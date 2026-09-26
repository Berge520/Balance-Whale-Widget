<script lang="ts" setup>
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AssetsApplyResult, AssetsExportResult, AssetsPreviewResult, BackupPreviewResult, BubbleMeta, CodexSummaryResult, CodexWindow, CodexWindows, DshBackupListResult, DshBackupSnapshot, DshDiagnoseFinding, DshDiagnoseItem, DshDiagnoseResult, DshDumpResult, DshExportPreviewResult, DshHostCompatCheckResult, DshHostCompatVerdict, DshIsolateCandidate, DshIsolateCandidatesResult, DshIsolatePlan, DshMarketCatalogResult, DshMarketInstallResult, DshMarketInstalledEntry, DshMarketPingEntry, DshMarketPlugin, DshMarketRegistryLatestEntry, DshMarketRegistryLatestResult, DshMarketStatusResult, DshMarketUninstallResult, DshMarketUpdateEntry, DshPatchItem, DshPatchListResult, DshUsageResult, LedgerDetailDay, LedgerDetailEntry, ModelUsageRow, SkinGallery, SkinMeta, SoundMeta, SoundRole, WhaleMailSecrets, WhaleModel, WhaleModelRow, WhaleModelTemplate, WhalePriceModel, WhaleServices, WhaleTokenPrice } from './types/services'
import SkinCropper from './components/SkinCropper.vue'
import SoundTrimmer from './components/SoundTrimmer.vue'
import FirstRunGuide from './components/FirstRunGuide.vue'
import UsageChart from './components/UsageChart.vue'
// GitHub 加速卡（含 hosts 探测 / 源表 / IP 表编辑，逻辑量在本页里数一数二）改按需异步加载：
// 它只在「帮助」Tab 才渲染，抽成独立 chunk 后 App.vue 首屏包明显变小，其余 Tab 的打开更快。
// 渲染时机不变（下面模板仍是 v-if="activeTab === 'help'"），首次切到帮助时才去取这段 JS
const AccelView = defineAsyncComponent(() => import('./views/AccelView.vue'))

// 主窗 preload（services.js）注入的宿主 API
const services: Partial<WhaleServices> = window.services || {}

// 低余额预警阈值的按币种默认值。唯一来源是宿主 constants.LOW_ALERT_BY_CURRENCY，
// 设置页拿不到宿主常量（preload 不参与打包），这里只放一份同值副本。
const LOW_ALERT_DEFAULT: Record<string, number> = { CNY: 10, USD: 2 }

// 自定义单价（令牌模式）的默认值，同样是宿主 constants.TOKEN_PRICE_DEFAULT 的同值副本
const TOKEN_PRICE_DEFAULT = { on: false, cur: 'CNY', rate: 7.2, hit: 0.02, miss: 1, out: 4, models: [] }
// 「按模型覆盖」的条目数上限，同宿主 constants.TOKEN_PRICE_MODELS_MAX
const PRICE_MODEL_MAX = 20

// 账本历史保留天数范围与默认值，同样是宿主 store.js 里 HISTORY_KEEP_* 的同值副本
// （下限 35 是为了「本月汇总」在 31 号能回溯到 1 号）
const HISTORY_KEEP = { DEFAULT: 365, MIN: 35, MAX: 730 }

// 内置形象 id（= public/whale/ 下的图片文件名），数组顺序即「形象」下拉的顺序。
// 也是同值副本：宿主 store.js 的 BUILTIN_SKINS 与挂件页面 floating-page.js 的 BUILTIN_SKINS
// 各有一份（设置页拿不到 preload 常量），加形象要三处一起改。
const BUILTIN_SKINS = [
  'liuy', 'black', 'ciya', 'DSniang1', 'DSniang02', 'DSniang3', 'DSniang4',
  'DSniang5', 'DSniang6', 'DSniang7', 'glby', 'Jian', '无稽之谈改',
]
const DEFAULT_SKIN = 'DSniang1'

// 避让滚动条的默认留白像素，同宿主 store.js 的 SCROLL_GAP_DEFAULT（同值副本，
// 由 scripts/check-shared.mjs 比对）
const SCROLL_GAP_DEFAULT = 17

// 吸附区宽度（可用区宽/高的百分比）范围与默认值，同宿主 store.js 的 SNAP_RATIO_*
// （同值副本，由 scripts/check-shared.mjs 比对）
const SNAP_RATIO_MIN = 1
const SNAP_RATIO_MAX = 45
const SNAP_RATIO_DEFAULT = 25

// —— 密钥（加密存储） ——
const secrets = reactive({ apiKey: '', platformToken: '' })
// 获取教程默认折叠，点「如何获取？」按钮才展开
const guides = reactive({ apiKey: false, token: false })
// 「帮助」组里使用说明 / 故障排查的折叠态（默认收起，点标题才展开）
const widgetFolds = reactive({ help: false, trouble: false })
// 长卡片内部的折叠态：凭据（填一次就不动，默认收起）
const toolOpen = reactive({ credentials: false })
// 「挂件外观」卡内分组折叠：基础项（大小 / 形象）常改，留折叠外；
// 气泡文案与音效属低频，默认收起，避免一屏铺开 11 组控件
const lookFolds = reactive({ bubble: false, sound: false })
// 「资源」页折叠态：内置资源纯查阅用，默认收起
const assetFolds = reactive({ builtin: false })
// —— 设置页顶部 Tab ——
// 原先 12 张卡片竖排一屏到底（模板近千行），找一项要滚很久；按主题分 6 组，一次只看一组。
// 每张卡片用 v-if="activeTab === 'xxx'" 归到组里（不额外套容器层）。组内顺序 = 卡片在模板里的先后；
// 但不同组的卡片是交错排布的（如「数据」的凭据卡在模板最前、「帮助」的关于卡在最后），
// 所以看模板不要以为同一组的卡挨在一起 —— 渲染顺序由下面 TABS 的 key 决定，与源码位置无关。
// desc 是分组说明：凭据、备份这类「不常用但找不到会着急」的项靠它暴露位置；
// 它得与卡片实际**顺序和数量**对得上（按错顺序写、漏掉某张卡，用户按描述找就会找不到）。
const TABS = [
  { key: 'look', label: '外观', desc: '大小 · 形象与音色 · 文案' },
  { key: 'assets', label: '资源', desc: '素材总览 · 形象画廊 · 气泡图 · 音效 · 素材包' },
  { key: 'usage', label: '用量', desc: '趋势与账本 · 提醒与通知 · 模型余额' },
  { key: 'window', label: '窗口', desc: '显隐 · 位置 · 透明度 · 穿透' },
  { key: 'data', label: '数据', desc: '凭据设置 · 清除数据 · 备份与恢复' },
  { key: 'help', label: '帮助', desc: '使用说明 · 故障排查 · 关于与更新' },
  // desc 是 Tab 栏下方的静态说明，得与卡片的实际顺序、数量对得上：
  // 原先只列「dsh / dsh 用量 / Codex」三项，而这一页实际有 8 张卡，用户按描述找
  // 「插件开关」「插件市场」会以为不在这里。按实际顺序列全，并把非 dsh 的 Codex 单独隔开
  { key: 'dev', label: '开发者', desc: 'DeepSeek Harness（dsh）：主控 · 环境诊断 · 配置转储 · 全量导出 · 用量统计 · 插件开关 · 插件市场　｜　Codex 会话统计' },
] as const
type TabKey = (typeof TABS)[number]['key']
const activeTab = ref<TabKey>('look')
const activeTabDesc = computed(() => TABS.find((t) => t.key === activeTab.value)?.desc || '')
// 统一的消息态：msg=文案、err=是否错误态；模板用 msgCls(f) 生成 class（合并原先 11 组 msg/err ref）
type Flash = { msg: string; err: boolean }
function useFlash(): Flash { return reactive({ msg: '', err: false }) }
function msgCls(f: Flash) { return { ok: !f.err, err: f.err } }
const secretsFlash: Flash = useFlash()
// 首次运行引导弹层的独立回执（不能与 secretsFlash 共用：两个入口同时开着时消息会串）
const guideFlash: Flash = useFlash()
const guideSaving = ref(false)
const showGuide = ref(false)
// 弹层是「首次自动弹出」还是「用户手动重开」：决定标题口径（欢迎使用 / 配置凭据），
// 也决定关闭时要不要写 guideDone —— 手动重开时它本来就是 true，不必再写
const guideReopen = ref(false)
const testing = ref(false)
const testResults = ref<Array<{ label: string; ok: boolean; msg: string }>>([])
const lastTestAt = ref(0)
const lastTestText = computed(() => {
  if (!lastTestAt.value) return ''
  const d = new Date(lastTestAt.value)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
})

// dsh Web UI 的默认监听端口：与宿主 constants.js 的 DSH_PORT_DEFAULT 必须一致
// （设置页不能 require 宿主模块，只能各持一份；改一处要同步，check-shared 会校验）。
// 为什么端口要能配：3080 落在 Windows/Hyper-V 的动态端口保留段里，被系统预留时 dsh 直接 bind 失败，
// 而用户无从改起 —— 上游 `dsh web --port <n>` 支持换端口。设置页只提供入口，真正的归一化在宿主 store。
const DEFAULT_DSH_PORT = 3080

// —— 挂件配置 ——
const cfg = reactive({
  scale: 1.3,
  scaleNum: 6,
  vol: 0.9,
  soundOn: true,
  soundSet: 'duck',
  usageMode: 'ledger',
  peakMode: 'default',
  peakRemindOn: true,
  bubbleOn: true,
  menuBtn: true,
  onTop: true,
  lowAlertOn: true,
  lowAlertAmount: LOW_ALERT_DEFAULT.CNY,
  // 今日预算：当日用量超过预算额时提醒（气泡 + 每天一次系统通知），0 = 未设置
  budgetOn: false,
  budgetAmount: 0,
  // 余额大幅波动通知：单次采样余额下降 ≥ 阈值即通知（不做每天一次去重），0 = 未设置
  dropAlertOn: false,
  dropAlertAmount: 5,
  // 点气泡依次播放台词（关闭 = 每次随机一组）
  clickQueueOn: false,
  // 提醒气泡停留秒数（0 = 常驻，手动点掉）
  remindSec: 8,
  // 免打扰时段：时段内只弹气泡、不弹系统通知（支持跨午夜，如 23:00–07:00）
  quietOn: false,
  quietFrom: '23:00',
  quietTo: '07:00',
  timeBubbleOn: true,
  // 默认关：开启后每次呼出会向 ghfast.top（第三方 GitHub 加速代理）拉一次远端 package.json
  // 比版本号。请求不含任何用户数据，但仍是「装完什么都不配就外发」，公开发布按隐私优先处理
  updateCheckOn: false,
  dragLock: false,
  // 实时识别任务栏隐藏/显示：任务栏弹出占位时挂件自动让位（详见宿主 widget.js 的 syncTaskbarWatch）
  avoidTaskbar: true,
  // 贴边间距（上/右/下/左，px）：0 = 紧贴该边
  edgeTop: 0,
  edgeRight: 0,
  edgeBottom: 0,
  edgeLeft: 0,
  // 避让滚动条：挂件贴右边缘时留出像素（默认 17px），避免盖住最大化窗口的纵向滚动条
  scrollGapOn: false,
  scrollGapPx: SCROLL_GAP_DEFAULT,
  // 吸附与翻转：ratio = 按比例吸附（吸附区宽度 = 可用区宽/高的 snapRatio%），off = 关闭吸附（纯自由摆放）
  // 翻转不用配：锚在左就朝右、锚在右就朝左（含自由摆放），鲸鱼始终朝屏幕内侧
  snapMode: 'ratio' as 'ratio' | 'off',
  snapRatio: SNAP_RATIO_DEFAULT,
  // 窗口透明度 20–100（%）与鼠标穿透总开关（开启后只能回设置页关闭）
  opacity: 100,
  passThrough: false,
  // 挂件形象：内置形象 id（见 BUILTIN_SKINS）/ 'custom' 用户导入
  skin: DEFAULT_SKIN,
  // 气泡配色主题：'default' | 'dark' | 'sakura'
  theme: 'default',
  timerNotifyOn: true,
  // 计时到点的邮件通知（邮件总开关 notifyMailOn 未开时不生效）
  timerMailOn: true,
  timerPersistOn: true,
  // 计时气泡常驻 / 计时中气泡只显示计时（原先只在挂件菜单里改，已挪到本页）
  timerBubblePin: true,
  timerBubbleOnly: true,
  // 计时时长（秒）与到点要做什么：留言 + 休息档。与挂件菜单「计时」组同一份配置
  timerSec: 1500,
  timerNote: '',
  timerBreakMin: 5,
  enterMode: 'both',
  dshNodeDir: '',
  dshKeepAlive: false,
  // dsh Web UI 监听端口（默认 3080 = DEFAULT_DSH_PORT）。空输入由输入框自己兜回默认，
  // 真正落到配置前还要过宿主 store 的 normDshPort（非法值一律退回默认）
  dshPort: DEFAULT_DSH_PORT,
  dshRegistry: '',
  dshVersion: '',
  dshReinstall: false,
  dshNoOpen: true,
  // dsh 插件市场目录源（**并发竞速**，见 dsh-market.js 的 loadCatalog）：
  //   · url      —— 自定义目录 URL（自己搭的镜像），空则不加这条
  //   · mirror   —— 是否让镜像源参赛（默认开）
  //   · registry —— 参赛的 registry，空 = 用宿主内置默认（实测延迟最低的 npmmirror）
  //   · official —— 是否让官方源参赛。**默认关**：实测它 4.37MB 要 52–99s、还常连不上
  dshMarketUrl: '',
  dshMarketMirror: true,
  dshMarketRegistry: '',
  dshMarketOfficial: false,
  // dsh 全量导出：两个勾选偏好。默认**不带凭据**（包里是明文）、**跳过 node_modules**
  dshExportCred: false,
  dshExportNoMod: true,
  // 台词库：可增删的随机组 + 两项不走抽签的固定文案（报时模板 / 动图降级）。
  // 组里的台词按「一行一条」编辑（保存时才拆行交给宿主清洗），这里存的是编辑用的文本
  quotes: { time: '', gifFail: '', groups: [] as QuoteGroupEdit[] },
  // 提醒文案模板：宿主里就是普通字符串（含换行），这里原样编辑，保存时整份交给宿主清洗
  alerts: { low: '', budget: '', peakOn: '', peakOff: '', passOn: '', passOff: '' } as Record<string, string>,
  // 额度（资源包 / 订阅）：总量 0 = 未设置；已用不落配置，按 quotaReset 从账本取
  quotaTotal: 0,
  quotaReset: 'monthly',
  // 自定义单价（令牌模式可选）：on 关闭时其余字段仍留着，下次打开不用重填。
  // models 单独给一份空数组：展开复制只做浅拷贝，共用一个数组实例会被后面的编辑污染默认值
  tokenPrice: { ...TOKEN_PRICE_DEFAULT, models: [] as WhalePriceModel[] },
  // 账本历史保留天数（35–730）：决定趋势图 / 明细 / 导出能回溯多久
  historyKeepDays: HISTORY_KEEP.DEFAULT,
  // GitHub 加速（hosts 方案）：on = 开关意图（实际是否生效以 hosts 标记块为准）；ips = 可编辑 IP 表
  ghAccelOn: false,
  ghAccelIps: [] as Array<{ domain: string; ip: string }>,
  ghAccelRefreshedAt: 0,
  // IP 获取来源开关 + 两段优先级顺序：sources = 社区源表内部顺序，order = 来源层候选链顺序。
  // 与宿主 normGhAccelSrc 同结构；默认全 true + 两段空数组 = 宿主默认候选链，与升级前行为一致
  ghAccelSrc: { doh: true, community: true, manual: true, sources: [] as string[], order: [] as string[] },
  // 通知渠道：系统通知（默认开）+ 邮件通知（默认关，需先配 SMTP）。
  // 邮件的收发件人/显示名/主题前缀属于「配置」进这里；服务器、账号、授权码属于凭据，走 mail 表单
  notifySystemOn: true,
  notifyMailOn: false,
  mailFrom: '',
  mailTo: '',
  mailFromName: '小鲸鱼余额挂件',
  mailSubjectPrefix: '[小鲸鱼余额挂件]',
})
// 邮件通知的 SMTP 凭据：与 cfg 分开，因为它在宿主侧进的是加密存储（不进备份）。
// mailPass 回填的是占位掩码而不是真实授权码 —— 只在用户没重新输入时保留原值，避免明文回显
const mail = reactive({
  mailHost: '',
  mailPort: 465,
  mailSecure: true,
  mailUser: '',
  mailPass: '',
})
// 已保存过授权码时为 true：用于把密码框的 placeholder 提示成「留空 = 不修改」
const mailPassSaved = ref(false)
const widgetVisible = ref(true)
const widgetFlash: Flash = useFlash()
// 挂件错误查看：errDetail 为宿主记录的最后一条创建/加载错误，空串表示无错误
const errDetail = ref('')
const errFlash: Flash = useFlash()
const clearConfirm = ref(false)
// 「数据与隐私」按项清除：勾选的项才会被清除（凭据 / 设置 / 账本 / 窗口位置与更新缓存 / 导入的素材）
// 素材三项（形象 / 气泡图 / 音效）合成一项，与「资源」页的「清除全部素材」等价，免得两个入口措辞还不一样
const clearItems = reactive({ secrets: true, config: true, ledger: true, window: true, assets: true })
const anyClearItem = computed(() => clearItems.secrets || clearItems.config || clearItems.ledger || clearItems.window || clearItems.assets)
// 二次确认时把「将清除哪些项」写清楚，避免误删
const clearItemNames = computed(() => {
  const names: string[] = []
  if (clearItems.secrets) names.push('凭据')
  if (clearItems.config) names.push('挂件设置')
  if (clearItems.ledger) names.push('账本用量记录')
  if (clearItems.window) names.push('窗口位置与更新缓存')
  if (clearItems.assets) names.push('导入的素材（形象 / 气泡图 / 音效）')
  return names.join('、')
})
const dataFlash: Flash = useFlash()
// 诊断日志：两版都同步落盘（%TEMP%\whale-debug.log），插件进程被 uTools 结束也不丢
const diagFlash: Flash = useFlash()
// 诊断日志入口恒显示：打包版同样落盘，不再按开发者模式隐藏
const diagReady = true

// —— DeepSeek Harness（dsh，开发者） ——
const dsh = reactive({
  running: false, stopping: false, busy: '', pid: 0, startedAt: 0, ready: false, readyAt: 0,
  keepAlive: false, url: '', port: DEFAULT_DSH_PORT, runPort: 0, needsPortRestart: false,
  nodeDir: '', nodeVersion: '', nodeAuto: true, found: true,
  error: '', lastCmd: '', log: '',
  registry: '', version: '', resolved: '', hasUpdate: false, runVersion: '', needsRestart: false, reinstall: false, prefix: '', source: '', globalVersion: '', globalDir: '', globalWritable: true,
  versions: { at: 0, latest: '', list: [] as string[] },
  external: false, externalPid: 0, externalName: '', externalRunPort: 0, portOther: '', webUrl: '', installed: '',
})
const dshFlash: Flash = useFlash()
const dshLogOpen = ref(false)
const dshLogEl = ref<HTMLElement | null>(null)
// 异步动作（启动 / 重启 / 更新）的终态收尾令牌与状态机。
// ⚠️ 为什么需要它：这三个动作都是「同步返回一个半成品快照 + 之后靠轮询拿结果」，
//    早先点完只写一条「正在更新 dsh…」占位消息就没了下文 —— 成功只进折叠着的日志、
//    失败只写进卡底的 dsh.error，用户看到占位消息一直挂着，**无从判断成功还是失败**。
//    这里在轮询里盯 busy 落回空，再把占位消息替换成真正的结果（成功 / 失败都有话说）。
// settled 为 true 才算收尾完成：busy 在更新途中会**短暂清零**
// （update() 先置 'update'，installDsh() 开头把它重置，重试提权时又置回），
// 所以必须连续两轮看到空才认定结束，否则会在「正在结束旧进程」的间隙就误报结果。
const dshAsync = { active: false, token: 0, wasBusy: false, idleTicks: 0, action: '' as 'start' | 'restart' | 'update' | '', wasRunning: false, before: '', deadline: 0 }

// 折叠区（默认收起，卡片更短）。
// 主控卡里的实际顺序：运行详情 / dsh 故障排查 / 高级选项 / 使用说明 —— 运行详情与排查提到最前，
// 它们是「出问题时才看」的，排在卡尾等于出事时滚不到；高级选项与使用说明是配置与说明，靠后无妨。
const dshFolds = reactive({ advanced: false, help: false, trouble: false, versions: false })
// 折叠「dsh 故障排查」时清掉二段确认态：dshConfirm 是单值且不随折叠重置，
// 用户点出「确认删除插件目录的 dsh？」后若收起该块再展开，按钮仍停在确认态，容易误点第二次直接执行。
function dshToggleTrouble() {
  dshFolds.trouble = !dshFolds.trouble
  if (!dshFolds.trouble) dshConfirm.value = ''
}
// 主控卡整体折叠：与其他卡保持一致（都带 caret + 收起态摘要）。默认展开 ——
// 启动/重启/结束是本 tab 最高频的动作，默认收起等于每次进来都要多点一下。
// 不并入 devFolds：其余卡是「展开才懒加载」，这张状态在启动时已自动查好，
// 用独立 ref 表达「默认展开」比给 devFolds 加默认值特例更直白
const dshMainFold = ref(true)
// 诊断折叠展开时顺手查一次「最新版本」：版本明细都是只读诊断，展开本身就是「我想核对版本」的信号，
// 此时查一次比让用户再点一次「查询可用版本」更省事。npm view 要联网、较慢，失败也不打断（dshQueryVersions 内部已兜底）
// 折叠「运行详情」时清掉二段确认态：与 dshToggleTrouble 同理，防止收起后按钮停在确认态被误点
function dshToggleVersions() {
  dshFolds.versions = !dshFolds.versions
  if (!dshFolds.versions) dshConfirm.value = ''
  if (dshFolds.versions && !dshHasVersions.value) dshQueryVersions()
}
const dshConfirm = ref('') // '' | 'remove-plugin' | 'clean-npx' | 'clear-log'
const dshNow = ref(Date.now()) // 未就绪时的「已等待 x 秒」
let dshTickTimer = 0
function dshTickSync(running: boolean, ready: boolean) {
  const need = running && !ready
  if (need && !dshTickTimer) dshTickTimer = window.setInterval(() => { dshNow.value = Date.now() }, 1000)
  else if (!need && dshTickTimer) { window.clearInterval(dshTickTimer); dshTickTimer = 0 }
  if (need) dshNow.value = Date.now()
}
// 有新版本提示（查询过可用版本才有）
// 「装最新（含测试版）」的哨兵版本号，与宿主 constants.js 的 NEWEST_VERSION 必须一致
// （设置页不能 require 宿主模块，只能各持一份；改一处要同步，check-shared 会校验）。
const NEWEST_VERSION = 'newest'
// 版本号比较：数字段逐位比，数字段 > 字母段，与宿主 isNewer 同一套口径
// （同上，这里也是副本，改一处务必同步另一处）。
function dshVerNewer(a: string, b: string) {
  const pa = String(a || '').split(/[.\-+]/), pb = String(b || '').split(/[.\-+]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i]
    if (x === undefined) return false
    if (y === undefined) return true
    const ix = parseInt(x, 10), iy = parseInt(y, 10)
    const sx = isNaN(ix), sy = isNaN(iy)
    if (sx && sy) { if (x !== y) return x > y; continue }
    if (sx !== sy) return sx
    if (ix !== iy) return ix > iy
  }
  return false
}
// 当前配置下「更新」会装到哪个版本：'' = latest 标签，'newest' = 版本列表里最高（含测试版），
// 其余为固定版本号。与宿主 installVersion 的口径保持一致。
const dshTargetVersion = computed(() => {
  if (cfg.dshVersion === NEWEST_VERSION) {
    const list = (dsh.versions && dsh.versions.list) || []
    // 列表是 npm 的发布顺序而非版本序，所以要按版本号比较取最大值，不能取末位
    let best = ''
    for (const v of list) if (!best || dshVerNewer(v, best)) best = v
    return best
  }
  return cfg.dshVersion || ((dsh.versions && dsh.versions.latest) || '')
})
const dshLatestTip = computed(() => {
  if (!dsh.hasUpdate) return ''
  return '有新版本 ' + dshTargetVersion.value + '，点「更新」'
})
// 「实际使用」与「更新会装到的版本」是否一致。
// 注意这是**另一个维度**、不是「谁更新」：手动装过 alpha / 指定过版本时，
// 目标版本可能比在用的旧（如目标 1.5.0-rc.2 而实际 1.6.0-alpha.2），
// 此时按 semver「没有更新」（状态行的 dshLatestTip 不会出现），但点「更新」仍会把你**替换**成目标版本。
// 这句提示专门补这个盲区，避免用户以为「没提示就是已是最新」。
const dshVerMismatch = computed(() => {
  if (dsh.hasUpdate) return '' // 升级情形已由状态行的 dshLatestTip 覆盖，不重复
  const latest = dshTargetVersion.value
  if (!latest) return ''
  const cur = dsh.resolved || dsh.installed || ''
  if (!cur || latest === cur) return ''
  return '当前 ' + cur + ' 与所选版本（' + latest + '）不同，点「更新」会替换为 ' + latest
})
function dshApply(s: any) {
  if (!s || typeof s !== 'object') return
  dsh.running = !!s.running
  dsh.stopping = !!s.stopping
  dsh.busy = s.busy || ''
  dsh.pid = s.pid || 0
  dsh.startedAt = s.startedAt || 0
  dsh.ready = !!s.ready
  dsh.readyAt = s.readyAt || 0
  dsh.keepAlive = s.keepAlive === true
  dsh.url = s.url || ''
  dsh.port = s.port || DEFAULT_DSH_PORT
  dsh.nodeDir = s.nodeDir || ''
  dsh.nodeVersion = s.nodeVersion || ''
  dsh.nodeAuto = s.nodeAuto !== false
  dsh.found = s.found !== false
  dsh.error = s.error || ''
  dsh.lastCmd = s.lastCmd || ''
  dsh.log = s.log || ''
  dsh.registry = s.registry || ''
  dsh.version = s.version || ''
  dsh.resolved = s.resolved || ''
  dsh.hasUpdate = s.hasUpdate === true
  dsh.runVersion = s.runVersion || ''
  dsh.needsRestart = s.needsRestart === true
  // 进程实际监听的端口由宿主单独告知：它可能与 dsh.port（配置值）不同 ——
  // 用户改了端口但没重启时就是这个状态，dshStateText 靠这两个字段避免误报「启动中」
  dsh.runPort = s.runPort || 0
  dsh.needsPortRestart = s.needsPortRestart === true
  dsh.reinstall = s.reinstall === true
  dsh.prefix = s.prefix || ''
  dsh.source = s.source === 'global' || s.source === 'plugin' ? s.source : ''
  dsh.globalVersion = s.globalVersion || ''
  dsh.globalDir = s.globalDir || ''
  dsh.globalWritable = s.globalWritable !== false
  dsh.versions = s.versions && typeof s.versions === 'object' ? s.versions : { at: 0, latest: '', list: [] }
  dsh.external = !!s.external
  dsh.externalPid = s.externalPid || 0
  dsh.externalName = s.externalName || ''
  // 外部 dsh 实际监听的端口（0 = 无留档）。改过端口后 externalPid 报的是旧端口上的进程，
  // 靠它才能说清「现监听哪个端口」——见 dshStateText 的外部分支
  dsh.externalRunPort = s.externalRunPort || 0
  dsh.portOther = s.portOther || ''
  dsh.webUrl = s.webUrl || ''
  dsh.installed = s.installed || ''
  dshTickSync(dsh.running, dsh.ready)
}
// 日志跟着更新滚到底部（只看得到最新几行）
watch(() => dsh.log, () => {
  if (!dshLogOpen.value) return
  nextTick(() => {
    const el = dshLogEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
})
function dshStatus(deep = false) {
  try {
    dshApply(services.dshStatus?.())
    // 宿主是异步探测端口的：顺手再读一次，才能拿到「外部 dsh 在不在」的真实结果。
    // 走 laterStatus 登记：首次进「开发者」Tab 会调 dshStatus(true)，
    // 用户若在这 600ms 内关掉设置窗，未登记的定时器会继续在已卸载组件上写状态
    if (deep) laterStatus(() => { try { dshApply(services.dshStatus?.()) } catch (err) {} }, 600)
  } catch (err) {}
  dshSettle()
}
// 异步动作的终态判定：busy 从「有」落回「空」并稳定两轮，才算这次动作真的结束。
// 注意 dshStatus 会在轮询与 dshApply 之后被各处调用，所以判定必须写成幂等 ——
// 认定结束后立刻清 active，后续调用直接返回，不会重复播报。
//
// ⚠️ 判「启动成功」用 dsh.ready，**不能**用 dsh.running（借鉴 dsh-market #663 的实测结论：
//    「端口有人在监听」不等于「起来了」—— 该项目的 activation-audit 失败时 web 端口其实
//    **已经被 bind**，树挂载了、服务器监听了，**然后**才拒绝整个 composition 并退出）。
//    本项目的 dsh.running 只表示「我们 spawn 的子进程还活着」，进程起来但组装失败、
//    正准备退出时它同样是 true —— 拿它报「已启动」会报出一个下一秒就崩的假成功。
//    dsh.ready 才是「3080 真正开始监听」（watchReady 观测到的结果），是唯一的成功判据。
function dshSettle() {
  if (!dshAsync.active) return
  const busy = dsh.busy
  if (busy) {
    // 还在跑（查询版本是另一条独立链路，不参与本动作的结束判定）
    if (busy !== 'versions') { dshAsync.wasBusy = true; dshAsync.idleTicks = 0 }
    return
  }
  // 从未见过 busy：动作可能在两次轮询之间就跑完了（例如「已是最新」直接返回、
  // 或第一次快照就是终态）。此时只累计轮次，避免 0 毫秒就宣布结束。
  dshAsync.idleTicks++
  // 见到过 busy 的，空闲一轮即可收尾；没见过的要两轮（防「安装还没开始」的假空闲）
  if (dshAsync.idleTicks < (dshAsync.wasBusy ? 1 : 2)) return
  // ⚠️ 进程类动作（启动 / 重启）在 busy 落空后往往还要等十几秒才真的监听上端口，
  //    此时 dsh.ready 仍是 false。若就此收尾会把它误报成「启动未成功」，
  //    所以要先给一段**宽限等待**：只要还显示着「启动中」就继续等，直到 ready 或超时。
  if (!dsh.error && dshAsync.action !== 'update' && !dsh.ready && Date.now() < dshAsync.deadline) {
    dshAsync.idleTicks = 0 // 重来一轮，等下一次轮询
    return
  }
  dshAsync.active = false
  const act = dshAsync.action
  dshAsync.action = ''
  if (dsh.error) {
    // 失败：dsh.error 已在卡底单独成行，这里只把占位消息清掉，避免两句红字打架
    dshFlash.err = true
    dshFlash.msg = ''
    dshLogOpen.value = true
    return
  }
  if (act === 'update') {
    // 更新成功 = 装到了新版本（回读磁盘的结论，见 preload 的 verifyInstalledPkg）。
    // ⚠️ 这里**不**要求 dsh.ready：更新完的 dsh 未必被拉起来（也可能用户设了不自动启动），
    //    用 ready 当判据会把「装成功了但没启动」误报成失败。
    const now = dsh.installed || dsh.globalVersion || dsh.runVersion || dsh.resolved || ''
    dshFlash.err = false
    dshFlash.msg = (dshAsync.before && now && now !== dshAsync.before)
      ? '更新完成：' + dshAsync.before + ' → ' + now
      : (dsh.ready ? '更新完成，dsh 已用新版启动' : '更新完成（新版本已装好，下次启动生效）')
  } else if (act === 'restart') {
    dshFlash.err = !dsh.ready
    dshFlash.msg = dsh.ready ? '已重启 dsh：' + dsh.port : '重启后 dsh 未就绪（详见日志）'
  } else {
    // 启动：首次会自动下载安装，ready（3080 真正监听）才是判据
    dshFlash.err = !dsh.ready
    dshFlash.msg = dsh.ready ? 'dsh 已启动' : '启动未成功：进程没能在限时内监听 ' + dsh.port + '，详见日志'
  }
  if (dshFlash.err) dshLogOpen.value = true
}
// 轮询统一管理：start 幂等（先停再起），stop 可重复调用；页面隐藏时跳过本轮，
// 避免后台空跑（dsh 状态与任务栏状态两处共用，见下方 dshPolling / taskbarPolling）
function usePolling(fn: () => void, ms: number, immediate = false) {
  let timer = 0
  const stop = () => { if (timer) { window.clearInterval(timer); timer = 0 } }
  const start = () => {
    stop()
    if (immediate) fn()
    timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') fn() }, ms)
  }
  return { start, stop }
}
// 延迟刷新 dsh 状态的 setTimeout 统一登记，便于组件卸载时一次性清掉。
// ⚠️ 为什么要登记：这些定时器都持有组件作用域闭包，回调里会写 dshApply / dshSettle 的响应式状态。
//    设置窗在 uTools 里随时可能被关掉或切走，只要延时还没到点，回调照样会执行 ——
//    等于在已卸载的组件上写状态，且这些写操作不会再被任何一次渲染消费。
// 为什么不复用 dshAsync.token：token 只在「启动/重启/更新」动作期间递增，
// 选目录、改端口这些非动作路径的延迟刷新根本没有 token 可比，所以另设一套只管生命周期的登记表。
const pendingStatusTimers = new Set<number>()
function laterStatus(fn: () => void, ms: number) {
  const id = window.setTimeout(() => {
    pendingStatusTimers.delete(id)
    fn()
  }, ms)
  pendingStatusTimers.add(id)
}
// 打开/回到本页时自动探测并持续刷新 dsh 状态（每 4s 浅探测）
const dshPolling = usePolling(() => dshStatus(false), 4000)
// dsh 状态只在「开发者」Tab 激活时轮询：dsh 是低频开发功能，用户停在其它 Tab 时没必要空转
// （首次进入补一次 deep 探测，识别外部终端里跑的 dsh；启停操作另有 deep 补读，见 dshDo/dshQueryVersions）
let dshDeepOnce = false
watch(activeTab, (tab) => {
  if (tab !== 'dev') {
    dshPolling.stop()
    return
  }
  if (!dshDeepOnce) {
    dshDeepOnce = true
    dshStatus(true)
  }
  dshPolling.start()
})
// 两张统计卡默认收起，首次「展开」时才读取：宿主是同步扫文件（会话日志可能几十 MB），
// 不看不读，避免每次进开发者 Tab 都无条件付一次扫描成本；展开后即读，也不用手动再点一下。
// 收起时摘要只在「本会话已读过」之后才显示（否则露「点击展开查看」），保证折叠 = 不预读。
const devFolds = reactive({ dshUsage: false, codex: false, diagnose: false, dshDump: false, dshIsolate: false, dshMarket: false, dshExport: false })
const devStatsLoaded = reactive({ dshUsage: false, codex: false, diagnose: false, dshDump: false, dshIsolate: false, dshMarket: false, dshExport: false })
function toggleDevCard(key: 'dshUsage' | 'codex' | 'diagnose' | 'dshDump' | 'dshIsolate' | 'dshMarket' | 'dshExport') {
  devFolds[key] = !devFolds[key]
  if (!devFolds[key] || devStatsLoaded[key]) return
  devStatsLoaded[key] = true
  if (key === 'dshUsage') dshUsageRefresh()
  else if (key === 'codex') codexRefresh()
  else if (key === 'dshDump') dshDumpRefresh()
  else if (key === 'dshExport') dshExportRefresh()
  else if (key === 'dshIsolate') { dshIsolateRefresh(); dshBackupRefresh() }
  // ⚠️ dshMarket **不在此处联网**：本 Tab 其余卡都是「展开即读本地文件」，
  // 唯独这张卡要发 HTTP。展开就自动抓等于「用户只是翻一眼 tab 就产生一次出站请求」，
  // 与其余卡的语义不一致，且用户没法预知。这里只读本地已装状态（不联网），
  // 目录由用户在卡内显式点「加载目录」才抓。
  else if (key === 'dshMarket') dshMarketRefreshStatus()
  else diagnoseRefresh()
}
// 启动/结束是同步返回；重启要等旧进程退出、更新要下载，之后再补一次状态
function dshDo(action: 'start' | 'stop' | 'restart' | 'update') {
  try {
    const api = services as any
    const fn = action === 'start' ? api.dshStart : action === 'stop' ? api.dshStop : action === 'restart' ? api.dshRestart : api.dshUpdate
    dshApply(fn?.())
    dshFlash.err = false
    // 启动/重启/更新都要等一会儿（首次安装要下载），自动展开日志方便看进度
    if (action !== 'stop') dshLogOpen.value = true
    dshFlash.msg = action === 'start' ? '已启动 dsh（首次会自动下载安装，稍等片刻再看状态）'
      : action === 'stop' ? '已结束 dsh'
        : action === 'restart' ? '正在重启 dsh…'
          : '正在更新 dsh（结束旧进程 → 重新安装 → 用新版启动）…'
    // 异步动作挂上终态收尾（stop 是同步语义、结果由下一次快照直接给出，不参与）
    if (action !== 'stop') {
      dshAsync.active = true
      dshAsync.token++
      dshAsync.wasBusy = false
      dshAsync.idleTicks = 0
      dshAsync.action = action
      // 记录更替前的版本，更新完成时才能报出「v1.6.0 → v1.7.0」而不是一句干巴巴的「完成」
      dshAsync.before = action === 'update' ? (dsh.resolved || dsh.runVersion || dsh.installed || dsh.globalVersion || '') : ''
      // 启动/重启的宽限等待上限：busy 落空后还要等 dsh 真监听上端口。
      // 90s 的取法：首次安装要下载（busy 期间已覆盖），这里只等「已装好、进程正在起」的那段，
      // watchReady 自己给的是 3 分钟，取 90s 是为了让「起不来」能早点有结论，不至于让用户干等。
      dshAsync.deadline = Date.now() + (action === 'update' ? 0 : 90000)
      const token = dshAsync.token
      // 结束外部 dsh 要等 700ms 复查端口；更新要重新下载（首次安装约几十秒），所以多刷新几次。
      // ⚠️ 这些点位只负责「早点刷新界面」：更新可能要跑几分钟（github / tarball 来源要现场
      //    clone + 构建），固定点位到点时它往往还没结束。真正的收尾交给 4s 常规轮询，
      //    所以这里不再试图用点位覆盖到结束（早先最远只到 90s，超时就等于又把结果弄丢了）。
      const delays = action === 'restart' ? [2500, 6000] : action === 'update' ? [5000, 20000, 45000] : [800]
      for (const ms of delays) window.setTimeout(() => { if (token === dshAsync.token) dshStatus() }, ms)
    }
  } catch (err: any) {
    dshAsync.active = false
    dshFlash.err = true
    dshFlash.msg = '操作失败：' + String(err?.message || err)
  }
}
// 清空日志：与维护类操作同一套二段确认（日志是排查现场，点错就没法复原）
function dshClearLog() {
  if (dshConfirm.value !== 'clear-log') { dshConfirm.value = 'clear-log'; dshFlash.msg = ''; return }
  dshConfirm.value = ''
  try {
    dshApply(services.dshClearLog?.())
    dshValueTip('log', '已清空日志')
  } catch (err: any) {
    dshValueTip('log', '清空失败', true)
    dshFlash.err = true
    dshFlash.msg = '清空失败：' + String(err?.message || err)
  }
}
// 维护类操作：点第一次变确认，点第二次执行（避免误删）
function dshMaintain(kind: 'remove-plugin' | 'clean-npx' | 'clear-lock') {
  if (dshConfirm.value !== kind) { dshConfirm.value = kind; dshFlash.msg = ''; return }
  dshConfirm.value = ''
  try {
    if (kind === 'clear-lock') { dshClearLock(); return }
    const s = kind === 'remove-plugin' ? services.dshRemovePlugin?.() : services.dshCleanNpxCache?.()
    dshApply(s)
    dshFlash.err = !!dsh.error
    dshFlash.msg = kind === 'remove-plugin' ? '已删除插件目录里的 dsh' : '已清理 npx 旧缓存（详见日志）'
    dshLogOpen.value = true
  } catch (err: any) {
    dshFlash.err = true
    dshFlash.msg = '操作失败：' + String(err?.message || err)
  }
}
// 清理 dsh 的 profile 写锁（孤儿锁）。
//
// 为什么需要这个按钮：dsh 每次改 profile 都要先拿一把写锁 <profile>/package.json.lock，
// 那把锁把持有者 pid 写进文件却从不读、也没有过期检查；进程被强杀或取消更新时，
// finally 里的释放不执行，锁就永久残留 —— 之后该 profile 的装/卸/更新/市场全部死锁。
// 上游把这些锁的回收明确定义为「人工操作」（0.1.7-alpha.2 与 rc.1 逐字相同），
// 所以只能由这边提供一个人工入口。
//
// ⚠️ 判据完全交给宿主侧（dshLockStale 的三重校验），界面**不做**任何「看起来像就删」的判断：
//    只有 pid 确证死亡才清；锁被真进程持有、或内容读不懂时一律拒删并如实回报原因。
//    这里刻意不做「有 dsh 在跑就跳过」的前置 —— 实测中 dsh web 长期在跑，而锁里的 pid
//    早已是别的死进程（本机 2026-09-24 实例：锁里 pid=22536 已死，dsh web 却一直活着），
//    加这种前置会把唯一该清的情况挡在门外。
function dshClearLock() {
  try {
    const st = services.dshLockStale?.()
    if (!st || !st.ok) {
      dshFlash.err = true
      dshFlash.msg = '检测失败：' + String(st?.error || '无法读取 profile 写锁')
      return
    }
    if (!st.stale) {
      // 按成因给不同文案：「被别的进程持有」和「内容读不懂」对用户是两回事
      const why: Record<string, string> = {
        absent: '没有残留的写锁，无需清理',
        alive: '写锁正被进程 ' + st.pid + ' 持有，未做清理',
        'bad-content': '写锁内容无法识别，为安全起见未做清理',
        unknown: '无法确认写锁持有者是否存活，为安全起见未做清理',
      }
      dshFlash.err = st.reason === 'alive' || st.reason === 'bad-content' || st.reason === 'unknown'
      dshFlash.msg = why[st.reason || ''] || '写锁不属于可清理状态（' + (st.reason || '未知') + '）'
      dshLogOpen.value = true
      return
    }
    // 确认是孤儿锁后再走一次清理；宿主侧会重新校验一遍（检测到确认之间可能已过去数秒）
    const done = services.dshLockClear?.()
    if (done?.ok && done.cleared) {
      dshFlash.err = false
      dshFlash.msg = '已清理残留的 dsh 写锁（死进程 pid=' + st.pid + '），可以重试之前失败的操作了'
    } else if (done?.already) {
      dshFlash.err = false
      dshFlash.msg = '写锁已不存在，无需清理'
    } else {
      dshFlash.err = true
      dshFlash.msg = '清理失败：' + String(done?.error || '未知原因')
    }
    dshLogOpen.value = true
  } catch (err: any) {
    dshFlash.err = true
    dshFlash.msg = '操作失败：' + String(err?.message || err)
  }
}
// 复制 / 定位这类「指着某个值做的动作」，反馈就近显示在那个值上：
// 卡底的 dshFlash 在运行详情展开、日志拉高之后已经滚出视野，用户还得多滚一趟才看得见结果。
// 只记结果与序号，不再把消息 push 进 dshFlash —— 否则同一条消息会在卡底再显示一遍。
const dshValueFlash = ref({ key: '', text: '', err: false })
let dshValueTick = 0
function dshValueTip(key: string, tip: string, err = false) {
  const token = ++dshValueTick
  dshValueFlash.value = { key, text: tip, err }
  window.setTimeout(() => { if (token === dshValueTick) dshValueFlash.value = { key: '', text: '', err: false } }, 2000)
}
function dshOpenPage() {
  try {
    const url = services.dshOpenWeb?.()
    if (!url) {
      dshFlash.err = true
      dshFlash.msg = '打开失败：无法调用系统浏览器'
      return
    }
    dshFlash.err = !dsh.webUrl
    dshFlash.msg = dsh.webUrl
      ? '已用系统浏览器打开：' + url
      : '已打开 ' + url + '（还没拿到带 token 的地址：若提示需要认证，等 dsh 完全启动后再点一次）'
  } catch (err: any) {
    dshFlash.err = true
    dshFlash.msg = '打开失败：' + String(err?.message || err)
  }
}
function dshCopyUrl() {
  // 兜底与「页面地址」那一行的展示文案保持一致：未启动时展示端会拼出默认地址，
  // 复制端若只认 dsh.webUrl/dsh.url 就会回「暂无地址」，用户看着屏幕上的地址却说没有。
  // 端口可配后兜底地址跟着 dsh.port 走，没拿到快照时才退回默认端口
  const url = dsh.webUrl || dsh.url || 'http://127.0.0.1:' + (dsh.port || DEFAULT_DSH_PORT)
  const ok = services.copyText?.(url)
  dshValueTip('url', ok ? '已复制' : '复制失败，请手动选中地址复制', !ok)
}
// 定位安装目录：node 全局装的那份不必复制路径、更不能点开 —— 是拿去找人核对才用得上
function dshLocatePrefix() {
  try {
    const r = services.openDir?.(dsh.prefix)
    if (!r || !r.ok) {
      dshValueTip('prefix', '打开目录失败', true)
      dshFlash.err = true
      dshFlash.msg = '打开插件目录失败：系统未返回结果'
      return
    }
    dshValueTip('prefix', '已打开目录', false)
  } catch (err: any) {
    dshValueTip('prefix', '打开目录失败', true)
    dshFlash.err = true
    dshFlash.msg = '打开插件目录失败：' + String(err?.message || err)
  }
}
// 选择 Node.js 安装目录（校验目录里有 node 可执行文件）
function dshPickDir() {
  try {
    const r = services.dshPickNodeDir?.()
    if (!r || r.canceled) return
    if (!r.ok) {
      dshFlash.err = true
      dshFlash.msg = r.error || '目录无效'
      return
    }
    patchCfg({ dshNodeDir: r.dir })
    dshFlash.msg = 'Node.js 目录已设为 ' + r.dir
    dshFlash.err = false
    laterStatus(dshStatus, 400)
  } catch (err: any) {
    dshFlash.err = true
    dshFlash.msg = '选择失败：' + String(err?.message || err)
  }
}
function dshAutoDir() {
  patchCfg({ dshNodeDir: '' })
  dshFlash.msg = '已改为自动探测（PATH → 常见安装位置）'
  dshFlash.err = false
  laterStatus(dshStatus, 400)
}
// 端口输入框的提交（@change 而非 @input：敲 "4080" 途中会先经过 "4"、"40"，逐个提交没有意义，
// 而且每敲一位都写一次存储）。非法值（空 / 0 / >65535 / 非整数）一律退回默认端口，
// **并且要把输入框里的错误值改回 cfg.dshPort**：宿主虽会归一化，但设置页自己的输入框若不回填，
// 屏幕上就留着那个没生效的数字，看着像「已经改成 65536 了」。改了端口必须重启 dsh 才生效（见下方提示）。
function dshSetPort(e: Event) {
  const raw = Math.round(Number((e.target as HTMLInputElement).value))
  const port = raw >= 1 && raw <= 65535 ? raw : DEFAULT_DSH_PORT
  cfg.dshPort = port
  if (e.target) (e.target as HTMLInputElement).value = String(port)
  if (port === DEFAULT_DSH_PORT && raw !== DEFAULT_DSH_PORT) {
    dshFlash.msg = '端口必须是 1–65535 的整数，已退回默认 ' + DEFAULT_DSH_PORT
    dshFlash.err = true
  } else if (dsh.running && !dsh.needsPortRestart && port !== dsh.runPort) {
    // 正在运行时改端口：进程还停在旧端口上，只有「重启」才切得过去。
    // ⚠️ 这里必须按「运行中」给措辞：宿主不会因为改配置就换端口，下一秒回来的快照里
    //    needsPortRestart 会是 true、状态行写着「现监听 <旧端口>」。若这里仍说「重启后生效」，
    //    用户会以为端口已经切过去一半了 —— 2026-09-26 的误报「启动中…（<新端口> 未就绪）」
    //    就是这种「配置与运行状态没分清」的同一个坑。
    dshFlash.msg = '端口已设为 ' + port + '，当前进程仍在 ' + dsh.runPort + ' 上运行，点「重启」后生效'
    dshFlash.err = false
  } else if (dsh.external) {
    // 外部 dsh 在跑（可能是别的终端启的、也可能停在旧端口上）：改配置同样不会让进程换端口。
    // 与上面 running 分支同一个道理 —— 必须说清「现在跑在哪个端口」，否则用户以为已经切过去了。
    const on = dsh.externalRunPort || port
    dshFlash.msg = '端口已设为 ' + port + '，外部 dsh（pid ' + dsh.externalPid + '）仍在 ' + on + ' 上运行，点「重启」后生效'
    dshFlash.err = false
  } else {
    dshFlash.msg = port === DEFAULT_DSH_PORT ? '已改为默认端口 ' + port : '端口已设为 ' + port + '，重启 dsh 后生效'
    dshFlash.err = false
  }
  patchCfg({ dshPort: port })
}
function dshCopyLog() {
  const text = dsh.log || ''
  if (!text) {
    dshFlash.err = true
    dshFlash.msg = '暂无日志：启动/更新 dsh 后这里会显示它的输出。'
    return
  }
  const ok = services.copyText?.(text)
  dshValueTip('log', ok ? '已复制 ' + text.split('\n').length + ' 行' : '复制失败，请手动选中日志复制', !ok)
}
const dshNodeText = computed(() => {
  if (cfg.dshNodeDir) return cfg.dshNodeDir + (dsh.nodeDir && dsh.nodeDir !== cfg.dshNodeDir ? '（无效，实际用 ' + dsh.nodeDir + '）' : '')
  return dsh.nodeDir ? '自动：' + dsh.nodeDir : '未找到 Node.js'
})
const dshStateText = computed(() => {
  if (dsh.busy === 'install') return '安装中…'
  if (dsh.busy === 'update') return '更新中…'
  if (dsh.busy === 'versions') return '查询版本中…'
  if (dsh.running) {
    // 进程还活着、只是配置端口被改了：运行端口上的事实仍然成立，不能显示「启动中」。
    // 这里必须先判 needsPortRestart —— 它的 ready 描述的是 runPort，与新的配置端口无关。
    const portHint = dsh.needsPortRestart
      ? ' · 端口已改为 ' + dsh.port + '（现监听 ' + dsh.runPort + '），点「重启」生效'
      : ''
    if (!dsh.ready && !dsh.needsPortRestart) {
      const wait = dsh.startedAt ? Math.max(0, Math.round((dshNow.value - dsh.startedAt) / 1000)) : 0
      return '启动中…（' + dsh.port + ' 未就绪' + (wait > 3 ? '，已等待 ' + wait + ' 秒' : '，首次安装需要下载') + '）'
    }
    const sec = dsh.startedAt && dsh.readyAt ? ((dsh.readyAt - dsh.startedAt) / 1000).toFixed(1) + 's' : ''
    return '运行中 · pid ' + dsh.pid + (sec ? '（就绪用时 ' + sec + '）' : '') +
      (dsh.needsRestart ? ' · 已更新到 ' + (dsh.resolved || '') + '，点「重启」生效' : '') +
      portHint
  }
  if (dsh.external) {
    // 外部 dsh 停在旧端口（externalRunPort）上、配置端口又被改过时，要说明「现监听哪个」：
    // 否则用户改了端口、状态卡只说「外部 dsh · pid N」，会以为端口已经切过去了。
    const extHint = dsh.externalRunPort && dsh.externalRunPort !== dsh.port
      ? '（现监听 ' + dsh.externalRunPort + '）· 端口已改为 ' + dsh.port + '，点「重启」生效'
      : ''
    return '外部 dsh · pid ' + dsh.externalPid + extHint
  }
  if (dsh.portOther) return '端口 ' + dsh.port + ' 被 ' + dsh.portOther + ' 占用'
  return '未运行'
})
const dshBusy = computed(() => dsh.busy === 'update' || dsh.busy === 'versions' || dsh.busy === 'install')
// 版本下拉：「自动」＝安装/更新时取 latest；也可以固定成某个具体版本
const dshVersionOptions = computed(() => {
  const list: string[] = (dsh.versions && dsh.versions.list) || []
  const latest = (dsh.versions && dsh.versions.latest) || ''
  // 先把「同一个版本号上的各种标记」汇总，再统一生成选项：
  // 早前是边判边 push，去重会让先出现的标记吃掉后面的（如已在用又恰好是 latest，
  // 就只剩一个标记），也导致全局安装时「已安装」完全不显示——那时判的是插件目录那份（installed）。
  const marks: Record<string, string[]> = {}
  const addMark = (v: string, m: string) => {
    if (!v) return
    if (!marks[v]) marks[v] = []
    if (!marks[v].includes(m)) marks[v].push(m)
  }
  // 「已安装」要标在**实际在用**的那份上（resolved 优先全局，见宿主 snapshot）
  if (dsh.resolved) addMark(dsh.resolved, dsh.source === 'global' ? '全局已安装' : '插件目录已安装')
  // 哨兵值不是真实版本号，不能拿去 addMark：那会在下面多推出一条 value='newest' 的选项，
  // 与固定写的那条「最新（含测试版…）」重复。它的「已选」改由选项的 label 自己拼。
  if (cfg.dshVersion && cfg.dshVersion !== NEWEST_VERSION) addMark(cfg.dshVersion, '已选')
  if (latest) addMark(latest, 'latest 标签')

  const out: Array<{ v: string; label: string }> = [
    { v: '', label: '自动（安装/更新时取 latest）' },
    {
      v: NEWEST_VERSION,
      label: '最新（含测试版，取列表中最高版本）' + (cfg.dshVersion === NEWEST_VERSION ? '（已选）' : ''),
    },
  ]
  const seen: Record<string, boolean> = { '': true }
  seen[NEWEST_VERSION] = true
  const push = (v: string) => {
    if (!v || seen[v]) return
    seen[v] = true
    const ms = marks[v]
    out.push({ v: v, label: ms && ms.length ? v + '（' + ms.join('，') + '）' : v })
  }
  // 版本列表按宿主给的顺序倒序（新版本在前），有标记的那几个（在用 / 已选）优先提到前面
  for (let i = list.length - 1; i >= 0; i--) push(list[i])
  for (const v of Object.keys(marks)) push(v)
  return out
})
// 查询可用版本：npm view 要联网，慢一点，稍后多次刷新状态
const DSH_QUERY_MSG = '正在查询可用版本…'
// 查询结果已经上屏（或正在查询）时就没必要再摆一个按钮占位：
// 「查询可用版本」只在两种情况下有意义 —— 还没查过、以及上次查失败要重试。
// 查询成功后 latest 直接显示在下面的「npm latest」行里，按钮留着只会让人怀疑「是不是还要再点一下」。
const dshQueryFailed = ref(false)
// 已经查到 latest 就别自动再查一遍：npm view 要联网、较慢，
// 每次展开运行详情都打一次是白花流量（用户想看最新的可手动点「重新查询」）。
const dshHasVersions = computed(() => !!(dsh.versions && dsh.versions.latest))
// 「npm latest」那一行的取值：查询结果是异步回来的（宿主查到 latest 后由轮询带回），
// 所以要区分三态 —— 查到 / 正在查 / 没查过。写成 `latest || '未查询'` 会让查询途中就报「未查询」，
// 与旁边按钮上的「查询中…」自相矛盾。
const dshLatestText = computed(() => {
  if (dshHasVersions.value) return (dsh.versions && dsh.versions.latest) || ''
  return dshQueryFailed.value ? '查询失败' : '未查询'
})
// 轮询是异步的，等结果期间先挂个「正在查询」。查到了要主动清掉：
// dshStatus 是通用轮询入口、成功时不碰 dshFlash，若不在这里清，提示会一直挂着到下次操作。
let dshQueryDone = 0 // 本次查询的令牌，防止上一轮的兜底定时器清掉下一轮刚设的提示
function dshQueryVersions() {
  try {
    services.dshListVersions?.()
    dshQueryFailed.value = false
    dshFlash.err = false
    dshFlash.msg = DSH_QUERY_MSG
    const token = ++dshQueryDone
    // 宿主查到 latest 后会在后续快照里带回来，所以每次都读一遍状态、顺带把提示收掉
    const probe = () => {
      dshStatus()
      if (token !== dshQueryDone) return
      if (dsh.versions && dsh.versions.latest) { dshFlash.msg = ''; dshQueryDone++; return }
      // 只有「还是我发的那条」才清，避免覆盖用户期间其他操作的消息
      if (dshFlash.msg === DSH_QUERY_MSG && Date.now() - t0 > 12000) {
        dshQueryFailed.value = true // 留下来给用户一个「重试」入口，按钮不再自动隐藏
        dshFlash.err = true
        dshFlash.msg = '查询超时：未取到可用版本，请检查网络或 npm 注册源后重试。'
        dshQueryDone++
      }
    }
    const t0 = Date.now()
    for (const ms of [2000, 5000, 9000]) window.setTimeout(probe, ms)
    window.setTimeout(probe, 12000)
  } catch (err: any) {
    dshQueryFailed.value = true
    dshFlash.err = true
    dshFlash.msg = '查询失败：' + String(err?.message || err)
  }
}

// —— Codex 本地会话统计 ——
// 数据来自 ~/.codex/sessions 下的 rollout JSONL（Codex CLI 自己写的明文日志），
// 纯本地读取，不需要 API Key，也不发任何网络请求。
const codex = ref<CodexSummaryResult | null>(null)
const codexBusy = ref(false)
const codexFlash: Flash = useFlash()
const codexFolds = reactive({ help: false })
// token 数按万/亿缩写，避免长串数字撑破布局
function fmtTokens(n?: number) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万'
  return String(v)
}
// 图表档位：宿主一次给 31 天（days31，索引 0 是今天），切档只改前端切片、不重扫
const codexRange = ref(7)
// 同 dshUsageDays：days31 是新→旧，最近 N 天在开头，故 slice(0, N)。
// 原用 slice(-N) 取到的是最旧的 N 天（见 dshUsageDays 处的说明）。
const codexDays = computed(() => ((codex.value && codex.value.days31) || []).slice(0, codexRange.value))
// 30 天档标签抽稀：每 5 天一个，避免糊成一片
const codexLabelEvery = computed(() => (codexRange.value >= 30 ? 5 : 1))
const codexModels = computed(() => {
  const bm = (codex.value && codex.value.byModel) || {}
  return Object.keys(bm)
    .map((k) => ({ name: k, ...bm[k] }))
    .sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0))
})
// 柱高百分比：最大值为满格（100%），最小留 2% 让「有量但极少」也看得见。
// 最大值就地算：这份 days 已按档位切好、最多 31 个元素，不值得单开 computed，
// 且共用组件拿不到这里的 computed，只能靠这个函数（见 UsageChart.vue 的 hasBars）。
function codexBarHeight(tokens?: number) {
  let max = 0
  for (const d of codexDays.value) max = Math.max(max, Number(d.tokens) || 0)
  if (!max) return '0%'
  return Math.max(2, Math.round(((Number(tokens) || 0) / max) * 100)) + '%'
}
// 'YYYY-MM-DD' → 'M-D'（图表横轴，省宽度）
function codexDayLabel(date: string) {
  const p = String(date || '').split('-')
  return p.length === 3 ? Number(p[1]) + '-' + Number(p[2]) : date
}
// —— Codex 订阅窗口（5h / 周）——
// ChatGPT 订阅的 Codex 会在 token_count 事件里带 rate_limits 快照（API-key 计费没有这份数据），
// 窗口是账号级状态，与本地 token 统计各自独立，所以单独一行展示。
const codexWindows = computed(() => (codex.value && codex.value.windows) || null)
// 窗口名：优先按日志里的窗口分钟数推断（各 Codex 版本给的值不一样），没给就按位置叫 5h / 周
function codexWinLabel(w: CodexWindow, idx: number) {
  const mins = Number(w.windowMinutes) || 0
  if (mins >= 1440) return Math.round(mins / 1440) + '天'
  if (mins >= 60) return Math.round(mins / 60) + 'h'
  if (mins > 0) return mins + '分钟'
  return idx === 0 ? '5h' : '周'
}
function codexWinReset(w: CodexWindow) {
  if (!w.resetAt) return ''
  const left = Number(w.resetAt) - codexNow.value
  if (!isFinite(left)) return ''
  if (left <= 0) return '即将重置'
  const h = Math.floor(left / 3600000)
  const d = Math.floor(h / 24)
  if (d > 0) return d + '天' + (h % 24) + '小时后重置'
  return h + '小时' + Math.floor((left % 3600000) / 60000) + '分后重置'
}
function codexWinPct(v: number | null | undefined) {
  if (v === null || v === undefined) return '--'
  return (Number(v) || 0).toFixed(1).replace(/\.0$/, '') + '%'
}
// 窗口文案：Codex 卡片与模型列表行共用（同一份数据两处显示，措辞要一致）
function codexWinText(w: CodexWindows | null) {
  if (!w) return ''
  const parts: string[] = []
  const list: [number, CodexWindow | null][] = [[0, w.primary], [1, w.secondary]]
  for (const [idx, one] of list) {
    if (!one) continue
    const reset = codexWinReset(one)
    parts.push(codexWinLabel(one, idx) + ' 已用 ' + codexWinPct(one.usedPct) + (reset ? ' · ' + reset : ''))
  }
  if (w.planType) parts.push(w.planType)
  return parts.join(' | ')
}
const codexWindowsText = computed(() => codexWinText(codexWindows.value))
function codexRefresh() {
  if (codexBusy.value) return
  codexBusy.value = true
  codexFlash.msg = ''
  codexFlash.err = false
  // 宿主侧是同步读文件（会话日志可能几十 MB），直接调会把「读取中…」和这次渲染一起卡住；
  // 先让 Vue 渲染一帧，再在下一轮事件循环里执行
  window.setTimeout(codexRefreshRun, 30)
}
function codexRefreshRun() {
  try {
    const r = services.codexSummary?.()
    if (!r) {
      codexFlash.err = true
      codexFlash.msg = '宿主 API 不可用'
      return
    }
    codex.value = r
    if (!r.ok) {
      codexFlash.err = true
      codexFlash.msg = r.error || '读取失败'
      return
    }
    codexFlash.msg = r.sessions
      ? `已扫描 ${r.sessions} 个会话文件（${r.changed} 个有更新）`
      : '未找到会话文件：确认 Codex CLI 用过、且 ~/.codex/sessions 里有 rollout-*.jsonl'
    codexFlash.err = !r.sessions
  } catch (err: any) {
    codexFlash.err = true
    codexFlash.msg = '读取失败：' + String(err?.message || err)
  } finally {
    codexBusy.value = false
  }
}
// 清缓存后重新扫（用于日志被外部改动、或怀疑缓存不一致时）
function codexClearCache() {
  try {
    services.clearCodexCache?.()
    codex.value = null
    codexRefresh()
  } catch (err: any) {
    codexFlash.err = true
    codexFlash.msg = '清除失败：' + String(err?.message || err)
  }
}

// —— dsh 本地用量统计 ——
// 数据来自 dsh 自己写在 $DSH_HOME（默认 ~/.dsh）下的用量数据：优先 dsh-usage 的按天账本，
// 账本还没落盘时回落到会话投影缓存（storages/session_projcache）。纯本地读取，不需要 API Key。
const dshUsage = ref<DshUsageResult | null>(null)
const dshUsageBusy = ref(false)
const dshUsageFlash: Flash = useFlash()
const dshUsageFolds = reactive({ help: false })
// 图表档位：宿主一次给 31 天（days31，索引 0 是今天），切档只改前端切片、不重扫
const DSH_USAGE_RANGES = [7, 14, 30] as const
const dshUsageRange = ref(7)
// 取「最近的 N 天」。days31 是**新→旧**（索引 0 是今天，宿主用 dayAdd(today, -i) 递减生成），
// 所以最近 N 天在数组**开头**，必须用 slice(0, N)。
// 早先用 slice(-N) 取的是**尾部**，即 31 天里最旧的 N 天 —— 症状是「7 天档」实际画的是
// 30~24 天前那一周（日期从 9-22 一路排到 8-28，跨了 26 天），今日/近期数据完全不出图。
const dshUsageDays = computed(() => ((dshUsage.value && dshUsage.value.days31) || []).slice(0, dshUsageRange.value))
// 30 天档标签抽稀：每 5 天一个，避免糊成一片
const dshUsageLabelEvery = computed(() => (dshUsageRange.value >= 30 ? 5 : 1))
const dshUsageModels = computed(() => {
  const bm = (dshUsage.value && dshUsage.value.byModel) || {}
  return Object.keys(bm)
    .map((k) => ({ name: k, ...bm[k] }))
    .sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0))
})
const dshUsageSourceText = computed(() => {
  const s = dshUsage.value && dshUsage.value.source
  if (s === 'ledger') return 'dsh-usage 按天账本'
  if (s === 'sessions') return '会话缓存聚合'
  return '无用量记录'
})
// 柱高百分比：最大值为满格（100%），最小留 2% 让「有量但极少」也看得见。
// 最大值就地算：这份 days 已经按档位切好，元素最多 31 个，不值得为它单开一个 computed，
// 而且共用组件拿不到这里的 computed，只能靠这个函数（见 UsageChart.vue 的 hasBars）。
function dshUsageBarHeight(tokens?: number) {
  let max = 0
  for (const d of dshUsageDays.value) max = Math.max(max, Number(d.tokens) || 0)
  if (!max) return '0%'
  return Math.max(2, Math.round(((Number(tokens) || 0) / max) * 100)) + '%'
}
// 花费按账本原币种显示；极小金额多留几位小数，免得非零却显示成 0.00
function fmtDshCost(v?: number) {
  const n = Number(v) || 0
  const cur = (dshUsage.value && dshUsage.value.costCurrency) || 'CNY'
  return (cur === 'CNY' ? '¥ ' : '') + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2))
}
// dsh-usage 自己抓的余额快照：与挂件轮询的余额互为印证，只作对照展示。
// 金额与抓取时间拆成两个函数 —— 指标格里它们分处价值行与副行，
// 而且金额要能被 nowrap 保住不被折行（原先拼成一句时日期会把金额挤到换行）。
function fmtDshBalanceAmount() {
  const b = dshUsage.value && dshUsage.value.balance
  if (!b) return ''
  const cur = b.currency === 'CNY' ? '¥' : b.currency === 'USD' ? '$' : ''
  return cur + Number(b.amount || 0).toFixed(2)
}
function fmtDshBalanceAt() {
  const b = dshUsage.value && dshUsage.value.balance
  if (!b || !b.at) return ''
  return new Date(b.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}
function dshUsageRefresh() {
  if (dshUsageBusy.value) return
  dshUsageBusy.value = true
  dshUsageFlash.msg = ''
  dshUsageFlash.err = false
  // 宿主侧是同步读文件，直接调会把「读取中…」和这次渲染一起卡住；
  // 先让 Vue 渲染一帧，再在下一轮事件循环里执行
  window.setTimeout(dshUsageRefreshRun, 30)
}
function dshUsageRefreshRun() {
  try {
    const r = services.dshUsageSummary?.()
    if (!r) {
      dshUsageFlash.err = true
      dshUsageFlash.msg = '宿主 API 不可用'
      return
    }
    dshUsage.value = r
    if (!r.ok) {
      dshUsageFlash.err = true
      dshUsageFlash.msg = r.error || '读取失败'
      return
    }
    const label = dshUsageSourceText.value
    dshUsageFlash.msg = `已扫描 ${r.sessions} 个会话缓存（${r.changed} 个有更新）· 数据来源：${label}`
    dshUsageFlash.err = r.source === 'none'
  } catch (err: any) {
    dshUsageFlash.err = true
    dshUsageFlash.msg = '读取失败：' + String(err?.message || err)
  } finally {
    dshUsageBusy.value = false
  }
}
// 清缓存后重新扫（用于 dsh 正在写入、或怀疑缓存不一致时）
function dshUsageClearCache() {
  try {
    services.clearDshUsageCache?.()
    dshUsage.value = null
    dshUsageRefresh()
  } catch (err: any) {
    dshUsageFlash.err = true
    dshUsageFlash.msg = '清除失败：' + String(err?.message || err)
  }
}

// —— dsh 只读诊断 ——
// 五项检查全在宿主侧读本地文件（含遍历 node_modules），点开才跑；纯只读，不改任何配置。
const diagnose = ref<DshDiagnoseResult | null>(null)
const diagnoseBusy = ref(false)
const diagnoseFlash: Flash = useFlash()
const diagnoseFolds = reactive({ help: false })
function diagnoseRefresh(force = false) {
  if (diagnoseBusy.value) return
  diagnoseBusy.value = true
  diagnoseFlash.msg = ''
  diagnoseFlash.err = false
  // 宿主侧要读本地文件（C1 遍历 node_modules、C5 探测端口），直接调会占住消息循环；
  // 先让 Vue 把「诊断中…」渲染出来，再在下一轮事件循环里发请求
  window.setTimeout(() => diagnoseRefreshRun(force), 30)
}
function diagnoseRefreshRun(force: boolean) {
  let p: Promise<DshDiagnoseResult> | undefined
  try {
    p = services.diagnoseDsh?.({ force })
  } catch (err: any) {
    diagnoseFlash.err = true
    diagnoseFlash.msg = '诊断失败：' + String(err?.message || err)
    diagnoseBusy.value = false
    return
  }
  if (!p) {
    diagnoseFlash.err = true
    diagnoseFlash.msg = '宿主 API 不可用'
    diagnoseBusy.value = false
    return
  }
  // 宿主返回 Promise，必须 then 取结果：之前直接把 Promise 当结果用，
  // 导致结果永远渲染不出来、且结论字段全是 undefined
  p.then((r) => {
    diagnose.value = r
    if (r.error) {
      diagnoseFlash.err = true
      diagnoseFlash.msg = r.error
      return
    }
    // 命中的是 TTL 内的旧结果时说清楚，免得用户以为刚跑完却没更新
    diagnoseFlash.msg = (r.cached ? '60 秒内已有结果，直接复用；' : '') +
      (r.bad ? `${r.pass} 项通过 · ${r.bad} 项异常` : '全部通过')
    diagnoseFlash.err = false
  }).catch((err: any) => {
    diagnoseFlash.err = true
    diagnoseFlash.msg = '诊断失败：' + String(err?.message || err)
  }).finally(() => {
    diagnoseBusy.value = false
  })
}
// 折叠头摘要（§3.6）：有结论无事才说「全部通过」，C5 判不出来时仍算异常项
const diagnoseSummary = computed(() => {
  const r = diagnose.value
  if (!r) return '点击展开诊断'
  // env 可能为 null（读环境失败/超时兜底），此时不冒充「未安装」
  if (r.env && !r.env.installed) return 'dsh 未安装'
  return r.bad ? `${r.pass} 项通过 · ${r.bad} 项异常` : '全部通过'
})
// 状态标记用文本而非 emoji / SVG：与项目现有视觉一致，三平台字体都渲染（§3.6）
function diagnoseMark(item: DshDiagnoseItem) {
  if (item.threw) return '[✗]'
  if (item.findings.some((f) => f.level === 'error')) return '[✗]'
  if (item.findings.some((f) => f.level === 'warn')) return '[!]'
  return '[✓]'
}
function diagnoseMarkCls(item: DshDiagnoseItem) {
  const m = diagnoseMark(item)
  return m === '[✗]' ? 'diag-bad' : m === '[!]' ? 'diag-warn' : 'diag-ok'
}
// 明细截断（D12）：C1 遍历 node_modules 可能产出几十行，不截断会把卡片撑爆。
// 截断只作用于渲染，缓存里存的是完整结果 —— 「复制诊断信息」拿到的仍是全量
const DIAGNOSE_SHOWN = 5
function diagnoseShown(item: DshDiagnoseItem) {
  return (item.findings || []).slice(0, DIAGNOSE_SHOWN)
}
function diagnoseRestCount(item: DshDiagnoseItem) {
  return Math.max(0, (item.findings || []).length - DIAGNOSE_SHOWN)
}
function diagnoseLevelCls(f: DshDiagnoseFinding) {
  return f.level === 'error' ? 'diag-bad' : f.level === 'warn' ? 'diag-warn' : 'diag-ok'
}
// 底部环境快照的展示口径：读不到就显示「未知」，不要留空白让人以为漏渲染
function diagnoseEnvText() {
  const e = diagnose.value && diagnose.value.env
  if (!e) return '环境信息读取失败'
  return [
    'Node ' + (e.nodeVersion || '未知'),
    'dsh ' + (e.dshVersion || '未知') + (e.dshSource ? '（' + e.dshSource + '）' : ''),
    'profile ' + (e.profile || 'web'),
    '$DSH_HOME ' + (e.home || '未知'),
  ].join(' · ')
}
// 「复制诊断信息」兜底：复制的是未截断的完整结果，用户贴给他人排查时不会缺内容。
// 环境快照一并带上，省得来回问版本
function diagnoseCopy() {
  const r = diagnose.value
  if (!r) {
    diagnoseFlash.err = true
    diagnoseFlash.msg = '还没有诊断结果，先点「重新诊断」。'
    return
  }
  const lines: string[] = []
  lines.push('dsh 只读诊断 · ' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }))
  lines.push(diagnoseEnvText())
  lines.push('结论：' + (r.ok ? '通过' : '有异常') + `（${r.pass} 项通过 · ${r.bad} 项异常）`)
  for (const item of r.results || []) {
    lines.push('')
    lines.push(diagnoseMark(item) + ' ' + item.title + (item.summary ? ' — ' + item.summary : ''))
    for (const f of item.findings || []) {
      lines.push('  [' + f.level + '] ' + f.text + (f.hint ? '（' + f.hint + '）' : ''))
    }
  }
  const text = lines.join('\n')
  const ok = services.copyText?.(text)
  diagnoseFlash.err = !ok
  diagnoseFlash.msg = ok ? '已复制完整诊断信息（含未截断明细）' : '复制失败，请手动选中复制。'
}

// —— dsh 配置转储 ——
// 一次 CLI 读取（node bin.js --profile <n> --dump-config / --dump-default-config），把「哪些层改了哪条」
// 与「生效树 vs 默认树差了什么」摊成可读列表。纯只读、不发网络请求。
const dshDump = ref<DshDumpResult | null>(null)
const dshDumpBusy = ref(false)
const dshDumpFlash: Flash = useFlash()
const dshDumpFolds = reactive({ help: false, layers: true, diff: true })
// 默认 profile 与诊断一致（'web'）：配置项化留给后续版本，避免这版就要用户先填对 profile 才看得到东西
const DSH_DUMP_PROFILE = 'web'
function dshDumpRefresh(force = false) {
  if (dshDumpBusy.value) return
  dshDumpBusy.value = true
  dshDumpFlash.msg = ''
  dshDumpFlash.err = false
  // 与诊断同理：起子进程会占住消息循环，先让 Vue 渲染出「读取中…」再发请求
  window.setTimeout(() => dshDumpRefreshRun(force), 30)
}
function dshDumpRefreshRun(force: boolean) {
  let p: Promise<DshDumpResult> | undefined
  try {
    p = services.dumpDshConfig?.({ force, profile: DSH_DUMP_PROFILE })
  } catch (err: any) {
    dshDumpFlash.err = true
    dshDumpFlash.msg = '读取失败：' + String(err?.message || err)
    dshDumpBusy.value = false
    return
  }
  if (!p) {
    dshDumpFlash.err = true
    dshDumpFlash.msg = '宿主 API 不可用'
    dshDumpBusy.value = false
    return
  }
  p.then((r) => {
    dshDump.value = r
    if (!r.ok) {
      dshDumpFlash.err = true
      dshDumpFlash.msg = r.error || '读取失败'
      return
    }
    const d = r.diff
    const diffText = d
      ? `差异 ${d.changed.length + d.added.length + d.removed.length} 处`
      : (r.diffError ? '默认树读取失败，仅展示分层' : '差异 0 处')
    dshDumpFlash.msg = (r.cached ? '60 秒内已有结果，直接复用；' : '') +
      `${r.layers?.length || 0} 层 · ${r.entries?.length || 0} 条目 · ${diffText}`
    dshDumpFlash.err = false
  }).catch((err: any) => {
    dshDumpFlash.err = true
    dshDumpFlash.msg = '读取失败：' + String(err?.message || err)
  }).finally(() => {
    dshDumpBusy.value = false
  })
}
// 折叠头摘要（与诊断卡同口径）：未展开过就只说「点击展开」，不预读
const dshDumpSummary = computed(() => {
  const r = dshDump.value
  if (!r) return '点击展开读取'
  if (!r.ok) return '读取失败'
  const d = r.diff
  const n = d ? d.changed.length + d.added.length + d.removed.length : 0
  return `${r.layers?.length || 0} 层 · 差异 ${d ? n : '—'} 处`
})
// 层卡片配色：base 灰（什么都没改）、bundle 蓝（包自带的 patch）、user 橙（用户自己写的 patch，最该被看见）
function dshDumpLayerCls(l: { kind: string }) {
  return l.kind === 'user' ? 'layer-user' : l.kind === 'bundle' ? 'layer-bundle' : 'layer-base'
}
function dshDumpLayerKindText(l: { kind: string }) {
  return l.kind === 'user' ? '用户层' : l.kind === 'bundle' ? '包内层' : '基线'
}
function dshDumpDiffText(kind: 'changed' | 'added' | 'removed') {
  return kind === 'changed' ? '被改' : kind === 'added' ? '生效树新增' : '生效树移除'
}
// 条目名可能为空（dump 里只有 id 没 name），退化成 id 显示，不要留空白
function dshDumpEntryLabel(e: { id: string; name: string }) {
  return e.name && e.name !== e.id ? `${e.name}（${e.id}）` : e.id
}
// 「被改」条目要看两边的差：把 before → after 摊开，只列真的变了的项
function dshDumpChangedNote(e: { before: { disabled: boolean; hasConfig: boolean; configKeys: string[] }; after: { disabled: boolean; hasConfig: boolean; configKeys: string[] } }) {
  const parts: string[] = []
  if (e.before.disabled !== e.after.disabled) {
    parts.push('禁用 ' + (e.before.disabled ? '是' : '否') + ' → ' + (e.after.disabled ? '是' : '否'))
  }
  const bk = e.before.configKeys.join(',')
  const ak = e.after.configKeys.join(',')
  if (bk !== ak) parts.push('config 字段 ' + (bk || '无') + ' → ' + (ak || '无'))
  // 哈希也把包名算进去了，所以两边都没变时只可能是 name 变了
  if (!parts.length) parts.push('包名或展示名不同')
  return parts.join(' · ')
}
// 「复制转储信息」：给的是完整的分层 + 差异清单（界面里层卡片按需折叠，复制不受影响）
function dshDumpCopy() {
  const r = dshDump.value
  if (!r || !r.ok) {
    dshDumpFlash.err = true
    dshDumpFlash.msg = '还没有转储结果，先点「重新读取」。'
    return
  }
  const lines: string[] = []
  lines.push('dsh 配置转储 · ' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }))
  lines.push('profile ' + (r.profile || DSH_DUMP_PROFILE) + ' · ' + (r.entries?.length || 0) + ' 条目 · ' + (r.sections || 0) + ' 分节')
  lines.push('')
  lines.push('== 分层 ==')
  // 与界面同口径：给了条目数就要给出来（以前把数字漏掉，直接接在条目名后面成了「…tool-agent-team 条目」）。
  // repeat 标记与界面统一成「 · 」而不是括号 —— 同一份数据两种写法会让人以为是两回事
  for (const l of r.layers || []) {
    // 层名优先给 source：界面为了排版宽度用的是短名（profiles/web），
    // 而复制是给人回帖用的，完整路径（…\profiles\web\cordis.patch.yml）才看得出文件在哪；
    // 两者不同时把短名附在后面，否则读者对不上界面看到的那一行
    const label = l.source && l.name && l.source !== l.name ? `${l.source}（${l.name}）` : (l.source || l.name)
    lines.push(`[${dshDumpLayerKindText(l)}] ${label} → ${l.itemCount ?? l.items?.length ?? 0} 条目 / ${l.sectionCount} 分节${l.repeat ? ' · 分节有重复列举' : ''}`)
    // 条目 id 逐行列出：界面里被截到 40 个（超出显示「…还有 N 个」），复制是给人回帖用的，给全量
    if (l.items?.length) lines.push('  ' + l.items.join(', '))
  }
  if (r.unparsed) lines.push(`（另有 ${r.unparsed} 行未识别，可能来自 dsh 输出格式变化）`)
  if (r.diff) {
    lines.push('')
    lines.push(`== 生效树 vs 默认树（改动 ${r.diff.changedTotal} · 新增 ${r.diff.addedTotal} · 移除 ${r.diff.removedTotal}）==`)
    // 分隔符与界面统一成 →（以前界面是 →、复制是 —，同一份数据两种写法容易让人以为不是同一回事）
    for (const e of r.diff.changed) {
      lines.push(`[${dshDumpDiffText('changed')}] ${dshDumpEntryLabel(e)} → ${dshDumpChangedNote(e)}`)
    }
    for (const e of r.diff.added) lines.push(`[${dshDumpDiffText('added')}] ${dshDumpEntryLabel(e)}`)
    for (const e of r.diff.removed) lines.push(`[${dshDumpDiffText('removed')}] ${dshDumpEntryLabel(e)}`)
  } else if (r.diffError) {
    lines.push('')
    lines.push('默认树读取失败，未能比对：' + r.diffError)
  }
  const ok = services.copyText?.(lines.join('\n'))
  dshDumpFlash.err = !ok
  dshDumpFlash.msg = ok ? '已复制完整转储信息' : '复制失败，请手动选中复制。'
}

// ── dsh 插件开关（计划书 §6.2 E2 / E3 合并卡）──
// 改的是用户层 patch（$DSH_HOME/profiles/web/cordis.patch.yml）：**逐条禁用/启用** + 快照还原。
// 与上面两张卡的本质区别：这是**唯一会写 dsh 文件的卡**，所以每次写入前强制建快照。
// E2 与 E3 合并成一张卡后：清单与候选统一用 dshIsolate 那份（含组装树，能看到未在 patch 里的插件），
// dshPatch 只保留「宿主返回的 patch 文件状态」（exists / file），供标题摘要与写入位置显示。
const dshPatch = ref<DshPatchListResult | null>(null)
const dshPatchBusy = ref(false)
const dshPatchFlash: Flash = useFlash()
// 逐条的操作中状态：key = id，避免一条在写时其他条也能点
const dshPatchPending = ref<string>('')
const dshPatchProfile = 'web'
const dshBackups = ref<DshBackupListResult | null>(null)
// 快照卡（还原 / 删除 / 命名 / 标记 / 保留份数）的**专属回执**，不与 dshPatchFlash 共用。
// ⚠️ 为什么不复用 dshPatchFlash（同一个文件、同一套快照，看起来该合并）：
//   ① 位置 —— 操作按钮在折起的列表里、dshPatchFlash 却画在整卡顶部，点完看不到（用户报的就是这个）；
//   ② 内容 —— dshPatchRefresh 会往 dshPatchFlash 写「patch 里已有 N 条…」，那是「插件开关」那半张卡
//      的结论，跟「这份快照还原成没成」是两件事，混在一行会互相顶掉。
const dshBackupFlash: Flash = useFlash()
const dshBackupFolds = reactive({ list: false })
// 还原是破坏性操作且不可再撤销（会把文件整体覆盖回旧内容），做两步确认
const dshRestoreConfirm = ref('')
// ── E4：命名 / known-good 标记 / 保留份数 ──
// 改名与删除都是「就地输入 / 两步确认」，同一时刻只允许一行处于编辑或待确认态
const dshRenameFor = ref('')
const dshRenameText = ref('')
const dshDeleteConfirm = ref('')
const dshKeepDraft = ref<number | null>(null)
const dshKeepBusy = ref(false)
// silent = 只更新数据、不动回执。
// ⚠️ 存在的理由（2026-09-24 用户报「快照点击恢复不知道成没成功」）：本函数一进来就清空
//    dshPatchFlash 并写「patch 里已有 N 条…」，而快照还原 / 删除 / 命名 / 清理的 finally 都会
//    调它 —— 刚写进去的「已还原 N 个文件」在同一次点击里就被这句话覆盖掉了，用户只看到
//    「patch 里已有 N 条」，自然不知道还原到底成没成。凡是「操作完顺手刷新一下清单」的调用
//    都要走 silent，回执由调用方自己负责。
function dshPatchRefresh(silent = false) {
  if (dshPatchBusy.value) return
  dshPatchBusy.value = true
  if (!silent) {
    dshPatchFlash.msg = ''
    dshPatchFlash.err = false
  }
  try {
    const r = services.dshPatchList?.({ profile: dshPatchProfile })
    if (!r) {
      dshPatchFlash.err = true
      dshPatchFlash.msg = '宿主 API 不可用'
      return
    }
    dshPatch.value = r
    if (!r.ok) {
      dshPatchFlash.err = true
      dshPatchFlash.msg = r.error || '读取失败'
      return
    }
    dshPatchFlash.msg = r.exists
      ? `这个 profile 的 patch 里已有 ${r.items?.length || 0} 条，其中 ${(r.items || []).filter((i) => i.disabled).length} 条已禁用 —— 下面的清单已按最新状态刷新。`
      : '这个 profile 还没有 patch 文件，禁用任意插件时会自动创建'
  } catch (err: any) {
    dshPatchFlash.err = true
    dshPatchFlash.msg = '读取失败：' + String(err?.message || err)
  } finally {
    dshPatchBusy.value = false
    dshBackupRefresh()
  }
}
function dshBackupRefresh() {
  try {
    const r = services.dshBackupList?.()
    if (r) dshBackups.value = r
  } catch (err: any) {
    // 快照列表读不到不该让整卡失败（禁用/启用仍可用，只是看不到历史）
    dshBackups.value = { ok: false, snapshots: [], error: String(err?.message || err) }
  } finally {
    dshBackupsLoaded.value = true
  }
}
// ⚠️ 快照列表必须**进卡就读一次 + 展开时补读一次**，不能只在展开时按 null 兜底。
// 修复的两个真实 bug：
//  ①（2026-09-24 用户报「快照功能」）dshBackups 初值是 null，而自动刷新藏在 dshPatchRefresh
//    的 finally 里 —— 进设置页后不先点「刷新」patch 清单、直接展开快照，读到 null，
//    界面显示「0 份 / 还没有快照」，而磁盘上其实躺着 7 份完好的快照。
//  ②（2026-09-24 用户报「展开快照（0 份…）/ 收起快照（1 份…）」）上一版把补读条件写成
//    `if (next && !dshBackups.value)`，可这个列表**恰好在本卡内会被写脏**：「立即备份」按钮
//    走 dshBackupCreate()，它写完刷一次列表（此时折叠着，计数是对的），而展开那一下因为
//    dshBackups 已有值就**不再补读**——于是标题停在写之前的快照数，列表体却是新的，同一处
//    出现「0 份」和「1 份」两个答案。改成「展开就一定补读」：listSnapshots 是本地 readdir，
//    代价可忽略，而「展开」正是用户要核对份数的那一刻，多读一次远好过显示一个过期的数。
const dshBackupsLoaded = ref(false)
function dshBackupToggleList() {
  const next = !dshBackupFolds.list
  dshBackupFolds.list = next
  if (next) dshBackupRefresh()
}
// 切换一条的 disabled。**宿主侧会先建快照再写**，所以这里不做「先备份」的分步交互
function dshPatchToggle(item: DshPatchItem) {
  if (dshPatchPending.value) return
  dshPatchPending.value = item.id
  dshPatchFlash.msg = ''
  dshPatchFlash.err = false
  const want = !item.disabled
  // 宿主的写前自动快照是否真的建了 —— 在 try 内赋值、在 finally 里用（`r` 是块级作用域，
  // finally 看不到），只有真建了才去重读快照目录，避免每次点开关都白读一次
  let backedUp = false
  window.setTimeout(() => {
    try {
      const r = services.dshPatchToggle?.({ profile: dshPatchProfile, id: item.id, disabled: want })
      if (!r) {
        dshPatchFlash.err = true
        dshPatchFlash.msg = '宿主 API 不可用'
        return
      }
      backedUp = !!r.backedUp
      if (!r.ok) {
        dshPatchFlash.err = true
        dshPatchFlash.msg = r.error || '写入失败'
        return
      }
      if (!r.changed) {
        dshPatchFlash.msg = `「${item.id}」已经是该状态，未改动。`
      } else {
        // V4：取消禁用（启用）不是即时生效的，必须重启 —— 这里不能笼统说「已生效」
        const tail = r.needsRestart ? '；dsh 的 patch 热重载是单向的，**启用需重启 dsh 才生效**' : ''
        dshPatchFlash.err = false
        dshPatchFlash.msg = `已${want ? '禁用' : '启用'}「${item.id}」` +
          (r.backedUp ? `（改动前已备份 ${r.snapshot}）` : '') + tail
      }
    } catch (err: any) {
      dshPatchFlash.err = true
      dshPatchFlash.msg = '写入失败：' + String(err?.message || err)
    } finally {
      dshPatchPending.value = ''
      // 刷新合并清单：状态徽章与行尾按钮都要按新的 disabled 重画
      dshIsolateRefresh()
      // ⚠️ 快照列表也要重读（2026-09-25）：开关一条 patch 时宿主会**写前自动建快照**
      //    （回执里的 `r.backedUp` / `r.snapshot` 就是它），而原先只刷了 patch 清单 ——
      //    快照区若展开着，新那份不出现，与市场安装那条链路是同一个 bug。
      //    只在真建了快照时刷，避免每次点开关都白读一次目录
      if (backedUp) dshBackupRefresh()
    }
  }, 30)
}
// 还原：第一次点变成「确认还原」，第二次才真还原
function dshBackupRestore(dirName: string) {
  if (dshRestoreConfirm.value !== dirName) {
    dshRestoreConfirm.value = dirName
    dshBackupFlash.err = false
    dshBackupFlash.msg = `再点一次「确认还原」会用 ${dirName} 覆盖当前配置（整文件覆盖，会一并回退这份文件上的其他改动）。`
    return
  }
  dshRestoreConfirm.value = ''
  dshBackupFlash.msg = ''
  try {
    const r = services.dshBackupRestore?.({ dirName })
    if (!r || !r.ok) {
      dshBackupFlash.err = true
      dshBackupFlash.msg = (r && r.error) || '还原失败'
      return
    }
    dshBackupFlash.err = false
    dshBackupFlash.msg = `已还原 ${r.written?.length || 0} 个文件` +
      (r.skipped?.length ? `（跳过 ${r.skipped.length} 个建快照时就不存在的文件）` : '') +
      '；dsh 侧需重启才完全生效。'
  } catch (err: any) {
    dshBackupFlash.err = true
    dshBackupFlash.msg = '还原失败：' + String(err?.message || err)
  } finally {
    // silent：还原的回执必须留在屏幕上，不能被刷新清单的那句话顶掉
    dshPatchRefresh(true)
  }
}
function dshBackupCreate() {
  dshBackupFlash.msg = ''
  try {
    const r = services.dshBackupCreate?.({ profile: dshPatchProfile })
    if (!r || !r.ok) {
      dshBackupFlash.err = true
      dshBackupFlash.msg = (r && r.error) || '备份失败'
      return
    }
    dshBackupFlash.err = false
    dshBackupFlash.msg = `已建快照 ${r.dirName}` + (r.missing ? `（${r.missing} 个文件当时不存在，未备）` : '')
  } catch (err: any) {
    dshBackupFlash.err = true
    dshBackupFlash.msg = '备份失败：' + String(err?.message || err)
  } finally {
    dshBackupRefresh()
  }
}
// 快照时间戳目录名 → 本地可读时间（YYYYMMDD-HHMMSS → 2026-09-22 21:42:43）
function dshBackupTime(s: DshBackupSnapshot) {
  if (s.at) {
    const d = new Date(s.at)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString('zh-CN', { hour12: false })
  }
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(s.dirName || '')
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : (s.dirName || '')
}
// ⚠️ 必须**穷举**宿主会写的每一个 reason（2026-09-25 修）：原先只映射了三档，市场那四个
//    （before-market-install / -update / -uninstall / -disable）与 before-isolate 全都落进
//    `(r || '—')` 兜底，把 `before-market-uninstall` 这种英文标识符**原样显示给用户** ——
//    快照列表里一排看不懂的英文，正是「认不出这份快照是干什么的」的直接原因。
//    新增 reason 时这里要同步加一行（宿主侧 reason 的完整清单见 dsh-backup.js 的注释与
//    settings.js 里全部 createSnapshot 调用点）。
const DSH_BACKUP_REASONS: Record<string, string> = {
  manual: '手动备份',
  'before-disable': '禁用前',
  'before-enable': '启用前',
  'before-isolate': '一键隔离前',
  'before-market-install': '市场安装前',
  'before-market-update': '市场更新前',
  'before-market-uninstall': '市场卸载前',
  'before-market-disable': '市场禁用前',
}
// 认不出的 reason 不直接抛英文标识符给用户：改成「未知来源（原值）」——
// 保留原值是为了出问题时能对着日志/磁盘目录名核对，不是给人读的
function dshBackupReasonText(r: string) {
  const key = String(r || '')
  if (!key) return '—'
  return DSH_BACKUP_REASONS[key] || '未知来源（' + key + '）'
}

// ── dsh 全量导出（与上面的「快照」是两件事，卡片也分开）──
// 快照 = 白名单 3 文件、为了回滚 patch（撤销设施）；导出 = 全量 $DSH_HOME、为了打包带走（搬运工具）。
// 两者受众与失败影响面都不同，所以不复用同一张卡、也不共用回执。
//
// 两个勾选项都存配置（dshExportCred / dshExportNoMod），存的是**用户偏好**：
// 勾了「包含凭据」下次展开还是勾着的 —— 否则每次导出都要重勾，用户会以为设置没生效。
// 开关状态直接读 cfg（与 dshMarket 那几个市场选项一样，进页面时由 loadCfg 归一化）
// 预检结果（展开即读，不写盘）。null = 还没读过
const dshExportInfo = ref<DshExportPreviewResult | null>(null)
const dshExportBusy = ref(false)
const dshExportFlash: Flash = useFlash()
// 导出成功后记住产出路径，给「打开所在文件夹」用（包可能已被用户移走，所以只当一次性凭据）
const dshExportLastPath = ref('')
// 预检：只统计不写盘。失败不弹错，只把 error 放进 dshExportInfo 由模板显示 ——
// 找不到 $DSH_HOME 是常见状态（没装 dsh 的人也会点进来），不该表现成「操作失败」
//
// ⚠️ 宿主这个 API 返回 Promise（它内部要异步探一次 3080 才知道 dsh 在不在跑），
//    所以这里必须 await/`.then`，不能再当同步值直接用 —— 否则拿到的是 Promise 对象，
//    模板里 `dshExportInfo.entries` 全是 undefined。
// 竞态：连点「重新统计」或快速切勾选会有多个探测在飞，用 token 只认最后一次
// （与 dshAsync 同一套思路），否则先发的慢探测回来会覆盖后发的快结果
const dshExportToken = { n: 0 }
function dshExportRefresh() {
  const my = ++dshExportToken.n
  dshExportInfo.value = null
  let p: any
  try {
    p = services.dshExportPreview?.({
      includeCred: cfg.dshExportCred === true,
      skipModules: cfg.dshExportNoMod !== false,
    })
  } catch (err: any) {
    dshExportInfo.value = { ok: false, error: String(err?.message || err) }
    return
  }
  if (!p) {
    dshExportInfo.value = { ok: false, error: '宿主 API 不可用' }
    return
  }
  Promise.resolve(p).then(
    (r: any) => { if (my === dshExportToken.n) dshExportInfo.value = r || { ok: false, error: '宿主 API 不可用' } },
    (err: any) => { if (my === dshExportToken.n) dshExportInfo.value = { ok: false, error: String(err?.message || err) } },
  )
}
// 勾选项变更：立刻重跑预检（条目数/体积会变），并把偏好写回配置。
// 预检要的是「勾选后的结果」，所以先写配置再刷新（dshExportRefresh 从 cfg 读）
function dshExportSetCred(v: boolean) {
  cfg.dshExportCred = v
  patchCfg({ dshExportCred: v })
  dshExportFlash.msg = ''
  dshExportRefresh()
}
function dshExportSetNoMod(v: boolean) {
  cfg.dshExportNoMod = v
  patchCfg({ dshExportNoMod: v })
  dshExportFlash.msg = ''
  dshExportRefresh()
}
function dshExportCreate() {
  if (dshExportBusy.value) return
  dshExportBusy.value = true
  dshExportFlash.msg = ''
  dshExportFlash.err = false
  // 先让出一次事件循环，让「导出中…」的禁用态先画出来 —— 打包是同步的，
  // 不这么做的话按钮会从头到尾保持可点，用户可能连点两次（第二次会撞上默认路径）
  window.setTimeout(() => {
    try {
      const r = services.dshExportCreate?.({
        includeCred: cfg.dshExportCred === true,
        skipModules: cfg.dshExportNoMod !== false,
      })
      if (!r) {
        dshExportFlash.err = true
        dshExportFlash.msg = '宿主 API 不可用'
        return
      }
      // 用户在保存对话框点了取消：不是失败，不给红字
      if (r.canceled) {
        dshExportFlash.err = false
        dshExportFlash.msg = '已取消，未生成导出包。'
        return
      }
      if (!r.ok) {
        dshExportFlash.err = true
        dshExportFlash.msg = r.error || '导出失败'
        return
      }
      dshExportLastPath.value = r.outPath || ''
      // 跳过的条目必须报出来。只说「导出成功」而实际少了几百个文件，
      // 用户要到真去恢复时才发现 —— 这正是社区「空壳包」那类问题的形态
      const skipTail = r.skippedTotal
        ? `；跳过 ${r.skippedTotal} 项（${(r.skipped || []).slice(0, 2).map((s) => s.rel).join('、')}${r.skippedTotal > 2 ? ' 等' : ''}）`
        : ''
      const credTail = r.includeCred ? '，**含凭据明文**' : ''
      dshExportFlash.err = false
      dshExportFlash.msg = `已导出 ${r.entries} 个文件（${dshExportSize(r.bytes || 0)}）到 ${r.outPath}${credTail}${skipTail}`
    } catch (err: any) {
      dshExportFlash.err = true
      dshExportFlash.msg = '导出失败：' + String(err?.message || err)
    } finally {
      dshExportBusy.value = false
    }
  }, 30)
}
function dshExportReveal() {
  const p = dshExportLastPath.value
  if (!p) return
  try {
    const r = services.dshExportReveal?.(p)
    if (r && !r.ok) {
      dshExportFlash.err = true
      dshExportFlash.msg = r.error || '打开所在文件夹失败'
    }
  } catch (err: any) {
    dshExportFlash.err = true
    dshExportFlash.msg = '打开所在文件夹失败：' + String(err?.message || err)
  }
}
// 字节数 → 人类可读。用 1024 进制（文件管理器口径），不是厂商那套 1000 进制
function dshExportSize(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`
}
// 收起态的摘要：让用户不用展开就知道「会备多少」。没读过时不写死数字（避免露一个假的 0）
const dshExportSummary = computed(() => {
  const r = dshExportInfo.value
  if (!devStatsLoaded.dshExport) return ''
  if (!r) return ''
  if (!r.ok) return '— 读取失败'
  if (!r.entries) return '— 没有可导出的文件'
  const cred = cfg.dshExportCred === true ? '、含凭据' : ''
  return `约 ${r.entries} 个文件 / ${dshExportSize(r.bytes || 0)}${cred}`
})

// ── E4：命名 / known-good 标记 / 保留份数 ──
// 改名：就地开编辑框，内容预填当前名字
function dshRenameStart(s: DshBackupSnapshot) {
  dshRenameFor.value = s.dirName
  dshRenameText.value = s.name || ''
  dshDeleteConfirm.value = ''
  dshRestoreConfirm.value = ''
}
function dshRenameCancel() {
  dshRenameFor.value = ''
  dshRenameText.value = ''
}
function dshRenameSave() {
  const dirName = dshRenameFor.value
  if (!dirName) return
  applyBackupMeta({ dirName: dirName, name: dshRenameText.value }, `已命名为「${dshRenameText.value.trim() || '（无名字）'}」`)
  dshRenameFor.value = ''
  dshRenameText.value = ''
}
// 切换 known-good：只有一份能是（宿主不强制，这里在前端把其他份取消掉，语义更清楚）
function dshToggleKnownGood(s: DshBackupSnapshot) {
  const want = !s.knownGood
  dshBackupFlash.msg = ''
  dshBackupFlash.err = false
  try {
    const r = services.dshBackupSetMeta?.({ dirName: s.dirName, knownGood: want })
    if (!r || !r.ok) {
      dshBackupFlash.err = true
      dshBackupFlash.msg = (r && r.error) || '更新标记失败'
      return
    }
    // 打上时把其他份的标记摘掉 —— 回滚目标只该有一个，否则「一键回滚」指向哪份就不明确了
    if (want) {
      const others = (dshBackups.value?.snapshots || []).filter((x) => x.knownGood && x.dirName !== s.dirName)
      for (const o of others) {
        const rr = services.dshBackupSetMeta?.({ dirName: o.dirName, knownGood: false })
        if (!rr || !rr.ok) {
          dshBackupFlash.err = true
          dshBackupFlash.msg = `已标记本份，但取消 ${o.dirName} 的旧标记失败`
        }
      }
    }
    dshBackupFlash.err = false
    dshBackupFlash.msg = want
      ? `已标记 ${s.dirName} 为「已知良好」—— 它不会被自动清理`
      : `已取消 ${s.dirName} 的「已知良好」标记`
  } catch (err: any) {
    dshBackupFlash.err = true
    dshBackupFlash.msg = '更新标记失败：' + String(err?.message || err)
  } finally {
    dshBackupRefresh()
  }
}
function applyBackupMeta(opts: { dirName: string; name?: string; knownGood?: boolean }, okMsg: string) {
  dshBackupFlash.msg = ''
  dshBackupFlash.err = false
  try {
    const r = services.dshBackupSetMeta?.(opts)
    if (!r || !r.ok) {
      dshBackupFlash.err = true
      dshBackupFlash.msg = (r && r.error) || '更新标记失败'
      return
    }
    dshBackupFlash.msg = okMsg
  } catch (err: any) {
    dshBackupFlash.err = true
    dshBackupFlash.msg = '更新标记失败：' + String(err?.message || err)
  } finally {
    dshBackupRefresh()
  }
}
// 删除：两步确认（快照删了就真没了，不经过回收站）
function dshDeleteSnapshot(dirName: string) {
  if (dshDeleteConfirm.value !== dirName) {
    dshDeleteConfirm.value = dirName
    dshRestoreConfirm.value = ''
    dshRenameFor.value = ''
    dshPatchFlash.err = false
    dshPatchFlash.msg = `再点一次「确认删除」会永久删掉 ${dirName}（不经过回收站）。`
    return
  }
  dshDeleteConfirm.value = ''
  dshBackupFlash.msg = ''
  try {
    const r = services.dshBackupRemove?.(dirName)
    if (!r || !r.ok) {
      dshBackupFlash.err = true
      dshBackupFlash.msg = (r && r.error) || '删除失败'
      return
    }
    dshBackupFlash.err = false
    dshBackupFlash.msg = `已删除 ${dirName}`
  } catch (err: any) {
    dshBackupFlash.err = true
    dshBackupFlash.msg = '删除失败：' + String(err?.message || err)
  } finally {
    dshBackupRefresh()
  }
}
// 保留份数：只写配置，不立刻删（删除由「立即清理」或下次建快照触发）
function dshSaveKeep() {
  if (dshKeepBusy.value) return
  const n = Number(dshKeepDraft.value)
  if (!Number.isFinite(n)) return
  dshKeepBusy.value = true
  dshBackupFlash.msg = ''
  dshBackupFlash.err = false
  try {
    const r = services.dshBackupSetKeep?.(Math.round(n))
    if (!r || !r.ok) {
      dshBackupFlash.err = true
      dshBackupFlash.msg = (r && r.error) || '保存失败'
      return
    }
    dshBackupFlash.err = false
    dshBackupFlash.msg = `保留份数已设为 ${r.keep}（调小不会立刻删，点「立即清理」或下次备份时生效）`
    dshKeepDraft.value = null
  } catch (err: any) {
    dshBackupFlash.err = true
    dshBackupFlash.msg = '保存失败：' + String(err?.message || err)
  } finally {
    dshKeepBusy.value = false
    dshBackupRefresh()
  }
}
function dshPruneNow() {
  dshBackupFlash.msg = ''
  dshBackupFlash.err = false
  // ⚠️ 输入框里改了数字但没点「保存」时，「立即清理」要按**眼前的数字**清，不能用已保存的旧值。
  // 修的真实 bug（2026-09-24 用户报）：早先恒用配置里的 20，于是「改成 2 → 直接点清理」
  // 什么都不删还提示「没有超出保留份数」，看着就像按钮坏了。
  const draft = dshKeepDraft.value
  const useDraft = Number.isFinite(draft as number)
  try {
    const r = services.dshBackupPrune?.(useDraft ? { keep: Math.round(draft as number) } : undefined)
    if (!r || !r.ok) {
      dshPatchFlash.err = true
      dshPatchFlash.msg = (r && r.error) || '清理失败'
      return
    }
    const n = r.removed?.length || 0
    // 用了草稿值就说明「这个数还没保存」—— 顺带提醒，否则用户以为配置也改了
    const tail = useDraft ? `（用的是输入框里的 ${r.keep}，尚未保存为默认值）` : ''
    dshBackupFlash.err = false
    dshBackupFlash.msg = n
      ? `已按保留 ${r.keep} 份清理，删掉 ${n} 份：${r.removed?.join('、')}${tail}`
      : `当前没有超出保留份数（${r.keep} 份）的快照，未删任何东西${tail}`
  } catch (err: any) {
    dshBackupFlash.err = true
    dshBackupFlash.msg = '清理失败：' + String(err?.message || err)
  } finally {
    dshBackupRefresh()
  }
}

// —— E3 一键隔离 ——
// 与 E2 的区别：E2 是「一条一条改」，E3 是「一次把勾选的都禁掉」。
// 计划书 §5.2 的红线在这里落地：**只动用户勾选的条目**，写前必须把「会改哪几行」摆出来过目。
// 一次写入的条数上限。**必须与宿主 dsh-isolate.js 的 MAX_BATCH 一致** ——
// 界面拿它做勾选量的提前拦截，宿主拿它做真正的准入判断；两边不一致就会出现
// 「界面放行、宿主拒绝」的割裂。改动时两处一起改（scripts/check-shared.mjs 会校验跨文件副本）。
const DSH_ISOLATE_MAX_BATCH = 100
// 独立回执，**不与 dshPatchFlash 共用**：两张卡操作同一份文件但是两件事，
// 共用一个 flash 会让「插件开关」卡的标题显示「已隔离：改了 N 条」（那张卡从不做隔离）——
// 界面在陈述一件不成立的事。同 secretsFlash / guideFlash 的分法（见 L78）。
const dshIsolateFlash: Flash = useFlash()
const dshIsolate = ref<DshIsolateCandidatesResult | null>(null)
const dshIsolateBusy = ref(false)
const dshIsolateFolds = reactive({ help: false, list: false })
// 勾选名单（用 Set 因为要频繁增删；渲染时再转数组）
const dshIsolatePicked = ref<Set<string>>(new Set())
// dryRun 探出来的改动计划：非空即处于「待确认」态（两步确认的第一步）
const dshIsolatePlan = ref<{ plans: DshIsolatePlan[]; changedCount: number; ids: string[] } | null>(null)

function dshIsolateRefresh() {
  if (dshIsolateBusy.value) return
  dshIsolateBusy.value = true
  dshIsolateFlash.msg = ''
  dshIsolateFlash.err = false
  // 重新读清单意味着候选可能变了，之前的勾选与待确认计划一律作废
  dshIsolatePlan.value = null
  Promise.resolve(services.dshIsolateCandidates?.({ profile: dshPatchProfile }))
    .then((r) => {
      if (!r) {
        dshIsolateFlash.err = true
        dshIsolateFlash.msg = '宿主 API 不可用'
        return
      }
      dshIsolate.value = r
      if (!r.ok) {
        dshIsolateFlash.err = true
        dshIsolateFlash.msg = r.error || '读取候选失败'
        return
      }
      dshIsolatePicked.value = new Set((r.items || []).map((it) => it.id))
      dshIsolateFlash.msg = r.treeError
        ? '组装树没读到（' + r.treeError + '），候选只含 patch 里已有的条目。'
        : `共 ${r.items?.length || 0} 个候选`
    })
    .catch((err) => {
      dshIsolateFlash.err = true
      dshIsolateFlash.msg = '读取候选失败：' + String(err?.message || err)
    })
    .then(() => {
      dshIsolateBusy.value = false
    })
}

function dshIsolateTogglePick(id: string) {
  const next = new Set(dshIsolatePicked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  dshIsolatePicked.value = next
  // 勾选一变，上一轮的「待确认计划」就过期了 —— 留着会让用户按着旧计划点确认
  dshIsolatePlan.value = null
}

function dshIsolateAll() {
  dshIsolatePicked.value = new Set((dshIsolate.value?.items || []).map((it) => it.id))
  dshIsolatePlan.value = null
}
// 只勾「确定启用中」的：已经是 disabled 的条目勾了也是 noop（一键隔离的意图是「只留我要的」）。
// 状态未知（disabled === undefined）也一并排除 —— 不知道它现在开没开，就不该替用户决定
function dshIsolateNoneDisabled() {
  const items = dshIsolate.value?.items || []
  dshIsolatePicked.value = new Set(items.filter((it) => it.disabled === false).map((it) => it.id))
  dshIsolatePlan.value = null
}

// 按档位分组的候选。实测本机 204 个候选里 199 个是 dsh 自己的框架节点
// （tool-bash / session / llm / subagent…），第三方插件只有 5 个 —— 平铺展示等于让用户
// 在 204 条里找那 5 条。分组后官方框架默认折叠，用户先看到的就是「我改过的 + 第三方插件」。
// 档位由宿主按 dump 的 bundle 归属算好（前端从 id 猜不出来），这里只负责分组与折叠。
const DSH_ISOLATE_TIERS: { key: string; label: string; hint: string; foldByDefault: boolean }[] = [
  { key: 'patched', label: '已在你 patch 里', hint: '改动就是改它自己那一行，最稳', foldByDefault: false },
  { key: 'third', label: '第三方插件', hint: '写入等于新加一条 patch；带前端界面的可能禁不掉', foldByDefault: false },
  { key: 'core', label: 'dsh 官方框架', hint: '禁掉可能让 dsh 本身不正常，确认不需要再动', foldByDefault: true },
]
// 第二种分组轴：按「启用中 / 已禁用」分。找同一批插件的当前状态时用得上 ——
// 来源分档回答「这条是谁的」，状态分档回答「这条现在开没开」，两个问题不重叠，所以做成可切换而不是二选一。
const DSH_ISOLATE_STATES: { key: string; label: string; hint: string; foldByDefault: boolean }[] = [
  { key: 'on', label: '启用中', hint: '当前没被禁用；勾选隔离会把它写进 patch', foldByDefault: false },
  { key: 'off', label: '已禁用', hint: '已经在 patch 里被禁掉了', foldByDefault: false },
  { key: 'unknown', label: '状态未知', hint: '没读到 dump 状态；可能是 dsh 组装树没读出来，重新刷新候选再看', foldByDefault: false },
]
const dshIsolateGroupBy = ref<'tier' | 'state' | 'both'>('tier')
// 状态分组：三态各自成组（undefined 归 unknown，绝不能并进 'on'）
function dshIsolateStateOf(it: { disabled?: boolean }) {
  if (it.disabled === true) return 'off'
  if (it.disabled === false) return 'on'
  return 'unknown'
}
function dshIsolateTierOf(it: { tier?: string }) {
  // 判不出来算 third，与宿主 tierOfBundle 的口径一致：宁可不折叠，也不把插件藏起来
  return it.tier || 'third'
}
const dshIsolateGroups = computed(() => {
  const items = dshIsolate.value?.items || []
  const by = dshIsolateGroupBy.value
  if (by === 'both') {
    // 第三轴「来源+状态」：来源在外、状态在内，空组整组不渲染（9 个组合全展开会有大半是空的）。
    // 组 key 用 'tier:state' 而不是裸 key —— 折叠状态是一张扁平表，'core' 这种 key 会和前两轴撞车。
    // 嵌套组沿用折叠表同理：内层 key 前面带上来源前缀，才不会和别的来源下同名状态互相干扰。
    return DSH_ISOLATE_TIERS.map((t) => ({
      ...t,
      items: [],
      children: DSH_ISOLATE_STATES.map((s) => ({
        ...s,
        key: `${t.key}:${s.key}`,
        items: items.filter((it) => dshIsolateTierOf(it) === t.key && dshIsolateStateOf(it) === s.key),
      })).filter((s) => s.items.length > 0),
    })).filter((t) => t.children.length > 0)
  }
  const specs = by === 'state' ? DSH_ISOLATE_STATES : DSH_ISOLATE_TIERS
  return specs
    .map((t) => ({
      ...t,
      children: [],
      items: items.filter((it) => (by === 'state' ? dshIsolateStateOf(it) === t.key : dshIsolateTierOf(it) === t.key)),
    }))
    .filter((g) => g.items.length > 0)
})
// 组名计数与折叠默认值按轴分别给：
// - 按来源时用 DSH_ISOLATE_TIERS / 按状态时用 DSH_ISOLATE_STATES，两者都带 foldByDefault；
// - 「来源+状态」下的内层组名取自 DSH_ISOLATE_STATES，但 key 是 'tier:state'，故从 key 里还原档位。
const dshIsolateGroupSpecs = computed(() => {
  const specs = DSH_ISOLATE_TIERS.concat(DSH_ISOLATE_STATES)
  if (dshIsolateGroupBy.value === 'both') {
    return DSH_ISOLATE_TIERS.flatMap((t) =>
      DSH_ISOLATE_STATES.map((s) => ({ ...s, key: `${t.key}:${s.key}`, foldByDefault: s.foldByDefault })),
    )
  }
  return specs.map((t) => ({ ...t, foldByDefault: t.foldByDefault }))
})
// 组头上的条数：「来源+状态」那一轴的外层组自己没有条目（items 恒空），
// 直接读 g.items.length 会显示 0 条 —— 它的条数在各子组里，要加起来报。
function dshIsolateGroupCount(g: { items: unknown[]; children?: { items: unknown[] }[] }) {
  return g.items.length + (g.children || []).reduce((n, c) => n + c.items.length, 0)
}
// 把「外层组之下要渲染的东西」统一成一层带/不带组头的行层，供模板一层 v-for 渲染完。
// 单轴：外层组自己就有条目 → 回一个 head:false 的无头层（不画组头、也不进折叠表）；
// 双轴：外层组只有子组 → 每个子组回一个 head:true 的层，折叠 key 沿用子组的 'tier:state' 复合键。
// 这样模板不必再为两种轴各写一份行渲染（原先两份逐字重复，改一处漏一处）。
function dshIsolateSubLevels(g: {
  key: string
  label: string
  hint: string
  items: DshIsolateCandidate[]
  children?: { key: string; label: string; hint: string; items: DshIsolateCandidate[] }[]
}) {
  if (g.children && g.children.length) {
    return g.children.map((c) => ({ key: c.key, label: c.label, hint: c.hint, items: c.items, head: true }))
  }
  return [{ key: g.key, label: g.label, hint: g.hint, items: g.items, head: false }]
}
// 收起态摘要：**陈述本卡的状态**，不借任何 flash 的消息。
// 早先这里读的是 dshPatchFlash.msg，于是「插件开关」卡禁用一个插件后，
// 本卡标题会显示那条消息 —— 一张从没做过隔离的卡在报告隔离结果。
const dshIsolateSummary = computed(() => {
  const r = dshIsolate.value
  if (!r) return '点击展开'
  if (!r.ok) return '读取失败'
  const n = r.items?.length || 0
  return `${n} 个插件 · 已勾 ${dshIsolatePicked.value.size} 个`
})
// 官方框架那组默认折叠，但只在本次数据首次到达时设一次 —— 用户手动展开后不能被覆盖回去
const dshIsolateTierFolds = reactive<Record<string, boolean>>({})
watch(dshIsolate, (r) => {
  if (!r?.items) return
  for (const t of dshIsolateGroupSpecs.value) {
    // 只在还没初始化过时套默认值；之后一律尊重用户的展开/折叠
    if (dshIsolateTierFolds[t.key] === undefined) dshIsolateTierFolds[t.key] = t.foldByDefault
  }
})
function dshIsolateToggleTier(key: string) {
  dshIsolateTierFolds[key] = !dshIsolateTierFolds[key]
}
function dshIsolateSetGroupBy(mode: 'tier' | 'state' | 'both') {
  dshIsolateGroupBy.value = mode
}
// 第一步：只算不写（dryRun），把「会动哪几行」摆给用户；第二步 dshIsolateConfirm 才真写
function dshIsolatePreview() {
  if (dshIsolateBusy.value) return
  const ids = Array.from(dshIsolatePicked.value)
  if (!ids.length) {
    dshIsolateFlash.err = true
    dshIsolateFlash.msg = '先勾选要保留隔离的插件。'
    return
  }
  // 超上限就拦在这里，并把话说全（勾了多少、上限多少、下一步怎么办）。
  // ⚠️ 宿主 isolateDshPlugins 对 ids.length > MAX_BATCH 是**直接拒绝**（返回 ok:false），
  // 不是截断 —— 而刷新默认全选、实测候选常有 200 条以上，于是「刷新后什么都不改直接点预览」
  // 必然弹一句「一次最多隔离 100 条」。那句错误既没说现在勾了几条、也没说该怎么办。
  if (ids.length > DSH_ISOLATE_MAX_BATCH) {
    dshIsolateFlash.err = true
    dshIsolateFlash.msg =
      `一次最多隔离 ${DSH_ISOLATE_MAX_BATCH} 条，当前勾了 ${ids.length} 条 —— ` +
      '请先点「只选启用中的」缩小范围，或在下面取消一部分勾选。'
    return
  }
  dshIsolateBusy.value = true
  dshIsolateFlash.msg = ''
  dshIsolateFlash.err = false
  try {
    const r = services.dshIsolateApply?.({ profile: dshPatchProfile, ids, dryRun: true })
    if (!r) {
      dshIsolateFlash.err = true
      dshIsolateFlash.msg = '宿主 API 不可用'
    } else if (!r.ok) {
      dshIsolateFlash.err = true
      dshIsolateFlash.msg = r.error || '无法生成改动计划'
    } else if (!r.changed) {
      dshIsolatePlan.value = null
      dshIsolateFlash.msg = `勾选的 ${ids.length} 条全都已经是禁用状态，无需改动。`
    } else {
      dshIsolatePlan.value = { plans: r.plans || [], changedCount: r.changedCount || 0, ids }
      dshIsolateFlash.msg = ''
    }
  } catch (err: any) {
    dshIsolateFlash.err = true
    dshIsolateFlash.msg = '生成改动计划失败：' + String(err?.message || err)
  } finally {
    dshIsolateBusy.value = false
  }
}

function dshIsolateConfirm() {
  const pending = dshIsolatePlan.value
  if (dshIsolateBusy.value || !pending) return
  dshIsolateBusy.value = true
  dshIsolateFlash.msg = ''
  dshIsolateFlash.err = false
  try {
    const r = services.dshIsolateApply?.({ profile: dshPatchProfile, ids: pending.ids })
    if (!r) {
      dshIsolateFlash.err = true
      dshIsolateFlash.msg = '宿主 API 不可用'
    } else if (!r.ok) {
      dshIsolateFlash.err = true
      dshIsolateFlash.msg = r.error || '写入失败'
    } else {
      dshIsolateFlash.err = false
      dshIsolateFlash.msg = `已隔离：改了 ${r.changedCount ?? 0} 条` +
        (r.backedUp ? `（快照 ${r.snapshot}）` : '') +
        '。dsh 的 patch 热重载是单向的，加 disabled 即时生效；若界面没变化请重启 dsh。'
    }
  } catch (err: any) {
    dshIsolateFlash.err = true
    dshIsolateFlash.msg = '写入失败：' + String(err?.message || err)
  } finally {
    dshIsolateBusy.value = false
    dshIsolatePlan.value = null
    dshIsolateRefresh()
  }
}

function dshIsolateActionText(action: string) {
  return action === 'update' ? '改 disabled 行'
    : action === 'insert' ? '补一行 disabled'
      : action === 'append' ? '新加条目'
        : '已是禁用（不动）'
}

// ── dsh 插件市场 ──
//
// 与其余 7 张 dev 卡的**唯一不同点：这张卡会联网**。其余卡都在 hint 里写明「不发网络请求」，
// 所以这里反过来必须显式声明「本卡会联网」—— 不能靠用户自己猜。
//
// 三段式（预览 → 确认 → 写入）与 dshIsolate 同构，但**不共用** flash/busy/plan：
// 两张卡操作的不是同一批对象（那边是 patch 条目 id，这边是 npm 包名），
// 共用会让「插件开关」卡显示「正在安装 xxx」这种不成立的话。
const dshMarketFlash: Flash = useFlash()
// 目录：DshMarketCatalogResult | null；installed：DshMarketStatusResult | null
const dshMarket = ref<DshMarketCatalogResult | null>(null)
const dshMarketStatus = ref<DshMarketStatusResult | null>(null)
const dshMarketBusy = ref(false)
// 已装状态与目录是两个独立的只读请求（前者不联网、可单独刷新），所以各自一个 busy
const dshMarketStatusBusy = ref(false)
// 目录没来时只显示空态提示，不来一大片骨架
const dshMarketLoaded = ref(false)
// 「准备浏览」的显式动作：只有点过它（加载目录 / 强制重抓 / 改来源 / 用最快的）才解锁浏览区。
// ⚠️ 为什么要有这层 gate：本卡展开只读本地、不联网，但一旦浏览区渲染出来，
// 里面的来源单选、测速、已装状态就会跟着跑（改来源会触发 dshMarketLoad）。
// 用一个显式开关把「打开卡片」与「进入市场」分开，保证**展开卡片本身零网络请求**。
const dshMarketRevealed = ref(false)
const dshMarketFolds = reactive({ help: false, filters: false, source: false, install: false })
// 分类 chip 行是否展开全部。默认收起：24 类平铺会占三行，把「范围 / 排序」挤到首屏之外，
// 而这 24 类里绝大多数人只看前几个；点 ⌄ 才铺开其余
const dshMarketCatExpand = ref(false)
// 浏览条件（纯前端，不必进宿主配置：它们是「本次找什么」，不是「这个插件怎么跑」）
const dshMarketKeyword = ref('')
const dshMarketCategory = ref('')
const dshMarketState = ref<'all' | 'installed' | 'notInstalled'>('all')
type DshMarketSort = 'stars' | 'downloads' | 'added' | 'name'
const dshMarketSort = ref<DshMarketSort>('downloads')
// 排序方向。⚠️ 各轴的**默认方向跟着轴走**（数值 / 日期默认降序、名称默认升序，同宿主
// dsh-market.js 的 SORTS_DESC），所以切换轴时要按新轴的默认方向复位 —— 否则从「名称升序」
// 切到「下载量」会变成「下载量升序」，列表中垫底的全是没人用的插件
const DSH_MARKET_SORT_DESC: Record<DshMarketSort, boolean> = { stars: true, downloads: true, added: true, name: false }
const dshMarketSortDesc = ref(DSH_MARKET_SORT_DESC.downloads)
function dshMarketPickSort(s: DshMarketSort) {
  // 再点一次当前轴 = 反向；换轴 = 用新轴的默认方向
  if (dshMarketSort.value === s) dshMarketSortDesc.value = !dshMarketSortDesc.value
  else {
    dshMarketSort.value = s
    dshMarketSortDesc.value = DSH_MARKET_SORT_DESC[s]
  }
}
// 悬停说明「点下去会发生什么」：方向无法只用箭头表达时不至于让人猜
function dshMarketSortTip(label: string): string {
  return `${label} · 点击${dshMarketSortDesc.value ? '升序' : '降序'}（再点一次反向）`
}
// 当前排序轴的中文名。列表底部的计数行要用（筛选区收起后只剩列表，得能看出按什么排的）。
// 抽成 computed 而不是内联三元：模板里写三层三元读起来没法核对，这里改轴时只改一处
const dshMarketSortLabel = computed(() => (
  dshMarketSort.value === 'stars' ? '星标'
    : dshMarketSort.value === 'added' ? '最新收录'
      : dshMarketSort.value === 'name' ? '名称'
        : '下载量'
))
// 安装/卸载的待确认计划：非空即处于「待确认」态（三段式的第二步）
const dshMarketPlan = ref<{ action: 'install' | 'uninstall' | 'remove' | 'update'; npm: string; name: string; message: string; id?: string; needsBuild?: boolean; spec?: string; version?: string; exact?: boolean; targetVersion?: string; npmName?: string; depVersion?: string; hostIncompatible?: boolean; hostForced?: boolean } | null>(null)
// 行级操作中的包名（避免同一行被连点两次）
const dshMarketPending = ref('')
// ── 安装/卸载进行中的进度反馈 ──
// ⚠️ 为什么需要：`dshMarketConfirm` 要等 npm 退出才 resolve，而 github / tarball 来源的条目
//    靠 prepare 脚本在安装时构建（clone + 装依赖 + 构建），动辄几分钟。此前界面上只有一个
//    按钮文案「写入中…」，用户看到的是一动不动的一行字，既不知道在装、也不知道进行到哪。
//    这里把「耗时计时 + npm 实时输出」回显出来，让等待可见。
//
// ⚠️ npm 输出**不需要新开通道**：runNpm 里 bindOutput 已经把 stdout/stderr 都 pushLog 进
//    state.log，而 dshStatus() 的 snapshot 会带上它（`log` 字段）。所以这里只需在 busy 期间
//    起一个更快的轮询读回来即可 —— 不动宿主 IPC 签名，也不违背「零依赖 / 最小改动」。
const dshMarketTicking = ref(false)
const dshMarketElapsed = ref(0)
const dshMarketLogTail = ref('')
// 当前正在跑的命令行（宿主快照的 lastCmd）：进度区把它显示出来，
// 用户能一眼看到「确实在跑 pnpm add …」而不是界面卡住
const dshMarketLastCmd = ref('')
// 日志区的 DOM 引用：输出是追加式的，用户关心的是**尾部**，所以每次更新后滚到底
const dshMarketLogEl = ref<HTMLElement | null>(null)
let dshMarketTickTimer = 0
const DSH_MARKET_TICK_MS = 1000
// 只留尾部若干行：npm 输出可能上千行，全塞进 DOM 既慢又没人看（真要全量有「日志」卡）
const DSH_MARKET_TAIL_LINES = 12
// pnpm 构建拦截的引导信息：github / tarball 来源靠 prepare 脚本构建，pnpm 默认拦截，
// 失败时 dsh 会给出那把带 commit hash 的 allowBuilds key。这里存下来让用户照着写一遍再重试
const dshMarketAllowBuilds = ref<{ spec: string; name: string; key: string; file: string } | null>(null)

// 更新检查结果：键是 spec（目录条目的 install spec，全目录唯一），值是判定结果。
// ⚠️ 为什么按 spec 而不是 npm 名做键：目录近半数条目 npm 为 null，只有 spec 一定存在；
//    而且宿主 marketCheckUpdates 也是按条目遍历的，spec 天然一一对应。
// 空 Map = 还没查过（此时卡片不显示任何「可更新」标记，而**不是**显示成「已是最新」）
const dshMarketUpdates = ref<Map<string, DshMarketUpdateEntry>>(new Map())
const dshMarketUpdateBusy = ref(false)
// 「只看可更新」——复用 dshMarketState 会让三选一变成四选一，语义也混（可更新必然已装），
// 所以单开一个开关，与状态筛选是**与**关系
const dshMarketOnlyUpdate = ref(false)
// 「只看 DSH 兼容」：与「只看可更新」同性质（独立开关 + 与关系）。
// ⚠️ 只有**已查到 compatible**的条目才算数 —— 没查过 / unknown 都不该被这个开关选中，
//    否则「只看兼容」会列出我们其实什么都没验证过的条目（那是在替未知背书）
const dshMarketOnlyCompat = ref(false)

// ── DSH 宿主兼容性（B 层：单条懒加载）──
//
// ⚠️ 为什么是「点了才查」而不是一进列表就查：兼容性只能从 npm manifest 的
//    peerDependencies / engines.dsh 读出来，而**目录条目本身不带这些字段**（实测近半数
//    条目连 npm 都是 null）—— 要标兼容性就必须联网。列表一次在屏上百条，
//    自动拉等于一开卡片就打上百个请求。所以 B 层只做「用户明确要看那一条」时才拉。
// ⚠️ 结论按 **spec** 存（与 dshMarketUpdates 同口径：spec 全目录唯一，npm 可能为 null）。
//    空 Map = 还没查过，此时**不显示任何标记** —— 不能默认画成「兼容」（那是编结论）。
const dshMarketCompat = ref<Map<string, DshHostCompatVerdict>>(new Map())
// 正在查的 spec 集合：同一行重复点不叠加请求，模板据此显示「检查中…」
const dshMarketCompatBusy = ref<Set<string>>(new Set())
// 拿不到宿主版本就不再逐个试：一条也判不出来，反复点只会反复空跑
const dshMarketHostVersion = ref('')
onMounted(() => {
  try {
    dshMarketHostVersion.value = String((services as any).dshHostVersion?.() || '')
  } catch (err) {
    dshMarketHostVersion.value = ''
  }
})

// 该条目能不能查兼容性：只有能剥出**裸 npm 包名**的才谈得上（github / tarball 来源
// 在 npm 上没有 manifest，查了必然 404 → 会渲染成满屏错误的「不兼容」）
function dshMarketCompatable(p: DshMarketPlugin): boolean {
  return !!p && String(p.specKind || '').toLowerCase() === 'npm'
}
function dshMarketCompatOf(p: DshMarketPlugin): DshHostCompatVerdict | null {
  return dshMarketCompat.value.get(p.spec) || null
}
// 三态各自的文案与 tooltip。unknown **不渲染成警告色**：它只代表「没查到 / 没声明」，
// 不是「不兼容」的证据（目录里近半条目没有 DSH 声明，全标红等于把市场变成红海）
function dshMarketCompatTagText(v: DshHostCompatVerdict): string {
  if (v.status === 'compatible') return 'DSH 兼容'
  if (v.status === 'incompatible') return 'DSH 不兼容'
  return '兼容性未知'
}
function dshMarketCompatTip(v: DshHostCompatVerdict): string {
  const req = String(v.requirement || '')
  if (v.status === 'compatible') return '该插件声明的 DSH 范围包含当前宿主' + (req ? '：' + req : '')
  if (v.status === 'incompatible') return '确证与当前 DSH 不兼容：该插件要求 DSH ' + (req || '（范围读不到）') + '，而当前宿主是 ' + (dshMarketHostVersion.value || '未知')
  if (v.reason === 'no-host-version') return '读不到当前宿主 DSH 版本，无法判定兼容性'
  if (v.reason === 'unavailable') return '拉取该包的 manifest 失败（网络 / 镜像问题），无法判定 —— 不代表不兼容'
  // 「拉到了，但包里一条 DSH 声明都没有」——**不是**网络问题，别让用户去修一个不存在的故障。
  // 例：@deepseek-ai/dsh-invariants 只 peer 了 @deepseek-ai/cordis（框架，不是宿主版本）
  return '该包没有声明 DSH 版本要求（manifest 里既没有 engines.dsh，也没有 @deepseek-ai/dsh* peer）'
}
function dshMarketCompatClass(v: DshHostCompatVerdict): string {
  if (v.status === 'compatible') return 'tag-compat'
  if (v.status === 'incompatible') return 'tag-incompat'
  return 'tag-unknown'
}
function dshMarketCompatChecking(p: DshMarketPlugin): boolean {
  return dshMarketCompatBusy.value.has(p.spec)
}
// 单条懒加载：点「检查兼容」才发请求（宿主内部还会去重 + 走 24h 缓存）
function dshMarketCheckCompat(p: DshMarketPlugin) {
  if (!p || dshMarketCompatChecking(p) || dshMarketCompat.value.has(p.spec)) return
  const pkg = String(p.npm || '').trim()
  if (!pkg) return
  dshMarketCompatBusy.value = new Set(dshMarketCompatBusy.value).add(p.spec)
  Promise.resolve((services as any).dshHostCompatCheck?.({ packages: [pkg] }))
    .then((r: DshHostCompatCheckResult | undefined) => {
      const v = r && r.results ? r.results[pkg] : null
      const next = new Map(dshMarketCompat.value)
      // ⚠️ 宿主 API 缺失 / 返回空也要落一条 unknown：否则按钮点了没反应，用户会以为坏了
      next.set(p.spec, v || { status: 'unknown', reason: 'unavailable', requirement: '', package: pkg })
      dshMarketCompat.value = next
    })
    .catch(() => {
      const next = new Map(dshMarketCompat.value)
      next.set(p.spec, { status: 'unknown', reason: 'unavailable', requirement: '', package: pkg })
      dshMarketCompat.value = next
    })
    .then(() => {
      const s = new Set(dshMarketCompatBusy.value)
      s.delete(p.spec)
      dshMarketCompatBusy.value = s
    })
}

// ── 回源 registry 查「官方最新版」（**卡片顶部一个按钮，纯手动，会联网**）──
//
// ⚠️ 为什么需要它：目录（dsh-plugin-catalog / 官方 plugins.json）是**每日快照**。实测
//    2026-09-25：目录停在 2026.924.4355（9/24），dshmarket 那条写着 1.61.0，而 registry 上
//    早已是 1.65.1 —— 界面上「可更新」的判断全部基于目录，于是「目录说已是目录最新版」
//    并不等于「你已是最新版」。要确证只能问 registry。
// ⚠️ 但**不进自动链路**：自动查就是一开卡片打几十上百个请求（与「刷新目录默认零网络」
//    同一考量）。所以做成一个按钮，用户点了才查。
// ⚠️ 查询范围 = **当前分页展示的条目**（用户选的「当前列表」口径）：一页 80 条封顶，
//    翻页后由 watch 清掉旧结论，避免「查了第 1 页、翻到第 3 页却看到第 1 页的数」。
// 结论按 spec 存（与 dshMarketUpdates / dshMarketCompat 同口径）。
const dshMarketLatest = ref<Map<string, DshMarketRegistryLatestEntry>>(new Map())
const dshMarketLatestBusy = ref(false)
// 本轮查询的元信息（按钮旁汇总展示用）。null = 还没查过
const dshMarketLatestAt = ref(0)
const dshMarketLatestFail = ref(0)

// 能不能查：只有能剥出**裸 npm 包名**的条目才谈得上（github / tarball 来源在 npm 上没有
// manifest，查了必然 404 —— 与 dshMarketCompatable 同一口径）
function dshMarketLatestable(p: DshMarketPlugin): boolean {
  return !!p && String(p.specKind || '').toLowerCase() === 'npm' && !!String(p.npm || '').trim()
}
// 能不能「装这一版」：比 dshMarketLatestable 更严 —— 额外要求**宿主剥出的 npm 字段就是裸包名**。
//
// ⚠️ 为什么两者要分开（2026-09-25 修）：`dsh-web#packages/dsh-web-all` 这种 subpath 形态
//    过了 dshMarketLatestable（能查出官方版本），但它的 `npm` 字段并非可直接 add 的 npm 包名，
//    「装这一版」点下去**必然失败** —— 宿主只对 npm 来源拼 `pkg@版本`，其余一律拒绝，
//    且 `#` / 路径分隔符不可能出现在合法包名里（`validPkgName` 的正则拒掉）。
//    故清单里这类条目**只告知、不给按钮**。
function dshMarketExactable(p: DshMarketPlugin): boolean {
  const name = String(p?.npm || '').trim()
  // 裸包名（含 scoped）里不该出现 `#` / `/` 以外的路径痕迹；`#` 一并拒掉（subpath 的标记）
  return dshMarketLatestable(p) && !!name && !name.includes('#') && !name.includes('\\')
}
function dshMarketLatestOf(p: DshMarketPlugin): DshMarketRegistryLatestEntry | null {
  return dshMarketLatest.value.get(String(p.spec || '')) || null
}

// 滞后判据的基准版本 = **实装版本优先**，实装读不到才回落目录版本。
//
// ⚠️ 为什么基准必须是实装版本（2026-09-25 修）：目录是每日快照，实测会**落后于用户机器上
//    已装的版本**（实装 1.62.0，目录还写 1.61.0）。此时若拿目录当基准，界面会显示
//    「目录 v1.61.0 → 官方 v1.65.1」，读起来像「要从 1.61 升到 1.65」，而用户真实路径是
//    「已装 1.62.0 → 官方 1.65.1」—— 基准错了，结论就不可信
function dshMarketBaseVer(p: DshMarketPlugin): string {
  const realized = String(dshMarketUpdateOf(p)?.installed || '')
  if (realized) return realized
  return String(dshMarketUpdateOf(p)?.latest || '')
}

// 「快照滞后」判据：查到的 registry 版本 **高于基准版本**（基准见上条）。
// 取不到基准时不算滞后（宁可漏报也不误报 —— 与宿主 updateState 的保守口径一致）
function dshMarketLatestStale(p: DshMarketPlugin): boolean {
  const v = dshMarketLatestOf(p)
  if (!v || v.error) return false
  const reg = String(v.version || '')
  const base = dshMarketBaseVer(p)
  if (!reg || !base) return false
  return cmpVerText(reg, base) > 0
}

// 本轮可查条目（当前分页 ∩ 能查的）。按钮的 disabled 与提示都看它
const dshMarketLatestTargets = computed(() => dshMarketPageList.value.filter((p) => dshMarketLatestable(p)))

// 查当前分页。重复点会重查（registry 的 latest 会变，这是合理诉求）；
// 宿主侧 5 分钟缓存保证短时间内连点不出站
function dshMarketCheckLatestPage() {
  if (dshMarketLatestBusy.value) return
  const targets = dshMarketLatestTargets.value
  if (!targets.length) {
    dshMarketFlash.err = true
    dshMarketFlash.msg = '当前页没有可查的条目（只有 npm 来源的插件能回源查版本）。'
    return
  }
  // 同一个包被多条条目引用时只查一次（宿主也会去重，这里先减一轮 payload）
  const items: { pkg: string; key: string }[] = []
  const seen = new Set<string>()
  for (const p of targets) {
    const spec = String(p.spec || '')
    const pkg = String(p.npm || '').trim()
    if (!spec || !pkg || seen.has(pkg)) continue
    seen.add(pkg)
    items.push({ pkg: pkg, key: spec })
  }
  dshMarketLatestBusy.value = true
  Promise.resolve((services as any).dshMarketRegistryLatest?.({ items: items }))
    .then((r: DshMarketRegistryLatestResult | undefined) => {
      // ⚠️ 宿主 API 缺失也要落一条带 error 的结论：否则按钮点了毫无反应，用户会以为坏了
      const results = (r && r.results) || {}
      const next = new Map(dshMarketLatest.value)
      let fail = 0
      for (const p of targets) {
        const spec = String(p.spec || '')
        const pkg = String(p.npm || '').trim()
        const v = results[spec]
        // 同包多条目时宿主只回了其中一条（按去重后的 key），把结论补给其余同包条目
        const shared = v || Object.values(results).find((x) => x && x.pkg === pkg)
        const entry = shared || { pkg: pkg, version: '', error: '宿主未返回结果', cached: false }
        if (entry.error || !entry.version) fail++
        next.set(spec, entry)
      }
      dshMarketLatest.value = next
      dshMarketLatestAt.value = Date.now()
      dshMarketLatestFail.value = fail
      dshMarketFlash.err = false
      const stale = targets.filter((p) => dshMarketLatestStale(p)).length
      dshMarketFlash.msg = stale
        ? `查到 ${stale} 个插件的官方版本比你机器上的新（目录是每日快照，会滞后）—— 已按行标出。`
        : `当前页 ${targets.length} 个插件都查到了，没有发现比你机器上更新的版本。`
    })
    .catch((err: any) => {
      dshMarketFlash.err = true
      dshMarketFlash.msg = '查官方最新版失败：' + String(err?.message || err)
    })
    .then(() => {
      dshMarketLatestBusy.value = false
    })
}

// 按钮旁的汇总文案。四种情况必须分清，尤其 ① —— 那正是查这个按钮的意义
function dshMarketLatestSummary(): string {
  if (!dshMarketLatestAt.value) return ''
  const targets = dshMarketLatestTargets.value
  if (!targets.length) return ''
  const stale = targets.filter((p) => dshMarketLatestStale(p)).length
  const fail = dshMarketLatestFail.value
  const parts: string[] = []
  if (stale) parts.push(`${stale} 个有新版本`)
  else parts.push('未发现新版本')
  if (fail) parts.push(`${fail} 个没查到`)
  return parts.join(' · ')
}
// 本轮里「官方版本 > 基准版本」的条目 —— 顶部汇总区逐个列出。
// 基准见 dshMarketBaseVer（实装优先），故文案说的是「已装 vX → 官方 vY」而不是目录版本
const dshMarketLatestStales = computed(() => dshMarketLatestTargets.value.filter((p) => dshMarketLatestStale(p)))

// 某一行的「官方最新 vX」短文案（在顶部汇总区里用）
function dshMarketLatestText(p: DshMarketPlugin): string {
  const v = dshMarketLatestOf(p)
  if (!v) return ''
  if (v.error || !v.version) return '未查到'
  return 'v' + v.version
}
// 汇总区某一条的完整说明（title）
function dshMarketLatestTip(p: DshMarketPlugin): string {
  const v = dshMarketLatestOf(p)
  if (!v) return ''
  if (v.error) return '从 npm registry 拉该包最新版本失败：' + v.error + ' —— 不代表已是最新版'
  const reg = String(v.version || '')
  const up = dshMarketUpdateOf(p)
  const realized = String(up?.installed || '')
  const cat = String(up?.latest || '')
  const base = 'npm registry 上的最新版本是 v' + reg
    + (v.cached ? '（5 分钟内查过，直接用的缓存）' : '')
  // 基准是「实装版本优先」，与 dshMarketBaseVer 同口径；有实装就只说实装，别拿更旧的目录版本搅混
  const mine = realized || cat
  if (!mine) return base
  if (cmpVerText(reg, mine) > 0) {
    return base + '，而你机器上是 v' + mine
      + (realized ? '（实装）' : '（目录记录）')
      + ' —— 目录（dsh-plugin-catalog）是每日快照，会落后于实际发版。'
      + '此时以 registry 的 v' + reg + ' 为准'
  }
  return base + '，与你机器上的 v' + mine + ' 一致'
}

// 精确装到查到的这一版（`pkg@x.y.z`）。
//
// ⚠️ 为什么不复用 dshMarketPreviewUpdate / dshMarketConfirm 那条链路：那条按**目录 spec**
//    重装，而 profile 的 pnpm-lock.yaml 锁着 `specifier: ^1.62.0 / version: 1.62.0` ——
//    pnpm 会命中锁文件、原样复用旧版，等于白跑（这正是「更新」按钮装不到 1.65.1 的原因）。
//    只有把确切版本拼进 spec（`dshmarket@1.65.1`）才会改写 lock。
function dshMarketPreviewInstallExact(p: DshMarketPlugin, force = false) {
  const v = dshMarketLatestOf(p)
  if (dshMarketBusy.value || !v || v.error || !v.version) return
  const pkg = String(p.npm || '').trim()
  if (!pkg) return
  dshMarketBusy.value = true
  dshMarketFlash.msg = ''
  dshMarketFlash.err = false
  Promise.resolve(services.dshMarketInstall?.({
    profile: dshPatchProfile,
    spec: p.spec,
    npm: pkg,
    name: p.name,
    exact: true,
    targetVersion: v.version,
    dryRun: true,
    force,
  }))
    .then((r) => {
      if (!r) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = '宿主 API 不可用'
      } else if (!r.ok) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = r.error || '无法生成安装计划'
        // 同 install 链路：拦下也给一条出路（点的还是「装这一版」，由 dshMarketForcePlan 按 exact 分派）
        if (r.hostIncompatible) {
          dshMarketPlan.value = {
            action: 'install',
            npm: p.spec,
            name: p.name,
            message: '',
            spec: p.spec,
            npmName: pkg,
            targetVersion: v.version,
            exact: true,
            hostIncompatible: true,
            hostForced: false,
          }
        }
      } else if (!r.changed) {
        dshMarketPlan.value = null
        dshMarketFlash.msg = r.message || '已经是最新，无需安装。'
      } else {
        // ⚠️ 走 install 分支（不是 update）：宿主那边 exact 拼的是 `pkg@版本` 的 add 语义，
        //    与「按 spec 覆盖重装」是两条路，用 install 才对得上宿主实际执行的命令
        dshMarketPlan.value = {
          action: 'install',
          npm: p.spec,
          name: p.name,
          message: r.message || '',
          spec: p.spec,
          npmName: pkg,
          targetVersion: v.version,
          exact: true,
          // ⚠️ 与另外两条入口同口径（2026-09-25）：dryRun 永远不带 force，所以这里拿到的
          //    hostForced 必为 false —— 用户点了「仍要强制安装」之后**重新** dryRun 一次，
          //    那次带了 force，卡片才会切到「你正在强行装…」的措辞
          hostIncompatible: !!r.hostIncompatible,
          hostForced: !!r.hostForced,
        }
      }
    })
    .catch((err: any) => {
      dshMarketFlash.err = true
      dshMarketFlash.msg = '生成安装计划失败：' + String(err?.message || err)
    })
    .then(() => {
      dshMarketBusy.value = false
    })
}

// 版本号比较只为「registry 是否比目录新」这一个判断服务。解析不出来时返回 0（不报滞后），
// 宁可漏报也不误报 —— 与宿主 updateState 的保守口径一致
function cmpVerText(a: string, b: string): number {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

// 镜像源测速结果（按延迟升序，失败的排最后）。空数组 = 还没测过
const dshMarketPing = ref<DshMarketPingEntry[]>([])
const dshMarketPingBusy = ref(false)
// 按 registry URL 取测速结果（源列表不长，线性找足够；模板里别写重复的 find 链）
function dshMarketPingOf(url: string) {
  return dshMarketPing.value.find((x) => x.url === url)
}

// 目录上的可选分类：保留目录给的顺序（它自己排的序比我们重排更合理），
// 并把「当前选中但已不在目录里」的情况一并考虑 —— 见 dshMarketCategories 的用法
const dshMarketCategories = computed(() => {
  const cats = dshMarket.value?.categories || {}
  return Object.keys(cats).map((k) => ({ key: k, zh: cats[k]?.zh || '', en: cats[k]?.en || '' }))
})

// 每个分类下的条数。⚠️ 用来在分类 chip 上标数字，让用户点之前就知道哪类是空的
// （有些分类目录里只挂了一两条，点进去看到空列表会以为坏了）。
// 只统计**目录全量**，不随当前筛选变化 —— 数字若随筛选跳动，用户会误以为目录在变
const dshMarketCategoryCount = computed(() => {
  const map: Record<string, number> = {}
  for (const p of dshMarket.value?.plugins || []) {
    const c = String(p.category || '')
    if (!c) continue
    map[c] = (map[c] || 0) + 1
  }
  return map
})

// 分类 chip 的排布：精选出的几个常用类落位到前面，其余折在 ⌄ 后面。
//
// ⚠️ 三条约束，决定了这里是「排序 + 择优 + 折叠」而不是直接 slice：
//   1. **选中的分类必须留在可见段**，哪怕它条数少。否则用户点开某个冷门分类后，
//      折叠一收起，那颗高亮的 chip 连同「怎么取消」一起消失 —— 筛选还生效着，界面上却找不到出口。
//   2. 择优依据是**条数**而不是位置。目录 categories 的键序是「目录自己排的」，
//      跟常用度无关（可能按拼音/字母），直接 slice 会把没人用的类留在前排、把大类的挤走。
//   3. 条数只是「有多大」的代理，不等于「多常用」—— 目录里 4000 多条压在某几类上时，
//      光按条数排前 8 名仍是又长又杂。所以再加上**首屏名额**与**占比**两道闸，见下。
//
// 首屏只留 DSH_MARKET_CAT_TOP 个 —— 这个数别调大：chip 行在 .iso-axis 里是 flex-wrap，
// 每多两个就多占一行，下面的「范围 / 排序」区域会被顶出可视区。
// ⚠️ 名额是**每行凑齐**而不是齐头截断：按每行能放几个分组（见 dshMarketCatsPerRow），
// 一行放得下就一行放完，放不下才断到下一行 —— 齐头截断会在首屏末尾留一小截孤零零的 chip。
//
// 返回 { top, rest, restCount }：top 常显，rest 只在展开时渲染。
// 计数为 0 的分类无条件归入 rest（它们点了会得到空列表，模板里另有 :disabled 兜一层）
const DSH_MARKET_CAT_TOP = 5
// 占比闸：条数不到目录的 1% 就够不上「常用」（4000 条目录下约 40 条）。
// 目录小的时候（比如不到 200 条）1% 会退化成个位数，所以下限固定 3 条，
// 免得目录一变薄就一个分类都精选不出来
const DSH_MARKET_CAT_MIN_RATIO = 0.01
const DSH_MARKET_CAT_MIN_COUNT = 3
// 首屏一行大概放得下的分类 chip 数（按「两字中文名（数字）」估宽度，见模板注释）。
// 折叠开关要占一个位置，所以算行容量时先扣掉它
const DSH_MARKET_CATS_PER_ROW = 6
const dshMarketCategorySplit = computed(() => {
  const count = dshMarketCategoryCount.value
  const n = (k: string) => count[k] || 0
  const total = dshMarket.value?.plugins?.length || 0
  const floor = Math.max(DSH_MARKET_CAT_MIN_COUNT, Math.ceil(total * DSH_MARKET_CAT_MIN_RATIO))
  // 三档：选中的（必留）→ 有计数的（择优竞争前 N 个）→ 空的（必折）
  const selected = dshMarketCategories.value.filter((c) => c.key === dshMarketCategory.value)
  const usable = dshMarketCategories.value.filter((c) => c.key !== dshMarketCategory.value && n(c.key) > 0)
  const empty = dshMarketCategories.value.filter((c) => c.key !== dshMarketCategory.value && n(c.key) === 0)
  // 同条数时按目录原序（sort 是稳定的，V8 / 各引擎均已保证）
  usable.sort((a, b) => n(b.key) - n(a.key))
  // 择优：先过占比闸（条数太少的直接出局），再取前几名
  const pickable = usable.filter((c) => n(c.key) >= floor)
  // ⚠️ 一个都够不上门槛时不能把首屏清空成只剩「全部」—— 那等于把分类筛选整个藏起来。
  //    退回「按条数取前 N 名」，宁可甄别不准也不能没得选
  if (!pickable.length) pickable.push(...usable)
  const room = Math.max(0, DSH_MARKET_CAT_TOP - selected.length) // 选中项占掉的名额要扣掉
  const chosen = pickable.slice(0, room)
  // 行容量：选中项已占掉若干位置；若折叠开关会出现，再扣掉它的一个位置。
  // 剩下放得下的名额用来从「够得上门槛但没进前 N 名」的里按条数补 —— 补进来的仍是常用类，
  // 只是名次靠后；补不满一行就不补（宁少不挤）
  const restTotal = usable.length - chosen.length + empty.length
  const slots = DSH_MARKET_CATS_PER_ROW - selected.length - (restTotal > 0 ? 1 : 0)
  const extra = Math.min(slots - chosen.length, pickable.length - chosen.length)
  if (extra > 0) chosen.push(...pickable.slice(chosen.length, chosen.length + extra))
  const top = selected.concat(chosen).sort((a, b) => n(b.key) - n(a.key))
  return { top, rest: usable.slice(chosen.length).concat(empty), restCount: restTotal }
})

// 分类 key → 中文名。⚠️ 别在模板里写 dshMarketCategories.find(...)：
// 每条都要对数组做一次线性查找，一页 80 条 × 每次重渲染就是 80 次（同 dshMarketHitMap
// 那段注释讲的道理）。这里一次建成 Record，模板 O(1) 取
const dshMarketCategoryZh = computed(() => {
  const out: Record<string, string> = {}
  for (const c of dshMarketCategories.value) out[c.key] = c.zh || c.en || c.key
  return out
})
// 取分类显示名。空分类回落到「未分类」（目录没给 category 的条目）
function dshMarketCategoryText(key: string): string {
  const k = String(key || '')
  if (!k) return '未分类'
  return dshMarketCategoryZh.value[k] || k
}

// 每条的已装状态，按**目录 spec** 索引。
// ⚠️ 为什么用 spec 当键而**不是**数组下标（2026-09-25 修，用户报「切到「范围=已装」后
//    卡片只剩「安装」按钮」）：这里原先返回的是 `(DshMarketInstalledEntry|null)[]`，
//    与 `dshMarket.value.plugins` **下标对齐**，模板里按 `(p, pi)` 的 `pi` 去取。
//    但模板遍历的是 `dshMarketPageList` —— 它是 `dshMarketList`（**筛选 + 排序**后）再切片。
//    两套下标只有在「不筛不排」时才碰巧一致：一旦筛选，`pi` 是筛选后列表的位置，
//    却被拿去索引原始目录数组，取到的是**另一条插件的已装状态**。
//    「范围=已装」把 4311 条筛成 5 条，`pi` 变成 0..4，于是拿原始目录第 0..4 条
//    （排序最前的那几条，恰好都没装）去判 → 卡片上的「已装」徽章错乱、按钮整块消失。
//    spec 是条目的稳定身份（`dshMarketUpdateOf` 也是按 spec 存的，同一套道理），
//    换成它之后下标错位这类问题从根上不可能再出现。
// ⚠️ 别在模板里直接调 dshMarketHitOf：单个条目的模板要读它 7 次（已装 / 已禁用 / 未写 patch /
// 按钮 disabled…），一次列表在屏上就上百条 → 几千次调用，而每次都要重建候选名数组 +
// 对 package.json 的全部键做二次遍历。实测单次约 60ms，乘上渲染趟数就是明显的卡顿。
const dshMarketHitMap = computed(() => {
  const arr = dshMarket.value?.plugins || []
  const out = new Map<string, DshMarketInstalledEntry>()
  for (const p of arr) {
    const hit = dshMarketHitOf(p)
    if (hit && p.spec) out.set(String(p.spec), hit)
  }
  return out
})
function dshMarketHitAt(p: DshMarketPlugin): DshMarketInstalledEntry | null {
  return dshMarketHitMap.value.get(String(p.spec || '')) || null
}

// 按 spec 取更新判定结果（模板里一行会读好几次，走 Map 而不是每次 find 一遍 2000 条）
function dshMarketUpdateOf(p: DshMarketPlugin): DshMarketUpdateEntry | null {
  return dshMarketUpdates.value.get(String(p.spec || '')) || null
}
// 该条目是否**确定**有新版。⚠️ 必须是 === 'update'：'unknown' 是「目录没给版本、比不了」，
// 不能当成「有更新」—— 那会把 2033 条 github/tarball 条目全标成可更新
function dshMarketHasUpdate(p: DshMarketPlugin): boolean {
  return dshMarketUpdateOf(p)?.state === 'update'
}

// 「已装 → 目录」的展示文案。
// ⚠️ v 前缀只加在**能确定是版本号**的一侧：实装版本是裸 `0.5.11`，加 v 没问题；
//    退回显示声明范围时是 `^0.5.11`，加 v 会变成 `v^0.5.11` 这种不成立的写法，
//    所以那一档前面带「声明」二字、不加 v。
function dshMarketVersionText(p: DshMarketPlugin): string {
  const u = dshMarketUpdateOf(p)
  if (!u) return ''
  const latest = String(u.latest || '')
  if (!latest) return ''
  if (u.installed) return 'v' + u.installed + ' → v' + latest
  return '声明 ' + (u.range || '?') + ' → v' + latest
}

// 版本条与「可更新」徽章的悬停说明：把判定依据讲清楚（尤其退回范围判定那一档，
// 用户看到的是范围而不是具体版本，不说清会被当成 bug）
function dshMarketUpdateTip(p: DshMarketPlugin): string {
  const u = dshMarketUpdateOf(p)
  if (!u) return ''
  if (u.basis === 'realized') {
    return '已安装 v' + u.installed + '（读自 node_modules），目录提供 v' + u.latest
  }
  if (u.basis === 'range') {
    return '读不到实装版本，按 package.json 的声明范围判断：' + u.range + '，目录提供 v' + u.latest
  }
  return '目录提供 v' + u.latest
}

// 单据卡要按动作找不同的入口（install / exact / update），而那几个预览函数收的是**目录条目**
// （要 p.spec / p.npm / p.needsBuild），plan 里没存这些。这里按 plan 里记的 spec 反查回条目。
//
// ⚠️ 为什么要反查而不是把整个 p 存进 plan：plan 的每个字段都是「宿主真写要用到的入参」或
//    「单据要展示的事实」，塞进去一个完整目录条目会让这个 ref 变成半个缓存，之后谁都能往里塞东西。
//    反查的代价是 O(条目数)，只在点「仍要强制安装」时算一次，可以接受。
// ⚠️ 只给 **handler** 用，不给模板用：模板里 `v-if` 挡不住 TS 的 null 窄化，
//    在模板上直接传它会报 TS2345（computed 的可空类型跨不过模板的 v-if）。
//    所以按钮只绑 handler，由 handler 自己判空并兜一句提示，用户不会遇到「点了没反应」。
function dshMarketPlanPlugin(): DshMarketPlugin | null {
  const plan = dshMarketPlan.value
  if (!plan) return null
  const key = String(plan.spec || plan.npm || '')
  if (!key) return null
  return dshMarketList.value.find((x) => String(x.spec || '') === key) || null
}

// 已装包名集合。⚠️ 目录条目的 npm 是完整包名（@scope/x），而宿主 installed 的键
// 可能是短名（x）—— 所以要按「完整名优先、短名兜底」判，不能直接 has(npm)。
// 这与宿主 dsh-market.matchInstalled 是**同一套口径**，两边的判法必须一致，
// 否则会出现「卡片说未安装、宿主说已经装了」这种自相矛盾。
function dshMarketInstalledOf(npm: string): DshMarketInstalledEntry | null {
  const map = dshMarketStatus.value?.installed
  if (!map || !npm) return null
  if (map[npm]) return map[npm]
  const slash = npm.indexOf('/')
  const short = slash >= 0 ? npm.slice(slash + 1) : npm
  return map[short] || null
}

// ── 已装包清单（「卸载」的兜底入口，2026-09-25）──
// 为什么需要它：卸载按钮原先只长在市场**目录条目**上，于是两类包永远找不到入口 ——
//   · 已装但不在目录里（市场列表完全由 catalog 驱动，这类包连行都没有）
//   · 在目录里但 install 字段认不出（specKind 为空，按钮整块不渲染）
// 而「装了什么」的权威真相是 profile/package.json + patch，与目录无关 ——
// 宿主 marketStatus 返回的 installed 正是这两者的合并（见 dsh-market.js 的 installedMap），
// 早先界面只拿它去**匹配目录条目**，从没把这份表本身列出来。这里把表列出来补齐盲区。
//
// 排序：先按「在依赖里」分组（可彻底删除的在前），组内按名字。inDeps 决定有没有「彻底删除」，
// 排一起便于一眼看清哪些能真删。
//
// ⚠️ 数据从哪来（2026-09-25 核实）：`dshMarketStatus` 的**唯一**触发点就是展开本卡时
//    `toggleDevCard('dshMarket')` → `dshMarketRefreshStatus()`（见 toggleDevCard 的注释），
//    所以这份清单在「卡片一展开」就有数据，不依赖「进入市场」或目录加载。
//    ⚠️ 别在这里再加一个 `watch(devFolds.dshMarket)` 的兜底 —— 那条路已经存在，重复触发
//    只会白多一次 `dshMarketCheckUpdates`（`dshMarketRefreshStatus` 里会调它）。
const dshMarketInstalledList = computed(() => {
  const map = dshMarketStatus.value?.installed
  if (!map) return []
  const keys = Object.keys(map)
  keys.sort((a, b) => {
    const da = map[a]?.inDeps ? 0 : 1
    const db = map[b]?.inDeps ? 0 : 1
    if (da !== db) return da - db
    return a.localeCompare(b)
  })
  return keys.map((k) => ({ key: k, hit: map[k] }))
})

const dshMarketInstalledFold = ref(true)

// 已装包折叠区的摘要：能删的（在 dependencies 里）单列一个数，因为那才是「彻底删除」的适用范围
const dshMarketInstalledSummary = computed(() => {
  const list = dshMarketInstalledList.value
  if (!list.length) return '暂无已装包'
  const removable = list.filter((x) => x.hit?.inDeps).length
  return `${list.length} 个已装包 · 其中 ${removable} 个可彻底删除`
})

// 目录里没有这条包时的说明。
//
// ⚠️ 为什么单独说清楚（2026-09-25 用户反馈「更明确点」）：市场目录只渲染目录里有的条目，
//    已装但目录里没有的包（自装的、作者删了词条的、github/tarball 装的）在这里**只有
//    「禁用 / 彻底删除」两把钥匙** —— 没有「安装 / 更新」，也看不到有没有新版。
//    用户在这个清单里找不到「更新」会以为界面漏了，所以直说缺的是什么、为什么。
// 判据与目录列表同源（dshMarketHitOf / spec 反查），避免「目录里明明有、这里却说没有」
//
// ⚠️ 必须**预计算**（2026-09-25 修，用户报「点击已装包（38个已装包·其中5个可彻底删除）
//    导致 uTools 插件卡死」）：逐行在模板里现算，代价是 O(目录条数 × 已装包数 × 每行调用次数)
//    —— 目录 4183 条、已装 38 个、模板里同一格调 **两次**（v-if 一次、插值一次），
//    约 32 万次比较，而每次比较还要先重建候选名数组 + 对 package.json 的全部键做二次遍历。
//    这不是「有点慢」而是**展开即卡死**。故改成一个 computed 预先算好「哪些已装包在目录里」，
//    之后再按包名查表 —— 与 dshMarketHitMap 是同一套做法（该 computed 的注释已警告过
//    不要逐次调用，此处是那个坑的第二次踩中）。
// 反向查找为什么可行：目录条目与已装条目是**同一批对象**（dshMarketHitOf 的比较就是
//    「引用相等」），所以拿每个目录条目的命中结果倒推「已装包在目录里」是等价且只需一遍的。
const dshMarketInstalledInCatalog = computed(() => {
  const cat = dshMarket.value?.plugins
  if (!cat || !cat.length) return null
  const set = new Set<unknown>()
  for (const p of cat) {
    const hit = dshMarketHitOf(p)
    if (hit) set.add(hit)
  }
  return set
})

const dshMarketInstalledNoteMap = computed(() => {
  const list = dshMarketInstalledList.value
  const out: Record<string, string> = {}
  if (!list.length) return out
  const inCat = dshMarketInstalledInCatalog.value
  if (!inCat) {
    for (const row of list) out[row.key] = '目录还没加载 —— 加载后这里会显示它有没有新版'
    return out
  }
  for (const row of list) {
    if (!inCat.has(row.hit)) out[row.key] = '目录里没有这个包 —— 没有「更新 / 装这一版」可用，只能禁用或彻底删除'
  }
  return out
})

// 按 install spec 反查已装（npm 字段为 null 的那近半数条目靠这个）。
// 与宿主 dsh-market.matchInstalledBySpec 同一套候选规则 —— 两边口径必须一致，
// 否则会出现「卡片说未安装、宿主 dryRun 说已装」
function dshMarketInstalledBySpec(p: DshMarketPlugin): DshMarketInstalledEntry | null {
  const map = dshMarketStatus.value?.installed
  const spec = String(p.spec || '')
  if (!map || !spec) return null
  const cands: string[] = [spec]
  const gh = spec.match(/^github:([^/#]+)\/([^/#]+)/i)
  if (gh) {
    cands.push(gh[1] + '/' + gh[2])
    cands.push(gh[2])
  }
  if (/^https?:\/\//i.test(spec)) {
    const noQuery = spec.split(/[?#]/)[0]
    const seg = noQuery.slice(noQuery.lastIndexOf('/') + 1)
    const base = seg.replace(/\.(tar\.gz|tgz)$/i, '')
    cands.push(base)
    cands.push(base.replace(/-\d+\.\d+\.\d+.*$/, ''))
  }
  const keys = Object.keys(map)
  for (const c of cands) {
    const lc = c.toLowerCase()
    for (const k of keys) {
      if (k.toLowerCase() === lc) return map[k]
    }
  }
  return null
}

// 统一入口：先按 spec 反查，再退回 npm 名（对老数据 / 裸包名条目更稳）
function dshMarketHitOf(p: DshMarketPlugin): DshMarketInstalledEntry | null {
  return dshMarketInstalledBySpec(p) || dshMarketInstalledOf(p.npm)
}

// 过滤 + 排序搬到前端做（宿主 dsh-market.filterPlugins 是同一套逻辑的纯函数实现，
// 但浏览是「每敲一个字就重筛」，走 IPC 要跨进程序列化 4000 多条，代价远高于本地筛）。
const dshMarketList = computed(() => {
  const all = dshMarket.value?.plugins || []
  const kw = dshMarketKeyword.value.trim().toLowerCase()
  const cat = dshMarketCategory.value
  const st = dshMarketState.value
  // 空格分词 → 与关系（每段都要命中）；`-词` → 排除。⚠️ 只有排除词也成立，
  // 此时没有正向条件，等于「全目录减去命中的」。与宿主 matchKeyword 同口径
  const parts = kw ? kw.split(/\s+/) : []
  const out: DshMarketPlugin[] = []
  for (const p of all) {
    if (cat && p.category !== cat) continue
    if (parts.length) {
      const hay = (p.name + ' ' + p.owner + ' ' + p.descZh + ' ' + p.descEn).toLowerCase()
      let hit = true
      for (const part of parts) {
        if (!part) continue
        if (part.charAt(0) === '-') {
          // 光一个 `-` 不算排除词（可能只是打个连字符），跳过，否则会把整份目录清空
          const ex = part.slice(1)
          if (ex && hay.indexOf(ex) >= 0) { hit = false; break }
          continue
        }
        if (hay.indexOf(part) < 0) { hit = false; break }
      }
      if (!hit) continue
    }
    if (st !== 'all') {
      // ⚠️ 读不到已装状态时**不冒充未安装**：宁可全都列出来，也不把已装的标成「未安装」
      // 骗用户去点安装（同宿主 filterPlugins 的取舍）
      if (!dshMarketStatus.value) continue
      const hit = dshMarketHitOf(p)
      if (st === 'installed' && !hit) continue
      if (st === 'notInstalled' && hit) continue
    }
    // 「只看可更新」与状态筛选是**与**关系（可更新必然已装，但它是一个独立开关）
    if (dshMarketOnlyUpdate.value && !dshMarketHasUpdate(p)) continue
    // 「只看 DSH 兼容」同上，但**只认已查到的 compatible**：没查过（根本没有键）与
    // unknown 都不算「兼容」。这不是吝啬，是口径 —— 我们没验证过的条目不能冒充已验证
    if (dshMarketOnlyCompat.value && dshMarketCompat.value.get(p.spec)?.status !== 'compatible') continue
    out.push(p)
  }
  // ⚠️ 方向在比较函数外层取反，不写进每个轴：写进去就得为四轴 × 两方向维护八条箭头函数
  const dir = dshMarketSortDesc.value ? -1 : 1
  const cmp = dshMarketSort.value === 'stars' ? (a: DshMarketPlugin, b: DshMarketPlugin) => (a.stars - b.stars) * dir
    : dshMarketSort.value === 'added' ? (a: DshMarketPlugin, b: DshMarketPlugin) => a.added.localeCompare(b.added) * dir
      : dshMarketSort.value === 'name' ? (a: DshMarketPlugin, b: DshMarketPlugin) => a.name.localeCompare(b.name) * dir
        : (a: DshMarketPlugin, b: DshMarketPlugin) => (a.downloads - b.downloads) * dir
  // ⚠️ 只在这四个轴之间比才可比，不补「以名称兜底」的第二关键字：目录里同名条目确实存在，
  //    但加一条全项目唯一的隐式排序规则，会让「名称」轴在两个名字相同时的表现变得无法解释
  out.sort(cmp)
  return out
})

// 列表分页：目录实测 4183 条，一次全渲染会卡住设置页（同 patch 候选卡的截断思路）。
//
// ⚠️ 从「再加载更多」改成**页码分页**（1/2/3…）的取舍：加载更多是累积式的，
//    翻到后面列表里躺着几百条，滚动条长得离谱、回到顶部也找不到北，而且
//    「我现在在第几屏」无从知晓。页码分页一次只渲染一页，位置明确、可以来回跳。
//    代价是同一页来回翻会重渲染 —— 但每页只有 80 条，且兼容性结论有缓存，代价可控。
const DSH_MARKET_PAGE = 80
const dshMarketPageNo = ref(1)
const dshMarketPageCount = computed(() => Math.max(1, Math.ceil(dshMarketList.value.length / DSH_MARKET_PAGE)))
const dshMarketPageList = computed(() => {
  // ⚠️ 页码要先夹紧再切：筛选后总页数会变小，此时残留的旧页码（如从第 40 页筛到只剩 3 页）
  //    会让 slice 切出空数组 —— 列表空白但计数说「有 200 条」，看起来就是坏了
  const total = dshMarketPageCount.value
  const no = Math.min(Math.max(1, dshMarketPageNo.value), total)
  const start = (no - 1) * DSH_MARKET_PAGE
  return dshMarketList.value.slice(start, start + DSH_MARKET_PAGE)
})
// 页码按钮：页数多时不能全列（4183 条 = 53 页），窗口化显示当前页附近 + 首末页
const dshMarketPageItems = computed<(number | '...')[]>(() => {
  const total = dshMarketPageCount.value
  const cur = Math.min(Math.max(1, dshMarketPageNo.value), total)
  const out: (number | '...')[] = []
  const push = (n: number | '...') => { if (out[out.length - 1] !== n) out.push(n) }
  // 首页、末页、当前页 ±2 必留，其余用省略号折叠
  for (let n = 1; n <= total; n++) {
    if (n === 1 || n === total || Math.abs(n - cur) <= 2) push(n)
    else push('...')
  }
  return out
})
// 条件一变就该从头看结果，停在第 40 页会让人以为筛选没生效
watch([dshMarketKeyword, dshMarketCategory, dshMarketState, dshMarketSort, dshMarketSortDesc, dshMarketOnlyUpdate, dshMarketOnlyCompat], () => {
  dshMarketPageNo.value = 1
})
// ⚠️ 翻页 / 换筛选会换掉整批条目，「官方最新版」那批结论就过期了（结论是按 spec 存的，
//    与新条目对不上）。不清的话顶部汇总会把「上一页的滞后结论」当成本页的结论显示出来。
watch(dshMarketPageList, () => {
  if (dshMarketLatestAt.value) {
    dshMarketLatest.value = new Map()
    dshMarketLatestAt.value = 0
    dshMarketLatestFail.value = 0
  }
})

// ── C 层：当前页自动标兼容性 ──
//
// ⚠️ 为什么只拉「当前已显示的条目」而不是整个目录：目录 4183 条，全量拉 manifest
//    就是 4183 个 HTTP 请求 —— 一打开卡片就开始，用户还没想好要装什么。
//    按页拉则是「你看到多少，我们就查多少」，翻到哪查到哪，且宿主侧 24h 缓存
//    保证重复翻页不会重复请求。
//
// ⚠️ 为什么用 watch 而不是 computed：computed 里发请求会造成「每次重算都发一轮」，
//    而重算频率由渲染决定，不受我们控制（改个关键词就是一次）。watch 只对
//    「当前页条目集合」的变化做反应，且我们自己能保证同一批只发一次。
// ⚠️ 但关键词变了会换一整批条目，所以依赖里必须带上它 —— 否则筛完不查。
const dshMarketCompatPending = ref(false)
async function dshMarketLoadCompatPage() {
  if (dshMarketCompatPending.value) return
  // 宿主版本读不到：一条都判不出来，别发请求（发了也只能得到一堆 no-host-version）
  if (!dshMarketHostVersion.value) return
  // 只查「能剥出裸 npm 包名」且**还没查过**的（查过的复用结论，不再请求）
  const todo: { spec: string; pkg: string }[] = []
  const seen = new Set<string>()
  for (const p of dshMarketPageList.value) {
    if (!dshMarketCompatable(p)) continue
    if (dshMarketCompat.value.has(p.spec)) continue
    const pkg = String(p.npm || '').trim()
    if (!pkg || seen.has(pkg)) continue
    seen.add(pkg)
    todo.push({ spec: p.spec, pkg: pkg })
  }
  if (!todo.length) return
  dshMarketCompatPending.value = true
  try {
    const r = await Promise.resolve((services as any).dshHostCompatCheck?.({
      packages: todo.map((t) => t.pkg),
    }))
    const results = (r && r.results) || {}
    const next = new Map(dshMarketCompat.value)
    for (const t of todo) {
      // ⚠️ 拉失败也要落一条 unknown：不落的话这批条目每翻一次页都重拉一遍，
      //    而「拉不到」在有缓存冷却前会反复撞同一堵墙（宿主侧有 5min 冷却兜底）
      next.set(t.spec, results[t.pkg] || { status: 'unknown', reason: 'unavailable', requirement: '', package: t.pkg })
    }
    dshMarketCompat.value = next
  } catch (err) {
    // 整体失败：什么都不落，下次翻页重试（宿主内部的失败冷却会挡住连打）
  } finally {
    dshMarketCompatPending.value = false
  }
}
// 当前页 + 筛选条件一变就查（含「再加载更多」把新条目纳入显示范围时）
watch([dshMarketPageList, dshMarketOnlyCompat], () => { dshMarketLoadCompatPage() }, { immediate: true })

// 镜像源清单由宿主给（单一来源，避免两边各写一份常量对不上）
const DSH_MARKET_REGISTRIES: { id: string; url: string; label: string }[] = services.dshMarketRegistries?.() || []

// 结果行：说「这一份目录是从哪来的、什么时候的、花了多久」。
// ⚠️ 与 dshMarketSourceShort（折叠按钮上的「偏好」摘要）分工不同，别合并：
//   前者是**事实**（数据实际来自哪条源），后者是**配置**（你希望用哪条源）。
//   默认走「延迟最低」时两者可能不一致 —— 那不是 bug，正是竞速的结果，要能分辨。
const dshMarketSourceText = computed(() => {
  const r = dshMarket.value
  if (!r) return ''
  // 镜像来源要说清**是哪个** registry —— 用户可能自己换过，硬编成「腾讯云」会撒谎
  const from = r.from === 'official' ? '官方目录'
    : r.from === 'mirror' ? ('npm 镜像（' + (DSH_MARKET_REGISTRIES.find((x) => x.url === r.registry)?.label || r.registry || '未知') + '）')
      : r.from === 'custom' ? '自定义目录'
        : r.from === 'cache' ? '上次的离线副本'
          : (r.from || '未知来源')
  const parts = [from]
  if (r.updated) parts.push('更新于 ' + r.updated)
  if (r.cached && !r.stale) parts.push('未变化，复用缓存')
  // 耗时只在这一轮真的抓了网才显示：命中内存缓存时 tookMs 是最初那次的值，显示出来会误导
  if (!r.cached && typeof r.tookMs === 'number' && r.tookMs > 0) parts.push('耗时 ' + (r.tookMs / 1000).toFixed(2) + 's')
  return parts.join(' · ')
})

// 折叠时的来源摘要：只说要紧的两件事（用哪条源、官方参不参赛），
// 让用户不展开也知道当前配置 —— 用完整 label 会太长，折叠按钮一行放不下。
// 测过速之后把最快的一条的延迟也带上：否则「测速」的结果只出现在 flash 消息里，
// 消息一被下一次操作清掉就再也看不到，用户等于白测。
const dshMarketSourceShort = computed(() => {
  const url = cfg.dshMarketRegistry
  const label = url
    ? (DSH_MARKET_REGISTRIES.find((x) => x.url === url)?.label || url)
    : '默认'
  const fastest = dshMarketPing.value.find((x) => x.ok)
  const ping = fastest ? ` · 最快 ${fastest.ms} ms` : ''
  return (cfg.dshMarketOfficial ? label + ' + 官方' : label) + ping
})

// 可更新条数。⚠️ 只数 state === 'update'，'unknown' 不算（目录没给版本，比不了）
const dshMarketUpdateCount = computed(() => {
  let n = 0
  for (const e of dshMarketUpdates.value.values()) {
    if (e.state === 'update') n++
  }
  return n
})

// 已确证兼容的条数（只数 compatible，unknown / 没查过都不算）。
// 用作「只看 DSH 兼容」开关的可用性与计数 —— 一条都没有时开关置灰，
// 而不是给一个点了必然空屏的按钮
const dshMarketCompatCount = computed(() => {
  let n = 0
  for (const v of dshMarketCompat.value.values()) {
    if (v.status === 'compatible') n++
  }
  return n
})

const dshMarketSummary = computed(() => {
  const r = dshMarket.value
  // 与其余 7 张卡同构：摘要的可用性看「本会话是否展开读过」，而不是「有没有联网抓过目录」。
  // 市场卡展开只读本地已装状态（不联网），所以未抓目录时也能报出已装包数 ——
  // 这里若改用 dshMarketLoaded 当闸门，摘要会一直停在「点击展开浏览」，
  // 即便用户已经展开读过、profile 里有多少已装包早已拿到。
  if (!devStatsLoaded.dshMarket) return '点击展开浏览'
  if (!r) {
    const instLocal = dshMarketStatus.value?.count
    return instLocal ? `profile 里 ${instLocal} 个已装包 · 点击进入市场` : '点击进入市场'
  }
  if (!r.ok) return '目录加载失败'
  const n = r.count || r.plugins?.length || 0
  const inst = dshMarketStatus.value?.count || 0
  // 有更新时把数字挂到摘要上 —— 这是用户最想一眼看到的（否则得自己翻筛选）
  const up = dshMarketUpdateCount.value
  return `${n} 个插件 · profile 里 ${inst} 个已装包` + (up ? ` · ${up} 个可更新` : '')
})

// 只读本地已装状态（**不联网**）：展开卡片时自动跑，装/卸之后也要重跑
function dshMarketRefreshStatus() {
  if (dshMarketStatusBusy.value) return
  dshMarketStatusBusy.value = true
  try {
    const r = services.dshMarketStatus?.({ profile: dshPatchProfile })
    dshMarketStatus.value = r || null
    // 已装状态变了 → 「谁有新版」的结论也跟着变（装/卸/更新之后都会走到这里）。
    // 目录没加载时它自己会清空 Map，不会误报
    dshMarketCheckUpdates()
  } catch (err: any) {
    dshMarketFlash.err = true
    dshMarketFlash.msg = '读取本地已装状态失败：' + String(err?.message || err)
  } finally {
    dshMarketStatusBusy.value = false
  }
}

// 检查已装插件有没有新版（**纯本地计算**：拿已加载的目录去比 package.json 的声明范围，
// 不联网 —— 目录已经在手上了，这里只是算）。
// ⚠️ 只在目录 ok 之后才调：没有目录就没有 version 可比，查了也全是 unknown。
// 每次目录刷新后都要重跑：目录换了，能比的条目也就变了。
function dshMarketCheckUpdates() {
  const cat = dshMarket.value
  if (!cat?.ok) {
    dshMarketUpdates.value = new Map()
    // ⚠️ 必须同时关掉「只看可更新」：它是个与状态筛选并列的**与**条件，
    //    目录一没就没人可更新，留着这个开关会让列表恒空 —— 用户看到的是
    //    「没有符合条件的插件」，但真正原因是自己开着一个已经没有意义的开关
    dshMarketOnlyUpdate.value = false
    return
  }
  if (dshMarketUpdateBusy.value) return
  dshMarketUpdateBusy.value = true
  try {
    const r = services.dshMarketCheckUpdates?.({ profile: dshPatchProfile, catalog: cat })
    const map = new Map<string, DshMarketUpdateEntry>()
    if (r && r.ok && Array.isArray(r.entries)) {
      for (const e of r.entries) map.set(String(e.spec || ''), e)
    }
    dshMarketUpdates.value = map
  } catch (err: any) {
    // 查更新失败不该打断浏览 —— 只是没有「可更新」标记，卡片其余部分照常。
    // 这里走 flash 而不是静默：宿主真出错时用户得能看见，否则「怎么没有可更新标记」
    // 会变成一句查不出原因的疑问
    dshMarketUpdates.value = new Map()
    dshMarketFlash.err = true
    dshMarketFlash.msg = '检查更新失败：' + String(err?.message || err)
  } finally {
    dshMarketUpdateBusy.value = false
  }
}

// 抓目录（**会联网**）：force 用于「强制重抓」与「改了目录源之后」。
// 注意宿主返回的是 Promise（要发 HTTP），与 dshMarketStatus 的同步返回不同
function dshMarketLoad(force = false) {
  if (dshMarketBusy.value) return
  dshMarketBusy.value = true
  dshMarketLoaded.value = true
  // 走到这儿说明用户明确要抓目录 —— 解锁浏览区（来源选择等也跟着出现）
  dshMarketRevealed.value = true
  dshMarketFlash.msg = ''
  dshMarketFlash.err = false
  // 重抓意味着这一轮的筛选结果可能全变，上一轮的待确认计划随之作废
  dshMarketPlan.value = null
  Promise.resolve(services.dshMarketCatalog?.({ force, url: cfg.dshMarketUrl || '', mirror: cfg.dshMarketMirror, registry: cfg.dshMarketRegistry || '', official: cfg.dshMarketOfficial }))
    .then((r) => {
      if (!r) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = '宿主 API 不可用'
        return
      }
      dshMarket.value = r
      if (!r.ok) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = r.error || '目录加载失败'
        return
      }
      // 降级到离线副本时必须说清楚 —— 否则用户以为看到的是最新目录，
      // 会照着几天前的 stars/downloads 做判断
      if (r.stale) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = `在线来源都取不到（${r.staleReason || '未知原因'}），以下是上次抓到的目录，可能已过期。`
        return
      }
      dshMarketFlash.msg = `已加载 ${r.count || r.plugins?.length || 0} 个插件（${dshMarketSourceText.value}）`
      // 目录到手就顺手算一次「哪些已装包有新版」—— 纯本地计算，不额外发请求
      dshMarketCheckUpdates()
    })
    .catch((err) => {
      dshMarketFlash.err = true
      dshMarketFlash.msg = '目录加载失败：' + String(err?.message || err)
    })
    .then(() => {
      dshMarketBusy.value = false
    })
}

// 给各镜像源测延迟。只打元数据（几百字节），不下载目录 —— 测速本身不该很慢。
// 结果按延迟升序，界面在每项旁显示「xx ms」并据此推荐「用最快那个」。
function dshMarketPingRun() {
  if (dshMarketPingBusy.value) return
  dshMarketPingBusy.value = true
  dshMarketFlash.msg = ''
  dshMarketFlash.err = false
  Promise.resolve(services.dshMarketPing?.({}))
    .then((r) => {
      if (!r || !r.ok || !Array.isArray(r.list)) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = '宿主 API 不可用'
        return
      }
      dshMarketPing.value = r.list
      const first = r.list.find((x) => x.ok)
      if (!first) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = '所有镜像源都测不通，检查网络后重试。'
        return
      }
      // 测速不改用户的配置 —— 只报告结果。「用最快的」是个显式动作，避免静默改配置
      dshMarketFlash.msg = `测速完成：最快是「${first.label}」（${first.ms} ms）。要改用它请点「用最快的」。`
    })
    .catch((err) => {
      dshMarketFlash.err = true
      dshMarketFlash.msg = '测速失败：' + String(err?.message || err)
    })
    .then(() => {
      dshMarketPingBusy.value = false
    })
}

// 把 registry 设成实测最快的那条。没有测速结果时先测一次再设。
function dshMarketUseFastest() {
  const first = dshMarketPing.value.find((x) => x.ok)
  if (!first) {
    dshMarketFlash.err = true
    dshMarketFlash.msg = '先点「测速」拿到结果，再选最快的。'
    return
  }
  cfg.dshMarketRegistry = first.url
  dshMarketFlash.err = false
  dshMarketFlash.msg = `已改用「${first.label}」（${first.ms} ms）。正在按新来源重新加载…`
  // 来源变了，缓存键也就变了 —— 下一次 load 必然重抓，不需要额外 force
  dshMarketLoad(false)
}

// 第一段：dryRun。宿主只回「准备执行什么」，不跑 npm、不建快照。
// ⚠️ 宿主返回 Promise（与 dshMarketStatus 的同步不同）：dryRun 分支虽不跑 npm 也走 Promise，
// 形状必须按 Promise 处理，否则拿到的是一整个 thenable 而不是结果对象
// ⚠️ force（2026-09-25 加）：dryRun 一律**不带** —— 第一步先照常判，把「不兼容」如实摆出来；
//    用户在单据卡上看过后果、点「仍要强制安装」，才带 force 重跑一次。所以这个入参只可能由
//    那个按钮传进来。带了 force 之后宿主仍会判定，只是不再以它为拦路依据，返回体照样带
//    hostIncompatible:true，界面据此把卡片切成「你正在强行装一个…」的措辞。
function dshMarketPreviewInstall(p: DshMarketPlugin, force = false) {
  // specKind 为空说明目录给的 spec 形态我们认不出来 —— 不给按钮，避免点下去必然失败
  if (dshMarketBusy.value || !p.specKind) return
  // ⚠️ 这条分支既服务「安装」也服务「已装但落后 → 转交更新流程」，所以两个版本都要回传：
  //    catalogVersion 进单据（给用户看「要改成哪一版」），depVersion 进确认时的宿主入参。
  //    少回传任一个都会让单据读不出具体版本 —— 那正是用户反馈「能不能更明确点」的由来
  const hit = dshMarketHitOf(p)
  dshMarketBusy.value = true
  dshMarketFlash.msg = ''
  dshMarketFlash.err = false
  // ⚠️ 必须把目录条目的 version 传下去：宿主只靠 profile/package.json 判「装没装」，
  //    而声明范围 `^1.48.0` 是**容得下** `1.49.0` 的 —— 不传版本，已装的包永远被判成
  //    「无需重复安装」，用户看着目录有新版本却点不动（真实 bug）。宿主拿到 version 才会比实装版本。
  Promise.resolve(services.dshMarketInstall?.({ profile: dshPatchProfile, spec: p.spec, npm: p.npm, name: p.name, version: p.version, needsBuild: p.needsBuild, dryRun: true, force }))
    .then((r) => {
      if (!r) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = '宿主 API 不可用'
      } else if (!r.ok) {
        // ⚠️ 宿主不兼容是**前置拦截**（宿主已判实证伪）：文案原文已说清「要求什么 / 当前是什么」，
        //    照搬即可，不要再自己拼一遍（两处口径会漂）
        dshMarketFlash.err = true
        dshMarketFlash.msg = r.error || '无法生成安装计划'
        // 拦下也留出路：单据卡据此长出「仍要强制安装」按钮（见 dshMarketForcePlan）。
        // 其余失败（spec 认不出、dryRun 自己出错）不给 —— force 对它们无能为力
        if (r.hostIncompatible) {
          dshMarketPlan.value = {
            action: 'install',
            npm: p.spec,
            name: p.name,
            message: '',
            spec: p.spec,
            needsBuild: !!p.needsBuild,
            hostIncompatible: true,
            hostForced: false,
          }
        }
      } else if (!r.changed) {
        dshMarketPlan.value = null
        dshMarketFlash.msg = r.message || '已经装过这个包，无需重复安装。'
      } else if (dshMarketHitOf(p)?.inDeps) {
        // ⚠️ 走到这里说明「已装，但实装版本落后于目录」（宿主 dryRun 比的实装版本）——
        //    这是「更新」，不是「安装」。不能复用安装入口：安装走 marketInstall 的写盘分支，
        //    不带 from 版本、文案也说不出「从哪版到哪版」。所以转交给更新确认流程。
        dshMarketFlash.err = false
        dshMarketFlash.msg = r.message || ''
        // ⚠️ 带上目录版本：真写被供应链策略挡下时，宿主靠它拼出「`- xxx@0.3.24`」这句可照抄的指引；
        //    不带就只能显示字面量「目标版本」，用户不知道该往白名单里写哪个号（真实 bug）。
        //    同一格还供单据显示「版本将改为 vX」（见模板的 mkt-plan-sub）；
        //    npm 名带回去（同 install 分支）让宿主真写时能按包名回读核验
        dshMarketPlan.value = { action: 'update', npm: p.spec, name: p.name, message: r.message || '', spec: p.spec, version: r.to || p.version, npmName: p.npm || '', depVersion: hit?.depVersion || '', hostIncompatible: !!r.hostIncompatible, hostForced: !!r.hostForced }
      } else {
        dshMarketPlan.value = { action: 'install', npm: p.spec, name: p.name, message: r.message || '', needsBuild: !!p.needsBuild, version: r.to || p.version, npmName: p.npm || '', hostIncompatible: !!r.hostIncompatible, hostForced: !!r.hostForced }
      }
    })
    .catch((err) => {
      dshMarketFlash.err = true
      dshMarketFlash.msg = '生成安装计划失败：' + String(err?.message || err)
    })
    .then(() => {
      dshMarketBusy.value = false
    })
}

// 单据卡上的「仍要强制安装」—— 带着 force 把 dryRun 重跑一遍。
//
// ⚠️ 为什么不直接 `dshMarketConfirm()` 收工：宿主那两道闸（dryRun 拦、真写再拦）判的是同一件事，
//    界面第一次拿到的返回体**没有** message（hostBlockedResult 走的是 error 分支），直接确认会让
//    单据卡上「将要执行什么」那一句空着 —— 用户等于盲签。所以这里重跑一次 dryRun，
//    拿到「结论相同 + 不再拦」的完整单据（含那条 ⚠️ 强装警告）再交给他点头。
function dshMarketForcePlan() {
  if (dshMarketBusy.value) return
  // 目录条目按 plan 里的 spec 反查（见 dshMarketPlanPlugin 的注释）。找不到说明列表被重筛过 ——
  // 说一句再退场，不能静默 return（按钮点了没反应会被当成卡死）
  const p = dshMarketPlanPlugin()
  if (!p) {
    dshMarketFlash.err = true
    dshMarketFlash.msg = '找不到这条目录条目（列表可能已被筛选/重载改过），请退出市场重新进入后再试。'
    return
  }
  // 精确安装走的是「用户查到的那一版」，不是目录 spec —— 有 targetVersion 就必须带回去，
  // 否则重跑出来的单据会从「装 v1.65.1」悄悄变成「按目录重装」，用户点的和他看到的对不上
  if (dshMarketPlan.value?.exact) return dshMarketPreviewInstallExact(p, true)
  return dshMarketPreviewInstall(p, true)
}

// 第一段：dryRun（停用 / 卸载）。remove=false 写 patch 的 disabled 行（包留在磁盘），
// remove=true 才真的从 profile 里删包 —— 两者是同一条链路的不同分支，所以走同一个入口、
// 由 remove 区分，避免两套并行逻辑漂移。
//
// ⚠️ 为什么「停用 / 卸载」两把钥匙都挂在目录条目上（2026-09-25 用户要求「这里也要有卸载按钮」，
//    参考 dsh-market 的已装行卡片）：
//    · 目录条目是用户浏览插件的**主场景** —— 他刚看到某条目写着「已装」，想卸就得回到下面那份
//      「已装包」折叠清单里去找同名项。两处状态各算各的，中间还隔着一屏滚动，是白白的负担。
//    · 已在「已装包」清单里的按钮保持不动（那里的作用是「目录里没有的包」的唯一出口，
//      以及一次看全 38 个包的整体视角），这里是**同一个入口的第二个位置**，不是替代品。
//    ⚠️ 卸载在目录条目上**只认 npm 包名，不要求 `p.specKind`**：宿主 marketUninstall 的
//    remove 分支按 npm 名删包（spec 反查不到时用 realDepKey 从依赖表取回键名），
//    而目录里近半条目的 install 字段形态是我们认不出的（specKind 为空）。
//    早先这里把 `p.specKind` 当成了「能不能卸」的判据（那是**安装**能力），
//    于是这类条目渲染成空白 —— 用户「看得见已装徽章、找不到卸载按钮」的原始 bug 就是这个。
//    只有「更新」仍需要 specKind（更新 = 按目录 spec 重装一次）。
function dshMarketPreviewUninstall(p: DshMarketPlugin, remove: boolean) {
  if (dshMarketBusy.value) return
  dshMarketBusy.value = true
  dshMarketFlash.msg = ''
  dshMarketFlash.err = false
  Promise.resolve(services.dshMarketUninstall?.({ profile: dshPatchProfile, spec: p.spec, npm: p.npm, name: p.name, remove, dryRun: true }))
    .then((r) => {
      if (!r) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = '宿主 API 不可用'
      } else if (!r.ok) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = r.error || '无法生成卸载计划'
      } else if (!r.changed) {
        dshMarketPlan.value = null
        dshMarketFlash.msg = r.message || '无需改动。'
      } else {
        dshMarketPlan.value = { action: remove ? 'remove' : 'uninstall', npm: p.npm || p.spec, name: p.name, message: r.message || '', id: r.id }
      }
    })
    .catch((err) => {
      dshMarketFlash.err = true
      dshMarketFlash.msg = '生成卸载计划失败：' + String(err?.message || err)
    })
    .then(() => {
      dshMarketBusy.value = false
    })
}

// 第二段：真写。宿主内部「先建快照 → 跑 npm → 回读 package.json 核验」，任一步失败即中止
function dshMarketConfirm() {
  const plan = dshMarketPlan.value
  if (dshMarketBusy.value || !plan) return
  const installing = plan.action === 'install'
  const updating = plan.action === 'update'
  dshMarketBusy.value = true
  // 开进度回显：这一等可能是几分钟（github/tarball 要 clone + 构建），必须让人看见在动
  dshMarketTickStart()
  dshMarketPending.value = plan.npm
  dshMarketFlash.msg = ''
  dshMarketFlash.err = false
  // 安装与更新都走 spec（github/tarball 条目没有 npm 名）；卸载走 npm 键名（宿主自己也会反查兜底）。
  // ⚠️ 更新必须用 plan.spec：plan.npm 在 update 分支里存的也是 spec（目录给的安装原话），
  //    但显式读 spec 才不会在日后改动里被误会成「npm 包名」
  // ⚠️ 必须把「调用宿主」也包进 try：宿主 API 是**同步调用**（preload 与页面同一 window，
  //    不是 ipcRenderer.invoke），它内部若在返回 Promise 之前抛错，异常会在这一行直接冒出来，
  //    下面的 `.then` 链根本没机会挂上 —— 于是 dshMarketBusy 永远停在 true，按钮卡在
  //    「正在安装…」、计时器也永远不停（2026-09-25 实测：7 分 56 秒仍在「正在安装…」，
  //    日志里一条阶段旁白都没有，就是宿主在 note() 处抛了 TypeError）。
  //    Promise.resolve(fn()) 这种写法挡不住同步 throw，必须显式收进 Promise。
  const call = Promise.resolve().then(() => {
    if (installing) {
      return services.dshMarketInstall?.({
        profile: dshPatchProfile,
        spec: plan.npm,
        name: plan.name,
        needsBuild: plan.needsBuild,
        // ⚠️ 「装到指定版本」走的也是 install 通道，但多带 exact + targetVersion —— 宿主据此
        //    把 spec 拼成 `pkg@x.y.z`（见 dshMarketPreviewInstallExact 的注释）。
        //    exact 为假时这两个字段不影响宿主行为（它有 `o.exact === true` 的硬判断）
        exact: !!plan.exact,
        targetVersion: plan.targetVersion,
        npm: plan.npmName,
        // ⚠️ 真写要**再带一次** force（2026-09-25）：宿主 dryRun 与真写是两次独立调用，
        //    两次都各自过一遍兼容闸。只给 dryRun 带 force，用户点头之后照样被拦在写入前 ——
        //    现象是「点了强制安装、也看到了单据，确认后却报不兼容」，比一开始就不给按钮更糟
        force: !!plan.hostForced,
      })
    }
    if (updating) {
      // ⚠️ 带上 npm 名（2026-09-25）：宿主 marketUpdate 靠它比**实装版本**（dryRun / 真写用它
      //    判「实装 < 目录 → 该更新」并回传 from）；不带就只能退回比声明范围，
      //    而 `^1.48.0` 是容得下 1.49.0 的 —— 会出现「单据说能更新、真写说无需更新」的自相矛盾。
      //    （同一处缺口在安装链路已由 plan.npmName 补上，见 install 分支）
      return services.dshMarketUpdate?.({ profile: dshPatchProfile, spec: plan.spec || plan.npm, npm: plan.npmName, name: plan.name, version: plan.version, force: !!plan.hostForced })
    }
    // 卸载把 dryRun 报回来的 id 一并带上：宿主优先按它写 patch（用户当前写的那个 id，
    // 可能是去掉 scope 的短名），反查只在没有 id 时才做
    return services.dshMarketUninstall?.({ profile: dshPatchProfile, npm: plan.npm, name: plan.name, id: plan.id, remove: plan.action === 'remove' })
  })
  call
    .then((r) => {
      if (!r) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = '宿主 API 不可用'
        return
      }
      if (!r.ok) {
        dshMarketFlash.err = true
        dshMarketFlash.msg = (r.error || '写入失败') + (r.snapshot ? `（快照 ${r.snapshot} 可回滚）` : '')
        // ⚠️ 「版本没变」也算失败：pnpm 退出码 0 但被 profile 的供应链策略（minimumReleaseAgeExclude）
        //    挡下、磁盘一个字没改。宿主回读发现后按失败上报，这里不再叠「已更新」的措辞。
        if ((r as DshMarketInstallResult).blocked) dshMarketFlash.msg = '未升级：' + dshMarketFlash.msg
        // ⚠️ 「版本反而变低」是另一个方向的静默失败：pnpm 报成功、版本也确实变了，但变**低**了
        //    （镜像滞后 / registry 把 @latest 解析成旧版本）。旧版可能缺安全修复，必须明确
        //    告知「建议回滚」而不是笼统的「写入失败」—— 宿主已把方向判好，这里只加点明主语。
        if ((r as DshMarketInstallResult).downgraded) dshMarketFlash.msg = '版本降级：' + dshMarketFlash.msg
        // ⚠️ 「版本没动」有两种完全不同的成因，给的下一步动作也相反：
        //    release-age = 目标版本太新、还没满最小发布年龄 → 等它满期，重试即可，**不必改配置**；
        //    其余（白名单没放行）→ 必须往白名单里加一行。
        //    宿主已按输出判断好方向，这里只负责把「该干什么」说清楚 —— 说反了用户会去改一个
        //    根本不起作用的键，然后以为插件坏了
        const sr = (r as DshMarketInstallResult).staleReason
        if (sr === 'release-age') {
          dshMarketFlash.msg += ' 原因是目标版本发布太新、还没到供应链策略要求的最小发布年龄 —— 等它满期后重试即可，不必改配置。'
        } else if (sr === 'allowlist') {
          dshMarketFlash.msg += ' 原因是供应链白名单没放行这一条 —— 见下方指引。'
        }
        // 「pnpm 报成功、版本也确实变了，但**低于**目标」：多半是镜像源滞后。
        // 高于目标不报（镜像抢先是好事），宿主只在低于目标时才置位
        const res0 = r as DshMarketInstallResult
        if (res0.mismatch) {
          dshMarketFlash.msg = `实装版本低于目标（期望 ${res0.expected || '?'}，实装 ${res0.version || '?'}）：` + dshMarketFlash.msg
        }
        // ⚠️ 「需构建」的条目**注定要失败一次**：这类插件靠 prepare 脚本在安装时构建，
        //    pnpm 默认拦截构建脚本，失败信息里会给出那把带 commit hash 的 allowBuilds key。
        //    宿主已从输出里把它抠出来，这里直接展示给用户，省掉「去日志里自己找」这一步
        const ab = (r as DshMarketInstallResult).allowBuilds
        if (ab) {
          dshMarketAllowBuilds.value = { spec: plan.npm, name: plan.name, key: ab.key, file: ab.file }
          dshMarketFlash.msg += ' 这属于 pnpm 的构建拦截（不是安装失败）—— 见下方指引。'
        }
        return
      }
      dshMarketAllowBuilds.value = null
      // 三种成功的说法要分清，否则用户不知道「卸载」到底删没删包。
      // ⚠️ 装/卸返回的是两种不同结果类型（version 只有装那边有、id 只有禁用那边有），
      // 联合类型下直接取字段会报错 —— 这里按 planned 动作分别缩窄
      dshMarketFlash.err = false
      if (plan.action === 'install') {
        const res = r as DshMarketInstallResult
        // ⚠️ exact（精确装到用户查到的那一版）也是「按版本重装」，结果卡必须画 `旧 → 新`：
        //    与 update 走同一个措辞，否则用户点了「装这一版」只看到「已安装 @1.65.1」，
        //    不知道是从 1.62.0 换上来的。`from` 由宿主回读实装版本给出（目录版本是滞后的，不能拿来当基准）
        dshMarketFlash.msg = res.from
          ? `已安装 ${plan.name || plan.npm}（v${res.from} → ${res.version ? 'v' + res.version : '?'}）${res.snapshot ? `（快照 ${res.snapshot}）` : ''}。`
          : `已安装 ${plan.name || plan.npm}${res.version ? ' @' + res.version : ''}${res.snapshot ? `（快照 ${res.snapshot}）` : ''}。`
      } else if (plan.action === 'update') {
        const res = r as DshMarketInstallResult
        dshMarketFlash.msg = `已更新 ${plan.name || plan.npm}${res.from ? `（v${res.from} → ${res.version ? 'v' + res.version : '?'}）` : (res.version ? ' @' + res.version : '')}${res.snapshot ? `（快照 ${res.snapshot}）` : ''}。`
      } else if (plan.action === 'remove') {
        dshMarketFlash.msg = `已从 profile 删掉 ${plan.npm}${r.snapshot ? `（快照 ${r.snapshot}）` : ''}。`
      } else {
        const res = r as DshMarketUninstallResult
        dshMarketFlash.msg = `已在 patch 里禁用 ${res.id || plan.npm}，包仍在磁盘上${r.snapshot ? `（快照 ${res.snapshot}）` : ''}。`
      }
      if (r.needsRestart) {
        dshMarketFlash.msg += 'dsh 需要重新加载才生效 —— 点上方「重启 dsh」，或稍后自行重启。'
      }
      // ⚠️ 强制安装**写进去了不等于能加载**（2026-09-25 加）：pnpm 只保证包装到磁盘，
      //    dsh 起插件时才会去核 peer/engines，那一刻失败的话它多半只往自己的日志里写一行，
      //    界面上什么都不显示 —— 用户会以为是这个插件本身坏了。
      //    所以成功文案要把「刚才是强行装的」重新点一次，并**明确指派复核动作**，
      //    不能让这句警告只活在动手前的单据上（那时用户正急着装，最不容易记住）。
      if (plan.hostForced) {
        dshMarketFlash.msg += '⚠️ 这是忽略宿主兼容性检查强行装的：若 dsh 加载它失败，先回滚快照，'
          + '或把 DSH 升到插件要求的版本再装 —— 插件本身没问题，是当前宿主版本不满足它的声明。'
      }
    })
    .catch((err) => {
      dshMarketFlash.err = true
      dshMarketFlash.msg = '写入失败：' + String(err?.message || err)
    })
    .then(() => {
      // 先停表再清 plan：停表会把 ticking 置 false，进度区随 plan 一起消失
      dshMarketTickStop()
      dshMarketBusy.value = false
      dshMarketPending.value = ''
      dshMarketPlan.value = null
      // 磁盘真的变了，本地已装状态必须重读，否则界面上那一行还停留在装之前
      dshMarketRefreshStatus()
      // ⚠️ 快照列表也要重读（2026-09-25 用户报「展开后再次保存快照，列表没出现新的」）：
      //    市场这条链路里，快照是**宿主侧**在 marketInstall 内部建的（写前自动快照），
      //    前端事先根本不知道 —— 结果卡上写着「快照 20260925-093530 可回滚」，可快照区
      //    展开着的那份列表还是旧数据，用户看不到刚建的那份，只能收起再展开（甚至以为没建）。
      //    成功与失败**都要刷**：失败分支同样建了快照（失败文案里也带 `（快照 … 可回滚）`）。
      //    放在这个收尾 then 里，两条路径共用一个出口。
      dshBackupRefresh()
    })
}

// ── 进度回显：计时 + npm 实时输出 ──
// 取 dshStatus() 快照里 log 的尾部若干行（宿主已经把它拼成整串了）。
// ⚠️ 只取尾部：npm 装一个带构建的包能打上千行，全量塞 DOM 又慢又没人看；
//    要看全量有「日志」卡，这里只需让人确认「它在动」。
function dshMarketTailOf(text: string): string {
  const all = String(text || '').replace(/\r/g, '').split('\n')
  // 去掉尾部连续空行（npm 用 \r 刷进度条，清完 \r 会剩一堆空行）
  while (all.length && !all[all.length - 1].trim()) all.pop()
  return all.slice(-DSH_MARKET_TAIL_LINES).join('\n')
}

// 拉一次进度（耗时由本地时钟算，日志由宿主快照取）
function dshMarketTick() {
  if (dshMarketStartedAt) dshMarketElapsed.value = Math.floor((Date.now() - dshMarketStartedAt) / 1000)
  try {
    // ⚠️ 用 dshProgress() 而不是 dshStatus()：后者每次都探一次端口（起 netstat 子进程），
    //    1Hz 刷新几分钟等于白起几百次；进度回显并不需要端口信息
    const s = services.dshProgress?.()
    if (s) {
      dshMarketLogTail.value = dshMarketTailOf(s.log)
      // lastCmd 在 npm 跑起来后才有值；没值时保留上一次，避免闪空
      if (s.lastCmd) dshMarketLastCmd.value = String(s.lastCmd)
      // ⚠️ 同步喂给「运行详情」卡（2026-09-25 修，用户实测报的）：
      //    那张卡的「最近命令 / dsh 日志」读的是 dshStatus() 快照，而 dshStatus 只在
      //    打开 Tab、点「刷新状态」、以及 4s 轮询时才会被调用 —— 装插件的这几分钟里，
      //    用户盯着「运行详情」看到的是**装之前**的旧快照（「最近命令：还没执行过」、
      //    「这里没有日志」），而 npm 明明已经在跑了。用户的原话就是「不知道执行了什么
      //    命令，日志，进度」。dshProgress() 回的是同一份 state（lastCmd / log），
      //    这里把它并进 dsh 快照即可，不必再起一条 IPC。
      if (s.lastCmd) dsh.lastCmd = String(s.lastCmd)
      if (typeof s.log === 'string' && s.log) dsh.log = s.log
    }
  } catch (err) { /* 预期分支：宿主快照读不到就只走计时，不影响写入本身 */ }
}

// ⚠️ 计时基准放在组件外层的普通变量而非 ref：它只用来算差值，
//    进响应式会让每次赋值都触发无谓的重渲染
let dshMarketStartedAt = 0
function dshMarketTickStart() {
  // ⚠️ 起表前先清一次旧表：重复点确认（或上一次的 interval 没清干净）会让两个表叠着跑。
  //    这里只清计时器、**不能**顺手把 ticking 置回 false —— 那会让紧接着的进度区
  //    `v-if="dshMarketTicking"` 整块渲染不出来（2026-09-25 实测：按钮已显示「正在安装…」，
  //    进度区却始终不出现），所以清表逻辑放在 TickStop 之外单独做。
  if (dshMarketTickTimer) { window.clearInterval(dshMarketTickTimer); dshMarketTickTimer = 0 }
  dshMarketStartedAt = Date.now()
  dshMarketElapsed.value = 0
  dshMarketLogTail.value = ''
  dshMarketTicking.value = true
  dshMarketTick()
  dshMarketTickTimer = window.setInterval(dshMarketTick, DSH_MARKET_TICK_MS)
}
function dshMarketTickStop() {
  if (dshMarketTickTimer) { window.clearInterval(dshMarketTickTimer); dshMarketTickTimer = 0 }
  dshMarketTicking.value = false
}
// 卸载时务必停表：定时器持有组件闭包，不停会一直空跑
onUnmounted(() => { dshMarketTickStop() })

// 有新输出就滚到底：npm 的输出是追加式的，用户要看的是最新那几行；
// 不自动滚的话进度区会一直停在最早那段，看起来像「卡住了」
watch(dshMarketLogTail, () => {
  nextTick(() => {
    const el = dshMarketLogEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

// 耗时文案：不到 1 分钟给秒，之后给「x 分 y 秒」—— 装带构建的包常等几分钟，
// 只报秒数（如 187 秒）不直观
function dshMarketElapsedText(): string {
  const s = dshMarketElapsed.value
  if (s < 60) return s + ' 秒'
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
}

// 进行中的动作名（对话框标题与按钮都用它，避免「写入中…」这种不说明在做什么的话）
function dshMarketActionLabel(): string {
  const a = dshMarketPlan.value?.action
  if (a === 'install') return '安装'
  if (a === 'update') return '更新'
  if (a === 'remove') return '彻底删除'
  return '禁用'
}

// 阶段的粗粒度提示：拿 lastCmd 结尾的 pnpm 子命令 + 有无输出，猜当前在哪一步。
// ⚠️ 这是**猜测**，措辞必须留余地（「正在…」而不是「已完成…」）：
//    宿主没有细粒度进度事件，只凭输出推断，说满会说错。
// ⚠️ 空输出段（早先一律说「正在建快照并启动 pnpm」）在 2026-09-25 被用户实测打回：
//    宿主日志流现在会播阶段旁白（dsh.note），有旁白就该照读，别再猜「在建快照」——
//    否则 pnpm 明明已经在跑，界面还在说建快照，用户更糊涂。
function dshMarketPhaseText(): string {
  const tail = dshMarketLogTail.value
  if (!tail) {
    // 连旁白都还没到（IPC 刚发出、宿主还没进 marketInstall）：只能说最保守的话
    return dshMarketPlan.value?.needsBuild
      ? '即将开始（该来源要 clone 后构建，首次较慢）…'
      : '即将开始…'
  }
  // 宿主播的阶段旁白：照读，最准
  if (/快照已建|开始起 pnpm/i.test(tail)) return '快照已建，pnpm 正在跑…'
  if (/建 profile 快照|建快照/i.test(tail)) return '正在建 profile 快照（还没起 pnpm）…'
  // ⚠️ 尾部还是「结束 dsh」那几行（taskkill / 已结束外部启动的 dsh）时，说明安装链路
  //    连旁白都还没插进来 —— 这时兜底说「pnpm 正在执行…」是**在骗人**：日志里根本没有 pnpm。
  //    实测 2026-09-25：日志尾部只有 taskkill，阶段提示却说「pnpm 正在执行」，用户越看越糊涂。
  //    遇到这种「只有结束动作、没有安装动作」的尾巴，如实说还在准备（或提示可能没走到）。
  if (/taskkill|已结束外部启动的 dsh|kill -TERM/i.test(tail)) return '正在准备安装（日志尾部还是上一次「结束 dsh」的输出，即将进入建快照 / 起 pnpm）…'
  if (/clone|Cloning|git/i.test(tail)) return '正在拉取源码…'
  if (/prepare|build|Building|gyp|tsc|compile/i.test(tail)) return '正在构建（prepare 脚本）…'
  if (/progress|reify|resolving|Fetch|download/i.test(tail)) return '正在下载依赖…'
  return 'pnpm 正在执行…'
}

// 重启 dsh：**永远由用户显式点**（装完插件不会自动重启 —— 会掐掉正在跑的会话）。
// 复用既有的 services.dshRestart()，不另开通道 —— 它本来就在主控卡里当「重启」按钮用，
// 这里只是把同一个动作摆到装完插件之后的位置
function dshRestartNow() {
  try {
    const api = services as any
    dshApply(api.dshRestart?.())
    dshMarketFlash.err = false
    dshMarketFlash.msg = '已请求重启 dsh，稍后自动刷新状态。'
    laterStatus(dshStatus, 2500)
    laterStatus(dshStatus, 6000)
  } catch (err: any) {
    dshMarketFlash.err = true
    dshMarketFlash.msg = '重启请求失败：' + String(err?.message || err)
  }
}

function dshMarketPinText(p: DshMarketPlugin) {
  const parts = []
  if (p.stars) parts.push(`★ ${p.stars}`)
  if (p.downloads) parts.push(`${p.downloads} 次下载`)
  if (p.version) parts.push('v' + p.version)
  return parts.join(' · ')
}

// —— 检查更新 ——
const appVersion = ref('')
const updateChecking = ref(false)
const updateResult = ref<any>(null)
const updateMsg = ref('')
// 手动检查出「有新版本」时把结果行变成可点入口（点了直接去插件市场更新）
const hasUpdate = computed(() => !!(updateResult.value && updateResult.value.ok && updateResult.value.hasUpdate))
// 反馈入口是软性内容，与版本信息不同性质，收进折叠
const aboutFolds = reactive({ feedback: false })

// —— 用量趋势 ——
// 宿主按「账本历史保留天数」给足（默认 365 天），图表按 usageRange 截尾部显示，「本月汇总」用整段算
const usageHistory = ref<Array<{ date: string; usage: number }>>([])
const usageCurrency = ref('CNY')
// 可选区间：上限就是保留天数，超出的天数账本里本来就没有
const USAGE_RANGES = [7, 14, 30, 90, 180] as const
type UsageRange = (typeof USAGE_RANGES)[number]
// 区间是纯前端显示口径，不进宿主配置（没必要为它跑 IPC 与同步），但必须跨启动记住，
// 否则每次重开插件都弹回 7 天。localStorage 在 uTools 的 file:// 下可用且按插件目录隔离
const USAGE_RANGE_KEY = 'whale:usageRange'
function loadUsageRange(): UsageRange {
  try {
    const n = Number(localStorage.getItem(USAGE_RANGE_KEY))
    // 白名单校验：存过旧版本/被手改过的值可能已不在 USAGE_RANGES 里
    if ((USAGE_RANGES as readonly number[]).includes(n)) return n as UsageRange
  } catch (err) {}
  return 7
}
const usageRange = ref<UsageRange>(loadUsageRange())
function setUsageRange(r: UsageRange) {
  usageRange.value = r
  try { localStorage.setItem(USAGE_RANGE_KEY, String(r)) } catch (err) {}
}
// 保留天数之外的区间不显示（保留 35 天时点「180 天」只会看到一小段柱子，容易以为数据丢了）
const usageRangeTabs = computed(() => USAGE_RANGES.filter((r) => r <= cfg.historyKeepDays))
const exportFlash: Flash = useFlash()
const importFlash: Flash = useFlash()
// 今日被防误判拦下的余额变动（赠送额到期/异常跳变，未计入今日已用）
const todayAdjust = ref(0)
// 额度「不重置」口径的累计已用（宿主归档累计 + 今天；滚动累计不受历史裁剪影响，不能自己求和）
const cumUsed = ref(0)
const lastAdjustWhy = ref('')
const lastAdjustAt = ref('')
// 手动校准今日已用
const calibrateInput = ref<number | null>(null)
const calibrateFlash: Flash = useFlash()
const adjustTimeText = computed(() => {
  const t = Date.parse(lastAdjustAt.value)
  if (!isFinite(t)) return ''
  const d = new Date(t)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return p2(d.getHours()) + ':' + p2(d.getMinutes())
})
// v-model.number 清空输入框时值为 ''（未输入时为 null），两种都视为未填
const calibrateInputEmpty = computed(() =>
  calibrateInput.value === null || (calibrateInput.value as unknown) === '')
// 图表实际渲染的区间（尾部 usageRange 天）
const chartDays = computed(() => usageHistory.value.slice(-usageRange.value))
const historyMax = computed(() => {
  let m = 0
  for (const d of chartDays.value) if (d.usage > m) m = d.usage
  return m
})
// 本月汇总：从 31 天里筛出本月日期。日均按「本月已过天数」摊（含今天），
// 否则月初会被整月的空白天数摊薄成一个没意义的小数
const monthStats = computed(() => {
  const now = new Date()
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
  const elapsed = now.getDate()
  let total = 0
  let peak = 0
  for (const d of usageHistory.value) {
    if (d.date.slice(0, 7) !== ym) continue
    total += d.usage
    if (d.usage > peak) peak = d.usage
  }
  return { total, peak, avg: elapsed > 0 ? total / elapsed : 0, elapsed }
})
// —— 额度（资源包 / 订阅）——
// 已用按重置周期取口径：不重置 = 归档累计（cumUsed）/ 每月 = 本月累计 / 每日 = 今日
// （usageHistory 按日期升序，最后一条就是今天，来源同「本月汇总」，不再单独请求）
const quotaUsed = computed(() => {
  if (cfg.quotaReset === 'never') return cumUsed.value
  if (cfg.quotaReset === 'daily') return usageHistory.value.length ? usageHistory.value[usageHistory.value.length - 1].usage : 0
  return monthStats.value.total
})
const quotaPeriodText = computed(() =>
  cfg.quotaReset === 'never' ? '累计已用' : cfg.quotaReset === 'daily' ? '今日已用' : '本月已用')
const quotaPct = computed(() =>
  cfg.quotaTotal > 0 ? Math.min(100, Math.round((quotaUsed.value / cfg.quotaTotal) * 100)) : 0)
const quotaLeft = computed(() => Math.max(0, cfg.quotaTotal - quotaUsed.value))
// 柱子多的时候标签要抽稀（约每 6 个柱子留一个），否则会糊成一片
const labelEvery = computed(() => Math.max(1, Math.round(usageRange.value / 6)))
function dayLabel(date: string) {
  return date.slice(5).replace('-', '/')
}
function barHeight(u: number) {
  return historyMax.value > 0 ? Math.max(3, Math.round((u / historyMax.value) * 100)) : 0
}
function fmtMoney(v: number) {
  const num = Number(v) || 0
  return usageCurrency.value === 'CNY' ? '¥ ' + num.toFixed(2) : num.toFixed(2) + ' ' + usageCurrency.value
}
// 导出账本用量为 CSV（宿主弹系统保存框；用户取消时静默）
function exportUsageCsv() {
  exportFlash.msg = ''
  exportFlash.err = false
  try {
    const r = services.exportUsageCsv?.(usageRange.value)
    if (!r) {
      exportFlash.err = true
      exportFlash.msg = '导出失败：宿主 API 不可用'
    } else if (r.ok) {
      exportFlash.msg = '已导出到：' + (r.path || '')
    } else if (!r.canceled) {
      exportFlash.err = true
      exportFlash.msg = '导出失败：' + (r.error || '未知错误')
    }
  } catch (err: any) {
    exportFlash.err = true
    exportFlash.msg = '导出失败：' + String(err?.message || err)
  }
}
// 导入账本用量 CSV（宿主弹系统打开框；合并后刷新趋势；用户取消时静默）
function importUsageCsv() {
  importFlash.msg = ''
  importFlash.err = false
  try {
    const r = services.importUsageCsv?.()
    if (!r) {
      importFlash.err = true
      importFlash.msg = '导入失败：宿主 API 不可用'
    } else if (r.ok) {
      const ignored = r.invalid ? '，忽略 ' + r.invalid + ' 行非法数据' : ''
      importFlash.msg = `已导入 ${r.imported} 天${ignored}；账本现有 ${r.kept} 天（${r.from} ~ ${r.to}）`
      refreshHistory()
    } else if (!r.canceled) {
      importFlash.err = true
      importFlash.msg = '导入失败：' + (r.error || '未知错误')
    }
  } catch (err: any) {
    importFlash.err = true
    importFlash.msg = '导入失败：' + String(err?.message || err)
  }
}
// 用量趋势：令牌模式下挂件刷新后今日总量会写入账本，
// 因此导入后、切用量模式、以及本窗口重新获得焦点时都要重新拉一次趋势。
// 一次拉满保留天数（宿主上限），图表区间由 usageRange 在前端截取，避免切范围时重新请求
function refreshHistory() {
  const h = services.getUsageHistory?.(cfg.historyKeepDays)
  if (h && Array.isArray(h.days)) {
    usageHistory.value = h.days
    usageCurrency.value = h.currency || 'CNY'
    todayAdjust.value = Number(h.todayAdjust) || 0
    cumUsed.value = Number(h.cumUsed) || 0
    lastAdjustWhy.value = h.lastAdjustWhy || ''
    lastAdjustAt.value = h.lastAdjustAt || ''
  }
  // 明细区展开着就顺手一起刷新（校准 / 导入 / 切用量模式后都要跟着变）
  if (detailOpen.value) refreshDetail()
}

// —— 账本明细（可折叠）——
// 数据源是宿主账本：每日用量 + 当天的「未计入用量的余额变动」「手动校准」记录。
// 展开时才取一次（拉满保留天数），区间跟着上方区间切换在前端截取，筛选也在前端做。
const detailOpen = ref(false)
const detailDays = ref<LedgerDetailDay[]>([])
const detailQuery = ref('')
// 类型筛选：两类记录字段完全不同（adjust 是金额 + 原因，calibrate 是校准前后），
// 混在一起时想只看校准只能靠关键词「校准」去猜，这里给个显式开关
const detailKind = ref<'all' | 'adjust' | 'calibrate'>('all')
const openDays = ref<string[]>([])
function refreshDetail() {
  const r = services.getUsageDetail?.(cfg.historyKeepDays)
  detailDays.value = r && Array.isArray(r.days) ? r.days : []
}
function toggleDetail() {
  detailOpen.value = !detailOpen.value
  if (detailOpen.value) refreshDetail()
}
function toggleDay(date: string) {
  const i = openDays.value.indexOf(date)
  if (i >= 0) openDays.value.splice(i, 1)
  else openDays.value.push(date)
}
// 是否处于筛选态（类型不是「全部」或有关键词）。筛选态下按「命中条目」展示，不筛时原样显示区间内所有天。
const detailFiltered = computed(() => detailKind.value !== 'all' || !!detailQuery.value.trim())
// 筛选命中做到「条目级」：只保留命中的条目，整天都没有命中条目就整天不显示。
// 早先只做「整天保留」，某天有一条命中就把当天全部记录都列出来，还得逐天点开找是哪条。
const detailRows = computed(() => {
  const base = detailDays.value.slice(-usageRange.value)
  const kw = detailQuery.value.trim().toLowerCase()
  const kind = detailKind.value
  if (kind === 'all' && !kw) return base
  const out: LedgerDetailDay[] = []
  for (const d of base) {
    // 关键词命中日期串（如 09-12）时保留当天全部条目 —— 用户就是按日期找那一天
    const dateHit = !!kw && d.date.indexOf(kw) >= 0
    let entries = kind === 'all' ? d.entries : d.entries.filter((e) => e.kind === kind)
    if (kw && !dateHit) entries = entries.filter((e) => entryText(e).toLowerCase().indexOf(kw) >= 0)
    if (!dateHit && !entries.length) continue
    out.push({ date: d.date, usage: d.usage, entries })
  }
  return out
})
const detailTotal = computed(() => detailRows.value.reduce((a, d) => a + d.usage, 0))
// 筛选态下强制展开：否则命中了还要一天天点开才知道是哪条命中
function dayOpen(date: string) {
  return detailFiltered.value || openDays.value.indexOf(date) >= 0
}
// 当天「未计入用量」的变动合计（adjust 条目；calibrate 不是余额变动，不参与）
function adjustSumOf(d: LedgerDetailDay) {
  return d.entries.reduce((a, e) => a + (e.kind === 'adjust' ? Number(e.amount) || 0 : 0), 0)
}
function entryTime(e: LedgerDetailEntry) {
  const t = Date.parse(e.at)
  if (!isFinite(t)) return ''
  const d = new Date(t)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}
function entryText(e: LedgerDetailEntry) {
  if (e.kind === 'calibrate') return `手动校准：${fmtMoney(e.from || 0)} → ${fmtMoney(e.to || 0)}`
  return `${fmtMoney(e.amount || 0)} 未计入用量${e.why ? '（' + e.why + '）' : ''}`
}
// 今日模型占比（仅令牌模式）：模型明细只有平台用量接口会给，记账模式拿不到，页面不显示
const todayModels = ref<ModelUsageRow[]>([])
const modelsLoading = ref(false)
const modelsErr = ref('')
const modelsAt = ref(0)
// 占比条配色：与趋势柱的蓝色系区分开，方便一眼分辨不同模型
const MODEL_COLORS = ['#5b7fd4', '#7fb0e8', '#57c2b0', '#e0a45c', '#b185d8', '#e07b8e']
const modelsSum = computed(() => todayModels.value.reduce((a, r) => a + (Number(r.amount) || 0), 0))
const modelsTimeText = computed(() => {
  if (!modelsAt.value) return ''
  const d = new Date(modelsAt.value)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
})
// 模型显示名：平台用量接口回的是模型 id（如 deepseek-v4-flash），原样铺在占比条上不好读。
// 只做「友好标注」，不合并数据、不改金额；原始 id 放 title 里悬浮可见。
const MODEL_LABELS: Record<string, string> = {
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash 视觉版（实验）',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
}
function modelLabel(m: string) {
  if (!m) return '未知模型'
  return MODEL_LABELS[m.toLowerCase()] || m
}
function modelPct(amount: number) {
  return modelsSum.value > 0 ? Math.round((amount / modelsSum.value) * 100) : 0
}
// 拉取今日各模型金额：一次联网请求，只在令牌模式且本页可见时调用
async function refreshTodayModels() {
  if (cfg.usageMode !== 'token') {
    todayModels.value = []
    modelsErr.value = ''
    return
  }
  modelsLoading.value = true
  try {
    const r = await services.getTodayModels?.()
    if (r && r.ok) {
      todayModels.value = Array.isArray(r.models) ? r.models : []
      modelsErr.value = ''
      modelsAt.value = Date.now()
    } else {
      todayModels.value = []
      modelsErr.value = (r && r.error) || '宿主 API 不可用'
    }
  } catch (err: any) {
    todayModels.value = []
    modelsErr.value = String(err?.message || err)
  } finally {
    modelsLoading.value = false
  }
}
// 手动校准今日已用：记账漏采/误判后可直接改成真实金额，余额基准不动，之后继续实时累加
function calibrateToday() {
  calibrateFlash.msg = ''
  calibrateFlash.err = false
  // v-model.number 清空输入框会得到 ''，Number('')===0，必须先拦掉，否则会误把用量清零
  if (calibrateInputEmpty.value) {
    calibrateFlash.err = true
    calibrateFlash.msg = '请先输入实际金额'
    return
  }
  const v = Number(calibrateInput.value)
  if (!isFinite(v) || v < 0) {
    calibrateFlash.err = true
    calibrateFlash.msg = '请输入不小于 0 的金额'
    return
  }
  try {
    const r = services.calibrateTodayUsage?.(v)
    if (!r || !r.ok) {
      calibrateFlash.err = true
      calibrateFlash.msg = '校准失败：' + (r?.error || '宿主 API 不可用')
      return
    }
    calibrateFlash.msg = `已将今日已用校准为 ${fmtMoney(r.to ?? v)}（原 ${fmtMoney(r.from ?? 0)}），之后余额继续实时记账`
    calibrateInput.value = null
    refreshHistory()
  } catch (err: any) {
    calibrateFlash.err = true
    calibrateFlash.msg = '校准失败：' + String(err?.message || err)
  }
}

// —— 多厂商模型（余额 / 额度） ——
// 列表第一行是内置 DeepSeek（余额走原有链路，不可编辑/删除），其余来自 config.models。
// 余额与额度是宿主的运行时快照（whale:models），不进配置也不进备份，所以每次都要现取。
const models = ref<WhaleModelRow[]>([])
const modelConfigs = ref<WhaleModel[]>([])
const modelsMainId = ref('deepseek')
const modelTpls = ref<Record<string, WhaleModelTemplate>>({})
const modelMax = ref(10)
const modelsFlash: Flash = useFlash()
// 正在测试的模型 id（'' = 空闲）：防连点，也让按钮能显示「测试中…」
const modelTesting = ref('')
const modelsRefreshing = ref(false)
// 展开编辑的行：NEW_MODEL_ROW = 新增草稿，其余为模型 id，'' = 全部收起
const modelOpen = ref('')
// 行内密钥输入框（不回显已存密钥，只表示「本次要改成什么」；留空 = 不改）
const modelKeys = reactive<Record<string, string>>({})
// 每行的「高级」折叠（字段路径等低频项默认收起）
const modelAdv = reactive<Record<string, boolean>>({})
// 行内编辑表单（modelOpen 非空时有值）与它的校验提示
const modelForm = ref<WhaleModel | null>(null)
const modelFormErr = ref('')
// 删除二次确认（与「数据与隐私」一致走行内确认条，不用 window.confirm）
const modelDelConfirm = ref('')
// 新增草稿的哨兵行 id：让草稿也走同一套行内表单，表单渲染逻辑不用写两份
const NEW_MODEL_ROW = '__new'
const modelRows = computed<WhaleModelRow[]>(() => {
  if (modelOpen.value !== NEW_MODEL_ROW) return models.value
  return models.value.concat([{
    id: NEW_MODEL_ROW, name: modelForm.value?.name || '新模型', kind: 'balance', currency: 'CNY',
    builtin: false, balance: null, todayUsage: null, usedPct: null, resetAt: 0, windows: null, at: 0,
    tokens: null, monthTokens: null, codexWindows: null,
    error: '', lowAlertOn: true, lowAlertAmount: 0,
  }])
})
// Codex 订阅窗口的重置倒计时心跳：卡片与模型列表行都用到，任一处有窗口数据就跑（30s 一跳，
// 够分钟级显示用）。放在 models 之后是因为要读它，写在前面会踩 const 的 TDZ
const codexTickNeed = computed(() => !!codexWindows.value ||
  models.value.some((m) => m.kind === 'codex' && !!m.codexWindows))
const codexNow = ref(Date.now())
let codexTickTimer = 0
watch(codexTickNeed, () => {
  if (codexTickNeed.value && !codexTickTimer) codexTickTimer = window.setInterval(() => { codexNow.value = Date.now() }, 30000)
  else if (!codexTickNeed.value && codexTickTimer) { window.clearInterval(codexTickTimer); codexTickTimer = 0 }
}, { immediate: true })
// 可选模板：内置 DeepSeek 已经占了列表第一行，不再作为可添加项（正在编辑的除外，否则下拉里没有当前值）
const modelTplOptions = computed(() => {
  const cur = modelForm.value ? modelForm.value.tpl : ''
  return Object.keys(modelTpls.value)
    .filter((k) => !modelTpls.value[k].builtin || k === cur)
    .map((k) => ({ key: k, name: modelTpls.value[k].name }))
})

function reloadModels() {
  const r = services.getModels?.()
  if (r && Array.isArray(r.list)) {
    models.value = r.list
    modelsMainId.value = r.mainModelId || 'deepseek'
  }
  modelConfigs.value = services.getModelsConfig?.() || []
}
function loadModelTemplates() {
  const r = services.getModelTemplates?.()
  if (!r) return
  modelTpls.value = r.templates || {}
  modelMax.value = Number(r.max) || 10
}
// 按模板预填一份新条目（宿主 normModel 会对每个字段再清洗一次，这里只求「填得像样」）
function blankModel(tpl: string): WhaleModel {
  const t = modelTpls.value[tpl] || ({} as WhaleModelTemplate)
  const n = (v: number | undefined, d: number) => (typeof v === 'number' && isFinite(v) ? v : d)
  return {
    id: tpl, tpl: tpl,
    name: t.name || '',
    kind: t.kind || 'balance',
    currency: t.currency || 'CNY',
    auth: t.auth || 'bearer',
    url: t.url || '',
    baseUrl: '',
    path: t.path || '',
    scale: n(t.scale, 1),
    usedUrl: t.usedUrl || '',
    usedPath: t.usedPath || '',
    usedScale: n(t.usedScale, 1),
    usedPctPath: t.usedPctPath || '',
    remainPctPath: t.remainPctPath || '',
    remainPath: t.remainPath || '',
    totalPath: t.totalPath || '',
    resetPath: t.resetPath || '',
    // 多窗口额度只由模板预填（设置页不提供编辑）；显式写空数组，
    // 换模板时才能把上一个模板留下的窗口清掉
    windows: (t.windows || []).map((w) => ({ ...w })),
    lowAlertOn: true,
    lowAlertAmount: LOW_ALERT_DEFAULT[t.currency === 'USD' ? 'USD' : 'CNY'],
  }
}
// 模型 id 是密钥槽位的键，必须唯一（用户看不见它，由这里保证）
function freeModelId(base: string) {
  const used = modelConfigs.value.map((m) => m.id)
  if (used.indexOf(base) < 0) return base
  for (let i = 2; i < 100; i++) {
    if (used.indexOf(base + '-' + i) < 0) return base + '-' + i
  }
  return base + '-' + Date.now().toString(36)
}
// 换模板 = 按新模板重新预填接口地址与字段路径（用户手填的路径会被覆盖，这是「换厂商」的预期）
function applyModelTpl() {
  const f = modelForm.value
  if (!f) return
  const t = modelTpls.value[f.tpl] || ({} as WhaleModelTemplate)
  const n = (v: number | undefined, d: number) => (typeof v === 'number' && isFinite(v) ? v : d)
  f.name = t.name || f.name
  f.kind = t.kind || 'balance'
  f.currency = t.currency || 'CNY'
  f.auth = t.auth || 'bearer'
  f.url = t.url || ''
  f.path = t.path || ''
  f.scale = n(t.scale, 1)
  f.usedUrl = t.usedUrl || ''
  f.usedPath = t.usedPath || ''
  f.usedScale = n(t.usedScale, 1)
  f.usedPctPath = t.usedPctPath || ''
  f.remainPctPath = t.remainPctPath || ''
  f.remainPath = t.remainPath || ''
  f.totalPath = t.totalPath || ''
  f.resetPath = t.resetPath || ''
  f.windows = (t.windows || []).map((w) => ({ ...w }))
  f.lowAlertAmount = LOW_ALERT_DEFAULT[t.currency === 'USD' ? 'USD' : 'CNY']
  if (modelOpen.value === NEW_MODEL_ROW) {
    // 草稿行的 id 跟着模板走，免得「先按 OpenRouter 建、又改成 Kimi」留下对不上的 id
    const old = f.id
    f.id = freeModelId(f.tpl)
    if (modelKeys[old] !== undefined) { modelKeys[f.id] = modelKeys[old]; delete modelKeys[old] }
  }
}
function openModelRow(id: string) {
  modelFormErr.value = ''
  modelDelConfirm.value = ''
  if (modelOpen.value === id) { modelOpen.value = ''; return }
  const c = modelConfigs.value.find((m) => m.id === id)
  if (!c) return
  modelForm.value = JSON.parse(JSON.stringify(c)) as WhaleModel
  modelKeys[id] = ''
  modelOpen.value = id
}
function openNewModel() {
  modelsFlash.msg = ''
  modelsFlash.err = false
  modelFormErr.value = ''
  if (modelConfigs.value.length >= modelMax.value) {
    modelsFlash.err = true
    modelsFlash.msg = `最多添加 ${modelMax.value} 个模型，请先删掉不用的`
    return
  }
  const f = blankModel('openrouter')
  f.id = freeModelId(f.tpl)
  modelForm.value = f
  modelKeys[f.id] = ''
  modelOpen.value = NEW_MODEL_ROW
}
function closeModelForm() {
  modelOpen.value = ''
  modelForm.value = null
  modelFormErr.value = ''
}
function saveModelForm() {
  const f = modelForm.value
  if (!f) return
  modelFormErr.value = ''
  if (!String(f.name || '').trim()) { modelFormErr.value = '请填写名称'; return }
  // Codex 走本地会话统计，没有接口地址可填
  if (f.kind !== 'codex' && !String(f.url || '').trim()) { modelFormErr.value = '请填写接口地址'; return }
  const isNew = modelOpen.value === NEW_MODEL_ROW
  const typed = modelKeys[f.id] || ''
  try {
    // 编辑时密钥留空 = 不动已存的那把（传 undefined）；新增时必须传（空串 = 先存配置、后补密钥）
    const r = services.saveModel?.(f, isNew ? typed : (typed || undefined))
    if (!r || !r.ok) { modelFormErr.value = '保存失败：' + (r?.error || '宿主 API 不可用'); return }
    closeModelForm()
    reloadModels()
    modelsFlash.err = false
    modelsFlash.msg = '已保存'
  } catch (err: any) {
    modelFormErr.value = '保存失败：' + String(err?.message || err)
  }
}
async function testModelForm() {
  const f = modelForm.value
  if (!f) return
  modelFormErr.value = ''
  modelsFlash.msg = ''
  modelTesting.value = f.id
  try {
    // 密钥留空 = 用该模型已保存的那把（宿主会回落到密钥槽位）
    const r = await services.testModel?.(f, modelKeys[f.id] || '')
    if (!r) { modelFormErr.value = '宿主接口不可用'; return }
    if (!r.ok) { modelFormErr.value = '连接失败：' + (r.error || '未知错误'); return }
    modelsFlash.err = false
    if (typeof r.tokens === 'number') {
      modelsFlash.msg = `${f.name}：今日 ${fmtTokens(r.tokens)} token`
      return
    }
    const ws = r.windows
    modelsFlash.msg = typeof r.usedPct === 'number'
      ? (ws && ws.length > 1
        // 多窗口接口：逐窗口列出已用%，只报首个窗口会漏掉周/月额度
        ? `${f.name}：` + ws.map((w) => w.label + ' 已用 ' + w.usedPct + '%').join(' · ') + resetSuffix(r.resetAt)
        : `${f.name}：已用 ${r.usedPct}%${resetSuffix(r.resetAt)}`)
      : `${f.name}：余额 ${fmtModelMoney(r.balance, f.currency)}`
  } catch (err: any) {
    modelFormErr.value = '连接失败：' + String(err?.message || err)
  } finally {
    modelTesting.value = ''
  }
}
function resetSuffix(at?: number) {
  if (!at) return ''
  const d = new Date(at)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `，${d.getMonth() + 1}-${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())} 重置`
}
// 余额一律按原币种显示（与挂件口径一致，不折算汇率）
function fmtModelMoney(v: number | null | undefined, currency: string) {
  const num = Number(v)
  if (v === null || v === undefined || !isFinite(num)) return '—'
  return currency === 'USD' ? '$' + num.toFixed(2) : '¥ ' + num.toFixed(2)
}
// 列表里的余额/额度展示：额度类是百分比，Codex 是 token 数，余额类按原币种显示
function modelValueText(m: WhaleModelRow) {
  if (m.kind === 'quota') return typeof m.usedPct === 'number' ? '已用 ' + m.usedPct + '%' : '—'
  if (m.kind === 'codex') return typeof m.tokens === 'number' ? fmtTokens(m.tokens) : '—'
  return fmtModelMoney(m.balance, m.currency)
}
function modelSubText(m: WhaleModelRow) {
  if (m.error) return '查询失败：' + m.error
  if (m.kind === 'codex') {
    const base = typeof m.monthTokens === 'number' ? '今日 token · 本月 ' + fmtTokens(m.monthTokens) : ''
    // 订阅窗口（5h / 周）：与 Codex 卡片同一份文案，没有订阅时只有上面的 token 数
    const win = codexWinText(m.codexWindows)
    return win ? (base ? base + ' | ' + win : win) : base
  }
  if (m.kind === 'quota') {
    // 多窗口接口（OpenCode Go 的 5h/周/月、MiniMax 的 5h/周）：逐个列出，只显示首个窗口会漏掉周/月额度
    if (m.windows && m.windows.length > 1) {
      return m.windows.map((w) => w.label + ' ' + w.usedPct + '%').join(' · ') + resetSuffix(m.resetAt)
    }
    return m.resetAt ? resetSuffix(m.resetAt).replace(/^，/, '') : ''
  }
  if (typeof m.todayUsage === 'number') return '今日约 ' + fmtModelMoney(m.todayUsage, m.currency)
  if (m.at) {
    const d = new Date(m.at)
    return '更新于 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  return ''
}
function setMainModelRow(id: string) {
  modelsFlash.msg = ''
  const r = services.setMainModel?.(id)
  if (!r || !r.ok) {
    modelsFlash.err = true
    modelsFlash.msg = '切换主显示失败：' + (r?.error || '宿主 API 不可用')
    return
  }
  // 单选以宿主回值为准（它会把非法 id 回退成 DeepSeek）
  modelsMainId.value = r.mainModelId || id
  modelsFlash.err = false
  modelsFlash.msg = id === 'deepseek' ? '挂件已切回 DeepSeek 余额' : '挂件主显示已切换'
}
async function refreshModelRows(ids?: string[]) {
  if (modelsRefreshing.value) return
  modelsRefreshing.value = true
  modelsFlash.msg = ''
  modelsFlash.err = false
  try {
    await services.refreshModels?.(ids && ids.length ? ids : null, true)
    reloadModels()
    modelsFlash.msg = '已刷新'
  } catch (err: any) {
    modelsFlash.err = true
    modelsFlash.msg = '刷新失败：' + String(err?.message || err)
  } finally {
    modelsRefreshing.value = false
  }
}
function removeModelRow(id: string) {
  const r = services.removeModel?.(id)
  if (!r || !r.ok) {
    modelsFlash.err = true
    modelsFlash.msg = '删除失败：' + (r?.error || '宿主 API 不可用')
    return
  }
  modelDelConfirm.value = ''
  if (modelOpen.value === id) closeModelForm()
  reloadModels()
  modelsFlash.err = false
  modelsFlash.msg = '已删除'
}

const MIN_SCALE = 0.6
const MAX_SCALE = 2.5
// 大小档位 1–15 线性映射到 MIN_SCALE–MAX_SCALE（原为 1–20，档位 20 即 2.5 倍太大，
// 收到 15 后最大约 2.1 倍）。档位数改动必须同步：此处的 SCALE_STEPS、
// numToScale 的钳制、scaleToNum 的分母，以及模板里 number 输入的 max，
// 并与浮动页 floating-page.js 的三处保持同值。
const SCALE_STEPS = 15
function scaleToNum(s: number) {
  return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1))) + 1
}
function numToScale(n: number) {
  const v = Math.max(1, Math.min(SCALE_STEPS, Math.round(n)))
  return MIN_SCALE + (v - 1) * ((MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1))
}
function onScaleLive() {
  // 拖动中：实时改窗口几何（不写存储），避免高频保存卡顿
  const s = Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(cfg.scale))) * 10) / 10
  cfg.scale = s
  cfg.scaleNum = scaleToNum(s)
  services.saveConfig?.({ scale: s, __live: true })
}
function onScaleNumLive() {
  const s = numToScale(cfg.scaleNum)
  cfg.scale = s
  services.saveConfig?.({ scale: s, __live: true })
}
function onScaleCommit() {
  // 松手/失焦：一次性持久化并同步给挂件
  const s = Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(cfg.scale))) * 10) / 10
  cfg.scale = s
  cfg.scaleNum = scaleToNum(s)
  services.saveConfig?.({ scale: s })
}
function patchCfg(p: Record<string, any>) {
  services.saveConfig?.(p)
}
// 打开「今日预算提醒」时补一个可用金额，避免开关开着但金额为 0（等于不提醒）
function onBudgetToggle() {
  if (cfg.budgetOn && !(cfg.budgetAmount > 0)) cfg.budgetAmount = 10
  patchCfg({ budgetOn: cfg.budgetOn, budgetAmount: cfg.budgetAmount })
}
// 同理：打开「余额大幅波动通知」时补一个可用阈值，避免开关开着但阈值为 0
function onDropToggle() {
  if (cfg.dropAlertOn && !(cfg.dropAlertAmount > 0)) cfg.dropAlertAmount = 5
  patchCfg({ dropAlertOn: cfg.dropAlertOn, dropAlertAmount: cfg.dropAlertAmount })
}
// —— 计时：时长三段输入 / 到点留言 / 「休息」档 ——
// 配置里只存总秒数（timerSec），三段输入是它的展示形态；
// 拆出来的 h/m/s 单独放一份本地状态，避免每次输入都被折算回秒再拆回来导致光标跳动
const TIMER_NOTE_MAX = 60
const timerHms = reactive({ h: 0, m: 0, s: 0 })
function syncTimerHms() {
  const sec = Math.max(0, Math.min(86399, Math.round(Number(cfg.timerSec) || 0)))
  timerHms.h = Math.floor(sec / 3600)
  timerHms.m = Math.floor((sec % 3600) / 60)
  timerHms.s = sec % 60
}
// 三段全填 0 时按 25 分钟兜底：否则「填了 0 就开不了计时」，且宿主侧清洗也会把它拉回默认值
function commitTimerHms() {
  const sec = Math.round(Number(timerHms.h) || 0) * 3600 + Math.round(Number(timerHms.m) || 0) * 60 + Math.round(Number(timerHms.s) || 0)
  cfg.timerSec = Math.max(1, Math.min(86399, sec || 1500))
  syncTimerHms()
  patchCfg({ timerSec: cfg.timerSec })
}
// 「休息」档：0 分钟 = 不显示休息按钮（与挂件菜单 hideBubble 后的按钮显隐同口径）
const timerBreakOn = computed({
  get: () => cfg.timerBreakMin > 0,
  set: (v: boolean) => { if (v && !(cfg.timerBreakMin > 0)) cfg.timerBreakMin = 5 },
})
const timerBreakMinEdit = computed({
  get: () => Math.max(1, cfg.timerBreakMin || 5),
  set: (v: number) => { cfg.timerBreakMin = Math.max(1, Math.min(120, Math.round(Number(v) || 5))) },
})
function onTimerBreakToggle() {
  patchCfg({ timerBreakMin: timerBreakOn.value ? (cfg.timerBreakMin > 0 ? cfg.timerBreakMin : 5) : 0 })
}
function commitTimerBreak() {
  patchCfg({ timerBreakMin: timerBreakMinEdit.value })
}
// —— 窗口透明度：拖动实时预览（只推 CSS opacity 不写存储），松手持久化 ——
function clampOpacity(v: number) {
  return Math.round(Math.max(20, Math.min(100, Number(v) || 100)))
}
function onOpacityLive() {
  cfg.opacity = clampOpacity(cfg.opacity)
  services.saveConfig?.({ opacity: cfg.opacity, __live: true })
}
function onOpacityCommit() {
  cfg.opacity = clampOpacity(cfg.opacity)
  services.saveConfig?.({ opacity: cfg.opacity })
}
// —— 自定义音效（按压/释放两段 + 四类提醒各一组，文件复制进本地数据目录） ——
// 每个槽位是「音效组」：可导入多段，挂件每次随机播一条
// 同值副本：preload 不参与打包，设置页读不到宿主常量（见 public/preload/lib/sounds.js 的 ROLES / ROLE_LABEL）
const SOUND_ROLES: SoundRole[] = ['press', 'release', 'low', 'budget', 'peak', 'pass']
// 四类提醒各自的提醒音：留空 = 静音（没有内置回落，不打扰是默认），导入后跟随音效开关与音量
const ALERT_SOUND_ROLES: SoundRole[] = ['low', 'budget', 'peak', 'pass']
const SOUND_ROLE_LABEL: Record<SoundRole, string> = {
  press: '按压音效', release: '释放音效',
  low: '低余额提醒音', budget: '预算提醒音', peak: '峰谷提醒音', pass: '穿透提醒音',
}
// 提醒音「什么时候响」：写进 label 的 title，免得用户猜
const ALERT_SOUND_WHEN: Record<string, string> = {
  low: '余额首次跌破预警阈值时',
  budget: '今日用量首次超出预算时',
  peak: '进入峰时段 / 谷时段时',
  pass: '切换鼠标穿透时',
}
// 六槽位统一初始化：宿主返回值缺键时也保证是空值（模板里到处取值）
function blankSoundMap<T>(fill: T): Record<SoundRole, T> {
  const out = {} as Record<SoundRole, T>
  for (const r of SOUND_ROLES) out[r] = fill
  return out
}
const soundsMeta = ref(blankSoundMap<SoundMeta[]>([]))
// 音效本体（base64 data URL）只用于「试听」：元信息里只有文件名，播不了
const soundData = ref(blankSoundMap<string[]>([]))
const soundFlash: Flash = useFlash()
// 试听实例放在模块级：再点「试听」先停掉上一个，避免两段音频叠在一起
let previewAudio: HTMLAudioElement | null = null
// 波形裁剪弹层：非空时显示（选文件 → 裁剪 → 确认后才落盘）
const soundTrim = ref<{ dataUrl: string; name: string; role: SoundRole } | null>(null)
// 模板里取某个槽位的元信息：直接写 soundsMeta[r] 的索引访问收窄不稳，统一走这个小函数
function soundMetaOf(role: SoundRole): SoundMeta[] {
  return soundsMeta.value[role] || []
}
// 槽位概览文案：一段就报名字，多段报「首个 等 N 段」
function soundLabel(role: SoundRole): string {
  const list = soundMetaOf(role)
  if (!list.length) return ''
  return list.length === 1 ? list[0].name : `${list[0].name} 等 ${list.length} 段`
}
function refreshSounds() {
  const m = services.getSounds?.()
  const next = blankSoundMap<SoundMeta[]>([])
  if (m) for (const r of SOUND_ROLES) next[r] = m[r] || []
  soundsMeta.value = next
  const d = services.getSoundData?.()
  const nextData = blankSoundMap<string[]>([])
  if (d) for (const r of SOUND_ROLES) nextData[r] = d[r] || []
  soundData.value = nextData
}
function stopPreviewSound() {
  if (!previewAudio) return
  try { previewAudio.pause() } catch (err) {}
  previewAudio = null
}
// 试听一段音频（自定义音效与内置音色共用）：错误写进传入的消息态，各自卡片里显示
function playAudioUrl(url: string, flash: Flash) {
  stopPreviewSound()
  try {
    const el = new Audio(url)
    el.volume = Math.min(1, Math.max(0, cfg.vol))
    previewAudio = el
    el.onended = () => { if (previewAudio === el) previewAudio = null }
    // play() 是 Promise：解码失败或被自动播放策略拦下时给个提示，不要静默
    el.play().catch((err: any) => {
      flash.err = true
      flash.msg = '试听失败：' + String(err?.message || err)
    })
  } catch (err: any) {
    flash.err = true
    flash.msg = '试听失败：' + String(err?.message || err)
  }
}
// 试听某一段（idx 是该槽位音效组里的第几段）
function doPreviewSound(role: SoundRole, idx: number) {
  soundFlash.msg = ''
  soundFlash.err = false
  const url = soundData.value[role][idx]
  if (!url) {
    soundFlash.err = true
    soundFlash.msg = '没有可试听的音效，请先导入'
    return
  }
  playAudioUrl(url, soundFlash)
}
// 导入先取文件（宿主只读成 data URL，不落盘）→ 弹波形裁剪窗 → 确认后才写盘
function doImportSound(role: SoundRole) {
  soundFlash.msg = ''
  soundFlash.err = false
  try {
    const r = services.pickSoundFile?.()
    if (!r) {
      soundFlash.err = true
      soundFlash.msg = '宿主 API 不可用'
      return
    }
    if (r.canceled) return
    if (!r.ok || !r.dataUrl) {
      soundFlash.err = true
      soundFlash.msg = '导入失败：' + (r.error || '未知错误')
      return
    }
    soundTrim.value = { dataUrl: r.dataUrl, name: r.name || '', role: role }
  } catch (err: any) {
    soundFlash.err = true
    soundFlash.msg = '导入失败：' + String(err?.message || err)
  }
}
function onSoundTrimConfirm(p: { dataUrl: string; name: string }) {
  const role: SoundRole = soundTrim.value ? soundTrim.value.role : 'press'
  soundTrim.value = null
  soundFlash.msg = ''
  soundFlash.err = false
  try {
    const r = services.importSoundFromData?.(role, p.name, p.dataUrl)
    if (!r) {
      soundFlash.err = true
      soundFlash.msg = '宿主 API 不可用'
      return
    }
    if (!r.ok) {
      soundFlash.err = true
      soundFlash.msg = '导入失败：' + (r.error || '未知错误')
      return
    }
    soundFlash.msg = `已导入${SOUND_ROLE_LABEL[role]}「${r.name || p.name}」`
    refreshSounds()
  } catch (err: any) {
    soundFlash.err = true
    soundFlash.msg = '导入失败：' + String(err?.message || err)
  }
}
// 删除：给了 file 只删这一段，不给就清空整个槽位（批量清除走后者）
function doRemoveSound(role: SoundRole, file?: string) {
  soundFlash.msg = ''
  soundFlash.err = false
  try {
    const r = services.removeSound?.(role, file)
    if (r && r.ok) {
      soundFlash.msg = file ? `已删除${SOUND_ROLE_LABEL[role]}的一段` : `已删除${SOUND_ROLE_LABEL[role]}`
      refreshSounds()
    }
  } catch (err: any) {
    soundFlash.err = true
    soundFlash.msg = '删除失败：' + String(err?.message || err)
  }
}
// 切用量模式：趋势图的今日柱取数来源会变（记账累计 ↔ 平台今日总量），立即重拉一次；
// 模型占比只在令牌模式有意义，切过来时也要拉一次
function onUsageModeChange() {
  patchCfg({ usageMode: cfg.usageMode })
  refreshHistory()
  refreshTodayModels()
}
// 自定义单价改动：模型占比是拿新价现算的，立即重拉；挂件侧今日已用等下次余额刷新（有 TTL 缓存）
function onTokenPriceChange() {
  patchCfg({ tokenPrice: plainTokenPrice() })
  refreshTodayModels()
}
// 交给宿主前摊平成纯对象：cfg 是 reactive，数组元素是 Proxy，IPC 的结构化克隆搬不动
function plainTokenPrice(): WhaleTokenPrice {
  const tp = cfg.tokenPrice
  return {
    on: tp.on,
    cur: tp.cur === 'USD' ? 'USD' : 'CNY',
    rate: tp.rate,
    hit: tp.hit,
    miss: tp.miss,
    out: tp.out,
    models: tp.models.map((m) => ({ name: m.name, hit: m.hit, miss: m.miss, out: m.out })),
  }
}
// 「按模型覆盖」加一行：单价先给内置默认值，免得只填模型名的一行把该模型算成 0。
// 这里不落存储 —— 模型名还是空的，宿主会把它丢掉；等填上名字触发 change 再保存
function addPriceModel() {
  if (cfg.tokenPrice.models.length >= PRICE_MODEL_MAX) return
  cfg.tokenPrice.models.push({
    name: '', hit: TOKEN_PRICE_DEFAULT.hit, miss: TOKEN_PRICE_DEFAULT.miss, out: TOKEN_PRICE_DEFAULT.out,
  })
}
function removePriceModel(i: number) {
  cfg.tokenPrice.models.splice(i, 1)
  onTokenPriceChange()
}
// 账本历史保留天数改动：宿主按这个窗口裁剪与返回数据，改完要重新取一次；
// 顺带把超出新窗口的区间收回到可选范围内（否则图表只剩一小段，看着像数据被清了）
function onHistoryKeepChange() {
  const n = Number(cfg.historyKeepDays)
  const v = isFinite(n) ? Math.round(Math.min(HISTORY_KEEP.MAX, Math.max(HISTORY_KEEP.MIN, n))) : HISTORY_KEEP.DEFAULT
  cfg.historyKeepDays = v
  patchCfg({ historyKeepDays: v })
  const tabs = usageRangeTabs.value
  if (tabs.indexOf(usageRange.value) < 0) setUsageRange(tabs[tabs.length - 1])
  refreshHistory()
  refreshDetail()
}

// —— 自定义挂件形象画廊（多张图片，复制进本地数据目录） ——
const skinGallery = ref<SkinGallery>({ current: '', items: [] })
// 当前正在使用的那张的元信息（画廊为空时 null）
const skinMeta = computed<SkinMeta | null>(() => {
  const g = skinGallery.value
  return g.items.filter((it) => it.id === g.current)[0] || null
})
const skinFlash: Flash = useFlash()
// 裁剪弹层：非空时显示（选图片 → 裁剪 → 确认后才落盘）
const skinCrop = ref<{ dataUrl: string; name: string } | null>(null)
function refreshSkin() {
  const g = services.listSkins?.()
  skinGallery.value = g && Array.isArray(g.items) ? g : { current: '', items: [] }
}
// 缩略图（等比缩到 128px 内、PNG data URL）：画廊网格要同时显示多张，直接读原图（动图可能好几 MB）
// 既慢又占内存；宿主 preload 跑在渲染进程，没有 canvas / nativeImage 可用，只能在这里生成后传过去。
// 生成失败（图片损坏等）回空串，宿主侧会回落到原图或由网格显示占位
function makeThumb(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const iw = img.naturalWidth || img.width || 1
        const ih = img.naturalHeight || img.height || 1
        const scale = Math.min(1, 128 / Math.max(iw, ih))
        const cv = document.createElement('canvas')
        cv.width = Math.max(1, Math.round(iw * scale))
        cv.height = Math.max(1, Math.round(ih * scale))
        const ctx = cv.getContext('2d')
        if (!ctx) return resolve('')
        ctx.drawImage(img, 0, 0, cv.width, cv.height)
        resolve(cv.toDataURL('image/png'))
      } catch (err) {
        resolve('')
      }
    }
    img.onerror = () => resolve('')
    img.src = dataUrl
  })
}
// 导入先取文件（宿主只读成 data URL，不落盘）→ 弹裁剪窗 → 确认后才写盘。
// 导入后自动切到「自定义」：导了图却还在用内置形象会很困惑
async function doImportSkin() {
  skinFlash.msg = ''
  skinFlash.err = false
  try {
    const r = services.pickImageFile?.()
    if (!r) {
      skinFlash.err = true
      skinFlash.msg = '宿主 API 不可用'
      return
    }
    if (r.canceled) return
    if (!r.ok || !r.dataUrl) {
      skinFlash.err = true
      skinFlash.msg = '导入失败：' + (r.error || '未知错误')
      return
    }
    // 动图（gif/apng）走直接复制，不裁剪：canvas 只取首帧会丢掉动画
    if (r.ext === 'gif' || r.ext === 'apng') {
      const thumb = await makeThumb(r.dataUrl)
      const ir = services.importSkinFromPath?.(r.filePath || '', r.name || '', thumb)
      if (!ir) {
        skinFlash.err = true
        skinFlash.msg = '宿主 API 不可用'
        return
      }
      if (!ir.ok) {
        skinFlash.err = true
        skinFlash.msg = '导入失败：' + (ir.error || '未知错误')
        return
      }
      skinFlash.msg = `已导入形象「${ir.name || r.name || ''}」（动图不裁剪，保留动画）`
      refreshSkin()
      cfg.skin = 'custom'
      patchCfg({ skin: cfg.skin })
      return
    }
    skinCrop.value = { dataUrl: r.dataUrl, name: r.name || '' }
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '导入失败：' + String(err?.message || err)
  }
}
async function onSkinCropConfirm(p: { dataUrl: string; name: string }) {
  skinCrop.value = null
  skinFlash.msg = ''
  skinFlash.err = false
  try {
    const thumb = await makeThumb(p.dataUrl)
    const r = services.importSkinFromData?.(p.name, p.dataUrl, thumb)
    if (!r) {
      skinFlash.err = true
      skinFlash.msg = '宿主 API 不可用'
      return
    }
    if (!r.ok) {
      skinFlash.err = true
      skinFlash.msg = '导入失败：' + (r.error || '未知错误')
      return
    }
    skinFlash.msg = `已导入形象「${r.name || p.name}」`
    refreshSkin()
    cfg.skin = 'custom'
    patchCfg({ skin: cfg.skin })
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '导入失败：' + String(err?.message || err)
  }
}
// 随机换一个内置形象；「自定义」是用户自己导入的那张，不在抽签范围里。
// 抽到当前这张时再抽一次（只有一张内置形象的极端情况会抽不出来，那就保持原样）
function doRandomSkin() {
  const pool = BUILTIN_SKINS.filter(s => s !== cfg.skin)
  const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : cfg.skin
  cfg.skin = pick
  patchCfg({ skin: pick })
}

// 换用画廊里的某一张（顺带把「形象」切到自定义，否则点了没反应）
function doUseSkin(id: string) {
  skinFlash.msg = ''
  skinFlash.err = false
  try {
    const r = services.setSkinCurrent?.(id)
    if (!r || !r.ok) {
      skinFlash.err = true
      skinFlash.msg = '切换失败：' + ((r && r.error) || '未知错误')
      return
    }
    refreshSkin()
    if (cfg.skin !== 'custom') {
      cfg.skin = 'custom'
      patchCfg({ skin: cfg.skin })
    }
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '切换失败：' + String(err?.message || err)
  }
}
// 置顶：只调整画廊顺序，不改变正在使用的那张
function doPinSkin(id: string) {
  try {
    services.pinSkin?.(id)
    refreshSkin()
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '置顶失败：' + String(err?.message || err)
  }
}
function doRemoveSkin(id: string) {
  skinFlash.msg = ''
  skinFlash.err = false
  try {
    const r = services.removeSkin?.(id)
    if (!r || !r.ok) {
      skinFlash.err = true
      skinFlash.msg = '删除失败：' + ((r && r.error) || '未知错误')
      return
    }
    skinFlash.msg = '已删除该形象'
    refreshSkin()
    // 一张都不剩了还停在「自定义」就无图可显示，回退内置形象
    if (!skinGallery.value.items.length && cfg.skin === 'custom') {
      cfg.skin = DEFAULT_SKIN
      patchCfg({ skin: cfg.skin })
    }
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '删除失败：' + String(err?.message || err)
  }
}

// —— 自定义气泡图片（点鲸鱼抽到「动图组」时随机显示一张） ——
// 与形象的关键差别：没有「当前用哪张」——有图就随机抽，删光即自动回退内置 rua.gif，所以没有「使用中」标记。
// 也不裁剪（原图原样落盘）：气泡里放的多是动图或整图，canvas 重编码会丢动画帧。
const bubbleItems = ref<BubbleMeta[]>([])
const bubbleFlash: Flash = useFlash()
function refreshBubbles() {
  const r = services.listBubbles?.()
  bubbleItems.value = r && Array.isArray(r.items) ? r.items : []
}
// 导入：先取文件（宿主只读成 data URL，不落盘）→ 生成缩略图 → 写盘
async function doImportBubble() {
  bubbleFlash.msg = ''
  bubbleFlash.err = false
  try {
    const r = services.pickBubbleFile?.()
    if (!r) {
      bubbleFlash.err = true
      bubbleFlash.msg = '宿主 API 不可用'
      return
    }
    if (r.canceled) return
    if (!r.ok || !r.dataUrl) {
      bubbleFlash.err = true
      bubbleFlash.msg = '导入失败：' + (r.error || '未知错误')
      return
    }
    const thumb = await makeThumb(r.dataUrl)
    const ir = services.importBubbleFromData?.(r.name || '', r.dataUrl, thumb)
    if (!ir) {
      bubbleFlash.err = true
      bubbleFlash.msg = '宿主 API 不可用'
      return
    }
    if (!ir.ok) {
      bubbleFlash.err = true
      bubbleFlash.msg = '导入失败：' + (ir.error || '未知错误')
      return
    }
    bubbleFlash.msg = `已导入气泡图「${ir.name || r.name || ''}」，点小鲸鱼时会随机显示`
    refreshBubbles()
  } catch (err: any) {
    bubbleFlash.err = true
    bubbleFlash.msg = '导入失败：' + String(err?.message || err)
  }
}
function doRemoveBubble(id: string) {
  bubbleFlash.msg = ''
  bubbleFlash.err = false
  try {
    const r = services.removeBubble?.(id)
    if (!r || !r.ok) {
      bubbleFlash.err = true
      bubbleFlash.msg = '删除失败：' + ((r && r.error) || '未知错误')
      return
    }
    bubbleFlash.msg = r.left ? '已删除该气泡图' : '已删除最后一张气泡图，挂件回退内置动图'
    refreshBubbles()
  } catch (err: any) {
    bubbleFlash.err = true
    bubbleFlash.msg = '删除失败：' + String(err?.message || err)
  }
}

// —— 自定义素材（形象 + 气泡图 + 六段音效的集中管理） ——
// 与「挂件外观」分工：那边只管「用哪个」（选内置还是自定义），这里管「导了什么、占多大、要不要删」。
// 素材管理不跟着「形象 / 音色」的选择走 —— 之前藏在 v-if="cfg.skin === 'custom'" 里，
// 一旦切回内置形象，导入的素材在界面上就消失了（磁盘上还占着），既看不到也删不掉。
const hasAssets = computed(() => !!skinMeta.value || bubbleItems.value.length > 0
  || SOUND_ROLES.some((r) => soundsMeta.value[r].length > 0))
// 素材在、但设置没在用（形象/音色选的是内置）时提示一句，免得用户以为导入没生效。
// 只管按压/释放两段：提醒音与「音色」无关，只受音效开关与音量影响
const skinUnused = computed(() => !!skinMeta.value && cfg.skin !== 'custom')
const soundUnused = computed(() => (soundsMeta.value.press.length > 0 || soundsMeta.value.release.length > 0)
  && (!cfg.soundOn || cfg.soundSet !== 'custom'))
// 体积展示：元信息里的 size 由宿主读取时派生，文件缺失为 0
function fmtBytes(n: number) {
  const v = Number(n) || 0
  if (v <= 0) return '0 KB'
  return v < 1024 * 1024 ? Math.max(1, Math.round(v / 1024)) + ' KB' : (v / 1024 / 1024).toFixed(1) + ' MB'
}
function assetSize(m: { size?: number } | null) {
  const n = Number(m && m.size) || 0
  return n > 0 ? fmtBytes(n) : '体积未知'
}
function assetAt(m: { at?: number } | null) {
  const t = Number(m && m.at) || 0
  if (!t) return ''
  const d = new Date(t)
  const p2 = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
// 全部清除：形象 + 气泡图 + 六段音效（与「数据与隐私」里的按项清除同源，但只清素材、不动其它数据）。
// 清完把形象/音色从「自定义」回退为内置，避免停在「自定义」却无素材可用
function doClearAssets() {
  skinFlash.msg = ''
  soundFlash.msg = ''
  bubbleFlash.msg = ''
  skinFlash.err = false
  soundFlash.err = false
  bubbleFlash.err = false
  try {
    let failed = ''
    // 画廊是多张，逐张删（宿主没有「清空画廊」以外的批量接口，逐张删能看出哪张失败）
    for (const it of skinGallery.value.items.slice()) {
      const r = services.removeSkin?.(it.id)
      if (!r || !r.ok) failed = '形象'
    }
    for (const it of bubbleItems.value.slice()) {
      const r = services.removeBubble?.(it.id)
      if (!r || !r.ok) failed = failed || '气泡图'
    }
    for (const role of SOUND_ROLES) {
      if (!soundsMeta.value[role].length) continue
      const r = services.removeSound?.(role)
      if (!r || !r.ok) failed = failed || SOUND_ROLE_LABEL[role]
    }
    refreshSkin()
    refreshBubbles()
    refreshSounds()
    if (failed) {
      skinFlash.err = true
      skinFlash.msg = `部分素材清除失败：${failed}`
      return
    }
    skinFlash.msg = '已清除全部导入素材'
    if (cfg.skin === 'custom') {
      cfg.skin = DEFAULT_SKIN
      patchCfg({ skin: cfg.skin })
    }
    if (cfg.soundSet === 'custom') {
      cfg.soundSet = 'duck'
      patchCfg({ soundSet: cfg.soundSet })
    }
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '清除失败：' + String(err?.message || err)
  }
}

// —— 「资源」Tab：素材总览 / 素材包 / 内置资源对照 ——
// 素材包容器格式与导入语义见 public/preload/lib/assets.js；这里只做界面编排。
// 素材包不落配置（导完就完事），所以不涉及「配置四处同步铁律」。
const assetsFold = reactive({ open: false })
const assetsFlash: Flash = useFlash()
const assetsBusy = ref(false)
const assetsPack = ref<AssetsPreviewResult | null>(null)
const assetsPicks = reactive({ skins: true, sounds: true, bubbles: true })
const assetsConfirm = ref(false)
const assetsAnyItem = computed(() => (assetsPicks.skins && !!assetsPack.value?.has?.skins)
  || (assetsPicks.sounds && !!assetsPack.value?.has?.sounds)
  || (assetsPicks.bubbles && !!assetsPack.value?.has?.bubbles))
// 内置音色（同值副本：public/floating-page.js 的 SOUND_FILES，加一组要两处一起改）
const BUILTIN_SOUND_SETS: Array<{ key: string; label: string; press: string; release: string }> = [
  { key: 'duck', label: '小黄鸭', press: './whale/Ya1.mp3', release: './whale/Ya2.mp3' },
  { key: 'fx1', label: '音效1', press: './whale/D1.mp3', release: './whale/D2.mp3' },
]
// 内置形象图片路径：同值副本（public/floating-page.js 的 BUILTIN_SKINS），一律 .webp
function builtinSkinUrl(id: string) {
  return './whale/' + encodeURIComponent(id) + '.webp'
}
const builtinFlash: Flash = useFlash()
function doPreviewBuiltin(url: string) {
  builtinFlash.msg = ''
  builtinFlash.err = false
  playAudioUrl(url, builtinFlash)
}
// 导入素材的总占用与段数：单个文件缺失时 size 为 0，不影响其它项的统计
const importedSoundCount = computed(() => SOUND_ROLES.reduce((n, r) => n + soundsMeta.value[r].length, 0))
const assetTotalBytes = computed(() => {
  let n = 0
  for (const it of skinGallery.value.items) n += Number(it.size) || 0
  for (const it of bubbleItems.value) n += Number(it.size) || 0
  for (const r of SOUND_ROLES) for (const it of soundsMeta.value[r]) n += Number(it.size) || 0
  return n
})
// 「未使用」= 磁盘上有、但按当前设置不会播放 / 显示的素材：
// 形象：画廊里除正在使用的那张以外的每一张（形象选的是内置时，整柜都没在用）
// 音效：音效开关关 → 全部未使用；按压/释放看「音色」是否自定义；四类提醒音看对应提醒开关
const unusedSkinIds = computed(() => {
  const cur = cfg.skin === 'custom' ? skinGallery.value.current : ''
  return skinGallery.value.items.filter((it) => it.id !== cur).map((it) => it.id)
})
const unusedSoundRoles = computed(() => {
  const out: SoundRole[] = []
  for (const r of SOUND_ROLES) {
    if (!soundsMeta.value[r].length) continue
    if (!cfg.soundOn) { out.push(r); continue }
    if (r === 'press' || r === 'release') { if (cfg.soundSet !== 'custom') out.push(r); continue }
    if (r === 'low' ? !cfg.lowAlertOn
      : r === 'budget' ? !cfg.budgetOn
        : r === 'peak' ? !cfg.peakRemindOn
          : !cfg.passThrough) out.push(r)
  }
  return out
})
const unusedCount = computed(() => unusedSkinIds.value.length + unusedSoundRoles.value.length)
function doClearUnused() {
  // 先快照：删完 computed 会变 0，消息里的数量得用删除前的
  const skinIds = unusedSkinIds.value.slice()
  const roles = unusedSoundRoles.value.slice()
  if (!skinIds.length && !roles.length) return
  skinFlash.msg = ''
  soundFlash.msg = ''
  skinFlash.err = false
  soundFlash.err = false
  try {
    let failed = ''
    for (const id of skinIds) {
      const r = services.removeSkin?.(id)
      if (!r || !r.ok) failed = '形象'
    }
    for (const role of roles) {
      const r = services.removeSound?.(role)
      if (!r || !r.ok) failed = failed || SOUND_ROLE_LABEL[role]
    }
    refreshSkin()
    refreshSounds()
    if (failed) {
      skinFlash.err = true
      skinFlash.msg = `部分素材清除失败：${failed}`
      return
    }
    skinFlash.msg = `已清除 ${skinIds.length + roles.length} 项未使用素材（正在使用的已保留）`
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '清除失败：' + String(err?.message || err)
  }
}
// 素材包：导出 / 选择预览 / 确认写入（与「备份与恢复」同一套三段式，见 backupExport / backupPick / backupApply）
function doExportAssets() {
  if (assetsBusy.value) return
  assetsBusy.value = true
  assetsFlash.msg = ''
  assetsFlash.err = false
  try {
    const r: AssetsExportResult | undefined = services.assetsExport?.()
    if (!r || (!r.ok && !r.canceled)) {
      assetsFlash.err = true
      assetsFlash.msg = '导出失败：' + ((r && r.error) || '未知错误')
    } else if (r.canceled) {
      assetsFlash.msg = '已取消导出'
    } else {
      assetsFlash.msg = `已导出素材包（形象 ${r.skins || 0} 张 · 气泡图 ${r.bubbles || 0} 张 · 音效 ${r.sounds || 0} 段）：${r.path}`
    }
  } catch (err: any) {
    assetsFlash.err = true
    assetsFlash.msg = '导出失败：' + String(err?.message || err)
  } finally {
    assetsBusy.value = false
  }
}
function doPickAssets() {
  if (assetsBusy.value) return
  assetsBusy.value = true
  assetsFlash.msg = ''
  assetsFlash.err = false
  assetsConfirm.value = false
  assetsPack.value = null
  try {
    const r: AssetsPreviewResult | undefined = services.assetsPick?.()
    if (!r || (!r.ok && !r.canceled)) {
      assetsFlash.err = true
      assetsFlash.msg = '读取失败：' + ((r && r.error) || '未知错误')
    } else if (r.canceled) {
      assetsFlash.msg = '已取消导入'
    } else {
      assetsPack.value = r
      assetsPicks.skins = !!r.has?.skins
      assetsPicks.sounds = !!r.has?.sounds
      assetsPicks.bubbles = !!r.has?.bubbles
      assetsFlash.msg = '已读取素材包，勾选要导入的内容后点「导入选中项」'
    }
  } catch (err: any) {
    assetsFlash.err = true
    assetsFlash.msg = '读取失败：' + String(err?.message || err)
  } finally {
    assetsBusy.value = false
  }
}
function doApplyAssets() {
  if (assetsBusy.value || !assetsAnyItem.value) return
  if (!assetsConfirm.value) {
    assetsConfirm.value = true
    assetsFlash.msg = ''
    assetsFlash.err = false
    return
  }
  assetsConfirm.value = false
  assetsBusy.value = true
  try {
    const r: AssetsApplyResult | undefined = services.assetsApply?.({
      skins: assetsPicks.skins, sounds: assetsPicks.sounds, bubbles: assetsPicks.bubbles,
    })
    if (!r || !r.ok) {
      assetsFlash.err = true
      assetsFlash.msg = '导入失败：' + ((r && r.error) || '未知错误')
    } else {
      const parts: string[] = []
      if (r.skins) parts.push(`形象新增 ${r.skins.added} 张${r.skins.skipped ? `（${r.skins.skipped} 张因画廊已满跳过）` : ''}`)
      if (r.bubbles) parts.push(`气泡图新增 ${r.bubbles.added} 张${r.bubbles.skipped ? `（${r.bubbles.skipped} 张因已满跳过）` : ''}`)
      if (r.sounds) parts.push(`音效写入 ${r.sounds.applied} 段`)
      let msg = '已导入素材包：' + (parts.join(' · ') || '没有可写入的内容') + '。'
      assetsFlash.err = false
      if (r.errors && r.errors.length) { msg += r.errors.join('；'); assetsFlash.err = true }
      assetsFlash.msg = msg
      assetsPack.value = null
      refreshSkin()
      refreshBubbles()
      refreshSounds()
    }
  } catch (err: any) {
    assetsFlash.err = true
    assetsFlash.msg = '导入失败：' + String(err?.message || err)
  } finally {
    assetsBusy.value = false
  }
}
function doCancelAssets() {
  assetsPack.value = null
  assetsConfirm.value = false
  assetsFlash.msg = ''
  try { services.assetsCancel?.() } catch (err) {}
}
// 预览里列出包内音效槽位（宿主只给 role 字符串，转成中文标签）
function roleLabelOf(r: string) {
  return SOUND_ROLE_LABEL[r as SoundRole] || r
}
const assetsSkinNames = computed(() => (assetsPack.value?.skinNames || []).join('、'))
const assetsBubbleNames = computed(() => (assetsPack.value?.bubbleNames || []).join('、'))
const assetsSoundNames = computed(() => (assetsPack.value?.soundRoles || []).map(roleLabelOf).join('、'))
// 预览里的一行说明：包里有这一项就列出内容，没有就说清楚
function packLine(n: number | undefined, unit: string, detail: string) {
  return n ? `${n} ${unit}：${detail}` : '包里没有这一项'
}

// —— 台词库（随机台词组 + 报时 / 动图降级文案） ——
// 一组 = 一个抽签项：权重越大越常抽到，顺序决定「依次播放」的出场次序。
// card 是内置的余额 / 时段卡（内容按当前数据现算，文字改不了）；text 是自己填的台词；image 是抽一张气泡图
type QuoteKind = 'card' | 'text' | 'image'
interface QuoteGroupEdit { kind: QuoteKind; w: number; style: 'A' | 'B'; lines: string }
const QUOTE_KINDS: Array<{ v: QuoteKind; label: string }> = [
  { v: 'card', label: '余额/时段卡' },
  { v: 'text', label: '自定义台词' },
  { v: 'image', label: '气泡图' },
]
// 上限与宿主 normQuoteGroups 的 QUOTE_GROUP_MAX 一致（多出来的会被宿主截掉，不如这里就拦住）
const QUOTE_GROUP_MAX = 12
// 不走抽签的两项固定文案（key 写成字面量联合，才能在 cfg.quotes 上按下标取值）
const QUOTE_TEXT_FIELDS: Array<{ key: 'time' | 'gifFail'; label: string; hint: string }> = [
  { key: 'time', label: '报时文案', hint: '白天报时的几种说法，{t} 会替换成当前时间（HH:MM）；深夜/清晨/早上的固定说法不改' },
  { key: 'gifFail', label: '动图降级', hint: '动图（rua.gif）加载失败时顶替显示的文案' },
]
const quoteFolds = reactive({ open: false })
// 文案卡默认折叠：整张卡是「一次配好就不再动」的内容，展开要占一屏多，
// 收起来后「外观」页只剩常用项（大小 / 形象 / 气泡 / 音效）
const quoteCardFolds = reactive({ open: false })
const quoteResetConfirm = ref(false)
// 「有未保存改动」提示：基线由 applyConfig 每次回填后写入（保存 / 恢复默认 / 导入配置 / 清除数据都会经过它），
// 与当前编辑内容序列化比对即可，不必再挂深层 watcher。null = 还没回填过，此时不提示
const quotesBaseline = ref<string | null>(null)
const quotesDirty = computed(() => quotesBaseline.value !== null && JSON.stringify(cfg.quotes) !== quotesBaseline.value)
const quoteFlash: Flash = useFlash()
let quoteFlashTimer: number | undefined
function quoteFlashShow(msg: string, err = false) {
  quoteFlash.msg = msg
  quoteFlash.err = err
  if (quoteFlashTimer) clearTimeout(quoteFlashTimer)
  quoteFlashTimer = window.setTimeout(() => { quoteFlash.msg = '' }, 3000)
}
function quoteGroupAdd() {
  if (cfg.quotes.groups.length >= QUOTE_GROUP_MAX) return
  cfg.quotes.groups.push({ kind: 'text', w: 5, style: 'A', lines: '' })
}
function quoteGroupDel(i: number) {
  cfg.quotes.groups.splice(i, 1)
}
// 上移 / 下移：顺序决定「依次播放」的出场次序，所以要有办法调
function quoteGroupMove(i: number, d: number) {
  const j = i + d
  if (j < 0 || j >= cfg.quotes.groups.length) return
  const [g] = cfg.quotes.groups.splice(i, 1)
  cfg.quotes.groups.splice(j, 0, g)
}
// 保存：按行拆开整份交给宿主清洗（去空白 / 丢空行 / 限长 / 权重压到 1–999 / 丢掉没台词的文本组），
// 再回读一次拿到清洗后的结果
function saveQuotes() {
  quoteResetConfirm.value = false
  const groups = cfg.quotes.groups.map((g) => ({
    kind: g.kind,
    w: g.w,
    style: g.style,
    // 非文本组不带台词：宿主对它们直接短路，带上只是噪音
    lines: g.kind === 'text' ? String(g.lines || '').split('\n').map((s) => s.trim()).filter(Boolean) : [],
  }))
  const quotes: Record<string, any> = { groups }
  for (const f of QUOTE_TEXT_FIELDS) {
    quotes[f.key] = String(cfg.quotes[f.key] || '').split('\n').map((s) => s.trim()).filter(Boolean)
  }
  try {
    patchCfg({ quotes })
    applyConfig(services.getConfig?.())
    quoteFlashShow('已保存')
  } catch (err: any) {
    quoteFlashShow('保存失败：' + String(err?.message || err), true)
  }
}
// 恢复默认：整组传 null，由宿主填回内置默认值（内置那六组与整理前写死在挂件里的完全一致）
// 这一步会直接覆盖用户写的全部台词且不可撤销，所以先要一次二次确认
function resetQuotes() {
  if (!quoteResetConfirm.value) {
    quoteResetConfirm.value = true
    quoteFlash.msg = ''
    return
  }
  quoteResetConfirm.value = false
  try {
    patchCfg({ quotes: null })
    applyConfig(services.getConfig?.())
    quoteFlashShow('已恢复默认台词')
  } catch (err: any) {
    quoteFlashShow('恢复失败：' + String(err?.message || err), true)
  }
}

// —— 提醒文案（低余额 / 今日预算 / 峰谷切换 / 鼠标穿透四类自动提醒的气泡与系统通知文案） ——
// 模板按行映射到气泡三行：第 1 行标题 / 第 2 行大字 / 第 3 行说明；系统通知取全文（换行合并成一行）
const ALERT_FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'low', label: '低余额预警', hint: '余额低于预警阈值时提醒；{balance} = 当前余额，{threshold} = 预警阈值' },
  { key: 'budget', label: '今日预算', hint: '今日用量超出预算时提醒；{used} = 今日已用，{budget} = 预算额，{over} = 超出金额' },
  { key: 'peakOn', label: '进入峰时', hint: '进入高峰时段时提醒；{schedule} = 峰时时段表（如 峰时9-12/14-18点）' },
  { key: 'peakOff', label: '进入谷时', hint: '进入低谷时段时提醒；{schedule} = 峰时时段表（如 峰时9-12/14-18点）' },
  { key: 'passOn', label: '穿透开启', hint: '开启鼠标穿透时提醒（无占位符）' },
  { key: 'passOff', label: '穿透关闭', hint: '关闭鼠标穿透时提醒（无占位符）' },
]
const alertFlash: Flash = useFlash()
const alertResetConfirm = ref(false)
let alertFlashTimer: number | undefined
function alertFlashShow(msg: string, err = false) {
  alertFlash.msg = msg
  alertFlash.err = err
  if (alertFlashTimer) clearTimeout(alertFlashTimer)
  alertFlashTimer = window.setTimeout(() => { alertFlash.msg = '' }, 3000)
}
// 保存：整份交给宿主清洗（去空白 / 丢空行 / 限长），再回读一次拿到清洗后的结果
function saveAlerts() {
  alertResetConfirm.value = false
  const alerts: Record<string, string> = {}
  for (const f of ALERT_FIELDS) alerts[f.key] = String(cfg.alerts[f.key] || '')
  try {
    patchCfg({ alerts })
    applyConfig(services.getConfig?.())
    alertFlashShow('已保存')
  } catch (err: any) {
    alertFlashShow('保存失败：' + String(err?.message || err), true)
  }
}
// 恢复默认：整组传 null，由宿主填回内置文案。同样会覆盖全部自定义文案，先要一次二次确认
function resetAlerts() {
  if (!alertResetConfirm.value) {
    alertResetConfirm.value = true
    alertFlash.msg = ''
    return
  }
  alertResetConfirm.value = false
  try {
    patchCfg({ alerts: null })
    applyConfig(services.getConfig?.())
    alertFlashShow('已恢复默认文案')
  } catch (err: any) {
    alertFlashShow('恢复失败：' + String(err?.message || err), true)
  }
}

// 提醒文案折叠：与上面的开关同属「提醒」主题，收在「提醒与通知」卡里，不再单独占「外观」页一张卡
const alertFolds = reactive({ open: false })
// 同「文案」卡：与上次回填的内容比对，用于「未保存」提示
const alertsBaseline = ref<string | null>(null)
const alertsDirty = computed(() => alertsBaseline.value !== null && JSON.stringify(cfg.alerts) !== alertsBaseline.value)

// —— 邮件通知（SMTP） ——
const mailFlash: Flash = useFlash()
const mailTesting = ref(false)
// SMTP 配置区的展开态。三个来源共同决定，见下面 mailOpen 的注释
const mailFold = reactive({ open: false, touched: false })
// 配置是否已齐全：服务器 / 发件人 / 收件人。只看「有没有填过」这个持久事实，
// 不看本次测试成没成 —— 折叠态要能跨会话稳定重现，不依赖一次性的运行时结果。
// **刻意不要求账号与授权码**：账号留空是合法用法（多数服务器直接拿发件人地址当账号，
// 宿主 SmtpClient.send 也是 `if (user)` 才发 AUTH），授权码同理 —— 本机可匿名中继的
// 内网 SMTP 根本不需要。早先要求这两项非空，用户账号留空时永远判「未配置」，
// 于是每次重载都弹回整张空表格，看着就像「保存丢了」
const mailConfigured = computed(() => !!(
  mail.mailHost.trim() && cfg.mailFrom.trim() && cfg.mailTo.trim()
))
// 展开条件：手动展开过、或配置还没齐（空表格就是要催用户去填）、或刚点了「重新配置」。
// 配置齐全且用户没动过 → 收起，只留一行「已配置」摘要，把卡片位置让给上面的提醒开关。
// `touched` 是关键：否则用户点「修改」展开后，一改动输入框就会因「已配置」立刻收起，
// 出现「点开就自动关上」的失焦感
const mailOpen = computed(() => mailFold.touched || !mailConfigured.value || mailFold.open)
// 通知渠道自测（「通知方式」小节的「测试通知」按钮）：与邮件测试分开两个消息态，
// 因为它同时覆盖系统通知渠道，消息文案也不同
const notifyFlash: Flash = useFlash()
const notifyTesting = ref(false)
let notifyFlashTimer: number | undefined
function notifyFlashShow(msg: string, err = false) {
  notifyFlash.msg = msg
  notifyFlash.err = err
  if (notifyFlashTimer) clearTimeout(notifyFlashTimer)
  notifyFlashTimer = window.setTimeout(() => { notifyFlash.msg = '' }, 4000)
}
let mailFlashTimer: number | undefined
function mailFlashShow(msg: string, err = false) {
  mailFlash.msg = msg
  mailFlash.err = err
  if (mailFlashTimer) clearTimeout(mailFlashTimer)
  mailFlashTimer = window.setTimeout(() => { mailFlash.msg = '' }, 4000)
}
// 从宿主读回 SMTP 凭据：授权码不返明文，只回「有没有存过」的标记，
// 所以密码框留空提交时后端会沿用旧值（见 saveMailSecrets）。
// 入参是「SMTP 凭据本体」（**两种来源形状必须一致**）：
//   - getSecrets() 返回整个 WhaleSecrets，SMTP 挂在 `notifyMail` 子对象下，要下沉一层
//   - saveMailSecrets() 直接返回该子对象（WhaleMailSecrets），不能下沉
// 早先这里写成 `s.mailHost` 取顶层、而 saveMailSecrets 又直接返回子对象，
// 两条路径形状对不上，回填恒为空 → 每次重启都判「未配置」
function applyMailSecrets(m: WhaleMailSecrets | undefined) {
  if (!m || typeof m !== 'object') return
  mail.mailHost = String(m.mailHost || '')
  mail.mailPort = Number(m.mailPort) > 0 ? Number(m.mailPort) : 465
  mail.mailSecure = m.mailSecure !== false
  mail.mailUser = String(m.mailUser || '')
  mailPassSaved.value = !!m.mailPass
  mail.mailPass = ''
}
function loadMailSecrets() {
  // 预期分支：读存储失败/宿主未就绪时保持空表单，用户重填即可
  try { applyMailSecrets(services.getSecrets?.()?.notifyMail) } catch (err) {}
}
// 「重新配置 / 收起」：touched 一旦置位就不再自动收起，把展开态完全交还给用户，
// 避免填到一半被 computed 判成「已配置」而自己合上
function toggleMailFold() {
  mailFold.touched = true
  mailFold.open = !mailFold.open
}
function saveMailSettings() {
  mailFlash.msg = ''
  try {
    // 非敏感字段（开关 / 收件人 / 主题前缀）进配置；服务器与授权码进加密存储，两条路分开写
    patchCfg({
      notifySystemOn: cfg.notifySystemOn,
      notifyMailOn: cfg.notifyMailOn,
      mailFrom: cfg.mailFrom.trim(),
      mailTo: cfg.mailTo.trim(),
      mailFromName: cfg.mailFromName.trim(),
      mailSubjectPrefix: cfg.mailSubjectPrefix.trim(),
    })
    const saved = services.saveMailSecrets?.({
      mailHost: mail.mailHost.trim(),
      mailPort: Number(mail.mailPort) || 465,
      mailSecure: mail.mailSecure,
      mailUser: mail.mailUser.trim(),
      mailPass: mail.mailPass,
    })
    applyMailSecrets(saved)
    mailFlashShow('已保存')
  } catch (err: any) {
    mailFlashShow('保存失败：' + String(err?.message || err), true)
  }
}
async function testNotify() {
  if (notifyTesting.value) return
  notifyTesting.value = true
  notifyFlash.msg = ''
  try {
    const r = await services.testNotify?.()
    if (r && r.ok) {
      const sys = (r.on || []).includes('系统通知')
      notifyFlashShow(sys
        ? '已按当前渠道发出：' + (r.on || []).join(' + ') + '（系统通知应已弹出，邮件请查收含垃圾箱）'
        : '已发出：' + (r.on || []).join(' + ') + '，请查收（含垃圾箱）')
      // 邮件这条渠道也验证通过 → 与「发送测试邮件」同样收起配置区
      if ((r.on || []).includes('邮件')) mailFold.open = false
    } else {
      // 邮件渠道失败时展开配置区，否则错误提示会被折叠藏住
      if ((r && r.on || []).includes('邮件')) mailFold.open = true
      notifyFlashShow('发送失败：' + ((r && r.error) || '未知错误'), true)
    }
  } catch (err: any) {
    notifyFlashShow('发送失败：' + String(err?.message || err), true)
  } finally {
    notifyTesting.value = false
  }
}
async function testMail() {
  if (mailTesting.value) return
  mailTesting.value = true
  mailFlash.msg = ''
  try {
    const r = await services.sendTestMail?.({
      mailHost: mail.mailHost.trim(),
      mailPort: Number(mail.mailPort) || 465,
      mailSecure: mail.mailSecure,
      mailUser: mail.mailUser.trim(),
      mailPass: mail.mailPass,
      // 发件人 / 收件人在「当前表单」里（cfg），不在凭据区 —— 漏传就会被宿主判成空串，
      // 报「发件邮箱格式不正确」，用户看表单里明明填了
      mailFrom: cfg.mailFrom.trim(),
      mailTo: cfg.mailTo.trim(),
      mailFromName: cfg.mailFromName.trim(),
    })
    if (r && r.ok) {
      mailFlashShow('测试邮件已发出，请查收（含垃圾箱）')
      // 发信成功 = 这组参数确实能送达，此时自动收起配置区，卡片回到「一行摘要」的清爽态。
      // 只清 open、留 touched=true：展开权已交给用户，之后不会再自己弹开
      mailFold.open = false
    } else {
      // 失败时反而要展开，否则错误提示会跟着配置区一起藏在折叠里，用户只看到一片空白
      mailFold.open = true
      mailFlashShow('发送失败：' + ((r && r.error) || '未知错误'), true)
    }
  } catch (err: any) {
    mailFold.open = true
    mailFlashShow('发送失败：' + String(err?.message || err), true)
  } finally {
    mailTesting.value = false
  }
}

function saveSecrets() {
  const r = services.saveSecrets?.({ apiKey: secrets.apiKey.trim(), platformToken: secrets.platformToken.trim() })
  secretsFlash.msg = r && r.hasApiKey ? '已加密保存' : '已保存（未填写 API Key，挂件将提示未配置）'
  setTimeout(() => { secretsFlash.msg = '' }, 3000)
}
async function testKey() {
  const key = secrets.apiKey.trim()
  const token = secrets.platformToken.trim()
  if (!key && !token) return
  testing.value = true
  testResults.value = []
  try {
    // API Key → 余额接口（api.deepseek.com）
    if (key) {
      if (!services.testApiKey) {
        testResults.value.push({ label: 'API Key', ok: false, msg: '宿主接口不可用' })
      } else {
        const r = await services.testApiKey(key)
        if (r && r.ok) {
          const cur = r.currency === 'CNY' ? '¥' : (r.currency || '')
          testResults.value.push({ label: 'API Key', ok: true, msg: `连接成功 · 当前余额 ${cur} ${Number(r.totalBalance).toFixed(2)}` })
        } else {
          testResults.value.push({ label: 'API Key', ok: false, msg: (r && r.error) || '未知错误' })
        }
      }
    }
    // 平台 Token → 用量接口（platform.deepseek.com）
    if (token) {
      if (!services.testPlatformToken) {
        testResults.value.push({ label: '平台 Token', ok: false, msg: '宿主接口不可用' })
      } else {
        const r = await services.testPlatformToken(token)
        if (r && r.amount !== undefined) {
          testResults.value.push({
            label: '平台 Token',
            ok: true,
            msg: r.empty
              ? '连接成功 · 今日暂无用量记录'
              : `连接成功 · 今日用量 ¥ ${Number(r.amount).toFixed(4)}（${Number(r.tokens || 0).toLocaleString()} tokens）`,
          })
        } else {
          testResults.value.push({ label: '平台 Token', ok: false, msg: (r && r.error) || '未知错误' })
        }
      }
    }
  } catch (err: any) {
    testResults.value.push({ label: '测试', ok: false, msg: String(err?.message || err) })
  } finally {
    testing.value = false
    lastTestAt.value = Date.now()
  }
}

// —— 首次运行引导 ——
// 保存并结束引导：复用 saveSecrets 那条宿主通道（内部会 Object.assign 合并，不会清掉 models / notifyMail），
// 同时把「进入方式」一并落库。凭据为空也允许提交 —— 用户可能只想调进入方式，
// 这时给一句提示而不是拦着（拦着会让他以为必须填密钥才能用）
function onGuideSave(p: { apiKey: string; platformToken: string; enterMode: string }) {
  guideSaving.value = true
  try {
    secrets.apiKey = p.apiKey
    secrets.platformToken = p.platformToken
    const r = services.saveSecrets?.({ apiKey: p.apiKey, platformToken: p.platformToken })
    cfg.enterMode = p.enterMode as typeof cfg.enterMode
    patchCfg({ enterMode: p.enterMode })
    services.finishFirstRunGuide?.()
    showGuide.value = false
    guideReopen.value = false
    if (r && !r.hasApiKey) {
      // 没填 API Key：引导仍算走完（否则每次打开都弹），但要明确告诉用户挂件还显示不出余额
      activeTab.value = 'data'
      toolOpen.credentials = true
      secretsFlash.msg = '已保存（未填写 API Key，挂件将提示未配置）'
      setTimeout(() => { secretsFlash.msg = '' }, 4000)
    }
  } catch (err: any) {
    guideFlash.msg = String(err?.message || err)
    guideFlash.err = true
  } finally {
    guideSaving.value = false
  }
}
// 引导里的「测试连接」：直接借 testKey()，它读的正是已同步好的 secrets
async function onGuideTest(p: { apiKey: string; platformToken: string }) {
  secrets.apiKey = p.apiKey
  secrets.platformToken = p.platformToken
  guideFlash.msg = ''
  await testKey()
}
// 跳过 / 关闭：只置位 guideDone，不动凭据也不动进入方式 —— 用户明说现在不想配，就别顺手改他的配置。
// 手动重开（guideReopen）时 guideDone 早已是 true，但仍调一次：语义一致，且宿主侧是幂等写
function onGuideSkip() {
  try {
    services.finishFirstRunGuide?.()
  } catch (err) {}
  showGuide.value = false
  guideReopen.value = false
}
// 手动重开引导（数据 Tab 凭据卡里的入口）：不改 guideDone，纯粹再展示一次 ——
// 用户回来多半是想换个 Key 或忘了进入方式在哪调
function onGuideReopen() {
  guideFlash.msg = ''
  guideFlash.err = false
  guideReopen.value = true
  showGuide.value = true
}

function showWidget() {
  const r = services.showWidget?.() || { ok: true }
  widgetVisible.value = true
  if (r && r.ok && !r.error) {
    widgetFlash.err = false
    // 打包版与开发版一致：均给出调试提示（日志两版都落盘）
    widgetFlash.msg = '挂件窗口已创建。若桌面看不到鲸鱼，请打开开发者工具（主窗右键→检查）查看 [whale][widget] 日志。'
  } else {
    widgetFlash.err = true
    widgetFlash.msg = '挂件创建失败：' + ((r && r.error) || '未知错误')
      + '（详见开发者工具控制台 [whale][widget] 日志）'
  }
  checkWidgetError(true)
}
function hideWidget() {
  services.hideWidget?.()
  widgetVisible.value = false
  widgetFlash.msg = ''
}
// 复位挂件位置：宿主把锚点写回默认值（右下角）并立即重摆，用于换显示器/改分辨率后找回挂件
function resetWidgetPos() {
  const r = services.resetWidgetPosition?.()
  const ok = !!(r && r.ok)
  widgetFlash.err = !ok
  widgetFlash.msg = ok ? '挂件已回到默认位置（右下角）。' : ((r && r.error) || '复位失败：宿主接口不可用')
}
// 读取宿主记录的最后一条挂件创建失败原因；silent=true 时不显示「无错误」提示（用于自动检查）
function checkWidgetError(silent = false) {
  if (!silent) {
    errFlash.msg = ''
    errFlash.err = false
  }
  try {
    const e = services.getWidgetError?.()
    errDetail.value = e || ''
    if (!silent && !e) errFlash.msg = '当前没有记录到挂件错误。'
  } catch (err: any) {
    errDetail.value = ''
    if (!silent) {
      errFlash.err = true
      errFlash.msg = '读取失败：' + String(err?.message || err)
    }
  }
}
function copyWidgetError() {
  const ok = services.copyText?.(errDetail.value)
  errFlash.err = !ok
  errFlash.msg = ok ? '错误信息已复制到剪贴板。' : '复制失败，请手动选中上方文本复制。'
}
// 清除本地数据：按勾选项清除，需二次确认，避免误触
function clearSelectedData() {
  if (!anyClearItem.value) return
  if (!clearConfirm.value) {
    clearConfirm.value = true
    dataFlash.msg = ''
    dataFlash.err = false
    return
  }
  clearConfirm.value = false
  const picked = { secrets: clearItems.secrets, config: clearItems.config, ledger: clearItems.ledger, window: clearItems.window, sounds: clearItems.assets, skins: clearItems.assets, bubbles: clearItems.assets }
  // 清音效/形象时宿主会把音色、形象从「自定义」回退为内置，先记下原值用于提示文案
  const wasCustomSound = cfg.soundSet === 'custom'
  const wasCustomSkin = cfg.skin === 'custom'
  try {
    const r = services.clearAllData?.(picked) || { ok: false }
    dataFlash.err = !(r && r.ok)
    if (r && r.ok) {
      const names: string[] = []
      if (picked.secrets) names.push('凭据')
      if (picked.config) names.push('挂件设置')
      if (picked.ledger) names.push('账本用量记录')
      if (picked.window) names.push('窗口位置与更新缓存')
      if (picked.sounds) names.push('导入的素材（形象 / 气泡图 / 音效）')
      dataFlash.msg = `已清除：${names.join('、')}。`
        + (picked.config || picked.window ? '挂件已按默认配置重建。' : '')
        // 素材三项已合成一项，回退提示按同一开关走；清设置时挂件本就按默认重建，不必再逐项说
        + (picked.sounds && !picked.config
            ? (wasCustomSound ? '音色已回退为「小黄鸭」。' : '')
              + (wasCustomSkin ? '形象已回退为「默认形象」。' : '')
              + '挂件气泡图已回退为内置动图。'
            : '')
      if (picked.secrets) {
        secrets.apiKey = ''
        secrets.platformToken = ''
        secretsFlash.msg = ''
      }
      // 清音效/形象可能改了音色与形象（自定义 → 内置），因此与清设置一样要重新套用配置
      if (picked.config || picked.sounds || picked.skins) applyConfig(services.getConfig?.())
      if (picked.ledger) usageHistory.value = []
      else refreshHistory()
      if (picked.sounds) refreshSounds() // 音效卡片（音色「自定义」）回显为「未导入」
      if (picked.skins) refreshSkin()   // 形象画廊回显为空（只剩「＋ 导入」）
      if (picked.bubbles) refreshBubbles() // 气泡图网格回显为空
    } else {
      dataFlash.msg = '清除失败：' + ((r && r.error) || '未知错误')
    }
  } catch (err: any) {
    dataFlash.err = true
    dataFlash.msg = '清除失败：' + String(err?.message || err)
  }
}
// —— 备份与恢复（数据与隐私卡片）——
const backupFolds = reactive({ open: false })
const backupWithSecrets = ref(false)
const backupPassword = ref('')
const backupBusy = ref(false)
const backupFlash: Flash = useFlash()
const backupConfirm = ref(false)
const backupPreview = ref<BackupPreviewResult | null>(null)
const backupPicks = reactive<Record<string, boolean>>({ config: true, ledger: true, window: true, timer: true, secrets: true })
const backupItems: Array<{ key: string; label: string; note: string }> = [
  { key: 'config', label: '挂件设置', note: '（同名覆盖）' },
  { key: 'ledger', label: '账本用量记录', note: '（同日覆盖，保留最近 30 天）' },
  { key: 'window', label: '窗口位置', note: '（恢复后挂件重建一次）' },
  { key: 'timer', label: '计时状态', note: '（重载插件后恢复）' },
  { key: 'secrets', label: '凭据', note: '（用备份密码解密）' },
]
const backupHas = (key: string) => !!backupPreview.value?.has?.[key as 'config']
const backupAnyItem = computed(() => backupItems.some((it) => backupPicks[it.key] && backupHas(it.key)))
const backupItemLabel = (key: string) => (backupItems.find((i) => i.key === key) || { label: key }).label
const backupNames = (list?: string[]) => (list || []).map(backupItemLabel).join('、')
function backupExport() {
  if (backupBusy.value) return
  backupBusy.value = true
  backupFlash.msg = ''
  backupFlash.err = false
  try {
    const r = services.backupExport?.({ secrets: backupWithSecrets.value, password: backupPassword.value })
    if (!r || (!r.ok && !r.canceled)) {
      backupFlash.err = true
      backupFlash.msg = '导出失败：' + ((r && r.error) || '未知错误')
    } else if (r.canceled) {
      backupFlash.msg = '已取消导出'
    } else {
      backupPassword.value = '' // 密码不留在内存/界面上
      backupFlash.msg = '已导出备份：' + r.path + (r.withSecrets ? '（含加密凭据）' : '（不含凭据）')
    }
  } catch (err: any) {
    backupFlash.err = true
    backupFlash.msg = '导出失败：' + String(err?.message || err)
  } finally {
    backupBusy.value = false
  }
}
function backupPick() {
  if (backupBusy.value) return
  backupBusy.value = true
  backupFlash.msg = ''
  backupFlash.err = false
  backupConfirm.value = false
  backupPreview.value = null
  try {
    const r = services.backupPick?.()
    if (!r || (!r.ok && !r.canceled)) {
      backupFlash.err = true
      backupFlash.msg = '读取失败：' + ((r && r.error) || '未知错误')
    } else if (r.canceled) {
      backupFlash.msg = '已取消导入'
    } else {
      backupPreview.value = r as BackupPreviewResult
      backupItems.forEach((it) => { backupPicks[it.key] = backupHas(it.key) })
      backupFlash.msg = '已读取备份，请勾选要恢复的项，再点「恢复选中项」'
    }
  } catch (err: any) {
    backupFlash.err = true
    backupFlash.msg = '读取失败：' + String(err?.message || err)
  } finally {
    backupBusy.value = false
  }
}
function backupApply() {
  if (backupBusy.value || !backupAnyItem.value) return
  if (!backupConfirm.value) {
    backupConfirm.value = true
    backupFlash.msg = ''
    backupFlash.err = false
    return
  }
  backupConfirm.value = false
  backupBusy.value = true
  try {
    const r = services.backupApply?.({
      config: backupPicks.config, ledger: backupPicks.ledger, window: backupPicks.window,
      timer: backupPicks.timer, secrets: backupPicks.secrets, password: backupPassword.value,
    })
    const applied = (r && r.applied) || []
    if (!r || !r.ok) {
      backupFlash.err = true
      backupFlash.msg = '恢复失败：' + ((r && (r.errors || [])[0]) || (r && r.error) || '未知错误')
    } else {
      let msg = '已恢复：' + backupNames(applied) + '。'
      if (r.skipped && r.skipped.length) msg += '备份里没有：' + backupNames(r.skipped) + '。'
      if (r.widgetRebuilt) msg += '挂件已按恢复的设置重建。'
      backupFlash.err = false
      if (r.errors && r.errors.length) { msg += r.errors.join('；'); backupFlash.err = true }
      backupPassword.value = ''
      backupPreview.value = null
      backupFlash.msg = msg
      // 让页面回显跟上：设置 / 账本 / 凭据分别刷新
      if (applied.indexOf('config') >= 0) applyConfig(services.getConfig?.())
      if (applied.indexOf('ledger') >= 0) refreshHistory()
      if (applied.indexOf('secrets') >= 0) {
        const s = services.getSecrets?.()
        if (s) {
          secrets.apiKey = s.apiKey || ''
          secrets.platformToken = s.platformToken || ''
        }
      }
    }
  } catch (err: any) {
    backupFlash.err = true
    backupFlash.msg = '恢复失败：' + String(err?.message || err)
  } finally {
    backupBusy.value = false
  }
}
function backupCancelPick() {
  backupPreview.value = null
  backupConfirm.value = false
  backupFlash.msg = ''
  try { services.backupCancel?.() } catch (err) {}
}
// 复制指令名，便于粘贴到 uTools「全局功能」新增全局快捷键
function copyHotkeyCmd(label = '显示/隐藏挂件') {
  const ok = services.copyText?.(label)
  widgetFlash.err = !ok
  widgetFlash.msg = ok
    ? `已复制「${label}」，粘贴到 uTools「全局功能」的指令框即可。`
    : `复制失败，请手动输入指令名：${label}`
}
// 跳转 uTools「全局功能」并直接新增一条待绑定项（快捷键被删除后可用它重新添加）
// 注意：每次点击都会新增一条，uTools 无「只跳转不新增」的接口
function addHotkey(label = '显示/隐藏挂件') {
  const ok = services.redirectHotKeySetting?.(label)
  widgetFlash.err = !ok
  widgetFlash.msg = ok
    ? `已跳转 uTools「全局功能」并新增一条待绑定项（指令：${label}），按下组合键即可完成绑定。`
    : '跳转失败，请手动打开 uTools 设置 → 全局功能 添加。'
}
// 复制诊断日志：uTools 结束插件进程会连带清空控制台，日志已同步落盘，可从文件取回
function copyDebugLog() {
  try {
    const r = services.getDebugLog?.()
    const text = (r && r.text) || ''
    if (!text) {
      diagFlash.err = true
      diagFlash.msg = '暂无可复制的日志：日志文件尚未产生（插件重启后才会写入）。'
      return
    }
    const ok = services.copyText?.(text)
    diagFlash.err = !ok
    diagFlash.msg = ok
      ? `已复制诊断日志末尾 ${text.split('\n').length} 行。文件：${(r && r.path) || ''}`
      : '复制失败，可点「打开日志文件」手动查看。'
  } catch (err: any) {
    diagFlash.err = true
    diagFlash.msg = '读取失败：' + String(err?.message || err)
  }
}
// 用系统默认程序打开日志文件，便于人工查看或另存
function openLogFile() {
  try {
    const r = services.openLogFile?.()
    diagFlash.err = !(r && r.ok)
    diagFlash.msg = r && r.ok
      ? '已用系统默认程序打开日志文件：' + (r.path || '')
      : '打开失败：' + ((r && r.path) ? r.path : '日志文件尚未产生（插件重启后才会写入）。')
  } catch (err: any) {
    diagFlash.err = true
    diagFlash.msg = '打开失败：' + String(err?.message || err)
  }
}

function doCheckUpdate(force: boolean) {
  if (!services.checkUpdate) return
  updateChecking.value = true
  updateMsg.value = ''
  Promise.resolve(services.checkUpdate(force))
    .then((r: any) => {
      updateResult.value = r || null
      if (!r || !r.ok) updateMsg.value = '检查失败：' + ((r && r.error) || '未知错误')
      else if (r.hasUpdate) updateMsg.value = '发现新版本 v' + r.latest + '（当前 v' + r.current + '），可在插件市场更新'
      else updateMsg.value = '已是最新版本'
    })
    .catch((err: any) => {
      updateMsg.value = '检查失败：' + String(err?.message || err)
    })
    .finally(() => { updateChecking.value = false })
}
function openHomepage() {
  services.openExternal?.('https://github.com/Berge520/Balance-Whale-Widget')
}
// 跳 uTools 插件应用市场并搜索本插件（走「管理中心 → 插件应用市场 → 搜一搜」那条路径）。
// 原理：utools.redirect(label) 在已装插件里查不到该指令名时，底座会提示「未找到功能…已为您跳转
// 插件市场搜索」并自动打开市场搜索页 —— 这是官方文档写明的降级行为，正好用来做「去市场搜索」。
// 坑：redirect 按前缀匹配指令名，本插件 cmds 含「小鲸鱼」「小鲸鱼余额」「余额挂件」等，
// 所以「小鲸鱼余额挂件」会被「小鲸鱼余额」吃掉、直接打开本插件。必须用不撞任何 cmd 前缀的词：
// 这里传「鲸鱼余额挂件」（以「鲸」开头），实测能稳定落到市场搜索分支并搜到本插件。
// 若底座版本过旧不支持（返回 false），兜底用系统浏览器打开市场搜索页。
const MARKET_SEARCH_KEYWORD = '鲸鱼余额挂件'
function marketSearch() {
  const ok = services.redirectToMarket?.(MARKET_SEARCH_KEYWORD)
  if (!ok) services.openExternal?.('https://www.u-tools.cn/plugins/?keyword=' + encodeURIComponent(MARKET_SEARCH_KEYWORD))
}
// 教程里的链接用系统浏览器打开，避免在插件窗口内导航
function openDoc(url: string) {
  services.openExternal?.(url)
}

// 用宿主返回的配置回填设置页各开关（首次进入与挂件菜单改动后的同步都走这里）
function applyConfig(c: any) {
  if (!c) return
  cfg.scale = c.scale
  cfg.scaleNum = scaleToNum(c.scale)
  cfg.vol = c.vol
  cfg.soundOn = c.soundOn !== false
  cfg.soundSet = c.soundSet
  cfg.usageMode = c.usageMode
  cfg.peakMode = c.peakMode
  cfg.peakRemindOn = c.peakRemindOn !== false
  cfg.bubbleOn = c.bubbleOn
  cfg.menuBtn = c.menuBtn !== false
  cfg.onTop = c.onTop !== false
  cfg.lowAlertOn = c.lowAlertOn !== false
  cfg.lowAlertAmount = typeof c.lowAlertAmount === 'number' ? c.lowAlertAmount : LOW_ALERT_DEFAULT.CNY
  cfg.budgetOn = c.budgetOn === true
  cfg.budgetAmount = typeof c.budgetAmount === 'number' ? c.budgetAmount : 0
  cfg.dropAlertOn = c.dropAlertOn === true
  cfg.dropAlertAmount = typeof c.dropAlertAmount === 'number' ? c.dropAlertAmount : 5
  cfg.skin = c.skin === 'custom' || BUILTIN_SKINS.includes(c.skin) ? c.skin : DEFAULT_SKIN
  cfg.theme = c.theme === 'dark' || c.theme === 'sakura' ? c.theme : 'default'
  cfg.clickQueueOn = c.clickQueueOn === true
  cfg.remindSec = c.remindSec === 0 || c.remindSec === 5 || c.remindSec === 15 ? c.remindSec : 8
  cfg.quietOn = c.quietOn === true
  cfg.quietFrom = typeof c.quietFrom === 'string' && c.quietFrom ? c.quietFrom : '23:00'
  cfg.quietTo = typeof c.quietTo === 'string' && c.quietTo ? c.quietTo : '07:00'
  cfg.timeBubbleOn = c.timeBubbleOn !== false
  // 回填时不能漏：漏了的话勾选后重开设置页开关会自己弹回去，看着像没保存
  cfg.updateCheckOn = c.updateCheckOn === true
  cfg.dragLock = c.dragLock === true
  cfg.timerNotifyOn = c.timerNotifyOn !== false
  cfg.timerMailOn = c.timerMailOn !== false
  cfg.timerPersistOn = c.timerPersistOn !== false
  cfg.timerBubblePin = c.timerBubblePin !== false
  cfg.timerBubbleOnly = c.timerBubbleOnly !== false
  cfg.timerSec = typeof c.timerSec === 'number' && c.timerSec > 0 ? Math.round(c.timerSec) : 1500
  cfg.timerNote = typeof c.timerNote === 'string' ? c.timerNote : ''
  cfg.timerBreakMin = typeof c.timerBreakMin === 'number' ? c.timerBreakMin : 5
  syncTimerHms()
  cfg.enterMode = c.enterMode === 'widget' || c.enterMode === 'settings' ? c.enterMode : 'both'
  cfg.dshNodeDir = typeof c.dshNodeDir === 'string' ? c.dshNodeDir : ''
  cfg.dshKeepAlive = c.dshKeepAlive === true
  // 端口：宿主 store 的 normDshPort 已保证是 1–65535，这里的兜底只为「宿主没给这个键」的旧配置
  cfg.dshPort = typeof c.dshPort === 'number' && c.dshPort >= 1 && c.dshPort <= 65535 ? Math.round(c.dshPort) : DEFAULT_DSH_PORT
  cfg.dshRegistry = typeof c.dshRegistry === 'string' ? c.dshRegistry : ''
  cfg.dshVersion = typeof c.dshVersion === 'string' ? c.dshVersion : ''
  cfg.dshReinstall = c.dshReinstall === true
  cfg.dshNoOpen = c.dshNoOpen !== false
  cfg.dshMarketUrl = typeof c.dshMarketUrl === 'string' ? c.dshMarketUrl : ''
  cfg.dshMarketMirror = c.dshMarketMirror !== false
  cfg.dshMarketRegistry = typeof c.dshMarketRegistry === 'string' ? c.dshMarketRegistry : ''
  cfg.dshMarketOfficial = c.dshMarketOfficial === true
  cfg.dshExportCred = c.dshExportCred === true
  cfg.dshExportNoMod = c.dshExportNoMod !== false
  cfg.avoidTaskbar = c.avoidTaskbar !== false
  cfg.edgeTop = typeof c.edgeTop === 'number' ? c.edgeTop : 0
  cfg.edgeRight = typeof c.edgeRight === 'number' ? c.edgeRight : 0
  cfg.edgeBottom = typeof c.edgeBottom === 'number' ? c.edgeBottom : 0
  cfg.edgeLeft = typeof c.edgeLeft === 'number' ? c.edgeLeft : 0
  cfg.scrollGapOn = c.scrollGapOn === true
  cfg.scrollGapPx = typeof c.scrollGapPx === 'number' ? c.scrollGapPx : SCROLL_GAP_DEFAULT
  cfg.snapMode = c.snapMode === 'off' ? 'off' : 'ratio'
  cfg.snapRatio = typeof c.snapRatio === 'number' ? c.snapRatio : SNAP_RATIO_DEFAULT
  cfg.opacity = typeof c.opacity === 'number' ? c.opacity : 100
  cfg.passThrough = c.passThrough === true
  // 额度：总量与重置周期存配置，已用由账本按周期算（quotaUsed 见下方 computed）
  cfg.quotaTotal = typeof c.quotaTotal === 'number' ? c.quotaTotal : 0
  cfg.quotaReset = c.quotaReset === 'never' || c.quotaReset === 'daily' ? c.quotaReset : 'monthly'
  // 自定义单价：宿主已归一化过，这里只做类型兜底（缺字段回默认值）
  const tp = c.tokenPrice && typeof c.tokenPrice === 'object' ? c.tokenPrice : {}
  const tpNum = (v: any, dft: number) => (typeof v === 'number' && isFinite(v) ? v : dft)
  cfg.tokenPrice.on = tp.on === true
  cfg.tokenPrice.cur = tp.cur === 'USD' ? 'USD' : 'CNY'
  cfg.tokenPrice.rate = tpNum(tp.rate, TOKEN_PRICE_DEFAULT.rate)
  cfg.tokenPrice.hit = tpNum(tp.hit, TOKEN_PRICE_DEFAULT.hit)
  cfg.tokenPrice.miss = tpNum(tp.miss, TOKEN_PRICE_DEFAULT.miss)
  cfg.tokenPrice.out = tpNum(tp.out, TOKEN_PRICE_DEFAULT.out)
  // 按模型覆盖的条目：宿主已清洗过（丢空名、钳范围、截条数），这里只做类型兜底
  cfg.tokenPrice.models = Array.isArray(tp.models)
    ? tp.models.filter((it: any) => it && typeof it === 'object').map((it: any) => ({
        name: String(it.name || ''),
        hit: tpNum(it.hit, TOKEN_PRICE_DEFAULT.hit),
        miss: tpNum(it.miss, TOKEN_PRICE_DEFAULT.miss),
        out: tpNum(it.out, TOKEN_PRICE_DEFAULT.out),
      }))
    : []
  // 账本历史保留天数：宿主已归一化过，这里只做类型兜底
  cfg.historyKeepDays = typeof c.historyKeepDays === 'number' ? c.historyKeepDays : HISTORY_KEEP.DEFAULT
  // GitHub 加速：开关意图 + IP 表（宿主已清洗过非法条目，这里只做类型兜底）
  cfg.ghAccelOn = c.ghAccelOn === true
  cfg.ghAccelIps = Array.isArray(c.ghAccelIps)
    ? c.ghAccelIps.filter((it: any) => it && typeof it === 'object').map((it: any) => ({ domain: String(it.domain || ''), ip: String(it.ip || '') }))
    : []
  cfg.ghAccelRefreshedAt = typeof c.ghAccelRefreshedAt === 'number' && c.ghAccelRefreshedAt > 0 ? c.ghAccelRefreshedAt : 0
  // 来源开关 + 两段顺序。这里**必须整对象回填**（order 与 sources 都不能漏）：
  // AccelView 的来源顺序取自 props.cfg.ghAccelSrc.order、源表顺序取自 .sources，
  // 漏回填的话点「上移 / 下移」落盘后父级 cfg 不变，子组件拿到的 props 仍是旧顺序 ——
  // 表现就是「点了没反应」，而宿主侧读的也是这份 cfg，刷新时同样按旧顺序走
  const gs = c.ghAccelSrc && typeof c.ghAccelSrc === 'object' ? c.ghAccelSrc : {}
  cfg.ghAccelSrc = {
    doh: gs.doh !== false,
    community: gs.community !== false,
    manual: gs.manual !== false,
    sources: Array.isArray(gs.sources) ? gs.sources.filter((s: any) => typeof s === 'string') : [],
    order: Array.isArray(gs.order) ? gs.order.filter((s: any) => typeof s === 'string') : [],
  }
  // 通知渠道：系统通知默认开（沿用旧行为）；邮件通知的服务器/授权码不在这里（走 secrets）
  cfg.notifySystemOn = c.notifySystemOn !== false
  cfg.notifyMailOn = c.notifyMailOn === true
  cfg.mailFrom = typeof c.mailFrom === 'string' ? c.mailFrom : ''
  cfg.mailTo = typeof c.mailTo === 'string' ? c.mailTo : ''
  cfg.mailFromName = typeof c.mailFromName === 'string' ? c.mailFromName : ''
  cfg.mailSubjectPrefix = typeof c.mailSubjectPrefix === 'string' ? c.mailSubjectPrefix : ''
  // 台词库：宿主回的是清洗后的结构（time / gifFail 是字符串数组，groups 是随机组列表），
  // 编辑区按「一行一条」显示（缺字段/异常值按空处理）
  const q = c.quotes && typeof c.quotes === 'object' ? c.quotes : {}
  for (const f of QUOTE_TEXT_FIELDS) {
    cfg.quotes[f.key] = Array.isArray(q[f.key]) ? q[f.key].join('\n') : ''
  }
  cfg.quotes.groups = (Array.isArray(q.groups) ? q.groups : []).map((g: any) => ({
    kind: g?.kind === 'card' ? 'card' : g?.kind === 'image' ? 'image' : 'text',
    w: typeof g?.w === 'number' ? g.w : 5,
    style: g?.style === 'B' ? 'B' : 'A',
    lines: Array.isArray(g?.lines) ? g.lines.join('\n') : '',
  })) as QuoteGroupEdit[]
  // 提醒文案模板：宿主回的就是含换行的字符串，原样显示（缺字段/异常值按空处理）
  const al = c.alerts && typeof c.alerts === 'object' ? c.alerts : {}
  for (const f of ALERT_FIELDS) {
    cfg.alerts[f.key] = typeof al[f.key] === 'string' ? al[f.key] : ''
  }
  // 回填完成即等于「已保存状态」，在这里落基线，供「未保存」提示比对
  quotesBaseline.value = JSON.stringify(cfg.quotes)
  alertsBaseline.value = JSON.stringify(cfg.alerts)
  // 模型列表与主显示也走配置（挂件菜单里切换主显示时会广播过来，本页单选要跟着变）
  reloadModels()
}

// —— 任务栏状态（宿主实时识别；本页每 2s 同步一次，用来展示现在是隐藏还是显示） ——
const taskbar = reactive({ state: '', edge: '', thickness: 0 })
const edgeName: Record<string, string> = { left: '左侧', top: '顶部', right: '右侧', bottom: '底部' }
function taskbarSync() {
  try {
    const s = services.getTaskbarState?.()
    if (!s) return
    taskbar.state = s.state || ''
    taskbar.edge = s.edge || ''
    taskbar.thickness = s.thickness || 0
  } catch (err) {}
}
const taskbarText = computed(() => {
  const e = edgeName[taskbar.edge] || '任务栏所在边'
  if (taskbar.state === 'visible') return '正在显示：占' + e + ' ' + taskbar.thickness + 'px，挂件已让位'
  if (taskbar.state === 'hidden') {
    return '已自动收起（' + e + (taskbar.thickness ? '，厚 ' + taskbar.thickness + 'px' : '') + '）：挂件贴满边，弹出时自动让位'
  }
  return '未识别到任务栏，挂件按屏幕边缘贴边'
})
// 任务栏状态每 2s 同步一次（immediate：启动时先同步一次，不必等第一个间隔）
const taskbarPolling = usePolling(taskbarSync, 2000, true)

// 宿主推送的配置变更订阅（挂件菜单改设置时，让本页开关同步）
let unsubConfig: (() => void) | undefined
// 本窗口重新可见/重新聚焦时刷新趋势（挂件刷新余额后账本可能已变）
function onWindowActive() {
  if (document.visibilityState === 'hidden') return
  refreshHistory()
  refreshTodayModels() // 模型占比是联网结果，回到本页时也刷新一次
  reloadModels() // 挂件会定时刷余额，回到本页时把最新快照取回来
  // 只在开发者 Tab 轮询着 dsh 状态时才需要补 deep 探测（可能在挂件菜单里启停过）
  if (activeTab.value === 'dev') dshStatus(true)
  taskbarSync() // 顺带同步任务栏显隐状态
}

onMounted(() => {
  try {
    // ── 首帧关键路径：只做「轻量、必现」的同步读取 ──
    // 这些要么是纯内存读（配置/凭据/版本），要么决定首屏骨架（开关状态），必须同步拿。
    applyConfig(services.getConfig?.())
    // 挂件菜单勾选/取消 → 宿主广播 → 刷新本页开关
    unsubConfig = services.onConfigChange?.(applyConfig)
    const s = services.getSecrets?.()
    if (s) {
      secrets.apiKey = s.apiKey || ''
      secrets.platformToken = s.platformToken || ''
    }
    loadMailSecrets()
    widgetVisible.value = services.isWidgetVisible?.() !== false
    checkWidgetError(true)
    appVersion.value = services.getVersion?.() || ''
    // dsh 状态不在挂载时轮询：等切到「开发者」Tab 再启（见 watch(activeTab)）；
    // 任务栏状态所有 Tab 都可能看，保持常轮
    taskbarPolling.start()
    // GitHub 加速（hosts 实际状态）不在这里预读：它已抽到 AccelView，
    // 由该组件在切到帮助 Tab 时自行刷新，父级无需代劳
  } catch (err) {}
  window.addEventListener('focus', onWindowActive)
  document.addEventListener('visibilitychange', onWindowActive)
  // ── 非关键路径：延后到首帧之后 ──
  // 原先 refreshSkin/refreshBubbles/refreshSounds/refreshHistory 等直接在 onMounted 里同步跑，
  // 但它们是同步 IPC，且 refreshSkin → getSkinData/listSkins、refreshBubbles → listBubbles
  // 会把每张形象/气泡图**读成 base64 data URL**（单张几百 KB、base64 再涨 33%，多张即数 MB）。
  // onMounted 处于首帧渲染路径上，于是「读图 + base64 + IPC 往返」的总耗时直接变成白屏
  // 2~3 秒（冷启动最慢）。这里把重活挪到 rAF 之后：Vue 先把界面渲出来，再在空档里补数据 ——
  // 只改执行时机，不改任何数据逻辑与渲染结果。
  requestAnimationFrame(() => {
    try {
      refreshHistory()
      refreshTodayModels()
      loadModelTemplates()
      reloadModels()
      refreshSounds()
      refreshSkin()
      refreshBubbles()
    } catch (err) {}
    // 更新检查与首次引导也一并后置：它们都涉及网络/弹窗，不能挡住首屏
    try { if (cfg.updateCheckOn) doCheckUpdate(false) } catch (err) {}
    // 首次运行引导：放在最后弹，避免与前面的初始化抢渲染。
    // 判据在宿主侧（guideDone 未置位 + 没填 API Key），老用户升级上来不会被打扰
    try {
      if (services.needFirstRunGuide?.()) {
        guideReopen.value = false
        showGuide.value = true
      }
    } catch (err) {}
  })
})

onUnmounted(() => {
  try { unsubConfig?.() } catch (err) {}
  dshPolling.stop()
  dshTickSync(false, true)
  // 清掉未到点的延迟刷新（见 laterStatus）：设置窗关掉后这些回调不该再跑
  for (const id of pendingStatusTimers) window.clearTimeout(id)
  pendingStatusTimers.clear()
  if (codexTickTimer) { window.clearInterval(codexTickTimer); codexTickTimer = 0 }
  taskbarPolling.stop()
  window.removeEventListener('focus', onWindowActive)
  document.removeEventListener('visibilitychange', onWindowActive)
})
</script>

<template>
  <div class="page">
    <h1>🐳 小鲸鱼余额挂件</h1>
    <p class="sub">桌面透明置顶小窗 · 显示 DeepSeek 余额</p>

    <!-- 顶部 Tab：一次只显示一组卡片 -->
    <nav class="tab-bar">
      <div class="tab-row">
        <button v-for="t in TABS" :key="t.key" type="button" class="tab"
                :class="{ 'tab-on': activeTab === t.key }" @click="activeTab = t.key">{{ t.label }}</button>
      </div>
      <p class="tab-desc">{{ activeTabDesc }}</p>
    </nav>

    <!-- [数据] 凭据：填一次就不动，默认收起（展开状态见 toolOpen.credentials） -->
    <section v-if="activeTab === 'data'" class="card">
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="toolOpen.credentials = !toolOpen.credentials">
          {{ toolOpen.credentials ? '收起凭据设置' : 'DeepSeek 凭据（API Key / 平台 Token）' }}
        </button>
        <div v-if="toolOpen.credentials" class="guide">
          <label class="field">
            <span class="label">API Key</span>
            <input v-model="secrets.apiKey" type="password" placeholder="sk-..." autocomplete="off" />
          </label>
          <button class="link-btn utils-btn utils-secondary" @click="guides.apiKey = !guides.apiKey">
            {{ guides.apiKey ? '收起教程' : '如何获取 API Key？' }}
          </button>
          <div v-if="guides.apiKey" class="guide2">
            <p class="guide-use"><strong>用途：</strong>读取账户余额，挂件显示余额必需（<strong>必填</strong>）。</p>
            <ol class="guide-steps">
              <li>登录 <a href="#" @click.prevent="openDoc('https://platform.deepseek.com')">platform.deepseek.com</a>。</li>
              <li>左侧进「API keys」→「创建 API key」。</li>
              <li>复制 <code>sk-</code> 开头的密钥（仅完整显示一次）。</li>
              <li>粘贴到上方，点「保存凭据」。</li>
            </ol>
            <p class="guide-meta"><strong>保存与安全：</strong>存于本机 uTools 加密存储，仅本插件可读、不上传服务器；只随请求发往 <code>api.deepseek.com</code>，不写日志。API Key 长期有效，泄露可在平台删旧 key 后换新。</p>
            <p class="guide-note">注意：这是接口密钥，不是「平台 Token」；请勿泄露。</p>
          </div>
          <label class="field">
            <span class="label">平台 Token <em>（可选，「实时·令牌」用量模式需要）</em></span>
            <input v-model="secrets.platformToken" type="password" placeholder="platform.deepseek.com 令牌" autocomplete="off" />
          </label>
          <button class="link-btn utils-btn utils-secondary" @click="guides.token = !guides.token">
            {{ guides.token ? '收起教程' : '如何获取平台 Token？' }}
          </button>
          <div v-if="guides.token" class="guide2">
            <p class="guide-use"><strong>用途：</strong>可选。用于「实时·令牌」用量模式；不填则本地记账。</p>
            <ol class="guide-steps">
              <li>登录 <a href="#" @click.prevent="openDoc('https://platform.deepseek.com')">platform.deepseek.com</a>，按 <code>F12</code> 打开 Network。</li>
              <li>刷新「用量」页，找到 <code>usage/by_api_key/amount</code> 请求。</li>
              <li>复制其 Request Headers 里 <code>Authorization</code> 的值（<code>Bearer eyJ...</code>）。</li>
              <li>粘贴到上方，点「保存凭据」。</li>
            </ol>
            <p class="guide-meta"><strong>保存与安全：</strong>同 API Key，本机加密存储、不上传服务器；只随请求发往 <code>platform.deepseek.com</code>。它属网页会话令牌，重登后可能失效，届时自动回落本地记账，重新复制一次即可。</p>
          </div>
          <div class="btn-row">
            <button class="utils-btn utils-primary" @click="saveSecrets">保存凭据（加密存储）</button>
            <button class="secondary utils-btn utils-secondary" :disabled="testing || (!secrets.apiKey.trim() && !secrets.platformToken.trim())" @click="testKey">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
          </div>
          <p v-if="secretsFlash.msg" class="msg" :class="msgCls(secretsFlash)">{{ secretsFlash.msg }}</p>
          <div v-if="testResults.length" class="test-list">
            <div v-for="(r, i) in testResults" :key="i" class="test-item" :class="r.ok ? 'ok' : 'err'">
              <span class="test-icon">{{ r.ok ? '✓' : '✕' }}</span>
              <div class="test-body">
                <div class="test-label">{{ r.label }}</div>
                <div class="test-msg">{{ r.msg }}</div>
              </div>
            </div>
            <div v-if="lastTestText" class="test-time">上次测试 {{ lastTestText }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- [外观] 挂件外观：大小 / 形象 / 气泡（主题 · 峰谷文案 · 开关）/ 音效（开关 · 音色 · 音量）。
         素材的「导入 / 删除 / 试听 / 素材包」都在「资源」页，这里只选「用哪个」——
         所以素材说明统一放在卡片开头一句，各设置项下面只留「当前用的是什么」的状态 -->
    <section v-if="activeTab === 'look'" class="card">
      <h2>挂件外观</h2>

      <p class="hint">
        素材都会复制到本地数据目录（不引用源文件），单文件 ≤5MB。导入 / 删除 / 试听、素材占用与素材包导出
        都在「资源」页；未导入时分别回退为「默认形象」与「小黄鸭」。
      </p>

      <label class="field row">
        <span class="label">大小</span>
        <input class="range" type="range" min="0.6" max="2.5" step="0.1" v-model.number="cfg.scale"
               @input="onScaleLive" @change="onScaleCommit" />
        <input class="num" type="number" min="1" :max="SCALE_STEPS" step="1" v-model.number="cfg.scaleNum"
               @input="onScaleNumLive" @change="onScaleCommit" />
      </label>

      <label class="field row">
        <span class="label">形象</span>
        <select v-model="cfg.skin" @change="patchCfg({ skin: cfg.skin })">
          <option v-for="s in BUILTIN_SKINS" :key="s" :value="s">{{ s }}</option>
          <option value="custom">自定义</option>
        </select>
        <button class="export-btn utils-btn utils-outline" type="button" title="随机换一个内置形象" @click="doRandomSkin()">随机</button>
      </label>
      <p v-if="cfg.skin === 'custom' && !skinMeta" class="hint">
        还没有导入形象，去「资源」页加一张后这里才有「自定义」可用（当前会回退为「默认形象」）。
      </p>
      <p v-else-if="skinUnused" class="hint">
        已导入但当前未使用：「形象」选的不是「自定义」。
      </p>
      <p v-else-if="skinMeta" class="hint">
        当前使用：{{ skinMeta.name }}（{{ assetSize(skinMeta) }}）。
      </p>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="lookFolds.bubble = !lookFolds.bubble">{{ lookFolds.bubble ? '收起气泡与文案' : '气泡与文案（主题 · 峰谷 · 报时 · 点按播放）' }}</button>
        <div v-if="lookFolds.bubble">
          <label class="field row">
            <span class="label">气泡主题</span>
            <select v-model="cfg.theme" @change="patchCfg({ theme: cfg.theme })">
              <option value="default">默认（蓝白）</option>
              <option value="dark">深色</option>
              <option value="sakura">樱花</option>
            </select>
          </label>

          <label class="field row">
            <span class="label">峰谷文案</span>
            <select v-model="cfg.peakMode" @change="patchCfg({ peakMode: cfg.peakMode })">
              <option value="default">默认（空闲/高峰）</option>
              <option value="liangwen">梁文峰谷</option>
              <option value="qiangqiang">!?强强?!</option>
            </select>
          </label>

          <label class="field row check">
            <span class="label">思考气泡</span>
            <input type="checkbox" v-model="cfg.bubbleOn" @change="patchCfg({ bubbleOn: cfg.bubbleOn })" />
          </label>

          <label class="field row check">
            <span class="label">小鲸鱼报时 <em>（气泡首行显示当前时间）</em></span>
            <input type="checkbox" v-model="cfg.timeBubbleOn" @change="patchCfg({ timeBubbleOn: cfg.timeBubbleOn })" />
          </label>

          <label class="field row check">
            <span class="label">挂件右上角菜单按钮</span>
            <input type="checkbox" v-model="cfg.menuBtn" @change="patchCfg({ menuBtn: cfg.menuBtn })" />
          </label>

          <label class="field row check">
            <span class="label">点按依次播放 <em>（点气泡按顺序播放台词，播完才收起；关闭则每次随机一组）</em></span>
            <input type="checkbox" v-model="cfg.clickQueueOn" @change="patchCfg({ clickQueueOn: cfg.clickQueueOn })" />
          </label>
        </div>
      </div>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="lookFolds.sound = !lookFolds.sound">{{ lookFolds.sound ? '收起音效' : '音效（开关 · 音色 · 音量）' }}</button>
        <div v-if="lookFolds.sound">
          <label class="field row check">
            <span class="label">音效开关</span>
            <input type="checkbox" v-model="cfg.soundOn" @change="patchCfg({ soundOn: cfg.soundOn })" />
          </label>

          <label class="field row">
            <span class="label">音色</span>
            <select v-model="cfg.soundSet" :disabled="!cfg.soundOn" @change="patchCfg({ soundSet: cfg.soundSet })">
              <option value="duck">小黄鸭</option>
              <option value="fx1">音效1</option>
              <option value="custom">自定义</option>
            </select>
          </label>

          <label class="field row">
            <span class="label">音量</span>
            <input class="range" type="range" min="0" max="1" step="0.05" v-model.number="cfg.vol"
                   :disabled="!cfg.soundOn" @input="patchCfg({ vol: cfg.vol })" />
            <span class="num-text">{{ Math.round(cfg.vol * 100) }}%</span>
          </label>

          <p v-if="cfg.soundSet === 'custom' && !soundsMeta.press.length" class="hint">
            还没有导入按压音，去「资源」页加一个后这里才有「自定义」可用（当前会回退为「小黄鸭」）。
          </p>
          <p v-else-if="soundUnused" class="hint">
            已导入但当前未使用：「音效开关」没开，或「音色」选的不是「自定义」。
          </p>
          <p v-else-if="soundsMeta.press.length" class="hint">
            自定义音色：按压音 {{ soundLabel('press') }}<template v-if="soundsMeta.release.length"> · 释放音 {{ soundLabel('release') }}</template><template v-else> · 释放音未导入（松开时静音）</template>。
          </p>
          <p class="hint">
            四类提醒音（低余额 / 预算 / 峰谷 / 穿透）留空 = 静音，不打扰是默认，
            只在对应提醒真的弹出时响一次（系统通知不受影响）。
          </p>
        </div>
      </div>
    </section>

    <!-- [资源] 素材集中管理：概览（占用 / 清理 / 素材包）· 导入的形象 · 导入的音效 · 内置资源对照。
         与「挂件外观」分工：那边只选「用哪个」，这里管「导了什么、占多大、要不要删、换机器怎么带走」 -->
    <section v-if="activeTab === 'assets'" class="card">
      <div class="card-head">
        <h2>资源概览</h2>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-outline" type="button" :disabled="!unusedCount" @click="doClearUnused()">
            清除未使用{{ unusedCount ? `（${unusedCount}）` : '' }}
          </button>
          <button class="export-btn utils-btn utils-outline" type="button" :disabled="!hasAssets" @click="doClearAssets()">清除全部素材</button>
        </div>
      </div>
      <label class="field row">
        <span class="label">导入素材</span>
        <span class="asset-meta">
          形象 {{ skinGallery.items.length }} 张 · 气泡图 {{ bubbleItems.length }} 张 · 音效 {{ importedSoundCount }} 段 · 合计 {{ fmtBytes(assetTotalBytes) }}
        </span>
      </label>
      <p class="hint">
        「清除未使用」只删当前设置不会用到的素材（画廊里没在用形象、已关掉的提醒音等），正在使用的一律保留；
        「清除全部素材」把导入的形象、气泡图与音效全删掉，形象 / 音色一并回退为内置（与「数据」页勾「导入的素材」是同一操作）。
        两者都只动素材，不影响其它设置。
      </p>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="assetsFold.open = !assetsFold.open">
          {{ assetsFold.open ? '收起素材包' : '素材包（换机器一次带走）' }}
        </button>
        <div v-if="assetsFold.open" class="guide">
          <p class="guide-use">
            <strong>导出：</strong>把导入的形象、气泡图与音效打包成一个 <code>.whaleassets</code> 文件。
            <strong>导入：</strong>形象与气泡图是<strong>补充</strong>（每张都新增，不动现有画廊与在用的那张），
            音效按<strong>槽位覆盖</strong>（同名槽位换成本包里的那段）。内置形象与内置音色不在包里，换机器后本来就有。
          </p>
          <div class="btn-row">
            <button class="secondary utils-btn utils-secondary" :disabled="assetsBusy || !hasAssets" @click="doExportAssets">导出素材包…</button>
            <button class="secondary utils-btn utils-secondary" :disabled="assetsBusy" @click="doPickAssets">导入素材包…</button>
            <button v-if="assetsPack" class="secondary utils-btn utils-secondary" @click="doCancelAssets">取消导入</button>
          </div>

          <div v-if="assetsPack">
            <p class="guide-use">
              已选文件：<code>{{ assetsPack.path }}</code><br />
              导出时间：{{ assetsPack.exportedAt || '未知' }} · 插件版本：{{ assetsPack.appVersion || '未知' }}
            </p>
            <label class="field row check">
              <span class="label">形象 <em>{{ packLine(assetsPack.has?.skins, '张', assetsSkinNames) }}</em></span>
              <input type="checkbox" v-model="assetsPicks.skins" :disabled="!assetsPack.has?.skins" @change="assetsConfirm = false" />
            </label>
            <label class="field row check">
              <span class="label">气泡图 <em>{{ packLine(assetsPack.has?.bubbles, '张', assetsBubbleNames) }}</em></span>
              <input type="checkbox" v-model="assetsPicks.bubbles" :disabled="!assetsPack.has?.bubbles" @change="assetsConfirm = false" />
            </label>
            <label class="field row check">
              <span class="label">音效 <em>{{ packLine(assetsPack.has?.sounds, '段', assetsSoundNames) }}</em></span>
              <input type="checkbox" v-model="assetsPicks.sounds" :disabled="!assetsPack.has?.sounds" @change="assetsConfirm = false" />
            </label>
            <div class="btn-row">
              <button class="danger utils-btn utils-danger" :disabled="assetsBusy || !assetsAnyItem" @click="doApplyAssets">
                {{ assetsConfirm ? '确认导入？同名音效槽位会被覆盖' : '导入选中项' }}
              </button>
              <button v-if="assetsConfirm" class="secondary utils-btn utils-secondary" @click="assetsConfirm = false">取消</button>
            </div>
          </div>
          <p v-if="assetsFlash.msg" class="msg" :class="msgCls(assetsFlash)">{{ assetsFlash.msg }}</p>
        </div>
      </div>
    </section>

    <!-- [资源] 导入的形象：画廊（点缩略图切换、置顶、删除） -->
    <section v-if="activeTab === 'assets'" class="card">
      <div class="card-head">
        <h2>导入的形象</h2>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-outline" type="button" @click="doImportSkin()">导入图片…</button>
        </div>
      </div>
      <div class="skin-grid">
        <div v-for="it in skinGallery.items" :key="it.id" class="skin-cell"
             :class="{ active: it.id === skinGallery.current }">
          <button class="skin-cell-pick" type="button"
                  :title="`${it.name}（${assetSize(it)} · ${assetAt(it)}）`"
                  @click="doUseSkin(it.id)">
            <img v-if="it.thumb" class="skin-cell-img" :src="it.thumb" :alt="it.name" />
            <span v-else class="skin-cell-none">无预览</span>
          </button>
          <span class="skin-cell-ops">
            <button class="skin-op" type="button" title="置顶" @click.stop="doPinSkin(it.id)">置顶</button>
            <button class="skin-op danger" type="button" title="删除这张" @click.stop="doRemoveSkin(it.id)">删</button>
          </span>
          <span v-if="it.id === skinGallery.current" class="skin-cell-tag">使用中</span>
        </div>
        <button class="skin-cell skin-cell-add" type="button" title="导入图片" @click="doImportSkin()">
          <span class="skin-cell-add-plus">＋</span>
          <span class="skin-cell-add-txt">导入</span>
        </button>
      </div>
      <p v-if="skinMeta" class="hint">
        当前使用：{{ skinMeta.name }}（{{ assetSize(skinMeta) }} · {{ assetAt(skinMeta) }}）；点缩略图切换，最多保留 20 张。
      </p>
      <p v-else class="hint">
        还没有导入形象。点「导入图片…」加一张，支持 png / jpg / webp / gif / apng（动图不裁剪，保留动画）。
      </p>
      <p v-if="skinUnused" class="hint">
        已导入但当前未使用：「挂件外观 → 形象」选的不是「自定义」。
      </p>
      <p v-if="skinFlash.msg" class="msg" :class="msgCls(skinFlash)">{{ skinFlash.msg }}</p>
    </section>

    <!-- [资源] 导入的气泡图：点小鲸鱼抽到「动图组」时随机显示一张。
         与形象不同 —— 没有「当前用哪张」（有图就随机抽，删光即回退内置动图），所以没有「使用中」标记与置顶 -->
    <section v-if="activeTab === 'assets'" class="card">
      <div class="card-head">
        <h2>导入的气泡图</h2>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-outline" type="button" @click="doImportBubble()">导入图片…</button>
        </div>
      </div>
      <div class="skin-grid">
        <div v-for="it in bubbleItems" :key="it.id" class="skin-cell">
          <span class="skin-cell-pick" :title="`${it.name}（${assetSize(it)} · ${assetAt(it)}）`">
            <img v-if="it.thumb" class="skin-cell-img" :src="it.thumb" :alt="it.name" />
            <span v-else class="skin-cell-none">无预览</span>
          </span>
          <span class="skin-cell-ops">
            <button class="skin-op danger" type="button" title="删除这张" @click.stop="doRemoveBubble(it.id)">删</button>
          </span>
        </div>
        <button class="skin-cell skin-cell-add" type="button" title="导入图片" @click="doImportBubble()">
          <span class="skin-cell-add-plus">＋</span>
          <span class="skin-cell-add-txt">导入</span>
        </button>
      </div>
      <p v-if="bubbleItems.length" class="hint">
        点小鲸鱼抽到「动图组」时，从这 {{ bubbleItems.length }} 张里随机显示一张；删光即回退内置动图，最多保留 8 张。
      </p>
      <p v-else class="hint">
        还没有导入气泡图，点小鲸鱼时显示内置动图。点「导入图片…」加一张，支持 png / jpg / webp / gif / apng（动图不裁剪，保留动画）。
      </p>
      <p v-if="bubbleFlash.msg" class="msg" :class="msgCls(bubbleFlash)">{{ bubbleFlash.msg }}</p>
    </section>

    <!-- [资源] 导入的音效：六槽位（按压 / 释放 + 四类提醒音），每槽位可放多段（挂件随机播一条） -->
    <section v-if="activeTab === 'assets'" class="card">
      <h2>导入的音效</h2>
      <div class="sound-group" v-for="r in SOUND_ROLES" :key="r">
        <div class="field row">
          <span class="label" :title="ALERT_SOUND_WHEN[r]">{{ SOUND_ROLE_LABEL[r] }}</span>
          <span class="sound-file" :title="soundLabel(r)">
            {{ soundLabel(r) || (ALERT_SOUND_ROLES.indexOf(r) >= 0 ? '未导入（静音）' : '未导入（可选）') }}
          </span>
          <button class="export-btn utils-btn utils-outline" type="button" @click="doImportSound(r)">
            {{ soundMetaOf(r).length ? '追加' : '导入' }}
          </button>
        </div>
        <div class="field row sound-seg" v-for="(it, i) in soundMetaOf(r)" :key="it.file">
          <span class="sound-file" :title="it.name">{{ i + 1 }}. {{ it.name }}</span>
          <span class="asset-meta">{{ assetSize(it) }} · {{ assetAt(it) }}</span>
          <button class="export-btn utils-btn utils-outline" type="button" @click="doPreviewSound(r, i)">试听</button>
          <button class="export-btn utils-btn utils-outline" type="button" @click="doRemoveSound(r, it.file)">删除</button>
        </div>
      </div>
      <p v-if="cfg.soundSet === 'custom' && !soundsMeta.press.length" class="hint">
        还没有导入按压音，「挂件外观 → 音色」的「自定义」当前会回退为「小黄鸭」。
      </p>
      <p v-if="soundUnused" class="hint">
        按压 / 释放音已导入但当前未使用：「音效开关」没开，或「音色」选的不是「自定义」。
      </p>
      <p class="hint">
        同一槽位可以放多段（点「追加」继续加），挂件每次随机播一条。
        提醒音留空 = 静音（不打扰是默认），只在对应提醒真的弹出时响一次；播放跟随「挂件外观」里的音效开关与音量。
        音效支持 mp3 / wav / ogg 等，导入时可先拖选片段试听（最长 10 秒），结果转成单声道 WAV。
      </p>
      <p v-if="soundFlash.msg" class="msg" :class="msgCls(soundFlash)">{{ soundFlash.msg }}</p>
    </section>

    <!-- [资源] 内置资源：随插件附带、不可删，只作对照（选哪个在「挂件外观」）。
         纯查阅用，默认收起，避免与「导入的…」三张卡一起铺满一屏 -->
    <section v-if="activeTab === 'assets'" class="card">
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="assetFolds.builtin = !assetFolds.builtin">{{ assetFolds.builtin ? '收起内置资源' : '内置资源（随插件附带，只作对照）' }}</button>
        <div v-if="assetFolds.builtin">
          <p class="hint">随插件附带、不可删除，列在这里只作对照；换形象 / 音色请到「挂件外观」。</p>
          <p class="group-title">内置形象 <em>（{{ BUILTIN_SKINS.length }} 张，当前：{{ cfg.skin === 'custom' ? '自定义' : cfg.skin }}）</em></p>
          <div class="skin-grid">
            <div v-for="s in BUILTIN_SKINS" :key="s" class="skin-cell" :class="{ active: cfg.skin === s }">
              <img class="skin-cell-img" :src="builtinSkinUrl(s)" :alt="s" :title="s" />
              <span class="skin-cell-tag">{{ s }}</span>
            </div>
          </div>
          <p class="group-title">内置音色 <em>（两组，在「挂件外观 → 音色」里选；提醒音没有内置回落）</em></p>
          <div class="field row" v-for="g in BUILTIN_SOUND_SETS" :key="g.key">
            <span class="label">{{ g.label }}</span>
            <span class="sound-file">按压 {{ g.press }} · 释放 {{ g.release }}</span>
            <button class="export-btn utils-btn utils-outline" type="button" @click="doPreviewBuiltin(g.press)">试听按压</button>
            <button class="export-btn utils-btn utils-outline" type="button" @click="doPreviewBuiltin(g.release)">试听释放</button>
          </div>
          <p class="hint">
            内置形象与音色是插件包里的文件，不占本地数据目录空间，也不会被「清除素材」删掉。
          </p>
          <p v-if="builtinFlash.msg" class="msg" :class="msgCls(builtinFlash)">{{ builtinFlash.msg }}</p>
        </div>
      </div>
    </section>

    <!-- [外观] 文案：只剩台词库（随机台词组 + 6 个多行文本 + 保存 / 恢复默认）。
         提醒文案结构相同但属「提醒」主题，已并入「用量 → 提醒与通知」卡，免得调一类提醒要跳两个 Tab -->
    <section v-if="activeTab === 'look'" class="card">
      <div class="card-head">
        <button class="fold-title" type="button" @click="quoteCardFolds.open = !quoteCardFolds.open">
          <span class="fold-caret">{{ quoteCardFolds.open ? '▾' : '▸' }}</span>
          文案
        </button>
        <div class="head-actions">
          <span v-if="quotesDirty" class="dirty-tag">未保存</span>
          <button class="export-btn utils-btn utils-outline" type="button" @click="saveQuotes()">保存</button>
          <button class="export-btn utils-btn" :class="quoteResetConfirm ? 'utils-danger' : 'utils-outline'" type="button" @click="resetQuotes()">
            {{ quoteResetConfirm ? '确认恢复默认？' : '恢复默认' }}
          </button>
          <button v-if="quoteResetConfirm" class="export-btn utils-btn utils-outline" type="button" @click="quoteResetConfirm = false">取消</button>
        </div>
      </div>
      <p v-if="!quoteCardFolds.open" class="hint">
        台词库（随机台词组 / 报时 / 动图降级）与固定文案；默认收起，改完记得点「保存」。
      </p>
      <template v-if="quoteCardFolds.open">
      <p v-if="quoteResetConfirm" class="hint">
        将丢弃当前全部自定义台词与固定文案，恢复为内置默认，此操作不可撤销。
      </p>

      <div class="field">
        <span class="label">随机台词组</span>
        <p class="hint quote-group-tip">
          点气泡时按权重随机抽一组，权重越大越常抽到（1–999）；「依次播放」开着时按这里的先后顺序出场。
        </p>
        <div v-for="(g, i) in cfg.quotes.groups" :key="i" class="quote-group">
          <div class="quote-group-head">
            <select v-model="g.kind">
              <option v-for="k in QUOTE_KINDS" :key="k.v" :value="k.v">{{ k.label }}</option>
            </select>
            <span class="quote-w">
              权重
              <input class="num" type="number" min="1" max="999" step="1" v-model.number="g.w" />
            </span>
            <select v-if="g.kind === 'text'" v-model="g.style">
              <option value="A">普通字号</option>
              <option value="B">大字号</option>
            </select>
            <span class="quote-group-sp"></span>
            <button class="export-btn utils-btn utils-outline" type="button" :disabled="i === 0" title="上移" @click="quoteGroupMove(i, -1)">↑</button>
            <button class="export-btn utils-btn utils-outline" type="button" :disabled="i === cfg.quotes.groups.length - 1" title="下移" @click="quoteGroupMove(i, 1)">↓</button>
            <button class="export-btn utils-btn utils-outline" type="button" @click="quoteGroupDel(i)">删除</button>
          </div>
          <textarea v-if="g.kind === 'text'" class="quote-input" rows="3" spellcheck="false"
                    v-model="g.lines" placeholder="一行一条，随机抽一条显示；可写 {balance} / {today} / {peak} / {next} 占位符"></textarea>
          <p v-if="g.kind === 'text' && !String(g.lines || '').trim()" class="hint quote-group-note">
            还没填台词，保存后这一组会被丢掉
          </p>
          <p v-else-if="g.kind === 'card'" class="hint quote-group-note">
            内置卡片：内容按当前余额 / 峰谷时段现算，文字改不了
          </p>
          <p v-else-if="g.kind === 'image'" class="hint quote-group-note">
            抽一张「气泡图」里的图（导入在「资源」页）；没导入过时用内置的 rua.gif
          </p>
        </div>
        <button class="export-btn utils-btn utils-outline" type="button" :disabled="cfg.quotes.groups.length >= QUOTE_GROUP_MAX"
                @click="quoteGroupAdd()">{{ cfg.quotes.groups.length >= QUOTE_GROUP_MAX ? `已达上限（${QUOTE_GROUP_MAX} 组）` : '+ 添加组' }}</button>
      </div>
      <p class="hint">
        台词里可写占位符插入实时数值：<b>{balance}</b> 当前余额、<b>{today}</b> 今日已用、<b>{peak}</b> 当前时段、
        <b>{next}</b> 距下次峰谷切换。后三项是 DeepSeek 口径，主显示换成其它模型时为空；写错的占位符会原样显示出来。
      </p>
      <p class="hint">
        没填台词的「自定义台词」组保存后会被丢掉；一组都不剩时随机台词整体回退为内置默认。
        改动点右上角「保存」才生效，挂件已开着的话立即生效。
      </p>

      <!-- 报时 / 动图降级是不走抽签的固定文案，平时不用改，收进折叠 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="quoteFolds.open = !quoteFolds.open">
          {{ quoteFolds.open ? '收起固定文案' : '固定文案（报时 / 动图降级）' }}
        </button>
        <div v-if="quoteFolds.open" class="guide">
          <label v-for="f in QUOTE_TEXT_FIELDS" :key="f.key" class="field">
            <span class="label">{{ f.label }}</span>
            <textarea class="quote-input" rows="3" spellcheck="false"
                      v-model="cfg.quotes[f.key]" :placeholder="f.hint"></textarea>
          </label>
        </div>
      </div>

      <p class="hint">
        台词一行一条，空行会被丢掉；改完点「保存」才会生效（点「恢复默认」把所有组恢复成内置那六组）。
        台词留空的组保存后会被丢掉（等于这组不出现）。单条最多 60 字、每组最多 30 条、最多 12 组；
        气泡只有三行，超出部分显示不出来。挂件已开着的话保存后立即生效。
      </p>
      <p v-if="quoteFlash.msg" class="msg" :class="msgCls(quoteFlash)">{{ quoteFlash.msg }}</p>
      </template>
    </section>

    <!-- [用量] 用量与账本：用量口径（记账 / 令牌）+ 趋势 + 明细 + 额度 + 校准。
         口径原先在「挂件行为」卡片里，与它影响的图表分家，现在挪到图表上方 -->
    <section v-if="activeTab === 'usage'" class="card">
      <div class="card-head">
        <h2>用量与账本</h2>
        <div class="head-actions">
          <!-- 区间切换：同一组按钮在下方 UsageChart 组件里还有一份（那才是主入口，
               本行是卡片头部就近快捷）。样式走 main.css 的 utils 基类，与组件内那份一致。 -->
          <div class="range-tabs">
            <button v-for="r in usageRangeTabs" :key="r" class="range-tab utils-btn"
                    :class="usageRange === r ? 'utils-primary' : 'utils-secondary'" @click="setUsageRange(r)">{{ r }} 天</button>
          </div>
          <button class="export-btn utils-btn utils-outline" @click="importUsageCsv">导入 CSV</button>
          <button class="export-btn utils-btn utils-outline" :disabled="historyMax <= 0" @click="exportUsageCsv">导出 CSV</button>
        </div>
      </div>

      <label class="field row">
        <span class="label">用量</span>
        <select v-model="cfg.usageMode" @change="onUsageModeChange">
          <option value="ledger">小鲸鱼记账（推荐）</option>
          <option value="token">实时·令牌（需平台 Token）</option>
        </select>
      </label>

      <!-- 历史保留：账本按这个窗口裁剪，趋势图 / 明细 / 导出的可选区间也跟着它 -->
      <label class="field row">
        <span class="label">历史保留</span>
        <input class="num" type="number" :min="HISTORY_KEEP.MIN" :max="HISTORY_KEEP.MAX" step="1"
               v-model.number="cfg.historyKeepDays" @change="onHistoryKeepChange" />
        <span class="num-text">天</span>
        <span class="hint">{{ HISTORY_KEEP.MIN }}–{{ HISTORY_KEEP.MAX }} 天，默认 {{ HISTORY_KEEP.DEFAULT }}；保留越久账本越大</span>
      </label>

      <!-- 自定义单价（可选）：官方调价没跟上、或走中转站按自己的价目结算时用。
           填的是谷价，峰价按官方规则（谷价 × 2）自动翻倍；美元单价按汇率折成人民币记账。
           两种覆盖方式可分别使用：全局开关（对所有模型）与「按模型覆盖」的条目（只改列出的） -->
      <div v-if="cfg.usageMode === 'token'" class="price-box">
        <label class="field row check">
          <span class="label">自定义单价</span>
          <input type="checkbox" v-model="cfg.tokenPrice.on" @change="onTokenPriceChange" />
          <span class="hint">整表覆盖（关闭 = 全部用内置价目表）</span>
        </label>
        <div v-if="cfg.tokenPrice.on" class="price-row">
          <label class="price-cell">
            <span class="price-name">缓存命中</span>
            <input class="num" type="number" min="0" step="0.01" v-model.number="cfg.tokenPrice.hit"
                   @change="onTokenPriceChange" />
          </label>
          <label class="price-cell">
            <span class="price-name">缓存未命中</span>
            <input class="num" type="number" min="0" step="0.01" v-model.number="cfg.tokenPrice.miss"
                   @change="onTokenPriceChange" />
          </label>
          <label class="price-cell">
            <span class="price-name">输出</span>
            <input class="num" type="number" min="0" step="0.01" v-model.number="cfg.tokenPrice.out"
                   @change="onTokenPriceChange" />
          </label>
        </div>
        <label class="field row">
          <span class="label">币种</span>
          <select v-model="cfg.tokenPrice.cur" @change="onTokenPriceChange">
            <option value="CNY">人民币 CNY</option>
            <option value="USD">美元 USD</option>
          </select>
          <template v-if="cfg.tokenPrice.cur === 'USD'">
            <span class="label">汇率</span>
            <input class="num" type="number" min="0" step="0.01" v-model.number="cfg.tokenPrice.rate"
                   @change="onTokenPriceChange" />
            <span class="num-text">元/USD</span>
          </template>
        </label>
        <p class="hint">
          单价单位：{{ cfg.tokenPrice.cur === 'USD' ? '美元' : '元' }} / 百万 token，填谷价（峰价自动翻倍）。
          <template v-if="cfg.tokenPrice.cur === 'USD'">按上方汇率折成人民币后记账。</template>
          改动后下次刷新余额时更新今日已用。
        </p>

        <p class="group-title">
          按模型覆盖 <em>（只改列出的模型，其余仍用内置价目表；名称按子串匹配）</em>
        </p>
        <div v-for="(it, i) in cfg.tokenPrice.models" :key="i" class="price-row">
          <label class="price-cell price-cell-model">
            <span class="price-name">模型名</span>
            <input class="num" type="text" spellcheck="false" placeholder="deepseek-v4-pro"
                   v-model="it.name" @change="onTokenPriceChange" />
          </label>
          <label class="price-cell">
            <span class="price-name">缓存命中</span>
            <input class="num" type="number" min="0" step="0.01" v-model.number="it.hit"
                   @change="onTokenPriceChange" />
          </label>
          <label class="price-cell">
            <span class="price-name">缓存未命中</span>
            <input class="num" type="number" min="0" step="0.01" v-model.number="it.miss"
                   @change="onTokenPriceChange" />
          </label>
          <label class="price-cell">
            <span class="price-name">输出</span>
            <input class="num" type="number" min="0" step="0.01" v-model.number="it.out"
                   @change="onTokenPriceChange" />
          </label>
          <button class="export-btn price-del utils-btn utils-outline" type="button" title="删除这一条"
                  @click="removePriceModel(i)">删</button>
        </div>
        <button class="export-btn utils-btn utils-outline" type="button"
                :disabled="cfg.tokenPrice.models.length >= PRICE_MODEL_MAX"
                @click="addPriceModel()">＋ 添加模型</button>
      </div>

      <div v-if="historyMax > 0" class="chart"
           :class="{ 'chart-dense': usageRange >= 14, 'chart-ultra': usageRange >= 90 }">
        <div v-for="(d, i) in chartDays" :key="d.date" class="bar-col">
          <div class="bar-val">{{ d.usage > 0 && usageRange <= 14 ? fmtMoney(d.usage) : '' }}</div>
          <div class="bar-track">
            <div class="bar" :style="{ height: barHeight(d.usage) + '%' }"></div>
          </div>
          <div class="bar-day">{{ i % labelEvery === 0 ? dayLabel(d.date) : '' }}</div>
        </div>
      </div>
      <p v-else class="hint">暂无用量记录（挂件运行并记账后自动显示）。</p>
      <!-- 「累计已用」是账本的滚动累计（quotaUsed + 今天），不受历史保留期裁剪影响，故与上方区间无关 -->
      <p v-if="historyMax > 0 || cumUsed > 0" class="hint month-sum">
        本月累计 <strong>{{ fmtMoney(monthStats.total) }}</strong>
        · 日均 {{ fmtMoney(monthStats.avg) }}（按已过 {{ monthStats.elapsed }} 天）
        · 最高单日 {{ fmtMoney(monthStats.peak) }}
        · 累计已用 <strong>{{ fmtMoney(cumUsed) }}</strong>
      </p>
      <!-- 账本明细：按日展开当天的异常变动与校准记录。区间跟随上方区间，筛选在本地做 -->
      <div v-if="historyMax > 0 || detailDays.length" class="detail">
        <div class="detail-head">
          <button class="detail-toggle utils-btn utils-outline" @click="toggleDetail">
            {{ detailOpen ? '收起账本明细' : '展开账本明细' }}
          </button>
          <input v-if="detailOpen" class="detail-search" type="search" v-model="detailQuery"
                 placeholder="按日期或原因检索（如 09-12、到期）" />
          <select v-if="detailOpen" class="detail-kind" v-model="detailKind">
            <option value="all">全部记录</option>
            <option value="adjust">只看未计入</option>
            <option value="calibrate">只看校准</option>
          </select>
          <span v-if="detailOpen" class="hint detail-sum">
            近 {{ usageRange }} 天 {{ detailRows.length }} 天 · 合计 {{ fmtMoney(detailTotal) }}
          </span>
        </div>
        <template v-if="detailOpen">
          <div v-for="d in detailRows" :key="d.date" class="detail-day">
            <div class="detail-day-row" @click="toggleDay(d.date)">
              <span class="detail-caret">{{ dayOpen(d.date) ? '▾' : '▸' }}</span>
              <span class="detail-date">{{ d.date }}</span>
              <span class="detail-usage">{{ fmtMoney(d.usage) }}</span>
              <span class="detail-tags">
                <span v-if="adjustSumOf(d) > 0" class="detail-tag">
                  另有 {{ fmtMoney(adjustSumOf(d)) }} 未计入
                </span>
                <span v-else-if="d.entries.length" class="detail-tag detail-tag-mute">
                  {{ d.entries.length }} 条记录
                </span>
              </span>
            </div>
            <div v-if="dayOpen(d.date)" class="detail-entries">
              <div v-for="(e, i) in d.entries" :key="i" class="detail-entry">
                <span class="detail-time">{{ entryTime(e) }}</span>
                <span>{{ entryText(e) }}</span>
              </div>
              <p v-if="!d.entries.length" class="hint">当天无异常变动或校准记录。</p>
            </div>
          </div>
          <p v-if="!detailRows.length" class="hint">没有匹配的记录。</p>
        </template>
      </div>
      <!-- 额度（资源包 / 订阅）：总量与重置周期存配置，已用按周期从账本取（不新增存储与请求） -->
      <div class="quota">
        <label class="field row">
          <span class="label">额度总量</span>
          <input class="num" type="number" min="0" step="1" v-model.number="cfg.quotaTotal"
                 @change="patchCfg({ quotaTotal: cfg.quotaTotal })" />
          <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
          <select class="quota-reset" v-model="cfg.quotaReset" @change="patchCfg({ quotaReset: cfg.quotaReset })">
            <option value="monthly">每月重置</option>
            <option value="daily">每日重置</option>
            <option value="never">不重置</option>
          </select>
        </label>
        <template v-if="cfg.quotaTotal > 0">
          <div class="quota-line">
            {{ quotaPeriodText }} <strong>{{ fmtMoney(quotaUsed) }}</strong> / {{ fmtMoney(cfg.quotaTotal) }}
            · 剩余 <strong>{{ fmtMoney(quotaLeft) }}</strong>（{{ quotaPct }}%）
          </div>
          <div class="quota-track">
            <div class="quota-fill" :class="{ 'quota-fill-warn': quotaPct >= 90 }" :style="{ width: quotaPct + '%' }"></div>
          </div>
        </template>
        <p v-else class="hint">填「额度总量」后这里显示进度与剩余（0 = 不显示）。额度只做展示，不影响余额与记账口径。</p>
      </div>
      <!-- 今日模型占比：模型明细只有平台用量接口会给，因此只在令牌模式显示 -->
      <div v-if="cfg.usageMode === 'token'" class="model-share">
        <div class="model-share-head">
          <span class="model-share-title">今日模型占比</span>
          <span class="hint model-share-sub">
            <template v-if="modelsLoading">读取中…</template>
            <template v-else-if="modelsErr">读取失败：{{ modelsErr }}</template>
            <template v-else-if="!todayModels.length">今日暂无用量记录</template>
            <template v-else>共 {{ fmtMoney(modelsSum) }} · 更新于 {{ modelsTimeText }}</template>
          </span>
        </div>
        <div v-for="(row, i) in todayModels" :key="row.model || 'unknown'" class="model-row">
          <span class="model-name" :title="row.model || '未知模型'">{{ modelLabel(row.model) }}</span>
          <div class="model-track">
            <div class="model-fill"
                 :style="{ width: modelPct(row.amount) + '%', background: MODEL_COLORS[i % MODEL_COLORS.length] }"></div>
          </div>
          <span class="model-pct">{{ modelPct(row.amount) }}%</span>
          <span class="model-cost">{{ fmtMoney(row.amount) }}</span>
        </div>
      </div>
      <p v-if="cfg.usageMode === 'ledger' && todayAdjust > 0" class="hint adjust-note">
        今日另有 <strong>{{ fmtMoney(todayAdjust) }}</strong> 余额变动未计入用量<template v-if="lastAdjustWhy">（{{ lastAdjustWhy }}<template v-if="adjustTimeText">，{{ adjustTimeText }}</template>）</template>；如确为消费可用下方校准补回。
      </p>
      <div v-if="cfg.usageMode === 'ledger'" class="calibrate-row">
        <span class="calibrate-label">校准今日已用</span>
        <input class="num calibrate-input" type="number" min="0" step="0.01"
               v-model.number="calibrateInput" placeholder="实际金额" @keyup.enter="calibrateToday" />
        <button class="export-btn utils-btn utils-outline" :disabled="calibrateInputEmpty" @click="calibrateToday">校准</button>
      </div>
      <p v-else class="hint">当前为「平台令牌」用量模式，今日已用以平台返回为准，无需校准。</p>
      <p v-if="calibrateFlash.msg" class="msg" :class="msgCls(calibrateFlash)">{{ calibrateFlash.msg }}</p>
      <p v-if="exportFlash.msg" class="msg" :class="msgCls(exportFlash)">{{ exportFlash.msg }}</p>
      <p v-if="importFlash.msg" class="msg" :class="msgCls(importFlash)">{{ importFlash.msg }}</p>
    </section>

    <!-- [用量] 提醒与通知：四类自动提醒（峰谷切换 / 低余额 / 今日预算 / 余额大幅波动）+ 计时通知 + 提醒文案。
         原先开关挤在「挂件行为」那张 106 行的卡里、文案挂在「外观 → 文案」卡里，调一类提醒要跳两个 Tab，
         现在按「提醒」这个主题收成一张卡，文案作为卡内折叠 -->
    <section v-if="activeTab === 'usage'" class="card">
      <h2>提醒与通知</h2>

      <label class="field row check">
        <span class="label">峰谷切换提醒 <em>（进入峰/谷时段时气泡提示，需开启思考气泡）</em></span>
        <input type="checkbox" v-model="cfg.peakRemindOn" @change="patchCfg({ peakRemindOn: cfg.peakRemindOn })" />
      </label>

      <label class="field row check">
        <span class="label">计时到点通知 <em>（挂件菜单「计时」到点时弹系统通知）</em></span>
        <input type="checkbox" v-model="cfg.timerNotifyOn" @change="patchCfg({ timerNotifyOn: cfg.timerNotifyOn })" />
      </label>

      <label class="field row check">
        <span class="label">记住计时状态 <em>（重载插件 / 重建挂件后继续计时）</em></span>
        <input type="checkbox" v-model="cfg.timerPersistOn" @change="patchCfg({ timerPersistOn: cfg.timerPersistOn })" />
      </label>

      <!-- 计时气泡口径：原先只在挂件菜单「计时 → 更多」里，那层嵌套折叠已去掉，挪到本页 -->
      <label class="field row check">
        <span class="label">计时气泡常驻 <em>（开启：计时中气泡一直显示；关闭：只在开始时短暂显示，点小鲸鱼可随时查看）</em></span>
        <input type="checkbox" v-model="cfg.timerBubblePin" @change="patchCfg({ timerBubblePin: cfg.timerBubblePin })" />
      </label>
      <label class="field row check">
        <span class="label">计时中只显示计时 <em>（开启：气泡只显示计时；关闭：气泡照常显示余额、今日用量等全部内容）</em></span>
        <input type="checkbox" v-model="cfg.timerBubbleOnly" @change="patchCfg({ timerBubbleOnly: cfg.timerBubbleOnly })" />
      </label>

      <!-- 计时时长：与挂件菜单「倒计时」三段输入同一份配置（cfg.timerSec 存秒），
           这里用三个数字框拆开展示，任一段改动都折算回秒提交 -->
      <div class="field row">
        <span class="label">倒计时时长 <em>（挂件菜单「计时」里也能改；0 时 0 分 0 秒按 25 分钟算）</em></span>
        <input class="num" type="number" min="0" max="23" step="1" v-model.number="timerHms.h" @change="commitTimerHms" />
        <span class="num-text">时</span>
        <input class="num" type="number" min="0" max="59" step="1" v-model.number="timerHms.m" @change="commitTimerHms" />
        <span class="num-text">分</span>
        <input class="num" type="number" min="0" max="59" step="1" v-model.number="timerHms.s" @change="commitTimerHms" />
        <span class="num-text">秒</span>
      </div>

      <label class="field row">
        <span class="label">到点提醒我 <em>（开始计时前写一句「结束后要做什么」，到点时显示在气泡与通知里）</em></span>
        <input type="text" v-model="cfg.timerNote" :maxlength="TIMER_NOTE_MAX" placeholder="例如：起来喝水、活动一下"
               @change="patchCfg({ timerNote: cfg.timerNote })" />
      </label>

      <label class="field row check">
        <span class="label">到点后给「休息」快捷键 <em>（气泡旁的按钮点一下直接开始休息计时）</em></span>
        <input type="checkbox" v-model="timerBreakOn" @change="onTimerBreakToggle" />
      </label>
      <label v-if="timerBreakOn" class="field row">
        <span class="label">休息时长</span>
        <input class="num" type="number" min="1" max="120" step="1" v-model.number="timerBreakMinEdit" @change="commitTimerBreak" />
        <span class="num-text">分钟</span>
      </label>

      <label class="field row check">
        <span class="label">低余额预警 <em>（余额低于阈值时数字变红，并弹一次提醒气泡 + 每天一次系统通知）</em></span>
        <input type="checkbox" v-model="cfg.lowAlertOn" @change="patchCfg({ lowAlertOn: cfg.lowAlertOn })" />
      </label>
      <label v-if="cfg.lowAlertOn" class="field row">
        <span class="label">预警阈值</span>
        <input class="num" type="number" min="0" step="1" v-model.number="cfg.lowAlertAmount"
               @change="patchCfg({ lowAlertAmount: cfg.lowAlertAmount })" />
        <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
      </label>

      <label class="field row check">
        <span class="label">今日预算提醒 <em>（今日用量超出预算时气泡提示，并每天弹一次系统通知）</em></span>
        <input type="checkbox" v-model="cfg.budgetOn" @change="onBudgetToggle" />
      </label>
      <label v-if="cfg.budgetOn" class="field row">
        <span class="label">每日预算</span>
        <input class="num" type="number" min="0" step="1" v-model.number="cfg.budgetAmount"
               @change="patchCfg({ budgetAmount: cfg.budgetAmount })" />
        <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
      </label>

      <label class="field row check">
        <span class="label">余额大幅波动通知 <em>（单次采样余额下降超过阈值时弹一次系统通知）</em></span>
        <input type="checkbox" v-model="cfg.dropAlertOn" @change="onDropToggle" />
      </label>
      <label v-if="cfg.dropAlertOn" class="field row">
        <span class="label">波动阈值</span>
        <input class="num" type="number" min="0" step="1" v-model.number="cfg.dropAlertAmount"
               @change="patchCfg({ dropAlertAmount: cfg.dropAlertAmount })" />
        <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
      </label>
      <p v-if="cfg.dropAlertOn" class="hint">
        每发生一次「余额一次少掉 ≥ 阈值」就通知一次（不受「每天一次」限制）。被防误判拦下的下降（赠送额到期、异常跳变）也会通知，并注明原因；
        跨天、换币种、换 API Key 时两边余额不可比，不会误报。免打扰时段内静默不发通知。
      </p>

      <!-- 通知渠道：上面这些提醒「用什么方式送达」。系统通知 = 桌面弹窗；邮件 = SMTP 直发。
           渠道是总开关，与具体哪几类提醒要开无关 —— 后者在上面各自的开关里 -->
      <h3 class="sub">通知方式</h3>

      <label class="field row check">
        <span class="label">系统通知 <em>（桌面弹窗；关闭后所有自动提醒与计时都不再弹窗）</em></span>
        <input type="checkbox" v-model="cfg.notifySystemOn" @change="patchCfg({ notifySystemOn: cfg.notifySystemOn })" />
      </label>

      <label class="field row check">
        <span class="label">邮件通知 <em>（把提醒发到邮箱；需先填下方 SMTP 配置）</em></span>
        <input type="checkbox" v-model="cfg.notifyMailOn" @change="patchCfg({ notifyMailOn: cfg.notifyMailOn })" />
      </label>

      <!-- 测试按钮：按当前开着的渠道各发一条，用来确认「开关 + 配置」确实能送达。
           系统通知渠道 = 宿主 notifySystem；邮件 = 宿主 sendMailAsync；都不做「每天一次」去重 -->
      <div class="btn-row">
        <button class="export-btn utils-btn utils-outline" type="button" :disabled="notifyTesting" @click="testNotify()">
          {{ notifyTesting ? '发送中…' : '测试通知' }}
        </button>
      </div>
      <p v-if="notifyFlash.msg" class="msg" :class="msgCls(notifyFlash)">{{ notifyFlash.msg }}</p>

      <!-- SMTP 配置：只在「邮件通知」开着时出现。配置齐全后自动收起成一行摘要，
           把卡片位置让回给上面的提醒开关；点「重新配置」可再展开（见 mailOpen） -->
      <div v-if="cfg.notifyMailOn" class="fold">
        <p v-if="mailConfigured && !mailOpen" class="mail-summary">
          <span class="ok-tag">已配置</span>
          {{ mail.mailHost }}:{{ mail.mailPort }} → {{ cfg.mailTo || '（未填收件人）' }}
          <button class="link-btn inline utils-btn utils-secondary" type="button" @click="toggleMailFold()">重新配置</button>
        </p>
        <button v-else class="link-btn utils-btn utils-secondary" type="button" @click="toggleMailFold()">
          {{ mailConfigured ? '收起 SMTP 配置' : 'SMTP 配置（必填）' }}
        </button>

        <div v-if="mailOpen" class="guide">
          <label class="field row">
            <span class="label">SMTP 服务器</span>
            <input v-model="mail.mailHost" type="text" placeholder="smtp.qq.com" autocomplete="off" />
          </label>
          <label class="field row">
            <span class="label">端口</span>
            <input class="num" type="number" min="1" max="65535" v-model.number="mail.mailPort" />
          </label>
          <label class="field row check">
            <span class="label">SSL/TLS 直连 <em>（465 端口勾上；587 / 25 取消勾选，连上后自动 STARTTLS 升级）</em></span>
            <input type="checkbox" v-model="mail.mailSecure" />
          </label>

          <label class="field row">
            <span class="label">账号</span>
            <input v-model="mail.mailUser" type="text" placeholder="you@qq.com" autocomplete="off" />
          </label>
          <label class="field row">
            <span class="label">授权码</span>
            <input v-model="mail.mailPass" type="password" :placeholder="mailPassSaved ? '已保存，留空则不修改' : '邮箱授权码（非登录密码）'" autocomplete="off" />
          </label>
          <p class="hint">
            授权码存于 uTools 加密存储，<b>不进备份文件</b>；填过一次后留空即表示沿用已保存的值。
            多数邮箱（QQ / 163 / Gmail）需要在邮箱设置里单独开启 SMTP 并生成授权码，不能直接填登录密码。
          </p>

          <label class="field row">
            <span class="label">发件人</span>
            <input v-model="cfg.mailFrom" type="text" placeholder="与上方账号一致" autocomplete="off" />
          </label>
          <label class="field row">
            <span class="label">收件人</span>
            <input v-model="cfg.mailTo" type="text" placeholder="收提醒的邮箱（可与发件人相同）" autocomplete="off" />
          </label>
          <label class="field row">
            <span class="label">发件人显示名</span>
            <input v-model="cfg.mailFromName" type="text" placeholder="小鲸鱼余额挂件" autocomplete="off" />
          </label>
          <label class="field row">
            <span class="label">主题前缀</span>
            <input v-model="cfg.mailSubjectPrefix" type="text" placeholder="[小鲸鱼余额挂件]" autocomplete="off" />
          </label>

          <label class="field row check">
            <span class="label">计时到点也发邮件 <em>（除系统通知外，到点另发一封邮件；关掉则只有系统通知）</em></span>
            <input type="checkbox" v-model="cfg.timerMailOn" @change="patchCfg({ timerMailOn: cfg.timerMailOn })" />
          </label>

          <div class="btn-row">
            <button class="export-btn utils-btn utils-outline" type="button" @click="saveMailSettings()">保存邮件设置</button>
            <button class="export-btn utils-btn utils-outline" type="button" :disabled="mailTesting" @click="testMail()">
              {{ mailTesting ? '发送中…' : '发送测试邮件' }}
            </button>
          </div>
          <p v-if="mailFlash.msg" class="msg" :class="msgCls(mailFlash)">{{ mailFlash.msg }}</p>
          <p class="hint">
            测试邮件用的是上方「当前填的内容」（未保存也会用），方便先验证再保存；<b>发送成功会自动收起本区</b>。
            改完记得点「保存邮件设置」——上方「测试通知」读的是已保存的配置，两者分工不同。
            免打扰时段内邮件与系统通知一并静默（计时到点不受免打扰影响）。
          </p>
        </div>
      </div>

      <!-- 低频的「提醒表现 + 时段 + 文案」收在一处折叠，卡片默认只留「哪几类提醒要开」 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="alertFolds.open = !alertFolds.open">
          {{ alertFolds.open ? '收起更多提醒设置' : '更多提醒设置（停留时长 / 免打扰 / 文案）' }}
        </button>
        <div v-if="alertFolds.open" class="guide">
          <label class="field row">
            <span class="label">提醒停留时长</span>
            <select v-model.number="cfg.remindSec" @change="patchCfg({ remindSec: cfg.remindSec })">
              <option :value="0">常驻（手动点掉）</option>
              <option :value="5">5 秒</option>
              <option :value="8">8 秒</option>
              <option :value="15">15 秒</option>
            </select>
          </label>
          <p class="hint">峰谷切换 / 今日预算 / 低余额 / 穿透说明这几类提醒气泡的停留时间（随机台词不受影响）。</p>

          <label class="field row check">
            <span class="label">免打扰时段 <em>（时段内只弹气泡，不弹自动提醒的系统通知；跨午夜如 23:00–07:00 也支持）</em></span>
            <input type="checkbox" v-model="cfg.quietOn" @change="patchCfg({ quietOn: cfg.quietOn })" />
          </label>
          <label v-if="cfg.quietOn" class="field row">
            <span class="label">免打扰起止</span>
            <input class="time" type="time" v-model="cfg.quietFrom" @change="patchCfg({ quietFrom: cfg.quietFrom })" />
            <em class="time-sep">至</em>
            <input class="time" type="time" v-model="cfg.quietTo" @change="patchCfg({ quietTo: cfg.quietTo })" />
          </label>
          <p v-if="cfg.quietOn" class="hint">
            免打扰静默「今日预算」「低余额」「余额大幅波动」三类自动通知（邮件一并静默）：前两类不占用当天名额（出时段后仍会补发一次），
            波动通知本身就是一次性的、不补发。计时到点是你主动设定的一次性提醒，照常通知。
          </p>

          <!-- 提醒文案：四类自动提醒（低余额 / 预算 / 峰谷 / 穿透）的气泡与系统通知文案 -->
          <label v-for="f in ALERT_FIELDS" :key="f.key" class="field">
            <span class="label">{{ f.label }}</span>
            <textarea class="quote-input" rows="3" spellcheck="false"
                      v-model="cfg.alerts[f.key]" :placeholder="f.hint"></textarea>
          </label>

          <p class="hint">
            低余额 / 今日预算 / 峰谷切换 / 鼠标穿透这几类自动提醒的<b>气泡与系统通知共用这里的文案</b>。
            <b>最多三行</b>，依次对应气泡的「标题 / 大字 / 说明」；行数不够则后面的行留空，多于三行的并进说明行。
            系统通知取全文（换行合并成一行）。空行会被丢掉，清空某一条 = 该条恢复内置默认。
            占位符按各输入框里的提示填写，写错的会原样显示出来。改完点「保存」才生效，挂件已开着的话立即生效。
          </p>
          <p class="hint">
            注意：低余额文案用于内置 DeepSeek 的预警；多厂商模型的余额通知带模型名，不受这里影响。
          </p>
          <p v-if="alertResetConfirm" class="hint">
            将丢弃全部自定义提醒文案，恢复为内置默认，此操作不可撤销。
          </p>
          <div class="btn-row">
            <span v-if="alertsDirty" class="dirty-tag">未保存</span>
            <button class="export-btn utils-btn utils-outline" type="button" @click="saveAlerts()">保存</button>
            <button class="export-btn utils-btn" :class="alertResetConfirm ? 'utils-danger' : 'utils-outline'" type="button" @click="resetAlerts()">
              {{ alertResetConfirm ? '确认恢复默认？' : '恢复默认' }}
            </button>
            <button v-if="alertResetConfirm" class="export-btn utils-btn utils-outline" type="button" @click="alertResetConfirm = false">取消</button>
          </div>
          <p v-if="alertFlash.msg" class="msg" :class="msgCls(alertFlash)">{{ alertFlash.msg }}</p>
        </div>
      </div>
    </section>

    <!-- [用量] 多厂商模型：注册表存配置、余额存运行时快照；挂件菜单里可切换主显示的是哪一个 -->
    <section v-if="activeTab === 'usage'" class="card">
      <div class="card-head">
        <h2>模型与余额</h2>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-outline" :disabled="modelsRefreshing" @click="refreshModelRows()">
            {{ modelsRefreshing ? '刷新中…' : '刷新全部' }}
          </button>
          <button class="export-btn utils-btn utils-outline" :disabled="modelConfigs.length >= modelMax" @click="openNewModel">添加模型</button>
        </div>
      </div>
      <p class="hint">
        挂件默认显示 DeepSeek 余额；这里添加的厂商模型（{{ modelConfigs.length }}/{{ modelMax }}）可在挂件菜单里切换成主显示。
        余额按原币种展示、不折算汇率，只在本机查询；密钥用 uTools 加密存储，不写进备份文件。
      </p>
      <div class="mm-list">
        <div v-for="m in modelRows" :key="m.id" class="mm-item">
          <div v-if="m.id !== NEW_MODEL_ROW" class="mm-row">
            <input class="mm-radio" type="radio" name="mm-main" :value="m.id" v-model="modelsMainId"
                   :title="modelsMainId === m.id ? '当前挂件主显示' : '设为挂件主显示'"
                   @change="setMainModelRow(m.id)" />
            <span class="mm-name" :title="m.name">{{ m.name }}</span>
            <span class="mm-val" :class="{ 'mm-val-err': !!m.error }">{{ modelValueText(m) }}</span>
            <span class="mm-sub" :title="modelSubText(m)">{{ modelSubText(m) }}</span>
            <span v-if="m.builtin" class="mm-tag">内置</span>
            <template v-else>
              <button class="link-btn mm-act utils-btn utils-secondary" @click="openModelRow(m.id)">{{ modelOpen === m.id ? '收起' : '设置' }}</button>
              <button class="link-btn mm-act utils-btn utils-secondary" :disabled="modelsRefreshing" @click="refreshModelRows([m.id])">刷新</button>
              <button class="link-btn mm-act mm-del utils-btn utils-secondary"
                      @click="modelDelConfirm = modelDelConfirm === m.id ? '' : m.id">删除</button>
            </template>
          </div>
          <div v-if="m.id !== NEW_MODEL_ROW && modelDelConfirm === m.id" class="mm-confirm">
            <span>删除「{{ m.name }}」？它的密钥与余额记录会一并清除。</span>
            <button class="export-btn utils-btn utils-outline" @click="removeModelRow(m.id)">确认删除</button>
            <button class="link-btn mm-act utils-btn utils-secondary" @click="modelDelConfirm = ''">取消</button>
          </div>
          <!-- 行内编辑：新增草稿（NEW_MODEL_ROW）与编辑已有模型共用这一套表单 -->
          <div v-if="modelOpen === m.id && modelForm" class="mm-form">
            <div class="mm-grid">
              <label class="field">
                <span class="label">厂商模板</span>
                <select v-model="modelForm.tpl" @change="applyModelTpl">
                  <option v-for="t in modelTplOptions" :key="t.key" :value="t.key">{{ t.name }}</option>
                </select>
              </label>
              <label class="field">
                <span class="label">名称</span>
                <input v-model="modelForm.name" maxlength="40" placeholder="挂件菜单里显示的名字" />
              </label>
              <label class="field">
                <span class="label">类型</span>
                <select v-model="modelForm.kind">
                  <option value="balance">余额（金额）</option>
                  <option value="quota">订阅额度（百分比）</option>
                  <option value="codex">Codex 本地会话（token）</option>
                </select>
              </label>
              <label v-if="modelForm.kind !== 'codex'" class="field">
                <span class="label">币种</span>
                <select v-model="modelForm.currency">
                  <option value="CNY">人民币 ¥</option>
                  <option value="USD">美元 $</option>
                </select>
              </label>
            </div>
            <p v-if="modelForm.kind === 'codex'" class="hint">
              Codex 本地会话统计：读取本机 ~/.codex 下的会话日志（rollout JSONL）统计今日 token 用量，
              不需要 API Key、也不发网络请求。挂件上按今日 token 显示，点「测试连接」可立即统计一次。
            </p>
            <label v-if="modelForm.kind !== 'codex'" class="field">
              <span class="label">API Key <em>（留空 = 不改动已存的；本机加密存储）</em></span>
              <input v-model="modelKeys[modelForm.id]" type="password" placeholder="该厂商的 API Key" autocomplete="off" />
            </label>
            <label v-if="modelForm.kind !== 'codex'" class="field">
              <span class="label">接口地址</span>
              <input v-model="modelForm.url" placeholder="https://..." />
            </label>
            <label v-if="modelForm.kind !== 'codex' && (modelForm.url.indexOf('{base}') >= 0 || modelForm.baseUrl)" class="field">
              <span class="label">Base URL <em>（替换接口地址里的 {base}）</em></span>
              <input v-model="modelForm.baseUrl" placeholder="https://your-gateway.com" />
            </label>
            <label v-if="modelForm.kind === 'balance'" class="field">
              <span class="label">余额字段路径</span>
              <input v-model="modelForm.path" placeholder="data.available_balance" />
            </label>
            <label v-else-if="modelForm.kind === 'quota'" class="field">
              <span class="label">已用百分比字段路径</span>
              <input v-model="modelForm.usedPctPath" placeholder="data.limits[0].TOKENS_LIMIT.percentage" />
            </label>
            <label v-if="modelForm.kind === 'balance'" class="field">
              <span class="label">取值倍数 scale <em>（接口单位与展示单位不一致时用，如 0.0001）</em></span>
              <input class="num" type="number" step="any" min="0" v-model.number="modelForm.scale" />
            </label>
            <button v-if="modelForm.kind !== 'codex'" class="link-btn utils-btn utils-secondary" @click="modelAdv[modelForm.id] = !modelAdv[modelForm.id]">
              {{ modelAdv[modelForm.id] ? '收起高级设置' : '高级设置（字段路径 / 认证方式）' }}
            </button>
            <div v-if="modelAdv[modelForm.id] && modelForm.kind !== 'codex'" class="mm-grid">
              <label class="field">
                <span class="label">认证方式</span>
                <select v-model="modelForm.auth">
                  <option value="bearer">Bearer（多数厂商）</option>
                  <option value="raw">原始值（如智谱）</option>
                </select>
              </label>
              <template v-if="modelForm.kind === 'balance'">
                <label class="field">
                  <span class="label">已用额度字段路径 <em>（余额 = 上面的余额 - 本项 × 倍数）</em></span>
                  <input v-model="modelForm.usedPath" placeholder="data.total_usage" />
                </label>
                <label class="field">
                  <span class="label">已用额度倍数</span>
                  <input class="num" type="number" step="any" min="0" v-model.number="modelForm.usedScale" />
                </label>
                <label class="field">
                  <span class="label">已用额度接口地址 <em>（留空 = 与余额同接口）</em></span>
                  <input v-model="modelForm.usedUrl" placeholder="https://..." />
                </label>
              </template>
              <template v-else>
                <label class="field">
                  <span class="label">剩余百分比字段路径</span>
                  <input v-model="modelForm.remainPctPath" placeholder="model_remains[0].current_interval_remaining_percent" />
                </label>
                <label class="field">
                  <span class="label">剩余量字段路径 <em>（与总量一起算百分比）</em></span>
                  <input v-model="modelForm.remainPath" placeholder="usage.remaining" />
                </label>
                <label class="field">
                  <span class="label">总量字段路径</span>
                  <input v-model="modelForm.totalPath" placeholder="usage.limit" />
                </label>
              </template>
              <label class="field">
                <span class="label">重置时刻字段路径</span>
                <input v-model="modelForm.resetPath" placeholder="usage.resetTime" />
              </label>
            </div>
            <label v-if="modelForm.kind !== 'codex'" class="field row check">
              <span class="label">低余额提醒 <em>（低于阈值时弹系统通知，每模型每天一次；额度类看剩余百分比）</em></span>
              <input type="checkbox" v-model="modelForm.lowAlertOn" />
            </label>
            <label v-if="modelForm.kind !== 'codex' && modelForm.lowAlertOn" class="field row">
              <span class="label">提醒阈值</span>
              <input class="num" type="number" min="0" step="any" v-model.number="modelForm.lowAlertAmount" />
              <span class="num-text">{{ modelForm.currency === 'USD' ? '美元' : '元' }}</span>
            </label>
            <div class="btn-row">
              <button class="utils-btn utils-primary" @click="saveModelForm">保存</button>
              <button class="secondary utils-btn utils-secondary" :disabled="modelTesting === modelForm.id" @click="testModelForm">
                {{ modelTesting === modelForm.id ? '测试中…' : '测试连接' }}
              </button>
              <button class="secondary utils-btn utils-secondary" @click="closeModelForm">取消</button>
            </div>
            <p v-if="modelFormErr" class="msg err">{{ modelFormErr }}</p>
          </div>
        </div>
      </div>
      <p v-if="modelsFlash.msg" class="msg" :class="msgCls(modelsFlash)">{{ modelsFlash.msg }}</p>
    </section>

    <!-- [窗口] 挂件窗口：显隐、位置与窗口属性（使用说明 / 故障排查已挪到「帮助」组） -->
    <section v-if="activeTab === 'window'" class="card">
      <h2>挂件窗口</h2>
      <label class="field row">
        <span class="label">进入插件时</span>
        <select v-model="cfg.enterMode" @change="patchCfg({ enterMode: cfg.enterMode })">
          <option value="both">设置窗口 + 挂件</option>
          <option value="widget">只显示挂件</option>
          <option value="settings">只显示设置窗口</option>
        </select>
      </label>
      <div class="btn-row">
        <button class="utils-btn utils-primary" @click="showWidget">显示挂件</button>
        <button class="secondary utils-btn utils-secondary" @click="hideWidget">隐藏挂件</button>
      </div>

      <label class="field row check">
        <span class="label">窗口置顶</span>
        <input type="checkbox" v-model="cfg.onTop" @change="patchCfg({ onTop: cfg.onTop })" />
      </label>

      <label class="field row check">
        <span class="label">锁定位置 <em>（禁止拖拽与滚轮缩放，点击刷新仍可用）</em></span>
        <input type="checkbox" v-model="cfg.dragLock" @change="patchCfg({ dragLock: cfg.dragLock })" />
      </label>

      <label class="field row">
        <span class="label">窗口透明度</span>
        <input class="range" type="range" min="20" max="100" step="5" v-model.number="cfg.opacity"
               @input="onOpacityLive" @change="onOpacityCommit" />
        <em class="range-val">{{ cfg.opacity }}%</em>
      </label>
      <p class="hint">透明度作用于整个挂件（含气泡与菜单）；拖动实时预览。</p>

      <label class="field row check">
        <span class="label">鼠标穿透 <em>（挂件完全不接收鼠标——点击/拖拽/菜单全部穿透；在鲸鱼上停留约 1 秒可临时接管）</em></span>
        <input type="checkbox" v-model="cfg.passThrough" @change="patchCfg({ passThrough: cfg.passThrough })" />
      </label>
      <p class="hint">
        穿透开启后挂件自身菜单也点不到，建议先绑定全局快捷键作为「逃生通道」：uTools 设置 → 全局功能 → 新增 → 指令填「切换鼠标穿透」→ 按下组合键。也可在鲸鱼上停留约 1 秒临时接管后再关。
      </p>
      <div class="btn-row">
        <button class="secondary utils-btn utils-secondary" @click="copyHotkeyCmd('切换鼠标穿透')">复制「穿透」指令名</button>
        <button class="secondary utils-btn utils-secondary" @click="addHotkey('切换鼠标穿透')">新增「穿透」快捷键</button>
      </div>

      <label class="field row check">
        <span class="label">自动避让任务栏 <em>（实时识别任务栏隐藏/显示，弹出时让位、收起后贴回）</em></span>
        <input type="checkbox" v-model="cfg.avoidTaskbar" @change="patchCfg({ avoidTaskbar: cfg.avoidTaskbar })" />
      </label>
      <p class="hint taskbar-hint">
        任务栏：{{ taskbarText }}
        <em v-if="!cfg.avoidTaskbar">（避让已关闭，挂件位置不再跟随任务栏变化）</em>
      </p>

      <label class="field row">
        <span class="label">贴边间距</span>
        <span class="edge-row">
          <em>上</em><input class="num" type="number" min="0" max="400" step="4" v-model.number="cfg.edgeTop" @change="patchCfg({ edgeTop: cfg.edgeTop })" />
          <em>右</em><input class="num" type="number" min="0" max="400" step="4" v-model.number="cfg.edgeRight" @change="patchCfg({ edgeRight: cfg.edgeRight })" />
          <em>下</em><input class="num" type="number" min="0" max="400" step="4" v-model.number="cfg.edgeBottom" @change="patchCfg({ edgeBottom: cfg.edgeBottom })" />
          <em>左</em><input class="num" type="number" min="0" max="400" step="4" v-model.number="cfg.edgeLeft" @change="patchCfg({ edgeLeft: cfg.edgeLeft })" />
        </span>
      </label>
      <p class="hint">贴边间距：挂件贴到该边时留出的像素数（0＝紧贴）。开了「自动避让任务栏」时，任务栏占位的那条边会自动让位；任务栏收起后又回到这里设定的贴边位置。</p>

      <label class="field row">
        <span class="label">吸附与翻转</span>
        <select v-model="cfg.snapMode" @change="patchCfg({ snapMode: cfg.snapMode })">
          <option value="ratio">比例吸附</option>
          <option value="off">关闭（自由摆放）</option>
        </select>
      </label>
      <label class="field row" v-if="cfg.snapMode === 'ratio'">
        <span class="label">吸附区宽度</span>
        <input class="num" type="number" :min="SNAP_RATIO_MIN" :max="SNAP_RATIO_MAX" step="1" v-model.number="cfg.snapRatio" @change="patchCfg({ snapRatio: cfg.snapRatio })" />
        <span class="num-text">%</span>
      </label>
      <p class="hint">
        吸附：拖拽松手时，挂件中心落进某条边的吸附区就贴到那条边（吸附区宽度按可用区宽/高算，默认 25%＝左右各 1/4、上下各 1/4）。
        关掉吸附后松手停在哪就是哪，不再自动贴边。
      </p>
      <p class="hint">
        朝向不用配：锚在屏幕左半边就朝右、右半边就朝左，鲸鱼始终面向屏幕内侧（关掉吸附也一样）。
      </p>

      <label class="field row check">
        <span class="label">避让滚动条 <em>（挂件贴右边缘时留出像素，避免盖住最大化窗口的纵向滚动条）</em></span>
        <input type="checkbox" v-model="cfg.scrollGapOn" @change="patchCfg({ scrollGapOn: cfg.scrollGapOn })" />
      </label>
      <label class="field row" v-if="cfg.scrollGapOn">
        <span class="label">滚动条宽度</span>
        <input class="num" type="number" min="0" max="100" step="1" v-model.number="cfg.scrollGapPx" @change="patchCfg({ scrollGapPx: cfg.scrollGapPx })" />
        <span class="num-text">px</span>
      </label>
      <p class="hint" v-if="cfg.scrollGapOn">Windows 默认滚动条约 17px；填 0 等于贴边（与关闭开关等效）。与「贴边间距 → 右」取较大值，不会叠加。</p>

      <div class="btn-row">
        <button class="secondary utils-btn utils-secondary" @click="resetWidgetPos">复位窗口位置</button>
      </div>
      <p class="hint">把挂件挪回默认位置（右下角、紧贴边缘）——换显示器、改分辨率或拖出屏幕后用。</p>
      <p v-if="widgetFlash.msg" class="msg" :class="msgCls(widgetFlash)">{{ widgetFlash.msg }}</p>
    </section>

    <!-- [帮助] 使用帮助：使用说明 / 快捷键绑定 / 挂件故障排查。
         这些原先都堆在「挂件窗口」卡尾（一次性配置 + 排查 + 说明），日常要调的窗口项被埋在一堆说明下面。
         这里叫「挂件故障排查」以区别 dsh 卡里的「dsh 故障排查」—— 前者是插件自身日志，后者是 dsh 子进程日志 -->
    <section v-if="activeTab === 'help'" class="card">
      <h2>使用帮助</h2>
      <p class="hint">给「显示/隐藏挂件」绑定一个全局快捷键（想给「鼠标穿透」也绑一个，见「窗口」组）。</p>
      <div class="btn-row">
        <button class="secondary utils-btn utils-secondary" @click="copyHotkeyCmd()">复制指令名</button>
        <button class="secondary utils-btn utils-secondary" @click="addHotkey()">新增快捷键</button>
      </div>
      <!-- 新手引导入口：首次引导只弹一次（guideDone），之后从帮助 Tab 重开。
           与「使用说明」「故障排查」同为折叠块、同一视觉语言，不额外占版面 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="onGuideReopen()">新手引导（填 DeepSeek 凭据）</button>
      </div>
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="widgetFolds.help = !widgetFolds.help">{{ widgetFolds.help ? '收起使用说明' : '使用说明' }}</button>
        <div v-if="widgetFolds.help" class="guide">
          <p class="guide-use"><strong>进入插件时：</strong>选含挂件的模式后，挂件出现时会抢走焦点、本设置窗口自动收起；改设置请点挂件右上角菜单（或右键）→「打开设置」唤回本窗口。</p>
          <p class="guide-use"><strong>挂件操作：</strong>可拖拽到屏幕四边吸附（吸附区宽度与开关见「挂件窗口」卡片），鲸鱼始终朝屏幕内侧；点击鲸鱼刷新余额，悬停后点右上角菜单调整设置。</p>
          <p class="guide-use"><strong>快捷键：</strong>按 Ctrl+, 打开 uTools 设置 → 全局功能 → 新增 → 指令填「显示/隐藏挂件」→ 按下组合键。可点上方「复制指令名」快速复制。想给「鼠标穿透」也绑一个，指令名填「切换鼠标穿透」。</p>
          <p class="guide-use"><strong>常驻：</strong>退出到后台挂件保留；关闭 Ctrl+D 分离窗口会直接结束插件运行、挂件消失，分离后请用「最小化」；重进插件会自动重建，配置不丢。</p>
        </div>
      </div>
      <div v-if="diagReady" class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="widgetFolds.trouble = !widgetFolds.trouble">{{ widgetFolds.trouble ? '收起挂件故障排查' : '挂件故障排查' }}</button>
        <div v-if="widgetFolds.trouble" class="guide">
          <!-- 标题与日志按钮都带「挂件」前缀：dsh 卡里另有一块「dsh 故障排查」讲 dsh 子进程日志，
               两块都叫「故障排查」时用户会把两处的日志当成同一份 -->
          <p class="guide-use">挂件消失或显示异常时，可复制插件自身的诊断日志（%TEMP%\whale-debug.log）或用系统程序打开日志文件。<strong>这只含挂件与插件自身的日志</strong>；dsh 的日志见「开发者 → dsh」卡里的「查看 dsh 日志」。</p>
          <div class="btn-row">
            <button class="secondary utils-btn utils-secondary" @click="copyDebugLog">复制挂件日志</button>
            <button class="secondary utils-btn utils-secondary" @click="openLogFile">打开挂件日志文件</button>
          </div>
          <p v-if="diagFlash.msg" class="msg" :class="msgCls(diagFlash)">{{ diagFlash.msg }}</p>
        </div>
      </div>
      <div v-if="errDetail" class="err-block">
        <p class="err-title">挂件窗口创建失败</p>
        <pre class="err-box">{{ errDetail }}</pre>
        <div class="btn-row">
          <button class="secondary utils-btn utils-secondary" @click="copyWidgetError">复制错误信息</button>
          <button class="secondary utils-btn utils-secondary" @click="checkWidgetError()">重新检查</button>
        </div>
      </div>
      <button v-else class="link-btn utils-btn utils-secondary" @click="checkWidgetError()">挂件异常？查看错误详情</button>
      <p v-if="errFlash.msg" class="msg" :class="msgCls(errFlash)">{{ errFlash.msg }}</p>
    </section>

    <!-- [数据] 数据与隐私：按项清除 + 备份与恢复 -->
    <section v-if="activeTab === 'data'" class="card">
      <h2>数据与隐私</h2>
      <p class="hint">API Key 与平台 Token 通过 uTools 加密存储，账本、窗口位置与导入的素材（形象 / 气泡图 / 音效）也只保存在本机，不会上传到任何第三方服务器。</p>
      <p class="hint">卸载 uTools 插件不会自动删除这些数据，需要彻底清除时请勾选下方要清除的内容（<strong>清除前建议先导出一份备份</strong>，见下方「备份与恢复」）：</p>
      <label class="field row check">
        <span class="label">凭据 <em>（API Key / 平台 Token）</em></span>
        <input type="checkbox" v-model="clearItems.secrets" @change="clearConfirm = false" />
      </label>
      <label class="field row check">
        <span class="label">挂件设置 <em>（大小 / 音效 / 开关等，清除后按默认值重建挂件）</em></span>
        <input type="checkbox" v-model="clearItems.config" @change="clearConfirm = false" />
      </label>
      <label class="field row check">
        <span class="label">账本用量记录 <em>（今日已用与用量趋势）</em></span>
        <input type="checkbox" v-model="clearItems.ledger" @change="clearConfirm = false" />
      </label>
      <label class="field row check">
        <span class="label">窗口位置与更新缓存 <em>（挂件回到默认位置）</em></span>
        <input type="checkbox" v-model="clearItems.window" @change="clearConfirm = false" />
      </label>
      <label class="field row check">
        <span class="label">导入的素材 <em>（形象 / 气泡图 / 音效文件，删后回退为内置；等同「资源」页的「清除全部素材」）</em></span>
        <input type="checkbox" v-model="clearItems.assets" @change="clearConfirm = false" />
      </label>
      <div class="btn-row">
        <button class="danger utils-btn utils-danger" :disabled="!anyClearItem" @click="clearSelectedData()">
          {{ clearConfirm ? '确认清除选中数据？不可恢复' : '清除选中数据' }}
        </button>
        <button v-if="clearConfirm" class="secondary utils-btn utils-secondary" @click="clearConfirm = false">取消</button>
      </div>
      <p v-if="clearConfirm" class="hint">将清除：{{ clearItemNames || '（未选中任何项）' }}。此操作不可撤销。</p>
      <p v-if="dataFlash.msg" class="msg" :class="msgCls(dataFlash)">{{ dataFlash.msg }}</p>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="backupFolds.open = !backupFolds.open">{{ backupFolds.open ? '收起备份与恢复' : '备份与恢复' }}</button>
        <div v-if="backupFolds.open" class="guide">
          <p class="guide-use"><strong>导出：</strong>把「挂件设置 / 账本 / 窗口位置 / 计时」打包成一个 JSON 文件（不含 dsh 开发者配置与 Node 路径）；<strong>凭据默认不导出</strong>，勾选「包含凭据」后必须设密码，凭据会用 scrypt + AES-256-GCM 加密后才写入文件（文件里没有明文）。</p>
          <p class="guide-use"><strong>安全提示：</strong>密码不会保存到任何地方，忘记就无法解密（其余项仍可正常恢复）；备份文件本身含你的设置与用量记录，请妥善保管。</p>
          <label class="field row check">
            <span class="label">包含凭据 <em>（需设密码，加密后写入）</em></span>
            <input type="checkbox" v-model="backupWithSecrets" @change="backupFlash.msg = ''" />
          </label>
          <label v-if="backupWithSecrets" class="field row">
            <span class="label">备份密码</span>
            <input type="password" v-model="backupPassword" placeholder="至少 6 位，导入时要用" autocomplete="new-password" />
          </label>
          <div class="btn-row">
            <button class="secondary utils-btn utils-secondary" :disabled="backupBusy" @click="backupExport">导出备份…</button>
            <button class="secondary utils-btn utils-secondary" :disabled="backupBusy" @click="backupPick">导入备份…</button>
            <button v-if="backupPreview" class="secondary utils-btn utils-secondary" @click="backupCancelPick">取消导入</button>
          </div>

          <div v-if="backupPreview">
            <p class="guide-use">已选文件：<code>{{ backupPreview.path }}</code><br />导出时间：{{ backupPreview.exportedAt || '未知' }} · 插件版本：{{ backupPreview.appVersion || '未知' }}</p>
            <label v-for="it in backupItems" :key="it.key" class="field row check">
              <span class="label">{{ it.label }} <em>{{ it.note }}{{ backupHas(it.key) ? '' : '：备份里没有这一项' }}</em></span>
              <input type="checkbox" v-model="backupPicks[it.key]" :disabled="!backupHas(it.key)" @change="backupConfirm = false" />
            </label>
            <label v-if="backupHas('secrets')" class="field row">
              <span class="label">备份密码</span>
              <input type="password" v-model="backupPassword" placeholder="导出时设的密码（用于解密凭据）" autocomplete="off" />
            </label>
            <div class="btn-row">
              <button class="danger utils-btn utils-danger" :disabled="backupBusy || !backupAnyItem" @click="backupApply">
                {{ backupConfirm ? '确认覆盖写入？不可撤销' : '恢复选中项' }}
              </button>
              <button v-if="backupConfirm" class="secondary utils-btn utils-secondary" @click="backupConfirm = false">取消</button>
            </div>
          </div>
          <p v-if="backupFlash.msg" class="msg" :class="msgCls(backupFlash)">{{ backupFlash.msg }}</p>
        </div>
      </div>
    </section>

    <!-- [开发者] DeepSeek Harness（dsh） -->
    <section v-if="activeTab === 'dev'" class="card dsh-card">
      <div class="card-head">
        <h2 class="card-toggle" @click="dshMainFold = !dshMainFold">
          <span class="caret">{{ dshMainFold ? '▾' : '▸' }}</span>DeepSeek Harness（dsh）
          <!-- 收起态摘要：状态本来就是启动后自动查的（不额外读盘），所以这里直接报，不像其他卡要等首次展开 -->
          <span v-if="!dshMainFold" class="card-sum">{{ dshStateText }}</span>
        </h2>
      </div>
      <template v-if="dshMainFold">
      <p class="hint">在挂件菜单「dsh」分组或本卡片里 启动 / 重启 / 结束 / 更新 dsh 并打开它的 Web UI（默认 <code>http://127.0.0.1:{{ DEFAULT_DSH_PORT }}</code>，可在下方「高级选项」里改端口）。<strong>优先用你已全局安装的那份</strong>（零重复占用、终端与插件同一版本），没有才装到插件数据目录。</p>

      <label class="field row">
        <span class="label">状态</span>
        <span class="ver">{{ dshStateText }}<span v-if="dsh.nodeVersion"> · Node {{ dsh.nodeVersion }}</span><span v-if="dshLatestTip" class="tag tag-new">{{ dshLatestTip }}</span></span>
      </label>
      <div class="btn-row">
        <button class="utils-btn utils-primary" :disabled="dsh.running || dsh.external || !!dsh.portOther || dshBusy" @click="dshDo('start')">启动</button>
        <button class="secondary utils-btn utils-secondary" :disabled="(!dsh.running && !dsh.external) || dshBusy" @click="dshDo('restart')">重启</button>
        <button class="secondary utils-btn utils-secondary" :disabled="(!dsh.running && !dsh.external) || dshBusy" @click="dshDo('stop')">结束</button>
        <button class="secondary utils-btn utils-secondary" @click="dshOpenPage">打开 Web UI</button>
      </div>
      <!-- 装哪个版本 + 更新，是同一条动作链的两个环节，所以放同一行；
           版本下拉原先在「高级选项」里，一次「装指定版本」要横跨三个折叠区才走完 -->
      <div class="field row dsh-update-row">
        <span class="label">更新版本</span>
        <select v-model="cfg.dshVersion" @change="patchCfg({ dshVersion: cfg.dshVersion })">
          <option v-for="o in dshVersionOptions" :key="o.v" :value="o.v">{{ o.label }}</option>
        </select>
        <!-- 既无全局也无插件安装时实际走的是安装流程，按钮文案别再写「更新」误导。
             「有新版」标记用的是与标题 dshLatestTip 同一个 dsh.hasUpdate，不另算一套：
             没有它时按钮和「没更新」时长得完全一样，用户得回头读标题小字才知道要不要点 -->
        <button class="secondary utils-btn utils-secondary" :disabled="dshBusy" @click="dshDo('update')">
          {{ dsh.resolved || dsh.globalVersion ? '更新' : '安装' }}<span v-if="dsh.hasUpdate" class="tag tag-new">有新版</span>
        </button>
      </div>
      <p v-if="dsh.external" class="hint">{{ dsh.port }} 上检测到由<strong>别的终端</strong>启动的 dsh（pid {{ dsh.externalPid }}）：「结束」会结束它，「重启」会结束它并按当前版本重新启动。</p>
      <p v-else-if="dsh.portOther" class="hint">{{ dsh.port }} 被 {{ dsh.portOther }} 占用（不是 dsh）。为避免误杀，插件不会结束它。</p>

      <!-- 运行详情（只读）：版本对照 / 最近命令 / 页面地址 / 日志，展开时自动查一次最新版本。
           标题不叫「诊断信息」：「dsh 环境诊断」那张卡才是排查启动失败的检查项，
           两块都带「诊断」二字时用户分不清点哪个，这里本质是运行状态详情 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="dshToggleVersions">
          {{ dshFolds.versions ? '收起运行详情' : '运行详情（版本 / 命令 / 地址 / 日志）' }}
        </button>
        <div v-if="dshFolds.versions" class="guide">
          <label class="field row">
            <span class="label">实际使用</span>
            <span class="ver">{{ dsh.resolved || '未安装' }}<span v-if="dsh.resolved && dsh.source" class="tag">{{ dsh.source === 'global' ? '全局' : '插件目录' }}</span></span>
          </label>
          <label class="field row">
            <span class="label">全局安装</span>
            <span class="ver">{{ dsh.globalVersion || '无' }}<span v-if="dsh.globalVersion && !dsh.globalWritable" class="tag">只读，更新会弹一次 UAC</span></span>
          </label>
          <label class="field row">
            <span class="label">插件目录</span>
            <span class="ver">{{ dsh.installed || '未安装' }}</span>
          </label>
          <label class="field row">
            <span class="label">npm latest</span>
            <!-- 不再挂「点更新会装到这个版本」的 tag：那是常驻说明，且下方 dshVerMismatch
                 已按实际情况给出对比句（两者不同才出现），比常驻标签更准也更省视觉噪音 -->
            <span class="ver">{{ dshLatestText }}</span>
          </label>
          <label class="field row">
            <span class="label">最近命令</span>
            <span class="cmdline">{{ dsh.lastCmd || '（还没执行过）' }}</span>
          </label>
          <label class="field row">
            <span class="label">页面地址</span>
            <span class="cmdline">{{ dsh.webUrl || ('http://127.0.0.1:' + dsh.port + '（未捕获 token，dsh 启动完成后会自动获取）') }}</span>
          </label>
          <!-- 复制 / 定位的反馈就近显示：dshValueFlash 同时只挂一条，故四处共用同一行；
               成功与失败都只靠颜色区分（内容对「复制」是同一句、对「定位」是同一句），
               卡底只留错误与需用户决策的提示，见 dshValueTip 处的说明 -->
          <label v-if="dshValueFlash.text" class="field row">
            <span class="label"></span>
            <span class="ver" :class="dshValueFlash.err ? 'err' : 'ok'">{{ dshValueFlash.text }}</span>
          </label>
          <p v-if="dshVerMismatch" class="hint">{{ dshVerMismatch }}</p>
          <!-- 主按钮行只留「改变状态」的动作：查询会重打一次 npm，日志开合是这一块的主视角。
               其余三个（刷新状态 / 定位 dsh 目录 / 复制地址）都是「顺手一下」的辅助动作，
               降成下面一行的文字按钮 —— 否则 8 个等宽按钮并列，主次完全看不出来，还容易误点「清空」。 -->
          <div class="btn-row">
            <!-- 查询过就不再摆按钮：结果已经显示在「npm latest」行里，留着反而让人以为还得再点一下。
                 只有「还没查过」和「上次查失败」才需要这个入口（失败时文案变「重试」） -->
            <button v-if="dshQueryFailed || !dshHasVersions" class="secondary utils-btn utils-secondary" :disabled="dsh.busy === 'versions'" @click="dshQueryVersions">
              {{ dsh.busy === 'versions' ? '查询中…' : (dshQueryFailed ? '重试：查询可用版本' : '查询可用版本') }}
            </button>
            <!-- 日志按钮都带 dsh 前缀：帮助 Tab 里另有一处「复制诊断日志 / 打开日志文件」，
                 那是插件自身的 whale-debug.log，与这里的 dsh 子进程日志是两回事 -->
            <button class="secondary utils-btn utils-secondary" @click="dshLogOpen = !dshLogOpen">{{ dshLogOpen ? '收起 dsh 日志' : '查看 dsh 日志' }}</button>
          </div>
          <div class="btn-row row-link">
            <button class="link-btn utils-btn utils-secondary" @click="dshStatus(true)">刷新状态</button>
            <button v-if="dsh.prefix" class="link-btn utils-btn utils-secondary" @click="dshLocatePrefix">定位 dsh 目录</button>
            <button class="link-btn utils-btn utils-secondary" :disabled="!dsh.webUrl && !dsh.url" @click="dshCopyUrl">复制地址</button>
            <!-- 清空也走二段确认：与「删除插件目录的 dsh」「清理 npx 旧缓存」同一套手势，
                 日志是排查现场，误点一下就没了（且清掉后无法恢复） -->
            <button v-if="dshLogOpen" class="link-btn utils-btn utils-secondary" @click="dshClearLog">
              {{ dshConfirm === 'clear-log' ? '确认清空 dsh 日志？' : '清空 dsh 日志' }}
            </button>
            <button v-if="dshLogOpen" class="link-btn utils-btn utils-secondary" @click="dshCopyLog">复制 dsh 日志</button>
            <span v-if="dshValueFlash.key === 'log'" class="ver" :class="dshValueFlash.err ? 'err' : 'ok'">{{ dshValueFlash.text }}</span>
          </div>
          <pre v-if="dshLogOpen" ref="dshLogEl" class="log-box">{{ dsh.log || '（暂无日志：启动或更新 dsh 后再看）' }}</pre>
        </div>
      </div>

      <!-- 故障排查：与「运行详情」紧邻、都在主控卡头部 —— 这两块是「出问题时才看」的，
           早先故障排查被排在卡尾（运行详情 → 高级选项 → 使用说明 → 故障排查），
           真出问题时用户根本滚不到。标题带 dsh 前缀：帮助 Tab 里另有一块也叫「故障排查」，
           讲的是插件自身（whale-debug.log），不写前缀会让人以为是一回事。 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="dshToggleTrouble">{{ dshFolds.trouble ? '收起 dsh 故障排查' : 'dsh 故障排查' }}</button>
        <div v-if="dshFolds.trouble" class="guide">
          <p class="guide-use"><strong>结束 / 重启：</strong>不只管本插件启动的进程 —— 只要 dsh 端口上跑着 dsh（含在别的终端里启动的）都能被结束；非 dsh 占用端口时会拒绝执行，避免误杀。</p>
          <p class="guide-use"><strong>首次安装很慢：</strong>要下载约 500 个包，国内建议把「npm 注册源」改成淘宝镜像；等待期间状态行会显示「已等待 x 秒」。</p>
          <p class="guide-use"><strong>占用空间：</strong>「删除插件目录的 dsh」清掉插件装的那份（有全局安装时用不到它）；「清理 npx 旧缓存」清掉旧版本留在 npx 缓存里的副本。</p>
          <p class="guide-use"><strong>装 / 卸 / 更新插件时报错、或市场卡片刷不出来：</strong>多半是 dsh 的 profile 写锁残留导致的。dsh 改 profile 前要先拿一把写锁，进程被强杀或取消更新时锁没被释放，之后所有操作都会卡在等锁上（真实报错是 <code>timed out waiting for the writer lock</code>）。点下面的按钮清理即可 —— 只有确认持有它的进程已经不存在时才会清理，锁正被别的进程持有时会拒绝并说明原因。</p>
          <div class="btn-row">
            <button class="secondary utils-btn utils-secondary" :disabled="!dsh.installed || dshBusy" @click="dshMaintain('remove-plugin')">
              {{ dshConfirm === 'remove-plugin' ? '确认删除插件目录的 dsh？' : '删除插件目录的 dsh' }}
            </button>
            <button class="secondary utils-btn utils-secondary" :disabled="dshBusy" @click="dshMaintain('clean-npx')">
              {{ dshConfirm === 'clean-npx' ? '确认清理 npx 旧缓存？' : '清理 npx 旧缓存' }}
            </button>
            <button class="secondary utils-btn utils-secondary" @click="dshMaintain('clear-lock')">
              {{ dshConfirm === 'clear-lock' ? '确认清理残留写锁？' : '清理残留写锁' }}
            </button>
            <button v-if="dshConfirm" class="secondary utils-btn utils-secondary" @click="dshConfirm = ''">取消</button>
          </div>
        </div>
      </div>

      <!-- 操作失败与 dsh.error 合成一条：用户要读的是一句「出了什么事」，
           两个 .msg 叠在卡底会出现两行红字、且与 dsh.error「日志已打开就隐藏」的取值无关；
           合成后判断只落在 dsh.error 上，收起日志也不会突然换一种显示方式 -->
      <p v-if="dsh.error && dshLogOpen" class="msg err">dsh 报错：{{ dsh.error }}（详见下方日志）</p>
      <p v-else-if="dsh.error" class="msg err">dsh 报错：{{ dsh.error }}</p>
      <p v-if="dshFlash.msg" class="msg" :class="msgCls(dshFlash)">{{ dshFlash.msg }}</p>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="dshFolds.advanced = !dshFolds.advanced">{{ dshFolds.advanced ? '收起高级选项' : '高级选项（端口 / 注册源 / Node 目录 / 行为）' }}</button>
        <div v-if="dshFolds.advanced" class="guide">
          <!-- 「dsh 版本」已移到上面的「更新版本」行：它是安装/更新的入参，属于动作的一部分；
               留在这里会让一次「装指定版本」横跨三个折叠区（运行详情查版本 → 这里选版本 → 上面点更新），
               而另外几项（端口 / 注册源 / Node 目录 / 行为）是设一次就不动的环境配置，才是名副其实的高级选项 -->
          <label class="field row">
            <span class="label">Web UI 端口 <em>（默认 3080；改了要重启 dsh 才生效）</em></span>
            <input
              class="num"
              type="number"
              min="1"
              max="65535"
              step="1"
              :value="cfg.dshPort"
              @change="dshSetPort"
            />
          </label>
          <p class="hint">3080 落在 Windows/Hyper-V 的<strong>动态端口保留段</strong>里，被系统预留时 dsh 会直接 bind 失败（报 <code>EADDRINUSE</code>）。这里换成别的端口（如 4080）即可绕开；填非法值（0 / 超出 1–65535）会退回 3080。</p>
          <label class="field row">
            <span class="label">npm 注册源</span>
            <select v-model="cfg.dshRegistry" @change="patchCfg({ dshRegistry: cfg.dshRegistry })">
              <option value="">官方（registry.npmjs.org）</option>
              <option value="https://registry.npmmirror.com">淘宝镜像（registry.npmmirror.com）</option>
            </select>
          </label>
          <label class="field row">
            <span class="label">Node.js 目录</span>
            <span class="ver">{{ dshNodeText }}</span>
          </label>
          <div class="btn-row">
            <button class="secondary utils-btn utils-secondary" @click="dshPickDir">选择目录</button>
            <button v-if="cfg.dshNodeDir" class="secondary utils-btn utils-secondary" @click="dshAutoDir">改为自动探测</button>
          </div>
          <label class="field row check">
            <span class="label">启动时不自动打开浏览器 <em>（勾选：命令追加 --no-open，启动后点「打开 Web UI」查看）</em></span>
            <input type="checkbox" v-model="cfg.dshNoOpen" @change="patchCfg({ dshNoOpen: cfg.dshNoOpen })" />
          </label>
          <label class="field row check">
            <span class="label">更新前重新下载 <em>（先删掉插件目录里的那份再装；用全局那份时不生效）</em></span>
            <input type="checkbox" v-model="cfg.dshReinstall" @change="patchCfg({ dshReinstall: cfg.dshReinstall })" />
          </label>
          <label class="field row check">
            <span class="label">uTools 退出后保留 dsh <em>（不勾选＝插件退出时自动结束，避免占着端口）</em></span>
            <input type="checkbox" v-model="cfg.dshKeepAlive" @change="patchCfg({ dshKeepAlive: cfg.dshKeepAlive })" />
          </label>
        </div>
      </div>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="dshFolds.help = !dshFolds.help">{{ dshFolds.help ? '收起使用说明' : '使用说明' }}</button>
        <div v-if="dshFolds.help" class="guide">
          <p class="guide-use"><strong>启动：</strong>直接 <code>node &lt;那份 dsh&gt;/lib/bin.js web [--no-open]</code>（有全局安装就用全局那份，否则用插件目录的）—— 不再经过 npx，也就不会再堆缓存副本。</p>
          <p class="guide-use"><strong>更新：</strong>结束正在运行的 dsh → 重新安装「dsh 版本」里选定的版本（自动＝latest）→ 原本在跑就用新版重新启动；已有全局安装时更新的就是全局那份（<code>npm i -g</code>）。</p>
          <p class="guide-use"><strong>dsh 自己的数据：</strong>工作目录取用户主目录，配置与数据由 dsh 自己管理（默认 <code>~/.dsh</code>），本插件不做改动。</p>
        </div>
      </div>
      </template>
    </section>
    <!-- [dsh] dsh 只读诊断：五项本地检查，纯只读、不改任何配置、不联网 -->
    <section v-if="activeTab === 'dev'" class="card dsh-card">
      <div class="card-head">
        <h2 class="card-toggle" @click="toggleDevCard('diagnose')">
          <span class="caret">{{ devFolds.diagnose ? '▾' : '▸' }}</span>dsh 环境诊断
          <!-- 收起态摘要：只在「本会话已展开跑过」后才显示，否则不预读、直接提示点开 -->
          <span v-if="!devFolds.diagnose" class="card-sum">
            <template v-if="devStatsLoaded.diagnose">{{ diagnoseSummary }}</template>
            <template v-else>点击展开诊断</template>
          </span>
        </h2>
      </div>
      <template v-if="devFolds.diagnose">
      <p class="hint">
        逐项检查 dsh 起不来 / preset 挂不上的常见原因（重复模块、patch 条目与语法、<code>settings.yaml</code>、dsh 端口归属），
        <strong>全部只读本地文件，不改动任何配置、不发任何网络请求</strong>。问题行的标记含义：<code>[✓]</code> 查过且正常 ·
        <code>[!]</code> 有隐患或这一项没查出来 · <code>[✗]</code> 确实有问题。
      </p>
      <div class="btn-row">
        <button class="utils-btn utils-primary" :disabled="diagnoseBusy" @click="diagnoseRefresh()">{{ diagnoseBusy ? '诊断中…' : '重新诊断' }}</button>
        <button class="secondary utils-btn utils-secondary" :disabled="diagnoseBusy" @click="diagnoseRefresh(true)">强制重跑</button>
        <!-- 判据是「有结果**且没有整轮失败**」：只判 diagnose 存在的话，整轮失败时也有值
             （results 为空、env 为 null），点了会复制出一份「0 项通过 · 0 项异常」的空报告 ——
             比不给按钮更误导。转储卡那边判的是 !r.ok，这里对齐 -->
        <button v-if="diagnose && !diagnose.error" class="secondary utils-btn utils-secondary" :disabled="diagnoseBusy" @click="diagnoseCopy">复制诊断信息</button>
      </div>
      <p v-if="diagnoseFlash.msg" class="msg" :class="msgCls(diagnoseFlash)">{{ diagnoseFlash.msg }}</p>

      <!-- 整轮失败（环境信息都没读出来，env 为 null）：必须单独收尾。
           否则下面两道分支（未安装 / 已安装）都不命中 —— 前者要 env 为真且 installed 假，
           后者要 installed 真 —— 页面只剩一行 flash 红字与一张空卡，是最需要指引的时候反而没指引 -->
      <template v-if="diagnose && !diagnose.env">
        <p class="hint">
          这一轮没能读到 dsh 的环境信息（<code>profile</code> 或 <code>node_modules</code> 读取失败、宿主进程异常等），
          所以五项检查都没跑。<strong>上面的红字是具体原因</strong>；修掉后点「强制重跑」再试一次。
        </p>
      </template>

      <!-- dsh 未安装：给明确文案，不报错、不列检查项（D11） -->
      <template v-else-if="diagnose && !diagnose.env?.installed">
        <p class="hint">未检测到已安装的 dsh，无需诊断。先在「dsh」卡片里启动一次（会自动下载安装），再回来点「重新诊断」。</p>
      </template>

      <!-- 用 v-else-if 而非 v-if：三道分支各自收尾，否则会多出一个无主的 </template> -->
      <template v-else-if="diagnose && diagnose.env?.installed">
        <div v-for="item in diagnose.results" :key="item.id" class="diag-item">
          <p class="diag-head">
            <span class="diag-mark" :class="diagnoseMarkCls(item)">{{ diagnoseMark(item) }}</span>
            <strong>{{ item.title }}</strong>
            <span v-if="item.summary" class="diag-sum">{{ item.summary }}</span>
          </p>
          <!-- 明细截断到 5 行（D12）：超出部分由「复制诊断信息」兜底给出全量 -->
          <div v-if="item.findings.length" class="diag-detail">
            <p v-for="(f, i) in diagnoseShown(item)" :key="i" class="diag-line" :class="diagnoseLevelCls(f)">
              <span class="diag-line-text">{{ f.text }}</span>
              <span v-if="f.hint" class="diag-hint">→ {{ f.hint }}</span>
            </p>
            <p v-if="diagnoseRestCount(item)" class="diag-more">还有 {{ diagnoseRestCount(item) }} 项，点上方「复制诊断信息」看完整明细</p>
          </div>
        </div>

        <label class="field row">
          <span class="label">环境</span>
          <span class="ver">{{ diagnoseEnvText() }}</span>
        </label>

        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="diagnoseFolds.help = !diagnoseFolds.help">{{ diagnoseFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="diagnoseFolds.help" class="guide">
            <!-- 与「配置转储」「插件开关」两张卡分工：这张只回答「哪里坏了」，
                 转储卡回答「这个条目是谁改的」，插件开关卡负责动手改。
                 判据与改进办法在各自卡里只讲一遍，这里只留指引，避免三处说法随时间漂移。 -->
            <p class="guide-use"><strong>本卡只诊断，不动手：</strong>这里回答「哪里坏了」，不会改任何文件。要看清某个条目是被谁改的用「dsh 配置转储」，要真的禁掉某个插件用「dsh 插件开关」。</p>
            <p class="guide-use"><strong>重复模块：</strong>profile 的 <code>node_modules</code> 里装出了一份与全局 dsh 树<strong>同版本</strong>的 <code>@deepseek-ai/*</code>（比对包名 + 版本号判定，不看路径），会让 cordis 认成两份不同的包，报 <code>prompt section "deployment:persona" is already registered</code>，所有 preset 挂载失败。每次升级全局 dsh 都可能复现。</p>
            <p class="guide-use"><strong>patch 条目：</strong><code>cordis.patch.yml</code> 里 <code>- id: X</code> 指向的条目必须真的存在于组装树中，否则 dsh 报 <code>patch: entry "X" not found</code>。报这个错<strong>不一定是拼错</strong>：这个 id 是组装树的注册 id，常见真因是该 id 由某个 bundle 内部 insert 出来、而那个 bundle 现在没装（或条目已改名 / 被上游移除）。先到「dsh 配置转储」的用户层列表对照，确认它是否还在，再决定改 id 还是删掉这条 patch —— 这一项的判据由 dsh 自己打印的 not-found 行给出，所以要先在转储卡里读一次，否则显示 <code>[!]</code>「无法判定」，不猜。</p>
            <p class="guide-use"><strong>dsh 端口：</strong>被非 dsh 进程占用时 dsh 起不来；已有 dsh 在跑则不必再启。这一项要读进程名，个别系统上可能查不出归属 —— 那种情况显示 <code>[!]</code> 并附原因，属于「没查出来」，不是「查出来有问题」。</p>
            <p class="guide-use"><strong>只读与缓存：</strong>本诊断不修任何东西，也不写 dsh 的任何文件。结果缓存 60 秒：「重新诊断」在缓存有效时直接复用（省掉一次遍历 <code>node_modules</code>），需要抹掉缓存重跑就点「强制重跑」。</p>
          </div>
        </div>
      </template>
      </template>
    </section>
    <!-- [dsh] dsh 配置转储：一次 CLI 读取，摊开 patch 分层与生效/默认树差异，纯只读、不改配置、不联网 -->
    <section v-if="activeTab === 'dev'" class="card dsh-card">
      <div class="card-head">
        <h2 class="card-toggle" @click="toggleDevCard('dshDump')">
          <span class="caret">{{ devFolds.dshDump ? '▾' : '▸' }}</span>dsh 配置转储
          <span v-if="!devFolds.dshDump" class="card-sum">
            <template v-if="devStatsLoaded.dshDump">{{ dshDumpSummary }}</template>
            <template v-else>点击展开读取</template>
          </span>
        </h2>
      </div>
      <template v-if="devFolds.dshDump">
      <p class="hint">
        读出 dsh 实际组装用的配置树，摊成<strong>分层</strong>（哪一层、改了几条）与<strong>生效树 vs 默认树差异</strong>，
        用来回答「这个条目到底是谁改的、默认长什么样」。一次 CLI 读取（<code>--dump-config</code> / <code>--dump-default-config</code>），
        <strong>纯只读、不改动任何配置、不发任何网络请求</strong>。
      </p>
      <div class="btn-row">
        <button class="utils-btn utils-primary" :disabled="dshDumpBusy" @click="dshDumpRefresh()">{{ dshDumpBusy ? '读取中…' : '重新读取' }}</button>
        <button class="secondary utils-btn utils-secondary" :disabled="dshDumpBusy" @click="dshDumpRefresh(true)">强制重跑</button>
        <button v-if="dshDump && dshDump.ok" class="secondary utils-btn utils-secondary" :disabled="dshDumpBusy" @click="dshDumpCopy">复制转储信息</button>
      </div>
      <p v-if="dshDumpFlash.msg" class="msg" :class="msgCls(dshDumpFlash)">{{ dshDumpFlash.msg }}</p>

      <!-- dsh 未安装 / 读取失败：只给文案，不摊空列表。
           两种情况分开说 —— 没装要去「dsh」卡片装一次，失败才是重试 -->
      <template v-if="dshDump && !dshDump.ok && dshDump.notInstalled">
        <p class="hint">{{ dshDump.error || '未检测到可用的 dsh，先在「dsh」卡片里启动一次再回来读取。' }}</p>
      </template>

      <template v-else-if="dshDump && !dshDump.ok">
        <p class="hint">{{ dshDump.error || '读取失败，请稍后重试。' }}</p>
      </template>

      <template v-else-if="dshDump && dshDump.ok">
        <label class="field row">
          <span class="label">概览</span>
          <span class="ver">profile {{ dshDump.profile || DSH_DUMP_PROFILE }} · {{ dshDump.entries?.length || 0 }} 条目 · {{ dshDump.sections || 0 }} 分节{{ dshDump.unparsed ? ` · ${dshDump.unparsed} 行未识别` : '' }}</span>
        </label>

        <!-- D1：patch 分层。层数等于 dump 里的来源数，不固定为五，避免硬套模型失真 -->
        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="dshDumpFolds.layers = !dshDumpFolds.layers">{{ dshDumpFolds.layers ? '收起分层' : '展开分层' }}（{{ dshDump.layers?.length || 0 }} 层）</button>
          <div v-if="dshDumpFolds.layers" class="layer-list">
            <div v-for="l in dshDump.layers" :key="l.order" class="layer-item" :class="dshDumpLayerCls(l)">
              <p class="layer-head">
                <span class="layer-kind">{{ dshDumpLayerKindText(l) }}</span>
                <strong class="layer-name" :title="l.source || l.name">{{ l.name }}</strong>
                <span class="layer-count">{{ l.itemCount }} 条目 / {{ l.sectionCount }} 分节{{ l.repeat ? ' · 分节有重复列举' : '' }}</span>
              </p>
              <!-- 层里到底有哪些条目：ID 本身就短，直接列出来比只给个数字有用得多 -->
              <p class="layer-items" :title="l.items.join('\n')">
                <span v-for="id in l.preview" :key="id" class="layer-id">{{ id }}</span>
                <span v-if="l.items.length > l.preview.length" class="layer-more">…还有 {{ l.items.length - l.preview.length }} 个</span>
              </p>
            </div>
          </div>
        </div>

        <!-- D2：生效树 vs 默认树差异。默认树读失败时降级为只展示分层，不整卡失败 -->
        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="dshDumpFolds.diff = !dshDumpFolds.diff">{{ dshDumpFolds.diff ? '收起差异' : '展开差异' }}</button>
          <div v-if="dshDumpFolds.diff">
            <p v-if="dshDump.diffError" class="hint">默认树读取失败，未能比对：{{ dshDump.diffError }}</p>
            <p v-else-if="dshDump.diff && !dshDump.diff.changedTotal && !dshDump.diff.addedTotal && !dshDump.diff.removedTotal" class="hint">生效树与默认树完全一致，没有额外改动。</p>
            <template v-else-if="dshDump.diff">
              <p class="hint">改动 {{ dshDump.diff.changedTotal }} · 新增 {{ dshDump.diff.addedTotal }} · 移除 {{ dshDump.diff.removedTotal }}<template v-if="dshDump.diff.changed.length > 5">（下面列出前 5 条）</template></p>
              <p v-for="(e, i) in dshDump.diff.changed.slice(0, 5)" :key="'c' + i" class="diag-line diag-warn">
                <span class="diag-line-text">[{{ dshDumpDiffText('changed') }}] {{ dshDumpEntryLabel(e) }}</span>
                <span class="diag-hint">→ {{ dshDumpChangedNote(e) }}</span>
              </p>
              <template v-if="!dshDump.diff.changedTotal">
                <p class="hint">生效树里没有条目被用户层改过。</p>
              </template>
              <p v-for="(e, i) in dshDump.diff.added.slice(0, 5)" :key="'a' + i" class="diag-line diag-ok">
                <span class="diag-line-text">[{{ dshDumpDiffText('added') }}] {{ dshDumpEntryLabel(e) }}</span>
              </p>
              <p v-for="(e, i) in dshDump.diff.removed.slice(0, 5)" :key="'r' + i" class="diag-line diag-bad">
                <span class="diag-line-text">[{{ dshDumpDiffText('removed') }}] {{ dshDumpEntryLabel(e) }}</span>
              </p>
            </template>
          </div>
        </div>

        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="dshDumpFolds.help = !dshDumpFolds.help">{{ dshDumpFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="dshDumpFolds.help" class="guide">
            <!-- 与「环境诊断」卡的分工：这张解释「谁改的 / 默认长什么样」，
                 诊断卡负责判「坏了没」。读一次转储同时给诊断卡提供 patch 判据，
                 这点在两边都要说清，否则用户不知道「诊断说无法判定」时该去哪。 -->
            <p class="guide-use"><strong>本卡解释「为什么」，不诊断也不改配置：</strong>回答「这个条目是谁改的、默认长什么样」。判断配置有没有坏用「dsh 环境诊断」，要改某个插件的开关用「dsh 插件开关」。</p>
            <p class="guide-use"><strong>顺手给诊断卡提供判据：</strong>dsh 解析 patch 时会打印 <code>patch: entry "X" not found</code>。诊断卡的「patch 条目指向不存在的 id」一项就是读这里的缓存来判定的 —— 没读过转储时那一项显示「无法判定」，读过才给结论。所以先读转储再跑诊断，结果最准。</p>
            <p class="guide-use"><strong>分层怎么来的：</strong>dump 里每个分节头写着「这份配置来自哪个包」以及「被谁 patch 过」。包名来源算<strong>包内层</strong>（bundle 自带的 patch），<code>cordis.patch.yml</code> 的绝对路径算<strong>用户层</strong>（你自己写的 patch），没有任何来源的算<strong>基线</strong>。判用户层看的是「像不像绝对路径」，不写死某个目录 —— 改过 <code>$DSH_HOME</code> 也能认出来。</p>
            <p class="guide-use"><strong>差异是怎么比的：</strong>生效树（<code>--dump-config</code>）与默认树（<code>--dump-default-config</code>）按条目 id 对齐，比三样：包名、是否禁用、config 的<strong>字段名</strong>。patch 是把整条替换掉的，所以同 id 后出现的分节会盖住先出现的，这里也按同样规则合并。</p>
            <p class="guide-use"><strong>为什么看不到 config 的值：</strong>config 里可能带密钥，转储一律只留字段名不留值，界面上与「复制」里都是如此。</p>
            <p class="guide-use"><strong><code>!!js</code> 表达式：</strong>形如 <code>disabled: !!js '...'</code> 的条目要 cordis 上下文才能求值，静态解析做不到，一律按「已禁用」标注，不代表它真的被禁用。</p>
            <p class="guide-use"><strong>只读与缓存：</strong>整个读取只跑 <code>bin.js</code> 的 dump 子命令，不写 dsh 的任何文件；子进程 8 秒超时，结果缓存 60 秒：「重新读取」在缓存有效时直接复用（省掉两次 spawn），需要抹掉缓存重跑就点「强制重跑」。</p>
          </div>
        </div>
      </template>
      </template>
    </section>
    <!-- [dsh] 全量导出：把整个 $DSH_HOME 压成一个 zip 交给用户，用于「换台机器接着用 / 存档」。
         与下面「dsh 插件开关」里的**快照**卡是两件事：那张卡白名单备 3 个文件、为了回滚 patch，
         这张卡全量、为了搬运。所以不复用那张卡，也不共用回执。
         位置紧邻「诊断 / 转储」：这三张同属「只读、不改 dsh 任何状态」的取证族，
         而下面的开关 / 市场会写配置或装插件 —— 把只读族与写入族分开，翻页时更好找。 -->
    <section v-if="activeTab === 'dev'" class="card dsh-card">
      <div class="card-head">
        <h2 class="card-toggle" @click="toggleDevCard('dshExport')">
          <span class="caret">{{ devFolds.dshExport ? '▾' : '▸' }}</span>dsh 全量导出
          <!-- 收起态摘要：只在「本会话已展开读过」后才显示，否则不预读、直接提示点开 -->
          <span v-if="!devFolds.dshExport" class="card-sum">
            <template v-if="dshExportSummary">{{ dshExportSummary }}</template>
            <template v-else>点击展开查看</template>
          </span>
        </h2>
      </div>
      <template v-if="devFolds.dshExport">
        <p class="hint">
          把整个 <code>$DSH_HOME</code> 打包成一个 <code>.zip</code>（含 <code>profiles/</code> 下的
          patch、插件、会话记录），用于<strong>换台机器接着用</strong>或长期存档。
          包内会附一份 <code>whale-dsh-export.json</code> 清单，写明导出时间、来源目录与跳过了什么。
        </p>
        <p class="hint">
          与下面「dsh 插件开关」里的<strong>快照</strong>不是一回事：快照只备 3 个文件、由挂件管、
          用来把 patch 还原回去；这里是全量搬运，<strong>挂件不解析包内容、也不负责还原</strong>。
        </p>

        <p v-if="dshExportInfo && !dshExportInfo.ok" class="hint">
          {{ dshExportInfo.error || '读取失败，请稍后重试。' }}
        </p>

        <template v-else-if="dshExportInfo">
          <label class="field row">
            <span class="label">来源目录</span>
            <span class="ver" :title="dshExportInfo.dshHome">{{ dshExportInfo.dshHome }}</span>
          </label>
          <label class="field row">
            <span class="label">预计导出</span>
            <span class="ver">
              {{ dshExportInfo.entries || 0 }} 个文件 / {{ dshExportSize(dshExportInfo.bytes || 0) }}
              <template v-if="dshExportInfo.excluded">（另有 {{ dshExportInfo.excluded }} 项不进包）</template>
            </span>
          </label>

          <!-- dsh 运行中提示：会话文件是追加写的，边跑边导可能拿到半条记录。
               放在「预计导出」正下方 —— 用户看完条目数就会往下扫，这里是必读位置。
               三种状态分开说：在跑（黄）/ 端口被别的程序占（灰，性质不同）/ 判不出来（灰） -->
          <p v-if="dshExportInfo.running && dshExportInfo.running.running" class="hint hint-warn">
            ⚠️ 检测到 dsh <strong>正在运行</strong><template v-if="dshExportInfo.running.pid">（pid {{ dshExportInfo.running.pid }}）</template>。
            建议先退出 dsh 再导出：会话记录是<strong>边写边存</strong>的，运行中导出可能取到写了一半的记录，
            配置也可能正处在修改中间态。<strong>不退出也能导，但包不保证是某一时刻的完整快照。</strong>
          </p>
          <p v-else-if="dshExportInfo.running && dshExportInfo.running.other" class="hint">
            端口 {{ dshExportInfo.running.other }} 被其他程序占用（不是 dsh，不影响导出）。
          </p>
          <!-- running 为 null = 探测没拿到结果。不谎报「没在跑」，明说判不出来 -->
          <p v-else-if="dshExportInfo.running === null" class="hint">
            未能确认 dsh 是否在运行。若你正开着 dsh，建议先退出再导出。
          </p>

          <label class="field row">
            <span class="label">包含凭据</span>
            <input type="checkbox" :checked="cfg.dshExportCred" @change="dshExportSetCred(($event.target as HTMLInputElement).checked)" />
            <span class="hint">
              默认不带。<code>.credentials.yaml</code> 等在包里是<strong>明文</strong> ——
              要迁移登录态才勾，勾了别把包拷给别人或传网盘。
            </span>
          </label>
          <label class="field row">
            <span class="label">跳过依赖</span>
            <input type="checkbox" :checked="cfg.dshExportNoMod" @change="dshExportSetNoMod(($event.target as HTMLInputElement).checked)" />
            <span class="hint">
              默认跳过 <code>node_modules</code>（可重装、体积是配置的几十倍）。
              取消勾选会显著增大包体积与耗时。
            </span>
          </label>

          <!-- 未勾凭据但目录里确实有凭据文件时给出具体名字，
               泛泛说「会排除凭据」用户不知道指的是哪个文件 -->
          <p v-if="!cfg.dshExportCred && dshExportInfo.credFiles?.length" class="hint">
            将排除 {{ dshExportInfo.credFiles.length }} 个凭据文件：
            <code>{{ dshExportInfo.credFiles.slice(0, 3).join('、') }}</code>
            <template v-if="dshExportInfo.credFiles.length > 3">等</template>
          </p>

          <p v-if="dshExportInfo.truncated" class="hint">
            ⚠️ 文件数超过上限（{{ dshExportInfo.maxEntries }}），<strong>导出会被拒绝</strong>。
            请先清理 <code>$DSH_HOME</code> 下的会话记录再试。
          </p>

          <div class="btn-row">
            <button
              class="utils-btn utils-primary"
              :disabled="dshExportBusy || !dshExportInfo.entries || dshExportInfo.truncated"
              @click="dshExportCreate()"
            >{{ dshExportBusy ? '导出中…' : '导出为 zip…' }}</button>
            <button class="secondary utils-btn utils-secondary" :disabled="dshExportBusy" @click="dshExportRefresh()">重新统计</button>
          </div>

          <p v-if="dshExportFlash.msg" class="msg" :class="msgCls(dshExportFlash)">{{ dshExportFlash.msg }}</p>
          <!-- 导出成功才给「打开所在文件夹」：路径只在本次导出后有效，
               刷新/重进页面就该消失，避免指向一个早被移走的文件 -->
          <div v-if="dshExportLastPath" class="fold">
            <button class="link-btn utils-btn utils-secondary" :title="dshExportLastPath" @click="dshExportReveal()">
              打开所在文件夹
            </button>
          </div>
        </template>
      </template>
    </section>
    <!-- [dsh] dsh 本地用量统计：读 ~/.dsh 下 dsh-usage 的账本与会话投影缓存，纯本地、不联网 -->
    <section v-if="activeTab === 'dev'" class="card dsh-card">
      <div class="card-head">
        <h2 class="card-toggle" @click="toggleDevCard('dshUsage')">
          <span class="caret">{{ devFolds.dshUsage ? '▾' : '▸' }}</span>dsh 用量统计
          <!-- 收起态摘要：只在「本会话已展开读过」后才显示，否则不预读、直接提示点开 -->
          <span v-if="!devFolds.dshUsage" class="card-sum">
            <template v-if="devStatsLoaded.dshUsage && dshUsage && dshUsage.ok">今日 {{ fmtTokens(dshUsage.todayTokens) }} tokens · 本月 {{ fmtTokens(dshUsage.monthTokens) }}</template>
            <template v-else>点击展开查看</template>
          </span>
        </h2>
      </div>
      <template v-if="devFolds.dshUsage">
      <p class="hint">
        读 dsh 自己写在 <code>~/.dsh</code>（或 <code>$DSH_HOME</code>）下的用量数据做统计，
        <strong>纯本地读取、不需要 API Key、不发任何网络请求</strong>。优先用 dsh-usage 的按天账本，
        账本还没落盘时回落到会话投影缓存。
      </p>
      <div class="btn-row">
        <!-- 首次展开已自动读过一次，按钮主要当「刷新」用 -->
        <button class="utils-btn utils-primary" :disabled="dshUsageBusy" @click="dshUsageRefresh">{{ dshUsageBusy ? '读取中…' : (dshUsage ? '刷新' : '读取统计') }}</button>
        <button v-if="dshUsage" class="secondary utils-btn utils-secondary" :disabled="dshUsageBusy" @click="dshUsageClearCache">清除缓存并重扫</button>
      </div>
      <p v-if="dshUsageFlash.msg" class="msg" :class="msgCls(dshUsageFlash)">{{ dshUsageFlash.msg }}</p>

      <template v-if="dshUsage && dshUsage.ok">
        <label class="field row">
          <span class="label">数据目录</span>
          <span class="cmdline">{{ dshUsage.home }}</span>
        </label>
        <label class="field row">
          <span class="label">数据来源</span>
          <span class="ver">{{ dshUsageSourceText }}</span>
        </label>
        <label class="field row">
          <span class="label">会话</span>
          <span class="ver">{{ dshUsage.sessions }} 个（{{ dshUsage.activeSessions }} 个有用量）</span>
        </label>

        <!-- 今日 / 本月 / 累计 / 轮次 / 余额五个口径：原先各占一行、数值与单位挤在同一段文字里，
             扫读时要逐字读才知道哪个是哪个。改成等宽指标格：数字大一号、单位在下，
             列宽由 grid 均分，各格对齐成一条基线，一眼能横向比较。
             余额并进这里是因为它本来单独占一行 .field，而「dsh-usage 抓到的余额」这个标签
             拖到卡片被挤散（见 .stat-cell 注释），值和日期都受了影响。 -->
        <div class="stat-grid">
          <div class="stat-cell" title="今日消耗的 token 数（含输入 / 缓存命中 / 输出 / 推理）">
            <span class="stat-num">{{ fmtTokens(dshUsage.todayTokens) }}</span>
            <span class="stat-label">今日</span>
            <span class="stat-sub">{{ fmtDshCost(dshUsage.costToday) }}</span>
          </div>
          <div class="stat-cell" title="本月消耗的 token 数">
            <span class="stat-num">{{ fmtTokens(dshUsage.monthTokens) }}</span>
            <span class="stat-label">本月</span>
            <span class="stat-sub">{{ fmtDshCost(dshUsage.costMonth) }}</span>
          </div>
          <div class="stat-cell" title="有记录以来的累计 token 数">
            <span class="stat-num">{{ fmtTokens(dshUsage.totalTokens) }}</span>
            <span class="stat-label">累计</span>
            <span class="stat-sub">{{ fmtDshCost(dshUsage.costTotal) }}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-num">{{ dshUsage.turns || 0 }}</span>
            <span class="stat-label">{{ dshUsage.turnsLabel || '轮' }}</span>
            <span class="stat-sub">账本口径见说明</span>
          </div>
          <div v-if="dshUsage.balance" class="stat-cell" title="dsh-usage 自己抓的余额快照，与挂件轮询的余额互为印证">
            <span class="stat-num">{{ fmtDshBalanceAmount() }}</span>
            <span class="stat-label">dsh 抓到的余额</span>
            <span class="stat-sub">{{ fmtDshBalanceAt() || '快照' }}</span>
          </div>
        </div>

        <!-- 累计的 token 构成：四个分项本来塞在「累计」那一行的括号里，长度逼近两行且
             与总数混排。挪进独立一行的小格 —— 它们只在读细账时才看，不该挡住「今日 / 本月」。 -->
        <div class="stat-break">
          <span class="stat-chip"><em>输入</em>{{ fmtTokens(dshUsage.inTokens) }}</span>
          <span class="stat-chip"><em>缓存命中</em>{{ fmtTokens(dshUsage.cachedTokens) }}</span>
          <span class="stat-chip"><em>输出</em>{{ fmtTokens(dshUsage.outTokens) }}</span>
          <span class="stat-chip"><em>推理</em>{{ fmtTokens(dshUsage.reasonTokens) }}</span>
        </div>

        <p v-if="dshUsage.note" class="hint">{{ dshUsage.note }}</p>

        <!-- 图表 + 各模型用量由共用组件渲染：与 Codex 卡那两块逐字相同，
             抽出来避免改一处漏一处（详见 UsageChart.vue 顶部注释） -->
        <UsageChart
          v-model:range="dshUsageRange"
          :ranges="DSH_USAGE_RANGES"
          :days="dshUsageDays"
          :label-every="dshUsageLabelEvery"
          :bar-height="dshUsageBarHeight"
          :day-label="codexDayLabel"
          :models="dshUsageModels"
          :turns-label="dshUsage.turnsLabel || '轮'"
          :show-cost="true"
          :fmt-cost="fmtDshCost"
        />

        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="dshUsageFolds.help = !dshUsageFolds.help">{{ dshUsageFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="dshUsageFolds.help" class="guide">
            <p class="guide-use"><strong>数据来源：</strong>优先读 <code>dsh-usage/usage-ledger.json</code>（dsh-usage 插件的按天账本，能画趋势）；账本还没有数据时回落到 <code>storages/session_projcache/sessions/*.json</code>，按「会话创建日」把该会话的全部用量记在一天里。两者不会同时累加，避免同一批 token 被算两遍。</p>
            <p class="guide-use"><strong>花费：</strong>账本里的 <code>cost</code> 只有 DeepSeek 官方那档有值（单位人民币），其它 provider 未定价恒为 0，所以不会混币种。</p>
            <p class="guide-use"><strong>轮次：</strong>按天账本给的是 LLM 调用次数，会话缓存给的是对话轮次，两者的单位不同，已在上面标出。</p>
            <p class="guide-use"><strong>缓存：</strong>按会话缓存文件的 size/mtime 判断是否变化，只有变过的才重新解析。缓存里只有聚合数与文件指纹，<strong>不含任何凭据</strong>。</p>
            <p class="guide-use"><strong>读不到数据：</strong>dsh 的账本由 dsh-usage / cost-meter 这类插件写入，装好并跑过几轮对话后才有数；也可以点「清除缓存并重扫」强制重读。</p>
          </div>
        </div>
      </template>
      </template>
    </section>
    <!-- [dsh] 插件开关 / 批量隔离（E2 + E3 合并卡）
         合并理由：两卡改的是**同一个文件、同一个 profile、同一套快照**，差别只在粒度与候选范围。
         而候选范围不一致是会让人迷路的 —— E2 只列 patch 里已有的 12 条，用户想禁的第三方插件
         往往不在其中，在 E2 卡里根本找不到，得切到 E3 卡才行，而 E2 卡完全没提示这一点。 -->
    <section v-if="activeTab === 'dev'" class="card dsh-card">
      <div class="card-head">
        <h2 class="card-toggle" @click="toggleDevCard('dshIsolate')">
          <span class="caret">{{ devFolds.dshIsolate ? '▾' : '▸' }}</span>dsh 插件开关
          <span v-if="!devFolds.dshIsolate" class="card-sum">
            <template v-if="devStatsLoaded.dshIsolate">{{ dshIsolateSummary }}</template>
            <template v-else>点击展开读取</template>
          </span>
        </h2>
      </div>
      <template v-if="devFolds.dshIsolate">
        <p class="hint">
          改的是用户层 patch（<code>cordis.patch.yml</code>）。<strong>两种改法</strong>：
          行尾按钮<strong>一条一条</strong>即时改；或者勾选若干条后点「预览改动」→「确认隔离」<strong>一次改一批</strong>。
          <strong>没勾的条目一个字节都不会碰</strong> —— 批量那侧的「隔离」不是「把所有插件全禁」。
        </p>
        <p class="hint">
          ⚠️ 候选 = <strong>用户层 patch 里已有的条目</strong> ∪ <strong>组装树里读到的插件</strong>。
          后者写进去等于<strong>新加</strong>一条 patch，而实测带前端界面的插件这样就禁不掉
          （加载入口在 <code>package.json</code> 的 <code>dependencies</code> 里）；
          纯服务端插件（cost-meter / modlens / mnemon 这类）才可靠生效。
          <br>⚠️ <strong>任何写入前都强制建快照</strong>，快照建不出来就中止写入，不会出现改完没法回滚的情况。
          <br>⚠️ <strong>启用需重启</strong>：dsh 的 patch 热重载是<strong>单向</strong>的 —— 加 <code>disabled</code> 即时生效，
          但<strong>删掉不恢复</strong>，所以「启用」后要重启 dsh 才看得到。
        </p>
        <div class="btn-row">
          <button class="utils-btn utils-primary" :disabled="dshIsolateBusy" @click="dshIsolateRefresh()">{{ dshIsolateBusy ? '读取中…' : '刷新清单' }}</button>
          <button class="secondary utils-btn utils-secondary" @click="dshBackupCreate()">立即备份</button>
          <button class="secondary utils-btn utils-secondary" :disabled="dshIsolateBusy" @click="dshIsolatePreview()">预览改动</button>
        </div>
        <!-- ⚠️ 「说明」不能放进上面那个 .btn-row：.btn-row 的 `flex: 1` 会展开成 `flex-basis: 0`，
             而 .link-btn 的 `padding: 0` 让「文字撑出宽度」这条退路也没了 —— 两者相加宽度恒为 0，
             按钮看得见却点不到（点击落到邻座的「预览改动」上）。
             所以独立成 .fold 一行；位置放在整卡最后 —— 本 Tab 多数卡（主控 / 转储 / 用量 / 开关 / 市场 / Codex）
             都把「说明」收在末尾（导出卡没有说明、诊断卡的说明嵌在「已安装」分支内，是两处例外）。
             说明是补充信息，不该插在「候选 → 预览 → 确认」这条动作链中间。 -->
        <!-- 两个回执各自一条：逐条开关归 dshPatchFlash，批量隔离归 dshIsolateFlash，
             快照（还原/删除/命名/清理）归列表内的 dshBackupFlash（见下方快照折叠区）—— 三件事
             三行，否则点「禁用」会在同一条消息行里覆盖掉上一句「已隔离：改了 N 条」。 -->
        <p v-if="dshPatchFlash.msg" class="msg" :class="msgCls(dshPatchFlash)">{{ dshPatchFlash.msg }}</p>
        <p v-if="dshIsolateFlash.msg" class="msg" :class="msgCls(dshIsolateFlash)">{{ dshIsolateFlash.msg }}</p>

        <label v-if="dshIsolate?.ok" class="field row">
          <span class="label">写入位置</span>
          <span class="ver" :title="dshIsolate.file">{{ dshIsolate.file }}</span>
        </label>

        <template v-if="dshIsolate && !dshIsolate.ok">
          <p class="hint">{{ dshIsolate.error || '读取候选失败，请稍后重试。' }}</p>
        </template>

        <template v-else-if="dshIsolate">
          <p v-if="!dshIsolate.items?.length" class="hint">
            没有可隔离的候选 —— patch 文件里还没有条目，也没能从组装树里读到插件。
          </p>

          <template v-else>
            <div class="fold">
              <button class="link-btn utils-btn utils-secondary" @click="dshIsolateFolds.list = !dshIsolateFolds.list">
                {{ dshIsolateFolds.list ? '收起候选' : '展开候选' }}（已勾 {{ dshIsolatePicked.size }} / 共 {{ dshIsolate.items.length }} 条）
              </button>
              <!-- 用小胶囊样式而不是 .btn-row：上一行是 12px 的下划线链接，
                   放进 .btn-row 会被 `flex: 1` 撑成两个等宽大按钮，一行小链接配一行大按钮，
                   视觉重量差太多（同类小控件见下面的分组轴切换） -->
              <div class="iso-axis iso-pick-row">
                <button class="iso-axis-btn" @click="dshIsolateAll()">全选</button>
                <button class="iso-axis-btn" :title="'只勾当前确定启用中的条目（超过 ' + DSH_ISOLATE_MAX_BATCH + ' 条时会自动停在上限）'" @click="dshIsolateNoneDisabled()">只选启用中的</button>
              </div>
            </div>
            <!-- 一次写入有上限（MAX_BATCH）。超过就必须说清楚，否则用户以为「全选 = 全禁」，
                 而实际只写进去前 100 条 —— 这正是早先候选被截断时的静默失效形态。
                 现在宿主是「超限直接拒绝」而不是截断，所以这里说「会被拦下」而不是「会分批」 -->
            <p v-if="dshIsolatePicked.size > DSH_ISOLATE_MAX_BATCH" class="hint">
              ⚠️ 已勾 <strong>{{ dshIsolatePicked.size }}</strong> 条，超过单次写入上限
              <strong>{{ DSH_ISOLATE_MAX_BATCH }}</strong> 条，点「预览改动」会被拦下。
              先点「只选启用中的」缩小范围最快 —— 已禁用的条目本来就不需要再禁一次。
            </p>
            <div v-if="dshIsolateFolds.list" class="patch-list">
              <!-- 分组轴切换放在列表内部：它只对下面这堆候选有意义，列表没展开时露在外面就是个悬空控件。
                   也避开了 .btn-row 的 `flex: 1` —— 进去会被无差别撑成大按钮 -->
              <div class="iso-axis">
                <span class="iso-axis-label">分组</span>
                <button
                  class="iso-axis-btn"
                  :class="{ 'iso-axis-on': dshIsolateGroupBy === 'tier' }"
                  @click="dshIsolateSetGroupBy('tier')"
                >
                  按来源
                </button>
                <button
                  class="iso-axis-btn"
                  :class="{ 'iso-axis-on': dshIsolateGroupBy === 'state' }"
                  @click="dshIsolateSetGroupBy('state')"
                >
                  按启用状态
                </button>
                <button
                  class="iso-axis-btn"
                  :class="{ 'iso-axis-on': dshIsolateGroupBy === 'both' }"
                  @click="dshIsolateSetGroupBy('both')"
                >
                  按来源+状态
                </button>
              </div>
              <!-- 单轴（按来源 / 按状态）与双轴（按来源+状态）共用这一层渲染：
                   单轴时 dshIsolateSubLevels 回一个「无头层」直接把 g.items 交出去；
                   双轴时外层组 items 恒空、条数都在子组里，每个子组各成一个带头层。
                   两层共用同一段行模板（含徽章与行尾开关按钮）——
                   早先这两层各抄了一份一模一样的行模板，改一处漏一处，加个徽章得改两遍。 -->
              <template v-for="g in dshIsolateGroups" :key="g.key">
                <div class="iso-tier">
                  <button class="link-btn utils-btn utils-secondary" @click="dshIsolateToggleTier(g.key)">
                    {{ dshIsolateTierFolds[g.key] ? '▸' : '▾' }} {{ g.label
                    }}（{{ dshIsolateGroupCount(g) }} 条）
                  </button>
                  <span class="iso-tier-hint">{{ g.hint }}</span>
                </div>
                <template v-if="!dshIsolateTierFolds[g.key]">
                  <template v-for="lvl in dshIsolateSubLevels(g)" :key="lvl.key">
                    <!-- 双轴时的内层组头：用 iso-tier-sub 与主组头拉开层级。
                         单轴时 dshIsolateSubLevels 只回一个「无头层」（head 为 false），不渲染组头。 -->
                    <div v-if="lvl.head" class="iso-tier iso-tier-sub">
                      <button class="link-btn utils-btn utils-secondary" @click="dshIsolateToggleTier(lvl.key)">
                        {{ dshIsolateTierFolds[lvl.key] ? '▸' : '▾' }} {{ lvl.label }}（{{ lvl.items.length }} 条）
                      </button>
                      <span class="iso-tier-hint">{{ lvl.hint }}</span>
                    </div>
                    <template v-if="!lvl.head || !dshIsolateTierFolds[lvl.key]">
                      <label
                        v-for="it in lvl.items"
                        :key="it.id"
                        class="patch-item iso-item"
                        :class="{ 'patch-off': it.disabled === true }"
                      >
                        <input type="checkbox" :checked="dshIsolatePicked.has(it.id)" @change="dshIsolateTogglePick(it.id)">
                        <span class="patch-id" :title="it.source === 'patch' ? `patch 第 ${it.line} 行` : `不在 patch 里，隔离会新加一条${it.bundle ? '（来自 ' + it.bundle + '）' : ''}`">{{ it.id }}</span>
                        <span v-if="it.source === 'plugin'" class="patch-tag">新加</span>
                        <span v-if="it.hasConfig" class="patch-tag">带 config</span>
                        <span
                          class="patch-state"
                          :class="it.disabled === true ? 'state-off' : it.disabled === false ? 'state-on' : 'state-unknown'"
                        >{{ it.disabled === true ? '已禁用' : it.disabled === false ? '启用中' : '状态未知' }}</span>
                        <!-- 行尾即时开关：只有「已经在 patch 里」的条目才给。
                             不在 patch 里的（source=plugin）想禁只能靠批量那条路 —— 宿主 dshPatchToggle 要求该 id
                             已在 patch 中存在，单条切换做不到「新加」，硬给按钮必然报「patch 里没有这条」。
                             状态未知的也不给：连它现在开没开都不知道，就不该让一键把它翻过去。 -->
                        <button
                          v-if="it.source === 'patch' && it.disabled !== undefined"
                          class="secondary patch-btn utils-btn utils-secondary"
                          :disabled="!!dshPatchPending"
                          @click.prevent="dshPatchToggle({ id: it.id, disabled: it.disabled, hasConfig: it.hasConfig, line: it.line })"
                        >{{ dshPatchPending === it.id ? '写入中…' : (it.disabled ? '启用' : '禁用') }}</button>
                      </label>
                    </template>
                  </template>
                </template>
              </template>
            </div>
          </template>

          <!-- 待确认的改动计划：写之前把「会动哪几行」逐条摆出来，这是 §5.2 的硬要求 -->
          <template v-if="dshIsolatePlan">
            <p class="hint">
              将改动 <strong>{{ dshIsolatePlan.changedCount }}</strong> 条（行号按<strong>改动前</strong>的文件算）：
            </p>
            <div class="patch-list">
              <div v-for="p in dshIsolatePlan.plans" :key="p.id" class="patch-item" :class="{ 'patch-off': p.action === 'noop' }">
                <span class="patch-id">{{ p.id }}</span>
                <span class="patch-tag">{{ dshIsolateActionText(p.action) }}</span>
                <span class="patch-state">{{ p.line ? `第 ${p.line} 行` : '追加到末尾' }}</span>
              </div>
            </div>
            <div class="btn-row">
              <button class="danger utils-btn utils-danger" :disabled="dshIsolateBusy" @click="dshIsolateConfirm()">{{ dshIsolateBusy ? '写入中…' : '确认隔离（先建快照）' }}</button>
              <button class="secondary utils-btn utils-secondary" @click="dshIsolatePlan = null">取消</button>
            </div>
          </template>
        </template>

        <!-- 快照：写前自动建的那些 + 手动备份的，都在这里回滚。
             放在候选与「待确认计划」之后 —— 快照是**事后回滚**用的，不是写入流程的一环。
             早先它夹在说明与候选之间，把「预览改动 → 确认隔离」这条动作链硬生生截断，
             用户从预览滚到确认要跨过整块快照管理（份数/还原/命名/删除/清理）。 -->
        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="dshBackupToggleList()">
            {{ dshBackupFolds.list ? '收起快照' : '展开快照' }}（{{ dshBackups?.snapshots?.length || 0 }} 份，保留最近 {{ dshBackups?.max ?? 20 }} 份）
          </button>
          <div v-if="dshBackupFolds.list">
            <p v-if="dshBackups && !dshBackups.ok" class="hint">{{ dshBackups.error || '快照列表读取失败。' }}</p>
            <template v-else>
              <!-- 保留份数：已知良好与手动命名的快照不参与轮转，所以实际留的会比这个数多 -->
              <div class="bak-keep">
                <span class="label">保留份数</span>
                <input
                  class="bak-keep-input"
                  type="number"
                  :min="dshBackups?.keepMin ?? 1"
                  :max="dshBackups?.keepMax ?? 200"
                  :value="dshKeepDraft ?? (dshBackups?.max ?? 20)"
                  @input="dshKeepDraft = (($event.target as HTMLInputElement).value.trim() === '' ? null : Number(($event.target as HTMLInputElement).value))"
                />
                <button class="secondary patch-btn utils-btn utils-secondary" :disabled="dshKeepDraft === null || dshKeepBusy" @click="dshSaveKeep()">
                  {{ dshKeepBusy ? '保存中…' : '保存' }}
                </button>
                <button class="secondary patch-btn utils-btn utils-secondary" @click="dshPruneNow()">立即清理</button>
                <span class="hint bak-keep-note">「已知良好」与手动命名的备份不受这个数限制</span>
              </div>

              <p v-if="!dshBackups?.snapshots?.length" class="hint">还没有快照。</p>
              <template v-else>
                <p class="hint" :title="dshBackups.root">存放在 <code>whale-dsh-backup/</code>（与 dsh 配置同目录，可自行删除）</p>
                <!-- 快照卡自己的回执，**必须挨着列表**：还原 / 删除 / 命名的按钮都在列表里，
                     回执却挂在整卡顶部（上面那条 dshPatchFlash）—— 点完按钮视线落在列表底部，
                     颜色相近的 12px 小字在视野之外，等于没有回执（2026-09-24 用户报
                     「快照点击恢复不知道成没成功」）。两条都画：恢复的是「有没有成功」，
                     顶部那条是「patch 现在几条」。 -->
                <p v-if="dshBackupFlash.msg" class="msg bak-flash" :class="msgCls(dshBackupFlash)">{{ dshBackupFlash.msg }}</p>
                <div v-for="s in dshBackups.snapshots" :key="s.dirName" class="bak-item" :class="{ 'bak-known': s.knownGood }">
                  <div class="bak-line">
                    <span class="bak-time">{{ dshBackupTime(s) }}</span>
                    <span v-if="s.knownGood" class="bak-known-tag" title="不会被自动清理">已知良好</span>
                    <!-- 快照文件被外部删过/改过时标出来，并把「还原」置灰 —— 让用户在这里就看到
                         「这份还原不了」，而不是点下去等宿主报错（那次点击是白点的） -->
                    <span v-if="s.damaged" class="bak-damaged-tag" title="快照文件已缺失或被修改，无法还原">已损坏</span>
                    <span v-if="s.name" class="bak-name" :title="s.name">{{ s.name }}</span>
                    <span v-if="s.reason" class="bak-reason">{{ dshBackupReasonText(s.reason) }}</span>
                    <span class="bak-meta">{{ s.present }}/{{ s.total }} 个文件</span>
                  </div>
                  <!-- 系统记的「这是对谁做的什么操作」：市场那条链路里同名原因会堆成十几份，
                       光看原因（如「市场安装前」×12）分不出哪份是为了回滚哪个包，所以把
                       宿主拼好的 note（形如「安装 dshmarket@1.65.1」）独立一行说出来。
                       ⚠️ 为什么与上面那行分开而不是并排（2026-09-25 用户反馈「能不能更明确点」）：
                       并排时它只是时间戳后面一枚 11px 小徽章，与「已知良好」「3/3 个文件」
                       混在一条线上，读起来像又一个状态标签而不是一句话；换成独立一行 +
                       前置的「记录」标签，才能一眼看出这是「动作 + 包名 + 版本」的完整陈述。
                       ⚠️ 与上面的 name **同时显示而非互斥**：name 是用户起的名，
                       改过名的快照照样要看得出它当初是给哪个包建的。 -->
                  <p v-if="s.note" class="bak-note-row">
                    <span class="bak-note-tag">记录</span>
                    <span class="bak-note" :title="s.note">{{ s.note }}</span>
                  </p>
                  <div class="bak-actions">
                    <button
                      class="secondary patch-btn utils-btn utils-secondary"
                      :class="{ 'bak-confirm': dshRestoreConfirm === s.dirName }"
                      :disabled="s.damaged"
                      :title="s.damaged ? '快照文件已缺失或被修改，无法还原' : ''"
                      @click="dshBackupRestore(s.dirName)"
                    >{{ dshRestoreConfirm === s.dirName ? '确认还原' : '还原' }}</button>
                    <button class="secondary patch-btn utils-btn utils-secondary" @click="dshToggleKnownGood(s)">{{ s.knownGood ? '取消标记' : '标为已知良好' }}</button>
                    <button class="link-btn utils-btn utils-secondary" @click="dshRenameStart(s)">{{ s.name ? '改名' : '命名' }}</button>
                    <button class="link-btn bak-del utils-btn utils-secondary" :class="{ 'bak-confirm': dshDeleteConfirm === s.dirName }" @click="dshDeleteSnapshot(s.dirName)">
                      {{ dshDeleteConfirm === s.dirName ? '确认删除' : '删除' }}
                    </button>
                  </div>
                  <div v-if="dshRenameFor === s.dirName" class="bak-rename">
                    <input
                      class="bak-rename-input"
                      type="text"
                      maxlength="40"
                      placeholder="给这份快照起个名字（如「装插件前」）"
                      :value="dshRenameText"
                      @input="dshRenameText = ($event.target as HTMLInputElement).value"
                      @keyup.enter="dshRenameSave()"
                      @keyup.esc="dshRenameCancel()"
                    />
                    <button class="secondary patch-btn utils-btn utils-secondary" @click="dshRenameSave()">保存</button>
                    <button class="link-btn utils-btn utils-secondary" @click="dshRenameCancel()">取消</button>
                  </div>
                </div>
              </template>
            </template>
          </div>
        </div>

        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="dshIsolateFolds.help = !dshIsolateFolds.help">{{ dshIsolateFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="dshIsolateFolds.help" class="guide">
            <p class="guide-use"><strong>为什么清单里有 200 多条：</strong>候选是<strong>用户层 patch 里已有的条目</strong> ∪ <strong>组装树里读到的插件</strong>。前者是「你已经写过的」，后者写进去等于<strong>新加</strong>一条 patch —— 只列前者的话，你想禁的第三方插件往往根本不在清单里，会找不到入口。加起来实测常有 200 条以上，用上面的分组轴收窄。</p>
            <p class="guide-use"><strong>为什么候选要读组装树：</strong>实测写一个<strong>不存在的 id</strong>，dsh 只在 stderr 打一行 <code>patch: entry "X" not found</code>、退出码 0、启动照常 —— 也就是「写坏了不报错」。所以候选先拿一份真实存在的条目，让你<strong>勾不到拼错的 id</strong>。读不到组装树时降级为「只有 patch 里的条目」，不把整件事判死。</p>
            <p class="guide-use"><strong>禁用是怎么写的：</strong>沿用 dsh 自己的行级写法 —— 已有条目就只改它那一行的 <code>disabled</code>；没有该条目就在文件末尾追加 <code>- id: X</code> + <code>disabled: true</code>（patch 是后者覆盖前者，追加在末尾等于优先级最高）。整份文件<strong>不会重新序列化</strong>，你的注释、引号风格、键顺序都原样保留。</p>
            <p class="guide-use"><strong>单条改与批量改的区别：</strong>行尾按钮是立即写入一条；「预览改动」是 <strong>dryRun</strong>，只计算不写盘、把「会动哪几行」摆出来，你过目后再点「确认隔离」。批量改多条与单条不同 —— 往中间插行会让后面的行号整体顺延，所以实现里是<strong>从后往前</strong>改、并且<strong>一次写盘</strong>，不会半截写入。</p>
            <p class="guide-use"><strong>「隔离」为什么不是「全禁」：</strong>原方案是往 profile 里补十几条 <code>disabled: true</code> 把用户整个 profile 干掉。这里改成只操作<strong>显式勾选</strong>的条目 —— 界面上点不出「我没选的东西」，改动范围永远能追溯到一份真实读到的清单。</p>
            <p class="guide-use"><strong>一次最多写 100 条：</strong>超过会被拦下并提示先缩小范围（点「只选启用中的」最快 —— 已禁用的条目本来就不需要再禁一次）。<strong>是拒绝，不是分批</strong>，所以不会出现「以为全禁了、其实只写进去前 100 条」的静默失效。</p>
            <p class="guide-use"><strong>三个分组轴怎么选：</strong>「按来源」回答「这条是谁的」（已在你 patch 里 / 第三方插件 / dsh 官方框架），「按启用状态」回答「这条现在开没开」，「按来源+状态」把两者叠起来看（外层来源、内层状态）。三个问题不重叠，所以做成可切换而不是合并成一个。官方框架默认折叠 —— 200 多条里绝大多数是 dsh 自己的组装树节点，铺开会把真正要操作的插件淹掉。</p>
            <p class="guide-use"><strong>「状态未知」是什么：</strong>宿主没读到该条目的 dump 状态（组装树读取降级）时会显示成<strong>黄色虚线</strong>「状态未知」，而不是蓝色「启用中」 —— 拿「启用中」的颜色去画一个未知状态，等于替它背书。「只选启用中的」也只勾<strong>确定</strong>启用中的条目，未知的不替你决定。</p>
            <p class="guide-use"><strong>已是禁用的条目：</strong>勾了也不会重复写，计划里会标成「已是禁用（不动）」，界面上说「改了 N 条」而不是「N 条已隔离」，免得把没动过的算进战果。</p>
            <p class="guide-use"><strong>为什么每次都要备份：</strong>实测 dsh 对写坏的 patch <strong>不报错</strong>（见上），所以这里写完会<strong>回读磁盘校验</strong>，并且改动前一定先建快照：宁可不让改，也不能让改动不可撤销。</p>
            <p class="guide-use"><strong>还原是整文件覆盖：</strong>因为热重载单向（删行不恢复），只有让文件真正回到改动前的完整内容才有效。代价是<strong>会一并回退这份文件上的其他改动</strong> —— 备份的价值就是拿到一个已知良好的状态。快照<strong>绝不包含</strong> <code>.credentials.yaml</code> 等凭据文件。</p>
          </div>
        </div>
      </template>
    </section>
    <!-- [dsh] dsh 插件市场：浏览/搜索/筛选官方目录并安装插件。
         ⚠️ 本 Tab 里**唯一会联网**的卡 —— 其余卡都在 hint 里写明「不发网络请求」，
         所以这张反过来必须显式声明会联网，且**默认一个请求都不发**：
         展开只读一次本地已装状态，要点「进入市场」+「加载目录」才出站（见 dshMarketRevealed）。
         联网警示在「进入市场」前后各留一份（文案不同）—— 出站点在后面，不能只在入口说一次。 -->
    <section v-if="activeTab === 'dev'" class="card dsh-card">
      <div class="card-head">
        <h2 class="card-toggle" @click="toggleDevCard('dshMarket')">
          <span class="caret">{{ devFolds.dshMarket ? '▾' : '▸' }}</span>dsh 插件市场
          <!-- 收起态摘要：与其余卡同构 —— 只在「本会话已展开读过」后才显示，否则不预读、直接提示点开 -->
          <span v-if="!devFolds.dshMarket" class="card-sum">{{ dshMarketSummary }}</span>
        </h2>
      </div>
      <template v-if="devFolds.dshMarket">
      <!-- 入口态：按钮 + 一句介绍 + 联网警示。
           ⚠️ 「进入市场」一旦点过，这三样里的**按钮与介绍**就该退场 —— 用户已经在市场里了，
              再摆一个「进入市场」是死按钮，介绍也成了废话。但**联网警示必须留下**：
              展开后紧接着就是「加载目录 / 强制重抓」这些真正出站的按钮，警示的落点正是那里，
              跟着按钮一起消失等于在最该提醒的位置把话收走。
              所以这里按 dshMarketRevealed 分成两态，而不是整块 v-if 掉。 -->
      <template v-if="!dshMarketRevealed">
        <p class="hint">
          浏览 dsh 插件目录（4000+ 条），搜到后<strong>直接装进 profile</strong>。
        </p>
        <p class="hint">
          ⚠️ <strong>本卡会联网</strong>（其余卡片只读本地文件）。默认不发请求：展开只读一次已装状态，
          点「进入市场」才出站。
        </p>
        <div class="btn-row">
          <button class="utils-btn utils-primary" @click="dshMarketRevealed = true">进入市场</button>
        </div>
      </template>
      <p v-else class="hint">
        ⚠️ <strong>本卡会联网</strong>（其余卡片只读本地文件）—— 点下面的「加载目录」才出站，
        在此之前只读本地已装状态。
      </p>

      <!-- 已装包清单：「卸载」的兜底入口。
           ⚠️ 为什么放在 **dshMarketRevealed 之前**（即「进入市场」之前）：这份清单是**纯本地**的
              （读 profile/package.json + patch），与联网、与目录加载全都无关。
              放在「进入市场」之后等于要求用户先点一次「进入市场」才看得到卸载入口 ——
              而多数人根本不进市场，盲区照旧。位置也就在「加载目录」那句提示之前。
           ⚠️ 为什么必须独立于目录列表：目录列表只渲染 catalog 里的条目，而「已装」是 profile 的
              事实 —— 已装但不在目录里、或 install 字段认不出的包，在目录列表里永远找不到行。
              这里直接列 installed 表，把两类盲区一次补齐。 -->
      <div v-if="dshMarketStatus" class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="dshMarketInstalledFold = !dshMarketInstalledFold">
          {{ dshMarketInstalledFold ? '▸' : '▾' }} 已装包（{{ dshMarketInstalledSummary }}）
        </button>
        <div v-if="!dshMarketInstalledFold && dshMarketInstalledList.length" class="patch-list">
          <p class="hint">
            这些是从 <code>profile/package.json</code> 与 patch 里直读的<strong>真实已装状态</strong>，
            与目录是否加载无关。<strong>「禁用」只写 patch（包留在磁盘）</strong>；
            <strong>「彻底删除」</strong>才会真的 <code>pnpm remove</code> 掉这个包。
            两者都<strong>先出计划再确认</strong>，写入前自动建快照。
          </p>
          <div v-for="row in dshMarketInstalledList" :key="row.key" class="patch-item" :class="{ 'patch-off': row.hit?.disabled === true }">
            <span class="patch-id" :title="row.key">{{ row.key }}</span>
            <span v-if="row.hit?.inDeps" class="patch-tag" :title="'声明范围：' + (row.hit?.depVersion || '（读不到）')">
              依赖{{ row.hit?.depVersion ? ' ' + row.hit.depVersion : '' }}
            </span>
            <span v-if="row.hit?.inPatch" class="patch-state" :class="row.hit?.disabled ? 'state-off' : 'state-on'">
              {{ row.hit?.disabled ? '已禁用' : '启用中' }}
            </span>
            <span v-else class="patch-tag" title="patch 文件里没有这一条，只能删包、不能只禁用">无 patch 条目</span>
            <!-- 目录里找不到这条包时把「为什么没有更新按钮」说出来（见 dshMarketInstalledNoteMap）。
                 查表而非调用函数：逐行现算是 O(目录 × 已装) 量级，展开即卡死 -->
            <span v-if="dshMarketInstalledNoteMap[row.key]" class="patch-note">{{ dshMarketInstalledNoteMap[row.key] }}</span>
            <!-- 禁用：只在 patch 里已有该条目时才给。宿主 dshPatchToggle 要求 id 已存在，
                 做不到「新加」；强行给必然报「patch 里没有这条」（与插件开关卡同一约束）。
                 包不在 patch 里时想禁，得先让它在 patch 里出现 —— 那属于「插件开关」卡的活。 -->
            <!-- 停用 / 启用：蓝色次操作，与目录条目、以及其它卡片同名同色 -->
            <button
              v-if="row.hit?.inPatch"
              class="secondary patch-btn utils-btn utils-secondary"
              :disabled="dshMarketBusy || row.hit?.disabled"
              @click="dshMarketPreviewUninstall({ spec: '', npm: row.key, name: row.key } as DshMarketPlugin, false)"
            >{{ row.hit?.disabled ? '启用（留包）' : '停用（留包）' }}</button>
            <!-- 彻底删除：只在包真的在 dependencies 里才给（与目录条目同判据）——
                 包不在依赖里时 pnpm remove 没东西可删，白跑一趟。
                 用 utils-danger 危险档，与目录条目的「卸载」同一个色 -->
            <button
              v-if="row.hit?.inDeps"
              class="patch-btn utils-btn utils-danger"
              :disabled="dshMarketBusy"
              title="从 profile 里彻底删掉这个包（pnpm remove），只删这一个包名，不做依赖反查"
              @click="dshMarketPreviewUninstall({ spec: '', npm: row.key, name: row.key } as DshMarketPlugin, true)"
            >彻底删除</button>
          </div>
        </div>
        <p v-else-if="!dshMarketInstalledFold" class="hint">还没有读到已装包 —— 点上面的「刷新已装状态」重读一次。</p>
      </div>

      <template v-if="dshMarketRevealed">
      <!-- 来源设置整块收进折叠：默认只留「加载目录」按钮，想调源才展开。
           两段来源说明（竞速机制 + 设置不触发抓取）合并成一段放进折叠里 ——
           说明与设置放一起，展开就看到全部上下文，不用回到上面找。 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="dshMarketFolds.source = !dshMarketFolds.source">
          {{ dshMarketFolds.source ? '收起来源设置' : '来源设置' }}（{{ dshMarketSourceShort }}）
        </button>
        <div v-if="dshMarketFolds.source" class="guide">
          <p class="hint">
            ⚡ <strong>多源并发竞速，先到先用</strong>，其余立刻取消。官方源 4.37MB 实测 52–99 秒（还常连不上），
            npm 镜像只有 1.09MB、0.2–0.7 秒，<strong>内容同源</strong>，所以官方源默认关闭；勾上它不影响快源，只是多占一条连接。
            下方单选只改偏好、<strong>不触发抓取</strong>，抓取由「加载目录」发起；先「测速」再「用最快的」可挑出当前网络最快的一条。
          </p>
          <div class="mkt-src">
            <label class="mkt-src-row">
              <input type="radio" :value="''" v-model="cfg.dshMarketRegistry">
              <span>默认（宿主内置，当前为延迟最低的一条）</span>
            </label>
            <label v-for="r in DSH_MARKET_REGISTRIES" :key="r.id" class="mkt-src-row">
              <input type="radio" :value="r.url" v-model="cfg.dshMarketRegistry">
              <span>{{ r.label }}</span>
              <span v-if="dshMarketPingOf(r.url)" class="mkt-src-ms" :class="{ 'mkt-src-bad': !dshMarketPingOf(r.url)?.ok }">
                {{ dshMarketPingOf(r.url)?.ok ? (dshMarketPingOf(r.url)?.ms + ' ms') : '测不通' }}
              </span>
            </label>
            <label class="mkt-src-row">
              <input type="checkbox" v-model="cfg.dshMarketOfficial">
              <span>同时让官方源参赛（慢，但来源最权威）</span>
            </label>
            <div class="btn-row mkt-src-btns">
              <button class="utils-btn utils-secondary" :disabled="dshMarketPingBusy" @click="dshMarketPingRun()">{{ dshMarketPingBusy ? '测速中…' : '测速' }}</button>
              <button class="utils-btn utils-secondary" :disabled="dshMarketPingBusy || !dshMarketPing.some(x => x.ok)" @click="dshMarketUseFastest()">用最快的</button>
            </div>
          </div>
        </div>
      </div>
      <!-- 安装机制收进折叠：展开卡片时默认只留按钮行。
           这段是「为什么可以信它」的解释，不是操作步骤，常驻两行会压住下面的列表；
           但它关系到用户敢不敢点安装，所以不能删，做成一行提示 + 可展开。 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="dshMarketFolds.install = !dshMarketFolds.install">
          {{ dshMarketFolds.install ? '收起安装说明' : '安装说明' }}（快照 + 回读校验；装完需重启 dsh）
        </button>
        <div v-if="dshMarketFolds.install" class="guide">
          <p class="hint">
            ⚠️ 安装走 <code>pnpm add --dir &lt;profiles/{{ dshPatchProfile }}&gt;</code> 写进 profile 的
            <code>package.json</code>。<strong>写入前强制建快照，装完回读校验</strong>（dsh 对写坏的配置不报错，不能只信 pnpm 退出码）。
          </p>
          <p class="hint">
            ⚠️ 装完/禁用后 <strong>dsh 需重新加载才生效</strong>；不会自动重启（会掐掉你正在跑的会话），
            由你点「重启 dsh」。
          </p>
        </div>
      </div>
      <div class="btn-row">
        <button class="utils-btn utils-primary" :disabled="dshMarketBusy" @click="dshMarketLoad(false)">{{ dshMarketBusy ? '加载中…' : (dshMarket ? '刷新目录' : '加载目录') }}</button>
        <button class="secondary utils-btn utils-secondary" :disabled="dshMarketBusy" @click="dshMarketLoad(true)">强制重抓</button>
        <button class="secondary utils-btn utils-secondary" :disabled="dshMarketStatusBusy" @click="dshMarketRefreshStatus()">刷新已装状态</button>
        <button class="secondary utils-btn utils-secondary" @click="dshRestartNow()">重启 dsh</button>
      </div>
      <p v-if="dshMarketFlash.msg" class="msg" :class="msgCls(dshMarketFlash)">{{ dshMarketFlash.msg }}</p>

      <!-- pnpm 构建拦截的引导（只在本卡出现过一次 allowBuilds 失败后显示）。
           ⚠️ 为什么不能自动帮用户写：那把 key 带 commit hash，只有在 dsh 报错时才出现；
              而且它是 pnpm 的**安全机制**（阻止来源不明的包在安装时跑构建脚本），
              替用户静默放行等于把这个机制废掉。所以这里只把原文和位置摆清楚，写由用户决定。 -->
      <template v-if="dshMarketAllowBuilds">
        <p class="hint">
          ⚠️ <strong>pnpm 拦下了构建脚本</strong>：<code>{{ dshMarketAllowBuilds.name || dshMarketAllowBuilds.spec }}</code>
          靠 <code>prepare</code> 在安装时构建，pnpm 默认不放行。这不是失败，是安全机制 —— 显式允许后再装一次。
        </p>
        <p class="hint">
          把这行加进 <code>{{ dshMarketAllowBuilds.file }}</code> 的 <code>allowBuilds:</code> 下（缩进与已有条目一致），保存后重装：
        </p>
        <p class="hint"><code>{{ dshMarketAllowBuilds.key }}: true</code></p>
        <p class="hint">
          ⚠️ 放行后该包安装时<strong>可执行任意脚本</strong>，先确认来源可信。key 带 commit hash，<strong>装前无法预知</strong>，
          所以这类插件注定先失败一次。
        </p>
        <div class="btn-row">
          <button class="secondary utils-btn utils-secondary" @click="dshMarketAllowBuilds = null">知道了</button>
        </div>
      </template>

      <label v-if="dshMarket && dshMarket.ok" class="field row">
        <span class="label">数据来源</span>
        <span class="ver">{{ dshMarketSourceText }}</span>
      </label>
      <label v-if="dshMarketStatus" class="field row">
        <span class="label">写入位置</span>
        <span class="ver" :title="dshMarketStatus.file">{{ dshMarketStatus.file }}</span>
      </label>

      <!-- 还没加载：给一句话，不摊空列表（空列表会被误读成「目录里没有插件」） -->
      <p v-if="!dshMarketLoaded" class="hint">点「加载目录」抓取插件清单（默认走 npm 镜像，约 1MB；首次约 1 秒，之后 60 秒内复用缓存）。</p>

      <template v-else-if="dshMarket && !dshMarket.ok">
        <p class="hint">{{ dshMarket.error || '目录加载失败，请稍后重试。' }}</p>
      </template>

      <template v-else-if="dshMarket && dshMarket.ok">
        <!-- 离线降级：内容不是刚抓的，必须挡在最前面 —— 用户会照 stars/downloads 做判断 -->
        <p v-if="dshMarket.stale" class="hint">
          ⚠️ 在线来源都取不到（{{ dshMarket.staleReason || '未知原因' }}），显示的是<strong>上次抓到的目录副本</strong>，可能已过期。
        </p>

        <!-- 筛选器收进折叠：浏览的主体是列表，三个筛选控件常驻会把列表挤下去 -->
        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="dshMarketFolds.filters = !dshMarketFolds.filters">
            {{ dshMarketFolds.filters ? '收起筛选' : '筛选与排序' }}
          </button>
          <div v-if="dshMarketFolds.filters" class="guide">
            <label class="field row">
              <span class="label">关键词</span>
              <input v-model="dshMarketKeyword" type="text" maxlength="60" placeholder="空格分词，如「翻译 离线」；-词 排除，如「翻译 -离线」" />
            </label>
            <!-- 分类：从 <select> 改成 chip 行。24 类的下拉框要展开才能看见有什么可选，
                 而且看不出各类有多少条；chip 平铺后一眼扫完，带计数还能避开空分类。
                 ⚠️ 平铺 24 个会占三行（.iso-axis 是 flex-wrap），把下面的「范围 / 排序」
                 挤出首屏 —— 所以**只精选几个常用类常显、其余折叠**，点 ⌄ 才铺开。
                 折叠段里的选中项会被提到常显段（防止「筛选项消失、找不到取消入口」），
                 排布规则见 dshMarketCategorySplit -->
            <div class="iso-axis">
              <span class="iso-axis-label">分类</span>
              <button
                class="iso-axis-btn"
                :class="{ 'iso-axis-on': dshMarketCategory === '' }"
                @click="dshMarketCategory = ''"
              >全部（{{ dshMarket.count || dshMarket.plugins?.length || 0 }}）</button>
              <button
                v-for="c in dshMarketCategorySplit.top"
                :key="c.key"
                class="iso-axis-btn"
                :class="{ 'iso-axis-on': dshMarketCategory === c.key }"
                :disabled="!(dshMarketCategoryCount[c.key] || 0) && dshMarketCategory !== c.key"
                :title="dshMarketCategoryCount[c.key] ? c.key : c.key + '（目录里没有此类插件）'"
                @click="dshMarketCategory = dshMarketCategory === c.key ? '' : c.key"
              >{{ c.zh || c.en || c.key }}（{{ dshMarketCategoryCount[c.key] || 0 }}）</button>
              <!-- 折叠开关：仅在真有折起来的分类时出现（分类本来就少于门槛时不该多一颗空按钮）。
                   ⚠️ 计数用 restCount 而不是 rest.length —— rest 里含「选中项之外的有计数类」，
                   展开后选中项已归到常显段（不再属于 rest），用它会让「N 个」在展开的一瞬间变样。
                   restCount 是折叠前算好的常数，收起态与展开态读出同一个数 -->
              <button
                v-if="dshMarketCategorySplit.rest.length"
                class="iso-axis-btn iso-cat-toggle"
                :title="dshMarketCatExpand
                  ? '收起不常用的分类'
                  : '展开其余 ' + dshMarketCategorySplit.restCount + ' 个分类（按条数由多到少）'"
                :aria-expanded="dshMarketCatExpand ? 'true' : 'false'"
                @click="dshMarketCatExpand = !dshMarketCatExpand"
              >
                <span class="iso-cat-caret">{{ dshMarketCatExpand ? '▴' : '▾' }}</span>
                {{ dshMarketCatExpand ? '收起' : dshMarketCategorySplit.restCount + ' 个' }}
              </button>
            </div>
            <!-- 折起来的那一段单独一行：与常显段分开，展开时一眼能看出「多出来的部分」从哪开始。
                 ⚠️ 这里【必须按条数重排一遍】，不能直接用 rest 的数组顺序：
                 rest = usable.slice(补进来的名额) + empty，它的开头正好被常显段截走了一段，
                 接着才是剩下的。若原样渲染，展开时这段会**跳到前面**（上一次被补进常显段的那几个
                 名字出现在「其余」行的下半截），看起来就是「位置没跟着变」。
                 常显段内部是条数降序，这里也按同一口径重排，展开后整块的次序才是连续的。
                 v-if 而不是 v-show —— 收起时这些按钮不该留在 DOM 里被 Tab 键走到 -->
            <div v-if="dshMarketCatExpand" class="iso-axis">
              <span class="iso-axis-label">其余</span>
              <button
                v-for="c in [...dshMarketCategorySplit.rest].sort((a, b) => (dshMarketCategoryCount[b.key] || 0) - (dshMarketCategoryCount[a.key] || 0))"
                :key="c.key"
                class="iso-axis-btn"
                :class="{ 'iso-axis-on': dshMarketCategory === c.key }"
                :disabled="!(dshMarketCategoryCount[c.key] || 0) && dshMarketCategory !== c.key"
                :title="dshMarketCategoryCount[c.key] ? c.key : c.key + '（目录里没有此类插件）'"
                @click="dshMarketCategory = dshMarketCategory === c.key ? '' : c.key"
              >{{ c.zh || c.en || c.key }}（{{ dshMarketCategoryCount[c.key] || 0 }}）</button>
            </div>
            <div class="iso-axis">
              <span class="iso-axis-label">范围</span>
              <button class="iso-axis-btn" :class="{ 'iso-axis-on': dshMarketState === 'all' }" @click="dshMarketState = 'all'">全部</button>
              <button class="iso-axis-btn" :class="{ 'iso-axis-on': dshMarketState === 'installed' }" @click="dshMarketState = 'installed'">已装</button>
              <button class="iso-axis-btn" :class="{ 'iso-axis-on': dshMarketState === 'notInstalled' }" @click="dshMarketState = 'notInstalled'">未装</button>
              <!-- 「只看可更新」单开一个开关而不并进「范围」三选一：可更新必然已装，
                   并进去会出现「已装/未装/可更新」这种互斥关系不成立的选项 -->
              <button
                class="iso-axis-btn"
                :class="{ 'iso-axis-on': dshMarketOnlyUpdate }"
                :disabled="!dshMarketUpdateCount"
                :title="dshMarketUpdateCount ? '只看已装且有新版的' : '当前没有可更新的插件'"
                @click="dshMarketOnlyUpdate = !dshMarketOnlyUpdate"
              >只看可更新{{ dshMarketUpdateCount ? '（' + dshMarketUpdateCount + '）' : '' }}</button>
              <!-- 「只看 DSH 兼容」：与上面同性质。⚠️ 与「只看可更新」并列而不并进「范围」三选一，
                   同样是因为互斥关系不成立（兼容性与装没装无关） -->
              <button
                class="iso-axis-btn"
                :class="{ 'iso-axis-on': dshMarketOnlyCompat }"
                :disabled="!dshMarketCompatCount"
                :title="dshMarketCompatCount ? '只看已确证与当前 DSH 兼容的' : '还没有已确证兼容的插件（当前页查完才计数）'"
                @click="dshMarketOnlyCompat = !dshMarketOnlyCompat"
              >只看 DSH 兼容{{ dshMarketCompatCount ? '（' + dshMarketCompatCount + '）' : '' }}</button>
            </div>
            <div class="iso-axis">
              <span class="iso-axis-label">排序</span>
              <!-- 排序轴是单选的，但**再点一次当前轴会反向**（方向见下方箭头）。
                   所以这里不能用单选按钮的语义，而是「点当前项 = 切方向」的三态按钮 -->
              <button class="iso-axis-btn" :class="{ 'iso-axis-on': dshMarketSort === 'downloads' }" :title="dshMarketSortTip('下载量')" @click="dshMarketPickSort('downloads')">下载量</button>
              <button class="iso-axis-btn" :class="{ 'iso-axis-on': dshMarketSort === 'stars' }" :title="dshMarketSortTip('星标')" @click="dshMarketPickSort('stars')">星标</button>
              <button class="iso-axis-btn" :class="{ 'iso-axis-on': dshMarketSort === 'added' }" :title="dshMarketSortTip('最新收录')" @click="dshMarketPickSort('added')">最新收录</button>
              <button class="iso-axis-btn" :class="{ 'iso-axis-on': dshMarketSort === 'name' }" :title="dshMarketSortTip('名称')" @click="dshMarketPickSort('name')">名称</button>
              <!-- 方向：读出「当前轴 + 方向」这个事实，切换一律走上面的按钮。
                   不单独给一个方向开关 —— 那样会出现「方向：降序」但一个轴都没选中的空档状态 -->
              <span class="iso-axis-label">方向：{{ dshMarketSortDesc ? '降序' : '升序' }}</span>
            </div>
            <p v-if="!dshMarketStatus" class="hint">还没读到本地已装状态，「已装 / 未装」两个筛选项暂时不会过滤（读不到就不冒充未安装）。</p>
          </div>
        </div>

        <!-- 空态：把「筛掉的原因」说清楚，并带上全量条数 —— 只说「没有符合条件」
             会让人怀疑是目录没加载好，而不是自己筛得太窄 -->
        <p v-if="!dshMarketList.length" class="hint">
          没有符合条件的插件（目录共 {{ dshMarket.count || dshMarket.plugins?.length || 0 }} 条）
          —— 换个关键词，或把「分类 / 范围」放宽到「全部」。
        </p>

        <template v-else>
          <!-- ── 回源查「官方最新版」（卡片顶部一个按钮，查**当前分页**）──
               ⚠️ 为什么要有它：这张卡上所有版本号都出自**目录**，而目录是**每日快照** ——
                  它说「已是最新」本身可能已经过时（实测目录停在 9/24 记 1.61.0，registry 上
                  早已是 1.65.1）。要确证只能回源问一次。
               ⚠️ 为什么是按钮而不是自动查：一页就 80 条，自动查等于一开卡片打 80 个请求，
                  与「刷新目录默认零网络」同一考量。 -->
          <div class="mkt-latest-bar">
            <!-- ⚠️ 这一行的按钮与卡片顶部「刷新目录 / 强制重抓 / 刷新已装状态」用**同一套**
                 `secondary utils-btn utils-secondary`，不是 link-btn：早先用 link-btn 是为了
                 「不抢主按钮」，但它与同类辅助按钮并排时高宽、内边距都对不上，看起来像另一个
                 层级的控件（用户实测反馈「样式和别的进行统一」）。统一到 secondary 后，
                 层级语义仍由位置（单独一行、在列表上方）与文案承担。 -->
            <button
              class="secondary utils-btn utils-secondary"
              :disabled="dshMarketLatestBusy || !dshMarketLatestTargets.length"
              :title="dshMarketLatestTargets.length
                ? '回源 npm registry 查当前页 ' + dshMarketLatestTargets.length + ' 个插件（会联网，几十个请求）'
                : '当前页没有可查的条目（只有 npm 来源的插件能回源查版本）'"
              @click="dshMarketCheckLatestPage"
            >{{ dshMarketLatestBusy ? '查询中…' : '查官方最新版' }}</button>
            <!-- ⚠️ 把「查的是谁」写死在文案里：用户实测问过「查的是已安装插件的还是目前列表
                 显示的插件的」—— 这正是本按钮最容易误解的地方。查的是**当前分页展示的条目**
                 （不是「已装清单」，也不是整个目录），故直接说「本页」。 -->
            <span class="mkt-latest-scope">本页 {{ dshMarketLatestTargets.length }} 个可查（仅列出的 npm 来源）· 会联网</span>
            <span v-if="dshMarketLatestSummary()" class="mkt-latest-sum">{{ dshMarketLatestSummary() }}</span>
          </div>
          <!-- 只列「官方版本比基准版本新」的那些（1.65.1 这种查出来才有意义）。
               ⚠️ 基准是**实装版本优先**（见 dshMarketBaseVer）：显示「已装 vX → 官方 vY」，
                  不显示目录版本 —— 目录会落后于用户已装的版本（实测实装 1.62.0 / 目录 1.61.0），
                  拿目录当基准会让人以为「要从 1.61 升到 1.65」。
               ⚠️ 「装这一版」只给 npm 来源（dshMarketExactable）：它按 `包名@确切版本` 装，
                  这才是**真正能装上**的路径 —— 卡片原有「更新」按钮按目录 spec 重装，会被
                  pnpm-lock 锁回旧版，装不到这一版。非 npm 来源（如 `dsh-web#packages/...`）
                  给了按钮也必然失败，故只说版本差异、不给按钮。 -->
          <div v-if="dshMarketLatestStales.length" class="mkt-latest-list">
            <div v-for="p in dshMarketLatestStales" :key="'stale-' + p.spec" class="mkt-latest-row">
              <span class="mkt-latest-name" :title="p.spec">{{ p.name }}</span>
              <span class="mkt-latest-ver" :title="dshMarketLatestTip(p)">
                已装 v{{ dshMarketBaseVer(p) || '?' }} → 官方 <b>{{ dshMarketLatestText(p) }}</b>
              </span>
              <span class="mkt-spacer"></span>
              <button
                v-if="dshMarketExactable(p)"
                class="secondary utils-btn utils-secondary"
                :disabled="dshMarketBusy"
                :title="'按 ' + (p.npm || p.spec) + '@' + dshMarketLatestOf(p)?.version + ' 精确安装（会改写 pnpm-lock，与「更新」按钮不同）'"
                @click="dshMarketPreviewInstallExact(p)"
              >装这一版</button>
              <span v-else class="mkt-latest-note" title="该条目不是纯 npm 来源（spec 里带子路径等），无法按 `包名@版本` 精确安装">非 npm 来源，请用「更新」</span>
            </div>
          </div>
          <!-- 外面这层只负责给滚动条留槽位（见 .mkt-scroll）：滚动发生在里面的 .mkt-list，
               槽位留在外面，条目就不会被滚动条压住 -->
          <div class="mkt-scroll">
          <div class="mkt-list">
            <div v-for="p in dshMarketPageList" :key="p.spec + '|' + p.name" class="mkt-item">
              <div class="mkt-head">
                <span class="mkt-name" :title="p.owner ? '作者：' + p.owner : ''">{{ p.name }}</span>
                <span v-if="dshMarketHitAt(p)" class="patch-tag">已装</span>
                <!-- 「可更新」只在**确定**有新版时出（state==='update'）：
                     目录没给版本的条目 state 是 'unknown'，不能标成可更新 -->
                <span v-if="dshMarketHasUpdate(p)" class="patch-tag tag-update" :title="dshMarketUpdateTip(p)">可更新</span>
                <span v-if="dshMarketHitAt(p)?.disabled" class="patch-state state-off">已禁用</span>
                <span v-else-if="dshMarketHitAt(p)?.inDeps && !dshMarketHitAt(p)?.inPatch" class="patch-state state-unknown">包在磁盘，未写 patch</span>
                <!-- ⚠️ 「需构建」与「不认识」是两回事，必须分开说：
                     前者有按钮（装一次、按引导加 allowBuilds 再装一次就能成），
                     后者连按钮都不给（我们不知道拿什么去装，点了必然失败） -->
                <span v-if="p.needsBuild" class="patch-tag" title="该来源靠 prepare 脚本在安装时构建，pnpm 默认拦截构建脚本">需构建</span>
                <span v-if="!p.specKind" class="patch-tag">目录未给可识别的安装方式</span>
                <!-- DSH 宿主兼容性：**只显示查过的结论**（v-if 三态 tag）。
                     没查过时只给一个「检查兼容」按钮，不预置任何颜色 —— 见 dshMarketCompat 注释 -->
                <span
                  v-if="dshMarketCompatOf(p)"
                  class="patch-tag"
                  :class="dshMarketCompatClass(dshMarketCompatOf(p)!)"
                  :title="dshMarketCompatTip(dshMarketCompatOf(p)!)"
                >{{ dshMarketCompatTagText(dshMarketCompatOf(p)!) }}</span>
                <span class="mkt-pin">{{ dshMarketPinText(p) }}</span>
              </div>
              <p v-if="p.descZh || p.descEn" class="mkt-desc">{{ p.descZh || p.descEn }}</p>
              <div class="mkt-foot">
                <span class="mkt-cat">{{ dshMarketCategoryText(p.category) }}</span>
                <span class="mkt-npm">{{ p.spec || p.npm || '（目录没给安装方式）' }}</span>
                <!-- 已装版本 → 目录版本：只在**比得出来**时出（目录没给版本的条目 latest 是空，
                     写「? → ?」纯属噪音）。
                     ⚠️ 左侧取的是 node_modules 里的**实装版本**（裸 `0.5.11`），不是声明范围 ——
                     改口径前这里放的是 `^0.5.11` 这种范围原文，再被硬拼一个 `v` 前缀，
                     渲染成 `v^0.5.11` 这种不成立的写法，也答不了「我现在装的是哪版」。
                     实在读不到实装版本（包在磁盘但 node_modules 里没有）才退回显示声明范围，
                     此时不带 v —— `v^0.5.11` 不能出现。 -->
                <span v-if="dshMarketUpdateOf(p)?.latest" class="mkt-ver" :title="dshMarketUpdateTip(p)">
                  {{ dshMarketVersionText(p) }}
                </span>
                <span class="mkt-spacer"></span>
                <!-- 「检查兼容」：只有能剥出裸 npm 包名的条目才给（github / tarball 来源在
                     npm 上没有 manifest，查了必然 404）。查过一次就收起按钮 —— 结论已在上方 tag 上，
                     留着按钮反而让人以为要反复点 -->
                <button
                  v-if="dshMarketCompatable(p) && !dshMarketCompatOf(p)"
                  class="link-btn utils-btn utils-secondary"
                  :disabled="dshMarketCompatChecking(p)"
                  title="从 npm 拉这个包的 manifest，看它声明的 DSH 版本范围是否包含你当前的 DSH"
                  @click="dshMarketCheckCompat(p)"
                >{{ dshMarketCompatChecking(p) ? '检查中…' : '检查兼容' }}</button>
                <!-- 停用 / 启用：蓝色次操作（可逆，包还在磁盘），与「安装」同档 -->
                <button
                  v-if="dshMarketHitAt(p)?.inDeps || dshMarketHitAt(p)?.inPatch"
                  class="secondary patch-btn utils-btn utils-secondary"
                  :disabled="dshMarketBusy"
                  @click="dshMarketPreviewUninstall(p, false)"
                >{{ dshMarketHitAt(p)?.disabled ? '启用（留包）' : '停用（留包）' }}</button>
                <!-- 卸载（真删包）：走 utils-danger 危险档（半透明红底 + 红字描边）——
                     与「已装包」清单里的「彻底删除」、快照的「删除」同一个视觉语言，
                     让「不可逆」在整页里只有一种颜色。样式全部来自 main.css，
                     这里不再自己拼 .link-btn / .bak-del 两套类名 -->
                <button
                  v-if="dshMarketHitAt(p)?.inDeps || dshMarketHitAt(p)?.inPatch"
                  class="patch-btn utils-btn utils-danger"
                  :disabled="dshMarketBusy"
                  @click="dshMarketPreviewUninstall(p, true)"
                >卸载</button>
                <button
                  v-if="p.specKind && !dshMarketHitAt(p)?.inDeps && !dshMarketHitAt(p)?.inPatch"
                  class="secondary patch-btn utils-btn utils-secondary"
                  :disabled="dshMarketBusy"
                  @click="dshMarketPreviewInstall(p)"
                >{{ dshMarketPending === p.spec ? '处理中…' : (p.needsBuild ? '安装（需构建）' : '安装') }}</button>
                <a v-if="p.page || p.url" class="link-btn utils-btn utils-secondary" href="#" @click.prevent="openDoc(p.page || p.url)">主页</a>
              </div>
            </div>
          </div>
          </div>

          <!-- 页码分页：放在滚动区**外面** —— 放进列表末尾会被长列表推走，
               翻页要滚到底才能点，来回跳页的体验就没了 -->
          <div v-if="dshMarketPageCount > 1" class="mkt-pager">
            <button
              class="mkt-page-btn utils-btn utils-secondary"
              :disabled="dshMarketPageNo <= 1"
              @click="dshMarketPageNo = Math.max(1, dshMarketPageNo - 1)"
            >上一页</button>
            <!-- 省略号是不可点的占位（'...'），与页码共用一个按钮样式表 -->
            <template v-for="(it, idx) in dshMarketPageItems" :key="it + '-' + idx">
              <span v-if="it === '...'" class="mkt-page-gap">…</span>
              <button
                v-else
                class="mkt-page-btn utils-btn"
                :class="it === dshMarketPageNo ? 'mkt-page-on' : 'utils-secondary'"
                @click="dshMarketPageNo = it"
              >{{ it }}</button>
            </template>
            <button
              class="mkt-page-btn utils-btn utils-secondary"
              :disabled="dshMarketPageNo >= dshMarketPageCount"
              @click="dshMarketPageNo = Math.min(dshMarketPageCount, dshMarketPageNo + 1)"
            >下一页</button>
          </div>

          <!-- 计数与「当前在第几页」说清楚：只给页码不给总数，用户不知道后面还有多远。
               顺带把**当前排序轴与方向**写在这里（如「下载量 降序」）—— 筛选区收起后
               只剩列表，顺序看起来就是随机的，而方向切换只靠按钮悬停是看不见的 -->
          <p class="hint mkt-rest">
            共 {{ dshMarketList.length }} 条符合条件，第 {{ dshMarketPageNo }} / {{ dshMarketPageCount }} 页（每页 {{ DSH_MARKET_PAGE }} 条）。
            排序：{{ dshMarketSortLabel }} {{ dshMarketSortDesc ? '降序' : '升序' }}。
          </p>
        </template>

        <!-- 待确认的安装/卸载计划：与「插件开关」卡同一套手势 —— 先摆出来再写。
             ⚠️ 整块是一张「有名字、有版本、有后果、有动作」的单据，不是一行提示语（2026-09-25 改版）：
                原先是两行 `hint`（「将安装 <强>`包名`</强>（显示名）：」+ 整句 message 塞进 `<code>`），
                后果与动作全挤在等宽字体的长句里。用户反馈「继续优化或者美化」——
                现在包名/显示名/版本各自成块（.mkt-plan-*），后果单独成列表，「会改哪些文件」列出来，
                动作按钮贴着单据底部。确认按钮与取消同排（原先是 danger 在左、取消在右，
                一眼看去分不清哪个是主操作）。 -->
        <template v-if="dshMarketPlan">
          <div class="mkt-plan" :class="{ err: dshMarketPlan.action === 'remove' }">
            <p class="mkt-plan-head">
              <span class="mkt-plan-badge">{{ dshMarketPlan.action === 'install' ? '安装' : dshMarketPlan.action === 'remove' ? '彻底删除' : '禁用' }}</span>
              <strong class="mkt-plan-name">{{ dshMarketPlan.npm }}</strong>
            </p>
            <p class="mkt-plan-sub">
              {{ dshMarketPlan.name || '（未提供显示名）' }}
              <!-- exact：把「从哪一版到哪一版」摆在最显眼处 —— 这是用户点「装这一版」最关心的一条 -->
              <template v-if="dshMarketPlan.exact && dshMarketPlan.targetVersion">
                · 精确到
                <b>v{{ dshMarketPlan.targetVersion }}</b>
                <span class="mkt-plan-arrow" aria-hidden="true">·</span>
                <span class="mkt-plan-note">不改别的包</span>
              </template>
              <!-- ⚠️ 非 exact 的安装 / 更新**必须把「要改成哪一版」写出来**（2026-09-25 用户反馈
                   「能不能更明确点」）：下面「会改什么」只说「改写版本范围」，「按目录提供的版本重装」
                   又把版本当成了形容词 —— 用户真正想知道的是**具体数字**。
                   版本取 plan.version（更新入口给的是目录版本），拿不到就不提，不写「v?」。
                   ⚠️ 安装只在「同一包已装」时才叫「改为」：全新安装没有「从哪一版来」，
                   两处都写「改为」会让首次安装看起来像在覆盖什么。判据与上面那行的「已装」徽章同源 -->
              <template v-else-if="dshMarketPlan.version && (dshMarketPlan.action === 'install' || dshMarketPlan.action === 'update')">
                ·
                <span class="mkt-plan-note">{{ dshMarketPlan.action === 'update' ? '版本将改为' : '将写入版本' }}</span>
                <b>v{{ dshMarketPlan.version }}</b>
              </template>
              <span v-else class="mkt-plan-note">· 按目录提供的版本重装</span>
            </p>
            <!-- ⚠️ 宿主不兼容警示条（2026-09-25 加）：这是**唯一**一处能让用户看见
                 「我要装的这个东西要求 DSH x，我宿主是 y」的地方 —— 宿主给的 error 文案在
                 flash 消息里，会被下一次操作刷掉；而这张单据会一直摆到用户点头或取消。
                 两种状态必须分开写：还没强装的（下面给按钮）vs 已经决定强装的（只剩后果提醒），
                 混成一句会让用户分不清自己到底按没按过。 -->
            <div v-if="dshMarketPlan.hostIncompatible" class="mkt-plan-warn">
              <p class="mkt-plan-warn-head">
                <span aria-hidden="true">⚠️</span>
                {{ dshMarketPlan.hostForced ? '你正在强行安装一个宿主不兼容的插件' : '这个插件与当前 DSH 不兼容' }}
              </p>
              <p v-if="dshMarketPlan.hostIncompatible && !dshMarketPlan.hostForced" class="mkt-plan-warn-body">
                它声明的 DSH 版本范围容不下当前宿主（要求见上方提示）。装上 pnpm 不会报错，
                但 dsh 起插件时才会去核这条声明 —— 那一步失败通常只写进 dsh 自己的日志，
                界面上不显示，看起来就像插件本身坏了。
              </p>
              <p v-else class="mkt-plan-warn-body">
                写入会照常完成。若之后 dsh 加载它失败或行为异常，<strong>先回滚快照</strong>；
                想真正用上它，需要把 DSH 升到它要求的版本再装。
              </p>
              <p class="mkt-plan-warn-body">
                动手前会自动建快照，失败仍可回滚 —— 但「装上用不了」这件事本身，快照救不了。
              </p>
            </div>
            <!-- ⚠️ 用 `white-space: pre-line` 保留宿主 message 里的换行：message 尾部会挂一段
                 `⚠️ 该来源靠 prepare 脚本构建…` 的警告，那是**独立一段**，跟主句挤成一行会读丢 -->
            <p v-if="dshMarketPlan.message" class="mkt-plan-msg">{{ dshMarketPlan.message }}</p>
            <!-- 「会改什么」列出来：profile 的 package.json 是用户真正会被改动的东西，
                 而 `dsh plugin add` 还会连带改 lock —— 说清楚才敢点确认。
                 ⚠️ 每条都必须**按动作分支**，不能一股脑列全：把「包仍留在磁盘上」写给安装看、
                 或把「会改写版本范围」写给禁用看，都是误导 —— 而这张单子的全部价值就在于说准。 -->
            <ul class="mkt-plan-effects">
              <template v-if="dshMarketPlan.action === 'install'">
                <li>
                  改写 profile <code>{{ dshPatchProfile }}</code> 的 <code>package.json</code>：
                  <code>{{ dshMarketPlan.npmName || dshMarketPlan.npm }}</code>
                  的版本范围
                  <!-- 声明范围与目标版本一起说清「这一格会变成什么」——
                       只写「改写版本范围」，用户答不出最后落在哪一版 -->
                  <template v-if="dshMarketPlan.depVersion">（现在 <code>{{ dshMarketPlan.depVersion }}</code>）</template>
                  <template v-if="dshMarketPlan.version">，指明要 <b>v{{ dshMarketPlan.version }}</b></template>
                </li>
                <li>连带更新 <code>pnpm-lock.yaml</code>（旧版本会从 lock 里被替换掉）</li>
                <li v-if="dshMarketPlan.needsBuild">该来源靠 <code>prepare</code> 脚本构建，pnpm 默认会拦一次</li>
                <li>动手前自动建快照，失败可回滚</li>
              </template>
              <template v-else-if="dshMarketPlan.action === 'update'">
                <!-- update 原先落进下面的 else 分支，被写成「只往 patch 里写一条 disabled: true」——
                     那是**禁用**的说明，与更新完全无关。安装 / 彻底删除都各有分支，只有更新漏了，
                     于是用户点「更新」看到的是一段讲禁用的文字（真实错误） -->
                <li>
                  改写 profile <code>{{ dshPatchProfile }}</code> 的 <code>package.json</code> 里的版本范围
                  <template v-if="dshMarketPlan.npmName">（<code>{{ dshMarketPlan.npmName }}</code>）</template>
                  <template v-if="dshMarketPlan.depVersion">：现在 <code>{{ dshMarketPlan.depVersion }}</code></template>
                  <template v-if="dshMarketPlan.version">，重装后指的是 <b>v{{ dshMarketPlan.version }}</b></template>
                </li>
                <li>连带更新 <code>pnpm-lock.yaml</code>（这是「更新」与「装这一版」的共同点：都会改写 lock）</li>
                <li>动手前自动建快照，失败可回滚</li>
              </template>
              <template v-else-if="dshMarketPlan.action === 'remove'">
                <li>从 profile <code>{{ dshPatchProfile }}</code> 的 <code>package.json</code> 里删掉这个依赖</li>
                <li>连带从 <code>pnpm-lock.yaml</code> 与磁盘上移除包本体</li>
                <li>动手前自动建快照，失败可回滚</li>
              </template>
              <template v-else>
                <li>只往 patch 里写一条 <code>disabled: true</code></li>
                <li>包与依赖原样留在磁盘上，不碰 <code>package.json</code> / <code>pnpm-lock.yaml</code></li>
                <li>动手前自动建快照，失败可回滚</li>
              </template>
            </ul>
            <!-- 进行中的进度区：npm 要跑完才返回，github/tarball 来源还要 clone + 构建，
                 等待可能长达几分钟。这里给出「在做什么 + 已等多久 + 执行的命令 + 实时输出」，
                 让等待可见 —— 此前只有一个静止的「写入中…」，用户不知道到底动没动。
                 ⚠️ 命令与输出**始终占位**（没有就打一句说明），不整块 v-if 掉：用户实测反馈
                    「不知道执行了什么命令、日志、进度」—— 元素时有时无会让区块高度反复跳，
                    也让人怀疑是不是没在跑。 -->
            <div v-if="dshMarketTicking" class="mkt-progress">
              <p class="mkt-progress-head">
                <span class="mkt-spin" aria-hidden="true"></span>
                正在{{ dshMarketActionLabel() }}…已等 {{ dshMarketElapsedText() }}
              </p>
              <p class="hint mkt-progress-phase">{{ dshMarketPhaseText() }}</p>
              <p class="mkt-progress-cmd">
                <span class="mkt-progress-k">执行的命令</span>
                <code v-if="dshMarketLastCmd">{{ dshMarketLastCmd }}</code>
                <span v-else class="hint">尚未产生 —— 宿主还没进到起 pnpm 那一步（见下方「实时输出」的阶段说明）</span>
              </p>
              <p class="mkt-progress-k">实时输出</p>
              <pre v-if="dshMarketLogTail" ref="dshMarketLogEl" class="mkt-progress-log">{{ dshMarketLogTail }}</pre>
              <pre v-else class="mkt-progress-log mkt-progress-log-empty">（还没有输出。若进程已起来却长时间没动静，带构建的来源要先 clone 再 prepare，首次会比较慢）</pre>
              <p class="hint">
                完整日志见上方「运行详情」→「查看 dsh 日志」（本区块只显示最后 {{ DSH_MARKET_TAIL_LINES }} 行）。
                请不要关掉本页：pnpm 由宿主进程托管，关页不会中断，但也看不到结果。
              </p>
            </div>
            <div class="btn-row mkt-plan-actions">
              <!-- ⚠️ 宿主不兼容时，确认键原样保留（用户可能正是想强装），只在它**前面**加一个
                   把话说明白的入口。刻意不把确认键换成「强制安装」：那样点下去就像普通安装，
                   而这件事的后果（装上大概率加载不了）需要一个明确说出口的动作。
                   ⚠️ 强装态（hostForced）下这个按钮消失 —— 已经强装过了，再点只是再跑一遍 dryRun -->
              <button
                v-if="dshMarketPlan.hostIncompatible && !dshMarketPlan.hostForced"
                class="secondary utils-btn utils-secondary"
                :disabled="dshMarketBusy"
                @click="dshMarketForcePlan()"
              >仍要强制{{ dshMarketPlan.action === 'update' ? '更新' : '安装' }}…</button>
              <!-- ⚠️ 确认用 primary 而不是 danger（2026-09-25 改）：dsh 装插件是**常规操作**，
                   整张卡标红会让人以为要删东西；真正的不可逆操作是「彻底删除」，那个仍走 danger -->
              <button
                class="utils-btn utils-primary"
                :disabled="dshMarketBusy"
                @click="dshMarketConfirm()"
              >{{ dshMarketBusy ? `正在${dshMarketActionLabel()}…` : (dshMarketPlan.action === 'install' ? '确认安装（先建快照）' : '确认执行（先建快照）') }}</button>
              <button class="secondary utils-btn utils-secondary" :disabled="dshMarketBusy" @click="dshMarketPlan = null">取消</button>
            </div>
          </div>
        </template>

        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="dshMarketFolds.help = !dshMarketFolds.help">{{ dshMarketFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="dshMarketFolds.help" class="guide">
            <p class="guide-use"><strong>目录从哪来：</strong>默认走 npm 镜像（<code>registry.npmmirror.com</code> 的 <code>dsh-plugin-catalog</code>，与官方同源但只有 1.09MB）。勾「官方源」会让 <code>awesome-dsh-plugin.com/plugins.json</code>（4.37MB）一起参赛。多源<strong>并发竞速、先到先用</strong>；全挂则用本地副本并标「可能已过期」。也可填自定义 URL（优先于镜像）。</p>
            <p class="guide-use"><strong>为什么默认不联网：</strong>本 Tab 其余卡片展开即读本地文件，唯独这张要发 HTTP。所以展开只读已装状态，点「进入市场」→「加载目录」才抓取；来源单选只改偏好，不触发抓取。</p>
            <p class="guide-use"><strong>安装用什么 spec：</strong>用目录条目自带的 <code>install</code> 字段（目录作者原话），剥出末尾 spec 去装。<strong>不按 <code>npm</code> 字段拼</strong> —— 4183 条里 2033 条（48.6%）<code>npm</code> 为 null，装的是 <code>github:owner/repo</code> 或远端 <code>.tgz</code>，只认 npm 名等于判死近一半目录。三种形态：裸包名、<code>github:owner/repo</code>、<code>https://…/x.tgz</code>；认不出时<strong>不给安装按钮</strong>。</p>
            <p class="guide-use"><strong>「需构建」是什么：</strong>github / tarball 来源靠 <code>prepare</code> 在安装时构建，pnpm 默认拦截（防止不明来源的包安装时执行代码）。报错给出带 commit hash 的 key，要写进 profile 的 <code>pnpm-workspace.yaml</code> → <code>allowBuilds</code>。<strong>装前拿不到 key</strong>，所以注定先失败一次。<strong>不会替你放行</strong> —— 那等于废掉这个安全机制。</p>
            <p class="guide-use"><strong>禁用 vs 彻底删除：</strong>「禁用」只往 patch 写 <code>disabled: true</code>，包还在磁盘，随时改回；「彻底删除」跑 <code>npm uninstall</code>。<strong>只删你点的这个包名</strong>，不做依赖反查 —— 反查会连带删掉别的插件共用的依赖。</p>
            <p class="guide-use"><strong>禁用为什么用短名：</strong>patch 条目 id 是你实际写的名字（常是去掉 <code>@scope/</code> 的短名），目录给的是完整包名。用完整名 append 等于新加一条指向不存在插件的条目 —— dsh <strong>不报错</strong>，只静默失效。所以先用完整名对，对不上再用短名兜。</p>
            <p class="guide-use"><strong>缓存两层：</strong>内存 60 秒（挡反复刷新）+ 落本地存储做离线兜底。「强制重抓」绕开内存缓存真重新请求；改了来源后也会自动重抓。</p>
          </div>
        </div>
      </template>

      </template>
      </template>
    </section>
    <!-- [dsh] Codex 本地会话统计：读 ~/.codex/sessions 的 rollout JSONL，纯本地、不联网。
         上方 7 张卡都属于 dsh，这张不是 —— 用一条纯分界线隔开即可，不写字：
         写字会和紧邻的卡标题「Codex 会话统计」重复，反而更啰嗦。 -->
    <hr v-if="activeTab === 'dev'" class="group-sep">
    <section v-if="activeTab === 'dev'" class="card dsh-card">
      <div class="card-head">
        <h2 class="card-toggle" @click="toggleDevCard('codex')">
          <span class="caret">{{ devFolds.codex ? '▾' : '▸' }}</span>Codex 会话统计
          <!-- 收起态摘要：只在「本会话已展开读过」后才显示，否则不预读、直接提示点开 -->
          <span v-if="!devFolds.codex" class="card-sum">
            <template v-if="devStatsLoaded.codex && codex && codex.ok">今日 {{ fmtTokens(codex.todayTokens) }} tokens · 本月 {{ fmtTokens(codex.monthTokens) }}</template>
            <template v-else>点击展开查看</template>
          </span>
        </h2>
      </div>
      <template v-if="devFolds.codex">
      <p class="hint">
        直接读 Codex CLI 写在 <code>~/.codex/sessions</code> 的会话日志（<code>rollout-*.jsonl</code>）做统计，
        <strong>纯本地读取、不需要 API Key、不发任何网络请求</strong>。用量取累计量的差值，天然免疫重复计数。
      </p>
      <div class="btn-row">
        <!-- 首次展开已自动读过一次，按钮主要当「刷新」用 -->
        <button class="utils-btn utils-primary" :disabled="codexBusy" @click="codexRefresh">{{ codexBusy ? '读取中…' : (codex ? '刷新' : '读取统计') }}</button>
        <button v-if="codex" class="secondary utils-btn utils-secondary" :disabled="codexBusy" @click="codexClearCache">清除缓存并重扫</button>
      </div>
      <p v-if="codexFlash.msg" class="msg" :class="msgCls(codexFlash)">{{ codexFlash.msg }}</p>

      <template v-if="codex && codex.ok">
        <label class="field row">
          <span class="label">会话目录</span>
          <span class="cmdline">{{ codex.home }}</span>
        </label>
        <label class="field row">
          <span class="label">会话文件</span>
          <span class="ver">{{ codex.sessions }} 个</span>
        </label>

        <!-- 与 dsh 用量卡保持同一套指标格：原先「今日」「累计」各占一行、数值与单位混排，
             「累计」的括号里还塞了三个分项、长度逼近两行。改成等宽格后横向可比，
             分项另起一行小格（见下方 .stat-break）。
             Codex 无金额口径（showCost=false），故 .stat-sub 不放成本：
             今日那格改放轮次，其余留空不渲染（空 span 会让该格多占一行高度）。 -->
        <div class="stat-grid">
          <div class="stat-cell" title="今日消耗的 token 数（含输出 / 推理 / 缓存命中）">
            <span class="stat-num">{{ fmtTokens(codex.todayTokens) }}</span>
            <span class="stat-label">今日</span>
            <span class="stat-sub">{{ codex.turns || 0 }} 轮</span>
          </div>
          <div class="stat-cell" title="本月消耗的 token 数">
            <span class="stat-num">{{ fmtTokens(codex.monthTokens) }}</span>
            <span class="stat-label">本月</span>
          </div>
          <div class="stat-cell" title="有记录以来的累计 token 数">
            <span class="stat-num">{{ fmtTokens(codex.totalTokens) }}</span>
            <span class="stat-label">累计</span>
          </div>
          <div class="stat-cell" title="会话文件个数（~/.codex/sessions 下的 rollout-*.jsonl）">
            <span class="stat-num">{{ codex.sessions || 0 }}</span>
            <span class="stat-label">会话</span>
          </div>
        </div>

        <!-- 累计的 token 构成：三项本来塞在「累计」那一行的括号里，与总数混排 -->
        <div class="stat-break">
          <span class="stat-chip"><em>输出</em>{{ fmtTokens(codex.outTokens) }}</span>
          <span class="stat-chip"><em>推理</em>{{ fmtTokens(codex.reasonTokens) }}</span>
          <span class="stat-chip"><em>缓存命中</em>{{ fmtTokens(codex.cachedTokens) }}</span>
        </div>

        <!-- 订阅窗口：只有日志里带 rate_limits（ChatGPT 订阅）时才有内容，没有就整行不渲染。
             是相对倒计时的整句文本，与上面的短数值不同形，仍留 .field row。 -->
        <label v-if="codexWindowsText" class="field row">
          <span class="label">订阅窗口</span>
          <span class="ver">{{ codexWindowsText }}</span>
        </label>

        <UsageChart
          v-model:range="codexRange"
          :ranges="DSH_USAGE_RANGES"
          :days="codexDays"
          :label-every="codexLabelEvery"
          :bar-height="codexBarHeight"
          :day-label="codexDayLabel"
          :models="codexModels"
          turns-label="轮"
          :show-cost="false"
          :fmt-cost="() => ''"
        />

        <div class="fold">
          <button class="link-btn utils-btn utils-secondary" @click="codexFolds.help = !codexFolds.help">{{ codexFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="codexFolds.help" class="guide">
            <p class="guide-use"><strong>统计口径：</strong>优先用 <code>total_token_usage</code> 的累计差值（单调递增，一次轮次写多条 <code>token_count</code> 也不会重复计数）；累计缺失时退回 <code>last_token_usage</code>。</p>
            <p class="guide-use"><strong>模型归属：</strong>按 <code>turn_context</code> 事件里的 <code>model</code> 归类，未标注的记为 <code>codex</code>。</p>
            <p class="guide-use"><strong>订阅窗口：</strong>ChatGPT 订阅的 Codex 会在 <code>token_count</code> 事件里带 <code>rate_limits</code> 快照（5h 与周两个窗口的已用% 与重置时间），字段名各版本不一致，已做多候选键容错；API-key 计费或没有订阅时日志里没有这份快照，这一行不显示。窗口是账号级状态，与上面的本地 token 统计各自独立。</p>
            <p class="guide-use"><strong>缓存：</strong>按文件的 size/mtime 判断是否变化，只有变过的文件才重新解析（会话日志可能几十 MB）。缓存里只有聚合数与文件指纹，<strong>不含任何凭据</strong>。</p>
            <p class="guide-use"><strong>读不到数据：</strong>确认 Codex CLI 至少跑过一次、且 <code>~/.codex/sessions</code>（或 <code>$CODEX_HOME</code> 指向的目录）里有 <code>rollout-*.jsonl</code>。</p>
          </div>
        </div>
      </template>
      </template>
    </section>

    <!-- [帮助] 关于与更新 -->
    <section v-if="activeTab === 'help'" class="card">
      <h2>关于与更新</h2>
      <!-- 上游要求衍生版必须标注「个人衍生版」：既避免被误认成官方版，也说明售后归属 -->
      <p class="hint">本插件是 <strong>个人衍生版</strong>，移植自 <a href="#" @click.prevent="openDoc('https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget')">MeteorNOX/DeepSeek-Balance-Whale-Widget</a>（MIT License）。<strong>非官方版本，与 DeepSeek、uTools 官方均无关联</strong>，无官方支持与售后 —— 上游作者不对本衍生版负责，问题请走下方反馈入口。</p>
      <label class="field row check">
        <span class="label">自动检查更新</span>
        <input type="checkbox" v-model="cfg.updateCheckOn" @change="patchCfg({ updateCheckOn: cfg.updateCheckOn })" />
      </label>
      <label class="field row">
        <span class="label">当前版本</span>
        <span class="ver">v{{ appVersion }}</span>
      </label>
      <div class="btn-row">
        <button class="secondary utils-btn utils-secondary" :disabled="updateChecking" @click="doCheckUpdate(true)">
          {{ updateChecking ? '检查中…' : '立即检查更新' }}
        </button>
        <button class="secondary utils-btn utils-secondary" @click="marketSearch">插件市场</button>
        <button class="secondary utils-btn utils-secondary" @click="openHomepage">项目主页</button>
      </div>
      <p v-if="updateMsg" class="msg" :class="[updateResult && updateResult.ok ? 'ok' : 'err', hasUpdate ? 'clickable' : '']"
         :title="hasUpdate ? '点击前往插件市场更新' : ''"
         @click="hasUpdate && marketSearch()">{{ updateMsg }}</p>
      <p class="hint">开启后每次呼出插件自动检查一次（12 小时内最多一次），发现新版本会弹出系统通知。</p>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="aboutFolds.feedback = !aboutFolds.feedback">
          {{ aboutFolds.feedback ? '收起反馈与建议' : '反馈与建议' }}
        </button>
        <div v-if="aboutFolds.feedback" class="guide">
          <p class="hint">用得还顺手吗？想要的新功能、碰到的 bug，或者只是想吐槽两句，都欢迎告诉鲸鱼娘～可以去 <a href="#" @click.prevent="openDoc('https://www.u-tools.cn/plugins/detail/%E5%B0%8F%E9%B2%B8%E9%B1%BC%E4%BD%99%E9%A2%9D%E6%8C%82%E4%BB%B6/')">插件市场详情页</a> 的「留言」区，也可以在 <a href="#" @click.prevent="openDoc('https://github.com/Berge520/Balance-Whale-Widget/issues')">GitHub Issues</a> 里提，每条我都会认真看完，顺手给个五星好评就更开心啦 (๑•̀ㅂ•́)و✧</p>
        </div>
      </div>
    </section>

    <!-- [帮助] GitHub 加速（hosts 方案）：已抽成独立组件，显隐仍由本页的 Tab 决定 -->
    <AccelView
      v-if="activeTab === 'help'"
      :cfg="cfg"
      :services="services"
      :active-tab="activeTab"
      @patch="patchCfg"
    />

    <!-- 导入裁剪弹层：宿主选完文件（还没落盘）才显示，确认后才写盘 -->
    <SkinCropper
      v-if="skinCrop"
      :data-url="skinCrop.dataUrl"
      :name="skinCrop.name"
      @confirm="onSkinCropConfirm"
      @cancel="skinCrop = null"
    />
    <SoundTrimmer
      v-if="soundTrim"
      :data-url="soundTrim.dataUrl"
      :name="soundTrim.name"
      :role="soundTrim.role"
      :vol="cfg.vol"
      @confirm="onSoundTrimConfirm"
      @cancel="soundTrim = null"
    />

    <!-- 首次运行引导：新装用户进设置页时弹一次，保存凭据或跳过都置位 guideDone，之后不再弹 -->
    <FirstRunGuide
      v-if="showGuide"
      :api-key="secrets.apiKey"
      :platform-token="secrets.platformToken"
      :enter-mode="cfg.enterMode"
      :saving="guideSaving"
      :testing="testing"
      :test-results="testResults"
      :flash-msg="guideFlash.msg"
      :flash-err="guideFlash.err"
      :reopen="guideReopen"
      @save="onGuideSave"
      @test="onGuideTest"
      @skip="onGuideSkip"
      @doc="openDoc"
    />
  </div>
</template>

<style scoped>
.page {
  --fg: #1f2a44;
  --fg-dim: #536ba9;
  --fg-faint: #9fb0d9;
  --accent: #536ba9;
  --line: rgba(83, 107, 169, 0.4);
  --card-bg: rgba(127, 127, 127, 0.08);
  --card-border: rgba(127, 127, 127, 0.18);
  --track: rgba(83, 107, 169, 0.1);
  --input-bg: #ffffff;
  --ok: #2fa24c;
  --err: #e0433f;
  --warn: #c07d1a;
  /* 顶部 Tab 吸顶时的底色，必须与 main.css 里 body 的背景一致，否则滚到一半内容会从导航下面透出来 */
  --bar-bg: #f4f4f4;
  /* 让原生控件（下拉列表、复选框等）跟随本页主题，否则深色模式下
     下拉展开的选项会用系统浅色底 + 本页浅色字，导致文字看不清 */
  color-scheme: light;
  max-width: 560px;
  margin: 0 auto;
  padding: 22px 18px 44px;
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .page {
    --fg: #e8ecf5;
    --fg-dim: #9fb0d9;
    --fg-faint: #7f8db3;
    --accent: #8aa4e6;
    --line: rgba(255, 255, 255, 0.22);
    --card-bg: rgba(255, 255, 255, 0.06);
    --card-border: rgba(255, 255, 255, 0.12);
    --track: rgba(255, 255, 255, 0.08);
    --input-bg: #2b3145;
    --ok: #4ec46b;
    --err: #ff6b66;
    --warn: #e0a63c;
    --bar-bg: #303133;
    color-scheme: dark;
  }
  /* 深色下悬停浮出的轨道：main.css 默认给的是浅色系灰，深底上会显脏，这里换成冷白 */
  .log-box:hover::-webkit-scrollbar-track,
  .detail-entries:hover::-webkit-scrollbar-track,
  .mkt-list:hover::-webkit-scrollbar-track {
    background-color: rgba(255, 255, 255, 0.09);
  }
}
h1 {
  margin: 0 0 6px;
  font-size: 20px;
  letter-spacing: 0.3px;
}
.sub {
  margin: 0 0 18px;
  color: var(--fg-dim);
  font-size: 13px;
}
/* 顶部 Tab：一次只显示一组卡片（原先 12 张卡竖排一屏到底，找一项要滚很久）。
   吸顶是为了在长卡片（用量 / 开发者）里滚到一半也能直接切组 */
.tab-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  margin: 0 0 16px;
  padding: 6px 0 8px;
  background: var(--bar-bg);
}
.tab-row {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.tab {
  flex: 1;
  padding: 3px 0;
  font-size: 13px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
}
.tab:hover {
  color: var(--fg);
}
.tab-on {
  background: var(--accent);
  color: #fff;
}
.tab-on:hover {
  color: #fff;
}
.tab-desc {
  margin: 8px 2px 0;
  font-size: 12px;
  color: var(--fg-faint);
}
.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}
.card h2 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-dim);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.card-head h2 {
  margin: 0;
}
/* 可折叠卡片的标题本身是按钮：抹掉 button 默认外观，视觉上对齐 .card-head h2，
   让用户仍然一眼认出这是标题（有 hover 反馈暗示可点） */
.fold-title {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-dim);
  cursor: pointer;
}
.fold-title:hover {
  color: var(--fg);
}
/* 箭头单独占位，展开 / 收起时标题不会左右横跳 */
.fold-caret {
  width: 1em;
  font-size: 12px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
/* 卡片头部的区间快捷切换：与 UsageChart.vue 里那份同构（等分、文字居中），
   尺寸/配色来自 main.css 的 utils 基类。放在这里而不是沿用组件的 scoped 块 ——
   这些按钮是本模板直接写的元素，只有 App 的哈希，引用组件内的规则匹配不上。 */
.range-tabs {
  display: flex;
  gap: 4px;
}
.range-tab {
  flex: 1 1 0;
  text-align: center;
}
/* 开发者 Tab 两张统计卡的整卡折叠：标题即按钮，收起态在标题右侧挂一行摘要。
   摘要用次级色、可换行，保证窄窗口下不把标题挤走 */
.card-toggle {
  display: flex;
  align-items: baseline;
  gap: 6px;
  /* 窄窗口下摘要换到第二行，不挤压标题 */
  flex-wrap: wrap;
  cursor: pointer;
  user-select: none;
}
/* 对齐既有 .fold-caret：三角字符在标题字号下会继承 600 字重，
   小字号加粗后 ▸/▾ 会糊成一道短横，所以固定宽度并显式 400 字重 */
.card-toggle .caret {
  width: 1em;
  font-size: 12px;
  font-weight: 400;
  color: var(--fg-dim);
}
.card-sum {
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
  color: var(--fg-dim);
  text-align: right;
}
/* 卡片组之间的纯分界线（如 dsh 组与 Codex 卡之间）：只划线不写字 ——
   文字会和紧邻的卡标题重复。纯装饰，不抢卡片标题的视觉权重。
   上下间距要自己给足：卡片只在下侧留 margin-bottom，紧挨着的下一张卡没有 margin-top，
   若线只留 margin-top，线就会贴着下一张卡的边框（上图留白 16、下图 0，看着像贴歪）。 */
.group-sep {
  margin: 0 0 16px;
  border: 0;
  border-top: 1px solid var(--line);
}
/* 卡头里的危险操作（如「确认恢复默认？」）：与 .btn-row button.danger 同一套配色 */
.head-actions button.danger {
  background: rgba(224, 67, 63, 0.16);
  color: var(--err);
}
/* 「未保存」标记：改完 textarea 不点保存就切 Tab / 关窗口会丢改动，给个常驻提示。
   用 danger 色是因为丢的是用户手写的内容，且 align-self 保证在 flex 行里不拉伸 */
.dirty-tag {
  align-self: center;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.5;
  border-radius: 999px;
  background: rgba(224, 67, 63, 0.16);
  color: var(--err);
  white-space: nowrap;
}
/* 用量趋势区间切换与柱状图的样式**不在这里** —— 它们由 UsageChart.vue 渲染。
   本文件是 <style scoped>，选择器会编译成 `.chart[data-v-App哈希]`，而 scoped 属性只加在
   「本模板里直接写的元素」上；这些元素在子组件内部、只带 UsageChart 的哈希，规则整段失效。
   症状尤其隐蔽：柱状图完全不出图（.bar-track 的 height:90px 没生效 → 柱子高 0），
   但样式表里查得到、看着也没写错。现全部随组件放进 UsageChart.vue 自己的 scoped 块。 */
.export-btn {
  /* 尺寸与描边档配色来自 main.css 的 utils 基类；这里只补它没有的 hover 提亮。
     注意 markup 里那些 `class="export-btn danger"` / `:class="{ danger: ... }"`：
     它们在 scoped 块的 `[data-v]` 加持下特异性高于全局的 `.utils-danger`，
     所以 danger 变体现在**真的会显红**（在此之前 `.export-btn.danger` 根本没写样式，
     清除/删除类按钮一直只显示灰描边 —— 这是个既有 bug）。 */
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}
.field {
  display: block;
  margin: 10px 0;
}
.field.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.field.check {
  justify-content: flex-start;
  /* 标签换行成多行时，复选框跟首行对齐 —— 居中对齐会飘到两行之间，看起来像对错了行 */
  align-items: flex-start;
}
.label {
  font-size: 13px;
  /* 短标签保持 72px 起始宽度、纵向对齐（同组控件左侧对齐）；
     flex-shrink 允许长标签（常带 <em> 说明）在窄卡片里收缩换行，
     而不是顶住不缩把同行控件乃至整张卡片撑出边界 */
  flex: 0 1 auto;
  min-width: 72px;
  /* 长标签的换行点：中文没有空格，靠 break-word 才能在盒子内折行 */
  overflow-wrap: anywhere;
}
/* 勾选行（.field.check）：标签独占剩余宽度，复选框固定靠右不被挤出卡片。
   这类标签的 <em> 补充说明最长（如 dsh 的三条），是横向溢出的主要来源 */
.field.check .label {
  flex: 1 1 auto;
  min-width: 0;
  line-height: 1.5;
}
.field:not(.row) .label {
  display: block;
  margin-bottom: 5px;
}
.label em {
  font-style: normal;
  color: var(--fg-faint);
  font-size: 11px;
}
input[type='password'],
/* 裸文本输入框：属性选择器匹配的是「显式属性」，不带 type 的 input 会漏掉，掉成浏览器默认外观 */
input:not([type]),
input[type='text'],
select {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg);
}
/* 下拉展开后的选项：必须显式给出背景与文字色。
   否则深色模式下选项文字（浅色）会落在系统浅色弹层上，完全看不清。 */
select option {
  background: var(--input-bg);
  color: var(--fg);
}
input[type='password']:focus,
input:not([type]):focus,
input[type='text']:focus,
select:focus,
.num:focus,
.time:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(83, 107, 169, 0.18);
}
.field.row select {
  flex: 1;
}
.range {
  flex: 1;
  accent-color: var(--accent);
}
.num {
  width: 56px;
  padding: 5px 6px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
}
.num-text {
  width: 44px;
  text-align: right;
  font-size: 13px;
  color: var(--fg-dim);
}
/* 免打扰起止时刻（HH:MM） */
.time {
  width: 96px;
  padding: 5px 6px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
}
.time-sep {
  font-style: normal;
  font-size: 12px;
  color: var(--fg-faint);
}
.ver {
  font-size: 13px;
  color: var(--fg-dim);
  /* 值是版本号或安装路径（dsh 的「实际使用 / 全局安装 / 插件目录」），可能很长：
     作为 .field.row 的 flex 项默认 min-width:auto 不肯收缩，长路径会把卡片撑出边界。
     与 .field.check .label 同一处理，见那里的说明。 */
  min-width: 0;
  word-break: break-all;
}
/* 复制 / 定位的就地反馈：只靠颜色区分成败（文案相同），与 .msg.ok / .msg.err 同色系 */
.ver.ok {
  color: var(--ok);
}
.ver.err {
  color: var(--err);
}
/* 贴边间距：一行四个数值（上/右/下/左） */
.edge-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.edge-row em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-faint);
}
/* 任务栏状态：紧跟「自动避让任务栏」开关之后，收紧上下间距 */
.taskbar-hint {
  margin: 2px 0 12px;
}
/* dsh 最近执行的命令：等宽小字，可换行，方便核对/复制 */
.cmdline {
  font-family: ui-monospace, Consolas, 'Courier New', monospace;
  font-size: 12px;
  color: var(--fg-dim);
  word-break: break-all;
}
/* dsh 状态行里的小标签（来源 / 有新版本） */
.tag {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--fg-dim);
  background: rgba(127, 127, 127, 0.16);
}
.tag-new {
  color: #fff;
  background: var(--accent);
}
/* dsh 日志：中性框（普通输出不是错误，别用红框） */
.log-box {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(127, 127, 127, 0.08);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow: auto;
  /* 日志是等宽 pre-wrap，出不出滚动条只影响右侧留白；预留槽位免得日志变长时整块抖一下 */
  scrollbar-gutter: stable;
  user-select: text;
}
/* 悬停时轨道浮出来（滚动条配色统一在 main.css，这里只补「何时显现」）。
   伪元素上挂不了 :hover，只能写成「元素:hover 伪元素」；挂到真有滚动条的容器上，
   鼠标在页面别处时不会误亮。 */
.log-box:hover::-webkit-scrollbar-track,
.detail-entries:hover::-webkit-scrollbar-track,
.mkt-list:hover::-webkit-scrollbar-track {
  background-color: rgba(120, 134, 170, 0.1);
}
/* dsh 诊断结果列表：每一项一块，明细缩进在标题下方 */
.diag-item {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(127, 127, 127, 0.05);
}
.diag-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  flex-wrap: wrap;
}
/* 标记等宽，避免 [✓]/[!]/[✗] 混排时标题起点参差 */
.diag-mark {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  flex: none;
}
.diag-ok {
  color: #2e9e5b;
}
.diag-warn {
  color: #c98a00;
}
.diag-bad {
  color: #d9534f;
}
.diag-sum {
  color: var(--fg-dim);
  font-size: 12px;
}
.diag-detail {
  margin: 6px 0 0 20px;
}
.diag-line {
  margin: 2px 0;
  font-size: 12px;
  line-height: 1.6;
  /* 路径 / 报错原文可能很长，允许横向溢出由外层滚动，不撑破卡片 */
  word-break: break-all;
}
.diag-line-text {
  color: var(--fg);
}
.diag-hint {
  margin-left: 6px;
  color: var(--fg-faint);
}
.diag-more {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--fg-faint);
}
/* 配置转储的 patch 分层列表：每层一块，左侧色条区分 基线 / 包内层 / 用户层 */
.layer-list {
  margin-top: 6px;
}
.layer-item {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  border-left-width: 3px;
  background: rgba(127, 127, 127, 0.05);
}
.layer-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  flex-wrap: wrap;
}
.layer-kind {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  background: rgba(127, 127, 127, 0.18);
  color: var(--fg-dim);
}
.layer-name {
  color: var(--fg);
  word-break: break-all;
}
/* 用户层是绝对路径（可达 50+ 字符），不省略会把「N 条目 / M 分节」挤到下一行错位 */
.layer-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.layer-count {
  margin-left: auto;
  flex: none;
  color: var(--fg-dim);
  font-size: 12px;
}
/* 层里的条目 id：小号等宽、可换行，长列表不溢出卡片 */
.layer-items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 5px 0 0;
}
.layer-id {
  padding: 0 5px;
  border-radius: 4px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--fg-dim);
  background: rgba(127, 127, 127, 0.12);
  word-break: break-all;
}
.layer-more {
  font-size: 11px;
  color: var(--fg-dim);
  align-self: center;
}
.layer-base {
  border-left-color: rgba(127, 127, 127, 0.45);
}
.layer-bundle {
  border-left-color: #4a90d9;
}
.layer-user {
  border-left-color: #e08a2e;
}
/* 插件开关（E2）的条目列表：一行一个，左侧色条标出「已禁用」 */
.patch-list {
  margin-top: 6px;
}
.patch-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  border-left: 3px solid #4a90d9;
  background: rgba(127, 127, 127, 0.05);
}
/* 已禁用：灰掉色条 + 整行压暗。
   只灰色条时扫不出「哪些被我关了」——状态字与启用态同色同字号，一行行看下来要逐个读字。
   整行一起压暗后，「亮着的 = 启用中、暗着的 = 已禁用」可以一眼扫出来，不用读文字。 */
.patch-off {
  border-left-color: rgba(127, 127, 127, 0.45);
  background: rgba(127, 127, 127, 0.02);
}
.patch-off .patch-id {
  color: var(--fg-dim);
}
.patch-id {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--fg);
  word-break: break-all;
  min-width: 0;
}
.patch-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--fg-dim);
  background: rgba(127, 127, 127, 0.15);
}
/* 「目录里没有这个包」的说明性文字（见 dshMarketInstalledNote）：
   与 .patch-tag 的徽章区分开 —— 这不是状态，是一句解释，
   而且比较长（要说明缺了哪些按钮），所以不给底色、允许换行、可被压缩 */
.patch-note {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}
/* 「可更新」用实心绿：它是这批标签里唯一「建议你动手」的一个，
   灰底跟「需构建」「已装」混在一起扫不出来。绿色与「禁用」的灰、「启用中」的蓝都不撞。 */
.tag-update {
  color: #2e8b57;
  background: rgba(46, 139, 87, 0.14);
  border: 1px solid rgba(46, 139, 87, 0.35);
  font-weight: 500;
}
/* 状态徽章：已禁用 / 启用中 做成实心胶囊，两种状态颜色方向相反（灰 vs 蓝）。
   原先两者共用一个纯文字样式，「禁用」这件事全靠用户读那三个字；做成徽章后是颜色差异，扫一眼就分得出。 */
.patch-state {
  margin-left: auto;
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.state-on {
  color: #2f7bd0;
  background: rgba(74, 144, 217, 0.14);
  border: 1px solid rgba(74, 144, 217, 0.35);
}
.state-off {
  color: var(--fg-dim);
  background: rgba(127, 127, 127, 0.16);
  border: 1px solid rgba(127, 127, 127, 0.28);
}
/* DSH 宿主兼容性三态：兼容=蓝、不兼容=红、未知=灰。
   配色沿用既有语义变量（--err）—— 项目里没有 --danger，别再写不存在的变量名。
   ⚠️ 未知**不能**用红色：它只表示「没查到 / 没声明」，不是「不兼容」的证据 */
.tag-compat {
  color: #2f7bd0;
  background: rgba(74, 144, 217, 0.14);
  border: 1px solid rgba(74, 144, 217, 0.35);
}
.tag-incompat {
  color: var(--err);
  background: rgba(214, 76, 76, 0.12);
  border: 1px solid var(--err);
}
.tag-unknown {
  color: var(--fg-dim);
  background: rgba(127, 127, 127, 0.12);
  border: 1px solid rgba(127, 127, 127, 0.28);
}
/* 状态未知：用警示色而不是「启用中」的蓝 —— 宿主没读到 dump 状态时，
   把它画成启用中就是在替一条未知状态背书的谎报 */
.state-unknown {
  color: #b8860b;
  background: rgba(224, 138, 46, 0.13);
  border: 1px dashed rgba(224, 138, 46, 0.45);
}
.patch-btn {
  /* 尺寸/配色走 main.css 的 utils 基类（markup 挂 .utils-btn .utils-secondary） */
  flex: none;
}
/* 候选行（.iso-item）里既可能有行尾开关按钮、也可能没有（source=plugin 与「状态未知」不给按钮）。
   .patch-state 的 `margin-left: auto` 只把**第一个** auto 元素推到行尾，所以：
   - 没有按钮时：auto 落在徽章上，徽章贴右，正确；
   - 有按钮时：auto 仍落在徽章上，徽章被推右、按钮紧随其后 —— 但按钮自己没有左边距，
     两个控件会**贴死**（徽章是胶囊形，右边框弧线紧挨按钮左边缘，看着像一个拼接控件）。
   这里给按钮补 8px 间距（与 .patch-item 的 gap 一致），不动 auto 的归属 ——
   把 auto 挪到按钮上会让「无按钮」的行不再贴右，反而破坏原本正确的那些行。 */
.iso-item .patch-btn {
  margin-left: 8px;
}
/* 还原前的二次确认：把按钮染成警示色，避免连点误操作 */
.bak-confirm {
  border-color: #d9534f;
  color: #d9534f;
}
/* E3 候选行是 <label>，整行可点即勾选；补上手型与复选框对齐 */
.iso-item {
  cursor: pointer;
}
.iso-item input[type='checkbox'] {
  flex: none;
  margin: 0;
  accent-color: var(--accent);
}
/* 候选分组头：把 204 条收成 3 组后，这行是「哪些条属于哪一档」的唯一标识 */
.iso-tier {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--card-border);
}
.iso-tier:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
/* 「来源+状态」轴的内层组头：缩进 + 不画虚线，靠层级差说明「它属于上面那个来源」。
   若沿用 .iso-tier 的分隔线，两层组头连在一起会看起来是平级的兄弟组 */
.iso-tier-sub {
  margin-left: 18px;
  padding-top: 4px;
  border-top: none;
}
.iso-tier-hint {
  font-size: 12px;
  opacity: 0.6;
}
/* 分组轴切换：自带按钮样式，不复用 .link-btn —— 那个带 margin-top: 10px，在这个 flex 行里会歪掉 */
.iso-axis {
  display: flex;
  align-items: center;
  /* 分类 chip 有 24 类，必须能换行 —— 单行会把后面的 chip 挤出可视区（且没有横向滚动条，
     等于直接消失）。旧版「范围 / 排序」各只有 3-4 颗按钮，换行不影响它们 */
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--fg-dim);
}
/* 标签在换行后不该独自占一行，所以不让它收缩 */
.iso-axis-label {
  flex: none;
}
.iso-axis-btn {
  padding: 2px 10px;
  border: 1px solid var(--card-border);
  border-radius: 999px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 12px;
  cursor: pointer;
}
.iso-axis-btn:hover {
  color: var(--fg);
}
/* 计数为 0 的分类：点进去只会看到空列表，所以置灰且不可点。
   ⚠️ :hover 要一起掐掉，否则灰着的按钮仍会变亮，看着像能点。
   用 :not([disabled]) 限定，避免选中态（不会 disabled）也被这股力量压住 */
.iso-axis-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.iso-axis-btn:disabled:hover {
  color: var(--fg-dim);
}
/* 分类折叠开关：虚线边框与实心的分类 chip 区分开 —— 它是个动作，不是一个分类。
   ⚠️ 万一将来某个分类真叫「收起 / 展开」，虚线也能把两者分清 */
.iso-cat-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border-style: dashed;
}
/* ▴/▾ 用等宽（同 fold 系列的 caret 处理）：两个字形宽度不同，切换时整行会抖 */
.iso-cat-caret {
  width: 1em;
  text-align: center;
}
/* 「全选 / 只选启用中的」这一行：复用 .iso-axis 的横向排列，但去掉它的下边距 ——
   那 8px 是给「分组轴 → 候选列表」留的，这两颗按钮下面紧跟的是超限警告，
   .fold 与警告各有自己的间距，再叠 8px 会把它们顶开 */
.iso-pick-row {
  margin-bottom: 0;
  margin-top: 8px;
}
/* 当前生效的那一轴：实心底 + 亮字，和另一轴拉开差距 */
.iso-axis-on {
  color: var(--accent);
  border-color: var(--accent);
  background: rgba(83, 107, 169, 0.18);
  font-weight: 600;
}
.bak-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(127, 127, 127, 0.05);
}
/* known-good 是回滚目标，左侧加一条主色边，扫一眼就能找到 */
.bak-known {
  border-color: var(--accent);
}
.bak-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bak-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bak-time {
  font-size: 12px;
  color: var(--fg);
}
.bak-known-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--accent);
  border: 1px solid var(--accent);
}
/* 损坏标记用告警色而不是强调色：它和「已知良好」是完全相反的两件事，同色会被一眼看混 */
.bak-damaged-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--err);
  border: 1px solid var(--err);
}
.bak-name {
  flex: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg);
}
.bak-rename {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bak-rename-input {
  flex: 1;
  min-width: 0;
}
.bak-keep {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.bak-keep-input {
  width: 72px;
  flex: none;
}
.bak-keep-note {
  font-size: 11px;
}
/* 删除是不可逆的，单独染成警示色与「还原」的确认色区分开 */
.bak-del.bak-confirm {
  color: #d9534f;
}
.bak-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--fg-dim);
  background: rgba(127, 127, 127, 0.15);
}
/* 快照的来源（「市场安装前」「手动」等，见 DSH_BACKUP_REASONS 穷举映射）。
   与上面那行的 note 分开：**reason 答「哪类动作」、note 答「对谁做的」** ——
   原先两者挤在同一枚小徽章的位置上（note 占了这个位），于是「哪类动作」在列表里
   整个看不见了。这里仍用 .bak-tag 的灰底小徽章外观：它是枚举值，读法就是标签，
   而 note 那句（动作 + 包名@版本）才是要当句子读的，故它自己占一行 */
.bak-reason {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--fg-dim);
  background: rgba(127, 127, 127, 0.15);
}
.bak-meta {
  margin-left: auto;
  flex: none;
  font-size: 12px;
  color: var(--fg-dim);
}
/* 快照是对哪个包做的什么操作（系统记的事实，见 note），内容形如「安装 dshmarket@1.65.1」。
   独立一行（不并进上面那行）：那行已经摆了时间戳 / 已知良好 / 已损坏 / 用户命名 / 文件数
   五个元素，再挤一枚小徽章就只能当标签看；这条是用户真正在找的线索，值得自己一行。
   ⚠️ 窄区块（气泡窗）里整行要能换行：包名可长达几十字符，只靠省略号会让用户看不全 ——
   换行后版本号仍在，仍认得出是哪个包 */
.bak-note-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.5;
  min-width: 0;
}
/* 前置的「记录」标签：说明后面那句是系统记下来的事实（不是用户起的名字，那是上一行的 .bak-name） */
.bak-note-tag {
  flex: none;
  color: var(--fg-dim);
}
.bak-note {
  flex: 0 1 auto;
  min-width: 0;
  padding: 0 6px;
  border-radius: 4px;
  color: var(--fg);
  background: rgba(93, 156, 236, 0.18);
  /* 长包名 / URL 形态的 spec 靠**换行**而不是省略号收场：两个字符断点（任意位置可断 + 优先在
     `@` `/` `-` 后断）比一个 max-width 更能在窄区块里保住「看得见版本号」这件事 */
  overflow-wrap: anywhere;
  word-break: break-word;
}
/* 快照卡的回执：`.msg` 默认 margin-top: 10px，挨着列表时要收一点，
   并加背景块把它从「跟下面的条目长得一样」里拎出来 —— 这是结果，不是可点的行 */
.bak-flash {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(127, 127, 127, 0.08);
}
/* ===== dsh 插件市场（.mkt-*）=====
   列表可能一次渲染 80 条（见 App.vue 的 DSH_MARKET_PAGE），条目因此压到两行：
   head（名称 + 状态徽章 + 附加说明）与 foot（分类 + 包名 + 操作），描述单独一行。
   不给左色条：那套（.patch-item / .iso-item）表达的是「启用 / 禁用」，而这里的
   条目没有「行级开关」语义，色条会被读成状态。 */
.mkt-list {
  margin-top: 6px;
  /* 目录列表自带滚动区：一次渲染 80 条会把整页撑得很长，用户想翻到卡片下方的
     「待确认计划 / 说明」就得一路滚过上千行。这里给列表一个高度上限，**只有列表滚**，
     外层页面滚动条不受影响（overscroll-behavior 防止滑到列表两端时把滚动传给页面）。

     高度用 px 而非 vh：本卡下方还有「待确认计划」与说明，用 vh 时窗口一矮（或拉宽后
     行数变少）列表就会把底下的内容顶出可视区，滚动条还会一直伸到卡片圆角上。
     7 条 * 约 73px + 间距 ≈ 520px，是「一眼能比几条」与「不淹没卡片」的折中。
     min() 兜住矮窗口：可视高度不足时按 60vh 收缩，不会占满整屏。
     ⚠️ 矮窗口下 60vh 可能只剩 200 出头（连两条都放不下，滑块还短到抓不住），
     所以再配一条 min-height 保底 —— 宁可让页面自己滚，也要保证列表是个能用的滚动区。 */
  max-height: min(520px, 60vh);
  min-height: 260px;
  /* ⚠️ overflow 必须跟着 max-height 一起给：只有上限没有 overflow，浏览器不会生成
     滚动区，而是把 80 条**全部摊开**——卡片被撑破，列表后面的「再加载 / 下一张卡」
     会以「夹在条目中间」的样子出现（踩过一次）。 */
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 滚动条槽位开在列表**外面**（.mkt-scroll 上），而不是自己 padding-right 挤——
     挤出来的是内容的内边距，条目右边框仍会贴着滚动条，看上去像被压住。
     开在容器上则由浏览器在列表与卡片边缘之间插一条真正的空白槽，条目完整不被遮。 */
}
.mkt-scroll {
  scrollbar-gutter: stable;
}
/* 列表末尾的「再加载」条已改为页码分页（见 .mkt-pager）。这里保留 .iso-axis 的换行能力 */
/* 页码分页条：放在滚动区外，横向排列、居中。
   24 类分类 chip 行会很长，所以这行必须能换行 —— 否则窄窗口下「下一页」被挤出可视区 */
.mkt-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.mkt-page-btn {
  min-width: 30px;
  padding: 2px 8px;
  text-align: center;
}
/* 当前页：用主色描边 + 加粗，而不是实心填充 —— 实心块在深色主题下过重，
   与周围一圈淡边框按钮不成比例 */
.mkt-page-on {
  border-color: var(--accent, #4a90d9);
  color: var(--accent, #4a90d9);
  font-weight: 600;
}
/* 省略号占位：与页码等宽对齐，且不可点（不是按钮，没有 hover） */
.mkt-page-gap {
  min-width: 18px;
  text-align: center;
  color: var(--fg-dim);
  font-size: 12px;
  user-select: none;
}
/* 列表外的分页计数：右侧对齐、字号压小，只作补充不作正文 */
.mkt-rest {
  margin-top: 6px;
  text-align: right;
  font-size: 12px;
}
/* ── 安装/卸载进行中的进度区 ──
   目的只有一个：让「要等几分钟」这件事可见。所以不追求好看，追求**一眼看出在动**：
   转圈 + 秒表 + 实时输出尾部。 */
/* ── 待确认单据（安装 / 禁用 / 彻底删除） ──
   骨架用「左边一条竖向色带 + 淡背景」把这块从卡片里拎出来，表示「这是待你点头才动的事」，
   比原先两行 hint 更像一张单据。色带随动作变（默认主色、彻底删除走 --err），
   靠模板上的 `:class="msgCls({ err: ... })"` 拿到 `.err` 类，与 `.msg.err` 同一套变量。 */
.mkt-plan {
  position: relative;
  margin: 10px 0 0;
  padding: 10px 12px 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(127, 127, 127, 0.07);
  overflow: hidden;
}
.mkt-plan::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--accent, currentColor);
  opacity: 0.7;
}
.mkt-plan.err::before {
  background: var(--err);
  opacity: 0.9;
}
/* 头行：动作徽标 + 包名。徽标是「动词」，包名是「宾语」，两者并排让人一秒看懂要干什么 */
.mkt-plan-head {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mkt-plan-badge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.mkt-plan.err .mkt-plan-badge {
  background: rgba(220, 80, 80, 0.18);
  color: var(--err);
}
/* ⚠️ 包名用等宽：`dshmarket` / `@linxin666/dsh-web-all` 这类串里，等宽字体才分得清
   `-` 与 `_`、`/` 与 `\`，比例字体下极易看错 */
.mkt-plan-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  word-break: break-all;
}
.mkt-plan-sub {
  margin: 4px 0 0;
  font-size: 12px;
  opacity: 0.8;
}
.mkt-plan-note {
  opacity: 0.7;
}
/* 从哪一版到哪一版：用户点「装这一版」时最关心的一条，故加粗 + 稍大 */
.mkt-plan-sub b {
  font-size: 13px;
}
.mkt-plan-arrow {
  margin: 0 2px;
  opacity: 0.6;
}
/* 宿主给的 message：动词落在等宽字体上（命令原文就是命令原文），但正文保持比例字体，
   否则一整段中文说明用等宽看着很累 */
.mkt-plan-msg {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  /* ⚠️ 保留换行：message 里 `\n⚠️ 该来源靠 prepare 脚本构建…` 是独立一段，
     与主句挤在一条线上会被读丢 */
  white-space: pre-line;
}
/* ── 宿主不兼容警示条（单据卡里） ──
   ⚠️ 用独立的告警配色而不是复用 `.err` 红：这张单子里「不兼容」**不阻止**用户继续
   （下面有「仍要强制安装」），标成与「彻底删除」同款的红会让整件事看起来像已被否决。
   琥珀色表达的是「风险已知、你仍可继续」—— 与这条链路真正的语义对齐。 */
.mkt-plan-warn {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgba(214, 158, 46, 0.45);
  background: rgba(214, 158, 46, 0.1);
}
.mkt-plan-warn-head {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.mkt-plan-warn-body {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.85;
}
/* 「会改什么」清单：用户真正在权衡的是这个，故不用 hint 敷衍，给足行距 */
.mkt-plan-effects {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.78;
}
.mkt-plan-effects code {
  font-size: 11px;
}
/* 动作行贴在单据底部，与上面的说明拉开一拍 */
.mkt-plan-actions {
  margin-top: 10px;
}

.mkt-progress {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(127, 127, 127, 0.06);
}
.mkt-progress-head {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
/* 纯 CSS 转圈：不引 GIF / SVG（零依赖），靠 border 半透明 + 旋转即可。
   ⚠️ 本项目只跑 Chromium，animation 无需前缀 */
.mkt-spin {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 2px solid rgba(127, 127, 127, 0.35);
  border-top-color: currentColor;
  animation: mkt-spin 0.8s linear infinite;
}
@keyframes mkt-spin {
  to { transform: rotate(360deg); }
}
.mkt-progress-phase {
  margin: 6px 0 0;
}
/* 命令行：允许横向滚动而不是换行 —— 长路径换行会把进度区撑得很高 */
.mkt-progress-cmd {
  margin: 4px 0 0;
  overflow-x: auto;
  white-space: nowrap;
}
/* 「执行的命令」「实时输出」这两个小节标签：次要色 + 稍小字号，用来把标签与内容分开。
   ⚠️ 用块级 margin 而不是紧跟冒号，是为让 `<code>` / `<pre>` 各自成行（长命令换行时不挤在一起） */
.mkt-progress-k {
  display: block;
  margin: 8px 0 0;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.65;
}
/* 空态日志：与 `.mkt-progress-log` 同一块骨架，但内容是说明文字而非命令输出，
   故去掉等宽字体（中文说明用等宽很难看），并去掉背景让它更像提示而不是输出 */
.mkt-progress-log-empty {
  font-family: inherit;
  background: transparent;
  border: 1px dashed rgba(127, 127, 127, 0.35);
}
/* 实时输出尾部：等宽 + 限高 + 内部滚动。
   ⚠️ `overscroll-behavior: contain` 防止滚到底后把滚动传给外层页面 */
.mkt-progress-log {
  margin: 6px 0 0;
  max-height: 160px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.18);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.mkt-progress-log::-webkit-scrollbar {
  width: 8px;
}
.mkt-progress-log::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.4);
}
.mkt-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--card-border);
  background: rgba(127, 127, 127, 0.05);
}
.mkt-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mkt-name {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--fg);
  word-break: break-all;
  min-width: 0;
}
/* 下载量/星标这类附加说明：推到行尾、压暗、不换行。
   用 margin-left: auto 而不是复用 .patch-state —— 徽章样式语义是「状态」，
   把数据量画成徽章会和真正的「已装 / 已禁用」混淆。 */
.mkt-pin {
  margin-left: auto;
  flex: none;
  font-size: 11px;
  color: var(--fg-dim);
  white-space: nowrap;
}
/* 描述只给一行：全展开会把 80 条撑成上千行，列表内滚动区里逐条翻也很费劲 */
.mkt-desc {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mkt-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mkt-cat {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--fg-dim);
  background: rgba(127, 127, 127, 0.15);
}
.mkt-npm {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--fg-dim);
  word-break: break-all;
  min-width: 0;
}
/* 「v已装 → v目录」：等宽 + 略提亮。它比包名更值得看，但比按钮弱 ——
   用亮度而不是颜色区分，免得跟同一行的「可更新」绿标抢注意力 */
.mkt-ver {
  flex: none;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--fg);
  opacity: 0.75;
  white-space: nowrap;
}
/* ── 回源查「官方最新版」：卡片顶部一行（按钮 + 范围说明 + 汇总）──
   与卡片内其它「辅助动作」（刷新目录 / 测速）同一视觉层级，不抢主按钮的注意力 */
.mkt-latest-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 6px;
}
.mkt-latest-scope {
  font-size: 11px;
  color: var(--fg-dim);
}
/* 汇总结论：本次查到几个滞后。⚠️ 有滞后时用橙黄**加粗**——它是要被看见的警告，
   不是背景信息（与 .mkt-latest-row 的配色同源，见下） */
.mkt-latest-sum {
  font-size: 11px;
  color: var(--fg-dim);
}
/* 滞后清单：只列「官方版本 > 目录版本」的条目，每行带「装这一版」。
   整块用橙黄浅底 + 左边框，与普通条目拉开 —— 这是本次查询的**结论区**，
   混在列表里会被当成又一个普通条目 */
.mkt-latest-list {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-left: 3px solid rgba(184, 134, 11, 0.55);
  border-radius: 4px;
  background: rgba(184, 134, 11, 0.10);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mkt-latest-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mkt-latest-name {
  flex: none;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--fg);
  font-weight: 500;
}
.mkt-latest-ver {
  flex: none;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: #b8860b;
}
.mkt-latest-ver b {
  font-weight: 600;
}
/* 非 npm 来源条目（如 `dsh-web#packages/...`）的替位说明：这类条目查得出官方版本，
   却无法按 `包名@版本` 精确安装，故不给按钮、只留一句为什么。
   压暗 + 常规字重，避免被误当成可点的按钮 */
.mkt-latest-note {
  flex: none;
  font-size: 11px;
  color: var(--fg-dim);
}
/* 把右侧的操作按钮组推到行尾（对应 .mkt-foot 里 <span class="mkt-spacer">）。
   .btn-row button 的 flex: 1 不适用于这里 —— .mkt-foot 不是 .btn-row。 */
.mkt-spacer {
  flex: 1;
}
/* 目录来源选择区：一行一个单/复选，右侧留出测速毫秒的位置。
   刻意不用 .btn-row —— 那是按钮组（flex:1 拉伸），这里要的是纵向列表。 */
.mkt-src {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mkt-src-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.mkt-src-row > span:first-of-type {
  flex: 1;
  min-width: 0;
}
/* 测速结果：正常绿、测不通红。未测过时整个 span 不渲染（v-if），不会留空位 */
.mkt-src-ms {
  font-variant-numeric: tabular-nums;
  color: var(--ok, #2e7d32);
  font-size: 12px;
  white-space: nowrap;
}
.mkt-src-bad {
  color: var(--err, #c62828);
}
.mkt-src-btns {
  margin-top: 2px;
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
.btn-row {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  /* IP 表这排最多会到 4 个按钮（添加/保存/校验/清除），窄窗下换行而不是把文字挤成竖排 */
  flex-wrap: wrap;
}
.btn-row button {
  flex: 1;
}
/* 尺寸/配色来自 main.css 的 utils 基类（单一来源）。
   这里只保留与布局强耦合的两条：等分拉伸、以及 `.secondary` / `.danger`
   的**填充策略**差异 —— 参考卡片的主按钮是"无类名"，走 main.css 的
   `button { background: none var(--blue) }` 实心蓝，而 .secondary / .danger
   要把这个底清掉换成半透明，光靠 utils-secondary 的 background 盖不住
   （同一个 background 简写但全局 button 规则更具体），必须显式 background: none 兜底。
   顺带修掉一个既有 bug：`.danger` 原先只写了 background + color，没写 border
   → 走 border: none，于是危险按钮比旁边的次按钮**矮 2px**（少一圈 1px 描边）。 */
.btn-row button.secondary,
.btn-row button.danger {
  background: none;
}
/* ===== dsh 分组的按钮（dsh 主控 · 环境诊断 · 配置转储 · 全量导出 · 用量统计 · 插件开关 · 插件市场 · Codex 会话统计）=====
   这 8 张卡原先各写各的按钮：主控卡用 .btn-row（实心蓝主 + .secondary 灰蓝、font-size 13 / 无 padding），
   外围四张卡却把 .btn-row 当容器、里面清一色 .secondary（字号掉到按钮默认值），
   候选行的 .patch-btn 又是 2px/10px 的迷你尺寸，分组轴 .iso-axis-btn 更是自带一套胶囊边框 ——
   同一条动作链（刷新 → 预览 → 确认）上的按钮高矮胖瘦全不一样。

   **尺寸/配色那半已经上提到 main.css 的 utils 基类**（markup 挂了 .utils-btn + 对应档），
   这里只剩三件与 dsh 分组强耦合的事：flex 归属、胶囊圆角的例外、以及选中/危险的覆盖顺序。
   之所以不能连这些一起上提：flex 是布局耦合（.btn-row 要等分、行尾按钮要贴内容宽），
   而 `!important` 式的全局覆盖会误伤 .tab / .skin-cell 那些豁免件。

   注意配色不再靠本块给出：.utils-secondary / .utils-danger 的 (0,1,0) 与
   `.dsh-card .btn-row button` (0,2,1) 争时**后者赢**，所以这里只做覆盖、不做定义。 */
.dsh-card .btn-row button {
  flex: 1 1 auto;
}
/* 「运行详情」的次要动作行：全是文字按钮，贴内容宽即可 ——
   继承上面的 flex:1 会把「刷新状态 / 定位 dsh 目录 …」也拉成等宽块状，
   看着还是一条主按钮行，白降一级。.link-btn 的尺寸仍由基类给，这里只管排版。 */
.dsh-card .btn-row.row-link {
  margin-top: 6px;
}
.dsh-card .btn-row.row-link button {
  flex: none;
}
/* 「更新版本」行：版本下拉 + 更新按钮。下拉吃满剩余宽度（.field.row select 已给 flex:1），
   按钮贴内容宽；与上面的主操作行留一点间距，免得看成同一行。
   注意这条按钮不在 .btn-row 里，所以不受 `.btn-row button { flex:1 }` 影响，无需再覆盖 flex。 */
.dsh-card .dsh-update-row {
  margin-top: 8px;
}
/* .iso-axis-btn 是分组轴，豁免基准圆角（胶囊），只借 utils-btn 的尺寸；
   .dsh-card .iso-axis-btn 的 (0,2,0) 压过 .utils-btn 的 (0,1,0) */
.dsh-card .iso-axis-btn {
  border-radius: 999px;
}
.dsh-card .patch-btn,
.dsh-card .iso-axis-btn {
  flex: none;
}
/* 分组轴里「当前生效的那一轴」：.iso-axis-on 原规则靠背景+主色字表示选中，
   这里必须排在上面的规则之后 —— 同为 (0,2,0)，后写的覆盖背景色，
   否则选中态会被统一底色盖掉、三个分组按钮看起来一模一样。 */
.dsh-card .iso-axis-btn.iso-axis-on {
  border-color: var(--accent);
  background: rgba(83, 107, 169, 0.18);
  color: var(--accent);
}
/* 危险档（确认隔离 / 候选行禁用…）与 .btn-row button.danger 同色系。
   同上一节：`.dsh-card .btn-row button` 的 (0,2,1) 高于 .utils-danger 的 (0,1,0)，
   所以这里必须自己写全三色，否则实心蓝会漏出来。 */
.dsh-card .btn-row button.danger {
  background: rgba(224, 67, 63, 0.16);
  color: var(--err);
  border-color: rgba(224, 67, 63, 0.35);
}
.dsh-card .bak-confirm {
  border-color: #d9534f;
  color: #d9534f;
}
.msg {
  margin: 10px 0 0;
  font-size: 12px;
}
.msg.ok {
  color: var(--ok);
}
.msg.err {
  color: var(--err);
}
/* 有新版本时结果行可点，直接去插件市场更新 */
.msg.clickable {
  cursor: pointer;
  text-decoration: underline;
}
.link-btn {
  margin-top: 10px;
  padding: 0;
  border: none;
  background: none;
  color: var(--fg-dim);
  font-size: 12px;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.link-btn:hover {
  color: var(--fg);
}
/* 凭据获取教程（默认折叠） */
.field + .link-btn {
  margin-top: -4px;
}
.guide {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--input-bg);
  font-size: 12px;
  line-height: 1.6;
}
.guide-use {
  margin: 0;
  color: var(--fg);
}
.guide-use + .guide-use {
  margin-top: 6px;
}
/* 折叠面板里的首个标题紧贴顶部，不额外留白 */
.guide > .link-btn:first-child {
  margin-top: 0;
}
/* 嵌套说明（折叠面板内的教程）：比外层 .guide 再退一层，靠左侧色条区分层级，
   否则两层同色边框叠在一起会糊成一块 */
.guide2 {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  border-left: 2px solid var(--accent);
  background: var(--card-bg);
  font-size: 12px;
  line-height: 1.6;
}
/* 分组折叠（使用说明 / 故障排查）：组间留白并用分隔线隔开 */
.fold {
  margin-top: 12px;
}
.fold > .link-btn {
  margin-top: 0;
}
.fold + .fold {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
/* SMTP 已配置时的一行摘要：替代整块表单，让「提醒与通知」卡回到「只有开关」的清爽态。
   与 .link-btn 的 inline 变体配合 —— 摘要里嵌一个「重新配置」链接 */
.mail-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-dim);
}
/* 覆盖 .link-btn 的 margin-top / 下划线，避免在 flex 摘要里把行高撑开 */
.link-btn.inline {
  margin-top: 0;
  font-size: 12px;
}
/* 「已配置」徽标：用成功色描边而非实心填充 —— --card-bg 是半透明色，实心底上的字会糊 */
.ok-tag {
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--ok);
  color: var(--ok);
  font-size: 11px;
  line-height: 1.5;
}
.guide-steps {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--fg);
}
.guide-steps li {
  margin-bottom: 4px;
}
.guide-steps li:last-child {
  margin-bottom: 0;
}
.guide-note {
  margin: 8px 0 0;
  color: var(--fg-dim);
}
/* 保存位置 / 安全性 / 可靠性：与「注意」同色，但行距更紧凑 */
.guide-meta {
  margin: 6px 0 0;
  color: var(--fg-dim);
}
.guide code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.18);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  word-break: break-all;
}
.guide a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.err-block {
  margin-top: 10px;
}
.err-title {
  margin: 0;
  color: var(--err);
  font-size: 12px;
}
.err-box {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--err);
  background: rgba(224, 67, 63, 0.08);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
  user-select: text;
}
/* 卡片内的分组小标题：同一张卡里再分小节（如音效卡的「提醒音效」），
   用上边框把小节和上一组字段隔开，避免看起来还是一串平铺的字段 */
.group-title {
  margin: 18px 0 6px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-size: 13px;
  color: var(--fg-dim);
}
.group-title em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-faint);
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-faint);
  line-height: 1.6;
}
/* 需要用户动手的提示（如「dsh 正在运行」）：只用颜色提级，不换图标不换字号 ——
   这类提示是「建议」不是「错误」，做成红色警告框会与真失败（.msg.err）混淆 */
.hint-warn {
  color: var(--warn);
}
/* 本月汇总：紧跟在图表下面，数字提亮一档便于扫读 */
.month-sum {
  margin-top: 6px;
}
.month-sum strong {
  color: var(--fg);
  font-weight: 600;
}
/* 账本明细：折叠区 + 按日展开的异常变动 / 校准记录 */
.detail {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-toggle {
  /* 尺寸/配色走 utils 基类（markup 挂 .utils-btn .utils-outline）；这里只留 hover 提亮 */
  cursor: pointer;
}
.detail-toggle:hover {
  color: var(--fg);
  border-color: var(--accent);
}
.detail-search {
  flex: 1;
  min-width: 160px;
  padding: 4px 9px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--input-bg);
  color: var(--fg);
}
/* 类型筛选下拉：全局 select 是 width:100%，这里必须收回成自动宽度，
   否则它会把同一行的检索框挤成一条 */
.detail-kind {
  width: auto;
  flex: 0 0 auto;
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 8px;
}
.detail-sum {
  margin: 0;
}
.detail-day {
  margin-top: 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  overflow: hidden;
}
.detail-day-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}
.detail-day-row:hover {
  background: var(--input-bg);
}
.detail-caret {
  width: 10px;
  color: var(--fg-faint);
}
.detail-date {
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}
.detail-usage {
  color: var(--fg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.detail-tags {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.detail-tag {
  padding: 1px 7px;
  border-radius: 6px;
  font-size: 11px;
  background: rgba(224, 67, 63, 0.12);
  color: var(--err);
}
.detail-tag-mute {
  background: rgba(127, 127, 127, 0.16);
  color: var(--fg-faint);
}
.detail-entries {
  padding: 4px 10px 8px 28px;
  border-top: 1px solid var(--line);
  background: var(--input-bg);
  max-height: 200px;
  overflow: auto;
  /* 与 .log-box 同理：条目数随展开/收起变化，预留槽位避免右侧内容左右跳 */
  scrollbar-gutter: stable;
}
.detail-entry {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  color: var(--fg-dim);
}
.detail-time {
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
}
.hint a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
/* 测试连接结果 */
.test-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.test-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 11px;
  border-radius: 9px;
  border: 1px solid transparent;
  font-size: 12px;
  line-height: 1.5;
}
.test-item.ok {
  background: rgba(47, 162, 76, 0.1);
  border-color: rgba(47, 162, 76, 0.32);
}
.test-item.err {
  background: rgba(224, 67, 63, 0.1);
  border-color: rgba(224, 67, 63, 0.32);
}
.test-icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}
.test-item.ok .test-icon {
  background: var(--ok);
}
.test-item.err .test-icon {
  background: var(--err);
}
.test-body {
  flex: 1;
  min-width: 0;
}
.test-label {
  font-weight: 600;
}
.test-msg {
  color: var(--fg-dim);
  word-break: break-word;
}
.test-time {
  margin-top: 2px;
  font-size: 11px;
  color: var(--fg-faint);
  text-align: right;
}
/* 用量趋势 */
.adjust-note strong {
  color: var(--err);
  font-weight: 600;
}
.calibrate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.calibrate-label {
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.calibrate-input {
  width: 110px;
}
/* 台词库编辑框：一行一条，允许竖向拉伸方便一次看多条 */
.quote-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  resize: vertical;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg);
}
.quote-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(83, 107, 169, 0.18);
}
/* 随机台词组：一行一组，表头（类型 / 权重 / 字号 / 排序 / 删除）+ 台词框 */
.quote-group {
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 9px;
}
.quote-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
/* 行内下拉/输入框：全局规则是 width:100%，在表头里会把其余控件挤出去 */
.quote-group-head select,
.quote-group-head .num {
  width: auto;
  flex: 0 0 auto;
}
.quote-w {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--fg-dim);
}
/* 占位撑开，把排序 / 删除推到右侧 */
.quote-group-sp {
  flex: 1;
}
.quote-group-note {
  margin: 0;
}
.quote-group-tip {
  margin: 0 0 8px;
}
.sound-file {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 音效组里的分段明细行：左侧让出与槽位名等宽的空档（.label 的 72px + gap 10px），
   文件名与上一行的文件名对齐，一眼看出这几段属于同一个槽位 */
.sound-seg {
  margin-top: 4px;
  padding-left: 82px;
}
/* 素材的体积与导入时间：次要信息，跟在文件名后面，不参与换行挤压 */
.asset-meta {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
/* 形象画廊：缩略图网格。棋盘格底让透明 PNG 的透明区域能看出来 */
.skin-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.skin-cell {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background-color: #fff;
  background-image: linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%),
    linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%);
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
}
.skin-cell.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(83, 107, 169, 0.28);
}
.skin-cell-pick {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.skin-cell-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.skin-cell-none {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 11px;
  color: var(--fg-dim);
}
/* 操作条常显（只靠 hover 显隐在触控板上不好点），压在缩略图右上角 */
.skin-cell-ops {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  gap: 2px;
}
.skin-op {
  padding: 1px 4px;
  font-size: 10px;
  line-height: 1.4;
  border: none;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
}
.skin-op.danger {
  background: rgba(190, 60, 60, 0.8);
}
.skin-cell-tag {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  font-size: 10px;
  line-height: 1.5;
  text-align: center;
  background: rgba(83, 107, 169, 0.85);
  color: #fff;
}
.skin-cell-add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border-style: dashed;
  background-image: none;
  background-color: var(--input-bg);
  color: var(--fg-dim);
  cursor: pointer;
}
.skin-cell-add-plus {
  font-size: 18px;
  line-height: 1;
}
.skin-cell-add-txt {
  font-size: 11px;
}
.range-val {
  font-style: normal;
  font-size: 12px;
  color: var(--fg-dim);
  min-width: 38px;
  text-align: right;
}
/* 用量统计卡的口径指标格（今日 / 本月 / 累计 / 轮次 / 余额）。
   这五格原先各占一行 .field，值与单位（tokens、¥、轮）全挤在同一段文字里，
   各行的「大数」处在不同水平位置，扫读时无法横向比较。
   这里等分列：数字统一大一号、单位降到标签行、金额作次级说明，
   各格的基线因此对齐 —— 一眼比出今日与本月差几倍。
   列数用 auto-fit 而不是写死 4 或 5：余额格是 v-if 的（dsh-usage 没抓到余额时不存在），
   写死列数会让 4 格时右边空一列、或 5 格时挤成两行里只放一个。 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 6px;
  margin: 10px 0 8px;
}
.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--card-bg);
}
.stat-num {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--fg);
  /* 大数不换行：K/M 缩写后最长 5 字符，换行会让各格高度参差、基线错位 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-label {
  font-size: 11px;
  color: var(--fg-dim);
  /* 标签跟着 .stat-num 一起不换行 —— 一旦标签折成两行会把该格顶高、
     与同行其它格的价值行错位。宁可省略号（完整含义都在 title 里）。 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-sub {
  font-size: 10px;
  color: var(--fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 累计 token 的四个分项。与 .stat-grid 分开成一行：
   它们是读细账才看的口径，不该和「今日 / 本月」抢同一屏注意力。 */
.stat-break {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.stat-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 7px;
  background: var(--track);
  font-size: 12px;
  color: var(--fg);
}
.stat-chip em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-dim);
}
/* 窄窗（uTools 侧栏拖到最窄约 420px）下四格会挤到数字截断，
   降成两列让每格重新变宽；顺序仍是 今日 / 本月 / 累计 / 轮次，读序不变。 */
@media (max-width: 460px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
/* 各模型用量排行榜的样式**不在这里** —— 那几行由 UsageChart.vue 渲染，
   而本文件是 <style scoped>，选择器会被编译成 `.m-row[data-v-App哈希]`，
   只有 App.vue 模板里直接写的元素才带得上这个属性，子组件根节点以外的元素一律匹配不到。
   早先写在这一侧，规则在构建产物里存在但整段失效（模型行掉回纯文本堆叠）。
   现随组件放在 UsageChart.vue 自己的 scoped 块里。 */

/* 今日模型占比（令牌模式）：名称 / 条 / 百分比 / 金额四列对齐 */
.model-share {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
.model-share-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.model-share-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
.model-share-sub {
  margin: 0;
}
.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.model-name {
  flex: 0 0 130px;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-track {
  flex: 1;
  min-width: 0;
  height: 10px;
  background: var(--track);
  border-radius: 5px;
  overflow: hidden;
}
.model-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.3s ease;
}
.model-pct {
  flex: 0 0 34px;
  font-size: 11px;
  color: var(--fg-dim);
  text-align: right;
}
.model-cost {
  flex: 0 0 78px;
  font-size: 11px;
  color: var(--fg);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 额度（资源包 / 订阅）：进度条沿用趋势柱的蓝色系，用色阶区分是否接近用尽 */
.quota {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
/* 自定义单价（令牌模式）：与额度块同样用虚线分隔，三格单价并排一行 */
.price-box {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
.price-row {
  display: flex;
  gap: 10px;
  margin: 6px 0;
}
.price-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.price-name {
  font-size: 12px;
  color: var(--fg-dim);
}
.price-cell .num {
  width: 100%;
}
/* 「按模型覆盖」的模型名要填得下完整模型名（如 deepseek-v4-flash-vision-exp），比三格单价宽些 */
.price-cell-model {
  flex: 1.6;
}
/* 删除按钮与输入框底边对齐（price-cell 是列布局，标签在上、输入在下） */
.price-del {
  align-self: flex-end;
}
.quota-reset {
  margin-left: 8px;
}
.quota-line {
  font-size: 12px;
  color: var(--fg-dim);
}
.quota-track {
  margin-top: 6px;
  height: 10px;
  background: var(--track);
  border-radius: 5px;
  overflow: hidden;
}
.quota-fill {
  height: 100%;
  background: linear-gradient(90deg, #6f8ad6, var(--accent));
  border-radius: 5px;
  transition: width 0.3s ease;
}
.quota-fill-warn {
  background: linear-gradient(90deg, #e0a45c, #d9534f);
}
/* 多厂商模型：每行 = 主显示单选 / 名称 / 余额 / 说明 / 操作，展开后是本行的编辑表单 */
.mm-list {
  margin-top: 10px;
  padding-top: 4px;
  border-top: 1px dashed var(--line);
}
.mm-item {
  border-bottom: 1px dashed var(--line);
}
.mm-item:last-child {
  border-bottom: none;
}
.mm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
}
.mm-radio {
  flex: 0 0 auto;
  margin: 0;
  cursor: pointer;
}
.mm-name {
  flex: 0 0 150px;
  font-size: 12px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-val {
  flex: 0 0 96px;
  font-size: 12px;
  color: var(--fg);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.mm-val-err {
  color: var(--err);
}
.mm-sub {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-tag {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
}
/* 行内操作按钮：.link-btn 默认带上外边距与左对齐，这里按行内小按钮收一下 */
.mm-act {
  flex: 0 0 auto;
  margin-top: 0;
  font-size: 11px;
}
.mm-act:disabled {
  opacity: 0.45;
  cursor: default;
}
.mm-del {
  color: var(--err);
}
.mm-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 8px;
  font-size: 12px;
  color: var(--fg-dim);
}
.mm-form {
  padding: 2px 0 12px;
}
.mm-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
</style>
