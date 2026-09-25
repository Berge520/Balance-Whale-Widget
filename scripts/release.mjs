/*
 * 一键发版脚本
 *
 * 用法：
 *   npm run release                 # 发 package.json 里当前 version
 *   npm run release -- 1.7.0        # 先把版本号写成 1.7.0，再发
 *   npm run release -- 1.7.0 --dry-run   # 只跑前置检查与四关，不提交不推送
 *
 * 做的事（严格按顺序，任一步失败即中止、不留下半成品）：
 *   1. 前置检查：版本号递增、工作区干净、README 有该版本章节、tag 未占用、gh 已登录
 *   2. 写版本号到 package.json → sync-version 同步到 plugin.json 与 lib/constants.js
 *   3. 跑四关：lint → typecheck → test → build（与 ci.yml / release.yml 完全同一套命令）
 *   4. 用 README「### <版本>」章节当正文，建 release commit
 *   5. push main → 等 CI 绿 → 打附注 tag → push tag
 *   6. 等 Release 工作流绿 → 核对 Release 与 zip 资产（版本号 + 关键文件在位）
 *
 * 为什么这些步骤不交给 CI 而留在本地：版本号单一来源是 package.json 的 version，
 * 而 tag 是「这一版确实要发」的显式动作；本地先跑同一套四关，能保证「本地能过 = CI 能过」
 * （ci.yml 的注释也是这个口径）。README 章节进 commit body 是为了让 git log 与
 * 对外的版本记录口径一致，不用两处各写一遍。
 *
 * 边界：uTools 市场的 .upx 仍需人工在开发者工具里打包上传，脚本只到 GitHub Release 为止。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const versionArg = process.argv.slice(2).find((a) => !a.startsWith('--'))

// ── 小工具 ──
// Windows 下 gh / git / npm 是 .cmd 或 .exe，直接 spawn 不带 shell 会 ENOENT，
// 所以命令拼成整条字符串交给系统 shell —— 注意此时不能再给 shell 传参数数组
// （Node 24 起会报 DEP0190），参数已经在字符串里拼好了。
function run(cmd, args, opts = {}) {
  const line = [cmd, ...args].join(' ')
  const { echo = true, ...spawnOpts } = opts
  if (echo) console.log(`  $ ${line}`)
  const r = spawnSync(line, { cwd: root, stdio: 'inherit', shell: true, ...spawnOpts })
  if (r.status !== 0) throw new Error(`命令失败（exit ${r.status}）：${line}`)
}

// 要拿 stdout 的场景，失败即抛错，调用方自己决定要不要容忍
function capture(cmd, args, { allowFail = false } = {}) {
  const line = [cmd, ...args].join(' ')
  const r = spawnSync(line, { cwd: root, encoding: 'utf8', shell: true })
  if (r.status !== 0 && !allowFail) {
    throw new Error(`命令失败（exit ${r.status}）：${line}\n${r.stderr || ''}`)
  }
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// 单纯等一会儿。用同步 sleep 而不是 node -e 起子进程：少一次进程开销，
// 也不受 shell 引号转义的影响。
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function fail(msg) {
  // 注意：这里不能直接 process.exit —— process.exit 不会执行外层的 finally，
  // 临时消息文件就留在 .git 里了（实测确认过）。抛错让 main 的 finally 正常收尾。
  throw new ReleaseError(msg)
}

class ReleaseError extends Error {}

function step(title) {
  console.log(`\n[release] ── ${title} ──`)
}

const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'))
const pkgPath = path.join(root, 'package.json')
// 临时消息文件统一放这里，连同 finally 清理，避免失败中断时留下垃圾
const tmpDir = path.join(root, '.git', 'whale-release-tmp')

// ── 版本号比较（只认 x.y.z，够用了） ──
function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? [+m[1], +m[2], +m[3]] : null
}
function gt(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

// ── 1. 前置检查 ──
// 整个流程包在 try 里，只为 finally 清掉中间写出的临时消息文件：
// 这里的每一步都可能 fail() 中断，散落的清理语句会被跳过。
function main() {
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // 清理失败无所谓（.git 下不影响仓库内容），不能让收尾把真正的错误盖掉
  }
}

// --dry-run 时用于还原版本号；在 try 外声明，finally 里才可见（否则作用域对不上）
const versionBackup = new Map()

try {
step('前置检查')

const curVersion = readJson('package.json').version
let nextVersion = versionArg || curVersion

const vNext = parseVer(nextVersion)
if (!vNext) fail(`版本号格式不对：${nextVersion}（要求 x.y.z）`)

const vCur = parseVer(curVersion)
// 相等要放行：--dry-run 会真的把 version 写进 package.json，之后正式发同一个版本号时
// 「next == cur」是预期状态。只有「next < cur」（想发一个更旧的版本）才是错误。
if (versionArg && vCur && gt(vCur, vNext)) {
  fail(`新版本 ${nextVersion} 小于当前 ${curVersion}，不能往回发`)
}

// 工作区必须干净：发版 commit 只应包含版本号与文档改动，混进别的改动会让「这一版发了什么」说不清
const dirty = capture('git', ['status', '--porcelain']).out
if (dirty) {
  // 允许已改好的源码 / 文档进 commit，但必须让人看见自己将要提交什么
  console.log('  工作区有未提交改动，将一并进入本次 release commit：')
  console.log(dirty.split('\n').map((l) => `    ${l}`).join('\n'))
}

// README 必须有对应章节：它同时是 commit body 的来源，缺了会让 commit 空正文
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
const sectionRe = new RegExp(`^### ${nextVersion.replace(/\./g, '\\.')}\\s*$`, 'm')
if (!sectionRe.test(readme)) {
  fail(`README.md 里找不到「### ${nextVersion}」章节；先补上版本记录再发（它会被当作 commit 正文）`)
}

// tag 不能已存在（本地或远端）
if (capture('git', ['tag', '-l', `v${nextVersion}`]).out) {
  fail(`本地已存在 tag v${nextVersion}`)
}
// 远端那次查询要联网：网络不通 ≠ tag 存在。区分开，否则一次网络抖动就会被
// 报成「tag 被占用」，让人去删一个根本不存在的 tag。
const remoteTag = capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${nextVersion}`], { allowFail: true })
if (remoteTag.status !== 0) {
  if (/unable to access|Could not resolve|Connection|timed out/i.test(remoteTag.err)) {
    fail(`查不到远端 tag（网络不通）：\n${remoteTag.err}\n请确认能访问 github.com 后重试`)
  }
  fail(`查询远端 tag 失败：\n${remoteTag.err}`)
}
if (remoteTag.out) fail(`远端已存在 tag v${nextVersion}`)

// gh 未登录 / 未安装时，后面等 CI 与核对 Release 都会失败，提前问清楚
capture('gh', ['auth', 'status'])

// 当前分支必须是 main：release.yml 校验 tag 与 package.json，但 CI 只跑 main
const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out
if (branch !== 'main') fail(`当前分支是 ${branch}，发版请在 main 上进行`)

console.log(`  ✓ ${curVersion} → ${nextVersion}，README 章节 / tag 占用 / gh 登录 / 分支 均通过`)

if (dryRun) {
  console.log('\n[release] --dry-run：前置检查通过，继续跑四关（不提交、不推送）\n')
}

// ── 2. 写版本号 ──
step(`写版本号 ${nextVersion}`)
// 三处版本号都要能原样恢复：--dry-run 承诺「只检查不提交」，若真的留下改动，
// 用户以为什么都没发生、实际工作区已经脏了（且 package-lock 不含在内会更不一致）。
// 所以先把原始内容存下来，四关跑完（无论成败）在 finally 里还原。
const versionFiles = ['package.json', 'package-lock.json', 'public/plugin.json', 'public/preload/lib/constants.js']
if (dryRun) {
  for (const rel of versionFiles) {
    try { versionBackup.set(rel, readFileSync(path.join(root, rel), 'utf8')) } catch (e) {
      // 文件可能不存在（如某些检出方式下的 package-lock），记 null 表示「本来就没有」，还原时删掉即可
      versionBackup.set(rel, null)
    }
  }
}
const pkgRaw = readFileSync(pkgPath, 'utf8')
// 锚定行首两个空格的顶层字段：不加锚点会改到「第一个出现的 version 键」，
// 万一将来 package.json 里先出现别的（如某个嵌套配置的 version）就会改错地方。
const pkgNext = pkgRaw.replace(/^( {2}"version": ")([^"]*)(")/m, `$1${nextVersion}$3`)
if (pkgNext === pkgRaw && curVersion !== nextVersion) {
  fail('package.json 里没找到可替换的 version 字段')
}
writeFileSync(pkgPath, pkgNext, 'utf8')
run('node', ['scripts/sync-version.mjs'])

// ── 3. 四关 ──
step('静态检查 / 类型检查 / 单测 / 构建')
for (const s of ['lint', 'typecheck', 'test', 'build']) {
  console.log(`\n  ▶ npm run ${s}`)
  run('npm', ['run', s])
}
console.log('\n  ✓ 四关全绿')

if (dryRun) {
  console.log('\n[release] --dry-run 结束：以上改动（package.json / plugin.json / constants.js）未提交，请自行决定是否保留\n')
  // 用 return 而不是 process.exit：process.exit 会跳过 finally（同 fail() 那条注释）。
  // 此刻临时目录虽然还没建，但依赖「它恰好没建」太脆，统一走正常收尾。
  return
}

// ── 4. 建 release commit（正文取自 README 章节） ──
step(`建 release commit`)

// 抽出「### <版本>」到下一个「##」或「###」之前的内容，剥掉「**小标题**」这类 markdown 强调。
// 必须先把 CRLF 归一成 LF：README 在 Windows 上是 CRLF，每行末尾的 \r 会被原样写进
// commit / tag 消息（git 存进对象时只保留 \n，于是回读比对永远对不上，正文里也会多出
// 看不见的回车）。归一后正文在两种行尾的仓库里都一致。
const bodyStart = readme.search(sectionRe)
const afterHead = readme.slice(bodyStart).indexOf('\n') + bodyStart + 1
const rest = readme.slice(afterHead)
const nextHead = rest.search(/^#{2,3} /m)
const rawBody = (nextHead >= 0 ? rest.slice(0, nextHead) : rest)
  .replace(/\r\n?/g, '\n')
  .trim()
const body = rawBody.replace(/\*\*/g, '').replace(/^-\s*/gm, '- ')

// 标题取「### <版本>」章节里第一行「**XXX**」小标题，没有就用版本号
const firstLabel = /\*\*(.+?)\*\*/.exec(rawBody)
const title = `chore: 发布 v${nextVersion} - ${firstLabel ? firstLabel[1] : '版本发布'}`

const msgPath = path.join(tmpDir, `COMMIT_MSG_V${nextVersion.replace(/\./g, '')}.txt`)
mkdirSync(tmpDir, { recursive: true })
writeFileSync(msgPath, `${title}\n\n${body}\n`, 'utf8')

run('git', ['add', '-A'])
// 版本号 / 文档若已提前手工提交（前置检查允许 next == cur），这里就没有可提交的内容。
// 无条件 commit 会以「nothing to commit」退出 1，把一次本可正常发版的流程打断 ——
// 前置检查放行、执行却挂，属于脚本自身的不一致。故先看暂存区是否真有内容。
const staged = capture('git', ['diff', '--cached', '--name-only']).out
if (staged) {
  run('git', ['commit', '-F', path.relative(root, msgPath)])
} else {
  console.log('  （版本号与文档已在历史提交中，无需 release commit，跳过）')
}

// ── 5. push main → 等 CI → tag ──
step('推送 main 并等 CI')
// 同上：release commit 被跳过时，main 可能已经在远端（本地无新提交）。
// git push 在「Everything up-to-date」时本身退出 0，但仍要先确认本地不落后，
// 否则会在旧 head 上打 tag，Release 的校验会莫名其妙地挂。
const ahead = capture('git', ['rev-list', '--count', 'origin/main..HEAD']).out
if (ahead !== '0') run('git', ['push', 'origin', 'main'])
else console.log('  （main 已与 origin/main 同步，跳过 push）')

const headSha = capture('git', ['rev-parse', 'HEAD']).out
console.log(`\n  等待 CI（head=${headSha.slice(0, 7)}）…`)

// CI 是 push 触发的异步工作流：先等它出现，再等它结束
const ciRun = waitForRun({ headSha, workflow: 'CI', initialDelayMs: 8000 })
console.log(`  CI run ${ciRun} 已就绪，等待结果…`)
run('gh', ['run', 'watch', ciRun, '--exit-status', '--interval', '15'])
console.log('  ✓ CI 全绿')

step(`打附注 tag v${nextVersion}`)
// 正文含换行，不能拼进命令行：system shell（Windows 上是 cmd）拿到含换行的
// 整条命令时只取第一行执行，后半段会被当成新命令 —— 实测只会得到
// 「v1.7.0」这一行的 tag 消息，多行正文静默丢失。改用 -F 从文件读。
const tagMsgPath = path.join(tmpDir, `TAG_MSG_V${nextVersion.replace(/\./g, '')}.txt`)
writeFileSync(tagMsgPath, `v${nextVersion}\n\n${body}\n`, 'utf8')
run('git', ['tag', '-a', `v${nextVersion}`, '-F', path.relative(root, tagMsgPath)])
// 回读校验：正文丢失是静默的（tag 照样建成功），只能建完再看一眼。
// 必须比**整段正文**而不是首行：脚本注释里记录过的事故形态正是「第一行在、多行正文丢」——
// 只比 body.split('\n')[0] 时这种事故照样通过，校验形同虚设。
// git cat-file 的原始对象里，头部与正文之间是空行；正文里的换行原样保留。
const tagMsg = capture('git', ['cat-file', 'tag', `v${nextVersion}`], { allowFail: true })
const tagBody = tagMsg.out.includes('\n\n') ? tagMsg.out.slice(tagMsg.out.indexOf('\n\n') + 2) : ''
// 归一化行尾再比：body 已在上面归一成 LF，但 cat-file 输出在 Windows 上可能带 CRLF
const normEol = (s) => s.replace(/\r\n?/g, '\n').trim()
if (tagMsg.status !== 0 || normEol(tagBody) !== normEol(body)) {
  fail('tag 消息与预期不符（正文可能没写全）；先 git tag -d v' + nextVersion + ' 删掉再重试')
}
run('git', ['push', 'origin', `v${nextVersion}`])

// ── 6. 等 Release 并核对资产 ──
step('等 Release 工作流')
const relRun = waitForRun({ headSha, workflow: 'Release', initialDelayMs: 8000 })
console.log(`  Release run ${relRun} 已就绪，等待结果…`)
run('gh', ['run', 'watch', relRun, '--exit-status', '--interval', '15'])
console.log('  ✓ Release 工作流全绿')

step('核对 Release 与 zip 资产')
const rel = JSON.parse(
  capture('gh', ['release', 'view', `v${nextVersion}`, '--json', 'tagName,isDraft,isPrerelease,assets,url']).out
)
if (rel.isDraft || rel.isPrerelease) fail(`Release v${nextVersion} 状态异常：draft=${rel.isDraft} prerelease=${rel.isPrerelease}`)

const zipName = `balance-whale-widget-v${nextVersion}.zip`
const asset = rel.assets.find((a) => a.name === zipName)
if (!asset) fail(`Release 里找不到资产 ${zipName}（现有：${rel.assets.map((a) => a.name).join(', ') || '无'}）`)
console.log(`  ✓ 资产 ${zipName}  ${(asset.size / 1024).toFixed(1)} KB`)

// zip 内部结构核对：plugin.json 必须在顶层且版本号对得上，preload 必须原样在（不打包不压缩）
const zipDir = path.join(os.tmpdir(), `whale-release-${nextVersion}`)
const verifyScript = path.join(root, 'scripts', 'verify-release-zip.mjs')
// zipDir 必须加引号：run() 是把参数拼成一条命令交给 shell 的，路径含空格时
// （用户名目录就是常见情况，如 C:\Users\Some User\...）会被拆成两个参数，位置全错位。
run('node', [verifyScript, `"${zipDir}"`, zipName, nextVersion])

console.log(`
[release] ✓ v${nextVersion} 发布完成
  Release: ${rel.url}

  仍需人工：
   1. 在 uTools 开发者工具里把入口指向 dist/，重新加载插件验证
   2. 要上架的话，开发者工具里打包 .upx 上传插件市场
`)
} finally {
  cleanup()
  // --dry-run 还原版本号：放 finally 才会在「四关失败 / 中途 fail()」时也还原，
  // 否则一次失败的 dry-run 会把工作区留成「版本号已改」的状态，比不改还糟。
  if (dryRun && versionBackup.size) {
    for (const [rel, orig] of versionBackup) {
      const abs = path.join(root, rel)
      try {
        if (orig === null) rmSync(abs, { force: true })
        else writeFileSync(abs, orig, 'utf8')
      } catch (e) {
        console.log(`  [release] 警告：还原 ${rel} 失败（${(e && e.message) || e}），请手动检查`)
      }
    }
    console.log('\n[release] --dry-run：版本号改动已还原，工作区恢复原状\n')
  }
}
}

// 收尾统一在这里：fail() 抛 ReleaseError 上来，非预期异常原样打印堆栈以便定位。
// 放在 main 之外，保证 finally 已执行完（临时文件清干净）才退出进程。
try {
  main()
} catch (e) {
  if (e instanceof ReleaseError) {
    console.error(`\n[release] ✗ ${e.message}\n`)
  } else {
    console.error(`\n[release] ✗ 未预期错误：\n`, e)
  }
  process.exitCode = 1
}

// ── 辅助：轮询等某个 head 的工作流出现 ──
// gh run list 的 databaseId 是数字，用 --json 解析避免科学计数法；轮询是因为
// 刚 push 时 run 还没建出来，直接 gh run watch 会报「run not found」。
function waitForRun({ headSha, workflow, initialDelayMs = 0, timeoutMs = 120000 }) {
  const started = Date.now()
  if (initialDelayMs > 0) sleep(initialDelayMs)
  for (;;) {
    const list = JSON.parse(
      capture('gh', ['run', 'list', '--limit', '10', '--json', 'databaseId,headSha,name,status']).out
    )
    const hit = list.find((r) => r.headSha === headSha && r.name.includes(workflow))
    if (hit) return String(hit.databaseId)
    if (Date.now() - started > timeoutMs) {
      fail(`等 ${workflow} 工作流超时（head=${headSha.slice(0, 7)}）；去 GitHub Actions 页面手动确认`)
    }
    sleep(5000)
  }
}
