/*
 * 死键体检：store.js defaultConfig() 里的每个设置键，必须在「定义方之外」的代码里
 * 有至少一个属性读取点（.key 形态）。0 读点 = 死键嫌疑：设置页能改、能持久化、
 * 能回显，但运行时没人读 —— 用户调了没用，三关（lint / typecheck / test）全绿也照样发生。
 *
 * 两层扫描（思路来自上游 DeepSeek-Balance-Whale-Widget 的 tools/check-dead-settings.mjs）：
 *   第一层（全量）：defaultConfig 全部键逐一数读点，0 读点即嫌疑，ALLOW 白名单逐条写理由豁免。
 *     这层拦「新增键忘接消费方」—— test/build-gates.test.mjs 的固定清单版只做回归防护，拦不住新增。
 *   第二层（契约）：EXPECT_CONSUMERS 登记键 → 必须读到它的文件。键在别的文件碰巧被提一嘴
 *     不算数，指定消费方没有读点就红 —— 拦「读点被搬走 / 删掉，别处残留引用掩盖了死亡」。
 *
 * 与 test/build-gates.test.mjs 的分工：那边是「门禁还在链路上」的契约测试 + 挂件视觉键子集的
 * 回归防护；这里做全量扫描。两者并存：测试随 npm test 跑（无构建依赖），本脚本挂在 prebuild 上。
 *
 * 自检：test/check-dead-settings.test.mjs 用临时样本仓库逐项验证「写坏必红」（干净样本全绿、
 * 死键 / 注释骗过 / 过期表 / 契约违约各自变红），经 CDS_ROOT / CDS_ALLOW / CDS_EXPECT 三个
 * 环境变量注入。真实构建不设这些变量，走默认值，行为不变。
 *
 * 口径与取舍（别高估这层网）：
 *   - store.js 是定义方（readConfig/writeConfig 会提到每个键），不计入消费方，否则无键会死。
 *   - 只报「零读点」，不做「读点即活」的强证明：子对象属性与配置键同名会算误活（宁可漏报不误报，
 *     本脚本定位是 tripwire；漏报的典型是「读点存在但逻辑从不用返回值」，那只能靠人）。
 *   - 白名单是欠账清单不是免检牌：每条必须写理由，键被删后白名单条目会因「defaultConfig 里
 *     没有这个键」而红，逼着清理。目标永远是空表。
 *
 * 由 npm run build 的 prebuild 钩子自动执行，也可手动执行：node scripts/check-dead-settings.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 自检注入口：样本仓库的目录结构与真实仓库不同（minimal），所以三个注入项必须**整体**
// 覆盖默认值，而不是合并 —— 自检里样本仓库没有 src/views、消费方集合也自己给定。
// 真实构建不设这些变量，走默认值，行为与注入前完全一致。
const root = path.resolve(
  process.env.CDS_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
)
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

// 剥掉注释与字符串后再数读点：注释里提到键名、字符串里拼键名都不能算「有消费方」
// （上游明确踩过：给函数写一句含键名的说明，契约层立刻被骗过）
function stripJs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}
function stripVue(src) {
  return stripJs(src.replace(/<!--[\s\S]*?-->/g, ' '))
}

// —— 定义方：从 store.js 的 defaultConfig() 抽全部顶层键 ——
// CDS_MIN_KEYS：样本仓库只造几个键，放宽「解析出过少键 = 解析规则失效」的护栏阈值。
const MIN_KEYS = Number(process.env.CDS_MIN_KEYS) || 50
const storeSrc = read('public/preload/lib/store.js')
const dft = storeSrc.match(/function defaultConfig\(\)\s*\{\s*return\s*\{([\s\S]*?)\}\s*\}/)
if (!dft) throw new Error('store.js 里找不到 defaultConfig()，解析规则可能已失效')
const keys = []
for (const m of dft[1].matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) keys.push(m[1])
if (keys.length < MIN_KEYS) throw new Error(`defaultConfig 只解析出 ${keys.length} 个键，解析规则可疑`)

// —— 消费方文件集（定义方 store.js 不在内，见头部口径）——
// CDS_CONSUMERS：自检用的**替代**消费方清单（逗号分隔相对路径）。样本仓库没有 src/views、
// src/components 这些目录，readdirSync 会炸；注入后脚本就不再探目录，只按清单读文件。
const CONSUMERS = process.env.CDS_CONSUMERS
  ? process.env.CDS_CONSUMERS.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'index.html',
      'public/floating-page.js',
      'public/preload/services.js',
      ...readdirSync(path.join(root, 'public/preload/lib')).filter((f) => f.endsWith('.js') && f !== 'store.js')
        .map((f) => `public/preload/lib/${f}`),
      'src/App.vue',
      ...readdirSync(path.join(root, 'src/views')).filter((f) => f.endsWith('.vue')).map((f) => `src/views/${f}`),
      ...readdirSync(path.join(root, 'src/components')).filter((f) => f.endsWith('.vue')).map((f) => `src/components/${f}`),
    ]
const strippedOf = {}
for (const f of CONSUMERS) {
  strippedOf[f] = f.endsWith('.vue') ? stripVue(read(f)) : stripJs(read(f))
}

// 键的读点：属性访问 .key 形态（`.key`）。命中任意消费方文件即算有读点。
// 只认点访问不是偷懒：本项目消费方里不存在 ['key'] 括号形态（全仓 grep 核实过），
// 且 stripJs 已把字符串字面量剥成 ''，cfg['vol'] 的键名部分根本不在扫描面上。
function hasReadIn(file, key) {
  const re = new RegExp('\\.\\s*' + key + '\\b')
  return re.test(strippedOf[file])
}
function readersOf(key) {
  return CONSUMERS.filter((f) => hasReadIn(f, key))
}

// —— 第一层白名单：defaultConfig 里的键、全仓库零读点，但有存在的理由 ——
// 每条必须写理由；键从 defaultConfig 删掉后条目必须跟着删（下面的存在性校验会红）。
// 目标永远是空表：给死键接上消费方，或把键删掉，然后把条目清掉。
// CDS_ALLOW：自检注入（JSON 对象，键 → 理由），替代真实仓库的白名单表。
const ALLOW = process.env.CDS_ALLOW ? JSON.parse(process.env.CDS_ALLOW) : {
  // （暂空 —— 出现条目时写清「为什么允许它暂时没人读」）
}

// —— 第二层契约表：这些键**必须**在指定文件里有读点 ——
// 与第一层互补：第一层只保证「别处有人读」，这里保证「该读它的文件真的在读」。
// 只登记「运行时消费方明确唯一」的键，不追求全键覆盖（全键契约是维护深坑，
// 挂件视觉键那批已由 test/build-gates.test.mjs 以固定清单形式钉住，不在此重复）。
// 路径相对仓库根；文件从消费方集合里剔除后（如改名）会因路径不存在而红，逼着同步。
// CDS_EXPECT：自检注入（JSON 对象，键 → 文件数组），替代真实仓库的契约表。
const EXPECT_CONSUMERS = process.env.CDS_EXPECT ? JSON.parse(process.env.CDS_EXPECT) : {
  // 提醒音独立音量：悬浮窗解析三态音量的唯一地方（设置页只写不播）
  alertVols: ['public/floating-page.js'],
  // 台词与提醒文案模板：悬浮窗是唯一运行时消费方
  quotes: ['public/floating-page.js'],
  alerts: ['public/floating-page.js'],
  // 免打扰时段：api.js 的 inQuietHours 判断（发系统通知前据此静默）
  quietOn: ['public/preload/lib/api.js'],
  quietFrom: ['public/preload/lib/api.js'],
  quietTo: ['public/preload/lib/api.js'],
  // 计时状态落库的开关：宿主 pushInit 据此决定是否回推计时
  timerPersistOn: ['public/preload/lib/widget.js'],
}

let bad = 0

// 白名单/契约表的键必须真实存在于 defaultConfig：防「键删了、表忘了清」的过期条目
for (const [table, entries] of [['ALLOW', ALLOW], ['EXPECT_CONSUMERS', EXPECT_CONSUMERS]]) {
  const phantom = Object.keys(entries).filter((k) => !keys.includes(k))
  if (phantom.length) {
    bad++
    console.error(`[check-dead] ${table} 登记了 defaultConfig() 里不存在的键（表已过期或键名拼错）：${phantom.join(', ')}`)
  }
}
for (const [k, files] of Object.entries(EXPECT_CONSUMERS)) {
  const missing = files.filter((f) => !CONSUMERS.includes(f))
  if (missing.length) {
    bad++
    console.error(`[check-dead] EXPECT_CONSUMERS['${k}'] 登记的文件不在消费方集合里（改名/删除后未同步）：${missing.join(', ')}`)
  }
}

// 第一层：全量 0 读点扫描
const dead = []
for (const k of keys) {
  if (ALLOW[k] !== undefined) continue
  if (!readersOf(k).length) dead.push(k)
}
if (dead.length) {
  bad++
  console.error(`[check-dead] ${dead.length} 个设置键在所有消费方文件里都没有读取点（设置页能改、运行时不读 = 调了没用）：`)
  for (const k of dead) console.error(`  ${k}`)
  console.error('  处理：给键接上消费方，或从 defaultConfig 删掉；确属「暂留但未接线」的，进 ALLOW 写明理由')
}

// 第二层：契约文件必须有读点
for (const [k, files] of Object.entries(EXPECT_CONSUMERS)) {
  for (const f of files) {
    if (!hasReadIn(f, k)) {
      bad++
      console.error(`[check-dead] 契约违约：键「${k}」在指定消费方 ${f} 里没有读取点（读点可能被搬走/删除，只剩别处残留引用）`)
    }
  }
}

if (bad) {
  console.error(`[check-dead] ${bad} 处问题，请修复后再构建`)
  process.exit(1)
}
console.log(`[check-dead] ${keys.length} 个设置键全部有读点，契约表 ${Object.keys(EXPECT_CONSUMERS).length} 条全部满足`)
