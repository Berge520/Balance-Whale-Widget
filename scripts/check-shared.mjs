/*
 * 跨文件副本一致性校验
 *
 * 同一份常量在宿主 / 设置页 / 浮动页 / 样式表里各留了一份副本，这些副本消不掉：
 *   - preload 不参与 Vite 打包，设置页拿不到宿主 constants
 *   - 浮动页没有 require，读不到宿主常量
 *   - 窗口留白是 CSS 变量，宿主读不到
 * 改一处忘另一处只会静默不一致（挂件与设置页显示不同的默认台词、阈值、留白…），
 * 因此这里逐对比对，不一致直接让构建失败。
 *
 * 由 npm run build 的 prebuild 钩子自动执行，也可手动执行：node scripts/check-shared.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

// 从 marker 之后第一个 { 或 [ 开始，取括号配平的整段字面量，再压掉空白便于比对。
// 只处理本仓库里这些简单字面量：字符串用引号跟踪跳过，行注释整段丢弃。
function jsLiteral(marker) {
  return (src, file) => {
    const at = src.indexOf(marker)
    if (at < 0) throw new Error(`${file} 里找不到「${marker}」`)
    const rest = src.slice(at + marker.length)
    const off = rest.search(/[[{]/)
    if (off < 0) throw new Error(`${file} 里「${marker}」后面没有对象/数组字面量`)
    const from = at + marker.length + off
    const open = src[from]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let quote = ''
    for (let i = from; i < src.length; i++) {
      const ch = src[i]
      if (quote) {
        if (ch === '\\') { i++; continue }
        if (ch === quote) quote = ''
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i)
        if (nl < 0) break
        i = nl
        continue
      }
      if (ch === open) depth++
      else if (ch === close && --depth === 0) {
        return src.slice(from, i + 1).replace(/\s+/g, '')
      }
    }
    throw new Error(`${file} 里「${marker}」的括号没有配平`)
  }
}

// JS 里的数字常量（如 const WIN_PAD = 200）
function jsNumber(marker) {
  return (src, file) => {
    const m = src.match(new RegExp(marker + '\\s*=\\s*(-?[\\d.]+)'))
    if (!m) throw new Error(`${file} 里找不到「${marker}」`)
    return m[1]
  }
}

// JS 里「有值就取值、没值回落默认」形态的兜底数字（如 var port = s.port || 3080）。
// 不能用 jsNumber：它的 `=\s*数字` 要求等号后紧跟数字，而这里等号后是 `s.port || 3080`，
// 取不到会直接抛「找不到 marker」，把一条真实存在的副本报成缺失。
function jsFallbackNumber(marker) {
  return (src, file) => {
    const m = src.match(new RegExp(marker + '\\s*=\\s*[^|\\n]*\\|\\|\\s*(-?[\\d.]+)'))
    if (!m) throw new Error(`${file} 里找不到「${marker}」的 || 回落值`)
    return m[1]
  }
}

// CSS 变量（如 --whale-pad: 200px），比对时去掉单位
function cssPx(name) {
  return (src, file) => {
    const m = src.match(new RegExp('--' + name + '\\s*:\\s*([^;}]+)'))
    if (!m) throw new Error(`${file} 里找不到 --${name}`)
    return m[1].trim().replace(/px$/i, '')
  }
}

// 字符串常量（如 const DEFAULT_SKIN = 'DSniang1'）
function jsString(marker) {
  return (src, file) => {
    const m = src.match(new RegExp(marker + '\\s*=\\s*[\'"]([^\'"]*)[\'"]'))
    if (!m) throw new Error(`${file} 里找不到「${marker}」`)
    return m[1]
  }
}

// 内置形象清单三处副本的**形态不同**：挂件页是「id → 相对路径」对象，宿主与设置页是 id 数组。
// 这里统一抽成「排序后逗号连接」的 id 列表再比对 —— 比对的是 id 集合与个数，不含路径与顺序。
function skinIdsFromObject(marker) {
  return (src, file) => {
    const body = jsLiteral(marker)(src, file)
    const ids = [...body.matchAll(/(?:^|[{,])(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))\s*:/g)]
      .map((m) => m[1] ?? m[2] ?? m[3])
    if (!ids.length) throw new Error(`${file} 里「${marker}」没解析出任何 id`)
    return ids.sort().join(',')
  }
}
function skinIdsFromArray(marker) {
  return (src, file) => {
    const body = jsLiteral(marker)(src, file)
    const ids = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
    if (!ids.length) throw new Error(`${file} 里「${marker}」没解析出任何 id`)
    return ids.sort().join(',')
  }
}

// 账本历史保留天数的**形态不同**：宿主是三个数字常量（HISTORY_KEEP_DEFAULT / _MIN / _MAX），
// 设置页是一个对象（HISTORY_KEEP = { DEFAULT, MIN, MAX }）。两边都抽成「默认,下限,上限」再比对。
function historyKeepFromConstants(src, file) {
  const one = (marker) => {
    const m = src.match(new RegExp(marker + '\\s*=\\s*(-?[\\d.]+)'))
    if (!m) throw new Error(`${file} 里找不到「${marker}」`)
    return m[1]
  }
  return [one('const HISTORY_KEEP_DEFAULT'), one('const HISTORY_KEEP_MIN'), one('const HISTORY_KEEP_MAX')].join(',')
}
function historyKeepFromObject(marker) {
  return (src, file) => {
    const body = jsLiteral(marker)(src, file)
    const one = (key) => {
      const m = body.match(new RegExp(key + '\\s*:\\s*(-?[\\d.]+)'))
      if (!m) throw new Error(`${file} 里「${marker}」没有 ${key}`)
      return m[1]
    }
    return [one('DEFAULT'), one('MIN'), one('MAX')].join(',')
  }
}

// 内置音色两组（按压 / 释放）的文件路径同样是两份副本：挂件页是 `SOUND_FILES` 对象（真正播放用），
// 设置页「资源」Tab 的「内置资源」试听用 `BUILTIN_SOUND_SETS` 数组。两边形态不同，统一抽成
// 「排序后逗号连接」的 ./whale/*.mp3 路径再比对 —— 改一处忘另一处会让试听与挂件实际播的不是同一个文件。
function whaleMp3Paths(marker) {
  return (src, file) => {
    const at = src.indexOf(marker)
    if (at < 0) throw new Error(`${file} 里找不到「${marker}」`)
    // 从「= 之后的第一个括号」起算：设置页那份带 TS 类型注解（`Array<{...}> = [`），
    // 直接取 marker 之后的第一个括号会落在类型注解上。因此 marker 只写到变量名、**不要带 `=`**，
    // 否则会在后面正文里再找一个「= {」当成赋值。
    const rest = src.slice(at + marker.length)
    const m = rest.match(/=\s*([[{])/)
    if (!m) throw new Error(`${file} 里「${marker}」后面没有赋值字面量`)
    const from = at + marker.length + m.index + m[0].length - 1
    const body = balanced(src, from, file, marker)
    const paths = [...body.matchAll(/['"](\.\/whale\/[^'"]+\.mp3)['"]/g)].map((x) => x[1])
    if (!paths.length) throw new Error(`${file} 里「${marker}」没解析出任何内置音效路径`)
    return paths.sort().join(',')
  }
}

// 随机台词组的内置默认：宿主是 `QUOTE_GROUPS_DEFAULT` 字面量，挂件页是 `defaultRandomGroups()` 的返回值。
// 两边形态不同（台词分别来自 QUOTES_DEFAULT / QUOTES），但「组的顺序 + 类型 + 权重 + 字号」必须一致，
// 否则设置页显示的内置六组与挂件实际抽签的六组对不上。抽成「kind,w,style|kind,w,…」再比对
function quoteGroupShape(marker) {
  return (src, file) => {
    const body = jsLiteral(marker)(src, file)
    const items = [...body.matchAll(/kind\s*:\s*'([a-z]+)'\s*,\s*w\s*:\s*(\d+)(?:\s*,\s*style\s*:\s*'([AB])')?/g)]
      .map((m) => [m[1], m[2], m[3] || ''].join(','))
    if (!items.length) throw new Error(`${file} 里「${marker}」没解析出任何台词组`)
    return items.join('|')
  }
}

// 气泡三行字号（label / amount / period）外加 hint：CSS 里是**未缩小时的默认值**（字号写在
// .dshwv-xxx 规则里），floating-page.js 的 BUBBLE_FONT 是**超框缩小时的基准**。两份值必须相等，
// 否则「内容超框」前后字号会跳变（页面写行内 calc(var(--dshw-u) * N) 覆盖 CSS，基准不一样就断层）。
// 两边形态不同：JS 是对象字面量、CSS 是四条独立规则，统一抽成「label,amount,period,hint」再比对。
function bubbleFontFromJs(marker) {
  return (src, file) => {
    const at = src.indexOf(marker)
    if (at < 0) throw new Error(`${file} 里找不到「${marker}」`)
    // 取到本行结尾即可：BUBBLE_FONT 是单行对象字面量
    const line = src.slice(at, src.indexOf('\n', at))
    const one = (key) => {
      const m = line.match(new RegExp("'" + key + "'\\s*:\\s*(\\d+)"))
      if (!m) throw new Error(`${file} 里「${marker}」没有 ${key}`)
      return m[1]
    }
    return [one('dshwv-label'), one('dshwv-amount'), one('dshwv-period'), one('dshwv-hint')].join(',')
  }
}
function bubbleFontFromCss(src, file) {
  const one = (cls) => {
    const m = src.match(new RegExp(
      '\\.' + cls + "\\s*\\{[^}]*font-size\\s*:\\s*calc\\(var\\(--dshw-u\\)\\s*\\*\\s*(\\d+)\\)"
    ))
    if (!m) throw new Error(`${file} 里 .${cls} 没有 calc(var(--dshw-u) * N) 字号`)
    return m[1]
  }
  return [one('dshwv-label'), one('dshwv-amount'), one('dshwv-period'), one('dshwv-hint')].join(',')
}

// 气泡配色的**默认主题**：floating-page.js 的 THEMES.default 是换主题时**会写**的值，
// floating.css 里 var(--dshwv-xxx, #兜底) 的兜底色是「JS 没来得及写变量」时的显示值。
// 两者必须一致，否则首帧（主题未应用）与常态颜色不同。取 THEMES.default 与 CSS 四个兜底色比对。
function themeDefaultFromJs(marker) {
  return (src, file) => {
    const at = src.indexOf(marker)
    if (at < 0) throw new Error(`${file} 里找不到「${marker}」`)
    const m = src.slice(at).match(/default\s*:\s*\{([^}]*)\}/)
    if (!m) throw new Error(`${file} 里「${marker}」没有 default 主题`)
    const one = (key) => {
      const x = m[1].match(new RegExp(key + "\\s*:\\s*'([^']+)'"))
      if (!x) throw new Error(`${file} 里 default 主题没有 ${key}`)
      return x[1].toUpperCase()
    }
    return [one('text'), one('hint'), one('fill'), one('stroke')].join(',')
  }
}
function themeDefaultFromCss(src, file) {
  const one = (v) => {
    const m = src.match(new RegExp('var\\(--' + v + "\\s*,\\s*(#[0-9A-Fa-f]{6})\\)"))
    if (!m) throw new Error(`${file} 里 var(--${v}, #...) 没有兜底色`)
    return m[1].toUpperCase()
  }
  return [one('dshwv-text'), one('dshwv-hint'), one('dshwv-fill'), one('dshwv-stroke')].join(',')
}

// 气泡字号单位 u = 挂件基准 / 1026：除数在 CSS 的 --dshw-u 定义里，floating-page.js 只在
// BUBBLE_FONT **上方的注释块**里记了同一个 1026（注释在声明前一行，不是同一行）。
// 这是「注释 vs 代码」的比对 —— 看着弱，但除数一改（如 /1024）而不动另一边，
// 字号基准就整体错位且**无任何报错**，故值得钉住。
function uDivisorFromCss(src, file) {
  const m = src.match(/--dshw-u\s*:\s*calc\(var\(--dshw-base\)\s*\/\s*(\d+)\)/)
  if (!m) throw new Error(`${file} 里 --dshw-u 不是 calc(var(--dshw-base) / N)`)
  return m[1]
}
// 取 marker **之前**最近的一段连续行注释里出现的「/ N」，即「单位 u = 挂件基准 / 1026」那句
function uDivisorFromJsComment(marker) {
  return (src, file) => {
    const at = src.indexOf(marker)
    if (at < 0) throw new Error(`${file} 里找不到「${marker}」`)
    const before = src.slice(0, at)
    const start = before.lastIndexOf('\n\n')
    const block = before.slice(start < 0 ? 0 : start)
    const m = block.match(/\/\s*(\d{3,5})\s*[,，；;）)]?\s*(?:与|$|\n)/)
    if (!m) throw new Error(`${file} 里「${marker}」上方注释没有「单位 u = 挂件基准 / N」`)
    return m[1]
  }
}

// 从 openAt 处的括号起取配平整段（字符串 / 行注释跳过），压掉空白便于比对
function balanced(src, openAt, file, marker) {
  const open = src[openAt]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let quote = ''
  for (let i = openAt; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return src.slice(openAt, i + 1).replace(/\s+/g, '')
  }
  throw new Error(`${file} 里「${marker}」的括号没有配平`)
}

const CONSTANTS = 'public/preload/lib/constants.js'
const FLOATING_PAGE = 'public/floating-page.js'
const FLOATING_CSS = 'public/floating.css'
const STORE = 'public/preload/lib/store.js'
const APP_VUE = 'src/App.vue'

const CHECKS = [
  {
    name: '峰谷时段表',
    parts: [
      { file: CONSTANTS, pick: jsLiteral('const PEAK_HOURS =') },
      { file: FLOATING_PAGE, pick: jsLiteral('var PEAK_HOURS =') },
    ],
  },
  {
    name: '币种前缀 MODEL_MONEY_PREFIX',
    parts: [
      { file: CONSTANTS, pick: jsLiteral('const MODEL_MONEY_PREFIX =') },
      { file: FLOATING_PAGE, pick: jsLiteral('var MODEL_MONEY_PREFIX =') },
    ],
  },
  {
    name: '低余额阈值 LOW_ALERT_BY_CURRENCY',
    parts: [
      { file: CONSTANTS, pick: jsLiteral('const LOW_ALERT_BY_CURRENCY =') },
      { file: APP_VUE, pick: jsLiteral('LOW_ALERT_DEFAULT') },
    ],
  },
  {
    name: '台词库默认值 QUOTES_DEFAULT',
    parts: [
      { file: STORE, pick: jsLiteral('const QUOTES_DEFAULT =') },
      { file: FLOATING_PAGE, pick: jsLiteral('var QUOTES =') },
    ],
  },
  {
    name: '随机台词组默认顺序与权重 QUOTE_GROUPS_DEFAULT',
    parts: [
      { file: STORE, pick: quoteGroupShape('const QUOTE_GROUPS_DEFAULT =') },
      { file: FLOATING_PAGE, pick: quoteGroupShape('function defaultRandomGroups()') },
    ],
  },
  {
    name: '提醒文案模板 ALERTS_DEFAULT',
    parts: [
      { file: STORE, pick: jsLiteral('const ALERTS_DEFAULT =') },
      { file: FLOATING_PAGE, pick: jsLiteral('var ALERTS =') },
    ],
  },
  {
    name: '自定义单价默认值 TOKEN_PRICE_DEFAULT',
    parts: [
      { file: CONSTANTS, pick: jsLiteral('const TOKEN_PRICE_DEFAULT =') },
      { file: APP_VUE, pick: jsLiteral('const TOKEN_PRICE_DEFAULT =') },
    ],
  },
  {
    name: '窗口留白 WIN_PAD',
    parts: [
      { file: CONSTANTS, pick: jsNumber('const WIN_PAD') },
      { file: FLOATING_CSS, pick: cssPx('whale-pad') },
    ],
  },
  // 缩放范围有三份：宿主判定上下限、挂件滚轮缩放、设置页滑块。
  // 注意同在这三处的还有「1–20 档 ↔ 实际倍率」的换算（(MAX_SCALE - MIN_SCALE) / 19），
  // 那是表达式、没法在这里比对，改范围时记得一起看。
  {
    name: '缩放下限 MIN_SCALE',
    parts: [
      { file: CONSTANTS, pick: jsNumber('const MIN_SCALE') },
      { file: FLOATING_PAGE, pick: jsNumber('MIN_SCALE') },
      { file: APP_VUE, pick: jsNumber('const MIN_SCALE') },
    ],
  },
  {
    name: '缩放上限 MAX_SCALE',
    parts: [
      { file: CONSTANTS, pick: jsNumber('const MAX_SCALE') },
      { file: FLOATING_PAGE, pick: jsNumber('MAX_SCALE') },
      { file: APP_VUE, pick: jsNumber('const MAX_SCALE') },
    ],
  },
  {
    name: '避让滚动条默认留白 SCROLL_GAP_DEFAULT',
    parts: [
      { file: STORE, pick: jsNumber('const SCROLL_GAP_DEFAULT') },
      { file: APP_VUE, pick: jsNumber('const SCROLL_GAP_DEFAULT') },
    ],
  },
  // 吸附区宽度（可用区宽/高的百分比）范围与默认值：宿主 store.js 与设置页各一份，
  // 设置页那份同时用在滑块上下限（:min / :max）上，改一处忘另一处会出现
  // 「滑块拖得到、宿主被 clamp」这类静默不一致
  {
    name: '吸附区宽度下限 SNAP_RATIO_MIN',
    parts: [
      { file: STORE, pick: jsNumber('const SNAP_RATIO_MIN') },
      { file: APP_VUE, pick: jsNumber('const SNAP_RATIO_MIN') },
    ],
  },
  {
    name: '吸附区宽度上限 SNAP_RATIO_MAX',
    parts: [
      { file: STORE, pick: jsNumber('const SNAP_RATIO_MAX') },
      { file: APP_VUE, pick: jsNumber('const SNAP_RATIO_MAX') },
    ],
  },
  {
    name: '吸附区宽度默认值 SNAP_RATIO_DEFAULT',
    parts: [
      { file: STORE, pick: jsNumber('const SNAP_RATIO_DEFAULT') },
      { file: APP_VUE, pick: jsNumber('const SNAP_RATIO_DEFAULT') },
    ],
  },
  // 内置形象清单同样是三份（挂件页对象 / 宿主数组 / 设置页数组），加形象只改一处
  // 会出现「设置页选得到、挂件不认」这类静默不一致。
  {
    name: '内置形象清单 BUILTIN_SKINS',
    parts: [
      { file: FLOATING_PAGE, pick: skinIdsFromObject('var BUILTIN_SKINS =') },
      { file: STORE, pick: skinIdsFromArray('const BUILTIN_SKINS =') },
      { file: APP_VUE, pick: skinIdsFromArray('const BUILTIN_SKINS =') },
    ],
  },
  {
    name: '默认形象 DEFAULT_SKIN',
    parts: [
      { file: FLOATING_PAGE, pick: jsString('var DEFAULT_SKIN') },
      { file: STORE, pick: jsString('const DEFAULT_SKIN') },
      { file: APP_VUE, pick: jsString('const DEFAULT_SKIN') },
    ],
  },
  // 「按模型覆盖」的条目数上限：宿主 constants 与设置页各一份，改一处忘另一处会出现
  // 「设置页能加、宿主被截断」这类静默不一致
  {
    name: '按模型覆盖上限 TOKEN_PRICE_MODELS_MAX',
    parts: [
      { file: CONSTANTS, pick: jsNumber('const TOKEN_PRICE_MODELS_MAX') },
      { file: APP_VUE, pick: jsNumber('const PRICE_MODEL_MAX') },
    ],
  },
  {
    name: '账本历史保留天数 HISTORY_KEEP',
    parts: [
      { file: STORE, pick: historyKeepFromConstants },
      { file: APP_VUE, pick: historyKeepFromObject('const HISTORY_KEEP =') },
    ],
  },
  {
    name: '内置音效文件 SOUND_FILES',
    parts: [
      { file: FLOATING_PAGE, pick: whaleMp3Paths('var SOUND_FILES') },
      { file: APP_VUE, pick: whaleMp3Paths('const BUILTIN_SOUND_SETS') },
    ],
  },
  // 一键隔离的单次写入上限：宿主 dsh-isolate.js 拿它做准入判断（超限直接拒绝），
  // 设置页拿它做勾选量的提前拦截。两边不一致会出现「界面放行、宿主拒绝」的割裂，
  // 或更糟的「界面拦下了宿主其实能写的条数」。
  {
    name: '一键隔离写入上限 MAX_BATCH',
    parts: [
      { file: 'public/preload/lib/dsh-isolate.js', pick: jsNumber('const MAX_BATCH') },
      { file: APP_VUE, pick: jsNumber('const DSH_ISOLATE_MAX_BATCH') },
    ],
  },
  // 「最新（含测试版）」哨兵值：宿主 constants.js 与设置页各一份 ——
  // 设置页要按它算「更新会装到哪个版本」的提示文案（含下拉选项的 value），宿主拿它决定实际装什么。
  // 字面量写错会出现「选得到、装不到」或「提示说要装 X、实际装了 Y」这类静默不一致。
  // 版本比较口径（isNewer / dshVerNewer）是表达式、没法在这里比对，改一处务必同步另一处。
  {
    name: '最新版哨兵值 NEWEST_VERSION',
    parts: [
      { file: CONSTANTS, pick: jsString('const NEWEST_VERSION') },
      { file: APP_VUE, pick: jsString('const NEWEST_VERSION') },
    ],
  },
  // dsh Web UI 的默认监听端口：宿主 constants.js 与设置页各一份 ——
  // 设置页拿它当输入框的默认值与非法值兜底，宿主拿它决定 spawn dsh 时 `--port` 的默认值。
  // 写错会出现「界面显示 3080、实际监听别的端口」这类静默不一致（诊断卡的目标端口也跟着错）。
  // 挂件页还有第三份：状态行取快照的 s.port，只在快照缺 port 时回落到这个字面量 ——
  // 它是条兜底路径，正常拿不到快照里没有 port，正因如此漏了就很难被人工发现，必须一起纳入校验。
  {
    name: 'dsh 默认端口 DSH_PORT_DEFAULT',
    parts: [
      { file: CONSTANTS, pick: jsNumber('const DSH_PORT_DEFAULT') },
      { file: APP_VUE, pick: jsNumber('const DEFAULT_DSH_PORT') },
      { file: FLOATING_PAGE, pick: jsFallbackNumber('var port') },
    ],
  },
  // 气泡字号基准：CSS 的四条 font-size 是未缩小时默认值，floating-page.js 的 BUBBLE_FONT 是
  // 超框缩小时的基准。两边不等会让「内容超框」前后字号跳变。
  {
    name: '气泡字号基准 BUBBLE_FONT',
    parts: [
      { file: FLOATING_PAGE, pick: bubbleFontFromJs('var BUBBLE_FONT =') },
      { file: FLOATING_CSS, pick: bubbleFontFromCss },
    ],
  },
  // 气泡配色默认主题：JS 的 THEMES.default（会写入）与 CSS 的 var(--dshwv-xxx, #兜底)（首帧兜底）
  // 必须一致，否则主题应用前后的颜色不同。
  {
    name: '气泡默认配色 THEMES.default',
    parts: [
      { file: FLOATING_PAGE, pick: themeDefaultFromJs('var THEMES =') },
      { file: FLOATING_CSS, pick: themeDefaultFromCss },
    ],
  },
  // 气泡字号单位 u 的除数：CSS 的 --dshw-u 定义 vs floating-page.js BUBBLE_FONT 上方的注释。
  // 除数改动而不动另一边会让字号基准整体错位且无任何报错。
  {
    name: '气泡字号单位除数 --dshw-u',
    parts: [
      { file: FLOATING_CSS, pick: uDivisorFromCss },
      { file: FLOATING_PAGE, pick: uDivisorFromJsComment('var BUBBLE_FONT =') },
    ],
  },
  // 到点留言长度上限三处副本：宿主 constants（清洗用）、挂件页（菜单输入框取用）、
  // 设置页（输入框 maxLength）。改一处忘另一处会出现「界面能敲进去、宿主悄悄截掉」。
  {
    name: '到点留言长度上限 TIMER_NOTE_MAX',
    parts: [
      { file: CONSTANTS, pick: jsNumber('const TIMER_NOTE_MAX') },
      { file: FLOATING_PAGE, pick: jsNumber('var TIMER_NOTE_MAX') },
      { file: APP_VUE, pick: jsNumber('const TIMER_NOTE_MAX') },
    ],
  },
  // 随机台词组条目数上限两处副本：宿主 store.js 的 normQuoteGroups（超出的截掉）
  // 与设置页的「+ 添加组」按钮（达上限禁用）。不一致会出现「按钮让加、宿主却截掉」。
  {
    name: '随机台词组上限 QUOTE_GROUP_MAX',
    parts: [
      { file: STORE, pick: jsNumber('const QUOTE_GROUP_MAX') },
      { file: APP_VUE, pick: jsNumber('const QUOTE_GROUP_MAX') },
    ],
  },
]

let bad = 0
for (const c of CHECKS) {
  const vals = c.parts.map((p) => {
    try {
      return { file: p.file, v: p.pick(read(p.file), p.file) }
    } catch (err) {
      // ⚠️ 读失败必须**独立计为坏**，不能混进下面那套「取值是否全等」的比较：
      //    两侧都读失败时错误串完全相同，`new Set(...).size === 1` 会把它判成「一致」，
      //    构建门禁就被绕过了（marker 写错 → 两处都抛同一条 → 静默放行）。
      return { file: p.file, v: null, err: err.message }
    }
  })
  const failed = vals.filter((x) => x.err)
  if (failed.length) {
    bad++
    console.error(`[check-shared] ${c.name} 读取失败：`)
    for (const x of failed) console.error(`  ${x.file}\n    读取失败：${x.err}`)
    continue
  }
  if (new Set(vals.map((x) => x.v)).size === 1) {
    console.log(`[check-shared] ${c.name} 一致`)
    continue
  }
  bad++
  console.error(`[check-shared] ${c.name} 不一致：`)
  for (const x of vals) console.error(`  ${x.file}\n    ${x.v}`)
}

if (bad) {
  console.error(`[check-shared] ${bad} 处副本不一致，请同步后再构建`)
  process.exit(1)
}
console.log('[check-shared] 全部副本一致')
