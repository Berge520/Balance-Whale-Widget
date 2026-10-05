/*
 * 构建门禁的**自身**守卫测试（node --test，零依赖）。
 *
 * 这里不测产品逻辑，测的是「门禁还在链路上」这件事。
 * sync-version.mjs 与 check-shared.mjs 由 prebuild 钩子触发，而 prebuild 只在
 * `npm run build` 时跑；如果有人重写 package.json 的 scripts、把其中一环悄悄删掉，
 * 三关（lint / typecheck / test）依然全绿，构建也照样成功 —— 门禁消失却没有任何信号。
 * 这类「守卫静默退役」是最难发现的失效方式，因此这里对 scripts 与 CI 工作流做契约断言：
 *   - prebuild 必须同时包含 sync-version.mjs（版本号单一来源）与 check-shared.mjs（跨文件副本）
 *   - ci.yml / release.yml 必须真的执行 npm run build（否则 prebuild 永远不会被触发）
 *   - Release 必须校验 tag 与 package.json 版本一致（否则产物与版本号可能各说各话）
 *
 * ⚠️ 只读文件、不写任何东西；断言的是「脚本被接上」这一事实，不校验脚本内部逻辑 ——
 *    内部逻辑由脚本自身的运行结果（构建失败）来兜。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

const pkg = JSON.parse(read('package.json'))
const ci = read('.github/workflows/ci.yml')
const release = read('.github/workflows/release.yml')

test('prebuild 同时挂上 sync-version 与 check-shared', () => {
  const prebuild = pkg.scripts?.prebuild
  assert.ok(prebuild, 'package.json 缺少 prebuild 脚本，两个门禁都不会被触发')
  assert.match(prebuild, /scripts\/sync-version\.mjs/, 'prebuild 少了 sync-version.mjs：版本号不再从 package.json 传播')
  assert.match(prebuild, /scripts\/check-shared\.mjs/, 'prebuild 少了 check-shared.mjs：跨文件副本不再校验')
  assert.match(prebuild, /scripts\/check-dead-settings\.mjs/, 'prebuild 少了 check-dead-settings.mjs：死键体检不再校验')
  assert.match(prebuild, /scripts\/gen-search-index\.mjs\s+--check/, 'prebuild 少了 gen-search-index.mjs --check：搜索全文索引不再校验新鲜度')
})

test('prebuild 仍由 build 触发', () => {
  // npm 会在 `npm run build` 前自动跑 prebuild，前提是 build 脚本存在且未被改名
  assert.ok(pkg.scripts?.build, 'package.json 缺少 build 脚本，prebuild 钩子不会被执行')
})

test('CI 与 Release 都真的执行 npm run build', () => {
  // 只看脚本存在还不够：门禁要靠 build 触发，工作流必须调用它
  for (const [name, yml] of [['ci.yml', ci], ['release.yml', release]]) {
    assert.match(yml, /npm run build/, `${name} 没有执行 npm run build，prebuild 里的门禁形同虚设`)
  }
})

test('CI 真的执行 lint / typecheck / test 三关', () => {
  // 与上一条同理，但针对另外三关：它们不挂在任何钩子上，只能靠工作流显式调用。
  // 若有人精简 ci.yml 时删掉其中一条，本地三关照绿、PR 也不再拦截，
  // 「四关」静默退化成「三关」而没有任何信号 —— 所以在这里钉住。
  //
  // ⚠️ 允许 `npm run test` 与 `npm test` 两种写法：ci.yml 当前用的是后者（别的关用前者），
  //    只认一种会把「换个等价写法」误判成「门禁被删」。行尾锚定，避免前缀相同的脚本
  //    （如 npm run lint-old）被当成通过。
  for (const [script, what] of [['lint', '静态检查'], ['typecheck', '类型检查'], ['test', '单元测试']]) {
    const re = new RegExp(`npm (?:run )?${script}\\s*$`, 'm')
    assert.match(ci, re, `ci.yml 没有执行 npm ${script}，${what}这一关已失效`)
  }
})

test('Release 校验 tag 与 package.json 版本一致', () => {
  // 版本号单一来源是 package.json，tag 只是「这一版要发」的显式动作；
  // 两者对不上会让 Release 的产物与版本号各说各话
  assert.match(release, /GITHUB_REF_NAME/, 'release.yml 没有读取 tag 名，无法校验版本')
  assert.match(release, /package\.json/, 'release.yml 没有读取 package.json 版本，无法校验版本')
})

test('plugin.json 的 feature code 都有 onPluginEnter 分支', () => {
  // 每条 feature 对应一个「指令」：plugin.json 声明 code，services.js 的 onPluginEnter 按
  // action.code 分派。两边必须成对 —— 只加 plugin.json 忘了加分支（或相反）不会报任何错，
  // 表现为「指令能搜到、点了没反应」：这是 uTools 插件最典型且**用户重启插件也修不好**的哑故障，
  // 三关（lint / typecheck / test）全绿也照样发生，故用门禁钉死。
  //
  // 判据：code 要么在 services.js 里以 `code === '<x>'` 显式比较，要么被兜底分支覆盖。
  // 当前 `whale` 走的就是兜底路径（services.js 末尾的默认功能，不写显式比较），
  // 因此这里**只看「有没有人处理」，不要求显式比较**：兜底分支存在即可覆盖未被显式比较的 code。
  const plugin = JSON.parse(read('public/plugin.json'))
  const services = read('public/preload/services.js')

  const codes = (plugin.features || []).map((f) => f && f.code).filter(Boolean)
  assert.ok(codes.length > 0, 'plugin.json 没有任何 feature code，解析规则可能已失效')

  // services.js 里所有显式比较的 code
  const handled = new Set()
  for (const m of services.matchAll(/\bcode\s*===\s*['"]([^'"]+)['"]/g)) handled.add(m[1])

  // 兜底分支：onPluginEnter 回调体内出现的「默认功能」注释锚点。
  // 它一旦被删（例如有人把所有分支改成显式比较却漏了 whale），本测试会立刻报 whale 未处理 ——
  // 这正是我们要拦的形态，故把兜底当作与这条注释绑定的契约。
  const hasFallback = /默认功能（whale）/.test(services)

  const unhandled = codes.filter((c) => !handled.has(c) && !hasFallback)
  assert.deepEqual(unhandled, [],
    `这些 feature code 在 services.js 的 onPluginEnter 里没有任何分支（指令能搜到、点了没反应）：${unhandled.join(', ')}`)

  // 反向：services.js 里比较的 code 必须在 plugin.json 声明。
  // 多出来的分支是死代码 —— 通常意味着 feature 被删了但分支忘了删，或 code 拼错了一个字母
  // （拼错时它既不匹配任何真实指令、又不报错，正是最难发现的一种）。
  const declared = new Set(codes)
  const orphan = [...handled].filter((c) => !declared.has(c))
  assert.deepEqual(orphan, [],
    `services.js 比较了这些 code，但 plugin.json 没有声明对应 feature（死分支或拼写错误）：${orphan.join(', ')}`)
})

test('挂件视觉类配置键在消费方（挂件页 / 宿主建窗）里都有读取点', () => {
  // 「控件有值、没有消费方」初筛（受上游 DeepSeek-Balance-Whale-Widget v0.3.17 的
  // tools/check-dead-settings.mjs 启发）。上游踩过的形态是：设置页滑块能拖、能持久化、
  // 能回显，但运行时代码从不读它 —— 用户调了没用，只能靠「反馈 → 排查」发现。
  //
  // ⚠ 作用范围（别高估它）：这是**回归防护**，不是**新增防护**。
  //   能拦：本表里的键被删掉 / 改名读点 → 立刻红。
  //   拦不住：新加一个挂件控件却忘了接到消费方 —— 新键不在本表，本测试根本不看它。
  //   要拦后者得从 defaultConfig() 全量抽键，但那会误报十几条（见下），故不做。
  //
  // 为什么只挑这批：defaultConfig() 现有 86 个键，其余大批（quotaTotal / historyKeepDays /
  // ghAccel* / dshMarket* 等）的消费方在 App.vue 的计算逻辑或 hosts / dsh 模块里，
  // 形态各异（readConfig().<k>、参数透传等），按键名一律要求「在消费方文件里有读点」
  // 会误报十几条 —— 那正是上游脚本要配 ALLOW 白名单的原因。收窄后本表天然零白名单、免维护。
  //
  // 表内取舍：以「用户可调、且调了直接影响挂件外观/行为」为准；因此含 menuGroups(右键菜单分组)、
  // timerMode/timerAt/timerRemindSec(计时模式) 这类偏行为项 —— 它们同样由挂件页消费，
  // 且「调了没用」的观感与视觉项一致。少数键在 App.vue 里搜不到（配置经 services.saveConfig
  // 的其它路径写入），这不影响本测试：它只查「消费方有没有读」，不查「设置页怎么写」。
  const WIDGET_VISUAL_KEYS = [
    // 外观 / 尺寸
    'scale', 'opacity', 'skin', 'theme', 'passThrough', 'dragLock', 'onTop', 'avoidTaskbar',
    'snapMode', 'snapRatio', 'edgeTop', 'edgeRight', 'edgeBottom', 'edgeLeft',
    'scrollGapOn', 'scrollGapPx', 'menuBtn', 'menuGroups', 'menuGroupsRev',
    // 声音
    'vol', 'soundOn', 'soundSet',
    // 气泡 / 台词
    'bubbleOn', 'timeBubbleOn', 'usageMode', 'peakMode', 'peakRemindOn',
    // 台词：全局停留时长 / 点按推进 / 拖拽台词（都由挂件页消费）
    'bubbleDwell', 'tapAdvance', 'dragLines',
    // 提醒 / 计时
    'lowAlertOn', 'lowAlertAmount', 'budgetOn', 'budgetAmount', 'remindSec',
    'timerMode', 'timerSec', 'timerAt', 'timerNote', 'timerBreakMin', 'timerRemindSec',
    'timerBubblePin', 'timerBubbleOnly', 'timerNotifyOn', 'timerMailOn', 'timerPersistOn',
    'notifyMailOn',
  ]

  // 消费方有**两个**，缺一不可：
  //   - public/floating-page.js：挂件页面自己读的（外观 / 声音 / 气泡 / 计时）
  //   - public/preload/lib/widget.js：宿主侧建窗参数（onTop / avoidTaskbar / edgeX 吸附
  //     与贴边偏移 / scrollGapPx 滚动间隙 —— 这些是**宿主**在摆窗口，页面里根本不出现，
  //     实测 10 个键全落在这边）。
  // 两个文件合起来才算「这批键的运行时消费方」；只看 floating-page.js 会把宿主侧那批误判成死键。
  const consumers = [read('public/floating-page.js'), read('public/preload/lib/widget.js')]
  // 必须剥掉注释与字符串：否则「注释里提到键名」会被当成读取方
  // （上游脚本明确记过这个坑：给函数写一句含键名的说明，契约层立刻被骗过）。
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  const stripped = consumers.map(strip).join('\n')

  // 键必须来自 defaultConfig()：防止本表写了一个配置里根本不存在的键（那样会永远「有读点」或永远误报）
  const storeSrc = read('public/preload/lib/store.js')
  const dft = storeSrc.match(/function defaultConfig\(\)\s*\{\s*return\s*\{([\s\S]*?)\}\s*\}/)
  assert.ok(dft, '没找到 defaultConfig()，解析规则可能已失效')
  const declared = new Set()
  for (const m of dft[1].matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) declared.add(m[1])
  assert.ok(declared.size >= 50, `defaultConfig 只解析出 ${declared.size} 个键，解析规则可疑`)

  const phantom = WIDGET_VISUAL_KEYS.filter((k) => !declared.has(k))
  assert.deepEqual(phantom, [],
    `本表登记了 defaultConfig() 里不存在的键（表已过期或键名拼错）：${phantom.join(', ')}`)

  const dead = WIDGET_VISUAL_KEYS.filter((k) => {
    const re = new RegExp('\\.' + k + '\\b|\\[\\s*[\'"]' + k + '[\'"]\\s*\\]')
    return !re.test(stripped)
  })
  assert.deepEqual(dead, [],
    `这些挂件视觉键在两个消费方（floating-page.js / widget.js）里都没有读取点（设置页能改、但挂件不读 = 调了没用）：${dead.join(', ')}`)
})

test('App.vue 的 data-search 与 SEARCH_INDEX 一一对应', () => {
  // 卡片搜索（跨 Tab 找卡）靠两张表配合：
  //   - 模板上每张卡挂 data-search="<key>"（渲染锚点）
  //   - 脚本里 SEARCH_INDEX 登记 <key> → { label, tab, keys }（检索索引）
  // 只登记一边就会静默坏掉：漏登记 → 搜不到、且搜索态下这张卡永不渲染
  //（cardOn 走 searchHits，不在索引里就命中不了）；多登记 → 产生死链接。
  // 这个坑真实发生过（共享形象 / 共享音效两张卡漏登记），故用门禁钉死。
  const app = read('src/App.vue')

  // 模板里所有 data-search="xxx"（去重）；排除 scrollToCard 里的选择器字符串。
  // 锚点不只在 App.vue：抽出去的异步组件（AccelView）自带 .card，锚点挂在那里，
  // 故连 views/ 下的 .vue 一起扫 —— 只看 App.vue 会把 ghAccel 误判成死链接。
  const templateKeys = new Set()
  const appSrc = app + '\n' + fs.readdirSync(new URL('../src/views', import.meta.url))
    .filter((f) => f.endsWith('.vue'))
    .map((f) => read(`src/views/${f}`)).join('\n')
  for (const m of appSrc.matchAll(/data-search="([A-Za-z0-9_]+)"/g)) templateKeys.add(m[1])

  // SEARCH_INDEX 对象的键：从 `const SEARCH_INDEX ... = {` 到下一个顶层 `}`
  const block = app.match(/const SEARCH_INDEX[^=]*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(block, '没找到 SEARCH_INDEX 定义，解析规则可能已失效')
  const indexKeys = new Set()
  // 只取形如 `  key: {` 的行（行首缩进 + 键名 + 冒号 + 花括号），避开注释与嵌套对象
  for (const m of block[1].matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)) indexKeys.add(m[1])

  // 至少得解析出东西，否则解析规则悄悄失效会让本测试变成永远通过
  assert.ok(templateKeys.size >= 10, `模板里只解析出 ${templateKeys.size} 个 data-search，解析规则可疑`)
  assert.ok(indexKeys.size >= 10, `SEARCH_INDEX 只解析出 ${indexKeys.size} 个键，解析规则可疑`)

  const missingInIndex = [...templateKeys].filter((k) => !indexKeys.has(k))
  const missingInTpl = [...indexKeys].filter((k) => !templateKeys.has(k))
  assert.deepEqual(missingInIndex, [],
    `这些卡有 data-search 但 SEARCH_INDEX 没登记（搜不到、搜索态下也不渲染）：${missingInIndex.join(', ')}`)
  assert.deepEqual(missingInTpl, [],
    `SEARCH_INDEX 登记了但模板没有对应 data-search（死链接）：${missingInTpl.join(', ')}`)

  // label 必须与卡片 <h2> 一致：搜索命中后，标签上显示的是 SEARCH_INDEX.label，
  // 点进去看到的却是 <h2>，两者不一致会让用户以为点错了卡。
  // 取法：先剥掉 HTML 注释（注释里会提到 <h2>，不清会误匹配），再按 <section … data-search="key" …>
  // 定位到该卡，取其内第一处 <h2> 的**纯文本**（卡头可能含 caret / 摘要等 span，只比对可读文字）。
  const labelOf = {}
  for (const m of block[1].matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{[^}]*?label:\s*'([^']*)'/gm)) labelOf[m[1]] = m[2]
  const noComment = appSrc.replace(/<!--[\s\S]*?-->/g, '')
  // 所有卡片的起始位置（<section ... data-search="key" ...>）
  const sections = []
  for (const m of noComment.matchAll(/<section\b[^>]*data-search="([A-Za-z0-9_]+)"[^>]*>/g)) {
    sections.push({ key: m[1], start: m.index + m[0].length })
  }
  const h2Of = {}
  const stripTags = (s) => s
    .replace(/<span[^>]*class="(?:caret|card-sum|gh-accel-sum|gh-accel-caret)[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]+>/g, '')        // 去掉剩余标签（含 span 包裹）
    .replace(/\{\{[^}]*\}\}/g, '') // 去掉未渲染的插值（若有）
    .replace(/\s+/g, ' ')
    .trim()
  for (let i = 0; i < sections.length; i++) {
    const seg = noComment.slice(sections[i].start, sections[i + 1] ? sections[i + 1].start : undefined)
    const h = seg.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
    if (h) h2Of[sections[i].key] = stripTags(h[1])
  }
  const mismatched = []
  for (const k of Object.keys(labelOf)) {
    if (!h2Of[k]) continue // 组件卡片（AccelView）的 h2 不在 App.vue，跳过
    // 卡头可能带装饰性前后缀（如 ghAccel 的 caret），用「包含」判定比「相等」稳：
    // 索引名是「干净名字」，卡头可含额外符号，只要索引名是卡头文字的一部分即可。
    if (!h2Of[k].includes(labelOf[k])) mismatched.push(`${k}: 索引「${labelOf[k]}」不在卡头「${h2Of[k]}」中`)
  }
  assert.ok(Object.keys(h2Of).length >= 10, `只匹配到 ${Object.keys(h2Of).length} 个卡片 h2，解析规则可疑`)
  assert.deepEqual(mismatched, [],
    `SEARCH_INDEX.label 与卡片标题不一致（搜索标签会显示成另一个名字）：\n  ${mismatched.join('\n  ')}`)
})

test('卡内每个字段名都能被该卡的搜索索引命中（label/keys 覆盖）', () => {
  // 第二层守卫：上面只保证「索引 ↔ 锚点」成对，保证不了「卡里新加的字段有关键词」——
  // 真实踩过：加「界面深浅色」下拉时忘了给「挂件外观」卡补关键词，搜「界面」静默零命中，
  // 三关全绿、无任何报警。这里的口径：把每张卡模板里用户可见的**字段名**（.label 文本 +
  // 折叠钮 / 链接钮等 .link-btn 文本）抠出来，要求每个名字（归一化后）出现在该卡的
  // SEARCH_INDEX「label+keys」串里。新字段忘了配词 → 这里红，当场补。
  //
  // ⚠️ 白名单是**欠账清单**不是免检牌：只允许「历史遗留、值得配词但还没配」的条目，
  //    新增字段不许进（进来就说明有人在绕闸门）。清一条删一条，目标永远是空表。
  const app = read('src/App.vue')
  // 与上一测试同口径：锚点也可能在 views/ 下的异步组件里
  const appSrc = app + '\n' + fs.readdirSync(new URL('../src/views', import.meta.url))
    .filter((f) => f.endsWith('.vue'))
    .map((f) => read(`src/views/${f}`)).join('\n')

  // 解析 SEARCH_INDEX（同上一测试的取法）
  const block = app.match(/const SEARCH_INDEX[^=]*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(block, '没找到 SEARCH_INDEX 定义，解析规则可能已失效')
  const indexOf = {}
  for (const m of block[1].matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{[^}]*?label:\s*'([^']*)',\s*tab:\s*'[^']*',\s*keys:\s*'([^']*)'/gm)) {
    indexOf[m[1]] = { label: m[2], keys: m[3] }
  }
  assert.ok(Object.keys(indexOf).length >= 10, `SEARCH_INDEX 只解析出 ${Object.keys(indexOf).length} 项，解析规则可疑`)

  // 与运行时 normSearch 一致：小写 + 删空白（App.vue 是中文界面，lowercase 只影响英文词）
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '')

  // 卡片分段（同上一测试）：按 <section … data-search="key"> 切片
  const noComment = appSrc.replace(/<!--[\s\S]*?-->/g, '')
  const sections = []
  for (const m of noComment.matchAll(/<section\b[^>]*data-search="([A-Za-z0-9_]+)"[^>]*>/g)) {
    sections.push({ key: m[1], start: m.index + m[0].length })
  }

  // 每张卡的用户可见字段名：只抠 <span class="label">（允许带修饰类）。动作按钮（删除 / 取消 /
  // 复制地址这类 link-btn / utils-btn）不算字段 —— 它们是操作不是设置项，逐个配词没有意义。
  // 字段名取「主干」：剥标签/插值后，再去掉括号补充说明（全角（…）与半角 (…)）与引号——
  // 说明句不可能也不该要求关键词覆盖（如「音量（0–100%）」只需覆盖「音量」）；
  // 主干不足 2 字的（「·」、动态插值剥完剩下的空壳）也不是检索目标，直接丢弃。
  const fieldNamesOf = {}
  for (let i = 0; i < sections.length; i++) {
    const seg = noComment.slice(sections[i].start, sections[i + 1] ? sections[i + 1].start : undefined)
    const raws = []
    for (const m of seg.matchAll(/<span class="label[^"]*">([\s\S]*?)<\/span>/g)) raws.push(m[1])
    const coreOf = (s) => s
      .replace(/<[^>]+>/g, '')
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/（[^（）]*）/g, '')
      .replace(/\([^()]*\)/g, '')
      .replace(/[「」『』「」""'']/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const names = raws.map(coreOf).filter((s) => s.length >= 2)
    fieldNamesOf[sections[i].key] = [...new Set(names)]
  }

  // 覆盖判定 = 「弱可达」：字段主干里**存在**任一 ≥2 字的子串出现在该卡「label+keys」串里。
  // 语义：用户敲字段名里的任一个词（如「预警阈值」敲「阈值」、「峰谷切换提醒」敲「峰谷」或「提醒」）
  // 都能命中这张卡。不要求整名可达 —— 句子式标签（「到点后给休息快捷键」）里「后给」这类
  // 虚词进词表纯属污染；整串连续匹配（搜「预警阈值」四字连打）受中文分词所限，属已知边界，
  // 多词 AND（「预警 阈值」带空格）已由运行时覆盖。
  const reachable = (name, hay) => {
    for (let i = 0; i < name.length - 1; i++) {
      for (let j = i + 2; j <= name.length; j++) {
        if (hay.includes(name.slice(i, j))) return true
      }
    }
    return false
  }

  const uncovered = []
  for (const key of Object.keys(fieldNamesOf)) {
    if (!indexOf[key]) continue // 上一测试已拦「有锚点没索引」，这里不重复报
    const hay = norm(indexOf[key].label + ' ' + indexOf[key].keys)
    for (const name of fieldNamesOf[key]) {
      if (!reachable(norm(name), hay)) uncovered.push(`${key}: 「${name}」`)
    }
  }
  assert.ok(Object.keys(fieldNamesOf).length >= 10, `只匹配到 ${Object.keys(fieldNamesOf).length} 张卡的字段，解析规则可疑`)
  assert.deepEqual(uncovered, [],
    `这些字段名在所属卡的搜索关键词里不可达（用户按字段名搜索会零命中）。把缺的词补进该卡 keys：\n  ${uncovered.join('\n  ')}`)
})
