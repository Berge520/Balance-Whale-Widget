<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { cloneBubbleItems, isChoiceStep, setStepModules, stepLabel, stepModules } from '../composables/useBubble'
import BubbleQueueEditor from '../components/BubbleQueueEditor.vue'
import BubbleModPanel from '../components/BubbleModPanel.vue'

// 「按压气泡（自定义泡泡）」整卡：点击队列 → 每步一个泡 → 泡里按行摆模块。
// 这是上游「自定义泡泡」编辑器的适配移植版（数据层 / 渲染层本项目早已齐备，缺的就是这套编辑 UI）。
//
// 落在本卡而不是塞进「挂件外观」的理由：编辑器自身有队列 + 泡 + 行 + 模块四层结构与
// 十几种模块类型的属性面板，体量远超外观卡；且上游本来就是独立面板，独立成卡才能被搜索直接命中
// （挂件菜单「气泡设置」→ openSettings('bubble') → App.vue 的 onNavigate 会切到本卡）。
//
// 数据入口是 props.cfg.bubble（宿主 store.js 的 normBubble 出口，形态恒定）：
//   { v:1, on, items, lib, tapAdvance, dwell, dragLines, system }
// 落盘一律 emit('patch', { bubble: {...} }) 整份覆盖 —— normBubble 是按键合并的，
// 只传 items 不会洗掉 on / dwell / dragLines / system（阶段 2 只动 items 与 on）。

const props = defineProps<{
  // 挂件配置整体传入：本卡只读写 cfg.bubble 与 cfg.bubbleOn（思考气泡）
  cfg: any
  // 挂件是否已显示：未显示时试播发不出去，按钮置灰并说明原因（宿主 bubblePreview 同口径）
  widgetVisible: boolean
}>()
// 挂件菜单「气泡设置」的导航（宿主 emitNavigate → 切外观 Tab + 滚到本卡）由 App.vue 的 onMounted
// 统一订阅：卡片是 v-if 渲染的，订阅放组件里会「未激活 Tab 时收不到导航」，故本组件不碰它。

const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
}>()

type Flash = { msg: string; err: boolean }
const flash = reactive<Flash>({ msg: '', err: false })
function msgCls(f: Flash) { return { ok: !f.err, err: f.err } }

// —— 显示用派生值 ——
// items 恒为数组（宿主归一化保证），这里再兜一层，避免旧配置 / 手工改库导致渲染期 undefined
const items = computed<any[]>(() => (props.cfg?.bubble && Array.isArray(props.cfg.bubble.items) ? props.cfg.bubble.items : []))
// 气泡总开关：本卡不搬气泡的外层开关，只做「按压气泡」自己的 on（与「思考气泡」并列，互不影响）
const bubbleOn = computed(() => props.cfg?.bubble?.on === true)

// —— 撤销 / 重做 ——
// 只覆盖本卡的三个编辑入口（队列 / 泡内容 / 模块库），不 watch props.cfg：宿主推送的回填
// （挂件菜单改动、备份恢复）不是用户在编辑器里的操作，记进去会「没动过也能撤销出别的状态」。
// 快照用 cloneBubbleItems 深拷贝（试播载荷同款），与 props 引用脱钩 —— 回填会整份换掉 cfg.bubble，
// 浅引用入栈等于存了个「未来的状态」。
type UndoState = { items: any[]; lib: any[] }
const undoStack = ref<UndoState[]>([])
const redoStack = ref<UndoState[]>([])
// 泡内容面板是逐键回抛（textPatch 走 @input），不合并的话打一句「你好」就压进七八个快照。
// 用合并窗口聚成一步：窗口内连续改动只更新栈顶，超过 600ms 或换了编辑对象才算新一步
const MERGE_MS = 600
let lastPushAt = 0
let lastEditKey = ''
let mergeTimer: number | undefined

function snapshot(): UndoState {
  return {
    items: cloneBubbleItems(props.cfg?.bubble?.items),
    lib: cloneBubbleItems(props.cfg?.bubble?.lib),
  }
}
// 记一步可撤销的编辑：把改动前的状态压栈、清空重做栈。各 emit 入口在改 payload 前调用
function pushUndo(editKey: string) {
  const now = Date.now()
  // 同一编辑对象且在合并窗口内 → 只把栈顶更新为「改动前」的最新近邻（第一次已压过，不重复压）
  if (editKey === lastEditKey && now - lastPushAt < MERGE_MS && undoStack.value.length) {
    lastPushAt = now
    if (mergeTimer !== undefined) window.clearTimeout(mergeTimer)
    mergeTimer = window.setTimeout(() => { lastEditKey = '' }, MERGE_MS)
    return
  }
  undoStack.value.push(snapshot())
  if (undoStack.value.length > 50) undoStack.value.shift()
  redoStack.value = []
  lastPushAt = now
  lastEditKey = editKey
  if (mergeTimer !== undefined) window.clearTimeout(mergeTimer)
  mergeTimer = window.setTimeout(() => { lastEditKey = '' }, MERGE_MS)
}
function undo() {
  const prev = undoStack.value.pop()
  if (!prev) return
  resetConfirm.value = false
  redoStack.value.push(snapshot())
  lastEditKey = ''
  emit('patch', { bubble: { items: prev.items, lib: prev.lib } })
  editing.value = null
}
function redo() {
  const next = redoStack.value.pop()
  if (!next) return
  resetConfirm.value = false
  undoStack.value.push(snapshot())
  lastEditKey = ''
  emit('patch', { bubble: { items: next.items, lib: next.lib } })
  editing.value = null
}
const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)
// 快捷键 Ctrl+Z / Ctrl+Y（含 Ctrl+Shift+Z 反向）：输入框聚焦时不拦，让正常打字退格不受干扰
function onUndoKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const k = e.key.toLowerCase()
  if (k !== 'z' && k !== 'y') return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  e.preventDefault()
  if (k === 'z' && !e.shiftKey) undo()
  else redo()
}
onMounted(() => window.addEventListener('keydown', onUndoKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onUndoKey)
  if (mergeTimer !== undefined) window.clearTimeout(mergeTimer)
})

// —— 试播：把当前队列整份发给挂件真弹一次（宿主 bubblePreview → whale:bubble-preview）——
// 载荷必须与配置脱钩（挂件那边会存引用），故走 cloneBubbleItems 深拷贝
const previewing = ref(false)
// 编辑器折叠态（队列 + 模块库两层长列表）：纯展示态、不给父级，故留组件内部。
// 默认展开 —— 本卡主要功能就是编辑器，折起来只服务「只想看 / 改开关」的人
const editorCollapsed = ref(false)
// 整卡折叠：本卡与「挂件外观」同属外观 Tab，且编辑器折起来后仍占一整屏，
// 故再给一层卡级折叠（沿 dsh 卡的 .card-toggle 范式），默认展开、可收起。
// 收起态摘要播报「开关 + 步骤数」，不让人以为折起来就把配置藏没了
const cardFold = reactive({ open: true })
const cardSummary = computed(() => {
  const steps = Array.isArray(items.value) ? items.value.length : 0
  return (bubbleOn.value ? '已开启' : '已关闭') + ` · ${steps} 个步骤`
})
async function doPreview() {
  flash.msg = ''
  flash.err = false
  if (!props.widgetVisible) {
    flash.err = true
    flash.msg = '挂件未显示，先在「窗口」页显示挂件再试播'
    return
  }
  try {
    // 宿主可能不挂 bubblePreview（老版本设置页），显式判空给出人话
    const r = window.services?.bubblePreview?.({ items: cloneBubbleItems(items.value) })
    if (r && r.ok) {
      previewing.value = true
      window.setTimeout(() => { previewing.value = false }, 1500)
      flash.msg = '已把当前队列发给挂件试播，点小鲸鱼看效果'
      return
    }
    flash.err = true
    flash.msg = (r && r.error) || '试播失败，宿主未返回结果'
  } catch (err: any) {
    flash.err = true
    flash.msg = '试播失败：' + String(err?.message || err)
  }
}

// —— 总开关：与「思考气泡」两回事，各写各的键 ——
// 「思考气泡」是 cfg 顶层的 bubbleOn（挂件上那些随余额刷新的定点气泡）；
// 本卡是 cfg.bubble.on —— 点小鲸鱼时弹的自定义泡泡队列。两个都开着不会互相覆盖
function onToggleOn(e: Event) {
  flash.msg = ''
  flash.err = false
  resetConfirm.value = false
  const on = (e.target as HTMLInputElement).checked
  emit('patch', { bubble: { on } })
}
function onToggleThinking(e: Event) {
  emit('patch', { bubbleOn: (e.target as HTMLInputElement).checked })
}

// —— 队列编辑（W1）回抛 ——
// 编辑器只产新数组，落盘由本卡统一 emit('patch')：normBubble 按键合并，只传 items 不会洗掉
// on / dwell / dragLines / system（lib 也原地保留）。
function onQueueChange(next: any[]) {
  flash.msg = ''
  flash.err = false
  resetConfirm.value = false
  pushUndo('queue')
  emit('patch', { bubble: { items: next } })
}

// —— 恢复出厂默认队列 ——
// 队列删空 → 保存 → 宿主 normBubbleItems(null) 回填出厂默认，但那是隐式路径且要「保存」才生效；
// 这里给一个显式入口。传 { items: null } 而非 { bubble: null }：后者会连 lib（用户攒的模块库）
// 一起清空（store.js normBubble 的 `if (!src) out.lib = []`），只重置队列不动模块库才是本意。
// 出厂默认由宿主 bubbleDefaultItems() 生成，前端不重复实现一份，避免两处漂移。
const resetConfirm = ref(false)
function onResetQueue() {
  if (!resetConfirm.value) {
    resetConfirm.value = true
    flash.msg = ''
    flash.err = false
    return
  }
  resetConfirm.value = false
  pushUndo('reset')
  emit('patch', { bubble: { items: null } })
  flash.err = false
  flash.msg = '已恢复出厂默认队列（模块库保留）'
}
// 打开某一步某侧的内容编辑（W2）：记录「正在编辑哪一步的哪一侧」。
// 面板本身是居中弹层（见 BubbleModPanel 文件头）：队列上同一个索引再点一次即收起，
// 关掉遮罩（点空白）或面板里的「关闭」都走 closeEditor。并列泡的两侧切换在**面板内部**的
// A / B chip 上，不走这里 —— onQueueEdit 对「同 idx + 同 side」是 toggle-close，
// 若把 chip 直接绑到这里，点当前侧会把面板关掉，所以另开一个 setEditSide。
// 只存索引不存副本：泡内容仍以 props.cfg.bubble.items 为唯一真源，编辑器每次改动都整体回抛，
// 避免「父级草稿 + 子级草稿」两份状态互相打架。
const editing = ref<{ idx: number; side: number } | null>(null)
function onQueueEdit(payload: { idx: number; side: number }) {
  flash.msg = ''
  flash.err = false
  resetConfirm.value = false
  const cur = editing.value
  if (cur && cur.idx === payload.idx && cur.side === payload.side) {
    editing.value = null
    return
  }
  editing.value = { idx: payload.idx, side: payload.side }
}
// 面板内切侧：只换 side，永远不关面板（点当前侧是无操作，不是收起）
function setEditSide(side: number) {
  const cur = editing.value
  if (!cur) return
  if (cur.side === side) return
  editing.value = { idx: cur.idx, side }
  flash.msg = ''
  flash.err = false
}
function closeEditor() { editing.value = null }

// 编辑器标题：'第 N 次点击'。并列泡的 A / B 由面板内的 chip 指示，标题不再缀后缀（避免重复）
const editingTitle = computed(() => {
  const e = editing.value
  if (!e) return ''
  const step = items.value[e.idx]
  if (step === undefined) return ''
  return stepLabel(e.idx)
})
// 当前编辑的泡的模块（扁平 modules[]）；未在编辑 / 索引越界时为空数组
const editingModules = computed<any[]>(() => {
  const e = editing.value
  if (!e) return []
  return stepModules(items.value[e.idx], e.side)
})
// 面板要的当前侧 / 总侧数：并列泡 2 侧、单选泡 1 侧（1 侧时面板不渲染 A / B chip）
const editingSide = computed(() => editing.value?.side ?? 0)
const editingSides = computed(() => {
  const e = editing.value
  if (!e) return 1
  return isChoiceStep(items.value[e.idx]) ? 2 : 1
})
// 模块库：宿主归一化后恒为数组，这里再兜一层
const bubbleLib = computed<any[]>(() => (props.cfg?.bubble && Array.isArray(props.cfg.bubble.lib) ? props.cfg.bubble.lib : []))

// 泡内容回抛：用 setStepModules 把新 modules 写回该步该侧，再整份 items 落盘。
// editKey 带上「哪一步哪一侧」：换泡 / 换侧重开合并窗口，不把两个泡的改动并成一步
function onModChange(mods: any[]) {
  const e = editing.value
  if (!e) return
  const cur = items.value[e.idx]
  if (cur === undefined) return
  pushUndo('mod:' + e.idx + ':' + e.side)
  const next = items.value.map((s: any, k: number) => (k === e.idx ? setStepModules(s, e.side, mods) : s))
  emit('patch', { bubble: { items: next } })
}
// 模块库回抛：lib 是 cfg.bubble 上独立的一份，与 items 并列，直接整份覆盖
function onLibChange(lib: any[]) {
  pushUndo('lib')
  emit('patch', { bubble: { lib } })
}

// —— 已导入的气泡图（image 模块的「用哪张图」下拉需要）——
// 挂载时拉一次即可：本卡不提供导入入口（导入在「资源」页），用户切回本卡时会重新挂载再拉。
// services 可能不挂 listBubbles（老宿主），失败就给空数组，下拉退化成只有「每次随机一张」
const bubbles = ref<any[]>([])
onMounted(() => {
  try {
    const r = window.services?.listBubbles?.()
    bubbles.value = Array.isArray(r?.items) ? r.items : []
  } catch {
    bubbles.value = []
  }
})
</script>

<template>
  <!-- [外观] 按压气泡（自定义泡泡）：点小鲸鱼时按顺序弹的泡泡队列，每个泡可以摆多行模块。
       本卡不改运行链路（queue / 渲染 / 试播 IPC / 挂件消费侧都已齐备），只补编辑入口。 -->
  <section class="card" data-search="bubbleCustom">
    <div class="card-head">
      <h2 class="card-toggle" @click="cardFold.open = !cardFold.open">
        <span class="caret">{{ cardFold.open ? '▾' : '▸' }}</span>按压气泡（自定义泡泡）
        <span v-if="!cardFold.open" class="card-sum">{{ cardSummary }}</span>
      </h2>
    </div>
    <template v-if="cardFold.open">

    <p class="hint">
      点小鲸鱼时按顺序弹出的泡泡：每个「步骤」是一次点击对应的泡，泡里可以按行摆多个模块
      （文本 / 报时 / 余额 / 随机语句 / 图片 / 峰谷 / 超链接…）。与上面的「思考气泡」是两回事 ——
      那个是随余额刷新的定点气泡，这里是点一下弹一次的队列。两项可以同时开。
    </p>

    <label class="field row check">
      <span class="label">按压气泡开关</span>
      <input type="checkbox" :checked="bubbleOn" @change="onToggleOn" />
    </label>
    <label class="field row check">
      <span class="label">思考气泡 <em>（随余额刷新的定点气泡，与按压气泡互不影响）</em></span>
      <input type="checkbox" :checked="cfg.bubbleOn" @change="onToggleThinking" />
    </label>

    <p v-if="!bubbleOn" class="hint">
      按压气泡当前是关的：挂件上点小鲸鱼不会弹自定义泡泡，仍然只按「思考气泡」显示。
      打开上面的开关后再试播。
    </p>

    <!-- 点击队列编辑器（W1）：增删步骤 / 上移下移 / 单泡↔并列 / A·B 权重 / 进泡编辑。
         点「编辑内容」开的是泡内容面板（W2）—— 面板本身是居中弹层（见 BubbleModPanel 文件头），
         位置与这个插槽无关；保留具名插槽只是为了把面板挂在队列编辑器之下（组件树清晰、状态同居）。
         可折叠：编辑器带队列 + 模块库两层长列表，看开关 / 文案的人不必每次都滚过它。
         折叠按钮用 .fold + .link-btn 的既有范式（本卡原来没有折叠，故此处的「收起」默认展开） -->
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" type="button" @click="editorCollapsed = !editorCollapsed">
        {{ editorCollapsed ? '展开编辑器（队列与模块）' : '收起编辑器' }}
      </button>
      <template v-if="!editorCollapsed">
        <BubbleQueueEditor :items="items" :editing="editing" @change="onQueueChange" @edit="onQueueEdit">
          <template #editor>
            <BubbleModPanel v-if="editingTitle"
                            :title="editingTitle" :modules="editingModules" :lib="bubbleLib" :bubbles="bubbles"
                            :theme="cfg.theme" :side="editingSide" :sides="editingSides"
                            @change="onModChange" @lib="onLibChange" @edit="setEditSide" @close="closeEditor" />
          </template>
        </BubbleQueueEditor>

        <div class="btn-row">
          <!-- 撤销 / 重做：覆盖队列 + 泡内容 + 模块库三类编辑；宿主推送的回填（挂件菜单 / 备份恢复）
               不入栈，故「撤销」永远只回退用户在编辑器里做过的操作。快捷键 Ctrl+Z / Ctrl+Y 同款 -->
          <button class="utils-btn utils-secondary" type="button" :disabled="!canUndo"
                  title="撤销上一次编辑（Ctrl+Z）" @click="undo">撤销</button>
          <button class="utils-btn utils-secondary" type="button" :disabled="!canRedo"
                  title="重做被撤销的编辑（Ctrl+Y）" @click="redo">重做</button>
          <button class="utils-btn utils-secondary" type="button" :disabled="previewing || !widgetVisible"
                  :title="widgetVisible ? '把当前队列发给挂件真弹一次' : '挂件未显示，先在「窗口」页显示挂件'"
                  @click="doPreview">{{ previewing ? '已试播' : '试播到挂件' }}</button>
          <!-- 恢复默认：两段式确认（首点变「确认恢复默认？」+ 危险色，再点执行；旁边给「取消」），
               范式照 NotifyView 的提醒文案恢复默认。执行前先 pushUndo，仍可 Ctrl+Z 撤回这一次重置 -->
          <button class="utils-btn" :class="resetConfirm ? 'utils-danger' : 'utils-secondary'" type="button"
                  title="把点击队列恢复成出厂默认（不动模块库）"
                  @click="onResetQueue">{{ resetConfirm ? '确认恢复默认？' : '恢复默认' }}</button>
          <button v-if="resetConfirm" class="utils-btn utils-secondary" type="button"
                  @click="resetConfirm = false">取消</button>
        </div>
      </template>
    </div>
    <p v-if="!widgetVisible" class="hint">
      挂件还没显示，试播发不出去 —— 先去「窗口」页把它显示出来。
    </p>
    <p v-if="flash.msg" class="msg" :class="msgCls(flash)">{{ flash.msg }}</p>
    </template>
  </section>
</template>

<style scoped>
/* 设计令牌来自 main.css 的 :root；.card / .field / .label / .hint / .msg / .btn-row / utils 档位
   是设置页跨卡共用的基类（各自 scoped，故这里补齐本组件用到的部分）。 */

input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

/* 队列编辑器（BubbleQueueEditor）自带样式；本卡只留外壳与开关类 */
</style>
