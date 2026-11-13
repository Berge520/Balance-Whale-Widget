/*
 * 计时到点看门狗（CommonJS，纯函数 + 依赖注入，无 IO、可无桩单测）。
 *
 * 为什么要有它：计时器活在悬浮窗页面里，页面随挂件一起销毁（「隐藏挂件」= destroyWidget）。
 * 挂件藏起来之后到点就没人报，重开时也只在 5 分钟宽限内才补 —— 用户定 25 分钟、顺手藏了挂件、
 * 过一阵才回来就彻底错过。宿主 preload 在主窗里还活着，由它的 30s 表补发。
 *
 * 边界（别把它当万能）：宿主 preload 随插件主窗存活，插件进程真正退出（关掉承载主界面的设置窗
 * 会触发 onPluginOut(isKill=true)）后 30s 表就停了。所以它只覆盖「挂件不在、插件进程仍在」；
 * 进程都退了谁也发不出来，那时重开挂件 5 分钟内的补发仍是唯一通道。
 *
 * 防重复三道闸：
 *   1. alive() 为真（挂件页面在）一律不插手，页面自己会报；
 *   2. 计时状态的 notified 标记：代发后写回，页面重开只补气泡/记账，不再响一次；
 *   3. 本模块记住上次代发的 endAt：写库失败也不至于每 30s 重发一遍。
 *
 * 时效上限：只补 24 小时内的到点。计时状态留在库里没有过期时间，不加这道闸的话，
 * 插件退出一两天再进来本来会给一个早就过去的「倒计时结束」弹通知，还会把它标成已通知 ——
 * 用户只会觉得莫名。
 *
 * 文案必须与页面 timerDoneText() 同口径 —— 本文件读不到 floating-page.js（那是 IIFE，
 * 不参与打包），只能镜像格式。改文案请同时看那边的 timerDoneText / fmtClock。
 */

function pad2(n) { return (n < 10 ? '0' : '') + n }

// 与 floating-page.js 的 fmtClock 逐字同口径：不足 1 小时 mm:ss，否则 h:mm:ss
function fmtClock(ms) {
  var s = Math.max(0, Math.round(ms / 1000))
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec)
}

// 与页面 timerDoneText 同口径：定时看 HH:MM，倒计时把秒数换算成时钟；留言有就接在后面
function timerDoneText(t, cfg) {
  var base
  if (t.mode === 'at') base = '定时到点（' + String(t.arg || '') + '）'
  else base = (t.isBreak === true ? '休息' : '倒计时') + '结束（' + fmtClock((Number(t.arg) || 0) * 1000) + '）'
  var note = cfg && typeof cfg.timerNote === 'string' ? cfg.timerNote.trim() : ''
  return note ? base + ' · ' + note : base
}

// 超过这个时长还没补的到点就作废（见文件头「时效上限」）
var STALE_MS = 24 * 60 * 60 * 1000

// 该不该由宿主补发：只认「还在跑的 down/at 且已过终点、且没发过」。返回通知正文或 ''
function dueTimer(t, cfg, now) {
  if (!t || (t.mode !== 'down' && t.mode !== 'at')) return ''
  if (t.running !== true || t.paused === true) return ''
  var endAt = Number(t.endAt) || 0
  if (!endAt || endAt > now) return ''
  if (now - endAt > STALE_MS) return ''
  if (t.notified === true) return ''
  return '小鲸鱼提醒：' + timerDoneText(t, cfg)
}

// 已代发过的 endAt（进程内）。写库失败时靠它避免同一轮每 30s 重发
var firedEndAt = 0

// deps: { alive, readConfig, readTimer, writeTimer, notifyTimer, logErr }
function runTimerWatch(deps, now) {
  var d = deps || {}
  try {
    if (!d.alive || d.alive()) return false
    var cfg = (d.readConfig && d.readConfig()) || {}
    // 没开「计时保存」就没有可判断的状态，别拿残留旧值当现行计时
    if (cfg.timerPersistOn === false) return false
    var t = d.readTimer && d.readTimer()
    var endAt = t ? (Number(t.endAt) || 0) : 0
    if (endAt && endAt === firedEndAt) return false
    var text = dueTimer(t, cfg, now || Date.now())
    if (!text) return false
    firedEndAt = endAt
    // 渠道口径与页面 notifyTimerDone 一致；系统/邮件总开关由 notifyTimer 内部再叠一层
    d.notifyTimer(text, cfg, { system: cfg.timerNotifyOn !== false, mail: cfg.timerMailOn === true })
    d.writeTimer(Object.assign({}, t, { notified: true }))
    return true
  } catch (err) {
    if (d.logErr) d.logErr('[whale][timer-watch] 补发到点通知失败', err && err.message)
    return false
  }
}

module.exports = { timerDoneText, dueTimer, runTimerWatch }
