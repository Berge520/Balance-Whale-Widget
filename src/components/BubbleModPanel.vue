<script lang="ts" setup>
import { computed, reactive, ref, watch } from 'vue'
import {
  BUBBLE_IMG_SCALE_MAX, BUBBLE_LINES_MAX, BUBBLE_LIB_MAX,
  BUBBLE_MOD_TYPES, BUBBLE_PRESET_COLORS, BUBBLE_QUICK_MODS, BUBBLE_ROW_MAX,
  BUBBLE_SESSION_LEN_MAX, BUBBLE_SIZE_MAX, BUBBLE_SIZE_MIN, BUBBLE_TEXT_MAX,
  addLibModule, addModule, addToRow, bubbleApplyRowLayout, bubbleRowsFromMods,
  cloneRows, dropModule, imgIdOf, imgIdRandom, isImgMod, libModuleById,
  modNeedsTpl, moveModule, moveModuleEnd, moveRow, moveRowEnd, moveRowTo,
  removeLibModule, removeModule, removeRow, setModule,
} from '../composables/useBubble'
import BubblePreview from './BubblePreview.vue'

// 单泡模块面板（W2）：把一个泡摆成「行 × 模块」，并逐个模块编辑样式与内容。
// 形态是**居中弹层**（.whale-overlay 底上并排两张卡：左 .bmp-left 预览、右 .bmp 编辑）：
// 与 SkinCropper / SoundTrimmer 同一套全屏遮罩。为什么不内联在卡片里 —— 左卡要常驻一块
// 330px 级的真实气泡预览，塞进卡片只剩两三百像素宽，编辑区会被挤成一条缝；弹层能一次给足
// 宽度（左预览右编辑）且右卡自滚，编辑长列表时预览不跟着滚走。遮罩底层的队列仍可见（半透明），
// 关掉就回到原处。
//
// 数据流（遵守 vue/no-mutating-props）：本组件只吃 rows（二维行）的深拷贝草稿，
// 每次改动 emit('change', flatModules) 把**压平后的 modules[]** 交回父级；父级负责写回
// cfg.bubble.items 并落盘。rows ↔ flat 的互转在父级与这里都只走 bubble-edit.js 的同一对函数。

const props = defineProps<{
  // 当前正在编辑的泡名（'第 N 次点击'），仅用于标题
  title: string
  // 该泡的模块（扁平 modules[]，来自 stepModules）
  modules: any[]
  // 模块库（cfg.bubble.lib），供「从库里取」面板用
  lib: any[]
  // 已导入的自定义气泡图（services.listBubbles().items），供 image 模块的下标下拉用。
  // 下标语义同浮动页 bubbleImgSrc：'' / '0' = 随机抽一张，1..N = 指定第 N 张
  bubbles: any[]
  // 设置页主题（cfg.theme）：预览要跟着主题走，否则深色主题下面板里亮着一块浅色气泡
  theme?: string
  // 当前编辑的是并列泡的哪一侧（0 = A / 1 = B）；单选泡恒 0
  side?: number
  // 该步有几侧（并列泡 2、单选泡 1）—— 只有 > 1 时面板里才显示 A/B 切换
  sides?: number
}>()

const emit = defineEmits<{
  (e: 'change', modules: any[]): void
  (e: 'lib', lib: any[]): void
  // 切到另一侧继续编辑（父级改 editing.side，面板原地换成那一侧的模块）
  (e: 'edit', side: number): void
  (e: 'close'): void
}>()

// —— 行草稿：进入时按 modules 还原成二维行；外部模块变了（切泡 / 切侧 / 撤销）要重新同步 ——
const rows = ref<any[][]>(bubbleRowsFromMods(props.modules))
watch(() => props.modules, (m) => { rows.value = bubbleRowsFromMods(m) })

// 落盘：压平后回抛（bubbleApplyRowLayout 会重建 row 键，与宿主 normBubbleModules 幂等）
function push(next: any[][]) {
  rows.value = next
  emit('change', bubbleApplyRowLayout(next))
}

const flash = reactive({ msg: '', err: false })
function say(msg?: string, err = false) { flash.msg = msg || ''; flash.err = err }

// —— 展开哪个模块的详细设置（一次只开一个，避免面板过长）——
const openKey = ref('')
function modKey(ri: number, mi: number) { return ri + ':' + mi }
function toggleMod(ri: number, mi: number) {
  const k = modKey(ri, mi)
  openKey.value = openKey.value === k ? '' : k
}

// —— 行操作 ——
function onAddModule(type: string) {
  const r = addModule(rows.value, type)
  if (!r.ok) { say(r.reason, true); return }
  flash.msg = ''
  push(r.rows)
}
function onAddToRow(ri: number, type: string) {
  const r = addToRow(rows.value, ri, type)
  if (!r.ok) { say(r.reason, true); return }
  flash.msg = ''
  push(r.rows)
}
function onRemoveModule(ri: number, mi: number) {
  openKey.value = ''
  push(removeModule(rows.value, ri, mi))
}
function onMoveRow(ri: number, dir: number) {
  push(moveRow(rows.value, ri, dir))
}
function onRemoveRow(ri: number) {
  openKey.value = ''
  push(removeRow(rows.value, ri))
}
// 把某模块整行挪到目标行（下拉选择，作为拖拽的无障碍兜底，键盘也能用）
function onMoveModuleTo(ri: number, mi: number, e: Event) {
  const target = Number((e.target as HTMLSelectElement).value)
  if (!Number.isFinite(target) || target === ri) return
  push(moveModule(rows.value, ri, mi, target))
}

// —— 拖拽排序（对齐上游 bubblePvMoveRow / bubblePvDropBlock 的落点口径）——
// 三态：拖模块块、拖整行手柄 ⠿、拖到列表下方空白区（末尾）。落点五态由 dragover 实时算出：
// 模块块横向靠边（xRel < 0.2 / > 0.8）判「并入行首 / 行尾」，否则按纵向上下半判「另起一行插在前 / 后」。
// 用 HTML5 DnD 而非自研触摸手势 —— 设置窗是桌面环境，且本项目 AssetsView 画廊已用同一套（现网可用）。
// 拖拽只改排序，不新造数据结构：全部落到 bubble-edit.js 的纯函数，失败（超上限等）只提示不落库。
const dragKind = ref<'' | 'mod' | 'row'>('')
const dragFrom = reactive({ ri: -1, mi: -1 })
const dropRi = ref(-1)
const dropZone = ref<'' | 'pairL' | 'pairR' | 'before' | 'after'>('')
// 拖到列表下方空白区 = 挪到末尾（此时行级高亮要清掉，改由末尾区自亮）
const dropEnd = ref(false)

function dragReset() {
  dragKind.value = ''
  dragFrom.ri = -1
  dragFrom.mi = -1
  dropRi.value = -1
  dropZone.value = ''
  dropEnd.value = false
}

function onModDragStart(ri: number, mi: number, e: DragEvent) {
  dragKind.value = 'mod'
  dragFrom.ri = ri
  dragFrom.mi = mi
  dropEnd.value = false
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', 'mod:' + ri + ':' + mi)
  }
}
function onRowDragStart(ri: number, e: DragEvent) {
  dragKind.value = 'row'
  dragFrom.ri = ri
  dragFrom.mi = -1
  dropEnd.value = false
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', 'prow:' + ri)
  }
}
// 行落点判定：模块块横向靠边 → 并入；否则按纵向上下半 → 另起一行插在行前 / 后
function onRowDragOver(ri: number, e: DragEvent) {
  if (!dragKind.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropEnd.value = false
  dropRi.value = ri
  if (dragKind.value === 'row') { dropZone.value = 'before'; return }
  const el = e.currentTarget as HTMLElement
  const rc = el.getBoundingClientRect()
  if (!rc.width) return
  const xRel = (e.clientX - rc.left) / rc.width
  if (xRel < 0.2) { dropZone.value = 'pairL'; return }
  if (xRel > 0.8) { dropZone.value = 'pairR'; return }
  dropZone.value = (e.clientY - rc.top) < rc.height / 2 ? 'before' : 'after'
}
function onRowDragLeave(ri: number, e: DragEvent) {
  // 在行内子元素之间移动也会触发 dragleave，若直接清掉高亮会闪烁；
  // 只有真正离开整行（relatedTarget 不在行内）才清
  const to = e.relatedTarget as Node | null
  if (to && (e.currentTarget as HTMLElement).contains(to)) return
  if (dropRi.value === ri) { dropRi.value = -1; dropZone.value = '' }
}
// 行上落子：按拖的是什么分发到对应纯函数
function onRowDrop(ri: number, e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  const kind = dragKind.value
  const from = dragFrom.ri
  const zone = dropZone.value
  dragReset()
  if (kind === 'row' && from >= 0 && zone) push(moveRowTo(rows.value, from, ri, zone))
  else if (kind === 'mod' && from >= 0 && zone) {
    const r = dropModule(rows.value, from, dragFrom.mi, ri, zone)
    if (!r.ok) { say(r.reason, true); return }
    flash.msg = ''
    push(r.rows)
  }
}
// 空白区：行级拖拽 → 挪到末尾；模块块 → 独立成末尾一行
function onEndDragOver(e: DragEvent) {
  if (!dragKind.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropRi.value = -1
  dropZone.value = ''
  dropEnd.value = true
}
function onEndDrop(e: DragEvent) {
  e.preventDefault()
  const kind = dragKind.value
  const from = dragFrom.ri
  const mi = dragFrom.mi
  dragReset()
  if (kind === 'row' && from >= 0) push(moveRowEnd(rows.value, from))
  else if (kind === 'mod' && from >= 0) push(moveModuleEnd(rows.value, from, mi))
}

// 落点高亮：口径取自上游 bubbleDropShadow —— 并入用内阴影（左右）、另起行用外阴影（上下）
function dropStyle(ri: number): Record<string, string> {
  if (dropRi.value !== ri || !dropZone.value) return {}
  if (dropZone.value === 'before') return { boxShadow: '0 -3px 0 var(--accent)' }
  if (dropZone.value === 'after') return { boxShadow: '0 3px 0 var(--accent)' }
  if (dropZone.value === 'pairL') return { boxShadow: 'inset 3px 0 0 var(--accent)' }
  return { boxShadow: 'inset -3px 0 0 var(--accent)' }
}

// —— 模块字段编辑 ——
// patch 一组字段，走 setModule（undefined 摘键，空串由调用方决定是否传 undefined）
function patchMod(ri: number, mi: number, patch: Record<string, any>) {
  push(setModule(rows.value, ri, mi, patch))
}
// 数值输入：越界夹回，空值不写（避免输入中途把字段打没）
function numPatch(ri: number, mi: number, key: string, e: Event, min: number, max: number, dft?: number) {
  const raw = (e.target as HTMLInputElement).value
  if (raw === '') { if (dft !== undefined) patchMod(ri, mi, { [key]: dft }); return }
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  const v = Math.min(max, Math.max(min, Math.round(n)))
  patchMod(ri, mi, { [key]: v })
  // 夹回后的值要回写到输入框（用户输了 999 应看到 50）
  ;(e.target as HTMLInputElement).value = String(v)
}
// 文本输入：空 → 摘键（颜色 / 字体等空串就等于「用默认」）
function textPatch(ri: number, mi: number, key: string, e: Event, keepEmpty = false) {
  const s = String((e.target as HTMLInputElement).value)
  if (!s && !keepEmpty) patchMod(ri, mi, { [key]: undefined })
  else patchMod(ri, mi, { [key]: s })
}
// 勾选：只认 true（与宿主 === true 口径一致），取消时摘键
function boolPatch(ri: number, mi: number, key: string, e: Event) {
  const on = (e.target as HTMLInputElement).checked
  patchMod(ri, mi, { [key]: on ? true : undefined })
}

// —— random 模块的句池（lines）编辑 ——
// 用换行分隔的多行文本最省事：每行一句，空行丢弃，超上限截断
function linesText(m: any): string {
  const arr = Array.isArray(m.lines) ? m.lines : []
  return arr.map((it: any) => (typeof it === 'string' ? it : String(it?.t || ''))).filter(Boolean).join('\n')
}
function onLinesInput(ri: number, mi: number, e: Event) {
  const txt = String((e.target as HTMLTextAreaElement).value)
  const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, BUBBLE_LINES_MAX)
  // 全空不能落（宿主 normBubbleMod 会整条丢掉 random），保留原值并提示
  if (!lines.length) { say('随机语句至少留一句，否则这个模块会被丢掉', true); return }
  flash.msg = ''
  patchMod(ri, mi, { lines: lines.map((t) => ({ t })) })
}

// —— image / randimg 的取图设置 ——
// image 的 imgId 是**已导入气泡图的下标**（1 起算，'0'/空 = 每次随机抽一张）——与浮动页
// bubbleImgSrc 同语义。故这里给下拉而非文本框：让用户手填下标基本等于让他猜，无从下手。
// randimg 的 imgs 是共享角色池下标集，那个池子在本项目里恒为空（无数据源），保持纯文本占位输入
function imgIdOptions() {
  const n = Math.max(1, props.bubbles.length)
  const out: { v: string; label: string }[] = [{ v: imgIdRandom(), label: '每次随机一张' }]
  for (let i = 1; i <= n; i++) out.push({ v: String(i), label: `第 ${i} 张` })
  return out
}
function onImgId(ri: number, mi: number, e: Event) {
  patchMod(ri, mi, { imgId: (e.target as HTMLSelectElement).value })
}
// 当前 imgId 若超出已导入张数（删过图），下拉里没有对应项会显示空白，这里夹回「随机」
function imgIdCurrent(m: any) {
  const s = imgIdOf(m?.imgId)
  if (s === imgIdRandom()) return s
  return Number(s) <= props.bubbles.length ? s : imgIdRandom()
}
function imgsText(m: any): string {
  return Array.isArray(m.imgs) ? m.imgs.join('\n') : ''
}
function onImgsInput(ri: number, mi: number, e: Event) {
  const txt = String((e.target as HTMLTextAreaElement).value)
  const imgs = txt.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 60)
  patchMod(ri, mi, { imgs })
}

// —— 模块库 ——
const libOpen = ref(false)
function onSaveToLib(ri: number, mi: number) {
  const m = rows.value[ri]?.[mi]
  if (!m) return
  const label = m.type === 'text' ? String(m.text || '').slice(0, 10) : (modLabel(m.type))
  emit('lib', addLibModule(props.lib, m, label))
  say('已存入模块库')
}
function onFromLib(id: string) {
  const m = libModuleById(props.lib, id)
  if (!m) return
  const r = addModule(rows.value, m.type)
  if (!r.ok) { say(r.reason, true); return }
  // addModule 造的是空模块，这里换成库里的那份（落到同一行末）
  const next = cloneRows(r.rows)
  next[next.length - 1] = [m]
  flash.msg = ''
  libOpen.value = false
  push(next)
}
function onDelLib(id: string) {
  emit('lib', removeLibModule(props.lib, id))
}

// —— 展示辅助 ——
function modLabel(type: string) {
  return BUBBLE_MOD_TYPES.find((m) => m.type === type)?.label || type
}
// 模块在行内的摘要（列表里那一行小字）
function modSummary(m: any): string {
  switch (m?.type) {
    case 'text': return String(m.text || '').slice(0, 24)
    case 'random': return `${Array.isArray(m.lines) ? m.lines.length : 0} 句 · ${String((m.lines?.[0]?.t) || '').slice(0, 14)}`
    case 'link': return String(m.url || '')
    case 'image': {
      const s = imgIdCurrent(m)
      return s === imgIdRandom() ? '随机一张' : `第 ${s} 张`
    }
    case 'randimg': return `${Array.isArray(m.imgs) ? m.imgs.length : 0} 张随机图`
    case 'peak': return `峰谷 · ${m.peakStyle === 'count' ? '倒计时' : m.peakStyle === 'mini' ? '简式' : '文字'}`
    default: return modLabel(m?.type || '')
  }
}
const peakStyleLabel: Record<string, string> = { mini: '简式', text: '文字', count: '倒计时' }
const planWinLabel: Record<string, string> = { all: '全部', '5h': '近 5 小时', week: '本周', month: '本月' }
const fontOptions = [
  { v: '', label: '默认字体' },
  { v: '"Microsoft YaHei",sans-serif', label: '微软雅黑' },
  { v: '"PingFang SC","Microsoft YaHei",sans-serif', label: '苹方 / 雅黑' },
  { v: 'SimSun,serif', label: '宋体' },
  { v: 'SimHei,sans-serif', label: '黑体' },
  { v: 'KaiTi,serif', label: '楷体' },
  { v: '"Courier New",monospace', label: '等宽' },
  { v: 'Consolas,monospace', label: 'Consolas' },
  { v: 'Georgia,serif', label: 'Georgia' },
]
// 跑马灯方案（与宿主 BUBBLE_RGB_SCHEMES 同值，'' = 无渐变）
const rgbOptions = [
  '', 'macaron', 'candy', 'rouge', 'bamboo', 'aurora', 'deepsea', 'sunset', 'forest',
  'champagne', 'lavender', 'mint', 'lava', 'galaxy', 'ink', 'indigo', 'blaze', 'amber',
]

const rowCount = computed(() => rows.value.length)
const emptyHint = computed(() => !rows.value.length)
// 已放图片（图片独占一行，放过后「图片」按钮要禁用）
const hasImg = computed(() => rows.value.some((r) => r.length && isImgMod(r[0].type)))

// —— 真气泡形预览 ——
// 行草稿压平成交给渲染器的 modules[]，走的正是落盘那支 bubbleApplyRowLayout ——
// 预览的行分组与左侧行列表必然同源，不会出现「预览和编辑区对不上」
const previewLines = computed(() => ({ mods: bubbleApplyRowLayout(rows.value) }))

// 预览用的示例值：不取实时数据。取固定样本而非每次刷新换数字 —— 调样式时数值得稳定，
// 否则每次改字号预览里的数字都在跳，看不出自己改了什么
const PREVIEW_TOKENS: Record<string, string> = {
  balance_ds: '¥ 12.34', expense_ds: '¥ 3.21', status: '高峰时段', countdown: '30m',
  balance: '¥ 12.34', today: '¥ 3.21', peak: '高峰时段', next: '¥ 8.00',
  change: '-¥ 1.20', model: 'DeepSeek', currency: '¥', date: '10-06', time: '10:30',
  weekday: '周二', session: '—',
}
// 模板替换：口径同浮动页 bubbleApplyTpl —— 长键优先，否则 {balance_ds} 会先被 {balance} 咬掉半截
function previewTpl(tpl: any, auto: string) {
  const s = String(tpl == null ? '' : tpl)
  if (!s) return auto
  return Object.keys(PREVIEW_TOKENS)
    .sort((a, b) => b.length - a.length)
    .reduce((acc, k) => acc.split('{' + k + '}').join(PREVIEW_TOKENS[k]), s)
}
// 文本里的占位符也换成样本值，与浮动页 renderLinePlaceholders 同口径
function previewPlaceholders(text: any) {
  return String(text == null ? '' : text)
    .replace(/\{(\w+)\}/g, (mm, k) => (k in PREVIEW_TOKENS ? PREVIEW_TOKENS[k] : mm))
}
// 模块正文示例值：分支顺序与浮动页 bubbleModText 一一对应（含 tpl 套用）
function previewModText(m: any): string {
  switch (m?.type) {
    case 'text': return previewPlaceholders(m.text)
    case 'link': return previewPlaceholders(m.text || m.url || '')
    case 'random': {
      const lines = Array.isArray(m.lines) ? m.lines : []
      if (!lines.length) return ''
      const it = lines[0]
      return previewPlaceholders(typeof it === 'string' ? it : String(it?.t || ''))
    }
    case 'time': return previewTpl(m.tpl, PREVIEW_TOKENS.time)
    case 'balance': return previewTpl(m.tpl, PREVIEW_TOKENS.balance)
    case 'today': return previewTpl(m.tpl, PREVIEW_TOKENS.today)
    // bonus / recharge / session / quota / plan 本项目暂无数据源，与浮动页一致回「—」
    case 'bonus': case 'recharge': case 'session': case 'quota': case 'plan':
      return previewTpl(m.tpl, '—')
    case 'peak': {
      const auto = m.peakStyle === 'count' ? PREVIEW_TOKENS.countdown
        : m.peakStyle === 'mini' ? '峰' : PREVIEW_TOKENS.peak
      return previewTpl(m.tpl, auto)
    }
    default: return ''
  }
}
// 图片模块取图：下标语义同浮动页 bubbleImgSrc（1..N 指定，0/空 = 随机）。
// 预览里把「随机」固定成第 1 张 —— 要在预览中检查某张图的缩放，图就不能每次都在换
function previewModImageSrc(m: any): string | null {
  if (m?.type !== 'image') return null
  const n = Number(imgIdOf(m.imgId))
  return props.bubbles[(n > 0 ? n : 1) - 1]?.thumb || null
}
// 峰谷模块的动态配色：渲染器不知道该取峰还是谷，这里固定按「峰」态预览（可见性最好）
function previewModStyle(m: any): Record<string, string> | null {
  if (m?.type !== 'peak') return null
  const o: Record<string, string> = {}
  if (m.peakColor) o.color = m.peakColor
  if (m.peakRgb) o.rgb = m.peakRgb
  if (m.peakBg) o.bg = m.peakBg
  return o
}

// —— A/B 侧（并列泡）：chip 高亮当前侧，点击切到另一侧 ——
const sideCount = computed(() => Math.max(1, Number(props.sides) || 1))
const curSide = computed(() => Math.max(0, Number(props.side) || 0))

// —— 问号圈：长说明收进弹出，不再平铺占版面（对齐上游 dshwvAskDot）——
const help = ref('')
function toggleHelp(k: string) { help.value = help.value === k ? '' : k }
// 展开的模块与问号都按 key 记（'行:列'）；换泡 / 换侧后 key 会撞上前一个泡的状态，故整体收起。
// 只认 title / side 这两个「身份」信号 —— 不能顺手 watch props.modules：本组件每次改动都会回抛，
// 父级落盘后 props.modules 必然是新引用，把它算进来就会「打一个字，展开的模块自己收起来」
watch(() => [props.side, props.title], () => { openKey.value = ''; help.value = '' })
const HELP: Record<string, string> = {
  add: '一个泡可以摆多行，一行最多 6 个模块（超了自动另起一行）；图片独占一行、一个泡只能放一张。点模块标题展开它的内容与样式设置；并列泡用上面的 A / B 按钮换侧。',
  tpl: '这个模块的正文由运行时的数据决定（余额、峰谷状态等），模板里的 {balance_ds} / {status} / {countdown} 这类占位符会被自动替换。留空则用默认正文。',
  bg: '底色跑马灯优先于纯色底色：两者都设时只跑马灯生效。',
  img: '还没有导入过气泡图：去「资源」页导入后，这里才能指定用哪一张；选「随机」每次点开会在已导入的图里换一张。',
  randimg: '本项目还没有共享角色图池，这一项暂时取不到图（整行不显示）。',
}
</script>

<template>
  <!-- 居中弹层（.whale-overlay 遮罩 + 两张并排卡）：见文件头「为什么弹层」。
       左卡 .bmp-left 常驻真实气泡预览、右卡 .bmp 是编辑区 —— 两块是兄弟，编辑区不必再套右栏；
       滚动条只开在 .bmp 上（左卡内容不高，不需要滚），所以编辑长列表时预览不跟着卷走，
       改一个颜色当场就能看见效果，这正是把上游「真实泡泡预览」补回来的意义 -->
  <div class="whale-overlay bmp-overlay" @click.self="emit('close')">
    <!-- 预览单独成卡，与右边编辑卡平级并排 —— 两块是兄弟，编辑区就不必再套一层右栏容器；
         左卡常驻预览（改一个色号当场看见），右卡长到 88vh 自滚，滚列表时预览不跟着卷走 -->
    <div class="bmp-left">
      <div class="bmp-pv-head">
        <span>泡泡内容预览</span>
        <button class="bmp-ask" type="button" :class="{ 'bmp-ask-on': help === 'add' }"
                title="怎么摆行 / 加模块" @click="toggleHelp('add')">?</button>
      </div>
      <BubblePreview :lines="previewLines" :theme="theme" :scale="0.7"
                     :mod-text="previewModText" :mod-image-src="previewModImageSrc"
                     :mod-style="previewModStyle" />
      <p v-if="help === 'add'" class="bmp-help">{{ HELP.add }}</p>
    </div>

    <div class="bmp">
      <div class="bmp-head">
        <span class="bmp-title">{{ title }} · 泡内容（{{ rowCount }} / {{ BUBBLE_ROW_MAX }} 行）</span>
        <button class="utils-btn utils-outline utils-xs" type="button" @click="emit('close')">关闭</button>
      </div>

      <!-- 并列泡才有第二侧：切换即换编辑对象（改动是实时回抛的，切侧不会丢） -->
      <div v-if="sideCount > 1" class="bmp-sides">
        <button v-for="si in sideCount" :key="si" class="bmp-chip"
                :class="{ 'bmp-chip-cur': curSide === si - 1 }" type="button"
                @click="emit('edit', si - 1)">{{ si === 1 ? 'A 泡' : 'B 泡' }}</button>
      </div>

      <!-- 行列表：每行都是拖拽落点容器（模块块 / 整行 都往这里落）。
           落点高亮口径见 dropStyle（并入 = 左右内阴影，另起一行 = 上下外阴影） -->
      <div v-for="(row, ri) in rows" :key="ri" class="bmp-row"
           :class="{ 'bmp-row-drop': dropRi === ri && !!dropZone }" :style="dropStyle(ri)"
           @dragover="onRowDragOver(ri, $event)"
           @dragleave="onRowDragLeave(ri, $event)"
           @drop="onRowDrop(ri, $event)">
        <div class="bmp-row-head">
          <!-- 整行拖拽手柄：⠿ 是行排序的唯一抓手（模块块只管自己那一格） -->
          <span class="bmp-grip" draggable="true" title="拖动整行排序"
                @dragstart="onRowDragStart(ri, $event)" @dragend="dragReset()">⠿</span>
          <span class="bmp-row-idx">第 {{ ri + 1 }} 行</span>
          <span class="bmp-row-ops">
            <button class="utils-btn utils-outline utils-xs" type="button" :disabled="ri === 0"
                    title="上移一行" @click="onMoveRow(ri, -1)">↑</button>
            <button class="utils-btn utils-outline utils-xs" type="button" :disabled="ri === rowCount - 1"
                    title="下移一行" @click="onMoveRow(ri, 1)">↓</button>
            <button class="utils-btn utils-danger utils-xs" type="button" title="删掉这一行"
                    @click="onRemoveRow(ri)">删行</button>
          </span>
        </div>

        <!-- 行内模块：每个模块一个可展开的小卡。拖拽抓手只给标题栏（.bmp-mod-head）——
             整卡 draggable 会让展开后的输入框跟着能被拖走，抢掉选中文本的手感 -->
        <div class="bmp-mods">
          <div v-for="(m, mi) in row" :key="mi" class="bmp-mod">
            <div class="bmp-mod-head" draggable="true" title="拖动这个模块（拖到另一行左右边缘 = 并入该行）"
                 @click="toggleMod(ri, mi)"
                 @dragstart="onModDragStart(ri, mi, $event)" @dragend="dragReset()">
              <span class="bmp-mod-type">{{ modLabel(m.type) }}</span>
              <span class="bmp-mod-sum">{{ modSummary(m) }}</span>
              <span class="bmp-mod-caret">{{ openKey === modKey(ri, mi) ? '▾' : '▸' }}</span>
            </div>

            <div v-if="openKey === modKey(ri, mi)" class="bmp-mod-body">
              <!-- 内容区（按类型分支） -->
              <label v-if="m.type === 'text'" class="bmp-f">
                <span>文本</span>
                <input type="text" :value="m.text" :maxlength="BUBBLE_TEXT_MAX"
                       @input="textPatch(ri, mi, 'text', $event, true)" />
              </label>

              <label v-else-if="m.type === 'link'" class="bmp-f">
                <span>链接地址</span>
                <input type="text" :value="m.url" placeholder="https://…"
                       @input="textPatch(ri, mi, 'url', $event, true)" />
              </label>
              <label v-if="m.type === 'link'" class="bmp-f">
                <span>显示文字</span>
                <input type="text" :value="m.text" placeholder="留空则显示链接本身"
                       @input="textPatch(ri, mi, 'text', $event, true)" />
              </label>

              <label v-else-if="m.type === 'random'" class="bmp-f bmp-f-col">
                <span>随机句池（一行一句，共 {{ Array.isArray(m.lines) ? m.lines.length : 0 }} 句）</span>
                <textarea rows="5" :value="linesText(m)" @change="onLinesInput(ri, mi, $event)"></textarea>
              </label>

              <label v-else-if="m.type === 'image'" class="bmp-f">
                <span>用哪张图</span>
                <select :value="imgIdCurrent(m)" @change="onImgId(ri, mi, $event)">
                  <option v-for="o in imgIdOptions()" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
                <span class="bmp-ask" :class="{ 'bmp-ask-on': help === 'img' }"
                      title="说明" @click.stop.prevent="toggleHelp('img')">?</span>
              </label>
              <p v-if="help === 'img'" class="bmp-help">{{ HELP.img }}</p>

              <label v-else-if="m.type === 'randimg'" class="bmp-f bmp-f-col">
                <span>随机图池（一行一个共享角色下标，共 {{ Array.isArray(m.imgs) ? m.imgs.length : 0 }} 张）
                  <span class="bmp-ask" :class="{ 'bmp-ask-on': help === 'randimg' }"
                        title="说明" @click.stop.prevent="toggleHelp('randimg')">?</span>
                </span>
                <textarea rows="4" :value="imgsText(m)" @change="onImgsInput(ri, mi, $event)"></textarea>
              </label>
              <p v-if="help === 'randimg'" class="bmp-help">{{ HELP.randimg }}</p>

              <template v-else-if="m.type === 'peak'">
                <label class="bmp-f">
                  <span>显示样式</span>
                  <select :value="m.peakStyle || 'text'"
                          @change="patchMod(ri, mi, { peakStyle: ($event.target as HTMLSelectElement).value })">
                    <option v-for="(lb, k) in peakStyleLabel" :key="k" :value="k">{{ lb }}</option>
                  </select>
                </label>
              </template>

              <template v-else-if="m.type === 'session'">
                <label class="bmp-f">
                  <span>保留字数</span>
                  <input type="number" min="0" :max="BUBBLE_SESSION_LEN_MAX" :value="m.len"
                         @change="numPatch(ri, mi, 'len', $event, 0, BUBBLE_SESSION_LEN_MAX, 0)" />
                </label>
              </template>

              <template v-else-if="m.type === 'plan'">
                <label class="bmp-f">
                  <span>时间窗口</span>
                  <select :value="m.planWin || 'all'"
                          @change="patchMod(ri, mi, { planWin: ($event.target as HTMLSelectElement).value })">
                    <option v-for="(lb, k) in planWinLabel" :key="k" :value="k">{{ lb }}</option>
                  </select>
                </label>
              </template>

              <!-- 模板（内容锁定型 / 峰谷 / 对话名才给）：占位符口径收进问号，不再平铺一行小字 -->
              <label v-if="modNeedsTpl(m.type)" class="bmp-f">
                <span>模板</span>
                <input type="text" :value="m.tpl" placeholder="可用 {balance_ds} / {expense_ds} / {status} / {countdown}"
                       @input="textPatch(ri, mi, 'tpl', $event, true)" />
                <span class="bmp-ask" :class="{ 'bmp-ask-on': help === 'tpl' }"
                      title="说明" @click.stop.prevent="toggleHelp('tpl')">?</span>
              </label>
              <p v-if="modNeedsTpl(m.type) && help === 'tpl'" class="bmp-help">{{ HELP.tpl }}</p>

              <!-- 公共样式 -->
              <div class="bmp-sub">样式</div>
              <div class="bmp-grid">
                <label class="bmp-f bmp-f-sm">
                  <span>字号</span>
                  <input type="number" :min="BUBBLE_SIZE_MIN" :max="BUBBLE_SIZE_MAX" :value="m.size"
                         @change="numPatch(ri, mi, 'size', $event, BUBBLE_SIZE_MIN, BUBBLE_SIZE_MAX)" />
                </label>
                <label v-if="m.type !== 'peak'" class="bmp-f bmp-f-sm">
                  <span>文字颜色</span>
                  <span class="bmp-color">
                    <input type="color" :value="m.color || '#3b4d8f'"
                           @input="textPatch(ri, mi, 'color', $event)" />
                    <input type="text" class="bmp-color-hex" :value="m.color" placeholder="默认"
                           @input="textPatch(ri, mi, 'color', $event)" />
                  </span>
                </label>
              </div>
              <!-- 预设色：一排 chip，与并列泡的 A/B 切换同款外观（对齐上游 .dshwv-palchip） -->
              <div v-if="m.type !== 'peak'" class="bmp-palette">
                <button v-for="c in BUBBLE_PRESET_COLORS" :key="c" class="bmp-chip bmp-chip-color"
                        type="button" :style="{ background: c }" :title="c"
                        @click="patchMod(ri, mi, { color: c })"></button>
                <button class="bmp-chip" type="button" title="用默认色"
                        @click="patchMod(ri, mi, { color: undefined })">无</button>
              </div>

              <div class="bmp-grid">
                <label class="bmp-f bmp-f-sm">
                  <span>跑马灯</span>
                  <select :value="m.rgb || ''"
                          @change="patchMod(ri, mi, { rgb: ($event.target as HTMLSelectElement).value || undefined })">
                    <option v-for="s in rgbOptions" :key="s" :value="s">{{ s || '无' }}</option>
                  </select>
                </label>
                <label class="bmp-f bmp-f-sm">
                  <span>字体</span>
                  <select :value="m.fontFamily || ''"
                          @change="patchMod(ri, mi, { fontFamily: ($event.target as HTMLSelectElement).value || undefined })">
                    <option v-for="f in fontOptions" :key="f.v" :value="f.v">{{ f.label }}</option>
                  </select>
                </label>
              </div>

              <!-- 模块底色 / 底色跑马灯（渲染侧 needBg：bg 与 bgRgb 二选一，都空则不画底）。
                   峰谷模块有自己那套 peakBg / offBg（在下面「峰谷配色」里），这里不重复给 -->
              <div v-if="m.type !== 'peak'" class="bmp-grid">
                <label class="bmp-f bmp-f-sm">
                  <span>底色</span>
                  <span class="bmp-color">
                    <input type="color" :value="m.bg || '#1f2937'"
                           @input="textPatch(ri, mi, 'bg', $event)" />
                    <input type="text" class="bmp-color-hex" :value="m.bg" placeholder="无"
                           @input="textPatch(ri, mi, 'bg', $event)" />
                  </span>
                </label>
                <label class="bmp-f bmp-f-sm">
                  <span>底色跑马灯
                    <span class="bmp-ask" :class="{ 'bmp-ask-on': help === 'bg' }"
                          title="说明" @click.stop.prevent="toggleHelp('bg')">?</span>
                  </span>
                  <select :value="m.bgRgb || ''"
                          @change="patchMod(ri, mi, { bgRgb: ($event.target as HTMLSelectElement).value || undefined })">
                    <option v-for="s in rgbOptions" :key="s" :value="s">{{ s || '无' }}</option>
                  </select>
                </label>
              </div>
              <p v-if="help === 'bg'" class="bmp-help">{{ HELP.bg }}</p>

              <div class="bmp-checks">
                <label><input type="checkbox" :checked="m.bold === true"
                              @change="boolPatch(ri, mi, 'bold', $event)" /> 加粗</label>
                <label><input type="checkbox" :checked="m.italic === true"
                              @change="boolPatch(ri, mi, 'italic', $event)" /> 斜体</label>
                <label><input type="checkbox" :checked="m.ul === true"
                              @change="boolPatch(ri, mi, 'ul', $event)" /> 下划线</label>
              </div>

              <!-- 图片缩放 -->
              <label v-if="isImgMod(m.type)" class="bmp-f bmp-f-sm">
                <span>图片缩放（{{ Number(m.imgScale ?? 1).toFixed(2) }}）</span>
                <input type="range" min="0.1" :max="BUBBLE_IMG_SCALE_MAX" step="0.05"
                       :value="Number(m.imgScale ?? 1)"
                       @input="patchMod(ri, mi, { imgScale: Math.round(Number(($event.target as HTMLInputElement).value) * 100) / 100 })" />
              </label>

              <!-- 峰谷两态配色：文字色 / 底色 / 各自的跑马灯（peak 态与 off 态各一套） -->
              <template v-if="m.type === 'peak'">
                <div class="bmp-grid">
                  <label class="bmp-f bmp-f-sm">
                    <span>峰色</span>
                    <input type="color" :value="m.peakColor || '#b91c1c'"
                           @input="textPatch(ri, mi, 'peakColor', $event)" />
                  </label>
                  <label class="bmp-f bmp-f-sm">
                    <span>谷色</span>
                    <input type="color" :value="m.offColor || '#15803d'"
                           @input="textPatch(ri, mi, 'offColor', $event)" />
                  </label>
                </div>
                <div class="bmp-grid">
                  <label class="bmp-f bmp-f-sm">
                    <span>峰跑马灯</span>
                    <select :value="m.peakRgb || ''"
                            @change="patchMod(ri, mi, { peakRgb: ($event.target as HTMLSelectElement).value || undefined })">
                      <option v-for="s in rgbOptions" :key="s" :value="s">{{ s || '无' }}</option>
                    </select>
                  </label>
                  <label class="bmp-f bmp-f-sm">
                    <span>谷跑马灯</span>
                    <select :value="m.offRgb || ''"
                            @change="patchMod(ri, mi, { offRgb: ($event.target as HTMLSelectElement).value || undefined })">
                      <option v-for="s in rgbOptions" :key="s" :value="s">{{ s || '无' }}</option>
                    </select>
                  </label>
                </div>
                <div class="bmp-grid">
                  <label class="bmp-f bmp-f-sm">
                    <span>峰底色</span>
                    <span class="bmp-color">
                      <input type="color" :value="m.peakBg || '#fee2e2'"
                             @input="textPatch(ri, mi, 'peakBg', $event)" />
                      <input type="text" class="bmp-color-hex" :value="m.peakBg" placeholder="无"
                             @input="textPatch(ri, mi, 'peakBg', $event)" />
                    </span>
                  </label>
                  <label class="bmp-f bmp-f-sm">
                    <span>谷底色</span>
                    <span class="bmp-color">
                      <input type="color" :value="m.offBg || '#dcfce7'"
                             @input="textPatch(ri, mi, 'offBg', $event)" />
                      <input type="text" class="bmp-color-hex" :value="m.offBg" placeholder="无"
                             @input="textPatch(ri, mi, 'offBg', $event)" />
                    </span>
                  </label>
                </div>
                <label class="bmp-f bmp-f-sm">
                  <span>谷底色跑马灯</span>
                  <select :value="m.offBgRgb || ''"
                          @change="patchMod(ri, mi, { offBgRgb: ($event.target as HTMLSelectElement).value || undefined })">
                    <option v-for="s in rgbOptions" :key="s" :value="s">{{ s || '无' }}</option>
                  </select>
                </label>
              </template>

              <!-- 本模块操作 -->
              <div class="bmp-mod-ops">
                <label v-if="rowCount > 1" class="bmp-move">
                  挪到
                  <select :value="ri" @change="onMoveModuleTo(ri, mi, $event)">
                    <option v-for="(_, ti) in rows" :key="ti" :value="ti">第 {{ ti + 1 }} 行</option>
                  </select>
                </label>
                <button class="utils-btn utils-outline utils-xs" type="button"
                        title="把这个模块存进模块库，别的泡也能用" @click="onSaveToLib(ri, mi)">存入模块库</button>
                <button class="utils-btn utils-danger utils-xs" type="button"
                        @click="onRemoveModule(ri, mi)">删除模块</button>
              </div>
            </div><!-- /.bmp-mod-body -->
          </div><!-- /.bmp-mod -->
        </div><!-- /.bmp-mods -->

        <span v-if="!row.length" class="bmp-row-empty">这一行空了</span>

        <!-- 给这一行加模块（放在行循环内，「本行加」才拿得到 ri） -->
        <div class="bmp-row-add">
          <span class="bmp-add-label">本行加：</span>
          <button v-for="q in BUBBLE_QUICK_MODS" :key="q.type" class="utils-btn utils-outline utils-xs"
                  type="button" :disabled="isImgMod(q.type)" @click="onAddToRow(ri, q.type)">{{ q.label }}</button>
        </div>
      </div><!-- /.bmp-row -->

      <!-- 行列表下方空白区：拖到这里的落点是「挪到末尾」（整行排序 / 模块独立成最后一行）。
           只在拖拽进行中才显形（平时不占版面），并给出「放到末尾」的落点提示 -->
      <div v-if="dragKind" class="bmp-end" :class="{ 'bmp-end-on': dropEnd }"
           @dragover="onEndDragOver($event)" @drop="onEndDrop($event)">放到末尾</div>

      <p v-if="emptyHint" class="bmp-empty">
        这个泡是空的。空泡存下去会被丢掉，请至少加一个模块。
      </p>

      <!-- 新起一行加模块 -->
      <div class="bmp-add">
        <div class="bmp-add-head">
          <span class="bmp-add-label">新起一行加模块：</span>
          <button class="utils-btn utils-outline utils-xs" type="button"
                  @click="libOpen = !libOpen">模块库（{{ lib.length }} / {{ BUBBLE_LIB_MAX }}）</button>
        </div>
        <div class="bmp-quick">
          <button v-for="q in BUBBLE_QUICK_MODS" :key="q.type" class="utils-btn utils-secondary utils-xs"
                  type="button" :disabled="isImgMod(q.type) && hasImg"
                  :title="isImgMod(q.type) && hasImg ? '一个泡里只能放一张图片' : ''"
                  @click="onAddModule(q.type)">{{ q.label }}</button>
          <button v-for="t in BUBBLE_MOD_TYPES" v-show="!BUBBLE_QUICK_MODS.some((q) => q.type === t.type)"
                  :key="t.type" class="utils-btn utils-outline utils-xs" type="button"
                  :title="t.hint" :disabled="isImgMod(t.type) && hasImg"
                  @click="onAddModule(t.type)">{{ t.label }}</button>
        </div>

        <!-- 模块库面板 -->
        <div v-if="libOpen" class="bmp-lib">
          <p v-if="!lib.length" class="bmp-note">模块库还是空的：展开任意模块，点「存入模块库」把它存下来。</p>
          <div v-for="it in lib" :key="it.id" class="bmp-lib-item">
            <span class="bmp-lib-name">{{ it.name }}</span>
            <span class="bmp-lib-type">{{ modLabel(it.module?.type || '') }}</span>
            <button class="utils-btn utils-secondary utils-xs" type="button"
                    @click="onFromLib(it.id)">放进新行</button>
            <button class="utils-btn utils-danger utils-xs" type="button"
                    @click="onDelLib(it.id)">删</button>
          </div>
        </div>
      </div><!-- /.bmp-add -->

      <p v-if="flash.msg" class="bmp-msg" :class="flash.err ? 'err' : 'ok'">{{ flash.msg }}</p>
    </div><!-- /.bmp -->
  </div>
</template>

<style scoped>
/* 单泡模块面板：居中弹层里并排的两张卡（左预览 / 右编辑）。设计令牌来自 main.css 的 :root —— 
   var(--input-bg) / var(--fg) 这类主题变量是各 .page 定义的局部变量，故样式必须留在本组件 scoped，
   写进 main.css 会静默 fallback（见 main.css 的注释） */
.bmp-overlay {
  gap: 14px;
  align-items: stretch;
}
/* 左卡：常驻预览。内容高度固定（预览 + 一段问号说明），不参与滚动 */
.bmp-left {
  flex: 0 0 auto;
  align-self: center;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--input-bg);
  color: var(--fg);
}
.bmp-pv-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--fg-dim);
  font-weight: 600;
}
/* 右卡：编辑区。长到 88vh 后自己滚，滚列表时左边的预览不跟着卷走 */
.bmp {
  flex: 0 1 440px;
  max-height: 88vh;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--input-bg);
  color: var(--fg);
}
.bmp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bmp-title {
  font-size: 12px;
  color: var(--fg-dim);
  font-weight: 600;
}
/* A/B 侧切换：一排 chip，当前侧高亮（对齐上游 .dshwv-bubchip-btn / .dshwv-bubchip-cur） */
.bmp-sides {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0;
}
.bmp-chip {
  flex: 0 0 auto;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--fg);
  background: rgba(83, 107, 169, 0.08);
  border: 1px dashed var(--line);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}
.bmp-chip:hover {
  background: rgba(83, 107, 169, 0.18);
}
.bmp-chip-cur {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
.bmp-chip-color {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
}
.bmp-ask {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--accent);
  border-radius: 50%;
  background: none;
  color: var(--fg-dim);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}
.bmp-ask-on {
  background: var(--accent-weak);
}
.bmp-help {
  margin: 6px 0;
  font-size: 11px;
  color: var(--fg-faint);
  line-height: 1.6;
}
.bmp-row {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card-bg);
  /* 落点高亮是内联 boxShadow（见 dropStyle），过渡让它不硬闪 */
  transition: box-shadow 0.12s ease;
}
.bmp-row-drop {
  border-color: var(--accent);
}
/* 整行拖拽手柄：平时低调，悬停才显形，免得抢视线 */
.bmp-grip {
  flex: 0 0 auto;
  padding: 0 2px;
  font-size: 12px;
  line-height: 1;
  color: var(--fg-faint);
  cursor: grab;
  user-select: none;
}
.bmp-grip:hover {
  color: var(--accent);
}
.bmp-grip:active {
  cursor: grabbing;
}
.bmp-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bmp-row-idx {
  font-size: 11px;
  color: var(--fg-dim);
}
.bmp-row-ops {
  display: flex;
  gap: 4px;
}
.bmp-mods {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.bmp-row-empty {
  font-size: 11px;
  color: var(--fg-faint);
}
.bmp-mod {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card-bg);
}
.bmp-mod-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  cursor: pointer;
}
.bmp-mod-type {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--fg);
}
.bmp-mod-sum {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--fg-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bmp-mod-caret {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-faint);
}
.bmp-mod-body {
  padding: 8px;
  border-top: 1px dashed var(--line);
}
.bmp-f {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  font-size: 12px;
  color: var(--fg-dim);
}
.bmp-f > span:first-child {
  flex: 0 0 76px;
}
.bmp-f input[type='text'],
.bmp-f input[type='number'],
.bmp-f select,
.bmp-f textarea {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 6px;
  font-size: 12px;
  color: var(--fg);
  background: var(--input-bg);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.bmp-f textarea {
  font-family: inherit;
  resize: vertical;
}
.bmp-f-col {
  align-items: flex-start;
  flex-direction: column;
}
.bmp-f-col > span:first-child {
  flex: 0 0 auto;
}
.bmp-f-col textarea {
  width: 100%;
}
.bmp-sub {
  margin: 10px 0 2px;
  font-size: 11px;
  color: var(--fg-faint);
}
.bmp-grid {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.bmp-f-sm > span:first-child {
  flex: 0 0 auto;
}
.bmp-color {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.bmp-color input[type='color'] {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: none;
}
.bmp-color-hex {
  width: 84px;
}
.bmp-palette {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 6px 0;
}
.bmp-checks {
  display: flex;
  gap: 14px;
  margin: 6px 0;
  font-size: 12px;
  color: var(--fg-dim);
}
.bmp-checks label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.bmp-note {
  margin: 6px 0;
  font-size: 11px;
  color: var(--fg-faint);
  line-height: 1.6;
}
.bmp-mod-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.bmp-move {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-faint);
}
.bmp-move select {
  padding: 2px 4px;
  font-size: 11px;
  color: var(--fg);
  background: var(--input-bg);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.bmp-row-add {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.bmp-add-label {
  font-size: 11px;
  color: var(--fg-faint);
}
.bmp-add {
  margin-top: 10px;
}
.bmp-add-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bmp-quick {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.bmp-lib {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card-bg);
}
.bmp-lib-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.bmp-lib-item + .bmp-lib-item {
  border-top: 1px dashed var(--line);
}
.bmp-lib-name {
  font-size: 12px;
  color: var(--fg);
}
.bmp-lib-type {
  font-size: 11px;
  color: var(--fg-faint);
  margin-right: auto;
}
.bmp-empty {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--warn);
}
/* 列表下方空白落点：只在拖拽进行中显形（v-if="dragKind"），提示「拖到这里 = 挪到末尾」 */
.bmp-end {
  margin-top: 8px;
  padding: 8px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  text-align: center;
  font-size: 11px;
  color: var(--fg-faint);
}
.bmp-end-on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-weak);
}
.bmp-msg {
  margin: 8px 0 0;
  font-size: 12px;
}
.bmp-msg.ok {
  color: var(--ok);
}
.bmp-msg.err {
  color: var(--err);
}
</style>
