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

test('marketInstall dryRun：已装但落后于目录 → changed:true，放行走更新（回归：不能拦成「无需重复安装」）', () => {
  const r = settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: FAKE_VERSION, dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.changed, true, '声明范围 ^1.48.0 容得下 1.49.0，但实装只有 1.48.0 —— 磁盘会变，changed 必须是 true')
  assert.equal(r.action, 'install')
  // 文案要说清「从哪版 → 到哪版」：用户看到的是范围原文时并不知道自己装的是哪版
  assert.match(r.message, /1\.49\.0/)
  assert.match(r.message, /已装 1\.48\.0/)
})

test('marketInstall dryRun：实装版本已等于目录版本 → changed:false（重装无意义）', () => {
  const r = settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.48.0', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.equal(r.action, 'already')
  assert.match(r.message, /已是目录里的最新版/)
})

test('marketInstall dryRun：目录版本反而更低时不报「更新到旧版」', () => {
  const r = settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', version: '1.47.0', dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false, '实装 1.48.0 比目录的 1.47.0 新，不能让人装回旧版')
})

test('marketInstall dryRun：目录没给 version → 不猜，维持「已装」结论', () => {
  const r = settings.dshMarketInstall({ profile: PROFILE, spec: 'dshmarket', npm: 'dshmarket', name: 'dshmarket', dryRun: true })
  assert.equal(r.changed, false)
  assert.equal(r.action, 'already')
})

test('marketInstall dryRun：没装过的包仍是 install，且不受新逻辑影响', () => {
  const r = settings.dshMarketInstall({ profile: PROFILE, spec: 'definitely-not-installed-xyz', name: 'x', version: '9.9.9', dryRun: true })
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
