import { onBeforeUnmount, onMounted, ref } from 'vue'
import { CMD_TOGGLE } from '../constants/commands'
import type { WhaleServices } from '../types/services'

// 读取指令当前绑定的全局快捷键（uTools 8.0 的 utools.getCmdHotKey）。
//
// 为什么需要它：设置页原来只能告诉用户「去 uTools 设置 → 全局功能 → 新增 → 指令填 xxx」，
// 用户绑完回到这里，页面还是那句说明，根本看不出到底绑没绑、绑的是什么键 ——
// 常见的误解是「我点过新增了应该就行了吧」。这里把真实绑定读出来直接显示。
//
// 时序：绑定动作发生在 uTools 自己的设置窗口，用户切回来时本窗口重新获得焦点，
// 所以除了挂载时读一次，还要在 window focus 时再读一次，否则页面停在旧值。
// 7.x 没有该 API，宿主回空串，模板统一按「未绑定」展示（措辞不能承诺已绑定）。
// 绑定目标默认是「显示/隐藏挂件」：绝大多数用户只需要这一个，
// 指令名统一从 constants/commands 取，避免与 plugin.json 的 cmds 漂移。
export function useHotkey(services: Partial<WhaleServices>, label: string = CMD_TOGGLE) {
  const hotkey = ref('')
  function refresh() {
    try {
      hotkey.value = services.getCmdHotKey?.(label) || ''
    } catch (err) {
      hotkey.value = ''
    }
  }
  onMounted(() => {
    refresh()
    window.addEventListener('focus', refresh)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('focus', refresh)
  })
  return { hotkey, refresh }
}
