/**
 * Memory Module — 统一导出
 *
 * Phase 2: MemoryCoordinator + legacy module re-exports
 * Phase 3: ActiveContext (合并 WorkingMemory + ReasoningTrace)
 * Phase 4: SessionStore (合并 EpisodicMemory + ToolResultCache)
 * Phase 5: PersistentMemory (继承 ProjectSemanticMemory + 增强)
 */

export { MemoryCoordinator } from './MemoryCoordinator.js';
export { ActiveContext } from './ActiveContext.js';
export { SessionStore } from './SessionStore.js';
export { PersistentMemory } from './PersistentMemory.js';
