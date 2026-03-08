/**
 * @module ast/parser-init
 * @description web-tree-sitter 初始化器
 *
 * 统一管理 WASM 版 Parser 的生命周期：
 *   1. 调用 Parser.init() 初始化 WASM 运行时（仅一次）
 *   2. 加载 .wasm 语法文件为 Language 对象
 *   3. 提供同步的 Parser 构造与语言设置 API
 *
 * 所有 async 操作（init + wasm 加载）集中在 loadPlugins() 阶段完成，
 * 下游 analyzeFile / findCallExpressions 等保持同步调用。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RESOURCES_DIR } from '../../shared/package-root.js';

/** 预编译 .wasm 文件存放目录 */
const GRAMMARS_DIR = path.resolve(RESOURCES_DIR, 'grammars');

let Parser: any = null;
/** web-tree-sitter 模块命名空间 — Language.load 在这里 */
let _namespace: any = null;
let _initialized = false;

/**
 * 初始化 web-tree-sitter WASM 运行时
 * 幂等 — 多次调用只执行一次
 */
export async function initParser() {
  if (_initialized) {
    return;
  }

  try {
    // web-tree-sitter ESM: 导出 { Parser, Language, ... } 命名空间
    const mod = await import('web-tree-sitter');
    _namespace = mod.default || mod;
    // v0.25 导出 { Parser, Language, ... }，需要提取 Parser 类
    Parser = typeof _namespace === 'function' ? _namespace : _namespace.Parser;
    await Parser.init();
    _initialized = true;
  } catch {
    // web-tree-sitter 不可用时优雅降级
    Parser = null;
    _initialized = false;
  }
}

/**
 * 获取 Parser 构造函数
 * @returns {typeof import('web-tree-sitter') | null}
 */
export function getParserClass() {
  return Parser;
}

/**
 * 检查 parser 是否已初始化
 */
export function isParserReady() {
  return _initialized && Parser !== null;
}

/**
 * 从 resources/grammars/ 加载指定语言的 .wasm 文件
 * @param {string} wasmFileName 如 'tree-sitter-javascript.wasm'
 * @returns {Promise<object|null>} Language 对象，失败返回 null
 */
export async function loadLanguageWasm(wasmFileName: any) {
  if (!_initialized || !_namespace) {
    return null;
  }

  const wasmPath = path.join(GRAMMARS_DIR, wasmFileName);
  try {
    // 自行读取 wasm 文件为 Uint8Array，绕过 ESM 下 __require("fs/promises") 的兼容问题
    const buffer = await readFile(wasmPath);
    const Language = _namespace.Language || Parser.Language;
    return await Language.load(new Uint8Array(buffer));
  } catch {
    return null;
  }
}
