/*
 * DeepSeek Harness（dsh）进程管理（CommonJS）。
 *
 * 面向开发者用户：在挂件菜单/设置页里 启动 / 重启 / 结束 / 更新 dsh，并打开它的 Web UI。
 *  - npx 模式：npx -y @deepseek-ai/dsh@latest web --no-open（不污染全局，「更新」即重新拉最新）
 *  - 全局模式：dsh web --no-open（需先 npm i -g @deepseek-ai/dsh，「更新」走 npm i -g …@latest）
 * Node.js 目录：优先用户自定义目录，其次 PATH，最后常见安装位置（含 nvm）。
 */
const { spawn, execFile, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { log, logErr } = require('./log')
const { readConfig } = require('./store')

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
  mode: 'npx',        // npx | global
  nodeDir: '',        // 用户自定义 Node.js 目录；'' = 自动探测
  keepAlive: false,   // true = uTools 退出后不结束 dsh
  busy: '',           // '' | 'update'
  error: '',
  exitCode: null,
  exitAt: 0,
  log: [],
  lastCmd: '',        // 最近执行的命令（界面展示 + 日志里以 $ 开头记一行）
  registry: '',       // npm 注册源（'' = 官方 registry.npmjs.org）
  version: '',        // '' = @latest；否则固定版本号
  cleanNpx: false,    // 更新前清理 npx 缓存（~/.npm/_npx）
  versions: { at: 0, latest: '', list: [] }, // 「查询版本」结果
  extPid: 0,          // 监听 3080 的外部 dsh 进程（非本插件启动）
  extName: '',
  ready: false,       // 本次启动后 3080 是否已就绪（npx 首次要下载，起来要一会儿）
  readyAt: 0,
  readyTimer: null,
  webUrl: '',         // dsh 打印的带 token 的页面地址（浏览器认证用），停止后失效
  tail: '',           // 输出滚动缓冲：token 地址可能被拆到两个 data 事件里
  versionCache: {},   // dir → node -v 结果
  resolveCache: { key: '\u0000', value: null },
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
  state.resolveCache = { key: key, value: found }
  return found
}
// 全局安装的 dsh 可执行文件（node 目录 / 上级目录 / npm 全局 bin）
function dshBin(node) {
  const cands = []
  if (node) { cands.push(node.dir, path.dirname(node.dir)) }
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm'))
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'npm'))
  if (!WIN) cands.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  for (const d of cands) {
    const p = findExe(d, 'dsh')
    if (p) return p
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
// Windows 下 npm/npx/dsh 都是 .cmd，必须经 shell 执行；路径可能含空格，这里统一加引号
function quote(s) {
  const v = String(s)
  return WIN ? '"' + v.replace(/"/g, '\\"') + '"' : "'" + v.replace(/'/g, "'\\''") + "'"
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
  if (WIN) return spawn(quote(exe) + ' ' + args.map(quote).join(' '), Object.assign(options, { shell: true }))
  // POSIX 下独立进程组，结束时可整组杀掉（npx/dsh 会有子进程）
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
const probe = { pid: 0, name: '', at: 0, busy: false, waiters: [] }
function isDshName(name) { return /^(node|dsh)(\.exe)?$/i.test(String(name || '').trim()) }
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
// 提权结束用的 powershell 绝对路径（找不到就退回 PATH 里的 powershell）
function psExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try { if (fs.existsSync(p)) return p } catch (err) {}
  return 'powershell'
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
function flushProbe(cb) {
  const ws = probe.waiters
  probe.waiters = []
  for (const w of ws) { try { w(probe.pid) } catch (err) {} }
  if (cb) { try { cb(probe.pid) } catch (err) {} }
}
// 探测结果缓存在 probe 里，供同步的 snapshot()/stop() 使用；cb(pid) 在探测完成后回调
function probePort(cb) {
  if (probe.busy) { if (cb) probe.waiters.push(cb); return }
  probe.busy = true
  const exe = WIN ? 'netstat' : 'lsof'
  const args = WIN ? ['-ano', '-p', 'tcp'] : ['-nP', '-iTCP:' + DSH_PORT, '-sTCP:LISTEN', '-t']
  execFile(exe, args, { timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    const pid = err ? 0 : parsePortPid(stdout)
    if (!pid) {
      probe.busy = false; probe.pid = 0; probe.name = ''; probe.at = Date.now()
      flushProbe(cb)
      return
    }
    processName(pid, (name) => {
      probe.busy = false; probe.pid = pid; probe.name = name; probe.at = Date.now()
      flushProbe(cb)
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
// 外部 dsh：3080 被占用、不是本插件的子进程、且进程名像 node/dsh
function externalPid() {
  return probe.pid && probe.pid !== state.pid && isDshName(probe.name) ? probe.pid : 0
}
// 非 dsh 进程占着 3080 时不允许结束（避免误杀别的程序）
function portOccupiedByOther() {
  return !!probe.pid && probe.pid !== state.pid && !isDshName(probe.name) ? probe.name || '未知进程' : ''
}
// 删除 npx 缓存目录（对应手工的 rm -rf ~/.npm/_npx，强制重新拉取）
function cleanNpxCache() {
  const dir = path.join(os.homedir(), '.npm', '_npx')
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    pushLog('已清理 npx 缓存：' + dir)
    return true
  } catch (err) {
    pushLog('清理 npx 缓存失败（可能有 npx 正在运行）：' + ((err && err.message) || err))
    return false
  }
}

// ──────────────────────────────────────────────
// 对外操作
// ──────────────────────────────────────────────
function configure(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const mode = c.dshMode === 'global' ? 'global' : 'npx'
  const nodeDir = typeof c.dshNodeDir === 'string' ? c.dshNodeDir.trim() : ''
  const registry = typeof c.dshRegistry === 'string' ? c.dshRegistry.trim() : ''
  const version = typeof c.dshVersion === 'string' ? c.dshVersion.trim() : ''
  if (nodeDir !== state.nodeDir) state.resolveCache = { key: '\u0000', value: null }
  if (mode !== state.mode || nodeDir !== state.nodeDir) log('[whale][dsh] 配置变更', { mode, nodeDir: nodeDir || '(自动)' })
  state.mode = mode
  state.nodeDir = nodeDir
  state.keepAlive = c.dshKeepAlive === true
  state.registry = registry
  state.version = version
  state.cleanNpx = c.dshCleanNpx === true
}
// 每次操作前从配置同步（设置页/挂件菜单都可能改），避免漏掉某个调用点
function syncConfig() {
  try { configure(readConfig()) } catch (err) { logErr('[whale][dsh] 读取配置失败', err && err.message) }
}
// 包名（@latest 或指定版本）与注册源参数
function pkgSpec() { return DSH_PKG + '@' + (state.version || 'latest') }
function regArgs() { return state.registry ? ['--registry=' + state.registry] : [] }
// npm/npx 提速参数：跳过审计与赞助请求；锁定版本时可优先命中缓存（@latest 不能加，否则可能拿到过期的 latest）
function fastArgs() {
  const out = ['--no-audit', '--no-fund']
  if (state.version) out.push('--prefer-offline')
  return out
}
// 启动后就绪检测：3080 真正开始监听才算可用（npx 首次下载可能几十秒）
function watchReady() {
  if (state.readyTimer) clearInterval(state.readyTimer)
  let ticks = 0
  state.readyTimer = setInterval(() => {
    ticks++
    if (!state.child || ticks > 150) {
      clearInterval(state.readyTimer)
      state.readyTimer = null
      return
    }
    probePort((pid) => {
      if (!pid) return
      state.ready = true
      state.readyAt = Date.now()
      const sec = state.startedAt ? ((state.readyAt - state.startedAt) / 1000).toFixed(1) + 's' : '未知'
      pushLog('3080 已就绪（启动用时 ' + sec + '）')
      if (state.readyTimer) { clearInterval(state.readyTimer); state.readyTimer = null }
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
  let exe = ''
  let args = []
  if (state.mode === 'global') {
    exe = dshBin(node)
    if (!exe) {
      state.error = '未找到全局 dsh：请先执行 npm i -g ' + DSH_PKG + '，或把运行方式改成 npx'
      pushLog(state.error)
      return snapshot()
    }
    args = ['web', '--no-open']
  } else {
    if (!node.npx) {
      state.error = 'Node.js 目录里没有 npx（' + node.dir + '），请重新指定目录'
      pushLog(state.error)
      return snapshot()
    }
    exe = node.npx
    // npx -y [--no-audit --no-fund --prefer-offline] [--registry=镜像] @deepseek-ai/dsh@<版本|latest> web --no-open
    args = ['-y'].concat(fastArgs(), regArgs(), [pkgSpec(), 'web', '--no-open'])
  }
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
    if (state.child === child) { state.child = null; state.pid = 0 }
  })
  child.on('exit', (code, signal) => {
    pushLog('dsh 已退出（code=' + code + (signal ? '，signal=' + signal : '') + '）')
    clearReady()
    // 端口被别的 dsh 占着时给个明确的处置提示（本插件只能结束自己启动的进程）
    if (code !== 0 && /EADDRINUSE|address already in use|端口|占用/i.test(state.log.slice(-6).join('\n'))) {
      state.error = '端口 ' + DSH_PORT + ' 已被占用：dsh 可能已在别处运行，请先结束它再启动'
      pushLog(state.error)
    }
    if (state.child === child) { state.child = null; state.pid = 0; state.stopping = false }
    state.exitCode = code
    state.exitAt = Date.now()
  })
  log('[whale][dsh] 已启动', { pid: state.pid, mode: state.mode, node: node.dir })
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
  try {
    if (WIN) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
    else {
      // 进程组整体结束（spawnCmd 用了 detached: true）
      try { process.kill(-pid, 'SIGTERM') } catch (err) { child.kill('SIGTERM') }
    }
  } catch (err) {
    logErr('[whale][dsh] 结束失败', err && err.message)
    state.stopping = false
    state.error = '结束失败：' + ((err && err.message) || err)
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
    if (state.error) { if (done) done(snapshot()); return }
    let tries = 0
    const timer = setInterval(() => {
      tries++
      probePort((pid) => {
        if (!pid || tries > 20) {
          clearInterval(timer)
          const s = start()
          if (done) done(s)
        }
      })
    }, 350)
  })
}

function update() {
  syncConfig()
  if (state.busy) { state.error = '正在' + (state.busy === 'versions' ? '查询版本' : '更新') + '中，请稍候'; return snapshot() }
  const node = resolveNode(state.nodeDir)
  if (!node) {
    state.error = '未找到 Node.js：请在设置页「DeepSeek Harness」里指定 Node.js 目录'
    pushLog(state.error)
    return snapshot()
  }
  const isGlobal = state.mode === 'global'
  const exe = isGlobal ? node.npm : node.npx
  const spec = pkgSpec()
  const args = isGlobal ? ['i', '-g'].concat(fastArgs(), regArgs(), [spec]) : ['-y'].concat(fastArgs(), regArgs(), [spec, '--version'])
  if (!exe) {
    state.error = (isGlobal ? '未找到 npm' : '未找到 npx') + '：请重新指定 Node.js 目录'
    pushLog(state.error)
    return snapshot()
  }
  state.error = ''
  state.busy = 'update'
  if (state.cleanNpx) cleanNpxCache()
  setCmd(exe + ' ' + args.join(' '))
  let child = null
  try { child = spawnCmd(exe, args, node) } catch (err) {
    state.busy = ''
    state.error = '更新失败：' + ((err && err.message) || err)
    pushLog(state.error)
    return snapshot()
  }
  bindOutput(child)
  const finish = (code) => {
    state.busy = ''
    if (code === 0) {
      pushLog((isGlobal ? '更新完成' : '已拉取 ' + spec) + '（重启 dsh 后生效）')
    } else if (isGlobal) {
      state.error = '更新失败（退出码 ' + code + '），详见设置页日志'
      pushLog(state.error)
    } else {
      // npx 模式下这条命令只是为了把包拉进缓存，退出码非 0 不代表更新失败
      pushLog('更新告警（退出码 ' + code + '）：包已尝试拉取；npx 模式每次启动都会用 ' + spec)
    }
  }
  child.on('error', (err) => { state.busy = ''; state.error = '更新失败：' + ((err && err.message) || err); pushLog(state.error) })
  child.on('exit', (code) => finish(code))
  return snapshot()
}

// 查询可用版本列表（npm view <pkg> versions --json），结果缓存在 state.versions
function listVersions() {
  syncConfig()
  if (state.busy) { state.error = '正在' + (state.busy === 'update' ? '更新' : '查询版本') + '中，请稍候'; return snapshot() }
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
  child.on('error', (err) => { state.busy = ''; state.error = '查询版本失败：' + ((err && err.message) || err); pushLog(state.error) })
  child.on('exit', (code) => {
    state.busy = ''
    if (code !== 0) {
      state.error = '查询版本失败（退出码 ' + code + '），详见设置页日志'
      pushLog(state.error)
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
      return
    }
    state.versions = {
      at: Date.now(),
      latest: tag || list[list.length - 1] || '',
      list: list.slice(-60),
    }
    pushLog('可用版本 ' + list.length + ' 个，latest 标签：' + (state.versions.latest || '未知'))
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
  const node = resolveNode(state.nodeDir)
  const bin = state.mode === 'global' ? dshBin(node) : ''
  return {
    running: !!state.child,
    stopping: !!state.stopping,
    busy: state.busy,
    pid: state.pid,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    exitAt: state.exitAt,
    mode: state.mode,
    keepAlive: state.keepAlive,
    url: DSH_URL,
    port: DSH_PORT,
    nodeDir: node ? node.dir : '',
    nodeVersion: node ? nodeVersion(node) : '',
    nodeAuto: !state.nodeDir,
    found: !!node,
    dshFound: state.mode === 'global' ? !!bin : true,
    error: state.error,
    lastCmd: state.lastCmd,
    log: state.log.join('\n'),
    // 运行方式相关配置（界面回显）
    registry: state.registry,
    version: state.version,
    cleanNpx: state.cleanNpx,
    versions: state.versions,
    // 3080 上的进程探测：识别别的终端里跑的 dsh
    external: !!externalPid(),
    externalPid: externalPid() || 0,
    externalName: probe.pid && probe.pid !== state.pid ? probe.name : '',
    extBusy: !!probe.busy,
    portOther: portOccupiedByOther(),
    // 本插件启动的进程是否已经能提供服务（3080 开始监听）
    ready: state.ready,
    readyAt: state.readyAt,
    // dsh 打印的带 token 页面地址（浏览器认证用）
    webUrl: state.webUrl,
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
  openWeb,
  stopOnQuit,
  probePort,
  snapshot,
  resolveNode,
  // 校验某个目录里是否有 node 可执行文件（设置页选择目录时用）
  nodeInDir(dir) { return !!hasNode(dir) },
}
