/*
 * GitHub 加速（hosts 方案，CommonJS）。
 *
 * 原理：在系统 hosts 文件最前写一段由标记头/尾包裹的「IP 域名」块（Windows 首次匹配解析，
 * 块在最前才能压过其它工具写在后面的条目），浏览器 / git / 下载全走直连 IP 加速；
 * 关闭时按标记把块删掉即可完全还原。原始 hosts 内容永不修改 —— 因此即使
 * 内置 IP 表过时，最坏只是回到慢速，关一次开关就恢复原状，不会更糟。
 *
 * 与其它加速工具的共存：
 *  - 若对方也写 hosts：Windows 按首次匹配解析，排在前的条目会覆盖本插件的块
 *    → scanConflicts() 扫描块外已有的目标域名条目，设置页提示先关掉对方再启用
 *  - 若对方走「本地反代 + 证书」：hosts 直连会绕开其代理，可能更慢/连不上
 *    → probeConnectivity() 实测 github.com 可达性，让用户开启前后各测一次自行判断
 *
 * 提权写 hosts：UAC 弹窗走 dsh.js 的 psExe + Start-Process -Verb RunAs 先例。
 * 关键设计：hosts 的读写都在本模块内按字节做（不解码原文，避免把 ANSI/GBK 注释
 * 当 UTF-8 重写造成乱码），算好的完整文件写到临时文件，提权脚本只负责
 * 「首次备份原 hosts → 拷贝覆盖」，并把结果写回临时结果文件由父进程读回。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const https = require('https')
const { log, logErr } = require('./log')
const { GH_DOMAINS, GH520_HOSTS_URL } = require('./constants')
const { normIps, patchConfig } = require('./store')
const { psExe } = require('./dsh')

const WIN = process.platform === 'win32'
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
const MARK_START = '# >>> whale-ghaccel start >>>'
const MARK_END = '# <<< whale-ghaccel end <<<'

// 取 URL 主机名（来源列展示「社区源表 · raw.hellogithub.com」，比整条 URL 短且够辨识）
function srcHost(url) {
  try { return new URL(url).host } catch (err) { return String(url || '').replace(/^https?:\/\//, '').split('/')[0] }
}

// 最近一次获取过程的来源追踪（内存态，不落盘）：设置页「GitHub 加速 → 查看日志」展示，
// 回答「每个域名的 IP 通过什么方式、从哪里获取」：
//  - dohResolvers：本次 DoH 实时解析中，实际返回过 A 记录的 DoH 入口（域名或直连 IP 形式）
//  - dohByDomain：DoH 实时解析出的逐域名 IP（并集，未过探测）
//  - dohOrigin：上面每个 IP 具体由哪家 DoH 解析出（Cloudflare / Google），支撑「来源」列点名到厂商
//  - refreshUrl：刷新用到的社区源 URL（GitHub520 主源或镜像）
//  - byDomain：每个域名最终选中的 IP + 来源（带具体出处，如「DoH 实时解析 · Cloudflare」）
let lastTrace = { at: 0, dohResolvers: [], dohByDomain: {}, dohOrigin: {}, refreshUrl: '', byDomain: {} }

// ──────────────────────────────────────────────
// 操作日志（内存态环形缓冲，重开插件清空）
// ──────────────────────────────────────────────
// 设置页「GitHub 加速日志」用：一条 = 一次操作，回答「点了什么按钮 → 做了什么 → 结果如何」。
// 与 log()/logErr() 的区别：那两个是给开发者看的诊断流水（DEV 门控、混着所有模块）；
// 这份是**结构化**的面向用户记录（步骤 + 结果 + 关键数据），且保留足够条数供回看历史。
// 不落盘：日志含 IP / 源 URL，属诊断信息，没必要长期留存，也避免泄漏到磁盘。
const OP_LOG_MAX = 50
const opLogs = []
function nextOpId() {
  return opLogs.length ? opLogs[0].id + 1 : 1
}
// step：步骤文案（做什么）；state：running/done/fail/skip；detail：结果与关键数据
function opStart(title) {
  const entry = { id: nextOpId(), at: Date.now(), title: title, state: 'running', steps: [] }
  opLogs.unshift(entry)
  if (opLogs.length > OP_LOG_MAX) opLogs.length = OP_LOG_MAX
  log('[whale][ghaccel] 操作开始 #' + entry.id, title)
  return entry
}
function opStep(entry, text, state, detail) {
  if (!entry) return
  entry.steps.push({ text: text, state: state || 'done', detail: detail || '' })
}
function opEnd(entry, state, summary) {
  if (!entry) return
  entry.state = state
  entry.summary = summary || ''
  entry.ms = Date.now() - entry.at
  const tag = state === 'ok' ? '完成' : state === 'cancel' ? '取消' : '失败'
  const line = '[whale][ghaccel] 操作' + tag + ' #' + entry.id + ' ' + entry.title + '（' + entry.ms + 'ms）' + (summary ? '：' + summary : '')
  if (state === 'fail') logErr(line)
  else log(line)
}
function ghAccelOpLogs() {
  // 深拷贝：渲染进程拿到的不能是宿主内部对象引用，否则设置页改一下就污染了历史
  return opLogs.map((e) => ({
    id: e.id,
    at: e.at,
    title: e.title,
    state: e.state,
    summary: e.summary || '',
    ms: e.ms || 0,
    steps: e.steps.map((s) => ({ text: s.text, state: s.state, detail: s.detail })),
  }))
}
// 清空操作日志。连带把 id 计数也归零（nextOpId 依赖 opLogs[0]，清空后自然从 #1 重来）。
// 进行中的那条也一并清掉：clear 只在设置页点，此刻用户就是要一片干净，留着半条更奇怪；
// 那条 op 的 opEnd 后续仍会写进 log()（诊断流水不受影响），只是不再回到这份面向用户的记录
function clearGhAccelOpLogs() {
  const n = opLogs.length
  opLogs.length = 0
  log('[whale][ghaccel] 操作日志已清空', n, '条')
  return n
}

// 备份文件位置：首次开启时由提权脚本把原 hosts 复制过去，供误操作时手动恢复。
// 正常关闭走「删块」不需要它；uTools 的数据目录卸载/清除不影响系统 hosts。
function userDataDir() {
  try { return utools.getPath('userData') } catch (err) {}
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'whale') : os.tmpdir()
}
function hostsBackupPath() {
  return path.join(userDataDir(), 'whale-hosts-backup')
}
// 先 String(s) 再判别：来源追踪 / 源表里 ip 可能不是字符串（数字形式的 IP），
// 直接 exec 会因类型隐式转换放过非字符串值。统一在这里转成字符串，
// 保证调用方拿到的 ip 一定是 string（设置页侧有对应类型契约）
function isIpv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s == null ? '' : s))
  return !!m && m.slice(1).every((n) => Number(n) <= 255)
}

// ──────────────────────────────────────────────
// 按字节读写 hosts（不改变原文编码）
// ──────────────────────────────────────────────
function readHostsBuf() {
  try {
    const b = fs.readFileSync(HOSTS_PATH)
    return Buffer.isBuffer(b) ? b : Buffer.from(b)
  } catch (err) {
    // 读文件不需要管理员权限；读不到按空处理（enable 时会重建）
    return Buffer.alloc(0)
  }
}
// 找到 pos 所在行的行首（不含换行）
function lineStart(buf, pos) {
  const nl = buf.lastIndexOf(10, pos)
  return nl < 0 ? 0 : nl + 1
}
// 找到 pos 所在行的行尾（不含换行符本身）
function lineEnd(buf, pos) {
  const nl = buf.indexOf(10, pos)
  return nl < 0 ? buf.length : nl
}
// 删除标记块（头在但尾不在 = 异常残留，也从行首删到文件尾）
function stripBlock(buf) {
  const i0 = buf.indexOf(Buffer.from(MARK_START))
  if (i0 < 0) return buf
  const iEnd = buf.indexOf(Buffer.from(MARK_END))
  const s = lineStart(buf, i0)
  let e = iEnd < 0 ? buf.length : lineEnd(buf, iEnd)
  // 把块末尾的换行（\r\n 或 \n）一并删掉
  if (e < buf.length && buf[e] === 13) e++
  if (e < buf.length && buf[e] === 10) e++
  return Buffer.concat([buf.slice(0, s), buf.slice(e)])
}
// 把块写到文件最前：Windows 按首次匹配解析，其它工具常驻的「127.0.0.1 github.com」
// 等条目排在后面就永远轮不到我们 —— 块写在最前才能压过它们，让 github 直连真实可达 IP。
// 块内容是我们自己写的，可放心当 UTF-8 编码
function prependBlock(buf, ips) {
  const lines = [
    MARK_START,
    '### 小鲸鱼余额挂件 GitHub 加速：关闭加速后本块整段删除，不影响其他内容',
  ].concat(ips.map((it) => it.ip + ' ' + it.domain)).concat([MARK_END])
  const block = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')
  // 原文件非空且不以换行结尾时先补一个换行，避免与块尾换行粘连
  let tail = buf
  if (tail.length > 0 && tail[tail.length - 1] !== 10) tail = Buffer.concat([tail, Buffer.from('\r\n')])
  return Buffer.concat([block, tail])
}
// 解析块内容里的「生效域名」列表（块是我们写的 ASCII，按 UTF-8 解没问题）
// 同一域名可能有多行（多个候选 IP 做回退），这里按域名去重 —— 调用方（设置页
// 「已生效（N 个域名）」）要的是域名数，不是行数
function blockActive(buf) {
  const i0 = buf.indexOf(Buffer.from(MARK_START))
  const iEnd = buf.indexOf(Buffer.from(MARK_END))
  if (i0 < 0 || iEnd < 0) return []
  const inner = buf.slice(lineEnd(buf, i0) + 1, lineStart(buf, iEnd)).toString('utf8')
  const out = []
  const seen = new Set()
  for (const line of inner.split('\n')) {
    const t = line.replace(/#.*/, '').trim()
    if (!t) continue
    const p = t.split(/\s+/)
    if (p.length >= 2 && isIpv4(p[0]) && GH_DOMAINS.includes(p[1]) && !seen.has(p[1])) {
      seen.add(p[1])
      out.push(p[1])
    }
  }
  return out
}

// ──────────────────────────────────────────────
// 状态与冲突扫描（读文件即可，不需要管理员权限）
// ──────────────────────────────────────────────
function ghAccelStatus() {
  if (!WIN) return { ok: false, on: false, active: [], hostsPath: HOSTS_PATH, error: '仅支持 Windows' }
  const buf = readHostsBuf()
  const i0 = buf.indexOf(Buffer.from(MARK_START))
  const on = i0 >= 0
  // degraded：块存在但已被挤出文件最前（块前有非空白/非注释内容）。块写在最前才能
  // 压过其它工具常驻的 127.0.0.1 条目（Windows first-match）；若对方在本插件
  // 之后又写了 hosts、把块挤到后段，就会失效 —— 设置页据此提示「重新写入 hosts」。
  // 监听 hosts 变化的工具会在我们写入后自动重写，我们无法常驻提权（会反复弹 UAC），
  // 故用「读文件时检测 + 状态暴露」的轻量替代。
  let degraded = false
  if (on) {
    const head = buf.slice(0, i0).toString('utf8').replace(/#[^\n]*/g, '').replace(/\s+/g, '')
    degraded = head !== ''
  }
  return { ok: true, on: on, degraded: degraded, active: on ? blockActive(buf) : [], hostsPath: HOSTS_PATH, error: '' }
}
// 块之外已有的目标域名条目：Windows 首次匹配解析，它们排在前会覆盖本插件的块
function scanConflicts() {
  if (!WIN) return []
  const buf = stripBlock(readHostsBuf())
  const out = []
  const seen = new Set()
  for (const line of buf.toString('utf8').split('\n')) {
    const t = line.replace(/#.*/, '').trim()
    if (!t) continue
    const p = t.split(/\s+/)
    if (p.length < 2 || !isIpv4(p[0])) continue
    const domain = p[1].toLowerCase()
    if (GH_DOMAINS.includes(domain) && !seen.has(domain)) {
      seen.add(domain)
      out.push({ domain: domain, ip: p[0], line: line.trim() })
    }
  }
  return out
}

// 连通性自检：HEAD https://github.com 实测（设置页「检测连接」开启前后各测一次做对比）
async function probeConnectivity(op) {
  const t0 = Date.now()
  opStep(op, 'HEAD 请求 https://github.com', 'running', '走系统当前的 DNS 与 hosts 解析')
  try {
    const res = await fetch('https://github.com', { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) })
    opStep(op, 'HEAD 请求 https://github.com', 'done', 'HTTP ' + res.status + '，耗时 ' + (Date.now() - t0) + 'ms')
    return { ok: true, ms: Date.now() - t0, status: res.status }
  } catch (err) {
    const msg = String((err && err.message) || err)
    opStep(op, 'HEAD 请求 https://github.com', 'fail', msg)
    return { ok: false, ms: Date.now() - t0, error: msg }
  }
}

// ──────────────────────────────────────────────
// 一键刷新 IP 表（社区源，每日更新）
// ──────────────────────────────────────────────
// 社区源只覆盖 github.* 域名，huggingface.co / hub.docker.com / greasyfork.org 源里没有，
// 刷新按「源命中 > 当前表」逐域名合并，绝不丢掉这些域名 —— 否则一刷新表就少了几条。
// 多源兜底：GitHub520 主源挂了/被墙时逐个往后切，首个有命中的源即停；
// 全部失败保留旧表只报错 —— 宁可继续用旧表，也不能把表清空。
// 三个源内容各不相同（已实测 sha256 两两不同），互补而非冗余。
// 注意别再塞 ghproxy.net 版的 ineo6/hosts：它与 gitlab 那份字节完全相同（同一文件的两个入口），
// 只会白跑一轮；且它还要经代理转一层、本身依赖能连通 GitHub，恰在本功能最需要时最不可靠
const GH_IPS_SOURCES = [
  GH520_HOSTS_URL,
  'https://hosts.gitcdn.top/hosts.txt',
  'https://gitlab.com/ineo6/hosts/-/raw/master/hosts?ref_type=heads',
]
async function refreshIps(current, op) {
  const want = {}
  for (const d of GH_DOMAINS) want[d] = true
  const curBy = {}
  if (Array.isArray(current)) for (const it of current) if (it && it.domain) curBy[it.domain] = it.ip
  const curCount = Object.keys(curBy).length
  opStep(op, '读取当前 IP 表作为合并基线', 'done', curCount + ' 条')
  let lastErr = ''
  for (const url of GH_IPS_SOURCES) {
    let res
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    } catch (err) {
      lastErr = String((err && err.message) || err)
      logErr('[whale][ghaccel] 拉取源失败', url, lastErr)
      opStep(op, '拉取社区源 ' + srcHost(url), 'fail', lastErr)
      continue
    }
    if (!res.ok) {
      lastErr = 'HTTP ' + res.status
      logErr('[whale][ghaccel] 源返回非 2xx', url, lastErr)
      opStep(op, '拉取社区源 ' + srcHost(url), 'fail', lastErr)
      continue
    }
    const text = await res.text()
    const found = {}
    let total = 0
    for (const line of text.split('\n')) {
      const t = line.replace(/#.*/, '').trim()
      if (!t) continue
      const p = t.split(/\s+/)
      if (p.length < 2 || !isIpv4(p[0])) continue
      const domain = p[1].toLowerCase()
      if (!want[domain]) continue
      total++
      if (!(domain in found)) found[domain] = p[0] // 源里同域多条时取第一条
    }
    const fresh = GH_DOMAINS.filter((d) => found[d]).length
    if (!fresh) {
      lastErr = '源没有本插件关心的域名条目'
      logErr('[whale][ghaccel] 源无命中条目', url)
      opStep(op, '解析社区源 ' + srcHost(url), 'fail', '无本插件关心的域名条目（共 ' + total + ' 条）')
      continue
    }
    const updated = GH_DOMAINS.map((d) => ({ domain: d, ip: found[d] || curBy[d] }))
    const ips = normIps(updated)
    log('[whale][ghaccel] IP 表刷新成功', fresh, '条 / 源共', total, '条目标条目')
    // 来源追踪：刷新用到的源 + 各域名表内值来自哪一层（源表 > 当前表）。
    // 来源字符串带上具体出处（源主机名），避免只写「社区源表」看不出到底哪来的
    lastTrace.at = Date.now()
    lastTrace.refreshUrl = url
    const host = srcHost(url) // 如 raw.hellogithub.com / ghproxy.net
    GH_DOMAINS.forEach((d) => {
      lastTrace.byDomain[d] = {
        ip: found[d] || curBy[d] || '',
        source: found[d] ? '社区源表 · ' + host : (curBy[d] ? '当前 IP 表（手填）' : '源表未覆盖（未写）'),
      }
    })
    patchConfig({ ghAccelRefreshedAt: Date.now() }) // 表龄提醒的依据：成功刷新即更新，失败不动
    opStep(op, '解析社区源 ' + host, 'done', '命中 ' + fresh + ' 个域名（源共 ' + total + ' 条目标条目）')
    opStep(op, '合并为新的 IP 表', 'done', ips.length + ' 条' + (GH_DOMAINS.length - fresh ? '，源未覆盖的 ' + (GH_DOMAINS.length - fresh) + ' 个域名沿用当前表' : ''))
    return { ok: true, updated: ips, total: total, skipped: GH_DOMAINS.length - fresh }
  }
  opStep(op, '所有社区源均失败', 'fail', lastErr)
  return { ok: false, error: '所有源都拉取失败：' + lastErr + '（已保留现有 IP 表）' }
}

// ──────────────────────────────────────────────
// UAC 提权写 hosts
// ──────────────────────────────────────────────
// PowerShell 双引号字符串里 ` 是转义符，反斜杠是字面量
function psStr(s) {
  return '"' + String(s).replace(/`/g, '``').replace(/"/g, '`"') + '"'
}
// 提权脚本只做三件事：首次备份原 hosts → 用父进程算好的文件覆盖 → 写结果文件。
// 不做任何 hosts 内容处理 —— 内容处理在父进程按字节做完，避免提权进程里解码/编码出错。
function buildElevatePs1(srcPath, backupPath, resultPath) {
  return [
    '$ErrorActionPreference = "Stop"',
    '$src = ' + psStr(srcPath),
    '$backup = ' + psStr(backupPath),
    '$result = ' + psStr(resultPath),
    'try {',
    '  if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath "' + HOSTS_PATH.replace(/"/g, '`"') + '" -Destination $backup -Force }',
    '  Copy-Item -LiteralPath $src -Destination "' + HOSTS_PATH.replace(/"/g, '`"') + '" -Force',
    '  [System.IO.File]::WriteAllText($result, "ok")',
    '} catch {',
    '  try { [System.IO.File]::WriteAllText($result, "fail:" + $_.Exception.Message) } catch {}',
    '  exit 1',
    '}',
  ].join('\r\n')
}
// action: 'enable' | 'disable'；返回 Promise<{ ok, canceled?, already?, error? }>
function applyHostsBlock(action, ips, op) {
  return new Promise((resolve) => {
    if (!WIN) {
      resolve({ ok: false, canceled: false, error: '仅支持 Windows' })
      return
    }
    // 父进程按字节算好「新 hosts」：enable = 删旧块后在文件最前重写块；disable = 只删块
    let next
    try {
      next = action === 'enable' ? prependBlock(stripBlock(readHostsBuf()), ips) : stripBlock(readHostsBuf())
    } catch (err) {
      logErr('[whale][ghaccel] 计算新 hosts 内容失败', err && err.message)
      opStep(op, '计算新的 hosts 内容', 'fail', (err && err.message) || String(err))
      resolve({ ok: false, canceled: false, error: '处理 hosts 内容失败：' + ((err && err.message) || err) })
      return
    }
    opStep(op, '计算新的 hosts 内容', 'done', action === 'enable' ? '在原文件最前插入标记块（' + ips.length + ' 条域名）' : '移除标记块')
    if (action === 'disable' && next.length === readHostsBuf().length) {
      // hosts 里本来就没有本插件的块：无事可做，不弹 UAC
      opStep(op, '检查 hosts 里的标记块', 'skip', '没有本插件写入的块，无需提权')
      resolve({ ok: true, canceled: false, already: true })
      return
    }
    opStep(op, '弹出 UAC 提权写 hosts', 'running', '需在系统弹窗点「是」')
    const stamp = 'whale-ghaccel-' + process.pid + '-' + Date.now()
    const scriptPath = path.join(os.tmpdir(), stamp + '.ps1')
    const srcPath = path.join(os.tmpdir(), stamp + '.hosts')
    const resultPath = path.join(os.tmpdir(), stamp + '.result')
    const cleanup = () => {
      for (const p of [scriptPath, srcPath, resultPath]) { try { fs.rmSync(p, { force: true }) } catch (err) {} }
    }
    try {
      fs.writeFileSync(srcPath, next)
      fs.writeFileSync(scriptPath, buildElevatePs1(srcPath, hostsBackupPath(), resultPath))
    } catch (err) {
      logErr('[whale][ghaccel] 写临时文件失败', err && err.message)
      cleanup()
      resolve({ ok: false, canceled: false, error: '无法创建临时文件：' + ((err && err.message) || err) })
      return
    }
    // -Verb RunAs 触发 UAC；-Wait 等提权进程结束，-PassThru 才能拿到退出码
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"
    const ps = '$p = Start-Process -FilePath ' + q(psExe())
      + ' -ArgumentList ' + ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath].map(q).join(',')
      + ' -Verb RunAs -Wait -PassThru; exit $p.ExitCode'
    execFile(psExe(), ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'buffer', timeout: 120000 }, (err, so, se) => {
      let result = ''
      try { result = fs.readFileSync(resultPath, 'utf8').trim() } catch (err2) {}
      cleanup()
      const own = String(Buffer.isBuffer(so) ? so : so || '') + String(Buffer.isBuffer(se) ? se : se || '')
      if (result) {
        if (/^ok\b/.test(result)) {
          log('[whale][ghaccel] hosts 标记块', action === 'enable' ? '已写入' : '已移除')
          opStep(op, '提权进程写 hosts', 'done', action === 'enable' ? '标记块已写入文件最前' : '标记块已移除')
          resolve({ ok: true, canceled: false })
        } else {
          const msg = result.replace(/^fail:?/, '').trim()
          logErr('[whale][ghaccel] 提权写 hosts 失败', msg || '未知错误')
          opStep(op, '提权进程写 hosts', 'fail', msg || '未知错误')
          resolve({ ok: false, canceled: false, error: msg || '提权写 hosts 失败（请确认是管理员账户）' })
        }
        return
      }
      // 没有结果文件：UAC 被取消（点了「否」）或提权进程根本没起来
      const canceled = /cancel|取消|拒绝访问|access is denied|access denied/i.test(own)
      if (canceled) {
        opStep(op, '提权进程写 hosts', 'fail', 'UAC 弹窗被取消')
        resolve({ ok: false, canceled: true, error: 'UAC 提权被取消（弹窗里点了「否」），可重试并在弹窗点「是」' })
      } else {
        logErr('[whale][ghaccel] 提权进程未产出结果', own)
        opStep(op, '提权进程写 hosts', 'fail', '提权进程未完成' + (own ? '：' + own.slice(0, 120) : ''))
        resolve({ ok: false, canceled: false, error: '提权进程未完成' + (own ? '：' + own.slice(0, 120) : '') })
      }
    })
  })
}

// ──────────────────────────────────────────────
// 写入前连通性探测（静态 hosts 零容错：一条死 IP 会让域名连不上且不回落 DNS，必须筛掉）
// ──────────────────────────────────────────────
// 单 IP 探测超时。所有候选是并行探测的（Promise.all），整批的等待时间就等于
// **最慢的那个候选**，所以这个值直接决定「点开启后要等多久」，必须谨慎取。
//
// 历史教训（2026-09，用户网络）：超时曾放宽到 8s，因为实测 140.82.112.4 / 140.82.121.3
// 能回 200 但整体要 4~5s（connect 快、首包慢），140.82.116.3 连 connect 就要 3.2s ——
// 超时太短会把这类「慢但能用」的 IP 误杀，域名整个被丢出块、退回 DNS 污染。
//
// 但 8s 的代价是每次开启固定等到最慢候选超时，用户感受就是「每次都好慢」。折中到 4.5s：
//  - 保住上面那批 3.2~4.5s 的慢 IP（这是当初放宽的理由，不能回退到 2s 那种激进值）；
//  - 同时砍掉「8s 全黑等」——超过 4.5s 无响应的基本是黑洞/被墙地址。
// 真正让开启变快的是下面 DOH_URLS 减半（去掉串行瓶颈），不是靠压这个值。
const PROBE_TIMEOUT_MS = 4500
// github.com 的兜底候选（真实 A 记录，Azure 亚洲边缘）：源表（GitHub520）给它的 IP
// 在部分网络（尤其 140.82.x / 部分 20.205.x）会被墙或不是该域名的边缘，实测备这几个仍可达的。
// 不进设置页 IP 表：表里保持「一行一域名」，兜底只在内部分配候选链时追加
const GH_COM_EXTRA_IPS = ['140.82.112.4', '140.82.121.3', '20.27.177.113', '20.200.245.247']
// 单个 IP 探测：发真实 HTTPS GET（SNI 带域名）。用 HTTP 状态区分「可达」与「错误边缘」：
//  - 任何域名：400/5xx/超时/断连 = 此 IP 不服务该域名或不可达，拒收。纯 TLS 握手测不出这层
//    （同一 Azure IP 上 api.github.com 握手成功且 200，github.com 的 SNI 却回 400），写进
//    hosts 浏览器照样打不开，所以必须看 HTTP 状态。
//  - github.com 主站：只认 2xx/3xx —— 20.205.243.167/.162 对 github.com 回 403/404，都是
//    错误边缘，4xx 绝不能写。
//  - 内容域名（objects / user-images / camo / assets / uploads / githubapp）在正确的
//    185.199.108.133 内容边缘上，根路径 GET 回 404/403 是**正常**的（没路径当然 404），
//    只认 2xx/3xx 会把它们误杀丢出块 → 网页资产全加载不出来，故其它域名 4xx 也收。
// 证书 SAN 匹配：
// 证书里的 DNS 名与目标域名精确相等，或 `*.example.com` 通配匹配，才算「这个 IP 真的是该域名的边缘」。
// 为什么必须自己比：一个 IP 可能完成 TLS 握手、甚至回 200，但证书是别家域名的（被劫持 / 错误边缘）。
// 这类 IP 写进 hosts 后浏览器会因证书不匹配直接拦死 —— 比 4xx 更隐蔽，只看 HTTP 状态抓不出来。
function certMatchesDomain(cert, domain) {
  if (!cert || !domain) return false
  const cn = cert.subject && cert.subject.CN
  if (cn && (cn === domain || (cn[0] === '*' && domain.endsWith(cn.slice(1))))) return true
  const san = cert.subjectaltname || ''
  // subjectaltname 形如 "DNS:github.com, DNS:*.github.com, IP Address:1.2.3.4"
  return san.split(',').some((part) => {
    const name = part.trim().replace(/^DNS:/i, '')
    if (!/^DNS:/i.test(part.trim())) return false
    if (name === domain) return true
    return name[0] === '*' && domain.endsWith(name.slice(1))
  })
}
function probeIp(ip, servername) {
  return new Promise((resolve) => {
    const req = https.request({
      host: ip, port: 443, servername: servername, path: '/', method: 'GET',
      // rejectUnauthorized 置 false：这里 host 填的是 IP，Node 会用 IP 去比证书名，
      // 必然报 ERR_TLS_CERT_ALTNAME_INVALID。域名匹配改由上面的 certMatchesDomain 手工按
      // servername 判（见上面的 certMatchesDomain），因此这里必须放行。
      rejectUnauthorized: false, timeout: PROBE_TIMEOUT_MS,
      // host 填的是 IP，这里必须显式把 Host 头指回域名，边缘按 Host+SNI 路由
      headers: { host: servername, 'user-agent': 'whale-ghaccel-probe/1.0' },
    })
    let certOk = false
    req.once('socket', (socket) => {
      socket.once('secureConnect', () => {
        try {
          certOk = certMatchesDomain(socket.getPeerCertificate(), servername)
        } catch (err) { certOk = false }
      })
    })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { req.destroy() } catch (err) {}
      resolve(ok)
    }
    req.once('response', (res) => {
      const sc = res.statusCode
      const statusOk = servername === 'github.com'
        ? (sc >= 200 && sc < 400)                       // 主站：4xx 全是错误边缘
        : (sc >= 200 && sc < 500 && sc !== 400)         // 其它域名：内容域根路径 404/403 正常
      // 证书 SAN 必须也匹配：能回 200 但证书是别家域名的 IP，写进 hosts 浏览器照样打不开。
      // 两个条件都满足才算这个 IP 真能服务该域名。
      finish(statusOk && certOk)
    })
    req.once('timeout', () => finish(false))
    req.once('error', () => finish(false))
    req.end()
  })
}
// DoH 实时 A 记录（思路：每次动态解析，换新鲜 IP；多个 resolver
// 并集）：静态列表（GitHub520 源表 / 手填表）会过期，真实 A 记录才是当天最新的。
// 国外 resolver 并集 —— Cloudflare 1.1.1.1/1.0.0.1 + Google dns.google/8.8.8.8，每个 DNS 商
// 各给「域名入口」与「直连 IP 入口」，域名本身被污染/解析失败时直连 IP 入口还能用
// （直连 IP 形式的 DoH 入口是通用做法）。国内 DoH（如 alidns）实测返回的就是
// 被污染的 IP，故不用 —— 注意这只针对「实时解析」；国内社区源表（GitHub520）是人工验证过的
// IP，仍然在用（见 refreshIps）。结果照旧过 probeIp 的 HTTPS GET 探测，错误边缘会被滤掉；
// 解析失败返回空 = 候选链保持原样，无害。短 TTL 缓存，避免开启/重写时反复解析。
// 体积换取速度的取舍：1.1.1.1 与 1.0.0.1 是同一家（Cloudflare）的两个 anycast 地址，
// dns.google 与 8.8.8.8 同为 Google —— 保留 4 个入口时每个域名要发 4 个请求，其中一半是
// 重复厂商的冗余。实测两家（Cloudflare + Google）并集已能覆盖 GitHub 的边缘 IP，
// 故砍掉两个冗余入口：请求数从「域名数 × 4」降到「域名数 × 2」。
// DoH 是「域名数 × 入口数」的并行扇出，入口数直接乘在等待时间上，故这里收益最大。
const DOH_URLS = [
  'https://1.1.1.1/dns-query',
  'https://dns.google/resolve',
]
// 实时解析哪些域名：挑「主站 + 高频 API/内容入口 + 源表覆盖差的域名」，并非全部 GH_DOMAINS。理由：
//  - github.com 是主站，必须最可靠（它的候选链前端插 DoH 结果）；
//  - api / raw / objects / codeload 是 git 操作与下载的主路径，静态表最易过时；
//  - gist 两个域名同样如此：gist 内容走 gist.githubusercontent.com，源表覆盖时有时无；
//  - user-images / avatars / camo 是 README 与头像的实际落点：源表给的多是 185.199.108.133
//    这类「内容边缘」共享地址，实测常给出不服务该域名的 IP（能连、证书却是别家的），
//    纳入 DoH 后用实时 A 记录把正确边缘顶到候选链最前，比只靠源表稳；
//  - 其余（github.githubassets / github.dev / github.io / education 等）低频或走 CDN 通配证书，
//    IP 变化小，DoH 收益低而请求数线性增长。
// 每个域名仍走全部 DOH_URLS，解析结果并集去重后进候选链。
const DOH_DOMAINS = [
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'codeload.github.com',
  'gist.github.com', 'gist.githubusercontent.com',
  'avatars.githubusercontent.com', 'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
]
// DoH 入口 → 人话名字：来源列要写到「从哪个解析商拿的」，直接摆 URL 太长，
// 这里按 base URL 反查厂商简称（同一厂商的域名入口与直连 IP 入口归到同一名字）
const DOH_NAMES = [
  [/1\.1\.1\.1|1\.0\.0\.1|cloudflare/i, 'Cloudflare'],
  [/dns\.google|8\.8\.8\.8/i, 'Google'],
]
function dohName(entry) {
  for (const [re, name] of DOH_NAMES) if (re.test(entry)) return name
  return entry.replace(/^https?:\/\//, '').split('/')[0]
}
function dohUrl(base, domain) {
  return base + '?name=' + domain + '&type=A'
}
const DOH_TTL_MS = 5 * 60 * 1000
// 缓存结构改成 { at, byDomain, originByIp }：分域名缓存，某个域名解析失败不影响其它域名的缓存。
// originByIp 记录「每个 IP 是哪个 DoH 厂商给的」——同一域名多个厂商并集，光存 IP 看不出出处
let dohCache = { at: 0, byDomain: {}, originByIp: {} }
// 解析单个域名：返回 { ips, resolvers, originByIp }
//  - resolvers：成功返回 A 记录的 DoH 入口（含完整 URL，日志用）
//  - originByIp：IP → 厂商简称（来源列用；同一 IP 被多家解析出时保留先到者）
async function dohResolveDomain(domain) {
  const ips = []
  const seen = new Set()
  const resolvers = []
  const originByIp = {}
  await Promise.all(
    DOH_URLS.map((base) =>
      // 5s 偏长：DoH 是开启流程最前端的串行瓶颈（必须等它出结果才建候选链），
      // 而单家 DoH 正常响应在 100~500ms。2.5s 足够，超时即放弃这家（另一家仍可能给结果），
      // 避免一家卡 5s 把整体开启时间整体拖长
      fetch(dohUrl(base, domain), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(2500) })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!j || !Array.isArray(j.Answer)) return
          let got = 0
          for (const a of j.Answer) {
            const ip = String((a && a.data) || '')
            if (isIpv4(ip)) {
              if (!originByIp[ip]) originByIp[ip] = dohName(base)
              if (!seen.has(ip)) { seen.add(ip); ips.push(ip); got++ }
            }
          }
          if (got) resolvers.push(dohUrl(base, domain))
        })
        // 单个 resolver 失败忽略（另一个可能成功）；全部失败 = 返回空，候选链保持原样
        .catch(() => {})
    )
  )
  return { ips: ips, resolvers: resolvers, originByIp: originByIp }
}
// 解析全部 DOH_DOMAINS（并行），返回 { [domain]: IP[] }；同时更新来源追踪
// force=true 跳过 TTL 缓存重新解析：verifyIps 要的是「此刻的真实 A 记录」，用几分钟前的
// 缓存去否定用户手填的 IP 会得出错误结论
async function dohIps(force) {
  const now = Date.now()
  if (!force && now - dohCache.at < DOH_TTL_MS) return dohCache.byDomain
  const results = await Promise.all(DOH_DOMAINS.map((d) => dohResolveDomain(d)))
  const byDomain = {}
  const originByIp = {}
  const resolvers = []
  DOH_DOMAINS.forEach((d, i) => {
    const r = results[i]
    if (r.ips.length) {
      byDomain[d] = r.ips
      Object.assign(originByIp, r.originByIp)
      resolvers.push.apply(resolvers, r.resolvers)
      log('[whale][ghaccel] DoH 解析', d, '得', r.ips.join(', '))
    }
  })
  if (Object.keys(byDomain).length) {
    dohCache = { at: now, byDomain: byDomain, originByIp: originByIp }
    // 来源追踪：记录这次实时解析实际返回结果的 DoH 入口与逐域名 IP
    lastTrace.dohResolvers = resolvers
    lastTrace.dohByDomain = Object.assign({}, byDomain)
    lastTrace.dohOrigin = Object.assign({}, originByIp)
  }
  return byDomain
}
// 逐域名选可达 IP：候选链 = DoH 实时解析 > 传入表（含 GitHub520 源）> github.com 内部兜底，
// 同一 (域名,IP) 只测一次。没有内置快照兜底：源表某域名给了被墙的 IP（GitHub520 每天更新、
// 总有人给你墙掉的地址）时，该域名可能整个落选 —— 这是刻意的取舍，宁可不写这条也不要长期
// 写一批可能过时的地址（过时地址实测就是「写进去了但打不开」，比不写更难排查）。
async function filterReachable(ips, op) {
  const list = normIps(ips)
  const byDomain = {}
  for (const it of list) if (it && it.domain && !byDomain[it.domain]) byDomain[it.domain] = it.ip
  const dohBy = await dohIps() // 提前解析一次，供 github.com 等域名的候选链最前端插入
  opStep(op, 'DoH 实时解析 ' + DOH_DOMAINS.join('、'), Object.keys(dohBy).length ? 'done' : 'skip',
    Object.keys(dohBy).length ? Object.keys(dohBy).map((d) => d + ' → ' + dohBy[d].join('/')).join('；') : '未取到 A 记录，改用源表/当前表')
  // IP → DoH 厂商：来源列要写到「这个 IP 是哪家解析出来的」，不能只写「DoH 实时解析」
  const dohOrigin = dohCache.originByIp || {}
  const cands = []
  const seenKey = new Set()
  for (const d of GH_DOMAINS) {
    const chain = []
    const src = [] // 与 chain 一一对应的来源标记（来源追踪用）
    const push = (ip, source) => {
      if (!ip || chain.includes(ip)) return
      chain.push(ip)
      src.push(source)
    }
    // DoH 实时 A 记录放最前（优先级最高）：它最新鲜，且是唯一能绕开静态表过时问题的来源。
    // 来源里点名是哪个 DoH 入口给的（dohBy[d] 只存 IP，这里按 IP 反查 dohOrigin 拿出处）
    for (const ip of dohBy[d] || []) push(ip, 'DoH 实时解析 · ' + (dohOrigin[ip] || 'cloudflare/google 等'))
    // 传入表放其后。**降权**：社区源表（GitHub520）是人工维护的静态快照，时效性与地域性都
    // 不可控，实测大量 IP「能连但打不开」。它只在 DoH 没覆盖到这个域名时才有机会当首选，
    // 且当前位置固定为「实时解析之后的第一个候选」—— 即 DoH 有结果时它只作为回退。
    if (byDomain[d]) {
      // 传入表若刚由 refreshIps 产出，沿用其来源（社区源表/当前表）；否则按配置表算
      const prev = lastTrace.byDomain[d]
      const source = prev && prev.ip === byDomain[d] ? prev.source : '当前 IP 表（手填）'
      push(byDomain[d], source)
    }
    // github.com 再追加内部兜底候选（见 GH_COM_EXTRA_IPS），放最后一位优先级最低。
    // 兜底**不影响用户表**：这里只是「探测时多一个候选」，不能把兜底 IP 写回 cfg.ghAccelIps
    // （实测过旧代码这么干：用户手填的 20.205 打不开，重写一次就被换成兜底 IP，
    // 「填的 IP 用不上」且来源日志显示的也不是用户填的值）
    if (d === 'github.com') for (const ip of GH_COM_EXTRA_IPS) push(ip, '内部兜底 · Azure 亚洲边缘')
    chain.forEach((ip, idx) => {
      const key = d + '\u0000' + ip
      if (seenKey.has(key)) return
      seenKey.add(key)
      cands.push({ domain: d, ip: ip, idx: idx, source: src[idx] || '候选链' })
    })
  }
  const results = await Promise.all(cands.map((c) => probeIp(c.ip, c.domain)))
  // 每个域名保留**所有**可达候选（按候选链顺序），而不是只留第一个。
  // 这是 hosts 方案里唯一能拿到「运行期回退」的手段：同一个域名写多行不同 IP，
  // Windows 解析按顺序取第一条 —— 首选 IP 哪天挂了，系统自动落到下一条，
  // 而不是像单条方案那样整个域名打不开且不回落 DNS（语义同「逐个候选试」）
  const byDomFinal = new Map()
  cands.forEach((c, i) => {
    if (!results[i]) return
    if (!byDomFinal.has(c.domain)) byDomFinal.set(c.domain, [])
    byDomFinal.get(c.domain).push(c)
  })
  // github.com 整链全失败时重测一轮：实测同一批 IP 几分钟内 200 ↔ 超时反复横跳，
  // 瞬时抖动下多一次机会；只重试主站，其余域名首轮结论不动
  if (!byDomFinal.has('github.com')) {
    const ghCands = cands.filter((c) => c.domain === 'github.com')
    if (ghCands.length) {
      const retry = await Promise.all(ghCands.map((c) => probeIp(c.ip, c.domain)))
      // 收集可达的再一次性落 Map（不用 forEach 边判边 push：那种写法靠 has() 当门闩，
      // 第一条就把键建好了，后面几条会全部漏进去，语义上等价于这里的结果但极难看懂）。
      // 注意此处**不会**与首轮结论混：能进到这个分支就说明首轮 github.com 一条都没过，
      // 所以 set 是覆盖空位、不是覆盖已有结果；retry 返回布尔，故不涉及 idx 排序问题
      const alive = ghCands.filter((c, i) => retry[i])
      if (alive.length) byDomFinal.set('github.com', alive)
    }
  }
  // 每个域名的候选按 idx 排序（保住「DoH 实时 > 传入表 > 兜底」的优先级语义）
  for (const arr of byDomFinal.values()) arr.sort((a, b) => a.idx - b.idx)
  // 来源追踪：本次过滤后每个域名最终选中的 IP + 来源。byDomain 只在「选中值确实来自用户表」
  // 时才并入，避免把兜底/实时解析的结果伪装成用户的表内容
  lastTrace.at = Date.now()
  const traceBy = {}
  for (const arr of byDomFinal.values()) traceBy[arr[0].domain] = { ip: arr[0].ip, source: arr[0].source }
  lastTrace.byDomain = Object.assign({}, lastTrace.byDomain, traceBy)
  // 展平成写入用的 { domain, ip } 列表：同域名多行，顺序即 hosts 里的优先级
  const reach = []
  for (const arr of byDomFinal.values()) for (const c of arr) reach.push({ domain: c.domain, ip: c.ip })
  const dropped = GH_DOMAINS.length - byDomFinal.size
  const extra = reach.length - byDomFinal.size
  opStep(op, '逐个候选 IP 做 HTTPS 探测 + 证书 SAN 校验（共 ' + cands.length + ' 个候选，超时 ' + PROBE_TIMEOUT_MS / 1000 + 's）', 'done',
    '选中 ' + byDomFinal.size + ' 个域名' + (extra > 0 ? '（含 ' + extra + ' 条备用 IP 一并写入，主 IP 失效时系统自动回退）' : '')
      + (dropped > 0 ? '，' + dropped + ' 个域名无可达 IP 被丢弃' : ''))
  return reach
}

// 校验 IP 表：逐条探测（与写入前过滤共用同一套 probeIp，口径一致），把不可达的挑出来
// 供设置页「一键清掉」。刻意不在这里直接改配置：删表是破坏性操作，要由用户在设置页确认；
// 宿主只负责给出结论。判「是否已过时」用强制刷新的实时 A 记录，不用 TTL 缓存
async function verifyIps(ips, op) {
  const list = normIps(ips)
  if (!list.length) {
    opStep(op, '读取待校验的 IP 表', 'skip', 'IP 表为空')
    return { ok: true, results: [], bad: [], stale: [], checkedAt: Date.now() }
  }
  opStep(op, '读取待校验的 IP 表', 'done', list.length + ' 条')
  const dohBy = await dohIps(true)
  opStep(op, '强制刷新实时 A 记录（用于判断 IP 是否已过时）', Object.keys(dohBy).length ? 'done' : 'skip',
    Object.keys(dohBy).length ? Object.keys(dohBy).map((d) => d + ' → ' + dohBy[d].join('/')).join('；') : '未取到，仅按探测结果判定')
  const results = await Promise.all(list.map((it) => probeIp(it.ip, it.domain)))
  const out = list.map((it, i) => ({ domain: it.domain, ip: it.ip, ok: !!results[i] }))
  // 「命中当前实时 A 记录」的 IP 单独标出来：这类 IP 探测可能因瞬时抖动失败，
  // 但它正是 DNS 此刻的答案，删掉纯属误伤，界面据此不推荐删除
  const bad = out.filter((r) => !r.ok && !(dohBy[r.domain] || []).includes(r.ip))
  const stale = out.filter((r) => !r.ok && (dohBy[r.domain] || []).includes(r.ip))
  const good = out.length - bad.length - stale.length
  opStep(op, '逐条 HTTPS 探测（超时 ' + PROBE_TIMEOUT_MS / 1000 + 's）', 'done', '可达 ' + good + ' 条 / 不可达 ' + bad.length + ' 条 / 探测失败但仍是实时 A 记录 ' + stale.length + ' 条')
  log('[whale][ghaccel] 校验 IP 表', out.length, '条，可达', good, '条，不可达', bad.length, '条，实时 A 记录但探测失败', stale.length, '条')
  return { ok: true, results: out, bad: bad, stale: stale, checkedAt: Date.now() }
}

// 开启（含「重新写入 hosts」）：op 传入时同步写操作日志，让设置页看到每一步在干什么
async function enable(ips, opts, op) {
  // 开启流程：① 拉社区源与「探测」并行起跑 → ② DoH 实时解析 + 逐 IP 探测筛可达
  // （刷新回来若首轮 github.com 未达标，再补测一轮）→ ③ 全不可达拒绝写入（不弹 UAC、不留坏块）
  // → ④ UAC 写块
  // 注意顺序：①与②必须并行，串行会让用户先干等拉源（最长 15s）再等探测 —— 这正是「每次都好慢」的主因。
  const refresh = opts && (typeof opts === 'object' ? !!opts.refresh : !!opts)
  let table = normIps(ips)
  opStep(op, '载入待写入的 IP 表', table.length ? 'done' : 'skip', table.length ? table.length + ' 条' : '当前 IP 表为空')
  // 并行地拉社区源（最长 15s），但**不再串行等它**：原来 refresh 后才 filterReachable，
  // 用户要连续等「拉源（可达十几秒）→ DoH 解析 → 探测」三段。现在两件事同时起跑，
  // 探测先跑完就能先出结论；源回来后再补一轮新候选的探测。
  // 为什么敢并行：社区源在候选链里已降权到 DoH 之后（见 filterReachable），它的作用只是
  // 「DoH 没覆盖时兜底 + 提供备用 IP」。首轮用当前表 + DoH 已足以判断主站是否可达，
  // 源只影响「多加几条备用」，不值得让用户为它多等十几秒。
  const freshPromise = refresh ? refreshIps(table, op) : null
  let reachable = await filterReachable(table, op)
  // 源回来了：把它新给的 IP 再探一轮，补进结果（只为「该域名在首轮没达标」时才需要，
  // 若首轮已有 github.com 可达就不必再等这批备用 IP，直接用首轮结论写块）
  if (freshPromise) {
    const fresh = await freshPromise
    const needMore = !reachable.some((it) => it.domain === 'github.com')
    if (fresh.ok && needMore) {
      const merged = fresh.updated
      const have = new Set(reachable.map((it) => it.domain + '\u0000' + it.ip))
      const extra = merged.filter((it) => !have.has(it.domain + '\u0000' + it.ip))
      if (extra.length) {
        opStep(op, '用社区源新 IP 补测一轮', 'done', extra.length + ' 条新候选（首轮 github.com 未达标）')
        const more = await filterReachable(merged, op)
        reachable = more
      }
    } else if (fresh.ok) {
      opStep(op, '社区源已返回（首轮已达标，跳过补测）', 'skip',
        '新表 ' + fresh.updated.length + ' 条仅作后续刷新用，本次不再多等')
    }
  }
  const hasGithubCom = reachable.some((it) => it.domain === 'github.com')
  if (!reachable.length || !hasGithubCom) {
    // github.com 是主站：块里缺它等于白开——它仍走被污染的 DNS，用户看到的就是
    // 「已生效 N 个域名但 github.com 打不开」（实测踩过，13/21 写入、github.com 被丢）。
    // 因此必须等 github.com 有可达 IP 才写；其余域名再通也不写，避免假成功误导。
    const why = hasGithubCom
      ? '当前网络下这些 IP 都不可达，未写入 hosts。可能是 IP 表过时（可先点「刷新 IP 表」再重试），也可能当前网络直连 GitHub 不通'
      : 'github.com 当前所有候选 IP 都不可达，未写入 hosts（其余域名可达但主站打不开等于白开）。可稍后重试，或点「刷新 IP 表」后再开'
    logErr('[whale][ghaccel] 拒绝写入 hosts', why, '可达域名数', reachable.length, '含 github.com', hasGithubCom)
    opStep(op, '写入前把关', 'fail', hasGithubCom ? '所有候选 IP 都不可达，放弃写入' : 'github.com 无可达 IP，放弃写入（主站打不开等于白开）')
    return { ok: false, canceled: false, error: why }
  }
  const ghIpCount = reachable.filter((it) => it.domain === 'github.com').length
  opStep(op, '写入前把关', 'done', 'github.com 有可达 IP，共 ' + reachable.length + ' 条候选写入 hosts'
    + (ghIpCount > 1 ? '（github.com 含 ' + ghIpCount + ' 个 IP，做 first-match 回退）' : ''))
  const r = await applyHostsBlock('enable', reachable, op)
  // 让设置页把实际写入的表同步回配置（刷新后表可能变了）。**只回写用户表本身的 IP**：
  // 兜底 / DoH 实时解析的 IP 只是探测时的候选，一旦回写成配置，用户手填的 IP 会被悄悄替换，
  // 且来源日志里显示的也不再是用户填的值 —— 表现就是「我填的 IP 根本没用上」。
  // 判据用「该 IP 是否本来就出现在传入表里」，不能像旧代码那样按 domain 查主 IP 的来源
  // （多行回退后，同一域名的备用 IP 会被误判成主 IP 的来源而整体排除）
  if (r.ok) r.ips = reachable.filter((it) => table.some((t) => t.domain === it.domain && t.ip === it.ip))
  return r
}
function disable(op) {
  opStep(op, '准备移除 hosts 标记块', 'done', '关闭加速会完整还原开启前的 hosts 内容')
  return applyHostsBlock('disable', [], op)
}

module.exports = {
  HOSTS_PATH,
  hostsBackupPath,
  ghAccelStatus,
  ghAccelTrace,
  ghAccelOpLogs,
  clearGhAccelOpLogs,
  opStart,
  opStep,
  opEnd,
  scanConflicts,
  probeConnectivity,
  refreshIps,
  verifyIps,
  enable,
  disable,
}

// 最近一次获取过程的来源追踪（内存态；每次开启/刷新/重写更新，重开插件即清空）
function ghAccelTrace() {
  const dohByDomain = {}
  for (const d of Object.keys(lastTrace.dohByDomain)) dohByDomain[d] = lastTrace.dohByDomain[d].slice()
  return {
    at: lastTrace.at,
    dohResolvers: lastTrace.dohResolvers.slice(),
    dohByDomain: dohByDomain,
    dohOrigin: Object.assign({}, lastTrace.dohOrigin),
    refreshUrl: lastTrace.refreshUrl,
    byDomain: Object.assign({}, lastTrace.byDomain),
  }
}
