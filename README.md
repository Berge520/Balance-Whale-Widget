# 小鲸鱼余额挂件 · uTools 插件

桌面上一个透明、无边框、置顶的小鲸鱼挂件，常驻显示 **DeepSeek API 余额** 与 **今日已用**。移植自 DSH 版 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，改为独立的 [uTools](https://u.tools) 插件（Vue 3 + Vite 6）。

![小鲸鱼余额挂件](public/whale/DSniang1.png)

## 特性

- 🐋 **桌面常驻小窗**：独立透明置顶窗口（可在设置里开关置顶），不依附任何网页；透明区域**点击穿透**，不挡桌面操作
- 💰 **余额**：60 秒自动刷新 + 点击鲸鱼手动刷新；余额变化时数字**滚动动画**；网络抖动自动沿用最近余额不报错
- 📊 **今日已用** 双模式：
  - **小鲸鱼记账（推荐，免令牌）**：余额差值本地记账，跨天自动归档（保留 30 天），切换币种只重置基准
  - **实时·令牌**：填平台网页令牌后按**峰谷定价**精确换算；令牌失效自动回落记账
- 🔑 **凭据加密存储**（uTools `dbCryptoStorage`）；「测试连接」分项验证 **API Key**（余额接口）与**平台 Token**（用量接口）
- ⚠️ **低余额预警**：余额低于可配阈值时，数字与「今日已用」变红提醒（设置页开关 + 阈值）
- 📈 **近 7 天用量趋势**：设置页柱状图展示每日用量
- 🕐 **小鲸鱼报时**：点击鲸鱼时气泡首行报当前时间（鲸鱼娘语气，深夜/清晨会换台词）；设置页与挂件菜单均可开关
- 🖱️ **拖拽 + 四边四分之一吸附**（四角可组合），也可拖到屏幕中间**自由摆放**；贴左缘整体**水平镜像翻转**
- 🧸 **按压 Q 弹** + 按压/松手双段音效（设置页与挂件菜单均有**音效开关**）；💬 **随机台词**（含 rua.gif）；🎚️ 汉堡菜单调大小/音效开关/音色/音量/用量/峰谷文案/气泡
- ⌨️ **自定义快捷键**：可为「显示/隐藏挂件」指令绑定 uTools 全局快捷键，一键显隐挂件（设置页提供「复制指令名」+ 文字步骤，绑定被删除后可用「新增快捷键」直接跳转新增）

## 安装与开发

前置：[uTools](https://u.tools) 桌面端 + Node.js。

**开发模式（热更新）**

```powershell
npm install
npm run dev      # Vite dev server，http://localhost:5173
```

在 uTools 中：打开 **开发者工具** → 新建项目，**插件入口目录选本项目的** **`public/`** → 用指令 `余额挂件` / `小鲸鱼` 呼出。
设置页走 dev server 热更；悬浮窗页面与 preload 改动后需在 uTools 里**重新加载插件**。

**打包安装**

```powershell
npm run build    # 产物输出到 dist/
```

uTools 开发者工具中把插件入口目录指向 **`dist/`**。

## 配置（呼出后主窗口即设置页）

1. **DeepSeek API Key（必需）**：[platform.deepseek.com](https://platform.deepseek.com) →「API keys」创建（`sk-` 开头）→ 粘贴到 **API Key** 框 →「保存凭据（加密存储）」。「测试连接」会分别验证已填写的 API Key 与平台 Token。
2. **平台 Token（可选，仅「实时·令牌」模式）**：登录 <https://platform.deepseek.com> → F12 → Network → 打开「用量」页 → 找 `usage/by_api_key/amount` 请求 → 复制其 Request Headers 里 `Authorization` 的值（形如 `Bearer eyJ...`，前缀可带可不带）→ 粘贴到 **平台 Token** 框保存。令牌是网页会话，重新登录平台后可能失效（会自动回落记账）。

## 使用

- **呼出**：`余额挂件` / `小鲸鱼` / `小鲸鱼余额` / `DeepSeek余额` / `whale`
- **点鲸鱼**：弹余额气泡 + 手动刷新 + 报时（气泡首行显示当前时间）；点气泡切随机台词，再点关闭（5 秒自动收起）
- **拖鲸鱼**：松手按屏幕 1/4 区吸附四边（四角可组合）、贴左镜像；拖中间则自由摆放
- **悬停鲸鱼 → 右上角汉堡按钮**：大小 / 音效开关 / 音色 / 音量 / 用量模式 / 峰谷文案 / 气泡 / 报时 / 置顶
- **设置页**：显示 / 隐藏挂件；「复制指令名」「新增快捷键」用于绑定全局快捷键
- **自定义快捷键**：按 `Ctrl+,` 打开 uTools 设置 → **全局功能** → 新增 → 指令填「显示/隐藏挂件」（可点设置页「复制指令名」快速复制）→ 按下组合键。之后按该键即可一键显隐挂件，触发时不弹出搜索框；若绑定被删除，点「新增快捷键」可直接跳转重新添加（注意每次点击都会新增一条待绑定项）

## 常见问题

- **挂件不出现**：确认入口目录（dev=`public/`，打包=`dist/`）；点设置页「显示挂件」；主窗右键→检查看 `[whale][widget]` 日志。
- **悬浮窗调试**：焦点在挂件窗口上按 `Ctrl+Shift+I`。
- **401 API Key 无效**：确认填的是 `sk-` 开头的 **API Key**（不是平台 Token）；用「测试连接」看服务器原文。
- **今日已用** **`--`**：记账模式需先有一次余额观测（60 秒内）；令牌模式需配好平台 Token，失败回落记账。
- **没声音**：音量不为 0；Electron 首次需先有一次交互。
- **改了 preload 不生效**：preload 不热更，需在 uTools 开发者工具里重新加载插件。

## 文档

- 本 README 面向使用者与安装；
- 开发/维护向的完整规格（架构、窗口几何、IPC 通道、存储结构、视觉参数、峰谷定价、踩坑结论）见 **[docs/whale-widget-spec.md](docs/whale-widget-spec.md)**。

## 致谢

挂件视觉、台词与交互原型来自 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。

## 许可证

本项目基于 **GNU Affero General Public License v3.0（AGPL-3.0-only）** 开源，详见 [LICENSE](LICENSE)。

本项目移植自 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT License，Copyright (c) 2026 MeteorNOX），上游代码与素材的 MIT 许可条款保留在 [LICENSE-MIT](LICENSE-MIT)。
