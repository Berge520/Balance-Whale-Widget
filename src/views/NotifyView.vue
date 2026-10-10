<script lang="ts" setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { msgCls, useFlashShow } from '../composables/useFlash'
import type { AlertRole, SoundRole, WhaleMailSecrets, WhaleServices } from '../types/services'

// 「提醒与通知」整卡：四类自动提醒（峰谷切换 / 低余额 / 今日预算 / 余额大幅波动）+
// 计时（时长 / 到点留言 / 休息档）+ 通知方式（系统 / 邮件 + SMTP 配置）+ 提醒音独立音量 + 提醒文案折叠。
// 从设置页 App.vue 抽出。以下项仍留在父级，按 props 下传或 emit 触发，不能跟着搬：
//   - applyConfig / patchCfg：applyConfig 是父级 onConfigChange 订阅与备份恢复共用的回填入口，
//     本卡保存提醒文案后要「整份回填 + 落盘」，只能 emit 请求父级做（applyConfig 搬不动）。
//   - usageCurrency：额度/预算/波动三处阈值单位靠它（跨卡共享，notify 卡与 usage 卡共用），留父级。
//   - ALERT_SOUND_ROLES / SOUND_ROLE_LABEL：提醒音槽位与标签。
//     SOUND_ROLE_LABEL 还被 settings 里其它卡（音效导入、共享音效选用）引用，跨卡共享，留父级。
//   - soundsMeta / soundFlash 等音效资源状态：音效导入导出在「外观」页，跨卡共享。
//   - cfg.alerts 的基线比对（alertsBaseline）随本卡搬入 —— 它只服务本卡的「未保存」提示。
// 随卡搬入的：计时时长三段输入 / 到点留言 / 休息档、四类提醒的开关与阈值联动、通知渠道与 SMTP 配置、
// 提醒音独立音量的三态计算、提醒文案的编辑 / 保存 / 恢复默认与折叠态。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写提醒 / 计时 / 邮件相关字段，落盘统一走 emit('patch')
  cfg: any
  services: Partial<WhaleServices>
  // 记账币种（'CNY' / 'USD'）：预算 / 阈值输入框的单位靠它
  usageCurrency: string
  // 到点留言长度上限（父级 TIMER_NOTE_MAX）
  timerNoteMax: number
  // 提醒音槽位与标签（父级 ALERT_SOUND_ROLES / SOUND_ROLE_LABEL），跨卡共享故以 props 下传
  alertSoundRoles: AlertRole[]
  soundRoleLabel: Record<SoundRole, string>
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
  // 保存 / 恢复默认提醒文案：需要父级 applyConfig(services.getConfig()) 整份回填后落盘
  (e: 'save-alerts', alerts: Record<string, string> | null): void
}>()

// 统一的消息态（Flash）：定义收口在 composables/useFlash.ts，各卡不再各持一份。

// —— 计时：时长三段输入 / 到点留言 / 「休息」档 ——
// 配置里只存总秒数（timerSec），三段输入是它的展示形态；
// 拆出来的 h/m/s 单独放一份本地状态，避免每次输入都被折算回秒再拆回来导致光标跳动
const timerHms = reactive({ h: 0, m: 0, s: 0 })
function syncTimerHms() {
  const sec = Math.max(0, Math.min(86399, Math.round(Number(props.cfg.timerSec) || 0)))
  timerHms.h = Math.floor(sec / 3600)
  timerHms.m = Math.floor((sec % 3600) / 60)
  timerHms.s = sec % 60
}
// 三段全填 0 时按 25 分钟兜底：否则「填了 0 就开不了计时」，且宿主侧清洗也会把它拉回默认值
function commitTimerHms() {
  const sec = Math.round(Number(timerHms.h) || 0) * 3600 + Math.round(Number(timerHms.m) || 0) * 60 + Math.round(Number(timerHms.s) || 0)
  emit('patch', { timerSec: Math.max(1, Math.min(86399, sec || 1500)) })
  syncTimerHms()
}
// 「休息」档：0 分钟 = 不显示休息按钮（与挂件菜单 hideBubble 后的按钮显隐同口径）
const timerBreakOn = computed({
  get: () => props.cfg.timerBreakMin > 0,
  set: (v: boolean) => { onTimerBreakToggle(v) },
})
const timerBreakMinEdit = computed({
  get: () => (props.cfg.timerBreakMin > 0 ? props.cfg.timerBreakMin : 5),
  set: () => {},
})
// 打开时补一个可用值（5 分钟），关掉时归零（= 不显示按钮）
function onTimerBreakToggle(on: boolean) {
  emit('patch', { timerBreakMin: on ? (props.cfg.timerBreakMin > 0 ? props.cfg.timerBreakMin : 5) : 0 })
}
function commitTimerBreak() {
  emit('patch', { timerBreakMin: timerBreakMinEdit.value })
}

// —— 四类提醒开关的联动 ——
// 打开「今日预算提醒」时补一个可用金额，避免开关开着但金额为 0（等于不提醒）
function onBudgetToggle(on: boolean) {
  const amount = props.cfg.budgetAmount > 0 ? props.cfg.budgetAmount : 10
  emit('patch', { budgetOn: on, budgetAmount: on ? amount : props.cfg.budgetAmount })
}
// 同理：打开「余额大幅波动通知」时补一个可用阈值，避免开关开着但阈值为 0
function onDropToggle(on: boolean) {
  const amount = props.cfg.dropAlertAmount > 0 ? props.cfg.dropAlertAmount : 5
  emit('patch', { dropAlertOn: on, dropAlertAmount: on ? amount : props.cfg.dropAlertAmount })
}

// —— 提醒音独立音量（三态：跟随全局 / 独立生效，语义对齐悬浮窗 alertVolumeOf） ——
// 展示值：未显式设置（volSet=false）时显示全局音量当「跟随值」，滑块以此为起点
function alertVolShown(r: AlertRole): number {
  if (props.cfg.alertVols[r].volSet) return props.cfg.alertVols[r].vol
  return typeof props.cfg.vol === 'number' && isFinite(props.cfg.vol) ? props.cfg.vol : 0.9
}
function alertVolSummary(r: AlertRole): string {
  const av = props.cfg.alertVols[r]
  return av.volSet ? Math.round(av.vol * 100) + '%' : '跟随 ' + Math.round(alertVolShown(r) * 100) + '%'
}
// 拖动 = 显式设置（volSet=true，此后不再跟随全局）；「恢复」= 回到跟随（音量复位默认 100%）
function setAlertVol(r: AlertRole, v: number, set: boolean) {
  const n = Number(v)
  const vol = Math.round(Math.min(1, Math.max(0, isFinite(n) ? n : 0)) * 100) / 100
  // 整份传：宿主 patchConfig 按 alertVols 键整体归一化。浅拷贝防 reactive 代理过 contextBridge
  emit('patch', {
    alertVols: {
      low: { ...props.cfg.alertVols.low, vol: r === 'low' ? vol : props.cfg.alertVols.low.vol, volSet: r === 'low' ? set : props.cfg.alertVols.low.volSet },
      budget: { ...props.cfg.alertVols.budget, vol: r === 'budget' ? vol : props.cfg.alertVols.budget.vol, volSet: r === 'budget' ? set : props.cfg.alertVols.budget.volSet },
      peak: { ...props.cfg.alertVols.peak, vol: r === 'peak' ? vol : props.cfg.alertVols.peak.vol, volSet: r === 'peak' ? set : props.cfg.alertVols.peak.volSet },
      pass: { ...props.cfg.alertVols.pass, vol: r === 'pass' ? vol : props.cfg.alertVols.pass.vol, volSet: r === 'pass' ? set : props.cfg.alertVols.pass.volSet },
    },
  })
}
function resetAlertVol(r: AlertRole) {
  setAlertVol(r, 1, false)
}
function onAlertVolInput(r: AlertRole, e: Event) {
  setAlertVol(r, Number((e.target as HTMLInputElement).value), true)
}
// 提醒文案编辑：整份传出（宿主按 alerts 键整体归一化），只改目标键，其余保持原值
function onAlertEdit(key: string, e: Event) {
  const alerts: Record<string, string> = {}
  for (const f of ALERT_FIELDS) alerts[f.key] = String(props.cfg.alerts[f.key] || '')
  alerts[key] = (e.target as HTMLTextAreaElement).value
  emit('patch', { alerts })
}

// —— 提醒文案（低余额 / 今日预算 / 峰谷切换 / 鼠标穿透四类自动提醒的气泡与系统通知文案） ——
// 模板按行映射到气泡三行：第 1 行标题 / 第 2 行大字 / 第 3 行说明；系统通知取全文（换行合并成一行）
const ALERT_FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'low', label: '低余额预警', hint: '余额低于预警阈值时提醒；{balance} = 当前余额，{threshold} = 预警阈值' },
  { key: 'budget', label: '今日预算', hint: '今日用量超出预算时提醒；{used} = 今日已用，{budget} = 预算额，{over} = 超出金额' },
  { key: 'peakOn', label: '进入峰时', hint: '进入高峰时段时提醒；{schedule} = 峰时时段表（如 峰时9-12/14-18点）' },
  { key: 'peakOff', label: '进入谷时', hint: '进入低谷时段时提醒；{schedule} = 峰时时段表（如 峰时9-12/14-18点）' },
  { key: 'passOn', label: '穿透开启', hint: '开启鼠标穿透时提醒（无占位符）' },
  { key: 'passOff', label: '穿透关闭', hint: '关闭鼠标穿透时提醒（无占位符）' },
]
// 整份提醒文案的回执：3s 自动消失（本卡最长文案也短，无需 4s）
const { flash: alertFlash, show: alertFlashShow, clear: alertFlashClear, stop: alertFlashStop } = useFlashShow(3000)
const alertResetConfirm = ref(false)
// 保存：整份交给宿主清洗（去空白 / 丢空行 / 限长），再回读一次拿到清洗后的结果
// （回填 + 落盘由父级 applyConfig 负责，本卡只把要保存的整份内容上抛）
function saveAlerts() {
  alertResetConfirm.value = false
  const alerts: Record<string, string> = {}
  for (const f of ALERT_FIELDS) alerts[f.key] = String(props.cfg.alerts[f.key] || '')
  alertFlashShow('已保存')
  emit('save-alerts', alerts)
}
// 恢复默认：整组传 null，由宿主填回内置文案。同样会覆盖全部自定义文案，先要一次二次确认
function resetAlerts() {
  if (!alertResetConfirm.value) {
    alertResetConfirm.value = true
    alertFlashClear()
    return
  }
  alertResetConfirm.value = false
  alertFlashShow('已恢复默认文案')
  emit('save-alerts', null)
}

// 提醒文案折叠：与上面的开关同属「提醒」主题，收在「提醒与通知」卡里，不再单独占「外观」页一张卡
const alertFolds = reactive({ open: false })
// 提醒音音量折叠：4 条滑块默认全「跟随全局」，多数人一次都不会拖，却常驻铺满卡片尾部。
// 默认收起成一行摘要（「全部跟随全局（x%）」/「低余额 60% · 其余跟随全局」），点标题才铺开滑块 ——
// 摘要在任何状态下都在播报当前音量口径，不会「藏了就等于没有」。纯展示态、不给父级
const volFold = reactive({ open: false })
// 摘要文案：全跟随 → 一行「全部跟随全局（x%）」；有独立项 → 「低余额 60% · 其余跟随全局（x%）」
const volSummary = computed(() => {
  const follow = '跟随全局（' + Math.round(alertVolShown(props.cfg.alertSoundRoles[0]) * 100) + '%）'
  const parts: string[] = []
  for (const r of props.cfg.alertSoundRoles as AlertRole[]) {
    const av = props.cfg.alertVols[r]
    if (av.volSet) parts.push(props.soundRoleLabel[r] + ' ' + Math.round(av.vol * 100) + '%')
  }
  if (!parts.length) return '全部' + follow
  return parts.join(' · ') + ' · 其余' + follow
})
// 计时分区折叠：开关 4 个 + 时长 + 文案 + 休息快捷键共 9 个控件，多数人只在初次设一次，
// 却把这卡的中段占满。默认收起：计时功能本身从挂件菜单进出，这里只是它的配置项，
// 折起来能让下方的「低余额 / 预算 / 波动」提醒开关上浮（这几项才是本卡的主入口）。
// 纯展示态、不给父级，故留组件内部
const timerFold = reactive({ open: false })
// 与上次回填的内容比对，用于「未保存」提示。基线由父级 applyConfig 后经 syncAlertsBaseline 写入
const alertsBaseline = ref<string | null>(null)
const alertsDirty = computed(() => alertsBaseline.value !== null && JSON.stringify(props.cfg.alerts) !== alertsBaseline.value)

// —— 邮件通知（SMTP） ——
// SMTP 凭据：与 cfg 分开，因为它在宿主侧进的是加密存储（不进备份）。
// mailPass 回填的是占位掩码而不是真实授权码 —— 只在用户没重新输入时保留原值，避免明文回显
const mail = reactive({
  mailHost: '',
  mailPort: 465,
  mailSecure: true,
  mailUser: '',
  mailPass: '',
})
// 已保存过授权码时为 true：用于把密码框的 placeholder 提示成「留空 = 不修改」
const mailPassSaved = ref(false)
const mailTesting = ref(false)
// SMTP 配置区的展开态。默认收起，点了按钮才展开（见 mailOpen）
const mailFold = reactive({ open: false })
// 配置是否已齐全：服务器 / 发件人 / 收件人。只看「有没有填过」这个持久事实，
// 不看本次测试成没成 —— 折叠态要能跨会话稳定重现，不依赖一次性的运行时结果。
// **刻意不要求账号与授权码**：账号留空是合法用法（多数服务器直接拿发件人地址当账号，
// 宿主 SmtpClient.send 也是 `if (user)` 才发 AUTH），授权码同理 —— 本机可匿名中继的
// 内网 SMTP 根本不需要。早先要求这两项非空，用户账号留空时永远判「未配置」，
// 于是每次重载都弹回整张空表格，看着就像「保存丢了」
const mailConfigured = computed(() => !!(
  mail.mailHost.trim() && props.cfg.mailFrom.trim() && props.cfg.mailTo.trim()
))
const mailOpen = computed(() => mailFold.open)
// 端口缺省值的**唯一**推导口径，与宿主 notify.js 的 resolvePort() 保持一致：
// 勾了 SSL/TLS 直连默认 465，否则 587。早先这里两处都写死 `|| 465`，
// 用户选了「587 + 取消勾选」却留空端口时会落成 465，与 mailSecure=false 直接矛盾，
// 连上后报 TLS 层原始错误（wrong version number），用户完全看不懂
function mailPortOf(): number {
  const n = Number(mail.mailPort)
  return isFinite(n) && n > 0 ? n : (mail.mailSecure ? 465 : 587)
}
// 通知渠道自测（「通知方式」小节的「测试通知」按钮）：与邮件测试分开两个消息态，
// 因为它同时覆盖系统通知渠道，消息文案也不同
const { flash: notifyFlash, show: notifyFlashShow, clear: notifyFlashClear, stop: notifyFlashStop } = useFlashShow(4000)
const notifyTesting = ref(false)
const { flash: mailFlash, show: mailFlashShow, clear: mailFlashClear, stop: mailFlashStop } = useFlashShow(4000)
// 从宿主读回 SMTP 凭据：授权码不返明文，只回「有没有存过」的标记，
// 所以密码框留空提交时后端会沿用旧值（见 saveMailSecrets）。
// 入参是「SMTP 凭据本体」（**两种来源形状必须一致**）：
//   - getSecrets() 返回整个 WhaleSecrets，SMTP 挂在 `notifyMail` 子对象下，要下沉一层
//   - saveMailSecrets() 直接返回该子对象（WhaleMailSecrets），不能下沉
// 早先这里写成 `s.mailHost` 取顶层、而 saveMailSecrets 又直接返回子对象，
// 两条路径形状对不上，回填恒为空 → 每次重启都判「未配置」
function applyMailSecrets(m: WhaleMailSecrets | undefined) {
  if (!m || typeof m !== 'object') return
  mail.mailHost = String(m.mailHost || '')
  mail.mailSecure = m.mailSecure !== false
  // 端口缺省也随 mailSecure 走：host 与 secure 都读回后再定端口默认值，
  // 不能写死 465 —— 未配过端口的 587 用户回填会被强行改成 465
  mail.mailPort = Number(m.mailPort) > 0 ? Number(m.mailPort) : (mail.mailSecure ? 465 : 587)
  mail.mailUser = String(m.mailUser || '')
  mailPassSaved.value = !!m.mailPass
  mail.mailPass = ''
}
// 「SMTP 配置（必填） / 重新配置 / 收起」按钮：纯手动开关，展开态不再被「配置齐没齐」左右
function toggleMailFold() {
  mailFold.open = !mailFold.open
}
function saveMailSettings() {
  mailFlashClear()
  try {
    // 非敏感字段（发件人 / 收件人 / 显示名 / 主题前缀）已改为输入即 emit('patch') 实时落盘，
    // 这里不再重复 emit —— 早先靠 @change（失焦）才落盘，用户敲完直接点「保存」时
    // change 可能尚未派发，看着「保存了却没生效」。只有服务器与凭据这一路需要显式写
    const saved = props.services.saveMailSecrets?.({
      mailHost: mail.mailHost.trim(),
      mailPort: mailPortOf(),
      mailSecure: mail.mailSecure,
      mailUser: mail.mailUser.trim(),
      mailPass: mail.mailPass,
    })
    applyMailSecrets(saved)
    mailFlashShow('已保存')
  } catch (err: any) {
    mailFlashShow('保存失败：' + String(err?.message || err), true)
  }
}
async function testNotify() {
  if (notifyTesting.value) return
  notifyTesting.value = true
  notifyFlashClear()
  try {
    const r = await props.services.testNotify?.()
    if (r && r.ok) {
      const sys = (r.on || []).includes('系统通知')
      notifyFlashShow(sys
        ? '已按当前渠道发出：' + (r.on || []).join(' + ') + '（系统通知应已弹出，邮件请查收含垃圾箱）'
        : '已发出：' + (r.on || []).join(' + ') + '，请查收（含垃圾箱）')
      // 邮件这条渠道也验证通过 → 与「发送测试邮件」同样收起配置区
      if ((r.on || []).includes('邮件')) mailFold.open = false
    } else {
      // 邮件渠道失败时展开配置区，否则错误提示会被折叠藏住
      if ((r && r.on || []).includes('邮件')) mailFold.open = true
      notifyFlashShow('发送失败：' + ((r && r.error) || '未知错误'), true)
    }
  } catch (err: any) {
    notifyFlashShow('发送失败：' + String(err?.message || err), true)
  } finally {
    notifyTesting.value = false
  }
}
async function testMail() {
  if (mailTesting.value) return
  mailTesting.value = true
  mailFlashClear()
  try {
    const r = await props.services.sendTestMail?.({
      mailHost: mail.mailHost.trim(),
      mailPort: mailPortOf(),
      mailSecure: mail.mailSecure,
      mailUser: mail.mailUser.trim(),
      mailPass: mail.mailPass,
      // 发件人 / 收件人在「当前表单」里（cfg），不在凭据区 —— 漏传就会被宿主判成空串，
      // 报「发件邮箱格式不正确」，用户看表单里明明填了
      mailFrom: props.cfg.mailFrom.trim(),
      mailTo: props.cfg.mailTo.trim(),
      mailFromName: props.cfg.mailFromName.trim(),
    })
    if (r && r.ok) {
      mailFlashShow('测试邮件已发出，请查收（含垃圾箱）')
      // 发信成功 = 这组参数确实能送达，此时自动收起配置区，卡片回到「一行摘要」的清爽态。
      // 之后仍可点「重新配置」再展开
      mailFold.open = false
    } else {
      // 失败时反而要展开，否则错误提示会跟着配置区一起藏在折叠里，用户只看到一片空白
      mailFold.open = true
      mailFlashShow('发送失败：' + ((r && r.error) || '未知错误'), true)
    }
  } catch (err: any) {
    mailFold.open = true
    mailFlashShow('发送失败：' + String(err?.message || err), true)
  } finally {
    mailTesting.value = false
  }
}

// 暴露给父级：
//   - syncAlertsBaseline：父级 applyConfig 回填 cfg.alerts 后落基线，供「未保存」比对；
//     同步 syncTimerHms 把 timerSec 的三段展示刷新（配置可能来自备份恢复 / 挂件菜单推送）
//   - loadMailSecrets：挂载时父级调一次读回 SMTP 凭据（凭据读失败是预期分支，静默）
function syncAlertsBaseline() {
  alertsBaseline.value = JSON.stringify(props.cfg.alerts)
  syncTimerHms()
}
function loadMailSecrets() {
  // 预期分支：读存储失败/宿主未就绪时保持空表单，用户重填即可
  try { applyMailSecrets(props.services.getSecrets?.()?.notifyMail) } catch (err) {}
}
// 本卡自己挂载时就读一次 SMTP 凭据，**不再依赖父级 onMounted 里调 loadMailSecrets()**：
// 本卡被 v-if="cardOn('usage','notify')" 控制、默认 Tab 是「外观」，父级 onMounted 跑时
// notifyViewRef 还是 null，那次调用是空转 —— 于是服务器/端口/账号全部回填不出来，
// 用户看到的就是「已保存配置没正确显示」。改成本卡自持后，无论从哪个 Tab 进入都能读回
onMounted(loadMailSecrets)
// 离开即清掉三条回执的定时器，避免组件销毁后回调写到已卸载的 reactive 上
onUnmounted(() => { alertFlashStop(); mailFlashStop(); notifyFlashStop() })
defineExpose({ syncAlertsBaseline, loadMailSecrets, syncTimerHms })

// timerSec 变化（备份恢复 / 挂件菜单推送）时刷新三段展示；本地 commitTimerHms 已自行 sync，
// 这里再 sync 一次是幂等的，不会造成光标跳动（只在值真的变化时触发）
watch(() => props.cfg.timerSec, syncTimerHms)
</script>

<template>
  <section class="card" data-search="notify">
    <h2>提醒与通知</h2>

    <label class="field row check">
      <span class="label">峰谷切换提醒 <em>（进入峰/谷时段时气泡提示，需开启思考气泡）</em></span>
      <input type="checkbox" :checked="cfg.peakRemindOn" @change="emit('patch', { peakRemindOn: ($event.target as HTMLInputElement).checked })" />
    </label>

    <!-- 计时相关项原先散在本卡中段、与「余额提醒」「通知渠道」混排，用户找不到「倒计时时长」在哪儿。
         加一个分区标题把它们圈起来（与下方「通知方式」同一套 .sub 视觉），不改控件归属。
         分区整块可折叠：9 个控件是「设一次就不动」的低频项，折起来让下方的提醒开关上浮 -->
    <h3 class="sub">计时</h3>
    <button class="link-btn utils-btn utils-secondary" type="button" @click="timerFold.open = !timerFold.open">
      {{ timerFold.open ? '收起计时设置' : '展开计时设置（通知 / 常驻 / 时长 / 到点提醒 / 休息）' }}
    </button>
    <template v-if="timerFold.open">

    <label class="field row check">
      <span class="label">计时到点通知 <em>（挂件菜单「计时」到点时弹系统通知）</em></span>
      <input type="checkbox" :checked="cfg.timerNotifyOn" @change="emit('patch', { timerNotifyOn: ($event.target as HTMLInputElement).checked })" />
    </label>

    <label class="field row check">
      <span class="label">记住计时状态 <em>（重载插件 / 重建挂件后继续计时）</em></span>
      <input type="checkbox" :checked="cfg.timerPersistOn" @change="emit('patch', { timerPersistOn: ($event.target as HTMLInputElement).checked })" />
    </label>

    <!-- 计时气泡口径：原先只在挂件菜单「计时 → 更多」里，那层嵌套折叠已去掉，挪到本页 -->
    <label class="field row check">
      <span class="label">计时气泡常驻 <em>（开启：计时中气泡一直显示；关闭：只在开始时短暂显示，点小鲸鱼可随时查看）</em></span>
      <input type="checkbox" :checked="cfg.timerBubblePin" @change="emit('patch', { timerBubblePin: ($event.target as HTMLInputElement).checked })" />
    </label>
    <label class="field row check">
      <span class="label">计时中只显示计时 <em>（开启：气泡只显示计时；关闭：气泡照常显示余额、今日用量等全部内容）</em></span>
      <input type="checkbox" :checked="cfg.timerBubbleOnly" @change="emit('patch', { timerBubbleOnly: ($event.target as HTMLInputElement).checked })" />
    </label>

    <!-- 计时时长：与挂件菜单「倒计时」三段输入同一份配置（cfg.timerSec 存秒），
         这里用三个数字框拆开展示，任一段改动都折算回秒提交 -->
    <div class="field row">
      <span class="label">倒计时时长 <em>（挂件菜单「计时」里也能改；0 时 0 分 0 秒按 25 分钟算）</em></span>
      <input class="num" type="number" min="0" max="23" step="1" v-model.number="timerHms.h" @change="commitTimerHms" />
      <span class="num-text">时</span>
      <input class="num" type="number" min="0" max="59" step="1" v-model.number="timerHms.m" @change="commitTimerHms" />
      <span class="num-text">分</span>
      <input class="num" type="number" min="0" max="59" step="1" v-model.number="timerHms.s" @change="commitTimerHms" />
      <span class="num-text">秒</span>
    </div>

    <label class="field row">
      <span class="label">到点提醒我 <em>（开始计时前写一句「结束后要做什么」，到点时显示在气泡与通知里）</em></span>
      <input type="text" :value="cfg.timerNote" :maxlength="timerNoteMax" placeholder="例如：起来喝水、活动一下"
             @change="emit('patch', { timerNote: ($event.target as HTMLInputElement).value })" />
    </label>

    <label class="field row check">
      <span class="label">到点后给「休息」快捷键 <em>（气泡旁的按钮点一下直接开始休息计时）</em></span>
      <input type="checkbox" v-model="timerBreakOn" />
    </label>
    <label v-if="timerBreakOn" class="field row">
      <span class="label">休息时长</span>
      <input class="num" type="number" min="1" max="120" step="1" v-model.number="timerBreakMinEdit" @change="commitTimerBreak" />
      <span class="num-text">分钟</span>
    </label>
    </template>

    <label class="field row check">
      <span class="label">低余额预警 <em>（余额低于阈值时数字变红，并弹一次提醒气泡 + 每天一次系统通知）</em></span>
      <input type="checkbox" :checked="cfg.lowAlertOn" @change="emit('patch', { lowAlertOn: ($event.target as HTMLInputElement).checked })" />
    </label>
    <label v-if="cfg.lowAlertOn" class="field row">
      <span class="label">预警阈值</span>
      <input class="num" type="number" min="0" step="1" :value="cfg.lowAlertAmount"
             @change="emit('patch', { lowAlertAmount: Number(($event.target as HTMLInputElement).value) })" />
      <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
    </label>

    <label class="field row check">
      <span class="label">今日预算提醒 <em>（今日用量超出预算时气泡提示，并每天弹一次系统通知）</em></span>
      <input type="checkbox" :checked="cfg.budgetOn" @change="onBudgetToggle(($event.target as HTMLInputElement).checked)" />
    </label>
    <label v-if="cfg.budgetOn" class="field row">
      <span class="label">每日预算</span>
      <input class="num" type="number" min="0" step="1" :value="cfg.budgetAmount"
             @change="emit('patch', { budgetAmount: Number(($event.target as HTMLInputElement).value) })" />
      <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
    </label>

    <label class="field row check">
      <span class="label">余额大幅波动通知 <em>（单次采样余额下降超过阈值时弹一次系统通知）</em></span>
      <input type="checkbox" :checked="cfg.dropAlertOn" @change="onDropToggle(($event.target as HTMLInputElement).checked)" />
    </label>
    <label v-if="cfg.dropAlertOn" class="field row">
      <span class="label">波动阈值</span>
      <input class="num" type="number" min="0" step="1" :value="cfg.dropAlertAmount"
             @change="emit('patch', { dropAlertAmount: Number(($event.target as HTMLInputElement).value) })" />
      <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
    </label>
    <p v-if="cfg.dropAlertOn" class="hint">
      每发生一次「余额一次少掉 ≥ 阈值」就通知一次（不受「每天一次」限制）。被防误判拦下的下降（赠送额到期、异常跳变）也会通知，并注明原因；
      跨天、换币种、换 API Key 时两边余额不可比，不会误报。免打扰时段内静默不发通知。
    </p>

    <!-- 通知渠道：上面这些提醒「用什么方式送达」。系统通知 = 桌面弹窗；邮件 = SMTP 直发。
         渠道是总开关，与具体哪几类提醒要开无关 —— 后者在上面各自的开关里 -->
    <h3 class="sub">通知方式</h3>

    <label class="field row check">
      <span class="label">系统通知 <em>（桌面弹窗；关闭后所有自动提醒与计时都不再弹窗）</em></span>
      <input type="checkbox" :checked="cfg.notifySystemOn" @change="emit('patch', { notifySystemOn: ($event.target as HTMLInputElement).checked })" />
    </label>

    <label class="field row check">
      <span class="label">邮件通知 <em>（把提醒发到邮箱；需先填下方 SMTP 配置）</em></span>
      <input type="checkbox" :checked="cfg.notifyMailOn" @change="emit('patch', { notifyMailOn: ($event.target as HTMLInputElement).checked })" />
    </label>

    <!-- 测试按钮：按当前开着的渠道各发一条，用来确认「开关 + 配置」确实能送达。
         系统通知渠道 = 宿主 notifySystem；邮件 = 宿主 sendMailAsync；都不做「每天一次」去重 -->
    <div class="btn-row">
      <button class="export-btn utils-btn utils-outline" type="button" :disabled="notifyTesting" @click="testNotify()">
        {{ notifyTesting ? '发送中…' : '测试通知' }}
      </button>
    </div>
    <p v-if="notifyFlash.msg" class="msg" :class="msgCls(notifyFlash)">{{ notifyFlash.msg }}</p>

    <!-- SMTP 配置：只在「邮件通知」开着时出现。**默认收起**（未配置时也只留一行「SMTP 配置（必填）」按钮），
         点开才铺开表格；配置齐全收起时显示一行「已配置」摘要 -->
    <div v-if="cfg.notifyMailOn" class="fold">
      <p v-if="mailConfigured && !mailOpen" class="mail-summary">
        <span class="ok-tag">已配置</span>
        {{ mail.mailHost }}:{{ mail.mailPort }} → {{ cfg.mailTo || '（未填收件人）' }}
        <button class="link-btn inline utils-btn utils-secondary" type="button" @click="toggleMailFold()">重新配置</button>
      </p>
      <button v-else class="link-btn utils-btn utils-secondary" type="button" @click="toggleMailFold()">
        {{ mailConfigured ? '收起 SMTP 配置' : 'SMTP 配置（必填）' }}
      </button>

      <div v-if="mailOpen" class="guide">
        <label class="field row">
          <span class="label">SMTP 服务器</span>
          <input v-model="mail.mailHost" type="text" placeholder="smtp.qq.com" autocomplete="off" />
        </label>
        <label class="field row">
          <span class="label">端口</span>
          <input class="num" type="number" min="1" max="65535" v-model.number="mail.mailPort" />
        </label>
        <label class="field row check">
          <span class="label">SSL/TLS 直连 <em>（465 端口勾上；587 / 25 取消勾选，连上后自动 STARTTLS 升级）</em></span>
          <input type="checkbox" v-model="mail.mailSecure" />
        </label>

        <label class="field row">
          <span class="label">账号</span>
          <input v-model="mail.mailUser" type="text" placeholder="you@qq.com" autocomplete="off" />
        </label>
        <label class="field row">
          <span class="label">授权码</span>
          <input v-model="mail.mailPass" type="password" :placeholder="mailPassSaved ? '已保存，留空则不修改' : '邮箱授权码（非登录密码）'" autocomplete="off" />
        </label>
        <p class="hint">
          授权码存于 uTools 加密存储，<b>不进备份文件</b>；填过一次后留空即表示沿用已保存的值。
          多数邮箱（QQ / 163 / Gmail）需要在邮箱设置里单独开启 SMTP 并生成授权码，不能直接填登录密码。
        </p>

        <label class="field row">
          <span class="label">发件人</span>
          <input :value="cfg.mailFrom" type="text" placeholder="与上方账号一致" autocomplete="off"
                 @input="emit('patch', { mailFrom: ($event.target as HTMLInputElement).value })" />
        </label>
        <label class="field row">
          <span class="label">收件人</span>
          <input :value="cfg.mailTo" type="text" placeholder="收提醒的邮箱（可与发件人相同）" autocomplete="off"
                 @input="emit('patch', { mailTo: ($event.target as HTMLInputElement).value })" />
        </label>
        <label class="field row">
          <span class="label">发件人显示名</span>
          <input :value="cfg.mailFromName" type="text" placeholder="小鲸鱼余额挂件" autocomplete="off"
                 @input="emit('patch', { mailFromName: ($event.target as HTMLInputElement).value })" />
        </label>
        <label class="field row">
          <span class="label">主题前缀</span>
          <input :value="cfg.mailSubjectPrefix" type="text" placeholder="[小鲸鱼余额挂件]" autocomplete="off"
                 @input="emit('patch', { mailSubjectPrefix: ($event.target as HTMLInputElement).value })" />
        </label>

        <label class="field row check">
          <span class="label">计时到点也发邮件 <em>（除系统通知外，到点另发一封邮件；关掉则只有系统通知）</em></span>
          <input type="checkbox" :checked="cfg.timerMailOn" @change="emit('patch', { timerMailOn: ($event.target as HTMLInputElement).checked })" />
        </label>

        <div class="btn-row">
          <button class="export-btn utils-btn utils-outline" type="button" @click="saveMailSettings()">保存邮件设置</button>
          <button class="export-btn utils-btn utils-outline" type="button" :disabled="mailTesting" @click="testMail()">
            {{ mailTesting ? '发送中…' : '发送测试邮件' }}
          </button>
        </div>
        <p v-if="mailFlash.msg" class="msg" :class="msgCls(mailFlash)">{{ mailFlash.msg }}</p>
        <p class="hint">
          测试邮件用的是上方「当前填的内容」（未保存也会用），方便先验证再保存；<b>发送成功会自动收起本区</b>。
          上方「测试通知」读的是已保存的配置，两者分工不同；SMTP 服务器与授权码需点「保存邮件设置」落盘。
          免打扰时段内邮件与系统通知一并静默（计时到点不受免打扰影响）。
        </p>
      </div>
    </div>

    <!-- 低频的「提醒表现 + 时段 + 文案」收在一处折叠，卡片默认只留「哪几类提醒要开」 -->
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" @click="alertFolds.open = !alertFolds.open">
        {{ alertFolds.open ? '收起更多提醒设置' : '更多提醒设置（停留时长 / 免打扰 / 文案）' }}
      </button>
      <div v-if="alertFolds.open" class="guide">
        <label class="field row">
          <span class="label">提醒停留时长</span>
          <select :value="cfg.remindSec" @change="emit('patch', { remindSec: Number(($event.target as HTMLSelectElement).value) })">
            <option :value="0">常驻（手动点掉）</option>
            <option :value="5">5 秒</option>
            <option :value="8">8 秒</option>
            <option :value="15">15 秒</option>
          </select>
        </label>
        <p class="hint">峰谷切换 / 今日预算 / 低余额 / 穿透说明这几类提醒气泡的停留时间（随机台词不受影响）。</p>

        <label class="field row check">
          <span class="label">免打扰时段 <em>（时段内只弹气泡，不弹自动提醒的系统通知；跨午夜如 23:00–07:00 也支持）</em></span>
          <input type="checkbox" :checked="cfg.quietOn" @change="emit('patch', { quietOn: ($event.target as HTMLInputElement).checked })" />
        </label>
        <label v-if="cfg.quietOn" class="field row">
          <span class="label">免打扰起止</span>
          <input class="time" type="time" :value="cfg.quietFrom" @change="emit('patch', { quietFrom: ($event.target as HTMLInputElement).value })" />
          <em class="time-sep">至</em>
          <input class="time" type="time" :value="cfg.quietTo" @change="emit('patch', { quietTo: ($event.target as HTMLInputElement).value })" />
        </label>
        <p v-if="cfg.quietOn" class="hint">
          免打扰静默「今日预算」「低余额」「余额大幅波动」三类自动通知（邮件一并静默）：前两类不占用当天名额（出时段后仍会补发一次），
          波动通知本身就是一次性的、不补发。计时到点是你主动设定的一次性提醒，照常通知。
        </p>

        <!-- 提醒文案：四类自动提醒（低余额 / 预算 / 峰谷 / 穿透）的气泡与系统通知文案 -->
        <label v-for="f in ALERT_FIELDS" :key="f.key" class="field">
          <span class="label">{{ f.label }}</span>
          <textarea class="quote-input" rows="3" spellcheck="false"
                    :value="cfg.alerts[f.key]" :placeholder="f.hint" @change="onAlertEdit(f.key, $event)"></textarea>
        </label>

        <p class="hint">
          低余额 / 今日预算 / 峰谷切换 / 鼠标穿透这几类自动提醒的<b>气泡与系统通知共用这里的文案</b>。
          <b>最多三行</b>，依次对应气泡的「标题 / 大字 / 说明」；行数不够则后面的行留空，多于三行的并进说明行。
          系统通知取全文（换行合并成一行）。空行会被丢掉，清空某一条 = 该条恢复内置默认。
          占位符按各输入框里的提示填写，写错的会原样显示出来。改完点「保存」才生效，挂件已开着的话立即生效。
        </p>
        <p class="hint">
          注意：低余额文案用于内置 DeepSeek 的预警；多厂商模型的余额通知带模型名，不受这里影响。
        </p>
        <p v-if="alertResetConfirm" class="hint">
          将丢弃全部自定义提醒文案，恢复为内置默认，此操作不可撤销。
        </p>
        <div class="btn-row">
          <span v-if="alertsDirty" class="dirty-tag">未保存</span>
          <button class="export-btn utils-btn utils-outline" type="button" @click="saveAlerts()">保存</button>
          <button class="export-btn utils-btn" :class="alertResetConfirm ? 'utils-danger' : 'utils-outline'" type="button" @click="resetAlerts()">
            {{ alertResetConfirm ? '确认恢复默认？' : '恢复默认' }}
          </button>
          <button v-if="alertResetConfirm" class="export-btn utils-btn utils-outline" type="button" @click="alertResetConfirm = false">取消</button>
        </div>
        <p v-if="alertFlash.msg" class="msg" :class="msgCls(alertFlash)">{{ alertFlash.msg }}</p>
      </div>
    </div>

    <!-- 提醒音独立音量：语义上属于「提醒」，放这页比折叠在「外观」的音效条里更好找（音效开关/音色/全局音量
         仍在「外观」的音效折叠条里）。默认收起成一行摘要；点标题行展开成滑块，
         摘要行始终播报当前音量口径，不会藏了等于没有 -->
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" @click="volFold.open = !volFold.open">
        {{ volFold.open ? '收起提醒音音量' : '提醒音音量' }}
      </button>
      <p class="hint vol-sum">{{ volSummary }}</p>
      <div v-if="volFold.open" class="guide">
        <div v-for="r in alertSoundRoles" :key="'av-' + r" class="field row">
          <span class="label">{{ soundRoleLabel[r] }}</span>
          <input class="range" type="range" min="0" max="1" step="0.05"
                 :value="alertVolShown(r)" :disabled="!cfg.soundOn"
                 @input="onAlertVolInput(r, $event)" />
          <span class="num-text">{{ alertVolSummary(r) }}</span>
          <button v-if="cfg.alertVols[r].volSet" class="link-btn utils-btn utils-secondary"
                  type="button" :disabled="!cfg.soundOn" @click="resetAlertVol(r)">恢复跟随</button>
        </div>
        <p class="hint">
          默认跟随「外观」页的全局音量；单独拖动某一类后即独立生效（不再跟随），
          点「恢复跟随」回到随全局音量变化。提醒音的导入与静音（留空）在「资源」页。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 设计令牌来自 main.css 的 :root。通用控件样式已由 main.css 统一提供（全局唯一来源），
   本组件只留自身特有的控件样式。utils 档位配色、.link-btn、.btn-row 基类也已在 main.css，
   此处不再留副本。 */

/* 「通知方式」小标题：与卡片流里的分组标题同源（app.css 的 .sub） */
.sub {
  margin: 0 0 18px;
  color: var(--fg-dim);
  font-size: 13px;
}
.export-btn {
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}

/* 输入框 / 下拉 / 数值框 / 复选框的表单控件基类已上提 main.css（全局唯一来源），
   此处不再留副本；仅保留本卡专用的 .time。 */

/* 免打扰起止时刻（HH:MM） */
.time {
  width: 96px;
  padding: 5px 6px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
}
.time-sep {
  font-style: normal;
  font-size: 12px;
  color: var(--fg-faint);
}
.range {
  flex: 1;
  accent-color: var(--accent);
}

/* 「未保存」标记：改完 textarea 不点保存就切 Tab / 关窗口会丢改动，给个常驻提示 */
.dirty-tag {
  align-self: center;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.5;
  border-radius: 999px;
  background: var(--err-weak);
  color: var(--err);
  white-space: nowrap;
}
/* 提醒文案 textarea（app.css 的 .quote-input） */
.quote-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 2px;
  padding: 7px 9px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  resize: vertical;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg);
}
/* 折叠组 / 说明面板 / SMTP 摘要（app.css 的 .fold / .mail-summary / .ok-tag）；
   .guide 已上提 main.css（全局唯一来源）。 */

.mail-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-dim);
}
/* 提醒音音量摘要行：与 .mail-summary 同款（一行摘要 + 内联切换按钮），收起态就靠它播报当前口径 */
.vol-sum {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
}
.link-btn.inline {
  margin-top: 0;
  font-size: 12px;
}
.ok-tag {
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--ok);
  color: var(--ok);
  font-size: 11px;
  line-height: 1.5;
}
</style>
