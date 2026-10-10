<script lang="ts" setup>
import { computed, reactive, ref, watch } from 'vue'
import { msgCls, useFlash, type Flash } from '../composables/useFlash'
import { barHeightOf } from '../utils/format'
import type { CodexSummaryResult, CodexWindows, WhaleServices } from '../types/services'
import UsageChart from '../components/UsageChart.vue'

// 「Codex 会话统计」整卡：读 ~/.codex/sessions 的 rollout JSONL 做统计，从设置页 App.vue 抽出。
// 与 dsh 一族无关（上方 7 张开发者卡才是 dsh），父级用一条 <hr class="group-sep"> 隔开，
// 那条线依赖父级的 searchActive / activeTab，留在父级，本组件根节点即 <section class="card">。
//
// 仍留在父级、以 props 下传的（这些是**跨卡共享**的单一来源，卡片自己不留副本）：
//   - fmtTokens ：「万 / 亿」缩写，dsh 用量卡与模型列表行也在用
//   - codexWinText：窗口文案，模型列表行的 codex 行也要显示同一份措辞
//   - codexDayLabel：图表横轴短标签，dsh 用量卡同样在用
//   - ranges：DSH_USAGE_RANGES，useDsh() 内部常量，子组件无法 import
// 倒计时能跟着走的原因：windowsText 在本组件 computed 内调用父级的 codexWinText，
// 闭包读到父级的 codexNow，依赖登记到本 computed —— 父级 30s 心跳一跳，这里文案就刷新。
const props = defineProps<{
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局
  services: Partial<WhaleServices>
  // 图表档位（7/14/30）
  ranges: readonly number[]
  // token 数按万/亿缩写（父级单一来源）
  fmtTokens: (n?: number) => string
  // 订阅窗口文案（父级单一来源）
  codexWinText: (w: CodexWindows | null) => string
  // 'YYYY-MM-DD' → 'M-D'（父级单一来源）
  codexDayLabel: (date: string) => string
}>()
const emit = defineEmits<{
  // 本卡是否有窗口数据：父级的倒计时心跳要把这一项并进 codexTickNeed
  (e: 'windows', has: boolean): void
}>()

// 统一的消息态（Flash）：定义收口在 composables/useFlash.ts，各卡不再各持一份。

// 整卡折叠：宿主是同步扫文件（会话日志可能几十 MB），默认收起、首次展开才读，
// 避免每次进开发者 Tab 都无条件付一次扫描成本。
// loaded 保证收起态摘要只在「本会话已读过」之后才显示，折叠 = 不预读。
const folds = reactive({ open: false, help: false })
const loaded = ref(false)
function toggle() {
  folds.open = !folds.open
  if (!folds.open || loaded.value) return
  loaded.value = true
  codexRefresh()
}

const codex = ref<CodexSummaryResult | null>(null)
const codexBusy = ref(false)
const codexFlash: Flash = useFlash()

// 图表档位：宿主一次给 31 天（days31，索引 0 是今天），切档只改前端切片、不重扫
const codexRange = ref(7)
// days31 是新→旧，最近 N 天在开头，故 slice(0, N)。原用 slice(-N) 取到的是最旧的 N 天。
const codexDays = computed(() => ((codex.value && codex.value.days31) || []).slice(0, codexRange.value))
// 30 天档标签抽稀：每 5 天一个，避免糊成一片
const codexLabelEvery = computed(() => (codexRange.value >= 30 ? 5 : 1))
const codexModels = computed(() => {
  const bm = (codex.value && codex.value.byModel) || {}
  return Object.keys(bm)
    .map((k) => ({ name: k, ...bm[k] }))
    .sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0))
})
// 柱高百分比：最大值为满格（100%），最小留 2% 让「有量但极少」也看得见。
// 最大值就地算：这份 days 已按档位切好、最多 31 个元素；共用组件拿不到这里的 computed，
// 只能靠这个函数（见 UsageChart.vue 的 hasBars）。实现收在 utils/format.ts 的 barHeightOf。
function codexBarHeight(tokens?: number) {
  return barHeightOf(codexDays.value, tokens, 2)
}
// 订阅窗口是账号级状态，与本地 token 统计各自独立，单独一行展示
const codexWindows = computed(() => (codex.value && codex.value.windows) || null)
const codexWindowsText = computed(() => props.codexWinText(codexWindows.value))
// 把「本卡有无窗口数据」同步给父级：父级靠它决定是否跑 30s 倒计时心跳
watch(codexWindows, (w) => emit('windows', !!w))

function codexRefresh() {
  if (codexBusy.value) return
  codexBusy.value = true
  codexFlash.msg = ''
  codexFlash.err = false
  // 宿主侧是同步读文件（会话日志可能几十 MB），直接调会把「读取中…」和这次渲染一起卡住；
  // 先让 Vue 渲染一帧，再在下一轮事件循环里执行
  window.setTimeout(codexRefreshRun, 30)
}
function codexRefreshRun() {
  try {
    const r = props.services.codexSummary?.()
    if (!r) {
      codexFlash.err = true
      codexFlash.msg = '宿主 API 不可用'
      return
    }
    codex.value = r
    if (!r.ok) {
      codexFlash.err = true
      codexFlash.msg = r.error || '读取失败'
      return
    }
    codexFlash.msg = r.sessions
      ? `已扫描 ${r.sessions} 个会话文件（${r.changed} 个有更新）`
      : '未找到会话文件：确认 Codex CLI 用过、且 ~/.codex/sessions 里有 rollout-*.jsonl'
    codexFlash.err = !r.sessions
  } catch (err: any) {
    codexFlash.err = true
    codexFlash.msg = '读取失败：' + String(err?.message || err)
  } finally {
    codexBusy.value = false
  }
}
// 清缓存后重新扫（用于日志被外部改动、或怀疑缓存不一致时）
function codexClearCache() {
  try {
    props.services.clearCodexCache?.()
    codex.value = null
    codexRefresh()
  } catch (err: any) {
    codexFlash.err = true
    codexFlash.msg = '清除失败：' + String(err?.message || err)
  }
}
</script>

<template>
  <!-- [dev] Codex 本地会话统计：读 ~/.codex/sessions 的 rollout JSONL，纯本地、不联网。
       根元素即 .card：父级 v-if 控显隐，data-search 供搜索滚动锚点定位（构建期据此抽卡片全文索引）。 -->
  <section class="card dsh-card" data-search="codex">
    <div class="card-head">
      <h2 class="card-toggle" @click="toggle">
        <span class="caret">{{ folds.open ? '▾' : '▸' }}</span>Codex 会话统计
        <!-- 收起态摘要：只在「本会话已展开读过」后才显示，否则不预读、直接提示点开 -->
        <span v-if="!folds.open" class="card-sum">
          <template v-if="loaded && codex && codex.ok">今日 {{ fmtTokens(codex.todayTokens) }} tokens · 本月 {{ fmtTokens(codex.monthTokens) }}</template>
          <template v-else>点击展开查看</template>
        </span>
      </h2>
    </div>
    <template v-if="folds.open">
    <p class="hint">
      直接读 Codex CLI 写在 <code>~/.codex/sessions</code> 的会话日志（<code>rollout-*.jsonl</code>）做统计，
      <strong>纯本地读取、不需要 API Key、不发任何网络请求</strong>。用量取累计量的差值，天然免疫重复计数。
    </p>
    <div class="btn-row">
      <!-- 首次展开已自动读过一次，按钮主要当「刷新」用 -->
      <button class="utils-btn utils-primary" :disabled="codexBusy" @click="codexRefresh">{{ codexBusy ? '读取中…' : (codex ? '刷新' : '读取统计') }}</button>
      <button v-if="codex" class="secondary utils-btn utils-secondary" :disabled="codexBusy" @click="codexClearCache">清除缓存并重扫</button>
    </div>
    <p v-if="codexFlash.msg" class="msg" :class="msgCls(codexFlash)">{{ codexFlash.msg }}</p>

    <template v-if="codex && codex.ok">
      <label class="field row">
        <span class="label">会话目录</span>
        <span class="cmdline">{{ codex.home }}</span>
      </label>
      <label class="field row">
        <span class="label">会话文件</span>
        <span class="ver">{{ codex.sessions }} 个</span>
      </label>

      <!-- 与 dsh 用量卡保持同一套指标格：等宽格后横向可比，
           分项另起一行小格（见下方 .stat-break）。
           Codex 无金额口径（showCost=false），故 .stat-sub 不放成本：
           今日那格改放轮次，其余留空不渲染（空 span 会让该格多占一行高度）。 -->
      <div class="stat-grid">
        <div class="stat-cell" title="今日消耗的 token 数（含输出 / 推理 / 缓存命中）">
          <span class="stat-num">{{ fmtTokens(codex.todayTokens) }}</span>
          <span class="stat-label">今日</span>
          <span class="stat-sub">{{ codex.turns || 0 }} 轮</span>
        </div>
        <div class="stat-cell" title="本月消耗的 token 数">
          <span class="stat-num">{{ fmtTokens(codex.monthTokens) }}</span>
          <span class="stat-label">本月</span>
        </div>
        <div class="stat-cell" title="有记录以来的累计 token 数">
          <span class="stat-num">{{ fmtTokens(codex.totalTokens) }}</span>
          <span class="stat-label">累计</span>
        </div>
        <div class="stat-cell" title="会话文件个数（~/.codex/sessions 下的 rollout-*.jsonl）">
          <span class="stat-num">{{ codex.sessions || 0 }}</span>
          <span class="stat-label">会话</span>
        </div>
      </div>

      <!-- 累计的 token 构成：三项本来塞在「累计」那一行的括号里，与总数混排 -->
      <div class="stat-break">
        <span class="stat-chip"><em>输出</em>{{ fmtTokens(codex.outTokens) }}</span>
        <span class="stat-chip"><em>推理</em>{{ fmtTokens(codex.reasonTokens) }}</span>
        <span class="stat-chip"><em>缓存命中</em>{{ fmtTokens(codex.cachedTokens) }}</span>
      </div>

      <!-- 订阅窗口：只有日志里带 rate_limits（ChatGPT 订阅）时才有内容，没有就整行不渲染。
           是相对倒计时的整句文本，与上面的短数值不同形，仍留 .field row。 -->
      <label v-if="codexWindowsText" class="field row">
        <span class="label">订阅窗口</span>
        <span class="ver">{{ codexWindowsText }}</span>
      </label>

      <UsageChart
        v-model:range="codexRange"
        :ranges="ranges"
        :days="codexDays"
        :label-every="codexLabelEvery"
        :bar-height="codexBarHeight"
        :day-label="codexDayLabel"
        :models="codexModels"
        turns-label="轮"
        :show-cost="false"
        :fmt-cost="() => ''"
      />

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="folds.help = !folds.help">{{ folds.help ? '收起说明' : '说明' }}</button>
        <div v-if="folds.help" class="guide">
          <p class="guide-use"><strong>统计口径：</strong>优先用 <code>total_token_usage</code> 的累计差值（单调递增，一次轮次写多条 <code>token_count</code> 也不会重复计数）；累计缺失时退回 <code>last_token_usage</code>。</p>
          <p class="guide-use"><strong>模型归属：</strong>按 <code>turn_context</code> 事件里的 <code>model</code> 归类，未标注的记为 <code>codex</code>。</p>
          <p class="guide-use"><strong>订阅窗口：</strong>ChatGPT 订阅的 Codex 会在 <code>token_count</code> 事件里带 <code>rate_limits</code> 快照（5h 与周两个窗口的已用% 与重置时间），字段名各版本不一致，已做多候选键容错；API-key 计费或没有订阅时日志里没有这份快照，这一行不显示。窗口是账号级状态，与上面的本地 token 统计各自独立。</p>
          <p class="guide-use"><strong>缓存：</strong>按文件的 size/mtime 判断是否变化，只有变过的文件才重新解析（会话日志可能几十 MB）。缓存里只有聚合数与文件指纹，<strong>不含任何凭据</strong>。</p>
          <p class="guide-use"><strong>读不到数据：</strong>确认 Codex CLI 至少跑过一次、且 <code>~/.codex/sessions</code>（或 <code>$CODEX_HOME</code> 指向的目录）里有 <code>rollout-*.jsonl</code>。</p>
        </div>
      </div>
    </template>
    </template>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）来自 main.css 的 :root。
   通用控件样式已由 main.css 统一提供（全局唯一来源），本组件只留自身特有的控件样式。
   .btn-row 骨架、.link-btn 与 utils 档位配色也已在 main.css，此处不再留副本。
   .card-toggle / .card-toggle .caret / .card-sum（整卡折叠）同样已在 main.css，此处不再留副本。 */

/* dsh 分组卡的按钮排版：本卡沿用同一观感（不强制等宽，按钮贴内容宽） */
.dsh-card .btn-row button {
  flex: 1 1 auto;
}

/* 值可能是长路径（会话目录）：作为 flex 项默认 min-width:auto 不肯收缩，会撑破卡片 */
.ver {
  font-size: 13px;
  color: var(--fg-dim);
  min-width: 0;
  word-break: break-all;
}
/* 会话目录：等宽小字，可换行，方便核对 */
.cmdline {
  font-family: ui-monospace, Consolas, 'Courier New', monospace;
  font-size: 12px;
  color: var(--fg-dim);
  word-break: break-all;
}

/* 口径指标格：等分列，数字统一大一号、单位降到标签行，各格基线对齐。
   列数用 auto-fit：格数变化时不空列、不挤成两行里只放一个 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 6px;
  margin: 10px 0 8px;
}
.stat-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--card-bg);
}
.stat-num {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-label {
  font-size: 11px;
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-sub {
  font-size: 10px;
  color: var(--fg-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 累计 token 的分项：与 .stat-grid 分开成一行，不和「今日 / 本月」抢注意力 */
.stat-break {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.stat-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 7px;
  background: var(--track);
  font-size: 12px;
  color: var(--fg);
}
.stat-chip em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-dim);
}
/* 窄窗（uTools 侧栏拖到最窄约 420px）下四格会挤到数字截断，降成两列让每格重新变宽 */
@media (max-width: 460px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
/* .guide / .guide-use / .guide code 已上提 main.css（全局唯一来源）。 */
</style>