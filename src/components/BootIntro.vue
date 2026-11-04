<script lang="ts" setup>
// 设置页启动片头：可选、默认关闭、每次插件进程启动后只自动播一次。
// 有未至之境视频时作为全屏背景（4.2s 后淡出），没有则播轻量 HUD 片头（1.6s）。
// 点击 / 任意按键 / Esc 跳过；reduce 只关闭转场与 CSS 扫描动画，视频仍播放（片头是用户显式开启的功能）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import logoUrl from '../assets/logo.png'

const props = defineProps<{
  // 未至之境视频的 blob URL（可无）；有则作为片头背景
  videoUrl?: string
  // 预览时系统开了减少动态效果：保留内容、去掉位移/扫描动画
  reduce?: boolean
}>()
const emit = defineEmits<{
  (e: 'done'): void
  // 退场开始：父级据此把「纯净播放」隐藏的设置页放回来，避免退场期间露黑底
  (e: 'closing'): void
}>()

const rootEl = ref<HTMLElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const leaving = ref(false)
const videoFailed = ref(false)
const videoPaused = ref(true)
const holdMs = computed(() => (props.videoUrl && !videoFailed.value ? 4200 : 1600))
let finished = false
let holdTimer = 0
let leaveTimer = 0

function armTimer(ms: number) {
  if (holdTimer) window.clearTimeout(holdTimer)
  holdTimer = window.setTimeout(() => finish(false), ms)
}

function finish(skipped: boolean) {
  if (finished) return
  finished = true
  if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = 0 }
  leaving.value = true
  emit('closing')
  const delay = props.reduce ? 0 : skipped ? 220 : 460
  leaveTimer = window.setTimeout(() => emit('done'), delay)
}

function onKeydown(e: KeyboardEvent) {
  // Tab 留给焦点移动；其余任意键视为「跳过」
  if (e.key === 'Tab') return
  finish(true)
}

// 浏览器默认策略可能拦截静音自动播放：加载完再补一次 play；
// 仍拦下时保留「播放视频」按钮，点击它就是合法的用户交互。
function playVideoOnly() {
  const v = videoEl.value
  if (!v) return
  v.muted = true
  try {
    const p = v.play?.()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch (err) {}
}
function tryPlayVideo() {
  videoPaused.value = true
  playVideoOnly()
}

onMounted(() => {
  rootEl.value?.focus()
  window.addEventListener('keydown', onKeydown)
  armTimer(holdMs.value)
})
watch(holdMs, (ms) => { if (!finished) armTimer(ms) })
onBeforeUnmount(() => {
  if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = 0 }
  if (leaveTimer) { window.clearTimeout(leaveTimer); leaveTimer = 0 }
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootEl" class="boot-intro" :class="{ leaving: leaving, reduce: props.reduce }"
       tabindex="-1" role="dialog" aria-modal="true" aria-label="启动片头" @click="finish(true)">
    <video v-if="props.videoUrl && !videoFailed" ref="videoEl" class="boot-intro-video" :src="props.videoUrl"
           muted autoplay playsinline preload="auto" @loadeddata="tryPlayVideo"
           @play="videoPaused = false" @playing="videoPaused = false" @pause="videoPaused = true"
           @error="videoFailed = true" @ended="finish(false)"></video>
    <div class="boot-intro-veil"></div>
    <div class="boot-intro-content">
      <img class="boot-intro-logo" :src="logoUrl" alt="" />
      <div class="boot-intro-title">小鲸鱼余额挂件</div>
      <div class="boot-intro-sub">未至之境 · BALANCE WHALE</div>
      <div class="boot-intro-line"></div>
    </div>
    <div class="boot-intro-scan"></div>
    <button v-if="props.videoUrl && !videoFailed && videoPaused" class="boot-intro-play" type="button"
            @click.stop="playVideoOnly">播放视频</button>
    <button class="boot-intro-skip" type="button" @click.stop="finish(true)">跳过</button>
  </div>
</template>

<style scoped>
.boot-intro {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
  color: #E8F1FF;
  background: radial-gradient(900px 560px at 50% 38%, rgba(58, 123, 255, 0.22), transparent 66%), #05070D;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  opacity: 1;
  transition: opacity 0.46s ease;
}
.boot-intro.leaving { opacity: 0; }
.boot-intro.reduce,
.boot-intro.reduce.leaving { transition: none; }
/* 背景网格：只在没有视频/视频失败时露出来，给纯 CSS 片头一点「全息仪表盘」质感 */
.boot-intro::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(58, 123, 255, 0.1) 1px, transparent 1px),
    linear-gradient(90deg, rgba(58, 123, 255, 0.1) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse at center, #000 0%, transparent 72%);
  pointer-events: none;
}
.boot-intro-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 78% 42%;
}
.boot-intro-veil {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 80% at 50% 0%, rgba(5, 7, 13, 0.1) 0%, rgba(5, 7, 13, 0.55) 72%, #05070D 100%),
    linear-gradient(180deg, rgba(5, 7, 13, 0.38), rgba(5, 7, 13, 0.2) 42%, rgba(5, 7, 13, 0.6));
}
.boot-intro-content {
  position: relative;
  text-align: center;
  animation: boot-rise 0.6s ease both;
}
.boot-intro-logo {
  width: 92px;
  height: 92px;
  object-fit: contain;
  filter: drop-shadow(0 0 20px rgba(57, 255, 209, 0.55));
}
.boot-intro-title {
  margin-top: 14px;
  font-size: 22px;
  letter-spacing: 0.18em;
}
.boot-intro-sub {
  margin-top: 8px;
  font-size: 11px;
  letter-spacing: 0.32em;
  color: #8FA8CC;
}
.boot-intro-line {
  width: 180px;
  height: 1px;
  margin: 18px auto 0;
  background: linear-gradient(90deg, transparent, rgba(57, 255, 209, 0.9), transparent);
  animation: boot-line 0.8s 0.2s ease both;
}
.boot-intro-scan {
  position: absolute;
  left: 0;
  right: 0;
  top: -120px;
  height: 120px;
  background: linear-gradient(180deg, transparent, rgba(57, 255, 209, 0.08), transparent);
  animation: boot-scan 1.8s linear infinite;
  pointer-events: none;
}
.boot-intro-play {
  position: absolute;
  right: 92px;
  bottom: 18px;
  padding: 4px 10px;
  border: 1px solid rgba(57, 255, 209, 0.55);
  border-radius: 4px;
  background: rgba(5, 7, 13, 0.72);
  color: #B9E8E0;
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}
.boot-intro-skip {
  position: absolute;
  right: 22px;
  bottom: 18px;
  padding: 4px 10px;
  border: 1px solid rgba(57, 255, 209, 0.4);
  border-radius: 4px;
  background: rgba(5, 7, 13, 0.6);
  color: #B9E8E0;
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}
.boot-intro.reduce .boot-intro-content,
.boot-intro.reduce .boot-intro-line,
.boot-intro.reduce .boot-intro-scan { animation: none; }
.boot-intro.reduce .boot-intro-scan { display: none; }
@keyframes boot-rise {
  from { opacity: 0; transform: translateY(10px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
@keyframes boot-line {
  from { opacity: 0; transform: scaleX(0.2); }
  to { opacity: 1; transform: none; }
}
@keyframes boot-scan {
  from { top: -120px; }
  to { top: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .boot-intro,
  .boot-intro.leaving { transition: none; }
  .boot-intro-content,
  .boot-intro-line { animation: none; }
  .boot-intro-scan { display: none; }
}
</style>
