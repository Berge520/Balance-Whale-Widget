<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue'

// 主窗 preload（services.js）注入的宿主 API
const services = (window as any).services || {}

// —— 密钥（加密存储） ——
const secrets = reactive({ apiKey: '', platformToken: '' })
const secretsMsg = ref('')
const secretsOk = ref(false)
const testing = ref(false)
const testResults = ref<Array<{ label: string; ok: boolean; msg: string }>>([])
const lastTestAt = ref(0)
const lastTestText = computed(() => {
  if (!lastTestAt.value) return ''
  const d = new Date(lastTestAt.value)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
})

// —— 挂件配置 ——
const cfg = reactive({
  scale: 1.5,
  scaleNum: 10,
  vol: 0.9,
  soundOn: true,
  soundSet: 'duck',
  usageMode: 'ledger',
  peakMode: 'default',
  bubbleOn: true,
  menuBtn: true,
  onTop: true,
  lowAlertOn: true,
  lowAlertAmount: 10,
  timeBubbleOn: true,
  updateCheckOn: true,
})
const widgetVisible = ref(true)
const widgetMsg = ref('')
const widgetErr = ref(false)

// —— 检查更新 ——
const appVersion = ref('')
const updateChecking = ref(false)
const updateResult = ref<any>(null)
const updateMsg = ref('')

// —— 近 7 天用量趋势 ——
const usageHistory = ref<Array<{ date: string; usage: number }>>([])
const usageCurrency = ref('CNY')
const historyMax = computed(() => {
  let m = 0
  for (const d of usageHistory.value) if (d.usage > m) m = d.usage
  return m
})
function dayLabel(date: string) {
  return date.slice(5).replace('-', '/')
}
function barHeight(u: number) {
  return historyMax.value > 0 ? Math.max(3, Math.round((u / historyMax.value) * 100)) : 0
}
function fmtMoney(v: number) {
  const num = Number(v) || 0
  return usageCurrency.value === 'CNY' ? '¥ ' + num.toFixed(2) : num.toFixed(2) + ' ' + usageCurrency.value
}

const MIN_SCALE = 0.6
const MAX_SCALE = 2.5
function scaleToNum(s: number) {
  return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1
}
function numToScale(n: number) {
  const v = Math.max(1, Math.min(20, Math.round(n)))
  return MIN_SCALE + (v - 1) * ((MAX_SCALE - MIN_SCALE) / 19)
}
function onScaleLive() {
  // 拖动中：实时改窗口几何（不写存储），避免高频保存卡顿
  const s = Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(cfg.scale))) * 10) / 10
  cfg.scale = s
  cfg.scaleNum = scaleToNum(s)
  services.saveConfig?.({ scale: s, __live: true })
}
function onScaleNumLive() {
  const s = numToScale(cfg.scaleNum)
  cfg.scale = s
  services.saveConfig?.({ scale: s, __live: true })
}
function onScaleCommit() {
  // 松手/失焦：一次性持久化并同步给挂件
  const s = Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(cfg.scale))) * 10) / 10
  cfg.scale = s
  cfg.scaleNum = scaleToNum(s)
  services.saveConfig?.({ scale: s })
}
function patchCfg(p: Record<string, any>) {
  services.saveConfig?.(p)
}

function saveSecrets() {
  const r = services.saveSecrets?.({ apiKey: secrets.apiKey.trim(), platformToken: secrets.platformToken.trim() })
  secretsOk.value = true
  secretsMsg.value = r && r.hasApiKey ? '已加密保存' : '已保存（未填写 API Key，挂件将提示未配置）'
  setTimeout(() => { secretsOk.value = false }, 3000)
}

async function testKey() {
  const key = secrets.apiKey.trim()
  const token = secrets.platformToken.trim()
  if (!key && !token) return
  testing.value = true
  testResults.value = []
  try {
    // API Key → 余额接口（api.deepseek.com）
    if (key) {
      if (!services.testApiKey) {
        testResults.value.push({ label: 'API Key', ok: false, msg: '宿主接口不可用' })
      } else {
        const r = await services.testApiKey(key)
        if (r && r.ok) {
          const cur = r.currency === 'CNY' ? '¥' : (r.currency || '')
          testResults.value.push({ label: 'API Key', ok: true, msg: `连接成功 · 当前余额 ${cur} ${Number(r.totalBalance).toFixed(2)}` })
        } else {
          testResults.value.push({ label: 'API Key', ok: false, msg: (r && r.error) || '未知错误' })
        }
      }
    }
    // 平台 Token → 用量接口（platform.deepseek.com）
    if (token) {
      if (!services.testPlatformToken) {
        testResults.value.push({ label: '平台 Token', ok: false, msg: '宿主接口不可用' })
      } else {
        const r = await services.testPlatformToken(token)
        if (r && r.amount !== undefined) {
          testResults.value.push({
            label: '平台 Token',
            ok: true,
            msg: r.empty
              ? '连接成功 · 今日暂无用量记录'
              : `连接成功 · 今日用量 ¥ ${Number(r.amount).toFixed(4)}（${Number(r.tokens || 0).toLocaleString()} tokens）`,
          })
        } else {
          testResults.value.push({ label: '平台 Token', ok: false, msg: (r && r.error) || '未知错误' })
        }
      }
    }
  } catch (err: any) {
    testResults.value.push({ label: '测试', ok: false, msg: String(err?.message || err) })
  } finally {
    testing.value = false
    lastTestAt.value = Date.now()
  }
}

function showWidget() {
  const r = services.showWidget?.() || { ok: true }
  widgetVisible.value = true
  if (r && r.ok && !r.error) {
    widgetErr.value = false
    // 开发模式才显示调试提示；正式打包（dist）只给普通确认
    widgetMsg.value = import.meta.env.DEV
      ? '挂件窗口已创建。若桌面看不到鲸鱼，请打开开发者工具（主窗右键→检查）查看 [whale][widget] 日志。'
      : '挂件窗口已创建。'
  } else {
    widgetErr.value = true
    widgetMsg.value = '挂件创建失败：' + ((r && r.error) || '未知错误')
      + (import.meta.env.DEV ? '（详见开发者工具控制台 [whale][widget] 日志）' : '')
  }
}
function hideWidget() {
  services.hideWidget?.()
  widgetVisible.value = false
  widgetMsg.value = ''
}
// 复制指令名，便于粘贴到 uTools「全局功能」新增全局快捷键
function copyHotkeyCmd() {
  const ok = services.copyText?.('显示/隐藏挂件')
  widgetErr.value = !ok
  widgetMsg.value = ok
    ? '已复制「显示/隐藏挂件」，粘贴到 uTools「全局功能」的指令框即可。'
    : '复制失败，请手动输入指令名：显示/隐藏挂件'
}
// 跳转 uTools「全局功能」并直接新增一条待绑定项（快捷键被删除后可用它重新添加）
// 注意：每次点击都会新增一条，uTools 无「只跳转不新增」的接口
function addHotkey() {
  const ok = services.redirectHotKeySetting?.('显示/隐藏挂件')
  widgetErr.value = !ok
  widgetMsg.value = ok
    ? '已跳转 uTools「全局功能」并新增一条待绑定项，按下组合键即可完成绑定。'
    : '跳转失败，请手动打开 uTools 设置 → 全局功能 添加。'
}

function doCheckUpdate(force: boolean) {
  if (!services.checkUpdate) return
  updateChecking.value = true
  updateMsg.value = ''
  Promise.resolve(services.checkUpdate(force))
    .then((r: any) => {
      updateResult.value = r || null
      if (!r || !r.ok) updateMsg.value = '检查失败：' + ((r && r.error) || '未知错误')
      else if (r.hasUpdate) updateMsg.value = '发现新版本 v' + r.latest + '，可前往项目主页查看'
      else updateMsg.value = '已是最新版本'
    })
    .catch((err: any) => {
      updateMsg.value = '检查失败：' + String(err?.message || err)
    })
    .finally(() => { updateChecking.value = false })
}
function openHomepage() {
  services.openExternal?.('https://github.com/Berge520/Balance-Whale-Widget')
}

onMounted(() => {
  try {
    const c = services.getConfig?.()
    if (c) {
      cfg.scale = c.scale
      cfg.scaleNum = scaleToNum(c.scale)
      cfg.vol = c.vol
      cfg.soundOn = c.soundOn !== false
      cfg.soundSet = c.soundSet
      cfg.usageMode = c.usageMode
      cfg.peakMode = c.peakMode
      cfg.bubbleOn = c.bubbleOn
      cfg.menuBtn = c.menuBtn !== false
      cfg.onTop = c.onTop !== false
      cfg.lowAlertOn = c.lowAlertOn !== false
      cfg.lowAlertAmount = typeof c.lowAlertAmount === 'number' ? c.lowAlertAmount : 10
      cfg.timeBubbleOn = c.timeBubbleOn !== false
    }
    const s = services.getSecrets?.()
    if (s) {
      secrets.apiKey = s.apiKey || ''
      secrets.platformToken = s.platformToken || ''
    }
    widgetVisible.value = services.isWidgetVisible?.() !== false
    appVersion.value = services.getVersion?.() || ''
    const h = services.getUsageHistory?.(7)
    if (h && Array.isArray(h.days)) {
      usageHistory.value = h.days
      usageCurrency.value = h.currency || 'CNY'
    }
  } catch (err) {}
  if (cfg.updateCheckOn) doCheckUpdate(false)
})
</script>

<template>
  <div class="page">
    <h1>🐳 小鲸鱼余额挂件</h1>
    <p class="sub">桌面透明置顶小窗 · 显示 DeepSeek 余额</p>

    <!-- 凭据 -->
    <section class="card">
      <h2>DeepSeek 凭据</h2>
      <label class="field">
        <span class="label">API Key</span>
        <input v-model="secrets.apiKey" type="password" placeholder="sk-..." autocomplete="off" />
      </label>
      <label class="field">
        <span class="label">平台 Token <em>（可选，「实时·令牌」用量模式需要）</em></span>
        <input v-model="secrets.platformToken" type="password" placeholder="platform.deepseek.com 令牌" autocomplete="off" />
      </label>
      <div class="btn-row">
        <button @click="saveSecrets">保存凭据（加密存储）</button>
        <button class="secondary" :disabled="testing || (!secrets.apiKey.trim() && !secrets.platformToken.trim())" @click="testKey">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
      </div>
      <p v-if="secretsMsg" class="msg ok">{{ secretsMsg }}</p>
      <div v-if="testResults.length" class="test-list">
        <div v-for="(r, i) in testResults" :key="i" class="test-item" :class="r.ok ? 'ok' : 'err'">
          <span class="test-icon">{{ r.ok ? '✓' : '✕' }}</span>
          <div class="test-body">
            <div class="test-label">{{ r.label }}</div>
            <div class="test-msg">{{ r.msg }}</div>
          </div>
        </div>
        <div v-if="lastTestText" class="test-time">上次测试 {{ lastTestText }}</div>
      </div>
    </section>

    <!-- 挂件设置 -->
    <section class="card">
      <h2>挂件设置</h2>

      <label class="field row">
        <span class="label">大小</span>
        <input class="range" type="range" min="0.6" max="2.5" step="0.1" v-model.number="cfg.scale"
               @input="onScaleLive" @change="onScaleCommit" />
        <input class="num" type="number" min="1" max="20" step="1" v-model.number="cfg.scaleNum"
               @input="onScaleNumLive" @change="onScaleCommit" />
      </label>

      <label class="field row check">
        <span class="label">音效开关</span>
        <input type="checkbox" v-model="cfg.soundOn" @change="patchCfg({ soundOn: cfg.soundOn })" />
      </label>

      <label class="field row">
        <span class="label">音色</span>
        <select v-model="cfg.soundSet" :disabled="!cfg.soundOn" @change="patchCfg({ soundSet: cfg.soundSet })">
          <option value="duck">小黄鸭</option>
          <option value="fx1">音效1</option>
        </select>
      </label>

      <label class="field row">
        <span class="label">音量</span>
        <input class="range" type="range" min="0" max="1" step="0.05" v-model.number="cfg.vol"
               :disabled="!cfg.soundOn" @input="patchCfg({ vol: cfg.vol })" />
        <span class="num-text">{{ Math.round(cfg.vol * 100) }}%</span>
      </label>

      <label class="field row">
        <span class="label">用量</span>
        <select v-model="cfg.usageMode" @change="patchCfg({ usageMode: cfg.usageMode })">
          <option value="ledger">小鲸鱼记账（推荐）</option>
          <option value="token">实时·令牌（需平台 Token）</option>
        </select>
      </label>

      <label class="field row">
        <span class="label">峰谷文案</span>
        <select v-model="cfg.peakMode" @change="patchCfg({ peakMode: cfg.peakMode })">
          <option value="default">默认（空闲/高峰）</option>
          <option value="liangwen">梁文峰谷</option>
          <option value="qiangqiang">!?强强?!</option>
        </select>
      </label>

      <label class="field row check">
        <span class="label">思考气泡</span>
        <input type="checkbox" v-model="cfg.bubbleOn" @change="patchCfg({ bubbleOn: cfg.bubbleOn })" />
      </label>

      <label class="field row check">
        <span class="label">小鲸鱼报时 <em>（气泡首行显示当前时间）</em></span>
        <input type="checkbox" v-model="cfg.timeBubbleOn" @change="patchCfg({ timeBubbleOn: cfg.timeBubbleOn })" />
      </label>

      <label class="field row check">
        <span class="label">挂件右上角菜单按钮</span>
        <input type="checkbox" v-model="cfg.menuBtn" @change="patchCfg({ menuBtn: cfg.menuBtn })" />
      </label>

      <label class="field row check">
        <span class="label">窗口置顶</span>
        <input type="checkbox" v-model="cfg.onTop" @change="patchCfg({ onTop: cfg.onTop })" />
      </label>

      <label class="field row check">
        <span class="label">低余额预警</span>
        <input type="checkbox" v-model="cfg.lowAlertOn" @change="patchCfg({ lowAlertOn: cfg.lowAlertOn })" />
      </label>

      <label v-if="cfg.lowAlertOn" class="field row">
        <span class="label">预警阈值</span>
        <input class="num" type="number" min="0" step="1" v-model.number="cfg.lowAlertAmount"
               @change="patchCfg({ lowAlertAmount: cfg.lowAlertAmount })" />
        <span class="num-text">元</span>
      </label>
    </section>

    <!-- 用量趋势 -->
    <section class="card">
      <h2>近 7 天用量</h2>
      <div v-if="historyMax > 0" class="chart">
        <div v-for="d in usageHistory" :key="d.date" class="bar-col">
          <div class="bar-val">{{ d.usage > 0 ? fmtMoney(d.usage) : '' }}</div>
          <div class="bar-track">
            <div class="bar" :style="{ height: barHeight(d.usage) + '%' }"></div>
          </div>
          <div class="bar-day">{{ dayLabel(d.date) }}</div>
        </div>
      </div>
      <p v-else class="hint">暂无用量记录（挂件运行并记账后自动显示）。</p>
    </section>

    <!-- 显隐 -->
    <section class="card">
      <h2>挂件窗口</h2>
      <div class="btn-row">
        <button @click="showWidget">显示挂件</button>
        <button class="secondary" @click="hideWidget">隐藏挂件</button>
      </div>
      <div class="btn-row">
        <button class="secondary" @click="copyHotkeyCmd">复制指令名</button>
        <button class="secondary" @click="addHotkey">新增快捷键</button>
      </div>
      <p v-if="widgetMsg" class="msg" :class="{ ok: !widgetErr, err: widgetErr }">{{ widgetMsg }}</p>
      <p class="hint">提示：挂件常驻桌面，可拖拽到屏幕四边吸附；贴左缘会镜像翻转。点击鲸鱼刷新余额，悬停后点右上角菜单可调整设置。</p>
      <p class="hint">设置快捷键：按 Ctrl+, 打开 uTools 设置 → 全局功能 → 新增 → 指令填「显示/隐藏挂件」→ 按下组合键。可点「复制指令名」快速复制；绑定被删除后，点「新增快捷键」可直接跳转重新添加。</p>
    </section>

    <!-- 关于与更新 -->
    <section class="card">
      <h2>关于与更新</h2>
      <label class="field row check">
        <span class="label">自动检查更新</span>
        <input type="checkbox" v-model="cfg.updateCheckOn" @change="patchCfg({ updateCheckOn: cfg.updateCheckOn })" />
      </label>
      <label class="field row">
        <span class="label">当前版本</span>
        <span class="ver">v{{ appVersion }}</span>
      </label>
      <div class="btn-row">
        <button class="secondary" :disabled="updateChecking" @click="doCheckUpdate(true)">
          {{ updateChecking ? '检查中…' : '立即检查更新' }}
        </button>
        <button class="secondary" @click="openHomepage">项目主页</button>
      </div>
      <p v-if="updateMsg" class="msg" :class="updateResult && updateResult.ok ? 'ok' : 'err'">{{ updateMsg }}</p>
      <p class="hint">开启后每次呼出插件自动检查一次（12 小时内最多一次），发现新版本会弹出系统通知。</p>
    </section>
  </div>
</template>

<style scoped>
.page {
  --fg: #1f2a44;
  --fg-dim: #536ba9;
  --fg-faint: #9fb0d9;
  --accent: #536ba9;
  --line: rgba(83, 107, 169, 0.4);
  --card-bg: rgba(127, 127, 127, 0.08);
  --card-border: rgba(127, 127, 127, 0.18);
  --track: rgba(83, 107, 169, 0.1);
  --ok: #2fa24c;
  --err: #e0433f;
  max-width: 560px;
  margin: 0 auto;
  padding: 22px 18px 44px;
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .page {
    --fg: #e8ecf5;
    --fg-dim: #9fb0d9;
    --fg-faint: #7f8db3;
    --accent: #8aa4e6;
    --line: rgba(255, 255, 255, 0.22);
    --card-bg: rgba(255, 255, 255, 0.06);
    --card-border: rgba(255, 255, 255, 0.12);
    --track: rgba(255, 255, 255, 0.08);
    --ok: #4ec46b;
    --err: #ff6b66;
  }
}
h1 {
  margin: 0 0 6px;
  font-size: 20px;
  letter-spacing: 0.3px;
}
.sub {
  margin: 0 0 18px;
  color: var(--fg-dim);
  font-size: 13px;
}
.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
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
}
.label {
  font-size: 13px;
  flex: 0 0 auto;
  min-width: 72px;
}
.field:not(.row) .label {
  display: block;
  margin-bottom: 5px;
}
.label em {
  font-style: normal;
  color: var(--fg-faint);
  font-size: 11px;
}
input[type='password'],
select {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
}
input[type='password']:focus,
select:focus,
.num:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(83, 107, 169, 0.18);
}
.field.row select {
  flex: 1;
}
.range {
  flex: 1;
  accent-color: var(--accent);
}
.num {
  width: 56px;
  padding: 5px 6px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
}
.num-text {
  width: 44px;
  text-align: right;
  font-size: 13px;
  color: var(--fg-dim);
}
.ver {
  font-size: 13px;
  color: var(--fg-dim);
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
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
  color: var(--accent);
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
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-faint);
  line-height: 1.6;
}
/* 测试连接结果 */
.test-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.test-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 11px;
  border-radius: 9px;
  border: 1px solid transparent;
  font-size: 12px;
  line-height: 1.5;
}
.test-item.ok {
  background: rgba(47, 162, 76, 0.1);
  border-color: rgba(47, 162, 76, 0.32);
}
.test-item.err {
  background: rgba(224, 67, 63, 0.1);
  border-color: rgba(224, 67, 63, 0.32);
}
.test-icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}
.test-item.ok .test-icon {
  background: var(--ok);
}
.test-item.err .test-icon {
  background: var(--err);
}
.test-body {
  flex: 1;
  min-width: 0;
}
.test-label {
  font-weight: 600;
}
.test-msg {
  color: var(--fg-dim);
  word-break: break-word;
}
.test-time {
  margin-top: 2px;
  font-size: 11px;
  color: var(--fg-faint);
  text-align: right;
}
/* 用量趋势 */
.chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding-top: 6px;
}
.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.bar-val {
  font-size: 10px;
  color: var(--fg-dim);
  white-space: nowrap;
  height: 14px;
}
.bar-track {
  width: 100%;
  height: 90px;
  display: flex;
  align-items: flex-end;
  background: var(--track);
  border-radius: 6px;
  overflow: hidden;
}
.bar {
  width: 100%;
  background: linear-gradient(180deg, #6f8ad6, var(--accent));
  border-radius: 6px 6px 0 0;
  transition: height 0.3s ease;
}
.bar-day {
  font-size: 10px;
  color: var(--fg-faint);
  white-space: nowrap;
}
</style>
