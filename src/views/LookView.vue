<script lang="ts" setup>
import { reactive, ref, watch } from 'vue'
import type { SkinMeta, SoundMeta, SoundRole } from '../types/services'

// 「挂件外观」整卡：大小 / 形象 / 深浅色 / 气泡与文案 / 音效，从设置页 App.vue 抽出。
// 仍有多处留在父级，按 props 下传或 emit 触发，不能跟着搬：
//   - 素材状态（skinMeta / skinUnused / skinFlash / assetSize / soundsMeta / soundLabel /
//     soundUnused）：本卡与「资源」页七张卡共用同一套（画廊导入、试听、清理都会刷新它们），
//     唯一来源留在父级，这里只收结果展示。
//   - skinFlash：本卡与「资源」页画廊共用同一消息槽（随机按钮的反馈也写它），故留父级。
//   - doRandomSkin / onToggleIncludeBuiltin：都要写 skinFlash 并刷新画廊，留父级，本卡 emit 触发。
//   - 深浅色应用（applyUtoolsDark）：读全局 utools 与 document，父级 1s 轮询也在跑，留父级，
//     本卡 emit('ui-mode-change') 由父级落盘并应用。
//   - 量表换算：父级 applyConfig 回填时也要用（scaleToNum），
//     故换算函数留父级，本卡只把输入的数值 emit 上去。
// 吸附区 / 量表上下限等常量：MIN_SCALE / MAX_SCALE 的第三份副本由 scripts/check-shared.mjs
// 比对（指向 App.vue），不搬进来，模板所需档位数以 prop 传入。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写外观相关字段，落盘统一走 emit('patch')
  cfg: any
  // 随包内置形象清单（父级持有，check-shared 比对的一份在那边）
  builtinSkins: string[]
  // 历史内置形象 id 全集：老配置里可能存着已移出包的值，补 option 用
  legacyBuiltinSkins: string[]
  // 当前使用的自定义形象元信息（无则 null）
  skinMeta: SkinMeta | null
  // 已导入形象但当前未使用
  skinUnused: boolean
  // 与「资源」页画廊共用的操作反馈槽（父级写入，本卡只显示）
  skinFlash: Flash
  // 素材体积格式化（跨卡共享的小工具，父级唯一来源）
  assetSize: (m: { size?: number } | null) => string
  // 六槽位音效元信息（父级 refreshSounds 填充）
  soundsMeta: Record<SoundRole, SoundMeta[]>
  // 槽位音效摘要文案（跨卡共享，父级唯一来源）
  soundLabel: (role: SoundRole) => string
  // 已导入音效但当前未使用
  soundUnused: boolean
  // 大小档位数（父级 SCALE_STEPS，模板 number 输入的 max）
  scaleSteps: number
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
  (e: 'scale-live', v: number): void
  (e: 'scale-num-live', v: number): void
  // 无参：range 与 number 两个入口的 change 都走它，父级统一以当前 cfg.scale 为准落盘
  (e: 'scale-commit'): void
  (e: 'random-skin'): void
  (e: 'toggle-include-builtin', on: boolean): void
  (e: 'ui-mode-change', mode: string): void
}>()

// 统一的消息态：与父级 App.vue 里的同名工具保持同一定义（内联一份，免父子透传 4 行工具）
type Flash = { msg: string; err: boolean }
function msgCls(f: Flash) { return { ok: !f.err, err: f.err } }

// 两个折叠组（气泡与文案 / 音效）：仅本卡消费，随卡搬入
const lookFolds = reactive({ bubble: false, sound: false })

// —— 音效音量：本地草稿。父级 cfg.vol 还供挂件预览，故本卡只 emit 落盘，
// 显示值走草稿避免依赖父级回推的时序 ——
function clampVol(v: number) {
  const n = Number(v)
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.9)) * 100) / 100
}
const volDraft = ref(clampVol(props.cfg.vol))
watch(() => props.cfg.vol, (v) => { volDraft.value = clampVol(v) })
function onVolInput(e: Event) {
  volDraft.value = clampVol(Number((e.target as HTMLInputElement).value))
  emit('patch', { vol: volDraft.value })
}
</script>

<template>
  <!-- [外观] 挂件外观：大小 / 形象 / 气泡（主题 · 峰谷文案 · 开关）/ 音效（开关 · 音色 · 音量）。
       素材的「导入 / 删除 / 试听 / 素材包」都在「资源」页，这里只选「用哪个」——
       所以素材说明统一放在卡片开头一句，各设置项下面只留「当前用的是什么」的状态 -->
  <section class="card" data-search="look">
    <h2>挂件外观</h2>

    <p class="hint">
      素材都会复制到本地数据目录（不引用源文件），单文件 ≤5MB。导入 / 删除 / 试听、素材占用与素材包导出
      都在「资源」页；未导入时分别回退为「默认形象」与「小黄鸭」。
    </p>

    <label class="field row">
      <span class="label">大小</span>
      <input class="range" type="range" min="0.6" max="2.5" step="0.1" :value="cfg.scale"
             @input="emit('scale-live', Number(($event.target as HTMLInputElement).value))"
             @change="emit('scale-commit')" />
      <input class="num" type="number" min="1" :max="scaleSteps" step="1" :value="cfg.scaleNum"
             @input="emit('scale-num-live', Number(($event.target as HTMLInputElement).value))"
             @change="emit('scale-commit')" />
    </label>

    <label class="field row">
      <span class="label">形象</span>
      <select :value="cfg.skin" @change="emit('patch', { skin: ($event.target as HTMLSelectElement).value })">
        <option v-for="s in builtinSkins" :key="s" :value="s">{{ s }}</option>
        <!-- 老配置里存的可能是已移出包的历史内置形象：补一个 option，
             否则 select 显示空白；下载回来之前挂件回退默认形象显示，不误导 -->
        <option v-if="!builtinSkins.includes(cfg.skin) && cfg.skin !== 'custom' && legacyBuiltinSkins.includes(cfg.skin)"
                :value="cfg.skin">{{ cfg.skin }}（未下载）</option>
        <!-- 「自定义」只是个语义占位，真正用哪张由宿主 current 决定。
             直接显示「自定义」用户会以为没生效，这里映射成实际形象名 -->
        <option value="custom">{{ skinMeta ? '自定义 · ' + skinMeta.name : '自定义' }}</option>
      </select>
      <button class="export-btn utils-btn utils-outline" type="button" title="从所有勾选了「参与随机」的形象里随机换一张" @click="emit('random-skin')">随机</button>
    </label>
    <label class="field row check">
      <span class="label">内置形象也参与随机 <em>（关掉后随机池只剩你勾选「参与随机」的形象）</em></span>
      <input type="checkbox" :checked="cfg.randomIncludeBuiltin !== false"
             @change="emit('toggle-include-builtin', ($event.target as HTMLInputElement).checked)" />
    </label>
    <p v-if="cfg.skin === 'custom' && !skinMeta" class="hint">
      还没有导入形象，去「资源」页加一张后这里才有「自定义」可用（当前会回退为「默认形象」）。
    </p>
    <p v-else-if="skinUnused" class="hint">
      已导入但当前未使用：「形象」选的不是「自定义」。
    </p>
    <p v-else-if="skinMeta" class="hint">
      当前使用：{{ skinMeta.name }}（{{ assetSize(skinMeta) }}）。
    </p>
    <!-- 随机按钮的反馈：skinFlash 原本只在「资源」页画廊渲染，用户停在「外观」页按随机会看不到结果 -->
    <p v-if="skinFlash.msg" class="msg" :class="msgCls(skinFlash)">{{ skinFlash.msg }}</p>

    <label class="field row">
      <span class="label">界面深浅色</span>
      <select :value="cfg.uiMode" @change="emit('ui-mode-change', ($event.target as HTMLSelectElement).value)">
        <option value="auto">跟随 uTools</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
    <p class="hint">
      设置页与挂件菜单面板的深浅形态，一般选「跟随 uTools」。手动固定后将与 uTools 主题相反；
      不影响气泡配色（在下方「气泡与文案」里单独设置）。
    </p>

    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" @click="lookFolds.bubble = !lookFolds.bubble">{{ lookFolds.bubble ? '收起气泡与文案' : '气泡与文案（主题 · 峰谷 · 报时 · 点按播放）' }}</button>
      <div v-if="lookFolds.bubble">
        <label class="field row">
          <span class="label">气泡主题</span>
          <select :value="cfg.theme" @change="emit('patch', { theme: ($event.target as HTMLSelectElement).value })">
            <option value="default">默认（蓝白）</option>
            <option value="dark">深色</option>
            <option value="sakura">樱花</option>
          </select>
        </label>

        <label class="field row">
          <span class="label">峰谷文案</span>
          <select :value="cfg.peakMode" @change="emit('patch', { peakMode: ($event.target as HTMLSelectElement).value })">
            <option value="default">默认（空闲/高峰）</option>
            <option value="liangwen">梁文峰谷</option>
            <option value="qiangqiang">!?强强?!</option>
          </select>
        </label>

        <label class="field row check">
          <span class="label">思考气泡</span>
          <input type="checkbox" :checked="cfg.bubbleOn" @change="emit('patch', { bubbleOn: ($event.target as HTMLInputElement).checked })" />
        </label>

        <label class="field row check">
          <span class="label">小鲸鱼报时 <em>（气泡首行显示当前时间）</em></span>
          <input type="checkbox" :checked="cfg.timeBubbleOn" @change="emit('patch', { timeBubbleOn: ($event.target as HTMLInputElement).checked })" />
        </label>

        <label class="field row check">
          <span class="label">挂件右上角菜单按钮</span>
          <input type="checkbox" :checked="cfg.menuBtn" @change="emit('patch', { menuBtn: ($event.target as HTMLInputElement).checked })" />
        </label>
      </div>
    </div>

    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" @click="lookFolds.sound = !lookFolds.sound">{{ lookFolds.sound ? '收起音效' : '音效（开关 · 音色 · 音量）' }}</button>
      <div v-if="lookFolds.sound">
        <label class="field row check">
          <span class="label">音效开关</span>
          <input type="checkbox" :checked="cfg.soundOn" @change="emit('patch', { soundOn: ($event.target as HTMLInputElement).checked })" />
        </label>

        <label class="field row">
          <span class="label">音色</span>
          <select :value="cfg.soundSet" :disabled="!cfg.soundOn" @change="emit('patch', { soundSet: ($event.target as HTMLSelectElement).value })">
            <option value="duck">小黄鸭</option>
            <option value="fx1">音效 1</option>
            <option value="custom">自定义</option>
          </select>
        </label>

        <label class="field row">
          <span class="label">音量</span>
          <input class="range" type="range" min="0" max="1" step="0.05" :value="volDraft"
                 :disabled="!cfg.soundOn" @input="onVolInput" />
          <span class="num-text">{{ Math.round(volDraft * 100) }}%</span>
        </label>

        <p v-if="cfg.soundSet === 'custom' && !soundsMeta.press.length" class="hint">
          还没有导入按压音，去「资源」页加一个后这里才有「自定义」可用（当前会回退为「小黄鸭」）。
        </p>
        <p v-else-if="soundUnused" class="hint">
          已导入但当前未使用：「音效开关」没开，或「音色」选的不是「自定义」。
        </p>
        <p v-else-if="soundsMeta.press.length" class="hint">
          自定义音色：按压音 {{ soundLabel('press') }}<template v-if="soundsMeta.release.length"> · 释放音 {{ soundLabel('release') }}</template><template v-else> · 释放音未导入（松开时静音）</template>。
        </p>
        <p class="hint">
          四类提醒音（低余额 / 预算 / 峰谷 / 穿透）留空 = 静音，不打扰是默认，
          只在对应提醒真的弹出时响一次（系统通知不受影响）。各类提醒音的独立音量在「用量」页的「提醒与通知」里调。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）全部来自 main.css 的 :root。
   通用控件样式原本由 App.vue 的 scoped 样式提供，组件拆分后 scoped 隔离掉了，
   这里按本组件用到的部分补齐一份。.btn-row 骨架、utils 档位配色与 .link-btn 基类
   已在 main.css（单一来源），此处不再留副本。 */
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
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
/* 随机按钮：补 hover 提亮（尺寸与描边档配色来自 main.css 的 utils 基类） */
.export-btn {
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}
/* 折叠组：组间留白并用分隔线隔开 */
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