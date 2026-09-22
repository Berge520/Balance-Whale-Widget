# dsh 只读诊断 · 实施计划书

> 状态：**阶段一、阶段二均已落地验收（2026-09-22）** · 原定稿 v1.5 · 目标读者：项目作者
> **性质（D8 改判后）**：本文**长期保留**，是「决策依据与留档」文档 —— 写**为什么这么定**，不写"是什么"。现行为「是什么」见 `docs/whale-widget-spec.md`。
> 两份文档**必须同步、不得矛盾**；若代码与本文冲突，**以代码 + spec 为准**，并回头改本文。
> 本文只覆盖**阶段一（只读诊断）**与**阶段二（一次性 CLI 读取）的保留计划**；阶段三写入类**不在本文交付范围**（见 §6）。
>
> 事实来源标注：**[实测]** = 本机跑过 / 读过真实文件 · **[文档]** = `dsh-CLI-功能参考.md` / `dsh-utools-插件设计方案.md` · **[社区]** = dsh-recovery 等第三方项目 · **[推测]** = 尚未验证

---

## 决策已定（作者批复，2026-09-22）

| # | 议题 | **决定** |
|---|---|---|
| D1 | 阶段一检查项范围 | **C1–C5 五项必做**；C6 / C7 / C8 **不纳入本期** |
| D2 | 阶段三（写入与恢复） | **整体延后**，须先过 §6.1 的 V1–V4 验证清单才启动 |
| D3 | 设置页落点 | **新增第 4 张卡**（「开发者」tab 内，与现有三张同构） |
| D4 | 阶段二定位 | **保留计划，排在阶段一之后**；需先补 macOS/Linux 登录 shell 兜底 |
| D5 | ~~IPC 通道~~ | ~~**新通道** `whale:dsh-diagnose`（不复用 `whale:dsh`）~~ → **作废（D14 改判）**，见 D14 |
| D6 | 缓存重扫时机 | **60s TTL + 手动 `force`** |
| D7 | E5（`--port 0` 自动换端口） | **单独排期，不进本期** |
| D8 | 本文去向 | ~~定稿后并入 spec 并删除本文~~ → **作废（2026-09-22 作者改判）：保留本文，不删除**。见下方说明 |
| D9 | 依赖与 YAML 处理 | **零新 npm 依赖**；YAML **只做行级字符串操作** |
| D10 | C1 `duplicate-modules` 检测口径 | **两层判定**：先查 `package.json` 的 `dependencies` 是否声明 `@deepseek-ai/*`，再比对 realpath。两层都命中 = `error`；仅命中第一层 = `warn`。**避免 pnpm 正常符号链接误报** |
| D11 | dsh 未安装时的返回形状 | **`ok:false` + `installed:false`**，`results` 为空数组；UI 据此渲染空态，**不写缓存** |
| D12 | 结果项排序与明细截断 | **按 `severity` 倒序**；每项明细**最多 5 行**，超出显示 `还有 N 项`；完整内容由「复制诊断信息」兜底 |
| D13 | 单测覆盖范围 | **只测可注入的纯函数**：C3 行级扫描、`severity`→标记映射、`ctx` 组装。C1/C2/C4/C5 留给 §10.3 手工验证 |
| D14 | 诊断结果的通信方式 | **走 `settings.js` 宿主 API，不新增 IPC 通道**。原 D5「新开 `whale:dsh-diagnose`」**作废** |
| D15 | C5 端口状态的读法 | **只调已导出的 `probePort(cb)`，再读 `snapshot()`**；不改 `dsh.js` 的导出面 |
| D16 | `dshHome()` 的归属 | ~~提取到中立共享位置~~ → **升级为 D18**（范围扩大，不再只提 `dshHome()`） |
| D17 | 阶段一开工范围 | **C1–C5 五项全做，C1 保留两层判据**（确认 D1/D10 不变） |
| D18 | 复用范围 | **一次性提取全部已有重复**，而非只为诊断提取 `dshHome()`。见 §3.5.1 |
| D19 | 共享模块落点 | **新建独立纯工具模块** `public/preload/lib/util.js`（不并入 `constants.js` / `log.js`） |
| D20 | 一并提取的工具 | `homeDir` / `dayKeyFromTs` / `dayAdd` / `num` / `readTextSafe` / `walkDir` / `normalizePath` 七项 |
| D21 | `util.js` 的依赖边界 | **硬禁令**：禁止 `require('./log')` / `require('utools')` / 禁止定义任何需跨文件同步的常量。理由见 §3.5.1「依赖边界」小节 |
| D22 | `homeDir()` 合并口径 | **保守**：只统一「env → fallback → `existsSync` 探测」骨架；`~` 展开与相对路径解析作为**可选参数**，`dshHome` 传 `true`、`codexHome` 传 `false`，**严格保持两者原行为** |
| D23 | `readTextSafe()` 的错误处理 | **分流**：`ENOENT` 属预期分支静默返回；**其他错误 `logErr` 留痕并回报原因**，不静默吞掉 |
| D24 | §2.2 表述修正 | 「本期无遍历大目录风险」的表述**错误**——C1 本身要遍历 `node_modules`。改为「无 C7 那种全 `$DSH_HOME` 体检式遍历」 |
| D25 | **C1 判据换为身份指纹**（**稳定优先**） | 放弃 `realpath` 字符串比对，改为比对包的 **`package.json` 的 `name` + `version`** —— 指纹相同即「同一包装了两遍」。理由：`realpathSync` 不归一化大小写，在 Windows/macOS **静默漏报**，且 macOS「保留大小写」原理上无法靠字符串归一化解决。见 §3.3.1 |
| D26 | **C5 降级为「尽力而为」**（**稳定优先**） | 依赖 `tasklist`/`ps` 两套逻辑 + 进程名反推，是本期**唯一真正有平台风险**的项。探测失败/超时 → 报 `warning` 并附 `reason`，**不影响其余四项**，且**不得让整轮 `ok:false`**。见 §3.3.2 |
| D27 | **阶段一内部按梯队实现** | 第一梯队 C2/C3/C4（纯文件+行级字符串，零平台语义）→ 第二梯队 C1（指纹判据）→ 第三梯队 C5（尽力而为）。稳的先落地 |

**关于 D8 改判的说明（2026-09-22）**：原决定是「并入 spec 后删除本文」，作者改判为**保留本文**。因此本文从「一次性计划书」转为**长期留存的决策依据文档**，与 `docs/whale-widget-spec.md` 分工如下：

| 文档 | 定位 | 谁看 |
|---|---|---|
| `docs/whale-widget-spec.md` | **现行规格** —— 只写「是什么」（IPC 形状、存储键、UI 落点），不写理由 | 改代码前必读 |
| 本文 | **决策依据与留档** —— 只写「为什么这么定」（D1–D13 的理由、平台差异实测、外部方案纠错、排除项判据） | 想推翻某个决定前必读 |

**维护约定（重要）**：两份文档**必须同步**，且**不允许出现矛盾表述**。落地后若代码与本文冲突，**以代码 + spec 为准**，并立即回头改本文 —— 本文不再是"计划"，而是"决策记录"，过期即失效。阶段一完成后，§3 的「本期开工」状态需改为实际状态，§7 的节奏表同步更新。

---

## 0. 背景与结论摘要

### 0.1 问题定义

dsh（DeepSeek Harness）的 Cordis 插件加载是 **all-or-nothing**：任何插件 import 失败 / apply 抛错 / 依赖缺失，整个 dsh 起不来，fail-loud 退出 **[文档]**。官方 0.1.5 启动器只路由 `web` / `plugin` 两个子命令，**没有 `--safe-mode` 之类的启动开关**，且历史上的 `dsh doctor` 是本地打补丁、升级即被冲掉 **[社区]**。

因此用户当前的处境是：**"dsh 起不来" = 必须切终端手动排查**。

本项目的差异化价值：把这件事变成 **面板内可诊断、可隔离、可恢复的闭环**，且**不离开 uTools**。

### 0.2 本项目当前已覆盖的范围

| 位置 | 已有能力 |
|---|---|
| 悬浮窗菜单 `dsh` 分组 | 启动 / 重启 / 结束 / 更新 + 打开页面 + 状态行 + 最近命令 |
| 设置页「开发者」tab · dsh 卡 | 进程状态 / pid / 端口 / 版本与来源 / 日志 / 8 个操作 / 高级选项 |
| 设置页「开发者」tab · dsh 用量统计卡 | 31 天柱状图 / 各模型 / 余额快照 / 花费 |
| 设置页「开发者」tab · Codex 统计卡 | Codex 本地会话统计 |

**空白区**：profile 结构、bundle 清单、patch 分层、参数/报错/退出码速查、**故障诊断与恢复**。

### 0.3 本计划书的核心判断

1. **只读诊断（doctor）是本项目最该做、风险最低、三平台零差异的一块** —— 它复用已有 `lib/dsh.js` 的基础设施，不改动任何现有启动逻辑。
2. **写入类能力（安全模式 / 禁用 / 回滚）必须先验证 `disabled: true` 对 bundle 条目是否生效**，未验证前不动手。这是本计划书把写入排在后面的唯一原因。
3. **不引入新 npm 依赖**。YAML 只做**行级字符串操作**，绝不全量 parse→serialize（会破坏 `!!js` 表达式与注释）。

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 验收标准 |
|---|---|---|
| G1 | dsh 起不来时，面板内能给出**具体病因** | 至少覆盖「重复模块」与「patch 条目缺失」两类真实病因 |
| G2 | 诊断**不依赖 dsh 正在运行** | dsh 完全没启动时，诊断仍能出结果 |
| G3 | 诊断**只读、零副作用** | 诊断过程不写任何文件（含不写日志以外的存储） |
| G4 | 三平台一致，**Windows 必须可用** | Windows 实测通过；macOS/Linux 走同一代码路径，无平台分支 |
| G5 | 结果可一键复制去提 issue | 一处按钮产出含 Node/dsh 版本、端口、profile、错误文本的完整快照 |
| G6 | 诊断逻辑可独立测试 | `test/*.test.mjs` 里能纯函数测试，不需要 uTools |

### 1.2 非目标（本期明确不做）

| 不做 | 原因 |
|---|---|
| C6 `node_modules` 完整性 / C7 `$DSH_HOME` 目录体检 / C8 启动日志解析 | **D1 决定不纳入本期**。C1–C5 已覆盖两类真实病因；C6–C8 留待阶段一跑顺后按需追加（§11 列为可选后续） |
| 会话浏览 / 检索 | `sessions/*.jsonl.zstd` 是 **zstd 压缩**，Node 无内置解压 **[实测]**；社区 TUI 也是解自有格式而非原文件 |
| headless 任务运行器 | 会**真实计费**（需 API key） |
| 自动修改 `cordis.patch.yml` | **D2 决定整体延后**，见 §6 |
| 二分定位元凶 | 交互成本极高（每轮要用户手动启一次并回答 y/n），且"自动探活成功 ≠ 该插件健康" |
| E5 自动换端口（`--port 0`） | **D7 决定单独排期**。它要改现有启动参数链与就绪判定，与诊断无关，混在一起有回归风险 |
| 新增 uTools 指令 / 视图 | 本项目是「挂件插件单指令 + 设置页 tab」，不另开 `dsh`/`dsh执行`/`dsh插件` 等多指令（外部设计稿的五视图方案不适用本项目架构） |
| 引入 `js-yaml` / `yaml` 等依赖 | **D9 决定零新依赖**，见 §5.3 |
| 改动现有启动/停止逻辑 | 本期纯增量，G1–G6 均不要求改 `dsh.js` 的进程路径 |

---

## 2. 平台可行性矩阵（这是本计划书的硬约束）

### 2.1 四处真实的平台差异

| # | 差异点 | Windows | macOS / Linux | 本计划书的处理 |
|---|---|---|---|---|
| P1 | **定位 node 可执行文件** | `resolveNode()` 已覆盖：PATH + 常见目录 + nvm-windows + 自定义 prefix **[实测]** | ⚠️ **GUI 进程不加载 `~/.zshrc`/`~/.bash_profile`**，PATH 里可能没有 node；需要登录 shell 兜底 `spawn($SHELL, ['-i','-c','command -v node'])` **[文档]** | 现有 `resolveNode()` **不做** `-i -c` 兜底。本计划的 P0 项**不依赖 node 可执行文件**（纯 fs），故不受影响；一旦做 P1 项（需 spawn），**必须先补这个兜底** |
| P2 | **命令输出编码** | 中文系统命令输出可能是 GBK **[实测]** | UTF-8 | 复用现有 `decodeOut(buf)`：先按 utf8 试，出现 `\uFFFD` 再 `TextDecoder('gbk')` |
| P3 | **目录可写性判定** | `fs.access W_OK` **不校验 ACL**，会误判可写 **[实测]** | `W_OK` 正确 | 复用现有 `canWriteDir(dir)`：mkdtemp 试建再删 |
| P4 | **spawn 包装脚本** | ❌ 禁止 spawn `dsh.cmd`（需 `shell:true` + 转义噩梦）/ `dsh.ps1`（执行策略）**[实测]** | `dsh` 含 cygwin 路径转换风险 **[文档]** | **统一公式**：`spawn(node, [binJs绝对路径, ...args])`。本项目 `lib/dsh.js` 已走这条路 |

### 2.2 结论

- §3 的 **C2/C3/C4**（第一梯队）是**纯文本文件读取 + 行级字符串处理** → **零平台语义依赖、无平台分支、无 spawn、三平台行为完全一致**。
- §3 的 **C1**（第二梯队）纯读文件，判据已换为**包身份指纹**（D25）→ 不再依赖 `realpath` 的跨平台路径语义。
- §3 的 **C5**（第三梯队）依赖 `tasklist`/`ps` 两套逻辑 + 进程名反推 → **本期唯一真正有平台风险的项**，已按 D26 降级为「尽力而为」：失败只报 `warning`，不给错误结论、不阻塞其余检查。
- §4 的 P1 项需要 spawn 一次性 CLI → 走 §2.1 的统一公式，**但需先补 P1 项的登录 shell 兜底**（§4.1）。
- 本计划书**不引入任何新的平台判断分支**（不新增 `if (WIN)`）。
- **D1 已排除 C6–C8**，故本期无 **C7 那种全 `$DSH_HOME` 体检式**遍历，也无「解析未知格式日志」的风险项（C8 已排除）。
  > ⚠️ **但这是有限度的**：**C1 本身就要遍历 profile 的 `node_modules`**（`profiles/<n>/node_modules` 与全局 dsh 树），这是本期唯一的目录遍历来源。它范围可控（只扫 `@deepseek-ai/*` 一层深度），但**不是零遍历** —— 故 `util.js` 的 `walkDir` 必须带深度上限（§3.5.1）。

---

## 3. 阶段一：只读诊断（**已落地验收**）

### 3.1 交付物

| 交付物 | 文件 | 说明 |
|---|---|---|
| **共享工具** | `public/preload/lib/util.js`（**新建**） | 七项工具函数（D18/D19/D20，见 §3.5.1）：消除 `dsh-usage.js` 与 `codex.js` 之间已有的重复 |
| 诊断引擎 | `public/preload/lib/diagnostics.js`（新建，CommonJS） | check 契约 + 5 个检查项 + `diagnose()` 聚合 |
| **宿主 API** | `public/preload/lib/settings.js`（改） | **新增 `diagnoseDsh()` / `clearDshDiagnoseCache()`**（D14：这是设置页真正的 API 出口，与既有 `dshUsageSummary()` 同文件、同构） |
| 类型声明 | `src/types/services.d.ts`（改） | 新增 `DshDiagnoseResult` 等 interface |
| 设置页卡片 | `src/App.vue`（改） | 「开发者」tab 第 4 张卡：dsh 诊断 |
| 存储键 | `public/preload/lib/constants.js`（改） | 新增诊断结果缓存键（见 §3.5） |
| 单测 | `test/diagnostics.test.mjs`（新建） | **只测可注入的纯函数**（见 §3.2 末段） |
| **单测** | `test/util.test.mjs`（**新建**） | `util.js` 的纯函数（`dayKeyFromTs`/`dayAdd`/`num`/`normalizePath`）。⚠️**不得依赖 `globalThis.utools` 桩**（D21） |
| 规格同步 | `docs/whale-widget-spec.md`（改） | 第二节架构 + 第六节存储键 + 第十节设置页 |

**需要改动的现有稳定模块**（D18 的代价，见 §3.5.1）：

| 文件 | 改动 |
|---|---|
| `public/preload/lib/dsh-usage.js` | 删本地 `num`/`dayKeyFromTs`/`dayAdd`/`dshHome`，改引 `util.js`；导出面保留 |
| `public/preload/lib/codex.js` | 删本地 `dayKeyFromTs`/`dayAdd`/`codexHome`，`walk` 改引 `walkDir`；导出面保留 |

**不需要改动的文件**（D14 的直接收益）：

| 文件 | 为何不用改 |
|---|---|
| `public/preload/lib/ipc.js` | 不新增 IPC 通道。现有 `whale:dsh` 两处都是**悬浮窗**方向路由，与诊断无关 |
| `public/preload/services.js` | 它只做装配（`window.services`、`registerIpc()`、生命周期）；宿主 API 的实现在 `lib/settings.js`（既有惯例） |
| `public/preload/lib/dsh.js` | 只调已导出的 `probePort` / `snapshot`，**不动导出面**（D15） |

> 说明：诊断逻辑**必须**放 `public/preload/lib/diagnostics.js` —— 设置页（`src/App.vue`）跑在渲染进程，**拿不到 `fs`**；文件系统能力只在 preload。外部方案建议的「诊断逻辑放 `src/diagnostics/` 走 Vite HMR」在本项目架构下**不可行**。

### 3.2 Check 契约（照 dsh-recovery 的成熟做法，零新依赖）

```js
// 每个检查项：detect 只读，绝不写入
// { id, title, severity, fixable, detect(ctx) -> Finding }
// Finding = { ok, summary, detail?, findings?: [{level, text, hint?}] }
// level ∈ 'ok' | 'warn' | 'error'
```

约定（照搬社区已验证的规则）：

1. `detect` **绝不写入**任何文件。
2. **单项抛错不算整体失败** —— 捕获后把该项标记为 `error` 并附 `err.message`，其余项继续。
3. `severity` ∈ `'critical'`（起不来）/ `'warning'`（能起来但有隐患）。
4. `fixable` 本期恒为 `false`（阶段一不提供修复）。

**可测边界（D13 已定）**：诊断引擎读的是本机真实 `$DSH_HOME` 与真实进程，单测里不可直接跑。因此把下列逻辑做成**接受入参的纯函数**并导出（供 `test/diagnostics.test.mjs` 直接喂样例）：

| 纯函数 | 入参 | 出参 | 用途 |
|---|---|---|---|
| `scanPatchLines(text)` | YAML 文本字符串 | `Finding[]` | C3 行级扫描（缩进跳变 / `- id:` 缺值 / `!!js` 截断 / 重复 id） |
| `markOf(result)` | 单个 `Finding` | `'[✓]'` / `'[!]'` / `'[✗]'` | `severity` → 标记映射（§3.6 表） |
| `buildContext(input)` | 已解析好的路径/版本/端口对象 | `ctx` | `ctx` 组装，让 C1–C5 的 `detect(ctx)` 可脱离真实环境被调用 |
| `orderResults(results)` | `Finding[]` | 排序后 `Finding[]` | 按 `severity` 倒序（D12） |

**`util.js` 亦纳入单测**（D18 的额外收益）—— 提取出来的函数里，`dayKeyFromTs` / `dayAdd` / `num` / `normalizePath` 都是纯函数，可脱离文件系统直接喂样例。**尤其 `normalizePath` 必须有测试**：Windows 大小写不敏感、尾部分隔符、`..` 未展开、混合分隔符这几种输入若不测，C1 的 realpath 比对会在某个平台静默失效（比错路径却不报错）。

C1 / C2 / C4 / C5 **不做单测** —— 它们依赖真实文件系统与进程，交给 §10.3 手工验证（与现有 `test/*.test.mjs` 的粒度一致：只测不含 IO 的逻辑）。

### 3.3 首批 5 个检查项（**本期范围，D1 确认；按 D25/D26 分梯队**）

**排序原则（D25）**：按「三平台行为一致性的确定程度」分梯队排 —— **纯文件读取 + 行级字符串处理**最稳，依赖**进程/路径语义**的最不稳。实现顺序按梯队走，稳的先落地。

| 梯队 | 项 | 稳定性依据 |
|---|---|---|
| **第一梯队** | C2 / C3 / C4 | 纯读文本文件 + 行级字符串处理，**零平台语义依赖**，三平台行为完全一致 |
| **第二梯队** | C1（改用 `name+version` 指纹判据，见下） | 纯读文件；判据换成包身份指纹后，**不再依赖 `realpath` 的跨平台路径语义** |
| **第三梯队** | C5（**降级为"尽力而为"**，见 D26） | 依赖 `tasklist`/`ps` **两套不同解析逻辑** + 进程名反推，是本期**唯一真正有平台风险**的项 |

| # | id | 检测什么 | 判据 / 依据 | 平台 | 证据强度 |
|---|---|---|---|---|---|
| C1 | `duplicate-modules` | profile 的 `node_modules/@deepseek-ai/*` 与全局 dsh 树**不是同一份** → 装出**第二份 cordis** → 路径身份分裂 → `prompt section "deployment:persona" is already registered`，所有 preset 挂载失败。**每次升级全局 dsh 都会重现** | **两层判定（D10 + D25）**：① 查 `profiles/<n>/package.json` 的 `dependencies` 是否声明 `@deepseek-ai/*`；② **比对该包的「身份指纹」= `package.json` 的 `name` + `version`** —— 两份指纹相同即视为「同一包装了两遍」。两层都命中 = `error`；仅①命中 = `warn` | W M L | **[社区]** dsh-recovery 头号病因 |
| C2 | `patch-entry-missing` | `cordis.patch.yml` 里 `- id: X` 在组装树中不存在 | 本机已实测该报错原文：`patch: entry "config-manager" not found` | W M L | **[实测]** |
| C3 | `patch-syntax` | `cordis.patch.yml` **行级**结构异常（缩进跳变、`- id:` 缺值、`!!js` 被截断、重复 id） | 只做行级扫描，不 parse（见 §5.3） | W M L | **[文档]** |
| C4 | `settings-yaml` | `$DSH_HOME/settings.yaml` 是否可解析 | 本机 `settings.yaml` 488B，含 `agent-default-model` 等 **[实测]** | W M L | **[社区]** |
| C5 | `port-3080` | 3080 是否被**非 dsh** 进程占用 / 是否已有 dsh 在跑 | **只调已导出的 `probePort(cb)`，回调里再读 `snapshot()`**（D15）。⚠️ `parsePortPid` / `processName` / `isDshName` **均未从 `dsh.js` 导出**，不可直接调用；且 `probePort` 内部有**全局单例缓存 + `busy` 标志**，与状态卡共用，**不可并发**，诊断须串行排队 | W M L | **[实测]** 复用已导出接口，不改 `dsh.js` 导出面 |

#### 3.3.1 C1 判据改用身份指纹（**D25：稳定优先**）

> **为何放弃 `realpath` 字符串比对**：原判据是「比对 `fs.realpathSync` 后的目录是否落在全局 dsh 树内」。**该判据在 Windows / macOS 上会静默失效**（漏报，而非报错）：
>
> | 平台 | `realpath` 的不稳来源 |
> |---|---|
> | **Windows** | 路径**大小写不敏感**（`C:\Users` 与 `c:\users` 同一路径，但字符串不等）；`\` 与 `/` 混用；NTFS 有 **junction / symlink 两种链接**，`realpath` 对二者行为不同；盘符可能有 8.3 短名（`PROGRA~1`） |
> | **macOS** | APFS **大小写不敏感但保留大小写** —— `realpath` 返回**原始大小写**，同一文件经由不同大小写路径进来得到不同字符串（**此问题无法靠字符串归一化解决**）；`/tmp` 实为 `/private/tmp` |
> | **Linux** | 相对最稳（大小写敏感），但 `/home` 可能是挂载点或 symlink；容器/CI 里 `node_modules` 常为符号链接 |
>
> **关键**：`fs.realpathSync` **不归一化大小写**。靠 `normalizePath()` 做字符串处理是**下策** —— 需穷举大小写规则、分隔符、短名、junction 语义，且 macOS「保留大小写」这一项**从原理上无法用字符串解决**。

**改用判据（方案 A）**：读目标包的 `package.json`，取 `name` + `version` 作为**身份指纹**；两份指纹相同 → 认定「同一包装了两遍」。

| 对比项 | 原方案（realpath 字符串） | 新方案（身份指纹） |
|---|---|---|
| 依赖 | 路径语义（平台差异大） | **纯读文件**（跨平台一致） |
| macOS 保留大小写 | ❌ 无法解决 | ✅ 不受影响 |
| Windows 大小写 / junction / 短名 | ❌ 需逐一处理 | ✅ 不受影响 |
| 失效模式 | **静默漏报** | 无此类失效 |
| 代价 | — | 无法区分「两份完全相同版本的合法安装」（**罕见且报出无害**） |

**`normalizePath` 因此降级**：不再承担 C1 的核心判据，仅用于**日志/明细展示时统一路径外观**。R9 的风险等级随之下降（不再可能导致 C1 漏报）。

#### 3.3.2 C5 降级为「尽力而为」（**D26：稳定优先**）

C5 的依赖链是 `probePort` → 读端口占用 PID → `processName(pid)` → `isDshName()`。这条链**是本期唯一真正跨平台不稳的**：

| 环节 | 平台差异 |
|---|---|
| `psExe()` | Windows 走 `tasklist`，macOS/Linux 走 `ps` —— **两套完全不同的解析逻辑** |
| `processName` 输出格式 | Windows `node.exe` / macOS `node` / Linux `node` —— 格式不同 |
| 「是不是 dsh」反推 | 需从 `node.exe` 反推命令行：**macOS/Linux 要读 `/proc` 或 `ps -o command=`，权限受限时拿不到** |

**降级规则**：

| 场景 | 输出 | 是否影响其余四项 |
|---|---|---|
| 成功判定端口归属 | 正常 `ok` / `warning` / `error` | — |
| **探测失败 / 无法判定归属** | 报 `warning`「**无法判定 3080 端口归属**」，附 `reason` | **不影响** —— 其余四项照常出结论 |
| 超时 | 同上，附超时说明 | **不影响** |

**设计意图**：降级后 C5 即使在某平台失效，**给不出结论，但绝不给错误结论**，且不阻塞其他检查。这比"强行判定、给出错误归属"更符合稳定优先。

> ⚠️ 连带约束：C5 的失败**不得让整轮诊断 `ok:false`**。整轮结论只看第一/二梯队是否存在 `error` 级 finding。

#### 3.3.3 已排除、留作可选后续（D1）

以下三项**本期不做**，写在这里是为了保留判据与实测结论，避免后续重新调研：

| # | id | 检测什么 | 为何排除 / 备注 |
|---|---|---|---|
| ~~C6~~ | `node-modules-integrity` | profile `node_modules` 里的坏符号链接、依赖缺失 | C1 已覆盖"身份分裂"这个主要形态，C6 偏细节；本机 `profiles/` 下有 `node_modules` 与 `pnpm-workspace.yaml` **[实测]** |
| ~~C7~~ | `home-layout` | `$DSH_HOME` 目录体检（`.env`/`cordis.patch.yml`/`cache`/`sessions`/`profiles`/`storages` 存在性与体量） | 偏"信息展示"而非"故障诊断"，更适合与阶段二的配置卡片合并做。本机顶层 13 个产物目录；`storages/cost-meter/ledger.json` 达 **141KB** **[实测]** |
| ~~C8~~ | `startup-log` | 解析 `$DSH_HOME/logs/startup-*.log` 最近 N 条失败 | ⚠️ **本机 `~/.dsh/logs` 不存在**（无失败记录），无法实测验证解析逻辑 **[实测]**。若后续纳入，**必须优雅降级**：目录缺失时该项为 `ok` 而非 `error`） |

### 3.4 宿主 API（**D14 确认：不加 IPC 通道**）

> ⚠️ **本节曾按「新开 `whale:dsh-diagnose` IPC 通道」写（原 D5），已作废。**
> 作废理由（核查结论，留档以免后续重新走错）：本项目现有 dsh 用量统计、Codex 统计**根本不走 IPC**，而是在 `public/preload/lib/settings.js` 里以**宿主 API 直接返回**（`dshUsageSummary()` / `codexSummary()`），设置页在 `src/App.vue` 里 `services.dshUsageSummary?.()` 同步调用，无事件监听、无双向回推。诊断是**纯设置页功能**，悬浮窗不需要该数据，因此与它们保持同构即可。原 D5 那段「为何不复用 `whale:dsh`」的论证**建立在错误前提上** —— 真正结论是「诊断根本不需要 IPC」。

新增宿主 API（挂在 `window.services`，实现放 `public/preload/lib/settings.js`）：

```ts
diagnoseDsh(opts?: { force?: boolean }): Promise<DshDiagnoseResult>
clearDshDiagnoseCache(): void
```

**不新增任何 IPC 通道**。`ipc.js` 无需改动 —— 现有 `whale:dsh` 两处都是**悬浮窗**方向的路由（`sendToWidget`），与诊断无关。

> ⚠️ **`diagnoseDsh()` 是唯一异步的宿主 API（必须返回 Promise），这一点与 `dshUsageSummary()` / `codexSummary()` 不同，不要「顺手统一」成同步返回。**
>
> 原因（**实测踩坑留档**）：C5 端口探测走 `probePort()` 的 `execFile` 回调，本质异步。若宿主在 `diagnoseDsh()` 里同步等结果，调用就发生在**设置页所在的渲染进程**里（`window.services` 是 preload 注入的同进程同步对象），会把消息循环整个占住 —— 表现就是**诊断卡在「诊断中…」，整个设置页卡顿到无法使用**。`detectPort()` 的 8s 兜底同理：回调一旦不回来，「同步等」就是永久阻塞。
>
> 两条硬约束：
> 1. **宿主侧**：Promise 必须保证「一定会 settle」。`detectPort` 的 8s 超时之外，`diagnoseDsh` 里另加 15s 兜底闸门（`settled` 标志 + `done()`），防止任何异常路径让 Promise 永久 pending —— 那样前端 `finally` 不执行，按钮永远退不出「诊断中…」。
> 2. **设置页侧**：必须 `p.then(...).catch(...).finally(...)` 取结果。**绝不能把返回的 Promise 直接当结果对象用**（读 `.error` / `.cached` 全是 `undefined`，结果永远渲染不出来），也不能用 `try/catch` 包同步调用 —— Promise 的 rejection 不会进 `catch` 块。

**返回值形状（D11 已定）**：

| 场景 | 返回 | `results` | 是否写缓存 |
|---|---|---|---|
| dsh 正常安装 | `{ ok:true, at, cached:false, pass, bad, results:[...], env:{...} }` | 5 项 | 是 |
| 命中 60s TTL 缓存 | 同上 + `cached:true` | 缓存里的 5 项 | 否（不重写） |
| 整轮失败 / 超时兜底 | `{ ok:false, at, cached:false, pass:0, bad:0, results:[], env:null, error:'...' }` | **空数组** | 否 |
| 单项 `detect` 抛错 | `ok` 不变，该项 `threw:true` + 附 `err.message`（§3.2 约定 2） | 5 项 | 是 |

> `env` 在「读环境失败 / 超时兜底」时为 `null`，设置页按**「读不到」**渲染（`diagnoseEnvText()` 回「环境信息读取失败」），**不得当成「dsh 未安装」**。

### 3.5 存储与缓存（**D6 确认：60s TTL + 手动 force**）

| 介质 | 键（**已定**） | 内容 |
|---|---|---|
| `dbStorage` | `whale:dshDiagnose` | 诊断结果缓存 `{ at, home, results:[...] }` |

设计约束（照 `lib/dsh-usage.js` 已验证的模式）：

- **纯派生数据、不含任何凭据、不进备份**，可随时由「清除缓存并重扫」删除重建。
- **TTL 60s + `force` 绕过**：打开卡片时若 `Date.now() - at < 60_000` 直接返回缓存；超时或点「重新诊断」才重扫。遍历 `node_modules`（C1）与命令探测（C5）都不便宜，不加 TTL 会让每次开设置页都付一遍成本。
- `whale:dshDiagnose` 需加进 `constants.js` 的 `K` 表（与 `dshVersions` / `dshUsage` 并列）。
- 键名统一 `whale:` 前缀，**新增键必须同步 `docs/whale-widget-spec.md` 第六节**。
- **不建议挂进 `clearAllData` 的清理项**（纯派生数据，留着无害，清掉只换来一次重扫）。

#### 3.5.1 复用提取（**D18/D19/D20 确认：一次性提取全部已有重复**）

##### 复核发现：`lib/` 里已存在真实重复

写诊断时原计划只提 `dshHome()`（D16）。编码前复核发现重复**不止一处**：

| 重复项 | 现状 | 位置 |
|---|---|---|
| `dayKeyFromTs()` | **逐字相同的两份实现** | `dsh-usage.js` L30–34 · `codex.js` L33–37 |
| `dayAdd()` | **逐字相同的两份实现** | `dsh-usage.js` L36–40 · `codex.js` L39–43 |
| `num()` | 仅 `dsh-usage.js` 有，诊断也要用 | `dsh-usage.js` L25–28 |
| 目录定位 | `dshHome()` / `codexHome()` **同模式的两次复制**（前者多 `~` 展开与相对路径分支） | `dsh-usage.js` L45–60 · `codex.js` L46–52 |
| 目录递归 | `codex.js` 的 `walk(dir, depth)`（带深度上限、异常吞掉） | `codex.js` L71–80 |
| 安全读文件 | 「读失败返回默认值」的 pattern 各写一遍 | `dsh-usage.js` L75/L85 · `codex.js` L69 |

**判断**：若只为诊断提取 `dshHome()`，等于**在已有两处重复的基础上再叠一处引用关系**，而 `dayKeyFromTs`/`dayAdd` 的重复原样留下 —— 后续每次加数据源都会再复制一遍。因此**升级为一次性提取**（D18）。

##### 落点（**D19**）：新建 `public/preload/lib/util.js`

| 项 | 决定 |
|---|---|
| 文件 | `public/preload/lib/util.js`（新建，CommonJS） |
| 依赖 | **仅 `path` / `os` / `fs`**，零项目内部依赖 → 不可能产生循环引用，符合 `lib/` 单向依赖约定 |
| 为何不并入 `constants.js` | `constants` 语义是「常量」，放函数进去会混淆职责 |
| 为何不并入 `log.js` | `log` 语义是日志，放路径/日期工具同样职责不清 |

##### 提取清单（**D20**）

| 导出 | 来源 | 说明 |
|---|---|---|
| `homeDir(envKey, fallbackName, opts)` | 合并 `dshHome()` + `codexHome()` | **保守合并（D22）**：只统一「env 优先 → 否则 `~/<fallbackName>` → 逐个 `existsSync` 探测 → 都不存在返回 `''`」这个**共同骨架**。`~` 展开与相对路径解析做成 **可选参数**：`dshHome` 传 `{ expand:true }`、`codexHome` 传 `{ expand:false }`，**严格保持两者原行为** |
| `dayKeyFromTs(ts)` | 消除逐字重复 | 原样搬移，逻辑零变更 |
| `dayAdd(base, delta)` | 消除逐字重复 | 原样搬移，逻辑零变更 |
| `num(v)` | 复用已有 | 原样搬移 |
| `readTextSafe(file)` | 归纳既有 pattern | **错误分流（D23）**：`ENOENT` 属预期分支 → 静默返回 `''`；**其他错误（`EACCES`/`EISDIR` 等）→ `logErr` 留痕并回报原因**，不静默吞掉。见下方说明 |
| `walkDir(dir, opts)` | 提炼 `codex.js` 的 `walk` | 带深度上限、异常吞掉、可选文件名过滤；返回匹配路径数组 |
| `normalizePath(p)` | **新增**（非复用） | C1 比对 realpath 需要：Windows 大小写不敏感、尾部分隔符不一致的统一处理 |

> **为何 `readTextSafe` 必须分流（D23 补充说明）**：项目规则明确「空 `catch` 只允许用于**预期分支**，业务失败必须 `logErr` 留痕」。若 `readTextSafe` 内部 catch 后**一律静默返回 `''`**，那么「文件存在但权限不足」「路径其实是目录」这类**非预期**失败会被吃掉，调用方只看到"空内容"→ 诊断会报成「文件为空或缺失」，**错误归因错误**。
>
> 而诊断功能的**核心价值恰恰是「说清为什么读不到」**，不是笼统说"缺失"。因此 `readTextSafe` 的返回值设计为可携带原因（如 `{ ok:false, reason:'EACCES' }` 或等价形式），让 C2/C4 能把真实原因写进 `Finding`。

##### 依赖边界（**D21**：硬禁令）

`util.js` 必须保持**可被单测直接 `require`**。以下三条为硬禁令，实现时不得违反：

| 禁令 | 原因 |
|---|---|
| **禁止 `require('./log')`** | `log.js` 的 `DEV` 常量与 `write()` 依赖全局 `utools`；一旦引入，`test/util.test.mjs` 会在 `require` 阶段直接崩溃 |
| **禁止 `require('utools')` 或任何触碰全局 `utools` 的代码** | 同上。现有单测（如 `test/codex.test.mjs`）靠**先挂 `globalThis.utools` 桩**再 `require` 模块；`util.js` 设计目标是**连桩都不需要** |
| **禁止定义任何需跨文件同步的常量** | 构建期 `scripts/check-shared.mjs` 只扫描 `constants.js` 与 `store.js` 找跨文件副本。`util.js` **不在扫描范围**，若把 `WALK_MAX_DEPTH` 之类的常量放进来，副本不一致**不会被构建发现** |

> 简言之：`util.js` 只允许 `path` / `os` / `fs`。**违反 D21 的一个直接症状是「构建通过但单测在 require 阶段炸」**，排查成本高，故列为硬禁令而非建议。
>
> **附带动作**：交付物表需补 `test/util.test.mjs`（原表只列了 `test/diagnostics.test.mjs`，与 §3.2「`util.js` 亦纳入单测」矛盾，此处一并修正）。

##### 改动面与风险

| 文件 | 改动 |
|---|---|
| `public/preload/lib/util.js` | **新建** |
| `public/preload/lib/dsh-usage.js` | 删除本地 `num`/`dayKeyFromTs`/`dayAdd`/`dshHome` 实现，改 `require('./util')`；**导出面保留 `dshHome`**（`dshUsageSummary` 内部 L201 仍在用，且避免破坏既有调用方） |
| `public/preload/lib/codex.js` | 删除本地 `dayKeyFromTs`/`dayAdd`/`codexHome` 实现，`walk` 改为调用 `walkDir`；**导出面保留 `codexHome`** |
| `public/preload/lib/diagnostics.js` | 直接 `require('./util')` |

> ⚠️ **D18 的代价说清楚**：这是本期**对现有稳定模块的最大一次改动** —— 同时动 `dsh-usage.js` 与 `codex.js` 两个跑得好好的模块。收益是消除已有重复并避免后续第三次复制。
>
> **风险控制三条**：① 搬移的函数**逻辑零变更**（只换位置，不改行为）；② 保留原导出面，外部调用方无感；③ 现有 `test/*.test.mjs` 覆盖 store/api/pricing/codex/backup/hosts —— 改完**必须全绿**，且 §10.3 新增「用量统计回归」与「Codex 统计回归」两个必测场景。
>
> **若回归失败**：回滚 `util.js`，退回「`diagnostics.js` 自己实现一份」的方案（约 15 行重复，零回归风险）。这是一个明确的退路，不是开放式风险。

### 3.6 UI 落点（**D3 确认：新增第 4 张卡**）

「开发者」tab 新增第 4 张卡 **dsh 诊断**，与现有三张（dsh / dsh 用量统计 / Codex 会话统计）**同构**：

- 折叠头摘要：`N 项通过 · M 项异常`（全通过时 `全部通过`）
- 懒加载：**首次展开才跑诊断**（对齐现有 `toggleDevCard(key)` 的 `devStatsLoaded` 模式）
- 折叠态：沿用 `devFolds` 的 reactive 结构（新增 `diagnose: false`）

| 区域 | 内容 |
|---|---|
| 顶部按钮 | `重新诊断`（`force:true`）/ `复制诊断信息` |
| 结果列表 | 每项一行 `[✓] / [!] / [✗]` + 标题 + 摘要；问题明细缩进显示，**最多 5 行**，超出显示 `还有 N 项`（D12） |
| 底部 | 环境快照：Node 版本 / dsh 版本与来源 / profile / 端口状态 / `$DSH_HOME` |
| 空态 | dsh 未安装（`installed:false`）时给出明确文案，**不报错、不列检查项**（D11） |

**排序与截断（D12 已定）**：

- **排序：按 `severity` 倒序** —— `error` 级 finding 的项排最前，其次 `warn`，最后无 finding 的 `[✓]` 项。让用户第一眼看到重点，不必翻过一串通过项。
- **明细截断：每项最多 5 行**。C1 遍历 `node_modules` 可能产出几十行明细，不截断会把卡片撑爆。超出部分显示 `还有 N 项`，完整内容由顶部「复制诊断信息」按钮兜底（复制的是**未截断**的原始结果）。
- 截断只作用于**渲染**，不作用于 `whale:dshDiagnose` 缓存内容 —— 存的是完整结果，截断在 UI 层做（否则「复制诊断信息」拿到的也是被砍过的数据，兜底失效）。

**视觉约定**：

- 状态标记用**文本** `[✓] [!] [✗]`，不用 emoji / SVG —— 与项目现有视觉一致，且三平台字体都渲染。
- 结果行沿用现有卡片的排版变量，不新增全局 CSS。
- 长文本（如路径、报错原文）走现有 `<pre class="log-box">` 风格，可横向滚动。

**`severity` 到标记的映射**（避免"全是红灯"的噪音）：

| severity | 该轮结果 | 标记 |
|---|---|---|
| `critical` | 有 `error` 级 finding | `[✗]` |
| `warning` | 有 `warn` 级 finding | `[!]` |
| 任意 | 无 finding | `[✓]` |
| 任意 | `detect` 抛错 | `[✗]` + 附 `err.message`（§3.2 约定 2） |
| **`warning`** | **C5「无法判定端口归属」（D26 降级）** | **`[!]` + 附无法判定的原因** —— 显式区别于 `[✓]`（有结论：无事）与 `[✗]`（有结论：有问题） |

> 说明：**`critical` 与 `warning` 不决定"整轮失败"**，只决定单个检查项的标记强度。整轮结论由"是否存在 `error` 级 finding"决定，供折叠头摘要用。
>
> ⚠️ **D26 连带**：C5 的"无法判定"必须是 `warning` 而非 `error`，**且不得让整轮 `ok:false`**。UI 上要让用户看出这是"没查出来"，不是"查出来有问题" —— 这是稳定优先的核心体现。

---

## 4. 阶段二：一次性 CLI 读取（**D4 确认：保留计划，排在阶段一之后**）

### 4.1 前置条件（**必须先做**）

**必须先补 §2.1 的 P1 项**（macOS/Linux 登录 shell 兜底），否则这两个功能在 mac/Linux 上可能找不到 node。

原因：现有 `resolveNode()` 只探 PATH + 常见目录 **[实测]**，而 **macOS/Linux 的 GUI 进程不执行 `~/.zshrc` / `~/.bash_profile`** **[文档]**，PATH 里可能根本没有 node。Windows 侧 `resolveNode()` 已覆盖 nvm-windows 与自定义 prefix，**不受影响**。

建议做法：

```js
// 仅在 resolveNode() 全部探测失败时才走，且结果进 resolveCache
spawn(process.env.SHELL, ['-i', '-c', 'command -v node'], { timeout: 5000 })
```

注意：`-i`（交互模式）会加载用户 rc 文件，**这类 shell 可能很慢或输出无关噪声**（如欢迎语、nvm 提示），因此必须：① 只在兜底路径走；② 加 5s 超时；③ 从输出里**取最后一行**而非整段。

### 4.2 功能项

| # | 功能 | 数据源（均已实测可跑） | 说明 |
|---|---|---|---|
| D1 | **patch 五层分层可视化** | `node bin.js --profile <n> --dump-config` 输出的 `# == <来源>` 分节 | 五层：bundle → profile 用户层 → home 用户层 → `--patch` → 遥测。patch 按 id **整体替换**，不是深度合并 **[文档]** |
| D2 | **生效树 vs 默认树 diff** | `--dump-config` × `--dump-default-config` | 高亮「被用户层改过的条目」 |

### 4.3 约束

| 约束 | 说明 |
|---|---|
| 超时 | `--dump-config` 是短命进程，必须加超时（建议 8s）+ 只读缓存 |
| 编码 | 必须过 `decodeOut()`（Windows 中文系统 GBK）**[实测]** |
| `!!js` 表达式 | dump 输出里 `!!js` 表达式**原样打印不求值** **[文档]**，解析时不要试图求值 |
| 大小 | dump 输出可能很大 → 只解析到「条目级」，不整篇回传前端 |
| 缓存 | 同 §3.5 的 fingerprint + memo 模式 |
| 参数顺序 | `--profile <n> --dump-config`（本机实测这个顺序可用）；**不要**依赖位置参数缩写，见下 |

> **参数顺序踩坑**（本机实测）：`bin.js` 的 `expanded` 逻辑只在**第一个 token 不以 `-` 开头且不是 `plugin`** 时才补 `--profile`。因此 `dsh web --dump-config` 与 `dsh --profile web --dump-config` 都可能可用，但**只在启动模式生效**，`plugin` 子命令下不适用。为稳妥，本项目**一律显式写 `--profile <n>`**，不用缩写。

---

## 5. 关键技术决策（理由留档，避免后续被"顺手改掉"）

### 5.1 为什么诊断不能挂进 dsh 进程

README 明示：0.1.5 启动器只路由 `web` / `plugin`；历史上的 `dsh doctor` 是**本地打补丁**，升级即被冲掉 **[社区]**。→ 我们的诊断必须**自成一路**，且**不依赖 dsh 运行**（G2）。

### 5.2 为什么"安全模式"要降级

外部方案建议「一键给**所有**用户插件条目追加 `disabled: true`」。问题：

- 本机 `profiles/web` 有 **13 个 bundle + 9 个依赖** **[实测]**，全禁等于**把用户整个 profile 干掉**。
- `disabled: true` 对 **bundle 条目**是否生效，**我目前没有实测证据** **[推测]**。
- 是否触发 `patch: entry not found`，也未验证 **[推测]**。

**结论**：本期只做只读展示（把 `disabled` 现状渲染出来），**写入留到验证之后**。届时也建议降级为「**我的一键隔离**」——只操作用户选定的候选项，且写入前必须备份 + 明确列出将改动的行。

### 5.3 YAML 处理：只做行级字符串操作

外部方案同时说了「用 `js-yaml` 解析和生成」和「用字符串操作避免格式变动」——**这两条自相矛盾**，且第一条会破坏 `!!js` 表达式与注释。dsh-recovery 实际依赖 `yaml` 包 **[社区]**，但我们**不引入依赖**。

**采用**：只做行级定位与插入 —— 定位 `- id: <name>` 块，在其缩进层插入 `disabled: true`。**绝不全量 parse → serialize**。

### 5.4 外部方案与本项目架构的冲突（必须修正）

| 外部方案说法 | 本项目实际 | 修正 |
|---|---|---|
| 诊断逻辑放 `src/diagnostics/`（纯 TS，Vite HMR） | 设置页拿不到 `fs` / 子进程 | 放 `public/preload/lib/diagnostics.js` |
| 用 `preload.ts`、`utools/` 目录 | 本项目是 `public/preload/lib/*.js` 纯 CommonJS，无 TS | 同上 |
| 基于 `@ver5/vite-plugin-utools` 结构 | 本项目 Vite 6 + 手写 `public/plugin.json` | 忽略 |
| 「无需任何 npm 依赖」 | 与「用 `js-yaml`」矛盾 | 我们**零新依赖**，故只能行级 |
| 「预计 1 天 / 半天」 | 未计 UI / IPC / spec / 单测 / 三平台验证 | 改为**按阶段验收**，不承诺时长 |

### 5.5 不建议采信的外部信息

| 项 | 问题 |
|---|---|
| `dsh-fix` 项目 | 搜索**无此包**；其行为描述（`# dsh-fix:` 标记、flutter doctor 风格输出）**无法核实** |
| `dsh-safe-tui` 项目 | 搜索**无此包**；其会话选择器交互细节**无法核实** |
| `dsh doctor` 子命令 | 已失效（见 §5.1） |

可核实的现实参照是 **dsh-recovery（dsh-selfrepair）**：真项目、MIT、v0.6.0，用 `.dsh-doctor-backup/<时间戳>/` 与 `.dsh-doctor-known-good/snapshots/`（留 5 份）命名。**我们若做备份，用 `whale-` 前缀自己的目录**，避免与其混淆。

---

## 6. 阶段三：写入与恢复（**D2 确认：整体延后**）

> **本节不在本期交付范围。** 编码前必须先过 §6.1 的验证清单（硬 gate）。
> 之所以要 gate：外部方案建议「一键给**所有**用户插件条目追加 `disabled: true`」，但本机 `profiles/web` 有 **13 个 bundle + 9 个依赖** **[实测]**，全禁等于把用户整个 profile 干掉；且 `disabled: true` 对 **bundle 条目**是否生效、是否会触发 `patch: entry not found`，**目前都没有实测证据** **[推测]**。在未验证前实现写入，风险是损坏用户的 dsh 环境。

### 6.1 验证清单（**编码前的硬 gate**）

> **状态：V1–V4 已于 v1.6.2 全部真机核验完毕（2026-09-22）**，逐条结论见 `docs/whale-widget-spec.md` §10.3 第 ⑤ 段。**验证结论已敲定阶段三的四条硬约束**；**E1（备份 + 可撤销机制）、E2（单个插件禁用 / 启用）与 E3（我的一键隔离）已于 v1.6.3 落地**（见 §6.2 与 spec §10.3 第 ⑥ / ⑦ / ⑧ 段），E4 待排期。
> 核验全程用 `dsh --patch <overlay.yml>` 叠加临时层，**未改用户文件**；备份在 `~/.dsh/whale-v-gate-backup/`，验完三个关键文件 SHA256 与基线逐字一致。

| # | 要验证什么 | 方法 | 通过后才做 | **实测结论（v1.6.2）** |
|---|---|---|---|---|
| V1 | `disabled: true` 对 **profile `cordis.patch.yml` 里的 bundle 条目**是否生效 | 手动改一个 bundle 条目 → 启动 dsh → 看目标插件是否真被禁用 | E2 精确禁用 | **分情况**：纯服务端 bundle（`cost-meter`/`modlens`/`mnemon`）**可靠生效**；带 client 入口的插件（`dsh-better-sidebar`）**禁用组装树条目无效** —— 其加载入口在 `package.json` 的 `dependencies`。E2 不能承诺「禁用必生效」 |
| V2 | 整份禁用后 dsh 是否真能起来（是否会触发 `patch: entry not found`） | 手动全禁 → 启动 | E3 一键隔离 | **能起来**（16 条全禁，监听 3080，无报错）。但**写不存在的 id 只打一行 stderr `patch: entry "X" not found`**，退出码 0、启动照常 —— **静默失效**，E2/E3 必须主动捕获这句 |
| V3 | 现有 `profiles/web/cordis.patch.yml` 里 11 条 `disabled` 的实际语义 | 读现有文件，确认它是"用户自己禁的"还是"某工具写的" | 写入格式设计 | **12 条目 / 11 条 `disabled`，全部是第三方插件**（`modlens`/`mnemon`×9/`cost-meter`），无一条打在官方 bundle；第 25–34 行是 `remote-web-ui` 托管块。格式：`- id: X` + `disabled: true` **行级追加**，不改其他字段 |
| V4 | 写入后 dsh 是否热加载（`patchReload: "live"` **[实测]** 的含义） | 改文件 → 观察不重启是否生效 | 是否需提示重启 | **单向生效**：加 `disabled` **即时生效**（pid 不变）；**删掉该行不恢复**（等 23s 仍无效）→ **「恢复/撤销」不能只删行**，必须重启或显式 toggle |

**验证方式**：手动操作 + 记录结论到 `docs/whale-widget-spec.md`，**不写代码**。（已完成）

**零风险验证通道（后续 E1/E2 可复用）**：`dsh --profile web --patch <overlay.yml> --dump-config` 叠加临时层，不改用户文件；运行态看 web 首页 `/plugins/??<清单>`（`/?token=<启动打印的 token>` 是唯一免额外鉴权的端点，`/api/*` 一律 401）。注意 `--patch` 是 launcher 层参数，与 `web` 位置参数不可混用。


### 6.2 候选功能（验证通过后再排期）

| # | 功能 | 前置 | 状态 |
|---|---|---|---|
| E1 | 备份 + 可撤销机制（`whale-dsh-backup/<时间戳>/`） | 无（是所有写入的前置） | ✅ **模块与单测已完成（v1.6.3）**：`lib/dsh-backup.js` + `test/dsh-backup.test.mjs`（20 项）。**IPC 接入与设置页卡片未做**，留给 E2 —— 详见 spec §10.3 第 ⑥ 段 |
| E2 | 单个插件禁用 / 启用 | V1、V3、E1 | ✅ **已完成（v1.6.3）**：`lib/dsh-patch.js` + `test/dsh-patch.test.mjs`（15 项）+ `settings.js` 宿主层 + `services.d.ts` 类型 + 设置页「dsh 插件开关」卡片（含快照列表与两步确认还原）。**写前强制建快照，快照失败即中止写入**；「启用」需重启 dsh（V4 单向热重载）。**未新增 IPC 通道**（D14）。详见 spec §10.3 第 ⑦ 段 |
| E3 | 「我的一键隔离」（**不是**原方案的"安全模式"） | V2、E1 | ✅ **已完成（v1.6.3）**：`lib/dsh-isolate.js`（候选清单纯函数层）+ `dsh-patch.js#applyBatchDisable`（**两趟法**批量落笔）+ `test/dsh-isolate.test.mjs`（25 项）+ `settings.js` 宿主层 + `services.d.ts` 类型 + 设置页「dsh 一键隔离」卡片。**只禁勾选的候选**（§5.2 红线，不做全禁）；候选数上限 `MAX_BATCH = 100`；组装树读不到时**降级**（`treeError` + 只列 patch 条目，不算整体失败）；**写入前 `dryRun` 把将改动的行列给用户过目 → 两步确认 → 建 `before-isolate` 快照（失败即中止）→ 回读逐条校验**。**未新增 IPC 通道**（D14）。详见 spec §10.3 第 ⑧ 段 |
| E4 | known-good 快照 + 回滚（留 N 份） | E1。**快照绝不包含 `.credentials.yaml`** | 待排期（E1 已备好 `pruneSnapshots` / `MAX_SNAPSHOTS = 20`） |
| E5 | 自动换端口启动（官方支持 `--port 0` 让 OS 选空闲端口）**[实测]** | **D7：单独排期，不进本期** |
| E6 | Profile 快速切换 + 健康指示 | 需改 `restart()` 参数链 |
| E7 | `dsh plugin` 转发（pnpm） | 只读列举先做；pnpm 缺失需降级只读；**禁走 `.cmd`/`.ps1`** |

---

## 7. 交付节奏（按阶段验收，不承诺时长）

| 阶段 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| 阶段一 · 第一梯队 | §3.3 **C2 / C3 / C4** | 纯读文本 + 行级字符串，零平台语义依赖；三项在任何平台行为一致 | **已落地** |
| 阶段一 · 第二梯队 | §3.3 **C1**（身份指纹判据，D25） | 不再依赖 `realpath` 跨平台语义；pnpm 正常结构不误报、真装两份能报出 | **已落地** |
| 阶段一 · 第三梯队 | §3.3 **C5**（降级「尽力而为」，D26） | 探测失败报 `warning` 并写明原因，**不得**让整轮 `ok:false` | **已落地**：`lib/diagnostics.js` C5 六条 `warning` 出口 |
| 阶段一 · 收尾 | §3.1 全量交付物 + §3.4 宿主 API + §3.6 第 4 张卡 | 按 §11.3 手动制造 5 种场景，诊断能准确报出；dsh 未安装 / 未运行时诊断不报错 | **已落地**：spec §10.3 四段核验记录（含 C5 三态真机证据） |
| 阶段二 | §4 一次性 CLI 读取（D1–D2） | 先补 §4.1 登录 shell 兜底；三平台均能取到 dump 并正确分节；超时/失败有降级文案 | **已落地**：`lib/dsh-dump.js`（§4.3 六条约束全遵守）+ 设置页第 5 张卡（开发者 Tab）+ 28 项单测 |
| 阶段三 | §6 写入与恢复 | **先过 §6.1 的 V1–V4 硬 gate** | **进行中（v1.6.3）**：gate 已全过；**E1 备份机制 / E2 单插件禁用启用 / E3 一键隔离已落地**，E4 known-good 回滚待排期 |
| 单独排期 | E5 自动换端口（`--port 0`） | 不改现有 `dsh.js` 启动路径的前提下另立任务 | **延后（D7）** |

> **梯队划分的意义（D27）**：按「平台语义依赖从零到有」排序，**稳的先落地**。第一梯队不碰任何平台差异，可行即完成；C1 曾是本期最不稳的一环（`realpath` 语义），改用身份指纹后降到第二梯队；C5 是唯一真正依赖 `tasklist`/`ps` 双套逻辑 + 进程名反推的项，**允许它探测不出来**（D26）。

**每个阶段都必须包含**（本项目规范要求，一关都不能省）：

1. `npm run lint`（ESLint 10 扁平配置）
2. `npm run typecheck`（`vue-tsc --noEmit`）
3. `npm test`（`node --test`）
4. `npm run build`（`prebuild` 先 `sync-version.mjs` 再 `check-shared.mjs`）
5. 同步 `docs/whale-widget-spec.md`：新增存储键 → 第六节；新增文件 → 第二节；新增设置页卡片 → 第十节（**第五节 IPC 无需改动**，D14）
6. 涉及 `preload/` 改动 → **提示用户「在 uTools 里重新加载插件」**才能看到效果
7. `README.md` 对应章节（开发者集成 / 故障排查）如涉及用户可见行为，一并更新

---

## 8. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | 诊断遍历 `node_modules` 可能很慢 | 设置页卡顿 | memo + 60s TTL + `force` 手动刷新；per-check 超时 |
| R2 | 单项检查抛错导致整轮失败 | 诊断不可用 | 每项独立 try/catch，失败标记为该项 `error`，其余继续（§3.2 约定 2） |
| R3 | `$DSH_HOME/logs` 可能不存在 | 误报为故障 | 目录缺失时该项为 `ok`（§3.3 C8）**[实测]** |
| R4 | `$DSH_HOME` 可能被环境变量覆盖 | 读错目录 | 复用 `util.js` 的 `homeDir('DSH_HOME', '.dsh')`（支持 env 优先、`~` 展开、相对路径按 cwd）（D18） |
| R5 | 误把"重复模块"当故障（有些场景是有意的） | 误报 | 分级为 `warning` + 给出解释，不判 `critical` |
| R6 | 未来做写入时破坏用户 `cordis.patch.yml` | **用户环境损坏** | §6.1 验证 gate + E1 备份先行 + 只做行级操作 |
| R7 | mtime/size 指纹失效导致缓存读到旧数据 | 诊断结论过期 | 沿用 `dsh-usage.js` 已验证的 size/mtimeMs 指纹方案 |
| R8 | 复用提取（D18）动了 `dsh-usage.js` + `codex.js` 两个稳定模块 | **两个统计卡回归**（本期最大风险） | 函数体原样搬移、逻辑零变更、保留原导出面；改完**必须**跑 `npm test` 全绿 + §10.3 两个回归场景；失败则回滚 `util.js`，退回「诊断自己实现一份」 |
| R9 | ~~`normalizePath` 行为不符预期导致 C1 静默失效~~ → **已由 D25 消解** | 漏报重复模块 | **D25 换用 `name+version` 身份指纹后，C1 不再依赖路径语义**。`normalizePath` 降级为仅用于展示，风险随之下降 |
| R10 | `util.js` 意外引入 `log.js` 或触碰 `utools`（D21） | **单测在 `require` 阶段崩溃**，且构建**不会**拦下 | D21 三条硬禁令；`test/util.test.mjs` **不得挂 `utools` 桩**——若需要挂桩才能跑，就说明已违反 D21 |
| R11 | `homeDir()` 合并时把 `codexHome` 的语义一并放宽（D22） | `CODEX_HOME` 设相对路径的用户**行为被静默改变** | 保守合并：`~` 展开与相对路径做成可选参数，`codexHome` 传 `{expand:false}`；§10.3 补 `CODEX_HOME` 回归场景 |
| R12 | `readTextSafe` 静默吞掉 `EACCES`/`EISDIR`（D23） | 诊断**错误归因**（报"缺失"实为"读不到"） | 错误分流：仅 `ENOENT` 静默，其他 `logErr` 留痕并回报 `reason` |
| R13 | C5 依赖 `tasklist`（Windows）/ `ps`（其他）两套逻辑，且需从命令行**反推进程名**（D26） | 某些平台/权限下**判不出端口归属** | **已按 D26 降级**：探测失败 → `warning` + 写明原因 + **不阻塞其余四项**；不尝试新增平台分支去"补全"它，避免把平台差异引进本期 |
| R14 | 按 D27 分梯队实现，第一梯队先合并后，C1/C5 可能被"顺手简化" | 后续梯队被跳过，只剩最稳的三项就宣布完成 | §7 梯队表列为验收口径；C1/C5 未落地前**不得**把阶段一标为完成 |

---

## 9. 待确认问题（**已全部批复，见开篇「决策已定」**）

| # | 问题 | 批复 |
|---|---|---|
| Q1 | C1–C5 是否就是本期范围？C6–C8 是否纳入？ | **C1–C5 必做；C6–C8 不纳入**（D1）→ §3.3 / §3.3.1 |
| Q2 | ~~IPC 用新通道还是复用 `whale:dsh`？~~ | ~~**新通道** `whale:dsh-diagnose`（D5）~~ → **改判：不加 IPC，走 `settings.js` 宿主 API**（D14）→ §3.4 |
| Q3 | 存储键名用 `whale:dshDiagnose`？ | **采用**（D6）→ §3.5 |
| Q4 | 诊断缓存 TTL？ | **60s + 手动 `force`**（D6）→ §3.5 |
| Q5 | 设置页落点？ | **新增第 4 张卡**（D3）→ §3.6 |
| Q6 | 阶段三写入类整体延后，先过 V1–V4？ | **同意整体延后**（D2）→ §6.1 |
| Q7 | E5 自动换端口是否提前？ | **单独排期，不进本期**（D7）→ §6.2 |
| Q8 | 零新依赖 + YAML 只做行级操作？ | **同意**（D9）→ §5.3 |
| Q9 | 本文定稿后去向？ | ~~并入 spec 后删除本文~~ → **改判：保留本文**（D8 作废，见开篇说明）→ 本文即本文 |

---

## 10. 收尾动作（阶段一完成后执行）

### 10.1 同步 `docs/whale-widget-spec.md`（**不删除本文**，D8 改判）

spec 只写「是什么」，本文只写「为什么」（职责划分见开篇说明）。

| 目标节 | 要加入的内容 |
|---|---|
| 第二节（架构） | `lib/` 文件表新增 `util.js` 一行（共享工具，仅依赖 path/os/fs）、`diagnostics.js` 一行（只读诊断 check 契约 + 5 项检查 + `diagnose()` 聚合 + 60s TTL）；`settings.js` 一行补入 `diagnoseDsh()`；`dsh-usage.js` / `codex.js` 两行注明已改用 `util.js`（D18） |
| ~~第五节（IPC 通道契约）~~ | **无需改动**（D14：不新增 IPC 通道） |
| 第六节（存储结构） | 新增 `dbStorage` 键 `whale:dshDiagnose` 行（标注"纯派生数据、不含凭据、不进备份"） |
| 第十节（设置页） | 「开发者」tab 新增「dsh 诊断」卡的说明 |
| 第一节 / 第十一节 | 如涉及需求描述或测试命令，一并补充 |

**本文同步动作**（保留后必须做，否则本文会变成过期文档）：

| 位置 | 改什么 |
|---|---|
| 开篇状态行 | 版本号递增；阶段一完成后标注实际完成情况 |
| §3 标题 | 「阶段一：只读诊断（**本期开工**）」→ 落地后改为实际状态 |
| §7 交付节奏表 | 「状态」列同步更新 |
| §9 Q9 / 开篇 D8 | 已按改判修订，后续无需再动 |

**同步原则**：本文与 spec **不得出现矛盾表述**。若代码与本文冲突，**以代码 + spec 为准**，并回头改本文 —— 本文是决策记录，过期即失效。



### 10.2 阶段一提交前的必跑项（一项都不能省）

1. `npm run lint`（ESLint 10 扁平配置）
2. `npm run typecheck`（`vue-tsc --noEmit`）
3. `npm test`（`node --test`，含新建的 `test/diagnostics.test.mjs`）
4. `npm run build`（`prebuild` 先 `sync-version.mjs` 再 `check-shared.mjs`）
5. 同步 `docs/whale-widget-spec.md`（见 §10.1）
6. `README.md`：开发者集成 / 故障排查章节如涉及用户可见行为，一并更新
7. **提示用户「在 uTools 里重新加载插件」** —— 涉及 `preload/` 改动，不重载看不到效果

### 10.3 阶段一的自测方式（手工验证 G1）

必须**手动制造故障**确认诊断能报出，不能只看"全绿"：

| 场景 | 制造方法 | 期望 |
|---|---|---|
| **pnpm 正常结构不误报**（**D10 必测**） | 用**当前本机未改动的** `profiles/web`（pnpm 装、有 `pnpm-workspace.yaml`） | C1 报 `[✓]`。若报 `error` 说明两层判定没生效，判定口径写错了 |
| 重复模块（仅声明） | 在 `profiles/web/package.json` 的 `dependencies` 里加一个 `@deepseek-ai/*` 但**不安装**（**先备份**） | C1 报 `warning`（仅①命中）⭐ **本机现状下该分支恒不命中**（实测 `profiles/web` 的 9 项依赖里没有 `@deepseek-ai/*`），必须手工加一条才能验证，否则会误以为漏测 |
| 重复模块（真装出第二份） | 接上一步，在该 profile 下真正 `pnpm install` 出第二份 cordis（**先备份**） | C1 报 `error`（①②都命中），并指出冲突路径 |
| patch 条目缺失 | 在 `cordis.patch.yml` 里加一条指向不存在 id 的 patch（**先备份**） | C2 报 `error` 并给出该 id |
| patch 语法异常 | 在 `cordis.patch.yml` 里造缩进跳变 / `- id:` 缺值（**先备份**） | C3 报 `error` 并给出行号 |
| 端口被占 | 用别的进程占 3080 | C5 报 `error`（"被非 dsh 进程占用"） |
| dsh 未安装 | 临时改 `dshNodeDir` 指向空目录 | 返回 `installed:false`，卡片给空态文案，**不报错、不写缓存** |
| dsh 未运行 | 不启动 dsh | C1–C4 仍能出结果（G2），C5 报 `warning`（"未运行"） |
| **用量统计回归**（**D18 必测**） | 复用提取后，正常打开「dsh 用量统计」卡 | 用量数据与改动前**完全一致**（数字不变、无报错）。若为空或报错，说明 `util.js` 提取破坏了 `dsh-usage.js` |
| **Codex 统计回归**（**D18 必测**） | 复用提取后，正常打开「Codex 会话统计」卡 | 会话数据与改动前**完全一致**，`walkDir` 提取未丢文件。若数量变少，说明 `walkDir` 参数与原来不等价 |
| **并发不抢占**（**D15 必测**） | 在 dsh 状态卡正在探测端口时，立刻点开诊断卡并点「重新诊断」 | 两者都正常返回，**无卡死、无重复探测**。若出现挂起，说明 `probePort` 的单例 `busy` 标志被抢 |
| **`CODEX_HOME` 语义回归**（**D22 必测**） | 设 `CODEX_HOME` 为一个**相对路径**，打开 Codex 统计卡 | 行为与改动前**一致**（相对路径不解析、回退 `~/.codex`）。若变成解析并命中，说明 `homeDir` 把 `codexHome` 语义错误放宽了 |
| **`util.test.mjs` 独立性**（**D21 必测**） | 单独跑 `node --test test/util.test.mjs`，**不挂任何 `utools` 桩** | 直接通过。若报 `Cannot find module 'utools'` 或 `utools is not defined`，说明 `util.js` 违反了 D21 依赖禁令 |
| **C5 降级不污染整轮**（**D26 必测**） | 人为让端口探测失败（例如临时改掉 `psExe()` 的返回，或在一个 `tasklist`/`ps` 不可用的受限 shell 下运行） | 整轮**仍返回 `ok:true`**，C5 那一项为 `warning` + 写明「无法判定端口归属」，C1–C4 结果**照常给出**。若整轮变 `ok:false` 或 C1–C4 被吞，说明 D26 的连带约束没实现 |
| **C1 指纹判据跨平台自洽**（**D25 必测**） | 同一份 profile 目录，分别在 Windows 与 macOS/Linux 打开诊断卡（或用不同大小写的路径进入） | C1 结论**完全一致**。若结论随路径大小写/写法变化，说明还在走 `realpath` 字符串比对，D25 未生效 |

**验证方式**：手动操作 + 把结论记进 `docs/whale-widget-spec.md`，**不写自动化代码**。所有涉及改文件的场景**必须先备份**（改完还原，或依赖 `~/.dsh` 本身不在 git 里的天然隔离）。

---

## 11. 附：数据源清单（全部本机实测可读）

**★ = 本期阶段一实际使用**

| 路径 | 内容 | 用于 |
|---|---|---|
| ★ `$DSH_HOME/profiles/<n>/package.json` | `dsh.profile.bundles`（本机 web 有 13 项）、`dependencies`（9 项）、`patchReload: "live"` | **C1** |
| ★ `$DSH_HOME/profiles/<n>/cordis.patch.yml` | 已有 11 条 `disabled` | **C2、C3** |
| ★ `$DSH_HOME/settings.yaml` | 488B；`agent-default-model`(provider/model/reasoningEffort)、`pet`、`remote-web-ui` 等 | **C4** |
| ★ `$DSH_HOME/cordis.patch.yml` | home 用户层 patch | **C2、C3** |
| ★ 3080 端口 + 进程名 | 复用现有 `probePort/processName/isDshName` | **C5** |
| ★ `$DSH_HOME/profiles/<n>/node_modules/@deepseek-ai/*` | C1 的 realpath 比对对象 | **C1** |
| `$DSH_HOME/profiles/<n>/cordis.yml`、`pnpm-workspace.yaml` | profile 组装配置 | ~~C6~~（已排除） |
| `$DSH_HOME/logs/startup-<时间>-<uuid>.log` | ⚠️ **本机不存在** | ~~C8~~（已排除） |
| `$DSH_HOME/.env`、`.credentials.yaml`(223B)、`.anonymous-user-id` | 环境与凭据 | ~~C7~~（已排除）。**若将来读，只报存在性，绝不读凭据内容** |
| `$DSH_HOME/storages/cost-meter/ledger.json` | **141KB**，含 per-model 定价与 config | ~~C7~~（已排除） |
| `$DSH_HOME/dsh-usage/usage-ledger.json` | `{version:1, days:{...}}` 真实用量 | 已用于用量卡 |
| `$DSH_HOME/dsh-usage/provider-snapshots.json` | 11 个 provider，`deepseek-official`/`deepseek` 有 balance；`spendWatch` | 已用于用量卡 |
| `$DSH_HOME/storages/session_projcache/sessions/*.json` | 会话投影缓存 | 已用于用量卡 |
| `$DSH_HOME/sessions/<cwd转义>/session*.jsonl.zstd` | **zstd 压缩** | 本期不用 |
| `$DSH_HOME/task-board/ledger-v2.json` | `{schemaVersion:3, tasks:[], scheduler:{...}}` | C7 |

---

**请批复 §9 的 Q1–Q9。** 确认后我按阶段一开工。
