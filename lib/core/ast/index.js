/**
 * @module ast/index
 * @description 语言 AST 插件自动加载器
 *
 * 按 try/catch 逐个加载每个语言插件并注册到 AstAnalyzer。
 * 缺少对应 tree-sitter 包时静默跳过（优雅降级）。
 *
 * 使用方式:
 *   import '../core/ast/index.js';  // 副作用: 注册所有可用语言插件
 *
 * 或按需:
 *   import { loadPlugins } from '../core/ast/index.js';
 *   await loadPlugins();
 */

import { registerLanguage } from '../AstAnalyzer.js';

let _loaded = false;

/**
 * 重置加载标志，允许 loadPlugins() 再次执行
 * 仅由 ensure-grammars.js 在安装新包后调用
 */
export function _resetForReload() {
  _loaded = false;
}

/**
 * 加载并注册所有可用的语言 AST 插件
 * 幂等 — 多次调用只执行一次
 */
export async function loadPlugins() {
  if (_loaded) {
    return;
  }
  _loaded = true;

  // ObjC
  try {
    const { plugin } = await import('./lang-objc.js');
    registerLanguage('objectivec', plugin);
  } catch {
    /* tree-sitter-objc not installed */
  }

  // Swift
  try {
    const { plugin } = await import('./lang-swift.js');
    registerLanguage('swift', plugin);
  } catch {
    /* tree-sitter-swift not installed */
  }

  // TypeScript
  try {
    const { plugin: tsPlugin, tsxPlugin } = await import('./lang-typescript.js');
    registerLanguage('typescript', tsPlugin);
    if (tsxPlugin) {
      registerLanguage('tsx', tsxPlugin);
    }
  } catch {
    /* tree-sitter-typescript not installed */
  }

  // JavaScript
  try {
    const { plugin } = await import('./lang-javascript.js');
    registerLanguage('javascript', plugin);
  } catch {
    /* tree-sitter-javascript not installed */
  }

  // Python
  try {
    const { plugin } = await import('./lang-python.js');
    registerLanguage('python', plugin);
  } catch {
    /* tree-sitter-python not installed */
  }

  // Java
  try {
    const { plugin } = await import('./lang-java.js');
    registerLanguage('java', plugin);
  } catch {
    /* tree-sitter-java not installed */
  }

  // Kotlin
  try {
    const { plugin } = await import('./lang-kotlin.js');
    registerLanguage('kotlin', plugin);
  } catch {
    /* tree-sitter-kotlin not installed */
  }

  // Go
  try {
    const { plugin } = await import('./lang-go.js');
    registerLanguage('go', plugin);
  } catch {
    /* tree-sitter-go not installed */
  }

  // Dart
  try {
    const { plugin } = await import('./lang-dart.js');
    registerLanguage('dart', plugin);
  } catch {
    /* tree-sitter-dart not installed */
  }
}

// 自动加载（ESM 模块顶层 await）
await loadPlugins();
