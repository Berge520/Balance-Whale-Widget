<script lang="ts" setup>
import { computed, reactive, ref } from 'vue'
import { msgCls, useFlash, type Flash } from '../composables/useFlash'
import type { WhaleServices } from '../types/services'

// 「数据与隐私」按项清除整卡：勾选项与二次确认都内聚在本组件，从设置页 App.vue 抽出。
// 唯一的对外出口是「清除成功」——清除后的页面回显刷新（凭据置空 / 设置回填 / 账本重读）
// 要读父级的全局状态（secrets / cfg / usageHistory），子组件读不到，故用 emit('cleared') 交回。
// 父级用 v-if="cardOn('data', 'privacy')" 控制显隐；本卡不读写 cfg，故不接 cfg。
const props = defineProps<{
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局
  services: Partial<WhaleServices>
}>()
const emit = defineEmits<{
  (e: 'cleared', picked: { secrets: boolean; config: boolean; ledger: boolean; window: boolean; sounds: boolean; skins: boolean; bubbles: boolean; bubble: boolean }): void
}>()

// 统一的消息态（Flash）：msg=文案、err=是否错误态；模板用 msgCls(f) 生成 class。
// 定义收口在 composables/useFlash.ts。

const clearConfirm = ref(false)
// 勾选的项才会被清除（凭据 / 设置 / 账本 / 窗口位置与更新缓存 / 按压气泡 / 导入的素材）
// 「导入的素材」等同「资源」页的「清除全部素材」；一个勾选拆成 sounds/skins/bubbles 三项下发。
// 「按压气泡」单列一项：它的数据天然分散在两处（文案/队列/开关在「挂件设置」里，
// 配图在 whale:bubbles），用户想「把按压气泡整个恢复默认」时不该被迫连挂件其他设置一起清，
// 故给一个组合勾选，一次把文案 + 配图都清掉（host 侧 bubble=true 即做这两件事）
const clearItems = reactive({ secrets: true, config: true, ledger: true, window: true, bubble: true, assets: true })
const anyClearItem = computed(() => clearItems.secrets || clearItems.config || clearItems.ledger || clearItems.window || clearItems.bubble || clearItems.assets)
// 二次确认时把「将清除哪些项」写清楚，避免误删
const clearItemNames = computed(() => {
  const names: string[] = []
  if (clearItems.secrets) names.push('凭据')
  if (clearItems.config) names.push('挂件设置')
  if (clearItems.ledger) names.push('账本用量记录')
  if (clearItems.window) names.push('窗口位置与更新缓存')
  if (clearItems.bubble) names.push('按压气泡（文案 + 配图）')
  if (clearItems.assets) names.push('导入的素材（形象 / 气泡图 / 音效）')
  return names.join('、')
})
const dataFlash: Flash = useFlash()

// 卡级折叠：本卡正文长（两段隐私说明 + 六个勾选项 + 清除按钮），收起后只留标题与摘要，
// 让「数据」组的其它卡上浮。摘要播报当前勾选了几项，收起态也能看出「会不会清东西」
const cardFold = reactive({ open: true })
const cardSummary = computed(() => {
  const n = [clearItems.secrets, clearItems.config, clearItems.ledger, clearItems.window, clearItems.bubble, clearItems.assets].filter(Boolean).length
  return `已勾选 ${n}/6 项`
})

// 清除本地数据：按勾选项清除，需二次确认，避免误触
function clearSelectedData() {
  if (!anyClearItem.value) return
  if (!clearConfirm.value) {
    clearConfirm.value = true
    dataFlash.msg = ''
    dataFlash.err = false
    return
  }
  clearConfirm.value = false
  const picked = { secrets: clearItems.secrets, config: clearItems.config, ledger: clearItems.ledger, window: clearItems.window, bubble: clearItems.bubble, sounds: clearItems.assets, skins: clearItems.assets, bubbles: clearItems.assets }
  try {
    const r = props.services.clearAllData?.(picked) || { ok: false }
    dataFlash.err = !(r && r.ok)
    if (r && r.ok) {
      // 用量趋势的显示区间是纯前端偏好（localStorage，不进宿主存储），随账本一起清掉才叫「清干净」：
      // 不清的话重开插件仍停在上次选的区间，看着像账本没清（实际数据没了，只是区间还被记着）
      if (picked.ledger) { try { localStorage.removeItem('whale:usageRange') } catch (err) {} }
      const names: string[] = []
      if (picked.secrets) names.push('凭据')
      if (picked.config) names.push('挂件设置')
      if (picked.ledger) names.push('账本用量记录')
      if (picked.window) names.push('窗口位置与更新缓存')
      if (picked.bubble) names.push('按压气泡')
      if (clearItems.assets) names.push('导入的素材')
      dataFlash.msg = `已清除：${names.join('、')}。`
        + (picked.config || picked.window ? '挂件已按默认配置重建。' : '')
      // 页面回显刷新（凭据置空 / 设置回填 / 账本重读）读父级全局状态，交回父级做
      emit('cleared', picked)
    } else {
      dataFlash.msg = '清除失败：' + ((r && r.error) || '未知错误')
    }
  } catch (err: any) {
    dataFlash.err = true
    dataFlash.msg = '清除失败：' + String(err?.message || err)
  }
}
</script>

<template>
  <!-- [数据] 数据与隐私：按项清除本地数据。根元素即 .card：父级 v-if 控显隐，
       data-search 供搜索滚动锚点定位（构建期据此抽卡片全文索引）。 -->
  <section class="card" data-search="privacy">
    <div class="card-head">
      <h2 class="card-toggle" @click="cardFold.open = !cardFold.open">
        <span class="caret">{{ cardFold.open ? '▾' : '▸' }}</span>清除数据
        <span v-if="!cardFold.open" class="card-sum">{{ cardSummary }}</span>
      </h2>
    </div>
    <template v-if="cardFold.open">
    <p class="hint">API Key 与平台 Token 通过 uTools 加密存储，账本、窗口位置与导入的素材（形象 / 气泡图 / 音效）也只保存在本机，不会上传到任何第三方服务器。</p>
    <p class="hint">卸载 uTools 插件不会自动删除这些数据，需要彻底清除时请勾选下方要清除的内容（<strong>清除前建议先导出一份备份</strong>，见下方「备份与恢复」）：</p>
    <label class="field row check">
      <span class="label">凭据 <em>（API Key / 平台 Token）</em></span>
      <input type="checkbox" v-model="clearItems.secrets" @change="clearConfirm = false" />
    </label>
    <label class="field row check">
      <span class="label">挂件设置 <em>（大小 / 音效 / 开关等，清除后按默认值重建挂件；含节假日联网更新表）</em></span>
      <input type="checkbox" v-model="clearItems.config" @change="clearConfirm = false" />
    </label>
    <label class="field row check">
      <span class="label">账本用量记录 <em>（今日已用与用量趋势；含 Codex / dsh 本地用量统计缓存）</em></span>
      <input type="checkbox" v-model="clearItems.ledger" @change="clearConfirm = false" />
    </label>
    <label class="field row check">
      <span class="label">窗口位置与更新缓存 <em>（挂件回到默认位置；含 dsh 版本 / 诊断 / 转储 / 市场目录等缓存）</em></span>
      <input type="checkbox" v-model="clearItems.window" @change="clearConfirm = false" />
    </label>
    <label class="field row check">
      <span class="label">按压气泡 <em>（自定义泡泡的文案与配图，清除后回到内置文案与内置图）</em></span>
      <input type="checkbox" v-model="clearItems.bubble" @change="clearConfirm = false" />
    </label>
    <label class="field row check">
      <span class="label">导入的素材 <em>（形象 / 气泡图 / 音效文件，删后回退为内置；等同「资源」页的「清除全部素材」）</em></span>
      <input type="checkbox" v-model="clearItems.assets" @change="clearConfirm = false" />
    </label>
    <div class="btn-row">
      <button class="danger utils-btn utils-danger" :disabled="!anyClearItem" @click="clearSelectedData()">
        {{ clearConfirm ? '确认清除选中数据？不可恢复' : '清除选中数据' }}
      </button>
      <button v-if="clearConfirm" class="secondary utils-btn utils-secondary" @click="clearConfirm = false">取消</button>
    </div>
    <p v-if="clearConfirm" class="hint">将清除：{{ clearItemNames || '（未选中任何项）' }}。此操作不可撤销。</p>
    <p v-if="dataFlash.msg" class="msg" :class="msgCls(dataFlash)">{{ dataFlash.msg }}</p>
    </template>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）来自 main.css 的 :root。
   通用控件样式（.card / .field / .label / .msg / .hint 等）已由 main.css 统一提供
   （全局唯一来源），本组件只留自身特有的控件样式。
   .btn-row 骨架与 utils 档位配色也已在 main.css，此处不再留副本。
   通用复选框尺寸与配色亦已上提 main.css（全局唯一来源）。 */
</style>