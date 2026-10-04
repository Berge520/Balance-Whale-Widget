/*
 * 卡片搜索「全文索引」生成器与新鲜度闸门的守卫测试（node --test，零依赖）。
 *
 * 测两层：
 *   1. 生成器自身正确性 —— 用临时样本模板验证：能提取、提取不到会红、--check 能发现过期。
 *      经 GSI_APP / GSI_VIEWS / GSI_OUT 三个环境变量注入（真实构建不设，走默认路径）。
 *   2. 真实仓库的产物新鲜度 —— search-index.gen.ts 必须与当前模板一致（等价于 --check），
 *      且 App.vue 确实 import 了 CARD_TEXT（断链 = 第三档全文匹配静默失效）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../scripts/gen-search-index.mjs', import.meta.url))
const root = path.dirname(path.dirname(scriptPath))

const run = (env) => execFileSync(process.execPath, [scriptPath], {
  env: { ...process.env, GSI_MIN_KEYS: '2', ...env },
  encoding: 'utf8',
})

const runFail = (env) => {
  try {
    run(env)
  } catch (err) {
    return err
  }
  return null
}

// 造一份最小样本模板：两张卡（h2 形态 + fold-title 画廊形态），一张带 label 字段
function writeSample(dir) {
  const app = [
    '<template>',
    '  <!-- 注释里的 data-search="ghost" 不该被算数 -->',
    '  <section class="card" data-search="alpha">',
    '    <h2>Alpha 标题</h2>',
    '    <span class="label">音量（0–100%）</span>',
    '  </section>',
    '  <section class="card" data-search="beta">',
    '    <button class="fold-title" type="button"><span class="fold-caret">▾</span> 画廊卡头</button>',
    '    <span class="label">SMTP 服务器端口</span>',
    '  </section>',
    '</template>',
    '',
    'const SEARCH_INDEX: Record<string, SearchItem> = {',
    '  alpha: { label: \'Alpha 标题\', tab: \'look\', keys: \'x\' },',
    '  beta: { label: \'Beta 标题\', tab: \'look\', keys: \'y\' },',
    '}',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'App.vue'), app, 'utf8')
}

test('生成器：能从模板提取卡片文本并生成归一化索引', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsi-'))
  writeSample(dir)
  const out = path.join(dir, 'search-index.gen.ts')
  run({ GSI_APP: path.join(dir, 'App.vue'), GSI_OUT: out })
  const gen = fs.readFileSync(out, 'utf8')
  // h2 + label 主干被抽出、括号说明被剥掉、归一化（小写无空白）
  assert.match(gen, /alpha: "alpha标题音量"/, 'alpha 卡应含 h2 与 label 主干（括号说明剥掉）')
  // fold-title 卡头 + label 字段名（插值/箭头剥掉）。SEARCH_INDEX 的 label 不并入产物——
  // 运行时第三档匹配本就把 label 并进命中并集（x = t || s || hits(w, text)），并进去是纯冗余
  assert.match(gen, /beta: "画廊卡头smtp服务器端口"/, 'beta 卡应含 fold-title 卡头与 label 字段名')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('生成器：SEARCH_INDEX 与模板锚点不一致会红', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsi-'))
  writeSample(dir)
  // 模板加一张 SEARCH_INDEX 没登记的卡
  const appPath = path.join(dir, 'App.vue')
  fs.appendFileSync(appPath, '<section class="card" data-search="ghost"><h2>幽灵</h2></section>\n')
  const err = runFail({ GSI_APP: appPath, GSI_OUT: path.join(dir, 'out.ts') })
  assert.ok(err, '漏登记应导致非零退出')
  assert.match(String(err.stderr), /SEARCH_INDEX 未登记/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('生成器：--check 检出过期产物（模板改了没重新生成）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsi-'))
  writeSample(dir)
  const out = path.join(dir, 'search-index.gen.ts')
  const env = { GSI_APP: path.join(dir, 'App.vue'), GSI_OUT: out }
  run(env)
  run({ ...env, GSI_CHECK: '1' }) // 新鲜产物 → 通过
  // 改模板（登记了 SEARCH_INDEX 的键）但不重新生成 → --check 必须红
  const appPath = path.join(dir, 'App.vue')
  const app = fs.readFileSync(appPath, 'utf8')
  fs.writeFileSync(appPath, app
    .replace('<h2>Alpha 标题</h2>', '<h2>Alpha 标题新词</h2>')
    .replace("  alpha: { label: 'Alpha 标题'", "  alpha: { label: 'Alpha 标题新词'"), 'utf8')
  const err = runFail({ ...env, GSI_CHECK: '1' })
  assert.ok(err, '过期产物应导致非零退出')
  assert.match(String(err.stderr), /已过期/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('生成器：解析规则失效（模板里没有卡片锚点）会红而不是静默生成空索引', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsi-'))
  fs.writeFileSync(path.join(dir, 'App.vue'), '<template><p>没有卡片</p></template>\n', 'utf8')
  const err = runFail({ GSI_APP: path.join(dir, 'App.vue'), GSI_OUT: path.join(dir, 'out.ts') })
  assert.ok(err, '空模板应导致非零退出')
  assert.match(String(err.stderr), /没匹配到任何/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('真实仓库：search-index.gen.ts 与当前模板一致（等价 --check）', () => {
  const genPath = path.join(root, 'src/search-index.gen.ts')
  assert.ok(fs.existsSync(genPath), 'src/search-index.gen.ts 不存在：先跑 node scripts/gen-search-index.mjs 生成')
  const err = runFail({ GSI_CHECK: '1' })
  assert.ok(!err, `全文索引已过期（模板改了但没重新生成）：${err ? err.message : ''}`)
})

test('真实仓库：App.vue 已接入 CARD_TEXT（断链 = 全文匹配静默失效）', () => {
  const app = fs.readFileSync(path.join(root, 'src/App.vue'), 'utf8')
  assert.match(app, /import \{ CARD_TEXT \} from '\.\/search-index\.gen'/, 'App.vue 没有 import CARD_TEXT')
  assert.match(app, /CARD_TEXT\[k\]/, 'searchHits 没有使用 CARD_TEXT，全文第三档没接上')
})
