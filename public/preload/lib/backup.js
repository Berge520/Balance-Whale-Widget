/*
 * 备份 / 恢复（CommonJS）。
 *
 *  - 导出：把「挂件设置 / 账本 / 窗口位置 / 计时 / 待办与专注统计」打包成一个 JSON 文件。
 *  - 气泡图素材（whale:bubbles 的图片文件）：默认**不导出**（二进制会让 JSON 备份膨胀到几十 MB），
 *    勾选后才以 base64 内嵌进 JSON —— 给「不想再单独导一次素材包」的用户一个一次带走的口子。
 *  - 凭据（API Key / 平台 Token / 各模型密钥 / 邮件 SMTP 凭据）默认**不导出**；勾选后必须设密码，用 scrypt 派生密钥 + AES-256-GCM
 *    加密后才写入文件（文件里没有明文，密码不落盘，忘记密码就无法解密）。
 *  - 导入：先解析出预览（导出时间 / 插件版本 / 包含项），由设置页勾选要恢复的项，再按「同名覆盖」写入。
 *    「按压气泡」的文案 / 队列在 config.bubble 里，跟着「挂件设置」一起进出；气泡图配图走本文件的 bubbles 项。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { log, logErr } = require('./log')
const { PLUGIN_VERSION, K } = require('./constants')
const { errMsg, stamp, writeFileAtomicSync } = require('./util')
const {
  readConfig, writeConfig, readSecrets, writeSecrets,
  readLedger, mergeLedgerHistory, readTimer, writeTimer,
  readAnchor, writeAnchor, readTodo, writeTodo, readFocus, writeFocus,
} = require('./store')
const holidays = require('./holidays')
const bubbles = require('./bubbles')

const KIND = 'balance-whale-widget-backup'
// 来源标记：文件选择器允许任意 *.json，用户很容易误选别的插件的备份。
// 只认 kind 不够 —— 历史版本 / 手改文件的 kind 可能缺失，故另有 APP 作为**缺省**来源标记：
// 有 kind 走 kind，没 kind 才看 app；两者都没有的旧备份交给设置页做二次确认
const APP = 'balance-whale-widget'
const SCHEMA = 1
const MIN_PWD = 6
// scrypt 参数：内存约 16MB / 次，桌面端足够快，也让暴力破解代价高
const SCRYPT = { N: 16384, r: 8, p: 1 }

let pending = null // 已解析、等待确认写入的备份（避免重复读文件）

// ── 凭据加解密（scrypt + AES-256-GCM，带认证标签，改一位就解不开）──
function encryptSecrets(obj, password) {
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(String(password), salt, 32, SCRYPT)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return {
    algo: 'aes-256-gcm', kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'), data: data.toString('base64'),
  }
}
function decryptSecrets(blob, password) {
  if (!blob || typeof blob !== 'object' || !blob.salt || !blob.data) throw new Error('备份里没有可用的凭据')
  const key = crypto.scryptSync(String(password || ''), Buffer.from(blob.salt, 'base64'), 32, {
    N: Number(blob.N) || SCRYPT.N, r: Number(blob.r) || SCRYPT.r, p: Number(blob.p) || SCRYPT.p,
  })
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'))
  d.setAuthTag(Buffer.from(blob.tag, 'base64'))
  const out = Buffer.concat([d.update(Buffer.from(blob.data, 'base64')), d.final()])
  return JSON.parse(out.toString('utf8'))
}

// dsh 相关配置里含机器相关的路径（Node 目录 / 版本），备份不带，
// 免得恢复到另一台机器后指到不存在的目录
function stripDshKeys(cfg) {
  const out = {}
  for (const k of Object.keys(cfg || {})) {
    if (k.indexOf('dsh') !== 0) out[k] = cfg[k]
  }
  return out
}

// ── 导出 ──
// opts = { secrets: boolean, bubbles: boolean, password: string }
function exportBackup(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const withSecrets = o.secrets === true
  const withBubbles = o.bubbles === true
  const password = String(o.password || '')
  if (withSecrets && password.length < MIN_PWD) {
    return { ok: false, error: '导出凭据需要设密码（至少 ' + MIN_PWD + ' 位）' }
  }
  let filePath = ''
  try {
    filePath = utools.showSaveDialog({
      title: '导出小鲸鱼挂件备份',
      defaultPath: path.join(String(utools.getPath('downloads') || ''), 'whale-backup-' + stamp() + '.json'),
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    })
  } catch (err) {
    return { ok: false, error: '无法打开保存对话框：' + errMsg(err) }
  }
  if (!filePath) return { ok: false, canceled: true, error: '' }
  const data = {
    config: stripDshKeys(readConfig()),
    ledger: readLedger(),
    window: readAnchor(),
    timer: readTimer(),
  }
  // 节假日联网覆盖层：有才带（没更新过就不要往备份里塞一个空壳），无则 includes.holidays 为 false
  const holidaysSnap = holidays.snapshot()
  if (holidaysSnap) data.holidays = holidaysSnap
  // 待办与专注统计：用户的长期记录，进备份；但空壳不带 —— 恢复时「备份里没有」与
  // 「备份里是空的」语义不同，前者不该让用户误点后把现有清单清空（has.todo 由有无条目决定）
  const todoSnap = readTodo()
  const todoItems = todoSnap.items || []
  if (todoItems.length) data.todo = todoSnap
  const focusSnap = readFocus()
  const focusDays = Object.keys(focusSnap.days || {}).length
  const focusSessions = (focusSnap.sessions || []).length
  if (focusDays || focusSessions) data.focus = focusSnap
  // 气泡图配图：可选带上（base64 内嵌 JSON）。一张都读不出来时按「没带」处理，不让备份里留个空数组
  let bubbleCount = 0
  let bubbleBytes = 0
  if (withBubbles) {
    const items = bubbles.exportItems()
    const list = []
    for (const it of items) {
      if (!it.data || !it.data.length) continue
      const thumb = it.thumb && it.thumb.length ? it.thumb.toString('base64') : ''
      list.push({
        name: String(it.name || ''), ext: String(it.ext || ''), at: Number(it.at) || 0,
        data: it.data.toString('base64'), thumb: thumb,
      })
      bubbleCount++
      bubbleBytes += it.data.length + (it.thumb ? it.thumb.length : 0)
    }
    if (list.length) data.bubbles = list
    else bubbleCount = 0
  }
  if (withSecrets) {
    try {
      data.secretsEnc = encryptSecrets(readSecrets(), password)
    } catch (err) {
      return { ok: false, error: '加密凭据失败：' + errMsg(err) }
    }
  }
  const payload = {
    kind: KIND,
    app: APP,
    schema: SCHEMA,
    appVersion: PLUGIN_VERSION,
    exportedAt: new Date().toISOString(),
    includes: {
      config: true, ledger: true, window: true, timer: true,
      holidays: !!holidaysSnap,
      bubbles: bubbleCount,
      todo: todoItems.length,
      focus: focusDays,
      secrets: withSecrets ? 'encrypted' : 'none',
    },
    data,
  }
  // 原子写：备份文件是用户拿去换机 / 存档的凭据，半份 JSON 解析不了、也看不出坏了。
  // 临时文件与目标同目录（rename 不跨卷），失败时 writeFileAtomicSync 自己会清掉临时文件
  const w = writeFileAtomicSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
  if (!w.ok) return { ok: false, error: '写入备份文件失败：' + w.error }
  log('[whale][backup] 导出备份', { filePath, withSecrets, bubbles: bubbleCount })
  return { ok: true, path: filePath, withSecrets, bubbles: bubbleCount, bubblesBytes: bubbleBytes, exportedAt: payload.exportedAt }
}

// ── 选择备份文件并解析出预览（不写任何数据）──
function pickBackup() {
  let picked
  try {
    picked = utools.showOpenDialog({
      title: '选择小鲸鱼挂件备份',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['openFile'],
    })
  } catch (err) {
    return { ok: false, error: '无法打开文件对话框：' + errMsg(err) }
  }
  const filePath = Array.isArray(picked) ? picked[0] : picked
  if (!filePath) return { ok: false, canceled: true, error: '' }
  let payload = null
  try {
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    return { ok: false, error: '不是有效的备份文件（读取或解析失败）：' + errMsg(err) }
  }
  // 来源校验：kind 对得上就是本插件的备份（有 kind 时不再看 app，兼容早期的导出）；
  // kind 缺失时退回看 app；两者都没有 → 放行但标 noMark（设置页提示「来源不明」让用户确认）
  // 而不是直接拒 —— 用户在别处手存过一份只有 data 的 JSON 这种老用法还能用。
  // 另：payload 也可能是数组 / null，其上取 .kind 是 undefined，自然走「没给」分支
  // kind 只在「给了且不是本插件的」时候才拒；null / 空串算没给（手改文件常见）
  const kindOk = payload.kind === KIND
  const appOk = payload.app === APP
  if (!kindOk && payload.kind != null && payload.kind !== '') {
    return { ok: false, error: '这不是本插件的备份文件' }
  }
  // 只认非空字符串：JSON 里手写的空串不算「来自另一个应用」，改坏一个字段不该把能用的备份判死
  if (!kindOk && !appOk && typeof payload.app === 'string' && payload.app) {
    return { ok: false, error: '这份备份来自另一个应用（' + payload.app + '），本插件不识别' }
  }
  if (!payload.data || typeof payload.data !== 'object') {
    return { ok: false, error: '这不是本插件的备份文件' }
  }
  if (Number(payload.schema) > SCHEMA) {
    return { ok: false, error: '备份来自更新的插件版本（schema ' + payload.schema + '），请先升级插件' }
  }
  const d = payload.data
  pending = { path: filePath, payload: payload }
  // 预览的「有没有这一项」必须与 applyBackup 的「写不写得进去」同一把尺子：
  // 前者原先只判「对象在不在」，于是勾了「窗口位置」恢复时因锚点不合法被 skip、勾了「气泡图」
  // 恢复时因图片全坏整体放弃 —— 用户勾了个寂寞，还会以为是 bug。故这里复用恢复侧同一批判据
  const anchorOk = validAnchor(d.window)
  const bubbleOk = Array.isArray(d.bubbles) && d.bubbles.some((it) => {
    const raw = it && typeof it === 'object' ? it : {}
    return bubbles.checkImport(String(raw.ext || '').toLowerCase(), Buffer.from(String(raw.data || ''), 'base64')).ok
  })
  return {
    ok: true,
    path: filePath,
    exportedAt: String(payload.exportedAt || ''),
    appVersion: String(payload.appVersion || ''),
    // 无来源标记的旧备份：设置页据此要求二次确认，别让它静默覆盖现有数据
    noMark: !kindOk && !appOk,
    // 凭据要密码才解得开，预览侧无法预判密码对不对；但至少要提醒「勾了就得填密码」——
    // 否则用户勾上凭据、密码留空点恢复，预检整体失败，其余勾选项一项也没写，很迷惑
    noPasswordHint: !!(d.secretsEnc && typeof d.secretsEnc === 'object' && d.secretsEnc.data),
    has: {
      config: !!d.config && typeof d.config === 'object',
      ledger: !!d.ledger && typeof d.ledger === 'object',
      window: anchorOk,
      timer: !!d.timer && typeof d.timer === 'object',
      holidays: !!d.holidays && typeof d.holidays === 'object' && Array.isArray(d.holidays.dates) && d.holidays.dates.length > 0,
      bubbles: bubbleOk,
      // 与恢复侧同判据：有 items 数组就写得进去，哪怕为空（清除现有清单也是用户勾选后的真实意图）
      todo: !!d.todo && typeof d.todo === 'object' && Array.isArray(d.todo.items),
      // 与恢复侧同判据：days 是对象、或 sessions 是非空数组即可写（只留明细的老数据也要能恢复）
      focus: !!d.focus && typeof d.focus === 'object' && (
        (!!d.focus.days && typeof d.focus.days === 'object')
        || (Array.isArray(d.focus.sessions) && d.focus.sessions.length > 0)
      ),
      secrets: !!(d.secretsEnc && typeof d.secretsEnc === 'object' && d.secretsEnc.data),
    },
  }
}
// 只看预览：不需要「选择文件」时也能拿到当前待写入的备份信息
function pendingPreview() {
  if (!pending) return { ok: false, error: '请先选择备份文件' }
  return { ok: true, path: pending.path, exportedAt: String(pending.payload.exportedAt || '') }
}
function clearPending() { pending = null; return { ok: true } }

// 窗口锚点校验（避免把坏数据写进去导致挂件跑到屏幕外）
function validAnchor(a) {
  return !!a && typeof a === 'object'
    && (a.hAnchor === 'left' || a.hAnchor === 'right') && isFinite(Number(a.hDist))
    && (a.vAnchor === 'top' || a.vAnchor === 'bottom') && isFinite(Number(a.vDist))
}

// ── 恢复：按勾选项「同名覆盖」写入 ──
// opts = { config, ledger, window, timer, holidays, bubbles, todo, focus, secrets, password }
function applyBackup(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (!pending) return { ok: false, error: '请先选择备份文件' }
  const d = pending.payload.data || {}
  const want = (k) => o[k] === true
  const applied = []
  const skipped = []
  const errors = []
  // 有写入但不算完整恢复（目前只有「气泡图只写进去一部分」）：ok 要判真，applied 不含它
  let partial = false
  // writeConfig / writeTimer / writeAnchor / mergeLedgerHistory 写失败时**不抛错**（内部 logErr 后返回 false / ok:false），
  // 所以每个分支都必须判返回值：只 try/catch 会把「写失败」记成 applied，
  // 用户看到「恢复成功」但重启后一切照旧 —— 这是全项目唯一会丢数据的路径，宁可报错也不能假报成功。
  const fail = (label, detail) => {
    logErr('[whale][backup] 恢复 ' + label + ' 失败', detail || '')
    errors.push(label + '：写入失败' + (detail ? '（' + detail + '）' : ''))
  }

  // ── 预检（只读）：把「一定写不进去」的情况提前拦下，一个字节都不写 ──
  // 各分支原本按勾选项顺序直接落盘，凭据解密却排在最后：密码错时 config / 账本 / 待办已经写进去了，
  // 用户看到「恢复失败」，重启后却发现一半设置已经变了；而气泡图分支是「先 clearAll 再写」，
  // 备份里的图全不合法时会把现有图清空、再一张也写不回来。
  // 故把「解密凭据」「气泡图可写性」这两件可提前判定的事挪到写盘之前，失败即整体放弃。
  // 预检失败不消耗 pending：用户改对密码 / 换一份备份后可以直接重试，不用重新选文件。
  let secretPlan = null
  if (want('secrets') && d.secretsEnc) {
    try {
      const s = decryptSecrets(d.secretsEnc, String(o.password || ''))
      if (!s || typeof s !== 'object') throw new Error('解密结果异常')
      secretPlan = s
    } catch (err) {
      // AES-GCM 认证标签不匹配 → 密码错或文件被改过
      logErr('[whale][backup] 预检凭据失败（密码错或备份损坏）', errMsg(err))
      const m = '凭据：密码不正确或备份已损坏（' + errMsg(err) + '）'
      return { ok: false, precheck: true, applied: [], skipped: [], errors: [m], error: m }
    }
  }
  let bubblePlan = null
  // 备份里声明了几张：预检会把不合法的剔掉，只比较 bubblePlan 自己的长度发现不了「丢图」
  let bubbleTotal = 0
  if (want('bubbles') && Array.isArray(d.bubbles) && d.bubbles.length) {
    bubbleTotal = d.bubbles.length
    const plan = []
    for (const it of d.bubbles) {
      const raw = it && typeof it === 'object' ? it : {}
      const ext = String(raw.ext || '').toLowerCase()
      const data = Buffer.from(String(raw.data || ''), 'base64')
      // 口径交给 bubbles.checkImport：预检与真正落盘必须用同一把尺子，
      // 否则会出现「预检通过、清空后却一张都写不进」
      if (!bubbles.checkImport(ext, data).ok) continue
      const thumb = Buffer.from(String(raw.thumb || ''), 'base64')
      plan.push({ name: String(raw.name || ''), ext: ext, data: data, thumb: thumb.length ? thumb : null, at: Number(raw.at) || 0 })
    }
    if (!plan.length) {
      logErr('[whale][backup] 预检气泡图失败：备份里的图片均不合法')
      const m = '气泡图素材：备份里的图片均无法写入'
      return { ok: false, precheck: true, applied: [], skipped: [], errors: [m], error: m }
    }
    bubblePlan = plan
  }

  if (want('config')) {
    if (!d.config || typeof d.config !== 'object') skipped.push('config')
    else {
      try {
        // 同名覆盖：备份里有值的键覆盖当前值，没提到的保持现状（writeConfig 会做一遍合法性归一）
        if (writeConfig(Object.assign({}, readConfig(), stripDshKeys(d.config)))) applied.push('config')
        else fail('挂件设置')
      } catch (err) { fail('挂件设置', errMsg(err)) }
    }
  }
  if (want('ledger')) {
    if (!d.ledger || typeof d.ledger !== 'object') skipped.push('ledger')
    else {
      try {
        const hist = d.ledger.history && typeof d.ledger.history === 'object' ? d.ledger.history : {}
        const entries = Object.keys(hist).map((date) => ({ date: date, usage: hist[date] }))
        if (d.ledger.date) entries.push({ date: String(d.ledger.date), usage: d.ledger.todayUsage })
        // 写回后回读核对：setItem 可能「不抛错但也没真存进去」（存储层是异步落盘的），
        // 只判返回值等于相信写入方，这里再读一次确认备份里那条数据确实还在
        const mr = mergeLedgerHistory(entries)
        const back = readLedger()
        const dayIn = !!(d.ledger.date && d.ledger.history
          && typeof d.ledger.history === 'object'
          && Object.prototype.hasOwnProperty.call(d.ledger.history, String(d.ledger.date)))
        const gotToday = back.todayUsage === Math.max(0, Number(d.ledger.todayUsage) || 0)
        if (!mr.ok) fail('账本')
        else if (d.ledger.date && !dayIn && !gotToday) {
          // 备份当天既不在历史里、今日用量也没对上 = 这份账本没真正落进去
          fail('账本', '写入后回读不到备份里的数据')
        } else applied.push('ledger')
      } catch (err) { fail('账本', errMsg(err)) }
    }
  }
  if (want('window')) {
    if (!validAnchor(d.window)) skipped.push('window')
    else {
      try {
        const want = {
          hAnchor: d.window.hAnchor, hDist: Math.max(0, Math.round(Number(d.window.hDist))),
          vAnchor: d.window.vAnchor, vDist: Math.max(0, Math.round(Number(d.window.vDist))),
        }
        if (!writeAnchor(want)) fail('窗口位置')
        else {
          // 回读核对必须绕开 readAnchor：它带内存缓存，写的正是这份缓存，
          // 拿缓存比对等于自己跟自己比，落盘失败也发现不了。故直接从存储读原始值
          const back = utools.dbStorage.getItem(K.win)
          if (back && back.hAnchor === want.hAnchor && back.hDist === want.hDist
            && back.vAnchor === want.vAnchor && back.vDist === want.vDist) applied.push('window')
          else fail('窗口位置', '写入后回读不到备份里的位置')
        }
      } catch (err) { fail('窗口位置', errMsg(err)) }
    }
  }
  if (want('timer')) {
    if (!d.timer || typeof d.timer !== 'object') skipped.push('timer')
    else {
      try {
        if (writeTimer(d.timer)) applied.push('timer')
        else fail('计时')
      } catch (err) { fail('计时', errMsg(err)) }
    }
  }
  if (want('holidays')) {
    // 备份里没有、或结构不可用（dates 不是非空数组）→ skipped（等于「这份备份没带节假日表」）；
    // 只有结构合法却写盘失败才记 error
    const okShape = d.holidays && typeof d.holidays === 'object'
      && Array.isArray(d.holidays.dates) && d.holidays.dates.length > 0
    if (!okShape) skipped.push('holidays')
    else if (holidays.restore(d.holidays)) applied.push('holidays')
    else fail('节假日表')
  }
  if (want('bubbles')) {
    // 配图已在预检里解码、筛过（bubblePlan）；这里只负责「先清后写」——
    // 恢复的语义是「回到备份时的样子」，若只做「补充」会与现有图混在一起，
    // 还可能撞上 8 张上限导致只恢复一半，反而更乱
    if (!bubblePlan) skipped.push('bubbles')
    else {
      try {
        bubbles.clearAll()
        let added = 0
        for (const it of bubblePlan) {
          const r = bubbles.importBuffer(it.name, it.ext, it.data, it.thumb, it.at)
          if (r && r.ok) added++
        }
        // 恢复的语义是「回到备份时的样子」：少一张也算没恢复完整。原先进 applied 只在旁边
        // 加一条 errors，界面就成了「已恢复：…」+ 小字报错，用户只看得到成功。
        // 分母用 bubbleTotal（备份里声明的张数）而不是 bubblePlan 长度 —— 预检剔掉的也在其中
        if (added < bubbleTotal) {
          logErr('[whale][backup] 恢复气泡图有 ' + (bubbleTotal - added) + ' 张失败（格式或体积不合法）')
          if (added > 0) errors.push('气泡图素材：只写入了 ' + added + '/' + bubbleTotal + ' 张')
          else fail('气泡图素材', '备份里的图片均无法写入')
          // 部分写入不算 applied（界面不能报「已恢复」），但确实写了东西：
          // 只勾了气泡图时 ok 不能为 false，否则界面直接报「恢复失败」，用户以为图没进去
          if (added > 0) partial = true
        } else applied.push('bubbles')
      } catch (err) { fail('气泡图素材', errMsg(err)) }
    }
  }
  if (want('todo')) {
    // 待办：结构不可用 → skipped；写盘失败要报 error（同 config，不能假报成功）
    const st = d.todo
    if (!st || typeof st !== 'object' || !Array.isArray(st.items)) skipped.push('todo')
    else {
      try {
        // 形状归一交给 readTodo：写入后所有读取方（挂件 / 设置页）都会拿到过滤过的清单
        if (writeTodo({ items: st.items, focusId: String(st.focusId || '') })) applied.push('todo')
        else fail('待办清单')
      } catch (err) { fail('待办清单', errMsg(err)) }
    }
  }
  if (want('focus')) {
    const f = d.focus
    const hasDays = !!f && typeof f === 'object' && !!f.days && typeof f.days === 'object'
    const hasSessions = !!f && typeof f === 'object' && Array.isArray(f.sessions) && f.sessions.length > 0
    if (!hasDays && !hasSessions) skipped.push('focus')
    else {
      try {
        // 同上：writeFocus 会过一遍 focus.withDerived —— 会话按形状清洗、天表按会话重新派生，
        // 这里只判形状。会话明细必须一起写回：只恢复按天汇总的话，「专注记录」列表会凭空变空
        if (writeFocus({ days: hasDays ? f.days : {}, sessions: hasSessions ? f.sessions : [] })) applied.push('focus')
        else fail('专注统计')
      } catch (err) { fail('专注统计', errMsg(err)) }
    }
  }
  if (want('secrets')) {
    // 解密已在预检里做过（secretPlan）；这里只剩写存储，失败才记 error
    if (!secretPlan) skipped.push('secrets')
    else {
      try {
        const s = secretPlan
        writeSecrets({
          apiKey: String(s.apiKey || ''),
          platformToken: String(s.platformToken || ''),
          // 多厂商模型的密钥槽位：老备份里没有这个字段，传 undefined 让 writeSecrets 沿用现值，
          // 否则一次「只恢复凭据」会把用户已保存的各模型密钥清空
          models: s.models === undefined ? undefined : s.models,
          // SMTP 邮件凭据：导出时 readSecrets() 已把它一并加密写进备份，这里必须显式恢复，
          // 否则 writeSecrets 见其为 undefined 会沿用现值 —— 换机恢复后邮件密码就丢了，
          // 备份文件里那份加密凭据等于白存。老备份无此字段时传 undefined 沿用现值
          notifyMail: s.notifyMail === undefined ? undefined : s.notifyMail,
        })
        // 凭据是「写进去了就算」（不能回读比对：万一读失败会误报，而密码错已在预检拦下）。
        // 但至少要确认关键字段真的落到了存储里 —— 加密存储写失败在某些环境不抛异常
        const wantKey = String(s.apiKey || '')
        const backS = readSecrets()
        if (wantKey && backS.apiKey !== wantKey) fail('凭据', '写入后回读不到 API Key')
        else applied.push('secrets')
      } catch (err) { fail('凭据', errMsg(err)) }
    }
  }
  log('[whale][backup] 恢复备份', { applied: applied.join(','), skipped: skipped.join(','), errors: errors.length })
  if (applied.length || partial) pending = null
  return { ok: applied.length > 0 || partial, applied: applied, skipped: skipped, errors: errors, error: errors[0] || '' }
}

module.exports = {
  exportBackup,
  pickBackup,
  pendingPreview,
  clearPending,
  applyBackup,
  // 供测试/排查用
  _encryptSecrets: encryptSecrets,
  _decryptSecrets: decryptSecrets,
}
