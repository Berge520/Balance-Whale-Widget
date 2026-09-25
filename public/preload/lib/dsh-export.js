/*
 * dsh 全量导出（CommonJS）—— 把 $DSH_HOME 整个目录压成一个 .zip 交付给用户。
 *
 * ── 与 lib/dsh-backup.js 的分工（两者并存，互不干扰）──
 *   dsh-backup.js：**快照**，白名单备 3 个文件，落在 $DSH_HOME/whale-dsh-backup/，
 *                  目的是「patch 写坏了能整文件覆盖回滚」，粒度是文件级、生命周期由挂件管。
 *   dsh-export.js：**导出**，全量遍历 $DSH_HOME，落在用户自己选的路径，
 *                  目的是「打包带走 / 存档」，挂件不解析包内容、不负责还原。
 * 前者是「撤销设施」，后者是「搬运工具」——受众、失败影响面都不同，所以不合并。
 *
 * ── 为什么不用 dsh-backup 的白名单 ──
 * 备份要「改坏了能回滚」，白名单够用且更安全（见 dsh-backup.js 头注释）。
 * 导出要「换台机器还能接着用」，漏文件就是丢数据，所以这里必须是**全量**。
 * 两者的安全模型不通用，各自成立 —— 这是刻意的差异，不是不一致。
 *
 * ── 学到的教训（社区 + 本项目）──
 *   ① 空壳包：社区 dsh-backup 0.12.2 修过一个 bug —— Windows 上 tar 拿到「盘符根目录」
 *      参数直接失败，留下 29 字节的空壳包，但脚本判定为成功。用户以为备好了，真出事
 *      才发现是空的。所以本模块**打完包必须回读校验**：条目数 + 解压后总字节数对得上
 *      才叫成功（见 verifyZip）。这不是过度设计，是踩过的坑。
 *   ② 不调系统 tar/zip：同上那个 bug 就是调系统工具导致的，且要额外处理引号 / 路径
 *      转义 / 平台差异。本项目 dsh-market.js 已有「手写 tar 解析」的先例，这里手写 zip
 *      写入，只依赖 Node 内置 fs（store 模式不压缩，见下方 zip 写入节）。
 *
 * ── 安全边界 ──
 * 凭据文件（.credentials.yaml 等）**默认不进包**，由用户显式勾选才进（includeCred）。
 * why 默认排除：包里是明文，用户拷给别人 / 传到网盘时不会意识到自己顺带泄了凭据；
 * 「要迁移就先勾上」比「默认带上、泄露了才发现」安全。勾选时界面必须明确警示。
 */
const fs = require('fs')
const path = require('path')
const { log, logErr } = require('./log')
const { homeDir } = require('./util')

// 包内清单文件名。放在包根，用户解开就能看到这份 zip 是从哪来的、备了什么
const MANIFEST_NAME = 'whale-dsh-export.json'
// manifest schema：将来字段变了，旧包仍能被识别（不至于当成损坏）
const SCHEMA = 1

// ── 排除规则 ──
// 恒排除的目录名（在任意层级都排除，不给用户开关）：
//   .git         —— 版本库快照，dsh 目录下的 .git 属于插件源码，可重新 clone
//   whale-dsh-backup —— 本插件的快照目录。导出时把它自己装进去会形成嵌套，
//                        且它是挂件的内部状态、不是 dsh 的数据，带走没意义
// ⚠️ node_modules **不在这里**：它是用户可选的（skipModules 开关）。
//    早先把它并进本数组，导致 skipModules=false 时仍被恒排除 —— 勾了也没用（测试抓到）。
//    它与 .git 的区别在于「有时确实要带走」（离线机器、装不上的包），所以给开关
const EXCLUDE_DIRS = ['.git', 'whale-dsh-backup']
// 默认可跳过的目录名。与 EXCLUDE_DIRS 分开，因为这一项受 skipModules 控制
const MODULES_DIR = 'node_modules'

// 文件名：默认排除的凭据文件。仅当 includeCred=true 时收进来
const CRED_FILES = ['.credentials.yaml', '.credentials.yml', 'credentials.yaml', 'credentials.yml']
// 除固定名之外，`.env` 系列（.env / .env.local / .env.production …）也是凭据载体
function isCredFile(name) {
  if (CRED_FILES.includes(name)) return true
  return /^\.env(\.|$)/i.test(name)
}

// 单文件体积上限（100MB）。导出的是配置/会话，正常不会有这种大文件；
// 真遇到就跳过并留痕，而不是把内存吃爆（整个 zip 是在内存里拼的）
const MAX_FILE_BYTES = 100 * 1024 * 1024
// 条目总数上限（20 万）。防「用户把某个巨型目录软链进 $DSH_HOME」这类意外
const MAX_ENTRIES = 200000

function errMsg(err) { return String((err && err.message) || err || '未知错误') }

// ── 路径 ──
// 与 dsh-backup.js / diagnostics.js 同一口径：env 优先 + 回退 ~/.dsh，都要实际存在
function dshHome() {
  return homeDir({ env: 'DSH_HOME', fallback: '.dsh' })
}

// 时间戳（包名用）：20260924-2143
function stampOf(d) {
  const t = d instanceof Date ? d : new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return String(t.getFullYear()) + p2(t.getMonth() + 1) + p2(t.getDate())
    + '-' + p2(t.getHours()) + p2(t.getMinutes())
}

// ── 遍历 ──
// 递归收集要打包的文件，返回 { files: [{ rel, abs, size }], skipped: [{rel, why}], truncated }
//
// ⚠️ 用**迭代**而不是递归：目录深时递归会爆栈（$DSH_HOME 下有插件源码，层级不可控）。
// ⚠️ 用 lstat 而不是 stat：symlink 不跟随 —— 跟随会走进包外目录（甚至走进环），
//    既可能把无关文件备进来，也可能无限展开。
function collectFiles(home, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const includeCred = o.includeCred === true
  // 默认跳过 node_modules（可重建 + 体积大）。EXCLUDE_DIRS 里另有 .git / whale-dsh-backup
  // 两个恒排除项，它们不给用户开关 —— 那两者带走没有意义，留成选项只会增加理解成本
  const skipModules = o.skipModules !== false
  const files = []
  const skipped = []
  let truncated = false
  // [{ abs, rel }] —— 待展开的目录栈
  const stack = [{ abs: home, rel: '' }]

  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try {
      ents = fs.readdirSync(cur.abs, { withFileTypes: true })
    } catch (err) {
      // 读不到的子目录（EACCES 等）是真故障，必须留痕 —— 静默跳过会让用户拿到一个
      // 「少了一部分但看起来正常」的包，这正是社区踩过的坑
      logErr('[whale][dsh-export] 读目录失败', cur.abs + ': ' + errMsg(err))
      skipped.push({ rel: cur.rel, why: '读取失败：' + errMsg(err) })
      continue
    }
    for (const e of ents) {
      const rel = cur.rel ? cur.rel + '/' + e.name : e.name
      const abs = path.join(cur.abs, e.name)
      if (e.isDirectory()) {
        if (skipModules && e.name === MODULES_DIR) { skipped.push({ rel: rel, why: 'node_modules（按设置跳过）' }); continue }
        if (EXCLUDE_DIRS.includes(e.name)) { skipped.push({ rel: rel, why: '按规则排除的目录' }); continue }
        stack.push({ abs: abs, rel: rel })
        continue
      }
      // 非普通文件（symlink / fifo / socket / 设备）一律不收：内容不可靠，且打包语义不清。
      // 不记 skipped —— 它们不是「丢数据」，是本来就不该进包
      if (!e.isFile()) continue
      if (!includeCred && isCredFile(e.name)) {
        skipped.push({ rel: rel, why: '凭据文件（未勾选包含）' })
        continue
      }
      let size = 0
      try {
        size = fs.statSync(abs).size
      } catch (err) {
        logErr('[whale][dsh-export] 取文件大小失败', rel + ': ' + errMsg(err))
        skipped.push({ rel: rel, why: '取文件大小失败：' + errMsg(err) })
        continue
      }
      if (size > MAX_FILE_BYTES) {
        logErr('[whale][dsh-export] 文件过大已跳过', rel + ' (' + size + ' 字节)')
        skipped.push({ rel: rel, why: '超过单文件上限' })
        continue
      }
      if (files.length >= MAX_ENTRIES) { truncated = true; break }
      files.push({ rel: rel, abs: abs, size: size })
    }
    if (truncated) break
  }
  // 排序：让同一份 $DSH_HOME 每次导出的条目顺序一致（readdirSync 顺序在不同
  // 文件系统上不稳定），便于比对两份包的差异
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files: files, skipped: skipped, truncated: truncated }
}

// ── zip 写入 ──
// ⚠️ 为什么手写：见文件头注释 ②（不调系统 tar/zip）。只依赖 Node 内置 zlib。
//
// 用 store 模式（method=0，不压缩）而不是 deflate：
// 导出的是配置 / 会话这类文本，deflate 能省一半体积，但**代价是解压时的兼容风险**
// 与更多出错面（zlib 版本差异、流式写入的分块边界）。第一版先用 store —— 
// 它是最简单的合法 zip，任何解压工具都能开，且「能还原」优先于「包小」。
// 需要体积优化时再加重 deflate，届时只需改 entry 里的 method / 压缩数据两处。
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// DOS 时间 / 日期（zip 头用的是 MS-DOS 格式，1980 起算）
function dosDateTime(d) {
  const y = d.getFullYear()
  const date = ((y < 1980 ? 0 : y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  return { date: date & 0xFFFF, time: time & 0xFFFF }
}

// 构造一个 zip 条目（local file header + 数据）。返回 Buffer
function zipEntry(name, data, when) {
  const nameBuf = Buffer.from(name, 'utf8')
  const dt = dosDateTime(when)
  const crc = crc32(data)
  const lh = Buffer.alloc(30)
  lh.writeUInt32LE(0x04034b50, 0)   // local file header 签名
  lh.writeUInt16LE(20, 4)           // 需要版本 2.0
  lh.writeUInt16LE(0x0800, 6)       // flag：bit 11 = 文件名是 UTF-8（中文路径必须）
  lh.writeUInt16LE(0, 8)            // 压缩方法 0 = store（不压缩）
  lh.writeUInt16LE(dt.time, 10)
  lh.writeUInt16LE(dt.date, 12)
  lh.writeUInt32LE(crc, 14)
  lh.writeUInt32LE(data.length, 18) // 压缩后大小（store 模式下等于原始大小）
  lh.writeUInt32LE(data.length, 22) // 原始大小
  lh.writeUInt16LE(nameBuf.length, 26)
  lh.writeUInt16LE(0, 28)           // extra field 长度
  return { local: Buffer.concat([lh, nameBuf, data]), nameBuf: nameBuf, crc: crc, size: data.length, dt: dt }
}

// 构造 central directory 条目。offset = 该条目 local header 在 zip 里的起点
function zipCentral(entry, offset) {
  const ch = Buffer.alloc(46)
  ch.writeUInt32LE(0x02014b50, 0)   // central file header 签名
  ch.writeUInt16LE(20, 4)           // 创建版本
  ch.writeUInt16LE(20, 6)           // 需要版本
  ch.writeUInt16LE(0x0800, 8)       // flag：UTF-8
  ch.writeUInt16LE(0, 10)           // store
  ch.writeUInt16LE(entry.dt.time, 12)
  ch.writeUInt16LE(entry.dt.date, 14)
  ch.writeUInt32LE(entry.crc, 16)
  ch.writeUInt32LE(entry.size, 20)
  ch.writeUInt32LE(entry.size, 24)
  ch.writeUInt16LE(entry.nameBuf.length, 28)
  ch.writeUInt16LE(0, 30)           // extra 长度
  ch.writeUInt16LE(0, 32)           // comment 长度
  ch.writeUInt16LE(0, 34)           // 起始磁盘号
  ch.writeUInt16LE(0, 36)           // 内部属性
  ch.writeUInt32LE(0, 38)           // 外部属性
  ch.writeUInt32LE(offset, 42)      // local header 相对偏移
  return Buffer.concat([ch, entry.nameBuf])
}

// 构造 end of central directory（EOCD）记录
function zipEocd(count, centralSize, centralOffset) {
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0)
  e.writeUInt16LE(0, 4)             // 本磁盘号
  e.writeUInt16LE(0, 6)             // central 起始磁盘号
  e.writeUInt16LE(count, 8)         // 本磁盘条目数
  e.writeUInt16LE(count, 10)        // 总条目数
  e.writeUInt32LE(centralSize, 12)
  e.writeUInt32LE(centralOffset, 16)
  e.writeUInt16LE(0, 20)            // 注释长度
  return e
}

// ── 回读校验（空壳检测）──
// 见文件头注释 ①：打完包**必须**回读一遍，确认 EOCD / 条目数 / 每条 CRC 都对得上。
// 社区那个 29 字节空壳包如果当时做了这一步就会被拦下。
//
// 返回 { ok, entries, totalBytes, error? }
function verifyZip(buf) {
  // EOCD 在文件末尾，注释最长 65535 —— 从后往前找签名
  const minEocd = 22
  if (buf.length < minEocd) return { ok: false, error: '产物过小，不是合法的 zip（' + buf.length + ' 字节）' }
  let eocd = -1
  const from = Math.max(0, buf.length - minEocd - 65535)
  for (let i = buf.length - minEocd; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return { ok: false, error: '找不到 zip 结尾记录（包可能被截断）' }
  const count = buf.readUInt16LE(eocd + 10)
  const centralSize = buf.readUInt32LE(eocd + 12)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  if (centralOffset + centralSize > buf.length) return { ok: false, error: 'zip 目录区越界（包不完整）' }

  // 顺着 central directory 逐条核对：名字长度 / 数据偏移 / CRC 与 store 长度一致
  let off = centralOffset
  let totalBytes = 0
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      return { ok: false, error: 'zip 第 ' + (i + 1) + ' 个目录项损坏' }
    }
    const crc = buf.readUInt32LE(off + 16)
    const size = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const cmtLen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) {
      return { ok: false, error: 'zip 第 ' + (i + 1) + ' 个数据段缺失' }
    }
    const lNameLen = buf.readUInt16LE(lho + 26)
    const lExtraLen = buf.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + lNameLen + lExtraLen
    if (dataStart + size > buf.length) return { ok: false, error: 'zip 第 ' + (i + 1) + ' 个数据越界' }
    const data = buf.slice(dataStart, dataStart + size)
    if (crc32(data) !== crc) return { ok: false, error: 'zip 第 ' + (i + 1) + ' 个条目校验值不符' }
    totalBytes += size
    off += 46 + nameLen + extraLen + cmtLen
  }
  return { ok: true, entries: count, totalBytes: totalBytes }
}

// ── 导出主流程 ──
// opts = { outPath: string, includeCred?: boolean, at?: Date, onProgress?: (n) => void }
//   凭据是否进包**只由调用方（界面）决定**：本模块不做「默认包含」这种隐式行为
//
// 返回 { ok, outPath, entries, bytes, skipped, truncated, missing, error? }
//   skipped：没进包的文件及原因（凭据排除 / 读取失败 / 超限）—— 界面要展示，
//            否则用户拿到一个「少了东西但看着正常」的包（社区踩过的坑）
function exportAll(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const home = dshHome()
  if (!home) return { ok: false, error: '找不到 dsh 配置目录（$DSH_HOME 与 ~/.dsh 都不存在）' }
  const outPath = String(o.outPath || '').trim()
  if (!outPath) return { ok: false, error: '未指定导出位置' }

  const rawAt = o.at instanceof Date ? o.at : new Date(o.at)
  const at = Number.isNaN(rawAt.getTime()) ? new Date() : rawAt
  const includeCred = o.includeCred === true

  const collected = collectFiles(home, { includeCred: includeCred, skipModules: o.skipModules !== false })
  if (!collected.files.length) return { ok: false, error: '该目录下没有可导出的文件' }
  if (collected.truncated) {
    logErr('[whale][dsh-export] 条目数超过上限', String(MAX_ENTRIES))
    return { ok: false, error: '文件数超过上限（' + MAX_ENTRIES + '），未导出。请先清理 $DSH_HOME 后重试' }
  }

  // 逐文件读入并组装 zip。整个包在内存里拼 —— 已排除 node_modules，
  // 正常规模是几 MB 到几十 MB，可接受
  const parts = []
  const entries = []
  const skipped = collected.skipped.slice()
  let missing = 0

  for (const f of collected.files) {
    let data = null
    try {
      data = fs.readFileSync(f.abs)
    } catch (err) {
      // 遍历与读取之间文件被删（dsh 正在跑，会话文件会变）属正常竞态，
      // 但要留痕并计入 skipped —— 不能静默少文件
      logErr('[whale][dsh-export] 读文件失败', f.rel + ': ' + errMsg(err))
      skipped.push({ rel: f.rel, why: '读取失败：' + errMsg(err) })
      missing++
      continue
    }
    const entry = zipEntry(f.rel, data, at)
    entries.push(entry)
    parts.push(entry.local)
    if (typeof o.onProgress === 'function') { try { o.onProgress(entries.length) } catch (_) {} }
  }

  if (!entries.length) return { ok: false, error: '所有文件都读不出来，未生成导出包' }

  // 包内清单：让用户解开就知道「这包是什么时候、从哪备的、备了多少、排除了什么」
  const manifest = {
    kind: 'whale-dsh-export',
    schema: SCHEMA,
    at: at.toISOString(),
    dshHome: home,
    includeCred: includeCred,
    entries: entries.length,
    bytes: entries.reduce((n, e) => n + e.size, 0),
    skipped: skipped.slice(0, 200),  // 只记前 200 条，避免清单本身过大
    skippedTotal: skipped.length,
    // 实际生效的排除项：node_modules 只在「按设置跳过」时才真的被排除，
    // 清单里要如实反映，否则解开包的人会以为 node_modules 是被规则排除的
    excludedDirs: (o.skipModules !== false ? [MODULES_DIR] : []).concat(EXCLUDE_DIRS),
  }
  const manifestEntry = zipEntry(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), at)
  entries.push(manifestEntry)
  parts.push(manifestEntry.local)

  // central directory 要等所有 local 写完才能填偏移。按 parts 的顺序重新累加一遍，
  // 得到每个条目 local header 的真实起点（不能用上面已推进到末尾的游标）
  let centralOffset = 0
  for (const e of entries) centralOffset += e.local.length
  let centralSize = 0
  const centrals = []
  let walk = 0
  for (const e of entries) {
    const c = zipCentral(e, walk)
    centrals.push(c)
    centralSize += c.length
    walk += e.local.length
  }
  const out = Buffer.concat(parts.concat(centrals).concat([zipEocd(entries.length, centralSize, centralOffset)]))

  // 回读校验（空壳检测）—— 见文件头注释 ①
  const check = verifyZip(out)
  if (!check.ok) {
    logErr('[whale][dsh-export] 导出包自检失败', check.error)
    return { ok: false, error: '导出包校验失败（' + check.error + '），已放弃写入，请重试' }
  }
  if (check.entries !== entries.length) {
    logErr('[whale][dsh-export] 条目数不符', check.entries + ' != ' + entries.length)
    return { ok: false, error: '导出包条目数不符，已放弃写入，请重试' }
  }

  // 写盘。先写临时文件再改名 —— 中途失败不会留下一个「看起来正常」的半截包
  const tmp = outPath + '.part'
  try {
    fs.writeFileSync(tmp, out)
    fs.renameSync(tmp, outPath)
  } catch (err) {
    logErr('[whale][dsh-export] 写导出包失败', errMsg(err))
    try { fs.rmSync(tmp, { force: true }) } catch (_) { /* 清不掉临时文件不掩盖主错误 */ }
    return { ok: false, error: '写入失败：' + errMsg(err) }
  }

  log('[whale][dsh-export] 已导出', {
    outPath: outPath, entries: entries.length, bytes: out.length,
    includeCred: includeCred, skipped: skipped.length,
  })
  return {
    ok: true,
    outPath: outPath,
    at: at.toISOString(),
    entries: entries.length,
    bytes: out.length,
    sourceBytes: manifest.bytes,
    skipped: skipped,
    skippedTotal: skipped.length,
    includeCred: includeCred,
    missing: missing,
  }
}

// 导出前给界面用的「预检」：不写文件，只告诉用户会备走多少、会排除什么。
// why 需要它：用户点「导出」前应该先看到「凭据会被排除」这件事，而不是拿到包之后才发现。
function previewExport(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const home = dshHome()
  if (!home) return { ok: false, error: '找不到 dsh 配置目录（$DSH_HOME 与 ~/.dsh 都不存在）' }
  const includeCred = o.includeCred === true
  const c = collectFiles(home, { includeCred: includeCred, skipModules: o.skipModules !== false })
  const credExcluded = c.skipped.filter((s) => /凭据文件/.test(String(s.why || '')))
  return {
    ok: true,
    dshHome: home,
    entries: c.files.length,
    bytes: c.files.reduce((n, f) => n + f.size, 0),
    truncated: c.truncated,
    excluded: c.skipped.length,
    // 凭据文件单独列出（不勾选时它们就在 skipped 里），界面用它做警示文案
    credFiles: credExcluded.map((s) => s.rel),
    skipped: c.skipped,
    maxFileBytes: MAX_FILE_BYTES,
    maxEntries: MAX_ENTRIES,
    excludeDirs: EXCLUDE_DIRS,
  }
}

module.exports = {
  MANIFEST_NAME,
  SCHEMA,
  EXCLUDE_DIRS,
  MODULES_DIR,
  CRED_FILES,
  MAX_FILE_BYTES,
  MAX_ENTRIES,
  dshHome,
  stampOf,
  isCredFile,
  collectFiles,
  exportAll,
  previewExport,
  // 供测试 / 排查用
  _crc32: crc32,
  _zipEntry: zipEntry,
  _verifyZip: verifyZip,
}
