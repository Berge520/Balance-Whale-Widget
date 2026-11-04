<script lang="ts" setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { msgCls, useFlashShow } from '../composables/useFlash'
import { useFold } from '../composables/useFold'
import type {
  FocusSession,
  FocusStatsResult,
  TodoItem,
  TodoLimits,
  TodoMutateResult,
  TodoState,
  WhaleServices,
} from '../types/services'

// 「专注与待办」整卡：今日概览 + 待办清单（编辑面）+ 专注统计与明细。
// 从 App.vue 抽出，沿用各 view 的范式：cfg 只读、落盘一律 emit('patch')；
// 待办与统计都是宿主持有的数据，写操作走 services.todo*，读快照走 services.todoGet / focusStats。
//
// 挂件里的待办块可直接开始 / 勾选 / 快速添加；改名 / 删除 / 提醒 / 预估 / 清除已完成仍在这里。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写 focusOn / todoOn 两个键
  cfg: any
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局
  services: Partial<WhaleServices>
  // 输入法组字守卫（父级统一实现）：组字期间的回车是确认候选词，不能当成提交
  isImeComposing: (e: Event | undefined) => boolean
  // 搜索态：命中时强制展开分区（否则「搜到了统计却看不见统计」，与 TimerView 同口径）
  searchActive: boolean
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
}>()

const { flash, show, stop } = useFlashShow(4000)

// 统计窗口：柱状图放 7 根柱刚好，再长就挤了。明细列表共用这一个常量（见下方 reloadSessions）。
// 真源在宿主 constants.FOCUS_STATS_DAYS；设置页拿不到 preload 常量，这份副本由 check-shared 钉住
const STAT_DAYS = 7

function onCheckChange(key: string, e: Event) {
  emit('patch', { [key]: (e.target as HTMLInputElement).checked })
}

// —— 专注统计 ——
// setup 里同步取一次：focusStats 是纯本地读，不联网，没必要等 onMounted（否则首帧会闪一下空态）
const stats = ref<FocusStatsResult | null>(props.services.focusStats?.(STAT_DAYS) ?? null)
function reloadStats() {
  stats.value = props.services.focusStats?.(STAT_DAYS) ?? null
  reloadHeat()
  reloadSessions()
}
// 柱高按窗口内最大值归一；全是 0 时用 1 兜底，避免除零
const barMax = computed(() => {
  const s = stats.value
  if (!s) return 1
  return Math.max(1, ...s.series.map((d) => d.m))
})
// 有分钟数按比例给高度；0 分钟留 2px 基线，让「这天没练」也有柱位、不塌成空白
function barH(m: number) {
  if (!(m > 0)) return '2px'
  return Math.max(4, Math.round((m / barMax.value) * 100)) + '%'
}
// —— 近 90 天热力图 ——
// 7 根柱只能看出一周，看不出「坚持了多久、有没有断」；13×7 的格子才看得出。
// 窗口取宿主保留上限（FOCUS_KEEP_DAYS = 90），与上面柱图同一份数据源、只是窗口更长。
// 单独取一份而不是把 STAT_DAYS 改大：柱图 7 根刚好，拉长会挤成一条线。
// 真源在宿主 constants.FOCUS_KEEP_DAYS；这份副本由 check-shared 钉住
const HEAT_DAYS = 90
const heatStats = ref<FocusStatsResult | null>(props.services.focusStats?.(HEAT_DAYS) ?? null)
function reloadHeat() {
  heatStats.value = props.services.focusStats?.(HEAT_DAYS) ?? null
}

// —— 近 7 天趋势（并入摘要行，不单独占一段） ——
// 只给「比上次多了多少」，不做好坏评价：专注是长期节奏，某天少练不等于退步。
// 数据来自已有的 90 天序列，不额外取数。
const trendText = computed(() => {
  const s = heatStats.value
  if (!s || s.series.length < 8) return ''
  const sumR = (list: FocusStatsResult['series']) => list.reduce((a, d) => a + d.r, 0)
  const last7 = sumR(s.series.slice(-7))
  const prev7 = sumR(s.series.slice(-14, -7))
  if (!last7 && !prev7) return ''
  if (!prev7) return `近 7 天 ${last7} 轮`
  if (!last7) return `近 7 天没有记录`
  if (last7 === prev7) return `近 7 天 ${last7} 轮，与前 7 天持平`
  return `近 7 天 ${last7} 轮，比前 7 天${last7 > prev7 ? '多' : '少'} ${Math.abs(last7 - prev7)} 轮`
})

// 一行摘要：今日 / 连续 / 近 7 天趋势 / 日均。柱图与热力图负责「每天多少」，不再重复成段
const statsSummary = computed(() => {
  const s = stats.value
  if (!s) return ''
  // 「日均」的分母必须是**有记录的天**，不能是窗口天数：7 天里只练了 3 天时，
  // 按 7 天算会把日均摊薄成「几乎没练」
  const activeDays = s.series.filter((d) => d.m > 0).length
  const avg = activeDays > 0 ? Math.round(s.total.m / activeDays) : 0
  const avgText = activeDays > 0 ? ` · 日均 ${avg} 分钟` : ''
  const trend = trendText.value ? ` · ${trendText.value}` : ''
  return `今日 ${s.today.r} 轮 · ${s.today.m} 分钟 · 连续 ${s.streak} 天${trend}${avgText}`
})
// 首格前面补空位，让同一列落在同一个星期几上（0 = 周日，与 Date#getDay 一致）
const heatCells = computed(() => {
  const s = heatStats.value
  const cells: Array<{ date: string; r: number; m: number } | null> = []
  if (!s || !s.series.length) return cells
  const first = new Date(s.series[0].date + 'T00:00:00')
  const pad = Number.isFinite(first.getTime()) ? first.getDay() : 0
  for (let i = 0; i < pad; i++) cells.push(null)
  for (const d of s.series) cells.push(d)
  return cells
})
// 90 天里一次都没有就不画（避免给新用户摆一整块空格子）
const heatHasData = computed(() => !!heatStats.value && heatStats.value.series.some((d) => d.m > 0))
const heatRange = computed(() => {
  const s = heatStats.value
  if (!s || !s.series.length) return ''
  return s.series[0].date.slice(5) + ' ~ ' + s.series[s.series.length - 1].date.slice(5)
})
const heatAria = computed(() => {
  const s = heatStats.value
  if (!s) return ''
  const active = s.series.filter((d) => d.m > 0).length
  return `近 ${s.days} 天专注热力图：${active} 天有记录，合计 ${s.total.m} 分钟`
})
// 色阶按「当天专注分钟」分档，档位按 25 分钟一轮的常见节奏切：
// ≤1 轮 / ≤2 轮 / ≤4 轮 / 更多。0 分钟另有底色（与柱图的零值柱同色）
function heatLevel(m: number) {
  if (!(m > 0)) return 0
  if (m <= 25) return 1
  if (m <= 50) return 2
  if (m <= 100) return 3
  return 4
}

// —— 专注记录（会话明细）——
// 柱图看的是「每天多少」，这里回答「今天/昨天具体哪几轮、各做了什么」。
// 窗口与柱图共用 STAT_DAYS（必须同值：分组头数字取柱图那份天表，窗口不一致就缺数字）；
// 更早的明细翻起来费劲，长期趋势看上方的热力图就够了。
// 老宿主没有这个服务：整块日志不渲染，其余统计照常工作
const hasSessionApi = typeof props.services.focusSessions === 'function'
const sessions = ref<FocusSession[]>(props.services.focusSessions?.(STAT_DAYS) ?? [])
function reloadSessions() {
  sessions.value = props.services.focusSessions?.(STAT_DAYS) ?? []
}
function fmtClock(t: number) {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes())
}
// 服务端已按时间倒序；这里只把同一天收拢成一组，并补上「今天 / 昨天」标签。
// 日期基准用 stats 序列的最后两格（宿主本地日），而不是浏览器的 new Date()：
// 跨零点前后两边可能差一天，用同一份数据源才不会出现「昨天」标签跳位
//
// 分组头的「N 轮 · M 分钟」取宿主天表（与柱图、热力图同一份 series），不在这里按明细累加：
// 明细里现在有三类「只记时长、不算一轮」的行（正计时 / 定时 / 中途放弃），休息行连时长都不进天表。
// 早先这里写的是 cur.r += 1 / cur.m += s.m，一进 v2 会话模型就会和上方柱图打架 —— 口径只该有一处。
const seriesByDate = computed(() => {
  const map: Record<string, { r: number; m: number }> = {}
  for (const d of stats.value?.series || []) map[d.date] = { r: d.r, m: d.m }
  return map
})
type SessionGroup = {
  date: string
  label: string
  sum: { r: number; m: number } | null
  items: FocusSession[]
}
const sessionGroups = computed<SessionGroup[]>(() => {
  const list = sessions.value
  if (!list.length) return []
  const series = stats.value?.series || []
  const today = series.length ? series[series.length - 1].date : ''
  const yesterday = series.length > 1 ? series[series.length - 2].date : ''
  const byDate = seriesByDate.value
  const groups: SessionGroup[] = []
  let cur: SessionGroup | null = null
  for (const s of list) {
    if (!cur || cur.date !== s.d) {
      cur = {
        date: s.d,
        label: s.d === today ? '今天' : s.d === yesterday ? '昨天' : s.d.slice(5),
        // 查不到这天（明细窗口比统计窗口长时才会发生）就给 null：
        // 宁可这组不报数，也不自己编一个和柱图不同的口径
        sum: byDate[s.d] || null,
        items: [],
      }
      groups.push(cur)
    }
    cur.items.push(s)
  }
  return groups
})
// 徽标只回答一件事：这条为什么算 / 不算一轮。没有徽标的行就是走完的一轮。
// round 由宿主派生（focus.js 的 isRound 唯一口径），这里只读
const MODE_LABEL: Record<string, string> = { down: '倒计时', up: '正计时', at: '定时' }
function sessionBadges(s: FocusSession): Array<{ cls: string; text: string }> {
  const out: Array<{ cls: string; text: string }> = []
  if (s.k && s.k !== 'down') out.push({ cls: 'badge-mode', text: MODE_LABEL[s.k] || s.k })
  if (s.b) out.push({ cls: 'badge-rest', text: '休息' })
  if (s.a) out.push({ cls: 'badge-abort', text: '放弃' })
  return out
}
function sessionTitle(s: FocusSession): string {
  if (s.round) return '这一轮计入轮数与时长'
  // 休息行在宿主天表里轮数和时长都不聚合，写「只记时长」会和分组头对不上（列表多 5 分钟、头上不涨）
  if (s.b) return '休息：只做一行标记，轮数和时长都不计入'
  return (MODE_LABEL[s.k] || '倒计时') + (s.a ? '中途放弃' : '结束') + '：只记时长，不算一轮'
}
// 有历史统计、却没有一条明细：这是升级前的老数据（当时只按天汇总）
const sessionStale = computed(() => hasSessionApi && !sessions.value.length
  && (heatStats.value?.total.r || 0) > 0)

// —— 分区折叠：统计与明细都是「回头再看」的长块 ——
// 本卡默认只留「今日 + 待办清单」，统计与明细收起，卡片不再一进来就顶到两屏开外。
// 与「计时」卡同一套范式（h3.card-sub-toggle：整行可点 + 三角 + 收起态摘要），
// 折叠态持久化，展开过一次下次还是展开。
// 搜索态另有一套开关（searchFoldClosed）：搜索命中时强制展开，用户仍可在搜索态下自己收起
type FoldKey = 'stat' | 'log'
const folds: Record<FoldKey, { open: boolean }> = {
  stat: useFold('focusStat', false),
  log: useFold('focusLog', false),
}
const searchFoldClosed = ref<Record<FoldKey, boolean>>({ stat: false, log: false })
function foldOpen(key: FoldKey) {
  return props.searchActive ? !searchFoldClosed.value[key] : folds[key].open
}
function toggleFold(key: FoldKey) {
  if (props.searchActive) {
    searchFoldClosed.value = { ...searchFoldClosed.value, [key]: !searchFoldClosed.value[key] }
    return
  }
  folds[key].open = !folds[key].open
}
// 每次进入搜索态都重置：上一轮搜索里手动收起的，不该让这一轮也看不见
watch(() => props.searchActive, (on) => {
  if (on) searchFoldClosed.value = { stat: false, log: false }
})
// 收起态的摘要：把「有多少」先说出来，收起不等于把信息藏没
const statBrief = computed(() => {
  const s = stats.value
  if (!s || !s.total.r) return '暂无记录'
  return `近 ${STAT_DAYS} 天 ${s.total.r} 轮 · ${s.total.m} 分钟`
})
// 今日轮数（待办行的徽标）：与仪表盘/挂件同源，任务删了只是查不到，不影响历史明细
function todayRoundsOf(id: string) {
  return stats.value?.todayByTodo?.[id] || 0
}

// —— 待办清单 ——
// limits 拿不到（老宿主）时按 null 处理：输入框不加 maxlength，上限交给宿主报错兜底，
// 这里不复制一份 60 / 200 的常量副本（单一来源是宿主 constants.js）
const todo = ref<TodoState>(props.services.todoGet?.() ?? { items: [], focusId: '' })
const limits = ref<TodoLimits | null>(props.services.todoLimits?.() ?? null)

// 所有写操作的统一回填：成功只回填清单（不弹提示，避免每次勾选都闪一行），
// 失败把宿主给的原因原样展示 —— 文案（内容为空 / 条数已达上限 / 条目不存在…）只在宿主维护一份
function applyResult(r?: TodoMutateResult) {
  if (!r) {
    show('当前宿主不支持待办操作', true)
    return
  }
  todo.value = r.todo
  if (!r.ok) show(r.error || '操作失败', true)
}

const newText = ref('')
function onNewInput(e: Event) {
  newText.value = (e.target as HTMLInputElement).value
}
function onAddEnter(e: KeyboardEvent) {
  if (props.isImeComposing(e)) return
  addTodo()
}
function addTodo() {
  const t = newText.value.trim()
  if (!t) return
  const r = props.services.todoAdd?.(t)
  if (!r) {
    show('当前宿主不支持待办操作', true)
    return
  }
  applyResult(r)
  // 失败时保留原文：用户改一改（比如超长被截断）就能再提交，不用重打
  if (r.ok) newText.value = ''
}

// 行内改名：Enter 提交、Esc 取消、失焦提交。
// commitEdit 先清 editingId 再写：Enter 提交后输入框被卸载，若浏览器再补一个 blur，
// 第二次进到这里会因 editingId 为空直接返回，不会重复提交（也不会把 Esc 的取消又提交回去）
const editingId = ref('')
const editingText = ref('')
const editInput = ref<HTMLInputElement | HTMLInputElement[] | null>(null)
function startEdit(it: TodoItem) {
  editingId.value = it.id
  editingText.value = it.text
  openTodo.value[it.id] = false // 改名输入框占整行，高级设置块先收起免得换行错位
}
function onEditInput(e: Event) {
  editingText.value = (e.target as HTMLInputElement).value
}
function onEditEnter(e: KeyboardEvent) {
  if (props.isImeComposing(e)) return
  commitEdit()
}
function commitEdit() {
  const id = editingId.value
  if (!id) return
  editingId.value = ''
  const t = editingText.value.trim()
  const it = todo.value.items.find((x) => x.id === id)
  // 没改或改成空串都不落库：空串在宿主那也会被拒（「内容为空」），这里直接当取消处理
  if (!it || !t || t === it.text) return
  applyResult(props.services.todoRename?.(id, t))
}
function cancelEdit() {
  editingId.value = ''
}
watch(editingId, (v) => {
  if (!v) return
  nextTick(() => {
    const el = editInput.value
    const node = Array.isArray(el) ? el[0] : el
    node?.focus()
    node?.select()
  })
})

function toggleDone(it: TodoItem, e: Event) {
  applyResult(props.services.todoSetDone?.(it.id, (e.target as HTMLInputElement).checked))
}
function toggleFocus(it: TodoItem) {
  applyResult(props.services.todoFocus?.(it.id))
}
function setEst(it: TodoItem, e: Event) {
  const n = Math.max(0, Math.min(99, Math.round(Number((e.target as HTMLInputElement).value) || 0)))
  applyResult(props.services.todoSetEst?.(it.id, n))
}

// —— 每条待办自己的计时方式（学番茄 todo）——
// 方式用下拉（倒计时 / 正计时 / 不计时），倒计时再配一个分钟输入框（1–600，默认 25）。
// 不做固定档位：番茄钟的时长本来就因人而异（25 是默认，不是唯一），档位下拉会逼用户
// 为了 30 分钟去挂件菜单里改全局目标
const TIMER_MODES: Array<{ v: 'down' | 'up' | ''; label: string }> = [
  { v: 'down', label: '倒计时' },
  { v: 'up', label: '正计时' },
  { v: '', label: '不计时' },
]
function setTodoTimerMode(it: TodoItem, e: Event) {
  const tm = (e.target as HTMLSelectElement).value as 'down' | 'up' | ''
  applyResult(props.services.todoSetTimer?.(it.id, tm, Number(it.mins) || 25))
}
function setTodoTimerMins(it: TodoItem, e: Event) {
  const n = Math.max(1, Math.min(600, Math.round(Number((e.target as HTMLInputElement).value) || 25)))
  applyResult(props.services.todoSetTimer?.(it.id, it.tm === 'up' || it.tm === '' ? it.tm : 'down', n))
}

// —— 到点提醒 ——
// 只提醒、不自动开始计时：到点判定与分发都在宿主（preload 的 reminders.js + services 的 tick），
// 这里只负责把用户选的形态 / 时刻写回，回填仍走 applyResult（失败原因由宿主给）
const REMIND_KINDS = [
  { v: 'once', label: '一次性' },
  { v: 'daily', label: '每天' },
  { v: 'weekdays', label: '工作日' },
  { v: 'weekly', label: '每周' },
] as const
const WEEK_DAYS = [
  { v: 1, label: '一' }, { v: 2, label: '二' }, { v: 3, label: '三' }, { v: 4, label: '四' },
  { v: 5, label: '五' }, { v: 6, label: '六' }, { v: 0, label: '日' },
]
function setRemind(it: TodoItem, patch: Record<string, any>) {
  applyResult(props.services.todoSetDue?.(it.id, {
    remindOn: it.remindOn, remindKind: it.remindKind, remindAt: it.remindAt, remindDow: it.remindDow, ...patch,
  }))
}
function onRemindToggle(it: TodoItem, e: Event) {
  const on = (e.target as HTMLInputElement).checked
  const kind = it.remindKind || 'once'
  // 重复形态的 0 只可能是「未选时刻」，而 0 分钟正好是 00:00：直接开等于半夜响。
  // 所以开启时补 09:00（540）；一次性没有默认时刻，保持 0（= 还没选时间，不参与判定）
  const at = on && kind !== 'once' ? it.remindAt || 540 : it.remindAt
  setRemind(it, { remindOn: on, remindAt: at })
}
function onRemindKind(it: TodoItem, e: Event) {
  const kind = (e.target as HTMLSelectElement).value
  const at = Number(it.remindAt) || 0
  // once 存绝对 ms、其余存当天分钟数，两套量纲不能原样搬过去：
  // 分钟数被 once 当成 epoch ms → 1970 年，宿主扫描到「已到点」会立刻补一条提醒；
  // ms 被重复形态 clamp → 23:59。所以换形态时重算：能读回「几点」就带过去，
  // 读不回来就回落（重复 09:00 / 一次性置空 = 还没选时刻）
  let nextAt = at
  if (kind === 'once') {
    nextAt = 0
  } else if (at > 1439) {
    const d = new Date(at)
    nextAt = d.getHours() * 60 + d.getMinutes()
  } else if (!at) {
    nextAt = 540
  }
  setRemind(it, { remindKind: kind, remindAt: nextAt })
}
function onRemindDow(it: TodoItem, e: Event) {
  setRemind(it, { remindDow: Number((e.target as HTMLSelectElement).value) || 0 })
}
// once 用 datetime-local（转 ms）；其余用 time（转当天分钟数）
function remindShown(it: TodoItem): string {
  const at = Number(it.remindAt) || 0
  if (it.remindKind === 'once') {
    if (!at) return ''
    const d = new Date(at)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(at / 60))}:${p(at % 60)}`
}
function onRemindTime(it: TodoItem, e: Event) {
  const el = e.target as HTMLInputElement
  const v = el.value
  if (!v) {
    // 重复形态的 remindAt 是当天分钟数，0 在引擎里是合法 00:00（会半夜提醒）：
    // 清空输入表达不了「不设时刻」，这里回退原值 —— 要停提醒只能关掉勾选。
    // once 的 0 表示「还没选时间」，保持原语义
    if (it.remindKind !== 'once') { el.value = remindShown(it); return }
    setRemind(it, { remindAt: 0 })
    return
  }
  if (it.remindKind === 'once') {
    const ms = new Date(v).getTime()
    setRemind(it, { remindAt: Number.isFinite(ms) ? ms : 0 })
  } else {
    const [h, m] = v.split(':').map((x) => Number(x) || 0)
    setRemind(it, { remindAt: Math.max(0, Math.min(1439, h * 60 + m)) })
  }
}

// —— 行内折叠：高级设置默认收起，折叠态用一行摘要兜住非默认值 ——
const openTodo = ref<Record<string, boolean>>({})
function toggleTodoMore(it: TodoItem) {
  openTodo.value[it.id] = !openTodo.value[it.id]
}
// 折叠态摘要：只写非默认项（预估 0 / 不计时 / 未提醒都不占字），收起来也不丢信息
function remindBrief(it: TodoItem): string {
  if (!it.remindOn) return ''
  const at = Number(it.remindAt) || 0
  const kind = it.remindKind || 'once'
  const p = (n: number) => String(n).padStart(2, '0')
  if (kind === 'once') {
    if (!at) return '提醒 未选时间'
    const d = new Date(at)
    return `提醒 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const kindLabel = kind === 'daily' ? '每天' : kind === 'weekdays' ? '工作日' : '每周'
  return `提醒 ${kindLabel} ${p(Math.floor(at / 60))}:${p(at % 60)}`
}
function todoBrief(it: TodoItem): string {
  const parts: string[] = []
  if (it.est > 0) parts.push(`预估 ${it.est} 轮`)
  if (it.tm === 'down') parts.push(`倒计时 ${it.mins} 分`)
  else if (it.tm === 'up') parts.push('正计时')
  const r = remindBrief(it)
  if (r) parts.push(r)
  return parts.join(' · ')
}

// —— 每日专注目标 ——
const goalInput = ref<HTMLInputElement | null>(null)
function onGoalInput(e: Event) {
  const n = Math.max(0, Math.min(99, Math.round(Number((e.target as HTMLInputElement).value) || 0)))
  emit('patch', { focusGoal: n })
}
const goalProgress = computed(() => {
  const goal = props.cfg.focusGoal || 0
  if (goal <= 0) return null
  const today = stats.value?.today.r || 0
  const pct = Math.min(100, Math.round((today / goal) * 100))
  return { today, goal, pct, done: today >= goal }
})
// 待办计划：未完成条目里「填了预估」的剩余轮数之和（est - 已完成 rounds，最小 0）。
// 只做展示汇总，不新增字段；未填预估的条目只计入条数，不虚构轮数。
const todoPlanText = computed(() => {
  const items = todo.value.items.filter((x) => !x.done)
  if (!items.length) return ''
  let left = 0
  let withEst = 0
  for (const it of items) {
    const est = Math.max(0, Math.round(Number(it.est) || 0))
    if (!est) continue
    withEst += 1
    left += Math.max(0, est - (Number(it.rounds) || 0))
  }
  return withEst ? `待办 ${items.length} 条 · 预估剩 ${left} 轮` : `待办 ${items.length} 条`
})
const todoPlanTitle = '按每条填写的预估轮数减去已完成轮数；未填预估的不计'
function removeTodo(it: TodoItem) {
  if (editingId.value === it.id) editingId.value = ''
  const r = props.services.todoRemove?.(it.id)
  applyResult(r)
  // 只有真删掉才给撤回入口；宿主失败（条目已不存在 / 写盘失败）时不再提「已删除」
  if (r && r.ok) showUndo(it)
}

// —— 删除撤回 ——
// 删除由宿主立即执行（挂件侧同步消失）；宿主在内存里留最近一条快照，这里只负责撤回条的生命周期。
// 刻意不在前端延迟删除：那样关掉设置页 / 插件崩溃会让「已删除」变成没删，挂件也会在撤回窗口里
// 继续显示旧数据，等于把一次性操作拆成两套事实。
const UNDO_MS = 8000
const undo = ref<{ id: string; text: string } | null>(null)
let undoTimer = 0
function stopUndoTimer() {
  if (undoTimer) { window.clearTimeout(undoTimer); undoTimer = 0 }
}
function dismissUndo() {
  stopUndoTimer()
  undo.value = null
}
function showUndo(it: TodoItem) {
  stopUndoTimer()
  undo.value = { id: it.id, text: it.text }
  undoTimer = window.setTimeout(dismissUndo, UNDO_MS)
}
// 悬停时暂停自动消失：8 秒对「看到提示再移鼠标去点」刚好够，但别让手慢的用户点空
function pauseUndo() { stopUndoTimer() }
function resumeUndo() {
  if (undo.value && !undoTimer) undoTimer = window.setTimeout(dismissUndo, UNDO_MS)
}
function undoRemove() {
  const cur = undo.value
  if (!cur) return
  dismissUndo()
  const r = props.services.todoUndoRemove?.(cur.id)
  if (!r) { show('当前宿主不支持撤回', true); return }
  applyResult(r)
  if (r.ok) show(`已撤回删除「${cur.text}」`)
}
function clearDone() {
  applyResult(props.services.todoClearDone?.())
}

// 未完成在前、已完成在后（各自保持存储内相对顺序）：
// 已完成的条目通常只是「留着看一眼」，压在上面会把今天要做的挤下去
const orderedTodo = computed(() => {
  const items = todo.value.items
  return items.filter((x) => !x.done).concat(items.filter((x) => x.done))
})
const doneCount = computed(() => todo.value.items.filter((x) => x.done).length)

// 订阅宿主推送：挂件里勾选 / 设为专注、计时结束记一轮，都会让本页立刻跟上
let unsubTodo: (() => void) | undefined
let unsubFocus: (() => void) | undefined
onMounted(() => {
  unsubTodo = props.services.onTodoChange?.((t) => { todo.value = t })
  unsubFocus = props.services.onFocusChange?.(() => { reloadStats() })
})
onUnmounted(() => {
  unsubTodo?.()
  unsubFocus?.()
  stopUndoTimer()
  stop()
})
</script>

<template>
  <!-- [用量] 专注与待办：今日概览 + 待办清单（编辑面）+ 专注统计与明细。
       待办在挂件「专注」组里可直接开始 / 勾选完成；改名 / 删除 / 清除已完成的入口在本卡 -->
  <section class="card-embedded" data-search="focus">

    <!-- 今日：先回答「今天做了多少、还差多少」，再往下才是清单与统计。
         只有一个记录开关：早先拆成两个，关掉后者整条链路什么都不记，用户只会以为开了功能却坏了 -->
    <h3 class="card-sub">今日</h3>
    <label class="field row check">
      <span class="label">专注记录 <em>（每轮计时记成明细，按天汇总）</em></span>
      <input type="checkbox" :checked="cfg.focusOn" @change="onCheckChange('focusOn', $event)" />
    </label>
    <template v-if="cfg.focusOn">
      <p class="hint">
        倒计时走完算 1 轮；正计时、定时、半途放弃只记时长，记录保留 90 天。只决定记录与统计，不挡任务开始。
      </p>
      <p v-if="stats && stats.total.r > 0" class="focus-sum">{{ statsSummary }}</p>
      <div class="focus-goal">
        <label class="field row focus-goal-row">
          <span class="label">每日目标 <em>（轮数，0 = 不设）</em></span>
          <input ref="goalInput" type="number" class="focus-goal-input" min="0" max="99"
                 :value="cfg.focusGoal" @change="onGoalInput" />
        </label>
        <div v-if="goalProgress" class="focus-goal-progress">
          <div class="focus-goal-bar">
            <div class="focus-goal-fill" :class="{ done: goalProgress.done }" :style="{ width: goalProgress.pct + '%' }"></div>
          </div>
          <span class="focus-goal-text" :class="{ done: goalProgress.done }">
            今日 {{ goalProgress.today }} / {{ goalProgress.goal }} 轮
            <template v-if="goalProgress.done">🎉 已达成</template>
          </span>
        </div>
      </div>
    </template>
    <p v-if="todoPlanText" class="hint focus-plan" :title="todoPlanTitle">{{ todoPlanText }}</p>

    <h3 class="card-sub">待办清单</h3>
    <label class="field row check todo-switch">
      <span class="label">挂件里显示待办 <em>（菜单里可直接勾选）</em></span>
      <input type="checkbox" :checked="cfg.todoOn" @change="onCheckChange('todoOn', $event)" />
    </label>
    <!-- 开始 / 设为专注只依赖待办本身；focusOn 只决定是否记录与统计 -->
    <div class="todo-add">
      <input type="text" :value="newText" :maxlength="limits?.textMax"
             placeholder="添加一条待办，回车保存" @input="onNewInput" @keydown.enter="onAddEnter" />
      <button class="utils-btn utils-primary" @click="addTodo">添加</button>
    </div>

    <ul v-if="orderedTodo.length" class="todo-list">
      <li v-for="it in orderedTodo" :key="it.id" class="todo-item"
          :class="{ done: it.done, focus: todo.focusId === it.id }">
        <input type="checkbox" :checked="it.done"
               :aria-label="it.done ? '标记为未完成' : '标记为已完成'"
               @change="toggleDone(it, $event)" />
        <input v-if="editingId === it.id" ref="editInput" class="todo-edit" type="text"
               :value="editingText" :maxlength="limits?.textMax"
               @input="onEditInput" @keydown.enter="onEditEnter" @keydown.esc="cancelEdit"
               @blur="commitEdit" />
        <span v-else class="todo-text" :title="it.text + '（双击修改）'" @dblclick="startEdit(it)">{{ it.text }}</span>
        <span v-if="todo.focusId === it.id" class="todo-tag">专注中</span>
        <span v-if="cfg.focusOn && todayRoundsOf(it.id) > 0" class="todo-tag todo-today"
              :title="'今天在这条待办上完成 ' + todayRoundsOf(it.id) + ' 轮'">今日 {{ todayRoundsOf(it.id) }} 轮</span>
        <span v-if="it.est > 0" class="todo-tag todo-rounds"
              :title="'累计完成 ' + it.rounds + ' 轮 / 预估 ' + it.est + ' 轮'">{{ it.rounds }}/{{ it.est }} 轮</span>
        <span v-else-if="it.rounds > 0" class="todo-tag todo-rounds"
              :title="'累计完成 ' + it.rounds + ' 轮'">累计 {{ it.rounds }} 轮</span>
        <!-- 行内操作区：固定在主行右侧（窄窗整组换行）。只放动作，
             折叠摘要 / 高级设置另行整行，避免把按钮挤到下一行、每行看着三层高 -->
        <span class="todo-ops">
          <template v-if="!it.done">
            <button class="todo-act todo-focus" :class="{ 'is-on': todo.focusId === it.id }" type="button"
                    @click="toggleFocus(it)">
              {{ todo.focusId === it.id ? '取消专注' : '设为专注' }}
            </button>
            <button class="todo-act todo-more" type="button"
                    :aria-expanded="!!openTodo[it.id]" @click="toggleTodoMore(it)">
              {{ openTodo[it.id] ? '收起' : '更多' }}<span class="todo-caret" aria-hidden="true">{{ openTodo[it.id] ? '▴' : '▾' }}</span>
            </button>
          </template>
          <button class="todo-act todo-del" type="button" @click="removeTodo(it)">删除</button>
        </span>
        <template v-if="!it.done">
          <!-- 折叠态摘要：非默认设置用一行灰字兜住，收起来也不丢信息 -->
          <span v-if="!openTodo[it.id] && todoBrief(it)" class="todo-sum">{{ todoBrief(it) }}</span>
          <!-- 高级设置：预估 / 计时 / 时长 / 提醒 / 改名。默认收起，避免每行常显五六个控件 -->
          <div v-if="openTodo[it.id]" class="todo-adv">
            <label class="todo-est" :title="'预估番茄轮数（0 = 未设置）'">
              <span class="todo-est-label">预估</span>
              <input type="number" class="todo-est-input" min="0" max="99" :value="it.est" @change="setEst(it, $event)" />
            </label>
            <label class="todo-timer" title="挂件里点这条的「开始」时，按这个方式计时">
              <span class="todo-est-label">计时</span>
              <select class="todo-timer-select" :value="it.tm" @change="setTodoTimerMode(it, $event)">
                <option v-for="m in TIMER_MODES" :key="m.v" :value="m.v">{{ m.label }}</option>
              </select>
              <template v-if="it.tm === 'down'">
                <input class="todo-est-input" type="number" min="1" max="600" step="1"
                       title="倒计时分钟数（1–600）" :value="it.mins" @change="setTodoTimerMins(it, $event)" />
                <span class="todo-est-label">分</span>
              </template>
            </label>
            <label class="todo-remind" title="到点只提醒，不自动开始计时">
              <span class="todo-est-label">提醒</span>
              <input type="checkbox" :checked="it.remindOn" @change="onRemindToggle(it, $event)" />
              <template v-if="it.remindOn">
                <select class="todo-timer-select" :value="it.remindKind" @change="onRemindKind(it, $event)">
                  <option v-for="k in REMIND_KINDS" :key="k.v" :value="k.v">{{ k.label }}</option>
                </select>
                <select v-if="it.remindKind === 'weekly'" class="todo-timer-select" :value="it.remindDow" @change="onRemindDow(it, $event)">
                  <option v-for="w in WEEK_DAYS" :key="w.v" :value="w.v">周{{ w.label }}</option>
                </select>
                <input :type="it.remindKind === 'once' ? 'datetime-local' : 'time'"
                       class="todo-est-input" :value="remindShown(it)" @change="onRemindTime(it, $event)" />
              </template>
            </label>
            <button class="todo-act" type="button" @click="startEdit(it)">改名</button>
          </div>
        </template>
      </li>
    </ul>
    <p v-else class="hint">还没有待办。在上面输入框写一条，回车即可添加。</p>

    <p v-if="todo.items.length" class="todo-count">
      已完成 {{ doneCount }} / 共 {{ todo.items.length }} 条<template v-if="limits">（上限 {{ limits.max }} 条）</template>
    </p>
    <div v-if="doneCount > 0" class="btn-row">
      <button class="secondary utils-btn utils-secondary" @click="clearDone">清除已完成（{{ doneCount }}）</button>
    </div>


    <h3 class="card-sub card-sub-toggle" role="button" tabindex="0"
        :aria-expanded="foldOpen('stat')"
        @click="toggleFold('stat')"
        @keydown.enter.prevent="toggleFold('stat')"
        @keydown.space.prevent="toggleFold('stat')">
      专注统计<span class="fold-caret">{{ foldOpen('stat') ? '▾' : '▸' }}</span>
      <em v-if="!foldOpen('stat')">{{ statBrief }}</em>
    </h3>
    <template v-if="foldOpen('stat')">
    <div class="focus-stat">
      <div v-if="stats && stats.total.r > 0" class="focus-bars">
        <div v-for="(d, i) in stats.series" :key="d.date" class="focus-bar-cell"
             :title="`${d.date} · ${d.r} 轮 · ${d.m} 分钟`">
          <div class="focus-bar-wrap">
            <div class="focus-bar" :class="{ zero: !(d.m > 0) }" :style="{ height: barH(d.m) }"></div>
          </div>
          <span class="focus-bar-label">{{ i === stats.series.length - 1 ? '今天' : d.date.slice(5) }}</span>
        </div>
      </div>
      <p v-else-if="stats && !cfg.focusOn" class="hint focus-empty">
        开启「专注记录」后，跑一段计时就会记在这里。
      </p>
      <!-- 柱图按「轮」聚合，明细什么段都收：只有正计时 / 定时 / 放弃时会出现「图是空的、列表有行」，
           这时候说「还没有专注记录」就是在骗人，得把两行数字对上 -->
      <p v-else-if="stats && sessions.length" class="hint focus-empty">
        柱状图只画「轮」；明细里的 {{ sessions.length }} 段时长照常保留。
      </p>
      <p v-else-if="stats" class="hint focus-empty">
        跑一段计时就会记进下面的明细。
      </p>
      <!-- 近 90 天热力图：7 根柱只能看出一周，13×7 的格子才看得出「断没断」。
           90 天里一次都没有就整块不画 —— 新用户不必看一整块空格子 -->
      <div v-if="heatHasData" class="heat">
        <div class="heat-head">
          <span class="heat-title">近 {{ heatStats?.days || HEAT_DAYS }} 天</span>
          <span class="heat-range">{{ heatRange }}</span>
          <span class="heat-legend">
            <em>少</em>
            <i class="heat-swatch lvl-1"></i><i class="heat-swatch lvl-2"></i>
            <i class="heat-swatch lvl-3"></i><i class="heat-swatch lvl-4"></i>
            <em>多</em>
          </span>
        </div>
        <div class="heat-grid" role="img" :aria-label="heatAria">
          <span v-for="(c, i) in heatCells" :key="i" class="heat-cell"
                :class="c ? 'lvl-' + heatLevel(c.m) : 'pad'"
                :title="c ? `${c.date} · ${c.r} 轮 · ${c.m} 分钟` : ''"></span>
        </div>
      </div>
    </div>
    </template>

    <!-- 专注记录明细：柱图看「每天多少」，这里回答「具体哪几轮、各做了什么」。
         高度封顶、内部滚动 —— 7 天几十轮不滚动的话会把下面的待办清单推到很远。
         区名和「最近 N 天 · M 条」都并进分区标题：列表里再挂一个自己的表头，同一件事就有两个说法 -->
    <template v-if="sessionGroups.length || sessionStale">
      <h3 class="card-sub card-sub-toggle" role="button" tabindex="0"
          :aria-expanded="foldOpen('log')"
          @click="toggleFold('log')"
          @keydown.enter.prevent="toggleFold('log')"
          @keydown.space.prevent="toggleFold('log')">
        专注明细<span class="fold-caret">{{ foldOpen('log') ? '▾' : '▸' }}</span>
        <em v-if="!foldOpen('log')">最近 {{ STAT_DAYS }} 天<template v-if="sessionGroups.length"> · {{ sessions.length }} 条</template></em>
      </h3>
      <template v-if="foldOpen('log')">
      <div class="focus-log">
        <ul v-if="sessionGroups.length" class="focus-log-list">
          <li v-for="g in sessionGroups" :key="g.date" class="focus-log-day">
            <div class="focus-log-date">
              <span class="focus-log-day-label">{{ g.label }}</span>
              <span v-if="g.sum" class="focus-log-day-sum">{{ g.sum.r }} 轮 · {{ g.sum.m }} 分钟</span>
            </div>
            <ul class="focus-log-items">
              <li v-for="(s, i) in g.items" :key="s.id || (g.date + '-' + i)" class="focus-log-item"
                  :class="{ 'is-extra': !s.round }" :title="sessionTitle(s)">
                <span class="focus-log-time">{{ fmtClock(s.t) }}</span>
                <span class="focus-log-mins">{{ s.m }} 分钟</span>
                <span v-for="(b, bi) in sessionBadges(s)" :key="bi" class="focus-log-badge" :class="b.cls">{{ b.text }}</span>
                <span v-if="s.todoText" class="focus-log-todo" :title="s.todoText">{{ s.todoText }}</span>
                <span v-else class="focus-log-todo focus-log-none">未关联待办</span>
              </li>
            </ul>
          </li>
        </ul>
        <p v-else class="hint focus-empty">
          之前的专注只按天汇总；从现在起每一轮都会列在这里。
        </p>
      </div>
      </template>
    </template>

    <!-- 删除撤回：固定视口底部，长列表也不会把提示滚出视野；
         Teleport 到 body，避免被卡片 / 吸顶条裁掉；悬停暂停自动消失 -->
    <Teleport to="body">
      <div v-if="undo" class="todo-undo" role="status" aria-live="polite"
           @mouseenter="pauseUndo" @mouseleave="resumeUndo">
        <span class="todo-undo-text" :title="undo.text">已删除「{{ undo.text }}」</span>
        <button class="todo-undo-btn" type="button" @click="undoRemove">撤回</button>
        <button class="todo-undo-close" type="button" aria-label="关闭撤回提示" @click="dismissUndo">×</button>
      </div>
    </Teleport>

    <p v-if="flash.msg" class="msg" :class="msgCls(flash)">{{ flash.msg }}</p>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --track / --input-bg 等）全部来自 main.css 的 :root；
   .field / .hint / .msg / .btn-row / .link-btn / utils 按钮档位 / 分区标题 .card-sub
   也由 main.css 统一提供，这里只留本卡特有的统计图与待办列表样式。 */

.focus-stat {
  margin: 4px 0 16px;
}
/* 跨卡链接：默认时长 / 番茄规则在「计时」卡，本卡只留每条待办的计时方式 */
.focus-goal {
  margin: 0 0 16px;
}
/* 待办计划行：今日块末尾的一行弱色汇总，不占独立分区 */
.focus-plan {
  margin: 0 0 12px;
}
.focus-goal-row {
  margin: 0 0 8px;
}
.focus-goal-input {
  width: 64px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--input-bg);
  font-size: 13px;
  text-align: center;
}
.focus-goal-input::-webkit-inner-spin-button {
  opacity: 0.5;
}
.focus-goal-progress {
  display: flex;
  align-items: center;
  gap: 12px;
}
.focus-goal-bar {
  flex: 1;
  height: 8px;
  background: var(--track);
  border-radius: 4px;
  overflow: hidden;
}
.focus-goal-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.3s ease;
}
.focus-goal-fill.done {
  background: var(--success, #4caf50);
}
.focus-goal-text {
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.focus-goal-text.done {
  color: var(--success, #4caf50);
  font-weight: 500;
}
.focus-sum {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--fg-dim);
}
.focus-bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 92px;
}
.focus-bar-cell {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.focus-bar-wrap {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  background: var(--track);
  border-radius: 4px;
  overflow: hidden;
}
.focus-bar {
  width: 100%;
  background: var(--accent);
  border-radius: 4px;
}
/* 0 分钟的柱只留一条基线，用淡色区分「没记录」而不是「记录了很少」 */
.focus-bar.zero {
  background: var(--line);
}
.focus-bar-label {
  margin-top: 4px;
  font-size: 11px;
  color: var(--fg-faint);
  white-space: nowrap;
}
.focus-empty {
  margin: 0;
}
/* 对比回顾：与柱图同一窗口的「比上次多/少」，弱色 + 左侧细线，像一句旁注而不是新面板 */

/* —— 专注记录明细 ——
   区名与条数在分区标题（.card-sub）里，这里只管列表本身。
   高度封顶内部滚动：7 天几十轮全铺开会把下面的待办清单推到很远；
   overscroll-behavior 防止滚到底后继续带着整页滚 */
.focus-log {
  margin: 0 0 16px;
}
.focus-log-list {
  list-style: none;
  margin: 0;
  padding: 0 4px 0 0;
  max-height: 220px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.focus-log-day {
  padding: 6px 0;
  border-top: 1px dashed var(--line);
}
.focus-log-day:first-child {
  padding-top: 0;
  border-top: none;
}
.focus-log-date {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.focus-log-day-label {
  color: var(--fg);
  font-weight: 600;
}
.focus-log-day-sum {
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
}
.focus-log-items {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.focus-log-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 4px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg-dim);
}
.focus-log-item:hover {
  background: var(--track);
}
.focus-log-time {
  flex: 0 0 auto;
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
}
.focus-log-mins {
  flex: 0 0 auto;
}
/* 徽标：解释「这条为什么不算一轮」，所以只给不计轮的三种情况加彩色底，
   走完的倒计时保持无徽标 —— 满屏标签比没标签更难读 */
.focus-log-badge {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--track);
  font-size: 11px;
  line-height: 16px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.badge-rest {
  border-color: rgba(46, 160, 67, 0.4);
  color: #2ea043;
}
.badge-abort {
  border-color: rgba(207, 103, 35, 0.4);
  color: #cf6723;
}
/* 不计轮的行整行压暗：一眼能扫出「哪些进了轮数」，不用逐条读徽标 */
.focus-log-item.is-extra .focus-log-mins,
.focus-log-item.is-extra .focus-log-todo {
  color: var(--fg-faint);
}
.focus-log-todo {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}
.focus-log-none {
  color: var(--fg-faint);
}

/* —— 近 90 天热力图 ——
   13 列 × 7 行（列 = 周，行 = 星期几），grid-auto-flow:column 让数据按周自然折行。
   色阶不用 color-mix：那要 Chromium 111+，且变量本身带 alpha 时不可靠；
   深浅两套各给一份固定 rgba，与 --accent 同源（浅 #536ba9 / 深 #8aa4e6） */
.heat {
  margin: 12px 0 0;
}
.heat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--fg-dim);
}
.heat-title {
  color: var(--fg);
  font-weight: 600;
}
.heat-range {
  color: var(--fg-faint);
}
.heat-legend {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  color: var(--fg-faint);
}
.heat-legend em {
  font-style: normal;
  font-size: 11px;
}
.heat-swatch,
.heat-cell {
  display: inline-block;
  width: 13px;
  height: 13px;
  border-radius: 3px;
  background: var(--track);
}
.heat-swatch {
  width: 11px;
  height: 11px;
}
/* 13 列 × 7 行固定尺寸的方格：卡片本身是整宽的，但热力图必须保持正方形格子，
   所以不拉伸、整体居中（横向铺满会变成 50px 宽的长条） */
.heat-grid {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(7, 13px);
  gap: 3px;
  justify-content: center;
}
.heat-cell.pad {
  background: transparent;
}
/* 0 分钟沿用 .heat-cell 的 --track 底色（与柱图零值柱同色），以下只覆盖有记录的四档 */
.lvl-1 { background: rgba(83, 107, 169, 0.25); }
.lvl-2 { background: rgba(83, 107, 169, 0.45); }
.lvl-3 { background: rgba(83, 107, 169, 0.68); }
.lvl-4 { background: rgba(83, 107, 169, 0.92); }
html.dark .lvl-1 { background: rgba(138, 164, 230, 0.25); }
html.dark .lvl-2 { background: rgba(138, 164, 230, 0.45); }
html.dark .lvl-3 { background: rgba(138, 164, 230, 0.68); }
html.dark .lvl-4 { background: rgba(138, 164, 230, 0.92); }

/* 待办：与专注统计之间留一条分隔，避免两件事视觉上粘在一起 */
.todo-switch {
  margin-top: 0;
}
.todo-add {
  display: flex;
  gap: 8px;
  margin: 12px 0 0;
}
.todo-add input[type='text'] {
  flex: 1;
  min-width: 0;
}
.todo-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.todo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
  flex-wrap: wrap;
}
/* 专注中的条目整行描边强调：挂件里显示的「当前任务」就是它 */
.todo-item.focus {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.todo-text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--fg);
  word-break: break-all;
  cursor: text;
}
.todo-item.done .todo-text {
  text-decoration: line-through;
  color: var(--fg-faint);
}
.todo-edit {
  flex: 1;
  min-width: 0;
}
.todo-tag {
  padding: 0 6px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  font-size: 11px;
  color: var(--accent);
  white-space: nowrap;
}
.todo-rounds {
  border-color: var(--line);
  color: var(--fg-dim);
  background: var(--track);
}
/* 今日轮数：与「累计 N 轮」区分开 —— 今日是行动信号，用主题色底衬托；累计是历史，保持灰调 */
.todo-today {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-weak);
}
/* 折叠态摘要：非默认设置收成一行灰字，控件收起来也不丢信息 */
.todo-sum {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 高级设置块：独占一整行，与主行用虚线分隔 */
.todo-adv {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}
.todo-est {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.todo-est-label {
  font-size: 11px;
}
.todo-est-input {
  width: 48px;
  padding: 2px 4px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--input-bg);
  font-size: 12px;
  text-align: center;
}
.todo-est-input::-webkit-inner-spin-button {
  opacity: 0.5;
}
/* 计时方式下拉：与「预估」同一行同一档字号，宽度吃内容（最长「倒计时 45 分钟」） */
.todo-timer {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.todo-timer-select {
  padding: 2px 4px;
  font-size: 12px;
}
/* 到点提醒：与「预估 / 计时」同一档字号与弱色，时刻输入框放宽到能放下 datetime-local 的日期 */
.todo-remind {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.todo-remind .todo-est-input { width: 130px; }
/* 行内操作区：固定在主行右侧；窄窗时整组换行而不是把三个按钮拆散 */
.todo-ops {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  margin-left: auto;
  flex-wrap: wrap;
}
/* 行内动作：去掉「每个按钮一圈边框 + 下划线」的重观感，收成紧凑胶囊。
   主操作（设为专注）用主题色底，更多是中性弱色，删除平时弱色、悬停才警示 ——
   一行三四个按钮不再互相抢注意力 */
.todo-act {
  height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.todo-act:hover {
  background: var(--line);
  color: var(--fg);
}
.todo-act:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.todo-focus {
  color: var(--accent);
  background: var(--accent-weak);
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
}
.todo-focus:hover {
  color: var(--accent);
  background: var(--accent-weak);
  border-color: var(--accent);
}
/* 已在专注中：整行已有强调底色，按钮改成描边即可，避免和行底色糊在一起 */
.todo-focus.is-on,
.todo-focus.is-on:hover {
  background: transparent;
}
.todo-more {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.todo-caret {
  font-size: 9px;
  opacity: 0.7;
}
.todo-del {
  color: var(--fg-faint);
}
.todo-del:hover {
  color: var(--err);
  background: color-mix(in srgb, var(--err) 12%, transparent);
}
.todo-count {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-faint);
}
/* 删除撤回条：固定底部居中。底色走 --bar-bg（与吸顶 Tab 条同一份不透明底），
   不用 --card-bg / --input-bg 的半透明玻璃 —— 压在两页内容上会透出下面的字，读不清。
   左侧强调色条 + 悬停暂停自动消失，兼顾「一眼看到」与「手慢也能撤回」。 */
.todo-undo {
  position: fixed;
  left: 50%;
  bottom: 22px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  background: var(--bar-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 12px;
  color: var(--fg);
  transform: translateX(-50%);
  animation: todo-undo-in 0.18s ease-out;
}
.todo-undo-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.todo-undo-btn {
  flex: none;
  height: 24px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: filter 0.15s;
}
.todo-undo-btn:hover { filter: brightness(1.08); }
.todo-undo-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.todo-undo-close {
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--fg-faint);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.todo-undo-close:hover {
  color: var(--fg);
  background: var(--line);
}
@keyframes todo-undo-in {
  from { opacity: 0; transform: translate(-50%, 8px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .todo-undo { animation: none; }
}
</style>
