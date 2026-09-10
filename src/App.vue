<script lang="ts" setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { WhaleServices } from './types/services'

// 主窗 preload（services.js）注入的宿主 API
const services: Partial<WhaleServices> = window.services || {}

// —— 密钥（加密存储） ——
const secrets = reactive({ apiKey: '', platformToken: '' })
// 获取教程默认折叠，点「如何获取？」按钮才展开
const guides = reactive({ apiKey: false, token: false })
// 「挂件窗口」卡片的说明默认折叠，点标题才展开（help=使用说明，trouble=故障排查）
const widgetFolds = reactive({ help: false, trouble: false })
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
  peakRemindOn: true,
  bubbleOn: true,
  menuBtn: true,
  onTop: true,
  lowAlertOn: true,
  lowAlertAmount: 10,
  timeBubbleOn: true,
  updateCheckOn: true,
  dragLock: false,
  enterMode: 'both',
})
const widgetVisible = ref(true)
const widgetMsg = ref('')
const widgetErr = ref(false)
// 挂件错误查看：errDetail 为宿主记录的最后一条创建/加载错误，空串表示无错误
const errDetail = ref('')
const errMsg = ref('')
const errMsgErr = ref(false)
const clearConfirm = ref<'' | 'all' | 'keep'>('')
const dataMsg = ref('')
const dataErr = ref(false)
// 诊断日志：dev 下同步落盘（%TEMP%\whale-debug.log），插件进程被 uTools 结束也不丢
const diagMsg = ref('')
const diagErr = ref(false)
// 诊断日志入口只在 uTools 开发者模式（日志真正落盘）时出现，正式版不显示
const diagReady = !!services.isDev?.()

// —— 检查更新 ——
const appVersion = ref('')
const updateChecking = ref(false)
const updateResult = ref<any>(null)
const updateMsg = ref('')

// —— 近 7 天用量趋势 ——
const usageHistory = ref<Array<{ date: string; usage: number }>>([])
const usageCurrency = ref('CNY')
const exportMsg = ref('')
const exportErr = ref(false)
const importMsg = ref('')
const importErr = ref(false)
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
// 导出账本用量为 CSV（宿主弹系统保存框；用户取消时静默）
function exportUsageCsv() {
  exportMsg.value = ''
  exportErr.value = false
  try {
    const r = services.exportUsageCsv?.(usageHistory.value.length || 7)
    if (!r) {
      exportErr.value = true
      exportMsg.value = '导出失败：宿主 API 不可用'
    } else if (r.ok) {
      exportMsg.value = '已导出到：' + (r.path || '')
    } else if (!r.canceled) {
      exportErr.value = true
      exportMsg.value = '导出失败：' + (r.error || '未知错误')
    }
  } catch (err: any) {
    exportErr.value = true
    exportMsg.value = '导出失败：' + String(err?.message || err)
  }
}
// 导入账本用量 CSV（宿主弹系统打开框；合并后刷新趋势；用户取消时静默）
function importUsageCsv() {
  importMsg.value = ''
  importErr.value = false
  try {
    const r = services.importUsageCsv?.()
    if (!r) {
      importErr.value = true
      importMsg.value = '导入失败：宿主 API 不可用'
    } else if (r.ok) {
      const ignored = r.invalid ? '，忽略 ' + r.invalid + ' 行非法数据' : ''
      importMsg.value = `已导入 ${r.imported} 天${ignored}；账本现有 ${r.kept} 天（${r.from} ~ ${r.to}）`
      const h = services.getUsageHistory?.(7)
      if (h && Array.isArray(h.days)) {
        usageHistory.value = h.days
        usageCurrency.value = h.currency || usageCurrency.value
      }
    } else if (!r.canceled) {
      importErr.value = true
      importMsg.value = '导入失败：' + (r.error || '未知错误')
    }
  } catch (err: any) {
    importErr.value = true
    importMsg.value = '导入失败：' + String(err?.message || err)
  }
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
  checkWidgetError(true)
}
function hideWidget() {
  services.hideWidget?.()
  widgetVisible.value = false
  widgetMsg.value = ''
}
// 读取宿主记录的最后一条挂件创建失败原因；silent=true 时不显示「无错误」提示（用于自动检查）
function checkWidgetError(silent = false) {
  if (!silent) {
    errMsg.value = ''
    errMsgErr.value = false
  }
  try {
    const e = services.getWidgetError?.()
    errDetail.value = e || ''
    if (!silent && !e) errMsg.value = '当前没有记录到挂件错误。'
  } catch (err: any) {
    errDetail.value = ''
    if (!silent) {
      errMsgErr.value = true
      errMsg.value = '读取失败：' + String(err?.message || err)
    }
  }
}
function copyWidgetError() {
  const ok = services.copyText?.(errDetail.value)
  errMsgErr.value = !ok
  errMsg.value = ok ? '错误信息已复制到剪贴板。' : '复制失败，请手动选中上方文本复制。'
}
// 清除本地数据：需二次确认，避免误触。
// mode='all' 连凭据一起清除；mode='keep' 保留 API Key / 平台 Token。
function clearAllData(mode: 'all' | 'keep') {
  if (clearConfirm.value !== mode) {
    clearConfirm.value = mode
    dataMsg.value = ''
    dataErr.value = false
    return
  }
  clearConfirm.value = ''
  try {
    const keepSecrets = mode === 'keep'
    const r = services.clearAllData?.({ keepSecrets }) || { ok: false }
    dataErr.value = !(r && r.ok)
    dataMsg.value = r && r.ok
      ? (keepSecrets
          ? '已清除设置、账本、窗口位置与更新缓存，API Key / 平台 Token 已保留，并按默认配置重建挂件。'
          : '已清除全部本地数据（凭据、设置、账本、窗口位置、更新缓存），并按默认配置重建挂件。')
      : '清除失败：' + ((r && r.error) || '未知错误')
    if (r && r.ok) {
      cfg.dragLock = false
      cfg.enterMode = 'both'
      cfg.scale = 1.5
      cfg.scaleNum = scaleToNum(1.5)
      cfg.vol = 0.9
      cfg.soundOn = true
      cfg.soundSet = 'duck'
      cfg.usageMode = 'ledger'
      cfg.peakMode = 'default'
      cfg.bubbleOn = true
      cfg.menuBtn = true
      cfg.onTop = true
      cfg.lowAlertOn = true
      cfg.lowAlertAmount = 10
      cfg.timeBubbleOn = true
      cfg.updateCheckOn = true
      if (!keepSecrets) {
        secrets.apiKey = ''
        secrets.platformToken = ''
        secretsOk.value = false
      }
      usageHistory.value = []
    }
  } catch (err: any) {
    dataErr.value = true
    dataMsg.value = '清除失败：' + String(err?.message || err)
  }
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
// 复制诊断日志：uTools 结束插件进程会连带清空控制台，日志已同步落盘，可从文件取回
function copyDebugLog() {
  try {
    const r = services.getDebugLog?.()
    const text = (r && r.text) || ''
    if (!text) {
      diagErr.value = true
      diagMsg.value = '暂无可复制的日志：控制台日志仅在 uTools 开发者模式下落盘。'
      return
    }
    const ok = services.copyText?.(text)
    diagErr.value = !ok
    diagMsg.value = ok
      ? `已复制诊断日志末尾 ${text.split('\n').length} 行。文件：${(r && r.path) || ''}`
      : '复制失败，可点「打开日志文件」手动查看。'
  } catch (err: any) {
    diagErr.value = true
    diagMsg.value = '读取失败：' + String(err?.message || err)
  }
}
// 用系统默认程序打开日志文件，便于人工查看或另存
function openLogFile() {
  try {
    const r = services.openLogFile?.()
    diagErr.value = !(r && r.ok)
    diagMsg.value = r && r.ok
      ? '已用系统默认程序打开日志文件：' + (r.path || '')
      : '打开失败：' + ((r && r.path) ? r.path : '控制台日志仅在 uTools 开发者模式下落盘。')
  } catch (err: any) {
    diagErr.value = true
    diagMsg.value = '打开失败：' + String(err?.message || err)
  }
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
// 教程里的链接用系统浏览器打开，避免在插件窗口内导航
function openDoc(url: string) {
  services.openExternal?.(url)
}

// 用宿主返回的配置回填设置页各开关（首次进入与挂件菜单改动后的同步都走这里）
function applyConfig(c: any) {
  if (!c) return
  cfg.scale = c.scale
  cfg.scaleNum = scaleToNum(c.scale)
  cfg.vol = c.vol
  cfg.soundOn = c.soundOn !== false
  cfg.soundSet = c.soundSet
  cfg.usageMode = c.usageMode
  cfg.peakMode = c.peakMode
  cfg.peakRemindOn = c.peakRemindOn !== false
  cfg.bubbleOn = c.bubbleOn
  cfg.menuBtn = c.menuBtn !== false
  cfg.onTop = c.onTop !== false
  cfg.lowAlertOn = c.lowAlertOn !== false
  cfg.lowAlertAmount = typeof c.lowAlertAmount === 'number' ? c.lowAlertAmount : 10
  cfg.timeBubbleOn = c.timeBubbleOn !== false
  cfg.dragLock = c.dragLock === true
  cfg.enterMode = c.enterMode === 'widget' || c.enterMode === 'settings' ? c.enterMode : 'both'
}

// 宿主推送的配置变更订阅（挂件三点菜单改设置时，让本页开关同步）
let unsubConfig: (() => void) | undefined

onMounted(() => {
  try {
    applyConfig(services.getConfig?.())
    // 挂件菜单勾选/取消 → 宿主广播 → 刷新本页开关
    unsubConfig = services.onConfigChange?.(applyConfig)
    const s = services.getSecrets?.()
    if (s) {
      secrets.apiKey = s.apiKey || ''
      secrets.platformToken = s.platformToken || ''
    }
    widgetVisible.value = services.isWidgetVisible?.() !== false
    checkWidgetError(true)
    appVersion.value = services.getVersion?.() || ''
    const h = services.getUsageHistory?.(7)
    if (h && Array.isArray(h.days)) {
      usageHistory.value = h.days
      usageCurrency.value = h.currency || 'CNY'
    }
  } catch (err) {}
  if (cfg.updateCheckOn) doCheckUpdate(false)
})

onUnmounted(() => {
  try { unsubConfig?.() } catch (err) {}
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
      <button class="link-btn" @click="guides.apiKey = !guides.apiKey">
        {{ guides.apiKey ? '收起教程' : '如何获取 API Key？' }}
      </button>
      <div v-if="guides.apiKey" class="guide">
        <p class="guide-use"><strong>用途：</strong>读取账户余额，挂件显示余额必需（<strong>必填</strong>）。</p>
        <ol class="guide-steps">
          <li>登录 <a href="#" @click.prevent="openDoc('https://platform.deepseek.com')">platform.deepseek.com</a>。</li>
          <li>左侧进「API keys」→「创建 API key」。</li>
          <li>复制 <code>sk-</code> 开头的密钥（仅完整显示一次）。</li>
          <li>粘贴到上方，点「保存凭据」。</li>
        </ol>
        <p class="guide-meta"><strong>保存与安全：</strong>存于本机 uTools 加密存储，仅本插件可读、不上传服务器；只随请求发往 <code>api.deepseek.com</code>，不写日志。API Key 长期有效，泄露可在平台删旧 key 后换新。</p>
        <p class="guide-note">注意：这是接口密钥，不是「平台 Token」；请勿泄露。</p>
      </div>
      <label class="field">
        <span class="label">平台 Token <em>（可选，「实时·令牌」用量模式需要）</em></span>
        <input v-model="secrets.platformToken" type="password" placeholder="platform.deepseek.com 令牌" autocomplete="off" />
      </label>
      <button class="link-btn" @click="guides.token = !guides.token">
        {{ guides.token ? '收起教程' : '如何获取平台 Token？' }}
      </button>
      <div v-if="guides.token" class="guide">
        <p class="guide-use"><strong>用途：</strong>可选。用于「实时·令牌」用量模式；不填则本地记账。</p>
        <ol class="guide-steps">
          <li>登录 <a href="#" @click.prevent="openDoc('https://platform.deepseek.com')">platform.deepseek.com</a>，按 <code>F12</code> 打开 Network。</li>
          <li>刷新「用量」页，找到 <code>usage/by_api_key/amount</code> 请求。</li>
          <li>复制其 Request Headers 里 <code>Authorization</code> 的值（<code>Bearer eyJ...</code>）。</li>
          <li>粘贴到上方，点「保存凭据」。</li>
        </ol>
        <p class="guide-meta"><strong>保存与安全：</strong>同 API Key，本机加密存储、不上传服务器；只随请求发往 <code>platform.deepseek.com</code>。它属网页会话令牌，重登后可能失效，届时自动回落本地记账，重新复制一次即可。</p>
      </div>
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
        <span class="label">峰谷切换提醒 <em>（进入峰/谷时段时气泡提示，需开启思考气泡）</em></span>
        <input type="checkbox" v-model="cfg.peakRemindOn" @change="patchCfg({ peakRemindOn: cfg.peakRemindOn })" />
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
        <span class="label">锁定位置 <em>（禁止拖拽与滚轮缩放，点击刷新仍可用）</em></span>
        <input type="checkbox" v-model="cfg.dragLock" @change="patchCfg({ dragLock: cfg.dragLock })" />
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
      <div class="card-head">
        <h2>近 7 天用量</h2>
        <div class="head-actions">
          <button class="export-btn" @click="importUsageCsv">导入 CSV</button>
          <button class="export-btn" :disabled="historyMax <= 0" @click="exportUsageCsv">导出 CSV</button>
        </div>
      </div>
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
      <p v-if="exportMsg" class="msg" :class="{ ok: !exportErr, err: exportErr }">{{ exportMsg }}</p>
      <p v-if="importMsg" class="msg" :class="{ ok: !importErr, err: importErr }">{{ importMsg }}</p>
    </section>

    <!-- 显隐 -->
    <section class="card">
      <h2>挂件窗口</h2>
      <label class="field row">
        <span class="label">进入插件时</span>
        <select v-model="cfg.enterMode" @change="patchCfg({ enterMode: cfg.enterMode })">
          <option value="both">设置窗口 + 挂件</option>
          <option value="widget">只显示挂件</option>
          <option value="settings">只显示设置窗口</option>
        </select>
      </label>
      <div class="btn-row">
        <button @click="showWidget">显示挂件</button>
        <button class="secondary" @click="hideWidget">隐藏挂件</button>
      </div>
      <div class="btn-row">
        <button class="secondary" @click="copyHotkeyCmd">复制指令名</button>
        <button class="secondary" @click="addHotkey">新增快捷键</button>
      </div>
      <div v-if="errDetail" class="err-block">
        <p class="err-title">挂件窗口创建失败</p>
        <pre class="err-box">{{ errDetail }}</pre>
        <div class="btn-row">
          <button class="secondary" @click="copyWidgetError">复制错误信息</button>
          <button class="secondary" @click="checkWidgetError()">重新检查</button>
        </div>
      </div>
      <button v-else class="link-btn" @click="checkWidgetError()">挂件异常？查看错误详情</button>
      <p v-if="widgetMsg" class="msg" :class="{ ok: !widgetErr, err: widgetErr }">{{ widgetMsg }}</p>
      <p v-if="errMsg" class="msg" :class="{ ok: !errMsgErr, err: errMsgErr }">{{ errMsg }}</p>
      <div class="fold">
        <button class="link-btn" @click="widgetFolds.help = !widgetFolds.help">{{ widgetFolds.help ? '收起使用说明' : '使用说明' }}</button>
        <div v-if="widgetFolds.help" class="guide">
          <p class="guide-use"><strong>进入插件时：</strong>选含挂件的模式后，挂件出现时会抢走焦点、本设置窗口自动收起；改设置请点挂件右上角菜单（或右键）→「打开设置」唤回本窗口。</p>
          <p class="guide-use"><strong>挂件操作：</strong>可拖拽到屏幕四边吸附，贴左缘会镜像翻转；点击鲸鱼刷新余额，悬停后点右上角菜单调整设置。</p>
          <p class="guide-use"><strong>快捷键：</strong>按 Ctrl+, 打开 uTools 设置 → 全局功能 → 新增 → 指令填「显示/隐藏挂件」→ 按下组合键。可点上方「复制指令名」快速复制。</p>
          <p class="guide-use"><strong>常驻：</strong>退出到后台挂件保留；关闭 Ctrl+D 分离窗口会直接结束插件运行、挂件消失，分离后请用「最小化」；重进插件会自动重建，配置不丢。</p>
        </div>
      </div>
      <div v-if="diagReady" class="fold">
        <button class="link-btn" @click="widgetFolds.trouble = !widgetFolds.trouble">{{ widgetFolds.trouble ? '收起故障排查' : '故障排查' }}</button>
        <div v-if="widgetFolds.trouble" class="guide">
          <p class="guide-use">挂件消失或显示异常时，可复制诊断日志（仅 uTools 开发者模式下落盘）或用系统程序打开日志文件。</p>
          <div class="btn-row">
            <button class="secondary" @click="copyDebugLog">复制诊断日志</button>
            <button class="secondary" @click="openLogFile">打开日志文件</button>
          </div>
          <p v-if="diagMsg" class="msg" :class="{ ok: !diagErr, err: diagErr }">{{ diagMsg }}</p>
        </div>
      </div>
    </section>

    <!-- 数据与隐私 -->
    <section class="card">
      <h2>数据与隐私</h2>
      <p class="hint">API Key 与平台 Token 通过 uTools 加密存储，账本与窗口位置也只保存在本机，不会上传到任何第三方服务器。</p>
      <p class="hint">注意：卸载 uTools 插件不会自动删除上述数据，如需彻底清除请点下方按钮。</p>
      <div class="btn-row">
        <button class="danger" @click="clearAllData('all')">{{ clearConfirm === 'all' ? '确认清除？不可恢复' : '清除全部数据' }}</button>
        <button class="secondary" @click="clearAllData('keep')">{{ clearConfirm === 'keep' ? '确认清除？保留凭据' : '清除数据（保留凭据）' }}</button>
        <button v-if="clearConfirm" class="secondary" @click="clearConfirm = ''">取消</button>
      </div>
      <p v-if="dataMsg" class="msg" :class="{ ok: !dataErr, err: dataErr }">{{ dataMsg }}</p>
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
      <p class="hint">用得还顺手吗？想要的新功能、碰到的 bug，或者只是想吐槽两句，都欢迎告诉鲸鱼娘～可以去 <a href="#" @click.prevent="openDoc('https://www.u-tools.cn/plugins/detail/%E5%B0%8F%E9%B2%B8%E9%B1%BC%E4%BD%99%E9%A2%9D%E6%8C%82%E4%BB%B6/')">插件市场详情页</a> 的「留言」区，也可以在 <a href="#" @click.prevent="openDoc('https://github.com/Berge520/Balance-Whale-Widget/issues')">GitHub Issues</a> 里提，每条我都会认真看完，顺手给个五星好评就更开心啦 (๑•̀ㅂ•́)و✧</p>
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
  --input-bg: #ffffff;
  --ok: #2fa24c;
  --err: #e0433f;
  /* 让原生控件（下拉列表、复选框等）跟随本页主题，否则深色模式下
     下拉展开的选项会用系统浅色底 + 本页浅色字，导致文字看不清 */
  color-scheme: light;
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
    --input-bg: #2b3145;
    --ok: #4ec46b;
    --err: #ff6b66;
    color-scheme: dark;
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
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.card-head h2 {
  margin: 0;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.export-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}
.export-btn:disabled {
  opacity: 0.45;
  cursor: default;
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
  background: var(--input-bg);
  color: var(--fg);
}
/* 下拉展开后的选项：必须显式给出背景与文字色。
   否则深色模式下选项文字（浅色）会落在系统浅色弹层上，完全看不清。 */
select option {
  background: var(--input-bg);
  color: var(--fg);
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
.btn-row button.danger {
  background: rgba(224, 67, 63, 0.16);
  color: var(--err);
}
.btn-row button:disabled {
  opacity: 0.45;
  cursor: default;
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
.link-btn {
  margin-top: 10px;
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
/* 凭据获取教程（默认折叠） */
.field + .link-btn {
  margin-top: -4px;
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
.guide-use {
  margin: 0;
  color: var(--fg);
}
.guide-use + .guide-use {
  margin-top: 6px;
}
/* 折叠面板里的首个标题紧贴顶部，不额外留白 */
.guide > .link-btn:first-child {
  margin-top: 0;
}
/* 分组折叠（使用说明 / 故障排查）：组间留白并用分隔线隔开 */
.fold {
  margin-top: 12px;
}
.fold > .link-btn {
  margin-top: 0;
}
.fold + .fold {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.guide-steps {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--fg);
}
.guide-steps li {
  margin-bottom: 4px;
}
.guide-steps li:last-child {
  margin-bottom: 0;
}
.guide-note {
  margin: 8px 0 0;
  color: var(--fg-dim);
}
/* 保存位置 / 安全性 / 可靠性：与「注意」同色，但行距更紧凑 */
.guide-meta {
  margin: 6px 0 0;
  color: var(--fg-dim);
}
.guide code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.18);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  word-break: break-all;
}
.guide a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.err-block {
  margin-top: 10px;
}
.err-title {
  margin: 0;
  color: var(--err);
  font-size: 12px;
}
.err-box {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--err);
  background: rgba(224, 67, 63, 0.08);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
  user-select: text;
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
