/*
 * 素材包下载的「进度状态」（CommonJS）。
 *
 * ── 为什么单独一个模块 ──
 * 内置形象包（skin-packs.js）与共享素材包（assets-packs.js）是两条独立链路，各自有
 * 自己的 running 防重入布尔，但**进度回显只能有一处**：设置页三张卡片（内置形象 /
 * 共享角色 / 共享音效）共用同一条 fetch 候选链与同一份带宽，进度区也不该同时冒三条。
 * 所以把进度态放这里做成单例，两个模块都往里写，设置页只读这一份。
 *
 * ── 为什么不放在共享的 assets.js / fetch 包装里 ──
 * 那会让「取包」这一层变成有状态的黑盒，两条链路各自的阶段语义（连接 / 下载 / 校验 /
 * 解包 / 写入）反而没法表达。这里只存数据、由调用方按自己的节奏写，职责更清楚。
 *
 * ── 读侧约定（与 dsh.js#progress 同款）──
 * snapshot() 必须**零副作用**：只读内存、不碰磁盘、不起子进程。设置页要 1Hz 轮询，
 * 任何副作用都会被放大成每秒一次的白工（dsh 那边就踩过 netstat 的坑，见 dsh.js#progress）。
 *
 * ── 为什么要有 updatedAt ──
 * 读侧靠它判断「这份进度是不是上一次下载留下的」：下载结束后状态要保留一小段时间让
 * 用户看清最终结果（进度条停在 100%、显示命中源），但不能永远留着 —— 否则下次没下载
 * 时进度区还杵在那里。保留窗口由读侧决定，写侧只如实记时间戳。
 */
let current = null

// 单条阶段的默认文案。phase 是给程序判断的，label 是给用户看的（也可以在 set 时覆盖）
const PHASE_LABEL = {
  connect: '正在连接下载源…',
  download: '正在下载…',
  verify: '正在校验…',
  install: '正在写入…',
}

// 开一次下载。pack 用 'skins' | 'shared-skins' | 'shared-sounds'，读侧据此决定文案与
// 「下完要刷新哪份清单」。total 未知时传 0，读侧退化为「只显示已下载字节 + 不确定进度条」。
function begin(pack, total) {
  const t = Number(total) || 0
  current = {
    pack: String(pack || ''),
    phase: 'connect',
    received: 0,
    total: t > 0 ? t : 0,
    // 服务端未给 Content-Length 时为 false，读侧据此显示「不确定进度」而非谎报 0%
    totalKnown: t > 0,
    url: '',
    label: PHASE_LABEL.connect,
    bytes: 0,
    at: Date.now(),
  }
}

// 进入某个阶段。切到 download 时会把上一源残留的 received 归零 —— 候选链换源要重新计，
// 否则换了源还接着上个源的数字涨，看上去像「越下越多」。
function phase(name, extra) {
  if (!current) return
  current.phase = String(name || '')
  current.label = PHASE_LABEL[current.phase] || current.label
  current.at = Date.now()
  if (current.phase === 'connect' || current.phase === 'download') {
    current.received = 0
    current.total = current.phase === 'connect' ? 0 : current.total
    current.totalKnown = current.total > 0
  }
  if (extra && typeof extra === 'object') {
    if (extra.url !== undefined) current.url = String(extra.url || '')
    if (extra.label !== undefined) current.label = String(extra.label || '')
    if (extra.total !== undefined) {
      const t = Number(extra.total) || 0
      current.total = t
      current.totalKnown = t > 0
    }
  }
}

// 本次尝试的下载源（进入候选链的一道时调用）。url 给读侧展示 / 复制，label 是它的
// 人话标签（「默认加速 ghfast.top」这类，由调用方的 labelOf 生成）。
function source(url, label) {
  if (!current) return
  current.url = String(url || '')
  if (label) current.label = String(label)
  current.phase = 'connect'
  current.received = 0
  current.at = Date.now()
}

// 已读字节数。下载中由读取循环高频调用 —— 这里刻意不做任何节流 / 格式化，
// 只赋值两个数字（读侧 1Hz 取快照，写得再勤也不会有额外开销）。
function progress(received, total) {
  if (!current) return
  const r = Number(received) || 0
  current.received = r
  current.phase = 'download'
  current.label = PHASE_LABEL.download
  if (total !== undefined) {
    const t = Number(total) || 0
    current.total = t
    current.totalKnown = t > 0
  }
  // 服务端给了 Content-Length 就用它当总量，比调用方传的 static 预期更可信
  current.at = Date.now()
}

// 结束一次下载。ok 决定读侧显示成功还是失败；bytes 是最终落地的包体积。
// 保留 current（不清空）—— 让读侧还能把终态呈现出来，由读侧按时间窗口自行忽略。
function end(ok, bytes) {
  if (!current) return
  current.phase = ok ? 'done' : 'failed'
  current.label = ok ? '下载完成' : '下载失败'
  current.bytes = Number(bytes) || 0
  if (ok) {
    // 成功时把 received 对齐到总量，避免进度条停在 99.x% 的观感（实际字节已齐，
    // 差额只是读循环最后一次回调与总量之间的取整误差）
    if (current.totalKnown) current.received = current.total
  }
  current.at = Date.now()
}

// 丢弃进度（读侧忽略窗口过后不必调用，这里给「用户主动重开一次」等场景留后门）
function clear() { current = null }

// 只读快照：回 null 表示当前没有（或从未有过）下载记录。
// ⚠️ 必须返回**副本**：调用方（设置页）会直接渲染这个对象，若回引用，
// 下载中的高频 progress() 会让渲染层读到「半更新」的字段组合。
function snapshot() {
  if (!current) return null
  return {
    pack: current.pack,
    phase: current.phase,
    received: current.received,
    total: current.total,
    totalKnown: current.totalKnown,
    url: current.url,
    label: current.label,
    bytes: current.bytes,
    at: current.at,
  }
}

module.exports = { begin, phase, source, progress, end, clear, snapshot, PHASE_LABEL }
