<script lang="ts" setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AssetsApplyResult, AssetsExportResult, AssetsPreviewResult, BackupPreviewResult, BubbleMeta, CodexSummaryResult, CodexWindow, CodexWindows, DshUsageResult, LedgerDetailDay, LedgerDetailEntry, ModelUsageRow, SkinGallery, SkinMeta, SoundMeta, SoundRole, WhaleMailSecrets, WhaleModel, WhaleModelRow, WhaleModelTemplate, WhalePriceModel, WhaleServices, WhaleTokenPrice } from './types/services'
import SkinCropper from './components/SkinCropper.vue'
import SoundTrimmer from './components/SoundTrimmer.vue'
import FirstRunGuide from './components/FirstRunGuide.vue'
import AccelView from './views/AccelView.vue'

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
// 每张卡片用 v-if="activeTab === 'xxx'" 归到组里（不额外套容器层，源码顺序即组内顺序）。
// desc 是分组说明：凭据、备份这类「不常用但找不到会着急」的项靠它暴露位置。
const TABS = [
  { key: 'look', label: '外观', desc: '大小 · 形象与音色 · 文案' },
  { key: 'assets', label: '资源', desc: '素材总览 · 形象画廊 · 音效 · 素材包' },
  { key: 'usage', label: '用量', desc: '趋势与账本 · 模型余额 · 提醒与通知' },
  { key: 'window', label: '窗口', desc: '显隐 · 位置 · 透明度 · 穿透' },
  { key: 'data', label: '数据', desc: '凭据设置 · 清除数据 · 备份与恢复' },
  { key: 'help', label: '帮助', desc: '使用说明 · 故障排查 · 关于与更新' },
  { key: 'dev', label: '开发者', desc: 'DeepSeek Harness（dsh）· dsh 用量统计 · Codex 会话统计' },
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
  // 计时时长（秒）与到点要做什么：留言 + 休息档。与挂件菜单「计时」组同一份配置
  timerSec: 1500,
  timerNote: '',
  timerBreakMin: 5,
  enterMode: 'both',
  dshNodeDir: '',
  dshKeepAlive: false,
  dshRegistry: '',
  dshVersion: '',
  dshReinstall: false,
  dshNoOpen: true,
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
  keepAlive: false, url: '', port: 3080,
  nodeDir: '', nodeVersion: '', nodeAuto: true, found: true,
  error: '', lastCmd: '', log: '',
  registry: '', version: '', resolved: '', hasUpdate: false, runVersion: '', needsRestart: false, reinstall: false, prefix: '', source: '', globalVersion: '', globalDir: '', globalWritable: true,
  versions: { at: 0, latest: '', list: [] as string[] },
  external: false, externalPid: 0, externalName: '', portOther: '', webUrl: '', installed: '',
})
const dshFlash: Flash = useFlash()
const dshLogOpen = ref(false)
const dshLogEl = ref<HTMLElement | null>(null)
// 折叠区（默认收起，卡片更短）：诊断信息 / 高级选项 / 使用说明 / 故障排查
const dshFolds = reactive({ advanced: false, help: false, trouble: false, versions: false })
// 诊断折叠展开时顺手查一次「最新版本」：版本明细都是只读诊断，展开本身就是「我想核对版本」的信号，
// 此时查一次比让用户再点一次「查询可用版本」更省事。npm view 要联网、较慢，失败也不打断（dshQueryVersions 内部已兜底）
function dshToggleVersions() {
  dshFolds.versions = !dshFolds.versions
  if (dshFolds.versions && !(dsh.versions && dsh.versions.latest)) dshQueryVersions()
}
const dshConfirm = ref('') // '' | 'remove-plugin' | 'clean-npx'
const dshNow = ref(Date.now()) // 未就绪时的「已等待 x 秒」
let dshTickTimer = 0
function dshTickSync(running: boolean, ready: boolean) {
  const need = running && !ready
  if (need && !dshTickTimer) dshTickTimer = window.setInterval(() => { dshNow.value = Date.now() }, 1000)
  else if (!need && dshTickTimer) { window.clearInterval(dshTickTimer); dshTickTimer = 0 }
  if (need) dshNow.value = Date.now()
}
// 有新版本提示（查询过可用版本才有）
const dshLatestTip = computed(() => {
  if (!dsh.hasUpdate) return ''
  return '有新版本 ' + ((dsh.versions && dsh.versions.latest) || '') + '，点「更新」'
})
// 「实际使用」与「更新会装到的版本」是否一致。
// 注意这是**另一个维度**、不是「谁更新」：手动装过 alpha / 指定过版本时，
// npm latest 可能比在用的旧（如 latest=1.5.0-rc.2 而实际 1.6.0-alpha.2），
// 此时按 semver「没有更新」（状态行的 dshLatestTip 不会出现），但点「更新」仍会把你**替换**成 latest。
// 这句提示专门补这个盲区，避免用户以为「没提示就是已是最新」。
const dshVerMismatch = computed(() => {
  if (dsh.hasUpdate) return '' // 升级情形已由状态行的 dshLatestTip 覆盖，不重复
  const latest = (dsh.versions && dsh.versions.latest) || ''
  const cur = dsh.resolved || dsh.installed || ''
  if (!latest || !cur || latest === cur) return ''
  return '当前 ' + cur + ' 与 npm latest（' + latest + '）不同，点「更新」会替换为 ' + latest
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
  dsh.port = s.port || 3080
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
    // 宿主是异步探测端口的：顺手再读一次，才能拿到「外部 dsh 在不在」的真实结果
    if (deep) window.setTimeout(() => { try { dshApply(services.dshStatus?.()) } catch (err) {} }, 600)
  } catch (err) {}
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
const devFolds = reactive({ dshUsage: false, codex: false })
const devStatsLoaded = reactive({ dshUsage: false, codex: false })
function toggleDevCard(key: 'dshUsage' | 'codex') {
  devFolds[key] = !devFolds[key]
  if (!devFolds[key] || devStatsLoaded[key]) return
  devStatsLoaded[key] = true
  if (key === 'dshUsage') dshUsageRefresh()
  else codexRefresh()
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
    // 结束外部 dsh 要等 700ms 复查端口；更新要重新下载（首次安装约几十秒），所以多刷新几次
    const delays = action === 'restart' ? [2500, 6000] : action === 'update' ? [5000, 20000, 45000, 90000] : action === 'stop' ? [900, 2400] : [800]
    for (const ms of delays) window.setTimeout(dshStatus, ms)
  } catch (err: any) {
    dshFlash.err = true
    dshFlash.msg = '操作失败：' + String(err?.message || err)
  }
}
// 清空内存日志
function dshClearLog() {
  try {
    dshApply(services.dshClearLog?.())
    dshFlash.err = false
    dshFlash.msg = '已清空日志'
  } catch (err: any) {
    dshFlash.err = true
    dshFlash.msg = '清空失败：' + String(err?.message || err)
  }
}
// 维护类操作：点第一次变确认，点第二次执行（避免误删）
function dshMaintain(kind: 'remove-plugin' | 'clean-npx') {
  if (dshConfirm.value !== kind) { dshConfirm.value = kind; dshFlash.msg = ''; return }
  dshConfirm.value = ''
  try {
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
function dshCopyPath(p: string, label: string) {
  if (!p) { dshFlash.err = true; dshFlash.msg = '暂无' + label; return }
  const ok = services.copyText?.(p)
  dshFlash.err = !ok
  dshFlash.msg = ok ? '已复制' + label + '：' + p : '复制失败，请手动选中复制。'
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
  const url = dsh.webUrl || dsh.url
  if (!url) {
    dshFlash.err = true
    dshFlash.msg = '暂无地址'
    return
  }
  const ok = services.copyText?.(url)
  dshFlash.err = !ok
  dshFlash.msg = ok ? '已复制页面地址：' + url : '复制失败，请手动选中上面的地址复制。'
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
    window.setTimeout(dshStatus, 400)
  } catch (err: any) {
    dshFlash.err = true
    dshFlash.msg = '选择失败：' + String(err?.message || err)
  }
}
function dshAutoDir() {
  patchCfg({ dshNodeDir: '' })
  dshFlash.msg = '已改为自动探测（PATH → 常见安装位置）'
  dshFlash.err = false
  window.setTimeout(dshStatus, 400)
}
function dshCopyLog() {
  const text = dsh.log || ''
  if (!text) {
    dshFlash.err = true
    dshFlash.msg = '暂无日志：启动/更新 dsh 后这里会显示它的输出。'
    return
  }
  const ok = services.copyText?.(text)
  dshFlash.err = !ok
  dshFlash.msg = ok ? '已复制 dsh 日志（' + text.split('\n').length + ' 行）' : '复制失败，请手动选中日志复制。'
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
    if (!dsh.ready) {
      const wait = dsh.startedAt ? Math.max(0, Math.round((dshNow.value - dsh.startedAt) / 1000)) : 0
      return '启动中…（3080 未就绪' + (wait > 3 ? '，已等待 ' + wait + ' 秒' : '，首次安装需要下载') + '）'
    }
    const sec = dsh.startedAt && dsh.readyAt ? ((dsh.readyAt - dsh.startedAt) / 1000).toFixed(1) + 's' : ''
    return '运行中 · pid ' + dsh.pid + (sec ? '（就绪用时 ' + sec + '）' : '') +
      (dsh.needsRestart ? ' · 已更新到 ' + (dsh.resolved || '') + '，点「重启」生效' : '')
  }
  if (dsh.external) return '外部 dsh · pid ' + dsh.externalPid
  if (dsh.portOther) return '端口 3080 被 ' + dsh.portOther + ' 占用'
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
  if (cfg.dshVersion) addMark(cfg.dshVersion, '已选')
  if (latest) addMark(latest, 'latest 标签')

  const out: Array<{ v: string; label: string }> = [{ v: '', label: '自动（安装/更新时取 latest）' }]
  const seen: Record<string, boolean> = { '': true }
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
// 轮询是异步的，等结果期间先挂个「正在查询」。查到了要主动清掉：
// dshStatus 是通用轮询入口、成功时不碰 dshFlash，若不在这里清，提示会一直挂着到下次操作。
let dshQueryDone = 0 // 本次查询的令牌，防止上一轮的兜底定时器清掉下一轮刚设的提示
function dshQueryVersions() {
  try {
    services.dshListVersions?.()
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
        dshFlash.err = true
        dshFlash.msg = '查询超时：未取到可用版本，请检查网络或 npm 注册源后重试。'
        dshQueryDone++
      }
    }
    const t0 = Date.now()
    for (const ms of [2000, 5000, 9000]) window.setTimeout(probe, ms)
    window.setTimeout(probe, 12000)
  } catch (err: any) {
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
const codexFolds = reactive({ models: false, help: false })
// token 数按万/亿缩写，避免长串数字撑破布局
function fmtTokens(n?: number) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万'
  return String(v)
}
// 图表档位：宿主一次给 31 天（days31，索引 0 是今天），切档只改前端切片、不重扫
const codexRange = ref(7)
const codexDays = computed(() => ((codex.value && codex.value.days31) || []).slice(-codexRange.value))
// 30 天档标签抽稀：每 5 天一个，避免糊成一片
const codexLabelEvery = computed(() => (codexRange.value >= 30 ? 5 : 1))
const codexDayMax = computed(() => {
  let m = 0
  for (const d of codexDays.value) m = Math.max(m, Number(d.tokens) || 0)
  return m
})
const codexModels = computed(() => {
  const bm = (codex.value && codex.value.byModel) || {}
  return Object.keys(bm)
    .map((k) => ({ name: k, ...bm[k] }))
    .sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0))
})
// 柱高百分比：最大值为满格（100%），最小留 2% 让「有量但极少」也看得见
function codexBarHeight(tokens?: number) {
  const max = codexDayMax.value
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
const dshUsageFolds = reactive({ models: false, help: false })
// 图表档位：宿主一次给 31 天（days31，索引 0 是今天），切档只改前端切片、不重扫
const DSH_USAGE_RANGES = [7, 14, 30] as const
const dshUsageRange = ref(7)
const dshUsageDays = computed(() => ((dshUsage.value && dshUsage.value.days31) || []).slice(-dshUsageRange.value))
// 30 天档标签抽稀：每 5 天一个，避免糊成一片
const dshUsageLabelEvery = computed(() => (dshUsageRange.value >= 30 ? 5 : 1))
// 当前档内最大值：用来算柱状条高度（全为 0 时避免除零）
const dshUsageDayMax = computed(() => {
  let m = 0
  for (const d of dshUsageDays.value) m = Math.max(m, Number(d.tokens) || 0)
  return m
})
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
// 柱高百分比：最大值为满格（100%），最小留 2% 让「有量但极少」也看得见
function dshUsageBarHeight(tokens?: number) {
  const max = dshUsageDayMax.value
  if (!max) return '0%'
  return Math.max(2, Math.round(((Number(tokens) || 0) / max) * 100)) + '%'
}
// 花费按账本原币种显示；极小金额多留几位小数，免得非零却显示成 0.00
function fmtDshCost(v?: number) {
  const n = Number(v) || 0
  const cur = (dshUsage.value && dshUsage.value.costCurrency) || 'CNY'
  return (cur === 'CNY' ? '¥ ' : '') + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2))
}
// dsh-usage 自己抓的余额快照：与挂件轮询的余额互为印证，只作对照展示
function fmtDshBalance() {
  const b = dshUsage.value && dshUsage.value.balance
  if (!b) return ''
  const cur = b.currency === 'CNY' ? '¥ ' : b.currency === 'USD' ? '$' : ''
  const at = b.at ? new Date(b.at).toLocaleString('zh-CN', { hour12: false }) : ''
  return cur + Number(b.amount || 0).toFixed(2) + (at ? ' · ' + at : '')
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
  cfg.timerSec = typeof c.timerSec === 'number' && c.timerSec > 0 ? Math.round(c.timerSec) : 1500
  cfg.timerNote = typeof c.timerNote === 'string' ? c.timerNote : ''
  cfg.timerBreakMin = typeof c.timerBreakMin === 'number' ? c.timerBreakMin : 5
  syncTimerHms()
  cfg.enterMode = c.enterMode === 'widget' || c.enterMode === 'settings' ? c.enterMode : 'both'
  cfg.dshNodeDir = typeof c.dshNodeDir === 'string' ? c.dshNodeDir : ''
  cfg.dshKeepAlive = c.dshKeepAlive === true
  cfg.dshRegistry = typeof c.dshRegistry === 'string' ? c.dshRegistry : ''
  cfg.dshVersion = typeof c.dshVersion === 'string' ? c.dshVersion : ''
  cfg.dshReinstall = c.dshReinstall === true
  cfg.dshNoOpen = c.dshNoOpen !== false
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
    refreshHistory()
    refreshTodayModels()
    loadModelTemplates()
    reloadModels()
    refreshSounds()
    refreshSkin()
    refreshBubbles()
    // dsh 状态不在挂载时轮询：等切到「开发者」Tab 再启（见 watch(activeTab)）；
    // 任务栏状态所有 Tab 都可能看，保持常轮
    taskbarPolling.start()
    // GitHub 加速（hosts 实际状态）不在这里预读：它已抽到 AccelView，
    // 由该组件在切到帮助 Tab 时自行刷新，父级无需代劳
  } catch (err) {}
  window.addEventListener('focus', onWindowActive)
  document.addEventListener('visibilitychange', onWindowActive)
  if (cfg.updateCheckOn) doCheckUpdate(false)
  // 首次运行引导：放在最后弹，避免与前面的初始化抢渲染。
  // 判据在宿主侧（guideDone 未置位 + 没填 API Key），老用户升级上来不会被打扰
  try {
    if (services.needFirstRunGuide?.()) {
      guideReopen.value = false
      showGuide.value = true
    }
  } catch (err) {}
})

onUnmounted(() => {
  try { unsubConfig?.() } catch (err) {}
  dshPolling.stop()
  dshTickSync(false, true)
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
        <button class="link-btn" @click="toolOpen.credentials = !toolOpen.credentials">
          {{ toolOpen.credentials ? '收起凭据设置' : 'DeepSeek 凭据（API Key / 平台 Token）' }}
        </button>
        <div v-if="toolOpen.credentials" class="guide">
          <label class="field">
            <span class="label">API Key</span>
            <input v-model="secrets.apiKey" type="password" placeholder="sk-..." autocomplete="off" />
          </label>
          <button class="link-btn" @click="guides.apiKey = !guides.apiKey">
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
          <button class="link-btn" @click="guides.token = !guides.token">
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
            <button @click="saveSecrets">保存凭据（加密存储）</button>
            <button class="secondary" :disabled="testing || (!secrets.apiKey.trim() && !secrets.platformToken.trim())" @click="testKey">
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
        <button class="export-btn" type="button" title="随机换一个内置形象" @click="doRandomSkin()">随机</button>
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
        <button class="link-btn" @click="lookFolds.bubble = !lookFolds.bubble">{{ lookFolds.bubble ? '收起气泡与文案' : '气泡与文案（主题 · 峰谷 · 报时 · 点按播放）' }}</button>
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
        <button class="link-btn" @click="lookFolds.sound = !lookFolds.sound">{{ lookFolds.sound ? '收起音效' : '音效（开关 · 音色 · 音量）' }}</button>
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
          <button class="export-btn" type="button" :disabled="!unusedCount" @click="doClearUnused()">
            清除未使用{{ unusedCount ? `（${unusedCount}）` : '' }}
          </button>
          <button class="export-btn" type="button" :disabled="!hasAssets" @click="doClearAssets()">清除全部素材</button>
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
        <button class="link-btn" @click="assetsFold.open = !assetsFold.open">
          {{ assetsFold.open ? '收起素材包' : '素材包（换机器一次带走）' }}
        </button>
        <div v-if="assetsFold.open" class="guide">
          <p class="guide-use">
            <strong>导出：</strong>把导入的形象、气泡图与音效打包成一个 <code>.whaleassets</code> 文件。
            <strong>导入：</strong>形象与气泡图是<strong>补充</strong>（每张都新增，不动现有画廊与在用的那张），
            音效按<strong>槽位覆盖</strong>（同名槽位换成本包里的那段）。内置形象与内置音色不在包里，换机器后本来就有。
          </p>
          <div class="btn-row">
            <button class="secondary" :disabled="assetsBusy || !hasAssets" @click="doExportAssets">导出素材包…</button>
            <button class="secondary" :disabled="assetsBusy" @click="doPickAssets">导入素材包…</button>
            <button v-if="assetsPack" class="secondary" @click="doCancelAssets">取消导入</button>
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
              <button class="danger" :disabled="assetsBusy || !assetsAnyItem" @click="doApplyAssets">
                {{ assetsConfirm ? '确认导入？同名音效槽位会被覆盖' : '导入选中项' }}
              </button>
              <button v-if="assetsConfirm" class="secondary" @click="assetsConfirm = false">取消</button>
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
          <button class="export-btn" type="button" @click="doImportSkin()">导入图片…</button>
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
          <button class="export-btn" type="button" @click="doImportBubble()">导入图片…</button>
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
          <button class="export-btn" type="button" @click="doImportSound(r)">
            {{ soundMetaOf(r).length ? '追加' : '导入' }}
          </button>
        </div>
        <div class="field row sound-seg" v-for="(it, i) in soundMetaOf(r)" :key="it.file">
          <span class="sound-file" :title="it.name">{{ i + 1 }}. {{ it.name }}</span>
          <span class="asset-meta">{{ assetSize(it) }} · {{ assetAt(it) }}</span>
          <button class="export-btn" type="button" @click="doPreviewSound(r, i)">试听</button>
          <button class="export-btn" type="button" @click="doRemoveSound(r, it.file)">删除</button>
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
        <button class="link-btn" @click="assetFolds.builtin = !assetFolds.builtin">{{ assetFolds.builtin ? '收起内置资源' : '内置资源（随插件附带，只作对照）' }}</button>
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
            <button class="export-btn" type="button" @click="doPreviewBuiltin(g.press)">试听按压</button>
            <button class="export-btn" type="button" @click="doPreviewBuiltin(g.release)">试听释放</button>
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
          <button class="export-btn" type="button" @click="saveQuotes()">保存</button>
          <button class="export-btn" :class="{ danger: quoteResetConfirm }" type="button" @click="resetQuotes()">
            {{ quoteResetConfirm ? '确认恢复默认？' : '恢复默认' }}
          </button>
          <button v-if="quoteResetConfirm" class="export-btn" type="button" @click="quoteResetConfirm = false">取消</button>
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
            <button class="export-btn" type="button" :disabled="i === 0" title="上移" @click="quoteGroupMove(i, -1)">↑</button>
            <button class="export-btn" type="button" :disabled="i === cfg.quotes.groups.length - 1" title="下移" @click="quoteGroupMove(i, 1)">↓</button>
            <button class="export-btn" type="button" @click="quoteGroupDel(i)">删除</button>
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
        <button class="export-btn" type="button" :disabled="cfg.quotes.groups.length >= QUOTE_GROUP_MAX"
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
        <button class="link-btn" @click="quoteFolds.open = !quoteFolds.open">
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
          <div class="range-tabs">
            <button v-for="r in usageRangeTabs" :key="r" class="range-tab"
                    :class="{ 'range-tab-on': usageRange === r }" @click="setUsageRange(r)">{{ r }} 天</button>
          </div>
          <button class="export-btn" @click="importUsageCsv">导入 CSV</button>
          <button class="export-btn" :disabled="historyMax <= 0" @click="exportUsageCsv">导出 CSV</button>
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
          <button class="export-btn price-del" type="button" title="删除这一条"
                  @click="removePriceModel(i)">删</button>
        </div>
        <button class="export-btn" type="button"
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
          <button class="detail-toggle" @click="toggleDetail">
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
        <button class="export-btn" :disabled="calibrateInputEmpty" @click="calibrateToday">校准</button>
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
        <button class="export-btn" type="button" :disabled="notifyTesting" @click="testNotify()">
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
          <button class="link-btn inline" type="button" @click="toggleMailFold()">重新配置</button>
        </p>
        <button v-else class="link-btn" type="button" @click="toggleMailFold()">
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
            <button class="export-btn" type="button" @click="saveMailSettings()">保存邮件设置</button>
            <button class="export-btn" type="button" :disabled="mailTesting" @click="testMail()">
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
        <button class="link-btn" @click="alertFolds.open = !alertFolds.open">
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
            <button class="export-btn" type="button" @click="saveAlerts()">保存</button>
            <button class="export-btn" :class="{ danger: alertResetConfirm }" type="button" @click="resetAlerts()">
              {{ alertResetConfirm ? '确认恢复默认？' : '恢复默认' }}
            </button>
            <button v-if="alertResetConfirm" class="export-btn" type="button" @click="alertResetConfirm = false">取消</button>
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
          <button class="export-btn" :disabled="modelsRefreshing" @click="refreshModelRows()">
            {{ modelsRefreshing ? '刷新中…' : '刷新全部' }}
          </button>
          <button class="export-btn" :disabled="modelConfigs.length >= modelMax" @click="openNewModel">添加模型</button>
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
              <button class="link-btn mm-act" @click="openModelRow(m.id)">{{ modelOpen === m.id ? '收起' : '设置' }}</button>
              <button class="link-btn mm-act" :disabled="modelsRefreshing" @click="refreshModelRows([m.id])">刷新</button>
              <button class="link-btn mm-act mm-del"
                      @click="modelDelConfirm = modelDelConfirm === m.id ? '' : m.id">删除</button>
            </template>
          </div>
          <div v-if="m.id !== NEW_MODEL_ROW && modelDelConfirm === m.id" class="mm-confirm">
            <span>删除「{{ m.name }}」？它的密钥与余额记录会一并清除。</span>
            <button class="export-btn" @click="removeModelRow(m.id)">确认删除</button>
            <button class="link-btn mm-act" @click="modelDelConfirm = ''">取消</button>
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
            <button v-if="modelForm.kind !== 'codex'" class="link-btn" @click="modelAdv[modelForm.id] = !modelAdv[modelForm.id]">
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
              <button @click="saveModelForm">保存</button>
              <button class="secondary" :disabled="modelTesting === modelForm.id" @click="testModelForm">
                {{ modelTesting === modelForm.id ? '测试中…' : '测试连接' }}
              </button>
              <button class="secondary" @click="closeModelForm">取消</button>
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
        <button @click="showWidget">显示挂件</button>
        <button class="secondary" @click="hideWidget">隐藏挂件</button>
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
        <button class="secondary" @click="copyHotkeyCmd('切换鼠标穿透')">复制「穿透」指令名</button>
        <button class="secondary" @click="addHotkey('切换鼠标穿透')">新增「穿透」快捷键</button>
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
        <button class="secondary" @click="resetWidgetPos">复位窗口位置</button>
      </div>
      <p class="hint">把挂件挪回默认位置（右下角、紧贴边缘）——换显示器、改分辨率或拖出屏幕后用。</p>
      <p v-if="widgetFlash.msg" class="msg" :class="msgCls(widgetFlash)">{{ widgetFlash.msg }}</p>
    </section>

    <!-- [帮助] 使用帮助：使用说明 / 快捷键绑定 / 故障排查。
         这些原先都堆在「挂件窗口」卡尾（一次性配置 + 排查 + 说明），日常要调的窗口项被埋在一堆说明下面 -->
    <section v-if="activeTab === 'help'" class="card">
      <h2>使用帮助</h2>
      <p class="hint">给「显示/隐藏挂件」绑定一个全局快捷键（想给「鼠标穿透」也绑一个，见「窗口」组）。</p>
      <div class="btn-row">
        <button class="secondary" @click="copyHotkeyCmd()">复制指令名</button>
        <button class="secondary" @click="addHotkey()">新增快捷键</button>
      </div>
      <!-- 新手引导入口：首次引导只弹一次（guideDone），之后从帮助 Tab 重开。
           与「使用说明」「故障排查」同为折叠块、同一视觉语言，不额外占版面 -->
      <div class="fold">
        <button class="link-btn" @click="onGuideReopen()">新手引导（填 DeepSeek 凭据）</button>
      </div>
      <div class="fold">
        <button class="link-btn" @click="widgetFolds.help = !widgetFolds.help">{{ widgetFolds.help ? '收起使用说明' : '使用说明' }}</button>
        <div v-if="widgetFolds.help" class="guide">
          <p class="guide-use"><strong>进入插件时：</strong>选含挂件的模式后，挂件出现时会抢走焦点、本设置窗口自动收起；改设置请点挂件右上角菜单（或右键）→「打开设置」唤回本窗口。</p>
          <p class="guide-use"><strong>挂件操作：</strong>可拖拽到屏幕四边吸附（吸附区宽度与开关见「挂件窗口」卡片），鲸鱼始终朝屏幕内侧；点击鲸鱼刷新余额，悬停后点右上角菜单调整设置。</p>
          <p class="guide-use"><strong>快捷键：</strong>按 Ctrl+, 打开 uTools 设置 → 全局功能 → 新增 → 指令填「显示/隐藏挂件」→ 按下组合键。可点上方「复制指令名」快速复制。想给「鼠标穿透」也绑一个，指令名填「切换鼠标穿透」。</p>
          <p class="guide-use"><strong>常驻：</strong>退出到后台挂件保留；关闭 Ctrl+D 分离窗口会直接结束插件运行、挂件消失，分离后请用「最小化」；重进插件会自动重建，配置不丢。</p>
        </div>
      </div>
      <div v-if="diagReady" class="fold">
        <button class="link-btn" @click="widgetFolds.trouble = !widgetFolds.trouble">{{ widgetFolds.trouble ? '收起故障排查' : '故障排查' }}</button>
        <div v-if="widgetFolds.trouble" class="guide">
          <p class="guide-use">挂件消失或显示异常时，可复制诊断日志（%TEMP%\whale-debug.log）或用系统程序打开日志文件。</p>
          <div class="btn-row">
            <button class="secondary" @click="copyDebugLog">复制诊断日志</button>
            <button class="secondary" @click="openLogFile">打开日志文件</button>
          </div>
          <p v-if="diagFlash.msg" class="msg" :class="msgCls(diagFlash)">{{ diagFlash.msg }}</p>
        </div>
      </div>
      <div v-if="errDetail" class="err-block">
        <p class="err-title">挂件窗口创建失败</p>
        <pre class="err-box">{{ errDetail }}</pre>
        <div class="btn-row">
          <button class="secondary" @click="copyWidgetError">复制错误信息</button>
          <button class="secondary" @click="checkWidgetError()">重新检查</button>
        </div>
      </div>
      <button v-else class="link-btn" @click="checkWidgetError()">挂件异常？查看错误详情</button>
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
        <button class="danger" :disabled="!anyClearItem" @click="clearSelectedData()">
          {{ clearConfirm ? '确认清除选中数据？不可恢复' : '清除选中数据' }}
        </button>
        <button v-if="clearConfirm" class="secondary" @click="clearConfirm = false">取消</button>
      </div>
      <p v-if="clearConfirm" class="hint">将清除：{{ clearItemNames || '（未选中任何项）' }}。此操作不可撤销。</p>
      <p v-if="dataFlash.msg" class="msg" :class="msgCls(dataFlash)">{{ dataFlash.msg }}</p>

      <div class="fold">
        <button class="link-btn" @click="backupFolds.open = !backupFolds.open">{{ backupFolds.open ? '收起备份与恢复' : '备份与恢复' }}</button>
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
            <button class="secondary" :disabled="backupBusy" @click="backupExport">导出备份…</button>
            <button class="secondary" :disabled="backupBusy" @click="backupPick">导入备份…</button>
            <button v-if="backupPreview" class="secondary" @click="backupCancelPick">取消导入</button>
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
              <button class="danger" :disabled="backupBusy || !backupAnyItem" @click="backupApply">
                {{ backupConfirm ? '确认覆盖写入？不可撤销' : '恢复选中项' }}
              </button>
              <button v-if="backupConfirm" class="secondary" @click="backupConfirm = false">取消</button>
            </div>
          </div>
          <p v-if="backupFlash.msg" class="msg" :class="msgCls(backupFlash)">{{ backupFlash.msg }}</p>
        </div>
      </div>
    </section>

    <!-- [开发者] DeepSeek Harness（dsh） -->
    <section v-if="activeTab === 'dev'" class="card">
      <h2>DeepSeek Harness（dsh）</h2>
      <p class="hint">在挂件菜单「dsh」分组或本卡片里 启动 / 重启 / 结束 / 更新 dsh 并打开它的 Web UI（默认 <code>http://127.0.0.1:3080</code>）。<strong>优先用你已全局安装的那份</strong>（零重复占用、终端与插件同一版本），没有才装到插件数据目录。</p>

      <label class="field row">
        <span class="label">状态</span>
        <span class="ver">{{ dshStateText }}<span v-if="dsh.nodeVersion"> · Node {{ dsh.nodeVersion }}</span><span v-if="dshLatestTip" class="tag tag-new">{{ dshLatestTip }}</span></span>
      </label>
      <div class="btn-row">
        <button :disabled="dsh.running || dsh.external || !!dsh.portOther || dshBusy" @click="dshDo('start')">启动</button>
        <button class="secondary" :disabled="(!dsh.running && !dsh.external) || dshBusy" @click="dshDo('restart')">重启</button>
        <button class="secondary" :disabled="(!dsh.running && !dsh.external) || dshBusy" @click="dshDo('stop')">结束</button>
        <!-- 既无全局也无插件安装时实际走的是安装流程，按钮文案别再写「更新」误导 -->
        <button class="secondary" :disabled="dshBusy" @click="dshDo('update')">{{ dsh.resolved || dsh.globalVersion ? '更新' : '安装' }}</button>
        <button class="secondary" @click="dshOpenPage">打开 Web UI</button>
      </div>
      <p v-if="dsh.external" class="hint">3080 上检测到由<strong>别的终端</strong>启动的 dsh（pid {{ dsh.externalPid }}）：「结束」会结束它，「重启」会结束它并按当前版本重新启动。</p>
      <p v-else-if="dsh.portOther" class="hint">3080 被 {{ dsh.portOther }} 占用（不是 dsh）。为避免误杀，插件不会结束它。</p>

      <!-- 诊断信息（只读）：版本对照 / 最近命令 / 页面地址 / 日志，展开时自动查一次最新版本 -->
      <div class="fold">
        <button class="link-btn" @click="dshToggleVersions">
          {{ dshFolds.versions ? '收起诊断信息' : '诊断信息（版本 / 命令 / 地址 / 日志）' }}
        </button>
        <div v-if="dshFolds.versions" class="guide">
          <label class="field row">
            <span class="label">实际使用</span>
            <span class="ver">{{ dsh.resolved || '未安装' }}<span v-if="dsh.source" class="tag">{{ dsh.source === 'global' ? '全局' : '插件目录' }}</span></span>
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
            <span class="ver">{{ (dsh.versions && dsh.versions.latest) || '查询中…' }}<span v-if="dsh.versions && dsh.versions.latest" class="tag">点「更新」会装到这个版本</span></span>
          </label>
          <label class="field row">
            <span class="label">最近命令</span>
            <span class="cmdline">{{ dsh.lastCmd || '（还没执行过）' }}</span>
          </label>
          <label class="field row">
            <span class="label">页面地址</span>
            <span class="cmdline">{{ dsh.webUrl || (dsh.url + '（未捕获 token，dsh 启动完成后会自动获取）') }}</span>
          </label>
          <p v-if="dshVerMismatch" class="hint">{{ dshVerMismatch }}</p>
          <div class="btn-row">
            <button class="secondary" :disabled="dsh.busy === 'versions'" @click="dshQueryVersions">
              {{ dsh.busy === 'versions' ? '查询中…' : '查询可用版本' }}
            </button>
            <button class="secondary" @click="dshStatus(true)">刷新状态</button>
            <button v-if="dsh.globalDir" class="secondary" @click="dshCopyPath(dsh.globalDir, '全局路径')">复制全局路径</button>
            <button v-if="dsh.installed" class="secondary" @click="dshCopyPath(dsh.prefix, '插件路径')">复制插件路径</button>
            <button class="secondary" @click="dshCopyUrl">复制地址</button>
            <button class="secondary" @click="dshLogOpen = !dshLogOpen">{{ dshLogOpen ? '收起日志' : '查看日志' }}</button>
            <button v-if="dshLogOpen" class="secondary" @click="dshClearLog">清空日志</button>
            <button v-if="dshLogOpen" class="secondary" @click="dshCopyLog">复制日志</button>
          </div>
          <pre v-if="dshLogOpen" ref="dshLogEl" class="log-box">{{ dsh.log || '（暂无日志：启动或更新 dsh 后再看）' }}</pre>
        </div>
      </div>

      <p v-if="dsh.error && !dshLogOpen" class="msg err">{{ dsh.error }}</p>
      <p v-if="dshFlash.msg" class="msg" :class="msgCls(dshFlash)">{{ dshFlash.msg }}</p>

      <div class="fold">
        <button class="link-btn" @click="dshFolds.advanced = !dshFolds.advanced">{{ dshFolds.advanced ? '收起高级选项' : '高级选项（版本 / 注册源 / Node 目录 / 行为）' }}</button>
        <div v-if="dshFolds.advanced" class="guide">
          <label class="field row">
            <span class="label">dsh 版本</span>
            <select v-model="cfg.dshVersion" @change="patchCfg({ dshVersion: cfg.dshVersion })">
              <option v-for="o in dshVersionOptions" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </label>
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
            <button class="secondary" @click="dshPickDir">选择目录</button>
            <button v-if="cfg.dshNodeDir" class="secondary" @click="dshAutoDir">改为自动探测</button>
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
        <button class="link-btn" @click="dshFolds.help = !dshFolds.help">{{ dshFolds.help ? '收起使用说明' : '使用说明' }}</button>
        <div v-if="dshFolds.help" class="guide">
          <p class="guide-use"><strong>启动：</strong>直接 <code>node &lt;那份 dsh&gt;/lib/bin.js web [--no-open]</code>（有全局安装就用全局那份，否则用插件目录的）—— 不再经过 npx，也就不会再堆缓存副本。</p>
          <p class="guide-use"><strong>更新：</strong>结束正在运行的 dsh → 重新安装「dsh 版本」里选定的版本（自动＝latest）→ 原本在跑就用新版重新启动；已有全局安装时更新的就是全局那份（<code>npm i -g</code>）。</p>
          <p class="guide-use"><strong>dsh 自己的数据：</strong>工作目录取用户主目录，配置与数据由 dsh 自己管理（默认 <code>~/.dsh</code>），本插件不做改动。</p>
        </div>
      </div>
      <div class="fold">
        <button class="link-btn" @click="dshFolds.trouble = !dshFolds.trouble">{{ dshFolds.trouble ? '收起故障排查' : '故障排查' }}</button>
        <div v-if="dshFolds.trouble" class="guide">
          <p class="guide-use"><strong>结束 / 重启：</strong>不只管本插件启动的进程 —— 只要 3080 上跑着 dsh（含在别的终端里启动的）都能被结束；非 dsh 占用端口时会拒绝执行，避免误杀。</p>
          <p class="guide-use"><strong>首次安装很慢：</strong>要下载约 500 个包，国内建议把「npm 注册源」改成淘宝镜像；等待期间状态行会显示「已等待 x 秒」。</p>
          <p class="guide-use"><strong>占用空间：</strong>「删除插件目录的 dsh」清掉插件装的那份（有全局安装时用不到它）；「清理 npx 旧缓存」清掉旧版本留在 npx 缓存里的副本。</p>
          <div class="btn-row">
            <button class="secondary" :disabled="!dsh.installed || dshBusy" @click="dshMaintain('remove-plugin')">
              {{ dshConfirm === 'remove-plugin' ? '确认删除插件目录的 dsh？' : '删除插件目录的 dsh' }}
            </button>
            <button class="secondary" :disabled="dshBusy" @click="dshMaintain('clean-npx')">
              {{ dshConfirm === 'clean-npx' ? '确认清理 npx 旧缓存？' : '清理 npx 旧缓存' }}
            </button>
            <button v-if="dshConfirm" class="secondary" @click="dshConfirm = ''">取消</button>
          </div>
        </div>
      </div>
    </section>

    <!-- [dsh] dsh 本地用量统计：读 ~/.dsh 下 dsh-usage 的账本与会话投影缓存，纯本地、不联网 -->
    <section v-if="activeTab === 'dev'" class="card">
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
        <button :disabled="dshUsageBusy" @click="dshUsageRefresh">{{ dshUsageBusy ? '读取中…' : (dshUsage ? '刷新' : '读取统计') }}</button>
        <button v-if="dshUsage" class="secondary" :disabled="dshUsageBusy" @click="dshUsageClearCache">清除缓存并重扫</button>
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
        <label class="field row">
          <span class="label">今日</span>
          <span class="ver"><strong>{{ fmtTokens(dshUsage.todayTokens) }}</strong> tokens · {{ fmtDshCost(dshUsage.costToday) }}</span>
        </label>
        <label class="field row">
          <span class="label">本月</span>
          <span class="ver">{{ fmtTokens(dshUsage.monthTokens) }} tokens · {{ fmtDshCost(dshUsage.costMonth) }}</span>
        </label>
        <label class="field row">
          <span class="label">累计</span>
          <span class="ver">
            {{ fmtTokens(dshUsage.totalTokens) }} tokens（输入 {{ fmtTokens(dshUsage.inTokens) }} · 缓存命中 {{ fmtTokens(dshUsage.cachedTokens) }} · 输出 {{ fmtTokens(dshUsage.outTokens) }} · 推理 {{ fmtTokens(dshUsage.reasonTokens) }}）
            · {{ fmtDshCost(dshUsage.costTotal) }} · 共 {{ dshUsage.turns }} {{ dshUsage.turnsLabel || '轮' }}
          </span>
        </label>
        <label v-if="dshUsage.balance" class="field row">
          <span class="label">dsh-usage 抓到的余额</span>
          <span class="ver">{{ fmtDshBalance() }}</span>
        </label>
        <p v-if="dshUsage.note" class="hint">{{ dshUsage.note }}</p>

        <div class="range-tabs-row">
          <div class="range-tabs">
            <button v-for="r in DSH_USAGE_RANGES" :key="r" class="range-tab"
                    :class="{ 'range-tab-on': dshUsageRange === r }" @click="dshUsageRange = r">{{ r }} 天</button>
          </div>
        </div>
        <div v-if="dshUsageDayMax > 0" class="chart" :class="{ 'chart-dense': dshUsageRange >= 14 }">
          <div v-for="(d, i) in dshUsageDays" :key="d.date" class="bar-col">
            <div class="bar-val">{{ d.tokens > 0 && (dshUsageLabelEvery === 1 || i % dshUsageLabelEvery === 0) ? fmtTokens(d.tokens) : '' }}</div>
            <div class="bar-track">
              <div class="bar" :style="{ height: dshUsageBarHeight(d.tokens) }"></div>
            </div>
            <div class="bar-day">{{ i % dshUsageLabelEvery === 0 ? codexDayLabel(d.date) : '' }}</div>
          </div>
        </div>
        <p v-else class="hint">近 {{ dshUsageRange }} 天没有用量记录。</p>

        <div class="fold">
          <button class="link-btn" @click="dshUsageFolds.models = !dshUsageFolds.models">{{ dshUsageFolds.models ? '收起各模型用量' : '各模型用量' }}</button>
          <div v-if="dshUsageFolds.models" class="guide">
            <label v-for="m in dshUsageModels" :key="m.name" class="field row">
              <span class="label">{{ m.name }}</span>
              <span class="ver">{{ fmtTokens(m.tokens) }} tokens · {{ m.turns }} {{ dshUsage.turnsLabel || '轮' }} · 输出 {{ fmtTokens(m.out) }} · {{ fmtDshCost(m.cost) }}</span>
            </label>
          </div>
        </div>
        <div class="fold">
          <button class="link-btn" @click="dshUsageFolds.help = !dshUsageFolds.help">{{ dshUsageFolds.help ? '收起说明' : '说明' }}</button>
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

    <!-- [dsh] Codex 本地会话统计：读 ~/.codex/sessions 的 rollout JSONL，纯本地、不联网 -->
    <section v-if="activeTab === 'dev'" class="card">
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
        <button :disabled="codexBusy" @click="codexRefresh">{{ codexBusy ? '读取中…' : (codex ? '刷新' : '读取统计') }}</button>
        <button v-if="codex" class="secondary" :disabled="codexBusy" @click="codexClearCache">清除缓存并重扫</button>
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
        <label class="field row">
          <span class="label">今日</span>
          <span class="ver"><strong>{{ fmtTokens(codex.todayTokens) }}</strong> tokens · {{ codex.turns || 0 }} 轮</span>
        </label>
        <label class="field row">
          <span class="label">本月</span>
          <span class="ver">{{ fmtTokens(codex.monthTokens) }} tokens</span>
        </label>
        <label class="field row">
          <span class="label">累计</span>
          <span class="ver">{{ fmtTokens(codex.totalTokens) }} tokens（输出 {{ fmtTokens(codex.outTokens) }} · 推理 {{ fmtTokens(codex.reasonTokens) }} · 缓存命中 {{ fmtTokens(codex.cachedTokens) }}）</span>
        </label>
        <!-- 订阅窗口：只有日志里带 rate_limits（ChatGPT 订阅）时才有内容，没有就整行不渲染 -->
        <label v-if="codexWindowsText" class="field row">
          <span class="label">订阅窗口</span>
          <span class="ver">{{ codexWindowsText }}</span>
        </label>

        <div class="range-tabs-row">
          <div class="range-tabs">
            <button v-for="r in DSH_USAGE_RANGES" :key="r" class="range-tab"
                    :class="{ 'range-tab-on': codexRange === r }" @click="codexRange = r">{{ r }} 天</button>
          </div>
        </div>
        <div v-if="codexDayMax > 0" class="chart" :class="{ 'chart-dense': codexRange >= 14 }">
          <div v-for="(d, i) in codexDays" :key="d.date" class="bar-col">
            <div class="bar-val">{{ d.tokens > 0 && (codexLabelEvery === 1 || i % codexLabelEvery === 0) ? fmtTokens(d.tokens) : '' }}</div>
            <div class="bar-track">
              <div class="bar" :style="{ height: codexBarHeight(d.tokens) }"></div>
            </div>
            <div class="bar-day">{{ i % codexLabelEvery === 0 ? codexDayLabel(d.date) : '' }}</div>
          </div>
        </div>
        <p v-else class="hint">近 {{ codexRange }} 天没有用量记录。</p>

        <div class="fold">
          <button class="link-btn" @click="codexFolds.models = !codexFolds.models">{{ codexFolds.models ? '收起各模型用量' : '各模型用量' }}</button>
          <div v-if="codexFolds.models" class="guide">
            <label v-for="m in codexModels" :key="m.name" class="field row">
              <span class="label">{{ m.name }}</span>
              <span class="ver">{{ fmtTokens(m.tokens) }} tokens · {{ m.turns }} 轮 · 输出 {{ fmtTokens(m.out) }}</span>
            </label>
          </div>
        </div>
        <div class="fold">
          <button class="link-btn" @click="codexFolds.help = !codexFolds.help">{{ codexFolds.help ? '收起说明' : '说明' }}</button>
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
        <button class="secondary" :disabled="updateChecking" @click="doCheckUpdate(true)">
          {{ updateChecking ? '检查中…' : '立即检查更新' }}
        </button>
        <button class="secondary" @click="marketSearch">插件市场</button>
        <button class="secondary" @click="openHomepage">项目主页</button>
      </div>
      <p v-if="updateMsg" class="msg" :class="[updateResult && updateResult.ok ? 'ok' : 'err', hasUpdate ? 'clickable' : '']"
         :title="hasUpdate ? '点击前往插件市场更新' : ''"
         @click="hasUpdate && marketSearch()">{{ updateMsg }}</p>
      <p class="hint">开启后每次呼出插件自动检查一次（12 小时内最多一次），发现新版本会弹出系统通知。</p>

      <div class="fold">
        <button class="link-btn" @click="aboutFolds.feedback = !aboutFolds.feedback">
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
/* 用量趋势区间切换（7 / 14 / 30 / 90 / 180 天）；.range-tabs-row 是开发者 Tab 的档位容器 */
/* 开发者 Tab 里的图表档位：右对齐贴住图表上沿，与卡片内的按钮行区分开 */
.range-tabs-row {
  display: flex;
  justify-content: flex-end;
  margin: 4px 0 8px;
}
.range-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 9px;
}
.range-tab {
  padding: 2px 9px;
  font-size: 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
}
.range-tab:hover {
  color: var(--fg);
}
.range-tab-on {
  background: var(--accent);
  color: #fff;
}
.range-tab-on:hover {
  color: #fff;
}
.export-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}
.export-btn:disabled {
  opacity: 0.45;
  cursor: default;
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
  user-select: text;
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
  border-radius: 8px;
  font-size: 13px;
}
.btn-row button.secondary {
  background: rgba(83, 107, 169, 0.18);
  color: var(--accent);
}
.btn-row button.danger {
  background: rgba(224, 67, 63, 0.16);
  color: var(--err);
}
.btn-row button:disabled {
  opacity: 0.45;
  cursor: default;
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
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg-dim);
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
.chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding-top: 6px;
}
.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.bar-val {
  font-size: 10px;
  color: var(--fg-dim);
  white-space: nowrap;
  height: 14px;
}
.bar-track {
  width: 100%;
  height: 90px;
  display: flex;
  align-items: flex-end;
  background: var(--track);
  border-radius: 6px;
  overflow: hidden;
}
.bar {
  width: 100%;
  background: linear-gradient(180deg, #6f8ad6, var(--accent));
  border-radius: 6px 6px 0 0;
  transition: height 0.3s ease;
}
.bar-day {
  font-size: 10px;
  color: var(--fg-faint);
  white-space: nowrap;
}
/* 14 / 30 天：柱子变窄，间距与日期字号一起收，否则会糊成一片 */
.chart-dense {
  gap: 3px;
}
.chart-dense .bar-day {
  font-size: 9px;
}
.chart-dense .bar-track {
  border-radius: 4px;
}
/* 90 / 180 天：柱子更密，间距再收一档，否则空隙会吃掉大半个图宽（卡片内容宽只有 524px） */
.chart-ultra {
  gap: 1px;
}
.chart-ultra .bar-track {
  border-radius: 2px;
}
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
