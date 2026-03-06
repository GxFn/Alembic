/**
 * @module enhancement/index
 * @description Enhancement Pack 自动加载器与 Registry 初始化
 *
 * 使用方式:
 *   import { getEnhancementRegistry } from '../core/enhancement/index.js';
 *   const registry = getEnhancementRegistry();
 *   const packs = registry.resolve(primaryLang, detectedFrameworks);
 */

import { EnhancementRegistry } from './EnhancementRegistry.js';

let _instance: any = null;

/**
 * 获取全局 EnhancementRegistry 单例
 * 注意: 首次访问前必须调用 initEnhancementRegistry() 完成异步加载
 * 如果未初始化, 返回空 Registry（不会抛错, 但 resolve() 结果为空）
 * @returns {EnhancementRegistry}
 */
export function getEnhancementRegistry() {
  if (_instance) {
    return _instance;
  }
  _instance = new EnhancementRegistry();
  // 同步路径无法加载 ESM 动态 import — 返回空 Registry
  // 使用方应确保先调用 initEnhancementRegistry()
  return _instance;
}

/**
 * 异步初始化 — 加载所有增强包
 * 需要在使用 resolve() 之前调用
 */
export async function initEnhancementRegistry() {
  if (_instance && _instance.all().length > 0) {
    return _instance;
  }
  _instance = new EnhancementRegistry();

  const packImports = [
    import('./react-enhancement.js'),
    import('./nextjs-enhancement.js'),
    import('./vue-enhancement.js'),
    import('./node-server-enhancement.js'),
    import('./django-enhancement.js'),
    import('./fastapi-enhancement.js'),
    import('./ml-enhancement.js'),
    import('./langchain-enhancement.js'),
    import('./spring-enhancement.js'),
    import('./android-enhancement.js'),
    import('./go-web-enhancement.js'),
    import('./go-grpc-enhancement.js'),
    import('./rust-web-enhancement.js'),
    import('./rust-tokio-enhancement.js'),
  ];

  const results = await Promise.allSettled(packImports);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.pack) {
      _instance.register(result.value.pack);
    }
  }

  return _instance;
}

// Re-exports
export { EnhancementPack } from './EnhancementPack.js';
export { EnhancementRegistry } from './EnhancementRegistry.js';
