import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 素材包目录（public/whale-pack/）里只有**大件**不该进插件包：
//   - skins-pack.whaleassets 是发 Release 的远程附件本身（v1.8.0 起 1 张约 73KB），随包等于白减体积；
//   - manifest.json 是做核对用的中间产物，运行时用不到。
// 但 thumbs/（v1.8.0 起 1 张缩略图，约 4KB）必须进包：设置页「内置资源」折叠区用相对路径
// './whale-pack/thumbs/<id>.webp' 显示缩略图，让用户下载前就能看见长什么样。
const SKIP_PUBLIC_FILES = new Set(['whale-pack/skins-pack.whaleassets', 'whale-pack/manifest.json'])

// public/shared/ 是「共享素材」的单张下载源（scripts/export-shared-assets.mjs 导出，
// 角色 36 张约 40.6MB + 音效 45 段约 2.7MB），**整个目录都不进插件包**：
// 它入库的唯一目的是让用户从 raw / jsDelivr 按 URL 单张取；
// 若随插件包分发，插件体积白涨 43MB，等于把「按需下载」这件事作废。
const SKIP_PUBLIC_DIRS = new Set(['shared'])

// resources/ 是仓库里的素材源目录，**大部分不该进插件包**：
//   - manifest.json 是打包核对用的中间产物；
//   - thumbs/（36 张缩略图，约 404KB）**必须进包** —— 设置页「共享角色」网格用相对路径
//     './resources/thumbs/<id>.webp' 显示缩略图，让用户下载前就能看见长什么样。
const SKIP_RESOURCES_FILES = new Set(['manifest.json'])

// 把仓库根的 resources/ 拷进 dist/resources/，按上面清单排除大件
function copyResourcesExceptSkip(outDir) {
  return {
    name: 'whale-copy-resources-except-pack',
    apply: 'build',
    async writeBundle() {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const src = path.resolve(process.cwd(), 'resources')
      if (!fs.existsSync(src)) return
      const walk = (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const childRel = rel ? rel + '/' + ent.name : ent.name
          if (SKIP_RESOURCES_FILES.has(childRel)) continue
          const from = path.join(dir, ent.name)
          const to = path.join(outDir, 'resources', childRel)
          if (ent.isDirectory()) {
            fs.mkdirSync(to, { recursive: true })
            walk(from, childRel)
          } else {
            fs.mkdirSync(path.dirname(to), { recursive: true })
            fs.copyFileSync(from, to)
          }
        }
      }
      walk(src, '')
    },
  }
}

// 把 publicDir 的内容按原样拷进 dist，但跳过上面列出的大件
function copyPublicExceptSkip(outDir) {
  return {
    name: 'whale-copy-public-except-pack',
    apply: 'build',
    async writeBundle() {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const src = path.resolve(process.cwd(), 'public')
      const walk = (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const childRel = rel ? rel + '/' + ent.name : ent.name
          if (SKIP_PUBLIC_FILES.has(childRel)) continue
          if (ent.isDirectory() && rel === '' && SKIP_PUBLIC_DIRS.has(ent.name)) continue
          const from = path.join(dir, ent.name)
          const to = path.join(outDir, childRel)
          if (ent.isDirectory()) {
            fs.mkdirSync(to, { recursive: true })
            walk(from, childRel)
          } else {
            fs.mkdirSync(path.dirname(to), { recursive: true })
            fs.copyFileSync(from, to)
          }
        }
      }
      walk(src, '')
    },
  }
}

// src/bubble/bubble-render.js 是悬浮窗与设置页共享的气泡渲染器单一来源。悬浮窗页面是
// file:// 下的普通 script（不能用 ES module），所以构建时用 esbuild 把它打成 IIFE：
// dist/bubble-render.js 挂全局 window.BubbleRender，floating.html 在 floating-page.js 之前加载。
// esbuild 取 Vite 的传递依赖（node_modules 顶层提升副本），不单独进 package.json。
// 不压缩：与 dist 里其他原样文件一致，标识符不混淆便于排障（注释会被 esbuild 剥掉，源文件保留）。
// 放 closeBundle 而非 writeBundle：watch 模式下每次重建都会触发，产物始终跟源文件同步。
function buildBubbleRenderIife(outDir) {
  return {
    name: 'whale-build-bubble-render',
    apply: 'build',
    async closeBundle() {
      const esbuild = await import('esbuild')
      const path = await import('node:path')
      await esbuild.build({
        entryPoints: [path.resolve(process.cwd(), 'src/bubble/bubble-render.js')],
        outfile: path.resolve(process.cwd(), outDir, 'bubble-render.js'),
        bundle: true,
        format: 'iife',
        globalName: 'BubbleRender',
        minify: false,
        logLevel: 'silent',
      })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  // publicDir 关掉：uTools 插件要的是 public/ 下的原样文件（preload/、floating.html…），
  // 交给上面那个插件拷贝，才能按需排除 whale-pack/。
  publicDir: false,
  plugins: [
    vue(),
    copyPublicExceptSkip('dist'),
    copyResourcesExceptSkip('dist'),
    buildBubbleRenderIife('dist'),
  ],
  base: './'
})
