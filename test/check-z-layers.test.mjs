/*
 * check-z-layers.mjs 的**自检**（node --test，零依赖）。
 *
 * 门禁有两种坏法 —— ① 误判（把合规写法判成违规，构建被无故卡死）；
 * ② 漏判（正则/状态机坏了，看着在跑其实什么都查不出）。
 * 下面每个用例钉住一条真实形态：变量引用 / 裸数字 / 未定义变量 / 层段同值 / 注释干扰。
 *
 * 样本经注入环境变量喂进脚本（CZL_ROOT / CZL_FILES / CZL_ALLOW），
 * 真实构建不设这些变量，走脚本内置默认值。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-z-layers.mjs')

// 最小合规样本：层段表 + 一处变量引用
const TABLE = `:root {
  --z-whale-root: 9999;
  --z-whale-menu: 10000;
  --z-whale-actions: 10001;
}
.a { z-index: var(--z-whale-root); }
`

function makeRepo(cssFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-czl-selftest-'))
  for (const [rel, content] of Object.entries(cssFiles)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return { root, files: Object.keys(cssFiles).join(',') }
}

function runScript(repo, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...(extra.argv || [])], {
    env: {
      ...process.env,
      CZL_ROOT: repo.root,
      CZL_FILES: repo.files,
      CZL_ALLOW: extra.allow ? JSON.stringify(extra.allow) : '[]',
    },
    encoding: 'utf8',
  })
}

test('基线：层段表 + 变量引用必须全绿', () => {
  const repo = makeRepo({ 'public/floating.css': TABLE })
  const r = runScript(repo)
  assert.equal(r.status, 0, `应通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /全部 z-index 合规/)
})

test('裸数字必报：未登记的 z-index 数字被点名', () => {
  const repo = makeRepo({
    'public/floating.css': TABLE + '.b { z-index: 12345; }\n',
  })
  const r = runScript(repo)
  assert.match(r.stdout, /z-index: 12345/)
})

test('ALLOW 豁免：登记的裸数字不再报（元素内层走此路）', () => {
  const repo = makeRepo({
    'public/floating.css': TABLE + '.b { z-index: 2; }\n',
  })
  const r = runScript(repo, { allow: [{ file: 'public/floating.css', value: '2', why: '元素内层' }] })
  assert.equal(r.status, 0, `白名单应豁免：\n${r.stdout}`)
})

test('未定义的层段变量必报：引用了层段表里没有的 --z-whale-*', () => {
  const repo = makeRepo({
    'public/floating.css': TABLE + '.b { z-index: var(--z-whale-ghost); }\n',
  })
  const r = runScript(repo)
  assert.match(r.stdout, /未定义的层段变量 --z-whale-ghost/)
})

test('非层段变量必报：用了 var(--other)', () => {
  const repo = makeRepo({
    'public/floating.css': TABLE + '.b { z-index: var(--not-a-layer); }\n',
  })
  const r = runScript(repo)
  assert.match(r.stdout, /非层段变量/)
})

test('层段同值必报：两个层段取同一个数字', () => {
  const repo = makeRepo({
    'public/floating.css': `:root {
  --z-whale-root: 9999;
  --z-whale-menu: 9999;
  --z-whale-actions: 10001;
}
`,
  })
  const r = runScript(repo)
  assert.match(r.stdout, /同值/)
})

test('跨文件扫描：别的 CSS 里冒出的裸数字同样被点名', () => {
  const repo = makeRepo({
    'public/floating.css': TABLE,
    'public/floating-bubble.css': '.b { z-index: 7; }\n',
  })
  const r = runScript(repo)
  assert.match(r.stdout, /floating-bubble\.css.*z-index: 7/)
})

test('注释里的 z-index 不算数（不被误报）', () => {
  const repo = makeRepo({
    'public/floating.css': TABLE + '/* 历史：曾用 z-index: 8888 */\n',
  })
  const r = runScript(repo)
  assert.equal(r.status, 0, `注释应被忽略：\n${r.stdout}`)
})

test('--fail 模式下有违规则退出码非 0（默认模式恒 0）', () => {
  const repo = makeRepo({ 'public/floating.css': TABLE + '.b { z-index: 12345; }\n' })
  const warn = runScript(repo)
  assert.equal(warn.status, 0, '默认体检模式不该非 0')
  const fail = runScript(repo, { argv: ['--fail'] })
  assert.notEqual(fail.status, 0, '--fail 下应非 0')
})

test('真实仓库（不注入）默认体检模式恒绿：不阻断构建', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `体检模式应恒绿：\n${r.stdout}${r.stderr}`)
})

test('真实仓库 --fail 模式必须绿：现有代码已全部合规', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--fail'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `现有代码应合规：\n${r.stdout}${r.stderr}`)
})
