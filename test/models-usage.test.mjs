/*
 * refreshModels 的「今日已用」估算回归测试（node --test，零依赖）。
 *
 * ⚠️ 盯的是与全局账本 keyChanged 同根因、但**这条链路漏掉**的漏洞（2026-09-28 修）：
 *    多厂商模型的今日已用按「上次余额 − 本次余额」估算（插件拦不到对话）。
 *    用户在设置页**直接改某个模型的 API Key**（模型 id 不变、没有新建条目）时，
 *    两边余额来自**不同账户**、根本不可比：
 *      - 新 Key 余额更高 → 差值为负，不累加，看不出问题（这也是漏掉它的原因）
 *      - 新 Key 余额更低 → 差值被判成正消费，**凭空记出一笔巨额「今日已用」**，
 *        且它会一直累加进当天数字，挂件上带 ~ 标记显示——用户以为今天花了这么多。
 *    修法：状态里存该模型密钥的指纹（keyId），换 Key 时只重置基准、不记差额。
 *
 * 为什么必须打桩测、而不是测纯函数：判据嵌在 refreshModels 的异步循环里
 * （读配置 → 请求 → 比对指纹 → 写状态），拆出来就得复制一遍流程，测的就不是真链路了。
 * api.js 顶层 require 了 log.js（→ utools.getPath），所以先挂桩再 require。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRequire } from 'node:module'

// ── utools 桩：需要一个能读写的内存存储，refreshModels 全程要读配置/密钥/写模型状态 ──
const mem = new Map()
const store = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, v) },
  removeItem: (k) => { mem.delete(k) },
}
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: store,
  dbCryptoStorage: store,
}

const require = createRequire(import.meta.url)
const api = require('../public/preload/lib/api.js')
const constants = require('../public/preload/lib/constants.js')
const { K } = constants

// ── 夹具 ──
const MODEL_ID = 'm1'
const KEY_OLD = 'sk-old-key-aaaa'
const KEY_NEW = 'sk-new-key-bbbb'

// 模型条目走配置（readConfig 会过 normModels 归一化，这里给最小可用集）
function seedConfig() {
  store.setItem(K.config, {
    models: [{
      id: MODEL_ID, tpl: 'custom', name: '测试模型', kind: 'balance',
      currency: 'CNY', auth: 'bearer',
      url: 'https://example.test/balance', baseUrl: '', path: 'balance',
    }],
  })
}
function seedKey(key) {
  store.setItem(K.secrets, { apiKey: '', platformToken: '', models: { [MODEL_ID]: key } })
}
function seedModelState(state) {
  store.setItem(K.models, state)
}
function modelState() {
  return store.getItem(K.models) || {}
}

// fetch 打桩：返回固定余额（refreshModels → fetchModelBalance → fetchModelJson 走全局 fetch）
function stubFetch(balance) {
  const saved = globalThis.fetch
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ balance: balance }),
  })
  return () => { globalThis.fetch = saved }
}

// 每条用例前清干净：模型状态与密钥是跨用例串联的（同一次运行里共享 mem）
test.beforeEach(() => {
  mem.clear()
  seedConfig()
})

test('refreshModels：换 Key（模型 id 不变）后不把两边余额差记成今日已用（回归：会凭空冒出巨额用量）', async () => {
  const today = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const todayStr = today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate())

  // 上一轮：旧 Key，余额 100，今天已用 3
  seedKey(KEY_OLD)
  seedModelState({
    [MODEL_ID]: {
      at: Date.now(), date: todayStr, currency: 'CNY',
      balance: 100, todayUsage: 3, prevBalance: 100,
      keyId: require('../public/preload/lib/store.js').keyFingerprint(KEY_OLD),
    },
  })

  // 本轮：换了新 Key，新账户余额只有 10 —— 若不认指纹，会记出 100 - 10 = 90 的假用量
  seedKey(KEY_NEW)
  const restore = stubFetch(10)
  try {
    await api.refreshModels([MODEL_ID], true)
  } finally {
    restore()
  }

  const cur = modelState()[MODEL_ID]
  assert.equal(cur.balance, 10, '余额照常刷新（换 Key 只影响用量估算，不该影响展示余额）')
  assert.equal(cur.todayUsage, 0, '换 Key 后两边余额不可比，今日已用必须归零、不能记 90 的假账')
  assert.equal(cur.prevBalance, 10, '基准要重置成新 Key 的余额，作为下一轮比较起点')
})

test('refreshModels：同一 Key 内正常累计余额差（换 Key 防护不能把正常记账一并挡掉）', async () => {
  const store_ = require('../public/preload/lib/store.js')
  const today = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const todayStr = today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate())

  seedKey(KEY_OLD)
  seedModelState({
    [MODEL_ID]: {
      at: Date.now(), date: todayStr, currency: 'CNY',
      balance: 100, todayUsage: 3, prevBalance: 100,
      keyId: store_.keyFingerprint(KEY_OLD),
    },
  })

  const restore = stubFetch(92) // 同一账户，余额从 100 掉到 92 = 花了 8
  try {
    await api.refreshModels([MODEL_ID], true)
  } finally {
    restore()
  }

  const cur = modelState()[MODEL_ID]
  assert.equal(cur.todayUsage, 11, '同一 Key 内 3 + 8 = 11，正常记账不能被防护误伤')
})

test('refreshModels：老状态没有 keyId 时只补记录、不重置用量（升级不丢当天已有数字）', async () => {
  const store_ = require('../public/preload/lib/store.js')
  const today = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const todayStr = today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate())

  // 老版本写的状态：没有 keyId 字段
  seedKey(KEY_OLD)
  seedModelState({
    [MODEL_ID]: {
      at: Date.now(), date: todayStr, currency: 'CNY',
      balance: 100, todayUsage: 7, prevBalance: 100,
    },
  })

  const restore = stubFetch(95) // 假设未换 Key，掉 5
  try {
    await api.refreshModels([MODEL_ID], true)
  } finally {
    restore()
  }

  const cur = modelState()[MODEL_ID]
  assert.equal(cur.todayUsage, 12, '首次见到 keyId 时不能当成「换 Key」，7 + 5 = 12')
  assert.equal(cur.keyId, store_.keyFingerprint(KEY_OLD), '这一轮要把指纹补记下来，供下次比对')
})
