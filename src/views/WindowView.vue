<script lang="ts" setup>
import { ref, watch } from 'vue'
import { msgCls, type Flash } from '../composables/useFlash'
import type { WhaleServices } from '../types/services'

// 「挂件窗口」整卡：进入模式 / 显隐 / 置顶锁定 / 透明度 / 鼠标穿透 / 任务栏避让 /
// 贴边间距 / 吸附与翻转 / 滚动条避让 / 复位，从设置页 App.vue 抽出。
// 仍有多处留在父级，不能跟着搬：
//   - widgetFlash：本卡与「使用帮助」卡共用同一消息槽（那边复制指令 / 新增快捷键也写它），
//     状态由父级持有，这里按 props 收只负责显示。
//   - 挂件显隐 / 复位 / 复制指令 / 新增快捷键：都会写上面那个共享消息槽，故保留在父级，
//     本卡用 emit 触发，保证抽出前后行为一致。
//   - taskbarText：任务栏状态轮询的启停在父级生命周期里（所有 Tab 常轮），这里只收结果展示。
// 吸附区宽度上下限只被本卡消费，随卡搬入；同值副本仍由 scripts/check-shared.mjs 比对。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写窗口相关字段，落盘统一走 emit('patch')
  cfg: any
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局
  services: Partial<WhaleServices>
  // 任务栏实时状态文案（父级每 2s 轮询宿主得到，见 App.vue 的 taskbarPolling）
  taskbarText: string
  // 与「使用帮助」卡共用的操作反馈槽（父级写入，本卡只显示）
  widgetFlash: Flash
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
  (e: 'show-widget'): void
  (e: 'hide-widget'): void
  (e: 'reset-pos'): void
  (e: 'copy-cmd', label: string): void
  (e: 'add-hotkey', label: string): void
}>()

// 统一的消息态（Flash）：定义收口在 composables/useFlash.ts，各卡不再各持一份。

// 吸附区宽度（可用区宽/高的百分比）上下限，同宿主 store.js 的 SNAP_RATIO_*
const SNAP_RATIO_MIN = 1
const SNAP_RATIO_MAX = 45

// 「位置与吸附」折叠态：贴边间距 / 吸附 / 避让滚动条 / 复位都是「装完就不动」的低频项，
// 却占着本卡后半段整整一屏。默认收起，让常改的显隐 / 置顶 / 透明度 / 穿透留在首屏。
// 纯展示态、不给父级，故留组件内部（同 UsageChart 的 modelsOpen）
const posFold = ref(false)

// 表单控件统一回写父级：cfg 是 prop，子组件直接改写属于规范外的副作用，
// 一律 emit('patch') 交给父级落盘（与 AccelView 同一范式）。改完由宿主 saveConfig
// 的 emitConfigChange 回推、父级 applyConfig 回填，形成闭环。
function onTextChange(key: string, e: Event) {
  emit('patch', { [key]: (e.target as HTMLInputElement).value })
}
function onNumChange(key: string, e: Event) {
  emit('patch', { [key]: Number((e.target as HTMLInputElement).value) })
}
function onCheckChange(key: string, e: Event) {
  emit('patch', { [key]: (e.target as HTMLInputElement).checked })
}

// —— 窗口透明度：拖动实时预览（只推 CSS opacity 不写存储），松手持久化 ——
// 需要本地草稿：实时预览那一步走 __live 分支，宿主不落存储也不回推，父级 cfg.opacity
// 在拖动期间不会变 —— 若滑块直接绑 cfg.opacity，「{{ }}%」数字会停在松手那一刻。
function clampOpacity(v: number) {
  return Math.round(Math.max(20, Math.min(100, Number(v) || 100)))
}
const opacityDraft = ref(clampOpacity(props.cfg.opacity))
watch(() => props.cfg.opacity, (v) => { opacityDraft.value = clampOpacity(v) })
function onOpacityLive(e: Event) {
  opacityDraft.value = clampOpacity(Number((e.target as HTMLInputElement).value))
  emit('patch', { opacity: opacityDraft.value, __live: true })
}
function onOpacityCommit() {
  opacityDraft.value = clampOpacity(opacityDraft.value)
  emit('patch', { opacity: opacityDraft.value })
}
</script>

<template>
  <!-- [外观] 挂件窗口：显隐、位置与窗口属性（使用说明 / 故障排查在「帮助」组）。
       与「挂件外观」同属外观组：那边管挂件长什么样、这边管它怎么摆与怎么响应鼠标 -->
  <section class="card" data-search="window">
    <h2>挂件窗口</h2>
    <label class="field row">
      <span class="label">进入插件时</span>
      <select :value="cfg.enterMode" @change="onTextChange('enterMode', $event)">
        <option value="both">设置窗口 + 挂件</option>
        <option value="widget">只显示挂件</option>
        <option value="settings">只显示设置窗口</option>
      </select>
    </label>
    <div class="btn-row">
      <button class="utils-btn utils-primary" @click="emit('show-widget')">显示挂件</button>
      <button class="secondary utils-btn utils-secondary" @click="emit('hide-widget')">隐藏挂件</button>
    </div>

    <label class="field row check">
      <span class="label">窗口置顶</span>
      <input type="checkbox" :checked="cfg.onTop" @change="onCheckChange('onTop', $event)" />
    </label>

    <label class="field row check">
      <span class="label">锁定位置 <em>（禁止拖拽与滚轮缩放，点击刷新仍可用）</em></span>
      <input type="checkbox" :checked="cfg.dragLock" @change="onCheckChange('dragLock', $event)" />
    </label>

    <label class="field row">
      <span class="label">窗口透明度</span>
      <input class="range" type="range" min="20" max="100" step="5" :value="opacityDraft"
             @input="onOpacityLive" @change="onOpacityCommit" />
      <em class="range-val">{{ opacityDraft }}%</em>
    </label>
    <p class="hint">透明度作用于整个挂件（含气泡与菜单）；拖动实时预览。</p>

    <label class="field row check">
      <span class="label">鼠标穿透 <em>（挂件完全不接收鼠标——点击/拖拽/菜单全部穿透；在鲸鱼上停留约 1 秒可临时接管）</em></span>
      <input type="checkbox" :checked="cfg.passThrough" @change="onCheckChange('passThrough', $event)" />
    </label>
    <p class="hint">
      穿透开启后挂件自身菜单也点不到，建议先绑定全局快捷键作为「逃生通道」：uTools 设置 → 全局功能 → 新增 → 指令填「切换鼠标穿透」→ 按下组合键。也可在鲸鱼上停留约 1 秒临时接管后再关。
    </p>
    <div class="btn-row">
      <button class="secondary utils-btn utils-secondary" @click="emit('copy-cmd', '切换鼠标穿透')">复制「穿透」指令名</button>
      <button class="secondary utils-btn utils-secondary" @click="emit('add-hotkey', '切换鼠标穿透')">新增「穿透」快捷键</button>
    </div>

    <label class="field row check">
      <span class="label">自动避让任务栏 <em>（实时识别任务栏隐藏/显示，弹出时让位、收起后贴回）</em></span>
      <input type="checkbox" :checked="cfg.avoidTaskbar" @change="onCheckChange('avoidTaskbar', $event)" />
    </label>
    <p class="hint taskbar-hint">
      任务栏：{{ taskbarText }}
      <em v-if="!cfg.avoidTaskbar">（避让已关闭，挂件位置不再跟随任务栏变化）</em>
    </p>

    <!-- 位置与吸附：低频项收进一个默认收起的折叠（贴边间距 / 吸附 / 滚动条 / 复位） -->
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" type="button" @click="posFold = !posFold">
        {{ posFold ? '收起位置与吸附' : '位置与吸附（贴边间距 / 吸附与翻转 / 避让滚动条 / 复位）' }}
      </button>
      <div v-if="posFold" class="guide">
    <label class="field row">
      <span class="label">贴边间距</span>
      <span class="edge-row">
        <em>上</em><input class="num" type="number" min="0" max="400" step="4" :value="cfg.edgeTop" @change="onNumChange('edgeTop', $event)" />
        <em>右</em><input class="num" type="number" min="0" max="400" step="4" :value="cfg.edgeRight" @change="onNumChange('edgeRight', $event)" />
        <em>下</em><input class="num" type="number" min="0" max="400" step="4" :value="cfg.edgeBottom" @change="onNumChange('edgeBottom', $event)" />
        <em>左</em><input class="num" type="number" min="0" max="400" step="4" :value="cfg.edgeLeft" @change="onNumChange('edgeLeft', $event)" />
      </span>
    </label>
    <p class="hint">贴边间距：挂件贴到该边时留出的像素数（0＝紧贴）。开了「自动避让任务栏」时，任务栏占位的那条边会自动让位；任务栏收起后又回到这里设定的贴边位置。</p>

    <label class="field row">
      <span class="label">吸附与翻转</span>
      <select :value="cfg.snapMode" @change="onTextChange('snapMode', $event)">
        <option value="ratio">比例吸附</option>
        <option value="off">关闭（自由摆放）</option>
      </select>
    </label>
    <label class="field row" v-if="cfg.snapMode === 'ratio'">
      <span class="label">吸附区宽度</span>
      <input class="num" type="number" :min="SNAP_RATIO_MIN" :max="SNAP_RATIO_MAX" step="1" :value="cfg.snapRatio" @change="onNumChange('snapRatio', $event)" />
      <span class="num-text">%</span>
    </label>
    <p class="hint">
      吸附：拖拽松手时，挂件中心落进某条边的吸附区就贴到那条边（吸附区宽度按可用区宽/高算，默认 25%＝左右各 1/4、上下各 1/4）。
      关掉吸附后松手停在哪就是哪，不再自动贴边。
    </p>
    <p class="hint">
      朝向不用配：锚在屏幕左半边就朝右、右半边就朝左，鲸鱼始终面向屏幕内侧（关掉吸附也一样）。
    </p>

    <label class="field row check">
      <span class="label">避让滚动条 <em>（挂件贴右边缘时留出像素，避免盖住最大化窗口的纵向滚动条）</em></span>
      <input type="checkbox" :checked="cfg.scrollGapOn" @change="onCheckChange('scrollGapOn', $event)" />
    </label>
    <label class="field row" v-if="cfg.scrollGapOn">
      <span class="label">滚动条宽度</span>
      <input class="num" type="number" min="0" max="100" step="1" :value="cfg.scrollGapPx" @change="onNumChange('scrollGapPx', $event)" />
      <span class="num-text">px</span>
    </label>
    <p class="hint" v-if="cfg.scrollGapOn">Windows 默认滚动条约 17px；填 0 等于贴边（与关闭开关等效）。与「贴边间距 → 右」取较大值，不会叠加。</p>

    <div class="btn-row">
      <button class="secondary utils-btn utils-secondary" @click="emit('reset-pos')">复位窗口位置</button>
    </div>
    <p class="hint">把挂件挪回默认位置（右下角、紧贴边缘）——换显示器、改分辨率或拖出屏幕后用。</p>
      </div>
    </div>
    <p v-if="widgetFlash.msg" class="msg" :class="msgCls(widgetFlash)">{{ widgetFlash.msg }}</p>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）全部来自 main.css 的 :root。
   通用控件样式已由 main.css 统一提供（全局唯一来源），本组件只留自身特有的控件样式。
   .btn-row 骨架与 utils 档位配色也已在 main.css，此处不再留副本。 */

/* 下拉 / 数值框 / 复选框的表单控件基类已上提 main.css（全局唯一来源），
   此处不再留副本。 */

.range {
  flex: 1;
  accent-color: var(--accent);
}
.range-val {
  font-style: normal;
  font-size: 12px;
  color: var(--fg-dim);
  min-width: 38px;
  text-align: right;
}
/* 贴边间距：一行四个数值（上/右/下/左） */
.edge-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.edge-row em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-faint);
}
/* 任务栏状态：紧跟「自动避让任务栏」开关之后，收紧上下间距 */
.taskbar-hint {
  margin: 2px 0 12px;
}
/* 通用复选框尺寸与配色已上提 main.css（全局唯一来源）。 */
</style>
