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
 *  - 体积：写入时发现文件超过 MAX_BYTES 就**轮转**（改名成 .1 后主文件重建，只保留一份历史）；
 *  - 日期：模块加载（即插件启动）时若文件最后修改时间超过 KEEP_DAYS 天，直接清空重建。
 * 两者都必须做在写入路径上 —— 日志是 appendFileSync 同步写的，进程随时可能被 uTools 结束，
 * 独立定时器并不可靠（定时器还没触发进程就没了）。
 *
 * 为什么超限是「轮转」而不是「截断只留末尾」：触发超限的往往是密集报错（某处高频失败
 * 瞬间刷满 1MB），截断会把出错之前的正常日志连同第一现场一起冲掉。轮转把整份旧日志
 * 存成 .1 保住上下文，用户报问题时「上一次会话的完整尾巴」还在。
 *
 * 重复日志抑制（P2）：同一处代码（level + 归一化后的消息）在短时间内反复失败会刷出上千行几乎相同的
 * 记录，既撑爆体积又淹没其它线索。故对相同键在 SUPPRESS_WINDOW 内只写首条，窗口过去后
 * 再补一行「（上次同键又重复 N 次，已折叠）」。这样「业务失败必须留痕」与「不刷爆日志」不再冲突。
 */
const DEV = true

// 单文件体积上限 1MB，超出后轮转成 .1（保留一份历史）并重建主文件。
const MAX_BYTES = 1024 * 1024
// 启动时按日期清理：最后修改时间超过 7 天视为陈旧日志，清空重建（长期不用再打开的场景）
const KEEP_DAYS = 7
const KEEP_MS = KEEP_DAYS * 24 * 3600 * 1000
// 重复抑制窗口：同一键在此毫秒数内只写首条，之后补一行重复计数。
// 取 5 秒 —— 高频轮询（如 250ms 的 watchTick）会落进同一窗口被折叠，
// 而真正的「不同次故障」之间通常间隔更久，不会被误折叠
const SUPPRESS_WINDOW = 5000
// 同键在窗口内被折叠的次数上限：极高频下也不让计数无界增长（到顶就固定在这个数）
const SUPPRESS_MAX_COUNT = 10000

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

// 体积超限时轮转：把当前日志改名成 .1（覆盖上上次的 .1），主文件重建。
// 保留一份历史而非直接截断 —— 触发超限的常常是密集报错，截断会把第一现场一起冲掉。
// 只留一份 .1：再多份历史对「用户报一个问题」的场景没收益，反而占 %TEMP% 空间。
function rotateIfOversize() {
  if (!LOG_FILE || !fsMod) return
  try {
    const st = fsMod.statSync(LOG_FILE)
    if (st.size <= MAX_BYTES) { bytesWritten = st.size; return }
    const prev = LOG_FILE + '.1'
    // 先删旧的 .1，再改名：Windows 下 rename 到已存在的目标会失败（与 POSIX 覆盖语义不同）
    try { fsMod.unlinkSync(prev) } catch (err) {}
    fsMod.renameSync(LOG_FILE, prev)
    const head = '[whale][log] 日志超过 ' + (MAX_BYTES / 1024) + 'KB，已轮转；上一份见 ' + prev + '\n'
    fsMod.writeFileSync(LOG_FILE, head)
    bytesWritten = Buffer.byteLength(head)
  } catch (err) {}
}

purgeIfStale()

function stringify(a) {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message || String(a)
  try { return JSON.stringify(a) } catch (err) { return String(a) }
}

// 重复抑制表：key（level + 归一化后的消息）→ { at: 本窗口起点时间戳, count: 本窗口已折叠条数,
// pendingRepeat: 上一窗口折叠的条数（待下一次放行时补一行计数后清零） }。
// 只对**日志行**生效，控制台照样每条都打 —— 调试时能看见完整序列，落盘才需要收敛。
// 键里带上 level：同一条消息既有 LOG 又有 ERR 时不应互相折叠（含义不同）。
// 键里的时间戳 / 数字要归一化，否则「同一处失败但耗秒数不同」会被当成不同键，抑制失效
const suppressed = new Map()
// 抑制表条目上限：日志消息种类理论上可无限（如带用户名/URL 的报错），不能让它无界增长。
// 超限时清空整表（而不是 LRU 淘汰单条）—— 抑制是「省日志」的优化，失忆一秒无碍，
// 而清空是最省事、无需维护链表的做法，符合这里的收益量级
const SUPPRESS_MAX_KEYS = 500

// 把一行归一成抑制键：抹掉易变的时间戳与数字，只留「是谁、在哪、说了什么」。
// 不用整行原文当键，是因为 duration_ms / 行号 / 计时值每次都可能变，原文比较必然失效
function suppressKey(level, joined) {
  return level + '|' + joined
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '')   // ISO 时间戳
    .replace(/\b\d+(\.\d+)?(ms|s|KB|MB)?\b/g, '#') // 裸数字与其单位
    .slice(0, 400)
}

// 同键抑制窗口内的重复：返回 true 表示「本条应被折叠、不落盘」。
// 窗口到期后放行首条，并在首条后补一行「上次同键又重复 N 次」——
// 这样既能看到「问题还在持续」，又不会为每次重复都写一行。
function isSuppressed(level, joined, now) {
  const key = suppressKey(level, joined)
  const rec = suppressed.get(key)
  if (!rec) {
    if (suppressed.size >= SUPPRESS_MAX_KEYS) suppressed.clear()
    suppressed.set(key, { at: now, count: 0, pendingRepeat: 0 })
    return false
  }
  if (now - rec.at <= SUPPRESS_WINDOW) {
    if (rec.count < SUPPRESS_MAX_COUNT) rec.count++
    return true
  }
  // 窗口已过：先记下「折叠了多少次」，放行当前这条，由 write 负责补重复行
  rec.pendingRepeat = rec.count
  rec.at = now
  rec.count = 0
  return false
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
    const joined = parts.join(' ')
    const now = Date.now()
    if (isSuppressed(level, joined, now)) return
    // 上一窗口折叠过同键 → 在当前这条之前补一行计数，时间戳用本次，
    // 让读者知道「在两次落盘之间它其实又失败了 N 次」，不至于以为只发生了一次
    const key = suppressKey(level, joined)
    const rec = suppressed.get(key)
    const repeat = rec && rec.pendingRepeat
    if (repeat) {
      rec.pendingRepeat = 0
      const note = '[' + new Date(now).toISOString() + '][' + level + '] （上次同键又重复 ' + repeat + ' 次，已折叠）\n'
      fsMod.appendFileSync(LOG_FILE, note)
      bytesWritten += Buffer.byteLength(note)
    }
    const line = '[' + new Date(now).toISOString() + '][' + level + '] ' + joined + '\n'
    fsMod.appendFileSync(LOG_FILE, line)
    bytesWritten += Buffer.byteLength(line)
    // 只有逼近上限才走统计/轮转，常态写入零额外 IO
    if (bytesWritten > MAX_BYTES) rotateIfOversize()
  } catch (err) {}
}

function log() { write('LOG', Array.prototype.slice.call(arguments)) }
function logErr() { write('ERR', Array.prototype.slice.call(arguments)) }

module.exports = { DEV, LOG_FILE, log, logErr }
