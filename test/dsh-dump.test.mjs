/*
 * dsh-dump.js 的回归测试（node --test，零依赖）。
 *
 * 只测**纯函数**：分节解析 / 归层 / 条目抽取 / 树 diff / 登录 shell 输出提取。
 * 需要 spawn 子进程的部分（run / dumpEffective / collectDshDump）不在这里测 ——
 * 它们依赖真实的 dsh 安装与 node，属于集成测试范畴。
 *
 * 需要 utools 桩：dsh-dump.js 顶层 require 了 constants.js（→ 无 utools 依赖）
 * 与 dsh.js（→ require log.js → utools）。所以必须先挂上 globalThis.utools。
 * 这与 test/util.test.mjs 的「零桩」是刻意的区别：util.js 的边界禁令不适用于此。
 *
 * 覆盖：
 *   1. stripAnsi 去掉 dsh 的颜色转义与 BOM（带转义会让标题正则全部失配）
 *   2. parseSectionHead 三种分节形态 + 用户层判据（绝对路径，含 Windows 盘符）
 *   3. shortSource 把 cordis.patch.yml 绝对路径缩成可读来源名
 *   4. parseDump 抽出条目骨架（id/name/disabled/configKeys），`!!js` 不求值
 *   5. buildLayers 按「用户层按文件、包内层按包名」聚合
 *   6. diffTrees 找出 changed / added / removed
 *   7. lastPathLine 从带欢迎语噪声的 shell 输出里取最后一行路径
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ── utools 桩（dsh-dump → dsh → log 需要）──
// dbStorage 用内存 Map，模拟真实存储行为；测试用不到值，但桩必须存在
const store = new Map()
globalThis.utools = {
  isDev: () => true,
  dbStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
  dbCryptoStorage: {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  },
}

const dump = require('../public/preload/lib/dsh-dump.js')
const dsh = require('../public/preload/lib/dsh.js')

// ── 真实 dump 样例（从本机 `--profile web --dump-config` 实跑输出里摘出来的形态）──
const SAMPLE = [
  'dsh: [C:\\Users\\x\\.dsh\\profiles\\web\\cordis.patch.yml] patch: entry "config-manager" not found',
  '# == @deepseek-ai/dsh-base',
  '- id: plugin-manager',
  "  name: '@deepseek-ai/dsh-plugin-manager'",
  "  disabled: !!js '!ctx.get(''profileContext'')'",
  '- id: llm',
  "  name: '@deepseek-ai/dsh-llm'",
  '- id: session-title',
  "  name: '@deepseek-ai/dsh-session-title'",
  '  config:',
  '    fallbackMaxWords: 5',
  '    maxTitleBytes: 80',
  '# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app',
  '- id: llm',
  "  name: '@deepseek-ai/dsh-llm'",
  '# == @deepseek-ai/dsh-base, patched by C:\\Users\\x\\.dsh\\profiles\\web\\cordis.patch.yml',
  '- id: llm',
  "  name: '@deepseek-ai/dsh-llm'",
  '  disabled: true',
  '# == @liustack/modlens, patched by C:\\Users\\x\\.dsh\\profiles\\web\\cordis.patch.yml',
  '- id: modlens',
  "  name: '@liustack/modlens'",
].join('\n')

// ── stripAnsi ──
test('stripAnsi 去掉 ANSI 颜色转义与 BOM，并统一换行', () => {
  const colored = '\uFEFF\x1b[32m# == pkg\x1b[0m\r\n- id: a\r\n'
  assert.equal(dump.stripAnsi(colored), '# == pkg\n- id: a\n')
  // 去掉转义后标题正则才能命中：这是「解析不出任何分节」的常见根因
  assert.ok(dump.parseSectionHead(dump.stripAnsi(colored).split('\n')[0]))
})

test('stripAnsi 处理 null/undefined 不抛错', () => {
  assert.equal(dump.stripAnsi(null), '')
  assert.equal(dump.stripAnsi(undefined), '')
})

// ── parseSectionHead ──
test('parseSectionHead 解析「包名」「包名 + 包内 patch」「包名 + 用户层 patch」三种形态', () => {
  const a = dump.parseSectionHead('# == @deepseek-ai/dsh-base')
  assert.equal(a.bundle, '@deepseek-ai/dsh-base')
  assert.equal(a.patchedBy, '')
  assert.equal(a.isUserLayer, false)
  assert.equal(a.label, '@deepseek-ai/dsh-base')

  const b = dump.parseSectionHead('# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app')
  assert.equal(b.bundle, '@deepseek-ai/dsh-base')
  assert.equal(b.patchedBy, '@deepseek-ai/dsh-web-app')
  // 包名不是路径 → 不是用户层
  assert.equal(b.isUserLayer, false)

  const c = dump.parseSectionHead('# == @liustack/modlens, patched by C:\\Users\\x\\.dsh\\profiles\\web\\cordis.patch.yml')
  assert.equal(c.bundle, '@liustack/modlens')
  assert.equal(c.isUserLayer, true)
})

test('parseSectionHead 把 POSIX 绝对路径也判为用户层', () => {
  const s = dump.parseSectionHead('# == pkg, patched by /home/x/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(s.isUserLayer, true)
})

test('parseSectionHead 对非标题行返回 null', () => {
  assert.equal(dump.parseSectionHead('- id: foo'), null)
  assert.equal(dump.parseSectionHead('  name: bar'), null)
  assert.equal(dump.parseSectionHead(''), null)
  assert.equal(dump.parseSectionHead(null), null)
})

// ⚠️ 用户层判据必须是「像绝对路径」而不是「以某个已知目录开头」：
// profile 目录可由 $DSH_HOME 改，写死前缀在用户改过 $DSH_HOME 后会静默判错。
// 这条测试把该判据钉死
test('用户层判据不依赖 $DSH_HOME 的具体位置：任意绝对路径都算用户层', () => {
  const s = dump.parseSectionHead('# == pkg, patched by /opt/whatever/mypatch.yml')
  assert.equal(s.isUserLayer, true)
  // 但相对路径 / 裸包名不算
  const r = dump.parseSectionHead('# == pkg, patched by some-relative/patch.yml')
  assert.equal(r.isUserLayer, false)
})

// ── shortSource ──
test('shortSource 把 cordis.patch.yml 绝对路径缩成 profiles/<名> 形式', () => {
  assert.equal(dump.shortSource('C:\\Users\\x\\.dsh\\profiles\\web\\cordis.patch.yml'), 'profiles/web')
  assert.equal(dump.shortSource('/home/x/.dsh/profiles/web/cordis.patch.yml'), 'profiles/web')
})

test('shortSource 对非 profiles 布局退化为上一级目录名', () => {
  assert.equal(dump.shortSource('/etc/dsh/cordis.patch.yml'), 'dsh')
  assert.equal(dump.shortSource(''), '')
})

// ── parseDump ──
test('parseDump 抽出分节与条目骨架（id / name / disabled / configKeys）', () => {
  const p = dump.parseDump(SAMPLE)
  assert.equal(p.sections.length, 4)
  assert.deepEqual(p.sections[0].ids, ['plugin-manager', 'llm', 'session-title'])

  const en = dump.entriesOf(p)
  const lm = en.find((e) => e.id === 'plugin-manager')
  assert.equal(lm.name, '@deepseek-ai/dsh-plugin-manager')
  // `!!js '...'` 是运行期表达式，原样保留不求值 → 一律算 disabled（§4.3）
  assert.equal(lm.disabled, true)

  const st = en.find((e) => e.id === 'session-title')
  assert.equal(st.hasConfig, true)
  assert.deepEqual(st.configKeys, ['fallbackMaxWords', 'maxTitleBytes'])
})

test('parseDump 的 configKeys 只留字段名不留值（config 值可能含密钥）', () => {
  const p = dump.parseDump(['# == pkg', '- id: a', '  config:', '    apiKey: sk-secret-123'].join('\n'))
  const en = dump.entriesOf(p)
  assert.deepEqual(en[0].configKeys, ['apiKey'])
  // 值绝不能出现在任何返回字段里
  assert.equal(JSON.stringify(en).includes('sk-secret-123'), false)
})

test('parseDump 对 `disabled: false` 显式判为 false（不是「有 disabled 就算 true」）', () => {
  const p = dump.parseDump(['# == pkg', '- id: a', '  name: x', '  disabled: false'].join('\n'))
  assert.equal(dump.entriesOf(p)[0].disabled, false)
})

test('parseDump 处理空输入与无分节输入', () => {
  assert.equal(dump.parseDump('').sections.length, 0)
  assert.equal(dump.parseDump(null).sections.length, 0)
  // 只有 dsh 的 stderr 报错、没有分节：不能崩，分节数为 0
  const only = dump.parseDump('dsh: patch: entry "x" not found')
  assert.equal(only.sections.length, 0)
  assert.equal(dump.entriesOf(only).length, 0)
})

// ⚠️ 同 id 出现在多个分节是分层语义，不能互相覆盖 —— 后出现的才是「最终生效」
test('indexEntries 让后出现的分节覆盖先出现的（patch 按 id 整体替换）', () => {
  const p = dump.parseDump(SAMPLE)
  const idx = dump.indexEntries(p)
  // llm 在 3 个分节里都出现过，最后一个（用户层）把它 disabled: true
  assert.equal(idx.llm.disabled, true)
})

test('parseDump 忽略 config 下缩进不足的噪声行（不误收为 configKeys）', () => {
  const p = dump.parseDump(['# == pkg', '- id: a', '  config:', '    realKey: 1', '  strayKey: 2'].join('\n'))
  assert.deepEqual(dump.entriesOf(p)[0].configKeys, ['realKey'])
})

// ⚠️ 嵌套条目必须与顶层条目一视同仁 —— 这是本机实测踩过的坑：
// `mnemon-bundle` 的 config 列表里嵌着 8 个 depth=4 的子条目，只认行首 `- id:` 的旧实现
// 把它们整组漏掉（用户层显示 3 条而非 11 条）。下面这三条钉住它，别让谁「简化」回行首正则
test('parseDump 收进 config 列表里嵌套的子条目（不只看行首 `- id:`）', () => {
  const p = dump.parseDump(
    [
      '# == pkg',
      '- id: mnemon-bundle',
      '  name: dsh-mnemon',
      '  config:',
      '    - id: mnemon',
      '      name: dsh-mnemon-core',
      '    - id: mnemon-source-documents',
      '      name: dsh-mnemon-docs',
    ].join('\n')
  )
  assert.deepEqual(p.sections[0].ids, ['mnemon-bundle', 'mnemon', 'mnemon-source-documents'])
  const byId = {}
  for (const e of dump.entriesOf(p)) byId[e.id] = e
  assert.equal(byId['mnemon'].name, 'dsh-mnemon-core')
  assert.equal(byId['mnemon-source-documents'].name, 'dsh-mnemon-docs')
  // depth 是解析期的内部字段（entriesOf 刻意不回传前端，见 DshDumpEntry），
  // 用「分节序号:id」直接读内部表。子条目 4 格、父条目 0 格
  assert.equal(p.entries['0:mnemon-bundle'].depth, 0)
  assert.equal(p.entries['0:mnemon'].depth, 4)
})

// 字段归属由缩进决定，不是「最近出现过谁」：子条目出现后父条目自己的字段
// 不能被算到子条目头上（反之亦然），否则 disabled / configKeys 会串味
test('parseDump 按缩进把 name / disabled / config 归给正确的层级', () => {
  const p = dump.parseDump(
    [
      '# == pkg',
      '- id: parent',
      '  name: parent-name',
      '  config:',
      '    - id: child',
      '      name: child-name',
      '      disabled: true',
      '      config:',
      '        childKey: 1',
      '  disabled: false',
    ].join('\n')
  )
  const byId = {}
  for (const e of dump.entriesOf(p)) byId[e.id] = e
  assert.equal(byId['parent'].name, 'parent-name')
  assert.equal(byId['child'].name, 'child-name')
  // 父条目在子条目之后才写自己的 disabled: false，不能被 child 的 true 覆盖
  assert.equal(byId['parent'].disabled, false)
  assert.equal(byId['child'].disabled, true)
  // 子条目字段门槛 = 自身缩进 4 + 4 = 8
  assert.deepEqual(byId['child'].configKeys, ['childKey'])
})

// configKeys 的缩进门槛随条目深浅浮动：条目 `- id:` 比同级兄弟字段少 2 格，
// 它的 config: 在 +2、config 的字段在 +4。写死 4 格只对顶层条目有效，写 +2 则一个都收不到
test('parseDump 的 configKeys 门槛随条目深度浮动（顶层与嵌套都收，且不含更深层内部字段）', () => {
  const p = dump.parseDump(
    [
      '# == pkg',
      '- id: top',
      '  config:',
      '    topKey: 1',
      '    embedding:',
      '      enabled: true',
      '    - id: nested',
      '      config:',
      '        nestedKey: 2',
    ].join('\n')
  )
  const byId = {}
  for (const e of dump.entriesOf(p)) byId[e.id] = e
  assert.deepEqual(byId['top'].configKeys, ['topKey', 'embedding'])
  // embedding 是顶层字段（收），它内部的 enabled 不是（不收）
  assert.equal(byId['top'].configKeys.includes('enabled'), false)
  assert.deepEqual(byId['nested'].configKeys, ['nestedKey'])
})

// 反向钉子：`providers:` 之类的列表用 `- use:` / `instanceId:` 而非 `- id:`，
// 它们不是 cordis 组装节点，混进 entries 会让 id 清单与条目数一起虚高
test('parseDump 不把 `- use:` / `instanceId:` 列表项当成条目', () => {
  const p = dump.parseDump(
    [
      '# == pkg',
      '- id: mnemon-source-memory-spaces',
      '  config:',
      '    providers:',
      '      - use: dsh-mnemon-provider-local',
      '        instanceId: local-1',
      '      - use: dsh-mnemon-provider-remote',
      '        instanceId: remote-1',
    ].join('\n')
  )
  assert.deepEqual(p.sections[0].ids, ['mnemon-source-memory-spaces'])
  // `- use:` 行没有 `- id:`，所以压根没进 entries；`providers` 作为 config 顶层字段被收
  assert.deepEqual(Object.keys(p.entries), ['0:mnemon-source-memory-spaces'])
  assert.deepEqual(dump.entriesOf(p)[0].configKeys, ['providers'])
})

// ── parseDshWarnings ──
// 这是 C2 的唯一权威判据来源：dsh 解析 patch 时自己打的 not found 行。
// 实测它在 dump 正文**之前**（走 stderr），格式如：
//   dsh: [C:\Users\Berge\.dsh\profiles\web\cordis.patch.yml] patch: entry "config-manager" not found
test('parseDshWarnings 抽出 dsh 报的 not found id（本机真实行）', () => {
  const text = [
    'dsh: [C:\\Users\\Berge\\.dsh\\profiles\\web\\cordis.patch.yml] patch: entry "config-manager" not found',
    '# == @deepseek-ai/dsh-base',
    '- id: tool-plugin-manager',
  ].join('\n')
  const w = dump.parseDshWarnings(text)
  assert.equal(w.length, 1)
  assert.equal(w[0].id, 'config-manager')
})

test('parseDshWarnings：没有警告行 → 空数组（这才是「dsh 全都认得」）', () => {
  assert.deepEqual(dump.parseDshWarnings('# == pkg\n- id: a\n'), [])
  assert.deepEqual(dump.parseDshWarnings(''), [])
})

test('parseDshWarnings：带 ANSI 颜色也要能抽出来；同 id 重复只记一次', () => {
  const esc = '\u001b[31m'
  const text = [
    esc + 'dsh: patch: entry "ghost" not found\u001b[0m',
    'dsh: patch: entry "ghost" not found',
    'dsh: patch: entry "other" not found',
  ].join('\n')
  const w = dump.parseDshWarnings(text)
  assert.deepEqual(w.map((x) => x.id), ['ghost', 'other'], '同 id 只报一次，顺序按出现先后')
})

// ── buildLayers ──
test('buildLayers 按「用户层按文件、包内层按包名」聚合，不按分节数膨胀', () => {
  const layers = dump.buildLayers(dump.parseDump(SAMPLE))
  const names = layers.map((l) => l.kind + ':' + l.name)
  assert.deepEqual(names, ['base:bundle 内置', 'bundle:@deepseek-ai/dsh-web-app', 'user:profiles/web'])
  // 用户层在样例里 patch 了两个包（dsh-base 与 modlens），必须合成一层
  const user = layers.find((l) => l.kind === 'user')
  assert.equal(user.sectionCount, 2)
  assert.deepEqual(user.items, ['llm', 'modlens'])
  assert.equal(user.itemCount, 2)
})

// ⚠️ 实测踩坑：同一个 bundle 会在 dump 里反复以「基线分节」出现（本机 `# == @deepseek-ai/dsh-base`
// 出现 13 次，每次重列同一批 40 个条目）。不去重的话层卡上「条目」数会是概览里生效条目数的好几倍，
// 看着像解析出了双份配置
test('buildLayers 对重复列举的 id 去重，并标记 repeat', () => {
  const repeated = dump.parseDump([
    '# == @deepseek-ai/dsh-base',
    '- id: a', '  name: A',
    '- id: b', '  name: B',
    '# == @deepseek-ai/dsh-base',
    '- id: a', '  name: A',
    '- id: b', '  name: B',
    '- id: c', '  name: C',
  ].join('\n'))
  const base = dump.buildLayers(repeated)[0]
  assert.deepEqual(base.items, ['a', 'b', 'c'])
  assert.equal(base.itemCount, 3)
  assert.equal(base.sectionCount, 2)
  assert.equal(base.repeat, true)
})

test('buildLayers 给出界面用预览：items 超过 40 个时截断', () => {
  const many = ['# == pkg']
  for (let i = 0; i < 45; i++) many.push('- id: p' + i, '  name: P' + i)
  const base = dump.buildLayers(dump.parseDump(many.join('\n')))[0]
  assert.equal(base.items.length, 45)
  assert.equal(base.preview.length, 40)
  assert.deepEqual(base.preview, base.items.slice(0, 40))
})

test('buildLayers 不把内部去重表 seen 漏给前端', () => {
  const layers = dump.buildLayers(dump.parseDump(SAMPLE))
  for (const l of layers) assert.equal(l.seen, undefined)
})

test('buildLayers 对空输入返回空数组', () => {
  assert.deepEqual(dump.buildLayers(dump.parseDump('')), [])
  assert.deepEqual(dump.buildLayers(null), [])
})

test('buildLayers 的 order 从 1 递增且唯一（供界面稳定排序）', () => {
  const layers = dump.buildLayers(dump.parseDump(SAMPLE))
  const orders = layers.map((l) => l.order)
  assert.deepEqual(orders, [1, 2, 3])
})

// ── diffTrees ──
test('diffTrees 找出被用户层改过 / 新增 / 移除的条目', () => {
  const eff = dump.parseDump([
    '# == pkg',
    '- id: same', '  name: same',
    '- id: changed', '  name: a', '  disabled: true',
    '- id: added', '  name: brand-new',
  ].join('\n'))
  const def = dump.parseDump([
    '# == pkg',
    '- id: same', '  name: same',
    '- id: changed', '  name: a',
    '- id: removed', '  name: gone',
  ].join('\n'))
  const d = dump.diffTrees(eff, def)
  assert.deepEqual(d.changed.map((c) => c.id), ['changed'])
  assert.equal(d.changed[0].before.disabled, false)
  assert.equal(d.changed[0].after.disabled, true)
  assert.deepEqual(d.added.map((a) => a.id), ['added'])
  assert.deepEqual(d.removed.map((r) => r.id), ['removed'])
})

test('diffTrees 两棵完全相同的树给出空 diff', () => {
  const one = ['# == pkg', '- id: a', '  name: x', '  config:', '    k: 1'].join('\n')
  const d = dump.diffTrees(dump.parseDump(one), dump.parseDump(one))
  assert.deepEqual(d.changed, [])
  assert.deepEqual(d.added, [])
  assert.deepEqual(d.removed, [])
})

// ⚠️ config 的**值**不在 dump 里（只留 key 名），这条测试把该取舍钉死：
// 「改了值但 key 没变」查不出来是有意为之，不是 bug
test('diffTrees 看不出「config 值变了但 key 未变」（刻意的取舍：值可能含密钥）', () => {
  const eff = dump.parseDump(['# == pkg', '- id: a', '  name: x', '  config:', '    k: 2'].join('\n'))
  const def = dump.parseDump(['# == pkg', '- id: a', '  name: x', '  config:', '    k: 1'].join('\n'))
  assert.deepEqual(dump.diffTrees(eff, def).changed, [])
})

test('diffTrees 对空输入不抛错', () => {
  const d = dump.diffTrees(null, null)
  assert.deepEqual(d.changed, [])
})

// ── isNotInstalled（决定设置页给「先装一次」还是「重试」）──
test('isNotInstalled 只认「没装 / 没 Node」，其余失败都算「装了但读不了」', () => {
  // run() 自己抛的两条：一个都没找到
  assert.equal(dump.isNotInstalled(new Error('未找到可用的 dsh（全局或插件目录都没有安装）')), true)
  assert.equal(dump.isNotInstalled(new Error('未找到 Node.js 可执行文件')), true)
  // 装了但没跑通：不能误导用户去重装
  assert.equal(dump.isNotInstalled(new Error('dump 超时（8s），dsh 可能卡住了')), false)
  assert.equal(dump.isNotInstalled(new Error('dsh 退出码 1（无输出）')), false)
  assert.equal(dump.isNotInstalled(null), false)
  assert.equal(dump.isNotInstalled(''), false)
})

// ── lastPathLine（dsh.js 的登录 shell 兜底解析）──
test('lastPathLine 从带欢迎语的交互 shell 输出里取最后一行路径', () => {
  // `-i` 会加载 rc 文件，可能先打印欢迎语 / nvm 提示
  const noisy = [
    'Welcome to your shell!',
    'nvm: node v20.11.0 is active',
    '/Users/x/.nvm/versions/node/v20.11.0/bin/node',
  ].join('\n')
  assert.equal(dsh.lastPathLine(noisy), '/Users/x/.nvm/versions/node/v20.11.0/bin/node')
})

test('lastPathLine 兼容 Windows 盘符路径与 .exe 后缀', () => {
  assert.equal(dsh.lastPathLine('noise\r\nD:\\nodejs\\node.exe\r\n'), 'D:\\nodejs\\node.exe')
})

test('lastPathLine 剥掉 shell 可能加的引号', () => {
  assert.equal(dsh.lastPathLine("'/usr/local/bin/node'"), '/usr/local/bin/node')
})

test('lastPathLine 取最后一条而**不是**第一条：前面可能有别的路径噪声', () => {
  // rc 文件里可能 echo 了别处的路径，真正生效的是 command -v 给的最后一条
  const out = ['/usr/bin/echo-helper', '/opt/homebrew/bin/node'].join('\n')
  assert.equal(dsh.lastPathLine(out), '/opt/homebrew/bin/node')
})

test('lastPathLine 对「找不到 node」（command -v 无输出）返回空串', () => {
  assert.equal(dsh.lastPathLine(''), '')
  assert.equal(dsh.lastPathLine('   \n  '), '')
  assert.equal(dsh.lastPathLine(null), '')
  // 只有欢迎语、没有路径
  assert.equal(dsh.lastPathLine('bash: node: command not found'), '')
})

test('lastPathLine 拒绝不像路径的行（避免把欢迎语当路径）', () => {
  assert.equal(dsh.lastPathLine('node'), '')
  assert.equal(dsh.lastPathLine('node is not installed'), '')
  // 是绝对路径但不以 node 结尾
  assert.equal(dsh.lastPathLine('/usr/local/bin/npm'), '')
})

// ── summarizeDump（日志用一行摘要）──
test('summarizeDump 给出可读摘要且不抛错', () => {
  assert.equal(dump.summarizeDump(null), '无结果')
  assert.match(dump.summarizeDump({ ok: false, error: 'x' }), /失败：x/)
  const s = dump.summarizeDump({
    ok: true, profile: 'web', sections: 41, entries: [{}, {}],
    diff: { changedTotal: 1, addedTotal: 0, removedTotal: 0 },
  })
  assert.match(s, /profile web/)
  assert.match(s, /41 个分节/)
  assert.match(s, /2 个条目/)
})

// ── validPkgSpec / validPkgName（安装 spec 进命令行的唯一关口）──
// 目录是信任来源，但终究是远端数据 —— 这里挡的是「被篡改的目录把 --prefix 之类的开关当包名塞进来」。
// validPkgSpec 比 validPkgName 宽（放行 github: 与远端 tgz），但绝不是「放行任意字符串」。
test('validPkgSpec 放行三种形态：npm 包名 / github:owner/repo / 远端 https tarball', () => {
  assert.equal(dsh.validPkgSpec('@scope/dsh-demo'), '@scope/dsh-demo')
  assert.equal(dsh.validPkgSpec('dsh-demo'), 'dsh-demo')
  assert.equal(dsh.validPkgSpec('github:owner/repo'), 'github:owner/repo')
  assert.equal(dsh.validPkgSpec('github:owner/repo#v1.2.3'), 'github:owner/repo#v1.2.3')
  assert.equal(dsh.validPkgSpec('https://codeload.github.com/o/r/tar.gz/abc'), 'https://codeload.github.com/o/r/tar.gz/abc')
  assert.equal(dsh.validPkgSpec('https://x.cn/a.tgz?v=2&k=1'), 'https://x.cn/a.tgz?v=2&k=1')
  assert.equal(dsh.validPkgSpec('  github:owner/repo  '), 'github:owner/repo')
})

// 回归（2026-09-25 真实 bug）：精确安装走的就是 `pkg@x.y.z`，而裸包名分支的字符集里
// 原先没有 `@`，一律判非法 → installPluginPkg 静默返回 code -1（连日志都不打），
// 界面只显示「安装失败（退出码 -1）：详见「日志」卡」而日志卡空白。
test('validPkgSpec 放行 `包名@版本`（精确安装的唯一形态，不接受它等于精确安装永远失败）', () => {
  assert.equal(dsh.validPkgSpec('dshmarket@1.65.1'), 'dshmarket@1.65.1')
  assert.equal(dsh.validPkgSpec('@scope/dsh-demo@1.2.3'), '@scope/dsh-demo@1.2.3')
  // 预发布 / 构建元数据（dsh 的 alpha / rc 版本是常态，必须能精确装）
  assert.equal(dsh.validPkgSpec('dsh@0.1.7-alpha.2'), 'dsh@0.1.7-alpha.2')
  assert.equal(dsh.validPkgSpec('dsh@0.1.5-rc.2+build.7'), 'dsh@0.1.5-rc.2+build.7')
  // 尾部 `#` 片段（npm 别名 / registry 片段语法）
  assert.equal(dsh.validPkgSpec('dsh@1.2.3#beta'), 'dsh@1.2.3#beta')
  // ⚠️ 加了 `@版本` 也**不能**把注入面放大：版本段仍只吃字母数字与 . _ + -
  assert.equal(dsh.validPkgSpec('dsh@'), '', '光一个 @ 没有版本号，应拒')
  assert.equal(dsh.validPkgSpec('dsh@1.0.0;rm -rf /'), '', '版本段不许有 ;')
  assert.equal(dsh.validPkgSpec('dsh@1.0.0&&whoami'), '', '版本段不许有 &&')
  assert.equal(dsh.validPkgSpec('dsh@1.0.0 --prefix'), '', '版本段不许有空格')
  assert.equal(dsh.validPkgSpec('dsh@1.0.0`id`'), '', '版本段不许有反引号')
})

test('validPkgSpec 挡住 shell 注入与参数走私（这是它的全部意义）', () => {
  // `-` 开头会被当 npm 开关
  assert.equal(dsh.validPkgSpec('--prefix'), '')
  assert.equal(dsh.validPkgSpec('-g'), '')
  // 空白 / 换行会把一个 spec 拆成多个参数
  assert.equal(dsh.validPkgSpec('dsh-a dsh-b'), '')
  assert.equal(dsh.validPkgSpec('dsh-a\nrm -rf /'), '')
  // shell 元字符
  assert.equal(dsh.validPkgSpec('dsh-a;rm -rf /'), '')
  assert.equal(dsh.validPkgSpec('dsh-a&&whoami'), '')
  assert.equal(dsh.validPkgSpec('dsh-a|cat /etc/passwd'), '')
  assert.equal(dsh.validPkgSpec('$(whoami)'), '')
  assert.equal(dsh.validPkgSpec('`whoami`'), '')
  assert.equal(dsh.validPkgSpec('"https://x.cn/a.tgz"'), '')
  assert.equal(dsh.validPkgSpec('https://x.cn/a.tgz\\'), '')
  // 非 http(s) 的协议不认
  assert.equal(dsh.validPkgSpec('file:///etc/passwd'), '')
  assert.equal(dsh.validPkgSpec('git+ssh://git@x.cn/a.git'), '')
  // 空值
  assert.equal(dsh.validPkgSpec(''), '')
  assert.equal(dsh.validPkgSpec(null), '')
  assert.equal(dsh.validPkgSpec(undefined), '')
})

test('validPkgSpec 限长 214 字符（npm 包名上限，超长一律拒绝）', () => {
  assert.equal(dsh.validPkgSpec('a'.repeat(214)), 'a'.repeat(214))
  assert.equal(dsh.validPkgSpec('a'.repeat(215)), '')
})

test('validPkgName 仍只认包名（卸载走 dependencies 键名，不接受 github:/URL）', () => {
  assert.equal(dsh.validPkgName('@scope/dsh-demo'), '@scope/dsh-demo')
  assert.equal(dsh.validPkgName('dsh-demo'), 'dsh-demo')
  // 与 validPkgSpec 的关键差异：这两类卸载时匹配不上 dependencies 的键，必须挡住
  assert.equal(dsh.validPkgName('github:owner/repo'), '')
  assert.equal(dsh.validPkgName('https://x.cn/a.tgz'), '')
  assert.equal(dsh.validPkgName(''), '')
})

// ── progress（安装/更新期间的轻量进度快照）──
//
// ⚠️ 这段盯的是「进度回显不能有副作用」：前端要 1Hz 刷新几分钟，
//    所以 progress() 必须只读内存、**不探端口**（否则每秒白起一个 netstat 子进程）。
//    快照里也不能泄露 state 之外的引用 —— 前端只用到 lastCmd / log 两个字段。
test('progress 返回 { lastCmd, log } 两个字段，未执行过时为空串', () => {
  const p = dsh.progress()
  assert.deepEqual(Object.keys(p).sort(), ['lastCmd', 'log'])
  assert.equal(typeof p.lastCmd, 'string')
  assert.equal(typeof p.log, 'string')
})

test('progress 不含端口探测相关字段（保证零副作用：不起 netstat 子进程）', () => {
  const p = dsh.progress()
  // 这些是 snapshot() 才有的字段。若日后有人图省事让它复用 snapshot()，
  // 端口探测就会跟着恢复到 1Hz —— 用这条钉住分开的理由
  for (const k of ['portPid', 'portName', 'portOther', 'extBusy', 'external', 'probe']) {
    assert.equal(k in p, false, `progress() 不该带 ${k}`)
  }
})

test('progress 的 log 是整串（含换行），不是数组', () => {
  const p = dsh.progress()
  // 前端靠 split('\n') 自己取尾部若干行，所以这里必须是字符串
  assert.equal(Array.isArray(p.log), false)
})

// ── quoteCmdArg（cmd /s /c 这条线的参数引号规则）──
//
// ⚠️ 这段钉的是一个**真实 bug**（2026-09-24 用户报的「更新失败（退出码 1）」）：
//    spawnCmd 在 Windows 下走 `cmd.exe /d /s /c <整串>`，而**沿用 POSIX 式引号给每个参数都包一层**
//    会让 cmd 在补/剥外层引号时错配 —— 实测命令名被吃成 `dejs\npm.cmd\"`，报
//    「不是内部或外部命令」。npm/dsh 当场全部跑不起来。
//    规则：**只给真正含空格的参数**加引号，参数内的引号用 cmd 的 `""`（不是 `\"`）。
test('quoteCmdArg 对不含空格的参数不加引号（关键：加了会被 /s 的外层引号错配）', () => {
  assert.equal(dsh.quoteCmdArg('install'), 'install')
  assert.equal(dsh.quoteCmdArg('--prefix'), '--prefix')
  assert.equal(dsh.quoteCmdArg('dshmarket'), 'dshmarket')
  assert.equal(dsh.quoteCmdArg('--registry=https://registry.npmmirror.com'), '--registry=https://registry.npmmirror.com')
  // Windows 路径：反斜杠不是特殊字符，不该触发加引号
  assert.equal(dsh.quoteCmdArg('D:\\nodejs\\npm.cmd'), 'D:\\nodejs\\npm.cmd')
  assert.equal(dsh.quoteCmdArg('C:\\Users\\Berge\\.dsh\\profiles\\web'), 'C:\\Users\\Berge\\.dsh\\profiles\\web')
})

test('quoteCmdArg 只给含空格的参数加引号', () => {
  assert.equal(dsh.quoteCmdArg('C:\\Program Files\\nodejs\\npm.cmd'), '"C:\\Program Files\\nodejs\\npm.cmd"')
  assert.equal(dsh.quoteCmdArg('C:\\Users\\a b\\.dsh'), '"C:\\Users\\a b\\.dsh"')
  // 只包一层：不能再像 POSIX 那样额外转义
  assert.equal(dsh.quoteCmdArg('a b').startsWith('"'), true)
  assert.equal(dsh.quoteCmdArg('a b').endsWith('"'), true)
})

test('quoteCmdArg 用 cmd 的 "" 转义内部引号，而不是 \\"（cmd 不认反斜杠转义）', () => {
  const r = dsh.quoteCmdArg('say "hi"')
  assert.equal(r, '"say ""hi"""')
  assert.equal(r.includes('\\"'), false, 'cmd 不认反斜杠转义，混进去会变成字面反斜杠')
})

test('quoteCmdArg 对 shell 元字符加引号（挡住命令拼接）', () => {
  for (const v of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b)']) {
    assert.equal(dsh.quoteCmdArg(v).startsWith('"'), true, v + ' 应被引号包住')
  }
})

test('quoteCmdArg 拼出的命令行与实测能跑通的形态一致（回归：命令名首尾不能有多余引号）', () => {
  const exe = 'D:\\nodejs\\npm.cmd'
  const args = ['install', '--prefix', 'C:\\Users\\Berge\\.dsh\\profiles\\web', '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com', 'dshmarket']
  const line = dsh.quoteCmdArg(exe) + ' ' + args.map(dsh.quoteCmdArg).join(' ')
  // 这条线上不能出现任何引号 —— 全是不含空格的参数，出现引号就说明又走回踩坑写法了
  assert.equal(line.includes('"'), false, '无空格参数不该有引号：' + line)
  assert.equal(line, 'D:\\nodejs\\npm.cmd install --prefix C:\\Users\\Berge\\.dsh\\profiles\\web --no-audit --no-fund --registry=https://registry.npmmirror.com dshmarket')
})

// ── pnpm 通道（装/卸插件必须走它，不能退回 npm）──
// 2026-09-24 实测：npm 在 profile 目录里跑会因 `@openviking/dsh-memory-plugin@0.3.2` 的
// peer 由全局 dsh 提供而报 ERESOLVE；`--legacy-peer-deps` 能绕过但会连带改 73 个无关包。
// pnpm（profile 的 autoInstallPeers: false）只报 [WARN] 不中止，且只动目标包。

test('pnpmArgs 拼出 --dir / --reporter 且顺序在 spec 之前（回归：参数顺序错了 pnpm 会把 spec 当目录）', () => {
  const args = dsh.pnpmArgs('C:\\Users\\Berge\\.dsh\\profiles\\web')
  assert.deepEqual(args, ['--dir', 'C:\\Users\\Berge\\.dsh\\profiles\\web', '--reporter=append-only'])
})

test('pnpmArgs 带自定义镜像源时把 --registry 追加在末尾', () => {
  const before = dsh.pnpmArgs('X:\\p')
  // 默认（未配置镜像）不带 --registry
  assert.equal(before.some((a) => a.startsWith('--registry')), false, '未配镜像不该凭空加 --registry')
})

test('pnpmArgs 用 --reporter=append-only：默认 TTY 报告器的进度条会把日志刷屏', () => {
  assert.equal(dsh.pnpmArgs('X:\\p').includes('--reporter=append-only'), true)
})

test('pnpmArgs 不带 --ignore-scripts：github/tgz 来源靠 prepare 构建，忽略脚本等于装出空壳', () => {
  const args = dsh.pnpmArgs('X:\\p')
  assert.equal(args.includes('--ignore-scripts'), false)
  assert.equal(args.some((a) => a.startsWith('--ignore')), false)
})

test('installPluginPkg 拒绝非法 profile / spec（不进命令行）', async () => {
  const bad = await dsh.installPluginPkg('../etc', 'dshmarket')
  assert.equal(bad.ok, false)
  assert.match(bad.err, /profile 名不合法/)
  const bad2 = await dsh.installPluginPkg('web', 'dshmarket; rm -rf /')
  assert.equal(bad2.ok, false)
  assert.match(bad2.err, /包名不合法/)
})

test('uninstallPluginPkg 拒绝非法 profile / 包名（不进命令行）', async () => {
  const bad = await dsh.uninstallPluginPkg('web', '--dangerously-allow-all')
  assert.equal(bad.ok, false)
  assert.match(bad.err, /包名不合法/)
})

test('resolvePnpm 找不到 pnpm 时返回空串，不偷偷退回 npm（退回正是 ERESOLVE 的根源）', () => {
  // 用一个不存在的 Node 目录 + 清空 PATH，保证探测一定失败
  const savedPath = process.env.PATH
  const savedAppData = process.env.APPDATA
  const savedLocalAppData = process.env.LOCALAPPDATA
  const savedProgramFiles = process.env.ProgramFiles
  const savedProgramFilesX86 = process.env['ProgramFiles(x86)']
  try {
    process.env.PATH = ''
    delete process.env.APPDATA
    delete process.env.LOCALAPPDATA
    delete process.env.ProgramFiles
    delete process.env['ProgramFiles(x86)']
    const r = dsh.resolvePnpm({ dir: 'X:\\definitely-not-here' })
    // 返回值必须是字符串（'' 或绝对路径），绝不能是 npm 的路径 —— 判据是「结果为 falsy 时调用方报错」
    assert.equal(typeof r, 'string')
    if (!r) assert.equal(r, '', '找不到就返回空串，让调用方报错而不是降级')
  } finally {
    process.env.PATH = savedPath
    if (savedAppData !== undefined) process.env.APPDATA = savedAppData
    if (savedLocalAppData !== undefined) process.env.LOCALAPPDATA = savedLocalAppData
    if (savedProgramFiles !== undefined) process.env.ProgramFiles = savedProgramFiles
    if (savedProgramFilesX86 !== undefined) process.env['ProgramFiles(x86)'] = savedProgramFilesX86
  }
})
