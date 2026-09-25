/*
 * dsh 插件市场的**目录获取与数据处理**（CommonJS）。
 *
 * 职责边界（与 dsh-patch.js 同一条边界）：
 *   · 本模块只做「把远端目录变成一份干净的插件清单」与「按条件筛出来」—— **纯计算**，
 *     不写任何文件、不建快照、不跑 npm。安装/卸载的落笔由调用方（settings.js）编排。
 *   · 因此本模块可以被单测直接覆盖：normCatalog / filterPlugins / installedMap 都是纯函数，
 *     抓取那条链路用一个可注入的 fetch 就能测。
 *
 * ── 目录数据的真实形态（2026-09-23 实测 https://awesome-dsh-plugin.com/plugins.json）──
 *   { name, url, source, updated, count,
 *     categories: { usage: { en: 'Usage & Billing', zh: '用量与计费' }, ... },   // 24 类
 *     plugins: [{
 *       name, owner, url, page, category,
 *       description: { en, zh },        // 双语；某一侧可能缺
 *       npm,                            // ⚠️ 可以为 null —— 这种插件只能 github: 装
 *       version, stars, downloads, install,
 *       added, screenshots?             // screenshots 只有少数条目有
 *     }] }
 *
 * ⚠️ npm 为 null 是本模块最需要如实处理的字段：实测 4183 条里有 2033 条（48.6%）为 null。
 *    这些条目**不是装不了**，而是 install spec 换了形态 —— 见下面的 spec 解析。
 *
 * ── install 字段才是权威的安装命令（2026-09-23 实测）──
 *   4183 条**全部**带 `install`，格式统一为 `dsh plugin --profile web add <spec>`。
 *   剥掉前缀后的 spec 有三种，且与 npm 字段一一对应、无冲突（实测 0 例外）：
 *     · bare name（2150 条）      → npm 有值，常规 `npm install <name>`
 *     · `github:owner/repo`（1832）→ npm 为 null
 *     · `"https://…/x.tgz"`（201） → npm 为 null，**带引号**（原始命令里引号是 shell 层的，
 *                                    解析时必须剥掉，否则会把引号当 spec 的一部分）
 *   所以自己按 npm 字段拼 spec 不如**直接用目录给的 install**：那是目录作者写的原话。
 *
 * ⚠️ 但 github / tarball 来源多一个坎（本机实测）：这类插件靠 `prepare` 脚本在安装时构建，
 *    而 **pnpm 默认拦截构建脚本**，会失败并要求把 key 写进 profile 的
 *    `pnpm-workspace.yaml` → `allowBuilds`。那个 key 的**真实形态**（本机实跑 `dsh plugin
 *    --profile web add github:omdsh-dev/DSH-better-sidebar` 抄下来的报错原文，不是猜的）：
 *      · 缩进两格的裸 yaml 行，**没有**反引号 / 引号包裹；
 *      · 形如 `dsh-better-sidebar@git+https://github.com/omdsh-dev/DSH-better-sidebar.git#<commit>: true`。
 *    ⚠️ 不是 `@https://codeload.github.com/…/tar.gz/<hash>` 那种形态 —— 那是 `pnpm-workspace.yaml`
 *    里**别的历史 key**，别照它去改 settings.js 的 `parseAllowBuilds`（那条注释就是防这次回退）。
 *    —— **带 commit hash，安装前拿不到**。所以「需要构建」的条目注定要先失败一次，
 *    这不是我们的 bug 而是 pnpm 的安全机制，界面必须如实区分「能直接装」与「要先允许构建」。
 *
 * ── 为什么要有条件请求（etag / last-modified）──
 * 目录 4183 条、原始 JSON 上兆，而它**每天才刷新一次**。不带校验器的轮询等于每天
 * 重复下载一兆无用数据。抄 dsh-market 的做法：先 if-none-match，退化到 if-modified-since，
 * 304 直接复用内存体。校验器按**来源**分别存（sourceKey），多源回退时不会互相污染 ——
 * 否则「官方源的 etag」会被拿去问镜像源，必然 200 全量重下。
 *
 * ── 零依赖约束 ──
 * 项目单测不装包，所以这里只有 Node 内置模块。npm 镜像那条链路要解 tarball：
 * 用 **zlib 解 gzip**（内置）+ 手写 tar 头解析（tar 格式固定 512 字节块，只需要找
 * package/plugins.json 这一个成员，不需要通用解包器）。
 */
const zlib = require('zlib')
const { log, logErr } = require('./log')

// 官方目录（与 dsh-market 同源）
const OFFICIAL_URL = 'https://awesome-dsh-plugin.com/plugins.json'
// npm 包 dsh-plugin-catalog 里装着同一份 plugins.json，各 registry 都有
const MIRROR_PKG = 'dsh-plugin-catalog'
// ── 可选镜像源（2026-09-23 实测，均为同一份 2026.923.4200）──
//   镜像链路比官方源快两个数量级：官方源 4.37MB 直连要 52–99s（还常连不上），
//   镜像 tarball 只有 1.09MB 且 0.16–0.37s 就下完。默认用**延迟最低的那个**。
const MIRROR_REGISTRIES = [
  { id: 'npmmirror', url: 'https://registry.npmmirror.com', label: 'npmmirror（阿里，国内最快）' },
  { id: 'tencent', url: 'https://mirrors.cloud.tencent.com/npm', label: '腾讯云' },
  { id: 'npmjs', url: 'https://registry.npmjs.org', label: 'npm 官方 registry（海外）' },
]
// 默认镜像 = 实测延迟最低（474ms）的那个；找不到就退回数组首项，避免改常量时漏改默认值
const MIRROR_REGISTRY = MIRROR_REGISTRIES[0].url
// 抓取超时。官方源单次实测要 52–99s，竞速时**不能**让慢源把整次加载拖住 ——
// 竞速下这个值只用于「兜底取消」，最慢源等满就放弃（快源早返回了）。
const FETCH_TIMEOUT_MS = 15000
// 内存缓存 TTL：目录每天才刷新一次，60s 足够挡住「反复点刷新」
const CACHE_TTL_MS = 60 * 1000
// 目录体积上限：防止被异常响应（或被劫持的镜像）撑爆内存。实测最大约 4.4MB，给 16MB 余量
const MAX_BYTES = 16 * 1024 * 1024

// ── 内存状态（重载插件即丢；持久化的那份由 settings.js 落 dbStorage）──
let mem = { at: 0, key: '', data: null, validators: {} }

function errMsg(err) { return String((err && err.message) || err || '未知错误') }

// ── 纯函数：安装 spec 解析 ──

// 目录的 install 字段是 `dsh plugin --profile <p> add <spec>` 形式的完整命令。
// 本函数只负责把末尾的 <spec> 剥出来、去掉 shell 引号 —— **不做安全性判断**
// （白名单在 dsh.js 的 validPkgSpec，那边才是进命令行的关口）。
//
// 为什么不直接用 npm 字段拼：npm 为 null 的条目（近半数）根本没有 npm 名可拼。
// install 是目录作者写的原话，且实测与 npm 字段零冲突，用它更忠实。
function parseInstallSpec(install) {
  const s = String(install == null ? '' : install).trim()
  if (!s) return ''
  // 取最后一个空白分隔的片段（spec 本身不含空格；带空格的都是非法串，会被白名单挡下）
  const parts = s.split(/\s+/)
  let spec = parts[parts.length - 1] || ''
  // 裸 spec 会带 shell 引号：`"https://…/x.tgz"` / `'…'`。引号是 shell 层的，必须剥掉，
  // 否则传给 npm 的是一段带引号的地址，会 404
  if (spec.length >= 2) {
    const a = spec.charAt(0)
    const b = spec.charAt(spec.length - 1)
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) spec = spec.slice(1, -1)
  }
  return spec.trim()
}

// 判定 spec 类型。三种：npm 包名 / github / tarball。
//   · npm      —— 常规包名，npm 与 pnpm 都能直接装（`@scope/name` 也算）
//   · github   —— `github:owner/repo`，靠 prepare 脚本构建，pnpm 需 allowBuilds 放行
//   · tarball  —— 远端 .tgz 地址，同样可能需要构建（GitHub Releases 的包多数是预构建的，
//                 但 pnpm 仍会对带 prepare 的包拦构建，所以同归「需构建」一档更保守）
//   · ''       —— 认不出来（目录给的是我们没见过的形态），界面按「不支持」处理并禁用按钮
//
// ⚠️ 为什么不把 tarball 与 github 分开处理：两者在「pnpm 构建拦截」这件事上表现一致，
//    分开只是让界面多一种文案，而处置动作（加 allowBuilds 再重试）完全相同。
function specKindOf(spec) {
  const s = String(spec || '').trim()
  if (!s) return ''
  if (/^github:/i.test(s)) return 'github'
  if (/^https?:\/\//i.test(s)) return 'tarball'
  if (/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(s)) return 'npm'
  return ''
}

// 该 spec 是否「需要构建才能用」—— 只有 github / tarball 会走 prepare 脚本。
// 界面据此提前说明「可能要先允许构建」，而不是等它失败一次才解释。
function specNeedsBuild(kind) {
  return kind === 'github' || kind === 'tarball'
}

// ── 纯函数：归一 ──

// 把一条原始插件条目归一成界面要用的形状。坏条目返回 null（调用方过滤掉）。
//
// 刻意**不做**「猜字段」的兜底：目录是我们唯一的数据源，字段名变了应该表现为
// 「条目被丢掉」并可被日志看到，而不是靠猜把错误的值填进界面。
function normPlugin(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const name = String(p.name == null ? '' : p.name).trim()
  if (!name) return null
  const d = p.description && typeof p.description === 'object' ? p.description : {}
  const npm = String(p.npm == null ? '' : p.npm).trim()
  const install = String(p.install == null ? '' : p.install).trim()
  // 安装以目录给的 install 为准（详见文件头注释）。spec 为空或形态不认得时
  // specKind 也是 ''，界面由此禁用按钮 —— 而不是拿 npm 字段硬拼一个可能错的 spec
  const spec = parseInstallSpec(install)
  const specKind = specKindOf(spec)
  return {
    name: name,
    owner: String(p.owner == null ? '' : p.owner).trim(),
    // 条目名可能带 `#子包` 后缀（实测 `dsh-gungnir#dsh-plugin`，共 443 条），
    // 而 install 的 spec 是干净的 —— 展示用 name，安装一律用 spec
    url: String(p.url == null ? '' : p.url).trim(),
    page: String(p.page == null ? '' : p.page).trim(),
    category: String(p.category == null ? '' : p.category).trim(),
    descZh: String(d.zh == null ? '' : d.zh).trim(),
    descEn: String(d.en == null ? '' : d.en).trim(),
    npm: npm,
    version: String(p.version == null ? '' : p.version).trim(),
    stars: Number.isFinite(Number(p.stars)) ? Number(p.stars) : 0,
    downloads: Number.isFinite(Number(p.downloads)) ? Number(p.downloads) : 0,
    install: install,
    added: String(p.added == null ? '' : p.added).trim(),
    screenshots: Array.isArray(p.screenshots) ? p.screenshots.filter((s) => typeof s === 'string') : [],
    // ⚠️ 安装能力三件套（取代旧的 `installable: !!npm`）：
    //   · spec      —— 真正要交给安装命令的串（github:owner/repo 或 https://…/x.tgz 或裸包名）
    //   · specKind  —— 'npm' / 'github' / 'tarball' / ''（认不出来）
    //   · needsBuild—— github / tarball 靠 prepare 脚本构建，pnpm 会先拦一次
    // 旧实现只看 npm 字段，等于把 48.6% 的目录判成「装不了」并禁用按钮 —— 实测那 2033 条
    // 只是换了个 spec 形态，pnpm 原生支持。按钮该给，只是要提前说明「需构建」
    spec: spec,
    specKind: specKind,
    needsBuild: specNeedsBuild(specKind),
  }
}

// 归一整份目录。返回 { ok, plugins, categories, updated, count, error? }
// 容错口径：plugins 不是数组 / 为空 → ok:false（不能把「空目录」当成「没有插件」展示，
// 那会让用户以为市场是空的）
function normCatalog(raw) {
  const r = raw && typeof raw === 'object' ? raw : null
  if (!r) return { ok: false, error: '目录内容不是对象', plugins: [], categories: {} }
  const list = Array.isArray(r.plugins) ? r.plugins : null
  if (!list) return { ok: false, error: '目录里没有 plugins 数组', plugins: [], categories: {} }
  const plugins = []
  let dropped = 0
  for (let i = 0; i < list.length; i++) {
    const it = normPlugin(list[i])
    if (it) plugins.push(it)
    else dropped++
  }
  if (!plugins.length) return { ok: false, error: '目录里没有可用的插件条目', plugins: [], categories: {} }
  if (dropped) logErr('[whale][dsh-market] 目录里有条目缺 name，已跳过', String(dropped))

  // categories 保留中英双语与**出现顺序**（目录自己排的序比我们重排更合理）
  const cats = {}
  const src = r.categories && typeof r.categories === 'object' ? r.categories : {}
  for (const k of Object.keys(src)) {
    const c = src[k] && typeof src[k] === 'object' ? src[k] : {}
    cats[k] = { en: String(c.en == null ? '' : c.en).trim(), zh: String(c.zh == null ? '' : c.zh).trim() }
  }
  // 目录没给的分类（条目里出现了但 categories 里没有）也要能选，否则那些条目筛不到
  for (let i = 0; i < plugins.length; i++) {
    const k = plugins[i].category
    if (k && !cats[k]) cats[k] = { en: '', zh: '' }
  }
  return {
    ok: true,
    plugins: plugins,
    categories: cats,
    updated: String(r.updated == null ? '' : r.updated).trim(),
    count: plugins.length,
  }
}

// ── 纯函数：筛选与排序 ──

// 排序轴。目录自带 stars / downloads / added 三个可比值，界面用哪个由用户定。
//
// ⚠️ 每个轴都是**升序**原语（数值用 a-b、文本用 a.localeCompare(b)），方向交给 SORTS_DESC；
//    早先各轴自己写死成降序，界面就没法做「再点一次反向」—— 反向只能靠前端再排一遍。
const SORTS = {
  stars: (a, b) => a.stars - b.stars,
  downloads: (a, b) => a.downloads - b.downloads,
  // added / updated 都是 YYYY-MM-DD，字符串比较即时间比较（同格式下无需转日期）
  added: (a, b) => String(a.added).localeCompare(String(b.added)),
  name: (a, b) => a.name.localeCompare(b.name),
}
// 默认方向：数值 / 日期给人的直觉是「大的在前」，名称则是「A 在前」。
// ⚠️ 放在表里而不是散在界面：界面只要写 `sort: 'name', desc: false` 就能表达「名称升序」，
//    不必为「默认降序」这条规则在前端再维护一份 sort → desc 的映射（两处必然漂移）。
const SORTS_DESC = { stars: true, downloads: true, added: true, name: false }

// 关键词匹配：名字 / 所有者 / 双语描述里任意命中即可。
//   · 空格分词 → **与**关系（每段都要命中），搜 `dsh usage` 能出 `dsh-usage`
//   · `-词` → 排除（不得命中）
//   · 只有排除词（如 `-plugin`）也成立：此时没有正向条件，等于「全目录减去命中的」
// 大小写不敏感 —— 用户在搜索框里不会关心 `dsh-usage` 的大小写。
function matchKeyword(p, kw) {
  const q = String(kw || '').trim().toLowerCase()
  if (!q) return true
  const hay = (p.name + ' ' + p.owner + ' ' + p.descZh + ' ' + p.descEn).toLowerCase()
  const parts = q.split(/\s+/)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    if (part.charAt(0) === '-') {
      const ex = part.slice(1)
      // ⚠️ 光一个 `-` 不算排除词（用户可能只是想打个连字符）：跳过，否则会把整份目录清空
      if (ex && hay.indexOf(ex) >= 0) return false
      continue
    }
    if (hay.indexOf(part) < 0) return false
  }
  return true
}

// filterPlugins(list, opts) → 过滤 + 排序后的数组（不改原数组）
//   opts = { keyword?, category?, state?: 'all'|'installed'|'notInstalled', sort?, desc?, installed? }
//
// ⚠️ 排序放在过滤之后而不是之前：过滤是 O(n) 一遍，排序是 O(n log n)；
// 而「未安装」这类过滤常常能砍掉大半（实测 4183 条里已装的通常是个位数），
// 先筛后排总代价更低。
function filterPlugins(list, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const arr = Array.isArray(list) ? list : []
  const installed = o.installed && typeof o.installed === 'object' ? o.installed : null
  const state = o.state === 'installed' || o.state === 'notInstalled' ? o.state : 'all'
  const cat = String(o.category || '').trim()
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i]
    if (cat && p.category !== cat) continue
    if (!matchKeyword(p, o.keyword)) continue
    if (state !== 'all') {
      // 拿不到已装状态（没读过 profile）时**不冒充**未安装：宁可全都显示，
      // 也不把已装的插件标成「未安装」骗用户去点安装
      if (!installed) continue
      const has = !!installed[p.npm]
      if (state === 'installed' && !has) continue
      if (state === 'notInstalled' && has) continue
    }
    out.push(p)
  }
  const key = SORTS[o.sort] ? o.sort : 'downloads'
  // ⚠️ 方向：`desc` 没给（undefined）才用该轴的默认方向；显式传 false 得尊重，
  //    否则界面永远无法表达「名称倒序 / 下载量升序」——`o.desc || SORTS_DESC[key]`
  //    会把用户选的 false 顶掉（`false || true` → `true`），是个很容易写错的坑。
  const desc = typeof o.desc === 'boolean' ? o.desc : SORTS_DESC[key]
  const cmp = SORTS[key]
  out.sort(desc ? (a, b) => -cmp(a, b) : cmp)
  return out
}

// ── 纯函数：已装状态 ──
// 从 profile 的 package.json 依赖 + 用户层 patch 条目算出「这个 npm 包现在是什么状态」。
// 返回 { [npmName]: { inDeps: bool, depVersion: string, inPatch: bool, disabled: bool } }
//
// ⚠️ 两个来源说的是两件事，不能只看一个：
//   · package.json 的 dependencies  —— 包**装没装**（npm 层面）
//   · cordis.patch.yml               —— 条目**开关**（dsh 层面）
// 一个包可能装了但被 disabled（用户主动关的），也可能在 patch 里但没装（写了不存在的 id）。
// 界面要能区分，所以这里两个都读出来。
function installedMap(deps, patchItems) {
  const out = {}
  const d = deps && typeof deps === 'object' ? deps : {}
  for (const name of Object.keys(d)) {
    const n = String(name).trim()
    if (!n) continue
    out[n] = { inDeps: true, depVersion: String(d[name] == null ? '' : d[name]), inPatch: false, disabled: false }
  }
  const items = Array.isArray(patchItems) ? patchItems : []
  for (let i = 0; i < items.length; i++) {
    const it = items[i] && typeof items[i] === 'object' ? items[i] : {}
    const id = String(it.id == null ? '' : it.id).trim()
    if (!id) continue
    // patch 里的 id 可能是**条目名**（dsh-gungnir）而不是 npm 包名
    // （@scope/dsh-gungnir 这种带作用域的写法）。这里按「已知的 npm 名」去对，
    // 所以后面对不上时还要用短名兜一层 —— 见 matchInstalled
    if (!out[id]) out[id] = { inDeps: false, depVersion: '', inPatch: false, disabled: false }
    out[id].inPatch = true
    out[id].disabled = !!it.disabled
  }
  return out
}

// 把一个条目的 npm 包名对上已装映射。返回那份记录或 null。
//
// 为什么要「短名兜底」：dsh 的 patch 条目 id 用的是**去掉 scope 的短名**是常见写法
// （实测 `- id: dsh-mnemon` 对应 `@deepseek-ai/dsh-mnemon` 这类也出现过），
// 而目录里 npm 字段是完整包名。只按完整名对会让「明明装了」显示成未装。
function matchInstalled(installed, npmName) {
  if (!installed) return null
  const full = String(npmName || '').trim()
  if (!full) return null
  if (installed[full]) return installed[full]
  const short = full.indexOf('/') >= 0 ? full.slice(full.indexOf('/') + 1) : full
  return installed[short] || null
}

// 按**包名**在**原始依赖表**（`dsh.installedDeps` 的输出，`{ 键: 声明范围 }`）里找一个版本。
// 返回 `{ key, depVersion }` 或 null —— 形状与 `matchInstalledBySpec` 一致。
//
// ⚠️ 为什么不直接用 `matchInstalled`：那个函数吃的是 `installedMap` 的**记录表**
//    （`{ 键: { inDeps, depVersion, … } }`），返回值就是记录本身。而「检查更新 / 更新」
//    这条链路上手上只有原始依赖表，两个函数的入参形状不同 —— 混用会让 `hit.depVersion`
//    恒为 undefined（记录表里才叫 depVersion，原始表里那个位置放的是**裸字符串**），
//    于是每条带 caret 的包都掉进 unknown，功能静默失效。宁可分成两个函数，不要靠调用方记形状。
function matchDepByNpm(deps, npmName) {
  if (!deps) return null
  const full = String(npmName || '').trim()
  if (!full) return null
  const short = full.indexOf('/') >= 0 ? full.slice(full.indexOf('/') + 1) : full
  // 完整名优先、短名兜底；都按大小写不敏感比（npm 键对 github spec 会小写化）
  for (const want of [full, short]) {
    const w = want.toLowerCase()
    const keys = Object.keys(deps)
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i]).trim().toLowerCase() === w) {
        return { key: keys[i], depVersion: String(deps[keys[i]] == null ? '' : deps[keys[i]]) }
      }
    }
  }
  return null
}

// 按**安装 spec** 反查已装映射（npm 字段对不上的那近半数条目靠这个）。
//
// ⚠️ 为什么需要它：npm 为 null 的条目（github: / tarball）根本没有 npm 名可对，
//    但它们装完后 package.json 的 dependencies 里**会**有一个键 ——
//    npm 对 github spec 归一成 `owner/repo`（`github:CAI-MH/x` → `cai-mh/x`），
//    对远端 tgz 归一成包名（读 tarball 里的 name 字段）。所以按 spec 反查要与
//    「spec 归一后的候选键」比对，而不是字面比对。
//
// 候选取法（宽松但不会误判，因为键来自用户自己的 package.json）：
//   · spec 本身           —— 裸包名这一档直接命中
//   · spec 的短名         —— `@scope/name` 加去 scope 的 `name`
//                            （目录名偶尔会被归一成短名，与 matchInstalled 的兜底同口径）
//   · github:owner/repo   —— 加 `owner/repo`、`repo`
//   · https://…/x.tgz     —— 取路径最后一段去掉 .tgz / .tar.gz，加去掉 scope 的短名
// 全部按小写比对（npm 的 dependencies 键对 github spec 会小写化），但**保留原始键**返回。
// 返回值形状与界面约定的 `{ key, depVersion }` 一致（key 供卸载时定位、depVersion 供展示）。
function matchInstalledBySpec(installed, spec) {
  if (!installed) return null
  const s = String(spec || '').trim()
  if (!s) return null
  const cands = []
  const push = (v) => { const x = String(v || '').trim().toLowerCase(); if (x && cands.indexOf(x) < 0) cands.push(x) }
  // 短名兜底：`@scope/name` → `name`。与 matchInstalled 同口径，否则遇到目录名被归一成
  // 短名时（`node_modules/dsh-mnemon` 对应 spec `@deepseek-ai/dsh-mnemon`）会认不出。
  const pushShort = (v) => { const x = String(v || '').trim(); const i = x.indexOf('/'); if (i >= 0) push(x.slice(i + 1)) }
  push(s)
  pushShort(s)
  const gh = s.match(/^github:([^/#]+)\/([^/#]+)/i)
  if (gh) {
    push(gh[1] + '/' + gh[2])
    push(gh[2])
  }
  if (/^https?:\/\//i.test(s)) {
    const noQuery = s.split(/[?#]/)[0]
    const seg = noQuery.slice(noQuery.lastIndexOf('/') + 1)
    const base = seg.replace(/\.(tar\.gz|tgz)$/i, '')
    push(base)
    // 远端 tarball 的文件名常是 `scope-name-1.2.3.tgz` 或 `name-1.2.3.tgz`，
    // 版本号要在最后一层兜底时才有意义 —— 这里先按「原样 + 去版本」两种试
    push(base.replace(/-\d+\.\d+\.\d+.*$/, ''))
  }
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    const keys = Object.keys(installed)
    for (let j = 0; j < keys.length; j++) {
      const raw = keys[j]
      if (String(raw).trim().toLowerCase() === c) return { key: raw, depVersion: installed[raw] }
    }
  }
  return null
}

// 按 spec 在「实装版本表」里找版本号，找到返版本字符串，找不到返 ''。
//
// ⚠️ 为什么复用 matchInstalledBySpec 而不是另写一套：候选键的取法（spec 原文 / github 的
//    `owner/repo` 与 `repo` / tarball 文件名去扩展名与去版本）与「按 spec 认已装」完全同一套逻辑。
//    而实装版本表的键正好就是 node_modules 的目录名 —— hoisted 模式下 github 来源包的目录名
//    是 npm 归一后的 `owner/repo`，tarball 来源是包名，与那套候选键对得上。
//    唯一区别是本函数只关心「版本值」，所以拆出 depVersion 返回裸字符串。
function realizedVersionBySpec(versions, spec) {
  const hit = matchInstalledBySpec(versions, spec)
  return hit && hit.depVersion ? String(hit.depVersion) : ''
}

// ── 纯函数：版本比对（零依赖手写，不引 semver）──
//
// ⚠️ 为什么不引 semver：项目强制零依赖（单测跑 node --test，不装包）。
//    而我们只需要「比大小」，不需要 semver 的完整语义 —— 实测目录里 2150 条带版本
//    的条目**全是裸 x.y.z**（无非 semver 形态），所以手写足够。
//
// ⚠️ prerelease 是后补的（2026-09-24，为 DSH 宿主兼容性检测）：dsh 生态的版本大量是
//    `0.1.7-rc.1` 这种，而其声明范围（peerDependencies）是 `^0.1.7-rc.1`。原先的正则
//    `^(\d+)(?:\.(\d+))?(?:\.(\d+))?` 会把 `-rc.1` 后缀**静默丢掉** → `0.1.7-rc.1` 与
//    `0.1.7` 被判相等。后果不是「显示错」而是**判反**：装了 rc.1 的用户会被告知「已是最新」
//    （其实 rc.2 已发布），而 `^0.1.7-rc.1` 这类范围的语义也整个失真。
//
// ⚠️ 比的是什么（2026-09-24 调整）：**优先比实装版本**（node_modules/<name>/package.json
//    里的真实 version），拿不到才退回 package.json 的**声明范围**。
//    为什么必须比实装：声明范围是 `^0.5.11` 这种，按「目录版本是否超出范围」判的话，
//    目录出 `0.5.13`（同 minor 内的小版本升级）会被判成「已最新」——而本机实测 9 条依赖里
//    8 条的实装版本**恰好都等于范围下界**（`^0.5.11` 实装就是 `0.5.11`），说明这类小版本
//    升级是真实存在的、且确实是「有新版」，不该漏报。
//    口径：实装版本 < 目录版本 → 有更新；相等或更高 → 已最新。
//    退回范围判定时沿用旧的保守口径（宁少报不乱报）：目录版本超出范围才算更新。
// 解析版本号。返回 [major, minor, patch, prerelease] 四元组，prerelease 为**数组**（无则 []）。
// ⚠️ 第四位是数组而不是字符串：prerelease 必须按 semver 的「点分段逐一比较」比
//    （`rc.10` > `rc.9`，按字符串比会得到 `rc.10` < `rc.9`），且纯数字段与字母段
//    **优先级不同**（数字段比字母段小：`1.0.0-1 < 1.0.0-alpha`）。
function parseVer(v) {
  const s = String(v == null ? '' : v).trim().replace(/^[v=\s]+/, '')
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  // build metadata（`+sha`）按 semver 规定**不参与比较**，故整体丢弃
  const pre = m[4] ? m[4].split('.').filter((x) => x !== '') : []
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0), pre]
}
// prerelease 段比较：a>b 返 1，a<b 返 -1，相等返 0（仅在 major.minor.patch 全等时才调）。
// 规则（semver §11.4）：① 无 prerelease **大于**有 prerelease（`1.0.0` > `1.0.0-rc.1`）；
//                      ② 逐段比：两段都是数字 → 按数值；都是字母 → 按 ASCII；
//                         数字 vs 字母 → **数字更小**（`1.0.0-1 < 1.0.0-alpha`）；
//                      ③ 前缀短的更小（`1.0.0-rc < 1.0.0-rc.1`）。
function cmpPre(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1   // a 是正式版 → 更大
  if (!b.length) return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i]
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d > 0 ? 1 : -1
    } else if (xn !== yn) {
      return xn ? -1 : 1   // 数字段比字母段小
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1)
}
// 比大小：a>b 返 1，a<b 返 -1，相等/无法比较返 0
function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  }
  return cmpPre(x[3], y[3])
}
// 判断「目录版本 target 是否还在已装声明范围 range 之内」。
// 把 parseVer 的四元组还原成可比较的字符串（数字段 + prerelease 后缀）。
// ⚠️ 不能再用 `lo.join('.')`：prerelease 是**数组**，join 会把 `['rc','1']` 拼成
//    `0.1.7.rc,1` 这种 parseVer 认不出的垃圾 → cmpVer 返 0 → 下界/上界判定整个静默失效。
function verStr(t) {
  const base = t[0] + '.' + t[1] + '.' + t[2]
  return t[3] && t[3].length ? base + '-' + t[3].join('.') : base
}
// range 支持：`^x.y.z` / `~x.y.z` / `x.y.z` / `>=x.y.z` / `*` / `latest` / 空。
// 认不出的形态一律返回 true（= 落在范围内 = 不报更新）—— 保守优先，宁可漏报。
function rangeAllows(range, target) {
  const r = String(range == null ? '' : range).trim()
  if (!r || r === '*' || r === 'latest' || r === 'x') return true
  const t = parseVer(target)
  if (!t) return true
  // caret：^0.5.11 → [0.5.11, 0.6.0)；^1.2.3 → [1.2.3, 2.0.0)
  //   ⚠️ 0.x 的 caret 语义特殊：^0.5.11 的上界是 0.6.0 而不是 1.0.0（npm 的约定）
  const caret = r.match(/^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (caret) {
    const lo = parseVer(r.slice(1))
    if (!lo) return true
    if (cmpVer(target, verStr(lo)) < 0) return false
    const hi = caret[1] === '0'
      ? (caret[2] === '0' || caret[2] === undefined
        ? [0, 0, Number(caret[3] || 0) + 1]      // ^0.0.x → [0.0.x, 0.0.x+1)
        : [0, Number(caret[2]) + 1, 0])          // ^0.5.x → [0.5.x, 0.6.0)
      : [Number(caret[1]) + 1, 0, 0]             // ^1.2.3 → [1.2.3, 2.0.0)
    // ⚠️ 上界是**不含 prerelease 的正式版**：`^0.1.7-rc.1` 的上界是 `0.2.0`，而
    //    `0.2.0-rc.1` 按 semver 也 < `0.2.0`，会被判「在范围内」。这与 npm 的
    //    `includePrerelease: false` 默认口径一致（prerelease 版本只有显式写进范围才匹配），
    //    对本项目是**安全的保守方向**：宁可判「在范围内」（不报更新）也不误报。
    return cmpVer(target, hi.join('.')) < 0
  }
  // tilde：~1.2.3 → [1.2.3, 1.3.0)；~1.2 → [1.2.0, 1.3.0)
  //   ⚠️ 上界是**同一 minor 的下一个**（major.minor+1.0），不是下一个 major。
  //      写成 +1 到 major 会让 `~1.2.3` 把 `1.3.0` 也放行 —— 那是 caret 的语义。
  //   ⚠️ `~1` 只给了 major：npm 语义退化成 [1.0.0, 2.0.0)，此时才升 major。
  const tilde = r.match(/^~(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (tilde) {
    const lo = parseVer(r.slice(1))
    if (!lo) return true
    if (cmpVer(target, verStr(lo)) < 0) return false
    const hi = tilde[2] === undefined
      ? [Number(tilde[1]) + 1, 0, 0]                                  // ~1 → [1.0.0, 2.0.0)
      : [Number(tilde[1]), Number(tilde[2]) + 1, 0]                   // ~1.2[.3] → […, 1.3.0)
    return cmpVer(target, hi.join('.')) < 0
  }
  // >=x.y.z / >x.y.z
  const ge = r.match(/^>=\s*(\S+)/)
  if (ge) return cmpVer(target, ge[1]) >= 0
  const gt = r.match(/^>\s*(\S+)/)
  if (gt) return cmpVer(target, gt[1]) > 0
  // 裸版本（含 `1.2`、`1` 这类简写）—— 按 npm 语义只有**完全相同**才算落在范围内
  const bare = parseVer(r)
  if (bare) return cmpVer(target, r) === 0
  // 认不出的形态（`latest`、workspace:*、npm:xxx 之类）→ 保守判「在范围内」
  return true
}
// 取声明范围的**下界**（`^1.62.0` → `1.62.0`），取不到返 ''。
//
// ⚠️ 为什么需要它：rangeAllows 只能答「这个版本满不满足范围」，答不了「谁新谁旧」。
//    而退回范围判定更新时恰恰需要方向 —— 目录版本低于下界 ≠ 有更新，那是目录快照
//    比实装还旧（典型：目录每天才刷一次）。下界是「用户当初装到的版本」的最佳近似，
//    拿它当方向基准即可判出这一档。见 updateState 里那段注释的真实事故。
function lowerBoundOf(range) {
  const r = String(range == null ? '' : range).trim()
  if (!r) return ''
  // caret / tilde：`^1.2.3` / `~1.2.3` → 剥掉前缀后的部分
  const sig = r.match(/^[\^~]\s*(\S+)/)
  if (sig) {
    const v = parseVer(sig[1])
    return v ? verStr(v) : ''
  }
  // >=x.y.z / >x.y.z
  const ge = r.match(/^>=\s*(\S+)/)
  if (ge) { const v = parseVer(ge[1]); return v ? verStr(v) : '' }
  // ⚠️ `>x.y.z` 的下界严格来说不是 x.y.z，但作为「谁新谁旧」的基准足够 ——
  //    目录版本连 x.y.z 都不超过时，绝无可能是更新
  const gt = r.match(/^>\s*(\S+)/)
  if (gt) { const v = parseVer(gt[1]); return v ? verStr(v) : '' }
  // 裸版本（`1.2.3` / `1.2` / `1`）—— 范围即该点，下界就是它
  const bare = parseVer(r)
  if (bare) return verStr(bare)
  // `*` / `latest` / 认不出的形态 → 没有可比的下界，调用方退回老口径
  return ''
}
// 判定一条目录条目相对已装状态是否有更新。返回：
//   { state: 'update' | 'current' | 'unknown', installed, range, latest, basis }
//   · 'unknown' —— 目录没给 version（github / tgz 来源 2033 条），或已装侧两边都拿不到
//   · 'current' —— 实装版本已 >= 目录版本（或退回范围判定时目录版本不比范围下界新）
//   · 'update'  —— 实装版本 < 目录版本（或退回范围判定时目录版本高于下界且超出范围）
//
// ⚠️ 为什么用「实装版本」而不是只比范围：见本段开头的口径说明。
//    第三个参数 realized 是**实装版本**（node_modules 里的裸 x.y.z，可能为空）。
//    传空就退回旧的「范围 vs 目录」判定 —— 拿不到实装就不猜，保守优先。
function updateState(depVersion, catalogVersion, realized) {
  const range = String(depVersion == null ? '' : depVersion).trim()
  const installed = String(realized == null ? '' : realized).trim()
  const latest = String(catalogVersion == null ? '' : catalogVersion).trim()
  // ⚠️ 只对**目录版本**要求「得是个能解析的版本号」：它得是裸 x.y.z 才有可比性。
  //    已装侧（range）**不能**用 parseVer 把关 —— 那里放的是声明范围（`^0.5.11` / `~1.2.0`），
  //    parseVer 见到 `^` 直接返回 null，会让每一条带 caret 的包都掉进 unknown，功能等于没做。
  //    「范围能不能认」交给 rangeAllows 自己判：它认不出的形态返 true，落到 current。
  if (!latest || !parseVer(latest)) {
    return { state: 'unknown', installed: installed, range: range, latest: latest, basis: 'none' }
  }
  const real = parseVer(installed)
  if (real) {
    // 实装版本可解析 → 直接比大小。这是主路径。
    // 相等**不算**更新（重装一遍没有意义，还会白建一次快照）
    const state = cmpVer(installed, latest) < 0 ? 'update' : 'current'
    return { state: state, installed: installed, range: range, latest: latest, basis: 'realized' }
  }
  // 退回范围判定：两边都没实装版本、也没声明范围 → 无从判断
  if (!range) return { state: 'unknown', installed: '', range: range, latest: latest, basis: 'none' }
  // ⚠️ 这一档**只用下界比方向**，不能用 rangeAllows —— 那会两个方向都判错。
  //    · 判反降级：`^1.62.0` 实装声明 + 目录给 `1.61.0`（目录快照滞后于实装）时，
  //      rangeAllows 见 1.61.0 低于下界返 false → 被判「有更新」，
  //      可 1.61.0 比实装旧，方向完全相反。真实事故：dshmarket 实装 1.62.0、
  //      目录快照 1.61.0，界面显示「v1.62.0 → v1.61.0」并给出「更新」按钮 ——
  //      点下去会把用户**降级**（正是 downgradedBy 要拦的那类事故）。
  //    · 漏报真升级：范围是**已装时写下的**，`^1.62.0` 允许到 `<2.0.0`，
  //      却不知道用户实际停在 1.62.0。拿它判「目录 1.65.1 在范围内 → 已最新」
  //      会把 `^` 范围内的正常小版本升级全漏掉。
  //    下界（`^1.62.0` → `1.62.0`）正是「用户当初装到的那个版本」的最佳近似，
  //    拿它当方向基准两边都对：目录更高 → update，不高于 → current。
  //    取不到下界（`*` / `latest` / 认不出的形态）才退回 rangeAllows 的保守口径。
  const lo = lowerBoundOf(range)
  if (lo) {
    const state = cmpVer(latest, lo) > 0 ? 'update' : 'current'
    return { state: state, installed: '', range: range, latest: latest, basis: 'range' }
  }
  return {
    state: rangeAllows(range, latest) ? 'current' : 'update',
    installed: '',
    range: range,
    latest: latest,
    basis: 'range'
  }
}

// ── 抓取 ──

// 读响应体，带体积上限。超限直接抛 —— 被劫持/异常的响应不该进内存。
async function readBody(res) {
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('目录超过体积上限（' + buf.length + ' 字节）')
  return buf
}

// 带校验器的一次 GET。返回 { notModified: true } 或 { body, etag, lastModified }
//
// 校验器二者只发一个：同时发 etag 与 last-modified 时，某些代理会挑它不喜欢的那条，
// 反而更容易判错 —— dsh-market 的取舍同此。
async function condGet(url, headers, validator, fetchImpl, signal) {
  const h = Object.assign({}, headers)
  if (validator && validator.etag) h['if-none-match'] = validator.etag
  else if (validator && validator.lastModified) h['if-modified-since'] = validator.lastModified
  const res = await fetchImpl(url, { headers: h, signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (res.status === 304) return { notModified: true }
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (res.statusText || ''))
  const buf = await readBody(res)
  return {
    body: buf.toString('utf8'),
    etag: String(res.headers.get('etag') || ''),
    lastModified: String(res.headers.get('last-modified') || ''),
  }
}

// 从 tar.gz 里解出 package/plugins.json（npm 镜像包链路）。
//
// 只支持这一种成员：tar 头固定 512 字节，路径在前 100 字节，size 在 124 起的 12 字节（八进制）。
// 遇到 GNU 长名（typeflag 'L'）时多读一块 —— npm publish 出来的包名不会那么长，
// 但真遇上也不能把后续块全错位。
const TAR_BLOCK = 512
function untarOne(buf, wanted) {
  let off = 0
  while (off + TAR_BLOCK <= buf.length) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '').trim()
    // 全零块 = 归档结束
    if (!name) return null
    const sizeStr = buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const type = buf.toString('utf8', off + 156, off + 157)
    let dataStart = off + TAR_BLOCK
    // 'L' = GNU long name：下一块是真实路径，再下一块才是数据
    if (type === 'L') {
      const n = parseInt(buf.toString('utf8', dataStart + 124, dataStart + 136).replace(/\0.*$/, '').trim(), 8) || 0
      const real = buf.toString('utf8', dataStart + TAR_BLOCK, dataStart + TAR_BLOCK + n).replace(/\0.*$/, '').trim()
      const realSize = parseInt(buf.toString('utf8', dataStart + 124, dataStart + 136).replace(/\0.*$/, '').trim(), 8) || 0
      const start = dataStart + TAR_BLOCK * (1 + Math.ceil(realSize / TAR_BLOCK))
      const end = start + realSize
      if (real === wanted) return buf.toString('utf8', start, end)
      off = start + Math.ceil(realSize / TAR_BLOCK) * TAR_BLOCK
      continue
    }
    const end = dataStart + size
    if (name === wanted) return buf.toString('utf8', dataStart, end)
    off = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return null
}

// npm 镜像链路：registry 元数据 → tarball → 解出 plugins.json
async function loadFromMirror(registry, fetchImpl, signal) {
  const reg = String(registry || MIRROR_REGISTRY).replace(/\/+$/, '')
  const metaUrl = reg + '/' + MIRROR_PKG + '/latest'
  const metaRes = await fetchImpl(metaUrl, { signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!metaRes.ok) throw new Error('镜像元数据 HTTP ' + metaRes.status)
  const meta = JSON.parse(await metaRes.text())
  const tarball = meta && meta.dist && meta.dist.tarball
  if (!tarball) throw new Error('镜像元数据里没有 dist.tarball')
  // ⚠️ tarball 的 URL 由 registry 元数据给出，可能指向它自己的 CDN。
  // 只允许 http(s) —— 不接受元数据把我们带去任意第三方主机
  const tb = String(tarball)
  if (!/^https?:\/\//i.test(tb)) throw new Error('镜像 tarball 地址不合法')
  const tarRes = await fetchImpl(tb, { signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!tarRes.ok) throw new Error('镜像 tarball HTTP ' + tarRes.status)
  const gz = Buffer.from(await tarRes.arrayBuffer())
  if (gz.length > MAX_BYTES) throw new Error('镜像 tarball 超过体积上限')
  const tar = zlib.gunzipSync(gz)
  const text = untarOne(tar, 'package/plugins.json')
  if (!text) throw new Error('镜像 tarball 里没有 plugins.json')
  return text
}

// 按用户配置列出**要参与竞速的来源集合**。
//
// 与旧实现的根本差别：旧的是「按优先级串行试」——必须等最慢的前一个失败才轮到下一个，
// 而官方源实测要 52–99s（还常连不上），于是每次首屏都要干等一分钟。
// 现在改为**并发竞速**：所有来源同时发请求，谁先拿到合格的目录就用谁，其余立即 abort。
//
// 来源构成（都可配）：
//   · custom   —— 用户显式指定的 URL（通常是自己搭的镜像），恒参与
//   · official —— 官方源，慢且不稳，默认**关闭**（老用户配置里没有这个键 → 视为关）
//   · mirror   —— 用户选的那个 registry（走 npm 包 dsh-plugin-catalog 的 tarball 链路）
//
// `key` 用于给每个来源**分别**存校验器与算缓存键 —— 多源不互相污染。
function buildSources(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const out = []
  const custom = String(o.customUrl || '').trim()
  if (custom) out.push({ kind: 'custom', url: custom, key: 'url:' + custom })
  const registry = String(o.registry || '').trim() || MIRROR_REGISTRY
  if (o.mirror !== false) out.push({ kind: 'mirror', url: registry, key: 'npm:' + registry + '/' + MIRROR_PKG })
  if (o.official === true) out.push({ kind: 'official', url: OFFICIAL_URL, key: 'url:' + OFFICIAL_URL })
  return out
}

// 竞速取一个来源的目录文本（不解析，解析在调用方统一做）。
// 每个来源各自套 AbortController：竞速胜出后要把其余来源立刻掐掉，别让它们白占带宽。
async function fetchSource(src, fetchImpl, validators, signal) {
  if (src.kind === 'mirror') {
    const text = await loadFromMirror(src.url, fetchImpl, signal)
    return { text: text }
  }
  const r = await condGet(src.url, { accept: 'application/json' }, validators[src.key], fetchImpl, signal)
  if (r.notModified) return { notModified: true }
  // 校验器只在这个来源真的返回了新体时更新 —— 304 时 r.etag 是空的，覆盖会把有效校验器抹掉
  if (r.etag || r.lastModified) validators[src.key] = { etag: r.etag, lastModified: r.lastModified }
  return { text: r.body }
}

// 抓目录。opts = { force?, customUrl?, mirror?, registry?, official?, fetchImpl? }
// 返回 { ok, plugins, categories, updated, count, from, cached, tookMs, error? }
//
// 竞速语义（这是本函数的核心，改之前先读懂）：
//   · 所有来源同时发请求，**第一个拿到合格目录的胜出**，其余立刻 abort；
//   · 单个来源失败（网络错 / 校验失败 / 内容不合格）只是它自己出局，不影响其他源；
//   · 全部出局才返回 ok:false，并把「每条链路为什么失败」拼进 error；
//   · 胜出的源会记下 `from` 与耗时 `tookMs`，界面据此显示「这一屏是谁给的、花了多久」。
async function loadCatalog(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  const force = o.force === true
  const sources = buildSources(o)
  const cacheKey = sources.map((s) => s.key).join('|')

  // 内存缓存：只有「同一组来源」才算命中，用户改了来源配置就该重新抓
  if (!force && mem.data && mem.key === cacheKey && Date.now() - mem.at < CACHE_TTL_MS) {
    return Object.assign({}, mem.data, { cached: true })
  }
  if (!sources.length) {
    return { ok: false, plugins: [], categories: {}, error: '没有可用的目录来源（官方源与镜像源都被关掉了）' }
  }

  const startedAt = Date.now()
  const failures = []
  // 每个来源一个 controller，胜出后统一 abort 剩下的
  const ctrls = sources.map(() => new AbortController())
  // 兜底：最慢的源不许超过 FETCH_TIMEOUT_MS（快源早就返回了，慢源等满即弃）
  const timer = setTimeout(() => { for (const c of ctrls) c.abort() }, FETCH_TIMEOUT_MS)

  let settled = false
  const payload = await new Promise((resolve) => {
    let pending = sources.length
    const done = (val) => {
      if (settled) return
      if (val) { settled = true; resolve(val) } else { pending--; if (pending === 0) { settled = true; resolve(null) } }
    }
    sources.forEach((src, i) => {
      fetchSource(src, fetchImpl, mem.validators, ctrls[i].signal)
        .then((r) => {
          // 304：内容没变，直接把上次的解析结果原样复用（并刷新时间戳）
          if (r.notModified && mem.data) {
            mem.at = Date.now()
            log('[whale][dsh-market] 目录未变化（304），复用缓存', src.kind)
            done(Object.assign({}, mem.data, { cached: true, from: src.kind, tookMs: Date.now() - startedAt, registry: src.kind === 'mirror' ? src.url : '' }))
            return
          }
          if (r.notModified) { done(null); return } // 有 304 却没有可复用的体：这个源出局
          const parsed = normCatalog(JSON.parse(r.text))
          if (!parsed.ok) throw new Error(parsed.error)
          // registry 一并回传：界面要显示「这一屏是哪个镜像给的」，硬编 label 会撒谎
          done(Object.assign(parsed, { from: src.kind, cached: false, tookMs: Date.now() - startedAt, registry: src.kind === 'mirror' ? src.url : '' }))
        })
        .catch((err) => {
          // abort 是「别人先赢了」的正常结果，不是失败，不进 failures（否则 error 里全是噪声）
          if (err && err.name === 'AbortError') { done(null); return }
          const why = errMsg(err)
          failures.push(src.kind + '（' + why + '）')
          logErr('[whale][dsh-market] 来源不可用', src.kind + ': ' + why)
          done(null)
        })
    })
  })

  clearTimeout(timer)
  // 胜出后掐掉还在跑的（含 304 复用这条路径）—— 失败隔离由 done() 保证，这里只省带宽
  for (const c of ctrls) { try { c.abort() } catch (_) { /* 已结束的 controller abort 无害 */ } }

  if (payload) {
    mem = { at: Date.now(), key: cacheKey, data: payload, validators: mem.validators }
    log('[whale][dsh-market] 目录已加载', { from: payload.from, count: payload.count, tookMs: payload.tookMs })
    return payload
  }

  return {
    ok: false,
    plugins: [],
    categories: {},
    error: '所有目录来源都取不到：' + (failures.length ? failures.join('；') : '全部超时'),
    failures: failures,
  }
}

// ── 回源 registry 查「官方最新版」──
//
// ⚠️ 为什么需要它：目录（`dsh-plugin-catalog` / 官方 plugins.json）是**每日快照**，而插件
//    发版随时在发生。实测 2026-09-25：目录停在 `2026.924.4355`（9/24 11:39），而 dshmarket
//    已发到 1.65.1 —— 目录里那条还写着 1.61.0。用户于是看到「已是最新」，实际落后 4 个版本。
//    目录里那份 version 只是**快照值**，不能当成「当前最新」。
//
// ⚠️ 所以这一档**必须出站**，且**只在用户明确点击时**才发请求（见界面每行的「查官方最新版」
//    按钮）—— 它不进 dshMarketCatalog / dshMarketCheckUpdates 那条「默认零网络请求」的链路，
//    否则「刷新目录」会连带打上百个 registry 请求。
//
// ⚠️ 只查**裸 npm 包名**：github / tarball 来源在 npm 上没有 manifest，查了必然 404
//    （与 dsh-host-compat 同一口径）。scoped 包的 `/` 要编码成 `%2F`，否则换 registry 会 404。
const LATEST_TIMEOUT_MS = 8000
// registry 的 latest 比目录变得快（发版即可见），但也没必要每次点击都重发 —— 5 分钟足够
const LATEST_TTL_MS = 5 * 60 * 1000
// 失败冷却：拉不到时别让用户反复点反复等满超时
const LATEST_FAIL_COOLDOWN_MS = 60 * 1000
const LATEST_CONCURRENCY = 8

// pkgName → { at, version }（version 为 '' 表示拉到了但元数据里没 version，属异常但按有效结论存）
const latestCache = new Map()
// pkgName → 下次可重试的时刻
const latestFailures = new Map()

function latestCacheGet(name, now) {
  const hit = latestCache.get(name)
  if (!hit) return undefined
  if (now - hit.at > LATEST_TTL_MS) { latestCache.delete(name); return undefined }
  return hit.version
}

// 拉一个包的 registry latest 版本。成功返回 { version }，失败返回 { error }。
// 与 dsh-host-compat.fetchFacts 同套路（超时 + 失败冷却 + 缓存）。
async function fetchRegistryLatest(name, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const now = Date.now()
  const cached = latestCacheGet(name, now)
  if (cached !== undefined) return { version: cached, cached: true }
  const retryAt = latestFailures.get(name)
  if (retryAt && now < retryAt) return { error: '刚拉取失败，稍后再试' }
  const registry = String(o.registry || MIRROR_REGISTRY).replace(/\/+$/, '')
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  const url = registry + '/' + name.replace(/\//g, '%2F') + '/latest'
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const meta = await res.json()
    const version = String((meta && meta.version) || '').trim()
    latestFailures.delete(name)
    // ⚠️ 拉到了就落缓存（即便 version 为空）—— 否则元数据异常的包每次点击都要重拉一遍
    latestCache.set(name, { at: Date.now(), version: version })
    return { version: version }
  } catch (err) {
    const why = errMsg(err)
    logErr('[whale][dsh-market] 查 registry latest 失败', name + ': ' + why)
    latestFailures.set(name, Date.now() + LATEST_FAIL_COOLDOWN_MS)
    return { error: why }
  }
}

// 批量查 registry latest：收 `{ pkg, key }` 数组，返回 { 键 → { version, error, cached } }。
//
// `key` 是调用方给的关联键（界面上用目录条目的 spec），因为一个包名可能对应多条目录条目，
// 用 pkg 当返回键会让它们互相覆盖。
//
// ⚠️ 与 dshHostCompat.lookup 一样做**有界并发**：列表一页 80 条，逐条 await 会把延迟叠成 80 倍。
async function registryLatest(items, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const list = Array.isArray(items) ? items : []
  // 同一个包名只查一次（多条目录条目可能指向同一个包），结果按各自 key 铺开
  const byPkg = new Map()
  for (const it of list) {
    const item = it && typeof it === 'object' ? it : {}
    const pkg = String(item.pkg == null ? '' : item.pkg).trim()
    const key = String(item.key == null ? '' : item.key).trim()
    if (!pkg || !key) continue
    if (!byPkg.has(pkg)) byPkg.set(pkg, [])
    byPkg.get(pkg).push(key)
  }
  const out = Object.create(null)
  if (!byPkg.size) return { ok: true, results: out }
  const pkgs = [...byPkg.keys()]
  const concurrency = Number.isFinite(o.concurrency) && o.concurrency > 0 ? Math.floor(o.concurrency) : LATEST_CONCURRENCY
  let idx = 0
  const worker = async () => {
    while (idx < pkgs.length) {
      const pkg = pkgs[idx++]
      const r = await fetchRegistryLatest(pkg, o)
      for (const key of byPkg.get(pkg)) {
        out[key] = {
          pkg: pkg,
          version: r.version || '',
          error: r.error || '',
          cached: !!r.cached,
        }
      }
    }
  }
  const workers = []
  for (let i = 0; i < Math.min(concurrency, pkgs.length); i++) workers.push(worker())
  await Promise.all(workers)
  return { ok: true, results: out }
}

// 清掉内存缓存（设置页改 URL 后调用，让下一次抓取真的重来）
function clearCache() {
  mem = { at: 0, key: '', data: null, validators: {} }
  latestCache.clear()
  latestFailures.clear()
}

// 拿上一次成功抓到的目录（给「离线兜底」用：settings.js 会把它落 dbStorage）
function peekCache() {
  return mem.data
}

module.exports = {
  OFFICIAL_URL,
  MIRROR_PKG,
  MIRROR_REGISTRY,
  MIRROR_REGISTRIES,
  CACHE_TTL_MS,
  FETCH_TIMEOUT_MS,
  SORTS_DESC,
  parseInstallSpec,
  specKindOf,
  specNeedsBuild,
  normPlugin,
  normCatalog,
  filterPlugins,
  matchKeyword,
  installedMap,
  matchInstalled,
  // 按包名在**原始依赖表**里找版本（形状与 matchInstalledBySpec 一致）——检查更新 / 更新用它
  matchDepByNpm,
  matchInstalledBySpec,
  // 实装版本查表（比 spec 找版本，给「检查更新」用）
  realizedVersionBySpec,
  parseVer,
  cmpVer,
  rangeAllows,
  lowerBoundOf,
  updateState,
  buildSources,
  loadCatalog,
  // 回源 registry 查官方最新版（目录是每日快照，比它新；只在用户点击时调）
  registryLatest,
  clearCache,
  peekCache,
  _untarOne: untarOne,
}
