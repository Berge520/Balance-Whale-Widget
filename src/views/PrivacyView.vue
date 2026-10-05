<script lang="ts" setup>
import { computed, reactive, ref } from 'vue'
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
  (e: 'cleared', picked: { secrets: boolean; config: boolean; ledger: boolean; window: boolean; sounds: boolean; skins: boolean; bubbles: boolean }): void
}>()

// 统一的消息态：msg=文案、err=是否错误态；模板用 msgCls(f) 生成 class。
// 与父级 App.vue 里的同名工具保持同一定义（原为全页共享，这里内联一份，免得父子透传）
type Flash = { msg: string; err: boolean }
function useFlash(): Flash { return reactive({ msg: '', err: false }) }
function msgCls(f: Flash) { return { ok: !f.err, err: f.err } }

const clearConfirm = ref(false)
// 勾选的项才会被清除（凭据 / 设置 / 账本 / 窗口位置与更新缓存 / 导入的素材）
// 「导入的素材」等同「资源」页的「清除全部素材」；一个勾选拆成 sounds/skins/bubbles 三项下发
const clearItems = reactive({ secrets: true, config: true, ledger: true, window: true, assets: true })
const anyClearItem = computed(() => clearItems.secrets || clearItems.config || clearItems.ledger || clearItems.window || clearItems.assets)
// 二次确认时把「将清除哪些项」写清楚，避免误删
const clearItemNames = computed(() => {
  const names: string[] = []
  if (clearItems.secrets) names.push('凭据')
  if (clearItems.config) names.push('挂件设置')
  if (clearItems.ledger) names.push('账本用量记录')
  if (clearItems.window) names.push('窗口位置与更新缓存')
  if (clearItems.assets) names.push('导入的素材（形象 / 气泡图 / 音效）')
  return names.join('、')
})
const dataFlash: Flash = useFlash()

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
  const picked = { secrets: clearItems.secrets, config: clearItems.config, ledger: clearItems.ledger, window: clearItems.window, sounds: clearItems.assets, skins: clearItems.assets, bubbles: clearItems.assets }
  try {
    const r = props.services.clearAllData?.(picked) || { ok: false }
    dataFlash.err = !(r && r.ok)
    if (r && r.ok) {
      const names: string[] = []
      if (picked.secrets) names.push('凭据')
      if (picked.config) names.push('挂件设置')
      if (picked.ledger) names.push('账本用量记录')
      if (picked.window) names.push('窗口位置与更新缓存')
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
    <h2>数据与隐私</h2>
    <p class="hint">API Key 与平台 Token 通过 uTools 加密存储，账本、窗口位置与导入的素材（形象 / 气泡图 / 音效）也只保存在本机，不会上传到任何第三方服务器。</p>
    <p class="hint">卸载 uTools 插件不会自动删除这些数据，需要彻底清除时请勾选下方要清除的内容（<strong>清除前建议先导出一份备份</strong>，见下方「备份与恢复」）：</p>
    <label class="field row check">
      <span class="label">凭据 <em>（API Key / 平台 Token）</em></span>
      <input type="checkbox" v-model="clearItems.secrets" @change="clearConfirm = false" />
    </label>
    <label class="field row check">
      <span class="label">挂件设置 <em>（大小 / 音效 / 开关等，清除后按默认值重建挂件）</em></span>
      <input type="checkbox" v-model="clearItems.config" @change="clearConfirm = false" />
    </label>
    <label class="field row check">
      <span class="label">账本用量记录 <em>（今日已用与用量趋势）</em></span>
      <input type="checkbox" v-model="clearItems.ledger" @change="clearConfirm = false" />
    </label>
    <label class="field row check">
      <span class="label">窗口位置与更新缓存 <em>（挂件回到默认位置）</em></span>
      <input type="checkbox" v-model="clearItems.window" @change="clearConfirm = false" />
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
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）来自 main.css 的 :root。
   通用控件样式（.card / .field / .label / .msg / .hint 等）原本由 App.vue 的 scoped 样式提供，
   组件拆分后 scoped 隔离掉了，这里按本组件用到的部分补齐一份。
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
.label em {
  font-style: normal;
  color: var(--fg-faint);
  font-size: 11px;
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
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
</style>