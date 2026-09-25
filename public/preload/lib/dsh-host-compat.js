/*
 * DSH 宿主兼容性检测（参照 dsh-market 的 discovery-compatibility.ts）。
 *
 * 判什么：一个插件声明的 DSH 版本范围（peerDependencies / engines.dsh）是否容得下
 * **当前宿主**的 DSH 版本。三态结论 —— compatible / incompatible / unknown。
 *
 * ⚠️ 为什么本模块能判：目录条目（plugins.json）里**没有** peerDependencies / engines
 *    字段（dsh-market 的 normPlugin 只留展示字段），要判兼容性必须去 npm registry
 *    拉该包 latest 的 manifest。所以这里自带一个有界并发的 manifest 索引。
 *
 * ⚠️ 分工：结论依赖「当前进程拿到的 DSH 版本」，是**动态**的，所以只缓存**原始 facts**
 *    （版本范围数组，24h 内存缓存），绝不缓存结论 —— 否则用户升级 DSH 后界面还按旧宿主判，
 *    全是错的。失败也只进内存冷却，不落盘：「镜像挂一天」不能变成磁盘上一整天的假 undeclared。
 *
 * ⚠️ 为什么用 registry 元数据（`<registry>/<pkg>/latest`）而不是直连 registry.npmjs.org：
 *    本项目其余联网都走用户选的 registry（默认 npmmirror），跟着走才能在内网 / 镜像环境
 *    里也用得上，且不会因为直连 npmjs 在部分网络下超时被判成「不兼容」。
 */
const { logErr } = require('./log')

// manifest 事实的内存 TTL。npm manifest 的声明极少变，24h 足够且能挡住翻页反复拉
const FACTS_TTL_MS = 24 * 60 * 60 * 1000
// 单次 manifest 请求超时。列表翻页要并发拉一批，单条卡住不能拖垮整页
const FETCH_TIMEOUT_MS = 8000
// 并发上限（与 dsh-market DEFAULT_CONCURRENCY 同口径）
const DEFAULT_CONCURRENCY = 8
// facts 缓存条目上限：目录 4000+ 条，翻几页也到不了 5000，超了按插入序淘汰最旧
const MAX_CACHE_ENTRIES = 5000
// 声明范围长度上限：超长的「范围」多半是异常数据，不能让它进比较逻辑
const MAX_RANGE_LENGTH = 256
// 失败冷却（内存）：网络抖一下不该让整页一直重拉；持续的镜像挂掉则进长冷却
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000
const OUTAGE_COOLDOWN_MS = 30 * 1000
// 一份目录里被判定「整源不可用」的阈值（连续这么多条都失败就不再逐条拉）
const OUTAGE_FAILURES = 3

// 只认 DSH 自家的包：目录里的插件还会声明 cordis / schemastery 等，那些不是宿主版本要求
const DSH_PEER_RE = /^@deepseek-ai\/dsh(?:-|$)/

// 「这条声明根本判不了」的探针：一个任何正常范围都不会放行的版本。
// ⚠️ 用 `0.0.0-0`（而非 `0.0.0`）：裸版本范围按 npm 语义只有完全相同才算命中，
//    用 0.0.0 会与「声明就是 0.0.0」这种极端情况混淆
const UNJUDGEABLE_PROBE = '0.0.0-0'

// ──────────────────────────────────────────────
// 纯函数（供 test/dsh-host-compat.test.mjs 直接喂样例）
// ──────────────────────────────────────────────

// 从 npm manifest 里抠出「这个插件对 DSH 的要求」。
//
// 三个来源，优先级从高到低：
//   ① engines.dsh      —— 顶层 engines 里的 dsh 字段
//   ② dsh.engines.dsh  —— 部分插件把版本要求写在自定义 dsh 段里（dsh-market 同此）
//   ③ peerDependencies 里所有 @deepseek-ai/dsh* 的声明
//
// 返回 { engine: string, peers: {name, range}[] }；一个都没有时返回 null
// —— ⚠️ null 的语义是「**没声明**」（不提要求 ≠ 不兼容），与「拉不到 manifest」必须分开
function manifestFacts(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {}
  const engines = m.engines && typeof m.engines === 'object' ? m.engines : {}
  const dshSeg = m.dsh && typeof m.dsh === 'object' ? m.dsh : {}
  const dshEngines = dshSeg.engines && typeof dshSeg.engines === 'object' ? dshSeg.engines : {}
  // ⚠️ 顶层 engines.dsh 优先：它是标准位置，自定义段是历史写法
  const engine = String(engines.dsh || dshEngines.dsh || '').trim()

  const peers = []
  const pd = m.peerDependencies && typeof m.peerDependencies === 'object' ? m.peerDependencies : {}
  for (const name of Object.keys(pd)) {
    // 只留 @deepseek-ai/dsh* —— cordis / schemastery 之类不是宿主版本要求，
    // 混进来会让「装了新版 cordis」被误报成 DSH 不兼容
    if (!DSH_PEER_RE.test(String(name))) continue
    const range = String(pd[name] == null ? '' : pd[name]).trim()
    if (!range) continue
    peers.push({ name: String(name), range: range })
  }

  if (!engine && !peers.length) return null
  return { engine: engine, peers: peers }
}

// 「这条声明根本判不了」的判据。
//
// dsh-market.js 的 rangeAllows 对**认不出**的范围一律放行（保守口径：宁可漏报不误报），
// 于是「放行」有两种成因 —— 「真的满足」与「压根没解析」。用不可能满足的探针反测：
// 探针也被放行 ⇒ 这条范围根本没被解析，不参与合取（否则会把 undeclared 当成 compatible）。
//
// ⚠️ 这是本项目相对 dsh-market 的**主动偏差**：那边自带完整 range 解析，能直接区分
//    「判过」与「认不出」；我们复用 dsh-market.js 那份极简实现，只能靠反测逼近。
//    代价是「一条判不出」会把整条结论压成 unknown —— 这正是我们要的保守方向。
function isUnjudgeable(range, allow) {
  if (String(range || '').length > MAX_RANGE_LENGTH) return true
  return allow(range, UNJUDGEABLE_PROBE) === true
}

// 把逐条判定合取成一个三态结论。
//
// ⚠️ 合取逻辑（照抄 dsh-market 的核心取舍，整套机制里最值得抄的一条）：
//    · 只要有**任一条**被确证不满足 → incompatible（一票否决）
//    · 全部满足                    → compatible
//    · 其余（含 unknown 混在里面）  → unknown，**不能被当兼容用**
//    unknown 绝不覆盖确定的 false：一票否决的前提就是「确证」，其余条能不能判出来
//    都不影响它。
//
// 返回 { status, reason, requirement }
//   status: 'compatible' | 'incompatible' | 'unknown'
//   reason: 'peer' | 'no-host-version' | 'undeclared' | 'unavailable'
//   requirement: 供界面展示的声明原文（多条用 ∩ 连，表明是合取关系）
//
// ⚠️ facts 的三种取值必须分开对待，早先在判定层把它们又混回去了（真 bug）：
//    · facts === UNAVAILABLE（拉不到，网络 / 404）→ reason 'unavailable'
//    · facts === null（**拉到了**，但包里一条 DSH 声明都没有，如 @deepseek-ai/dsh-invariants
//      只 peer 了 @deepseek-ai/cordis）→ reason 'undeclared'
//    两者最终都是 unknown，但**给用户的话完全不同**：一个是「我们没查到」，
//    一个是「这个包压根没提要求」。混成一句会让用户拿着网络错误去怀疑插件。
function deriveHostCompatibility(facts, hostVersion, rangeAllows) {
  const allow = typeof rangeAllows === 'function' ? rangeAllows : function () { return true }
  const hv = String(hostVersion == null ? '' : hostVersion).trim()
  // 拿不到宿主版本：一条都判不了。**不能**当兼容 —— 那等于假装验过了
  if (!hv) return { status: 'unknown', reason: 'no-host-version', requirement: '' }
  // 拉不到（网络 / 404 / 私有包）：与「拉到了但没声明」必须分开报
  if (facts === UNAVAILABLE) return { status: 'unknown', reason: 'unavailable', requirement: '' }
  // 拉到了，但 manifest 里没有任何 DSH 声明（manifestFacts 返 null）
  if (facts == null) return { status: 'unknown', reason: 'undeclared', requirement: '' }

  const verdicts = []
  const ranges = []
  if (facts.engine) {
    ranges.push(facts.engine)
    verdicts.push(isUnjudgeable(facts.engine, allow) ? null : (allow(facts.engine, hv) === false ? false : true))
  }
  for (const p of facts.peers || []) {
    const r = String(p.range || '')
    if (!r) continue
    ranges.push(r)
    verdicts.push(isUnjudgeable(r, allow) ? null : (allow(r, hv) === false ? false : true))
  }
  if (!verdicts.length) return { status: 'unknown', reason: 'undeclared', requirement: '' }

  const requirement = [...new Set(ranges)].join(' ∩ ')
  if (verdicts.some((v) => v === false)) return { status: 'incompatible', reason: 'peer', requirement: requirement }
  if (verdicts.every((v) => v === true)) return { status: 'compatible', reason: 'peer', requirement: requirement }
  // 有 null（判不出）又没有确证不满足 → 只能说不知道
  return { status: 'unknown', reason: 'undeclared', requirement: requirement }
}

// 列表筛选口径：'只看兼容' 只认确证的 compatible。
// ⚠️ unknown 不算兼容 —— 把「没声明」混进「兼容」是在骗用户
function isCompatibleStatus(status) {
  return String(status || '') === 'compatible'
}

// ──────────────────────────────────────────────
// 有界并发的 manifest facts 索引（带内存 TTL + 失败冷却）
// ──────────────────────────────────────────────

// pkgName → { at, facts }（facts 为 null 表示「确认没声明」）
const factsCache = new Map()
// pkgName → 该次失败的重试时间戳
const failures = new Map()
// 本轮被判「整源不可用」的时刻（一条成功即清除）
let outageUntil = 0

// 「拉失败」的哨兵值，用来把两种 null 分开：
//   · FETCH_FAILED —— 这次**没拉到**（网络 / 404）。不该进 facts 缓存（下次翻页该重试），要进冷却。
//   · null         —— 这次**拉到了，但包里没有 DSH 声明**（manifestFacts 返 null）。
//                    这是**有效结论**，必须落缓存，否则每翻一页都要把这一大批包重拉一遍。
// ⚠️ 早先两处都用裸 null，结果「没声明」被当成「拉失败」：不落缓存 + 计入 outage 阈值，
//    连续 3 个无声明包就被判成「镜像挂了」并短路整页（真 bug，单测抓出）。
const FETCH_FAILED = Symbol('fetch-failed')

// 对外表示「我们没能拿到这个包的 manifest」的哨兵值（区别于 null = 拉到了但没声明）。
// ⚠️ 早先 lookup 对失败直接给裸 null，与「拉到了但没声明」撞在一起 —— 界面于是把
//    @deepseek-ai/dsh-invariants（真的没声明）说成「拉取失败（网络 / 镜像问题）」，
//    让用户去修一个根本不存在的网络问题。失败必须能用身份区分出来。
const UNAVAILABLE = Symbol('unavailable')

function cacheGet(name, now) {
  const hit = factsCache.get(name)
  if (!hit) return undefined
  if (now - hit.at > FACTS_TTL_MS) { factsCache.delete(name); return undefined }
  return hit.facts
}

function cachePut(name, facts, now) {
  if (factsCache.size >= MAX_CACHE_ENTRIES) {
    // 按插入序淘汰最旧（Map 保证插入顺序）：目录再大也不会无限涨
    const oldest = factsCache.keys().next()
    if (!oldest.done) factsCache.delete(oldest.value)
  }
  factsCache.set(name, { at: now, facts: facts })
}

// 拉一个包的 manifest 并抠出 facts。
// 成功返回 facts **或 null**（null = 拉到了但没声明，是有效结论）；
// 失败返回 FETCH_FAILED 哨兵，由调用方按 'unavailable' 处理并进冷却。
async function fetchFacts(name, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const now = Date.now()
  if (now < outageUntil) return FETCH_FAILED
  const retryAt = failures.get(name)
  if (retryAt && now < retryAt) return FETCH_FAILED
  const registry = String(o.registry || '').replace(/\/+$/, '')
  if (!registry) return FETCH_FAILED
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  // ⚠️ scoped 包的 `/` 必须编码成 %2F（npm registry 规范）。npmmirror 对裸 `/` 做了宽松
  //    兼容（实测 `/@deepseek-ai/dsh-llm/latest` 也返 200），但换 registry 就可能 404 ——
  //    而 404 在这里会被当成「拉失败」，静默降级成 unknown，用户只会看到「兼容性未知」，
  //    永远看不到自己配的 registry 有问题。
  const url = registry + '/' + name.replace(/\//g, '%2F') + '/latest'
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const body = await res.text()
    if (body.length > MAX_RANGE_LENGTH * 1000) throw new Error('manifest 体积异常')
    const facts = manifestFacts(JSON.parse(body))
    failures.delete(name)
    outageUntil = 0
    return facts
  } catch (err) {
    const why = String((err && err.message) || err || '未知错误')
    logErr('[whale][dsh-host-compat] 拉 manifest 失败', name + ': ' + why)
    failures.set(name, Date.now() + FAILURE_COOLDOWN_MS)
    return FETCH_FAILED
  }
}

// 批量查 facts：收包名数组，返回 { name → facts|null }。
//
// ⚠️ 为什么要批量接口而不是逐条查：列表翻页要一次标 80 条，逐条走 IPC + 逐条 await
//    会把延迟叠成 80 倍。这里并发 8、单条 8s 超时，整页最坏 10 批 × 8s。
// ⚠️ 「整源不可用」短路：连续 OUTAGE_FAILURES 条都拿不到（镜像挂了 / 网断了）时，
//    不必把剩下几十条都等满超时 —— 直接全按 unavailable 返回，并进 30s 冷却。
async function lookup(packages, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const names = []
  const seen = Object.create(null)
  for (const raw of Array.isArray(packages) ? packages : []) {
    const n = String(raw || '').trim()
    if (!n || seen[n]) continue
    seen[n] = true
    names.push(n)
  }
  const out = Object.create(null)
  if (!names.length) return { ok: true, facts: out }
  // facts 缓存不区分 registry：范围声明是包自身的属性，与从哪个镜像读到无关。
  // （registry 只影响「读得到读不到」，读到了就一样，所以换源不必作废缓存）
  const now = Date.now()
  const todo = []
  for (const n of names) {
    const hit = cacheGet(n, now)
    if (hit !== undefined) { out[n] = hit; continue }
    todo.push(n)
  }
  if (!todo.length) return { ok: true, facts: out }

  const concurrency = Number.isFinite(o.concurrency) && o.concurrency > 0 ? Math.floor(o.concurrency) : DEFAULT_CONCURRENCY
  let idx = 0
  let hardFail = 0
  const worker = async () => {
    while (idx < todo.length) {
      const n = todo[idx++]
      // 已判「整源不可用」：这是**没拉到**，给 UNAVAILABLE 而不是 null —— 否则界面
      // 会把这批说成「没声明要求」，而真相是镜像挂了
      if (Date.now() < outageUntil) { out[n] = UNAVAILABLE; continue }
      const facts = await fetchFacts(n, o)
      if (facts === FETCH_FAILED) {
        // 拉不到：不落缓存（下次翻页该重试），计一次失败，到阈值就判定整源不可用
        out[n] = UNAVAILABLE
        hardFail++
        if (hardFail >= OUTAGE_FAILURES) {
          outageUntil = Date.now() + OUTAGE_COOLDOWN_MS
          logErr('[whale][dsh-market] 连续拉取失败，判定本次不可用，暂停 ' + (OUTAGE_COOLDOWN_MS / 1000) + 's')
        }
      } else {
        // 拉到（含「确认没声明」的 null）：这是有效结论，必须落缓存 ——
        // ⚠️ 不落缓存会让「没声明」的包每翻一页就重拉一遍，翻十页就是十倍无谓请求
        out[n] = facts
        hardFail = 0
        cachePut(n, facts, Date.now())
      }
    }
  }
  const workers = []
  for (let i = 0; i < Math.min(concurrency, todo.length); i++) workers.push(worker())
  await Promise.all(workers)
  return { ok: true, facts: out }
}

// 清内存缓存（设置页改 registry 后调用）。facts 本身与 registry 无关，
// 但失败冷却与 outage 必须清 —— 换了源就该立刻重试，不该等冷却走完
function clearCache() {
  factsCache.clear()
  failures.clear()
  outageUntil = 0
}

function cacheSize() { return factsCache.size }

module.exports = {
  FACTS_TTL_MS,
  FETCH_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  MAX_CACHE_ENTRIES,
  MAX_RANGE_LENGTH,
  FAILURE_COOLDOWN_MS,
  OUTAGE_COOLDOWN_MS,
  // 「没拉到」的哨兵：调用方（含设置页）判 unknown 的 reason 时要靠它区分
  // unavailable（我们没拿到）与 undeclared（拿到了，包里没声明）
  UNAVAILABLE,
  manifestFacts,
  deriveHostCompatibility,
  isCompatibleStatus,
  lookup,
  clearCache,
  cacheSize,
}
