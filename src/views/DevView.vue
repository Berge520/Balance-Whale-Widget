<script lang="ts" setup>
/*
 * 设置页「开发者」Tab → 调试工具卡（默认关 · 仅回归测试用）。
 *
 * 为什么不注册成普通卡片、也不进搜索索引：它属于「生产 UI 不该出现」的东西，
 * 只在本 Tab、非搜索态、且 config.debugTools 打开时渲染；入口实现由宿主再校验一次开关。
 *
 * 布局要点（这一版的改动）：三条只读自检（专注 / 待办 / 计时）各占一行、各带一个「自检」按钮，
 * 结论就地写在按钮右边 —— 原来只有一个全局「调试结果」槽，点完还得自己跑去别的卡核对，
 * 谁也说不清那句话是哪一步的。会真写数据的「注入旧数据」沉到最后，与只读自检分开。
 */
import { computed, reactive, ref } from 'vue'
import type { WhaleServices } from '../types/services'
import type { DebugRow } from '../composables/useDebugSelfCheck'

const props = defineProps<{
  services: Partial<WhaleServices>
  debugOn: boolean
  // 自检结果（含「演练提醒 / 注入旧数据」），由父级的 useDebugSelfCheck 持有：
  // 切 Tab 回来结果还在，不用重跑
  row: (k: string) => DebugRow
}>()
const emit = defineEmits<{
  toggled: [on: boolean]
  'focus-check': []
  'todo-check': []
  'timer-check': []
  'todo-due': [id: string]
  inject: []
}>()

const todoId = ref('')
const todos = computed(() => {
  if (!props.debugOn) return []
  try {
    return (props.services.todoGet?.().items || []).filter((x) => !x.done)
  } catch (err) {
    return []
  }
})
// 结构固定（五条），用常量数组驱动模板，省得五行重复抄一遍
const ROWS = reactive([
  { key: 'focus', name: '专注', tip: '明细 / 今日时长 / 开关三者是否自洽，只读', btn: '自检', ev: 'focus-check' },
  { key: 'todo', name: '待办', tip: '条数 / 专注目标是否还指向存在的条目，只读', btn: '自检', ev: 'todo-check' },
  { key: 'timer', name: '计时', tip: '宿主手里的计时快照能否原样恢复，只读', btn: '自检', ev: 'timer-check' },
])
</script>

<template>
  <section class="card">
    <h2 class="card-title">调试工具 <em>（默认关闭 · 仅回归测试用）</em></h2>
    <label class="field row check">
      <span class="label">启用调试工具 <em>（正常使用请保持关闭）</em></span>
      <input type="checkbox" :checked="debugOn" @change="emit('toggled', ($event.target as HTMLInputElement).checked)" />
    </label>
    <template v-if="debugOn">
      <!-- 三条只读自检：每行自己跑、结论写在自己这行 -->
      <div v-for="r in ROWS" :key="r.key" class="field row">
        <span class="label">{{ r.name }} <em>（{{ r.tip }}）</em></span>
        <button class="btn" @click="emit(r.ev as 'focus-check')">{{ r.btn }}</button>
        <span class="debug-out" :class="{ bad: row(r.key).bad }">{{ row(r.key).msg }}</span>
      </div>
      <div class="field row">
        <span class="label">演练提醒 <em>（对选中条目走一次通知 + 气泡，不写幂等位、不发邮件）</em></span>
        <select v-model="todoId">
          <option value="">选择一条待办…</option>
          <option v-for="it in todos" :key="it.id" :value="it.id">{{ it.text }}</option>
        </select>
        <button class="btn" :disabled="!todoId" @click="emit('todo-due', todoId)">立即触发</button>
        <span class="debug-out" :class="{ bad: row('due').bad }">{{ row('due').msg }}</span>
      </div>
      <!-- 次要项沉底：会真写数据，和上面几条只读自检不是一回事 -->
      <div class="field row">
        <span class="label">注入旧数据 <em>（remindedFor=0 的重复提醒 + focus/timer 双置顶 + 幽灵媒体项 · 会真写入）</em></span>
        <button class="btn" @click="emit('inject')">注入</button>
        <span class="debug-out" :class="{ bad: row('inject').bad }">{{ row('inject').msg }}</span>
      </div>
      <p class="hint">上面三条自检只读、不改数据；「注入旧数据」会真写入，可在「专注与待办」「管理显示内容」「背景与片头」里核对。</p>
    </template>
  </section>
</template>

<style scoped>
/* 行内结果：跟在按钮右侧吃掉剩余宽度；数字用等宽，读「3 条 / 12 轮」时不会左右跳 */
.debug-out {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}
.debug-out.bad {
  color: var(--err);
}
</style>
