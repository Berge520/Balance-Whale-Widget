// test/dsh-lifecycle.test.mjs
// 慢 UAC 下「重启 / 更新」的续启时序（public/preload/lib/dsh.js 的 watchChildGone）。
//
// 真机 bug：结束提权实例本身要走 runas（UAC 弹窗），慢的时候旧进程还在跑；
// restart 在 20×350ms 等待到点后无条件 start()，而 start() 会因 state.child 仍非空
// 静默 no-op → 旧实例随后退出，界面停在「未运行」且没有任何提示；update 同路径还会
// 让 npm install 与仍在跑的旧实例抢 node_modules。
//
// 修法：等待到点后如果自己的 child 还在，就挂一个「等它真的退出再补一次」的轮询；
// 只补一次、新一次等待会取消上一次；UAC 取消写进 state.error 时立刻中止并报错。
// 这里用可注入的 tick / grace 摆时序，不真的拉 UAC、也不真等 30 秒。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'

// ── utools 桩（与 dsh-elevate.test.mjs 同口径：dsh.js 顶层会读 whale:config）──
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
}

const require = createRequire(import.meta.url)
const dsh = require('../public/preload/lib/dsh.js')
const { __state: st, __watchChildGone } = dsh

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 每个用例都从「有旧实例、无错误」开始，避免上一例的 state 残留
test.beforeEach(() => {
  st.child = null
  st.error = ''
})

// 把三个出口收成一个 promise，方便断言「到底走了哪条分支」
function watchOnce(opts) {
  return new Promise((resolve) => {
    __watchChildGone({
      tickMs: opts.tickMs,
      graceMs: opts.graceMs,
      onGone: () => { opts.onGone?.(); resolve('gone') },
      onAbort: (msg) => { opts.onAbort?.(msg); resolve('abort') },
      onTimeout: () => { opts.onTimeout?.(); resolve('timeout') },
    })
    if (opts.whileWaiting) opts.whileWaiting()
  })
}

test('旧实例退出后补启一次（慢 UAC 场景）', async () => {
  st.child = { pid: 123 }
  let started = 0
  const outcome = await watchOnce({
    tickMs: 10,
    graceMs: 500,
    onGone: () => { started++ },
    // 30ms 后才真正退出：模拟 UAC 弹窗还没被确认的窗口期
    whileWaiting: () => setTimeout(() => { st.child = null }, 30),
  })
  assert.equal(outcome, 'gone')
  assert.equal(started, 1)
  await sleep(40) // 停止后继续流过若干个 tick
  assert.equal(started, 1, '补启只能发生一次，不能每个 tick 都启动一遍')
})

test('旧实例一直不退出：超时明确失败，绝不补启', async () => {
  st.child = { pid: 456 }
  let started = 0
  const outcome = await watchOnce({
    tickMs: 10,
    graceMs: 40,
    onGone: () => { started++ },
  })
  assert.equal(outcome, 'timeout')
  assert.equal(started, 0, '旧实例还在跑时启动会出现两个实例')
})

test('结束提权实例被取消（state.error 已写）：立即中止等待，不补启', async () => {
  st.child = { pid: 789 }
  let started = 0
  let abortMsg = ''
  const outcome = await watchOnce({
    tickMs: 10,
    graceMs: 500,
    onGone: () => { started++ },
    onAbort: (msg) => { abortMsg = msg },
    whileWaiting: () => setTimeout(() => { st.error = '结束失败：UAC 提权被取消' }, 25),
  })
  assert.equal(outcome, 'abort')
  assert.match(abortMsg, /UAC 提权被取消/, '要把真实原因交回调用方，不能干等到超时')
  assert.equal(started, 0)
})

test('新一次等待会取消上一次：只有最新一次可能补启', async () => {
  st.child = { pid: 999 }
  let oldFired = 0
  __watchChildGone({
    tickMs: 10,
    graceMs: 200,
    onGone: () => { oldFired++ },
    onAbort: () => { oldFired++ },
    onTimeout: () => { oldFired++ },
  })
  // 后发者立即取代先发者；本用例里 child 一直不退出，所以它走超时分支
  const outcome = await watchOnce({ tickMs: 10, graceMs: 60 })
  assert.equal(outcome, 'timeout')
  assert.equal(oldFired, 0, '被取代的等待不能再触发补启，否则会并发起两个实例')
})

test('退出事件写的「端口被占用」错误不阻断补启（进程确实退了）', async () => {
  st.child = { pid: 111 }
  let started = 0
  const outcome = await watchOnce({
    tickMs: 10,
    graceMs: 500,
    onGone: () => { started++ },
    whileWaiting: () => {
      // exit 处理里 code!==0 + 日志含「端口」时会写这条错误；但它不是「结束失败」，不该中止等待
      setTimeout(() => { st.error = '端口 5678 已被占用：dsh 可能已在别处运行' }, 20)
      setTimeout(() => { st.child = null }, 35)
    },
  })
  assert.equal(outcome, 'gone')
  assert.equal(started, 1)
})

test('接线：restart / update 到点后都先等 child 退出，不再无条件启动或安装', () => {
  const src = fs.readFileSync(new URL('../public/preload/lib/dsh.js', import.meta.url), 'utf8')
  const restart = src.slice(src.indexOf('function restart(done)'), src.indexOf('function update('))
  const update = src.slice(src.indexOf('function update()'), src.indexOf('function listVersions('))
  assert.ok(restart.length > 0 && update.length > 0, '找不到 restart / update')
  assert.match(restart, /watchChildGone\(\{/)
  assert.match(restart, /if \(!state\.child\) \{\s*const s = start\(\)/)
  assert.match(update, /watchChildGone\(\{/)
  // 旧写法（到点直接装）必须消失：它会让 npm install 与旧实例抢文件
  assert.doesNotMatch(update, /if \(!pid \|\| tries > 20\) \{ clearInterval\(timer\); doInstall\(\) \}/)
})
