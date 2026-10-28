/*
 * scripts/check-public-tracked.mjs 的自检（node --test，零依赖）。
 *
 * 用 CPT_STATUS 注入假的 git status 输出，不需要真 git 仓库、也不碰工作区。
 * 钉住的四件事：
 *   - 干净输出（只有 ` M`）必须放行；
 *   - `??`（未跟踪）必须拦；
 *   - `!!`（被 .gitignore 忽略）也必须拦 —— 这正是历史事故的形态（api.js.bak 被忽略，
 *     默认 git status 看不到，却被原样拷进 dist/ 打进发行包）；
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
  assert.match(r.stdout, /没有未入库文件/)
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

test('CRLF 与目录前缀都能解析', () => {
  const r = run({ CPT_STATUS: '?? public/whale-pack/thumbs/新 图.webp\r\n' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /新 图\.webp/)
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
