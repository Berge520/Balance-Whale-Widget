<script lang="ts" setup>
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import type { AlertRole, BubbleMeta, CodexWindow, CodexWindows, DshMarketPlugin, MediaItem, SkinGallery, SkinMeta, SoundMeta, SoundRole, WhaleModel, WhaleModelRow, WhaleModelTemplate, WhalePriceModel, WhaleServices, WhaleTokenPrice } from './types/services'
import SkinCropper from './components/SkinCropper.vue'
import SoundTrimmer from './components/SoundTrimmer.vue'
import FirstRunGuide from './components/FirstRunGuide.vue'
import BootIntro from './components/BootIntro.vue'
import UsageChart from './components/UsageChart.vue'
import DisplayManager from './components/DisplayManager.vue'
import { msgCls, useFlash, useFlashShow, type Flash } from './composables/useFlash'
import { useFold, setFoldPrefs } from './composables/useFold'
import { useDebugSelfCheck } from './composables/useDebugSelfCheck'
import { assetSize, fetchAsDataUrl, pad2, sharedSkinThumb } from './utils/format'
// 自定义显示：Tab/卡片/依赖关系常量（供 DisplayManager.vue 等组件共享）
import { TABS, SEARCH_INDEX, CORE_TABS, CORE_CARDS, sortByOrder, isCardHidden as cardHiddenByCfg, pinnedInTab as pinnedInTabOf, CARD_FOLDS, cardRootKey, type TabKey } from './constants/display'
// uTools 功能指令名的唯一副本（构建期与 plugin.json 的 cmds 交叉校验）
import { CMD_TOGGLE } from './constants/commands'
// 卡片「全文」索引：scripts/gen-search-index.mjs 在构建期从模板提取每张卡的可见文本
// （h2 卡头 + label 字段名），搜索第三档兜底用。模板改了没重新生成会被 prebuild 拦下
import { CARD_TEXT } from './search-index.gen'
// GitHub 加速卡（含 hosts 探测 / 源表 / IP 表编辑，逻辑量在本页里数一数二）改按需异步加载：
// 它只在「帮助」Tab 才渲染，抽成独立 chunk 后 App.vue 首屏包明显变小，其余 Tab 的打开更快。
// 渲染时机不变（下面模板仍是 v-if="activeTab === 'help'"），首次切到帮助时才去取这段 JS
const AccelView = defineAsyncComponent(() => import('./views/AccelView.vue'))
// 「资源」Tab 整组（4 张卡）。含 4 张可独立命中的卡，故把 cardOn 作为 prop 传入、
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
// 「提醒与通知」整卡。提醒开关与阈值 / 通知渠道 / SMTP 配置 / 提醒音音量 / 提醒文案
// 都内聚在组件内（计时配置已迁到 TimerView）；applyConfig 回填后要落「未保存」基线、备份恢复后
// 要刷新展示，这两处父级驱动，故组件用 defineExpose 暴露 syncAlertsBaseline，父级用模板 ref 调用。
// SMTP 凭据由 NotifyView 内的子块 components/MailSettings.vue 自己 onMounted 读回
// （父级 onMounted 时它的 ref 还没建立，会空转），父级不再调。保存 / 恢复默认提醒文案需父级整份
// applyConfig，故 emit('save-alerts')。
import NotifyView from './views/NotifyView.vue'
// 「计时」整卡：计时功能的全部配置（默认时长 / 快捷档位 / 到点提醒 / 休息与番茄 / 气泡与状态）。
// 原先寄居在「提醒与通知」卡的折叠分区里，搜索到也不容易看见；拆成独立卡后挂件菜单的
// 「计时设置」深链（target='timer'）可直达。落盘走 emit('patch')，跨卡跳转走 emit('go-card')。
import TimerView from './views/TimerView.vue'
// 「调试工具」卡：默认关、仅回归用。不注册成卡片（不进「管理显示内容」与搜索结果），
// 只在本 Tab 非搜索态渲染；三条只读自检各带一个按钮、结论写在行内。
import DevView from './views/DevView.vue'
// 「模型与余额」整卡。行内表单 / 展开态 / 删除确认 / 测试 / 刷新 / 增删改都内聚在组件内；
// 跨卡共享的运行时快照（models）、配置清单（modelConfigs）、主显示 id（modelsMainId）、
// 模板与上限、以及 fmtTokens / codexWinText 仍留父级，故按 props 下传；保存 / 删除 / 刷新后
// 需要父级 reloadModels 重新取快照，故 emit('reload')；主显示切换经 update:mainId 上抛。
// 按需异步加载：expose 的 closeModelForm 仅组件内部使用，父级无 ref 调用点，异步安全。
const ModelsView = defineAsyncComponent(() => import('./views/ModelsView.vue'))
// 「待办与计时」整卡：待办清单 + 计时默认值；v1.16 起去掉了专注统计 / 记录 / 每日目标。
// 待办归宿主（preload 的 settings.js），本卡只读写快照、订阅宿主推送；
// 输入法组字守卫与其它卡共用父级的 isImeComposing，故按 props 下传。
import FocusView from './views/FocusView.vue'
// 「下班倒计时」整卡：上下班时间 / 工作日 / 显示秒 / 可选附加信息（周末、发薪日、今日已赚）。
// 开关关闭时挂件完全走原路径（余额 / 专注 / 计时不受影响），本卡只负责写 cfg 并交给宿主归一。
import OffworkView from './views/OffworkView.vue'
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

// 番茄循环：长休时长（分钟），是宿主 constants.js TIMER_LONG_BREAK_DEFAULT 的同值副本
const TIMER_LONG_BREAK_DEFAULT = 15
// 番茄循环：每 N 轮进入长休，是宿主 constants.js TIMER_LONG_EVERY_DEFAULT 的同值副本
const TIMER_LONG_EVERY_DEFAULT = 4
// 挂件计时组快捷时长四档（分钟）的默认值，是宿主 constants.js TIMER_PRESETS_DEFAULT 的同值副本
const TIMER_PRESETS_DEFAULT = [15, 25, 45, 60]

// 下班倒计时配置归一：与宿主 offwork.js 的 normHm / normDays 同口径（时 0–23、分 0–59、
// 工作日 0–6 去重升序、空数组回默认周一至周五）。设置页拿不到 preload 模块，只能留一份同值副本
function normOffworkHm(v: any, dft: string) {
  const s = typeof v === 'string' ? v.trim() : ''
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s)
  if (!m) return dft
  return (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2]
}
function normOffworkDays(v: any, dft: number[]) {
  if (!Array.isArray(v)) return dft.slice()
  const out = Array.from(new Set(v.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))).sort((a, b) => a - b)
  return out.length ? out : dft.slice()
}
function normOffworkPayday(v: any) {
  return Number.isInteger(v) && v >= 1 && v <= 31 ? v : 10
}
// 时薪（元/小时）：与宿主 offwork.js 的 normWage 同口径 —— 正数、最多两位小数、≤ 100000；
// 其余（含 0 / 空）一律按「未配置」0 回填，挂件据此隐藏「今日已赚」
const OFFWORK_WAGE_MAX = 100000
function normOffworkWage(v: any) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > OFFWORK_WAGE_MAX) return 0
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return 0
  return Math.round(n * 100) / 100
}
const OFFWORK_DEFAULTS = {
  start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5],
  showSec: true, weekendOn: false, paydayOn: false, paydayDay: 10, hourlyWage: 0,
}

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

// 可下载的随包内置形象清单不再在设置页留副本：合并后的「形象」卡整组由宿主
// listSkinPacks() 的运行时清单渲染（id / name / size / installed 都从那来），
// 原先这份 `SKIN_PACK_SKINS` 字面量副本已无消费方，故删除；
// check-shared 里对应的那条比对也一并去掉（比对的正是「两侧同值」，一侧没了即无意义）。
// 宿主 constants.js 的 SKIN_PACK_SKINS 仍是唯一真源（决定下载落盘时的 id 校验）。

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

// 内置音色两组（按压 / 释放）的文件路径：与挂件页 floating-page.js 的 `SOUND_FILES` 同值
// （实际播放用那份），由 scripts/check-shared.mjs 抠出 ./whale/*.mp3 排序比对。
// 「挂件外观 → 音色」选 duck / fx1 时试听用的就是这里。改一处忘另一处会让试听与实际播的不是同一个文件。
const BUILTIN_SOUND_FILES: Array<{ key: string; label: string; press: string; release: string }> = [
  { key: 'duck', label: '小黄鸭', press: './whale/Ya1.mp3', release: './whale/Ya2.mp3' },
  { key: 'fx1', label: '音效 1', press: './whale/D1.mp3', release: './whale/D2.mp3' },
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
// 走 useFold：卡片级折叠要能被「管理显示内容」的默认展开/收起与记忆开关管到
const credentialsFold = useFold('credentials', false)
// 合并卡「待办与计时」的整卡折叠：主卡默认展开，收起态摘要提示两段内容
const focusTimerFold = useFold('focusTimer', true)
// —— 设置页顶部 Tab ——
// 原先 12 张卡片竖排一屏到底（模板近千行），找一项要滚很久；按主题分 7 组，一次只看一组。
// 每张卡片用 v-if="activeTab === 'xxx'" 归到组里（不额外套容器层）。组内顺序 = 卡片在模板里的先后；
// 但不同组的卡片是交错排布的（如「数据」的凭据卡在模板最前、「帮助」的关于卡在最后），
// 所以看模板不要以为同一组的卡挨在一起 —— 渲染顺序由下面 TABS 的 key 决定，与源码位置无关。
// desc 是分组说明：凭据、备份这类「不常用但找不到会着急」的项靠它暴露位置；
// 它得与卡片实际**顺序和数量**对得上（按错顺序写、漏掉某张卡，用户按描述找就会找不到）。
// 记住上次停留的分组：重开设置页 / 重启插件后回到原位置。
// 只放 localStorage、不进配置与备份 —— 这是纯 UI 偏好，写坏了最多回默认组，不值得进 dbStorage。
// 值为空 / 非法 / 存储被禁时一律回 'look'（冷启动仍从外观开始）。
const LAST_TAB_KEY = 'whale:lastTab'
function readLastTab(): TabKey | '' {
  try {
    const v = localStorage.getItem(LAST_TAB_KEY)
    return TABS.some((t) => t.key === v) ? (v as TabKey) : ''
  } catch (err) { return '' }
}
const activeTab = ref<TabKey>(readLastTab() || 'look')
// 写入失败（存储被禁 / 隐私模式）不影响使用，静默回默认即可
watch(activeTab, (v) => { try { localStorage.setItem(LAST_TAB_KEY, v) } catch (err) {} })
const activeTabDesc = computed(() => TABS.find((t) => t.key === activeTab.value)?.desc || '')
// 自定义显示：过滤掉用户隐藏的 Tab，并按用户自定义顺序排列（空顺序 = TABS 默认顺序）。
// devOnly 的 Tab 始终显示，因为它的显隐由其他逻辑控制
const visibleTabs = computed(() =>
  sortByOrder(TABS.filter((t) => !cfg.hiddenTabs.includes(t.key)), cfg.tabOrder, (t) => t.key),
)

// —— 卡片搜索（跨 Tab 找卡片）——
// 痛点：卡片按主题分了 7 组、共 20 余张，还大量用 .fold 折叠；找一项要「先猜在哪组、再翻折叠」。
// 这里只做「卡片级」检索：命中哪张卡就跨 Tab 把这张卡单独渲染出来，不定位卡内控件（控件太多无稳定文本）。
// 索引来源是**卡片可见文本**：每张卡在模板上挂 data-search（标题 + 同义词 + 栏目名），
// 搜的是这份索引而不是实时 DOM —— 因为卡片是 v-if 渲染的，未激活的 Tab 根本没进 DOM，抓不到文本；
// 且折叠区默认收起、DOM 里也读不到里面的字。索引与模板同处一文件，改卡片时顺手改这行，不会漂移。
const searchQuery = ref('')
// Ctrl+K 聚焦搜索用；没有它只能在页面里先找到输入框再点
const searchInputEl = ref<HTMLInputElement | null>(null)
const searchActive = computed(() => searchQuery.value.trim().length > 0)
// 归一化：去空白、英文小写，让「API Key」「api key」「apikey」等价
function normSearch(s: string) {
  return s.toLowerCase().replace(/\s+/g, '')
}
// 卡片索引：key 与模板上的 data-search 一一对应。额外收一批「同义词 / 别称 / 英文名」——
// 用户不一定记得界面上的措辞（如搜「穿透」得能命中「挂件窗口」，搜「token」得能命中「DeepSeek 凭据」）。
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
// 自定义显示：被用户隐藏的卡片不渲染（核心卡片 credentials/window/look 不可隐藏，见 constants/display.ts）
function cardOn(tab: string, key: string) {
  // 隐藏的卡片始终不渲染（无论搜索态还是正常态）
  if (cfg.hiddenCards.includes(key)) return false
  // Tab 被隐藏时，它下面的卡片一并隐藏（搜索命中仍会列出，但会标「已隐藏」并可一键取消）
  if (cfg.hiddenTabs.includes(tab)) return false
  if (searchActive.value) return searchHits.value.includes(key)
  return activeTab.value === tab
}
// —— 卡片置顶 ——
// 痛点：一张 Tab 里可能压着 6 张卡，最常用的那张往往不在最前（如「用量」组的提醒 / 模型）。
// 置顶**不改模板结构、也不搬 DOM**：只给卡根写 CSS `order`，`.pin-scope` 是 flex 列容器，
// 负 order 的卡自然排到组首。跨组卡片永远串不到一起，分组语义不变；
// 代价是没法把 A 组的卡排进 B 组 —— 那本来也不是需求。
//
// ⚠️ 为什么不能用 insertBefore 搬卡（真机事故，2026-11-02）：早先的实现把卡根搬到组首，
// dev 下看着正常，生产构建里却会「切哪一组都只看到挂件外观和设置页视觉」，回来后旧卡还在、
// 甚至重复一份。原因是 Vue 的 v-if 分支靠注释锚点定位（runtime-core 的 getNextHostNode 取
// `vnode.anchor || vnode.el` 的 nextSibling），把正在渲染的组件根节点/多根组件的片段子节点
// 搬离锚点后，卸载和重挂都会算错位置。结论：**凡是 Vue 管理的节点，只许改样式，不许换位置**。
const pinnedCards = computed((): string[] => cfg.pinnedCards || [])
// 置顶作用域：syncPinned 只在这里面查卡根、写 order
const pinScopeEl = ref<HTMLElement | null>(null)
// 按卡根判：合并卡配置里可能存的是 focus 也可能历史存成 timer（同一张卡），
// 否则「置顶计时」不会给整卡挂上 .card-pinned
function isPinned(key: string) {
  const root = cardRootKey(key)
  return pinnedCards.value.some((k) => cardRootKey(k) === root)
}
// 当前 Tab 里的置顶卡（保持用户定的顺序），供置顶区标题用；搜索态不显示标题（卡片是跨组混排的）。
// 判定收在 display.ts，与 DisplayManager 的置顶计数共用一份 —— 否则两处「哪张算置顶」迟早说岔
const pinnedInTab = computed(() =>
  pinnedInTabOf(pinnedCards.value, activeTab.value, cfg.hiddenTabs, cfg.hiddenCards),
)
// 供模板 .card :class 用：置顶卡挂 .card-pinned（左侧竖条标记）。位置由 order 排，
// class 只负责「长什么样」，不负责「排在哪」。
function cardCls(key: string) {
  return { 'card-pinned': isPinned(key) }
}
// 已写过 order 的元素。每轮先清空：常驻组件（如「资源」组的外包容器）不会随 Tab 卸载，
// 不清就会把上一组的负序号带到新一组去。
const pinOrderEls = new Set<HTMLElement>()
function clearPinOrder() {
  for (const el of pinOrderEls) el.style.removeProperty('order')
  pinOrderEls.clear()
}
// 置顶卡的 order 基数：取负值排到 0 的普通卡之前，又要远大于行内说明的固定负值
// （三段先后见下方 .pin-scope 的样式注释）。多张置顶按点击先后递增。
const PIN_ORDER_BASE = -1000
// 普通卡自定义顺序的起点：正值，排在 order 0 的分区标题 / 分隔线之后。
// 步长 10 只为可读（插入时留空档），当前不依赖空档做插值
const CARD_ORDER_BASE = 10
const CARD_ORDER_STEP = 10
function setPinOrder(el: HTMLElement, order: number) {
  el.style.setProperty('order', String(order))
  pinOrderEls.add(el)
}
// 祖先容器（如「资源」组的 .assets-scope）取子卡里最小的 order：
// order 只在同一个 flex 容器内比较，容器本身不提前，里面的卡写再小的值也只在容器内部生效
function bumpAncestors(root: HTMLElement, order: number, scope: HTMLElement) {
  let parent = root.parentElement
  while (parent && parent !== scope) {
    const cur = parent.style.getPropertyValue('order')
    if (!cur || Number(cur) > order) setPinOrder(parent, order)
    parent = parent.parentElement
  }
}
// 给当前 Tab 的卡根写 order。两级：
//  1. 置顶卡写负 order（按 pinnedCards 先后），未置顶的卡不再被动
//  2. 用户拖过顺序的 Tab，普通卡按 cfg.cardOrder 写正 order；没拖过的 Tab 保持 DOM（模板）顺序
// 取消置顶 / 恢复默认时把 order 清掉，卡自然回到原位，不需要另记一份模板序。
// 合并卡（计时 + 专注）一个卡根挂两个 data-search：按**卡根**算、把根上所有 key 都纳入判断，
// 否则「置顶计时」会被当成没有对应卡根，或者把子块从卡里搬出去。
function syncPinned() {
  const scope = pinScopeEl.value
  if (!scope) return
  // 搜索态卡片跨组混排，保持命中顺序，置顶 / 自定义顺序都不参与 —— 先清掉上一轮写的 order
  clearPinOrder()
  if (searchActive.value) return
  // 卡根 → 它挂的全部 data-search key（Map 的插入序即 DOM 顺序，下面补尾要用）
  const keysOfRoot = new Map<HTMLElement, string[]>()
  const seenRoots = new Set<HTMLElement>()
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[data-search]'))) {
    const key = el.dataset.search || ''
    if (SEARCH_INDEX[key]?.tab !== activeTab.value) continue
    const root = (el.closest('.card') as HTMLElement) || el
    if (seenRoots.has(root)) {
      const keys = keysOfRoot.get(root)
      if (keys && !keys.includes(key)) keys.push(key)
      continue
    }
    seenRoots.add(root)
    keysOfRoot.set(root, [key])
  }
  if (!keysOfRoot.size) return
  // 1) 置顶卡
  const list = pinnedInTab.value
  const pinnedRoots = new Set<HTMLElement>()
  for (const [root, keys] of keysOfRoot) {
    // 合并卡的两个子块都算：取 list 里更靠前的那个下标，点「计时」也整卡提前
    let idx = -1
    for (const k of keys) {
      // pinnedInTab 返回的是卡根代表键，按 root 匹配才对得上（合并卡的 timer 行也走这里）
      const i = list.indexOf(cardRootKey(k))
      if (i >= 0 && (idx < 0 || i < idx)) idx = i
    }
    if (idx < 0) continue
    pinnedRoots.add(root)
    const o = PIN_ORDER_BASE + idx
    setPinOrder(root, o)
    bumpAncestors(root, o, scope)
  }
  // 2) 普通卡的自定义顺序
  const order = (cfg.cardOrder && cfg.cardOrder[activeTab.value]) || []
  if (!order.length) return
  // 卡根代表键 → 名次（同一卡根只认第一次出现的名次）
  const rankOf = new Map<string, number>()
  order.forEach((k, i) => {
    const rk = cardRootKey(k)
    if (!rankOf.has(rk)) rankOf.set(rk, i)
  })
  // 没进 order 的卡按 DOM 原序补在最后（与 Tab 的 sortByOrder 同一套补尾规则）
  const ranked = Array.from(keysOfRoot.keys())
    .filter((root) => !pinnedRoots.has(root))
    .map((root, domIdx) => {
      let rank = Infinity
      for (const k of keysOfRoot.get(root) || []) {
        const r = rankOf.get(cardRootKey(k))
        if (r !== undefined && r < rank) rank = r
      }
      return { root, domIdx, rank }
    })
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1
    return a.domIdx - b.domIdx
  })
  ranked.forEach((it, i) => {
    const o = CARD_ORDER_BASE + i * CARD_ORDER_STEP
    setPinOrder(it.root, o)
    bumpAncestors(it.root, o, scope)
  })
}
// 依赖变化后重排：等 DOM 更新完（nextTick）再写 order，否则此时拿到的还是上一轮的节点。
// 切 Tab / 搜索 / 改显隐 / 改置顶都会触发（pinnedInTab 已把这些状态都算进去了）。
// ⚠️ 不带 immediate：本 watch 的 getter 读 cfg，而 cfg 在下方才声明 —— immediate 会立刻求值并撞 TDZ
// （与 applyUtoolsDark 同一条教训）。首屏那次由 cfg 声明之后调用 watchPinned() 时的挂载 watch 负责：
// 配置从宿主回填会改 cfg.pinnedCards，那一次同样走本 watch。
function watchPinned() {
  watch(
    () => [
      activeTab.value,
      searchQuery.value,
      cfg.pinnedCards.join(','),
      cfg.hiddenCards.join(','),
      cfg.hiddenTabs.join(','),
      // 卡片自定义顺序：对象引用每次 applyConfig 都会换，序列化后比较才不会白重排
      JSON.stringify(cfg.cardOrder || {}),
    ],
    () => { nextTick(syncPinned) },
  )
}
// 置顶 / 取消置顶（由 DisplayManager 调用）。顺序即显示顺序：新的置顶卡排在已有置顶卡之后，
// 用户连点几张时得到的是「点击顺序」，不用再自己排。
function togglePin(key: string, pinned: boolean) {
  if (!SEARCH_INDEX[key]) return
  // 按卡根去重 / 取消：合并卡的 focus 与 timer 是同一张卡，历史配置里可能两键都在，
  // 否则点「计时」置顶会在 pinnedCards 里塞第二个键，取消时又只删掉一个
  const root = cardRootKey(key)
  const cur = cfg.pinnedCards || []
  const has = cur.some((k) => cardRootKey(k) === root)
  if (pinned) {
    if (has) return
    saveHidden({ pinnedCards: [...cur, key] })
  } else {
    if (!has) return
    saveHidden({ pinnedCards: cur.filter((k) => cardRootKey(k) !== root) })
  }
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

// —— Tab 交互：回顶 / 快捷键 ——
// 切 Tab 回到页面顶部：否则从长分组（用量 / 开发者）切到短分组时，页面可能停在空白处，
// 用户以为切坏了。深链定位卡片（onBubbleNavigate / goAssetsTab）不走这里，它们自己滚到目标卡。
function scrollPageTop() {
  try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }) } catch (err) {}
}
// 点击 / 快捷键的统一入口：清搜索 → 切组 → 回顶。点当前组也回顶（顺手当「回到顶部」用）。
function onTabClick(key: TabKey) {
  clearSearch()
  activeTab.value = key
  scrollPageTop()
}
// Alt+←/→ 切相邻分组；首尾不循环（按一下跳到另一头容易误操作）
function switchAdjacentTab(delta: number) {
  const list = visibleTabs.value
  const i = list.findIndex((t) => t.key === activeTab.value)
  const j = Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))
  const t = list[j]
  if (t && t.key !== activeTab.value) onTabClick(t.key)
}
// Ctrl+1..7 直达「当前可见」的第 N 组（隐藏组自动跳过，顺序 = 用户自定义顺序）
function switchTabByIndex(n: number) {
  const t = visibleTabs.value[n - 1]
  if (t) onTabClick(t.key)
}
// Ctrl+K：聚焦搜索并全选已有词，直接重打
function focusSearch() {
  nextTick(() => {
    searchInputEl.value?.focus()
    searchInputEl.value?.select()
  })
}
// 弹层打开时快捷键一律让位 —— 否则会在弹窗背后悄悄切组 / 抢焦点
function anyModalOpen() {
  return !!document.querySelector('.whale-overlay, .display-manager-overlay, .boot-intro, .media-preview-box')
}
// 设置页快捷键：Ctrl+1..7 切组 / Ctrl+K 搜索 / Alt+←→ 相邻切组。
// Alt+方向键在输入框 / 下拉里是原生「按词跳转 / 换选项」，命中这些控件时一律不拦截。
function onSettingsKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || anyModalOpen()) return
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); focusSearch(); return }
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); switchTabByIndex(Number(e.key)) }
    return
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    e.preventDefault()
    switchAdjacentTab(e.key === 'ArrowRight' ? 1 : -1)
  }
}

// —— 配置保存回执 ——
// 保存失败必须「当场、看得见」地告诉用户。宿主 store.patchConfig 在写盘失败时会抛
// （见 store.js 里那句「写失败必须让调用方知道」），但设置页此前所有 patchCfg 调用都直接
// 丢掉返回值 / 不接异常 —— 存储写满时用户照样看到开关翻转、重启后又变回去，只能当成「功能坏了」。
//
// 为什么做成「整条常驻 + 可点重试」而不是 3 秒就消失的一行字：
//   · 存储写满/被拒绝是**持续**状态，不会自愈；提示闪一下就没了等于没提示
//   · 用户此刻做的改动是**已知没落盘**的，得给一个一键再试的入口（重试的仍是最后这次改动，
//     不重放历史，否则「先改 A 失败、再改 B 成功」会莫名其妙把 A 又写一遍）
//   · 文案要说清「没保存上」而不是笼统的「操作失败」—— 用户要判断的是「我刚才那下算不算数」
const saveFail = reactive({ msg: '', patch: null as Record<string, any> | null, retrying: false })
// —— 自定义显示管理 ——
// DisplayManager 弹窗的显隐
const showDisplayManager = ref(false)
// 显示管理的回执（3 秒自动消失）：这类动作的提示很短（「已隐藏 XX 分组，已切到 YY」），
// 不需要长期停留；与上面的常驻失败条是两回事，别合并 —— 后者必须一直挂着直到处理好
const { flash: displayFlash, show: showDisplayMsg } = useFlashShow(3000)
// 判断卡片是否被隐藏（卡片自身被隐藏，或它所属的 Tab 被隐藏 —— 对用户都是「看不见」）。
// 判定实现收在 display.ts（App.vue / DisplayManager 共用一份），这里只做参数绑定
function isCardHidden(key: string): boolean {
  return cardHiddenByCfg(cfg.hiddenTabs, cfg.hiddenCards, key)
}
// 写隐藏列表并回执失败（不返回值给组件，组件按动作 emit，界面由配置回推驱动）
function saveHidden(patch: Record<string, any>) {
  // 异常已在 patchCfg 内统一处理（重试 + 常驻失败条 + 回滚界面），这里只补一条就地回执：
  // 用户是在「显示管理」弹层里勾选的，弹层盖住了页头那条失败条 —— 不在这里说一声，
  // 他会以为勾选成功了（界面回滚后勾选框会变回去，但容易被当成「点了没反应」）
  if (!patchCfg(patch)) showDisplayMsg('保存失败：这次勾选没存上，重开设置会恢复原样', true)
}
// 切换卡片显隐（由 DisplayManager 组件调用）
function toggleCardVisibility(key: string, hidden: boolean) {
  const current = new Set(cfg.hiddenCards)
  if (hidden) current.add(key)
  else current.delete(key)
  saveHidden({ hiddenCards: [...current] })
}
// 切换 Tab 显隐（由 DisplayManager 组件调用）。隐藏当前 Tab 时由 watch(visibleTabs) 统一切走
function toggleTabVisibility(tabKey: TabKey, hidden: boolean) {
  const current = new Set(cfg.hiddenTabs)
  if (hidden) current.add(tabKey)
  else current.delete(tabKey)
  saveHidden({ hiddenTabs: [...current] })
}
// 恢复默认：显示全放出来 + Tab / 卡片顺序复位 + 置顶清空 + 折叠默认值与记忆开关复位
//（「恢复默认」对用户就是「回到刚装好时的样子」，只清隐藏、留着自定义顺序等于只恢复了一半；
//  折叠默认值同属「显示内容」的自定义，留着不清同样只恢复一半）
function resetDisplayToDefault() {
  saveHidden({
    hiddenTabs: [], hiddenCards: [], tabOrder: [], pinnedCards: [],
    cardOrder: {}, foldDefaults: {}, foldRemember: true,
  })
}
// Tab 上移 / 下移（由 DisplayManager 调用）。基于**完整顺序**（含已隐藏的 Tab）交换 ——
// 隐藏某个 Tab 不该把它在顺序里的位置丢掉；换完把整份顺序落配置，空数组 = 默认顺序。
function moveTab(key: string, delta: number) {
  const order: string[] = sortByOrder(TABS, cfg.tabOrder, (t) => t.key).map((t) => t.key)
  const i = order.indexOf(key)
  const j = i + delta
  if (i < 0 || j < 0 || j >= order.length) return
  order[i] = order[j]
  order[j] = key
  saveHidden({ tabOrder: order })
}
// 搜索结果里点「已隐藏」的卡片 = 一键取消隐藏：卡片和它所属 Tab 一起放出来，
// 否则只放卡片、Tab 还藏着，卡片仍然渲染不出来（README 里承诺的「一键取消」）
function unhideCard(key: string) {
  const patch: Record<string, any> = {}
  if (cfg.hiddenCards.includes(key)) patch.hiddenCards = cfg.hiddenCards.filter((k) => k !== key)
  const tab = SEARCH_INDEX[key]?.tab
  if (tab && cfg.hiddenTabs.includes(tab)) patch.hiddenTabs = cfg.hiddenTabs.filter((k) => k !== tab)
  if (Object.keys(patch).length) saveHidden(patch)
}
// DisplayManager 的变更统一入口：组件只按动作 emit('update', { type, key?, hidden?, delta? })，
// 状态与落盘全在本层（组件不直接改 cfg，避免 props 被改写的反模式）
type DisplayAction = {
  type: 'tab' | 'card' | 'cards' | 'reset' | 'showAll' | 'tabMove' | 'pin' | 'cardOrder' | 'pinOrder' | 'foldDefault' | 'foldRemember'
  key?: string
  hidden?: boolean
  delta?: number
  pinned?: boolean
  // type='foldDefault' / 'foldRemember' 时：true = 展开 / 开启记忆
  open?: boolean
  list?: string[]
}
// 某个 Tab 的模板默认卡片顺序（SEARCH_INDEX 组内声明序 == 模板卡片先后，由 test/display.test.mjs 钉死）。
// 合并卡（focus/timer）按代表键去重 —— 它们共用一个卡根，顺序表里只该出现一次
function defaultCardOrderOf(tab: string): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(SEARCH_INDEX)) {
    if (v.tab !== tab) continue
    const root = cardRootKey(k)
    if (!out.includes(root)) out.push(root)
  }
  return out
}
// 卡片顺序落配置：与模板默认顺序一致时删掉该 Tab 的键（避免存一份「等于默认」的冗余顺序，
// 后续模板加卡时也不会被这份旧顺序顶到末尾）。
// 置顶卡也要留在顺序表里：这份表记的是「用户拖出来的名次」，取消置顶时靠它回到原位置。
// 若把置顶根剔掉，用户随后拖别的卡会把它的名次从配置里抹掉，取消置顶就只能补到组尾
//（显示上置顶卡仍排组首，那是 syncPinned 另外写的负 order，与这份表无关）
function applyCardOrder(tab: string, list: string[]) {
  const valid: string[] = []
  for (const k of list) {
    if (typeof k !== 'string' || SEARCH_INDEX[k]?.tab !== tab) continue
    const root = cardRootKey(k)
    if (!valid.includes(root)) valid.push(root)
  }
  const next = { ...cfg.cardOrder }
  const def = defaultCardOrderOf(tab)
  if (valid.length && (valid.length !== def.length || valid.some((k, i) => k !== def[i]))) next[tab] = valid
  else delete next[tab]
  saveHidden({ cardOrder: next })
}
function onDisplayManagerUpdate(act: DisplayAction) {
  if (!act) return
  if (act.type === 'reset') { resetDisplayToDefault(); return }
  // 全部显示：只清隐藏，不动自定义顺序（用户只是想把藏起来的都放出来，没说顺序也重来）
  if (act.type === 'showAll') { saveHidden({ hiddenTabs: [], hiddenCards: [] }); return }
  // 整组放出：组件已算好完整隐藏清单，这里原样落地（只做核心卡白名单过滤）
  if (act.type === 'cards') {
    saveHidden({ hiddenCards: (act.list || []).filter((k) => typeof k === 'string' && !CORE_CARDS.includes(k)) })
    return
  }
  if (act.type === 'tabMove' && act.key) { moveTab(act.key, act.delta === 1 ? 1 : -1); return }
  if (act.type === 'pin' && act.key) { togglePin(act.key, act.pinned === true); return }
  // 普通区拖拽后的整份顺序（key = TabKey）
  if (act.type === 'cardOrder' && act.key) { applyCardOrder(act.key, act.list || []); return }
  // 置顶区内部拖拽后的整份置顶顺序（组件已按当前可见性算好）
  if (act.type === 'pinOrder') {
    saveHidden({ pinnedCards: (act.list || []).filter((k) => typeof k === 'string' && !!SEARCH_INDEX[k]) })
    return
  }
  // 单张卡的默认展开态（key = 折叠键，见 CARD_FOLDS）
  if (act.type === 'foldDefault' && act.key) {
    saveHidden({ foldDefaults: { ...cfg.foldDefaults, [act.key]: act.open === true } })
    return
  }
  if (act.type === 'foldRemember') { saveHidden({ foldRemember: act.open === true }); return }
  if (act.type === 'tab' && act.key) { toggleTabVisibility(act.key as TabKey, act.hidden === true); return }
  if (act.type === 'card' && act.key) toggleCardVisibility(act.key, act.hidden === true)
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
// 故用 scroll-margin-top 预留出它的高度。高度不写死：窄窗口下 Tab 行会换行、搜索框也可有可无
//（非搜索态没有），写死一个数就会露头或留一大截空白 ——
// 由下面的 ResizeObserver 实测后写进 --tab-bar-h，.card 的 scroll-margin-top 读它。
// 注意 desc 不在吸顶区内（它在 .pin-scope 里，随内容滚走），所以不该算进这个高度。
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

// 从外观页跳到资源页的背景与片头卡
function goAssetsTab() {
  activeTab.value = 'assets'
  nextTick(() => scrollToCard('assetsMedia'))
}
// 平台判定：仅用于 dev Tab 里那几处 Windows 专属文案（Hyper-V 端口段 / UAC 提权）。
// 宿主 preload 不往页面透传平台，uTools 在渲染进程直接可用（本文件已有 utools.dbStorage 用法）。
// 取不到时按非 Windows 处理：这些文案只在 Windows 才成立，宁可不显示也不误导。
const IS_WIN = (() => { try { return utools.isWindows() } catch (err) { return false } })()

// 深浅色判定：生效值 = uiMode 合成（auto 取 uTools 实际值，手动 light/dark 直接用偏好；
// fantasy「未至之境」恒为暗色，另挂 fantasy 类供主题令牌覆写）。
// uTools 实际值来自 utools.isDarkColors()，不跟系统 —— main.css 的 html.dark 系列规则是消费端。
// uTools 没有主题变更事件/API，只能轮询；isDarkColors 是同步布尔读，开销可忽略。
// 轮询间隔取 1s：auto 模式下 uTools 主题切换后最迟 1s 跟上，体感即时。
function applyUtoolsDark() {
  let utoolsDark = false
  try { utoolsDark = !!utools.isDarkColors() } catch (err) { /* 非 uTools 环境按浅色 */ }
  const fantasy = cfg.uiMode === 'fantasy'
  const dark = fantasy || (cfg.uiMode === 'auto' ? utoolsDark : cfg.uiMode === 'dark')
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('fantasy', fantasy)
}
// 背景氛围：deep / aurora 是纯 CSS，video 是内置视频，custom 是用户导入的图片/视频；
// 都只加类，实际显示条件与配色在 main.css 的 html.dark.bg-* / html:not(.dark).bg-* 里。
function applyBg() {
  const modes = ['deep', 'aurora', 'stars', 'mist', 'polar', 'warm', 'video', 'custom']
  const mode = modes.includes(cfg.bgMode) ? cfg.bgMode : 'off'
  for (const m of modes) document.documentElement.classList.toggle('bg-' + m, mode === m)
}

// —— 内置视频壁纸：只在设置页渲染，深色 / 浅色 / 未至之境都可用 ——
// 素材不随包，宿主按需下载到 userData/whale-bg；这里把 data URL 转 blob 后交给 <video>。
// 用 blob 而不是直接塞 data URL：视频循环播放时 blob 可被浏览器按媒体流处理，
// 不必把 1.8MB base64 字符串一直留在 DOM 属性里。
const bgVideoEl = ref<HTMLVideoElement | null>(null)
const bgVideoUrl = ref('')
const bgReduceMotion = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null
const bgVideoPaused = ref(true)
const bgVideoReduced = ref(bgReduceMotion ? bgReduceMotion.matches === true : false)
const bgVideoError = ref('')
let bgVideoLoading = false
let bgVideoSeq = 0
// 选中视频背景即视为用户明确要动态；减少动态效果只影响启动片头
let bgVideoWantPlay = false
// 自定义背景（media 库）：图片 / 视频；与内置视频共用遮罩/模糊/亮度与播放兜底
const bgCustomEl = ref<HTMLVideoElement | null>(null)
const bgCustomImgEl = ref<HTMLImageElement | null>(null)
const bgCustomUrl = ref('')
const bgCustomKind = ref<'image' | 'video'>('image')
const bgCustomPaused = ref(false)
const bgCustomError = ref('')
let bgCustomLoading = false
let bgCustomSeq = 0
let bgCustomWantPlay = false
// 当前已挂载的媒体 id：切换「用作背景」时 url 还在，不能靠 url 是否为空判断要不要重载
let bgCustomId = ''
// 只有媒体真的挂上后才让 body 透明、露出画面；未下载 / 读取失败时保留深海底色与淡光晕
watch([bgVideoUrl, bgCustomUrl], ([v, c]) => {
  document.documentElement.classList.toggle('bg-media-on', !!v || !!c)
})

function bgVideoWanted() {
  return cfg.bgMode === 'video'
}
function bgCustomWanted() {
  return cfg.bgMode === 'custom' && !!cfg.bgMediaId
}
function releaseBgVideo() {
  bgVideoSeq++
  bgVideoLoading = false
  bgVideoWantPlay = false
  bgVideoPaused.value = true
  bgVideoError.value = ''
  if (bgVideoUrl.value) {
    try { URL.revokeObjectURL(bgVideoUrl.value) } catch (err) {}
    bgVideoUrl.value = ''
  }
}
// 宿主回的是 base64 data URL（见 lib/bg-video.js#readData、lib/media.js#data）。
// 直接解码成 Blob，不走 fetch(data:)：设置页没有 CSP，但少一条异步链路、
// 也少一次字符串驻留。MIME 从 data URL 里取，图片/视频共用。
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const meta = comma >= 0 ? dataUrl.slice(0, comma) : ''
  const m = /^data:([^;,]+);base64$/i.exec(meta)
  if (comma < 0 || !m) throw new Error('媒体数据格式不对')
  const bin = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: m[1] })
}
function bgVideoErrorText(err: any) {
  const name = String((err && err.name) || '')
  if (name === 'NotSupportedError') return '浏览器不支持这个视频编码'
  if (name === 'NotAllowedError') return '浏览器拦截了自动播放，点按钮重试'
  return '视频播放失败' + (err && err.message ? '：' + err.message : '')
}
function syncBgVideo() {
  if (!bgVideoWanted()) { releaseBgVideo(); return }
  if (bgVideoUrl.value || bgVideoLoading) return
  const seq = ++bgVideoSeq
  bgVideoLoading = true
  bgVideoError.value = ''
  try {
    const r = services.bgVideoData?.()
    if (!r || !r.ok || !r.dataUrl) return
    const url = URL.createObjectURL(dataUrlToBlob(r.dataUrl))
    // 读盘 / 解码期间用户可能已切走：序号变了就不再挂 blob，避免留下永远不会被释放的 URL
    if (seq !== bgVideoSeq || !bgVideoWanted()) {
      try { URL.revokeObjectURL(url) } catch (err) {}
      return
    }
    bgVideoUrl.value = url
    // 用户选了视频背景 = 明确要动态：打开即尝试播放，减少动态效果只影响片头
    bgVideoWantPlay = true
  } catch (err) {
    // 读不到视频不阻断设置页：CSS 的深海底色仍是完整可用的回退
  } finally {
    if (seq === bgVideoSeq) bgVideoLoading = false
  }
}
function syncBgVideoSoon() {
  window.requestAnimationFrame(() => { syncBgVideo() })
}
function playBgVideo() {
  const v = bgVideoEl.value
  bgVideoWantPlay = true
  bgVideoError.value = ''
  if (!v) return
  try {
    v.muted = true
    v.defaultMuted = true
    // 已在播放时再点「重新播放」从头开始，避免用户以为按钮没反应
    if (!v.paused) v.currentTime = 0
    const p = v.play?.()
    if (p && typeof p.catch === 'function') p.catch((err) => { bgVideoError.value = bgVideoErrorText(err) })
  } catch (err: any) {
    bgVideoError.value = bgVideoErrorText(err)
  }
}
function applyBgVideoMotion() {
  const v = bgVideoEl.value
  if (!v) return
  v.muted = true
  v.defaultMuted = true
  if (bgReduceMotion?.matches && !bgVideoWantPlay) {
    try { v.pause() } catch (err) {}
    return
  }
  try {
    const p = v.play?.()
    if (p && typeof p.catch === 'function') p.catch((err) => { bgVideoError.value = bgVideoErrorText(err) })
  } catch (err: any) {
    bgVideoError.value = bgVideoErrorText(err)
  }
}
function onBgVideoMotionChange() {
  bgVideoReduced.value = bgReduceMotion ? bgReduceMotion.matches === true : false
  applyBgVideoMotion()
  applyBgCustomMotion()
}
// 自动播放被浏览器策略拦下时，用户在页面上的第一次点击/按键就是一次合法交互：
// 顺势把当前背景视频接上（暂停或报错时才补一次，避免每次点击都从头重播）。
function onBgMediaGesture() {
  if (cfg.bgMode === 'custom') {
    const v = bgCustomEl.value
    if (bgCustomKind.value === 'video' && v && (v.paused || bgCustomError.value)) playBgCustom()
    return
  }
  const v = bgVideoEl.value
  if (v && (v.paused || bgVideoError.value)) playBgVideo()
}
// 配置里的 bgMode / uiMode 变化后同步视频层：切走要立刻释放，切进来等首帧后再读盘。
// （watch 必须挂在 cfg 声明之后，见下方 watchPinned 同款 TDZ 注释）
// 首次 applyConfig 也走这里，避免把 1.8MB 读取挤进设置页首帧。
// 下载 / 删除完成后由 LookView 通知：重新读一次宿主缓存（删除时 release 掉旧 blob）
function onBgVideoUpdated() {
  releaseBgVideo()
  if (bgVideoWanted()) syncBgVideo()
}

// —— 自定义背景（media 库） ——
// 图片/视频共用同一个 blob 层；视频沿用内置视频的自动播放与显式播放兜底。
function releaseBgCustom() {
  bgCustomSeq++
  bgCustomLoading = false
  bgCustomWantPlay = false
  bgCustomPaused.value = false
  bgCustomError.value = ''
  bgCustomId = ''
  // 媒体已卸载，类型回到图片：否则清空 bgMediaId 后设置页还残留「播放 / 暂停视频」一行
  bgCustomKind.value = 'image'
  if (bgCustomUrl.value) {
    try { URL.revokeObjectURL(bgCustomUrl.value) } catch (err) {}
    bgCustomUrl.value = ''
  }
}
function syncBgCustom() {
  if (!bgCustomWanted()) { releaseBgCustom(); return }
  if (bgCustomUrl.value || bgCustomLoading) return
  const seq = ++bgCustomSeq
  bgCustomLoading = true
  bgCustomError.value = ''
  try {
    const r = services.mediaData?.(cfg.bgMediaId)
    if (!r || !r.ok || !r.dataUrl) return
    const url = URL.createObjectURL(dataUrlToBlob(r.dataUrl))
    if (seq !== bgCustomSeq || !bgCustomWanted()) {
      try { URL.revokeObjectURL(url) } catch (err) {}
      return
    }
    // 以 data URL 的 MIME 兜底判断类型：宿主元信息缺失时也不会把视频当图片
    const isVideo = r.type === 'video' || /^data:video\//i.test(r.dataUrl)
    bgCustomKind.value = isVideo ? 'video' : 'image'
    bgCustomPaused.value = isVideo
    bgCustomUrl.value = url
    bgCustomId = cfg.bgMediaId
    bgCustomWantPlay = isVideo
  } catch (err) {
    // 读不到媒体不阻断设置页：深海底色回退
  } finally {
    if (seq === bgCustomSeq) bgCustomLoading = false
  }
}
function syncBgCustomSoon() {
  window.requestAnimationFrame(() => { syncBgCustom() })
}
function playBgCustom() {
  const v = bgCustomEl.value
  bgCustomWantPlay = true
  bgCustomError.value = ''
  if (!v) return
  try {
    v.muted = true
    v.defaultMuted = true
    if (!v.paused) v.currentTime = 0
    const p = v.play?.()
    if (p && typeof p.catch === 'function') p.catch((err) => { bgCustomError.value = bgVideoErrorText(err) })
  } catch (err: any) {
    bgCustomError.value = bgVideoErrorText(err)
  }
}
function applyBgCustomMotion() {
  const v = bgCustomEl.value
  if (!v) return
  v.muted = true
  v.defaultMuted = true
  if (bgReduceMotion?.matches && !bgCustomWantPlay) {
    try { v.pause() } catch (err) {}
    return
  }
  try {
    const p = v.play?.()
    if (p && typeof p.catch === 'function') p.catch((err) => { bgCustomError.value = bgVideoErrorText(err) })
  } catch (err: any) {
    bgCustomError.value = bgVideoErrorText(err)
  }
}
// 片头/背景共用的当前播放目标：给 LookView 的「播放视频」按钮用
function playCurrentBgMedia() {
  if (cfg.bgMode === 'custom') playBgCustom()
  else playBgVideo()
}
function pauseCurrentBgMedia() {
  try {
    if (cfg.bgMode === 'custom') bgCustomEl.value?.pause()
    else bgVideoEl.value?.pause()
  } catch (err) {}
}
// 资产删除/媒体变化后由资源页通知：重新读一次宿主缓存（当前媒体被删时配置已由宿主回退）
function onMediaChanged() {
  if (cfg.bgMode === 'custom') {
    releaseBgCustom()
    if (bgCustomWanted()) syncBgCustom()
  }
}

// —— 设置页启动片头（可选，默认关闭） ——
// 触发：每次插件进程启动后首次打开设置页；由宿主 bootIntroConsume 做进程内消费，
// 设置窗关闭重开不会重播，插件重启才会。素材优先复用未至之境视频，没有则播轻量 CSS HUD。
const bootIntroOpen = ref(false)
const bootIntroAutoPlayed = ref(false)
const bootIntroVideoUrl = ref('')
let bootIntroOwnsUrl = false

function loadBootIntroVideo() {
  const source = cfg.bootIntroSource === 'media' || cfg.bootIntroSource === 'css' ? cfg.bootIntroSource : 'auto'
  if (source === 'css') return
  if (source === 'media') { loadBootIntroMedia(cfg.bootIntroMediaId); return }
  // auto：跟随当前背景；背景不是视频就退回 CSS HUD
  if (cfg.bgMode === 'video') {
    if (bgVideoUrl.value) { bootIntroVideoUrl.value = bgVideoUrl.value; bootIntroOwnsUrl = false; return }
    loadBootIntroBuiltin()
    return
  }
  if (cfg.bgMode === 'custom') {
    if (bgCustomKind.value === 'video' && bgCustomUrl.value) {
      bootIntroVideoUrl.value = bgCustomUrl.value
      bootIntroOwnsUrl = false
      return
    }
    loadBootIntroMedia(cfg.bgMediaId)
  }
}
function loadBootIntroBuiltin() {
  try {
    const r = services.bgVideoData?.()
    if (r && r.ok && r.dataUrl) {
      bootIntroVideoUrl.value = URL.createObjectURL(dataUrlToBlob(r.dataUrl))
      bootIntroOwnsUrl = true
    }
  } catch (err) { /* 没视频就走 CSS 片头 */ }
}
function loadBootIntroMedia(id: string) {
  if (!id) return
  try {
    const r = services.mediaData?.(id)
    if (r && r.ok && r.type === 'video' && r.dataUrl) {
      bootIntroVideoUrl.value = URL.createObjectURL(dataUrlToBlob(r.dataUrl))
      bootIntroOwnsUrl = true
    }
  } catch (err) { /* 没视频就走 CSS 片头 */ }
}
// 片头期间是否隐藏设置页：index.html 首帧会先加 boot-intro-pending，
// App 确认这次真的播后才切到 boot-intro-clean；不播 / 播完 / 跳过时两处都清掉。
function bootIntroRevealPage() {
  document.documentElement.classList.remove('boot-intro-pending', 'boot-intro-clean')
}
function bootIntroCleanPage(clean: boolean = cfg.bootIntroClean) {
  if (clean) document.documentElement.classList.add('boot-intro-clean')
  document.documentElement.classList.remove('boot-intro-pending')
}
function maybePlayBootIntro() {
  if (bootIntroOpen.value || !cfg.bootIntroOn) { bootIntroRevealPage(); return }
  // 片头是用户显式开启的功能：减少动态效果只关闭转场/CSS 扫描动画，不再把整个片头跳过
  let ok = false
  try { ok = services.bootIntroConsume?.() === true } catch (err) { ok = false }
  if (!ok) { bootIntroRevealPage(); return }
  bootIntroAutoPlayed.value = true
  bootIntroCleanPage()
  loadBootIntroVideo()
  bootIntroOpen.value = true
}
function playBootIntroPreview(clean: boolean = cfg.bootIntroClean) {
  if (bootIntroOpen.value) return
  bootIntroCleanPage(clean)
  loadBootIntroVideo()
  bootIntroOpen.value = true
}
// 片头开始退场时先让设置页回来，避免退场那 200–460ms 露出纯黑底
function onBootIntroClosing() {
  bootIntroRevealPage()
}
function finishBootIntro() {
  bootIntroOpen.value = false
  bootIntroRevealPage()
  if (bootIntroOwnsUrl && bootIntroVideoUrl.value) {
    try { URL.revokeObjectURL(bootIntroVideoUrl.value) } catch (err) {}
  }
  bootIntroVideoUrl.value = ''
  bootIntroOwnsUrl = false
}
// 注意：applyUtoolsDark 不能在这里立即调用 —— 它读 cfg.uiMode，而 cfg 在下方才声明，
// 先调用会撞 TDZ（ReferenceError），整个 <script setup> 崩掉、设置页白屏（2026-10-03 踩过）。
// 启动调用与轮询定时器挪到 cfg 声明之后。
// 下拉改动：本地立即应用一次再落库 —— 等下一轮轮询或配置回推才变化，会让人以为没生效
function onUiModeChange(mode: string) {
  // 下拉改动：本地立即应用一次再落库 —— 等下一轮轮询或配置回推才变化，会让人以为没生效
  cfg.uiMode = mode === 'light' || mode === 'dark' || mode === 'fantasy' ? mode : 'auto'
  applyUtoolsDark()
  patchCfg({ uiMode: cfg.uiMode })
}
// 纯净片头开关：本地立即生效再落库，否则点「预览片头」时 cfg 还没回填，页面不会隐藏
function onBootIntroCleanChange(on: boolean) {
  cfg.bootIntroClean = on === true
  patchCfg({ bootIntroClean: cfg.bootIntroClean })
}
// 打开系统「减少动态效果」设置页；老宿主没有专用服务时退回 ms-settings 快捷方式
function openSystemAnimationSettings() {
  try {
    const r = services.openSystemAnimationSettings?.()
    if (r && r.ok) return
  } catch (err) {}
  try { services.openExternal?.('ms-settings:easeofaccess-display') } catch (err) {}
}
// 背景调节滑杆：本地先应用再落库，拖动时画面立即跟手（不等宿主配置回推）
function onBgTune(p: { bgScrim?: number; bgBlur?: number; bgBrightness?: number; bgVignette?: number; bgFit?: 'cover' | 'contain'; bgFocusX?: number; bgFocusY?: number; bgZoom?: number }) {
  if (p.bgScrim !== undefined) cfg.bgScrim = Math.max(0, Math.min(80, Math.round(Number(p.bgScrim) || 0)))
  if (p.bgBlur !== undefined) cfg.bgBlur = Math.max(0, Math.min(20, Math.round(Number(p.bgBlur) || 0)))
  if (p.bgBrightness !== undefined) {
    cfg.bgBrightness = Math.max(50, Math.min(120, Math.round(Number(p.bgBrightness) || 100)))
  }
  if (p.bgVignette !== undefined) cfg.bgVignette = Math.max(0, Math.min(100, Math.round(Number(p.bgVignette) || 0)))
  if (p.bgFit !== undefined) cfg.bgFit = p.bgFit === 'contain' ? 'contain' : 'cover'
  if (p.bgFocusX !== undefined) cfg.bgFocusX = Math.max(0, Math.min(100, Math.round(Number(p.bgFocusX) || 0)))
  if (p.bgFocusY !== undefined) cfg.bgFocusY = Math.max(0, Math.min(100, Math.round(Number(p.bgFocusY) || 0)))
  if (p.bgZoom !== undefined) cfg.bgZoom = Math.max(100, Math.min(130, Math.round(Number(p.bgZoom) || 100)))
  patchCfg(p)
}
// 统一的消息态（Flash）：定义收口在 composables/useFlash.ts（合并原先 11 组 msg/err ref）。
// 本文件既自己用，也把 useFlash 注入 useDsh 供 dsh 各卡共用，故仍需 import 进来。
const secretsFlash: Flash = useFlash()
// 首次运行引导弹层的独立回执（不能与 secretsFlash 共用：两个入口同时开着时消息会串）
const guideFlash: Flash = useFlash()
const guideSaving = ref(false)
const showGuide = ref(false)
// 弹层是「首次自动弹出」还是「用户手动重开」：决定标题口径（欢迎使用 / 配置凭据），
// 也决定关闭时要不要写 guideDone —— 手动重开时它本来就是 true，不必再写
const guideReopen = ref(false)
// 本次引导「保存成功」：置位后组件才推进到第三步（完成页）。
// 为什么不让组件点完「保存」自己跳：保存可能失败（异常落 guideFlash.err），
// 乐观跳步会让用户在完成页看到「配置已保存」的红字回执，以为已经存上了。
// 每次打开弹层都要复位 —— 否则上次存成功留下的 true 会让手动重开直接落在完成页
const guideSaved = ref(false)
const testing = ref(false)
const testResults = ref<Array<{ label: string; ok: boolean; msg: string }>>([])
const lastTestAt = ref(0)
const lastTestText = computed(() => {
  if (!lastTestAt.value) return ''
  const d = new Date(lastTestAt.value)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
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
  // 金额遮蔽（挂件上点数字或菜单眼睛切换）：只影响显示，不改任何真实金额
  hideAmounts: false,
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
  // 气泡配色主题：'default' | 'dark' | 'sakura' | 'fantasy'
  theme: 'default',
  // 界面深浅色：'auto' 跟 uTools / 'light' / 'dark' / 'fantasy'（设置页与挂件面板共用；与气泡主题是两条线）
  uiMode: 'auto',
  // 背景氛围（浅色 / 深色 / 未至之境都生效）：'off' / 'deep' / 'aurora' / 'video'（视频需按需下载）
  bgMode: 'off',
  bgMediaId: '',
  bgScrim: 45,
  bgBlur: 0,
  bgBrightness: 100,
  bgVignette: 100,
  bgFit: 'cover',
  bgFocusX: 50,
  bgFocusY: 50,
  bgZoom: 100,
  // 设置页启动片头：默认关闭；每次插件进程启动后首次打开设置页自动播一次
  bootIntroOn: false,
  bootIntroClean: false,
  bootIntroSource: 'auto',
  bootIntroMediaId: '',
  timerNotifyOn: true,
  // 计时到点的邮件通知（邮件总开关 notifyMailOn 未开时不生效）
  timerMailOn: true,
  timerPersistOn: true,
  // 计时气泡常驻 / 计时中气泡只显示计时（只在设置页改，挂件菜单读本地副本）
  timerBubblePin: true,
  timerBubbleOnly: true,
  // 到点气泡停留秒数（0 = 常驻），四档与宿主 store 的归一化同口径
  timerRemindSec: 8,
  // 默认计时时长（秒）与到点要做什么：留言 + 休息档。
  // 这里是「默认值」的唯一写入方：挂件菜单里改时长只影响那一轮，不回写本键
  timerSec: 1500,
  timerNote: '',
  timerBreakMin: 5,
  // 番茄循环（v1.13.0）：倒计时结束后自动进入休息；休息结束停在「继续专注」等用户点
  // （「自动衔接」v1.15 移除，默认配置里也不再保留该键）。
  // 默认值与宿主 constants.js 同值（check-shared 钉住），故直接引用上方常量而不是写死数字。
  timerPomoOn: false,
  timerLongBreakMin: TIMER_LONG_BREAK_DEFAULT,
  timerLongEvery: TIMER_LONG_EVERY_DEFAULT,
  // 到点自动衔接下一条待办（v1.17 恢复为可选）：默认关 —— 没人点的自动开始计时是惊吓不是帮助
  todoAutoNext: false,
  // 挂件计时组快捷时长四档（分钟）：设置页可改，挂件 chips 读它
  timerPresets: TIMER_PRESETS_DEFAULT.slice(),
  enterMode: 'both',
  dshNodeDir: '',
  dshKeepAlive: false,
  // 以管理员身份启动 dsh（默认关；仅 Windows 显示这个开关）。
  // 开启后每次启动都会弹 UAC —— 运行中的进程无法就地提权，只能 runas 拉新实例（见 dsh.js startMode）
  dshElevated: false,
  // dsh Web UI 监听端口（默认 3080 = DEFAULT_DSH_PORT）。空输入由输入框自己兜回默认，
  // 真正落到配置前还要过宿主 store 的 normDshPort（非法值一律退回默认）
  dshPort: DEFAULT_DSH_PORT,
  dshRegistry: '',
  dshVersion: '',
  dshReinstall: false,
  dshNoOpen: true,
  dshOpenIn: 'builtin' as 'builtin' | 'external', // builtin = uTools 内置浏览器（默认）/ external = 系统默认浏览器
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
  ghAccelSrc: { doh: true, community: true, manual: true, sources: [] as string[], order: [] as string[], customSources: [] as string[] },
  // 形象素材包下载源：用户自填的加速前缀（如 'https://ghfast.top/'），空 = 只用内置候选链
  // （默认 ghfast.top → 直连 github.com 兜底）。与 ghAccelSrc 无关，只作用于「按需下载形象」
  skinPackSrc: '',
  // 「随机」抽签是否把随包内置形象算进池子（默认算）。关掉后池子只剩用户勾选参与随机的项
  randomIncludeBuiltin: true,
  // 通知渠道：系统通知（默认开）+ 邮件通知（默认关，需先配 SMTP）。
  // 邮件的收发件人/显示名/主题前缀属于「配置」进这里；服务器、账号、授权码属于凭据，走 mail 表单
  notifySystemOn: true,
  notifyMailOn: false,
  debugTools: false,
  mailFrom: '',
  mailTo: '',
  mailFromName: '小鲸鱼余额挂件',
  mailSubjectPrefix: '[小鲸鱼余额挂件]',
  // 按压气泡（自定义泡泡）配置对象。宿主 normBubble 的出口恒定形态，这里只做兜底初始值，
  // 真值由 applyConfig 从 c.bubble 回填 —— **漏了这步整卡就全是死的**（曾经踩过）：
  // BubbleView 读 cfg.bubble.items，回填缺失 → 恒读 undefined → items 恒为 []，
  // 于是「加一步」按下去宿主其实存成功了，设置页却永远显示 0 步，看着就是按钮点不动。
  bubble: { v: 1, on: false, items: [] as any[], lib: [] as any[], tapAdvance: false, dwell: 5, dragLines: [] as string[], system: {} as Record<string, string[]> },
  // 待办与计时总开关（v1.13.0 引入，v1.15 里 focusOn 与 todoOn 并成一个总开关）：
  // 默认关，不勾时挂件行为与 1.12.0 一致。v1.16 起 focusGoal（每日目标）已从设置页下线，
  // 宿主侧仍保留该键（数据不丢、可逆），这里不再回填也不再写默认值
  todoOn: false,
  // 下班倒计时（v1.14.0）：默认关闭；与宿主 offwork.DEFAULTS / store.js 保持一致
  offworkOn: false,
  offworkStart: '09:00',
  offworkEnd: '18:00',
  offworkDays: [1, 2, 3, 4, 5],
  offworkShowSec: true, offworkRing: true,
  ringWidth: 'normal' as 'thin' | 'normal' | 'thick',
  ringFollowTheme: true, // 外圈粗细 / 圈色跟随气泡主题（LookView 的 :value 直接读，缺了「外圈粗细」下拉框会空选）
  offworkWeekendOn: false, offworkPaydayOn: false,
  offworkPaydayDay: 10,
  // 时薪（元/小时）：0 = 未配置（输入框显示空、挂件不显示「今日已赚」），只有正数才参与估算
  offworkHourlyWage: 0,
  // 自定义显示：用户隐藏的 Tab 与卡片（空数组 = 全部显示）+ Tab 顺序（空数组 = 默认顺序）
  // + 置顶卡片（空数组 = 无置顶；顺序即组内置顶顺序）
  hiddenTabs: [] as string[],
  hiddenCards: [] as string[],
  tabOrder: [] as string[],
  pinnedCards: [] as string[],
  // 卡片自定义顺序：{ TabKey: [cardKey, ...] }，空对象 = 全部按模板顺序。
  // 只记普通卡（置顶卡的顺序由 pinnedCards 决定），未列出的卡按模板序补在后面
  cardOrder: {} as Record<string, string[]>,
  // 逐卡「默认展开」覆盖：{ foldKey: boolean }，空对象 = 全部用 FOLD_DEFAULTS 出厂值
  foldDefaults: {} as Record<string, boolean>,
  // 是否记忆每张卡上次的展开 / 收起状态。关掉 = 不读也不写 localStorage，永远回落到默认值
  foldRemember: true,
})
// applyConfig 每次保存后都会再跑一遍；只有首屏那一次算「注入」，之后都算用户改了折叠默认值。
// 两者对缓存的处理相反（首屏要让「记住的上次状态」优先，改动要让新默认值立刻生效），故用这个开关区分
let foldPrefsReady = false
// 深浅色启动应用 + 轮询（必须在 cfg 声明之后：applyUtoolsDark 读 cfg.uiMode，见上方 TDZ 注释）
applyUtoolsDark()
applyBg()
// 视频壁纸的同步 watch（必须在 cfg 声明之后：getter 会立即求值，提前访问 cfg 会 TDZ）
watch([() => cfg.bgMode, () => cfg.uiMode], () => {
  if (!bgVideoWanted()) { releaseBgVideo(); return }
  if (!bgVideoUrl.value && !bgVideoLoading) syncBgVideoSoon()
})
// 自定义媒体背景：媒体 id / 模式变化后同步（切走立刻释放；换了一张也要先释放旧的）
watch([() => cfg.bgMode, () => cfg.bgMediaId, () => cfg.uiMode], () => {
  if (!bgCustomWanted()) { releaseBgCustom(); return }
  if (bgCustomId !== cfg.bgMediaId) { releaseBgCustom(); syncBgCustomSoon(); return }
  if (!bgCustomUrl.value && !bgCustomLoading) syncBgCustomSoon()
})
// LookView 的「播放视频」按钮：当前自定义视频或内置视频的暂停态
const bgMediaPaused = computed(() => (cfg.bgMode === 'custom' ? bgCustomPaused.value : bgVideoPaused.value))
// 当前背景是否为视频（自定义媒体要等 mediaData 回来才知道类型）
const bgMediaIsVideo = computed(() => (cfg.bgMode === 'custom' ? bgCustomKind.value === 'video' : cfg.bgMode === 'video'))
// 视频解码 / 自动播放失败的文案（给设置页提示）
const bgMediaError = computed(() => (cfg.bgMode === 'custom' ? bgCustomError.value : bgVideoError.value))
// 背景遮罩/模糊/亮度统一走 CSS 变量，图片与视频共用
const bgMediaStyle = computed(() => ({
  '--bg-scrim': String((Number(cfg.bgScrim) || 45) / 100),
  '--bg-blur': `${Number(cfg.bgBlur) || 0}px`,
  '--bg-brightness': String((Number(cfg.bgBrightness) || 100) / 100),
  '--bg-vignette': String((Number(cfg.bgVignette) || 100) / 100),
}))
// 自定义媒体的构图：cover/contain、焦点、缩放（内置视频保持自己的固定构图）
const bgCustomFrameStyle = computed<CSSProperties>(() => ({
  objectFit: cfg.bgFit === 'contain' ? 'contain' : 'cover',
  objectPosition: `${Math.max(0, Math.min(100, Number(cfg.bgFocusX) || 50))}% ${Math.max(0, Math.min(100, Number(cfg.bgFocusY) || 50))}%`,
}))
const bgCustomZoomStyle = computed(() => ({
  '--bg-zoom': String(1.02 * (Math.max(100, Math.min(130, Number(cfg.bgZoom) || 100)) / 100)),
}))
// 智能适配：读当前背景首帧的平均亮度，给一个更稳的遮罩值（用户在滑杆上仍可微调）
function sampleBgLuminance(el: HTMLImageElement | HTMLVideoElement | null): number | null {
  if (!el) return null
  try {
    const w = 32
    const h = 18
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) return null
    const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth
    const sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight
    if (!sw || !sh) return null
    ctx.drawImage(el, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    return sum / (data.length / 4) / 255
  } catch (err) { return null }
}
function autoTuneBgMedia() {
  const el = cfg.bgMode === 'custom'
    ? (bgCustomKind.value === 'video' ? bgCustomEl.value : bgCustomImgEl.value)
    : bgVideoEl.value
  const lum = sampleBgLuminance(el)
  // 亮度越高越需要压暗；限制在 20%–65%，避免一键调成纯黑/纯透
  const scrim = lum === null ? 45 : Math.max(20, Math.min(65, Math.round((0.25 + lum * 0.4) * 100)))
  onBgTune({ bgScrim: scrim })
}
// 置顶重排的 watch 同理必须在 cfg 声明之后挂（getter 读 cfg.pinnedCards）
watchPinned()
// 当前 Tab 被隐藏后自动切到相邻的可见 Tab：否则 Tab 栏没有高亮、内容还停在已隐藏那组，
// 显示管理看起来就像「勾了没反应」；配置到达（applyConfig 替换 hiddenTabs）时也会触发这里。
// 落点取「原位置右侧最近的可见组，没有就左侧」——统一跳第一组会让用户以为页面自己乱跳。
// **必须放在 cfg 声明之后**：watch 创建时会立刻求值 visibleTabs，提前访问 cfg 会触发 TDZ
// （与上方 applyUtoolsDark 同一条教训，运行时实测报过「Cannot access before initialization」）
watch(visibleTabs, (list, prev) => {
  if (!list.length) return
  const cur = activeTab.value
  if (list.some((t) => t.key === cur)) return
  const idx = prev ? prev.findIndex((t) => t.key === cur) : -1
  const target = list[Math.min(Math.max(idx, 0), list.length - 1)] || list[0]
  activeTab.value = target.key
  scrollPageTop() // 自动跳组同样回顶，别让页面停在被隐藏分组的滚动位置
  const lostLabel = prev && prev.find((t) => t.key === cur)?.label
  // 复用显示管理的回执条（Tab 下方那行说明文字位置），不另起一套 toast。
  // 措辞用「已隐藏」而不是「已隐藏了」：配置回填（备份恢复 / 手改配置）也可能触发这里，
  // 不能暗示是用户刚刚点的隐藏。
  showDisplayMsg(`「${lostLabel || '当前'}」分组已隐藏，已切到「${target.label}」`)
})
const darkPollTimer = window.setInterval(applyUtoolsDark, 1000)
onUnmounted(() => { window.clearInterval(darkPollTimer) })
// 「提醒与通知」卡片的模板 ref：applyConfig 回填后要落「未保存」基线、备份恢复 / 宿主配置推送后
// 要刷新展示 —— 这些都由父级生命周期驱动，故用 ref 调组件暴露的方法。
// 保存 / 恢复默认提醒文案要先写配置再整份 applyConfig 回读，涉及父级 onConfigChange 通路，故仍留父级。
const notifyViewRef = ref<{ syncAlertsBaseline: () => void } | null>(null)
// 提醒文案保存 / 恢复默认：子组件整理好整份内容（或 null = 恢复默认）上抛，这里落盘并回读。
// 失败回执由 patchCfg 统一处理（失败条常驻，见 saveFail），这里不必再判返回值
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
// 六张开发卡的折叠态走 useFold：保留「默认收起 + 首次展开才读」的原行为，
// 同时让「管理显示内容」里的默认展开/收起与记忆开关能管到它们。
// 模板与 toggleDevCard 里大量用 devFolds.xxx 读写，故用 getter/setter 转给各自的实例
const devFoldStates = {
  dshUsage: useFold('dshUsage', false),
  diagnose: useFold('dshDiagnose', false),
  dshDump: useFold('dshDump', false),
  dshIsolate: useFold('dshIsolate', false),
  dshMarket: useFold('dshMarket', false),
  dshExport: useFold('dshExport', false),
}
const devFolds = reactive({
  get dshUsage() { return devFoldStates.dshUsage.open },
  set dshUsage(v: boolean) { devFoldStates.dshUsage.open = v },
  get diagnose() { return devFoldStates.diagnose.open },
  set diagnose(v: boolean) { devFoldStates.diagnose.open = v },
  get dshDump() { return devFoldStates.dshDump.open },
  set dshDump(v: boolean) { devFoldStates.dshDump.open = v },
  get dshIsolate() { return devFoldStates.dshIsolate.open },
  set dshIsolate(v: boolean) { devFoldStates.dshIsolate.open = v },
  get dshMarket() { return devFoldStates.dshMarket.open },
  set dshMarket(v: boolean) { devFoldStates.dshMarket.open = v },
  get dshExport() { return devFoldStates.dshExport.open },
  set dshExport(v: boolean) { devFoldStates.dshExport.open = v },
})
// 读过的卡 → 读完那一刻的时间戳（0 = 没读过）。用时间戳而非布尔（P5，2026-10-09）：
// 布尔是「本会话读过了」的永久态，而宿主侧的 dsh 数据是**会变的** —— 用户本页收起卡、
// 去别处 dsh 装了插件 / 换了 profile，回来时折叠标题上的摘要还是旧数字，看着像插件没刷新。
// 记时间戳后由 onWindowActive 判是否过期，过期就重读一次。
const devStatsLoaded = reactive<Record<string, number>>({ dshUsage: 0, diagnose: 0, dshDump: 0, dshIsolate: 0, dshMarket: 0, dshExport: 0 })
// 回到本窗口时，已读卡超过这个时长就重读。取 5 分钟：
// 短于它的「切个 tab 又回来」不该重扫（宿主是同步扫文件，会话日志可能几十 MB）；
// 长于它的（挂机办公一阵再回来）本地快照大概率已经变了。
// ⚠️ 只用于「重读本地快照」这类廉价动作 —— 勾选联网的卡（dshMarket）不参与自动重读
const DEV_STATS_STALE_MS = 5 * 60 * 1000
function markDevCardLoaded(key: string) { devStatsLoaded[key] = Date.now() }

function toggleDevCard(key: 'dshUsage' | 'diagnose' | 'dshDump' | 'dshIsolate' | 'dshMarket' | 'dshExport') {
  devFolds[key] = !devFolds[key]
  if (!devFolds[key]) return
  if (devStatsLoaded[key]) { markDevCardLoaded(key); return } // 已读过且还开着：只把新鲜度续上，不重读
  markDevCardLoaded(key)
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
  dshMarketPlainDep,
  dshMarketPlainDepTip,
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
// 时间戳 → 'HH:mm'（与宿主 util.hhmm 同口径）。用量卡多处「条目 / 校准时间」列共用，
// 留在父级作单一来源按 props 下传，避免各 view 各写一份补零拼装。
function hhmm(ts: number): string {
  const d = new Date(ts)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
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
  // 走 patchCfg 而不是直连 saveConfig：倍率同样是用户改动，保存失败必须回执
  // （早先这里裸调，写盘失败时挂件尺寸已按新值改过、存储却没记住，重启就「莫名变回原大小」）
  patchCfg({ scale: cfg.scale })
}
// 设置页所有配置写入的唯一入口。返回是否落盘成功（调用方基本不看 —— 失败回执在本函数内统一处理）。
//
// 为什么失败要重试一次：dbStorage 的写失败偶发（并发写、瞬时配额），一次就放弃会让用户
// 白改一遍。重试仍失败才置失败条 —— 这时基本可以确定是持续状态（存储满 / 被拒绝）。
//
// 为什么失败后要 applyConfig 回读：patchCfg 的调用方几乎都是「先改本地 cfg、再落盘」，
// 落盘失败时本地已经显示成新值了。不回读的话界面会一直显示「假的新值」（开关翻着、
// 实际存储还是旧值），用户看着像是生效了。
//
// —— 调试工具（config.debugTools 默认关，只在「开发者」Tab 且开关打开时渲染）——
// 卡片本体在 views/DevView.vue；「专注 / 待办 / 计时」三条只读自检的判定在
// composables/useDebugSelfCheck（结果由本层持有，切 Tab 回来还在），父级只转交调用。
const dbg = useDebugSelfCheck(services)
// 整张卡只在 uTools 开发模式下存在（v1.18）：打包版用户看到「注入旧数据」这类会真写库的按钮，
// 除了困惑没有任何用处，误点还会污染专注 / 待办数据。故开发模式下才渲染，打包版连 DOM 都没有。
// services.isDev 在宿主里现取 utools.isDev()，不要缓存成一次性常量 —— 设置页窗口可能跨模式复用。
const devMode = computed(() => {
  try { return !!services.isDev?.() } catch (err) { return false }
})
function patchCfg(p: Record<string, any>): boolean {
  let lastErr: any = null
  for (let i = 0; i < 2; i++) {
    try {
      services.saveConfig?.(p)
      return true
    } catch (err) {
      lastErr = err
    }
  }
  saveFail.patch = p
  saveFail.msg = '有一处设置没保存上（' + String((lastErr as Error)?.message || lastErr) + '）。'
    + '界面上的值可能已回退（存储空间不足或被占用时会这样）。'
  // 失败回滚成已落盘的真实值（理由见函数头注释）
  applyConfig(services.getConfig?.())
  return false
}
// 失败条上的「重试」：只重放最后这一次改动（不重放历史，理由见 saveFail 的注释）。
// 成功就收掉提示条；仍失败则保留换新文案（patchCfg 会覆盖），免得用户以为「点了没反应」。
function retrySaveCfg() {
  if (!saveFail.patch || saveFail.retrying) return
  const p = saveFail.patch
  saveFail.retrying = true
  // 给按钮一个「正在试」的可见状态再动手：写盘是同步的，直接调用会把这段时间吞掉，
  // 用户点完看不到任何动静会以为按钮坏了、连点几下
  window.setTimeout(() => {
    saveFail.retrying = false
    if (patchCfg(p)) { saveFail.msg = ''; saveFail.patch = null }
  }, 0)
}
// —— 自定义音效（按压/释放两段 + 四类提醒各一组，文件复制进本地数据目录） ——
// 每个槽位只保留一段：再导入就是替换掉旧的（挂件端不再有「随机播」这回事）
// 同值副本：preload 不参与打包，设置页读不到宿主常量（见 public/preload/lib/sounds.js 的 ROLES / ROLE_LABEL）
const SOUND_ROLES: SoundRole[] = ['press', 'release', 'low', 'budget', 'peak', 'pass']
// 四类提醒各自的提醒音：留空 = 用内置提醒音（挂件页 ALERT_FALLBACK），导入后跟随音效开关与音量
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
// 试听一段内置音色（「挂件外观 → 音色」里小黄鸭 / 音效 1 的试听）。
// 内置音色的路径是挂件页同值副本（见下面 BUILTIN_SOUND_FILES 与 check-shared 的比对），
// 直接 new Audio(url) 即可，不走 soundData —— 那份只装用户导入的槽位音。
function doPreviewBuiltinSound(url: string) {
  soundFlash.msg = ''
  soundFlash.err = false
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
// 导入进行中（防连点重入）：doImportSkin 里有一次 `await makeThumb`，期间再点会并发跑第二遍
// —— 弹两个裁剪窗、或两张图同时写（后写的顶掉先写的）。进入置真、finally 复位，按钮据此禁用
const skinImportBusy = ref(false)
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
  if (skinImportBusy.value) return
  skinImportBusy.value = true
  skinFlash.msg = ''
  skinFlash.err = false
  try {
    const r = services.pickImageFile?.()
    if (!r) throw new Error('宿主 API 不可用')
    if (r.canceled) return
    if (!r.ok || !r.dataUrl) throw new Error(r.error || '未知错误')
    // 动图（gif/apng）走直接复制，不裁剪：canvas 只取首帧会丢掉动画
    if (r.ext === 'gif' || r.ext === 'apng') {
      const thumb = await makeThumb(r.dataUrl)
      const ir = services.importSkinFromPath?.(r.filePath || '', r.name || '', thumb)
      if (!ir) throw new Error('宿主 API 不可用')
      if (!ir.ok) throw new Error(ir.error || '未知错误')
      skinFlash.msg = `已导入形象「${ir.name || r.name || ''}」（动图不裁剪，保留动画）`
      refreshSkin()
      cfg.skin = 'custom'
      return patchCfg({ skin: cfg.skin })
    }
    skinCrop.value = { dataUrl: r.dataUrl, name: r.name || '' }
  } catch (err: any) {
    skinFlash.err = true
    skinFlash.msg = '导入失败：' + String(err?.message || err)
  } finally {
    skinImportBusy.value = false
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
    skinFlash.msg = `已把 ${picked.length} 张设为${on ? '参与' : '不参与'}随机`
      + `（现共 ${skinGallery.value.items.filter(it => it.random !== false).length}/${skinGallery.value.items.length} 张参与）`
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
// 体积展示（fmtBytes / assetSize）已收进 utils/format.ts，此处直接引用
// 全部清除：形象 + 气泡图 + 六段音效（与「数据与隐私」里的按项清除同源，但只清素材、不动其它数据）。
// 清完把形象/音色从「自定义」回退为内置，避免停在「自定义」却无素材可用。
//
// ⚠️ 形象这一条必须走 removeSkins（批量），不能 for 循环逐张 removeSkin：
// 后者每张都做一次 readRaw + writeRaw（整份画廊 JSON 序列化落盘），还会推两次挂件
//（其中一次是共享角色图池；曾经连本体一起搬 —— 单张 0.9~2.7MB 读成 base64，现在只推清单，见 skins.js）。
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
    // 背景/片头媒体也属于「导入的素材」；clearAll 会把它引用的背景/片头配置回退
    const mediaR = services.mediaClearAll?.()
    if (!mediaR || !mediaR.ok) failed = failed || '背景/片头媒体'
    mediaRefreshTick.value++
    refreshSkin()
    refreshBubbles()
    refreshSounds()
    releaseBgCustom()
    // 形象卡里的「已下载」态由资产页自己在下一次渲染时重拉（组件常挂载，无需父级代劳）
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
// 背景/片头媒体列表的外部刷新信号（清除数据、概览清空时自增；AssetsView 据此重拉）
const mediaRefreshTick = ref(0)
// 「展开形象卡」指令计数器：AssetsView 内部 watch 它自增即展开（折叠态是本组件私有，父级改不了）
const browseSkinsTick = ref(0)

// 皮肤包 / 共享素材的「已装清单」与「正在使用的形象缺失」判定，都随「形象」卡下沉到了
// AssetsView（它自己 listSkinPacks / listSharedSkins 并渲染下载态）。这里不再持有镜像副本 ——
// 原先 App 与 AssetsView 各拉一次清单，App 那份只服务一个自动展开的 watch，纯属重复。

// —— 共享素材（角色图 36 张 + 音效库 45 个，上游 QQ 群素材，挂 Release 按需下） ——
// v1.9.0 起与「可下载的内置形象」同一套单张下载：点缩略图只下这一张（走 raw 直链），
// 顶上按钮才逐张串行补齐。不再有「点任意一张 = 下整包」的语义。
// 缩略图路径（sharedSkinThumb）与「读成 data URL」（fetchAsDataUrl）已收进 utils/format.ts。
// 为什么必须由设置页给宿主 data URL：宿主（preload）定位不到插件目录 —— 它只有 utools.getPath('userData')，
// 而相对路径 './resources/...' 只有渲染进程能解析。不给的话下载回来的共享角色没有缩略图，
// 画廊只能回落读原图（0.9~2.7MB 一张），很快耗光 listSkins 的 8MB 回落预算，后面全显示「无预览」。
function sharedSkinThumbDataUrl(id: string) {
  return fetchAsDataUrl(sharedSkinThumb(id))
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
  let unusedMedia: MediaItem[] = []
  try {
    const list = services.mediaList?.()
    unusedMedia = (list && list.ok ? list.items : []).filter((m) =>
      m.id !== cfg.bgMediaId && m.id !== cfg.bootIntroMediaId)
  } catch (err) { unusedMedia = [] }
  if (!skinIds.length && !roles.length && !unusedMedia.length) return
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
    let mediaRemoved = 0
    for (const m of unusedMedia) {
      const r = services.mediaRemove?.(m.id)
      if (!r || !r.ok) failed = failed || '背景/片头媒体'
      else mediaRemoved++
    }
    if (unusedMedia.length) mediaRefreshTick.value++
    refreshSkin()
    refreshSounds()
    // 同上：形象卡的下载态由资产页自管
    skinPicked.value = []
    if (failed) {
      skinFlash.err = true
      skinFlash.msg = `部分素材清除失败：${failed}`
      return
    }
    skinFlash.msg = `已清除 ${skinIds.length + roles.length + mediaRemoved} 项未使用素材（正在使用的已保留）`
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
    // 保存成功**不关弹层**，只把组件推进到第三步（完成页），由用户点「开始使用 / 去挑形象」关闭。
    // 原先这里直接 showGuide = false，于是第三步的完成页与「去挑形象」入口从来没显示过（死代码）。
    // guideReopen 也不动：完成页的标题口径应与打开时一致，否则重开引导的人会突然看到「欢迎使用」
    guideSaved.value = true
    if (r && !r.hasApiKey) {
      // 没填 API Key：引导仍算走完（否则每次打开都弹），但要把用户送到能补的地方。
      // 不再额外弹 secretsFlash —— 完成页本身就有「没有填 API Key」的红字说明，
      // 而弹层此时还盖在上面，那条 4 秒后自动消失的回执多半等不到用户看见
      activeTab.value = 'data'
      credentialsFold.open = true
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
  guideSaved.value = false
}
// 手动重开引导（数据 Tab 凭据卡里的入口）：不改 guideDone，纯粹再展示一次 ——
// 用户回来多半是想换个 Key 或忘了进入方式在哪调
function onGuideReopen() {
  guideFlash.msg = ''
  guideFlash.err = false
  guideSaved.value = false
  guideReopen.value = true
  showGuide.value = true
}
// 引导完成页的「去挑形象」：关掉引导 → 切到「资源」Tab → 展开「形象」卡折叠区 → 滚到该卡。
// 不在这里直接下形象 —— 下载是设置页形象区的活儿（含进度、失败提示、已装状态），
// 引导层只负责把用户带到那儿，免得同一套逻辑写两份（历史上这种重复漏过收件人）。
// 「展开折叠区」是 AssetsView 内部状态（galleryFolds），父级读不到，故用自增计数下发指令；
// 加一次 nextTick 让「切 Tab + 命令展开」先落地，再量卡片位置滚动。
function onGuideBrowseSkins() {
  onGuideSkip()
  clearSearch()
  activeTab.value = 'assets'
  browseSkinsTick.value++
  nextTick(() => {
    const el = document.querySelector('[data-search="assetsSkins"]')
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
function onDataCleared(picked: { secrets: boolean; config: boolean; ledger: boolean; window: boolean; sounds: boolean; skins: boolean; bubbles: boolean; media: boolean; bubble: boolean; todo: boolean }) {
  if (picked.secrets) {
    secrets.apiKey = ''
    secrets.platformToken = ''
    secretsFlash.msg = ''
  }
  // 清音效/形象可能改了音色与形象（自定义 → 内置），因此与清设置一样要重新套用配置；
  // 「按压气泡」重置了文案/开关（也在配置里），同样要重新套用；媒体清空会回退背景/片头
  if (picked.config || picked.sounds || picked.skins || picked.bubble || picked.media) applyConfig(services.getConfig?.())
  if (picked.media) { releaseBgCustom(); mediaRefreshTick.value++ }
  if (picked.ledger) usageHistory.value = []
  else refreshHistory()
  if (picked.sounds) refreshSounds() // 音效卡片（音色「自定义」）回显为「未导入」
  if (picked.skins) refreshSkin()   // 形象画廊回显为空（只剩「＋ 导入」）
  if (picked.bubbles || picked.bubble) refreshBubbles() // 气泡图网格回显为空（「按压气泡」也清了配图）
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
// label 默认取 constants/commands 的唯一副本（与 plugin.json 的 cmds 构建期校验一致）
function copyHotkeyCmd(label: string = CMD_TOGGLE) {
  const ok = services.copyText?.(label)
  widgetFlash.err = !ok
  widgetFlash.msg = ok
    ? `已复制「${label}」，粘贴到 uTools「全局功能」的指令框即可。`
    : `复制失败，请手动输入指令名：${label}`
}
// 跳转 uTools「全局功能」并直接新增一条待绑定项（快捷键被删除后可用它重新添加）
// 注意：每次点击都会新增一条，uTools 无「只跳转不新增」的接口
function addHotkey(label: string = CMD_TOGGLE) {
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
      // 版本比较的基准是 GitHub 主线，可能领先于 uTools 市场 —— 只写「去市场更新」会让
      // 市场尚未同步的用户白跑一趟，所以同时指出项目主页这条路
      else if (r.hasUpdate) updateMsg.value = '发现新版本 v' + r.latest + '（当前 v' + r.current + '），可在插件市场更新；市场尚未同步时可到「项目主页」下载'
      else updateMsg.value = '已是最新版本'
    })
    .catch((err: any) => {
      updateMsg.value = '检查失败：' + String(err?.message || err)
    })
    .finally(() => { updateChecking.value = false })
}
// 教程里的链接用系统浏览器打开，避免在插件窗口内导航。
// 协议白名单统一在宿主 openExternal 里做（那里是所有外链的唯一出口，覆盖面最大），
// 前端这里只做「有没有地址」的判断
function openDoc(url: string) {
  if (!url) return
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
  // 提醒文案：NotifyView 的 textarea 直接读 cfg.alerts，漏了这一步保存后重开设置页会整体显示为空
  const al = c.alerts && typeof c.alerts === 'object' ? c.alerts : {}
  for (const k of Object.keys(cfg.alerts)) {
    cfg.alerts[k] = typeof al[k] === 'string' ? al[k] : ''
  }
  cfg.soundOn = c.soundOn !== false
  cfg.soundSet = c.soundSet
  cfg.usageMode = c.usageMode
  cfg.peakMode = c.peakMode
  cfg.peakRemindOn = c.peakRemindOn !== false
  cfg.bubbleOn = c.bubbleOn
  cfg.hideAmounts = c.hideAmounts === true
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
  cfg.theme = c.theme === 'dark' || c.theme === 'sakura' || c.theme === 'fantasy' ? c.theme : 'default'
  // 界面深浅色回填：非法值按 auto 处理（与宿主 normUiMode 同口径）。
  // 回填后立即重应用：启动首次应用拿的是本地默认 auto，存储里的手动 light/dark 这时才到达，
  // 不重应用要等下一轮 1s 轮询才变对；挂件菜单改 uiMode 经配置推送过来也靠这里即时生效
  cfg.uiMode = c.uiMode === 'light' || c.uiMode === 'dark' || c.uiMode === 'fantasy' ? c.uiMode : 'auto'
  cfg.bgMode = ['deep', 'aurora', 'stars', 'mist', 'polar', 'warm', 'video', 'custom'].includes(c.bgMode)
    ? c.bgMode
    : 'off'
  cfg.bgMediaId = typeof c.bgMediaId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(c.bgMediaId) ? c.bgMediaId : ''
  cfg.bgScrim = typeof c.bgScrim === 'number' && isFinite(c.bgScrim) ? Math.max(0, Math.min(80, Math.round(c.bgScrim))) : 45
  cfg.bgBlur = typeof c.bgBlur === 'number' && isFinite(c.bgBlur) ? Math.max(0, Math.min(20, Math.round(c.bgBlur))) : 0
  cfg.bgBrightness = typeof c.bgBrightness === 'number' && isFinite(c.bgBrightness)
    ? Math.max(50, Math.min(120, Math.round(c.bgBrightness)))
    : 100
  cfg.bgVignette = typeof c.bgVignette === 'number' && isFinite(c.bgVignette)
    ? Math.max(0, Math.min(100, Math.round(c.bgVignette)))
    : 100
  cfg.bgFit = c.bgFit === 'contain' ? 'contain' : 'cover'
  cfg.bgFocusX = typeof c.bgFocusX === 'number' && isFinite(c.bgFocusX) ? Math.max(0, Math.min(100, Math.round(c.bgFocusX))) : 50
  cfg.bgFocusY = typeof c.bgFocusY === 'number' && isFinite(c.bgFocusY) ? Math.max(0, Math.min(100, Math.round(c.bgFocusY))) : 50
  cfg.bgZoom = typeof c.bgZoom === 'number' && isFinite(c.bgZoom) ? Math.max(100, Math.min(130, Math.round(c.bgZoom))) : 100
  cfg.bootIntroOn = c.bootIntroOn === true
  cfg.bootIntroClean = c.bootIntroClean === true
  cfg.bootIntroSource = c.bootIntroSource === 'media' || c.bootIntroSource === 'css' ? c.bootIntroSource : 'auto'
  cfg.bootIntroMediaId = typeof c.bootIntroMediaId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(c.bootIntroMediaId)
    ? c.bootIntroMediaId
    : ''
  applyUtoolsDark()
  applyBg()
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
  // 回填必须带档位校验：不合法的值一律回默认 8，否则 TimerView 的下拉框会空选
  cfg.timerRemindSec = c.timerRemindSec === 0 || c.timerRemindSec === 5 || c.timerRemindSec === 8 || c.timerRemindSec === 15
    ? c.timerRemindSec
    : 8
  cfg.timerSec = typeof c.timerSec === 'number' && c.timerSec > 0 ? Math.round(c.timerSec) : 1500
  cfg.timerNote = typeof c.timerNote === 'string' ? c.timerNote : ''
  cfg.timerBreakMin = typeof c.timerBreakMin === 'number' ? c.timerBreakMin : 5
  // 番茄循环（v1.13.0）：与宿主 store 的归一化同口径（长休 1–60 分钟、每 2–12 轮一次）。
  // **必须回填**：漏了这几行，Setting 页保存后重开开关会自己弹回去，看着像没保存
  cfg.timerPomoOn = c.timerPomoOn === true
  cfg.timerLongBreakMin = typeof c.timerLongBreakMin === 'number' && isFinite(c.timerLongBreakMin)
    ? Math.min(60, Math.max(1, Math.round(c.timerLongBreakMin)))
    : TIMER_LONG_BREAK_DEFAULT
  cfg.timerLongEvery = typeof c.timerLongEvery === 'number' && isFinite(c.timerLongEvery)
    ? Math.min(12, Math.max(2, Math.round(c.timerLongEvery)))
    : TIMER_LONG_EVERY_DEFAULT
  // 到点衔接下一条待办：同理必须回填，否则保存后开关自己弹回去
  cfg.todoAutoNext = c.todoAutoNext === true
  // 快捷时长四档：与宿主 normTimerPresets 同口径（固定 4 档、1–600 分钟、缺项补默认）。
  // 必须回填：TimerView 的四个输入框读的是这里，漏了会「改完重开又变回去」
  cfg.timerPresets = Array.isArray(c.timerPresets)
    ? TIMER_PRESETS_DEFAULT.map((dft, i) => {
      const n = Number(c.timerPresets[i])
      return c.timerPresets[i] == null || c.timerPresets[i] === '' || !isFinite(n)
        ? dft
        : Math.round(Math.min(600, Math.max(1, n)))
    })
    : TIMER_PRESETS_DEFAULT.slice()
  // 待办与计时总开关（v1.13.0）：同样必须回填，否则 FocusView 的开关读不到已存值。
  // 旧配置只有 focusOn 时宿主已在 readConfig 里兜底成 todoOn，这里只管取最终值。
  // v1.16 起不再回填 focusGoal —— 设置页已无每日目标入口，回填一个无消费方的字段只会误导
  cfg.todoOn = c.todoOn === true
  // 下班倒计时（v1.14.0）：九键同样必须回填，否则 OffworkView 的开关 / 时间 / 工作日 / 时薪在重开设置页后看着像没保存
  cfg.offworkOn = c.offworkOn === true
  cfg.offworkStart = normOffworkHm(c.offworkStart, OFFWORK_DEFAULTS.start)
  cfg.offworkEnd = normOffworkHm(c.offworkEnd, OFFWORK_DEFAULTS.end)
  cfg.offworkDays = normOffworkDays(c.offworkDays, OFFWORK_DEFAULTS.days)
  cfg.offworkShowSec = c.offworkShowSec !== false
  cfg.offworkRing = c.offworkRing !== false; cfg.ringWidth = ['thin', 'thick'].includes(c.ringWidth) ? c.ringWidth : 'normal'; cfg.ringFollowTheme = c.ringFollowTheme !== false // 外圈粗细带档位校验（非法回默认 normal），圈色默认跟随主题；缺回填会让 LookView 的下拉框空选
  cfg.offworkWeekendOn = c.offworkWeekendOn === true
  cfg.offworkPaydayOn = c.offworkPaydayOn === true
  cfg.offworkPaydayDay = normOffworkPayday(c.offworkPaydayDay)
  cfg.offworkHourlyWage = normOffworkWage(c.offworkHourlyWage)
  // 自定义显示：隐藏列表原样回填（空数组 = 全部显示）。漏了这里，DisplayManager 勾选后
  // 本地 cfg 永远不变，界面看着像「点不动」。
  // 含核心卡片的 Tab 与核心卡片本身一律剔掉：老备份 / 手改配置可能带着它们，
  // 不能让核心卡片被整体藏没（DisplayManager 只在勾选侧禁用，配置回填这道闸不能省）
  cfg.hiddenTabs = Array.isArray(c.hiddenTabs)
    ? c.hiddenTabs.filter((k: any) => typeof k === 'string' && !CORE_TABS.includes(k))
    : []
  cfg.hiddenCards = Array.isArray(c.hiddenCards)
    ? c.hiddenCards.filter((k: any) => typeof k === 'string' && !CORE_CARDS.includes(k))
    : []
  // Tab 顺序同样必须回填：visibleTabs 按 cfg.tabOrder 排序，漏了就「调完顺序重开又变回去」
  cfg.tabOrder = Array.isArray(c.tabOrder)
    ? c.tabOrder.filter((k: any) => typeof k === 'string' && TABS.some((t) => t.key === k))
    : []
  // 置顶卡片同理：漏了就「置顶完重开又掉回去」。只认索引里真实存在的卡片 id，
  // 卸载掉的旧卡 / 手改配置里的野 id 一律剔掉（否则置顶区标题会冒出空 label）
  cfg.pinnedCards = Array.isArray(c.pinnedCards)
    ? c.pinnedCards.filter((k: any) => typeof k === 'string' && !!SEARCH_INDEX[k])
    : []
  // 卡片自定义顺序：只认索引里真实存在、且确实属于该 Tab 的卡；
  // 顺序本身由宿主归一（去重 / 限长），这里再做一道 Tab 归属校验 ——
  // 跨 Tab 的野 key 混进来会让「另一个 Tab 的卡」在排序里占位，补尾时被跳过，用户看着像丢了一张
  const rawOrder = c.cardOrder && typeof c.cardOrder === 'object' && !Array.isArray(c.cardOrder) ? c.cardOrder : {}
  const nextCardOrder: Record<string, string[]> = {}
  for (const t of TABS) {
    const list = rawOrder[t.key]
    if (!Array.isArray(list)) continue
    const valid = list.filter((k: any) => typeof k === 'string' && SEARCH_INDEX[k]?.tab === t.key)
    if (valid.length) nextCardOrder[t.key] = valid
  }
  cfg.cardOrder = nextCardOrder
  // 逐卡默认展开/收起：key 是折叠键（不是卡片键，合并卡两行共用一个），只认表里有的键
  const foldKeys = new Set(Object.values(CARD_FOLDS))
  const rawFolds = c.foldDefaults && typeof c.foldDefaults === 'object' && !Array.isArray(c.foldDefaults) ? c.foldDefaults : {}
  const nextFoldDefaults: Record<string, boolean> = {}
  for (const k of Object.keys(rawFolds)) {
    if (foldKeys.has(k) && typeof rawFolds[k] === 'boolean') nextFoldDefaults[k] = rawFolds[k]
  }
  cfg.foldDefaults = nextFoldDefaults
  cfg.foldRemember = c.foldRemember !== false
  // 推给已挂载的 useFold 实例。initial 只在首屏回填时为 true ——
  // 后续每次保存都会再走一遍 applyConfig，那时是用户真的改了默认值 / 关了记忆，要立刻生效
  setFoldPrefs({ remember: cfg.foldRemember, defaults: cfg.foldDefaults, initial: !foldPrefsReady })
  foldPrefsReady = true
  cfg.enterMode = c.enterMode === 'widget' || c.enterMode === 'settings' ? c.enterMode : 'both'
  cfg.dshNodeDir = typeof c.dshNodeDir === 'string' ? c.dshNodeDir : ''
  cfg.dshKeepAlive = c.dshKeepAlive === true
  cfg.dshElevated = c.dshElevated === true
  // 端口：宿主 store 的 normDshPort 已保证是 1–65535，这里的兜底只为「宿主没给这个键」的旧配置
  cfg.dshPort = typeof c.dshPort === 'number' && c.dshPort >= 1 && c.dshPort <= 65535 ? Math.round(c.dshPort) : DEFAULT_DSH_PORT
  cfg.dshRegistry = typeof c.dshRegistry === 'string' ? c.dshRegistry : ''
  cfg.dshVersion = typeof c.dshVersion === 'string' ? c.dshVersion : ''
  cfg.dshReinstall = c.dshReinstall === true
  cfg.dshNoOpen = c.dshNoOpen !== false
  cfg.dshOpenIn = c.dshOpenIn === 'builtin' ? 'builtin' : 'external'
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
  // 来源开关 + 两段顺序 + 自定义源清单。这里**必须整对象回填**（order / sources / customSources
  // 一个都不能漏）：AccelView 的来源顺序取自 props.cfg.ghAccelSrc.order、源表顺序取自 .sources、
  // 自定义源列表取自 .customSources，漏回填的话落盘后父级 cfg 不变，子组件拿到的 props 仍是旧值 ——
  // 表现就是「点了没反应」或「加一条后列表只剩一条」，而宿主侧读的也是这份 cfg
  const gs = c.ghAccelSrc && typeof c.ghAccelSrc === 'object' ? c.ghAccelSrc : {}
  cfg.ghAccelSrc = {
    doh: gs.doh !== false,
    community: gs.community !== false,
    manual: gs.manual !== false,
    sources: Array.isArray(gs.sources) ? gs.sources.filter((s: any) => typeof s === 'string') : [],
    order: Array.isArray(gs.order) ? gs.order.filter((s: any) => typeof s === 'string') : [],
    customSources: Array.isArray(gs.customSources) ? gs.customSources.filter((s: any) => typeof s === 'string') : [],
  }
  // 形象下载源前缀：宿主已归一化（非法串回空），这里只做类型兜底
  cfg.skinPackSrc = typeof c.skinPackSrc === 'string' ? c.skinPackSrc : ''
  // 内置形象是否参与随机：缺省 true（老配置没有该字段时按「参与」处理，与升级前一致）
  cfg.randomIncludeBuiltin = c.randomIncludeBuiltin !== false
  // 通知渠道：系统通知默认开（沿用旧行为）；邮件通知的服务器/授权码不在这里（走 secrets）
  cfg.notifySystemOn = c.notifySystemOn !== false
  cfg.notifyMailOn = c.notifyMailOn === true
  cfg.debugTools = c.debugTools === true
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
// 挂件可见性同步（宿主实时判定：窗口不存在 → false；存在但被 uTools 连带 hide → false）。
// ⚠️ 必须「反复同步」而不是挂载时读一次：插件进入时宿主是先让设置页挂载、再在 onPluginEnter
//    里 createBrowserWindow，挂载那一刻挂件窗口往往还没建出来 —— 一次性读取会永久停在 false，
//    按压气泡卡就会一直显示「挂件还没显示」、试播按钮永久灰掉（真机复现）。挂件也可能被
//    全局快捷键 / 挂件菜单 / uTools 主窗隐藏等方式改变显隐，本页收不到任何通知。
//    故与任务栏状态同频（2s）轮询，并在一键显示/隐藏时先乐观置位、由下一轮轮询校正。
function widgetVisibleSync() {
  widgetVisible.value = services.isWidgetVisible?.() !== false
}

// 任务栏状态每 2s 同步一次（immediate：启动时先同步一次，不必等第一个间隔）
const taskbarPolling = usePolling(() => { taskbarSync(); widgetVisibleSync() }, 2000, true)

// 宿主推送的配置变更订阅（挂件菜单改设置时，让本页开关同步）
let unsubConfig: (() => void) | undefined
// 卡片导航的统一入口，两个来源共用：
//   · 挂件菜单深链（宿主 emitNavigate）：'bubble' 切「外观」滚到按压气泡卡；
//     'focus' / 'usage' / 'models' / 'timer' 切「用量」滚到对应卡。
//   · 设置页内的跨卡链接（TimerView / FocusView 的 emit('go-card')）：与深链同名同语义。
// 订阅放父级（与 onConfigChange 同处），不放进 BubbleView / FocusView：
// 卡片是 v-if 渲染的（未激活 Tab 根本不挂载），订阅一旦跟着卡走就会「卡没渲染 = 收不到导航」。
// 切换 Tab 后卡片要等下一帧才进 DOM，scrollToCard 必须 nextTick 之后再调，否则 querySelector 落空
let unsubNavigate: (() => void) | undefined
function onBubbleNavigate(target: string) {
  if (target === 'bubble') {
    activeTab.value = 'look'
    clearSearch()
    nextTick(() => scrollToCard('bubbleCustom'))
    return
  }
  if (target === 'focus' || target === 'timer' || target === 'usage' || target === 'models') {
    activeTab.value = 'usage'
    clearSearch()
    nextTick(() => scrollToCard(target))
  }
}
// 本窗口重新可见/重新聚焦时刷新趋势（挂件刷新余额后账本可能已变）
function onWindowActive() {
  if (document.visibilityState === 'hidden') return
  refreshHistory()
  refreshTodayModels() // 模型占比是联网结果，回到本页时也刷新一次
  reloadModels() // 挂件会定时刷余额，回到本页时把最新快照取回来
  // 只在开发者 Tab 轮询着 dsh 状态时才需要补 deep 探测（可能在挂件菜单里启停过）
  if (activeTab.value === 'dev') { dshStatus(true); refreshStaleDevCards() }
  taskbarSync() // 顺带同步任务栏显隐状态
  widgetVisibleSync() // 挂件可能在挂件菜单 / 全局快捷键里被显示或隐藏
}

// 回到本窗口时，把**已读过但已过期**的开发者卡重读一遍（P5，2026-10-09）。
// 判据是「读过时间戳距今超过 DEV_STATS_STALE_MS」，只对**读本地快照**的卡生效。
// ⚠️ dshMarket 刻意排除：它的「加载目录」是出站 HTTP，绝不能因为用户切回窗口就偷偷发请求 ——
//    卡内本来就要求用户显式点按钮才抓（见 toggleDevCard 的注释），自动刷新会破坏这条约定。
// ⚠️ 只重读**曾经读过**的卡（时间戳非 0）：没读过说明用户还没展开过，本就不该预读（折叠 = 不预读）。
//    dshIsolate 重读时连 dshBackupRefresh 一起走，与 toggleDevCard 的配对一致（两张卡的摘要互相依赖）
function refreshStaleDevCards() {
  const now = Date.now()
  const stale = (k: string) => devStatsLoaded[k] > 0 && now - devStatsLoaded[k] > DEV_STATS_STALE_MS
  if (stale('dshUsage')) { markDevCardLoaded('dshUsage'); dshUsageRefresh() }
  if (stale('dshDump')) { markDevCardLoaded('dshDump'); dshDumpRefresh() }
  if (stale('dshExport')) { markDevCardLoaded('dshExport'); dshExportRefresh() }
  if (stale('dshIsolate')) { markDevCardLoaded('dshIsolate'); dshIsolateRefresh(); dshBackupRefresh() }
  // diagnoseRefresh 会顺带做一次宿主 deep 探测，开销比其余卡大（有 ping/端口探测），
  // 所以只在 dsh 状态轮询已经在跑（开发者 Tab）时才补 —— 这也正是本函数只在该分支被调的原因
  if (stale('diagnose')) { markDevCardLoaded('diagnose'); diagnoseRefresh() }
}

onMounted(() => {
  try {
    // ── 首帧关键路径：只做「轻量、必现」的同步读取 ──
    // 这些要么是纯内存读（配置/凭据/版本），要么决定首屏骨架（开关状态），必须同步拿。
    applyConfig(services.getConfig?.())
    try { bootIntroAutoPlayed.value = services.bootIntroHasPlayed?.() === true } catch (err) {}
    // 挂件菜单勾选/取消 → 宿主广播 → 刷新本页开关
    unsubConfig = services.onConfigChange?.(applyConfig)
    // 挂件菜单「气泡设置」→ 切到「外观」Tab 的按压气泡卡（宿主 emitNavigate，见 onBubbleNavigate）
    unsubNavigate = services.onNavigate?.(onBubbleNavigate)
    const s = services.getSecrets?.()
    if (s) {
      secrets.apiKey = s.apiKey || ''
      secrets.platformToken = s.platformToken || ''
    }
    // SMTP 凭据不在这里读：它已下沉到 NotifyView 内的 MailSettings.vue 自己 onMounted 读
    widgetVisibleSync() // 见 widgetVisibleSync 注释：此刻挂件窗口可能还没被宿主创建，靠轮询校正
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
  // 系统「减少动态效果」切换时同步暂停 / 恢复视频；视频本身在 syncBgVideo 后挂载
  bgReduceMotion?.addEventListener?.('change', onBgVideoMotionChange)
  // 浏览器默认自动播放策略会拦下静音视频；用户第一次点页面/按键时补一次 play
  document.addEventListener('pointerdown', onBgMediaGesture, { passive: true })
  document.addEventListener('keydown', onBgMediaGesture)
  // 设置页导航快捷键（Ctrl+1..7 / Ctrl+K / Alt+←→），弹层打开时自动让位
  window.addEventListener('keydown', onSettingsKeydown)
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
    // 判据在宿主侧（guideDone 未置位 + 没填 API Key），老用户升级上来不会被打扰。
    // 引导弹层优先：首启不叠启动片头，避免两层全屏遮罩互相抢焦点。
    let firstRun = false
    try { firstRun = services.needFirstRunGuide?.() === true } catch (err) {}
    if (firstRun) {
      // 首次引导优先：首帧可能已按「纯净片头」把设置页藏了，先放出来再弹引导
      bootIntroRevealPage()
      guideReopen.value = false
      guideSaved.value = false
      showGuide.value = true
    } else {
      maybePlayBootIntro()
    }
  })
})

onUnmounted(() => {
  try { unsubConfig?.() } catch (err) {}
  try { unsubNavigate?.() } catch (err) {}
  if (codexTickTimer) { window.clearInterval(codexTickTimer); codexTickTimer = 0 }
  taskbarPolling.stop()
  window.removeEventListener('focus', onWindowActive)
  document.removeEventListener('visibilitychange', onWindowActive)
  bgReduceMotion?.removeEventListener?.('change', onBgVideoMotionChange)
  document.removeEventListener('pointerdown', onBgMediaGesture)
  document.removeEventListener('keydown', onBgMediaGesture)
  window.removeEventListener('keydown', onSettingsKeydown)
  finishBootIntro()
  releaseBgVideo()
  releaseBgCustom()
})
</script>

<template>
  <div class="page">
    <!-- 内置视频壁纸：仅设置页，深浅色 / 未至之境都可用；层在内容之下并禁用命中。
         素材 CC BY-NC-SA 4.0（stushansusu），由设置页按需下载，不随包分发。 -->
    <div v-if="bgVideoUrl" class="bg-video-layer" :style="bgMediaStyle" aria-hidden="true">
      <video ref="bgVideoEl" class="bg-video-el" :src="bgVideoUrl" muted loop autoplay playsinline
             preload="auto" disablepictureinpicture @loadeddata="applyBgVideoMotion"
             @error="bgVideoError = '视频文件无法解码'"
             @play="bgVideoPaused = false" @playing="bgVideoPaused = false" @pause="bgVideoPaused = true"></video>
      <div class="bg-video-veil"></div>
      <div class="bg-video-scrim"></div>
    </div>
    <!-- 用户导入的背景媒体（图片 / 视频），与内置视频共用遮罩、模糊、亮度 -->
    <div v-if="bgCustomUrl" class="bg-custom-layer" :style="[bgMediaStyle, bgCustomZoomStyle]" aria-hidden="true">
      <video v-if="bgCustomKind === 'video'" ref="bgCustomEl" class="bg-custom-el" :src="bgCustomUrl"
             :style="bgCustomFrameStyle"
             muted loop autoplay playsinline preload="auto" disablepictureinpicture
             @loadeddata="applyBgCustomMotion" @error="bgCustomError = '视频文件无法解码'"
             @play="bgCustomPaused = false"
             @playing="bgCustomPaused = false" @pause="bgCustomPaused = true"></video>
      <img v-else ref="bgCustomImgEl" class="bg-custom-el" :src="bgCustomUrl" :style="bgCustomFrameStyle" alt="" />
      <div class="bg-custom-veil"></div>
      <div class="bg-custom-scrim"></div>
    </div>
    <h1>🐳 小鲸鱼余额挂件</h1>
    <p class="sub">桌面透明置顶小窗 · 显示 DeepSeek 余额</p>

    <!-- 顶部 Tab：一次只显示一组卡片；Ctrl+1..7 直达第 N 组、Alt+←/→ 切相邻组（见 onSettingsKeydown） -->
    <nav class="tab-bar" ref="tabBarEl" aria-label="设置分组">
      <div class="tab-row">
        <button v-for="(t, i) in visibleTabs" :key="t.key" type="button" class="tab"
                :class="{ 'tab-on': !searchActive && activeTab === t.key }"
                :aria-current="!searchActive && activeTab === t.key ? 'page' : undefined"
                :title="`${t.label}（快捷键 Ctrl+${i + 1}）`"
                @click="onTabClick(t.key)">{{ t.label }}</button>
        <!-- 自定义显示管理入口：齿轮 + 文字（纯图标用户看不出这是什么，历史反馈里被当成"设置"）
             放在 Tab 行末尾，与分组标签同一行，不额外占一行 -->
        <button type="button" class="display-manager-btn" @click="showDisplayManager = true" title="管理显示内容：隐藏分组 / 卡片、调整分组顺序">⚙ 显示管理</button>
      </div>
      <!-- 卡片搜索：输入即跨 Tab 过滤出命中的卡片（见 SEARCH_INDEX）。清空 / Esc 回到正常 Tab 视图；
           Ctrl+K 直接聚焦这里（不用先找输入框） -->
      <div class="search-row">
        <input ref="searchInputEl" class="search-input" type="search" v-model="searchQuery"
               placeholder="搜索设置项（如：穿透 / 音效 / 备份 / dsh）" title="聚焦搜索（Ctrl+K）"
               @keydown.esc="!isImeComposing($event) && clearSearch()" />
        <button v-if="searchActive" class="search-clear utils-btn utils-secondary" type="button" @click="clearSearch">清除</button>
      </div>
    </nav>

    <!-- 配置没保存上：整条常驻、可点重试。放在所有回执之前、且不跟随 Tab 切换消失 ——
         它描述的是「你刚才那下没落盘」，属全局状态，不该只在外观 Tab 才看得见 -->
    <p v-if="saveFail.msg" class="save-fail" role="alert">
      <span class="save-fail-text">{{ saveFail.msg }}</span>
      <button type="button" class="utils-btn utils-secondary save-fail-retry"
              :disabled="saveFail.retrying" @click="retrySaveCfg">{{ saveFail.retrying ? '正在重试…' : '重试' }}</button>
      <button type="button" class="link-btn save-fail-close" title="先不管（下次改设置失败会再出现）"
              @click="saveFail.msg = ''; saveFail.patch = null">忽略</button>
    </p>

    <!-- 置顶作用域（.pin-scope）：包住「Tab 描述 + 全部卡片」。它是卡片搬动的作用域 ——
         syncPinned() 只在这里面查卡片、搬节点，组外的东西一概不碰。
         置顶区标题也在这里：由 syncPinned() 搬到组首（搬的是卡片的根节点，不碰子组件内部）。 -->
    <div class="pin-scope" ref="pinScopeEl">
      <p class="tab-desc">
        <!-- 显示管理的回执优先占用这一行：隐藏当前分组后必须让用户看见"跳到哪去了"，
             否则只看到页面自己换了一组，像是点坏了 -->
        <span v-if="displayFlash.msg" :class="{ 'desc-err': displayFlash.err }">{{ displayFlash.msg }}</span>
        <template v-else-if="searchActive">
          {{ searchHits.length ? `找到 ${searchHits.length} 张卡片（跨分组）` : '没有匹配的卡片，换个关键词试试' }}
        </template>
        <template v-else>{{ activeTabDesc }}</template>
      </p>

      <!-- 搜索结果为空时的指引：搜索是跨组过滤，匹配不到任何卡的可见文本 -->
      <p v-if="searchActive && !searchHits.length" class="card search-empty">
        没找到含「{{ searchQuery.trim() }}」的卡片。搜索匹配卡片标题与关键词（含同义词），
        试试更短的词，如「形象」「用量」「通知」「hosts」。
      </p>
      <!-- 搜索态下每张命中卡标出「本来在哪一组」，点标签直接滚到那张卡（命中卡按索引顺序渲染、不带分组名会找不到北） -->
      <div v-if="searchActive && searchHits.length" class="search-hits">
        <button v-for="k in searchHits" :key="k" type="button" class="search-hit-tag" :class="{ hidden: isCardHidden(k) }" @click="isCardHidden(k) ? unhideCard(k) : scrollToCard(k)">
          {{ cardTabLabel(k) }} · {{ SEARCH_INDEX[k].label }}
          <span v-if="isCardHidden(k)" class="hidden-badge">（已隐藏）</span>
        </button>
      </div>

      <!-- 置顶区标题：位置由 CSS order 顶到置顶卡块之前（见 .pin-scope 的样式注释），
           不搬 DOM —— v-if 节点被搬离锚点会让 Vue 在切 Tab 时丢节点 -->
      <p v-if="!searchActive && pinnedInTab.length" class="pin-head">
        📌 置顶 · {{ pinnedInTab.map((k) => SEARCH_INDEX[k]?.label).join(' · ') }}
      </p>

    <!-- [数据] 凭据：填一次就不动，默认收起（展开状态见 credentialsFold.open） -->
    <section v-if="cardOn('data', 'credentials')" class="card" :class="cardCls('credentials')" data-search="credentials">
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="credentialsFold.open" @click="credentialsFold.open = !credentialsFold.open">
          {{ credentialsFold.open ? '收起凭据设置' : 'DeepSeek 凭据（API Key / 平台 Token）' }}
        </button>
        <div v-if="credentialsFold.open" class="guide">
          <label class="field">
            <span class="label">API Key</span>
            <input v-model="secrets.apiKey" type="password" placeholder="sk-..." autocomplete="off" />
          </label>
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="guides.apiKey" @click="guides.apiKey = !guides.apiKey">
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
            <p class="guide-meta"><strong>保存与安全：</strong>存于本机 uTools 加密存储，仅本插件可读、不上传；只随请求发往 <code>api.deepseek.com</code>，不写日志。长期有效，泄露可在平台删旧 key 换新。</p>
            <p class="guide-note">注意：这是接口密钥，不是「平台 Token」；请勿泄露。</p>
          </div>
          <label class="field">
            <span class="label">平台 Token <em>（可选，「实时·令牌」模式需要）</em></span>
            <input v-model="secrets.platformToken" type="password" placeholder="platform.deepseek.com 令牌" autocomplete="off" />
          </label>
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="guides.token" @click="guides.token = !guides.token">
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
            <p class="guide-meta"><strong>保存与安全：</strong>同 API Key，本机加密存储、不上传；只发往 <code>platform.deepseek.com</code>。属网页会话令牌，重登后可能失效，届时自动回落本地记账，重新复制即可。</p>
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

    <!-- [外观] 挂件外观 + 设置页视觉：两张可独立命中 / 置顶的卡在 LookView 内，
         故整个块不加 v-if，显隐逐卡按 cardOn('look', key) 判定（与 AssetsView 同款）
         挂件外观 = 大小 / 形象 / 气泡（主题 · 峰谷文案 · 开关）/ 音效（开关 · 音色 · 音量）。
         素材的「导入 / 删除 / 试听 / 素材包」都在「资源」页，这里只选「用哪个」——
         所以素材说明统一放在卡片开头一句，各设置项下面只留「当前用的是什么」的状态 -->
    <LookView v-if="cardOn('look', 'look') || cardOn('look', 'pageVisual')"
              :cfg="cfg"
              :card-on="cardOn"
              :pinned="pinnedCards"
              :search-active="searchActive"
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
              :builtin-sound-sets="BUILTIN_SOUND_FILES"
              :bg-media-paused="bgMediaPaused"
              :bg-media-is-video="bgMediaIsVideo"
              :bg-media-error="bgMediaError"
              :boot-intro-auto-played="bootIntroAutoPlayed"
              @patch="patchCfg"
              @scale-num-live="onScaleNumLive"
              @scale-commit="onScaleCommit"
              @random-skin="doRandomSkin"
              @toggle-include-builtin="onToggleIncludeBuiltin"
              @preview-builtin-sound="doPreviewBuiltinSound"
              @bg-video-updated="onBgVideoUpdated"
              @bg-media-play="playCurrentBgMedia"
              @bg-media-pause="pauseCurrentBgMedia"
              @bg-auto-tune="autoTuneBgMedia"
              @bg-tune="onBgTune"
              @preview-boot-intro="playBootIntroPreview"
              @boot-intro-clean-change="onBootIntroCleanChange"
              @open-system-animation-settings="openSystemAnimationSettings"
              @go-assets="goAssetsTab"
              @ui-mode-change="onUiModeChange" />

    <!-- [外观] 按压气泡（自定义泡泡）：点小鲸鱼时按顺序弹的泡泡队列。
         挂在「挂件外观」之下、与它同属 look 组（挂件菜单的「气泡设置」按钮按 target='bubble' 直达本卡）。
         卡内是独立整块（队列 + 泡 + 行 + 模块四层），故单独成组件，不塞进 LookView -->
    <BubbleView v-if="cardOn('look', 'bubbleCustom')"
                :class="cardCls('bubbleCustom')"
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
      :pinned="pinnedCards"
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
      :assets-busy="assetsBusy"
      :skin-import-busy="skinImportBusy"
      :media-refresh-tick="mediaRefreshTick"
      :shared-skin-thumb-data-url="sharedSkinThumbDataUrl"
      :builtin-skins="BUILTIN_SKINS"
      :legacy-builtin-skins="LEGACY_BUILTIN_SKINS"
      :shared-skin-pack-skins="SHARED_SKIN_PACK_SKINS"
      :browse-skins-tick="browseSkinsTick"
      @patch="patchCfg"
      @media-changed="onMediaChanged"
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
      @stop-preview="stopPreviewSound"
      @refresh-sounds="refreshSounds"
      @refresh-skin="refreshSkin"
      @refresh-bubbles="refreshBubbles"
    />

    <!-- [用量] 用量与账本：用量口径（记账 / 令牌）+ 趋势 + 明细 + 额度 + 校准。
         口径原先在「挂件行为」卡片里，与它影响的图表分家，现在挪到图表上方 -->
    <UsageView v-if="cardOn('usage', 'usage')" ref="usageViewRef"
               :class="cardCls('usage')"
               :cfg="cfg" :services="services"
               :usage-history="usageHistory" :usage-currency="usageCurrency"
               :fmt-money="fmtMoney" :hhmm="hhmm" :is-ime-composing="isImeComposing"
               :history-keep="HISTORY_KEEP" :price-model-max="PRICE_MODEL_MAX"
               :token-price-default="TOKEN_PRICE_DEFAULT"
               @patch="patchCfg" @usage-mode-change="onUsageModeChange"
               @token-price-change="onTokenPriceChange" @history-keep-change="onHistoryKeepChange"
               @refresh="refreshHistory" @add-price-model="addPriceModel"
               @remove-price-model="removePriceModel" />

    <!-- [用量] 多厂商模型：注册表存配置、余额存运行时快照；挂件菜单里可切换主显示的是哪一个。
         放在「提醒与通知」之前：查余额 / 切主显示是高频动作，提醒是低频配置 -->
    <ModelsView v-if="cardOn('usage', 'models')"
                :class="cardCls('models')"
                :services="services" :models="models" :model-configs="modelConfigs"
                :models-main-id="modelsMainId" :model-tpls="modelTpls" :model-max="modelMax"
                :low-alert-default="LOW_ALERT_DEFAULT"
                :fmt-tokens="fmtTokens" :codex-win-text="codexWinText"
                @reload="reloadModels" @update:main-id="onModelsMainChange" />

    <!-- [用量] 提醒与通知：四类自动提醒（峰谷切换 / 低余额 / 今日预算 / 余额大幅波动）+ 通知渠道 + 提醒文案。
         原先开关挤在「挂件行为」那张 106 行的卡里、文案挂在「外观 → 文案」卡里，调一类提醒要跳两个 Tab，
         现在按「提醒」这个主题收成一张卡，文案作为卡内折叠。计时类配置已迁到下面的「计时」卡，
         「到点怎么提示」（留言 / 系统通知 / 气泡停留 / 邮件）归本卡 —— 那是一类提醒，不是计时参数 -->
    <NotifyView v-if="cardOn('usage', 'notify')" ref="notifyViewRef"
                :class="cardCls('notify')"
                :cfg="cfg" :services="services" :usage-currency="usageCurrency"
                :alert-sound-roles="ALERT_SOUND_ROLES" :sound-role-label="SOUND_ROLE_LABEL"
                @patch="patchCfg" @save-alerts="onSaveAlerts" />

    <!-- [用量] 待办与计时：待办清单在前，计时默认值沉底。
         子块仍各自带 data-search，显示管理 / 搜索 / 置顶键不变 -->
    <section v-if="cardOn('usage', 'timer') || cardOn('usage', 'focus')"
             class="card focus-timer-card"
             :class="{ 'card-pinned': isPinned('timer') || isPinned('focus') }">
      <div class="card-head">
        <h2 class="card-toggle" @click="focusTimerFold.open = !focusTimerFold.open">
          <span class="caret">{{ focusTimerFold.open ? '▾' : '▸' }}</span>{{ cardOn('usage', 'focus') ? '待办与计时' : '计时' }}
          <span v-if="!focusTimerFold.open" class="card-sum">{{ cardOn('usage', 'focus') ? (cardOn('usage', 'timer') ? '待办清单 · 计时设置' : '待办清单') : '默认时长 · 快捷 · 休息与番茄' }}</span>
        </h2>
      </div>
      <template v-if="focusTimerFold.open">
      <p v-if="cardOn('usage', 'focus')" class="hint">待办可直接开始计时，也可挂提醒；计时默认值在下方「计时设置」里调。</p>
      <FocusView v-if="cardOn('usage', 'focus')" class="card-embedded"
                 :cfg="cfg" :services="services" :is-ime-composing="isImeComposing"
                 :search-active="searchActive"
                 @patch="patchCfg" />
      <TimerView v-if="cardOn('usage', 'timer')" class="card-embedded"
                 :cfg="cfg"
                 :timer-presets-default="TIMER_PRESETS_DEFAULT"
                 :search-active="searchActive"
                 @patch="patchCfg" />
      </template>
    </section>

    <!-- [用量] 下班倒计时：占气泡首行（标题行），余额 / 今日已用照常；关闭时首行回到报时 / 余额（余额 / 专注 / 计时不受影响） -->
    <OffworkView
      v-if="cardOn('usage', 'offwork')"
      :class="cardCls('offwork')"
      :cfg="cfg"
      @patch="patchCfg" />

    <!-- [窗口] 挂件窗口：显隐、位置与窗口属性（使用说明 / 故障排查已挪到「帮助」组）。
         模板已迁至 WindowView.vue：widgetFlash / 显隐 / 复位 / 复制指令 / 新增快捷键
         都写与「使用帮助」卡共用的消息槽，故仍留在父级，这里用 emit 触发 -->
    <WindowView
      v-if="cardOn('window', 'window')"
      :class="cardCls('window')"
      :cfg="cfg"
      :services="services"
      :taskbar-text="taskbarText"
      :widget-flash="widgetFlash"
      :widget-visible="widgetVisible"
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
      :class="cardCls('help')"
      :services="services"
      :err-detail="errDetail"
      :err-flash="errFlash"
      @copy-cmd="copyHotkeyCmd"
      @add-hotkey="addHotkey"
      @guide-reopen="onGuideReopen"
      @check-widget-error="checkWidgetError"
      @copy-widget-error="copyWidgetError"
    />

    <!-- [数据] 备份与恢复。原先折在「数据与隐私」卡的 .fold 里，但「数据」组 desc 一直把它
         当并列的第三张卡来写（「凭据设置 · 清除数据 · 备份与恢复」），搜索索引里也没提它 ——
         即 desc 承诺是卡、实际是别人卡里的折叠。提升为独立卡，三者对齐；也更好找。
         卡内内容原样搬来，交互与状态（backupFlash 等）不变。
         放在「清除数据」之前：备份 / 恢复比销毁性操作常用，破坏性卡片沉底。 -->
    <BackupView v-if="cardOn('data', 'backup')" :class="cardCls('backup')" :services="services" @applied="onBackupApplied" />

    <!-- [数据] 数据与隐私：按项清除 + 备份与恢复 -->
    <!-- [数据] 数据与隐私：模板已迁至 PrivacyView.vue。清除动作与勾选项内聚在组件内，
         清除成功后的回显刷新（secrets / cfg / 账本 / 各素材卡片）读父级全局状态，故用 emit('cleared') 交回 -->
    <PrivacyView
      v-if="cardOn('data', 'privacy')"
      :class="cardCls('privacy')"
      :services="services"
      @cleared="onDataCleared"
    />

    <!-- [开发者] DeepSeek Harness（dsh） -->
    <section v-if="cardOn('dev', 'dshMain')" class="card dsh-card" :class="cardCls('dshMain')" data-search="dshMain">
      <div class="card-head">
        <h2 class="card-toggle" @click="dshMainFold.open = !dshMainFold.open">
          <span class="caret">{{ dshMainFold.open ? '▾' : '▸' }}</span>DeepSeek Harness（dsh）
          <!-- 收起态摘要：状态本来就是启动后自动查的（不额外读盘），所以这里直接报，不像其他卡要等首次展开 -->
          <span v-if="!dshMainFold.open" class="card-sum">{{ dshStateText }}</span>
        </h2>
      </div>
      <template v-if="dshMainFold.open">
      <p class="hint">在挂件菜单「dsh」分组或本卡里启动 / 重启 / 结束 / 更新 dsh，并打开 Web UI（默认 <code>http://127.0.0.1:{{ DEFAULT_DSH_PORT }}</code>，端口见「高级选项」）。优先用全局安装，没有才装到插件目录。</p>

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
        <span class="label">进入开发者页自动刷新版本 <em>（每次切到本 Tab 重查 npm，约 1–3 秒；不勾用缓存）</em></span>
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
      <p v-if="dsh.external" class="hint">{{ dsh.port }} 上有<strong>别的终端</strong>启动的 dsh（pid {{ dsh.externalPid }}）：「结束」会结束它，「重启」会按当前版本重新启动。</p>
      <p v-else-if="dsh.portOther" class="hint">{{ dsh.port }} 被 {{ dsh.portOther }} 占用（不是 dsh），插件不会结束它，以免误杀。</p>

      <!-- 运行详情（只读）：版本对照 / 最近命令 / 页面地址 / 日志，展开时自动查一次最新版本。
           标题不叫「诊断信息」：「dsh 环境诊断」那张卡才是排查启动失败的检查项，
           两块都带「诊断」二字时用户分不清点哪个，这里本质是运行状态详情 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshFolds.versions" @click="dshToggleVersions">
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
              <p class="hint notes-trunc">这 {{ dshNotes.versions ? dshNotes.versions.length : 0 }} 个版本没有可显示的说明。</p>
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
            <span class="cmdline">{{ dsh.webUrl || ('http://127.0.0.1:' + dsh.port + '（未捕获 token，dsh 启动后自动获取）') }}</span>
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
            <button class="secondary utils-btn utils-secondary" :aria-expanded="dshLogOpen" @click="dshLogOpen = !dshLogOpen">{{ dshLogOpen ? '收起 dsh 日志' : '查看 dsh 日志' }}</button>
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
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshFolds.trouble" @click="dshToggleTrouble">{{ dshFolds.trouble ? '收起 dsh 故障排查' : 'dsh 故障排查' }}</button>
        <div v-if="dshFolds.trouble" class="guide">
          <p class="guide-use"><strong>结束 / 重启：</strong>也作用于别的终端启动的 dsh；端口被非 dsh 占用时拒绝执行，避免误杀。</p>
          <p class="guide-use"><strong>首次安装较慢：</strong>需下载约 500 个包，国内建议把「npm 注册源」改为淘宝镜像；状态行会显示已等待秒数。</p>
          <p class="guide-use"><strong>占用空间：</strong>「删除插件目录的 dsh」清掉插件装的那份（有全局安装时用不到）；「清理 npx 旧缓存」清掉 npx 缓存里的旧版本副本。</p>
          <p class="guide-use"><strong>装 / 卸 / 更新插件报错、或市场卡片刷不出来：</strong>多半是 profile 写锁残留 —— 进程被强杀时锁未释放，后续操作卡在等锁上（报错为 <code>timed out waiting for the writer lock</code>）。点下方按钮清理；仅在持锁进程已不存在时才清，锁被占用时会拒绝并说明原因。</p>
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
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshFolds.advanced" @click="dshFolds.advanced = !dshFolds.advanced">{{ dshFolds.advanced ? '收起高级选项' : '高级选项（端口 / 注册源 / Node 目录 / 行为）' }}</button>
        <div v-if="dshFolds.advanced" class="guide">
          <!-- 「dsh 版本」已移到上面的「更新版本」行：它是安装/更新的入参，属于动作的一部分；
               留在这里会让一次「装指定版本」横跨三个折叠区（运行详情查版本 → 这里选版本 → 上面点更新），
               而另外几项（端口 / 注册源 / Node 目录 / 行为）是设一次就不动的环境配置，才是名副其实的高级选项 -->
          <label class="field row">
            <span class="label">Web UI 端口 <em>（默认 3080，改后需重启 dsh）</em></span>
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
          <p class="hint">3080 <template v-if="IS_WIN">属 Windows/Hyper-V 动态端口段，被预留时</template><template v-else>若被其它程序占用</template> dsh 会启动失败（<code>EADDRINUSE</code>）。换 4080 等端口即可；非法值（0 或超出 1–65535）退回 3080。</p>
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
          <label class="field row">
            <span class="label">打开 Web UI 时用 <em>（只影响「打开 Web UI」弹在哪；内置浏览器打不开就选系统默认）</em></span>
            <select v-model="cfg.dshOpenIn" @change="patchCfg({ dshOpenIn: cfg.dshOpenIn })">
              <option value="builtin">uTools 内置浏览器（不跳出 uTools）</option>
              <option value="external">系统默认浏览器</option>
            </select>
          </label>
          <label class="field row check">
            <span class="label">启动时不自动打开浏览器 <em>（勾选后命令追加 --no-open，启动后点「打开 Web UI」查看）</em></span>
            <input type="checkbox" v-model="cfg.dshNoOpen" @change="patchCfg({ dshNoOpen: cfg.dshNoOpen })" />
          </label>
          <label class="field row check">
            <span class="label">更新前重新下载 <em>（先删插件目录里的那份再装；用全局那份时不生效）</em></span>
            <input type="checkbox" v-model="cfg.dshReinstall" @change="patchCfg({ dshReinstall: cfg.dshReinstall })" />
          </label>
          <label class="field row check">
            <span class="label">uTools 退出后保留 dsh <em>（不勾选＝退出时自动结束，避免占端口）</em></span>
            <input type="checkbox" v-model="cfg.dshKeepAlive" @change="patchCfg({ dshKeepAlive: cfg.dshKeepAlive })" />
          </label>
          <!-- 以管理员身份启动：只在 Windows 出现（非 Windows 没有 UAC，也没有 runas 这条路） -->
          <label v-if="IS_WIN" class="field row check">
            <span class="label">以管理员身份启动 <em>（给需要管理员权限的 dsh 插件用；改后需重启 dsh）</em></span>
            <input type="checkbox" v-model="cfg.dshElevated" @change="patchCfg({ dshElevated: cfg.dshElevated })" />
          </label>
          <p v-if="IS_WIN && cfg.dshElevated" class="hint">开启后<strong>每次启动都弹一次 UAC</strong>；点「否」回落为普通权限启动（不会半启动）。运行中无法就地提权，故以 runas 起新实例、旧实例退出。结束这种实例同样要管理员权限，会再弹一次 UAC；「重启 / 更新」等于两次弹窗。<span v-if="dsh.admin">当前 uTools 已是管理员，启动时不再弹。</span><br /><strong>uTools 退出时不会自动结束这种实例</strong>（免得退出流程被 UAC 卡住），它会继续运行并占用端口；下次提示「端口已被占用」时点「结束」手动清掉（同样弹 UAC）。<br />想完全免弹窗，可改用「以最高权限运行」的计划任务启动 dsh；思路、<code>schtasks</code> 参数、凭证风险与回滚见 <code>docs/guide-dsh-admin.md</code>（系统层配置，本插件不代为创建）。</p>
        </div>
      </div>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshFolds.help" @click="dshFolds.help = !dshFolds.help">{{ dshFolds.help ? '收起使用说明' : '使用说明' }}</button>
        <div v-if="dshFolds.help" class="guide">
          <p class="guide-use"><strong>启动：</strong>直接 <code>node &lt;那份 dsh&gt;/lib/bin.js web [--no-open]</code>（有全局用全局，否则用插件目录的），不经 npx，不会堆缓存副本。</p>
          <p class="guide-use"><strong>更新：</strong>结束 dsh → 重装「更新版本」里选定的版本（自动＝latest）→ 原本在跑就用新版重启；有全局安装时更新的是全局那份（<code>npm i -g</code>）。</p>
          <p class="guide-use"><strong>dsh 数据：</strong>工作目录为用户主目录，配置与数据由 dsh 自管（默认 <code>~/.dsh</code>），插件不改动。</p>
        </div>
      </div>
      </template>
    </section>
    <!-- [dsh] dsh 只读诊断：五项本地检查，纯只读、不改任何配置、不联网 -->
    <section v-if="cardOn('dev', 'dshDiagnose')" class="card dsh-card" :class="cardCls('dshDiagnose')" data-search="dshDiagnose">
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
        逐项检查 dsh 起不来 / preset 挂不上的常见原因（重复模块、patch 条目与语法、<code>settings.yaml</code>、端口归属）。
        <strong>只读本地文件，不改配置、不联网</strong>。标记：<code>[✓]</code> 正常 ·
        <code>[!]</code> 有隐患或未查出 · <code>[✗]</code> 确有问题。
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
          本轮未读到 dsh 环境信息（<code>profile</code> / <code>node_modules</code> 读取失败、宿主异常等），
          五项检查均未运行。<strong>红字为具体原因</strong>，修复后点「强制重跑」。
        </p>
      </template>

      <!-- dsh 未安装：给明确文案，不报错、不列检查项（D11） -->
      <template v-else-if="diagnose && !diagnose.env?.installed">
        <p class="hint">未检测到已安装的 dsh，无需诊断。先在「dsh」卡片启动一次（会自动下载安装），再回来点「重新诊断」。</p>
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

      </template>

      <!-- 说明放在三道分支之外：未安装 / 整轮失败时也能看到本卡在做什么 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="diagnoseFolds.help" @click="diagnoseFolds.help = !diagnoseFolds.help">{{ diagnoseFolds.help ? '收起说明' : '说明' }}</button>
        <div v-if="diagnoseFolds.help" class="guide">
          <!-- 与「配置转储」「插件开关」两张卡分工：这张只回答「哪里坏了」，
               转储卡回答「这个条目是谁改的」，插件开关卡负责动手改。
               判据与改进办法在各自卡里只讲一遍，这里只留指引，避免三处说法随时间漂移。 -->
          <p class="guide-use"><strong>本卡只诊断，不动手：</strong>回答「哪里坏了」，不改任何文件。查条目被谁改的用「dsh 配置转储」，要禁用插件用「dsh 插件开关」。</p>
          <p class="guide-use"><strong>重复模块：</strong>profile 的 <code>node_modules</code> 里出现与全局 dsh 树<strong>同版本</strong>的 <code>@deepseek-ai/*</code>（按包名 + 版本号判定，不看路径），cordis 会认成两份包，报 <code>prompt section "deployment:persona" is already registered</code>，所有 preset 挂载失败。每次升级全局 dsh 都可能复现。</p>
          <p class="guide-use"><strong>patch 条目：</strong><code>cordis.patch.yml</code> 里 <code>- id: X</code> 必须存在于组装树，否则报 <code>patch: entry "X" not found</code>。报错<strong>不一定是拼错</strong>：该 id 常由某个 bundle 内部 insert 出来，bundle 没装（或条目改名 / 被上游移除）也会报。先到「dsh 配置转储」的用户层列表确认它是否还在，再决定改 id 还是删 patch；未读转储时本项显示 <code>[!]</code>「无法判定」。</p>
          <p class="guide-use"><strong>dsh 端口：</strong>被非 dsh 进程占用时 dsh 起不来；已有 dsh 在跑则不必再启。个别系统查不出进程归属时显示 <code>[!]</code> 并附原因，属「未查出」，不是「有问题」。</p>
          <p class="guide-use"><strong>只读与缓存：</strong>不修改任何东西，也不写 dsh 文件。结果缓存 60 秒，「重新诊断」复用缓存；要抹掉缓存重跑点「强制重跑」。</p>
        </div>
      </div>
      </template>
    </section>
    <!-- [dsh] dsh 配置转储：一次 CLI 读取，摊开 patch 分层与生效/默认树差异，纯只读、不改配置、不联网 -->
    <section v-if="cardOn('dev', 'dshDump')" class="card dsh-card" :class="cardCls('dshDump')" data-search="dshDump">
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
        读出 dsh 实际组装用的配置树，分为<strong>分层</strong>（哪一层、改了几条）与<strong>生效树 vs 默认树差异</strong>，
        回答「条目是谁改的、默认长什么样」。一次 CLI 读取（<code>--dump-config</code> / <code>--dump-default-config</code>），
        <strong>只读、不改配置、不联网</strong>。
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
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshDumpFolds.layers" @click="dshDumpFolds.layers = !dshDumpFolds.layers">{{ dshDumpFolds.layers ? '收起分层' : '展开分层' }}（{{ dshDump.layers?.length || 0 }} 层）</button>
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
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshDumpFolds.diff" @click="dshDumpFolds.diff = !dshDumpFolds.diff">{{ dshDumpFolds.diff ? '收起差异' : '展开差异' }}</button>
          <div v-if="dshDumpFolds.diff">
            <p v-if="dshDump.diffError" class="hint">默认树读取失败，未能比对：{{ dshDump.diffError }}</p>
            <p v-else-if="dshDump.diff && !dshDump.diff.changedTotal && !dshDump.diff.addedTotal && !dshDump.diff.removedTotal" class="hint">生效树与默认树一致，无额外改动。</p>
            <template v-else-if="dshDump.diff">
              <p class="hint">改动 {{ dshDump.diff.changedTotal }} · 新增 {{ dshDump.diff.addedTotal }} · 移除 {{ dshDump.diff.removedTotal }}<template v-if="dshDump.diff.changed.length > 5">（下面列出前 5 条）</template></p>
              <p v-for="(e, i) in dshDump.diff.changed.slice(0, 5)" :key="'c' + i" class="diag-line diag-warn">
                <span class="diag-line-text">[{{ dshDumpDiffText('changed') }}] {{ dshDumpEntryLabel(e) }}</span>
                <span class="diag-hint">→ {{ dshDumpChangedNote(e) }}</span>
              </p>
              <template v-if="!dshDump.diff.changedTotal">
                <p class="hint">没有条目被用户层改过。</p>
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
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshDumpFolds.help" @click="dshDumpFolds.help = !dshDumpFolds.help">{{ dshDumpFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="dshDumpFolds.help" class="guide">
            <!-- 与「环境诊断」卡的分工：这张解释「谁改的 / 默认长什么样」，
                 诊断卡负责判「坏了没」。读一次转储同时给诊断卡提供 patch 判据，
                 这点在两边都要说清，否则用户不知道「诊断说无法判定」时该去哪。 -->
            <p class="guide-use"><strong>本卡解释「为什么」，不诊断也不改配置：</strong>回答「条目是谁改的、默认长什么样」。判断配置是否损坏用「dsh 环境诊断」，改插件开关用「dsh 插件开关」。</p>
            <p class="guide-use"><strong>为诊断卡提供判据：</strong>dsh 解析 patch 时会打印 <code>patch: entry "X" not found</code>。诊断卡的「patch 条目指向不存在的 id」读这里的缓存判定，未读转储时显示「无法判定」。先读转储再跑诊断，结果最准。</p>
            <p class="guide-use"><strong>分层怎么来的：</strong>每个分节头写明配置来自哪个包、被谁 patch 过。包名来源为<strong>包内层</strong>（bundle 自带 patch），<code>cordis.patch.yml</code> 的绝对路径为<strong>用户层</strong>（你自己写的），无来源为<strong>基线</strong>。用户层按「是否绝对路径」判定，改过 <code>$DSH_HOME</code> 也能认出。</p>
            <p class="guide-use"><strong>差异怎么比：</strong>生效树（<code>--dump-config</code>）与默认树（<code>--dump-default-config</code>）按条目 id 对齐，比包名、是否禁用、config 的<strong>字段名</strong>。patch 整条替换，同 id 后出现的分节覆盖先出现的，这里按同规则合并。</p>
            <p class="guide-use"><strong>看不到 config 的值：</strong>config 可能带密钥，转储与「复制」都只留字段名、不留值。</p>
            <p class="guide-use"><strong><code>!!js</code> 表达式：</strong>形如 <code>disabled: !!js '...'</code> 的条目需 cordis 上下文求值，静态解析不到，一律标注「已禁用」，不代表真的禁用。</p>
            <p class="guide-use"><strong>只读与缓存：</strong>只跑 <code>bin.js</code> 的 dump 子命令，不写 dsh 文件；子进程 8 秒超时，结果缓存 60 秒，「重新读取」复用缓存；要重跑点「强制重跑」。</p>
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
    <section v-if="cardOn('dev', 'dshExport')" class="card dsh-card" :class="cardCls('dshExport')" data-search="dshExport">
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
          把整个 <code>$DSH_HOME</code> 打包为 <code>.zip</code>（含 <code>profiles/</code> 下的
          patch、插件、会话记录），用于<strong>换机</strong>或存档。
          包内附 <code>whale-dsh-export.json</code> 清单，写明导出时间、来源目录与跳过项。
        </p>
        <p class="hint">
          与「dsh 插件开关」里的<strong>快照</strong>不同：快照只备 3 个文件、用于还原 patch；
          这里是全量搬运，<strong>不解析包内容、不负责还原</strong>。
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
            ⚠️ dsh <strong>正在运行</strong><template v-if="dshExportInfo.running.pid">（pid {{ dshExportInfo.running.pid }}）</template>。
            建议先退出再导出：会话记录<strong>边写边存</strong>，运行中可能取到写了一半的记录，
            配置也可能处于修改中间态。<strong>不退出也能导，但不保证是某一时刻的完整快照。</strong>
          </p>
          <p v-else-if="dshExportInfo.running && dshExportInfo.running.other" class="hint">
            端口 {{ dshExportInfo.running.other }} 被其他程序占用（不是 dsh，不影响导出）。
          </p>
          <!-- running 为 null = 探测没拿到结果。不谎报「没在跑」，明说判不出来 -->
          <p v-else-if="dshExportInfo.running === null" class="hint">
            未能确认 dsh 是否在运行；若正开着，建议先退出再导出。
          </p>

          <label class="field row">
            <span class="label">包含凭据</span>
            <input type="checkbox" :checked="cfg.dshExportCred" @change="dshExportSetCred(($event.target as HTMLInputElement).checked)" />
            <span class="hint">
              默认不带。<code>.credentials.yaml</code> 等在包内是<strong>明文</strong>，
              仅迁移登录态时勾选；勾了勿外传或上传网盘。
            </span>
          </label>
          <label class="field row">
            <span class="label">跳过依赖</span>
            <input type="checkbox" :checked="cfg.dshExportNoMod" @change="dshExportSetNoMod(($event.target as HTMLInputElement).checked)" />
            <span class="hint">
              默认跳过 <code>node_modules</code>（可重装，体积是配置的几十倍）；
              取消会显著增大体积与耗时。
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
            请先清理 <code>$DSH_HOME</code> 下的会话记录。
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
    <section v-if="cardOn('dev', 'dshUsage')" class="card dsh-card" :class="cardCls('dshUsage')" data-search="dshUsage">
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
        读 dsh 写在 <code>~/.dsh</code>（或 <code>$DSH_HOME</code>）下的用量数据，
        <strong>纯本地、无需 API Key、不联网</strong>。优先用 dsh-usage 的按天账本，
        未落盘时回落到会话投影缓存。
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
          <div v-if="dshUsage.balance" class="stat-cell" title="dsh-usage 抓的余额快照，可与挂件余额互证">
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
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshUsageFolds.help" @click="dshUsageFolds.help = !dshUsageFolds.help">{{ dshUsageFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="dshUsageFolds.help" class="guide">
            <p class="guide-use"><strong>数据来源：</strong>优先读 <code>dsh-usage/usage-ledger.json</code>（按天账本，可画趋势）；无数据时回落到 <code>storages/session_projcache/sessions/*.json</code>，按「会话创建日」把全部用量记在一天。两者不叠加，避免重复计算。</p>
            <p class="guide-use"><strong>花费：</strong>账本 <code>cost</code> 仅 DeepSeek 官方档有值（人民币），其它 provider 未定价恒为 0，不会混币种。</p>
            <p class="guide-use"><strong>轮次：</strong>账本统计 LLM 调用次数，会话缓存统计对话轮次，单位不同，已在上方标出。</p>
            <p class="guide-use"><strong>缓存：</strong>按缓存文件的 size/mtime 判断变化，只重新解析变过的。缓存仅含聚合数与文件指纹，<strong>不含凭据</strong>。</p>
            <p class="guide-use"><strong>读不到数据：</strong>账本由 dsh-usage / cost-meter 这类插件写入，装好并跑过几轮对话后才有数据；也可点「清除缓存并重扫」强制重读。</p>
          </div>
        </div>
      </template>
      </template>
    </section>
    <!-- [dsh] 插件开关 / 批量隔离（E2 + E3 合并卡）
         合并理由：两卡改的是**同一个文件、同一个 profile、同一套快照**，差别只在粒度与候选范围。
         而候选范围不一致是会让人迷路的 —— E2 只列 patch 里已有的 12 条，用户想禁的第三方插件
         往往不在其中，在 E2 卡里根本找不到，得切到 E3 卡才行，而 E2 卡完全没提示这一点。 -->
    <section v-if="cardOn('dev', 'dshIsolate')" class="card dsh-card" :class="cardCls('dshIsolate')" data-search="dshIsolate">
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
          行尾按钮<strong>逐条</strong>即时改；或勾选后点「预览改动」→「确认隔离」<strong>批量改</strong>。
          <strong>未勾选的条目不会改动</strong> —— 批量那侧的「隔离」不是「全部禁用」。
        </p>
        <p class="hint">
          ⚠️ 候选 = <strong>patch 里已有的条目</strong> ∪ <strong>组装树里读到的插件</strong>。
          后者写进去等于<strong>新加</strong>一条 patch，带前端界面的插件这样禁不掉
          （加载入口在 <code>package.json</code> 的 <code>dependencies</code> 里）；
          纯服务端插件（cost-meter / modlens / mnemon 等）才可靠生效。
          <br>⚠️ <strong>写入前强制建快照</strong>，建不出来就中止，不会改完无法回滚。
          <br>⚠️ <strong>启用需重启</strong>：patch 热重载是<strong>单向</strong>的 —— 加 <code>disabled</code> 即时生效，
          但<strong>删掉不恢复</strong>，所以「启用」后要重启 dsh。
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
            没有可隔离的候选：patch 里还没有条目，也未从组装树读到插件。
          </p>

          <template v-else>
            <div class="fold">
              <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshIsolateFolds.list" @click="dshIsolateFolds.list = !dshIsolateFolds.list">
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
              ⚠️ 已勾 <strong>{{ dshIsolatePicked.size }}</strong> 条，超过单次上限
              <strong>{{ DSH_ISOLATE_MAX_BATCH }}</strong> 条，点「预览改动」会被拦下。
              先点「只选启用中的」缩小范围；已禁用的无需再禁。
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
                        <span v-if="it.expression" class="patch-tag" title="启用状态由 !!js 表达式决定，市场不会覆盖它">表达式</span>
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
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshBackupFolds.list" @click="dshBackupToggleList()">
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
                <span class="hint bak-keep-note">「已知良好」与手动命名的备份不计入此数</span>
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
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshIsolateFolds.help" @click="dshIsolateFolds.help = !dshIsolateFolds.help">{{ dshIsolateFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="dshIsolateFolds.help" class="guide">
            <p class="guide-use"><strong>清单为何有 200 多条：</strong>候选 = <strong>patch 里已有的条目</strong> ∪ <strong>组装树里读到的插件</strong>。只列前者会让你想禁的第三方插件找不到入口；后者写进去等于<strong>新加</strong>一条 patch。实测常有 200 条以上，用上方分组轴收窄。</p>
            <p class="guide-use"><strong>候选为何读组装树：</strong>写入<strong>不存在的 id</strong> 时，dsh 只在 stderr 打一行 <code>patch: entry "X" not found</code>、退出码 0、启动照常，即「写坏了不报错」。所以候选取真实存在的条目，让你<strong>勾不到拼错的 id</strong>；读不到组装树时降级为只有 patch 条目。</p>
            <p class="guide-use"><strong>禁用怎么写：</strong>已有条目只改该行的 <code>disabled</code>；没有就在文件末尾追加 <code>- id: X</code> + <code>disabled: true</code>（后者覆盖前者，末尾优先级最高）。整份文件<strong>不重新序列化</strong>，注释、引号风格、键顺序原样保留。</p>
            <p class="guide-use"><strong>单条与批量：</strong>行尾按钮立即写入一条；「预览改动」是 <strong>dryRun</strong>，只算不写，确认后才写。批量改多条时行号会顺延，故<strong>从后往前</strong>改、<strong>一次写盘</strong>，不会半截写入。</p>
            <p class="guide-use"><strong>「隔离」不是「全禁」：</strong>只操作<strong>显式勾选</strong>的条目，改动范围可追溯到一份真实读到的清单。</p>
            <p class="guide-use"><strong>一次最多写 100 条：</strong>超过会被拦下并提示缩小范围（点「只选启用中的」最快）。<strong>是拒绝，不是分批</strong>，不会出现「以为全禁、其实只写前 100 条」的静默失效。</p>
            <p class="guide-use"><strong>三个分组轴：</strong>「按来源」看这条属于谁（你的 patch / 第三方插件 / dsh 官方框架），「按启用状态」看现在开没开，「按来源+状态」叠起来看。官方框架默认折叠，避免淹没要操作的插件。</p>
            <p class="guide-use"><strong>「状态未知」：</strong>宿主没读到该条目的 dump 状态（组装树读取降级）时显示<strong>黄色虚线</strong>，不标成「启用中」；「只选启用中的」也只勾<strong>确定</strong>的条目。</p>
            <p class="guide-use"><strong>已禁用的条目：</strong>勾了也不重复写，计划里标「已是禁用（不动）」，回执说「改了 N 条」而非「N 条已隔离」。</p>
            <p class="guide-use"><strong>为什么每次备份：</strong>dsh 对写坏的 patch <strong>不报错</strong>，所以写完<strong>回读磁盘校验</strong>，改动前必建快照：宁可不让改，也不能改完不可撤销。</p>
            <p class="guide-use"><strong>还原是整文件覆盖：</strong>热重载单向（删行不恢复），只有让文件回到改动前的完整内容才有效。代价是<strong>会一并回退这份文件上的其他改动</strong>。快照<strong>绝不包含</strong> <code>.credentials.yaml</code> 等凭据。</p>
          </div>
        </div>
      </template>
    </section>
    <!-- [dsh] dsh 插件市场：浏览/搜索/筛选官方目录并安装插件。
         ⚠️ 本 Tab 里**唯一会联网**的卡 —— 其余卡都在 hint 里写明「不发网络请求」，
         所以这张反过来必须显式声明会联网，且**默认一个请求都不发**：
         展开只读一次本地已装状态，要点「进入市场」+「加载目录」才出站（见 dshMarketRevealed）。
         联网警示在「进入市场」前后各留一份（文案不同）—— 出站点在后面，不能只在入口说一次。 -->
    <section v-if="cardOn('dev', 'dshMarket')" class="card dsh-card" :class="cardCls('dshMarket')" data-search="dshMarket">
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
        ⚠️ <strong>本卡会联网</strong>（其余卡片只读本地文件）：点「加载目录」才出站，
        之前只读本地已装状态。
      </p>

      <!-- 已装包清单：「卸载」的兜底入口。
           ⚠️ 为什么放在 **dshMarketRevealed 之前**（即「进入市场」之前）：这份清单是**纯本地**的
              （读 profile/package.json + patch），与联网、与目录加载全都无关。
              放在「进入市场」之后等于要求用户先点一次「进入市场」才看得到卸载入口 ——
              而多数人根本不进市场，盲区照旧。位置也就在「加载目录」那句提示之前。
           ⚠️ 为什么必须独立于目录列表：目录列表只渲染 catalog 里的条目，而「已装」是 profile 的
              事实 —— 已装但不在目录里、或 install 字段认不出的包，在目录列表里永远找不到行。
              这里直接列 installed 表，把两类盲区一次补齐。 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="!dshMarketInstalledFold" @click="dshMarketInstalledFold = !dshMarketInstalledFold">已装包（{{ dshMarketInstalledSummary }}）</button>
        <!-- 刷新入口跟着「已装包」一起常显：读取失败时 dshMarketStatus 为 null，原先只挂在市场区的那个按钮根本不渲染 -->
        <button class="link-btn utils-btn utils-secondary" style="margin-left: 8px" :disabled="dshMarketStatusBusy" @click="dshMarketRefreshStatus()">{{ dshMarketStatusBusy ? '读取中…' : '刷新已装状态' }}</button>
        <div v-if="dshMarketStatus && !dshMarketInstalledFold && dshMarketInstalledList.length" class="patch-list">
          <p class="hint">
            从 <code>profile/package.json</code> 与 patch 直读的<strong>真实已装状态</strong>，
            与目录是否加载无关。<strong>「停用」只写 patch（包留磁盘）</strong>；
            <strong>「彻底删除」</strong>才 <code>pnpm remove</code>。
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
            <span v-else class="patch-tag" title="patch 里没有这一条，只能删包，不能只停用">无 patch 条目</span>
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
              title="从 profile 彻底删掉这个包（pnpm remove），只删该包名，不做依赖反查"
              @click="dshMarketPreviewUninstall({ spec: '', npm: row.key, name: row.key } as DshMarketPlugin, true)"
            >彻底删除</button>
          </div>
        </div>
        <p v-else-if="!dshMarketInstalledFold" class="hint">还没读到已装包：本地 profile 可能尚未生成，或读取失败。点「刷新已装状态」重试。</p>
      </div>

      <template v-if="dshMarketRevealed">
      <!-- 来源设置整块收进折叠：默认只留「加载目录」按钮，想调源才展开。
           两段来源说明（竞速机制 + 设置不触发抓取）合并成一段放进折叠里 ——
           说明与设置放一起，展开就看到全部上下文，不用回到上面找。 -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshMarketFolds.source" @click="dshMarketFolds.source = !dshMarketFolds.source">
          {{ dshMarketFolds.source ? '收起来源设置' : '来源设置' }}（{{ dshMarketSourceShort }}）
        </button>
        <div v-if="dshMarketFolds.source" class="guide">
          <p class="hint">
            ⚡ <strong>多源并发竞速，先到先用</strong>，其余立即取消。官方源 4.37MB 实测 52–99 秒（常连不上），
            npm 镜像 1.09MB、0.2–0.7 秒，<strong>内容同源</strong>，故官方源默认关闭；勾上只多占一条连接。
            下方单选只改偏好、<strong>不触发抓取</strong>；先「测速」再「用最快的」可选出当前最快源。
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
        <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshMarketFolds.install" @click="dshMarketFolds.install = !dshMarketFolds.install">
          {{ dshMarketFolds.install ? '收起安装说明' : '安装说明' }}（快照 + 回读校验；装完需重启 dsh）
        </button>
        <div v-if="dshMarketFolds.install" class="guide">
          <p class="hint">
            ⚠️ 安装走 <code>pnpm add --dir &lt;profiles/{{ dshPatchProfile }}&gt;</code> 写入 profile 的
            <code>package.json</code>。<strong>写入前强制建快照，装完回读校验</strong>（dsh 对写坏的配置不报错，不能只信 pnpm 退出码）。
          </p>
          <p class="hint">
            ⚠️ 装完 / 停用后 <strong>需重启 dsh 才生效</strong>；不会自动重启（会中断正在跑的会话），
            请点「重启 dsh」。
          </p>
        </div>
      </div>
      <div class="btn-row">
        <button class="utils-btn utils-primary" :disabled="dshMarketBusy" @click="dshMarketLoad(false)">{{ dshMarketBusy ? '加载中…' : (dshMarket ? '刷新目录' : '加载目录') }}</button>
        <button class="secondary utils-btn utils-secondary" :disabled="dshMarketBusy" @click="dshMarketLoad(true)">强制重抓</button>
        <button class="secondary utils-btn utils-secondary" @click="dshRestartNow()">重启 dsh</button>
      </div>
      <p v-if="dshMarketFlash.msg" class="msg" :class="msgCls(dshMarketFlash)">{{ dshMarketFlash.msg }}</p>

      <!-- 瞬时失败（网络抖动 / 拉取超时）：宿主已自动重试过一次仍失败，这里给用户一次手动再试。
           ⚠️ 与下面的 allowBuilds 引导互斥（宿主侧已保证不会同时出现）—— 那条要用户改配置，
               这条什么都别改，直接再点一次。两个指引同时在屏幕上会让人不知道该听谁的。 -->
      <template v-if="dshMarketRetry">
        <p class="hint">
          这次失败像<strong>瞬时问题</strong>（网络抖动或拉取超时），不是配置错误，已自动重试一次仍未成功。
          稍等后直接再试即可，无需改配置。
        </p>
        <div class="btn-row">
          <button class="utils-btn utils-primary" :disabled="dshMarketBusy" @click="dshMarketRetryNow()">{{ dshMarketBusy ? '处理中…' : '重试一次' }}</button>
          <button class="secondary utils-btn utils-secondary" :disabled="dshMarketBusy" @click="dshMarketRetry = null">知道了</button>
        </div>
      </template>

      <!-- pnpm 构建拦截的引导（只在本卡出现过一次 allowBuilds 失败后显示）。
           ⚠️ 为什么不能自动帮用户写：那把 key 带 commit hash，只有在 dsh 报错时才出现；
              而且它是 pnpm 的**安全机制**（阻止来源不明的包在安装时跑构建脚本），
              替用户静默放行等于把这个机制废掉。所以这里只把原文和位置摆清楚，写由用户决定。 -->
      <template v-if="dshMarketAllowBuilds">
        <p class="hint">
          ⚠️ <strong>pnpm 拦下了构建脚本</strong>：<code>{{ dshMarketAllowBuilds.name || dshMarketAllowBuilds.spec }}</code>
          靠 <code>prepare</code> 在安装时构建，pnpm 默认不放行。这不是失败，是安全机制，显式允许后再装一次。
        </p>
        <p class="hint">
          把这行加进 <code>{{ dshMarketAllowBuilds.file }}</code> 的 <code>allowBuilds:</code> 下（缩进与已有条目一致），保存后重装：
        </p>
        <p class="hint"><code>{{ dshMarketAllowBuilds.key }}: true</code></p>
        <p class="hint">
          ⚠️ 放行后该包安装时<strong>可执行任意脚本</strong>，先确认来源可信。key 带 commit hash，<strong>装前无法预知</strong>，
          这类插件注定先失败一次。
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
      <p v-if="!dshMarketLoaded" class="hint">点「加载目录」抓取插件清单（默认 npm 镜像，约 1MB；首次约 1 秒，60 秒内复用缓存）。</p>

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
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshMarketFolds.filters" @click="dshMarketFolds.filters = !dshMarketFolds.filters">
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
            <p v-if="!dshMarketStatus" class="hint">还没读到本地已装状态，「已装 / 未装」暂不过滤（读不到就不冒充未安装）。</p>
          </div>
        </div>

        <!-- 空态：把「筛掉的原因」说清楚，并带上全量条数 —— 只说「没有符合条件」
             会让人怀疑是目录没加载好，而不是自己筛得太窄 -->
        <p v-if="!dshMarketList.length" class="hint">
          没有符合条件的插件（目录共 {{ dshMarket.count || dshMarket.plugins?.length || 0 }} 条）。
          换个关键词，或将「分类 / 范围」放宽到「全部」。
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
            <span class="mkt-latest-scope">本页 {{ dshMarketLatestTargets.length }} 个可查（仅 npm 来源）· 会联网</span>
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
                <!-- 纯依赖（不是 dsh 插件）：市场更新通道装不了它（宿主 not-bundle 会回滚）。
                     标出来是为了回答「为什么它明明落后却没有『可更新』」—— 不标的话用户只会
                     以为市场漏判了，然后去点更新、白折腾一次。悬停给出版本差与处置建议 -->
                <span v-if="dshMarketPlainDep(p)" class="patch-tag" :title="dshMarketPlainDepTip(p)">普通依赖·不可更新</span>
                <span v-if="dshMarketHitAt(p)?.disabled" class="patch-state state-off">已禁用</span>
                <span v-else-if="dshMarketHitAt(p)?.inDeps && !dshMarketHitAt(p)?.inPatch" class="patch-state state-unknown">包在磁盘，未写 patch</span>
                <!-- ⚠️ 「需构建」与「不认识」是两回事，必须分开说：
                     前者有按钮（装一次、按引导加 allowBuilds 再装一次就能成），
                     后者连按钮都不给（我们不知道拿什么去装，点了必然失败） -->
                <span v-if="p.needsBuild" class="patch-tag" title="该来源靠 prepare 在安装时构建，pnpm 默认拦截">需构建</span>
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
                  title="从 npm 拉 manifest，检查其声明的 DSH 版本范围是否包含当前 DSH"
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
                <!-- 目录没给主页时，用安装 spec 反推出的仓库地址兜底；主页指向的又恰好是同一个仓库时不再重复 -->
                <a
                  v-else-if="p.sourceWeb"
                  class="link-btn utils-btn utils-secondary"
                  href="#"
                  :title="p.sourceWeb"
                  @click.prevent="openDoc(p.sourceWeb)"
                >源码</a>
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
                它声明的 DSH 版本范围容不下当前宿主（要求见上方提示）。pnpm 安装不会报错，
                但 dsh 加载插件时才核这条声明 —— 失败通常只写进 dsh 日志、界面不显示，
                看起来像插件本身坏了。
              </p>
              <p v-else class="mkt-plan-warn-body">
                写入会照常完成。若之后加载失败或行为异常，<strong>先回滚快照</strong>；
                想真正用上它，需把 DSH 升到要求的版本再装。
              </p>
              <p class="mkt-plan-warn-body">
                动手前自动建快照，失败可回滚 —— 但「装上用不了」这件事，快照救不了。
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
                <li>连带更新 <code>pnpm-lock.yaml</code>（旧版本被替换）</li>
                <li v-if="dshMarketPlan.needsBuild">该来源靠 <code>prepare</code> 构建，pnpm 默认会拦一次</li>
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
                <li>连带更新 <code>pnpm-lock.yaml</code>（「更新」与「装这一版」都会改写 lock）</li>
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
                <span v-else class="hint">尚未产生：宿主还没到起 pnpm 那一步（见下方「实时输出」）</span>
              </p>
              <p class="mkt-progress-k">实时输出</p>
              <pre v-if="dshMarketLogTail" ref="dshMarketLogEl" class="mkt-progress-log">{{ dshMarketLogTail }}</pre>
              <pre v-else class="mkt-progress-log mkt-progress-log-empty">（暂无输出。带构建的来源需先 clone 再 prepare，首次较慢）</pre>
              <p class="hint">
                完整日志见上方「运行详情」→「查看 dsh 日志」（此处只显示最后 {{ DSH_MARKET_TAIL_LINES }} 行）。
                关页不会中断 pnpm（由宿主托管），但会看不到结果。
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
          <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="dshMarketFolds.help" @click="dshMarketFolds.help = !dshMarketFolds.help">{{ dshMarketFolds.help ? '收起说明' : '说明' }}</button>
          <div v-if="dshMarketFolds.help" class="guide">
            <p class="guide-use"><strong>目录从哪来：</strong>默认走 npm 镜像（<code>registry.npmmirror.com</code> 的 <code>dsh-plugin-catalog</code>，与官方同源，仅 1.09MB）。勾「官方源」会让 <code>awesome-dsh-plugin.com/plugins.json</code>（4.37MB）参赛。多源<strong>并发竞速、先到先用</strong>；全挂则用本地副本并标「可能已过期」。自定义 URL 优先于镜像。</p>
            <p class="guide-use"><strong>为什么默认不联网：</strong>本 Tab 其余卡展开即读本地，唯独这张发 HTTP。所以展开只读已装状态，点「进入市场」→「加载目录」才抓取；来源单选只改偏好。</p>
            <p class="guide-use"><strong>安装用什么 spec：</strong>用目录条目的 <code>install</code> 字段（目录作者原话）剥出 spec 安装，<strong>不按 <code>npm</code> 字段拼</strong>：4183 条里 2033 条（48.6%）<code>npm</code> 为 null，实为 <code>github:owner/repo</code> 或远端 <code>.tgz</code>，只认 npm 名等于判死近一半。三种形态：裸包名、<code>github:owner/repo</code>、<code>https://…/x.tgz</code>；认不出时<strong>不给安装按钮</strong>。</p>
            <p class="guide-use"><strong>「需构建」是什么：</strong>github / tarball 来源靠 <code>prepare</code> 在安装时构建，pnpm 默认拦截（防止不明来源的包执行代码）。报错给出带 commit hash 的 key，需写进 profile 的 <code>pnpm-workspace.yaml</code> → <code>allowBuilds</code>。<strong>装前拿不到 key</strong>，注定先失败一次；<strong>不会替你放行</strong>，那等于废掉该机制。</p>
            <p class="guide-use"><strong>停用 vs 卸载：</strong>「停用」只往 patch 写 <code>disabled: true</code>，包留磁盘，随时改回；「卸载 / 彻底删除」跑 <code>npm uninstall</code>。<strong>只删你点的这个包名</strong>，不做依赖反查，以免连带删掉共用依赖。</p>
            <p class="guide-use"><strong>停用为什么用短名：</strong>patch 条目 id 常是去掉 <code>@scope/</code> 的短名，目录给的是完整包名。用完整名追加等于新加一条指向不存在插件的条目，dsh <strong>不报错</strong>，只静默失效。故先用完整名对，对不上再用短名兜。</p>
            <p class="guide-use"><strong>缓存两层：</strong>内存 60 秒（挡反复刷新）+ 本地存储做离线兜底。「强制重抓」绕开内存缓存重新请求；改来源后也会自动重抓。</p>
          </div>
        </div>
      </template>

      </template>
      </template>
    </section>
    <!-- [dsh] Codex 本地会话统计：读 ~/.codex/sessions 的 rollout JSONL，纯本地、不联网。
         上方 7 张卡都属于 dsh，这张不是 —— 用一条纯分界线隔开即可，不写字：
         写字会和紧邻的卡标题「Codex 会话统计」重复，反而更啰嗦。
         用户在「管理显示内容」里给开发者 Tab 拖过卡片顺序后就不再画这条线：
         它代表「dsh 组 / 非 dsh 组」的固定分组，一旦卡片被自由重排，这层分组已不存在，
         留着会变成一条夹在任意两张卡之间的野生横线。 -->
    <hr v-if="!searchActive && activeTab === 'dev' && !(cfg.cardOrder.dev || []).length" class="group-sep">
    <!-- [dsh] Codex 本地会话统计：模板已迁至 CodexView.vue。父级用一条 hr.group-sep 隔开
         （依赖 searchActive / activeTab，留父级）。fmtTokens / codexWinText / codexDayLabel
         与图表档位仍留父级（跨卡共享），按 props 下传；本卡是否有窗口数据经 emit('windows') 上抛，
         并入父级的倒计时心跳 codexTickNeed。 -->
    <CodexView
      v-if="cardOn('dev', 'codex')"
      :class="cardCls('codex')"
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
      :class="cardCls('about')"
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
      :class="cardCls('ghAccel')"
      :cfg="cfg"
      :services="services"
      :active-tab="activeTab"
      @patch="patchCfg"
    />
    <!-- 调试工具：不注册成卡片（否则会出现在「管理显示内容」与搜索结果里，违背「生产 UI 不出现」）。
         只在「开发者」Tab、非搜索态、**且运行在 uTools 开发模式**下渲染；入口本身还要 config.debugTools 打开才显示。
         三条只读自检各自一行、结论就地写在行内；「演练提醒」只投递不写幂等位，「注入旧数据」会真写入。 -->
    <DevView
      v-if="devMode && !searchActive && activeTab === 'dev'"
      :services="services"
      :debug-on="cfg.debugTools"
      :row="dbg.row"
      @toggled="patchCfg({ debugTools: $event })"
      @focus-check="dbg.focusCheck()"
      @todo-check="dbg.todoCheck()"
      @timer-check="dbg.timerCheck()"
      @todo-due="dbg.todoDue($event)"
      @inject="dbg.injectLegacy()"
    />
    </div>

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

    <!-- 设置页启动片头：可选、默认关闭；挂到 body 保证盖住吸顶条与弹层 -->
    <Teleport to="body">
      <BootIntro v-if="bootIntroOpen" :video-url="bootIntroVideoUrl" :reduce="bgVideoReduced"
                 @closing="onBootIntroClosing" @done="finishBootIntro" />
    </Teleport>

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
      :saved="guideSaved"
      @save="onGuideSave"
      @test="onGuideTest"
      @skip="onGuideSkip"
      @browse-skins="onGuideBrowseSkins"
      @doc="openDoc"
    />

    <!-- 自定义显示管理弹窗 -->
    <DisplayManager
      v-if="showDisplayManager"
      :visible="showDisplayManager"
      :cfg="cfg"
      :tabs="TABS"
      :search-index="SEARCH_INDEX"
      :flash-msg="displayFlash.msg"
      :flash-err="displayFlash.err"
      @close="showDisplayManager = false"
      @update="onDisplayManagerUpdate"
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
/* 「未至之境」：深海军蓝 + HUD 细线（fantasy 类由 applyUtoolsDark 挂，恒为暗色） */
html.fantasy .tab-bar {
  border-bottom: 1px solid rgba(58, 123, 255, 0.22);
  box-shadow: inset 0 -1px 0 rgba(57, 255, 209, 0.18);
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
/* Tab 行：7 个分组等分整行宽。窄窗口下**换行成两排**，不再横向滚动 ——
   横向滚动会把「帮助 / 开发者」藏在屏幕外，用户根本不知道右边还有组；
   换行最多多占一行，吸顶高度由 ResizeObserver 实测写进 --tab-bar-h，滚动定位不受影响。
   每个 Tab 保留 min-width，避免「开发者」被压到字叠字。 */
.tab-row {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.tab {
  flex: 1 1 auto;
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
/* 自定义显示管理入口：齿轮 + 文字，放在 Tab 行末尾。
   文字用 --fg（不是 --fg-dim）：按钮只有 12px，深色下 --fg-dim(#9fb0d9) 压在 #303133 上
   偏暗，实机反馈「深色主题下几乎看不见」；边框同理从虚线 --line 提亮到 --fg-faint */
.display-manager-btn {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 9px;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  border: 1px dashed var(--fg-faint);
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.display-manager-btn:hover {
  background: var(--line);
  color: var(--fg);
  border-color: var(--fg);
}
/* 当前分组的一句说明。原先在吸顶的 .tab-bar 里，随 Tab 切换一直挂在屏幕上；
   挪进 .pin-scope（置顶排序的作用域）后随内容滚走 —— 它是「这一组干什么」的提示，
   滚到第二屏时早已不需要，而吸顶区越矮、可视卡片越多。
   上边距归零、下边距留 12px：吸顶条自带 16px 下边距，这里再加 8px 会让组首空出一大截 */
/* 颜色用 --fg-dim 而不是 --fg-faint：12px 小字在 --bar-bg 上实测对比度
   浅色 1.97 / 深色 3.95 / 未至之境 5.15，前两套低于正文 AA（4.5）；
   换 --fg-dim 后为 4.72 / 6.01 / 8.29，仍比标题用的 --fg（12.96 / 11.00）弱一档，
   既读得清又不抢标题。行高 1.6 让说明折行时不贴在一起 */
.tab-desc {
  margin: 0 2px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-dim);
}
.tab-desc .desc-err { color: var(--err); }
/* 配置保存失败条：常驻、可重试。刻意做成整块底色而不是一行红字 ——
   一是它可能长期挂着（存储满不会自愈），一行细字容易被当成说明文字略过；
   二来它带按钮，需要明确的点击区。配色与 .msg.err 同一套变量，不另起色板 */
.save-fail {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 2px 12px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--err) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--err);
  font-size: 12px;
  color: var(--fg);
}
.save-fail-text { flex: 1 1 auto; min-width: 0; line-height: 1.5; }
.save-fail-retry, .save-fail-close { flex: none; }
/* 置顶竖条 .card-pinned 在 main.css 全局定义：置顶 class 由子视图挂在各自卡根上，
   写在 scoped 里够不到子组件的卡根（详见 main.css 同名规则注释）。 */
/* 置顶作用域：syncPinned 只在这里面查卡根、写 order，不搬 DOM。
   必须是 flex 列容器 —— 置顶卡靠负 order 排到组首，未置顶卡保持 DOM（模板）顺序，
   取消置顶时清掉 order 就回原位（不再需要另记一份模板序）。
   这里不加 overflow —— .card 的 scroll-margin-top 定位闪烁与 Tab 切换淡入动画都依赖正常流，
    加裁剪会把动画与阴影切掉。 */
.pin-scope {
  display: flex;
  flex-direction: column;
}
/* 组首三段「行内说明」的 order 必须小于置顶卡的基数（脚本里的 PIN_ORDER_BASE = -1000），
   否则置顶卡会跑到 Tab 描述 / 搜索命中 / 置顶标题上面去。
   它们与普通卡的 DOM 顺序不变，这里只钉住「永远在置顶块之前」。 */
.pin-scope > .tab-desc { order: -3001; }
.pin-scope > .search-hits,
.pin-scope > .search-empty { order: -3000; }
.pin-scope > .pin-head { order: -2001; }
/* 置顶区标题：告诉用户「下面这几张是置顶卡」；只出一行，太长省略避免撑高组首。
   位置由上面的 order 钉到置顶卡块之前，不搬 DOM。 */
.pin-head {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* 已隐藏的卡片在搜索结果中标记：半透明 + 删除线，提示用户这张卡当前不可见 */
.search-hit-tag.hidden {
  opacity: 0.5;
  text-decoration: line-through;
}
.hidden-badge {
  margin-left: 4px;
  font-size: 10px;
  color: var(--err);
}
.search-empty {
  color: var(--fg-dim);
  font-size: 13px;
  line-height: 1.7;
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

/* 输入框 / 下拉 / 数值框 / 复选框的表单控件基类已上提 main.css（全局唯一来源），
   此处不再留副本。 */

.range {
  flex: 1;
  accent-color: var(--accent);
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
/* 通用复选框尺寸与配色已上提 main.css（全局唯一来源）。 */
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
/* .guide / .guide-use / .guide > .link-btn:first-child / .guide code / .guide a
   已上提 main.css（全局唯一来源），此处不再留副本。 */
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

/* 专注与计时合并卡：两个子块在父卡内扁平化（子块已不带 .card，规则直接落在 .card-embedded） */
.card-embedded {
  border: 0;
  box-shadow: none;
  background: transparent;
  padding: 0;
  margin: 0;
}
/* 两段之间的分隔线 */
.focus-timer-card .card-embedded + .card-embedded {
  border-top: 1px solid var(--line);
  margin-top: 12px;
  padding-top: 12px;
}
</style>
