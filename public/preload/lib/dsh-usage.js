/*
 * dsh 本地用量统计（CommonJS，叶子模块）。
 *
 * 数据源全在 $DSH_HOME（默认 ~/.dsh）下，纯本地读取：不联网、不需要凭据。
 *  1. dsh-usage/usage-ledger.json —— dsh-usage 插件的按天账本，口径最好（有按天明细，能画趋势）：
 *     { version: 1, days: { 'YYYY-MM-DD': { provider: { model: UsageTokenTotals } } } }
 *     UsageTokenTotals = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *                          reasoningTokens, calls, cost }
 *     注意 cost 只有 DeepSeek 官方那档有值（单位人民币），其它 provider 恒为 0，因此不会混币种。
 *  2. storages/session_projcache/sessions/*.json —— dsh 核心的会话投影缓存（一个会话一个 JSON）。
 *     账本为空时用它按「会话创建日」聚合：record.identity.createdAt 定日，用量取
 *     rows.tokenUsage.val.totals / rows.costUsage.val.totals，轮次取 rows.sessionStats.val.turns。
 *  3. dsh-usage/provider-snapshots.json —— dsh-usage 抓到的官方余额快照与花费观察窗口，只作参考展示。
 *
 * 口径：账本有数据就用账本，否则回落到会话级聚合 —— 两者不混加，避免同一批 token 被算两遍。
 * 缓存：utools.dbStorage（whale:dshUsage），只存会话文件的 size/mtime 指纹与解析结果，不含任何凭据。
 */
const path = require('path')
const fs = require('fs')
const { K } = require('./constants')
const { log, logErr } = require('./log')
const { num, dayKeyFromTs, dayAdd, homeDir } = require('./util')

// ── dsh 数据目录定位 ──
// 与 dsh 自己（@linxin666/dsh-usage 的 dsh-home.ts）同规则：$DSH_HOME 优先（支持 ~ 展开，
// 相对路径按 cwd 解析），否则 ~/.dsh。
// expand / relative 必须显式传 true（D22）：codexHome 原本不支持这两者，
// 合并后各自的原始口径由调用方声明，避免静默放宽对方语义。
function dshHome() {
  return homeDir({ env: 'DSH_HOME', fallback: '.dsh', expand: true, relative: true })
}

// ── 缓存读写（utools.dbStorage）──
function readCache() {
  try {
    const v = utools.dbStorage.getItem(K.dshUsage)
    if (v && v.files && typeof v.files === 'object') return v
  } catch (_) {}
  return { version: 1, files: {} }
}
function writeCache(c) {
  try { utools.dbStorage.setItem(K.dshUsage, c) } catch (err) { logErr('[whale][dsh-usage] 写缓存失败', err && err.message) }
}

// ── 数据源 1：dsh-usage 的按天账本 ──
function readLedger(home) {
  const p = path.join(home, 'dsh-usage', 'usage-ledger.json')
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (o && o.days && typeof o.days === 'object') return o
  } catch (_) {}
  return null
}

// ── 数据源 3：余额快照 ──
function readSnapshots(home) {
  const p = path.join(home, 'dsh-usage', 'provider-snapshots.json')
  let o = null
  try { o = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) { return { balance: null, spendWatch: null } }
  const provs = (o && o.providers) || {}
  let best = null
  for (const k of Object.keys(provs)) {
    const b = provs[k] && provs[k].balance
    if (!b) continue
    const at = num(b.updatedAt)
    // 同一份余额会同时挂在 deepseek 与 deepseek-official 两个别名下，取最新的那条即可
    if (!best || at > best.at) {
      best = { provider: k, currency: String(b.currency || 'CNY'), amount: num(b.totalBalance), at }
    }
  }
  const sw = o && o.spendWatch
  return {
    balance: best,
    spendWatch: sw && typeof sw === 'object'
      ? { accruedCny: num(sw.accruedCny), since: num(sw.since), lastBalanceCny: num(sw.lastBalanceCny) }
      : null,
  }
}

// ── 数据源 2：会话投影缓存 ──
function listSessionFiles(home) {
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return [] }
  const out = []
  for (const e of ents) if (e.isFile() && /\.json$/i.test(e.name)) out.push(path.join(dir, e.name))
  return out
}

// 会话用的模型名：modelSelection 里的（lastUsed / pending）比 costUsage 里的 'default' 更有信息量
function sessionModel(ms, cu) {
  const cands = [ms.lastUsed && ms.lastUsed.model, ms.pending && ms.pending.model, cu.model]
  for (const c of cands) {
    const s = String(c || '').trim()
    if (s && s !== 'default') return s
  }
  return 'dsh'
}

// 解析单个会话缓存文件 → 该会话的用量聚合（解析失败返回 null，调用方跳过）
function parseSessionFile(file) {
  let o = null
  try { o = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return null }
  const rec = o && o.record
  if (!rec || typeof rec !== 'object') return null
  const rows = rec.rows || {}
  const val = (k) => {
    const r = rows[k]
    return r && r.val && typeof r.val === 'object' ? r.val : {}
  }
  const tu = val('tokenUsage'), cu = val('costUsage'), st = val('sessionStats')
  const ms = val('modelSelection')
  const at = num((rec.identity || {}).createdAt)
  const t = tu.totals || {}
  let inTok = num(t.uncachedInputTokens)
  let cached = num(t.cacheReadTokens) + num(t.cacheWriteTokens)
  let outTok = num(t.outputTokens)
  const ct = cu.totals || {}
  // tokenUsage 全 0 时退回 costUsage 的同类字段（两者口径不完全一致，仅作兜底）
  if (!(inTok + cached + outTok)) {
    inTok = num(ct.input)
    cached = num(ct.cacheRead) + num(ct.cacheWrite)
    outTok = num(ct.output)
  }
  return {
    at,
    day: at ? dayKeyFromTs(at) : '',
    model: sessionModel(ms, cu),
    provider: String(cu.provider || (ms.lastUsed && ms.lastUsed.provider) || '').trim(),
    tokens: inTok + cached + outTok,
    inTok, cached, outTok,
    // reasoning 单独列，不并进总量（与 Codex 卡片口径一致：总量只算四类 token）
    reason: num(ct.reasoning),
    cost: num(ct.cost),
    turns: num(st.turns),
  }
}

// 扫全部会话文件（带增量缓存：只有 size/mtime 变过的才重新解析）
function scanSessions(home) {
  const files = listSessionFiles(home)
  const cache = readCache()
  const keep = {}
  const list = []
  let changed = 0
  for (const f of files) {
    let st = null
    try { st = fs.statSync(f) } catch (_) { continue }
    const prev = cache.files[f]
    let agg = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.agg : null
    if (!agg) {
      agg = parseSessionFile(f)
      changed++
    }
    if (!agg) continue
    keep[f] = { size: st.size, mtimeMs: st.mtimeMs, agg }
    list.push(agg)
  }
  if (changed > 0 || Object.keys(cache.files).length !== Object.keys(keep).length) {
    writeCache({ version: 1, files: keep, builtAt: Date.now() })
  }
  let active = 0
  for (const s of list) if (s.turns > 0 || s.tokens > 0) active++
  return { files: files.length, active, changed, list }
}

// ── 汇总 ──
let memo = null, memoAt = 0
function dshUsageSummary() {
  const now = Date.now()
  if (memo && now - memoAt < 5000) return memo
  const home = dshHome()
  if (!home) {
    memo = { ok: false, error: '未找到 dsh 数据目录（$DSH_HOME 或 ~/.dsh）' }
    memoAt = now
    return memo
  }
  const ledger = readLedger(home)
  const sessions = scanSessions(home)
  const snap = readSnapshots(home)

  // 按天 / 按模型的桶：两个来源共用同一套累加口径（总量只算 input+cacheRead+cacheWrite+output）
  const byDay = {}
  const byModel = {}
  const bump = (day, model, v) => {
    const d0 = byDay[day] || (byDay[day] = { tokens: 0, cost: 0, turns: 0 })
    d0.tokens += v.tokens; d0.cost += v.cost; d0.turns += v.turns
    const bm = byModel[model] || (byModel[model] = { tokens: 0, in: 0, cached: 0, out: 0, reason: 0, turns: 0, cost: 0 })
    bm.tokens += v.tokens; bm.in += v.in; bm.cached += v.cached; bm.out += v.out
    bm.reason += v.reason; bm.turns += v.turns; bm.cost += v.cost
  }

  const useLedger = !!(ledger && ledger.days && Object.keys(ledger.days).length)
  let source = 'none'
  let turnsLabel = '轮'
  let note = ''
  if (useLedger) {
    source = 'ledger'
    turnsLabel = '次调用'
    for (const day of Object.keys(ledger.days)) {
      const provs = ledger.days[day] || {}
      for (const p of Object.keys(provs)) {
        const models = provs[p] || {}
        for (const m of Object.keys(models)) {
          const v = models[m] || {}
          const inTok = num(v.inputTokens)
          const cached = num(v.cacheReadTokens) + num(v.cacheWriteTokens)
          const outTok = num(v.outputTokens)
          bump(day, m, {
            tokens: inTok + cached + outTok,
            in: inTok, cached, out: outTok,
            reason: num(v.reasoningTokens),
            cost: num(v.cost),
            turns: num(v.calls),
          })
        }
      }
    }
  } else if (sessions.list.length) {
    source = 'sessions'
    turnsLabel = '轮'
    for (const s of sessions.list) {
      if (!s.day) continue
      bump(s.day, s.model, {
        tokens: s.tokens, in: s.inTok, cached: s.cached, out: s.outTok,
        reason: s.reason, cost: s.cost, turns: s.turns,
      })
    }
    note = 'dsh-usage 的按天账本暂无数据，以下按会话缓存聚合：一个会话的全部用量记在它开始的那天。'
  } else {
    note = '账本与会话缓存里都没有用量记录：确认 dsh 至少跑过一轮对话，且装了 dsh-usage / cost-meter 这类记账插件。'
  }

  const today = dayKeyFromTs(Date.now())
  const month = today.slice(0, 7)
  let totalTokens = 0, todayTokens = 0, monthTokens = 0
  let costTotal = 0, costToday = 0, costMonth = 0
  for (const d of Object.keys(byDay)) {
    const v = byDay[d]
    totalTokens += v.tokens
    costTotal += v.cost
    if (d === today) { todayTokens += v.tokens; costToday += v.cost }
    if (d.slice(0, 7) === month) { monthTokens += v.tokens; costMonth += v.cost }
  }
  let inTokens = 0, cachedTokens = 0, outTokens = 0, reasonTokens = 0, turns = 0
  for (const m of Object.keys(byModel)) {
    const v = byModel[m]
    inTokens += v.in; cachedTokens += v.cached; outTokens += v.out
    reasonTokens += v.reason; turns += v.turns
  }

  // 近 31 天明细（与 Codex 卡片一致：索引 0 是今天；设置页按 7/14/30 档位取尾部渲染，切档不重扫）
  const days31 = []
  for (let i = 0; i < 31; i++) {
    const d = dayAdd(today, -i)
    const v = byDay[d]
    days31.push({ date: d, tokens: v ? v.tokens : 0, cost: v ? v.cost : 0, turns: v ? v.turns : 0 })
  }

  memo = {
    ok: true, home, source, turnsLabel, note,
    sessions: sessions.files, activeSessions: sessions.active, changed: sessions.changed,
    todayTokens, monthTokens, totalTokens,
    inTokens, cachedTokens, outTokens, reasonTokens, turns,
    // cost 只对 DeepSeek 官方有值、单位为人民币（其它 provider 未定价恒为 0，故不会混币种）
    costToday, costMonth, costTotal, costCurrency: 'CNY',
    days31, byModel,
    balance: snap.balance, spendWatch: snap.spendWatch,
  }
  memoAt = now
  log('[whale][dsh-usage] 统计完成', home, 'source=' + source, sessions.files, '会话', sessions.changed, '变更', todayTokens, '今日 token')
  return memo
}

// 清缓存（设置页「清除缓存并重扫」按钮调用）
function clearDshUsageCache() {
  memo = null
  memoAt = 0
  try { utools.dbStorage.removeItem(K.dshUsage) } catch (_) {}
}

module.exports = { dshUsageSummary, clearDshUsageCache, dshHome }
