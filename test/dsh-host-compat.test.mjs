import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const compat = require('../public/preload/lib/dsh-host-compat.js')
const market = require('../public/preload/lib/dsh-market.js')

const {
  manifestFacts,
  deriveHostCompatibility,
  isCompatibleStatus,
  lookup,
  clearCache,
  cacheSize,
  MAX_RANGE_LENGTH,
  UNAVAILABLE,
} = compat

// 判定用的 rangeAllows 就是真实那份 —— 不另造一个简化的假实现，
// 否则「本项目复用 dsh-market.js 的极简 range 解析」这个前提本身就没被验到
const allow = market.rangeAllows

// ──────────────────────────────────────────────
// manifestFacts：从 manifest 抠 DSH 声明
// ──────────────────────────────────────────────

test('manifestFacts：engines.dsh 是首选位置', () => {
  const f = manifestFacts({ engines: { dsh: '^0.1.7-rc.1' } })
  assert.equal(f.engine, '^0.1.7-rc.1')
  assert.deepEqual(f.peers, [])
})

test('manifestFacts：只认 @deepseek-ai/dsh* 的 peer，cordis 之类不算宿主要求', () => {
  const f = manifestFacts({
    peerDependencies: {
      '@deepseek-ai/dsh-llm': '^0.1.7-rc.1',
      '@deepseek-ai/dsh-session': '^0.1.7-rc.1',
      cordis: '^4.0.0',
      schemastery: '^3.1.0',
      '@other/pkg': '^1.0.0',
    },
  })
  assert.deepEqual(f.peers.map((p) => p.name), ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session'])
})

test('manifestFacts：空串 / 空白 range 被丢掉（不能当成一条「声明」参与合取）', () => {
  const f = manifestFacts({
    peerDependencies: { '@deepseek-ai/dsh-llm': '', '@deepseek-ai/dsh-agent': '   ' },
  })
  assert.equal(f, null)
})

test('manifestFacts：一个声明都没有时返 null —— 「没声明」不等于「不兼容」', () => {
  assert.equal(manifestFacts({}), null)
  assert.equal(manifestFacts(null), null)
  assert.equal(manifestFacts({ peerDependencies: { vue: '^3.0.0' } }), null)
})

test('manifestFacts：dsh.engines.dsh 是历史写法，顶层 engines 优先于它', () => {
  assert.equal(manifestFacts({ dsh: { engines: { dsh: '^0.1.5' } } }).engine, '^0.1.5')
  assert.equal(manifestFacts({ engines: { dsh: '^0.1.7' }, dsh: { engines: { dsh: '^0.1.5' } } }).engine, '^0.1.7')
})

// ──────────────────────────────────────────────
// deriveHostCompatibility：合取三态 + 一票否决
// ──────────────────────────────────────────────

test('deriveHostCompatibility：全部声明都容得下 → compatible', () => {
  const facts = {
    engine: '',
    peers: [
      { name: '@deepseek-ai/dsh-llm', range: '^0.1.7-rc.1' },
      { name: '@deepseek-ai/dsh-agent', range: '^0.1.7-rc.1' },
    ],
  }
  const v = deriveHostCompatibility(facts, '0.1.7', allow)
  assert.equal(v.status, 'compatible')
  assert.equal(v.reason, 'peer')
  assert.equal(v.requirement, '^0.1.7-rc.1')
})

test('deriveHostCompatibility：任一条确证不满足 → incompatible（一票否决）', () => {
  const facts = {
    engine: '',
    peers: [
      { name: '@deepseek-ai/dsh-llm', range: '^0.1.7-rc.1' },
      { name: '@deepseek-ai/dsh-agent', range: '^0.2.0' },
    ],
  }
  const v = deriveHostCompatibility(facts, '0.1.7', allow)
  assert.equal(v.status, 'incompatible')
  // 两条都列出来：用户要看到「到底是哪一条卡住了」
  assert.equal(v.requirement, '^0.1.7-rc.1 ∩ ^0.2.0')
})

test('deriveHostCompatibility：unknown 不能覆盖确定的 false（一票否决的前提是「确证」）', () => {
  const facts = {
    engine: '',
    peers: [
      { name: '@deepseek-ai/dsh-llm', range: '这是个认不出的范围' },
      { name: '@deepseek-ai/dsh-agent', range: '^0.2.0' },
    ],
  }
  const v = deriveHostCompatibility(facts, '0.1.7', allow)
  assert.equal(v.status, 'incompatible')
})

test('deriveHostCompatibility：有判不出的、又没有确证不满足的 → unknown', () => {
  const facts = { engine: '', peers: [{ name: '@deepseek-ai/dsh-llm', range: '不是个范围' }] }
  assert.equal(deriveHostCompatibility(facts, '0.1.7', allow).status, 'unknown')
})

test('deriveHostCompatibility：超长 range 直接判不出（异常数据不进比较逻辑）', () => {
  const facts = { engine: '', peers: [{ name: '@deepseek-ai/dsh-llm', range: '^1'.repeat(MAX_RANGE_LENGTH) }] }
  assert.equal(deriveHostCompatibility(facts, '0.1.7', allow).status, 'unknown')
})

test('deriveHostCompatibility：拿不到宿主版本 → unknown + no-host-version（不能假装验过了）', () => {
  const facts = { engine: '^0.1.7', peers: [] }
  for (const hv of ['', '   ', null, undefined]) {
    const v = deriveHostCompatibility(facts, hv, allow)
    assert.equal(v.status, 'unknown')
    assert.equal(v.reason, 'no-host-version')
  }
})

test('deriveHostCompatibility：拉不到是 unavailable，拉到了但没声明是 undeclared —— 两者必须分开报', () => {
  // 拉不到（网络 / 404）：用哨兵 UNAVAILABLE 表达，**不是** null
  assert.equal(deriveHostCompatibility(UNAVAILABLE, '0.1.7', allow).reason, 'unavailable')
  // 拉到了、但包里一条 DSH 声明都没有（manifestFacts 返 null）——
  // 真实例子：@deepseek-ai/dsh-invariants 只 peer 了 @deepseek-ai/cordis
  assert.equal(deriveHostCompatibility(null, '0.1.7', allow).reason, 'undeclared')
  assert.equal(deriveHostCompatibility({ engine: '', peers: [] }, '0.1.7', allow).reason, 'undeclared')
  // 两者都是 unknown，但 reason 不同 —— 界面文案据此分派，混了就会让用户去修不存在的网络问题
  assert.equal(deriveHostCompatibility(UNAVAILABLE, '0.1.7', allow).status, 'unknown')
  assert.equal(deriveHostCompatibility(null, '0.1.7', allow).status, 'unknown')
})

test('deriveHostCompatibility：宿主是 prerelease、声明是 caret 时按 semver 判（这正是本轮补 parseVer 的动机）', () => {
  const facts = { engine: '', peers: [{ name: '@deepseek-ai/dsh-llm', range: '^0.1.7-rc.1' }] }
  // 宿主是 rc.1 本身：容得下
  assert.equal(deriveHostCompatibility(facts, '0.1.7-rc.1', allow).status, 'compatible')
  // 宿主是 rc.2（同一条 prerelease 线上更高）：仍容得下
  assert.equal(deriveHostCompatibility(facts, '0.1.7-rc.2', allow).status, 'compatible')
  // 宿主是 0.1.6（低于下界）：确证不满足
  assert.equal(deriveHostCompatibility(facts, '0.1.6', allow).status, 'incompatible')
})

test('isCompatibleStatus：unknown 不算兼容（把「没声明」混进「兼容」是在骗用户）', () => {
  assert.equal(isCompatibleStatus('compatible'), true)
  assert.equal(isCompatibleStatus('incompatible'), false)
  assert.equal(isCompatibleStatus('unknown'), false)
  assert.equal(isCompatibleStatus(''), false)
})

// ──────────────────────────────────────────────
// lookup：并发 / 缓存 / 失败冷却 / outage 短路
// ──────────────────────────────────────────────

// 造一个可控的 fetch：按 url 后缀 → manifest 或 抛错
function fakeFetch(map, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    if (o.delay) await new Promise((r) => setTimeout(r, o.delay))
    const key = String(url).replace(/^.*\/([^/]+)\/latest$/, '$1')
    const hit = map[key]
    if (hit === undefined || hit === 'ERR') throw new Error('mock 失败')
    return { ok: true, status: 200, text: async () => JSON.stringify(hit) }
  }
  fn.calls = calls
  return fn
}

test('lookup：批量拉取并缓存 —— 第二次不再发请求', async () => {
  clearCache()
  const f = fakeFetch({ 'pkg-a': { engines: { dsh: '^0.1.7' } } })
  const r1 = await lookup(['pkg-a'], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(r1.facts['pkg-a'].engine, '^0.1.7')
  assert.equal(f.calls.length, 1)
  assert.equal(cacheSize(), 1)
  const r2 = await lookup(['pkg-a'], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(r2.facts['pkg-a'].engine, '^0.1.7')
  // 命中缓存 → 请求数不再增加
  assert.equal(f.calls.length, 1)
})

test('lookup：包名去重（同一包在一页里出现两次只拉一次）', async () => {
  clearCache()
  const f = fakeFetch({ 'pkg-b': { engines: { dsh: '^0.1.7' } } })
  await lookup(['pkg-b', 'pkg-b', ' pkg-b '], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(f.calls.length, 1)
})

test('lookup：没有 registry 时一条都不发（拼不出 URL 就不该猜）', async () => {
  clearCache()
  const f = fakeFetch({ 'pkg-c': { engines: { dsh: '^0.1.7' } } })
  const r = await lookup(['pkg-c'], { registry: '', fetchImpl: f })
  // 拼不出 URL = 没拉到，给 UNAVAILABLE 而不是 null（null 是「拉到了但没声明」）
  assert.equal(r.facts['pkg-c'], UNAVAILABLE)
  assert.equal(f.calls.length, 0)
})

test('lookup：单条失败返 UNAVAILABLE 并进冷却，不会在同一页里反复重试', async () => {
  clearCache()
  const f = fakeFetch({ 'bad-pkg': 'ERR' })
  const r1 = await lookup(['bad-pkg'], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(r1.facts['bad-pkg'], UNAVAILABLE)
  assert.equal(f.calls.length, 1)
  // 冷却期内再来一次：不发请求，仍是 UNAVAILABLE
  const r2 = await lookup(['bad-pkg'], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(r2.facts['bad-pkg'], UNAVAILABLE)
  assert.equal(f.calls.length, 1)
})

test('lookup：连续多条失败触发 outage 短路，剩下的不再逐条等超时', async () => {
  clearCache()
  const f = fakeFetch({})
  const names = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10']
  const r = await lookup(names, { registry: 'https://r.example.com', fetchImpl: f, concurrency: 1 })
  for (const n of names) assert.equal(r.facts[n], UNAVAILABLE)
  // 短路生效：请求数 **小于** 包总数（若没短路会正好等于 10）
  assert.ok(f.calls.length < names.length, 'outage 短路未生效，发了 ' + f.calls.length + ' 次请求')
})

test('lookup：混着成功与失败时，成功的照常拿到 facts（不被失败拖累）', async () => {
  clearCache()
  const f = fakeFetch({ 'ok-1': { engines: { dsh: '^0.1.7' } }, 'ok-2': { peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.7-rc.1' } } })
  const r = await lookup(['ok-1', 'no-such', 'ok-2'], { registry: 'https://r.example.com', fetchImpl: f, concurrency: 2 })
  assert.equal(r.facts['ok-1'].engine, '^0.1.7')
  assert.equal(r.facts['ok-2'].peers.length, 1)
  assert.equal(r.facts['no-such'], UNAVAILABLE)
})

test('lookup：manifest 里没有 DSH 声明 → facts 为 null 落缓存，重复查不再联网', async () => {
  clearCache()
  const f = fakeFetch({ 'plain-pkg': { name: 'plain-pkg', version: '1.0.0' } })
  await lookup(['plain-pkg'], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(f.calls.length, 1)
  assert.equal(cacheSize(), 1)
  await lookup(['plain-pkg'], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(f.calls.length, 1)
})

test('lookup：「没声明」不能算作拉取失败 —— 否则连拉 3 个无声明包就误判镜像挂了', async () => {
  clearCache()
  // 5 个包都能拉到，只是都没有 DSH 声明
  const f = fakeFetch({
    p1: { name: 'p1' }, p2: { name: 'p2' }, p3: { name: 'p3' },
    p4: { name: 'p4' }, p5: { name: 'p5' },
  })
  const r = await lookup(['p1', 'p2', 'p3', 'p4', 'p5'], { registry: 'https://r.example.com', fetchImpl: f, concurrency: 1 })
  for (const n of ['p1', 'p2', 'p3', 'p4', 'p5']) assert.equal(r.facts[n], null)
  // 关键：一条都没被短路，5 条全真的发过请求（真失败会被 outage 短路在第 3 条）
  assert.equal(f.calls.length, 5, '「没声明」被误当成失败并触发了 outage 短路')
  // 而且全部落了缓存
  assert.equal(cacheSize(), 5)
})

test('lookup：空输入直接返回空表，不报错也不联网', async () => {
  clearCache()
  const f = fakeFetch({})
  const r = await lookup([], { registry: 'https://r.example.com', fetchImpl: f })
  assert.deepEqual({ ...r.facts }, {})
  assert.equal(f.calls.length, 0)
})

test('「拉到了但没声明」与「拉失败」在判定层必须给出不同的 reason（真 bug 回归）', async () => {
  clearCache()
  // 实测形态：@deepseek-ai/dsh-invariants 的 latest 里只 peer 了 @deepseek-ai/cordis
  // （框架，不是宿主版本），所以 manifestFacts 返 null —— 但它 **确实拉到了**
  const f = fakeFetch({
    'declares-nothing': { name: 'declares-nothing', version: '0.0.1-rc.1', peerDependencies: { '@deepseek-ai/cordis': '^4.0.1-rc.1' } },
    'really-broken': 'ERR',
  })
  const r = await lookup(['declares-nothing', 'really-broken'], { registry: 'https://r.example.com', fetchImpl: f, concurrency: 1 })
  const ok = deriveHostCompatibility(r.facts['declares-nothing'], '0.1.9', allow)
  const bad = deriveHostCompatibility(r.facts['really-broken'], '0.1.9', allow)
  // 两者都是 unknown，但**理由必须不同**：前者是这个包没提要求，后者是我们没拿到
  assert.equal(ok.status, 'unknown')
  assert.equal(ok.reason, 'undeclared', '拉到了但没声明，被误报成拉取失败 —— 界面会让用户去修不存在的网络问题')
  assert.equal(bad.status, 'unknown')
  assert.equal(bad.reason, 'unavailable')
})

test('clearCache：清掉 facts 缓存与冷却 —— 换了 registry 就该立刻重试', async () => {
  clearCache()
  const f = fakeFetch({ 'pkg-d': { engines: { dsh: '^0.1.7' } } })
  await lookup(['pkg-d'], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(cacheSize(), 1)
  clearCache()
  assert.equal(cacheSize(), 0)
  await lookup(['pkg-d'], { registry: 'https://r.example.com', fetchImpl: f })
  assert.equal(f.calls.length, 2)
})
