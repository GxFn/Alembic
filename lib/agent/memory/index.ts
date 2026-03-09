/**
 * Memory Module — 统一导出
 *
 * Phase 2: MemoryCoordinator + legacy module re-exports
 * Phase 3: ActiveContext (合并 WorkingMemory + ReasoningTrace)
 * Phase 4: SessionStore (合并 EpisodicMemory + ToolResultCache)
 * Phase 5: PersistentMemory (统一的持久化语义记忆)
 * Phase 6: MemoryStore / MemoryRetriever / MemoryConsolidator (PersistentMemory 子模块拆分)
 */

export { ActiveContext } from './ActiveContext.js';
export { MemoryConsolidator } from './MemoryConsolidator.js';
export { MemoryCoordinator } from './MemoryCoordinator.js';
export { MemoryRetriever } from './MemoryRetriever.js';

// PersistentMemory 子模块 — 内部拆分后的独立组件
export { MemoryStore } from './MemoryStore.js';
export { PersistentMemory } from './PersistentMemory.js';
export { SessionStore } from './SessionStore.js';
