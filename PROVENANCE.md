# 素材来源与许可范围（PROVENANCE）

本仓库的**代码**按 **AGPL-3.0-only** 开源（见 [LICENSE](LICENSE)），其中移植自上游的部分同时保留上游的 MIT 条款（见 [LICENSE-MIT](LICENSE-MIT)）。

`public/whale/` 与 `public/logo.png` 下的**美术素材**（形象图 / 动图 / 音效 / 图标）**不在上述许可覆盖范围内**，按下面的说明「原样（as-is）提供」。

## 一、许可范围

| 范围 | 许可 |
|---|---|
| `src/`、`public/preload/`、`public/floating-*`、`scripts/`、`test/` 与文档 | **AGPL-3.0-only**（见 `LICENSE`）；移植自上游的部分另见 `LICENSE-MIT` |
| `public/whale/**`、`public/logo.png` | **不适用上述许可**：随插件原样分发，仅用于运行本插件；不授予再许可，也不声明为本项目原创作品 |
| `public/shared/**`、`resources/**`（可下载的共享素材与其缩略图） | **不适用上述许可**：来源见第二节第 4 小节（上游 QQ 群分享），同样按 as-is 提供、适用第四节 Takedown |

这样划分的原因：代码可以明确授权，而美术素材的来源与权利状态往往无法百分之百举证 —— 与其给一个站不住的授权，不如如实标注范围，并承诺收到权利主张就处理（见第四节）。

## 二、逐项来源

### 1. 上游素材

`public/whale/` 下这几个文件与上游 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的 `assets/` 对应关系如下：

| 文件 | 上游对应 | 说明 |
|---|---|---|
| `rua.webp` | `assets/bubble-petpet.gif` | 随机动图（同一份素材，本项目改了名并转码）。**原为逐字节一致的 `rua.gif`，v1.7.x 起转成无损动 WebP**（10 帧逐帧像素比对一致、尺寸 128×128 与每帧 20ms 与循环次数均不变，体积 92KB→59KB），因此**已不再是逐字节一致** |
| `Ya2.mp3` | 同名 | 内置音效（松开），**逐字节一致**（已按 SHA-256 核对） |
| `Ya1.mp3` / `D1.mp3` / `D2.mp3` | 同名 | 内置音效（按压 / 松开）—— 音频帧数据与上游一致，但**已剥离 ID3v2 标签段**（见第三节），因此**已不再是逐字节一致** |

上游的两张形象图 `assets/DSniang1.png`（610×610）与 `assets/DSniang02.png`（1026×1026）**画面内容原样保留**，仅重新编码为 WebP：`DSniang1.webp` 随插件包分发（`public/whale/`，挂件默认形象），`DSniang02.webp` 自 v1.8.0 起改为**按需下载**（不再随包，见本节第 6 小节）—— 分辨率与像素内容未改，但**已不再是逐字节一致**。

> v1.8.0 起随包内置形象精简为 1 张（`DSniang1.webp`）：历史上的其余 12 张（`DSniang02`、`DSniang3`–`DSniang7`、`black`、`ciya`、`glby`、`liuy`、`Jian`、`无稽之谈改`）已从随包目录移除 —— `DSniang02` 改由可下载的形象包（本节第 6 小节）提供，其余 11 张随该次清理一并删除（见本节第 2 小节），现不再随本插件以任何形式分发。老用户已选的旧形象 id 由 `LEGACY_BUILTIN_SKINS` 兜底，配置值不会被打回默认。

上游 `assets/` 里的 `DSH2.png`、`bubble-money1.gif`、`minecraft-exp-orb.wav`、`task-end-a.wav` **未随本插件分发**。

据上游的 [PROVENANCE.md](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/main/PROVENANCE.md)：这些素材由上游维护者提供或使用 AI 工具生成，按 as-is 随插件分发，上游同样声明其不在 MIT 覆盖范围内。

### 2. 上游开发者的其余素材（未收录于上游仓库）

`public/whale/` 下曾另有 11 张内置形象（`liuy` / `Jian` / `无稽之谈改` / `DSniang3`–`DSniang7` / `black` / `ciya` / `glby`）。据本项目维护者说明，它们同为**上游开发者**的素材，但**上游仓库没有收录** —— 已核对上游 `main` 的完整文件树（`truncated: false`）、全部 releases（v0.2.2–v0.3.2）以及上游用户名下的全部仓库，均无对应文件：

- 上述 11 张**已于 v1.8.0 随「随包形象清理」一并删除**，现不再随本插件以任何形式分发。删除时的逐像素比对结论（哪些是同一张图的变体 / 放大版 / 剪影）已无留存必要，此处不再列出。

> 说明：这些文件的**文件名**沿用它们在本项目中的原始命名（`DSniang3`–`DSniang7` 承接第一节的上游形象序号，其余为素材原名），并非上游仓库中的文件名 —— 上游未收录它们，也就没有对应的上游文件名可比对。

由于上游自身即声明其素材不适用 MIT，这批文件即已删除，也从未在上游 MIT 的覆盖范围内。它们不再出现在本插件的任何分发形态中（随包或下载），故本文件不再为它们声明 as-is 条款；仅保留上面这段历史来源记录，以备追溯。

### 3. 本项目生成

| 文件 | 说明 |
|---|---|
| `public/logo.png`（256×256） | uTools 插件列表图标：由 `DSniang1`（现为 `DSniang1.webp`）**等比缩放**而来（高质量重采样，已按像素比对核对） |

### 4. 上游 QQ 群分享素材（可下载资源，不随包）

`public/shared/` 下另有**一批经用户下载方式提供**的素材（形象 36 张 / 音效 45 个），由本项目维护者从**上游交流 QQ 群**中获取。这批**不随插件包分发**（`vite.config.js` 的 `SKIP_PUBLIC_DIRS` 排除 `shared`），而是随仓库入库，由用户按需**单张**下载到本地（见 `public/preload/lib/assets-packs.js`）。`resources/thumbs/` 下 36 张缩略图由这批形象派生（设置页下载前预览用），同样按 as-is 提供。

- **权利状态**：来源为第三方分享，**无法举证原始权利归属**，按 as-is 提供，仅用于运行本插件；不声明为本项目原创，也不授予再许可，适用第四节的 Takedown 承诺。其中一部分音效的文件名本身即含可辨认的出处线索（如 `..._爱给网_aigei_com`、`Villager_*` 等）；本项目**未逐一取得授权**，一并适用 Takedown 承诺。
- **入库与命名**：素材原文件按 `id.ext`（ASCII 短哈希 / 序号）重命名后入库 `public/shared/skins/` 与 `public/shared/sounds/`，避开中文路径与全角括号在 CDN / raw 链接上的兼容性问题（见 `scripts/export-shared-assets.mjs`）。原始素材源（`assets-src/`、`resources/skins-src/`）仍不进仓库。
- **UI 标注**：设置页对这类可下载资源标注「来源：上游 QQ 群分享，按原样提供」，与「内置资源」区分，避免用户误以为是本项目原创。

### 5. 随包素材的格式与压缩

`public/whale/` 下随包形象图（现为 1 张 `DSniang1.webp`；v1.8.0 前为 13 张）随包时统一为 **WebP（有损，质量 90，带 alpha 通道）**。v1.8.0 前 13 张原为 PNG、合计 **10.8 MB**（占当时插件包体积的 94%）；转 WebP 后合计约 **1.0 MB** —— 这也是后续把内置形象精简为 1 张的动机之一。

转换只改编码方式：**分辨率、宽高比与透明通道逐张核对与转换前一致**，画面内容与构图未作任何改动。因此这不影响任何素材的来源与权利归属 —— 第 1 小节的对应关系依旧成立，只是 `DSniang1`（随包）与 `DSniang02`（可下载）两张形象图不再与上游「逐字节一致」。

形象 id 不含扩展名（`LEGACY_BUILTIN_SKINS` 里的 id 即文件名主干），故换格式**未改动任何配置字段**，老用户的 `config.skin` 照常生效。

### 6. 按需下载的两个素材包（不随包）

当前有两类素材按需下载，均**不随插件包分发**：

| 素材包 | 内容 | 与本文档的来源对应 |
|---|---|---|
| 内置形象包（`SKIN_PACK_SKINS`，见 `skin-packs.js`） | 1 张：`DSniang02` | 上游素材，对应第 1 小节 `assets/DSniang02.png`；仅重新编码为 WebP |
| 共享素材包（`SHARED_SKIN_PACK_SKINS` / `SHARED_SOUND_LIB`，见 `assets-packs.js`） | 形象 36 张 / 音效 45 个 | 上游 QQ 群分享，对应第 4 小节 |

- 形象包本体是 Release 附件 `skins-pack.whaleassets`（由 `scripts/build-skin-pack.py` 生成），设置页点某张缩略图时走 raw 直链取单张；校验值 `SKIN_PACK_SHA256` 与逐张 sha256 见 `constants.js`。
- 该脚本的输入形象原图存放在 `resources/skins-src/`（**不入库**，发布者本机保留即可），由脚本导出的单张原图副本落在 `public/whale-pack/src/`（随仓库入库，供 raw 直链取单张）。这些图同样来自上游开发者（同第 1 小节），按 as-is 提供。
- 共享素材包走 jsDelivr CDN / 用户自定义前缀 / `ghfast.top` / raw 直链的候选链单张下载，清单（含逐张 sha256）见 `constants.js` 的 `SHARED_SKIN_PACK_SKINS` 与 `SHARED_SOUND_LIB`。
- 两者的权利状态分别同第 1、4 小节；均按 as-is 提供，适用第四节 Takedown。

## 三、元数据清理

随包素材**不留内嵌元数据**，现状经解析核对：

- **WebP**（`public/whale/` 下随包形象图，现为 1 张 `DSniang1.webp`）：只有渲染必需的 `VP8X` / `ALPH` / `VP8` 三种块，没有 `EXIF` / `XMP ` / `ICCP` 这类元数据块（编码时未写入任何元数据，已逐文件解析块序列核对）。
- **PNG**（`public/logo.png`）：只有渲染必需的 `IHDR` / `pHYs` / `IDAT` / `IEND`，没有 `eXIf` / `iTXt` / `tEXt` / `zTXt` 这类文本与归属块（上游自 0.3.1 起已剥离文本与归属块，本项目沿用此口径）。
- **WebP 动图**（`rua.webp`）：无损动 WebP，只有渲染必需的块，无 `EXIF` / `XMP ` / `ICCP` 元数据块（由原 `rua.gif` 转码而来，转码后无残留的 GIF 注释块）。
- **MP3**（四个音效）：原先带 ID3v2.3 标签 —— `D1.mp3` / `D2.mp3` 为 `TXXX: Packed by Bilibili XCoder v2.0.2`，`Ya1.mp3` 为 `TXXX: 13367393`。**本项目已剥离**：只切掉 ID3 标签段，不重编码、不动音频帧数据，因此音质与时长完全不变；现在四个文件都是裸 MPEG 帧流，不含任何标签。

复核方式：解析 PNG 与 WebP 的块序列、扫描 MP3 文件头与尾部标签，确认无残留文本块。

## 四、权利主张 / Takedown

如果你认为上述素材侵犯了你的权利，请在本仓库开一条 issue，说明**文件名**与**依据**，我们会在核实后**立即替换或移除**，不附加其它条件。也欢迎直接提供可自由再分发的替代素材。

需要干净授权时不必改代码：设置页「资源」Tab 支持导入自定义形象、气泡图与音效（导入的素材落在 `userData/whale-*/`，与插件包内的素材无关）。
