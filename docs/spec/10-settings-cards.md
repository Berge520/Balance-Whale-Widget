**卡片合并 / 拆分（v1.5.0 整理）**：

- 「自定义素材」**并入「挂件外观」**：素材导入 / 删除原先另占一张卡，现并入，卡头「清除全部素材」按钮由 `hasAssets` 控制显隐。随后素材区从「挂件外观」整块移出、独立成 **「资源」Tab**：「挂件外观」只留「用哪个」（形象下拉 + 音色下拉 + 指向「资源」页的提示），「资源」页管导入、体积、删除与迁移。
- 「台词库」+「提醒文案」**合并为「文案」卡**（v1.5.0）：提醒文案侧 6 个 `textarea`；台词库侧是**可增删的随机组列表 + 2 个固定文案 `textarea`**。**该独立「文案」卡已拆解下线**：台词库整套编辑 UI（随机组列表 / 行×段编辑器 / 行条件 / random 段 / 导出台词包）已**从设置页移除**，`cfg.quotes` 的**数据模型（加权抽组 `groups` / `clickQueueOn` / `quoteMode`）也已在 v1.12.x 从宿主彻底删除**（总开关关掉时挂件改发 `cfg.bubble.system` 的 5 池固定文案）；提醒文案侧 6 个 `textarea` 归入「提醒与通知」卡；**「按压气泡（自定义泡泡）」卡**（`data-search="bubbleCustom"`）成为台词类内容的唯一编辑入口，卡内只留总开关 + 泡泡队列 + 模块编辑 + 使用说明，不再内嵌台词库分区（卡头换回 `bubbleCardFolds.open` 单纯折叠）。**⚠️ 拆卡时漏摘过一处**：`clickQueueOn`（「点按依次播放」）复选框留在「挂件外观」卡、配置层还在写，`public/` 侧已无读取方 —— **死开关**；v1.13.0 已连同 `cfg.clickQueueOn` 一并清掉（见第五节删除说明）。
- 「挂件行为」**拆开**：`usageMode` 口径下拉并入「用量与账本」；峰谷切换提醒 / 计时到点通知 / 记住计时状态 / 低余额预警 / 今日预算提醒 / 余额大幅波动通知 / 提醒停留时长 / 免打扰时段归入新增的**「提醒与通知」卡**。
- 「挂件窗口」**瘦身**：使用说明 / 快捷键绑定 / 故障排查 / 挂件错误查看移入新增的**「使用帮助」卡**，卡内只剩窗口相关项（避让 / 间距 / 透明度 / 穿透 / 复位）。
- 「用量趋势」**改名「用量与账本」**（趋势图 + 本月汇总 + 额度 + 今日模型占比 + 账本明细 + 导入导出都在这一张）。
- 「DeepSeek Harness（dsh）」归**「开发者」Tab**；「关于与更新」归**「帮助」Tab**。

**卡片内折叠（v1.5.0 后续整理）**：Tab 分组解决了「一屏看到底」，但组内仍有几张超长卡片。沿用既有的 `.fold` + `.link-btn` + `v-if` 折叠模式（与「用量与账本」的账本明细、素材包、使用说明同一套），把低频项收进折叠：

| 折叠态 | 位置 | 默认 | 收起原因 |
|---|---|---|---|
| `toolOpen.credentials` | 「数据」Tab → 凭据卡 | 收起 | 凭据填一次就不动，日常进这个 Tab 多半是为了清数据 / 备份 |
| `lookFolds.bubble` | 「外观」Tab → 挂件外观卡「气泡与文案」（主题 · 峰谷 · 思考气泡 · 报时 · 菜单按钮） | 收起 | 低频项 |
| `lookFolds.sound` | 「外观」Tab → 挂件外观卡「音效」 | 收起 | 开关 / 音色 / 音量设一次就不动 |
| `galleryFolds.skins` | 「资源」Tab → 形象卡 | 收起 | 合并后的形象卡上段网格 + 下段「可下载形象」（随包内置 + 共享角色）很长；收起后只留卡头与一行统计 |
| `galleryFolds.sounds` | 「资源」Tab → 音效卡 | 收起 | 合并后的音效卡上段六槽位 + 下段「可下载音效」（45 段）很长，装过就不再看；与形象卡同一套折叠模式 |

> **`assetFolds.builtin` 已删除**：「内置资源与下载源」卡在 v1.13.x 三卡合并中被拆掉 —— 形象部分并入「形象」卡、音色试听迁到「挂件外观 → 音色」。折叠态随之从父级 `assetFolds` 移除，形象 / 音效改由子组件私有 `galleryFolds`（`{skins:false, sounds:false}`）持有。**父级 `assetFolds` 整个删除**，App.vue 不再下发 `soundsFold` / 不再接 `toggle-sounds-fold`。搜索命中该卡时 `galleryOpen()` 无条件返回 `true` 强制展开（不再靠父级 `watch(searchHits)` 置折叠态）。

「挂件外观」卡折叠外只留**大小**与**形象**（含三条 select 提示 `hint`）—— 这两项最常改。凭据卡由裸 `<h2>` 改为折叠面板后，卡内两个教程块改用 `.guide2` 样式（比外层 `.guide` 再退一层，靠左侧 2px 强调色条表示层级），并为 `.guide > .link-btn:first-child` 去掉顶部留白。

通过 `window.services` 调用：`getConfig/onConfigChange/saveConfig/getSecrets/saveSecrets/saveMailSecrets/sendTestMail/testNotify/testApiKey/testPlatformToken/getUsageHistory/getUsageDetail/getTodayModels/calibrateTodayUsage/exportUsageCsv/importUsageCsv/getModelTemplates/getModelsConfig/saveModel/removeModel/setMainModel/testModel/refreshModels/getSounds/getSoundData/pickSoundFile/importSoundFromData/importSound/removeSound/getSkin/getSkinData/listSkins/setSkinCurrent/pinSkin/pickImageFile/importSkinFromData/importSkin/removeSkin/listBubbles/pickBubbleFile/importBubbleFromData/removeBubble/showWidget/hideWidget/resetWidgetPosition/isWidgetVisible/ensureWidget/getWidgetError/copyText/redirectHotKeySetting`，以及 dsh 系列（`dshStatus/dshStart/dshStop/dshRestart/dshUpdate/dshListVersions/dshLoadNotes/dshOpenWeb/dshClearLog/dshRemovePlugin/dshCleanNpxCache/dshLockStale/dshLockClear/dshPickNodeDir/diagnoseDsh/clearDshDiagnoseCache`；**`dshLoadNotes(force)`** —— 「版本说明」对外入口，结果落进宿主 `state.notes`、由快照的 `notes` / `notesBusy` 回传（设置页必须轮询，不能把返回值当结果）；**`diagnoseDsh`** —— 五项只读检查统一入口，返回 `DshDiagnoseResult`（含 `cached` 标记是否命中 60s TTL）；`clearDshDiagnoseCache` 由「重新诊断」的 `force:true` 覆盖，另留作配置变更后主动失效）、备份恢复系列（`backupExport/backupPick/backupApply/backupCancel`）、素材包系列（`assetsExport/assetsPick/assetsApply/assetsCancel`）、GitHub 加速系列（`ghAccelStatus/ghAccelTrace/ghAccelScanConflicts/ghAccelEnable/ghAccelDisable/ghAccelRefreshIps/ghAccelVerifyIps/ghAccelOpLogs/ghAccelClearOpLogs/ghAccelProbe/ghAccelSources`，其中 **`ghAccelStatus` 与 `ghAccelScanConflicts` 返回 Promise**（读 hosts 走异步 fs，设置页侧必须 `await`）；**`ghAccelSources`** —— 源清单属 hosts 模块的领域知识，设置页经它拿 `{all,order,custom,max}`，不自己抄 URL 清单）、**`redirectToMarket(keyword)`**（→ 宿主 `utools.redirect` 跳插件市场搜索页，指令名按**前缀匹配**，故关键词用「鲸鱼余额挂件」而非「小鲸鱼余额挂件」—— 后者会被自家 `小鲸鱼余额` 前缀吃掉、直接打开本插件；`utools.redirect` 失败返回 false，由设置页回落到 `openExternal`）、**专注与待办系列**（`todoGet/todoLimits/todoAdd/todoRename/todoSetDone/todoRemove/todoClearDone/todoFocus/focusStats/onTodoChange/onFocusChange`；读侧 `todoGet()` 回 `{items,focusId}`、`todoLimits()` 回 `{textMax,max}`（宿主 `TODO_TEXT_MAX` / `TODO_MAX`，设置页不抄副本）、`focusStats(days)` 回 `{series,today,total,streak,days}`；写侧 `todoAdd/todoRename/todoSetDone/todoRemove/todoClearDone/todoFocus` 统一回 `{ok,error?,todo}` —— **失败也带最新快照**，设置页据此一次回填并原样展示宿主给的原因；`onTodoChange/onFocusChange` 各返回退订函数）与 `getTaskbarState/getDebugLog/openLogFile/clearAllData`。`copyText/redirectHotKeySetting` 均已**参数化**（默认「显示/隐藏挂件」，可传「切换鼠标穿透」）。
