**固定文案池**（`config.bubble.system`，原 `config.quotes` 迁入）：五键 `time / timeEarly / timeMorning / timeEve / gifFail`，每项一个字符串数组。`time` 是白天报时模板（`{t}` 替换为 `HH:MM`），另三池是深夜 / 清晨 / 早上的固定说法，`gifFail` 是自定义气泡动图加载失败时的顶替文案 —— 都不走抽签，命中场景整池随机取一条。设置页在「按压气泡（自定义泡泡）」卡内提供编辑入口；默认值 `QUOTE_TEXT_DEFAULT`（`store.js`）与挂件页面 `floating-page.js` 里的兜底副本 `var QUOTES` 由 `scripts/check-shared.mjs` 构建时逐字比对。`normBubbleSystem` 清洗：逐条 `trim`、丢空、单条截 60 字、空数组 = 恢复内置默认。

**提醒文案**（`config.alerts`）：四类自动提醒（**低余额 / 今日预算 / 峰谷切换 / 鼠标穿透**）的**气泡与系统通知共用同一份模板**，可在设置页「提醒与通知」卡片编辑（原「文案」卡片迁入）。6 条模板：`low` / `budget` / `peakOn` / `peakOff` / `passOn` / `passOff` —— 峰谷与穿透**按状态各分两条**，免一条模板兼顾两种语气。

- **气泡三行映射**：模板按行映射到气泡的三行 —— 第 1 行 = 标题（A 样式）/ 第 2 行 = 大字（P 样式，带各提醒的状态色）/ 第 3 行 = 说明（C 样式，`w:true` 自动换行）；行数不足对应槽位留空，**超过三行的并入说明行**（气泡只有三行，多了显示不出来）。实现见页面侧 `alertLines(key, vars, midColor)`。
- **系统通知取全文**：通知只有一行，宿主用 `alertOneLine(tpl, vars)` 渲染后把换行合并成空格。
- **占位符**：`low` → `{balance}` `{threshold}`；`budget` → `{used}` `{budget}` `{over}`；`peakOn` / `peakOff` → `{schedule}`（值为时段表本身，如 `峰时9-12/14-18点`，前后缀写在模板里以便用户改语气）。**未提供的占位符原样保留**（`renderAlert` 只替换 `vars` 里真实存在的键），便于发现写错。
- **归一化**（`store.js`）：`normAlertText` 非字符串 → 内置默认，`\r\n` 归一、逐行 `trim`、**丢空行**（空行会让气泡某一行空着）、全空 → 内置默认、截 `ALERT_MAX_LEN`=200 字；`normAlerts(v, cur)` 口径同 `normBubbleSystem` —— `v` 不是对象（`null`）→ 6 条全部回默认（设置页「恢复默认」）；是对象 → 只处理它带的键，其余沿用 `cur`。取模板走 `alertFor(cfg, key)`（配置缺失/异常值时回内置默认）。
- **默认值 `ALERTS_DEFAULT` 在 `store.js`**，挂件页面 `floating-page.js` 里有一份**同内容的兜底副本 `ALERTS`**（浮动页无 `require`，读不到宿主常量），两处一起改（`check-shared.mjs` 比对）。页面侧 `applyConfig` 只接受**非空字符串**覆盖。
- **有意不接入模板**：多厂商模型的余额通知（`notifyModelLow`）文案含模型名，且每个模型有自己的 `lowAlertOn` / `lowAlertAmount`，与「内置 DeepSeek 低余额预警」是两套语义；余额大幅波动通知（`maybeNotifyDrop`）文案按是否计入用量区分，同样写死。
