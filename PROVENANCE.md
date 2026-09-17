# 素材来源与许可范围（PROVENANCE）

本仓库的**代码**按 **AGPL-3.0-only** 开源（见 [LICENSE](LICENSE)），其中移植自上游的部分同时保留上游的 MIT 条款（见 [LICENSE-MIT](LICENSE-MIT)）。

`public/whale/` 与 `public/logo.png` 下的**美术素材**（形象图 / 动图 / 音效 / 图标）**不在上述许可覆盖范围内**，按下面的说明「原样（as-is）提供」。

## 一、许可范围

| 范围 | 许可 |
|---|---|
| `src/`、`public/preload/`、`public/floating-*`、`scripts/`、`test/` 与文档 | **AGPL-3.0-only**（见 `LICENSE`）；移植自上游的部分另见 `LICENSE-MIT` |
| `public/whale/**`、`public/logo.png` | **不适用上述许可**：随插件原样分发，仅用于运行本插件；不授予再许可，也不声明为本项目原创作品 |

这样划分的原因：代码可以明确授权，而美术素材的来源与权利状态往往无法百分之百举证 —— 与其给一个站不住的授权，不如如实标注范围，并承诺收到权利主张就处理（见第四节）。

## 二、逐项来源

### 1. 上游素材

`public/whale/` 下这几个文件与上游 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的 `assets/` 对应关系如下：

| 文件 | 上游对应 | 说明 |
|---|---|---|
| `rua.gif` | `assets/bubble-petpet.gif` | 随机动图（同一份文件，本项目改了名），**逐字节一致**（已按 SHA-256 核对） |
| `Ya2.mp3` | 同名 | 内置音效（松开），**逐字节一致**（已按 SHA-256 核对） |
| `Ya1.mp3` / `D1.mp3` / `D2.mp3` | 同名 | 内置音效（按压 / 松开）—— 音频帧数据与上游一致，但**已剥离 ID3v2 标签段**（见第三节），因此**已不再是逐字节一致** |

上游的两张形象图 `assets/DSniang1.png`（610×610）与 `assets/DSniang02.png`（1026×1026）**画面内容原样保留**，仅重新编码为 WebP 后随包分发（见本节第 4 小节），本地文件为 `public/whale/DSniang1.webp`（挂件默认形象）与 `DSniang02.webp`（备用形象）—— 分辨率与像素内容未改，但**已不再是逐字节一致**。

上游 `assets/` 里的 `DSH2.png`、`bubble-money1.gif`、`minecraft-exp-orb.wav`、`task-end-a.wav` **未随本插件分发**。

据上游的 [PROVENANCE.md](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/main/PROVENANCE.md)：这些素材由上游维护者提供或使用 AI 工具生成，按 as-is 随插件分发，上游同样声明其不在 MIT 覆盖范围内。

### 2. 上游开发者的其余素材（未收录于上游仓库）

`public/whale/` 下另有 11 张内置形象。据本项目维护者说明，它们同为**上游开发者**的素材，但**上游仓库没有收录** —— 已核对上游 `main` 的完整文件树（`truncated: false`）、全部 releases（v0.2.2–v0.3.2）以及上游用户名下的全部仓库，均无对应文件。

因此这些文件**不在上游仓库 MIT 的覆盖范围内**（上游自身即声明其素材不适用 MIT），随本插件按 as-is 分发，仅用于运行本插件；不声明为本项目原创，也不授予再许可，同样适用第四节的 Takedown 承诺。

| 文件 | 尺寸 | 说明 |
|---|---|---|
| `liuy.webp` / `Jian.webp` / `无稽之谈改.webp` | 1254×1254 | 原图 2048×2048；挂件极端显示上限约 929 CSS px，2048 用不上，故等比缩到 1254×1254 后重存 |
| `DSniang3.webp` / `DSniang4.webp` / `DSniang7.webp` / `black.webp` | 1254×1254 | 其中 `black.webp` 是内置形象 `DSniang1` 的同构图暗色变体 |
| `DSniang5.webp` / `DSniang6.webp` | 1254×1254 | `DSniang5.webp` 是 `DSniang1.webp` 的插值放大版，`DSniang6.webp` 是纯黑剪影（保留仅为可选数量） |
| `ciya.webp` / `glby.webp` | 610×610 | `ciya.webp` 与 `DSniang1.webp` 为同一张图（已按像素比对，平均绝对差 0.65） |

以上「重复 / 放大 / 剪影」的判定均来自逐像素比对，记录在此是为了说明这些文件并非独立素材，而不是缺陷。

> 说明：这些文件的**文件名**沿用它们在本项目中的原始命名（`DSniang3`–`DSniang7` 承接第一节的上游形象序号，其余为素材原名），并非上游仓库中的文件名 —— 上游未收录它们，也就没有对应的上游文件名可比对。

### 3. 本项目生成

| 文件 | 说明 |
|---|---|
| `public/logo.png`（256×256） | uTools 插件列表图标：由 `DSniang1`（现为 `DSniang1.webp`）**等比缩放**而来（高质量重采样，已按像素比对核对） |

### 4. 格式与压缩（第 1–2 小节的 13 张内置形象图）

这 13 张形象图随包时统一为 **WebP（有损，质量 90，带 alpha 通道）**。原为 PNG，13 张合计 **10.8 MB，占插件包体积的 94%**（插件包总体积因此达 11.5 MB）；转 WebP 后合计约 **1.0 MB**。

转换只改编码方式：**分辨率、宽高比与透明通道逐张核对与转换前一致**（尺寸见上表），画面内容与构图未作任何改动。因此这不影响任何素材的来源与权利归属 —— 上表与第 1 小节的对应关系依旧成立，只是第 1 小节里那两张形象图不再与上游「逐字节一致」。

形象 id 不含扩展名（`BUILTIN_SKINS` 里的 id 即文件名主干），故换格式**未改动任何配置字段**，老用户的 `config.skin` 照常生效。

## 三、元数据清理

随包素材**不留内嵌元数据**，现状经解析核对：

- **WebP**（`public/whale/` 下 13 张形象图）：只有渲染必需的 `VP8X` / `ALPH` / `VP8` 三种块，没有 `EXIF` / `XMP ` / `ICCP` 这类元数据块（编码时未写入任何元数据，已逐文件解析块序列核对）。
- **PNG**（`public/logo.png`）：只有渲染必需的 `IHDR` / `pHYs` / `IDAT` / `IEND`，没有 `eXIf` / `iTXt` / `tEXt` / `zTXt` 这类文本与归属块（上游自 0.3.1 起已剥离文本与归属块，本项目沿用此口径）。
- **GIF**（`rua.gif`）：无 XMP / 注释块。
- **MP3**（四个音效）：原先带 ID3v2.3 标签 —— `D1.mp3` / `D2.mp3` 为 `TXXX: Packed by Bilibili XCoder v2.0.2`，`Ya1.mp3` 为 `TXXX: 13367393`。**本项目已剥离**：只切掉 ID3 标签段，不重编码、不动音频帧数据，因此音质与时长完全不变；现在四个文件都是裸 MPEG 帧流，不含任何标签。

复核方式：解析 PNG 与 WebP 的块序列、扫描 MP3 文件头与尾部标签，确认无残留文本块。

## 四、权利主张 / Takedown

如果你认为上述素材侵犯了你的权利，请在本仓库开一条 issue，说明**文件名**与**依据**，我们会在核实后**立即替换或移除**，不附加其它条件。也欢迎直接提供可自由再分发的替代素材。

需要干净授权时不必改代码：设置页「资源」Tab 支持导入自定义形象、气泡图与音效（导入的素材落在 `userData/whale-*/`，与插件包内的素材无关）。
