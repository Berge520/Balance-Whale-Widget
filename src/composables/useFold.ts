import { getCurrentScope, onScopeDispose, reactive, watch } from 'vue'

// 折叠态本地缓存前缀。为什么不进配置：折叠是「看的时候的临时状态」，每次点都写配置
// 会走 IPC + 落盘 + 回推一整圈；放 localStorage 同步读写、零延迟。
export const FOLD_STORAGE_PREFIX = 'whale-fold-'
// 「是否记住上次展开状态」的本地镜像：配置要等 applyConfig 才注入，而子组件的 setup
// 早于父级 onMounted，来不及读配置。存一份镜像让首屏就能按正确口径决定读不读缓存。
const FOLD_REMEMBER_KEY = 'whale-fold-remember'

// 全局折叠偏好：由设置页 applyConfig 时 setFoldPrefs 注入。
//   · remember —— 关闭后既不读也不写 localStorage，一律用默认值
//   · defaults —— 卡片级默认展开/收起（配置里的 foldDefaults），优先于代码里的第二参数
const prefs = reactive<{ remember: boolean; defaults: Record<string, boolean> }>({
  remember: true,
  defaults: {},
})
// 是否已经注入过配置。没注入时按本地镜像判断，避免「关了记忆但首屏仍读到旧缓存」
let injected = false

// 已挂载的折叠实例：改默认值 / 关掉记忆时要把新状态推给它们 ——
// 组件 setup 已经跑完，不会再去读一次 localStorage，光改配置界面不会变。
// 记下各自的代码默认值：配置里的默认值被移除（恢复默认）时，要推回它而不是 undefined
type LiveFold = { state: { open: boolean }; defaultOpen: boolean }
const live = new Map<string, Set<LiveFold>>()

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch (err) { return null }
}
function safeSet(key: string, val: string) {
  try { localStorage.setItem(key, val) } catch (err) { /* 隐私模式 / 配额满：折叠态丢了不影响功能 */ }
}
function safeRemove(key: string) {
  try { localStorage.removeItem(key) } catch (err) { /* 同上 */ }
}

// 当前是否应该记忆：已注入则看配置，未注入则看本地镜像（默认记）
function remembering(): boolean {
  if (injected) return prefs.remember
  return safeGet(FOLD_REMEMBER_KEY) !== '0'
}

function readFold(key: string): boolean | null {
  const v = safeGet(FOLD_STORAGE_PREFIX + key)
  if (v === '1') return true
  if (v === '0') return false
  return null
}

// 清掉所有卡片折叠缓存（关闭「记住」时调用：留着等于没关，下次打开记忆又会读回来）
export function clearAllFoldStorage() {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      // 记住开关本身也带同一前缀：一起删掉会让「关闭记住」在下次启动被默认值覆盖回开启
      if (k && k.startsWith(FOLD_STORAGE_PREFIX) && k !== FOLD_REMEMBER_KEY) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch (err) { /* localStorage 不可用：本来也没存到东西 */ }
}

/**
 * 注入折叠偏好（applyConfig 回填配置时调用）。
 * - remember 由开转关：清空所有缓存（当前会话的展开状态保持不变，不硬重置用户的视线）
 * - defaults 里某个键变化 / 被移除（恢复默认）：立刻推给已挂载的实例，并清掉该键的缓存
 *   （否则用户「设成默认展开」后，旧缓存还压着它，看起来像没生效）
 * - initial = 首屏注入：这不是用户改默认值，只是把存好的配置读进来。
 *   此时有缓存就以缓存为准（「记住上次状态」的语义），不清缓存也不改当前状态；
 *   没有缓存（或记忆关着）才按新默认值落一次 —— 否则首屏会把上次的展开态全部重置成默认值。
 */
export function setFoldPrefs(next: { remember?: boolean; defaults?: Record<string, boolean>; initial?: boolean }) {
  if (typeof next.remember === 'boolean') {
    const was = prefs.remember
    prefs.remember = next.remember
    injected = true
    safeSet(FOLD_REMEMBER_KEY, next.remember ? '1' : '0')
    if (was && !next.remember) clearAllFoldStorage()
  }
  if (next.defaults) {
    const prev = prefs.defaults
    // 「恢复默认」时新表里可能已经没有这个键：只遍历新表会漏掉被移除的键，
    // 旧缓存继续压着默认值，界面看起来像点了没反应。故按新旧键的并集判变化
    prefs.defaults = { ...next.defaults }
    const keys = new Set([...Object.keys(prev), ...Object.keys(next.defaults)])
    for (const key of keys) {
      const had = Object.prototype.hasOwnProperty.call(prev, key)
      const has = Object.prototype.hasOwnProperty.call(next.defaults, key)
      const open = next.defaults[key]
      if (had === has && prev[key] === open) continue
      if (next.initial && remembering() && readFold(key) !== null) continue
      if (!next.initial) safeRemove(FOLD_STORAGE_PREFIX + key)
      const set = live.get(key)
      if (!set) continue
      for (const it of set) it.state.open = has ? !!open : it.defaultOpen
    }
  }
}

/**
 * 卡片级折叠状态。返回的对象只有 `open` 一个字段，直接绑 v-if / :class 即可。
 * 取值优先级：记住的上次状态（remember 开着且有缓存） > 配置里的默认值 > 代码默认值。
 */
export function useFold(key: string, defaultOpen: boolean) {
  const storageKey = FOLD_STORAGE_PREFIX + key
  const fallback = prefs.defaults[key] ?? defaultOpen
  const saved = remembering() ? readFold(key) : null
  const state = reactive({ open: saved === null ? fallback : saved })

  watch(
    () => state.open,
    (val) => { if (remembering()) safeSet(storageKey, val ? '1' : '0') },
  )

  let set = live.get(key)
  if (!set) { set = new Set(); live.set(key, set) }
  const owner = set
  const entry: LiveFold = { state, defaultOpen }
  owner.add(entry)
  // 组件卸载后从注册表摘掉：否则 setFoldPrefs 会一直往已销毁的 reactive 上写
  if (getCurrentScope()) {
    onScopeDispose(() => {
      owner.delete(entry)
      if (!owner.size) live.delete(key)
    })
  }
  return state
}
