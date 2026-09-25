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
  // dsh 插件市场目录源（并发竞速，见 dsh-market.js 的 loadCatalog）：
  //   url      = 自定义目录 URL（'' = 不加这条）
  //   mirror   = 是否让镜像源参赛（默认开）
  //   registry = 参赛的 registry（'' = 宿主内置默认，即实测延迟最低的那条）
  //   official = 是否让官方源参赛。默认 false —— 实测官方源 4.37MB 要 52–99s 且常连不上
  dshMarketUrl: string
  dshMarketMirror: boolean
  dshMarketRegistry: string
  dshMarketOfficial: boolean
  // dsh 全量导出（见 preload/lib/dsh-export.js）：
  //   cred = 是否把凭据文件（.credentials.yaml 等）打进包。默认 false —— 包里是明文
  //   noMod = 是否跳过 node_modules。默认 true —— 可重建且体积是配置的几十倍
  dshExportCred: boolean
  dshExportNoMod: boolean
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

// dsh 只读诊断里单条问题明细。level 与 severity 是两套东西：
// level 描述「这条明细有多严重」，severity 描述「这个检查项本身归哪一档」
export interface DshDiagnoseFinding {
  level: 'ok' | 'warn' | 'error'
  text: string
  // 给出下一步怎么办（诊断的价值在于说清「为什么」和「怎么办」）
  hint?: string
}

// 单个检查项的结果。threw 表示该项自身抛错（§3.2 约定 2：不影响其余项）
export interface DshDiagnoseItem {
  id: string
  title: string
  severity: 'critical' | 'warning' | 'ok'
  // 本期恒 false（只读诊断不做修复）
  fixable: boolean
  ok: boolean
  summary: string
  findings: DshDiagnoseFinding[]
  threw: boolean
}

// dsh 只读诊断结果。
// ⚠️ ok 只看「是否存在 error 级 finding」；C5 端口「无法判定」是 warning，
// 会让对应项显示 [!] 但不应让整轮 ok 变 false（D26）
export interface DshDiagnoseResult {
  ok: boolean
  at: number
  // 命中 60s TTL 缓存时为 true（设置页据此提示「这是旧结果」）
  cached: boolean
  pass: number
  bad: number
  results: DshDiagnoseItem[]
  // 整轮编排层失败时的原因（单项抛错不走这里）
  error?: string
  // 读环境失败 / 超时兜底时为 null，设置页要按「读不到」渲染而不是当「未安装」
  env: {
    // $DSH_HOME（默认 ~/.dsh），与 dsh 用量统计同口径
    home: string
    nodeVersion: string
    dshVersion: string
    dshSource: string
    profile: string
    installed: boolean
  } | null
}

// dsh 配置转储的一层（D1 五层分层可视化）。
// kind 的三种取值对应「这一层的来源」：
//   · base   —— bundle 内置（没被任何 patch 覆盖的包）
//   · bundle —— 包内另一份 patch（如 @deepseek-ai/dsh-web-app 覆盖 dsh-base）
//   · user   —— 用户层（profile / home 的 cordis.patch.yml），按**绝对路径**聚合
export interface DshDumpLayer {
  kind: 'base' | 'bundle' | 'user'
  // 界面显示名：包名，或用户层缩短后的来源名（如 profiles/web）
  name: string
  // 用户层为 cordis.patch.yml 绝对路径；包内层为包名；base 层为 ''
  source: string
  // 该层覆盖到的条目 id，**已去重**（dump 会把同一批条目在多个分节里重复列出）
  items: string[]
  // items 的条数
  itemCount: number
  // 界面直接渲染的预览：items 的前 40 个（避免一次渲染上百个 id）
  preview: string[]
  // dump 里该层的 id 出现次数是否多于去重后的条数（true 说明分节有重复列举）
  repeat: boolean
  // 该层涉及的 dump 分节数（一个包 patch 多个包就会有多个分节）
  sectionCount: number
  // 首次出现序号，用于稳定排序
  order: number
}

// dump 里一个条目的骨架。⚠️ 刻意不含 config 的**值**：可能含密钥，且体积大（§4.3 只解析到条目级）
export interface DshDumpEntry {
  id: string
  name: string
  // disabled 为 `!!js '...'` 这类运行期表达式时同样算 true（原样保留不求值，§4.3）
  disabled: boolean
  hasConfig: boolean
  // config 下的顶层字段名（最多 12 个），只留名字不留值
  configKeys: string[]
  // 归属包名（dump 分节头的第一个字段，如 `@deepseek-ai/dsh-base` / `dsh-mnemon`）。
  // dsh 一键隔离拿它分档（官方框架 vs 第三方插件）—— id 本身看不出归属
  bundle?: string
}

// 生效树 vs 默认树 diff（D2）。三个数组都截断到 200 条，总数在 *Total 里。
// added / removed 只给 id + name（没有对照物，比不出细节）；changed 带 before/after 两边骨架
export interface DshDumpDiff {
  changed: { id: string; name: string; before: DshDumpEntry; after: DshDumpEntry }[]
  added: { id: string; name: string }[]
  removed: { id: string; name: string }[]
  changedTotal: number
  addedTotal: number
  removedTotal: number
}

// dsh 配置转储结果（阶段二 D1 + D2）。
// ok:false 时只有 error，layers/entries/diff 均缺省
export interface DshDumpResult {
  ok: boolean
  at: number
  // 命中 60s TTL 缓存时为 true
  cached: boolean
  profile: string
  error?: string
  // dsh 根本没装到可用（全局与插件目录都没有）：界面要给「先装一次」的空态，
  // 而不是笼统的「读取失败」—— 两者要做的事完全不同
  notInstalled?: boolean
  // dump 里的分节数（0 表示输出没能解析出任何分节，通常是 dsh 报错而非配置为空）
  sections?: number
  layers?: DshDumpLayer[]
  entries?: DshDumpEntry[]
  // 一个分节都没解析出来（输出格式变了 / dsh 报错）。界面要提示「解析不了」而不是「配置为空」
  unparsed?: boolean
  // 默认树读取失败时为 null，原因在 diffError（分层可视化仍可用，属降级不属失败）
  diff?: DshDumpDiff | null
  diffError?: string
}

// 用户层 patch（$DSH_HOME/profiles/<p>/cordis.patch.yml）里的一个条目。
// ⚠️ 清单只来自**这一个文件**，不是 dump 出来的组装树 —— 后者里绝大多数条目这份文件改不动
export interface DshPatchItem {
  id: string
  disabled: boolean
  // 条目在文件里的行号（1 基），方便用户对照着打开文件看
  line: number
  // 条目下除 disabled 外还有内容（config 等）
  hasConfig: boolean
}

export interface DshPatchListResult {
  ok: boolean
  error?: string
  // patch 文件绝对路径与 profile：界面必须把「改的是哪个文件」说清楚
  file?: string
  profile?: string
  // 文件当前是否存在。false 是正常空态（这份 profile 还没写过 patch），不是错误
  exists?: boolean
  items?: DshPatchItem[]
}

// 切换一个条目的结果。
// ⚠️ needsRestart：V4 实测 patchReload 是**单向**的 —— 加 disabled 即时生效，
// **取消禁用不恢复**。所以「启用」后界面必须提示重启，不能谎称已生效
export interface DshPatchToggleResult {
  ok: boolean
  error?: string
  changed?: boolean
  // 'append' 新增条目 | 'update' 改已有条目的 disabled 行 | 'insert' 给已有条目补 disabled 行 | 'noop'
  action?: string
  id?: string
  disabled?: boolean
  // 本次改动前是否成功建了快照（建失败会中止写入，故写成功时必为 true）
  backedUp?: boolean
  snapshot?: string
  needsRestart?: boolean
}

// dsh 配置快照（E1 的 whale-dsh-backup/<时间戳>/）
export interface DshBackupSnapshot {
  dirName: string
  // ISO 时间串
  at: string
  profile: string
  // 'manual' / 'before-disable' / 'before-enable' …
  reason: string
  total: number
  // 建快照时真的存在、被备走的文件数（< total 说明有文件当时就不存在，属正常）
  present: number
  // 用户给的名字（E4）。空串 = 没名字
  name: string
  // 用户指认的「已知良好」回滚目标（E4）。列表里这类排最前，且**不会被自动轮转删掉**
  knownGood: boolean
  // 快照文件在磁盘上是否完好（sha256 校验通过）。false = 快照目录被删过/改过，还原必然失败
  intact: boolean
  // intact 的反面，给界面直接判 `v-if` 用（避免模板里写 !s.intact 时看反）
  damaged: boolean
}

export interface DshBackupListResult {
  ok: boolean
  error?: string
  // 快照根目录（$DSH_HOME/whale-dsh-backup）
  root?: string
  // **当前生效**的保留份数（读用户配置，E4 起可调），不是常量上限
  max?: number
  // 保留份数的可调范围（设置页输入框用）
  keepMin?: number
  keepMax?: number
  snapshots: DshBackupSnapshot[]
}

export interface DshBackupRestoreResult {
  ok: boolean
  error?: string
  dirName?: string
  // 被覆盖回去的文件（相对 $DSH_HOME）
  written?: string[]
  // 建快照时就不存在、故未还原的文件
  skipped?: string[]
  // 写文件中断时已**逆序回滚**掉的文件（失败态下有值；written 此时为 []，
  // 因为目录已回到「动手之前」，不存在「部分成功」这个状态）
  rolledBack?: string[]
}

export interface DshBackupCreateResult {
  ok: boolean
  error?: string
  dirName?: string
  at?: string
  profile?: string
  // 建快照时不存在、只记了 missing 的文件数
  missing?: number
  // 建快照时一并打上的名字 / 标记（E4）
  name?: string
  knownGood?: boolean
}

// E4：命名 / 打 known-good 标记（只改 meta.json，不碰快照内容）
export interface DshBackupMetaResult {
  ok: boolean
  error?: string
  dirName?: string
  name?: string
  knownGood?: boolean
}

// E4：按当前保留份数清理一次
export interface DshBackupPruneResult {
  ok: boolean
  error?: string
  keep?: number
  // 被删掉的快照目录名
  removed?: string[]
}

// ── dsh 全量导出（lib/dsh-export.js）──
// 没进包的一项及原因（凭据未勾选 / 读取失败 / 超限 / node_modules）
export interface DshExportSkipped {
  // 相对 $DSH_HOME 的路径
  rel: string
  why: string
}

export interface DshExportPreviewResult {
  ok: boolean
  error?: string
  // $DSH_HOME 实际解析到的绝对路径
  dshHome?: string
  // 会进包的条目数与原始总字节数
  entries?: number
  bytes?: number
  // 文件数超过 20 万上限（此时导出会被拒绝，界面要提前提示用户清理）
  truncated?: boolean
  // 没进包的条目数
  excluded?: number
  // 未勾选「包含凭据」时被排除的凭据文件（界面用它做警示文案）
  credFiles?: string[]
  skipped?: DshExportSkipped[]
  maxFileBytes?: number
  maxEntries?: number
  // 恒排除的目录名（.git / whale-dsh-backup 等）
  excludeDirs?: string[]
  // 3080 上有没有 dsh 在跑（异步探测回填）。**null = 探测失败/拿不到**，
  // 与「确实没在跑」是两回事：界面据此分别显示「可以放心导」与「无法确认」
  running?: DshExportRunning | null
}

// dsh 运行状态（导出前提示用）。判据全部来自 dsh.js 的 snapshot，本处只做搬运
export interface DshExportRunning {
  // 有 dsh 在跑（本插件启的 / 别的终端的，都算）
  running: boolean
  // 在跑的 dsh 的 pid，判不出来时为 0
  pid?: number
  name?: string
  // 3080 被**非 dsh** 程序占用时的进程名（性质与「dsh 在跑」不同，措辞要分开）
  other?: string
  // 是否本插件自己启的那份
  self?: boolean
}

export interface DshExportCreateResult {
  ok: boolean
  error?: string
  // 用户在保存对话框点了取消（此时不算失败，不给用户看报错）
  canceled?: boolean
  // 产出包的绝对路径
  outPath?: string
  at?: string
  // 包内条目数（含包内清单 whale-dsh-export.json）
  entries?: number
  // 包文件本身的字节数
  bytes?: number
  // 原始文件的总字节数（store 模式不压缩，所以与 bytes 接近）
  sourceBytes?: number
  // includeCred 是否带上了凭据文件
  includeCred?: boolean
  // 没进包的条目及原因 —— 界面必须展示，否则用户拿到一个「少了东西但看着正常」的包
  skipped?: DshExportSkipped[]
  skippedTotal?: number
  // 遍历与读取之间消失的文件数（dsh 在跑时会话文件会变，属正常竞态）
  missing?: number
}

// ── E3「我的一键隔离」 ──
// 候选项 = 用户层 patch 里的条目 ∪ dump 出来的组装树条目。
// source 决定免责文案：'patch' 是改自己那一行（最稳），'plugin' 是**新增**一条 patch
// —— V1 实测带 client 入口的插件（如 dsh-better-sidebar）这样禁用**无效**，界面须提示
export interface DshIsolateCandidate {
  id: string
  // 'patch' | 'plugin'
  source: string
  // 已在用户层 patch 里（source === 'patch'）
  inPatch: boolean
  // 当前状态，**三态**：true 已禁用 / false 启用中 / undefined 状态未知。
  // ⚠️ undefined 不是「启用」—— 它表示宿主没拿到该条目的 dump 状态（调用方漏传 disabledOf）。
  // 界面必须把 undefined 显示成「状态未知」，当成 false 会把已禁用的插件谎报成启用中
  disabled?: boolean
  // 条目在 patch 文件里的行号（1 基）；不在 patch 里时为 0
  line: number
  // 条目下除 disabled 外还有 config 等子块
  hasConfig: boolean
  // 'patched' | 'third' | 'core' —— 分组用的档位（见 dsh-isolate.tierOfBundle）。
  // 'patched' = 已在用户 patch 里 / 'third' = 第三方插件 / 'core' = dsh 官方框架节点。
  // ⚠️ 只用于界面分组与默认折叠，**不是**权限或安全边界
  tier: string
  // 归属包名（来自 dump 分节头）。core/third 的实际判据，界面可显示出来
  bundle?: string
}

export interface DshIsolateCandidatesResult {
  ok: boolean
  error?: string
  // patch 文件绝对路径与 profile：界面必须说清「改的是哪个文件」
  file?: string
  profile?: string
  // patch 文件当前是否存在。false 是正常空态（还没写过 patch），不是错误
  exists?: boolean
  // 组装树读不到时的降级原因。**非空不代表整体失败** ——
  // 此时 items 只含 patch 里的条目，隔离照样能做（与 D26 同一取舍）
  treeError?: string
  // 候选**不再截断**（早先截到 MAX_BATCH=100，导致第 101 条起勾都勾不到）。
  // MAX_BATCH 现在只约束「一次写入多少条」，见 dshIsolateApply
  items?: DshIsolateCandidate[]
}

// 一条将改动的行。⚠️ line 是**改动前**的行号（1 基），append 的为 0
export interface DshIsolatePlan {
  id: string
  // 'update' 改已有 disabled 行 | 'insert' 给已有条目补 disabled 行 | 'append' 新增条目 | 'noop' 已是禁用
  action: string
  line: number
  // 改动前该条目的 disabled 状态
  was: boolean
}

export interface DshIsolateApplyResult {
  ok: boolean
  error?: string
  dryRun?: boolean
  changed?: boolean
  file?: string
  profile?: string
  plans?: DshIsolatePlan[]
  // plans 里 action !== 'noop' 的条数：界面据此说「改了 N 条」而不是「N 条已隔离」
  changedCount?: number
  // 写前是否成功建了快照（建失败会中止写入，故写成功时必为 true）
  backedUp?: boolean
  snapshot?: string
  // 写入后回读校验未通过的 id（V2 的静默失效靠这一步暴露）
  mismatch?: string[]
  // V4：加 disabled 是单向热重载中会生效的那一半，故为 false
  needsRestart?: boolean
}

// ── dsh 插件市场（lib/dsh-market.js）──
// 目录来源实测 https://awesome-dsh-plugin.com/plugins.json（2026-09-23：4183 条）
export interface DshMarketPlugin {
  name: string
  owner: string
  url: string
  page: string
  category: string
  descZh: string
  descEn: string
  // ⚠️ 目录里这一项**可以是空串**（原始 JSON 里为 null，实测 4183 条里 2033 条即 48.6%）。
  // 这些条目**并非装不了** —— 只是 install spec 换了形态，见下面的 spec。
  // 仅用于展示与「去 scope 短名」的兜底比对，**不再作为安装能力的判据**
  npm: string
  version: string
  stars: number
  downloads: number
  install: string
  added: string
  screenshots: string[]
  // === 安装能力三件套（取代旧的 installable）===
  // 真正交给安装命令的 spec：裸包名 / `github:owner/repo` / `https://…/x.tgz`
  spec: string
  // 'npm' | 'github' | 'tarball' | ''（''=我们认不出的形态，界面不给按钮）
  specKind: string
  // github / tarball 靠 prepare 脚本在安装时构建，pnpm 默认拦一次；界面据此标「需构建」
  needsBuild: boolean
}

export interface DshMarketCatalogResult {
  ok: boolean
  error?: string
  // 'official' | 'mirror' | 'custom' | 'cache'
  from?: string
  // 命中内存缓存（60s TTL）或 304：内容与上次一致
  cached?: boolean
  // 命中了 dbStorage 里的离线副本（所有来源都挂）—— 此时 ok 仍为 true，
  // 但必须把 stale/staleReason 显示出来，不能让用户以为是刚抓的
  stale?: boolean
  staleReason?: string
  // 离线副本的落库时间（epoch ms）
  at?: number
  // 目录自称的更新日期（YYYY-MM-DD）
  updated?: string
  // 分类键 → 双语名（目录里给的 24 类，保留原顺序）
  categories?: Record<string, { en: string; zh: string }>
  plugins?: DshMarketPlugin[]
  count?: number
  // 这次竞速从发起到胜出者拿到完整目录花掉的毫秒数（界面显示「耗时 x.xxs」）
  tookMs?: number
  // 胜出来源的 registry 地址；只有 from==='mirror' 时非空，界面据此反查 label
  registry?: string
  // 逐条链路的失败原因（ok:false 时给出，便于用户判断是网络还是来源挂了）
  failures?: string[]
}

// 一次目录来源测速的结果。只打 registry 的元数据（不下载 tarball），故比抓目录快得多
export interface DshMarketPingEntry {
  id: string
  url: string
  label: string
  // 元数据往返耗时（ms）；ok 为 false 时无意义
  ms: number
  ok: boolean
  error?: string
  // 该源当前发布的目录包版本号（能顺手证明它是不是活的）
  version?: string
}

// 一个包在 profile 里的状态。两个来源说的是两件事，界面要分开显示
export interface DshMarketInstalledEntry {
  // npm 层面装没装（profile/package.json 的 dependencies）
  inDeps: boolean
  depVersion: string
  // dsh 层面有没有 patch 条目 / 是否被禁用
  inPatch: boolean
  disabled: boolean
}

export interface DshMarketStatusResult {
  ok: boolean
  error?: string
  profile: string
  // profile/package.json 与 patch 文件的绝对路径（界面说清「装到哪儿、改的是哪个文件」）
  file: string
  patchFile: string
  // 键是用户实际写的那个名字（可能是去掉 scope 的短名），界面用包名去对
  installed: Record<string, DshMarketInstalledEntry>
  count: number
}

export interface DshMarketInstallResult {
  ok: boolean
  error?: string
  dryRun?: boolean
  changed?: boolean
  // 实际交给安装命令的 spec（github / tarball 条目只有它，没有 npm 名）
  spec?: string
  npm?: string
  name?: string
  version?: string
  profile?: string
  // 'install' | 'update' | 'already'
  action?: string
  message?: string
  snapshot?: string
  // 更新时的「更新前声明版本 → 更新后实装版本」中的前一端。
  // ⚠️ 2026-09-25 起**精确安装（exact）也回这个字段** —— 它同样是「按版本重装」，
  //    结果卡要画 `1.62.0 → 1.65.1`，且这个值取自实装版本回读，比目录版本可信
  from?: string
  // 目录条目给的版本（dryRun 按 `to` 回传，前端存进 plan、真写时再带回）。
  // ⚠️ 被供应链策略挡下时靠它拼出可照抄的白名单行；缺了就只能写「目标版本」
  to?: string
  // github / tarball 靠 prepare 脚本构建；pnpm 会拦一次，界面据此提示「若加载失败按引导再来」
  needsBuild?: boolean
  // 失败时的 pnpm 构建拦截引导（只有 needsBuild 且输出里含 allowBuilds 才有）。
  // key 带 commit hash —— 安装前拿不到，所以这类条目注定先失败一次
  allowBuilds?: { key: string; file: string } | null
  // 装完必须 dsh 重新加载才生效 —— 界面提示 + 手动「重启 dsh」按钮，宿主不自动重启
  needsRestart?: boolean
  // 更新时「pnpm 报成功但实装版本没变」（多为 profile 的供应链策略拦截）。
  // 这时 ok:false —— 不能让界面显示「已更新 v1.48.0 → v1.48.0」这种假成功
  blocked?: boolean
  // 更新时「pnpm 报成功、版本确实变了但变得**更低**」（镜像滞后 / registry 把 @latest
  // 解析成旧版本），与 blocked 是相反方向的两个静默失败。同样 ok:false，且建议回滚
  downgraded?: boolean
  // 被挡时给出该改哪个文件的哪个键（pnpm-workspace.yaml 的 minimumReleaseAgeExclude）
  policyFile?: string
  policyKey?: string
  // 「版本没动」到底是为什么挡的：'release-age' = 目标版本太新、还没满最小发布年龄；
  // 'allowlist' = 白名单没放行这一条；'unknown' = 输出里找不到可识别的线索。
  // 只有 release-age 才该劝用户「等它满期」—— 劝错了会让用户去改一个根本不起作用的配置
  staleReason?: 'release-age' | 'allowlist' | 'unknown'
  // 同一件事能不能靠「原样重试」解决。age 类要等时间；白名单类要改配置；构建类要先放行脚本。
  // 界面据此决定是给「重试」按钮还是给「去改配置」引导，避免让用户白点
  retryable?: boolean
  // 「pnpm 报告成功，但实装版本**低于**目标」（RESOLVED_VERSION_MISMATCH 语义）。
  // ⚠️ 高于目标**不算** mismatch —— 镜像抢先发版是好结果，别报成失败
  mismatch?: boolean
  // mismatch 时的目标版本（拼文案用），与 to 同源
  expected?: string
  // 原生命令输出的**尾部**若干行（pnpm 的关键报错在尾部，头部多是进度条噪音）
  tail?: string
  // 该插件声明的 DSH 版本范围容不下**当前宿主**（确证不兼容，dryRun 阶段就拦下，ok:false）。
  // ⚠️ 只拦确证的 incompatible —— unknown（没声明 / manifest 拉不到）照常放行，
  //    否则目录里近半没有 DSH 声明的条目会被整体拦死
  // ⚠️ 带 force 时**照样回 true**（结论没变，只是不再作为拦路依据）——
  //    界面靠它把单据卡切成「你正在强行装…」的措辞
  hostIncompatible?: boolean
  // 这次判定是在 force 放行下做的（用户在界面上看过后果、明确选择强装）。
  // 用来把「宿主拦下了」与「宿主拦了但被用户放行」这两种完全不同的态分开
  hostForced?: boolean
  // 兼容性判定的完整结论（dryRun 回传，供列表/详情显示「要求 DSH x ∩ y，当前 z」）
  hostCompat?: DshHostCompatVerdict
}

// 一个插件与当前宿主 DSH 的兼容性结论（三态，见 preload/lib/dsh-host-compat.js）
export interface DshHostCompatVerdict {
  // 'compatible' = 全部声明都容得下当前宿主；'incompatible' = 有任一条确证容不下；
  // 'unknown' = 判不了（没声明 / manifest 拉不到 / 一条都解析不出）
  status: 'compatible' | 'incompatible' | 'unknown' | string
  // 'peer' = 按 peer/engines 声明判出来的；'no-host-version' = 读不到宿主版本；
  // 'undeclared' = 插件没声明 DSH 要求；'unavailable' = manifest 拿不到
  reason: string
  // 声明原文（多条用 ∩ 连，表明是合取）
  requirement: string
  // 判定时用的宿主版本
  host?: string
  // 从目录条目的 spec 剥出的裸 npm 包名（判不了时为空串）
  package?: string
}

export interface DshHostCompatCheckResult {
  ok: boolean
  // 当前宿主 DSH 版本；空串表示读不到（此时整体短路、未发任何请求）
  host: string
  // 键是目录条目的 name（与界面列表的 key 一致），值是判定结论
  results: Record<string, DshHostCompatVerdict>
}

export interface DshMarketUninstallResult {
  ok: boolean
  error?: string
  dryRun?: boolean
  changed?: boolean
  npm?: string
  name?: string
  // true = 已连带删除磁盘包（npm uninstall）；false = 只写 disabled: true 禁用
  remove?: boolean
  // 实际写进 patch 的条目 id（可能是短名）
  id?: string
  profile?: string
  action?: string
  message?: string
  snapshot?: string
  needsRestart?: boolean
}

// 一条「已装 vs 目录」的版本比对结果。
// ⚠️ installed 是 node_modules 里读到的**实装版本**（裸 `0.5.11`），不是 package.json 里的
//    声明范围；后者放在 range 字段。口径：实装版本 < 目录版本 → 有更新。
export interface DshMarketUpdateEntry {
  spec: string
  npm: string
  name: string
  // 实装版本（node_modules/<name>/package.json 的 version）。读不到时为空字符串 ——
  // 此时若 range 有值，state 是按声明范围退回来的判定结果
  installed: string
  // profile/package.json 里写的声明范围（`^0.5.11` / `0.19.1`），仅作展示与退回判定用
  range: string
  latest: string
  // 'update' = 实装版本低于目录版本（退回判定时：目录版本超出声明范围）；
  // 'current' = 实装版本已不低（退回时：目录版本落在声明范围内）；
  // 'unknown' = 目录没给 version（github/tgz 来源）或已装侧两边都拿不到，比不了
  state: 'update' | 'current' | 'unknown'
  // 判定依据：'realized' = 比实装版本；'range' = 退回比声明范围；'none' = 无法比对
  basis: 'realized' | 'range' | 'none'
}

export interface DshMarketCheckUpdatesResult {
  ok: boolean
  error?: string
  profile: string
  // 只含**已装**的条目（未装的不参与「有没有新版」）
  entries: DshMarketUpdateEntry[]
  updates: number
  unknown: number
  checked: number
}

// 回源 registry 查到的「官方最新版」结论（**会联网**，纯手动触发）。
// ⚠️ 与 DshMarketUpdateEntry.latest 的区别：那个是**目录快照**里的 version（可能已落后），
//    这个是 registry 上当前的真实 latest。两者不一致 = 目录快照滞后。
export interface DshMarketRegistryLatestEntry {
  // 查询用的裸 npm 包名
  pkg: string
  // registry 上的 latest 版本；拉失败时为空串（看 error）
  version: string
  // 拉失败的原因（网络 / 404）；成功时为空串
  error: string
  // true = 命中宿主内存缓存（5 分钟 TTL），本次没出站
  cached: boolean
}

export interface DshMarketRegistryLatestResult {
  ok: boolean
  // 本次查询实际使用的 registry 地址
  registry: string
  // 键是调用方传的 key（界面用目录条目的 spec）
  results: Record<string, DshMarketRegistryLatestEntry>
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

// dsh 长跑操作的轻量进度快照（安装 / 更新插件期间前端 1Hz 轮询）
// ⚠️ 与 DshStatus 分开是有意的：这里**不探端口**，只读宿主内存里的两块数据。
//    进度回显不需要端口信息，却会因 DshStatus 的探测每秒白起一个 netstat 子进程
export interface DshProgress {
  // 正在执行的命令行（宿主 setCmd 写入），未执行过为空串
  lastCmd: string
  // 宿主滚动日志的全文（含 npm 的 stdout / stderr，已清 ANSI）
  log: string
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
// dsh profile 写锁（<profile>/package.json.lock）的孤儿检测结果。
// 背景：dsh 的锁进程被强杀后会永久残留（上游不做回收），之后该 profile 的
// 装/卸/更新/market 全部死锁 —— 表现为「操作失败」而真实原因是拿不到写锁。
export interface DshLockStale {
  ok: boolean
  // 三重判据（文件存在 + 内容是纯数字 pid + 该 pid 确证不存在）全部满足才为 true
  stale: boolean
  // 判非孤儿的成因：absent（没有锁，正常态）/ bad-content（内容读不懂，保守不清理）
  // / alive（锁被真进程持有）/ unknown（查不出存活，保守不清理）；另有错误态
  // bad-profile / no-profile-dir / read-error
  reason?: string
  lockPath?: string
  profile?: string
  // 锁文件里记录的 pid（absent/bad-content 时为 0）
  pid?: number
  // 锁已存在多久（ms），仅 orphan 时有意义
  age?: number
  error?: string
}
// 清理孤儿锁的结果。cleared=true 才代表真的删了；
// already=true 表示本来就没有锁（用户目标已达成，不是失败）
export interface DshLockClearResult {
  ok: boolean
  cleared: boolean
  already?: boolean
  lockPath?: string
  profile?: string
  pid?: number
  age?: number
  reason?: string
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
  // dsh 只读诊断：跑 5 项本地检查（重复模块 / patch 条目 / patch 语法 / settings.yaml / 3080 端口）。
  // 纯只读，不写入任何配置。60s TTL 缓存，force:true 绕过。
  // ⚠️ 必须返回 Promise：C5 端口探测走异步回调，如果这里同步等结果，
  // 宿主就把整个渲染进程冻住（设置页会卡死）—— 别把它改成同步返回
  diagnoseDsh(opts?: { force?: boolean }): Promise<DshDiagnoseResult>
  clearDshDiagnoseCache(): void
  // dsh 配置转储（阶段二）：跑 `node bin.js --profile <n> --dump-config` 与
  // `--dump-default-config`，解析成「五层 patch 分层」+「生效树 vs 默认树 diff」。
  // 纯只读：不改任何配置、不写 dsh 的任何文件。
  // ⚠️ 与 diagnoseDsh 同理必须返回 Promise：内部要 spawn 子进程（每次 8s 上限、两次串行），
  // 同步等结果会冻住整个渲染进程。宿主侧另有 20s 兜底闸门保证一定 settle。
  dumpDshConfig(opts?: { force?: boolean; profile?: string }): Promise<DshDumpResult>
  clearDshDumpCache(): void
  // ── dsh 插件开关（E2）：只读写用户层 profile patch（$DSH_HOME/profiles/<p>/cordis.patch.yml）──
  // 列出该文件里的条目（**不是** dump 出来的组装树：那份清单里绝大多数条目这个文件改不动）
  dshPatchList(opts?: { profile?: string }): DshPatchListResult
  // 切换单个条目的 disabled。**写前自动建快照**，建失败则中止写入（宁可不让改，也不能让改动不可撤销）。
  // 返回的 needsRestart=true 表示「启用」场景：patchReload 单向，取消禁用必须重启 dsh 才看得到
  dshPatchToggle(opts: { profile?: string; id: string; disabled: boolean }): DshPatchToggleResult
  // 快照（E1 的 whale-dsh-backup）：列表 / 立即备份 / 还原 / 删除
  dshBackupList(): DshBackupListResult
  // 立即备份。给了 name 就是「手动命名的备份」→ 不受轮转清理（E4）
  dshBackupCreate(opts?: { profile?: string; name?: string }): DshBackupCreateResult
  dshBackupRestore(opts: { dirName: string; dryRun?: boolean }): DshBackupRestoreResult
  dshBackupRemove(dirName: string): { ok: boolean; error?: string }
  // ── E4：known-good 标记 / 命名 / 可配保留份数 ──
  // 命名与打标记只改快照目录里的 meta.json，**不碰快照内容**（标记错了重标即可）。
  // name 传空串清名字、knownGood 传 false 取消标记；只传一项时另一项保持不变
  dshBackupSetMeta(opts: { dirName: string; name?: string; knownGood?: boolean }): DshBackupMetaResult
  // 按保留份数清理一次（known-good 与手动命名的快照不参与轮转）。
  // ⚠️ opts.keep 是**本次清理的临时份数**，只影响这一次、不写配置 —— 界面上「改了数字但没点保存
  // 就点立即清理」时用它，否则会拿已保存的旧值去清、什么都不删（看着像按钮坏了）。省略则用配置值
  dshBackupPrune(opts?: { keep?: number }): DshBackupPruneResult
  // 改保留份数（1–200）。**只写配置、不立即删**，删除由 dshBackupPrune 或下次建快照触发
  dshBackupSetKeep(n: number): { ok: boolean; error?: string; keep?: number }
  // ── dsh 全量导出（与上面的 dshBackup* 是两回事，别混）──
  // dshBackup* 是**快照**：白名单 3 个文件、落在 $DSH_HOME/whale-dsh-backup/、为了回滚 patch；
  // dshExport* 是**导出**：整个 $DSH_HOME 打成 zip、落用户选的路径、为了打包带走/存档。
  // 挂件不解析包内容、不负责还原 —— 还原就是用户自己解压覆盖。
  //
  // 预检：不写盘，只回报「会备多少 / 会排除什么」，让用户先看到凭据被排除再决定。
  // ⚠️ 返回 Promise：宿主内部异步探一次 3080，看 dsh 在不在跑（结果在 running 字段）
  dshExportPreview(opts?: { includeCred?: boolean; skipModules?: boolean }): Promise<DshExportPreviewResult>
  // 导出全量包。outPath 为空时宿主弹保存对话框（返回 canceled=true 表示用户取消）。
  // includeCred 由界面勾选决定，宿主不做「默认包含」这种隐式行为
  dshExportCreate(opts?: { outPath?: string; includeCred?: boolean; skipModules?: boolean }): DshExportCreateResult
  // 在文件管理器里定位导出包
  dshExportReveal(outPath: string): { ok: boolean; error?: string }
  // ── E3「我的一键隔离」：一次把勾选的条目全禁掉 ──
  // 候选清单必须 spawn `dsh --dump-config`，故返回 Promise（宿主侧有 20s 兜底闸门）。
  // 组装树读不到时**降级**：treeError 说明原因、items 只含 patch 里的条目，不算整体失败
  dshIsolateCandidates(opts?: { profile?: string }): Promise<DshIsolateCandidatesResult>
  // 执行隔离。**只动 ids 里的条目**，其余一个字节不碰（计划书 §5.2 的红线）。
  // dryRun=true 只算不写，返回 plans 让界面把「会动哪几行」先摆给用户过目；
  // 真正写入时写前自动建快照（reason='before-isolate'），建失败即中止
  dshIsolateApply(opts: { profile?: string; ids: string[]; dryRun?: boolean }): DshIsolateApplyResult
  // ── dsh 插件市场：本 Tab 里**唯一会联网**的卡 ──
  // 抓目录。锁定的来源**同时发请求、先到先用**，胜出者一到就 abort 其余连接（实测官方源
  // body 要下 50–130s，串行回退等于白等）。全部来源都挂时**不返回 ok:false**，而是降级给
  // 上次的目录并置 stale=true + staleReason —— 界面必须把这两项显示出来。
  // registry 传空串表示用内置默认（实测最快的 npmmirror）；official 默认 false（官方源实测常连不上）
  dshMarketCatalog(opts?: { force?: boolean; url?: string; mirror?: boolean; registry?: string; official?: boolean }): Promise<DshMarketCatalogResult>
  // 给「目录来源」选择区列出可选 registry（id/url/label），界面单选时用
  dshMarketRegistries(): { id: string; url: string; label: string }[]
  // 目录来源测速：并发打各 registry 的元数据，按延迟升序返回（不通的排最后并带 error）。
  // **只测速不改配置** —— 改哪个源由用户点「用最快的」决定
  dshMarketPing(opts?: { registries?: { id: string; url: string; label: string }[] }): Promise<{ ok: boolean; list: DshMarketPingEntry[] }>
  // 已装状态（profile/package.json 的依赖 + 用户层 patch 条目）
  dshMarketStatus(opts?: { profile?: string }): DshMarketStatusResult
  // 安装：dryRun=true 只回「准备执行什么」不跑 npm。真装时写前建快照，npm 后回读 package.json 核验。
  // ⚠️ 装的是 spec（目录 install 字段剥出来的原话），不是 npm 字段 —— 近半数条目 npm 为 null
  // ⚠️ version 是**目录条目的版本号**（DshMarketPlugin.version），必须传：
  //    宿主只靠 profile/package.json 的声明范围判「装没装」，而 `^1.48.0` 是容得下 `1.49.0` 的，
  //    不传版本会让「已装但落后」的包被判成「无需重复安装」。传了才比实装版本、才判得出该更新
  // ⚠️ exact=true + targetVersion：按「裸 npm 包名@确切版本」精确安装（只在 npm 来源可用）。
  //    为什么需要：profile 的 pnpm-lock.yaml 会锁住旧版，`pnpm add <spec>` 会命中 lock、原样复用旧版；
  //    只有把确切版本拼进 spec 才能装到用户查到的 registry 版本
  // ⚠️ force = 用户在界面上看过「宿主不兼容」的后果、明确选择强装（2026-09-25 加）。
  //    dryRun 与真写**都要带**：宿主那两道闸判的是同一件事，只给 dryRun 带的话，
  //    用户点头之后仍会被拦在写入前。带上后宿主照样判定，只是不再以它作为拦路依据
  dshMarketInstall(opts: { profile?: string; spec: string; npm?: string; name?: string; version?: string; needsBuild?: boolean; dryRun?: boolean; exact?: boolean; targetVersion?: string; force?: boolean }): Promise<DshMarketInstallResult>
  // 卸载：remove 缺省 = 只写 disabled: true 禁用（包留磁盘）；remove=true = npm uninstall 删包。
  // spec 可替代 npm 传入，宿主会自己反查 package.json 里真实的键名
  dshMarketUninstall(opts: { profile?: string; npm?: string; spec?: string; name?: string; remove?: boolean; dryRun?: boolean }): Promise<DshMarketUninstallResult>
  // 检查已装插件有没有新版。⚠️ **要目录数据**（catalog 由界面把已拿到的目录原样传回来，
  // 宿主不自己联网）—— 所以只在目录已加载后才调，否则就等于绕过「默认零网络请求」
  dshMarketCheckUpdates(opts?: { profile?: string; catalog?: DshMarketCatalogResult }): DshMarketCheckUpdatesResult
  // ⚠️ 回源 registry 查**官方最新版**（**会联网** —— 所以纯手动，界面每行一个按钮）。
  // 目录是每日快照，里面那份 version 可能已落后于 registry（实测目录停在 9/24 而包已发到 1.65.1），
  // 「目录说已最新」本身可能过时。只在能剥出裸 npm 包名的条目上调（github / tarball 查了必然 404）。
  dshMarketRegistryLatest(opts?: { items?: { pkg?: string; key?: string }[]; registry?: string }): Promise<DshMarketRegistryLatestResult>
  // 更新一个已装插件：按目录 spec **重装**（不是 npm update —— 后者只在声明范围内升，
  // 而「有更新」的定义正是超出范围）。dryRun 只算不写；真写与安装同链路：快照 → npm → 回读核验
  //
  // ⚠️ version = **目录条目给的版本**，dryRun 时传下去、真写时再带回来。没有它，更新被 profile 的
  // 供应链策略（minimumReleaseAgeExclude）挡下时，宿主只能说「目标版本」，用户不知道该往白名单写哪个号
  dshMarketUpdate(opts: { profile?: string; spec: string; npm?: string; name?: string; version?: string; dryRun?: boolean; force?: boolean }): Promise<DshMarketInstallResult>
  // 查一批插件与**当前宿主 DSH** 的兼容性（见 preload/lib/dsh-host-compat.js）。
  // entries 走目录条目（宿主自己从 spec 剥包名，剥不出的当场返 unknown 且不发请求）；
  // packages 走裸包名数组。两者都空则返空表。
  // ⚠️ 读不到宿主版本时**整体不联网**，全部返 unknown —— 没有宿主版本，任何结论都是编的
  dshHostCompatCheck(opts?: { entries?: { name?: string; spec?: string; npm?: string }[]; packages?: string[]; registry?: string }): Promise<DshHostCompatCheckResult>
  // 当前宿主的 DSH 版本（与诊断卡同源）。空串 = 读不到，界面据此说「无法判定」而不是「兼容」
  dshHostVersion(): string
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
  // 用系统文件管理器打开指定目录（定位插件目录里的 dsh 用）；路径为空时 ok:false
  openDir(dir: string): { ok: boolean; path: string }
  // DeepSeek Harness（dsh）：状态与 启动/重启/结束/更新/打开页面
  dshStatus(): DshStatus
  // 轻量进度（只回命令行与日志尾部，不探端口）。安装/更新这类长跑操作期间前端 1Hz 轮询它
  // 做进度回显 —— 复用 dshStatus() 会每秒起一个 netstat 子进程，代价与收益完全不成比例
  dshProgress(): DshProgress
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
  // dsh profile 写锁的孤儿检测（只读，不清算）。profile 缺省时宿主按当前 profile 处理
  dshLockStale(opts?: { profile?: string }): DshLockStale
  // 清理孤儿写锁（用户确认后调用）。宿主会重新校验，非孤儿一律不删
  dshLockClear(opts?: { profile?: string }): DshLockClearResult
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
