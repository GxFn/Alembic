/**
 * @module enhancement/index
 * @description Enhancement Pack 自动加载器与 Registry 初始化
 *
 * 使用方式:
 *   import { getEnhancementRegistry } from '../core/enhancement/index.js';
 *   const registry = getEnhancementRegistry();
 *   const packs = registry.resolve(primaryLang, detectedFrameworks);
 */

import { EnhancementRegistry } from '@alembic/core/core/enhancement/EnhancementRegistry';

let _instance: EnhancementRegistry | null = null;

/**
 * 获取全局 EnhancementRegistry 单例
 * 注意: 首次访问前必须调用 initEnhancementRegistry() 完成异步加载
 * 如果未初始化, 返回空 Registry（不会抛错, 但 resolve() 结果为空）
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
    import('@alembic/core/core/enhancement/react-enhancement'),
    import('@alembic/core/core/enhancement/nextjs-enhancement'),
    import('@alembic/core/core/enhancement/vue-enhancement'),
    import('@alembic/core/core/enhancement/node-server-enhancement'),
    import('@alembic/core/core/enhancement/django-enhancement'),
    import('@alembic/core/core/enhancement/fastapi-enhancement'),
    import('@alembic/core/core/enhancement/ml-enhancement'),
    import('@alembic/core/core/enhancement/langchain-enhancement'),
    import('@alembic/core/core/enhancement/spring-enhancement'),
    import('@alembic/core/core/enhancement/android-enhancement'),
    import('@alembic/core/core/enhancement/go-web-enhancement'),
    import('@alembic/core/core/enhancement/go-grpc-enhancement'),
    import('@alembic/core/core/enhancement/rust-web-enhancement'),
    import('@alembic/core/core/enhancement/rust-tokio-enhancement'),
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
export { EnhancementPack } from '@alembic/core/core/enhancement/EnhancementPack';
export { EnhancementRegistry } from '@alembic/core/core/enhancement/EnhancementRegistry';
