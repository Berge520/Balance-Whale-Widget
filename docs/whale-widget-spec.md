# 小鲸鱼余额挂件 · 开发与维护规格（uTools 版）

> 用途：汇总本 uTools 插件的完整架构、行为规格、视觉/几何参数、IPC 契约、存储结构与踩坑结论，供复现、维护与二次开发。
> 用户向文档见根目录 [README.md](../README.md)。视觉原型来自 DSH 版 [`whale-widget-prompt.md`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，本文件只描述 **uTools 版的差异与落地实现**。
> **本文件是索引 + 需求总览**：正文已按主题拆到 [`docs/spec/`](spec/) 下 50 个分片。**按需只读相关分片，不要整目录读入**。

## 目录

| 分片 | 内容 |
|---|---|
| 本文件 | §一 需求总览 |
| [02-architecture.md](spec/02-architecture.md) | §二 架构（务必先读）：主窗 / 悬浮窗数据流、核心 lib 模块职责 |
| [02-architecture-lib.md](spec/02-architecture-lib.md) | §二 续：lib 模块职责（工具 / 诊断 / 素材 / 窗口）+ 依赖单向 |
| [02-architecture-ui.md](spec/02-architecture-ui.md) | §二 续：悬浮窗 preload / 页面、设置页组件分层、构建约束 |
| [03-utools-api.md](spec/03-utools-api.md) | §三 uTools 关键 API 约定：建窗 / 穿透 / 快捷键 / 日志 |
| [03-utools-api-window.md](spec/03-utools-api-window.md) | §三 续：空 catch / onPluginOut / enterMode / workArea / setOpacity / 鼠标穿透 |
| [04-geometry.md](spec/04-geometry.md) | §四 窗口几何模型 |
| [05-ipc.md](spec/05-ipc.md) | §五 IPC 通道契约：悬浮窗 ↔ 宿主 |
| [05-ipc-services.md](spec/05-ipc-services.md) | §五 续：`services.*` 接口 + 余额 payload |
| [06-storage.md](spec/06-storage.md) | §六 存储结构：核心存储键 / 文件路径总表 |
| [06-storage-dsh.md](spec/06-storage-dsh.md) | §六 续：dsh / Codex / 任务栏 / 节假日存储键 |
| [06-storage-assets.md](spec/06-storage-assets.md) | §六 续：素材包 / 内置形象 |
| [06-storage-shared.md](spec/06-storage-shared.md) | §六 续：共享素材 |
| [06-storage-config.md](spec/06-storage-config.md) | §六 续：config 字段 |
| [06-storage-copy.md](spec/06-storage-copy.md) | §六 续：文案池 / 提醒文案 |
| [06-storage-notify.md](spec/06-storage-notify.md) | §六 续：通知方式 / 额度 / 多厂商模型 |
| [07-network-billing.md](spec/07-network-billing.md) | §七 网络与计费 |
| [08-floating.md](spec/08-floating.md) | §八 悬浮窗页面：渲染 / 拖拽 / 音效 / 气泡 |
| [08-floating-menu.md](spec/08-floating-menu.md) | §八 续：汉堡菜单分组与窗口行为 |
| [08-floating-remind.md](spec/08-floating-remind.md) | §八 续：提醒 / 计时 / 专注 / 深浅色 |
| [09-visual.md](spec/09-visual.md) | §九 视觉与几何参数（精确值） |
| [10-settings.md](spec/10-settings.md) | §十-1 设置页：深浅色合成 + 顶部 Tab 分组 |
| [10-settings-cards.md](spec/10-settings-cards.md) | §十-1 续：卡片合并 / 拆分、卡内折叠态 |
| [10-settings-sync.md](spec/10-settings-sync.md) | §十-1 续：配置双向同步、素材管理、用量刷新 |
| [10-settings-dsh.md](spec/10-settings-dsh.md) | §十-2 设置页：dsh 卡片主控 / 版本说明 / 异步动作收尾 |
| [10-settings-dsh-port.md](spec/10-settings-dsh-port.md) | §十-2 续：运行端口留档、状态轮询、用量统计卡 |
| [10-settings-dsh-diag.md](spec/10-settings-dsh-diag.md) | §十-2 续：dsh 故障诊断卡片本体 |
| [10-settings-dsh-diag-c2.md](spec/10-settings-dsh-diag-c2.md) | §十-2 续：C2 / C3 判据踩坑 |
| [10-settings-dsh-diag-c5.md](spec/10-settings-dsh-diag-c5.md) | §十-2 续：C5 端口 / pid 判据踩坑 |
| [10-settings-dsh-dump.md](spec/10-settings-dsh-dump.md) | §十-2 续：dsh 配置转储 |
| [10-settings-market.md](spec/10-settings-market.md) | §十-3 设置页：dsh 插件市场卡（卡片本体 + `.mkt-*` 样式） |
| [10-settings-market-api.md](spec/10-settings-market-api.md) | §十-3 续：宿主兼容性拦截 |
| [10-settings-market-query.md](spec/10-settings-market-query.md) | §十-3 续：目录快照 / 精确版本查询 / dryRun |
| [10-settings-market-install.md](spec/10-settings-market-install.md) | §十-3 续：安装 / 更新进度、待确认单据、已装包清单 |
| [10-settings-market-pnpm.md](spec/10-settings-market-pnpm.md) | §十-3 续：pnpm 通道、参数引号、假成功判据 |
| [10-settings-market-failure.md](spec/10-settings-market-failure.md) | §十-3 续：失败结构化分类、一次性重试、mismatch |
| [10-settings-market-update.md](spec/10-settings-market-update.md) | §十-3 续：检查更新 / 更新插件 / 装载卸载 |
| [10-settings-market-verify.md](spec/10-settings-market-verify.md) | §十-3 续：回读核验五道、五态表、`.mkt-*` 样式 |
| [10-settings-privacy.md](spec/10-settings-privacy.md) | §十-4 设置页：数据与隐私 / 备份与恢复 |
| [10-settings-history.md](spec/10-settings-history.md) | §十-5 设置页：v1.6.2 手工核验结论 + ①–⑤ 段留档（历史，非现行契约） |
| [10-settings-history-dsh.md](spec/10-settings-history-dsh.md) | §十-5 续：⑥–⑧ 段 dsh 相关留档（历史） |
| [10-settings-history-dsh-e4.md](spec/10-settings-history-dsh-e4.md) | §十-5 续：⑨ E4 known-good + `disabled` 三态（历史） |
| [10-settings-history-dsh-audit.md](spec/10-settings-history-dsh-audit.md) | §十-5 续：⑩ §十二 全量审计 + ⑪ E3 候选分档修复（历史） |
| [10-settings-history-dsh-tab.md](spec/10-settings-history-dsh-tab.md) | §十-5 续：⑫ dsh Tab 结构整合 第一–四批（历史） |
| [10-settings-history-dsh-tab-b.md](spec/10-settings-history-dsh-tab-b.md) | §十-5 续：⑫ dsh Tab 结构整合 第五–八批（历史） |
| [10-settings-history-batches.md](spec/10-settings-history-batches.md) | §十-5 续：⑬–⑮ 全量导出 / 筛选排序 / 分类 chip（历史） |
| [10-settings-history-batches-platform.md](spec/10-settings-history-batches-platform.md) | §十-5 续：⑯ 三平台 / ⑰ 画廊缩略图（历史） |
| [10-settings-history-batches-theme.md](spec/10-settings-history-batches-theme.md) | §十-5 续：⑱–㉑ 按钮深色 / `uiMode` / 首帧预涂 / 复用收敛（历史） |
| [11-build.md](spec/11-build.md) | §十一 构建与自测：安装 / 类型检查 / 单测 |
| [11-build-release.md](spec/11-build-release.md) | §十一 续：版本号 / 副本校验 / 自测清单 / CI / 发版 |
| [12-regressions.md](spec/12-regressions.md) | §十二 已知待修问题（v1.6.2 全量审计留档） |

---

## 一、需求总览

uTools 插件：呼出后在桌面创建一个**透明、无边框、置顶**的独立小窗，常驻显示「小鲸鱼 + DeepSeek 余额 + 今日已用」。

- 鲸鱼 cut-out 本体（默认 `public/whale/DSniang1.webp`，另有 1 张内置可下载形象（v1.8.0 起）与 36 张共享角色，以及用户导入的图片可选，见 `config.skin`）+ 代码绘制的对话气泡（SVG），气泡内三行文字；气泡配色有默认（蓝白）/ 深色 / 樱花三套预设。导入的形象进**画廊**（`whale:skins`，最多 20 张，缩略图网格里切换 / 置顶 / 删除）。
- 余额：`GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <apiKey>`；从 `balance_infos` 智能选币种（优先 CNY 且 >0 → 任意 >0 → CNY → 第一项）。
- 今日已用双模式：
  - **小鲸鱼记账（默认，免令牌）**：余额差值本地记账（uTools `dbStorage`），跨天归档保留天数**可配**（`config.historyKeepDays`，默认 365，范围 35–730；下限 35 是因为趋势图要取到 30 天、且「本月汇总」在 31 号要回溯到 1 号，31 天窗口不够），切换币种只重置基准。
  - **实时·令牌**：用平台网页令牌调 `usage/by_api_key/amount`，按峰谷定价表换算；失败自动回落记账。
- **记账防误判**（三条例外，详见第七节）：赠送额度整块到期/被平台收回、短时间异常跳变、更换 API Key，均不计入今日用量；被拦下的下降额单列（`todayAdjust`）并在挂件气泡里解释。另有**手动校准今日已用**（只改当天累计）。
- 交互：拖拽 + 四边四分之一吸附（四角可组合）+ 自由位、贴左镜像、按压 Q 弹 + 双段音效（可选**自定义音效**：按压/释放两段为「音色」，另有低余额/预算/峰谷/穿透**四类提醒各一段提醒音**，六槽位分别导入，提醒音留空时用内置提醒音）、汉堡菜单（分组：待办 / 模型 / 外观与音效（大小/音效开关/音色/音量/**透明度**/气泡/报时/锁定）/ 用量与峰谷（用量/峰谷文案/峰谷提醒）/ 计时 / dsh；末尾打开设置 / 隐藏挂件）、数字滚动、60s 自动刷新 + 点击手动刷新、报时/降级固定文案 + rua.webp、透明区点击穿透。
- **窗口透明度**（20%–100%）与**鼠标穿透**总开关（可悬停约 1 秒临时接管）：详见第三节第 7、16、17 条与第八节。
- 计时 / 定时 / 倒计时：结果在思考气泡内显示并每秒刷新；到点响提示音（沿用音效开关与音量）并在气泡里显示「时间到！」。
- 任务栏避让（默认开，可关）：实时识别任务栏隐藏/显示 —— 自动隐藏且收起时挂件贴满边，任务栏一弹出就自动按锚点上移让位、收起后贴回；另有「贴边间距」（上/右/下/左，px，0＝紧贴）可自定义（详见第四节）。
- **自动通知三类**（都受免打扰时段约束）：今日预算超出、余额低于阈值（各**每天一次**）、余额大幅波动（单次采样下降 ≥ 阈值，**不去重**，每次发生都通知）。低余额 / 今日预算 / 峰谷切换 / 鼠标穿透四类提醒的**气泡与系统通知文案可在设置页「提醒与通知」卡片编辑**（v1.12.x 起由原「文案」卡片迁入；模板 + 占位符，见第六节）。
- **用量与账本**（设置页）：可选 7 / 14 / 30 天柱状图 + 本月汇总（合计 / 日均 / 峰值 / **累计已用**）+ 可折叠**账本明细**（见第十节）。
- 开发者附带：**DeepSeek Harness（dsh）** 启停/重启/更新/版本来源/日志与缓存清理（挂件菜单折叠组 + 设置页卡片）；**备份与恢复**（挂件设置/账本/窗口位置/计时/待办与专注记录，凭据可选加密导出、导入按项同名覆盖）。
- **多厂商余额 / 额度**（v1.5.0 新增）：除内置 DeepSeek 外最多再添加 9 个模型（合计 `MODEL_MAX = 10`），可在挂件里**切换主显示** —— 余额型显示原币种余额（附 `~今日已用`，按相邻两次余额差估算），额度型（订阅）显示剩余百分比与重置时刻。内置 11 个厂商模板（OpenRouter / Moonshot 大陆站与国际站 / 阶跃星辰 / Novita / 智谱 GLM Coding / Kimi Coding / MiniMax Coding / OpenAI 兼容中转站 / 自定义 HTTP），**只收录能用 API key 直接查到余额或订阅额度的厂商** —— 其余厂商官方没有这类接口，而本插件拦不到对话事件，搬过来只会是空壳。
- **不含**「每轮对话消耗统计」（该功能依赖 DSH 本机会话事件，uTools 无对应数据源）。
