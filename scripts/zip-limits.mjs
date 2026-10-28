/*
 * Release zip 体积上限的**单一来源**。
 *
 * 为什么需要：打包是 `cd dist && zip -qr ... .`，dist 里有什么就打什么。历史事故是
 * `dist/resources/` 下混进一个废弃的 44MB 素材包，.upx / zip 从 1.2MB 涨到 44MB，
 * 而 lint / typecheck / test / build 全绿、Release 照发 —— 体积没有任何一道关在看。
 *
 * 正常体积：约 1.2–2.4MB（共享角色 / 音效在 public/shared/，被 vite 的 SKIP_PUBLIC_DIRS
 * 排除，不进包）。上限给到 8MB 是留出「内置形象 / 气泡图长大」的余量，同时远低于事故量级。
 *
 * 被两处消费，改这里一处即可：
 *   - scripts/check-zip-size.mjs（release.yml 打包后调用）
 *   - scripts/verify-release-zip.mjs（release.mjs 下载 Release 资产后调用）
 */
export const MAX_ZIP_BYTES = 8 * 1024 * 1024
export const MAX_ZIP_LABEL = '8 MB'
