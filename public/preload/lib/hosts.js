/*
 * GitHub 加速（hosts 方案，CommonJS）。
 *
 * 原理：在系统 hosts 文件最前写一段由标记头/尾包裹的「IP 域名」块（Windows 首次匹配解析，
 * 块在最前才能压过其它工具写在后面的条目），浏览器 / git / 下载全走直连 IP 加速；
 * 关闭时按标记把块删掉即可完全还原。原始 hosts 内容永不修改 —— 因此即使
 * 内置 IP 表过时，最坏只是回到慢速，关一次开关就恢复原状，不会更糟。
 *
 * 与其它加速工具的共存：
 *  - 若对方也写 hosts：Windows 按首次匹配解析，排在前的条目会覆盖本插件的块
 *    → scanConflicts() 扫描块外已有的目标域名条目，设置页提示先关掉对方再启用
 *  - 若对方走「本地反代 + 证书」：hosts 直连会绕开其代理，可能更慢/连不上
 *    → probeConnectivity() 实测 github.com 可达性，让用户开启前后各测一次自行判断
 *
 * 提权写 hosts：UAC 弹窗走 dsh.js 的 psExe + Start-Process -Verb RunAs 先例。
 * 关键设计：hosts 的读写都在本模块内按字节做（不解码原文，避免把 ANSI/GBK 注释
 * 当 UTF-8 重写造成乱码），算好的完整文件写到临时文件，提权脚本只负责
 * 「首次备份原 hosts → 拷贝覆盖」，并把结果写回临时结果文件由父进程读回。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const https = require('https')
const { log, logErr } = require('./log')
const { GH_DOMAINS, GH520_HOSTS_URL } = require('./constants')
const { normIps, patchConfig, readConfig } = require('./store')
const { psExe } = require('./dsh')

const WIN = process.platform === 'win32'
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
const MARK_START = '# >>> whale-ghaccel start >>>'
const MARK_END = '# <<< whale-ghaccel end <<<'

// 取 URL 主机名（来源列展示「社区源表 · raw.hellogithub.com」，比整条 URL 短且够辨识）
function srcHost(url) {
  try { return new URL(url).host } catch (err) { return String(url || '').replace(/^https?:\/\//, '').split('/')[0] }
}

// 带并发上限的 map：结果数组与入参同序（调用方按下标取值，与 Promise.all 用法一致）。
// 为什么不用 Promise.all：本模块所有代码都跑在渲染进程主线程上（services.js 把 lib/settings
// 直接挂 window，是同进程直调而非 IPC），Promise.all 会在同一瞬间把上百个 https.request /
// fetch 全推出去 —— 主线程要连续处理上百次 socket 事件与 TLS 握手回调，Vue 的渲染与事件响应
// 被挤到队尾，表现就是「点一下刷新整个设置页卡住」。限并发后任一时刻在飞的就这几条，
// 主线程有喘息间隙，总耗时几乎不变（瓶颈是单个最慢的探测，不是并发度）。
//
// 被拒绝时立刻拒绝整个 map（与 Promise.all 语义一致）：本模块的 task 都自带 catch 兜底
// 不抛错，正常路径不会走到这里，保留拒绝只是不让错误被静默吞掉
function mapLimit(items, limit, task) {
  const list = Array.isArray(items) ? items : []
  const out = new Array(list.length)
  if (!list.length) return Promise.resolve(out)
  // 并发度取不小于 1 的整数：调用方可能传 0（写错）导致一个都不跑、Promise 永不 settle
  const n = Math.max(1, Math.min(Math.round(limit) || 1, list.length))
  let next = 0
  let remaining = list.length
  return new Promise((resolve, reject) => {
    const done = () => {
      remaining--
      if (remaining === 0) resolve(out)
      else pump()
    }
    const pump = () => {
      if (next >= list.length) return
      const i = next++
      Promise.resolve()
        .then(() => task(list[i], i))
        .then((r) => { out[i] = r; done() }, reject)
    }
    for (let i = 0; i < n; i++) pump()
  })
}

// 候选链的三个可选来源：默认顺序 = 改动前写死的 doh > community > manual。
// 归一化规则与 normGhAccelSrc 同源（缺省落到默认），但这里管的是「顺序」而非「开关」
const SRC_KEYS = ['doh', 'community', 'manual']
const SRC_LABEL = { doh: 'DoH 实时解析', community: '社区源表', manual: '当前 IP 表（手填）' }
function normSrcOrder(v) {
  const arr = Array.isArray(v) ? v.filter((k) => SRC_KEYS.includes(k)) : []
  const out = []
  for (const k of arr) if (!out.includes(k)) out.push(k)
  // 缺失的键补到末尾：老配置没这个数组时 = SRC_KEYS 原顺序，行为与升级前完全一致
  for (const k of SRC_KEYS) if (!out.includes(k)) out.push(k)
  return out
}
// 把「来源顺序 + 开关」渲染成一行短文案，供操作日志标题 / 步骤共用。
// 为什么由后端算而不是前端传：标题在 preload 侧生成（runGhAccelOp 的开篇），且要在
// 用户还没打开设置页时就正确 —— 前端算不出来。文案只列**实际参与**的来源（关掉的不列），
// 顺序与 normSrcOrder 一致，才能让「标题里写的」与「这一步真正做的事」对得上。
// 与设置页 ghAccelEffectiveOrder 的差别：那边末尾补「> 内部兜底」，这里只在有来源时补
function srcChainLabel(order, src) {
  const on = (k) => !(src && src[k] === false)
  const parts = normSrcOrder(order).filter(on).map((k) => SRC_LABEL[k])
  return parts.length ? parts.join(' > ') + ' > 内部兜底' : '（来源全关，无法开启）'
}

// 最近一次获取过程的来源追踪（内存态，不落盘）：设置页「GitHub 加速 → 查看日志」展示，
// 回答「每个域名的 IP 通过什么方式、从哪里获取」：
//  - dohResolvers：本次 DoH 实时解析中，实际返回过 A 记录的 DoH 入口（域名或直连 IP 形式）
//  - dohByDomain：DoH 实时解析出的逐域名 IP（并集，未过探测）
//  - dohOrigin：上面每个 IP 具体由哪家 DoH 解析出（Cloudflare / Google），支撑「来源」列点名到厂商
//  - refreshUrl：刷新用到的社区源 URL（GitHub520 主源或镜像）
//  - byDomain：每个域名最终选中的 IP + 来源（带具体出处，如「DoH 实时解析 · Cloudflare」）
let lastTrace = { at: 0, dohResolvers: [], dohByDomain: {}, dohOrigin: {}, refreshUrl: '', byDomain: {} }

// ──────────────────────────────────────────────
// 操作日志（内存态环形缓冲，重开插件清空）
// ──────────────────────────────────────────────
// 设置页「GitHub 加速日志」用：一条 = 一次操作，回答「点了什么按钮 → 做了什么 → 结果如何」。
// 与 log()/logErr() 的区别：那两个是给开发者看的诊断流水（DEV 门控、混着所有模块）；
// 这份是**结构化**的面向用户记录（步骤 + 结果 + 关键数据），且保留足够条数供回看历史。
// 不落盘：日志含 IP / 源 URL，属诊断信息，没必要长期留存，也避免泄漏到磁盘。
const OP_LOG_MAX = 50
const opLogs = []
// 日志版本号：每次结构变化（新增 op / 新增 step / 改写 detail / 落终态）自增。
// ghAccelOpLogs 据此判断「自上次取走以来有没有真的变过」—— 没变就直接返回同一份快照，
// 省掉每 500ms 一次的「最多 50 条 × N 步骤」全量深拷贝（探测中步骤数组一直在长，
// 这份拷贝的分配压力会直接压在主线程上，正是刷新期间界面卡顿的一部分）
let opLogVer = 0
function nextOpId() {
  return opLogs.length ? opLogs[0].id + 1 : 1
}
// step：步骤文案（做什么）；state：running/done/fail/skip；detail：结果与关键数据
function opStart(title) {
  const entry = { id: nextOpId(), at: Date.now(), title: title, state: 'running', steps: [] }
  opLogs.unshift(entry)
  if (opLogs.length > OP_LOG_MAX) opLogs.length = OP_LOG_MAX
  opLogVer++
  log('[whale][ghaccel] 操作开始 #' + entry.id, title)
  return entry
}
function opStep(entry, text, state, detail) {
  if (!entry) return
  const step = { text: text, state: state || 'done', detail: detail || '' }
  entry.steps.push(step)
  opLogVer++
  // 返回刚压入的 step，调用方可持有它并在后续原地改写 detail（逐条探测的进度回显）。
  // 直接用 push 进数组的同一个对象，ghAccelOpLogs 深拷贝时会取到最新值，无需额外通知机制
  return step
}
// 逐条探测的进度回显：不改文字，只把「已测 n / 共 m」写进该步骤的 detail，
// 让设置页在探测期间能看到进展（探测是最耗时的一步，之前只有静止的「校验中…」）
function opProgress(step, done, total, extra) {
  if (!step) return
  step.detail = '已测 ' + done + '/' + total + ' 条' + (extra ? '，' + extra : '')
  opLogVer++
}
function opEnd(entry, state, summary) {
  if (!entry) return
  entry.state = state
  entry.summary = summary || ''
  entry.ms = Date.now() - entry.at
  opLogVer++
  const tag = state === 'ok' ? '完成' : state === 'cancel' ? '取消' : '失败'
  const line = '[whale][ghaccel] 操作' + tag + ' #' + entry.id + ' ' + entry.title + '（' + entry.ms + 'ms）' + (summary ? '：' + summary : '')
  if (state === 'fail') logErr(line)
  else log(line)
}
// 上次取走时的版本号与快照。设置页在操作进行中每 500ms 轮询一次，而日志内容只在「步骤真的
// 变了」时才变（探测期间每个候选才推一次进度）—— 版本未变就复用同一份快照，省掉重复深拷贝
let opLogCacheVer = -1
let opLogCache = []
function ghAccelOpLogs() {
  if (opLogCacheVer === opLogVer) return opLogCache
  // 深拷贝：渲染进程拿到的不能是宿主内部对象引用，否则设置页改一下就污染了历史
  opLogCache = opLogs.map((e) => ({
    id: e.id,
    at: e.at,
    title: e.title,
    state: e.state,
    summary: e.summary || '',
    ms: e.ms || 0,
    steps: e.steps.map((s) => ({ text: s.text, state: s.state, detail: s.detail })),
  }))
  opLogCacheVer = opLogVer
  return opLogCache
}
// 清空操作日志。连带把 id 计数也归零（nextOpId 依赖 opLogs[0]，清空后自然从 #1 重来）。
// 进行中的那条也一并清掉：clear 只在设置页点，此刻用户就是要一片干净，留着半条更奇怪；
// 那条 op 的 opEnd 后续仍会写进 log()（诊断流水不受影响），只是不再回到这份面向用户的记录
function clearGhAccelOpLogs() {
  const n = opLogs.length
  opLogs.length = 0
  opLogVer++ // 清空也是内容变化：不递增的话轮询会一直拿到清空前的旧快照
  log('[whale][ghaccel] 操作日志已清空', n, '条')
  return n
}

// 备份文件位置：首次开启时由提权脚本把原 hosts 复制过去，供误操作时手动恢复。
// 正常关闭走「删块」不需要它；uTools 的数据目录卸载/清除不影响系统 hosts。
function userDataDir() {
  try { return utools.getPath('userData') } catch (err) {}
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'whale') : os.tmpdir()
}
function hostsBackupPath() {
  return path.join(userDataDir(), 'whale-hosts-backup')
}
// 先 String(s) 再判别：来源追踪 / 源表里 ip 可能不是字符串（数字形式的 IP），
// 直接 exec 会因类型隐式转换放过非字符串值。统一在这里转成字符串，
// 保证调用方拿到的 ip 一定是 string（设置页侧有对应类型契约）
function isIpv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s == null ? '' : s))
  return !!m && m.slice(1).every((n) => Number(n) <= 255)
}

// ──────────────────────────────────────────────
// 按字节读写 hosts（不改变原文编码）
// ──────────────────────────────────────────────
// 异步读：本模块所有代码都跑在渲染进程主线程上（services.js 把 lib/settings 直接挂 window，
// 是**同进程直调**而非 IPC），同步 fs 会把 Vue 的渲染线程一起冻住。hosts 文件虽小，
// 但读写发生在「点开启」的关键路径上，一律走异步版
function readHostsBuf() {
  return new Promise((resolve) => {
    fs.readFile(HOSTS_PATH, (err, b) => {
      // 读文件不需要管理员权限；读不到按空处理（enable 时会重建）
      if (err) resolve(Buffer.alloc(0))
      else resolve(Buffer.isBuffer(b) ? b : Buffer.from(b))
    })
  })
}
// 找到 pos 所在行的行首（不含换行）
function lineStart(buf, pos) {
  const nl = buf.lastIndexOf(10, pos)
  return nl < 0 ? 0 : nl + 1
}
// 找到 pos 所在行的行尾（不含换行符本身）
function lineEnd(buf, pos) {
  const nl = buf.indexOf(10, pos)
  return nl < 0 ? buf.length : nl
}
// 删除标记块。头在但尾不在 = 异常残留，也从行首删到文件尾。
// 循环删除是为了处理「文件里存在多段块」：别的工具复制粘贴过、或上次写入异常残留。
// 只删第一段会留下后段残块（含 IP 行时会误导解析，也污染用户 hosts），
// 下次 enable 时它还会留在文件后段 —— 这里一次清干净。
function stripBlock(buf) {
  let cur = buf
  for (;;) {
    const i0 = cur.indexOf(Buffer.from(MARK_START))
    if (i0 < 0) return cur
    // 尾标记只找头之后的第一个：与 ghAccelStatus 的完整性判定同口径（只认第一段块），
    // 否则删的范围会跨过第二段块的头，把中间的正常内容一起删掉
    const iEnd = cur.indexOf(Buffer.from(MARK_END), i0)
    const s = lineStart(cur, i0)
    let e = iEnd < 0 ? cur.length : lineEnd(cur, iEnd)
    // 把块末尾的换行（\r\n 或 \n）一并删掉
    if (e < cur.length && cur[e] === 13) e++
    if (e < cur.length && cur[e] === 10) e++
    cur = Buffer.concat([cur.slice(0, s), cur.slice(e)])
  }
}
// 把块写到文件最前：Windows 按首次匹配解析，其它工具常驻的「127.0.0.1 github.com」
// 等条目排在后面就永远轮不到我们 —— 块写在最前才能压过它们，让 github 直连真实可达 IP。
// 块内容是我们自己写的，可放心当 UTF-8 编码
function prependBlock(buf, ips) {
  const lines = [
    MARK_START,
    '### 小鲸鱼余额挂件 GitHub 加速：关闭加速后本块整段删除，不影响其他内容',
  ].concat(ips.map((it) => it.ip + ' ' + it.domain)).concat([MARK_END])
  const block = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')
  // 原文件非空且不以换行结尾时先补一个换行，避免与块尾换行粘连
  let tail = buf
  if (tail.length > 0 && tail[tail.length - 1] !== 10) tail = Buffer.concat([tail, Buffer.from('\r\n')])
  return Buffer.concat([block, tail])
}
// 解析块内容里的「生效域名」列表（块是我们写的 ASCII，按 UTF-8 解没问题）
// 同一域名可能有多行（多个候选 IP 做回退），这里按域名去重 —— 调用方（设置页
// 「已生效（N 个域名）」）要的是域名数，不是行数
function blockActive(buf) {
  const i0 = buf.indexOf(Buffer.from(MARK_START))
  const iEnd = buf.indexOf(Buffer.from(MARK_END))
  if (i0 < 0 || iEnd < 0) return []
  const inner = buf.slice(lineEnd(buf, i0) + 1, lineStart(buf, iEnd)).toString('utf8')
  const out = []
  const seen = new Set()
  for (const line of inner.split('\n')) {
    const t = line.replace(/#.*/, '').trim()
    if (!t) continue
    const p = t.split(/\s+/)
    if (p.length >= 2 && isIpv4(p[0]) && GH_DOMAINS.includes(p[1]) && !seen.has(p[1])) {
      seen.add(p[1])
      out.push(p[1])
    }
  }
  return out
}

// ──────────────────────────────────────────────
// 状态与冲突扫描（读文件即可，不需要管理员权限）
// ──────────────────────────────────────────────
async function ghAccelStatus() {
  if (!WIN) return { ok: false, on: false, active: [], hostsPath: HOSTS_PATH, error: '仅支持 Windows' }
  const buf = await readHostsBuf()
  const i0 = buf.indexOf(Buffer.from(MARK_START))
  // 完整性只看**第一段**块：取头标记之后的第一个尾标记。不能取 lastIndexOf(尾) —— 文件里
  // 若存在两段块（别的工具复制粘贴过、或上次写入异常残留），末段完整而首段残缺时，
  // lastIndexOf 会判成完整，但 Windows 解析生效的是**最靠前那段**，于是又变成
  // 「显示已生效却打不开」的假成功。与 stripBlock / blockActive 统一按 indexOf 口径
  // （删除和读内容都只动第一段），避免「判定说生效、删除删的是另一段」的自相矛盾。
  const iEnd = i0 < 0 ? -1 : buf.indexOf(Buffer.from(MARK_END), i0)
  // on 的判据是「头标记之后能找到尾标记」，而不是「找得到头标记」：
  // 头在而尾缺失/被截断时块内容根本没生效，报 on 就是假成功。
  // 与 Watt Toolkit HostsFileServiceImpl.ContainsHostsByTag() 同思路（它只认
  // 「文件最后出现的标记是 End」的状态），但这里更严：只认第一段块的完整性。
  const on = i0 >= 0 && iEnd > i0
  // broken：头在但尾不在 —— 块被别的工具/编辑器截断或改坏。与「没开启」(!on) 语义不同：
  // 没开启是不动 hosts；broken 是留下一段垃圾块，必须提示用户「重新写入 hosts」清掉，
  // 否则那段残留里若有被墙的 IP，反而会把域名解析到死地址
  const broken = i0 >= 0 && !on
  // degraded：块存在但已被挤出文件最前（块前有非空白/非注释内容）。块写在最前才能
  // 压过其它工具常驻的 127.0.0.1 条目（Windows first-match）；若对方在本插件
  // 之后又写了 hosts、把块挤到后段，就会失效 —— 设置页据此提示「重新写入 hosts」。
  // 监听 hosts 变化的工具会在我们写入后自动重写，我们无法常驻提权（会反复弹 UAC），
  // 故用「读文件时检测 + 状态暴露」的轻量替代。
  let degraded = false
  if (on) {
    const head = buf.slice(0, i0).toString('utf8').replace(/#[^\n]*/g, '').replace(/\s+/g, '')
    degraded = head !== ''
  }
  return { ok: true, on: on, broken: broken, degraded: degraded, active: on ? blockActive(buf) : [], hostsPath: HOSTS_PATH, error: '' }
}
// 块之外已有的目标域名条目：Windows 首次匹配解析，它们排在前会覆盖本插件的块
// 顺带按条目特征猜「是哪类工具写的」—— 只认高置信特征，判不准就返回空串，
// 由调用方退回中性说法「第三方条目」。猜错比不猜更糟（用户会去错误的软件里翻设置），
// 故这里宁可少说：宁可说「别的工具」，也不说「可能是 XX」然后其实不是。
function guessWriter(ip) {
  // 回环地址指向 GitHub 域名 = 典型的「本地反代」类工具（Watt Toolkit / FastGithub 等）：
  // 先用 hosts 把域名劫持到本机，再由本地代理进程转发。用户手写 hosts 极少会把
  // 这些域名指到 127.0.0.1（那样只会打不开），故这是高置信特征
  if (ip === '127.0.0.1' || ip === '0.0.0.0') return '本地反代类工具'
  return ''
}
async function scanConflicts() {
  if (!WIN) return []
  const buf = stripBlock(await readHostsBuf())
  const out = []
  const seen = new Set()
  for (const line of buf.toString('utf8').split('\n')) {
    const t = line.replace(/#.*/, '').trim()
    if (!t) continue
    const p = t.split(/\s+/)
    if (p.length < 2 || !isIpv4(p[0])) continue
    const domain = p[1].toLowerCase()
    if (GH_DOMAINS.includes(domain) && !seen.has(domain)) {
      seen.add(domain)
      out.push({ domain: domain, ip: p[0], line: line.trim(), writer: guessWriter(p[0]) })
    }
  }
  return out
}

// 连通性自检：HEAD https://github.com 实测（设置页「检测连接」开启前后各测一次做对比）
async function probeConnectivity(op) {
  const t0 = Date.now()
  opStep(op, 'HEAD 请求 https://github.com', 'running', '走系统当前的 DNS 与 hosts 解析')
  try {
    const res = await fetch('https://github.com', { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) })
    opStep(op, 'HEAD 请求 https://github.com', 'done', 'HTTP ' + res.status + '，耗时 ' + (Date.now() - t0) + 'ms')
    return { ok: true, ms: Date.now() - t0, status: res.status }
  } catch (err) {
    const msg = String((err && err.message) || err)
    opStep(op, 'HEAD 请求 https://github.com', 'fail', msg)
    return { ok: false, ms: Date.now() - t0, error: msg }
  }
}

// ──────────────────────────────────────────────
// 一键刷新 IP 表（走与开启同一套候选链：DoH 实时解析 + 社区源，按用户设定的来源优先级合并）
// ──────────────────────────────────────────────
// 社区源只覆盖 github.* 域名，huggingface.co / hub.docker.com / greasyfork.org 源里没有，
// 刷新按「候选链命中 > 当前表」逐域名合并，绝不丢掉这些域名 —— 否则一刷新表就少了几条。
// 多源兜底：GitHub520 主源挂了/被墙时逐个往后切，首个有命中的源即停；
// 全部失败保留旧表只报错 —— 宁可继续用旧表，也不能把表清空。
// **两个源互补，别再往里加 gitlab / ghproxy 版 ineo6/hosts**：实测它们与 raw.hellogithub.com
// 是同一个文件的不同镜像入口（域名清单与 IP 完全一致，gitlab.com/ineo6/hosts 本身就是 GitHub520
// 的镜像仓库），加进来只会让刷新白等一轮网络往返，对覆盖率零贡献 —— 实测日志里
// 「拉取社区源 gitlab.com 命中 12 个域名」正是这种假命中（12 个域名全是前面已命中的）。
// ghproxy 版还多两层依赖（经代理转发、本身就要求能连通 GitHub），恰在本功能最需要时最不可靠
const GH_IPS_SOURCES = [
  GH520_HOSTS_URL,
  'https://hosts.gitcdn.top/hosts.txt',
]
// 用户自定义源：只收 http(s) URL，且必须是**合法的绝对 URL**（让 new URL 先校验一遍）。
// 为什么在这里校验而不是信任设置页：配置可被手改 / 从备份恢复，源 URL 会被直接 fetch，
// 放任意字符串进来会变成一次莫名其妙的网络请求。上限 10 个 —— 每个源都是一轮网络往返，
// 刷新耗时 ≈ 最慢那个源，源太多只会让用户白等
const CUSTOM_SRC_MAX = 10
function normCustomSources(v) {
  const arr = Array.isArray(v) ? v : []
  const out = []
  for (const u of arr) {
    const url = typeof u === 'string' ? u.trim() : ''
    if (!url || out.includes(url)) continue
    let ok = false
    try {
      const p = new URL(url)
      ok = (p.protocol === 'https:' || p.protocol === 'http:') && !!p.host
    } catch (err) { ok = false } // 不是合法 URL：直接丢，不静默留下一个拉不动的源
    if (ok) out.push(url)
    if (out.length >= CUSTOM_SRC_MAX) break
  }
  return out
}
// 全部可参与候选链的源 = 内置源 + 用户自定义源。
// 自定义源**追加在末尾**：内置源是人工验证过的高可靠快照，让它们继续优先；
// 用户若想让自己加的源优先，可在「获取方式」里把它往上移（顺序存在 sources 里）
function allSources(custom) {
  const out = GH_IPS_SOURCES.slice()
  for (const u of normCustomSources(custom)) if (!out.includes(u)) out.push(u)
  return out
}
// 源表顺序：用户可在「获取方式」里自定义（ghAccelSrcSources），默认 = GH_IPS_SOURCES 原顺序。
// 归一化放在这里而不是 store.js：源清单属于 hosts 模块的领域知识，store 只需存字符串数组
// **必须剥掉 'community:' 前缀再比对**：设置页落盘的是 srcCode 编出来的 'community:<url>'
// （见 AccelView.srcCode），而 allow 里是裸 URL。旧实现直接 allow.includes(u)，恒为 false
// → out 被清空 → 下面按 GH_IPS_SOURCES 原序补回，用户排的源表顺序 100% 丢失、永远退回默认序。
// 症状极隐蔽：UI 显示的顺序是对的（splitOrder 有去前缀），日志里「刷新源：」那行却是默认序，
// 表现为「用户排 gitcdn.top 在前，来源列却大面积是 raw.hellogithub.com」
function normSources(v, custom) {
  const arr = Array.isArray(v) ? v : []
  const allow = allSources(custom) // 内置 + 自定义，自定义排在末尾
  const out = []
  // 保序去重：同一源写两遍（重复拖动 / 配置手改）会让同一个 URL 被拉两遍、白等一轮网络往返
  for (const u of arr) {
    const url = typeof u === 'string' && u.startsWith('community:') ? u.slice('community:'.length) : u
    if (allow.includes(url) && !out.includes(url)) out.push(url) // 只认已知源，防配置里塞任意 URL 被当源拉取
  }
  for (const u of GH_IPS_SOURCES) if (!out.includes(u)) out.push(u) // 内置源自动补到末尾，老配置不漏源
  // 自定义源**不自动补**：它的参与与否只由「sources 里有没有写它」决定（勾选才启用）。
  // 若也按 allow 补齐，用户刚粘进列表、还没勾的源自个儿就参与拉取了 —— 默认不参与直接失效
  return out
}
// refreshIps(current, op, srcOrder, order)
//  - srcOrder：社区源表内部的源顺序（GH_IPS_SOURCES 的子序列）
//  - order：候选链的来源顺序（doh / community / manual），来自用户在「获取方式」里的排序。
//    刷新必须**同样**走这条链：用户把 DoH 排第一却看到日志只报「拉取社区源」，等于设置白设
//    （旧版的坑：这里从不调用 dohIps，DoH 在这条路径上完全没参与，却照样报成功）
async function refreshIps(current, op, srcOrder, order, customSources) {
  const want = {}
  for (const d of GH_DOMAINS) want[d] = true
  const curBy = {}
  if (Array.isArray(current)) for (const it of current) if (it && it.domain) curBy[it.domain] = it.ip
  const curCount = Object.keys(curBy).length
  opStep(op, '读取当前 IP 表作为合并基线', 'done', curCount + ' 条')
  // 候选链来源顺序（与开启共用 normSrcOrder 归一化口径）
  const chain = normSrcOrder(order)
  const order2 = normSources(srcOrder, customSources)
  opStep(op, '候选链优先级', 'done', chain.map((k) => SRC_LABEL[k]).join(' > '))
  // ── 分辨率优先短路 ──
  // 按用户的优先级**逐段推进，凑齐就停**：排在前面的来源先出结果，已覆盖全部域名就不再
  // 跑后面的来源。旧实现是「无条件先解析 DoH + 无条件全拉社区源，最后才合并」，优先级只在
  // 合并那一步生效 —— 用户把「当前 IP 表」排第一、DoH 排最后，DoH 照样先解析、三个源照样
  // 全拉，白等十几秒（实测 13s），等于优先级对耗时毫无影响。
  // 现在：当前表排第一 → 先探旧值；旧值全通就不解析 DoH、不拉任何源。
  const coveredBy = {} // 域名 → { ip, source, fresh }：参与探测的候选（最终来源以 lastTrace 为准）
  // 已探通且可写入的域名 → IP。凑齐 GH_DOMAINS 全部即提前收工
  const reached = {}
  const probes = [] // 各段探测的汇总，供日志与「不可达」清点
  // 已探过的 (域名|IP) → true。跨段复用：DoH / 社区源 / 手填三段常给出同一批 IP（尤其是
  // 都不通的死地址），不记这个的话每个 IP 会被重探 N 遍，每次最坏等满 PROBE_TIMEOUT_MS
  const probedKey = {}
  let dohHit = 0
  let okCount = 0
  let totalEntries = 0
  const pulledHosts = []
  const errs = []
  // 缺哪些域名还没探通：短路判定与下一段「只补缺的」都靠它
  const missing = () => GH_DOMAINS.filter((d) => !reached[d])

  for (const key of chain) {
    const need = missing()
    if (!need.length) {
      opStep(op, '候选链提前收工', 'skip',
        '已按优先级由 ' + chain.slice(0, chain.indexOf(key)).map((k) => SRC_LABEL[k]).join('、')
        + ' 覆盖全部 ' + GH_DOMAINS.length + ' 个域名，后续来源不再执行')
      break
    }
    if (key === 'doh') {
      const dohBy = await dohIps()
      dohHit = GH_DOMAINS.filter((d) => (dohBy[d] || []).length).length
      opStep(op, 'DoH 实时解析（' + DOH_URLS.map((u) => dohName(u)).join(' + ') + '）', dohHit ? 'done' : 'skip',
        dohHit ? dohHit + ' 个域名取到实时 A 记录' : '未取到 A 记录，交给下一优先级来源' + dohFailText())
      for (const d of need) {
        const ip = (dohBy[d] || [])[0]
        if (ip) coveredBy[d] = { ip: ip, source: 'DoH 实时解析 · ' + ((dohCache.originByIp || {})[ip] || 'cloudflare/google 等'), fresh: true }
      }
    } else if (key === 'community') {
      // 只给「还没探通」的域名拉源：前一段已覆盖的域名不必再花一次网络往返。
      // 源表顺序由用户决定，故这一段内**全部拉取**（A 只覆盖 3 个域名时不能停手，
      // 否则 B 的域名全丢）—— 段内限并发，总耗时 ≈ 最慢那个源
      const pullStep = opStep(op, '拉取社区源（' + order2.length + ' 个）', 'running', '已拉 0/' + order2.length + ' 个')
      let pulled = 0
      const pulls = await mapLimit(order2, order2.length, async (url) => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
          if (!res.ok) {
            const e = 'HTTP ' + res.status
            logErr('[whale][ghaccel] 源返回非 2xx', url, e)
            return { url: url, err: e }
          }
          const text = await res.text()
          const found = {}
          let total = 0
          for (const line of text.split('\n')) {
            const t = line.replace(/#.*/, '').trim()
            if (!t) continue
            const p = t.split(/\s+/)
            if (p.length < 2 || !isIpv4(p[0])) continue
            const domain = p[1].toLowerCase()
            if (!want[domain]) continue
            total++
            if (!(domain in found)) found[domain] = p[0] // 源里同域多条时取第一条
          }
          return { url: url, found: found, total: total }
        } catch (err) {
          const e = String((err && err.message) || err)
          logErr('[whale][ghaccel] 拉取源失败', url, e)
          return { url: url, err: e }
        } finally {
          pulled++
          opProgress(pullStep, pulled, order2.length)
        }
      })
      pullStep.state = 'done'
      // 逐源报告：某源整体失败不该静默，用户要能看出「我排在前面的源根本没拉到」。
      // 失败原因累加成数组而非单变量覆盖：三个源全挂时只留最后一个的话，用户以为「只有最后一个有问题」
      const ok = []
      pulls.forEach((p) => {
        const host = srcHost(p.url)
        const fresh = p.found ? GH_DOMAINS.filter((d) => p.found[d]).length : 0
        if (p.found && fresh) {
          ok.push(p)
          pulledHosts.push(host)
          opStep(op, '拉取社区源 ' + host, 'done', '命中 ' + fresh + ' 个域名（源共 ' + p.total + ' 条目标条目）')
        } else if (p.found) {
          errs.push(host + '：无本插件关心的域名条目（源共 ' + p.total + ' 条）')
          logErr('[whale][ghaccel] 源无命中条目', p.url)
          opStep(op, '拉取社区源 ' + host, 'fail', '无本插件关心的域名条目（共 ' + p.total + ' 条）')
        } else {
          errs.push(host + '：' + p.err)
          opStep(op, '拉取社区源 ' + host, 'fail', p.err)
        }
      })
      pullStep.detail = '可用 ' + ok.length + '/' + order2.length + ' 个源'
        + (errs.length ? '；失败：' + errs.join('；') : '')
      okCount += ok.length
      totalEntries += ok.reduce((s, p) => s + p.total, 0)
      // 段内按源表顺序取**第一个覆盖该域名的源**（排在前面的源说了算）
      for (const d of need) {
        const src = ok.find((p) => p.found[d])
        if (src) coveredBy[d] = { ip: src.found[d], source: '社区源表 · ' + srcHost(src.url), fresh: true }
      }
    } else if (key === 'manual') {
      // 当前表作为**候选链的一环**参与：用户把它排第一就该先拿旧值去探。
      // 旧版这里错写成和 community 共用同一份源结果，导致 manual 段永远只重复检查社区源、
      // 从不真正读当前表 —— 表现就是「我把当前 IP 表排第一，日志里却一条相关步骤都没有」
      const hits = need.filter((d) => curBy[d])
      opStep(op, '当前 IP 表（手填）作为候选', hits.length ? 'done' : 'skip',
        hits.length ? '覆盖 ' + hits.length + ' 个域名' : '当前表没有这些域名的记录')
      for (const d of hits) coveredBy[d] = { ip: curBy[d], source: '当前 IP 表（手填）', fresh: false }
    }
    // 本段候选立刻探测，**探通才记入 reached** —— 短路判定必须基于「真的能用」，
    // 否则「源给了 IP 但全探测不通」会被当成已覆盖而提前收工
    // 同一 (域名,IP) 已在前面段探过就直接复用结果：多段给同一批 IP 时（实测 DoH 与手填
    // 都指向同一批死地址），旧版每段重探一遍，5s 超时 × 重复轮次纯粹白等
    const list = need.filter((d) => coveredBy[d]
      && reached[d] === undefined
      && !probedKey[d + '|' + coveredBy[d].ip])
    if (!list.length) continue
    const step = opStep(op, '探测 ' + SRC_LABEL[key] + ' 给的 IP（单个超时 ' + PROBE_TIMEOUT_MS / 1000 + 's）', 'running', '已测 0/' + list.length + ' 条')
    let done = 0
    const res = await mapLimit(list, PROBE_CONCURRENCY, (d) => probeIp(coveredBy[d].ip, d).then((r) => {
      probedKey[d + '|' + coveredBy[d].ip] = true // 探过就记，后续段同 IP 不再重复发请求
      done++
      opProgress(step, done, list.length)
      return r
    }))
    let okHere = 0
    list.forEach((d, i) => {
      // probeIp 现在返回 { ok, ms }，取 ok 判定；耗时在 refreshIps 这一层用不上（它不做排序）
      if (res[i] && res[i].ok) { reached[d] = coveredBy[d].ip; okHere++ } else probes.push(d + '（' + coveredBy[d].source + ' 给的 ' + coveredBy[d].ip + '）')
    })
    step.state = okHere ? 'done' : 'fail'
    step.detail = '可达 ' + okHere + '/' + list.length + ' 条' + (list.length - okHere ? '，' + (list.length - okHere) + ' 条不通，交给下一优先级来源' : '')
  }
  // ── github.com 内部兜底段（用户来源全跑完才轮到，优先级最低）──
  // refreshIps 与 filterReachable 是两条独立路径，兜底候选原本只在 filterReachable 里追加，
  // 导致「点刷新 IP 表」这条路径下 github.com 若被 DoH/社区源/手填全都放弃，
  // 日志里只会看到「候选链未覆盖」，4 个兜底 IP 从未被探测（实测日志：
  // 「github.com 当前 IP 表（手填）给的 IP 探测不通，旧值 20.205.243.166 复验也不通」，
  // 而 140.82.x 那批压根没出现在候选里）。
  // 这里补上同一段：只有 github.com 有兜底，且**仅当它还没探通**才发起，避免无谓请求。
  // 与 filterReachable 一样，兜底只作为「探测候选」，绝不写回 cfg.ghAccelIps
  if (reached['github.com'] === undefined) {
    const extra = GH_COM_EXTRA_IPS.filter((ip) => !probedKey['github.com|' + ip])
    if (extra.length) {
      const step = opStep(op, '探测 github.com 内部兜底候选（单个超时 ' + PROBE_TIMEOUT_MS / 1000 + 's）', 'running', '已测 0/' + extra.length + ' 条')
      let done = 0
      const res = await mapLimit(extra, PROBE_CONCURRENCY, (ip) => probeIp(ip, 'github.com').then((r) => {
        probedKey['github.com|' + ip] = true
        done++
        opProgress(step, done, extra.length)
        return r
      }))
      const hitIdx = res.findIndex((r) => r && r.ok)
      if (hitIdx >= 0) {
        reached['github.com'] = extra[hitIdx]
        coveredBy['github.com'] = { ip: extra[hitIdx], source: '内部兜底', fresh: true }
        step.state = 'done'
        step.detail = '可达 ' + extra[hitIdx] + '，写入 hosts'
      } else {
        step.state = 'fail'
        step.detail = extra.length + ' 条兜底 IP 全不通，github.com 未写入'
      }
    }
  }
  // ── 旧值兜底 ──
  // 候选链全跑完仍有域名没探通，且当前表里有旧值 → 再给旧值一次机会。
  // **旧值不能想当然沿用**：旧值同样可能是早已失效的死地址（上一次刷新留下的、或手填后网络
  // 环境变了），直接写回去会让 hosts 里留一条解析不通的映射 —— 比不写更糟（不写至少能回落到
  // DNS 真实解析）。故旧值也要过同一套 probeIp：通了才沿用，不通就**不写这个域名**。
  // 已在 manual 段探过同一 (域名,IP) 的跳过（manual 段给的本来就是旧值，结果已记在 probes 里）
  const fallbackList = GH_DOMAINS.filter((d) => !reached[d] && curBy[d]
    && (!coveredBy[d] || coveredBy[d].fresh) && !probedKey[d + '|' + curBy[d]])
  const dropList = GH_DOMAINS.filter((d) => !reached[d] && !curBy[d])
  // 旧值已在前面段探过（本次不重探）的域名：结果同为「不通」，直接计入放弃清单
  const oldProbed = GH_DOMAINS.filter((d) => !reached[d] && curBy[d] && probedKey[d + '|' + curBy[d]])
  let fbStep = null
  let fbProbed = 0
  const fbRes = fallbackList.length
    ? await mapLimit(fallbackList, PROBE_CONCURRENCY, (d) => {
      fbStep = fbStep || opStep(op, '候选不通的域名改测当前表旧值', 'running', '已测 0/' + fallbackList.length + ' 条')
      return probeIp(curBy[d], d).then((r) => {
        probedKey[d + '|' + curBy[d]] = true
        fbProbed++
        opProgress(fbStep, fbProbed, fallbackList.length)
        return r
      })
    })
    : []
  const keptOld = {} // 旧值探测通过、可沿用的域名
  const dropped = [] // 旧值也不通（或压根没有旧值）→ 不写这个域名
  fallbackList.forEach((d, i) => {
    if (fbRes[i] && fbRes[i].ok) keptOld[d] = curBy[d]
    else dropped.push(d + '（' + curBy[d] + '）')
  })
  dropList.forEach((d) => dropped.push(d + '（无旧值）'))
  oldProbed.forEach((d) => dropped.push(d + '（' + curBy[d] + '，本轮已探过不通）'))
  if (fbStep) {
    fbStep.state = 'done'
    fbStep.detail = '旧值可用 ' + Object.keys(keptOld).length + ' 条'
      + (dropped.length ? '，不可用 ' + dropped.length + ' 条（这些域名不写入）' : '')
  }
  const oldUsed = Object.keys(keptOld)
  const ips = normIps(GH_DOMAINS.map((d) => ({ domain: d, ip: reached[d] || keptOld[d] })))
  const freshCount = Object.keys(coveredBy).length
  const unreachableCount = probes.length
  const droppedCount = dropped.length
  log('[whale][ghaccel] IP 表刷新成功', freshCount, '条 / DoH 命中', dohHit, '条 / 成功源', okCount, '/', order2.length,
    '共', totalEntries, '条目标条目', '候选不通', unreachableCount, '条 / 沿用旧值', oldUsed.length, '条 / 放弃', droppedCount, '条')
  // 来源追踪：刷新用到的源 + 各域名表内值来自哪一层。来源字符串**点名具体出处**
  // （同一域名可能来自排在第二位的源，只写「社区源表」看不出用户自定义顺序有没有生效）
  lastTrace.at = Date.now()
  lastTrace.refreshUrl = pulledHosts.length ? pulledHosts.join(' , ') : '（本次未拉取社区源）'
  GH_DOMAINS.forEach((d) => {
    const hit = coveredBy[d]
    // 候选给了 IP 但探测不通 = 已被丢弃，这里如实写出后续怎么处理的 ——
    // 沿用旧值要说清「旧值也验过」，放弃要说清「没写」，都不能让用户以为表里是候选那个值
    if (reached[d]) {
      lastTrace.byDomain[d] = { ip: reached[d], source: hit ? hit.source : '当前 IP 表（手填）' }
      return
    }
    if (keptOld[d]) {
      lastTrace.byDomain[d] = { ip: keptOld[d], source: '当前 IP 表（手填，旧值复验可用）' }
      return
    }
    const why = hit ? hit.source + ' 给的 IP 探测不通' : '候选链未覆盖'
    lastTrace.byDomain[d] = {
      ip: '',
      source: curBy[d]
        ? why + '，旧值 ' + curBy[d] + ' 复验也不通，未写入'
        : why + '，且当前表也没有此域名，未写入',
    }
  })
  // 表龄提醒的依据：成功刷新即更新，失败不动。
  // 单独 try/catch：patchConfig 写失败会抛错（见 store.js），但「表龄记不上」远轻于「刷新结果丢掉」——
  // 这次已经探到的可达 IP 必须照样返回，否则用户点一次刷新却拿到异常，白等一轮探测
  try {
    patchConfig({ ghAccelRefreshedAt: Date.now() })
  } catch (e) {
    logErr('[whale][ghaccel] 记录 IP 表龄失败（不影响本次刷新结果）', (e && e.message) || '')
  }
  const untouched = GH_DOMAINS.length - freshCount
  opStep(op, '按来源优先级合并为新的 IP 表', 'done', '候选链覆盖 ' + freshCount + ' 个域名（DoH 命中 ' + dohHit
    + ' 个，可用社区源 ' + okCount + ' 个）'
    + (unreachableCount ? '，' + unreachableCount + ' 个候选探测不通' : '')
    + (oldUsed.length ? '，其中 ' + oldUsed.length + ' 个旧值复验可用已沿用' : '')
    + (droppedCount ? '，' + droppedCount + ' 个旧值也不通（或没有旧值）未写入' : '')
    + (untouched ? '；候选链未覆盖 ' + untouched + ' 个域名' : ''))
  return { ok: true, updated: ips, total: totalEntries, skipped: untouched, unreachable: unreachableCount, dropped: droppedCount }
}

// ──────────────────────────────────────────────
// UAC 提权写 hosts
// ──────────────────────────────────────────────
// PowerShell 双引号字符串里 ` 是转义符，反斜杠是字面量
function psStr(s) {
  return '"' + String(s).replace(/`/g, '``').replace(/"/g, '`"') + '"'
}
// 提权脚本只做四件事：首次备份原 hosts → 用父进程算好的文件覆盖 → 刷新 DNS 解析缓存 → 写结果文件。
// 不做任何 hosts 内容处理 —— 内容处理在父进程按字节做完，避免提权进程里解码/编码出错。
//
// 为什么必须刷 DNS 缓存（ipconfig /flushdns）：hosts 改了不等于立刻生效。Windows 的 DNS Client
// 服务会把解析结果缓存起来，浏览器 / git 还会各自再缓存一层 —— 不刷的话用户点完开启，访问
// github.com 很可能仍走缓存的旧（被污染的）IP，看到的现象就是「明明显示已开启，却还是打不开」。
// 放在提权脚本里是因为它必须在覆盖 hosts **之后**执行（顺序不能错），且 flushdns 需要管理员权限；
// 提权进程本来就只弹一次 UAC，顺带做掉，不额外弹第二次。
// 用 `| Out-Null` 吞掉 ipconfig 输出，避免污染结果文件之外的 stdout；失败也不影响主流程 ——
// 缓存最坏就是多存活一会儿，下次自然过期，不该因此判写入失败。
function buildElevatePs1(srcPath, backupPath, resultPath) {
  return [
    '$ErrorActionPreference = "Stop"',
    '$src = ' + psStr(srcPath),
    '$backup = ' + psStr(backupPath),
    '$result = ' + psStr(resultPath),
    'try {',
    '  if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath "' + HOSTS_PATH.replace(/"/g, '`"') + '" -Destination $backup -Force }',
    '  Copy-Item -LiteralPath $src -Destination "' + HOSTS_PATH.replace(/"/g, '`"') + '" -Force',
    '  try { ipconfig /flushdns 2>&1 | Out-Null } catch {}',
    '  [System.IO.File]::WriteAllText($result, "ok")',
    '} catch {',
    '  try { [System.IO.File]::WriteAllText($result, "fail:" + $_.Exception.Message) } catch {}',
    '  exit 1',
    '}',
  ].join('\r\n')
}
// action: 'enable' | 'disable'；返回 Promise<{ ok, canceled?, already?, error? }>
// async + 内部 new Promise：读 hosts 与写临时文件都要 await（异步 fs，见 readHostsBuf 的说明）
async function applyHostsBlock(action, ips, op) {
  return new Promise((resolve) => {
    if (!WIN) {
      resolve({ ok: false, canceled: false, error: '仅支持 Windows' })
      return
    }
    // 父进程按字节算好「新 hosts」：enable = 删旧块后在文件最前重写块；disable = 只删块
    void (async () => {
    let next
    let prevLen = 0
    try {
      const cur = await readHostsBuf()
      prevLen = cur.length
      next = action === 'enable' ? prependBlock(stripBlock(cur), ips) : stripBlock(cur)
    } catch (err) {
      logErr('[whale][ghaccel] 计算新 hosts 内容失败', err && err.message)
      opStep(op, '计算新的 hosts 内容', 'fail', (err && err.message) || String(err))
      resolve({ ok: false, canceled: false, error: '处理 hosts 内容失败：' + ((err && err.message) || err) })
      return
    }
    opStep(op, '计算新的 hosts 内容', 'done', action === 'enable' ? '在原文件最前插入标记块（' + ips.length + ' 条域名）' : '移除标记块')
    if (action === 'disable' && next.length === prevLen) {
      // hosts 里本来就没有本插件的块：无事可做，不弹 UAC
      opStep(op, '检查 hosts 里的标记块', 'skip', '没有本插件写入的块，无需提权')
      resolve({ ok: true, canceled: false, already: true })
      return
    }
    opStep(op, '弹出 UAC 提权写 hosts', 'running', '需在系统弹窗点「是」')
    const stamp = 'whale-ghaccel-' + process.pid + '-' + Date.now()
    const scriptPath = path.join(os.tmpdir(), stamp + '.ps1')
    const srcPath = path.join(os.tmpdir(), stamp + '.hosts')
    const resultPath = path.join(os.tmpdir(), stamp + '.result')
    const cleanup = () => {
      for (const p of [scriptPath, srcPath, resultPath]) fs.rm(p, { force: true }, () => {})
    }
    try {
      // 异步写：临时 hosts 文件可能有几 KB，同步写同样会冻住渲染线程
      await Promise.all([
        fs.promises.writeFile(srcPath, next),
        fs.promises.writeFile(scriptPath, buildElevatePs1(srcPath, hostsBackupPath(), resultPath)),
      ])
    } catch (err) {
      logErr('[whale][ghaccel] 写临时文件失败', err && err.message)
      cleanup()
      resolve({ ok: false, canceled: false, error: '无法创建临时文件：' + ((err && err.message) || err) })
      return
    }
    // -Verb RunAs 触发 UAC；-Wait 等提权进程结束，-PassThru 才能拿到退出码
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
    const ps = '$p = Start-Process -FilePath ' + q(psExe())
      + ' -ArgumentList ' + ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath].map(q).join(',')
      + ' -Verb RunAs -Wait -PassThru; exit $p.ExitCode'
    execFile(psExe(), ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'buffer', timeout: 120000 }, async (err, so, se) => {
      let result = ''
      // 结果文件极小，但这里仍在渲染线程上，统一用异步读避免同步 IO
      try { result = (await fs.promises.readFile(resultPath, 'utf8')).trim() } catch (err2) {}
      cleanup()
      const own = String(Buffer.isBuffer(so) ? so : so || '') + String(Buffer.isBuffer(se) ? se : se || '')
      if (result) {
        if (/^ok\b/.test(result)) {
          log('[whale][ghaccel] hosts 标记块', action === 'enable' ? '已写入' : '已移除')
          opStep(op, '提权进程写 hosts', 'done', action === 'enable' ? '标记块已写入文件最前，已刷新 DNS 缓存' : '标记块已移除，已刷新 DNS 缓存')
          resolve({ ok: true, canceled: false })
        } else {
          const msg = result.replace(/^fail:?/, '').trim()
          logErr('[whale][ghaccel] 提权写 hosts 失败', msg || '未知错误')
          opStep(op, '提权进程写 hosts', 'fail', msg || '未知错误')
          resolve({ ok: false, canceled: false, error: msg || '提权写 hosts 失败（请确认是管理员账户）' })
        }
        return
      }
      // 没有结果文件：UAC 被取消（点了「否」）或提权进程根本没起来
      const canceled = /cancel|取消|拒绝访问|access is denied|access denied/i.test(own)
      if (canceled) {
        opStep(op, '提权进程写 hosts', 'fail', 'UAC 弹窗被取消')
        resolve({ ok: false, canceled: true, error: 'UAC 提权被取消（弹窗里点了「否」），可重试并在弹窗点「是」' })
      } else {
        logErr('[whale][ghaccel] 提权进程未产出结果', own)
        opStep(op, '提权进程写 hosts', 'fail', '提权进程未完成' + (own ? '：' + own.slice(0, 120) : ''))
        resolve({ ok: false, canceled: false, error: '提权进程未完成' + (own ? '：' + own.slice(0, 120) : '') })
      }
    })
    })()
  })
}

// ──────────────────────────────────────────────
// 写入前连通性探测（静态 hosts 零容错：一条死 IP 会让域名连不上且不回落 DNS，必须筛掉）
// ──────────────────────────────────────────────
// 单 IP 探测超时。所有候选都在同一批里探测（限并发 mapLimit，见 PROBE_CONCURRENCY），整批的
// 等待时间就等于**最慢的那个候选**，所以这个值直接决定「点开启后要等多久」，必须谨慎取。
//
// 历史教训（2026-09，用户网络）：超时曾放宽到 8s，因为实测 140.82.112.4 / 140.82.121.3
// 能回 200 但整体要 4~5s（connect 快、首包慢），140.82.116.3 连 connect 就要 3.2s ——
// 超时太短会把这类「慢但能用」的 IP 误杀，域名整个被丢出块、退回 DNS 污染。
//
// 但 8s 的代价是每次开启固定等到最慢候选超时，用户感受就是「每次都好慢」。折中到 4.5s：
//  - 保住上面那批 3.2~4.5s 的慢 IP（这是当初放宽的理由，不能回退到 2s 那种激进值）；
//  - 同时砍掉「8s 全黑等」——超过 4.5s 无响应的基本是黑洞/被墙地址。
// 真正让开启变快的是下面 DOH_URLS 减半（去掉串行瓶颈），不是靠压这个值。
const PROBE_TIMEOUT_MS = 4500
// 探测的并发上限。本模块所有代码跑在渲染进程主线程（services.js 把 lib/settings 直接挂 window，
// 是同进程直调而非 IPC），把上百个候选一次性全推出去会让主线程连续处理成百上千次 socket 事件与
// TLS 握手回调，Vue 的渲染被挤到队尾 —— 表现就是「点一下开启/刷新整个设置页卡住」。
// 取 6：足以让「等待时间 ≈ 最慢的那个候选」这个前提继续成立（单批瞬时完成，总耗时几乎不变），
// 同时把瞬时在飞请求数压到一个主线程能从容消化的量级
const PROBE_CONCURRENCY = 6
// github.com 的兜底候选（真实 A 记录）：源表（GitHub520）给它的 IP
// 在部分网络（尤其 140.82.x / 部分 20.205.x）会被墙或不是该域名的边缘，实测备这几个仍可达的。
// 不进设置页 IP 表：表里保持「一行一域名」，兜底只在内部分配候选链时追加。
// 这批 IP 跨多个网段（GitHub 自有 140.82.x 与 Azure 的 20.x），**不标注具体地区** ——
// 早期注释把它们统称「Azure 亚洲边缘」，对 140.82.121.x 这种美国机房段是错的，
// 会让人误判「用了亚洲节点应该很快」。这里的取舍是「保证打得开」，快慢交给实测延迟排序
const GH_COM_EXTRA_IPS = ['140.82.112.4', '140.82.121.3', '20.27.177.113', '20.200.245.247']
// 单个 IP 探测：发真实 HTTPS GET（SNI 带域名）。用 HTTP 状态区分「可达」与「错误边缘」：
//  - 任何域名：400/5xx/超时/断连 = 此 IP 不服务该域名或不可达，拒收。纯 TLS 握手测不出这层
//    （同一 Azure IP 上 api.github.com 握手成功且 200，github.com 的 SNI 却回 400），写进
//    hosts 浏览器照样打不开，所以必须看 HTTP 状态。
//  - github.com 主站：只认 2xx/3xx —— 20.205.243.167/.162 对 github.com 回 403/404，都是
//    错误边缘，4xx 绝不能写。
//  - 内容域名（objects / user-images / camo / assets / uploads / githubapp）在正确的
//    185.199.108.133 内容边缘上，根路径 GET 回 404/403 是**正常**的（没路径当然 404），
//    只认 2xx/3xx 会把它们误杀丢出块 → 网页资产全加载不出来，故其它域名 4xx 也收。
// 证书 SAN 匹配：
// 证书里的 DNS 名与目标域名精确相等，或 `*.example.com` 通配匹配，才算「这个 IP 真的是该域名的边缘」。
// 为什么必须自己比：一个 IP 可能完成 TLS 握手、甚至回 200，但证书是别家域名的（被劫持 / 错误边缘）。
// 这类 IP 写进 hosts 后浏览器会因证书不匹配直接拦死 —— 比 4xx 更隐蔽，只看 HTTP 状态抓不出来。
function certMatchesDomain(cert, domain) {
  if (!cert || !domain) return false
  const cn = cert.subject && cert.subject.CN
  if (cn && (cn === domain || (cn[0] === '*' && domain.endsWith(cn.slice(1))))) return true
  const san = cert.subjectaltname || ''
  // subjectaltname 形如 "DNS:github.com, DNS:*.github.com, IP Address:1.2.3.4"
  return san.split(',').some((part) => {
    const name = part.trim().replace(/^DNS:/i, '')
    if (!/^DNS:/i.test(part.trim())) return false
    if (name === domain) return true
    return name[0] === '*' && domain.endsWith(name.slice(1))
  })
}
// 探测结果从布尔扩成 { ok, ms }：ms 是「从发起请求到拿到可用响应」的耗时，
// 用于同优先级内按实测延迟排序（hosts 是 first-match，排前面的 IP 就是实际生效的那个）。
// 不可达时 ms 记为 0 —— 调用方只对 ok 的项比较耗时，给个 0 免得漏出 undefined 参与运算
const PROBE_FAIL = { ok: false, ms: 0 }
function probeIp(ip, servername) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const req = https.request({
      host: ip, port: 443, servername: servername, path: '/', method: 'GET',
      // rejectUnauthorized 置 false：这里 host 填的是 IP，Node 会用 IP 去比证书名，
      // 必然报 ERR_TLS_CERT_ALTNAME_INVALID。域名匹配改由上面的 certMatchesDomain 手工按
      // servername 判（见上面的 certMatchesDomain），因此这里必须放行。
      rejectUnauthorized: false, timeout: PROBE_TIMEOUT_MS,
      // host 填的是 IP，这里必须显式把 Host 头指回域名，边缘按 Host+SNI 路由
      headers: { host: servername, 'user-agent': 'whale-ghaccel-probe/1.0' },
      // 显式关掉 keep-alive：本探测是一次性的短连接，复用池没有收益，
      // 反而会留下半死 socket 被后续请求捡到，造成「明明能通却报错」的假失败
      agent: false,
    })
    let certOk = false
    req.once('socket', (socket) => {
      socket.once('secureConnect', () => {
        try {
          certOk = certMatchesDomain(socket.getPeerCertificate(), servername)
        } catch (err) { certOk = false }
      })
    })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { req.destroy() } catch (err) {}
      // 耗时在这里取：整个请求的耗时由「拿到响应」那一刻决定，destroy 之后的清理不计入
      resolve(ok ? { ok: true, ms: Date.now() - t0 } : PROBE_FAIL)
    }
    req.once('response', (res) => {
      const sc = res.statusCode
      const statusOk = servername === 'github.com'
        ? (sc >= 200 && sc < 400)                       // 主站：4xx 全是错误边缘
        : (sc >= 200 && sc < 500 && sc !== 400)         // 其它域名：内容域根路径 404/403 正常
      // 证书 SAN 必须也匹配：能回 200 但证书是别家域名的 IP，写进 hosts 浏览器照样打不开。
      // 两个条件都满足才算这个 IP 真能服务该域名。
      finish(statusOk && certOk)
    })
    req.once('timeout', () => finish(false))
    req.once('error', () => finish(false))
    req.end()
  })
}
// DoH 实时 A 记录（思路：每次动态解析，换新鲜 IP；多个 resolver
// 并集）：静态列表（GitHub520 源表 / 手填表）会过期，真实 A 记录才是当天最新的。
//
// 入口选取（2026-09 实测修正，推翻了旧注释的结论）：
//  - **阿里 223.5.5.5 放在第一位**。旧版只有 Cloudflare + Google，注释写「国内 DoH 实测返回的
//    就是被污染的 IP，故不用」—— 这个结论不成立：实测阿里 DoH 对 github.com 返回
//    20.205.243.166、api.github.com 返回 20.205.243.168、raw.githubusercontent.com 返回
//    185.199.111.133 等，与系统解析及社区源表一致，没有污染。当初大概率是在别的网络环境下
//    观察到一次异常就写死了结论。
//  - 更关键的是**国外两家在很多网络上根本连不上**：实测 1.1.1.1 / 1.0.0.1 / 8.8.8.8 /
//    8.8.4.4 的 :443 全部不通（TCP 就握不上手，不是解析问题），而 223.5.5.5 通。
//    此时旧版 DOH_URLS 是「全灭」状态 —— DoH 实时解析永远返回空，日志却只报
//    「未取到 A 记录」，用户误以为是网络抖动，实际是入口被墙。
//  - 保留国外两家作为备用：换到能连通它们的网络（海外 / 公司网）时仍能生效，且多一家
//    就多一份 A 记录并集，代价只是几个并发请求。
// 入口间是**并发竞速**关系：任一入口先出结果即可用，连不上的入口只会拖慢它自己，
// 不再像旧版那样「等最慢的那个」（旧版 1.1.1.1 空等 2.5s 才轮到结果）。
const DOH_URLS = [
  'https://223.5.5.5/resolve',
  'https://1.1.1.1/dns-query',
  'https://dns.google/resolve',
]
// 单个 DoH 入口的超时。**必须显著小于 PROBE_TIMEOUT_MS(4.5s)**：DoH 是开启/刷新链路最前端
// 的串行瓶颈（必须等它出结果才建候选链），而入口数量现在是 3 个，若每个都放到 4.5s，
// 「三家全不通」的最坏情况就是 4.5s 纯等待。实测阿里正常响应在 100~300ms，
// 国外入口连通时也是几百毫秒级，2s 足够；超时即放弃这家，其余入口照常。
const DOH_TIMEOUT_MS = 2000
// 实时解析哪些域名：挑「主站 + 高频 API/内容入口 + 源表覆盖差的域名」，并非全部 GH_DOMAINS。理由：
//  - github.com 是主站，必须最可靠（它的候选链前端插 DoH 结果）；
//  - api / raw / objects / codeload 是 git 操作与下载的主路径，静态表最易过时；
//  - gist 两个域名同样如此：gist 内容走 gist.githubusercontent.com，源表覆盖时有时无；
//  - user-images / avatars / camo 是 README 与头像的实际落点：源表给的多是 185.199.108.133
//    这类「内容边缘」共享地址，实测常给出不服务该域名的 IP（能连、证书却是别家的），
//    纳入 DoH 后用实时 A 记录把正确边缘顶到候选链最前，比只靠源表稳；
//  - 其余（github.githubassets / github.dev / github.io / education 等）低频或走 CDN 通配证书，
//    IP 变化小，DoH 收益低而请求数线性增长。
// 每个域名仍走全部 DOH_URLS，解析结果并集去重后进候选链。
const DOH_DOMAINS = [
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'codeload.github.com',
  'gist.github.com', 'gist.githubusercontent.com',
  'avatars.githubusercontent.com', 'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
]
// DoH 入口 → 人话名字：来源列要写到「从哪个解析商拿的」，直接摆 URL 太长，
// 这里按 base URL 反查厂商简称（同一厂商的域名入口与直连 IP 入口归到同一名字）
const DOH_NAMES = [
  [/223\.5\.5\.5|223\.6\.6\.6|alidns|aliyun/i, '阿里 DNS'],
  [/1\.1\.1\.1|1\.0\.0\.1|cloudflare/i, 'Cloudflare'],
  [/dns\.google|8\.8\.8\.8/i, 'Google'],
]
function dohName(entry) {
  for (const [re, name] of DOH_NAMES) if (re.test(entry)) return name
  return entry.replace(/^https?:\/\//, '').split('/')[0]
}
function dohUrl(base, domain) {
  return base + '?name=' + domain + '&type=A'
}
const DOH_TTL_MS = 5 * 60 * 1000
// 缓存结构改成 { at, byDomain, originByIp }：分域名缓存，某个域名解析失败不影响其它域名的缓存。
// originByIp 记录「每个 IP 是哪个 DoH 厂商给的」——同一域名多个厂商并集，光存 IP 看不出出处
let dohCache = { at: 0, byDomain: {}, originByIp: {} }
// 解析单个域名：返回 { ips, resolvers, originByIp, fails }
//  - resolvers：成功返回 A 记录的 DoH 入口（含完整 URL，日志用）
//  - originByIp：IP → 厂商简称（来源列用；同一 IP 被多家解析出时保留先到者）
//  - fails：失败入口的原因清单（厂商简称 → 原因）。**不能让失败静默**：旧版把「入口被墙」
//    和「域名真没有 A 记录」都归成空的 ips，上层只能笼统报「未取到 A 记录」，用户看到的是
//    「网络抖动、再试一次就好」，实际是这台机器上国外 DoH 入口根本连不上（实测 1.1.1.1 /
//    8.8.8.8 的 :443 全不通）。分开报才能让用户看出该换入口还是该换网络。
async function dohResolveDomain(domain) {
  const ips = []
  const seen = new Set()
  const resolvers = []
  const originByIp = {}
  const fails = []
  await Promise.all(
    DOH_URLS.map((base) =>
      fetch(dohUrl(base, domain), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(DOH_TIMEOUT_MS) })
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json()
        })
        .then((j) => {
          if (!j || !Array.isArray(j.Answer)) throw new Error('无 Answer 字段')
          let got = 0
          for (const a of j.Answer) {
            const ip = String((a && a.data) || '')
            if (isIpv4(ip)) {
              if (!originByIp[ip]) originByIp[ip] = dohName(base)
              if (!seen.has(ip)) { seen.add(ip); ips.push(ip); got++ }
            }
          }
          // Answer 存在但里面没有 A 记录（只有 CNAME / AAAA）= 该域名确实没解析出 IPv4
          if (!got) throw new Error('无 A 记录')
          resolvers.push(dohUrl(base, domain))
        })
        // 单个 resolver 失败不影响其它入口（它们仍可能给结果），但原因要留痕
        .catch((err) => {
          const why = String((err && err.message) || err)
          const reason = /timeout|abort/i.test(why) ? '超时 ' + DOH_TIMEOUT_MS / 1000 + 's' : why
          fails.push({ name: dohName(base), reason: reason })
          logErr('[whale][ghaccel] DoH 入口失败', dohName(base), domain, reason)
        })
    )
  )
  return { ips: ips, resolvers: resolvers, originByIp: originByIp, fails: fails }
}
// 解析全部 DOH_DOMAINS（限并发），返回 { [domain]: IP[] }；同时更新来源追踪
// force=true 跳过 TTL 缓存重新解析：verifyIps 要的是「此刻的真实 A 记录」，用几分钟前的
// 缓存去否定用户手填的 IP 会得出错误结论
async function dohIps(force) {
  const now = Date.now()
  if (!force && now - dohCache.at < DOH_TTL_MS) return dohCache.byDomain
  // 逐域名限并发：DOH_DOMAINS 有 10 个、每个再扇出 3 个入口，一次全推出去就是 30 条请求同时
  // 冲击渲染进程主线程（同 mapLimit 的理由）。域名之间互不依赖，慢的排后面不影响总耗时
  const results = await mapLimit(DOH_DOMAINS, PROBE_CONCURRENCY, (d) => dohResolveDomain(d))
  const byDomain = {}
  const originByIp = {}
  const resolvers = []
  // 失败汇总：同一入口对 10 个域名各失败一次，按「入口 → 原因」去重后才是用户要看的结论
  const failMap = {}
  DOH_DOMAINS.forEach((d, i) => {
    const r = results[i]
    for (const f of r.fails) {
      const k = f.name + '：' + f.reason
      failMap[k] = (failMap[k] || 0) + 1
    }
    if (r.ips.length) {
      byDomain[d] = r.ips
      Object.assign(originByIp, r.originByIp)
      resolvers.push.apply(resolvers, r.resolvers)
      log('[whale][ghaccel] DoH 解析', d, '得', r.ips.join(', '))
    }
  })
  // 失败清单存内存态（不落盘，随 dohCache 一起被下次解析覆盖），供 dohIps 的调用方如实写日志
  dohFails = Object.keys(failMap).map((k) => k + '（' + failMap[k] + '/' + DOH_DOMAINS.length + ' 个域名）')
  if (Object.keys(byDomain).length) {
    dohCache = { at: now, byDomain: byDomain, originByIp: originByIp }
    // 来源追踪：记录这次实时解析实际返回结果的 DoH 入口与逐域名 IP
    lastTrace.dohResolvers = resolvers
    lastTrace.dohByDomain = Object.assign({}, byDomain)
    lastTrace.dohOrigin = Object.assign({}, originByIp)
  }
  return byDomain
}
// 上一次 DoH 全量解析的失败清单（人话短句），供「未取到 A 记录」时补充真实原因。
// 空数组 = 入口都通、只是这批域名没解析出 A 记录 —— 与「入口连不上」是两种完全不同的处置
let dohFails = []
function dohFailText() {
  return dohFails.length ? '；入口失败：' + dohFails.join('；') : ''
}
// 逐域名选可达 IP：候选链 = 用户排序的三来源（默认 DoH > 社区源表/手填表）> github.com 内部兜底，
// 同一 (域名,IP) 只测一次。没有内置快照兜底：源表某域名给了被墙的 IP（GitHub520 每天更新、
// 总有人给你墙掉的地址）时，该域名可能整个落选 —— 这是刻意的取舍，宁可不写这条也不要长期
// 写一批可能过时的地址（过时地址实测就是「写进去了但打不开」，比不写更难排查）。
// srcOpt.srcKey / srcOpt.skipSrc 供「补测」这一轮使用：把新候选标成来源 K 但不重复打来源行、
// 并把这几条候选整体前移到该来源应有的位置（否则补测的社区源候选会排到 DoH 之后，
// 用户设的「源表优先」在补测轮里就静默失效了）
async function filterReachable(ips, op, srcOpt) {
  const list = normIps(ips)
  const byDomain = {}
  for (const it of list) if (it && it.domain && !byDomain[it.domain]) byDomain[it.domain] = it.ip
  // 用户选的三来源开关，缺省全开（与配置层 normGhAccelSrc 默认口径一致）。
  // 参数名用 srcOpt 而非 src：函数下方 `const src = []` 是候选链的来源标记数组，
  // 同名会遮蔽参数、且 const 在同一作用域内会直接抛 TDZ 错误
  const s = srcOpt && typeof srcOpt === 'object' ? srcOpt : {}
  const useDoh = s.doh !== false
  const useManual = s.manual !== false
  // 候选链优先级由用户决定（s.order），缺省 = 改动前的固定顺序 doh > community > manual。
  // 归一化在这里做：store 只存数组，去重与补齐由本模块负责
  const order = normSrcOrder(s.order)
  // 补测轮：srcKey = 本轮候选的统一来源标记，只把新 IP 挂到该段；skipSrc = 不再重复打来源行
  const srcKey = s.srcKey || ''
  // 关掉 DoH 时不再发起实时解析（既省掉「域名数 × 2」的请求扇出，也避免用户
  // 「我只要手填的 IP」时还偷偷混进实时结果）；传空对象让下面的候选链自然跳过
  const dohBy = useDoh ? await dohIps() : {}
  if (!s.skipSrc) {
    opStep(op, 'DoH 实时解析 ' + DOH_DOMAINS.join('、'), !useDoh ? 'skip' : (Object.keys(dohBy).length ? 'done' : 'skip'),
      !useDoh ? '已按设置关闭 DoH 实时解析' : (Object.keys(dohBy).length ? Object.keys(dohBy).map((d) => d + ' → ' + dohBy[d].join('/')).join('；') : '未取到 A 记录，改用源表/当前表' + dohFailText()))
    opStep(op, '候选链优先级', 'done', order.map((k) => SRC_LABEL[k]).join(' > '))
  }
  // IP → DoH 厂商：来源列要写到「这个 IP 是哪家解析出来的」，不能只写「DoH 实时解析」
  const dohOrigin = dohCache.originByIp || {}
  const cands = []
  const seenKey = new Set()
  for (const d of GH_DOMAINS) {
    const chain = []
    const src = [] // 与 chain 一一对应的来源标记（来源追踪用）
    const push = (ip, source) => {
      if (!ip || chain.includes(ip)) return
      chain.push(ip)
      src.push(source)
    }
    // 按用户排序逐段拼接：排在前面的来源先入链 = 优先级更高（hosts 同域名多行按顺序 first-match）。
    // 每一段内部仍是原有语义 —— DoH 实时 A 记录最新鲜；传入表（社区源表/手填）降权；
    // github.com 内部兜底恒为最后一位，不参与排序（它只是「探测时多一个候选」，不是用户可选来源）
    for (const key of order) {
      if (key === 'doh') {
        if (!useDoh) continue
        // 来源里点名是哪个 DoH 入口给的（dohBy[d] 只存 IP，这里按 IP 反查 dohOrigin 拿出处）
        for (const ip of dohBy[d] || []) push(ip, 'DoH 实时解析 · ' + (dohOrigin[ip] || 'cloudflare/google 等'))
      } else if (key === 'community' || key === 'manual') {
        if (!useManual || !byDomain[d]) continue
        // 传入表若刚由 refreshIps 产出，沿用其来源（社区源表/当前表）；否则按配置表算。
        // 传入表只有一份，故 order 里 community / manual 谁在前就挂在谁名下，另一个不再重复入链
        const prev = lastTrace.byDomain[d]
        const source = srcKey ? key + '\u0000' + srcKey : (prev && prev.ip === byDomain[d] ? prev.source : '当前 IP 表（手填）')
        push(byDomain[d], source)
        break
      }
    }
    // github.com 再追加内部兜底候选（见 GH_COM_EXTRA_IPS），放最后一位优先级最低。
    // 兜底**不影响用户表**：这里只是「探测时多一个候选」，不能把兜底 IP 写回 cfg.ghAccelIps
    // （实测过旧代码这么干：用户手填的 20.205 打不开，重写一次就被换成兜底 IP，
    // 「填的 IP 用不上」且来源日志显示的也不是用户填的值）。
    // 标注只写「内部兜底」不带地区名：这批 IP 跨 140.82.x / 20.x 多个网段，
    // 原先写死的「Azure 亚洲边缘」对 140.82.121.x 这类 GitHub 美国机房段是错的，
    // 用户会据此误判延迟来源（还在排查「为什么用了这个 IP」时被误导）。
    // 兜底候选的 rank 显式给 order.length（低于一切用户来源）。**不能靠下面 src[idx] 反查** ——
    // 「内部兜底」标记里没有 \u0000 前缀，cut<0 时才 fallback 到 order.length，
    // 而 src 一旦因别的路径错位，就会把兜底候选认成某个用户来源，优先级被错误抬高
    const extraStart = chain.length
    if (d === 'github.com') for (const ip of GH_COM_EXTRA_IPS) push(ip, '内部兜底')
    chain.forEach((ip, idx) => {
      const ck = d + '\u0000' + ip
      if (seenKey.has(ck)) return
      seenKey.add(ck)
      // 来源标记可能是「优先级\u0000真实来源」的编码形式（补测轮），拆开：rank 只用于排序，
      // 真实的来源文字照常展示，不能把内部编码漏到界面上
      const mark = src[idx] || '候选链'
      const cut = mark.indexOf('\u0000')
      // 兜底候选（idx >= extraStart）的 rank 直接给 order.length：
      // 不参与用户来源排序，永远排最后。走显式判断而不是靠 mark 里没有 \u0000 来 fallback ——
      // 后者在 src 错位时会把兜底认成用户来源（见 extraStart 处注释）
      const isExtra = idx >= extraStart
      cands.push({
        domain: d,
        ip: ip,
        idx: idx,
        rank: isExtra ? order.length : (cut < 0 ? order.length : order.indexOf(mark.slice(0, cut))),
        source: cut < 0 ? mark : mark.slice(cut + 1),
      })
    })
  }
  // 探测是最耗时的一步（每个候选最长 PROBE_TIMEOUT_MS，整体耗时取决于最慢的那个），
  // 先把「running + 已测 0/n」压进日志，再逐条推进进度；否则用户看到的是一条静止的
  // 「探测中…」，不知道还要等多久
  const probeStep = opStep(op, '逐个候选 IP 做 HTTPS 探测 + 证书 SAN 校验（共 ' + cands.length + ' 个候选，单个超时 ' + PROBE_TIMEOUT_MS / 1000 + 's）', 'running', '已测 0/' + cands.length + ' 个')
  let finished = 0
  const results = await mapLimit(cands, PROBE_CONCURRENCY, (c) => probeIp(c.ip, c.domain).then((r) => {
    finished++
    opProgress(probeStep, finished, cands.length, '个')
    return r
  }))
  // 每个域名保留**所有**可达候选（按候选链顺序），而不是只留第一个。
  // 这是 hosts 方案里唯一能拿到「运行期回退」的手段：同一个域名写多行不同 IP，
  // Windows 解析按顺序取第一条 —— 首选 IP 哪天挂了，系统自动落到下一条，
  // 而不是像单条方案那样整个域名打不开且不回落 DNS（语义同「逐个候选试」）
  const byDomFinal = new Map()
  cands.forEach((c, i) => {
    const r = results[i]
    if (!r || !r.ok) return
    // 把实测耗时挂到候选上，供下面排序用（cands 是共享对象，重测轮复用同一批不会串味）
    if (!byDomFinal.has(c.domain)) byDomFinal.set(c.domain, [])
    byDomFinal.get(c.domain).push({ c: c, ms: r.ms })
  })
  // github.com 整链全失败时重测一轮：实测同一批 IP 几分钟内 200 ↔ 超时反复横跳，
  // 瞬时抖动下多一次机会；只重试主站，其余域名首轮结论不动
  if (!byDomFinal.has('github.com')) {
    const ghCands = cands.filter((c) => c.domain === 'github.com')
    if (ghCands.length) {
      const retry = await mapLimit(ghCands, PROBE_CONCURRENCY, (c) => probeIp(c.ip, c.domain))
      // 收集可达的再一次性落 Map（不用 forEach 边判边 push：那种写法靠 has() 当门闩，
      // 第一条就把键建好了，后面几条会全部漏进去，语义上等价于这里的结果但极难看懂）。
      // 注意此处**不会**与首轮结论混：能进到这个分支就说明首轮 github.com 一条都没过，
      // 所以 set 是覆盖空位、不是覆盖已有结果
      const alive = ghCands.map((c, i) => ({ c: c, ms: retry[i] ? retry[i].ms : 0 })).filter((x) => x.ms)
      if (alive.length) byDomFinal.set('github.com', alive)
    }
  }
  // 每个域名的候选按「来源优先级 → 实测延迟 → 链内位置」排序。
  // 补测轮的候选整体前移到其来源对应的位置，用户在界面里把社区源表排到第一位时，
  // 补测拿到的源表 IP 也能成为首选（而不是被固定排在 DoH 之后）。
  // **延迟排在链内位置之前**：同一来源给了多个可达 IP 时（社区源表常一次给好几条），
  // 真正决定体验的是哪个最快 —— hosts 只认第一条，把慢的写在前面＝每次访问都白等那几百毫秒。
  // 排在来源优先级之后是刻意的：用户把某来源提到第一位就该让该来源的 IP 优先，
  // 不因另一个来源恰好更快而越权（跨来源只比优先级，同来源内才比快慢）
  for (const arr of byDomFinal.values()) {
    arr.sort((a, b) => (a.c.rank - b.c.rank) || (a.ms - b.ms) || (a.c.idx - b.c.idx))
  }
  // 来源追踪：本次过滤后每个域名最终选中的 IP + 来源。byDomain 只在「选中值确实来自用户表」
  // 时才并入，避免把兜底/实时解析的结果伪装成用户的表内容
  lastTrace.at = Date.now()
  const traceBy = {}
  for (const arr of byDomFinal.values()) traceBy[arr[0].c.domain] = { ip: arr[0].c.ip, source: arr[0].c.source }
  lastTrace.byDomain = Object.assign({}, lastTrace.byDomain, traceBy)
  // 展平成写入用的 { domain, ip } 列表：同域名多行，顺序即 hosts 里的优先级
  const reach = []
  for (const arr of byDomFinal.values()) for (const x of arr) reach.push({ domain: x.c.domain, ip: x.c.ip })
  const dropped = GH_DOMAINS.length - byDomFinal.size
  const extra = reach.length - byDomFinal.size
  // 结论回填到探测那一步（替换掉过程中的「已测 n/m 个」）
  probeStep.state = 'done'
  probeStep.detail = '选中 ' + byDomFinal.size + ' 个域名' + (extra > 0 ? '（含 ' + extra + ' 条备用 IP 一并写入，主 IP 失效时系统自动回退）' : '')
    + (dropped > 0 ? '，' + dropped + ' 个域名无可达 IP 被丢弃' : '')
  log('[whale][ghaccel] 探测完成：候选', cands.length, '最终可达', reach.length, '条 / 覆盖', byDomFinal.size, '个域名')
  return reach
}

// 校验 IP 表：逐条探测（与写入前过滤共用同一套 probeIp，口径一致），把不可达的挑出来
// 供设置页「一键清掉」。刻意不在这里直接改配置：删表是破坏性操作，要由用户在设置页确认；
// 宿主只负责给出结论。判「是否已过时」用强制刷新的实时 A 记录，不用 TTL 缓存
async function verifyIps(ips, op) {
  const list = normIps(ips)
  if (!list.length) {
    opStep(op, '读取待校验的 IP 表', 'skip', 'IP 表为空')
    return { ok: true, results: [], bad: [], stale: [], checkedAt: Date.now() }
  }
  opStep(op, '读取待校验的 IP 表', 'done', list.length + ' 条')
  const dohBy = await dohIps(true)
  opStep(op, '强制刷新实时 A 记录（用于判断 IP 是否已过时）', Object.keys(dohBy).length ? 'done' : 'skip',
    Object.keys(dohBy).length ? Object.keys(dohBy).map((d) => d + ' → ' + dohBy[d].join('/')).join('；') : '未取到，仅按探测结果判定')
  // 探测是最耗时的一步（每条最长 PROBE_TIMEOUT_MS），先把「running + 已测 0/n」压进日志，
  // 再逐条推进进度；否则用户看到的是一条静止的「校验中…」，不知道还要等多久
  const probeStep = opStep(op, '逐条 HTTPS 探测（单个超时 ' + PROBE_TIMEOUT_MS / 1000 + 's）', 'running', '已测 0/' + list.length + ' 条')
  let finished = 0
  const results = await mapLimit(list, PROBE_CONCURRENCY, (it) => probeIp(it.ip, it.domain).then((r) => {
    finished++
    opProgress(probeStep, finished, list.length)
    return r
  }))
  const out = list.map((it, i) => ({ domain: it.domain, ip: it.ip, ok: !!(results[i] && results[i].ok) }))
  // 「命中当前实时 A 记录」的 IP 单独标出来：这类 IP 探测可能因瞬时抖动失败，
  // 但它正是 DNS 此刻的答案，删掉纯属误伤，界面据此不推荐删除
  const bad = out.filter((r) => !r.ok && !(dohBy[r.domain] || []).includes(r.ip))
  const stale = out.filter((r) => !r.ok && (dohBy[r.domain] || []).includes(r.ip))
  const good = out.length - bad.length - stale.length
  // 结论回填到同一个 step 上：进度文案换成最终统计，避免留下「已测 12/12 条」这种过程态
  probeStep.state = 'done'
  probeStep.detail = '可达 ' + good + ' 条 / 不可达 ' + bad.length + ' 条 / 探测失败但仍是实时 A 记录 ' + stale.length + ' 条'
  log('[whale][ghaccel] 校验 IP 表', out.length, '条，可达', good, '条，不可达', bad.length, '条，实时 A 记录但探测失败', stale.length, '条')
  return { ok: true, results: out, bad: bad, stale: stale, checkedAt: Date.now() }
}

// 开启（含「重新写入 hosts」）：op 传入时同步写操作日志，让设置页看到每一步在干什么
async function enable(ips, opts, op) {
  // 开启流程：① 拉社区源与「探测」并行起跑 → ② DoH 实时解析 + 逐 IP 探测筛可达
  // （刷新回来若首轮 github.com 未达标，再补测一轮）→ ③ 全不可达拒绝写入（不弹 UAC、不留坏块）
  // → ④ UAC 写块
  // 注意顺序：①与②必须并行，串行会让用户先干等拉源（最长 15s）再等探测 —— 这正是「每次都好慢」的主因。
  const refresh = opts && (typeof opts === 'object' ? !!opts.refresh : !!opts)
  // 来源开关与顺序：community=false 时连社区源都不拉（用户明确不要源表，不必白等 15s）
  const srcOpt = opts && typeof opts === 'object' && opts.src && typeof opts.src === 'object' ? opts.src : {}
  const useCommunity = srcOpt.community !== false
  // 三来源全关 = 候选链必然为空，直接拒绝：不弹 UAC、不留坏块，也省掉后面的白跑。
  // 这是「宁可不写也不写过时地址」取舍的延伸 —— 没有候选来源就等于没有可信 IP 可用
  if (srcOpt.doh === false && srcOpt.community === false && srcOpt.manual === false) {
    const why = '三个 IP 获取来源都被关闭，没有可用候选。请在「获取方式」里至少勾选一项后再开启'
    logErr('[whale][ghaccel] 拒绝写入 hosts：来源全关')
    opStep(op, '写入前把关', 'fail', 'IP 获取来源全关，无候选可用')
    return { ok: false, canceled: false, error: why }
  }
  let table = normIps(ips)
  opStep(op, '载入待写入的 IP 表', table.length ? 'done' : 'skip', table.length ? table.length + ' 条' : '当前 IP 表为空')
  // 并行地拉社区源（最长 15s），但**不再串行等它**：原来 refresh 后才 filterReachable，
  // 用户要连续等「拉源（可达十几秒）→ DoH 解析 → 探测」三段。现在两件事同时起跑，
  // 探测先跑完就能先出结论；源回来后再补一轮新候选的探测。
  // 为什么敢并行：社区源在候选链里已降权到 DoH 之后（见 filterReachable），它的作用只是
  // 「DoH 没覆盖时兜底 + 提供备用 IP」。首轮用当前表 + DoH 已足以判断主站是否可达，
  // 源只影响「多加几条备用」，不值得让用户为它多等十几秒。
  // 这里同样要传 srcOpt.order：只传 sources 会让这次内部刷新的候选链退回默认顺序，
  // 用户在「来源优先级」里排的序在开启流程里静默失效（手动刷新那条路径已按同一口径传）
  const freshPromise = refresh && useCommunity ? refreshIps(table, op, srcOpt.sources, srcOpt.order, srcOpt.customSources) : null
  let reachable = await filterReachable(table, op, srcOpt)
  // 源回来了：把它新给的 IP 再探一轮，补进结果（只为「该域名在首轮没达标」时才需要，
  // 若首轮已有 github.com 可达就不必再等这批备用 IP，直接用首轮结论写块）
  if (freshPromise) {
    const fresh = await freshPromise
    const needMore = !reachable.some((it) => it.domain === 'github.com')
    if (fresh.ok && needMore) {
      const merged = fresh.updated
      const have = new Set(reachable.map((it) => it.domain + '\u0000' + it.ip))
      const extra = merged.filter((it) => !have.has(it.domain + '\u0000' + it.ip))
      if (extra.length) {
        opStep(op, '用社区源新 IP 补测一轮', 'done', extra.length + ' 条新候选（首轮 github.com 未达标）')
        // srcKey 让这批候选挂到「社区源表」这一来源段、并参与用户设定的优先级排序（见 filterReachable）；
        // skipSrc 避免把「DoH 实时解析 / 候选链优先级」两行来源日志重复打一遍
        const more = await filterReachable(merged, op, { doh: srcOpt.doh, manual: srcOpt.manual, order: srcOpt.order, srcKey: 'community', skipSrc: true })
        reachable = more
      }
    } else if (fresh.ok) {
      opStep(op, '社区源已返回（首轮已达标，跳过补测）', 'skip',
        '新表 ' + fresh.updated.length + ' 条仅作后续刷新用，本次不再多等')
    }
  }
  const hasGithubCom = reachable.some((it) => it.domain === 'github.com')
  if (!reachable.length || !hasGithubCom) {
    // github.com 是主站：块里缺它等于白开——它仍走被污染的 DNS，用户看到的就是
    // 「已生效 N 个域名但 github.com 打不开」（实测踩过，13/21 写入、github.com 被丢）。
    // 因此必须等 github.com 有可达 IP 才写；其余域名再通也不写，避免假成功误导。
    const why = hasGithubCom
      ? '当前网络下这些 IP 都不可达，未写入 hosts。可能是 IP 表过时（可先点「刷新 IP 表」再重试），也可能当前网络直连 GitHub 不通'
      : 'github.com 当前所有候选 IP 都不可达，未写入 hosts（其余域名可达但主站打不开等于白开）。可稍后重试，或点「刷新 IP 表」后再开'
    logErr('[whale][ghaccel] 拒绝写入 hosts', why, '可达域名数', reachable.length, '含 github.com', hasGithubCom)
    opStep(op, '写入前把关', 'fail', hasGithubCom ? '所有候选 IP 都不可达，放弃写入' : 'github.com 无可达 IP，放弃写入（主站打不开等于白开）')
    return { ok: false, canceled: false, error: why }
  }
  const ghIpCount = reachable.filter((it) => it.domain === 'github.com').length
  opStep(op, '写入前把关', 'done', 'github.com 有可达 IP，共 ' + reachable.length + ' 条候选写入 hosts'
    + (ghIpCount > 1 ? '（github.com 含 ' + ghIpCount + ' 个 IP，做 first-match 回退）' : ''))
  const r = await applyHostsBlock('enable', reachable, op)
  // 让设置页把实际写入的表同步回配置（刷新后表可能变了）。**只回写用户表本身的 IP**：
  // 兜底 / DoH 实时解析的 IP 只是探测时的候选，一旦回写成配置，用户手填的 IP 会被悄悄替换，
  // 且来源日志里显示的也不再是用户填的值 —— 表现就是「我填的 IP 根本没用上」。
  // 判据用「该 IP 是否本来就出现在传入表里」，不能像旧代码那样按 domain 查主 IP 的来源
  // （多行回退后，同一域名的备用 IP 会被误判成主 IP 的来源而整体排除）
  if (r.ok) r.ips = reachable.filter((it) => table.some((t) => t.domain === it.domain && t.ip === it.ip))
  return r
}
function disable(op) {
  opStep(op, '准备移除 hosts 标记块', 'done', '关闭加速会完整还原开启前的 hosts 内容')
  return applyHostsBlock('disable', [], op)
}

module.exports = {
  HOSTS_PATH,
  hostsBackupPath,
  ghAccelStatus,
  ghAccelTrace,
  ghAccelSources,
  ghAccelOpLogs,
  clearGhAccelOpLogs,
  opStart,
  opStep,
  opEnd,
  scanConflicts,
  probeConnectivity,
  refreshIps,
  verifyIps,
  enable,
  disable,
  normSources, // 仅供单测：源表顺序归一化（曾漏剥 'community:' 前缀，导致用户排序静默失效）
  normCustomSources, // 仅供单测：自定义源 URL 校验 / 去重 / 上限
  srcChainLabel, // 供 settings 生成操作标题：按用户实际设置动态显示来源顺序
}
// 最近一次获取过程的来源追踪（内存态；每次开启/刷新/重写更新，重开插件即清空）
function ghAccelTrace() {
  const dohByDomain = {}
  for (const d of Object.keys(lastTrace.dohByDomain)) dohByDomain[d] = lastTrace.dohByDomain[d].slice()
  return {
    at: lastTrace.at,
    dohResolvers: lastTrace.dohResolvers.slice(),
    dohByDomain: dohByDomain,
    dohOrigin: Object.assign({}, lastTrace.dohOrigin),
    refreshUrl: lastTrace.refreshUrl,
    byDomain: Object.assign({}, lastTrace.byDomain),
  }
}
// 可选社区源表清单：设置页「自定义源表优先级」用它渲染列表（含默认顺序）。
// 同时给出当前生效顺序（用户配过则按用户的，未配过 = 默认），让界面不必自己算归一化
function ghAccelSources() {
  const cfg = readConfig()
  const src = cfg.ghAccelSrc || {}
  const custom = normCustomSources(src.customSources)
  const sources = normSources(src.sources, custom)
  return {
    all: allSources(custom).map((url) => ({ url: url, host: srcHost(url), custom: !GH_IPS_SOURCES.includes(url) })),
    order: sources,
    // 回给设置页一份校验后的自定义源清单：用户在输入框里贴的 URL 是否被接受，
    // 以宿主这份为准（设置页不做校验，避免两处规则走岔）
    custom: custom,
    max: CUSTOM_SRC_MAX,
  }
}
