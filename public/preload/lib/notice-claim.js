/*
 * 每日提醒去重（CommonJS）。
 *
 * 预算 / 低余额 / 专注目标三类系统通知各自每天最多一次（按日期字符串比较，跨天自动失效）。
 * 从 store.js 拆出来是为了不让账本读写区继续膨胀过体积棘轮的红线；本模块只读账本的
 * 日期标记、不碰账本其他字段，依赖方向 store → notice-claim 是单向的（store 不反向引用）。
 */
const { logErr } = require('./log')
const { K } = require('./constants')
const { readLedger, todayKey } = require('./store')

const NOTICE_KEYS = { budget: 'budgetNotifiedOn', low: 'lowNotifiedOn', goal: 'focusGoalNotifiedOn' }
// 写存储失败时的进程内兜底：正常靠账本里的日期标记去重，但那个标记写不进去时，
// 每轮刷新都会重新认领成功 —— 预算/低余额提醒会变成 25s 一次刷屏
const claimedInSession = new Set()

// 返回 true 表示本次调用认领了今天的提醒名额，可以发通知
function claimDailyNotice(kind) {
  const key = NOTICE_KEYS[kind] || NOTICE_KEYS.budget
  const led = readLedger()
  const t = todayKey()
  const memo = key + '@' + t
  if (led[key] === t || claimedInSession.has(memo)) return false
  led[key] = t
  try { utools.dbStorage.setItem(K.ledger, led) } catch (err) {
    // 落不了盘就只在本次会话里认账：本轮照发（用户该被提醒），但不至于每轮重弹
    logErr('[whale][ledger] 写提醒标记失败', err && err.message); claimedInSession.add(memo)
  }
  return true
}

module.exports = { claimDailyNotice }
