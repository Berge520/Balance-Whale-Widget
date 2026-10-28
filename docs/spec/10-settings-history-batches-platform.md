**⑯ 「开发者」Tab 三平台（Windows / macOS / Linux）支持审计与改造（2026-09-28）**

逐卡核对结论：**平台硬阻塞集中在 dsh 主控卡的「安装 / 提权」链路**，其余 7 张卡（环境诊断 / 配置转储 / 全量导出 / 用量统计 / 插件开关 / 插件市场 / Codex 会话统计）近于零平台耦合。本轮只做「真平台阻塞 + 纯收益小项」。

- **⚠️ 先分清两类命中**：`netstat` / `tasklist` / `wmic` / `taskkill` / `powershell` **几乎全在 `WIN` 分支内或注释里**，POSIX 侧早有 `lsof` / `ps -o comm=` / `ps -o args=` / `kill`。判据是「有没有 POSIX 分支」而非「有没有出现 Windows 命令」。
- **① 提权链路平台化（真阻塞）**：新增 `elevateTool()` —— Windows 返回 `{exe: powershell, kind:'uac'}`，macOS / Linux 优先 `/usr/bin/pkexec`、回退 `sudo`；`elevateInstall()`（非 Windows 直接 `pkexec` / `sudo` 起 `npm`）、`stopExternal()`（POSIX 走 `sudo kill -TERM`）、`elevateWhy()` 三处分叉。`elevateTool` 与 `psExe` 一并导出；`hosts.js` 的 UAC 写 hosts 复用 `psExe`，**非 Windows 已由 `!WIN` 门禁挡成「仅支持 Windows」**。
- **② `runPnpm` 超时清理补 POSIX 分支（真阻塞，静默失效型）**：Windows 用 `taskkill /T /F` 杀进程树，POSIX 原无清理（子进程存活会抢同一份 profile 锁，表现为「卸载 / 更新一直超时」）。补 `kill -TERM -<pid>` 杀**进程组**（`spawn` 时 `detached`），与 `/T` 语义对齐。
- **③ 文案平台化（`IS_WIN`）**：新增 `IS_WIN`（`utools.isWindows()` 包 `try/catch`）；「更新会弹一次 UAC」按平台显示「UAC」/「提权」；「Windows 动态端口段常预留 3080」改为仅 Windows 显示，其余用「若被其它程序占用」。
- **④ 诊断候选目录显式分支（软问题）**：`diagnostics.js` 的 `globalModuleRoots()` 原候选集偏 Windows（`node_global` / `%APPDATA%\npm`…），POSIX 的 `/usr/local/lib/node_modules` / `/usr/lib/node_modules` / `~/.npm-global/lib/node_modules` 全缺。改为按 `WIN` 显式分派两组，**Windows 侧候选集逐项不变**（单测依赖 `%APPDATA%\npm\node_modules` 仍过）。
- **诚实边界**：`sudo` / `pkexec` / `lsof` / `ps` 分支**无法真机验证**（开发机 Windows），仅代码级对照；`lsof` 缺失时按「探测拿到空结果」降级、**不崩溃**（与 C5「拿不到 → 无法判定」同口径）。
- **验证**：四关全绿（含 `check-shared` 副本一致）。**`public/preload/lib/dsh.js` 与 `diagnostics.js` 有改动**，需重载插件；`App.vue` 走 `npm run dev`。

**⑰ 画廊缩略图「无预览」根因修复（bug 10，2026-09-29）**

真机核验报：**「共享角色能显示出来预览图，但是在导入的形象显示不出来预览图」**。

- **两条链路**：**共享角色网格**走静态 `./resources/thumbs/<id>.webp`（几 KB，**渲染进程直接读、不经宿主**）；**本地画廊**（导入 + 已下载共享角色）走 `utools.getPath(''userData'')/whale-skins/<id>.thumb.png|webp`，经宿主 `skins.listSkins()` 读回；前者正常、后者全空。
- **磁盘证据**：`uTools\whale-skins` 下 `s*.png` / `Q*.png` **全部没有 `.thumb.png`**，仅一张老遗留的 `kmumigcc0r5v.thumb.png`。
- **根因 = 两条独立的错叠加**：
  - ① **下载侧从不落缩略图**：`assets-packs.js#downloadSharedSkin` 调 `installBuiltin` 时第 4 参**写死 `null`**。
  - ② **读回侧格式不认**：`skins.readThumb(id)` 只试 `.thumb.png`，打包的缩略图却是 `.webp`。
  - ③ **放大器**：`listSkins()` 无缩略图时**回落读原图**塞进 `thumb`，但 `fallbackBudget = 8 * 1024 * 1024`（8MB）**逐张判断**（`size <= fallbackBudget` 才回落）；共享角色原图 0.9–2.7MB → **约第 4 张就耗光预算**，之后全部 `thumb: ''''`，故「前几张可能有」。
- **修复三层**（细节见 §五「缩略图懒补」）：
  - **下载落盘**：`installBuiltin` 第 4 参由 **Buffer 改为 data URL 字符串**（`writeThumb` 按前缀决定 `.thumb.png` / `.thumb.webp`）；设置页新增 `sharedSkinThumbDataUrl(id)` 把 `resources/thumbs/<id>.webp` 读成 data URL，经 `downloadSharedSkin(id, prefix, thumb)` 第 3 参传给宿主 —— **必须由设置页给**：宿主 preload 无 plugin 路径 API。
  - **老数据懒补**：`App.vue#refreshSkin()` 挂 `backfillMissingThumbs()`，对 `!it.thumb && it.builtin === true` 的项调 `setSkinThumb(id, url)`，只补一轮、`backfillingThumbs` 防重入。
  - **读回兼容**：`readThumb` / `removeSkin` / `exportItems` 全支持 png + webp（漏 `exportItems` 会让 webp 项导出后丢缩略图）；新增 `hasThumbFile(id)` 做**纯文件存在性**检查 —— `setThumb` 不能用 `readThumb(id)` 非空判断（`thumb` 带回落）。
- **顺带修**：`skin-packs.js` 按 manifest 的 `thumbOff` / `thumbLen` 切缩略图传给 `installBuiltin`（**当前发布包两项都是 0**，走空串分支、不回归）；`writeThumb` 落盘时清掉另一格式旧文件。
- **验证**：四关全绿（`check-shared` 一致）。纯 `src/` 改动，`npm run dev` 热更新。
