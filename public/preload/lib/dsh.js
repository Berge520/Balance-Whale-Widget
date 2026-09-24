/*
 * DeepSeek Harness（dsh）进程管理（CommonJS）。
 *
 * 面向开发者用户：在挂件菜单/设置页里 启动 / 重启 / 结束 / 更新 dsh，并打开它的 Web UI。
 *  - 插件把 dsh 装在自己的数据目录（<userData>/dsh，npm install --prefix，不污染全局），
 *    启动时直接用 node 跑那份 CLI：既不会被 PATH 上的全局 dsh 抢先，也不受 npx 缓存哈希/清理影响，
 *    因此「已安装 / 实际使用 / 设置里选的版本」三者始终一致
 *  - 「更新」＝结束正在运行的 dsh → 重新安装指定版本 → 原本在跑就用新版重新启动
 *  - --no-open 可在设置页勾选（默认勾选＝启动不自动弹浏览器，用「打开页面」按钮打开）
 * Node.js 目录：优先用户自定义目录，其次 PATH，最后常见安装位置（含 nvm）。
 */
const { spawn, execFile, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { log, logErr } = require('./log')
const { readConfig } = require('./store')
const { K, NEWEST_VERSION } = require('./constants')
const { homeDir } = require('./util')

const DSH_PORT = 3080
const DSH_URL = 'http://127.0.0.1:' + DSH_PORT
const DSH_PKG = '@deepseek-ai/dsh'
const LOG_MAX = 160 // 内存里保留的日志行数
const WIN = process.platform === 'win32'

const state = {
  child: null,
  pid: 0,
  startedAt: 0,
  stopping: false,
  nodeDir: '',        // 用户自定义 Node.js 目录；'' = 自动探测
  keepAlive: false,   // true = uTools 退出后不结束 dsh
  busy: '',           // '' | 'update'
  error: '',
  exitCode: null,
  exitAt: 0,
  log: [],
  lastCmd: '',        // 最近执行的命令（界面展示 + 日志里以 $ 开头记一行）
  registry: '',       // npm 注册源（'' = 官方 registry.npmjs.org）
  version: '',        // '' = 自动（安装/更新时取 latest）；否则固定版本号
  reinstall: false,   // 更新前先删掉插件目录里的 dsh，强制重装
  noOpen: true,       // 启动时带 --no-open（不自动开浏览器，用「打开页面」按钮打开）
  versions: { at: 0, latest: '', list: [] }, // 「查询版本」结果（落库缓存，重载插件后仍在）
  versionsLoaded: false,
  installed: '',      // 插件目录里实际安装的 dsh 版本（所见即所跑）
  prefix: '',         // 插件自己那份 dsh 的安装目录（懒解析）
  globalWritable: null, // 全局安装目录当前用户可写？null=还没测过（只在需要时试写一次）
  extPid: 0,          // 监听 3080 的外部 dsh 进程（非本插件启动）
  extName: '',
  ready: false,       // 本次启动后 3080 是否已就绪（首次安装要下载，起来要一会儿）
  readyAt: 0,
  readyTimer: null,
  webUrl: '',         // dsh 打印的带 token 的页面地址（浏览器认证用），停止后失效
  runVersion: '',     // 本次启动实际用的版本（用于判断更新后是否要重启）
  tail: '',           // 输出滚动缓冲：token 地址可能被拆到两个 data 事件里
  versionCache: {},   // dir → node -v 结果
  resolveCache: { key: '\u0000', value: null },
  pnpmCache: { key: '\u0000', value: '' }, // pnpm 可执行文件路径缓存（探测要扫多个目录）
}

// 记一条「要执行的命令」：既进日志，也作为状态暴露给界面
function setCmd(text) {
  state.lastCmd = String(text == null ? '' : text)
  pushLog('$ ' + state.lastCmd)
}

function pushLog(text) {
  // 去掉 ANSI 转义（dsh 可能带颜色/光标控制），并给每行加时间戳，便于回看「什么时候执行的」
  const cleaned = String(text == null ? '' : text)
    .replace(/\r/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
  const d = new Date()
  const stamp = '[' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + '] '
  for (const p of cleaned.split('\n')) {
    const line = p.trimEnd()
    if (!line) continue
    const one = stamp + (line.length > 400 ? line.slice(0, 400) + '…' : line)
    state.log.push(one)
  }
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX)
}

// ──────────────────────────────────────────────
// 状态变更广播
// 挂件菜单只在点击操作时拉一次快照，而 3080 就绪 / 进程退出 / 安装完成 / 版本查完
// 都是稍后才发生的异步事件 —— 不主动广播，挂件状态会一直停在「启动中…」「正在结束…」
// （设置页靠每 4s 轮询能自愈，挂件不轮询）。由 IPC 层订阅后转发给挂件窗口。
// ──────────────────────────────────────────────
const changeListeners = []
function onChange(cb) { if (typeof cb === 'function') changeListeners.push(cb) }
function broadcast() {
  if (!changeListeners.length) return
  let s = null
  for (const cb of changeListeners) {
    try { cb(s || (s = snapshot())) } catch (err) {}
  }
}

// ──────────────────────────────────────────────
// Node.js 目录解析
// ──────────────────────────────────────────────
function exeNames(base) {
  return WIN ? [base + '.cmd', base + '.exe', base + '.bat', base] : [base]
}
function findExe(dir, base) {
  if (!dir) return ''
  for (const n of exeNames(base)) {
    const p = path.join(dir, n)
    try { if (fs.statSync(p).isFile()) return p } catch (err) {}
  }
  return ''
}
function hasNode(dir) { return !!findExe(dir, 'node') }
// PATH 里常带结尾分隔符（D:\nodejs\;…），去掉后再用，避免界面显示成 D:\nodejs\
function trimDir(d) {
  const s = String(d == null ? '' : d)
  return s.length > 3 ? s.replace(/[\\/]+$/, '') : s
}

function pathDirs() {
  return String(process.env.PATH || '').split(WIN ? ';' : ':').filter(Boolean)
}
function commonDirs() {
  const out = []
  if (WIN) {
    const pf = process.env.ProgramFiles
    const pf86 = process.env['ProgramFiles(x86)']
    const la = process.env.LOCALAPPDATA
    const ad = process.env.APPDATA
    if (pf) out.push(path.join(pf, 'nodejs'))
    if (pf86) out.push(path.join(pf86, 'nodejs'))
    if (la) out.push(path.join(la, 'Programs', 'nodejs'))
    if (process.env.NVM_SYMLINK) out.push(process.env.NVM_SYMLINK) // nvm-windows 当前版本软链
    if (process.env.NVM_HOME) out.push(process.env.NVM_HOME)
    if (ad) out.push(path.join(ad, 'nvm')) // nvm-windows 版本目录（下面会扫子目录）
  } else {
    out.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
    if (process.env.NVM_DIR) out.push(path.join(process.env.NVM_DIR, 'current', 'bin'))
  }
  return out.filter(Boolean)
}
// nvm 目录下按 版本号 取最新的一个子目录
function newestVersionDir(dir) {
  let subs = []
  try { subs = fs.readdirSync(dir).filter((n) => /^v?\d+\./.test(n)) } catch (err) { return '' }
  subs.sort((a, b) => {
    const pa = a.replace(/^v/, '').split('.').map(Number)
    const pb = b.replace(/^v/, '').split('.').map(Number)
    return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2])
  })
  for (const s of subs) {
    const sd = path.join(dir, s)
    if (hasNode(sd)) return sd
    if (hasNode(path.join(sd, 'bin'))) return path.join(sd, 'bin')
  }
  return ''
}
// → { dir, node, npm, npx } 或 null
function resolveNode(custom) {
  const key = String(custom || '') + '\u0000' + String(process.env.PATH || '').length
  if (state.resolveCache.key === key) return state.resolveCache.value
  const dirs = []
  if (custom) dirs.push(custom)
  for (const d of pathDirs()) dirs.push(d)
  for (const d of commonDirs()) dirs.push(d)
  let found = null
  for (const d of dirs) {
    if (!d) continue
    if (hasNode(d)) { found = { dir: trimDir(d), node: findExe(d, 'node'), npm: findExe(d, 'npm'), npx: findExe(d, 'npx') }; break }
    const nv = newestVersionDir(d)
    if (nv) { found = { dir: trimDir(nv), node: findExe(nv, 'node'), npm: findExe(nv, 'npm'), npx: findExe(nv, 'npx') }; break }
  }
  // macOS/Linux 的 GUI 进程不执行 ~/.zshrc / ~/.bash_profile，PATH 里可能根本没有 node
  // （nvm / homebrew 装的 node 都只写在 rc 文件里）。这里只在常规探测**全部失败**后才兜底，
  // 且结果一并进 resolveCache —— 兜底要起一个交互 shell（可能几百毫秒），不能每次都跑。
  if (!found && !WIN) found = resolveNodeViaLoginShell()
  state.resolveCache = { key: key, value: found }
  return found
}

// 找 pnpm：profile 的依赖树由 pnpm 维护（node_modules/.modules.yaml 里逐条记着 pnpm 的
// hoistPattern / allowBuilds / virtualStoreDir），所以装插件**必须**也走 pnpm，
// 否则 pnpm 下次一同步就会把我们用 npm 改出来的树整个改回去。
//
// ⚠️ 为什么不用 `node.npm exec pnpm`：Electron 里的 process.execPath 是 uTools 自己，
//    取不到 npm 前缀，这条兜底其实是死的。pnpm 在本机是**全局包**（D:\nodejs\npm-global\pnpm.cmd
//    或 ~/AppData/Local/pnpm/pnpm.CMD），落在 Node 目录与 npm 全局目录两处，直接按这两个位置找即可。
//    找不到就让调用方**明确报错**（提示用户装 pnpm）—— 不偷偷退回 npm：
//    退回 npm 正是这次 ERESOLVE 的根源，静默降级只会把同一个错换个地方再报一次。
function resolvePnpm(node) {
  const key = (node && node.dir ? node.dir : '') + '\u0000' + String(process.env.PATH || '').length
  if (state.pnpmCache.key === key) return state.pnpmCache.value
  const found = findPnpm(node)
  state.pnpmCache = { key: key, value: found }
  return found
}
// → 可执行文件绝对路径，或 ''
function findPnpm(node) {
  const dirs = []
  if (node && node.dir) dirs.push(node.dir)
  for (const d of pathDirs()) dirs.push(d)
  // npm 全局目录：pnpm 多半是 `npm i -g pnpm` 装的，落在全局 bin 里，而全局 bin 常常不在 PATH
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'pnpm', 'bin'))
  for (const d of commonDirs()) dirs.push(d)
  for (const d of dirs) {
    if (!d) continue
    const p = findExe(d, 'pnpm')
    if (p) return p
  }
  return ''
}

// 登录 shell 兜底：`$SHELL -i -c 'command -v node'`，解析出 node 所在目录后按常规布局补齐 npm/npx。
// 取**最后一行**：`-i` 会加载用户 rc 文件，可能先打印欢迎语 / nvm 提示 / 版本横幅，
// 真正的路径在末尾。整段拿去当路径必然失败，所以只认最后一行里像绝对路径的那条。
function resolveNodeViaLoginShell() {
  const shell = String(process.env.SHELL || '')
  if (!shell) return null
  let out = ''
  try {
    // 同步执行：调用方（resolveNode）本身是同步契约，改成异步会波及所有调用点。
    // 5s 超时兜住 rc 文件卡住的情况（timeout 选项会 kill 子进程）
    out = decodeOut(execFileSync(shell, ['-i', '-c', 'command -v node'], { timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch (err) {
    return null
  }
  const p = lastPathLine(out)
  if (!p) return null
  // command -v 可能给的是 node 本身，也可能是 nvm 的 shim；取它所在目录后按常规布局找三个可执行文件
  const dir = path.dirname(p)
  if (!hasNode(dir)) return null
  return { dir: trimDir(dir), node: findExe(dir, 'node'), npm: findExe(dir, 'npm'), npx: findExe(dir, 'npx') }
}

// 从 shell 输出里挑出「像 node 绝对路径」的最后一行。
// 纯字符串处理，便于单测：不碰 fs、不碰进程。
function lastPathLine(out) {
  const lines = String(out == null ? '' : out).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim().replace(/^['"]|['"]$/g, '')
    if (!s) continue
    // 必须看起来是绝对路径且以 node 结尾，避免把欢迎语里的普通单词当路径
    // 绝对路径的三形态：POSIX `/x`、UNC `\\x`、Windows 盘符 `C:\x` / `C:/x`
    if (!/^([\\/]|[a-zA-Z]:[\\/])/.test(s)) continue
    if (!/[\\/]node(\.exe)?$/i.test(s)) continue
    return s
  }
  return ''
}
function nodeVersion(node) {
  if (!node) return ''
  if (state.versionCache[node.dir] !== undefined) return state.versionCache[node.dir]
  let v = ''
  try {
    v = String(execFileSync(node.node, ['-v'], { timeout: 5000, windowsHide: true })).trim()
  } catch (err) { v = '' }
  state.versionCache[node.dir] = v
  return v
}

// ──────────────────────────────────────────────
// 子进程
// ──────────────────────────────────────────────
// ⚠️ cmd.exe 的引号规则与 POSIX 完全不同，**不能**沿用 POSIX 式引号：
//    （2026-09-24 实测）`cmd /s /c` 会先把整条命令串**再包一层引号**，再按 /s 语义剥掉最外层那对。
//    若我们自己已经在内层用 `"` 包了每个参数，外层补的那对会和它们错配 —— 实测命令名被吃成
//    `dejs\npm.cmd\"`，报「不是内部或外部命令」（日志里那行 `'\"D:\nodejs\npm.cmd\"'` 就是这个）。
//    另一种写法（内层改用 cmd 的 `""` 转义）实测同样失败，因为 /s 的剥离发生在转义解析之前。
//    结论：这条线上**只对真正含空格的参数**加引号，且参数内的引号用 cmd 的 `""` 转义。
//    纯裸参数（install / --prefix / dshmarket…）一律不加，让 cmd 原样吞下。
function quoteCmdArg(s) {
  const v = String(s)
  // 不含空格与特殊字符就不包引号：包了反而会被 /s 的外层引号错配掉
  if (!/[\s"&|<>^()]/.test(v)) return v
  return '"' + v.replace(/"/g, '""') + '"'
}
function childEnv(node) {
  const extra = []
  if (node) {
    extra.push(node.dir)
    if (process.env.APPDATA) extra.push(path.join(process.env.APPDATA, 'npm'))
    if (process.env.LOCALAPPDATA) extra.push(path.join(process.env.LOCALAPPDATA, 'npm'))
  }
  const env = Object.assign({}, process.env)
  env.PATH = extra.concat([process.env.PATH || '']).join(path.delimiter)
  env.FORCE_COLOR = '0'
  return env
}
function spawnCmd(exe, args, node) {
  const options = { cwd: os.homedir(), env: childEnv(node), windowsHide: true }
  if (WIN) {
    // npm/dsh 都是 .cmd，必须经 cmd.exe 执行；但**不能**用 shell:true。
    // shell:true 会让 Node 走 `cmd.exe /d /s /c "..."` 且把读写管道挂在这个 cmd 上，
    // 实测在 uTools（Electron，GUI 子系统、无控制台）下会闪出一个 cmd 黑窗口 ——
    // windowsHide 挡不住它。改为自己起 cmd.exe 并把 stdio 显式设为管道，
    // cmd 就没有可附加的控制台，窗口自然不出现，输出仍正常回到父进程。
    // ⚠️ 用 quoteCmdArg 而不是 quote()：cmd /s /c 这条线上用 POSIX 式引号会错配（见上面注释）
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoteCmdArg(exe) + ' ' + args.map(quoteCmdArg).join(' ')],
      Object.assign(options, { stdio: ['ignore', 'pipe', 'pipe'] }))
  }
  // POSIX 下独立进程组，结束时可整组杀掉（dsh 会有子进程）
  return spawn(exe, args, Object.assign(options, { detached: true }))
}
function bindOutput(child) {
  const onData = (d) => {
    const text = String(d == null ? '' : d)
    pushLog(text)
    // token 地址可能被拆分到两次输出里，用滚动缓冲拼起来再匹配
    state.tail = (state.tail + text).slice(-500)
    captureWebUrl(state.tail)
  }
  try { child.stdout && child.stdout.on('data', onData) } catch (err) {}
  try { child.stderr && child.stderr.on('data', onData) } catch (err) {}
}

// ──────────────────────────────────────────────
// 端口占用探测：识别「在别的终端里跑的 dsh」，支持由本插件结束/重启
// ──────────────────────────────────────────────
// gen = 探测轮次号：force 允许两轮并存，只让**最新一轮**写结果，
// 否则先发起（但更旧）的那轮后回来会把新结果覆盖回去。
const probe = { pid: 0, name: '', cmdline: '', cmdlineKnown: false, at: 0, busy: false, waiters: [], selfOwned: false, gen: 0 }
function isDshName(name) { return /^(node|dsh)(\.exe)?$/i.test(String(name || '').trim()) }
// 命令行里出现这些字样才算「这确实是 dsh」。
// 只看进程名（node.exe）是不够的：任何 Node 程序都叫 node.exe。
// 本机实测（2026-09-22）起一个裸 `node -e "net.createServer().listen(3080)"` 占住 3080，
// 进程名同样是 node.exe，旧判据于是把它报成「3080 上已有外部 dsh 在运行」——
// 把一个真占用降级成了无害的 warning，用户按提示去「接管」必然失败。
// 真 dsh 的命令行长这样（本项目实测）：
//   "D:\nodejs\node.exe" D:\nodejs\npm-global\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open
const DSH_CMDLINE_RE = /(@deepseek-ai[\\/]dsh|dsh[\\/](lib[\\/])?bin\.js|[\\/]dsh\.(cmd|exe|js)\b|@deepseek-ai[\\/]dsh-)/i
// 纯函数，便于单测：命令行能否证明「这是 dsh」。
// 返回 true / false / null（null = 判不出来，调用方按 D26 报「无法确认」）
function looksLikeDsh(cmdline) {
  if (cmdline == null) return null
  const s = String(cmdline).trim()
  if (!s) return null
  return DSH_CMDLINE_RE.test(s)
}
// netstat -ano（Windows）/ lsof（POSIX）输出 → 监听 DSH_PORT 的 pid
function parsePortPid(out) {
  const text = String(out || '')
  if (!WIN) {
    const first = text.trim().split('\n')[0]
    return /^\d+$/.test(first.trim()) ? Number(first.trim()) : 0
  }
  for (const line of text.split('\n')) {
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 4 && parts[1] && parts[1].indexOf(':' + DSH_PORT) >= 0) return Number(parts[parts.length - 1]) || 0
  }
  return 0
}
// Windows 自带命令（taskkill/tasklist/netstat）在中文系统上按 GBK 输出，
// 直接当 UTF-8 会显示成乱码：先按 UTF-8 试，出现替换字符就再按 GBK 解一遍
function decodeOut(buf) {
  if (buf == null) return ''
  if (typeof buf === 'string') return buf
  let raw
  try { raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf) } catch (err) { return String(buf) }
  const u8 = raw.toString('utf8')
  if (u8.indexOf('\uFFFD') < 0) return u8
  try { return new TextDecoder('gbk').decode(raw) } catch (err) { return u8 }
}
// 目录当前用户是否可写：Windows 上 fs.access 的 W_OK 不校验 ACL，只能真的建/删一个临时目录来试
function canWriteDir(dir) {
  if (!dir) return false
  let tmp = ''
  try {
    tmp = fs.mkdtempSync(path.join(dir, '.whale-write-'))
    return true
  } catch (err) {
    return false
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (err) {} }
  }
}
// 提权结束用的 powershell 绝对路径（找不到就退回 PATH 里的 powershell）
function psExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try { if (fs.existsSync(p)) return p } catch (err) {}
  return 'powershell'
}
// 提权失败的原因：UAC 被取消（用户点了「否」）还是 npm 在管理员权限下仍然失败
function elevateWhy(info) {
  if (info && info.canceled) return '：UAC 提权被取消（弹窗里点了「否」），可重试并在弹窗点「是」'
  return '：管理员权限下 npm 安装失败（原因见上方日志）'
}
// 以管理员权限跑一次 npm（UAC 弹窗）；用于全局安装目录只对管理员可写的情况
// 提权进程会另开一个控制台窗口，它的输出不会回到父进程（npm 报错一闪而过，日志里只剩「提权未成功」），
// 所以用临时 .cmd 包一层把输出重定向到文件，跑完读回来 —— 失败时才有据可查。
// -Wait -PassThru 拿 npm 的退出码，避免「提权被取消」却被当成成功
function elevateInstall(npmExe, args, onDone) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const cq = (s) => '"' + String(s) + '"'
  const stamp = 'whale-elev-' + process.pid + '-' + Date.now()
  const bat = path.join(os.tmpdir(), stamp + '.cmd')
  const outFile = path.join(os.tmpdir(), stamp + '.log')
  let ps = ''
  try {
    fs.writeFileSync(bat, '@echo off\r\n' + [npmExe].concat(args).map(cq).join(' ')
      + ' > ' + cq(outFile) + ' 2>&1\r\nexit /b %ERRORLEVEL%\r\n')
    ps = '$p = Start-Process -FilePath "cmd.exe" -ArgumentList ' + q('/c') + ',' + q(bat)
      + ' -Verb RunAs -Wait -PassThru; exit $p.ExitCode'
  } catch (err) {
    pushLog('提权安装未成功（无法创建临时脚本）：' + ((err && err.message) || err))
    if (onDone) onDone(err, { code: 0, canceled: false })
    return
  }
  const cleanup = () => {
    try { fs.rmSync(bat, { force: true }) } catch (err) {}
    try { fs.rmSync(outFile, { force: true }) } catch (err) {}
  }
  execFile(psExe(), ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'buffer' }, (err, so, se) => {
    let npmOut = ''
    try { npmOut = decodeOut(fs.readFileSync(outFile)).trim() } catch (err2) {}
    if (npmOut) pushLog(npmOut)
    cleanup()
    const own = (decodeOut(so) + decodeOut(se)).trim()
    if (own) pushLog(own)
    // 取消 UAC 时 powershell 自己会报错（stderr 非空）；npm 失败则是它的退出码 + 上面读回来的输出
    const canceled = !!own && /cancel|取消|拒绝访问|access is denied/i.test(own)
    const code = err && err.code !== undefined ? err.code : 0
    if (err) pushLog('提权安装未成功（退出码 ' + code + (canceled ? '，UAC 被取消' : '，管理员权限下 npm 仍失败') + '）')
    if (onDone) onDone(err, { code: code, canceled: canceled })
  })
}
function processName(pid, cb) {
  if (WIN) {
    execFile('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true, encoding: 'buffer' }, (err, out) => {
      const m = /^"([^"]+)"/.exec(decodeOut(out).trim())
      cb(err ? '' : (m ? m[1] : ''))
    })
    return
  }
  execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000, encoding: 'buffer' }, (err, out) => cb(err ? '' : decodeOut(out).trim()))
}
// 某个 pid 的完整命令行（用于区分「真 dsh」与「别的 node 程序」，见 looksLikeDsh）。
// Windows 优先 wmic（Win11 起已从部分系统移除，失败就换 powershell CIM），
// 两条都拿不到 → 返回 ''，调用方按「判不出来」处理（D26），绝不瞎猜。
// ⚠️ 不能用 tasklist：它只给进程名，拿不到命令行 —— 本 bug 的根因就是「只有名字」。
function processCmdline(pid, cb) {
  const fail = () => cb('')
  if (!WIN) {
    execFile('ps', ['-p', String(pid), '-o', 'args='], { timeout: 5000, encoding: 'buffer' }, (err, out) => {
      if (err) return fail()
      cb(decodeOut(out).trim())
    })
    return
  }
  execFile('wmic', ['process', 'where', 'processid=' + pid, 'get', 'commandline', '/value'], { timeout: 5000, windowsHide: true, encoding: 'buffer' }, (err, out) => {
    const text = err ? '' : decodeOut(out)
    // 输出形如 `CommandLine=<完整命令行>`（含路径里的 `=` 也照取），取第一行有效值
    const m = /^\s*CommandLine=(.*)$/im.exec(text)
    const v = m ? m[1].trim() : ''
    if (v) { cb(v); return }
    // wmic 不可用（新版 Windows 已移除）→ 退回 powershell CIM，多花约 300ms，只在探测端口归属时走一次
    execFile(psExe(), ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine'], { timeout: 6000, windowsHide: true, encoding: 'buffer' }, (err2, out2) => {
      cb(err2 ? '' : decodeOut(out2).trim())
    })
  })
}
// 让本轮结束：**最新的轮次**清空队列并发通知；旧轮只回调自己那个 cb（给旧值也比永不回调好 ——
// watchReady 的轮询可以被吞一轮，但 detectPort 的调用方若永不回调就只能等 8s 超时兜底）。
function flushProbe(cb, gen) {
  if (gen === probe.gen) {
    const ws = probe.waiters
    probe.waiters = []
    for (const w of ws) { try { w(probe.pid) } catch (err) {} }
  }
  if (cb) { try { cb(probe.pid) } catch (err) {} }
}
// 探测结果缓存在 probe 里，供同步的 snapshot()/stop() 使用；cb(pid) 在探测完成后回调。
// force=true 时即使有探测在跑也**另起一轮**（见 detectPort 的 staleness 问题）：
// 排队复用正在跑的那一轮，拿到的可能是几毫秒前跑的、当时端口还没起来的空结果。
function probePort(cb, force) {
  if (probe.busy && !force) { if (cb) probe.waiters.push(cb); return }
  probe.busy = true
  const myGen = ++probe.gen
  const stale = () => __isStale(myGen, probe.gen) // 已有更新的轮次 → 本轮作废，不写 probe
  const exe = WIN ? 'netstat' : 'lsof'
  const args = WIN ? ['-ano', '-p', 'tcp'] : ['-nP', '-iTCP:' + DSH_PORT, '-sTCP:LISTEN', '-t']
  execFile(exe, args, { timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    const pid = err ? 0 : parsePortPid(stdout)
    if (!pid) {
      if (!stale()) {
        probe.pid = 0; probe.name = ''; probe.cmdline = ''; probe.cmdlineKnown = false; probe.at = Date.now(); probe.selfOwned = false
        probe.busy = false
      }
      flushProbe(cb, myGen)
      return
    }
    // 名字 / 命令行 / 父链归属各跑一次 execFile：串行会叠加多次进程创建开销（Windows 上各约 100–300ms），
    // 这里并行发起、都回来才算探测完成，避免状态卡刷新时端口归属长时间「探测中」。
    // 父链只在「监听 pid 不等于插件 pid」时才需要真查（同 pid 直接算自己人）。
    let left = 3
    const done = () => {
      if (--left > 0) return
      if (!stale()) {
        probe.busy = false
        probe.pid = pid
        probe.at = Date.now()
      }
      flushProbe(cb, myGen)
    }
    processName(pid, (name) => {
      if (!stale()) probe.name = name
      done()
    })
    processCmdline(pid, (cmdline) => {
      if (!stale()) { probe.cmdline = cmdline; probe.cmdlineKnown = !!cmdline }
      done()
    })
    isSelfOwnedPort(pid, (self) => {
      if (!stale()) probe.selfOwned = self
      done()
    })
  })
}
// 结束外部 dsh：命令返回码 + 复查 3080，如实反馈；
// 普通权限被拒（拒绝访问）时自动改用管理员权限再杀一次（会弹一次 UAC）
function stopExternal(pid, done) {
  setCmd(WIN ? 'taskkill /pid ' + pid + ' /T /F' : 'kill -TERM ' + pid)
  const opts = { windowsHide: true, encoding: 'buffer' }
  let elevated = false
  const report = (still) => {
    if (still) {
      state.error = '结束失败：3080 仍在监听（pid ' + still + '）。可能是权限不足（可尝试以管理员身份运行 uTools），'
        + '或 dsh 有守护进程把它拉了起来（在它自己的终端里按 Ctrl+C 更可靠）'
      pushLog(state.error)
    } else {
      state.error = ''
      probe.pid = 0
      probe.name = ''
      pushLog('已结束外部启动的 dsh（pid=' + pid + '）')
    }
    broadcast() // 复查/可能的 UAC 提权要 1.5–15s，结束后主动推一次
    if (done) done(snapshot())
  }
  // 等 waitMs 后复查；还没起来就再等 rounds 轮（每轮 1.5s，用于等用户点 UAC）
  const verify = (waitMs, rounds) => {
    setTimeout(() => {
      probePort((still) => {
        if (!still) { report(0); return }
        if (WIN && !elevated) {
          elevated = true
          pushLog('普通权限被拒绝（拒绝访问），改用管理员权限结束：请在 UAC 弹窗中点「是」')
          const ps = 'Start-Process -FilePath taskkill -ArgumentList \'/pid\',\'' + still + '\',\'/T\',\'/F\' -Verb RunAs'
          execFile(psExe(), ['-NoProfile', '-Command', ps], opts, (err, so, se) => {
            const out = (decodeOut(so) + decodeOut(se)).trim()
            if (out) pushLog(out)
            if (err) pushLog('提权结束命令返回错误（可能取消了 UAC）：' + ((err && err.code) !== undefined ? err.code : '未知'))
            verify(1500, 10)
          })
          return
        }
        if (rounds > 0) { verify(1500, rounds - 1); return }
        report(still)
      })
    }, waitMs)
  }
  const onDone = (err, stdout, stderr) => {
    const out = (decodeOut(stdout) + decodeOut(stderr)).trim()
    if (out) pushLog(out)
    if (err) pushLog('结束命令退出码：' + ((err && err.code) !== undefined ? err.code : '未知'))
    verify(700, 0)
  }
  if (WIN) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], opts, onDone)
  else execFile('kill', ['-TERM', String(pid)], opts, onDone)
}
// 某 pid 的父进程 pid（拿不到返回 0）。
// 用于「沿父链上溯」，判断监听 3080 的进程是不是本插件 spawn 出来的后代。
// ⚠️ 不能只看 state.pid === probe.pid：Windows 下 spawn 用了 shell:true，插件拿到的是
// cmd.exe 的 pid，真正监听 3080 的是它的子进程 node.exe（cmd 是中间层）。
// 本机实测（2026-09-22）进程链：插件 → cmd.exe(28260) → node.exe(12488 监听 3080)，
// 于是 probe.pid(12488) !== state.pid(28260)，externalPid() 判定成「外部 dsh」，
// 状态卡说「运行中」而诊断卡说「外部进程在跑」，自相矛盾。必须上溯祖辈才能认出自己人。
function processParent(pid, cb) {
  const fail = () => cb(0)
  if (!WIN) {
    execFile('ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 5000, encoding: 'buffer' }, (err, out) => {
      if (err) return fail()
      const v = Number(decodeOut(out).trim())
      cb(Number.isFinite(v) && v > 0 ? v : 0)
    })
    return
  }
  execFile('wmic', ['process', 'where', 'processid=' + pid, 'get', 'parentprocessid', '/value'], { timeout: 5000, windowsHide: true, encoding: 'buffer' }, (err, out) => {
    const text = err ? '' : decodeOut(out)
    const m = /^\s*ParentProcessId=(\d+)/im.exec(text)
    if (m) { cb(Number(m[1]) || 0); return }
    // wmic 不可用（新版 Windows 已移除）→ 退回 powershell CIM
    execFile(psExe(), ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").ParentProcessId'], { timeout: 6000, windowsHide: true, encoding: 'buffer' }, (err2, out2) => {
      if (err2) return fail()
      const v = Number(decodeOut(out2).trim())
      cb(Number.isFinite(v) && v > 0 ? v : 0)
    })
  })
}
// 纯函数（便于单测）：从 `pid → 父pid` 的邻接表上溯，判断 from 是否为 self 的后代。
// depth 限量 + seen 防环：Windows 的父 pid 会被复用，且拿不到父时返回 0，
// 若不设界可能一直追下去；遇到 0 或环即停。
function isDescendantOf(from, self, parents, depth) {
  const max = depth || 8
  if (!from || !self) return false
  let cur = from
  const seen = {}
  for (let i = 0; i < max; i++) {
    if (!cur || seen[cur]) return false
    seen[cur] = true
    const p = parents && parents[cur]
    if (!p) return false
    if (p === self) return true
    cur = p
  }
  return false
}
// 纯函数（便于单测）：某轮探测是否已被更新的轮次取代 —— 取代后不许再写 probe，
// 也不许放行 waiters（否则调用方拿到的是旧值）。force 让两轮能并存，靠它定唯一写口。
function __isStale(myGen, latestGen) { return myGen !== latestGen }
// 监听 3080 的进程是不是本插件启动的那份（含「它是插件子进程的后代」）。
// 快路径是同 pid 相等；慢路径才去查父链（要跑 execFile，有成本）。
function isSelfOwnedPort(pid, cb) {
  if (!pid) { cb(false); return }
  if (pid === state.pid) { cb(true); return }
  if (!state.pid) { cb(false); return }
  // 只上溯 probe.pid 的祖辈，逐层取父；层级少（实测 2 层：node → cmd → 插件），
  // 每次 processParent 一次 execFile，为省开销串行走到命中或到头
  const parents = {}
  const step = (cur, left) => {
    if (!cur || left <= 0) { cb(false); return }
    processParent(cur, (p) => {
      parents[cur] = p
      if (p && p === state.pid) { cb(true); return }
      if (!p) { cb(false); return }
      step(p, left - 1)
    })
  }
  step(pid, 8)
}
// 外部 dsh：3080 被占用、不是本插件的子进程（含后代）、且**命令行能证明它是 dsh**。
// ⚠️ 光看进程名（node.exe）不算数：任何 Node 程序都叫 node.exe，本机实测一个裸 node 探针
// 占着 3080 时会被旧判据说成「外部 dsh」（漏报真占用）。命令行拿不到时保守返回 0 ——
// 宁可报「无法确认」也不能把别的程序说成 dsh（会让用户去点「接管」，然后失败）。
function externalPid() {
  if (!probe.pid || probe.pid === state.pid) return 0
  // 本插件启动时 probe.pid 是 state.pid 的后代（cmd 中间层），父链归属在快照阶段
  // 已由 probe.selfOwned 异步算好；这里同步读结果，未算好时保守当「不是自己的」
  if (probe.selfOwned) return 0
  if (!isDshName(probe.name)) return 0
  return looksLikeDsh(probe.cmdline) === true ? probe.pid : 0
}
// 非 dsh 进程占着 3080 时不允许结束（避免误杀别的程序）。
// 分两种「非 dsh」：
//   · 名字就不像 dsh（chrome.exe / nginx…）→ 直接给出进程名
//   · 名字像（node.exe）但命令行证明不是 dsh → 也说成占用，且带上名字 + 明示「非 dsh 的 node 程序」
// 命令行拿不到（null）时返回 '' —— 这是「判不出来」，交给 C5 报「无法确认是不是 dsh」
function portOccupiedByOther() {
  if (!probe.pid || probe.pid === state.pid) return ''
  // 与 externalPid 同理：本插件启动的那份监听着 3080 时，不能算「别人占用」
  if (probe.selfOwned) return ''
  if (!isDshName(probe.name)) return probe.name || '未知进程'
  return looksLikeDsh(probe.cmdline) === false ? (probe.name || 'node') : ''
}
// ── 插件自己那份 dsh：装在插件数据目录，不依赖全局安装，也不受 npx 缓存影响 ──
function dshPrefix() {
  if (!state.prefix) {
    let base = ''
    try { base = utools.getPath('userData') || '' } catch (err) {}
    if (!base) base = path.join(os.homedir(), '.balance-whale-widget')
    state.prefix = path.join(base, 'dsh')
  }
  return state.prefix
}
function dshPkgDir() { return path.join(dshPrefix(), 'node_modules', DSH_PKG) }
function readPkgVersion(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return j && j.version ? String(j.version) : ''
  } catch (err) { return '' }
}
// 某个 dsh 包目录的 CLI 入口：package.json 的 bin 字段（字符串，或 { dsh: 'lib/bin.js' }）
function cliEntryIn(pkgDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const b = pkg.bin
    const rel = typeof b === 'string' ? b : (b && (b.dsh || b[Object.keys(b)[0]]))
    if (!rel) return ''
    const p = path.join(pkgDir, String(rel))
    if (fs.statSync(p).isFile()) return p
  } catch (err) {}
  return ''
}
// 插件目录里的 dsh（CLI 入口 / 版本）
function cliEntry() { return cliEntryIn(dshPkgDir()) }
function installedVersion() {
  const v = readPkgVersion(path.join(dshPkgDir(), 'package.json'))
  state.installed = v
  return v
}
// 全局安装的 dsh 可能落在哪儿：Node 目录附近的各种布局 + npm 默认 prefix + PATH 里有 dsh 的目录
function globalPkgDirs() {
  const out = []
  const add = (d) => { if (d && out.indexOf(d) < 0) out.push(d) }
  const node = resolveNode(state.nodeDir)
  if (node && node.dir) {
    add(path.join(node.dir, 'node_modules'))
    add(path.join(node.dir, '..', 'node_modules'))
    add(path.join(node.dir, '..', 'lib', 'node_modules'))
    add(path.join(node.dir, 'node_global', 'node_modules'))  // nvm-windows
    add(path.join(node.dir, 'npm-global', 'node_modules'))   // 自定义 prefix（如 D:\nodejs\npm-global）
  }
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules'))
  if (process.env.PREFIX) add(path.join(process.env.PREFIX, 'lib', 'node_modules'))
  add(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'))
  add('/usr/local/lib/node_modules')
  add('/usr/lib/node_modules')
  // PATH 里带着 dsh 命令的目录，它旁边的 node_modules 就是那份全局安装
  for (const d of pathDirs()) {
    if (!d) continue
    for (const n of WIN ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']) {
      try {
        if (fs.statSync(path.join(d, n)).isFile()) { add(path.join(d, 'node_modules')); break }
      } catch (err) {}
    }
  }
  return out
}
// 全局有没有装 dsh（装了就用它，省一份重复下载）
function globalDsh() {
  for (const base of globalPkgDirs()) {
    const pkgDir = path.join(base, DSH_PKG)
    const version = readPkgVersion(path.join(pkgDir, 'package.json'))
    if (!version) continue
    const entry = cliEntryIn(pkgDir)
    if (entry) return { source: 'global', pkgDir: pkgDir, version: version, entry: entry }
  }
  return null
}
// 实际会用哪一份：全局优先，其次插件目录
function activeDsh() {
  const g = globalDsh()
  if (g) return g
  const entry = cliEntry()
  if (!entry) return null
  return { source: 'plugin', pkgDir: dshPkgDir(), version: installedVersion(), entry: entry }
}
// 「更新前重新下载」：删掉插件目录里的 dsh，强制重装（不动全局安装）
function removeInstalled() {
  const dir = path.join(dshPrefix(), 'node_modules')
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    pushLog('已删除插件目录里的 dsh（将重新下载）：' + dir)
  } catch (err) {
    pushLog('删除插件目录失败（文件被占用？）：' + ((err && err.message) || err))
  }
  state.installed = ''
  return true
}
// latest 是否比当前更新（数字段逐位比较；预发布后缀按「数字 > 字母」粗略处理，够用）
function isNewer(a, b) {
  const pa = String(a || '').split(/[.\-+]/), pb = String(b || '').split(/[.\-+]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i]
    if (x === undefined) return false
    if (y === undefined) return true
    const ix = parseInt(x, 10), iy = parseInt(y, 10)
    const sx = isNaN(ix), sy = isNaN(iy)
    if (sx && sy) { if (x !== y) return x > y; continue }
    if (sx !== sy) return sx // 数字段 > 字母段
    if (ix !== iy) return ix > iy
  }
  return false
}

// ──────────────────────────────────────────────
// 对外操作
// ──────────────────────────────────────────────
function configure(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const nodeDir = typeof c.dshNodeDir === 'string' ? c.dshNodeDir.trim() : ''
  const registry = typeof c.dshRegistry === 'string' ? c.dshRegistry.trim() : ''
  const version = typeof c.dshVersion === 'string' ? c.dshVersion.trim() : ''
  if (nodeDir !== state.nodeDir) state.resolveCache = { key: '\u0000', value: null }
  // pnpm 的候选目录里也有 node.dir，Node 目录一换就得重找
  if (nodeDir !== state.nodeDir) state.pnpmCache = { key: '\u0000', value: '' }
  if (nodeDir !== state.nodeDir) log('[whale][dsh] 配置变更', { nodeDir: nodeDir || '(自动)' })
  state.nodeDir = nodeDir
  state.keepAlive = c.dshKeepAlive === true
  state.registry = registry
  state.version = version
  state.noOpen = c.dshNoOpen !== false
  state.reinstall = c.dshReinstall === true
}
// 每次操作前从配置同步（设置页/挂件菜单都可能改），避免漏掉某个调用点
function syncConfig() {
  try { configure(readConfig()) } catch (err) { logErr('[whale][dsh] 读取配置失败', err && err.message) }
}
// 「要安装的版本」：配置固定了就用它；'newest' 取列表里最大的；否则 latest（「更新」用这个）
function installVersion() {
  if (state.version === NEWEST_VERSION) return maxVersion(state.versions && state.versions.list) || 'latest'
  return state.version || 'latest'
}
// 已查到的版本列表里最大的那个（含 alpha / rc 等预发布）。
// 不能拿 list[list.length-1] 顶替：list 是 npm 的发布顺序、不是版本序，
// 后期补发的旧分支补丁会排在更后面，取末位会装到比 latest 还旧的版本。
// 比较复用 isNewer；列表长 60 以内，O(n²) 足够。
function maxVersion(list) {
  const arr = Array.isArray(list) ? list : []
  let best = ''
  for (const v of arr) { if (!best || isNewer(v, best)) best = v }
  return best
}
// 目标版本（未固定版本时）：'newest' 看列表最大值，否则看 latest 标签。
// 供「更新」的幂等判断与「有新版本」提示共用，避免两处各写一套哨兵分支。
function targetVersion() {
  if (state.version === NEWEST_VERSION) return maxVersion(state.versions && state.versions.list)
  return (state.versions && state.versions.latest) || ''
}
// 包名（@版本）
function pkgSpec(v) { return DSH_PKG + '@' + (v || installVersion()) }
function regArgs() { return state.registry ? ['--registry=' + state.registry] : [] }
// 子命令：默认带 --no-open（不自动弹浏览器，用「打开页面」打开）
function webArgs() { return state.noOpen ? ['web', '--no-open'] : ['web'] }
// npm 提速参数：跳过审计与赞助请求
// 不能加 --prefer-offline：它会跳过缓存新鲜度校验，用旧的 packument 解析依赖树，
// 于是「刚发布的版本 / 它新带的子包」会被判成 ETARGET（选固定版本时最容易踩，缓存里的 tarball 本来就会命中）
function fastArgs() {
  return ['--no-audit', '--no-fund']
}
// 启动后就绪检测：3080 真正开始监听才算可用（首次安装要下载，可能几十秒）
function watchReady() {
  if (state.readyTimer) clearInterval(state.readyTimer)
  let ticks = 0
  state.readyTimer = setInterval(() => {
    ticks++
    if (!state.child) { // 进程退出：exit 事件会广播并经 clearReady 停掉轮询
      clearInterval(state.readyTimer)
      state.readyTimer = null
      return
    }
    if (ticks > 150) {
      // 超过 3 分钟仍未监听：不放弃（dsh 晚启动成功也能补上就绪），重置计数继续等，
      // 顺手推一次快照让界面别停在旧状态
      ticks = 0
      pushLog('3080 仍未就绪，继续等待（dsh 启动异常请看设置页日志）')
      broadcast()
    }
    probePort((pid) => {
      if (!pid) return
      state.ready = true
      state.readyAt = Date.now()
      const sec = state.startedAt ? ((state.readyAt - state.startedAt) / 1000).toFixed(1) + 's' : '未知'
      pushLog('3080 已就绪（启动用时 ' + sec + '）')
      if (state.readyTimer) { clearInterval(state.readyTimer); state.readyTimer = null }
      broadcast() // 关键推送：挂件状态从「启动中…（3080 未就绪）」变「运行中 · pid」
    })
  }, 1200)
}
function clearReady() {
  state.ready = false
  state.readyAt = 0
  state.webUrl = ''
  state.tail = ''
  if (state.readyTimer) { clearInterval(state.readyTimer); state.readyTimer = null }
}
// dsh web 会打印形如 http://127.0.0.1:3080/?token=xxx 的地址，浏览器首次访问必须带 token，
// 否则只显示「authentication required」。这里把地址抓下来供「打开页面」使用（优先本机回环地址）
const LOCAL_TOKEN_URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[^\s"'`]*[?&]token=[A-Za-z0-9._~%-]+/i
const ANY_TOKEN_URL_RE = /https?:\/\/[^\s"'`]*[?&]token=[A-Za-z0-9._~%-]+/i
function captureWebUrl(text) {
  const s = String(text || '')
  const m = LOCAL_TOKEN_URL_RE.exec(s) || ANY_TOKEN_URL_RE.exec(s)
  if (!m) return
  const url = m[0].replace(/[)\]},.;'"]+$/, '')
  if (!url || url === state.webUrl) return
  state.webUrl = url
  pushLog('已捕获带 token 的页面地址，「打开页面」会用它')
  broadcast()
}

function start() {
  syncConfig()
  if (state.child) { state.error = ''; return snapshot() }
  // 3080 已被别的进程占着时不重复启动（外部 dsh 可先用「结束」处理）
  const ext = externalPid()
  if (ext) {
    state.error = '端口 ' + DSH_PORT + ' 已被另一个 dsh（pid ' + ext + '）占用：请先「结束」或「重启」它'
    pushLog(state.error)
    return snapshot()
  }
  const other = portOccupiedByOther()
  if (other) {
    state.error = '端口 ' + DSH_PORT + ' 被 ' + other + ' 占用（不是 dsh），已停止启动'
    pushLog(state.error)
    return snapshot()
  }
  const node = resolveNode(state.nodeDir)
  if (!node) {
    state.error = '未找到 Node.js：请在设置页「DeepSeek Harness」里指定 Node.js 目录'
    pushLog(state.error)
    return snapshot()
  }
  const act = activeDsh()
  if (!act) {
    // 全局和插件目录都没有：先装再启动（装到插件目录，不动全局）
    pushLog('还没有可用的 dsh，先安装：' + pkgSpec())
    installDsh(() => start(), 'install')
    return snapshot()
  }
  const exe = node.node
  state.runVersion = act.version // 本次实际跑的版本（用于判断「更新后是否要重启」）
  // node <dsh 包目录>/lib/bin.js web [--no-open]（全局安装优先，其次插件目录）
  const args = [act.entry].concat(webArgs())
  state.error = ''
  state.exitCode = null
  setCmd(exe + ' ' + args.join(' '))
  let child = null
  try { child = spawnCmd(exe, args, node) } catch (err) {
    state.error = '启动失败：' + ((err && err.message) || err)
    pushLog(state.error)
    return snapshot()
  }
  state.child = child
  state.pid = child.pid || 0
  state.startedAt = Date.now()
  state.stopping = false
  clearReady()
  watchReady()
  bindOutput(child)
  child.on('error', (err) => {
    state.error = '启动失败：' + ((err && err.message) || err)
    pushLog(state.error)
    logErr('[whale][dsh] 启动失败', err && err.message)
    if (state.child === child) { state.child = null; state.pid = 0; state.runVersion = '' }
    broadcast()
  })
  child.on('exit', (code, signal) => {
    pushLog('dsh 已退出（code=' + code + (signal ? '，signal=' + signal : '') + '）')
    clearReady()
    // 端口被别的 dsh 占着时给个明确的处置提示（本插件只能结束自己启动的进程）
    if (code !== 0 && /EADDRINUSE|address already in use|端口|占用/i.test(state.log.slice(-6).join('\n'))) {
      state.error = '端口 ' + DSH_PORT + ' 已被占用：dsh 可能已在别处运行，请先结束它再启动'
      pushLog(state.error)
    }
    if (state.child === child) { state.child = null; state.pid = 0; state.stopping = false; state.runVersion = '' }
    state.exitCode = code
    state.exitAt = Date.now()
    // 关键推送：taskkill 完成后进程真正退出在这里发生，不广播挂件会一直显示「正在结束…」。
    // Windows 下 shell 包了一层 cmd，probe 缓存的监听 pid 与 state.pid 不同，
    // 先重新探测再推，避免把刚结束的进程短暂误报成「外部 dsh」（端口此刻若被真·外部 dsh
    // 接住，探测结果也会如实显示它）
    probePort(() => broadcast())
  })
  log('[whale][dsh] 已启动', { pid: state.pid, node: node.dir })
  return snapshot()
}

function stop(done) {
  syncConfig()
  const child = state.child
  if (!child) {
    // 没有本插件启动的进程：看 3080 上是不是别人（别的终端）跑的 dsh
    const other = portOccupiedByOther()
    if (other) {
      state.error = '端口 ' + DSH_PORT + ' 被 ' + other + ' 占用（不是 dsh），已中止结束操作'
      pushLog(state.error)
      if (done) done(snapshot())
      return snapshot()
    }
    const ext = externalPid()
    if (ext) {
      state.error = ''
      stopExternal(ext, done)
      return snapshot()
    }
    state.error = ''
    pushLog('dsh 未在运行')
    if (done) done(snapshot())
    return snapshot()
  }
  const pid = state.pid
  setCmd(WIN ? 'taskkill /pid ' + pid + ' /T /F' : 'kill -TERM -' + pid + '（进程组）')
  state.stopping = true
  clearReady()
  const onKillErr = (err) => {
    if (!err) return
    pushLog('结束命令返回错误：' + ((err && err.code !== undefined) ? err.code : (err && err.message) || err))
    // 进程可能已经自己退了 —— 那种情况 exit 事件会清状态并广播；确实没退掉才解除 stopping 报错，
    // 否则界面会永远停在「正在结束…」
    if (state.child === child) {
      state.stopping = false
      state.error = '结束失败：' + ((err && err.message) || err) + '（可重试，或以管理员身份运行 uTools）'
      broadcast()
    }
  }
  try {
    if (WIN) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => onKillErr(err))
    else {
      // 进程组整体结束（spawnCmd 用了 detached: true）
      try { process.kill(-pid, 'SIGTERM') } catch (err) { child.kill('SIGTERM') }
    }
  } catch (err) {
    logErr('[whale][dsh] 结束失败', err && err.message)
    state.stopping = false
    state.error = '结束失败：' + ((err && err.message) || err)
    broadcast()
  }
  if (done) done(snapshot())
  return snapshot()
}

// 重启：先结束（自己的或外部终端启的），等 3080 真正释放后再用当前配置启动
function restart(done) {
  syncConfig()
  const ext = externalPid()
  if (!state.child && !ext) { const s = start(); if (done) done(s); return }
  stop(() => {
    if (state.error) { broadcast(); if (done) done(snapshot()); return }
    let tries = 0
    const timer = setInterval(() => {
      tries++
      probePort((pid) => {
        if (!pid || tries > 20) {
          clearInterval(timer)
          const s = start()
          broadcast() // 重启的启动发生在数秒后，原来的请求回调早已结束，必须主动推
          if (done) done(s)
        }
      })
    }, 350)
  })
}

function update() {
  syncConfig()
  if (state.busy) { state.error = '正在' + (state.busy === 'versions' ? '查询版本' : state.busy === 'install' ? '安装' : '更新') + '中，请稍候'; return snapshot() }
  const node = resolveNode(state.nodeDir)
  if (!node) {
    state.error = '未找到 Node.js：请在设置页「DeepSeek Harness」里指定 Node.js 目录'
    pushLog(state.error)
    return snapshot()
  }
  if (!node.npm) {
    state.error = 'Node.js 目录里没有 npm（' + node.dir + '），请重新指定目录'
    pushLog(state.error)
    return snapshot()
  }
  state.error = ''
  // 已经是所选版本就别白跑一次 npm（固定版本可以直接判断；「更新前重新下载」时除外）。
  // 'newest' 不是真实版本号、不能直接比，要先解析成列表最大值；列表还没查过就解析不出，
  // 此时不拦（宁可白跑一次 npm，也不要误判成「已是最新」而什么都不装）。
  const cur = activeDsh()
  const want = state.version === NEWEST_VERSION ? maxVersion(state.versions && state.versions.list) : state.version
  if (state.version && want && cur && cur.version === want && !state.reinstall) {
    pushLog('已是最新：当前用 ' + cur.version + '，与所选版本一致，无需更新')
    return snapshot()
  }
  // 更新＝结束当前 dsh（含别的终端里启动的）→ 重新安装指定版本 → 原本在跑就用新版拉起来
  const wasRunning = !!state.child || !!externalPid()
  const doInstall = () => installDsh(() => {
    if (!wasRunning) return
    pushLog('正在用 ' + (installedVersion() || '新版') + ' 重新启动 dsh')
    start()
  }, 'update')
  if (!wasRunning) { doInstall(); return snapshot() }
  state.busy = 'update'
  pushLog('更新：先结束正在运行的 dsh（否则文件被占用，装不上）')
  stop(() => {
    if (state.error) {
      state.busy = ''
      pushLog('更新中止：' + state.error)
      broadcast()
      return
    }
    // 等 3080 真正释放（刚 taskkill 完可能还没退干净，文件也还被占用）
    let tries = 0
    const timer = setInterval(() => {
      tries++
      probePort((pid) => {
        if (!pid || tries > 20) { clearInterval(timer); doInstall() }
      })
    }, 350)
  })
  return snapshot()
}

// 把 dsh 装到插件自己的目录（npm install --prefix <userData>/dsh）
// done：装成功后回调；busyKind：界面文案（'install' 首次安装 / 'update' 更新）
function installDsh(done, busyKind) {
  syncConfig()
  const node = resolveNode(state.nodeDir)
  if (!node) {
    state.busy = ''
    state.error = '未找到 Node.js：请在设置页「DeepSeek Harness」里指定 Node.js 目录'
    pushLog(state.error)
    broadcast() // 多为「启动 → 自动安装」链路里走到这，原始请求回复的是「安装中」，这里要再推
    return snapshot()
  }
  if (!node.npm) {
    state.busy = ''
    state.error = 'Node.js 目录里没有 npm（' + node.dir + '），请重新指定目录'
    pushLog(state.error)
    broadcast()
    return snapshot()
  }
  // 已有全局安装就更新它（省一份重复下载），否则装到插件目录
  const g = globalDsh()
  const target = g ? 'global' : 'plugin'
  const before = g ? g.version : installedVersion()
  if (target === 'plugin' && state.reinstall) removeInstalled()
  const spec = pkgSpec()
  const args = target === 'global'
    ? ['install', '-g'].concat(fastArgs(), regArgs(), [spec])
    : ['install', '--prefix', dshPrefix()].concat(fastArgs(), regArgs(), [spec])
  state.busy = busyKind || 'install'
  setCmd(node.npm + ' ' + args.join(' '))
  pushLog((state.busy === 'update' ? '开始更新：' : '开始安装：') + spec + '（' + (target === 'global' ? '全局安装' : '插件目录') + '）')
  let triedElevate = false
  const afterVersion = () => (target === 'global' ? ((globalDsh() || {}).version || '') : installedVersion())
  const succeed = (after) => {
    state.busy = ''
    state.globalWritable = null // 装过之后重新判定可写性
    if (before && after !== before) pushLog('安装完成：' + before + ' → ' + after)
    else pushLog('安装完成：' + after)
    // done 通常是「用新版启动 dsh」：先跑回调再广播，推出去的快照就是「启动中/已运行」
    if (done) done()
    broadcast()
  }
  // 全局安装目录常只对管理员可写：先探测，不可写就直接提权，免得白跑一遍再抛 EPERM
  const globalBase = target === 'global' ? path.dirname(path.dirname(g.pkgDir)) : ''
  if (target === 'global' && WIN && !canWriteDir(globalBase)) {
    triedElevate = true
    pushLog('全局安装目录 ' + globalBase + ' 普通用户不可写（需要管理员权限），改用管理员权限安装：请在 UAC 弹窗点「是」')
    elevateInstall(node.npm, args, (elevErr, info) => {
      const v2 = afterVersion()
      if (!elevErr && v2) succeed(v2)
      else failInstall(info && info.code, elevateWhy(info))
    })
    return snapshot()
  }
  let child = null
  try { child = spawnCmd(node.npm, args, node) } catch (err) {
    state.busy = ''
    state.error = '安装失败：' + ((err && err.message) || err)
    pushLog(state.error)
    broadcast()
    return snapshot()
  }
  bindOutput(child)
  const fail = failInstall
  const finish = (code) => {
    const after = afterVersion()
    if (code === 0 && after) { succeed(after); return }
    // npm 的 EPERM/EACCES：Windows 上多半是「目录只对管理员可写」或「文件正被占用」
    const denied = /EPERM|EACCES|operation not permitted|拒绝访问/i.test(state.log.slice(-30).join('\n'))
    if (target === 'global' && denied && !triedElevate && WIN) {
      triedElevate = true
      state.busy = busyKind || 'install'
      pushLog('全局安装目录 ' + globalBase + ' 普通用户不可写，改用管理员权限重试：请在 UAC 弹窗点「是」')
      elevateInstall(node.npm, args, (elevErr, info) => {
        const v2 = afterVersion()
        if (!elevErr && v2) succeed(v2)
        else fail(info && info.code ? info.code : code, elevateWhy(info))
      })
      return
    }
    if (denied && target === 'global') {
      fail(code, '：全局安装目录需要管理员权限。可在 UAC 弹窗点「是」重试、以管理员身份运行 uTools，'
        + '或先卸载全局 dsh（npm uninstall -g ' + DSH_PKG + '）并删掉它，让插件装到插件数据目录')
      return
    }
    if (denied) fail(code, '：目标文件被占用或权限不足（可先「结束」dsh 再重试）')
    else fail(code, '')
  }
  function failInstall(code, why) {
    state.busy = ''
    state.error = '安装失败' + (code ? '（退出码 ' + code + '）' : '') + (why || '') + '：详见设置页日志'
    pushLog(state.error)
    broadcast()
  }
  child.on('error', (err) => {
    state.busy = ''
    state.error = '安装失败：' + ((err && err.message) || err)
    pushLog(state.error)
    broadcast()
  })
  child.on('exit', (code) => finish(code))
  return snapshot()
}

// ──────────────────────────────────────────────
// 插件市场要用的 npm 原语（装 / 卸单个第三方插件、列出装了哪些）
//
// ⚠️ 为什么不做成「一次装多个」：npm install a b c 里任何一个解析失败都会整批回滚，
//    而插件市场是逐个点的动作，逐条装才好把失败精确归到某个包上。
// ──────────────────────────────────────────────
// 包名白名单：只可能是 npm 包名，绝不允许 `-` 开头（否则会被当 npm 参数）、
// 也不允许带路径分隔符/空格/引号。目录是我们信任的来源，但它终究是远端数据 ——
// 这里挡住的是「被篡改的目录把 `--prefix` 之类的开关当包名塞进来」。
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
function validPkgName(name) {
  const n = String(name == null ? '' : name).trim()
  if (!n || n.length > 214) return ''
  return PKG_NAME_RE.test(n) ? n : ''
}
// ⚠️ install spec 白名单 —— 比包名宽，但**绝不是「放行任意字符串」**。
//    市场目录里实测有 48.6% 的条目 install spec 不是裸包名（github: / 远端 tgz），
//    只认包名等于把这近一半目录判死；但目录终究是远端数据，进命令行的关口必须收窄。
//    三种形态：npm 包名 / `github:owner/repo` / 远端 https 地址。
//    仍然禁止：`-` 开头（会被当开关）、空白与换行（拆成多个参数）、
//    引号与 shell 元字符（&& | ; ` $ ( ) < > 等）、反斜杠。
//    ⚠️ 不禁止 URL 里的 `?` 与 `=`（合法的 tgz 查询串），但用白名单字符集把它们限制在 URL 参数位置。
const PKG_SPEC_RE = /^(github:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(#[a-z0-9._/-]+)?|https?:\/\/[a-z0-9.-]+(:\d+)?\/[a-z0-9._~/-]*(\.tgz|\.tar\.gz)?(\?[a-z0-9._~%&=+-]*)?|(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$/i
function validPkgSpec(spec) {
  const s = String(spec == null ? '' : spec).trim()
  if (!s || s.length > 214) return ''
  return PKG_SPEC_RE.test(s) ? s : ''
}
// profile 与包名一样会进命令行，用同一条白名单（profile 名不允许 @ 与 /）
const PROFILE_RE = /^[a-z0-9][a-z0-9._-]*$/i
function validProfile(p) {
  const n = String(p == null ? '' : p).trim()
  return PROFILE_RE.test(n) ? n : ''
}
// profile 里的 package.json：npm 装进 profile 的结果就落在这里
// ⚠️ $DSH_HOME 的定位口径必须与 dsh-backup / diagnostics / dsh-dump 一致
// （env 优先 + 回退 ~/.dsh，且都要求目录实际存在）—— 不一致会出现
// 「快照备的是这个目录、npm 装的是那个目录」这种静默错位
function profileDir(profile) {
  const home = homeDir({ env: 'DSH_HOME', fallback: '.dsh' })
  const pf = validProfile(profile)
  if (!home || !pf) return ''
  return path.join(home, 'profiles', pf)
}
function profilePkgFile(profile) {
  const dir = profileDir(profile)
  return dir ? path.join(dir, 'package.json') : ''
}
// ⚠️ npm 装第三方包**不建快照也安全**：它只动 profile/package.json，
//    而 dsh-backup 的 PROFILE_FILES 白名单里正好有这个文件（见 lib/dsh-backup.js）。
// 已装映射：直接读 profile/package.json 的 dependencies。
// 读不到（文件不存在 = 还没装过任何插件）返回空表，这是正常空态不是错误。
function installedDeps(profile) {
  const file = profilePkgFile(profile)
  if (!file) return {}
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const d = j && j.dependencies && typeof j.dependencies === 'object' ? j.dependencies : {}
    const out = {}
    for (const k of Object.keys(d)) out[String(k)] = String(d[k] == null ? '' : d[k])
    return out
  } catch (err) { return {} }
}
// 实装版本表：node_modules/<name>/package.json 的 version（**不是** package.json 里的声明范围）。
//
// ⚠️ 为什么要单独读：profile/package.json 的 dependencies 存的是**声明范围**（`^0.5.11`），
//    拿它比「有没有新版」只能答「目录版本是否超出范围」——`^0.5.11` 装到 0.5.13 时
//    目录出 0.5.13 明明该提示，却因为「范围允许」被判成已最新。要比就得比实装版本。
//
// ⚠️ 为什么可以直接拼路径（不处理软链、不用 pnpm 的 .pnpm 目录）：本机实测 dsh 底层虽是 pnpm，
//    但 `node_modules/.modules.yaml` 里 `nodeLinker: hoisted`，包被**硬链接成实体目录**平铺在
//    顶层 `node_modules/<name>/`（`.pnpm` 下只有一个 lock.yaml，没有包目录）。所以
//    `<dir>/node_modules/<name>/package.json` 直读即可 —— 作用域包照写 `@scope/name`。
//    若将来 dsh 改用默认的 isolated 模式（顶层是软链），这里仍能读通：软链解引用后照样是实体文件。
//
// 返回 { [目录名]: version }。读不到的包**不编造**：调用方拿不到就退回范围判定。
function installedVersions(profile) {
  const dir = profileDir(profile)
  if (!dir) return {}
  const root = path.join(dir, 'node_modules')
  const out = {}
  const readOne = (name) => {
    const n = String(name == null ? '' : name).trim()
    // 目录名同样进路径，用包名白名单挡掉 `../` 这类穿越（目录名来自我们自己的代码，但仍收口）
    if (!n || !validPkgName(n)) return
    if (out[n] !== undefined) return
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, n, 'package.json'), 'utf8'))
      const v = j && j.version != null ? String(j.version).trim() : ''
      if (v) out[n] = v
    } catch (err) { /* 预期分支：包没装 / 没读权限，跳过即可 */ }
  }
  // 以 dependencies 的键为准（装了才有键），比遍历整个 node_modules 稳：
  // node_modules 里还有几百个传递依赖，全读一遍纯属浪费
  const deps = installedDeps(profile)
  for (const k of Object.keys(deps)) readOne(k)
  return out
}
// 跑一次 pnpm。返回 Promise<{ code, ok, out, err }>，**永不 reject**（调用方按 ok 判成败，
// 不必再包一层 catch）。输出同时进 dsh 的日志流，用户能在「日志」卡里看到 pnpm 到底说了什么。
//
// ⚠️ 为什么是 pnpm 而不是 npm（2026-09-24 实测）：profile 的依赖树是 pnpm 建的，
//    改动必须走同一条通道。用 npm 有两条死路：
//    ① `npm error code ERESOLVE`：`@openviking/dsh-memory-plugin@0.3.2` 声明了 3 个 peer
//       （dsh-llm / dsh-mcp-client / dsh-skill-filesystem），它们**由全局 dsh 提供**、不在
//       profile 的 node_modules 里。npm 只认 profile 自己的 node_modules → 判定 peer 不满足 → 直接中止。
//       报错信息具误导性（"Could not resolve dependency: @openviking/dsh-memory-plugin from the root project"），
//       根因不在那个包本身。
//    ② `--legacy-peer-deps` 能绕过①，但实测会**连带升/降 73 个无关包**（81 条变更行，
//       含 undici 8.10.2→7.29.0 降级、@antfu/install-pkg 2.0.1→1.1.0 降级）—— 绝不能用。
//    pnpm 走 `autoInstallPeers: false`（profile 的 pnpm-workspace.yaml 里写着），
//    peer 不满足只报 `[WARN] Issues with peer dependencies found`，不中止；实测只动目标包，其余 9 条依赖原封不动。
//
// ⚠️ 装什么由 spec 决定，`--dir` 只管目录：`pnpm add --dir <profile> <spec>` 与
//    `npm install --prefix <profile> <spec>` 语义一致，github: / tgz 两种形态 pnpm 同样原生支持。
function runPnpm(args) {
  return new Promise((resolve) => {
    syncConfig()
    const node = resolveNode(state.nodeDir)
    if (!node) {
      const why = '未找到 Node.js：请在设置页「DeepSeek Harness」里指定 Node.js 目录'
      pushLog('pnpm 调用失败：' + why)
      resolve({ code: -1, ok: false, out: '', err: why })
      return
    }
    const pnpm = resolvePnpm(node)
    if (!pnpm) {
      const why = '未找到 pnpm：profile 的依赖树由 pnpm 维护，装插件必须用它。'
        + '请先安装（npm i -g pnpm）或在设置页指定 Node.js 目录'
      pushLog('pnpm 调用失败：' + why)
      resolve({ code: -1, ok: false, out: '', err: why })
      return
    }
    setCmd(pnpm + ' ' + args.join(' '))
    let child = null
    try { child = spawnCmd(pnpm, args, node) } catch (err) {
      const why = (err && err.message) || String(err)
      pushLog('pnpm 调用失败：' + why)
      resolve({ code: -1, ok: false, out: '', err: why })
      return
    }
    let out = ''
    const grab = (d) => { out += String(d == null ? '' : d) }
    try { child.stdout && child.stdout.on('data', grab) } catch (err) {}
    try { child.stderr && child.stderr.on('data', grab) } catch (err) {}
    // 复用 bindOutput 让 pnpm 的输出进同一份日志（含 ANSI 清理与滚动缓冲）
    bindOutput(child)
    child.on('error', (err) => {
      const why = (err && err.message) || String(err)
      pushLog('pnpm 调用失败：' + why)
      resolve({ code: -1, ok: false, out: out, err: why })
    })
    child.on('exit', (code) => {
      // ⚠️ pnpm 在 stderr 上打 warning 是常态（peer 提示、deprecated），不能把 stderr 有内容当失败。
      // 唯一判据是退出码 —— dsh 主包安装那条链路也是这个口径
      resolve({ code: code == null ? -1 : code, ok: code === 0, out: out, err: '' })
    })
  })
}
// pnpm add 的公共参数
// ⚠️ `--reporter=append-only`：默认的默认 TTY 报告器会打满进度条与光标控制字符，在日志里刷屏
//    （我们已经把 ANSI 清掉了，剩下的进度条残渣仍会把关键报错挤出视野）
// ⚠️ 不加 `--ignore-scripts`：github / tgz 来源的插件靠 `prepare` 脚本在安装时构建，
//    忽略脚本等于装出一个空壳。构建该不该跑由 pnpm 的 allowBuilds 白名单裁决（拦下时
//    pnpm 会给出要写进 pnpm-workspace.yaml 的 key，由 settings.js 的 parseAllowBuilds 解读）
function pnpmArgs(dir) {
  return ['--dir', dir, '--reporter=append-only'].concat(regArgs())
}
// 装一个插件到 profile（pnpm add --dir <profile> <spec>）
//
// ⚠️ 这里接受的是「install spec」而不是裸包名：市场目录近半数条目的 spec 是
//    `github:owner/repo` 或远端 tgz 地址，pnpm 原生就支持这两种形态（会自己去 clone / 下载）。
//
// ⚠️ github/tgz 来源多一道 pnpm 的坎：这类插件靠 `prepare` 脚本在安装时构建，
//    **pnpm 默认拦截构建脚本**，失败信息里会给出一把带 commit hash 的 allowBuilds key。
//    installPluginPkg 只负责把原始输出**如实**回传，怎么解读由 settings.js / 界面决定。
function installPluginPkg(profile, spec) {
  const pf = validProfile(profile)
  const s = validPkgSpec(spec)
  if (!pf) return Promise.resolve({ code: -1, ok: false, out: '', err: 'profile 名不合法：' + profile })
  if (!s) return Promise.resolve({ code: -1, ok: false, out: '', err: '包名不合法：' + spec })
  const dir = profileDir(pf)
  return runPnpm(['add'].concat(pnpmArgs(dir), [s]))
}
// 从 profile 卸一个插件（pnpm remove --dir <profile> <pkg>）
// ⚠️ 卸载仍只认**已装依赖的键名**（validPkgName），不用 spec：
//    package.json 的 dependencies 键就是 pnpm 归一后的名字，用 spec 去 remove 反而匹配不上
function uninstallPluginPkg(profile, pkg) {
  const pf = validProfile(profile)
  const p = validPkgName(pkg)
  if (!pf) return Promise.resolve({ code: -1, ok: false, out: '', err: 'profile 名不合法：' + profile })
  if (!p) return Promise.resolve({ code: -1, ok: false, out: '', err: '包名不合法：' + pkg })
  const dir = profileDir(pf)
  return runPnpm(['remove'].concat(pnpmArgs(dir), [p]))
}

// 版本列表落库缓存：重载插件后不用重新查询也能在下拉里选到具体版本
function loadVersions() {
  if (state.versionsLoaded) return
  state.versionsLoaded = true
  try {
    const c = utools.dbStorage.getItem(K.dshVersions)
    if (c && typeof c === 'object' && Array.isArray(c.list) && c.list.length) {
      state.versions = { at: Number(c.at) || 0, latest: String(c.latest || ''), list: c.list.map(String).slice(-60) }
    }
  } catch (err) {}
}
function saveVersions() {
  try { utools.dbStorage.setItem(K.dshVersions, state.versions) } catch (err) { logErr('[whale][dsh] 写版本缓存失败', err && err.message) }
}

// 查询可用版本列表（npm view <pkg> versions --json），结果缓存在 state.versions
function listVersions() {
  syncConfig()
  if (state.busy) { state.error = '正在' + (state.busy === 'versions' ? '查询版本' : state.busy === 'install' ? '安装' : '更新') + '中，请稍候'; return snapshot() }
  const node = resolveNode(state.nodeDir)
  const exe = node && node.npm
  if (!exe) {
    state.error = '未找到 npm：请在设置页指定 Node.js 目录'
    pushLog(state.error)
    return snapshot()
  }
  state.error = ''
  state.busy = 'versions'
  // 一次拿到全部版本 + latest 标签（最新发布的不一定是 latest 标签指向的稳定版）
  const args = ['view', DSH_PKG, 'versions', 'dist-tags', '--json'].concat(regArgs())
  setCmd(exe + ' ' + args.join(' '))
  let out = ''
  let child = null
  try { child = spawnCmd(exe, args, node) } catch (err) {
    state.busy = ''
    state.error = '查询版本失败：' + ((err && err.message) || err)
    pushLog(state.error)
    return snapshot()
  }
  try { child.stdout && child.stdout.on('data', (d) => { out += String(d) }) } catch (err) {}
  bindOutput(child)
  child.on('error', (err) => {
    state.busy = ''; state.error = '查询版本失败：' + ((err && err.message) || err); pushLog(state.error)
    broadcast()
  })
  child.on('exit', (code) => {
    state.busy = ''
    if (code !== 0) {
      state.error = '查询版本失败（退出码 ' + code + '），详见设置页日志'
      pushLog(state.error)
      broadcast()
      return
    }
    let list = []
    let tag = ''
    try {
      const j = JSON.parse(String(out).trim() || '{}')
      if (Array.isArray(j)) list = j.map(String)
      else {
        if (Array.isArray(j.versions)) list = j.versions.map(String)
        const tags = j['dist-tags'] && typeof j['dist-tags'] === 'object' ? j['dist-tags'] : {}
        tag = tags.latest ? String(tags.latest) : ''
      }
    } catch (err) { list = [] }
    if (!list.length && !tag) {
      state.error = '没有查到可用版本'
      pushLog(state.error)
      broadcast()
      return
    }
    state.versions = {
      at: Date.now(),
      latest: tag || list[list.length - 1] || '',
      list: list.slice(-60),
    }
    saveVersions()
    pushLog('可用版本 ' + list.length + ' 个，latest 标签：' + (state.versions.latest || '未知'))
    broadcast() // 版本列表 / 「有新版本」提示落库后推一次
  })
  return snapshot()
}

// 打开 dsh 的 Web UI：优先用捕获到的带 token 地址（否则只会显示 authentication required）
function openWeb() {
  const url = state.webUrl || DSH_URL
  try {
    utools.shellOpenExternal(url)
    log('[whale][dsh] 打开页面', url)
    return url
  } catch (err) {
    logErr('[whale][dsh] 打开 Web UI 失败', err && err.message)
    return ''
  }
}

// ── 维护操作（设置页按钮）──
// 清空内存日志
function clearLog() {
  state.log = []
  state.error = ''
  pushLog('日志已清空')
  return snapshot()
}
// 删除插件目录里的那份 dsh（有全局安装时本来就用不到它）
function removePluginDsh() {
  const act = activeDsh()
  if (state.child && act && act.source === 'plugin') {
    state.error = '正在运行插件目录里的 dsh，请先「结束」再删除'
    pushLog(state.error)
    return snapshot()
  }
  const dir = path.join(dshPrefix(), 'node_modules')
  state.error = ''
  if (!fs.existsSync(dir)) {
    pushLog('插件目录里没有 dsh，无需删除')
    return snapshot()
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    pushLog('已删除插件目录里的 dsh：' + dir)
  } catch (err) {
    state.error = '删除失败（文件被占用？）：' + ((err && err.message) || err)
    pushLog(state.error)
  }
  state.installed = ''
  return snapshot()
}
// npx 缓存根目录候选（只用于清理历史副本；插件自己已经不用 npx）
function npxCacheBases() {
  const out = []
  const add = (d) => { if (d && out.indexOf(d) < 0) out.push(d) }
  if (process.env.npm_config_cache) add(path.join(process.env.npm_config_cache, '_npx'))
  if (WIN && process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))
  if (process.env.XDG_CACHE_HOME) add(path.join(process.env.XDG_CACHE_HOME, 'npm', '_npx'))
  add(path.join(os.homedir(), '.npm', '_npx'))
  add(path.join(os.homedir(), '.cache', 'npm', '_npx'))
  return out
}
// 清理 npx 缓存里含 @deepseek-ai/dsh 的 <hash> 目录（以前的版本留下的，一次性回收；不动其它包）
function cleanNpxCaches() {
  let n = 0
  state.error = ''
  for (const base of npxCacheBases()) {
    let names = []
    try { names = fs.readdirSync(base) } catch (err) { continue }
    for (const name of names) {
      const dir = path.join(base, name)
      const hasDsh = fs.existsSync(path.join(dir, 'node_modules', DSH_PKG, 'package.json'))
      // 之前测过、只剩锁文件的空目录也一并清掉
      const empty = !fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(dir, 'concurrency.lock'))
      if (!hasDsh && !empty) continue
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        n++
        pushLog('已删除 ' + dir)
      } catch (err) {
        pushLog('删除失败（可能正被 npx 使用）：' + dir + ' —— ' + ((err && err.message) || err))
      }
    }
  }
  pushLog(n ? ('已清理 ' + n + ' 个 npx 缓存目录') : '没有需要清理的 npx 缓存目录')
  return snapshot()
}

// uTools 退出（isKill=true）且用户没勾「保留」时结束 dsh，避免留下孤进程占着 3080
function stopOnQuit() {
  syncConfig()
  if (state.keepAlive || !state.child) return
  pushLog('uTools 退出，结束 dsh')
  stop()
}

// 面向 UI 的状态快照（含日志）
function snapshot() {
  syncConfig()
  loadVersions()
  const node = resolveNode(state.nodeDir)
  const gv = globalDsh() // 全局安装（有就用它，省一份重复下载）
  const act = gv || (cliEntry() ? { source: 'plugin', version: installedVersion() } : null)
  const installed = installedVersion()
  // 全局目录是否可写：只在第一次快照（以及安装后）真试一次，之后用缓存
  if (gv && state.globalWritable === null) {
    state.globalWritable = canWriteDir(path.dirname(path.dirname(gv.pkgDir)))
  }
  return {
    running: !!state.child,
    stopping: !!state.stopping,
    busy: state.busy,
    pid: state.pid,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    exitAt: state.exitAt,
    keepAlive: state.keepAlive,
    url: DSH_URL,
    port: DSH_PORT,
    nodeDir: node ? node.dir : '',
    nodeVersion: node ? nodeVersion(node) : '',
    nodeAuto: !state.nodeDir,
    found: !!node,
    error: state.error,
    lastCmd: state.lastCmd,
    log: state.log.join('\n'),
    // dsh 相关配置（界面回显）
    registry: state.registry,
    version: state.version,
    resolved: act ? act.version : '',
    // 已查询到目标版本且比当前用的新（界面提示「有新版本」）。
    // 目标版本随所选版本变：固定版本时按原先只比 latest 的口径不变，'newest' 时改比列表最大值。
    hasUpdate: !!(act && targetVersion() && isNewer(targetVersion(), act.version)),
    // 用哪一份：'global'（全局安装，优先）/ 'plugin'（插件目录）/ ''（都没有）
    source: act ? act.source : '',
    globalVersion: gv ? gv.version : '',
    globalDir: gv ? gv.pkgDir : '',
    // 全局安装目录是否可写（false 时「更新」会弹一次 UAC 提权）
    globalWritable: !!gv && state.globalWritable !== false,
    reinstall: state.reinstall,
    prefix: dshPrefix(),
    versions: state.versions,
    installed: installed,
    // 本次启动用的版本 + 是否需要重启才生效（目录里已是另一个版本）
    runVersion: state.runVersion,
    needsRestart: !!state.child && !!state.runVersion && !!act && act.version !== state.runVersion,
    // 3080 上的进程探测：识别别的终端里跑的 dsh。
    // ⚠️ 不能再拿 `probe.busy` 当「外部实例存在」的判据：那是异步探测的工程状态，不是业务结论。
    // 2026-09-22 实测：插件自己启动 dsh 后，watchReady 每 1.2s 探一次端口，probe.busy 长期为 true，
    // 界面于是显示「外部 dsh · pid 0」——启动按钮被禁用、提示还写着「别的终端启动的」。
    // externalPid() 读的是已算好的 probe 结果（未算好时保守返回 0），是否 busy 交给 extBusy 表达。
    external: !!externalPid(),
    externalPid: externalPid() || 0,
    externalName: probe.pid && probe.pid !== state.pid && !probe.selfOwned ? probe.name : '',
    // 监听 3080 的进程是本插件启动的那份（含父链上溯：Windows 下 spawn 有 cmd 中间层，
    // 监听者是插件子进程的**子进程**，单比 pid 会认不出来）
    selfOwned: !!probe.selfOwned,
    // 占端口的进程命令行能否证明「是 dsh」：true/false/null（null = 拿不到命令行，判不出来）。
    // C5 靠它决定报 error（确认是别的程序）还是 warning（无法确认）—— D26
    portDsh: looksLikeDsh(probe.cmdline),
    // **谁在监听这个端口**（本插件启的 / 外部的 / 别的程序，都算）。
    // ⚠️ 不能拿 externalPid 代替它：那是「外部 dsh」的 pid，本插件自己启的那份恒为 0。
    // 2026-09-22 实测：插件启动 dsh 后 externalPid=0、portOther=''，C5 于是把 pid 当 0
    // 判成「3080 空闲（无进程监听）」—— 状态卡同时显示「运行中 · pid 26916」，自相矛盾。
    // 区分「有没有人占」与「占的人是不是外人」是两件事，必须两个字段。
    portPid: (probe.busy ? 0 : probe.pid) || 0,
    portName: probe.busy ? '' : probe.name,
    portCmdlineKnown: !!probe.cmdlineKnown,
    extBusy: !!probe.busy,
    portOther: portOccupiedByOther(),
    // 本插件启动的进程是否已经能提供服务（3080 开始监听）
    ready: state.ready,
    readyAt: state.readyAt,
    // dsh 打印的带 token 页面地址（浏览器认证用）
    webUrl: state.webUrl,
  }
}

// 轻量进度快照：只回「当前命令行 + 日志尾部」，专供安装/更新这类**长跑操作**做进度回显。
//
// ⚠️ 为什么不复用 snapshot()：那个函数会顺带跑 resolveNode / globalDsh / canWriteDir，
//    还得靠 setCmd 之后的状态；更要紧的是**它不探端口**，但界面若走 dshStatus() 那条通道，
//    每次调用都会触发一次 probePort（起一个 netstat 子进程）。安装期间前端要 1Hz 刷新，
//    等于几分钟内白起几百次 netstat —— 与进度显示毫无关系。
//    这里只读两块内存里的数据（state.lastCmd / state.log），零子进程、零磁盘。
function progress() {
  return {
    lastCmd: state.lastCmd || '',
    log: state.log.join('\n'),
  }
}

module.exports = {
  DSH_PORT,
  DSH_URL,
  DSH_PKG,
  configure,
  start,
  stop,
  restart,
  update,
  listVersions,
  clearLog,
  removePluginDsh,
  cleanNpxCaches,
  openWeb,
  stopOnQuit,
  probePort,
  snapshot,
  // 轻量进度（安装/更新期间前端 1Hz 刷新用），只读内存、不起子进程
  progress,
  onChange,
  resolveNode,
  // 定位 pnpm 可执行文件（profile 的依赖树由 pnpm 维护，装/卸插件必须走它）。
  // 导出：单测要验证「找不到 pnpm 时返回空串、不偷偷退回 npm」这条边界
  resolvePnpm,
  // 提权用 powershell 绝对路径（hosts.js 的 UAC 写 hosts 复用）
  psExe,
  // 校验某个目录里是否有 node 可执行文件（设置页选择目录时用）
  nodeInDir(dir) { return !!hasNode(dir) },
  // 一次性 CLI 读取（lib/dsh-dump.js）复用的底层能力：这些都是通用工具，
  // 不是 dsh 的进程管理语义，单独复制一份只会造成 decodeOut/spawnCmd 两处漂移
  decodeOut,
  spawnCmd,
  // cmd /s /c 这条线的参数引号规则（纯函数）。导出来单测：
  // 2026-09-24 命令名被引号错配吃掉的 bug 就出在这里，必须有回归钉住
  quoteCmdArg,
  // dsh CLI 入口与「实际用哪一份」的定位（dump 要拿 bin.js 绝对路径）
  activeDsh,
  // 插件市场复用的 pnpm 原语（settings.js 编排安装/卸载）：
  // 包名/profile 白名单是纯函数，单测直接喂样例 —— 它们挡的是「远端目录里的字符串进命令行」
  validPkgName,
  validPkgSpec,
  validProfile,
  profilePkgFile,
  installedDeps,
  // 实装版本表（node_modules 里的真实 version，与声明范围区分）——市场「检查更新」用它比对
  installedVersions,
  installPluginPkg,
  uninstallPluginPkg,
  // pnpm add 的公共参数（纯函数，单测钉住 --dir/--reporter 与 --registry 的拼装顺序）
  pnpmArgs,
  // 登录 shell 输出的路径行提取（纯函数，单测直接喂样例）
  lastPathLine,
  // 命令行能否证明「这是 dsh」（纯函数，三态：true/false/null）。
  // 单测直接喂样例 —— 这条判据的错法很隐蔽（旧版只看进程名，任何 node.exe 都算 dsh），
  // 必须钉住「裸 node 命令行 → false」而不是等线上漏报真占用
  looksLikeDsh,
  // 父链上溯（纯函数，单测喂邻接表）：判断 pid 是否为 self 的后代。
  // 修的是「插件启动的 dsh 被误报成外部进程」—— Windows 下 spawn 有 cmd 中间层，
  // 监听 3080 的是插件的**孙进程**，单比 pid 认不出自己人
  isDescendantOf,
  // 探测轮次号的白盒入口（仅供单测）：诊断点「强制重跑」时若蹭上 watchReady
  // 正在跑的旧轮，会拿到 dsh 尚未 bind 时的空结果 —— 这两个钩子钉住「旧轮不许写 probe」
  __probeState() { return { gen: probe.gen, busy: probe.busy, pid: probe.pid, selfOwned: probe.selfOwned, waiters: probe.waiters.length } },
  __isStale,
}
