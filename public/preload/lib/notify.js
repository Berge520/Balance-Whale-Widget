/*
 * 通知统一出口（CommonJS）：系统通知（utools.showNotification）+ 邮件通知（SMTP 直发）。
 *
 * 为什么要有这一层：原先各处（余额预警 / 预算 / 波动 / 峰谷 / 穿透 / 计时 / 更新提示）各自
 * 直接调 utools.showNotification，新增渠道就必须在七八个地方各改一遍。现在全部收口到 notify()，
 * 渠道开关只在配置里加，调用方不用知道有几种渠道。
 *
 * 两条铁律（沿用原有语义）：
 *  - 免打扰时段由调用方判断（notifyDaily / notifyNow / notifyModelLow 在进入前就 return），
 *    这一层不重复判断，避免「免打扰只静默系统通知、邮件却照发」的歧义。
 *  - 邮件失败绝不影响主流程：整条发送链丢进 Promise，错误只 logErr 留痕。
 *    （提醒功能本身是副作用，不能因为 SMTP 连不上就让余额刷新这类主流程失败。）
 */
const net = require('net')
const tls = require('tls')
const { logErr } = require('./log')
const { K } = require('./constants')

// 单测注入点：SmtpClient 正常只碰 net/tls，但 feed() 这类「纯解析」逻辑不该为了可测
// 就去起真连接。测试用 _setNetForTest() 换成假 socket，跑完传 null 还原。
let netImpl = net

// ──────────────────────────────────────────────
// 系统通知
// ──────────────────────────────────────────────
// 参数 title 保留但基本用不上：uTools 显示的是「插件名 + 正文」，body 才是用户看到的内容。
// 第二个参数是客户端标识（与全项目一致用 'whale'）。
function notifySystem(text) {
  const t = String(text == null ? '' : text).trim()
  if (!t) return false
  try {
    utools.showNotification(t, 'whale')
    return true
  } catch (err) {
    logErr('[whale][notify] 系统通知失败', err && err.message)
    return false
  }
}

// ──────────────────────────────────────────────
// 邮件通知（SMTP）
// ──────────────────────────────────────────────
const SMTP_TIMEOUT_MS = 15000 // 单次会话总超时：SMTP 卡住时不能让挂件一直等
const SMTP_STEP_MS = 8000     // 单步等待响应超时

function num(v, dft) {
  const n = Number(v)
  return isFinite(n) && n > 0 ? n : dft
}

// 端口与「SSL/TLS 直连」的**唯一**推导口径。connect()（决定一上来是不是裸 TLS）与
// send()（决定要不要 STARTTLS 升级）必须问同一个函数 —— 早先两处各写一个 default
// （`useTls ? 465 : 587` 与固定 `587`），端口缺失 + mailSecure 为真时会分叉：
// connect() 连 465 走裸 TLS，send() 却按 587 的语境判 STARTTLS，两边对「怎么加密」的理解不一致。
// 端口有效时（UI 恒带端口）两处本就等价，这里统一是为了去掉这个隐性分叉。
function resolvePort(cfg) {
  const secure = cfg.mailSecure !== false
  return num(cfg.mailPort, secure ? 465 : 587)
}

// 端口与加密方式明显矛盾时给出可读提示，而不是把一个 TLS 层的原始报错丢给用户。
// 587/25 是「明文 + STARTTLS 升级」的端口，勾了「SSL/TLS 直连」会直接 TLS 握手失败；
// 反之 465 是 implicit TLS 端口，取消勾选后走明文会连不上。仅提示不够就纠偏：
// 这里只做**提示**（不改用户填的值），让用户自己确认 —— 猜着改用户的端口更危险。
function portHint(cfg) {
  const secure = cfg.mailSecure !== false
  const port = resolvePort(cfg)
  if (secure && (port === 587 || port === 25)) {
    return '（提示：587 / 25 端口一般配合「STARTTLS 升级」使用，请取消勾选「SSL/TLS 直连」）'
  }
  if (!secure && port === 465) {
    return '（提示：465 端口是 SSL/TLS 直连端口，请勾选「SSL/TLS 直连」）'
  }
  return ''
}

// 邮件正文：正文里都是「余额仅剩 3.20 元」这类短句，标题取首句并按长度裁一下，
// 过长时用「…」收尾（某些邮件客户端对标题换行处理很丑）。
function mailSubject(body) {
  const one = String(body || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean).join(' ')
  const short = Array.from(one).length > 40 ? Array.from(one).slice(0, 40).join('') + '…' : one
  return short || '小鲸鱼余额挂件通知'
}

// RFC 2047 编码头部：SMTP 是 7bit 通道，中文主题不编码会变乱码
function mimeHeaderText(s) {
  const t = String(s == null ? '' : s)
  return /^[\x20-\x7e]*$/.test(t) ? t : '=?UTF-8?B?' + Buffer.from(t, 'utf8').toString('base64') + '?='
}

function mailAddress(name, addr) {
  const a = String(addr || '').trim()
  const n = String(name || '').trim()
  if (!n) return '<' + a + '>'
  return mimeHeaderText(n) + ' <' + a + '>'
}

// 组装 MIME 报文。头部字段的换行一律用 CRLF（SMTP 规范要求）；
// 正文用 base64 编码 + 76 字符折行，这样中英文、长链接都不会触发行长限制。
function buildMail(cfg, from, to, subject, body) {
  const text = String(body == null ? '' : body).replace(/\r?\n/g, '\r\n')
  const b64 = Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')
  return [
    'From: ' + mailAddress(cfg.mailFromName, from),
    'To: ' + mailAddress('', to),
    'Subject: ' + mimeHeaderText(subject),
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
  ].join('\r\n')
}

// 最小 SMTP 客户端：只实现发送一封信需要的命令流（EHLO → AUTH → MAIL/RCPT/DATA → QUIT）。
// 为什么不用 nodemailer：uTools 宿主 preload 是 CommonJS 且「不可压缩混淆」，
// 引入第三方包要额外处理依赖打包；而这里只需要纯文本单收件人，协议本身很短。
// 支持 465（一上来就是 TLS）与 587/25（明文握手后 STARTTLS 升级）两种连接方式。
class SmtpClient {
  constructor(cfg) {
    this.cfg = cfg
    this.sock = null
    this.buf = ''
    this.lines = []
    this.waiter = null
    this.fatal = null
  }

  // 收行：按 CRLF 切分。用「行缓冲」而不是只看当前行 —— 多行响应（EHLO 的能力列表、
  // AUTH 的多个 334 等）里第一行是 `250-xxx`、最后一行才是 `250 xxx`，命令的成败判在末行。
  // 早先只把末行 resolve 出去、把前面的行丢掉，导致 `AUTH LOGIN` 拿到的是
  // `334 VXNlcm5hbWU6` 而不是 `334 `，校验直接判失败 —— 所有需要认证的服务器都发不出去。
  feed(chunk) {
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      this.lines.push(line)
      if (!/^\d{3}-/.test(line) && this.waiter) {
        const w = this.waiter
        this.waiter = null
        const all = this.lines
        this.lines = []
        w.resolve(all)
      }
    }
  }

  // 等一次响应，返回**本次响应的全部行**（调用方需自行取末行判状态码，见 last()）
  read(ms) {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
      const timer = setTimeout(() => {
        if (this.waiter) {
          this.waiter = null
          // 超时后必须清掉已缓冲的行：残留的响应片段会被下一次 cmd() 的第一个 read() 当成
          // 自己的应答，状态码随之错位（报「SMTP 2xx」这类看不懂的错），后续所有校验全部错位
          this.lines = []
          reject(new Error('SMTP 响应超时'))
        }
      }, ms || SMTP_STEP_MS)
      const done = (fn) => (v) => { clearTimeout(timer); fn(v) }
      this.waiter.resolve = done(resolve)
      this.waiter.reject = done(reject)
    })
  }

  // 一次响应里最后一行才是状态行（多行响应中「250-」是延续、「250 」才是结论）
  last(lines) {
    return String((Array.isArray(lines) ? lines[lines.length - 1] : lines) || '')
  }

  // 响应里是否出现某能力/关键字（用于判断服务器是否支持 STARTTLS）
  has(lines, re) {
    return (Array.isArray(lines) ? lines : [lines]).some((l) => re.test(String(l)))
  }

  write(s) {
    this.sock.write(s)
  }

  // 发一条命令并校验响应码：只看**末行**（多行响应的结论行），不匹配时把服务器原话
  // 带进错误，设置页「测试发送」能直接看到原因
  async cmd(text, expect, allow) {
    this.write(text + '\r\n')
    const lines = await this.read()
    const line = this.last(lines)
    const code = Number(line.slice(0, 3))
    if (expect.indexOf(code) < 0 && (!allow || allow.indexOf(code) < 0)) {
      throw new Error('SMTP ' + line)
    }
    return lines
  }

  connect() {
    const cfg = this.cfg
    const useTls = cfg.mailSecure !== false
    const port = resolvePort(cfg)
    const host = String(cfg.mailHost || '').trim()
    return new Promise((resolve, reject) => {
      let settled = false
      const ok = () => { if (!settled) { settled = true; resolve() } }
      const fail = (err) => { if (!settled) { settled = true; reject(err) } }
      const onReady = () => ok()
      // 连接失败时附上「端口与加密方式可能不匹配」的提示：TLS 握手失败的原始报错
      // （如 wrong version number）对用户毫无指向性，而绝大多数情况正是这个错配
      const onErr = (err) => fail(new Error('连接 SMTP 服务器失败：' + (err && err.message ? err.message : err) + portHint(cfg)))
      if (useTls) {
        this.sock = tls.connect({ host: host, port: port, servername: host }, onReady)
      } else {
        this.sock = netImpl.connect({ host: host, port: port }, onReady)
      }
      this.armTimeout(this.sock)
      this.sock.once('error', onErr)
      this.sock.on('data', (c) => { try { this.feed(c.toString('utf8')) } catch (err) { fail(err) } })
    })
  }

  // 给 socket 挂「整次会话」级空闲超时。抽成方法是因为 STARTTLS 升级会换 socket
  // （upgrade() 里 this.sock = next），新 socket 必须重新挂一遍 —— 早先只在 connect()
  // 里设一次，升级后整个 TLS 会话就没有 socket 级兜底了，只剩 read() 的单步超时
  armTimeout(sock) {
    if (!sock) return
    sock.setTimeout(SMTP_TIMEOUT_MS, () => {
      try { sock.destroy(new Error('SMTP 连接超时')) } catch (err) {}
    })
  }

  // 明文连接握手后升级 TLS：升级会换掉 socket 且已缓冲的数据要作废，否则残留的等待者会串行错位
  upgrade() {
    const host = String(this.cfg.mailHost || '').trim()
    const old = this.sock
    return new Promise((resolve, reject) => {
      // 不设 rejectUnauthorized:false —— 那等于放弃证书校验，授权码会被中间人拿到；
      // Node 默认 servername 已按 host 填好 SNI，证书不匹配就该失败并让用户看到原因
      const next = tls.connect({ socket: old, servername: host }, () => resolve(next))
      next.once('error', (err) => reject(new Error('STARTTLS 失败：' + (err && err.message ? err.message : err))))
    }).then((next) => {
      old.removeAllListeners('data')
      old.removeAllListeners('error')
      old.removeAllListeners('timeout')
      this.buf = ''
      this.lines = []
      this.waiter = null
      this.sock = next
      // 新 socket 必须重新挂会话级超时：connect() 挂的是 old，升级后 old 的监听已被摘掉，
      // 若不重挂，整个 TLS 阶段只剩 read() 的单步超时，卡在推送大正文时无人兜底
      this.armTimeout(next)
      next.on('data', (c) => { try { this.feed(c.toString('utf8')) } catch (err) { logErr('[whale][notify] SMTP 收包异常', err && err.message) } })
      next.once('error', (err) => logErr('[whale][notify] SMTP 连接错误', err && err.message))
      // 摘除 old 监听后到 next 就绪之间，old 上后到的错误（如对端在升级瞬间断连）没有监听者，
      // 在 Node 里会升级成 uncaught 直接把宿主 preload 打挂。这里补一个兜底吞掉并留痕
      old.on('error', (err) => logErr('[whale][notify] STARTTLS 旧连接错误', err && err.message))
    })
  }

  async send(from, to, data) {
    await this.connect()
    const greet = this.last(await this.read()) // 220 问候（connect() 只保证 TCP/TLS 就绪，业务码在这里校验）
    if (!/^220/.test(greet)) throw new Error('SMTP ' + greet)

    const ehlo = await this.cmd('EHLO whale-widget', [250])
    // 明文连接且服务器支持 STARTTLS 时升级，避免正文与授权码走明文。
    // 排除 25：传统明文端口上做 TLS 升级兼容性差，且很多服务器能力表里根本没 STARTTLS。
    // 只在「用户明确关了 SSL/TLS 直连」时才走到这里，所以不必再判 mailSecure。
    // 端口用 resolvePort() 与 connect() 同一口径 —— 两处各写一个 default 会在端口缺失时
    // 分叉（connect 按 465 裸 TLS、这里按 587 判 STARTTLS），对「怎么加密」理解不一致
    const port = resolvePort(this.cfg)
    if (port !== 25 && this.has(ehlo, /STARTTLS/i)) {
      await this.cmd('STARTTLS', [220])
      await this.upgrade()
      await this.cmd('EHLO whale-widget', [250])
    }

    const user = String(this.cfg.mailUser || '').trim()
    const pass = String(this.cfg.mailPass || '')
    if (user) {
      await this.cmd('AUTH LOGIN', [334])
      await this.cmd(Buffer.from(user, 'utf8').toString('base64'), [334])
      await this.cmd(Buffer.from(pass, 'utf8').toString('base64'), [235])
    }

    await this.cmd('MAIL FROM:<' + from + '>', [250])
    await this.cmd('RCPT TO:<' + to + '>', [250, 251])
    await this.cmd('DATA', [354])
    this.write(data + '\r\n.\r\n')
    const fin = this.last(await this.read(SMTP_STEP_MS * 2))
    if (!/^250/.test(fin)) throw new Error('SMTP ' + fin)
    try { this.write('QUIT\r\n') } catch (err) {}
  }

  destroy() {
    try { this.sock && this.sock.destroy() } catch (err) {}
    this.sock = null
  }
}

// 校验 + 发送一封信。返回 {ok:true} 或 {ok:false,error}（设置页「测试发送」直接展示 error）
function sendMail(cfg, subject, body) {
  return new Promise((resolve) => {
    const host = String((cfg && cfg.mailHost) || '').trim()
    const from = String((cfg && cfg.mailFrom) || '').trim()
    const to = String((cfg && cfg.mailTo) || '').trim()
    if (!host) return resolve({ ok: false, error: '未配置 SMTP 服务器' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) return resolve({ ok: false, error: '发件邮箱格式不正确' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return resolve({ ok: false, error: '收件邮箱格式不正确' })
    const mail = buildMail(cfg, from, to, subject || mailSubject(body), body)
    const client = new SmtpClient(cfg)
    // 总超时兜底：任一步卡死时也要 resolve，不能让 Promise 永久挂起
    const guard = setTimeout(() => {
      client.destroy()
      resolve({ ok: false, error: '发送超时' })
    }, SMTP_TIMEOUT_MS)
    client.send(from, to, mail)
      .then(() => { clearTimeout(guard); client.destroy(); resolve({ ok: true }) })
      .catch((err) => {
        clearTimeout(guard)
        client.destroy()
        resolve({ ok: false, error: String((err && err.message) || err) })
      })
  })
}

// ──────────────────────────────────────────────
// 统一出口
// ──────────────────────────────────────────────
// 邮件凭据进的是加密存储（whale:secrets.notifyMail），不是配置 —— 授权码等同密码，
// 不能跟着 config 一起进备份明文。
function mailConfig() {
  try {
    const s = utools.dbCryptoStorage.getItem(K.secrets)
    if (s && typeof s === 'object' && s.notifyMail && typeof s.notifyMail === 'object') return s.notifyMail
  } catch (err) {}
  return {}
}

// 发一封通知邮件。返回 Promise<{ok,error}>，但**自动提醒的调用方不 await**——
// 邮件失败绝不影响主流程，错误只在内部 logErr 留痕（见文件头「两条铁律」）。
// 设置页的「测试通知」要拿结果给用户看，所以这里把 Promise 返回出去。
// cfg 是**完整配置**（readConfig 的结果）：凭据在加密存储、收件人在 config，
// 这里负责把两者合成 sendMail 需要的完整视图。漏合并会让 mailFrom/mailTo 落空、
// 被判成「发件邮箱格式不正确」——自动提醒这条路的错误只 logErr 不弹窗，用户看不到，必须合对
function sendMailAsync(cfg, text) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const mail = Object.assign({}, mailConfig(), {
    mailFrom: c.mailFrom,
    mailTo: c.mailTo,
    mailFromName: c.mailFromName,
  })
  const title = c.mailSubjectPrefix || ''
  return sendMail(mail, mailSubject(title ? title + ' ' + text : text), text).then((r) => {
    if (!r.ok) logErr('[whale][notify] 邮件通知失败', r.error)
    return r
  })
}

function sendSystemAsync(text) {
  try { notifySystem(text) } catch (err) { logErr('[whale][notify] 系统通知异常', err && err.message) }
}

// 所有提醒的统一出口：按配置把一条文案分发到各渠道。
// cfg.notifySystemOn 默认开（沿用旧行为）；cfg.notifyMailOn 默认关（需要用户先配 SMTP）。
// 计时到点由页面侧再包一层 timerNotifyOn / timerMailOn，这里不再单独判。
function notify(text, cfg) {
  const t = String(text == null ? '' : text).trim()
  if (!t) return
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  if (c.notifySystemOn !== false) sendSystemAsync(t)
  if (c.notifyMailOn === true) sendMailAsync(c, t)
}

// 只给单测用的假 socket 注入（见文件头 netImpl 注释）
function _setNetForTest(impl) {
  netImpl = impl || net
}

module.exports = { notify, sendMail, mailSubject, notifySystem, mailConfig, sendMailAsync, buildMail, mimeHeaderText, mailAddress, resolvePort, portHint, SmtpClient, _setNetForTest }
