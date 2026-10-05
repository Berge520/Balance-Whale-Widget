<script lang="ts" setup>
import { reactive } from 'vue'
import type { WhaleServices } from '../types/services'

// 「关于与更新」整卡：模板 + 反馈折叠 + 插件市场 / 项目主页跳转。
// 从设置页 App.vue 抽出。**更新检查的状态与 doCheckUpdate 保留在父级**——
// 父级 onMounted 里有一处「开关开启则启动时自动检查一次」，它不随卡片是否可见而跑
// （卡片是 v-if，只在「帮助」Tab 渲染），所以状态不能跟着搬进来，这里按 props 收、
// 用 emit('check-update') 触发，保证行为与抽出前一致。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读 updateCheckOn，落盘统一走 emit('patch')
  cfg: any
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局
  services: Partial<WhaleServices>
  // 更新检查与版本号状态由父级持有（见上），这里只负责显示
  appVersion: string
  updateChecking: boolean
  updateMsg: string
  hasUpdate: boolean
  // 结果行成功（绿）/ 失败（红）由本次检查结果决定
  updateOk: boolean
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
  // 外链统一交回父级用 services.openExternal 打开（openDoc 为全页共享工具）
  (e: 'doc', url: string): void
  (e: 'check-update', force: boolean): void
}>()

// 反馈入口是软性内容，与版本信息不同性质，收进折叠
const aboutFolds = reactive({ feedback: false })

function openHomepage() {
  props.services.openExternal?.('https://github.com/Berge520/Balance-Whale-Widget')
}
// 跳 uTools 插件应用市场并搜索本插件（走「管理中心 → 插件应用市场 → 搜一搜」那条路径）。
// 原理：utools.redirect(label) 在已装插件里查不到该指令名时，底座会提示「未找到功能…已为您跳转
// 插件市场搜索」并自动打开市场搜索页 —— 这是官方文档写明的降级行为，正好用来做「去市场搜索」。
// 坑：redirect 按前缀匹配指令名，本插件 cmds 含「小鲸鱼」「小鲸鱼余额」「余额挂件」等，
// 所以「小鲸鱼余额挂件」会被「小鲸鱼余额」吃掉、直接打开本插件。必须用不撞任何 cmd 前缀的词：
// 这里传「鲸鱼余额挂件」（以「鲸」开头），实测能稳定落到市场搜索分支并搜到本插件。
// 若底座版本过旧不支持（返回 false），兜底用系统浏览器打开市场搜索页。
const MARKET_SEARCH_KEYWORD = '鲸鱼余额挂件'
function marketSearch() {
  const ok = props.services.redirectToMarket?.(MARKET_SEARCH_KEYWORD)
  if (!ok) props.services.openExternal?.('https://www.u-tools.cn/plugins/?keyword=' + encodeURIComponent(MARKET_SEARCH_KEYWORD))
}
</script>

<template>
  <section class="card" data-search="about">
    <h2>关于与更新</h2>
    <!-- 上游要求衍生版必须标注「个人衍生版」：既避免被误认成官方版，也说明售后归属 -->
    <p class="hint">本插件是 <strong>个人衍生版</strong>，移植自 <a href="#" @click.prevent="emit('doc', 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget')">MeteorNOX/DeepSeek-Balance-Whale-Widget</a>（MIT License）。<strong>非官方版本，与 DeepSeek、uTools 官方均无关联</strong>，无官方支持与售后 —— 上游作者不对本衍生版负责，问题请走下方反馈入口。</p>
    <label class="field row check">
      <span class="label">自动检查更新</span>
      <input type="checkbox" :checked="cfg.updateCheckOn" @change="emit('patch', { updateCheckOn: ($event.target as HTMLInputElement).checked })" />
    </label>
    <label class="field row">
      <span class="label">当前版本</span>
      <span class="ver">v{{ appVersion }}</span>
    </label>
    <div class="btn-row">
      <button class="secondary utils-btn utils-secondary" :disabled="updateChecking" @click="emit('check-update', true)">
        {{ updateChecking ? '检查中…' : '立即检查更新' }}
      </button>
      <button class="secondary utils-btn utils-secondary" @click="marketSearch">插件市场</button>
      <button class="secondary utils-btn utils-secondary" @click="openHomepage">项目主页</button>
    </div>
    <p v-if="updateMsg" class="msg" :class="[updateOk ? 'ok' : 'err', hasUpdate ? 'clickable' : '']"
       :title="hasUpdate ? '点击前往插件市场更新' : ''"
       @click="hasUpdate && marketSearch()">{{ updateMsg }}</p>
    <p class="hint">开启后每次呼出插件自动检查一次（12 小时内最多一次），发现新版本会弹出系统通知。</p>

    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" @click="aboutFolds.feedback = !aboutFolds.feedback">
        {{ aboutFolds.feedback ? '收起反馈与建议' : '反馈与建议' }}
      </button>
      <div v-if="aboutFolds.feedback" class="guide">
        <p class="hint">用得还顺手吗？想要的新功能、碰到的 bug，或者只是想吐槽两句，都欢迎告诉鲸鱼娘～可以去 <a href="#" @click.prevent="emit('doc', 'https://www.u-tools.cn/plugins/detail/%E5%B0%8F%E9%B2%B8%E9%B1%BC%E4%BD%99%E9%A2%9D%E6%8C%82%E4%BB%B6/')">插件市场详情页</a> 的「留言」区，也可以在 <a href="#" @click.prevent="emit('doc', 'https://github.com/Berge520/Balance-Whale-Widget/issues')">GitHub Issues</a> 里提，每条我都会认真看完，顺手给个五星好评就更开心啦 (๑•̀ㅂ•́)و✧</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）全部来自 main.css 的 :root。
   通用控件样式（.card / .field / .label / .ver / .msg / .hint / .guide 等）原本由 App.vue 的
   scoped 样式提供，组件拆分后 scoped 隔离掉了，这里按本组件用到的部分补齐一份。
   .btn-row 骨架与 utils 档位配色已在 main.css（单一来源），此处不再留副本。 */
.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  /* 点搜索命中标签滚到卡片时，吸顶的 .tab-bar 会盖住卡头；预留它的高度让卡顶落在下方 */
  scroll-margin-top: var(--tab-bar-h, 96px);
}
.card h2 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-dim);
}
.field {
  display: block;
  margin: 10px 0;
}
.field.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.field.check {
  justify-content: flex-start;
  /* 标签换行成多行时，复选框跟首行对齐 —— 居中对齐会飘到两行之间，看起来像对错了行 */
  align-items: flex-start;
}
.label {
  font-size: 13px;
  flex: 0 1 auto;
  min-width: 72px;
  overflow-wrap: anywhere;
}
.field.check .label {
  flex: 1 1 auto;
  min-width: 0;
  line-height: 1.5;
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
.ver {
  font-size: 13px;
  color: var(--fg-dim);
  min-width: 0;
  word-break: break-all;
}
.msg {
  margin: 10px 0 0;
  font-size: 12px;
}
.msg.ok {
  color: var(--ok);
}
.msg.err {
  color: var(--err);
}
/* 有新版本时结果行可点，直接去插件市场更新 */
.msg.clickable {
  cursor: pointer;
  text-decoration: underline;
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-faint);
  line-height: 1.6;
}
.hint a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.fold {
  margin-top: 12px;
}
.fold > .link-btn {
  margin-top: 0;
}
.guide {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--input-bg);
  font-size: 12px;
  line-height: 1.6;
}
</style>