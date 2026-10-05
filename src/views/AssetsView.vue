<script lang="ts" setup>
// ============================================================================
// 资源页：素材集中管理（概览 / 导入的形象 / 导入的气泡图 / 导入的音效 / 内置资源 /
// 共享角色 / 共享音效库）。
// 与「挂件外观」分工：那边只选「用哪个」，这里管「导了什么、占多大、要不要删、换机器怎么带走」。
// 抽出约定：素材状态（skinGallery / soundsMeta / bubbleItems 等）由父级持有并 props 下传，
// 本组件只做展示与交互，改动一律 emit('patch', {...}) 或语义化事件上抛，
// 不直接改写 cfg / 不直接落盘（导入形象、导入音效的两个裁剪弹层归父级所有）。
// ============================================================================
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
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
  sharedSounds: SoundMeta[]
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
const rndSubOpen = ref(false)
const rndSubHover = ref(false)
const rndSubUsed = ref(false)
const rndSubSeen = ref(false)
let rndSubTimer = 0
const rndPanelPos = reactive({ right: 0, top: 0, minWidth: 0 })
function toggleRndMenu(e: MouseEvent) {
  if (rndMenu.value) { rndMenu.value = ''; return }
  const btn = e.currentTarget as HTMLElement
  const r = btn.getBoundingClientRect()
  rndPanelPos.right = Math.max(8, window.innerWidth - r.right)
  rndPanelPos.top = r.bottom + 6
  rndPanelPos.minWidth = Math.max(r.width, 180)
  rndMenu.value = 'organize'
  // 首次打开时自动展一瞬二级菜单，让新用户知道那里能悬停
  if (!rndSubSeen.value) {
    rndSubSeen.value = true
    rndSubOpen.value = true
    rndSubUsed.value = true
    window.setTimeout(() => { if (!rndSubHover.value) rndSubOpen.value = false }, 900)
  }
}
const randomSkinPool = computed(() => props.skinGallery.items.filter((it) => it.random).map((it) => it.id))
function doRandomSkin() {
  emit('random-skin')
}
function doBatchRandom(mode: 'all' | 'none' | 'keepCurrent') {
  emit('batch-random', mode)
}
function doUseSkin(id: string) {
  emit('use-skin', id)
}
function pickSkin(id: string) {
  emit('pick-skin', id)
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

// —— 文档级监听：整理面板点外部关闭 / 二级悬停 ——
function onDocClickForRndMenu(e: MouseEvent) {
  if (!rndMenu.value) return
  const t = e.target as HTMLElement
  if (t && t.closest && t.closest('.rnd-menu')) return
  rndMenu.value = ''
}
function onDocMoveForRndMenu(e: MouseEvent) {
  if (!rndMenu.value) return
  const t = e.target as HTMLElement
  const inSub = !!(t && t.closest && t.closest('.rnd-menu-sub'))
  if (inSub) {
    rndSubHover.value = true
    if (rndSubTimer) { window.clearTimeout(rndSubTimer); rndSubTimer = 0 }
    rndSubOpen.value = true
    return
  }
  if (rndSubHover.value) {
    rndSubHover.value = false
    if (rndSubTimer) window.clearTimeout(rndSubTimer)
    rndSubTimer = window.setTimeout(() => { rndSubOpen.value = false; rndSubTimer = 0 }, 220)
  }
}

onMounted(() => {
  refreshSkinPacks()
  refreshSharedSkins()
  refreshSharedSounds()
  dlTick()
  document.addEventListener('click', onDocClickForRndMenu)
  document.addEventListener('mousemove', onDocMoveForRndMenu)
})
onUnmounted(() => {
  dlTickStop()
  stopBuiltinAudio()
  if (rndSubTimer) { window.clearTimeout(rndSubTimer); rndSubTimer = 0 }
  if (removeConfirmTimer) { clearTimeout(removeConfirmTimer); removeConfirmTimer = null }
  document.removeEventListener('click', onDocClickForRndMenu)
  document.removeEventListener('mousemove', onDocMoveForRndMenu)
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
                      :class="{ 'has-sel': !!pickedSkinned.length }"
                      :title="pickedSkinned.length
                        ? `已选中 ${pickedSkinned.length} 张，可整理它们`
                        : '整理形象：使用 / 排序 / 删除 / 是否参与随机'"
                      @click="toggleRndMenu">
                {{ pickedSkinned.length ? `已选 ${pickedSkinned.length} 张` : '整理' }}
                <span class="rnd-menu-caret">{{ rndMenu ? '▴' : '▾' }}</span>
              </button>
              <!-- 坐标在 toggleRndMenu 里按按钮实测（见 rndPanelPos）；面板是 fixed 定位，
                   所以 .rnd-menu 只作为「哪些点击算面板内部」的判定锚点（onDocClickForRndMenu） -->
              <div v-if="rndMenu" class="rnd-menu-panel"
                   :style="{ right: rndPanelPos.right + 'px', top: rndPanelPos.top + 'px', minWidth: rndPanelPos.minWidth + 'px' }">
                <!-- 第一段：作用于选中的那批。**未选中时整段不渲染**，只留一行可点的引导。
                     原来是把 6 个按钮原样摆着置灰 —— 面板一下多出 6 行灰条，比能用的项还长，
                     还会让人先去点一下试试是不是坏了。 -->
                <template v-if="pickedSkinned.length">
                  <p class="rnd-menu-title">选中的 {{ pickedSkinned.length }} 张</p>
                  <button type="button" @click="doUsePicked(); rndMenu = ''">使用这张</button>
                  <button type="button"
                          :disabled="pickedSkinned.length === skinGallery.items.length"
                          @click="doPinPicked(); rndMenu = ''">移到最前</button>
                  <button type="button"
                          :disabled="pickedSkinned.length === skinGallery.items.length"
                          @click="doBottomPicked(); rndMenu = ''">移到最后</button>
                  <button type="button" @click="applyPickedRandom(true); rndMenu = ''">参与随机</button>
                  <button type="button" @click="applyPickedRandom(false); rndMenu = ''">不参与随机</button>
                  <!-- 删除是这一列里唯一不可逆的动作，用一条分隔线与上面五项拉开：
                       连点「不参与随机」时手滑一下就删掉几张，只靠红字挡不住 -->
                  <div class="rnd-menu-sep"></div>
                  <button type="button" class="danger"
                          @click="doRemovePicked(); rndMenu = ''">删除选中的</button>
                </template>
                <button v-else class="rnd-menu-guide" type="button"
                        title="去缩略图上点一下"
                        @click="skinFlash.err = false; skinFlash.msg = '在缩略图上点一下即可选中，可连点多张'; rndMenu = ''">
                  选中缩略图后可整理它们
                </button>
                <div class="rnd-menu-sep"></div>
                <!-- 第二段：整张清单，无需先选中任何东西。低频，悬停展开（见 onDocMoveForRndMenu） -->
                <div class="rnd-menu-sub">
                  <p class="rnd-menu-title rnd-sub-trigger">
                    全部 {{ skinGallery.items.length }} 张
                    <span class="rnd-sub-caret">{{ rndSubOpen ? '▾' : '▸' }}</span>
                  </p>
                  <div v-show="rndSubOpen" class="rnd-sub-panel">
                    <button type="button"
                            :disabled="skinGallery.items.length > 0 && randomSkinPool.length >= skinGallery.items.length"
                            @click="doBatchRandom('all')">全部参与随机</button>
                    <button type="button" :disabled="randomSkinPool.length === 0"
                            @click="doBatchRandom('none')">全部不参与随机</button>
                    <button type="button"
                            :disabled="randomSkinPool.length === 1 && skinGallery.items.some(it => it.id === skinGallery.current)"
                            @click="doBatchRandom('keepCurrent')">只保留使用中那张</button>
                  </div>
                </div>
              </div>
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
                    @click="pickSkin(it.id)"
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
        「整理 → 全部」那一段不用先选中，可整批切换参与随机。
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
        <button class="link-btn utils-btn utils-secondary" @click="emit('toggle-builtin-fold', !builtinFold)">{{ builtinFold ? '收起内置资源' : '内置资源（随插件附带，只作对照）' }}</button>
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
                        :title="skinPackInstalled[s.id] ? `${s.id}（已下载，点选用）`
                          : `${s.id}（未下载，点一下下载，下完自动切到这张）`"
                        @click="doSkinPackCell(s.id)">
                  <img class="skin-cell-img" :src="skinPackThumb(s.id)" :alt="s.id" />
                </button>
                <!-- 角标写「下载」：v1.8.0 起这批只剩 1 张，「下载全部」显得莫名其妙 -->
                <span v-if="!skinPackInstalled[s.id]" class="skin-cell-badge">下载</span>
                <!-- 名字与警示标签二选一：两个都贴 bottom:0，同时渲染会叠在一起看不清。
                     「正在使用 · 未下载」本身已含「是哪张」的信息（它只可能出现在 cfg.skin 那张上） -->
                <span v-if="skinInUseMissing && s.id === cfg.skin" class="skin-cell-tag warn">正在使用 · 未下载</span>
                <span v-else class="skin-cell-tag">{{ s.id }}</span>
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
          共享角色
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
          共享音效库
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

<style scoped />
