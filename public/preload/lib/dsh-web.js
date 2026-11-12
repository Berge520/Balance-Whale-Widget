/**
 * dsh 的 Web UI 打开器（dsh.js 的叶子模块）。
 *
 * 只管「点『打开 Web UI』时把地址弹到哪儿」，不碰 dsh 进程：
 *   builtin  = uTools 内置浏览器窗口（utools.ubrowser）
 *   external = 系统默认浏览器（shellOpenExternal）
 * 由配置 dshOpenIn 决定（归一在 store.js）。
 *
 * 单独成文件的原因：dsh.js 有行数棘轮（白名单只缩不涨），这段建窗逻辑带
 * 单例状态与 uTools 窗口的坑，塞回主文件就得拆别的更核心的东西。
 *
 * ⚠️ 为什么用 ubrowser 而不是 createBrowserWindow（2026-11-11 实测结论）：
 *   定制窗口（createBrowserWindow）第一参只能是**插件包内 html 的相对路径**，
 *   想显示在线页面得先建壳页再导航，而定制窗口实例上探不到可用的导航方法
 *   （win.webContents.loadURL / win.loadURL 都报 is not a function），页面永远停在壳页。
 *   uTools 官方给「用内置浏览器打开网页」的入口是 utools.ubrowser：
 *     utools.ubrowser.goto(url).run(窗口选项)  → 可视化浏览器窗口，直接就是目标页。
 *   注意 run() 返回后再没有后续操作时，窗口若处于隐藏状态会被 uTools 销毁，
 *   所以窗口选项必须显式 show: true（默认即 true，这里写死以免将来被改默认值坑到）。
 *
 * ⚠️ 为什么要先注入 Cookie（2026-11-11 实测）：dsh 的鉴权是「GET /?token=xxx → 303 + Set-Cookie
 *   dsh-auth-<nonce>=…（HttpOnly; SameSite=Strict）」，之后所有页面资源与 /api/* 都认这个 Cookie。
 *   uBrowser 的内置会话没把这条 Cookie 落地 → 外壳能开、接口全 401（设置读取失败 / Failed to fetch）。
 *   所以这里先用 Node 的 http 打一次**页面自己的地址**（`/?token=…`，回 v1 cookie），解析成
 *   CookieDetails 后 ubrowser.setCookies 注入，再 goto。取数目标为什么必须是页面地址而不是
 *   `/connect`，见 fetchCookies 的说明（一句话：页面与 ws 都首选 v1，注 v2 反而 401）。
 *   注入只是「尽力」：拿不到 / 注不进都照常打开（带 token 打开至少还能看到页面外壳），不阻断用户。
 *
 * 依赖方向：只依赖 log + dsh-cookie（+ Node 内置 http + 全局 utools）。不要 require 回 dsh.js（会成环）。
 */
const http = require('http')
const { log, logErr } = require('./log')
const { parseSetCookies } = require('./dsh-cookie')

// 取 Cookie 的等待上限：本机 127.0.0.1 正常 10ms 级返回，2s 还没回就是服务端没起来
const COOKIE_TIMEOUT_MS = 2000

// uBrowser 窗口选项：dsh 的 Web UI 是桌面布局，800×600 太小
const WIN_OPTS = { show: true, title: 'dsh · Web UI', width: 1200, height: 800, center: true }

// 统一上报：本进程日志 + 调用方回调（dsh.js 用它写进设置页那份日志）
function report(done, r) {
  if (r.ok) log('[whale][dsh] 打开 Web UI', r.mode, r.url)
  else logErr('[whale][dsh] 打开 Web UI 失败', r.err || '')
  if (done) {
    try { done(r) } catch (err) {}
  }
}

// 回退系统默认浏览器。返回是否成功（不抛）
function openExternal(url, done, reason) {
  try {
    utools.shellOpenExternal(url)
    report(done, { ok: true, mode: 'external', url: url, err: reason })
    return true
  } catch (err) {
    report(done, { ok: false, mode: 'external', url: url, err: (reason ? reason + '；' : '') + (err && err.message) })
    return false
  }
}

/**
 * 发一次本机 HTTP GET（不跟随跳转），只为了读响应头里的 Set-Cookie。
 *
 * ⚠️ 不能用全局 fetch（2026-11-11 实测）：preload 里 `fetch` 抛错（日志里是 `HTTP 0`），
 *    所以这里直接用 Node 的 http。两者都拿不到「跟随后」的 Set-Cookie，本来也只需首跳。
 */
function getWithHeaders(host, port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'GET' }, (res) => {
      res.resume() // 只读头，body 丢掉
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 端口探活：拿到任意 HTTP 响应（303 / 401 / 404 都算）就证明服务已 listen。
 *
 * ⚠️ 为什么不用 netstat 当唯一证据（2026-11-11 修「dsh 一直显示启动中」）：
 *   netstat + tasklist + wmic 是三次子进程，实测 0.3–1.5s，还都得排 probe.busy 那道闸门；
 *   闸门一卡，就绪判定就永远拿不到新结果。本机 http 往返通常个位数毫秒，
 *   且语义更直接 ——「服务能应答」就是「已就绪」，不依赖 pid / 进程树能否解析出来。
 *
 * 不跟随跳转：跳转响应本身已说明服务在跑。超时 / 连接被拒一律返回 false（不抛）。
 */
function alive(host, port, timeoutMs) {
  return getWithHeaders(host, port, '/', timeoutMs).then((res) => !!res, () => false)
}

/**
 * 取 dsh 的认证 Cookie（可能有多条），解析成 uBrowser 的 CookieDetails 数组。
 * 失败一律返回 []（不抛）：注入不了就按老路子直接打开，让用户至少能看到页面。
 *
 * ⚠️ 必须打**页面地址**（`/?token=…`），不能打 `/connect`（2026-11-11 二次修正，用户报
 *   「dsh web authentication required」）。读 dsh-client-connection 源码确认：
 *   两条 cookie **同名**（`dsh-auth-<authority>`），只能存在一条，而它们被两套校验分别认可 ——
 *     ① `GET /?token=…` 发 version 1：`isAuthenticated()` **只认 v1**，页面 index 与 ws 都靠它；
 *     ② `GET /connect?token=…` 发 version 2（含 operator id）：只被 `authenticateApi()` 认可。
 *   Web UI 的页面与 websocket 都走 `admit()`，而 `admit()` **首选 isAuthenticated（v1）**，
 *   所以一条 v1 就够；注入 v2 反而让页面 index 直接 401（writeUnauthorized 那句原文）。
 *   上一版正是从 `/connect` 取 v2 再打开，才把页面打成 401 —— 别再改回 /connect。
 */
async function fetchCookies(pageUrl) {
  try {
    const u = new URL(pageUrl)
    // 只打页面自己的地址（带 token 的 `/?token=…`）：它回 303 + Set-Cookie。裸地址必然 401，白跑一趟。
    const res = await getWithHeaders(u.hostname, Number(u.port) || 80, u.pathname + u.search, COOKIE_TIMEOUT_MS)
    // Node 的 headers['set-cookie'] 是数组（多条）；只有一条时某些实现给字符串，这里统一成数组
    const raw = res.headers['set-cookie']
    const list = parseSetCookies(Array.isArray(raw) ? raw : raw ? [raw] : [], pageUrl)
    if (!list.length) {
      logErr('[whale][dsh] 没取到认证 Cookie', 'HTTP ' + res.status + '，将以无 Cookie 方式打开')
      return []
    }
    log('[whale][dsh] 取到认证 Cookie', list.map((c) => c.name).join(','))
    return list
  } catch (err) {
    logErr('[whale][dsh] 取认证 Cookie 失败', (err && err.message) || String(err))
    return []
  }
}

// 起 uBrowser：有 Cookie 就先 setCookies 再 goto，否则直接 goto。
// setCookies 与 goto 都在同一条链上（队列按调用顺序执行），所以不会出现「先导航后落 Cookie」。
// setCookies 不可用（旧版 uBrowser）/ 抛错时退回无 Cookie 链，不影响打开。
//
// ⚠️ 打开时**保留 `?token=`**，不要去掉（2026-11-11 二次修正）：上一版注入的是 `/connect` 的 v2，
//   怕带 token 的 `GET /` 再发一条同名 v1 把它顶掉，所以去 token 开裸地址。现在注入的就是 v1
//   （页面与 ws 都认它，见 fetchCookies），再发一次 v1 也不会打架；反过来，万一 uBrowser 没认
//   注入的 Cookie，带 token 打开还能落到页面外壳（接口 401 但界面出得来），裸地址则直接 401 白屏。

// 给内置浏览器页面补 polyfill（2026-11-12 定因，别删）。
//
// ⚠️ uTools 7.8.0 的内置浏览器内核是 **Chromium 108**（页面 UA 实测 Chrome/108.0.5359.215），
//   而 dsh 前端用了 Chrome 116+ 的 `AbortSignal.any`：dsh-api-gateway 的 pumpEvents 在**建流之前**
//   就 `AbortSignal.any([signal, failed.signal])`，108 里它是 undefined → TypeError → 每个 generation
//   立刻失败 → 连接控制器无限重试，左下角就永远停在「重新连接中」。同一地址用 Edge（新内核）打开正常，
//   差别只在浏览器内核版本。
//   取证依据：页面自己的 WebSocket 全部 open 之后 `sent:0`（一帧都没发出就被 close(4000)），
//   而插件另开一条原生 WS 手发 `$events` open 帧能立刻收到 ready —— 服务端与鉴权都没问题。
//
// 注入只能在页面 load 之后（ubrowser 的 evaluate 就这么跑），但连接控制器会一直重试，
// 补上之后下一轮重试自然就通。只补现代 TS/React 应用常见的那几个，不做完整 polyfill 库；
// 全部带存在性判断且用 defineProperty 装（不污染 for...in），重复执行无副作用，
// 将来 uTools 换新内核后这里自动变成空操作。
// evaluate 的入参是函数源码，必须自包含：只能经 window 取页面全局，不能碰模块作用域。
function patchPage() {
  return new Promise((resolve) => {
    const applied = []
    const put = (obj, key, value) => {
      try {
        Object.defineProperty(obj, key, { value: value, configurable: true, writable: true })
      } catch (e) {
        obj[key] = value
      }
    }
    const missing = (test) => {
      try {
        return !test()
      } catch (e) {
        return true
      }
    }
    const apply = (name, install) => {
      try {
        install()
        applied.push(name)
      } catch (e) {}
    }
    // AbortSignal.any 是本次卡死的直接原因；后面几个与它同批（Chrome 119+ / 121+），
    // 同一套现代前端代码很容易一起用到，顺手补齐免得修一个冒一个
    if (missing(() => typeof window.AbortSignal.any === 'function')) {
      apply('AbortSignal.any', () => {
        put(window.AbortSignal, 'any', function (signals) {
          const ctrl = new window.AbortController()
          const list = Array.prototype.slice.call(signals || [])
          const onAbort = (e) => {
            for (let i = 0; i < list.length; i++) {
              if (list[i] && list[i].removeEventListener) list[i].removeEventListener('abort', onAbort)
            }
            ctrl.abort(e && e.target ? e.target.reason : undefined)
          }
          for (let i = 0; i < list.length; i++) {
            const s = list[i]
            if (!s) continue
            if (s.aborted) {
              ctrl.abort(s.reason)
              return ctrl.signal
            }
            s.addEventListener('abort', onAbort, { once: true })
          }
          return ctrl.signal
        })
      })
    }
    if (missing(() => typeof window.Promise.withResolvers === 'function')) {
      apply('Promise.withResolvers', () => {
        put(window.Promise, 'withResolvers', function () {
          let res = null
          let rej = null
          const promise = new window.Promise((a, b) => {
            res = a
            rej = b
          })
          return { promise: promise, resolve: res, reject: rej }
        })
      })
    }
    if (missing(() => typeof window.Symbol.dispose === 'symbol')) {
      apply('Symbol.dispose', () => {
        put(window.Symbol, 'dispose', window.Symbol('Symbol.dispose'))
        put(window.Symbol, 'asyncDispose', window.Symbol('Symbol.asyncDispose'))
      })
    }
    if (missing(() => typeof window.Array.prototype.toSorted === 'function')) {
      apply('Array.prototype.toSorted', () => {
        const copy = (arr) => Array.prototype.slice.call(arr)
        put(window.Array.prototype, 'toSorted', function (cmp) {
          return copy(this).sort(cmp)
        })
        put(window.Array.prototype, 'toReversed', function () {
          return copy(this).reverse()
        })
        put(window.Array.prototype, 'with', function (i, v) {
          const out = copy(this)
          out[i < 0 ? out.length + i : i] = v
          return out
        })
      })
    }
    if (missing(() => typeof window.Object.groupBy === 'function')) {
      apply('Object.groupBy', () => {
        put(window.Object, 'groupBy', function (items, key) {
          const out = {}
          let i = 0
          for (const item of items) {
            const k = key(item, i++)
            if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = []
            out[k].push(item)
          }
          return out
        })
      })
    }
    // 回读连接指示器。⚠️ 不能用裸 `[data-phase]`：会话根节点也带 data-phase（settling / hero / active），
    //   第一版就因此把「已连上」误读成 `hero|`。指示器自己的 data-phase 只可能是 connecting / disconnected
    //   （已连接走 recovered 分支，那个 div 没有 data-phase），按**值**筛最可靠，不依赖 DOM 嵌套位置。
    const indicator = () => {
      try {
        const hit = (root) => {
          if (!root) return null
          const list = root.querySelectorAll('[data-phase]')
          for (let i = 0; i < list.length; i++) {
            const p = list[i].getAttribute('data-phase') || ''
            if (p === 'connecting' || p === 'disconnected') return list[i]
          }
          return null
        }
        const el = hit(window.document.querySelector('[data-slot="sidebar.settings"]')) || hit(window.document)
        if (el) return (el.getAttribute('data-phase') || '') + '|' + (el.getAttribute('aria-label') || '')
        // 查不到 = 指示器没渲染 = 已连上（recovered 分支不带 data-phase）
        return 'gone'
      } catch (e) {
        return 'err'
      }
    }
    // 等够一轮重试（退避上限 10s）再回读：gone = 指示器已消失 = 连上了
    setTimeout(() => {
      resolve({ applied: applied, ua: window.navigator.userAgent, phase: indicator() })
    }, 10000)
  })
}

// 把 polyfill 注入结果落日志（只记 Cookie 名，不落值）。
// run() 的回执是「链上每次 evaluate / cookies 的结果」：单次 evaluate 时可能直接给结果本身，
// 也可能包成数组，两种都接住。phase 为空串 = 指示器已消失 = 页面自己连上了。
function logPatch(res) {
  const list = Array.isArray(res) ? res : [res]
  const patch = list.find((x) => x && typeof x === 'object' && 'applied' in x)
  if (patch) {
    log('[whale][dsh] 内置浏览器 polyfill', JSON.stringify({
      applied: patch.applied,
      phase: patch.phase,
      ua: patch.ua
    }))
  }
  const jar = list.find((x) => Array.isArray(x) && x.some((c) => c && typeof c.name === 'string'))
  if (jar) log('[whale][dsh] 内置浏览器会话 Cookie', jar.map((c) => c && c.name).join(',') || '(空)')
}

function launch(ub, url, cookies) {
  if (cookies.length && typeof ub.setCookies === 'function') {
    try {
      return ub.setCookies(cookies).goto(url).cookies({ url }).evaluate(patchPage).run(WIN_OPTS)
    } catch (err) {
      logErr('[whale][dsh] 注入 Cookie 失败，改为直接打开', (err && err.message) || String(err))
    }
  }
  return ub.goto(url).cookies({ url }).evaluate(patchPage).run(WIN_OPTS)
}

// 用 uTools 内置浏览器（uBrowser）打开。
// run() 是异步的：导航成败要等 Promise，所以这里立刻返回 true（表示「已发起」），
// 最终结论一律经 done 回调；失败则顺手回退系统浏览器——「打开 Web UI」是用户明确点的
// 动作，宁可换个地方打开，也不要只留一句报错。
function openInBuiltin(url, done) {
  const ub = utools.ubrowser
  if (!ub || typeof ub.goto !== 'function') {
    return openExternal(url, done, '当前 uTools 不支持内置浏览器')
  }
  // 取 Cookie 也要等一个来回（本机 10ms 级）：整体挪到异步里，保持「立刻返回 true」的契约。
  // 兜底 catch：runBuiltin 内部已有同步 try，这里只防 callback 参数自身抛错把 Promise 变成未处理拒绝
  fetchCookies(url).then(
    (cookies) => runBuiltin(ub, url, cookies, done),
    (err) => {
      logErr('[whale][dsh] 内置浏览器准备阶段异常', (err && err.message) || String(err))
      runBuiltin(ub, url, [], done)
    }
  )
  return true
}

function runBuiltin(ub, url, cookies, done) {
  // 回执里报原样地址（带 token 那条就是用户从 dsh 输出里看到的地址，便于对照与复制）
  const opened = url
  let req
  try {
    req = launch(ub, url, cookies)
  } catch (err) {
    // 同步抛通常是链式 API 本身不可用，直接换系统浏览器
    logErr('[whale][dsh] 内置浏览器启动失败', err && err.message)
    return openExternal(url, done, err && err.message)
  }
  if (!req || typeof req.then !== 'function') {
    // 老版本 uBrowser 不返 Promise：没法确认结果，按「已发起」算，不额外回退（免得开两遍）
    report(done, { ok: true, mode: 'builtin', url: opened })
    return true
  }
  req.then(
    (res) => {
      logPatch(res)
      report(done, { ok: true, mode: 'builtin', url: opened })
    },
    (err) => {
      // polyfill 注入失败也会走到这里：先留证，再判是不是用户提前关窗
      logPatch(err && err.data)
      // 用户等不及、自己先把窗口关了也会走到这里 —— 此时不该再往系统浏览器弹一次
      if (releaseDone()) return report(done, { ok: true, mode: 'builtin', url: opened })
      const msg = (err && err.message) || String(err)
      logErr('[whale][dsh] 内置浏览器加载页面失败', msg)
      openExternal(url, done, '内置浏览器打开失败')
    }
  )
  return true
}

// 看到过 release() 被调用（release 只在用户关窗时才为真，且每个会话各自一份）
function releaseDone() {
  const ub = utools.ubrowser
  try {
    return !!(ub && ub.release && ub.release())
  } catch (err) {
    // 预期分支：旧版 uBrowser 没有 release / 调用抛错 —— 当作「不是用户关的」（与改造前行为一致）
    return false
  }
}

/**
 * 打开 dsh 的 Web UI，返回要展示给用户的地址；连系统浏览器都打不开时返回 ''。
 * @param {string} url 带 token 的地址（调用方负责兜底成 webUrl()）
 * @param {'builtin'|'external'} mode 用哪个浏览器（调用方从配置取，已归一）
 * @param {(r: {ok: boolean, mode: 'builtin'|'external', url: string, err?: string}) => void} [done]
 *        最终结论回调（内置模式下异步：uBrowser 加载完才知道成败）
 */
function openWebIn(url, mode, done) {
  if (!url) return ''
  if (mode !== 'external' && openInBuiltin(url, done)) return url
  return openExternal(url, done) ? url : ''
}

module.exports = { openWebIn, alive }
