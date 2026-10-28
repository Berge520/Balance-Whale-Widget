# 自定义显示功能方案 v1.0

## 一、背景与目标

### 1.1 背景

当前设置页共有 **8 个 Tab**（外观/窗口/用量/提醒/资源/数据/帮助/开发者），包含 **25 张卡片**。不同用户的使用场景差异较大：
- 普通用户可能只关注"外观 + 用量"
- 高级用户会用到"提醒 + 资源"
- 开发者会用到"开发者 Tab"的 dsh 系列功能

多数用户面对 25 张卡片时会感到信息过载，需要一个自定义显示的功能来降噪。

### 1.2 目标

实现 **Tab 级 + 卡片级** 的两层自定义可见性控制：
1. 用户可以隐藏整个 Tab（该 Tab 下所有卡片都不显示）
2. 用户可以在可见 Tab 内隐藏特定卡片
3. 搜索系统适配：命中隐藏卡片时显示"已隐藏"标记 + "取消隐藏"按钮
4. 配置自动纳入备份/恢复/清除数据流程
5. 提供"恢复默认显示"一键重置

### 1.3 设计原则

- **用户可控**：所有隐藏操作都可逆，提供明确的恢复入口
- **数据安全**：核心功能卡片不可隐藏（凭据卡/WindowView/LookView）
- **透明提示**：隐藏卡片时显示依赖警告，搜索命中隐藏卡片时明确标记
- **零额外存储**：复用现有 `cfg` 配置对象，自动纳入备份/恢复

---

## 二、数据结构设计

### 2.1 新增配置字段

在 `public/preload/lib/store.js` 的 `defaultConfig()` 中新增：

```javascript
function defaultConfig() {
  return {
    // ... 现有字段（约 80+ 个）
    hiddenTabs: [],    // 隐藏的 Tab key 列表，如 ['dev', 'assets']
    hiddenCards: [],   // 隐藏的卡片 key 列表，如 ['bubbleCustom', 'dshDiagnose']
  }
}
```

**存储位置**：`utools.dbStorage.getItem('whale:config')`

**归一化逻辑**（`readConfig()` 中）：
```javascript
cfg.hiddenTabs = Array.isArray(cfg.hiddenTabs) ? cfg.hiddenTabs : []
cfg.hiddenCards = Array.isArray(cfg.hiddenCards) ? cfg.hiddenCards : []
```

### 2.2 核心卡片白名单（前端硬编码）

```typescript
// src/App.vue
const CORE_CARDS = ['credentials', 'window', 'look'] as const
```

这三张卡片在管理界面中始终勾选，灰显不可取消，旁边标注"核心，不可隐藏"。

### 2.3 卡片依赖关系表（前端硬编码）

```typescript
// src/App.vue
const CARD_DEPENDENCIES: Record<string, { label: string; warning: string }> = {
  bubbleCustom: {
    label: '按压气泡（自定义泡泡）',
    warning: '隐藏后无法编辑按压气泡，但已配置的气泡仍正常显示'
  },
  models: {
    label: '模型与余额',
    warning: '隐藏后无法管理多厂商模型，但挂件仍显示内置 DeepSeek 余额'
  },
  usage: {
    label: '用量与账本',
    warning: '隐藏后用量趋势不可见，但挂件记账不受影响'
  },
  notify: {
    label: '提醒与通知',
    warning: '隐藏后提醒设置不可改，但已配置的提醒仍正常触发'
  },
  focus: {
    label: '专注与待办',
    warning: '隐藏后待办编辑不可用，但挂件菜单仍可勾选完成'
  },
  assetsOverview: {
    label: '资源概览',
    warning: '隐藏后无法查看素材占用与清理'
  },
  assetsSkins: {
    label: '形象',
    warning: '隐藏后无法更换挂件形象'
  },
  assetsBubbles: {
    label: '导入的气泡图',
    warning: '隐藏后无法管理自定义气泡图'
  },
  assetsSounds: {
    label: '音效',
    warning: '隐藏后无法管理自定义音效'
  },
  privacy: {
    label: '清除数据',
    warning: '隐藏后无法清除数据，建议保留'
  },
  backup: {
    label: '备份与恢复',
    warning: '隐藏后无法备份/恢复配置'
  },
  help: {
    label: '使用帮助',
    warning: '隐藏后无法查看帮助文档'
  },
  about: {
    label: '关于与更新',
    warning: '隐藏后无法检查更新'
  },
  ghAccel: {
    label: 'GitHub 加速',
    warning: '隐藏后无法编辑 hosts 方案'
  },
  dshMain: {
    label: 'DeepSeek Harness（dsh）',
    warning: '隐藏后无法启动/停止 dsh'
  },
  dshDiagnose: {
    label: 'dsh 环境诊断',
    warning: '隐藏后无法诊断 dsh 环境'
  },
  dshDump: {
    label: 'dsh 配置转储',
    warning: '隐藏后无法查看 dsh 配置差异'
  },
  dshExport: {
    label: 'dsh 全量导出',
    warning: '隐藏后无法导出 dsh 配置'
  },
  dshUsage: {
    label: 'dsh 用量统计',
    warning: '隐藏后无法查看 dsh 用量'
  },
  dshIsolate: {
    label: 'dsh 插件开关',
    warning: '隐藏后无法管理 dsh 插件隔离'
  },
  dshMarket: {
    label: 'dsh 插件市场',
    warning: '隐藏后无法浏览/安装 dsh 插件'
  },
  codex: {
    label: 'Codex 会话统计',
    warning: '隐藏后无法查看 Codex 用量'
  },
}
```

---

## 三、UI/UX 设计

### 3.1 管理界面入口

**位置**：Tab 栏右侧，搜索框左边，齿轮图标按钮。

```html
<nav class="tab-bar">
  <div class="tab-row">
    <button v-for="t in visibleTabs" ...>{{ t.label }}</button>
    <button class="display-manager-btn" @click="showDisplayManager = true" title="管理显示内容">
      <svg>...</svg> <!-- 齿轮图标 -->
    </button>
  </div>
  <div class="search-row">...</div>
  <p class="tab-desc">...</p>
</nav>
```

### 3.2 管理界面模态框

**结构**：

```
┌─────────────────────────────────────────────────┐
│  管理显示内容                              [×]  │
├─────────────────────────────────────────────────┤
│                                                 │
│  ☑ 外观                                         │
│    ☑ 挂件外观（核心，不可隐藏）                  │
│    ☐ 按压气泡（自定义泡泡）                      │
│      ⚠ 隐藏后无法编辑按压气泡，但已配置的气泡... │
│                                                 │
│  ☑ 窗口                                         │
│    ☑ 挂件窗口（核心，不可隐藏）                  │
│                                                 │
│  ☑ 用量                                         │
│    ☑ 用量与账本                                  │
│    ☑ 模型与余额                                  │
│                                                 │
│  ...                                            │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │  [恢复默认显示]                          │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
└─────────────────────────────────────────────────┘
```

**交互逻辑**：

1. **Tab 级开关**：
   - 取消勾选 Tab → 该 Tab 下所有卡片自动取消勾选（灰显不可选）
   - 勾选 Tab → 该 Tab 下所有卡片恢复为之前的状态（如果之前全部取消，则全部勾选）

2. **卡片级开关**：
   - 只在 Tab 可见时才能单独控制
   - 核心卡片始终勾选，灰显，旁边标注"核心，不可隐藏"
   - 非核心卡片隐藏时，下方显示警告文案

3. **恢复默认**：
   - 一键清空 `hiddenTabs` 和 `hiddenCards`
   - 弹出确认对话框："确定要恢复所有隐藏的 Tab 和卡片吗？"

4. **保存时机**：
   - 勾选/取消 → 立即调用 `services.saveConfig({ hiddenTabs, hiddenCards })`
   - 无需"确定"按钮（实时生效）

### 3.3 搜索结果适配

**场景 1：搜索命中隐藏卡片**

```
搜索 "dsh" → 结果列表：
  [dev · dsh 主控] (已隐藏) [取消隐藏]
  [dev · dsh 诊断] (已隐藏) [取消隐藏]
```

**实现**：
- `searchHits` 计算时不过滤隐藏卡片
- 渲染搜索结果时检查 `isCardHidden(key)`，显示"已隐藏"标记
- 点击"取消隐藏"→ 从 `hiddenCards` 移除该 key，自动从 `hiddenTabs` 移除其所属 Tab

**场景 2：搜索命中隐藏 Tab 里的卡片**

同上，但提示文案改为"该卡片所在 Tab 已隐藏"。

### 3.4 Tab 栏适配

**现有逻辑**：

```typescript
const visibleTabs = computed(() => {
  return TABS.filter(t => {
    if (t.devOnly && !cfg.dshNodeDir) return false
    return true
  })
})
```

**新增逻辑**：

```typescript
const visibleTabs = computed(() => {
  return TABS.filter(t => {
    if (t.devOnly && !cfg.dshNodeDir) return false
    if (cfg.hiddenTabs?.includes(t.key)) return false
    return true
  })
})
```

**边界情况**：当前 `activeTab` 被隐藏时，自动回退到 `'look'`（现有逻辑已支持）。

### 3.5 卡片渲染适配

**现有 `cardOn` 函数**：

```typescript
function cardOn(tab: string, key: string) {
  if (searchActive.value) return searchHits.value.includes(key)
  return activeTab.value === tab
}
```

**新增逻辑**：

```typescript
function cardOn(tab: string, key: string) {
  if (searchActive.value) return searchHits.value.includes(key)
  if (cfg.hiddenCards?.includes(key)) return false
  return activeTab.value === tab
}
```

**AssetsView 特殊处理**：现有代码已经把 `cardOn` 作为 prop 传入，内部逐段判定，无需改动。

---

## 四、实现细节

### 4.1 Phase 1：基础设施（1-2 天）

**4.1.1 `store.js`：新增配置字段**

文件：`public/preload/lib/store.js`

```javascript
// defaultConfig() 中新增
function defaultConfig() {
  return {
    // ... 现有字段
    hiddenTabs: [],
    hiddenCards: [],
  }
}

// readConfig() 中归一化
function readConfig() {
  // ... 现有逻辑
  cfg.hiddenTabs = Array.isArray(cfg.hiddenTabs) ? cfg.hiddenTabs : []
  cfg.hiddenCards = Array.isArray(cfg.hiddenCards) ? cfg.hiddenCards : []
  return cfg
}

// patchConfig() 中处理
function patchConfig(patch) {
  // ... 现有逻辑
  if (patch.hiddenTabs !== undefined) {
    cfg.hiddenTabs = Array.isArray(patch.hiddenTabs) ? patch.hiddenTabs : []
  }
  if (patch.hiddenCards !== undefined) {
    cfg.hiddenCards = Array.isArray(patch.hiddenCards) ? patch.hiddenCards : []
  }
  return writeConfig(cfg)
}
```

**4.1.2 `App.vue`：`visibleTabs` 过滤**

文件：`src/App.vue`

```typescript
const visibleTabs = computed(() => {
  return TABS.filter(t => {
    if (t.devOnly && !cfg.dshNodeDir) return false
    if (cfg.hiddenTabs?.includes(t.key)) return false
    return true
  })
})
```

**4.1.3 `App.vue`：`cardOn()` 过滤**

```typescript
function cardOn(tab: string, key: string) {
  if (searchActive.value) return searchHits.value.includes(key)
  if (cfg.hiddenCards?.includes(key)) return false
  return activeTab.value === tab
}
```

**4.1.4 `App.vue`：辅助函数**

```typescript
function isCardHidden(key: string): boolean {
  if (CORE_CARDS.includes(key as any)) return false
  if (cfg.hiddenCards?.includes(key)) return true
  const cardTab = SEARCH_INDEX[key]?.tab
  if (cardTab && cfg.hiddenTabs?.includes(cardTab)) return true
  return false
}

function toggleCardVisibility(key: string, hidden: boolean) {
  const newHiddenCards = [...(cfg.hiddenCards || [])]
  const idx = newHiddenCards.indexOf(key)
  if (hidden && idx === -1) {
    newHiddenCards.push(key)
  } else if (!hidden && idx !== -1) {
    newHiddenCards.splice(idx, 1)
  }
  services.saveConfig({ hiddenCards: newHiddenCards })
}

function toggleTabVisibility(tabKey: string, hidden: boolean) {
  const newHiddenTabs = [...(cfg.hiddenTabs || [])]
  const idx = newHiddenTabs.indexOf(tabKey)
  if (hidden && idx === -1) {
    newHiddenTabs.push(tabKey)
    // 同时隐藏该 Tab 下所有卡片
    const tabCards = Object.entries(SEARCH_INDEX)
      .filter(([_, v]) => v.tab === tabKey)
      .map(([k]) => k)
    const newHiddenCards = [...(cfg.hiddenCards || []), ...tabCards]
    services.saveConfig({ hiddenTabs: newHiddenTabs, hiddenCards: newHiddenCards })
  } else if (!hidden && idx !== -1) {
    newHiddenTabs.splice(idx, 1)
    services.saveConfig({ hiddenTabs: newHiddenTabs })
  }
}

function resetDisplayToDefault() {
  services.saveConfig({ hiddenTabs: [], hiddenCards: [] })
}
```

### 4.2 Phase 2：管理界面（2-3 天）

**4.2.1 新建 `DisplayManager.vue`**

文件：`src/components/DisplayManager.vue`

核心结构：

```vue
<template>
  <Teleport to="body">
    <div v-if="visible" class="display-manager-overlay" @click.self="$emit('close')">
      <div class="display-manager-modal">
        <header>
          <h2>管理显示内容</h2>
          <button @click="$emit('close')" class="close-btn">×</button>
        </header>
        
        <div class="modal-body">
          <div v-for="tab in TABS" :key="tab.key" class="tab-section">
            <label class="tab-header">
              <input
                type="checkbox"
                :checked="!cfg.hiddenTabs?.includes(tab.key)"
                :disabled="tab.devOnly && !cfg.dshNodeDir"
                @change="onTabToggle(tab.key, $event.target.checked)"
              />
              <span>{{ tab.label }}</span>
              <span v-if="tab.devOnly && !cfg.dshNodeDir" class="hint">
                （需要配置 dsh 环境）
              </span>
            </label>
            
            <div class="card-list">
              <div v-for="card in getCardsByTab(tab.key)" :key="card.key" class="card-item">
                <label :class="{ disabled: cfg.hiddenTabs?.includes(tab.key) }">
                  <input
                    type="checkbox"
                    :checked="!isCardHidden(card.key)"
                    :disabled="CORE_CARDS.includes(card.key) || cfg.hiddenTabs?.includes(tab.key)"
                    @change="onCardToggle(card.key, $event.target.checked)"
                  />
                  <span>{{ card.label }}</span>
                  <span v-if="CORE_CARDS.includes(card.key)" class="core-badge">
                    核心，不可隐藏
                  </span>
                </label>
                
                <p v-if="!CORE_CARDS.includes(card.key) && CARD_DEPENDENCIES[card.key]" class="warning">
                  ⚠ {{ CARD_DEPENDENCIES[card.key].warning }}
                </p>
              </div>
            </div>
          </div>
        </div>
        
        <footer>
          <button @click="onReset" class="reset-btn">恢复默认显示</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue'
import { TABS, SEARCH_INDEX, CORE_CARDS, CARD_DEPENDENCIES } from '../App.vue'

const props = defineProps({
  visible: Boolean,
  cfg: Object,
})

const emit = defineEmits(['close', 'update'])

function getCardsByTab(tabKey) {
  return Object.entries(SEARCH_INDEX)
    .filter(([_, v]) => v.tab === tabKey)
    .map(([key, v]) => ({ key, label: v.label }))
}

function isCardHidden(key) {
  if (CORE_CARDS.includes(key)) return false
  if (props.cfg.hiddenCards?.includes(key)) return true
  const cardTab = SEARCH_INDEX[key]?.tab
  if (cardTab && props.cfg.hiddenTabs?.includes(cardTab)) return true
  return false
}

function onTabToggle(tabKey, checked) {
  emit('update', { type: 'tab', key: tabKey, hidden: !checked })
}

function onCardToggle(cardKey, checked) {
  emit('update', { type: 'card', key: cardKey, hidden: !checked })
}

function onReset() {
  if (confirm('确定要恢复所有隐藏的 Tab 和卡片吗？')) {
    emit('update', { type: 'reset' })
  }
}
</script>
```

**4.2.2 `App.vue`：添加入口按钮**

```html
<nav class="tab-bar">
  <div class="tab-row">
    <button v-for="t in visibleTabs" ...>{{ t.label }}</button>
    <button class="display-manager-btn" @click="showDisplayManager = true" title="管理显示内容">
      <svg width="16" height="16" viewBox="0 0 16 16">
        <path d="M8 4.754a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5zM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13zM2.046 4.25a.75.75 0 0 1 1.06-.046l1.32 1.145a.75.75 0 0 1-.977 1.132l-1.32-1.145a.75.75 0 0 1-.083-1.086zm10.908 7.705a.75.75 0 0 1 1.06-.046l1.32 1.145a.75.75 0 0 1-.977 1.132l-1.32-1.145a.75.75 0 0 1-.083-1.086zM0 8a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 8zm13 0a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 13 8zM2.046 11.75a.75.75 0 0 1 1.06.046l1.32 1.145a.75.75 0 0 1-.977 1.132l-1.32-1.145a.75.75 0 0 1-.083-1.086zm10.908-7.705a.75.75 0 0 1 1.06.046l1.32 1.145a.75.75 0 0 1-.977 1.132l-1.32-1.145a.75.75 0 0 1-.083-1.086z" fill="currentColor"/>
      </svg>
    </button>
  </div>
  ...
</nav>

<DisplayManager
  :visible="showDisplayManager"
  :cfg="cfg"
  @close="showDisplayManager = false"
  @update="onDisplayManagerUpdate"
/>
```

**4.2.3 `App.vue`：处理更新事件**

```typescript
const showDisplayManager = ref(false)

function onDisplayManagerUpdate(action: { type: 'tab' | 'card' | 'reset', key?: string, hidden?: boolean }) {
  if (action.type === 'reset') {
    resetDisplayToDefault()
  } else if (action.type === 'tab' && action.key) {
    toggleTabVisibility(action.key, action.hidden!)
  } else if (action.type === 'card' && action.key) {
    toggleCardVisibility(action.key, action.hidden!)
  }
}
```

### 4.3 Phase 3：搜索适配（1 天）

**4.3.1 `App.vue`：搜索结果渲染**

```html
<div v-if="searchActive && searchHits.length" class="search-hits">
  <button
    v-for="k in searchHits"
    :key="k"
    type="button"
    class="search-hit-tag"
    :class="{ hidden: isCardHidden(k) }"
    @click="isCardHidden(k) ? toggleCardVisibility(k, false) : scrollToCard(k)"
  >
    {{ cardTabLabel(k) }} · {{ SEARCH_INDEX[k].label }}
    <span v-if="isCardHidden(k)" class="hidden-badge">已隐藏</span>
  </button>
</div>
```

**4.3.2 样式**

```css
.search-hit-tag.hidden {
  opacity: 0.6;
  border-style: dashed;
}

.hidden-badge {
  margin-left: 0.5em;
  padding: 0.1em 0.4em;
  background: var(--color-bg-secondary);
  border-radius: 3px;
  font-size: 0.85em;
}
```

### 4.4 Phase 4：依赖提示（1 天）

已在 4.2.1 中实现（`CARD_DEPENDENCIES` 表 + 警告文案渲染）。

### 4.5 Phase 5：帮助文档（0.5 天）

文件：`src/views/HelpView.vue`

```html
<section class="help-section">
  <h3>如何恢复隐藏的卡片？</h3>
  <p>如果您不小心隐藏了某个设置项，可以通过以下方式恢复：</p>
  <ol>
    <li>点击 Tab 栏右侧的 ⚙ 图标</li>
    <li>在弹出的"管理显示内容"窗口中，勾选需要显示的卡片</li>
    <li>点击窗口底部的"恢复默认显示"按钮可一键恢复所有隐藏项</li>
  </ol>
</section>
```

### 4.6 Phase 6：测试（1-2 天）

**4.6.1 单元测试**

- `store.js`：配置归一化、补丁写入
- `App.vue`：`visibleTabs` 过滤、`cardOn()` 过滤、`isCardHidden()` 判定

**4.6.2 集成测试**

- 备份/恢复：`hiddenTabs`/`hiddenCards` 是否正确包含
- 清除数据：勾选"配置"清除后，`hiddenTabs`/`hiddenCards` 是否重置
- 首次引导：不影响现有流程

**4.6.3 边界测试**

- 隐藏当前 Tab → 自动回退到 `'look'`
- 隐藏所有卡片 → 设置页空白，但管理界面可访问
- dev Tab 条件显示 → `dshNodeDir` 未配置时整行灰显

---

## 五、实现步骤与时间估算

| Phase | 任务 | 时间 | 依赖 |
|-------|------|------|------|
| 1 | 基础设施（store.js + App.vue 过滤逻辑） | 1-2 天 | 无 |
| 2 | 管理界面（DisplayManager.vue + 入口按钮） | 2-3 天 | Phase 1 |
| 3 | 搜索适配（结果标记 + 取消隐藏） | 1 天 | Phase 1 |
| 4 | 依赖提示（警告文案） | 1 天 | Phase 2 |
| 5 | 帮助文档 | 0.5 天 | 无 |
| 6 | 测试 | 1-2 天 | Phase 1-5 |
| **总计** | | **7-10 天** | |

---

## 六、关键设计决策总结

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 配置存储 | `cfg.hiddenTabs/hiddenCards` | 自动纳入备份/恢复/清除 |
| 不可隐藏卡 | 凭据、Window、Look | 隐藏会导致核心功能不可用 |
| 搜索命中隐藏卡 | 显示"已隐藏"标记 + 取消按钮 | 用户可能不知道卡片被隐藏 |
| 管理界面入口 | Tab 栏右侧齿轮图标 | 位置显眼，符合设置类操作直觉 |
| 卡片依赖提示 | 硬编码依赖表 + 警告文案 | 帮助用户理解隐藏的后果 |
| dev Tab 特殊处理 | 保持隐藏即使配置了 dshNodeDir | 用户主动隐藏应尊重其选择 |
| 保存时机 | 勾选即保存（实时生效） | 减少操作步骤，符合现代 UI 习惯 |

---

## 七、风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 用户隐藏所有卡片后无法操作 | 管理界面入口始终可见（在 Tab 栏，不受卡片隐藏影响） |
| 隐藏核心功能卡片导致困惑 | 核心卡片硬编码不可隐藏，灰显标注 |
| 搜索命中隐藏卡片用户不知道 | 显示"已隐藏"标记 + 一键取消隐藏 |
| 配置迁移（老用户升级） | `readConfig()` 归一化时默认为空数组，无需迁移脚本 |
| 备份文件体积增加 | `hiddenTabs`/`hiddenCards` 是字符串数组，体积可忽略 |

---

## 八、未来扩展

1. **卡片排序**：允许用户自定义卡片显示顺序
2. **Tab 排序**：允许用户自定义 Tab 显示顺序
3. **预设方案**：提供"简洁模式"、"开发者模式"等预设
4. **导入/导出配置**：单独导出显示偏好，方便多设备同步

---

**文档版本**：v1.0  
**最后更新**：2026-10-28  
**作者**：AI Assistant
