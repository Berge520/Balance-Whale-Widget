/*
 * dsh 认证 Cookie 的解析（纯函数叶子，零依赖、可无 utools 桩单测）。
 *
 * 背景（2026-11-11 实测）：dsh 的 Web UI 鉴权不是「URL 带 token 就放行」，而是
 *   ① GET /?token=xxx → 303，Set-Cookie: dsh-auth-<nonce>=v1.<p>.<s>; HttpOnly; SameSite=Strict; Path=/
 *   ② 之后所有请求（页面静态资源 / /api/* / websocket）都靠这个 Cookie 认证
 * 系统浏览器会乖乖存下 HttpOnly Cookie，uBrowser 的内置会话实测没落地 →
 * 页面外壳能开、所有接口 401 →「设置读取失败 / Failed to fetch / 重新连接中」。
 * 所以打开内置浏览器前由插件自己取一次 Set-Cookie，再用 ubrowser.setCookies 注入。
 *
 * 本模块只做字符串解析：把 Set-Cookie 头解析成 uBrowser 的 CookieDetails 结构。
 * 取数（fetch）在 dsh-web.js 里做 —— 保持这里零 IO、可单测。
 *
 * 不做的事：不校验签名、不判断过期（过期就取不到 Cookie，注入自然失败并回退）。
 */

// SameSite 归一：uBrowser（Chromium）只认这四种，其余（含缺省）一律 unspecified
const SAME_SITE = { strict: 'strict', lax: 'lax', none: 'no_restriction', 'no_restriction': 'no_restriction', 'unspecified': 'unspecified' }

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析一条 Set-Cookie，转成 uBrowser CookieDetails。
 * @param {string} raw  「name=value; Path=/; HttpOnly; SameSite=Strict」这样的一条
 * @param {string} url  该 Cookie 所属页面的地址（CookieDetails 的必填项，用于推导 domain / path）
 * @returns {{name: string, value: string, url: string, path: string, secure: boolean, httpOnly: boolean, sameSite: string, expirationDate?: number} | null}
 *          解析不出 name 或 value 时返回 null（宁可少注入，也不注入脏数据）
 */
function parseSetCookie(raw, url) {
  const text = String(raw == null ? '' : raw)
  const semi = text.indexOf(';')
  // 注意：value 里可能含 '='（签名串），只按第一个 '=' 切 name / value
  const pair = semi < 0 ? text : text.slice(0, semi)
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (!name) return null
  const out = { name: name, value: value, url: String(url || ''), path: '/', secure: false, httpOnly: false, sameSite: 'unspecified' }
  const attrs = semi < 0 ? [] : text.slice(semi + 1).split(';')
  for (const a of attrs) {
    const i = a.indexOf('=')
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase()
    const v = i < 0 ? '' : a.slice(i + 1).trim()
    if (k === 'path' && v) out.path = v
    else if (k === 'secure') out.secure = true
    else if (k === 'httponly') out.httpOnly = true
    else if (k === 'samesite') out.sameSite = SAME_SITE[v.toLowerCase()] || 'unspecified'
    else if (k === 'max-age') {
      const sec = num(v)
      // Max-Age=0 / 负数 = 立刻删除，这种不该注入
      if (sec <= 0) return null
      out.expirationDate = Math.floor(Date.now() / 1000) + sec
    } else if (k === 'expires') {
      const t = Date.parse(v)
      // Expires 优先级低于 Max-Age（RFC 6265），已有 Max-Age 时忽略
      if (out.expirationDate === undefined && Number.isFinite(t)) {
        if (t <= Date.now()) return null
        out.expirationDate = Math.floor(t / 1000)
      }
    }
  }
  return out
}

/**
 * 批量解析（getSetCookie() 的数组直传），丢弃解析失败的条目。
 * @param {string[]} list
 * @param {string} url
 */
function parseSetCookies(list, url) {
  const out = []
  for (const raw of list || []) {
    const c = parseSetCookie(raw, url)
    if (c) out.push(c)
  }
  return out
}

module.exports = { parseSetCookie, parseSetCookies }
