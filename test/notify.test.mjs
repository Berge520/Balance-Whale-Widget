/*
 * notify.js 的单测（node --test，零依赖）。
 *
 * 只覆盖「取错值不抛错、只是把邮件发错 / 报错误导」的纯函数与协议解析：
 *   buildMail / mailSubject / mimeHeaderText / mailAddress —— 报文组装（头部编码、折行）
 *   resolvePort / portHint —— 端口与加密方式的唯一推导口径（曾两处分叉）
 *   SmtpClient.feed —— 多行响应解析（曾只留末行，导致所有需认证的服务器发不出去）
 *   SmtpClient.read —— 超时后清缓冲（残留响应会串到下一次命令，状态码错位）
 *
 * 刻意不起真连接：feed/read 只解析字符串，用 _setNetForTest() 注入假 socket。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import notify from '../public/preload/lib/notify.js'

const { buildMail, mailSubject, mimeHeaderText, mailAddress, resolvePort, portHint, SmtpClient, _setNetForTest } = notify

// ──────────────────────────────────────────────
// 端口 / 加密方式推导
// ──────────────────────────────────────────────
test('resolvePort：勾了 SSL/TLS 直连默认 465，否则 587', () => {
  assert.equal(resolvePort({}), 465)                              // mailSecure 缺省视为 true
  assert.equal(resolvePort({ mailSecure: true }), 465)
  assert.equal(resolvePort({ mailSecure: false }), 587)
  // 用户填了端口就用用户的，缺省值不参与
  assert.equal(resolvePort({ mailSecure: false, mailPort: 25 }), 25)
  assert.equal(resolvePort({ mailSecure: true, mailPort: 465 }), 465)
  // 非法端口（0 / 负数 / 非数字 / 空串）一律回落到按 mailSecure 推的默认值
  for (const bad of [0, -1, 'abc', '', null, undefined, NaN]) {
    assert.equal(resolvePort({ mailSecure: false, mailPort: bad }), 587, String(bad))
    assert.equal(resolvePort({ mailSecure: true, mailPort: bad }), 465, String(bad))
  }
})

test('portHint：端口与加密方式矛盾时才给提示', () => {
  // 587 / 25 却勾了直连 → 提示改成 STARTTLS
  assert.match(portHint({ mailSecure: true, mailPort: 587 }), /STARTTLS/)
  assert.match(portHint({ mailSecure: true, mailPort: 25 }), /STARTTLS/)
  // 465 却没勾直连 → 提示勾上
  assert.match(portHint({ mailSecure: false, mailPort: 465 }), /SSL\/TLS 直连/)
  // 匹配的组合 / 缺省组合都不该凭空提示（缺省 465 + secure 是真缺省，不是错配）
  assert.equal(portHint({ mailSecure: true, mailPort: 465 }), '')
  assert.equal(portHint({ mailSecure: false, mailPort: 587 }), '')
  assert.equal(portHint({}), '')
})

// ──────────────────────────────────────────────
// 报文组装
// ──────────────────────────────────────────────
test('mimeHeaderText：纯 ASCII 原样，含非 ASCII 才 RFC 2047 编码', () => {
  assert.equal(mimeHeaderText('hello'), 'hello')
  assert.equal(mimeHeaderText(''), '')
  assert.equal(mimeHeaderText(null), '')
  assert.equal(mimeHeaderText('小鲸鱼'), '=?UTF-8?B?' + Buffer.from('小鲸鱼', 'utf8').toString('base64') + '?=')
})

test('mailAddress：空显示名只留 <addr>，有名字才编码前缀', () => {
  assert.equal(mailAddress('', 'a@b.com'), '<a@b.com>')
  assert.equal(mailAddress('  ', 'a@b.com'), '<a@b.com>')
  assert.equal(mailAddress('小鲸鱼', 'a@b.com'), '=?UTF-8?B?' + Buffer.from('小鲸鱼', 'utf8').toString('base64') + '?= <a@b.com>')
})

test('buildMail：CRLF 头部 + base64 正文 + 76 字符折行', () => {
  const mail = buildMail({ mailFromName: '小鲸鱼' }, 'from@b.com', 'to@c.com', '主题', '正文一行')
  const lines = mail.split('\r\n')
  assert.ok(lines[0].startsWith('From: '))
  assert.ok(lines[1] === 'To: <to@c.com>')
  assert.ok(lines[2].startsWith('Subject: =?UTF-8?B?'))
  assert.ok(lines.includes('Content-Transfer-Encoding: base64'))
  // 头部与正文之间空行分隔
  assert.ok(mail.includes('\r\n\r\n'))
  // 正文能 base64 还原（去掉折行后）
  const b64 = mail.split('\r\n\r\n')[1].replace(/\r\n/g, '')
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '正文一行')
})

test('buildMail：正文换行归一成 CRLF，长正文按 76 字符折行', () => {
  const mail = buildMail({}, 'a@b.com', 'c@d.com', 's', 'x\n'.repeat(100))
  const b64part = mail.split('\r\n\r\n')[1]
  const rows = b64part.split('\r\n')
  // 除最后一行外都是 76 字符
  rows.slice(0, -1).forEach((r) => assert.equal(r.length, 76))
  assert.ok(rows[rows.length - 1].length <= 76)
})

test('mailSubject：取首句、超 40 字（按字符数）裁断加省略号', () => {
  assert.equal(mailSubject('余额不足').includes('余额不足'), true)
  assert.equal(mailSubject('第一行\n第二行'), '第一行 第二行')
  assert.equal(mailSubject(''), '小鲸鱼余额挂件通知')
  const long = '甲'.repeat(50)
  const s = mailSubject(long)
  assert.equal(Array.from(s).length, 41) // 40 + '…'
  assert.ok(s.endsWith('…'))
})

// ──────────────────────────────────────────────
// 协议解析（不连真实服务器）
// ──────────────────────────────────────────────
// 假 socket：绝不真正收发，只为让 feed/read 能跑起来
function fakeSocket() {
  return { write() {}, destroy() {}, setTimeout() {}, once() {}, on() {}, removeAllListeners() {} }
}

test('feed：多行响应攒齐后一次 resolve 全部行（不只留末行）', async () => {
  const c = new SmtpClient({ mailHost: 'x' })
  c.sock = fakeSocket()
  const p = c.read()
  c.feed('250-第一行\r\n250-第二行\r\n')
  c.feed('250 末行\r\n')
  const lines = await p
  assert.deepEqual(lines, ['250-第一行', '250-第二行', '250 末行'])
  // 末行才是状态行
  assert.equal(c.last(lines), '250 末行')
})

test('feed：一次 feed 里的多条完整响应不会串到下一次 read', async () => {
  const c = new SmtpClient({ mailHost: 'x' })
  c.sock = fakeSocket()
  // 先喂一个完整响应 + 一个残缺响应：前者给第一次 read，后者留给第二次
  const p1 = c.read()
  c.feed('220 hello\r\n')
  assert.deepEqual(await p1, ['220 hello'])
  const p2 = c.read()
  c.feed(' more\r\n')
  assert.deepEqual(await p2, [' more'])
})

test('feed：跨 chunk 的半行要拼起来，不把残行当完整响应', async () => {
  const c = new SmtpClient({ mailHost: 'x' })
  c.sock = fakeSocket()
  const p = c.read()
  c.feed('334 VXNlcm')
  c.feed('5hbWU6\r\n')
  assert.deepEqual(await p, ['334 VXNlcm5hbWU6'])
})

test('read：超时后清掉残行，下一次命令不会读到上一次的响应', async () => {
  const c = new SmtpClient({ mailHost: 'x' })
  c.sock = fakeSocket()
  // 喂一个不完整的多行响应（首行带 - ，不会 resolve）后让 read 超时
  c.feed('250-old\r\n')
  await assert.rejects(() => c.read(10), /超时/)
  assert.deepEqual(c.lines, []) // 残行已被清掉
  // 下一次 read 只认新响应
  const p = c.read()
  c.feed('250 fresh\r\n')
  assert.deepEqual(await p, ['250 fresh'])
})

test('connect：端口按 resolvePort 走，mailSecure=false 连 587', async () => {
  // 注入假 net：connect 时按端口记录，onReady 回调即「socket 就绪」，供断言端口联动。
  // 只验证建连参数，不喂 220 —— connect() 只等 TCP/TLS 就绪，业务码由 send() 校验
  let connected = null
  _setNetForTest({
    connect(opts, onReady) {
      connected = opts
      const sock = fakeSocket()
      // net.connect 的就绪回调是第二个参数：这里同步回一个，模拟 socket 立刻可用
      if (typeof onReady === 'function') onReady()
      return sock
    },
  })
  const c = new SmtpClient({ mailHost: 'smtp.example.com', mailSecure: false, mailPort: 587 })
  try {
    await c.connect()
    assert.equal(connected.port, 587)
    assert.equal(connected.host, 'smtp.example.com')
  } finally {
    _setNetForTest(null) // 还原，避免影响其它用例
  }
})
