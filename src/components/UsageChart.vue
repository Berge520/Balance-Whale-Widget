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

// 纵轴量级：取当前档位内的最大值，作为 100% 参考线对应的 token 数。
// 复用 barHeight 的口径（父组件按同一份最大值算柱高），这里只把「满格 = 多少 token」还原成数字。
// 再遍历一遍 days 而不新增 prop：days 最多 31 个元素，代价可忽略，
// 而新增 prop 会让两个父组件各多维护一份「最大值」，正是这次抽组件想消除的重复。
const dayMax = computed(() => {
  let max = 0
  for (const d of props.days) max = Math.max(max, Number(d.tokens) || 0)
  return max
})
// 三条参考线（1/2、1/4、满格）。只给「满格」和「半格」写刻度文字：
// 31 根柱子、90px 高的图里塞四个数字会挤成一片，两条足以读出量级。
const gridLines = computed(() => {
  if (!dayMax.value) return []
  return [1, 0.5, 0.25].map((f) => ({
    key: f,
    bottom: f * 100 + '%',
    // 只有满格与半格标数值，1/4 线纯装饰
    label: f === 1 || f === 0.5 ? fmtTokens(dayMax.value * f) : '',
  }))
})
// 各模型展示条数上限。排行榜之外的尾巴（真实账本里常有一串只调用过一两次的模型）
// 全画出来会把卡片拉得很长，且那些行的占比条都短得看不出差别。
const MODELS_MAX = 8
const modelsShown = computed(() => props.models.slice(0, MODELS_MAX))
const modelsHidden = computed(() => Math.max(0, props.models.length - modelsShown.value.length))

// 占比条按「最大模型」为满格，而不是按总量占比 —— 排行榜里第一名贴满、
// 其余按与第一名的倍数收窄，比全部挤在 0–30% 的一小段里更容易分辨。
// 判据与柱状图一致：用 hasBars 同款的「有没有量为正」判断，全 0 时不出条。
const modelMax = computed(() => {
  let max = 0
  for (const m of props.models) max = Math.max(max, Number(m.tokens) || 0)
  return max
})
function modelBarWidth(tokens?: number) {
  if (!modelMax.value) return '0%'
  return Math.max(3, Math.round(((Number(tokens) || 0) / modelMax.value) * 100)) + '%'
}
</script>

<template>
  <div class="range-tabs-row">
    <div class="range-tabs">
      <button
        v-for="r in props.ranges"
        :key="r"
        class="range-tab utils-btn"
        :class="props.range === r ? 'range-tab-on utils-primary' : 'utils-secondary'"
        @click="emit('update:range', r)"
      >{{ r }} 天</button>
    </div>
  </div>
  <!-- 图表加纵轴参考线：原先只有柱高、没有刻度，看不出 69K 是高还是低
       （满格是当档最大值，换档/换数据后同一高度代表完全不同的量）。
       bottom 统一写成 calc(百分比 + var(--day-row))，与柱子的 0 刻度对齐（见 .grid-line 注释）。 -->
  <div v-if="hasBars" class="chart-wrap">
    <div class="chart-axis">
      <span v-for="g in gridLines" :key="g.key" class="axis-label" :style="{ bottom: 'calc(' + g.bottom + ' + var(--day-row))' }">{{ g.label }}</span>
    </div>
    <div class="chart-plot">
      <span v-for="g in gridLines" :key="g.key" class="grid-line" :style="{ bottom: 'calc(' + g.bottom + ' + var(--day-row))' }"></span>
      <div class="chart" :class="{ 'chart-dense': props.range >= 14, 'chart-ultra': props.range >= 30 }">
        <div v-for="(d, i) in props.days" :key="d.date" class="bar-col">
          <div class="bar-val">{{ (d.tokens || 0) > 0 && (props.labelEvery === 1 || i % props.labelEvery === 0) ? fmtTokens(d.tokens) : '' }}</div>
          <div class="bar-track">
            <div class="bar" :style="{ height: props.barHeight(d.tokens) }"></div>
          </div>
          <div class="bar-day">{{ i % props.labelEvery === 0 ? props.dayLabel(d.date) : '' }}</div>
        </div>
      </div>
    </div>
  </div>
  <p v-else class="hint">近 {{ props.range }} 天没有用量记录。</p>

  <div class="fold">
    <button class="link-btn utils-btn utils-secondary" @click="modelsOpen = !modelsOpen">{{ modelsOpen ? '收起各模型用量' : '各模型用量' }}</button>
    <div v-if="modelsOpen" class="guide">
      <!-- 模型行原先是一条长长的 .field：名字靠左、后面紧跟「4.2M tokens · 73 次调用 · 输出 26K · ¥ 0.00」
           一长串，右缘参差不齐，也没法横向比各模型。改成四列定宽的排行榜：
           名字 → 总量 → 次/输出 → 花费，下面压一条按「相对最大模型」比例的细条，
           扫一眼就能看出谁在吃 token。 -->
      <div v-for="m in modelsShown" :key="m.name" class="m-row">
        <span class="m-name" :title="m.name">{{ m.name }}</span>
        <span class="m-tokens">{{ fmtTokens(m.tokens) }}</span>
        <span class="m-turns">{{ m.turns || 0 }} {{ props.turnsLabel }} · 输出 {{ fmtTokens(m.out) }}</span>
        <span v-if="props.showCost" class="m-cost">{{ props.fmtCost(m.cost) }}</span>
        <span class="m-bar"><i :style="{ width: modelBarWidth(m.tokens) }"></i></span>
      </div>
      <p v-if="modelsHidden" class="hint">另有 {{ modelsHidden }} 个模型用量过少，未列出。</p>
      <p v-if="!props.models.length" class="hint">没有按模型分组的记录。</p>
    </div>
  </div>
</template>

<style scoped>
/* ===== 档位切换器 =====
   尺寸/配色走 main.css 的 utils 基类（未选中挂 .utils-secondary、选中挂 .utils-primary），
   这里只留布局：右对齐、等分、按钮组内部的 2px 间隙。
   上一轮这里曾按 App.vue 那套参数**再复制一份**（因为父组件 scoped 规则匹配不到本组件渲染的元素），
   那正是这轮要根治的东西 —— 现在按钮基准只有 main.css 一处。 */
.range-tabs-row {
  display: flex;
  justify-content: flex-end;
  margin: 4px 0 8px;
}
.range-tabs {
  display: flex;
  gap: 2px;
}
.range-tab {
  /* 等分宽度：档位是「7 天 / 14 天 / 30 天」，内容宽随位数变（最宽差 12px），
     贴内容排会让三个按钮宽窄不一、整排看起来像没对齐。
     等分后宽度固定，切换时按钮不会因文字变化而抖。 */
  flex: 1 1 0;
  text-align: center;
}

/* ===== 柱状趋势图 =====
   **这些规则原先写在 App.vue 的 scoped 块里，整段失效，柱子因此完全不出图。**
   App.vue 也是 <style scoped>，编译成 `.chart[data-v-App哈希]`；而 scoped 属性只加在
   「模板里直接写的元素」上，本组件渲染的 .chart / .bar-col / .bar-track 位于子组件内部，
   只带 UsageChart 自己的哈希，永远匹配不上 —— 最要命的是 .bar-track 的 height: 90px 没生效，
   轨道高度 0，里面 height: xx% 的柱子自然全被压成 0 高（有数值、有日期、就是没柱形）。
   样式必须与渲染它的组件同处一个 scoped 块。 */
/* 纵轴刻度列：宽度固定，避免刻度文字长短变化时把绘图区推得左右抖。
   height 必须等于 .bar-track 的 90px —— 刻度是按「相对轨道的百分比」定位的，
   若这里高度取的是整列（含日期行），刻度会整体错位。padding-top 对应 track 上方的
   .bar-val(14px) + gap(4px)，让两条轴从同一水平线起算。 */
.chart-axis {
  position: relative;
  flex: 0 0 34px;
  height: 90px;
  padding-top: 18px;
  box-sizing: content-box;
}
.axis-label {
  position: absolute;
  right: 0;
  /* translateY(50%) 让文字中心压在参考线上，而不是底边贴线 */
  transform: translateY(50%);
  font-size: 9px;
  color: var(--fg-faint);
  white-space: nowrap;
}
.chart-plot {
  position: relative;
  flex: 1;
  min-width: 0;
}
/* 水平参考线铺在柱子背后，只作读数量的背景刻度。
   关键：网格线的 bottom 基准是整个绘图区，而「0 刻度」不是绘图区底边 ——
   下面还有 .bar-day 那一行（10px 字 × 默认行高 ≈ 15px）。直接 bottom: 0 会让参考线
   整体下沉到日期行上、与柱子对不上。所以 bottom 用 calc(百分比 + 日期行高) 一起算，
   行高抽成 --day-row：14/30 天档 .chart-dense 把日期字号压到 9px，行高跟着变小，同步换值。
   不用 margin-bottom 顶替：绝对定位元素上 margin 与百分比 bottom 的叠加语义容易踩坑，
   直接写进 calc 里最直白。
   变量挂在 .chart-wrap（两侧刻度列与绘图区的共同父级）而不是 .chart-plot：
   .chart-axis 在 plot 之外，定义在 plot 上它取不到，刻度会全部掉到容器底边。 */
.chart-wrap {
  /* --day-row 见下方 .grid-line 注释：日期行高，供网格线/刻度把 0 刻度垫高一行 */
  --day-row: 15px;
  display: flex;
  gap: 6px;
  padding-top: 6px;
}
.chart-wrap:has(.chart-dense) {
  --day-row: 14px;
}
.grid-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--line);
  z-index: 0;
  /* bottom 的具体值由内联 style 给（calc 里带 --day-row），此处不设 */
}
.chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding-top: 6px;
}
.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.bar-val {
  font-size: 10px;
  color: var(--fg-dim);
  white-space: nowrap;
  height: 14px;
}
.bar-track {
  width: 100%;
  height: 90px;
  display: flex;
  align-items: flex-end;
  background: var(--track);
  border-radius: 6px;
  overflow: hidden;
}
.bar {
  width: 100%;
  background: linear-gradient(180deg, #6f8ad6, var(--accent));
  border-radius: 6px 6px 0 0;
  transition: height 0.3s ease;
}
.bar-day {
  font-size: 10px;
  color: var(--fg-faint);
  white-space: nowrap;
}
/* 14 / 30 天：柱子变窄，间距与日期字号一起收，否则会糊成一片 */
.chart-dense {
  gap: 3px;
}
.chart-dense .bar-day {
  font-size: 9px;
}
.chart-dense .bar-track {
  border-radius: 4px;
}
/* 30 天：柱子更密，间距再收一档，否则空隙会吃掉大半个图宽（卡片内容宽只有 524px） */
.chart-ultra {
  gap: 1px;
}
.chart-ultra .bar-track {
  border-radius: 2px;
}

/* ===== 各模型用量排行榜 =====
   四列定宽：名字 / 总量 / 次·输出 / 花费，
   下面压一条相对最大模型的占比细条。用 grid 而不是 flex，是为了让各行的列真正对齐 ——
   原先每行是一整串文字，右缘随内容长短浮动，读第 3 列的「次数」要逐行找位置。 */
.m-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 54px 108px 62px;
  align-items: center;
  gap: 2px 8px;
  padding: 5px 0;
}
.m-row + .m-row {
  border-top: 1px dashed var(--line);
}
.m-name {
  font-size: 12px;
  color: var(--fg);
  /* 模型名可以很长（deepseek-v4.1-flash-reasoner 之类），
     截断而非换行：换行会把该行顶成两行高、行列对不齐；完整名字留在 title */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m-tokens {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  text-align: right;
  white-space: nowrap;
}
.m-turns {
  font-size: 11px;
  color: var(--fg-dim);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m-cost {
  font-size: 11px;
  color: var(--fg-faint);
  text-align: right;
  white-space: nowrap;
}
/* 占比条统占一行（grid-column 从第 1 列跨到末列）：它表达的是「整行」的量级，
   若挤在名字下面会与右边的数字列抢宽度，且短条会被列宽截断看不出比例 */
.m-bar {
  grid-column: 1 / -1;
  height: 3px;
  border-radius: 2px;
  background: var(--track);
  overflow: hidden;
}
.m-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #6f8ad6, var(--accent));
}
/* 不显示花费时（Codex 侧 showCost=false）末列不存在，列宽要跟着收，
   否则右侧会空出一整列、数字看起来没贴边 */
.m-row:not(:has(.m-cost)) {
  grid-template-columns: minmax(0, 1fr) 54px 108px;
}

/* ===== 「各模型用量 / 收起各模型用量」折叠按钮 =====
   尺寸/配色走 utils 基类（markup 是 `class="link-btn utils-btn utils-secondary"`）。
   这里只需对付全局 `.link-btn` 的**下划线 + 透明底**：`.link-btn` (0,1,0) 与
   `.utils-btn` / `.utils-secondary` 同特异性，谁赢看源序 —— 而 main.css 是先于各 .vue
   注入的，所以全局 .link-btn 反而更晚、会把 utils 的 background / text-decoration 抢回去。
   故这里压一级写成 `button.link-btn`（0,1,1）稳定胜出，只覆盖它多出来的那几项。 */
button.link-btn {
  margin-top: 10px;
  background: rgba(83, 107, 169, 0.18);
  color: #536ba9;
  text-decoration: none;
  text-underline-offset: 0;
}
button.link-btn:hover {
  color: #536ba9;
}
</style>
