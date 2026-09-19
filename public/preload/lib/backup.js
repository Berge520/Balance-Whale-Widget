/*
 * 备份 / 恢复（CommonJS）。
 *
 *  - 导出：把「挂件设置 / 账本 / 窗口位置 / 计时」打包成一个 JSON 文件。
 *  - 凭据（API Key / 平台 Token）默认**不导出**；勾选后必须设密码，用 scrypt 派生密钥 + AES-256-GCM
 *    加密后才写入文件（文件里没有明文，密码不落盘，忘记密码就无法解密）。
 *  - 导入：先解析出预览（导出时间 / 插件版本 / 包含项），由设置页勾选要恢复的项，再按「同名覆盖」写入。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { log } = require('./log')
const { PLUGIN_VERSION } = require('./constants')
const {
  readConfig, writeConfig, readSecrets, writeSecrets,
  readLedger, mergeLedgerHistory, readTimer, writeTimer,
  readAnchor, writeAnchor,
} = require('./store')

const KIND = 'balance-whale-widget-backup'
const SCHEMA = 1
const MIN_PWD = 6
// scrypt 参数：内存约 16MB / 次，桌面端足够快，也让暴力破解代价高
const SCRYPT = { N: 16384, r: 8, p: 1 }

let pending = null // 已解析、等待确认写入的备份（避免重复读文件）

function errMsg(err) { return String((err && err.message) || err || '未知错误') }

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

function stamp() {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes())
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
// opts = { secrets: boolean, password: string }
function exportBackup(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const withSecrets = o.secrets === true
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
  if (withSecrets) {
    try {
      data.secretsEnc = encryptSecrets(readSecrets(), password)
    } catch (err) {
      return { ok: false, error: '加密凭据失败：' + errMsg(err) }
    }
  }
  const payload = {
    kind: KIND,
    schema: SCHEMA,
    appVersion: PLUGIN_VERSION,
    exportedAt: new Date().toISOString(),
    includes: {
      config: true, ledger: true, window: true, timer: true,
      secrets: withSecrets ? 'encrypted' : 'none',
    },
    data,
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
  } catch (err) {
    return { ok: false, error: '写入备份文件失败：' + errMsg(err) }
  }
  log('[whale][backup] 导出备份', { filePath, withSecrets })
  return { ok: true, path: filePath, withSecrets, exportedAt: payload.exportedAt }
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
  if (!payload || payload.kind !== KIND || !payload.data || typeof payload.data !== 'object') {
    return { ok: false, error: '这不是本插件的备份文件' }
  }
  if (Number(payload.schema) > SCHEMA) {
    return { ok: false, error: '备份来自更新的插件版本（schema ' + payload.schema + '），请先升级插件' }
  }
  const d = payload.data
  pending = { path: filePath, payload: payload }
  return {
    ok: true,
    path: filePath,
    exportedAt: String(payload.exportedAt || ''),
    appVersion: String(payload.appVersion || ''),
    has: {
      config: !!d.config && typeof d.config === 'object',
      ledger: !!d.ledger && typeof d.ledger === 'object',
      window: !!d.window && typeof d.window === 'object',
      timer: !!d.timer && typeof d.timer === 'object',
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
// opts = { config, ledger, window, timer, secrets, password }
function applyBackup(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (!pending) return { ok: false, error: '请先选择备份文件' }
  const d = pending.payload.data || {}
  const want = (k) => o[k] === true
  const applied = []
  const skipped = []
  const errors = []

  if (want('config')) {
    if (!d.config || typeof d.config !== 'object') skipped.push('config')
    else {
      try {
        // 同名覆盖：备份里有值的键覆盖当前值，没提到的保持现状（writeConfig 会做一遍合法性归一）
        writeConfig(Object.assign({}, readConfig(), stripDshKeys(d.config)))
        applied.push('config')
      } catch (err) { errors.push('挂件设置：' + errMsg(err)) }
    }
  }
  if (want('ledger')) {
    if (!d.ledger || typeof d.ledger !== 'object') skipped.push('ledger')
    else {
      try {
        const hist = d.ledger.history && typeof d.ledger.history === 'object' ? d.ledger.history : {}
        const entries = Object.keys(hist).map((date) => ({ date: date, usage: hist[date] }))
        if (d.ledger.date) entries.push({ date: String(d.ledger.date), usage: d.ledger.todayUsage })
        mergeLedgerHistory(entries) // 同日覆盖，只保留配置的账本保留天数之内
        applied.push('ledger')
      } catch (err) { errors.push('账本：' + errMsg(err)) }
    }
  }
  if (want('window')) {
    if (!validAnchor(d.window)) skipped.push('window')
    else {
      try {
        writeAnchor({
          hAnchor: d.window.hAnchor, hDist: Math.max(0, Math.round(Number(d.window.hDist))),
          vAnchor: d.window.vAnchor, vDist: Math.max(0, Math.round(Number(d.window.vDist))),
        })
        applied.push('window')
      } catch (err) { errors.push('窗口位置：' + errMsg(err)) }
    }
  }
  if (want('timer')) {
    if (!d.timer || typeof d.timer !== 'object') skipped.push('timer')
    else {
      try { writeTimer(d.timer); applied.push('timer') } catch (err) { errors.push('计时：' + errMsg(err)) }
    }
  }
  if (want('secrets')) {
    if (!d.secretsEnc) skipped.push('secrets')
    else {
      try {
        const s = decryptSecrets(d.secretsEnc, String(o.password || ''))
        if (!s || typeof s !== 'object') throw new Error('解密结果异常')
        writeSecrets({
          apiKey: String(s.apiKey || ''),
          platformToken: String(s.platformToken || ''),
          // 多厂商模型的密钥槽位：老备份里没有这个字段，传 undefined 让 writeSecrets 沿用现值，
          // 否则一次「只恢复凭据」会把用户已保存的各模型密钥清空
          models: s.models === undefined ? undefined : s.models,
        })
        applied.push('secrets')
      } catch (err) {
        // AES-GCM 认证标签不匹配 → 密码错或文件被改过
        errors.push('凭据：密码不正确或备份已损坏（' + errMsg(err) + '）')
      }
    }
  }
  log('[whale][backup] 恢复备份', { applied: applied.join(','), skipped: skipped.join(','), errors: errors.length })
  if (applied.length) pending = null
  return { ok: applied.length > 0, applied: applied, skipped: skipped, errors: errors, error: errors[0] || '' }
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
