/*
 * pnpm-compat.js 的回归测试（node --test，零依赖、零 utools 桩）。
 *
 * 为什么这个模块值得单独钉：
 *   1. **顺序即设计**。RECOGNIZERS 是先命中者胜，多条正则常同时命中同一段 pnpm 输出。
 *      顺序一变，归因就变 —— 而错误归因会直接把用户指去一个改不好的方向（如把「另一个 dsh
 *      正在跑」误报成「被杀软锁了」）。所以顺序敏感的几对必须钉住谁先谁后。
 *   2. **retryable 有真实消费点**。它不是摆设：settings.js 会把它回传给前端，前端据此决定
 *      要不要画「重试一次」按钮（P3）。判错 = 界面要么白让用户点，要么把该重试的藏起来。
 *   3. **shouldAutoRetryOnce 是白名单**。自动重试会再跑一次可能长达数分钟的 pnpm，花的是
 *      用户的时间。放行的口径必须精确到「哪几码 + 什么前提」，尤其 release-age 永远不放行
 *      （这是供应链安全策略，绝不能靠自动重试绕过）。
 *
 * ⚠️ 本文件**不挂 utools 桩**：pnpm-compat 是叶子模块，require 它不该碰宿主。若哪天它引了
 *    log / utools / constants，这个测试会在 require 阶段就崩 —— 那正是我们想要的警报。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { classifyPnpmFailure, shouldAutoRetryOnce } = require('../public/preload/lib/pnpm-compat.js')

// ── 认不出：一律 code=null / retryable=false ──
//
// ⚠️ retryable 默认 false 是刻意的：认不出的失败，我们**没有证据**说重试有用。给个按钮点了
//    还是同样报错，比自己翻日志更让人火大。
test('classifyPnpmFailure：认不出的输出返回 code=null 且 retryable=false', () => {
  const r = classifyPnpmFailure('some totally unrelated failure text', 1)
  assert.equal(r.code, null)
  assert.equal(r.retryable, false)
  assert.equal(r.reason, '')
  assert.equal(r.hint, '')
})

test('classifyPnpmFailure：空 / 非字符串输入不抛异常，照样回落', () => {
  for (const v of ['', null, undefined, 12345, {}, []]) {
    const r = classifyPnpmFailure(v, 1)
    assert.equal(r.code, null, 'input=' + String(v))
    assert.equal(r.retryable, false, 'input=' + String(v))
  }
  // 退出码本身也容错：非有限数按 -1 处理，不能因此把 pnpm-missing 误判出来
  assert.equal(classifyPnpmFailure('随便一段', NaN).code, null)
  assert.equal(classifyPnpmFailure('随便一段', 'oops').code, null)
})

// ── 1. pnpm-missing：必须是第一条，且只在退出码 -1 时成立 ──
//
// ⚠️ 下面所有识别器都假设「pnpm 真的跑起来了」，只有这一条是「连进程都没有」的早退分支。
//    它要是排到后面，会被别的规则抢走；而若误把普通失败判成 pnpm-missing，用户会被指去
//    重装 pnpm（南辕北辙）。
test('pnpm-missing：仅退出码 -1 且点名缺 pnpm / Node 时命中（retryable=false）', () => {
  const r = classifyPnpmFailure('未找到 pnpm 可执行文件，请先安装（npm i -g pnpm）', -1)
  assert.equal(r.code, 'pnpm-missing')
  assert.equal(r.retryable, false, '没装 pnpm，原样重试必然再失败')
  assert.match(r.hint, /pnpm/)

  // 同样文案但退出码是 1（pnpm 跑过又失败）→ 不该判成 pnpm-missing，回落认不出
  assert.equal(classifyPnpmFailure('未找到 pnpm 可执行文件', 1).code, null)
})

// ── 2 与 3 的先后：profile 锁必须先于 windows 锁 ──
//
// ⚠️ 两段原文都可能同时带 EBUSY/EPERM，属于「文件被占用」大类，但出路相反：
//    profile 锁 → 关掉另一个 dsh；windows 锁 → 关掉编辑器 / 杀软。
//    顺序写反 = 把「dsh 正在跑」误报成「被杀软锁了」，用户照着一个改不好的方向折腾。
test('profile-file-locked 优先于 windows-file-locked（同时命中时才不吃错方向）', () => {
  // 两个规则的正则都能命中这段：ERR_PNPM_EPERM 属于 windows 类，package.json.lock 属于 profile 类
  const r = classifyPnpmFailure('ERR_PNPM_EPERM ... package.json.lock is held by another dsh instance', 1)
  assert.equal(r.code, 'profile-file-locked', '顺序即设计：profile 锁必须排在前面')
  assert.equal(r.retryable, false, '锁没释放时原样重试必然再撞，不给「重试」按钮')
  assert.match(r.reason, /占用/)
})

test('profile-file-locked：内层锁文件 .pnpm/lock.yaml.<pid> 也要认得', () => {
  // 这种报错里既没有 package.json.lock 也没有 "profile" 字样，靠关键词表会漏判
  const r = classifyPnpmFailure('ERR_PNPM_EPERM: Cannot lock E:/x/profiles/a/.pnpm/lock.yaml.12345', 1)
  assert.equal(r.code, 'profile-file-locked')
  assert.equal(r.retryable, false)
  // 文案不出现内部术语「profile」（用户不知道那是什么）
  assert.doesNotMatch(r.reason, /profile/i)
  assert.doesNotMatch(r.hint, /profile/i)
})

test('windows-file-locked：只有纯文件占用、不涉及 profile 锁时才命中', () => {
  const r = classifyPnpmFailure('EBUSY: resource busy or locked, rmdir node_modules\\foo', 1)
  assert.equal(r.code, 'windows-file-locked')
  assert.equal(r.retryable, true)
})

// ── 4 / 5. 网络与超时：两码都 retryable ──
test('transient-network：常见瞬时网络错误都归这一类（retryable=true）', () => {
  const samples = [
    'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/x: FetchError: request failed',
    'Error: read ECONNRESET',
    'Error: connect ETIMEDOUT 1.2.3.4:443',
    'getaddrinfo EAI_AGAIN registry.npmmirror.com',
    'Error: socket hang up',
    'network timeout at: https://registry.npmjs.org/y',
    'GET https://registry.npmjs.org/z 502 Bad Gateway',
  ]
  for (const s of samples) {
    const r = classifyPnpmFailure(s, 1)
    assert.equal(r.code, 'transient-network', s)
    assert.equal(r.retryable, true, s)
  }
})

test('fetch-timeout：超时单独成码（retryable=true），不与普通网络抖动混为一谈', () => {
  const samples = [
    'operation was aborted due to timeout',
    'TimeoutError: The operation was aborted',
    'ERR_PNPM_FETCH_TIMEOUT ... request timed out',
  ]
  for (const s of samples) {
    const r = classifyPnpmFailure(s, 1)
    assert.equal(r.code, 'fetch-timeout', s)
    assert.equal(r.retryable, true, s)
  }
})

// ── 6. root-add：只归因，是否补 -w 交给上层读盘决定 ──
test('root-add：命中即 retryable=true，但**是否真重试**由 shouldAutoRetryOnce 另判', () => {
  const r = classifyPnpmFailure('ERR_PNPM_ADDING_TO_ROOT  This package was added to the root project', 1)
  assert.equal(r.code, 'root-add')
  assert.equal(r.retryable, true)
})

// ── 1.5. pnpm-stalled：必须排在锁类 / 网络类之前，且点名罪魁包 ──
//
// pnpm 的 stalled 报错会把超时前打印的所有输出一起带出来，里面常混着 EBUSY / ECONNRESET。
// 排在后面就会被抢走 → 用户照着「关杀软 / 换镜像」折腾一圈，真正卡死的那个包始终没被点名。
test('pnpm-stalled：混着 EBUSY 也只判「脚本卡死」，并点出罪魁包', () => {
  const out = [
    '...\\node_modules\\foo install$ node ./postinstall.js',
    'EBUSY: resource busy or locked, rmdir node_modules\\x',
    '...\\node_modules\\.pnpm\\better-sqlite3@9.0.0\\node_modules\\better-sqlite3 install$ node-gyp rebuild',
    'Progress: resolved 1, reused 0, downloaded 0, added 0',
    'The process was terminated because it printed nothing for 600000ms and was terminated',
  ].join('\n')
  const r = classifyPnpmFailure(out, 1)
  assert.equal(r.code, 'pnpm-stalled', 'stalled 必须优先于 windows-file-locked')
  assert.equal(r.retryable, false, '脚本卡死是确定性的，重试只会再等一轮')
  assert.match(r.reason, /better-sqlite3/, '要点出最后一条安装脚本的包名')
  assert.match(r.reason, /600/)
})

test('pnpm-stalled：认不出罪魁包时只说「有脚本卡死」，不编包名', () => {
  const r = classifyPnpmFailure('printed nothing for 300000ms and was terminated', 1)
  assert.equal(r.code, 'pnpm-stalled')
  assert.doesNotMatch(r.reason, /来自/)
})

// ── 7. lockfile：outdated / broken 两档，出路不同 ──
test('lockfile-outdated：retryable=false（原样重试必然再撞，且自动改 argv 风险高）', () => {
  const r = classifyPnpmFailure('ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date', 1)
  assert.equal(r.code, 'lockfile-outdated')
  assert.equal(r.retryable, false)
})

test('lockfile-broken：lockfile 缺条目 / 损坏单独成码，并给出重建步骤', () => {
  const r = classifyPnpmFailure('ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY  Broken lockfile: no entry for /foo/1.0.0', 1)
  assert.equal(r.code, 'lockfile-broken')
  assert.equal(r.retryable, false)
  assert.match(r.hint, /--no-frozen-lockfile/)
  assert.match(r.hint, /lockfile-only/)
  // 关键安全提示：别让用户删掉整个 lockfile（否则所有插件版本一起漂移）
  assert.match(r.hint, /不要删整个/)
})

// ── 8. release-age：只归因、不放行（供应链安全底线）──
//
// ⚠️ 这是本模块**最重要**的一条不变量：看到「太新」只能告诉用户等，绝不能自动放行、
//    绝不能注入 --config.minimum-release-age=0。上游在 install.ts 里明确拒绝自动放行
//    （releaseAgeBypass === false 就直接放弃重试），本项目沿用同一立场。
test('release-age-violation：retryable=false，且自检「绝不放行」这条底线', () => {
  for (const s of [
    'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION  dshmarket@1.57.0 is too new; published 3 hours ago',
    'ERR_PNPM_NO_MATURE_MATCHING_VERSION  No matching version found',
    // 同一道门的第三张脸（上游 ca7fd10）：lockfile 校验通过后解析器才炸
    'ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED  2 resolution-policy violations were produced',
    'minimum release age of 1 days not satisfied',
  ]) {
    const r = classifyPnpmFailure(s, 1)
    assert.equal(r.code, 'release-age-violation', s)
    assert.equal(r.retryable, false, s)
  }
  // hint 只能引导「等」或「手动加白名单」，绝不能出现任何自动放行的措辞
  const r = classifyPnpmFailure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION x is too new', 1)
  assert.match(r.hint, /等/)
  assert.doesNotMatch(r.hint, /自动|已放行|绕过/, 'hint 不能暗示会自动绕过观察期')
})

test('release-age 正则不吃 minimumReleaseAgeExclude（白名单字段本身不是违规）', () => {
  // `minimum[\s-]?release[\s-]?age(?!Exclude)` 里的负向先行：Exclude 是**例外配置**，
  // 出现在文本里不代表这次失败是 release-age 违规，不能误判
  const r = classifyPnpmFailure('config: minimumReleaseAgeExclude: [dshmarket@1.2.3]', 1)
  assert.notEqual(r.code, 'release-age-violation', '白名单字段不该被当成违规')
})

// ── 9. host-peer：404/无匹配版本 + @deepseek-ai/ 同时出现才命中 ──
test('host-peer：必须 404 类文案与 @deepseek-ai/ 同时出现，且 retryable=true', () => {
  const r = classifyPnpmFailure('404 Not Found - GET https://registry.npmjs.org/@deepseek-ai%2fdsh-settings', 1)
  assert.equal(r.code, 'host-peer')
  assert.equal(r.retryable, true)

  // 只有 404、不涉及 @deepseek-ai/ —— 不能认领（那是普通缺包，出路不同）
  assert.notEqual(classifyPnpmFailure('404 Not Found - GET https://registry.npmjs.org/lodash', 1).code, 'host-peer')
})

// ── 9.5 exact-version-missing：精确版本在当前线路还没同步 ──
//
// ⚠️ 关键是不能误说成「版本不存在」：镜像 packument 往往滞后于刚发布的版本，
//    用户等一会儿 / 换 registry 就能装上（上游 #927）。
test('exact-version-missing：ERR_PNPM_NO_MATCHING_VERSION + 精确 name@x.y.z 才命中', () => {
  const r = classifyPnpmFailure(
    'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for dshmarket@1.73.7 while resolving',
    1,
  )
  assert.equal(r.code, 'exact-version-missing')
  assert.equal(r.retryable, false, '手动原样重试没有新信息，自动重试由宿主做一次')
  assert.match(r.reason, /dshmarket@1\.73\.7/)
  assert.match(r.reason, /不等于这个版本不存在/)
  assert.match(r.hint, /自动重试一次/)

  // scoped 包名同样要能抠出来
  const scoped = classifyPnpmFailure(
    'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @linxin666/dsh-web-all@0.3.30',
    1,
  )
  assert.equal(scoped.code, 'exact-version-missing')
  assert.match(scoped.reason, /@linxin666\/dsh-web-all@0\.3\.30/)
})

test('exact-version-missing：范围请求 / 缺错误码 / 宿主包都不认领', () => {
  // 范围请求匹配不上 ≠ 精确版本未同步：文案不同，不能混
  assert.equal(classifyPnpmFailure('ERR_PNPM_NO_MATCHING_VERSION  No matching version found for foo@^1.2.3', 1).code, null)
  // 没带 ERR_PNPM_NO_MATCHING_VERSION 不猜
  assert.equal(classifyPnpmFailure('No matching version found for foo@1.2.3', 1).code, null)
  // 宿主包归 host-peer：哪怕它这里也满足「精确版本」，也不能抢
  const host = classifyPnpmFailure(
    'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @deepseek-ai/dsh-llm@0.3.0',
    1,
  )
  assert.equal(host.code, 'host-peer')
})

// ── 10. unparseable-build-key：allowBuilds 未放行（retryable=false）──
test('unparseable-build-key：构建脚本被拦，retryable=false（重试不会放行）', () => {
  const r = classifyPnpmFailure('[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] The git-hosted package needs to execute build scripts but is not in the "allowBuilds" allowlist', 1)
  assert.equal(r.code, 'unparseable-build-key')
  assert.equal(r.retryable, false)
})

// ── 识别器永不抛：失败路径上的失败路径 ──
test('classifyPnpmFailure：任何输入组合都不抛异常（识别器内部 try 兜底）', () => {
  const weird = [Symbol('x')]
  for (const v of weird) {
    assert.doesNotThrow(() => classifyPnpmFailure(v, 1))
  }
  // 超长输出也不该崩
  assert.doesNotThrow(() => classifyPnpmFailure('x'.repeat(200000), 1))
})

// ── shouldAutoRetryOnce：白名单式闸门 ──
test('shouldAutoRetryOnce：只放行 transient-network / fetch-timeout / exact-version-missing', () => {
  assert.equal(shouldAutoRetryOnce({ code: 'transient-network' }), true)
  assert.equal(shouldAutoRetryOnce({ code: 'fetch-timeout' }), true)
  // 精确版本未被镜像同步：同 argv 再拉一次 packument 有机会命中（上游 #927）
  assert.equal(shouldAutoRetryOnce({ code: 'exact-version-missing' }), true)
})

test('shouldAutoRetryOnce：锁类即便 retryable 也不自动重试（要等外部进程让锁）', () => {
  // windows-file-locked 的 retryable=true（手动点重试有意义），但**自动**重试不行：
  // 锁没释放时立刻重试多半还锁着，只会让界面长时间「正在安装」，体验更差。
  // profile-file-locked 本身已是 retryable=false（上游 #786），这里一并钉住两码都不放行
  assert.equal(shouldAutoRetryOnce({ code: 'profile-file-locked' }), false)
  assert.equal(shouldAutoRetryOnce({ code: 'windows-file-locked' }), false)
})

test('shouldAutoRetryOnce：pnpm-stalled 不自动重试（脚本卡死是确定性的）', () => {
  assert.equal(shouldAutoRetryOnce({ code: 'pnpm-stalled' }, { hasWorkspaceFile: true }), false)
})

test('shouldAutoRetryOnce：root-add 仅在 hasWorkspaceFile=true 时放行（否则补 -w 会撞 NOT_A_WORKSPACE）', () => {
  assert.equal(shouldAutoRetryOnce({ code: 'root-add' }, { hasWorkspaceFile: true }), true)
  assert.equal(shouldAutoRetryOnce({ code: 'root-add' }, { hasWorkspaceFile: false }), false)
  assert.equal(shouldAutoRetryOnce({ code: 'root-add' }), false, '缺省（undefined）必须是 false，不能假设有 workspace')
  assert.equal(shouldAutoRetryOnce({ code: 'root-add' }, {}), false)
})

test('shouldAutoRetryOnce：release-age / lockfile / build-key / host-peer 一律不自动重试', () => {
  // release-age 恒 false —— 这是安全底线，不能因任何 opts 改变
  assert.equal(shouldAutoRetryOnce({ code: 'release-age-violation' }, { hasWorkspaceFile: true }), false)
  assert.equal(shouldAutoRetryOnce({ code: 'lockfile-outdated' }), false)
  assert.equal(shouldAutoRetryOnce({ code: 'lockfile-broken' }), false)
  assert.equal(shouldAutoRetryOnce({ code: 'unparseable-build-key' }), false)
  // host-peer 要改 argv（auto-install-peers=false）才算「带参重试」，不在纯函数口径内
  assert.equal(shouldAutoRetryOnce({ code: 'host-peer' }), false)
})

test('shouldAutoRetryOnce：认不出（code=null）与非对象输入都不放行', () => {
  assert.equal(shouldAutoRetryOnce({ code: null }), false)
  assert.equal(shouldAutoRetryOnce(null), false)
  assert.equal(shouldAutoRetryOnce(undefined), false)
  assert.equal(shouldAutoRetryOnce({}), false)
})

test('结果对象形状稳定：四个键齐全，retryable 恒为布尔', () => {
  const ok = classifyPnpmFailure('ECONNRESET', 1)
  assert.deepEqual(Object.keys(ok).sort(), ['code', 'hint', 'reason', 'retryable'])
  assert.equal(typeof ok.retryable, 'boolean')
  assert.equal(typeof ok.reason, 'string')
  assert.equal(typeof ok.hint, 'string')
})
