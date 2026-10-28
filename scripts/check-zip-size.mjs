/*
 * 校验打包后的 Release zip 体积（上限见 scripts/zip-limits.mjs）。
 *
 * 为什么单独一步：zip 由 `cd dist && zip -qr` 现打，CI 的 lint / typecheck / test / build
 * 都不看体积；dist/ 里混进陈年大件时四关全绿、Release 照发。这一步在打包之后、建 Release
 * 之前拦一道（历史事故：44MB 的废弃素材包被打进包，而一切都「绿」）。
 *
 * 用法：node scripts/check-zip-size.mjs <zip 路径>   # 超限 / 文件不在则 exit 1
 */
import { statSync } from 'node:fs'
import { MAX_ZIP_BYTES, MAX_ZIP_LABEL } from './zip-limits.mjs'

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/check-zip-size.mjs <zip 路径>')
  process.exit(1)
}

let size
try {
  size = statSync(file).size
} catch (e) {
  console.error(`[zip-size] ✗ 读不到 ${file}：${(e && e.message) || e}`)
  process.exit(1)
}

const mb = (size / 1024 / 1024).toFixed(2)
if (size > MAX_ZIP_BYTES) {
  console.error(`[zip-size] ✗ ${file} 有 ${mb} MB，超过上限 ${MAX_ZIP_LABEL}（正常约 1.2–2.4MB）`)
  console.error('  先查 dist/resources/ 与 dist/ 下有没有陈年大件：打包是 dist 里有什么就打什么。')
  process.exit(1)
}
console.log(`[zip-size] ✓ ${file} ${mb} MB（上限 ${MAX_ZIP_LABEL}）`)
