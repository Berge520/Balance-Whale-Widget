<!--
 * 首次运行引导弹层：新装插件第一次打开设置页时弹出，引导填 DeepSeek 凭据（可跳过）。
 *
 * 为什么做成「组件 + 弹层」而不是往「数据」Tab 里加卡片：新装用户不知道该去哪个 Tab，
 * 引导要在他还没建立任何心智模型时就把最关键的一步（填 API Key）摆到眼前。
 *
 * 为什么拆成三步向导而不是一页长表单：一页里 API Key、平台 Token、教程、进入方式叠在一起，
 * 教程一展开就是几千像素，新装用户看到的是「填不完的表」而不是「还剩一步」。
 * 拆步后每屏只留一个动作：填 Key →（可测）→ 定进入方式，推进感来自顶部进度点。
 *
 * 手动重开（数据 Tab 里的「重新查看新手引导」）时传 reopen：文案与左上角副标题按「补配凭据」口径走，
 * 不再说「欢迎使用」，否则老用户会以为自己重装了一遍。
 *
 * 弹层外观照抄 SkinCropper / SoundTrimmer 那套 .overlay + .panel —— 项目里已有的全屏遮罩模式，
 * 不引入新样式体系。凭据的保存 / 测试不在本组件里实现，一律 emit 给 App.vue 复用既有逻辑，
 * 免得「引导里一份、数据 Tab 里一份」两处拼参数（历史上这种重复就漏过收件人）。
-->
<script setup lang="ts">
import { reactive, ref, computed } from 'vue'

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
  // 是否由「重新查看新手引导」手动打开（见文件头注释）
  reopen: boolean
}>()

const emit = defineEmits<{
  (e: 'save', payload: { apiKey: string; platformToken: string; enterMode: string }): void
  (e: 'test', payload: { apiKey: string; platformToken: string }): void
  (e: 'skip'): void
  (e: 'doc', url: string): void
}>()

// 表单是 props 的本地副本：用户没点「保存」就不该改动设置页手里的值
const form = reactive({
  apiKey: props.apiKey,
  platformToken: props.platformToken,
  enterMode: props.enterMode,
  // 教程默认收起：分步向导里这一步的主任务是「填 Key」，教程是备选路径，展开会重新变成一堵文字墙
  guideApiKey: false,
  guideToken: false,
})

// 0 = 填 Key，1 = 定进入方式，2 = 完成。只前进不后退：
// 回退没有实际意义（前面几步没有分支），少一套状态少一类 bug
const step = ref(0)

const canSubmit = computed(() => !props.saving && !props.testing)
const canTest = computed(() => canSubmit.value && !!(form.apiKey.trim() || form.platformToken.trim()))
const hasKey = computed(() => !!form.apiKey.trim())

// 已保存过凭据的用户重开引导时，Key 回填了也跟着走「欢迎」口径会显得错位，故用 reopen 区分标题
const title = computed(() => (props.reopen ? '配置 DeepSeek 凭据' : '欢迎使用小鲸鱼余额挂件'))
const steps = [
  { key: 'key', label: '填 API Key' },
  { key: 'enter', label: '进入方式' },
  { key: 'done', label: '完成' },
]

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
      <button class="close" type="button" title="关闭" @click="emit('skip')">×</button>

      <div class="head">
        <span class="title">{{ title }}</span>
        <span class="sub">{{ reopen ? '随时可以调完就关，不影响已保存的配置' : '三步就能用起来' }}</span>
      </div>

      <!-- 进度点：兼作当前步提示。不可点击 —— 前面没有分支，跳步只会让用户漏填 -->
      <ol class="steps">
        <li v-for="(s, i) in steps" :key="s.key" :class="{ on: i === step, past: i < step }">
          <span class="dot">{{ i < step ? '✓' : i + 1 }}</span>
          <span class="step-label">{{ s.label }}</span>
        </li>
      </ol>

      <!-- 第一步：API Key +（可选）平台 Token -->
      <template v-if="step === 0">
        <p class="lead">
          填入 DeepSeek 的 <strong>API Key</strong>，挂件才能读到账户余额。不知道去哪拿就展开下面的教程，
          或者先跳过、以后在<strong>数据</strong> Tab 里再配。
        </p>

        <label class="field">
          <span class="label">API Key <em>（必填）</em></span>
          <input v-model="form.apiKey" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false" />
        </label>
        <button class="link-btn utils-btn utils-secondary" type="button" @click="form.guideApiKey = !form.guideApiKey">
          {{ form.guideApiKey ? '收起教程' : '如何获取 API Key？' }}
        </button>
        <div v-if="form.guideApiKey" class="guide2">
          <ol class="guide-steps">
            <li>登录 <a href="#" @click.prevent="emit('doc', 'https://platform.deepseek.com')">platform.deepseek.com</a>。</li>
            <li>左侧进「API keys」→「创建 API key」。</li>
            <li>复制 <code>sk-</code> 开头的密钥（仅完整显示一次）。</li>
            <li>粘贴到上方，点「下一步」。</li>
          </ol>
          <p class="guide-meta"><strong>保存与安全：</strong>存于本机 uTools 加密存储，仅本插件可读、不上传服务器；只随请求发往 <code>api.deepseek.com</code>，不写日志。</p>
          <p class="guide-note">注意：这是接口密钥，不是「平台 Token」；请勿泄露。</p>
        </div>

        <label class="field">
          <span class="label">平台 Token <em>（可选）</em></span>
          <input v-model="form.platformToken" type="password" placeholder="platform.deepseek.com 令牌" autocomplete="off" spellcheck="false" />
        </label>
        <button class="link-btn utils-btn utils-secondary" type="button" @click="form.guideToken = !form.guideToken">
          {{ form.guideToken ? '收起教程' : '如何获取平台 Token？' }}
        </button>
        <div v-if="form.guideToken" class="guide2">
          <p class="guide-use"><strong>用途：</strong>用于「实时·令牌」用量模式；不填则在本地记账，不影响余额显示。</p>
          <ol class="guide-steps">
            <li>登录 <a href="#" @click.prevent="emit('doc', 'https://platform.deepseek.com')">platform.deepseek.com</a>，按 <code>F12</code> 打开 Network。</li>
            <li>刷新「用量」页，找到 <code>usage/by_api_key/amount</code> 请求。</li>
            <li>复制其 Request Headers 里 <code>Authorization</code> 的值（<code>Bearer eyJ...</code>）。</li>
            <li>粘贴到上方。</li>
          </ol>
          <p class="guide-meta"><strong>保存与安全：</strong>同 API Key，本机加密存储、不上传服务器。它属网页会话令牌，重登后可能失效，届时自动回落本地记账。</p>
        </div>
      </template>

      <!-- 第二步：进入方式 -->
      <template v-else-if="step === 1">
        <p class="lead">每次呼出插件时，先看到什么？选一个就行，之后可在「窗口」Tab 里随时改。</p>
        <div class="opts">
          <label v-for="o in [
            { v: 'both', t: '设置窗口 + 挂件', d: '两个都开，第一次装通常选这个' },
            { v: 'widget', t: '只显示挂件', d: '桌面上的小鲸鱼，不弹设置窗口' },
            { v: 'settings', t: '只显示设置窗口', d: '只调设置，不显示桌宠' },
          ]" :key="o.v" class="opt" :class="{ on: form.enterMode === o.v }">
            <input v-model="form.enterMode" type="radio" :value="o.v" />
            <span class="opt-body">
              <span class="opt-title">{{ o.t }}</span>
              <span class="opt-desc">{{ o.d }}</span>
            </span>
          </label>
        </div>
      </template>

      <!-- 第三步：回执 -->
      <template v-else>
        <p class="lead" :class="{ bad: !hasKey }">
          <template v-if="hasKey">配置已保存，挂件马上就能读到余额。桌面上的小鲸鱼就是它，点它会有菜单。</template>
          <template v-else>没有填 API Key，设置已保存，但挂件还读不到余额。可在<strong>数据</strong> Tab 里补上。</template>
        </p>
      </template>

      <p v-if="flashMsg" class="msg" :class="{ ok: !flashErr, err: flashErr }">{{ flashMsg }}</p>
      <!-- 测试结果横排并排：两项（API Key / 平台 Token）各自占一列，扫一眼就能对比，
           竖着堆会把「都成功」拉成两行、占掉弹层高度 -->
      <div v-if="testResults.length" class="test-list">
        <div v-for="(r, i) in testResults" :key="i" class="test-item" :class="r.ok ? 'ok' : 'err'">
          <span class="test-label">{{ r.label }}</span>
          <span class="test-msg">{{ r.msg }}</span>
          <span class="test-icon">{{ r.ok ? '✓' : '✕' }}</span>
        </div>
      </div>

      <div class="btn-row">
        <!-- 第一步：主按钮「下一步」；能测就顺手测，测不通不阻止继续（用户可能只想先存上） -->
        <template v-if="step === 0">
          <button class="utils-btn utils-primary" type="button" :disabled="!canSubmit" @click="step = 1">下一步</button>
          <button class="secondary utils-btn utils-secondary" type="button" :disabled="!canTest" @click="onTest">
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <button class="ghost utils-btn utils-outline" type="button" :disabled="!canSubmit" @click="emit('skip')">跳过</button>
        </template>

        <!-- 第二步：主按钮保存（保存即结束引导）。放这里而不是第三步，是为了「关掉窗口也不会丢配置」 -->
        <template v-else-if="step === 1">
          <button class="utils-btn utils-primary" type="button" :disabled="!canSubmit" @click="onSave">
            {{ saving ? '保存中…' : '保存并开始使用' }}
          </button>
          <button class="ghost utils-btn utils-outline" type="button" @click="step = 0">上一步</button>
        </template>

        <!-- 第三步：只收尾 -->
        <template v-else>
          <button class="utils-btn utils-primary" type="button" @click="emit('skip')">开始使用</button>
          <button class="ghost utils-btn utils-outline" type="button" @click="emit('skip')">关闭</button>
        </template>
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
  position: relative;
  width: 100%;
  max-width: 520px;
  max-height: 100%;
  overflow: auto;
  /* 引导内容高度随步骤变化，预留滚动条槽位免得每步布局横跳 */
  scrollbar-gutter: stable;
  padding: 20px;
  border-radius: 14px;
  background: var(--input-bg, #fff);
  color: var(--fg, #1f2a44);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.32);
}
.close {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(83, 107, 169, 0.14);
  color: var(--fg-dim);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.close:hover {
  background: rgba(83, 107, 169, 0.26);
  color: var(--fg);
}
.head {
  margin-bottom: 14px;
  padding-right: 30px;
}
.title {
  display: block;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.sub {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  color: var(--fg-dim);
}

/* 进度点：当前步高亮，已走过的打勾。轻量到不抢注意力，但让「还剩几步」一眼可见 */
.steps {
  display: flex;
  gap: 4px;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}
.steps li {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
}
.dot {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(83, 107, 169, 0.16);
  font-size: 11px;
}
.steps li.on {
  color: var(--fg);
  font-weight: 600;
}
.steps li.on .dot {
  background: var(--accent, #3b6ef5);
  color: #fff;
}
.steps li.past .dot {
  background: rgba(52, 168, 112, 0.2);
  color: var(--ok, #2e9e6b);
}
.step-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.lead {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--fg-dim);
}
.lead.bad {
  color: var(--err, #d9534f);
}
.field {
  display: block;
  margin: 12px 0 6px;
}
.label {
  display: block;
  margin-bottom: 5px;
  font-size: 13px;
}
.label em {
  font-style: normal;
  color: var(--fg-dim);
  font-size: 12px;
}
input[type='password'] {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border, rgba(83, 107, 169, 0.32));
  border-radius: 8px;
  background: var(--input-bg, #fff);
  color: inherit;
  font-size: 13px;
}
input[type='password']:focus {
  border-color: var(--accent, #3b6ef5);
  outline: none;
}

/* 进入方式：整块可点的单选卡，比下拉更直观（三项各自差别一句话说不清） */
.opts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.opt {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(83, 107, 169, 0.24));
  border-radius: 10px;
  cursor: pointer;
}
.opt:hover {
  border-color: rgba(83, 107, 169, 0.5);
}
.opt.on {
  border-color: var(--accent, #3b6ef5);
  background: rgba(59, 110, 245, 0.07);
}
.opt input {
  margin: 2px 0 0;
  flex: 0 0 auto;
}
.opt-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.opt-title {
  font-size: 13px;
  font-weight: 600;
}
.opt-desc {
  margin-top: 2px;
  font-size: 12px;
  color: var(--fg-dim);
}

/* 尺寸/配色走 utils 基类（markup 是 `class="link-btn utils-btn utils-secondary"`）。
   这里压一级 `button.link-btn`（0,1,1）盖掉全局 .link-btn 的下划线 ——
   全局 .link-btn 与 .utils-* 同为 (0,1,0) 且**注入更晚**（main.css 先于各 .vue），
   不压特异性的话下划线会漏出来。 */
button.link-btn {
  margin: 0;
  text-decoration: none;
  text-underline-offset: 0;
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
  margin: 0 0 6px;
  padding-left: 18px;
}
.guide-steps li {
  margin-bottom: 2px;
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
  margin-top: 18px;
}
/* 尺寸/配色走 main.css 的 utils 基类（markup 分别挂 .utils-btn，
   再按主/次/描边叠 .utils-primary / .utils-secondary / .utils-outline）。
   原先这里是独立一套：圆角 9px（全页唯一一档非 8px）、13px、靠 main.css 的
   line-height 2.5 撑高 —— 是全页"高矮胖瘦不一"的来源之一，已随统一收敛。 */
.btn-row button {
  flex: 1;
}
/* 跳过 / 上一步 / 关闭：弱化到「存在但不建议点」的层级，不和主按钮抢视线。
   叠 utils-outline 拿到描边档配色，再把下划线加回来 —— 「不抢视线」这个语义
   靠下划线表达，统一的是尺寸而非层级，所以这条要保留。 */
.btn-row button.ghost {
  flex: 0 0 auto;
  text-decoration: underline;
  text-underline-offset: 2px;
}
/* 两项并排；窄窗下自动换行，不把文案挤成竖排 */
.test-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
/* align-items 用 center 而非 baseline：两种字号（标签 12px 加粗、消息 11px）混排时，
   baseline 对齐会让短消息那格重心偏上、看着像没对齐 */
.test-item {
  display: flex;
  flex: 1 1 200px;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(83, 107, 169, 0.08);
}
.test-item.ok {
  background: rgba(52, 168, 112, 0.1);
}
.test-item.err {
  background: rgba(217, 83, 79, 0.1);
}
.test-item.ok .test-icon {
  color: var(--ok);
}
.test-item.err .test-icon {
  color: var(--err);
}
.test-label {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
}
/* 结果文案用省略号收尾而不是换行：换行会让两格的底色高度不等、右边那格被撑成两行
   （「连接成功 · 今日暂无用量记录」正是这种情况），并排的两格必须一样高才整齐 */
.test-msg {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.test-icon {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 700;
}
</style>
