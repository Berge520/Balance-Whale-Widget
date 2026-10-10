// dsh（DeepSeek Harness）开发者区的前端状态与逻辑。
// 从 App.vue 抽出：这九张卡的状态 / 请求 / 轮询 / 清理自成一体，留在设置页里既稀释主逻辑，
// 也让「展开才读、离开即停」这类 dsh 专属约定混在通用设置里难以复核。
// 依赖全部由 App.vue 注入（services / cfg / patchCfg / activeTab ...），本模块不反向引用设置页。
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type {
  DshBackupListResult,
  DshBackupSnapshot,
  DshDiagnoseFinding,
  DshDiagnoseItem,
  DshDiagnoseResult,
  DshDumpResult,
  DshExportPreviewResult,
  DshHostCompatCheckResult,
  DshHostCompatVerdict,
  DshIsolateCandidate,
  DshIsolateCandidatesResult,
  DshIsolatePlan,
  DshMarketCatalogResult,
  DshMarketInstallResult,
  DshMarketInstalledEntry,
  DshMarketPingEntry,
  DshMarketPlugin,
  DshMarketRegistryLatestEntry,
  DshMarketRegistryLatestResult,
  DshMarketStatusResult,
  DshMarketUninstallResult,
  DshMarketUpdateEntry,
  DshPatchItem,
  DshPatchListResult,
  DshUsageResult,
  WhaleServices,
} from '../types/services'
import { type Flash } from './useFlash'
import { barHeightOf } from '../utils/format'

export function useDsh(opts: {
  services: Partial<WhaleServices>
  cfg: any
  patchCfg: (p: Record<string, any>) => void
  activeTab: any
  DEFAULT_DSH_PORT: number
  useFlash: () => Flash
  usePolling: (fn: () => void, ms: number, immediate?: boolean) => { start: () => void; stop: () => void }
  // 各开发者卡的「读过时间戳」（0 = 没读过）。父级 App.vue 维护，这里只读不写 ——
  // 判真即「读过」（P5 起改为时间戳，语义仍是「本会话读过没有」）
  devStatsLoaded: Record<string, number>
}) {
  const { services, cfg, patchCfg, activeTab, DEFAULT_DSH_PORT, useFlash, usePolling, devStatsLoaded } = opts

// —— DeepSeek Harness（dsh，开发者） ——
const dsh = reactive({
  running: false, stopping: false, busy: '', pid: 0, startedAt: 0, ready: false, readyAt: 0,
  keepAlive: false, url: '', port: DEFAULT_DSH_PORT, runPort: 0, needsPortRestart: false,
  nodeDir: '', nodeVersion: '', nodeAuto: true, found: true,
  error: '', lastCmd: '', log: '',
  registry: '', version: '', resolved: '', hasUpdate: false, runVersion: '', needsRestart: false, reinstall: false, prefix: '', source: '', globalVersion: '', globalDir: '', globalWritable: true,
  versions: { at: 0, latest: '', list: [] as string[], times: {} as Record<string, number> },
  // 版本说明（所选版本那一版、或「实装 → 所选」区间的 release notes 聚合，见 dsh-notes.js）。
  // 宿主回 null = 还没取 / 没有可看的区间，界面据此整块不渲染
  notes: null as any,
  notesBusy: false,
  external: false, externalPid: 0, externalName: '', externalRunPort: 0, portOther: '', webUrl: '', installed: '',
})
const dshFlash: Flash = useFlash()
// 安装 / 更新的终态横幅：dshFlash 是 12px 的细字，位置又在卡片最底部，
// 更新这类「要等几十秒、结果决定接下来怎么办」的动作只落到那里等于没提示 ——
// 用户点完往下滚才发现「原来早就装好了」。这里在「更新版本」行正下方挂一条醒目横幅，
// 成功/失败都停住不自动消失（要等用户关掉或发起下一次动作），避免刚好错过。
// 为什么另起一个 ref 而不是复用 dshFlash：dshFlash 语义是「瞬时回执」（改端口、复制等一闪过），
// 两者生命周期不同，混用会让横幅被无关的小回执顶掉。
const dshResult = ref<{ msg: string; err: boolean } | null>(null)
// 「打开 Web UI」的招揽态：dsh 起来后这个按钮才是真正可用的下一步，但它和「重启 / 结束」
// 同排同色，用户扫一眼看不出该点哪个。这里借用 GitHub 加速卡片「执行中按钮」那套呼吸动效
// （见 AccelView 的 .btn-busy）把它做成会脉动的高亮，视线自然被拉过去。
// ⚠️ 与 .btn-busy 的区别：那边表示「正在执行、请等待」，这边表示「可以点了」，
//    语义相反但视觉手法一致（描边 + 亮度脉动），所以不复用类名，另起一个以免将来改错语义。
// 只脉动**没被点过**的那一次：点过就说明用户已经知道入口在哪，一直闪是干扰。
// 首次 ready 时置 true，用户点开（dshOpenPage）或 dsh 停下时置 false。
const dshWebHint = ref(false)
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
const dshFolds = reactive({ advanced: false, help: false, trouble: false, versions: false, notes: false })
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
  // 只在「确实没查过」时自动查：dshVersionsQueried 是持久化的，重载插件后展开不会白打一次 npm view。
  // 查过但缓存里那份列表为空（上游下架等），也认作查过 —— 要重查由用户点「重试」
  if (dshFolds.versions && !dshHasVersions.value && !dshVersionsQueried.value && !dshQueryFailed.value) dshQueryVersions()
}
// 展开「版本说明」时按需取一次 —— **取数只由这里发起**（宿主在 listVersions 结束时不再顺手捞，
// 版本变化也不再自动重取，见下方对应注释）。三条触发条件：
//  · 没取过（dsh.notes 为空）
//  · 上次失败过（ok === false）：否则用户展开只会一直看到那条失败提示，没有自愈路径
//  · 手上那份过期了（!dshNotesFresh()）：版本换过、说明还是旧的 —— 必须重取，
//    否则会拿「上一段区间」的结论冒充当前这一段
function dshToggleNotes() {
  dshFolds.notes = !dshFolds.notes
  if (!dshFolds.notes) return
  const failed = !!(dsh.notes && dsh.notes.ok === false)
  const stale = !!(dsh.notes && !dshNotesFresh())
  if (!dsh.notesBusy && (!dsh.notes || failed || stale)) dshLoadNotes(failed || stale)
}
// 取说明：结果由轮询经快照的 notes / notesBusy 字段异步回传，这里不自己存结果。
// 调用本身失败（IPC 通道缺失等）用 dshFlash 提示 —— 设置页没有写宿主日志的通道，
// 页面侧的异常一律走这条既有的提示位，不吞掉也不自造第二个错误态
function dshLoadNotes(force?: boolean) {
  try { services.dshLoadNotes?.(force === true) } catch (err: any) {
    dshFlash.err = true
    dshFlash.msg = '取版本说明失败：' + String(err?.message || err)
  }
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
// 版本号比较（semver 兜底）：数字段逐位比，数字段 > 字母段，与宿主 isNewer 同一套口径
// （同上，这里也是副本，改一处务必同步另一处）。
function dshVerSemver(a: string, b: string) {
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
// 「a 是否比 b 更新」——必须与宿主的 newerByTime **逐字镜像**：优先按 **npm 发布时间**（times），
// 时间拿不到才退回 semver。这里是副本（设置页不能 require 宿主模块），改一处务必同步另一处。
//
// 为什么不能只按 semver：dsh 官方不按 semver 递增发布，会给旧分支补发版本号更低的补丁
// （实测 0.1.5-rc.3 发布于 0.1.6-alpha.2 **之后**）。若这里按 semver 挑「最新（含测试版）」，
// 会挑出号更大但发布更早的那版，与宿主 maxVersion 算出的目标版本对不上 —— 而 dshNotesResolved
// 又拿本函数算「所选是否比实装新」去拼新鲜度键，一旦判反，键与宿主对不上 → 版本说明永远卡在
// 「正在获取说明…」（判据问题，重取多少次都没用）。宿主那边退回 semver 的兜底也照搬，保持对称。
function dshVerNewer(a: string, b: string) {
  const x = String(a || '').trim(), y = String(b || '').trim()
  if (!x) return false
  if (!y) return true
  const t = (dsh.versions && dsh.versions.times) || null
  const tx = t && t[x], ty = t && t[y]
  if (tx && ty) return tx > ty
  if (tx && !ty) return true
  if (!tx && ty) return false
  return dshVerSemver(x, y)
}
// 当前配置下「更新」会装到哪个版本：'' = latest 标签，'newest' = 版本列表里最高（含测试版），
// 其余为固定版本号。与宿主 installVersion 的口径保持一致。
const dshTargetVersion = computed(() => {
  if (cfg.dshVersion === NEWEST_VERSION) {
    const list = (dsh.versions && dsh.versions.list) || []
    // 列表是 npm 的发布顺序而非版本序，所以要逐项比较取「最新」的那版，不能取末位。
    // dshVerNewer 走宿主同一套口径（优先按 times 发布时间），这里自动跟着对
    let best = ''
    for (const v of list) if (!best || dshVerNewer(v, best)) best = v
    return best
  }
  return cfg.dshVersion || ((dsh.versions && dsh.versions.latest) || '')
})
// 「实际使用」那一栏的版本说法。口径与 dshHasUpdateTip 完全一致（实装 vs npm latest），
// dshHasUpdateTip 已经带上了具体版本号，这里直接复用，不再自己去算目标版本 —— 
// 之前这里取的是 dshTargetVersion（用户手选的版本），实装 0.1.7-alpha.2 且也选了它时
// 会写成「0.1.7-alpha.2（有新版本：0.1.7-alpha.2）」，版本号原地重复两遍。
// 实装版本（取到哪一份在用）：宿主 resolved 优先全局，再退插件目录那份
const dshCurVer = computed(() => dsh.resolved || dsh.installed || '')
const dshCurText = computed(() => {
  const cur = dshCurVer.value
  if (!dshHasVersions.value) return dshStateText.value // 没查到版本，回落「查询中 / 查询失败 / 未运行…」
  if (!cur) return '未安装'
  return cur + '（' + dshHasUpdateTip.value + '）'
})
// 更新状态句：「已是最新 / 有新版本 x.y.z」。
// 全卡**只有这一处**报「有没有新版」：状态行标签与「实际使用」行都取它 ——
// 先前三处各说一遍（状态行标签、按钮「有新版」、实际使用行），版本号口径还不一样，读出来全是矛盾。
// 判据是宿主给的 dsh.hasUpdate，它比的是**实装版本 vs npm latest**；这里显示的版本号也必须取
// **同一个值**（dsh.versions.latest），不能取 dshTargetVersion —— 后者会优先返回用户在下拉里手选的
// 版本，实装 0.1.7-alpha.2 且恰好也选了它时，就会写出「有新版本 0.1.7-alpha.2」，
// 和同一屏的「npm latest 0.1.7-rc.2」打脸（用户报的就是这个）。
// 下拉选哪个版本只决定「更新时装成哪一版」，不该改写「npm 上有没有新版」这个事实。
const dshHasUpdateTip = computed(() => {
  if (!dshHasVersions.value) return ''
  const latest = (dsh.versions && dsh.versions.latest) || ''
  return dsh.hasUpdate ? '有新版本' + (latest ? ' ' + latest : '') : '已是最新'
})
// 未安装时不能断言「有新版本」：没有可比对的基准，只说「npm 上有哪些版本」
const dshLatestLabel = computed(() => (dshCurVer.value ? dshHasUpdateTip.value : '可安装'))
// 「实际使用」与「更新会装到的版本」是否一致。
// 注意这是**另一个维度**、与上半句的「谁更新」互不覆盖：
//  · dshHasUpdateTip 说的是「npm latest 比在用的新」（客观事实，只看 latest）；
//  · 这句说的是「你选的版本和实际在用的不一致，点更新会把你替换掉」（看的是下拉所选值）。
// 两者可以同时成立（选了更老的一版，而 npm latest 又比在用的新）—— 那时上半句报「有新版本」，
// 这句补一句「点了会被替换成 X」，否则用户按提示点了更新，装回来的却是自己没预期的老版本。
const dshVerMismatch = computed(() => {
  const tgt = dshTargetVersion.value
  if (!tgt) return ''
  const cur = dshCurVer.value
  if (!cur || tgt === cur) return ''
  return '当前 ' + cur + ' 与所选版本（' + tgt + '）不同，点「更新」会替换为 ' + tgt
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
  // 兜底对象也带上 times：老宿主快照没有它时，dshVerNewer 靠它为空退回 semver（不能留 undefined）
  dsh.versions = s.versions && typeof s.versions === 'object' ? s.versions : { at: 0, latest: '', list: [], times: {} }
  // 版本说明：宿主给 null / 非对象时一律归 null（模板按 null 判定整块不渲染，不必再防一层）
  dsh.notes = s.notes && typeof s.notes === 'object' ? s.notes : null
  dsh.notesBusy = s.notesBusy === true
  // 版本查询结论随快照带回：白名单过滤，避免宿主 / 未来字段把 dshVersionsCode 写成别的值
  const vc = s.versionsCode
  dshVersionsCode.value = vc === 'hit' || vc === 'empty' ? vc : ''
  // 查过就落库：宿主只在真打了一次 npm view 后回 'hit'，轮询读到的落库缓存不会带码。
  // 界面自己再写一遍是幂等补充（本设置页可能比宿主先拿到结论）
  if (dshVersionsCode.value && !dshVersionsQueried.value) {
    dshVersionsQueried.value = true
    try { utools.dbStorage.setItem(KEY_DSH_QUERIED, true) } catch (err) {}
  }
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
  // 终态一律撤掉「正在更新…」这类进度占位：结果已由 dshResult 横幅独立承担，
  // 留着会让卡底细字与横幅说同一件事（一上一下两处重复）
  dshFlash.msg = ''
  if (dsh.error) {
    dshFlash.err = true
    dshLogOpen.value = true
    // 横幅要自己说清「哪一步失败了」，不能只留卡底那行 dsh.error —— 它可能被日志推高后滚出视野
    dshResult.value = { msg: (act === 'update' ? '更新' : act === 'restart' ? '重启' : '启动') + '失败：' + dsh.error, err: true }
    return
  }
  if (act === 'update') {
    // 更新成功 = 装到了新版本（回读磁盘的结论，见 preload 的 verifyInstalledPkg）。
    // ⚠️ 这里**不**要求 dsh.ready：更新完的 dsh 未必被拉起来（也可能用户设了不自动启动），
    //    用 ready 当判据会把「装成功了但没启动」误报成失败。
    const now = dsh.installed || dsh.globalVersion || dsh.runVersion || dsh.resolved || ''
    dshResult.value = {
      msg: (dshAsync.before && now && now !== dshAsync.before)
        ? '更新完成：' + dshAsync.before + ' → ' + now
        : (dsh.ready ? '更新完成，dsh 已用新版启动' : '更新完成（新版本已装好，下次启动生效）'),
      err: false,
    }
  } else if (act === 'restart') {
    dshResult.value = { msg: dsh.ready ? '已重启 dsh：' + dsh.port : '重启后 dsh 未就绪（详见日志）', err: !dsh.ready }
  } else {
    // 启动：首次会自动下载安装，ready（3080 真正监听）才是判据
    dshResult.value = { msg: dsh.ready ? 'dsh 已启动' : '启动未成功：进程没能在限时内监听 ' + dsh.port + '，详见日志', err: !dsh.ready }
  }
  if (dshResult.value && dshResult.value.err) dshLogOpen.value = true
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
  // 勾了「自动刷新版本」就每次进 Tab 重查一次：与手动点「重新查询」同一入口（dshQueryVersions），
  // busy 由宿主快照带回、按钮自身禁用，查询期间重复进 Tab 会被 dshDo 的 busy 拦截，不会叠发 npm view
  if (dshAutoRefresh.value && dsh.busy !== 'versions' && !dshQueryFailed.value) dshQueryVersions()
  dshPolling.start()
})
// 启动/结束是同步返回；重启要等旧进程退出、更新要下载，之后再补一次状态
function dshDo(action: 'start' | 'stop' | 'restart' | 'update') {
  try {
    const api = services as any
    const fn = action === 'start' ? api.dshStart : action === 'stop' ? api.dshStop : action === 'restart' ? api.dshRestart : api.dshUpdate
    dshApply(fn?.())
    dshFlash.err = false
    // 发起新动作就把上一条终态横幅撤掉：否则「更新完成」会一直挂在按钮下面，
    // 与这次的「正在更新…」并存，用户没法判断哪个才是当下状态
    dshResult.value = null
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
    dshResult.value = { msg: '操作失败：' + String(err?.message || err), err: true }
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
  // 用户已经找到入口了，脉动的使命到此为止 —— 再闪就是干扰
  dshWebHint.value = false
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
// dsh 从「没在跑」变成「跑起来了」的那一刻，点亮「打开 Web UI」的招揽脉动。
// 只在上升沿置位：挂件菜单里启动 dsh 也会走到这里，此时设置页可能正开着，
// 按钮得跟着亮起来，否则用户回到设置页还是看到一个平平的次按钮。
// 用 running/external 而非 ready：ready 还要等 3080 真正监听，那时才亮会把
// 「进程已起、马上就能进」的窗口漏掉，用户在这几秒里仍不知道该点哪。
watch(() => dsh.running || dsh.external, (now, was) => {
  if (now && !was) dshWebHint.value = true
  else if (!now) dshWebHint.value = false // 停了就撤掉，免得下次启动前一直闪
})
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
  // 下拉里**只标「已安装」**，不标「已选」：
  //  · 「已选」是 select 自身的勾选态，浏览器原生就显示（选中项就是它），再拼一遍纯属重复；
  //    原先顶端还跟着一条「0.0.1-rc.1（已选）」+ 旁边按钮挂「有新版」，
  //    用户读到的是「已选 0.0.1-rc.1 + 有新版」—— 与「npm latest 0.1.7-rc.2」互相打脸。
  //  · 「已安装」则必须标：下拉默认只显示所选值，不展开就看不到实装的是哪一版，
  //    而「已安装」正是判断要不要更新的基准，比勾选态重要得多。
  // 顶部两条固定项（自动 / 最新）的哨兵值同理：选中态交给 select，不再往 label 里拼「（已选）」。
  // 「已安装」要标在**实际在用**的那份上（resolved 优先全局，见宿主 snapshot）
  if (dsh.resolved) addMark(dsh.resolved, dsh.source === 'global' ? '全局已安装' : '插件目录已安装')
  if (latest) addMark(latest, 'latest 标签')

  const out: Array<{ v: string; label: string }> = [
    { v: '', label: '自动（安装/更新时取 latest）' },
    { v: NEWEST_VERSION, label: '最新（含测试版，取列表中最高版本）' },
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
// 首次拿到版本列表时把下拉默认指到**实装版本**（resolved 优先全局，与「实际使用」行同源）：
// 用户此前选的是「自动（取 latest）」，但 dsh 预发布线（alpha/rc）走得比 latest 快，
// 「自动」点更新反而装出**更旧**的稳定版 —— 默认「装回当前这版」比「莫名降级」安全得多。
// 只在用户从未主动选过版本时兜底（cfg.dshVersion 为空 = 没选过 / 用户显式选回「自动」；
// 后者故意不覆盖 —— 用户点回「自动」就是想要 latest 行为，不该被改回去）。
watch(() => (dsh.versions && dsh.versions.latest) || '', (latest) => {
  if (!latest || cfg.dshVersion) return
  const cur = dsh.resolved || dsh.installed || ''
  if (!cur) return
  const list: string[] = (dsh.versions && dsh.versions.list) || []
  // 实装版本必须在列表里才指过去：不在（列表被截断 / 下游镜像没收录）就保持「自动」，
  // 否则 select 会因 value 无对应 option 而显示空白，比「自动」更让人困惑
  if (list.indexOf(cur) < 0) return
  cfg.dshVersion = cur
  patchCfg({ dshVersion: cur })
})
// 查询可用版本：npm view 要联网，慢一点，稍后多次刷新状态
const DSH_QUERY_MSG = '正在查询可用版本…'
// 查询结果已经上屏（或正在查询）时就没必要再摆一个按钮占位：
// 「查询可用版本」只在两种情况下有意义 —— 还没查过、以及上次查失败要重试。
// 查询成功后 latest 直接显示在下面的「npm latest」行里，按钮留着只会让人怀疑「是不是还要再点一下」。
const dshQueryFailed = ref(false)
// 已查询到的版本缓存在宿主 dbStorage 里（重载插件后仍在），所以「已经查过」有三个来源：
// 本次会话查到了、本次会话查失败了、以及重载插件前查过（只在展开时读回来）。
// 记不住这个状态就会出现「按钮永远重查」或「查过却说没查」，
// 用一个持久化标记统管，展开折叠区时按它决定要不要自动查一次。
const dshVersionsQueried = ref(false)
// 版本查询的结论码，宿主随快照回溯：'' 无结论 | 'hit' 本次查询拿到版本 | 'empty' 查到但没版本
const dshVersionsCode = ref('')
// 「每次进入开发者 Tab 自动刷新可用版本」：勾上后切进本 Tab 就重打一次 npm view，
// 解决版本缓存无 TTL（上游发新版列表不会自己变）、而手动「重新查询」又容易忘的问题。
// 默认关：查询要联网（约 0.5–3s），自动联网行为必须用户显式授权 —— 与 dshMarket 卡
// 「展开不自动抓目录」同一取舍
const dshAutoRefresh = ref(false)
const KEY_DSH_AUTO_REFRESH = 'whale:dshAutoRefreshVersions'
try { dshAutoRefresh.value = utools.dbStorage.getItem(KEY_DSH_AUTO_REFRESH) === true } catch (err) {}
function dshToggleAutoRefresh() {
  const next = !dshAutoRefresh.value
  dshAutoRefresh.value = next
  try { utools.dbStorage.setItem(KEY_DSH_AUTO_REFRESH, next) } catch (err) {}
  // 勾选瞬间补一查：用户勾它就是想「现在就有新列表」，等下次进 Tab 再生效太绕
  if (next && activeTab.value === 'dev' && dsh.busy !== 'versions' && !dshQueryFailed.value) dshQueryVersions()
}
const KEY_DSH_QUERIED = 'whale:dshVersionsQueried'
try { dshVersionsQueried.value = utools.dbStorage.getItem(KEY_DSH_QUERIED) === true } catch (err) {}
const dshHasVersions = computed(() => !!(dsh.versions && dsh.versions.latest))
// 「npm latest」那一行的取值：查询结果是异步回来的（宿主查到 latest 后由轮询带回），
// 所以要区分三态 —— 查到 / 正在查 / 没查过。写成 `latest || '未查询'` 会让查询途中就报「未查询」，
// 与旁边按钮上的「查询中…」自相矛盾。
const dshLatestText = computed(() => {
  if (dshHasVersions.value) return (dsh.versions && dsh.versions.latest) || ''
  return dshQueryFailed.value ? '查询失败' : '未查询'
})
// 版本说明。三种呈现：
//  · 有内容（区间聚合、或单版本自己那一版）→ 折叠行 + 展开的清单；
//  · 已是最新（empty）→ 一行纯文案，明确告诉用户「查过了，没有新版本」；
//  · 还没取到（notes 为 null）→ **仍给折叠行**（右侧显示「展开」），点开才去取。
// 最后这一档是必需的，不是可选：说明结果要联网才有，而入口若也等结果才渲染，
// 就形成「要有结果才给入口、要有入口才有结果」的死锁 —— 用户永远点不到，
// 只会看到这一块凭空消失。界面显示得比取数慢一拍没关系，不能连入口都没有。
// 失败（ok:false）落在「已取到答案但没成功」：同样保留折叠行，展开后由宿主提示失败原因。
const dshNotes = computed(() => dsh.notes)
const dshNotesOk = computed(() => !!(dshNotes.value && dshNotes.value.ok))
// 「有可展开的区间」：empty 为假 + sections 有长度（版本是否新鲜由 dshNotesFresh 统一把关，见下）
const dshNotesFilled = computed(() => !!(dshNotesOk.value && !dshNotes.value.empty && Array.isArray(dshNotes.value.sections) && dshNotes.value.sections.length))
const dshHasNotes = computed(() => dshNotesFilled.value && dshNotesFresh())
// 「版本说明」折叠行的摘要。两种模式各有各的说法 —— 说「跨 N 个版本」还是「这一版」，
// 取决于说明到底覆盖了几个版本；用户在两种模式下看到的必须是能对上的描述。
// 单版本模式只有 1 个版本，此时还写「跨 1 个版本」会很别扭（听着像升级跨度），改说「这一版」
const dshNotesSummary = computed(() => {
  const n = dshNotes.value
  if (!n || !dshNotesOk.value || !dshNotesFresh()) return ''
  if (n.empty) return ''
  const ver = Array.isArray(n.versions) ? n.versions.length : 0
  const head = ver > 1 ? '实装 → 最新跨 ' + ver + ' 个版本' : '所选版本 ' + ((n.versions && n.versions[0]) || '')
  return head + ' · 共 ' + (n.total || 0) + ' 条'
})
// 实装版本 —— **必须与宿主取说明时用的那一份同源**（dsh.js 的 loadNotes 用 activeDsh().version）。
// 只有一处：宿主广播的 `resolved`（= activeDsh().version，全局优先）。
// 先前这里写的是 `dsh.source === 'global' && dsh.globalVersion ? dsh.globalVersion : dsh.installed || dsh.globalVersion`，
// 看着等价，实则走的是**另一个字段**：`dsh.installed` 是 installedVersion() 读「插件目录」那份，
// **不含全局安装**。全局装 dsh 的用户（正是最常见的情形）于是两边拿的不是同一个版本 ——
// 用户实测：全局 0.1.7-alpha.2、选 0.1.7-rc.1，宿主按 alpha.2 判出「区间模式」，
// 这里按插件目录那份判成「单版本模式」，两个 resolvedTarget 对不上 → dshNotesFresh 恒 false
// → 永远停在「正在获取说明…」。注意 rc.2 恰好两种口径都落区间模式、把差异掩盖了，
// 所以这个 bug 只在「选一个比实装新的中间版本」时才现形。
// 空值链保留 globalVersion 兜底：resolved 尚未广播（首帧 / 快照未回）时不至于空手判据。
const dshInstalledVer = computed(() => dsh.resolved || dsh.globalVersion || dsh.installed || '')
// 与宿主 dsh.js 的 loadNotes **逐字**对应地算出「这份说明算的是哪一段」，用来核对回传的 notes 是否
// 属于当前这组版本。宿主的键是 `newerByTime(target, installed) ? installed + '->' + target : target`：
//   · 所选版本比实装新 → 区间模式，上界随实装版本走，实装变了就得重算，所以键里带上实装版本；
//   · 所选版本不高于实装（含相等）→ 单版本模式，看的是所选那一版自己，与实装版本无关，键就是所选版本。
// 注意 dshVerNewer 是 newerByTime 的副本，两边判据必须都按 **times 发布时间**（其中一方退回 semver 就会漂）。
// 为什么要「逐字」：这个键两边一旦不一致，就会退化成 dshNotesFresh 恒为 false —— 界面永远停在
// 「正在获取说明…」，再重取多少次都没用（判据问题，不是数据问题）。先前这里自己复刻过一套
// 「取区间上界」的算法，改单版本模式时必然要再改一遍，索性改成镜像宿主这一行，只有一处会漂。
const dshNotesResolved = computed(() => {
  const target = dshTargetVersion.value
  if (!target) return ''
  const installed = dshInstalledVer.value
  return installed && dshVerNewer(target, installed) ? installed + '->' + target : target
})
const dshNotesFresh = () => {
  const n = dshNotes.value
  if (!n || !dshNotesOk.value) return false
  return n.resolvedTarget === dshNotesResolved.value
}
// 无区间时的文案。三重前提，缺一不可：
//  ① ok —— 真取到了结论；
//  ② empty —— 宿主算出的区间确实为空；
//  ③ **这份结论属于当前这组版本** —— notes.installed / notes.target 与此刻的实装、目标一致。
// 第 ③ 条是踩坑后补的（用户实测：实装 0.1.7-alpha.2、latest 0.1.7-rc.2，却报「已是最新」）：
// notes 是**异步**回传的，换版本重查时宿主只是重新发起取数，旧的那份 notes 会继续挂在界面上，
// 直到新结果回来。旧结果是按**上一组**版本算的「已是最新」，直接拿来展示就会张冠李戴；
// 更糟的是显示成「已是最新」会连带把折叠行藏掉，用户连点开重取的入口都没有，卡死在这个错判上。
// 版本对不上就当「还没取到」（归到折叠行那一档），点开自会去取新的
const dshNotesLatest = computed(() => !!(dshNotesOk.value && dshNotes.value.empty && dshNotesFresh()))
// 折叠行是否渲染：有区间、或已是最新、或还没取到 —— 三种都要给入口。
// 只排除「有版本列表可用于取说明」这一前提都没有的情况（版本都没查到，区间无从谈起）
const dshNotesRow = computed(() => {
  if (dshHasNotes.value || dshNotesLatest.value) return true
  return !!(dsh.versions && dsh.versions.latest)
})
// 说明面板**展开期间**，实装 / 目标版本一变就立刻重取 —— 用户换完下拉不必再收起展开。
// 只在展开时生效是刻意的：说明是附注信息，不点开就不该占用一趟网络（上游固定吐 380KB 全量）。
// 收起态下版本变了怎么办：不重取，展开时的 dshNotesFresh() 判否 → 界面落回「正在获取说明…」那一档，
// 用户点开那一下 dshToggleNotes 会补取（呈现上不会误导，也没有静默死局）。
// 为什么要 watch 而不是只靠 dshToggleNotes：换下拉只落盘配置（patchCfg），
// 中间**没有任何操作**会经过「展开」这个入口 —— 用户实测「切换版本后都要点击收起再展开才能获取」。
// 触发条件是 !dshNotesFresh()：已是最新那几种情形（ok / 空区间 / 版本没变）自然不重取，不必另外判。
watch([dshInstalledVer, dshTargetVersion, () => dsh.notesBusy], () => {
  if (!dshFolds.notes || dsh.notesBusy) return
  if (!dshNotesFresh()) dshLoadNotes(true)
})
// 取数结果靠 dshPolling 回传，而它是 4s 一跳的**粗粒度**状态轮询（状态行、按钮可用性够用）。
// 说明这一趟实测 0.3~2.9s，用 4s 去接它的结果，平均要多等半格 —— 用户点开就是「要好几秒」的观感
// （用户实测「获取需要 5 秒」。宿主其实早就落地了，只是界面还没轮到那一跳去读）。
// 所以取数期间额外挂一条 600ms 的快轮询，一旦从快照里看到 notesBusy 落回 false 就停 ——
// 自限时，不使用户多付任何成本；说明真失败/超时（TIMEOUT_MS）也照样有 4s 那条兜底，不会漏读。
let dshNotesFastTimer = 0
function dshNotesFastStop() {
  if (dshNotesFastTimer) { window.clearInterval(dshNotesFastTimer); dshNotesFastTimer = 0 }
}
watch(() => dsh.notesBusy, (busy) => {
  if (busy && !dshNotesFastTimer) {
    dshNotesFastTimer = window.setInterval(() => {
      dshStatus()
      if (!dsh.notesBusy) dshNotesFastStop()
    }, 600)
  } else if (!busy) {
    dshNotesFastStop()
  }
})
onUnmounted(dshNotesFastStop)
// ⚠️ 不能用「清空提示」来标记本轮结束：dshFlash 是启动/重启/更新动作共用的提示位，
//    用户在查询途中点一次「启动」，清掉的是动作的提示；反过来动作的提示也会被这里的
//    超时分支覆盖成「查询超时」，把刚播报的成功结果抹掉。收尾只认宿主快照里的结论码。
let dshQueryToken = 0 // 本次查询的令牌，防止上一轮的兜底定时器清掉下一轮刚设的提示
function dshQueryVersions() {
  try {
    // 先清失败态再发请求：宿主每次都是重新打一遍 npm view，上一次的失败结论对本次无效。
    // 清了之后按钮文案会从「重试」回落到「查询中…」（busy 由宿主快照带回）
    dshQueryFailed.value = false
    const token = ++dshQueryToken
    services.dshListVersions?.()
    // 宿主查到 latest 后会在后续快照里带回来，所以每次都读一遍状态、顺带把提示收掉
    const probe = () => {
      dshStatus()
      if (token !== dshQueryToken) return
      if (dsh.versions && dsh.versions.latest) {
        dshVersionsQueried.value = true
        // 查到版本就是本轮收尾：把「正在查询可用版本…」收掉，否则它会一直挂在卡片底部
        // （先前这里 return 得干干净净、只落 queried 标记，提示文案没人清 —— 成功反而比失败更像卡住）。
        // 只在「还是我发的那条」时清，避免抹掉用户期间其他操作（启动 / 更新等）的回执
        if (dshFlash.msg === DSH_QUERY_MSG) dshFlash.msg = ''
        // 说明的取数在宿主侧已挂在 listVersions 结束时（宿主那侧是 force），这里不再补一刀：
        // 设置页拿不到版本列表，没法自己判断区间是否已取全，重复触发只会多打一趟网络
        return
      }
      // 查到「没有可用版本」也是有效结论：不再自动重查，但保留「重试」入口
      if (dshVersionsCode.value === 'empty') {
        dshQueryFailed.value = true
        if (dshFlash.msg === DSH_QUERY_MSG) dshFlash.msg = ''
        return
      }
      // 只有「还是我发的那条」才改，避免覆盖用户期间其他操作的消息
      if (dshFlash.msg === DSH_QUERY_MSG && Date.now() - t0 > 12000) {
        dshQueryFailed.value = true // 留下来给用户一个「重试」入口，按钮不再自动隐藏
        dshFlash.err = true
        dshFlash.msg = '查询超时：未取到可用版本，请检查网络或 npm 注册源后重试。'
        dshQueryToken++
      }
    }
    // 超时判定放在发请求之后取时间：宿主是同步返回快照、随后才 spawn npm，
    // 提示文案要等下一次轮询（≤4s）才会被 busy 分支挂上，不能把这段等待算进 12s 里
    const t0 = Date.now()
    dshFlash.err = false
    dshFlash.msg = DSH_QUERY_MSG
    for (const ms of [2000, 5000, 9000]) window.setTimeout(probe, ms)
    window.setTimeout(probe, 12000)
  } catch (err: any) {
    dshQueryFailed.value = true
    dshFlash.err = true
    dshFlash.msg = '查询失败：' + String(err?.message || err)
  }
}
// —— dsh 本地用量统计 ——
// 数据来自 dsh 自己写在 $DSH_HOME（默认 ~/.dsh）下的用量数据：优先 dsh-usage 的按天账本，
// 账本还没落盘时回落到会话投影缓存（storages/session_projcache）。纯本地读取，不需要 API Key。
const dshUsage = ref<DshUsageResult | null>(null)
const dshUsageBusy = ref(false)
const dshUsageFlash: Flash = useFlash()
const dshUsageFolds = reactive({ help: true })
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
// 实现收在 utils/format.ts 的 barHeightOf。
function dshUsageBarHeight(tokens?: number) {
  return barHeightOf(dshUsageDays.value, tokens, 2)
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
const diagnoseFolds = reactive({ help: true })
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
const dshIsolateFolds = reactive({ help: true, list: false })
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
const dshMarketFolds = reactive({ help: true, filters: false, source: false, install: false })
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
// 「值得原样再试一次」的失败（P3）。宿主按 pnpm 输出分类后回传 retryable，只有三类**瞬时**成因
// 才为真：网络抖动 / 拉取超时 / workspace 存在时的 root-add。落成独立 ref 而不是复用 allowBuilds：
// 两者的出路**相反** —— allowBuilds 要用户去改配置再点，retryable 是「什么都不用改，再点一次」，
// 混在一起会出现「既让你重试又让你改白名单」的自相矛盾指引。
// ⚠️ 只存「提示态」，不存命令本身：重试必须**重跑 dryRun**（见 dshMarketRetryNow），
//    不能拿旧 plan 直接 confirm —— 失败可能已改盘（如 root-add 被 pnpm 部分写盘），旧单据会过期。
const dshMarketRetry = ref<{ name: string; code: string } | null>(null)

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
// 卡片行内也要能看出「官方有新版本」—— 这套结论原先只在列表**上方**的汇总区
// （.mkt-latest-list）成立，卡片里只写目录版本的 `vA → vB`，两处口径不同：
// 汇总区比的是**官方 registry**（dshMarketLatestStale），卡片比的是**目录快照**
// （dshMarketUpdateOf），于是同一插件会出现「上面说能升到 0.4.3、卡片里只在 0.4.2→0.4.3 间打转」，
// 用户得在两屏之间来回对。这里把汇总区那条「已装 vX → 官方 vY」的话术复用到卡片上，
// 有官方滞后结论时优先说它（那才是用户真正想点的升级目标）。
function dshMarketOfficialText(p: DshMarketPlugin): string {
  if (!dshMarketLatestStale(p)) return ''
  const v = dshMarketLatestOf(p)
  const reg = String(v?.version || '')
  if (!reg) return ''
  const base = dshMarketBaseVer(p)
  return base ? '已装 v' + base + ' → 官方 v' + reg : '官方 v' + reg
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
  // 同 dshMarketPreviewInstall：重跑 dryRun 即换了条命令，旧的重试提示作废
  dshMarketRetry.value = null
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
// ⚠️ 两侧同版本时**整行不显示**（返回空串）：装的就是目录那一版时画成「v1.66.2 → v1.66.2」，
//    用户会以为有个自己没看出来的更新在等着，实际什么也没变。
//    注意这里判的是「两个数字相等」而不是 state —— state 为 'update' 是宿主按 semver 比的结论，
//    而展示用的是字符串版本文本，两者在构建号/前缀不同的写法下可能对不上，所以按展示值自己判一次。
function dshMarketVersionText(p: DshMarketPlugin): string {
  const u = dshMarketUpdateOf(p)
  if (!u) return ''
  const latest = String(u.latest || '')
  if (!latest) return ''
  if (u.installed) {
    if (String(u.installed) === latest) return ''
    return 'v' + u.installed + ' → v' + latest
  }
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
  // 重新生成单据 = 换了条命令，上一轮的「可重试」提示跟着作废（同 dshMarketConfirm 的理由）
  dshMarketRetry.value = null
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

// 「重试一次」—— 只对宿主判为**瞬时失败**的那几类出现（P3）。
//
// ⚠️ 为什么是重跑 dryRun 而不是直接 `dshMarketConfirm()`：失败可能已经部分改盘
//    （root-add 被 pnpm 拦下前 profile/package.json 未必一字节没动），旧 plan 的
//    「将要执行什么」就过期了。重跑 dryRun 拿到的才是当前磁盘状态下的正确单据 ——
//    既让用户再看一眼要做什么，也让宿主那两道闸（兼容性、供应链）重新过一遍。
// ⚠️ 不做自动重试：自动重试已经在宿主侧（runPnpmWithCompat）做过一次了。这里再自动一次
//    就成了「失败 → 静默重试 → 又失败 → 再静默重试」，用户只看到转圈更久，还是不知道要不要改配置。
//    把最后这一次交给用户点，是刻意的 —— 重试按钮旁边会同时显示「是什么原因、要不要改配置」。
function dshMarketRetryNow() {
  if (dshMarketBusy.value) return
  const p = dshMarketPlanPlugin()
  if (!p) {
    // 与 dshMarketForcePlan 同口径：列表被重筛过就明说，不能静默 return
    dshMarketFlash.err = true
    dshMarketFlash.msg = '找不到这条目录条目（列表可能已被筛选/重载改过），请退出市场重新进入后再试。'
    return
  }
  // 精确安装（用户查到的那一版）必须带回 targetVersion，否则会从「装 v1.65.1」悄悄变成
  // 「按目录重装」—— 与 dshMarketForcePlan 同一处坑，这里刻意用同样的分派判据
  if (dshMarketPlan.value?.exact) return dshMarketPreviewInstallExact(p, !!dshMarketPlan.value?.hostForced)
  return dshMarketPreviewInstall(p, !!dshMarketPlan.value?.hostForced)
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
  dshMarketRetry.value = null
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
  // 一动手就把上一轮的「可重试」提示收掉：它属于**上一条**命令，留着会让人以为这次也不行
  dshMarketRetry.value = null
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
        // ⚠️ 「可重试」与「要改配置」互斥（P3）：allowBuilds 是「必须先去改 pnpm 白名单」，
        //    给了重试按钮反而误导（重试一百次也还是一样的构建拦截）。宿主侧 allowBuilds 命中时
        //    retryable 本就有意义不明之处（分类器此时命中的是 unparseable-build-key，retryable=false），
        //    这里再加一道 `!ab` 保险，确保两个指引不会同时在屏幕上出现。
        // ⚠️ 宿主不兼容（hostForced 那条路的失败）也不给重试：它失败在「dsh 加载插件」这一步，
        //    不是 pnpm 的瞬时抖动，重试注定同样失败，出路是升 DSH 或回滚快照。
        const resR = r as DshMarketInstallResult
        if (resR.retryable === true && !ab && !resR.hostIncompatible) {
          dshMarketRetry.value = { name: plan.name || plan.npm, code: String(resR.failureCode || '') }
        }
        return
      }
      // 成功即清空上一轮的「可重试」提示，否则它会留在屏幕上，让用户以为这次也失败了
      dshMarketRetry.value = null
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

  // 卸载时务必停表：定时器持有组件闭包，不停会一直空跑；顺带清掉未到点的延迟刷新（见 laterStatus），
  // 设置窗关掉后这些回调不该再跑（dshNotesFastStop 的 onUnmounted 已随块迁入）
  onUnmounted(() => {
    dshPolling.stop()
    dshTickSync(false, true)
    dshMarketTickStop()
    for (const id of pendingStatusTimers) window.clearTimeout(id)
    pendingStatusTimers.clear()
  })

  // 模板与设置页脚本都要用的名字：扁平返回，调用侧直接结构解构（模板里就是 dsh / dshStatus 这种裸名）
  return {
    DSH_DUMP_PROFILE,
    DSH_ISOLATE_MAX_BATCH,
    DSH_MARKET_PAGE,
    DSH_MARKET_REGISTRIES,
    DSH_MARKET_TAIL_LINES,
    DSH_USAGE_RANGES,
    diagnose,
    diagnoseBusy,
    diagnoseCopy,
    diagnoseEnvText,
    diagnoseFlash,
    diagnoseFolds,
    diagnoseLevelCls,
    diagnoseMark,
    diagnoseMarkCls,
    diagnoseRefresh,
    diagnoseRestCount,
    diagnoseShown,
    diagnoseSummary,
    dsh,
    dshAutoDir,
    dshAutoRefresh,
    dshBackupCreate,
    dshBackupFlash,
    dshBackupFolds,
    dshBackupReasonText,
    dshBackupRefresh,
    dshBackupRestore,
    dshBackupTime,
    dshBackupToggleList,
    dshBackups,
    dshBusy,
    dshClearLog,
    dshConfirm,
    dshCopyLog,
    dshCopyUrl,
    dshCurText,
    dshDeleteConfirm,
    dshDeleteSnapshot,
    dshDo,
    dshDump,
    dshDumpBusy,
    dshDumpChangedNote,
    dshDumpCopy,
    dshDumpDiffText,
    dshDumpEntryLabel,
    dshDumpFlash,
    dshDumpFolds,
    dshDumpLayerCls,
    dshDumpLayerKindText,
    dshDumpRefresh,
    dshDumpSummary,
    dshExportBusy,
    dshExportCreate,
    dshExportFlash,
    dshExportInfo,
    dshExportLastPath,
    dshExportRefresh,
    dshExportReveal,
    dshExportSetCred,
    dshExportSetNoMod,
    dshExportSize,
    dshExportSummary,
    dshFlash,
    dshFolds,
    dshHasNotes,
    dshHasUpdateTip,
    dshIsolate,
    dshIsolateActionText,
    dshIsolateAll,
    dshIsolateBusy,
    dshIsolateConfirm,
    dshIsolateFlash,
    dshIsolateFolds,
    dshIsolateGroupBy,
    dshIsolateGroupCount,
    dshIsolateGroups,
    dshIsolateNoneDisabled,
    dshIsolatePicked,
    dshIsolatePlan,
    dshIsolatePreview,
    dshIsolateRefresh,
    dshIsolateSetGroupBy,
    dshIsolateSubLevels,
    dshIsolateSummary,
    dshIsolateTierFolds,
    dshIsolateTogglePick,
    dshIsolateToggleTier,
    dshKeepBusy,
    dshKeepDraft,
    dshLatestLabel,
    dshLatestText,
    dshLoadNotes,
    dshLocatePrefix,
    dshLogEl,
    dshLogOpen,
    dshMainFold,
    dshMaintain,
    dshMarket,
    dshMarketActionLabel,
    dshMarketAllowBuilds,
    dshMarketBaseVer,
    dshMarketBusy,
    dshMarketCatExpand,
    dshMarketCategory,
    dshMarketCategoryCount,
    dshMarketCategorySplit,
    dshMarketCategoryText,
    dshMarketCheckCompat,
    dshMarketCheckLatestPage,
    dshMarketCompatChecking,
    dshMarketCompatClass,
    dshMarketCompatCount,
    dshMarketCompatOf,
    dshMarketCompatTagText,
    dshMarketCompatTip,
    dshMarketCompatable,
    dshMarketConfirm,
    dshMarketElapsedText,
    dshMarketExactable,
    dshMarketFlash,
    dshMarketFolds,
    dshMarketForcePlan,
    dshMarketHasUpdate,
    dshMarketHitAt,
    dshMarketInstalledFold,
    dshMarketInstalledList,
    dshMarketInstalledNoteMap,
    dshMarketInstalledSummary,
    dshMarketKeyword,
    dshMarketLastCmd,
    dshMarketLatestBusy,
    dshMarketLatestOf,
    dshMarketLatestStales,
    dshMarketLatestSummary,
    dshMarketLatestTargets,
    dshMarketLatestText,
    dshMarketLatestTip,
    dshMarketList,
    dshMarketLoad,
    dshMarketLoaded,
    dshMarketLogEl,
    dshMarketLogTail,
    dshMarketOfficialText,
    dshMarketOnlyCompat,
    dshMarketOnlyUpdate,
    dshMarketPageCount,
    dshMarketPageItems,
    dshMarketPageList,
    dshMarketPageNo,
    dshMarketPending,
    dshMarketPhaseText,
    dshMarketPickSort,
    dshMarketPinText,
    dshMarketPing,
    dshMarketPingBusy,
    dshMarketPingOf,
    dshMarketPingRun,
    dshMarketPlan,
    dshMarketPreviewInstall,
    dshMarketPreviewInstallExact,
    dshMarketPreviewUninstall,
    dshMarketRefreshStatus,
    dshMarketRetry,
    dshMarketRetryNow,
    dshMarketRevealed,
    dshMarketSort,
    dshMarketSortDesc,
    dshMarketSortLabel,
    dshMarketSortTip,
    dshMarketSourceShort,
    dshMarketSourceText,
    dshMarketState,
    dshMarketStatus,
    dshMarketStatusBusy,
    dshMarketSummary,
    dshMarketTicking,
    dshMarketUpdateCount,
    dshMarketUpdateTip,
    dshMarketUseFastest,
    dshMarketVersionText,
    dshNodeText,
    dshNotes,
    dshNotesFresh,
    dshNotesLatest,
    dshNotesOk,
    dshNotesRow,
    dshNotesSummary,
    dshOpenPage,
    dshPatchFlash,
    dshPatchPending,
    dshPatchProfile,
    dshPatchToggle,
    dshPickDir,
    dshPruneNow,
    dshQueryFailed,
    dshQueryVersions,
    dshRenameCancel,
    dshRenameFor,
    dshRenameSave,
    dshRenameStart,
    dshRenameText,
    dshRestartNow,
    dshRestoreConfirm,
    dshResult,
    dshSaveKeep,
    dshSetPort,
    dshStateText,
    dshStatus,
    dshToggleAutoRefresh,
    dshToggleKnownGood,
    dshToggleNotes,
    dshToggleTrouble,
    dshToggleVersions,
    dshUsage,
    dshUsageBarHeight,
    dshUsageBusy,
    dshUsageClearCache,
    dshUsageDays,
    dshUsageFlash,
    dshUsageFolds,
    dshUsageLabelEvery,
    dshUsageModels,
    dshUsageRange,
    dshUsageRefresh,
    dshUsageSourceText,
    dshValueFlash,
    dshVerMismatch,
    dshVersionOptions,
    dshVersionsQueried,
    dshWebHint,
    fmtDshBalanceAmount,
    fmtDshBalanceAt,
    fmtDshCost,
  }
}
