<script lang="ts" setup>
import { computed, reactive, ref } from 'vue'
import type { BackupPreviewResult, WhaleServices } from '../types/services'

// 备份与恢复整卡：状态 / 交互（导出、选择文件、勾选恢复项、恢复）全部内聚在本组件，
// 从设置页 App.vue 抽出。唯一的对外出口是「恢复成功」——恢复后的页面回显刷新
// （设置回填 / 账本重读 / 凭据回填）要读父级的全局状态，故用 emit('applied') 交回父级执行。
// 父级用 v-if="cardOn('data', 'backup')" 控制显隐；本卡不读写 cfg，故不接 cfg。
const props = defineProps<{
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局
  services: Partial<WhaleServices>
}>()
const emit = defineEmits<{
  (e: 'applied', applied: string[]): void
}>()

// 统一的消息态：msg=文案、err=是否错误态；模板用 msgCls(f) 生成 class。
// 与父级 App.vue 里的同名工具保持同一定义（原为全页共享，这里内联一份，
// 免得一个 4 行的 class 工具也要父子透传）
type Flash = { msg: string; err: boolean }
function useFlash(): Flash { return reactive({ msg: '', err: false }) }
function msgCls(f: Flash) { return { ok: !f.err, err: f.err } }

const backupWithSecrets = ref(false)
// 气泡图素材：与凭据一样默认不导出 —— 图片是二进制，base64 内嵌会让 JSON 备份膨胀到几十 MB；
// 只想带走「设置 + 账本」的用户不该被拖累。勾了才把配图一起装进 JSON（见 backup.js）
const backupWithBubbles = ref(false)
const backupPassword = ref('')
const backupBusy = ref(false)
const backupFlash: Flash = useFlash()
const backupConfirm = ref(false)
const backupPreview = ref<BackupPreviewResult | null>(null)
const backupPicks = reactive<Record<string, boolean>>({ config: true, ledger: true, window: true, timer: true, holidays: true, bubbles: true, secrets: true })
const backupItems: Array<{ key: string; label: string; note: string }> = [
  { key: 'config', label: '挂件设置', note: '（同名覆盖；含按压气泡的文案与开关）' },
  { key: 'ledger', label: '账本用量记录', note: '（同日覆盖，保留最近 30 天）' },
  { key: 'window', label: '窗口位置', note: '（恢复后挂件重建一次）' },
  { key: 'timer', label: '计时状态', note: '（重载插件后恢复）' },
  { key: 'holidays', label: '节假日表', note: '（联网更新的覆盖层，未更新过则无此项）' },
  { key: 'bubbles', label: '气泡图素材', note: '（按压气泡导入的自定义配图；导出时勾选「包含气泡图素材」才带）' },
  { key: 'secrets', label: '凭据', note: '（API Key / 平台 Token / SMTP 密码，用备份密码解密）' },
]
const backupHas = (key: string) => !!backupPreview.value?.has?.[key as 'config']
const backupAnyItem = computed(() => backupItems.some((it) => backupPicks[it.key] && backupHas(it.key)))
const backupItemLabel = (key: string) => (backupItems.find((i) => i.key === key) || { label: key }).label
const backupNames = (list?: string[]) => (list || []).map(backupItemLabel).join('、')
function backupExport() {
  if (backupBusy.value) return
  backupBusy.value = true
  backupFlash.msg = ''
  backupFlash.err = false
  try {
    const r = props.services.backupExport?.({ secrets: backupWithSecrets.value, bubbles: backupWithBubbles.value, password: backupPassword.value })
    if (!r || (!r.ok && !r.canceled)) {
      backupFlash.err = true
      backupFlash.msg = '导出失败：' + ((r && r.error) || '未知错误')
    } else if (r.canceled) {
      backupFlash.msg = '已取消导出'
    } else {
      backupPassword.value = '' // 密码不留在内存/界面上
      const parts: string[] = []
      parts.push(r.withSecrets ? '含加密凭据' : '不含凭据')
      if (r.bubbles) parts.push('含 ' + r.bubbles + ' 张气泡图')
      backupFlash.msg = '已导出备份：' + r.path + '（' + parts.join('，') + '）'
    }
  } catch (err: any) {
    backupFlash.err = true
    backupFlash.msg = '导出失败：' + String(err?.message || err)
  } finally {
    backupBusy.value = false
  }
}
function backupPick() {
  if (backupBusy.value) return
  backupBusy.value = true
  backupFlash.msg = ''
  backupFlash.err = false
  backupConfirm.value = false
  backupPreview.value = null
  try {
    const r = props.services.backupPick?.()
    if (!r || (!r.ok && !r.canceled)) {
      backupFlash.err = true
      backupFlash.msg = '读取失败：' + ((r && r.error) || '未知错误')
    } else if (r.canceled) {
      backupFlash.msg = '已取消导入'
    } else {
      backupPreview.value = r as BackupPreviewResult
      backupItems.forEach((it) => { backupPicks[it.key] = backupHas(it.key) })
      backupFlash.msg = '已读取备份，请勾选要恢复的项，再点「恢复选中项」'
    }
  } catch (err: any) {
    backupFlash.err = true
    backupFlash.msg = '读取失败：' + String(err?.message || err)
  } finally {
    backupBusy.value = false
  }
}
function backupApply() {
  if (backupBusy.value || !backupAnyItem.value) return
  if (!backupConfirm.value) {
    backupConfirm.value = true
    backupFlash.msg = ''
    backupFlash.err = false
    return
  }
  backupConfirm.value = false
  backupBusy.value = true
  try {
    const r = props.services.backupApply?.({
      config: backupPicks.config, ledger: backupPicks.ledger, window: backupPicks.window,
      timer: backupPicks.timer, holidays: backupPicks.holidays, bubbles: backupPicks.bubbles,
      secrets: backupPicks.secrets, password: backupPassword.value,
    })
    const applied = (r && r.applied) || []
    if (!r || !r.ok) {
      backupFlash.err = true
      backupFlash.msg = '恢复失败：' + ((r && (r.errors || [])[0]) || (r && r.error) || '未知错误')
    } else {
      let msg = '已恢复：' + backupNames(applied) + '。'
      if (r.skipped && r.skipped.length) msg += '备份里没有：' + backupNames(r.skipped) + '。'
      if (r.widgetRebuilt) msg += '挂件已按恢复的设置重建。'
      backupFlash.err = false
      if (r.errors && r.errors.length) { msg += r.errors.join('；'); backupFlash.err = true }
      backupPassword.value = ''
      backupPreview.value = null
      backupFlash.msg = msg
      // 让页面回显跟上：设置 / 账本 / 凭据分别刷新 —— 三处都读父级的全局状态，交回父级做
      emit('applied', applied)
    }
  } catch (err: any) {
    backupFlash.err = true
    backupFlash.msg = '恢复失败：' + String(err?.message || err)
  } finally {
    backupBusy.value = false
  }
}
function backupCancelPick() {
  backupPreview.value = null
  backupConfirm.value = false
  backupFlash.msg = ''
  try { props.services.backupCancel?.() } catch (err) {}
}

// 卡级折叠：本卡正文很长（一段安全说明 + 两个导出勾选 + 导出/导入按钮 + 导入预览区），
// 日常只在「导出/导入」时才展开；默认展开但可收起，收起后标题栏摘要播报是否有待恢复的预览
const cardFold = reactive({ open: true })
const cardSummary = computed(() => backupPreview.value ? '已读取备份，待恢复' : '导出 / 导入 JSON 备份')
</script>

<template>
  <!-- [数据] 备份与恢复。原先折在「数据与隐私」卡的 .fold 里，但「数据」组 desc 一直把它
       当并列的第三张卡来写（「凭据设置 · 清除数据 · 备份与恢复」），搜索索引里也没提它 ——
       即 desc 承诺是卡、实际是别人卡里的折叠。提升为独立卡，三者对齐；也更好找。
       根元素即 .card：父级 v-if 控显隐，data-search 供搜索滚动锚点定位。 -->
  <section class="card" data-search="backup">
    <div class="card-head">
      <h2 class="card-toggle" @click="cardFold.open = !cardFold.open">
        <span class="caret">{{ cardFold.open ? '▾' : '▸' }}</span>备份与恢复
        <span v-if="!cardFold.open" class="card-sum">{{ cardSummary }}</span>
      </h2>
    </div>
    <template v-if="cardFold.open">
    <p class="hint">把「挂件设置 / 账本 / 窗口位置 / 计时 / 节假日表」打包成一个 JSON 文件；<strong>不含</strong> dsh 开发者配置与已导入的形象 / 音效素材（这几类可用「资源」页的素材包单独导出）。<strong>凭据默认不导出</strong>，勾选「包含凭据」后必须设密码，凭据（API Key / 平台 Token / SMTP 密码）会用 scrypt + AES-256-GCM 加密后才写入文件（文件里没有明文）。<strong>按压气泡</strong>的文字与开关随「挂件设置」一起备份，自定义配图默认不导出，勾选「包含气泡图素材」才会一并打包。<strong>安全提示：</strong>密码不会保存到任何地方，忘记就无法解密（其余项仍可正常恢复）；备份文件本身含你的设置与用量记录，请妥善保管。</p>
    <label class="field row check">
      <span class="label">包含凭据 <em>（需设密码，加密后写入）</em></span>
      <input type="checkbox" v-model="backupWithSecrets" @change="backupFlash.msg = ''" />
    </label>
    <label class="field row check">
      <span class="label">包含气泡图素材 <em>（按压气泡的自定义配图，会明显增大文件体积）</em></span>
      <input type="checkbox" v-model="backupWithBubbles" @change="backupFlash.msg = ''" />
    </label>
    <label v-if="backupWithSecrets" class="field row">
      <span class="label">备份密码</span>
      <input type="password" v-model="backupPassword" placeholder="至少 6 位，导入时要用" autocomplete="new-password" />
    </label>
    <div class="btn-row">
      <button class="secondary utils-btn utils-secondary" :disabled="backupBusy" @click="backupExport">导出备份…</button>
      <button class="secondary utils-btn utils-secondary" :disabled="backupBusy" @click="backupPick">导入备份…</button>
      <button v-if="backupPreview" class="secondary utils-btn utils-secondary" @click="backupCancelPick">取消导入</button>
    </div>

    <div v-if="backupPreview">
      <p class="guide-use">已选文件：<code>{{ backupPreview.path }}</code><br />导出时间：{{ backupPreview.exportedAt || '未知' }} · 插件版本：{{ backupPreview.appVersion || '未知' }}</p>
      <label v-for="it in backupItems" :key="it.key" class="field row check">
        <span class="label">{{ it.label }} <em>{{ it.note }}{{ backupHas(it.key) ? '' : '：备份里没有这一项' }}</em></span>
        <input type="checkbox" v-model="backupPicks[it.key]" :disabled="!backupHas(it.key)" @change="backupConfirm = false" />
      </label>
      <label v-if="backupHas('secrets')" class="field row">
        <span class="label">备份密码</span>
        <input type="password" v-model="backupPassword" placeholder="导出时设的密码（用于解密凭据）" autocomplete="off" />
      </label>
      <div class="btn-row">
        <button class="danger utils-btn utils-danger" :disabled="backupBusy || !backupAnyItem" @click="backupApply">
          {{ backupConfirm ? '确认覆盖写入？不可撤销' : '恢复选中项' }}
        </button>
        <button v-if="backupConfirm" class="secondary utils-btn utils-secondary" @click="backupConfirm = false">取消</button>
      </div>
    </div>
    <p v-if="backupFlash.msg" class="msg" :class="msgCls(backupFlash)">{{ backupFlash.msg }}</p>
    </template>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）全部来自 main.css 的 :root。
   通用控件样式（.card / .field / .label / .msg / .hint / .guide-use 等）已由 main.css
   统一提供（全局唯一来源），本组件只留自身特有的控件样式。
   .btn-row 骨架与 utils 档位配色也已在 main.css，此处不再留副本。 */

input[type='password'] {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg);
}
input[type='password']:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(83, 107, 169, 0.18);
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.guide-use {
  margin: 0;
  color: var(--fg);
}
.guide-use + .guide-use {
  margin-top: 6px;
}
</style>