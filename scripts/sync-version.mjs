/*
 * 版本号单一来源同步脚本
 *
 * 以 package.json 的 version 为唯一真源，写入：
 *   - public/plugin.json 的 version
 *   - public/preload/lib/constants.js 的 PLUGIN_VERSION
 *
 * 由 npm run build 的 prebuild 钩子自动执行，避免三处手动同步遗漏导致更新检测失效。
 * 也可手动执行：node scripts/sync-version.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const pluginPath = path.join(root, 'public', 'plugin.json')
const servicesPath = path.join(root, 'public', 'preload', 'lib', 'constants.js')

const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
if (!version) {
  console.error('[sync-version] package.json 缺少 version 字段')
  process.exit(1)
}

// ── public/plugin.json ──
const pluginRaw = readFileSync(pluginPath, 'utf8')
const plugin = JSON.parse(pluginRaw)
if (plugin.version === version) {
  console.log(`[sync-version] plugin.json 已是 ${version}`)
} else {
  // 保留原有换行风格，避免整文件 diff
  const eol = pluginRaw.includes('\r\n') ? '\r\n' : '\n'
  plugin.version = version
  const out = JSON.stringify(plugin, null, 2).split('\n').join(eol) + eol
  writeFileSync(pluginPath, out, 'utf8')
  console.log(`[sync-version] plugin.json -> ${version}`)
}

// ── public/preload/lib/constants.js ──
const servicesRaw = readFileSync(servicesPath, 'utf8')
const re = /(const PLUGIN_VERSION = ')([^']*)(')/
const match = servicesRaw.match(re)
if (!match) {
  console.error('[sync-version] lib/constants.js 未找到 PLUGIN_VERSION 声明')
  process.exit(1)
}
if (match[2] === version) {
  console.log(`[sync-version] lib/constants.js 已是 ${version}`)
} else {
  writeFileSync(servicesPath, servicesRaw.replace(re, `$1${version}$3`), 'utf8')
  console.log(`[sync-version] lib/constants.js -> ${version}`)
}
