/**
 * @module ast/ensure-grammars
 * @description 检查 .wasm 语法文件可用性
 *
 * 迁移至 web-tree-sitter (WASM) 后，不再需要运行时 npm install。
 * 所有 .wasm 文件随包一起发布在 resources/grammars/。
 * 此模块保留旧接口以兼容调用方，但内部逻辑改为检查 .wasm 文件。
 *
 * 使用方式:
 *   import { ensureGrammars } from '../core/ast/ensure-grammars.js';
 *   const result = await ensureGrammars(['typescript', 'javascript'], { logger });
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageService } from '../../shared/LanguageService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** .wasm 文件存放目录 */
const GRAMMARS_DIR = path.resolve(__dirname, '..', '..', '..', 'resources', 'grammars');

/**
 * 语言 ID → .wasm 文件名映射
 */
const LANG_TO_WASM = {
  objectivec: 'tree-sitter-objc.wasm',
  swift: 'tree-sitter-swift.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  go: 'tree-sitter-go.wasm',
  dart: 'tree-sitter-dart.wasm',
  rust: 'tree-sitter-rust.wasm',
};

/**
 * 检查 .wasm 文件是否存在
 */
function isWasmAvailable(wasmFileName) {
  return fs.existsSync(path.join(GRAMMARS_DIR, wasmFileName));
}

/**
 * 检查所需语言的 .wasm 文件是否就绪
 *
 * 保持旧接口签名以兼容 bootstrap 等调用方。
 * WASM 模式下不会执行 npm install —— 文件随包分发。
 *
 * @param {string[]} detectedLanguages - 检测到的语言列表
 * @param {object} [options]
 * @param {object} [options.logger] - Logger 实例（可选）
 * @returns {Promise<{installed: string[], skipped: string[], failed: string[], alreadyAvailable: string[]}>}
 */
export async function ensureGrammars(detectedLanguages, options = {}) {
  const { logger } = options;

  const result = {
    installed: [], // WASM 模式下始终为空（不再运行时安装）
    skipped: [],
    failed: [],
    alreadyAvailable: [],
  };

  if (!detectedLanguages || detectedLanguages.length === 0) {
    return result;
  }

  for (const lang of detectedLanguages) {
    const wasmFile = LANG_TO_WASM[lang];
    if (!wasmFile) {
      result.skipped.push(lang);
      continue;
    }

    if (isWasmAvailable(wasmFile)) {
      result.alreadyAvailable.push(lang);
    } else {
      result.failed.push(lang);
      logger?.warn?.(`[ensure-grammars] Missing .wasm file: ${wasmFile} for language "${lang}"`);
    }
  }

  if (result.failed.length > 0) {
    logger?.warn?.(
      `[ensure-grammars] ${result.failed.length} grammar(s) missing. ` +
      `Expected in: ${GRAMMARS_DIR}`
    );
  } else {
    logger?.info?.('[ensure-grammars] All required grammar .wasm files available');
  }

  return result;
}

/**
 * 在安装新包后重新加载 AST 插件
 * 由于 loadPlugins() 是幂等的（_loaded 标志），需要重置标志后重新加载
 */
export async function reloadPlugins() {
  const astIndex = await import('./index.js');
  if (typeof astIndex._resetForReload === 'function') {
    astIndex._resetForReload();
  }
  await astIndex.loadPlugins();
}

/**
 * 从文件扩展名统计推断需要的语言列表
 *
 * @param {Record<string, number>} langStats - { swift: 120, m: 80, ts: 200 }
 * @returns {string[]} 需要的语言 ID 列表
 */
export function inferLanguagesFromStats(langStats) {
  const bareMap = LanguageService.bareExtToLangMap;

  const langs = new Set();
  for (const ext of Object.keys(langStats)) {
    const lang = ext === 'tsx' ? 'tsx' : bareMap[ext];
    if (lang) {
      langs.add(lang);
    }
  }
  return [...langs];
}
