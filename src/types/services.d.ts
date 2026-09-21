// 主窗 preload（public/preload/services.js）注入到 window.services 的宿主 API 类型声明。
// 仅用于设置页（src/App.vue）的类型提示与校验，运行时实现见 public/preload/services.js。

// 挂件形象 id：内置形象的 id 即 public/whale/ 下的图片文件名（宿主 store.js 的 normSkin
// 与设置页 App.vue 的 BUILTIN_SKINS 各有一份同值清单）；'custom' = 用户导入的图片
export type SkinId =
  | 'liuy' | 'black' | 'ciya'
  | 'DSniang1' | 'DSniang02' | 'DSniang3' | 'DSniang4' | 'DSniang5' | 'DSniang6' | 'DSniang7'
  | 'glby' | 'Jian' | '无稽之谈改'
  | 'custom'

export interface WhaleConfig {
  scale: number
  vol: number
  soundOn: boolean
  soundSet: 'duck' | 'fx1' | 'custom'
  usageMode: 'ledger' | 'token'
  peakMode: 'default' | 'liangwen' | 'qiangqiang'
  // 峰/谷时段切换时，用气泡提醒当前价格时段
  peakRemindOn: boolean
  bubbleOn: boolean
  menuBtn: boolean
  onTop: boolean
  lowAlertOn: boolean
  lowAlertAmount: number
  // 今日预算：当日用量超过 budgetAmount 时提醒（气泡 + 每天一次系统通知）；budgetAmount 为 0 表示未设置
  budgetOn: boolean
  budgetAmount: number
  // 余额大幅波动通知：单次采样余额下降 ≥ dropAlertAmount 时弹系统通知（不做每天一次去重）；0 表示未设置
  dropAlertOn: boolean
  dropAlertAmount: number
  // 点气泡依次播放台词（false = 每次随机一组）
  clickQueueOn: boolean
  // 提醒气泡（峰谷/预算/低余额/穿透说明）停留秒数；0 = 常驻，等用户点掉
  remindSec: 0 | 5 | 8 | 15
  // 免打扰时段：时段内只弹挂件气泡、不弹系统通知（支持跨午夜，如 23:00–07:00）
  quietOn: boolean
  quietFrom: string
  quietTo: string
  timeBubbleOn: boolean
  updateCheckOn: boolean
  dragLock: boolean
  // 自动避让任务栏：实时识别任务栏隐藏/显示，任务栏弹出占位时挂件自动让位
  avoidTaskbar: boolean
  // 贴边间距（px，0 = 紧贴该边）：上/右/下/左，以系统当前可用区为准
  edgeTop: number
  edgeRight: number
  edgeBottom: number
  edgeLeft: number
  // 吸附：ratio = 按比例吸附（吸附区宽度 = 可用区宽/高的 snapRatio%）、off = 关闭吸附（松手停在哪就是哪）
  snapMode: 'ratio' | 'off'
  // 吸附区宽度（%，1–45，默认 25）：挂件中心落进该边这个比例内就贴边；关闭吸附时该值不生效
  snapRatio: number
  // 窗口整体透明度 20–100（%），以页面根元素 CSS opacity 生效（透明窗不能用 win.setOpacity）
  opacity: number
  // 鼠标穿透总开关：开启后挂件完全不接收鼠标（含鲸鱼本体），只能回设置页关闭
  passThrough: boolean
  // 挂件形象：内置形象 id（见 SkinId）/ 'custom' 用户导入（图片复制进本地数据目录）
  skin: SkinId
  // 气泡配色主题（颜色走挂件页面 CSS 变量）
  theme: 'default' | 'dark' | 'sakura'
  // 台词库（设置页可编辑，一行一条；空组 = 恢复内置默认）
  quotes: WhaleQuotes
  // 提醒文案模板（设置页可编辑；低余额 / 预算 / 峰谷 / 穿透四类提醒的气泡与系统通知共用一份）
  alerts: WhaleAlerts
  // 额度（资源包 / 订阅）：总量（元，0 = 未设置）与重置周期；已用由账本按周期算，不落配置
  quotaTotal: number
  quotaReset: 'never' | 'daily' | 'monthly'
  // 自定义单价（仅「实时·令牌」模式生效）：谷价（元或美元 / 百万 token）+ 币种 + 汇率（元/USD）
  tokenPrice: WhaleTokenPrice
  // 账本历史保留天数（35–730，默认 365）：账本与明细日志的裁剪窗口，
  // 也是趋势图 / 明细 / CSV 导出能回溯的最长区间
  historyKeepDays: number
  // 计时到点时弹系统通知
  timerNotifyOn: boolean
  // 计时到点的邮件通知（总开关 notifyMailOn 没开时不生效）
  timerMailOn: boolean
  // 记住计时状态：重载插件/重建挂件后继续计时
  timerPersistOn: boolean
  // 计时偏好（重载后不用重新选）：模式 / 倒计时秒数（1–86399）/ 定时时刻 / 到点气泡停留秒数（0=常驻）
  timerMode: 'off' | 'up' | 'down' | 'at'
  timerSec: number
  timerAt: string
  timerRemindSec: 0 | 5 | 8 | 15
  // 到点要做什么：预设留言（显示在到点气泡与通知里，最长 60 字）
  timerNote: string
  // 到点气泡旁「休息」按钮的分钟数（0 = 不显示该按钮）
  timerBreakMin: number
  // 计时气泡是否常驻显示（false = 计时中只短暂显示，点小鲸鱼可随时查看）
  timerBubblePin: boolean
  // 气泡是否只显示计时（false = 计时中气泡照常显示余额/用量等全部内容）
  timerBubbleOnly: boolean
  // 进入插件时显示哪些窗口：both=设置窗+挂件；widget=只显示挂件；settings=只显示设置窗
  enterMode: 'both' | 'widget' | 'settings'
  // 首次运行引导是否已结束（保存凭据或点「跳过」都置 true），之后不再弹
  guideDone: boolean
  // DeepSeek Harness（dsh，开发者）：自定义 Node.js 目录（''=自动探测）/ 退出后是否保留进程
  dshNodeDir: string
  dshKeepAlive: boolean
  // npm 注册源（'' = 官方源）/ 固定版本（'' = 自动：安装/更新时取 latest）/ 更新前是否先删掉插件目录里的 dsh / 启动是否带 --no-open
  dshRegistry: string
  dshVersion: string
  dshReinstall: boolean
  dshNoOpen: boolean
  // 多厂商模型（余额 / 额度）：注册表进配置（随备份与恢复走），运行时余额不在这里
  models: WhaleModel[]
  // 挂件主显示的模型 id（'deepseek' = 内置）
  mainModelId: string
  // 挂件菜单五个分组的展开状态：重开挂件 / 重载插件后保持上次的组合
  menuGroups: { look: boolean; models: boolean; usage: boolean; timer: boolean; dsh: boolean }
  // GitHub 加速（hosts 方案）：on = 开关意图（实际是否生效以 hosts 文件里的标记块为准）；
  // ips = 可编辑 IP 表（{ domain, ip }，非法条目会在保存时被丢弃）
  ghAccelOn: boolean
  ghAccelIps: Array<{ domain: string; ip: string }>
  // 上次成功刷新 IP 表的时间戳（epoch ms；0 = 从未刷新过，设置页据此提示表龄）
  ghAccelRefreshedAt: number
  // IP 获取来源开关：doh = DoH 实时解析、community = 社区源表、manual = 手填/现有 IP 表。
  // 三者默认全开（= 升级前的固定候选链行为）；全关时拒绝开启并提示。
  // 来源开关 + 两段顺序：order 是来源层的候选链顺序（doh / community / manual 谁在前，
  // 空数组 = 用内置默认顺序），sources 是社区源表内部的源顺序（'community:<url>' 前缀），
  // 两者互不影响、各自独立落盘
  ghAccelSrc: { doh: boolean; community: boolean; manual: boolean; sources: string[]; order: string[] }
  // 通知渠道：系统通知（默认开）+ 邮件通知（默认关，需先在「提醒与通知」卡里配好 SMTP）
  notifySystemOn: boolean
  notifyMailOn: boolean
  // 邮件通知的非敏感字段（发件人/收件人/发件人显示名/主题前缀）；
  // SMTP 服务器、账号与授权码属于凭据，走 saveMailSecrets 进加密存储，不在这里
  mailFrom: string
  mailTo: string
  mailFromName: string
  mailSubjectPrefix: string
}

// 台词库：groups 是可增删的随机台词组（一组 = 一个抽签项），time 是白天报时模板（{t} = 当前时间），
// gifFail 是动图加载失败时的顶替文案；后两项不走抽签，固定就是这两份
export interface WhaleQuotes {
  groups: WhaleQuoteGroup[]
  time: string[]
  gifFail: string[]
}

// 随机台词组：kind = card（内置余额 / 时段卡，内容现算、文字不可编辑）/ text（用户填的台词）/
// image（抽一张自定义气泡图）。w 是权重（1–999，越大越常抽到）；style 只对文本组有效：
// A = 普通字号（长句自动换行）、B = 大字（不换行，靠挂件按可用宽度整体缩放）
export interface WhaleQuoteGroup {
  kind: 'card' | 'text' | 'image'
  w: number
  style?: 'A' | 'B'
  lines?: string[]
}

// 自定义单价（「实时·令牌」模式可选）：覆盖内置价目表。填的是谷价（币种 / 百万 token），
// 峰价按官方规则（谷价 × 2）自动翻倍；cur 为 USD 时按 rate（元/USD）折成人民币后记账。
// on = 全局覆盖（对所有模型生效）；models = 按模型覆盖（命中子串的模型用它，未列出的仍走内置表）。
// 两种覆盖可分别使用，同时存在时按模型优先。
export interface WhaleTokenPrice {
  on: boolean
  cur: 'CNY' | 'USD'
  rate: number
  hit: number
  miss: number
  out: number
  models: WhalePriceModel[]
}

// 「按模型覆盖」的一条：name 为模型名（按子串匹配，与内置价目表同规则），单价含义同上（谷价）
export interface WhalePriceModel {
  name: string
  hit: number
  miss: number
  out: number
}

// 提醒文案模板：气泡按行映射到三行（标题 / 大字 / 说明），系统通知取全文（换行合并成一行）。
// 占位符：low = {balance} {threshold}；budget = {used} {budget} {over}；peakOn/peakOff = {schedule}
export interface WhaleAlerts {
  low: string
  budget: string
  peakOn: string
  peakOff: string
  passOn: string
  passOff: string
}

// 邮件通知的 SMTP 凭据（存 dbCryptoStorage.whale:secrets.notifyMail，不进备份）
export interface WhaleMailSecrets {
  mailHost: string
  mailPort: number
  // true = 465 直连 TLS；false = 587/25 明文握手后 STARTTLS 升级
  mailSecure: boolean
  mailUser: string
  mailPass: string
}

export interface WhaleMailResult {
  ok: boolean
  error?: string
}

// 测试邮件的入参 = SMTP 凭据 + 收件人相关字段。
// 收件人/发件人来自配置（非加密存储），但发信必须带上，所以一并传（见 sendTestMail）
export type WhaleMailTestInput = Partial<WhaleMailSecrets & Pick<
  WhaleConfig,
  'mailFrom' | 'mailTo' | 'mailFromName' | 'mailSubjectPrefix'
>>

// 通知渠道自测结果：on = 本次实际发过的渠道名（按配置现算）
export interface WhaleNotifyTestResult {
  ok: boolean
  on: string[]
  system?: boolean
  error?: string
}

export interface WhaleSecrets {
  apiKey: string
  platformToken: string
  // 逐模型密钥：键为模型 id，值为该模型的 API Key
  models: Record<string, string>
  // SMTP 凭据挂在子对象下，**不在顶层** —— 读的时候别直接取 s.mailHost
  notifyMail: WhaleMailSecrets
}

export interface BalanceTestResult {
  ok: boolean
  totalBalance?: number
  currency?: string
  error?: string
  code?: string
  transient?: boolean
}

export interface PlatformUsageTestResult {
  amount?: number
  tokens?: number
  empty?: boolean
  error?: string
}

// 今日单个模型的用量（令牌模式）：amount 按内置单价算出的金额（元），tokens 为该模型总 token
export interface ModelUsageRow {
  model: string
  amount: number
  tokens: number
}

export interface TodayModelsResult {
  ok: boolean
  models?: ModelUsageRow[]
  amount?: number
  tokens?: number
  error?: string
}

export interface UpdateCheckResult {
  ok: boolean
  fresh?: boolean
  at?: number
  current?: string
  latest?: string
  hasUpdate?: boolean
  error?: string
}

export interface WidgetResult {
  ok: boolean
  error?: string | null
}

export interface CodexSummaryResult {
  ok: boolean
  error?: string
  home?: string
  sessions?: number
  changed?: number
  todayTokens?: number
  monthTokens?: number
  totalTokens?: number
  outTokens?: number
  reasonTokens?: number
  cachedTokens?: number
  turns?: number
  // 近 31 天明细（索引 0 是今天），设置页按 7/14/30 档位取尾部
  days31?: { date: string; tokens: number; turns: number }[]
  byModel?: Record<string, { tokens: number; out: number; reason: number; cached: number; turns: number }>
  // 订阅窗口（5h / 周）：来自日志里的 rate_limits，只有 ChatGPT 订阅 provider 才有值
  windows?: CodexWindows | null
  rateLimitsTs?: number
}

// 单个订阅窗口：usedPct 可能为 null（日志只给了重置时间），resetAt 是换算好的绝对时间戳
export interface CodexWindow {
  usedPct: number | null
  resetAt: number | null
  windowMinutes: number | null
  label: string
}
export interface CodexWindows {
  primary: CodexWindow | null
  secondary: CodexWindow | null
  planType: string
  limitName: string
  reached: string
}

// dsh 本地用量统计：读 $DSH_HOME（默认 ~/.dsh）下 dsh-usage 的按天账本与会话投影缓存，
// 纯本地读取，不需要 API Key。source 说明这份数字来自哪里：ledger=按天账本 / sessions=会话级聚合 / none=都没有
export interface DshUsageResult {
  ok: boolean
  error?: string
  home?: string
  source?: 'ledger' | 'sessions' | 'none'
  // 数据源为空时的提示（有数据时为空串）
  note?: string
  // 轮次计数单位：账本给的是 LLM 调用次数，会话缓存给的是对话轮次
  turnsLabel?: string
  // 会话投影缓存文件数 / 其中有实际用量的 / 本次重新解析的
  sessions?: number
  activeSessions?: number
  changed?: number
  todayTokens?: number
  monthTokens?: number
  totalTokens?: number
  inTokens?: number
  cachedTokens?: number
  outTokens?: number
  reasonTokens?: number
  turns?: number
  // 花费（账本口径，只对 DeepSeek 官方有值，单位为 costCurrency）
  costToday?: number
  costMonth?: number
  costTotal?: number
  costCurrency?: string
  // 近 31 天明细（索引 0 是今天），设置页按 7/14/30 档位取尾部
  days31?: { date: string; tokens: number; cost: number; turns: number }[]
  byModel?: Record<string, { tokens: number; in: number; cached: number; out: number; reason: number; turns: number; cost: number }>
  // dsh-usage 抓到的官方余额快照（可能为空）
  balance?: { provider: string; currency: string; amount: number; at: number } | null
  spendWatch?: { accruedCny: number; since: number; lastBalanceCny: number } | null
}

export interface ClearDataResult {
  ok: boolean
  // 各项是否被清除（按项清除的结果回显）
  cleared?: {
    // 凭据（API Key / 平台 Token）
    secrets: boolean
    // 挂件设置
    config: boolean
    // 账本用量记录
    ledger: boolean
    // 窗口位置与更新缓存
    window: boolean
    // 自定义音效（音频文件 + 元信息）
    sounds: boolean
    // 自定义挂件形象（图片文件 + 元信息）
    skins: boolean
    // 自定义气泡图片（图片文件 + 元信息）
    bubbles: boolean
  }
  error?: string
}

export interface UsageHistoryResult {
  currency: string
  days: Array<{ date: string; usage: number }>
  // 今日被防误判拦下、未计入用量的余额变动合计（赠送额度到期/被收回、异常跳变）
  todayAdjust?: number
  // 最近一次未计入变动的原因与时间（ISO）
  lastAdjustWhy?: string
  lastAdjustAt?: string
  // 额度「不重置」口径的累计已用（归档累计 + 今天）
  cumUsed?: number
}

// 账本明细里的单条记录。kind='adjust' 是「被判定为非消费、未计入用量」的余额变动，
// kind='calibrate' 是手动校准今日已用；两类字段不同，故都标可选（按 kind 取用）。
export interface LedgerDetailEntry {
  at: string
  kind: 'adjust' | 'calibrate'
  // adjust：变动金额（正数）与原因；calibrate：校准前/后金额
  amount?: number
  why?: string
  from?: number
  to?: number
}

export interface LedgerDetailDay {
  date: string
  usage: number
  entries: LedgerDetailEntry[]
}

export interface UsageDetailResult {
  currency: string
  days: LedgerDetailDay[]
  // 区间内用量合计
  total: number
}

export interface CalibrateResult {
  ok: boolean
  // 校准前/后的今日已用
  from?: number
  to?: number
  // 当前未计入用量的变动合计
  todayAdjust?: number
  error?: string
}

// 音效槽位：press / release 是「音色」的按压与释放两段（有内置回落）；
// low / budget / peak / pass 是四类提醒（低余额 / 今日预算 / 峰谷切换 / 鼠标穿透）各自的提醒音，留空即静音。
// 每个槽位是一个「音效组」——可导入多段，挂件每次随机播一条
export type SoundRole = 'press' | 'release' | 'low' | 'budget' | 'peak' | 'pass'

// 自定义音效元信息（名称仅用于展示；音频本体由宿主按 file 从本地读）
export interface SoundMeta {
  name: string
  ext: string
  at: number
  // 落盘文件名（userData/whale-sounds 下）：一槽位多段时靠它区分，删除也要按它定位
  file: string
  // 音频体积（字节，宿主读取时派生；文件缺失为 0），供「自定义素材」卡片展示
  size: number
}

export interface SoundImportResult {
  ok: boolean
  role?: string
  name?: string
  ext?: string
  canceled?: boolean
  error?: string
}

// 选择音频文件（不落盘）：dataUrl 供设置页解码波形、试听与裁剪，用户确认后才由 importSoundFromData 写入
export interface SoundPickResult {
  ok: boolean
  name?: string
  ext?: string
  dataUrl?: string
  canceled?: boolean
  error?: string
}

// 自定义挂件形象元信息（名称仅用于展示；图片本体由宿主按 ext 从本地读成 data URL）
export interface SkinMeta {
  id: string
  name: string
  ext: string
  at: number
  // 图片体积（字节，宿主读取时派生；文件缺失为 0），供「自定义素材」卡片展示
  size: number
}

// 画廊里的一张：元信息 + 缩略图。缩略图缺失（老数据/生成失败）时小图回落到原图，大图为空串
export interface SkinGalleryItem extends SkinMeta {
  thumb: string
}

export interface SkinGallery {
  // 挂件当前使用的那张的 id；画廊为空时为空串
  current: string
  items: SkinGalleryItem[]
}

export interface SkinImportResult {
  ok: boolean
  id?: string
  name?: string
  ext?: string
  canceled?: boolean
  error?: string
}

// 选择图片文件（不落盘）：dataUrl 供设置页显示裁剪框，用户确认后才由 importSkinFromData 写入
export interface SkinPickResult {
  ok: boolean
  name?: string
  ext?: string
  dataUrl?: string
  filePath?: string
  canceled?: boolean
  error?: string
}

// 自定义气泡图片元信息（点鲸鱼抽到「动图组」时随机显示一张；无「当前用哪张」概念）
export interface BubbleMeta {
  id: string
  name: string
  ext: string
  at: number
  // 图片体积（字节，宿主读取时派生；文件缺失为 0），供「自定义素材」卡片展示
  size: number
  // 设置页网格用的小图（data URL，缺失时为空串）
  thumb: string
}

export interface BubbleList {
  items: BubbleMeta[]
}

export interface BubbleImportResult {
  ok: boolean
  id?: string
  name?: string
  ext?: string
  canceled?: boolean
  error?: string
}

// 选择气泡图片（不落盘）：dataUrl 供设置页生成缩略图，用户确认后才由 importBubbleFromData 写入
export interface BubblePickResult {
  ok: boolean
  name?: string
  ext?: string
  dataUrl?: string
  canceled?: boolean
  error?: string
}

// 素材包导出结果
export interface AssetsExportResult {
  ok: boolean
  // 用户取消保存对话框
  canceled?: boolean
  path?: string
  exportedAt?: string
  // 包内形象张数、音效段数与气泡图张数
  skins?: number
  sounds?: number
  bubbles?: number
  error?: string
}

// 素材包预览（选择文件后解析出来，尚未写入任何数据）
export interface AssetsPreviewResult {
  ok: boolean
  canceled?: boolean
  path?: string
  exportedAt?: string
  appVersion?: string
  has?: { skins: number; sounds: number; bubbles: number }
  // 包内形象/气泡图文件名（最多 40 条）与音效槽位，仅供预览展示
  skinNames?: string[]
  soundRoles?: string[]
  bubbleNames?: string[]
  error?: string
}

// 素材包导入结果
export interface AssetsApplyResult {
  ok: boolean
  // 形象是「补充」：added = 新增张数，skipped = 因画廊已满（20 张）未导入的张数
  skins?: { added: number; skipped: number }
  // 音效是「同槽位覆盖」：applied = 写入段数
  sounds?: { applied: number }
  // 气泡图也是「补充」：skipped = 因已达上限（8 张）未导入的张数
  bubbles?: { added: number; skipped: number }
  errors?: string[]
  error?: string
}

export interface UsageCsvResult {
  ok: boolean
  // 用户取消保存对话框
  canceled?: boolean
  // 保存成功后的绝对路径
  path?: string
  error?: string
}

export interface UsageCsvImportResult {
  ok: boolean
  // 用户取消文件选择对话框
  canceled?: boolean
  // 导入文件路径
  path?: string
  error?: string
  // 成功合并的行数
  imported?: number
  // 忽略的非法行数（表头不计）
  invalid?: number
  // 合并后账本保留的天数
  kept?: number
  // 合并后账本覆盖的日期范围
  from?: string
  to?: string
}

export interface DebugLogResult {
  // 日志文件绝对路径（非 dev 为空串）
  path: string
  // 日志末尾内容（非 dev 为空串）
  text: string
}

// dsh（DeepSeek Harness）运行状态快照
export interface DshStatus {
  running: boolean
  stopping: boolean
  // '' | 'update'
  busy: string
  pid: number
  startedAt: number
  exitCode: number | null
  exitAt: number
  keepAlive: boolean
  url: string
  port: number
  // 实际生效的 Node.js 目录与版本
  nodeDir: string
  nodeVersion: string
  // 目录是否来自自动探测
  nodeAuto: boolean
  found: boolean
  error: string
  // 最近执行过的命令（启动/更新/结束），界面直接展示
  lastCmd: string
  log: string
  // dsh 相关配置回显
  registry: string
  version: string
  // 「实际会跑」的版本（全局优先，其次插件目录）
  resolved: string
  // 已查询到 latest 且比当前用的新（界面提示「有新版本」）
  hasUpdate: boolean
  // 用哪一份：global=全局安装（优先）；plugin=插件目录；''=都没有
  source: 'global' | 'plugin' | ''
  // 全局安装的那份（没有则为空）
  globalVersion: string
  globalDir: string
  // 全局安装目录当前用户可写？（false 时「更新」会弹一次 UAC 提权）
  globalWritable: boolean
  // 更新前是否先删掉插件目录里的 dsh
  reinstall: boolean
  // 插件自己那份 dsh 的安装目录
  prefix: string
  // 「查询可用版本」结果（list 按版本号升序，latest 为最后一个）
  versions: { at: number; latest: string; list: string[] }
  // 3080 上的进程探测：external=别的终端启动的 dsh；portOther=非 dsh 进程名
  external: boolean
  externalPid: number
  externalName: string
  extBusy: boolean
  portOther: string
  // 本插件启动的进程是否已就绪（3080 开始监听）；npx 首次启动要下载，会有「启动中」阶段
  ready: boolean
  readyAt: number
  // dsh 打印的带 token 的页面地址（浏览器首次访问需要它，否则提示 authentication required）
  webUrl: string
  // 实际已安装的 dsh 版本（npx 缓存，探测不到为空）
  installed: string
  // 本次启动实际用的版本；缓存里已换成别的版本时 needsRestart=true（需点「重启」才生效）
  runVersion: string
  needsRestart: boolean
}

export interface DshDirPickResult {
  ok: boolean
  canceled?: boolean
  dir?: string
  error?: string
}

// —— GitHub 加速（hosts 方案） ——
// 实际状态：读 hosts 文件现算；on = 标记块完整（尾标记在头标记之后），active = 块内解析出的生效域名
export interface GhAccelStatus {
  ok: boolean
  on: boolean
  // 头标记在、尾标记不在：块被截断/改坏，内容不生效且会留下残留（提示「重新写入 hosts」）
  broken?: boolean
  // 块被其它工具挤出文件最前（对方在本插件之后又写 hosts），first-match 被抢、加速失效
  degraded?: boolean
  active: string[]
  hostsPath: string
  error?: string
}
// 块之外已存在的目标域名条目（first-match 解析会覆盖本插件的块）
export interface GhAccelConflict {
  domain: string
  ip: string
  line: string
  // 按条目特征猜的「是哪类工具写的」（回环 IP = 本地反代类）；判不准时为空串
  writer?: string
}
// 最近一次 IP 获取的来源追踪（内存态，重开插件清空）：回答「每个域名的 IP 通过什么方式、从哪里获取」
export interface GhAccelTrace {
  at: number
  // 本次 DoH 实时解析中实际返回过 A 记录的 DoH 入口（域名或直连 IP 形式）
  dohResolvers: string[]
  // DoH 实时解析出的逐域名 IP（并集，未过探测）；只含配置了实时解析的域名（主站 + 高频入口）
  dohByDomain: Record<string, string[]>
  // 上面每个 IP 具体由哪家 DoH 解析出（阿里 DNS / Cloudflare / Google），支撑「来源」列点名到厂商
  dohOrigin: Record<string, string>
  // 刷新用到的社区源 URL（GitHub520 主源或镜像），空 = 本次没刷新
  refreshUrl: string
  // 每个域名最终选中的 IP + 来源（带具体出处，如「DoH 实时解析 · 阿里 DNS」「社区源表 · raw.hellogithub.com」）
  byDomain: Record<string, { ip: string; source: string }>
}
// 一次 GitHub 加速操作（开启 / 关闭 / 刷新 / 校验 / 检测）的步骤记录，供「GitHub 加速日志」回看
export interface GhAccelOpStep {
  // 这一步在干什么，如「拉取社区源 raw.hellogithub.com」
  text: string
  // done 正常完成 / fail 失败 / skip 跳过（条件不满足，非错误） / running 进行中
  state: 'done' | 'fail' | 'skip' | 'running'
  // 结果与关键数据，如「命中 13 个域名（源共 21 条目标条目）」
  detail: string
}
export interface GhAccelOpLog {
  id: number
  at: number
  // 操作名，如「刷新 IP 表（拉取社区源）」
  title: string
  // running 进行中；ok 成功；fail 失败；cancel 用户取消（UAC 点否）
  state: 'running' | 'ok' | 'fail' | 'cancel'
  // 一句话总结结果，running 时为空
  summary: string
  // 总耗时 ms，未结束时为 0
  ms: number
  steps: GhAccelOpStep[]
}
// 开启/关闭结果；canceled = UAC 被取消；already = 关闭时 hosts 里本来就没块（没弹 UAC）
export interface GhAccelOpResult {
  ok: boolean
  canceled?: boolean
  already?: boolean
  error?: string
  // 实际写入 hosts 的 IP 表（开启时可能已刷新 + 过滤不可达，与传入的表不同）
  ips?: Array<{ domain: string; ip: string }>
}
// 一键刷新结果：updated = 新 IP 表，total = 源里目标域名条目数，skipped = 源里没有、保留旧值的域名数
export interface GhAccelRefreshResult {
  ok: boolean
  updated?: Array<{ domain: string; ip: string }>
  total?: number
  skipped?: number
  // 候选链给的 IP 探测不通的条数；unreachable 中旧值复验也不通、最终未写入的条数看 dropped
  unreachable?: number
  dropped?: number
  error?: string
}
// 连通性自检结果：ms = 往返耗时，status = HTTP 状态
export interface GhAccelProbeResult {
  ok: boolean
  ms: number
  status?: number
  error?: string
}
// IP 表校验结果：results = 每条逐项探测结论；bad = 不可达（建议删除）；
// stale = 不可达但命中当前实时 A 记录（多为探测抖动，界面不推荐删除）
export interface GhAccelVerifyItem {
  domain: string
  ip: string
  ok: boolean
}
export interface GhAccelVerifyResult {
  ok: boolean
  results: GhAccelVerifyItem[]
  bad: GhAccelVerifyItem[]
  stale: GhAccelVerifyItem[]
  checkedAt: number
}

// 备份导出结果
export interface BackupExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  withSecrets?: boolean
  exportedAt?: string
  error?: string
}

// 备份预览（选择文件后解析出来，尚未写入）
export interface BackupPreviewResult {
  ok: boolean
  canceled?: boolean
  path?: string
  exportedAt?: string
  appVersion?: string
  has?: { config: boolean; ledger: boolean; window: boolean; timer: boolean; secrets: boolean }
  error?: string
}

// 备份恢复结果
export interface BackupApplyResult {
  ok: boolean
  applied?: string[]
  skipped?: string[]
  errors?: string[]
  widgetRebuilt?: boolean
  error?: string
}

// —— 多厂商模型（余额 / 额度 / 本地会话统计） ——
// 单个模型的「配置」（持久化在 whale:config.models 里，密钥另存加密存储）。
// kind='balance' 表示接口给的是钱，'quota' 表示订阅额度（接口给的是窗口用量%），
// 'codex' 表示本机 Codex 会话统计（读 ~/.codex 的会话日志，单位 token，无接口无密钥）。
// 字段路径支持 a.b[0].c 形式；scale / usedScale 是取到值之后的乘数（接口单位与展示单位不一致时用）。
export interface WhaleModel {
  id: string
  // 厂商模板 key（见 constants.js 的 MODEL_TEMPLATES），只用于预填与展示，不影响查询
  tpl: string
  name: string
  kind: 'balance' | 'quota' | 'codex'
  currency: 'CNY' | 'USD'
  // 认证方式：'bearer' → Authorization: Bearer {key}；'raw' → Authorization: {key}
  auth: 'bearer' | 'raw'
  // 余额接口；含 {base} 时用 baseUrl 替换（OpenAI 兼容中转站）
  url: string
  baseUrl: string
  path: string
  scale: number
  // 「已用额度」来自另一个接口时填（余额 = path - usedPath * usedScale，如 OpenRouter）
  usedUrl: string
  usedPath: string
  usedScale: number
  usedPctPath: string
  remainPctPath: string
  remainPath: string
  totalPath: string
  resetPath: string
  // 多窗口额度（OpenCode Go 的 5h/周/月、MiniMax 的 5h/周）：字段与顶层同构，只多 key/label。
  // 只由模板预填，设置页不提供编辑；空数组 = 单窗口，按顶层字段取值
  windows: QuotaWindowSpec[]
  lowAlertOn: boolean
  lowAlertAmount: number
}

// 订阅额度的单个窗口定义（配置侧）
export interface QuotaWindowSpec {
  key: string
  label: string
  usedPctPath?: string
  remainPctPath?: string
  remainPath?: string
  totalPath?: string
  resetPath?: string
}

// 订阅额度的单个窗口查询结果
export interface QuotaWindow {
  key: string
  label: string
  // 已用百分比（0–100）
  usedPct: number
  // 该窗口的重置时刻（毫秒时间戳，0 = 接口没给）
  resetAt: number
}

// 厂商模板：字段与 WhaleModel 同构但可缺省（缺的由宿主回默认）
export interface WhaleModelTemplate extends Partial<WhaleModel> {
  name: string
  kind: 'balance' | 'quota' | 'codex'
  currency: 'CNY' | 'USD'
  // 该模板必须填 Base URL（如 OpenAI 兼容中转站）
  needsBaseUrl?: boolean
  // 内置模板（DeepSeek 本身），不可删
  builtin?: boolean
}

// 模型列表里的一行（含内置 DeepSeek）：余额/额度是查询结果，不是配置
export interface WhaleModelRow {
  id: string
  name: string
  kind: 'balance' | 'quota' | 'codex'
  currency: string
  builtin: boolean
  // 余额（原币种）；未查询到为 null
  balance: number | null
  // 由相邻两次余额差估算的今日已用
  todayUsage: number | null
  // 额度类：已用百分比
  usedPct: number | null
  // 额度重置时刻（毫秒时间戳，0 = 接口没给）
  resetAt: number
  // 额度类且接口给了多个窗口时非空（首个窗口即 usedPct / resetAt 那一条）
  windows: QuotaWindow[] | null
  // Codex 本地会话类（kind='codex'）：今日 token 与本月累计 token
  tokens: number | null
  monthTokens: number | null
  // Codex 订阅窗口（5h / 周）：日志里有 rate_limits 才非空，API-key 计费时为 null
  codexWindows: CodexWindows | null
  // 上次查询成功时刻（毫秒时间戳）
  at: number
  error: string
  lowAlertOn: boolean
  lowAlertAmount: number
}

export interface WhaleModelsResult {
  list: WhaleModelRow[]
  mainModelId: string
}

export interface WhaleModelTemplatesResult {
  templates: Record<string, WhaleModelTemplate>
  max: number
  mainModelId: string
}

// 单个模型的查询结果（设置页「测试」用，不落库）
export interface ModelBalanceResult {
  ok: boolean
  balance?: number
  usedPct?: number
  resetAt?: number
  // 多窗口额度接口（OpenCode Go / MiniMax）返回的全部窗口；首个窗口即 usedPct / resetAt
  windows?: QuotaWindow[]
  // Codex 本地会话统计（kind='codex'）：今日 token 与本月累计 token
  tokens?: number
  monthTokens?: number
  currency?: string
  error?: string
  code?: string
}

export interface ModelSaveResult {
  ok: boolean
  id?: string
  // 该模型是否已存有密钥（用于列表上的「已配置密钥」标记）
  hasKey?: boolean
  error?: string
}

export interface TaskbarState {
  state: 'visible' | 'hidden' | 'none'
  // 'left' | 'top' | 'right' | 'bottom'，未识别到时为空串
  edge: string
  // 任务栏厚度（DIP，px）；未识别到时为 0
  thickness: number
}

export interface WhaleServices {
  getConfig(): WhaleConfig
  // 订阅配置变更（挂件菜单改设置时宿主广播过来），返回退订函数
  onConfigChange(cb: (cfg: WhaleConfig) => void): () => void
  // 任务栏当前状态：visible = 正在占位（常显/自动隐藏已弹出）/ hidden = 已自动收起 / none = 未识别到
  getTaskbarState(): TaskbarState
  getVersion(): string
  checkUpdate(force?: boolean): Promise<UpdateCheckResult>
  openExternal(url: string): boolean
  // 让 uTools 底座跳「插件应用市场」并搜索关键词；返回 false 表示底座不支持，需调用方兜底
  redirectToMarket(keyword: string): boolean
  // __live: 拖动滑块中的实时预览，只改窗口几何，不写存储
  saveConfig(patch: Partial<WhaleConfig> & { __live?: boolean }): WhaleConfig
  getSecrets(): WhaleSecrets
  saveSecrets(secrets: Partial<WhaleSecrets>): { hasApiKey: boolean; hasPlatformToken: boolean }
  // 是否需要弹「首次运行引导」：guideDone 未置位且尚未填 API Key（老用户升级上来不会为 true）
  needFirstRunGuide(): boolean
  // 结束首次运行引导（保存凭据或跳过都调它），置位 guideDone
  finishFirstRunGuide(): boolean
  // 邮件通知的 SMTP 凭据：走加密存储（不进备份）。mailPass 留空 = 沿用已保存的授权码
  saveMailSecrets(mail: Partial<WhaleMailSecrets>): WhaleMailSecrets
  // 用给定（或已保存的）SMTP 配置发一封测试邮件，不落库
  sendTestMail(mail: WhaleMailTestInput): Promise<WhaleMailResult>
  // 按当前开着的通知渠道各发一条测试通知（不做去重），不落库
  testNotify(): Promise<WhaleNotifyTestResult>
  testApiKey(apiKey: string): Promise<BalanceTestResult>
  testPlatformToken(platformToken: string): Promise<PlatformUsageTestResult>
  getUsageHistory(days?: number): UsageHistoryResult
  // 账本明细：近 N 天每日用量 + 当天的异常变动/校准记录（检索由设置页本地过滤）
  getUsageDetail(days?: number): UsageDetailResult
  // 今日各模型金额占比（令牌模式；记账模式接口不给模型明细，返回 ok:false）
  getTodayModels(): Promise<TodayModelsResult>
  // 手动校准今日已用（仅记账模式有意义；令牌模式下平台返回会覆盖）
  calibrateTodayUsage(amount: number): CalibrateResult
  // —— 自定义音效（按压/释放两段 + 四类提醒各一组；文件复制进 userData/whale-sounds） ——
  getSounds(): Record<SoundRole, SoundMeta[]>
  // 音效本体（base64 data URL 数组），供设置页试听
  getSoundData(): Record<SoundRole, string[]>
  importSound(role: SoundRole): SoundImportResult
  // 选音频（不落盘）→ 设置页裁剪 → importSoundFromData 写入裁剪后的 WAV
  pickSoundFile(): SoundPickResult
  importSoundFromData(role: SoundRole, name: string, dataUrl: string): SoundImportResult
  // 不给 file 时清空整个槽位
  removeSound(role: SoundRole, file?: string): { ok: boolean; role: string; error?: string }
  // —— 自定义挂件形象画廊（多张图片；文件复制进 userData/whale-skins） ——
  // 画廊列表：元信息 + 缩略图 data URL（current = 挂件当前用的那张的 id）
  listSkins(): SkinGallery
  // 当前形象元信息（画廊为空时返回 null），供「自定义素材」卡片展示
  getSkin(): SkinMeta | null
  // 当前形象本体（base64 data URL，挂件 img.src 直接用）；空串表示无自定义形象
  getSkinData(): string
  importSkin(): SkinImportResult
  // 选图片（不落盘）→ 设置页裁剪 → importSkinFromData 写入裁剪后的 PNG
  pickImageFile(): SkinPickResult
  // 已选好的文件直接复制（不裁剪）：动图（gif/apng）走这条路径保留动画。thumb 是设置页生成的缩略图
  importSkinFromPath(filePath: string, name: string, thumb: string): SkinImportResult
  importSkinFromData(name: string, dataUrl: string, thumb: string): SkinImportResult
  // 换用画廊里的某一张
  setSkinCurrent(id: string): { ok: boolean; current?: string; error?: string }
  // 把某一张移到画廊最前（不改变当前使用的那张）
  pinSkin(id: string): { ok: boolean; error?: string }
  removeSkin(id: string): { ok: boolean; current?: string; left?: number; error?: string }
  // —— 自定义气泡图片（点鲸鱼随机显示一张；文件复制进 userData/whale-bubbles） ——
  // 列表：元信息 + 缩略图 data URL
  listBubbles(): BubbleList
  // 选图片（不落盘）→ 设置页生成缩略图 → importBubbleFromData 写入原图
  pickBubbleFile(): BubblePickResult
  importBubbleFromData(name: string, dataUrl: string, thumb: string): BubbleImportResult
  removeBubble(id: string): { ok: boolean; left?: number; error?: string }
  // —— 素材包（形象 + 音效 + 气泡图打包成一个 .whaleassets 文件，换机器时一次带走） ——
  assetsExport(): AssetsExportResult
  // 选择素材包并解析预览（不写任何数据）
  assetsPick(): AssetsPreviewResult
  // 按勾选项写入：形象/气泡图补充（新 id）、音效同槽位覆盖
  assetsApply(opts: { skins?: boolean; sounds?: boolean; bubbles?: boolean }): AssetsApplyResult
  // 放弃本次选择
  assetsCancel(): { ok: boolean }
  // Codex 本地会话统计：读 ~/.codex/sessions 下的 rollout JSONL，按天/模型聚合
  codexSummary(): CodexSummaryResult
  clearCodexCache(): void
  // dsh 本地用量统计：读 $DSH_HOME（默认 ~/.dsh）下 dsh-usage 的账本与会话投影缓存，按天/模型聚合
  dshUsageSummary(): DshUsageResult
  clearDshUsageCache(): void
  exportUsageCsv(days?: number): UsageCsvResult
  importUsageCsv(): UsageCsvImportResult
  // 按项清除本地数据：true 的项才会被清除
  clearAllData(opts?: { secrets?: boolean; config?: boolean; ledger?: boolean; window?: boolean; sounds?: boolean; skins?: boolean; bubbles?: boolean }): ClearDataResult
  ensureWidget(): WidgetResult
  showWidget(): WidgetResult
  getWidgetError(): string | null
  hideWidget(): boolean
  // 把挂件位置复位到默认锚点（右下角、紧贴边缘）
  resetWidgetPosition(): WidgetResult
  copyText(text: string): boolean
  redirectHotKeySetting(cmdLabel?: string): boolean
  isWidgetVisible(): boolean
  // 诊断日志（落盘于 %TEMP%\whale-debug.log，进程被 uTools 结束也不丢）
  getDebugLog(): DebugLogResult
  openLogFile(): { ok: boolean; path: string }
  // DeepSeek Harness（dsh）：状态与 启动/重启/结束/更新/打开页面
  dshStatus(): DshStatus
  dshStart(): DshStatus
  dshStop(): DshStatus
  dshRestart(): DshStatus
  dshUpdate(): DshStatus
  // 打开 Web UI（用捕获到的带 token 地址），返回实际打开的地址，失败返回 ''
  dshOpenWeb(): string
  // 查询可用版本（结果在状态的 versions 字段里，稍后刷新状态可见）
  dshListVersions(): DshStatus
  // 清空内存日志
  dshClearLog(): DshStatus
  // 删除插件目录里的那份 dsh
  dshRemovePlugin(): DshStatus
  // 清理 npx 缓存里含 dsh 的历史副本
  dshCleanNpxCache(): DshStatus
  // 选择 Node.js 安装目录（文件夹选择器，校验目录里有 node）
  dshPickNodeDir(): DshDirPickResult
  // —— GitHub 加速（hosts 方案，纯设置页功能） ——
  // 实际状态：读 hosts 文件现算（标记块存在 = 生效），不依赖配置里的开关意图。
  // 异步：宿主是同进程直调（非 IPC），读文件走异步 fs 以免阻塞渲染线程
  ghAccelStatus(): Promise<GhAccelStatus>
  // 最近一次 IP 获取的来源追踪（内存态）：每个域名最终 IP 从哪来（DoH/社区源表/当前表/快照/兜底）
  ghAccelTrace(): GhAccelTrace
  // 可选的社区源表清单（含默认顺序 / 当前生效顺序）：设置页「自定义源表优先级」按它渲染，
  // 前端不抄一份 URL，避免随版本漂移。
  // custom 是宿主校验后的自定义源（设置页贴的 URL 是否被接受以这份为准）、max 是数量上限
  ghAccelSources(): {
    all: Array<{ url: string; host: string; custom?: boolean }>
    order: string[]
    custom?: string[]
    max?: number
  }
  // 块之外已存在的目标域名条目（其它工具也写 hosts 时会覆盖本插件，提示先关掉对方）
  ghAccelScanConflicts(): Promise<GhAccelConflict[]>
  // 开启：refresh=true 时先静默刷新 GitHub520 并逐 IP 探测，只写当前网络可达的；
  // 全不可达时拒绝写入并返回 error。结果 ips = 实际写入的表（刷新后可能与传入不同）
  ghAccelEnable(ips?: Array<{ domain: string; ip: string }>, refresh?: boolean): Promise<GhAccelOpResult>
  ghAccelDisable(): Promise<GhAccelOpResult>
  // 一键刷新 IP 表（GitHub520 源）：current 传当前表，源里没有的域名沿用当前值，不会丢失
  ghAccelRefreshIps(current?: Array<{ domain: string; ip: string }>): Promise<GhAccelRefreshResult>
  // 校验 IP 表：逐条探测只给结论（不删表），删除由设置页确认后走 saveConfig
  ghAccelVerifyIps(ips?: Array<{ domain: string; ip: string }>): Promise<GhAccelVerifyResult>
  // GitHub 加速操作日志（内存态，最多 50 条，重开插件清空）
  ghAccelOpLogs(): GhAccelOpLog[]
  // 清空操作日志，cleared = 清掉的条数
  ghAccelClearOpLogs(): { cleared: number }
  // 连通性自检（HEAD https://github.com），开启前后各测一次做对比
  ghAccelProbe(): Promise<GhAccelProbeResult>
  // —— 备份 / 恢复 ——
  // 导出备份（secrets=true 时用 password 加密后才写入凭据）
  backupExport(opts: { secrets?: boolean; password?: string }): BackupExportResult
  // 选择备份文件并解析预览（不写任何数据）
  backupPick(): BackupPreviewResult
  // 按勾选项恢复（同名覆盖）
  backupApply(opts: { config?: boolean; ledger?: boolean; window?: boolean; timer?: boolean; secrets?: boolean; password?: string }): BackupApplyResult
  // 放弃本次选择
  backupCancel(): { ok: boolean }
  // —— 多厂商模型（余额 / 额度） ——
  // 列表（含内置 DeepSeek 那条）+ 当前主显示模型，供列表渲染
  getModels(): WhaleModelsResult
  // 厂商模板表（含数量上限），供「添加模型」时预填
  getModelTemplates(): WhaleModelTemplatesResult
  // 完整模型配置（含接口地址与字段路径），供行内编辑原样回填
  getModelsConfig(): WhaleModel[]
  // 新增 / 编辑：key 省略 = 不动密钥，空串 = 清空该模型密钥
  saveModel(model: Partial<WhaleModel>, key?: string): ModelSaveResult
  removeModel(id: string): { ok: boolean; error?: string }
  // 切换挂件主显示模型（不存在时宿主回退内置 DeepSeek）
  setMainModel(id: string): { ok: boolean; mainModelId?: string; error?: string }
  // 用给定条目直接验证（不落库）：key 省略时取该模型已保存的密钥
  testModel(model: Partial<WhaleModel>, key?: string): Promise<ModelBalanceResult>
  // 刷新余额/额度（ids 省略 = 全部；force=false 时跳过刚拉过的）
  refreshModels(ids?: string[] | null, force?: boolean): Promise<{ ok: boolean }>
}

declare global {
  interface Window {
    services: WhaleServices
  }
}
