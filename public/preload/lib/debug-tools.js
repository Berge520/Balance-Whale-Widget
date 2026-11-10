/*
 * 设置页「开发者」Tab → 调试工具卡的宿主侧实现（CommonJS）。
 *
 * 为什么单独成文件：真机回归专用的一组入口，逻辑自成一块（演练投递 / 旧数据注入 / 只读自检），
 * 留在 settings.js 里只会继续撑大那个本就贴着行数棘轮的顶层模块。
 *
 * 约定：
 *   · 每个入口自己再查一次 `config.debugTools`（双保险：UI 默认不渲染，服务层也不放行）；
 *   · 「演练提醒 / 旧数据注入」不写幂等位、不启停扫描，正常 tick 逻辑不受影响；
 *   · 「专注 / 计时」自检**只读**：专注记账只有挂件「跑完 / 放弃一段计时」一个真实入口，
 *     设置页伪造一轮会污染统计；改计时快照等于替用户改计时状态，所以只报不修。
 */
const { logErr } = require('./log')
const { readConfig, patchConfig, readTodo, writeTodo, readFocus, readTimer, todayKey } = require('./store')
const { summarize: summarizeFocus } = require('./focus')
const { notify } = require('./notify')

// 待办 id 生成：与 settings.js 的 newTodoId 同口径（'t' 前缀 + 时间戳 + 随机串，去重）。
// 这里不反向 require settings.js（那是顶层模块，反向依赖会成环），只复刻这几行生成规则；
// 校验点：id 只要在当前清单里唯一即可，格式不参与任何解析
function newTodoId(items) {
  const seen = new Set((items || []).map((x) => x.id))
  for (;;) {
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    if (!seen.has(id)) return id
  }
}

const OFF = { ok: false, error: '调试工具未开启' }

// 「立即触发指定提醒」：走与正常 tick 相同的两条通道（系统通知/邮件 + 挂件气泡），
// dueAt 取当前时刻，回执带 debug:true（宿主 ipc 据此跳过记账）。
function debugTodoDue(id) {
  if (readConfig().debugTools !== true) return OFF
  const st = readTodo()
  const it = st.items.find((x) => x.id === String(id || ''))
  if (!it) return { ok: false, error: '条目不存在' }
  const cfg = readConfig()
  const dueAt = Date.now()
  try { notify('待办到点：' + it.text, cfg) } catch (err) {
    logErr('[whale][debug] 演练通知失败', err && err.message)
  }
  try {
    require('./ipc').sendWidgetCmd('todo-due', { id: it.id, text: it.text, dueAt: dueAt, debug: true })
  } catch (err) {
    logErr('[whale][debug] 演练气泡下发失败', err && err.message)
    return { ok: false, error: '挂件未就绪，气泡没发出去' }
  }
  return { ok: true, todo: st, id: it.id, dueAt: dueAt }
}

// 「注入旧数据」：一次性造出三类历史故障现场，供后续回归：
//  1) remindedFor / notifiedFor 都是 0 的重复提醒（daily，时刻 = 当前时间前 1 分钟）——
//     下个 tick 会把它当新到点走完整投递路径（免打扰 / 气泡被拦的补弹都能验）；
//  2) pinnedCards 同时含 focus 与 timer（合并卡根重复的旧形态）—— 验去重/排序/取消置顶；
//  3) 幽灵媒体项（元数据在、文件不在）—— 验媒体列表与导入配额的自愈。
// emit* 由调用方（settings.js）传入：它们闭着 settings 内部的推送通道，拆不出来
function debugInjectLegacy(emit) {
  if (readConfig().debugTools !== true) return OFF
  const media = require('./media')
  const st = readTodo()
  const now = new Date()
  // 当前本地时刻往前 1 分钟（跨零点回绕）。到点时刻已经过去，下个 tick 立刻命中
  let mins = now.getHours() * 60 + now.getMinutes() - 1
  if (mins < 0) mins += 24 * 60
  const id = newTodoId(st.items)
  st.items.unshift({
    id: id,
    text: '调试：旧数据提醒 ' + String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'),
    done: false, at: Date.now(), doneAt: 0, est: 0, rounds: 0, tm: 'down', mins: 25,
    remindOn: true, remindKind: 'daily', remindAt: mins, remindDow: 0,
    remindedFor: 0, notifiedFor: 0,
  })
  if (!writeTodo(st)) return { ok: false, error: '写入失败', todo: readTodo() }
  try { patchConfig({ pinnedCards: ['focus', 'timer'] }) } catch (err) {
    logErr('[whale][debug] 注入旧置顶配置失败', err && err.message)
  }
  let ghostId = ''
  try { ghostId = media.injectGhost() } catch (err) {
    logErr('[whale][debug] 注入幽灵媒体失败', err && err.message)
  }
  emit()
  return { ok: true, todo: st, todoId: id, ghostId: ghostId, pinnedCards: ['focus', 'timer'] }
}

// 「专注」自检：只读核对账本三件事 —— 会话明细在不在、天表与明细对不对得上、开关关着是否仍留着历史。
function debugFocusCheck() {
  if (readConfig().debugTools !== true) return OFF
  const cfg = readConfig()
  const st = readFocus()
  const key = todayKey()
  const s = summarizeFocus(st, key, 7)
  const sessions = Array.isArray(st.sessions) ? st.sessions : []
  const ms = st.days && st.days[key] ? Math.max(0, Math.round(Number(st.days[key].m) || 0)) : 0
  const issues = []
  // 天表是派生的：今日分钟数与明细里「今天结束的会话」分钟之和必须一致（差 1 分钟内算舍入）
  const todayMs = sessions.reduce((acc, x) => (x && x.d === key ? acc + Math.max(0, Math.round(Number(x.m) || 0)) : acc), 0)
  if (Math.abs(todayMs - ms) > 60000) issues.push('今日时长与明细不符（' + Math.round(ms / 60000) + ' 分钟 vs 明细 ' + Math.round(todayMs / 60000) + ' 分钟）')
  const bad = sessions.filter((x) => !x || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.d || '')) || !isFinite(Number(x.s)) || !isFinite(Number(x.t))).length
  if (bad) issues.push(bad + ' 条明细字段不完整')
  if (!cfg.todoOn) issues.push('「专注与待办」关着，挂件不记账（历史记录保留）')
  return {
    ok: issues.length === 0,
    error: issues.length ? issues.join('；') : undefined,
    sessions: sessions.length, rounds: s.today, todayMs: ms, total: s.total, streak: s.streak,
    gate: cfg.todoOn === true,
  }
}

// 「计时」自检：只读核对落库的计时状态。计时本体只在挂件页跑，这里核的是「宿主手里这份快照讲不讲得通」——
// 重建挂件后能否原样恢复，全看它。
function debugTimerCheck() {
  if (readConfig().debugTools !== true) return OFF
  const t = readTimer()
  const issues = []
  const now = Date.now()
  if (t.running && !t.paused) {
    if (t.mode === 'down' && !(t.endAt > 0)) issues.push('倒计时在跑却没有结束时刻，重建挂件后恢复不出剩余时间')
    if (t.mode === 'at' && !(t.endAt > 0)) issues.push('定时在跑却没有结束时刻')
    if (t.startAt > now + 60000) issues.push('开始时刻在未来（系统时间被改过？）')
    if (t.endAt > now + 24 * 3600 * 1000) issues.push('结束时刻超过 24 小时后，像是写坏了')
  } else if (t.endAt > 0 || t.remain > 0) issues.push('没在跑却留着结束时刻/剩余时间，重建后可能误恢复')
  if (t.isBreak && t.mode === 'off') issues.push('标了休息轮却没有计时模式')
  return {
    ok: issues.length === 0,
    error: issues.length ? issues.join('；') : undefined,
    mode: t.mode, running: t.running, paused: t.paused, isBreak: t.isBreak,
    remainMs: t.running && t.endAt > 0 ? Math.max(0, t.endAt - now) : Math.max(0, t.remain || 0),
    cycle: t.cycle,
  }
}

module.exports = { debugTodoDue, debugInjectLegacy, debugFocusCheck, debugTimerCheck }
