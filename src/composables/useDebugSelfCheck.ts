import { reactive } from 'vue'
import type { WhaleServices } from '../types/services'

/*
 * 设置页「开发者」Tab → 调试工具卡的自检逻辑（只读）。
 *
 * 为什么单独成一个 composable：调试卡要的是「每行一个按钮、结果就地写在按钮旁」，
 * 三条自检 + 提醒演练 + 旧数据注入各自都有「宿主没提供入口 / 抛错 / 判定不过」三种落法，
 * 全塞进 App.vue 会把设置页外壳继续撑大（行数棘轮只缩不涨）。这里只做「跑一次 + 拼一句人话」，
 * 判定阈值与写操作一律留在宿主（settings.js 的 debugFocusCheck / debugTimerCheck）。
 *
 * 约定：
 *   · 只读：这里不写任何存储，自检失败也不会自动修（改计时快照等于替用户改计时状态）；
 *   · 每条结果各自独立，互不覆盖 —— 原来只有一个全局「调试结果」槽，谁也说不清那句是哪一步的；
 *   · 入口缺失 / 抛错都落到「未执行」，不让按钮点了没反应。
 */

export type DebugRow = { msg: string; bad: boolean }

const INIT: DebugRow = { msg: '（未执行）', bad: false }

// 时长展示：分钟以内就报分钟，超过一小时拆成「N 小时 M 分钟」（自检看的是量级，不追秒）
function dur(ms: number): string {
  const m = Math.max(0, Math.round((Number(ms) || 0) / 60000))
  return m >= 60 ? Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟' : m + ' 分钟'
}

export function useDebugSelfCheck(services: Partial<WhaleServices>) {
  const rows = reactive<Record<string, DebugRow>>({})
  const row = (k: string): DebugRow => rows[k] || INIT

  // 统一兜底：宿主没给入口 / 抛错 → 明确的红字，而不是静默的「（未执行）」
  function run(k: string, fn: () => any, okMsg: (r: any) => string) {
    let r: any = null
    try {
      r = fn()
    } catch (err) {
      r = { ok: false, error: String((err as Error)?.message || err) }
    }
    if (!r) {
      rows[k] = { msg: '宿主未提供该调试入口', bad: true }
      return
    }
    rows[k] = { msg: r.ok ? okMsg(r) : r.error || '未通过', bad: !r.ok }
  }

  function focusCheck() {
    run('focus', () => services.debugFocusCheck?.(), (r) =>
      '通过：明细 ' + r.sessions + ' 条 / 今日 ' + r.rounds + ' 轮 · ' + dur(r.todayMs)
      + ' / 累计 ' + dur(r.total) + (r.streak ? ' / 连续 ' + r.streak + ' 天' : ''))
  }

  // 待办没有宿主专用入口：清单本身就在设置页手里，这里直接核「最常见的点了没反应」——
  // 专注目标还指着一条已删掉的条目
  function todoCheck() {
    run('todo', () => {
      const st = services.todoGet?.()
      if (!st) return null
      const items = st.items || []
      if (st.focusId && !items.some((x) => x.id === st.focusId)) {
        return { ok: false, error: '专注目标指向不存在的条目（' + st.focusId + '），挂件点「开始」会没反应' }
      }
      return {
        ok: true,
        n: items.length,
        done: items.filter((x) => x.done).length,
        timed: items.filter((x) => x.remindOn).length,
        focus: !!st.focusId,
      }
    }, (r) => '通过：' + r.n + ' 条（已完成 ' + r.done + '，带提醒 ' + r.timed + '）' + (r.focus ? '，专注目标已设' : ''))
  }

  function timerCheck() {
    run('timer', () => services.debugTimerCheck?.(), (r) => {
      if (r.mode === 'off' || !r.running) return '通过：当前没有在跑的计时（' + r.mode + '）'
      return '通过：' + (r.mode === 'down' ? '倒计时' : r.mode === 'at' ? '定时' : '正计时')
        + (r.paused ? '（已暂停）' : '') + (r.isBreak ? ' · 休息轮' : '')
        + (r.remainMs > 0 ? ' · 还剩 ' + dur(Math.ceil(r.remainMs / 60000) * 60000) : '')
    })
  }

  function todoDue(id: string) {
    if (!id) return
    run('due', () => services.debugTodoDue?.(id), () => '已投递（不写幂等位，去挂件看气泡）')
  }

  function injectLegacy() {
    run('inject', () => services.debugInjectLegacy?.(), (r) =>
      '已注入：待办 ' + (r.todoId || '') + '、置顶 [focus, timer]、幽灵媒体 ' + (r.ghostId || ''))
  }

  return { row, focusCheck, todoCheck, timerCheck, todoDue, injectLegacy }
}
