<script lang="ts" setup>
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import type { GhAccelOpLog, GhAccelTrace, GhAccelVerifyResult, WhaleServices } from '../types/services'

// GitHub 加速（hosts 方案）整块功能：状态 / 开关 / IP 表 / 连接检测 / 操作日志。
// 从设置页 App.vue 抽出的独立 Tab 组件 —— 这块自成一体（不读写其它 Tab 的状态），
// 抽出来能显著削掉 App.vue 的 template 体积。
// 与父级的接口刻意保持最小：cfg 整体传入（内含 ghAccel* 字段，响应式链路不变），
// 落盘统一走 emit('patch')，与父级 patchCfg 同义。
const props = defineProps<{
  cfg: any
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局。
  // 父级持有的是 Partial（preload 可能缺方法），故这里同样放宽
  services: Partial<WhaleServices>
  // 当前选中的 Tab：本组件只在选中「帮助」时才需要刷新 hosts 实际状态
  activeTab: string
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
}>()

// 统一的消息态：msg=文案、err=是否错误态；模板用 msgCls(f) 生成 class。
// 原为 App.vue 里全页共享的工具函数，这里按同一定义内联一份，
// 免得让子组件为了一个 4 行的 class 工具去依赖父级
type Flash = { msg: string; err: boolean }
function useFlash(): Flash { return reactive({ msg: '', err: false }) }
function msgCls(f: Flash) {
  return { ok: !f.err, err: f.err }
}

// —— GitHub 加速（hosts 方案）：状态 / 开关 / IP 表 / 检测连接 ——
const ghAccelFlash: Flash = useFlash()
const ghAccelBusy = ref(false) // 防重入：UAC 弹窗或联网刷新期间按钮不可点
// 表龄文案与「超 7 天未刷新」提醒：GitHub 的 CDN IP 会变动，旧 IP 可能已失效
function ghAccelAgeText() {
  const t = props.cfg.ghAccelRefreshedAt
  if (!t) return '从未刷新'
  const min = Math.floor((Date.now() - t) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}
const ghAccelStale = computed(() => {
  const t = props.cfg.ghAccelRefreshedAt
  return !!t && Date.now() - t > 7 * 24 * 3600 * 1000
})
// hosts 实际状态（读文件现算，不依赖配置意图）；null = 还没查过
const ghAccelActual = ref<{ on: boolean; degraded?: boolean; active: string[]; hostsPath: string } | null>(null)
// 块之外已存在的目标域名条目（其它工具也写 hosts；本插件的块写在最前，会压过它们）
const ghAccelConflicts = ref<Array<{ domain: string; ip: string; line: string }>>([])
const ghAccelProbe = ref<{ ok: boolean; ms: number; status?: number; error?: string } | null>(null)
const ghAccelProbing = ref(false)
const ghAccelIpsFold = ref(false)
// IP 表编辑框内容没保存过（用于「回到帮助 Tab 时提醒未保存」）
const ghAccelTableDirty = ref(false)
// 最近一次 IP 获取的来源追踪：每个域名最终 IP 从哪来（DoH / 社区源表 / 当前表 / 兜底）
const ghAccelTrace = ref<GhAccelTrace | null>(null)
const ghAccelLogFold = ref(false)
// GitHub 加速操作日志（宿主内存态环形缓冲）。在操作开始/结束时各拉一次：
// 开始时拿到 running 那条（能看到「正在干什么」），结束时拿到终态（结果 + 耗时）
const ghAccelOps = ref<GhAccelOpLog[]>([])
const ghAccelRunning = computed(() => ghAccelOps.value.find((o) => o.state === 'running') || null)
const ghAccelOpsDone = computed(() => ghAccelOps.value.filter((o) => o.state !== 'running'))
function ghOpStateText(s: string) {
  if (s === 'ok') return '成功'
  if (s === 'fail') return '失败'
  if (s === 'cancel') return '已取消'
  return '进行中'
}
function ghStepMark(s: string) {
  if (s === 'ok' || s === 'done') return '✓'
  if (s === 'fail') return '✕'
  if (s === 'skip') return '–'
  return '…'
}
// IP 表校验：verifying 探测中；verify 上一次结论（null = 还没测过）
const ghAccelVerifying = ref(false)
const ghAccelVerify = ref<GhAccelVerifyResult | null>(null)
// 域名+IP → 校验结论，供编辑行就地标色。同一 (域名,IP) 在表里可能重复，用组合键而非索引
function ghIpState(domain: string, ip: string): 'ok' | 'bad' | 'stale' | '' {
  const v = ghAccelVerify.value
  if (!v || !domain || !ip) return ''
  const hit = v.results.find((r) => r.domain === domain && r.ip === ip)
  if (!hit) return ''
  // 不可达但正是 DNS 此刻的答案：多为探测抖动，标黄提醒而不是红（红会诱导用户误删好 IP）
  if (hit.ok) return 'ok'
  return v.bad.some((r) => r.domain === domain && r.ip === ip) ? 'bad' : 'stale'
}
// 校验标记的短文案：空态不占位（返回空串），行里只用一个小圆点式文字
function ghIpStateText(s: string) {
  if (s === 'ok') return '可用'
  if (s === 'bad') return '不可用'
  if (s === 'stale') return '待复查'
  return ''
}
// 「来源」列按层级上色：拿到的 IP 越新鲜越可信（DoH 实时解析 / 社区源表 = 绿），
// 退回内部兜底/源表未覆盖 = 黄，方便一眼扫出哪些域名需要处理。
// 中间层（当前 IP 表）是用户手填的，中性不上色。
// 宿主实际给的是带出处的长串（如「DoH 实时解析 · Cloudflare」「社区源表 · raw.hellogithub.com」），
// 必须按前缀匹配 —— 早期写成全等比较，导致所有来源都落进默认灰、上色完全失效
function ghTraceSrcCls(source: string) {
  const s = String(source || '')
  if (s.startsWith('DoH 实时解析') || s.startsWith('社区源表')) return 'gh-src-good'
  if (s.startsWith('内部兜底') || s.startsWith('源表未覆盖')) return 'gh-src-warn'
  return ''
}
// 宿主 API 走 props.services（由父级注入），不在此组件内直接引用全局变量
const api = computed(() => props.services)

// IP 表的**本地草稿**：编辑框改的是这份副本，点「保存 IP 表」才通过 emit('patch') 落盘
// （宿主会清洗非法条目，保存后的表可能和输入框里不完全一样）。
// 之所以不直接改 props.cfg.ghAccelIps：prop 是父级数据，子组件改写属于规范外的副作用，
// 且脏数据会在保存前就顺着响应式链路流出去。改为「草稿 + 显式保存」，语义更清楚。
// 同步关系：config 回推（父级 saveConfig 广播 / 打开设置加载）时重新灌入草稿 ——
// 会覆盖未保存的编辑，这与原先直接改 prop 后被回推覆盖的行为一致。
const ips = ref<Array<{ domain: string; ip: string }>>([])
watch(
  () => props.cfg.ghAccelIps,
  (v) => {
    ips.value = Array.isArray(v)
      ? v.map((it: any) => ({ domain: String(it?.domain ?? ''), ip: String(it?.ip ?? '') }))
      : []
  },
  { immediate: true, deep: true }
)

function refreshGhAccel() {
  if (!api.value.ghAccelStatus) return
  try {
    const s = api.value.ghAccelStatus()
    ghAccelActual.value = { on: s.on, degraded: !!s.degraded, active: s.active || [], hostsPath: s.hostsPath || '' }
    ghAccelConflicts.value = api.value.ghAccelScanConflicts?.() || []
    ghAccelTrace.value = api.value.ghAccelTrace?.() || null
    pullGhAccelOps() // 日志与状态同一处刷新：切到帮助 Tab / 操作结束后都能看到最新记录
  } catch (err) {}
}
// 开关绑定 cfg.ghAccelOn（意图），实际生效与否由 hosts 文件现算；失败/取消时开关回弹
// 拉取宿主操作日志。start 在操作开始时调（拿到 running 那条，日志区能实时显示「正在干什么」），
// done 在结束时调（拿终态 + 耗时）。宿主是同步内存读取，开销可忽略
function pullGhAccelOps() {
  try {
    if (api.value.ghAccelOpLogs) ghAccelOps.value = api.value.ghAccelOpLogs()
  } catch (err) {}
}
// 进行中操作的步骤要「边跑边长」。宿主是另一个进程，push 不会通知渲染进程，
// 只能定时轮询；宿主是同步内存读取，开销可忽略。仅在确实有 running 操作时轮询，
// 结束后自动停（无操作时零开销）—— 早期只在开始/结束各拉一次，中间步骤全是空的
let ghAccelOpTimer: number | null = null
function startGhAccelOpPoll() {
  if (ghAccelOpTimer !== null) return
  ghAccelOpTimer = window.setInterval(pullGhAccelOps, 500)
}
function stopGhAccelOpPoll() {
  if (ghAccelOpTimer === null) return
  window.clearInterval(ghAccelOpTimer)
  ghAccelOpTimer = null
}
watch(ghAccelRunning, (now) => {
  if (now) {
    pullGhAccelOps()
    startGhAccelOpPoll()
  } else {
    stopGhAccelOpPoll()
    pullGhAccelOps() // 收尾再拉一次，保证拿到终态（state / summary / 耗时）
  }
})
onUnmounted(stopGhAccelOpPoll)
// 打开日志折叠区时主动拉一次：否则用户没操作过就展开会看到空列表
function toggleGhAccelLog() {
  ghAccelLogFold.value = !ghAccelLogFold.value
  if (ghAccelLogFold.value) pullGhAccelOps()
}
// 单条操作的步骤默认收起，只留「状态 + 标题 + 摘要 + 耗时」一行 —— 日志一多，
// 展开全部步骤会变成几十行流水，想看的「哪次失败了」反而被淹掉。点标题行展开细节
const ghOpOpen = ref<Record<number, boolean>>({})
function toggleGhOp(id: number) {
  ghOpOpen.value[id] = !ghOpOpen.value[id]
}
// 清日志：日志是内存态，清了不影响 hosts / IP 表 / 来源追踪，且下一次操作马上又会有新记录，
// 误点的代价只是「重新操作一次」，不值得再加一次确认打断
function clearGhAccelLogs() {
  if (!api.value.ghAccelClearOpLogs) return
  try {
    api.value.ghAccelClearOpLogs()
  } catch (err) {}
  stopGhAccelOpPoll() // 被清掉的可能正是那条 running，轮询没意义了
  ghOpOpen.value = {}
  ghAccelTrace.value = api.value.ghAccelTrace?.() || null
  pullGhAccelOps()
}
// 加速开关的「意图状态」：开关本身是用户想要开/关，实际生效与否由 hosts 现算，两者可能不一致。
// config 是父级数据，子组件不能直接改写，所以统一经过这里 emit 给父级落盘。
// 注意一个赋值会**触发两次**配置回推（saveConfig 自身 + 宿主广播），开销可忽略，无需去抖
function setGhAccelOn(v: boolean) {
  emit('patch', { ghAccelOn: !!v })
}
// 勾选后先按新意图落 config，再交给 toggleGhAccel 真正去写 / 删 hosts；
// 失败或取消 UAC 时由它把意图回弹，因此这里不必等回推
function onGhAccelToggleChange(e: Event) {
  setGhAccelOn(!!(e.target as HTMLInputElement).checked)
  toggleGhAccel()
}
async function toggleGhAccel() {
  if (ghAccelBusy.value || !api.value.ghAccelEnable || !api.value.ghAccelDisable) return
  ghAccelBusy.value = true
  ghAccelFlash.msg = ''
  pullGhAccelOps()
  // 函数开头读一次意图，后面不再读 props.cfg.ghAccelOn：它可能因为回推 / 回弹而变
  const want = !!props.cfg.ghAccelOn
  try {
    const r = want
      ? await api.value.ghAccelEnable(ips.value, true)
      : await api.value.ghAccelDisable()
    if (r.ok) {
      // 开启前会先刷新 + 过滤不可达，把实际写入的表同步回配置，界面显示的才是真实内容
      if (r.ips) emit('patch', { ghAccelIps: r.ips })
      ghAccelFlash.err = false
      ghAccelFlash.msg = want
        ? '已开启：GitHub 相关域名已写入 hosts（建议先点「检测连接」验证）'
        : '已关闭：hosts 标记块已移除，其它内容未改动'
      refreshGhAccel()
      // 开启后立刻自动预演一次：hosts 是静态映射，写错了用户自己很难判断
      // （浏览器可能还在用连接池里的旧连接，看不出问题）。这里主动跑一次系统级
      // 连通性检测，不通就当场提示 + 给一键关闭，避免带着坏块不知情
      if (want) await autoVerifyAfterWrite()
    } else {
      // 弹了 UAC 但没写入（取消/失败）：hosts 没动，意图状态不该保持，弹回原样
      setGhAccelOn(!want)
      ghAccelFlash.err = true
      ghAccelFlash.msg = r.error || (r.canceled ? '已取消' : '操作失败')
    }
  } catch (err: any) {
    setGhAccelOn(!want)
    ghAccelFlash.err = true
    ghAccelFlash.msg = '操作失败：' + String(err?.message || err)
  } finally {
    ghAccelBusy.value = false
    pullGhAccelOps()
  }
}
// 写入 hosts 后的自动预演：跑一次系统级连通性检测（走真实 hosts 解析），
// 失败时把提示改成「已开启但打不开 + 怎么办」，并让「关闭」成为显眼的下一步。
// ghAccelProbe 会被赋上结果，界面上的探测提示块随之显示，不另造一套 UI
async function autoVerifyAfterWrite() {
  if (!api.value.ghAccelProbe) return
  ghAccelProbing.value = true
  try {
    ghAccelProbe.value = await api.value.ghAccelProbe()
    if (ghAccelProbe.value.ok) {
      ghAccelFlash.err = false
      ghAccelFlash.msg = '已开启并验证通过：github.com 可达（' + ghAccelProbe.value.ms + 'ms）'
    } else {
      ghAccelFlash.err = true
      ghAccelFlash.msg = '已写入 hosts，但 github.com 仍不可达：'
        + (ghAccelProbe.value.error || '未知错误')
        + '。可点「重新写入 hosts」换个 IP 重试；若一直不行，建议先关闭加速，改用其它加速方式或等待网络恢复'
    }
  } catch (err: any) {
    ghAccelProbe.value = { ok: false, ms: 0, error: String(err?.message || err) }
  } finally {
    ghAccelProbing.value = false
    pullGhAccelOps()
  }
}
// 开关已开、但 IP 表刚改过时，按新表再写一次 hosts（会再弹一次 UAC）
async function doReapplyGhAccel() {
  if (ghAccelBusy.value || !api.value.ghAccelEnable) return
  ghAccelBusy.value = true
  ghAccelFlash.msg = ''
  pullGhAccelOps()
  try {
    const r = await api.value.ghAccelEnable(ips.value, false)
    if (r.ok) {
      ghAccelFlash.err = false
      ghAccelFlash.msg = '已按当前 IP 表重新写入 hosts'
      refreshGhAccel()
      await autoVerifyAfterWrite() // 重写等于换了一批 IP，同样要预演一次确认真的通了
    } else {
      ghAccelFlash.err = true
      ghAccelFlash.msg = r.error || '写入失败'
    }
  } catch (err: any) {
    ghAccelFlash.err = true
    ghAccelFlash.msg = '写入失败：' + String(err?.message || err)
  } finally {
    ghAccelBusy.value = false
    pullGhAccelOps()
  }
}
// 一键刷新 IP 表（GitHub520 社区源）：成功直接替换配置里的表；失败保留旧表
async function doRefreshGhAccelIps() {
  if (ghAccelBusy.value || !api.value.ghAccelRefreshIps) return
  ghAccelBusy.value = true
  ghAccelFlash.msg = ''
  pullGhAccelOps()
  try {
    const r = await api.value.ghAccelRefreshIps(ips.value)
    if (r.ok && r.updated) {
      emit('patch', { ghAccelIps: r.updated })
      ghAccelTableDirty.value = false
      ghAccelVerify.value = null // 整表换新，旧校验结论全部作废
      ghAccelFlash.err = false
      ghAccelFlash.msg = '已更新 ' + r.updated.length + ' 个域名' + (r.total ? '（源共 ' + r.total + ' 条）' : '') + (props.cfg.ghAccelOn ? '；已开启时请点「重新写入 hosts」生效' : '')
      refreshGhAccel() // 刷新源/来源追踪变了，「GitHub 加速日志」里的来源表跟着更新
    } else {
      ghAccelFlash.err = true
      ghAccelFlash.msg = r.error || '刷新失败'
    }
  } catch (err: any) {
    ghAccelFlash.err = true
    ghAccelFlash.msg = '刷新失败：' + String(err?.message || err)
  } finally {
    ghAccelBusy.value = false
    pullGhAccelOps()
  }
}
// 连通性自检：HEAD https://github.com。开启前后各测一次对比，判断 hosts 直连是否真的更快
async function doGhAccelProbe() {
  if (ghAccelProbing.value || !api.value.ghAccelProbe) return
  ghAccelProbing.value = true
  pullGhAccelOps()
  try {
    ghAccelProbe.value = await api.value.ghAccelProbe()
    refreshGhAccel() // 探测走系统解析，连带确认 hosts 真实状态，避免「已生效」停留在旧状态误导
  } catch (err: any) {
    ghAccelProbe.value = { ok: false, ms: 0, error: String(err?.message || err) }
  } finally {
    ghAccelProbing.value = false
    pullGhAccelOps()
  }
}
function saveGhAccelIps() {
  // 保存的是本地草稿；非法条目由宿主清洗（会被丢），回推后草稿跟着刷新
  emit('patch', { ghAccelIps: ips.value })
  ghAccelTableDirty.value = false
  ghAccelVerify.value = null // 表变了，上次校验结论作废，否则行标色会张冠李戴
  ghAccelFlash.err = false
  ghAccelFlash.msg = 'IP 表已保存' + (props.cfg.ghAccelOn ? '；如需让新表生效请点「重新写入 hosts」' : '；开启加速后生效')
}
// 校验 IP 表：逐条探测，把不可达的挑出来。只出结论不改表，删不删由用户点「清除不可用」决定
async function doVerifyGhAccelIps() {
  if (ghAccelVerifying.value || !api.value.ghAccelVerifyIps) return
  if (!ips.value.length) {
    ghAccelFlash.err = true
    ghAccelFlash.msg = 'IP 表是空的，先点「刷新 IP 表」或手动添加'
    return
  }
  ghAccelVerifying.value = true
  ghAccelFlash.msg = ''
  pullGhAccelOps()
  try {
    const r = await api.value.ghAccelVerifyIps(ips.value)
    ghAccelVerify.value = r
    ghAccelFlash.err = false
    const good = r.results.length - r.bad.length - r.stale.length
    ghAccelFlash.msg = '校验完成：' + good + ' 条可用'
      + (r.bad.length ? '，' + r.bad.length + ' 条不可用（可点「清除不可用」）' : '')
      + (r.stale.length ? '，' + r.stale.length + ' 条探测失败但仍是当前 DNS 解析结果（建议保留）' : '')
  } catch (err: any) {
    ghAccelFlash.err = true
    ghAccelFlash.msg = '校验失败：' + String(err?.message || err)
  } finally {
    ghAccelVerifying.value = false
    pullGhAccelOps()
  }
}
// 清除校验判定为不可用的条目（只删 bad，stale 保留）。删完要落盘，开了加速还需重写 hosts 生效
function dropBadGhAccelIps() {
  const v = ghAccelVerify.value
  if (!v || !v.bad.length) return
  const drop = new Set(v.bad.map((r) => r.domain + '\u0000' + r.ip))
  const before = ips.value.length
  ips.value = ips.value.filter((it) => !drop.has(String(it.domain) + '\u0000' + String(it.ip)))
  const removed = before - ips.value.length
  emit('patch', { ghAccelIps: ips.value })
  ghAccelVerify.value = null
  ghAccelTableDirty.value = false
  ghAccelFlash.err = false
  ghAccelFlash.msg = '已清除 ' + removed + ' 条不可用 IP'
    + (props.cfg.ghAccelOn ? '；请点「重新写入 hosts」让新表生效' : '')
}
function addGhAccelRow() {
  ips.value.push({ domain: '', ip: '' })
  ghAccelTableDirty.value = true
  ghAccelVerify.value = null
}
function removeGhAccelRow(i: number) {
  ips.value.splice(i, 1)
  ghAccelTableDirty.value = true
  ghAccelVerify.value = null
}
// 进入帮助 Tab 时刷新一次 hosts 实际状态（其它时间可能被手动改过 hosts）
watch(() => props.activeTab, (k) => { if (k === 'help') refreshGhAccel() })
// 离开帮助 Tab 就丢掉校验结论：探测结果有时效，下次进来重新测，避免用旧结论标色误导
watch(() => props.activeTab, (k) => { if (k !== 'help') ghAccelVerify.value = null })
</script>

<template>
  <!-- 根元素固定为 .gh-accel 容器（本组件始终渲染，显隐交给外层的 v-if="activeTab === 'help'"）：
       这样 CSS 变量与 scoped 样式有一个稳定的宿主节点，卡片本身仍是 .card，视觉不变 -->
  <div class="gh-accel">
    <!-- [帮助] GitHub 加速（hosts 方案）：走系统 hosts 直连，不装常驻进程 -->
    <section class="card">
    <h2>GitHub 加速</h2>
    <p class="hint">改写系统 <strong>hosts</strong> 让 GitHub 相关域名直连可用 IP，浏览器 / git / 下载全生效，<strong>不占常驻进程</strong>。写入需一次 <strong>UAC 确认</strong>，关闭即删块，不动你原有的 hosts 内容。写入前会逐条做 <strong>HTTPS 探测 + 证书校验</strong>，只写真正可用、且证书确实是该域名的 IP；同一域名会有多个备用 IP 一起写入，主 IP 失效时由系统按顺序自动回退。</p>
    <label class="field row check">
      <span class="label">启用 GitHub 加速</span>
      <!-- 勾选即写 config（走的仍是父级 patch），随后由 toggleGhAccel 真正落 hosts；
           失败 / 取消 UAC 时函数内部会把开关回弹，所以这里不用等回推 -->
      <input type="checkbox" :checked="cfg.ghAccelOn" :disabled="ghAccelBusy" @change="onGhAccelToggleChange" />
    </label>
    <label class="field row">
      <span class="label">实际状态</span>
      <span class="ver" v-if="ghAccelActual">
        {{ ghAccelActual.on ? '已生效（' + ghAccelActual.active.length + ' 个域名）' : '未生效' }}
      </span>
      <span class="ver" v-else>读取中…</span>
    </label>
    <label class="field row">
      <span class="label">上次刷新</span>
      <span class="ver">{{ ghAccelAgeText() }}</span>
    </label>
    <p v-if="ghAccelStale" class="msg err">IP 表已超 7 天未刷新（CDN IP 会变）。当前开启时会优先用 DoH 实时解析的结果，源表只作回退，所以多半仍可用；想彻底更新源表可点「刷新 IP 表」再「重新写入 hosts」。</p>
    <!-- github.com 不在已写入的块里：主站仍走被污染的 DNS，这正是「已生效但打不开」的常见原因 -->
    <p v-if="ghAccelActual?.on && ghAccelActual.active && !ghAccelActual.active.includes('github.com')" class="msg err">
      块里<strong>没有 github.com</strong>，主站仍走 DNS 可能打不开。请「刷新 IP 表」后再「重新写入 hosts」。
    </p>
    <!-- 块被挤出文件最前：其它工具在本插件之后又写了 hosts，first-match 被抢、加速失效 -->
    <p v-if="ghAccelActual?.on && ghAccelActual.degraded" class="msg err">
      检测到本插件写入的 hosts 块被其它工具<strong>挤到了文件后段</strong>（可能是在本插件之后又写过 hosts），会被其条目抢先解析。点「重新写入 hosts」把块移回文件最前。
    </p>
    <p class="hint" v-if="ghAccelActual && ghAccelActual.hostsPath">hosts 文件：<code>{{ ghAccelActual.hostsPath }}</code></p>
    <!-- 冲突提示：其它工具常驻 127.0.0.1 条目；本插件块写在文件最前，first-match 优先生效 -->
    <!-- 故此处不是警告而是提示：无需先关对方 -->
    <p v-if="ghAccelConflicts.length" class="msg err">
      检测到第三方条目（可能是其它加速工具写的）：{{ ghAccelConflicts.map(c => c.domain).join('、') }}。本插件块写在文件最前会优先生效，可直接使用；若要彻底替换对方，请先在其设置里关闭对应的 GitHub 加速。
    </p>
    <div class="btn-row">
      <button class="secondary" :disabled="ghAccelProbing" @click="doGhAccelProbe">
        {{ ghAccelProbing ? '检测中…' : '检测连接' }}
      </button>
      <button class="secondary" :disabled="ghAccelBusy" @click="doRefreshGhAccelIps">刷新 IP 表</button>
      <button v-if="cfg.ghAccelOn" class="secondary" :disabled="ghAccelBusy" @click="doReapplyGhAccel">重新写入 hosts</button>
    </div>
    <p v-if="ghAccelProbe" class="msg" :class="ghAccelProbe.ok ? 'ok' : 'err'">
      {{ ghAccelProbe.ok ? 'github.com 可达，耗时 ' + ghAccelProbe.ms + 'ms' + (ghAccelProbe.status ? '（HTTP ' + ghAccelProbe.status + '）' : '') : '无法访问 github.com：' + (ghAccelProbe.error || '未知错误') }}<template v-if="ghAccelProbe.ok && !ghAccelActual?.on"> —— 开启前已可达（可能靠其它加速工具或代理），hosts 直连可能绕开现有代理，建议开启后再测一次对比</template>
    </p>
    <!-- 探测失败但块里确实有 github.com：写入的那个 IP 刚失效，重写一次让插件重新探测换 IP -->
    <p v-if="ghAccelProbe && !ghAccelProbe.ok && ghAccelActual?.on && ghAccelActual.active.includes('github.com')" class="msg err">
      写入的 github.com IP 当前不可达（可能刚失效），点「重新写入 hosts」换一个可用 IP。
    </p>
    <p v-if="ghAccelFlash.msg" class="msg" :class="msgCls(ghAccelFlash)">{{ ghAccelFlash.msg }}</p>
    <!-- GitHub 加速日志：一次操作（开启/关闭/刷新/校验/检测）= 一条，默认只留一行摘要，点开看步骤。
         数据来自宿主的操作日志环形缓冲（内存态）+ 最近一次 IP 获取的来源追踪 -->
    <div class="fold">
      <button class="link-btn" @click="toggleGhAccelLog">
        {{ ghAccelLogFold ? '收起 GitHub 加速日志' : 'GitHub 加速日志' + (ghAccelOps.length ? '（' + ghAccelOps.length + '）' : '') }}
      </button>
      <div v-if="ghAccelLogFold" class="guide">
        <p class="hint">
          每次「开启 / 关闭 / 检测连接 / 刷新 IP 表 / 校验可用性 / 重新写入 hosts」记一条，留最近 50 条，
          <strong>重开插件后清空</strong>。点一条可展开它的每一步。
        </p>
        <!-- 进行中的操作排最前，步骤始终展开（就几条，且此刻用户最关心在干什么） -->
        <div v-if="ghAccelRunning" class="gh-op gh-op-running">
          <div class="gh-op-head">
            <span class="gh-op-state">进行中</span>
            <span class="gh-op-title">#{{ ghAccelRunning.id }} {{ ghAccelRunning.title }}</span>
          </div>
          <ul class="gh-op-steps">
            <li v-for="(s, i) in ghAccelRunning.steps" :key="i" :class="'gh-step-' + s.state">
              <span class="gh-step-mark">{{ ghStepMark(s.state) }}</span>
              <span class="gh-step-text">{{ s.text }}</span>
              <span v-if="s.detail" class="gh-step-detail">{{ s.detail }}</span>
            </li>
          </ul>
        </div>
        <div v-for="op in ghAccelOpsDone" :key="op.id" class="gh-op" :class="'gh-op-' + op.state">
          <button class="gh-op-head" @click="toggleGhOp(op.id)">
            <span class="gh-op-state">{{ ghOpStateText(op.state) }}</span>
            <span class="gh-op-title">#{{ op.id }} {{ op.title }}</span>
            <span class="gh-op-meta">{{ new Date(op.at).toLocaleTimeString() }} · {{ op.ms }}ms</span>
            <span class="gh-op-caret">{{ ghOpOpen[op.id] ? '▾' : '▸' }}</span>
          </button>
          <p v-if="op.summary" class="gh-op-summary">{{ op.summary }}</p>
          <ul class="gh-op-steps" v-if="ghOpOpen[op.id]">
            <li v-for="(s, i) in op.steps" :key="i" :class="'gh-step-' + s.state">
              <span class="gh-step-mark">{{ ghStepMark(s.state) }}</span>
              <span class="gh-step-text">{{ s.text }}</span>
              <span v-if="s.detail" class="gh-step-detail">{{ s.detail }}</span>
            </li>
          </ul>
        </div>
        <p v-if="!ghAccelOps.length" class="hint">还没有操作记录：点一次「检测连接」或「刷新 IP 表」，这里会列出每一步做了什么、结果如何。</p>
        <div class="btn-row" v-if="ghAccelOps.length">
          <button class="secondary" @click="clearGhAccelLogs">清除日志</button>
        </div>

        <!-- IP 来源追踪：回答「每个域名的 IP 通过什么方式、从哪里获取」 -->
        <p class="hint" style="margin-top:14px"><strong>最近一次 IP 获取来源</strong>（开启加速 / 刷新 IP 表 / 重新写入时更新）。优先级：DoH 实时解析 &gt; 社区源表 &gt; 当前 IP 表 &gt; 内部兜底。</p>
        <template v-if="ghAccelTrace && ghAccelTrace.at">
          <p class="hint">时间：<code>{{ new Date(ghAccelTrace.at).toLocaleString() }}</code></p>
          <p class="hint" v-if="ghAccelTrace.dohResolvers.length">
            DoH 实时解析入口：<code>{{ ghAccelTrace.dohResolvers.join('、') }}</code>
          </p>
          <p class="hint" v-if="ghAccelTrace.refreshUrl">刷新源：<code>{{ ghAccelTrace.refreshUrl }}</code></p>
          <!-- 主表：每个域名最终用了哪个 IP、从哪来。实时解析 & 内部兜底只在「来源」列里点名 -->
          <table class="gh-trace-table">
            <thead>
              <tr><th>域名</th><th>IP</th><th>来源</th></tr>
            </thead>
            <tbody>
              <tr v-for="(d, i) in Object.keys(ghAccelTrace.byDomain)" :key="i">
                <td class="gh-trace-domain">{{ d }}</td>
                <td><code>{{ ghAccelTrace.byDomain[d].ip }}</code></td>
                <td :class="ghTraceSrcCls(ghAccelTrace.byDomain[d].source)">{{ ghAccelTrace.byDomain[d].source }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <p v-else class="hint">还没有获取记录：开启加速、刷新 IP 表或重新写入后，这里会列出每个域名最终使用的 IP 与来源。</p>
      </div>
    </div>
    <div class="fold">
      <button class="link-btn" @click="ghAccelIpsFold = !ghAccelIpsFold">
        {{ ghAccelIpsFold ? '收起 IP 表编辑' : '编辑 IP 表' }}
      </button>
      <div v-if="ghAccelIpsFold" class="guide">
        <p class="hint">一行一个域名 + IP，域名留空或 IP 非法会在保存时丢弃；编辑完点「保存 IP 表」。</p>
        <div v-for="(row, i) in ips" :key="i" class="gh-ip-row">
          <input v-model="row.domain" class="gh-ip-domain" placeholder="域名，如 github.com" spellcheck="false" />
          <input v-model="row.ip" class="gh-ip-ip" placeholder="IPv4，如 140.82.112.3" spellcheck="false" />
          <span class="gh-ip-state" :class="'gh-ip-' + ghIpState(row.domain, row.ip)">{{ ghIpStateText(ghIpState(row.domain, row.ip)) }}</span>
          <button class="link-btn" @click="removeGhAccelRow(i)">删除</button>
        </div>
        <div class="btn-row">
          <button class="secondary" @click="addGhAccelRow">＋ 添加域名</button>
          <button class="secondary" @click="saveGhAccelIps">保存 IP 表</button>
          <button class="secondary" :disabled="ghAccelVerifying" @click="doVerifyGhAccelIps">
            {{ ghAccelVerifying ? '校验中…' : '校验可用性' }}
          </button>
          <button
            v-if="ghAccelVerify && ghAccelVerify.bad.length"
            class="secondary"
            @click="dropBadGhAccelIps"
          >清除 {{ ghAccelVerify.bad.length }} 条不可用</button>
        </div>
        <p class="hint" v-if="ghAccelVerify">
          校验于 {{ new Date(ghAccelVerify.checkedAt).toLocaleTimeString() }}：<span class="gh-ip-ok">可用</span> /
          <span class="gh-ip-bad">不可用</span>（连不上该域名的正确边缘，清掉后开启时会自动改用其它来源）/
          <span class="gh-ip-stale">探测失败但仍是当前 DNS 解析结果</span>（多为瞬时抖动，建议保留）。
        </p>
      </div>
    </div>
    <p class="hint">IP 失效时<strong>关一次开关再开</strong>即按新表重写（最坏回到慢速，不会更糟）。首次开启会把原 hosts 备份到<strong>插件数据目录 <code>whale-hosts-backup</code></strong>，供手动恢复；卸载不影响系统 hosts，记得先关闭。</p>
    </section>
  </div>
</template>

<style scoped>
/* 本组件自带一份设计令牌：scoped 样式不会跨越组件边界，父级 .page 上的 CSS 变量
   在子组件里拿不到（会退化成继承值 / 空值），所以这里必须自带一份。
   数值需与 App.vue 的 .page / 暗色媒体查询保持一致 —— 改配色时要两处一起改。 */
.gh-accel {
  --fg: #1f2a44;
  --fg-dim: #536ba9;
  --fg-faint: #9fb0d9;
  --accent: #536ba9;
  --line: rgba(83, 107, 169, 0.4);
  --card-bg: rgba(127, 127, 127, 0.08);
  --card-border: rgba(127, 127, 127, 0.18);
  --input-bg: #ffffff;
  --ok: #2fa24c;
  --err: #e0433f;
  --warn: #c07d1a;
  display: block;
}
@media (prefers-color-scheme: dark) {
  .gh-accel {
    --fg: #e8ecf5;
    --fg-dim: #9fb0d9;
    --fg-faint: #7f8db3;
    --accent: #8aa4e6;
    --line: rgba(255, 255, 255, 0.22);
    --card-bg: rgba(255, 255, 255, 0.06);
    --card-border: rgba(255, 255, 255, 0.12);
    --input-bg: #2b3145;
    --ok: #4ec46b;
    --err: #ff6b66;
    --warn: #e0a63c;
  }
}
/* 通用控件样式：原本由 App.vue 的 scoped 样式提供，组件拆分后 scoped 隔离掉了，
   这里按本组件用到的部分补齐一份（.card / .field / .label / .btn-row / .msg / .guide / .fold 等） */
.gh-accel .card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}
.gh-accel .card h2 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-dim);
}
.gh-accel .field {
  display: block;
  margin: 10px 0;
}
.gh-accel .field.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.gh-accel .field.check {
  justify-content: flex-start;
  /* 标签换行成多行时，复选框跟首行对齐 —— 居中对齐会飘到两行之间，看起来像对错了行 */
  align-items: flex-start;
}
.gh-accel .label {
  font-size: 13px;
  /* 短标签保持 72px 起始宽度、纵向对齐（同组控件左侧对齐）；
     flex-shrink 允许长标签在窄卡片里收缩换行，而不是顶住不缩把整张卡片撑出边界 */
  flex: 0 1 auto;
  min-width: 72px;
  overflow-wrap: anywhere;
}
.gh-accel .field.check .label {
  flex: 1 1 auto;
  min-width: 0;
  line-height: 1.5;
}
.gh-accel input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
.gh-accel .ver {
  font-size: 13px;
  color: var(--fg-dim);
}
.gh-accel .btn-row {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  /* IP 表这排最多会到 4 个按钮（添加/保存/校验/清除），窄窗下换行而不是把文字挤成竖排 */
  flex-wrap: wrap;
}
.gh-accel .btn-row button {
  flex: 1;
  border-radius: 8px;
  font-size: 13px;
}
.gh-accel .btn-row button.secondary {
  background: rgba(83, 107, 169, 0.18);
  color: var(--accent);
}
.gh-accel .btn-row button:disabled {
  opacity: 0.45;
  cursor: default;
}
.gh-accel .msg {
  margin: 10px 0 0;
  font-size: 12px;
}
.gh-accel .msg.ok {
  color: var(--ok);
}
.gh-accel .msg.err {
  color: var(--err);
}
.gh-accel .hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-faint);
  line-height: 1.6;
}
.gh-accel .hint code,
.gh-accel .guide code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.18);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  word-break: break-all;
}
.gh-accel .link-btn {
  margin-top: 10px;
  padding: 0;
  border: none;
  background: none;
  color: var(--fg-dim);
  font-size: 12px;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.gh-accel .link-btn:hover {
  color: var(--fg);
}
.gh-accel .guide {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--input-bg);
  font-size: 12px;
  line-height: 1.6;
}
/* 分组折叠（GitHub 加速日志 / 编辑 IP 表）：组间留白并用分隔线隔开 */
.gh-accel .fold {
  margin-top: 12px;
}
.gh-accel .fold > .link-btn {
  margin-top: 0;
}
.gh-accel .fold + .fold {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

/* GitHub 加速：IP 表编辑行（域名 + IP 两个输入框并排） */
.gh-accel .gh-ip-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
.gh-accel .gh-ip-row input {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid rgba(127, 127, 127, 0.25);
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
  color: var(--fg);
  font-size: 12px;
}
/* ── GitHub 加速日志：一次操作一条 ── */
.gh-accel .gh-op {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
/* 进行中：左侧加一条强调色，和已结束的记录区分开 */
.gh-accel .gh-op-running {
  border-color: var(--ok);
  background: color-mix(in srgb, var(--ok) 6%, transparent);
}
/* 标题行现在是个按钮（点开看步骤）：抹掉浏览器默认样式，保持原来的一行布局 */
.gh-accel .gh-op-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  box-sizing: border-box;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.gh-accel .gh-op-head:hover .gh-op-title {
  color: var(--accent, var(--fg));
}
.gh-accel .gh-op-running .gh-op-head {
  cursor: default;
}
/* 展开指示器固定在行尾，收起 ▸ / 展开 ▾ */
.gh-accel .gh-op-caret {
  margin-left: auto;
  color: var(--fg-faint);
  font-size: 11px;
}
.gh-accel .gh-op-state {
  flex: none;
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 11px;
  background: rgba(127, 127, 127, 0.16);
  color: var(--fg-dim);
}
.gh-accel .gh-op-ok .gh-op-state {
  background: rgba(47, 162, 76, 0.16);
  color: var(--ok);
}
.gh-accel .gh-op-fail .gh-op-state {
  background: rgba(224, 67, 63, 0.16);
  color: var(--err);
}
.gh-accel .gh-op-cancel .gh-op-state {
  background: rgba(192, 125, 26, 0.16);
  color: var(--warn);
}
.gh-accel .gh-op-running .gh-op-state {
  background: rgba(47, 162, 76, 0.16);
  color: var(--ok);
}
.gh-accel .gh-op-title {
  font-size: 12px;
  color: var(--fg);
}
.gh-accel .gh-op-meta {
  margin-left: auto;
  font-size: 11px;
  color: var(--fg-faint);
}
.gh-accel .gh-op-summary {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--fg-dim);
}
.gh-accel .gh-op-steps {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.gh-accel .gh-op-steps li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-dim);
}
.gh-accel .gh-step-mark {
  flex: none;
  width: 1em;
  text-align: center;
}
.gh-accel .gh-step-text {
  word-break: break-all;
}
.gh-accel .gh-step-detail {
  color: var(--fg-faint);
  font-size: 11px;
}
.gh-accel .gh-step-done .gh-step-mark {
  color: var(--ok);
}
.gh-accel .gh-step-fail .gh-step-mark,
.gh-accel .gh-step-fail .gh-step-detail {
  color: var(--err);
}
.gh-accel .gh-step-skip .gh-step-mark {
  color: var(--fg-faint);
}
.gh-accel .gh-step-running .gh-step-mark {
  color: var(--accent);
}
.gh-accel .gh-ip-row .gh-ip-ip {
  flex: 0 0 150px;
}
.gh-accel .gh-ip-state {
  flex: none;
  width: 42px;
  font-size: 11px;
  color: var(--fg-faint);
}
.gh-accel .gh-ip-state.gh-ip-ok {
  color: var(--ok);
}
.gh-accel .gh-ip-state.gh-ip-bad {
  color: var(--err);
}
.gh-accel .gh-ip-state.gh-ip-stale {
  color: var(--warn);
}
.gh-accel .gh-ip-ok {
  color: var(--ok);
}
.gh-accel .gh-ip-bad {
  color: var(--err);
}
.gh-accel .gh-ip-stale {
  color: var(--warn);
}
.gh-accel .gh-ip-row .link-btn {
  margin-top: 0;
}
.gh-accel .gh-trace-table {
  width: 100%;
  margin-top: 8px;
  border-collapse: collapse;
  font-size: 12px;
}
.gh-accel .gh-trace-table th,
.gh-accel .gh-trace-table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
.gh-accel .gh-trace-table th {
  color: var(--fg-faint);
  font-weight: 500;
}
.gh-accel .gh-trace-domain {
  color: var(--fg);
  word-break: break-all;
}
.gh-accel .gh-trace-table td:last-child {
  white-space: nowrap;
}
.gh-accel .gh-trace-table td.gh-src-good {
  color: var(--ok);
}
.gh-accel .gh-trace-table td.gh-src-warn {
  color: var(--warn);
}
</style>
