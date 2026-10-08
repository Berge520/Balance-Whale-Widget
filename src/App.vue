<script lang="ts" setup>
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AlertRole, BubbleMeta, CodexWindow, CodexWindows, DshMarketPlugin, SkinGallery, SkinMeta, SkinPackList, SoundMeta, SoundRole, WhaleModel, WhaleModelRow, WhaleModelTemplate, WhalePriceModel, WhaleServices, WhaleTokenPrice } from './types/services'
import SkinCropper from './components/SkinCropper.vue'
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
// 按需异步加载：全仓最大的视图（形象画廊 / 音效 / 素材包编辑都在这），抽成独立 chunk 给主包瘦身；
// 组件恒挂载（无 v-if），chunk 在启动即取，但主包解析变小变快。expose 仅供外部预留，父级无 ref 调用点，异步安全。
const AssetsView = defineAsyncComponent(() => import('./views/AssetsView.vue'))
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
// 「按压气泡（自定义泡泡）」整卡：点小鲸鱼时按顺序弹的泡泡队列编辑器。
// 数据层 / 渲染层 / 试播 IPC / 挂件消费侧都已齐备（宿主 store.js 的 normBubble、悬浮页 bubbleItems），
// 本卡只补编辑入口 —— 故不需要新 IPC 通道；队列只读概览 + 试播内聚在组件里，
// 落盘统一 emit('patch', { bubble })；挂件菜单「气泡设置」的导航订阅留在父级
// （与 onConfigChange 同处 onMounted），组件不重复管生命周期。
// 按需异步加载：BubbleQueueEditor / BubbleModPanel / BubblePreview 与共享渲染器只被本卡引用，
// 整族抽成独立 chunk 后首屏包明显变小（本卡只在「外观」Tab 的泡泡卡展开时才渲染）。
const BubbleView = defineAsyncComponent(() => import('./views/BubbleView.vue'))
// 「用量与账本」整卡。账本快照与刷新入口（refreshHistory / refreshTodayModels）留在父级——
// 窗口聚焦 / 挂载 / 恢复备份 / 清除数据后父级都要主动刷新，故这里用 props 收、emit 触发；
// 卡片内需要父级同步结果的回填（账本截取所需数据）经 defineExpose 暴露方法，父级用模板 ref 调用。
import UsageView from './views/UsageView.vue'
// 「提醒与通知」整卡。计时时长 / 提醒开关与阈值 / 通知渠道 / SMTP 配置 / 提醒音音量 / 提醒文案
// 都内聚在组件内；applyConfig 回填后要落「未保存」基线、备份恢复后要刷新计时三段展示，这两处
// 父级驱动，故组件用 defineExpose 暴露 syncAlertsBaseline / syncTimerHms，父级用模板 ref 调用。
// SMTP 凭据改由组件自己 onMounted 读回（父级 onMounted 时它的 ref 还没建立，会空转），
// 故 loadMailSecrets 仍保留在 defineExpose 里备用，但父级不再调。保存 / 恢复默认提醒文案需父级整份
// applyConfig，故 emit('save-alerts')。
import NotifyView from './views/NotifyView.vue'
// 「模型与余额」整卡。行内表单 / 展开态 / 删除确认 / 测试 / 刷新 / 增删改都内聚在组件内；
// 跨卡共享的运行时快照（models）、配置清单（modelConfigs）、主显示 id（modelsMainId）、
// 模板与上限、以及 fmtTokens / codexWinText 仍留父级，故按 props 下传；保存 / 删除 / 刷新后
// 需要父级 reloadModels 重新取快照，故 emit('reload')；主显示切换经 update:mainId 上抛。
// 按需异步加载：expose 的 closeModelForm 仅组件内部使用，父级无 ref 调用点，异步安全。
const ModelsView = defineAsyncComponent(() => import('./views/ModelsView.vue'))
// 「使用帮助」整卡：使用说明 / 快捷键绑定 / 挂件故障排查 / 挂件创建错误详情。
// 卡片自身的折叠态与诊断日志入口内聚在组件内；挂件错误状态（errDetail / errFlash）与
// checkWidgetError 由父级 onMounted、showWidget 驱动，故按 props 收、emit 触发；
// 「复制指令名 / 新增快捷键」与窗口卡共用父级消息槽，「新手引导重开」的浮层在父级模板，故均 emit。
import HelpView from './views/HelpView.vue'
// 「Codex 会话统计」整卡：读 ~/.codex/sessions 的 rollout JSONL 做统计，纯本地不联网。
// fmtTokens / codexWinText / codexDayLabel 与图表档位是跨卡共享的单一来源（模型列表行、
// dsh 用量卡也在用），按 props 下传；本卡是否有窗口数据经 emit('windows') 上抛，并入父级的
// 倒计时心跳 codexTickNeed。与其上 7 张 dsh 卡之间的 hr.group-sep 依赖 searchActive / activeTab，留父级。
// 按需异步加载：只在「开发者」Tab 渲染，内含 UsageChart 图表组件，首次切到该 Tab 才取这段 JS。
const CodexView = defineAsyncComponent(() => import('./views/CodexView.vue'))

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
// 原先 12 张卡片竖排一屏到底（模板近千行），找一项要滚很久；按主题分 7 组，一次只看一组。
// 每张卡片用 v-if="activeTab === 'xxx'" 归到组里（不额外套容器层）。组内顺序 = 卡片在模板里的先后；
// 但不同组的卡片是交错排布的（如「数据」的凭据卡在模板最前、「帮助」的关于卡在最后），
// 所以看模板不要以为同一组的卡挨在一起 —— 渲染顺序由下面 TABS 的 key 决定，与源码位置无关。
// desc 是分组说明：凭据、备份这类「不常用但找不到会着急」的项靠它暴露位置；
// 它得与卡片实际**顺序和数量**对得上（按错顺序写、漏掉某张卡，用户按描述找就会找不到）。
const TABS = [
  { key: 'look', label: '外观', desc: '挂件外观 · 按压气泡' },
  // desc 只列**真实存在的卡片**、且用卡片标题的原词：此前写「形象画廊」（卡名是「导入的形象」）、
  // 又把「素材包」当并列卡列出（它其实是「资源概览」卡里的导出/导入入口，不是独立卡）→ 用户按描述找不到。
  // 同理，「内置资源（随插件附带，只作对照）」已改名为「内置资源与下载源」（卡内确有可编辑的下载源）。
  { key: 'assets', label: '资源', desc: '我的素材：资源概览 · 形象 · 气泡图 · 音效　｜　下载素材：内置资源与下载源 · 共享形象 · 共享音效' },
  { key: 'usage', label: '用量', desc: '用量与账本 · 提醒与通知 · 模型与余额' },
  // 本组只有一张卡，「挂件窗口」这个卡名起头最有用（原先只列分区名，用户不知道这页就是挂件窗口）
  { key: 'window', label: '窗口', desc: '挂件窗口：显隐 · 位置 · 透明度 · 穿透' },
  { key: 'data', label: '数据', desc: 'DeepSeek 凭据 · 清除数据 · 备份与恢复' },
  // 顺渲染顺序（模板里 HelpView → AboutView → AccelView）；此前漏了「GitHub 加速」卡，
  // 后又把它错列在「关于与更新」之前，用户按描述找加速会先撞上关于
  { key: 'help', label: '帮助', desc: '使用帮助 · 关于与更新 · GitHub 加速' },
  // desc 是 Tab 栏下方的静态说明，得与卡片的实际顺序、数量对得上：
  // 原先只列「dsh / dsh 用量 / Codex」三项，而这一页实际有 8 张卡，用户按描述找
  // 「插件开关」「插件市场」会以为不在这里。按实际顺序列全，并把非 dsh 的 Codex 单独隔开。
  // 与其它组同口径用卡片标题原词（主控卡标题即「DeepSeek Harness（dsh）」，不再另起「主控」这种别名）
  { key: 'dev', label: '开发者', desc: 'DeepSeek Harness（dsh） · dsh 环境诊断 · dsh 配置转储 · dsh 全量导出 · dsh 用量统计 · dsh 插件开关 · dsh 插件市场　｜　Codex 会话统计' },
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
  look: { label: '挂件外观', tab: 'look', keys: '形象 皮肤 音色 音效 音量 大小 缩放 气泡 主题 报时 点按 播放 界面 深浅色 深色 浅色 暗色 亮色 跟随 uTools 峰谷 文案 随机 节假日 法定节假日表 更新' },
  // 按压气泡（自定义泡泡）：卡内字段名简单（「按压气泡开关」「思考气泡」），
  // 但真正要能被搜到的是「自定义泡泡 / 点我弹什么 / 点击队列」这类叫法，一并收进 keys。
  // 挂件菜单的「气泡设置」按钮也指向本卡（导航 target='bubble'）
  bubbleCustom: { label: '按压气泡（自定义泡泡）', tab: 'look', keys: '按压气泡 自定义泡泡 泡泡 气泡 编辑 撤销 重做 队列 排序 步骤 模块 行 文本 报时 余额 赠金 充值 今日 峰谷 对话名 随机 超链接 图片 动图 额度 订阅 试播 预览 开关 思考 点我 点击 停留' },
  assetsOverview: { label: '资源概览', tab: 'assets', keys: '素材 形象 音效 气泡图 占用 体积 清除 未使用 素材包 导出 导入' },
  assetsSkins: { label: '导入的形象', tab: 'assets', keys: '形象 皮肤 图片 缩略图 置顶 删除 导入' },
  assetsBubbles: { label: '导入的气泡图', tab: 'assets', keys: '气泡 图 动图 gif 图片 导入 删除' },
  assetsSounds: { label: '导入的音效', tab: 'assets', keys: '音效 声音 按压 释放 提醒音 试听 导入 删除 共享音效库 筛选 过滤 搜索 候选' },
  assetsBuiltin: { label: '内置资源与下载源', tab: 'assets', keys: '内置 形象 音色 对照 预览 下载源' },
  // 这两张卡此前漏登记：模板里有 data-search="assetsSharedSkins/SharedSounds"，
  // 但 SEARCH_INDEX 没登记 → 搜「共享」「角色」找不到，且搜索态下这两张卡永不渲染
  // （cardOn 走 searchHits，不在索引里就等于命中不了）。别再漏。
  assetsSharedSkins: { label: '共享形象', tab: 'assets', keys: '共享 角色 形象 下载 选用 预览 缩略图' },
  assetsSharedSounds: { label: '共享音效', tab: 'assets', keys: '共享 音效 声音 下载 选用 试听 角色 段 筛选 过滤 搜索 已参加播放 一段都没挂' },
  usage: { label: '用量与账本', tab: 'usage', keys: '用量 趋势 账本 历史 区间 导出 csv 导入 校准 额度 单价 模型占比 明细 币种 汇率 保留' },
  notify: { label: '提醒与通知', tab: 'usage', keys: '提醒 通知 系统通知 邮件 smtp 预算 低余额 波动 免打扰 计时 倒计时 休息 预警 阈值 端口 ssl tls 直连 账号 授权码 发件人 收件人 主题 前缀 停留 切换' },
  models: { label: '模型与余额', tab: 'usage', keys: '模型 余额 提供商 厂商 刷新 api key 额度 主显示 密钥 凭据 token 名称 类型 币种 接口 地址 base url scale 认证 字段 路径 取值 倍数 重置 提醒 阈值' },
  window: { label: '挂件窗口', tab: 'window', keys: '窗口 显隐 位置 复位 透明度 穿透 吸附 翻转 避让 任务栏 间距 插件 滚动条 置顶 锁定 贴边 宽度' },
  help: { label: '使用帮助', tab: 'help', keys: '帮助 快捷键 使用说明 故障排查 日志 新手引导 异常 详情' },
  privacy: { label: '清除数据', tab: 'data', keys: '清除 数据 隐私 重置 卸载 凭据 挂件 账本 窗口 素材' },
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
  // 按压气泡（自定义泡泡）配置对象。宿主 normBubble 的出口恒定形态，这里只做兜底初始值，
  // 真值由 applyConfig 从 c.bubble 回填 —— **漏了这步整卡就全是死的**（曾经踩过）：
  // BubbleView 读 cfg.bubble.items，回填缺失 → 恒读 undefined → items 恒为 []，
  // 于是「加一步」按下去宿主其实存成功了，设置页却永远显示 0 步，看着就是按钮点不动。
  bubble: { v: 1, on: false, items: [] as any[], lib: [] as any[], tapAdvance: false, dwell: 5, dragLines: [] as string[], system: {} as Record<string, string[]> },
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

// dsh 九张卡的前端逻辑整体在 useDsh composable（见文件下方解构处的说明）
import { useDsh } from './composables/useDsh'

// —— DeepSeek Harness（dsh，开发者） ——
// 九张 dsh 卡的状态 / 请求 / 轮询 / 清理内聚在 useDsh（src/composables/useDsh.ts），
// 这里原位扁平解构接回：模板与既有调用点全部用裸名，行为与抽出前一致。
// 留在本文件的三个通用件：usePolling（任务栏轮询共用）、devFolds / devStatsLoaded / toggleDevCard
// （模板折叠态 + 展开才读的读卡入口；toggleDevCard 体内调用的刷新函数全部来自下方解构）。
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
// 两张统计卡默认收起，首次「展开」时才读取：宿主是同步扫文件（会话日志可能几十 MB），
// 不看不读，避免每次进开发者 Tab 都无条件付一次扫描成本；展开后即读，也不用手动再点一下。
// 收起时摘要只在「本会话已读过」之后才显示（否则露「点击展开查看」），保证折叠 = 不预读。
const devFolds = reactive({ dshUsage: false, diagnose: false, dshDump: false, dshIsolate: false, dshMarket: false, dshExport: false })
const devStatsLoaded = reactive({ dshUsage: false, diagnose: false, dshDump: false, dshIsolate: false, dshMarket: false, dshExport: false })
function toggleDevCard(key: 'dshUsage' | 'diagnose' | 'dshDump' | 'dshIsolate' | 'dshMarket' | 'dshExport') {
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
const {
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
  fmtDshCost
} = useDsh({ services, cfg, patchCfg, activeTab, DEFAULT_DSH_PORT, useFlash, usePolling, devStatsLoaded })

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
// 大小档位：1–SCALE_STEPS 线性映射到 MIN_SCALE–MAX_SCALE（档位 k 的倍率 = numToScale(k)）。
// 这是**全链路唯一刻度** —— 设置页滑块与数字框、浮动页菜单滑块、宿主落库归一都用它，
// 且必须与 public/preload/lib/constants.js 的 SCALE_STEPS 同值（check-shared.mjs 校验）。
// 原为 1–20 档，档位 20（=2.5 倍）太大，收到 15（最大约 2.1 倍）。
const SCALE_STEPS = 15
// 档位 ↔ 倍率换算。分母是 SCALE_STEPS - 1：15 档时步长 (2.5-0.6)/14 ≈ 0.1357
function scaleToNum(s: number) {
  return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1))) + 1
}
function numToScale(n: number) {
  const v = Math.max(1, Math.min(SCALE_STEPS, Math.round(n)))
  return MIN_SCALE + (v - 1) * ((MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1))
}
// 把任意倍率吸附到最近的整数档倍率：旧存储里的 1.3/1.6 这类非整档值启动时归一到档位
function snapScale(s: number) {
  return numToScale(scaleToNum(Number(s)))
}
// 大小输入：LookView 用 :value 绑定（不直接改 cfg），把数值 emit 上来，这里落 cfg。
// 拖动中**不推实时缩放给挂件**（原先发 __live）：滑块所在窗口就是被缩放的对象，拖动中改窗口
// 尺寸会让窗口边动边缩、thumb 追着手抖，快速滑动每帧一次 setBounds 更是直接闪 ——
// 拖动期只更新读数与 cfg.scaleNum（纯 DOM），松手/失焦(onScaleCommit)才落盘并让挂件改窗口。
function onScaleNumLive(v: number) {
  const n = Math.max(1, Math.min(SCALE_STEPS, Math.round(Number(v) || 1)))
  cfg.scaleNum = n
  cfg.scale = numToScale(n)
}
function onScaleCommit() {
  // 松手/失焦：一次性持久化并同步给挂件
  const n = Math.max(1, Math.min(SCALE_STEPS, Math.round(Number(cfg.scaleNum) || 1)))
  cfg.scaleNum = n
  cfg.scale = numToScale(n)
  services.saveConfig?.({ scale: cfg.scale })
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
// 试听某一段（idx 是该槽位里的第几段；一段一槽位后恒为 0，留 idx 是为迁就旧数据的多段形态）
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
// 试听共享库里的一段（资源 tab 槽位内的「选用…」面板用）：按落盘文件名取 data URL。
// 本来只有「共享音效」卡自己的试听函数，但那条路在 AssetsView 内部、只认卡内的选中 id，
// 槽位面板没法复用，故在父级单开一条（两边读的是同一个素材池，取数据方式一致）。
function doPreviewSharedSound(file: string, done?: () => void) {
  soundFlash.msg = ''
  soundFlash.err = false
  const r = services.readSharedSoundData?.(file)
  if (!r || !r.ok || !r.url) {
    soundFlash.msg = (r && r.error) || '没有可试听的音效'
    soundFlash.err = true
    if (done) done()
    return
  }
  playAudioUrl(r.url, soundFlash, done)
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
function onUsageModeChange(v: string) {
  // 从事件取值：子组件不改写 cfg（props），而 :value 单向绑定不会写回，
  // 早先这里读 cfg.usageMode 拿到的永远是旧值 —— 表现就是下拉选了没反应
  cfg.usageMode = v === 'token' ? 'token' : 'ledger'
  patchCfg({ usageMode: cfg.usageMode })
  refreshHistory()
  refreshTodayModels()
}
// 自定义单价改动：模型占比是拿新价现算的，立即重拉；挂件侧今日已用等下次余额刷新（有 TTL 缓存）
// p.index 有值 = 改的是「按模型覆盖」的第 index 行，否则是全局字段
function onTokenPriceChange(p: { key: string; value: any; index?: number }) {
  if (typeof p.index === 'number') {
    const row = cfg.tokenPrice.models[p.index]
    if (row) (row as any)[p.key] = p.value
  } else {
    (cfg.tokenPrice as any)[p.key] = p.value
  }
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
  // 删除本身已改完 cfg，这里只需落盘（不能再走 onTokenPriceChange：它会按 key 再写一次字段）
  patchCfg({ tokenPrice: plainTokenPrice() })
  refreshTodayModels()
}
// 账本历史保留天数改动：宿主按这个窗口裁剪与返回数据，改完要重新取一次。
// 区间收敛（超出新窗口的区间收回到可选范围）随 usageRange / usageRangeTabs 一起搬进 UsageView，
// 由子组件 watch(cfg.historyKeepDays) 自行处理，这里不再重复
function onHistoryKeepChange(v0: number) {
  const n = Number(v0)
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
  // 选中反馈：整理面板的批量动作反馈也写同一个 skinFlash（由「资源」页画廊与「外观」页渲染），
  // 这里补一句选中提示。只在选中（而非反选）时说一句 —— 取消是用户主动反悔，不必再确认一遍
  if (i < 0) {
    skinFlash.err = false
    skinFlash.msg = `已选中 ${skinPicked.value.length} 张：再到卡头「整理」里统一使用 / 排序 / 删除 / 参与随机`
  }
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
// 清完把形象/音色从「自定义」回退为内置，避免停在「自定义」却无素材可用。
//
// ⚠️ 形象这一条必须走 removeSkins（批量），不能 for 循环逐张 removeSkin：
// 后者每张都做一次 readRaw + writeRaw（整份画廊 JSON 序列化落盘），还会推两次挂件，
// 其中 getBuiltinData() 要把每张内置/共享角色读成 base64 data URL（单张 0.9~2.7MB）。
// 36 张共享角色就是 36 次全量写盘 + 72 次挂件推送，渲染进程主线程被压住 —— 这就是「清了半天」的来源。
// removeSkins 内部一趟读改写盘，且只在真删掉东西时推一次挂件（见 settings.js）。
// 气泡图 / 音效本就走「一次调用清一类」的口子，逐张 / 逐槽循环的开销在槽位数量级，不必改。
function doClearAssets() {
  skinFlash.msg = ''
  soundFlash.msg = ''
  bubbleFlash.msg = ''
  skinFlash.err = false
  soundFlash.err = false
  bubbleFlash.err = false
  try {
    let failed = ''
    // 画廊多张：一次批量删完（回传 failed 数，用于提示哪一类没清干净）
    const skinIds = skinGallery.value.items.map((it) => it.id)
    if (skinIds.length) {
      const r = services.removeSkins?.(skinIds)
      if (!r || !r.ok || r.failed) failed = '形象'
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
    refreshSkinPacks()
    skinPicked.value = []
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

// —— 共享音效库（45 个，与共享角色同一个包来源，但落 sounds 的 shared 槽位） ——
// shared 是「素材池」，不直接参与实播 —— 用户在下面从池子里「选用」到某个实播槽位才生效，
// 否则一装几十段、把原本选好的音效挤掉。
// 库清单由 AssetsView 自己 listSharedSounds 拉（点开卡片时才拉），父级不再持副本

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
    // 与 doClearAssets 同口径：形象走批量接口（逐张 removeSkin 是 N 次全量写盘 + N 次挂件推送）
    if (skinIds.length) {
      const r = services.removeSkins?.(skinIds)
      if (!r || !r.ok || r.failed) failed = '形象'
    }
    for (const role of roles) {
      const r = services.removeSound?.(role)
      if (!r || !r.ok) failed = failed || SOUND_ROLE_LABEL[role]
    }
    refreshSkin()
    refreshSounds()
    refreshSkinPacks()
    skinPicked.value = []
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
  // 旧存储里可能是 1.3/1.6 这类非整档倍率：吸附到最近档，保证滑块位置与数字框读数一致
  const s = snapScale(c.scale)
  cfg.scale = s
  cfg.scaleNum = scaleToNum(s)
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
  // 按压气泡整份回填（**不能漏**：BubbleView 的整卡数据都来自 cfg.bubble，漏了这步
  // 队列编辑器读到的 items 恒为 []，「加一步 / 删 / 上移」全是点不动的手感 —— 宿主其实已存成功）。
  // 宿主 normBubble 保证出口是稳定形态；这里只做类型兜底，不重新归一化（避免两套口径打架）
  cfg.bubble = c.bubble && typeof c.bubble === 'object'
    ? c.bubble
    : { v: 1, on: false, items: [], lib: [], tapAdvance: false, dwell: 5, dragLines: [], system: {} }
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
  // 提醒文案模板：宿主回的就是含换行的字符串，原样显示（缺字段/异常值按空处理）
  // 回填完成即等于「已保存状态」，在这里落基线，供「未保存」提示比对
  notifyViewRef.value?.syncAlertsBaseline()
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
// 挂件菜单「气泡设置」→ 宿主 showMainWindow + emitNavigate('bubble') → 这里切到「外观」Tab 并滚到
// 「按压气泡」卡。订阅放父级（与 onConfigChange 同处），不放进 BubbleView：
// 卡片是 v-if 渲染的（未激活 Tab 根本不挂载），订阅一旦跟着卡走就会「卡没渲染 = 收不到导航」。
// 切换 Tab 后卡片要等下一帧才进 DOM，scrollToCard 必须 nextTick 之后再调，否则 querySelector 落空
let unsubNavigate: (() => void) | undefined
function onBubbleNavigate(target: string) {
  if (target !== 'bubble') return
  activeTab.value = 'look'
  clearSearch()
  nextTick(() => scrollToCard('bubbleCustom'))
}
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
    // 挂件菜单「气泡设置」→ 切到「外观」Tab 的按压气泡卡（宿主 emitNavigate，见 onBubbleNavigate）
    unsubNavigate = services.onNavigate?.(onBubbleNavigate)
    const s = services.getSecrets?.()
    if (s) {
      secrets.apiKey = s.apiKey || ''
      secrets.platformToken = s.platformToken || ''
    }
    // SMTP 凭据不在这里读：NotifyView 归「用量」Tab、默认 Tab 是「外观」，此刻它的 ref 还是 null，
    // 父级调 loadMailSecrets() 是空转。改由 NotifyView 自己 onMounted 读（见该组件注释）
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
  try { unsubNavigate?.() } catch (err) {}
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
              :services="services"
              :builtin-skins="BUILTIN_SKINS"
              :legacy-builtin-skins="LEGACY_BUILTIN_SKINS"
              :skin-meta="skinMeta"
              :skin-gallery="skinGallery"
              :skin-unused="skinUnused"
              :skin-flash="skinFlash"
              :asset-size="assetSize"
              :sounds-meta="soundsMeta"
              :sound-label="soundLabel"
              :sound-unused="soundUnused"
              :scale-steps="SCALE_STEPS"
              @patch="patchCfg"
              @scale-num-live="onScaleNumLive"
              @scale-commit="onScaleCommit"
              @random-skin="doRandomSkin"
              @toggle-include-builtin="onToggleIncludeBuiltin"
              @ui-mode-change="onUiModeChange" />

    <!-- [外观] 按压气泡（自定义泡泡）：点小鲸鱼时按顺序弹的泡泡队列。
         挂在「挂件外观」之下、与它同属 look 组（挂件菜单的「气泡设置」按钮按 target='bubble' 直达本卡）。
         卡内是独立整块（队列 + 泡 + 行 + 模块四层），故单独成组件，不塞进 LookView -->
    <BubbleView v-if="cardOn('look', 'bubbleCustom')"
                :cfg="cfg"
                :widget-visible="widgetVisible"
                @patch="patchCfg" />

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
      :skin-flash="skinFlash"
      :thumb-broken="thumbBroken"
      :skin-hint-open="skinHintOpen"
      :sounds-meta="soundsMeta"
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
      @preview-shared-sound="doPreviewSharedSound"
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
    />

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

    <!-- [窗口] 挂件窗口：显隐、位置与窗口属性（使用说明 / 故障排查已挪到「帮助」组）。
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
/* 勾选行（.field.check）：标签独占剩余宽度，复选框固定靠右不被挤出卡片。
   这类标签的 <em> 补充说明最长（如 dsh 的三条），是横向溢出的主要来源 */

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

/* 有新版本时结果行可点，直接去插件市场更新 */
.msg.clickable {
  cursor: pointer;
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

/* SMTP 已配置时的一行摘要：替代整块表单，让「提醒与通知」卡回到「只有开关」的清爽态。
   与 .link-btn 的 inline 变体配合 —— 摘要里嵌一个「重新配置」链接 */
.link-btn.inline {
  margin-top: 0;
  font-size: 12px;
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
/* 需要用户动手的提示（如「dsh 正在运行」）：只用颜色提级，不换图标不换字号 ——
   这类提示是「建议」不是「错误」，做成红色警告框会与真失败（.msg.err）混淆 */
.hint-warn {
  color: var(--warn);
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
</style>
