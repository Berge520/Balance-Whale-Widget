// 瞬时回执（Flash）：设置页各卡共用的「一行提示」状态与配套工具。
// 从 App.vue 与 10 个 view 里抽出的同一份定义 —— 原先各处内联 3~4 行，
// 结果 msgCls 的分叉（AssetsView 返字符串、其余返对象）只能靠人眼对，改一处必漏。
// 这里收口为单一来源：type Flash + useFlash() + msgCls() + useFlashShow()。
//
// 为什么不用 .vue：本模块只导出纯函数与 reactive，无模板，放 composables 与 useDsh 同级。
import { reactive } from 'vue'

/** 瞬时回执：msg 为空表示不显示，err 决定文案配色（红/绿） */
export type Flash = { msg: string; err: boolean }

/** 造一份空的瞬时回执 */
export function useFlash(): Flash {
  return reactive({ msg: '', err: false })
}

/** 模板 class 绑定：给「一行提示」套上成功/失败配色（返回对象形式，:class 直接用） */
export function msgCls(f: Flash) {
  return { ok: !f.err, err: f.err }
}

/**
 * 造一份带回执能力的瞬时回执：show() 写文案并起定时器，到点自动清空。
 * 每次 show 都重置计时（连点不会提前消失），组件卸载时调 stop() 清残留定时器。
 *
 * 为什么做成工厂而不是「给 Flash 挂方法」：Flash 是 reactive 对象，
 * 方法挂在它上面会被 Vue 当成响应式属性一并代理，且类型上把数据与行为混在一起。
 * 用闭包持有 timer，Flash 仍是纯数据。
 */
export function useFlashShow(ms: number) {
  const flash = useFlash()
  let timer: number | undefined
  function stop() {
    if (timer) { clearTimeout(timer); timer = undefined }
  }
  function show(msg: string, err = false) {
    flash.msg = msg
    flash.err = err
    stop()
    timer = window.setTimeout(() => { flash.msg = ''; timer = undefined }, ms)
  }
  function clear() {
    stop()
    flash.msg = ''
    flash.err = false
  }
  return { flash, show, clear, stop }
}
