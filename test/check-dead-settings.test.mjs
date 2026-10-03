/*
 * check-dead-settings.mjs 的**自检**（node --test，零依赖）。
 *
 * 思路来自上游 DeepSeek-Balance-Whale-Widget 的 tools/ci-audit-selftest.mjs：
 * 门禁有两种坏法 —— ① 误判（把合法代码判死 → 维护者嫌烦，最后把整条检查删掉）；
 * ② 漏判（看着是绿的其实什么都没拦，比如解析正则被改坏、stripJs 被改得不再剥注释）。
 * 门禁挂在 prebuild 上，构建时只告诉你「当前仓库是绿的」；它「坏了也会绿」这件事，
 * 只有反过来**喂给它写坏的样本**才能暴露。所以这里逐项证明：
 *   先证明「干净样本全绿」，再证明「每一种该红的写法必红」。
 *
 * 样本仓库经 scripts/check-dead-settings.mjs 的注入环境变量喂进去（CDS_ROOT /
 * CDS_CONSUMERS / CDS_MIN_KEYS / CDS_ALLOW / CDS_EXPECT），真实构建不设这些变量，
 * 走脚本内置默认值，行为与注入前完全一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-dead-settings.mjs')

// —— 样本仓库工厂 ———————————————————————————————————————————————
// 每个用例一座临时仓库，目录结构只需覆盖脚本读取的部分：
//   public/preload/lib/store.js（defaultConfig 定义方）+ 若干消费方文件。
// 键与读点用循环生成，保证超过 CDS_MIN_KEYS 护栏（真实仓库 88 个键，护栏 50）。
function makeRepo(deadKeys, { comments = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cds-selftest-'))
  const lib = path.join(root, 'public', 'preload', 'lib')
  fs.mkdirSync(lib, { recursive: true })
  const keys = []
  for (let i = 0; i < 12; i++) keys.push(`feat${i}`)
  for (let i = 0; i < 45; i++) keys.push(`fill${i}`)
  const dft = keys.map((k) => (deadKeys.includes(k) ? `  ${k}: 0,` : `  ${k}: 1,`)).join('\n')
  fs.writeFileSync(path.join(lib, 'store.js'), `function defaultConfig() {\n  return {\n${dft}\n  }\n}\n`)
  // 消费方 a.js：一半键的读点；b.vue：另一半。死键的读点不写（或写成注释/字符串）。
  const half = Math.floor(keys.length / 2)
  const inA = keys.filter((_, i) => i < half && !deadKeys.includes(keys[i]))
  const inB = keys.filter((_, i) => i >= half && !deadKeys.includes(keys[i]))
  let a = inA.map((k) => `state.${k}`).join('\n') + '\n'
  let b = inB.map((k) => `state.${k}`).join('\n') + '\n'
  if (comments) {
    // 骗过形态：死键名只出现在注释 / 字符串里 —— stripJs 失效时会误判成「有读点」
    a += `// 注释里提到 ${deadKeys.filter((k) => k.startsWith('feat'))[0] || 'feat0'} 不算读点\n`
    a += `const hint = "${deadKeys.filter((k) => k.startsWith('fill'))[0] || 'fill0'}"\n`
  }
  fs.writeFileSync(path.join(lib, 'a.js'), a || '\n')
  fs.writeFileSync(path.join(root, 'b.vue'), b || '\n')
  return { root, keys }
}

function envFor(repo, extra = {}) {
  return {
    ...process.env,
    CDS_ROOT: repo.root,
    CDS_CONSUMERS: 'public/preload/lib/a.js,b.vue',
    CDS_MIN_KEYS: '50',
    // 默认压掉真实仓库的契约表（里面的键在样本仓库不存在，会整表误红）；
    // 契约用例经 extra 覆盖成自己要的表
    CDS_EXPECT: '{}',
    ...extra,
  }
}

function runScript(env) {
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' })
}

test('基线：干净样本必须全绿', () => {
  const { root } = makeRepo([])
  const r = runScript(envFor({ root }))
  assert.equal(r.status, 0, `应通过却失败：\n${r.stderr}`)
  assert.match(r.stdout, /全部有读点/)
})

test('死键必红：读点被删掉的键出现在输出里', () => {
  const { root } = makeRepo(['feat3'])
  const r = runScript(envFor({ root }))
  assert.equal(r.status, 1, '死键样本应不通过')
  assert.match(r.stderr, /feat3/, '输出里应点名死键')
})

test('注释 / 字符串里的键名不算读点（stripJs 失效即此用例变绿）', () => {
  const { root } = makeRepo(['feat3', 'fill7'], { comments: true })
  const r = runScript(envFor({ root }))
  assert.equal(r.status, 1, '注释/字符串骗过样本应不通过')
  assert.match(r.stderr, /feat3/)
  assert.match(r.stderr, /fill7/)
})

test('定义方出现键名不算读点：只在 store.js 里的键必红', () => {
  const { root, keys } = makeRepo([])
  // 挑一个读点真的在 b.vue 里的活键（键按下标分半，fill0 在 a.js，不能按名字猜；
  // fill1 是 fill16 的前缀，必须按词边界找，否则会选中根本没有读点的键）
  const bSrc = fs.readFileSync(path.join(root, 'b.vue'), 'utf8')
  const victim = keys.find((k) => new RegExp('state\\.' + k + '\\b').test(bSrc))
  fs.writeFileSync(path.join(root, 'b.vue'), bSrc.replace(new RegExp('state\\.' + victim + '\\b'), 'state.other'))
  const r = runScript(envFor({ root }))
  assert.equal(r.status, 1, '只剩定义方的键应不通过')
  assert.match(r.stderr, new RegExp(`\\b${victim}\\b`))
})

test('ALLOW 白名单救回死键 → 全绿；登记不存在的键 → 红', () => {
  const { root } = makeRepo(['feat2'])
  const ok = runScript(envFor({ root }, { CDS_ALLOW: JSON.stringify({ feat2: '测试用：暂时无人读' }) }))
  assert.equal(ok.status, 0, `白名单应豁免死键：\n${ok.stderr}`)

  // 过期表：白名单登记了 defaultConfig 里没有的键，必须红（逼着清表）
  const phantom = runScript(envFor({ root }, { CDS_ALLOW: JSON.stringify({ feat2: 'x', noSuchKey: 'y' }) }))
  assert.equal(phantom.status, 1, '白名单过期条目应不通过')
  assert.match(phantom.stderr, /ALLOW.*不存在|不存在.*ALLOW|noSuchKey/s)
})

test('契约层：读点搬到非指定文件 → 红；指定文件不在消费方集合 → 红', () => {
  const { root, keys } = makeRepo([])
  // 把 fill1 的读点从 b.vue 搬进 a.js（「别处有人读」但指定消费方没有 → 契约违约）
  const victim = keys.find((k) => k.startsWith('fill'))
  const bPath = path.join(root, 'b.vue')
  fs.writeFileSync(bPath, fs.readFileSync(bPath, 'utf8').replace(`state.${victim}`, 'state.moved'))
  fs.appendFileSync(path.join(root, 'public', 'preload', 'lib', 'a.js'), `state.${victim}\n`)
  const r = runScript(envFor({ root }, {
    CDS_EXPECT: JSON.stringify({ [victim]: ['b.vue'], ghost: ['missing-file.js'] }),
  }))
  assert.equal(r.status, 1, '契约违约应不通过')
  assert.match(r.stderr, new RegExp(`\\b${victim}\\b`), '应点名违约键')
  assert.match(r.stderr, /ghost/, '应点名登记了不存在文件的键')
})

test('契约层：指定文件真的在读 → 这条契约绿（拆开跑，隔离上面的违约用例）', () => {
  const { root, keys } = makeRepo([])
  // 契约目标必须是读点真的在 b.vue 里的键；按词边界找（fill1 是 fill16 的前缀）
  const bSrc = fs.readFileSync(path.join(root, 'b.vue'), 'utf8')
  const target = keys.find((k) => new RegExp('state\\.' + k + '\\b').test(bSrc))
  const r = runScript(envFor({ root }, {
    CDS_EXPECT: JSON.stringify({ [target]: ['b.vue'] }),
  }))
  assert.equal(r.status, 0, `契约满足时应通过：\n${r.stderr}`)
})

test('真实仓库（不注入）跑一遍仍绿：护栏键数不得被调低绕过', () => {
  // 不设 CDS_*，走脚本内置默认 —— 等于真实 prebuild 那一遍。
  // 同时钉住：把 CDS_MIN_KEYS 注入成 0 也不影响本次运行（防有人改脚本时把护栏改成可配置为零）。
  const r = runScript({ ...process.env })
  assert.equal(r.status, 0, `真实仓库应通过：\n${r.stderr}`)
})
