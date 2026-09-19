/*
 * 日志门控（CommonJS）。
 *
 * 约定：业务失败（网络/存储/IPC/窗口创建）用 logErr 留痕；
 *      Electron 可选 API 不存在或窗口已销毁属预期分支，用空 catch 静默跳过。
 *
 * 重要：uTools 关闭插件窗口会直接结束插件进程（勾选「退出到后台立即结束运行」时必然如此），
 * 控制台内容随进程一起丢失，导致「关闭设置窗口 → 挂件消失」这类生命周期问题无法排查。
 * 因此日志除控制台外，同步追加到固定文件（appendFileSync，进程被杀也不丢），事后可查：
 *   %TEMP%\whale-debug.log
 *
 * DEV 恒为 true（不再取 utools.isDev()）：打包版与开发版行为完全一致 —— 同样的日志落盘、
 * 挂件 DevTools、设置页「诊断日志」入口。代价是正式安装的插件也会持续写日志，属有意为之：
 * 普通用户遇到问题时才有日志可查（原先打包版无任何取证手段）。
 *
 * 日志定期清理（两重，防 %TEMP% 无限增长）：
 *  - 体积：写入时发现文件超过 MAX_BYTES 就截断，只留末尾 KEEP_BYTES；
 *  - 日期：模块加载（即插件启动）时若文件最后修改时间超过 KEEP_DAYS 天，直接清空重建。
 * 两者都必须做在写入路径上 —— 日志是 appendFileSync 同步写的，进程随时可能被 uTools 结束，
 * 独立定时器并不可靠（定时器还没触发进程就没了）。
 */
const DEV = true

// 单文件体积上限 1MB，超出后保留末尾 200KB。
// 按每行约 120 字节估算，200KB ≈ 1700 行，足够回溯最近一段时间的生命周期与报错。
const MAX_BYTES = 1024 * 1024
const KEEP_BYTES = 200 * 1024
// 启动时按日期清理：最后修改时间超过 7 天视为陈旧日志，清空重建（长期不用再打开的场景）
const KEEP_DAYS = 7
const KEEP_MS = KEEP_DAYS * 24 * 3600 * 1000

// 日志落盘路径：优先系统临时目录（用户易找到：Win+R 输入 %TEMP%\whale-debug.log）
const LOG_FILE = (function () {
  try {
    const path = require('path')
    let dir = ''
    try { dir = utools.getPath('temp') } catch (err) {}
    if (!dir) { try { dir = utools.getPath('userData') } catch (err) {} }
    return dir ? path.join(dir, 'whale-debug.log') : ''
  } catch (err) { return '' }
})()

let fsMod = null
try { fsMod = require('fs') } catch (err) { fsMod = null }

// 已写入字节数的乐观计数：避免每次 log() 都 statSync（磁盘 IO + 大文件时开销明显）。
// 只在计数逼近上限时才真去 stat 复核，防止长时间运行后计数与磁盘实际值漂移。
let bytesWritten = 0

// 启动时按日期清理：陈旧日志直接清空（保留文件本身，便于用户原地查看新日志）
function purgeIfStale() {
  if (!LOG_FILE || !fsMod) return
  try {
    const st = fsMod.statSync(LOG_FILE)
    if (Date.now() - st.mtimeMs > KEEP_MS) {
      fsMod.writeFileSync(LOG_FILE, '')
      bytesWritten = 0
    } else {
      bytesWritten = st.size
    }
  } catch (err) {
    // 文件不存在（首次运行）属预期分支，静默跳过；其余失败也不该影响插件启动
  }
}

// 体积超限时截断：保留末尾 KEEP_BYTES，避免把日志撑到几十 MB。
// 从保留区起点往后找第一个换行再切，防止首行断在中间变成半行乱码。
function trimIfOversize() {
  if (!LOG_FILE || !fsMod) return
  try {
    const st = fsMod.statSync(LOG_FILE)
    if (st.size <= MAX_BYTES) { bytesWritten = st.size; return }
    const fd = fsMod.openSync(LOG_FILE, 'r')
    let tail = ''
    try {
      const buf = Buffer.alloc(KEEP_BYTES)
      const read = fsMod.readSync(fd, buf, 0, KEEP_BYTES, Math.max(0, st.size - KEEP_BYTES))
      tail = buf.slice(0, read).toString('utf8')
    } finally {
      fsMod.closeSync(fd)
    }
    const nl = tail.indexOf('\n')
    // 找不到换行（单行超长）就整段保留，总比丢掉全部内容好
    const kept = nl >= 0 ? tail.slice(nl + 1) : tail
    const head = '[whale][log] 日志超过 ' + (MAX_BYTES / 1024) + 'KB，已截断只保留末尾\n'
    fsMod.writeFileSync(LOG_FILE, head + kept)
    bytesWritten = Buffer.byteLength(head + kept)
  } catch (err) {}
}

purgeIfStale()

function stringify(a) {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message || String(a)
  try { return JSON.stringify(a) } catch (err) { return String(a) }
}

// 同步写：进程随时可能被 uTools 结束，异步写会丢
function write(level, args) {
  if (!DEV) return
  try {
    const fn = level === 'ERR' ? console.error : console.log
    fn.apply(console, args)
  } catch (err) {}
  if (!LOG_FILE || !fsMod) return
  try {
    const parts = []
    for (let i = 0; i < args.length; i++) parts.push(stringify(args[i]))
    const line = '[' + new Date().toISOString() + '][' + level + '] ' + parts.join(' ') + '\n'
    fsMod.appendFileSync(LOG_FILE, line)
    bytesWritten += Buffer.byteLength(line)
    // 只有逼近上限才走统计/截断，常态写入零额外 IO
    if (bytesWritten > MAX_BYTES) trimIfOversize()
  } catch (err) {}
}

function log() { write('LOG', Array.prototype.slice.call(arguments)) }
function logErr() { write('ERR', Array.prototype.slice.call(arguments)) }

module.exports = { DEV, LOG_FILE, log, logErr }
