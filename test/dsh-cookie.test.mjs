/*
 * dsh-cookie.js 的回归测试（node --test，零依赖）
 *
 * 为什么单独测：这条 Cookie 是 dsh 内置浏览器能不能用的唯一开关，而它只是
 * 一段字符串解析 —— 写错了不会抛错，只会「静默注入一条无效 Cookie → 页面全 401」，
 * 在真机上表现得和「uBrowser 不落 Cookie」一模一样，极难分辨。
 * 所以签名串（含 '.'、可能很长）、SameSite / HttpOnly / Max-Age / Expires 这些
 * 必须逐分支钉住，尤其是**过期 / 删除语义**：Max-Age<=0 或 Expires 已过
 * 必须丢弃，否则会往浏览器里塞一条登不上的 Cookie。
 *
 * dsh-cookie.js 零依赖（不 require log / utools），本文件不挂桩即可跑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseSetCookie, parseSetCookies } = require('../public/preload/lib/dsh-cookie.js')

const URL0 = 'http://127.0.0.1:3080/?token=abc'
// 与 2026-11-11 实测响应头同形（value 里含 '.'，签名串很长）
const REAL = 'dsh-auth-VPhEEcLKeqRDBoBalzN2Nm7CnfxKhLE00pKIDWxt1sw=v1.eyJub25jZSI6IngifQ.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'

test('解析真实 Set-Cookie：name / value 按第一个 = 切，签名串不被截断', () => {
  const c = parseSetCookie(REAL, URL0)
  assert.ok(c)
  assert.equal(c.name, 'dsh-auth-VPhEEcLKeqRDBoBalzN2Nm7CnfxKhLE00pKIDWxt1sw')
  assert.equal(c.value, 'v1.eyJub25jZSI6IngifQ.sig')
  assert.equal(c.url, URL0)
  assert.equal(c.path, '/')
  assert.equal(c.httpOnly, true)
  assert.equal(c.sameSite, 'strict')
  assert.equal(c.secure, false)
})

test('Max-Age 换算成绝对过期时间（秒）', () => {
  const before = Math.floor(Date.now() / 1000)
  const c = parseSetCookie(REAL, URL0)
  assert.ok(c.expirationDate >= before + 2592000 - 2)
  assert.ok(c.expirationDate <= before + 2592000 + 2)
})

test('Max-Age<=0 视为删除，丢弃', () => {
  assert.equal(parseSetCookie('a=1; Max-Age=0', URL0), null)
  assert.equal(parseSetCookie('a=1; Max-Age=-1', URL0), null)
})

test('Expires：未来保留、过去丢弃；Max-Age 优先于 Expires', () => {
  const future = new Date(Date.now() + 3600e3).toUTCString()
  const past = new Date(Date.now() - 3600e3).toUTCString()
  assert.ok(parseSetCookie('a=1; Expires=' + future, URL0).expirationDate > 0)
  assert.equal(parseSetCookie('a=1; Expires=' + past, URL0), null)
  // Max-Age 在前：Expires 过期也不影响（RFC 6265 里 Max-Age 优先）
  const c = parseSetCookie('a=1; Max-Age=600; Expires=' + past, URL0)
  assert.ok(c && c.expirationDate > 0)
})

test('SameSite 归一：None→no_restriction，未知/缺省→unspecified', () => {
  assert.equal(parseSetCookie('a=1; SameSite=None', URL0).sameSite, 'no_restriction')
  assert.equal(parseSetCookie('a=1; SameSite=no_restriction', URL0).sameSite, 'no_restriction')
  assert.equal(parseSetCookie('a=1; SameSite=Lax', URL0).sameSite, 'lax')
  assert.equal(parseSetCookie('a=1; SameSite=Weird', URL0).sameSite, 'unspecified')
  assert.equal(parseSetCookie('a=1', URL0).sameSite, 'unspecified')
})

test('属性大小写不敏感，Secure / Path 生效', () => {
  const c = parseSetCookie('a=1; secure; HTTPONLY; PATH=/api', URL0)
  assert.equal(c.secure, true)
  assert.equal(c.httpOnly, true)
  assert.equal(c.path, '/api')
})

test('value 允许为空串；缺 name / 空串一律丢弃', () => {
  assert.equal(parseSetCookie('a=; Path=/', URL0).value, '')
  assert.equal(parseSetCookie('=1; Path=/', URL0), null)
  assert.equal(parseSetCookie('', URL0), null)
  assert.equal(parseSetCookie(null, URL0), null)
})

test('value 里的 = 不被当作新属性', () => {
  const c = parseSetCookie('a=b=c==; Path=/', URL0)
  assert.equal(c.value, 'b=c==')
})

test('parseSetCookies 批量：保留有效、丢弃无效、空输入得空数组', () => {
  const list = parseSetCookies([REAL, 'bad', 'x=1; Max-Age=0'], URL0)
  assert.equal(list.length, 1)
  assert.equal(list[0].name.startsWith('dsh-auth-'), true)
  assert.deepEqual(parseSetCookies(null, URL0), [])
  assert.deepEqual(parseSetCookies([], URL0), [])
})

// 解析器不校验版本（v1 页面 cookie 与 v2 API cookie 都能原样带过），但要确认
// 长 payload（base64 段 + 签名）不被截断或丢弃 —— 截断了就是「注入了却登不上」，
// 在真机上和「uBrowser 不落 Cookie」表现一模一样。这里用页面那条 v1 的真实形态。
// （历史上这条断言的是 /connect 的 v2，并附「只有 v2 能连 ws」的错误结论；
//   2026-11-11 读源码订正：admit() 首选 isAuthenticated（v1），一条 v1 够页面也够 ws。）
test('v1 cookie（GET /?token= 返回）能完整解析，value 不被截断', () => {
  const v1 = 'dsh-auth-VPhEEcLKeqRDBoBalzN2Nm7CnfxKhLE00pKIDWxt1sw=v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6MzA4MCIsImlzc3VlZEF0IjoxNzYyNzk5OTk5OTk5LCJleHBpcmVzQXQiOjE3NjI4ODAwMDB9.c2lnbmF0dXJl; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
  const c = parseSetCookie(v1, 'http://127.0.0.1:3080/')
  assert.ok(c)
  assert.ok(c.value.startsWith('v1.'))
  assert.ok(c.value.endsWith('.c2lnbmF0dXJl'))
  assert.equal(c.sameSite, 'strict')
  assert.equal(c.httpOnly, true)
  assert.equal(c.secure, false)
  assert.ok(c.expirationDate > Date.now() / 1000)
})
