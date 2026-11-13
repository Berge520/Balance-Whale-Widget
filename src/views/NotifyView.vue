<script lang="ts" setup>
import { computed, onUnmounted, ref } from 'vue'
import MailSettings from '../components/MailSettings.vue'
import { msgCls, useFlashShow } from '../composables/useFlash'
import { useFold } from '../composables/useFold'
import type { AlertRole, SoundRole, WhaleServices } from '../types/services'

// 「提醒与通知」整卡，分区顺序：通知方式（系统 / 邮件 + SMTP 配置 + 测试）→
// 计时到点（留言 / 通知 / 气泡停留 / 邮件，折叠）→ 自动提醒（峰谷切换 / 低余额 / 今日预算 / 余额大幅波动）
// → 更多提醒设置（停留时长 / 免打扰 / 文案，折叠）→ 提醒音独立音量（折叠）。
// 渠道与到点提示是配一次就不动的前置，四类自动提醒才是日常反复调的，故把前者前置。
// 计时**怎么设一轮**（默认时长 / 快捷档位 / 休息与番茄 / 气泡）仍在「计时」卡（TimerView.vue）；
// 但「到点怎么提示」（留言 / 系统通知 / 气泡停留 / 邮件）归本卡 —— 那是一类提醒，不是计时参数。
// 从设置页 App.vue 抽出。以下项仍留在父级，按 props 下传或 emit 触发，不能跟着搬：
//   - applyConfig / patchCfg：applyConfig 是父级 onConfigChange 订阅与备份恢复共用的回填入口，
//     本卡保存提醒文案后要「整份回填 + 落盘」，只能 emit 请求父级做（applyConfig 搬不动）。
//   - usageCurrency：额度/预算/波动三处阈值单位靠它（跨卡共享，notify 卡与 usage 卡共用），留父级。
//   - ALERT_SOUND_ROLES / SOUND_ROLE_LABEL：提醒音槽位与标签。
//     SOUND_ROLE_LABEL 还被 settings 里其它卡（音效导入、共享音效选用）引用，跨卡共享，留父级。
//   - soundsMeta / soundFlash 等音效资源状态：音效导入导出在「外观」页，跨卡共享。
//   - cfg.alerts 的基线比对（alertsBaseline）随本卡搬入 —— 它只服务本卡的「未保存」提示。
// 随卡搬入的：四类提醒的开关与阈值联动、通知渠道与 SMTP 配置、
// 提醒音独立音量的三态计算、提醒文案的编辑 / 保存 / 恢复默认与折叠态。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写提醒 / 邮件相关字段，落盘统一走 emit('patch')
  cfg: any
  services: Partial<WhaleServices>
  // 记账币种（'CNY' / 'USD'）：预算 / 阈值输入框的单位靠它
  usageCurrency: string
  // 提醒音槽位与标签（父级 ALERT_SOUND_ROLES / SOUND_ROLE_LABEL），跨卡共享故以 props 下传
  alertSoundRoles: AlertRole[]
  soundRoleLabel: Record<SoundRole, string>
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
  // 保存 / 恢复默认提醒文案：需要父级 applyConfig(services.getConfig()) 整份回填后落盘
  (e: 'save-alerts', alerts: Record<string, string> | null): void
}>()

// 计时到点留言长度上限：宿主 constants.js TIMER_NOTE_MAX 的同值副本（check-shared 校验三处一致）。
// 「到点提醒」控件搬进本卡后 maxLength 在这边，父级 App.vue 不再下传
const TIMER_NOTE_MAX = 60

// 统一的消息态（Flash）：定义收口在 composables/useFlash.ts，各卡不再各持一份。

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

// 卡级折叠：本卡正文很长（四类自动提醒开关 + 通知渠道 / SMTP + 提醒文案 + 提醒音音量），
// 日常只在「改提醒设置」时才逐段展开；与隐私 / 备份 / 关于三卡统一为「默认收起、可展开」，
// 收起后只留标题与一行摘要，让「用量」组的其它卡上浮
// 使用 useFold 持久化折叠状态到 localStorage，避免用户每次打开都要重新展开
const cardFold = useFold('notify', false)
// 计时到点**实际生效**的渠道：分渠道开关还要与「通知方式」里的总开关取与
// （宿主 notify.js 的 notifyTimer 就是这么判的）。只播报配置值会骗人 ——
// 邮件总开关默认关着，默认配置下播报「通知 + 邮件」，那封邮件永远发不出去。
const timerCh = computed(() => ({
  sys: props.cfg.timerNotifyOn === true && props.cfg.notifySystemOn !== false,
  mail: props.cfg.timerMailOn === true && props.cfg.notifyMailOn === true,
}))
// 收起态摘要：播报四类自动提醒各开了几个，收起也能看出「现在会收到哪些提醒」；
// 计时到点（留言 / 系统通知 / 邮件）也归本卡，一并计入 —— 否则收起后看不出「计时会不会提醒」
const cardSummary = computed(() => {
  const auto = [props.cfg.peakRemindOn, props.cfg.lowAlertOn, props.cfg.budgetOn, props.cfg.dropAlertOn].filter(Boolean).length
  const { sys, mail } = timerCh.value
  const parts: string[] = []
  parts.push(auto ? `已开启 ${auto}/4 类自动提醒` : '四类自动提醒均未开启')
  if (sys || mail) parts.push('计时到点：' + (sys && mail ? '通知 + 邮件' : sys ? '系统通知' : '邮件'))
  // 两个分渠道开关都开着、但总开关把它们全关掉：明说「只剩气泡」，别让人以为还有提醒
  else if (props.cfg.timerNotifyOn || props.cfg.timerMailOn) parts.push('计时到点：仅气泡')
  return parts.join(' · ')
})
// 计时到点折叠：四项（留言 / 通知 / 气泡停留 / 邮件）配一次就不动，默认收起，与「更多提醒设置」「提醒音音量」同一套
const timerFold = useFold('timerNote', false)
// 收起态摘要：把「到点什么、走哪些渠道」说出来，收起也不等于没信息
const timerBrief = computed(() => {
  const note = String(props.cfg.timerNote || '').trim()
  const { sys, mail } = timerCh.value
  const ch: string[] = []
  if (sys) ch.push('通知')
  if (mail) ch.push('邮件')
  const stay = props.cfg.timerRemindSec > 0 ? `${props.cfg.timerRemindSec} 秒` : '常驻'
  return `${note ? '「' + note + '」' : '未设留言'} · ${ch.length ? ch.join(' + ') : '仅气泡'} · 停留 ${stay}`
})
// 提醒文案折叠：与上面的开关同属「提醒」主题，收在「提醒与通知」卡里，不再单独占「外观」页一张卡
const alertFolds = useFold('alert', false)
// 提醒音音量折叠：4 条滑块默认全「跟随全局」，多数人一次都不会拖，却常驻铺满卡片尾部。
// 默认收起成一行摘要（「全部跟随全局（x%）」/「低余额 60% · 其余跟随全局」），点标题才铺开滑块 ——
// 摘要在任何状态下都在播报当前音量口径，不会「藏了就等于没有」。纯展示态、不给父级
const volFold = useFold('vol', false)
// 摘要文案：全跟随 → 一行「全部跟随全局（x%）」；有独立项 → 「低余额 60% · 其余跟随全局（x%）」
const volSummary = computed(() => {
  const follow = '跟随全局（' + Math.round(alertVolShown(props.alertSoundRoles[0]) * 100) + '%）'
  const parts: string[] = []
  for (const r of props.alertSoundRoles as AlertRole[]) {
    const av = props.cfg.alertVols[r]
    if (av.volSet) parts.push(props.soundRoleLabel[r] + ' ' + Math.round(av.vol * 100) + '%')
  }
  if (!parts.length) return '全部' + follow
  return parts.join(' · ') + ' · 其余' + follow
})
// 与上次回填的内容比对，用于「未保存」提示。基线由父级 applyConfig 后经 syncAlertsBaseline 写入
const alertsBaseline = ref<string | null>(null)
const alertsDirty = computed(() => alertsBaseline.value !== null && JSON.stringify(props.cfg.alerts) !== alertsBaseline.value)

// —— 邮件通知（SMTP） ——
// 表单状态、凭据回填、保存与测试邮件全部在子块 components/MailSettings.vue 里自持；
// 本卡只留一个 ref 用来在「测试通知」带邮件渠道成功后收起它的配置区
// 通知渠道自测（「通知方式」小节的「测试通知」按钮）：同时覆盖系统通知与邮件两条渠道，
// 回执文案与「发送测试邮件」不同，故单独一个消息态
const { flash: notifyFlash, show: notifyFlashShow, clear: notifyFlashClear, stop: notifyFlashStop } = useFlashShow(4000)
const notifyTesting = ref(false)
// SMTP 配置子块：只为了「测试通知带上邮件并成功时收起它的配置区」，不碰它内部的表单状态
const mailSettingsRef = ref<{ collapse: () => void; stop: () => void } | null>(null)

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
      if ((r.on || []).includes('邮件')) mailSettingsRef.value?.collapse()
    } else {
      notifyFlashShow('发送失败：' + ((r && r.error) || '未知错误'), true)
    }
  } catch (err: any) {
    notifyFlashShow('发送失败：' + String(err?.message || err), true)
  } finally {
    notifyTesting.value = false
  }
}

// 暴露给父级：syncAlertsBaseline —— 父级 applyConfig 回填 cfg.alerts 后落基线，供「未保存」比对。
// SMTP 凭据的读回已随子块（MailSettings.vue）下沉，父级不再需要 loadMailSecrets
function syncAlertsBaseline() {
  alertsBaseline.value = JSON.stringify(props.cfg.alerts)
}
// 离开即清掉本卡两条回执的定时器（子块自己的定时器由它 stop），避免组件销毁后回调写到已卸载的 reactive 上
onUnmounted(() => { alertFlashStop(); notifyFlashStop(); mailSettingsRef.value?.stop() })
defineExpose({ syncAlertsBaseline })
</script>

<template>
  <section class="card" data-search="notify">
    <div class="card-head">
      <h2 class="card-toggle" @click="cardFold.open = !cardFold.open">
        <span class="caret">{{ cardFold.open ? '▾' : '▸' }}</span>提醒与通知
        <span v-if="!cardFold.open" class="card-sum">{{ cardSummary }}</span>
      </h2>
    </div>
    <div v-if="cardFold.open">

    <!-- 顺序按「先把渠道配好 → 再定到点说什么 → 最后挑哪几类要提醒」：
         渠道是一次性配置，自动提醒才是日常反复调的。早先四类开关直接铺在卡头、渠道夹在中间，
         读起来断成两段（v1.16 重排） -->
    <h3 class="card-sub">通知方式</h3>
    <label class="field row check">
      <span class="label">系统通知 <em>（桌面弹窗；关闭后自动提醒与计时都不弹窗）</em></span>
      <input type="checkbox" :checked="cfg.notifySystemOn" @change="emit('patch', { notifySystemOn: ($event.target as HTMLInputElement).checked })" />
    </label>

    <label class="field row check">
      <span class="label">邮件通知 <em>（提醒发到邮箱；需先填下方 SMTP 配置）</em></span>
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

    <!-- SMTP 配置这一块抽成了 components/MailSettings.vue（模板与状态自持，含「已配置」摘要与测试邮件）。
         显隐仍由本卡判断：邮件通知关着时整块不渲染，配置区无从进入 -->
    <MailSettings v-if="cfg.notifyMailOn" ref="mailSettingsRef" :cfg="cfg" :services="services" @patch="(p) => emit('patch', p)" />

    <!-- 计时到点：原先在「计时」卡里，和邮件渠道隔着一张卡；搬到此处与系统通知 / 邮件并排，
         渠道与「到点说什么」一起设。四项低频配置收进折叠（同下面的「更多提醒设置」范式），
         收起时仍播报摘要，不会「藏了等于没有」。留言长度上限走文件内常量（父级已不再下传） -->
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary fold-toggle" type="button" :aria-expanded="timerFold.open" @click="timerFold.open = !timerFold.open">
        {{ timerFold.open ? '收起计时到点' : '计时到点' }}
      </button>
      <p v-if="!timerFold.open" class="hint vol-sum">{{ timerBrief }}</p>
      <div v-if="timerFold.open" class="guide">
        <label class="field row">
          <span class="label">到点提醒我 <em>（到点显示在气泡与通知）</em></span>
          <input type="text" :value="cfg.timerNote" :maxlength="TIMER_NOTE_MAX" placeholder="例如：起来喝水、活动一下"
                 @change="emit('patch', { timerNote: ($event.target as HTMLInputElement).value })" />
        </label>

        <label class="field row check">
          <span class="label">计时到点系统通知 <em>（关掉后不弹系统通知；邮件另由下面的开关控制）</em></span>
          <input type="checkbox" :checked="cfg.timerNotifyOn" @change="emit('patch', { timerNotifyOn: ($event.target as HTMLInputElement).checked })" />
        </label>

        <label class="field row">
          <span class="label">到点气泡停留 <em>（常驻＝手动点掉；自动提醒的停留时长见「更多提醒设置」）</em></span>
          <select :value="cfg.timerRemindSec" @change="emit('patch', { timerRemindSec: Number(($event.target as HTMLSelectElement).value) })">
            <option :value="5">5 秒</option>
            <option :value="8">8 秒</option>
            <option :value="15">15 秒</option>
            <option :value="0">常驻</option>
          </select>
        </label>

        <label class="field row check">
          <span class="label">计时到点也发邮件 <em>（需先开启「邮件通知」并填好 SMTP）</em><b v-if="cfg.timerMailOn === true && cfg.notifyMailOn !== true" class="warn-note">邮件通知总开关没开，这个勾选暂不生效</b></span>
          <input type="checkbox" :checked="cfg.timerMailOn" @change="emit('patch', { timerMailOn: ($event.target as HTMLInputElement).checked })" />
        </label>
      </div>
    </div>

    <!-- 自动提醒：四类「什么时候该提醒我」的开关与阈值。放最后是因为它是日常反复调的一块，
         而渠道与到点提示是配一次就不动的前置 —— 先配渠道、再定内容、最后挑类别 -->
    <h3 class="card-sub">自动提醒</h3>

    <label class="field row check">
      <span class="label">峰谷切换提醒 <em>（进入峰/谷时段时气泡提示，需开启思考气泡）</em></span>
      <input type="checkbox" :checked="cfg.peakRemindOn" @change="emit('patch', { peakRemindOn: ($event.target as HTMLInputElement).checked })" />
    </label>

    <label class="field row check">
      <span class="label">低余额预警 <em>（低于阈值数字变红，弹一次气泡 + 每天一次系统通知）</em></span>
      <input type="checkbox" :checked="cfg.lowAlertOn" @change="emit('patch', { lowAlertOn: ($event.target as HTMLInputElement).checked })" />
    </label>
    <label v-if="cfg.lowAlertOn" class="field row">
      <span class="label">预警阈值</span>
      <input class="num" type="number" min="0" step="1" :value="cfg.lowAlertAmount"
             @change="emit('patch', { lowAlertAmount: Number(($event.target as HTMLInputElement).value) })" />
      <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
    </label>

    <label class="field row check">
      <span class="label">今日预算提醒 <em>（用量超预算时气泡提示 + 每天一次系统通知）</em></span>
      <input type="checkbox" :checked="cfg.budgetOn" @change="onBudgetToggle(($event.target as HTMLInputElement).checked)" />
    </label>
    <label v-if="cfg.budgetOn" class="field row">
      <span class="label">每日预算</span>
      <input class="num" type="number" min="0" step="1" :value="cfg.budgetAmount"
             @change="emit('patch', { budgetAmount: Number(($event.target as HTMLInputElement).value) })" />
      <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
    </label>

    <label class="field row check">
      <span class="label">余额大幅波动通知 <em>（单次采样余额降幅超阈值时弹一次系统通知）</em></span>
      <input type="checkbox" :checked="cfg.dropAlertOn" @change="onDropToggle(($event.target as HTMLInputElement).checked)" />
    </label>
    <label v-if="cfg.dropAlertOn" class="field row">
      <span class="label">波动阈值</span>
      <input class="num" type="number" min="0" step="1" :value="cfg.dropAlertAmount"
             @change="emit('patch', { dropAlertAmount: Number(($event.target as HTMLInputElement).value) })" />
      <span class="num-text">{{ usageCurrency === 'CNY' ? '元' : '美元' }}</span>
    </label>
    <p v-if="cfg.dropAlertOn" class="hint">
      每少 ≥ 阈值通知一次（不受「每天一次」限制）；被拦下的下降（赠送额到期、异常跳变）也会通知并注明原因；换币种或 API Key 不误报。
    </p>

    <!-- 低频的「提醒表现 + 时段 + 文案」收在一处折叠，卡片默认只留「哪几类提醒要开」 -->
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="alertFolds.open" @click="alertFolds.open = !alertFolds.open">
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
        <p class="hint">峰谷 / 预算 / 低余额 / 穿透提醒气泡的停留时长（随机台词与计时到点不受影响，后者见「计时到点」）。</p>

        <label class="field row check">
          <span class="label">免打扰时段 <em>（只静音系统通知与邮件，气泡照常；支持跨午夜如 23:00–07:00）</em></span>
          <input type="checkbox" :checked="cfg.quietOn" @change="emit('patch', { quietOn: ($event.target as HTMLInputElement).checked })" />
        </label>
        <label v-if="cfg.quietOn" class="field row">
          <span class="label">免打扰起止</span>
          <input class="time" type="time" :value="cfg.quietFrom" @change="emit('patch', { quietFrom: ($event.target as HTMLInputElement).value })" />
          <em class="time-sep">至</em>
          <input class="time" type="time" :value="cfg.quietTo" @change="emit('patch', { quietTo: ($event.target as HTMLInputElement).value })" />
        </label>
        <p v-if="cfg.quietOn" class="hint">
          免打扰只压系统通知与邮件，气泡照常：「今日预算」「低余额」不占当天名额、出时段补发；大幅波动一次性不补发；待办到点只弹气泡即算完成。
        </p>

        <!-- 提醒文案：四类自动提醒（低余额 / 预算 / 峰谷 / 穿透）的气泡与系统通知文案 -->
        <label v-for="f in ALERT_FIELDS" :key="f.key" class="field">
          <span class="label">{{ f.label }}</span>
          <textarea class="quote-input" rows="3" spellcheck="false"
                    :value="cfg.alerts[f.key]" :placeholder="f.hint" @change="onAlertEdit(f.key, $event)"></textarea>
        </label>

        <p class="hint">
          四类提醒的<b>气泡与通知共用此文案</b>，<b>最多三行</b>（标题 / 大字 / 说明，超出并入说明行），通知取全文；
          空行丢弃、清空即恢复默认；占位符见输入框提示，写错原样显示；点「保存」生效。
        </p>
        <p class="hint">
          低余额文案仅用于内置 DeepSeek 预警；多厂商模型的余额通知带模型名，不受影响。
        </p>
        <p v-if="alertResetConfirm" class="hint">
          将丢弃全部自定义文案并恢复内置默认，不可撤销。
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
      <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="volFold.open" @click="volFold.open = !volFold.open">
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
          默认跟随「外观」页的全局音量；拖动某一类后即独立生效，点「恢复跟随」回到跟随。
          提醒音的导入与更换（留空用内置音）见「资源」页。
        </p>
      </div>
    </div>

    </div>
  </section>
</template>

<style scoped>
/* 设计令牌来自 main.css 的 :root。通用控件样式已由 main.css 统一提供（全局唯一来源），
   本组件只留自身特有的控件样式。utils 档位配色、.link-btn、.btn-row 基类、分区标题 .card-sub
   也已在 main.css，此处不再留副本。 */

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
/* 「勾了也不生效」的常显提醒：只加提示不改值 —— 总开关临时关掉时不该顺手清掉用户的勾选 */
.warn-note {
  margin-left: 6px;
  font-weight: 600;
  color: var(--warn);
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
/* 折叠组 / 说明面板（app.css 的 .fold）；.guide 已上提 main.css（全局唯一来源）。
   .mail-summary / .ok-tag / .link-btn.inline / .export-btn 随 SMTP 配置区一起移到了
   components/MailSettings.vue，本卡不再留副本。 */

/* 提醒音音量摘要行：一行摘要 + 内联切换按钮，收起态就靠它播报当前口径 */
.vol-sum {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
}
</style>
