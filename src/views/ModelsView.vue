<script lang="ts" setup>
import { computed, reactive, ref } from 'vue'
import type { WhaleModel, WhaleModelRow, WhaleModelTemplate, WhaleServices } from '../types/services'

// 多厂商模型卡（余额 / 额度 / Codex 本地会话）。
// 抽自 App.vue：卡片自身的行内表单 / 展开态 / 删除确认 / 测试 / 刷新 / 增删改全内聚在此。
// 跨卡共享的运行时快照（models）、配置清单（modelConfigs）、主显示 id（modelsMainId）、
// 模板与上限、以及 fmtTokens / codexWinText 两个文案函数仍留父级，按 props 下传 ——
// 账号余额卡（余额卡的 model 候选与 mainModelId）与 Codex 心跳都在用，不复制副本。
const props = defineProps<{
  services: Partial<WhaleServices>
  // 宿主运行时快照行（含内置 DeepSeek 第一行），父级 reloadModels 取回后下传
  models: WhaleModelRow[]
  // 配置清单（不含余额），用于「是否已达上限」与编辑时查配置
  modelConfigs: WhaleModel[]
  // 主显示模型 id（父级持有：余额卡的 model 文案也读它）
  modelsMainId: string
  modelTpls: Record<string, WhaleModelTemplate>
  modelMax: number
  // 低余额预警阈值的按币种默认值（同宿主 constants.LOW_ALERT_BY_CURRENCY，父级留副本过 check-shared）
  lowAlertDefault: Record<string, number>
  // 跨卡共享的展示函数：token 数格式化、Codex 订阅窗口文案（模型列表行的 codex 行与 Codex 卡共用）
  fmtTokens: (n?: number) => string
  codexWinText: (w: any) => string
}>()

const emit = defineEmits<{
  (e: 'reload'): void
  (e: 'update:mainId', id: string): void
}>()

// 统一的消息态：与父级 App.vue 里的同名工具保持同一定义（内联一份，免父子透传 4 行工具）
type Flash = { msg: string; err: boolean }
function useFlash(): Flash { return reactive({ msg: '', err: false }) }
function msgCls(f: Flash) { return { ok: !f.err, err: f.err } }

const modelsFlash: Flash = useFlash()
// 正在测试的模型 id（'' = 空闲）：防连点，也让按钮能显示「测试中…」
const modelTesting = ref('')
const modelsRefreshing = ref(false)
// 展开编辑的行：NEW_MODEL_ROW = 新增草稿，其余为模型 id，'' = 全部收起
const modelOpen = ref('')
// 行内密钥输入框（不回显已存密钥，只表示「本次要改成什么」；留空 = 不改）
const modelKeys = reactive<Record<string, string>>({})
// 每行的「高级」折叠（字段路径等低频项默认收起）
const modelAdv = reactive<Record<string, boolean>>({})
// 行内编辑表单（modelOpen 非空时有值）与它的校验提示
const modelForm = ref<WhaleModel | null>(null)
const modelFormErr = ref('')
// 删除二次确认（与「数据与隐私」一致走行内确认条，不用 window.confirm）
const modelDelConfirm = ref('')
// 新增草稿的哨兵行 id：让草稿也走同一套行内表单，表单渲染逻辑不用写两份
const NEW_MODEL_ROW = '__new'
const modelRows = computed<WhaleModelRow[]>(() => {
  if (modelOpen.value !== NEW_MODEL_ROW) return props.models
  return props.models.concat([{
    id: NEW_MODEL_ROW, name: modelForm.value?.name || '新模型', kind: 'balance', currency: 'CNY',
    builtin: false, balance: null, todayUsage: null, usedPct: null, resetAt: 0, windows: null, at: 0,
    tokens: null, monthTokens: null, codexWindows: null,
    error: '', lowAlertOn: true, lowAlertAmount: 0,
  } as unknown as WhaleModelRow])
})
// 可选模板：内置 DeepSeek 已经占了列表第一行，不再作为可添加项（正在编辑的除外，否则下拉里没有当前值）
const modelTplOptions = computed(() => {
  const cur = modelForm.value ? modelForm.value.tpl : ''
  return Object.keys(props.modelTpls)
    .filter((k) => !props.modelTpls[k].builtin || k === cur)
    .map((k) => ({ key: k, name: props.modelTpls[k].name }))
})

// 按模板预填一份新条目（宿主 normModel 会对每个字段再清洗一次，这里只求「填得像样」）
function blankModel(tpl: string): WhaleModel {
  const t = props.modelTpls[tpl] || ({} as WhaleModelTemplate)
  const n = (v: number | undefined, d: number) => (typeof v === 'number' && isFinite(v) ? v : d)
  return {
    id: tpl, tpl: tpl,
    name: t.name || '',
    kind: t.kind || 'balance',
    currency: t.currency || 'CNY',
    auth: t.auth || 'bearer',
    url: t.url || '',
    baseUrl: '',
    path: t.path || '',
    scale: n(t.scale, 1),
    usedUrl: t.usedUrl || '',
    usedPath: t.usedPath || '',
    usedScale: n(t.usedScale, 1),
    usedPctPath: t.usedPctPath || '',
    remainPctPath: t.remainPctPath || '',
    remainPath: t.remainPath || '',
    totalPath: t.totalPath || '',
    resetPath: t.resetPath || '',
    // 多窗口额度只由模板预填（设置页不提供编辑）；显式写空数组，
    // 换模板时才能把上一个模板留下的窗口清掉
    windows: (t.windows || []).map((w) => ({ ...w })),
    lowAlertOn: true,
    lowAlertAmount: props.lowAlertDefault[t.currency === 'USD' ? 'USD' : 'CNY'],
  }
}
// 模型 id 是密钥槽位的键，必须唯一（用户看不见它，由这里保证）
function freeModelId(base: string) {
  const used = props.modelConfigs.map((m) => m.id)
  if (used.indexOf(base) < 0) return base
  for (let i = 2; i < 100; i++) {
    if (used.indexOf(base + '-' + i) < 0) return base + '-' + i
  }
  return base + '-' + Date.now().toString(36)
}
// 换模板 = 按新模板重新预填接口地址与字段路径（用户手填的路径会被覆盖，这是「换厂商」的预期）
function applyModelTpl() {
  const f = modelForm.value
  if (!f) return
  const t = props.modelTpls[f.tpl] || ({} as WhaleModelTemplate)
  const n = (v: number | undefined, d: number) => (typeof v === 'number' && isFinite(v) ? v : d)
  f.name = t.name || f.name
  f.kind = t.kind || 'balance'
  f.currency = t.currency || 'CNY'
  f.auth = t.auth || 'bearer'
  f.url = t.url || ''
  f.path = t.path || ''
  f.scale = n(t.scale, 1)
  f.usedUrl = t.usedUrl || ''
  f.usedPath = t.usedPath || ''
  f.usedScale = n(t.usedScale, 1)
  f.usedPctPath = t.usedPctPath || ''
  f.remainPctPath = t.remainPctPath || ''
  f.remainPath = t.remainPath || ''
  f.totalPath = t.totalPath || ''
  f.resetPath = t.resetPath || ''
  f.windows = (t.windows || []).map((w) => ({ ...w }))
  f.lowAlertAmount = props.lowAlertDefault[t.currency === 'USD' ? 'USD' : 'CNY']
  if (modelOpen.value === NEW_MODEL_ROW) {
    // 草稿行的 id 跟着模板走，免得「先按 OpenRouter 建、又改成 Kimi」留下对不上的 id
    const old = f.id
    f.id = freeModelId(f.tpl)
    if (modelKeys[old] !== undefined) { modelKeys[f.id] = modelKeys[old]; delete modelKeys[old] }
  }
}
function openModelRow(id: string) {
  modelFormErr.value = ''
  modelDelConfirm.value = ''
  if (modelOpen.value === id) { modelOpen.value = ''; return }
  const c = props.modelConfigs.find((m) => m.id === id)
  if (!c) return
  modelForm.value = JSON.parse(JSON.stringify(c)) as WhaleModel
  modelKeys[id] = ''
  modelOpen.value = id
}
function openNewModel() {
  modelsFlash.msg = ''
  modelsFlash.err = false
  modelFormErr.value = ''
  if (props.modelConfigs.length >= props.modelMax) {
    modelsFlash.err = true
    modelsFlash.msg = `最多添加 ${props.modelMax} 个模型，请先删掉不用的`
    return
  }
  const f = blankModel('openrouter')
  f.id = freeModelId(f.tpl)
  modelForm.value = f
  modelKeys[f.id] = ''
  modelOpen.value = NEW_MODEL_ROW
}
function closeModelForm() {
  modelOpen.value = ''
  modelForm.value = null
  modelFormErr.value = ''
}
function saveModelForm() {
  const f = modelForm.value
  if (!f) return
  modelFormErr.value = ''
  if (!String(f.name || '').trim()) { modelFormErr.value = '请填写名称'; return }
  // Codex 走本地会话统计，没有接口地址可填
  if (f.kind !== 'codex' && !String(f.url || '').trim()) { modelFormErr.value = '请填写接口地址'; return }
  const isNew = modelOpen.value === NEW_MODEL_ROW
  const typed = modelKeys[f.id] || ''
  try {
    // 编辑时密钥留空 = 不动已存的那把（传 undefined）；新增时必须传（空串 = 先存配置、后补密钥）
    const r = props.services.saveModel?.(f, isNew ? typed : (typed || undefined))
    if (!r || !r.ok) { modelFormErr.value = '保存失败：' + (r?.error || '宿主 API 不可用'); return }
    closeModelForm()
    emit('reload')
    modelsFlash.err = false
    modelsFlash.msg = '已保存'
  } catch (err: any) {
    modelFormErr.value = '保存失败：' + String(err?.message || err)
  }
}
async function testModelForm() {
  const f = modelForm.value
  if (!f) return
  modelFormErr.value = ''
  modelsFlash.msg = ''
  modelTesting.value = f.id
  try {
    // 密钥留空 = 用该模型已保存的那把（宿主会回落到密钥槽位）
    const r = await props.services.testModel?.(f, modelKeys[f.id] || '')
    if (!r) { modelFormErr.value = '宿主接口不可用'; return }
    if (!r.ok) { modelFormErr.value = '连接失败：' + (r.error || '未知错误'); return }
    modelsFlash.err = false
    if (typeof r.tokens === 'number') {
      modelsFlash.msg = `${f.name}：今日 ${props.fmtTokens(r.tokens)} token`
      return
    }
    const ws = r.windows
    modelsFlash.msg = typeof r.usedPct === 'number'
      ? (ws && ws.length > 1
        // 多窗口接口：逐窗口列出已用%，只报首个窗口会漏掉周/月额度
        ? `${f.name}：` + ws.map((w) => w.label + ' 已用 ' + w.usedPct + '%').join(' · ') + resetSuffix(r.resetAt)
        : `${f.name}：已用 ${r.usedPct}%${resetSuffix(r.resetAt)}`)
      : `${f.name}：余额 ${fmtModelMoney(r.balance, f.currency)}`
  } catch (err: any) {
    modelFormErr.value = '连接失败：' + String(err?.message || err)
  } finally {
    modelTesting.value = ''
  }
}
function resetSuffix(at?: number) {
  if (!at) return ''
  const d = new Date(at)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `，${d.getMonth() + 1}-${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())} 重置`
}
// 余额一律按原币种显示（与挂件口径一致，不折算汇率）
function fmtModelMoney(v: number | null | undefined, currency: string) {
  const num = Number(v)
  if (v === null || v === undefined || !isFinite(num)) return '—'
  return currency === 'USD' ? '$' + num.toFixed(2) : '¥ ' + num.toFixed(2)
}
// 列表里的余额/额度展示：额度类是百分比，Codex 是 token 数，余额类按原币种显示
function modelValueText(m: WhaleModelRow) {
  if (m.kind === 'quota') return typeof m.usedPct === 'number' ? '已用 ' + m.usedPct + '%' : '—'
  if (m.kind === 'codex') return typeof m.tokens === 'number' ? props.fmtTokens(m.tokens) : '—'
  return fmtModelMoney(m.balance, m.currency)
}
function modelSubText(m: WhaleModelRow) {
  if (m.error) return '查询失败：' + m.error
  if (m.kind === 'codex') {
    const base = typeof m.monthTokens === 'number' ? '今日 token · 本月 ' + props.fmtTokens(m.monthTokens) : ''
    // 订阅窗口（5h / 周）：与 Codex 卡片同一份文案，没有订阅时只有上面的 token 数
    const win = props.codexWinText(m.codexWindows)
    return win ? (base ? base + ' | ' + win : win) : base
  }
  if (m.kind === 'quota') {
    // 多窗口接口（OpenCode Go 的 5h/周/月、MiniMax 的 5h/周）：逐个列出，只显示首个窗口会漏掉周/月额度
    if (m.windows && m.windows.length > 1) {
      return m.windows.map((w) => w.label + ' ' + w.usedPct + '%').join(' · ') + resetSuffix(m.resetAt)
    }
    return m.resetAt ? resetSuffix(m.resetAt).replace(/^，/, '') : ''
  }
  if (typeof m.todayUsage === 'number') return '今日约 ' + fmtModelMoney(m.todayUsage, m.currency)
  if (m.at) {
    const d = new Date(m.at)
    return '更新于 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  return ''
}
function setMainModelRow(id: string) {
  modelsFlash.msg = ''
  const r = props.services.setMainModel?.(id)
  if (!r || !r.ok) {
    modelsFlash.err = true
    modelsFlash.msg = '切换主显示失败：' + (r?.error || '宿主 API 不可用')
    return
  }
  // 单选以宿主回值为准（它会把非法 id 回退成 DeepSeek）
  emit('update:mainId', r.mainModelId || id)
  modelsFlash.err = false
  modelsFlash.msg = id === 'deepseek' ? '挂件已切回 DeepSeek 余额' : '挂件主显示已切换'
}
async function refreshModelRows(ids?: string[]) {
  if (modelsRefreshing.value) return
  modelsRefreshing.value = true
  modelsFlash.msg = ''
  modelsFlash.err = false
  try {
    await props.services.refreshModels?.(ids && ids.length ? ids : null, true)
    emit('reload')
    modelsFlash.msg = '已刷新'
  } catch (err: any) {
    modelsFlash.err = true
    modelsFlash.msg = '刷新失败：' + String(err?.message || err)
  } finally {
    modelsRefreshing.value = false
  }
}
function removeModelRow(id: string) {
  const r = props.services.removeModel?.(id)
  if (!r || !r.ok) {
    modelsFlash.err = true
    modelsFlash.msg = '删除失败：' + (r?.error || '宿主 API 不可用')
    return
  }
  modelDelConfirm.value = ''
  if (modelOpen.value === id) closeModelForm()
  emit('reload')
  modelsFlash.err = false
  modelsFlash.msg = '已删除'
}

defineExpose({ closeModelForm })
</script>

<template>
  <section class="card" data-search="models">
    <div class="card-head">
      <h2>模型与余额</h2>
      <div class="head-actions">
        <button class="export-btn utils-btn utils-outline" :disabled="modelsRefreshing" @click="refreshModelRows()">
          {{ modelsRefreshing ? '刷新中…' : '刷新全部' }}
        </button>
        <button class="export-btn utils-btn utils-outline" :disabled="modelConfigs.length >= modelMax" @click="openNewModel">添加模型</button>
      </div>
    </div>
    <p class="hint">
      挂件默认显示 DeepSeek 余额；这里添加的厂商模型（{{ modelConfigs.length }}/{{ modelMax }}）可在挂件菜单里切换成主显示。
      余额按原币种展示、不折算汇率，只在本机查询；密钥用 uTools 加密存储，不写进备份文件。
    </p>
    <div class="mm-list">
      <div v-for="m in modelRows" :key="m.id" class="mm-item">
        <div v-if="m.id !== NEW_MODEL_ROW" class="mm-row">
          <input class="mm-radio" type="radio" name="mm-main" :value="m.id" :checked="modelsMainId === m.id"
                 :title="modelsMainId === m.id ? '当前挂件主显示' : '设为挂件主显示'"
                 @change="setMainModelRow(m.id)" />
          <span class="mm-name" :title="m.name">{{ m.name }}</span>
          <span class="mm-val" :class="{ 'mm-val-err': !!m.error }">{{ modelValueText(m) }}</span>
          <span class="mm-sub" :title="modelSubText(m)">{{ modelSubText(m) }}</span>
          <span v-if="m.builtin" class="mm-tag">内置</span>
          <template v-else>
            <button class="link-btn mm-act utils-btn utils-secondary" @click="openModelRow(m.id)">{{ modelOpen === m.id ? '收起' : '设置' }}</button>
            <button class="link-btn mm-act utils-btn utils-secondary" :disabled="modelsRefreshing" @click="refreshModelRows([m.id])">刷新</button>
            <button class="link-btn mm-act mm-del utils-btn utils-secondary"
                    @click="modelDelConfirm = modelDelConfirm === m.id ? '' : m.id">删除</button>
          </template>
        </div>
        <div v-if="m.id !== NEW_MODEL_ROW && modelDelConfirm === m.id" class="mm-confirm">
          <span>删除「{{ m.name }}」？它的密钥与余额记录会一并清除。</span>
          <button class="export-btn utils-btn utils-outline" @click="removeModelRow(m.id)">确认删除</button>
          <button class="link-btn mm-act utils-btn utils-secondary" @click="modelDelConfirm = ''">取消</button>
        </div>
        <!-- 行内编辑：新增草稿（NEW_MODEL_ROW）与编辑已有模型共用这一套表单 -->
        <div v-if="modelOpen === m.id && modelForm" class="mm-form">
          <div class="mm-grid">
            <label class="field">
              <span class="label">厂商模板</span>
              <select v-model="modelForm.tpl" @change="applyModelTpl">
                <option v-for="t in modelTplOptions" :key="t.key" :value="t.key">{{ t.name }}</option>
              </select>
            </label>
            <label class="field">
              <span class="label">名称</span>
              <input v-model="modelForm.name" maxlength="40" placeholder="挂件菜单里显示的名字" />
            </label>
            <label class="field">
              <span class="label">类型</span>
              <select v-model="modelForm.kind">
                <option value="balance">余额（金额）</option>
                <option value="quota">订阅额度（百分比）</option>
                <option value="codex">Codex 本地会话（token）</option>
              </select>
            </label>
            <label v-if="modelForm.kind !== 'codex'" class="field">
              <span class="label">币种</span>
              <select v-model="modelForm.currency">
                <option value="CNY">人民币 ¥</option>
                <option value="USD">美元 $</option>
              </select>
            </label>
          </div>
          <p v-if="modelForm.kind === 'codex'" class="hint">
            Codex 本地会话统计：读取本机 ~/.codex 下的会话日志（rollout JSONL）统计今日 token 用量，
            不需要 API Key、也不发网络请求。挂件上按今日 token 显示，点「测试连接」可立即统计一次。
          </p>
          <label v-if="modelForm.kind !== 'codex'" class="field">
            <span class="label">API Key <em>（留空 = 不改动已存的；本机加密存储）</em></span>
            <input v-model="modelKeys[modelForm.id]" type="password" placeholder="该厂商的 API Key" autocomplete="off" />
          </label>
          <label v-if="modelForm.kind !== 'codex'" class="field">
            <span class="label">接口地址</span>
            <input v-model="modelForm.url" placeholder="https://..." />
          </label>
          <label v-if="modelForm.kind !== 'codex' && (modelForm.url.indexOf('{base}') >= 0 || modelForm.baseUrl)" class="field">
            <span class="label">Base URL <em>（替换接口地址里的 {base}）</em></span>
            <input v-model="modelForm.baseUrl" placeholder="https://your-gateway.com" />
          </label>
          <label v-if="modelForm.kind === 'balance'" class="field">
            <span class="label">余额字段路径</span>
            <input v-model="modelForm.path" placeholder="data.available_balance" />
          </label>
          <label v-else-if="modelForm.kind === 'quota'" class="field">
            <span class="label">已用百分比字段路径</span>
            <input v-model="modelForm.usedPctPath" placeholder="data.limits[0].TOKENS_LIMIT.percentage" />
          </label>
          <label v-if="modelForm.kind === 'balance'" class="field">
            <span class="label">取值倍数 scale <em>（接口单位与展示单位不一致时用，如 0.0001）</em></span>
            <input class="num" type="number" step="any" min="0" v-model.number="modelForm.scale" />
          </label>
          <button v-if="modelForm.kind !== 'codex'" class="link-btn utils-btn utils-secondary" @click="modelAdv[modelForm.id] = !modelAdv[modelForm.id]">
            {{ modelAdv[modelForm.id] ? '收起高级设置' : '高级设置（字段路径 / 认证方式）' }}
          </button>
          <div v-if="modelAdv[modelForm.id] && modelForm.kind !== 'codex'" class="mm-grid">
            <label class="field">
              <span class="label">认证方式</span>
              <select v-model="modelForm.auth">
                <option value="bearer">Bearer（多数厂商）</option>
                <option value="raw">原始值（如智谱）</option>
              </select>
            </label>
            <template v-if="modelForm.kind === 'balance'">
              <label class="field">
                <span class="label">已用额度字段路径 <em>（余额 = 上面的余额 - 本项 × 倍数）</em></span>
                <input v-model="modelForm.usedPath" placeholder="data.total_usage" />
              </label>
              <label class="field">
                <span class="label">已用额度倍数</span>
                <input class="num" type="number" step="any" min="0" v-model.number="modelForm.usedScale" />
              </label>
              <label class="field">
                <span class="label">已用额度接口地址 <em>（留空 = 与余额同接口）</em></span>
                <input v-model="modelForm.usedUrl" placeholder="https://..." />
              </label>
            </template>
            <template v-else>
              <label class="field">
                <span class="label">剩余百分比字段路径</span>
                <input v-model="modelForm.remainPctPath" placeholder="model_remains[0].current_interval_remaining_percent" />
              </label>
              <label class="field">
                <span class="label">剩余量字段路径 <em>（与总量一起算百分比）</em></span>
                <input v-model="modelForm.remainPath" placeholder="usage.remaining" />
              </label>
              <label class="field">
                <span class="label">总量字段路径</span>
                <input v-model="modelForm.totalPath" placeholder="usage.limit" />
              </label>
            </template>
            <label class="field">
              <span class="label">重置时刻字段路径</span>
              <input v-model="modelForm.resetPath" placeholder="usage.resetTime" />
            </label>
          </div>
          <label v-if="modelForm.kind !== 'codex'" class="field row check">
            <span class="label">低余额提醒 <em>（低于阈值时弹系统通知，每模型每天一次；额度类看剩余百分比）</em></span>
            <input type="checkbox" v-model="modelForm.lowAlertOn" />
          </label>
          <label v-if="modelForm.kind !== 'codex' && modelForm.lowAlertOn" class="field row">
            <span class="label">提醒阈值</span>
            <input class="num" type="number" min="0" step="any" v-model.number="modelForm.lowAlertAmount" />
            <span class="num-text">{{ modelForm.currency === 'USD' ? '美元' : '元' }}</span>
          </label>
          <div class="btn-row">
            <button class="utils-btn utils-primary" @click="saveModelForm">保存</button>
            <button class="secondary utils-btn utils-secondary" :disabled="modelTesting === modelForm.id" @click="testModelForm">
              {{ modelTesting === modelForm.id ? '测试中…' : '测试连接' }}
            </button>
            <button class="secondary utils-btn utils-secondary" @click="closeModelForm">取消</button>
          </div>
          <p v-if="modelFormErr" class="msg err">{{ modelFormErr }}</p>
        </div>
      </div>
    </div>
    <p v-if="modelsFlash.msg" class="msg" :class="msgCls(modelsFlash)">{{ modelsFlash.msg }}</p>
  </section>
</template>

<style scoped>
/* 多厂商模型：每行 = 主显示单选 / 名称 / 余额 / 说明 / 操作，展开后是本行的编辑表单
   （原 app.css 的 .mm-* 副本随卡搬来：scoped 样式必须与渲染它的组件同处一个块） */
.mm-list {
  margin-top: 10px;
  padding-top: 4px;
  border-top: 1px dashed var(--line);
}
.mm-item {
  border-bottom: 1px dashed var(--line);
}
.mm-item:last-child {
  border-bottom: none;
}
.mm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
}
.mm-radio {
  flex: 0 0 auto;
  margin: 0;
  cursor: pointer;
}
.mm-name {
  flex: 0 0 150px;
  font-size: 12px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-val {
  flex: 0 0 96px;
  font-size: 12px;
  color: var(--fg);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.mm-val-err {
  color: var(--err);
}
.mm-sub {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-tag {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
}
/* 行内操作按钮：.link-btn 默认带上外边距与左对齐，这里按行内小按钮收一下 */
.mm-act {
  flex: 0 0 auto;
  margin-top: 0;
  font-size: 11px;
}
.mm-act:disabled {
  opacity: 0.45;
  cursor: default;
}
.mm-del {
  color: var(--err);
}
.mm-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 8px;
  font-size: 12px;
  color: var(--fg-dim);
}
.mm-form {
  padding: 2px 0 12px;
}
.mm-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
</style>
