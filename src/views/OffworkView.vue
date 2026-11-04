<script setup lang="ts">
import { useFold } from '../composables/useFold'

// 「下班倒计时」整卡：显示形态由宿主 / 浮动页决定，本卡只写配置（不直接改挂件）。
// 所有取值都走现有 patch 链路（defaultConfig / readConfig / writeConfig / patchConfig 四处同步）。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写 offwork* 八键，落盘统一走 emit('patch')
  cfg: any
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
}>()

// 整卡折叠：默认展开，与 FOLD_DEFAULTS.offwork 一致（test/display.test.mjs 会比对）
const cardFold = useFold('offwork', true)

// 顺序按周一到周日；0 = 周日（与 Date.getDay() 一致，配置里也用这个编号）
const WEEK_ITEMS = [
  { v: 1, label: '周一' },
  { v: 2, label: '周二' },
  { v: 3, label: '周三' },
  { v: 4, label: '周四' },
  { v: 5, label: '周五' },
  { v: 6, label: '周六' },
  { v: 0, label: '周日' },
]
const PAY_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

function onCheck(key: string, e: Event) {
  emit('patch', { [key]: (e.target as HTMLInputElement).checked })
}
function onText(key: string, e: Event) {
  emit('patch', { [key]: (e.target as HTMLInputElement | HTMLSelectElement).value })
}
function onPaydayDay(e: Event) {
  emit('patch', { offworkPaydayDay: Number((e.target as HTMLSelectElement).value) })
}
function isWorkday(d: number) {
  return Array.isArray(props.cfg.offworkDays) && props.cfg.offworkDays.includes(d)
}
// 至少保留一天：与宿主 patchConfig 的 normDays 兜底同一口径（取消最后一天不生效）
function toggleDay(d: number) {
  const cur: number[] = Array.isArray(props.cfg.offworkDays) ? props.cfg.offworkDays : [1, 2, 3, 4, 5]
  let next = cur.includes(d) ? cur.filter((x) => x !== d) : cur.concat(d)
  next = Array.from(new Set(next)).sort((a, b) => a - b)
  if (!next.length) return
  emit('patch', { offworkDays: next })
}
</script>

<template>
  <!-- [用量] 下班倒计时：可开关的独立展示形态，关闭时挂件完全走原路径 -->
  <section class="card" data-search="offwork">
    <div class="card-head">
      <h2 class="card-toggle" @click="cardFold.open = !cardFold.open">
        <span class="caret">{{ cardFold.open ? '▾' : '▸' }}</span>下班倒计时
        <span v-if="!cardFold.open" class="card-sum">
          {{ cfg.offworkOn ? '已开启 · ' + cfg.offworkStart + '–' + cfg.offworkEnd : '未开启' }}
        </span>
      </h2>
    </div>
    <template v-if="cardFold.open">
      <label class="field row check">
        <span class="label">开启下班倒计时</span>
        <input type="checkbox" :checked="cfg.offworkOn" @change="onCheck('offworkOn', $event)" />
      </label>
      <p class="hint">
        开启后挂件主体改为「距离下班 hh:mm:ss」，余额、专注与计时不受影响；点小鲸鱼仍可查看余额。关闭后与现在完全一致。
      </p>

      <div class="field row">
        <span class="label">上班时间</span>
        <input class="time" type="time" :value="cfg.offworkStart" @change="onText('offworkStart', $event)" />
      </div>
      <div class="field row">
        <span class="label">下班时间</span>
        <input class="time" type="time" :value="cfg.offworkEnd" @change="onText('offworkEnd', $event)" />
      </div>
      <p class="hint">
        下班时间早于上班时间按跨日班处理（例如 22:00–次日 06:00）；跨日、凌晨仍在上一班、周切换都按本地时间实时计算。
      </p>

      <div class="field">
        <span class="label">工作日</span>
        <div class="day-row">
          <button
            v-for="d in WEEK_ITEMS"
            :key="d.v"
            type="button"
            class="day-chip"
            :class="{ on: isWorkday(d.v) }"
            :aria-pressed="isWorkday(d.v) ? 'true' : 'false'"
            @click="toggleDay(d.v)"
          >{{ d.label }}</button>
        </div>
      </div>
      <p class="hint">默认周一至周五；至少保留一天（取消最后一天不会生效）。</p>

      <label class="field row check">
        <span class="label">显示秒 <em>（关闭后只显示 hh:mm）</em></span>
        <input type="checkbox" :checked="cfg.offworkShowSec" @change="onCheck('offworkShowSec', $event)" />
      </label>

      <label class="field row check">
        <span class="label">附加「距周末」<em>（周六日显示「周末进行中」）</em></span>
        <input type="checkbox" :checked="cfg.offworkWeekendOn" @change="onCheck('offworkWeekendOn', $event)" />
      </label>
      <label class="field row check">
        <span class="label">附加「距发薪日」</span>
        <input type="checkbox" :checked="cfg.offworkPaydayOn" @change="onCheck('offworkPaydayOn', $event)" />
      </label>
      <label v-if="cfg.offworkPaydayOn" class="field row">
        <span class="label">每月发薪日</span>
        <select :value="String(cfg.offworkPaydayDay)" @change="onPaydayDay($event)">
          <option v-for="d in PAY_DAYS" :key="d" :value="String(d)">第 {{ d }} 天</option>
        </select>
      </label>

      <p class="hint">
        附加倒计时接在倒计时下方的说明行，用「·」分隔；最后 30 分钟与 10 分钟会轻微变色提醒，不弹窗、不响铃。
      </p>
    </template>
  </section>
</template>

<style scoped>
/* 上下班时刻（HH:MM），与提醒卡的 .time 同一视觉口径 */
.time {
  width: 96px;
  padding: 5px 6px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
}
.day-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.day-chip {
  padding: 3px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: inherit;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
}
.day-chip.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-weak);
}
</style>
