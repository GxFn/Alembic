/**
 * @module discovery/index
 * @description ProjectDiscoverer 系统入口 - 初始化 Registry 并注册所有 Discoverer
 */

import { SpmDiscoverer } from '../../platform/ios/spm/SpmDiscoverer.js';
import { DartDiscoverer } from './DartDiscoverer.js';
import { DiscovererRegistry } from './DiscovererRegistry.js';
import { GenericDiscoverer } from './GenericDiscoverer.js';
import { GoDiscoverer } from './GoDiscoverer.js';
import { JvmDiscoverer } from './JvmDiscoverer.js';
import { NodeDiscoverer } from './NodeDiscoverer.js';
import { PythonDiscoverer } from './PythonDiscoverer.js';
import { RustDiscoverer } from './RustDiscoverer.js';

/** @type {DiscovererRegistry|null} */
let _registry: DiscovererRegistry | null = null;

/**
 * 获取全局 DiscovererRegistry 单例
 * @returns {DiscovererRegistry}
 */
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
      .register(new GenericDiscoverer());
  }
  return _registry;
}

/**
 * 重置 Registry（仅用于测试）
 */
export function resetDiscovererRegistry() {
  _registry = null;
}

export { SpmDiscoverer } from '../../platform/ios/spm/SpmDiscoverer.js';
export { DartDiscoverer } from './DartDiscoverer.js';
export { DiscovererRegistry } from './DiscovererRegistry.js';
export { GenericDiscoverer } from './GenericDiscoverer.js';
export { GoDiscoverer } from './GoDiscoverer.js';
export { JvmDiscoverer } from './JvmDiscoverer.js';
export { NodeDiscoverer } from './NodeDiscoverer.js';
// Re-exports
export { ProjectDiscoverer } from './ProjectDiscoverer.js';
export { PythonDiscoverer } from './PythonDiscoverer.js';
export { RustDiscoverer } from './RustDiscoverer.js';
