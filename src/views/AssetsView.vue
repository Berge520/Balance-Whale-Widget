<script lang="ts" setup>
// ============================================================================
// 资源页：素材集中管理（概览 / 导入的形象 / 导入的气泡图 / 导入的音效 / 内置资源 /
// 共享角色 / 共享音效库）。
// 与「挂件外观」分工：那边只选「用哪个」，这里管「导了什么、占多大、要不要删、换机器怎么带走」。
// 抽出约定：素材状态（skinGallery / soundsMeta / bubbleItems 等）由父级持有并 props 下传，
// 本组件只做展示与交互，改动一律 emit('patch', {...}) 或语义化事件上抛，
// 不直接改写 cfg / 不直接落盘（导入形象、导入音效的两个裁剪弹层归父级所有）。
// ============================================================================
import { computed, onMounted, onUnmounted, reactive, ref, watch, nextTick } from 'vue'
import type {
  AssetsApplyResult, AssetsExportResult, AssetsPreviewResult, BubbleMeta, DownloadProgress,
  SharedSkinList, SharedSoundItem, SharedSoundList, SkinGallery, SkinMeta, SkinPackList,
  SoundMeta, SoundRole, AlertRole, WhaleServices,
} from '../types/services'

// 统一的消息态：msg 为空表示不显示
type Flash = { msg: string; err: boolean }
function msgCls(f: { err: boolean }) {
  return f.err ? 'msg err' : 'msg ok'
}
// 缩略图整理菜单里的提示完全是组件内的瞬时反馈（点一下就写一句、父级不消费），
// 故自持本地草稿，避免改写父级 prop（vue/no-mutating-props）
const skinFlash = reactive<Flash>({ msg: '', err: false })

const props = defineProps<{
  cfg: any
  // 卡片显隐判定：与父级同源（搜索态按 searchHits 命中，否则看 activeTab），
  // 本组件含 7 张可独立命中的卡，故逐段调用而不能整体包一层 v-if
  cardOn: (tab: string, key: string) => boolean
  searchActive: boolean
  services: Partial<WhaleServices>
  // —— 父级持有的素材状态 ——
  skinGallery: SkinGallery
  skinMeta: SkinMeta | null
  skinPicked: string[]
  pickedSkinned: SkinMeta[]
  thumbBroken: Record<string, boolean>
  skinHintOpen: boolean
  soundsMeta: Record<SoundRole, SoundMeta[]>
  soundData: Record<SoundRole, string[]>
  soundFlash: Flash
  bubbleItems: BubbleMeta[]
  bubbleFlash: Flash
  hasAssets: boolean
  skinUnused: boolean
  soundUnused: boolean
  // —— 父级的折叠 / 忙碌态（与 assets 卡片联动） ——
  // 折叠态归父级（App.vue 另有 watch 自动展开的逻辑），本组件只读 + emit 回改
  builtinFold: boolean
  assetsBusy: boolean
  // 读打包缩略图转 data URL（下共享角色时一并落盘）：LookView 域的 backfillMissingThumbs 也用，父级唯一来源
  sharedSkinThumbDataUrl: (id: string) => Promise<string>
  // —— 父级常量（值来自父级，避免容器双写） ——
  builtinSkins: string[]
  legacyBuiltinSkins: string[]
  // 可下载形象的 id + 体积（清单里没有 name，展示名一律回落成 id，见 skinPackLabel）
  skinPackSkins: Array<{ id: string; size: number }>
  sharedSkinPackSkins: Array<{ id: string; name: string }>
}>()

const emit = defineEmits<{
  (e: 'patch', patch: Record<string, unknown>): void
  // 素材相关的宿主操作（父级调 services 落盘后自行刷新）
  (e: 'import-skin'): void
  (e: 'use-skin', id: string): void
  (e: 'pick-skin', id: string): void
  (e: 'use-skin-pick', id: string): void
  (e: 'remove-skin', id: string): void
  (e: 'remove-skins', ids: string[]): void
  (e: 'use-picked'): void
  (e: 'pin-picked'): void
  (e: 'bottom-picked'): void
  (e: 'apply-picked-random', on: boolean): void
  (e: 'remove-picked'): void
  (e: 'batch-random', mode: 'all' | 'none' | 'keepCurrent'): void
  (e: 'move-skins', ids: string[], index: number, label?: string): void
  (e: 'random-skin'): void
  (e: 'thumb-error', key: string): void
  (e: 'toggle-builtin-fold', on: boolean): void
  (e: 'preview-sound', role: SoundRole, idx: number): void
  (e: 'import-sound', role: SoundRole): void
  (e: 'remove-sound', role: SoundRole, file?: string): void
  (e: 'import-bubble'): void
  (e: 'remove-bubble', id: string): void
  (e: 'clear-unused'): void
  (e: 'clear-assets'): void
  // 皮肤挑选态 / 操作说明折叠 / 内置音色试听：父级持有共享状态
  (e: 'clear-picked'): void
  (e: 'toggle-skin-hint'): void
  (e: 'preview-builtin', url: string): void
  (e: 'stop-preview'): void
  (e: 'refresh-sounds'): void
  (e: 'refresh-skin'): void
  (e: 'refresh-bubbles'): void
  (e: 'refresh-skin-packs'): void
  (e: 'refresh-shared-skins'): void
  (e: 'refresh-shared-sounds'): void
}>()

const services = computed(() => props.services)

// —— 通用小工具（与父级同源，避免各处重复实现） ——
function fmtBytes(n: number) {
  const v = Number(n) || 0
  if (v <= 0) return '0 KB'
  return v < 1024 * 1024 ? Math.max(1, Math.round(v / 1024)) + ' KB' : (v / 1024 / 1024).toFixed(1) + ' MB'
}
const SOUND_ROLES: SoundRole[] = ['press', 'release', 'low', 'budget', 'peak', 'pass']
const ALERT_SOUND_ROLES: AlertRole[] = ['low', 'budget', 'peak', 'pass']
const SOUND_ROLE_LABEL: Record<SoundRole, string> = {
  press: '按压音效',
  release: '释放音效',
  low: '低余额提醒音',
  budget: '预算提醒音',
  peak: '峰谷提醒音',
  pass: '穿透提醒音',
}
const ALERT_SOUND_WHEN: Record<string, string> = {
  low: '余额首次跌破预警阈值时',
  budget: '今日用量首次超出预算时',
  peak: '进入峰时段 / 谷时段时',
  pass: '切换鼠标穿透时',
}

// —— 音效（六槽位） ——
function soundMetaOf(role: SoundRole): SoundMeta[] {
  return props.soundsMeta[role] || []
}
function doPreviewSound(role: SoundRole, idx: number) {
  emit('preview-sound', role, idx)
}
function doImportSound(role: SoundRole) {
  emit('import-sound', role)
}
function doRemoveSound(role: SoundRole, file?: string) {
  emit('remove-sound', role, file)
}

// —— 素材总览 / 占用统计 ——
const importedSoundCount = computed(() => SOUND_ROLES.reduce((n, r) => n + (props.soundsMeta[r] || []).length, 0))
const assetTotalBytes = computed(() => {
  let n = 0
  for (const it of props.skinGallery.items) n += Number(it.size) || 0
  for (const it of props.bubbleItems) n += Number(it.size) || 0
  for (const r of SOUND_ROLES) for (const it of (props.soundsMeta[r] || [])) n += Number(it.size) || 0
  return n
})
function assetSize(m: { size?: number } | null | undefined) {
  const n = Number(m && m.size) || 0
  return n > 0 ? fmtBytes(n) : '体积未知'
}
function pad2(n: number) {
  return n < 10 ? '0' + n : '' + n
}
function assetAt(m: { at?: number } | null | undefined) {
  const t = Number(m && m.at) || 0
  if (!t) return '时间未知'
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
function assetAtShort(m: { at?: number } | null | undefined) {
  const t = Number(m && m.at) || 0
  if (!t) return '时间未知'
  const d = new Date(t)
  const now = new Date()
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, now)) return '今天 ' + hm
  const y = new Date(now.getTime() - 86400000)
  if (sameDay(d, y)) return '昨天 ' + hm
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
}

// 未使用统计：磁盘上有、但按当前设置不会播放 / 显示的素材
const unusedSkinIds = computed(() => {
  const cur = props.cfg.skin === 'custom' ? props.skinGallery.current : ''
  return props.skinGallery.items.filter((it) => it.id !== cur).map((it) => it.id)
})
const unusedSoundRoles = computed(() => {
  const out: SoundRole[] = []
  for (const r of SOUND_ROLES) {
    if (!(props.soundsMeta[r] || []).length) continue
    if (!props.cfg.soundOn) { out.push(r); continue }
    if (r === 'press' || r === 'release') { if (props.cfg.soundSet !== 'custom') out.push(r); continue }
    if (r === 'low' ? !props.cfg.lowAlertOn
      : r === 'budget' ? !props.cfg.budgetOn
        : r === 'peak' ? !props.cfg.peakRemindOn
          : !props.cfg.passThrough) out.push(r)
  }
  return out
})
const unusedCount = computed(() => unusedSkinIds.value.length + unusedSoundRoles.value.length)

// —— 折叠 / 目录 / 素材包 ——
const assetsFold = reactive({ open: false })
const galleryFolds = reactive({ skins: false, sharedSkins: false, sharedSounds: false })
function galleryOpen(key: 'skins' | 'sharedSkins' | 'sharedSounds') {
  return props.searchActive || galleryFolds[key]
}
const assetsFlash: Flash = reactive({ msg: '', err: false })
const dataDirs = ref<{ skins: string; sounds: string; bubbles: string } | null>(null)
const dataDirsOpen = ref(false)
function toggleDataDirs() {
  dataDirsOpen.value = !dataDirsOpen.value
  if (dataDirsOpen.value && !dataDirs.value) {
    try { dataDirs.value = services.value.dataDirs?.() || null } catch (err) { dataDirs.value = null }
  }
}
function openDataDir(p: string) {
  if (!p) return
  assetsFlash.msg = ''
  assetsFlash.err = false
  try {
    const r = services.value.openDir?.(p)
    if (!r || !r.ok) {
      assetsFlash.err = true
      assetsFlash.msg = '打开目录失败，可手动复制上面的路径到文件管理器'
    }
  } catch (err: any) {
    assetsFlash.err = true
    assetsFlash.msg = '打开目录失败：' + String(err?.message || err)
  }
}

const assetsPack = ref<AssetsPreviewResult | null>(null)
const assetsPicks = reactive({ skins: true, sounds: true, bubbles: true })
const assetsConfirm = ref(false)
const assetsAnyItem = computed(() => (assetsPicks.skins && !!assetsPack.value?.has?.skins)
  || (assetsPicks.sounds && !!assetsPack.value?.has?.sounds)
  || (assetsPicks.bubbles && !!assetsPack.value?.has?.bubbles))
function doExportAssets() {
  if (props.assetsBusy) return
  assetsFlash.msg = ''
  assetsFlash.err = false
  try {
    const r: AssetsExportResult | undefined = services.value.assetsExport?.()
    if (!r || (!r.ok && !r.canceled)) {
      assetsFlash.err = true
      assetsFlash.msg = '导出失败：' + ((r && r.error) || '未知错误')
    } else if (r.canceled) {
      assetsFlash.msg = '已取消导出'
    } else {
      assetsFlash.msg = `已导出素材包（形象 ${r.skins || 0} 张 · 气泡图 ${r.bubbles || 0} 张 · 音效 ${r.sounds || 0} 段）：${r.path}`
    }
  } catch (err: any) {
    assetsFlash.err = true
    assetsFlash.msg = '导出失败：' + String(err?.message || err)
  }
}
function doPickAssets() {
  if (props.assetsBusy) return
  assetsFlash.msg = ''
  assetsFlash.err = false
  assetsConfirm.value = false
  assetsPack.value = null
  try {
    const r: AssetsPreviewResult | undefined = services.value.assetsPick?.()
    if (!r || (!r.ok && !r.canceled)) {
      assetsFlash.err = true
      assetsFlash.msg = '读取失败：' + ((r && r.error) || '未知错误')
    } else if (r.canceled) {
      assetsFlash.msg = '已取消导入'
    } else {
      assetsPack.value = r
      assetsPicks.skins = !!r.has?.skins
      assetsPicks.sounds = !!r.has?.sounds
      assetsPicks.bubbles = !!r.has?.bubbles
      assetsFlash.msg = '已读取素材包，勾选要导入的内容后点「导入选中项」'
    }
  } catch (err: any) {
    assetsFlash.err = true
    assetsFlash.msg = '读取失败：' + String(err?.message || err)
  }
}
function doApplyAssets() {
  if (props.assetsBusy || !assetsAnyItem.value) return
  if (!assetsConfirm.value) {
    assetsConfirm.value = true
    assetsFlash.msg = ''
    assetsFlash.err = false
    return
  }
  assetsConfirm.value = false
  try {
    const r: AssetsApplyResult | undefined = services.value.assetsApply?.({
      skins: assetsPicks.skins, sounds: assetsPicks.sounds, bubbles: assetsPicks.bubbles,
    })
    if (!r || !r.ok) {
      assetsFlash.err = true
      assetsFlash.msg = '导入失败：' + ((r && r.error) || '未知错误')
    } else {
      const parts: string[] = []
      if (r.skins) parts.push(`形象新增 ${r.skins.added} 张${r.skins.skipped ? `（${r.skins.skipped} 张因画廊已满跳过）` : ''}`)
      if (r.bubbles) parts.push(`气泡图新增 ${r.bubbles.added} 张${r.bubbles.skipped ? `（${r.bubbles.skipped} 张因已满跳过）` : ''}`)
      if (r.sounds) parts.push(`音效写入 ${r.sounds.applied} 段`)
      let msg = '已导入素材包：' + (parts.join(' · ') || '没有可写入的内容') + '。'
      assetsFlash.err = false
      if (r.errors && r.errors.length) { msg += r.errors.join('；'); assetsFlash.err = true }
      assetsFlash.msg = msg
      assetsPack.value = null
      emit('refresh-skin')
      emit('refresh-skin-packs')
      emit('refresh-shared-skins')
      emit('refresh-bubbles')
      emit('refresh-sounds')
    }
  } catch (err: any) {
    assetsFlash.err = true
    assetsFlash.msg = '导入失败：' + String(err?.message || err)
  }
}
function doCancelAssets() {
  assetsPack.value = null
  assetsConfirm.value = false
  assetsFlash.msg = ''
  try { services.value.assetsCancel?.() } catch (err) { /* 预期分支：宿主不支持或窗口已关，取消本身无需反馈 */ }
}
function roleLabelOf(r: string) {
  return SOUND_ROLE_LABEL[r as SoundRole] || r
}
const assetsSkinNames = computed(() => (assetsPack.value?.skinNames || []).join('、'))
const assetsBubbleNames = computed(() => (assetsPack.value?.bubbleNames || []).join('、'))
const assetsSoundNames = computed(() => (assetsPack.value?.soundRoles || []).map(roleLabelOf).join('、'))
function packLine(n: number | undefined, unit: string, detail: string) {
  return n ? `${n} ${unit}：${detail}` : '包里没有这一项'
}

// —— 随机 / 选中 / 整理面板 ——
const rndMenu = ref('')
const rndPanelPos = reactive({ left: 0, top: 0, minWidth: 0 })
function closeRndMenu() {
  rndMenu.value = ''
}
function toggleRndMenu(e: MouseEvent) {
  if (rndMenu.value) { closeRndMenu(); return }
  const btn = e.currentTarget as HTMLElement
  const r = btn.getBoundingClientRect()
  // 按视口坐标钳制而不是靠 right 对齐：按钮文案会在「整理」与「已选 N 张」之间变长，
  // right 对齐会把面板左边缘一路往左推，位置随选中数漂。这里先按按钮左边缘定位，
  // 再减到不出右边界（留 8px），宽度因此只跟内容走，跟按钮文案无关
  const w = Math.max(r.width, 180)
  rndPanelPos.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
  rndPanelPos.top = r.bottom + 6
  rndPanelPos.minWidth = w
  rndMenu.value = 'organize'
}
const randomSkinPool = computed(() => props.skinGallery.items.filter((it) => it.random).map((it) => it.id))
// 选中 id 是父级持有的；「整理」面板的按钮文案 / 禁用态却按**当前可见清单**算数量。
// 普通来源下二者恒等，但「共享形象」来源是个独立画廊：切过去时父级仍留着导入形象的选中 id，
// pickedSkinned.length 会显示一个当前页面上根本点不出来的数，直接从 props 里滤掉这一批
const pickedVisible = computed(() => {
  const ids = new Set(props.skinGallery.items.map((it) => it.id))
  return props.pickedSkinned.filter((it) => ids.has(it.id))
})
// 「随机时抽哪些」本质是一组互斥模式，而不是三个各自独立的批量动作 —— 三个按钮平铺时，
// 用户得自己比对各池大小才知道当前处于哪种状态，而且很容易把「抽」与「不抽」按反。
// 这里把现状算成 mode，模板据此标出命中项（✓）并把「点了也不改变现状」的那项置灰。
// 注意 n 为 0 时一律视为 none：空画廊没有当前张，「只留当前」也无从谈起。
// 返回 '' 表示「三种都不命中」（部分参与随机的混杂状态），此时三项全可点，没有勾
const randomMode = computed<'all' | 'none' | 'keepCurrent' | ''>(() => {
  const n = props.skinGallery.items.length
  if (!n) return 'none'
  const pool = randomSkinPool.value.length
  if (pool === 0) return 'none'
  if (pool >= n) return 'all'
  if (pool === 1 && randomSkinPool.value[0] === props.skinGallery.current) return 'keepCurrent'
  return ''
})
// 这一组里哪些项点了会改变现状（= 可点）。三项共用一套判定，避免像原来那样各写各的
// 禁用条件、各错各的（原「全部不参与随机」写的是 pool === 0 才禁用，语义正好反了）
const randomChoices = computed(() => {
  const n = props.skinGallery.items.length
  const hasCurrent = !!props.skinGallery.current && props.skinGallery.items.some((it) => it.id === props.skinGallery.current)
  return [
    { mode: 'all' as const, label: '随机时会抽到它们', on: randomMode.value === 'all' },
    { mode: 'none' as const, label: '随机时都不抽', on: randomMode.value === 'none' },
    { mode: 'keepCurrent' as const, label: '只抽「使用中」那张', on: randomMode.value === 'keepCurrent' },
  ].map((c) => ({ ...c, usable: n > 0 && (c.mode !== 'keepCurrent' || hasCurrent) && randomMode.value !== c.mode }))
})
function doRandomSkin() {
  emit('random-skin')
}
function doBatchRandom(mode: 'all' | 'none' | 'keepCurrent') {
  emit('batch-random', mode)
}
function doUseSkin(id: string) {
  emit('use-skin', id)
}
// 单击缩略图的反馈：选中是「整理」面板的前置状态，若不给一句文案，
// 用户点完只看到描边变化，未必意识到卡头那个按钮已经换成「已选 N 张」。
// 只在选中（而非取消选中）时说一句，取消是用户主动反悔，不必再确认一遍
function onSkinPicked(id: string, picked: boolean) {
  emit('pick-skin', id)
  if (picked) {
    skinFlash.err = false
    skinFlash.msg = '已选中 1 张：可连点多张，再到卡头「整理」里统一使用 / 排序 / 删除'
  }
}
function doUseSkinPick(id: string) {
  emit('use-skin-pick', id)
}
function doUsePicked() {
  emit('use-picked')
}
function doPinPicked() {
  emit('pin-picked')
}
function doBottomPicked() {
  emit('bottom-picked')
}
function applyPickedRandom(on: boolean) {
  emit('apply-picked-random', on)
}
function doRemovePicked() {
  emit('remove-picked')
}
function doRemoveSkin(id: string) {
  emit('remove-skin', id)
}
function doImportSkin() {
  emit('import-skin')
}
function onThumbError(key: string) {
  emit('thumb-error', key)
}

// 拖拽排序：三态（draggingId / dragOverId / dragOverAfter）
const draggingId = ref('')
const dragOverId = ref('')
const dragOverAfter = ref(false)
function onSkinDragStart(id: string, e: DragEvent) {
  draggingId.value = id
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id) }
}
function onSkinDragOver(it: SkinMeta, e: DragEvent) {
  if (!draggingId.value || draggingId.value === it.id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  dragOverId.value = it.id
  dragOverAfter.value = e.clientX > r.left + r.width / 2
}
function onSkinDragEnd() {
  draggingId.value = ''
  dragOverId.value = ''
  dragOverAfter.value = false
}
function onSkinDrop(it: SkinMeta, e: DragEvent) {
  e.preventDefault()
  const from = draggingId.value
  const after = dragOverAfter.value
  draggingId.value = ''
  dragOverId.value = ''
  dragOverAfter.value = false
  if (!from || from === it.id) return
  const ids = props.skinGallery.items.map((x) => x.id).filter((id) => id !== from)
  let index = ids.indexOf(it.id)
  if (index < 0) return
  if (after) index += 1
  emit('move-skins', [from], index, '已移动 1 张')
}

// —— 气泡图 ——
function doImportBubble() {
  emit('import-bubble')
}
function doRemoveBubble(id: string) {
  emit('remove-bubble', id)
}

// —— 内置资源 / 形象包 ——
const BUILTIN_SOUND_SETS: Array<{ key: string; label: string; press: string; release: string }> = [
  { key: 'duck', label: '小黄鸭', press: './whale/Ya1.mp3', release: './whale/Ya2.mp3' },
  { key: 'fx1', label: '音效 1', press: './whale/D1.mp3', release: './whale/D2.mp3' },
]
const SKIN_PACK_PREFIX_MAX = 200
const builtinFlash: Flash = reactive({ msg: '', err: false })
function builtinSkinUrl(id: string) {
  return './whale/' + encodeURIComponent(id) + '.webp'
}
function doPreviewBuiltin(url: string) {
  builtinFlash.msg = ''
  builtinFlash.err = false
  emit('preview-builtin', url)
}
function skinPackThumb(id: string) {
  return './whale-pack/thumbs/' + encodeURIComponent(id) + '.webp'
}

const skinPackList = ref<SkinPackList | null>(null)
const skinPackBusy = ref(false)
const skinPackFlash: Flash = reactive({ msg: '', err: false })
const skinPackInstalled = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {}
  for (const it of (skinPackList.value?.items || [])) out[it.id] = it.installed === true
  return out
})
const skinPackItems = computed(() => skinPackList.value?.items || [])
const skinPackInstalledCount = computed(() => skinPackItems.value.filter((it) => it.installed).length)
const skinPackInstalledAny = computed(() => skinPackInstalledCount.value > 0)
const skinPackAllInstalled = computed(() => !!skinPackItems.value.length && skinPackInstalledCount.value >= skinPackItems.value.length)
const skinPackRemainBytes = computed(() => skinPackItems.value.reduce((n, it) => n + (it.installed ? 0 : Number(it.size) || 0), 0))
const skinPackBytes = computed(() => props.skinPackSkins.reduce((n, s) => n + (Number(s.size) || 0), 0))
// 可下载形象的展示名。清单里没有 name 字段（DSniang02 是「DS 娘」的 id，中文名无意义），
// 于是各处一律走它回落成 id —— 全卡统一，免得标题用 name、缩略图用 id，两处对不上
// （曾踩：一面写「内置形象」一面标 id，用户以为点错了卡）。
function skinPackLabel(id: string) {
  return id
}
// 「正在使用的形象当前拿不到」：配置里选的是历史内置形象，但本地还没下载回来（静默降级）
const skinInUseMissing = computed<boolean>(() => {
  const s = props.cfg.skin
  if (!s || s === 'custom') return false
  if (props.builtinSkins.includes(s)) return false
  if (!props.legacyBuiltinSkins.includes(s)) return false
  return skinPackInstalled.value[s] !== true
})
const missingSkinName = computed(() => (skinInUseMissing.value ? props.cfg.skin : ''))
const builtinFoldAutoOpened = ref(false)
watch(skinInUseMissing, (v) => {
  if (v && !builtinFoldAutoOpened.value) {
    builtinFoldAutoOpened.value = true
    emit('toggle-builtin-fold', true)
  }
}, { immediate: true })
function refreshSkinPacks() {
  const r = services.value.listSkinPacks?.()
  skinPackList.value = r && Array.isArray(r.items) ? r : null
}
async function doDownloadSkinPacks() {
  if (skinPackBusy.value) return
  skinPackFlash.msg = ''
  skinPackFlash.err = false
  skinPackBusy.value = true
  dlTickStart()
  try {
    const r = await services.value.downloadSkinPacks?.(props.cfg.skinPackSrc || '')
    emit('refresh-skin')
    refreshSkinPacks()
    if (!r || !r.ok) {
      skinPackFlash.msg = (r && r.error) || '下载失败，请稍后重试'
      skinPackFlash.err = true
      return
    }
    const n = (r.installed || []).length
    skinPackFlash.msg = n ? `已下载 ${n} 张形象`
      : (r.errors && r.errors.length ? `部分形象未能写入：${r.errors[0]}` : '形象已是最新，无需重复下载')
    skinPackFlash.err = !!(r.errors && r.errors.length)
  } finally {
    skinPackBusy.value = false
  }
}
async function doSkinPackCell(id: string) {
  if (skinPackInstalled.value[id]) { doUseSkin(id); return }
  await doDownloadSkinPacks()
  if (skinPackInstalled.value[id]) doUseSkin(id)
}

// —— 共享角色 ——
function sharedSkinThumb(id: string) {
  return './resources/thumbs/' + encodeURIComponent(id) + '.webp'
}
// sharedSkinThumbDataUrl（读打包缩略图转 data URL）留在父级：LookView 域的
// backfillMissingThumbs 也要用它补老数据缺的缩略图，父级唯一来源，这里用 prop 收。
const sharedSkinList = ref<SharedSkinList | null>(null)
const sharedSkinBusy = ref(false)
const sharedSkinFlash: Flash = reactive({ msg: '', err: false })
const sharedSkinInstalled = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {}
  for (const it of (sharedSkinList.value?.items || [])) out[it.id] = it.installed === true
  return out
})
const sharedSkinItems = computed(() => sharedSkinList.value?.items || [])
const sharedSkinInstalledCount = computed(() => sharedSkinItems.value.filter((it) => it.installed).length)
const sharedSkinAllInstalled = computed(() => !!sharedSkinItems.value.length && sharedSkinInstalledCount.value >= sharedSkinItems.value.length)
const sharedSkinRemainBytes = computed(() => Number(sharedSkinList.value?.totalSize || 0)
  - sharedSkinItems.value.reduce((n, it) => n + (it.installed ? (Number(it.size) || 0) : 0), 0))
const sharedSkinTotalBytes = computed(() => Number(sharedSkinList.value?.totalSize || 0))
const sharedSkinNames = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const s of props.sharedSkinPackSkins) out[s.id] = s.name
  return out
})
function refreshSharedSkins() {
  const r = services.value.listSharedSkins?.()
  sharedSkinList.value = r && Array.isArray(r.items) ? r : null
}
async function doDownloadSharedSkins() {
  if (sharedSkinBusy.value) return
  sharedSkinFlash.msg = ''
  sharedSkinFlash.err = false
  sharedSkinBusy.value = true
  dlTickStart()
  try {
    const todo = sharedSkinItems.value.filter((it) => !it.installed)
    const failed: string[] = []
    for (const it of todo) {
      const r = await services.value.downloadSharedSkin?.(it.id, props.cfg.skinPackSrc || '',
        await props.sharedSkinThumbDataUrl(it.id))
      if (!r || !r.ok) failed.push(it.name + '：' + ((r && r.error) || '下载失败'))
      refreshSharedSkins()
      emit('refresh-skin')
    }
    const okCount = todo.length - failed.length
    if (failed.length) {
      sharedSkinFlash.msg = `已下载 ${okCount} 张，${failed.length} 张失败 —— ${failed[0]}`
      sharedSkinFlash.err = true
      return
    }
    sharedSkinFlash.msg = todo.length ? `已下载 ${todo.length} 张共享角色` : '共享角色已是最新，无需重复下载'
    sharedSkinFlash.err = false
  } finally {
    sharedSkinBusy.value = false
  }
}
async function doSharedSkinCell(id: string) {
  if (sharedSkinInstalled.value[id]) { doUseSkin(id); return }
  if (sharedSkinBusy.value) return
  sharedSkinFlash.msg = ''
  sharedSkinFlash.err = false
  sharedSkinBusy.value = true
  dlTickStart()
  try {
    const r = await services.value.downloadSharedSkin?.(id, props.cfg.skinPackSrc || '',
      await props.sharedSkinThumbDataUrl(id))
    emit('refresh-skin')
    refreshSharedSkins()
    if (!r || !r.ok) {
      sharedSkinFlash.msg = (r && r.error) || '下载失败，请稍后重试'
      sharedSkinFlash.err = true
      return
    }
    sharedSkinFlash.msg = `已下载「${r.name || id}」`
    sharedSkinFlash.err = false
    doUseSkin(id)
  } finally {
    sharedSkinBusy.value = false
  }
}

// —— 共享音效库（落 sounds 的 shared 槽位，是素材池，不直接参与实播） ——
const sharedSoundList = ref<SharedSoundList | null>(null)
const sharedSoundBusy = ref(false)
const sharedSoundFlash: Flash = reactive({ msg: '', err: false })
const sharedSoundItems = computed(() => sharedSoundList.value?.items || [])
const sharedSoundInstalledCount = computed(() => sharedSoundItems.value.filter((it) => it.installed).length)
const sharedSoundAllInstalled = computed(() => !!sharedSoundItems.value.length && sharedSoundInstalledCount.value >= sharedSoundItems.value.length)
const sharedSoundTotalBytes = computed(() => Number(sharedSoundList.value?.totalSize || 0))
const sharedSoundInstalledItems = computed(() => sharedSoundItems.value.filter((it) => it.installed))
const sharedSoundPendingItems = computed(() => sharedSoundItems.value.filter((it) => !it.installed))
const sharedSoundPendingOpen = ref(false)
const previewingSharedId = ref<string | null>(null)
const removeConfirmId = ref<string | null>(null)
let removeConfirmTimer: ReturnType<typeof setTimeout> | null = null
const sharedSoundRemainBytes = computed(() => Number(sharedSoundList.value?.totalSize || 0)
  - sharedSoundItems.value.reduce((n, it) => n + (it.installed ? (Number(it.size) || 0) : 0), 0))
const sharedSoundUseRole = reactive<Record<string, SoundRole>>({})
function refreshSharedSounds() {
  const r = services.value.listSharedSounds?.()
  sharedSoundList.value = r && Array.isArray(r.items) ? r : null
}
async function doDownloadSharedSounds() {
  if (sharedSoundBusy.value) return
  sharedSoundFlash.msg = ''
  sharedSoundFlash.err = false
  sharedSoundBusy.value = true
  dlTickStart()
  try {
    const todo = sharedSoundItems.value.filter((it) => !it.installed)
    const failed: string[] = []
    for (const it of todo) {
      const r = await services.value.downloadSharedSound?.(it.id, props.cfg.skinPackSrc || '')
      if (!r || !r.ok) failed.push(it.name + '：' + ((r && r.error) || '下载失败'))
      refreshSharedSounds()
      emit('refresh-sounds')
    }
    const okCount = todo.length - failed.length
    if (failed.length) {
      sharedSoundFlash.msg = `已下载 ${okCount} 段，${failed.length} 段失败 —— ${failed[0]}`
      sharedSoundFlash.err = true
      return
    }
    sharedSoundFlash.msg = todo.length ? `已下载 ${todo.length} 段音效（存进「共享音效库」，可到下面选用）` : '共享音效已是最新，无需重复下载'
    sharedSoundFlash.err = false
  } finally {
    sharedSoundBusy.value = false
  }
}
async function doDownloadSharedSound(it: SharedSoundItem) {
  if (sharedSoundBusy.value || it.installed) return
  sharedSoundFlash.msg = ''
  sharedSoundFlash.err = false
  sharedSoundBusy.value = true
  dlTickStart()
  try {
    const r = await services.value.downloadSharedSound?.(it.id, props.cfg.skinPackSrc || '')
    emit('refresh-sounds')
    refreshSharedSounds()
    if (!r || !r.ok) {
      sharedSoundFlash.msg = (r && r.error) || '下载失败，请稍后重试'
      sharedSoundFlash.err = true
      return
    }
    sharedSoundFlash.msg = `已下载「${r.name || it.name}」`
    sharedSoundFlash.err = false
  } finally {
    sharedSoundBusy.value = false
  }
}
function doRemoveSharedSound(it: SharedSoundItem) {
  if (removeConfirmId.value !== it.id) {
    removeConfirmId.value = it.id
    if (removeConfirmTimer) clearTimeout(removeConfirmTimer)
    removeConfirmTimer = setTimeout(() => { removeConfirmId.value = null }, 3000)
    return
  }
  if (removeConfirmTimer) { clearTimeout(removeConfirmTimer); removeConfirmTimer = null }
  removeConfirmId.value = null
  sharedSoundFlash.msg = ''
  sharedSoundFlash.err = false
  const r = services.value.removeSharedSound?.(it.file || '')
  if (!r || !r.ok) {
    sharedSoundFlash.msg = (r && r.error) || '删除失败'
    sharedSoundFlash.err = true
    return
  }
  refreshSharedSounds()
  emit('refresh-sounds')
  // 清掉这段残留的选用值，否则重新下载回同一 id 时下拉会带着上次选择复现
  delete sharedSoundUseRole[it.id]
  if (previewingSharedId.value === it.id) stopPreviewShared()
  const cleared = (r.clearedRoles || [])
  sharedSoundFlash.msg = `已删除「${it.name}」`
    + (cleared.length ? `，并清掉了它在${cleared.map((x) => SOUND_ROLE_LABEL[x] || x).join(' / ')}上的选用` : '')
}
async function doUseSharedSound(it: SharedSoundItem) {
  const role = sharedSoundUseRole[it.id]
  if (!role) return
  const r = services.value.useSharedSound?.(it.file, role)
  emit('refresh-sounds')
  if (r && r.ok) {
    let switched = false
    if (props.cfg.soundOn && props.cfg.soundSet !== 'custom' && (role === 'press' || role === 'release')) {
      emit('patch', { soundSet: 'custom' })
      switched = true
    }
    sharedSoundFlash.msg = `已把「${it.name}」选用到${SOUND_ROLE_LABEL[role] || role}`
      + (switched ? '，并把「音色」切到了「自定义」' : '')
    delete sharedSoundUseRole[it.id]
    sharedSoundFlash.err = false
  } else {
    sharedSoundFlash.msg = (r && r.error) || '选用失败'
    sharedSoundFlash.err = true
  }
}
function doPreviewSharedSound(it: SharedSoundItem) {
  sharedSoundFlash.msg = ''
  sharedSoundFlash.err = false
  if (previewingSharedId.value === it.id) { stopPreviewShared(); return }
  const r = services.value.readSharedSoundData?.(it.file)
  if (!r || !r.ok || !r.url) {
    sharedSoundFlash.msg = (r && r.error) || '没有可试听的音效'
    sharedSoundFlash.err = true
    return
  }
  previewingSharedId.value = it.id
  playAudioUrl(r.url, sharedSoundFlash, () => { previewingSharedId.value = null })
}
function stopPreviewShared() {
  emit('stop-preview')
  previewingSharedId.value = null
}

// —— 内置音色试听（本组件自持音频，父级无需感知） ——
let builtinAudio: HTMLAudioElement | null = null
let builtinOnDone: (() => void) | null = null
function playAudioUrl(url: string, flash: Flash, onDone?: () => void) {
  stopBuiltinAudio()
  builtinOnDone = onDone || null
  try {
    const el = new Audio(url)
    builtinAudio = el
    el.volume = Math.min(1, Math.max(0, Number(props.cfg.vol) || 0))
    el.onended = () => { flash.msg = ''; const cb = builtinOnDone; builtinOnDone = null; builtinAudio = null; if (cb) cb() }
    el.onerror = () => {
      flash.msg = '音效播放失败'
      flash.err = true
      const cb = builtinOnDone; builtinOnDone = null; builtinAudio = null; if (cb) cb()
    }
    void el.play().catch(() => { flash.msg = '音效播放失败'; flash.err = true })
  } catch (err: any) {
    flash.msg = '音效播放失败：' + String(err?.message || err)
    flash.err = true
  }
}
function stopBuiltinAudio() {
  const cb = builtinOnDone
  builtinOnDone = null
  if (builtinAudio) {
    try { builtinAudio.pause(); builtinAudio.currentTime = 0 } catch (err) { /* 预期分支：音频已释放 */ }
    builtinAudio = null
  }
  if (cb) cb()
}

// —— 下载进度（宿主内存快照，轮询） ——
const dlProgress = ref<DownloadProgress | null>(null)
let dlTickTimer = 0
const DL_TICK_MS = 250
const DL_DONE_KEEP_MS = 8000
const DL_CLOCK_SLACK_MS = 2000
function dlTick() {
  let s: DownloadProgress | null = null
  try {
    s = services.value.downloadProgress?.() || null
  } catch (err) { /* 预期分支：宿主快照读不到就当作没有进度，不影响下载本身 */ }
  if (s && (s.phase === 'done' || s.phase === 'failed')
    && Date.now() - Number(s.at || 0) > DL_DONE_KEEP_MS + DL_CLOCK_SLACK_MS) {
    s = null
  }
  dlProgress.value = s
  if (!s || s.phase === 'done' || s.phase === 'failed') dlTickStop()
}
function dlTickStart() {
  dlTick()
  if (!dlTickTimer) dlTickTimer = window.setInterval(dlTick, DL_TICK_MS)
}
function dlTickStop() {
  if (dlTickTimer) { window.clearInterval(dlTickTimer); dlTickTimer = 0 }
}
const dlPercent = computed<number | null>(() => {
  const s = dlProgress.value
  if (!s || !s.totalKnown || !(s.total > 0)) return null
  return Math.max(0, Math.min(100, Math.round((Number(s.received) || 0) / s.total * 100)))
})
const dlAmountText = computed<string>(() => {
  const s = dlProgress.value
  if (!s) return ''
  const got = fmtBytes(Number(s.received) || Number(s.bytes) || 0)
  return s.totalKnown && s.total > 0 ? `${got} / ${fmtBytes(s.total)}` : got
})

// —— 文档级监听：整理面板点外部关闭 ——
// 面板用 Teleport 挂到了 body（见模板注释），不再是 .rnd-menu 的后代，
// 所以「点击是否在面板内」必须额外认 .rnd-menu-panel 这个类
function onDocClickForRndMenu(e: MouseEvent) {
  if (!rndMenu.value) return
  const t = e.target as HTMLElement
  if (t && t.closest && (t.closest('.rnd-menu') || t.closest('.rnd-menu-panel'))) return
  closeRndMenu()
}
// 面板按打开时的视口坐标固定，页面一滚就与按钮脱节（fixed 不会跟着走），索性关掉 —— 下拉的常规行为
function onScrollCloseRndMenu() {
  if (rndMenu.value) closeRndMenu()
}
// 下拉的常规键盘行为：Esc 收起。不做焦点回移，避免在 Teleport 面板里凭空抢焦点
function onKeydownCloseRndMenu(e: KeyboardEvent) {
  if (e.key === 'Escape' && rndMenu.value) closeRndMenu()
}

onMounted(() => {
  refreshSkinPacks()
  refreshSharedSkins()
  refreshSharedSounds()
  dlTick()
  document.addEventListener('click', onDocClickForRndMenu)
  document.addEventListener('keydown', onKeydownCloseRndMenu)
  window.addEventListener('scroll', onScrollCloseRndMenu, true)
})
// 三张画廊卡默认收起，展开才去拉私有数据（共享角色 / 共享音效清单、素材包已装状态）。
// 为什么不放 onMounted 一次拉完：这三张卡是 v-if，本组件挂载时它们并不在 DOM 里，
// onMounted 拉回来的数据会因为没有可见消费方而一直被忽略；等用户点开时又不会再拉，
// 于是「共享形象 / 共享音效」永远显示 0 张（曾踩：展开后一片空，点「下载全部」也没反应）。
// 卡片展开或搜索态强制展开时补拉一次，补齐「onMounted 只覆盖已展开卡」的缺口。
watch(
  () => [galleryOpen('skins'), galleryOpen('sharedSkins'), galleryOpen('sharedSounds'), props.searchActive],
  () => {
    nextTick(() => {
      refreshSkinPacks()
      refreshSharedSkins()
      refreshSharedSounds()
    })
  },
)
onUnmounted(() => {
  dlTickStop()
  stopBuiltinAudio()
  if (removeConfirmTimer) { clearTimeout(removeConfirmTimer); removeConfirmTimer = null }
  document.removeEventListener('click', onDocClickForRndMenu)
  document.removeEventListener('keydown', onKeydownCloseRndMenu)
  window.removeEventListener('scroll', onScrollCloseRndMenu, true)
})

defineExpose({ refreshSkinPacks, refreshSharedSkins, refreshSharedSounds, expandBuiltin: () => { emit('toggle-builtin-fold', true) } })
</script>

<template>
  <div>
    <!-- [资源] 素材集中管理：概览（占用 / 清理 / 素材包）· 导入的形象 · 导入的音效 · 内置资源对照。
         与「挂件外观」分工：那边只选「用哪个」，这里管「导了什么、占多大、要不要删、换机器怎么带走」 -->
    <section v-if="cardOn('assets', 'assetsOverview')" class="card" data-search="assetsOverview">
      <div class="card-head">
        <h2>资源概览</h2>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-outline" type="button" :disabled="!unusedCount" @click="emit('clear-unused')">
            清除未使用{{ unusedCount ? `（${unusedCount}）` : '' }}
          </button>
          <button class="export-btn utils-btn utils-outline" type="button" :disabled="!hasAssets" @click="emit('clear-assets')">清除全部素材</button>
        </div>
      </div>
      <label class="field row">
        <span class="label">导入素材</span>
        <span class="asset-meta">
          形象 {{ skinGallery.items.length }} 张 · 气泡图 {{ bubbleItems.length }} 张 · 音效 {{ importedSoundCount }} 段 · 合计 {{ fmtBytes(assetTotalBytes) }}
        </span>
      </label>
      <p class="hint">
        「清除未使用」只删当前设置不会用到的素材（画廊里没在用形象、已关掉的提醒音等），正在使用的一律保留；
        「清除全部素材」把导入的形象、气泡图与音效全删掉，形象 / 音色一并回退为内置（与「数据」页勾「导入的素材」是同一操作）。
        两者都只动素材，不影响其它设置。
      </p>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="toggleDataDirs()">
          {{ dataDirsOpen ? '收起数据目录' : '数据目录（导入 / 下载的素材存在哪）' }}
        </button>
        <div v-if="dataDirsOpen" class="guide">
          <p class="guide-use">
            导入的形象、气泡图与下载回来的共享素材都<strong>复制</strong>进插件的用户数据目录，不引用你选的原文件。
            换机器 / 清理前想直接看看有哪些文件，可以在这里打开对应目录：
          </p>
          <div class="field row" v-if="dataDirs">
            <span class="label">形象</span>
            <code class="dir-path" :title="dataDirs.skins">{{ dataDirs.skins }}</code>
            <button class="export-btn utils-btn utils-outline" type="button" @click="openDataDir(dataDirs.skins)">打开</button>
          </div>
          <div class="field row" v-if="dataDirs">
            <span class="label">音效</span>
            <code class="dir-path" :title="dataDirs.sounds">{{ dataDirs.sounds }}</code>
            <button class="export-btn utils-btn utils-outline" type="button" @click="openDataDir(dataDirs.sounds)">打开</button>
          </div>
          <div class="field row" v-if="dataDirs">
            <span class="label">气泡图</span>
            <code class="dir-path" :title="dataDirs.bubbles">{{ dataDirs.bubbles }}</code>
            <button class="export-btn utils-btn utils-outline" type="button" @click="openDataDir(dataDirs.bubbles)">打开</button>
          </div>
          <p v-if="dataDirsOpen && !dataDirs" class="hint">宿主未提供数据目录信息。</p>
          <p v-if="assetsFlash.msg" class="msg" :class="msgCls(assetsFlash)">{{ assetsFlash.msg }}</p>
        </div>
      </div>

      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="assetsFold.open = !assetsFold.open">
          {{ assetsFold.open ? '收起素材包' : '素材包（换机器一次带走）' }}
        </button>
        <div v-if="assetsFold.open" class="guide">
          <p class="guide-use">
            <strong>导出：</strong>把导入的形象、气泡图与音效打包成一个 <code>.whaleassets</code> 文件。
            <strong>导入：</strong>形象与气泡图是<strong>补充</strong>（每张都新增，不动现有画廊与在用的那张），
            音效按<strong>槽位覆盖</strong>（同名槽位换成本包里的那段）。内置形象与内置音色不在包里，换机器后本来就有。
          </p>
          <div class="btn-row">
            <button class="secondary utils-btn utils-secondary" :disabled="assetsBusy || !hasAssets" @click="doExportAssets">导出素材包…</button>
            <button class="secondary utils-btn utils-secondary" :disabled="assetsBusy" @click="doPickAssets">导入素材包…</button>
            <button v-if="assetsPack" class="secondary utils-btn utils-secondary" @click="doCancelAssets">取消导入</button>
          </div>

          <div v-if="assetsPack">
            <p class="guide-use">
              已选文件：<code>{{ assetsPack.path }}</code><br />
              导出时间：{{ assetsPack.exportedAt || '未知' }} · 插件版本：{{ assetsPack.appVersion || '未知' }}
            </p>
            <label class="field row check">
              <span class="label">形象 <em>{{ packLine(assetsPack.has?.skins, '张', assetsSkinNames) }}</em></span>
              <input type="checkbox" v-model="assetsPicks.skins" :disabled="!assetsPack.has?.skins" @change="assetsConfirm = false" />
            </label>
            <label class="field row check">
              <span class="label">气泡图 <em>{{ packLine(assetsPack.has?.bubbles, '张', assetsBubbleNames) }}</em></span>
              <input type="checkbox" v-model="assetsPicks.bubbles" :disabled="!assetsPack.has?.bubbles" @change="assetsConfirm = false" />
            </label>
            <label class="field row check">
              <span class="label">音效 <em>{{ packLine(assetsPack.has?.sounds, '段', assetsSoundNames) }}</em></span>
              <input type="checkbox" v-model="assetsPicks.sounds" :disabled="!assetsPack.has?.sounds" @change="assetsConfirm = false" />
            </label>
            <div class="btn-row">
              <button class="danger utils-btn utils-danger" :disabled="assetsBusy || !assetsAnyItem" @click="doApplyAssets">
                {{ assetsConfirm ? '确认导入？同名音效槽位会被覆盖' : '导入选中项' }}
              </button>
              <button v-if="assetsConfirm" class="secondary utils-btn utils-secondary" @click="assetsConfirm = false">取消</button>
            </div>
          </div>
          <p v-if="assetsFlash.msg" class="msg" :class="msgCls(assetsFlash)">{{ assetsFlash.msg }}</p>
        </div>
      </div>
    </section>

    <!-- [资源] 导入的形象：画廊（点缩略图切换、置顶、删除、勾选参与随机） -->
    <section v-if="cardOn('assets', 'assetsSkins')" class="card" data-search="assetsSkins">
      <div class="card-head">
        <button class="fold-title" type="button" @click="galleryFolds.skins = !galleryFolds.skins; rndMenu = ''; emit('clear-picked')">
          <span class="fold-caret">{{ galleryOpen('skins') ? '▾' : '▸' }}</span>
          导入的形象
        </button>
        <div class="head-actions">
            <button class="export-btn utils-btn utils-outline" type="button" @click="doRandomSkin()">随机一张</button>
            <button class="export-btn utils-btn utils-outline" type="button" @click="doImportSkin()">导入图片…</button>
            <!-- 卡头唯一的整理入口。原来这里是「选中操作」「随机设置」两个下拉并列，两处很别扭：
                 1) 面板与箭头都在表达「我有独立状态」，但实际共用一个布尔，点一个两个同时展开；
                 2) 「设为参与随机」在两边各有一份（选中批量 / 全部批量），用户要在两个面板间找；
                 3) 卡头一行四个按钮已经偏挤。
                 现在收成一个「整理」，面板内按**作用范围**分成两段，段内动作都天然可批量：
                 上段作用于单击选中那批（未选中时收起，只留一行引导），下段作用于整张清单。
                 选中态因此回到它本来的角色 —— 「接下来要操作哪几张」的选择器，
                 而不是「必须先点开某个下拉」的前置条件：整清单的动作用不着先选任何东西。

                 面板内部**一个层级**：曾把整批动作收成悬停二级菜单来压高度又撤掉（只为「看着短」，
                 代价是多一层悬停）；这一轮改回来，但只收**低频**的那一族（「全部 N 张」），
                 日常那 6 项（使用 / 排序 / 随机 / 删除）照旧平铺直取。收法见 onDocMoveForRndMenu：
                 悬停展开 + 220ms 延迟收 + 首次开面板自动展一瞬（新用户不必先发现那里能悬停）。 -->
            <div class="rnd-menu">
              <button class="export-btn utils-btn utils-outline" type="button"
                      :class="{ 'has-sel': !!pickedVisible.length }"
                      :title="pickedVisible.length
                        ? `已选中 ${pickedVisible.length} 张，可整理它们`
                        : '整理形象：使用 / 排序 / 删除 / 是否参与随机'"
                      @click="toggleRndMenu">
                {{ pickedVisible.length ? `已选 ${pickedVisible.length} 张` : '整理' }}
                <span class="rnd-menu-caret">{{ rndMenu ? '▴' : '▾' }}</span>
              </button>
              <!-- 坐标在 toggleRndMenu 里按按钮实测（见 rndPanelPos）；面板是 fixed 定位，
                   Teleport 到 body 才对得上视口坐标：uTools 内嵌浏览器的祖先容器带 transform，
                   会把 fixed 的定位基准降级成最近的定位祖先（这里是 position:relative 的 .rnd-menu），
                   于是视口坐标被当成相对卡头的偏移，面板飘到卡片下方。
                   回到 body 后 fixed 才真正相对视口，也与 .rnd-menu 只作「点击判定锚点」的原意一致 -->
              <Teleport to="body">
                <div v-if="rndMenu" class="rnd-menu-panel"
                     :style="{ left: rndPanelPos.left + 'px', top: rndPanelPos.top + 'px', minWidth: rndPanelPos.minWidth + 'px' }">
                <!-- 第一段：作用于选中的那批。**未选中时整段不渲染**，只留一行灰字说明。
                     原来是把 6 个按钮原样摆着置灰 —— 面板一下多出 6 行灰条，比能用的项还长，
                     还会让人先去点一下试试是不是坏了。
                     说明行也**不做成可点按钮**：它点了只能弹一句提示，看着像菜单项却什么都办不了，
                     是最容易骗到点击的那类占位；写成不可点的灰字，跟「选中的 N 张」小标题同款，
                     读起来就是「这一段的处境」，而不是「一个暂时点不动的操作」 -->
                <template v-if="pickedVisible.length">
                  <p class="rnd-menu-title">选中的 {{ pickedVisible.length }} 张</p>
                  <button type="button" @click="doUsePicked(); closeRndMenu()">使用这张</button>
                  <button type="button"
                          :disabled="pickedVisible.length === skinGallery.items.length"
                          @click="doPinPicked(); closeRndMenu()">移到最前</button>
                  <button type="button"
                          :disabled="pickedVisible.length === skinGallery.items.length"
                          @click="doBottomPicked(); closeRndMenu()">移到最后</button>
                  <button type="button" @click="applyPickedRandom(true); closeRndMenu()">参与随机</button>
                  <button type="button" @click="applyPickedRandom(false); closeRndMenu()">不参与随机</button>
                  <!-- 删除是这一列里唯一不可逆的动作，用一条分隔线与上面五项拉开：
                       连点「不参与随机」时手滑一下就删掉几张，只靠红字挡不住 -->
                  <div class="rnd-menu-sep"></div>
                  <button type="button" class="danger"
                          @click="doRemovePicked(); closeRndMenu()">删除选中的</button>
                </template>
                <p v-else class="rnd-menu-title">未选中（单击缩略图可多选）</p>
                <div class="rnd-menu-sep"></div>
                <!-- 第二段：整张清单的「随机时抽哪些」。原来是悬停展开的二级菜单，得先猜那里能悬停、
                     再跨一层才碰到仅有的三个动作；而且那三项各写着各的禁用条件，池子空时「都不抽」
                     这个唯一有用的动作反而被灰掉（条件写反了）。
                     现在摊平，并改成一组成员状态的选项：命中项打勾（.on）、点了不改变现状的项置灰
                     （!usable），勾选态的判定与可点性都来自 randomChoices / randomMode，不再逐项手写 -->
                <p class="rnd-menu-title">随机时抽哪些</p>
                <button v-for="c in randomChoices" :key="c.mode" type="button"
                        :class="{ on: c.on }"
                        :disabled="!c.usable"
                        :title="c.on ? '当前已是这个状态' : ''"
                        @click="doBatchRandom(c.mode); closeRndMenu()">
                  <span class="rnd-menu-tick">{{ c.on ? '✓' : '' }}</span>{{ c.label }}
                </button>
                </div>
              </Teleport>
            </div>
        </div>
      </div>
      <p v-if="!galleryOpen('skins')" class="hint">
        共 {{ skinGallery.items.length }} 张{{ skinMeta ? `，当前使用「${skinMeta.name}」` : '' }}。默认收起，点标题展开。
      </p>
      <template v-if="galleryOpen('skins')">
      <div class="skin-grid">
        <div v-for="(it, idx) in skinGallery.items" :key="it.id" class="skin-cell"
             :class="{ active: it.id === skinGallery.current, picked: skinPicked.indexOf(it.id) >= 0, broken: thumbBroken[it.id], noprev: !it.thumb && !thumbBroken[it.id], dragging: draggingId === it.id, 'drop-before': dragOverId === it.id && !dragOverAfter, 'drop-after': dragOverId === it.id && dragOverAfter }"
             :draggable="true"
             @dragstart="onSkinDragStart(it.id, $event)"
             @dragover="onSkinDragOver(it, $event)"
             @drop="onSkinDrop(it, $event)"
             @dragend="onSkinDragEnd()">
          <!-- 序号：让「移到最前 / 拖拽」的效果可验证（操作后看序号变化），也方便描述「第几张」 -->
          <span class="skin-cell-idx">{{ idx + 1 }}</span>
          <div class="skin-box">
            <!-- 单击 = 切换选中（「整理」面板里「选中的 N 张」那一段作用于它），
                 双击 = 切换使用。可多选：连点几张就能对它们一起排序 / 删除 / 改随机。
                 原先每张图上挂一套按钮太占画面，收敛到卡头后图本身清爽，
                 功能靠「选中」这一个中间态承接。 -->
            <button class="skin-cell-pick" type="button"
                    :title="`${it.name}（${assetSize(it)} · ${assetAt(it)}）· 单击选中（可多选），双击切换使用`"
                    @click="onSkinPicked(it.id, !(props.skinPicked.indexOf(it.id) >= 0))"
                    @dblclick="doUseSkinPick(it.id)">
              <img v-if="it.thumb && !thumbBroken[it.id]" class="skin-cell-img" :src="it.thumb" :alt="it.name"
                   @error="onThumbError(it.id)" />
              <span v-else-if="thumbBroken[it.id]" class="skin-cell-broken">预览失败</span>
              <span v-else class="skin-cell-none">无预览</span>
            </button>
            <span v-if="it.id === skinGallery.current" class="skin-cell-tag">使用中</span>
          </div>
        </div>
        <button class="skin-cell skin-cell-add" type="button" title="导入图片" @click="doImportSkin()">
          <span class="skin-cell-add-plus">＋</span>
          <span class="skin-cell-add-txt">导入</span>
        </button>
      </div>
      <p v-if="skinMeta" class="hint">
        当前使用：{{ skinMeta.name }}（{{ assetSize(skinMeta) }} · {{ assetAt(skinMeta) }}）
        <button class="link-btn" type="button" @click="emit('toggle-skin-hint')">{{ skinHintOpen ? '收起说明' : '操作说明' }}</button>
      </p>
      <p v-if="skinMeta && skinHintOpen" class="hint">
        单击缩略图选中（可连点多张），再点卡片上方「整理」，可对它们：切换使用 / 移到最前 / 移到最后 / 参与随机 / 不参与随机 / 删除；
        双击缩略图也能直接切换使用，最多保留 20 张；
        直接拖动缩略图可排到任意位置；
        参与随机的共 {{ randomSkinPool.length }} 张（随包内置那张始终参与），「随机一张」会从它们里挑；
        「整理 → 随机时抽哪些」那一段不用先选中，可整批指定随机时的取图范围。
      </p>
      <p v-else-if="!skinMeta" class="hint">
        还没有导入形象。点「导入图片…」加一张，支持 png / jpg / webp / gif / apng（动图不裁剪，保留动画）。
      </p>
      <p v-if="skinUnused" class="hint">
        已导入但当前未使用：「挂件外观 → 形象」选的不是「自定义」。
      </p>
      <p v-if="skinFlash.msg" class="msg" :class="msgCls(skinFlash)">{{ skinFlash.msg }}</p>
      </template>
    </section>

    <!-- [资源] 导入的气泡图：点小鲸鱼抽到「动图组」时随机显示一张。
         与形象不同 —— 没有「当前用哪张」（有图就随机抽，删光即回退内置动图），所以没有「使用中」标记与置顶 -->
    <section v-if="cardOn('assets', 'assetsBubbles')" class="card" data-search="assetsBubbles">
      <div class="card-head">
        <h2>导入的气泡图</h2>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-outline" type="button" @click="doImportBubble()">导入图片…</button>
        </div>
      </div>
      <div class="skin-grid">
        <div v-for="it in bubbleItems" :key="it.id" class="skin-cell"
             :class="{ broken: thumbBroken[it.id], noprev: !it.thumb && !thumbBroken[it.id] }">
          <div class="skin-box">
            <span class="skin-cell-pick" :title="`${it.name}（${assetSize(it)} · ${assetAt(it)}）`">
              <img v-if="it.thumb && !thumbBroken[it.id]" class="skin-cell-img" :src="it.thumb" :alt="it.name"
                   @error="onThumbError(it.id)" />
              <span v-else-if="thumbBroken[it.id]" class="skin-cell-broken">预览失败</span>
              <span v-else class="skin-cell-none">无预览</span>
            </span>
            <span class="skin-cell-ops">
              <button class="skin-op danger" type="button" title="删除这张" @click.stop="doRemoveBubble(it.id)">删</button>
            </span>
          </div>
        </div>
        <button class="skin-cell skin-cell-add" type="button" title="导入图片" @click="doImportBubble()">
          <span class="skin-cell-add-plus">＋</span>
          <span class="skin-cell-add-txt">导入</span>
        </button>
      </div>
      <p v-if="bubbleItems.length" class="hint">
        点小鲸鱼抽到「动图组」时，从这 {{ bubbleItems.length }} 张里随机显示一张；删光即回退内置动图，最多保留 8 张。
      </p>
      <p v-else class="hint">
        还没有导入气泡图，点小鲸鱼时显示内置动图。点「导入图片…」加一张，支持 png / jpg / webp / gif / apng（动图不裁剪，保留动画）。
      </p>
      <p v-if="bubbleFlash.msg" class="msg" :class="msgCls(bubbleFlash)">{{ bubbleFlash.msg }}</p>
    </section>

    <!-- [资源] 导入的音效：六槽位（按压 / 释放 + 四类提醒音），每槽位只保留一段 -->
    <section v-if="cardOn('assets', 'assetsSounds')" class="card" data-search="assetsSounds">
      <h2>导入的音效</h2>
      <!-- 六个槽位各成一个块（.sound-group 有底色与描边）。
           每个槽位最多一段：再导入就是替换掉旧的，所以没有「第 1 段 / 第 2 段」的编号，
           也不需要「哪几段属于谁」的分组暗示。 -->
      <div class="sound-group" v-for="r in SOUND_ROLES" :key="r">
        <div class="sound-group-head">
          <span class="label" :title="ALERT_SOUND_WHEN[r]">{{ SOUND_ROLE_LABEL[r] }}</span>
          <!-- 概览只报有没有，不报名字：名字就在同一行的右侧（.sound-file），复述一遍纯属重复 -->
          <span class="asset-meta">
            <template v-if="soundMetaOf(r).length">已导入</template>
            <template v-else>{{ (ALERT_SOUND_ROLES as string[]).indexOf(r) >= 0 ? '未导入（静音）' : '未导入（可选）' }}</template>
          </span>
          <button class="export-btn utils-btn utils-outline" type="button" @click="doImportSound(r)">
            {{ soundMetaOf(r).length ? '替换' : '导入' }}
          </button>
        </div>
        <!-- 单段时直接并进槽位头一行：既然只有一个，再单起一行纯属浪费纵向空间 -->
        <div class="sound-seg" v-for="(it, i) in soundMetaOf(r)" :key="it.file">
          <span class="sound-file" :title="it.name">{{ it.name }}</span>
          <span class="seg-ops">
            <button class="export-btn utils-btn utils-outline" type="button" @click="doPreviewSound(r, i)">试听</button>
            <button class="export-btn utils-btn utils-outline" type="button" @click="doRemoveSound(r, it.file)">删除</button>
          </span>
          <!-- 体积与导入时间都是次要信息，合成一行放在最下面 -->
          <span class="seg-time" :title="assetAt(it)">{{ assetSize(it) }} · {{ assetAtShort(it) }}</span>
        </div>
      </div>
      <p v-if="cfg.soundSet === 'custom' && !soundsMeta.press.length" class="hint">
        还没有导入按压音，「挂件外观 → 音色」的「自定义」当前会回退为「小黄鸭」。
      </p>
      <p v-if="soundUnused" class="hint">
        按压 / 释放音已导入但当前未使用：「音效开关」没开，或「音色」选的不是「自定义」。
      </p>
      <p class="hint">
        <strong>一个槽位只保留一段</strong> —— 再导入（按钮显示「替换」）会顶掉旧的。
        提醒音留空 = 静音（不打扰是默认），只在对应提醒真的弹出时响一次；播放跟随「挂件外观」里的音效开关与音量。
        音效支持 mp3 / wav / ogg 等，导入时可先拖选片段试听（最长 10 秒），结果转成单声道 WAV。
      </p>
      <p v-if="soundFlash.msg" class="msg" :class="msgCls(soundFlash)">{{ soundFlash.msg }}</p>
    </section>

    <!-- [资源] 内置资源：随插件附带、不可删，只作对照（选哪个在「挂件外观」）。
         纯查阅用，默认收起，避免与「导入的…」三张卡一起铺满一屏 -->
    <section v-if="cardOn('assets', 'assetsBuiltin')" class="card" data-search="assetsBuiltin">
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" @click="emit('toggle-builtin-fold', !builtinFold)">{{ builtinFold ? '收起内置资源与下载源' : '内置资源与下载源' }}</button>
        <div v-if="builtinFold">
          <p class="hint">随插件附带、不可删除，列在这里只作对照；换形象 / 音色请到「挂件外观」。</p>
          <p v-if="skinInUseMissing" class="msg err">
            你正在使用的形象「{{ missingSkinName }}」随新版移出了插件包，挂件暂用默认形象显示。
            点下方它的缩略图即可下载找回（也可整体「下载全部」）。
          </p>
          <p class="group-title">内置形象 <em>（随包 {{ builtinSkins.length }} 张 · 可下载 {{ skinPackSkins.length }} 张，共约 {{ fmtBytes(skinPackBytes) }}；当前：{{ cfg.skin === 'custom' ? '自定义' : cfg.skin }}）</em></p>
          <div class="skin-grid">
            <div v-for="s in builtinSkins" :key="'b-' + s" class="skin-cell" :class="{ active: cfg.skin === s }">
              <div class="skin-box">
                <img class="skin-cell-img" :src="builtinSkinUrl(s)" :alt="s" :title="s" />
                <span class="skin-cell-tag">{{ s }}</span>
              </div>
            </div>
            <!-- 可下载的那批（v1.8.0 起只剩 1 张）：未装灰底 + 下载角标（缩略图是设置页内嵌的，不下载也能看见长什么样）；
                 已装则与「导入的形象」共用一套展示（缩略图从画廊来），可选用 / 可删 -->
            <div v-for="s in skinPackItems" :key="'p-' + s.id" class="skin-cell"
                 :class="{ active: cfg.skin === s.id, 'is-remote': !skinPackInstalled[s.id] }">
              <div class="skin-box">
                <button class="skin-cell-pick" type="button"
                        :title="skinPackInstalled[s.id] ? `${skinPackLabel(s.id)}（已下载，点选用）`
                          : `${skinPackLabel(s.id)}（未下载，点一下下载，下完自动切到这张）`"
                        @click="doSkinPackCell(s.id)">
                  <img class="skin-cell-img" :src="skinPackThumb(s.id)" :alt="skinPackLabel(s.id)" />
                </button>
                <!-- 角标写「下载」：v1.8.0 起这批只剩 1 张，「下载全部」显得莫名其妙 -->
                <span v-if="!skinPackInstalled[s.id]" class="skin-cell-badge">下载</span>
                <!-- 名字与警示标签二选一：两个都贴 bottom:0，同时渲染会叠在一起看不清。
                     「正在使用 · 未下载」本身已含「是哪张」的信息（它只可能出现在 cfg.skin 那张上） -->
                <span v-if="skinInUseMissing && s.id === cfg.skin" class="skin-cell-tag warn">正在使用 · 未下载</span>
                <span v-else class="skin-cell-tag">{{ skinPackLabel(s.id) }}</span>
                <span v-if="skinPackInstalled[s.id]" class="skin-cell-ops">
                  <button class="skin-op danger" type="button" title="从本地删除这张（可重新下载）"
                          @click.stop="doRemoveSkin(s.id)">删</button>
                </span>
              </div>
            </div>
          </div>
          <div class="btn-row">
            <button class="export-btn utils-btn utils-primary" type="button"
                    :disabled="skinPackBusy || skinPackAllInstalled"
                    @click="doDownloadSkinPacks()">
              {{ skinPackBusy ? '正在下载…'
                : skinPackAllInstalled ? '已全部下载'
                  : skinPackInstalledAny ? `下载剩余 ${skinPackSkins.length - skinPackInstalledCount} 张（约 ${fmtBytes(skinPackRemainBytes)}）`
                      : (skinPackSkins.length === 1 ? `下载（约 ${fmtBytes(skinPackBytes)}）`
                         : `下载全部 ${skinPackSkins.length} 张（约 ${fmtBytes(skinPackBytes)}）`) }}
            </button>
          </div>
          <div v-if="dlProgress && dlProgress.pack === 'skins'" class="dl-box">
            <div class="dl-track" :class="{ indet: dlPercent === null }">
              <div class="dl-bar" :class="{ indet: dlPercent === null, done: dlProgress.phase === 'done', err: dlProgress.phase === 'failed' }"
                   :style="dlPercent === null ? undefined : { width: dlPercent + '%' }"></div>
            </div>
            <div class="dl-line">
              <span class="dl-label">{{ dlProgress.label }}</span>
              <span class="dl-amt">{{ dlAmountText }}</span>
              <span v-if="dlPercent !== null" class="dl-pct">{{ dlPercent }}%</span>
            </div>
            <div v-if="dlProgress.url" class="dl-src">
              <span class="dl-src-tag">下载源</span>
              <a class="dl-src-url" :href="dlProgress.url" target="_blank" rel="noreferrer" :title="dlProgress.url">{{ dlProgress.url }}</a>
            </div>
          </div>
          <p class="hint">
            <strong>一次操作下载的是整包</strong>：形象打包在同一个 Release 文件里，没有按张分片，所以无论点缩略图还是点上面按钮，
            都会把未下载的那几张一起下回来（已下载的自动跳过，不重复占体积），下完自动切到你点的那张。
            已下载的缩略图悬停可「删」单张，删了能重新下载。下载回来的形象存本地、不占导入配额（「导入的形象」最多 20 张另算）。
          </p>
          <!-- 下载源：留空即内置候选链（ghfast.top 加速 → 直连 github.com 兜底）。
               自填须是 http(s) 绝对 URL 前缀，宿主会归一化（非法串回空并回落内置），末尾 '/' 可省略 -->
          <label class="field row">
            <span class="label">形象下载源 <em>（留空用内置：ghfast.top，失败自动直连 github.com）</em></span>
            <input type="text" :maxlength="SKIN_PACK_PREFIX_MAX" spellcheck="false" autocomplete="off"
                   placeholder="https://ghfast.top/"
                   :value="cfg.skinPackSrc"
                   @change="emit('patch', { skinPackSrc: ($event.target as HTMLInputElement).value })" />
          </label>
          <p v-if="skinPackFlash.msg" class="msg" :class="msgCls(skinPackFlash)">{{ skinPackFlash.msg }}</p>
          <p class="group-title">内置音色 <em>（两组，在「挂件外观 → 音色」里选；提醒音没有内置回落）</em></p>
          <div class="field row" v-for="g in BUILTIN_SOUND_SETS" :key="g.key">
            <span class="label">{{ g.label }}</span>
            <span class="sound-file">按压 {{ g.press }} · 释放 {{ g.release }}</span>
            <button class="export-btn utils-btn utils-outline" type="button" @click="doPreviewBuiltin(g.press)">试听按压</button>
            <button class="export-btn utils-btn utils-outline" type="button" @click="doPreviewBuiltin(g.release)">试听释放</button>
          </div>
          <p class="hint">
            内置音色是插件包里的文件，不占本地数据目录空间，也不会被「清除素材」删掉。
          </p>
          <p v-if="builtinFlash.msg" class="msg" :class="msgCls(builtinFlash)">{{ builtinFlash.msg }}</p>
        </div>
      </div>
    </section>

    <!-- [资源] 共享角色：上游 QQ 群素材（36 张），v1.9.0 起按需单张下载（走 raw 直链，不再整包）。
         点缩略图 = 下这一张；顶上按钮 = 逐张串行把未下载的补齐 -->
    <section v-if="cardOn('assets', 'assetsSharedSkins')" class="card" data-search="assetsSharedSkins">
      <div class="card-head">
        <button class="fold-title" type="button" @click="galleryFolds.sharedSkins = !galleryFolds.sharedSkins">
          <span class="fold-caret">{{ galleryOpen('sharedSkins') ? '▾' : '▸' }}</span>
          共享形象
        </button>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-primary" type="button"
                  :disabled="sharedSkinBusy || sharedSkinAllInstalled"
                  @click="doDownloadSharedSkins()">
            {{ sharedSkinBusy ? '正在下载…'
              : sharedSkinAllInstalled ? '已全部下载'
                : sharedSkinInstalledCount ? `下载剩余 ${sharedSkinItems.length - sharedSkinInstalledCount} 张（约 ${fmtBytes(sharedSkinRemainBytes)}）`
                  : `下载全部 ${sharedSkinItems.length} 张（约 ${fmtBytes(sharedSkinTotalBytes)}）` }}
          </button>
        </div>
      </div>
      <p v-if="!galleryOpen('sharedSkins')" class="hint">
        共 {{ sharedSkinItems.length }} 张，已下载 {{ sharedSkinInstalledCount }} 张。默认收起，点标题展开。
      </p>
      <template v-if="galleryOpen('sharedSkins')">
      <div v-if="dlProgress && dlProgress.pack === 'shared-skins'" class="dl-box">
        <div class="dl-track" :class="{ indet: dlPercent === null }">
          <div class="dl-bar" :class="{ indet: dlPercent === null, done: dlProgress.phase === 'done', err: dlProgress.phase === 'failed' }"
               :style="dlPercent === null ? undefined : { width: dlPercent + '%' }"></div>
        </div>
        <div class="dl-line">
          <span class="dl-label">{{ dlProgress.label }}</span>
          <span class="dl-amt">{{ dlAmountText }}</span>
          <span v-if="dlPercent !== null" class="dl-pct">{{ dlPercent }}%</span>
        </div>
        <div v-if="dlProgress.url" class="dl-src">
          <span class="dl-src-tag">下载源</span>
          <a class="dl-src-url" :href="dlProgress.url" target="_blank" rel="noreferrer" :title="dlProgress.url">{{ dlProgress.url }}</a>
        </div>
      </div>
      <div class="skin-grid">
        <div v-for="s in sharedSkinItems" :key="'sh-' + s.id" class="skin-cell"
             :class="{ active: cfg.skin === s.id, 'is-remote': !sharedSkinInstalled[s.id] }">
          <div class="skin-box">
            <button class="skin-cell-pick" type="button"
                    :title="sharedSkinInstalled[s.id] ? `${sharedSkinNames[s.id] || s.id}（已下载，点选用）`
                      : `${sharedSkinNames[s.id] || s.id}（未下载，点一下下载这张，下完自动切到这张）`"
                    @click="doSharedSkinCell(s.id)">
              <img v-if="!thumbBroken['sh-' + s.id]" class="skin-cell-img" :src="sharedSkinThumb(s.id)"
                   :alt="sharedSkinNames[s.id] || s.id" @error="onThumbError('sh-' + s.id)" />
              <span v-else class="skin-cell-broken">预览加载失败</span>
            </button>
            <!-- 单张点击只下这一张，但 40MB 整包时代留下的「下载全部」措辞要改成「下载」 -->
            <span v-if="!sharedSkinInstalled[s.id]" class="skin-cell-badge">下载</span>
            <span class="skin-cell-tag">{{ sharedSkinNames[s.id] || s.id }}</span>
            <span v-if="sharedSkinInstalled[s.id]" class="skin-cell-ops">
              <button class="skin-op danger" type="button" title="从本地删除这张（可重新下载）"
                      @click.stop="doRemoveSkin(s.id)">删</button>
            </span>
          </div>
        </div>
      </div>
      <p v-if="!sharedSkinItems.length" class="hint">暂无可下载的共享角色。</p>
      <p class="hint">
        这些角色来自上游 QQ 群分享，<strong>不随插件包分发</strong>，改为按需从 GitHub 直链下载。
        <strong>点缩略图只下载这一张</strong>（约 1~2MB），下完自动切到这张；
        点上方的按钮会把还没下载的<strong>逐张</strong>下回来（已下载的自动跳过）。
        已下载的可悬停「删」单张，删了能重新下载；下载回来的角色存本地，不占「导入的形象」的 20 张配额。
      </p>
      <p v-if="sharedSkinFlash.msg" class="msg" :class="msgCls(sharedSkinFlash)">{{ sharedSkinFlash.msg }}</p>
      </template>
    </section>

    <!-- [资源] 共享音效库：与共享角色同一批上游素材（45 段），落 sounds 的 shared 槽位。
         它是「素材池」不直接参与实播 —— 要到下面选一个实播槽位「选用」才生效，
         否则一装几十段、把原本选好的音效挤掉 -->
    <section v-if="cardOn('assets', 'assetsSharedSounds')" class="card" data-search="assetsSharedSounds">
      <div class="card-head">
        <button class="fold-title" type="button" @click="galleryFolds.sharedSounds = !galleryFolds.sharedSounds">
          <span class="fold-caret">{{ galleryOpen('sharedSounds') ? '▾' : '▸' }}</span>
          共享音效
        </button>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-primary" type="button"
                  :disabled="sharedSoundBusy || sharedSoundAllInstalled"
                  @click="doDownloadSharedSounds()">
            {{ sharedSoundBusy ? '正在下载…'
              : sharedSoundAllInstalled ? '已全部下载'
                : sharedSoundInstalledCount ? `下载剩余 ${sharedSoundItems.length - sharedSoundInstalledCount} 段（约 ${fmtBytes(sharedSoundRemainBytes)}）`
                  : `下载全部 ${sharedSoundItems.length} 段（约 ${fmtBytes(sharedSoundTotalBytes)}）` }}
          </button>
        </div>
      </div>
      <p v-if="!galleryOpen('sharedSounds')" class="hint">
        共 {{ sharedSoundItems.length }} 段，已下载 {{ sharedSoundInstalledCount }} 段。默认收起，点标题展开。
      </p>
      <template v-if="galleryOpen('sharedSounds')">
      <div v-if="dlProgress && dlProgress.pack === 'shared-sounds'" class="dl-box">
        <div class="dl-track" :class="{ indet: dlPercent === null }">
          <div class="dl-bar" :class="{ indet: dlPercent === null, done: dlProgress.phase === 'done', err: dlProgress.phase === 'failed' }"
               :style="dlPercent === null ? undefined : { width: dlPercent + '%' }"></div>
        </div>
        <div class="dl-line">
          <span class="dl-label">{{ dlProgress.label }}</span>
          <span class="dl-amt">{{ dlAmountText }}</span>
          <span v-if="dlPercent !== null" class="dl-pct">{{ dlPercent }}%</span>
        </div>
        <div v-if="dlProgress.url" class="dl-src">
          <span class="dl-src-tag">下载源</span>
          <a class="dl-src-url" :href="dlProgress.url" target="_blank" rel="noreferrer" :title="dlProgress.url">{{ dlProgress.url }}</a>
        </div>
      </div>
      <!-- 列表按「是否已下载」分两组：两组的控件数量差 3 个（未下载行没有试听/下拉/选用/删），
           混排会让整列文件名的右边界在两种行之间来回跳，45 行看下来就是锯齿。
           分组后同组内控件结构一致，列能对齐；未下载的那组默认收进 .fold 里，
           免得 45 行未下载项把「已下载」这半截推到屏外。 -->
      <div class="shs-list">
        <template v-if="sharedSoundInstalledItems.length">
          <p class="group-title">已下载 <em>（{{ sharedSoundInstalledItems.length }} 段，可试听 / 选用 / 删）</em></p>
          <div class="shs-row" v-for="it in sharedSoundInstalledItems" :key="'shs-' + it.id">
            <!-- 主线：文件名是这一行唯一需要读的信息，独占剩余宽度、不再被控件挤到截断 -->
            <div class="shs-main">
              <span class="sound-file" :title="it.name">{{ it.name }}</span>
              <span class="asset-meta">{{ fmtBytes(it.size) }}</span>
            </div>
            <!-- 副线：三个动作归到一行，与文件名左对齐。原先 4 个控件横铺在文件名右边，
                 「选择要加入的音效段…」这个全场最长的文案还逐行重复，把文件名压成了 AUGH#H -->
            <div class="shs-ops">
              <!-- 下拉按语义分组：按压 / 释放是「音色」的两段（要配合音色=自定义才响），
                   另外四类是独立的提醒音。混在一个平铺列表里，用户看不出这层区别 -->
              <select class="sound-role-pick" :value="sharedSoundUseRole[it.id] || ''"
                      @change="sharedSoundUseRole[it.id] = ($event.target as HTMLSelectElement).value as SoundRole">
                <option value="">选用到槽位…</option>
                <optgroup label="音色 · 按压 / 释放">
                  <option value="press">{{ SOUND_ROLE_LABEL.press }}</option>
                  <option value="release">{{ SOUND_ROLE_LABEL.release }}</option>
                </optgroup>
                <optgroup label="提醒音 · 四类提醒">
                  <option v-for="r in ALERT_SOUND_ROLES" :key="'sr-' + r" :value="r">{{ SOUND_ROLE_LABEL[r] }}</option>
                </optgroup>
              </select>
              <button class="export-btn utils-btn utils-primary" type="button"
                      :disabled="!sharedSoundUseRole[it.id]" @click="doUseSharedSound(it)">选用</button>
              <button class="export-btn utils-btn utils-outline" type="button"
                      :class="{ 'preview-on': previewingSharedId === it.id }"
                      @click="doPreviewSharedSound(it)">{{ previewingSharedId === it.id ? '停止' : '试听' }}</button>
              <button class="export-btn utils-btn" type="button"
                      :class="removeConfirmId === it.id ? 'utils-danger' : 'utils-outline'"
                      :title="removeConfirmId === it.id ? '再点一次确认删除（3 秒后自动取消）' : '从共享音效库删掉这一段；若已选用到槽位，槽位上的那份也一并清掉'"
                      @click="doRemoveSharedSound(it)">{{ removeConfirmId === it.id ? '确认删' : '删' }}</button>
            </div>
          </div>
        </template>
        <p v-else class="hint">共享音效库暂时是空的 —— 上方按钮若显示「下载全部 N 段」，点它把音效拉回来。</p>

        <div class="fold" v-if="sharedSoundPendingItems.length">
          <button class="link-btn utils-btn utils-secondary" type="button"
                  @click="sharedSoundPendingOpen = !sharedSoundPendingOpen">
            未下载 {{ sharedSoundPendingItems.length }} 段<span class="fold-caret">{{ sharedSoundPendingOpen ? '▾' : '▸' }}</span>
          </button>
          <template v-if="sharedSoundPendingOpen">
            <div class="shs-row" v-for="it in sharedSoundPendingItems" :key="'shs-' + it.id">
              <div class="shs-main">
                <span class="sound-file" :title="it.name">{{ it.name }}</span>
                <span class="asset-meta">{{ fmtBytes(it.size) }}</span>
              </div>
              <div class="shs-ops">
                <!-- 措辞带上「这一段」：顶部还有一个「下载剩余 N 段」（逐段串行下完），
                     两个按钮的量级差 40 倍，都写「下载」会让人以为点了就是整包 -->
                <button class="export-btn utils-btn utils-primary" type="button"
                        :disabled="sharedSoundBusy" @click="doDownloadSharedSound(it)">下载这一段</button>
              </div>
            </div>
          </template>
        </div>
      </div>
      <p class="hint">
        这些音效来自上游 QQ 群分享，<strong>不随插件包分发</strong>，改为按需从 GitHub 直链下载。
        <strong>「下载这一段」只拉当前这一条</strong>；卡头的按钮是把还没下载的<strong>逐段</strong>串行下回来。
        下载后先进「共享音效库」这个素材池，<strong>不会自动播放</strong> —— 从下拉里选一个音效段（按压 / 释放 / 四类提醒音）再点「选用」，
        才会把这段放进那个槽位（一个槽位只保留一段，再选用就是顶掉旧的）。
        这样不会一装几十段、把原本选好的音效挤掉。
        <br>「选用」是<strong>另存一份</strong>到槽位，所以这里点「删」时，<strong>槽位上那份也会跟着清掉</strong>
        （不然删完挂件还在响，像是没删干净）；清掉了哪个槽位会写在下面的提示里。
      </p>
      <p v-if="sharedSoundFlash.msg" class="msg" :class="msgCls(sharedSoundFlash)">{{ sharedSoundFlash.msg }}</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* 设计令牌来自 main.css 的 :root。通用控件样式（.card / .field / .label / .msg / .hint /
   .export-btn / .head-actions / .fold 等）原本由 App.vue 的 scoped 样式提供，
   组件拆分后 scoped 隔离掉了，这里按本组件用到的部分补齐一份。utils 档位配色与
   .link-btn 基类已在 main.css（单一来源），此处不再留副本。
   ★ 本组件此前漏了这一步（样式标签是空的 `<style scoped />`），而 App.vue 内联的规则
     带的是 App 的哈希、匹配不上本组件渲染的元素 —— 症状是整卡样式失效：画廊网格无尺寸、
     棋盘格底 / 悬停操作条 / 角标全丢，素材包与共享音效的进度条塌成空白。这里一次性补齐。 */
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
/* 可折叠卡片的标题本身是按钮：抹掉 button 默认外观，视觉上对齐 .card-head h2，
   让用户仍然一眼认出这是标题（有 hover 反馈暗示可点） */
.fold-title {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-dim);
  cursor: pointer;
}
.fold-title:hover {
  color: var(--fg);
}
/* 箭头单独占位，展开 / 收起时标题不会左右横跳 */
.fold-caret {
  width: 1em;
  font-size: 12px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
/* 卡头的「整理」下拉：按钮沿用 utils-outline 基类，这里只负责面板定位。
   .rnd-menu 自己 position:relative 当锚点（不能挂在 .head-actions 上 —— 后面还有别的按钮） */
.rnd-menu {
  position: relative;
}
.rnd-menu-caret {
  font-size: 9px;
  opacity: 0.75;
}
/* 有选中项时按钮变实心强调色：选中态是「操作哪几张」的入口，不显眼用户不会去点，
   而整清单的动作（面板下半段）又不需要选中 —— 明确区分这两种处境 */
.rnd-menu > button.has-sel {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-weak);
}
.rnd-menu-panel {
  position: fixed;
  z-index: 20;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 8px;
  /* 用 fixed + 运行时算出的视口坐标（见 rndPanelPos 与 toggleRndMenu）：不用 absolute 挂在卡头下沿，
     是因为 .tab-bar 是 position:sticky + z-index:5 且带不透明底色，粘住后是一条独立的层叠上下文，
     卡头里的下拉无论写多高的 z-index 都会被它盖住。
     ⚠️ 光写 fixed 还不够：必须配合模板里的 <Teleport to="body">。uTools 内嵌浏览器的祖先容器
     带 transform，会创建 containing block 把 fixed 降级成「相对最近定位祖先」（=.rnd-menu），
     于是视口坐标被当成偏移量，面板飘到卡片下方。挂到 body 下才真正相对视口。
     宽度由内容撑开（fixed 元素默认 shrink-to-fit，无需再写 max-content）；
     水平位置用 left（不用 right —— 按钮文案「整理」↔「已选 N 张」会变长，right 对齐会让位置跟着漂） */
  background: var(--input-bg);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
/* 面板内的分组标题（「选中的 N 张」/「全部 N 张」）：这面板里并存两类作用范围不同的动作，
   不给小标题就会让人以为它们是一回事。样式上跟菜单项走同一套内边距、同一档字号 */
.rnd-menu-title {
  margin: 0;
  padding: 6px 10px 3px;
  font-size: 12px;
  color: var(--fg-dim);
  opacity: 0.9;
  white-space: nowrap;
}
.rnd-menu-sep {
  height: 1px;
  margin: 4px 0;
  /* 与项同宽：左右不留缝，这条线才能当作「一组到此为止」的边界 */
  background: var(--line);
}
/* 「随机时抽哪些」这一组：三选一的成员状态，命中项左侧打勾并提亮。
   原来是悬停展开的二级菜单（.rnd-menu-sub / .rnd-sub-trigger / .rnd-sub-panel），
   得先猜到标题能悬停、再跨一层才碰到仅有的三个动作；摊平后一屏看全，不再需要那套悬停状态机 */
.rnd-menu-panel button.on {
  color: var(--accent);
  font-weight: 600;
}
/* 勾号占位固定宽度：不打勾时也留出这一格，三项文字才能左侧对齐成一条线 */
.rnd-menu-tick {
  display: inline-block;
  width: 12px;
  font-size: 11px;
}
/* 未选中时的说明行：不做成可点按钮，直接沿用 .rnd-menu-title（见模板注释）。
   原来那套 .rnd-menu-guide 按钮样式随「点了只弹提示」的假菜单项一起去掉了 */
.rnd-menu-panel button {
  padding: 6px 10px;
  font-size: 12px;
  text-align: left;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
}
.rnd-menu-panel button:hover:not(:disabled) {
  background: var(--accent-weak);
}
/* 面板里的危险动作（「删除选中的」）：悬停给红底，跟同类字色区分开，免得在一列同款菜单项里误点 */
.rnd-menu-panel button.danger {
  color: var(--err);
}
.rnd-menu-panel button.danger:hover:not(:disabled) {
  background: rgba(210, 70, 70, 0.14);
}
/* 置灰的只有「点了也不改变现状」的那一项（当前命中项），可点性由 randomChoices 统一算出来。
   原来三项各写各的禁用条件，还把「随机时都不抽」写成了池子空才禁用——语义正好反了，
   于是池子空时唯一有用的那个动作反而点不动，面板看着像坏了 */
.rnd-menu-panel button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* 尺寸与描边档配色来自 main.css 的 utils 基类；这里只补它没有的 hover 提亮。
   注意 markup 里那些 `class="export-btn danger"`：在 scoped 块的 `[data-v]` 加持下
   特异性高于全局的 .utils-danger，所以 danger 变体现在真的会显红 */
.export-btn {
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
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
  /* 短标签保持 72px 起始宽度、纵向对齐；flex-shrink 允许长标签在窄卡片里收缩换行 */
  flex: 0 1 auto;
  min-width: 72px;
  /* 长标签的换行点：中文没有空格，靠 break-word 才能在盒子内折行 */
  overflow-wrap: anywhere;
}
.field.check .label {
  flex: 1 1 auto;
  min-width: 0;
  line-height: 1.5;
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
input[type='text'] {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg);
}
input[type='text']:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(83, 107, 169, 0.18);
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
/* 有失败项时可点，直接去插件市场更新 */
.msg.clickable {
  cursor: pointer;
  text-decoration: underline;
}
/* ── 素材包下载进度（内置形象 / 共享角色 / 共享音效三张卡共用一套样式） ──
   条子固定 8px 高：40.6MB 的角色包在慢网下要下好几分钟，进度条要够显眼又不能顶开版式 */
.dl-box {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--track);
}
.dl-track {
  position: relative;
  height: 8px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.dl-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  /* 宽度每 250ms 跳一档，加过渡把台阶磨平，否则看起来像在抖 */
  transition: width 0.25s linear;
}
.dl-bar.done { background: var(--ok); }
.dl-bar.err { background: var(--err); }
/* 总量未知（加速代理回 Transfer-Encoding: chunked，拿不到 Content-Length）：
   不谎报百分比，改成来回扫的滑块表示「在动，但说不准还有多久」 */
.dl-bar.indet {
  width: 35%;
  transition: none;
  animation: dl-slide 1.1s ease-in-out infinite;
}
@keyframes dl-slide {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
.dl-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
}
.dl-label { flex: 0 0 auto; }
/* 字节数用等宽：数字每 250ms 变一次，比例字体下宽度会跳，整行跟着抖 */
.dl-amt {
  flex: 0 1 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.85;
}
.dl-pct {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.85;
}
/* 下载源一行：URL 很长（github.com/.../releases/download/...），必须能断行 + 可复制 */
.dl-src {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
}
.dl-src-tag {
  flex: 0 0 auto;
  opacity: 0.7;
}
.dl-src-url {
  flex: 1 1 auto;
  min-width: 0;
  color: inherit;
  opacity: 0.75;
  word-break: break-all;
  text-decoration: underline;
}
/* 折叠面板（「数据目录」「素材包导入导出」）与凭据获取教程同款观感 */
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
/* 「数据目录」里展示的落盘路径：等宽、可截断，长路径不把按钮挤出去 */
.dir-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 6px;
  border-radius: 4px;
  /* 只读的等宽值标签，用输入框底色 --input-bg 做底衬 */
  background: var(--input-bg);
  color: var(--fg-dim);
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
}
/* 分组折叠：组间留白并用分隔线隔开 */
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
/* 覆盖 .link-btn 的 margin-top / 下划线，避免在 flex 行里把行高撑开 */
.link-btn.inline {
  margin-top: 0;
  font-size: 12px;
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
/* 卡片内的分组小标题（如素材包卡的「导出 / 导入」）：用上边框把小节和上一组字段隔开，
   避免看起来还是一串平铺的字段 */
.group-title {
  margin: 18px 0 6px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-size: 13px;
  color: var(--fg-dim);
}
.group-title em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-faint);
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
/* ===== 「导入的音效」：六个槽位各成一个块 =====
   块 = 槽位头（角色名 + 概况 + 导入/替换按钮）+ 该槽位那一段（最多一段）的明细。
   没有底色 / 描边 / 块间距时，六个槽位连同各自的明细会在视觉上连成一片，看不出归属。 */
.sound-file {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sound-group {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--card-border);
  border-radius: 10px;
  background: var(--card-bg);
}
.sound-group:first-of-type {
  /* 紧跟在卡片标题下，不需要再多一层上边距 */
  margin-top: 4px;
}
.sound-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 槽位头里的概况文案占住中间剩余宽度，把「导入 / 替换」按钮推到行尾 ——
   六个块的按钮因此左边界一致 */
.sound-group-head .asset-meta {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sound-seg {
  display: flex;
  align-items: center;
  /* 允许换行，配合下面 .seg-time 的 flex-basis:100% 把它挤到第二行 */
  flex-wrap: wrap;
  gap: 8px;
  /* 与槽位头拉开一点距离即可：这段就属于上面那个槽位，不需要分隔线再切一刀 */
  margin-top: 6px;
}
.seg-ops {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 6px;
}
/* 导入时间：单独占满一行（flex-basis:100% 逼它换行），比挤在行尾更短更易扫。
   同一个槽位里多个同名段（都叫「来财」）就是靠这里的时分来区分先后 */
.seg-time {
  flex: 1 1 100%;
  font-size: 11px;
  color: var(--fg-faint);
  white-space: nowrap;
}
/* ===== 共享音效库的分组列表 =====
   「已下载」与「未下载」分开渲染（见模板注释：两类行控件数差 3 个，混排必然列对不齐）。
   每行是上下两段：.shs-main 主线（文件名 + 体积，文件名独占剩余宽度）、
   .shs-ops 副线（动作控件，与文件名左对齐，窄卡片里可换行）。 */
.shs-list {
  margin-top: 4px;
}
.shs-row {
  padding: 6px 0;
  border-top: 1px solid var(--track);
}
/* 行内竖向留白 + 上下两段之间的间距；用 padding 而非 margin，
   保证 border-top 是紧贴上一行、间距全部落在下面 */
.shs-row:first-of-type {
  border-top: none;
  padding-top: 0;
}
.shs-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.shs-ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
/* 槽位下拉：给个基准宽度而不是 flex:1 铺满 —— 铺满后「选用 / 试听 / 删」会被推到行尾，
   离开文件名的视线范围；固定宽度更紧凑，也让 45 行的按钮列左右对齐。
   用 --input-bg 而非透明：它是个可选下拉，透明底会和「试听 / 删」两个描边按钮糊在一起 */
.shs-ops .sound-role-pick {
  flex: 0 1 150px;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--fg-dim);
  font-size: 12px;
}
/* 正在试听的那一段：按钮切成「停止」并给强调色描边，让用户在 45 行里一眼找到在放哪条 */
.shs-ops .preview-on {
  color: var(--accent);
  border-color: var(--accent);
}
/* 素材的体积与导入时间：次要信息，跟在文件名后面，不参与换行挤压 */
.asset-meta {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
/* 形象画廊：缩略图网格。棋盘格底让透明 PNG 的透明区域能看出来 */
.skin-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* 一格 = 一个 64×64 的预览图框。操作（置顶 / 随机 / 删）已改为悬停时浮在图上
   （见 .skin-cell-ops），格内常态只有图 +「使用中 / 下载」角标，网格紧凑干净。
   .skin-box 是「图 + 角标 + 操作条」的定位锚。 */
.skin-cell {
  position: relative;
  display: block;
  width: 64px;
}
/* 预览图框：虚线棋盘底（透明图能看出透明区）+ 圆角描边，挂在 .skin-box 上，
   这样内置形象（没有 pick 包裹层）与其它格长得一样 */
.skin-box {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background-color: #fff;
  background-image: linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%),
    linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%);
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
}
/* 图片与角标各自裁圆角 —— 不能给 .skin-box 加 overflow:hidden，
   否则「使用中」的外发光（box-shadow 画在边框外）会被裁掉看不见 */
.skin-cell-img,
.skin-cell-broken,
.skin-cell-none {
  border-radius: 8px;
  overflow: hidden;
}
.skin-cell-pick {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.skin-cell.active .skin-box {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(83, 107, 169, 0.28);
}
.skin-cell-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.skin-cell-none {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 11px;
  color: var(--fg-dim);
}
/* 缩略图读到一半失败（文件被外部删了、动图解码失败、data URL 超长被截断等）也要给个反馈，
   不能留一块空白格让人以为「没导入进来」。JS 侧把该格标记成 thumbBroken，这里只负责显示 */
.skin-cell-broken {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 11px;
  color: var(--fg-dim);
  text-align: center;
  line-height: 1.4;
}
/* 「置顶 / 删除」已从导入的形象每格图内移到卡头（见 .head-actions），图上不再挂操作条 ——
   原先每格悬停浮出一行小按钮，37 格下来整屏全是按钮、图本身读不清。
   现在靠「单击选中」这一个中间态承接：选中格加主题色描边（.skin-cell.picked），
   卡头的「置顶 / 删除」作用于它。
   下面 .skin-cell-ops / .skin-op 仍供气泡图 / 皮肤包 / 共享角色三处网格使用（它们的操作简单、
   格数也少，贴格悬停浮现比搬到卡头更直接），故不能删。 */
.skin-cell-ops {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  padding: 1px;
  border-radius: 8px 8px 0 0;
  /* 不铺满整条的深色遮罩 —— 只给按钮各自底色的淡淡渐变托底，尽量减少对图的遮挡 */
  background: linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.skin-cell:hover .skin-cell-ops,
.skin-cell:focus-within .skin-cell-ops,
.skin-cell.active .skin-cell-ops {
  opacity: 1;
  pointer-events: auto;
}
.skin-op {
  flex: 0 0 auto;
  padding: 0 2px;
  font-size: 10px;
  line-height: 1.5;
  border: none;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
}
.skin-op.danger {
  background: rgba(210, 70, 70, 0.9);
}
.skin-op:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
/* 普通选中（.skin-cell.picked）：单击缩略图切换选中，供「整理」面板里
   「选中的 N 张」那一段作用。可多选，所以是「集合里的每个都描边」而不是单选高亮。
   与「使用中」（右下角 .skin-cell-tag）区分开 —— 选中只是「接下来要操作它」，不等于启用。 */
.skin-cell.picked {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.skin-cell.picked .skin-box {
  background: var(--accent-weak);
}
.skin-cell-tag {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 3px;
  font-size: 9px;
  line-height: 1.4;
  border-radius: 6px 0 6px 0;
  background: rgba(83, 107, 169, 0.9);
  color: #fff;
  pointer-events: none;
}
/* 序号（左下角）：让「置 / ↑↓」的效果可验证，也方便描述「第几张」。
   放左下而不是左上 —— 顶部整条被悬停操作条（.skin-cell-ops）占据，序号在左上会被按钮盖住；
   右下角是「使用中」角标，左下角空着，正好错开。
   悬停时淡出：操作条要盖住上半张图的视觉重心，序号此刻已不必要，隐去更清爽 */
.skin-cell-idx {
  position: absolute;
  left: 0;
  bottom: 0;
  min-width: 13px;
  padding: 0 3px;
  font-size: 9px;
  line-height: 13px;
  text-align: center;
  color: #fff;
  border-radius: 0 6px 0 6px;
  background: rgba(0, 0, 0, 0.32);
  pointer-events: none;
  z-index: 1;
  transition: opacity 0.12s ease;
}
.skin-cell:hover .skin-cell-idx,
.skin-cell:focus-within .skin-cell-idx,
.skin-cell.dragging .skin-cell-idx {
  opacity: 0;
}
/* 拖拽排序：源格半透明表示「正在被搬走」；落点格用左侧/右侧一条竖线提示插入位置。
   指示线用 ::before/::after 画，避免再加 DOM 节点影响 flex 布局。 */
.skin-cell.dragging {
  opacity: 0.4;
}
.skin-cell.drop-before::before,
.skin-cell.drop-after::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}
.skin-cell.drop-before::before {
  left: -2px;
}
.skin-cell.drop-after::after {
  right: -2px;
}
/* 可拖拽时给个抓手指针；批量模式下不可拖（此时点格是勾选） */
.skin-cell[draggable='true'] .skin-cell-pick {
  cursor: grab;
}
.skin-cell.dragging .skin-cell-pick {
  cursor: grabbing;
}
/* 「下载」角标：贴在图片左上角（.skin-cell-tag 占右下角）。
   只服务「未下载 · 可下载」一种语义（已下载的不再贴角标） */
.skin-cell-badge {
  position: absolute;
  left: 0;
  top: 0;
  padding: 0 3px;
  font-size: 9px;
  line-height: 1.4;
  border-radius: 0 0 6px 0;
  background: rgba(83, 107, 169, 0.9);
  color: #fff;
  pointer-events: none;
  white-space: nowrap;
}
/* 缩略图缺失 / 加载失败（文件被外部删了、动图解码失败、data URL 超长被截断等）都要给整格套警示色，
   一眼能从一片正常格里认出「这张坏了要重导」。两档：
   - .broken：thumb 有值但解码失败（@error 置位），文案「预览失败」—— 大概率文件损坏
   - .noprev：thumb 为空（没缩略图且回落读原图也失败），文案「无预览」—— 大概率文件已被删 */
.skin-cell.broken .skin-box,
.skin-cell.noprev .skin-box {
  border-color: rgba(200, 90, 60, 0.75);
  background-color: rgba(200, 90, 60, 0.08);
}
/* 未下载的远程形象：整格压暗 + 缩略图降饱和，一眼看出「还没下来」，
   但缩略图仍可见 —— 让用户在下手前看得见长什么样 */
.skin-cell.is-remote .skin-cell-img {
  opacity: 0.45;
  filter: grayscale(0.7);
}
.skin-cell.is-remote .skin-cell-tag {
  background: rgba(0, 0, 0, 0.45);
}
/* 「正在使用的那张已移出插件包、还没下载回来」：标签改成警示色，并且不再被
   .is-remote 的压暗覆盖 —— 这张是用户最该看见和点的一张 */
.skin-cell-tag.warn {
  background: rgba(200, 120, 30, 0.92);
}
.skin-cell.is-remote .skin-cell-tag.warn {
  background: rgba(200, 120, 30, 0.92);
}
/* 「导入」格：内容为「＋ / 导入」，位置与其它 64×64 图框对齐。
   边框用实线、底色与 .skin-box 同款棋盘 —— 夹在一排棋盘格里时它是一枚正常的「加图」按钮 */
.skin-cell-add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background-color: #fff;
  background-image: linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%),
    linear-gradient(45deg, rgba(0, 0, 0, 0.07) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.07) 75%);
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
  color: var(--fg-dim);
  cursor: pointer;
}
.skin-cell-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.skin-cell-add-plus {
  font-size: 18px;
  line-height: 1;
}
.skin-cell-add-txt {
  font-size: 11px;
}
</style>
