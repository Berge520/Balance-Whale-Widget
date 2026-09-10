/*
 * 日志门控（CommonJS）。
 *
 * 调试日志仅在 uTools 开发者模式下输出，避免打包后向用户控制台刷屏。
 * 约定：业务失败（网络/存储/IPC/窗口创建）用 logErr 留痕；
 *      Electron 可选 API 不存在或窗口已销毁属预期分支，用空 catch 静默跳过。
 *
 * 重要：uTools 关闭插件窗口会直接结束插件进程（勾选「退出到后台立即结束运行」时必然如此），
 * 控制台内容随进程一起丢失，导致「关闭设置窗口 → 挂件消失」这类生命周期问题无法排查。
 * 因此 dev 下额外把日志同步追加到固定文件（appendFileSync，进程被杀也不丢），事后可查：
 *   %TEMP%\whale-debug.log
 */
const DEV = (function () {
  try { return !!utools.isDev() } catch (err) { return false }
})()

// dev 日志落盘路径：优先系统临时目录（用户易找到：Win+R 输入 %TEMP%\whale-debug.log）
const LOG_FILE = (function () {
  if (!DEV) return ''
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
    fsMod.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '][' + level + '] ' + parts.join(' ') + '\n')
  } catch (err) {}
}

function log() { write('LOG', Array.prototype.slice.call(arguments)) }
function logErr() { write('ERR', Array.prototype.slice.call(arguments)) }

module.exports = { DEV, LOG_FILE, log, logErr }
