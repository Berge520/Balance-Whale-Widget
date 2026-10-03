<script lang="ts" setup>
// 台词预览舞台：挂载共享渲染器（src/bubble/bubble-render.js），与悬浮窗气泡
// 同一套 DOM / 主题变量 / 字号自适应算法，台词库编辑时所见即所得。
// 悬浮窗走 esbuild 打的 IIFE（window.BubbleRender），这里直接 ESM import 同一源文件——
// 两边共享的正是这份源码，而不是各自维护的副本。
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { createBubbleRenderer, THEMES } from '../bubble/bubble-render.js'

interface PreviewLine { t: string; s: 'A' | 'B' | 'P' | 'C'; c?: string; w?: boolean }
const props = defineProps<{
  lines: Array<PreviewLine | null> | { gif: true; src?: string }
  theme?: string
}>()

const stage = ref<HTMLElement | null>(null)
let renderer: ReturnType<typeof createBubbleRenderer> | null = null
let rootEl: HTMLElement | null = null

// 点气泡 = 切下一条（多行文本组逐条检查时不用瞄准小按钮）；由父组件决定是否响应
const emit = defineEmits<{ next: [] }>()

// 主题只重写 CSS 变量、不重建 DOM（与悬浮窗 floating-page.js 的 applyTheme 同一笔画）
function applyThemeVars() {
  if (!rootEl) return
  const themes = THEMES as unknown as Record<string, { text: string; hint: string; fill: string; stroke: string }>
  const t = themes[props.theme || 'default'] || themes.default
  rootEl.style.setProperty('--dshwv-text', t.text)
  rootEl.style.setProperty('--dshwv-hint', t.hint)
  rootEl.style.setProperty('--dshwv-fill', t.fill)
  rootEl.style.setProperty('--dshwv-stroke', t.stroke)
}

onMounted(() => {
  rootEl = document.createElement('div')
  rootEl.className = 'dshwv-root bubble-preview-root'
  renderer = createBubbleRenderer({
    rootEl,
    // 与悬浮窗同路径：设置页 index.html 也在 dist 根，./whale/rua.webp 可直接解析
    defaultGifUrl: './whale/rua.webp',
    onGifError() { /* 预览里图挂了就让它挂着，不做降级文案（那是挂件的运行时行为） */ },
  })
  // 预览里的气泡常开（不做收起状态机）：文本/动图的显隐全由 applyLines 按行模型控制
  renderer.els.bubbleBox.classList.add('dshwv-bubble-open')
  // 渲染器只造 DOM 不挂载（悬浮窗也是页面自己 append 的）：漏了这步气泡就漂在文档外，
  // 点「预览」毫无反应（首版踩过）。不包 .dshwv-body：那层是悬浮窗 Q 弹动画的载体，
  // 气泡/文字的百分比定位以最近定位祖先为准，直接挂 root 几何完全一致
  rootEl.appendChild(renderer.els.bubbleBox)
  if (stage.value) stage.value.appendChild(rootEl)
  applyThemeVars()
  renderer.applyLines(props.lines)
})
onUnmounted(() => {
  if (renderer) renderer.cancelGifFade()
  renderer = null
  rootEl = null
})

// 行模型变化即重渲染：台词框打字时实时预览（computed 每次给新数组，引用必变）
watch(() => props.lines, (v) => { if (renderer) renderer.applyLines(v) })
watch(() => props.theme, () => applyThemeVars())
</script>

<template>
  <div ref="stage" class="bubble-preview-stage" @click="emit('next')"></div>
</template>

<style scoped>
/* 舞台：挂件基准固定 330px（u = 330/1026）。root 按真机口径取正方形（悬浮窗窗口四边
   留白对称，本体永远是正方形），居中于 365px 高舞台：root 本身 330 + 气泡放大 118% 的
   -4.67% 负偏移再向上探 ~15px，365px 才容得下气泡顶弧（300px 首版裁掉了顶弧，踩过）。
   动态插入的 DOM 没有 scoped 属性，气泡本体样式全靠全局的 floating-bubble.css，
   这里只用 :deep() 管 root 几何与舞台外观。 */
.bubble-preview-stage {
  position: relative;
  height: 365px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  background: var(--input-bg);
  overflow: hidden;
}
.bubble-preview-stage :deep(.bubble-preview-root) {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 330px;
  height: 330px;
  transform: translate(-50%, -50%);
  /* 挂件基准：floating.css 的 .dshwv-root 用 calc(100vw - pad*2)，预览舞台自备固定值 */
  --dshw-base: 330px;
}
</style>
