## 十、设置页（src/）

**深浅色由 `uiMode` 合成（判定源 `utools.isDarkColors()`）**：`auto`（默认）跟随 `utools.isDarkColors()`，`light`/`dark` 手动固定（兼作 `isDarkColors()` 异常时的逃生门）；生效值切 `<html>` 的 `dark` 类，`main.css` 与 App.vue scoped 的深色规则**全部**以 `html.dark` 为前缀。判定源**不跟系统** `prefers-color-scheme` —— 否则「系统暗 + uTools 亮」恒为暗色，用户以为主题坏了。uTools 无主题变更事件，只能轮询（同步布尔读，开销可忽略）：App.vue 启动即应用并 1s 轮询，`onUnmounted` 清定时器。「外观」卡「界面深浅色」下拉（跟随 uTools / 浅色 / 深色）走 `onUiModeChange` 本地立即应用再落库 —— 等轮询 / 回推才变会让人以为没生效；挂件菜单不加该行（7 行已满且极低频）。非 uTools 环境（类型检查 / 浏览器预览）`isDarkColors()` 抛错，按浅色处理。

**顶部 Tab 分组（现 7 组）**：原先卡片竖排一屏到底，找一项要滚很久；现按主题分组、一次只看一组，`activeTab` 默认 `look`：

| Tab | 副标题（`.tab-desc`） | 组内卡片（渲染顺序） |
|---|---|---|
| 外观 `look` | 挂件外观 · 按压气泡 | 挂件外观 / 按压气泡（自定义泡泡） |
| 资源 `assets` | 我的素材：资源概览 · 气泡图　｜　下载素材：形象 · 音效 | 资源概览 / 形象 / 导入的气泡图 / 音效 |
| 用量 `usage` | 用量与账本 · 提醒与通知 · 模型与余额 · 专注与待办 | 用量与账本 / 提醒与通知 / 模型与余额 / 专注与待办 |
| 窗口 `window` | 挂件窗口：显隐 · 位置 · 透明度 · 穿透 | 挂件窗口 |
| 数据 `data` | DeepSeek 凭据 · 清除数据 · 备份与恢复 | DeepSeek 凭据 / 清除数据 / 备份与恢复 |
| 帮助 `help` | 使用帮助 · 关于与更新 · GitHub 加速 | 使用帮助 / 关于与更新 / GitHub 加速 |
| 开发者 `dev` | DeepSeek Harness（dsh） · dsh 环境诊断 · dsh 配置转储 · dsh 全量导出 · dsh 用量统计 · dsh 插件开关 · dsh 插件市场　｜　Codex 会话统计 | DeepSeek Harness（dsh）/ dsh 环境诊断 / dsh 配置转储 / dsh 全量导出 / dsh 用量统计 / dsh 插件开关 / dsh 插件市场 / Codex 会话统计 |

**副标题（`.tab-desc`）与卡片名必须对得上**：`.tab-desc` 只列**真实存在的卡片**、用卡片标题（`<h2>` / `.fold-title`）的原词，顺序与渲染顺序一致 —— 写「组内分区」或已下线的卡名，用户照着找找不到。`TABS` 定义在 `src/App.vue` 顶部；`SEARCH_INDEX` 各条 `label` 也须与卡片标题同词。**本表抄的是 `TABS` 的 `label` / `desc` 原词，只是镜像；改 Tab 以 `src/App.vue` 的 `TABS` 为准，写死必漂移。**

分组就是把 `v-if="cardOn('tab', 'key')"` 直接挂在每张卡片上（`cardOn` 普通态按 Tab 命中、搜索态按 `searchHits` 命中；不额外套容器层）。**渲染顺序由 `TABS` 数组的 key 决定，与模板源码位置无关** —— 不同组的卡片在模板里交错排布（「数据」凭据卡在最前、「帮助」关于卡在最后）。Tab 条 `.tab-bar` 吸顶（`position:sticky; top:0; z-index:5`），底色用 CSS 变量 `--bar-bg` —— **必须与 `src/main.css` 里 `body` 背景一致**（浅色 `#f4f4f4` / 深色 `#303133`），否则滚动时内容从导航下面透出来。
