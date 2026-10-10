/*
 * 把「共享素材」源文件按 id 导出到 public/shared/（发版前手动跑一次）。
 *
 * ── 为什么要有这个脚本 ──
 * 共享角色与音效原先打成两个 .whaleassets 挂 Release，用户整包下载（角色包 40.6MB）。
 * 40MB 走 github.com 在国内太慢，改为**按张下载**：每张原图必须有独立 URL，
 * 而 Release 上的打包产物给不了单张 URL，所以把源文件按 id 重命名后提交进仓库，
 * 由 raw.githubusercontent.com / jsDelivr 直接按 URL 取单张。
 *
 * ── 为什么按 id 重命名（而不是原名）──
 * 源文件名是中文（「三月七（啥子）.png」「[东北]我踏马来啦.mp3」），含全角括号与方括号：
 *   ① 拼进 URL 必须 percent-encode，raw / jsDelivr 对中文路径的处理不完全一致，易踩坑；
 *   ② id 本身是 ASCII 短名（skins.js 的 id 白名单只收 ^[A-Za-z0-9_-]{1,40}$），
 *      落盘文件名本来就该用 id，导出即用 id 命名可与落盘保持一致。
 * 展示用的中文名留在 constants 的 name 字段里（设置页从宿主 listSharedSkins 拿）。
 *
 * ── 与 build-assets-pack.py 的关系 ──
 * 那个脚本打整包（已废弃，随本次改动一起删）；本脚本是它的替代：不再打容器，
 * 只把源文件按 id 拷到 public/shared/。两个脚本都从 assets-src/ 读输入、都以 constants
 * 的清单为对齐基准。
 *
 * 跑法：node scripts/export-shared-assets.mjs
 * 依赖：无（只用 Node 内置模块）
 * 输入：assets-src/skins/<中文原名>.png、assets-src/sounds/<中文原名>.<mp3|ogg>
 * 产物：public/shared/skins/<id>.png、public/shared/sounds/<id>.<ext>
 *
 * 幂等：重复跑只覆盖同名文件，不清空目录（历史上导出过的 id 若已从清单移除，
 * 需手工删 —— 脚本不主动删，避免误删用户手动放进来的东西）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// constants.js 是 CJS（public/preload/package.json 强制 commonjs），这里借 createRequire 引入，
// 让「清单」保持单一真源 —— 脚本不复制一份清单，避免与运行时漂移
const require = createRequire(import.meta.url)
const { SHARED_SKIN_PACK_SKINS, SHARED_SOUND_LIB } = require('../public/preload/lib/constants.js')

const SRC_SKINS = path.join(ROOT, 'assets-src', 'skins')
const SRC_SOUNDS = path.join(ROOT, 'assets-src', 'sounds')
const OUT_SKINS = path.join(ROOT, 'public', 'shared', 'skins')
const OUT_SOUNDS = path.join(ROOT, 'public', 'shared', 'sounds')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// 逐项导出：从 srcDir 找 srcName，校 sha256，写到 outDir/<id>.<ext>。
// 校验不通过（文件缺失 / 内容与 constants 清单不符）一律**报错退出**，不静默跳过 ——
// 导出错了会让用户下到坏文件，且在运行时才暴露（那时无从溯源到这一步）。
function exportOne(srcDir, outDir, id, srcName, ext, wantSha, kind) {
  const srcPath = path.join(srcDir, srcName)
  if (!fs.existsSync(srcPath)) {
    throw new Error(`[${kind}] 源文件不存在：${srcName}（期望在 ${path.relative(ROOT, srcDir)}/）`)
  }
  const buf = fs.readFileSync(srcPath)
  const got = sha256(buf)
  if (wantSha && got !== wantSha) {
    throw new Error(`[${kind}] ${srcName} 的 sha256 与 constants 清单不符\n  清单: ${wantSha}\n  实际: ${got}`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, id + '.' + ext)
  fs.writeFileSync(outPath, buf)
  return { id, ext, size: buf.length }
}

function run() {
  const out = { skins: [], sounds: [] }

  for (const s of SHARED_SKIN_PACK_SKINS) {
    const ext = String(path.extname(s.file || '') || '.png').replace(/^\./, '').toLowerCase()
    out.skins.push(exportOne(SRC_SKINS, OUT_SKINS, s.id, s.file, ext, s.sha256, '角色'))
  }

  for (const s of SHARED_SOUND_LIB) {
    // 音效清单没有 file 字段：源文件名 = name + '.' + ext（见 constants 注释）
    out.sounds.push(exportOne(SRC_SOUNDS, OUT_SOUNDS, s.id, s.name + '.' + s.ext, s.ext, s.sha256, '音效'))
  }

  const sum = (arr) => arr.reduce((n, x) => n + x.size, 0)
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
  console.log(`[export-shared-assets] 角色 ${out.skins.length} 张（${mb(sum(out.skins))}）→ public/shared/skins/`)
  console.log(`[export-shared-assets] 音效 ${out.sounds.length} 段（${mb(sum(out.sounds))}）→ public/shared/sounds/`)
  console.log('[export-shared-assets] 全部 sha256 校验通过，可以提交了')
}

try {
  run()
} catch (err) {
  console.error('[export-shared-assets] 失败：' + ((err && err.message) || err || '未知错误'))
  process.exit(1)
}
