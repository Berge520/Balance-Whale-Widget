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
  // 「超密」档的 range 阈值：≥ 此值才挂 .chart-ultra（收窄柱间距）。
  // 两个父卡的口径不同（会话统计卡 token 量级小、30 天就很密 → 30；
  // 用量卡按金额记、柱子少但要用更紧的间距 → 90），差异由 prop 表达，不各留一份样式。
  // 默认 30 保持会话统计卡原行为，不传即可。
  ultraThreshold?: number
  // 柱顶数值的格式化函数。dsh / Codex 显示 token（K/M 缩写，见 fmtTokens）；
  // 用量卡显示金额（fmtMoney）。**父组件传什么就显示什么**，
  // 组件内不再写死 fmtTokens —— 否则用量卡会显示 token 缩写而不是金额。
  valFmt?: (v?: number) => string
  // 无用量记录时的提示文案。三张卡的措辞略不同，默认沿用会话统计卡那句。
  emptyText?: string
  // 是否渲染「各模型用量」折叠块。dsh / Codex 卡要（默认 true）；
  // 用量卡的模型占比是另一套「今日模型占比」块（数据口径不同），不重复出这一块，传 false。
  showModels?: boolean
  // 是否渲染组件自带的区间切换器（默认 true）。
  // 用量卡把切换器放进了卡片头部（挨着导入/导出，就近快捷），故传 false 避免同卡两处重复。
  showRangeTabs?: boolean
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
// 刻度文字与柱顶同口径（valText：父卡可传 valFmt），否则同一张图上纵轴用 token 缩写、
// 柱顶用金额，会自相矛盾（本图新加纵轴时踩过这个坑：金额卡纵轴曾写死 fmtTokens）。
const gridLines = computed(() => {
  if (!dayMax.value) return []
  return [1, 0.5, 0.25].map((f) => ({
    key: f,
    bottom: f * 100 + '%',
    // 只有满格与半格标数值，1/4 线纯装饰
    label: f === 1 || f === 0.5 ? valText(dayMax.value * f) : '',
  }))
})
// 各模型展示条数上限。排行榜之外的尾巴（真实账本里常有一串只调用过一两次的模型）
// 全画出来会把卡片拉得很长，且那些行的占比条都短得看不出差别。
const MODELS_MAX = 8
const modelsShown = computed(() => props.models.slice(0, MODELS_MAX))
const modelsHidden = computed(() => Math.max(0, props.models.length - modelsShown.value.length))

// 「超密」档阈值：父组件不传时保持默认 30
const ultraAt = computed(() => props.ultraThreshold ?? 30)
// 柱顶数值格：父组件传了 valFmt 就用它（用量卡传 fmtMoney），否则用组件内 fmtTokens
const valText = (v?: number) => (props.valFmt ? props.valFmt(v) : fmtTokens(v))
// 空态提示：父组件不传时沿用原话
const emptyMsg = computed(() => props.emptyText ?? `近 ${props.range} 天没有用量记录。`)

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
  <div v-if="props.showRangeTabs !== false" class="range-tabs-row">
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
      <div class="chart" :class="{ 'chart-dense': props.range >= 14, 'chart-ultra': props.range >= ultraAt }">
        <div v-for="(d, i) in props.days" :key="d.date" class="bar-col">
          <div class="bar-val">{{ (d.tokens || 0) > 0 && (props.labelEvery === 1 || i % props.labelEvery === 0) ? valText(d.tokens) : '' }}</div>
          <div class="bar-track">
            <div class="bar" :style="{ height: props.barHeight(d.tokens) }"></div>
          </div>
          <div class="bar-day">{{ i % props.labelEvery === 0 ? props.dayLabel(d.date) : '' }}</div>
        </div>
      </div>
    </div>
  </div>
  <p v-else class="hint">{{ emptyMsg }}</p>

  <div v-if="props.showModels !== false" class="fold">
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
   .chart / .bar-* / .chart-axis / .grid-line / .chart-wrap / .chart-dense / .chart-ultra
   这一整套已上提 main.css 作**唯一来源**（原先 UsageChart.vue 与 UsageView.vue 各抄一份，
   同款规则再往前还曾在 App.vue scoped 里因哈希不匹配而整段失效）。
   这里不再留副本 —— 唯一实质差异「超密档阈值」已由 ultraThreshold prop 表达。
   注意：本组件渲染的元素带的是**本组件**的哈希，main.css 是全局块不带哈希，故能正常命中；
   反之，父组件 scoped 里再写一份也匹配不到本组件渲染的元素，这正是历史上柱子不出图的原因。 */

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

/* 「各模型用量 / 收起」折叠按钮（markup 是 link-btn + utils 类）：全局 .link-btn
   按设计压过 utils 档位渲染成下划线文字链，这里不再写副本 ——
   旧版这节按「scoped 特异性补丁」处理，还把写死的深蓝抄了一份（深色下几乎隐形）。 */
</style>
