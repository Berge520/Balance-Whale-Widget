/*
 * dsh-web.js 的 alive()：端口探活（node --test）
 *
 * 为什么单测这一条：它是「dsh 一直显示启动中」修复里新增的第三条就绪证据 ——
 * 只有它真正能分辨「服务已 listen」与「端口还没起来」，写坏了不会报错，
 * 只会让界面重新回到永远「启动中…」。所以三种结局都要钉：
 * 有服务应答 → true；端口没人听 → false；服务卡住不回 → 超时 false（不能 hang）。
 *
 * 用真实的本地 http server，不打桩：探活本身就是「真的连一下」，mock 掉就失去意义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import { createRequire } from 'node:module'

// ── utools 桩：只为了让 log.js 能定位日志目录（dsh-web 顶层 require 它）──
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}

const require = createRequire(import.meta.url)
const dshWeb = require('../public/preload/lib/dsh-web.js')
const { alive } = dshWeb

// 起一个只回 401 的最小服务：401 是 dsh 未带 token 时的真实响应，也证明「任意状态码都算活」
function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

test('服务能应答（401）→ 视为已就绪', async () => {
  const { srv, port } = await listen((req, res) => { res.statusCode = 401; res.end('unauthorized') })
  try {
    assert.equal(await alive('127.0.0.1', port, 800), true)
  } finally {
    srv.close()
  }
})

test('303 跳转也算活：不跟随跳转，只看「有人应答」', async () => {
  const { srv, port } = await listen((req, res) => { res.statusCode = 303; res.setHeader('Location', '/x'); res.end() })
  try {
    assert.equal(await alive('127.0.0.1', port, 800), true)
  } finally {
    srv.close()
  }
})

test('端口没人监听 → false（服务还没起来，不能误判就绪）', async () => {
  const { srv, port } = await listen(() => {})
  await new Promise((r) => srv.close(r)) // 拿到端口号后立刻关掉，制造「空端口」
  assert.equal(await alive('127.0.0.1', port, 500), false)
})

test('服务接了连接却不响应 → 超时返回 false，不能把轮询挂住', async () => {
  const { srv, port } = await listen(() => { /* 故意不回包 */ })
  try {
    const t = Date.now()
    assert.equal(await alive('127.0.0.1', port, 300), false)
    assert.ok(Date.now() - t < 3000, '超时上限必须生效')
  } finally {
    srv.close()
  }
})

// ──────────────────────────────────────────────
// 「打开 Web UI」注入的 Cookie 必须来自**页面地址**，不能来自 /connect
//   （2026-11-11 用户报 「dsh web authentication required; reopen the URL printed by dsh web.」）
// 源码判据（dsh-client-connection/lib/index.js）：
//   · authenticate() 认 v1 或 v2，但 isAuthenticated() 只判 === COOKIE_PAYLOAD_VERSION(=1)
//   · admit() 先 isAuthenticated(v1)、不过才 authenticateApi(v2)；页面 index 走 authorizeIndex()
//     → isAuthenticated(v1)，不过就 writeUnauthorized() 吐上面那句原文
//   · 两条 cookie **同名**（dsh-auth-<authority>），浏览器里只能留一条 → 注 v2 就把页面打成 401
// 这条用例用一个「只有 / 发 cookie、/connect 不发」的假 dsh 钉住取数路径：走错就是 401 那句话。
test('注入的 Cookie 取自页面地址（/?token=…），不是 /connect', async () => {
  const hit = []
  const { srv, port } = await listen((req, res) => {
    hit.push(req.url)
    if (req.url.startsWith('/?')) {
      res.statusCode = 303
      res.setHeader('Location', './')
      res.setHeader('Set-Cookie', 'dsh-auth-test=v1.eyJ2ZXJzaW9uIjoxfQ.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict')
    } else {
      // /connect 之类：模拟「不发 v1 cookie」——若代码改回打 /connect，就取不到 Cookie
      res.statusCode = 302
      res.setHeader('Location', './api/remote.mux')
    }
    res.end()
  })
  try {
    const url = `http://127.0.0.1:${port}/?token=abc`
    // fetchCookies 不导出，经 openWebIn 的 Cookie 注入链间接验证：这里直接调内部路径不可行，
    // 改为断言「打的是带 token 的页面地址」这一行为契约 —— 用 ubrowser 桩抓 setCookies 的实参。
    let injected = null
    globalThis.utools.ubrowser = {
      setCookies(list) {
        injected = list
        return { goto: () => ({ run: () => Promise.resolve() }) }
      },
      goto: () => ({ run: () => Promise.resolve() }),
    }
    dshWeb.openWebIn(url, 'builtin')
    await new Promise((r) => setTimeout(r, 300)) // 取 Cookie 是异步的
    assert.deepEqual(hit, ['/?token=abc'], '只能打页面地址这一条；打 /connect 会拿到 v2 → 页面 401')
    assert.ok(injected && injected.length === 1, '应从页面响应里取到那条 v1 Cookie')
    assert.ok(injected[0].value.startsWith('v1.'))
  } finally {
    delete globalThis.utools.ubrowser
    srv.close()
  }
})
