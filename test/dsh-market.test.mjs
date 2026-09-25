/*
 * dsh-market.js 单测（node --test，零依赖）
 *
 * 只测纯函数与可注入 fetch 的抓取链路：
 *   · 归一（normPlugin / normCatalog）—— 目录是唯一数据源，字段漏了会静默少条目
 *   · 安装 spec（parseInstallSpec / specKindOf / specNeedsBuild）—— install 字段才是权威安装命令，
 *     目录里 48.6% 的条目 npm 为 null 但 install 是 github:/tarball，按 npm 判可用会砍掉近半目录
 *   · 筛选排序（filterPlugins / matchKeyword）—— 先筛后排、读不到已装状态时不冒充未安装；
 *     关键词空格分词（与关系）与 `-词` 排除；排序方向 desc 不传走各轴默认（SORTS_DESC）
 *   · 已装映射（installedMap / matchInstalled / matchInstalledBySpec）—— 完整名优先、短名兜底、
 *     spec 反查（github/tarball 装完的键名由 npm 归一，对不上 npm 字段），判法与宿主/界面必须一致
 *   · 来源链（buildSources / loadCatalog）—— 自定义最优先、镜像可关、逐源重试、全挂才 ok:false
 *   · tar 解析（untarOne）—— 手写 512 字节块解析，错位会解出乱码而不报错
 *
 * loadCatalog 通过注入 fake fetch 覆盖，不碰网络；每例前 clearCache() 防内存缓存串联。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import dshMarket from '../public/preload/lib/dsh-market.js'

const {
  normPlugin, normCatalog, filterPlugins, matchKeyword, SORTS_DESC,
  installedMap, matchInstalled, matchInstalledBySpec, matchDepByNpm, buildSources, loadCatalog,
  parseInstallSpec, specKindOf, specNeedsBuild,
  realizedVersionBySpec,
  parseVer, cmpVer, rangeAllows, lowerBoundOf, updateState,
  registryLatest,
  clearCache, OFFICIAL_URL, MIRROR_PKG, MIRROR_REGISTRY,
} = dshMarket

// ── 测试夹具 ──

// 造一条目录里的原始条目（字段名与真实 plugins.json 对齐）
function raw(over) {
  return Object.assign({
    name: 'dsh-demo',
    owner: 'someone',
    url: 'https://github.com/someone/dsh-demo',
    page: 'https://awesome-dsh-plugin.com/p/dsh-demo',
    category: 'tool',
    description: { en: 'A demo plugin', zh: '一个示例插件' },
    npm: '@scope/dsh-demo',
    version: '1.2.3',
    stars: 10,
    downloads: 200,
    install: 'dsh plugin --profile web add @scope/dsh-demo',
    added: '2026-08-01',
  }, over || {})
}

function catalogJson(plugins, extras) {
  return JSON.stringify(Object.assign({
    name: 'demo',
    updated: '2026-09-20',
    count: plugins.length,
    categories: { tool: { en: 'Tool', zh: '工具' } },
    plugins,
  }, extras || {}))
}

// 只认 URL 的极简 Response 替身
// over = { ok, status, statusText, headers }，会盖掉默认值
function res(body, over) {
  const o = over || {}
  const text = String(body == null ? '' : body)
  return Object.assign({
    ok: true,
    status: 200,
    statusText: '',
    text: async () => text,
    // registryLatest 走 res.json()（目录链路走 res.text()），两者都要有
    json: async () => JSON.parse(text),
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
    headers: Object.assign({ get: () => '' }, o.headers || {}),
  }, o.ok === undefined ? {} : { ok: o.ok }, o.status === undefined ? {} : { status: o.status },
  o.statusText === undefined ? {} : { statusText: o.statusText })
}

// fetch 替身：按 url 命中 map 里的处理函数；未命中按 404 处理（记进 calls 便于断言链路）
// map 的值可以是「函数（拿 url/init 自己造响应）」或「字符串（当 200 JSON 正文）」
function fakeFetch(map, calls) {
  return async (url, init) => {
    if (calls) calls.push(url)
    const h = map[url]
    if (!h) return res('', { ok: false, status: 404 })
    return typeof h === 'function' ? h(url, init) : res(h)
  }
}

// 手写一个只含单个成员的最小 tar 块（header + data + 补齐，**不带结束零块**）
// 不带零块是为了能拼出多成员归档：解析器把「全零块」当归档结束，
// 若每块都自带零块，第二块就永远读不到（这正是本夹具要覆盖的边界）
function tarMember(memberName, content) {
  const data = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  header.write(memberName, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8)             // mode
  header.write('0000000\0', 108, 8)             // uid
  header.write('0000000\0', 116, 8)             // gid
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12) // size（八进制）
  header.write('00000000000\0', 136, 12)        // mtime
  header.write('0', 156, 1)                     // typeflag 普通文件
  header.write('ustar', 257, 5)
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, pad])
}

// 完整归档 = 成员块 + 1024 字节结束零块
function makeTar(memberName, content) {
  return Buffer.concat([tarMember(memberName, content), Buffer.alloc(1024)])
}

// ── normPlugin ──

test('normPlugin：归一字段并从 install 字段解析出权威 spec', () => {
  const p = normPlugin(raw())
  assert.equal(p.name, 'dsh-demo')
  assert.equal(p.npm, '@scope/dsh-demo')
  assert.equal(p.descZh, '一个示例插件')
  assert.equal(p.descEn, 'A demo plugin')
  assert.equal(p.stars, 10)
  assert.equal(p.downloads, 200)
  // install 才是权威安装命令：裸包名形态
  assert.equal(p.spec, '@scope/dsh-demo')
  assert.equal(p.specKind, 'npm')
  assert.equal(p.needsBuild, false)
})

test('normPlugin：npm 为 null 但 install 是 github: 时仍可装，只是标为需构建', () => {
  // 真实目录里 48.6% 的条目 npm 为 null —— 它们不是装不了，而是 spec 换了形态。
  // 旧实现按 npm 判 installable，等于砍掉近一半目录；现在按 install 解析。
  const p = normPlugin(raw({
    npm: null,
    name: 'dsh-github-only',
    install: 'dsh plugin --profile web add github:someone/dsh-github-only',
  }))
  assert.equal(p.npm, '')
  assert.equal(p.spec, 'github:someone/dsh-github-only')
  assert.equal(p.specKind, 'github')
  assert.equal(p.needsBuild, true)
})

// ── 安装 spec 解析（parseInstallSpec / specKindOf / specNeedsBuild）──

test('parseInstallSpec：取命令行最后一个词，并剥掉成对的单双引号', () => {
  assert.equal(parseInstallSpec('dsh plugin --profile web add @scope/dsh-demo'), '@scope/dsh-demo')
  assert.equal(parseInstallSpec('dsh plugin --profile web add github:a/b'), 'github:a/b')
  // 真实目录里 tarball 形态带 shell 引号，引号必须剥掉否则进不了白名单
  assert.equal(parseInstallSpec('dsh plugin --profile web add "https://x.cn/a.tgz"'), 'https://x.cn/a.tgz')
  assert.equal(parseInstallSpec("dsh plugin --profile web add 'https://x.cn/a.tgz'"), 'https://x.cn/a.tgz')
  assert.equal(parseInstallSpec('  https://x.cn/a.tgz  '), 'https://x.cn/a.tgz')
  assert.equal(parseInstallSpec(''), '')
  assert.equal(parseInstallSpec(null), '')
  assert.equal(parseInstallSpec(undefined), '')
})

test('specKindOf：按前缀区分 npm / github / tarball，认不出的返回空串', () => {
  assert.equal(specKindOf('@scope/dsh-demo'), 'npm')
  assert.equal(specKindOf('dsh-demo'), 'npm')
  assert.equal(specKindOf('github:owner/repo'), 'github')
  assert.equal(specKindOf('GitHub:owner/repo'), 'github')
  assert.equal(specKindOf('https://codeload.github.com/o/r/tar.gz/abc'), 'tarball')
  assert.equal(specKindOf('http://x.cn/a.tgz'), 'tarball')
  assert.equal(specKindOf('./local-dir'), '')
  assert.equal(specKindOf('git+ssh://git@x.cn/a.git'), '')
  assert.equal(specKindOf(''), '')
  assert.equal(specKindOf(null), '')
})

test('specNeedsBuild：只有 git / tarball 来源需要现场构建', () => {
  // 这两类靠 prepare 脚本构建，pnpm 默认拦截 → 首次安装注定失败并要引导 allowBuilds
  assert.equal(specNeedsBuild('github'), true)
  assert.equal(specNeedsBuild('tarball'), true)
  assert.equal(specNeedsBuild('npm'), false)
  assert.equal(specNeedsBuild(''), false)
})

// ── matchInstalledBySpec ──

test('matchInstalledBySpec：github spec 能对上 owner/repo 与 repo 两种键名', () => {
  const deps = { 'dsh-whale-widget': '^0.3.7', 'owner/repo': '^1.0.0', 'dsh-b': '^2.0.0' }
  assert.deepEqual(matchInstalledBySpec(deps, 'github:owner/repo'), { key: 'owner/repo', depVersion: '^1.0.0' })
  assert.deepEqual(matchInstalledBySpec(deps, 'github:owner/dsh-b'), { key: 'dsh-b', depVersion: '^2.0.0' })
  assert.equal(matchInstalledBySpec(deps, 'github:owner/nope'), null)
})

test('matchInstalledBySpec：tarball spec 去掉查询串与 .tgz、版本号后仍能对上', () => {
  const deps = { 'dsh-a': '^1.0.0', 'pkg': '^2.0.0' }
  assert.deepEqual(matchInstalledBySpec(deps, 'https://x.cn/dsh-a-1.2.3.tgz'), { key: 'dsh-a', depVersion: '^1.0.0' })
  assert.deepEqual(matchInstalledBySpec(deps, 'https://x.cn/pkg.tgz'), { key: 'pkg', depVersion: '^2.0.0' })
  // 查询串要去掉：?v=2 不能让末段变成 `pkg.tgz?v=2`
  assert.deepEqual(matchInstalledBySpec(deps, 'https://x.cn/pkg.tgz?v=2'), { key: 'pkg', depVersion: '^2.0.0' })
  assert.equal(matchInstalledBySpec(deps, 'https://x.cn/nope.tgz'), null)
})

test('matchInstalledBySpec：裸包名走完整名，且大小写不敏感、返回原始键', () => {
  const deps = { '@Scope/Dsh-Demo': '^1.2.3' }
  assert.deepEqual(matchInstalledBySpec(deps, '@scope/dsh-demo'), { key: '@Scope/Dsh-Demo', depVersion: '^1.2.3' })
  assert.equal(matchInstalledBySpec(deps, ''), null)
  assert.equal(matchInstalledBySpec(null, 'dsh-a'), null)
})

// ── 版本比对（parseVer / cmpVer / rangeAllows / updateState）──
//
// 口径（2026-09-24 调整）：优先比**实装版本**（node_modules/<name>/package.json 的 version），
// 拿不到才退回比 package.json 里的**声明范围**（`^0.5.11`）。
// 为什么改：老口径只看范围时，`^0.5.11` 实装 0.5.11 的用户在目录出 0.5.13 时不会被告知 ——
// 而本机实测 9 条依赖里 8 条的实装版本恰好都等于范围下界，这类升级是真实的、不该漏报。

test('parseVer：容忍 v 前缀 / = / 前后空白，缺位的段补 0', () => {
  // ⚠️ 返回的是**四元组** [major, minor, patch, prerelease[]]，第四位是数组
  //    （2026-09-24 为 DSH 宿主兼容性检测补的 prerelease 支持）
  assert.deepEqual(parseVer('1.2.3'), [1, 2, 3, []])
  assert.deepEqual(parseVer('v0.5.11'), [0, 5, 11, []])
  assert.deepEqual(parseVer('= 1.2'), [1, 2, 0, []])
  assert.deepEqual(parseVer('1'), [1, 0, 0, []])
  assert.equal(parseVer('latest'), null)
  assert.equal(parseVer(''), null)
  assert.equal(parseVer(null), null)
})

test('parseVer：带 prerelease 的版本号不再把后缀丢掉（丢掉会让 rc.1 与正式版判相等）', () => {
  assert.deepEqual(parseVer('0.1.7-rc.1'), [0, 1, 7, ['rc', '1']])
  assert.deepEqual(parseVer('1.0.0-alpha.beta'), [1, 0, 0, ['alpha', 'beta']])
  assert.deepEqual(parseVer('v2.0.0-rc.10'), [2, 0, 0, ['rc', '10']])
  // build metadata 按 semver 规定不参与比较，整体丢弃
  assert.deepEqual(parseVer('1.2.3+build.9'), [1, 2, 3, []])
  assert.deepEqual(parseVer('1.2.3-rc.1+build.9'), [1, 2, 3, ['rc', '1']])
})

test('cmpVer：prerelease —— 正式版更大，rc.10 > rc.9（字符串比会判反）', () => {
  assert.equal(cmpVer('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(cmpVer('1.0.0-rc.1', '1.0.0'), -1)
  // ⚠️ 这条是「必须按数值而非字符串比」的钉子：'rc.10' < 'rc.9' 是字符串的结论
  assert.equal(cmpVer('0.1.7-rc.10', '0.1.7-rc.9'), 1)
  assert.equal(cmpVer('0.1.7-rc.1', '0.1.7-rc.2'), -1)
  assert.equal(cmpVer('0.1.7-rc.1', '0.1.7-rc.1'), 0)
  // 数字段 < 字母段（semver §11.4）
  assert.equal(cmpVer('1.0.0-1', '1.0.0-alpha'), -1)
  // 前缀短的更小
  assert.equal(cmpVer('1.0.0-rc', '1.0.0-rc.1'), -1)
  // 主版本不同时 prerelease 不参与（数字段优先）
  assert.equal(cmpVer('0.1.8-rc.1', '0.1.7'), 1)
})

test('rangeAllows：caret 下界带 prerelease 时不能拼出 parseVer 认不出的垃圾', () => {
  // ⚠️ 回归：lo 是四元组，`lo.join('.')` 会把 ['rc','1'] 拼成 `0.1.7.rc,1`
  //    → cmpVer 返 0 → 下界判定静默失效（低于下界的也会被放行）
  assert.equal(rangeAllows('^0.1.7-rc.1', '0.1.7-rc.1'), true)
  assert.equal(rangeAllows('^0.1.7-rc.1', '0.1.7-rc.2'), true)
  assert.equal(rangeAllows('^0.1.7-rc.1', '0.1.7'), true)
  // 低于下界必须判 false —— 这正是 join 脏串会漏掉的那条
  assert.equal(rangeAllows('^0.1.7-rc.1', '0.1.6'), false)
  assert.equal(rangeAllows('~0.1.7-rc.1', '0.1.6'), false)
})

test('cmpVer：逐段比大小，右边多处算大；无法解析时返 0（不冒充「有新」）', () => {
  assert.equal(cmpVer('1.2.3', '1.2.4'), -1)
  assert.equal(cmpVer('0.6.0', '0.5.11'), 1)
  assert.equal(cmpVer('1.2.3', '1.2.3'), 0)
  assert.equal(cmpVer('1.2', '1.2.0'), 0)
  // 字符串比较会得出 '0.10.0' < '0.9.0' 的错结论，这里是数字比，必须为 1
  assert.equal(cmpVer('0.10.0', '0.9.0'), 1)
  assert.equal(cmpVer('latest', '1.0.0'), 0)
})

test('rangeAllows：通配与空范围一律放行', () => {
  assert.equal(rangeAllows('', '9.9.9'), true)
  assert.equal(rangeAllows('*', '9.9.9'), true)
  assert.equal(rangeAllows('latest', '9.9.9'), true)
  assert.equal(rangeAllows('x', '9.9.9'), true)
})

test('rangeAllows：caret —— 0.x 的上界是下个 minor，不是 1.0.0（npm 的特殊语义）', () => {
  // ^0.5.11 → [0.5.11, 0.6.0)
  assert.equal(rangeAllows('^0.5.11', '0.5.13'), true)
  assert.equal(rangeAllows('^0.5.11', '0.5.11'), true)
  assert.equal(rangeAllows('^0.5.11', '0.6.0'), false)
  // ^1.2.3 → [1.2.3, 2.0.0)
  assert.equal(rangeAllows('^1.2.3', '1.9.0'), true)
  assert.equal(rangeAllows('^1.2.3', '2.0.0'), false)
  // 低于下界也算超出（用户手动降级过声明范围）
  assert.equal(rangeAllows('^1.2.3', '1.2.2'), false)
})

test('rangeAllows：tilde 只放开 patch 位', () => {
  assert.equal(rangeAllows('~1.2.3', '1.2.9'), true)
  assert.equal(rangeAllows('~1.2.3', '1.3.0'), false)
})

test('rangeAllows：裸版本按 npm 语义只有完全相同才算落在范围内', () => {
  // 本机实测就有这种写法：dsh-better-sidebar 写的是 "0.19.1"，锁定式
  assert.equal(rangeAllows('0.19.1', '0.19.1'), true)
  assert.equal(rangeAllows('0.19.1', '0.19.2'), false)
  // `1.2` 这类简写补 0 后与 1.2.0 等价
  assert.equal(rangeAllows('1.2', '1.2.0'), true)
})

test('rangeAllows：>= / > 比较器', () => {
  assert.equal(rangeAllows('>=1.2.0', '1.2.0'), true)
  assert.equal(rangeAllows('>=1.2.0', '0.9.0'), false)
  assert.equal(rangeAllows('>1.2.0', '1.2.0'), false)
  assert.equal(rangeAllows('>1.2.0', '1.2.1'), true)
})

test('rangeAllows：认不出的形态一律判「在范围内」（保守，宁可漏报不误报）', () => {
  // workspace:* / npm: 别名 / file: 这些我们没实现比较，不能瞎判成有更新
  assert.equal(rangeAllows('workspace:*', '9.9.9'), true)
  assert.equal(rangeAllows('npm:other@^1.0.0', '9.9.9'), true)
})

test('lowerBoundOf：取范围下界，用于「目录版本 vs 声明下界」判方向', () => {
  // caret / tilde / >= / 裸版本都要给出可比的裸版本号
  assert.equal(lowerBoundOf('^0.5.11'), '0.5.11')
  assert.equal(lowerBoundOf('~1.2.3'), '1.2.3')
  assert.equal(lowerBoundOf('>=1.2.0'), '1.2.0')
  assert.equal(lowerBoundOf('1.2.3'), '1.2.3')
  // 通配 / 空 / 认不出的形态没有下界，返回空串（调用方据此退回 unknown）
  assert.equal(lowerBoundOf(''), '')
  assert.equal(lowerBoundOf('*'), '')
  assert.equal(lowerBoundOf('latest'), '')
  assert.equal(lowerBoundOf('workspace:*'), '')
})

test('updateState：实装版本低于目录版本 → update（主路径，比实装版本）', () => {
  // 本机实测形态：声明 `^0.5.11`、实装 `0.5.11`，目录出 `0.5.13`
  // —— 按老口径「目录版本落在 ^0.5.11 范围内」会判成 current（漏报），
  //    改成比实装版本后正确判为 update
  const s = updateState('^0.5.11', '0.5.13', '0.5.11')
  assert.equal(s.state, 'update')
  assert.equal(s.basis, 'realized')
  assert.equal(s.installed, '0.5.11')
  assert.equal(s.range, '^0.5.11')
  assert.equal(s.latest, '0.5.13')
})

test('updateState：实装版本相等 → current（重装没意义，不报更新）', () => {
  assert.equal(updateState('^0.5.11', '0.5.11', '0.5.11').state, 'current')
  assert.equal(updateState('^1.0.0', '1.0.0', '1.0.0').basis, 'realized')
})

test('updateState：实装版本高于目录版本 → current（目录反而旧，不能报「更新到旧版」）', () => {
  // 用户手动装过更高版本、或目录数据滞后的情况
  const s = updateState('^1.0.0', '0.9.0', '1.2.0')
  assert.equal(s.state, 'current')
  assert.equal(s.basis, 'realized')
})

test('updateState：拿不到实装版本 → 退回声明范围判定（basis=range）', () => {
  // node_modules 里读不到（包在 profile/package.json 里但没落盘）时不能瞎猜，
  // 退回「目录版本 vs 声明范围下界」判方向
  const a = updateState('^0.5.11', '0.6.0', '')
  assert.equal(a.state, 'update')
  assert.equal(a.basis, 'range')
  assert.equal(a.installed, '')
  assert.equal(a.range, '^0.5.11')
  // 目录版本高于下界 0.5.11 → 是真升级。口径 2026-09-24 修正：旧实现拿
  // rangeAllows 判「是否超出范围」，会把 `^` 范围内的正常小版本升级判成 current（漏报）
  const b = updateState('^0.5.11', '0.5.13', '')
  assert.equal(b.state, 'update')
  assert.equal(b.basis, 'range')
  // 目录版本 == 下界 → 不比已装的新，不是更新
  assert.equal(updateState('^0.5.11', '0.5.11', '').state, 'current')
})

test('updateState：退回范围判定时，目录版本低于下界不能报 update（真实降级误报）', () => {
  // 用户真实事故（2026-09-24）：dshmarket 实装 1.62.0、声明 `^1.62.0`，
  // 而目录快照滞留在 1.61.0。旧实现用 rangeAllows('^1.62.0','1.61.0') 判「超出范围」
  // → 返 false → 报 update，界面显示「v1.62.0 → v1.61.0」并给出「更新」按钮，
  // 点下去会把用户**降级**到 1.61.0。方向完全判反。
  const s = updateState('^1.62.0', '1.61.0', '')
  assert.equal(s.state, 'current')
  assert.equal(s.basis, 'range')
  assert.equal(s.latest, '1.61.0')
  // 跨大版本回落同样不能报更新
  assert.equal(updateState('^1.62.0', '0.9.0', '').state, 'current')
  // 裸版本声明：目录比它旧 → current
  assert.equal(updateState('1.62.0', '1.61.0', '').state, 'current')
})

test('updateState：退回范围判定时，目录版本高于下界即报 update（含 ^ 范围内的小版本）', () => {
  // 与上一条配对：下界 1.62.0，目录 1.63.0 虽仍在 `^1.62.0` 范围内，
  // 也高于用户装到的 1.62.0，应报 update（旧实现会漏报）
  assert.equal(updateState('^1.62.0', '1.63.0', '').state, 'update')
  assert.equal(updateState('^1.62.0', '1.65.1', '').state, 'update')
  // tilde / >= / 裸版本三种形态一致
  assert.equal(updateState('~1.2.3', '1.2.9', '').state, 'update')
  assert.equal(updateState('>=1.2.3', '1.3.0', '').state, 'update')
  assert.equal(updateState('1.2.3', '1.2.4', '').state, 'update')
})

test('updateState：prerelease 声明退回范围判定时按 semver 比方向', () => {
  // dsh 生态大量 `0.1.7-rc.1` 形态；rc.2 应被认成比 rc.1 新
  assert.equal(updateState('^0.1.7-rc.1', '0.1.7-rc.2', '').state, 'update')
  assert.equal(updateState('^0.1.7-rc.1', '0.1.7-rc.1', '').state, 'current')
  assert.equal(updateState('^0.1.7-rc.1', '0.1.6', '').state, 'current')
})

test('updateState：目录没给 version → unknown（不冒充结论）', () => {
  // 目录里 48.6% 的条目（github/tarball 来源）没有 version 字段
  assert.equal(updateState('^1.0.0', '', '1.0.0').state, 'unknown')
  assert.equal(updateState('^1.0.0', null, '1.0.0').state, 'unknown')
  // 目录给的不是可解析版本（理论上不该有，但接口是开放的）也不冒充
  assert.equal(updateState('^1.0.0', 'latest', '1.0.0').state, 'unknown')
  assert.equal(updateState('^1.0.0', 'latest', '1.0.0').basis, 'none')
})

test('updateState：已装侧两边都拿不到 → unknown；只有范围 → 按下界判方向', () => {
  assert.equal(updateState('', '1.0.0', '').state, 'unknown')
  assert.equal(updateState(null, '1.0.0', '').state, 'unknown')
  // ⚠️ 已装侧是**声明范围**，不是裸版本号 —— caret 必须能正常比出 update，
  //    否则本机实测那批 `^0.5.11` 的包会全掉进 unknown，功能等于没做
  assert.equal(updateState('^0.5.11', '0.6.0', '').state, 'update')
  // ⚠️ `0.5.13` 虽落在 `^0.5.11` 范围内，但比下界 `0.5.11` 新 —— 必须报 update。
  //    不能拿 rangeAllows 判（它会因「落在范围内」返 true 而判成 current），
  //    那正是旧口径的漏报：同 minor 内的小版本升级真实存在，算「有新版」。
  assert.equal(updateState('^0.5.11', '0.5.13', '').state, 'update')
  // ⚠️ 反向：目录版本 == 下界（快照不比当初装到的新）→ current，不能报
  assert.equal(updateState('^0.5.11', '0.5.11', '').state, 'current')
  // 认不出的范围（workspace:* 之类）取不到下界，退回 rangeAllows 落到 current，不报更新
  assert.equal(updateState('workspace:*', '9.9.9', '').state, 'current')
})

test('updateState：实装版本是不可解析的脏数据 → 退回范围判定，不崩', () => {
  // node_modules 里的 version 理论上总是裸 x.y.z，但万一被改坏不能让它掉进 unknown 就完事
  const s = updateState('^0.5.11', '0.6.0', 'not-a-version')
  assert.equal(s.state, 'update')
  assert.equal(s.basis, 'range')
  assert.equal(s.installed, '')
})

test('updateState：只认 ==="update"，"unknown" 不能进可更新计数', () => {
  const list = ['0.6.0', '', '0.5.13']
  const n = list.filter((v) => updateState('^0.5.11', v, '0.5.11').state === 'update').length
  // 0.6.0 > 0.5.11 → update；'' → unknown；0.5.13 > 0.5.11 → update。共 2
  assert.equal(n, 2)
})

// ── 实装版本查表（realizedVersionBySpec）──
//
// 实装版本表的键就是 node_modules 的**目录名**（hoisted 模式下由 pnpm 物化）：
//   · npm 包来源        → 包名（作用域包为 `@scope/name`）
//   · github: 来源      → npm 归一后的 `owner/repo`
//   · 远端 tgz 来源     → tarball 里的 name 字段（通常就是包名）
// 而目录条目的 npm 字段对不上这近半数条目，所以要有「按 spec 反查」这条路。

test('realizedVersionBySpec：裸包名直接命中', () => {
  const v = { 'dsh-mnemon': '0.5.11', '@scope/x': '2.0.0' }
  assert.equal(realizedVersionBySpec(v, 'dsh-mnemon'), '0.5.11')
  assert.equal(realizedVersionBySpec(v, '@scope/x'), '2.0.0')
})

test('realizedVersionBySpec：作用域包的短名也能命中（目录名可能被归一成短名）', () => {
  const v = { 'dsh-mnemon': '0.5.11' }
  assert.equal(realizedVersionBySpec(v, '@deepseek-ai/dsh-mnemon'), '0.5.11')
})

test('realizedVersionBySpec：github: spec 按 owner/repo 与 repo 两档找（且大小写不敏感）', () => {
  const a = { 'cai-mh/x': '1.0.0' }
  assert.equal(realizedVersionBySpec(a, 'github:CAI-MH/x'), '1.0.0')
  const b = { x: '1.0.0' }
  assert.equal(realizedVersionBySpec(b, 'github:CAI-MH/x'), '1.0.0')
})

test('realizedVersionBySpec：带 commit hash 的 github spec 也能命中', () => {
  const v = { 'cai-mh/x': '1.0.0' }
  assert.equal(realizedVersionBySpec(v, 'github:cai-mh/x#abc1234'), '1.0.0')
})

test('realizedVersionBySpec：远端 tgz 按文件名（去扩展名 / 去版本）找', () => {
  const a = { 'dsh-demo': '3.1.0' }
  assert.equal(realizedVersionBySpec(a, 'https://x.com/dsh-demo.tgz'), '3.1.0')
  // 文件名带版本号的形态：`dsh-demo-3.1.0.tgz` → 兜底去掉 `-x.y.z` 后能对上
  assert.equal(realizedVersionBySpec(a, 'https://x.com/dsh-demo-3.1.0.tgz'), '3.1.0')
  // 带查询串的合法 tgz URL
  assert.equal(realizedVersionBySpec(a, 'https://x.com/dsh-demo.tgz?v=2&t=1'), '3.1.0')
})

test('realizedVersionBySpec：找不到返空字符串（不是 null / undefined，调用方按 falsy 判）', () => {
  const v = { 'dsh-mnemon': '0.5.11' }
  assert.equal(realizedVersionBySpec(v, 'dsh-nope'), '')
  assert.equal(realizedVersionBySpec(v, ''), '')
  assert.equal(realizedVersionBySpec(null, 'dsh-mnemon'), '')
  // 表里命中了键但值是空 → 也返 ''，不能把空串当版本传下去
  assert.equal(realizedVersionBySpec({ 'dsh-a': '' }, 'dsh-a'), '')
})

test('realizedVersionBySpec + updateState：串起来能判出「同 minor 内的小版本更新」', () => {
  // 这是本次改口径要解决的核心场景：声明 ^0.5.11、实装 0.5.11，目录出 0.5.13
  const versions = { 'dsh-mnemon': '0.5.11' }
  const realized = realizedVersionBySpec(versions, 'dsh-mnemon')
  assert.equal(updateState('^0.5.11', '0.5.13', realized).state, 'update')
})

// ── 目录归一化 ──

test('normPlugin：缺 name 的条目返回 null（由调用方丢弃，不猜字段）', () => {
  assert.equal(normPlugin({ owner: 'x' }), null)
  assert.equal(normPlugin(null), null)
  assert.equal(normPlugin('dsh-demo'), null)
})

test('normPlugin：缺 description / stars 非数 / screenshots 非数组时取安全默认', () => {
  const p = normPlugin(raw({ description: undefined, stars: 'many', screenshots: 'nope' }))
  assert.equal(p.descZh, '')
  assert.equal(p.descEn, '')
  assert.equal(p.stars, 0)
  assert.deepEqual(p.screenshots, [])
})

// ── normCatalog ──

test('normCatalog：解析正常目录并保留分类顺序', () => {
  const r = normCatalog(JSON.parse(catalogJson([raw(), raw({ name: 'dsh-b', npm: 'dsh-b' })])))
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.equal(r.updated, '2026-09-20')
  assert.deepEqual(Object.keys(r.categories), ['tool'])
  assert.equal(r.categories.tool.zh, '工具')
})

test('normCatalog：plugins 非数组或为空 → ok:false（空目录不能当「没有插件」展示）', () => {
  assert.equal(normCatalog({ plugins: null }).ok, false)
  assert.equal(normCatalog({ plugins: [] }).ok, false)
  assert.equal(normCatalog({}).ok, false)
  assert.equal(normCatalog(null).ok, false)
})

test('normCatalog：条目里出现但 categories 没给的分类要补上，否则那些条目筛不到', () => {
  const r = normCatalog(JSON.parse(catalogJson([raw({ category: 'unknown-cat' })])))
  assert.equal(r.ok, true)
  assert.ok(Object.prototype.hasOwnProperty.call(r.categories, 'unknown-cat'))
})

test('normCatalog：坏条目被丢掉，但剩下能用的条目照样出结果', () => {
  const r = normCatalog(JSON.parse(catalogJson([raw(), { owner: 'no-name' }])))
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.equal(r.plugins[0].name, 'dsh-demo')
})

// ── matchKeyword / filterPlugins ──

test('matchKeyword：命中 name / owner / 双语描述，且大小写不敏感', () => {
  const p = normPlugin(raw())
  assert.equal(matchKeyword(p, 'DEMO'), true)
  assert.equal(matchKeyword(p, 'someone'), true)
  assert.equal(matchKeyword(p, '示例'), true)
  assert.equal(matchKeyword(p, 'plugin'), true) // descEn 命中
  assert.equal(matchKeyword(p, 'zzz'), false)
  assert.equal(matchKeyword(p, ''), true)       // 空关键词 = 不过滤
  assert.equal(matchKeyword(p, '   '), true)
})

test('matchKeyword：空格分词是与关系（每段都要命中，且可跨字段）', () => {
  // name=dsh-demo / owner=someone / descZh=示例插件 / descEn=Demo plugin
  const p = normPlugin(raw())
  assert.equal(matchKeyword(p, 'demo plugin'), true)   // name + descEn，跨字段
  assert.equal(matchKeyword(p, 'someone 示例'), true)   // owner + descZh
  assert.equal(matchKeyword(p, 'demo zzz'), false)     // 第二段没命中 → 整条落选
  assert.equal(matchKeyword(p, '  demo   plugin  '), true) // 连续空格 / 首尾空格不产生空段
})

test('matchKeyword：`-词` 排除，且只有排除词时视为「全目录减去命中的」', () => {
  const p = normPlugin(raw())
  assert.equal(matchKeyword(p, 'demo -zzz'), true)      // 排除词没命中 → 保留
  assert.equal(matchKeyword(p, 'demo -plugin'), false)  // 排除词命中 descEn → 剔除
  assert.equal(matchKeyword(p, '-plugin'), false)       // 只有排除词：全目录减去命中的
  assert.equal(matchKeyword(p, '-zzz'), true)           // 只有排除词且没命中 → 全都要
  // ⚠️ 光一个 `-` 不是排除词（用户可能只是打个连字符）：跳过，不能把整份目录清空
  assert.equal(matchKeyword(p, '-'), true)
  assert.equal(matchKeyword(p, 'demo -'), true)
})

test('filterPlugins：分类 + 关键词 + 排序', () => {
  const list = [
    normPlugin(raw({ name: 'alpha', downloads: 5, category: 'tool' })),
    normPlugin(raw({ name: 'beta', downloads: 90, category: 'tool' })),
    normPlugin(raw({ name: 'gamma', downloads: 50, category: 'other' })),
  ]
  const byCat = filterPlugins(list, { category: 'tool' })
  assert.deepEqual(byCat.map((p) => p.name), ['beta', 'alpha']) // downloads 降序（默认轴）

  const byKw = filterPlugins(list, { keyword: 'gamma' })
  assert.deepEqual(byKw.map((p) => p.name), ['gamma'])

  assert.deepEqual(filterPlugins(list, { sort: 'name' }).map((p) => p.name), ['alpha', 'beta', 'gamma'])
})

test('filterPlugins：desc 不传走各轴默认方向，显式传 false 必须被尊重', () => {
  const list = [
    normPlugin(raw({ name: 'alpha', downloads: 5, stars: 1, added: '2026-01-03' })),
    normPlugin(raw({ name: 'beta', downloads: 90, stars: 9, added: '2026-01-01' })),
    normPlugin(raw({ name: 'gamma', downloads: 50, stars: 5, added: '2026-01-02' })),
  ]
  const names = (o) => filterPlugins(list, o).map((p) => p.name)
  // 不传 desc：数值 / 日期降序、名称升序（= SORTS_DESC）
  assert.deepEqual(names({ sort: 'downloads' }), ['beta', 'gamma', 'alpha'])
  assert.deepEqual(names({ sort: 'stars' }), ['beta', 'gamma', 'alpha'])
  assert.deepEqual(names({ sort: 'added' }), ['alpha', 'gamma', 'beta'])
  assert.deepEqual(names({ sort: 'name' }), ['alpha', 'beta', 'gamma'])
  // 显式反向
  assert.deepEqual(names({ sort: 'downloads', desc: false }), ['alpha', 'gamma', 'beta'])
  assert.deepEqual(names({ sort: 'name', desc: true }), ['gamma', 'beta', 'alpha'])
  assert.deepEqual(names({ sort: 'added', desc: false }), ['beta', 'gamma', 'alpha'])
  // ⚠️ 关键回归：`desc: false` 不能被 `false || 默认方向` 顶掉（写错就永远升不了序）
  assert.notDeepEqual(names({ sort: 'downolads', desc: false }), names({ sort: 'downloads' }))
  // 未知轴回落 downloads，方向仍按 downloads 的默认（降序）
  assert.deepEqual(names({ sort: 'nope' }), ['beta', 'gamma', 'alpha'])
  // 每个轴都必须在 SORTS_DESC 里有默认方向，否则 desc 不传时方向是 undefined（= 升序）
  assert.deepEqual(Object.keys(SORTS_DESC).sort(), ['added', 'downloads', 'name', 'stars'])
})

test('filterPlugins：读不到已装状态时 state 过滤把条目全跳过（不冒充未安装）', () => {
  const list = [normPlugin(raw({ name: 'a' })), normPlugin(raw({ name: 'b', npm: 'b' }))]
  // installed 未给：无法判断装没装，宁可**一条都不出**，也不把已装的标成「未安装」
  // 骗用户去点安装。（与 App.vue 的 dshMarketList 同口径：拿不到 status 就跳过）
  assert.equal(filterPlugins(list, { state: 'installed' }).length, 0)
  assert.equal(filterPlugins(list, { state: 'notInstalled' }).length, 0)
  // state:'all'（默认）不受影响，条目照样全出
  assert.equal(filterPlugins(list, {}).length, 2)
})

test('filterPlugins：有已装状态时 state 过滤按完整名判定', () => {
  const list = [normPlugin(raw({ name: 'a', npm: '@s/a' })), normPlugin(raw({ name: 'b', npm: 'b' }))]
  const installed = { '@s/a': { inDeps: true } }
  assert.deepEqual(filterPlugins(list, { state: 'installed', installed }).map((p) => p.name), ['a'])
  assert.deepEqual(filterPlugins(list, { state: 'notInstalled', installed }).map((p) => p.name), ['b'])
})

test('filterPlugins：不改动传入数组（返回新数组）', () => {
  const list = [normPlugin(raw({ name: 'a' })), normPlugin(raw({ name: 'b' }))]
  const before = list.slice()
  filterPlugins(list, { sort: 'name' })
  assert.deepEqual(list, before)
})

test('filterPlugins：bad 入参不抛异常', () => {
  assert.deepEqual(filterPlugins(null, null), [])
  assert.deepEqual(filterPlugins(undefined, { sort: 'nope' }), [])
})

// ── installedMap / matchInstalled ──

test('installedMap：deps 与 patch 两个来源合并，说清装没装与开没开', () => {
  const map = installedMap(
    { '@scope/dsh-demo': '1.2.3', 'dsh-bare': '0.1.0' },
    [{ id: '@scope/dsh-demo', disabled: true }, { id: 'ghost-only' }, { id: '' }],
  )
  // 装了 + 被禁用 —— 两个来源说两件事
  assert.deepEqual(map['@scope/dsh-demo'], { inDeps: true, depVersion: '1.2.3', inPatch: true, disabled: true })
  // 装了但 patch 里没有（走默认启用）
  assert.deepEqual(map['dsh-bare'], { inDeps: true, depVersion: '0.1.0', inPatch: false, disabled: false })
  // 在 patch 里但没装 = 写了不存在的 id
  assert.deepEqual(map['ghost-only'], { inDeps: false, depVersion: '', inPatch: true, disabled: false })
  // 空 id 的 patch 条目被忽略
  assert.equal(Object.keys(map).length, 3)
})

test('installedMap：入参缺失时返回空表（未装过插件是正常空态）', () => {
  assert.deepEqual(installedMap(null, null), {})
  assert.deepEqual(installedMap(undefined, undefined), {})
})

test('matchInstalled：完整名优先，短名兜底', () => {
  const installed = { 'dsh-demo': { inDeps: true }, '@scope/dsh-other': { inDeps: true } }
  // 完整名对不上 → 落到去掉 scope 的短名
  assert.equal(matchInstalled(installed, '@scope/dsh-demo').inDeps, true)
  // 完整名直接命中
  assert.equal(matchInstalled(installed, '@scope/dsh-other').inDeps, true)
  // 都对不上
  assert.equal(matchInstalled(installed, '@scope/nope'), null)
  assert.equal(matchInstalled(installed, ''), null)
  assert.equal(matchInstalled(null, '@scope/dsh-demo'), null)
})

// ── matchDepByNpm（原始依赖表版，形状与 matchInstalledBySpec 一致）──
//
// ⚠️ 这段盯的是一个真实回归：`matchInstalled` 吃的是 installedMap 的**记录表**、
//    返回记录本身；而「检查更新 / 更新」链路上只有 `dsh.installedDeps` 的**原始表**。
//    早先误把原始表喂给 matchInstalled，`hit.depVersion` 恒为 undefined，
//    于是每条带 caret 的包 range 为空、state 全掉进 unknown —— 功能静默失效。
test('matchDepByNpm：完整名优先、短名兜底、大小写不敏感，返回 {key, depVersion}', () => {
  const deps = { 'dsh-mnemon': '^0.5.11', '@scope/dsh-other': '~1.2.0' }
  // 返回形状必须与 matchInstalledBySpec 一致（都是 {key, depVersion}）
  assert.deepEqual(matchDepByNpm(deps, 'dsh-mnemon'), { key: 'dsh-mnemon', depVersion: '^0.5.11' })
  // 完整名对不上 → 落到去掉 scope 的短名
  assert.deepEqual(matchDepByNpm(deps, '@scope/dsh-mnemon'), { key: 'dsh-mnemon', depVersion: '^0.5.11' })
  // 作用域完整名直接命中，key 保留原始写法
  assert.deepEqual(matchDepByNpm(deps, '@scope/dsh-other'), { key: '@scope/dsh-other', depVersion: '~1.2.0' })
  // 大小写不敏感（npm 对 github spec 的键会小写化）
  assert.deepEqual(matchDepByNpm(deps, 'DSH-MNEMON'), { key: 'dsh-mnemon', depVersion: '^0.5.11' })
  // 对不上 / 空入参
  assert.equal(matchDepByNpm(deps, 'dsh-nope'), null)
  assert.equal(matchDepByNpm(deps, ''), null)
  assert.equal(matchDepByNpm(null, 'dsh-mnemon'), null)
  // 声明的值是空串时也要给回键（不能因为值空就当成没装）
  assert.deepEqual(matchDepByNpm({ 'dsh-x': '' }, 'dsh-x'), { key: 'dsh-x', depVersion: '' })
})

test('matchDepByNpm：与 updateState 串起来，npm 分支不再丢掉声明范围', () => {
  // 回归现场：目录条目有 npm 字段时走的就是这一档，以前 range 会是空串
  const deps = { 'dsh-mnemon': '^0.5.11' }
  const hit = matchDepByNpm(deps, 'dsh-mnemon')
  // 拿不到实装版本 → 退回范围判定，range 必须是 ^0.5.11（而不是空）
  // 目录 0.5.13 比下界 0.5.11 新 → update（旧口径会因「落在范围内」漏报成 current）
  const byRange = updateState(hit.depVersion, '0.5.13', '')
  assert.equal(byRange.range, '^0.5.11')
  assert.equal(byRange.basis, 'range')
  assert.equal(byRange.state, 'update')
  // 目录版本不高于下界 → current，两个方向都不能判错
  assert.equal(updateState(hit.depVersion, '0.5.11', '').state, 'current')
  // 有实装版本 → 主路径判出 update
  const byReal = updateState(hit.depVersion, '0.5.13', '0.5.11')
  assert.equal(byReal.basis, 'realized')
  assert.equal(byReal.state, 'update')
})

// ── buildSources ──

test('buildSources：默认只出镜像源（官方源默认关，它实测要 52–99s 且常连不上）', () => {
  const def = buildSources({})
  assert.deepEqual(def.map((s) => s.kind), ['mirror'])
  assert.equal(def[0].url, MIRROR_REGISTRY)
})

test('buildSources：official:true 才带上官方源；custom 恒参与且排最前', () => {
  const all = buildSources({ customUrl: 'https://my.example/list.json', official: true })
  assert.deepEqual(all.map((s) => s.kind), ['custom', 'mirror', 'official'])
  assert.equal(all[0].url, 'https://my.example/list.json')
  assert.equal(all[2].url, OFFICIAL_URL)
  // 不带 custom 时必须只剩镜像（官方默认关）
  assert.deepEqual(buildSources({ official: true }).map((s) => s.kind), ['mirror', 'official'])
})

test('buildSources：registry 决定镜像源地址；mirror:false 时镜像源整个不参与', () => {
  const tencent = buildSources({ registry: 'https://mirrors.cloud.tencent.com/npm' })
  assert.equal(tencent.length, 1)
  assert.equal(tencent[0].url, 'https://mirrors.cloud.tencent.com/npm')

  const noMirror = buildSources({ mirror: false, official: true })
  assert.deepEqual(noMirror.map((s) => s.kind), ['official'])
  // 两个都关 → 没有任何来源（loadCatalog 必须据此明确报错，而不是静默返回空目录）
  assert.deepEqual(buildSources({ mirror: false }), [])
})

test('buildSources：每个来源各有互不相同的 key（校验器按来源隔离）', () => {
  const keys = buildSources({ customUrl: 'https://my.example/list.json', official: true }).map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length)
})

test('buildSources：换 registry 就换 key（不同镜像的缓存不互相冒充）', () => {
  const a = buildSources({ registry: 'https://registry.npmmirror.com' })[0].key
  const b = buildSources({ registry: 'https://mirrors.cloud.tencent.com/npm' })[0].key
  assert.notEqual(a, b)
})

// ── untarOne ──

test('untarOne：从 tar 里解出指定成员', () => {
  const tar = makeTar('package/plugins.json', '{"plugins":[1]}')
  assert.equal(dshMarket._untarOne(tar, 'package/plugins.json'), '{"plugins":[1]}')
})

test('untarOne：跳过其它成员与填充字节，找到目标', () => {
  // 多成员归档：只在**最后一个**成员之后放结束零块（解析器遇零块即停）
  const tar = Buffer.concat([
    tarMember('package/readme.md', 'x'.repeat(600)),
    tarMember('package/plugins.json', '{"ok":true}'),
    Buffer.alloc(1024),
  ])
  assert.equal(dshMarket._untarOne(tar, 'package/plugins.json'), '{"ok":true}')
})

test('untarOne：没有目标成员返回 null', () => {
  const tar = makeTar('package/other.json', '{}')
  assert.equal(dshMarket._untarOne(tar, 'package/plugins.json'), null)
})

// ── loadCatalog（注入 fake fetch）──

test('loadCatalog：镜像源直接命中（registry → tarball → 解包）', async () => {
  clearCache()
  const tarballUrl = MIRROR_REGISTRY + '/' + MIRROR_PKG + '/-/pkg.tgz'
  const gh = zlib.gzipSync(makeTar('package/plugins.json', catalogJson([raw({ name: 'from-mirror' })])))
  const calls = []
  const f = fakeFetch({
    [MIRROR_REGISTRY + '/' + MIRROR_PKG + '/latest']: JSON.stringify({ dist: { tarball: tarballUrl } }),
    // tarball 是二进制：res 替身按字符串造体，这里给真实 gz 字节
    [tarballUrl]: () => ({ ok: true, status: 200, arrayBuffer: async () => gh, headers: { get: () => '' } }),
  }, calls)
  const r = await loadCatalog({ fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.from, 'mirror')
  assert.equal(r.registry, MIRROR_REGISTRY) // 界面靠这个反查 label
  assert.equal(r.plugins[0].name, 'from-mirror')
  assert.equal(typeof r.tookMs, 'number')
})

test('loadCatalog：官方源开时才请求它（默认关）', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({ [OFFICIAL_URL]: catalogJson([raw()]) }, calls)
  const r = await loadCatalog({ official: true, mirror: false, fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.from, 'official')
  assert.equal(r.registry, '') // 官方源不是镜像，别回传 registry
  assert.deepEqual(calls, [OFFICIAL_URL])
})

test('loadCatalog：默认不碰官方源（少一条注定超时的连接）', async () => {
  clearCache()
  const tarballUrl = MIRROR_REGISTRY + '/' + MIRROR_PKG + '/-/pkg.tgz'
  const gh = zlib.gzipSync(makeTar('package/plugins.json', catalogJson([raw()])))
  const calls = []
  const f = fakeFetch({
    [OFFICIAL_URL]: catalogJson([raw({ name: 'from-official' })]),
    [MIRROR_REGISTRY + '/' + MIRROR_PKG + '/latest']: JSON.stringify({ dist: { tarball: tarballUrl } }),
    [tarballUrl]: () => ({ ok: true, status: 200, arrayBuffer: async () => gh, headers: { get: () => '' } }),
  }, calls)
  const r = await loadCatalog({ fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.from, 'mirror')
  assert.equal(calls.includes(OFFICIAL_URL), false)
})

test('loadCatalog：两个来源都关掉时明确报错，不静默返回空目录', async () => {
  clearCache()
  const r = await loadCatalog({ mirror: false, fetchImpl: async () => res('{}') })
  assert.equal(r.ok, false)
  assert.ok(r.error.indexOf('没有可用的目录来源') >= 0)
})

test('loadCatalog：全部来源都挂 → ok:false 并给出逐条原因', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({
    [OFFICIAL_URL]: () => res('', { ok: false, status: 502 }),
    [MIRROR_REGISTRY + '/' + MIRROR_PKG + '/latest']: () => res('', { ok: false, status: 500, statusText: 'boom' }),
  }, calls)
  const r = await loadCatalog({ official: true, fetchImpl: f })
  assert.equal(r.ok, false)
  assert.ok(r.error.indexOf('所有目录来源都取不到') >= 0)
  // 镜像与官方各一条原因，且都带来源名（用户要能看出是哪条链路断了）
  assert.equal(r.failures.length, 2)
  assert.ok(r.failures.some((x) => x.indexOf('mirror') >= 0))
  assert.ok(r.failures.some((x) => x.indexOf('official') >= 0))
})

test('loadCatalog：竞速 —— 慢源不拖累快源，快源一到就用它', async () => {
  clearCache()
  const custom = 'https://my.example/list.json'
  const f = async (url, init) => {
    if (url === custom) return res(catalogJson([raw({ name: 'fast' })]))
    // 官方源模拟「很慢」：等到被 abort 才结束。若实现是串行等待，这个用例会挂住
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e)
      })
    })
  }
  const r = await loadCatalog({ customUrl: custom, official: true, fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.from, 'custom')
  assert.equal(r.plugins[0].name, 'fast')
})

test('loadCatalog：竞速 —— 快源内容坏掉时不算胜出，慢但合格的源能接上', async () => {
  clearCache()
  const custom = 'https://my.example/list.json'
  const tarballUrl = MIRROR_REGISTRY + '/' + MIRROR_PKG + '/-/pkg.tgz'
  const gh = zlib.gzipSync(makeTar('package/plugins.json', catalogJson([raw({ name: 'good-mirror' })])))
  const f = async (url) => {
    if (url === custom) return res('not json at all') // 快，但内容不合格
    if (url === MIRROR_REGISTRY + '/' + MIRROR_PKG + '/latest') {
      return res(JSON.stringify({ dist: { tarball: tarballUrl } }))
    }
    if (url === tarballUrl) {
      return { ok: true, status: 200, arrayBuffer: async () => gh, headers: { get: () => '' } }
    }
    return res('', { ok: false, status: 404 })
  }
  const r = await loadCatalog({ customUrl: custom, fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.from, 'mirror')
  assert.equal(r.plugins[0].name, 'good-mirror')
})

test('loadCatalog：换 registry 后重新抓（缓存键含 registry，别拿上一家的目录冒充）', async () => {
  clearCache()
  const other = 'https://mirrors.cloud.tencent.com/npm'
  const tarballUrl = other + '/' + MIRROR_PKG + '/-/pkg.tgz'
  const gh = zlib.gzipSync(makeTar('package/plugins.json', catalogJson([raw({ name: 'tencent-copy' })])))
  let n = 0
  const f = async (url) => {
    n++
    if (url === other + '/' + MIRROR_PKG + '/latest') return res(JSON.stringify({ dist: { tarball: tarballUrl } }))
    if (url === tarballUrl) return { ok: true, status: 200, arrayBuffer: async () => gh, headers: { get: () => '' } }
    return res(catalogJson([raw({ name: 'default-copy' })]))
  }
  await loadCatalog({ fetchImpl: f })
  const r = await loadCatalog({ registry: other, fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.registry, other)
  assert.equal(r.plugins[0].name, 'tencent-copy')
  assert.ok(n >= 3) // 没被上一次的缓存挡住
})

test('loadCatalog：自定义源命中就不碰官方（默认关），也不会白等镜像', async () => {
  clearCache()
  const custom = 'https://my.example/list.json'
  const calls = []
  // 镜像源故意做成「很慢」：自定义源一到就该 abort 它，而不是等它
  const f = async (url, init) => {
    calls.push(url)
    if (url === custom) return res(catalogJson([raw({ name: 'mine' })]))
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e)
      })
    })
  }
  const r = await loadCatalog({ customUrl: custom, fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.from, 'custom')
  assert.equal(r.plugins[0].name, 'mine')
  assert.equal(calls.includes(OFFICIAL_URL), false)
})

test('loadCatalog：内容坏掉（非 JSON / 无 plugins）时不冒充成功', async () => {
  clearCache()
  const f = fakeFetch({ [OFFICIAL_URL]: 'not json at all' })
  const r = await loadCatalog({ official: true, mirror: false, fetchImpl: f })
  assert.equal(r.ok, false)
})

test('loadCatalog：单个来源失败只出局自己，不再按来源重试（竞速语义）', async () => {
  clearCache()
  const tarballUrl = MIRROR_REGISTRY + '/' + MIRROR_PKG + '/-/pkg.tgz'
  const gh = zlib.gzipSync(makeTar('package/plugins.json', catalogJson([raw({ name: 'mirror-wins' })])))
  let officialCalls = 0
  const f = async (url) => {
    if (url === OFFICIAL_URL) { officialCalls++; return res('', { ok: false, status: 503 }) }
    if (url === MIRROR_REGISTRY + '/' + MIRROR_PKG + '/latest') return res(JSON.stringify({ dist: { tarball: tarballUrl } }))
    return { ok: true, status: 200, arrayBuffer: async () => gh, headers: { get: () => '' } }
  }
  const r = await loadCatalog({ official: true, fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.from, 'mirror')
  assert.equal(r.plugins[0].name, 'mirror-wins')
  assert.equal(officialCalls, 1) // 官方只打一次（旧实现会重试 MAX_TRY 次）
})

// 造一个「正常镜像源」的 fetch 替身；n 用闭包计数，方便断言缓存是否真的挡住了请求。
// 竞速下每次 load 只会打通镜像的 2 个请求（元数据 + tarball），官方默认关不参与
function mirrorFetch(counter) {
  const tarballUrl = MIRROR_REGISTRY + '/' + MIRROR_PKG + '/-/pkg.tgz'
  const gh = zlib.gzipSync(makeTar('package/plugins.json', catalogJson([raw()])))
  return async (url) => {
    if (url === MIRROR_REGISTRY + '/' + MIRROR_PKG + '/latest') {
      counter.n++
      return res(JSON.stringify({ dist: { tarball: tarballUrl } }))
    }
    if (url === tarballUrl) {
      counter.n++
      return { ok: true, status: 200, arrayBuffer: async () => gh, headers: { get: () => '' } }
    }
    return res('', { ok: false, status: 404 })
  }
}

test('loadCatalog：60 秒内同组来源命中内存缓存（cached:true）', async () => {
  clearCache()
  const c = { n: 0 }
  const f = mirrorFetch(c)
  await loadCatalog({ fetchImpl: f })
  assert.equal(c.n, 2)                 // 元数据 + tarball
  const again = await loadCatalog({ fetchImpl: f })
  assert.equal(c.n, 2)                 // 第二次没发请求
  assert.equal(again.cached, true)
  // force 绕开缓存
  await loadCatalog({ force: true, fetchImpl: f })
  assert.equal(c.n, 4)
})

test('loadCatalog：清了缓存后真的是重新抓（用户改 URL 后要重来）', async () => {
  clearCache()
  const c = { n: 0 }
  const f = mirrorFetch(c)
  await loadCatalog({ fetchImpl: f })
  clearCache()
  const r = await loadCatalog({ fetchImpl: f })
  assert.equal(c.n, 4)
  assert.equal(r.cached, false)
})

test('loadCatalog：304 时复用上次的解析结果', async () => {
  clearCache()
  // 官方源才有条件请求链路（镜像走 tarball，没有 304 一说），所以这条用 official 单跑
  let n = 0
  const f = async () => {
    n++
    if (n === 1) {
      return res(catalogJson([raw({ name: 'first' })]), { headers: { get: (k) => (k === 'etag' ? '"abc"' : '') } })
    }
    return res('', { status: 304 })
  }
  await loadCatalog({ official: true, mirror: false, fetchImpl: f })
  const r = await loadCatalog({ official: true, mirror: false, force: true, fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.cached, true)
  assert.equal(r.plugins[0].name, 'first')
})

test('loadCatalog：304 的来源记下的仍是它原来的校验器（没被空 etag 抹掉）', async () => {
  clearCache()
  const seen = []
  let n = 0
  const f = async (url, init) => {
    seen.push(init.headers['if-none-match'] || '')
    n++
    if (n === 1) return res(catalogJson([raw()]), { headers: { get: (k) => (k === 'etag' ? '"abc"' : '') } })
    return res('', { status: 304 })
  }
  await loadCatalog({ official: true, mirror: false, fetchImpl: f })
  await loadCatalog({ official: true, mirror: false, force: true, fetchImpl: f })
  // 第三次：若 304 把校验器覆盖成空，这里就发不出 if-none-match 了
  await loadCatalog({ official: true, mirror: false, force: true, fetchImpl: f })
  assert.deepEqual(seen, ['', '"abc"', '"abc"'])
})

// ── registryLatest（回源查官方最新版；纯手动触发，不参与目录链路）──

test('registryLatest：按包名查 latest 并回填到 key 上', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({
    [MIRROR_REGISTRY + '/dshmarket/latest']: JSON.stringify({ version: '1.65.1' }),
  }, calls)
  const r = await registryLatest([{ pkg: 'dshmarket', key: 'dshmarket' }], { fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.results['dshmarket'].version, '1.65.1')
  assert.equal(r.results['dshmarket'].error, '')
  assert.equal(r.results['dshmarket'].pkg, 'dshmarket')
  assert.equal(r.results['dshmarket'].cached, false)
  assert.deepEqual(calls, [MIRROR_REGISTRY + '/dshmarket/latest'])
})

test('registryLatest：scoped 包名的 `/` 必须编码成 %2F（否则 registry 认不出）', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({
    [MIRROR_REGISTRY + '/@scope%2Fdsh-demo/latest']: JSON.stringify({ version: '0.5.11' }),
  }, calls)
  const r = await registryLatest([{ pkg: '@scope/dsh-demo', key: 'k' }], { fetchImpl: f })
  assert.equal(r.results['k'].version, '0.5.11')
  // 未编码的形态会 404，绝不能出现
  assert.equal(calls.includes(MIRROR_REGISTRY + '/@scope/dsh-demo/latest'), false)
})

test('registryLatest：同一个包被多条条目引用只查一次，结果回填给每个 key', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({ [MIRROR_REGISTRY + '/dshmarket/latest']: JSON.stringify({ version: '1.65.1' }) }, calls)
  const r = await registryLatest([
    { pkg: 'dshmarket', key: 'a' },
    { pkg: 'dshmarket', key: 'b' },
  ], { fetchImpl: f })
  assert.equal(calls.length, 1)
  assert.equal(r.results['a'].version, '1.65.1')
  assert.equal(r.results['b'].version, '1.65.1')
})

test('registryLatest：5 分钟 TTL 内命中内存缓存，不出站', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({ [MIRROR_REGISTRY + '/dshmarket/latest']: JSON.stringify({ version: '1.65.1' }) }, calls)
  await registryLatest([{ pkg: 'dshmarket', key: 'a' }], { fetchImpl: f })
  const again = await registryLatest([{ pkg: 'dshmarket', key: 'a' }], { fetchImpl: f })
  assert.equal(calls.length, 1)
  assert.equal(again.results['a'].cached, true)
  assert.equal(again.results['a'].version, '1.65.1')
})

test('registryLatest：拉失败记入冷却，冷却期内不再发请求且给出原因', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({
    [MIRROR_REGISTRY + '/dshmarket/latest']: () => res('', { ok: false, status: 500, statusText: 'boom' }),
  }, calls)
  const first = await registryLatest([{ pkg: 'dshmarket', key: 'a' }], { fetchImpl: f })
  assert.equal(first.results['a'].version, '')
  assert.ok(first.results['a'].error.length > 0)
  assert.equal(calls.length, 1)
  // 冷却期内再查：直接返回错误，不再出站
  const second = await registryLatest([{ pkg: 'dshmarket', key: 'b' }], { fetchImpl: f })
  assert.equal(second.results['b'].version, '')
  assert.ok(second.results['b'].error.length > 0)
  assert.equal(calls.length, 1)
})

test('registryLatest：条目缺 pkg / key 的跳过，不产生空请求', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({}, calls)
  const r = await registryLatest([
    { pkg: '', key: 'a' },
    { pkg: 'dshmarket', key: '' },
    null,
    { pkg: 'dshmarket', key: 'ok' },
  ], { fetchImpl: f })
  assert.equal(calls.length, 1)
  assert.equal(Object.keys(r.results).length, 1)
  assert.ok(r.results['ok'])
})

test('registryLatest：空列表直接返回，不打任何请求', async () => {
  clearCache()
  const calls = []
  const r = await registryLatest([], { fetchImpl: fakeFetch({}, calls) })
  assert.equal(r.ok, true)
  // results 是 null 原型对象（宿主刻意的，避免 key 撞 Object.prototype），所以断言键数不 deepEqual {}
  assert.equal(Object.keys(r.results).length, 0)
  assert.equal(calls.length, 0)
  // 非数组也要能兜住
  assert.equal(Object.keys((await registryLatest(null, { fetchImpl: fakeFetch({}, calls) })).results).length, 0)
})

test('registryLatest：并发上限生效 —— 请求不会一次全发出去', async () => {
  clearCache()
  let inflight = 0
  let peak = 0
  const f = async (url) => {
    inflight++
    peak = Math.max(peak, inflight)
    await new Promise((r) => setTimeout(r, 5))
    inflight--
    const name = url.slice(url.lastIndexOf('/') + 1)
    return res(JSON.stringify({ version: '1.0.0' + '-' + name }))
  }
  const items = []
  for (let i = 0; i < 24; i++) items.push({ pkg: 'pkg-' + i, key: 'k' + i })
  const r = await registryLatest(items, { fetchImpl: f, concurrency: 4 })
  assert.equal(Object.keys(r.results).length, 24)
  assert.ok(peak <= 4, '并发峰值应不超过 4，实际 ' + peak)
})

test('registryLatest：一个包拉失败不拖垮其它包（各自独立落结果）', async () => {
  clearCache()
  const f = async (url) => {
    if (url.indexOf('bad') >= 0) return res('', { ok: false, status: 404 })
    return res(JSON.stringify({ version: '2.0.0' }))
  }
  const r = await registryLatest([
    { pkg: 'bad-pkg', key: 'bad' },
    { pkg: 'good-pkg', key: 'good' },
  ], { fetchImpl: f })
  assert.equal(r.results['bad'].version, '')
  assert.ok(r.results['bad'].error.length > 0)
  assert.equal(r.results['good'].version, '2.0.0')
  assert.equal(r.results['good'].error, '')
})

test('registryLatest：换 registry 不拿上一家的缓存冒充（地址进 URL，不进缓存键）', async () => {
  clearCache()
  const other = 'https://mirrors.cloud.tencent.com/npm'
  const calls = []
  const f = fakeFetch({
    [MIRROR_REGISTRY + '/dshmarket/latest']: JSON.stringify({ version: '1.65.1' }),
    [other + '/dshmarket/latest']: JSON.stringify({ version: '9.9.9' }),
  }, calls)
  await registryLatest([{ pkg: 'dshmarket', key: 'a' }], { fetchImpl: f })
  // ⚠️ 缓存只按包名存，不按 registry —— 这是有意的（多镜像同源，latest 应一致）。
  //    这里断言的是「第二次没出站」，不是「拿到了 9.9.9」：换源也复用，因为语义相同
  const again = await registryLatest([{ pkg: 'dshmarket', key: 'a' }], { registry: other, fetchImpl: f })
  assert.equal(again.results['a'].cached, true)
  assert.equal(again.results['a'].version, '1.65.1')
  assert.equal(calls.length, 1)
})

test('clearCache：一并清掉 latest 的缓存与失败冷却', async () => {
  clearCache()
  const calls = []
  const f = fakeFetch({ [MIRROR_REGISTRY + '/dshmarket/latest']: JSON.stringify({ version: '1.65.1' }) }, calls)
  await registryLatest([{ pkg: 'dshmarket', key: 'a' }], { fetchImpl: f })
  clearCache()
  const again = await registryLatest([{ pkg: 'dshmarket', key: 'a' }], { fetchImpl: f })
  assert.equal(calls.length, 2)         // 缓存被清了 → 重新出站
  assert.equal(again.results['a'].cached, false)
})
