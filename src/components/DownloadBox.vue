<script lang="ts" setup>
// 下载进度盒：三张下载卡（内置资源与下载源 / 共享形象 / 共享音效）原本各手抄一份
// 同款 `.dl-box`（进度条 + 行进字节 + 下载源一行），三份只能一起改、改漏一处就三种观感。
// 收成一处后，进度「总量未知」的滑块态、字节数等宽防抖、超长 URL 断行这些口径只有一个来源。
// 显示与否由调用方判定（各自比对 dlProgress.pack），本组件只管画。
import { computed } from 'vue'
import type { DownloadProgress } from '../types/services'

const props = defineProps<{
  progress: DownloadProgress
  // 百分比；null = 总量未知，改用来回扫的滑块（不谎报百分比）
  percent: number | null
  // 行进字节文案（「12 MB / 40 MB」或「12 MB」）
  amount: string
}>()

// 终态（下载完成 / 下载失败）必须停掉「来回扫」：否则「下载失败」旁边那根条还在动，
// 看起来像仍在重试；总量未知时终态也按满格收尾（完成绿 / 失败红），让条形自己说明结果。
const terminal = computed(() => props.progress.phase === 'done' || props.progress.phase === 'failed')
// 「总量未知」的滑块态只属于进行中
const indet = computed(() => props.percent === null && !terminal.value)
const barStyle = computed(() => (indet.value ? undefined : { width: (props.percent === null ? 100 : props.percent) + '%' }))
</script>

<template>
  <div class="dl-box">
    <div class="dl-track">
      <div class="dl-bar" :class="{ indet: indet, done: progress.phase === 'done', err: progress.phase === 'failed' }"
           :style="barStyle"></div>
    </div>
    <div class="dl-line">
      <span class="dl-label">{{ progress.label }}</span>
      <span class="dl-amt">{{ amount }}</span>
      <span v-if="percent !== null" class="dl-pct">{{ percent }}%</span>
    </div>
    <div v-if="progress.url" class="dl-src">
      <span class="dl-src-tag">下载源</span>
      <a class="dl-src-url" :href="progress.url" target="_blank" rel="noreferrer" :title="progress.url">{{ progress.url }}</a>
    </div>
  </div>
</template>

<style scoped>
.dl-box {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--track);
}
.dl-track {
  position: relative;
  height: 8px;
  border-radius: 999px;
  /* 轨道用 --line 而不是 --track：.dl-box 底色就是 --track，同色会让未填充部分整段看不见，
     条子看起来像「一截凭空浮着」 */
  background: var(--line);
  overflow: hidden;
}
.dl-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  /* 宽度每 250ms 跳一档，加过渡把台阶磨平，否则看起来像在抖 */
  transition: width 0.25s linear;
}
.dl-bar.done { background: var(--ok); }
.dl-bar.err { background: var(--err); }
/* 总量未知（加速代理回 Transfer-Encoding: chunked，拿不到 Content-Length）：
   不谎报百分比，改成来回扫的滑块表示「在动，但说不准还有多久」 */
.dl-bar.indet {
  width: 35%;
  transition: none;
  animation: dl-slide 1.1s ease-in-out infinite;
}
@keyframes dl-slide {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
.dl-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
}
.dl-label { flex: 0 0 auto; }
/* 字节数用等宽：数字每 250ms 变一次，比例字体下宽度会跳，整行跟着抖 */
.dl-amt {
  flex: 0 1 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.85;
}
.dl-pct {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.85;
}
/* 下载源一行：URL 很长（github.com/.../releases/download/...），必须能断行 + 可复制 */
.dl-src {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
}
.dl-src-tag {
  flex: 0 0 auto;
  opacity: 0.7;
}
.dl-src-url {
  flex: 1 1 auto;
  min-width: 0;
  color: inherit;
  opacity: 0.75;
  word-break: break-all;
  text-decoration: underline;
}
</style>
