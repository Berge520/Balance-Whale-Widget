<script lang="ts" setup>
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AlertRole, BubbleMeta, CodexWindow, CodexWindows, DshBackupListResult, DshBackupSnapshot, DshDiagnoseFinding, DshDiagnoseItem, DshDiagnoseResult, DshDumpResult, DshExportPreviewResult, DshHostCompatCheckResult, DshHostCompatVerdict, DshIsolateCandidate, DshIsolateCandidatesResult, DshIsolatePlan, DshMarketCatalogResult, DshMarketInstallResult, DshMarketInstalledEntry, DshMarketPingEntry, DshMarketPlugin, DshMarketRegistryLatestEntry, DshMarketRegistryLatestResult, DshMarketStatusResult, DshMarketUninstallResult, DshMarketUpdateEntry, DshPatchItem, DshPatchListResult, DshUsageResult, SharedSkinList, SharedSoundList, SkinGallery, SkinMeta, SkinPackList, SoundMeta, SoundRole, WhaleModel, WhaleModelRow, WhaleModelTemplate, WhalePriceModel, WhaleServices, WhaleTokenPrice } from './types/services'
import SkinCropper from './components/SkinCropper.vue'
import BubblePreview from './components/BubblePreview.vue'
import SoundTrimmer from './components/SoundTrimmer.vue'
import FirstRunGuide from './components/FirstRunGuide.vue'
import UsageChart from './components/UsageChart.vue'
// 卡片「全文」索引：scripts/gen-search-index.mjs 在构建期从模板提取每张卡的可见文本
// （h2 卡头 + label 字段名），搜索第三档兜底用。模板改了没重新生成会被 prebuild 拦下
import { CARD_TEXT } from './search-index.gen'
// GitHub 加速卡（含 hosts 探测 / 源表 / IP 表编辑，逻辑量在本页里数一数二）改按需异步加载：
// 它只在「帮助」Tab 才渲染，抽成独立 chunk 后 App.vue 首屏包明显变小，其余 Tab 的打开更快。
// 渲染时机不变（下面模板仍是 v-if="activeTab === 'help'"），首次切到帮助时才去取这段 JS
const AccelView = defineAsyncComponent(() => import('./views/AccelView.vue'))
// 「资源」Tab 整组（7 张卡）。含 7 张可独立命中的卡，故把 cardOn 作为 prop 传入、
// 由组件内各 section 自行判定显隐，不能在本层包一层 v-if（那样搜索态只能整组显隐）。
import AssetsView from './views/AssetsView.vue'
// 「挂件窗口」整卡。widgetFlash / 显隐 / 复位 / 复制指令 / 新增快捷键都会写与「使用帮助」
// 卡共用的消息槽，故这些函数与状态留在父级，本组件用 emit 触发。
import WindowView from './views/WindowView.vue'
// 「关于与更新」整卡。更新检查状态与 doCheckUpdate 留在父级——onMounted 里有
// 「开关开启则启动时自动检查一次」，不随卡片是否可见而跑（卡片是 v-if），故这里用 emit 触发。
import AboutView from './views/AboutView.vue'
// 「数据与隐私」整卡。清除动作与勾选项内聚在组件内，清除后要刷新父级全局状态
// （secrets / cfg / 账本 / 各素材卡片），子组件读不到，故用 emit('cleared') 交回父级做回显刷新。
import PrivacyView from './views/PrivacyView.vue'
// 「备份与恢复」整卡。导出 / 读取 / 勾选 / 恢复逻辑内聚在组件内（直接调 services.backup*）；
// 恢复成功要刷新父级全局状态（cfg / 账本 / secrets），故用 emit('applied') 交回父级做回显刷新。
import BackupView from './views/BackupView.vue'
// 「挂件外观」整卡。素材状态（skinMeta / skinFlash / soundsMeta 等）与「资源」页共用，
// 深浅色应用 / 随机形象 / 量表换算也要读父级全局，故这些都留父级，本组件按 props 收、emit 触发。
import LookView from './views/LookView.vue'
// 「用量与账本」整卡。账本快照与刷新入口（refreshHistory / refreshTodayModels）留在父级——
// 窗口聚焦 / 挂载 / 恢复备份 / 清除数据后父级都要主动刷新，故这里用 props 收、emit 触发；
// 卡片内需要父级同步结果的回填（账本截取所需数据）经 defineExpose 暴露方法，父级用模板 ref 调用。
import UsageView from './views/UsageView.vue'
// 「提醒与通知」整卡。计时时长 / 提醒开关与阈值 / 通知渠道 / SMTP 配置 / 提醒音音量 / 提醒文案
// 都内聚在组件内；applyConfig 回填后要落「未保存」基线、挂载时要读回 SMTP 凭据、备份恢复后要
// 刷新计时三段展示，这三处父级驱动，故组件用 defineExpose 暴露 syncAlertsBaseline / loadMailSecrets
// / syncTimerHms，父级用模板 ref 调用。保存 / 恢复默认提醒文案需父级整份 applyConfig，故 emit('save-alerts')。
import NotifyView from './views/NotifyView.vue'
// 「模型与余额」整卡。行内表单 / 展开态 / 删除确认 / 测试 / 刷新 / 增删改都内聚在组件内；
// 跨卡共享的运行时快照（models）、配置清单（modelConfigs）、主显示 id（modelsMainId）、
// 模板与上限、以及 fmtTokens / codexWinText 仍留父级，故按 props 下传；保存 / 删除 / 刷新后
// 需要父级 reloadModels 重新取快照，故 emit('reload')；主显示切换经 update:mainId 上抛。
import ModelsView from './views/ModelsView.vue'
// 「使用帮助」整卡：使用说明 / 快捷键绑定 / 挂件故障排查 / 挂件创建错误详情。
// 卡片自身的折叠态与诊断日志入口内聚在组件内；挂件错误状态（errDetail / errFlash）与
// checkWidgetError 由父级 onMounted、showWidget 驱动，故按 props 收、emit 触发；
// 「复制指令名 / 新增快捷键」与窗口卡共用父级消息槽，「新手引导重开」的浮层在父级模板，故均 emit。
import HelpView from './views/HelpView.vue'
// 「Codex 会话统计」整卡：读 ~/.codex/sessions 的 rollout JSONL 做统计，纯本地不联网。
// fmtTokens / codexWinText / codexDayLabel 与图表档位是跨卡共享的单一来源（模型列表行、
// dsh 用量卡也在用），按 props 下传；本卡是否有窗口数据经 emit('windows') 上抛，并入父级的
// 倒计时心跳 codexTickNeed。与其上 7 张 dsh 卡之间的 hr.group-sep 依赖 searchActive / activeTab，留父级。
import CodexView from './views/CodexView.vue'

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

// 计时到点留言长度上限，是宿主 constants.js TIMER_NOTE_MAX 的同值副本（下传给 NotifyView）
const TIMER_NOTE_MAX = 60

// 随包内置形象 id（= public/whale/ 下的图片文件名），数组顺序即「形象」下拉的顺序。
// 也是同值副本：宿主 store.js 的 BUILTIN_SKINS 与挂件页面 floating-page.js 的 BUILTIN_SKINS
// 各有一份（设置页拿不到 preload 常量），加形象要三处一起改。
// v1.7.x 起只留默认那张随包 —— 其余移出插件包、挂 Release 按需下载（见下方
// SKIN_PACK_SKINS），把插件包从约 2.7MB 压到约 1.7MB。
const BUILTIN_SKINS = ['DSniang1']
const DEFAULT_SKIN = 'DSniang1'

// 历史上曾是内置形象、现已移出插件包的 id（同值副本：宿主 store.js 的 LEGACY_BUILTIN_SKINS，
// 由 scripts/check-shared.mjs 比对）。留着是为了「不打回默认」——老用户配置里存的是这些 id，
// 下载回来之前挂件找不到文件会回退默认形象显示，但配置值本身要原样保留，
// 否则用户一下载就发现「我选的形象被改了」。
// 头一项从 BUILTIN_SKINS 展开、不重复写死（宿主那份同款写法），check-shared 两边都按展开后比对。
const LEGACY_BUILTIN_SKINS = [
  ...BUILTIN_SKINS,
  'liuy', 'black', 'ciya', 'DSniang02', 'DSniang3', 'DSniang4',
  'DSniang5', 'DSniang6', 'DSniang7', 'glby', 'Jian', 'wjztg',
]

// 可下载的内置形象（同值副本：宿主 lib/constants.js 的 SKIN_PACK_SKINS，由 check-shared.mjs
// 比对 id 清单；size 供界面显示「共约 x MB」，缩略图是下面 THUMB_* 内嵌的静态资源）。
// v1.8.0 起从 12 张精简为 1 张：其余 11 张与「共享角色包」是同图重复（那批本是用户从 QQ 群
// 挑一部分转 webp 单独打包，原图同时也在共享角色包里整包分发），一律改由共享角色包提供。
const SKIN_PACK_SKINS = [
  { id: 'DSniang02', size: 74578 },
]

// 共享角色（36 张，上游 QQ 群素材，入库 public/shared/ 按需单张下）。与宿主 lib/constants.js 的
// SHARED_SKIN_PACK_SKINS 同值（scripts/check-shared.mjs 逐项比对 id 与展示名）——
// 这里只留展示要用的 id/name，sha256 与体积由宿主那侧说了算。
// 落盘 id 是打包时生成的 ASCII 短哈希（如 s34330e4aba），中文原名只作展示。
// 缩略图随插件包分发，路径 './resources/thumbs/<id>.webp'（见 vite.config.js 的
// copyResourcesExceptSkip：只拷 thumbs/，大图入库 public/shared/ 按需单张下）。
// 不写 TS 类型标注：check-shared.mjs 用「声明名 + 等号」这个 marker 定位数组字面量
// （jsLiteral 找 marker 之后的第一个 [/{），加了 `: Array<{...}>` 会让它命中类型里的
// `{`，抽不出清单、整条比对静默跳过——那等于闸门失效。也正因如此，注释里不要出现
// 完整的声明语句，否则 indexOf 会先命中注释、同样抽错。
const SHARED_SKIN_PACK_SKINS = [
  { id: 'Q1', name: 'Q版小鲸鱼(配色1)' },
  { id: 'Q2', name: 'Q版小鲸鱼(配色2)' },
  { id: 'Q3', name: 'Q版小鲸鱼(配色3)' },
  { id: 's00f8c08fa9', name: '原版小鲸鱼(黑配色)' },
  { id: 's070d47c13b', name: '凯伊' },
  { id: 's16f0b0311b', name: '远坂凛' },
  { id: 's1a94068ae6', name: '亚丝娜' },
  { id: 's1cba53fc36', name: '优香' },
  { id: 's1e815bca0e', name: '春日野穹' },
  { id: 's34330e4aba', name: '钟离' },
  { id: 's34d8444337', name: '哥伦比亚' },
  { id: 's3fd9cc08f5', name: '诺亚' },
  { id: 's4db0fec6c4', name: '可露希尔' },
  { id: 's52b8efd026', name: '旅行者荧' },
  { id: 's52bf39e5af', name: '未解锁小鲸鱼' },
  { id: 's52fa3a3e51', name: '小鲸鱼(异色)' },
  { id: 's5df9934040', name: '莉音' },
  { id: 's68c065ada9', name: '原版小鲸鱼(呲牙)' },
  { id: 's68d2d6025c', name: '薇薇安' },
  { id: 's7303c1b0d5', name: '胡桃' },
  { id: 's74c705e8db', name: '曼波' },
  { id: 's762accf9cc', name: '阿篱（戈薇）' },
  { id: 's78bbaca4aa', name: '绪山真寻-无稽之谈' },
  { id: 's7c4c1631fb', name: '席德' },
  { id: 's80ac059dc2', name: '瓦雷莎' },
  { id: 's8995615309', name: '派蒙' },
  { id: 's8a23dfae26', name: '洛琪希' },
  { id: 's8ecaf6b8b0', name: '两仪式' },
  { id: 's98f716c60d', name: '三月七（照相机）' },
  { id: 'sbdd0f63848', name: '三月七（啥子）' },
  { id: 'sc0d50309e4', name: '原版小鲸鱼(表情)' },
  { id: 'scb3c3b976a', name: '芙宁娜' },
  { id: 'sd577294ef9', name: '睦子米' },
  { id: 'se981cc7b13', name: '鼠鼠-简' },
  { id: 'seacc9959c4', name: '原版小鲸鱼' },
  { id: 'sf16b3b9610', name: '流萤' },
]

// 避让滚动条的默认留白像素，同宿主 store.js 的 SCROLL_GAP_DEFAULT（同值副本，
// 由 scripts/check-shared.mjs 比对）
const SCROLL_GAP_DEFAULT = 17

// 吸附区宽度（可用区宽/高的百分比）范围与默认值，同宿主 store.js 的 SNAP_RATIO_*
// （同值副本，由 scripts/check-shared.mjs 比对）
// 下限 / 上限已被 WindowView.vue 随卡搬走（那里有副本），此处只留默认值
const SNAP_RATIO_DEFAULT = 25

// —— 密钥（加密存储） ——
const secrets = reactive({ apiKey: '', platformToken: '' })
// 获取教程默认折叠，点「如何获取？」按钮才展开
const guides = reactive({ apiKey: false, token: false })
// 「帮助」组里使用说明 / 故障排查的折叠态已随 HelpView 迁走
// 长卡片内部的折叠态：凭据（填一次就不动，默认收起）
const toolOpen = reactive({ credentials: false })
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
  { key: 'look', label: '外观', desc: '大小 · 形象 · 气泡与音效 · 文案' },
  // desc 只列**真实存在的卡片**、且用卡片标题的原词：此前写「形象画廊」（卡名是「导入的形象」）、
  // 又把「素材包」当并列卡列出（它其实是「资源概览」卡里的导出/导入入口，不是独立卡）→ 用户按描述找不到。
  { key: 'assets', label: '资源', desc: '资源概览 · 导入的形象 · 导入的气泡图 · 导入的音效 · 内置资源 · 共享形象 · 共享音效' },
  { key: 'usage', label: '用量', desc: '趋势与账本 · 提醒与通知 · 模型余额' },
  { key: 'window', label: '窗口', desc: '显隐 · 位置 · 透明度 · 穿透' },
  { key: 'data', label: '数据', desc: '凭据设置 · 清除数据 · 备份与恢复' },
  // 此前漏了本组的「GitHub 加速」卡（描述只列了 3 项、实际 3 张卡却少列一张）→ 用户找不到加速
  { key: 'help', label: '帮助', desc: '使用说明 · GitHub 加速 · 故障排查 · 关于与更新' },
  // desc 是 Tab 栏下方的静态说明，得与卡片的实际顺序、数量对得上：
  // 原先只列「dsh / dsh 用量 / Codex」三项，而这一页实际有 8 张卡，用户按描述找
  // 「插件开关」「插件市场」会以为不在这里。按实际顺序列全，并把非 dsh 的 Codex 单独隔开
  { key: 'dev', label: '开发者', desc: 'DeepSeek Harness（dsh）：主控 · 环境诊断 · 配置转储 · 全量导出 · 用量统计 · 插件开关 · 插件市场　｜　Codex 会话统计' },
] as const
type TabKey = (typeof TABS)[number]['key']
const activeTab = ref<TabKey>('look')
const activeTabDesc = computed(() => TABS.find((t) => t.key === activeTab.value)?.desc || '')

// —— 卡片搜索（跨 Tab 找卡片）——
// 痛点：卡片按主题分了 7 组、共 20 余张，还大量用 .fold 折叠；找一项要「先猜在哪组、再翻折叠」。
// 这里只做「卡片级」检索：命中哪张卡就跨 Tab 把这张卡单独渲染出来，不定位卡内控件（控件太多无稳定文本）。
// 索引来源是**卡片可见文本**：每张卡在模板上挂 data-search（标题 + 同义词 + 栏目名），
// 搜的是这份索引而不是实时 DOM —— 因为卡片是 v-if 渲染的，未激活的 Tab 根本没进 DOM，抓不到文本；
// 且折叠区默认收起、DOM 里也读不到里面的字。索引与模板同处一文件，改卡片时顺手改这行，不会漂移。
const searchQuery = ref('')
const searchActive = computed(() => searchQuery.value.trim().length > 0)
// 归一化：去空白、英文小写，让「API Key」「api key」「apikey」等价
function normSearch(s: string) {
  return s.toLowerCase().replace(/\s+/g, '')
}
// 卡片索引：key 与模板上的 data-search 一一对应。额外收一批「同义词 / 别称 / 英文名」——
// 用户不一定记得界面上的措辞（如搜「穿透」得能命中「挂件窗口」，搜「token」得能命中「DeepSeek 凭据」）。
const SEARCH_INDEX: Record<string, { label: string; tab: TabKey; keys: string }> = {
  credentials: { label: 'DeepSeek 凭据（API Key / 平台 Token）', tab: 'data', keys: 'apikey api key 密钥 token 令牌 凭据 授权 余额 认证' },
  // keys 覆盖守卫（build-gates）：卡内每个字段名至少要有一个 ≥2 字词出现在 label+keys 里，
  // 缺词会构建红 —— 下面各卡的「生僻字段词」（音量 / 币种 / 授权码 / 写入位置…）就是补欠账补出来的
  look: { label: '挂件外观', tab: 'look', keys: '形象 皮肤 音色 音效 音量 大小 缩放 气泡 主题 报时 点按 播放 界面 深浅色 深色 浅色 暗色 亮色 跟随 uTools 峰谷 文案 随机' },
  assetsOverview: { label: '资源概览', tab: 'assets', keys: '素材 形象 音效 气泡图 台词组 占用 体积 清除 未使用 素材包 导出 导入' },
  assetsSkins: { label: '导入的形象', tab: 'assets', keys: '形象 皮肤 图片 缩略图 置顶 删除 导入' },
  assetsBubbles: { label: '导入的气泡图', tab: 'assets', keys: '气泡 图 动图 gif 图片 导入 删除' },
  assetsSounds: { label: '导入的音效', tab: 'assets', keys: '音效 声音 按压 释放 提醒音 试听 导入 删除' },
  assetsBuiltin: { label: '内置资源', tab: 'assets', keys: '内置 形象 音色 对照 预览 下载源' },
  // 这两张卡此前漏登记：模板里有 data-search="assetsSharedSkins/SharedSounds"，
  // 但 SEARCH_INDEX 没登记 → 搜「共享」「角色」找不到，且搜索态下这两张卡永不渲染
  // （cardOn 走 searchHits，不在索引里就等于命中不了）。别再漏。
  assetsSharedSkins: { label: '共享形象', tab: 'assets', keys: '共享 角色 形象 下载 选用 预览 缩略图' },
  assetsSharedSounds: { label: '共享音效', tab: 'assets', keys: '共享 音效 声音 下载 选用 试听 角色 段' },
  quotes: { label: '文案', tab: 'look', keys: '台词 文案 台词库 提醒文案 随机 权重 报时 动图 台词组 预览 音效 条件 模板 高级编辑 富文本 行×段 试播' },
  usage: { label: '用量与账本', tab: 'usage', keys: '用量 趋势 账本 历史 区间 导出 csv 导入 校准 额度 单价 模型占比 明细 币种 汇率 保留' },
  notify: { label: '提醒与通知', tab: 'usage', keys: '提醒 通知 系统通知 邮件 smtp 预算 低余额 波动 免打扰 计时 倒计时 休息 预警 阈值 端口 ssl tls 直连 账号 授权码 发件人 收件人 主题 前缀 停留 切换' },
  models: { label: '模型与余额', tab: 'usage', keys: '模型 余额 提供商 厂商 刷新 api key 额度 主显示 密钥 凭据 token 名称 类型 币种 接口 地址 base url scale 认证 字段 路径 取值 倍数 重置 提醒 阈值' },
  window: { label: '挂件窗口', tab: 'window', keys: '窗口 显隐 位置 复位 透明度 穿透 吸附 翻转 避让 任务栏 间距 插件 滚动条 置顶 锁定 贴边 宽度' },
  help: { label: '使用帮助', tab: 'help', keys: '帮助 快捷键 使用说明 故障排查 日志 新手引导 异常 详情' },
  privacy: { label: '数据与隐私', tab: 'data', keys: '清除 数据 隐私 重置 卸载 凭据 挂件 账本 窗口 素材' },
  backup: { label: '备份与恢复', tab: 'data', keys: '备份 恢复 导出 导入 json 迁移 密码 加密 凭据' },
  dshMain: { label: 'DeepSeek Harness（dsh）', tab: 'dev', keys: 'dsh harness 启动 重启 结束 更新 版本 端口 注册源 node 日志 状态 安装 目录 命令 地址 使用' },
  dshDiagnose: { label: 'dsh 环境诊断', tab: 'dev', keys: 'dsh 诊断 环境 检查 排障 patch 冲突 端口占用' },
  dshDump: { label: 'dsh 配置转储', tab: 'dev', keys: 'dsh 配置 转储 dump 分层 默认树 差异 概览' },
  dshExport: { label: 'dsh 全量导出', tab: 'dev', keys: 'dsh 导出 zip 打包 全量 备份 来源 目录 凭据 跳过 依赖 文件夹' },
  dshUsage: { label: 'dsh 用量统计', tab: 'dev', keys: 'dsh 用量 统计 token 趋势 数据 目录 来源 会话' },
  dshIsolate: { label: 'dsh 插件开关', tab: 'dev', keys: 'dsh 插件 开关 隔离 patch 启用 禁用 写入 位置 保留' },
  dshMarket: { label: 'dsh 插件市场', tab: 'dev', keys: 'dsh 市场 插件 安装 卸载 更新 目录 数据 来源 写入 位置 关键词' },
  codex: { label: 'Codex 会话统计', tab: 'dev', keys: 'codex 会话 统计 token 用量 日志 订阅 窗口' },
  about: { label: '关于与更新', tab: 'help', keys: '关于 更新 版本 反馈 好评 市场' },
  ghAccel: { label: 'GitHub 加速', tab: 'help', keys: 'github 加速 hosts 直连 ip 刷新 源 冲突 证书 状态' },
}
// 命中卡片的 key 列表（按 SEARCH_INDEX 声明顺序，与模板中的卡片顺序不同也没关系，
// 因为搜索结果里每张卡自带栏目名，用户看得到它属于哪一组）
// 匹配口径：查询按空格拆成多词，**每个词都命中**（AND）才算命中 —— 整句includes会把
// 「界面 深色」拼成「界面深色」而关键词串里是「界面深浅色…深色」，子串断开、零命中，
// 用户输入两个词搜不到东西（2026-10-03 真实踩过）。单词行为不变。
//
// 排序三档（档内保持索引声明序，Array.prototype.sort 在现代 V8 是稳定排序）：
//   1. 标题命中 —— 所有词都出现在卡片标题里（搜「备份」时「备份与恢复」排最前）
//   2. 同义词命中 —— 所有词都出现在手工 keys 里（搜「悬浮窗」命中「挂件窗口」这类叫法映射）
//   3. 全文命中 —— 所有词都出现在卡内可见文本里（构建期从模板提取，见 search-index.gen.ts；
//      覆盖「SMTP」「透明度」这类没配同义词的卡内功能词，新卡自动跟上、不会漂移）
// 三档 AND 全灭时降级为 OR：任一词命中即收录，按命中词数排序 —— 用户多打了一个没收录的词
// （如「深色模式」的「模式」）不该得到空结果页。
// 反向子串：除「词出现在文本里」外，也认「文本里的词出现在长词里」（如输入「检查更新」
// 能靠「更新」命中）—— 只对 ≥3 字的词放宽，中文没有词边界只能这么放宽。
const searchHits = computed(() => {
  // 先拆词再归一：normSearch 会删掉所有空白，归一后再拆就永远拆不开了
  const words = searchQuery.value.toLowerCase().split(/\s+/).filter(Boolean).map(normSearch).filter(Boolean)
  if (!words.length) return []
  // 单词与目标串的命中：正向子串；词 ≥3 字时再放宽反向 —— 目标串里的词出现在长词里
  // （输入「检查更新」靠「更新」命中）。反向只对 ≥3 字的词做：2 字词反向会把「界面」
  // 这类短词放大成到处命中（任何含「面」的 2 字词都会中），噪声盖过精度。
  const hits = (w: string, hay: string) => {
    if (!w || !hay) return false
    if (hay.includes(w)) return true
    if (w.length >= 3) {
      for (let i = 0; i + 2 <= hay.length; i++) {
        const t = hay.slice(i, i + 2)
        if (t && w.includes(t)) return true
      }
    }
    return false
  }
  const titleHit: string[] = []
  const synHit: string[] = []
  const textHit: string[] = []
  // OR 兜底：key → 命中词数（AND 全灭时按此排序输出）
  const orScore = new Map<string, number>()
  for (const k of Object.keys(SEARCH_INDEX)) {
    const it = SEARCH_INDEX[k]
    const label = normSearch(it.label)
    const keys = normSearch(it.keys)
    const text = CARD_TEXT[k] || ''
    let andTitle = true
    let andSyn = true
    let andText = true
    let orN = 0
    for (const w of words) {
      const t = hits(w, label)
      const s = hits(w, keys)
      const x = t || s || hits(w, text)
      if (!t) andTitle = false
      if (!s) andSyn = false
      if (!x) andText = false
      if (x) orN++
    }
    if (andTitle) titleHit.push(k)
    else if (andSyn) synHit.push(k)
    else if (andText) textHit.push(k)
    else if (orN > 0) orScore.set(k, orN)
  }
  if (titleHit.length || synHit.length || textHit.length) return [...titleHit, ...synHit, ...textHit]
  // AND 全灭 → OR 降级：命中词数多的卡在前，同分保持声明序
  return [...orScore.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
})
// 某张卡是否应该在当前搜索态下渲染：搜索中 → 只有命中的卡渲染（跨 Tab）；非搜索态 → 沿用原 Tab 判定
function cardOn(tab: string, key: string) {
  if (searchActive.value) return searchHits.value.includes(key)
  return activeTab.value === tab
}
// 卡片在搜索结果里的来源标签（如「用量」），用于告诉用户这张卡本来在哪一组
function cardTabLabel(key: string) {
  const t = SEARCH_INDEX[key]?.tab
  return TABS.find((x) => x.key === t)?.label || ''
}
// 清空搜索：回到正常 Tab 视图。点 Tab 标签时也走它 —— 搜索态下点某个分组 = 「我不搜了，去看这一组」
function clearSearch() {
  searchQuery.value = ''
}
// 输入法组字守卫：组字期间按 Enter/Esc 是「确认候选词 / 取消组字」，不该触发输入框上挂的
// 确认 / 关闭动作（比如给快照起中文名时一回车名字就被提交了）。keyCode 229 是 IME 处理中的经典标记
function isImeComposing(e: Event | undefined) {
  const ke = e as KeyboardEvent | undefined
  return !!ke && (ke.isComposing || ke.keyCode === 229)
}
// 点命中标签 → 滚到那张卡。卡片在搜索结果里按 SEARCH_INDEX 顺序渲染，标签与之同序，
// 故直接按 key 找模板上的 data-search（跨 Tab 渲染出的卡都在 DOM 里，能选到）。
// 滚动用 scrollIntoView({block:'start'}) 把卡顶到视口顶部；吸顶的 .tab-bar 会挡住卡头，
// 故用 scroll-margin-top 预留出它的高度。高度不写死：吸顶区是「Tab 行 + 搜索框 + desc」
// 三段之和，随 desc 换行（窄窗口）而变，写死一个数就会露头或留一大截空白 ——
// 由下面的 ResizeObserver 实测后写进 --tab-bar-h，.card 的 scroll-margin-top 读它。
const tabBarEl = ref<HTMLElement | null>(null)
let tabBarRO: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !tabBarEl.value) return
  tabBarRO = new ResizeObserver((entries) => {
    const h = entries[0]?.contentRect.height || 0
    // +8 是吸顶条与卡顶之间留的一道缝，不然卡头会紧贴吸顶条下沿
    document.documentElement.style.setProperty('--tab-bar-h', `${Math.round(h) + 8}px`)
  })
  tabBarRO.observe(tabBarEl.value)
})
onUnmounted(() => {
  if (tabBarRO) { tabBarRO.disconnect(); tabBarRO = null }
})
function scrollToCard(key: string) {
  const el = document.querySelector(`[data-search="${key}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // 定位闪烁：滚过去之后让卡亮一下，视线能立刻接住「滚到哪了」（样式在 main.css 全局段，
  // 因为 ghAccel 卡在异步组件 AccelView 里，scoped 规则够不到它）。
  // 连点同一张卡也要重闪：先摘类再强制 reflow，动画才能从头跑（同类名挂着时 animation 不会重启）
  el.classList.remove('search-flash')
  void (el as HTMLElement).offsetWidth
  el.classList.add('search-flash')
  el.addEventListener('animationend', () => el.classList.remove('search-flash'), { once: true })
}
// 平台判定：仅用于 dev Tab 里那几处 Windows 专属文案（Hyper-V 端口段 / UAC 提权）。
// 宿主 preload 不往页面透传平台，uTools 在渲染进程直接可用（本文件已有 utools.dbStorage 用法）。
// 取不到时按非 Windows 处理：这些文案只在 Windows 才成立，宁可不显示也不误导。
const IS_WIN = (() => { try { return utools.isWindows() } catch (err) { return false } })()

// 深浅色判定：生效值 = uiMode 合成（auto 取 uTools 实际值，手动 light/dark 直接用偏好）。
// uTools 实际值来自 utools.isDarkColors()，不跟系统 —— main.css 的 html.dark 系列规则是消费端。
// uTools 没有主题变更事件/API，只能轮询；isDarkColors 是同步布尔读，开销可忽略。
// 轮询间隔取 1s：auto 模式下 uTools 主题切换后最迟 1s 跟上，体感即时。
function applyUtoolsDark() {
  let utoolsDark = false
  try { utoolsDark = !!utools.isDarkColors() } catch (err) { /* 非 uTools 环境按浅色 */ }
  const dark = cfg.uiMode === 'auto' ? utoolsDark : cfg.uiMode === 'dark'
  document.documentElement.classList.toggle('dark', dark)
}
// 注意：applyUtoolsDark 不能在这里立即调用 —— 它读 cfg.uiMode，而 cfg 在下方才声明，
// 先调用会撞 TDZ（ReferenceError），整个 <script setup> 崩掉、设置页白屏（2026-10-03 踩过）。
// 启动调用与轮询定时器挪到 cfg 声明之后。
// 下拉改动：本地立即应用一次再落库 —— 等下一轮轮询或配置回推才变化，会让人以为没生效
function onUiModeChange(mode: string) {
  // 下拉改动：本地立即应用一次再落库 —— 等下一轮轮询或配置回推才变化，会让人以为没生效
  cfg.uiMode = mode === 'light' || mode === 'dark' ? mode : 'auto'
  applyUtoolsDark()
  patchCfg({ uiMode: cfg.uiMode })
}
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
  // 提醒音独立音量（volSet=false = 未动过滑块，跟随全局音量；拖动即置 true，「恢复默认」复位）
  alertVols: {
    low: { vol: 1, volSet: false },
    budget: { vol: 1, volSet: false },
    peak: { vol: 1, volSet: false },
    pass: { vol: 1, volSet: false },
  },
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
  // 界面深浅色：'auto' 跟 uTools / 'light' / 'dark'（设置页与挂件面板共用；与气泡主题是两条线）
  uiMode: 'auto',
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
  // 形象素材包下载源：用户自填的加速前缀（如 'https://ghfast.top/'），空 = 只用内置候选链
  // （默认 ghfast.top → 直连 github.com 兜底）。与 ghAccelSrc 无关，只作用于「按需下载形象」
  skinPackSrc: '',
  // 「随机」抽签是否把随包内置形象算进池子（默认算）。关掉后池子只剩用户勾选参与随机的项
  randomIncludeBuiltin: true,
  // 通知渠道：系统通知（默认开）+ 邮件通知（默认关，需先配 SMTP）。
  // 邮件的收发件人/显示名/主题前缀属于「配置」进这里；服务器、账号、授权码属于凭据，走 mail 表单
  notifySystemOn: true,
  notifyMailOn: false,
  mailFrom: '',
  mailTo: '',
  mailFromName: '小鲸鱼余额挂件',
  mailSubjectPrefix: '[小鲸鱼余额挂件]',
})
// 深浅色启动应用 + 轮询（必须在 cfg 声明之后：applyUtoolsDark 读 cfg.uiMode，见上方 TDZ 注释）
applyUtoolsDark()
const darkPollTimer = window.setInterval(applyUtoolsDark, 1000)
onUnmounted(() => { window.clearInterval(darkPollTimer) })
// 「提醒与通知」卡片的模板 ref：applyConfig 回填后要落「未保存」基线、挂载时要读回 SMTP 凭据、
// 备份恢复 / 挂件菜单推送后要刷新计时三段展示 —— 这三处都由父级生命周期驱动，故用 ref 调组件暴露的方法。
// 保存 / 恢复默认提醒文案要先写配置再整份 applyConfig 回读，涉及父级 onConfigChange 通路，故仍留父级。
const notifyViewRef = ref<{ syncAlertsBaseline: () => void; loadMailSecrets: () => void; syncTimerHms: () => void } | null>(null)
// 提醒文案保存 / 恢复默认：子组件整理好整份内容（或 null = 恢复默认）上抛，这里落盘并回读。
// 与父级 patchCfg 同口径直接调用（宿主 saveConfig 是可选调用，失败由宿主侧留痕），子组件负责回显结果
function onSaveAlerts(alerts: Record<string, string> | null) {
  patchCfg({ alerts })
  applyConfig(services.getConfig?.())
}
const widgetVisible = ref(true)
const widgetFlash: Flash = useFlash()
// 挂件错误查看：errDetail 为宿主记录的最后一条创建/加载错误，空串表示无错误
const errDetail = ref('')
const errFlash: Flash = useFlash()
// 诊断日志入口与它的消息槽已随 HelpView 迁走

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
  // 勾了「自动刷新版本」就每次进 Tab 重查一次：与手动点「重新查询」同一入口（dshQueryVersions），
  // busy 由宿主快照带回、按钮自身禁用，查询期间重复进 Tab 会被 dshDo 的 busy 拦截，不会叠发 npm view
  if (dshAutoRefresh.value && dsh.busy !== 'versions' && !dshQueryFailed.value) dshQueryVersions()
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
        // 说明的取数在宿主侧已挂在 listVersions 结束时（宿主那侧是 force），这里不再补一刀：
        // 设置页拿不到版本列表，没法自己判断区间是否已取全，重复触发只会多打一趟网络
        return
      }
      // 查到「没有可用版本」也是有效结论：不再自动重查，但保留「重试」入口
      if (dshVersionsCode.value === 'empty') { dshQueryFailed.value = true; return }
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

// —— Codex 本地会话统计 ——
// 数据来自 ~/.codex/sessions 下的 rollout JSONL（Codex CLI 自己写的明文日志），
// 纯本地读取，不需要 API Key，也不发任何网络请求。
// 卡片本体已迁至 CodexView.vue；下面只保留跨卡共享的展示函数（模型列表行的 codex 行、
// dsh 用量卡、CodexView 都在用）与倒计时心跳。CodexView 有无窗口数据经 emit('windows') 上抛。
const codexHasWindows = ref(false)
function onCodexWindows(has: boolean) {
  codexHasWindows.value = !!has
}
// token 数按万/亿缩写，避免长串数字撑破布局
function fmtTokens(n?: number) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万'
  return String(v)
}
// 'YYYY-MM-DD' → 'M-D'（图表横轴，省宽度）
function codexDayLabel(date: string) {
  const p = String(date || '').split('-')
  return p.length === 3 ? Number(p[1]) + '-' + Number(p[2]) : date
}
// —— Codex 订阅窗口（5h / 周）——
// ChatGPT 订阅的 Codex 会在 token_count 事件里带 rate_limits 快照（API-key 计费没有这份数据），
// 窗口是账号级状态，与本地 token 统计各自独立，所以单独一行展示。
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

// —— 用量趋势 ——
// 卡片本体（区间切换 / 图表 / 本月汇总 / 明细 / 额度 / 模型占比 / 校准）都在 UsageView.vue，
// 这里只保留「父级生命周期与其它卡片也要用到的」部分：账本快照（usageHistory / usageCurrency，
// 通知卡与清除数据后回显也要读）、金额格式化、拉取入口（窗口聚焦 / 挂载 / 恢复备份后要主动刷新）。
const usageViewRef = ref<{ applyHistory: (h: any) => void; refreshTodayModels: () => void } | null>(null)
const usageHistory = ref<Array<{ date: string; usage: number }>>([])
const usageCurrency = ref('CNY')
function fmtMoney(v: number) {
  const num = Number(v) || 0
  return usageCurrency.value === 'CNY' ? '¥ ' + num.toFixed(2) : num.toFixed(2) + ' ' + usageCurrency.value
}
// 用量趋势：令牌模式下挂件刷新后今日总量会写入账本，
// 因此导入后、切用量模式、以及本窗口重新获得焦点时都要重新拉一次趋势。
// 一次拉满保留天数（宿主上限），区间截取与图表渲染都在 UsageView 内做。
function refreshHistory() {
  const h = services.getUsageHistory?.(cfg.historyKeepDays)
  if (h && Array.isArray(h.days)) {
    usageHistory.value = h.days
    usageCurrency.value = h.currency || 'CNY'
  }
  // 卡片内的「今日额外变动 / 累计已用 / 明细」也要回填（父级是这些数据的唯一入口）
  usageViewRef.value?.applyHistory(h)
}
// 卡片内的模型占比拉取：父级在窗口聚焦 / 挂载后要主动触发一次
function refreshTodayModels() {
  usageViewRef.value?.refreshTodayModels()
}

// —— 多厂商模型（余额 / 额度） ——
// 列表第一行是内置 DeepSeek（余额走原有链路，不可编辑/删除），其余来自 config.models。
// 余额与额度是宿主的运行时快照（whale:models），不进配置也不进备份，所以每次都要现取。
const models = ref<WhaleModelRow[]>([])
const modelConfigs = ref<WhaleModel[]>([])
const modelsMainId = ref('deepseek')
const modelTpls = ref<Record<string, WhaleModelTemplate>>({})
const modelMax = ref(10)
// 新增草稿的哨兵行 id：模型列表里过滤掉它（ModelsView 内用同名常量渲染草稿行）
const NEW_MODEL_ROW = '__new'
// Codex 订阅窗口的重置倒计时心跳：卡片与模型列表行都用到，任一处有窗口数据就跑（30s 一跳，
// 够分钟级显示用）。放在 models 之后是因为要读它，写在前面会踩 const 的 TDZ
const codexTickNeed = computed(() => codexHasWindows.value ||
  models.value.some((m) => m.kind === 'codex' && !!m.codexWindows))
const codexNow = ref(Date.now())
let codexTickTimer = 0
watch(codexTickNeed, () => {
  if (codexTickNeed.value && !codexTickTimer) codexTickTimer = window.setInterval(() => { codexNow.value = Date.now() }, 30000)
  else if (!codexTickNeed.value && codexTickTimer) { window.clearInterval(codexTickTimer); codexTickTimer = 0 }
}, { immediate: true })
function reloadModels() {
  const r = services.getModels?.()
  if (r && Array.isArray(r.list)) {
    models.value = r.list
    modelsMainId.value = r.mainModelId || 'deepseek'
  }
  modelConfigs.value = services.getModelsConfig?.() || []
}
// ModelsView 内部已调 services.setMainModel 并回传宿主结果，这里只同步共享的 modelsMainId
function onModelsMainChange(id: string) {
  modelsMainId.value = id || 'deepseek'
}
function loadModelTemplates() {
  const r = services.getModelTemplates?.()
  if (!r) return
  modelTpls.value = r.templates || {}
  modelMax.value = Number(r.max) || 10
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
// 大小输入：LookView 用 :value 绑定（不直接改 cfg），把数值 emit 上来，这里落 cfg 并落盘。
// 拖动中只改窗口几何不写存储（__live），松手/失焦才一次性持久化。
function onScaleLive(v: number) {
  const s = Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(v))) * 10) / 10
  cfg.scale = s
  cfg.scaleNum = scaleToNum(s)
  services.saveConfig?.({ scale: s, __live: true })
}
function onScaleNumLive(v: number) {
  cfg.scaleNum = v
  const s = numToScale(v)
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
// —— 自定义音效（按压/释放两段 + 四类提醒各一组，文件复制进本地数据目录） ——
// 每个槽位只保留一段：再导入就是替换掉旧的（挂件端不再有「随机播」这回事）
// 同值副本：preload 不参与打包，设置页读不到宿主常量（见 public/preload/lib/sounds.js 的 ROLES / ROLE_LABEL）
const SOUND_ROLES: SoundRole[] = ['press', 'release', 'low', 'budget', 'peak', 'pass']
// 四类提醒各自的提醒音：留空 = 静音（没有内置回落，不打扰是默认），导入后跟随音效开关与音量
// 类型是 SoundRole 的提醒子集：它们还要索引 cfg.alertVols（音色两段没有独立音量）
const ALERT_SOUND_ROLES: AlertRole[] = ['low', 'budget', 'peak', 'pass']
const SOUND_ROLE_LABEL: Record<SoundRole, string> = {
  press: '按压音效', release: '释放音效',
  low: '低余额提醒音', budget: '预算提醒音', peak: '峰谷提醒音', pass: '穿透提醒音',
}
// 六槽位统一初始化：宿主返回值缺键时也保证是空值（模板里到处取值）
function blankSoundMap<T>(fill: T): Record<SoundRole, T> {
  const out = {} as Record<SoundRole, T>
  for (const r of SOUND_ROLES) out[r] = fill
  return out
}
const soundsMeta = ref(blankSoundMap<SoundMeta[]>([]))
// 共享音效库段清单（台词组「组级音效」下拉的选项来源）。soundsMeta 只装 SOUND_ROLES 六个实播
// 槽位，shared 不在其中，单独放一份——由 refreshSounds 统一填充，跟槽位元信息同批刷新
const sharedSounds = ref<SoundMeta[]>([])
// 音效本体（base64 data URL）只用于「试听」：元信息里只有文件名，播不了
const soundData = ref(blankSoundMap<string[]>([]))
const soundFlash: Flash = useFlash()
// 试听实例放在模块级：再点「试听」先停掉上一个，避免两段音频叠在一起
let previewAudio: HTMLAudioElement | null = null
// 当前实例的收尾回调（自然放完 / 被停掉时调用），见 playAudioUrl
let previewOnDone: (() => void) | null = null
// 波形裁剪弹层：非空时显示（选文件 → 裁剪 → 确认后才落盘）
const soundTrim = ref<{ dataUrl: string; name: string; role: SoundRole } | null>(null)
// 模板里取某个槽位的元信息：直接写 soundsMeta[r] 的索引访问收窄不稳，统一走这个小函数
function soundMetaOf(role: SoundRole): SoundMeta[] {
  return soundsMeta.value[role] || []
}
// 槽位概览文案：报该槽位当前那段的名字（空则回空串）。
// 每个槽位最多一段，所以不再有「首个 等 N 段」的分支 —— 那种写法在两段同名时会拼成
// 字面量「来财 等 2 段」，读着像一个叫「来财等2段」的音效，是块旧伤。
// 为兼容用户升级前存下的多段数据（旧 meta 里可能仍有 2 段），这里只取第一段展示。
function soundLabel(role: SoundRole): string {
  const list = soundMetaOf(role)
  return list.length ? list[0].name : ''
}
function refreshSounds() {
  const m = services.getSounds?.()
  const next = blankSoundMap<SoundMeta[]>([])
  if (m) for (const r of SOUND_ROLES) next[r] = m[r] || []
  soundsMeta.value = next
  sharedSounds.value = (m && Array.isArray(m.shared)) ? m.shared : []
  const d = services.getSoundData?.()
  const nextData = blankSoundMap<string[]>([])
  if (d) for (const r of SOUND_ROLES) nextData[r] = d[r] || []
  soundData.value = nextData
}
// 停止试听。onDone 是当前实例的收尾回调（见 playAudioUrl）：停掉时也要调用，
// 否则「试听中」的状态标记会留在界面上，按钮一直显示「停止」。
function stopPreviewSound() {
  const el = previewAudio
  if (!el) return
  previewAudio = null
  const done = previewOnDone
  previewOnDone = null
  try { el.pause() } catch (err) {}
  if (done) done()
}
// 试听一段音频（自定义音效与内置音色共用）：错误写进传入的消息态，各自卡片里显示。
// onDone 在自然放完 / 被 stopPreviewSound 打断时各调一次，供调用方清「正在播哪一段」的标记。
function playAudioUrl(url: string, flash: Flash, onDone?: () => void) {
  stopPreviewSound()
  try {
    const el = new Audio(url)
    el.volume = Math.min(1, Math.max(0, cfg.vol))
    previewAudio = el
    previewOnDone = onDone || null
    // 只有「当前实例」才清状态：用户连点两段时，先一段的 ended 会晚于 stopPreviewSound 触发，
    // 不加这层判断会把后一段的状态标记误清掉，按钮刚亮又灭。
    el.onended = () => {
      if (previewAudio === el) { previewAudio = null; previewOnDone = null }
      if (onDone) onDone()
    }
    // play() 是 Promise：解码失败或被自动播放策略拦下时给个提示，不要静默
    el.play().catch((err: any) => {
      flash.err = true
      flash.msg = '试听失败：' + String(err?.message || err)
      if (previewAudio === el) { previewAudio = null; previewOnDone = null }
      if (onDone) onDone()
    })
  } catch (err: any) {
    flash.err = true
    flash.msg = '试听失败：' + String(err?.message || err)
    if (onDone) onDone()
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
// 账本历史保留天数改动：宿主按这个窗口裁剪与返回数据，改完要重新取一次。
// 区间收敛（超出新窗口的区间收回到可选范围）随 usageRange / usageRangeTabs 一起搬进 UsageView，
// 由子组件 watch(cfg.historyKeepDays) 自行处理，这里不再重复
function onHistoryKeepChange() {
  const n = Number(cfg.historyKeepDays)
  const v = isFinite(n) ? Math.round(Math.min(HISTORY_KEEP.MAX, Math.max(HISTORY_KEEP.MIN, n))) : HISTORY_KEEP.DEFAULT
  cfg.historyKeepDays = v
  patchCfg({ historyKeepDays: v })
  refreshHistory()
}

// —— 自定义挂件形象画廊（多张图片，复制进本地数据目录） ——
const skinGallery = ref<SkinGallery>({ current: '', items: [] })
// 当前正在使用的那张的元信息（画廊为空时 null）
const skinMeta = computed<SkinMeta | null>(() => {
  const g = skinGallery.value
  return g.items.filter((it) => it.id === g.current)[0] || null
})
// 当前选中的那些（「置顶 / 删除 / 参与随机」三个卡头动作的作用对象）。
// 与 skinGallery.current（正在使用的那张）是两回事：选中只是「接下来要操作它们」，
// 单击缩略图 = 切换选中，双击 = 切换使用 —— 这样动作不必每张图各挂一套按钮。
const skinPicked = ref<string[]>([])
// 选中项被删掉 / 列表刷新后可能已不存在，用它安全回退（返回值即「仍存在的选中项」，交给宿主时不会带脏 id）
const pickedSkinned = computed(() => {
  const ids = skinPicked.value
  return skinGallery.value.items.filter(it => ids.indexOf(it.id) >= 0)
})
const skinFlash: Flash = useFlash()
// 缩略图加载失败的格子（键是 item.id）：宿主把缩略图读成 data URL 给出后，浏览器端仍可能解码失败
// （落盘文件被外部删掉、data URL 被截断、动图格式浏览器不认）。不记这一笔的话，img 加载失败就是一块空白格 ——
// 用户看到「这张没有预览」却不知道其实坏在读取环节，这正是一堆格子显示「无预览」的观感来源
const thumbBroken = reactive<Record<string, boolean>>({})
// 「导入的形象」卡片底部操作说明的展开态：默认收起，把「当前使用 + 随机规则」压成一行，
// 免得 30+ 格的画廊下面再堆三行说明
const skinHintOpen = ref(false)
// 批量随机设置（卡片内「随机设置」下拉的各项动作）：组件只转发，落到 doBatchSkinRandom
function doBatchRandom(mode: 'all' | 'none' | 'keepCurrent') {
  doBatchSkinRandom(mode)
}
// 裁剪弹层：非空时显示（选图片 → 裁剪 → 确认后才落盘）
const skinCrop = ref<{ dataUrl: string; name: string } | null>(null)
function refreshSkin() {
  const g = services.listSkins?.()
  skinGallery.value = g && Array.isArray(g.items) ? g : { current: '', items: [] }
  // 重新拉过一轮列表，之前那批「坏图」标记要清掉 —— 否则补上缩略图 / 重新导入同 id 后仍显示坏图提示
  for (const k of Object.keys(thumbBroken)) delete thumbBroken[k]
  backfillMissingThumbs()
}
// 懒补缩略图（老数据升级用）：v1.9.x 早先版本下载共享角色时没落缩略图，listSkins 只能回落读原图
// （0.9~2.7MB 一张，8MB 回落预算撑不过 4 张），后面的项全显示「无预览」。
// 设置页手上有打包好的 resources/thumbs/<id>.webp，哪张缺就补哪张 —— 补完再刷新一次列表，
// 让回落那几张换成几 KB 的缩略图。只跑一轮（补完 refreshSkin 再进来时列表里已都有 thumb，直接返回）。
// 不打 flash / 不报错：这是后台自愈动作，读不到资源就算了（回落原图仍能显示），不该打扰用户。
const backfillingThumbs = ref(false)
function backfillMissingThumbs() {
  const missing = skinGallery.value.items.filter(it => !it.thumb && it.builtin === true)
  if (!missing.length || backfillingThumbs.value) return
  backfillingThumbs.value = true
  Promise.all(missing.map(async (it) => {
    const url = await sharedSkinThumbDataUrl(it.id)
    if (url) services.setSkinThumb?.(it.id, url)
  })).then(() => {
    backfillingThumbs.value = false
    const g = services.listSkins?.()
    if (g && Array.isArray(g.items)) skinGallery.value = g
  })
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
// 随机换一张形象。抽签池 = 画廊里所有「未取消参与随机」的项（含用户自己导入的），
// 再加上随包内置那张 —— 但内置是否参与由「内置形象也参与随机」开关决定（默认参与）。
// 抽签用全集：内置 id（仅在开关打开时）去重后合并画廊里参与随机的项
const allSkinChoices = computed(() => {
  const out: string[] = []
  if (cfg.randomIncludeBuiltin !== false) {
    for (const s of BUILTIN_SKINS) if (out.indexOf(s) < 0) out.push(s)
  }
  for (const it of skinGallery.value.items) {
    if (it.random !== false && out.indexOf(it.id) < 0) out.push(it.id)
  }
  return out
})
function doRandomSkin() {
  const pool = allSkinChoices.value.filter(s => s !== cfg.skin)
  if (!pool.length) {
    // 池子只剩当前这张：要么总共只有一张，要么其它张都退出了随机池 —— 明确说明而非静默不动。
    // 文案与整理面板里「全部参与随机」对齐，让用户知道去哪加回来。
    const galleryCount = skinGallery.value.items.length
    skinFlash.msg = allSkinChoices.value.length <= 1
      ? (cfg.randomIncludeBuiltin === false
        ? '随机池是空的：内置形象没参与、画廊里也没有参与随机的项，用「整理 → 全部参与随机」加回来'
        : '只有一张形象可随机，先多下载或导入几张')
      : `其它 ${galleryCount - 1} 张都未参与随机，用「整理 → 全部参与随机」加回来`
    skinFlash.err = true
    return
  }
  skinFlash.msg = ''
  skinFlash.err = false
  const pick = pool[Math.floor(Math.random() * pool.length)]
  // 顺序要紧：先让宿主把 current 切到 pick，成功后再写配置。
  // 反过来（先写 cfg.skin 再切）一旦 setSkinCurrent 失败，配置说用 A、宿主 current 还是 B，
  // 挂件仍显示 B、刷新后选择器又被拉回旧值 —— 这正是「随机了挂件不换 / 又变回内置」的根因。
  if (skinGallery.value.items.some(it => it.id === pick)) {
    const r = services.setSkinCurrent?.(pick)
    if (!r || !r.ok) {
      skinFlash.err = true
      skinFlash.msg = '随机失败：' + ((r && r.error) || '无法切换形象')
      return
    }
    refreshSkin()
    cfg.skin = 'custom'
    patchCfg({ skin: cfg.skin })
  } else {
    // 抽到内置：直接把配置切到那个内置 id（无需动宿主 current）
    cfg.skin = pick
    patchCfg({ skin: pick })
  }
  const label = pick === 'custom' ? '自定义' : (
    skinGallery.value.items.filter(it => it.id === pick)[0]?.name || pick
  )
  skinFlash.msg = '已随机到「' + label + '」'
}
// 开关：内置（随包）形象是否也算进随机池。只影响后续抽签，不动当前这张。
function onToggleIncludeBuiltin(on: boolean) {
  cfg.randomIncludeBuiltin = on
  patchCfg({ randomIncludeBuiltin: on })
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
// 点缩略图 = 切换选中（卡头「整理」面板里「选中的 N 张」那一段作用于这批），再点一次取消选中。
// 与「切换使用」分开：切换改走双击（见 doUseSkinPick），这样每张图不必再挂按钮。
// 多选：图片够多时「删掉这几张旧图」要比一张张点快得多，所以选中态是个集合而非单个。
function pickSkin(id: string) {
  const i = skinPicked.value.indexOf(id)
  if (i >= 0) skinPicked.value.splice(i, 1)
  else skinPicked.value.push(id)
}
// 双击缩略图 = 切换使用（原来单击干的事）
function doUseSkinPick(id: string) {
  skinPicked.value = [id]
  doUseSkin(id)
}
// 整理面板「使用选中的」：单击选中后承接「切换使用」，不必再双击。
// 双选时取最后点中的那张（skinPicked 是数组，取末位即最近一次选择，符合「刚点的那张」直觉）
function doUsePicked() {
  const picked = pickedSkinned.value
  if (!picked.length) { skinFlash.err = true; skinFlash.msg = '先点一下缩略图选中它，再切换使用'; return }
  doUseSkinPick(picked[picked.length - 1].id)
}
// 卡头「移到最前 / 移到最后」：把选中的这几张按画廊顺序整体搬到一端。
// 置底的落点写 items.length 而不是 length-1：doMoveSkins 内部是「先剔除再插到第 want 个」，
// 剔除后列表短了一截，传入原先的总长度会被它夹到 rest.length（即真正的末尾）。
function doPinPicked() {
  const picked = pickedSkinned.value
  if (!picked.length) { skinFlash.err = true; skinFlash.msg = '先点几张缩略图选中它们，再置顶'; return }
  doMoveSkins(picked.map(it => it.id), 0, 'top')
}
function doBottomPicked() {
  const picked = pickedSkinned.value
  if (!picked.length) { skinFlash.err = true; skinFlash.msg = '先点几张缩略图选中它们，再置底'; return }
  doMoveSkins(picked.map(it => it.id), skinGallery.value.items.length, 'bottom')
}
// 卡头「删除」：一次删掉选中的这几张，删完清空选中
function doRemovePicked() {
  const picked = pickedSkinned.value
  if (!picked.length) { skinFlash.err = true; skinFlash.msg = '先点几张缩略图选中它们，再删除'; return }
  doRemoveSkins(picked.map(it => it.id))
  skinPicked.value = []
}
// 参与随机点名的「应用」：把选中的这几张一次性设为参与 / 不参与
// （与「整理」下拉里「全部」那段的批量动作同源，都走 setSkinRandomBatch 一次写盘）
function applyPickedRandom(on: boolean) {
  const picked = pickedSkinned.value
  if (!picked.length) { skinFlash.err = true; skinFlash.msg = '先点几张缩略图选中它们，再点这里'; return }
  const map: Record<string, boolean> = {}
  for (const it of picked) map[it.id] = on
  try {
    const r = services.setSkinRandomBatch?.(map)
    if (!r || !r.ok) {
      skinFlash.err = true
      skinFlash.msg = '应用失败：' + ((r && r.error) || '未知错误')
      return
    }
    refreshSkin()
    skinFlash.err = false
    skinFlash.msg = `已把 ${picked.length} 张设为${on ? '参与' : '不参与'}随机（现共 `
      + `${skinGallery.value.items.filter(it => it.random !== false).length} / ${skinGallery.value.items.length} 张参与）`
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '应用失败：' + String(err?.message || err)
  }
}
// 调整画廊顺序（可批量）：把 ids 里的项按原相对顺序整体搬到 index 落点，不影响正在使用的那张。
// 调用方：置顶（index=0）/ 置底（index=items.length）/ 拖拽（落点下标，组件内算好），
// 见 doPinPicked / doBottomPicked。
// 关键：**本地先重排（乐观更新），不调 refreshSkin()**。
// 每动一次就整屏重建列表的话，会闪一下、悬停态丢失，鼠标停的位置还可能换成另一张，根本没法连点。
// 这里只把 items 数组重新排一次 —— Vue 以 it.id 为 key 复用 DOM，只有顺序变化被 patch。
// 宿主成功即完事；失败才回滚 + 重新拉列表兜底。
// （宿主 moveSkin 还支持 'up' / 'down' 上下挪一格，但前端已改用拖拽排序，不再产生这两个值）
//
// label 只影响提示文案：同一个「没变化」的结果，置顶说「已经在最前一张」、置底说「已经在最后一张」，
// 不传就退化成中性说法（拖拽落点用）。
function doMoveSkins(ids: string[], index: number, label?: 'top' | 'bottom') {
  skinFlash.msg = ''
  skinFlash.err = false
  const before = skinGallery.value.items
  const set: Record<string, boolean> = {}
  // 允许传进「已被删掉 / 不在列表里」的 id，这里顺手滤掉，省得宿主为一个脏 id 整批失败
  for (const id of ids) if (before.some(it => it.id === id)) set[id] = true
  const movingCount = Object.keys(set).length
  if (!movingCount) return
  // 先筛出要搬的那批（保持画廊顺序），再把剩下的与它们拼接 —— 单张置顶 / 批量置顶共用这一段
  const moving = before.filter(it => set[it.id])
  const rest = before.filter(it => !set[it.id])
  const want = Math.max(0, Math.min(Number(index) || 0, rest.length))
  if (moving.length === before.length) {
    skinFlash.msg = '选中的就是全部，无需调整'
    return
  }
  const next = rest.slice(0, want).concat(moving, rest.slice(want))
  // 顺序没变就别白写盘（如单张已在该位置）
  if (next.every((it, i) => it.id === before[i].id)) {
    skinFlash.msg = movingCount > 1 ? '顺序已是这样，无需调整'
      : label === 'top' ? '已经在最前一张'
      : label === 'bottom' ? '已经在最后一张'
      : '位置没有变化'
    return
  }
  // 乐观更新：先动本地数组，用户立刻看到新顺序
  skinGallery.value = { ...skinGallery.value, items: next }
  try {
    const r = services.moveSkins?.(moving.map(it => it.id), want)
    if (!r || !r.ok) {
      skinFlash.err = true
      skinFlash.msg = '调整顺序失败：' + ((r && r.error) || '未知错误')
      refreshSkin()  // 回滚成宿主真值
      return
    }
    // 宿主把落点夹回合法范围后可能与本地算的不同（并发改动），以宿主返回的 index 为准校一次
    if (typeof r.index === 'number' && r.index !== want) refreshSkin()
    const name = moving[0]?.name || '形象'
    if (movingCount === 1) {
      skinFlash.msg = label === 'bottom' ? `已把「${name}」移到最后` : `已置顶「${name}」`
    } else {
      skinFlash.msg = label === 'bottom' ? `已把 ${movingCount} 张移到最后` : `已把 ${movingCount} 张移到最前`
    }
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '调整顺序失败：' + String(err?.message || err)
    refreshSkin()
  }
}
// 批量改「参与随机」：mode = all（全启用）/ none（全停用）/ keepCurrent（只留当前使用那张）。
// 走宿主的 setSkinRandomBatch —— 整张清单只读改写盘一次；逐张改会做 N 次全量读改写盘
// （37 张 = 37 次），这里不再那么干。
function doBatchSkinRandom(mode: 'all' | 'none' | 'keepCurrent') {
  skinFlash.msg = ''
  skinFlash.err = false
  const items = skinGallery.value.items
  if (!items.length) return
  const map: Record<string, boolean> = {}
  for (const it of items) {
    if (mode === 'all') map[it.id] = true
    else if (mode === 'none') map[it.id] = false
    else map[it.id] = it.id === skinGallery.value.current
  }
  try {
    const r = services.setSkinRandomBatch?.(map)
    if (!r || !r.ok) {
      skinFlash.err = true
      skinFlash.msg = '批量设置失败：' + ((r && r.error) || '未知错误')
      return
    }
    refreshSkin()
    skinFlash.msg = mode === 'all' ? '已全部设为参与随机'
      : mode === 'none' ? '已全部取消随机' : '已只保留当前使用那张参与随机'
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '批量设置失败：' + String(err?.message || err)
  }
}
// 一次删掉多张（卡头「删除」作用于选中的那批）：走宿主 removeSkins —— 一趟读改写盘删完，
// 逐张调 removeSkin 会做 N 次全量读改写盘，删 10 张就是 10 趟。
function doRemoveSkins(ids: string[]) {
  skinFlash.msg = ''
  skinFlash.err = false
  try {
    const r = services.removeSkins?.(ids)
    if (!r || !r.ok) {
      skinFlash.err = true
      skinFlash.msg = '删除失败：' + ((r && r.error) || '未知错误')
      return
    }
    skinFlash.msg = `已删除 ${r.removed ?? ids.length} 张形象`
    refreshSkin()
    // 删掉的可能正是「共享角色」那些格（画廊与共享网格是同一批文件的两个视图），
    // 不跟着刷一下，共享区仍显示「已装」、按钮还是「删」——用户会以为没删掉。
    refreshSharedSkins()
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
    // 删掉的可能正是「共享角色」那一格（画廊与共享网格是同一批文件的两个视图），
    // 不跟着刷一下，共享区仍显示「已装」、按钮还是「删」——用户会以为没删掉。
    refreshSharedSkins()
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
// 与形象的关键差别：没有「当前用哪张」——有图就随机抽，删光即自动回退内置 rua.webp，所以没有「使用中」标记。
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

// —— 「资源」Tab 素材包 / 下载进度（模板已迁至 AssetsView.vue；此处保留被其它域共用的部分） ——
const assetsBusy = ref(false)
const builtinFlash: Flash = useFlash()
function doPreviewBuiltin(url: string) {
  builtinFlash.msg = ''
  builtinFlash.err = false
  playAudioUrl(url, builtinFlash)
}

const skinPackList = ref<SkinPackList | null>(null)
// 已装状态从宿主清单来（以磁盘为准），而不是本地信心 —— 用户在「导入的形象」里删掉后这里要跟着变
const skinPackInstalled = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {}
  for (const it of (skinPackList.value?.items || [])) out[it.id] = it.installed === true
  return out
})
// 「正在使用的形象当前拿不到」：配置里选的是历史内置形象（已移出插件包），但本地还没下载回来
// —— 挂件此刻只能回退显示默认形象，对用户是**静默降级**（不下到「资源」页根本看不出）。
// 判据走 LEGACY_BUILTIN_SKINS 与皮肤包清单，不新增存储键；「未下载」以宿主清单的 installed 为准
const skinInUseMissing = computed<boolean>(() => {
  const s = cfg.skin
  if (!s || s === 'custom') return false
  if (BUILTIN_SKINS.includes(s)) return false
  if (!LEGACY_BUILTIN_SKINS.includes(s)) return false
  return skinPackInstalled.value[s] !== true
})
// 首次判定出缺失时自动展开「内置资源」折叠区（否则提示藏在收起区里等于没有）。
// 只在「从未展开过」时替用户展开一次，之后尊重他的手动收起（不反复弹开）
const builtinFoldAutoOpened = ref(false)
watch(skinInUseMissing, (v) => {
  if (v && !builtinFoldAutoOpened.value) {
    builtinFoldAutoOpened.value = true
    assetFolds.builtin = true
  }
}, { immediate: true })
function refreshSkinPacks() {
  const r = services.listSkinPacks?.()
  skinPackList.value = r && Array.isArray(r.items) ? r : null
}

// —— 共享素材（角色图 36 张 + 音效库 45 个，上游 QQ 群素材，挂 Release 按需下） ——
// v1.9.0 起与「可下载的内置形象」同一套单张下载：点缩略图只下这一张（走 raw 直链），
// 顶上按钮才逐张串行补齐。不再有「点任意一张 = 下整包」的语义。
function sharedSkinThumb(id: string) {
  return './resources/thumbs/' + encodeURIComponent(id) + '.webp'
}
// 把打包好的缩略图（resources/thumbs/<id>.webp，几 KB）读成 data URL 交给宿主落盘。
// 为什么必须由设置页给：宿主（preload）定位不到插件目录 —— 它只有 utools.getPath('userData')，
// 而相对路径 './resources/...' 只有渲染进程能解析。不给的话下载回来的共享角色没有缩略图，
// 画廊只能回落读原图（0.9~2.7MB 一张），很快耗光 listSkins 的 8MB 回落预算，后面全显示「无预览」。
// 读失败（资源缺失 / 不是有效图片）一律返回 ''：宁可这张暂时没缩略图（回落原图仍能显示），
// 也不能因为读图失败把整张角色图的下载带崩。
async function sharedSkinThumbDataUrl(id: string): Promise<string> {
  try {
    const res = await fetch(sharedSkinThumb(id))
    if (!res.ok) return ''
    const buf = await res.arrayBuffer()
    if (!buf.byteLength) return ''
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return 'data:image/webp;base64,' + btoa(bin)
  } catch (err) {
    return ''
  }
}
const sharedSkinList = ref<SharedSkinList | null>(null)
function refreshSharedSkins() {
  const r = services.listSharedSkins?.()
  sharedSkinList.value = r && Array.isArray(r.items) ? r : null
}

// —— 共享音效库（45 个，与共享角色同一个包来源，但落 sounds 的 shared 槽位） ——
// shared 是「素材池」，不直接参与实播 —— 用户在下面从池子里「选用」到某个实播槽位才生效，
// 否则一装几十段、把原本选好的音效挤掉。
const sharedSoundList = ref<SharedSoundList | null>(null)
function refreshSharedSounds() {
  const r = services.listSharedSounds?.()
  sharedSoundList.value = r && Array.isArray(r.items) ? r : null
}
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
// —— 台词库（随机台词组 + 报时 / 动图降级文案） ——
// 一组 = 一个抽签项：权重越大越常抽到，顺序决定「依次播放」的出场次序。
// card 是内置的余额 / 时段卡（内容按当前数据现算，文字改不了）；text 是自己填的台词；image 是抽一张气泡图
type QuoteKind = 'card' | 'text' | 'image'
// v2 行×段的最小类型：段字段按类型展开编辑（text 调样式、image 选图、link 填址、model 选键）
interface QuoteSegV2 { type?: string; t?: string; url?: string; img?: number; h?: number; model?: string; fz?: number; c?: string; g?: string; b?: number; i?: number; br?: number }
interface QuoteRowV2 { segs: QuoteSegV2[]; w?: number; d?: number; cond?: Record<string, unknown> }
interface QuoteGroupEdit { kind: QuoteKind; w: number; style: 'A' | 'B'; lines: string; rows?: QuoteRowV2[]; sound?: string }
// v2 行列表若全部是「单一 text 段、字号只落在 A(fz7+w:1)/B(fz11) 两档」的简单组，
// 就转回 textarea 形态照常编辑（保存时按 lines+style 走，宿主再升级回 v2，零损失往返）；
// 含图片 / 链接 / 变量段或自定义字号的富文本组转不动，返回 null 由调用方走 rows 透传
function rowsShapeToLines(rows: QuoteRowV2[]): { style: 'A' | 'B'; lines: string } | null {
  let style: 'A' | 'B' | null = null
  const lines: string[] = []
  for (const row of rows) {
    const segs = Array.isArray(row) ? row : row && typeof row === 'object' ? row.segs : null
    if (!segs || segs.length !== 1) return null
    const seg = segs[0] as QuoteSegV2
    const w = Array.isArray(row) ? undefined : row.w
    if (!seg || seg.type !== 'text' || typeof seg.t !== 'string' || seg.c || seg.g || seg.b || seg.i || seg.br) return null
    if (seg.fz === 7 && w === 1) { if (style === 'B') return null; style = 'A' }
    else if (seg.fz === 11 && w === undefined) { if (style === 'A') return null; style = 'B' }
    else return null
    lines.push(seg.t)
  }
  return style ? { style, lines: lines.join('\n') } : null
}
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
  { key: 'gifFail', label: '动图降级', hint: '动图（rua.webp）加载失败时顶替显示的文案' },
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
  cfg.quotes.groups.push({ kind: 'text', w: 5, style: 'A', lines: '', sound: '' })
}
function quoteGroupDel(i: number) {
  cfg.quotes.groups.splice(i, 1)
  // 预览选中下标跟着组列表走：删的是当前选中组则清空预览，删前面的则前移一位
  if (quotePreviewIdx.value === i) quotePreviewIdx.value = null
  else if (quotePreviewIdx.value !== null && quotePreviewIdx.value > i) quotePreviewIdx.value -= 1
  // 段编辑选中跟着组列表走：删的是选中组则清空，删前面的则前移一位
  const sel = quoteEditorSel.value
  if (sel && sel.group === i) quoteEditorSel.value = null
  else if (sel && sel.group > i) quoteEditorSel.value = { ...sel, group: sel.group - 1 }
  // 组级还原确认跟着组列表走：删前面的前移一位
  if (quoteGroupResetConfirm.value === i) quoteGroupResetConfirm.value = null
  else if (quoteGroupResetConfirm.value !== null && quoteGroupResetConfirm.value > i) quoteGroupResetConfirm.value -= 1
}
// 组级重置：撤销这组未保存的修改，回到上次保存的状态（quotesBaseline 存的就是整份 JSON，
  // 从里面把该组抠出来还回去即可）。仅在有未保存改动时给入口，保存/无改动时按钮无意义
  const quoteGroupResetConfirm = ref<number | null>(null)
  function quoteGroupReset(i: number) {
    if (quoteGroupResetConfirm.value !== i) { quoteGroupResetConfirm.value = i; return }
    quoteGroupResetConfirm.value = null
    try {
      const base = quotesBaseline.value ? JSON.parse(quotesBaseline.value) : null
      const groups = base && Array.isArray(base.groups) ? base.groups : null
      if (!groups || !groups[i]) { quoteFlashShow('没有可恢复的保存状态', true); return }
      cfg.quotes.groups.splice(i, 1, groups[i])
      quoteEditorSel.value = null
      quoteFlashShow('已还原这组的保存状态')
    } catch (err: any) {
      quoteFlashShow('还原失败：' + String(err?.message || err), true)
    }
  }

  // 卡头预览：一眼看出每组里有什么，免得逐个展开 textarea 找台词。
  // text 取首句截断（占位符原样显示，不做替换——这里只做识别不做渲染）；image 数气泡图张数要等宿主回填，这里只给文字
function quoteGroupPreview(g: QuoteGroupEdit): string {
  if (g.kind === 'text') {
    // 富文本组（rows 透传）：标行数 + 段型摘要（如图/链/数据段出现了就点名），免得逐行展开找
    if (Array.isArray(g.rows) && g.rows.length) {
      const types = new Set<string>()
      for (const r of g.rows) for (const s of (r.segs || [])) if (s.type && s.type !== 'text') types.add(s.type)
      const extra = types.size ? ' · ' + [...types].map((t) => QUOTE_SEG_TYPE_LABELS[t] || t).join('/') : ''
      return `${g.rows.length} 行 · 段编辑${extra}`
    }
    const lines = String(g.lines || '').split('\n').map(s => s.trim()).filter(Boolean)
    if (!lines.length) return '还没填台词'
    const first = lines[0].length > 12 ? `${lines[0].slice(0, 12)}…` : lines[0]
    return lines.length > 1 ? `${lines.length} 条 · ${first}` : first
  }
  if (g.kind === 'image') return '随机抽一张气泡图'
  return ''
}
// 上移 / 下移：顺序决定「依次播放」的出场次序，所以要有办法调
function quoteGroupMove(i: number, d: number) {
  const j = i + d
  if (j < 0 || j >= cfg.quotes.groups.length) return
  const [g] = cfg.quotes.groups.splice(i, 1)
  cfg.quotes.groups.splice(j, 0, g)
  // 预览选中跟着被移动的组走
  if (quotePreviewIdx.value === i) quotePreviewIdx.value = j
  else if (quotePreviewIdx.value === j) quotePreviewIdx.value = i
}

// —— v2 段级编辑器（第 3 期）：行×段 chips 编辑 ——
// 选中段状态带 group 下标（多个组可同时是富文本形态，选中不能跨组串线）。
// 编辑 UI 状态放独立 ref，绝不挂到 cfg.quotes 组对象上——quotesBaseline 用整份 JSON 比对「未保存」，
// UI 状态一旦混进组对象就会误报脏
interface QuoteEditorSel { group: number; row: number; seg: number }
const quoteEditorSel = ref<QuoteEditorSel | null>(null)
// 段拖拽只在精确指针（鼠标 / 触控板）下启用：触屏 dragstart 不可靠，左右移按钮兜底
const QUOTE_CAN_DRAG = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches
// model 段取值键：与宿主 store.js 的 QUOTE_MODEL_KEYS 同一份（check-shared 未钉住，改动需两处同步）
const QUOTE_MODEL_KEYS = ['balance', 'today', 'peak', 'next']
// 上限与宿主 normRows / normRow 同口径（行数 30 / 单行段数 12），超了保存时会被截掉，不如这里就拦住
const QUOTE_ROW_MAX = 30
const QUOTE_SEG_PER_ROW_MAX = 12
const QUOTE_SEG_TYPE_LABELS: Record<string, string> = { text: '文本', image: '气泡图', link: '链接', model: '数据' }
// 字号档位 1–11（档位表在宿主 QUOTE_FONT_TIERS，此处只让选档号，数字越大字越大）
const QUOTE_FZ_OPTIONS = Array.from({ length: 11 }, (_, n) => n + 1)
// 占位符 chips：点一下把 {key} 追加到当前 text 段文本尾（真插入光标处要拿选区坐标，成本不值）
const QUOTE_PLACEHOLDER_CHIPS: Array<{ k: string; label: string }> = [
  { k: 'balance', label: '余额' },
  { k: 'today', label: '今日已用' },
  { k: 'peak', label: '当前时段' },
  { k: 'next', label: '距高峰' },
]
// 成品组模板：字面量 rows，给「高级编辑」一个起点；深拷贝入组，避免模板被编辑污染。
// sound 是建议的组级音效（共享音效库段名，缺该段时挂件侧静音不报错）；留空 = 不建议音效
const QUOTE_TEMPLATES: Array<{ label: string; rows: QuoteRowV2[]; sound?: string }> = [
  {
    label: '余额播报',
    rows: [
      { segs: [{ type: 'text', t: '当前余额', fz: 7 }] },
      { segs: [{ type: 'model', model: 'balance', fz: 11 }] },
    ],
  },
  {
    label: '用量 + 时段',
    rows: [
      { segs: [{ type: 'text', t: '今日已用 ', fz: 7 }, { type: 'model', model: 'today', fz: 7 }] },
      { segs: [{ type: 'text', t: '现在是', fz: 7 }, { type: 'model', model: 'peak', fz: 7 }], w: 1 },
    ],
  },
  {
    label: '图文混排',
    rows: [
      { segs: [{ type: 'image', img: 0, h: 96 }] },
      { segs: [{ type: 'text', t: '余额 {balance}', fz: 7 }], w: 1 },
    ],
  },
  // —— 第 5 期新增：条件行 / 组音效演示模板（零网络依赖，音效名缺段时挂件侧静音） ——
  {
    label: '低余额提醒（条件行 + 建议音效）',
    sound: '来财',
    rows: [
      { segs: [{ type: 'text', t: '余额见底啦，快去充值~', fz: 11 }], cond: { type: 'balanceBelow', value: 10 } },
      { segs: [{ type: 'text', t: '当前余额 {balance}', fz: 7 }], w: 1 },
    ],
  },
  {
    label: '工作时段问候（峰谷条件）',
    rows: [
      { segs: [{ type: 'text', t: '冲冲冲！', fz: 11 }], cond: { type: 'peak' } },
      { segs: [{ type: 'text', t: '摸鱼中~', fz: 11 }], cond: { type: 'valley' } },
      { segs: [{ type: 'text', t: '现在是 {peak}', fz: 7 }] },
    ],
  },
  {
    label: '周末快乐（星期条件）',
    rows: [
      { segs: [{ type: 'text', t: '今天不营业，鲸鱼也要休息~', fz: 7 }], w: 1, cond: { type: 'weekday', days: [0, 6] } },
      { segs: [{ type: 'text', t: '今天也要加油鸭！', fz: 7 }], w: 1, cond: { type: 'weekday', days: [1, 2, 3, 4, 5] } },
    ],
  },
]
function quoteEditorRowsOf(i: number): QuoteRowV2[] {
  const g = cfg.quotes.groups[i]
  if (!g) return []
  if (!Array.isArray(g.rows)) g.rows = []
  return g.rows
}
// 模板用的纯读取版：不写 g.rows（渲染期改状态会再触发响应式），没 rows 给空数组兜底——
// v-for 回调作用域吃不到外层 v-else 的 Array.isArray 窄化，模板里一律走它就不碰类型歧义
function quoteRowsView(i: number): QuoteRowV2[] {
  const g = cfg.quotes.groups[i]
  return g && Array.isArray(g.rows) ? g.rows : []
}
// 简单组 → 富文本组（单向升级，textarea 回不来——要回只能恢复默认或改配置）：
// A = fz7 + 行折行，B = fz11，与 rowsShapeToLines 的还原映射一一对应，保存后零损失往返
function quoteUpgradeToRows(i: number) {
  const g = cfg.quotes.groups[i]
  if (!g || Array.isArray(g.rows)) return
  const fz = g.style === 'B' ? 11 : 7
  const lines = String(g.lines || '').split('\n').map((s) => s.trim()).filter(Boolean)
  g.rows = lines.length
    ? lines.map((t) => (g.style === 'A' ? { segs: [{ type: 'text', t, fz }], w: 1 } : { segs: [{ type: 'text', t, fz }] }))
    : []
}
function quoteRowAdd(i: number) {
  const rows = quoteEditorRowsOf(i)
  if (rows.length >= QUOTE_ROW_MAX) return
  rows.push({ segs: [] })
}
function quoteRowDel(i: number, ri: number) {
  const rows = quoteEditorRowsOf(i)
  rows.splice(ri, 1)
  const sel = quoteEditorSel.value
  if (sel && sel.group === i) {
    if (sel.row === ri || sel.row >= rows.length) quoteEditorSel.value = null
    else if (sel.row > ri) quoteEditorSel.value = { ...sel, row: sel.row - 1 }
  }
}
function quoteRowMove(i: number, ri: number, d: number) {
  const rows = quoteEditorRowsOf(i)
  const j = ri + d
  if (j < 0 || j >= rows.length) return
  const [r] = rows.splice(ri, 1)
  rows.splice(j, 0, r)
  const sel = quoteEditorSel.value
  if (sel && sel.group === i && sel.row === ri) quoteEditorSel.value = { ...sel, row: j }
  else if (sel && sel.group === i && sel.row === j) quoteEditorSel.value = { ...sel, row: ri }
}
function quoteRowToggleWrap(i: number, ri: number) {
  const r = quoteEditorRowsOf(i)[ri]
  // w 只存 1（truthy = 行内允许软折行），关掉就摘键，与宿主 normRow 的 wantWrap 口径一致
  if (r) r.w = r.w === 1 ? undefined : 1
}
// 行停留秒数：空串/非法 = 摘键（回默认 5 秒口径），1–120 取整落键，其余超界值夹回边界
function quoteRowDwellSet(i: number, ri: number, raw: string) {
  const r = quoteEditorRowsOf(i)[ri]
  if (!r) return
  const s = String(raw).trim()
  if (!s) { r.d = undefined; return }
  const n = Math.round(Number(s))
  if (!Number.isFinite(n)) { r.d = undefined; return }
  r.d = Math.min(120, Math.max(1, n))
}

// —— 第 4 期：行条件（不满足整行塌缩，不参与抽选） ——
// 行条件放行对象上（r.cond），会随 quotesBaseline 进脏比对——这是配置不是 UI 状态，正应该如此。
// 类型清单与宿主 store.js QUOTE_COND_TYPES 同份；model 条件的候选 = 已配置模型（含内置 DeepSeek）
const QUOTE_COND_LABELS: Record<string, string> = {
  peak: '工作日峰时',
  valley: '工作日谷时',
  balanceBelow: '余额低于',
  model: '主显模型为',
  weekday: '星期几',
}
// 悬浮页 PEAK_HOURS 同款说明文案：峰时是工作日 9-12 / 14-18 点，用户配条件时要知道边界
const QUOTE_COND_PEAK_HINT = '峰时 = 工作日 9-12 / 14-18 点，其余为谷时'
// weekday.days 的顺序展示（一~日），勾选项按下标映射 getDay 值
const QUOTE_WEEKDAYS: Array<{ d: number; label: string }> = [
  { d: 1, label: '一' }, { d: 2, label: '二' }, { d: 3, label: '三' }, { d: 4, label: '四' },
  { d: 5, label: '五' }, { d: 6, label: '六' }, { d: 0, label: '日' },
]
// model 条件的候选下拉：取宿主运行时模型清单（含内置 DeepSeek），空清单（宿主没回）时给 deepseek 兜底
const quoteCondModelOptions = computed(() => {
  const opts = models.value.filter((m) => m.id && m.id !== NEW_MODEL_ROW).map((m) => ({ id: m.id, name: m.name || m.id }))
  return opts.length ? opts : [{ id: 'deepseek', name: 'DeepSeek' }]
})
// 组级音效下拉的候选：共享音效库（getSounds 的 shared 槽位）段名清单，组里存的是名字。
// 走 computed 跟随 soundsMeta 刷新（导入 / 删除共享音效 / 素材包导入后 refreshSounds 会更新它）；
// 空库给 null，下拉只留「无」一项并禁用——比渲染一个空列表友好
const quoteSoundOptions = computed<Array<{ name: string }> | null>(() => {
  const list = sharedSounds.value
  if (!list.length) return null
  return list.map((m) => ({ name: m.name }))
})
// 行条件编辑的展开状态：独立 ref（同 quoteEditorSel 禁令——UI 状态不挂 cfg 对象，免得脏比对误报）
const quoteCondOpen = ref<string | null>(null) // '组下标:行下标' 或 null
function quoteCondKey(i: number, ri: number) { return i + ':' + ri }
function quoteRowCond(r: QuoteRowV2): Record<string, unknown> | null {
  return r && typeof r === 'object' && r.cond && typeof r.cond === 'object' ? (r.cond as Record<string, unknown>) : null
}
// 当前行条件类型（无条件 = ''）。读取走 quoteRowCond，写入在 quoteCondTypeSet
function quoteCondTypeOf(r: QuoteRowV2): string {
  const c = quoteRowCond(r)
  return c ? String(c.type || '') : ''
}
function quoteCondTypeSet(i: number, ri: number, type: string) {
  const r = quoteEditorRowsOf(i)[ri]
  if (!r) return
  if (r.cond) delete r.cond
  if (!type) return
  // 各类型给合法缺省：threshold/模型 id/勾全天之外的一天（全选 = 恒真，宿主会摘键）
  const cond: Record<string, unknown> = { type }
  if (type === 'balanceBelow') cond.value = 10
  else if (type === 'model') cond.value = quoteCondModelOptions.value[0]?.id || 'deepseek'
  else if (type === 'weekday') cond.days = [1]
  r.cond = cond
}
// 条件参数编辑都要先确认行还带着同型条件（用户可能在编辑中途换类型 / 清条件）
function quoteCondValue(i: number, ri: number): number {
  const c = quoteRowCond(quoteEditorRowsOf(i)[ri] || ({} as QuoteRowV2))
  return c && c.type === 'balanceBelow' ? Number(c.value) || 0 : 10
}
function quoteCondValueSet(i: number, ri: number, v: number) {
  const c = quoteRowCond(quoteEditorRowsOf(i)[ri] || ({} as QuoteRowV2))
  if (c && c.type === 'balanceBelow') c.value = Math.max(0, Math.round(v) || 0)
}
function quoteCondModel(i: number, ri: number): string {
  const c = quoteRowCond(quoteEditorRowsOf(i)[ri] || ({} as QuoteRowV2))
  return c && c.type === 'model' ? String(c.value || '') : ''
}
function quoteCondModelSet(i: number, ri: number, id: string) {
  const c = quoteRowCond(quoteEditorRowsOf(i)[ri] || ({} as QuoteRowV2))
  if (c && c.type === 'model') c.value = id
}
function quoteCondDays(i: number, ri: number): number[] {
  const c = quoteRowCond(quoteEditorRowsOf(i)[ri] || ({} as QuoteRowV2))
  return c && c.type === 'weekday' && Array.isArray(c.days) ? (c.days as number[]) : []
}
function quoteCondDayToggle(i: number, ri: number, d: number) {
  const c = quoteRowCond(quoteEditorRowsOf(i)[ri] || ({} as QuoteRowV2))
  if (!c || c.type !== 'weekday' || !Array.isArray(c.days)) return
  const days = c.days as number[]
  const at = days.indexOf(d)
  if (at >= 0) days.splice(at, 1)
  else days.push(d)
  // 全选 / 全不选都算没有意义（恒真 / 恒假），按宿主 normRowCond 口径直接摘键回无条件
  const row = quoteEditorRowsOf(i)[ri]
  if (row && (!days.length || days.length >= 7)) delete row.cond
}
// 行头 chip 摘要：峰时 / 余额<10 / 主显·DeepSeek / 周一·三 这类一眼能读的短句
function quoteCondLabel(r: QuoteRowV2): string {
  const c = quoteRowCond(r)
  if (!c) return ''
  const type = String(c.type || '')
  if (type === 'balanceBelow') return `余额<${c.value}`
  if (type === 'model') {
    const id = String(c.value || '')
    const m = quoteCondModelOptions.value.find((o) => o.id === id)
    return `主显·${m ? m.name : id}`
  }
  if (type === 'weekday') {
    const days = Array.isArray(c.days) ? (c.days as number[]) : []
    return days.map((d) => (QUOTE_WEEKDAYS.find((w) => w.d === d) || { label: String(d) }).label).join('')
  }
  return QUOTE_COND_LABELS[type] || type
}
function quoteSegAdd(i: number, ri: number, type: string) {
  const row = quoteEditorRowsOf(i)[ri]
  if (!row || row.segs.length >= QUOTE_SEG_PER_ROW_MAX) return
  // 新段给合法缺省值：text 空 t 会被宿主当空段丢，先占位让用户补内容
  const seg: QuoteSegV2 = type === 'image' ? { type: 'image', img: 0, h: 96 }
    : type === 'link' ? { type: 'link', url: 'https://', t: '' }
    : type === 'model' ? { type: 'model', model: 'balance', fz: 7 }
    : { type: 'text', t: '新文本', fz: 7 }
  row.segs.push(seg)
  quoteEditorSel.value = { group: i, row: ri, seg: row.segs.length - 1 }
}
function quoteSegAddFromSelect(e: Event, i: number, ri: number) {
  const el = e.target as HTMLSelectElement
  const t = el.value
  el.value = ''
  if (t) quoteSegAdd(i, ri, t)
}
function quoteSegDel(i: number, ri: number, si: number) {
  const row = quoteEditorRowsOf(i)[ri]
  if (!row) return
  row.segs.splice(si, 1)
  const sel = quoteEditorSel.value
  if (sel && sel.group === i && sel.row === ri) {
    quoteEditorSel.value = row.segs.length ? { ...sel, seg: Math.min(sel.seg, row.segs.length - 1) } : null
  } else if (sel && sel.group === i && sel.row > ri) {
    quoteEditorSel.value = { ...sel, row: sel.row - 1 }
  }
}
function quoteSegMove(i: number, ri: number, si: number, d: number) {
  const row = quoteEditorRowsOf(i)[ri]
  if (!row) return
  const j = si + d
  if (j < 0 || j >= row.segs.length) return
  const [s] = row.segs.splice(si, 1)
  row.segs.splice(j, 0, s)
  const sel = quoteEditorSel.value
  if (sel && sel.group === i && sel.row === ri) {
    if (sel.seg === si) quoteEditorSel.value = { ...sel, seg: j }
    else if (sel.seg === j) quoteEditorSel.value = { ...sel, seg: si }
  }
}
// 段拖拽换位（允许跨行）：dragover 在目标 chip 上记插入位，drop 时把源段 splice 进去。
// 同行源段在目标之前时，源段被删后目标下标要回退一位
let quoteDragFrom: QuoteEditorSel | null = null
let quoteDragTo: QuoteEditorSel | null = null
function quoteSegDragStart(e: DragEvent, gi: number, ri: number, si: number) {
  quoteDragFrom = { group: gi, row: ri, seg: si }
  quoteDragTo = null
  // Chromium 不 setData 也能触发 drop，但设了更稳（Firefox 系内核必须设）
  try { e.dataTransfer?.setData('text/plain', '') } catch { /* 无 dataTransfer 也允许 drop */ }
}
function quoteSegDragOver(gi: number, ri: number, si: number) { quoteDragTo = { group: gi, row: ri, seg: si } }
function quoteSegDrop(i: number) {
  const from = quoteDragFrom
  const to = quoteDragTo
  quoteDragFrom = null
  quoteDragTo = null
  if (!from || !to || from.group !== i || to.group !== i) return
  if (from.row === to.row && from.seg === to.seg) return
  const rows = quoteEditorRowsOf(i)
  const srcRow = rows[from.row]
  const dstRow = rows[to.row]
  if (!srcRow || !dstRow) return
  const [seg] = srcRow.segs.splice(from.seg, 1)
  if (!seg) return
  const tj = from.row === to.row && from.seg < to.seg ? to.seg - 1 : to.seg
  dstRow.segs.splice(tj, 0, seg)
  quoteEditorSel.value = { group: i, row: to.row, seg: tj }
}
// 当前选中段（组 / 行 / 段任一失效即 null，字段区随之消失）
const quoteSelSeg = computed<QuoteSegV2 | null>(() => {
  const sel = quoteEditorSel.value
  if (!sel) return null
  const g = cfg.quotes.groups[sel.group]
  const row = g && Array.isArray(g.rows) ? g.rows[sel.row] : null
  const seg = row && Array.isArray(row.segs) ? row.segs[sel.seg] : null
  return seg || null
})
function quoteSegFlag(k: 'b' | 'i' | 'br', v: boolean) {
  const seg = quoteSelSeg.value
  if (!seg) return
  if (v) (seg as Record<string, unknown>)[k] = 1
  else delete (seg as Record<string, unknown>)[k]
}
function quoteInsertPlaceholder(k: string) {
  const seg = quoteSelSeg.value
  if (seg) seg.t = String(seg.t || '') + '{' + k + '}'
}
// chip 摘要：一眼认出这段是什么（占位符原样显示，这里只做识别不做渲染）
function quoteSegLabel(seg: QuoteSegV2): string {
  if (seg.type === 'image') return Number(seg.img) > 0 ? `图 #${seg.img}` : '图 随机'
  if (seg.type === 'link') return `链 ${String(seg.t || seg.url || '').slice(0, 8)}`
  if (seg.type === 'model') return `{${seg.model}}`
  const t = String(seg.t || '')
  return t.length > 10 ? `${t.slice(0, 10)}…` : (t || '空文本')
}
// 从模板新建组：push 深拷贝的 rows，权重给个中间值让用户自己调；模板建议的音效一并带出（用户可改可清）
function quoteGroupFromTemplate(e: Event) {
  const el = e.target as HTMLSelectElement
  const ti = Number(el.value)
  el.value = ''
  if (!Number.isInteger(ti) || !QUOTE_TEMPLATES[ti]) return
  if (cfg.quotes.groups.length >= QUOTE_GROUP_MAX) return
  const tpl = QUOTE_TEMPLATES[ti]
  cfg.quotes.groups.push({ kind: 'text', w: 5, style: 'A', lines: '', rows: JSON.parse(JSON.stringify(tpl.rows)), sound: tpl.sound || '' })
}

// —— 台词预览：用与悬浮窗同一个渲染器真渲染 ——
// 点组上的「预览」选中该组，编辑实时跟手（computed 每次给新行模型，渲染器整体重画）。
// 预览不取实时数据：card 组与占位符都用写死的示例值，那是挂件的运行时行为
type PreviewLines = Array<{ t: string; s: 'A' | 'B' | 'P' | 'C'; c?: string; w?: boolean } | null> | { gif: true; src?: string } | { rows: unknown[] }
const quotePreviewIdx = ref<number | null>(null)
// 组内台词按顺序逐条预览（真机是组内随机抽一条，这里顺序过一遍是为了每条都能检查排版）
const quotePreviewLineIdx = ref(0)
function quoteGroupTogglePreview(i: number) {
  if (quotePreviewIdx.value === i) { quotePreviewIdx.value = null; return }
  quotePreviewIdx.value = i
  quotePreviewLineIdx.value = 0
  // 挂件气泡档下「预览」即试播：有可发内容（非 image 组）直接发整组到挂件，
  // 设置页档则只选中组（stage 渲染器跟着选中组实时跟手）
  if (quotePreviewTarget.value === 'widget' && quotePreviewSteps.value) quoteWidgetPreview()
}
// 当前选中组的文本行（card / image 组为空，预览导航随之隐藏）
const quotePreviewGroup = computed<QuoteGroupEdit | null>(() => {
  const i = quotePreviewIdx.value
  if (i === null) return null
  return cfg.quotes.groups[i] || null
})
const quotePreviewTextLines = computed<string[]>(() => {
  const g = quotePreviewGroup.value
  if (!g || g.kind !== 'text') return []
  return String(g.lines || '').split('\n').map(s => s.trim()).filter(Boolean)
})
// 富文本组的候选行（rows 透传组）：预览按行逐条过，与简单组的「逐条」导航同构
const quotePreviewRichRows = computed<QuoteRowV2[] | null>(() => {
  const g = quotePreviewGroup.value
  if (!g || g.kind !== 'text' || !Array.isArray(g.rows) || !g.rows.length) return null
  return g.rows
})
// 预览条目总数：富文本组按行数，简单组按台词条数
const quotePreviewCount = computed(() => {
  const rich = quotePreviewRichRows.value
  return rich ? rich.length : quotePreviewTextLines.value.length
})
function quotePreviewNext() {
  const n = quotePreviewCount.value
  if (n) quotePreviewLineIdx.value = (quotePreviewLineIdx.value + 1) % n
}
// 点预览区切换：多条目响应（单条 / card / image 没有可切的条目）
const quotePreviewStageClickable = computed(() => quotePreviewCount.value > 1)
// —— 预览位置：设置页（共享渲染器）还是挂件气泡（试播会话）——
// 挂件气泡模式发**整组**台词：一屏一条，悬浮页点气泡按顺序翻，末条再点收起；
// card 组是一屏三行的固定卡、text 组每行台词各占一屏；image 组气泡图在挂件进程里发不过去
type PreviewStep = Array<{ t: string; s: 'A' | 'B' | 'P' | 'C'; c?: string; w?: boolean } | null> | { rows: unknown[] }
// 预览位置是纯 UI 口径，与 usageRange 同理走 localStorage（whale: 前缀 + 白名单 + try/catch 兜底），
// 不进宿主配置——否则每次重开插件都弹回「设置页」档
const QUOTE_PREVIEW_TARGET_KEY = 'whale:quotePreviewTarget'
function loadQuotePreviewTarget(): 'stage' | 'widget' {
  try {
    const v = localStorage.getItem(QUOTE_PREVIEW_TARGET_KEY)
    if (v === 'stage' || v === 'widget') return v
  } catch (err) {}
  return 'stage'
}
const quotePreviewTarget = ref<'stage' | 'widget'>(loadQuotePreviewTarget())
// 恢复时只还原档位不自动发送：启动时挂件可能还没显示，自动弹气泡反而吓人
function quoteSetPreviewTarget(t: 'stage' | 'widget') {
  quotePreviewTarget.value = t
  try { localStorage.setItem(QUOTE_PREVIEW_TARGET_KEY, t) } catch (err) {}
}
const quotePreviewSteps = computed<PreviewStep[] | null>(() => {
  const g = quotePreviewGroup.value
  if (!g || g.kind === 'image') return null
  const style = g.kind === 'card' ? 'A' : (g.style === 'B' ? 'B' : 'A')
  if (g.kind === 'card') {
    return [[{ t: '当前时间段为: {peak}', s: 'A' }, { t: '{balance}', s: 'P' }, { t: '今日约 {today} · 距高峰 {next}', s: 'C', w: true }]]
  }
  // 富文本组：整组候选行编成逐行会话，rows 原样发（占位符由挂件消费时替换）
  const rich = quotePreviewRichRows.value
  if (rich) return rich.map((row) => ({ rows: [row] }))
  const lines = quotePreviewTextLines.value
  if (!lines.length) return null
  return lines.map((t) => [null, { t, s: style, w: style === 'A' }, null] as PreviewStep)
})
function quoteWidgetPreview() {
  const steps = quotePreviewSteps.value
  if (!steps) return
  try {
    // 富文本组的 rows 取自 reactive cfg，是 Proxy 代理：webContents.send 结构化克隆不支持
    // Proxy，不拍平会抛「An object could not be cloned」（简单组是纯字符串拼的，不受影响）。
    // 深拷贝成纯对象顺带隔离悬浮页的原地占位符替换，不污染编辑器状态
    const r = services.quotePreview?.({ steps: JSON.parse(JSON.stringify(steps)) })
    if (r && !r.ok) quoteFlashShow(String(r.error || '试播失败'), true)
    else if (r && r.ok) quoteFlashShow('已发到挂件，点挂件气泡逐条翻看，末条再点收起')
  } catch (err: any) {
    quoteFlashShow('试播失败：' + String(err?.message || err), true)
  }
}
// 切到「挂件气泡」档：有可发内容就直接发（少点一次「发送试播」），没有则停留在提示文案
function quoteSwitchToWidget() {
  quoteSetPreviewTarget('widget')
  if (quotePreviewSteps.value) quoteWidgetPreview()
}
// 卡片示例：按悬浮窗余额卡（buildGroup1 的 DeepSeek 分支）的三行结构写死
const quoteCardPreviewLines: PreviewLines = [
  { t: '当前时间段为:', s: 'A' },
  { t: '空闲时段', s: 'P', c: '#2fa24c' },
  { t: '今日约 ¥ 1.23 · 距高峰 42 分钟', s: 'C', w: true },
]
const quotePreviewLines = computed<PreviewLines | null>(() => {
  const i = quotePreviewIdx.value
  if (i === null) return null
  const g = cfg.quotes.groups[i]
  if (!g) return null
  if (g.kind === 'image') return { gif: true, src: '' }
  if (g.kind === 'card') return quoteCardPreviewLines
  // 富文本组：整行段列表包成单行 rows 给渲染器（stage 档无图段回调，image 段由渲染器整段丢）
  const rich = quotePreviewRichRows.value
  if (rich) {
    const row = rich[Math.min(quotePreviewLineIdx.value, rich.length - 1)]
    const segs = Array.isArray(row) ? row : row && typeof row === 'object' ? row.segs : null
    if (!segs) return null
    const out = segs.map((seg) => {
      if (seg && seg.type === 'text' && typeof seg.t === 'string') {
        return { type: 'text', t: quoteSamplePlaceholders(seg.t), fz: seg.fz, c: seg.c, g: seg.g, b: seg.b, i: seg.i, br: seg.br }
      }
      return seg
    })
    return { rows: [out] }
  }
  const lines = quotePreviewTextLines.value
  if (!lines.length) return null
  // 越界兜底：编辑中删行后 idx 可能超尾，夹回有效区间
  const li = Math.min(quotePreviewLineIdx.value, lines.length - 1)
  const first = lines[li]
  // 文本组与悬浮窗 textGroupLines 同构：单行居中，A 允许换行、B 不换行
  return [null, { t: quoteSamplePlaceholders(first), s: g.style, w: g.style === 'A' }, null]
})
// 占位符替换成示例值（认不出的原样保留，与悬浮窗 renderLinePlaceholders 同口径）
function quoteSamplePlaceholders(text: string): string {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'balance') return '¥ 12.34'
    if (k === 'today') return '¥ 1.23'
    if (k === 'peak') return '空闲时段'
    if (k === 'next') return '42 分钟'
    return m
  })
}
// 预览的 image 段取图：设置页只有 thumb（data URL）可用。
// 无气泡图 → null（渲染器整段丢，与挂件没导图时同口径）；img 0/缺省 → 固定第一张
// （预览要稳定可检查，不学挂件的随机抽）；1..N → 对应下标，越界夹回有效区间
function quoteBubbleSrc(img: number): string | null {
  const thumbs = bubbleItems.value.map((it) => it.thumb).filter(Boolean)
  if (!thumbs.length) return null
  const i = Math.round(Number(img) || 0)
  return thumbs[i >= 1 ? Math.min(i, thumbs.length) - 1 : 0] || null
}
// 预览的 model 段取值：与占位符示例同一套（复用 quoteSamplePlaceholders，认不出的给空串）
function quoteModelText(model: string): string {
  return quoteSamplePlaceholders('{' + String(model) + '}').replace(/^\{(\w+)\}$/, '')
}
// 保存：按行拆开整份交给宿主清洗（去空白 / 丢空行 / 限长 / 权重压到 1–999 / 丢掉没台词的文本组），
// 再回读一次拿到清洗后的结果
function saveQuotes() {
  quoteResetConfirm.value = false
  quoteGroupResetConfirm.value = null
  const groups = cfg.quotes.groups.map((g) => {
    // sound（组级音效名）随出口带出，清洗归宿主
    const snd = typeof g.sound === 'string' && g.sound ? g.sound : undefined
    if (g.kind !== 'text') return snd ? { kind: g.kind, w: g.w, sound: snd } : { kind: g.kind, w: g.w }
    // 富文本组：rows 原样透传给宿主清洗（编辑器第 2 期不展开段编辑，只保不丢）
    if (Array.isArray(g.rows) && g.rows.length) return snd ? { kind: 'text', w: g.w, rows: g.rows, sound: snd } : { kind: 'text', w: g.w, rows: g.rows }
    const out: Record<string, any> = {
      kind: 'text',
      w: g.w,
      style: g.style,
      lines: String(g.lines || '').split('\n').map((s) => s.trim()).filter(Boolean),
    }
    if (snd) out.sound = snd
    return out
  })
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
// 引导完成页的「去挑形象」：关掉引导 → 切到「资源」Tab → 展开内置资源折叠区 → 滚到该卡。
// 不在这里直接下形象 —— 下载是设置页形象区的活儿（含进度、失败提示、已装状态），
// 引导层只负责把用户带到那儿，免得同一套逻辑写两份（历史上这种重复漏过收件人）
function onGuideBrowseSkins() {
  onGuideSkip()
  clearSearch()
  activeTab.value = 'assets'
  assetFolds.builtin = true
  nextTick(() => {
    const el = document.querySelector('[data-search="assetsBuiltin"]')
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
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
// 清除数据（勾选与二次确认）已内聚到 PrivacyView.vue，由它调用 services.clearAllData；
// 这里只做「清除成功后的回显刷新」——要读父级全局状态（secrets / cfg / 账本 / 各素材卡片）。
// picked 由组件按同一语义拆好：素材三项（sounds/skins/bubbles）同开关一起下发。
function onDataCleared(picked: { secrets: boolean; config: boolean; ledger: boolean; window: boolean; sounds: boolean; skins: boolean; bubbles: boolean }) {
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
}
// —— 备份与恢复（「数据」页独立卡片）——
// 导出 / 读取 / 勾选 / 恢复全部内聚到 BackupView.vue（由它调用 services.backup*）；
// 这里只做「恢复成功后的回显刷新」——要读父级全局状态（cfg / 账本 / secrets）。
function onBackupApplied(applied: string[]) {
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
  // 提醒音独立音量：宿主已归一化，这里只做类型兜底（缺槽位保留本地默认 = 跟随全局）
  const avs = c.alertVols && typeof c.alertVols === 'object' ? c.alertVols : {}
  for (const r of ALERT_SOUND_ROLES) {
    const av = avs[r]
    if (av && typeof av === 'object') {
      cfg.alertVols[r].vol = typeof av.vol === 'number' && isFinite(av.vol) ? Math.min(1, Math.max(0, av.vol)) : 1
      cfg.alertVols[r].volSet = av.volSet === true
    }
  }
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
  // 内置（随包）与历史内置 id 都原样保留：老配置可能是已移出包的 id，下载回来就能用，
  // 这里打回默认会让「一下载就发现我选的形象被改了」
  cfg.skin = c.skin === 'custom' || LEGACY_BUILTIN_SKINS.includes(c.skin) ? c.skin : DEFAULT_SKIN
  cfg.theme = c.theme === 'dark' || c.theme === 'sakura' ? c.theme : 'default'
  // 界面深浅色回填：非法值按 auto 处理（与宿主 normUiMode 同口径）。
  // 回填后立即重应用：启动首次应用拿的是本地默认 auto，存储里的手动 light/dark 这时才到达，
  // 不重应用要等下一轮 1s 轮询才变对；挂件菜单改 uiMode 经配置推送过来也靠这里即时生效
  cfg.uiMode = c.uiMode === 'light' || c.uiMode === 'dark' ? c.uiMode : 'auto'
  applyUtoolsDark()
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
  notifyViewRef.value?.syncTimerHms()
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
  // 形象下载源前缀：宿主已归一化（非法串回空），这里只做类型兜底
  cfg.skinPackSrc = typeof c.skinPackSrc === 'string' ? c.skinPackSrc : ''
  // 内置形象是否参与随机：缺省 true（老配置没有该字段时按「参与」处理，与升级前一致）
  cfg.randomIncludeBuiltin = c.randomIncludeBuiltin !== false
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
  cfg.quotes.groups = (Array.isArray(q.groups) ? q.groups : []).map((g: any) => {
    // 组级音效名随组透传（编辑区不清洗，落库时宿主再规整；丢了的话每轮回灌 sound 就消失）
    const snd = typeof g?.sound === 'string' ? g.sound : ''
    if (g?.kind === 'card') return { kind: 'card', w: typeof g?.w === 'number' ? g.w : 5, style: 'A', lines: '', sound: snd }
    if (g?.kind === 'image') return { kind: 'image', w: typeof g?.w === 'number' ? g.w : 5, style: 'A', lines: '', sound: snd }
    // 宿主出口恒为 v2 rows：能退化成「单 text 段组」的转回 textarea 形态；富文本组 rows 原样透传。
    // 带 cond / d（行条件 / 停留秒数）的行不算简单组——textarea 两样都编辑不了，转过去就丢了
    const rows = Array.isArray(g?.rows) ? (g.rows as QuoteRowV2[]) : []
    const simple = rows.some((r: any) => r && typeof r === 'object' && (r.cond || r.d)) ? null : rowsShapeToLines(rows)
    if (simple) return { kind: 'text', w: typeof g?.w === 'number' ? g.w : 5, style: simple.style, lines: simple.lines, sound: snd }
    return { kind: 'text', w: typeof g?.w === 'number' ? g.w : 5, style: g?.style === 'B' ? 'B' : 'A', lines: '', rows, sound: snd }
  }) as QuoteGroupEdit[]
  // 提醒文案模板：宿主回的就是含换行的字符串，原样显示（缺字段/异常值按空处理）
  // 回填完成即等于「已保存状态」，在这里落基线，供「未保存」提示比对
  notifyViewRef.value?.syncAlertsBaseline()
  quotesBaseline.value = JSON.stringify(cfg.quotes)
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
    notifyViewRef.value?.loadMailSecrets()
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
      refreshSharedSkins()
      refreshSharedSounds()
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
    <nav class="tab-bar" ref="tabBarEl">
      <div class="tab-row">
        <button v-for="t in TABS" :key="t.key" type="button" class="tab"
                :class="{ 'tab-on': !searchActive && activeTab === t.key }" @click="clearSearch(); activeTab = t.key">{{ t.label }}</button>
      </div>
      <!-- 卡片搜索：输入即跨 Tab 过滤出命中的卡片（见 SEARCH_INDEX）。清空 / Esc 回到正常 Tab 视图 -->
      <div class="search-row">
        <input class="search-input" type="search" v-model="searchQuery" placeholder="搜索设置项（如：穿透 / 音效 / 备份 / dsh）"
               @keydown.esc="!isImeComposing($event) && clearSearch()" />
        <button v-if="searchActive" class="search-clear utils-btn utils-secondary" type="button" @click="clearSearch">清除</button>
      </div>
      <p class="tab-desc">
        <template v-if="searchActive">
          {{ searchHits.length ? `找到 ${searchHits.length} 张卡片（跨分组）` : '没有匹配的卡片，换个关键词试试' }}
        </template>
        <template v-else>{{ activeTabDesc }}</template>
      </p>
    </nav>

    <!-- 搜索结果为空时的指引：搜索是跨组过滤，匹配不到任何卡的可见文本 -->
    <p v-if="searchActive && !searchHits.length" class="card search-empty">
      没找到含「{{ searchQuery.trim() }}」的卡片。搜索匹配的是卡片标题与关键词（含同义词），
      试试更短或更常见的词，如「形象」「用量」「通知」「hosts」。
    </p>
    <!-- 搜索态下每张命中卡标出「本来在哪一组」，点标签直接滚到那张卡（命中卡按索引顺序渲染、不带分组名会找不到北） -->
    <div v-if="searchActive && searchHits.length" class="search-hits">
      <button v-for="k in searchHits" :key="k" type="button" class="search-hit-tag" @click="scrollToCard(k)">{{ cardTabLabel(k) }} · {{ SEARCH_INDEX[k].label }}</button>
    </div>

    <!-- [数据] 凭据：填一次就不动，默认收起（展开状态见 toolOpen.credentials） -->
    <section v-if="cardOn('data', 'credentials')" class="card" data-search="credentials">
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
    <LookView v-if="cardOn('look', 'look')"
              :cfg="cfg"
              :builtin-skins="BUILTIN_SKINS"
              :legacy-builtin-skins="LEGACY_BUILTIN_SKINS"
              :skin-meta="skinMeta"
              :skin-unused="skinUnused"
              :skin-flash="skinFlash"
              :asset-size="assetSize"
              :sounds-meta="soundsMeta"
              :sound-label="soundLabel"
              :sound-unused="soundUnused"
              :scale-steps="SCALE_STEPS"
              @patch="patchCfg"
              @scale-live="onScaleLive"
              @scale-num-live="onScaleNumLive"
              @scale-commit="onScaleCommit"
              @random-skin="doRandomSkin"
              @toggle-include-builtin="onToggleIncludeBuiltin"
              @ui-mode-change="onUiModeChange" />

    <!-- [资源] 素材集中管理：概览（占用 / 清理 / 素材包）· 导入的形象 · 导入的音效 · 内置资源对照。
         与「挂件外观」分工：那边只选「用哪个」，这里管「导了什么、占多大、要不要删、换机器怎么带走」
         模板已迁至 AssetsView.vue：组件内含多张可独立命中的卡，故整个块不加 v-if，
         显隐由组件内部逐段按 cardOn('assets', key) 判定（传函数 prop，见下） -->
    <AssetsView
      :cfg="cfg"
      :card-on="cardOn"
      :search-active="searchActive"
      :services="services"
      :skin-gallery="skinGallery"
      :skin-meta="skinMeta"
      :skin-picked="skinPicked"
      :picked-skinned="pickedSkinned"
      :thumb-broken="thumbBroken"
      :skin-hint-open="skinHintOpen"
      :sounds-meta="soundsMeta"
      :shared-sounds="sharedSounds"
      :sound-data="soundData"
      :sound-flash="soundFlash"
      :bubble-items="bubbleItems"
      :bubble-flash="bubbleFlash"
      :has-assets="hasAssets"
      :skin-unused="skinUnused"
      :sound-unused="soundUnused"
      :builtin-fold="assetFolds.builtin"
      :assets-busy="assetsBusy"
      :shared-skin-thumb-data-url="sharedSkinThumbDataUrl"
      :builtin-skins="BUILTIN_SKINS"
      :legacy-builtin-skins="LEGACY_BUILTIN_SKINS"
      :skin-pack-skins="SKIN_PACK_SKINS"
      :shared-skin-pack-skins="SHARED_SKIN_PACK_SKINS"
      @patch="patchCfg"
      @import-skin="doImportSkin"
      @use-skin="doUseSkin"
      @pick-skin="pickSkin"
      @use-skin-pick="doUseSkinPick"
      @remove-skin="doRemoveSkin"
      @remove-skins="doRemoveSkins"
      @use-picked="doUsePicked"
      @pin-picked="doPinPicked"
      @bottom-picked="doBottomPicked"
      @apply-picked-random="applyPickedRandom"
      @remove-picked="doRemovePicked"
      @batch-random="doBatchRandom"
      @move-skins="doMoveSkins"
      @random-skin="doRandomSkin"
      @toggle-include-builtin="onToggleIncludeBuiltin"
      @thumb-error="(k: string) => { thumbBroken[k] = true }"
      @toggle-builtin-fold="(on: boolean) => { assetFolds.builtin = on }"
      @preview-sound="doPreviewSound"
      @import-sound="doImportSound"
      @remove-sound="doRemoveSound"
      @import-bubble="doImportBubble"
      @remove-bubble="doRemoveBubble"
      @clear-unused="doClearUnused"
      @clear-assets="doClearAssets"
      @clear-picked="skinPicked = []"
      @toggle-skin-hint="skinHintOpen = !skinHintOpen"
      @preview-builtin="doPreviewBuiltin"
      @stop-preview="stopPreviewSound"
      @refresh-sounds="refreshSounds"
      @refresh-skin="refreshSkin"
      @refresh-bubbles="refreshBubbles"
      @refresh-skin-packs="refreshSkinPacks"
      @refresh-shared-skins="refreshSharedSkins"
      @refresh-shared-sounds="refreshSharedSounds"
    />

    <!-- [外观] 文案：只剩台词库（随机台词组 + 6 个多行文本 + 保存 / 恢复默认）。
         提醒文案结构相同但属「提醒」主题，已并入「用量 → 提醒与通知」卡，免得调一类提醒要跳两个 Tab -->
    <section v-if="cardOn('look', 'quotes')" class="card" data-search="quotes">
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
        将恢复为<b>内置默认台词</b>（含版本新增台词），当前全部自定义台词与固定文案会被丢弃，此操作不可撤销。
      </p>

      <div class="field">
        <span class="label">随机台词组</span>
        <p class="hint quote-group-tip">
          点气泡时按权重随机抽一组，权重越大越常抽到（1–999）；「依次播放」开着时按这里的先后顺序出场。
        </p>
        <div v-for="(g, i) in cfg.quotes.groups" :key="i" class="quote-group"
             :class="{ 'quote-group-on': quotePreviewIdx === i }">
          <div class="quote-group-head">
            <span class="quote-group-no" :title="'第 ' + (i + 1) + ' 组；「依次播放」开着时按这个顺序出场'">{{ i + 1 }}</span>
            <select v-model="g.kind">
              <option v-for="k in QUOTE_KINDS" :key="k.v" :value="k.v">{{ k.label }}</option>
            </select>
            <span class="quote-w">
              权重
              <input class="num" type="number" min="1" max="999" step="1" v-model.number="g.w" />
            </span>
            <select v-if="g.kind === 'text' && !Array.isArray(g.rows)" v-model="g.style">
              <option value="A">普通字号</option>
              <option value="B">大字号</option>
            </select>
            <!-- 组级音效：抽中这组时播共享音效库里的一段（名字对不上就静音，不报错） -->
            <select class="quote-sound-select" v-model="g.sound" :title="quoteSoundOptions ? '抽中这组时播放的音效（共享音效库里的段）' : '先在「资源」页导入共享音效库（素材包），才有音效可选'"
                    :disabled="!quoteSoundOptions">
              <option value="">不配音效</option>
              <option v-if="g.sound && quoteSoundOptions && !quoteSoundOptions.some((o) => o.name === g.sound)" :value="g.sound">{{ g.sound }}（已失效）</option>
              <option v-for="o in quoteSoundOptions || []" :key="o.name" :value="o.name">{{ o.name }}</option>
            </select>
            <span v-if="quoteGroupPreview(g)" class="quote-group-preview">{{ quoteGroupPreview(g) }}</span>
            <span class="quote-group-sp"></span>
            <span class="quote-group-acts">
              <button class="export-btn utils-btn" :class="quotePreviewIdx === i ? 'utils-primary' : 'utils-outline'"
                      type="button" @click="quoteGroupTogglePreview(i)">预览</button>
              <button v-if="quotesDirty" class="export-btn utils-btn" :class="quoteGroupResetConfirm === i ? 'utils-danger' : 'utils-outline'"
                      type="button" :title="quoteGroupResetConfirm === i ? '再点一次确认：把这组还原成上次保存的状态' : '撤销这组未保存的修改，回到上次保存的状态'"
                      @click="quoteGroupReset(i)">{{ quoteGroupResetConfirm === i ? '确认还原？' : '还原' }}</button>
              <button class="export-btn utils-btn utils-outline" type="button" :disabled="i === 0" title="上移" @click="quoteGroupMove(i, -1)">↑</button>
              <button class="export-btn utils-btn utils-outline" type="button" :disabled="i === cfg.quotes.groups.length - 1" title="下移" @click="quoteGroupMove(i, 1)">↓</button>
              <button class="export-btn utils-btn utils-outline" type="button" @click="quoteGroupDel(i)">删除</button>
            </span>
          </div>
          <template v-if="g.kind === 'text'">
            <!-- 简单组：textarea 一行一条，与宿主 lines 迁移口径一致；想精细排版再升级行×段 -->
            <template v-if="!Array.isArray(g.rows)">
              <textarea class="quote-input" rows="3" spellcheck="false"
                        v-model="g.lines" placeholder="一行一条，随机抽一条显示；可写 {balance} / {today} / {peak} / {next} 占位符"></textarea>
              <p v-if="!String(g.lines || '').trim()" class="hint quote-group-note">
                还没填台词，保存后这一组会被丢掉
              </p>
              <div class="quote-adv-row">
                <button class="export-btn utils-btn utils-outline" type="button"
                        title="升级为行×段编辑：可加气泡图 / 链接 / 数据段、调字号颜色；升级后回不去简单编辑"
                        @click="quoteUpgradeToRows(i)">高级编辑（行 × 段）</button>
              </div>
            </template>
            <!-- 富文本组：行 × 段 chips。点 chip 选中在下方展开字段编辑；桌面可拖拽换位（允许跨行），触屏用 ←/→ -->
            <template v-else>
              <div v-for="(r, ri) in quoteRowsView(i)" :key="ri" class="quote-row">
                <div class="quote-row-head">
                  <span class="quote-row-no">行{{ ri + 1 }}</span>
                  <!-- 行条件：点 chip 展开 / 收起编辑，无条件时给「+条件」入口。不满足整行塌缩不抽 -->
                  <button class="quote-cond-chip" :class="{ 'quote-cond-chip-on': !!quoteRowCond(r) }" type="button"
                          :title="quoteRowCond(r) ? '这行带显示条件，点开修改或清除' : '给这行加显示条件（不满足时整行不出现）'"
                          @click="quoteCondOpen = quoteCondOpen === quoteCondKey(i, ri) ? null : quoteCondKey(i, ri)">
                    {{ quoteRowCond(r) ? '⧉ ' + quoteCondLabel(r) : '+条件' }}
                  </button>
                  <label class="quote-row-wrap" title="这行允许自动折行（长台词才需要，对应普通字号的折行语义）">
                    <input type="checkbox" :checked="r.w === 1" @change="quoteRowToggleWrap(i, ri)" /> 折行
                  </label>
                  <label class="quote-row-wrap" title="这屏停留秒数（1–120 秒）：挂件气泡到点自动翻下一屏/收起；留空 = 默认 5 秒、需点击翻页的口径不变（试播会话同样生效）">
                    停留
                    <input class="num quote-dwell-in" type="number" min="1" max="120" step="1" placeholder="5"
                           :value="r.d" @change="quoteRowDwellSet(i, ri, ($event.target as HTMLInputElement).value)" /> 秒
                  </label>
                  <span class="quote-row-sp"></span>
                  <button class="export-btn utils-btn utils-outline" type="button" :disabled="ri === 0" title="上移" @click="quoteRowMove(i, ri, -1)">↑</button>
                  <button class="export-btn utils-btn utils-outline" type="button" :disabled="ri === quoteRowsView(i).length - 1" title="下移" @click="quoteRowMove(i, ri, 1)">↓</button>
                  <button class="export-btn utils-btn utils-outline" type="button" title="删这行" @click="quoteRowDel(i, ri)">删行</button>
                  <select class="quote-seg-add" title="往这行里加一段" @change="quoteSegAddFromSelect($event, i, ri)">
                    <option value="">+ 段…</option>
                    <option v-for="(lbl, tk) in QUOTE_SEG_TYPE_LABELS" :key="tk" :value="tk">{{ lbl }}</option>
                  </select>
                </div>
                <div v-if="quoteCondOpen === quoteCondKey(i, ri)" class="quote-cond-editor">
                  <select class="quote-cond-type" :value="quoteCondTypeOf(r)" @change="quoteCondTypeSet(i, ri, ($event.target as HTMLSelectElement).value)">
                    <option value="">无条件</option>
                    <option v-for="(lbl, ck) in QUOTE_COND_LABELS" :key="ck" :value="ck">{{ lbl }}</option>
                  </select>
                  <template v-if="quoteCondTypeOf(r) === 'balanceBelow'">
                    <input class="quote-cond-num" type="number" min="0" :value="quoteCondValue(i, ri)"
                           @change="quoteCondValueSet(i, ri, Number(($event.target as HTMLInputElement).value))" /> 元以下显示
                  </template>
                  <template v-else-if="quoteCondTypeOf(r) === 'model'">
                    <select class="quote-cond-model" :value="quoteCondModel(i, ri)" @change="quoteCondModelSet(i, ri, ($event.target as HTMLSelectElement).value)">
                      <option v-for="mo in quoteCondModelOptions" :key="mo.id" :value="mo.id">{{ mo.name }}</option>
                    </select> 为主显示时
                  </template>
                  <template v-else-if="quoteCondTypeOf(r) === 'weekday'">
                    <label v-for="wd in QUOTE_WEEKDAYS" :key="wd.d" class="quote-cond-day">
                      <input type="checkbox" :checked="quoteCondDays(i, ri).indexOf(wd.d) >= 0" @change="quoteCondDayToggle(i, ri, wd.d)" />{{ wd.label }}
                    </label>
                  </template>
                  <span v-else-if="quoteCondTypeOf(r) === 'peak' || quoteCondTypeOf(r) === 'valley'" class="quote-cond-note">{{ QUOTE_COND_PEAK_HINT }}</span>
                  <span v-if="quoteCondTypeOf(r) === 'weekday'" class="quote-cond-note">全选或全不选 = 无条件</span>
                </div>
                <div class="quote-row-chips" @dragover.prevent @drop.prevent="quoteSegDrop(i)">
                  <span v-if="!r.segs.length" class="quote-row-empty">空行（保存时会被丢掉，加段或删行）</span>
                  <span v-for="(s, si) in r.segs" :key="si" class="quote-chip"
                        :class="['quote-chip-' + (s.type || 'text'), quoteEditorSel && quoteEditorSel.group === i && quoteEditorSel.row === ri && quoteEditorSel.seg === si ? 'quote-chip-on' : '']"
                        :draggable="QUOTE_CAN_DRAG" :title="QUOTE_CAN_DRAG ? '拖拽换位（可跨行）；点一下编辑这段' : '点一下编辑这段'"
                        @click="quoteEditorSel = { group: i, row: ri, seg: si }"
                        @dragstart="quoteSegDragStart($event, i, ri, si)"
                        @dragover="quoteSegDragOver(i, ri, si)">
                    {{ quoteSegLabel(s) }}
                    <button class="quote-chip-x" type="button" title="删这段" @click.stop="quoteSegDel(i, ri, si)">×</button>
                  </span>
                </div>
              </div>
              <div class="quote-adv-row">
                <button class="export-btn utils-btn utils-outline" type="button"
                        :disabled="quoteRowsView(i).length >= QUOTE_ROW_MAX" @click="quoteRowAdd(i)">+ 行</button>
              </div>
              <!-- 选中段的字段编辑区（挂在本组下，跨组不会串） -->
              <div v-if="quoteSelSeg && quoteEditorSel && quoteEditorSel.group === i" class="quote-seg-editor">
                <div class="quote-seg-editor-head">
                  <span>编辑段：{{ QUOTE_SEG_TYPE_LABELS[quoteSelSeg.type || 'text'] || quoteSelSeg.type }}</span>
                  <span class="quote-seg-sp"></span>
                  <button class="export-btn utils-btn utils-outline" type="button" :disabled="quoteEditorSel.seg === 0" title="左移" @click="quoteSegMove(i, quoteEditorSel.row, quoteEditorSel.seg, -1)">←</button>
                  <button class="export-btn utils-btn utils-outline" type="button" :disabled="quoteEditorSel.seg === (quoteRowsView(i)[quoteEditorSel.row]?.segs.length || 1) - 1" title="右移" @click="quoteSegMove(i, quoteEditorSel.row, quoteEditorSel.seg, 1)">→</button>
                </div>
                <!-- text 段 -->
                <template v-if="!quoteSelSeg.type || quoteSelSeg.type === 'text'">
                  <input class="quote-input quote-seg-t" type="text" spellcheck="false" v-model="quoteSelSeg.t"
                         placeholder="文本内容，可写占位符（保时空文本的段会被丢）" />
                  <div class="quote-seg-flags">
                    字号
                    <select class="num" v-model.number="quoteSelSeg.fz">
                      <option v-for="n in QUOTE_FZ_OPTIONS" :key="n" :value="n">{{ n }}</option>
                    </select>
                    <label class="quote-flag"><input type="checkbox" :checked="!!quoteSelSeg.b" @change="quoteSegFlag('b', ($event.target as HTMLInputElement).checked)" /> 粗体</label>
                    <label class="quote-flag"><input type="checkbox" :checked="!!quoteSelSeg.i" @change="quoteSegFlag('i', ($event.target as HTMLInputElement).checked)" /> 斜体</label>
                    <label class="quote-flag" title="这段之后硬换行，本行里排在它后面的段都不显示">
                      <input type="checkbox" :checked="quoteSelSeg.br === 1" @change="quoteSegFlag('br', ($event.target as HTMLInputElement).checked)" /> 段后换行
                    </label>
                    <span class="quote-flag" title="纯色（如 #2fa24c），留空用主题色">色
                      <input class="quote-seg-c" type="text" v-model="quoteSelSeg.c" placeholder="#2fa24c" />
                    </span>
                  </div>
                  <div class="quote-chip-row">
                    <span class="quote-chip-row-label">插入占位符：</span>
                    <button v-for="p in QUOTE_PLACEHOLDER_CHIPS" :key="p.k" class="quote-chip-btn" type="button"
                            :title="'把 {' + p.k + '} 追加到文本尾，挂件显示时换成实时值'" @click="quoteInsertPlaceholder(p.k)">{{ p.label }}</button>
                  </div>
                </template>
                <!-- image 段 -->
                <template v-else-if="quoteSelSeg.type === 'image'">
                  <div class="quote-seg-flags">
                    图
                    <input class="num" type="number" min="0" max="99" step="1" v-model.number="quoteSelSeg.img" />
                    <span class="quote-seg-note">0 = 随机一张；1 起对应「资源」页气泡图顺序，超出张数按最后一张</span>
                    高
                    <input class="num" type="number" min="8" max="300" step="1" v-model.number="quoteSelSeg.h" />
                  </div>
                </template>
                <!-- link 段 -->
                <template v-else-if="quoteSelSeg.type === 'link'">
                  <input class="quote-input quote-seg-t" type="text" spellcheck="false" v-model="quoteSelSeg.url"
                         placeholder="链接地址（必填，留空的段保存时会被丢）" />
                  <input class="quote-input quote-seg-t" type="text" spellcheck="false" v-model="quoteSelSeg.t"
                         placeholder="显示文字（留空就用链接地址）" />
                </template>
                <!-- model 段 -->
                <template v-else-if="quoteSelSeg.type === 'model'">
                  <div class="quote-seg-flags">
                    数据
                    <select v-model="quoteSelSeg.model">
                      <option v-for="k in QUOTE_MODEL_KEYS" :key="k" :value="k">{{ k }}</option>
                    </select>
                    字号
                    <select class="num" v-model.number="quoteSelSeg.fz">
                      <option v-for="n in QUOTE_FZ_OPTIONS" :key="n" :value="n">{{ n }}</option>
                    </select>
                    <span class="quote-seg-note">显示时现算：balance 余额 / today 今日已用 / peak 当前时段 / next 距高峰</span>
                  </div>
                </template>
              </div>
            </template>
          </template>
          <p v-else-if="g.kind === 'card'" class="hint quote-group-note">
            内置卡片：内容按当前余额 / 峰谷时段现算，文字改不了
          </p>
          <p v-else-if="g.kind === 'image'" class="hint quote-group-note">
            抽一张「气泡图」里的图（导入在「资源」页）；没导入过时用内置的 rua.webp
          </p>
        </div>
        <div class="quote-add-row">
          <button class="export-btn utils-btn utils-outline" type="button" :disabled="cfg.quotes.groups.length >= QUOTE_GROUP_MAX"
                  @click="quoteGroupAdd()">{{ cfg.quotes.groups.length >= QUOTE_GROUP_MAX ? `已达上限（${QUOTE_GROUP_MAX} 组）` : '+ 添加组' }}</button>
          <select class="quote-tpl-select" title="从成品模板新建一组（行 × 段编辑）" @change="quoteGroupFromTemplate($event)">
            <option value="">从模板新建…</option>
            <option v-for="(t, ti) in QUOTE_TEMPLATES" :key="ti" :value="String(ti)">{{ t.label }}</option>
          </select>
        </div>
      </div>

      <!-- 台词真预览：共享渲染器真渲染（同一套 DOM / 字号自适应 / 主题变量）。
           不选中组时给引导文案；预览不取实时数据，示例值仅供参考。
           文本组给「下一条」导航：真机组内是随机抽一条，顺序逐条过是为了每条都检查得到 -->
      <div class="field">
        <div class="label quote-preview-label">
          <span>预览位置</span>
          <div class="range-tabs quote-preview-tabs">
            <button class="export-btn utils-btn range-tab quote-preview-tab" type="button"
                    :class="quotePreviewTarget === 'stage' ? 'utils-primary' : 'utils-outline'"
                    @click="quoteSetPreviewTarget('stage')">设置页</button>
            <button class="export-btn utils-btn range-tab quote-preview-tab" type="button"
                    :class="quotePreviewTarget === 'widget' ? 'utils-primary' : 'utils-outline'"
                    title="把整组台词发到挂件气泡，点挂件气泡按顺序逐条翻看（占位符换成实时值）"
                    @click="quoteSwitchToWidget()">挂件气泡</button>
          </div>
        </div>
        <BubblePreview v-if="quotePreviewTarget === 'stage' && quotePreviewLines" :lines="quotePreviewLines" :theme="cfg.theme"
                       :bubble-src="quoteBubbleSrc" :model-text="quoteModelText"
                       :title="quotePreviewStageClickable ? '点击切换下一条台词' : ''"
                       @next="quotePreviewStageClickable && quotePreviewNext()" />
        <p v-if="quotePreviewTarget === 'widget'" class="hint quote-preview-empty">
          点挂件气泡翻下一条，末条再点收起；挂件未显示时先在设置页显示挂件。
          再点一次组上的「预览」可重发。
        </p>
        <p v-if="quotePreviewTarget === 'stage' && !quotePreviewLines" class="hint quote-preview-empty">
          点某组右侧的「预览」在这里看到它真显示在气泡里的样子（与挂件同一套渲染）。
        </p>
        <!-- 元信息跟着预览体走：台词全删光时 quotePreviewLines 变 null，这行也一起消失 -->
        <div v-if="quotePreviewTarget === 'stage' && quotePreviewLines !== null" class="quote-preview-meta">
          <p class="hint quote-preview-nav">
            <template v-if="quotePreviewCount > 1">
              第 {{ Math.min(quotePreviewLineIdx, quotePreviewCount - 1) + 1 }} / {{ quotePreviewCount }} 条
              <button class="export-btn utils-btn utils-outline quote-preview-next" type="button" @click="quotePreviewNext()">下一条</button>
            </template>
            <template v-else-if="quotePreviewCount === 1">单条台词</template>
          </p>
          <p class="hint quote-preview-tip">
            <span v-if="quotePreviewGroup && quotePreviewGroup.kind === 'card'">卡片内容按当前余额 / 时段现算，这里显示示例值。</span>
            编辑实时跟手，点「预览」取消选中。真机播到这一组时是<b>随机抽一条</b>，不是按顺序轮播。
          </p>
        </div>
      </div>
      <p class="hint">
        台词里可写占位符插入实时数值：<b>{balance}</b> 当前余额、<b>{today}</b> 今日已用、<b>{peak}</b> 当前时段、
        <b>{next}</b> 距下次峰谷切换。后三项是 DeepSeek 口径，主显示换成其它模型时为空；写错的占位符会原样显示出来。
        想要「余额/时段卡」的自定义文字版？新建一个「自定义台词」组写上这些占位符即可（可选大字号）。
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
    <UsageView v-if="cardOn('usage', 'usage')" ref="usageViewRef"
               :cfg="cfg" :services="services"
               :usage-history="usageHistory" :usage-currency="usageCurrency"
               :fmt-money="fmtMoney" :is-ime-composing="isImeComposing"
               :history-keep="HISTORY_KEEP" :price-model-max="PRICE_MODEL_MAX"
               :token-price-default="TOKEN_PRICE_DEFAULT"
               @patch="patchCfg" @usage-mode-change="onUsageModeChange"
               @token-price-change="onTokenPriceChange" @history-keep-change="onHistoryKeepChange"
               @refresh="refreshHistory" @add-price-model="addPriceModel"
               @remove-price-model="removePriceModel" />

    <!-- [用量] 提醒与通知：四类自动提醒（峰谷切换 / 低余额 / 今日预算 / 余额大幅波动）+ 计时通知 + 提醒文案。
         原先开关挤在「挂件行为」那张 106 行的卡里、文案挂在「外观 → 文案」卡里，调一类提醒要跳两个 Tab，
         现在按「提醒」这个主题收成一张卡，文案作为卡内折叠 -->
    <NotifyView v-if="cardOn('usage', 'notify')" ref="notifyViewRef"
                :cfg="cfg" :services="services" :usage-currency="usageCurrency"
                :timer-note-max="TIMER_NOTE_MAX"
                :alert-sound-roles="ALERT_SOUND_ROLES" :sound-role-label="SOUND_ROLE_LABEL"
                @patch="patchCfg" @save-alerts="onSaveAlerts" />


    <!-- [用量] 多厂商模型：注册表存配置、余额存运行时快照；挂件菜单里可切换主显示的是哪一个 -->
    <ModelsView v-if="cardOn('usage', 'models')"
                :services="services" :models="models" :model-configs="modelConfigs"
                :models-main-id="modelsMainId" :model-tpls="modelTpls" :model-max="modelMax"
                :low-alert-default="LOW_ALERT_DEFAULT"
                :fmt-tokens="fmtTokens" :codex-win-text="codexWinText"
                @reload="reloadModels" @update:main-id="onModelsMainChange" />

    <!-- [窗口] 挂件窗口：显隐、位置与窗口属性（使用说明 / 故障排查已挪到「帮助」组） -->
    <!-- [外观] 挂件窗口：显隐、位置与窗口属性（使用说明 / 故障排查在「帮助」组）。
         模板已迁至 WindowView.vue：widgetFlash / 显隐 / 复位 / 复制指令 / 新增快捷键
         都写与「使用帮助」卡共用的消息槽，故仍留在父级，这里用 emit 触发 -->
    <WindowView
      v-if="cardOn('window', 'window')"
      :cfg="cfg"
      :services="services"
      :taskbar-text="taskbarText"
      :widget-flash="widgetFlash"
      @patch="patchCfg"
      @show-widget="showWidget"
      @hide-widget="hideWidget"
      @reset-pos="resetWidgetPos"
      @copy-cmd="copyHotkeyCmd"
      @add-hotkey="addHotkey"
    />
    <!-- [帮助] 使用帮助：使用说明 / 快捷键绑定 / 挂件故障排查 / 挂件创建错误详情。
         模板已迁至 HelpView.vue：卡片折叠态与诊断日志入口内聚在组件内；挂件错误状态与
         checkWidgetError 由父级 onMounted / showWidget 驱动，「复制指令名 / 新增快捷键」
         与窗口卡共用父级消息槽，故按 props 收、emit 触发 -->
    <HelpView
      v-if="cardOn('help', 'help')"
      :services="services"
      :err-detail="errDetail"
      :err-flash="errFlash"
      @copy-cmd="copyHotkeyCmd"
      @add-hotkey="addHotkey"
      @guide-reopen="onGuideReopen"
      @check-widget-error="checkWidgetError"
      @copy-widget-error="copyWidgetError"
    />

    <!-- [数据] 数据与隐私：按项清除 + 备份与恢复 -->
    <!-- [数据] 数据与隐私：模板已迁至 PrivacyView.vue。清除动作与勾选项内聚在组件内，
         清除成功后的回显刷新（secrets / cfg / 账本 / 各素材卡片）读父级全局状态，故用 emit('cleared') 交回 -->
    <PrivacyView
      v-if="cardOn('data', 'privacy')"
      :services="services"
      @cleared="onDataCleared"
    />

    <!-- [数据] 备份与恢复。原先折在「数据与隐私」卡的 .fold 里，但「数据」组 desc 一直把它
         当并列的第三张卡来写（「凭据设置 · 清除数据 · 备份与恢复」），搜索索引里也没提它 ——
         即 desc 承诺是卡、实际是别人卡里的折叠。提升为独立卡，三者对齐；也更好找。
         卡内内容原样搬来，交互与状态（backupFlash 等）不变。 -->
    <BackupView v-if="cardOn('data', 'backup')" :services="services" @applied="onBackupApplied" />

    <!-- [开发者] DeepSeek Harness（dsh） -->
    <section v-if="cardOn('dev', 'dshMain')" class="card dsh-card" data-search="dshMain">
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
        <span class="ver">{{ dshStateText }}<span v-if="dsh.nodeVersion"> · Node {{ dsh.nodeVersion }}</span><span v-if="dshHasUpdateTip" class="tag tag-new">{{ dshHasUpdateTip }}</span></span>
      </label>
      <div class="btn-row">
        <button class="utils-btn utils-primary" :disabled="dsh.running || dsh.external || !!dsh.portOther || dshBusy" @click="dshDo('start')">启动</button>
        <button class="secondary utils-btn utils-secondary" :disabled="(!dsh.running && !dsh.external) || dshBusy" @click="dshDo('restart')">重启</button>
        <button class="secondary utils-btn utils-secondary" :disabled="(!dsh.running && !dsh.external) || dshBusy" @click="dshDo('stop')">结束</button>
        <!-- 打开 Web UI 的可用性与「重启 / 结束」同源：没在跑就没有页面可开（点了只会拿到一句打开失败）。
             跑起来时升成主操作实心色，并叠 dsh-web-hint 的脉动招揽 —— 它是 dsh 起来后最常点的下一步，
             同排四个按钮里只有它该被一眼看到（动效手法参考 AccelView 的 .btn-busy） -->
        <button class="utils-btn dsh-web-btn" :class="[dsh.running || dsh.external ? 'utils-primary' : 'utils-secondary', { 'dsh-web-hint': dshWebHint }]" :disabled="(!dsh.running && !dsh.external) || dshBusy" @click="dshOpenPage">打开 Web UI</button>
      </div>
      <!-- 装哪个版本 + 更新，是同一条动作链的两个环节，所以放同一行；
           版本下拉原先在「高级选项」里，一次「装指定版本」要横跨三个折叠区才走完 -->
      <div class="field row dsh-update-row">
        <span class="label">更新版本</span>
        <!-- select 自身就显示选中项，不必再往 label 里拼「已选」；这里只标「已安装」，
             用户不展开下拉也能一眼看出当前实装的是哪一版（判断要不要更新的基准） -->
        <select v-model="cfg.dshVersion" @change="patchCfg({ dshVersion: cfg.dshVersion })">
          <option v-for="o in dshVersionOptions" :key="o.v" :value="o.v">{{ o.label }}</option>
        </select>
        <!-- 既无全局也无插件安装时实际走的是安装流程，按钮文案别再写「更新」误导。
             按钮上**不挂**任何版本 / 更新标签：「有没有新版、会装到哪一版」已由上方状态行与
             下方「实际使用」行各说一次，按钮上再挂一次就是同屏第三遍，正是先前读起来自相矛盾的来源 -->
        <button class="secondary utils-btn utils-secondary" :disabled="dshBusy" @click="dshDo('update')">
          {{ dsh.resolved || dsh.globalVersion ? '更新' : '安装' }}
        </button>
      </div>
      <label class="field row check">
        <span class="label">进入开发者页自动刷新版本 <em>（勾选：每次切到本 Tab 重查一次 npm，约 1–3 秒；不勾则用缓存的版本列表）</em></span>
        <input type="checkbox" :checked="dshAutoRefresh" @change="dshToggleAutoRefresh" />
      </label>
      <!-- 安装 / 更新的终态横幅：紧贴「更新版本」行，用户点完不用往下滚就能看到结果。
           成功 / 失败都做成整块高对比底色 + 左侧色条，与卡底 12px 的 .msg 细字区分开 ——
           那条只留给「改端口、复制地址」这类瞬时回执 -->
      <div v-if="dshResult" class="dsh-result" :class="dshResult.err ? 'err' : 'ok'">
        <span class="dsh-result-icon" aria-hidden="true">{{ dshResult.err ? '✕' : '✓' }}</span>
        <span class="dsh-result-text">{{ dshResult.msg }}</span>
        <button class="dsh-result-close utils-btn" title="关闭提示" @click="dshResult = null">×</button>
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
            <!-- 合并展示：版本号 + 「已是最新 / 有新版本：x.y.z」。
                 原先只写版本号，用户得回头看上面的状态行才知道有没有更新，且拿不到「更新会装到哪一版」 -->
            <span class="ver">{{ dshCurText }}</span>
          </label>
          <label class="field row">
            <span class="label">全局安装</span>
            <span class="ver">{{ dsh.globalVersion || '无' }}<span v-if="dsh.globalVersion && !dsh.globalWritable" class="tag">只读，更新会弹一次{{ IS_WIN ? 'UAC' : '提权' }}</span></span>
          </label>
          <label class="field row">
            <span class="label">插件目录</span>
            <span class="ver">{{ dsh.installed || '未安装' }}</span>
          </label>
          <label class="field row">
            <span class="label">npm latest</span>
            <!-- 只留版本号 + 与实装的一致性结论（dshLatestLabel）：「点更新会装到这个版本」是常驻说明，
                 已由下方的 dshVerMismatch（两者不同才出现）按实际情况给出对比句，比常驻标签更准也更省视觉噪音。
                 版本号本身既是事实也是对照基准（上面「实际使用」可能比它旧），不能省 -->
            <span class="ver">{{ dshLatestText }}<template v-if="dshLatestLabel"> · {{ dshLatestLabel }}</template></span>
          </label>
          <!-- 版本说明。入口**不依赖取数结果**：只要版本列表已查到就渲染折叠行，
               点开才去取说明。反过来（有结果才给入口）会让用户永远看不到这一块。
               已是最新时不摆折叠行，直接一行结论。
               按钮**不塞进 .field.row**：那一行的右侧位是给「实际使用 / npm latest」这类**只读值**用的，
               在这里会显成一个与其他行右对齐文本齐平的胶囊、看着像值不像按钮。
               与「运行详情」「dsh 故障排查」同款：独占一行、挂 .link-btn.utils-btn.utils-secondary -->
          <button v-if="dshNotesRow && !dshNotesLatest" class="link-btn utils-btn utils-secondary notes-toggle" @click="dshToggleNotes">
            {{ dshFolds.notes ? '收起版本说明' : '版本说明' }}<template v-if="dshNotesSummary"> · {{ dshNotesSummary }}</template>
          </button>
          <div v-if="dshFolds.notes && !dshNotesLatest" class="guide notes-box">
            <div v-if="dshHasNotes">
              <div v-for="sec in dshNotes.sections" :key="sec.title" class="notes-sec">
                <div class="notes-sec-title">{{ sec.title }}（{{ sec.items.length }}）</div>
                <div v-for="(it, i) in sec.items" :key="sec.title + '#' + i" class="notes-item">
                  <span class="notes-item-text">· {{ it.text }}</span>
                  <!-- 右标来源版本：区间内多条 release 并成一节，不标就分不清这条是哪版起的 -->
                  <span v-if="it.from" class="notes-item-from">{{ it.from }}</span>
                </div>
              </div>
              <!-- 实装版本早于列表下界（列表只留最近 N 个）时区间是残缺的，如实说明，不假装完整 -->
              <p v-if="dshNotes.truncated" class="hint notes-trunc">仅覆盖最近 {{ dshNotes.truncated.listMax }} 个版本</p>
              <!-- 外链交给底座打开（复用 openDoc，走 services.openExternal），不拼平台命令 -->
              <button v-if="dshNotes.url" class="link-btn utils-btn utils-secondary" @click="openDoc(dshNotes.url)">在浏览器查看完整发布页</button>
            </div>
            <!-- 取数中：轻提示，以及一个可重试的按钮（网络抖动时不用等轮询兜底） -->
            <p v-else-if="dsh.notesBusy" class="hint notes-busy">正在获取说明…</p>
            <!-- 取失败：如实说，并给重试入口。这是「没拿到答案」，与「已是最新」是两回事。
                 同样只认属于当前版本的结论 —— 换版本后旧那条失败提示会一直挂着误导人 -->
            <div v-else-if="dshNotes && dshNotes.ok === false && dshNotesFresh()" class="notes-sec">
              <p class="hint notes-trunc">获取版本说明失败：{{ dshNotes.reason || '未知原因' }}</p>
              <button class="link-btn utils-btn utils-secondary" @click="dshLoadNotes(true)">重试</button>
            </div>
            <!-- 区间非空、但正文一条都解析不出来（上游改了 markdown 结构 / 那几个版本没写 release 正文）。
                 必须有这一档收尾：否则会一路落到下面的「正在获取说明…」，取数明明已经结束却一直转圈 ——
                 用户看到的就是「卡住了」。如实说没有可展示的条目并给发布页入口，比装作还在加载有用 -->
            <div v-else-if="dshNotes && dshNotesOk && dshNotesFresh() && !dshNotes.empty" class="notes-sec">
              <p class="hint notes-trunc">这 {{ dshNotes.versions ? dshNotes.versions.length : 0 }} 个版本没有可显示的说明条目。</p>
              <button v-if="dshNotes.url" class="link-btn utils-btn utils-secondary" @click="openDoc(dshNotes.url)">在浏览器查看完整发布页</button>
            </div>
            <!-- 还没取过（首次展开）：主动取一次 -->
            <p v-else class="hint notes-busy">正在获取说明…</p>
          </div>
          <!-- 已是最新：查过且区间为空。给一句明确的结论 -->
          <label v-else-if="dshNotesLatest" class="field row">
            <span class="label">版本说明</span>
            <span class="hint notes-latest">已是最新版本</span>
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
            <!-- 查询按钮**常驻**：结果虽已显示在「npm latest」行里，但那份缓存无过期时间
                （whale:dshVersions 与有 12h TTL 的 whale:update 不同），上游发了新版也不会自己变。
                原先「查过就藏按钮」在缓存陈旧时把用户逼进死角 —— 界面显示几周前的版本号，
                既不自动重查、也没有任何入口手动重查，用户只能删库重来。
                现在任何时刻都能点一次刷新，文案按四态区分「查过没有」：
                查过→重新查询（这是常态，不再用疑问口吻催人）、查询中→查询中…（禁用）、
                失败→重试（带上失败原因由 dshValueFlash 提示）、没查过→查询可用版本 -->
            <button class="secondary utils-btn utils-secondary" :disabled="dsh.busy === 'versions'" @click="dshQueryVersions">
              {{ dsh.busy === 'versions' ? '查询中…' : (dshQueryFailed ? '重试：查询可用版本' : (dshVersionsQueried ? '重新查询可用版本' : '查询可用版本')) }}
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
          <p class="hint">3080 <template v-if="IS_WIN">落在 Windows/Hyper-V 的<strong>动态端口保留段</strong>里，被系统预留时</template><template v-else>若被其它程序占用</template> dsh 会直接 bind 失败（报 <code>EADDRINUSE</code>）。这里换成别的端口（如 4080）即可绕开；填非法值（0 / 超出 1–65535）会退回 3080。</p>
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
    <section v-if="cardOn('dev', 'dshDiagnose')" class="card dsh-card" data-search="dshDiagnose">
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
    <section v-if="cardOn('dev', 'dshDump')" class="card dsh-card" data-search="dshDump">
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
    <section v-if="cardOn('dev', 'dshExport')" class="card dsh-card" data-search="dshExport">
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
    <section v-if="cardOn('dev', 'dshUsage')" class="card dsh-card" data-search="dshUsage">
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
    <section v-if="cardOn('dev', 'dshIsolate')" class="card dsh-card" data-search="dshIsolate">
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
                      @keyup.enter="!isImeComposing($event) && dshRenameSave()"
                      @keyup.esc="!isImeComposing($event) && dshRenameCancel()"
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
    <section v-if="cardOn('dev', 'dshMarket')" class="card dsh-card" data-search="dshMarket">
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
                     此时不带 v —— `v^0.5.11` 不能出现。
                     ⚠️ v-if 判的是**渲染结果**而不是 latest 有没有值：dshMarketVersionText 在
                     「已装版本 == 目录版本」时返回空串（无意义的等值箭头，见该函数注释），
                     若只判 latest 就会留下一个空的 .mkt-ver（带 title 的空白占位）。
                     ⚠️ 有官方 registry 的滞后结论时**改说官方那条**（dshMarketOfficialText）：
                     它比目录版本更新、也更接近用户真正想装的目标；两者叠加显示等于一行两个「→」，
                     反而看不出该信哪个。官方版查过且更高时，目录那行自动退场。 -->
                <span v-if="dshMarketOfficialText(p)" class="mkt-ver mkt-ver-official" :title="'官方 npm 上已有更新版本：' + dshMarketOfficialText(p)">
                  {{ dshMarketOfficialText(p) }}
                </span>
                <span v-else-if="dshMarketVersionText(p)" class="mkt-ver" :title="dshMarketUpdateTip(p)">
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
    <hr v-if="!searchActive && activeTab === 'dev'" class="group-sep">
    <!-- [dsh] Codex 本地会话统计：模板已迁至 CodexView.vue。父级用一条 hr.group-sep 隔开
         （依赖 searchActive / activeTab，留父级）。fmtTokens / codexWinText / codexDayLabel
         与图表档位仍留父级（跨卡共享），按 props 下传；本卡是否有窗口数据经 emit('windows') 上抛，
         并入父级的倒计时心跳 codexTickNeed。 -->
    <CodexView
      v-if="cardOn('dev', 'codex')"
      :services="services"
      :ranges="DSH_USAGE_RANGES"
      :fmt-tokens="fmtTokens"
      :codex-win-text="codexWinText"
      :codex-day-label="codexDayLabel"
      @windows="onCodexWindows"
    />

    <!-- [帮助] 关于与更新：模板已迁至 AboutView.vue。更新检查状态与 doCheckUpdate
         留在父级（onMounted 里有启动时自动检查一次，不随卡片可见性而跑），这里用 emit 触发 -->
    <AboutView
      v-if="cardOn('help', 'about')"
      :cfg="cfg"
      :services="services"
      :app-version="appVersion"
      :update-checking="updateChecking"
      :update-msg="updateMsg"
      :has-update="hasUpdate"
      :update-ok="!!(updateResult && updateResult.ok)"
      @patch="patchCfg"
      @doc="openDoc"
      @check-update="doCheckUpdate"
    />

    <!-- [帮助] GitHub 加速（hosts 方案）：已抽成独立组件，显隐仍由本页的 Tab / 搜索态决定 -->
    <AccelView
      v-if="cardOn('help', 'ghAccel')"
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
      @browse-skins="onGuideBrowseSkins"
      @doc="openDoc"
    />
  </div>
</template>

<style scoped>
.page {
  /* 主题变量（--fg / --accent / --line / --card-bg / --ok / --err 等）已上提至
     main.css 的 :root 作全项目唯一真源，这里不再重复定义 —— 改配色只改那一处。
     仅保留页面级、非颜色令牌的 color-scheme：它让原生控件（下拉 / 复选框）跟随本页主题，
     否则深色模式下下拉展开的选项会用系统浅色底 + 本页浅色字，导致文字看不清。
     ⚠️ 它同时会影响滚动条绘制，main.css 的 `::-webkit-scrollbar { color-scheme: normal }`
     正为此反向压制，两者是一对，别只改一处。 */
  color-scheme: light;
  max-width: 560px;
  margin: 0 auto;
  padding: 22px 18px 44px;
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
/* 深浅色不跟系统、跟 uTools：html.dark 由脚本按 utools.isDarkColors() 切（见 main.css 同名注释） */
html.dark .page {
  color-scheme: dark;
}
/* 深色下悬停浮出的轨道：main.css 默认给的是浅色系灰，深底上会显脏，这里换成冷白 */
html.dark .log-box:hover::-webkit-scrollbar-track,
html.dark .detail-entries:hover::-webkit-scrollbar-track,
html.dark .mkt-list:hover::-webkit-scrollbar-track {
  background-color: rgba(255, 255, 255, 0.09);
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
/* Tab 行：7 个分组等分整行宽。窄窗口下等分会把「开发者」三字压到字叠字，
   所以给每个 Tab 设 min-width 并让整行可横向滚动（滚动条隐藏，见下）——
   宁可滑动，也不要文字挤压到读不出 */
.tab-row {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow-x: auto;
  scrollbar-width: none;
}
.tab-row::-webkit-scrollbar {
  display: none;
}
.tab {
  flex: 1 0 auto;
  min-width: 52px;
  padding: 3px 6px;
  font-size: 13px;
  white-space: nowrap;
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
/* 选中 Tab 的白字要盖过 .tab:hover 的 var(--fg) 提亮，否则悬停时白字变蓝灰字、在实心蓝底上看不清 */
.tab-on:hover {
  color: #fff;
}
.tab-desc {
  margin: 8px 2px 0;
  font-size: 12px;
  color: var(--fg-faint);
}
/* 卡片搜索：与 Tab 条同处吸顶区。输入框沿用各卡表单的观感（--input-bg / --line），
   type=search 在各平台自带清空叉，这里不再自绘 */
.search-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.search-input {
  flex: 1;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--fg);
  background: var(--input-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.search-input:focus {
  outline: none;
  border-color: var(--accent);
}
.search-clear {
  flex: none;
}
/* 命中卡片一览：一张卡一行，标出它本来的分组 —— 搜索结果是跨组混排的，不给来源就找不到北 */
.search-hits {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 2px 12px;
}
/* 命中标签是按钮（点击滚到对应卡片）：压掉按钮默认样式，hover 时描边高亮，给出可点提示 */
.search-hit-tag {
  padding: 2px 8px;
  font-size: 11px;
  font-family: inherit;
  color: var(--fg-dim);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 999px;
  cursor: pointer;
}
.search-hit-tag:hover {
  color: var(--fg);
  border-color: var(--accent);
}
.search-empty {
  color: var(--fg-dim);
  font-size: 13px;
  line-height: 1.7;
}
.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  /* 点搜索命中标签滚到卡片时，吸顶的 .tab-bar 会盖住卡头；预留它的高度让卡顶落在下方。
     值由 JS 实测吸顶条高后写进 --tab-bar-h（见 onMounted 的 ResizeObserver），
     不写死数字 —— 吸顶区含可换行的 desc，高度随窗口宽变化。兜底 96px 供首帧未测得时用 */
  scroll-margin-top: var(--tab-bar-h, 96px);
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
/* 卡头的「整理」下拉：按钮沿用 utils-outline 基类，这里只负责面板定位。
   .rnd-menu 自己 position:relative 当锚点（不能挂在 .head-actions 上 —— 后面还有别的按钮） */
.rnd-menu {
  position: relative;
}
.rnd-menu-caret {
  font-size: 9px;
  opacity: 0.75;
}
/* 有选中项时按钮变实心强调色：选中态是「操作哪几张」的入口，不显眼用户不会去点，
   而整清单的动作（面板下半段）又不需要选中 —— 明确区分这两种处境 */
.rnd-menu > button.has-sel {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-weak);
}
.rnd-menu-panel {
  position: fixed;
  z-index: 20;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 8px;
  /* 用 fixed + 运行时算出的坐标（见 rndPanelPos 与 toggleRndMenu），top / right 由 :style 给，
     不在这里写 top: calc(...) —— fixed 下百分比相对视口算，纯属死声明。
     之所以不用 absolute 挂在卡头下沿：.tab-bar 是 position:sticky + z-index:5 且带不透明底色，
     粘住后是一条独立的层叠上下文，卡头里的下拉无论写多高的 z-index 都会被它盖住 ——
     滚到一半时面板上半截就会被吸顶条切掉（截图里的现象）。
     挂到 body 下、用 fixed 定位后，下拉与吸顶条不再争夺同一个层叠上下文，也就不必给 tab-bar 降级。
     宽度由内容撑开（fixed 元素默认 shrink-to-fit，无需再写 max-content） */
  background: var(--input-bg);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
/* 面板内的分组标题（「选中的 N 张」/「全部 N 张」）：这面板里并存两类作用范围不同的动作，
   不给小标题就会让人以为它们是一回事。样式上跟菜单项**走同一套内边距、同一档字号**——
   标题若比项更小更挤，视觉上就会像「没有对齐的注释」而不是「这一组的名字」 */
.rnd-menu-title {
  margin: 0;
  padding: 6px 10px 3px;
  font-size: 12px;
  color: var(--fg-dim);
  opacity: 0.9;
  white-space: nowrap;
}
.rnd-menu-sep {
  height: 1px;
  margin: 4px 0;
  /* 与项同宽：左右不留缝，这条线才能当作「一组到此为止」的边界，而不是飘在中间的一道短线 */
  background: var(--line);
}
/* 「全部 N 张」这一族：低频，悬停展开（展开 / 收起的状态在 onDocMoveForRndMenu 里维护）。
   触发项就是那个分组标题本身 —— 再单起一行「更多…」会让面板多一行，
   而标题本来就是「这一族叫什么」的最短说法。指针停在标题或面板上都算「还在这一组里」，
   两者的共同祖先是 .rnd-menu-sub，所以判定只看这一个选择器。
   整块用与菜单项一致的内缩，否则子项会比上面的项明显内陷一层。 */
.rnd-menu-sub {
  padding: 0;
}
.rnd-sub-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 标题本身不是可点项，只是这一组的标牌：右对齐的箭头表示「悬停这里会展开」 */
  cursor: default;
}
.rnd-sub-trigger:hover {
  color: var(--fg);
  opacity: 1;
}
.rnd-sub-caret {
  font-size: 8px;
  opacity: 0.7;
}
.rnd-sub-panel {
  display: flex;
  flex-direction: column;
}
/* 未选中时的引导行：上半段的按钮全不渲染，只剩这一行。做成可点的按钮（点一下给提示）
   而不是纯文字，因为「怎么选中」本身就是这里唯一的未知项；
   用 link-btn 的文字观感而不是菜单项观感 —— 它不是动作，是说明 */
.rnd-menu-guide {
  padding: 6px 10px;
  font-size: 12px;
  text-align: left;
  color: var(--fg-dim);
  opacity: 0.75;
  white-space: nowrap;
}
.rnd-menu-guide:hover {
  opacity: 1;
  background: transparent;
}
.rnd-menu-panel button {
  padding: 6px 10px;
  font-size: 12px;
  text-align: left;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
}
.rnd-menu-panel button:hover:not(:disabled) {
  background: var(--accent-weak);
}
/* 面板里的危险动作（「删除选中的」）：悬停给红底，跟同类字色区分开，
   免得在一列同款菜单项里误点 */
.rnd-menu-panel button.danger {
  color: var(--err);
}
.rnd-menu-panel button.danger:hover:not(:disabled) {
  background: rgba(210, 70, 70, 0.14);
}
/* 已是终态的批量动作置灰：点「全部参与随机」再点一次没有任何变化，
   灰掉能直接告诉用户「当前就是这样」，省掉一次无意义的点击 */
.rnd-menu-panel button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
/* 卡头里的危险操作：配色已由全局 .utils-danger 提供，这里不再复写。 */
/* 「未保存」标记：改完 textarea 不点保存就切 Tab / 关窗口会丢改动，给个常驻提示。
   用 danger 色是因为丢的是用户手写的内容，且 align-self 保证在 flex 行里不拉伸 */
.dirty-tag {
  align-self: center;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.5;
  border-radius: 999px;
  background: var(--err-weak);
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
  color: var(--ok);
}
.diag-warn {
  color: var(--warn);
}
.diag-bad {
  color: var(--err);
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
  border-color: var(--err);
  color: var(--err);
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
  color: var(--err);
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
  border-color: var(--accent);
  color: var(--accent);
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
  background: var(--accent);
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
/* 官方 registry 版本（比目录快照更新）：这一条是「真能升上去」的目标，比目录那行更该被看见，
   所以把 opacity 补回来并加粗 —— 但不上彩色，一行里已经有「可更新」绿标，再上色就打架了 */
.mkt-ver-official {
  opacity: 1;
  font-weight: 600;
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
  /* 原先写 var(--panel2)，全项目没有该定义且无 fallback → background 整条失效，
     这个盒子的底其实是透明的，只剩一圈描边。想要「比卡片再深一档的次级块」用 --track。 */
  background: var(--track);
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
  color: var(--ok);
  font-size: 12px;
  white-space: nowrap;
}
.mkt-src-bad {
  color: var(--err);
}
.mkt-src-btns {
  margin-top: 2px;
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
/* .btn-row 骨架（flex + gap + margin-top + flex-wrap + 按钮等分）与 utils 档位配色
   都已收进 main.css 作单一来源，这里不再留副本。

   历史 hack 已随之上删：旧版给 .btn-row button.secondary/.danger 追加 background:none，
   立论是「全局 button 规则更具体、会漏出实心底」—— 实际全局 `button` 是 (0,0,1)，
   压不过档位类的 (0,1,0)，那两条从未生效过，反倒把次/危险按钮自己的半透明底剥掉过。 */
/* ===== dsh 分组的按钮（dsh 主控 · 环境诊断 · 配置转储 · 全量导出 · 用量统计 · 插件开关 · 插件市场 · Codex 会话统计）=====
   这 8 张卡原先各写各的按钮：主控卡用 .btn-row（实心蓝主 + .secondary 灰蓝、font-size 13 / 无 padding），
   外围四张卡却把 .btn-row 当容器、里面清一色 .secondary（字号掉到按钮默认值），
   候选行的 .patch-btn 又是 2px/10px 的迷你尺寸，分组轴 .iso-axis-btn 更是自带一套胶囊边框 ——
   同一条动作链（刷新 → 预览 → 确认）上的按钮高矮胖瘦全不一样。

   **尺寸/配色那半已经上提到 main.css 的 utils 基类**（markup 挂了 .utils-btn + 对应档），
   这里只剩两件与 dsh 分组强耦合的事：flex 归属（不强制等宽，按钮贴内容宽）与
   胶囊圆角的例外（.iso-axis-btn）。 */
.dsh-card .btn-row button {
  flex: 1 1 auto;
}
/* 「打开 Web UI」的招揽脉动：dsh 起来后它才是可用入口，但同排四个按钮等宽同形，
   光靠实心色仍不够醒目（「启动」本来就是实心，视线会先落在已经禁用变灰的那个上）。
   这里搬运 AccelView 的 .btn-busy 手法：强调色描边 + 亮度呼吸，让视线自己找过来。

   ⚠️ 关键坑（照抄 AccelView 的结论）：不能动 opacity —— 按钮在 dshBusy（更新/查版本）期间
   会同时带 disabled，而 `button.utils-btn:disabled { opacity: .45 }`（0,2,1）特异性高于
   `.dsh-web-hint`，会把 keyframe 里的 opacity 压成固定值，呼吸完全看不出来。
   filter 是独立属性，不与之打架。 */
.dsh-card .dsh-web-btn.dsh-web-hint {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
  animation: dsh-web-hint 1.2s ease-in-out infinite;
}
@keyframes dsh-web-hint {
  0%, 100% { filter: brightness(0.9); }
  50% { filter: brightness(1.3); }
}
/* 尊重系统「减少动态效果」：与 .btn-busy 同策略 —— 不直接 animation:none
   （该动效承载「这里可以点了」的功能信息，关掉后用户就看不出这个按钮有特殊地位了），
   只把节奏放慢、幅度收窄，减轻前庭负担仍保留「在动」的感知 */
@media (prefers-reduced-motion: reduce) {
  .dsh-card .dsh-web-btn.dsh-web-hint {
    animation-duration: 2.4s;
  }
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
  background: var(--accent-weak);
  color: var(--accent);
}
/* 危险档配色全由 .utils-danger 提供（旧版这里的复写与其三值逐字相同，纯冗余已删）。 */
.dsh-card .bak-confirm {
  border-color: var(--err);
  color: var(--err);
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

/* ── 素材包下载进度（内置形象 / 共享角色 / 共享音效三张卡共用一套样式） ──
   条子固定 8px 高：40.6MB 的角色包在慢网下要下好几分钟，进度条要够显眼又不能顶开版式 */
.dl-box {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--track);
}
.dl-track {
  position: relative;
  height: 8px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.dl-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  /* 宽度每 250ms 跳一档，加过渡把台阶磨平，否则看起来像在抖 */
  transition: width 0.25s linear;
}
.dl-bar.done { background: var(--ok); }
.dl-bar.err { background: var(--err); }
/* 总量未知（加速代理回 Transfer-Encoding: chunked，拿不到 Content-Length）：
   不谎报百分比，改成来回扫的滑块表示「在动，但说不准还有多久」 */
.dl-bar.indet {
  width: 35%;
  transition: none;
  animation: dl-slide 1.1s ease-in-out infinite;
}
@keyframes dl-slide {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
.dl-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
}
.dl-label { flex: 0 0 auto; }
/* 字节数用等宽：数字每 250ms 变一次，比例字体下宽度会跳，整行跟着抖 */
.dl-amt {
  flex: 0 1 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.85;
}
.dl-pct {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.85;
}
/* 下载源一行：URL 很长（github.com/.../releases/download/...），必须能断行 + 可复制 */
.dl-src {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
}
.dl-src-tag {
  flex: 0 0 auto;
  opacity: 0.7;
}
.dl-src-url {
  flex: 1 1 auto;
  min-width: 0;
  color: inherit;
  opacity: 0.75;
  word-break: break-all;
  text-decoration: underline;
}
/* 安装 / 更新的终态横幅：整块底色 + 左侧粗色条，做成「一眼就能看出成败」的强度。
   卡底那条 .msg 是 12px 单行细字，混在一起时成功/失败几乎没差别，
   更新完还容易被日志推高到视野外 —— 这里靠色块和留白把它拉回视线中心 */
.dsh-result {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 10px 0 0;
  padding: 10px 12px;
  border-left: 4px solid var(--ok);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  font-size: 13px;
  line-height: 1.55;
  color: var(--fg);
}
.dsh-result.err {
  border-left-color: var(--err);
  background: color-mix(in srgb, var(--err) 14%, transparent);
}
.dsh-result-icon {
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--ok);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}
.dsh-result.err .dsh-result-icon {
  background: var(--err);
}
.dsh-result-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
/* 关闭按钮：默认弱化，悬停才显形，避免抢横幅本身的注意力 */
.dsh-result-close {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg-dim);
  font-size: 16px;
  line-height: 20px;
  cursor: pointer;
}
.dsh-result-close:hover {
  color: var(--fg);
}
/* 「版本说明」折叠按钮：与「运行详情」「dsh 故障排查」同款 —— 独占一行、挂
   .link-btn.utils-btn.utils-secondary，连下划线一并保留（那两个也没去掉，去掉反而与本块其余按钮不一致）。
   这里只治外边距：那两个按钮在 .fold 里（.fold > .link-btn 给了 margin-top:0），
   本按钮直接落在卡片流里、没有 .fold 包着，得自己把 .link-btn 那个「独立成行」的 10px 收掉 */
.notes-toggle {
  margin-top: 0;
}
/* 说明正文：复用 .guide 的容器底色与边框，只补条目排版 */
.notes-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.notes-sec-title {
  font-weight: 600;
  color: var(--fg);
}
.notes-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 2px;
  color: var(--fg-dim);
}
/* 条目文字可换行收缩，来源版本作为右标不换行、不抢宽（与 .ver 同一处理思路） */
.notes-item-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.notes-item-from {
  flex: none;
  color: var(--fg-faint);
  font-size: 11px;
}
/* truncated 提示与「正在获取」：沿用 .hint 的字号，只去掉其在 .guide 内多余的上下外边距 */
.notes-trunc,
.notes-busy {
  margin: 0;
}
/* 「已是最新版本」：占 .field.row 的右侧位，与相邻行的版本号/命令文本对齐 */
.notes-latest {
  margin: 0;
}
/* .link-btn 基类已上提 main.css（单一来源）：原先只在本文件 scoped 里定义，
   AccelView / UsageChart / FirstRunGuide 里的同名类全是匹配不上的死类。
   下面几条只留与本文件布局强耦合的间距覆写。 */
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
/* 「数据目录」里展示的落盘路径：等宽、可截断，长路径不把按钮挤出去 */
.dir-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 6px;
  border-radius: 4px;
  /* 原先写 var(--bg)，全项目没有该定义且无 fallback → background 整条失效，
     路径标签没有底衬。这是只读的等宽值标签，用输入框底色 --input-bg 最贴近。 */
  background: var(--input-bg);
  color: var(--fg-dim);
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
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
  margin-top: 2px;
  padding: 7px 9px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  resize: vertical;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg);
}
.quote-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(83, 107, 169, 0.18);
}
/* 随机台词组：一行一组，表头（类型 / 权重 / 字号 / 排序 / 删除）+ 台词框。
   卡内嵌卡：card-bg 半透明叠一层做出层级，边框用更安静的 card-border，悬停再亮回 line */
.quote-group {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--card-border);
  border-radius: 10px;
  background: var(--card-bg);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.quote-group:hover {
  border-color: var(--line);
}
/* 正在预览的组：整卡亮起（此前只有「预览」按钮变色，卡片多了得来回找是哪组在播 */
.quote-group-on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-weak);
}
/* 组序号徽标：锚定卡片 + 可视化顺序（「依次播放」按这里的先后顺序出场） */
.quote-group-no {
  flex: 0 0 auto;
  min-width: 22px;
  padding: 2px 6px;
  border-radius: 9px;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
}
.quote-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  /* 加入组级音效下拉后表头变宽，窗口窄时固定不换行会把右侧按钮顶出卡片边框 */
  flex-wrap: wrap;
}
/* 行内下拉/输入框：全局规则是 width:100%，在表头里会把其余控件挤出去 */
.quote-group-head select,
.quote-group-head .num {
  width: auto;
  flex: 0 0 auto;
}
/* 表头按钮不缩不折行：utils-btn 基类没有 nowrap，行一挤「预览」「删除」会被压成竖排字。
   空间不够时该让步的是内容预览灰字（它有 ellipsis），不是按钮 */
.quote-group-head .export-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
.quote-w {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--fg-dim);
}
/* 卡头内容预览：一行小灰字，超长截断（弹性行里既不挤压控件也不把按钮顶出去） */
.quote-group-preview {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg-dim);
}
/* 行×段编辑器（第 3 期）：行头 / chips / 段字段区 */
.quote-adv-row,
.quote-add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.quote-tpl-select {
  width: auto;
  flex: 0 0 auto;
}
/* 组级音效下拉：宽度压到内容附近，表头空间紧（预览灰字负责让步） */
.quote-sound-select {
  max-width: 140px;
}
.quote-row {
  margin-bottom: 6px;
}
.quote-row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.quote-row-no {
  font-size: 12px;
  color: var(--fg-dim);
  flex: 0 0 auto;
}
.quote-row-wrap {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--fg-dim);
}
/* 停留秒数小输入框：三位数够用，别跟着 .num 默认宽度把行头撑折行 */
.quote-dwell-in {
  width: 52px;
}
.quote-row-sp {
  flex: 1;
}
.quote-row-head .export-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
.quote-seg-add {
  width: auto;
  flex: 0 0 auto;
}
/* 行条件 chip 与编辑条：chip 亮起 = 这行带条件；编辑条一行排开，窄了换行 */
.quote-cond-chip {
  border: 1px dashed var(--card-border);
  border-radius: 10px;
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 3px 8px;
  cursor: pointer;
  flex: 0 0 auto;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.quote-cond-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.quote-cond-chip-on {
  border-style: solid;
  border-color: var(--accent);
  color: var(--accent);
}
.quote-cond-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin: 2px 0 4px;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--input-bg);
}
.quote-cond-type,
.quote-cond-model {
  width: auto;
  flex: 0 0 auto;
  font-size: 12px;
}
.quote-cond-num {
  width: 72px;
}
.quote-cond-day {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
}
.quote-cond-note {
  opacity: .65;
}
.quote-row-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 26px;
  padding: 5px;
  border: 1px dashed var(--card-border);
  border-radius: 8px;
}
.quote-row-chips:focus-within {
  border-color: var(--accent);
}
.quote-row-empty {
  font-size: 12px;
  color: var(--fg-dim);
  align-self: center;
}
.quote-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 200px;
  padding: 2px 4px 2px 8px;
  border: 1px solid var(--card-border);
  border-radius: 6px;
  background: var(--input-bg);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  overflow: hidden;
}
.quote-chip-image { background: rgba(83, 107, 169, 0.12); }
.quote-chip-link { background: rgba(47, 162, 76, 0.12); }
.quote-chip-model { background: rgba(180, 130, 60, 0.12); }
.quote-chip-on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(83, 107, 169, 0.25);
}
.quote-chip-x {
  border: none;
  background: none;
  padding: 0 3px;
  font-size: 12px;
  line-height: 1;
  color: var(--fg-faint);
  cursor: pointer;
  border-radius: 4px;
}
.quote-chip-x:hover {
  color: var(--err);
}
.quote-seg-editor {
  margin-top: 6px;
  padding: 8px 10px;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--input-bg);
}
.quote-seg-editor-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--fg-dim);
}
.quote-seg-sp {
  flex: 1;
}
.quote-seg-editor-head .export-btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
.quote-seg-t {
  width: 100%;
  margin-bottom: 6px;
}
.quote-seg-flags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--fg-dim);
}
.quote-flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.quote-seg-c {
  width: 90px;
}
.quote-seg-note {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--fg-dim);
}
.quote-chip-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.quote-chip-row-label {
  font-size: 12px;
  color: var(--fg-dim);
}
.quote-chip-btn {
  padding: 2px 8px;
  border: 1px solid var(--card-border);
  border-radius: 10px;
  background: var(--input-bg);
  font-size: 12px;
  cursor: pointer;
  color: var(--fg);
  transition: border-color 0.15s ease, color 0.15s ease;
}
.quote-chip-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
/* 占位撑开，把排序 / 删除推到右侧 */
.quote-group-sp {
  flex: 1;
}
/* 表头右侧操作按钮打包成整体：单行时与原布局一致，换行时四个按钮整组落到第二行，不会散开或溢出 */
.quote-group-acts {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.quote-group-note {
  margin: 0;
}
.quote-group-tip {
  margin: 0 0 8px;
}
/* 台词预览：空态提示贴左边距与组列表对齐 */
.quote-preview-empty {
  margin: 4px 0 0;
}
/* 预览元信息：导航行（计数 + 下一条）与说明行各占一行，不再挤在一起折行悬半句 */
.quote-preview-meta {
  margin-top: 2px;
}
/* 预览位置双档切换：label 行与档位按钮并排，档位不用 range-tab 的 flex:1 撑满 */
.quote-preview-label {
  display: flex;
  align-items: center;
  gap: 10px;
}
.quote-preview-tabs {
  flex: 0 0 auto;
}
.quote-preview-tab {
  flex: 0 0 auto;
  padding: 2px 14px;
  font-size: 12px;
}
.quote-preview-meta .hint {
  margin: 2px 0 0;
}
.quote-preview-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}
.quote-preview-next {
  flex: 0 0 auto;
  padding: 1px 10px;
  font-size: 12px;
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
/* ===== 「导入的音效」：六个槽位各成一个块 =====
   块 = 槽位头（角色名 + 概况 + 导入/替换按钮）+ 该槽位那一段（最多一段）的明细。
   原先这里只有一条 padding-left 缩进，没有底色 / 描边 / 块间距，
   六个槽位连同各自的明细在视觉上连成一片，看不出归属。 */
.sound-group {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--card-border);
  border-radius: 10px;
  background: var(--card-bg);
}
.sound-group:first-of-type {
  /* 紧跟在卡片标题下，不需要再多一层上边距 */
  margin-top: 4px;
}
.sound-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 槽位头里的概况文案占住中间剩余宽度，把「导入 / 替换」按钮推到行尾 ——
   六个块的按钮因此左边界一致 */
.sound-group-head .asset-meta {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sound-seg {
  display: flex;
  align-items: center;
  /* 允许换行，配合下面 .seg-time 的 flex-basis:100% 把它挤到第二行 */
  flex-wrap: wrap;
  gap: 8px;
  /* 与槽位头拉开一点距离即可：这段就属于上面那个槽位，不需要分隔线再切一刀 */
  margin-top: 6px;
}
.seg-ops {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 6px;
}
/* 导入时间：单独占满一行（flex-basis:100% 逼它换行），比原来挤在行尾更短更易扫。
   同一个槽位里多个同名段（都叫「来财」）就是靠这里的时分来区分先后。 */
.seg-time {
  flex: 1 1 100%;
  font-size: 11px;
  color: var(--fg-faint);
  white-space: nowrap;
}
/* ===== 共享音效库的分组列表 =====
   「已下载」与「未下载」分开渲染（见模板注释：两类行控件数差 3 个，混排必然列对不齐）。
   每行是上下两段：
   - .shs-main 主线：文件名 + 体积，文件名 flex:1 独占剩余宽度，不再被控件挤压
   - .shs-ops  副线：动作控件，与文件名左对齐，窄卡片里可换行
   这是把一个 6 元素横铺的行拆成「读的一行 + 操作的一行」，让 45 行扫下来能对齐。 */
.shs-list {
  margin-top: 4px;
}
.shs-row {
  padding: 6px 0;
  border-top: 1px solid var(--track);
}
/* 行内竖向留白 + 上下两段之间的间距；用 padding 而非 margin，
   保证 border-top 是紧贴上一行、间距全部落在下面 */
.shs-row:first-of-type {
  border-top: none;
  padding-top: 0;
}
.shs-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.shs-ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
/* 槽位下拉：给个基准宽度而不是 flex:1 铺满 —— 铺满后「选用 / 试听 / 删」会被推到行尾，
   离开文件名的视线范围；固定宽度更紧凑，也让 45 行的按钮列左右对齐。
   用 --input-bg 而非透明：它是个可选下拉，透明底会和「试听 / 删」两个描边按钮糊在一起 */
.shs-ops .sound-role-pick {
  flex: 0 1 150px;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg-dim);
  font-size: 12px;
}
/* 正在试听的那一段：按钮切成「停止」并给强调色描边，让用户在 45 行里一眼找到在放哪条。
   配色跟随主题（--accent），不写死颜色 */
.shs-ops .preview-on {
  color: var(--accent);
  border-color: var(--accent);
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
/* 一格 = 一个 64×64 的预览图框。操作（置顶 / 随机 / 删）已改为悬停时浮在图上
   （见 .skin-cell-ops），格内常态只有图 +「使用中 / 下载」角标，网格紧凑干净。
   .skin-box 是「图 + 角标 + 操作条」的定位锚。 */
.skin-cell {
  position: relative;
  display: block;
  width: 64px;
}
/* 预览图框：虚线棋盘底（透明图能看出透明区）+ 圆角描边，挂在 .skin-box 上，
   这样内置形象（没有 pick 包裹层）与其它格长得一样 */
.skin-box {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background-color: #fff;
  background-image: linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%),
    linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%);
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
}
/* 图片与角标各自裁圆角 —— 不能给 .skin-box 加 overflow:hidden，
   否则「使用中」的外发光（box-shadow 画在边框外）会被裁掉看不见 */
.skin-cell-img,
.skin-cell-broken,
.skin-cell-none {
  border-radius: 8px;
  overflow: hidden;
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
.skin-cell.active .skin-box {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(83, 107, 169, 0.28);
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
/* 缩略图读到一半失败（文件被外部删了、动图解码失败、data URL 超长被截断等）也要给个反馈，
   不能留一块空白格让人以为「没导入进来」。JS 侧把该格标记成 thumbBroken，这里只负责显示 */
.skin-cell-broken {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 11px;
  color: var(--fg-dim);
  text-align: center;
  line-height: 1.4;
}
/* 「置顶 / 删除」已从**导入的形象**每格图内移到卡头（见 .head-actions），图上不再挂操作条 ——
   原先每格悬停浮出一行小按钮，37 格下来整屏全是按钮、图本身读不清。
   现在靠「单击选中」这一个中间态承接：选中格加主题色描边（.skin-cell.picked），
   卡头的「置顶 / 删除」作用于它。
   下面 .skin-cell-ops / .skin-op 仍供**气泡图 / 皮肤包 / 共享角色**三处网格使用（它们的操作简单、
   格数也少，贴格悬停浮现比搬到卡头更直接），故不能删。 */
.skin-cell-ops {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 1px;
  border-radius: 8px 8px 0 0;
  /* 不铺满整条的深色遮罩 —— 只给按钮各自底色的淡淡渐变托底，尽量减少对图的遮挡 */
  background: linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.skin-cell:hover .skin-cell-ops,
.skin-cell:focus-within .skin-cell-ops,
.skin-cell.active .skin-cell-ops {
  opacity: 1;
  pointer-events: auto;
}
.skin-op {
  flex: 0 0 auto;
  padding: 0 2px;
  font-size: 10px;
  line-height: 1.5;
  border: none;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
}
.skin-op.danger {
  background: rgba(210, 70, 70, 0.9);
}
.skin-op:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
/* 普通选中（.skin-cell.picked）：单击缩略图切换选中，供「整理」面板里
   「选中的 N 张」那一段作用。可多选，所以是「集合里的每个都描边」而不是单选高亮。
   与「使用中」（右下角 .skin-cell-tag）区分开 —— 选中只是「接下来要操作它」，不等于启用。 */
.skin-cell.picked {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.skin-cell.picked .skin-box {
  background: var(--accent-weak);
}
.skin-cell-tag {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 3px;
  font-size: 9px;
  line-height: 1.4;
  border-radius: 6px 0 6px 0;
  background: rgba(83, 107, 169, 0.9);
  color: #fff;
  pointer-events: none;
}
/* 序号（左下角）：让「置 / ↑↓」的效果可验证，也方便描述「第几张」。
   放左下而不是左上 —— 顶部整条被悬停操作条（.skin-cell-ops）占据，序号在左上会被按钮盖住。
   右下角是「使用中」角标，左下角空着，正好错开。
   悬停时淡出：操作条要盖住上半张图的视觉重心，序号此刻已不必要，隐去更清爽 */
.skin-cell-idx {
  position: absolute;
  left: 0;
  bottom: 0;
  min-width: 13px;
  padding: 0 3px;
  font-size: 9px;
  line-height: 13px;
  text-align: center;
  color: #fff;
  border-radius: 0 6px 0 6px;
  background: rgba(0, 0, 0, 0.32);
  pointer-events: none;
  z-index: 1;
  transition: opacity 0.12s ease;
}
.skin-cell:hover .skin-cell-idx,
.skin-cell:focus-within .skin-cell-idx,
.skin-cell.dragging .skin-cell-idx {
  opacity: 0;
}
/* 拖拽排序：源格半透明表示「正在被搬走」；落点格用左侧/右侧一条竖线提示插入位置。
   指示线用 ::before/::after 画，避免再加 DOM 节点影响 flex 布局。 */
.skin-cell.dragging {
  opacity: 0.4;
}
.skin-cell.drop-before::before,
.skin-cell.drop-after::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}
.skin-cell.drop-before::before {
  left: -2px;
}
.skin-cell.drop-after::after {
  right: -2px;
}
/* 可拖拽时给个抓手指针；批量模式下不可拖（此时点格是勾选） */
.skin-cell[draggable='true'] .skin-cell-pick {
  cursor: grab;
}
.skin-cell.dragging .skin-cell-pick {
  cursor: grabbing;
}
/* 操作条已在顶部（.skin-cell-ops），与右下角的「使用中 / 角色名」角标不再抢位，无需再抬角标。
   左上角的「下载」角标只出现在**未下载**的格上，而操作条只在**已下载**的格上出现，二者互斥、也不会撞。 */
/* 「下载」角标：贴在图片左上角（`.skin-cell-tag` 占右下角）。
   注意别再写第二份覆盖规则 —— 之前这里与下方重复定义过，后写的那份把 top/right/size
   全改了，角标位置与预期不符。现在只服务「未下载 · 可下载」一种语义（已下载的不再贴角标）。 */
.skin-cell-badge {
  position: absolute;
  left: 0;
  top: 0;
  padding: 0 3px;
  font-size: 9px;
  line-height: 1.4;
  border-radius: 0 0 6px 0;
  background: rgba(83, 107, 169, 0.9);
  color: #fff;
  pointer-events: none;
  white-space: nowrap;
}
/* 缩略图缺失 / 加载失败（文件被外部删了、动图解码失败、data URL 超长被截断等）都要给整格套警示色，
   一眼能从一片正常格里认出「这张坏了要重导」。两档：
   - `.broken`：thumb 有值但解码失败（@error 置位），文案「预览失败」—— 大概率文件损坏
   - `.noprev`：thumb 为空（没缩略图且回落读原图也失败），文案「无预览」—— 大概率文件已被删
   早先只有 @error 才描边，导致「无预览」那格混在正常格里、只显示一块灰字，看不出是坏的。 */
.skin-cell.broken .skin-box,
.skin-cell.noprev .skin-box {
  border-color: rgba(200, 90, 60, 0.75);
  background-color: rgba(200, 90, 60, 0.08);
}
/* 未下载的远程形象：整格压暗 + 缩略图降饱和，一眼看出「还没下来」，
   但缩略图仍可见 —— 让用户在下手前看得见长什么样 */
.skin-cell.is-remote .skin-cell-img {
  opacity: 0.45;
  filter: grayscale(0.7);
}
.skin-cell.is-remote .skin-cell-tag {
  background: rgba(0, 0, 0, 0.45);
}
/* 「正在使用的那张已移出插件包、还没下载回来」：标签改成警示色，并且不再被
   .is-remote 的压暗覆盖 —— 这张是用户最该看见和点的一张 */
.skin-cell-tag.warn {
  background: rgba(200, 120, 30, 0.92);
}
.skin-cell.is-remote .skin-cell-tag.warn {
  background: rgba(200, 120, 30, 0.92);
}
/* 「导入」格：内容为「＋ / 导入」，位置与其它 64×64 图框对齐。
   边框改**实线**、底色与 .skin-box 同款棋盘 —— 早先用虚线 + 纯色底，夹在一排棋盘格里
   看着像"这一格坏了"，实线 + 同底后它是一枚正常的「加图」按钮。 */
.skin-cell-add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background-color: #fff;
  background-image: linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%),
    linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%);
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
  color: var(--fg-dim);
  cursor: pointer;
}
.skin-cell-add:hover {
  border-color: var(--accent);
  color: var(--accent);
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
