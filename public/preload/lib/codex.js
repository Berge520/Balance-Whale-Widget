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
const os = require('os')
const fs = require('fs')
const { K } = require('./constants')
const { log, logErr } = require('./log')

// ── 扫描上限 ──
// 解析是同步的（readFileSync + split + 逐行 JSON.parse），整个插件主线程会被占住，
// 所以要给「单个文件」和「单轮总量」都设上限：
//   · 单文件超限：直接跳过，但**结果必须落缓存**。否则该文件的 size/mtime 每轮都在变、
//     每轮都被判定为"变更"重读，而超大文件又必然在读入/解析时抛错（V8 字符串上限），
//     错误发生在写缓存之前 → 永久复发，整个插件每轮都卡一次。
//   · 单轮超预算：先返回已聚合的部分并标 deferred，剩下的留到下一轮（5 秒 memo + 调用方缓存承接）。
const CODEX_MAX_FILE_BYTES = 32 * 1024 * 1024
const CODEX_MAX_ROUND_FILES = 400
const CODEX_MAX_ROUND_BYTES = 96 * 1024 * 1024

// ── 工具 ──
// 时间戳 → 'YYYY-MM-DD'（本地时区，用户在 Asia/Shanghai）
function dayKeyFromTs(ts) {
  const d = new Date(Number(ts))
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}
// 日期字符串 ±天数 → 'YYYY-MM-DD'
function dayAdd(base, delta) {
  const d = new Date(base + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return dayKeyFromTs(d.getTime())
}

// ── Codex 目录定位 ──
function codexHome() {
  const env = String(process.env.CODEX_HOME || '').trim()
  for (const c of [env, path.join(os.homedir(), '.codex')]) {
    try { if (c && fs.existsSync(c)) return c } catch (_) {}
  }
  return ''
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
function listCodexSessionFiles(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/^rollout-.*\.jsonl$/i.test(e.name)) out.push(p)
    }
  }
  // sessions/ 下按 YYYY/MM/DD/rollout-*.jsonl 组织
  walk(path.join(root, 'sessions'), 0)
  walk(path.join(root, 'archived_sessions'), 0)
  // 按路径排序：walk 依赖 readdirSync 的目录顺序，在不同文件系统上不稳定。
  // 排序后同一批文件每轮顺序一致，"预算用尽时优先解析哪些"才有确定行为（新文件按名字靠前）。
  out.sort()
  return out
}

// ── 解析单个会话文件 → { day: { model: {in,cached,cwrite,out,reason,total,turns} } } ──
// rl/rlTs 是该文件里时间最新的订阅窗口快照（没订阅 / API-key 计费时为 null）
function parseCodexFile(file) {
  const days = {}
  let model = 'codex'
  let prevTotal = null
  let lastRl = null, rlTs = -1
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (_) { return { days, rl: null, rlTs: 0 } }
  const bump = (day, mk, v) => {
    days[day] = days[day] || {}
    const cur = days[day][mk] || { in: 0, cached: 0, cwrite: 0, out: 0, reason: 0, total: 0, turns: 0 }
    cur.in += v.in; cur.cached += v.cached; cur.cwrite += v.cwrite
    cur.out += v.out; cur.reason += v.reason; cur.total += v.total; cur.turns += v.turns
    days[day][mk] = cur
  }
  for (const line of text.split('\n')) {
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
let memo = null, memoAt = 0
function codexSummary() {
  const now = Date.now()
  if (memo && now - memoAt < 5000) return memo
  const home = codexHome()
  if (!home) {
    memo = { ok: false, error: '未找到 Codex 目录（$CODEX_HOME 或 ~/.codex）' }
    memoAt = now
    return memo
  }
  const cache = readCodexCache()
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
    try { st = fs.statSync(f) } catch (_) { continue }
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

  // 单轮预算：本轮只解析 fresh 里的前 N 个 / 前 X 字节，其余留到下一轮。
  // 注意「留到下一轮」必须能在下一轮被优先处理，所以本轮未解析的一律不写缓存指纹，
  // 下轮它们仍在 fresh 里、且排在已被 reuse 的那些之前。
  let roundFiles = 0, roundBytes = 0, deferred = false
  for (const [f, st] of fresh) {
    if (roundFiles >= CODEX_MAX_ROUND_FILES || roundBytes + st.size > CODEX_MAX_ROUND_BYTES) {
      deferred = true
      pendingCount++
      const prev = cache.files[f]
      if (prev) keep[f] = prev // 有旧结果就先用旧的，至少不丢历史数据
      continue
    }
    const parsed = parseCodexFile(f)
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
  // 近 7 天明细
  const days7 = []
  for (let i = 0; i < 7; i++) {
    const d = dayAdd(today, -i)
    days7.push({ date: d, tokens: (byDay[d] && byDay[d].tokens) || 0, turns: (byDay[d] && byDay[d].turns) || 0 })
  }
  memo = {
    ok: true, home, sessions: files.length, changed,
    // 超大被跳过的文件数，以及本轮预算用尽未扫完（下轮补扫）
    skipped, deferred,
    todayTokens, monthTokens, totalTokens,
    outTokens, reasonTokens, cachedTokens, turns,
    days7, byModel,
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

// 清缓存（设置页「刷新」按钮调用）
function clearCodexCache() {
  memo = null
  memoAt = 0
  try { utools.dbStorage.removeItem(K.codex) } catch (_) {}
}

module.exports = { codexSummary, clearCodexCache, codexHome }
