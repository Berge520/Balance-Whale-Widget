import { reactive, watch, onMounted } from 'vue'

const FOLD_STORAGE_PREFIX = 'whale-fold-'

/**
 * 可持久化的折叠状态：组件挂载时从 localStorage 恢复，改变时自动保存。
 * 用于设置页各卡片的折叠/展开状态，避免用户每次打开都要重新展开。
 *
 * @param key 唯一标识（如 'about'、'notify'、'timer'），与 localStorage 键拼接
 * @param defaultOpen 默认是否展开（无缓存时使用）
 */
export function useFold(key: string, defaultOpen: boolean) {
  const storageKey = FOLD_STORAGE_PREFIX + key
  const state = reactive({ open: defaultOpen })

  // 挂载时恢复
  onMounted(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved !== null) {
        state.open = saved === '1'
      }
    } catch (err) {
      // localStorage 不可用（隐私模式/配额满），静默忽略
    }
  })

  // 改变时保存
  watch(() => state.open, (val) => {
    try {
      localStorage.setItem(storageKey, val ? '1' : '0')
    } catch (err) {
      // 静默忽略
    }
  })

  return state
}
