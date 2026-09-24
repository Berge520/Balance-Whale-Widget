<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { SoundRole } from '../types/services'

// 音效裁剪弹层：宿主把选中的音频读成 data URL 传进来（不落盘），
// 这里解码出波形、拖手柄选一段试听，确认后编码成 16-bit PCM WAV 交回父级落盘。
const props = defineProps<{ dataUrl: string; name: string; role: SoundRole; vol: number }>()
const emit = defineEmits<{
  confirm: [payload: { dataUrl: string; name: string }]
  cancel: []
}>()

// 选区最长 10 秒：挂件音效是「按一下」的短音，长音频只截一段用
const MAX_SEL = 10
// 选区最小长度（秒），避免拖成 0 长度后无法再拉回来
const MIN_SEL = 0.05

const audio = ref<AudioBuffer | null>(null)
const startSec = ref(0)
const endSec = ref(0)
const playing = ref(false)
const busy = ref(false)
const tip = ref('')
const trackEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

// 解码与试听共用同一个 AudioContext（Chromium 限制页面里的实例数量），卸载时关闭
let ac: AudioContext | null = null
let source: AudioBufferSourceNode | null = null

const total = computed(() => (audio.value ? audio.value.duration : 0))
const dur = computed(() => Math.max(0, endSec.value - startSec.value))
// 标题里的段落名（六槽位，与 App.vue 的 SOUND_ROLE_LABEL 同义但更短，配合「裁剪…」读得顺）
const ROLE_TEXT: Record<SoundRole, string> = {
  press: '按压音', release: '释放音',
  low: '低余额提醒音', budget: '预算提醒音', peak: '峰谷提醒音', pass: '穿透提醒音',
}
const roleText = computed(() => ROLE_TEXT[props.role] || '音效')
const startPct = computed(() => (total.value ? (startSec.value / total.value) * 100 : 0))
const widthPct = computed(() => (total.value ? (dur.value / total.value) * 100 : 0))
// 选区下限取「6px 对应的时长」：长音频里 0.05 秒只有零点几像素宽，
// 两个手柄会完全叠在一起，拖不开
const minDur = computed(() => {
  const w = trackEl.value ? trackEl.value.clientWidth : 0
  if (!w || !total.value) return MIN_SEL
  return Math.max(MIN_SEL, (6 / w) * total.value)
})

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max)
}

// 画波形：按像素列取该列区间的峰值（峰值比均值更能看出敲击音的位置）
function drawWave() {
  const cv = canvasEl.value
  const buf = audio.value
  if (!cv || !buf) return
  const dpr = window.devicePixelRatio || 1
  const cssW = cv.clientWidth || 480
  const cssH = cv.clientHeight || 90
  cv.width = Math.max(1, Math.round(cssW * dpr))
  cv.height = Math.max(1, Math.round(cssH * dpr))
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  const data = buf.getChannelData(0)
  const mid = cssH / 2
  ctx.fillStyle = 'rgba(83, 107, 169, 0.75)'
  for (let x = 0; x < cssW; x++) {
    const from = Math.floor((x * data.length) / cssW)
    const to = Math.max(from + 1, Math.floor(((x + 1) * data.length) / cssW))
    let peak = 0
    for (let i = from; i < to && i < data.length; i++) {
      const v = Math.abs(data[i])
      if (v > peak) peak = v
    }
    const h = Math.max(1, peak * (cssH - 4))
    ctx.fillRect(x, mid - h / 2, 1, h)
  }
}

// 选区越界/超长时收回来（超长直接截断并提示，不做二次确认）
function setRange(s: number, e: number) {
  const t = total.value
  if (!t) return
  const min = Math.min(minDur.value, t)
  const ns = clamp(s, 0, t - min)
  let ne = clamp(e, ns + min, t)
  if (ne - ns > MAX_SEL) {
    ne = ns + MAX_SEL
    if (ne > t) ne = t
    tip.value = '选区最长 10 秒，已截断'
  }
  startSec.value = ns
  endSec.value = ne
}

type DragMode = 'start' | 'end'
let drag: { mode: DragMode; sx: number } | null = null

function startDrag(e: PointerEvent, mode: DragMode) {
  e.preventDefault()
  drag = { mode: mode, sx: e.clientX }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
}

function onDragMove(e: PointerEvent) {
  if (!drag || !trackEl.value) return
  const w = trackEl.value.clientWidth || 1
  const dt = ((e.clientX - drag.sx) / w) * total.value
  if (drag.mode === 'start') setRange(startSec.value + dt, endSec.value)
  else setRange(startSec.value, endSec.value + dt)
}

function endDrag() {
  drag = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
}

function selectAll() {
  tip.value = ''
  setRange(0, total.value)
}

function stopPreview() {
  if (!source) return
  try { source.stop() } catch (err) {}
  source = null
  playing.value = false
}

function playSelection() {
  const buf = audio.value
  if (!buf) return
  stopPreview()
  try {
    if (!ac) ac = new AudioContext()
    if (ac.state === 'suspended') ac.resume()
    const gain = ac.createGain()
    gain.gain.value = clamp(props.vol, 0, 1)
    const src = ac.createBufferSource()
    src.buffer = buf
    src.connect(gain)
    gain.connect(ac.destination)
    src.onended = () => {
      if (source === src) {
        source = null
        playing.value = false
      }
    }
    src.start(0, startSec.value, Math.max(MIN_SEL, dur.value))
    source = src
    playing.value = true
    tip.value = ''
  } catch (err: any) {
    tip.value = '试听失败：' + String(err?.message || err)
  }
}

// 单声道 16-bit PCM WAV（44 字节 RIFF 头 + 采样数据）。
// 挂件侧 new Audio(dataURL) 直接可播，体积也比 base64 的 mp3 更可控。
function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const data = buf.getChannelData(0)
  const rate = buf.sampleRate
  const bytes = data.length * 2
  const ab = new ArrayBuffer(44 + bytes)
  const view = new DataView(ab)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // 1 = PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // 字节率 = 采样率 × 声道 × 位深/8
  view.setUint16(32, 2, true) // 块对齐
  view.setUint16(34, 16, true) // 位深
  str(36, 'data')
  view.setUint32(40, bytes, true)
  let off = 44
  for (let i = 0; i < data.length; i++) {
    const v = clamp(data[i], -1, 1)
    view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true)
    off += 2
  }
  return ab
}

function toBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab)
  let out = ''
  // 分块拼字符串：一次性 apply 几百万个参数会爆栈
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK)
    let part = ''
    for (let j = 0; j < sub.length; j++) part += String.fromCharCode(sub[j])
    out += part
  }
  return btoa(out)
}

async function confirmTrim() {
  const buf = audio.value
  if (!buf || busy.value) return
  busy.value = true
  try {
    const rate = buf.sampleRate
    const length = Math.max(1, Math.ceil(dur.value * rate))
    const off = new OfflineAudioContext(1, length, rate)
    const src = off.createBufferSource()
    src.buffer = buf
    src.connect(off.destination)
    src.start(0, startSec.value, Math.max(MIN_SEL, dur.value))
    const rendered = await off.startRendering()
    const url = 'data:audio/wav;base64,' + toBase64(encodeWav(rendered))
    emit('confirm', { dataUrl: url, name: props.name })
  } catch (err: any) {
    tip.value = '生成 WAV 失败：' + String(err?.message || err)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    const res = await fetch(props.dataUrl)
    const ab = await res.arrayBuffer()
    ac = new AudioContext()
    const decoded = await ac.decodeAudioData(ab)
    audio.value = decoded
    setRange(0, decoded.duration)
    tip.value = decoded.duration > MAX_SEL ? '已默认选中前 10 秒' : ''
    drawWave()
  } catch (err: any) {
    tip.value = '音频解码失败（该格式可能不受支持）：' + String(err?.message || err)
  }
})

onUnmounted(() => {
  endDrag()
  stopPreview()
  try { ac?.close() } catch (err) {}
  ac = null
})
</script>

<template>
  <div class="overlay">
    <div class="panel">
      <div class="head">
        <span class="title">裁剪{{ roleText }}</span>
        <span class="sub" :title="name">{{ name }}</span>
      </div>

      <div ref="trackEl" class="track">
        <canvas ref="canvasEl" class="wave"></canvas>
        <div v-if="audio" class="sel" :style="{ left: startPct + '%', width: widthPct + '%' }">
          <span class="handle h-start" @pointerdown.stop="startDrag($event, 'start')"></span>
          <span class="handle h-end" @pointerdown.stop="startDrag($event, 'end')"></span>
        </div>
      </div>

      <p class="time">
        选区 {{ startSec.toFixed(2) }}s – {{ endSec.toFixed(2) }}s（{{ dur.toFixed(2) }}s）
        <em v-if="audio">／ 原音 {{ total.toFixed(2) }}s</em>
      </p>

      <div class="btn-row">
        <button class="secondary utils-btn utils-secondary" type="button" :disabled="!audio" @click="playing ? stopPreview() : playSelection()">
          {{ playing ? '停止' : '试听选区' }}
        </button>
        <button class="secondary utils-btn utils-secondary" type="button" :disabled="!audio" @click="selectAll">全选</button>
      </div>
      <p v-if="tip" class="tip">{{ tip }}</p>
      <p class="hint">
        拖动两侧手柄选择要保留的片段（最长 10 秒）；导入后会转成 WAV 单声道，音效会复制到本地数据目录。
      </p>

      <div class="btn-row">
        <button class="secondary utils-btn utils-secondary" type="button" @click="emit('cancel')">取消</button>
        <button class="utils-btn utils-primary" type="button" :disabled="!audio || busy" @click="confirmTrim">{{ busy ? '处理中…' : '确定' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(20, 26, 42, 0.55);
}
.panel {
  width: 100%;
  max-width: 540px;
  padding: 16px;
  border-radius: 12px;
  background: var(--input-bg, #fff);
  color: var(--fg, #1f2a44);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.title {
  font-size: 14px;
  font-weight: 600;
}
.sub {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim, #536ba9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track {
  position: relative;
  height: 90px;
  border: 1px solid var(--line, rgba(83, 107, 169, 0.4));
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.06);
  overflow: hidden;
  touch-action: none;
}
.wave {
  display: block;
  width: 100%;
  height: 100%;
}
.sel {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--accent, #536ba9);
  border-right: 1px solid var(--accent, #536ba9);
  background: rgba(83, 107, 169, 0.16);
}
.handle {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 34px;
  margin-top: -17px;
  border-radius: 4px;
  background: var(--accent, #536ba9);
  cursor: ew-resize;
  touch-action: none;
}
/* 手柄压在选区内侧：贴到轨道两端时不会被 overflow 切掉一半，抓不到 */
.h-start { left: 0; }
.h-end { right: 0; }
.time {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-dim, #536ba9);
}
.time em {
  font-style: normal;
  color: var(--fg-faint, #9fb0d9);
}
.btn-row {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}
/* 尺寸/配色走 main.css 的 utils 基类（markup 挂 .utils-btn + .utils-secondary /
   .utils-primary），这里只留等分拉伸。原先这份是独立一套 13px + 靠 main.css
   line-height 2.5 撑高，是全页"高矮胖瘦不一"的来源之一。 */
.btn-row button {
  flex: 1;
}
.tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--err, #e0433f);
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-faint, #9fb0d9);
}
</style>
