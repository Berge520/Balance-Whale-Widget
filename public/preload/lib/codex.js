/*
 * Codex 本地会话统计（CommonJS，叶子模块）。
 *
 * 数据源：$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl 与 archived_sessions/*.jsonl（明文 JSONL）
 *   每行：{ type, timestamp, ordinal, payload }
 *   逐轮用量：type=event_msg & payload.type=token_count 的 payload.info.last_token_usage / total_token_usage
 *   模型归属：type=turn_context 的 payload.model
 *   订阅窗口：同一 token_count 事件的 payload.rate_limits（ChatGPT 订阅 provider 才有值）
 *
 * 口径：优先用「累计量的差值」（total_token_usage 单调递增，天然免疫一次轮次多条 token_count 的重复），
 *       用量拆分按该事件的 last_token_usage 比例缩放；累计缺失时退回 last_token_usage。
 * 缓存：utools.dbStorage（whale:codex），只存各文件聚合与 size/mtime，不存任何凭据。
 */
const path = require('path')
const fs = require('fs')
const { K } = require('./constants')
const { log, logErr } = require('./log')
const { dayKeyFromTs, dayAdd, homeDir, walkDir } = require('./util')

// ── 扫描上限 ──
// 解析是「readFile + split + 逐行 JSON.parse」，即便改成异步读，**解析本身仍占主线程**，
// 所以要三管齐下给单文件、单轮总量、单轮时长都设上限：
//   · 单文件超限：直接跳过，但**结果必须落缓存**。否则该文件的 size/mtime 每轮都在变、
//     每轮都被判定为"变更"重读，而超大文件又必然在读入/解析时抛错（V8 字符串上限），
//     错误发生在写缓存之前 → 永久复发，整个插件每轮都卡一次。
//   · 单轮超预算（文件数 / 字节数 / 耗时）：先返回已聚合的部分并标 deferred，剩下的留到下一轮。
//   · 逐文件 await yieldLoop()：把控制权还给事件循环，挂件动画 / IPC 不会被一次长扫描冻住。
const CODEX_MAX_FILE_BYTES = 32 * 1024 * 1024
const CODEX_MAX_ROUND_FILES = 400
const CODEX_MAX_ROUND_BYTES = 96 * 1024 * 1024
// 单轮「连续同步解析」的时长上限。文件数 / 字节数只能挡住大文件，挡不住
// 「400 个小文件逐个 JSON.parse」——量不大，但解析一段就是几十毫秒的连续阻塞，
// 挂件动画照样掉帧。到点就让出事件循环再接着扫（不中断本轮，只切片）
const CODEX_YIELD_MS = 12
// 快照层：同步入口只读快照（过期就顺手发起后台刷新，绝不阻塞），
// 需要「这次一定要新数据」的调用方（写模型状态的那一路）走 codexSummaryEnsured 有界等待
const CODEX_SNAP_TTL_MS = 60 * 1000
const CODEX_ENSURE_MAX_MS = 2500
// 本轮有 deferred 时，隔这么久再补扫一次（不用 5s memo，那只是防抖，不是补扫）
const CODEX_RESUME_DELAY_MS = 5000
// 单次 scan 内部 memo（防抖）：同一轮里多次取快照不必重扫
const CODEX_MEMO_MS = 5000

// ── 工具 ──
// dayKeyFromTs / dayAdd 已提到 util.js（与 dsh-usage.js 原本逐字重复，D18）

// 让出事件循环：setImmediate 在本轮 IO/定时器回调之后、下一个 tick 之前执行，
// 比 setTimeout(0) 少一次 4ms 下限，也不像 process.nextTick 那样插队（插队等于没让）。
// 刻意**不用** setImmediate().unref 之类：扫描是有意义的未完成工作，不该被当成空闲句柄。
function yieldLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

// 可在单测里替换的「延迟执行」接缝：scheduleResume 的 5 秒补扫、codexSummaryEnsured 的超时
// 都走它，测试才能在不真等的前提下验证补扫（与 util.js 的 atomicTmpPath 同款理由）。
// ⚠️ 调用点必须走 `module.exports.later(...)` 这个间接层（本文件末尾是 module.exports 整体替换，
//    写 exports.x 会拿到 undefined）。返回句柄供 clearTimeout
function later(fn, waitMs) {
  return setTimeout(fn, waitMs)
}
// 取用函数：调用点统一经它在**调用时**取一次当前实现，测试替换 module.exports.later 才真的生效
function laterOf() {
  return typeof module.exports.later === 'function' ? module.exports.later : later
}

// ── Codex 目录定位 ──
// 口径与改动前完全一致（D22）：**不支持** `~` 展开、**不**把相对路径按 cwd 解析
// （原实现是把 env 原样丢给 existsSync）。所以 expand / relative 都保持默认 false。
function codexHome() {
  return homeDir({ env: 'CODEX_HOME', fallback: '.codex' })
}

// ── 缓存读写（utools.dbStorage）──
// v2 起每个文件多存订阅窗口快照（rl/rlTs）：老缓存没有这两个字段，而文件指纹没变时不会重新解析，
// 会让窗口信息一直缺失 → 版本不符就当空缓存重扫一次
function readCodexCache() {
  try {
    const v = utools.dbStorage.getItem(K.codex)
    if (v && v.version === 2 && v.files && typeof v.files === 'object') return v
  } catch (_) {}
  return { version: 2, files: {} }
}
function writeCodexCache(c) {
  try { utools.dbStorage.setItem(K.codex, c) } catch (err) { logErr('[whale][codex] 写缓存失败', err && err.message) }
}

// ── 列出所有会话文件 ──
// sessions/ 下按 YYYY/MM/DD/rollout-*.jsonl 组织；archived_sessions/ 同理
// walkDir（util.js）已内含 depth 上限 6、排序与「读不到的子目录跳过」，
// 这里只需要把 match 定成文件名（不是整路径）
function listCodexSessionFiles(root) {
  const match = /^rollout-.*\.jsonl$/i
  const a = walkDir(path.join(root, 'sessions'), { match })
  const b = walkDir(path.join(root, 'archived_sessions'), { match })
  // 两棵树各自有序，合并后必须再排一次 —— 原实现是单次 walk 后统一 sort，
  // 顺序会决定「预算用尽时优先解析哪些文件」，必须保持一致
  const out = a.files.concat(b.files)
  out.sort()
  return out
}

// ── 解析单个会话文件 → { day: { model: {in,cached,cwrite,out,reason,total,turns} } } ──
// rl/rlTs 是该文件里时间最新的订阅窗口快照（没订阅 / API-key 计费时为 null）
// 纯文本解析（不做 IO），读取在 async 的 codexScan 里 —— 分开是为了让单测能直接喂文本，
// 也避免「读失败」与「解析失败」两条错误的归因混在一起
function parseCodexFileText(text) {
  const days = {}
  let model = 'codex'
  let prevTotal = null
  let lastRl = null, rlTs = -1
  const bump = (day, mk, v) => {
    days[day] = days[day] || {}
    const cur = days[day][mk] || { in: 0, cached: 0, cwrite: 0, out: 0, reason: 0, total: 0, turns: 0 }
    cur.in += v.in; cur.cached += v.cached; cur.cwrite += v.cwrite
    cur.out += v.out; cur.reason += v.reason; cur.total += v.total; cur.turns += v.turns
    days[day][mk] = cur
  }
  for (const line of String(text == null ? '' : text).split('\n')) {
    if (!line || line.charCodeAt(0) !== 123) continue // 只处理 '{' 开头的行
    let o = null
    try { o = JSON.parse(line) } catch (_) { continue }
    const p = o && o.payload
    if (!p) continue
    if (o.type === 'turn_context') {
      if (p.model) model = String(p.model)
      continue
    }
    if (o.type !== 'event_msg' || p.type !== 'token_count') continue
    // 订阅窗口快照与 info 无关（缺 info 的事件也可能带），所以放在 info 判断之前取；
    // 同一文件里保留时间最新的一条，跨文件的最新那条由 codexSummary 汇总
    const rl = p.rate_limits
    if (rl && typeof rl === 'object' && (rl.primary || rl.secondary || rl.plan_type || rl.credits)) {
      const rts = Date.parse(String(o.timestamp || '')) || 0
      if (rts >= rlTs) { lastRl = rl; rlTs = rts }
    }
    const info = p.info
    if (!info || typeof info !== 'object') continue
    const last = info.last_token_usage || null
    const tot = info.total_token_usage || null
    const ts = Date.parse(String(o.timestamp || '')) || 0
    if (!ts) continue
    const day = dayKeyFromTs(ts)
    // 该次增量：优先用累计差值（天然去重），否则退回 last_token_usage
    let delta = null
    const totAll = tot ? Number(tot.total_tokens) || 0 : 0
    if (totAll > 0) {
      if (prevTotal === null || totAll < prevTotal) delta = totAll
      else delta = totAll - prevTotal
      prevTotal = totAll
    }
    if (delta === null || delta <= 0) {
      if (!last) continue
      delta = Number(last.total_tokens) || 0
    }
    if (delta <= 0) continue
    // 拆分：按 last_token_usage 的比例缩放到 delta
    const lTotal = last ? Number(last.total_tokens) || 0 : 0
    const k = (lTotal > 0 && last) ? delta / lTotal : 0
    const v = last && k > 0
      ? {
        in: Math.round((Number(last.input_tokens) || 0) * k),
        cached: Math.round((Number(last.cached_input_tokens) || 0) * k),
        cwrite: Math.round((Number(last.cache_write_input_tokens) || 0) * k),
        out: Math.round((Number(last.output_tokens) || 0) * k),
        reason: Math.round((Number(last.reasoning_output_tokens) || 0) * k),
      }
      : { in: 0, cached: 0, cwrite: 0, out: 0, reason: 0 }
    bump(day, model, { in: v.in, cached: v.cached, cwrite: v.cwrite, out: v.out, reason: v.reason, total: delta, turns: 1 })
  }
  return { days, rl: lastRl, rlTs: rlTs > 0 ? rlTs : 0 }
}

// ── 订阅窗口归一化 ──
// rate_limits 的字段名在不同 Codex 版本里不一致 → 多候选键容错，换算成「已用% + 重置时间戳」
function normalizeCodexWindow(w, baseTs) {
  if (!w || typeof w !== 'object') return null
  const pick = (keys) => {
    for (const k of keys) {
      const raw = w[k]
      if (raw === null || raw === undefined || raw === '') continue
      const n = Number(raw)
      if (isFinite(n)) return n
    }
    return null
  }
  let usedPct = pick(['used_percent', 'usedPercent', 'percent', 'used_pct', 'usage_percent', 'usagePercent'])
  const remainPct = pick(['remaining_percent', 'remainingPercent', 'left_percent', 'remaining_pct'])
  if (usedPct === null && remainPct !== null) usedPct = Math.max(0, 100 - remainPct)
  let resetAt = null
  const secs = pick(['resets_in_seconds', 'resetsInSeconds', 'reset_after_seconds', 'reset_in_seconds', 'seconds_until_reset'])
  // 相对秒数要按「快照当时」换算：快照可能是几小时前写的，用 Date.now() 当基准会让倒计时永远重置不完
  if (secs !== null && secs >= 0) resetAt = (Number(baseTs) || Date.now()) + secs * 1000
  else {
    const abs = w.resets_at || w.reset_at || w.reset_time || w.next_reset || w.resetAt || w.nextResetTime
    if (typeof abs === 'number' && isFinite(abs)) resetAt = abs < 1e12 ? abs * 1000 : abs
    else if (typeof abs === 'string' && abs) { const t = Date.parse(abs); if (isFinite(t)) resetAt = t }
  }
  const windowMinutes = pick(['window_minutes', 'windowMinutes', 'window', 'period_minutes'])
  const label = String(w.limit_name || w.name || w.label || w.window_name || '')
  if (usedPct === null && resetAt === null) return null
  return { usedPct, resetAt, windowMinutes, label }
}
function normalizeCodexRateLimits(rl, baseTs) {
  if (!rl || typeof rl !== 'object') return null
  const primary = normalizeCodexWindow(rl.primary, baseTs)
  const secondary = normalizeCodexWindow(rl.secondary, baseTs)
  if (!primary && !secondary) return null
  return {
    primary, secondary,
    planType: rl.plan_type ? String(rl.plan_type) : '',
    limitName: rl.limit_name ? String(rl.limit_name) : (rl.limit_id ? String(rl.limit_id) : ''),
    reached: rl.rate_limit_reached_type ? String(rl.rate_limit_reached_type) : '',
  }
}

// ── 汇总（带增量缓存：只有变化的文件才重新解析）──
// 全程 async：读文件走 fs.promises，解析之间 await yieldLoop()，挂件动画不会被冻住
let memo = null, memoAt = 0

// 读一个会话文件并解析；读失败按「空结果 + 留痕」处理（与旧实现同口径，但不再静默）
async function parseCodexFile(file) {
  let text = ''
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    logErr('[whale][codex] 读会话文件失败', file, err && err.message)
    return { days: {}, rl: null, rlTs: 0 }
  }
  return parseCodexFileText(text)
}

async function codexScan() {
  const now = Date.now()
  if (memo && now - memoAt < CODEX_MEMO_MS) return memo
  const home = codexHome()
  if (!home) {
    memo = { ok: false, error: '未找到 Codex 目录（$CODEX_HOME 或 ~/.codex）' }
    memoAt = now
    return memo
  }
  const cache = readCodexCache()
  // walkDir 是同步递归（util.js 的既有实现）。会话目录只有 YYYY/MM/DD 三层、
  // readdir 通常在毫秒级，这里不为它单独造一套异步遍历 —— 真正的大头是文件解析，已经切片了
  const files = listCodexSessionFiles(home)
  const keep = {}
  let changed = 0
  let skipped = 0

  // 先按「是否需要解析」分桶，并给每个文件取一次 stat。
  // 之所以要先分桶：单轮预算必须优先花在**新变更**的文件上。若按目录顺序边扫边判，
  // 前几个文件每轮都会先把预算吃光，后面的文件永远轮不到（反复重扫同一批，永不前进）。
  const fresh = []   // 指纹变了、需要（重新）解析
  const reused = []  // 指纹未变、直接复用缓存
  let pendingCount = 0
  for (const f of files) {
    let st = null
    try { st = await fs.promises.stat(f) } catch (_) { continue }
    const prev = cache.files[f]
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.days) { reused.push([f, st, prev]); continue }
    // 超大文件：不解析，但把 size/mtime 记进缓存，下一轮指纹未变就不会再进来
    if (st.size > CODEX_MAX_FILE_BYTES) {
      keep[f] = { size: st.size, mtimeMs: st.mtimeMs, days: {}, rl: null, rlTs: 0, skipped: true }
      skipped++
      continue
    }
    fresh.push([f, st])
  }

  // 单轮预算：本轮只解析 fresh 里的前 N 个 / 前 X 字节 / 前十几毫秒，其余留到下一轮。
  // 注意「留到下一轮」必须能在下一轮被优先处理，所以本轮未解析的一律不写缓存指纹，
  // 下轮它们仍在 fresh 里、且排在已被 reuse 的那些之前。
  let roundFiles = 0, roundBytes = 0, deferred = false
  let yieldAt = Date.now()
  for (const [f, st] of fresh) {
    if (roundFiles >= CODEX_MAX_ROUND_FILES || roundBytes + st.size > CODEX_MAX_ROUND_BYTES) {
      deferred = true
      pendingCount++
      const prev = cache.files[f]
      if (prev) keep[f] = prev // 有旧结果就先用旧的，至少不丢历史数据
      continue
    }
    // 连续解析超过 CODEX_YIELD_MS 就让出一次事件循环，回来再接着扫（不中断本轮）
    if (Date.now() - yieldAt >= CODEX_YIELD_MS) {
      await yieldLoop()
      yieldAt = Date.now()
    }
    const parsed = await parseCodexFile(f)
    keep[f] = { size: st.size, mtimeMs: st.mtimeMs, days: parsed.days, rl: parsed.rl || null, rlTs: parsed.rlTs || 0 }
    roundFiles++
    roundBytes += st.size
    changed++
  }
  for (const [f, , prev] of reused) keep[f] = prev
  // 落缓存：pending 的文件不进缓存（下轮仍按"变更"优先解析），但本轮已解析的必须落盘，
  // 否则进度无法跨轮累积，每轮都从同一批文件重来。
  const cacheKeys = Object.keys(cache.files).length
  const keepKeys = Object.keys(keep).length
  if (changed > 0 || cacheKeys !== keepKeys + pendingCount) {
    writeCodexCache({ version: 2, files: keep, builtAt: Date.now() })
  }
  // 聚合
  const today = dayKeyFromTs(Date.now())
  const month = today.slice(0, 7)
  const byDay = {}
  const byModel = {}
  let totalTokens = 0, todayTokens = 0, monthTokens = 0, outTokens = 0, reasonTokens = 0, cachedTokens = 0, turns = 0
  // 跨文件取时间最新的那条订阅窗口快照（窗口是账号级状态，与哪个会话文件无关）
  let bestRl = null, bestRlTs = -1
  for (const f of Object.keys(keep)) {
    if (keep[f].rl && (keep[f].rlTs || 0) >= bestRlTs) { bestRl = keep[f].rl; bestRlTs = keep[f].rlTs || 0 }
    const days = keep[f].days || {}
    for (const d of Object.keys(days)) {
      const day0 = byDay[d] || (byDay[d] = { tokens: 0, turns: 0, models: {} })
      for (const m of Object.keys(days[d])) {
        const v = days[d][m] || {}
        day0.tokens += Number(v.total) || 0
        day0.turns += Number(v.turns) || 0
        day0.models[m] = (day0.models[m] || 0) + (Number(v.total) || 0)
        const bm = byModel[m] || (byModel[m] = { tokens: 0, out: 0, reason: 0, cached: 0, turns: 0 })
        bm.tokens += Number(v.total) || 0
        bm.out += Number(v.out) || 0
        bm.reason += Number(v.reason) || 0
        bm.cached += Number(v.cached) || 0
        bm.turns += Number(v.turns) || 0
        totalTokens += Number(v.total) || 0
        outTokens += Number(v.out) || 0
        reasonTokens += Number(v.reason) || 0
        cachedTokens += Number(v.cached) || 0
        turns += Number(v.turns) || 0
        if (d === today) todayTokens += Number(v.total) || 0
        if (d.slice(0, 7) === month) monthTokens += Number(v.total) || 0
      }
    }
  }
  // 近 31 天明细（索引 0 是今天，新→旧；设置页按 7/14/30 档位取 slice(0, N) 渲染 ——
  // 最近 N 天在数组**开头**，写成 slice(-N) 会取到最旧的 N 天，切档不重扫）
  const days31 = []
  for (let i = 0; i < 31; i++) {
    const d = dayAdd(today, -i)
    days31.push({ date: d, tokens: (byDay[d] && byDay[d].tokens) || 0, turns: (byDay[d] && byDay[d].turns) || 0 })
  }
  memo = {
    ok: true, home, sessions: files.length, changed,
    // 超大被跳过的文件数，以及本轮预算用尽未扫完（下轮补扫）
    skipped, deferred,
    todayTokens, monthTokens, totalTokens,
    outTokens, reasonTokens, cachedTokens, turns,
    days31, byModel,
    // 订阅窗口（5h / 周）：只有日志里带值的 rate_limits（ChatGPT 订阅 provider）才有内容，
    // API-key 计费或无订阅时为 null，设置页据此不渲染这一行
    windows: normalizeCodexRateLimits(bestRl, bestRlTs),
    rateLimitsTs: bestRlTs > 0 ? bestRlTs : 0,
  }
  memoAt = now
  log('[whale][codex] 统计完成', home, files.length, '文件', changed, '变更', todayTokens, '今日',
    skipped > 0 ? ('跳过 ' + skipped + ' 个超大日志') : '', deferred ? '本轮预算用尽，下轮续扫' : '')
  return memo
}

// ── 快照层 ──
// 为什么还要一层快照：所有 IPC handler 与 sendToWidget 都是**同步**的 —— 把 scan 做成 async 之后，
// 一旦在同步函数里调它，拿到的只会是个 Promise，`r.ok` 恒为 undefined，用户看到的是「统计失败」。
// 所以对外拆成三种入口：
//   · codexSummaryCached()     同步、永不阻塞：有快照就返回快照，过期就顺手发一个后台刷新
//   · codexSummaryEnsured(ms)  有界等待：最多等 ms 毫秒，等不到就给旧快照（可能 null），绝不挂死
//   · codexSummary()           直接 await 一次真实扫描（设置页「刷新」按钮要的语义）
let snap = null          // 最近一次完成的扫描结果（可能已过期）
let snapAt = 0           // 快照完成时刻
let inflight = null      // 进行中的扫描 Promise（并发调用共享同一次扫描，不叠跑）
let resumeTimer = null   // deferred 补扫的定时器句柄
let snapListeners = []

// 唯一的扫描发起口：已有进行中的扫描就复用。失败也要落成快照（ok:false），
// 否则「目录不存在」这类稳定失败会变成每次调用都重扫一遍目录树
function kickScan(why) {
  if (inflight) return inflight
  inflight = Promise.resolve()
    .then(() => codexScan())
    .then((r) => {
      snap = r
      snapAt = Date.now()
      if (r && r.ok && r.deferred) scheduleResume()
      notifySnapshot()
      return r
    })
    .catch((err) => {
      logErr('[whale][codex] 扫描失败', why, err && err.message)
      const r = { ok: false, error: '读取 Codex 会话统计失败：' + String((err && err.message) || err) }
      snap = r
      snapAt = Date.now()
      return r
    })
    .then((r) => { inflight = null; return r })
  return inflight
}

// 补扫：本轮预算用尽 → 隔 CODEX_RESUME_DELAY_MS 再扫一次，把 deferred 的部分补上。
// 不用 5s memo 顶替：memo 只是防抖，过期后再调才扫，而这条路径需要「没人调也自己补」
function scheduleResume() {
  if (resumeTimer) return
  resumeTimer = laterOf()(() => {
    resumeTimer = null
    // 清掉 scan 内部的 memo：补扫必须真的再扫一轮，不能被 5s 防抖挡回去
    memo = null
    memoAt = 0
    kickScan('resume')
  }, CODEX_RESUME_DELAY_MS)
}

function notifySnapshot() {
  const list = snapListeners.slice()
  for (const cb of list) {
    try { cb(snap) } catch (err) { logErr('[whale][codex] 快照订阅回调异常', err && err.message) }
  }
}

// 订阅「快照更新」（后台补扫 / 刷新完成后触发）。返回退订函数。
// settings.js 用它把新的今日 token 推给挂件：用户没开设置页时，也只有这里能感知到补扫完成
function onCodexSnapshot(cb) {
  if (typeof cb !== 'function') return () => {}
  snapListeners.push(cb)
  return function off() {
    const i = snapListeners.indexOf(cb)
    if (i >= 0) snapListeners.splice(i, 1)
  }
}

function snapshotFresh() {
  return !!snap && Date.now() - snapAt < CODEX_SNAP_TTL_MS
}

// 同步入口：立刻返回（可能是旧快照 / null），过期就在后台补一次，绝不阻塞调用方
function codexSummaryCached() {
  if (!snapshotFresh()) kickScan('cached')
  return snap
}

// 有界等待入口：最多等 maxWaitMs；等不到就返回旧快照（调用方要能接受 null）
async function codexSummaryEnsured(maxWaitMs) {
  if (snapshotFresh()) return snap
  const ms = Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : CODEX_ENSURE_MAX_MS
  const run = kickScan('ensured')
  let timer = null
  const timeout = new Promise((resolve) => { timer = laterOf()(() => resolve(null), ms) })
  const r = await Promise.race([run, timeout])
  if (timer) clearTimeout(timer)
  return r || snap
}

// 直接扫一轮（await 真实结果）。设置页「刷新」按钮走这里，语义是「我现在就要最新数字」。
// 仍复用进行中的扫描，避免连点叠跑
function codexSummary() {
  memo = null
  memoAt = 0
  return kickScan('direct')
}

// 插件进程真正结束时的清理（services.js 的 onPluginOut(isKill) 调）。
// 与 clearCodexCache 的区别：这里**不删缓存数据**（用户下次进来还要用），只停掉本模块持有的
// 定时器并清空订阅者 —— resumeTimer 是 5s 后才触发的补扫，进程结束前它还会再拉一次全量扫描，
// 对一个正在退出的进程纯属浪费（且扫描本身是 async，可能在退出过程中把半截结果写库）。
// 进行中的扫描不强行中断（没有取消通道，硬造只会让 fileCache 停在半更新态），让它自然收尾即可。
function dispose() {
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
  snapListeners = []
}

// 清缓存（设置页「刷新」按钮 / 清除数据时调用）
function clearCodexCache() {
  memo = null
  memoAt = 0
  snap = null
  snapAt = 0
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
  try { utools.dbStorage.removeItem(K.codex) } catch (_) {}
}

module.exports = {
  codexSummary, codexSummaryCached, codexSummaryEnsured, clearCodexCache, codexHome,
  onCodexSnapshot,
  // 插件退出清理（停补扫定时器 + 退订，不删缓存），services.js 的 onPluginOut 调
  dispose,
  // 单测接缝：替换 later 以便不真等 5 秒就能验证补扫
  later,
}
