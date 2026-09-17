<script lang="ts" setup>
import { computed, onUnmounted, reactive, ref } from 'vue'

// 形象图片裁剪弹层：宿主只把选中的图片读成 data URL 传进来（不落盘），
// 用户在这里框选范围、点「确定裁剪」后由父级调 importSkinFromData 写入 PNG。
const props = defineProps<{ dataUrl: string; name: string }>()
const emit = defineEmits<{
  confirm: [payload: { dataUrl: string; name: string }]
  cancel: []
}>()

// 图片在面板内的显示上限（px）：图再大也缩到框内；小图适度放大，否则框选没法操作
const MAX_W = 480
const MAX_H = 340
const MAX_UPSCALE = 8
// 裁剪框最小边长（显示坐标 px），避免拖成 0 宽后无法再拉回来
const MIN_SIZE = 8
const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const
type Handle = typeof HANDLES[number]

const imgEl = ref<HTMLImageElement | null>(null)
const natural = reactive({ w: 0, h: 0 })
const scale = ref(1)
const ready = ref(false)
const tip = ref('')
const crop = reactive({ x: 0, y: 0, w: 0, h: 0 })

const dispW = computed(() => Math.max(1, Math.round(natural.w * scale.value)))
const dispH = computed(() => Math.max(1, Math.round(natural.h * scale.value)))
const cropStyle = computed(() => ({
  left: crop.x + 'px',
  top: crop.y + 'px',
  width: crop.w + 'px',
  height: crop.h + 'px',
}))

// 把裁剪框夹回图片范围内，并保证不小于最小边长
function setCrop(x: number, y: number, w: number, h: number) {
  const W = dispW.value
  const H = dispH.value
  const nw = Math.min(Math.max(MIN_SIZE, Math.round(w)), W)
  const nh = Math.min(Math.max(MIN_SIZE, Math.round(h)), H)
  crop.w = nw
  crop.h = nh
  crop.x = Math.min(Math.max(0, Math.round(x)), W - nw)
  crop.y = Math.min(Math.max(0, Math.round(y)), H - nh)
}

function onImgLoad() {
  const el = imgEl.value
  if (!el) return
  natural.w = el.naturalWidth || 0
  natural.h = el.naturalHeight || 0
  if (!natural.w || !natural.h) return
  scale.value = Math.min(MAX_W / natural.w, MAX_H / natural.h, MAX_UPSCALE)
  ready.value = true
  tip.value = ''
  setCrop(0, 0, dispW.value, dispH.value)
}

function onImgError() {
  tip.value = '图片无法加载，请换一张试试'
}

// 拖拽：框内拖动 = 整体平移，四角/四边 = 缩放。指针事件挂在 window 上，
// 这样鼠标拖出面板也不会丢事件（松手在面板外同样能收尾）。
type DragMode = 'move' | Handle
let drag: { mode: DragMode; sx: number; sy: number; rect: { x: number; y: number; w: number; h: number } } | null = null

function startDrag(e: PointerEvent, mode: DragMode) {
  if (!ready.value) return
  e.preventDefault()
  drag = { mode: mode, sx: e.clientX, sy: e.clientY, rect: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
}

function onDragMove(e: PointerEvent) {
  if (!drag) return
  const dx = e.clientX - drag.sx
  const dy = e.clientY - drag.sy
  const W = dispW.value
  const H = dispH.value
  if (drag.mode === 'move') {
    setCrop(drag.rect.x + dx, drag.rect.y + dy, drag.rect.w, drag.rect.h)
    return
  }
  let left = drag.rect.x
  let top = drag.rect.y
  let right = drag.rect.x + drag.rect.w
  let bottom = drag.rect.y + drag.rect.h
  if (drag.mode.indexOf('w') >= 0) left = Math.min(Math.max(0, left + dx), right - MIN_SIZE)
  if (drag.mode.indexOf('e') >= 0) right = Math.max(Math.min(W, right + dx), left + MIN_SIZE)
  if (drag.mode.indexOf('n') >= 0) top = Math.min(Math.max(0, top + dy), bottom - MIN_SIZE)
  if (drag.mode.indexOf('s') >= 0) bottom = Math.max(Math.min(H, bottom + dy), top + MIN_SIZE)
  setCrop(left, top, right - left, bottom - top)
}

function endDrag() {
  drag = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
}

function selectAll() {
  tip.value = ''
  setCrop(0, 0, dispW.value, dispH.value)
}

// 自动裁掉透明边：扫 alpha > 8 的包围盒。逐像素扫描很吃时间，
// 先等比缩到 1024 以内再扫（包围盒精度对裁剪框足够），避免大图卡住界面。
function autoTrim() {
  const el = imgEl.value
  if (!el || !ready.value) return
  const S = Math.min(1, 1024 / Math.max(natural.w, natural.h))
  const w = Math.max(1, Math.round(natural.w * S))
  const h = Math.max(1, Math.round(natural.h * S))
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.drawImage(el, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) {
    tip.value = '整张图都是透明的'
    return
  }
  const k = dispW.value / w
  setCrop(minX * k, minY * k, (maxX + 1 - minX) * k, (maxY + 1 - minY) * k)
  tip.value = '已按不透明区域选中'
}

// 导出选区：按原图像素裁，toDataURL('image/png') 保留透明通道
// （挂件是透明窗，导出白底图会变成一块白方块）
function confirmCrop() {
  const el = imgEl.value
  if (!el || !ready.value) return
  const sx = crop.x / scale.value
  const sy = crop.y / scale.value
  const sw = crop.w / scale.value
  const sh = crop.h / scale.value
  const cw = Math.max(1, Math.round(sw))
  const ch = Math.max(1, Math.round(sh))
  const cv = document.createElement('canvas')
  cv.width = cw
  cv.height = ch
  const ctx = cv.getContext('2d')
  if (!ctx) {
    tip.value = '当前环境不支持裁剪，请换一张图片'
    return
  }
  ctx.drawImage(el, sx, sy, sw, sh, 0, 0, cw, ch)
  let url = ''
  try {
    url = cv.toDataURL('image/png')
  } catch (err) {
    tip.value = '导出图片失败，请换一张试试'
    return
  }
  emit('confirm', { dataUrl: url, name: props.name })
}

onUnmounted(endDrag)
</script>

<template>
  <div class="overlay">
    <div class="panel">
      <div class="head">
        <span class="title">裁剪形象图片</span>
        <span class="sub" :title="name">{{ name }}</span>
      </div>

      <div class="stage-wrap">
        <div class="stage-clip">
          <div class="stage" :style="{ width: dispW + 'px', height: dispH + 'px' }">
            <img ref="imgEl" class="pic" :src="dataUrl" alt="" draggable="false" @load="onImgLoad" @error="onImgError" />
            <div class="crop" :style="cropStyle" @pointerdown.stop="startDrag($event, 'move')">
              <span
                v-for="h in HANDLES"
                :key="h"
                class="handle"
                :class="'h-' + h"
                @pointerdown.stop="startDrag($event, h)"
              ></span>
            </div>
          </div>
        </div>
      </div>

      <div class="btn-row">
        <button class="secondary" type="button" :disabled="!ready" @click="autoTrim">自动裁掉透明边</button>
        <button class="secondary" type="button" :disabled="!ready" @click="selectAll">全选</button>
      </div>
      <p v-if="tip" class="tip">{{ tip }}</p>
      <p class="hint">
        拖动框内可移动，拖四角/四边可缩放；裁剪结果会存为 PNG（保留透明通道）。GIF 裁剪后会变成静态 PNG。
      </p>

      <div class="btn-row">
        <button class="secondary" type="button" @click="emit('cancel')">取消</button>
        <button type="button" :disabled="!ready" @click="confirmCrop">确定裁剪</button>
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
  max-width: 540px;
  max-height: 100%;
  overflow: auto;
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
.stage-wrap {
  display: flex;
  justify-content: center;
}
/* 留一圈内边距再裁切：裁剪框的压暗阴影被这里裁住，
   同时四角/四边手柄（伸出框外 5px）不会被切掉一半导致抓不住 */
.stage-clip {
  padding: 12px;
  border-radius: 10px;
  overflow: hidden;
  /* 棋盘格底：透明 PNG 的透明区域能看出来 */
  background-color: #fff;
  background-image: linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%),
    linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%);
  background-size: 12px 12px;
  background-position: 0 0, 6px 6px;
}
.stage {
  position: relative;
  touch-action: none;
}
.pic {
  display: block;
  width: 100%;
  height: 100%;
  user-select: none;
}
/* 裁剪框：靠超大 spread 的 box-shadow 把框外压暗，比铺四块遮罩省事且不会盖住框内 */
.crop {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid #fff;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
  cursor: move;
  touch-action: none;
}
.handle {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 1px solid var(--accent, #536ba9);
  border-radius: 2px;
  background: #fff;
  touch-action: none;
}
.h-nw { left: -5px; top: -5px; cursor: nwse-resize; }
.h-n { left: 50%; top: -5px; margin-left: -5px; cursor: ns-resize; }
.h-ne { right: -5px; top: -5px; cursor: nesw-resize; }
.h-w { left: -5px; top: 50%; margin-top: -5px; cursor: ew-resize; }
.h-e { right: -5px; top: 50%; margin-top: -5px; cursor: ew-resize; }
.h-sw { left: -5px; bottom: -5px; cursor: nesw-resize; }
.h-s { left: 50%; bottom: -5px; margin-left: -5px; cursor: ns-resize; }
.h-se { right: -5px; bottom: -5px; cursor: nwse-resize; }
.btn-row {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}
.btn-row button {
  flex: 1;
  border-radius: 8px;
  font-size: 13px;
}
.btn-row button.secondary {
  background: rgba(83, 107, 169, 0.18);
  color: var(--accent, #536ba9);
}
.btn-row button:disabled {
  opacity: 0.45;
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
