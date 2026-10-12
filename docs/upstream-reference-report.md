# 上游 DeepSeek-Balance-Whale-Widget 横向借鉴报告

- 上游路径：`E:\Github\DeepSeek-Balance-Whale-Widget`（DSH Web 插件，`dsh-whale-widget`）
- 本地路径：`e:\Github\Balance-Whale-Widget`（uTools 插件「小鲸鱼余额挂件」，v1.12.0）
- 结论口径：两者**同源但独立演进**（非 fork，remote 不同），业务重叠（余额/气泡/音效/吸附/提醒），因此横向借鉴成立；但**架构底座不同**（上游 = cordis 插件 + HTTP + 零构建单文件 IIFE；本地 = Electron preload + IPC + Vue3/Vite6），故借鉴点以**工程化与运行期防御**为主，而非代码移植。

> 本文是**一次性调研交付物**，非功能规格。功能规格仍以 `docs/whale-widget-spec.md` 为准。

---

## 一、上游版本线与现状

- 提交：67 commits；Tag：40 个；远端分支：13 个。
- 最新正式版 **v0.4.2**；`package.json` 的 `version` 仍为 `0.3.18`（上游自身存在版本线不一致，属其历史状态）。
- 版本线（近期）：`v0.4.0` / `v0.4.1` / `v0.4.2`，另有 `codex-v0.4.0` 并行线。
- 上游 remote 走 `ghfast.top` 镜像（`https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget.git`）。

## 二、上游架构与实现要点

| 维度 | 上游做法 |
| --- | --- |
| 插件体系 | cordis：`export default { name, apply(root) }` + `root.inject/on/effect`；`cordis.patch.yml` 声明 bundle 挂载 |
| 宿主本体 | [lib/index.js](file:///E:/Github/DeepSeek-Balance-Whale-Widget/lib/index.js) 约 4200 行 / 217KB，29 条 `/dsh-whale/*` 路由 |
| 前端本体 | [assets/whale-widget.js](file:///E:/Github/DeepSeek-Balance-Whale-Widget/assets/whale-widget.js) 约 17290 行 / 842KB，**单文件 IIFE，零依赖零构建，无 Shadow DOM**，`dshwv-` 前缀 |
| 通信 | `fetch('/dsh-whale/*')` HTTP，宿主事件驱动 + 前端轮询的间接推送 |
| 记账内核 | [accounting.mjs](file:///E:/Github/DeepSeek-Balance-Whale-Widget/lib/accounting.mjs) **无 IO 纯函数**定点数引擎 `SCALE=1e8`；`observeBalance` 余额差反推消费、`reconcileBalance` 乐观锁（`revisionOf` 冲突抛 409）、`bookBreakdown` 多账本 |
| 注入时序 | **有意去掉对象级 `inject`**（`lib/index.js` 约 651-656 行），改两段式 apply 规避桌面端注入竞态（issue #152/#153） |

### 2.1 安全栅栏（最值得借鉴的运行期设计）

- `registerRoute()`（约 802-811 行）把**所有 29 条路由统一**包进安全栅栏，杜绝「漏包一条」。
- `rejected(req,res)`（约 774-800 行）为总闸；`requestRejection` 三层 **fail-closed**：`selfRejection` + 宿主 `connection.requestRejection` 委托 + 加载告警。
- 写请求额外限制**本机回环**，防 DNS 重绑定 / CSRF / **凭据外带**（安全修复 S1）。
- 关键思想：**默认拒绝、集中一处**，而非每条路由各写一遍校验。

### 2.2 z-index 分层（本地目前完全没有的机制）

- 层段表 + `visibleTopZ()`（约 10051-10102 行）：**独立取值函数数组 + 各自 try/catch**，任一取值抛错不影响其余，规避 issue #131 的链式失效。
- 运行时登记口 `window.dshwRegisterMask(el)`（约 10106-10118 行），供第三方/插件动态遮罩登记，规避 issue #142。

## 三、上游工程化体系（本项目首要借鉴来源）

| 工具 | 作用 | 关键不变量 |
| --- | --- | --- |
| `tools/ci-audit.mjs` | 主审计（24KB / 约 470 行，零依赖，仅 `node:` 内置） | 5 条：栅栏 / 路由对等 / 打包产物自洽 / 门禁一致性 / 注入面 |
| `tools/ci-audit-selftest.mjs` | **门禁防腐** | 双向回归：干净样本必绿 + 写坏必红；`green()/red()` 断言原语，14 用例 |
| `tools/z-layer-audit.mjs` | z-index 分层校验 | 取值必须落在层段表内 |
| `tools/check-dead-settings.mjs` | 死配置两层 | ① 键名级读点 ② **kind 级消费方契约表** `EXPECT_CONSUMERS` |
| `ci-audit.allowlist.json` | 白名单 | 结构 `{key, why}`，**必须写明理由**才算数 |

其他工程实践：

- 发版 `publish.yml`：**手动触发**（npm 不可覆盖）、OIDC Trusted Publishing、`concurrency` 防并发、`dry_run` 演练、只允许 main、两套 workflow 一致性门禁。
- 合规 [`PROVENANCE.md`](file:///E:/Github/DeepSeek-Balance-Whale-Widget/PROVENANCE.md)：代码 MIT / 素材 as-is **分开标注** + 元数据剥离 + takedown 承诺。
- [`.gitattributes`](file:///E:/Github/DeepSeek-Balance-Whale-Widget/.gitattributes)：LF 统一（关联过一次 CRLF 事故）。

## 四、本地 vs 上游 差异对照

| 能力 | 上游 | 本地 | 判定 |
| --- | --- | --- | --- |
| 安全栅栏（集中式 fail-closed） | ✅ 三层，统一包 `registerRoute` | ❌ 本地走 Electron IPC（攻击面天然更小），无同类集中栅栏 | 借鉴「思想」，不做代码移植 |
| z-index 分层表 + 取值检查 | ✅ 层段表 + `visibleTopZ` + 登记口 | ❌ **z-index 写死 CSS 6 个散点**，无表、无检查 | **可落地（空缺最大）** |
| 门禁自检（防腐） | ✅ ci-audit-selftest（双向回归） | ⚠️ 有 `build-gates.test` / `check-dead-settings.test` / `check-orphan-css.test`，但**无「写坏必红」反向断言** | 借鉴补强 |
| 死配置契约表 `EXPECT_CONSUMERS` | ✅ | ✅ **已有同类两层实现** | 无需变更 |
| IPC/路由对等检查 | ✅ 路由对等（ci-audit 内） | ✅ `test/ipc-parity.test.mjs`（4 条双向断言，只读源码） | 无需变更 |
| 常量副本一致性 | ❌ | ✅ `scripts/check-shared.mjs`（CHECKS 表） | **本地更强** |
| 记账/定价内核 | ✅ 纯函数定点数引擎 `SCALE=1e8` | 本地为 `pricing.js` / 用量账本（业务不同） | 定点数思路可选借鉴 |
| 素材溯源合规 | ✅ `PROVENANCE.md` | ⚠️ 有共享角色/音效库，**无溯源文档** | 可落地 |
| 一键发版 | publish.yml（npm 线） | ✅ `scripts/release.mjs`（本地更贴合 uTools） | 无需变更 |

## 五、可落地优化点（含优先级 / 成本 / 收益）

| # | 优化点 | 优先级 | 实施成本 | 预期收益 | 具体做法 |
| --- | --- | --- | --- | --- | --- |
| 1 | **悬浮窗 z-index 分层表** | 高 | 中 | 高 | 在 `floating.css` 抽出 `:root` 变量层段表（如 `--z-root/--z-menu/--z-actions`），把现有 6 个散点值收敛进去；新增 `scripts/check-z-layers.mjs` 校验 JS/CSS 中出现的裸 z-index 必须落在层段内 |
| 2 | **门禁反向自检补强** | 高 | 低 | 中 | 仿 `ci-audit-selftest.mjs`：为现有 `check-shared` / `check-dead-settings` / `check-orphan-css` 各补「干净样本必绿 + 写坏必红」双向断言，纳入 `test/build-gates.test.mjs` |
| 3 | **取值函数独立 try/catch** | 中 | 低 | 中 | `floating-page.js` 里凡「多来源取同一个值」的函数群（如遮罩/命中判定），改为独立取值 + 各自兜底，避免单点抛错连坐 |
| 4 | **重试/超时/去重统一封装** | 中 | 中 | 中 | 上游对 fetch 有超时/去重/缓存 TTL/AbortController；本地走 IPC 但 `api.js` 的联网请求同样需要统一超时 + 去重 + 缓存 TTL，避免重复打上游接口 |
| 5 | **素材溯源文档** | 中 | 低 | 中 | 新建 `PROVENANCE.md`：区分内置素材与共享角色/音效库的来源与许可，承诺 takedown；与上游合规口径对齐 |
| 6 | **定点数记账** | 低 | 中 | 低 | 若本地用量/余额存在浮点误差风险，可借 `SCALE=1e8` 定点数思路；当前未发现明显误差，暂列观察 |

### 不建议照搬的部分

- **cordis 插件体系 / `cordis.patch.yml` / profile 机制**：本地是 uTools + Electron，体系不兼容，无移植价值。
- **HTTP 路由 + 三层安全栅栏**：本地经 `contextBridge` + IPC，攻击面本就小；照抄会引入不必要的复杂度。仅借鉴其「集中一处、默认拒绝」的设计思想。
- **单文件零构建 IIFE**：上游为「免安装分发」服务的取舍；本地已有 Vite6 构建与分层，反向退化无收益。

## 六、本地可反向参考给上游的点（附带结论）

1. `scripts/check-shared.mjs` 的**跨文件常量副本校验**（CHECKS 表）—— 上游缺此能力，常量副本漂移是共同风险。
2. `scripts/release.mjs` 的**前置检查链**（版本递增 / 工作区状态 / README 章节 / tag 占用 / gh 登录 / 分支）。
3. `test/ipc-parity.test.mjs` 的**只读源码**对等断言方式（无需起服务即可校验两侧通道齐全）。

## 七、落地顺序建议

1. 先做 **#1 z-index 分层表**（空缺最大、事故面最广：菜单/动作条/气泡叠加遮挡）。
2. 再做 **#2 门禁反向自检**（成本最低、直接提升现有门禁可信度）。
3. 之后按需推进 **#3 / #4 / #5**。
4. **#6 暂不实施**，仅在出现浮点误差证据时再评估。

---

*本报告基于对上游 `lib/index.js`、`assets/whale-widget.js`、`lib/accounting.mjs`、`tools/*`、`.github/workflows/*`、`PROVENANCE.md`，以及本地 `public/preload/**`、`public/floating-*.js|css`、`scripts/*`、`test/*` 的静态阅读与核对形成；全部结论均标注了对应文件/行号依据，未做任何代码修改。*
