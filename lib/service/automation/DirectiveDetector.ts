/**
 * DirectiveDetector - 文件内指令检测器
 *
 * 检测 // as:c（创建）、// as:s（搜索）、// as:a（审计）等指令
 * V2 ESM 版本，对应 V1 DirectiveDetector.js
 */

import { stripTriggerPrefix, TRIGGER_SYMBOL } from '../../infrastructure/config/TriggerSymbol.js';
import { LanguageService } from '../../shared/LanguageService.js';

/**
 * 指令标记常量
 */
export const MARKS = {
  HEADER_INCLUDE: '// autosnippet:include ',
  HEADER_IMPORT: '// autosnippet:import ',
  HEADER_INCLUDE_SHORT: '// as:include ',
  HEADER_IMPORT_SHORT: '// as:import ',
  CREATE_SHORT: '// as:create',
  CREATE_ALIAS: '// as:c',
  AUDIT_SHORT: '// as:audit',
  AUDIT_ALIAS: '// as:a',
  SEARCH_SHORT: '// as:search',
  SEARCH_LONG: '// autosnippet:search',
  SEARCH_ALIAS: '// as:s',
  ALINK: 'alink',
};

/**
 * 正则表达式
 */
export const REGEX = {
  CREATE_LINE: /^\/\/\s*as:(?:create|c)(?:\s+(-[cf]))?\s*$/,
  CREATE_REMOVE: /^@?\s*\/\/\s*as:(?:create|c)(?:\s+-[cf])?\s*\r?\n?/gm,
  HEADER_OBJC:
    /^@?\/\/\s*(?:autosnippet|as):include\s+(?:<([A-Za-z0-9_]+)\/([A-Za-z0-9_+.-]+\.h)>|"([A-Za-z0-9_+./-]+\.h)")(\s+.+)?$/,
  HEADER_SWIFT: /^@?\/\/\s*(?:autosnippet|as):import\s+\w+$/,
  IMPORT_OBJC: /^#import\s*<[A-Za-z0-9_]+\/[A-Za-z0-9_+.-]+\.h>$/,
  IMPORT_SWIFT: /^import\s*\w+$/,
  SEARCH_MARK: /\/\/\s*(?:autosnippet|as):(?:search|s)(\s|$)/,
};

/**
 * 推断文件语言 —— 委托给 LanguageService
 * @param {string} filename
 * @returns {string}
 */
function _inferLanguage(filename: string) {
  return LanguageService.inferLang(filename);
}

/**
 * 检测文件内容中的所有触发指令
 *
 * @param {string} data 文件内容
 * @param {string} filename 文件名
 * @returns {{ importArray: string[], headerLine: string|null, alinkLine: string|null,
 *             createLine: string|null, createOption: string|null,
 *             guardLine: string|null, searchLine: string|null, isSwift: boolean, language: string }}
 */
export function detectTriggers(data: string, filename: string) {
  const language = _inferLanguage(filename);
  const isSwift = language === 'swift';
  // Import/header 自动插入目前仅支持 ObjC/Swift（Xcode 工作流）
  const isApple = isSwift || language === 'objectivec';
  const currImportReg = isSwift ? REGEX.IMPORT_SWIFT : REGEX.IMPORT_OBJC;
  const _currHeaderReg = isSwift ? REGEX.HEADER_SWIFT : REGEX.HEADER_OBJC;

  const triggers = {
    importArray: [] as string[],
    headerLine: null as string | null,
    alinkLine: null as string | null,
    createLine: null as string | null,
    createOption: null as string | null,
    guardLine: null as string | null,
    searchLine: null as string | null,
    isSwift, // backward compat
    language, // v3.1 多语言标识
  };

  const lines = data.split('\n');
  for (const line of lines) {
    const lineVal = line.trim();
    const normalizedLineVal = stripTriggerPrefix(lineVal);

    // import 收集（仅 ObjC/Swift — Xcode 头文件工作流）
    if (isApple && currImportReg.test(lineVal)) {
      triggers.importArray.push(lineVal);
    }

    // header 指令
    if (_isHeaderDirective(normalizedLineVal)) {
      triggers.headerLine = normalizedLineVal;
    }

    // alink 指令
    if (lineVal.startsWith(TRIGGER_SYMBOL) && lineVal.endsWith(TRIGGER_SYMBOL + MARKS.ALINK)) {
      triggers.alinkLine = lineVal;
    }

    // create 指令
    const createMatch = normalizedLineVal.match(REGEX.CREATE_LINE);
    if (createMatch) {
      triggers.createLine = lineVal;
      triggers.createOption = createMatch[1] === '-c' ? 'c' : createMatch[1] === '-f' ? 'f' : null;
    }

    // guard/audit 指令
    if (_isGuardDirective(normalizedLineVal)) {
      triggers.guardLine = normalizedLineVal;
    }

    // search 指令
    if (_isSearchDirective(normalizedLineVal)) {
      triggers.searchLine = normalizedLineVal;
    }
  }

  return triggers;
}

function _isHeaderDirective(line: string) {
  return (
    line.startsWith(MARKS.HEADER_INCLUDE) ||
    line.startsWith(MARKS.HEADER_IMPORT) ||
    line.startsWith(MARKS.HEADER_INCLUDE_SHORT) ||
    line.startsWith(MARKS.HEADER_IMPORT_SHORT)
  );
}

function _isGuardDirective(line: string) {
  // 精确匹配: // as:audit 或 // as:a，后面只能是空格或行尾
  return /^\/\/\s*as:(?:audit|a)(?:\s|$)/.test(line);
}

function _isSearchDirective(line: string) {
  return (
    line.startsWith(MARKS.SEARCH_SHORT) ||
    line.startsWith(MARKS.SEARCH_LONG) ||
    line.startsWith(MARKS.SEARCH_ALIAS)
  );
}
