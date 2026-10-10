<script lang="ts" setup>
// ============================================================================
// 资源页：素材集中管理（概览 / 形象 / 气泡图 / 音效 / 预览/导出素材包）。
// 「形象」「音效」两张卡各自统管多个来源 —— 产物都落进同一处（skins 画廊 / sounds 六槽位），
// 故都合并成「上段我的 X + 下段可下载 X」两段，用户不必再猜「我那张 / 那段在哪张卡里」。
// 合并前的对照：形象 = 导入的形象 + 内置资源(形象部分) + 共享形象（三卡）；
// 音效 = 导入的音效(六槽位) + 共享音效库(45 段素材池)（两卡）—— 现各并成一张。
// 与「挂件外观」分工：那边只选「用哪个」，这里管「导了什么、占多大、要不要删、换机器怎么带走」。
// 抽出约定：素材状态（skinGallery / soundsMeta / bubbleItems 等）由父级持有并 props 下传，
// 本组件只做展示与交互，改动一律 emit('patch', {...}) 或语义化事件上抛，
// 不直接改写 cfg / 不直接落盘（导入形象、导入音效的两个裁剪弹层归父级所有）。
// ============================================================================
import { computed, onMounted, onUnmounted, reactive, ref, watch, nextTick } from 'vue'
import { msgCls, useFlash, type Flash } from '../composables/useFlash'
import SoundRow from '../components/SoundRow.vue'
import DownloadBox from '../components/DownloadBox.vue'
import type {
  AssetsApplyResult, AssetsExportResult, AssetsPreviewResult, BubbleMeta, DownloadProgress,
  SharedSkinList, SharedSoundItem, SharedSoundList, SkinGallery, SkinMeta, SkinPackList,
  SoundMeta, SoundRole, AlertRole, WhaleServices,
} from '../types/services'

// 统一的消息态（Flash）：定义收口在 composables/useFlash.ts，各卡不再各持一份。

const props = defineProps<{
  cfg: any
  // 卡片显隐判定：与父级同源（搜索态按 searchHits 命中，否则看 activeTab），
  // 本组件含 4 张可独立命中的卡，故逐段调用而不能整体包一层 v-if
  cardOn: (tab: string, key: string) => boolean
  searchActive: boolean
  services: Partial<WhaleServices>
  // —— 父级持有的素材状态 ——
  skinGallery: SkinGallery
  skinMeta: SkinMeta | null
  skinPicked: string[]
  pickedSkinned: SkinMeta[]
  // 形象消息槽：与「挂件外观」页共用父级同一份。整理面板里的批量动作（参与随机 / 置顶 /
  // 删除等）由父级改它，本卡负责在「资源」页把它渲染出来 —— 若自持本地 reactive，
  // 父级写的消息就落不到这里，用户点「参与随机」看不到任何反馈（「点了没反应」）
  skinFlash: Flash
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
  // —— 父级的忙碌态（与 assets 卡片联动） ——
  assetsBusy: boolean
  // 「展开形象卡」指令：新手引导的「去挑形象」会把它 +1。折叠态是本组件私有（galleryFolds），
  // 父级改不了，故用自增计数器当一次性指令（父级只写、这里 watch 后展开）
  browseSkinsTick: number
  // 读打包缩略图转 data URL（下共享角色时一并落盘）：LookView 域的 backfillMissingThumbs 也用，父级唯一来源
  sharedSkinThumbDataUrl: (id: string) => Promise<string>
  // —— 父级常量（值来自父级，避免容器双写） ——
  builtinSkins: string[]
  legacyBuiltinSkins: string[]
  // 共享角色的 id + 展示名（清单里没 name，靠这份常量把 id 翻成中文名）
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
  (e: 'preview-sound', role: SoundRole, idx: number): void
  // 试听共享库里的一段（本卡槽位内「选用…」面板用）：file 是落盘文件名，done 让面板复位高亮
  (e: 'preview-shared-sound', file: string, done: () => void): void
  (e: 'import-sound', role: SoundRole): void
  (e: 'remove-sound', role: SoundRole, file?: string): void
  (e: 'import-bubble'): void
  (e: 'remove-bubble', id: string): void
  (e: 'clear-unused'): void
  (e: 'clear-assets'): void
  // 皮肤挑选态 / 操作说明折叠 / 内置音色试听：父级持有共享状态
  (e: 'clear-picked'): void
  (e: 'toggle-skin-hint'): void
  (e: 'stop-preview'): void
  (e: 'refresh-sounds'): void
  (e: 'refresh-skin'): void
  (e: 'refresh-bubbles'): void
}>()

const services = computed(() => props.services)

// 消息槽取值别名：props 是 reactive 对象，取出的引用与父级同一份 —— 本卡写它等于写父级持有的那份，
// 卡片底部的 soundFlash 才能实时显示（同理 skinFlash / bubbleFlash 在模板里直接以 props 名访问）。
// 音效相关的几个操作函数（applySharedRoles / 下载 / 删除 / 试听）都要写它，起个短名省得处处 props.
const soundFlash = props.soundFlash

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
  if (needDeleteConfirm('seg:' + role + ':' + (file || ''))) return
  emit('remove-sound', role, file)
}
// 槽位里当前那段的名字（用于提示文案里点名「已导入的那段是谁」）。
// 自己导入的段一个槽位只保留一段，所以取第一条即可。
function soundNameOf(role: SoundRole): string {
  const it = soundMetaOf(role)[0]
  return it ? String(it.name || '') : ''
}
// 共享库里「参加了某槽位播放」的段（按 roles 反查）。槽位块下方列出来，可单独摘掉。
function sharedPinnedTo(role: SoundRole): SharedSoundItem[] {
  return sharedSoundInstalledItems.value.filter((it) => it.roles.indexOf(role) >= 0)
}
// 已下载、但还没挂到本槽位的段 —— 「从共享库添加…」面板里可加的那些。
// 已挂上的不重复出现（改到槽位块下方的「来自共享音效库」列表里管理），避免同一段在一处既显示「添加」又显示「移出」。
function sharedPickCandidates(role: SoundRole): SharedSoundItem[] {
  return sharedSoundInstalledItems.value.filter((it) => it.roles.indexOf(role) < 0)
}
// 候选面板的关键词过滤。45 段全下载时，一个槽位就有 44 行候选 —— 不筛的话得靠滚动肉眼找。
// 只按文件名匹配（这是行里唯一可读的信息），大小写不敏感。
const soundPickQuery = ref('')
const soundPickFiltered = computed(() => {
  const q = soundPickQuery.value.trim().toLowerCase()
  const list = sharedPickCandidates(soundPickOpen.value as SoundRole)
  if (!q) return list
  return list.filter((it) => String(it.name || '').toLowerCase().indexOf(q) >= 0)
})

// —— 从共享音效库添加音效到槽位（本卡内「这个槽位还想再挂几段共享库的」） ——
// 语义与旧「选用」不同：不再把音频另存一份搬进槽位，而是把**当前槽位**加进池里那段的 roles。
// 所以这里不需要选槽位（槽位就是当前展开的这个块），也就没有那个多余的下拉了。
// 忙态与提示跟「共享音效」卡共用 sharedSoundBusy / soundFlash —— 两边操作的是同一份素材池。
// 哪个槽位展开了「从共享库添加」面板（空串 = 都没展开，同时只开一个）
const soundPickOpen = ref<SoundRole | ''>('')
// 卡尾「音效使用说明」的展开态。低频说明文字，默认收起 —— 纯展示态、不给父级
const soundHelpOpen = ref(false)
// 试听走父级（与本卡其它试听同一条音频通道，两个试听不会同时响）；
// 和槽位已有的「试听」共用一条事件，父级只认角色不关心这声是从哪张卡点进来的。
const pickPreviewRole = ref<SoundRole | ''>('')
const previewingPickId = ref('')
function doPreviewPickSound(it: SharedSoundItem) {
  if (pickPreviewRole.value) {
    emit('preview-sound', pickPreviewRole.value, -1)
    pickPreviewRole.value = ''
    if (previewingPickId.value === it.id) { previewingPickId.value = ''; return }
  }
  previewingPickId.value = it.id
  pickPreviewRole.value = 'press'
  emit('preview-shared-sound', it.file, () => {
    if (previewingPickId.value === it.id) { previewingPickId.value = ''; pickPreviewRole.value = '' }
  })
}
// 把当前槽位加进这段共享音效的 roles（这段就多参加一个槽位的播放）。
// 「一段可同时挂多个槽位」是这次改动的核心 —— 槽位不再有「放不下」的容量焦虑。
async function doAddPickSound(it: SharedSoundItem) {
  const role = soundPickOpen.value
  if (!role) return
  await applySharedRoles(it, it.roles.concat(role), `已把「${it.name}」加到${SOUND_ROLE_LABEL[role] || role}`)
}
// 从某槽位摘掉这段共享音效（只影响这一个槽位）
async function doUnpinPickSound(it: SharedSoundItem, role: SoundRole) {
  await applySharedRoles(it, it.roles.filter((x) => x !== role), `已把「${it.name}」从${SOUND_ROLE_LABEL[role] || role}移出`)
}
// 共享库某段参加哪些槽位 —— 所有写入口最终都汇到这里，避免「切音色」的收尾逻辑在几处各写一遍
async function applySharedRoles(it: SharedSoundItem, roles: SoundRole[], okMsg: string) {
  if (sharedSoundBusy.value) return
  soundFlash.msg = ''
  soundFlash.err = false
  sharedSoundBusy.value = true
  try {
    const r = services.value.setSharedRoles?.(it.file, roles)
    emit('refresh-sounds')
    refreshSharedSounds()
    if (r && r.ok) {
      // 挂上「按压 / 释放」这段时，若当前音色不是「自定义」，它不会响 —— 顺手切过去
      let switched = false
      const affectsTap = roles.some((x) => x === 'press' || x === 'release')
      if (props.cfg.soundOn && props.cfg.soundSet !== 'custom' && affectsTap) {
        emit('patch', { soundSet: 'custom' })
        switched = true
      }
      soundFlash.msg = okMsg + (switched ? '，并把「音色」切到了「自定义」' : '')
      soundFlash.err = false
    } else {
      soundFlash.msg = (r && r.error) || '设置失败'
      soundFlash.err = true
    }
  } finally {
    sharedSoundBusy.value = false
  }
}

// —— 素材总览 / 占用统计 ——
const importedSoundCount = computed(() => SOUND_ROLES.reduce((n, r) => n + (props.soundsMeta[r] || []).length, 0))
// 「导入的音效」折叠标题右侧的概览：有几个槽位导入了自己那段（与每行的「已导入」同口径）。
// 与上面的 importedSoundCount 不同 —— 后者是总段数（用于占用统计），这里是槽位数
const soundImportedCount = computed(() => SOUND_ROLES.filter((r) => (props.soundsMeta[r] || []).length > 0).length)
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
// 「形象」与「音效」两张合并卡都默认收起：一展开就是三块网格 / 六个槽位加 45 段清单，一次铺满整屏。
// 默认收起时只留一行「共 N 张 · 另有 M 张可下载」/「已导入 n / 6 个槽位」，
// 用户扫一眼就知道有没有待下载的，需要挑 / 下载再点开（一个折叠换整页清爽）。
// 合并前「音效」的折叠态在父级（assetFolds.sounds），合并后与形象统一收进这里 ——
// 两张卡都是「私有折叠 + 搜索命中强制展开」的同一套，父级不必再持一份副本。
const galleryFolds = reactive({ skins: false, sounds: false })
function galleryOpen(key: 'skins' | 'sounds') {
  // 搜索态下强制展开：命中的卡如果还收着，用户搜到了却看不到内容（还以为没搜到）。
  // 与折叠态无关，只是「搜索时一律铺开」。
  return props.searchActive || galleryFolds[key]
}
// 「可下载形象 / 可下载音效」两段各自的折叠态（卡级折叠之下的第二层）。
// 默认收起：这两段是「上游有、按需下载」的长列表（36 张缩略图 / 45 段清单），
// 日常挑图 / 配槽位用的是上段（我的形象 / 我的音效），下段只在真要补下载时才展开。
// **不参与搜索强制展开** —— 全站搜索锚点挂在卡上（data-search），段内没有独立锚点，
// 若这里也跟 galleryOpen 一样被搜索顶开，「默认收起」就等于白设，且搜索任意形象关键词都会铺开 36 张。
const dlFolds = reactive({ skins: false, sounds: false })
// 下载类动作（卡头「下载剩余 N 张 / 段」、单张点缩略图、新手引导「去挑形象」）会往这两段里
// 写进度 / 亮 flash，所以触发前先把对应段展开 —— 否则用户点了下载却看不见任何反馈（进度藏在收起段里）。
function openDl(key: 'skins' | 'sounds') { dlFolds[key] = true }
// 分区小标题：命中 2 张以上才显示，搜索只命中单卡时不出现分隔线（纯噪音）。
// 合并后「形象」「音效」两张卡都横跨「我的素材」与「下载素材」两区（上段是本机的、下段是可下载的），
// 按各自的主增量统一归到「下载素材」组。
const MINE_CARDS = ['assetsOverview', 'assetsBubbles']
const DOWNLOAD_CARDS = ['assetsSkins', 'assetsSounds']
function showSection(group: 'mine' | 'download') {
  const keys = group === 'mine' ? MINE_CARDS : DOWNLOAD_CARDS
  return keys.filter((k) => props.cardOn('assets', k)).length >= 2
}
const assetsFlash: Flash = useFlash()
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
// 口径统一为 `random !== false`（缺省参与）——宿主 listSkins 已把该字段归一化成真布尔，
// 但设置页各处读法此前不一（此处真值、别处 `!== false`、角标处 `=== false`），
// 一旦数据源变化就会出现「计数与角标对不上」。全项目一律按「缺省 = 参与」判定。
const randomSkinPool = computed(() => props.skinGallery.items.filter((it) => it.random !== false).map((it) => it.id))
// 随机池的括号口径：随包内置那张是池里常驻的一员，池子规模的对外说法要带上它，
// 否则用户按「参与随机 N 张」去数格子会对不上（格子只覆盖画廊里的项）。
// 父级「内置形象也参与随机」开关关掉时它不在池里，这时不提
const poolBuiltinNote = computed(() => (props.cfg.randomIncludeBuiltin === false ? '' : '（另含随包内置那张）'))
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
    { mode: 'all' as const, label: `此页 ${n} 张全都参与随机`, on: randomMode.value === 'all' },
    { mode: 'none' as const, label: '此页都不参与随机', on: randomMode.value === 'none' },
    { mode: 'keepCurrent' as const, label: '只让「使用中」那张参与随机', on: randomMode.value === 'keepCurrent' },
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
// 单击缩略图 = 切换选中。选中反馈文案由父级写进共用的 skinFlash（本卡只负责渲染），
// 避免本卡自持消息槽导致父级写的批量动作反馈落不到「资源」页
function onSkinPicked(id: string) {
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
  if (needDeleteConfirm('skin:' + id)) return
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
  if (needDeleteConfirm('bubble:' + id)) return
  emit('remove-bubble', id)
}

// —— 内置资源 / 形象包 ——
const SKIN_PACK_PREFIX_MAX = 200
function skinPackThumb(id: string) {
  return './whale-pack/thumbs/' + encodeURIComponent(id) + '.webp'
}
// 把打包好的「随包内置」缩略图（whale-pack/thumbs/<id>.webp）读成 data URL 交给宿主落盘。
// 与父级 sharedSkinThumbDataUrl 同款（宿主定位不到插件目录，缩略图必须由渲染进程给）：
// 下载内置形象时若不带缩略图，画廊只能回落读原图（MB 级），很快耗尽回落预算变「无预览」。
// 读失败一律回 ''：宁可这张暂时没缩略图，也不能因为读图失败把下载带崩。
async function skinPackThumbDataUrl(id: string): Promise<string> {
  try {
    const res = await fetch(skinPackThumb(id))
    if (!res.ok) return ''
    const buf = await res.arrayBuffer()
    if (!buf.byteLength) return ''
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return 'data:image/webp;base64,' + btoa(bin)
  } catch (err) {
    return ''
  }
}

const skinPackList = ref<SkinPackList | null>(null)
const skinPackBusy = ref(false)
const skinPackFlash: Flash = useFlash()
const skinPackInstalled = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {}
  for (const it of (skinPackList.value?.items || [])) out[it.id] = it.installed === true
  return out
})
const skinPackItems = computed(() => skinPackList.value?.items || [])
const skinPackInstalledCount = computed(() => skinPackItems.value.filter((it) => it.installed).length)
const skinPackRemainBytes = computed(() => skinPackItems.value.reduce((n, it) => n + (it.installed ? 0 : Number(it.size) || 0), 0))
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
// 首次判定出缺失时自动展开「形象」折叠区（否则提示藏在收起区里等于没有）。
// 只在「从未展开过」时替用户展开一次，之后尊重他的手动收起（不反复弹开）。
// 合并前这里 emit('toggle-builtin-fold') 交给父级的 assetFolds.builtin；现在这张卡自己管折叠态，
// 直接开本地 galleryFolds.skins 即可（父级那份 assetFolds.builtin 已随「内置资源」卡一并删掉）。
const builtinFoldAutoOpened = ref(false)
watch(skinInUseMissing, (v) => {
  if (v && !builtinFoldAutoOpened.value) {
    builtinFoldAutoOpened.value = true
    galleryFolds.skins = true
    openDl('skins') // 「找回缺失形象」的入口就在「可下载形象」段里，收起时提示等于没有
  }
}, { immediate: true })
function refreshSkinPacks() {
  const r = services.value.listSkinPacks?.()
  skinPackList.value = r && Array.isArray(r.items) ? r : null
}
// 整包下载：卡头「下载剩余 N 张」里属于随包内置那部分（一次 Release，含整包 sha256 校验）。
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
  if (skinPackBusy.value) return
  skinPackFlash.msg = ''
  skinPackFlash.err = false
  skinPackBusy.value = true
  dlTickStart()
  try {
    // 单张下载（链路与「下载全部」不同）：宿主按 id 取那一张的原始图，逐张 sha256 校验后落盘。
    // 早期这里是「点任意一张 = 下整包」，但本批只剩 1 张，整包与单张等价、单张失败面更小，
    // 且与共享角色（点一张下一张）语义一致，用户不必记「这张卡点缩略图会连带下别的」。
    // 缩略图先读成 data URL 一并传下去，否则画廊只能回落读原图（MB 级）。
    const thumb = await skinPackThumbDataUrl(id)
    const r = await services.value.downloadSkinPackItem?.(id, props.cfg.skinPackSrc || '', thumb)
    emit('refresh-skin')
    refreshSkinPacks()
    if (!r || !r.ok) {
      skinPackFlash.msg = (r && r.error) || '下载失败，请稍后重试'
      skinPackFlash.err = true
      return
    }
    skinPackFlash.msg = `已下载「${skinPackLabel(id)}」`
    skinPackFlash.err = false
    doUseSkin(id)
  } finally {
    skinPackBusy.value = false
  }
}

// —— 共享角色 ——
function sharedSkinThumb(id: string) {
  return './resources/thumbs/' + encodeURIComponent(id) + '.webp'
}
// sharedSkinThumbDataUrl（读打包缩略图转 data URL）留在父级：LookView 域的
// backfillMissingThumbs 也要用它补老数据缺的缩略图，父级唯一来源，这里用 prop 收。
const sharedSkinList = ref<SharedSkinList | null>(null)
const sharedSkinBusy = ref(false)
const sharedSkinFlash: Flash = useFlash()
const sharedSkinInstalled = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {}
  for (const it of (sharedSkinList.value?.items || [])) out[it.id] = it.installed === true
  return out
})
const sharedSkinItems = computed(() => sharedSkinList.value?.items || [])
const sharedSkinInstalledCount = computed(() => sharedSkinItems.value.filter((it) => it.installed).length)
const sharedSkinRemainBytes = computed(() => Number(sharedSkinList.value?.totalSize || 0)
  - sharedSkinItems.value.reduce((n, it) => n + (it.installed ? (Number(it.size) || 0) : 0), 0))
const sharedSkinNames = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const s of props.sharedSkinPackSkins) out[s.id] = s.name
  return out
})
function refreshSharedSkins() {
  const r = services.value.listSharedSkins?.()
  sharedSkinList.value = r && Array.isArray(r.items) ? r : null
}
// 共享角色下载不适合 await：36 张串行、单张失败不中断（见上方说明）。
// 调方（卡头「下载剩余」/ 点缩略图）只关心「把请求发出去」，这里的错误由 sharedSkinFlash 回显。
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
// 点共享角色缩略图：已下载 → 直接选用；未下载 → 只下这一张（不是整批）。
// 不加 async：内层用 .then 在下载完的回调里选用，避免 await 让本函数返回的 Promise
// 被「进度条/按钮禁用」等场景反复等待（同一张重复点也不会串行排队）。
function doSharedSkinCell(id: string) {
  if (sharedSkinInstalled.value[id]) { doUseSkin(id); return }
  if (sharedSkinBusy.value) return
  sharedSkinFlash.msg = ''
  sharedSkinFlash.err = false
  sharedSkinBusy.value = true
  dlTickStart()
  // 缩略图 data URL 由父级提供（读打包资源），是 async；这里用 .then 串起来而不是 await，
  // 好让本函数仍是非 async —— 否则「点一张」会被调用处 await，和整批下载的 busy 守卫互相卡住。
  props.sharedSkinThumbDataUrl(id).then((thumb) => {
    const p = services.value.downloadSharedSkin?.(id, props.cfg.skinPackSrc || '', thumb)
    // 老宿主（无该 API）时 p 为 undefined，退回一个立即失败的结果，走同一套提示
    return p && typeof p.then === 'function' ? p : { ok: false, error: '当前版本不支持单张下载' }
  }).then((r) => {
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
  }).catch((err) => {
    sharedSkinFlash.msg = String((err && err.message) || err || '未知错误')
    sharedSkinFlash.err = true
  }).finally(() => {
    sharedSkinBusy.value = false
  })
}

// —— 合并卡的「可下载形象」汇总（随包内置 + 共享角色两批并成一个口径） ——
// 两批的下载链路不同（整包 Release / 单张 raw 直链），但在卡内是同一个语义：
// 「上游有、还没落盘，点缩略图就下一张」。卡头的「下载剩余 N 张」与收回态摘要都按这个合计走，
// 用户不必分别数「内置剩几张 + 共享剩几张」。
const remoteSkinCount = computed(() => skinPackItems.value.length + sharedSkinItems.value.length)
const remoteSkinInstalledCount = computed(() => skinPackInstalledCount.value + sharedSkinInstalledCount.value)
const skinRemainCount = computed(() =>
  (skinPackItems.value.length - skinPackInstalledCount.value)
  + (sharedSkinItems.value.length - sharedSkinInstalledCount.value))
const skinRemainBytes = computed(() => skinPackRemainBytes.value + sharedSkinRemainBytes.value)
const skinAnyBusy = computed(() => skinPackBusy.value || sharedSkinBusy.value)
// 卡头的「下载剩余 N 张」= 把两批里还没下来的整批补齐。
// 顺序上**先补共享角色**（36 张，逐张串行、每张都有独立失败反馈，是「大头」），
// 再补随包内置（一次整包 Release，失败会写进 skinPackFlash）。
// 两批各自的 flash 与进度条分别亮，用户看得到此刻在补哪一批。
async function doDownloadAllSkins() {
  if (skinAnyBusy.value) return
  openDl('skins') // 进度条与 flash 都在「可下载形象」段内，收起时用户看不到下载feedback
  if (sharedSkinItems.value.some((it) => !it.installed)) await doDownloadSharedSkins()
  if (skinPackItems.value.some((it) => !it.installed)) await doDownloadSkinPacks()
}
// 新手引导「去挑形象」：父级把 browseSkinsTick +1，这里展开「形象」卡。
// 与 builtinFoldAutoOpened 同理 —— 折叠态是本组件私有，父级只能靠这种一次性指令驱动。
// 「可下载形象」段也一并展开：引导的落点是「挑一张形象」，「我的形象」为空时能挑的恰恰在下载段里。
watch(() => props.browseSkinsTick, () => { galleryFolds.skins = true; openDl('skins') })

// —— 音效卡内「可下载音效」段的状态 ——
// 合并后整张卡只有一个消息槽（卡片底部的 soundFlash，来自 props）与一个忙碌位。
// 「共享音效」卡原来自持的 soundFlash 已取消 —— 消息统一写进 soundFlash，
// 用户点「下载这一段」的反馈与槽位操作落在同一行，不再两处各自闪；
// 忙碌位仍是独立布尔：它只表达「库里那段正在下载」，与槽位的导入 / 删除互不阻塞。
const sharedSoundBusy = ref(false)
const sharedSoundList = ref<SharedSoundList | null>(null)
const sharedSoundItems = computed(() => sharedSoundList.value?.items || [])
const sharedSoundInstalledCount = computed(() => sharedSoundItems.value.filter((it) => it.installed).length)
const sharedSoundInstalledItems = computed(() => sharedSoundItems.value.filter((it) => it.installed))
const sharedSoundPendingItems = computed(() => sharedSoundItems.value.filter((it) => !it.installed))
const sharedSoundPendingOpen = ref(false)
// 45 段铺开时「已下载」那半截要滚很久才找得到某一段；这两个控件把它收窄：
// 关键词按文件名筛，筛选档在「全部 / 已参加播放 / 一段都没挂」之间切。
// 只作用于「已下载」组 —— 「未下载」组的用途是逐段补下载，筛它没有意义。
const sharedSoundQuery = ref('')
const sharedSoundFilter = ref<'all' | 'pinned' | 'unpinned'>('all')
function filterSoundItems(list: SharedSoundItem[]): SharedSoundItem[] {
  const q = sharedSoundQuery.value.trim().toLowerCase()
  return list.filter((it) => {
    if (sharedSoundFilter.value === 'pinned' && !it.roles.length) return false
    if (sharedSoundFilter.value === 'unpinned' && it.roles.length) return false
    if (q && String(it.name || '').toLowerCase().indexOf(q) < 0) return false
    return true
  })
}
const sharedSoundInstalledShown = computed(() => filterSoundItems(sharedSoundInstalledItems.value))
const previewingSharedId = ref<string | null>(null)
// 二次确认：第一下点「删」只把该行切成「确认删」，3 秒内再点才真删。
// 全组删除动作（共享音效段 / 用户导入形象 / 气泡图 / 槽位音效段）共用这一个 key，
// 用前缀区分来源（如 'skin:<id>'）——删错形象或删错音效段都不可撤销，交互必须一致。
const removeConfirmId = ref<string | null>(null)
let removeConfirmTimer: ReturnType<typeof setTimeout> | null = null
// 返回 true = 已进入确认态、本次不执行；返回 false = 用户已二次点下，调用方照常执行删除。
function needDeleteConfirm(key: string): boolean {
  if (removeConfirmId.value !== key) {
    removeConfirmId.value = key
    if (removeConfirmTimer) clearTimeout(removeConfirmTimer)
    removeConfirmTimer = setTimeout(() => { removeConfirmId.value = null }, 3000)
    return true
  }
  if (removeConfirmTimer) { clearTimeout(removeConfirmTimer); removeConfirmTimer = null }
  removeConfirmId.value = null
  return false
}
const sharedSoundRemainBytes = computed(() => Number(sharedSoundList.value?.totalSize || 0)
  - sharedSoundItems.value.reduce((n, it) => n + (it.installed ? (Number(it.size) || 0) : 0), 0))

// 未下载的共享段数：卡头「下载剩余 N 段」与收起态摘要都按它算，
// 用户不必分别数「槽位导了几段 + 库里少了多少段」。
const sharedSoundRemainCount = computed(() =>
  sharedSoundItems.value.length - sharedSoundInstalledCount.value)
// 下段列表里「哪一行展开了槽位 chip」（空串 = 都没展开）。6 个 chip 常驻会制造 45 行的噪音，
// 收进行内展开后同一时刻只开一行，扫列表时整列文件名 + 试听 / 删对得齐。
const soundRowOpen = ref('')

// 一键下载：把共享库里还没下来的逐段补回来（与形象卡头的「下载剩余 N 张」同构）。
// 六个槽位的「手导的那一段」不能这样补 —— 那是用户自己挑的文件，只能一段段拖进来。
// 顺序在 **共享段先、槽位后** 是刻意的：下载只补「可下载音效」这半截，
// 不与「从共享库添加…」抢同一处面板。
function doDownloadAllSounds() {
  if (sharedSoundBusy.value) return
  openDl('sounds') // 逐段下载的进度条 / flash 都在「可下载音效」段内，收起时看不到反馈
  void doDownloadSharedSounds()
}
function refreshSharedSounds() {
  const r = services.value.listSharedSounds?.()
  sharedSoundList.value = r && Array.isArray(r.items) ? r : null
}
async function doDownloadSharedSounds() {
  if (sharedSoundBusy.value) return
  soundFlash.msg = ''
  soundFlash.err = false
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
      soundFlash.msg = `已下载 ${okCount} 段，${failed.length} 段失败 —— ${failed[0]}`
      soundFlash.err = true
      return
    }
    soundFlash.msg = todo.length ? `已下载 ${todo.length} 段音效（存进「共享音效库」，可到下面选用）` : '共享音效已是最新，无需重复下载'
    soundFlash.err = false
  } finally {
    sharedSoundBusy.value = false
  }
}
async function doDownloadSharedSound(it: SharedSoundItem) {
  if (sharedSoundBusy.value || it.installed) return
  soundFlash.msg = ''
  soundFlash.err = false
  sharedSoundBusy.value = true
  dlTickStart()
  try {
    const r = await services.value.downloadSharedSound?.(it.id, props.cfg.skinPackSrc || '')
    emit('refresh-sounds')
    refreshSharedSounds()
    if (!r || !r.ok) {
      soundFlash.msg = (r && r.error) || '下载失败，请稍后重试'
      soundFlash.err = true
      return
    }
    soundFlash.msg = `已下载「${r.name || it.name}」`
    soundFlash.err = false
  } finally {
    sharedSoundBusy.value = false
  }
}
function doRemoveSharedSound(it: SharedSoundItem) {
  if (needDeleteConfirm('shared:' + it.id)) return
  soundFlash.msg = ''
  soundFlash.err = false
  const r = services.value.removeSharedSound?.(it.file || '')
  if (!r || !r.ok) {
    soundFlash.msg = (r && r.error) || '删除失败'
    soundFlash.err = true
    return
  }
  refreshSharedSounds()
  emit('refresh-sounds')
  if (previewingSharedId.value === it.id) stopPreviewShared()
  soundFlash.msg = `已删除「${it.name}」`
    + (it.roles.length ? `（它原本参加的${it.roles.map((x) => SOUND_ROLE_LABEL[x] || x).join(' / ')}也一并退出播放）` : '')
}
// 切换「这段共享音效参加某个槽位的播放」（勾选 / 取消勾选）。
// 一眼看上去像纯前端 toggle，但每次都要落盘并让宿主重推给挂件，故仍走 applySharedRoles 的统一收尾。
async function toggleSharedRole(it: SharedSoundItem, role: SoundRole, on: boolean) {
  const next = on ? it.roles.concat(role) : it.roles.filter((x) => x !== role)
  await applySharedRoles(it, next, on
    ? `「${it.name}」已参加${SOUND_ROLE_LABEL[role] || role}的播放`
    : `「${it.name}」已退出${SOUND_ROLE_LABEL[role] || role}的播放`)
}
function doPreviewSharedSound(it: SharedSoundItem) {
  soundFlash.msg = ''
  soundFlash.err = false
  if (previewingSharedId.value === it.id) { stopPreviewShared(); return }
  const r = services.value.readSharedSoundData?.(it.file)
  if (!r || !r.ok || !r.url) {
    soundFlash.msg = (r && r.error) || '没有可试听的音效'
    soundFlash.err = true
    return
  }
  previewingSharedId.value = it.id
  playAudioUrl(r.url, soundFlash, () => { previewingSharedId.value = null })
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
// 两张下载大清单（共享形象 / 共享音效）与内置资源卡默认收起，展开才去拉私有数据。
// 为什么不放 onMounted 一次拉完：这些卡是 v-if，本组件挂载时它们并不在 DOM 里，
// onMounted 拉回来的数据会因为没有可见消费方而一直被忽略；等用户点开时又不会再拉，
// 于是「共享形象 / 共享音效」永远显示 0 张（曾踩：展开后一片空，点「下载全部」也没反应）。
// 卡片展开时补拉一次。搜索态也会让 galleryOpen 变 true（见上），故依赖里仍含 searchActive ——
// 搜索命中的下载卡同样会在展开时补拉，不会出现「搜到了却渲染 0 张」。
watch(
  () => [galleryOpen('skins'), galleryOpen('sounds')],
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

defineExpose({ refreshSkinPacks, refreshSharedSkins, refreshSharedSounds })
</script>

<template>
  <div>
    <!-- [资源] 素材集中管理，按「素材从哪来」分两区：
         · 我的素材 —— 导进来 / 下回来、落在本机、能删能用的那些（概览 · 气泡图）
         · 下载素材 —— 上游有、按需从 GitHub 拉的目录（形象 · 音效）
         「形象」「音效」两张卡都横跨两区（上段是本机的、下段是可下载的），按各自的主增量归到「下载素材」。
         分区标题只在两张以上卡片命中时显示（搜索命中单卡时分隔线纯属噪音）。
         与「挂件外观」分工：那边只选「用哪个」，这里管「导了什么、占多大、要不要删、换机器怎么带走」 -->
    <div v-if="showSection('mine')" class="assets-section">我的素材</div>
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

    <!-- [资源] 形象：本机所有可用的形象统一在一张卡里管。三个来源（用户导入 / 随包内置 / 上游共享）
         此前是三张彼此割裂的卡（「导入的形象」在「我的素材」、「内置资源与下载源」寄在音色卡里、
         「共享形象」在「下载素材」），但它们的产物其实是**同一处** —— 都落进 skins 画廊（内置 / 共享打
         builtin 标记，故不占「导入」的 20 张配额）。合并后：上段「我的形象」= 已落盘的（导入 + 已下载），
         下段「可下载形象」= 上游有、还没落盘的（随包 1 张 + 共享 36 张）。用户不必再猜「我那张在哪张卡里」 -->
    <section v-if="cardOn('assets', 'assetsSkins')" class="card" data-search="assetsSkins">
      <div class="card-head">
        <button class="fold-title" type="button" @click="galleryFolds.skins = !galleryFolds.skins; rndMenu = ''; emit('clear-picked')">
          <span class="fold-caret">{{ galleryOpen('skins') ? '▾' : '▸' }}</span>
          形象
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
                <!-- 三项不只是「可选动作」，也是「当前取图范围」的三种状态（命中项打勾）。
                     所以文案写成状态描述（「此页 N 张全都参与…」）而不是动作描述（「随机时会抽到它们」）：
                     用户读到的就是「我现在处于哪一档」，不必先在心里把动作名翻译成状态，
                     也不容易把「抽到」与「不抽」按反。勾选 / 可点性仍来自 randomChoices / randomMode -->
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
            <!-- 可下载形象的「下载剩余 N 张」：三卡合并后，「内置 1 张 + 共享 36 张」两个下载入口
                 收进卡头这一个（次要对齐按钮，与「随机一张 / 导入图片…」同档；
                 不再各占一张卡的主按钮）。点它 = 把没下来的整批补齐（单张仍可点下方缩略图） -->
            <button v-if="skinRemainCount" class="export-btn utils-btn utils-outline" type="button"
                    :disabled="skinAnyBusy"
                    :title="`把还没下载的 ${skinRemainCount} 张一起下回来（已下载的自动跳过）`"
                    @click="doDownloadAllSkins()">
              {{ skinAnyBusy ? '正在下载…' : `下载剩余 ${skinRemainCount} 张（约 ${fmtBytes(skinRemainBytes)}）` }}
            </button>
        </div>
      </div>
      <p v-if="!galleryOpen('skins')" class="hint">
        共 {{ skinGallery.items.length }} 张{{ skinMeta ? `，当前使用「${skinMeta.name}」` : '' }}
        <template v-if="skinRemainCount">· 另有 {{ skinRemainCount }} 张可下载（约 {{ fmtBytes(skinRemainBytes) }}）</template>。
      </p>
      <template v-if="galleryOpen('skins')">
      <!-- 上段：已落盘的形象。包含用户导入的（占 20 张配额、删了要重导）与已下载的内置 / 共享
           （不占配额、删了能重下）—— 两类靠悬停「删」的 title 文案区分，不必再分两张卡 -->
      <p class="group-title skin-group-title">我的形象 <em>（共 {{ skinGallery.items.length }} 张 · 点缩略图选用；单击选中可批量整理）</em></p>
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
                    @click="onSkinPicked(it.id)"
                    @dblclick="doUseSkinPick(it.id)">
              <img v-if="it.thumb && !thumbBroken[it.id]" class="skin-cell-img" :src="it.thumb" :alt="it.name"
                   @error="onThumbError(it.id)" />
              <span v-else-if="thumbBroken[it.id]" class="skin-cell-broken">预览失败</span>
              <span v-else class="skin-cell-none">无预览</span>
            </button>
            <span v-if="it.id === skinGallery.current" class="skin-cell-tag">使用中</span>
            <!-- 随机态**双向都标、且都不用文字**（2026-10-08 反馈）：
                 同一套圆点标准，靠颜色区分，不再用「不参与随机」通栏文字 ——
                 文字角标会盖住缩略图底部、还和左下角序号抢位置，读起来也慢。
                 · 参与 → 右上角绿点（沿用「外观」页图例那枚的形态与配色）；
                 · 不参与 → 右上角灰点，与绿点同尺寸同位置，只有颜色不同。
                 两枚点位置一致，扫一眼颜色即可判断，不占任何文案空间。 -->
            <span class="skin-cell-pool-dot" :class="it.random !== false ? 'is-on' : 'is-off'"
                  :title="it.random !== false ? '参与随机：会被「随机一张」抽到' : '不参与随机：不会被抽到'"></span>
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
      <!-- 随机池规模常驻在画廊下方：此前只在「操作说明」展开时才看得到，用户停在画廊时
           不知道「随机一张」到底会从几张里抽。颜色含义不再写在这里 —— 点就在格子上，
           写完反而成了每次都要读一遍的长句；悬停有 title 兜底。 -->
      <p v-if="skinMeta" class="hint">
        参与随机 {{ randomSkinPool.length }} / {{ skinGallery.items.length }} 张{{ poolBuiltinNote }}，「随机一张」从它们里挑。
      </p>
      <p v-if="skinMeta && skinHintOpen" class="hint">
        单击缩略图选中（可连点多张），再点卡片上方「整理」，可对它们：切换使用 / 移到最前 / 移到最后 / 参与随机 / 不参与随机 / 删除；
        双击缩略图直接切换使用，最多保留 20 张；直接拖动缩略图可排到任意位置；
        右上角圆点表示是否参与随机，绿 = 参与、灰 = 不参与。
      </p>
      <p v-else-if="!skinMeta" class="hint">
        还没有导入形象。点「导入图片…」加一张，支持 png / jpg / webp / gif / apng（动图不裁剪，保留动画）。
      </p>
      <p v-if="skinUnused" class="hint">
        已导入但当前未使用：「挂件外观 → 形象」选的不是「自定义」。
      </p>
      <p v-if="skinFlash.msg" class="msg" :class="msgCls(skinFlash)">{{ skinFlash.msg }}</p>

      <!-- 下段：可下载形象。内置（随包 1 张）与共享（上游 QQ 群 36 张）分两小组列出 ——
           两者的下载链路不同（整包 Release / 单张 raw 直链），但都是「点缩略图即下这一张」，
           故并排呈现、各带自己的进度条与说明；下段整体只在有可下载项时出现。
           标题即本段折叠开关（默认收起，见 dlFolds 注释）：收起态仍报「N / M 已下载」，
           一眼能看出有没有待补的；真要挑 / 下载再点开，不必让 36 张缩略图常驻屏上 -->
      <template v-if="remoteSkinCount">
        <button class="group-title skin-group-title dl-title" type="button"
                :title="dlFolds.skins ? '收起下载区' : '展开下载区，看上游还有哪些形象可下'"
                :aria-expanded="dlFolds.skins"
                @click="dlFolds.skins = !dlFolds.skins">
          <span class="dl-caret">{{ dlFolds.skins ? '▾' : '▸' }}</span>
          可下载形象 <em>（点缩略图即可下载那一张，下完自动切到它；{{ remoteSkinInstalledCount }} / {{ remoteSkinCount }} 已下载）</em>
          <span class="dl-action">{{ dlFolds.skins ? '收起' : '展开' }}</span>
        </button>
        <template v-if="dlFolds.skins">
        <div class="dl-body">
        <DownloadBox v-if="dlProgress && dlProgress.pack === 'skins'"
                     :progress="dlProgress" :percent="dlPercent" :amount="dlAmountText" />
        <DownloadBox v-if="dlProgress && dlProgress.pack === 'shared-skins'"
                     :progress="dlProgress" :percent="dlPercent" :amount="dlAmountText" />
        <p v-if="skinInUseMissing" class="msg err">
          你正在使用的形象「{{ missingSkinName }}」不在随包清单里，挂件暂用默认形象显示。
          点下方它的缩略图即可下载找回。
        </p>
        <!-- 内置（随包声明、可下载）：未装灰底 + 「下载」角标；已装则与本卡上段共用一套展示（可选用 / 可删）。
             已装的项也在上段画廊里（同一份数据），这里同时列出是为了「一个入口看全所有可选形象」 -->
        <p v-if="skinPackItems.length" class="skin-sub-title">随包内置 <em>（{{ skinPackInstalledCount }} / {{ skinPackItems.length }} 已下载）</em></p>
        <div v-if="skinPackItems.length" class="skin-grid">
          <div v-for="s in skinPackItems" :key="'p-' + s.id" class="skin-cell"
               :class="{ active: cfg.skin === s.id, 'is-remote': !skinPackInstalled[s.id] }">
            <div class="skin-box">
              <button class="skin-cell-pick" type="button"
                      :title="skinPackInstalled[s.id] ? `${skinPackLabel(s.id)}（已下载，点选用）`
                        : `${skinPackLabel(s.id)}（未下载，点一下下载，下完自动切到这张）`"
                      @click="doSkinPackCell(s.id)">
                <img class="skin-cell-img" :src="skinPackThumb(s.id)" :alt="skinPackLabel(s.id)" />
              </button>
              <span v-if="!skinPackInstalled[s.id]" class="skin-cell-badge">下载</span>
              <!-- 名字与警示标签二选一：两个都贴 bottom:0，同时渲染会叠在一起看不清。
                   「正在使用 · 未下载」本身已含「是哪张」的信息（它只可能出现在 cfg.skin 那张上） -->
              <span v-if="skinInUseMissing && s.id === cfg.skin" class="skin-cell-tag warn">正在使用 · 未下载</span>
              <span v-else class="skin-cell-tag">{{ skinPackLabel(s.id) }}</span>
              <span v-if="skinPackInstalled[s.id]" class="skin-cell-ops">
                <button class="skin-op danger" type="button"
                        :title="removeConfirmId === 'skin:' + s.id ? '再点一次确认删除（3 秒后自动取消）' : '从本地删除这张（可重新下载）'"
                        @click.stop="doRemoveSkin(s.id)">{{ removeConfirmId === 'skin:' + s.id ? '确认删' : '删' }}</button>
              </span>
            </div>
          </div>
        </div>
        <!-- 共享角色（上游 QQ 群 36 张）：与内置那批同一套交互。清单是异步拉的，
             未拉到时整组不渲染，免得出现「下载全部 0 张（约 0 KB）」的空壳 -->
        <p v-if="sharedSkinItems.length" class="skin-sub-title">共享角色 <em>（上游分享、不随插件包分发；{{ sharedSkinInstalledCount }} / {{ sharedSkinItems.length }} 已下载）</em></p>
        <div v-if="sharedSkinItems.length" class="skin-grid">
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
              <span v-if="!sharedSkinInstalled[s.id]" class="skin-cell-badge">下载</span>
              <span class="skin-cell-tag">{{ sharedSkinNames[s.id] || s.id }}</span>
              <span v-if="sharedSkinInstalled[s.id]" class="skin-cell-ops">
                <button class="skin-op danger" type="button"
                        :title="removeConfirmId === 'skin:' + s.id ? '再点一次确认删除（3 秒后自动取消）' : '从本地删除这张（可重新下载）'"
                        @click.stop="doRemoveSkin(s.id)">{{ removeConfirmId === 'skin:' + s.id ? '确认删' : '删' }}</button>
              </span>
            </div>
          </div>
        </div>
        <!-- 下载源：内置（ghfast.top → 直连）与共享（jsDelivr → ghfast → 直连 → raw）两条候选链
             共用同一个前缀配置（宿主那边各自回落内置），所以一个输入框管两处 -->
        <label class="field row">
          <span class="label">形象下载源 <em>（留空用内置加速源，失败自动直连 GitHub）</em></span>
          <input type="text" :maxlength="SKIN_PACK_PREFIX_MAX" spellcheck="false" autocomplete="off"
                 placeholder="https://ghfast.top/"
                 :value="cfg.skinPackSrc"
                 @change="emit('patch', { skinPackSrc: ($event.target as HTMLInputElement).value })" />
        </label>
        <p class="hint">
          下载回来的形象存本地、<strong>不占「导入」的 20 张配额</strong>（配额只算你自己导入的）。
          点缩略图只下这一张（下完自动切到它），已下载的悬停可「删」单张、删了能重新下载；
          卡头的「下载剩余 N 张」则把还没下来的整批补齐（已下载的自动跳过、不重复占体积）。
        </p>
        <p v-if="skinPackFlash.msg" class="msg" :class="msgCls(skinPackFlash)">{{ skinPackFlash.msg }}</p>
        <p v-if="sharedSkinFlash.msg" class="msg" :class="msgCls(sharedSkinFlash)">{{ sharedSkinFlash.msg }}</p>
        </div>
        </template>
      </template>
      <p v-else-if="!skinGallery.items.length" class="hint">
        暂无形象：点「导入图片…」加一张，支持 png / jpg / webp / gif / apng（动图不裁剪，保留动画）。
      </p>
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
              <button class="skin-op danger" type="button"
                      :title="removeConfirmId === 'bubble:' + it.id ? '再点一次确认删除（3 秒后自动取消）' : '删除这张'"
                      @click.stop="doRemoveBubble(it.id)">{{ removeConfirmId === 'bubble:' + it.id ? '确认删' : '删' }}</button>
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

    <!-- [资源] 音效：本机所有能响的音效统一在一张卡里管。两个来源（用户手导的六槽位 / 上游共享音效库 45 段）
         此前是两张彼此割裂的卡（「导入的音效」在「我的素材」、「共享音效」在「下载素材」），但同一件事
         （「这段音效挂着响不响」）被拆成两种相反的操作心智：槽位卡是「先选槽位、再从库挑段」，
         共享卡是「先选段、再勾它参加哪些槽位」——同一份 roles 数据两套入口，6 个 chip 还在 45 行里重复 45 次。
         合并后：上段「我的音效」= 六个槽位各一段手导 + 挂在本槽的共享段；下段「可下载音效」= 上游 45 段
         （点行展开 6 个槽位 chip，功能零损失，噪音只在展开的那一行里）。 -->
    <section v-if="cardOn('assets', 'assetsSounds')" class="card" data-search="assetsSounds">
      <div class="card-head">
        <!-- 整卡可折叠（默认收起）：六个槽位 + 45 段清单一次铺满整屏，只有真要导入 / 替换 / 下载时才需要。
             标题即开关；收起态在下方挂一行概览，不会「藏了就等于没有」。
             折叠态是本组件私有（galleryFolds），搜索命中时 galleryOpen 一律返回 true 强制展开 -->
        <button class="fold-title" type="button" @click="galleryFolds.sounds = !galleryFolds.sounds; soundPickOpen = ''">
          <span class="fold-caret">{{ galleryOpen('sounds') ? '▾' : '▸' }}</span>
          音效
        </button>
        <div class="head-actions">
          <button class="export-btn utils-btn utils-outline" type="button" @click="doImportSound('press')">导入音效…</button>
          <!-- 卡头唯一的整批下载入口（与形象卡头的「下载剩余 N 张」同构）：
               点它 = 把共享库里还没下来的段逐段串行补齐（已下载的自动跳过）。
               单段仍可点下方行里的「下载这一段」 -->
          <button v-if="sharedSoundRemainCount" class="export-btn utils-btn utils-outline" type="button"
                  :disabled="sharedSoundBusy"
                  :title="`把还没下载的 ${sharedSoundRemainCount} 段一起下回来（已下载的自动跳过）`"
                  @click="doDownloadAllSounds()">
            {{ sharedSoundBusy ? '正在下载…' : `下载剩余 ${sharedSoundRemainCount} 段（约 ${fmtBytes(sharedSoundRemainBytes)}）` }}
          </button>
        </div>
      </div>
      <p v-if="!galleryOpen('sounds')" class="hint">
        已导入 {{ soundImportedCount }} / {{ SOUND_ROLES.length }} 个槽位<template v-if="sharedSoundRemainCount"> · 另有 {{ sharedSoundRemainCount }} 段可下载（约 {{ fmtBytes(sharedSoundRemainBytes) }}）</template>。
      </p>
      <template v-if="galleryOpen('sounds')">
      <!-- 上段：我的音效。六槽位（按压 / 释放 + 四类提醒音），每槽位一段手导 + 若干挂在本槽的共享段。
           每个槽位最多一段手导：再导入就是替换掉旧的，所以没有「第 1 段 / 第 2 段」的编号。
           块有底色与描边 —— 六个槽位连同各自的明细不加框会连成一片，看不出归属 -->
      <p class="group-title skin-group-title">我的音效 <em>（六个槽位各一段，再导入 = 替换；可挂共享库的段一起随机播放）</em></p>
      <div class="sound-group" v-for="r in SOUND_ROLES" :key="r">
        <div class="sound-group-head">
          <span class="label" :title="ALERT_SOUND_WHEN[r]">{{ SOUND_ROLE_LABEL[r] }}</span>
          <!-- 概览只报有没有，不报名字：名字就在同一行的右侧（.sound-file），复述一遍纯属重复 -->
          <span class="asset-meta">
            <template v-if="soundMetaOf(r).length">已导入</template>
            <template v-else>{{ (ALERT_SOUND_ROLES as string[]).indexOf(r) >= 0 ? '未导入（静音）' : '未导入（可选）' }}</template>
          </span>
          <!-- 「从共享库添加」：把共享音效库已下载的段挂到本槽位（可先试听）。
               只在本槽位还有没挂上的段时才显示 —— 全挂上了就没必要再开这个面板。
               槽位是当前展开的这个块，所以面板里不再让用户选槽位（见 doAddPickSound） -->
          <button v-if="sharedSoundInstalledItems.length && sharedPinnedTo(r).length < sharedSoundInstalledItems.length"
                  class="export-btn utils-btn utils-outline" type="button"
                  @click="soundPickOpen = soundPickOpen === r ? '' : r">
            {{ soundPickOpen === r ? '收起' : '从共享库添加…' }}
          </button>
          <button class="export-btn utils-btn utils-outline" type="button" @click="doImportSound(r)">
            {{ soundMetaOf(r).length ? '替换' : '导入' }}
          </button>
        </div>
        <!-- 共享库挑选区：列出已下载的段，每行只有「添加」（把当前槽位加进这段的 roles）+「试听」。
             已挂在本槽位的段不在这里重复出现，改到下方「来自共享音效库」里管理 -->
        <div v-if="soundPickOpen === r" class="sound-pick">
          <template v-if="sharedSoundInstalledItems.length">
            <template v-if="sharedPickCandidates(r).length">
              <!-- 段多时的两道闸：关键词筛 + 限高滚动。候选只列「还没挂到本槽位」的段，
                   45 段全下载时这里是 44 行 —— 不限高会把整个槽位列表撑得极长 -->
              <div class="sound-pick-search field row">
                <span class="label">筛选</span>
                <input type="text" spellcheck="false" autocomplete="off"
                       placeholder="按音效名过滤…"
                       :value="soundPickQuery"
                       @input="soundPickQuery = ($event.target as HTMLInputElement).value" />
              </div>
              <div class="sound-pick-list">
                <div class="sound-pick-row" v-for="it in soundPickFiltered" :key="'sp-' + it.id">
                  <SoundRow :name="it.name" :size="fmtBytes(it.size)" />
                  <div class="sound-pick-ops">
                    <button class="export-btn utils-btn utils-primary" type="button"
                            :disabled="sharedSoundBusy" @click="doAddPickSound(it)">添加到{{ SOUND_ROLE_LABEL[r] }}</button>
                    <button class="export-btn utils-btn utils-outline" type="button"
                            :class="{ 'preview-on': previewingPickId === it.id }"
                            @click="doPreviewPickSound(it)">{{ previewingPickId === it.id ? '停止' : '试听' }}</button>
                  </div>
                </div>
                <p v-if="!soundPickFiltered.length" class="hint">没有名字匹配「{{ soundPickQuery }}」的段。</p>
              </div>
              <p class="hint">
                添加后这段会与「{{ soundNameOf(r) || '你导入的那段' }}」<strong>一起随机播放</strong>，
                不会顶掉它 —— 挂件每次触发时随机选一段。
              </p>
            </template>
            <p v-else class="hint">
              共享音效库已下载的段都挂到了本槽位，可以在下方「可下载音效」里下载更多、或调整它们参加哪些槽位。
            </p>
          </template>
          <p v-else class="hint">
            共享音效库还没有已下载的段 —— 在下方「可下载音效」里先下载几段，再回来添加。
          </p>
        </div>
        <!-- 单段时直接并进槽位头一行：既然只有一个，再单起一行纯属浪费纵向空间 -->
        <div class="sound-seg" v-for="(it, i) in soundMetaOf(r)" :key="it.file">
          <SoundRow :name="it.name">
            <span class="seg-ops">
              <button class="export-btn utils-btn utils-outline" type="button" @click="doPreviewSound(r, i)">试听</button>
              <button class="export-btn utils-btn"
                      :class="removeConfirmId === 'seg:' + r + ':' + it.file ? 'utils-danger' : 'utils-outline'"
                      type="button"
                      :title="removeConfirmId === 'seg:' + r + ':' + it.file ? '再点一次确认删除（3 秒后自动取消）' : '删除这段'"
                      @click="doRemoveSound(r, it.file)">{{ removeConfirmId === 'seg:' + r + ':' + it.file ? '确认删' : '删除' }}</button>
            </span>
            <!-- 体积与导入时间都是次要信息，合成一行放在最下面 -->
            <span class="seg-time" :title="assetAt(it)">{{ assetSize(it) }} · {{ assetAtShort(it) }}</span>
          </SoundRow>
        </div>
        <!-- 本槽位还挂着哪些共享库的段：与上面「自己导入的」并列展示，各自可单独试听 / 移出。
             用虚线框 + 「来自共享音效库」小标与本槽位导入的那段区分开 -->
        <div class="sound-seg sound-seg-shared" v-for="it in sharedPinnedTo(r)" :key="'pin-' + it.id">
          <SoundRow :name="it.name" :size="fmtBytes(it.size)">
            <span class="seg-ops">
              <button class="export-btn utils-btn utils-outline" type="button"
                      :class="{ 'preview-on': previewingPickId === it.id }"
                      @click="doPreviewPickSound(it)">{{ previewingPickId === it.id ? '停止' : '试听' }}</button>
              <button class="export-btn utils-btn utils-outline" type="button"
                      :disabled="sharedSoundBusy" @click="doUnpinPickSound(it, r)">移出</button>
            </span>
            <span class="seg-time">来自共享音效库</span>
          </SoundRow>
        </div>
      </div>
      <p v-if="cfg.soundSet === 'custom' && !soundsMeta.press.length && !sharedPinnedTo('press').length" class="hint">
        还没有导入按压音，「挂件外观 → 音色」的「自定义」当前会回退为「小黄鸭」。
      </p>
      <p v-if="soundUnused" class="hint">
        按压 / 释放音已导入但当前未使用：「音效开关」没开，或「音色」选的不是「自定义」。
      </p>

      <!-- 下段：可下载音效。与共享角色同一批上游素材（45 段），落 sounds 的 shared 槽位。
           每段自带一组 roles（参加哪些实播槽位的播放），下载后默认不挂任何槽位（不打扰），
           用户在行内展开的槽位 chip 上勾选要参加哪几个。
           标题即本段折叠开关（默认收起，见 dlFolds 注释）：45 段清单太长，收起态仍报
           「N / M 已下载」，日常配槽位用上段（我的音效），要补下载再点开 -->
      <template v-if="sharedSoundItems.length">
        <button class="group-title skin-group-title dl-title" type="button"
                :title="dlFolds.sounds ? '收起下载区' : '展开下载区，看共享音效库还有哪些段可下'"
                :aria-expanded="dlFolds.sounds"
                @click="dlFolds.sounds = !dlFolds.sounds">
          <span class="dl-caret">{{ dlFolds.sounds ? '▾' : '▸' }}</span>
          可下载音效 <em>（上游分享、不随插件包分发；{{ sharedSoundInstalledCount }} / {{ sharedSoundItems.length }} 已下载，点行展开可勾选参加哪些槽位）</em>
          <span class="dl-action">{{ dlFolds.sounds ? '收起' : '展开' }}</span>
        </button>
        <template v-if="dlFolds.sounds">
        <div class="dl-body">
        <DownloadBox v-if="dlProgress && dlProgress.pack === 'shared-sounds'"
                     :progress="dlProgress" :percent="dlPercent" :amount="dlAmountText" />
        <!-- 列表按「是否已下载」分两组：两组的控件不同（未下载行没有试听 / 槽位勾选 / 删），
             分组后同组内控件结构一致，列能对齐。未下载组默认收进 .fold 里，
             免得 45 行未下载项把「已下载」这半截推到屏外。 -->
        <div class="shs-list">
          <template v-if="sharedSoundInstalledItems.length">
            <p class="skin-sub-title">已下载 <em>（{{ sharedSoundInstalledItems.length }} 段，点行展开勾选槽位 / 可试听 / 可删）</em></p>
            <!-- 45 行铺开时找一段要滚很久；搜索 + 三档筛选把「已下载」这半截收窄。
                 筛选只作用于本组（未下载组是逐段补下载用的，筛它没意义） -->
            <div class="shs-filter">
              <input type="text" spellcheck="false" autocomplete="off"
                     placeholder="按音效名过滤…"
                     :value="sharedSoundQuery"
                     @input="sharedSoundQuery = ($event.target as HTMLInputElement).value" />
              <button class="role-chip utils-btn" type="button"
                      :class="sharedSoundFilter === 'all' ? 'utils-primary' : 'utils-outline'"
                      @click="sharedSoundFilter = 'all'">全部</button>
              <button class="role-chip utils-btn" type="button"
                      :class="sharedSoundFilter === 'pinned' ? 'utils-primary' : 'utils-outline'"
                      @click="sharedSoundFilter = 'pinned'">已参加播放</button>
              <button class="role-chip utils-btn" type="button"
                      :class="sharedSoundFilter === 'unpinned' ? 'utils-primary' : 'utils-outline'"
                      @click="sharedSoundFilter = 'unpinned'">一段都没挂</button>
            </div>
            <!-- 已下载段列表：限高内滚。45 段铺开会让整张卡长到几十屏 —— 卡高度收敛成固定值（约 6 行），
                 剩余内容交给内部滚动条。搜索 / 筛选行留在滚动区外，过滤时不用先滚回顶部 -->
            <div class="shs-scroll">
              <!-- 每行分两段：主线（文件名 + 体积 + 试听 / 删，同排右端对齐）+ 展开后的槽位 chip。
                   6 个 chip 此前常驻在 45 行里 = 270 个 chip 的视觉噪音；现在只在展开的那一行出现，
                   点行头「参加播放」即展开（与「我的音效」上段同源，功能零损失）。 -->
              <div class="shs-row" v-for="it in sharedSoundInstalledShown" :key="'shs-' + it.id">
                <div class="shs-main">
                  <button class="shs-row-toggle utils-btn" type="button"
                          :title="soundRowOpen === it.id ? '收起槽位勾选' : '点开勾选这段参加哪些槽位的播放'"
                          @click="soundRowOpen = soundRowOpen === it.id ? '' : it.id">
                    <span class="shs-row-caret">{{ soundRowOpen === it.id ? '▾' : '▸' }}</span>
                    <span class="shs-row-roles">参加 {{ it.roles.length }} 个槽位</span>
                  </button>
                  <SoundRow :name="it.name" :size="fmtBytes(it.size)">
                    <span class="seg-ops">
                      <button class="export-btn utils-btn utils-outline" type="button"
                              :class="{ 'preview-on': previewingSharedId === it.id }"
                              @click="doPreviewSharedSound(it)">{{ previewingSharedId === it.id ? '停止' : '试听' }}</button>
                      <button class="export-btn utils-btn" type="button"
                              :class="removeConfirmId === 'shared:' + it.id ? 'utils-danger' : 'utils-outline'"
                              :title="removeConfirmId === 'shared:' + it.id ? '再点一次确认删除（3 秒后自动取消）' : '从共享音效库删掉这一段；各槽位上挂的这段也一并失效'"
                              @click="doRemoveSharedSound(it)">{{ removeConfirmId === 'shared:' + it.id ? '确认删' : '删' }}</button>
                    </span>
                  </SoundRow>
                </div>
                <!-- 展开后的槽位勾选：每个槽位一个小 chip，点一下加入 / 再点移出（即 setSharedRoles）。
                     按压 / 释放是「音色」的两段（要配合音色=自定义才响）；另外四类是独立提醒音，
                     两组间用 .shs-roles-gap 拉开一点 -->
                <div v-if="soundRowOpen === it.id" class="shs-ops">
                  <template v-for="r in SOUND_ROLES" :key="r">
                    <span v-if="r === ALERT_SOUND_ROLES[0]" class="shs-roles-gap" />
                    <button class="role-chip utils-btn" type="button"
                            :class="it.roles.indexOf(r) >= 0 ? 'utils-primary' : 'utils-outline'"
                            :disabled="sharedSoundBusy"
                            :title="ALERT_SOUND_WHEN[r] || ''"
                            @click="toggleSharedRole(it, r, it.roles.indexOf(r) < 0)">{{ SOUND_ROLE_LABEL[r] }}</button>
                  </template>
                </div>
              </div>
            </div>
            <p v-if="!sharedSoundInstalledShown.length" class="hint">没有符合条件的已下载段。</p>
          </template>
          <p v-else class="hint">共享音效库暂时是空的 —— 卡头按钮若显示「下载剩余 N 段」，点它把音效拉回来。</p>

          <div class="fold" v-if="sharedSoundPendingItems.length">
            <button class="link-btn utils-btn utils-secondary" type="button"
                    @click="sharedSoundPendingOpen = !sharedSoundPendingOpen">
              未下载 {{ sharedSoundPendingItems.length }} 段<span class="fold-caret">{{ sharedSoundPendingOpen ? '▾' : '▸' }}</span>
            </button>
            <template v-if="sharedSoundPendingOpen">
              <div class="shs-row" v-for="it in sharedSoundPendingItems" :key="'shs-' + it.id">
                <div class="shs-main">
                  <SoundRow :name="it.name" :size="fmtBytes(it.size)" />
                </div>
                <div class="shs-ops">
                  <!-- 措辞带上「这一段」：卡头还有一个「下载剩余 N 段」（逐段串行下完），
                       两个按钮的量级差 40 倍，都写「下载」会让人以为点了就是整包 -->
                  <button class="export-btn utils-btn utils-primary" type="button"
                          :disabled="sharedSoundBusy" @click="doDownloadSharedSound(it)">下载这一段</button>
                </div>
              </div>
            </template>
          </div>
        </div>
        <!-- 下载源：与形象下载源共用同一个前缀配置（宿主那边各自回落内置），所以一个输入框管两处 -->
        <label class="field row">
          <span class="label">音效下载源 <em>（留空用内置加速源，失败自动直连 GitHub）</em></span>
          <input type="text" :maxlength="SKIN_PACK_PREFIX_MAX" spellcheck="false" autocomplete="off"
                 placeholder="https://ghfast.top/"
                 :value="cfg.skinPackSrc"
                 @change="emit('patch', { skinPackSrc: ($event.target as HTMLInputElement).value })" />
        </label>
        </div>
        </template>
      </template>
      <p v-else-if="!sharedSoundQuery" class="hint">共享音效清单未拉到时这里为空，展开本卡会自动重拉一次。</p>

      <!-- 使用说明默认折叠：原先四行小字常驻卡尾，把六个槽位压到下面去了。
           摘要只报「能干什么」，不重复上方每行状态（那些行里已经写着「已导入 / 未导入（静音）」） -->
      <div class="fold">
        <button class="link-btn utils-btn utils-secondary" type="button" @click="soundHelpOpen = !soundHelpOpen">
          {{ soundHelpOpen ? '收起音效使用说明' : '音效使用说明' }}
        </button>
        <div v-if="soundHelpOpen" class="guide">
          <p class="hint">每槽位一段手导，再导入 = 替换；想加更多，用槽位头的「从共享库添加…」挂共享段，一起随机播放。</p>
          <p class="hint">共享库的段来自上游 QQ 群分享、不随插件包分发，改为按需从 GitHub 直链下载；下载后默认不参加任何槽位（不打扰），点开行勾选想让它响的槽位即可。</p>
          <p class="hint">加入播放后它<strong>不会顶掉</strong>你手导的那段：挂件每次触发会在「手导的那段 + 挂到本槽位的共享段」里<strong>随机选一段</strong>。一段能同时挂多个槽位，一个槽位也能同时挂多段。</p>
          <p class="hint">提醒音留空 = 静音；播放跟随「挂件外观」的音效开关与音量。</p>
          <p class="hint">支持 mp3 / wav / ogg，导入时可拖选片段试听（最长 10 秒），存为单声道 WAV。</p>
        </div>
      </div>
      <p v-if="soundFlash.msg" class="msg" :class="msgCls(soundFlash)">{{ soundFlash.msg }}</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* 设计令牌来自 main.css 的 :root。通用控件样式（.card / .field / .label / .msg / .hint /
   .fold 等）已由 main.css 统一提供（全局唯一来源）。utils 档位配色与
   .link-btn 基类也已在 main.css，此处不再留副本。
   ★ 本组件此前漏了这一步（样式标签是空的 `<style scoped />`），而 App.vue 内联的规则
     带的是 App 的哈希、匹配不上本组件渲染的元素 —— 症状是整卡样式失效：画廊网格无尺寸、
     棋盘格底 / 悬停操作条 / 角标全丢，素材包与共享音效的进度条塌成空白。这里一次性补齐。 */
/* 分区小标题（「我的素材」/「下载素材」）：横线 + 小字，把卡分成「本机已有 / 上游待下载」两组。
   只在同组命中 2 张以上时渲染（见 showSection），搜索只命中单卡时不会突兀地出现一条分割线 */
.assets-section {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-dim);
}
.assets-section::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

/* 卡头：标题（左） + 操作按钮组（右）一行排开。
   ★ 这条此前漏了 —— 2969bf8 把通用控件样式收敛到 main.css 时，`.card-head` 只在
     UsageView / CodexView / App.vue 各留了一份 scoped 副本，AssetsView 这份被一并删掉
     而没进 main.css（孤儿 CSS 闸门只查「样式没人用」，查不出「元素没有样式」）。
     于是本组件各卡头 div 一直是块级，标题与右侧按钮**竖着堆**。
     现已上提到 main.css（本组件与 UsageView / App.vue 共用同一份），此处不再留副本。 */
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

/* 输入框 / 复选框的表单控件基类已上提 main.css（全局唯一来源），
   此处不再留副本。 */

/* 有失败项时可点，直接去插件市场更新 */
.msg.clickable {
  cursor: pointer;
  text-decoration: underline;
}
/* 折叠面板（「数据目录」「素材包导入导出」）与凭据获取教程同款观感 */
.field + .link-btn {
  margin-top: -4px;
}
/* .guide / .guide-use / .guide > .link-btn:first-child / .guide code / .guide a
   已上提 main.css（全局唯一来源），此处不再留副本。 */
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

/* 覆盖 .link-btn 的 margin-top / 下划线，避免在 flex 行里把行高撑开 */
.link-btn.inline {
  margin-top: 0;
  font-size: 12px;
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
/* 「形象」卡内的两段分区：「我的形象」（已落盘）与「可下载形象」（上游有、没下来）。
   合并三卡后这一张卡同时含三段网格（我的 + 随包内置 + 共享角色），
   给段标题加一条上面线与分组语义，用户扫一眼就知道每段是什么、彼此不连成一片。
   上段紧跟卡头，不留上边距 + 不画线（否则卡头下凭空多一道线） */
.skin-group-title {
  margin-top: 18px;
}
.skin-group-title:first-of-type {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
/* 「可下载形象 / 可下载音效」两段的标题现在可点（段级折叠，默认收起）。
   首版只做了「hover 变字色 + 一个同色小三角」，首用者根本看不出这行能点（反馈：看不清能不能展开）。
   三处加强可发现性，但仍让它读起来是**段标题**而不是一颗大按钮：
   1) 箭头做成描边胶囊（.dl-caret），用主题强调色 —— 明显是个控件，不是装饰字符；
   2) 行尾补一个动作词「展开 / 收起」（.dl-action），最直白、零学习成本；
   3) 整行 hover 铺一层淡底 + 描边，明确「这一整行都能点」，而不只是文字变色。
   展开态再给下面内容一条左侧淡竖线，视觉上归到本段名下（见 .dl-body）。 */
.dl-title {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin: 18px 0 6px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--fg-dim);
  text-align: left;
  cursor: pointer;
  transition: background .15s, border-color .15s, color .15s;
}
.dl-title:hover {
  color: var(--fg);
  background: var(--accent-weak);
  border-color: var(--line);
}
.dl-title:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* 描述性的 em（「…已下载」）会很长，让它占满剩余宽度，把动作词挤到行尾 */
.dl-title > em {
  flex: 1;
  min-width: 0;
}
/* 箭头胶囊：静态时就带描边与强调色，不靠 hover 才显形 */
.dl-caret {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 11px;
  line-height: 1;
}
/* 行尾动作词：hover 时与标题同色，平时比 em 稍显眼一点，起「这里是开关」的提示作用 */
.dl-action {
  flex: none;
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--accent);
  font-size: 11px;
  white-space: nowrap;
}
.dl-title:hover .dl-action {
  border-color: var(--accent);
}
/* 展开后的段内容：左侧一条淡竖线与标题对齐，读起来是「这一段的内容」 */
.dl-body {
  margin-left: 9px;
  padding-left: 11px;
  border-left: 2px solid var(--line);
}
/* 下段里的两个子分组（随包内置 / 共享角色）比段标题再低一级：
   不画上边框（同属「可下载形象」这一段的内部细分），只用更小的字号与更浅的颜色区分 */
.skin-sub-title {
  margin: 12px 0 6px;
  font-size: 12px;
  color: var(--fg-dim);
}
.skin-sub-title em {
  font-style: normal;
  font-size: 11px;
  color: var(--fg-faint);
}

/* ===== 「导入的音效」：六个槽位各成一个块 =====
   块 = 槽位头（角色名 + 概况 + 导入/替换按钮）+ 该槽位那一段（最多一段）的明细。
   没有底色 / 描边 / 块间距时，六个槽位连同各自的明细会在视觉上连成一片，看不出归属。
   文件名（.sound-file）与体积（.asset-meta）这两格属于「音效行」骨架，随 SoundRow 组件走 */
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
   一个槽位只留一段，这里只是给「这音是什么时候导进来的」留个时间戳 */
.seg-time {
  flex: 1 1 100%;
  font-size: 11px;
  color: var(--fg-faint);
  white-space: nowrap;
}
/* 槽位下的「从共享库选用」面板：缩进一格 + 左侧色条，视觉上从属于上面那个槽位。
   六个槽位同时展开会很长，所以同一时刻只允许开一个（见 soundPickOpen）。 */
.sound-pick {
  margin-top: 8px;
  padding: 6px 0 2px 10px;
  border-left: 2px solid var(--track);
}
.sound-pick-row {
  padding: 5px 0;
}
/* 候选区限高内滚：45 段全下载时一个槽位有 44 行候选，铺开会把整张卡撑到几屏长。
   内部滚动让面板高度可预期（滚动条本身也提示「这里还有更多」）。
   max-height 用 vh 而非固定 px：窄卡片与宽窗口下都取「大约一屏的六成」 */
.sound-pick-list {
  max-height: 260px;
  overflow-y: auto;
  /* 只给纵向留缝：横向滚动条会把行末的按钮推到需要左右拖才能点到 */
  padding-right: 2px;
}
/* 筛选行：与下面列表拉开、不要贴太紧（列表缩进是从 .sound-pick 的 border-left 来的） */
.sound-pick-search {
  margin: 4px 0 2px;
}
.sound-pick-search .label {
  flex: 0 0 auto;
  min-width: 34px;
}
.sound-pick-row + .sound-pick-row {
  border-top: 1px solid var(--track);
}
/* 动作行：与「共享音效」卡的 .shs-ops 同款（换行 + 基准宽度下拉），只是嵌套选择器不同。
   下拉不再铺满 —— 铺满后「使用 / 试听」被推到行尾、离开文件名的视线范围，
   窄卡片里也让两行控件各换各的行 */
.sound-pick-ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
/* 正在试听的那一段：按钮切成「停止」并给强调色描边，与「共享音效」卡同一套视觉 */
.sound-pick-ops .preview-on {
  color: var(--accent);
  border-color: var(--accent);
}
/* 选择区在槽位内部，可用宽度比「共享音效」卡窄，窄到放不下时让体积换到第二行，
   不然文件名会被压成省略号。
   SoundRow 是子组件（scoped 哈希不同），用 :deep 才够得着它内部的 .sound-file */
.sound-pick-row :deep(.sound-file) {
  flex-wrap: wrap;
}
/* ===== 共享音效库的分组列表 =====
   「已下载」与「未下载」分开渲染（见模板注释：两类行控件数差 3 个，混排必然列对不齐）。
   每行是上下两段：.shs-main 主线（文件名 + 体积，文件名独占剩余宽度）、
   .shs-ops 副线（动作控件，与文件名左对齐，窄卡片里可换行）。 */
.shs-list {
  margin-top: 4px;
}
/* 「已下载」组的搜索 + 筛选行：输入框吃掉剩余宽度，三档 chip 保持紧凑不换行时也能全露 */
.shs-filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.shs-filter input[type='text'] {
  /* 与 .label 的 72px 起始宽度呼应，让输入框与上面的「参加播放：」列起点对齐 */
  flex: 1 1 140px;
  min-width: 0;
}
/* 已下载段的滚动容器：限高内滚，把卡的高度钉在「约 6 行 + 表头」。
   45 段时不再让整张卡往下长几十屏 —— 页面总长可预期，滚出这半截也不会把
   搜索 / 筛选行一起滚走（它们在滚动区外）。
   用 vh 取值：窗口拉高时多露几行，窄窗口也不会矮到看不见列表 */
.shs-scroll {
  max-height: 42vh;
  overflow-y: auto;
  /* 只留纵向：横向滚动条会让行末的「删」需要左右拖才点得到 */
  padding-right: 2px;
}
/* 滚动区内的行首尾边距单独收一下：外层 .shs-list 的 margin-top 已提供顶部留白 */
.shs-scroll .shs-row:first-of-type {
  padding-top: 0;
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
/* 行内动作组（试听 / 删）跟在体积后面、右端对齐。
   不设 flex:1 —— 让文件名吃掉剩余宽度，动作组被挤到最右 */
.seg-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  /* 与上面的文件名基线错开一点，避免按钮比文字高出半行显得歪 */
  align-self: center;
}
.shs-ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  /* 与上行文件名错开一格：chip 是这一行「展开出来的」子级，缩进让人一眼看出从属 */
  margin-top: 6px;
  padding-left: 16px;
}
/* 行头「参加 N 个槽位」开关：点它展开 / 收起这一行的槽位 chip。
   常态只是一个很淡的小标记，不抢文件名；展开后箭头朝下、文字转强调色 */
.shs-row-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  padding: 1px 4px;
  border: none;
  background: transparent;
  font-size: 11px;
  color: var(--fg-faint);
  cursor: pointer;
}
.shs-row-toggle:hover {
  color: var(--accent);
}
.shs-row-caret {
  font-size: 10px;
  line-height: 1;
}
.shs-row-roles {
  white-space: nowrap;
}
/* 槽位 chip：一段共享音效「参加哪些槽位的播放」。点亮 = utils-primary（已参加），
   熄灭 = utils-outline（未参加）。比旧的下拉更直观 —— 一眼看出这段参与了哪几个槽位，
   且能同时选多个（下拉是单选 + 再点一次「选用」另存一份，语义完全不同）。 */
.shs-roles-gap {
  /* 分组分隔：按压 / 释放（音色）与四类提醒音之间拉开一点 */
  flex: 0 0 0;
  margin-left: 4px;
}
.role-chip {
  /* 比普通按钮紧凑：一行 6 个 chip 加一个分组缝刚好铺满，别把行撑爆 */
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.4;
}
/* 正在试听的那一段：按钮切成「停止」并给强调色描边，让用户在 45 行里一眼找到在放哪条 */
.shs-ops .preview-on {
  color: var(--accent);
  border-color: var(--accent);
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
/* 随机态标记：**一枚圆点，靠颜色区分**（2026-10-08 反馈：不要文字）。
   此前「不参与随机」是通栏文字角标，盖住缩略图底部、还和左下角序号抢位置（见上方
   .skin-cell:has(...) 那条让位规则），读起来也慢。现在两种态共用同一枚点：
   同尺寸、同位置（右上角 —— 右下角是「使用中」、左上角是「下载」、左下角是序号，只剩这里不打架），
   只有颜色不同。绿点沿用「外观」页图例那枚的形态与配色，两页视觉终于对得上。
   小圆点 + 一点白色描边：缩略图明暗不定时也能看清；pointer-events:none 不吃
   缩略图上的单击选中 / 双击使用。 */
.skin-cell-pool-dot {
  position: absolute;
  right: 3px;
  top: 3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.65);
  pointer-events: none;
}
.skin-cell-pool-dot.is-on {
  background: var(--ok);
}
/* 用中性灰而非红色 —— 这不是错误态，只是用户主动排除的一张，标红会让人以为这张图有问题 */
.skin-cell-pool-dot.is-off {
  background: rgba(120, 126, 138, 0.9);
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