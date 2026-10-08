<script lang="ts" setup>
import { computed, reactive, ref, watch } from 'vue'
import type { LedgerDetailDay, LedgerDetailEntry, ModelUsageRow, WhaleServices } from '../types/services'

// 「用量与账本」整卡：用量口径 / 趋势图 / 本月汇总 / 账本明细 / 额度 / 今日模型占比 / 校准，
// 从设置页 App.vue 抽出。以下项仍留在父级，按 props 下传或 emit 触发，不能跟着搬：
//   - usageHistory / usageCurrency：父级 onDataCleared 要把 usageHistory 清空（清除账本后刷新回显），
//     额度/校准文案也依赖 usageCurrency，故唯一来源留父级，这里只读结果。
//   - refreshHistory / refreshTodayModels：父级 onWindowActive / onMounted / onDataCleared /
//     onBackupApplied 都要主动调用（窗口重新聚焦、挂载后、恢复备份后刷新趋势），留父级。
//   - fmtMoney：趋势图 / 明细 / 校准消息都要用，且依赖 usageCurrency；父级是唯一来源，props 下传。
//   - isImeComposing：搜索框与 dsh 命名也在用（跨卡共享），留父级，props 下传。
//   - HISTORY_KEEP / PRICE_MODEL_MAX / TOKEN_PRICE_DEFAULT：第三份副本由 scripts/check-shared.mjs
//     比对（指向 App.vue），不搬进来，模板所需数值以 prop 传入。
//   - onUsageModeChange / onTokenPriceChange / onHistoryKeepChange / addPriceModel / removePriceModel：
//     前四个要写回 cfg 并 patchCfg 落盘，addPriceModel / removePriceModel 更是直接 mutate cfg.tokenPrice.models
//     （Proxy 数组，宿主会丢弃空名行，不落存储）；一律留父级，本卡只 emit 触发并把新值带出去
//     —— 本卡不能改写 cfg（vue/no-mutating-props），而 :value 单向绑定不会写回，
//     所以这些 handler 必须从事件参数取值，不能回头读 cfg（那样只会读到旧值）。
// 随卡搬入的：图表 / 明细 / 模型占比 / 额度 / 校准相关的状态与计算，父级不再引用。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写用量 / 额度相关字段，落盘统一走 emit('patch')
  cfg: any
  services: Partial<WhaleServices>
  // 账本历史（父级 refreshHistory 填充，本卡截尾渲染）
  usageHistory: Array<{ date: string; usage: number }>
  // 记账币种（'CNY' / 'USD'）：额度单位与金额格式都靠它
  usageCurrency: string
  // 金额格式化（跨卡共享，父级唯一来源）
  fmtMoney: (v: number) => string
  // 输入法组字守卫（跨卡共享，父级唯一来源）
  isImeComposing: (e: Event | undefined) => boolean
  // 历史保留上下限与默认值（父级 HISTORY_KEEP）
  historyKeep: { DEFAULT: number; MIN: number; MAX: number }
  // 「按模型覆盖」上限（父级 PRICE_MODEL_MAX）
  priceModelMax: number
  // 内置默认单价（父级 TOKEN_PRICE_DEFAULT），加新行时给初值
  tokenPriceDefault: { hit: number; miss: number; out: number }
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
  // 值随事件传给父级（父级负责写回 cfg + 落盘）：cfg 是 props，本卡不能改写；
  // 而 :value 是单向绑定、不会写回，父级若只从 cfg 读就会永远拿到旧值 —— 表现就是「选了没反应」
  (e: 'usage-mode-change', v: string): void
  // 全局单价字段：key 是 cfg.tokenPrice 下的字段名（on / cur / rate / hit / miss / out）
  (e: 'token-price-change', p: { key: string; value: any; index?: number }): void
  (e: 'history-keep-change', v: number): void
  // 要求父级重取账本（refreshHistory）：导入 CSV / 校准后趋势与额度都要重新拉一次。
  // 不复用 history-keep-change —— 那个的语义是「校验并落盘保留天数」，借用会串味
  (e: 'refresh'): void
  (e: 'add-price-model'): void
  (e: 'remove-price-model', i: number): void
}>()

// 统一的消息态：与父级 App.vue 里的同名工具保持同一定义（内联一份，免父子透传 4 行工具）
type Flash = { msg: string; err: boolean }
function useFlash(): Flash { return reactive({ msg: '', err: false }) }
function msgCls(f: Flash) { return { ok: !f.err, err: f.err } }

// —— 用量趋势 ——
// 宿主按「账本历史保留天数」给足（默认 365 天），图表按 usageRange 截尾部显示，「本月汇总」用整段算。
// 账本数据（usageHistory / usageCurrency）由父级 refreshHistory 填，本卡只负责截取与展示。
// 可选区间：上限就是保留天数，超出的天数账本里本来就没有
const USAGE_RANGES = [7, 14, 30, 90, 180] as const
type UsageRange = (typeof USAGE_RANGES)[number]
// 区间是纯前端显示口径，不进宿主配置（没必要为它跑 IPC 与同步），但必须跨启动记住，
// 否则每次重开插件都弹回 7 天。localStorage 在 uTools 的 file:// 下可用且按插件目录隔离
const USAGE_RANGE_KEY = 'whale:usageRange'
function loadUsageRange(): UsageRange {
  try {
    const n = Number(localStorage.getItem(USAGE_RANGE_KEY))
    // 白名单校验：存过旧版本/被手改过的值可能已不在 USAGE_RANGES 里
    if ((USAGE_RANGES as readonly number[]).includes(n)) return n as UsageRange
  } catch (err) {}
  return 7
}
const usageRange = ref<UsageRange>(loadUsageRange())
function setUsageRange(r: UsageRange) {
  usageRange.value = r
  try { localStorage.setItem(USAGE_RANGE_KEY, String(r)) } catch (err) {}
}
// 保留天数之外的区间不显示（保留 35 天时点「180 天」只会看到一小段柱子，容易以为数据丢了）
const usageRangeTabs = computed(() => USAGE_RANGES.filter((r) => r <= props.cfg.historyKeepDays))
// 保留天数被调小后，原先选中的区间可能已不在可选范围内（如 365→35 时还停在「180 天」），
// 要收回到最大可选档，否则图表只剩一小段柱子，看着像数据被清了
// （原在父级 onHistoryKeepChange 里，随 usageRangeTabs / usageRange / setUsageRange 一起搬进来）
watch(() => props.cfg.historyKeepDays, () => {
  const tabs = usageRangeTabs.value
  if (tabs.indexOf(usageRange.value) < 0) setUsageRange(tabs[tabs.length - 1])
})
const exportFlash: Flash = useFlash()
const importFlash: Flash = useFlash()
// 今日被防误判拦下的余额变动（赠送额到期/异常跳变，未计入今日已用）
const todayAdjust = ref(0)
// 额度「不重置」口径的累计已用（宿主归档累计 + 今天；滚动累计不受历史裁剪影响，不能自己求和）
const cumUsed = ref(0)
const lastAdjustWhy = ref('')
const lastAdjustAt = ref('')
// 手动校准今日已用
const calibrateInput = ref<number | null>(null)
const calibrateFlash: Flash = useFlash()
const adjustTimeText = computed(() => {
  const t = Date.parse(lastAdjustAt.value)
  if (!isFinite(t)) return ''
  const d = new Date(t)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return p2(d.getHours()) + ':' + p2(d.getMinutes())
})
// v-model.number 清空输入框时值为 ''（未输入时为 null），两种都视为未填
const calibrateInputEmpty = computed(() =>
  calibrateInput.value === null || (calibrateInput.value as unknown) === '')
// 图表实际渲染的区间（尾部 usageRange 天）
const chartDays = computed(() => props.usageHistory.slice(-usageRange.value))
const historyMax = computed(() => {
  let m = 0
  for (const d of chartDays.value) if (d.usage > m) m = d.usage
  return m
})
// 本月汇总：从 31 天里筛出本月日期。日均按「本月已过天数」摊（含今天），
// 否则月初会被整月的空白天数摊薄成一个没意义的小数
const monthStats = computed(() => {
  const now = new Date()
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
  const elapsed = now.getDate()
  let total = 0
  let peak = 0
  for (const d of props.usageHistory) {
    if (d.date.slice(0, 7) !== ym) continue
    total += d.usage
    if (d.usage > peak) peak = d.usage
  }
  return { total, peak, avg: elapsed > 0 ? total / elapsed : 0, elapsed }
})
// —— 额度（资源包 / 订阅）——
// 已用按重置周期取口径：不重置 = 归档累计（cumUsed）/ 每月 = 本月累计 / 每日 = 今日
// （usageHistory 按日期升序，最后一条就是今天，来源同「本月汇总」，不再单独请求）
const quotaUsed = computed(() => {
  if (props.cfg.quotaReset === 'never') return cumUsed.value
  if (props.cfg.quotaReset === 'daily') return props.usageHistory.length ? props.usageHistory[props.usageHistory.length - 1].usage : 0
  return monthStats.value.total
})
const quotaPeriodText = computed(() =>
  props.cfg.quotaReset === 'never' ? '累计已用' : props.cfg.quotaReset === 'daily' ? '今日已用' : '本月已用')
const quotaPct = computed(() =>
  props.cfg.quotaTotal > 0 ? Math.min(100, Math.round((quotaUsed.value / props.cfg.quotaTotal) * 100)) : 0)
const quotaLeft = computed(() => Math.max(0, props.cfg.quotaTotal - quotaUsed.value))
// 柱子多的时候标签要抽稀（约每 6 个柱子留一个），否则会糊成一片
const labelEvery = computed(() => Math.max(1, Math.round(usageRange.value / 6)))
function dayLabel(date: string) {
  return date.slice(5).replace('-', '/')
}
function barHeight(u: number) {
  return historyMax.value > 0 ? Math.max(3, Math.round((u / historyMax.value) * 100)) : 0
}
// 导出账本用量为 CSV（宿主弹系统保存框；用户取消时静默）
function exportUsageCsv() {
  exportFlash.msg = ''
  exportFlash.err = false
  try {
    const r = props.services.exportUsageCsv?.(usageRange.value)
    if (!r) {
      exportFlash.err = true
      exportFlash.msg = '导出失败：宿主 API 不可用'
    } else if (r.ok) {
      exportFlash.msg = '已导出到：' + (r.path || '')
    } else if (!r.canceled) {
      exportFlash.err = true
      exportFlash.msg = '导出失败：' + (r.error || '未知错误')
    }
  } catch (err: any) {
    exportFlash.err = true
    exportFlash.msg = '导出失败：' + String(err?.message || err)
  }
}
// 导入账本用量 CSV（宿主弹系统打开框；合并后刷新趋势；用户取消时静默）
function importUsageCsv() {
  importFlash.msg = ''
  importFlash.err = false
  try {
    const r = props.services.importUsageCsv?.()
    if (!r) {
      importFlash.err = true
      importFlash.msg = '导入失败：宿主 API 不可用'
    } else if (r.ok) {
      const ignored = r.invalid ? '，忽略 ' + r.invalid + ' 行非法数据' : ''
      importFlash.msg = `已导入 ${r.imported} 天${ignored}；账本现有 ${r.kept} 天（${r.from} ~ ${r.to}）`
      emit('refresh') // 导入后趋势要重取
    } else if (!r.canceled) {
      importFlash.err = true
      importFlash.msg = '导入失败：' + (r.error || '未知错误')
    }
  } catch (err: any) {
    importFlash.err = true
    importFlash.msg = '导入失败：' + String(err?.message || err)
  }
}

// 自定义单价折叠态：整块（4 列价格网格 + 按模型覆盖列表）平时用不到但很长，故可折。
// 默认展开 —— 本块只在「平台令牌」模式下渲染，进得来的基本就是要改价的。
// 纯展示态、不给父级，故留组件内部（同 usageRange）
const priceFold = ref(true)

// —— 账本明细（可折叠）——
// 数据源是宿主账本：每日用量 + 当天的「未计入用量的余额变动」「手动校准」记录。
// 展开时才取一次（拉满保留天数），区间跟着上方区间切换在前端截取，筛选也在前端做。
const detailOpen = ref(false)
const detailDays = ref<LedgerDetailDay[]>([])
const detailQuery = ref('')
// 类型筛选：两类记录字段完全不同（adjust 是金额 + 原因，calibrate 是校准前后），
// 混在一起时想只看校准只能靠关键词「校准」去猜，这里给个显式开关
const detailKind = ref<'all' | 'adjust' | 'calibrate'>('all')
const openDays = ref<string[]>([])
function refreshDetail() {
  const r = props.services.getUsageDetail?.(props.cfg.historyKeepDays)
  detailDays.value = r && Array.isArray(r.days) ? r.days : []
}
function toggleDetail() {
  detailOpen.value = !detailOpen.value
  if (detailOpen.value) refreshDetail()
}
function toggleDay(date: string) {
  const i = openDays.value.indexOf(date)
  if (i >= 0) openDays.value.splice(i, 1)
  else openDays.value.push(date)
}
// 是否处于筛选态（类型不是「全部」或有关键词）。筛选态下按「命中条目」展示，不筛时原样显示区间内所有天。
const detailFiltered = computed(() => detailKind.value !== 'all' || !!detailQuery.value.trim())
// 筛选命中做到「条目级」：只保留命中的条目，整天都没有命中条目就整天不显示。
// 早先只做「整天保留」，某天有一条命中就把当天全部记录都列出来，还得逐天点开找是哪条。
const detailRows = computed(() => {
  const base = detailDays.value.slice(-usageRange.value)
  const kw = detailQuery.value.trim().toLowerCase()
  const kind = detailKind.value
  if (kind === 'all' && !kw) return base
  const out: LedgerDetailDay[] = []
  for (const d of base) {
    // 关键词命中日期串（如 09-12）时保留当天全部条目 —— 用户就是按日期找那一天
    const dateHit = !!kw && d.date.indexOf(kw) >= 0
    let entries = kind === 'all' ? d.entries : d.entries.filter((e) => e.kind === kind)
    if (kw && !dateHit) entries = entries.filter((e) => entryText(e).toLowerCase().indexOf(kw) >= 0)
    if (!dateHit && !entries.length) continue
    out.push({ date: d.date, usage: d.usage, entries })
  }
  return out
})
const detailTotal = computed(() => detailRows.value.reduce((a, d) => a + d.usage, 0))
// 筛选态下强制展开：否则命中了还要一天天点开才知道是哪条命中
function dayOpen(date: string) {
  return detailFiltered.value || openDays.value.indexOf(date) >= 0
}
// 当天「未计入用量」的变动合计（adjust 条目；calibrate 不是余额变动，不参与）
function adjustSumOf(d: LedgerDetailDay) {
  return d.entries.reduce((a, e) => a + (e.kind === 'adjust' ? Number(e.amount) || 0 : 0), 0)
}
function entryTime(e: LedgerDetailEntry) {
  const t = Date.parse(e.at)
  if (!isFinite(t)) return ''
  const d = new Date(t)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}
function entryText(e: LedgerDetailEntry) {
  if (e.kind === 'calibrate') return `手动校准：${props.fmtMoney(e.from || 0)} → ${props.fmtMoney(e.to || 0)}`
  return `${props.fmtMoney(e.amount || 0)} 未计入用量${e.why ? '（' + e.why + '）' : ''}`
}
// 今日模型占比（仅令牌模式）：模型明细只有平台用量接口会给，记账模式拿不到，页面不显示
const todayModels = ref<ModelUsageRow[]>([])
const modelsLoading = ref(false)
const modelsErr = ref('')
const modelsAt = ref(0)
// 占比条配色：与趋势柱的蓝色系区分开，方便一眼分辨不同模型
const MODEL_COLORS = ['#5b7fd4', '#7fb0e8', '#57c2b0', '#e0a45c', '#b185d8', '#e07b8e']
const modelsSum = computed(() => todayModels.value.reduce((a, r) => a + (Number(r.amount) || 0), 0))
const modelsTimeText = computed(() => {
  if (!modelsAt.value) return ''
  const d = new Date(modelsAt.value)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
})
// 模型显示名：平台用量接口回的是模型 id（如 deepseek-v4-flash），原样铺在占比条上不好读。
// 只做「友好标注」，不合并数据、不改金额；原始 id 放 title 里悬浮可见。
const MODEL_LABELS: Record<string, string> = {
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash 视觉版（实验）',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
}
function modelLabel(m: string) {
  if (!m) return '未知模型'
  return MODEL_LABELS[m.toLowerCase()] || m
}
function modelPct(amount: number) {
  return modelsSum.value > 0 ? Math.round((amount / modelsSum.value) * 100) : 0
}
// 拉取今日各模型金额：一次联网请求，只在令牌模式且本页可见时调用。
// 父级在窗口聚焦 / 挂载后也直接调它（见 App.vue onWindowActive），故用 defineExpose 暴露。
async function refreshTodayModels() {
  if (props.cfg.usageMode !== 'token') {
    todayModels.value = []
    modelsErr.value = ''
    return
  }
  modelsLoading.value = true
  try {
    const r = await props.services.getTodayModels?.()
    if (r && r.ok) {
      todayModels.value = Array.isArray(r.models) ? r.models : []
      modelsErr.value = ''
      modelsAt.value = Date.now()
    } else {
      todayModels.value = []
      modelsErr.value = (r && r.error) || '宿主 API 不可用'
    }
  } catch (err: any) {
    todayModels.value = []
    modelsErr.value = String(err?.message || err)
  } finally {
    modelsLoading.value = false
  }
}
// 手动校准今日已用：记账漏采/误判后可直接改成真实金额，余额基准不动，之后继续实时累加
function calibrateToday() {
  calibrateFlash.msg = ''
  calibrateFlash.err = false
  // v-model.number 清空输入框会得到 ''，Number('')===0，必须先拦掉，否则会误把用量清零
  if (calibrateInputEmpty.value) {
    calibrateFlash.err = true
    calibrateFlash.msg = '请先输入实际金额'
    return
  }
  const v = Number(calibrateInput.value)
  if (!isFinite(v) || v < 0) {
    calibrateFlash.err = true
    calibrateFlash.msg = '请输入不小于 0 的金额'
    return
  }
  try {
    const r = props.services.calibrateTodayUsage?.(v)
    if (!r || !r.ok) {
      calibrateFlash.err = true
      calibrateFlash.msg = '校准失败：' + (r?.error || '宿主 API 不可用')
      return
    }
    calibrateFlash.msg = `已将今日已用校准为 ${props.fmtMoney(r.to ?? v)}（原 ${props.fmtMoney(r.from ?? 0)}），之后余额继续实时记账`
    calibrateInput.value = null
    emit('refresh') // 校准后趋势要重取
  } catch (err: any) {
    calibrateFlash.err = true
    calibrateFlash.msg = '校准失败：' + String(err?.message || err)
  }
}

// 暴露给父级：账本相关状态由宿主回填（父级 refreshHistory 拿数据后写回来），
// 模型占比父级也要主动刷新。全项目此前零 defineExpose，这里是唯一例外 —— 抽卡时已尽量
// 保留单向数据流，但「账本回填」这一层仍是父级驱动的同步 IPC 结果，只能由父级写回。
// 宿主 API 可能不存在（旧版 preload），getUsageHistory 返回 undefined，故允许空值
function applyHistory(h?: { days?: any[]; currency?: string; todayAdjust?: number; cumUsed?: number; lastAdjustWhy?: string; lastAdjustAt?: string } | null) {
  if (!h) return
  todayAdjust.value = Number(h.todayAdjust) || 0
  cumUsed.value = Number(h.cumUsed) || 0
  lastAdjustWhy.value = h.lastAdjustWhy || ''
  lastAdjustAt.value = h.lastAdjustAt || ''
  if (detailOpen.value) refreshDetail()
}
defineExpose({ applyHistory, refreshTodayModels, refreshDetail })
</script>

<template>
  <section class="card" data-search="usage">
    <div class="card-head">
      <h2>用量与账本</h2>
      <div class="head-actions">
        <!-- 区间切换：同一组按钮在下方 UsageChart 组件里还有一份（那才是主入口，
             本行是卡片头部就近快捷）。样式走 main.css 的 utils 基类，与组件内那份一致。 -->
        <div class="range-tabs">
          <button v-for="r in usageRangeTabs" :key="r" class="range-tab utils-btn"
                  :class="usageRange === r ? 'utils-primary' : 'utils-secondary'" @click="setUsageRange(r)">{{ r }} 天</button>
        </div>
        <button class="export-btn utils-btn utils-outline" @click="importUsageCsv">导入 CSV</button>
        <button class="export-btn utils-btn utils-outline" :disabled="historyMax <= 0" @click="exportUsageCsv">导出 CSV</button>
      </div>
    </div>

    <label class="field row">
      <span class="label">用量</span>
      <!-- 值必须随事件传给父级：cfg 是 props，本卡不能改写（vue/no-mutating-props 是 error 级），
           而 :value 单向绑定不会写回，父级若从 cfg 读就永远拿到旧值 -->
      <select :value="cfg.usageMode"
              @change="emit('usage-mode-change', ($event.target as HTMLSelectElement).value)">
        <option value="ledger">小鲸鱼记账（推荐）</option>
        <option value="token">实时·令牌（需平台 Token）</option>
      </select>
    </label>

    <!-- 历史保留：账本按这个窗口裁剪，趋势图 / 明细 / 导出的可选区间也跟着它 -->
    <label class="field row">
      <span class="label">历史保留</span>
      <input class="num" type="number" :min="historyKeep.MIN" :max="historyKeep.MAX" step="1"
             :value="cfg.historyKeepDays"
             @change="emit('history-keep-change', Number(($event.target as HTMLInputElement).value))" />
      <span class="num-text">天</span>
      <span class="hint">{{ historyKeep.MIN }}–{{ historyKeep.MAX }} 天，默认 {{ historyKeep.DEFAULT }}；保留越久账本越大</span>
    </label>

    <!-- 自定义单价（可选）：官方调价没跟上、或走中转站按自己的价目结算时用。
         填的是谷价，峰价按官方规则（谷价 × 2）自动翻倍；美元单价按汇率折成人民币记账。
         两种覆盖方式可分别使用：全局开关（对所有模型）与「按模型覆盖」的条目（只改列出的）。
         整块收进折叠：多数人用不到，但展开后有四列价格网格 + 按模型覆盖的列表，很长。
         默认展开（与「位置类默认收起」不同——本块只在令牌模式下出现，进来的就是来改价的） -->
    <div v-if="cfg.usageMode === 'token'" class="price-box">
      <button class="link-btn utils-btn utils-secondary" type="button" @click="priceFold = !priceFold">
        {{ priceFold ? '收起自定义单价' : '自定义单价（调价没跟上 / 按自己的价目结算）' }}
      </button>
      <div v-if="priceFold">
      <label class="field row check">
        <span class="label">自定义单价</span>
        <input type="checkbox" :checked="cfg.tokenPrice.on"
               @change="emit('token-price-change', { key: 'on', value: ($event.target as HTMLInputElement).checked })" />
        <span class="hint">整表覆盖（关闭 = 全部用内置价目表）</span>
      </label>
      <div v-if="cfg.tokenPrice.on" class="price-row">
        <label class="price-cell">
          <span class="price-name">缓存命中</span>
          <input class="num" type="number" min="0" step="0.01" :value="cfg.tokenPrice.hit"
                 @change="emit('token-price-change', { key: 'hit', value: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <label class="price-cell">
          <span class="price-name">缓存未命中</span>
          <input class="num" type="number" min="0" step="0.01" :value="cfg.tokenPrice.miss"
                 @change="emit('token-price-change', { key: 'miss', value: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <label class="price-cell">
          <span class="price-name">输出</span>
          <input class="num" type="number" min="0" step="0.01" :value="cfg.tokenPrice.out"
                 @change="emit('token-price-change', { key: 'out', value: Number(($event.target as HTMLInputElement).value) })" />
        </label>
      </div>
      <label class="field row">
        <span class="label">币种</span>
        <select :value="cfg.tokenPrice.cur"
                @change="emit('token-price-change', { key: 'cur', value: ($event.target as HTMLSelectElement).value })">
          <option value="CNY">人民币 CNY</option>
          <option value="USD">美元 USD</option>
        </select>
        <template v-if="cfg.tokenPrice.cur === 'USD'">
          <span class="label">汇率</span>
          <input class="num" type="number" min="0" step="0.01" :value="cfg.tokenPrice.rate"
                 @change="emit('token-price-change', { key: 'rate', value: Number(($event.target as HTMLInputElement).value) })" />
          <span class="num-text">元/USD</span>
        </template>
      </label>
      <p class="hint">
        单价单位：{{ cfg.tokenPrice.cur === 'USD' ? '美元' : '元' }} / 百万 token，填谷价（峰价自动翻倍）。
        <template v-if="cfg.tokenPrice.cur === 'USD'">按上方汇率折成人民币后记账。</template>
        改动后下次刷新余额时更新今日已用。
      </p>

      <p class="group-title">
        按模型覆盖 <em>（只改列出的模型，其余仍用内置价目表；名称按子串匹配）</em>
      </p>
      <div v-for="(it, i) in cfg.tokenPrice.models" :key="i" class="price-row">
        <label class="price-cell price-cell-model">
          <span class="price-name">模型名</span>
          <input class="num" type="text" spellcheck="false" placeholder="deepseek-v4-pro"
                 :value="it.name"
                 @change="emit('token-price-change', { index: i, key: 'name', value: ($event.target as HTMLInputElement).value })" />
        </label>
        <label class="price-cell">
          <span class="price-name">缓存命中</span>
          <input class="num" type="number" min="0" step="0.01" :value="it.hit"
                 @change="emit('token-price-change', { index: i, key: 'hit', value: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <label class="price-cell">
          <span class="price-name">缓存未命中</span>
          <input class="num" type="number" min="0" step="0.01" :value="it.miss"
                 @change="emit('token-price-change', { index: i, key: 'miss', value: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <label class="price-cell">
          <span class="price-name">输出</span>
          <input class="num" type="number" min="0" step="0.01" :value="it.out"
                 @change="emit('token-price-change', { index: i, key: 'out', value: Number(($event.target as HTMLInputElement).value) })" />
        </label>
        <button class="export-btn price-del utils-btn utils-outline" type="button" title="删除这一条"
                @click="emit('remove-price-model', i)">删</button>
      </div>
      <button class="export-btn utils-btn utils-outline" type="button"
              :disabled="cfg.tokenPrice.models.length >= priceModelMax"
              @click="emit('add-price-model')">＋ 添加模型</button>
      </div>
    </div>

    <div v-if="historyMax > 0" class="chart"
         :class="{ 'chart-dense': usageRange >= 14, 'chart-ultra': usageRange >= 90 }">
      <div v-for="(d, i) in chartDays" :key="d.date" class="bar-col">
        <div class="bar-val">{{ d.usage > 0 && usageRange <= 14 ? fmtMoney(d.usage) : '' }}</div>
        <div class="bar-track">
          <div class="bar" :style="{ height: barHeight(d.usage) + '%' }"></div>
        </div>
        <div class="bar-day">{{ i % labelEvery === 0 ? dayLabel(d.date) : '' }}</div>
      </div>
    </div>
    <p v-else class="hint">暂无用量记录（挂件运行并记账后自动显示）。</p>
    <!-- 「累计已用」是账本的滚动累计（quotaUsed + 今天），不受历史保留期裁剪影响，故与上方区间无关 -->
    <p v-if="historyMax > 0 || cumUsed > 0" class="hint month-sum">
      本月累计 <strong>{{ fmtMoney(monthStats.total) }}</strong>
      · 日均 {{ fmtMoney(monthStats.avg) }}（按已过 {{ monthStats.elapsed }} 天）
      · 最高单日 {{ fmtMoney(monthStats.peak) }}
      · 累计已用 <strong>{{ fmtMoney(cumUsed) }}</strong>
    </p>
    <!-- 账本明细：按日展开当天的异常变动与校准记录。区间跟随上方区间，筛选在本地做 -->
    <div v-if="historyMax > 0 || detailDays.length" class="detail">
      <div class="detail-head">
        <button class="detail-toggle utils-btn utils-outline" @click="toggleDetail">
          {{ detailOpen ? '收起账本明细' : '展开账本明细' }}
        </button>
        <input v-if="detailOpen" class="detail-search" type="search" v-model="detailQuery"
               placeholder="按日期或原因检索（如 09-12、到期）" />
        <select v-if="detailOpen" class="detail-kind" v-model="detailKind">
          <option value="all">全部记录</option>
          <option value="adjust">只看未计入</option>
          <option value="calibrate">只看校准</option>
        </select>
        <span v-if="detailOpen" class="hint detail-sum">
          近 {{ usageRange }} 天 {{ detailRows.length }} 天 · 合计 {{ fmtMoney(detailTotal) }}
        </span>
      </div>
      <template v-if="detailOpen">
        <div v-for="d in detailRows" :key="d.date" class="detail-day">
          <div class="detail-day-row" @click="toggleDay(d.date)">
            <span class="detail-caret">{{ dayOpen(d.date) ? '▾' : '▸' }}</span>
            <span class="detail-date">{{ d.date }}</span>
            <span class="detail-usage">{{ fmtMoney(d.usage) }}</span>
            <span class="detail-tags">
              <span v-if="adjustSumOf(d) > 0" class="detail-tag">
                另有 {{ fmtMoney(adjustSumOf(d)) }} 未计入
              </span>
              <span v-else-if="d.entries.length" class="detail-tag detail-tag-mute">
                {{ d.entries.length }} 条记录
              </span>
            </span>
          </div>
          <div v-if="dayOpen(d.date)" class="detail-entries">
            <div v-for="(e, i) in d.entries" :key="i" class="detail-entry">
              <span class="detail-time">{{ entryTime(e) }}</span>
              <span>{{ entryText(e) }}</span>
            </div>
            <p v-if="!d.entries.length" class="hint">当天无异常变动或校准记录。</p>
          </div>
        </div>
        <p v-if="!detailRows.length" class="hint">没有匹配的记录。</p>
      </template>
    </div>
    <!-- 额度（资源包 / 订阅）：总量与重置周期存配置，已用按周期从账本取（不新增存储与请求） -->
    <div class="quota">
      <label class="field row">
        <span class="label">额度总量</span>
        <input class="num" type="number" min="0" step="1" :value="cfg.quotaTotal"
               @change="emit('patch', { quotaTotal: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
        <select class="quota-reset" :value="cfg.quotaReset" @change="emit('patch', { quotaReset: ($event.target as HTMLSelectElement).value })">
          <option value="monthly">每月重置</option>
          <option value="daily">每日重置</option>
          <option value="never">不重置</option>
        </select>
      </label>
      <template v-if="cfg.quotaTotal > 0">
        <div class="quota-line">
          {{ quotaPeriodText }} <strong>{{ fmtMoney(quotaUsed) }}</strong> / {{ fmtMoney(cfg.quotaTotal) }}
          · 剩余 <strong>{{ fmtMoney(quotaLeft) }}</strong>（{{ quotaPct }}%）
        </div>
        <div class="quota-track">
          <div class="quota-fill" :class="{ 'quota-fill-warn': quotaPct >= 90 }" :style="{ width: quotaPct + '%' }"></div>
        </div>
      </template>
      <p v-else class="hint">填「额度总量」后这里显示进度与剩余（0 = 不显示）。额度只做展示，不影响余额与记账口径。</p>
    </div>
    <!-- 今日模型占比：模型明细只有平台用量接口会给，因此只在令牌模式显示 -->
    <div v-if="cfg.usageMode === 'token'" class="model-share">
      <div class="model-share-head">
        <span class="model-share-title">今日模型占比</span>
        <span class="hint model-share-sub">
          <template v-if="modelsLoading">读取中…</template>
          <template v-else-if="modelsErr">读取失败：{{ modelsErr }}</template>
          <template v-else-if="!todayModels.length">今日暂无用量记录</template>
          <template v-else>共 {{ fmtMoney(modelsSum) }} · 更新于 {{ modelsTimeText }}</template>
        </span>
      </div>
      <div v-for="(row, i) in todayModels" :key="row.model || 'unknown'" class="model-row">
        <span class="model-name" :title="row.model || '未知模型'">{{ modelLabel(row.model) }}</span>
        <div class="model-track">
          <div class="model-fill"
               :style="{ width: modelPct(row.amount) + '%', background: MODEL_COLORS[i % MODEL_COLORS.length] }"></div>
        </div>
        <span class="model-pct">{{ modelPct(row.amount) }}%</span>
        <span class="model-cost">{{ fmtMoney(row.amount) }}</span>
      </div>
    </div>
    <p v-if="cfg.usageMode === 'ledger' && todayAdjust > 0" class="hint adjust-note">
      今日另有 <strong>{{ fmtMoney(todayAdjust) }}</strong> 余额变动未计入用量<template v-if="lastAdjustWhy">（{{ lastAdjustWhy }}<template v-if="adjustTimeText">，{{ adjustTimeText }}</template>）</template>；如确为消费可用下方校准补回。
    </p>
    <div v-if="cfg.usageMode === 'ledger'" class="calibrate-row">
      <span class="calibrate-label">校准今日已用</span>
      <input class="num calibrate-input" type="number" min="0" step="0.01"
             v-model.number="calibrateInput" placeholder="实际金额" @keyup.enter="!isImeComposing($event) && calibrateToday()" />
      <button class="export-btn utils-btn utils-outline" :disabled="calibrateInputEmpty" @click="calibrateToday">校准</button>
    </div>
    <p v-else class="hint">当前为「平台令牌」用量模式，今日已用以平台返回为准，无需校准。</p>
    <p v-if="calibrateFlash.msg" class="msg" :class="msgCls(calibrateFlash)">{{ calibrateFlash.msg }}</p>
    <p v-if="exportFlash.msg" class="msg" :class="msgCls(exportFlash)">{{ exportFlash.msg }}</p>
    <p v-if="importFlash.msg" class="msg" :class="msgCls(importFlash)">{{ importFlash.msg }}</p>
  </section>
</template>

<style scoped>
/* 设计令牌来自 main.css 的 :root。通用控件样式已由 main.css 统一提供（全局唯一来源），
   本组件只留自身特有的控件样式。utils 档位配色与 .link-btn
   基类也已在 main.css，此处不再留副本。
   ★ 趋势柱状图那套（.chart / .bar-* / .chart-dense / .chart-ultra）必须带进来：
     原先它们只写在 UsageChart.vue 的 scoped 块里，而本卡的趋势图是 App.vue 内联 markup、
     带的是 App 的哈希，规则整段失效 —— 症状是柱子完全不出（.bar-track 的 height:90px 没生效）。
     随本卡抽成独立组件后在这里补齐，正好修掉这个既有 bug。
     阈值按本卡口径：dense ≥14、ultra ≥90（UsageChart 组件内是 14 / 30，与本卡不同）。 */

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.card-head h2 {
  margin: 0;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.range-tabs {
  display: flex;
  gap: 4px;
}
.range-tab {
  flex: 1 1 0;
  text-align: center;
}
.export-btn {
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}

input[type='text'],
select {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg);
}
select option {
  background: var(--input-bg);
  color: var(--fg);
}
input[type='text']:focus,
select:focus,
.num:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(83, 107, 169, 0.18);
}

.num {
  width: 56px;
  padding: 5px 6px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
}
.num-text {
  width: 44px;
  text-align: right;
  font-size: 13px;
  color: var(--fg-dim);
}
.group-title {
  margin: 18px 0 6px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-size: 13px;
  color: var(--fg-dim);
}
.group-title em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-faint);
}

.month-sum {
  margin-top: 6px;
}
.month-sum strong {
  color: var(--fg);
  font-weight: 600;
}
/* 账本明细：折叠区 + 按日展开的异常变动 / 校准记录 */
.detail {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-toggle {
  cursor: pointer;
}
.detail-toggle:hover {
  color: var(--fg);
  border-color: var(--accent);
}
.detail-search {
  flex: 1;
  min-width: 160px;
  padding: 4px 9px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--input-bg);
  color: var(--fg);
}
/* 类型筛选下拉：全局 select 是 width:100%，这里必须收回成自动宽度，
   否则它会把同一行的检索框挤成一条 */
.detail-kind {
  width: auto;
  flex: 0 0 auto;
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 8px;
}
.detail-sum {
  margin: 0;
}
.detail-day {
  margin-top: 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  overflow: hidden;
}
.detail-day-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}
.detail-day-row:hover {
  background: var(--input-bg);
}
.detail-caret {
  width: 10px;
  color: var(--fg-faint);
}
.detail-date {
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}
.detail-usage {
  color: var(--fg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.detail-tags {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.detail-tag {
  padding: 1px 7px;
  border-radius: 6px;
  font-size: 11px;
  background: rgba(224, 67, 63, 0.12);
  color: var(--err);
}
.detail-tag-mute {
  background: rgba(127, 127, 127, 0.16);
  color: var(--fg-faint);
}
.detail-entries {
  padding: 4px 10px 8px 28px;
  border-top: 1px solid var(--line);
  background: var(--input-bg);
  max-height: 200px;
  overflow: auto;
  scrollbar-gutter: stable;
}
.detail-entry {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  color: var(--fg-dim);
}
.detail-time {
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
}
.adjust-note strong {
  color: var(--err);
  font-weight: 600;
}
.calibrate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.calibrate-label {
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.calibrate-input {
  width: 110px;
}
/* 趋势柱状图（取自 UsageChart.vue，阈值按本卡口径） */
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
.chart-dense {
  gap: 3px;
}
.chart-dense .bar-day {
  font-size: 9px;
}
.chart-dense .bar-track {
  border-radius: 4px;
}
.chart-ultra {
  gap: 1px;
}
.chart-ultra .bar-track {
  border-radius: 2px;
}
/* 今日模型占比（令牌模式）：名称 / 条 / 百分比 / 金额四列对齐 */
.model-share {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
.model-share-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.model-share-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
.model-share-sub {
  margin: 0;
}
.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.model-name {
  flex: 0 0 130px;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-track {
  flex: 1;
  min-width: 0;
  height: 10px;
  background: var(--track);
  border-radius: 5px;
  overflow: hidden;
}
.model-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.3s ease;
}
.model-pct {
  flex: 0 0 34px;
  font-size: 11px;
  color: var(--fg-dim);
  text-align: right;
}
.model-cost {
  flex: 0 0 78px;
  font-size: 11px;
  color: var(--fg);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 额度（资源包 / 订阅）：进度条沿用趋势柱的蓝色系，用色阶区分是否接近用尽 */
.quota {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
/* 自定义单价（令牌模式）：与额度块同样用虚线分隔，三格单价并排一行 */
.price-box {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}
.price-row {
  display: flex;
  gap: 10px;
  margin: 6px 0;
}
.price-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.price-name {
  font-size: 12px;
  color: var(--fg-dim);
}
.price-cell .num {
  width: 100%;
}
/* 「按模型覆盖」的模型名要填得下完整模型名（如 deepseek-v4-flash-vision-exp），比三格单价宽些 */
.price-cell-model {
  flex: 1.6;
}
/* 删除按钮与输入框底边对齐（price-cell 是列布局，标签在上、输入在下） */
.price-del {
  align-self: flex-end;
}
.quota-reset {
  margin-left: 8px;
}
.quota-line {
  font-size: 12px;
  color: var(--fg-dim);
}
.quota-track {
  margin-top: 6px;
  height: 10px;
  background: var(--track);
  border-radius: 5px;
  overflow: hidden;
}
.quota-fill {
  height: 100%;
  background: linear-gradient(90deg, #6f8ad6, var(--accent));
  border-radius: 5px;
  transition: width 0.3s ease;
}
.quota-fill-warn {
  background: linear-gradient(90deg, #e0a45c, #d9534f);
}
</style>
