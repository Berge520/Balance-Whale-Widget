<script lang="ts" setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { msgCls, type Flash } from '../composables/useFlash'
import { useFold } from '../composables/useFold'
import DownloadBox from '../components/DownloadBox.vue'
import type { DownloadProgress, HolidayStatus, MediaItem, SkinGallery, SkinMeta, SoundMeta, SoundRole, WhaleServices } from '../types/services'

// 「挂件外观」整卡：大小 / 形象 / 深浅色 / 气泡与文案 / 音效，从设置页 App.vue 抽出。
// 仍有多处留在父级，按 props 下传或 emit 触发，不能跟着搬：
//   - 素材状态（skinMeta / skinUnused / skinFlash / assetSize / soundsMeta / soundLabel /
//     soundUnused）：本卡与「资源」页共用同一套（画廊导入、试听、清理都会刷新它们），
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
  // 本组件渲染两张卡（挂件外观 / 设置页视觉），显隐与置顶逐卡判定
  cardOn: (tab: string, key: string) => boolean
  pinned: string[]
  // 搜索态：命中时两张卡都强制展开（临时开合不落盘）
  searchActive: boolean
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
  // 内置音色两组（按压 / 释放）的显示名与文件路径：路径那份与挂件页 SOUND_FILES 同值、
  // 由父级 BUILTIN_SOUND_FILES + check-shared 统一把关，本卡只负责渲染与 emit 试听
  builtinSoundSets: Array<{ key: string; label: string; press: string; release: string }>
  // 宿主 API（父级注入）：仅「更新节假日表」用，不在此组件内直接引用全局变量
  services: Partial<WhaleServices>
  // 视频壁纸的播放状态（父级持有 <video>）：自动播放被拦 / 解码失败时给用户播放入口
  bgMediaPaused: boolean
  bgMediaIsVideo: boolean
  bgMediaError: string
  // 本次插件启动是否已经自动播过片头（由宿主进程内标记回读）
  bootIntroAutoPlayed: boolean
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
  (e: 'scale-num-live', v: number): void
  // 无参：range 与 number 两个入口的 change 都走它，父级统一以当前 cfg.scaleNum 为准落盘
  (e: 'scale-commit'): void
  (e: 'random-skin'): void
  (e: 'toggle-include-builtin', on: boolean): void
  // 试听内置音色（小黄鸭 / 音效 1 的按压 / 释放）：音频通道与消息槽都在父级（soundFlash），
  // 这里只把要播的 ./whale/*.mp3 路径递上去
  (e: 'preview-builtin-sound', url: string): void
  (e: 'ui-mode-change', mode: string): void
  // 视频壁纸下载 / 删除后通知父级重读宿主缓存并挂载（或释放）背景层
  (e: 'bg-video-updated'): void
  // 背景视频暂停 / 解码失败时，用户点按钮要求播放
  (e: 'bg-media-play'): void
  // 暂停当前背景视频
  (e: 'bg-media-pause'): void
  // 背景遮罩 / 模糊 / 亮度 / 暗角 / 构图滑杆：本地先应用再落库（父级负责即时预览）
  (e: 'bg-tune', p: { bgScrim?: number; bgBlur?: number; bgBrightness?: number; bgVignette?: number; bgFit?: 'cover' | 'contain'; bgFocusX?: number; bgFocusY?: number; bgZoom?: number }): void
  // 按当前画面亮度自动给遮罩一个建议值
  (e: 'bg-auto-tune'): void
  // 预览设置页启动片头（显式点击，不受「每次启动只播一次」限制）；参数是当前「纯净播放」勾选值
  (e: 'preview-boot-intro', clean: boolean): void
  // 纯净播放开关：本地立即应用再落库（否则预览时 cfg 还没回填）
  (e: 'boot-intro-clean-change', on: boolean): void
  // 打开系统「减少动态效果」设置页（Win10 轻松使用→显示 / Win11 辅助功能→视觉效果）
  (e: 'open-system-animation-settings'): void
  // 切到资源页「背景与片头」卡
  (e: 'go-assets'): void
}>()
// 按压气泡（自定义泡泡）模型是否已启用：一旦启用，气泡内容全部由「按压气泡」卡片里的模块决定，
// 常规三行气泡（含它的首行报时）不再渲染 —— 顶层的「小鲸鱼报时」开关随之失效。
// 这里据此把该开关置灰并给提示，避免用户以为是开关坏了（报时改在按压气泡里加「报时」模块）
const bubbleModelOn = computed(() => props.cfg.bubble?.on === true)
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

// 统一的消息态（Flash）收口在 composables/useFlash.ts，各卡不再各持一份。

// —— 气泡配色 / 外圈样式：改完先让挂件临时亮一下，再落盘 ——
// 顺序不能反：先落盘的话宿主会立刻按新配置重渲染，用户看不到「亮一下」这个对比过程。
// 预览走宿主通用指令通道（whale:cmd），宿主没挂（旧版设置页 / 浏览器预览）就静默跳过，
// 不影响设置本身生效。
function onThemeChange(theme: string) {
  try { window.services?.themePreview?.({ theme, ms: 3200 }) } catch { /* 宿主未提供：只落盘 */ }
  emit('patch', { theme })
}
function onRingPatch(p: Record<string, unknown>) {
  emit('patch', p)
  try { window.services?.ringPreview?.({ ms: 3200 }) } catch { /* 宿主未提供：只落盘 */ }
}

// 两个折叠组（气泡与文案 / 音效）：仅本卡消费，随卡搬入。
// 默认收起：这两组都是「配置一次后很少再动」的低频项（气泡配色 / 峰谷文案 / 节假日表 /
// 音色音量），展开后很长，会把上方常用的「大小 / 形象 / 深浅色」挤到屏幕外。
const lookFolds = reactive({ bubble: false, sound: false })
// 「设置页视觉」独立卡：默认收起，摘要显示当前背景/片头状态
const pageVisualFold = useFold('pageVisual', false)
// 搜索态强制展开命中的卡（与资源页 / 计时卡同口径）：否则搜到某个字段，卡片却收着，
// 只能看到摘要、看不到命中的那一项。搜索期间的临时收起状态不写 localStorage。
const searchFoldClosed = reactive({ look: false, pageVisual: false })
const lookOpen = computed(() => (props.searchActive ? !searchFoldClosed.look : cardFold.open))
const pageVisualOpen = computed(() => (props.searchActive ? !searchFoldClosed.pageVisual : pageVisualFold.open))
function toggleCardFold(key: 'look' | 'pageVisual') {
  if (props.searchActive) { searchFoldClosed[key] = !searchFoldClosed[key]; return }
  if (key === 'look') cardFold.open = !cardFold.open
  else pageVisualFold.open = !pageVisualFold.open
}
watch(() => props.searchActive, () => {
  searchFoldClosed.look = false
  searchFoldClosed.pageVisual = false
})
function pinCls(key: string) {
  return { 'card-pinned': props.pinned.includes(key) }
}

// 整卡折叠：本卡是「外观」Tab 的第一张、也是最长的一张（大小 / 形象 / 深浅色 + 气泡与文案 +
// 音效三组），进 Tab 就要滚很久。标题即按钮、默认展开、可收起（沿 dsh 卡的 .card-toggle 范式）。
// 收起态摘要播报「当前用的形象 + 音效口径」，避免折起来等于把现状藏了。
const cardFold = useFold('look', true)
const cardSummary = computed(() => {
  const skin = props.cfg.skin === 'custom'
    ? (props.skinMeta ? '自定义 · ' + props.skinMeta.name : '自定义（未导入）')
    : props.cfg.skin
  const sound = props.cfg.soundOn ? '音效 ' + props.cfg.soundSet : '音效关'
  return `形象：${skin} · ${sound} · 大小 ${props.cfg.scaleNum} 档`
})

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
    holidayFlash.value = { msg: '更新失败：' + String((err && err.message) || err || '未知错误'), err: true }
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

// —— 「未至之境」视频壁纸：按需下载 + 本地状态 ——
// 素材不随包（CC BY-NC-SA 4.0），下载/删除都由用户主动点；挂件不读，只在设置页播放。
const bgVideo = reactive({
  installed: false,
  bytes: 0,
  legacy: false,
  busy: false,
  flash: null as Flash | null,
})
const bgDl = ref<DownloadProgress | null>(null)
let bgPollTimer = 0
let bgDlClearTimer = 0

function refreshBgVideo() {
  try {
    const s = props.services.bgVideoStatus?.()
    if (s && s.ok) {
      bgVideo.installed = s.installed === true
      bgVideo.bytes = Number(s.bytes) || 0
      bgVideo.legacy = s.legacy === true
    }
  } catch (err) { /* 宿主未提供（浏览器预览）时按未下载处理 */ }
}
const bgDlPercent = computed<number | null>(() => {
  const s = bgDl.value
  if (!s || !s.totalKnown || !(s.total > 0)) return null
  return Math.max(0, Math.min(100, Math.round((Number(s.received) || 0) / s.total * 100)))
})
const bgDlAmount = computed(() => {
  const s = bgDl.value
  if (!s) return ''
  const got = Number(s.received) || Number(s.bytes) || 0
  return s.totalKnown && s.total > 0
    ? `${props.assetSize({ size: got })} / ${props.assetSize({ size: s.total })}`
    : props.assetSize({ size: got })
})
function bgDlTick() {
  let s: DownloadProgress | null = null
  try { s = props.services.downloadProgress?.() || null } catch (err) {}
  if (s && s.pack !== 'bg-video') s = null
  bgDl.value = s
  if (!s || s.phase === 'done' || s.phase === 'failed') {
    stopBgPoll()
    if (s && (s.phase === 'done' || s.phase === 'failed')) scheduleBgDlClear()
  }
}
function startBgPoll() {
  bgDlTick()
  if (!bgPollTimer) bgPollTimer = window.setInterval(bgDlTick, 250)
}
function stopBgPoll() {
  if (bgPollTimer) { window.clearInterval(bgPollTimer); bgPollTimer = 0 }
}
function scheduleBgDlClear() {
  if (bgDlClearTimer) return
  bgDlClearTimer = window.setTimeout(() => { bgDl.value = null; bgDlClearTimer = 0 }, 8000)
}
async function onBgVideoDownload() {
  if (bgVideo.busy) return
  bgVideo.busy = true
  bgVideo.flash = null
  bgDl.value = null
  if (bgDlClearTimer) { window.clearTimeout(bgDlClearTimer); bgDlClearTimer = 0 }
  startBgPoll()
  try {
    const r = await props.services.bgVideoDownload?.()
    if (r && r.ok) {
      bgVideo.flash = { msg: r.skipped ? '视频壁纸已在本地' : '视频壁纸已下载，正在启用', err: false }
      refreshBgVideo()
      emit('bg-video-updated')
    } else {
      bgVideo.flash = { msg: '下载失败：' + ((r && r.error) || '未知错误'), err: true }
    }
  } catch (err: any) {
    bgVideo.flash = { msg: '下载失败：' + String((err && err.message) || err || '未知错误'), err: true }
  } finally {
    bgVideo.busy = false
    stopBgPoll()
    refreshBgVideo()
  }
}
function onBgVideoRemove() {
  try {
    const r = props.services.bgVideoRemove?.()
    if (r && r.ok) {
      bgVideo.flash = { msg: '已删除本地视频，背景回退为深海底色', err: false }
      bgDl.value = null
      refreshBgVideo()
      emit('bg-video-updated')
    } else {
      bgVideo.flash = { msg: '删除失败：' + ((r && r.error) || '未知错误'), err: true }
    }
  } catch (err: any) {
    bgVideo.flash = { msg: '删除失败：' + String((err && err.message) || err || '未知错误'), err: true }
  }
}
function onBgModeChange(mode: string) {
  emit('patch', { bgMode: mode })
  if (mode === 'video') refreshBgVideo()
  if (mode === 'custom') refreshMedia()
}

// 背景/片头媒体库（资源页导入）：外观页只读列表做选择，导入与删除仍在资源页
const mediaItems = ref<MediaItem[]>([])
function refreshMedia() {
  try {
    const r = props.services.mediaList?.()
    if (r && r.ok) mediaItems.value = r.items || []
  } catch (err) { mediaItems.value = [] }
}
const mediaVideos = computed(() => mediaItems.value.filter((m) => m.type === 'video'))
const selectedBgMedia = computed(() => mediaItems.value.find((m) => m.id === props.cfg.bgMediaId) || null)
const BG_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'deep', label: '深海光晕' },
  { value: 'aurora', label: '极光' },
  { value: 'stars', label: '星海' },
  { value: 'mist', label: '薄雾' },
  { value: 'polar', label: '极夜' },
  { value: 'warm', label: '暖光' },
  { value: 'video', label: '鲸鱼娘视频' },
  { value: 'custom', label: '我的媒体' },
] as const
function bgOptionNote(value: string) {
  if (value === 'video') return bgVideo.installed ? '已下载' : '需下载'
  if (value === 'custom') return selectedBgMedia.value ? selectedBgMedia.value.name : '未选择'
  if (value === 'off') return ''
  return '纯 CSS'
}
function mediaNameOf(id: string) {
  const m = mediaItems.value.find((x) => x.id === id)
  return m ? m.name : ''
}
// 「设置页视觉」折叠组收起时的摘要：背景模式 + 片头状态
const BG_LABELS: Record<string, string> = {
  off: '关闭', deep: '深海光晕', aurora: '极光', stars: '星海',
  mist: '薄雾', polar: '极夜', warm: '暖光',
}
const pageVisualSummary = computed(() => {
  const mode = props.cfg.bgMode
  let bg = BG_LABELS[mode] || '关闭'
  if (mode === 'video') bg = bgVideo.installed ? '鲸鱼娘视频' : '鲸鱼娘视频（未下载）'
  else if (mode === 'custom') {
    const name = mediaNameOf(props.cfg.bgMediaId)
    bg = name ? `自定义 · ${name}` : (props.cfg.bgMediaId ? '自定义（媒体丢失）' : '自定义（未选择）')
  }
  let intro = '片头关'
  if (props.cfg.bootIntroOn) {
    const mediaName = props.cfg.bootIntroSource === 'media' ? mediaNameOf(props.cfg.bootIntroMediaId) : ''
    const source = props.cfg.bootIntroSource === 'media'
      ? (mediaName ? ' · ' + mediaName : '（未选视频）')
      : ''
    intro = '片头开' + source + (props.cfg.bootIntroClean ? ' · 纯净' : '')
  }
  return `背景：${bg} · ${intro}`
})

onMounted(() => { refreshBgVideo(); refreshMedia() })
watch(() => props.cfg.bgMode, (v) => {
  if (v === 'video') refreshBgVideo()
  if (v === 'custom') refreshMedia()
})
onUnmounted(() => {
  stopBgPoll()
  if (bgDlClearTimer) { window.clearTimeout(bgDlClearTimer); bgDlClearTimer = 0 }
})
</script>

<template>
  <!-- [外观] 挂件外观：大小 / 形象 / 气泡（主题 · 峰谷文案 · 开关）/ 音效（开关 · 音色 · 音量）。
       素材的「导入 / 删除 / 试听 / 素材包」都在「资源」页，这里只选「用哪个」——
       所以素材说明统一放在卡片开头一句，各设置项下面只留「当前用的是什么」的状态 -->
  <section v-if="cardOn('look', 'look')" class="card" :class="pinCls('look')" data-search="look">
    <div class="card-head">
      <h2 class="card-toggle" @click="toggleCardFold('look')">
        <span class="caret">{{ lookOpen ? '▾' : '▸' }}</span>挂件外观
        <span v-if="!lookOpen" class="card-sum">{{ cardSummary }}</span>
      </h2>
    </div>
    <template v-if="lookOpen">

    <p class="hint">
      形象 / 音效的导入、删除、试听在「资源」页；未导入时回退「默认形象」与「小黄鸭」。
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
      还没导入形象，当前回退「默认形象」；去「资源」页加一张后「自定义」才可用。
    </p>
    <p v-else-if="skinUnused" class="hint">
      已导入但没在用：「形象」选的不是「自定义」。
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
        <option value="fantasy">未至之境（深色）</option>
      </select>
    </label>
    <p class="hint">
      设置页与挂件菜单面板的深浅形态，一般选「跟随 uTools」；浅色 / 深色会固定下来，与 uTools 主题相反。
      不影响气泡配色（在「气泡与文案」里设）。
    </p>

    <!-- 挂件最常调的三个开关（思考气泡 / 报时 / 右上角菜单）不再埋进折叠区：
         折叠区默认收起，用户点「气泡与文案」才看得到，而这三项恰恰是日常最想改的。
         外圈样式属「设一次就不再动」的，故下沉到折叠区末尾 -->
    <label class="field row check">
      <span class="label">思考气泡</span>
      <input type="checkbox" :checked="cfg.bubbleOn" @change="emit('patch', { bubbleOn: ($event.target as HTMLInputElement).checked })" />
    </label>
    <!-- 关掉后不只是「不弹台词」：所有气泡类反馈一起没了，连计时到点的动作条也挂不出来
         （动作条定位在气泡下缘，见 floating-page.js 的 updateTimerActions）。
         这句话只在关着时出现 —— 开着的时候说一遍「关掉会怎样」纯属噪音 -->
    <p v-if="!cfg.bubbleOn" class="hint">
      已关闭：不再弹任何气泡 —— 峰谷 / 预算 / 低余额提醒、计时气泡，以及计时到点气泡旁的
      「休息 / 再来一轮」按钮都跟着消失，只剩系统通知（若开着）。
    </p>
    <label class="field row check">
      <span class="label">小鲸鱼报时 <em>（气泡首行显示当前时间）</em></span>
      <input type="checkbox" :checked="cfg.timeBubbleOn" :disabled="bubbleModelOn"
             @change="emit('patch', { timeBubbleOn: ($event.target as HTMLInputElement).checked })" />
    </label>
    <!-- 报时与「下班倒计时」可同时开启：倒计时只在最后一张「倒计时页」出现，第一张气泡始终是步骤页 -->
    <p v-if="bubbleModelOn" class="hint">已启用「按压气泡」，气泡内容由那里的模块决定，本开关失效 —— 报时请在「按压气泡」卡里加一个「报时」模块（如「现在是 {time}」）。</p>
    <p v-else-if="cfg.offworkOn === true" class="hint">已开启「下班倒计时」，两者可同时生效：倒计时占用最后一张「倒计时页」，第一张气泡仍是步骤页。</p>
    <label class="field row check">
      <span class="label">挂件右上角菜单按钮 <em>（关掉后悬停不出现；右键点鲸鱼仍可唤出）</em></span>
      <input type="checkbox" :checked="cfg.menuBtn" @change="emit('patch', { menuBtn: ($event.target as HTMLInputElement).checked })" />
    </label>

    <div class="fold">
      <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="lookFolds.bubble" @click="lookFolds.bubble = !lookFolds.bubble">{{ lookFolds.bubble ? '收起气泡配色与文案' : '气泡配色与文案（主题 · 峰谷 · 节假日表）' }}</button>
      <div v-if="lookFolds.bubble">
        <label class="field row">
          <span class="label">气泡配色</span>
          <select :value="cfg.theme" @change="onThemeChange(($event.target as HTMLSelectElement).value)">
            <option value="default">默认（蓝白）</option>
            <option value="dark">深色</option>
            <option value="sakura">樱花</option>
            <option value="fantasy">未至之境（深蓝）</option>
          </select>
        </label>
        <!-- 配色不在设置页放预览图：改完直接在真实挂件上弹泡演示（theme-preview），
             比静态样张更准，也不用维护第二份样本 -->
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
        <!-- 外圈：计时与下班倒计时共用同一圈（谁在跑归谁），样式放这里；「要不要给倒计时画」仍在下班倒计时卡。
             属「设一次就不再动」的低频项，放折叠区末尾 -->
        <label class="field row">
          <span class="label">外圈粗细</span>
          <select class="auto" :value="cfg.ringWidth" @change="onRingPatch({ ringWidth: ($event.target as HTMLSelectElement).value })">
            <option value="thin">细</option><option value="normal">标准</option><option value="thick">粗</option>
          </select>
        </label>
        <label class="field row check">
          <span class="label">圈色跟随气泡主题 <em>（浅底压深、深底调亮；樱花与未至之境另配色）</em></span>
          <input type="checkbox" :checked="cfg.ringFollowTheme !== false"
                 @change="onRingPatch({ ringFollowTheme: ($event.target as HTMLInputElement).checked })" />
        </label>
      </div>
    </div>
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary fold-toggle" :aria-expanded="lookFolds.sound" @click="lookFolds.sound = !lookFolds.sound">{{ lookFolds.sound ? '收起音效' : '音效（开关 · 音色 · 音量）' }}</button>
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
        <!-- 内置音色的试听：原先寄生在「资源」页的「内置资源与下载源」卡里（那张卡已拆掉），
             而音色是在本卡选的 —— 试听跟着选择走，用户不必为了听一耳朵跳去「资源」页。
             每组一对「按压 / 释放」；自定义音色的试听在「资源 → 导入的音效」里（那是用户自己的文件） -->
        <div class="builtin-sound-try" v-for="g in builtinSoundSets" :key="g.key">
          <span class="label">{{ g.label }}</span>
          <button class="export-btn utils-btn utils-outline" type="button" @click="emit('preview-builtin-sound', g.press)">试听按压</button>
          <button class="export-btn utils-btn utils-outline" type="button" @click="emit('preview-builtin-sound', g.release)">试听释放</button>
        </div>
        <label class="field row">
          <span class="label">音量</span>
          <input class="range" type="range" min="0" max="1" step="0.05" :value="volDraft"
                 :disabled="!cfg.soundOn" @input="onVolInput" />
          <span class="num-text">{{ Math.round(volDraft * 100) }}%</span>
        </label>
        <p v-if="cfg.soundSet === 'custom' && !soundsMeta.press.length" class="hint">
          还没导入按压音，当前回退「小黄鸭」；去「资源」页加一个后「自定义」才可用。
        </p>
        <p v-else-if="soundUnused" class="hint">
          已导入但没在用：「音效开关」没开，或「音色」选的不是「自定义」。
        </p>
        <p v-else-if="soundsMeta.press.length" class="hint">
          自定义音色：按压音 {{ soundLabel('press') }}<template v-if="soundsMeta.release.length"> · 释放音 {{ soundLabel('release') }}</template><template v-else> · 释放音未导入（松开时静音）</template>。
        </p>
        <p class="hint">
          四类提醒音（低余额 / 预算 / 峰谷 / 穿透）留空时用内置提醒音，导入后换成你自己的，
          只在对应提醒真的弹出时响一次（系统通知不受影响）。各类提醒音的独立音量在「用量」页的「提醒与通知」里调。
        </p>
      </div>
    </div>
    </template>
  </section>
  <!-- [外观] 设置页视觉：背景氛围 / 视频与自定义媒体构图 / 智能遮罩 / 启动片头。
       与「挂件外观」分开成卡：这里改的是设置页本身的样子（全局背景层 + 启动动画），
       与挂件主题是两回事；两张卡各自可显隐、可置顶。 -->
  <section v-if="cardOn('look', 'pageVisual')" class="card" :class="pinCls('pageVisual')" data-search="pageVisual">
    <div class="card-head">
      <!-- 默认收起：背景与片头基本是「调一次就不再动」的低频项，展开后很长 -->
      <h2 class="card-toggle" @click="toggleCardFold('pageVisual')">
        <span class="caret">{{ pageVisualOpen ? '▾' : '▸' }}</span>设置页视觉
        <!-- 紧跟「挂件外观」时容易被读成挂件外观的一部分：卡头直接点明只管设置页自己 -->
        <em class="card-note">（只影响设置页本身，不改挂件）</em>
        <span v-if="!pageVisualOpen" class="card-sum">{{ pageVisualSummary }}</span>
      </h2>
    </div>
    <template v-if="pageVisualOpen">

    <div class="field">
      <span class="label">背景氛围</span>
      <div class="bg-gallery">
        <button v-for="opt in BG_OPTIONS" :key="opt.value" type="button" class="bg-card"
                :class="{ 'is-active': cfg.bgMode === opt.value }" :aria-pressed="cfg.bgMode === opt.value"
                @click="onBgModeChange(opt.value)">
          <span class="bg-swatch" :class="'bg-swatch-' + opt.value">
            <img v-if="opt.value === 'custom' && selectedBgMedia?.thumb" :src="selectedBgMedia.thumb" alt="" />
            <span v-else-if="opt.value === 'custom'" class="bg-swatch-plus">＋</span>
            <span v-else-if="opt.value === 'video'" class="bg-swatch-play">▶</span>
          </span>
          <span class="bg-card-name">{{ opt.label }}</span>
          <span class="bg-card-note">{{ bgOptionNote(opt.value) }}</span>
        </button>
      </div>
    </div>
    <p class="hint">纯 CSS 背景零素材；视频壁纸需单独下载、自定义媒体在「资源」页导入，都只在设置页播放，不进挂件。画面随界面深浅色适配。</p>

    <div v-if="cfg.bgMode === 'video'" class="bg-video-box">
      <template v-if="bgVideo.installed">
        <p class="hint">已下载 {{ assetSize({ size: bgVideo.bytes }) }}，可随时删除本地文件。</p>
        <div class="bg-video-actions">
          <button class="link-btn utils-btn utils-secondary" type="button" :disabled="bgVideo.busy"
                  @click="onBgVideoDownload">{{ bgVideo.busy ? '正在下载…' : '重新下载' }}</button>
          <button class="link-btn utils-btn utils-secondary" type="button" :disabled="bgVideo.busy"
                  @click="onBgVideoRemove">删除本地文件</button>
        </div>
      </template>
      <template v-else>
        <p class="hint">{{ bgVideo.legacy
          ? '已下载旧版 1.3 MB 短片。完整版约 6.3 MB，下载后会覆盖并清理旧文件。'
          : '尚未下载（约 6.3 MB）。素材不随插件包分发，下载后可随时关闭或删除。' }}</p>
        <button class="link-btn utils-btn utils-secondary" type="button" :disabled="bgVideo.busy"
                @click="onBgVideoDownload">{{ bgVideo.busy ? '正在下载…' : (bgVideo.legacy ? '更新为完整版（6.3 MB）' : '下载视频壁纸（6.3 MB）') }}</button>
      </template>
      <DownloadBox v-if="bgDl" :progress="bgDl" :percent="bgDlPercent" :amount="bgDlAmount" />
      <p v-if="bgVideo.flash && bgVideo.flash.msg" class="msg" :class="msgCls(bgVideo.flash)">{{ bgVideo.flash.msg }}</p>
      <p class="hint bg-video-credit">
        素材：<a href="https://github.com/zhu1090093659/dsh-web" target="_blank" rel="noreferrer">stushansusu</a>
        · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0</a>
        · 仅限非商业使用，二次分发须保留署名与同许可证。
      </p>
    </div>

    <div v-if="cfg.bgMode === 'custom'" class="bg-video-box">
      <label class="field row">
        <span class="label">背景媒体</span>
        <select :value="cfg.bgMediaId" @change="emit('patch', { bgMediaId: ($event.target as HTMLSelectElement).value })">
          <option value="">（未选择）</option>
          <option v-for="m in mediaItems" :key="m.id" :value="m.id">{{ m.name }}（{{ m.type === 'video' ? '视频' : '图片' }}）</option>
        </select>
      </label>
      <p v-if="!mediaItems.length" class="hint">还没有导入背景媒体。</p>
      <button v-if="!mediaItems.length" class="link-btn utils-btn utils-secondary" type="button"
              @click="emit('go-assets')">去资源页导入</button>
      <p v-else-if="!cfg.bgMediaId" class="hint">从上面的下拉选一项；图片 / 视频都按 cover 铺满。</p>
      <p v-else-if="!mediaNameOf(cfg.bgMediaId)" class="hint">选中的媒体已丢失或已删除，背景会回退为深海底色。</p>
      <div v-else-if="selectedBgMedia" class="bg-media-preview">
        <img v-if="selectedBgMedia.thumb" :src="selectedBgMedia.thumb" alt="" />
        <span v-else class="bg-media-preview-kind">视频</span>
        <span class="bg-media-preview-meta">
          {{ selectedBgMedia.type === 'video' ? '视频' : '图片' }} · {{ assetSize(selectedBgMedia) }}
        </span>
        <button class="link-btn utils-btn utils-secondary" type="button"
                @click="emit('go-assets')">管理媒体</button>
      </div>
      <label class="field row">
        <span class="label">适配</span>
        <select :value="cfg.bgFit" @change="emit('bg-tune', { bgFit: ($event.target as HTMLSelectElement).value as 'cover' | 'contain' })">
          <option value="cover">铺满裁切</option>
          <option value="contain">完整显示</option>
        </select>
      </label>
      <label class="field row">
        <span class="label">焦点 X</span>
        <input class="range" type="range" min="0" max="100" step="5" :value="cfg.bgFocusX"
               @input="emit('bg-tune', { bgFocusX: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-text">{{ cfg.bgFocusX }}%</span>
      </label>
      <label class="field row">
        <span class="label">焦点 Y</span>
        <input class="range" type="range" min="0" max="100" step="5" :value="cfg.bgFocusY"
               @input="emit('bg-tune', { bgFocusY: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-text">{{ cfg.bgFocusY }}%</span>
      </label>
      <label class="field row">
        <span class="label">缩放</span>
        <input class="range" type="range" min="100" max="130" step="5" :value="cfg.bgZoom"
               @input="emit('bg-tune', { bgZoom: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-text">{{ cfg.bgZoom }}%</span>
      </label>
    </div>

    <div v-if="cfg.bgMode === 'video' || cfg.bgMode === 'custom'" class="bg-tune">
      <label class="field row">
        <span class="label">遮罩</span>
        <input class="range" type="range" min="0" max="80" step="5" :value="cfg.bgScrim"
               @input="emit('bg-tune', { bgScrim: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-text">{{ cfg.bgScrim }}%</span>
      </label>
      <label class="field row">
        <span class="label">模糊</span>
        <input class="range" type="range" min="0" max="20" step="1" :value="cfg.bgBlur"
               @input="emit('bg-tune', { bgBlur: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-text">{{ cfg.bgBlur }}px</span>
      </label>
      <label class="field row">
        <span class="label">亮度</span>
        <input class="range" type="range" min="50" max="120" step="5" :value="cfg.bgBrightness"
               @input="emit('bg-tune', { bgBrightness: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-text">{{ cfg.bgBrightness }}%</span>
      </label>
      <label class="field row">
        <span class="label">暗角</span>
        <input class="range" type="range" min="0" max="100" step="5" :value="cfg.bgVignette"
               @input="emit('bg-tune', { bgVignette: Number(($event.target as HTMLInputElement).value) })" />
        <span class="num-text">{{ cfg.bgVignette }}%</span>
      </label>
      <div class="bg-presets">
        <button class="export-btn utils-btn utils-outline" type="button"
                @click="emit('bg-tune', { bgScrim: 45, bgBlur: 0, bgBrightness: 100, bgVignette: 100 })">恢复默认</button>
        <button class="export-btn utils-btn utils-outline" type="button"
                @click="emit('bg-auto-tune')">智能适配</button>
        <button class="export-btn utils-btn utils-outline" type="button"
                @click="emit('bg-tune', { bgScrim: 25, bgBlur: 0, bgBrightness: 105, bgVignette: 60 })">清晰</button>
        <button class="export-btn utils-btn utils-outline" type="button"
                @click="emit('bg-tune', { bgScrim: 45, bgBlur: 4, bgBrightness: 100, bgVignette: 100 })">柔和</button>
        <button class="export-btn utils-btn utils-outline" type="button"
                @click="emit('bg-tune', { bgScrim: 60, bgBlur: 8, bgBrightness: 95, bgVignette: 100 })">沉浸</button>
      </div>
      <!-- 视频背景常驻播放控制：播放中只留紧凑的重播入口，暂停/报错时才展开说明 -->
      <template v-if="bgMediaIsVideo && (cfg.bgMode === 'custom' || bgVideo.installed)">
        <div v-if="bgMediaError" class="bg-video-play-row">
          <span class="hint">视频无法播放：{{ bgMediaError }}</span>
          <button class="link-btn utils-btn utils-secondary" type="button" @click="emit('bg-media-play')">播放视频</button>
        </div>
        <div v-else-if="bgMediaPaused" class="bg-video-play-row">
          <span class="hint">视频已暂停（可能被浏览器拦截自动播放），点右侧继续。</span>
          <button class="link-btn utils-btn utils-secondary" type="button" @click="emit('bg-media-play')">播放视频</button>
        </div>
        <div v-else class="bg-video-replay-row">
          <span class="hint">视频播放中</span>
          <button class="link-btn utils-btn utils-secondary" type="button" @click="emit('bg-media-pause')">暂停</button>
          <button class="link-btn utils-btn utils-secondary" type="button" @click="emit('bg-media-play')">重播</button>
        </div>
      </template>
    </div>

    <label class="field row check">
      <span class="label">启动片头 <em>（每次插件启动后首次打开设置页播一次）</em></span>
      <input type="checkbox" :checked="cfg.bootIntroOn"
             @change="emit('patch', { bootIntroOn: ($event.target as HTMLInputElement).checked })" />
    </label>
    <template v-if="cfg.bootIntroOn">
      <label class="field row">
        <span class="label">片头来源</span>
        <select :value="cfg.bootIntroSource" @change="emit('patch', { bootIntroSource: ($event.target as HTMLSelectElement).value })">
          <option value="auto">跟随背景（有视频就用）</option>
          <option value="media">指定片头视频</option>
          <option value="css">纯 HUD 片头</option>
        </select>
      </label>
      <label v-if="cfg.bootIntroSource === 'media'" class="field row">
        <span class="label">片头视频</span>
        <select :value="cfg.bootIntroMediaId" @change="emit('patch', { bootIntroMediaId: ($event.target as HTMLSelectElement).value })">
          <option value="">（未选择）</option>
          <option v-for="m in mediaVideos" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
      </label>
      <p v-if="cfg.bootIntroSource === 'media' && !mediaVideos.length" class="hint">
        还没有视频：去「资源」页「背景与片头」导入；未选择 / 媒体丢失时回退纯 HUD 片头。
      </p>
      <button v-if="cfg.bootIntroSource === 'media' && !mediaVideos.length"
              class="link-btn utils-btn utils-secondary" type="button"
              @click="emit('go-assets')">去资源页导入</button>
      <p v-else-if="cfg.bootIntroSource === 'media' && !cfg.bootIntroMediaId" class="hint">
        选一个视频；未选择时回退纯 HUD 片头。
      </p>
      <label class="field row check">
        <span class="label">纯净播放 <em>（片头期间隐藏所有 Tab 与卡片）</em></span>
        <input type="checkbox" :checked="cfg.bootIntroClean"
               @change="emit('boot-intro-clean-change', ($event.target as HTMLInputElement).checked)" />
      </label>
      <p class="hint">开启后片头播放时设置页完全隐藏，只显示启动动画；跳过 / 播完后自动恢复。</p>
    </template>
    <div class="boot-intro-row">
      <p class="hint">
        <template v-if="bootIntroAutoPlayed">本次插件启动已自动播放过；想重看请点「预览片头」。</template>
        <template v-else>每次插件启动后首次打开设置页自动播一次；想重看随时点「预览片头」。</template>
        播放时点击 / 任意键跳过；系统减少动态效果时只关闭转场/扫描动画，视频仍播放。
      </p>
      <span class="boot-intro-actions">
        <button class="link-btn utils-btn utils-secondary" type="button"
                @click="emit('open-system-animation-settings')">系统动画设置</button>
        <button class="link-btn utils-btn utils-secondary" type="button"
                @click="emit('preview-boot-intro', cfg.bootIntroClean)">预览片头</button>
      </span>
    </div>
    </template>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）全部来自 main.css 的 :root。
   通用控件样式已由 main.css 统一提供（全局唯一来源），本组件只留自身特有的控件样式。
   .btn-row 骨架、utils 档位配色与 .link-btn 基类也已在 main.css，此处不再留副本。 */

/* 外圈粗细的档位下拉只容纳「细 / 标准 / 粗」：全局 `.field.row select` 是 flex: 1、`select` 又是 width: 100%，
   只写 flex: 0 0 auto 会以整行宽度为基准且不收缩，叠上左侧标签就把卡片撑出边界 —— 必须同时收回 width */
.field.row select.auto { flex: 0 0 auto; width: auto; max-width: 100%; min-width: 84px }

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

/* 内置音色的试听行：左侧音色名、右侧一对试听按钮，与 .field.row 同骨架。
   每组一对（按压 / 释放）各占一行，音色名用 .label 左推，按钮靠右排齐 */
.builtin-sound-try {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.builtin-sound-try .label {
  margin-right: auto;
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

/* 下拉 / 数值框 / 复选框的表单控件基类已上提 main.css（全局唯一来源），
   此处不再留副本。 */

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
/* 随机按钮：补 hover 提亮（尺寸与描边档配色来自 main.css 的 utils 基类） */
.export-btn {
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}
/* 卡头括号注：常显、不随 .card-sum 推到最右，且不用斜体 */
.card-toggle .card-note { font-size: 12px; font-weight: 400; font-style: normal; color: var(--fg-dim) }
/* 视频壁纸的状态区：下载按钮 / 重新下载 / 删除 + 许可署名，跟在「背景氛围」下拉后 */
.bg-video-box {
  margin: 8px 0 4px;
  padding: 10px 12px;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--track);
}
.bg-video-box .hint { margin: 0 0 8px }
.bg-video-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.bg-video-play-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.bg-video-play-row .hint { flex: 1 1 auto; margin: 0 }
/* 背景画廊：九张卡片直接看效果，替代单个下拉 */
.bg-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
  margin-top: 6px;
}
.bg-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px;
  overflow: hidden;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--track);
  color: var(--fg);
  text-align: left;
  line-height: 1.2;
  cursor: pointer;
}
.bg-card:hover { border-color: var(--accent); }
.bg-card.is-active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent) }
.bg-swatch {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 52px;
  overflow: hidden;
  border-radius: 5px;
  background-color: #0A1020;
}
.bg-swatch img { width: 100%; height: 100%; object-fit: cover; }
.bg-swatch-off { background: linear-gradient(135deg, #0A1020, #05070D); }
.bg-swatch-deep {
  background:
    radial-gradient(80% 90% at 18% 12%, rgba(58, 123, 255, 0.5), transparent 62%),
    radial-gradient(80% 90% at 84% 88%, rgba(57, 255, 209, 0.18), transparent 60%),
    #05070D;
}
.bg-swatch-aurora {
  background:
    radial-gradient(90% 100% at 82% 0%, rgba(57, 255, 209, 0.4), transparent 60%),
    radial-gradient(90% 100% at 8% 100%, rgba(120, 80, 255, 0.45), transparent 62%),
    #05070D;
}
.bg-swatch-stars {
  background:
    radial-gradient(1px 1px at 18% 24%, #E8F1FF, transparent 55%),
    radial-gradient(1px 1px at 38% 68%, #39FFD1, transparent 55%),
    radial-gradient(1px 1px at 58% 34%, #E8F1FF, transparent 55%),
    radial-gradient(1px 1px at 76% 76%, #8FA8CC, transparent 55%),
    radial-gradient(1px 1px at 88% 28%, #39FFD1, transparent 55%),
    #05070D;
}
.bg-swatch-mist {
  background:
    radial-gradient(90% 80% at 20% 30%, rgba(138, 164, 230, 0.35), transparent 62%),
    radial-gradient(90% 80% at 80% 70%, rgba(57, 255, 209, 0.18), transparent 65%),
    linear-gradient(180deg, #142847, #05070D);
}
.bg-swatch-polar {
  background:
    linear-gradient(118deg, transparent 18%, rgba(57, 255, 209, 0.35) 34%, transparent 52%),
    linear-gradient(242deg, transparent 24%, rgba(120, 80, 255, 0.35) 46%, transparent 62%),
    #05070D;
}
.bg-swatch-warm {
  background:
    radial-gradient(90% 100% at 20% 18%, rgba(255, 170, 90, 0.45), transparent 65%),
    radial-gradient(90% 100% at 82% 82%, rgba(255, 110, 138, 0.32), transparent 62%),
    #05070D;
}
.bg-swatch-video {
  background:
    radial-gradient(80% 90% at 50% 40%, rgba(58, 123, 255, 0.32), transparent 65%),
    #05070D;
}
.bg-swatch-play { color: #B9E8E0; font-size: 14px; }
.bg-swatch-custom {
  border: 1px dashed var(--line);
  background: rgba(5, 7, 13, 0.6);
}
.bg-swatch-plus { color: var(--fg-faint); font-size: 18px; }
/* 浅色下缩略图换成同一氛围的淡彩版：否则「画廊预览是深色、切过去是浅色」，
   用户按缩略图选不到自己以为的效果（配色与 main.css 的浅色 ::before 同源） */
html:not(.dark) .bg-swatch { background-color: #F4F4F4; }
html:not(.dark) .bg-swatch-off { background: linear-gradient(135deg, #F7F8FB, #E9EBF0); }
html:not(.dark) .bg-swatch-deep {
  background:
    radial-gradient(80% 90% at 18% 12%, rgba(83, 107, 169, 0.32), transparent 62%),
    radial-gradient(80% 90% at 84% 88%, rgba(42, 170, 150, 0.22), transparent 60%),
    #F4F4F4;
}
html:not(.dark) .bg-swatch-aurora {
  background:
    radial-gradient(90% 100% at 82% 0%, rgba(42, 190, 170, 0.32), transparent 60%),
    radial-gradient(90% 100% at 8% 100%, rgba(130, 100, 220, 0.3), transparent 62%),
    #F4F4F4;
}
html:not(.dark) .bg-swatch-stars {
  background:
    radial-gradient(2px 2px at 18% 24%, rgba(31, 42, 68, 0.7), transparent 60%),
    radial-gradient(2px 2px at 38% 68%, rgba(28, 130, 112, 0.65), transparent 60%),
    radial-gradient(2px 2px at 58% 34%, rgba(31, 42, 68, 0.6), transparent 60%),
    radial-gradient(2px 2px at 76% 76%, rgba(83, 107, 169, 0.6), transparent 60%),
    radial-gradient(2px 2px at 88% 28%, rgba(28, 130, 112, 0.6), transparent 60%),
    #F4F4F4;
}
html:not(.dark) .bg-swatch-mist {
  background:
    radial-gradient(90% 80% at 20% 30%, rgba(138, 164, 230, 0.38), transparent 62%),
    radial-gradient(90% 80% at 80% 70%, rgba(120, 200, 190, 0.28), transparent 65%),
    linear-gradient(180deg, #EEF3FB, #F4F4F4);
}
html:not(.dark) .bg-swatch-polar {
  background:
    linear-gradient(118deg, transparent 18%, rgba(42, 170, 150, 0.3) 34%, transparent 52%),
    linear-gradient(242deg, transparent 24%, rgba(130, 100, 220, 0.28) 46%, transparent 62%),
    #F4F4F4;
}
html:not(.dark) .bg-swatch-warm {
  background:
    radial-gradient(90% 100% at 20% 18%, rgba(255, 170, 90, 0.4), transparent 65%),
    radial-gradient(90% 100% at 82% 82%, rgba(255, 110, 138, 0.28), transparent 62%),
    #F4F4F4;
}
html:not(.dark) .bg-swatch-video {
  background:
    radial-gradient(80% 90% at 50% 40%, rgba(83, 107, 169, 0.3), transparent 65%),
    #F4F4F4;
}
html:not(.dark) .bg-swatch-play { color: #3A5B8F; }
html:not(.dark) .bg-swatch-custom { background: rgba(244, 244, 244, 0.85); }
.bg-card-name { overflow: hidden; font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.bg-card-note { overflow: hidden; font-size: 10px; color: var(--fg-faint); white-space: nowrap; text-overflow: ellipsis; }

/* 背景媒体预览：缩略图 + 类型/体积 + 管理入口 */
.bg-media-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0;
  padding: 8px;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--track);
}
.bg-media-preview img,
.bg-media-preview-kind {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 96px;
  height: 54px;
  overflow: hidden;
  border-radius: 6px;
  object-fit: cover;
  background: rgba(0, 0, 0, 0.2);
  color: var(--fg-dim);
  font-size: 11px;
}
.bg-media-preview-meta {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--fg-faint);
  font-size: 11px;
}
/* 背景滑杆预设 */
.bg-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 0 8px;
}
.bg-tune {
  margin: 8px 0 12px;
}
/* 视频播放中：只留一行紧凑的重播入口 */
.bg-video-replay-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin: 6px 0 0;
}
.bg-video-replay-row .hint {
  margin: 0;
  font-size: 11px;
}
.bg-video-credit {
  margin: 8px 0 0;
  font-size: 11px;
  opacity: 0.8;
}
.bg-video-credit a {
  color: var(--accent);
}
/* 启动片头：说明文字与「预览片头」按钮同一行，按钮在右侧 */
.boot-intro-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0 12px;
}
.boot-intro-row .hint {
  flex: 1 1 auto;
  margin: 0;
}
.boot-intro-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
  margin-left: auto;
}
.boot-intro-actions .link-btn {
  white-space: nowrap;
}
</style>