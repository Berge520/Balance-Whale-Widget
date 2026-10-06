<script lang="ts" setup>
import { computed, ref } from 'vue'
import {
  BUBBLE_CHOICE_W_MAX, BUBBLE_ITEM_MAX, BUBBLE_MOD_TYPES,
  addStep, isChoiceStep, moveStep, moveStepTo, pairSteps, removeStep, replaceChoiceSide,
  splitChoiceSide, stepLabel, stepModules, stepSummary,
  toChoiceStep, toSingleStep,
} from '../composables/useBubble'

// 点击队列编辑器（W1）：增删步骤 / 上移下移 / 单泡↔并列升格降级 / 并列 A·B 权重。
// 本编辑器是卡片内联的一段；点「编辑内容」开出的泡内容面板（W2）本身是居中弹层，
// 由父级经 `editor` 插槽传入、插在被编辑的那一步之下（插槽落点只决定组件归属，不决定视觉位置）。
//
// 组件不直接改 props.items（vue/no-mutating-props 是 error 级）：
// 所有编辑都走纯函数产出新数组，再 emit('change', nextItems) 交父级落盘。
// 真正只读/改内容（模块）的事在 W2（BubbleModPanel），本组件只到「一步长什么样」这一层。

const props = defineProps<{
  // 点击队列（cfg.bubble.items），恒为数组由父级兜底
  items: any[]
  // 正在展开泡内容面板的那一步（父级持有）。本组件只拿它做「插到哪一步下面」，
  // 不碰面板本身 —— 面板由父级经 `editor` 具名插槽传进来
  editing?: { idx: number; side: number } | null
}>()

const emit = defineEmits<{
  (e: 'change', items: any[]): void
  // 打开某一步的泡内容编辑（W2），父级负责定位 A/B 侧
  (e: 'edit', payload: { idx: number; side: number }): void
}>()

// 只读展示用：把每步摊平成一行行（序号 / 名称 / 摘要 / 内容摘要 / 是否并列）
const rows = computed(() => props.items.map((s: any, i: number) => ({
  key: i,
  idx: i + 1,
  label: stepLabel(i),
  summary: stepSummary(s),
  desc: stepDesc(s),
  choice: isChoiceStep(s),
  // 并列泡的两个候选项权重（单选泡为空）
  weights: isChoiceStep(s) ? (s.options || []).map((o: any) => optWeight(o)) : [],
})))

// 内容摘要：优先文字，退而模块类型名（与父卡片概览同口径，但这里按步展开到 3 条）
function stepDesc(step: any): string {
  const mods = step && step.kind === 'choice'
    ? (step.options || []).flatMap((o: any) => (o && o.item && Array.isArray(o.item.modules) ? o.item.modules : []))
    : (step && Array.isArray(step.modules) ? step.modules : [])
  if (!mods.length) return '空泡'
  const labelOf = (t: string) => (BUBBLE_MOD_TYPES.find((m) => m.type === t)?.label || t)
  const parts = mods.slice(0, 3).map((m: any) => {
    if (m.type === 'text') return String(m.text || '').slice(0, 12)
    if (m.type === 'random' && Array.isArray(m.lines) && m.lines.length) {
      const t = m.lines[0] && (m.lines[0].t || m.lines[0])
      return String(t || '').slice(0, 12)
    }
    return labelOf(m.type)
  })
  const more = mods.length > 3 ? ` 等 ${mods.length} 个模块` : ''
  return parts.filter(Boolean).join(' · ') + more
}

// 权重展示：缺省 1（宿主 normBubbleChoice 出口会补 1）
function optWeight(o: any): number {
  const w = Number(o?.w)
  return Number.isFinite(w) && w >= 1 ? w : 1
}

// —— 队列级操作（全部返回新数组）——
function onAdd() {
  if (props.items.length >= BUBBLE_ITEM_MAX) return
  emit('change', addStep(props.items))
}
function onRemove(i: number) {
  emit('change', removeStep(props.items, i))
}
function onMove(i: number, dir: number) {
  emit('change', moveStep(props.items, i, dir))
}

// —— 步骤拖拽（对齐上游 bubbleRowZone 0.22/0.78 + bubblePairDrop / bubbleSideSplitDrop 口径）——
// 落点五态：中间上/下半 = 排到目标步前/后；左/右 22% 边缘 = 并列（pairL/pairR）。
// 单泡拖到并列泡边缘 = 替换该侧（破坏性，走行内确认条）；并列泡只能整步排序（⠿ 手柄），
// 其 A/B 标签可单独拖出拆分（splitChoiceSide），拖回本步上/下半 = 调换 A/B 次序。
// ↑↓ 按钮保留 —— 拖拽是快捷方式，不是替代品（键盘 / 无鼠标场景仍要能排序）。
const dragFrom = ref(-1)
// 拖拽源形态：-1 = 整步排序（默认）；0/1 = 并列步的 A/B 侧被单独拖出
const dragSide = ref(-1)
const dropIdx = ref(-1)
const dropZone = ref<'' | 'before' | 'after' | 'pairL' | 'pairR'>('')
// 替换并列侧的行内确认条（与 ModelsView 的删除确认同款交互，不用 window.confirm）
const swapConfirm = ref<{ from: number; to: number; side: number } | null>(null)

function dragReset() {
  dragFrom.value = -1
  dragSide.value = -1
  dropIdx.value = -1
  dropZone.value = ''
}
function onStepDragStart(i: number, e: DragEvent) {
  dragFrom.value = i
  dragSide.value = -1
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // 有些浏览器不带 data 就不触发 drop，写个占位（真正的位置用 dragFrom 状态，不信 dataTransfer）
    e.dataTransfer.setData('text/plain', String(i))
  }
}
// 并列步 A/B 侧的拖拽源：拖出拆分 / 拖到别处插入
function onSideDragStart(i: number, side: number, e: DragEvent) {
  dragFrom.value = i
  dragSide.value = side
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', `side:${i}:${side}`)
  }
}
// 队列层落点判定（上游 bubbleRowZone 同口径）：左右 22% = 并列/替换侧；中间按上/下半排前后。
// 并列区只对「单泡整步拖拽」开放：A/B 侧拖出只认纵向插入（上游同此排除），
// 并列步整步拖拽不可再并入（上游 bubblePairDrop 对并列源直接返回，高亮也不给，避免误导）
function stepZone(i: number, e: DragEvent): '' | 'before' | 'after' | 'pairL' | 'pairR' {
  const rc = (e.currentTarget as HTMLElement).getBoundingClientRect()
  if (!rc.width || !rc.height) return ''
  const srcChoice = dragSide.value < 0 && isChoiceStep(props.items[dragFrom.value])
  const x = e.clientX - rc.left
  let zone: '' | 'before' | 'after' | 'pairL' | 'pairR'
  if (dragSide.value < 0 && !srcChoice && (x < rc.width * 0.22 || x > rc.width * 0.78)) {
    zone = x < rc.width * 0.22 ? 'pairL' : 'pairR'
  } else {
    zone = (e.clientY - rc.top) < rc.height / 2 ? 'before' : 'after'
  }
  // 自己身上不亮并列/替换（无意义）；before/after 保留 —— A/B 拖回本步 = 调换 A/B 次序
  if (dragFrom.value === i && zone !== 'before' && zone !== 'after') return ''
  return zone
}
function onStepDragOver(i: number, e: DragEvent) {
  if (dragFrom.value < 0) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const zone = stepZone(i, e)
  if (!zone) return
  dropIdx.value = i
  dropZone.value = zone
}
function onStepDragLeave(i: number, e: DragEvent) {
  // 与 W2 同理：步骤内部子元素间移动也会触发 dragleave，只有真正离开整步才清高亮
  const to = e.relatedTarget as Node | null
  if (to && (e.currentTarget as HTMLElement).contains(to)) return
  if (dropIdx.value === i) { dropIdx.value = -1; dropZone.value = '' }
}
function onStepDrop(i: number, e: DragEvent) {
  e.preventDefault()
  const from = dragFrom.value
  const side = dragSide.value
  const zone = dropZone.value
  dragReset()
  // 新拖拽动作作废未确认的替换条 —— 行号可能已变，旧 from/to 不可再信
  swapConfirm.value = null
  if (from < 0 || !zone) return
  if (side >= 0) {
    // A/B 侧拖出：拆分插入 / 拖回本步调换 A/B 次序（from === i 时后者）
    emit('change', splitChoiceSide(props.items, from, side, i, zone as 'before' | 'after'))
    return
  }
  if (zone === 'pairL' || zone === 'pairR') {
    if (isChoiceStep(props.items[i])) {
      // 单泡拖到并列泡边缘 = 替换该侧内容（破坏性）→ 行内确认条，不直接落库
      swapConfirm.value = { from, to: i, side: zone === 'pairL' ? 0 : 1 }
      return
    }
    emit('change', pairSteps(props.items, from, i, zone))
    return
  }
  emit('change', moveStepTo(props.items, from, i, zone as 'before' | 'after'))
}
// 确认/取消替换并列侧
function onSwapConfirm(ok: boolean) {
  const p = swapConfirm.value
  swapConfirm.value = null
  if (ok && p) emit('change', replaceChoiceSide(props.items, p.from, p.to, p.side))
}
// 落点高亮：五态与上游 bubbleDropShadow 同口径（before/after 贴上下沿，pairL/pairR 贴左右内沿），
// 颜色用主题的 --accent 替代上游硬编码蓝
function stepDropStyle(i: number): Record<string, string> {
  if (dropIdx.value !== i || !dropZone.value) return {}
  const map: Record<string, string> = {
    before: '0 -3px 0 var(--accent)',
    after: '0 3px 0 var(--accent)',
    pairL: 'inset 3px 0 0 var(--accent)',
    pairR: 'inset -3px 0 0 var(--accent)',
  }
  return { boxShadow: map[dropZone.value] || '' }
}
// 单泡 → 并列（A/B 候选，默认权重 10 : 2）；并列 → 单泡（保留 A 侧）
function onToChoice(i: number) {
  emit('change', props.items.map((s: any, k: number) => (k === i ? toChoiceStep(s) : s)))
}
function onToSingle(i: number) {
  emit('change', props.items.map((s: any, k: number) => (k === i ? toSingleStep(s) : s)))
}
// A / B 权重：写回某一步的某一侧（越界已由闭包 k===i 保证）
function onWeight(i: number, side: number, e: Event) {
  const raw = Number((e.target as HTMLInputElement).value)
  const w = Math.min(BUBBLE_CHOICE_W_MAX, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : 1))
  emit('change', props.items.map((s: any, k: number) => {
    if (k !== i || !isChoiceStep(s)) return s
    const options = (s.options || []).map((o: any, si: number) => (si === side ? { ...o, w } : o))
    return { ...s, options }
  }))
}
function onEdit(i: number, side: number) {
  emit('edit', { idx: i, side })
}

// —— 权重滑杆：拖动只改本地草稿显示，松手才落库 ——
// @input 逐 tick 触发（拖一次几十个事件），逐 tick emit 会打爆 undo 合并窗口并造成存储写入风暴；
// 故拖动中把值暂存在 liveW（同一时刻只有一根滑杆在拖，单值即可），数值 / 概率 / 比例条实时跟手，
// 松手（@change）才经 onWeight 走 emit('change') 落库并记一步 undo
const liveW = ref<{ key: number; side: number; w: number } | null>(null)
// 展示用权重：拖动中取草稿，否则取落库值（rows 由 props 派生，落库后才更新）
function weightOf(r: { key: number; weights: number[] }, si: number): number {
  const l = liveW.value
  return l && l.key === r.key && l.side === si ? l.w : r.weights[si]
}
// 抽中概率（%）：与 floating-page.js 的 bubblePickOptionIdx 同口径 —— 权重 / 权重和；
// 两侧先按 A 取整，B 用 100 - A 收尾，保证恒为整百
function probs(r: { key: number; weights: number[] }): [number, number] {
  const pa = Math.round((weightOf(r, 0) * 100) / (weightOf(r, 0) + weightOf(r, 1)))
  return [pa, 100 - pa]
}
function onWLive(r: { key: number }, si: number, e: Event) {
  const w = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(w)) liveW.value = { key: r.key, side: si, w }
}
function onWCommit(r: { key: number }, si: number, e: Event) {
  liveW.value = null
  onWeight(r.key, si, e)
}
// 某一步里 A / B 侧现有模块数（给「编辑内容」按钮加个规模提示）
function sideModCount(step: any, side: number): number {
  return stepModules(step, side).length
}
</script>

<template>
  <div class="bqe">
    <div class="bqe-head">
      <span class="bqe-title">点击队列（{{ items.length }} / {{ BUBBLE_ITEM_MAX }} 步）</span>
      <button class="utils-btn utils-secondary utils-xs" type="button"
              :disabled="items.length >= BUBBLE_ITEM_MAX"
              :title="items.length >= BUBBLE_ITEM_MAX ? `最多 ${BUBBLE_ITEM_MAX} 步` : '在队尾加一步'"
              @click="onAdd">+ 加一步</button>
    </div>

    <p class="bqe-hint">
      点一下弹一步。每步可以是「单泡」或「并列」—— 并列泡每次按权重在 A / B 两个候选里抽一个。
      拖序号圆点排序；把一个单泡拖到另一单泡的左 / 右边缘可并成 A / B（拖到并列泡边缘 = 替换该侧）。
    </p>

    <ol class="bqe-list">
      <li v-for="r in rows" :key="r.key" class="bqe-step"
          :style="stepDropStyle(r.key)"
          @dragover="onStepDragOver(r.key, $event)"
          @dragleave="onStepDragLeave(r.key, $event)"
          @drop="onStepDrop(r.key, $event)">
        <div class="bqe-line">
          <!-- 拖拽抓手：只给序号圆点，整行 draggable 会让「编辑内容」按钮与权重输入框
               也跟着被拖走、抢掉文本选择手感（与 W2 模块块同口径）。↑↓ 按钮保留作兜底；
               并列步用序号圆点拖 = 整步一起挪（不可再并入，上游同口径） -->
          <span class="bqe-idx" draggable="true"
                :title="r.choice ? '拖动整步排序' : '拖动排序；拖到别的单泡左 / 右边缘可并列'"
                @dragstart="onStepDragStart(r.key, $event)" @dragend="dragReset()">{{ r.idx }}</span>
          <span class="bqe-name">
            {{ r.label }}<span v-if="r.choice" class="bqe-tag">并列</span>
          </span>
          <span class="bqe-sum">{{ r.summary }}</span>

          <span class="bqe-ops">
            <button class="utils-btn utils-outline utils-xs" type="button"
                    :disabled="r.key === 0" title="上移一步"
                    @click="onMove(r.key, -1)">↑</button>
            <button class="utils-btn utils-outline utils-xs" type="button"
                    :disabled="r.key === rows.length - 1" title="下移一步"
                    @click="onMove(r.key, 1)">↓</button>
            <button class="utils-btn utils-outline utils-xs" type="button"
                    :title="r.choice ? '改回单泡（保留 A 侧）' : '改成 A/B 并列（按权重抽一个）'"
                    @click="r.choice ? onToSingle(r.key) : onToChoice(r.key)">
              {{ r.choice ? '并为单泡' : '改成并列' }}
            </button>
            <button class="utils-btn utils-danger utils-xs" type="button"
                    title="删除这一步" @click="onRemove(r.key)">删</button>
          </span>
        </div>

        <div class="bqe-desc">{{ r.desc }}</div>

        <!-- 替换并列侧的行内确认条：单泡拖到并列泡左 / 右边缘时出现（破坏性操作，先确认再落库） -->
        <div v-if="swapConfirm && swapConfirm.to === r.key" class="bqe-swap">
          用「第 {{ swapConfirm.from + 1 }} 步」替换这一步的 {{ swapConfirm.side === 0 ? 'A' : 'B' }} 泡内容？权重保留原值
          <button class="utils-btn utils-danger utils-xs" type="button"
                  @click="onSwapConfirm(true)">替换</button>
          <button class="utils-btn utils-outline utils-xs" type="button"
                  @click="onSwapConfirm(false)">取消</button>
        </div>

        <!-- 并列：A / B 权重滑杆 + 抽中概率 + 各自的内容编辑入口。权重越高越容易被抽到；
             滑杆拖动只改草稿显示（数值 / 概率 / 比例条实时跟手），松手才落库记 undo；
             A / B 标签可拖：拖到别的位置 = 拆出成独立单泡，拖回本步上 / 下半 = 调换 A / B 次序 -->
        <div v-if="r.choice" class="bqe-choice">
          <div v-for="(w, si) in r.weights" :key="si" class="bqe-side">
            <span class="bqe-side-name" draggable="true"
                  :title="'按住拖动可把 ' + (si === 0 ? 'A' : 'B') + ' 泡拆出到别的位置；拖回本步可调换 A / B 次序'"
                  @dragstart="onSideDragStart(r.key, si, $event)" @dragend="dragReset()">{{ si === 0 ? 'A' : 'B' }}</span>
            <label class="bqe-w">
              权重
              <input class="bqe-w-range" type="range" min="1" :max="BUBBLE_CHOICE_W_MAX"
                     :value="weightOf(r, si)" @input="onWLive(r, si, $event)" @change="onWCommit(r, si, $event)" />
              <span class="bqe-w-num">{{ weightOf(r, si) }}</span>
            </label>
            <span class="bqe-side-mods">{{ probs(r)[si] }}% · {{ sideModCount(items[r.key], si) }} 个模块</span>
            <button class="utils-btn utils-secondary utils-xs" type="button"
                    @click="onEdit(r.key, si)">编辑内容</button>
          </div>
          <!-- A / B 比例条：概率可视化（拖动中实时跟手），title 给精确百分数 -->
          <div v-if="r.weights.length === 2" class="bqe-bar" :title="'A ' + probs(r)[0] + '% / B ' + probs(r)[1] + '%'">
            <span class="bqe-bar-a" :style="{ width: probs(r)[0] + '%' }">A {{ probs(r)[0] }}%</span>
            <span class="bqe-bar-b" :style="{ width: probs(r)[1] + '%' }">B {{ probs(r)[1] }}%</span>
          </div>
        </div>
        <!-- 单泡：直接编辑入口 -->
        <div v-else class="bqe-choice">
          <div class="bqe-side">
            <span class="bqe-side-mods">{{ sideModCount(items[r.key], 0) }} 个模块</span>
            <button class="utils-btn utils-secondary utils-xs" type="button"
                    @click="onEdit(r.key, 0)">编辑内容</button>
          </div>
        </div>

        <!-- 泡内容面板（居中弹层）挂在被编辑的那一步之下：只影响组件归属，不影响视觉位置
             （面板是 position:fixed 的遮罩，渲染在哪一层都浮在最上面） -->
        <div v-if="editing && editing.idx === r.key">
          <slot name="editor" />
        </div>
      </li>

      <li v-if="!rows.length" class="bqe-empty">队列已删空 —— 保存后会恢复出厂默认队列（3 步），不是「删不掉」</li>
    </ol>
  </div>
</template>

<style scoped>
/* 队列编辑器：卡片内的一段，靠左缩进与父卡内容对齐。设计令牌来自 main.css 的 :root */
.bqe {
  margin: 14px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--input-bg);
}
.bqe-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bqe-title {
  font-size: 12px;
  color: var(--fg-dim);
}
.bqe-hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--fg-faint);
  line-height: 1.6;
}
.bqe-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.bqe-step {
  padding: 8px 0;
  transition: box-shadow 0.12s ease;
}
.bqe-step + .bqe-step {
  border-top: 1px dashed var(--line);
}
.bqe-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bqe-idx {
  flex: 0 0 20px;
  height: 20px;
  line-height: 20px;
  text-align: center;
  border-radius: 50%;
  font-size: 11px;
  color: #fff;
  background: var(--accent);
  cursor: grab;
  user-select: none;
}
.bqe-idx:active {
  cursor: grabbing;
}
.bqe-name {
  font-size: 12px;
  color: var(--fg);
  white-space: nowrap;
}
.bqe-tag {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 6px;
  font-size: 10px;
  color: var(--accent);
  border: 1px solid var(--accent);
}
.bqe-sum {
  font-size: 11px;
  color: var(--fg-faint);
}
.bqe-ops {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.bqe-desc {
  margin: 4px 0 0 28px;
  font-size: 12px;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}
.bqe-choice {
  margin: 6px 0 0 28px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bqe-side {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bqe-side-name {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
  font-weight: 600;
  cursor: grab;
  user-select: none;
}
.bqe-side-name:active {
  cursor: grabbing;
}
/* 替换并列侧的行内确认条：贴在被替换那一步的下方，用危险色按钮 + 说明文字 */
.bqe-swap {
  margin: 6px 0 0 28px;
  padding: 6px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--fg);
  background: var(--card-bg);
  border: 1px solid var(--accent);
  border-radius: 8px;
}
.bqe-w {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-faint);
}
/* 权重滑杆（1–99）：固定宽度防止拖动时跟着概率文字伸缩；数值紧跟其后 */
.bqe-w-range {
  width: 110px;
  accent-color: var(--accent);
}
.bqe-w-num {
  min-width: 20px;
  font-size: 12px;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}
/* A / B 比例条：概率可视化，文字过窄时溢出隐藏（权重悬殊时窄侧放不下百分数） */
.bqe-bar {
  margin: 2px 0 0 28px;
  display: flex;
  height: 18px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.bqe-bar-a,
.bqe-bar-b {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 10px;
  color: #fff;
}
.bqe-bar-a {
  background: var(--accent);
}
.bqe-bar-b {
  background: var(--fg-faint);
}
.bqe-side-mods {
  font-size: 11px;
  color: var(--fg-faint);
}
.bqe-empty {
  padding: 8px 0;
  color: var(--fg-faint);
  font-size: 12px;
}
/* 泡内容面板（插槽 #editor）是 position:fixed 的居中弹层（见 BubbleModPanel），
   脱离文档流，插在哪一步之下都与这里的排布无关，故不需要任何缩进或定位样式 */
</style>
