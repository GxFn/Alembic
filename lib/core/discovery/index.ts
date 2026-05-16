/**
 * @module discovery/index
 * @description ProjectDiscoverer 系统入口 - 初始化 Registry 并注册所有 Discoverer
 */

import { CustomConfigDiscoverer } from '@alembic/core/core/discovery/CustomConfigDiscoverer';
import { DartDiscoverer } from '@alembic/core/core/discovery/DartDiscoverer';
import { DiscovererRegistry } from '@alembic/core/core/discovery/DiscovererRegistry';
import { GenericDiscoverer } from '@alembic/core/core/discovery/GenericDiscoverer';
import { GoDiscoverer } from '@alembic/core/core/discovery/GoDiscoverer';
import { JvmDiscoverer } from '@alembic/core/core/discovery/JvmDiscoverer';
import { NodeDiscoverer } from '@alembic/core/core/discovery/NodeDiscoverer';
import { PythonDiscoverer } from '@alembic/core/core/discovery/PythonDiscoverer';
import { RustDiscoverer } from '@alembic/core/core/discovery/RustDiscoverer';
import { SpmDiscoverer } from '@alembic/core/core/discovery/SpmDiscoverer';

let _registry: DiscovererRegistry | null = null;

/** 获取全局 DiscovererRegistry 单例 */
export function getDiscovererRegistry() {
  if (!_registry) {
    _registry = new DiscovererRegistry();
    _registry
      .register(new SpmDiscoverer())
      .register(new NodeDiscoverer())
      .register(new PythonDiscoverer())
      .register(new JvmDiscoverer())
      .register(new GoDiscoverer())
      .register(new DartDiscoverer())
      .register(new RustDiscoverer())
      .register(new CustomConfigDiscoverer())
      .register(new GenericDiscoverer());
  }
  return _registry;
}

/** 重置 Registry（仅用于测试） */
export function resetDiscovererRegistry() {
  _registry = null;
}

export { CustomConfigDiscoverer } from '@alembic/core/core/discovery/CustomConfigDiscoverer';
export { DartDiscoverer } from '@alembic/core/core/discovery/DartDiscoverer';
export {
  type ConflictResult,
  type DetectMatch,
  type DiscovererPreferenceData,
  detectConflict,
  loadPreference,
  promptDiscovererChoice,
  savePreference,
} from '@alembic/core/core/discovery/DiscovererPreference';
export { DiscovererRegistry } from '@alembic/core/core/discovery/DiscovererRegistry';
export { GenericDiscoverer } from '@alembic/core/core/discovery/GenericDiscoverer';
export { GoDiscoverer } from '@alembic/core/core/discovery/GoDiscoverer';
export { JvmDiscoverer } from '@alembic/core/core/discovery/JvmDiscoverer';
export { NodeDiscoverer } from '@alembic/core/core/discovery/NodeDiscoverer';
// Re-exports
export { ProjectDiscoverer } from '@alembic/core/core/discovery/ProjectDiscoverer';
export { PythonDiscoverer } from '@alembic/core/core/discovery/PythonDiscoverer';
export { RustDiscoverer } from '@alembic/core/core/discovery/RustDiscoverer';
export { SpmDiscoverer } from '@alembic/core/core/discovery/SpmDiscoverer';
