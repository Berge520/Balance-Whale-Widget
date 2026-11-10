// uTools 功能指令名（= public/plugin.json 里 features[].cmds 中的文本）。
//
// 为什么单独抽一份：全局快捷键绑定的是**指令名**（utools.getCmdHotKey /
// redirectHotKeySetting 的入参都是这个字符串，官方口径），不是 feature code。
// 设置页原先在各处直接写死中文字面量 —— plugin.json 一旦改名，界面照旧显示旧词，
// 用户点「新增快捷键」绑到一个不存在的指令上，既不报错也没反应，最难排查。
// 所以：这里是**唯一副本**，构建时由 scripts/check-shared.mjs 校验它确实出现在
// plugin.json 的 cmds 里，不一致直接构建失败。
//
// 注意：这几个字符串是已发布版本的公开契约，用户可能已绑了快捷键，
// 改名 = 让别人的快捷键失效。要改必须同步 plugin.json + 本文件 + 迁移说明。

// 显示/隐藏挂件（whale-toggle 的第一条指令，也是设置页默认的绑定目标）
export const CMD_TOGGLE = '显示/隐藏挂件'
// 切换鼠标穿透（whale-passthrough）：穿透开启后挂件点不动，这是逃生通道
export const CMD_PASSTHROUGH = '切换鼠标穿透'
// 刷新余额（whale-refresh）
export const CMD_REFRESH = '刷新余额'
// 计时器（whale-timer）：开始/暂停
export const CMD_TIMER = '计时器'
