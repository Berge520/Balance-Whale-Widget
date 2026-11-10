/*
 * scripts/check-public-tracked.mjs 的自检（node --test，零依赖）。
 *
 * 用 CPT_STATUS 注入假的 git status 输出，不需要真 git 仓库、也不碰工作区。
 * 钉住的六件事：
 *   - 干净输出（只有 ` M`）必须放行；
 *   - `??`（未跟踪）必须拦；
 *   - `!!`（被 .gitignore 忽略）也必须拦 —— 这正是历史事故的形态（api.js.bak 被忽略，
 *     默认 git status 看不到，却被原样拷进 dist/ 打进发行包）；
 *   - resources/ 与 public/ 同一口径，但 vite 构建期不拷贝的条目（skins-src / manifest.json）放行；
 *   - 跳过目录按完整路径前缀匹配（顶层与嵌套同级生效），与 vite 的拷贝口径严格同源；
 *   - 拿不到 git status（非 git 环境）必须 fail-open 放行，不能把「下载的源码包」卡死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/check-public-tracked.mjs', import.meta.url))

const run = (env) =>
  spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

test('只有已跟踪文件的改动时放行', () => {
  const r = run({ CPT_STATUS: ' M public/floating-page.js\n M public/preload/lib/ipc.js\n' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /没有会被打进包的未入库文件/)
})

test('未跟踪文件（??）被拦下', () => {
  const r = run({ CPT_STATUS: '?? public/preload/lib/focus.js\n' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /focus\.js/)
  assert.match(r.stderr, /未跟踪/)
})

test('被 .gitignore 忽略的文件（!!）也被拦下', () => {
  // 历史事故形态：public/preload/lib/api.js.bak 命中 .gitignore 的 *.bak，
  // 默认 git status 里根本不出现，却会被 copyPublicExceptSkip 原样拷进 dist/
  const r = run({ CPT_STATUS: '!! public/preload/lib/api.js.bak\n' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /api\.js\.bak/)
  assert.match(r.stderr, /\.gitignore/)
})

test('resources/ 下无子目录前缀的临时文件被拦下', () => {
  const r = run({ CPT_STATUS: '?? resources/DSniang02 副本.webp\n' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /DSniang02 副本\.webp/)
})

test('resources/skins-src/ 被 vite 跳过、不进包，故放行（回归用例）', () => {
  // 真实形态：resources/skins-src/DSniang02.webp 被 .gitignore 排除、也不入库，
  // 但它只用于本机生成内置形象包。修前会被 copyResourcesExceptSkip 原样拷进
  // dist/resources/skins-src/ 并打进发行包；现在 vite 跳过 且 闸门放行，两边同源。
  const r = run({ CPT_STATUS: '!! resources/skins-src/DSniang02.webp\n' })
  assert.equal(r.status, 0, r.stderr)
})

test('resources/ 下真正会被拷进包的文件被拦下', () => {
  const r = run({ CPT_STATUS: '?? resources/thumbs/new-role.webp\n' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /new-role\.webp/)
  assert.match(r.stderr, /未跟踪/)
})

test('vite 构建期不拷贝的条目放行（清单与 vite.config.js 同源）', () => {
  // 这四条都是「进不了 dist、不必入库」：跳过清单写在 vite.config.js 里，脚本直接 import
  const r = run({
    CPT_STATUS: [
      '!! resources/skins-src/DSniang02.webp',
      '!! resources/manifest.json',
      '!! public/whale-pack/manifest.json',
      '!! public/shared/roles/role-01.webp',
      '',
    ].join('\n'),
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /没有会被打进包的未入库文件/)
})

test('CRLF 与目录前缀都能解析', () => {
  const r = run({ CPT_STATUS: '?? public/whale-pack/thumbs/新 图.webp\r\n' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /新 图\.webp/)
})

test('跳过目录按完整路径前缀匹配，与 vite 拷贝口径严格同源', async () => {
  // 变异体守卫：闸门「放行」必须等价于 vite「不拷」。曾有一版 vite 只在顶层判
  // `rel === '' && SKIP_PUBLIC_DIRS.has(ent.name)`，闸门却按任意层级前缀放行 ——
  // 于是 public/whale-pack/shared/x.webp 闸门放过、vite 照拷，防线漏空。
  // 修后 vite 也按完整路径前缀比，清单里写的是 'shared' ⇒ 只排 public/shared，
  // public/whale-pack/shared/ 仍会进包，闸门必须**拦**。两条断言把两边钉在一起。
  const vite = await import('../vite.config.js')
  assert.deepEqual([...vite.SKIP_PUBLIC_DIRS], ['shared'], '回归用例的嵌套断言依赖这条清单')

  const top = run({ CPT_STATUS: '!! public/shared/roles/role-01.webp\n' })
  assert.equal(top.status, 0, top.stderr)

  const nested = run({ CPT_STATUS: '!! public/whale-pack/shared/role-01.webp\n' })
  assert.equal(nested.status, 1)
  assert.match(nested.stderr, /whale-pack\/shared\/role-01\.webp/)
})

test('拿不到 git status 时 fail-open 放行', () => {
  // 指向一个不含 .git 的临时目录：git status 会以非 0 退出，脚本应告警后 exit 0
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-'))
  try {
    const env = { ...process.env, CPT_ROOT: dir }
    delete env.CPT_STATUS
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /本关跳过/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
