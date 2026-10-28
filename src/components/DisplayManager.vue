<template>
  <Teleport to="body">
    <div v-if="visible" class="display-manager-overlay" @click.self="$emit('close')">
      <div class="display-manager-modal">
        <header class="modal-header">
          <h2>管理显示内容</h2>
          <button @click="$emit('close')" class="close-btn" title="关闭">×</button>
        </header>
        
        <div class="modal-body">
          <div v-for="tab in TABS" :key="tab.key" class="tab-section">
            <label class="tab-header">
              <input
                type="checkbox"
                :checked="!cfg.hiddenTabs?.includes(tab.key)"
                :disabled="isTabDisabled(tab)"
                @change="onTabToggle(tab.key, ($event.target as HTMLInputElement).checked)"
              />
              <span class="tab-label">{{ tab.label }}</span>
              <span v-if="isTabDisabled(tab)" class="tab-hint">
                （需要配置 dsh 环境）
              </span>
            </label>
            
            <div class="card-list" :class="{ disabled: cfg.hiddenTabs?.includes(tab.key) }">
              <div v-for="card in getCardsByTab(tab.key)" :key="card.key" class="card-item">
                <label :class="{ 'is-core': isCoreCard(card.key), disabled: cfg.hiddenTabs?.includes(tab.key) }">
                  <input
                    type="checkbox"
                    :checked="!isCardHidden(card.key)"
                    :disabled="isCoreCard(card.key) || cfg.hiddenTabs?.includes(tab.key)"
                    @change="onCardToggle(card.key, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="card-label">{{ card.label }}</span>
                  <span v-if="isCoreCard(card.key)" class="core-badge">核心，不可隐藏</span>
                </label>
                
                <p v-if="!isCoreCard(card.key) && getCardWarning(card.key)" class="card-warning">
                  ⚠ {{ getCardWarning(card.key) }}
                </p>
              </div>
            </div>
          </div>
        </div>
        
        <footer class="modal-footer">
          <button @click="onReset" class="reset-btn">恢复默认显示</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { CORE_CARDS, CARD_DEPENDENCIES } from '../constants/display'

const props = defineProps<{
  visible: boolean
  cfg: {
    hiddenTabs?: string[]
    hiddenCards?: string[]
    dshNodeDir?: string
  }
  TABS: readonly { key: string; label: string; desc: string; devOnly?: boolean }[]
  SEARCH_INDEX: Record<string, { label: string; tab: string; keys: string }>
}>()

const emit = defineEmits<{
  close: []
  update: [action: { type: 'tab' | 'card' | 'reset'; key?: string; hidden?: boolean }]
}>()

function getCardsByTab(tabKey: string) {
  return Object.entries(props.SEARCH_INDEX)
    .filter(([_, v]) => v.tab === tabKey)
    .map(([key, v]) => ({ key, label: v.label }))
}

function isCoreCard(key: string): boolean {
  return CORE_CARDS.includes(key)
}

function isCardHidden(key: string): boolean {
  if (isCoreCard(key)) return false
  if (props.cfg.hiddenCards?.includes(key)) return true
  const cardTab = props.SEARCH_INDEX[key]?.tab
  if (cardTab && props.cfg.hiddenTabs?.includes(cardTab)) return true
  return false
}

function isTabDisabled(tab: { key: string; devOnly?: boolean }): boolean {
  return !!tab.devOnly && !props.cfg.dshNodeDir
}

function getCardWarning(key: string): string {
  return CARD_DEPENDENCIES[key]?.warning || ''
}

function onTabToggle(tabKey: string, checked: boolean) {
  emit('update', { type: 'tab', key: tabKey, hidden: !checked })
}

function onCardToggle(cardKey: string, checked: boolean) {
  emit('update', { type: 'card', key: cardKey, hidden: !checked })
}

function onReset() {
  if (confirm('确定要恢复所有隐藏的 Tab 和卡片吗？')) {
    emit('update', { type: 'reset' })
  }
}
</script>

<style scoped>
.display-manager-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.display-manager-modal {
  background: var(--color-bg, #fff);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  width: 600px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.2s;
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border, #e0e0e0);
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--color-text-secondary, #666);
  padding: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: background 0.2s;
}

.close-btn:hover {
  background: var(--color-bg-secondary, #f5f5f5);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.tab-section {
  margin-bottom: 24px;
}

.tab-section:last-child {
  margin-bottom: 0;
}

.tab-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 12px;
  cursor: pointer;
}

.tab-header input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.tab-label {
  flex: 1;
}

.tab-hint {
  font-size: 12px;
  color: var(--color-text-secondary, #999);
  font-weight: normal;
}

.card-list {
  margin-left: 26px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.card-list.disabled {
  opacity: 0.5;
}

.card-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-item label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
}

.card-item label.disabled {
  cursor: not-allowed;
}

.card-item label.is-core {
  color: var(--color-text-secondary, #666);
}

.card-item input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.card-item input[type="checkbox"]:disabled {
  cursor: not-allowed;
}

.card-label {
  flex: 1;
}

.core-badge {
  font-size: 11px;
  padding: 2px 6px;
  background: var(--color-bg-secondary, #f0f0f0);
  border-radius: 3px;
  color: var(--color-text-secondary, #999);
}

.card-warning {
  margin: 0 0 0 24px;
  font-size: 12px;
  color: var(--color-text-secondary, #999);
  line-height: 1.5;
}

.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--color-border, #e0e0e0);
  display: flex;
  justify-content: flex-end;
}

.reset-btn {
  padding: 8px 16px;
  background: var(--color-bg-secondary, #f5f5f5);
  border: 1px solid var(--color-border, #e0e0e0);
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.2s;
}

.reset-btn:hover {
  background: var(--color-bg-hover, #e8e8e8);
}

/* 深色模式适配 */
:root.dark .display-manager-modal {
  background: var(--color-bg, #1e1e1e);
}

:root.dark .modal-header {
  border-bottom-color: var(--color-border, #333);
}

:root.dark .close-btn:hover {
  background: var(--color-bg-secondary, #2a2a2a);
}

:root.dark .core-badge {
  background: var(--color-bg-secondary, #2a2a2a);
}

:root.dark .modal-footer {
  border-top-color: var(--color-border, #333);
}

:root.dark .reset-btn {
  background: var(--color-bg-secondary, #2a2a2a);
  border-color: var(--color-border, #333);
}

:root.dark .reset-btn:hover {
  background: var(--color-bg-hover, #333);
}
</style>
