<!--
 * 首次运行引导弹层：新装插件第一次打开设置页时弹出，引导填 DeepSeek 凭据（可跳过）。
 *
 * 为什么做成「组件 + 弹层」而不是往「数据」Tab 里加卡片：新装用户不知道该去哪个 Tab，
 * 引导要在他还没建立任何心智模型时就把最关键的一步（填 API Key）摆到眼前。
 *
 * 弹层外观照抄 SkinCropper / SoundTrimmer 那套 .overlay + .panel —— 项目里已有的全屏遮罩模式，
 * 不引入新样式体系。凭据的保存 / 测试不在本组件里实现，一律 emit 给 App.vue 复用既有逻辑，
 * 免得「引导里一份、数据 Tab 里一份」两处拼参数（历史上这种重复就漏过收件人）。
-->
<script setup lang="ts">
import { reactive, computed } from 'vue'

const props = defineProps<{
  // 已保存的凭据（用于回填）：跳过一次后再进设置页时仍显示上次填了一半的内容
  apiKey: string
  platformToken: string
  // 进入方式，与「窗口」Tab 的 cfg.enterMode 同值
  enterMode: string
  // 保存 / 测试进行中：禁用按钮，防连点
  saving: boolean
  testing: boolean
  // 测试结果（沿用设置页的 testResults 形状）
  testResults: Array<{ label: string; ok: boolean; msg: string }>
  // 保存后的回执文案（沿用设置页的 secretsFlash）
  flashMsg: string
  flashErr: boolean
}>()

const emit = defineEmits<{
  (e: 'save', payload: { apiKey: string; platformToken: string; enterMode: string }): void
  (e: 'test', payload: { apiKey: string; platformToken: string }): void
  (e: 'skip'): void
  (e: 'doc', url: string): void
}>()

// 表单是 props 的本地副本：用户没点「保存并开始使用」就不该改动设置页手里的值
const form = reactive({
  apiKey: props.apiKey,
  platformToken: props.platformToken,
  enterMode: props.enterMode,
  // 「如何获取」教程默认展开 API Key 那份 —— 引导场景下这是必填项，藏起来反而多一次点击
  guideApiKey: true,
  guideToken: false,
})

const canSubmit = computed(() => !props.saving && !props.testing)
const canTest = computed(() => canSubmit.value && !!(form.apiKey.trim() || form.platformToken.trim()))

function onSave() {
  if (!canSubmit.value) return
  emit('save', { apiKey: form.apiKey.trim(), platformToken: form.platformToken.trim(), enterMode: form.enterMode })
}
function onTest() {
  if (!canTest.value) return
  emit('test', { apiKey: form.apiKey.trim(), platformToken: form.platformToken.trim() })
}
</script>

<template>
  <div class="overlay">
    <div class="panel">
      <div class="head">
        <span class="title">欢迎使用小鲸鱼余额挂件</span>
      </div>
      <p class="lead">
        还差最后一步：填入 DeepSeek 的 <strong>API Key</strong>，挂件才能读到账户余额。
        也可以在下方先把「进入插件时」的行为定下来。不确定怎么弄就往下看教程，或直接跳过、以后在
        <strong>数据</strong> Tab 里再配。
      </p>

      <label class="field">
        <span class="label">API Key <em>（必填）</em></span>
        <input v-model="form.apiKey" type="password" placeholder="sk-..." autocomplete="off" />
      </label>
      <button class="link-btn" type="button" @click="form.guideApiKey = !form.guideApiKey">
        {{ form.guideApiKey ? '收起教程' : '如何获取 API Key？' }}
      </button>
      <div v-if="form.guideApiKey" class="guide2">
        <p class="guide-use"><strong>用途：</strong>读取账户余额，挂件显示余额必需（<strong>必填</strong>）。</p>
        <ol class="guide-steps">
          <li>登录 <a href="#" @click.prevent="emit('doc', 'https://platform.deepseek.com')">platform.deepseek.com</a>。</li>
          <li>左侧进「API keys」→「创建 API key」。</li>
          <li>复制 <code>sk-</code> 开头的密钥（仅完整显示一次）。</li>
          <li>粘贴到上方，点「保存并开始使用」。</li>
        </ol>
        <p class="guide-meta"><strong>保存与安全：</strong>存于本机 uTools 加密存储，仅本插件可读、不上传服务器；只随请求发往 <code>api.deepseek.com</code>，不写日志。</p>
        <p class="guide-note">注意：这是接口密钥，不是「平台 Token」；请勿泄露。</p>
      </div>

      <label class="field">
        <span class="label">平台 Token <em>（可选）</em></span>
        <input v-model="form.platformToken" type="password" placeholder="platform.deepseek.com 令牌" autocomplete="off" />
      </label>
      <button class="link-btn" type="button" @click="form.guideToken = !form.guideToken">
        {{ form.guideToken ? '收起教程' : '如何获取平台 Token？' }}
      </button>
      <div v-if="form.guideToken" class="guide2">
        <p class="guide-use"><strong>用途：</strong>可选。用于「实时·令牌」用量模式；不填则本地记账。</p>
        <ol class="guide-steps">
          <li>登录 <a href="#" @click.prevent="emit('doc', 'https://platform.deepseek.com')">platform.deepseek.com</a>，按 <code>F12</code> 打开 Network。</li>
          <li>刷新「用量」页，找到 <code>usage/by_api_key/amount</code> 请求。</li>
          <li>复制其 Request Headers 里 <code>Authorization</code> 的值（<code>Bearer eyJ...</code>）。</li>
          <li>粘贴到上方，点「保存并开始使用」。</li>
        </ol>
        <p class="guide-meta"><strong>保存与安全：</strong>同 API Key，本机加密存储、不上传服务器。它属网页会话令牌，重登后可能失效，届时自动回落本地记账。</p>
      </div>

      <label class="field row">
        <span class="label">进入插件时</span>
        <select v-model="form.enterMode">
          <option value="both">设置窗口 + 挂件</option>
          <option value="widget">只显示挂件</option>
          <option value="settings">只显示设置窗口</option>
        </select>
      </label>
      <p class="hint">决定每次呼出插件时先看到什么，之后可在「窗口」Tab 里改。</p>

      <p v-if="flashMsg" class="msg" :class="{ ok: !flashErr, err: flashErr }">{{ flashMsg }}</p>
      <div v-if="testResults.length" class="test-list">
        <div v-for="(r, i) in testResults" :key="i" class="test-item" :class="r.ok ? 'ok' : 'err'">
          <span class="test-icon">{{ r.ok ? '✓' : '✕' }}</span>
          <div class="test-body">
            <div class="test-label">{{ r.label }}</div>
            <div class="test-msg">{{ r.msg }}</div>
          </div>
        </div>
      </div>

      <div class="btn-row">
        <button type="button" :disabled="!canSubmit" @click="onSave">
          {{ saving ? '保存中…' : '保存并开始使用' }}
        </button>
        <button class="secondary" type="button" :disabled="!canTest" @click="onTest">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="secondary" type="button" :disabled="!canSubmit" @click="emit('skip')">跳过</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩 + 面板：与 SkinCropper.vue / SoundTrimmer.vue 逐字一致，保持项目内弹层观感统一 */
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
.lead {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.7;
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
  margin-top: 16px;
}
.label {
  font-size: 13px;
  flex: 0 1 auto;
  min-width: 72px;
  overflow-wrap: anywhere;
}
.field:not(.row) .label {
  display: block;
  margin-bottom: 4px;
}
.label em {
  font-style: normal;
  color: var(--fg-dim);
  font-size: 12px;
}
input,
select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border, rgba(83, 107, 169, 0.32));
  border-radius: 6px;
  background: var(--input-bg, #fff);
  color: inherit;
  font-size: 13px;
}
.field.row select {
  width: auto;
  flex: 1 1 auto;
}
.link-btn {
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--fg-dim);
  font-size: 12px;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.link-btn:hover {
  color: var(--fg);
}
.guide2 {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(83, 107, 169, 0.08);
  font-size: 12px;
  line-height: 1.7;
}
.guide-use,
.guide-meta,
.guide-note {
  margin: 0 0 6px;
}
.guide-meta,
.guide-note {
  color: var(--fg-dim);
}
.guide2 code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(83, 107, 169, 0.16);
  font-size: 11px;
}
.guide2 a {
  color: var(--accent);
}
.guide-steps {
  margin: 6px 0;
  padding-left: 18px;
}
.guide-steps li {
  margin-bottom: 2px;
}
.hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--fg-dim);
  line-height: 1.6;
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
.btn-row {
  display: flex;
  gap: 10px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.btn-row button {
  flex: 1;
  border-radius: 8px;
  font-size: 13px;
}
.btn-row button.secondary {
  background: rgba(83, 107, 169, 0.18);
  color: var(--accent);
}
.btn-row button:disabled {
  opacity: 0.45;
  cursor: default;
}
.test-list {
  margin-top: 10px;
}
.test-item {
  display: flex;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;
  line-height: 1.6;
}
.test-item.ok .test-icon {
  color: var(--ok);
}
.test-item.err .test-icon {
  color: var(--err);
}
.test-label {
  font-weight: 600;
}
.test-msg {
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}
</style>
