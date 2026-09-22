/*
 * dsh 只读诊断（CommonJS）。
 *
 * 设计依据：docs/plan-dsh-diagnostics.md（阶段一，D1–D27）。核心约束：
 *   1. **只读** —— detect 绝不写入任何文件（阶段三才做写入与恢复，D2）。
 *   2. **单项抛错不算整体失败** —— 每项独立 try/catch，失败只标记该项（§3.2 约定 2）。
 *   3. **平台稳定优先**（D25/D26/D27）—— 按「平台语义依赖从零到有」分梯队：
 *      第一梯队 C2/C3/C4（纯文本 + 行级字符串），第二梯队 C1（包身份指纹），
 *      第三梯队 C5（尽力而为，判不出来就报"无法判定"，绝不给错误结论）。
 *   4. **零新 npm 依赖**（D9）—— YAML 只做行级字符串扫描，不 parse（§5.3）。
 *
 * 本模块依赖 util.js（叶子模块）与 dsh.js（只调其已导出的 probePort / snapshot，
 * 不改其导出面，D15）。不 require log.js 之外的宿主能力。
 */
const fs = require('fs')
const path = require('path')
const { K } = require('./constants')
const { logErr } = require('./log')
const { num, homeDir, readTextSafe, readJsonSafe, normalizePath } = require('./util')
const { probePort, snapshot } = require('./dsh')

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────
// 缓存 TTL（D6）：遍历 node_modules（C1）与命令探测（C5）都不便宜，
// 不加 TTL 会让每次开设置页都付一遍成本
const DIAGNOSE_TTL_MS = 60 * 1000
// UI 明细最多显示 5 行（D12）；截断只在渲染层做，缓存里存完整结果
const FINDING_MAX_SHOWN = 5

// ──────────────────────────────────────────────
// 纯函数（供 test/diagnostics.test.mjs 直接喂样例，D13）
// ──────────────────────────────────────────────

// 「这次调用能不能直接用缓存」的判定。
//
// ⚠️ 抽成纯函数是因为它踩过坑：设置页两个刷新按钮原先都把 force 写死成 true，
// 于是缓存分支永远进不去、TTL 形同虚设，同一秒内连点两次也照跑两遍完整扫描
// （诊断要遍历 node_modules，转储要 spawn 两次子进程）。这类「接线错误」在
// 界面里看不出来 —— 只有把判定钉死成可单测的函数，才能在他处接线时发现问题。
// force（用户主动点了「强制重跑」）与 profile 变更都必须作废缓存。
function cacheHit(hit, ttlMs, now, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (!hit || typeof hit !== 'object') return false
  if (o.force === true) return false
  if (o.profile != null && String(hit.profile || '') !== String(o.profile)) return false
  const at = Number(hit.at)
  if (!Number.isFinite(at) || at <= 0) return false
  return Number(now) - at < Number(ttlMs)
}

// severity → 文本标记（§3.6 映射表）。
// 注意「有结论：无事」([✓]) 与「没查出来」(warning→[!]) 必须区分开（D26）
function markOf(result) {
  if (!result || typeof result !== 'object') return '[✗]'
  if (result.threw) return '[✗]'
  const lv = severestLevel(result.findings)
  if (lv === 'error') return '[✗]'
  if (lv === 'warn') return '[!]'
  return '[✓]'
}

// 取一组 finding 里最严重的一级。empty → ''（无 finding）
function severestLevel(findings) {
  const list = Array.isArray(findings) ? findings : []
  let has = ''
  for (const f of list) {
    const lv = String((f && f.level) || '')
    if (lv === 'error') return 'error'
    if (lv === 'warn') has = 'warn'
  }
  return has
}

// 单个检查项结果 → severity（供折叠头统计「N 项通过 · M 项异常」）
// D26 连带：C5 的「无法判定」是 warning，不得让整轮 ok:false
function severityOf(result) {
  if (!result || typeof result !== 'object') return 'critical'
  if (result.threw) return 'critical'
  const lv = severestLevel(result.findings)
  if (lv === 'error') return 'critical'
  if (lv === 'warn') return 'warning'
  return 'ok'
}

// 按 severity 倒序（D12）：error 在最前，其次 warn，最后无 finding 的 [✓] 项。
// 同级保持原有顺序（stable），让结果在多次刷新间位置稳定
function orderResults(results) {
  const list = Array.isArray(results) ? results.slice() : []
  const rank = (r) => {
    const s = severityOf(r)
    return s === 'critical' ? 0 : (s === 'warning' ? 1 : 2)
  }
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (rank(a.r) - rank(b.r)) || (a.i - b.i))
    .map((x) => x.r)
}

// ── C3：cordis.patch.yml 行级扫描（D9：只做行级字符串操作，不 parse）──
// 检测四类结构性异常：
//   1. 缩进跳变（比上一有效行深 2 级以上，或用了 Tab）
//   2. `- id:` 缺值 / 值被引号截断
//   3. `!!js` 标签未闭合（被行内截断）
//   4. 重复 id
// 返回 Finding[]（level ∈ ok/warn/error）
function scanPatchLines(text) {
  const findings = []
  const src = String(text == null ? '' : text)
  if (!src.trim()) return findings
  const lines = src.split(/\r?\n/)
  const seenIds = Object.create(null)
  let prevIndent = -1
  let prevLineNo = 0
  let idCount = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const lineNo = i + 1
    // 空行 / 纯注释行不参与缩进与结构判断
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // ── 缩进 ──
    const indentStr = raw.slice(0, raw.length - raw.replace(/^[ \t]*/, '').length)
    if (indentStr.indexOf('\t') >= 0) {
      findings.push({ level: 'error', text: '第 ' + lineNo + ' 行用了 Tab 缩进', hint: 'YAML 禁止 Tab 缩进，请改成空格' })
    }
    const indent = indentStr.replace(/\t/g, '  ').length
    // 跳变：比上一有效行深超过 2 级，且不是进入列表项的子键
    if (prevIndent >= 0 && indent - prevIndent > 2 && !trimmed.startsWith('-')) {
      findings.push({
        level: 'warn',
        text: '第 ' + lineNo + ' 行缩进从 ' + prevIndent + ' 跳到 ' + indent,
        hint: '（上一有效行是第 ' + prevLineNo + ' 行）YAML 缩进跳变常导致解析失败，请核对',
      })
    }
    prevIndent = indent
    prevLineNo = lineNo

    // ── `- id:` 缺值 / 被截断 ──
    const idm = /^-\s*id\s*:\s*(.*)$/.exec(trimmed)
    if (idm) {
      idCount++
      const val = idm[1].trim()
      // 去掉成对引号后再看是否为空
      const bare = val.replace(/^(['"])(.*)\1$/, '$2').trim()
      if (!val) {
        findings.push({ level: 'error', text: '第 ' + lineNo + ' 行的 `- id:` 没有值', hint: 'patch 必须指明要替换哪个条目 id' })
      } else if (!bare) {
        findings.push({ level: 'error', text: '第 ' + lineNo + ' 行的 `- id:` 只有引号没有内容', hint: '引号被截断，值丢失' })
      } else if (seenIds[bare]) {
        findings.push({
          level: 'warn',
          text: '第 ' + lineNo + ' 行重复的 id "' + bare + '"',
          hint: '第 ' + seenIds[bare] + ' 行已出现过；patch 按 id 整体替换，重复项只有最后一个生效',
        })
      } else {
        seenIds[bare] = lineNo
      }
    }

    // ── `!!js` 标签未闭合 ──
    if (/!!js\b/.test(trimmed)) {
      const q = (trimmed.match(/['"]/g) || []).length
      if (q % 2 === 1) {
        findings.push({
          level: 'error',
          text: '第 ' + lineNo + ' 行的 `!!js` 引号未闭合',
          hint: '行内被截断，YAML 解析会失败',
        })
      }
    }
  }

  // 结构性提示：文件里有内容但一个 id 都没有
  if (idCount === 0 && findings.length === 0) {
    findings.push({
      level: 'warn',
      text: 'patch 文件里没有任何 `- id:` 条目',
      hint: 'cordis.patch.yml 靠 id 定位要替换的条目；空 patch 不会生效（若本意如此可忽略）',
    })
  }
  return findings
}

// ── ctx 组装（D13：让 C1–C5 的 detect(ctx) 可脱离真实环境被调用）──
// input = { home, nodeVersion, dshVersion, dshSource, profile, port, portState }
function buildContext(input) {
  const i = input && typeof input === 'object' ? input : {}
  return {
    home: String(i.home || ''),
    nodeVersion: String(i.nodeVersion || ''),
    dshVersion: String(i.dshVersion || ''),
    dshSource: String(i.dshSource || ''),
    profile: String(i.profile || 'web'),
    port: Number.isFinite(i.port) ? i.port : 3080,
    portState: i.portState || null, // { pid, name, occupiedByOther, external, externalPid }
  }
}

// ── 从包目录读身份指纹（D25 核心）──
// 只认 name + version，**不做任何路径比较** —— realpath 在 Windows/macOS 会静默漏报
function readFingerprint(pkgDir) {
  const pkg = readJsonSafe(path.join(pkgDir, 'package.json'))
  if (!pkg) return null
  const name = String(pkg.name || '').trim()
  const version = String(pkg.version || '').trim()
  if (!name && !version) return null
  return { name, version, dir: normalizePath(pkgDir) }
}

// 指纹相同即「同一包装了两遍」（D25）
function sameFingerprint(a, b) {
  if (!a || !b) return false
  // name 必须相同；version 相同即视为同一份（无法区分「两份完全相同的合法安装」，罕见且报出无害）
  return a.name === b.name && a.version === b.version
}

// ──────────────────────────────────────────────
// 检查项
// ──────────────────────────────────────────────
const CHECKS = []

// ── C1 duplicate-modules（D10 + D25：两层判定）──
// ① profiles/<n>/package.json 的 dependencies 是否声明 @deepseek-ai/*
// ② 该包的身份指纹（name+version）是否与全局/插件那份相同 → 同包装了两遍
// 两层都命中 = error；仅① = warn
CHECKS.push({
  id: 'duplicate-modules',
  title: '重复的 @deepseek-ai 模块',
  severity: 'critical',
  fixable: false,
  detect(ctx) {
    const findings = []
    const home = ctx.home
    if (!home) return { ok: true, summary: '未定位 $DSH_HOME，跳过', findings }
    const profileDir = path.join(home, 'profiles', ctx.profile)
    if (!fs.existsSync(profileDir)) {
      return { ok: true, summary: 'profile 目录不存在（' + ctx.profile + '），跳过', findings }
    }
    const profilePkg = readJsonSafe(path.join(profileDir, 'package.json'))
    if (!profilePkg) {
      return { ok: true, summary: 'profile 无 package.json，跳过', findings }
    }
    // ① 声明了哪些 @deepseek-ai/* 依赖
    const deps = Object.assign({}, profilePkg.dependencies, profilePkg.devDependencies)
    const declared = Object.keys(deps).filter((n) => n.indexOf('@deepseek-ai/') === 0)
    if (!declared.length) {
      return { ok: true, summary: 'profile 未声明 @deepseek-ai 依赖，无分裂风险', findings }
    }
    // ② 逐个体检：profile 本地那份 与 全局/插件那份 的指纹是否相同
    const localMods = path.join(profileDir, 'node_modules')
    // 全局那一份的位置：从诊断上下文里拿不到 pkgDir，只能扫候选目录
    const globalRoots = globalModuleRoots()
    for (const name of declared) {
      const localDir = path.join(localMods, name)
      const local = readFingerprint(localDir)
      if (!local) {
        findings.push({
          level: 'warn',
          text: '声明了 ' + name + ' 但 profile 下没有安装',
          hint: '未安装不会造成路径分裂，但可能起不来（该依赖缺失）',
        })
        continue
      }
      for (const root of globalRoots) {
        const other = readFingerprint(path.join(root, name))
        if (!other) continue
        if (sameFingerprint(local, other)) {
          findings.push({
            level: 'error',
            text: '同一份 ' + name + '@' + local.version + ' 被装了两遍',
            hint: 'profile: ' + local.dir + ' ／ 另一份: ' + other.dir
              + ' —— 会产生第二份 cordis，导致 "prompt section ... is already registered"，所有 preset 挂载失败',
          })
        } else {
          findings.push({
            level: 'warn',
            text: name + ' 存在两份不同版本（profile ' + local.version + ' ／ 另一处 ' + other.version + '）',
            hint: 'profile: ' + local.dir + ' ／ 另一处: ' + other.dir,
          })
        }
        break // 找到一个"另一份"就够，避免同版本多路径刷屏
      }
    }
    if (!findings.length) {
      return { ok: true, summary: '声明 ' + declared.length + ' 个 @deepseek-ai 依赖，未发现装了两遍', findings }
    }
    return {
      ok: false,
      summary: findings.length + ' 处可疑（' + declared.length + ' 个已声明依赖）',
      findings,
    }
  },
})

// 全局/插件那份 @deepseek-ai 的可能落点。
// 刻意不复用 dsh.js 内部函数（D15 不改其导出面），这里只做只读探测
function globalModuleRoots() {
  const out = []
  const add = (d) => { if (d && out.indexOf(d) < 0) out.push(d) }
  const nodeDir = path.dirname(process.execPath)
  add(path.join(nodeDir, 'node_modules'))
  add(path.join(nodeDir, '..', 'node_modules'))
  add(path.join(nodeDir, '..', 'lib', 'node_modules'))
  add(path.join(nodeDir, 'node_global', 'node_modules'))
  add(path.join(nodeDir, 'npm-global', 'node_modules'))
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules'))
  add(path.join(process.env.HOME || process.env.USERPROFILE || '', '.npm-global', 'lib', 'node_modules'))
  add('/usr/local/lib/node_modules')
  add('/usr/lib/node_modules')
  return out.filter((d) => d && fs.existsSync(d))
}

// ── C2 patch-entry-missing ──
// 本机实测 dsh 报错原文（dump 输出的第一行，走 stderr）：
//   dsh: [...\profiles\web\cordis.patch.yml] patch: entry "config-manager" not found
//
// ⚠️⚠️ 判据三次翻车，最终定为：**采信 dsh 自己打印的 not found 警告行**。
// 前两次都栽在「自己造一份已知 id 清单」上（dependencies 包名 → 11 条全误报；
// 上溯 bundle 的 dsh.bundle.patch insert id → 剩 2 条误报），第三次改成「比对 dump 的
// entries」又只剩一半对 —— 因为 **dump 的条目清单本身不完整**：
// `mnemon-bundle` 的 `config:` 列表里嵌套了 8 个子条目（mnemon、mnemon-source-*、
// mnemon-strategy-*），缩进 4 空格写在 config 内层，parseDump 只认行首 `^- id:` 故一个都没进
// entries。本机真实情况是：patch 共 12 条，其中 **11 条合法、只有 config-manager 真的不存在**
// —— 而「比对 entries」会报 9 条，8 条假阳性 + 1 条真阳性，**纯粹是巧合才没漏掉真的那个**。
//
// 结论：任何「自己重建组装树再比对」的路子都走不通（要么漏、要么错）。
// dsh 解析 patch 时**已经把结论打出来了**，直接采信即可：
//   · 拿到 dump → 用 dsh 报告的 not-found 列表当 findings，报几条就是几条 [✗]
//   · 拿不到 dump → [!]「无法判定」（dsh 没装／没跑过转储），绝不猜
// 这样判据与 dsh 的行为**定义上一致**，不存在漏报或误报。
CHECKS.push({
  id: 'patch-entry-missing',
  title: 'patch 条目指向不存在的 id',
  severity: 'critical',
  fixable: false,
  detect(ctx) {
    const findings = []
    const home = ctx.home
    if (!home) return { ok: true, summary: '未定位 $DSH_HOME，跳过', findings }
    // ⚠️ patch 文件在 profiles/<n>/ 下，不在 $DSH_HOME 根下。
    // 原先写成 path.join(home, 'cordis.patch.yml')，于是对本机这种「profile 内建 patch」
    // 的布局恒 ENOENT，C2/C3 一律误报「未使用 patch，跳过」—— 两个 [✓] 是假通过。
    // 同一函数下面读 package.json 用的就是 profiles/<n>/，两处基准必须一致。
    const patchFile = path.join(home, 'profiles', ctx.profile, 'cordis.patch.yml')
    const r = readTextSafe(patchFile)
    if (!r.ok) {
      if (r.reason) {
        // D23：非 ENOENT 的读取失败必须留痕并回报，不能笼统说"缺失"
        logErr('[whale][diagnostics] 读 cordis.patch.yml 失败', r.reason)
        findings.push({ level: 'warn', text: 'cordis.patch.yml 存在但读不到（' + r.reason + '）', hint: '诊断无法确认 patch 条目' })
        return { ok: false, summary: 'patch 文件读不到（' + r.reason + '）', findings }
      }
      return { ok: true, summary: '无 cordis.patch.yml（未使用 patch，跳过）', findings }
    }
    const ids = extractPatchIds(r.text)
    if (!ids.length) return { ok: true, summary: 'patch 里没有条目，跳过', findings }

    // dsh 自己报告的 not-found 列表 —— 唯一权威判据（见上方长注释）
    const warned = dshNotFoundIds(ctx)
    if (!warned) {
      return {
        ok: false,
        summary: '无法判定 ' + ids.length + ' 个 patch 条目（先跑一次配置转储）',
        findings: [{
          level: 'warn',
          text: '本机有 ' + ids.length + ' 个 patch 条目，但判定它们是否有效需要 dsh 自己跑一遍 patch',
          hint: '去「dsh 配置转储」卡片点一次「重新读取」，dsh 解析 patch 时会打印 '
            + '`patch: entry "X" not found`，诊断据此判定。在此之前不敢下结论 —— '
            + 'dump 的条目清单并不完整（嵌套子条目不在其中），自己比对必然误报',
        }],
      }
    }
    if (!warned.length) {
      return { ok: true, summary: ids.length + ' 个 patch 条目 dsh 全部认得', findings }
    }
    // 行号靠 patch 文件里同 id 的位置补：dsh 只说 id，不说第几行
    const lineOf = {}
    for (const e of ids) if (lineOf[e.id] == null) lineOf[e.id] = e.line
    for (const id of warned) {
      const at = lineOf[id]
      findings.push({
        level: 'error',
        text: at ? 'patch 第 ' + at + ' 行的 id "' + id + '" 在组装树里找不到'
          : 'patch 的 id "' + id + '" 在组装树里找不到',
        hint: 'dsh 已明确报告：`patch: entry "' + id + '" not found`，这条 patch 不会生效。'
          + '请核对拼写，或从「dsh 配置转储」里确认该条目实际叫什么',
      })
    }
    return { ok: false, summary: findings.length + ' 个 patch 条目对不上', findings }
  },
})

// 取 dsh 自己报告的 not-found id 列表。
// 返回 null = 拿不到 dump（没装 dsh / 没跑过转储 / 缓存结构不符）→ 调用方走「无法判定」；
// 返回 [] = dsh 跑过了且没报任何 not found。
// ⚠️ 必须区分这两种：把「没跑过」当成「没有 not found」是假通过，
// 当成「全都对不上」是误报（前两版判据各栽一个），故用 null 显式表达「不知道」。
function dshNotFoundIds(ctx) {
  if (typeof utools === 'undefined') return null
  try {
    const v = require('./dsh-dump').readCache()
    if (!v || !v.ok) return null
    // 缓存是 per-profile 的：换 profile 后旧缓存不能拿来判新 profile
    if (v.profile != null && String(v.profile) !== String(ctx.profile)) return null
    // warnings 是 v1.6.2 才写进缓存的字段。老缓存没有它 → 按「拿不到」处理，
    // 让用户重跑一次转储；**不能**当成空数组（那会把所有 id 判成合法）
    if (!Array.isArray(v.warnings)) return null
    const out = []
    for (const w of v.warnings) {
      const id = String((w && w.id) || '')
      if (id && out.indexOf(id) < 0) out.push(id)
    }
    return out
  } catch (err) {
    logErr('[whale][diagnostics] 读配置转储缓存失败', (err && err.message) || '')
    return null
  }
}

// 抽出 patch 里的 `- id: X` 及其行号
function extractPatchIds(text) {
  const out = []
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^-\s*id\s*:\s*(.*)$/.exec(lines[i].trim())
    if (!m) continue
    const bare = m[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    if (bare) out.push({ id: bare, line: i + 1 })
  }
  return out
}

// ── C3 patch-syntax（第一梯队：纯行级字符串）──
CHECKS.push({
  id: 'patch-syntax',
  title: 'cordis.patch.yml 行级语法',
  severity: 'warning',
  fixable: false,
  detect(ctx) {
    const home = ctx.home
    if (!home) return { ok: true, summary: '未定位 $DSH_HOME，跳过', findings: [] }
    // 同 C2：patch 文件在 profiles/<n>/ 下（原先少一层，导致 C3 从未真正扫过文件）
    const r = readTextSafe(path.join(home, 'profiles', ctx.profile, 'cordis.patch.yml'))
    if (!r.ok) {
      if (r.reason) {
        logErr('[whale][diagnostics] 读 cordis.patch.yml 失败（语法扫描）', r.reason)
        return { ok: false, summary: 'patch 文件读不到（' + r.reason + '）', findings: [] }
      }
      return { ok: true, summary: '无 cordis.patch.yml（跳过）', findings: [] }
    }
    const findings = scanPatchLines(r.text)
    if (!findings.length) return { ok: true, summary: '行级结构正常', findings }
    const errs = findings.filter((f) => f.level === 'error').length
    return {
      ok: false,
      summary: errs ? errs + ' 处语法问题' : findings.length + ' 处可疑缩进/结构',
      findings,
    }
  },
})

// ── C4 settings-yaml（第一梯队）──
// 只做「能否读到 + 行级结构是否正常」，不做完整 YAML 解析（D9）
CHECKS.push({
  id: 'settings-yaml',
  title: '$DSH_HOME/settings.yaml',
  severity: 'warning',
  fixable: false,
  detect(ctx) {
    const home = ctx.home
    if (!home) return { ok: true, summary: '未定位 $DSH_HOME，跳过', findings: [] }
    const file = path.join(home, 'settings.yaml')
    const r = readTextSafe(file)
    if (!r.ok) {
      if (r.reason) {
        logErr('[whale][diagnostics] 读 settings.yaml 失败', r.reason)
        return { ok: false, summary: 'settings.yaml 读不到（' + r.reason + '）', findings: [] }
      }
      return { ok: true, summary: '无 settings.yaml（用默认配置，跳过）', findings: [] }
    }
    const findings = []
    let keys = 0
    const lines = r.text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      // 顶层键：无缩进的 `key:` 形式
      if (/^[A-Za-z0-9_-]+\s*:/.test(raw)) keys++
      if (raw.indexOf('\t') >= 0) {
        findings.push({ level: 'error', text: '第 ' + (i + 1) + ' 行用了 Tab 缩进', hint: 'YAML 禁止 Tab，请改成空格' })
      }
      // 顶层键后面紧跟一个更深缩进的行，但该键没有值也没冒号 —— 典型的键值错位
      if (/^[A-Za-z0-9_-]+\s+\S/.test(raw)) {
        findings.push({
          level: 'warn',
          text: '第 ' + (i + 1) + ' 行疑似漏了冒号',
          hint: raw.trim().slice(0, 60),
        })
      }
    }
    if (!keys && !findings.length) {
      findings.push({ level: 'warn', text: 'settings.yaml 里没读到任何顶层配置项', hint: '文件可能被截断或格式异常' })
    }
    if (!findings.length) {
      return { ok: true, summary: '可读，' + keys + ' 个顶层配置项', findings }
    }
    return { ok: false, summary: findings.length + ' 处可疑', findings }
  },
})

// ── C5 port-3080（第三梯队：尽力而为，D26）──
// 依赖链 tasklist/ps 两套逻辑 + 进程名反推，是本期唯一真正有平台风险的项。
// 降级规则：探测失败 / 无法判定 → warning + reason，**不影响其余四项**，
// 且**不得让整轮 ok:false**。
CHECKS.push({
  id: 'port-3080',
  title: '3080 端口归属',
  severity: 'warning',
  fixable: false,
  detect(ctx) {
    // 注意：portState 由 diagnoseDsh 串行探测后注入（probePort 有全局单例 + busy 标志，
    // 与状态卡共用，不可并发，D15）
    const ps = ctx.portState
    if (!ps) {
      return {
        ok: false,
        summary: '无法判定 ' + ctx.port + ' 端口归属（探测未执行）',
        findings: [{ level: 'warn', text: '端口探测未能执行', hint: '这不影响其余检查项' }],
      }
    }
    if (ps.failed) {
      return {
        ok: false,
        summary: '无法判定 ' + ctx.port + ' 端口归属（' + ps.reason + '）',
        findings: [{ level: 'warn', text: '端口探测失败：' + ps.reason, hint: '这不影响其余检查项' }],
      }
    }
    const findings = []
    if (!ps.pid) {
      return { ok: true, summary: ctx.port + ' 空闲（无进程监听）', findings }
    }
    if (ps.occupiedByOther) {
      findings.push({
        level: 'error',
        text: ctx.port + ' 被非 dsh 进程占用（pid ' + ps.pid + '，' + ps.occupiedByOther + '）',
        hint: 'dsh 启动时会因端口被占而失败；请换端口或结束该进程',
      })
      return { ok: false, summary: ctx.port + ' 被非 dsh 进程占用', findings }
    }
    if (ps.externalPid) {
      findings.push({
        level: 'warn',
        text: ctx.port + ' 上已有 dsh 在跑（外部进程 pid ' + ps.externalPid + '）',
        hint: '不是本插件启动的；插件内点启动会失败，或可改为「接管」这个实例',
      })
      return { ok: false, summary: ctx.port + ' 已有外部 dsh 在运行', findings }
    }
    // 名字像 node/dsh 但**命令行证明它不是 dsh** —— 是别的 Node 程序占了端口。
    // 这是 error：dsh 启动会直接失败，且用户必须换端口或结束它，没有别的出路。
    // 本机实测（2026-09-22）：一个裸 node 探针占 3080 时旧判据报「已有外部 dsh 在运行」(warning)，
    // 用户按提示去「接管」必然失败 —— 漏报了一个真占用。
    if (ps.portDsh === false) {
      findings.push({
        level: 'error',
        text: ctx.port + ' 被非 dsh 的 ' + (ps.name || 'node') + ' 进程占用（pid ' + ps.pid + '）',
        hint: '它不是 dsh（命令行里没有 dsh 特征），dsh 启动会因端口被占而失败；请换端口或结束该进程',
      })
      return { ok: false, summary: ctx.port + ' 被非 dsh 进程占用', findings }
    }
    if (ps.portDsh === true) {
      // 命令行已证明是 dsh，且不是外部 dsh（上面 externalPid 分支已拦）→ 就是本插件这份。
      // 带上 pid：用户对照状态卡（cmd 包装进程）与任务管理器（真正监听的 node）排查时，
      // 只有这个 pid 是「端口上那个人」—— 本机实测状态卡 pid 26916 / 监听者 28216 不一致
      return { ok: true, summary: ctx.port + ' 由本插件的 dsh 监听（' + (ps.name || 'node') + '，pid ' + ps.pid + '）', findings }
    }
    // 命令行拿不到、但进程树证明是本插件 spawn 的后代 —— 也是自己人，报 [✓]。
    // 这条专门修「插件启动的 dsh 被误报成外部进程」：Windows 下命令行的获取可能失败
    // （wmic 已从新版系统移除、powershell CIM 也可能超时），此时**父链证据**是唯一可靠依据，
    // 比命令行更硬 —— 它是插件自己 spawn 出来的，不可能是别人的 dsh。
    if (ps.selfOwned) {
      return { ok: true, summary: ctx.port + ' 由本插件的 dsh 监听（' + (ps.name || 'node') + '，pid ' + ps.pid + '）', findings }
    }
    // ── 走到这里只剩「拿不到命令行」这条 ──
    // ⚠️ 唯一能证明「是本插件的 dsh」的证据是**命令行**（portDsh === true）。
    // 不能拿「名字像 node/dsh」当证据 —— 旧判据正是这么干的，才把一个占着 3080 的
    // 裸 node 探针说成「已有外部 dsh 在运行」（漏报真占用）。名字不像也不等于无事：
    // 那是别的程序占着端口，只是这里拿不到证据说明。两种情况都按 D26 报「无法确认」，
    // 宁可让用户看到 [!]，也不给一个蒙出来的 [✓]。
    const who = ps.name ? ps.name + '（pid ' + ps.pid + '）' : 'pid ' + ps.pid
    return {
      ok: false,
      summary: '无法判定 ' + ctx.port + ' 端口归属（拿不到进程命令行）',
      findings: [{ level: 'warn', text: ctx.port + ' 被 ' + who + ' 占用，但无法确认是不是 dsh', hint: '这不影响其余检查项' }],
    }
  },
})

// ──────────────────────────────────────────────
// 探测端口（串行，D15）
// probePort 内部有全局单例缓存与 busy 标志，与状态卡共用 → 不可并发。
// 这里做一次「排队 + 超时兜底」，保证诊断不会因探测卡住而永久挂起。
// ──────────────────────────────────────────────
function detectPort(port, cb) {
  let done = false
  const finish = (state) => {
    if (done) return
    done = true
    cb(state)
  }
  // 探测本身有 6s execFile 超时，这里再兜一层 8s，覆盖 processName 阶段
  const timer = setTimeout(() => finish({ failed: true, reason: '探测超时' }), 8000)
  try {
    // force=true：诊断必须拿到**本轮新鲜**的探测结果。
    // 默认的排队复用会把调用方挂进 waiters，蹭上正在跑的那一轮 —— 而状态卡的 watchReady
    // 每 1.2s 就探一次，用户点「强制重跑」时极可能撞上它，于是诊断读到的是几毫秒前
    // （当时 dsh 还没 bind 3080）的空结果，界面报「3080 空闲」，而状态卡同时显示「运行中」。
    // 本机实测（2026-09-22）：状态卡 pid 37112、诊断报「3080 空闲」，netstat 显示 28216 在监听。
    probePort(() => {
      clearTimeout(timer)
      try {
        const snap = snapshot()
        // 语义直接沿用 dsh.js 的推导（externalPid / portOccupiedByOther 内部已含
        // 「不是本插件子进程」「进程名像不像 dsh」两层判断），诊断不要自己再判一遍，
        // 否则两处口径漂移会让「状态卡说空闲、诊断说被占」这种自相矛盾出现
        //
        // ⚠️ 不要再把 snap.pid 兜进 pid：那是【本插件 spawn 的子进程】pid，与端口归属无关。
        // 原先写成 `... || (snap.portOther ? num(snap.pid) : 0) || num(snap.pid)`，于是当
        // dsh 正是本插件启动时（externalPid/portOther 都为空），界面会把插件的 cmd.exe
        // 包装进程 pid 当成「占用 3080 的进程」显示出来 —— 本机实测报 pid 26932(cmd.exe)，
        // 而真正监听 3080 的是 9692(node.exe)。pid 宁可为 0（让 C5 走「无法判定」），
        // 也不能给一个错的值。
        finish({
          // 「谁在监听端口」——本插件启的、外部的、别的程序，都算在这里。
          // ⚠️ 不能写成 `externalPid || (portOther ? pid : 0)`：本插件自己启的 dsh 两个都为空，
          // 于是 pid=0，C5 的 `if (!ps.pid)` 判成「3080 空闲（无进程监听）」，
          // 而状态卡同时显示「运行中 · pid 26916」—— 本机实测（2026-09-22）的自相矛盾。
          // snapshot().portPid 才是「端口上有人」的唯一真值。
          pid: num(snap.portPid) || num(snap.externalPid) || (snap.portOther ? num(snap.pid) : 0),
          name: String(snap.portName || snap.externalName || ''),
          occupiedByOther: String(snap.portOther || ''),
          externalPid: num(snap.externalPid),
          running: !!snap.running,
          // 占端口进程的命令行能否证明「是 dsh」：true/false/null（null = 拿不到命令行）。
          // dsh.js 新暴露的 portDsh。缺字段时按 null（判不出来）走「无法确认」，
          // 绝不默认成 true/false —— 猜错一边就变成误报或漏报
          portDsh: snap.portDsh === true ? true : (snap.portDsh === false ? false : null),
          // 端口在监听、且不是外部进程 —— 就是本插件这份 dsh 在服务（C5 据此报正常而非「无法判定」）。
          // 两个来源任一成立就算自己人：
          //   · snap.selfOwned —— 监听 3080 的进程是插件 spawn 进程的后代（父链上溯，2026-09-22 新增）。
          //     Windows 下 spawn 走 shell:true，插件拿到 cmd.exe 的 pid、真正监听的是它的子进程
          //     node.exe，单比 pid 必然认不出，会把自家的 dsh 误报成「外部进程在跑」。
          //   · snap.ready —— 插件自己 watchReady 观察到「3080 已开始监听」（老判据，保留兜底）。
          //     用 ready 而不是 running：子进程刚起、端口还没起来时不能算已归属。
          // 注意 fail-open 方向：两者都取 false 时 C5 会报「无法判定」(warning) 而非 error，
          // 认不出自己人最坏是多一句提示，不会诱导用户去点「接管」杀掉自己刚启的 dsh。
          selfOwned: !!snap.selfOwned || !!snap.ready,
        })
      } catch (err) {
        finish({ failed: true, reason: (err && err.message) || '读取快照失败' })
      }
    }, true)
  } catch (err) {
    clearTimeout(timer)
    finish({ failed: true, reason: (err && err.message) || '探测调用失败' })
  }
}

// ──────────────────────────────────────────────
// 聚合
// ──────────────────────────────────────────────

// 从 dsh.js 的 snapshot() 里取环境快照（只读，不改 dsh.js 导出面，D15）。
// home 的口径必须与 dsh-usage.js 的 dshHome() 完全一致（同一个 $DSH_HOME），
// 否则会出现「用量统计读到了、诊断说找不到目录」这种自相矛盾。所以共用 util.homeDir。
function readEnv() {
  const out = { home: '', nodeVersion: '', dshVersion: '', dshSource: '', profile: 'web', installed: false }
  out.home = homeDir({ env: 'DSH_HOME', fallback: '.dsh', expand: true, relative: true })
  try {
    const snap = snapshot()
    out.nodeVersion = String(snap.nodeVersion || '')
    out.dshVersion = String(snap.resolved || snap.installed || snap.globalVersion || '')
    out.dshSource = String(snap.source || '')
    out.installed = !!(snap.installed || snap.resolved)
  } catch (err) {
    logErr('[whale][diagnostics] 读 dsh 快照失败', (err && err.message) || '')
  }
  return out
}

// 主入口：跑一轮诊断（同步返回；C5 的端口探测是异步的，见 diagnoseDshAsync）
function runChecks(ctx) {
  const results = []
  for (const c of CHECKS) {
    if (c.enabled === false) continue
    try {
      const f = c.detect(ctx)
      results.push({
        id: c.id,
        title: c.title,
        severity: c.severity,
        fixable: false,
        ok: !!(f && f.ok),
        summary: String((f && f.summary) || ''),
        findings: Array.isArray(f && f.findings) ? f.findings : [],
        threw: false,
      })
    } catch (err) {
      // §3.2 约定 2：单项抛错不算整体失败
      logErr('[whale][diagnostics] 检查项抛错: ' + c.id, (err && err.message) || '')
      results.push({
        id: c.id,
        title: c.title,
        severity: c.severity,
        fixable: false,
        ok: false,
        summary: '检查执行出错',
        findings: [{ level: 'error', text: (err && err.message) || '未知错误', hint: '该项检查自身抛错，其余项不受影响' }],
        threw: true,
      })
    }
  }
  return results
}

// 整轮结论：只看是否存在 error 级 finding。
// ⚠️ D26 连带：C5 的「无法判定」是 warning，**不得**让整轮 ok:false
function overallOk(results) {
  for (const r of results) {
    if (r.threw) return false
    if (severestLevel(r.findings) === 'error') return false
  }
  return true
}

function summarize(results) {
  let pass = 0
  let bad = 0
  for (const r of results) {
    if (severestLevel(r.findings) === '' && !r.threw) pass++
    else bad++
  }
  return { pass, bad }
}

// ──────────────────────────────────────────────
// 缓存（D6：60s TTL + force）
// ──────────────────────────────────────────────
function readCache() {
  try {
    const v = utools.dbStorage.getItem(K.dshDiagnose)
    if (v && v.at && Array.isArray(v.results)) return v
  } catch (err) {
    // 读存储失败回默认值属预期分支
  }
  return null
}
function writeCache(v) {
  try { utools.dbStorage.setItem(K.dshDiagnose, v) } catch (err) {
    logErr('[whale][diagnostics] 写缓存失败', (err && err.message) || '')
  }
}
function clearDshDiagnoseCache() {
  try { utools.dbStorage.removeItem(K.dshDiagnose) } catch (err) {
    logErr('[whale][diagnostics] 清缓存失败', (err && err.message) || '')
  }
}

module.exports = {
  DIAGNOSE_TTL_MS,
  FINDING_MAX_SHOWN,
  CHECKS,
  // 纯函数（单测直接喂样例）
  markOf,
  severityOf,
  severestLevel,
  orderResults,
  scanPatchLines,
  buildContext,
  extractPatchIds,
  sameFingerprint,
  cacheHit,
  // 聚合
  runChecks,
  overallOk,
  summarize,
  readEnv,
  detectPort,
  readCache,
  writeCache,
  clearDshDiagnoseCache,
}
