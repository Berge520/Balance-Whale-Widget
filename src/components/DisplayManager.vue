<template>
  <Teleport to="body">
    <div v-if="visible" class="display-manager-overlay" @click.self="$emit('close')">
      <div class="display-manager-modal" role="dialog" aria-label="管理显示内容">
        <header class="modal-header">
          <div class="header-main">
            <h2>管理显示内容</h2>
            <p class="header-sub">
              共 {{ totalCards }} 张卡片，已隐藏 <b>{{ hiddenCount }}</b> 张
              <template v-if="hiddenTabCount">（{{ hiddenTabCount }} 个分组被整体隐藏）</template>
              <template v-if="pinnedCount">
                ，已置顶 <b>{{ pinnedCount }}</b> 张<template v-if="pinnedHiddenCount">（其中 {{ pinnedHiddenCount }} 张当前不可见）</template>
              </template>
            </p>
          </div>
          <button @click="$emit('close')" class="close-btn" title="关闭（Esc）">×</button>
        </header>

        <!-- 搜索：卡片多（25 张）时靠肉眼找太累，输入即过滤分组与卡片 -->
        <div class="search-row">
          <input
            ref="searchEl"
            v-model="keyword"
            class="search-input"
            type="search"
            placeholder="搜索分组或卡片（如：模型 / dsh / 备份）"
          />
          <button v-if="keyword" type="button" class="mini-btn" @click="keyword = ''">清除</button>
        </div>

        <!-- 折叠记忆总开关：默认开启（记住每张卡上次是展开还是收起），关掉则每次都按「默认展开/收起」来。
             放在搜索行下面而不是塞进页脚：它管的是下面每一行的折叠行为，离列表越近越容易理解 -->
        <div class="fold-remember">
          <label class="fold-remember-check">
            <input
              type="checkbox"
              :checked="foldRemember"
              @change="onRememberToggle(($event.target as HTMLInputElement).checked)"
            />
            <span>记住每张卡上次的展开状态</span>
          </label>
          <span class="fold-remember-hint">
            {{ foldRemember ? '关闭设置页再打开，卡片保持你上次的样子' : '关闭后每次打开都按下面的「默认展开 / 默认收起」来' }}
          </span>
        </div>

        <div class="modal-body">
          <div v-for="tab in shownTabs" :key="tab.key" class="tab-section">
            <div class="tab-header" :class="{ 'is-off': tabOff(tab.key) }">
              <label class="tab-check">
                <input
                  type="checkbox"
                  :checked="!tabOff(tab.key)"
                  :disabled="tabLocked(tab)"
                  @change="onTabToggle(tab.key, ($event.target as HTMLInputElement).checked)"
                />
                <span class="tab-label">{{ tab.label }}</span>
              </label>
              <span v-if="tabLocked(tab)" class="tab-hint">
                {{ tabHasCoreCard(tab.key) ? '含核心卡片，不可隐藏' : '需先配置 dsh' }}
              </span>
              <span v-else-if="tabOff(tab.key)" class="tab-hint">整组已隐藏</span>
              <!-- 组内有卡被单独藏掉时报出来：不写的话，用户只看到顶部总数多了一张，
                   却不知道该在哪个组里找回来（卡片多、分组折叠感强，靠肉眼比对很难） -->
              <span v-else-if="hiddenInTab(tab.key)" class="tab-hint warn">
                {{ hiddenInTab(tab.key) }} 张已隐藏
              </span>
              <!-- Tab 排序：只对可见分组有意义，隐藏的组也允许调（顺序是全量保存的） -->
              <span class="tab-ops">
                <button
                  type="button"
                  class="mini-btn"
                  :disabled="isFirstVisible(tab.key)"
                  :title="isFirstVisible(tab.key) ? '已经是第一个' : '上移'"
                  @click="$emit('update', { type: 'tabMove', key: tab.key, delta: -1 })"
                >↑</button>
                <button
                  type="button"
                  class="mini-btn"
                  :disabled="isLastVisible(tab.key)"
                  :title="isLastVisible(tab.key) ? '已经是最后一个' : '下移'"
                  @click="$emit('update', { type: 'tabMove', key: tab.key, delta: 1 })"
                >↓</button>
                <button
                  v-if="canShowAllInTab(tab)"
                  type="button"
                  class="mini-btn link"
                  title="把这组里被单独隐藏的卡片全部放出来"
                  @click="showAllInTab(tab)"
                >全显示</button>
              </span>
            </div>

            <div v-if="cardsOf(tab.key).length" class="card-list" :class="{ disabled: tabOff(tab.key) }">
              <div
                v-for="card in cardsOf(tab.key)"
                :key="card.key"
                class="card-item"
                :class="{
                  'is-off': cardSelfHidden(card.key),
                  'is-drag-over': dragOverKey === card.key && dragKey !== card.key,
                }"
                @dragover="onDragOver($event, tab.key, card.key)"
                @dragleave="onDragLeave($event, card.key)"
                @drop="onDrop($event, tab.key, card.key)"
              >
                <!-- 拖拽手柄：只有手柄能拖（整行可拖会跟勾选框 / 文字选择打架）。
                     搜索态与合并卡（计时跟着专注走）不给拖，见 canDrag -->
                <span
                  class="drag-handle"
                  :class="{ disabled: !canDrag(card.key) }"
                  :draggable="canDrag(card.key)"
                  :title="dragTitle(card.key)"
                  @dragstart="onDragStart($event, tab.key, card.key)"
                  @dragend="onDragEnd"
                >⋮⋮</span>
                <label :class="{ 'is-core': isCoreCard(card.key), disabled: tabOff(tab.key), 'is-off': cardSelfHidden(card.key) }">
                  <input
                    type="checkbox"
                    :checked="!cardHiddenBy(card.key)"
                    :disabled="isCoreCard(card.key) || tabOff(tab.key)"
                    @change="onCardToggle(card.key, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="card-label">{{ card.label }}</span>
                  <span v-if="isCoreCard(card.key)" class="core-badge">核心，不可隐藏</span>
                  <span v-else-if="cardSelfHidden(card.key)" class="hidden-badge">已隐藏</span>
                </label>
                <!-- 置顶：卡片在本组里的位置提前（只改本组内部顺序，不会跨组）。
                     放在 label 外面：label 是整行可点的复选框，把按钮塞进去点一下会顺带反选 -->
                <span class="card-ops">
                  <!-- 被藏掉的卡给一个显式的「显示」按钮：比让用户去「把勾选框重新勾上」直观得多，
                       而且勾选框本身在整行可点的 label 里，容易误点 -->
                  <button
                    v-if="cardSelfHidden(card.key)"
                    type="button"
                    class="mini-btn"
                    title="把这张卡放出来"
                    @click="$emit('update', { type: 'card', key: card.key, hidden: false })"
                  >显示</button>
                  <!-- 默认展开态：只在「记住上次状态」关掉时才有肉眼可见的效果，
                       所以开关关着时把按钮降成弱化样式（不是禁用 —— 用户可以先设好默认值再关记忆） -->
                  <button
                    v-if="hasFoldDefault(card.key)"
                    type="button"
                    class="mini-btn fold-default-btn"
                    :class="{ 'is-on': !foldDefaultOpen(card.key), muted: !foldRemember }"
                    :title="foldDefaultOpen(card.key)
                      ? '默认展开：点一下改为默认收起'
                      : '默认收起：点一下改为默认展开'"
                    @click="onFoldDefaultToggle(card.key)"
                  >{{ foldDefaultOpen(card.key) ? '默认展开' : '默认收起' }}</button>
                  <button
                    type="button"
                    class="mini-btn link pin-btn"
                    :class="{ 'is-on': isPinnedCard(card.key) }"
                    :title="isPinnedCard(card.key)
                      ? '取消置顶，回到原来的位置'
                      : '置顶到本组最前（多张置顶时按点击先后排）'"
                    @click="$emit('update', { type: 'pin', key: card.key, pinned: !isPinnedCard(card.key) })"
                  >{{ isPinnedCard(card.key) ? '📌 已置顶' : '置顶' }}</button>
                  <!-- 隐藏的置顶卡不标名次：它不在 App 的置顶区里，标了只会和实际顺序对不上 -->
                  <span v-if="isPinnedCard(card.key) && pinRank(card.key) > 0" class="pin-rank">第 {{ pinRank(card.key) }} 位</span>
                </span>

                <p v-if="!isCoreCard(card.key) && cardSelfHidden(card.key) && getCardWarning(card.key)" class="card-warning">
                  ⚠ {{ getCardWarning(card.key) }}
                </p>
              </div>
            </div>
            <p v-else class="tab-empty">（该分组没有匹配的卡片）</p>
          </div>

          <p v-if="!shownTabs.length" class="tab-empty big">
            没有匹配「{{ keyword.trim() }}」的分组或卡片。
            <!-- 搜不到时最常见的动作就是「把搜索清掉重来」，直接给按钮，不用再回去点输入框 -->
            <button type="button" class="mini-btn" @click="keyword = ''">清空搜索</button>
          </p>
        </div>

        <footer class="modal-footer">
          <p v-if="flashMsg" class="modal-msg" :class="{ err: flashErr }">{{ flashMsg }}</p>
          <!-- 左侧「把藏起来的放出来」组：勾掉的项越多越可能来这儿点，放左边顺手；
               右侧只留「关闭」。两组之间用 margin-left:auto 顶开，窄窗口换行也不会挤成一坨 -->
          <span class="foot-group">
            <button type="button" class="foot-btn" :disabled="!hiddenCount" @click="$emit('update', { type: 'showAll' })">
              全部显示
            </button>
            <!-- 恢复默认 = 隐藏全放出来 + 分组 / 卡片顺序复位 + 折叠默认值复位，比「全部显示」更彻底，
                 故走页面内二次确认（不用原生 confirm：uTools 窗口里它会阻塞渲染且样式不可控） -->
            <button v-if="!confirmReset" type="button" class="foot-btn" @click="confirmReset = true">恢复默认</button>
            <template v-else>
              <span class="confirm-tip">恢复默认会显示全部内容、清空置顶、还原分组与卡片顺序及折叠默认值，确定？</span>
              <button type="button" class="foot-btn danger" @click="doReset">确定恢复</button>
              <button type="button" class="foot-btn" @click="confirmReset = false">取消</button>
            </template>
          </span>
          <button type="button" class="foot-btn primary" @click="$emit('close')">关闭</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  CORE_CARDS, CARD_DEPENDENCIES, CARD_FOLDS, FOLD_DEFAULTS, MERGED_CARD_ROOT,
  cardRootKey, isCardHidden, pinnedInTab, sortByOrder, sortCardsByOrder,
} from '../constants/display'
import type { TabKey } from '../constants/display'

type TabItem = { key: string; label: string; desc: string; devOnly?: boolean }
type DisplayAction = {
  type: 'tab' | 'card' | 'cards' | 'reset' | 'showAll' | 'tabMove' | 'pin' | 'cardOrder' | 'pinOrder' | 'foldDefault' | 'foldRemember'
  key?: string
  hidden?: boolean
  delta?: number
  // type='pin' 时：true = 置顶，false = 取消置顶
  pinned?: boolean
  // type='foldDefault' / 'foldRemember' 时：true = 默认展开 / 开启记忆
  open?: boolean
  // type='cards' 时整份隐藏清单；type='cardOrder' / 'pinOrder' 时整份卡片顺序
  list?: string[]
}

const props = defineProps<{
  // 外层已用 v-if 控制挂载，保留 visible 是为了组件自身也能独立使用（不依赖父级 v-if）
  visible: boolean
  cfg: {
    hiddenTabs?: string[]
    hiddenCards?: string[]
    tabOrder?: string[]
    pinnedCards?: string[]
    // 卡片自定义顺序：{ TabKey: [cardKey, ...] }（只含非置顶卡）
    cardOrder?: Record<string, string[]>
    // 每张卡的默认展开态（key = 折叠键，见 CARD_FOLDS）
    foldDefaults?: Record<string, boolean>
    // 是否记住每张卡上次的展开态（false = 每次按默认值来）
    foldRemember?: boolean
    dshNodeDir?: string
  }
  // 常量由父级传入（单一来源 src/constants/display.ts），组件内不另抄副本
  tabs: readonly TabItem[]
  searchIndex: Record<string, { label: string; tab: string; keys: string }>
  // 保存失败的回执（父级 patchCfg 写盘失败时传入）
  flashMsg?: string
  flashErr?: boolean
}>()

const emit = defineEmits<{
  close: []
  update: [action: DisplayAction]
}>()

const keyword = ref('')
const searchEl = ref<HTMLInputElement | null>(null)
// 恢复默认的页面内二次确认（不用原生 confirm）
const confirmReset = ref(false)
const kw = computed(() => keyword.value.trim().toLowerCase())

// 分组顺序与主界面一致（父级按同一份 tabOrder 排），否则弹窗里的 ↑↓ 看起来会「跳」。
// 排序口径与 App.vue#visibleTabs 共用 sortByOrder（隐藏的分组也保留位置）
const orderedTabs = computed(() => sortByOrder(props.tabs, props.cfg.tabOrder, (t) => t.key))

// 置顶次序表：按分组把「当前可见的置顶卡」排成 1..N（与 App.vue#syncPinned 共用 pinnedInTab）。
// 卡片列表也按它把置顶卡提到组首 —— 否则徽章写「第 2 位」、卡片却排在列表中间，看着自相矛盾
const pinRankMap = computed(() => {
  const map = new Map<string, number>()
  for (const tab of props.tabs) {
    const list = pinnedInTab(props.cfg.pinnedCards, tab.key as TabKey, props.cfg.hiddenTabs, props.cfg.hiddenCards)
    for (let i = 0; i < list.length; i++) map.set(list[i], i + 1)
  }
  return map
})

// 置顶卡按名次提前，其余保持模板顺序（稳定排序：同名次的相对顺序不变）
function sortPinnedFirst<T extends { key: string }>(list: T[]): T[] {
  const rank = pinRankMap.value
  return list.slice().sort((a, b) => {
    // 名次表按卡根归一：合并卡的次要行（timer）也要跟主卡（focus）一起提到组首
    const ra = rank.get(cardRootKey(a.key)) || 0
    const rb = rank.get(cardRootKey(b.key)) || 0
    if (ra && rb) return ra - rb
    if (ra) return -1
    if (rb) return 1
    return 0
  })
}

function tabHit(tab: TabItem): boolean {
  if (!kw.value) return true
  // 命中判定全部收在 cardsOf：分组名命中 → 整组列出；否则只列卡片名 / 同义词命中的。
  // 这里不能再无视过滤（ignoreFilter）——那样每个非空分组都算命中，搜索等于没生效。
  return cardsOf(tab.key).length > 0
}

const shownTabs = computed(() => orderedTabs.value.filter(tabHit))

// 卡片命中：卡片名 + 手工同义词（SEARCH_INDEX.keys，和主界面搜索同一份数据）。
// 只认 label 的话，「番茄」「倒计时」这类叫法搜不到计时卡。
function cardsOf(tabKey: string) {
  const list = Object.entries(props.searchIndex)
    .filter(([, v]) => v.tab === tabKey)
    .map(([key, v]) => ({ key, label: v.label, keys: v.keys || '' }))
  // 先按用户自定义顺序排（与主界面同一份 cfg.cardOrder、同一套合并卡归一规则），
  // 再把置顶卡提到组首 —— 否则弹窗里的行序和主界面卡片顺序对不上，拖动完看着像没生效
  const ordered = sortCardsByOrder(list, props.cfg.cardOrder?.[tabKey])
  if (!kw.value) return sortPinnedFirst(ordered)
  const tab = props.tabs.find((t) => t.key === tabKey)
  // 分组名命中时整组都列出（用户搜的是分组），否则只列卡片名 / 同义词命中的。
  // 只比 label、不比 desc：desc 是一串卡片名（如「用量与账本 · 提醒与通知 · 模型与余额…」），
  // 拿它判分组会让「搜某张卡名」也命中整组，过滤形同虚设
  if (tab && tab.label.toLowerCase().includes(kw.value)) return sortPinnedFirst(ordered)
  return sortPinnedFirst(ordered.filter((c) => `${c.label} ${c.keys}`.toLowerCase().includes(kw.value)))
}

function isCoreCard(key: string): boolean {
  return CORE_CARDS.includes(key)
}

// 卡片当前是否不可见（自身被藏 或 所属分组被藏），判定收在 display.ts
function cardHiddenBy(key: string): boolean {
  return isCardHidden(props.cfg.hiddenTabs, props.cfg.hiddenCards, key)
}
// 仅「卡片自己」被藏（分组是显示的）—— 这种才需要给「撤销」按钮与警告文案
function cardSelfHidden(key: string): boolean {
  if (isCoreCard(key)) return false
  return !!props.cfg.hiddenCards?.includes(key) && !tabOff(props.searchIndex[key]?.tab || '')
}

function tabOff(tabKey: string): boolean {
  return !!props.cfg.hiddenTabs?.includes(tabKey)
}

// Tab 里是否含有核心卡片：有则整个 Tab 不可隐藏（否则核心卡片会被连带藏掉）
function tabHasCoreCard(tabKey: string): boolean {
  return Object.keys(props.searchIndex).some((k) => CORE_CARDS.includes(k) && props.searchIndex[k].tab === tabKey)
}

function tabLocked(tab: TabItem): boolean {
  if (tabHasCoreCard(tab.key)) return true
  return !!tab.devOnly && !props.cfg.dshNodeDir
}

function getCardWarning(key: string): string {
  return CARD_DEPENDENCIES[key]?.warning || ''
}

// —— 置顶 ——
// 置顶不限核心卡：核心卡只是「不可隐藏」，把凭据卡顶上最前反而更顺手
function isPinnedCard(key: string): boolean {
  // 按卡根判：合并卡在配置里可能存的是 focus 也可能历史存成 timer，勾选态必须一致
  return isPinnedRoot(cardRootKey(key))
}
// 该卡在**本组**置顶里的次序（1 起算）：多张置顶时按点击先后排，标出来用户才知道排第几。
// 与 App.vue#syncPinned 共用 pinnedInTab（次序表见上方 pinRankMap）：隐藏的置顶卡不参与排名
// （否则弹窗说「第 2 位」，实际排在第一位）。返回 0 = 当前不参与排名（自己被藏 / 整组被藏）。
function pinRank(key: string): number {
  return pinRankMap.value.get(cardRootKey(key)) || 0
}

// —— 计数 ——
const totalCards = computed(() => Object.keys(props.searchIndex).length)
const hiddenTabCount = computed(() => (props.cfg.hiddenTabs || []).length)
const hiddenCount = computed(() =>
  Object.keys(props.searchIndex).filter((k) => cardHiddenBy(k)).length,
)
// 置顶只统计索引里还存在的卡片（卸载掉的旧卡 id 留在配置里也不该出现在计数里）。
// 按卡根去重：合并卡的 focus / timer 是同一张卡，历史配置里存了两个也只算一张
const pinnedKeys = computed(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of props.cfg.pinnedCards || []) {
    if (!props.searchIndex[k]) continue
    const root = cardRootKey(k)
    if (seen.has(root)) continue
    seen.add(root)
    out.push(root)
  }
  return out
})
const pinnedCount = computed(() => pinnedKeys.value.length)
// 置顶但当前看不见（自己被藏 / 所在分组被藏）：要明说，否则用户会以为置顶失效了
const pinnedHiddenCount = computed(() =>
  pinnedKeys.value.filter((root) => Object.keys(props.searchIndex).some((x) => cardRootKey(x) === root && cardHiddenBy(x))).length,
)

// —— 排序按钮可用性：按「可见分组」判定首尾（隐藏组看不到，不能因为它挡着而让 ↑ 变灰） ——
const visibleTabKeys = computed(() => orderedTabs.value.filter((t) => !tabOff(t.key)).map((t) => t.key))
function isFirstVisible(key: string): boolean {
  return visibleTabKeys.value[0] === key
}
function isLastVisible(key: string): boolean {
  return visibleTabKeys.value[visibleTabKeys.value.length - 1] === key
}

// 本组有多少张卡被**单独**藏掉（不含整组隐藏：整组隐藏已由「整组已隐藏」提示，再报数会重复）
function hiddenInTab(tabKey: string): number {
  if (tabOff(tabKey)) return 0
  return Object.keys(props.searchIndex).filter(
    (k) => props.searchIndex[k].tab === tabKey && !isCoreCard(k) && props.cfg.hiddenCards?.includes(k),
  ).length
}

// 本组是否存在「被单独隐藏」的卡片（有才显示「全显示」按钮）
function canShowAllInTab(tab: TabItem): boolean {
  return hiddenInTab(tab.key) > 0
}
// 一次放出整组：直接算出「去掉本组后的完整隐藏清单」整份上抛（父级用 setHiddenCards 落地）。
// 不逐张 emit —— 逐个 emit 会各写一次盘，且中间态会让界面闪一下
function showAllInTab(tab: TabItem) {
  const rest = (props.cfg.hiddenCards || []).filter((k) => props.searchIndex[k]?.tab !== tab.key)
  emit('update', { type: 'cards', list: rest })
}

function onTabToggle(tabKey: string, checked: boolean) {
  emit('update', { type: 'tab', key: tabKey, hidden: !checked })
}

function onCardToggle(cardKey: string, checked: boolean) {
  emit('update', { type: 'card', key: cardKey, hidden: !checked })
}

// —— 拖拽调序 ——
// 只改顺序、不搬 DOM（主界面的排序同样只写 CSS order）：搬 DOM 会让 v-if / 事件绑定失效
const dragKey = ref('')
const dragTab = ref('')
const dragOverKey = ref('')

// 搜索态不给拖：只显示命中项时，「插到谁前面」的结果在完整列表里并不直观
// 合并卡的次要行（timer）也不给拖：它和主卡（focus）是同一个卡根，拖它等于拖主卡，容易误解
function canDrag(key: string): boolean {
  return !kw.value && !MERGED_CARD_ROOT[key]
}
function dragTitle(key: string): string {
  if (kw.value) return '搜索状态下不能调序，清空搜索后再拖'
  if (MERGED_CARD_ROOT[key]) return '这张卡跟着它的主卡走，请拖上面那张'
  return '按住拖动，调整这张卡在本组内的顺序'
}
function onDragStart(e: DragEvent, tabKey: string, key: string) {
  if (!canDrag(key)) { e.preventDefault(); return }
  dragKey.value = key
  dragTab.value = tabKey
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox 不 setData 就不认这次拖拽
    e.dataTransfer.setData('text/plain', key)
  }
}
// 是否置顶：按卡根判断。合并卡可能存的是 focus 也可能是 timer（老配置），两者是同一张卡
function isPinnedRoot(root: string): boolean {
  return (props.cfg.pinnedCards || []).some((k) => cardRootKey(k) === root)
}
function onDragOver(e: DragEvent, tabKey: string, key: string) {
  if (!dragKey.value || dragTab.value !== tabKey) return
  // 落点按卡根算：合并卡的次要行（计时）与主卡是同一张卡，拖到它身上等于拖到主卡
  const to = cardRootKey(key)
  if (dragKey.value === to) return
  // 置顶区与普通区不互通：跨区拖既不置顶也不改顺序，干脆不给落点高亮
  if (isPinnedRoot(dragKey.value) !== isPinnedRoot(to)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverKey.value = to
}
function onDragLeave(_e: DragEvent, key: string) {
  if (dragOverKey.value === cardRootKey(key)) dragOverKey.value = ''
}
function onDragEnd() {
  dragKey.value = ''
  dragTab.value = ''
  dragOverKey.value = ''
}
function onDrop(e: DragEvent, tabKey: string, key: string) {
  e.preventDefault()
  const from = dragKey.value
  const fromTab = dragTab.value
  onDragEnd()
  if (!from || fromTab !== tabKey) return
  const to = cardRootKey(key)
  if (from === to) return
  const fromPinned = isPinnedRoot(from)
  if (fromPinned !== isPinnedRoot(to)) return
  // 合并卡的两个子行只算一张卡：按卡根去重后取显示顺序，否则插到「计时」那一行
  // 会在 cardOrder 里留下 timer，主界面再按卡根归一，落点和预期错一格
  const keys: string[] = []
  for (const c of cardsOf(tabKey)) {
    const root = cardRootKey(c.key)
    if (!keys.includes(root)) keys.push(root)
  }
  const i = keys.indexOf(from)
  const j = keys.indexOf(to)
  if (i < 0 || j < 0) return
  keys.splice(j, 0, keys.splice(i, 1)[0])
  if (fromPinned) {
    emitPinOrder(tabKey, keys.filter((k) => isPinnedRoot(k)))
    return
  }
  emit('update', { type: 'cardOrder', key: tabKey, list: mergePinnedIntoOrder(tabKey, keys.filter((k) => !isPinnedRoot(k))) })
}
// 拖拽只能排非置顶卡，但写回 cardOrder 时必须把置顶卡留在它**原来的格子**里：
// 若直接剔掉，用户随后拖别的卡就把置顶卡的名次从配置里抹掉了，取消置顶只能补到组尾。
// 做法：以旧 cardOrder 为骨架，记下每张置顶卡「前面有几张非置顶卡」，再按这个空位插回新顺序。
// 旧顺序里没有的置顶卡不补 —— 那说明它还没进过自定义顺序，取消置顶本来就该按模板原位落回。
function mergePinnedIntoOrder(tabKey: string, movable: string[]): string[] {
  const prev: string[] = []
  for (const k of props.cfg.cardOrder?.[tabKey] || []) {
    const root = cardRootKey(k)
    if (!prev.includes(root)) prev.push(root)
  }
  const slots: Array<{ root: string; before: number }> = []
  let n = 0
  for (const root of prev) {
    if (isPinnedRoot(root)) slots.push({ root, before: n })
    else n++
  }
  const out: string[] = []
  let i = 0
  for (const root of movable) {
    while (slots.length && slots[0].before <= i) out.push(slots.shift()!.root)
    out.push(root)
    i++
  }
  while (slots.length) out.push(slots.shift()!.root)
  return out
}
// 置顶区内部调序：只重排本组置顶卡在 pinnedCards 里的相对位置，其它分组的置顶卡原位不动
//（pinnedCards 是全分组共享的一份列表，整份重写会把别组的置顶顺序也搅乱）
function emitPinOrder(tabKey: string, tabPinned: string[]) {
  const all = props.cfg.pinnedCards || []
  let i = 0
  const next = all.map((k) => (props.searchIndex[k]?.tab === tabKey ? (tabPinned[i++] ?? k) : k))
  emit('update', { type: 'pinOrder', list: next })
}

// —— 默认展开态 ——
// 一张卡一个折叠键（合并卡的 focus / timer 共用 focusTimer，见 CARD_FOLDS）
function foldKeyOf(cardKey: string): string {
  return CARD_FOLDS[cardKey] || ''
}
// 只给主行显示切换按钮：合并卡的次要行与主卡共用一个折叠键，重复显示会让人以为是两张卡
function hasFoldDefault(cardKey: string): boolean {
  return !!foldKeyOf(cardKey) && !MERGED_CARD_ROOT[cardKey]
}
// 未设置过时回落到模板默认值（FOLD_DEFAULTS 与各卡 useFold 的第二参数同值，由单测比对）
function foldDefaultOpen(cardKey: string): boolean {
  const fk = foldKeyOf(cardKey)
  const v = props.cfg.foldDefaults?.[fk]
  return typeof v === 'boolean' ? v : (FOLD_DEFAULTS[fk] ?? false)
}
function onFoldDefaultToggle(cardKey: string) {
  const fk = foldKeyOf(cardKey)
  if (!fk) return
  emit('update', { type: 'foldDefault', key: fk, open: !foldDefaultOpen(cardKey) })
}
const foldRemember = computed(() => props.cfg.foldRemember !== false)
function onRememberToggle(checked: boolean) {
  emit('update', { type: 'foldRemember', open: checked })
}

function doReset() {
  confirmReset.value = false
  emit('update', { type: 'reset' })
}

// Esc 关弹窗（输入框里按 Esc 先清搜索，再按才关）：uTools 窗口没有原生关闭手势，这个很实用。
// 只留 window 这一处监听：输入框上再挂 @keydown.esc 的话，一次 Esc 会先清搜索、再冒泡到
// 这里看到空的搜索词，直接连带把弹窗也关了。
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing) return
  if (keyword.value) { keyword.value = ''; return }
  emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.display-manager-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.display-manager-modal {
  /* 面板底色必须走 --input-bg（与 SkinCropper / SoundTrimmer / FirstRunGuide 的 .panel 同源）：
     曾误用 var(--bg)，而 :root / html.dark 都没有 --bg，深色下回退成白底 + 浅色字，整块读不出 */
  background: var(--input-bg, #fff);
  color: var(--fg, #1f2a44);
  border: 1px solid var(--line, #e0e0e0);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  width: 620px;
  max-width: 92vw;
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.2s;
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--line, #e0e0e0);
}

.header-main { min-width: 0; }
.modal-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
.header-sub { margin: 4px 0 0; font-size: 12px; color: var(--fg-dim, #666); }
.header-sub b { color: var(--fg, #1f2a44); }

.close-btn {
  background: none;
  border: none;
  font-size: 22px;
  cursor: pointer;
  color: var(--fg-dim, #666);
  padding: 0;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: background 0.2s;
}
.close-btn:hover { background: var(--line, #f0f0f0); }

.search-row {
  display: flex;
  gap: 6px;
  padding: 10px 18px 0;
}
.search-input {
  flex: 1;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--fg, #1f2a44);
  background: var(--input-bg, #fff);
  border: 1px solid var(--line, #e0e0e0);
  border-radius: 6px;
  outline: none;
}
.search-input:focus { border-color: var(--accent, #4a8cff); }
/* 全仓没有全局 ::placeholder 规则，这里单独给，避免深色下搜索框占位文案看不清；
   不加会吃浏览器默认的灰（深色底约 2:1） */
.search-input::placeholder { color: var(--fg-faint); }

/* 折叠记忆总开关：勾选框 + 说明文案，窄窗口下文案整体换行 */
.fold-remember {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 8px 18px 0;
}
.fold-remember-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.fold-remember-check input[type="checkbox"] { width: 15px; height: 15px; cursor: pointer; }
.fold-remember-hint { font-size: 11px; color: var(--fg-faint, #999); }

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 18px 16px;
}

.tab-section { margin-bottom: 18px; }
.tab-section:last-child { margin-bottom: 0; }

.tab-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
  padding: 4px 0;
}
.tab-header.is-off .tab-label { color: var(--fg-faint, #999); }

.tab-check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
}
.tab-header input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
.tab-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tab-hint {
  font-size: 11px;
  color: var(--fg-faint, #999);
  font-weight: normal;
  white-space: nowrap;
}
/* 「N 张已隐藏」是需要注意的状态，不能和普通灰提示同一档；用 --warn 在两套主题下都够亮 */
.tab-hint.warn { color: var(--warn, #c07d1a); }

.tab-ops { display: flex; gap: 4px; flex: 0 0 auto; }

.mini-btn {
  padding: 1px 7px;
  font-size: 12px;
  line-height: 18px;
  color: var(--fg-dim, #666);
  background: var(--card-bg, #f5f5f5);
  border: 1px solid var(--line, #e0e0e0);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.mini-btn:hover:not(:disabled) { background: var(--line, #e8e8e8); color: var(--fg, #1f2a44); }
.mini-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mini-btn.link { border-color: transparent; background: transparent; color: var(--accent, #4a8cff); }
.mini-btn.link:hover { background: rgba(74, 140, 255, 0.12); }

.card-list {
  margin-left: 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-left: 2px solid var(--line, #eee);
  padding-left: 12px;
}
.card-list.disabled { opacity: 0.45; }

/* .card-item 的布局在上方「卡片行」处定义（grid：卡片名 + 置顶按钮并排） */
.card-item label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}
.card-item label.disabled { cursor: not-allowed; }
.card-item label.is-core { color: var(--fg-dim, #666); }
.card-item input[type="checkbox"] { width: 15px; height: 15px; cursor: pointer; flex: 0 0 auto; }
.card-item input[type="checkbox"]:disabled { cursor: not-allowed; }

.card-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.core-badge {
  font-size: 11px;
  padding: 1px 6px;
  background: var(--card-bg, #f0f0f0);
  border-radius: 3px;
  color: var(--fg-faint, #999);
  white-space: nowrap;
}

/* 「已隐藏」徽标：与核心徽标同形，但用警示色 —— 它是「需要用户处理」的状态，
   和「核心，不可隐藏」（说明性信息）必须一眼能分开 */
.hidden-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--card-bg, #f0f0f0);
  color: var(--warn, #c07d1a);
  white-space: nowrap;
}
/* 被藏掉的整行减淡：让「哪些已经看不见了」在扫一眼时就成立，
   不用逐行去读右边的小徽标（对比度仍保留，不写成 opacity: .4 那种读不出的程度） */
.card-item.is-off .card-label { color: var(--fg-faint, #999); }

/* 卡片行：拖拽手柄 + checkbox 行 + 右侧按钮并排（按钮只占卡片名右侧的空白，不额外占一行），
   卡片警告文案仍单独占下一行 */
.card-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
  row-gap: 3px;
}
.card-item .card-warning { grid-column: 1 / -1; }

/* 拖拽手柄：只有它能拖（整行可拖会跟勾选框、文字选择抢手势）。
   「⋮⋮」用负字距压窄，省得占掉卡片名的地方 */
.drag-handle {
  font-size: 12px;
  line-height: 1;
  letter-spacing: -2px;
  padding: 2px 2px;
  color: var(--fg-faint, #999);
  border-radius: 3px;
  cursor: grab;
  user-select: none;
}
.drag-handle:hover { color: var(--fg-dim, #666); background: var(--card-bg, #f5f5f5); }
.drag-handle:active { cursor: grabbing; }
/* 搜索态 / 合并卡次要行：拖不了，但要留在原位保持列对齐（所以只是变淡，不隐藏） */
.drag-handle.disabled { opacity: 0.25; cursor: not-allowed; }
.drag-handle.disabled:hover { background: transparent; color: var(--fg-faint, #999); }
/* 拖动落点：左侧亮一条竖线，比整行变色克制 */
.card-item.is-drag-over { box-shadow: inset 2px 0 0 var(--accent, #4a8cff); }

.card-ops { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.pin-btn.is-on { color: var(--accent, #4a8cff); font-weight: 600; }
.pin-rank { font-size: 11px; color: var(--fg-faint, #999); }

/* 默认展开 / 收起：开着的状态用强调色；记忆开关关掉时降透明度（仍可点，先设默认值再关记忆是常见用法） */
.fold-default-btn.is-on { color: var(--accent, #4a8cff); }
.fold-default-btn.muted { opacity: 0.55; }

.card-warning {
  margin: 0 0 2px 23px;
  font-size: 11px;
  color: var(--fg-faint, #999);
  line-height: 1.5;
}

.tab-empty { margin: 4px 0 0 24px; font-size: 12px; color: var(--fg-faint, #999); }
/* 搜不到结果时的那条提示：文案 + 「清空搜索」按钮居中排在一行 */
.tab-empty.big {
  margin: 24px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
}

.modal-footer {
  padding: 12px 18px;
  border-top: 1px solid var(--line, #e0e0e0);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.modal-msg { margin: 0 auto 0 0; font-size: 12px; color: var(--ok, #2fa24c); }
.modal-msg.err { color: var(--err, #e0433f); }

.confirm-tip { font-size: 12px; color: var(--err, #e0433f); }

/* 底部左侧的「全部显示 / 恢复默认（含二次确认）」成组；margin-left:auto 把「关闭」顶到最右，
   窄窗口时这一组整体换行，不会和「关闭」交错 */
.foot-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}

.foot-btn {
  padding: 5px 14px;
  font-size: 13px;
  background: var(--card-bg, #f5f5f5);
  color: var(--fg, #1f2a44);
  border: 1px solid var(--line, #e0e0e0);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.foot-btn:hover:not(:disabled) { background: var(--line, #e8e8e8); }
.foot-btn:disabled { opacity: 0.45; cursor: not-allowed; }
/* 主按钮 / 危险按钮写死 #536ba9：深色主题的 --accent(#8aa4e6) 与 --err(#ff6b66) 都偏亮，
   压白字对比不足（约 2~2.7:1），与 main.css 的 .utils-primary 同口径 */
.foot-btn.primary { background: #536ba9; border-color: #536ba9; color: #fff; }
.foot-btn.primary:hover { filter: brightness(1.08); }
.foot-btn.danger { color: #fff; background: #536ba9; border-color: #536ba9; }
.foot-btn.danger:hover { filter: brightness(1.08); }
</style>
