/*
 * settings.js 里 parseAllowBuilds 的回归测试（node --test，零依赖）。
 *
 * 为什么单独盯这一个纯函数：github / tarball 来源的插件靠 `prepare` 脚本构建，
 * **pnpm 默认拦截构建**，会打一段报错并给出要写进 pnpm-workspace.yaml 的 key。
 * 那把 key 形如 `名字@https://codeload.github.com/owner/repo/tar.gz/<commit>`，
 * **带 commit hash、安装前拿不到** —— 所以「需构建」的条目注定先失败一次，
 * 界面只能把 dsh 给的原文照搬给用户。抠错 key 等于引导用户写错一行 yaml，
 * 且写错了 dsh 不报错（V2 的教训），属于静默失效型，必须钉住。
 *
 * settings.js 顶层 require 了 log.js（→ utools.getPath），所以先挂桩再 require。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── utools 桩：settings.js 顶层只需 getPath（log.js 用它定位落盘目录）──
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  dbCryptoStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}

const require = createRequire(import.meta.url)
const settings = require('../public/preload/lib/settings.js')

// 真实报错原文（2026-09-23 实跑 `dsh plugin --profile web add github:omdsh-dev/DSH-better-sidebar` 抄下来）
const REAL_OUT = [
  '✓ Lockfile passes supply-chain policies (verified 1d ago)',
  'Progress: resolved 1, reused 0, downloaded 0, added 0',
  '[WARN] HEAD https://github.com/omdsh-dev/DSH-better-sidebar error (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Will retry in 500 milliseconds. 2 retries left.',
  '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://github.com/omdsh-dev/DSH-better-sidebar.git": The git-hosted package "dsh-better-sidebar@0.19.1" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
  '',
  'This error happened while installing a direct dependency of C:\\Users\\Berge\\.dsh\\profiles\\web',
  '',
  'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
  'allowBuilds:',
  '  dsh-better-sidebar@git+https://github.com/omdsh-dev/DSH-better-sidebar.git#1fcf43ccbedd6e66370b7fb81df2b4dd0ef2604e: true',
  'dsh: pnpm failed; diagnostics: C:\\Users\\Berge\\.dsh\\profiles\\web\\.plugin-manager\\logs\\operation-d8lVYk\\pnpm.log',
  'dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in C:\\Users\\Berge\\.dsh\\profiles\\web\\pnpm-workspace.yaml, then re-run',
].join('\n')

test('parseAllowBuilds：从真实报错里抠出带 commit hash 的 key 与 yaml 路径', () => {
  const r = settings.parseAllowBuilds(REAL_OUT)
  // key 形态是 `名字@git+https://….git#<hash>`，且**不是**反引号包起来的（早先那版会抠到空串）
  assert.equal(r.key, 'dsh-better-sidebar@git+https://github.com/omdsh-dev/DSH-better-sidebar.git#1fcf43ccbedd6e66370b7fb81df2b4dd0ef2604e')
  assert.equal(r.file, 'C:\\Users\\Berge\\.dsh\\profiles\\web\\pnpm-workspace.yaml')
})

test('parseAllowBuilds：key 取的是 yaml 行本身，不会带上尾部 `: true`', () => {
  const r = settings.parseAllowBuilds('allowBuilds:\n  pkg@https://x.cn/a.tgz: true\n')
  assert.equal(r.key, 'pkg@https://x.cn/a.tgz')
})

test('parseAllowBuilds：输出里没有 allowBuilds 字样一律返回 null（不把普通报错误读成构建拦截）', () => {
  assert.equal(settings.parseAllowBuilds('npm ERR! 404 Not Found - GET https://registry/x'), null)
  assert.equal(settings.parseAllowBuilds(''), null)
  assert.equal(settings.parseAllowBuilds(null), null)
  assert.equal(settings.parseAllowBuilds(undefined), null)
})

test('parseAllowBuilds：有 allowBuilds 但抠不到 key 时 key 为空串（界面据此不展示 key 行）', () => {
  const r = settings.parseAllowBuilds('To allow builds, add an allowBuilds section to pnpm-workspace.yaml')
  assert.equal(r.key, '')
  // 路径也抠不到就退回文件名，界面至少能说出「写在哪」
  assert.equal(r.file, 'pnpm-workspace.yaml')
})

test('parseAllowBuilds：POSIX 绝对路径与相对路径都能抠出来', () => {
  const posix = settings.parseAllowBuilds('allowBuilds\nsee /home/me/.dsh/profiles/web/pnpm-workspace.yaml')
  assert.equal(posix.file, '/home/me/.dsh/profiles/web/pnpm-workspace.yaml')
  const rel = settings.parseAllowBuilds('allowBuilds\nedit profiles/web/pnpm-workspace.yaml')
  assert.equal(rel.file, 'profiles/web/pnpm-workspace.yaml')
})

test('parseAllowBuilds：大小写不敏感（pnpm 文案可能写作 AllowBuilds）', () => {
  const r = settings.parseAllowBuilds('AllowBuilds:\n  a@https://x.cn/a.tgz: true\n')
  assert.equal(r.key, 'a@https://x.cn/a.tgz')
})

// ── 安装期间必须播「阶段旁白」，否则日志卡空白像卡死 ──
//
// ⚠️ 盯的真实反馈（2026-09-25 用户报「等了好久，不知道什么情况，也不知道有没有在安装」）：
//    dsh 的日志流原先只由子进程输出喂养，而「建快照」这段根本没有子进程 —— pnpm 要等
//    快照建完才起。用户那几分钟里看到的是一片空白 + 一句静态提示。
//    修法：动手前先 dsh.note() 播一条阶段说明。这里钉住「旁白确实发出去了」。
test('marketInstall：建快照前与起 pnpm 前都要播阶段旁白（回归：日志卡不能空着）', async () => {
  const savedInstall = dshMod.installPluginPkg
  const savedGlobal = dshMod.globalDsh
  dshMod.installPluginPkg = () => Promise.resolve({ code: 1, ok: false, out: 'boom', err: '' })
  // 夹具环境里没有全局 dsh，但这台机器上有 —— 真写分支会读它，测试必须钉住取值（不能碰真实环境）
  dshMod.globalDsh = () => null
  try {
    const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: FAKE_VERSION, exact: true, targetVersion: '1.57.0' })
    assert.equal(r.ok, false, '这条只验旁白，安装本身失败是预期（stub 返回退出码 1）')
  } finally {
    dshMod.installPluginPkg = savedInstall
    dshMod.globalDsh = savedGlobal
  }
  // 从 dsh 的日志流里捞旁白（note 走的就是 pushLog，与子进程输出同一份缓冲）
  const log = dshMod.progress().log
  assert.match(log, /建 profile 快照/, '建快照前要留一句，否则那段时间日志卡是空的')
  assert.match(log, /快照已建/, '快照建完、起 pnpm 前要再留一句，让用户知道进度真的在走')
})

// ── 结果卡要画 `旧 → 新`，所以 exact 安装必须回 from（装之前的实装版本）──
//
// ⚠️ 盯的真实反馈（2026-09-25 用户报「继续优化或者美化」）：点「装这一版」成功后界面只显示
//    「已安装 dshmarket @1.65.1」，看不出是从 1.62.0 换上来的。前端手上只有**目录版本**
//    （正是滞后的那个），自己拼必然错，所以由宿主在跑 pnpm **之前**回读实装版本回传。
//    这里钉住「from 确实是装前的那个版本」。
//
// ⚠️ 这条必须自己造一套 profile 并在 finally 里删干净：它成功了 = 磁盘版本被改掉了，
//    而后面的 dryRun 几条共用同一份夹具（profile 顶层那份）—— 不还原就会把 1.48.0 改成 1.57.0，
//    后面的用例集体误判（实测踩过：一次改下来 4 条红）
test('marketInstall(exact)：成功时回 from = 装之前的实装版本（供结果卡画 旧 → 新）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-exact-from-'))
  const profDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(profDir, 'node_modules', 'dshmarket'), { recursive: true })
  fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { dshmarket: '^1.48.0' } }))
  fs.writeFileSync(path.join(profDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.48.0' }))
  const savedHome = process.env.DSH_HOME
  const savedInstall = dshMod.installPluginPkg
  const savedGlobal = dshMod.globalDsh
  process.env.DSH_HOME = home
  // 装成功：pnpm 退出码 0，且把 node_modules 与 package.json 里的版本都改成目标版 ——
  // 模拟真装上了，这样宿主回读校验（exact 要求 got === targetVersion）才过得去
  dshMod.installPluginPkg = () => {
    fs.writeFileSync(path.join(profDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.57.0' }))
    fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { dshmarket: '1.57.0' } }))
    return Promise.resolve({ code: 0, ok: true, out: 'ok', err: '' })
  }
  dshMod.globalDsh = () => null
  let r
  try {
    r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', exact: true, targetVersion: '1.57.0' })
  } finally {
    dshMod.installPluginPkg = savedInstall
    dshMod.globalDsh = savedGlobal
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(home, { recursive: true, force: true })
  }
  assert.equal(r.ok, true, '这条需要装成功才验得了 from：' + JSON.stringify(r.error || ''))
  assert.equal(r.from, '1.48.0', 'from 必须是「跑 pnpm 之前」读到的实装版本，不是目录版本、更不是事后版本')
  assert.equal(r.version, '1.57.0', 'version 是装完回读的版本')
})

// 回归（2026-09-25 真机踩到）：pnpm 把 `dshmarket@1.65.1` 写进 profile/package.json 时
// **保留成 `^1.65.1`**（声明范围带 caret），而 node_modules 里的实装版本是 `1.65.1`。
// 早先成功返回体回传的是 `hit.depVersion`（声明范围），界面拼成 `v^1.65.1` ——
// 精确安装的结果卡上冒出 caret，与「精确到 v1.65.1」自相矛盾。必须回传实装版本。
test('marketInstall(exact)：回传的 version 是实装版本，不能带声明范围的 caret（v^1.65.1 是 bug）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-exact-caret-'))
  const profDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(profDir, 'node_modules', 'dshmarket'), { recursive: true })
  fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { dshmarket: '^1.48.0' } }))
  fs.writeFileSync(path.join(profDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.48.0' }))
  const savedHome = process.env.DSH_HOME
  const savedInstall = dshMod.installPluginPkg
  const savedGlobal = dshMod.globalDsh
  process.env.DSH_HOME = home
  // ⚠️ 关键在 package.json 里写 `^1.57.0`（带 caret，与 pnpm 真实行为一致）、
  //    node_modules 里写 `1.57.0`（实装）。两者的差异正是这条回归要盯住的东西
  dshMod.installPluginPkg = () => {
    fs.writeFileSync(path.join(profDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.57.0' }))
    fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { dshmarket: '^1.57.0' } }))
    return Promise.resolve({ code: 0, ok: true, out: 'ok', err: '' })
  }
  dshMod.globalDsh = () => null
  let r
  try {
    r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', exact: true, targetVersion: '1.57.0' })
  } finally {
    dshMod.installPluginPkg = savedInstall
    dshMod.globalDsh = savedGlobal
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(home, { recursive: true, force: true })
  }
  assert.equal(r.ok, true, '这条需要装成功才验得了 version：' + JSON.stringify(r.error || ''))
  assert.equal(r.version, '1.57.0', 'version 必须是实装版本；回成 `^1.57.0` 会让界面画出 v^1.57.0')
  assert.ok(!String(r.version).includes('^'), 'version 里不该出现声明范围的 caret')
})

// ── marketInstall 的 dryRun：已装但落后于目录 → 必须判成「该更新」，不能拦成「无需重复安装」──
//
// ⚠️ 这段盯的是一个**真实 bug**（2026-09-24 用户报的）：声明范围 `^1.48.0` 是容得下 `1.49.0` 的。
//    早先 dryRun 只用 matchInstalledBySpec 判「装没装」，于是已装的包无论目录涨到哪一版，
//    都被判成 already / changed:false —— 用户看着目录里有新版去点「安装」，界面回
//    「已装 dshmarket（^1.48.0），无需重复安装」，更新这条路根本走不通。
//    修法：dryRun 也要比实装版本（口径与 marketCheckUpdates 的 updateState 一致）。
//
// ⚠️ 夹具为什么要建真目录：dryRun 走的是 dsh.installedDeps（读 profile/package.json）+
//    dsh.installedVersions（读 profile/node_modules/<名>/package.json），两个都是**真文件读**。
//    所以这里用 DSH_HOME 指向临时目录造一个最小 profile —— 比打桩更贴近真实链路，
//    也顺手钉住「profile 定位靠 DSH_HOME」这条口径。dryRun 分支不跑 npm、不建快照、不写盘。
const FAKE_VERSION = '1.49.0'
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dsh-home-'))
const PROFILE = 'web'
fs.mkdirSync(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dshmarket'), { recursive: true })
fs.writeFileSync(
  path.join(DSH_HOME, 'profiles', PROFILE, 'package.json'),
  // 关键：声明的是**范围** ^1.48.0，而实装是 1.48.0 —— 目录给 1.49.0 时范围容得下它
  JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { dshmarket: '^1.48.0' } }),
)
fs.writeFileSync(
  path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dshmarket', 'package.json'),
  JSON.stringify({ name: 'dshmarket', version: '1.48.0' }),
)
// ⚠️ 必须在 require settings.js **之前**设好：dsh.js 的 homeDir 是每次调用现取 env 的，
//    但 settings.js 顶层会 require 出一条常驻的模块链，提前设好最稳妥
process.env.DSH_HOME = DSH_HOME

// ⚠️ dryRun 自 A 层宿主兼容性拦截上线后是 **async**（要联网拉那一个包的 manifest 判兼容性）——
//    调用方必须 await；不 await 拿到的是 Promise，`r.ok` 会是 undefined（这几条测试就因此红过）
test('marketInstall dryRun：已装但落后于目录 → changed:true，放行走更新（回归：不能拦成「无需重复安装」）', async () => {
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: FAKE_VERSION, dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.changed, true, '声明范围 ^1.48.0 容得下 1.49.0，但实装只有 1.48.0 —— 磁盘会变，changed 必须是 true')
  assert.equal(r.action, 'install')
  // 文案要说清「从哪版 → 到哪版」：用户看到的是范围原文时并不知道自己装的是哪版
  assert.match(r.message, /1\.49\.0/)
  assert.match(r.message, /已装 1\.48\.0/)
})

test('marketInstall dryRun：实装版本已等于目录版本 → changed:false（重装无意义）', async () => {
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.48.0', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(r.action, 'already')
  assert.match(r.message, /已是目录里的最新版/)
})

test('marketInstall dryRun：目录版本反而更低时不报「更新到旧版」', async () => {
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.47.0', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false, '实装 1.48.0 比目录的 1.47.0 新，不能让人装回旧版')
})

test('marketInstall dryRun：目录没给 version → 不猜，维持「已装」结论', async () => {
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', dryRun: true })
  assert.equal(r.changed, false)
  assert.equal(r.action, 'already')
})

test('marketInstall dryRun：没装过的包仍是 install，且不受新逻辑影响', async () => {
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'definitely-not-installed-xyz', name: 'x', version: '9.9.9', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.equal(r.action, 'install')
  // 装/卸走 pnpm（npm 在 profile 目录里会因 peer 由全局 dsh 提供而 ERESOLVE）
  assert.match(r.message, /pnpm add/)
})

test('marketInstall dryRun：认不出的 spec 直接拒绝，不进入版本判定', () => {
  const r = settings.dshMarketInstall({ profile: PROFILE, spec: 'rm -rf /', dryRun: true })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /不是可安装的 spec/)
})

// ── marketInstall 的 dryRun + exact：装「指定的那一版」，判定基准是 targetVersion 而非目录 ──
//
// ⚠️ 盯的真实 bug（2026-09-25 用户报，实测复现）：用户点了「装这一版」要装 registry 的 v1.65.1，
//    却被告知「已装 dshmarket（1.62.0），无需重复安装」—— 按钮点了没反应。
//    根因：changed 原先只看 updateState(目录版本)，而目录快照比实装还旧
//    （目录 1.61.0 / 实装 1.62.0 → 判成 current → changed:false）。
//    这是把「目录这一维度」的结论错用到了「registry 那一维度」的问题上。
//    修法：exact 时拿实装与 **targetVersion** 比，相等才叫不必装；且文案要说清是「已经是这一版」。
test('marketInstall dryRun：exact 且实装落后于 targetVersion → changed:true（回归：不能拦成「无需重复安装」）', async () => {
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', exact: true, targetVersion: '1.65.1', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true, '实装 1.48.0 ≠ 目标 1.65.1 —— 磁盘会变，changed 必须是 true')
  assert.equal(r.action, 'install')
  // 文案要出现精确 spec（用户点完按钮该看到到底执行了什么）与目标版本
  assert.match(r.message, /dshmarket@1\.65\.1/)
  assert.match(r.message, /1\.65\.1/)
})

test('marketInstall dryRun：exact 的判定**不看目录版本** —— 目录比实装旧也要能装（本次 bug 的核心）', async () => {
  // 目录 1.40.0 远低于实装 1.48.0：常规路径会判「目录更旧、不报更新」，exact 必须无视它
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.40.0', exact: true, targetVersion: '1.65.1', dryRun: true })
  assert.equal(r.changed, true, 'exact 的目标是 targetVersion，与目录版本无关')
  assert.equal(r.action, 'install')
})

test('marketInstall dryRun：exact 且实装已等于 targetVersion → changed:false，文案说清「已经是这一版」', async () => {
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', exact: true, targetVersion: '1.48.0', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(r.action, 'already')
  assert.match(r.message, /已经是 v1\.48\.0/)
})

test('marketInstall dryRun：exact 缺 targetVersion 或版本号非法 → 明确拒绝（不拼出必然失败的 spec）', () => {
  const noVer = settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', exact: true, dryRun: true })
  assert.equal(noVer.ok, false)
  assert.match(String(noVer.error), /确切版本号/)

  // 版本里塞路径/命令注入 —— 拼进 spec 再交给 pnpm 是危险的，必须挡在门外
  const bad = settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', exact: true, targetVersion: '1.0.0; rm -rf /', dryRun: true })
  assert.equal(bad.ok, false)
  assert.match(String(bad.error), /确切版本号/)
})

test('marketInstall dryRun：exact 只认 npm 来源 —— github spec 直接拒绝', () => {
  const r = settings.dshMarketInstall({ profile: PROFILE, spec: 'github:owner/repo', exact: true, targetVersion: '1.0.0', dryRun: true })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /只在 npm 来源上可用/)
})

test('marketInstall dryRun：exact 要求目标版本形如 x.y.z，预发布后缀放行', async () => {
  const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', exact: true, targetVersion: '1.65.1-beta.2', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.match(r.message, /dshmarket@1\.65\.1-beta\.2/)
})

// ── marketUpdate 的「假成功」：pnpm 退出码 0 但版本没变，不能说「已更新」──
//
// ⚠️ 盯的真实 bug（2026-09-24 用户报，实测复现）：profile 的 pnpm-workspace.yaml 里有
//    `minimumReleaseAgeExclude` 供应链白名单，`dshmarket` 那条被写死成 `dshmarket@1.45.1 || 1.48.0`。
//    pnpm 解析时**把目录里的 1.57.0 排除掉**，回退到「当前锁定的 1.48.0」这个唯一合法解，
//    于是报 `✓ Lockfile passes supply-chain policies` + `Done` + **退出码 0**，磁盘却一字未改。
//    旧代码只看退出码就 ok:true，界面显示「已更新 dshmarket（v1.48.0 → v1.48.0）」——荒谬的假成功。
//    修法：回读后的实装版本若与更新前相同，判 ok:false 并指明被哪个文件的哪个键挡住。
//
// ⚠️ 打桩说明：marketUpdate 会真的调 dsh.installPluginPkg（起 pnpm 子进程）。
//    这里替换 dsh 模块上的那个函数，模拟「pnpm 报成功但什么也没改」，其余链路（快照、
//    回读 package.json / node_modules）全部走真实实现 —— 要验的正是「回读能否戳穿假成功」。
const dshMod = require('../public/preload/lib/dsh.js')

test('marketUpdate：pnpm 报成功但实装版本没变 → ok:false（回归：不能显示「已更新 v1.48.0 → v1.48.0」）', async () => {
  const saved = dshMod.installPluginPkg
  dshMod.installPluginPkg = () => Promise.resolve({ code: 0, ok: true, out: '✓ Lockfile passes supply-chain policies\nDone in 1.4s', err: '' })
  try {
    // 夹具里实装就是 1.48.0，pnpm「成功」后回读仍是 1.48.0
    const r = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' })
    assert.equal(r.ok, false, '退出码 0 但版本没变，不能算成功')
    assert.equal(r.blocked, true)
    assert.equal(r.from, '1.48.0')
    assert.equal(r.version, '1.48.0')
    // 文案必须给出「该改哪个文件的哪个键」，否则用户只能干瞪眼
    assert.match(String(r.error), /供应链策略/)
    assert.match(String(r.error), /minimumReleaseAgeExclude/)
    assert.match(String(r.error), /pnpm-workspace\.yaml/)
    assert.match(String(r.error), /1\.57\.0/, '要提示把哪个版本加进白名单')
  } finally {
    dshMod.installPluginPkg = saved
  }
})

// ── 「立即清理」的保留份数：要按**用户眼前那个数字**清，而不是已保存的旧值 ──
//
// ⚠️ 盯的真实 bug（2026-09-24 用户报「立即清理功能存在问题」）：早先 dshBackupPrune 恒用
//    retentionKeep()（= 已保存的配置值，默认 20）。于是「把输入框改成 2 → 不点保存 → 直接点
//    立即清理」会拿旧的 20 去清，什么都没删还提示「没有超出保留份数（20 份）的」——
//    用户看到的现象就是「立即清理不工作」。
//    修法：dshBackupPrune 接受可选的 o.keep 作为**本次清理的临时份数**（不写配置）。
//
// ⚠️ 这里连建 3 份快照再按 keep=1 清，验的是「宿主层真的把 keep 透传给了 pruneSnapshots」；
//    pruneSnapshots 自身的计数/保护语义由 dsh-backup.test.mjs 覆盖，不在这里重复。
test('dshBackupPrune：按传入的 keep 清理（回归：不能拿已保存的旧值去清，否则改了数字点清理等于没反应）', () => {
  const dirs = []
  for (let i = 0; i < 3; i++) {
    const r = settings.dshBackupCreate({ profile: PROFILE })
    assert.equal(r.ok, true, r.error)
    dirs.push(r.dirName)
    // 同一秒连建会撞名（模块用毫秒后缀兜底），这里等一毫秒让时间戳自然错开
    const t = Date.now(); while (Date.now() - t < 2) { /* spin */ }
  }
  assert.ok(settings.dshBackupList().snapshots.length >= 3, '三份快照都要能列出来')

  // 传 keep=1：应当删到只剩 1 份未固定快照
  const r = settings.dshBackupPrune({ keep: 1 })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.keep, 1, '返回体里的 keep 必须是调用方传的那个，否则界面文案会张冠李戴')
  assert.ok(r.removed.length >= 2, '传了 1 就该把多余的删掉；早先恒用配置值 20 会导致这里一份都不删')
  assert.equal(settings.dshBackupList().snapshots.length, 1)
})

test('dshBackupPrune：省略 keep 时回落配置值（不传参的旧调用方行为不变）', () => {
  const before = settings.dshBackupList().snapshots.length
  const r = settings.dshBackupPrune()
  assert.equal(r.ok, true, r.error)
  // 配置读不出来（测试里 dbStorage 是空桩）→ 回落 MAX_SNAPSHOTS=20；份数远没到，一份都不该删
  assert.equal(r.keep, settings.dshBackupList().max, '省略 keep 时用当前生效的保留份数')
  assert.deepEqual(r.removed, [], '份数没超上限就不该删东西')
  assert.equal(settings.dshBackupList().snapshots.length, before)
})

test('dshBackupPrune：keep 越界被夹到合法区间（与 dshBackupSetKeep 同一套边界）', () => {
  // 负数 → 夹到 KEEP_MIN=1，不能变成「删光所有未固定快照」
  const r = settings.dshBackupPrune({ keep: -5 })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.keep, 1)
  // 超大值 → 夹到 KEEP_MAX，不会因为溢出而异常
  const r2 = settings.dshBackupPrune({ keep: 999999 })
  assert.equal(r.ok, true, r2.error)
  assert.equal(r2.keep, settings.dshBackupList().keepMax)
})

test('marketUpdate：回读版本真的变了才报成功（不能把正常升级也一并拦掉）', async () => {
  const saved = dshMod.installPluginPkg
  const pkgFile = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dshmarket', 'package.json')
  dshMod.installPluginPkg = () => {
    // 模拟 pnpm 真的把包装上了：node_modules 里的实装版本随之变化
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'dshmarket', version: '1.57.0' }))
    return Promise.resolve({ code: 0, ok: true, out: 'Done in 1.4s', err: '' })
  }
  try {
    const r = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' })
    assert.equal(r.ok, true, '版本从 1.48.0 变成 1.57.0，这是真升级，必须放行')
    assert.equal(r.from, '1.48.0')
    assert.equal(r.version, '1.57.0')
    assert.equal(r.blocked, undefined)
  } finally {
    dshMod.installPluginPkg = saved
    // 还原夹具，避免污染后面的用例
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'dshmarket', version: '1.48.0' }))
  }
})

// ── RESOLVED_VERSION_MISMATCH：装完的版本与目标**不一致**，但只有「低于」才算失败 ──
//
// ⚠️ 这条的方向极容易写反。dnf 的 `resolvedVersion !== targetVersion` 看上去对称，实则不然：
//    镜像是异步同步的，可能**抢先**发布了比目录还新的版本（目录还没更新），那一刻装上去的就是
//    更新的版本 —— 这是**好事**，报成失败会把用户引向无谓的排查。只有实装 < 目标才是
//    「没装到位」。故单列纯函数钉住方向，避免日后被「对称比较」改回去。
test('mismatchResolved：实装低于目标才算不匹配（这是唯一该报的方向）', () => {
  assert.equal(settings.mismatchResolved('1.57.0', '1.40.0'), true, '比目标低 = 没装到位')
  assert.equal(settings.mismatchResolved('1.48.0', '1.48.0'), false, '与目标一致是正常')
  assert.equal(settings.mismatchResolved('1.48.0', '1.57.0'), false, '比目标**高**是镜像抢先，是好事，绝不能报错')
})

test('mismatchResolved：任一侧版本不可解析时不报不匹配（无从比较就不能猜）', () => {
  assert.equal(settings.mismatchResolved('', '1.40.0'), false, '目标为空时不能凭空判错')
  assert.equal(settings.mismatchResolved('1.57.0', ''), false, '实装读不出来时留给 updateState 兜底')
  assert.equal(settings.mismatchResolved('^1.2.0', '1.40.0'), false, 'range 不是实装版本')
  assert.equal(settings.mismatchResolved(null, undefined), false)
})

// ── staleReason：「版本没动」的两种成因必须分清，因为它们要用户做的事**相反** ──
//
// ⚠️ 这条链路分两段，测试必须两段都盖到：
//    ① pnpm **非零退出**、输出里就带着 release-age 的原话（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
//       / `too new`）—— 这一段走 pnpm 失败分支，靠 `tail` 把尾部原文带出去；
//    ② pnpm 报**退出码 0** 但被策略挡下、磁盘一字未改 —— 这一段靠回读发现，走 `blockedByPolicy`，
//       `staleReason` 由 `r.out` 里的关键短语判定，引导文案也在这里分派。
//    （原先只按「白名单没放行」一档处理，会把「太新」的用户劝去改一个没用的 yaml 键。）
test('marketUpdate：pnpm 非零退出且报「太新」时，尾部原文与可重试标记都要带出去', async () => {
  const saved = dshMod.installPluginPkg
  dshMod.installPluginPkg = () => Promise.resolve({
    code: 1,
    ok: false,
    out: 'Progress: resolved 1, reused 0\n[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] dshmarket@1.57.0 is too new; published 3 hours ago',
    err: '',
  })
  try {
    const r = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' })
    assert.equal(r.ok, false)
    // 关键报错在尾部，tail 必须把它带出来 —— 否则用户只能去日志里自己翻
    assert.match(String(r.tail), /too new/, '尾部原文要带上真正的失败原因')
    assert.equal(r.retryable, true, '普通 pnpm 失败多为网络/锁文件，原样重试有意义')
  } finally {
    dshMod.installPluginPkg = saved
  }
})

test('staleReason：输出说「太新」时判 release-age，文案劝等满期（不是劝改白名单）', async () => {
  const saved = dshMod.installPluginPkg
  // 退出码 0 + 输出里带「太新」= pnpm 被观察期挡下却报成功，版本回读必然没变
  dshMod.installPluginPkg = () => Promise.resolve({
    code: 0,
    ok: true,
    out: '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] dshmarket@1.57.0 is too new; it was published 3 hours ago, newer than the minimum release age of 1 days\nDone in 1.4s',
    err: '',
  })
  try {
    const r = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' })
    assert.equal(r.ok, false)
    assert.equal(r.blocked, true, '版本没变就是被挡')
    assert.equal(r.staleReason, 'release-age', '写死成白名单就劝错了方向')
    assert.equal(r.retryable, true, '太新是等时间能解决的，重试有意义')
    assert.match(String(r.error), /满期/, '要引导「等它满期」')
    assert.match(String(r.error), /不必改配置/, '必须明确说「不用改配置」，否则用户还是会去翻 yaml')
  } finally {
    dshMod.installPluginPkg = saved
  }
})

test('staleReason：输出只说白名单键名时判 allowlist，且给出可照抄的行', async () => {
  const saved = dshMod.installPluginPkg
  dshMod.installPluginPkg = () => Promise.resolve({
    code: 0,
    ok: true,
    out: 'dshmarket@1.57.0 needs to be added to minimumReleaseAgeExclude\n✓ Lockfile passes supply-chain policies\nDone in 1.4s',
    err: '',
  })
  try {
    const r = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' })
    assert.equal(r.ok, false)
    assert.equal(r.staleReason, 'allowlist')
    assert.equal(r.policyKey, 'minimumReleaseAgeExclude', '白名单路径要指向白名单键，不是观察期键')
    assert.match(String(r.error), /- dshmarket@1\.57\.0/, '白名单路径必须给出可照抄的行')
    assert.doesNotMatch(String(r.error), /不必改配置/, '白名单路径不能劝人「别改配置」')
  } finally {
    dshMod.installPluginPkg = saved
  }
})

// ── 判据优先级：太新 vs 白名单，必须**先看太新** ──
//
// ⚠️ pnpm 报「太新」时会**顺带**把白名单键名也打出来（「如要放行可改 minimumReleaseAgeExclude」），
//    所以两边的正则都能命中。若先判 keyHint 就永远归到 allowlist，等于把这道区分整个作废。
test('staleReason：输出里「太新」与白名单键名同时出现时，以「太新」为准', async () => {
  const saved = dshMod.installPluginPkg
  dshMod.installPluginPkg = () => Promise.resolve({
    code: 0,
    ok: true,
    out: 'dshmarket@1.57.0 is too new (published 2 hours ago). To allow it, add it to minimumReleaseAgeExclude in pnpm-workspace.yaml\nDone in 1.4s',
    err: '',
  })
  try {
    const r = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' })
    assert.equal(r.staleReason, 'release-age', '两个线索都在时要先认「太新」')
    assert.equal(r.policyKey, 'minimumReleaseAge', '太新时该指向观察期键')
  } finally {
    dshMod.installPluginPkg = saved
  }
})

test('tailLines：只留尾部若干行，并标出省略了多少（pnpm 关键报错在尾部）', () => {
  const text = Array.from({ length: 50 }, (_, i) => 'line' + (i + 1)).join('\n')
  const out = settings.tailLines(text, 5)
  assert.match(out, /line50$/, '最后一行必须在')
  assert.match(out, /line46/, '尾部 5 行都要在')
  assert.doesNotMatch(out, /line45/, '超出上限的要被截掉')
  assert.match(out, /省略前面 45 行/, '要标明省略了多少，否则用户以为这就是全部输出')
})

test('tailLines：行数不超上限时原样返回（不加省略标记，免得干扰阅读）', () => {
  const out = settings.tailLines('a\nb\nc', 10)
  assert.equal(out, 'a\nb\nc')
  assert.doesNotMatch(out, /省略/)
})

test('tailLines：空输入返回空串（不能拼出「省略前面 NaN 行」这种脏文案）', () => {
  assert.equal(settings.tailLines('', 10), '')
  assert.equal(settings.tailLines(null, 10), '')
})

// ── 快照还原：写文件失败必须回滚，不能留下半还原状态 ──
//
// ⚠️ dsh 的 profile 里 package.json 与 cordis.patch.yml 必须**同时**回到同一时刻，
//    只回了一半会让 dsh 处于既不是新态也不是旧态的夹缝（V2 的教训：这种夹缝 dsh 不报错，
//    只会静默行为怪异）。原实现写一半失败就 return，等于把用户丢在这个夹缝里。
test('restoreSnapshot：主写失败时逆序回滚，磁盘保持还原前的样子（不留半还原）', () => {
  const backup = require('../public/preload/lib/dsh-backup.js')
  // 夹具里 settings.yaml 已被 pod 的 profile 建过；先写一个「已知良好」内容并建快照
  const f1 = path.join(DSH_HOME, 'settings.yaml')
  fs.writeFileSync(f1, 'known-good: 1\n')
  const snap = backup.createSnapshot({ profile: PROFILE, reason: 'manual-rollback-fixture' })
  assert.equal(snap.ok, true, '夹具快照要建成功')
  // 快照建好之后，把磁盘上的内容改成「新态」—— 还原会把主写指向快照里的旧内容
  fs.writeFileSync(f1, 'modified: 2\n')

  const origWrite = fs.writeFileSync
  fs.writeFileSync = (p, ...rest) => {
    // 只打断主写（内容来自快照），放行回滚写（内容来自 prev 底稿）
    if (String(p).endsWith('settings.yaml') && String(rest[0]).includes('known-good')) {
      const e = new Error('ENOSPC: no space left on device')
      throw e
    }
    return origWrite(p, ...rest)
  }
  let r
  try {
    r = backup.restoreSnapshot({ dirName: snap.dirName })
  } finally {
    fs.writeFileSync = origWrite
  }
  assert.equal(r.ok, false, '写不进去就是失败')
  assert.match(String(r.error), /已回滚/, '失败文案要告诉用户已经回滚过了')
  assert.equal(fs.readFileSync(f1, 'utf8'), 'modified: 2\n', '磁盘要停在还原前，不能是半截状态')
  assert.deepEqual(r.written, [], '半还原不存在，written 必须为空')
})

// ── 快照列表要能自己认出「这份已经还原不了了」 ──
//
// ⚠️ 快照目录被磁盘清理、或被手动动过是真会发生的。原实现把 intact 硬编码成 true，
//    于是坏掉的快照照样列出来、照样「还原」可点 —— 用户点下去才报错，那一次点击是白点的。
//    列表阶段就做与 restore 同口径的 sha256 校验，把结论前置到用户点之前。
test('listSnapshots：快照文件被外部改过时 intact=false，不能被当成可还原', () => {
  const backup = require('../public/preload/lib/dsh-backup.js')
  const f1 = path.join(DSH_HOME, 'settings.yaml')
  fs.writeFileSync(f1, 'intact-check: 1\n')
  const snap = backup.createSnapshot({ profile: PROFILE, reason: 'manual-intact-fixture' })
  assert.equal(snap.ok, true)

  // 先确认完好的一份是 intact 的（否则下面的反例证明不了任何事）
  const good = backup.listSnapshots().find((s) => s.dirName === snap.dirName)
  assert.equal(good.intact, true, '刚建好的快照必须判为完好')
  assert.equal(good.damaged, false)

  // 把快照目录里的那份文件改掉 —— 模拟磁盘层面的损坏
  const flat = 'settings.yaml'
  fs.writeFileSync(path.join(backup.backupRoot(), snap.dirName, flat), 'tampered: 9\n')

  const bad = backup.listSnapshots().find((s) => s.dirName === snap.dirName)
  assert.equal(bad.intact, false, '校验值不符必须判为损坏')
  assert.equal(bad.damaged, true, '界面靠 damaged 置灰「还原」按钮')
})

// ── 用户报的第二个 bug：白名单行给出的是**字面量**「目标版本」，照抄等于没抄 ──
//
// ⚠️ 2026-09-24 真机原话：「如需放行，请把目标版本加进 …/pnpm-workspace.yaml 的
//    minimumReleaseAgeExclude（例如 `@linxin666/dsh-web-all@目标版本`）」。
//    根因是前端链条**没把目录版本传下去**：dryRun 不传 → 宿主 o.version 恒空。
//    修法：dryRun 把目录版本按 `to` 回传，前端存进 plan，真写时带回。
//
// ⚠️ 另一处是判据本身误导：`✓ Lockfile passes supply-chain policies` 是 pnpm 每次都打的
//    **常规信息行**，不是拦截证据。用户那个包（@linxin666/dsh-web-all）白名单里明明有、
//    只放行到 0.3.23，却被判「去改白名单」—— 该改的其实是「把新版本加进去」，不是「它不在白名单」。
test('marketUpdate：dryRun 回传目录版本，被挡文案里给出可照抄的白名单行（回归：不能是字面量「目标版本」）', async () => {
  const saved = dshMod.installPluginPkg
  dshMod.installPluginPkg = () => Promise.resolve({ code: 0, ok: true, out: '✓ Lockfile passes supply-chain policies\nDone in 1.4s', err: '' })
  try {
    // 第一步：dryRun 必须把目录给的版本原样吐回来，前端才有东西可存
    const dry = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0', dryRun: true })
    assert.equal(dry.ok, true)
    assert.equal(dry.changed, true)
    assert.equal(dry.to, '1.57.0', 'dryRun 要把目录版本回传，否则前端只能显示「目标版本」')

    // 第二步：真写被挡，文案里必须能直接照抄出「- dshmarket@1.57.0」
    const r = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' })
    assert.equal(r.blocked, true)
    assert.match(String(r.error), /- dshmarket@1\.57\.0/, '要给出可照抄的白名单行')
    assert.doesNotMatch(String(r.error), /@目标版本/, '不能出现字面量「目标版本」——用户照抄不了')
  } finally {
    dshMod.installPluginPkg = saved
  }
})

// ── 与「没变」相反方向的静默失败：版本**变了**，但变得更低 ──
//
// ⚠️ `blockedByPolicy` 只能抓「pnpm 报成功、版本纹丝不动」。真实存在的另一种更坏的失败是
//    版本确实动了、却**往回走**（镜像滞后 / registry 把 `@latest` 解析成旧版 / 目录给的 spec
//    指向回退的 tag）。若按「版本变了 = 成功」判，用户会看到「已更新 v1.48.0 → v1.40.0」，
//    而且磁盘上已经躺着旧版了。方向判反等于把降级当成功播报，故单列纯函数钉住。
test('downgradedBy：真升级 / 版本不变都不算降级（不能把正常结果也误判成降级）', () => {
  assert.equal(settings.downgradedBy('1.48.0', '1.57.0'), false, '升版本不是降级')
  assert.equal(settings.downgradedBy('1.48.0', '1.48.0'), false, '版本没动由 blocked 管，不算降级')
})

test('downgradedBy：回读到更低的版本判为降级', () => {
  assert.equal(settings.downgradedBy('1.48.0', '1.40.0'), true, '主版本内回退也要抓到')
  assert.equal(settings.downgradedBy('2.0.0', '1.99.0'), true, '跨大版本回退同样算降级')
})

test('downgradedBy：任一侧拿不到可解析的版本号时不判降级（无从比较就不能猜）', () => {
  assert.equal(settings.downgradedBy('', '1.40.0'), false)
  assert.equal(settings.downgradedBy('1.48.0', ''), false)
  assert.equal(settings.downgradedBy('^1.2.0', '1.40.0'), false, 'range 不是实装版本，不该参与比较')
  assert.equal(settings.downgradedBy(null, undefined), false)
})

test('marketUpdate：pnpm 报成功但回读版本更低，必须判失败并引导回滚（回归：不能播报「已更新」）', async () => {
  const saved = dshMod.installPluginPkg
  const pkgFile = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dshmarket', 'package.json')
  dshMod.installPluginPkg = () => {
    // 模拟镜像滞后：pnpm 一路报成功，但装上去的是**旧**版本
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'dshmarket', version: '1.40.0' }))
    return Promise.resolve({ code: 0, ok: true, out: 'Done in 1.4s', err: '' })
  }
  try {
    const r = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' })
    assert.equal(r.ok, false, '版本从 1.48.0 掉到 1.40.0 是降级，不能报成功')
    assert.equal(r.downgraded, true)
    assert.equal(r.from, '1.48.0')
    assert.equal(r.version, '1.40.0')
    assert.match(String(r.error), /滚/, '要引导用户回滚，而不是笼统的「写入失败」')
  } finally {
    dshMod.installPluginPkg = saved
    // 还原夹具，避免污染后面的用例
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'dshmarket', version: '1.48.0' }))
  }
})

// ── 宿主不兼容：默认拦在写入前，但用户明确要求时允许「强制安装」──
//
// ⚠️ 盯的是一条 2026-09-25 用户报的真实拦截：「确证与当前 DSH 不兼容：该插件要求 DSH
//    ^0.1.7-rc.1，而当前宿主是 0.1.7-alpha.2。装上也无法加载，已拦在写入前。」
//    用户的选择是：**拦是要拦的，但得给一条出路**（装之前先说明后果、自动建快照、事后提醒复核）。
//
// ⚠️ 这条链路最容易漏的是「真写那一遍」。dryRun 与真写是宿主上的两次**独立调用**
//    （界面先 dryRun 拿单据、用户点头后再调一次真写）。若真写不读 force，用户点了
//    「仍要强制安装」、看了警告、按了确认，照样被拦在写入前 —— 比一开始就不给按钮更糟。
//    所以这里 force 与不 force 两条路、dryRun 与真写两段都要盖到。
//
// ⚠️ 打桩说明：宿主版本的**真接缝**是 settings.js 里的 `diagnostics.readEnv().dshVersion`
//    （见 lib/settings.js 的 hostDshVersion），而 diagnostics.readEnv 内部调的是**它自己
//    顶层解构出来的** `snapshot`（`const { probePort, snapshot } = require('./dsh')`）。
//    所以「替换 dshMod.snapshot」根本透不进去 —— 解构早已把原函数钉死在 diagnostics 的闭包里，
//    重指 dsh.js 导出的 snapshot 对它无效。
//    这在本地能侥幸通过：本地真跑 dsh.snapshot() 读得到版本 → host 非空 → 兼容性检查照跑、
//    再用 lookup 桩判 incompatible。可 CI 上临时目录里没有 dsh，snapshot().resolved 为空 →
//    hostDshVersion() 返回 '' → enforceHostCompat 见 !host 直接提前返回 unknown，永不拦，
//    6 个断言全垮（2026-09-25 CI 首次暴露）。故这里直接替换 diagnostics.readEnv。
//    兼容性结论走 dshHostCompat.lookup（联网拉 manifest），替换它让 dshmarket 声明
//    `^0.1.7-rc.1` —— 而 0.1.7-alpha.2 < 0.1.7-rc.1（alpha < rc），故必判 incompatible。
//    这两处都是**模块级**替换，必须 finally 还原。
const diagnosticsMod = require('../public/preload/lib/diagnostics.js')
const dshHostCompatMod = require('../public/preload/lib/dsh-host-compat.js')

// 一次「声明要求 ^0.1.7-rc.1」的 lookup 桩：facts 结构照 deriveHostCompatibility 的入参造
const INCOMPAT_FACTS = { engine: '', peers: [{ name: '@deepseek-ai/dsh', range: '^0.1.7-rc.1' }] }

function withIncompatibleHost(fn) {
  const savedReadEnv = diagnosticsMod.readEnv
  const savedLookup = dshHostCompatMod.lookup
  diagnosticsMod.readEnv = () => ({ home: '', nodeVersion: '', dshVersion: '0.1.7-alpha.2', dshSource: '', profile: 'web', installed: true })
  dshHostCompatMod.lookup = () => Promise.resolve({ ok: true, facts: { dshmarket: INCOMPAT_FACTS } })
  // ⚠️ 必须等 Promise **落地**后再还原（2026-09-25 修）：早先这里在 finally 里同步还原，
  //    而调用方是 async —— fn() 一返回 Promise，finally 就立刻把桩换回真实现，于是
  //    「dryRun 一遍带桩、后一遍真写不带桩」。现象是同一个测试里 dry 判 incompatible、
  //    真写却判 compatible（拉到了 registry 上的真 manifest），force 结论随之丢失。
  try {
    return Promise.resolve(fn()).finally(() => {
      diagnosticsMod.readEnv = savedReadEnv
      dshHostCompatMod.lookup = savedLookup
    })
  } catch (err) {
    diagnosticsMod.readEnv = savedReadEnv
    dshHostCompatMod.lookup = savedLookup
    throw err
  }
}

test('marketInstall dryRun：宿主不兼容 → 拦在写入前（ok:false + hostIncompatible + retryable:false）', async () => {
  await withIncompatibleHost(async () => {
    const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0', dryRun: true })
    assert.equal(r.ok, false, '确证不兼容时不能放行')
    assert.equal(r.hostIncompatible, true, '要带这条 flag，前端才长得出「强制安装」按钮')
    assert.equal(r.retryable, false, '原样重试必然再失败，不能标可重试')
    // 文案要把「要求什么」「当前是什么」都说清 —— 用户得知道该升到哪一版
    assert.match(String(r.error), /\^0\.1\.7-rc\.1/)
    assert.match(String(r.error), /0\.1\.7-alpha\.2/)
    assert.match(String(r.error), /已拦在写入前/)
  })
})

test('marketInstall dryRun：带 force → 放行（ok:true），但「不兼容」这个结论照样回传', async () => {
  await withIncompatibleHost(async () => {
    const r = await settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0', dryRun: true, force: true })
    assert.equal(r.ok, true, 'force 就是用户的明确放行')
    assert.equal(r.changed, true)
    // ⚠️ 关键：force 只把 blocked 压成 false，结论本身没变 —— 界面全靠这两个 flag 把
    //    普普通通的确认单切成「你正在强行装一个宿主不兼容的插件」
    assert.equal(r.hostIncompatible, true, '强装不等于兼容，结论必须照样带回')
    assert.equal(r.hostForced, true, '要能区分「宿主拦下了」与「拦了但被用户放行」')
    assert.match(String(r.message), /已忽略宿主兼容性检查/, '单据上必须写明这是强装')
    assert.match(String(r.message), /\^0\.1\.7-rc\.1/, '强装警告里要带上要求的范围')
  })
})

test('marketInstall：force 下真写不被拦（回归：只给 dryRun 带 force 会让确认后照样失败）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-force-install-'))
  const profDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(profDir, 'node_modules', 'dshmarket'), { recursive: true })
  fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { dshmarket: '^1.48.0' } }))
  fs.writeFileSync(path.join(profDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.48.0' }))
  const savedHome = process.env.DSH_HOME
  const savedInstall = dshMod.installPluginPkg
  const savedGlobal = dshMod.globalDsh
  process.env.DSH_HOME = home
  dshMod.globalDsh = () => null
  dshMod.installPluginPkg = () => {
    // 模拟 pnpm 真把包装上了：node_modules 的实装版本随之变化（真写要能回读到）
    fs.writeFileSync(path.join(profDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.57.0' }))
    return Promise.resolve({ code: 0, ok: true, out: 'ok', err: '' })
  }
  let r
  try {
    r = await withIncompatibleHost(() => settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0', force: true }))
  } finally {
    dshMod.installPluginPkg = savedInstall
    dshMod.globalDsh = savedGlobal
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(home, { recursive: true, force: true })
  }
  assert.equal(r.ok, true, 'force 必须在真写那一遍也生效：' + JSON.stringify(r.error || ''))
  assert.equal(r.version, '1.57.0')
  assert.equal(r.snapshot ? true : false, true, '强装同样要有快照可回滚')
  assert.equal(r.hostIncompatible, true, '真写的结果卡也要知道这是强装 —— 事后复核全指望它')
  assert.equal(r.hostForced, true)
})

test('marketInstall：不带 force 时真写仍被拦（force 是放行开关，不是无差别放行）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-noforce-install-'))
  const profDir = path.join(home, 'profiles', PROFILE)
  fs.mkdirSync(path.join(profDir, 'node_modules', 'dshmarket'), { recursive: true })
  fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { dshmarket: '^1.48.0' } }))
  fs.writeFileSync(path.join(profDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.48.0' }))
  const savedHome = process.env.DSH_HOME
  const savedInstall = dshMod.installPluginPkg
  let called = false
  process.env.DSH_HOME = home
  dshMod.installPluginPkg = () => { called = true; return Promise.resolve({ code: 0, ok: true, out: 'ok', err: '' }) }
  let r
  try {
    r = await withIncompatibleHost(() => settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' }))
  } finally {
    dshMod.installPluginPkg = savedInstall
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(home, { recursive: true, force: true })
  }
  assert.equal(r.ok, false)
  assert.equal(r.hostIncompatible, true)
  assert.equal(called, false, '被拦时连 pnpm 都不该起 —— 「拦在写入前」的字面意思')
})

test('marketUpdate：dryRun 带 force 放行且回传两 flag；真写带 force 不拦', async () => {
  const savedInstall = dshMod.installPluginPkg
  const pkgFile = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'dshmarket', 'package.json')
  dshMod.installPluginPkg = () => {
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'dshmarket', version: '1.57.0' }))
    return Promise.resolve({ code: 0, ok: true, out: 'Done in 1.4s', err: '' })
  }
  let dry
  let real
  try {
    await withIncompatibleHost(async () => {
      dry = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0', dryRun: true, force: true })
      real = await settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0', force: true })
    })
  } finally {
    dshMod.installPluginPkg = savedInstall
    // 还原夹具，避免污染后面的用例
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'dshmarket', version: '1.48.0' }))
  }
  assert.equal(dry.ok, true, 'force 下 dryRun 要放行')
  assert.equal(dry.hostIncompatible, true)
  assert.equal(dry.hostForced, true)
  assert.match(String(dry.message), /已忽略宿主兼容性检查/)
  assert.equal(real.ok, true, '真写那一遍也要认 force，否则「更新」的强装按钮等于没接上')
  assert.equal(real.from, '1.48.0')
  assert.equal(real.version, '1.57.0')
  assert.equal(real.hostForced, true)
})

test('marketUpdate：不带 force 时真写被拦在写入前（与安装同一口径）', async () => {
  const savedInstall = dshMod.installPluginPkg
  let called = false
  dshMod.installPluginPkg = () => { called = true; return Promise.resolve({ code: 0, ok: true, out: 'ok', err: '' }) }
  let r
  try {
    r = await withIncompatibleHost(() => settings.dshMarketUpdate({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.57.0' }))
  } finally {
    dshMod.installPluginPkg = savedInstall
  }
  assert.equal(r.ok, false)
  assert.equal(r.hostIncompatible, true)
  assert.equal(r.action, 'update')
  assert.equal(called, false, '被拦时不该起 pnpm')
})

