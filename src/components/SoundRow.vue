<script lang="ts" setup>
// 音效「行」骨架：文件名（读的一行）+ 体积 + 动作区（slot 由调用方填）。
//
// 抽它的理由：设置页里同一种骨架被手抄了三处 ——
//   1. 槽位段行（.sound-seg）  文件名 + 试听 / 删除 + 导入时间
//   2. 共享库「已下载」行（.shs-row）  文件名 + 体积 + 下拉 / 选用 / 试听 / 删
//   3. 共享库「未下载」行（.shs-row）  文件名 + 体积 + 单一下载按钮
// 三处的文件名类名（.sound-file）与体积（.asset-meta）本来就同名同类，
// 只有动作区不同。这里只收敛「共同的骨架」，动作区原样走默认 slot ——
// 各行的类名 / 语义 / 事件都留在调用方，不动既有回归面。
//
// 为什么不在这里放 .shs-ops 的样式：那是共享库行专属（固定宽度下拉、45 行的按钮列
// 对齐），而槽位行的动作区是 .seg-ops。样式仍各归各的调用方，避免把两种行硬合并成一种。
</script>

<template>
  <!-- title 给文件名：窄卡片里长文件名会被 ellipsis 截断，鼠标悬停要看全名 -->
  <span class="sound-file" :title="name">{{ name }}</span>
  <span v-if="size !== undefined" class="asset-meta">{{ size }}</span>
  <slot />
</template>

<script lang="ts">
export default {
  props: {
    // 展示名（文件名或「按压 小黄鸭 · 释放 小黄鸭」这类概要）
    name: { type: String, required: true },
    // 体积文案（调用方用 fmtBytes 先算好）。不传则不渲染那一格：
    // 槽位段行显示的是「体积 · 导入时间」合成的一条，直接走默认 slot 自己排
    size: { type: String as () => string | undefined, default: undefined },
  },
}
</script>

<style scoped>
/* 与 AssetsView.vue 的 .sound-file / .asset-meta 逐字一致 —— 这两条是骨架自带的，
   原先散在 AssetsView.vue 里，随骨架一并搬过来（调用方不再重复定义） */
.sound-file {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 素材的体积：次要信息，不参与换行挤压 */
.asset-meta {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
</style>
