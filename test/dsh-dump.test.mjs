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
