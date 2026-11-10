<script lang="ts" setup>
import { computed, reactive, ref } from 'vue'
import { msgCls, useFlash, type Flash } from '../composables/useFlash'
import { useFold } from '../composables/useFold'
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

// 统一的消息态（Flash）：msg=文案、err=是否错误态；模板用 msgCls(f) 生成 class。
// 定义收口在 composables/useFlash.ts，各卡不再各持一份。

const backupWithSecrets = ref(false)
// 气泡图素材：与凭据一样默认不导出 —— 图片是二进制，base64 内嵌会让 JSON 备份膨胀到几十 MB；
// 只想带走「设置 + 账本」的用户不该被拖累。勾了才把配图一起装进 JSON（见 backup.js）
const backupWithBubbles = ref(false)
const backupPassword = ref('')
const backupBusy = ref(false)
const backupFlash: Flash = useFlash()
const backupConfirm = ref(false)
const backupPreview = ref<BackupPreviewResult | null>(null)
const backupPicks = reactive<Record<string, boolean>>({ config: true, ledger: true, window: true, timer: true, holidays: true, bubbles: true, todo: true, secrets: true })
// 「待办与专注记录」在用户心智里是一件事，故合成一个勾选项；底层仍是 whale:todo / whale:focus 两个键，
// 恢复时按备份里实际有的分别写（见 backupApply）。这也与「数据与隐私」页清除侧的合并口径一致。
const backupItems: Array<{ key: string; label: string; note: string }> = [
  { key: 'config', label: '挂件设置', note: '（同名覆盖；含按压气泡的文案与开关）' },
  { key: 'ledger', label: '账本用量记录', note: '（同日覆盖，保留最近 30 天）' },
  { key: 'window', label: '窗口位置', note: '（恢复后挂件重建一次）' },
  { key: 'timer', label: '计时状态', note: '（重载插件后恢复）' },
  { key: 'holidays', label: '节假日表', note: '（联网更新的覆盖层，未更新过则无此项）' },
  { key: 'bubbles', label: '气泡图素材', note: '（按压气泡导入的自定义配图；导出时勾选「包含气泡图素材」才带）' },
  { key: 'todo', label: '待办与专注记录', note: '（待办清单 + 近 90 天专注轮次，同名覆盖；备份里没有时无此项）' },
  // 与「数据与隐私」页清除侧、导出侧同一口径：whale:secrets 里不止 API Key / 平台 Token，
  // 还有各模型密钥与邮件 SMTP 凭据 —— 恢复会整份覆盖，文案漏写会让人以为只动前两项
  { key: 'secrets', label: '凭据', note: '（API Key / 平台 Token / 各模型密钥 / SMTP 密码，用备份密码解密）' },
]
// has 仍是两个键：合并项任一存在即可勾选
const backupHas = (key: string) => {
  const has = backupPreview.value?.has as Record<string, boolean> | undefined
  if (!has) return false
  if (key === 'todo') return !!(has.todo || has.focus)
  return !!has[key]
}
const backupAnyItem = computed(() => backupItems.some((it) => backupPicks[it.key] && backupHas(it.key)))
// 宿主回报的 applied / skipped 用的是底层键名（todo / focus），两者都映射到合并项的名称
const backupItemLabel = (key: string) => {
  const k = key === 'focus' ? 'todo' : key
  return (backupItems.find((i) => i.key === k) || { label: key }).label
}
// 去重：todo 与 focus 同时恢复成功时，列表里只出现一次「待办与专注记录」
const backupNames = (list?: string[]) => Array.from(new Set((list || []).map(backupItemLabel))).join('、')
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
      todo: backupPicks.todo && backupHas('todo'), focus: backupPicks.todo && backupHas('focus'),
      secrets: backupPicks.secrets, password: backupPassword.value,
    })
    const applied = (r && r.applied) || []
    // 待办与专注在界面上合成一个勾选项，底层却是 whale:todo / whale:focus 两个键：
    // 备份里只有其中一个（典型场景 —— 做过专注但清单已清空，导出侧「空清单不写」）时，
    // 宿主会「一个进 applied、一个进 skipped」，两处都映射到同一个卡名，就会输出
    // 「已恢复：待办与专注记录。备份里没有：待办与专注记录。」这种自相矛盾的话。
    // 故：合并项只要有任一部分恢复成功，就不再把它算作「备份里没有」；两个都缺才报。
    const MERGED_KEYS = ['todo', 'focus']
    const anyMergedApplied = applied.some((k) => MERGED_KEYS.indexOf(k) >= 0)
    const skipped = ((r && r.skipped) || []).filter((k) => !(MERGED_KEYS.indexOf(k) >= 0 && anyMergedApplied))
    if (!r || !r.ok) {
      backupFlash.err = true
      backupFlash.msg = '恢复失败：' + ((r && (r.errors || [])[0]) || (r && r.error) || '未知错误')
    } else {
      // 宿主返回的 ok 只表示「至少有一项写进去了」：部分失败时 applied 与 errors 同时非空，
      // 只报「已恢复」会让用户以为全都写进去了（重启后发现设置照旧），故改口径为「部分恢复」
      const errs = (r.errors || []) as string[]
      let msg = (errs.length ? '部分恢复：' : '已恢复：') + backupNames(applied) + '。'
      if (skipped.length) msg += '备份里没有：' + backupNames(skipped) + '。'
      if (r.widgetRebuilt) msg += '挂件已按恢复的设置重建。'
      if (errs.length) msg += errs.join('；') + '。'
      backupFlash.err = errs.length > 0
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
// 日常只在「导出/导入」时才展开；与提醒 / 隐私 / 关于三卡统一为「默认收起、可展开」，
// 收起后只留标题栏摘要（是否已读取备份待恢复）
const cardFold = useFold('backup', false)
const cardSummary = computed(() => backupPreview.value ? '已读取备份，待恢复' : '导出 / 导入 JSON 备份')
// 备份范围与安全说明的折叠态：纯展示、不落盘
const hintOpen = ref(false)
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
    <div class="fold">
      <!-- 备份范围与安全说明原先是一整段 300 字密文，压在勾选项与按钮之前：用户展开本卡的目的是
           导出/导入，却要先滚过一屏说明。按「一次性阅读」收进折叠，默认收起 -->
      <button class="link-btn utils-btn utils-secondary fold-toggle" type="button" :aria-expanded="hintOpen" @click="hintOpen = !hintOpen">{{ hintOpen ? '收起说明' : '备份包含什么 · 安全说明' }}</button>
      <div v-if="hintOpen" class="guide">
        <p class="hint">打包内容：挂件设置 · 账本 · 窗口位置 · 计时 · 节假日表 · 待办与专注。不含 dsh 配置与素材（素材用「资源」页的素材包导出）。</p>
        <p class="hint"><strong>凭据默认不导出</strong>；勾选后需设密码，以 scrypt + AES-256-GCM 加密写入，文件里没有明文。</p>
        <p class="hint">密码不做任何保存，忘记就无法解密凭据（其余项仍可恢复）。备份文件含设置与用量记录，请妥善保管。</p>
      </div>
    </div>
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
      <p class="guide-use">已选：<code>{{ backupPreview.path }}</code><br />导出于 {{ backupPreview.exportedAt || '未知' }} · 版本 {{ backupPreview.appVersion || '未知' }}</p>
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
   .btn-row 骨架与 utils 档位配色也已在 main.css，此处不再留副本。
   输入框 / 复选框的表单控件基类亦已上提 main.css（全局唯一来源）。 */
</style>