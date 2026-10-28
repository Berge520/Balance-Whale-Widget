<script lang="ts" setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { msgCls, useFlashShow } from '../composables/useFlash'
import type {
  FocusStatsResult,
  TodoItem,
  TodoLimits,
  TodoMutateResult,
  TodoState,
  WhaleServices,
} from '../types/services'

// 「专注与待办」整卡：专注记录开关 + 近 7 天统计 + 待办清单。
// 从 App.vue 抽出，沿用各 view 的范式：cfg 只读、落盘一律 emit('patch')；
// 待办与统计都是宿主持有的数据，写操作走 services.todo*，读快照走 services.todoGet / focusStats。
//
// 为什么编辑面只放在设置页：挂件窗口没有输入环境（见 floating-page.js 的同类注释），
// 那边只做「勾选完成 / 设为专注」两个只读动作，改名 / 删除 / 清除已完成都在这里。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写 focusOn / todoOn 两个键
  cfg: any
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局
  services: Partial<WhaleServices>
  // 输入法组字守卫（父级统一实现）：组字期间的回车是确认候选词，不能当成提交
  isImeComposing: (e: Event | undefined) => boolean
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
}>()

const { flash, show, stop } = useFlashShow(4000)

// 统计窗口：柱状图放 7 根柱刚好，再长就挤了
const STAT_DAYS = 7

function onCheckChange(key: string, e: Event) {
  emit('patch', { [key]: (e.target as HTMLInputElement).checked })
}

// —— 专注统计 ——
// setup 里同步取一次：focusStats 是纯本地读，不联网，没必要等 onMounted（否则首帧会闪一下空态）
const stats = ref<FocusStatsResult | null>(props.services.focusStats?.(STAT_DAYS) ?? null)
function reloadStats() {
  stats.value = props.services.focusStats?.(STAT_DAYS) ?? null
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
const statsSummary = computed(() => {
  const s = stats.value
  if (!s) return ''
  return `今日 ${s.today.r} 轮 / ${s.today.m} 分钟 · 连续 ${s.streak} 天 · 近 ${s.days} 天 ${s.total.m} 分钟（${s.total.r} 轮）`
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
function removeTodo(it: TodoItem) {
  if (editingId.value === it.id) editingId.value = ''
  applyResult(props.services.todoRemove?.(it.id))
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
  stop()
})
</script>

<template>
  <!-- [用量] 专注与待办：专注记录（开关 + 近 7 天统计）+ 待办清单（编辑面）。
       待办在挂件菜单里只读展示、可直接勾选完成；改名 / 删除 / 清除已完成的入口在本卡 -->
  <section class="card" data-search="focus">
    <h2>专注与待办</h2>

    <!-- 只有一个开关：早先拆成「专注记录 + 计时结束自动记录」两个，前者描述里就写着
         「计时结束后自动记一轮」，关掉后者后整条链路变成什么都不记 —— 用户只会以为开了功能却坏了 -->
    <label class="field row check">
      <span class="label">专注记录 <em>（倒计时走完自动记一轮，按天汇总）</em></span>
      <input type="checkbox" :checked="cfg.focusOn" @change="onCheckChange('focusOn', $event)" />
    </label>
    <p class="hint">
      只有「倒计时」走完才算一轮，分钟数按你设定的倒计时时长计（例如设 25 分钟就记 25 分钟）；正计时、定时与「休息」都不计。
      记录保留 90 天，可在「清除数据」里一起清掉。
    </p>

    <div class="focus-stat">
      <p v-if="stats && stats.total.r > 0" class="focus-sum">{{ statsSummary }}</p>
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
        最近 7 天还没有专注记录。开启上面的「专注记录」后，用挂件菜单的计时器倒计时走完就会自动记上。
      </p>
      <p v-else-if="stats" class="hint focus-empty">
        最近 7 天还没有专注记录。用挂件菜单的计时器倒计时走完，就会自动记上。
      </p>
    </div>

    <div v-if="cfg.focusOn" class="focus-goal">
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

    <label class="field row check todo-switch">
      <span class="label">待办清单 <em>（挂件菜单里显示待办，可直接勾选完成）</em></span>
      <input type="checkbox" :checked="cfg.todoOn" @change="onCheckChange('todoOn', $event)" />
    </label>
    <!-- 专注按钮与气泡尾注都受 focusOn 门控（见 floating-page.js 的 withFocusTail / todoRow），
         关着时这里不摆按钮，免得点了发现挂件里没反应 -->
    <p v-if="!cfg.focusOn" class="hint todo-focus-off">
      「设为专注」要先打开上方的「专注记录」：关着时挂件菜单里不显示专注按钮，计时气泡也不带「专注：xxx」尾注。
    </p>

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
        <span v-if="cfg.focusOn && todo.focusId === it.id" class="todo-tag">专注中</span>
        <span v-if="it.rounds > 0" class="todo-tag todo-rounds" :title="'已完成 ' + it.rounds + ' 轮'">{{ it.rounds }}轮</span>
        <template v-if="!it.done">
          <label class="todo-est" :title="'预估番茄轮数（0 = 未设置）'">
            <span class="todo-est-label">预估</span>
            <input type="number" class="todo-est-input" min="0" max="99" :value="it.est" @change="setEst(it, $event)" />
          </label>
          <button v-if="cfg.focusOn" class="link-btn utils-btn utils-secondary todo-act" type="button"
                  @click="toggleFocus(it)">
            {{ todo.focusId === it.id ? '取消专注' : '设为专注' }}
          </button>
          <button class="link-btn utils-btn utils-secondary todo-act" type="button" @click="startEdit(it)">改名</button>
        </template>
        <button class="link-btn utils-btn utils-secondary todo-act" type="button" @click="removeTodo(it)">删除</button>
      </li>
    </ul>
    <p v-else class="hint">还没有待办。在上面输入框写一条，回车即可添加。</p>

    <p v-if="todo.items.length" class="todo-count">
      已完成 {{ doneCount }} / 共 {{ todo.items.length }} 条<template v-if="limits">（上限 {{ limits.max }} 条）</template>
    </p>
    <div v-if="doneCount > 0" class="btn-row">
      <button class="secondary utils-btn utils-secondary" @click="clearDone">清除已完成（{{ doneCount }}）</button>
    </div>

    <p v-if="flash.msg" class="msg" :class="msgCls(flash)">{{ flash.msg }}</p>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --track / --input-bg 等）全部来自 main.css 的 :root；
   .field / .hint / .msg / .btn-row / .link-btn / utils 按钮档位也由 main.css 统一提供，
   这里只留本卡特有的统计图与待办列表样式。 */

.focus-stat {
  margin: 4px 0 16px;
}
.focus-goal {
  margin: 0 0 16px;
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

/* 待办：与专注统计之间留一条分隔，避免两件事视觉上粘在一起 */
.todo-switch {
  margin-top: 20px;
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
.todo-act {
  font-size: 12px;
}
.todo-count {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-faint);
}
</style>
