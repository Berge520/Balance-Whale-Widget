/*
 * 本地持久化（CommonJS）：密钥 / 配置 / 账本 / 窗口锚点。
 */
const {
  K, MIN_SCALE, MAX_SCALE, MODEL_MAX, MODEL_TEMPLATES, DEFAULT_MAIN_MODEL, LOW_ALERT_BY_CURRENCY,
  TOKEN_PRICE_DEFAULT, TOKEN_PRICE_MAX, TOKEN_RATE_MAX, TOKEN_PRICE_MODELS_MAX, TIMER_NOTE_MAX,
  NEWEST_VERSION,
} = require('./constants')
const { logErr } = require('./log')

// GitHub 加速 IP 表归一化：domain 去空白转小写限长、ip 必须是合法 IPv4，非法条目丢弃。
// 传 null/非数组 = 空表（不再内置 IP 快照：没有拿得到新鲜 IP 的途径时，宁可不写 hosts 也不写一批
// 可能过时的地址——写入前探测会把不可达的滤掉，真正生效的只有当天可达的那些）；
// hosts.js 的写块 / 刷新结果也用它清洗（IP 表存进配置一起走备份/恢复）。
function isIpv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  return !!m && m.slice(1).every((n) => Number(n) <= 255)
}
function normIps(v) {
  if (!Array.isArray(v)) return []
  const out = []
  const seen = new Set()
  for (const it of v) {
    if (!it || typeof it !== 'object') continue
    const domain = String(it.domain == null ? '' : it.domain).trim().toLowerCase().slice(0, 253)
    // 与 domain 一样显式转字符串：源里 ip 可能是数字，声明给设置页的类型是 string，
    // 不转的话「number 漏进 string 字段」，设置页侧类型对不上
    const ip = String(it.ip == null ? '' : it.ip).trim()
    if (!domain || !isIpv4(ip) || seen.has(domain)) continue
    seen.add(domain)
    out.push({ domain: domain, ip: ip })
    if (out.length >= 64) break // 上限：挡住整段粘贴，正常域名用不到这么多
  }
  return out
}

// GitHub 加速表龄时间戳归一化：epoch ms，非法值/非正数回 0（0 = 从未刷新过）
function normGhAccelRefreshedAt(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : 0
}

// GitHub 加速「IP 获取来源」开关归一化：doh = DoH 实时解析、community = 社区源表、
// manual = 手填/现有 IP 表。三者**默认全开**（= 改动前的固定候选链行为，老用户配置里没有
// 这个键时按默认走，行为与升级前完全一致，不产生意外变化）。
// 用 !== false 而非 === true：只有这样「缺省 / 非布尔」才会落到 true 一侧。
function normGhAccelSrc(v) {
  const o = v && typeof v === 'object' ? v : {}
  return {
    doh: o.doh !== false,
    community: o.community !== false,
    manual: o.manual !== false,
    // 社区源表的**先后顺序**（用户自定义优先级）。空数组 = 用 hosts.js 的默认顺序
    // （GH_IPS_SOURCES 原序）。这里只做「字符串数组 + 去重」，不去校验 URL 是否已知 ——
    // 已知源清单是 hosts 模块的领域知识，校验在 hosts.normSources 里做
    sources: normStrList(o.sources),
    // 来源层的**候选链顺序**（doh / community / manual 谁在前）。
    // 必须单独存一个键：sources 是扁平数组、混着 'community:<url>' 子项，hosts 侧要从里面
    // 拆出「来源顺序」就得知道怎么过滤，两处约定容易走岔（旧版就是只存 sources 而没人往里
    // 找顺序，refreshIps / filterReachable 拿到的 order 恒为 undefined，一律退回写死的默认
    // 顺序 —— 用户怎么调「上移 / 下移」都不生效）。顺序在这里只做「字符串去重」，
    // 合法性（只认三个 key、缺失补末尾）由 hosts.normSrcOrder 兜底
    order: normStrList(o.order),
    // 用户自定义源 URL 清单。同样只做「字符串数组 + 去重」，**URL 合法性由
    // hosts.normCustomSources 校验**（是否 http(s)、是否合法绝对 URL、数量上限）：
    // 配置可被手改 / 从备份恢复，这里放行任何字符串等于让一个随便的串被直接 fetch
    customSources: normStrList(o.customSources),
  }
}
// 字符串数组归一化：去非字符串、去空串，保序去重
function normStrList(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const s of v) {
    const t = typeof s === 'string' ? s.trim() : ''
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

// ──────────────────────────────────────────────
// 密钥
// ──────────────────────────────────────────────
// 模型密钥槽位：{ [模型 id]: key }。一模型一份密钥 —— 同厂商的不同模型余额来源不同
// （如 Moonshot 大陆站与国际站是两套账号），共用槽位没有真实场景。
function readSecretModels(v) {
  const out = {}
  if (!v || typeof v !== 'object') return out
  for (const k of Object.keys(v)) {
    const id = normModelId(k)
    if (!id) continue
    const key = sanitizeKey(v[k])
    if (key) out[id] = key
  }
  return out
}
// 邮件通知凭据（SMTP）。授权码等同密码，必须进加密存储 —— 若跟着 config 走，
// 导出的备份文件里就是明文密码。字段名与「非凭据的邮件配置」（收件人/端口/开关）
// 刻意分开：后者进 config（可备份、设置页回填），前者只在这里。
function readSecretMail(v) {
  const p = v && typeof v === 'object' ? v : {}
  const s = (x, n) => String(x == null ? '' : x).trim().slice(0, n)
  return {
    mailHost: s(p.mailHost, 200),
    mailPort: Math.round(clampNum(p.mailPort, 1, 65535, 465)),
    mailSecure: p.mailSecure !== false,
    mailUser: s(p.mailUser, 200),
    mailPass: String(p.mailPass == null ? '' : p.mailPass).slice(0, 200),
  }
}
function readSecrets() {
  try {
    const s = utools.dbCryptoStorage.getItem(K.secrets)
    if (s && typeof s === 'object') {
      return {
        apiKey: String(s.apiKey || ''),
        platformToken: String(s.platformToken || ''),
        models: readSecretModels(s.models),
        notifyMail: readSecretMail(s.notifyMail),
      }
    }
  } catch (err) {}
  return { apiKey: '', platformToken: '', models: {}, notifyMail: readSecretMail(null) }
}
function sanitizeKey(s) {
  // 密钥只允许字母数字及常见符号；粘贴常带入空格/换行/制表符，统一剔除
  return String(s == null ? '' : s).replace(/\s+/g, '')
}
function writeSecrets(secrets) {
  const s = secrets && typeof secrets === 'object' ? secrets : {}
  // models 槽位「未提供」时沿用现值：恢复备份只带 apiKey/platformToken，
  // 若在这里整体重建，用户已保存的各模型密钥会被一次恢复抹掉。
  const models = s.models === undefined ? readSecrets().models : readSecretModels(s.models)
  // 同理：notifyMail 只由设置页的 saveMailSecrets 单独传，恢复备份走的保存路径不带它，
  // 未提供时必须沿用现值，否则保存一次 API Key 就把 SMTP 密码清了。
  const notifyMail = s.notifyMail === undefined ? readSecrets().notifyMail : readSecretMail(s.notifyMail)
  utools.dbCryptoStorage.setItem(K.secrets, {
    apiKey: sanitizeKey(s.apiKey),
    platformToken: sanitizeKey(s.platformToken),
    models: models,
    notifyMail: notifyMail,
  })
}

// ──────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────
// 台词库默认值（设置页可编辑）。挂件页面里另有一份同内容的兜底（浮动页没有 require，读不到这里），
// 两处要一起改。hint/chat/dsh/short 是随机台词四组的文本，time 是报时模板（{t} 换成当前时间），
// gifFail 是动图加载失败时的顶替文案。
const QUOTES_DEFAULT = {
  hint: ['好模型... ↓', '好女孩...↓'],
  chat: ['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！'],
  dsh: ['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...'],
  short: ['哦鲸鲸...'],
  time: ['现在是 {t}', '已经 {t} 啦', '都 {t} 了哦', '小鲸鱼报时：{t}'],
  gifFail: ['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...'],
}
// 「不是随机组」的两项：报时模板与动图降级文案。它们不走抽签，固定就是这两份文案
const QUOTE_TEXT_KEYS = ['time', 'gifFail']
// 单条最长 60 字、每组最多 30 条：气泡只有三行，更长更多都显示不出来
const QUOTE_MAX_LEN = 60
const QUOTE_MAX_COUNT = 30
// 随机台词组：一组 = 一个抽签项，权重越大越常抽到。
// card = 内置的余额 / 时段卡（内容按当前数据现算，文本不可编辑）；text = 用户自己填的台词
// （一行一条候选，随机抽一条显示）；image = 抽一张自定义气泡图（没导入过就用内置 rua.gif）。
const QUOTE_GROUP_KINDS = ['card', 'text', 'image']
const QUOTE_GROUP_MAX = 12
const QUOTE_GROUP_W_MAX = 999
// 文本组的两种字号：A = 普通（长句自动换行）、B = 大字（不换行，靠挂件按可用宽度整体缩放）
const QUOTE_GROUP_STYLES = ['A', 'B']
// 内置默认组：与挂件页面 defaultRandomGroups() 一一对应（顺序、权重、样式都要一致），
// 权重沿用整理前写死在挂件页里的那套（45 / 7 / 7 / 10 / 3 / 1）
const QUOTE_GROUPS_DEFAULT = [
  { kind: 'card', w: 45 },
  { kind: 'text', w: 7, style: 'B', lines: QUOTES_DEFAULT.hint },
  { kind: 'text', w: 7, style: 'A', lines: QUOTES_DEFAULT.chat },
  { kind: 'image', w: 10 },
  { kind: 'text', w: 3, style: 'A', lines: QUOTES_DEFAULT.dsh },
  { kind: 'text', w: 1, style: 'B', lines: QUOTES_DEFAULT.short },
]
// 老结构（hint / chat / dsh / short 四个 key）里出现的 key 就认作「需要升级」
const LEGACY_GROUP_KEYS = ['hint', 'chat', 'dsh', 'short']
// 组列表深拷一层：默认值会被直接塞进配置对象，共用同一个数组实例会被后续编辑污染
function cloneGroups(list) {
  return list.map((g) => (Array.isArray(g.lines)
    ? { kind: g.kind, w: g.w, style: g.style, lines: g.lines.slice() }
    : { kind: g.kind, w: g.w }))
}
// 一组台词：null/非数组（设置页「恢复默认」传 null）→ 内置默认；空数组或全是空行 → 也回内置默认
// （抽到空数组会渲染出 undefined，报时/降级文案更不能没字，所以「清空」按恢复默认处理）
function normQuoteList(v, dft) {
  if (!Array.isArray(v)) return dft.slice()
  const out = []
  for (let i = 0; i < v.length && out.length < QUOTE_MAX_COUNT; i++) {
    if (typeof v[i] !== 'string') continue
    const s = v[i].trim().slice(0, QUOTE_MAX_LEN)
    if (s) out.push(s)
  }
  return out.length ? out : dft.slice()
}
// 单个组：kind 不认就按 text（老结构升级过来的都是文本组）；文本组没有有效台词就整组丢掉
// —— 清空 = 这组不出现，比「悄悄变回内置文案」更符合直觉。
// 权重压到 1–999：抽签是「累减权重」的循环，权重 0 的组不会被跳过、反而会被兜底抽到，
// 留着 0 只会让人以为「设成 0 就不出现」。
function normQuoteGroup(v) {
  if (!v || typeof v !== 'object') return null
  const kind = QUOTE_GROUP_KINDS.indexOf(v.kind) >= 0 ? v.kind : 'text'
  const w = Math.round(clampNum(v.w, 1, QUOTE_GROUP_W_MAX, 5))
  if (kind !== 'text') return { kind: kind, w: w }
  const lines = normQuoteList(v.lines, [])
  if (!lines.length) return null
  return { kind: 'text', w: w, style: QUOTE_GROUP_STYLES.indexOf(v.style) >= 0 ? v.style : 'A', lines: lines }
}
// 组列表：非数组（含 null）= 用内置默认；逐组清洗；一组不剩也回内置默认
// —— 全空的话气泡会没内容，「随机台词」整个功能就没了
function normQuoteGroups(v) {
  if (!Array.isArray(v)) return cloneGroups(QUOTE_GROUPS_DEFAULT)
  const out = []
  for (const it of v) {
    const g = normQuoteGroup(it)
    if (g) out.push(g)
    if (out.length >= QUOTE_GROUP_MAX) break
  }
  return out.length ? out : cloneGroups(QUOTE_GROUPS_DEFAULT)
}
// 老配置升级：hint / chat / dsh / short → 四个文本组，card 与 image 这两组在老结构里没有对应
// key，按内置默认的权重补回原来的位置（顺序与权重都与升级前挂件里写死的那套完全一致）
function groupsFromLegacy(src) {
  return [
    { kind: 'card', w: 45 },
    { kind: 'text', w: 7, style: 'B', lines: normQuoteList(src.hint, QUOTES_DEFAULT.hint) },
    { kind: 'text', w: 7, style: 'A', lines: normQuoteList(src.chat, QUOTES_DEFAULT.chat) },
    { kind: 'image', w: 10 },
    { kind: 'text', w: 3, style: 'A', lines: normQuoteList(src.dsh, QUOTES_DEFAULT.dsh) },
    { kind: 'text', w: 1, style: 'B', lines: normQuoteList(src.short, QUOTES_DEFAULT.short) },
  ]
}
// quotes 全量：v 不是对象（null/undefined）= 整份恢复默认；是对象则只处理它带的键，其余沿用 cur。
// 三个字段：time / gifFail（固定文案）+ groups（可增删的随机组）。
// 老结构（只有 hint / chat / dsh / short、没有 groups）在这里就地升级成组列表 ——
// 不做单独的迁移步骤，下一次保存自然落成新结构
function normQuotes(v, cur) {
  const src = v && typeof v === 'object' ? v : null
  const base = src && cur && typeof cur === 'object' ? cur : {}
  const out = {}
  for (const k of QUOTE_TEXT_KEYS) {
    if (!src) { out[k] = QUOTES_DEFAULT[k].slice(); continue }
    out[k] = k in src
      ? normQuoteList(src[k], QUOTES_DEFAULT[k])
      : (Array.isArray(base[k]) ? base[k].slice() : QUOTES_DEFAULT[k].slice())
  }
  if (!src) out.groups = cloneGroups(QUOTE_GROUPS_DEFAULT)
  else if ('groups' in src) out.groups = normQuoteGroups(src.groups)
  else if (LEGACY_GROUP_KEYS.some((k) => k in src)) out.groups = groupsFromLegacy(src)
  else out.groups = normQuoteGroups(base.groups)
  return out
}
// ──────────────────────────────────────────────
// 提醒文案模板（设置页可编辑）
// ──────────────────────────────────────────────
// 四类提醒（低余额 / 今日预算 / 峰谷切换 / 鼠标穿透）的文案，气泡与系统通知共用同一份模板。
// 气泡只有三行，模板按行映射：第 1 行标题 / 第 2 行大字 / 第 3 行说明；行数不足留空，超出三行的并入说明行。
// 系统通知取全文并把换行合并成空格（通知只有一行）。峰谷与穿透各按状态分两条，免得一条模板要兼顾两种语气。
// 挂件页面里另有一份同内容的兜底（浮动页没有 require，读不到这里），两处要一起改。
const ALERTS_DEFAULT = {
  low: '【余额预警】\n仅剩 {balance}\n已低于预警阈值 {threshold}（设置页可改）',
  budget: '【预算提醒】\n超预算 {over}\n今日已用 {used}，预算 {budget}（设置页可改）',
  peakOn: '【峰时提醒】\n峰时\n叮咚～进入峰时段啦（北京时间）！{schedule}，其余谷时',
  peakOff: '【谷时提醒】\n谷时\n好消息～进入谷时段啦（北京时间）！{schedule}外为谷时',
  passOn: '【鼠标穿透】已开启\n穿透中\n在鲸鱼上停留约 1 秒可临时接管；也可用「切换鼠标穿透」快捷键关闭',
  passOff: '【鼠标穿透】已关闭\n可操作\n点击、拖拽与菜单已恢复',
}
const ALERT_KEYS = Object.keys(ALERTS_DEFAULT)
// 模板长度上限：气泡三行放不下更多字，也避免超长文本把气泡撑坏
const ALERT_MAX_LEN = 200
// 模板归一化：非字符串 → 内置默认；去掉首尾空白与空行（空行会让气泡某一行空着）；全空 → 内置默认
function normAlertText(v, dft) {
  if (typeof v !== 'string') return dft
  const s = v.replace(/\r\n?/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean).join('\n')
  return s ? s.slice(0, ALERT_MAX_LEN) : dft
}
// alerts 全量：v 不是对象（null/undefined）= 全部恢复默认；是对象则只处理它带的键，其余沿用 cur
function normAlerts(v, cur) {
  const src = v && typeof v === 'object' ? v : null
  const base = src && cur && typeof cur === 'object' ? cur : {}
  const out = {}
  for (const k of ALERT_KEYS) {
    if (!src) { out[k] = ALERTS_DEFAULT[k]; continue }
    out[k] = k in src
      ? normAlertText(src[k], ALERTS_DEFAULT[k])
      : (typeof base[k] === 'string' && base[k] ? base[k] : ALERTS_DEFAULT[k])
  }
  return out
}
// 模板渲染：替换 {占位符}；模板里没提供的占位符原样留着，用户一眼能看出写错了
function renderAlert(tpl, vars) {
  const v = vars && typeof vars === 'object' ? vars : {}
  return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => (
    Object.prototype.hasOwnProperty.call(v, k) ? String(v[k]) : m
  ))
}
// 系统通知只有一行：渲染后把换行合并成空格
function alertOneLine(tpl, vars) {
  return renderAlert(tpl, vars).replace(/\s*\n\s*/g, ' ').trim()
}
// 取某类提醒的模板：配置里缺这一项（老配置 / 异常值）时回内置默认
function alertFor(cfg, key) {
  const a = cfg && cfg.alerts
  return a && typeof a[key] === 'string' && a[key] ? a[key] : ALERTS_DEFAULT[key]
}

// 吸附与翻转：'ratio' = 按比例吸附（吸附区宽度 = 可用区宽/高的 snapRatio%）、
// 'off' = 关闭吸附（纯自由摆放，但位置仍按「最近边 + 净距离」记锚点，照旧能原样还原）
const SNAP_MODES = ['ratio', 'off']
// 吸附区宽度：上限 45% —— 左右各占 45% 就只剩中间 10% 的自由区，再大两侧吸附区会重叠。
// 设置页拿不到宿主常量，App.vue 里有一份同值副本，由 scripts/check-shared.mjs 比对
const SNAP_RATIO_MIN = 1
const SNAP_RATIO_MAX = 45
const SNAP_RATIO_DEFAULT = 25

// 避让滚动条：挂件贴右边缘时默认留出的像素（Windows 默认纵向滚动条约 17px）。
// 设置页拿不到宿主常量，App.vue 里有一份同值副本，由 scripts/check-shared.mjs 比对
const SCROLL_GAP_DEFAULT = 17

// 挂件菜单的分组展开状态（每组一个布尔）。落配置是为了重开挂件 / 重载插件后
// 保持用户上次的展开组合，而不是每次都回到默认那两组。
// 默认只展开 models（切模型最高频）；look 组有 7 行控件，展开会把菜单塞满，故默认收起。
//
// menuGroupsRev 是「默认展开态」的版本号：改了上面任一组的默认值 / 删掉某组就 +1。
// 页面侧（floating-page.js）在配置里读到旧版本号时，会把受影响的组强制回到新默认，
// 否则老配置里存过的旧默认值会一直盖着新默认值，看起来像改动没生效。
// （v3 起 timer 组内不再有 timerAdv 子折叠，该键已从表里删掉）
const MENU_GROUPS_DEFAULT = { look: false, models: true, usage: false, timer: false, dsh: false }
function normMenuGroups(v) {
  const p = v && typeof v === 'object' ? v : {}
  const out = {}
  Object.keys(MENU_GROUPS_DEFAULT).forEach((k) => {
    out[k] = typeof p[k] === 'boolean' ? p[k] : MENU_GROUPS_DEFAULT[k]
  })
  return out
}

function normMenuGroupsRev(v) {
  const n = Math.round(clampNum(v, 0, 1e6, 0))
  return n
}
function defaultConfig() {
  return { scale: 1.3, vol: 0.9, soundOn: true, soundSet: 'duck', usageMode: 'ledger', peakMode: 'default', peakRemindOn: true, bubbleOn: true, menuBtn: true, onTop: true, lowAlertOn: true, lowAlertAmount: LOW_ALERT_BY_CURRENCY.CNY, budgetOn: false, budgetAmount: 0, dropAlertOn: false, dropAlertAmount: 5, clickQueueOn: false, remindSec: 8, quietOn: false, quietFrom: '23:00', quietTo: '07:00', timeBubbleOn: true, updateCheckOn: false, dragLock: false, enterMode: 'both', timerNotifyOn: true, timerMailOn: true, timerPersistOn: true, timerMode: 'off', timerSec: 1500, timerAt: '07:30', timerNote: '', timerBreakMin: 5, timerRemindSec: 8, timerBubblePin: true, timerBubbleOnly: true, guideDone: false, dshNodeDir: '', dshKeepAlive: false, dshRegistry: '', dshVersion: '', dshReinstall: false, dshNoOpen: true, dshMarketUrl: '', dshMarketMirror: true, dshMarketRegistry: '', dshMarketOfficial: false, avoidTaskbar: true, edgeTop: 0, edgeRight: 0, edgeBottom: 0, edgeLeft: 0, scrollGapOn: false, scrollGapPx: SCROLL_GAP_DEFAULT, snapMode: 'ratio', snapRatio: SNAP_RATIO_DEFAULT, opacity: 100, passThrough: false, skin: 'DSniang1', theme: 'default', quotes: normQuotes(null), alerts: normAlerts(null), quotaTotal: 0, quotaReset: 'monthly', tokenPrice: normTokenPrice(null), historyKeepDays: HISTORY_KEEP_DEFAULT, models: [], mainModelId: DEFAULT_MAIN_MODEL, dshBackupKeep: DSB_KEEP_DEFAULT, menuGroups: normMenuGroups(null), menuGroupsRev: 0, ghAccelOn: false, ghAccelIps: normIps(null), ghAccelRefreshedAt: 0, notifySystemOn: true, notifyMailOn: false, mailFrom: '', mailTo: '', mailFromName: '小鲸鱼余额挂件', mailSubjectPrefix: '[小鲸鱼余额挂件]' }
}
// dsh 注册源：只接受 http(s) 或空（默认官方源）
function normRegistry(v) {
  const s = String(v == null ? '' : v).trim()
  return /^https?:\/\//i.test(s) ? s.slice(0, 200) : ''
}
// dsh 插件市场的自定义目录 URL：同 normRegistry 的取舍（空 = 用官方目录）
function normMarketUrl(v) {
  const s = String(v == null ? '' : v).trim()
  return /^https?:\/\//i.test(s) ? s.slice(0, 300) : ''
}
// 免打扰起止时刻：'HH:MM'（24 小时制），非法值回默认
function normHm(v, dft) {
  const s = String(v == null ? '' : v).trim()
  if (!/^\d{1,2}:\d{2}$/.test(s)) return dft
  const parts = s.split(':')
  const h = Number(parts[0])
  const m = Number(parts[1])
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return dft
  return (h < 10 ? '0' + h : String(h)) + ':' + (m < 10 ? '0' + m : String(m))
}
// dsh 版本：'' = 自动（安装/更新时取 latest）；NEWEST_VERSION = 取版本列表里最大的那个（含测试版）；
// 否则固定版本号。哨兵值要在这里放行，否则会被当成非法版本号清成 ''，静默退回 latest ——
// 而 latest 只指向稳定发布，用户想装 1.7.0-alpha.2 这类比它更新的预发布时正好相反。
function normVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^@/, '')
  if (!s || s === 'latest') return ''
  if (s === NEWEST_VERSION) return s
  return /^[0-9A-Za-z][0-9A-Za-z.\-+]*$/.test(s) ? s.slice(0, 40) : ''
}
function clampNum(v, lo, hi, dft) {
  const n = Number(v)
  if (!isFinite(n)) return dft
  return Math.min(hi, Math.max(lo, n))
}
// 计时到点留言：单行纯文本（换行会让系统通知的标题/正文错位），超长截断。
// 上限与 floating-page.js 的 TIMER_NOTE_MAX、菜单输入框 maxLength 同值，三处要一起改
function normTimerNote(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, TIMER_NOTE_MAX)
}
// 挂件形象：内置形象的 id（= public/whale/ 下的图片文件名）/ 'custom'（用户导入）。
// 与 floating-page.js 的 BUILTIN_SKINS、设置页「形象」下拉三处同值，加形象要一起改。
const BUILTIN_SKINS = [
  'liuy', 'black', 'ciya', 'DSniang1', 'DSniang02', 'DSniang3', 'DSniang4',
  'DSniang5', 'DSniang6', 'DSniang7', 'glby', 'Jian', '无稽之谈改',
]
const DEFAULT_SKIN = 'DSniang1'
// v1.5.0 及更早只存过 'whale' / 'whale2' 两个 id（对应前两张图），这里映射过去 ——
// 否则老配置被判成非法值会悄悄换回默认形象，用户会以为「形象自己变了」
const SKIN_ALIAS = { whale: 'DSniang1', whale2: 'DSniang02' }
function normSkin(v) {
  const id = SKIN_ALIAS[v] || v
  return id === 'custom' || BUILTIN_SKINS.includes(id) ? id : DEFAULT_SKIN
}
// 气泡配色主题
function normTheme(v) {
  return v === 'dark' || v === 'sakura' ? v : 'default'
}
// 额度（资源包 / 订阅）的重置周期：'never' 不重置 / 'daily' 每日 / 'monthly' 每月
function normQuotaReset(v) {
  return v === 'never' || v === 'daily' ? v : 'monthly'
}
// 「实时·令牌」的自定义单价（谷价，元或美元/百万 token）+ 币种 + 汇率（元/USD）。
// 开关关着时其余字段照样存下来，下次打开不用重填；单价填 0 表示该项不收费，属合法值。
// models 是「按模型覆盖」的条目，与全局开关各自独立（见 lib/pricing.js）。
function normTokenPrice(v) {
  const src = v && typeof v === 'object' ? v : null
  // models 单独给一份空数组：Object.assign 是浅拷贝，共用默认值里的那个数组会被后续编辑污染
  if (!src) return Object.assign({}, TOKEN_PRICE_DEFAULT, { models: [] })
  return {
    on: src.on === true,
    cur: src.cur === 'USD' ? 'USD' : 'CNY',
    rate: Math.round(clampNum(src.rate, 0, TOKEN_RATE_MAX, TOKEN_PRICE_DEFAULT.rate) * 10000) / 10000,
    hit: clampNum(src.hit, 0, TOKEN_PRICE_MAX, TOKEN_PRICE_DEFAULT.hit),
    miss: clampNum(src.miss, 0, TOKEN_PRICE_MAX, TOKEN_PRICE_DEFAULT.miss),
    out: clampNum(src.out, 0, TOKEN_PRICE_MAX, TOKEN_PRICE_DEFAULT.out),
    models: normPriceModels(src.models),
  }
}
// 「按模型覆盖」的单价条目：{ name, hit, miss, out }，name 按子串匹配（与内置价目表同规则）。
// 空名条目直接丢掉 —— 空串会命中所有模型，等于把全局覆盖悄悄打开；单价缺省回内置默认值，
// 免得只填了模型名的一行把该模型的价算成 0（看着像「今天没花钱」）。
function normPriceModels(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const name = String(it.name == null ? '' : it.name).trim().slice(0, 80)
    if (!name) continue
    out.push({
      name: name,
      hit: clampNum(it.hit, 0, TOKEN_PRICE_MAX, TOKEN_PRICE_DEFAULT.hit),
      miss: clampNum(it.miss, 0, TOKEN_PRICE_MAX, TOKEN_PRICE_DEFAULT.miss),
      out: clampNum(it.out, 0, TOKEN_PRICE_MAX, TOKEN_PRICE_DEFAULT.out),
    })
    if (out.length >= TOKEN_PRICE_MODELS_MAX) break
  }
  return out
}

// ──────────────────────────────────────────────
// 多厂商模型：条目归一化（配置里存用户填的那一份，运行时结果另存 K.models）
// ──────────────────────────────────────────────
// 模型 id 会用作密钥槽位的键与 IPC 标识，限定字符集；生成的 id 由设置页给出（m + 时间戳）
function normModelId(v) {
  const s = String(v == null ? '' : v).trim()
  return /^[0-9A-Za-z_-]{1,40}$/.test(s) ? s : ''
}
function normModelTpl(v) {
  const s = String(v == null ? '' : v).trim()
  return Object.prototype.hasOwnProperty.call(MODEL_TEMPLATES, s) ? s : 'custom'
}
// JSON 字段路径（a.b[0].c）；空 = 该路径不取值
function normModelPath(v) {
  return String(v == null ? '' : v).trim().slice(0, 200)
}
// 接口地址：http(s) 或空；允许 {base}/... 形式（OpenAI 兼容中转站的 Base URL 在查询时才替换）
function normModelUrl(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 300)
  if (!s) return ''
  return /^https?:\/\//i.test(s) || /^\{base\}\//.test(s) ? s : ''
}
// 多窗口额度定义（OpenCode Go 的 5h/周/月、MiniMax 的 5h/周）：字段与顶层同构，只多 key/label 两个展示名。
// 只在模板里定义、设置页不提供编辑，所以这里只做形状清洗，不追求可读的报错
function normQuotaWindows(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const it of v) {
    if (!it || typeof it !== 'object') continue
    if (out.length >= 6) break
    const w = {
      key: String(it.key == null ? '' : it.key).trim().slice(0, 20),
      label: String(it.label == null ? '' : it.label).trim().slice(0, 12),
      usedPctPath: normModelPath(it.usedPctPath),
      remainPctPath: normModelPath(it.remainPctPath),
      remainPath: normModelPath(it.remainPath),
      totalPath: normModelPath(it.totalPath),
      resetPath: normModelPath(it.resetPath),
    }
    // 三种取值形态至少要有一个，否则这个窗口永远取不到值，留着只会让挂件多显示一行「—」
    if (!w.usedPctPath && !w.remainPctPath && !(w.remainPath && w.totalPath)) continue
    if (!w.label) w.label = w.key || '窗口'
    out.push(w)
  }
  return out
}
// 单个模型条目。字段「未提供」（undefined）时回模板默认，显式给了空值则以空值为准 ——
// 这样设置页「高级」里清空某个路径能真正生效，而不是被模板默认值悄悄填回来。
function normModel(v) {
  const src = v && typeof v === 'object' ? v : {}
  const tpl = normModelTpl(src.tpl)
  const t = MODEL_TEMPLATES[tpl] || MODEL_TEMPLATES.custom
  const pick = (k) => (src[k] === undefined ? t[k] : src[k])
  const id = normModelId(src.id)
  if (!id) return null
  const currency = src.currency === 'USD' || src.currency === 'CNY' ? src.currency : t.currency
  return {
    id: id,
    tpl: tpl,
    name: String(src.name == null ? '' : src.name).trim().slice(0, 40) || t.name,
    kind: src.kind === 'quota' || src.kind === 'balance' || src.kind === 'codex' ? src.kind : t.kind,
    currency: currency,
    auth: src.auth === 'raw' || src.auth === 'bearer' ? src.auth : (t.auth || 'bearer'),
    url: normModelUrl(pick('url')),
    baseUrl: normModelUrl(pick('baseUrl')),
    path: normModelPath(pick('path')),
    scale: clampNum(pick('scale'), 0, 1e6, t.scale || 1),
    usedUrl: normModelUrl(pick('usedUrl')),
    usedPath: normModelPath(pick('usedPath')),
    usedScale: clampNum(pick('usedScale'), 0, 1e6, t.usedScale || 1),
    usedPctPath: normModelPath(pick('usedPctPath')),
    remainPctPath: normModelPath(pick('remainPctPath')),
    remainPath: normModelPath(pick('remainPath')),
    totalPath: normModelPath(pick('totalPath')),
    resetPath: normModelPath(pick('resetPath')),
    // 多窗口额度：老配置里没有这个字段，undefined 时回模板（MiniMax / OpenCode Go 因此能自动升级成多窗口）
    windows: normQuotaWindows(pick('windows')),
    lowAlertOn: src.lowAlertOn !== false,
    lowAlertAmount: clampNum(src.lowAlertAmount, 0, 1e9, LOW_ALERT_BY_CURRENCY[currency] || 0),
  }
}
// 模型列表：超出上限的截断，id 非法或重复的丢弃（id 是密钥槽位的键，重复会互相覆盖）
function normModels(v) {
  if (!Array.isArray(v)) return []
  const out = []
  const seen = {}
  for (const it of v) {
    if (out.length >= MODEL_MAX) break
    const m = normModel(it)
    if (!m || seen[m.id]) continue
    seen[m.id] = true
    out.push(m)
  }
  return out
}
// 主显示模型：必须是「内置 DeepSeek」或列表里存在的 id，否则回 DeepSeek
function normMainModelId(v, models) {
  const s = normModelId(v)
  if (!s || s === DEFAULT_MAIN_MODEL) return DEFAULT_MAIN_MODEL
  return (models || []).some((m) => m.id === s) ? s : DEFAULT_MAIN_MODEL
}

function readConfig() {
  const dft = defaultConfig()
  let p = null
  try { p = utools.dbStorage.getItem(K.config) } catch (err) {}
  if (!p || typeof p !== 'object') return dft
  const models = normModels(p.models)
  return {
    scale: clampNum(p.scale, MIN_SCALE, MAX_SCALE, dft.scale),
    vol: clampNum(p.vol, 0, 1, dft.vol),
    soundOn: p.soundOn !== false,
    soundSet: p.soundSet === 'fx1' ? 'fx1' : p.soundSet === 'custom' ? 'custom' : 'duck',
    usageMode: p.usageMode === 'token' ? 'token' : 'ledger',
    peakMode: p.peakMode === 'liangwen' || p.peakMode === 'qiangqiang' ? p.peakMode : 'default',
    peakRemindOn: p.peakRemindOn !== false,
    bubbleOn: p.bubbleOn !== false,
    menuBtn: p.menuBtn !== false,
    onTop: p.onTop !== false,
    lowAlertOn: p.lowAlertOn !== false,
    lowAlertAmount: clampNum(p.lowAlertAmount, 0, 1e9, dft.lowAlertAmount),
    budgetOn: p.budgetOn === true,
    budgetAmount: clampNum(p.budgetAmount, 0, 1e9, dft.budgetAmount),
    dropAlertOn: p.dropAlertOn === true,
    dropAlertAmount: clampNum(p.dropAlertAmount, 0, 1e9, dft.dropAlertAmount),
    clickQueueOn: p.clickQueueOn === true,
    remindSec: p.remindSec === 0 || p.remindSec === 5 || p.remindSec === 8 || p.remindSec === 15 ? p.remindSec : dft.remindSec,
    quietOn: p.quietOn === true,
    quietFrom: normHm(p.quietFrom, dft.quietFrom),
    quietTo: normHm(p.quietTo, dft.quietTo),
    timeBubbleOn: p.timeBubbleOn !== false,
    // 默认关：开启后每次呼出会向 ghfast.top（第三方 GitHub 加速代理）拉一次远端
    // package.json 比版本号。请求不含任何用户数据，但仍是「装完什么都不配就外发」，
    // 公开发布按隐私优先处理 —— 用户主动勾选才联网
    updateCheckOn: p.updateCheckOn === true,
    dragLock: p.dragLock === true,
    enterMode: p.enterMode === 'widget' || p.enterMode === 'settings' ? p.enterMode : 'both',
    timerNotifyOn: p.timerNotifyOn !== false,
    // 计时到点的邮件通知（默认开）：未开邮件总开关时它不生效，保留值以便后开邮件时自动套用
    timerMailOn: p.timerMailOn !== false,
    timerPersistOn: p.timerPersistOn !== false,
    timerMode: p.timerMode === 'up' || p.timerMode === 'down' || p.timerMode === 'at' ? p.timerMode : 'off',
    timerSec: Math.round(clampNum(p.timerSec, 1, 86399, dft.timerSec)),
    timerAt: /^\d{1,2}:\d{2}$/.test(String(p.timerAt || '')) ? String(p.timerAt) : dft.timerAt,
    timerNote: normTimerNote(p.timerNote),
    timerBreakMin: Math.round(clampNum(p.timerBreakMin, 0, 120, dft.timerBreakMin)),
    timerRemindSec: p.timerRemindSec === 0 || p.timerRemindSec === 5 || p.timerRemindSec === 8 || p.timerRemindSec === 15 ? p.timerRemindSec : dft.timerRemindSec,
    timerBubblePin: p.timerBubblePin !== false,
    timerBubbleOnly: p.timerBubbleOnly !== false,
    // 首次运行引导是否已结束（点「开始使用」或「跳过」）——默认 false 表示还没走过引导。
    // 只认 true：老配置里没有这个键，若不这样归一，升级上来的老用户会被当成新装用户弹一次引导
    guideDone: p.guideDone === true,
    dshNodeDir: typeof p.dshNodeDir === 'string' ? p.dshNodeDir.slice(0, 260) : dft.dshNodeDir,
    dshKeepAlive: p.dshKeepAlive === true,
    dshRegistry: normRegistry(p.dshRegistry),
    dshVersion: normVersion(p.dshVersion),
    dshReinstall: p.dshReinstall === true,
    dshNoOpen: p.dshNoOpen !== false,
    dshMarketUrl: normMarketUrl(p.dshMarketUrl),
    dshMarketMirror: p.dshMarketMirror !== false,
    dshMarketRegistry: normRegistry(p.dshMarketRegistry),
    dshMarketOfficial: p.dshMarketOfficial === true,
    avoidTaskbar: p.avoidTaskbar !== false,
    edgeTop: Math.round(clampNum(p.edgeTop, 0, 400, dft.edgeTop)),
    edgeRight: Math.round(clampNum(p.edgeRight, 0, 400, dft.edgeRight)),
    edgeBottom: Math.round(clampNum(p.edgeBottom, 0, 400, dft.edgeBottom)),
    edgeLeft: Math.round(clampNum(p.edgeLeft, 0, 400, dft.edgeLeft)),
    scrollGapOn: p.scrollGapOn === true,
    scrollGapPx: Math.round(clampNum(p.scrollGapPx, 0, 100, dft.scrollGapPx)),
    // 吸附与翻转：snapRatio 是吸附区宽度（%），关闭吸附时该值留着不生效（下次打开仍是它）
    snapMode: SNAP_MODES.indexOf(p.snapMode) >= 0 ? p.snapMode : dft.snapMode,
    snapRatio: Math.round(clampNum(p.snapRatio, SNAP_RATIO_MIN, SNAP_RATIO_MAX, dft.snapRatio)),
    opacity: Math.round(clampNum(p.opacity, 20, 100, 100)),
    passThrough: p.passThrough === true,
    skin: normSkin(p.skin),
    theme: normTheme(p.theme),
    quotes: normQuotes(p.quotes),
    alerts: normAlerts(p.alerts, dft.alerts),
    // 额度（资源包 / 订阅）：总量（元，0 = 未设置）与重置周期，已用由账本算，不落配置
    quotaTotal: clampNum(p.quotaTotal, 0, 1e9, dft.quotaTotal),
    quotaReset: normQuotaReset(p.quotaReset),
    // 自定义单价（令牌模式可选）：只对平台用量换算生效，不影响余额显示币种
    tokenPrice: normTokenPrice(p.tokenPrice),
    // 账本历史保留天数：趋势图 / 明细 / 导出与明细日志裁剪都按它算窗口
    historyKeepDays: Math.round(clampNum(p.historyKeepDays, HISTORY_KEEP_MIN, HISTORY_KEEP_MAX, dft.historyKeepDays)),
    // dsh 快照保留份数（known-good / 手动命名的快照不计入，见 dsh-backup.js#pruneSnapshots）
    dshBackupKeep: Math.round(clampNum(p.dshBackupKeep, DSB_KEEP_MIN, DSB_KEEP_MAX, dft.dshBackupKeep)),
    // 多厂商模型：models 是用户填的注册表（自动进备份），运行时结果另存 K.models
    models: models,
    mainModelId: normMainModelId(p.mainModelId, models),
    menuGroups: normMenuGroups(p.menuGroups),
    menuGroupsRev: normMenuGroupsRev(p.menuGroupsRev),
    // GitHub 加速：on = 开关意图（实际是否生效以 hosts 文件里的标记块为准）；ips = 可编辑 IP 表；
    // refreshedAt = 上次成功刷新的时间戳（epoch ms，0 = 从未刷新过，用于设置页表龄提醒）
    ghAccelOn: p.ghAccelOn === true,
    ghAccelIps: normIps(p.ghAccelIps),
    ghAccelRefreshedAt: normGhAccelRefreshedAt(p.ghAccelRefreshedAt),
    // IP 获取来源开关（doh / community / manual），默认全开
    ghAccelSrc: normGhAccelSrc(p.ghAccelSrc),
    // 通知渠道：系统通知（默认开，沿用旧行为）+ 邮件通知（默认关，需先配好 SMTP）。
    // 邮件凭据（服务器/端口/账号/授权码）不在配置里，见 readSecretMail —— 只这里存「非敏感」的收发件人与信头
    notifySystemOn: p.notifySystemOn !== false,
    notifyMailOn: p.notifyMailOn === true,
    mailFrom: typeof p.mailFrom === 'string' ? p.mailFrom.trim().slice(0, 200) : dft.mailFrom,
    mailTo: typeof p.mailTo === 'string' ? p.mailTo.trim().slice(0, 200) : dft.mailTo,
    mailFromName: typeof p.mailFromName === 'string' ? p.mailFromName.trim().slice(0, 60) : dft.mailFromName,
    mailSubjectPrefix: typeof p.mailSubjectPrefix === 'string' ? p.mailSubjectPrefix.trim().slice(0, 60) : dft.mailSubjectPrefix,
  }
}
function writeConfig(cfg) {
  const models = normModels(cfg.models)
  try {
    utools.dbStorage.setItem(K.config, {
      scale: cfg.scale,
      vol: cfg.vol,
      soundOn: cfg.soundOn !== false,
      soundSet: cfg.soundSet,
      usageMode: cfg.usageMode,
      peakMode: cfg.peakMode,
      peakRemindOn: cfg.peakRemindOn !== false,
      bubbleOn: !!cfg.bubbleOn,
      menuBtn: cfg.menuBtn !== false,
      onTop: cfg.onTop !== false,
      lowAlertOn: cfg.lowAlertOn !== false,
      lowAlertAmount: cfg.lowAlertAmount,
      budgetOn: cfg.budgetOn === true,
      budgetAmount: cfg.budgetAmount,
      dropAlertOn: cfg.dropAlertOn === true,
      dropAlertAmount: cfg.dropAlertAmount,
      clickQueueOn: cfg.clickQueueOn === true,
      remindSec: cfg.remindSec === 0 || cfg.remindSec === 5 || cfg.remindSec === 8 || cfg.remindSec === 15 ? cfg.remindSec : 8,
      quietOn: cfg.quietOn === true,
      quietFrom: normHm(cfg.quietFrom, '23:00'),
      quietTo: normHm(cfg.quietTo, '07:00'),
      timeBubbleOn: cfg.timeBubbleOn !== false,
      updateCheckOn: cfg.updateCheckOn === true,
      dragLock: cfg.dragLock === true,
      enterMode: cfg.enterMode === 'widget' || cfg.enterMode === 'settings' ? cfg.enterMode : 'both',
      timerNotifyOn: cfg.timerNotifyOn !== false,
      timerMailOn: cfg.timerMailOn !== false,
      timerPersistOn: cfg.timerPersistOn !== false,
      timerMode: cfg.timerMode === 'up' || cfg.timerMode === 'down' || cfg.timerMode === 'at' ? cfg.timerMode : 'off',
      timerSec: Math.round(clampNum(cfg.timerSec, 1, 86399, 1500)),
      timerAt: /^\d{1,2}:\d{2}$/.test(String(cfg.timerAt || '')) ? String(cfg.timerAt) : '07:30',
      timerNote: normTimerNote(cfg.timerNote),
      timerBreakMin: Math.round(clampNum(cfg.timerBreakMin, 0, 120, 5)),
      timerRemindSec: cfg.timerRemindSec === 0 || cfg.timerRemindSec === 5 || cfg.timerRemindSec === 8 || cfg.timerRemindSec === 15 ? cfg.timerRemindSec : 8,
      timerBubblePin: cfg.timerBubblePin !== false,
      timerBubbleOnly: cfg.timerBubbleOnly !== false,
      guideDone: cfg.guideDone === true,
      dshNodeDir: typeof cfg.dshNodeDir === 'string' ? cfg.dshNodeDir.slice(0, 260) : '',
      dshKeepAlive: cfg.dshKeepAlive === true,
      dshRegistry: normRegistry(cfg.dshRegistry),
      dshVersion: normVersion(cfg.dshVersion),
      dshReinstall: cfg.dshReinstall === true,
      dshNoOpen: cfg.dshNoOpen !== false,
      dshMarketUrl: normMarketUrl(cfg.dshMarketUrl),
      dshMarketMirror: cfg.dshMarketMirror !== false,
      dshMarketRegistry: normRegistry(cfg.dshMarketRegistry),
      dshMarketOfficial: cfg.dshMarketOfficial === true,
      avoidTaskbar: cfg.avoidTaskbar !== false,
      edgeTop: Math.round(clampNum(cfg.edgeTop, 0, 400, 0)),
      edgeRight: Math.round(clampNum(cfg.edgeRight, 0, 400, 0)),
      edgeBottom: Math.round(clampNum(cfg.edgeBottom, 0, 400, 0)),
      edgeLeft: Math.round(clampNum(cfg.edgeLeft, 0, 400, 0)),
      scrollGapOn: cfg.scrollGapOn === true,
      scrollGapPx: Math.round(clampNum(cfg.scrollGapPx, 0, 100, SCROLL_GAP_DEFAULT)),
      snapMode: SNAP_MODES.indexOf(cfg.snapMode) >= 0 ? cfg.snapMode : 'ratio',
      snapRatio: Math.round(clampNum(cfg.snapRatio, SNAP_RATIO_MIN, SNAP_RATIO_MAX, SNAP_RATIO_DEFAULT)),
      opacity: Math.round(clampNum(cfg.opacity, 20, 100, 100)),
      passThrough: cfg.passThrough === true,
      skin: normSkin(cfg.skin),
      theme: normTheme(cfg.theme),
      quotes: normQuotes(cfg.quotes),
      alerts: normAlerts(cfg.alerts),
      quotaTotal: clampNum(cfg.quotaTotal, 0, 1e9, 0),
      quotaReset: normQuotaReset(cfg.quotaReset),
      tokenPrice: normTokenPrice(cfg.tokenPrice),
      historyKeepDays: Math.round(clampNum(cfg.historyKeepDays, HISTORY_KEEP_MIN, HISTORY_KEEP_MAX, HISTORY_KEEP_DEFAULT)),
      dshBackupKeep: Math.round(clampNum(cfg.dshBackupKeep, DSB_KEEP_MIN, DSB_KEEP_MAX, DSB_KEEP_DEFAULT)),
      models: models,
      mainModelId: normMainModelId(cfg.mainModelId, models),
      menuGroups: normMenuGroups(cfg.menuGroups),
      menuGroupsRev: normMenuGroupsRev(cfg.menuGroupsRev),
      ghAccelOn: cfg.ghAccelOn === true,
      ghAccelIps: normIps(cfg.ghAccelIps),
      ghAccelRefreshedAt: normGhAccelRefreshedAt(cfg.ghAccelRefreshedAt),
      ghAccelSrc: normGhAccelSrc(cfg.ghAccelSrc),
      notifySystemOn: cfg.notifySystemOn !== false,
      notifyMailOn: cfg.notifyMailOn === true,
      mailFrom: String(cfg.mailFrom || '').trim().slice(0, 200),
      mailTo: String(cfg.mailTo || '').trim().slice(0, 200),
      mailFromName: String(cfg.mailFromName || '').trim().slice(0, 60),
      mailSubjectPrefix: String(cfg.mailSubjectPrefix || '').trim().slice(0, 60),
      updatedAt: new Date().toISOString(),
      })
  } catch (err) {
    // 保存失败必须留痕：dbStorage 写满/配额超限时 setItem 会抛，若让它裸抛到 IPC 层，
    // 设置页只会看到「保存中」不动，用户以为改了其实没落盘（旧配置继续生效）。
    logErr('[whale][config] 写配置失败', err && err.message)
    return false
  }
  return true
}
function patchConfig(patch) {
  const cfg = readConfig()
  const p = patch && typeof patch === 'object' ? patch : {}
  if (p.scale !== undefined) cfg.scale = Math.round(clampNum(p.scale, MIN_SCALE, MAX_SCALE, cfg.scale) * 10) / 10
  if (p.vol !== undefined) cfg.vol = clampNum(p.vol, 0, 1, cfg.vol)
  if (p.soundOn !== undefined) cfg.soundOn = !!p.soundOn
  if (p.soundSet !== undefined) cfg.soundSet = (p.soundSet === 'fx1' || p.soundSet === 'custom') ? p.soundSet : 'duck'
  if (p.usageMode !== undefined) cfg.usageMode = p.usageMode === 'token' ? 'token' : 'ledger'
  if (p.peakMode !== undefined) cfg.peakMode = (p.peakMode === 'liangwen' || p.peakMode === 'qiangqiang') ? p.peakMode : 'default'
  if (p.peakRemindOn !== undefined) cfg.peakRemindOn = !!p.peakRemindOn
  if (p.bubbleOn !== undefined) cfg.bubbleOn = !!p.bubbleOn
  if (p.menuBtn !== undefined) cfg.menuBtn = !!p.menuBtn
  if (p.onTop !== undefined) cfg.onTop = !!p.onTop
  if (p.lowAlertOn !== undefined) cfg.lowAlertOn = !!p.lowAlertOn
  if (p.lowAlertAmount !== undefined) cfg.lowAlertAmount = clampNum(p.lowAlertAmount, 0, 1e9, cfg.lowAlertAmount)
  // 今日预算（0 = 未设置，不提醒）与「点按依次播放」台词
  if (p.budgetOn !== undefined) cfg.budgetOn = !!p.budgetOn
  if (p.budgetAmount !== undefined) cfg.budgetAmount = clampNum(p.budgetAmount, 0, 1e9, cfg.budgetAmount)
  // 余额大幅波动通知（单次下降 ≥ 阈值即通知；0 = 未设置，不通知）
  if (p.dropAlertOn !== undefined) cfg.dropAlertOn = !!p.dropAlertOn
  if (p.dropAlertAmount !== undefined) cfg.dropAlertAmount = clampNum(p.dropAlertAmount, 0, 1e9, cfg.dropAlertAmount)
  if (p.clickQueueOn !== undefined) cfg.clickQueueOn = !!p.clickQueueOn
  // 提醒气泡停留秒数（0 = 常驻，手动点掉）与免打扰时段（时段内静默系统通知，气泡照常）
  if (p.remindSec !== undefined) {
    const n = Number(p.remindSec)
    if (n === 0 || n === 5 || n === 8 || n === 15) cfg.remindSec = n
  }
  if (p.quietOn !== undefined) cfg.quietOn = !!p.quietOn
  if (p.quietFrom !== undefined) cfg.quietFrom = normHm(p.quietFrom, cfg.quietFrom)
  if (p.quietTo !== undefined) cfg.quietTo = normHm(p.quietTo, cfg.quietTo)
  if (p.timeBubbleOn !== undefined) cfg.timeBubbleOn = !!p.timeBubbleOn
  if (p.updateCheckOn !== undefined) cfg.updateCheckOn = !!p.updateCheckOn
  if (p.dragLock !== undefined) cfg.dragLock = !!p.dragLock
  if (p.enterMode !== undefined) cfg.enterMode = p.enterMode === 'widget' || p.enterMode === 'settings' ? p.enterMode : 'both'
  if (p.timerNotifyOn !== undefined) cfg.timerNotifyOn = !!p.timerNotifyOn
  if (p.timerMailOn !== undefined) cfg.timerMailOn = !!p.timerMailOn
  if (p.timerPersistOn !== undefined) cfg.timerPersistOn = !!p.timerPersistOn
  if (p.timerMode !== undefined) cfg.timerMode = p.timerMode === 'up' || p.timerMode === 'down' || p.timerMode === 'at' ? p.timerMode : 'off'
  if (p.timerSec !== undefined) cfg.timerSec = Math.round(clampNum(p.timerSec, 1, 86399, cfg.timerSec))
  if (p.timerNote !== undefined) cfg.timerNote = normTimerNote(p.timerNote)
  if (p.timerBreakMin !== undefined) cfg.timerBreakMin = Math.round(clampNum(p.timerBreakMin, 0, 120, cfg.timerBreakMin))
  if (p.timerAt !== undefined) {
    const s = String(p.timerAt)
    if (/^\d{1,2}:\d{2}$/.test(s)) cfg.timerAt = s
  }
  if (p.timerRemindSec !== undefined) {
    const n = Number(p.timerRemindSec)
    if (n === 0 || n === 5 || n === 8 || n === 15) cfg.timerRemindSec = n
  }
  if (p.timerBubblePin !== undefined) cfg.timerBubblePin = !!p.timerBubblePin
  if (p.timerBubbleOnly !== undefined) cfg.timerBubbleOnly = !!p.timerBubbleOnly
  // 首次运行引导只允许单向置为「已完成」：写回 undefined 之外的任何值都按 bool 处理，
  // 但不提供「重新弹出引导」的入口，免得误触让老用户再走一遍
  if (p.guideDone !== undefined) cfg.guideDone = p.guideDone === true
  if (p.dshNodeDir !== undefined) cfg.dshNodeDir = String(p.dshNodeDir || '').trim().slice(0, 260)
  if (p.dshKeepAlive !== undefined) cfg.dshKeepAlive = !!p.dshKeepAlive
  if (p.dshRegistry !== undefined) cfg.dshRegistry = normRegistry(p.dshRegistry)
  if (p.dshVersion !== undefined) cfg.dshVersion = normVersion(p.dshVersion)
  if (p.dshReinstall !== undefined) cfg.dshReinstall = !!p.dshReinstall
  if (p.dshNoOpen !== undefined) cfg.dshNoOpen = p.dshNoOpen !== false
  // 插件市场目录源（并发竞速，见 dsh-market.js 的 loadCatalog）：
  //   · dshMarketMirror   —— 是否让镜像源参赛（默认开）
  //   · dshMarketRegistry —— 参赛的 registry（空 = 用内置默认，即延迟最低的 npmmirror）
  //   · dshMarketOfficial —— 是否让官方源参赛。**默认关**：实测它 4.37MB 要 52–99s、
  //                          还常连不上，开着只会白占一个卡住的连接。要「官方最权威」可自行打开
  if (p.dshMarketUrl !== undefined) cfg.dshMarketUrl = normMarketUrl(p.dshMarketUrl)
  if (p.dshMarketMirror !== undefined) cfg.dshMarketMirror = p.dshMarketMirror !== false
  if (p.dshMarketRegistry !== undefined) cfg.dshMarketRegistry = normRegistry(p.dshMarketRegistry)
  if (p.dshMarketOfficial !== undefined) cfg.dshMarketOfficial = p.dshMarketOfficial === true
  if (p.avoidTaskbar !== undefined) cfg.avoidTaskbar = !!p.avoidTaskbar
  // 贴边间距（上/右/下/左，px）：0 = 紧贴该边（以系统当前可用区为准）
  if (p.edgeTop !== undefined) cfg.edgeTop = Math.round(clampNum(p.edgeTop, 0, 400, cfg.edgeTop))
  if (p.edgeRight !== undefined) cfg.edgeRight = Math.round(clampNum(p.edgeRight, 0, 400, cfg.edgeRight))
  if (p.edgeBottom !== undefined) cfg.edgeBottom = Math.round(clampNum(p.edgeBottom, 0, 400, cfg.edgeBottom))
  if (p.edgeLeft !== undefined) cfg.edgeLeft = Math.round(clampNum(p.edgeLeft, 0, 400, cfg.edgeLeft))
  // 避让滚动条：挂件贴右边缘时留出像素（默认 17px = Windows 滚动条宽度），避免盖住最大化窗口的纵向滚动条
  if (p.scrollGapOn !== undefined) cfg.scrollGapOn = !!p.scrollGapOn
  if (p.scrollGapPx !== undefined) cfg.scrollGapPx = Math.round(clampNum(p.scrollGapPx, 0, 100, cfg.scrollGapPx))
  // 吸附与翻转：mode = ratio 按比例吸附 / off 关闭吸附（关闭后不贴边，但仍按最近边记锚点）
  if (p.snapMode !== undefined) cfg.snapMode = SNAP_MODES.indexOf(p.snapMode) >= 0 ? p.snapMode : cfg.snapMode
  if (p.snapRatio !== undefined) cfg.snapRatio = Math.round(clampNum(p.snapRatio, SNAP_RATIO_MIN, SNAP_RATIO_MAX, cfg.snapRatio))
  // 窗口透明度（20–100%）与鼠标穿透总开关
  if (p.opacity !== undefined) cfg.opacity = Math.round(clampNum(p.opacity, 20, 100, cfg.opacity))
  if (p.passThrough !== undefined) cfg.passThrough = !!p.passThrough
  if (p.skin !== undefined) cfg.skin = normSkin(p.skin)
  if (p.theme !== undefined) cfg.theme = normTheme(p.theme)
  // 台词库：传对象 = 只改它带的组（组值 null/空 = 该组回内置默认）；传 null = 全部回内置默认
  if (p.quotes !== undefined) cfg.quotes = normQuotes(p.quotes, cfg.quotes)
  // 提醒文案模板：口径同台词库（传 null = 全部回内置默认）
  if (p.alerts !== undefined) cfg.alerts = normAlerts(p.alerts, cfg.alerts)
  // 额度（资源包 / 订阅）：总量 0 = 未设置（设置页不显示进度条）
  if (p.quotaTotal !== undefined) cfg.quotaTotal = clampNum(p.quotaTotal, 0, 1e9, cfg.quotaTotal)
  if (p.quotaReset !== undefined) cfg.quotaReset = normQuotaReset(p.quotaReset)
  // 自定义单价：整份替换（设置页每次提交完整对象，字段缺省时回内置默认值）
  if (p.tokenPrice !== undefined) cfg.tokenPrice = normTokenPrice(p.tokenPrice)
  // 账本历史保留天数（35–730）：调小不会立刻删历史，下一次记账/导入时才按新窗口裁剪
  if (p.historyKeepDays !== undefined) {
    cfg.historyKeepDays = Math.round(clampNum(p.historyKeepDays, HISTORY_KEEP_MIN, HISTORY_KEEP_MAX, cfg.historyKeepDays))
  }
  // dsh 快照保留份数（1–200）：调小不会立刻删，下一次建快照时才按新上限轮转
  if (p.dshBackupKeep !== undefined) {
    cfg.dshBackupKeep = Math.round(clampNum(p.dshBackupKeep, DSB_KEEP_MIN, DSB_KEEP_MAX, cfg.dshBackupKeep))
  }
  // 多厂商模型：models 先于 mainModelId 处理，否则「同时传两者」时新加的 id 还没进列表，主显示会被判为失效
  if (p.models !== undefined) cfg.models = normModels(p.models)
  if (p.mainModelId !== undefined) cfg.mainModelId = normMainModelId(p.mainModelId, cfg.models)
  // 菜单分组展开状态：逐组合并 —— 挂件只报变化的那一组时，不能把其余组打回默认
  if (p.menuGroups !== undefined && p.menuGroups && typeof p.menuGroups === 'object') {
    Object.keys(MENU_GROUPS_DEFAULT).forEach((k) => {
      if (typeof p.menuGroups[k] === 'boolean') cfg.menuGroups[k] = p.menuGroups[k]
    })
  }
  // 默认展开态的版本号：挂件迁移过 look 组后回报当前版本，下次启动不再重复迁移。
  // 只增不减：patchConfig 是「读现有配置 → 打补丁 → 整份写回」，而 readConfig 会把
  // 缺失的 menuGroupsRev 归一成 0；若这里直接接受补丁里的值，任何不带该字段的补丁
  // （设置页 patchCfg、改模型、改透明度…）都会把版本号冲回 0，
  // 导致挂件每次启动都重跑一次 look 迁移、并把 dsh 组一并强制收起
  if (p.menuGroupsRev !== undefined) cfg.menuGroupsRev = Math.max(cfg.menuGroupsRev, normMenuGroupsRev(p.menuGroupsRev))
  // GitHub 加速：开关意图（hosts 实际状态由 hosts.js 读文件现算）与可编辑 IP 表
  if (p.ghAccelOn !== undefined) cfg.ghAccelOn = !!p.ghAccelOn
  if (p.ghAccelIps !== undefined) cfg.ghAccelIps = normIps(p.ghAccelIps)
  if (p.ghAccelRefreshedAt !== undefined) cfg.ghAccelRefreshedAt = normGhAccelRefreshedAt(p.ghAccelRefreshedAt)
  // 来源开关与顺序：只覆盖显式传入的键，未传入的保持原值（前端可能只改其中一项）
  if (p.ghAccelSrc !== undefined) {
    const s = p.ghAccelSrc && typeof p.ghAccelSrc === 'object' ? p.ghAccelSrc : {}
    cfg.ghAccelSrc = normGhAccelSrc({
      doh: s.doh === undefined ? cfg.ghAccelSrc.doh : s.doh,
      community: s.community === undefined ? cfg.ghAccelSrc.community : s.community,
      manual: s.manual === undefined ? cfg.ghAccelSrc.manual : s.manual,
      sources: s.sources === undefined ? cfg.ghAccelSrc.sources : s.sources,
      order: s.order === undefined ? cfg.ghAccelSrc.order : s.order,
      customSources: s.customSources === undefined ? cfg.ghAccelSrc.customSources : s.customSources,
    })
  }
  // 通知渠道开关 + 邮件的非敏感字段（SMTP 服务器/授权码走 saveMailSecrets，不经这里）
  if (p.notifySystemOn !== undefined) cfg.notifySystemOn = !!p.notifySystemOn
  if (p.notifyMailOn !== undefined) cfg.notifyMailOn = !!p.notifyMailOn
  if (p.mailFrom !== undefined) cfg.mailFrom = String(p.mailFrom || '').trim().slice(0, 200)
  if (p.mailTo !== undefined) cfg.mailTo = String(p.mailTo || '').trim().slice(0, 200)
  if (p.mailFromName !== undefined) cfg.mailFromName = String(p.mailFromName || '').trim().slice(0, 60)
  if (p.mailSubjectPrefix !== undefined) cfg.mailSubjectPrefix = String(p.mailSubjectPrefix || '').trim().slice(0, 60)
  // 写失败必须让调用方知道：writeConfig 是**返回 false 而不抛错**（见上面的注释），
  // 早先这里直接忽略返回值，于是全项目 13 个 patchConfig 调用点（设置页保存、hosts 表龄、
  // 保留份数…）都拿不到「没落盘」这件事 —— writeConfig 里辛苦加的 logErr 只落到了日志里，
  // 用户侧依然看到「保存成功」、重启后又变回去。这里抛出去，交给各调用点的 try/catch 统一处理。
  if (!writeConfig(cfg)) throw new Error('写配置失败（存储可能已满或被拒绝）')
  return cfg
}

// ──────────────────────────────────────────────
// 账本
// ──────────────────────────────────────────────
function todayKey() {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}
// 记账防误判阈值（判据在桌面端被真实事故验证过：赠送额度 271 元整块到期曾被误记为用量）
const USAGE_JUMP_LIMIT = 20 // 元：间隔再短，一次下降超过 20 元即判为非消费
const USAGE_JUMP_RATE = 5   // 元/小时：距上次采样越久，容忍上限越宽
// 异常变动 / 校准明细的保留上限（条数）。两条日志都跨天保留（设置页要按日展开明细），
// 按保留天数裁剪之外再加一层条数兜底，避免某天频繁触发时无限膨胀。
const DETAIL_LOG_KEEP = 100
// 历史用量保留天数（设置页可调，默认 365）。下限 35 是因为「本月汇总」在 31 号那天要回溯到 1 号，
// 窗口再小就会缺月初的数据；上限 730 是为了兜住「一天一条」的量级，不至于让账本无限长下去。
const HISTORY_KEEP_DEFAULT = 365
const HISTORY_KEEP_MIN = 35
const HISTORY_KEEP_MAX = 730
// dsh 快照保留份数（设置页可调，默认 20）。上限 200 是「不至于让快照目录无限长」的兜底；
// 下限 1 是因为 0 等于「每次写入前建的快照立刻被自己删掉」，回滚就没了。known-good
// 与手动命名的快照不计入轮转，所以实际留在盘上的可能多于这个数（见 dsh-backup.js#isPinned）。
const DSB_KEEP_DEFAULT = 20
const DSB_KEEP_MIN = 1
const DSB_KEEP_MAX = 200
// 直接读原始配置而不走 readConfig()：readLedger() 每次刷新都会调 pruneDetailLog()，
// 而 readConfig() 要把 models / quotes / alerts 全套归一化一遍，这里只需要一个数字。
function historyKeepDays() {
  let p = null
  try { p = utools.dbStorage.getItem(K.config) } catch (err) {}
  const n = p && typeof p === 'object' ? Number(p.historyKeepDays) : NaN
  if (!isFinite(n)) return HISTORY_KEEP_DEFAULT
  return Math.round(Math.min(HISTORY_KEEP_MAX, Math.max(HISTORY_KEEP_MIN, n)))
}

// 明细日志裁剪：只留最近 historyKeepDays() 天内、最多 DETAIL_LOG_KEEP 条。
// 读账本时统一走一遍，老账本里超期的记录也会被自然清掉。
function pruneDetailLog(list) {
  const cutoff = Date.now() - historyKeepDays() * 86400000
  const arr = (Array.isArray(list) ? list : []).filter((e) => {
    const t = Date.parse(e && e.at)
    return isFinite(t) ? t >= cutoff : true
  })
  return arr.length > DETAIL_LOG_KEEP ? arr.slice(-DETAIL_LOG_KEEP) : arr
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000
}
// API Key 指纹：只留 sha1 前 8 位用于判断「是不是同一本账」，不落任何可还原密钥的信息
function keyFingerprint(key) {
  const s = String(key || '')
  if (!s) return ''
  try {
    return require('crypto').createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 8)
  } catch (err) { return '' }
}
function freshLedger() {
  return {
    date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {},
    // 赠送/充值分项余额与上次采样时间：识别赠送额度整块到期用
    lastGranted: null, lastToppedUp: null, lastSampleAt: '',
    // 当前账本绑定的 Key 指纹：换 Key 只重置基准，不把两边差额记成用量
    lastKeyId: '',
    // 判定为「非消费」的余额变动：今日合计 + 明细（at/amount/why）
    todayAdjust: 0, adjustLog: [], lastAdjustWhy: '', lastAdjustAt: '',
    // 手动校准记录
    calibrateLog: [],
    // 今日预算提醒已发过通知的日期（YYYY-MM-DD；空 = 今天还没提醒）
    budgetNotifiedOn: '',
    // 低余额预警已发过通知的日期（同上，两类提醒各自每天一次）
    lowNotifiedOn: '',
    // 额度「不重置」口径的累计已用：跨天归档时把当天用量并入，账本滚动删除历史也不影响它
    quotaUsed: 0,
  }
}
function readLedger() {
  let raw = null
  try {
    const led = utools.dbStorage.getItem(K.ledger)
    if (led && typeof led === 'object' && typeof led.date === 'string') raw = led
  } catch (err) {}
  if (!raw) return freshLedger()
  const numOr = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)
  return {
    date: String(raw.date),
    lastBalance: typeof raw.lastBalance === 'number' ? raw.lastBalance : null,
    lastCurrency: typeof raw.lastCurrency === 'string' ? raw.lastCurrency : '',
    todayUsage: numOr(raw.todayUsage, 0),
    history: raw.history && typeof raw.history === 'object' ? raw.history : {},
    lastGranted: typeof raw.lastGranted === 'number' ? raw.lastGranted : null,
    lastToppedUp: typeof raw.lastToppedUp === 'number' ? raw.lastToppedUp : null,
    lastSampleAt: typeof raw.lastSampleAt === 'string' ? raw.lastSampleAt : '',
    lastKeyId: typeof raw.lastKeyId === 'string' ? raw.lastKeyId : '',
    todayAdjust: numOr(raw.todayAdjust, 0),
    adjustLog: pruneDetailLog(raw.adjustLog),
    lastAdjustWhy: typeof raw.lastAdjustWhy === 'string' ? raw.lastAdjustWhy : '',
    lastAdjustAt: typeof raw.lastAdjustAt === 'string' ? raw.lastAdjustAt : '',
    calibrateLog: pruneDetailLog(raw.calibrateLog),
    budgetNotifiedOn: typeof raw.budgetNotifiedOn === 'string' ? raw.budgetNotifiedOn : '',
    lowNotifiedOn: typeof raw.lowNotifiedOn === 'string' ? raw.lowNotifiedOn : '',
    // 老账本没有 quotaUsed：用现存历史之和做起点，避免「不重置」的累计反而小于「本月累计」
    quotaUsed: typeof raw.quotaUsed === 'number' && isFinite(raw.quotaUsed)
      ? raw.quotaUsed
      : Object.keys(raw.history && typeof raw.history === 'object' ? raw.history : {})
        .reduce((a, k) => a + round4(raw.history[k]), 0),
  }
}
// 余额下降是否「不像用掉的」：1) 赠送额度整块消失（到期/平台收回）；2) 短时间异常大跳变。
// 返回原因字符串；'' 表示正常消费，计入今日已用。
function balanceDropReason(led, delta, granted, gapSec) {
  const pg = typeof led.lastGranted === 'number' ? led.lastGranted : null
  if (pg !== null && granted !== null && delta >= 0.5) {
    const gone = pg - granted
    if (gone > 0 && gone >= delta - 0.05 && granted <= Math.max(0.05, pg * 0.02)) {
      return '赠送额度到期/被收回'
    }
  }
  const limit = Math.max(USAGE_JUMP_LIMIT, USAGE_JUMP_RATE * Math.max(0, gapSec) / 3600)
  if (delta > limit) return '余额下降超过可信上限'
  return ''
}
// 记账：余额正差值累计当天用量；跨天归档（保留 HISTORY_KEEP 天）；换币种/换 Key 只重置基准不记差值。
// extra = { granted, toppedUp, keyId }：赠送/充值分项与 Key 指纹，用于防误判。
// 返回 { ledger, adjust, drop }；adjust 非空表示本轮下降未计入用量（气泡向用户解释）；
// drop 是本轮余额下降总额（计不计入用量都算），供宿主做「大幅波动」通知。
// 跨天/换币种/换 Key 三种情况下两边余额不可比，drop 恒为 0，不会误报波动。
function recordLedgerUsage(currentBalance, currency, extra) {
  const ex = extra && typeof extra === 'object' ? extra : {}
  const granted = isFinite(Number(ex.granted)) && Number(ex.granted) >= 0 ? round4(Number(ex.granted)) : null
  const toppedUp = isFinite(Number(ex.toppedUp)) && Number(ex.toppedUp) >= 0 ? round4(Number(ex.toppedUp)) : null
  const keyId = ex.keyId ? String(ex.keyId) : ''
  const nowIso = new Date().toISOString()

  const t = todayKey()
  const led = readLedger()
  const cur = String(currency || '')
  const currencyChanged =
    led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur
  const keyChanged = !!(led.lastKeyId && keyId && led.lastKeyId !== keyId)
  let adjust = null
  let drop = 0

  if (led.date !== t) {
    if (led.date) led.history[led.date] = led.todayUsage
    // 归档前把当天用量并进「不重置」口径的累计（顺序不能反，下面就把 todayUsage 清零了）
    led.quotaUsed = round4((led.quotaUsed || 0) + (typeof led.todayUsage === 'number' ? led.todayUsage : 0))
    led.date = t
    led.todayUsage = 0
    led.todayAdjust = 0
    // adjustLog 不随跨天清空：设置页的账本明细要能按日回看「哪天的余额变动没计入用量」，
    // 由 pruneDetailLog 按天数裁剪；todayAdjust 仍是「今日合计」，必须归零
    led.lastAdjustWhy = ''
    led.lastAdjustAt = ''
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else if (currencyChanged || keyChanged) {
    // 换币种/换 Key：两边余额不可比，只重置基准
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else if (typeof currentBalance === 'number' && isFinite(currentBalance)) {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : null
    if (prev !== null && currentBalance < prev) {
      const delta = round4(prev - currentBalance)
      drop = delta
      // 老账本没有采样时间，按一轮刷新间隔（60s）从严判定
      let gap = 60
      if (led.lastSampleAt) {
        const g = (Date.parse(nowIso) - Date.parse(led.lastSampleAt)) / 1000
        if (isFinite(g) && g >= 0) gap = g
      }
      const why = balanceDropReason(led, delta, granted, gap)
      if (why) {
        led.todayAdjust = round4((led.todayAdjust || 0) + delta)
        led.adjustLog.push({ at: nowIso, amount: delta, why: why })
        led.adjustLog = pruneDetailLog(led.adjustLog)
        led.lastAdjustWhy = why
        led.lastAdjustAt = nowIso
        adjust = { amount: delta, why: why }
      } else {
        led.todayUsage = round4((led.todayUsage || 0) + delta)
      }
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  }
  // 分项余额/Key 指纹/采样时间无论计不计差都更新，作为下一轮比较基准
  if (granted !== null) led.lastGranted = granted
  if (toppedUp !== null) led.lastToppedUp = toppedUp
  if (keyId) led.lastKeyId = keyId
  led.lastSampleAt = nowIso

  const keys = Object.keys(led.history).sort()
  const keep = historyKeepDays()
  while (keys.length > keep) delete led.history[keys.shift()]
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) { logErr('[whale][ledger] 写账本失败', err && err.message) }
  return { ledger: led, adjust: adjust, drop: drop }
}
// 手动校准今日已用：只改当天累计值，不动余额基准（后续记账仍按真实余额差值累加）。
// 令牌模式下平台今日总量是权威值、会覆盖校准结果，因此该入口只对记账模式有意义。
function calibrateTodayUsage(amount) {
  const n = Number(amount)
  if (!isFinite(n) || n < 0) return { ok: false, error: '请输入不小于 0 的金额' }
  const led = readLedger()
  const from = round4(led.todayUsage || 0)
  const to = round4(n)
  if (to === from) return { ok: true, from: from, to: to, todayAdjust: led.todayAdjust || 0 }
  led.todayUsage = to
  led.calibrateLog = Array.isArray(led.calibrateLog) ? led.calibrateLog : []
  led.calibrateLog.push({ at: new Date().toISOString(), from: from, to: to })
  led.calibrateLog = pruneDetailLog(led.calibrateLog)
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) {
    logErr('[whale][ledger] 校准写账本失败', err && err.message)
    return { ok: false, error: '校准写入失败：' + ((err && err.message) || err) }
  }
  return { ok: true, from: from, to: to, todayAdjust: led.todayAdjust || 0 }
}
// 每日提醒去重：预算 / 低余额两类系统通知各自每天最多一次（按日期字符串比较，跨天自动失效）。
// 返回 true 表示本次调用认领了今天的提醒名额，可以发通知。
const NOTICE_KEYS = { budget: 'budgetNotifiedOn', low: 'lowNotifiedOn' }
function claimDailyNotice(kind) {
  const key = NOTICE_KEYS[kind] || NOTICE_KEYS.budget
  const led = readLedger()
  const t = todayKey()
  if (led[key] === t) return false
  led[key] = t
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) { logErr('[whale][ledger] 写提醒标记失败', err && err.message) }
  return true
}
// 导入：把 [{ date, usage }] 合并进账本历史（同日覆盖），按日期升序只保留最近保留期内的天数。
// 当天（led.date）需同步写入 todayUsage，否则趋势图的当天柱仍取实时累计值，导入的当天行会被忽略；
// lastBalance/lastCurrency 基准不动，实时记账仍在其上累加。
function mergeLedgerHistory(entries) {
  const led = readLedger()
  const hist = led.history && typeof led.history === 'object' ? led.history : {}
  let imported = 0
  for (const e of entries || []) {
    if (!e || typeof e.date !== 'string' || !isFinite(Number(e.usage))) continue
    const v = Math.max(0, Number(e.usage))
    hist[e.date] = v
    if (e.date === led.date) led.todayUsage = v
    imported++
  }
  // 只保留最近 historyKeepDays() 天（history 按日期字符串升序即时间升序）
  const all = Object.keys(hist).sort()
  const keep = historyKeepDays()
  for (let i = 0; i < all.length - keep; i++) delete hist[all[i]]
  led.history = hist
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) { logErr('[whale][ledger] 导入写账本失败', err && err.message) }
  const kept = Object.keys(hist).sort()
  return { imported, kept: kept.length, from: kept[0] || '', to: kept[kept.length - 1] || '' }
}

// 令牌模式：平台返回的今日总量是权威值，直接写入账本当天用量。
// 不写的话趋势图/导出仍取记账累计值，会与挂件显示的「今日已用」对不上。
function setTodayUsage(amount) {
  const led = readLedger()
  led.todayUsage = Math.max(0, Number(amount) || 0)
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) { logErr('[whale][ledger] 写今日用量失败', err && err.message) }
  return led
}

// ──────────────────────────────────────────────
// 计时状态（正计时/倒计时/定时）
// ──────────────────────────────────────────────
// 由悬浮窗在开始/停止/到点时上报；宿主只做落库，重建挂件后回推给页面恢复。
// 传 null 表示清除（用户关掉「计时保存」开关时）。
function readTimer() {
  const dft = { mode: 'off', running: false, paused: false, startAt: 0, endAt: 0, elapsed: 0, remain: 0, arg: '' }
  try {
    const t = utools.dbStorage.getItem(K.timer)
    if (t && typeof t === 'object') {
      return {
        mode: t.mode === 'up' || t.mode === 'down' || t.mode === 'at' ? t.mode : 'off',
        running: t.running === true,
        paused: t.paused === true,
        startAt: isFinite(Number(t.startAt)) ? Number(t.startAt) : 0,
        endAt: isFinite(Number(t.endAt)) ? Number(t.endAt) : 0,
        elapsed: isFinite(Number(t.elapsed)) ? Math.max(0, Number(t.elapsed)) : 0,
        remain: isFinite(Number(t.remain)) ? Math.max(0, Number(t.remain)) : 0,
        arg: typeof t.arg === 'string' ? t.arg : '',
      }
    }
  } catch (err) {}
  return dft
}
function writeTimer(state) {
  try { utools.dbStorage.setItem(K.timer, state) } catch (err) { logErr('[whale][timer] 写计时状态失败', err && err.message) }
}
function clearTimer() {
  try { utools.dbStorage.removeItem(K.timer) } catch (err) {}
}

// ──────────────────────────────────────────────
// 多厂商模型的运行时状态
// ──────────────────────────────────────────────
// 结构：{ [模型 id]: { at, balance, currency, todayUsage, usedPct, resetAt, error } }。
// 只用于展示与预警、不参与记账，所以不进备份（备份里的 config.models 才是用户填的那份）。
function readModelState() {
  try {
    const s = utools.dbStorage.getItem(K.models)
    if (s && typeof s === 'object') return s
  } catch (err) {}
  return {}
}
function writeModelState(state) {
  try {
    utools.dbStorage.setItem(K.models, state && typeof state === 'object' ? state : {})
  } catch (err) {
    logErr('[whale][models] 写模型状态失败', err && err.message)
  }
}
// 删除模型时清掉它的运行时状态（密钥槽位由 settings.js 一并删）
function dropModelState(id) {
  const st = readModelState()
  if (Object.prototype.hasOwnProperty.call(st, id)) {
    delete st[id]
    writeModelState(st)
  }
}

// ──────────────────────────────────────────────
// 窗口锚点
// ──────────────────────────────────────────────
function defaultAnchor() {
  return { hAnchor: 'right', hDist: 0, vAnchor: 'bottom', vDist: 0 }
}
// 内存缓存：拖动滑块/拖拽时每帧都会读锚点，避免高频同步 dbStorage 读取
let anchorCache = null
function readAnchor() {
  if (anchorCache) return anchorCache
  const dft = defaultAnchor()
  try {
    const a = utools.dbStorage.getItem(K.win)
    if (a && typeof a === 'object' &&
        (a.hAnchor === 'left' || a.hAnchor === 'right') && typeof a.hDist === 'number' &&
        (a.vAnchor === 'top' || a.vAnchor === 'bottom') && typeof a.vDist === 'number') {
      anchorCache = { hAnchor: a.hAnchor, hDist: Math.max(0, Math.round(a.hDist)),
                      vAnchor: a.vAnchor, vDist: Math.max(0, Math.round(a.vDist)) }
      return anchorCache
    }
  } catch (err) {}
  anchorCache = dft
  return dft
}
function writeAnchor(a) {
  anchorCache = a
  try { utools.dbStorage.setItem(K.win, a) } catch (err) { logErr('[whale][anchor] 写窗口锚点失败', err && err.message) }
}
// 清除锚点内存缓存（clearAllData 后重新从存储读取）
function resetAnchorCache() { anchorCache = null }

module.exports = {
  readSecrets,
  sanitizeKey,
  writeSecrets,
  defaultConfig,
  clampNum,
  readConfig,
  writeConfig,
  patchConfig,
  normQuotes,
  renderAlert,
  alertOneLine,
  alertFor,
  todayKey,
  historyKeepDays,
  readLedger,
  recordLedgerUsage,
  calibrateTodayUsage,
  claimDailyNotice,
  keyFingerprint,
  mergeLedgerHistory,
  setTodayUsage,
  readTimer,
  writeTimer,
  clearTimer,
  readModelState,
  writeModelState,
  dropModelState,
  normModel,
  normModelId,
  defaultAnchor,
  readAnchor,
  writeAnchor,
  resetAnchorCache,
  // 纯函数，仅导出给单测：归一化写错不会抛错，只会让填的值悄悄变形（见 test/store.test.mjs）
  normTokenPrice,
  // GitHub 加速 IP 表归一化：hosts.js 写块 / 刷新结果与 store 配置共用
  normIps,
  // dsh 快照保留份数的边界（设置页输入框与 dsh-backup.js 的兜底共用同一组数字）
  DSB_KEEP_DEFAULT,
  DSB_KEEP_MIN,
  DSB_KEEP_MAX,
}
