<script lang="ts" setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { msgCls, useFlashShow } from '../composables/useFlash'
import { useFold } from '../composables/useFold'
import type {
  TodoItem,
  TodoLimits,
  TodoMutateResult,
  TodoState,
  WhaleServices,
} from '../types/services'

// 「待办与计时」整卡：总开关 + 待办清单（编辑面）。
// 从 App.vue 抽出，沿用各 view 的范式：cfg 只读、落盘一律 emit('patch')；
// 待办是宿主持有的数据，写操作走 services.todo*，读快照走 services.todoGet。
//
// v1.16 起本卡的「统计 / 记录」层（今日几轮、连续天数、专注明细、每日目标）全部下线：
// 那一层要在计时之外额外维护「设目标 → 对齐 → 看进度」的习惯，对绝大多数用户没有决策价值，
// 而「一轮」的判定又严格（只有倒计时走完且非休息、非放弃才算），
// 做了正计时却显示 0 轮反而像没记上。计时与番茄循环不依赖它，关掉照常工作。
// 宿主侧的 focus.js / whale:focus 这一轮先保留不动（数据不丢，可逆），但设置页与挂件不再读。
//
// 挂件里的待办块可直接开始 / 勾选 / 快速添加；改名 / 删除 / 提醒 / 计时方式仍在这里。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写 todoOn（待办与计时的总开关）
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

function onCheckChange(key: string, e: Event) {
  emit('patch', { [key]: (e.target as HTMLInputElement).checked })
}

// —— 分区折叠：只有「今日」与「已完成」两个 ——
// 已完成的待办是「留着对账」的尾巴：勾掉不等于删掉，长期累积会把今天要做的顶到一屏以外，
// 故整体收进一个折叠组，标题上直接报条数。
// 与「计时」卡同一套范式（h3.card-sub-toggle：整行可点 + 三角 + 收起态摘要），
// 折叠态持久化，展开过一次下次还是展开。
// 搜索态另有一套开关（searchFoldClosed）：搜索命中时强制展开，用户仍可在搜索态下自己收起
type FoldKey = 'today' | 'done'
const folds: Record<FoldKey, { open: boolean }> = {
  today: useFold('focusToday', false),
  done: useFold('focusDone', false),
}
const searchFoldClosed = ref<Record<FoldKey, boolean>>({ today: false, done: false })
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
  if (on) searchFoldClosed.value = { today: false, done: false }
})

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
// 「开始」按钮文案：这条配了计时方式就叫「开始」，选「不计时」的那条点下去只会挂上专注标记，
// 所以如实叫「专注」—— 按钮文案必须能预告点了会发生什么，不能让人以为会跑一个计时。
function startLabel(it: TodoItem) {
  return it.tm === 'down' || it.tm === 'up' ? '开始' : '专注'
}
// 点「开始」：一次调用就把「设为当前专注 + 让挂件按这条自己的参数启动计时（tm / mins）」做完
// （宿主 todoFocus 的第二个参数 start，见 settings.js）。计时本体在挂件页，
// 设置页不复制一套计时状态。取消专注仍走挂件菜单里「专注中」按钮，或换一条点「开始」。
// ⚠️ 打完卡 / 计时结束不用清 focusId：focusId 只是「这条是当前任务」，到点后挂着是正常的
// （取消专注走挂件菜单）。所以拿它当「专注进行中」的指示灯会一直亮着 —— 那才是 v1.16 之前的毛病。
function startTodo(it: TodoItem) {
  const r = props.services.todoFocus?.(it.id, true)
  if (!r) { show('当前宿主不支持待办操作', true); return }
  applyResult(r)
  if (!r.ok) return
  // 不计时的条目点下去只会挂上专注标记，如实提示一声，别让人以为在跑计时
  if (it.tm !== 'down' && it.tm !== 'up') show('已标记为当前专注（这条设为不计时）')
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
// 折叠态摘要：只写非默认项（不计时 / 未提醒都不占字），收起来也不丢信息
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
  if (it.tm === 'down') parts.push(`倒计时 ${it.mins} 分`)
  else if (it.tm === 'up') parts.push('正计时')
  // 提醒的摘要归提醒那一行自己（remindBrief），这里不重复，否则收起态会出现两次「提醒 …」
  return parts.join(' · ')
}

// 「今日」区折叠：总开关配一次就不动，日常进这张卡是为了写待办；
// 收起态直接说出开没开 —— 早先这块常驻在卡头，把单条待办推到一屏以外
const todayBrief = computed(() => {
  return props.cfg.todoOn ? '已开启 · 挂件里显示待办与计时入口' : '未开启 · 挂件里不显示待办'
})
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

// 未完成与已完成分开渲染。已完成项长期累积（勾掉不等于删掉），混在同一张列表里
// 会把今天要做的事一路顶下去 —— 所以已完成整体收进一个折叠组，标题上直接报条数
const openTodoList = computed(() => todo.value.items.filter((x) => !x.done))
const doneList = computed(() => todo.value.items.filter((x) => x.done))
const doneCount = computed(() => doneList.value.length)

// 高级设置里的「提醒」再收一层：计时方式与改名是一次性的，提醒要在四种频次 + 周几 + 时刻
// 里挑，展开就是一大片。收起态用摘要（每天 09:00 这种）兜住，展开后才出现全部控件
const remindOpen = ref<Record<string, boolean>>({})
function toggleRemind(it: TodoItem) {
  remindOpen.value[it.id] = !remindOpen.value[it.id]
}

// 订阅宿主推送：挂件里勾选 / 设为专注，都会让本页立刻跟上。
// v1.16 起不再订阅 onFocusChange —— 本页已不显示轮次与明细，计时结束无需刷新这里
let unsubTodo: (() => void) | undefined
onMounted(() => {
  unsubTodo = props.services.onTodoChange?.((t) => { todo.value = t })
})
onUnmounted(() => {
  unsubTodo?.()
  stopUndoTimer()
  stop()
})
</script>

<template>
  <!-- [用量] 待办与计时：总开关 + 待办清单（编辑面）。
       待办在挂件「待办」组里可直接开始 / 勾选完成；改名 / 删除 / 清除已完成的入口在本卡 -->
  <section class="card-embedded" data-search="focus">

    <!-- 今日：先回答「开没开」，再往下才是清单。
         只有一个总开关（v1.15 把「专注记录」与「挂件里显示待办」并成一个）：
         两个开关各关一半时，用户说不清「我到底开了什么」，也常出现「关了记录却在奇怪为什么没统计」 -->
    <!-- 今日区默认收起（配一次就不动），收起态直接播报开没开；
         搜索命中时强制展开（同下方其它低频分区口径） -->
    <h3 class="card-sub card-sub-toggle" role="button" tabindex="0"
        :aria-expanded="foldOpen('today')"
        @click="toggleFold('today')"
        @keydown.enter.prevent="toggleFold('today')"
        @keydown.space.prevent="toggleFold('today')">
      今日<span class="fold-caret">{{ foldOpen('today') ? '▾' : '▸' }}</span>
      <em v-if="!foldOpen('today')">{{ todayBrief }}</em>
    </h3>
    <template v-if="foldOpen('today')">
    <label class="field row check">
      <span class="label">待办与计时 <em>（挂件里显示待办与计时入口）</em></span>
      <input type="checkbox" :checked="cfg.todoOn" @change="onCheckChange('todoOn', $event)" />
    </label>
    <p class="hint">
      只管挂件是否显示待办与计时；到点提示与休息时长见下方「计时设置」。
    </p>
    </template>

    <h3 class="card-sub">待办清单</h3>
    <!-- 开始 / 设为专注只依赖待办本身；总开关只管「挂件里显不显示、记不记账」 -->
    <div class="todo-add">
      <input type="text" :value="newText" :maxlength="limits?.textMax"
             placeholder="添加一条待办，回车保存" @input="onNewInput" @keydown.enter="onAddEnter" />
      <button class="utils-btn utils-primary" @click="addTodo">添加</button>
    </div>

    <!-- 空态顺手把三个隐藏操作说出来：改名 / 计时与提醒都藏在「更多」里，
         第一次来的人不会自己想到去双击文字 -->
    <p v-if="!todo.items.length" class="hint">
      还没有待办。上方输入框写一条回车即添加；双击文字改名，「更多」里设计时与提醒。
    </p>

    <!-- 未完成：常显。行内只放「最常按得到」的动作，其余收进「更多」 -->
    <ul v-if="openTodoList.length" class="todo-list">
      <li v-for="it in openTodoList" :key="it.id" class="todo-item"
          :class="{ focus: todo.focusId === it.id }">
        <input type="checkbox" :checked="it.done" aria-label="标记为已完成"
               @change="toggleDone(it, $event)" />
        <input v-if="editingId === it.id" ref="editInput" class="todo-edit" type="text"
               :value="editingText" :maxlength="limits?.textMax"
               @input="onEditInput" @keydown.enter="onEditEnter" @keydown.esc="cancelEdit"
               @blur="commitEdit" />
        <span v-else class="todo-text" :title="it.text + '（双击修改）'" @dblclick="startEdit(it)">{{ it.text }}</span>
        <!-- v1.16 起不再挂「当前任务 / 专注中」标签：focusId 到点、暂停、打完卡都不清，
             拿它当指示灯会一直亮着骗人。状态只由行底色 + 按钮淡化暗示，
             真正的「还在计时吗」由挂件里的计时窗口回答 -->
        <!-- 行内操作区：固定在主行右侧（窄窗整组换行）。只放动作，
             折叠摘要 / 高级设置另行整行，避免把按钮挤到下一行、每行看着三层高 -->
        <span class="todo-ops">
          <!-- 「开始」= 设为当前专注 + 让挂件按这条自己的计时方式启动（v1.16 起）。
               原来这里是「设为专注 / 取消专注」独立按钮，与「开始」并列 —— 做一件事却要按两下，
               且挂件里同一个位置叫「开始」，两处心智对不上。现在：
               · 未专注 → 点它一次性完成「专注 + 开始」，不计时的那条只标专注（文案随之为「专注」）
               · 已专注 → 不重复发 focus（宿主是开关语义，再发会取消），只把计时拉起来 -->
          <button class="todo-act todo-start" type="button"
                  :title="todo.focusId === it.id ? '在挂件里开始这条的计时' : startLabel(it)"
                  @click="startTodo(it)">{{ todo.focusId === it.id ? '开始' : startLabel(it) }}</button>
          <button class="todo-act todo-more" type="button"
                  :aria-expanded="!!openTodo[it.id]" @click="toggleTodoMore(it)">
            {{ openTodo[it.id] ? '收起' : '更多' }}<span class="todo-caret" aria-hidden="true">{{ openTodo[it.id] ? '▴' : '▾' }}</span>
          </button>
          <button class="todo-act todo-del" type="button" @click="removeTodo(it)">删除</button>
        </span>
        <!-- 折叠态摘要：非默认设置用一行灰字兜住，收起来也不丢信息 -->
        <span v-if="!openTodo[it.id] && todoBrief(it)" class="todo-sum">{{ todoBrief(it) }}</span>
        <!-- 高级设置：计时 / 时长 / 提醒 / 改名。默认收起，避免每行常显五六个控件 -->
        <div v-if="openTodo[it.id]" class="todo-adv">
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
            <!-- 指向：这里的分钟数只管这一条待办；全局默认时长与四档快捷按钮在下方「计时设置」里认 -->
            <span class="todo-hint">默认时长与档位见下方「计时设置」</span>
          </label>
          <button class="todo-act" type="button" @click="startEdit(it)">改名</button>
          <!-- 提醒单独一层折叠：四种频次 + 周几 + 时刻一起展开就是一大片，
               而绝大多数待办并不需要提醒；收起态摘要直接播报「每天 09:00」 -->
          <span class="todo-remind-row">
            <button class="todo-act todo-remind-toggle" type="button"
                    :aria-expanded="!!remindOpen[it.id]" @click="toggleRemind(it)">
              提醒<span class="todo-caret" aria-hidden="true">{{ remindOpen[it.id] ? '▴' : '▾' }}</span>
            </button>
            <em v-if="!remindOpen[it.id]" class="todo-remind-brief">{{ remindBrief(it) || '未设置' }}</em>
          </span>
          <label v-if="remindOpen[it.id]" class="todo-remind" title="到点只提醒，不自动开始计时">
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
        </div>
      </li>
    </ul>

    <!-- 已完成：整体折叠，标题直接报条数。勾掉只是「留着对账」，
         不该继续占着今天的视线；展开后条目与未完成同一套行结构 -->
    <template v-if="doneList.length">
      <h3 class="card-sub card-sub-toggle" role="button" tabindex="0"
          :aria-expanded="foldOpen('done')"
          @click="toggleFold('done')"
          @keydown.enter.prevent="toggleFold('done')"
          @keydown.space.prevent="toggleFold('done')">
        已完成<span class="fold-caret">{{ foldOpen('done') ? '▾' : '▸' }}</span>
        <em>共 {{ doneCount }} 条</em>
      </h3>
      <ul v-if="foldOpen('done')" class="todo-list">
        <li v-for="it in doneList" :key="it.id" class="todo-item done">
          <input type="checkbox" :checked="it.done" aria-label="标记为未完成"
                 @change="toggleDone(it, $event)" />
          <!-- 已完成条目只是被一条实线划掉（.todo-item.done .todo-text），不删除、不挪走：
               留在「已完成」折叠组里对账，勾选框随时能点回来 -->
          <input v-if="editingId === it.id" ref="editInput" class="todo-edit" type="text"
                 :value="editingText" :maxlength="limits?.textMax"
                 @input="onEditInput" @keydown.enter="onEditEnter" @keydown.esc="cancelEdit"
                 @blur="commitEdit" />
          <span v-else class="todo-text" :title="it.text + '（双击修改）'" @dblclick="startEdit(it)">{{ it.text }}</span>
          <span class="todo-ops">
            <button class="todo-act todo-del" type="button" @click="removeTodo(it)">删除</button>
          </span>
        </li>
      </ul>
    </template>

    <!-- 上限只在快满时才说：平时「上限 200 条」对用户没有意义，
         快满时它才是「该清一清了」的提醒 -->
    <p v-if="todo.items.length" class="todo-count">
      已完成 {{ doneCount }} / 共 {{ todo.items.length }} 条<template v-if="limits && todo.items.length >= limits.max - 5">（上限 {{ limits.max }} 条，可清除已完成腾位置）</template>
    </p>
    <div v-if="doneCount > 0" class="btn-row">
      <button class="secondary utils-btn utils-secondary" @click="clearDone">清除已完成（{{ doneCount }}）</button>
    </div>

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
   也由 main.css 统一提供，这里只留本卡特有的待办列表样式。 */

/* v1.16 随「统计 / 记录」层下线的样式：7 天柱图（.focus-stat / .focus-bars）、
   90 天热力图、今日摘要（.focus-sum）、每日目标（.focus-goal*）、
   专注明细（.focus-log* 与 .badge-*）。宿主侧 focus.js 与 whale:focus 暂留未删，
   若哪天要把统计接回来，样式需一并恢复 —— 故这里不逐个注释回溯 */

/* 待办列表 */
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
/* 已完成：一条实线划掉、但不删条目 —— 留着对账，也随时能点回来。
   用 1px solid（不是默认的 line-through 细单线，也不必双线）：和正文同一档虚实，
   读起来是「划掉了」而不是「看不清的灰字」 */
.todo-item.done .todo-text {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
  text-decoration-color: var(--fg);
  color: var(--fg-faint);
}
/* v1.16 起待办行不挂任何常驻文字标签：focusId 到点 / 暂停 / 打完卡都不清，
   拿它当指示灯会一直亮着骗人。真正的「还在计时吗」由挂件里的计时窗口回答 */
.todo-edit {
  flex: 1;
  min-width: 0;
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
/* 指向「计时设置」的一句：只在高级设置里出现，弱色小字，跟在计时下拉后面 */
.todo-hint {
  margin-left: 4px;
  color: var(--muted);
  font-size: 11px;
}
/* 行内小标签（计时 / 分 / 提醒）：同档字号与弱色，宽度吃内容 */
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
/* 到点提醒：与「计时」同一档字号与弱色，时刻输入框放宽到能放下 datetime-local 的日期 */
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
/* 提醒开关行：默认收起只露「提醒 ▸ 每天 09:00」这一条，展开后才出现频次 / 周几 / 时刻 */
.todo-remind-row {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
}
.todo-remind-brief {
  font-size: 11px;
  font-style: normal;
  color: var(--fg-faint);
  white-space: nowrap;
}
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
.todo-start {
  color: var(--accent);
  background: var(--accent-weak);
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
}
.todo-start:hover {
  color: var(--accent);
  background: var(--accent-weak);
  border-color: var(--accent);
}
/* 已在专注中：整行已有强调底色，按钮改成描边即可，避免和行底色糊在一起。
   「不用再点」也靠这一点暗示：灰下去的不是重点，重点在行本身 */
.todo-item.focus .todo-start {
  background: transparent;
  color: var(--fg-dim);
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
}
.todo-more,
.todo-remind-toggle {
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
