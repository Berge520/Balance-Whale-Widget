<script setup lang="ts">
// 「用量统计」类卡片共用的两块内容：柱状趋势图 + 各模型用量折叠。
//
// 为什么抽出来：dsh 用量统计卡与 Codex 会话统计卡的这两块**逐字相同**，
// 只差字段前缀（days / labelEvery / barHeight / models）。原先两份各抄一遍 ——
// 改一处漏一处，柱状图的抽稀规则或模型行的格式一旦调整就必须记得改两遍。
//
// 注意：这里只统一「长相相同」的部分。两张卡的字段区（数据目录 / 会话目录 / 余额 等）
// 与口径说明差异很大，不纳入本组件 —— 抽公共组件的前提是差异真的只是变量名，
// 而不是为了复用把不同口径强行拉平。
import { ref, computed } from 'vue'

const props = defineProps<{
  // 图表档位（7/14/30），由父组件持有：切换只改前端切片，不重扫数据
  range: number
  ranges: readonly number[]
  // 已按档位切好的天数组，索引越大越早（父组件负责 slice）
  days: { date: string; tokens?: number }[]
  // 标签抽稀步长：30 天档每 5 天一个，避免糊成一片
  labelEvery: number
  // 柱高百分比（父组件按各自的最大值算）
  barHeight: (tokens?: number) => string
  // 日期 → 横轴短标签
  dayLabel: (date: string) => string
  // 各模型用量（已按 tokens 降序）
  models: { name: string; tokens?: number; turns?: number; out?: number; cost?: number }[]
  // 每行的轮/次单位不同（账本给的是「次」、会话缓存给的是「轮」），由父组件给
  turnsLabel: string
  // 是否显示花费：只有 dsh 账本里的 DeepSeek 官方档有定价，Codex 侧不显示
  showCost: boolean
  // 花费格式化函数，**必须由父组件传入、不在组件内自己实现**。
  // dsh 侧的花费带币种（costCurrency 非 CNY 时不加 ¥ 符号），组件内部写不了这段逻辑 ——
  // 早先这里硬编码过一份 `¥` + toFixed，等于给非人民币金额也贴了 ¥ 符号，
  // 正是「抽组件顺手抄一份」造出来的劣化复制。showCost 为 false 时该 prop 不会被调用。
  fmtCost: (v?: number) => string
}>()

const emit = defineEmits<{ (e: 'update:range', v: number): void }>()

// 纯展示态、无须给父组件，所以留在组件内部，省得父组件为两处各维护一份折叠态
const modelsOpen = ref(false)

// 只有「有天数且最大值为正」时才画图，否则显示「近 N 天没有用量记录」。
// 判据用 barHeight 的返回值而不是自己再遍历一遍 tokens：柱高由父组件算，
// 组件内重算一遍等于把「什么算有量」的规则写成两份。
const hasBars = computed(() => props.days.length > 0 && props.barHeight(1) !== '0%')

// token 数按 K/M 缩写，与卡片其余部分口径一致
function fmtTokens(n?: number) {
  const v = Number(n) || 0
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'K'
  return String(v)
}
</script>

<template>
  <div class="range-tabs-row">
    <div class="range-tabs">
      <button
        v-for="r in props.ranges"
        :key="r"
        class="range-tab"
        :class="{ 'range-tab-on': props.range === r }"
        @click="emit('update:range', r)"
      >{{ r }} 天</button>
    </div>
  </div>
  <div v-if="hasBars" class="chart" :class="{ 'chart-dense': props.range >= 14 }">
    <div v-for="(d, i) in props.days" :key="d.date" class="bar-col">
      <div class="bar-val">{{ (d.tokens || 0) > 0 && (props.labelEvery === 1 || i % props.labelEvery === 0) ? fmtTokens(d.tokens) : '' }}</div>
      <div class="bar-track">
        <div class="bar" :style="{ height: props.barHeight(d.tokens) }"></div>
      </div>
      <div class="bar-day">{{ i % props.labelEvery === 0 ? props.dayLabel(d.date) : '' }}</div>
    </div>
  </div>
  <p v-else class="hint">近 {{ props.range }} 天没有用量记录。</p>

  <div class="fold">
    <button class="link-btn" @click="modelsOpen = !modelsOpen">{{ modelsOpen ? '收起各模型用量' : '各模型用量' }}</button>
    <div v-if="modelsOpen" class="guide">
      <label v-for="m in props.models" :key="m.name" class="field row">
        <span class="label">{{ m.name }}</span>
        <span class="ver">
          {{ fmtTokens(m.tokens) }} tokens · {{ m.turns || 0 }} {{ props.turnsLabel }} · 输出 {{ fmtTokens(m.out) }}<template v-if="props.showCost"> · {{ props.fmtCost(m.cost) }}</template>
        </span>
      </label>
      <p v-if="!props.models.length" class="hint">没有按模型分组的记录。</p>
    </div>
  </div>
</template>
