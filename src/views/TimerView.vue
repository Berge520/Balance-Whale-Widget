<script lang="ts" setup>
import { computed, reactive, ref, watch } from 'vue'

// 「计时」整卡：只管「一轮怎么设」（默认时长 / 快捷档位 / 休息与番茄 / 气泡与状态）。
// 「到点怎么提示」（留言 / 系统通知 / 气泡停留 / 邮件）归「提醒与通知」卡 —— 那是一类提醒，
// 不是计时参数，本卡只留一句指向。
// 从「提醒与通知」卡里拆出来：那边四类自动提醒与通知渠道已经够长，计时 9 个控件夹在中间，
// 用户搜到「倒计时」滚过去也只看到一张默认收起的卡。拆成独立卡后搜索直达、入口随挂件菜单的
// 「计时设置」深链（target='timer'）直接落在这里。
//
// 语义：这里设的是**默认值**。挂件菜单里的 H/M/S、快捷档位、待办开始、再来一轮都只是
// 「这一轮」的临时参数，不写回这里（早前 startTimer 会把每轮的时长回写成默认值，
// 用户点了一次 5 分钟档位，下次开挂件默认时长就变成 5 分钟了）。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写计时相关字段，落盘统一走 emit('patch')
  cfg: any
  // 快捷档位默认值（父级 TIMER_PRESETS_DEFAULT）：配置缺键时兜底渲染
  timerPresetsDefault: number[]
  // 搜索命中态：低频分区在搜索时强制展开，否则「搜到了番茄却看不到控件」
  searchActive: boolean
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
}>()

// 指向性文案：v1.16 起专注卡不再有统计 / 记录层，这里只说计时怎么记
const focusRulesHint = computed(() => {
  const hidden = (props.cfg.hiddenCards || []).includes('focus')
    || (props.cfg.hiddenTabs || []).includes('usage')
  return hidden
    ? '挂件菜单里开不开「专注」组，在「待办与计时」卡（已在显示管理中隐藏）'
    : '挂件菜单里开不开「专注」组，见上面的「待办与计时」卡'
})

// —— 低频分区折叠：休息与番茄 / 计时气泡与状态默认收起 ——
// 收起不等于藏起来：标题尾注给一行状态摘要；搜索命中时强制展开（同 AssetsView 的 galleryOpen 口径）
type FoldKey = 'rest' | 'bubble'
const folds = ref<Record<FoldKey, boolean>>({ rest: false, bubble: false })
const searchFoldClosed = ref<Record<FoldKey, boolean>>({ rest: false, bubble: false })
function foldOpen(key: FoldKey) {
  return props.searchActive ? !searchFoldClosed.value[key] : folds.value[key]
}
function toggleFold(key: FoldKey) {
  if (props.searchActive) { searchFoldClosed.value[key] = !searchFoldClosed.value[key]; return }
  folds.value[key] = !folds.value[key]
}
watch(() => props.searchActive, (on) => {
  if (on) searchFoldClosed.value = { rest: false, bubble: false }
})
const restBrief = computed(() => {
  const c = props.cfg
  const rest = c.timerBreakMin > 0 ? `休息 ${c.timerBreakMin} 分` : '休息关'
  const pomo = c.timerPomoOn
    ? `番茄循环 · 长休 ${c.timerLongBreakMin} 分 / 每 ${c.timerLongEvery} 轮`
    : '番茄循环关'
  // 自动衔接独立于番茄循环，收起标题里也要能看出它开着，别让人以为折叠区里没有这项
  const next = c.todoAutoNext ? '待办自动衔接' : ''
  return [rest, pomo, next].filter(Boolean).join(' · ')
})
const bubbleBrief = computed(() => {
  const c = props.cfg
  return [
    c.timerBubblePin ? '气泡常驻' : '气泡短暂',
    c.timerBubbleOnly ? '只显计时' : '显示余额',
    c.timerPersistOn ? '记住状态' : '不记住',
  ].join(' · ')
})

// —— 默认时长：三段输入 ——
// 配置里只存总秒数（timerSec），三段是它的展示形态；本地单独放一份，避免每次输入都被
// 折算回秒再拆回来导致光标跳动。
const timerHms = reactive({ h: 0, m: 0, s: 0 })
function syncTimerHms() {
  const sec = Math.max(0, Math.min(86399, Math.round(Number(props.cfg.timerSec) || 0)))
  timerHms.h = Math.floor(sec / 3600)
  timerHms.m = Math.floor((sec % 3600) / 60)
  timerHms.s = sec % 60
}
// 三段全填 0 时按 25 分钟兜底：否则「填了 0 就开不了计时」，宿主清洗也会把它拉回默认值
function commitTimerHms() {
  const sec = Math.round(Number(timerHms.h) || 0) * 3600 + Math.round(Number(timerHms.m) || 0) * 60 + Math.round(Number(timerHms.s) || 0)
  emit('patch', { timerSec: Math.max(1, Math.min(86399, sec || 1500)) })
  syncTimerHms()
}
// 配置变化（备份恢复 / 宿主推送）时刷新三段；immediate 让首次挂载就有正确展示
watch(() => props.cfg.timerSec, syncTimerHms, { immediate: true })

// —— 快捷时长四档 ——
// 每档独立归一：1–600 取整，非数字输入保持该档现值（清空会被 Number('') 读成 0，夹到下限 1）。直接写回 input.value，
// 因为宿主可能把 601 夹成 600 而 cfg 恰好已是 600 —— 靠 :value 重渲染不会更新 DOM，
// 输入框会一直留着用户输的原文（看着像没保存）。
function commitPreset(i: number, e: Event) {
  const el = e.target as HTMLInputElement
  const cur = (Array.isArray(props.cfg.timerPresets) ? props.cfg.timerPresets : props.timerPresetsDefault).slice(0, 4)
  const n = Math.round(Number(el.value))
  const v = isFinite(n) ? Math.min(600, Math.max(1, n)) : (Number(cur[i]) || props.timerPresetsDefault[i])
  const next = props.timerPresetsDefault.map((dft, j) => (Number(cur[j]) > 0 ? Math.round(Number(cur[j])) : dft))
  next[i] = v
  emit('patch', { timerPresets: next })
  el.value = String(v)
}

// —— 休息与番茄 ——
// 「休息」档：0 分钟 = 不显示休息按钮（与挂件侧 hideBubble 后的按钮显隐同口径）
const timerBreakOn = computed({
  get: () => props.cfg.timerBreakMin > 0,
  set: (v: boolean) => { onTimerBreakToggle(v) },
})
// 展示值：未开启（0）时给个可用的 5 分钟当草稿；落盘在 @change 里读事件值
const timerBreakMinShown = computed(() => (props.cfg.timerBreakMin > 0 ? props.cfg.timerBreakMin : 5))
function onTimerBreakToggle(on: boolean) {
  emit('patch', { timerBreakMin: on ? (props.cfg.timerBreakMin > 0 ? props.cfg.timerBreakMin : 5) : 0 })
}
// 数字输入统一提交：夹到 [lo, hi] 取整，非数字值保持现值（清空同理被读成 0，夹到下限）；并把归一后的值写回 DOM
// （理由同 commitPreset：非法输入被宿主清洗后 cfg 可能不变，:value 不会刷新）
function commitNum(key: string, lo: number, hi: number, e: Event) {
  const el = e.target as HTMLInputElement
  const n = Math.round(Number(el.value))
  const cur = Number(props.cfg[key])
  const v = isFinite(n) ? Math.min(hi, Math.max(lo, n)) : (isFinite(cur) ? cur : lo)
  emit('patch', { [key]: v })
  el.value = String(v)
}
function commitTimerBreak(e: Event) {
  const el = e.target as HTMLInputElement
  const n = Math.round(Number(el.value))
  const v = isFinite(n) ? Math.min(120, Math.max(1, n)) : (props.cfg.timerBreakMin > 0 ? props.cfg.timerBreakMin : 5)
  emit('patch', { timerBreakMin: v })
  el.value = String(v)
}
function onCheck(key: string, e: Event) {
  emit('patch', { [key]: (e.target as HTMLInputElement).checked })
}
</script>

<template>
  <!-- [用量] 计时：计时功能的全部配置。不做卡级折叠 —— 搜索「倒计时 / 番茄 / 快捷时长」
       会直接滚到这里，折起来等于「搜到了却看不到控件」。 -->
  <section class="card-embedded" data-search="timer">
    <h3 class="card-sub">计时设置</h3>
    <p class="hint">这里只设<b>默认值</b>；挂件里临时改的时长只影响那一轮。</p>

    <h3 class="card-sub">默认与快捷档位</h3>
    <div class="field row">
      <span class="label">默认倒计时时长 <em>（填 0 按 25 分钟）</em></span>
      <input class="num" type="number" min="0" max="23" step="1" v-model.number="timerHms.h" @change="commitTimerHms" />
      <span class="num-text">时</span>
      <input class="num" type="number" min="0" max="59" step="1" v-model.number="timerHms.m" @change="commitTimerHms" />
      <span class="num-text">分</span>
      <input class="num" type="number" min="0" max="59" step="1" v-model.number="timerHms.s" @change="commitTimerHms" />
      <span class="num-text">秒</span>
    </div>
    <div class="field row">
      <span class="label">快捷时长档位 <em>（挂件里的四个快捷按钮，分钟）</em></span>
      <div class="timer-presets">
        <input v-for="(p, i) in (cfg.timerPresets || timerPresetsDefault)" :key="i"
               class="num timer-preset" type="number" min="1" max="600" step="1"
               :value="p" :title="'第 ' + (i + 1) + ' 档：点一下按这个分钟数开始一轮'"
               @change="commitPreset(i, $event)" />
      </div>
    </div>
    <p class="hint">只对那一轮生效，不改默认时长。</p>

    <!-- 「到点提醒」（留言 / 系统通知 / 气泡停留 / 邮件）已迁到「提醒与通知」卡：
         本卡只回答「一轮多长、怎么循环、气泡怎么写」，到点怎么提示归提醒 -->
    <p class="hint">到点怎么提示（留言 / 系统通知 / 邮件 / 气泡停留）在「提醒与通知」卡里设。</p>

    <h3 class="card-sub card-sub-toggle" role="button" tabindex="0"
        :aria-expanded="foldOpen('rest')"
        @click="toggleFold('rest')"
        @keydown.enter.prevent="toggleFold('rest')"
        @keydown.space.prevent="toggleFold('rest')">
      休息与番茄<span class="fold-caret">{{ foldOpen('rest') ? '▾' : '▸' }}</span>
      <em v-if="!foldOpen('rest')">{{ restBrief }}</em>
    </h3>
    <template v-if="foldOpen('rest')">
    <label class="field row check">
      <span class="label">到点后给「休息」快捷键 <em>（到点气泡旁出现「休息」按钮）</em></span>
      <input type="checkbox" v-model="timerBreakOn" />
    </label>
    <label v-if="timerBreakOn" class="field row">
      <span class="label">短休时长</span>
      <input class="num" type="number" min="1" max="120" step="1" :value="timerBreakMinShown" @change="commitTimerBreak" />
      <span class="num-text">分钟</span>
    </label>

    <label class="field row check">
      <span class="label">番茄循环 <em>（专注与休息自动交替）</em></span>
      <input type="checkbox" :checked="cfg.timerPomoOn" @change="onCheck('timerPomoOn', $event)" />
    </label>
    <template v-if="cfg.timerPomoOn">
      <label class="field row">
        <span class="label">长休时长 <em>（每 N 轮进一次）</em></span>
        <input class="num" type="number" min="1" max="60" step="1" :value="cfg.timerLongBreakMin"
               @change="commitNum('timerLongBreakMin', 1, 60, $event)" />
        <span class="num-text">分钟</span>
      </label>
      <label class="field row">
        <span class="label">每几轮进长休</span>
        <input class="num" type="number" min="2" max="12" step="1" :value="cfg.timerLongEvery"
               @change="commitNum('timerLongEvery', 2, 12, $event)" />
        <span class="num-text">轮</span>
      </label>
      <!-- 「自动衔接下一轮」v1.15 移除：到点一律停下等用户点。自动衔接要维护等待期、
           倒计时与取消路径，是最容易「没点却自己跑了」的一处；手动点一下成本更低 -->
    </template>

    <!-- 到点自动衔接下一条待办（v1.17 恢复为可选，默认关）：
         只管「待办这条做完了要不要接着下一条」，与上面的番茄循环（轮间怎么休息）正交。
         v1.15 硬移除是因为它当时无条件生效；现在做成显式开关 + 到点气泡仍可取消 -->
    <label class="field row check">
      <span class="label">到点自动开始下一条待办 <em>（待办计时结束时，自动接下一条未完成项）</em></span>
      <input type="checkbox" :checked="cfg.todoAutoNext" @change="onCheck('todoAutoNext', $event)" />
    </label>
    </template>

    <h3 class="card-sub card-sub-toggle" role="button" tabindex="0"
        :aria-expanded="foldOpen('bubble')"
        @click="toggleFold('bubble')"
        @keydown.enter.prevent="toggleFold('bubble')"
        @keydown.space.prevent="toggleFold('bubble')">
      计时气泡与状态<span class="fold-caret">{{ foldOpen('bubble') ? '▾' : '▸' }}</span>
      <em v-if="!foldOpen('bubble')">{{ bubbleBrief }}</em>
    </h3>
    <template v-if="foldOpen('bubble')">
    <label class="field row check">
      <span class="label">计时气泡常驻 <em>（关掉后只在开始时短暂显示）</em></span>
      <input type="checkbox" :checked="cfg.timerBubblePin" @change="onCheck('timerBubblePin', $event)" />
    </label>
    <label class="field row check">
      <span class="label">计时中只显示计时 <em>（双击鲸鱼可临时看余额）</em></span>
      <input type="checkbox" :checked="cfg.timerBubbleOnly" @change="onCheck('timerBubbleOnly', $event)" />
    </label>
    <label class="field row check">
      <span class="label">记住计时状态 <em>（重载后继续计时）</em></span>
      <input type="checkbox" :checked="cfg.timerPersistOn" @change="onCheck('timerPersistOn', $event)" />
    </label>
    </template>

    <p class="hint">
      实际计时在挂件菜单的「{{ cfg.todoOn ? '专注' : '计时' }}」组；{{ focusRulesHint }}。
    </p>
  </section>
</template>

<style scoped>
/* 设计令牌来自 main.css 的 :root；.field / .hint / .num / .link-btn / utils 按钮档位、
   分区标题 .card-sub 均由 main.css 统一提供（全局唯一来源），这里只留本卡特有样式。 */

.timer-presets {
  display: flex;
  gap: 6px;
}
.timer-preset {
  width: 58px;
}
/* 低频分区的折叠标题 .card-sub-toggle 与三角 .fold-caret 已上提到 main.css
   （FocusView 也要用同一套，scoped 样式跨不了组件） */
</style>
