### 10.3 手工核验结论（v1.6.2 留档）

①② 段只读（比对 `settings.yaml` / `profiles/web/cordis.patch.yml` / `profiles/web/package.json` 的 mtime + size）；③ 段改真实配置，先整目录备份、每场景造完立刻还原并核对 SHA256。

**① 只读核验（全部通过）**

| 项 | 结论 |
|---|---|
| pnpm 正常结构不误报（D10） | C1 `[✓]`「profile 未声明 `@deepseek-ai` 依赖，无分裂风险」；`dependencies` 确无 `@deepseek-ai/*`，「仅声明」分支恒不命中 |
| `util.test.mjs` 独立性（D21） | 不挂 `utools` 桩可跑通 —— `util.js` 只依赖 `fs`/`path`/`os` |
| `CODEX_HOME` 语义（D22） | 相对路径**原样传、未解析、未拼 cwd**；目录不存在返回 `""`；伪造 `~/.codex` 存在时回退；`env=~/probe` 不加 `expand` **不展开** |
| `DSH_HOME` 口径 | 有值且存在 → 原样返回；空 → 回退 `~/.dsh`；相对路径按 `relative:true` 接 cwd 解析（与 `codexHome` 相反，**显式声明**的差异） |
| C2–C5 现状 | C2 `[✗] 1 个`（只有 `config-manager`），C3/C4/C5 均 `[✓]` |

**② 降级与并发（全部通过）**

- **C5 降级不污染整轮**（D26）：探测未执行 / `failed:true` / 拿不到进程名 / 外部 dsh 在跑 → 一律 `warning`、**整轮 `ok:true`**、C1–C4 零污染；仅「被非 dsh 进程占用」→ `error` 且 `ok:false`。本轮注入 `externalPid` 绕过 `looksLikeDsh`，故「名字当证据」漏洞由 ③ 段真实探针暴露。
- **并发不抢占**（D15）：并发 3 次 `detectPort(3080)` 回调全部返回且 `deepEqual`（`busy` + `waiters` 成立）。此后 `detectPort` 改传 `force=true`，队列语义从「合并」变「只让最新轮写结果」，「所有调用方都拿到回调」不变。
- **dsh 未运行**：C1–C4 全部给出结论，C5 `[✓]`「3080 空闲」，整轮 `ok:true`。
- **dsh 未安装**：C1–C4 统一「未定位 `$DSH_HOME`，跳过」/「profile 目录不存在，跳过」/「无 `cordis.patch.yml`（跳过）」，**不报错**；`isNotInstalled` 只认 `run()` 两条文案（`未找到可用的 dsh` / `未找到 Node.js`），**超时 / 非零退出 / `ENOENT` 一律 `false`**；`settings.js` 只在 `payload.ok` 时写缓存。
- **用量 / Codex 统计**（D18）：`dsh-usage`（`silent:false`）能收集 `{dir, reason}`；`codex`（默认 silent）静默跳过 `EACCES`，与原实现一致，**未丢文件**。
- **只读承诺**：诊断 + 转储前后快照 mtime/size，三个关键文件未变。

**③ 改真实配置的硬 gate（备份后逐个造故障再还原）**

前置：整目录备份（**排除 `node_modules`**），关键文件 SHA256 一致。⚠️ 造故障只动 managed 注释块（`# --- remote-web-ui lan-bind block (managed - do not edit) ---`）**外**的条目。

- **patch 行级语法异常**：`cordis.patch.yml` 第 23 行 `disabled: true` 的缩进改 Tab → C3 报 `[✗] 1 处语法问题` / `第 23 行用了 Tab 缩进（YAML 禁止 Tab 缩进，请改成空格）`，**行号准确**，其余四项不受影响。
- **重复模块仅声明**：`package.json` 的 `dependencies` 加一条不存在的 `@deepseek-ai/dsh-probe-not-installed`、不跑 install → C1 `[!] 1 处可疑（1 个已声明依赖）`，`hint` 说明「未安装不会造成路径分裂，但可能起不来」。**仅①层命中时必须 `[!]` 不能 `[✗]`**。
- **端口被占**：裸 `node -e "net.createServer().listen(3080)"` → 暴露**真 bug**：C5 报 `[!] 已有外部 dsh 在运行`，判据只看进程名、把裸 node 认成 dsh。已修（见第十节 C5 两条踩坑）。
- **时序错位坑**：首次复验 C3 仍 `[✓]`，误判「诊断漏报」；查 mtime 发现用户点诊断在注入**之前**。**流程修正：造故障后先确认 mtime 与 hash 都变了，再让用户操作界面**。

**④ C5 端口归属三态真机核验（v1.6.2 补做）**

只起/停 dsh 本体，不造配置文件：

- **插件自启的 dsh 在监听** → C5 `[✓]`「由本插件的 dsh 监听」，pid 是**真正监听的 node.exe**；状态卡 pid 是 `cmd.exe`，两者不同是父链上溯生效的**正确**表现。
- **外部 dsh 占着** → C5 `[!]`（warning，整轮仍 `ok:true`）。
- **真空闲** → `[✓]`「3080 空闲」。
- **被非 dsh 进程占用** → `[✗]` error。

本段修掉两个真 bug（探测层工程错误，非判据）：

1. **探测蹭上陈旧轮次** —— 状态卡「运行中」时诊断报「3080 空闲」，而 `netstat -ano` 里有进程在 LISTENING。根因：`probePort` 的 `waiters` 排队复用让诊断搭上 `watchReady` 那轮。修法：`gen` 轮次号 + `detectPort` 传 `force=true`。
2. **`pid` 一字段两义** —— 诊断报「3080 空闲（无进程监听）」。根因：`detectPort` 把「端口上有没有人」与「占端口的是不是外人」塞进同一个 `pid`，而本插件自启 dsh 时后者恒为空。修法：`snapshot()` 拆出 `portPid` / `portName`。

**形态**：不是阈值或正则写错，而是「**同一份数据被两个语义共用**」与「**异步探测结果被跨轮复用**」；判据层单测（注入 `portState`）测不到，必须**真机跑 + `netstat` 对账**。

**已修**：`parseDump` 原只认行首 `^- id:`，`mnemon-bundle` 的 `config:` 列表里 4 空格缩进的 8 个子条目未进 `entries`。改按缩进的条目栈后，顺带修掉字段归属错层（父条目收尾字段覆盖子条目）与 base 层漏收 `openviking-memory-runtime`，详见第十节。

**C1 第二层判据真机验收，决定不做**：要在 `node_modules` 真装第二份 `@deepseek-ai` 包造「同包不同版本」，会动依赖树与锁文件。理由：① 清理闪失会留下假故障；② 风险方向是「误报 error 诱导用户改正确配置」，已由 `sameFingerprint` 两层单测覆盖（同包同版本 = error、同包不同版本 / 仅声明 = warn）；③ `dsh-dump` 已端到端给出。**替代**：用现成 `profiles/web.bak-*` 验「声明了但没装」只读路径。

**`config-manager`（C2 真错）—— 建议不改，由用户决定**：`cordis.patch.yml` 第 4-6 行是 `id: config-manager` + `name: dsh-config-manager` + `disabled: true` 的标准「禁用内置插件」写法，而该条目在组装树里不存在，**可能正是它被成功禁用的表现**；即便笔误，**诊断工具该如实报出，不替用户改配置**。也是 C2 判据的活体样本（本机 12 条 patch、dsh 只报这 1 条）。

**⑤ 阶段三 V1–V4 硬 gate 真机核验（v1.6.2 补做，只验证不写功能代码）**

前置：`Copy-Item` 三个关键文件到 `~/.dsh/whale-v-gate-backup/` 并记 SHA256；验完逐项还原。

**零风险通道**：`dsh --profile web --patch <overlay.yml> --dump-config` —— `--patch` 是 launcher 层参数，可**叠 overlay 不改用户文件**（`web` 位置参数与 `--patch` 不可混用，否则报 `--profile <name> is required`）。运行态判据用 `/plugins/??<清单>`（dsh 实际加载的客户端插件列表；`/?token=<启动时打印的 token>` 是唯一无需额外鉴权可读的端点，`/api/*` 一律 401）。

- **V1 `disabled: true` 打在 bundle 条目上** —— **分情况**。纯服务端 bundle 可靠生效（`cost-meter` / `modlens` / `mnemon` 禁用后客户端清单**确实消失**）；带 client 入口的**禁用组装树条目无效**（`dsh-better-sidebar` 的 client.js 在 `web-ui-better-sidebar`、`better-sidebar` **两个 id 都禁用后仍在清单里**，加载入口在 `profiles/web/package.json` 的 `dependencies`）。**开关不能承诺「禁用必生效」**，这类插件须单独提示。
- **V2 全禁后能否起来** —— **能起来**（监听 3080，无 stderr 报错，客户端清单 63 → 60）。**写出不存在的 id 时**只往 stderr 打一行 `dsh: [<overlay>] patch: entry "dshmarket" not found`，**退出码 0、dump 与启动照常成功** —— 静默失效。**阶段三必须主动捕获这句 `patch: entry "X" not found`**。
- **V3 现有 11 条 `disabled` 的语义** —— 实为 **12 个条目 / 11 条 `disabled`**，**全部指向第三方插件**（`modlens`、`mnemon` 及 8 个 `mnemon-*`、`cost-meter`），**无一条打在 `@deepseek-ai/*` 官方 bundle 上**。第 25–34 行是 `remote-web-ui` 的 `managed - do not edit` 托管块。写入格式先例：**只在条目下加一行 `disabled: true`**（`id:` 之后），不动其他字段。`dsh-market` 自身日志里 `event:"patch"` 用 `disabled row X` / `enabled row X`，与本项目行级写法**完全一致**。
- **V4 `patchReload: "live"` 是否即时生效** —— **单向生效**。加 `disabled: true` → pid **不变**、`dsh-whale-widget` **即时从清单消失**；**删行后等很久仍未恢复**。即**热重载能「禁用」不能「启用」**。**「恢复/撤销」不能只删行**，必须重启 dsh 或走显式 toggle —— 与 V3 里 market 日志的 `enabled row` 是**主动动作**相印证。

**对阶段三的直接约束**：① 禁用要**区分插件形态**（纯服务端可靠 / 有 client 入口不可靠）；② 写入后**必须校验 stderr 的 `not found`**；③ 撤销要**重启或显式 toggle**，删行无效；④ 格式沿用既有 `- id: X` + `disabled: true` 行级写法。
