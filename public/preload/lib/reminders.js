// public/preload/lib/reminders.js
// 待办到点提醒的纯逻辑：无 IO、无 utools，便于单测。
// 时间一律按本地时区解析；不引入时区库。

function normKind(v) {
  return v === 'daily' || v === 'weekdays' || v === 'weekly' ? v : 'once'
}

// 归一提醒字段：非法形态回退 once；once 的 remindAt 是绝对 ms，其余是当天分钟数 0–1439
function normRemind(input) {
  const src = input && typeof input === 'object' ? input : {}
  const remindOn = src.remindOn === true
  const remindKind = normKind(src.remindKind)
  const raw = Math.round(Number(src.remindAt))
  let remindAt = 0
  if (Number.isFinite(raw) && raw > 0) {
    remindAt = remindKind === 'once' ? raw : Math.max(0, Math.min(1439, raw))
  }
  const d = Math.round(Number(src.remindDow))
  const remindDow = Number.isFinite(d) ? Math.max(0, Math.min(6, d)) : 0
  return { remindOn, remindKind, remindAt, remindDow }
}

function dayStart(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
function shiftDays(startMs, delta) {
  const d = new Date(startMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta).getTime()
}

// 最近一次「已到点」的时刻（0 = 无）。已完成 / 未开启 / 非法一律 0。
function latestDueMs(item, now) {
  if (!item || item.remindOn !== true || item.done === true) return 0
  const kind = normKind(item.remindKind)
  const raw = Math.round(Number(item.remindAt))
  if (!Number.isFinite(raw) || raw < 0) return 0
  if (kind === 'once') return raw > 0 && raw <= now ? raw : 0
  // 重复形态的 remindAt=0 表示本地 00:00，是合法时刻；是否启用由 remindOn 控制
  const mins = Math.max(0, Math.min(1439, raw))
  const today = dayStart(now)
  if (kind === 'daily') {
    const todayDue = today + mins * 60000
    return todayDue <= now ? todayDue : shiftDays(today, -1) + mins * 60000
  }
  const dow = Math.max(0, Math.min(6, Math.round(Number(item.remindDow)) || 0))
  let base = today
  for (let i = 0; i < 8; i++) {
    const due = base + mins * 60000
    const wd = new Date(base).getDay()
    const ok = kind === 'weekdays' ? (wd >= 1 && wd <= 5) : (wd === dow)
    if (ok && due <= now) return due
    base = shiftDays(base, -1)
  }
  return 0
}

// 新建 / 改设提醒时的幂等位基线。
// 重复形态（daily / weekdays / weekly）把「此刻已经过去的那一轮」记为已提醒 ——
// 否则 10:00 设一个 daily 09:00 的提醒，第一个 tick 就会把这轮补弹一次。
// once 型不回填：过期的一次性提醒本来就该立刻提醒，不能一刀切。
function initialRemindedFor(input, now) {
  const r = normRemind(input)
  if (!r.remindOn || r.remindKind === 'once') return 0
  return latestDueMs(r, now)
}

// 两套幂等位（真机 A1/A2 结论后拆分）：
//  - notifiedFor：这一轮的**系统通知 / 邮件**已处理（送达，或已由挂件气泡完成）
//  - remindedFor：这一轮的**挂件气泡**已真正展示（页面回执 whale:todo-due-ack 才写）
// 两套分开记账，才能做到「系统通知发过就不再重复发，但气泡没弹出来仍在下个 tick 补弹」。
// 注意 notifiedFor 用 Math.max(notifiedFor, remindedFor) 兜底：v1.14 之前只有 remindedFor 一个位，
// 老数据里它代表「整轮已完成」，不回填的话升级后每条历史提醒都会被系统通知重发一遍。
function scanDue(todoState, now) {
  const items = todoState && Array.isArray(todoState.items) ? todoState.items : []
  const out = []
  for (const it of items) {
    const due = latestDueMs(it, now)
    if (!(due > 0)) continue
    const reminded = Math.round(Number(it.remindedFor)) || 0
    const notified = Math.max(Math.round(Number(it.notifiedFor)) || 0, reminded)
    const needNotify = due > notified
    const needBubble = due > reminded
    if (needNotify || needBubble) out.push({ id: it.id, text: it.text, dueAt: due, needNotify, needBubble })
  }
  return out
}

// notify() 的返回值是「实际送达了哪些渠道」（{ system, mail }）；老式注入返回 undefined /
// 非对象，按「已尝试系统通知」处理，保持既有调用方语义不变
function notifyDelivered(r) {
  if (r === false) return false
  if (r && typeof r === 'object') return r.system === true || r.mail === true
  return true
}

// 依赖注入的一轮扫描：通知 + 通知页面气泡，两套幂等位分开记账。deps 便于单测。
//  - 系统通道：真的送达才写 notifiedFor；发过就不再重复发；
//  - 挂件通道：只下发，气泡是否真露头由页面回执决定（计时气泡占位时会被拦，宿主看不见）。
//    没露头就不写 remindedFor → 下个 tick 继续补弹，直到回执成功；
//  - silent（免打扰时段）：完全不发系统通知/邮件，也**不记账**（否则出时段就补不到了）。
//    气泡照弹 —— 与设置页「免打扰」的既有口径一致（这条口径有意保留，见 NotifyView 文案）。
// once 型只要还有一套位没写，就一直是 due，不会因为被拦一次而永久丢。
function runDueTick(deps) {
  const { now, readTodo, writeTodo, notify, sendToWidget, cfg, silent } = deps || {}
  const st = readTodo()
  const due = scanDue(st, now)
  if (!due.length) return []
  let dirty = false
  for (const d of due) {
    const it = st.items.find((x) => x.id === d.id)
    if (!it) continue
    if (d.needNotify && !silent) {
      let delivered = false
      try { if (typeof notify === 'function') delivered = notifyDelivered(notify('待办到点：' + d.text, cfg)) } catch (err) {}
      if (delivered) {
        it.notifiedFor = d.dueAt
        dirty = true
      }
    }
    if (d.needBubble) {
      try { if (typeof sendToWidget === 'function') sendToWidget('todo-due', { id: d.id, text: d.text, dueAt: d.dueAt }) } catch (err) {}
    }
  }
  if (dirty) { try { writeTodo(st) } catch (err) {} }
  return due
}

module.exports = { normRemind, latestDueMs, initialRemindedFor, scanDue, runDueTick }
