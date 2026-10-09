<script lang="ts" setup>
import { computed, reactive, ref, watch } from 'vue'
import type { HolidayStatus, SkinGallery, SkinMeta, SoundMeta, SoundRole, WhaleServices } from '../types/services'

// 「挂件外观」整卡：大小 / 形象 / 深浅色 / 气泡与文案 / 音效，从设置页 App.vue 抽出。
// 仍有多处留在父级，按 props 下传或 emit 触发，不能跟着搬：
//   - 素材状态（skinMeta / skinUnused / skinFlash / assetSize / soundsMeta / soundLabel /
//     soundUnused）：本卡与「资源」页七张卡共用同一套（画廊导入、试听、清理都会刷新它们），
//     唯一来源留在父级，这里只收结果展示。
//   - skinFlash：本卡与「资源」页画廊共用同一消息槽（随机按钮的反馈也写它），故留父级。
//   - doRandomSkin / onToggleIncludeBuiltin：都要写 skinFlash 并刷新画廊，留父级，本卡 emit 触发。
//   - 深浅色应用（applyUtoolsDark）：读全局 utools 与 document，父级 1s 轮询也在跑，留父级，
//     本卡 emit('ui-mode-change') 由父级落盘并应用。
//   - 量表换算：父级 applyConfig 回填时也要用（scaleToNum / numToScale / snapScale），
//     故换算函数留父级，本卡只把输入的档位 emit 上去。
// 吸附区 / 量表上下限与档位数等常量：MIN_SCALE / MAX_SCALE / SCALE_STEPS 的第三份副本由
// scripts/check-shared.mjs 比对（指向 App.vue），不搬进来，模板所需档位数以 prop 传入。
const props = defineProps<{
  // 挂件配置整体传入：本卡只读写外观相关字段，落盘统一走 emit('patch')
  cfg: any
  // 随包内置形象清单（父级持有，check-shared 比对的一份在那边）
  builtinSkins: string[]
  // 历史内置形象 id 全集：老配置里可能存着已移出包的值，补 option 用
  legacyBuiltinSkins: string[]
  // 当前使用的自定义形象元信息（无则 null）
  skinMeta: SkinMeta | null
  // 画廊（父级 refreshSkin 填充）：只为在本卡显示「随机池有多大」。
  // 「随机」的抽签池在父级 allSkinChoices 里算（含内置），这里只取画廊这一半用于展示口径，
  // 避免把宿主抽签逻辑在视图层再实现一遍
  skinGallery: SkinGallery | null
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
  // 宿主 API（父级注入）：仅「更新节假日表」用，不在此组件内直接引用全局变量
  services: Partial<WhaleServices>
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
  (e: 'scale-num-live', v: number): void
  // 无参：range 与 number 两个入口的 change 都走它，父级统一以当前 cfg.scaleNum 为准落盘
  (e: 'scale-commit'): void
  (e: 'random-skin'): void
  (e: 'toggle-include-builtin', on: boolean): void
  (e: 'ui-mode-change', mode: string): void
}>()
// 「随机」抽签池规模：内置那张（开关打开时）+ 画廊里未取消参与随机的项。
// 口径与父级 allSkinChoices 一致 —— 这里只用来显示，真正的抽签仍在父级 doRandomSkin。
const randomPoolCount = computed(() => {
  const builtin = props.cfg.randomIncludeBuiltin !== false ? 1 : 0
  return builtin + (props.skinGallery?.items || []).filter((it) => it.random !== false).length
})
// 括号里的口径说明：只有一种情况需要解释（内置关掉了），其余情形保持简短
const randomPoolNote = computed(() => (props.cfg.randomIncludeBuiltin === false
  ? '只算你标了「参与随机」的'
  : '含随包内置那张'))

// 按压气泡（自定义泡泡）模型是否已启用：一旦启用，气泡内容全部由「按压气泡」卡片里的模块决定，
// 常规三行气泡（含它的首行报时）不再渲染 —— 顶层的「小鲸鱼报时」开关随之失效。
// 这里据此把该开关置灰并给提示，避免用户以为是开关坏了（报时改在按压气泡里加「报时」模块）
const bubbleModelOn = computed(() => props.cfg.bubble?.on === true)

// 统一的消息态：与父级 App.vue 里的同名工具保持同一定义（内联一份，免父子透传 4 行工具）
type Flash = { msg: string; err: boolean }
function msgCls(f: Flash) { return { ok: !f.err, err: f.err } }

// 两个折叠组（气泡与文案 / 音效）：仅本卡消费，随卡搬入
const lookFolds = reactive({ bubble: true, sound: true })

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

// —— 节假日表：只读状态 + 手动联网更新。默认零网络，只有点按钮才发请求 ——
const holiday = ref<HolidayStatus | null>(null)
const holidayBusy = ref(false)
const holidayFlash = ref<Flash | null>(null)
function refreshHoliday() {
  try {
    holiday.value = props.services.holidayStatus?.() || null
  } catch { holiday.value = null }
}
refreshHoliday()
async function onHolidayUpdate() {
  if (holidayBusy.value) return
  holidayBusy.value = true
  holidayFlash.value = null
  try {
    const r = await props.services.holidayUpdate?.()
    if (r && r.ok) {
      const years = (r.years || []).join('、')
      const extra = (r.failed && r.failed.length) ? `；${r.failed.join('、')} 年暂未发布（可稍后再更新）` : ''
      holidayFlash.value = { msg: `已更新：${years} 年全年 ${r.total || 0} 天${extra}`, err: !!(r.failed && r.failed.length) }
    } else {
      holidayFlash.value = { msg: (r && r.error) || '更新失败，请检查网络后重试', err: true }
    }
  } catch (err: any) {
    holidayFlash.value = { msg: '更新失败：' + String((err && err.message) || err), err: true }
  } finally {
    holidayBusy.value = false
    refreshHoliday()
  }
}
function onHolidayClear() {
  try { props.services.holidayClear?.() } catch (err) {}
  holidayFlash.value = { msg: '已回到内置节假日表', err: false }
  refreshHoliday()
}
// 状态行：已更新显示覆盖年份 + 整表天数 + 拉取时间；未更新提示当前只有内置年份。
// 「N 天」说的是该年整张节假日表的天数（7 个假期加起来），与今天是否是节假日无关：
// 原先写成「覆盖 2026 年，共 33 天」时，用户会把它读成「针对今天更新了 33 天」，
// 进而怀疑「今天凭什么算节假日」（2026-10-08 实际是节后上班日）。用「全年」点明范围即可。
const holidayNote = computed(() => {
  const h = holiday.value
  if (!h) return ''
  if (!h.updated) return `当前使用内置表（${h.builtinYears.join('、')} 年）`
  const at = h.fetchedAt ? new Date(h.fetchedAt * 1000).toLocaleString() : ''
  return `已更新：${h.years.join('、')} 年全年 ${h.total} 天${at ? '（' + at + '）' : ''}`
})
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
      <!-- 滑块与右侧数字框是同一刻度的两种形态（1–scaleSteps 整数档），都绑 cfg.scaleNum。
           原先滑块走 0.6–2.5/step 0.1（20 档）而数字框走 1–15（15 档），两个分母不同的刻度
           映射同一个 scale，互相把对方挤到非整数位（1.3 这种值根本不是 15 档里的任何一档）。
           input 只更新读数（scale-num-live 不再推实时缩放），change 才落盘并让挂件改窗口 ——
           拖动期间不动窗口，规避「窗口边动边缩 → thumb 追手抖 + 快滑闪」。
           下方刻度点给整数档提供视觉锚点，弥补拖动时看不到挂件真实大小的落差。 -->
      <span class="range-wrap">
        <input class="range" type="range" min="1" :max="scaleSteps" step="1" :value="cfg.scaleNum"
               :style="{ '--steps': scaleSteps }"
               @input="emit('scale-num-live', Number(($event.target as HTMLInputElement).value))"
               @change="emit('scale-commit')" />
        <span class="range-ticks" aria-hidden="true">
          <i v-for="n in scaleSteps" :key="n" :class="{ on: n <= cfg.scaleNum }"></i>
        </span>
      </span>
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
      <span class="label">内置形象也参与随机</span>
      <input type="checkbox" :checked="cfg.randomIncludeBuiltin !== false"
             @change="emit('toggle-include-builtin', ($event.target as HTMLInputElement).checked)" />
    </label>
    <!-- 「随机抽的是哪一池」此前只在「资源」页的操作说明里提一句，用户在外观页点「随机」时
         既不知道池子里有几张、也不知道是哪几张。这里只报规模 + 指路，「是哪几张」交给
         资源页缩略图右上角那枚圆点（那里才有格子可标）。 -->
    <p v-if="skinGallery" class="hint">
      「随机」从 {{ randomPoolCount }} 张里挑（{{ randomPoolNote }}），带
      <span class="skin-pool-legend-dot"></span> 绿点的是参与随机的。
    </p>
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
      <button class="link-btn utils-btn utils-secondary" @click="lookFolds.bubble = !lookFolds.bubble">{{ lookFolds.bubble ? '收起气泡与文案' : '气泡与文案（主题 · 峰谷 · 思考气泡 · 报时 · 菜单按钮）' }}</button>
      <div v-if="lookFolds.bubble">
        <label class="field row">
          <span class="label">气泡配色</span>
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

        <!-- 法定节假日表（峰谷判定的依据）：内置表 + 可选的联网覆盖层。
             默认不联网，「更新」按钮点一下才拉当年 + 次年的放假日子（数据源 chinese-days） -->
        <div class="field">
          <div class="holiday-head">
            <span class="label">法定节假日表</span>
            <button class="link-btn utils-btn utils-secondary" :disabled="holidayBusy"
                    @click="onHolidayUpdate">{{ holidayBusy ? '更新中…' : '更新节假日表' }}</button>
            <button v-if="holiday && holiday.updated" class="link-btn utils-btn utils-secondary"
                    @click="onHolidayClear">恢复内置表</button>
          </div>
          <p class="hint holiday-note">{{ holidayNote }}（表内日期全天谷价）</p>
          <p v-if="holidayFlash" class="hint" :class="msgCls(holidayFlash)">{{ holidayFlash.msg }}</p>
        </div>

        <label class="field row check">
          <span class="label">思考气泡</span>
          <input type="checkbox" :checked="cfg.bubbleOn" @change="emit('patch', { bubbleOn: ($event.target as HTMLInputElement).checked })" />
        </label>

        <label class="field row check">
          <span class="label">小鲸鱼报时 <em>（气泡首行显示当前时间）</em></span>
          <input type="checkbox" :checked="cfg.timeBubbleOn" :disabled="bubbleModelOn"
                 @change="emit('patch', { timeBubbleOn: ($event.target as HTMLInputElement).checked })" />
        </label>
        <p v-if="bubbleModelOn" class="hint">
          已启用「按压气泡（自定义泡泡）」，气泡内容由那里的模块决定，本开关不再生效 ——
          报时请到「按压气泡」卡片里加一个「报时」模块（可写成 <em>现在是 {time}</em> 之类）。
        </p>

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
   通用控件样式已由 main.css 统一提供（全局唯一来源），本组件只留自身特有的控件样式。
   .btn-row 骨架、utils 档位配色与 .link-btn 基类也已在 main.css，此处不再留副本。 */

/* 正文里嵌的「参与随机」图例小圆点：与「资源 → 导入的形象」格子上那枚角标
   （.skin-cell-pool）保持同一形态与配色，用户在这边读到时能对上那边的视觉 */
.skin-pool-legend-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--ok);
  vertical-align: middle;
}

/* 节假日表卡：标题行左侧文字 + 右侧操作按钮；状态说明行留小间距 */
.holiday-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.holiday-head .label {
  margin-right: auto;
}
.holiday-note {
  margin: 6px 0 0;
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

.range {
  flex: 1;
  accent-color: var(--accent);
}
/* 刻度点容器：与滑块同宽、同占位（滑块吃满剩余宽度，刻度点贴在它正下方）。
   纵向排列滑块 + 刻度，行高只多几像素，不影响 .field.row 的居中对齐。 */
.range-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* 刻度点：15 档均分。已到达的档位（n <= scaleNum）点亮为主题色，
   给整数档提供视觉锚点 —— 拖动时窗口不实时变，靠它确认当前停在第几档。
   用 space-between 而不是 grid，两端刻度正好落在滑块可停的两个极值上。 */
.range-ticks {
  display: flex;
  justify-content: space-between;
  padding: 0 8px;
  /* 缩放到滑块 thumb 的有效行程：滑块的 thumb 半径约 8px，两端各留一点，
     否则首尾刻度点会跑到 thumb 够不到的位置 */
  box-sizing: border-box;
}
.range-ticks i {
  width: 2px;
  height: 4px;
  border-radius: 1px;
  background: var(--line);
}
.range-ticks i.on {
  background: var(--accent);
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
</style>