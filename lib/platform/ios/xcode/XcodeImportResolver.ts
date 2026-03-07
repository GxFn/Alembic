/**
 * XcodeImportResolver — import 语句解析、头文件搜索与三级去重
 *
 * 从 XcodeIntegration.js 拆分，负责：
 *   - import 语句解析（ObjC / Swift）
 *   - 头文件物理路径搜索
 *   - import 格式化（同 target / 跨 target）
 *   - 三级去重（精确 → 模块 → 相似文件名）
 *   - 模块名推断
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve as pathResolve, relative, sep } from 'node:path';

/**
 * 解析原始 header 字符串，提取 moduleName 和 headerName
 *
 * 支持格式：
 *   #import <Module/Header.h>  → { moduleName: 'Module', headerName: 'Header.h', isAngle: true }
 *   #import "Header.h"          → { moduleName: '', headerName: 'Header.h', isAngle: false }
 *   @import Module;             → { moduleName: 'Module', headerName: '', isAngle: false, isAtImport: true }
 *   import Module (Swift)       → { moduleName: 'Module', headerName: '', isAngle: false, isSwiftImport: true }
 *   Header.h                    → { moduleName: '', headerName: 'Header.h', isAngle: false, isRaw: true }
 */
export function parseHeaderString(header: string) {
  const t = header.trim();
  // #import <Module/Header.h>
  let m = t.match(/^#(?:import|include)\s+<([^/> ]+)\/([^>]+)>/);
  if (m) {
    return { moduleName: m[1], headerName: m[2], isAngle: true };
  }
  // #import <Module>  (framework umbrella)
  m = t.match(/^#(?:import|include)\s+<([^>]+)>/);
  if (m) {
    return { moduleName: m[1], headerName: '', isAngle: true };
  }
  // #import "Header.h" or #import "Dir/Header.h"
  m = t.match(/^#(?:import|include)\s+"([^"]+)"/);
  if (m) {
    const parts = m[1].split('/');
    return {
      moduleName: '',
      headerName: parts[parts.length - 1],
      isAngle: false,
      quotedPath: m[1],
    };
  }
  // @import Module;
  m = t.match(/^@import\s+(\w+)/);
  if (m) {
    return { moduleName: m[1], headerName: '', isAngle: false, isAtImport: true };
  }
  // import Module (Swift)
  m = t.match(/^import\s+(\w+)/);
  if (m && !['class', 'struct', 'enum', 'protocol', 'func', 'var', 'let'].includes(m[1])) {
    return { moduleName: m[1], headerName: '', isAngle: false, isSwiftImport: true };
  }
  // 裸 header 名: Header.h
  if (/\.(h|hpp|hh)$/i.test(t)) {
    return { moduleName: '', headerName: t, isAngle: false, isRaw: true };
  }
  return { moduleName: '', headerName: t, isAngle: false, isRaw: true };
}

/**
 * 在 target 源目录中搜索头文件，返回相对于当前文件的路径
 *
 * 搜索策略：
 *   1. 当前文件同目录
 *   2. 从项目根目录递归查找（最多深度 6 层，优先 Sources/ 下）
 *   3. 找到后计算相对于当前文件目录的路径
 *
 * @param {string} headerName 头文件名 (如 "Foo.h")
 * @param {string} currentFilePath 当前正在编辑的文件绝对路径
 * @param {string} [projectRoot] 项目根目录
 * @returns {string|null} 相对路径 (如 "Foo.h" 或 "../SubDir/Foo.h")，null 表示未找到
 */
export function findHeaderRelativePath(
  headerName: string,
  currentFilePath: string,
  projectRoot: string | null
) {
  if (!headerName || !currentFilePath) {
    return null;
  }
  try {
    const currentDir = dirname(currentFilePath);

    // 1. 同目录检查
    const sameDir = pathResolve(currentDir, headerName);
    if (existsSync(sameDir)) {
      return headerName;
    }

    // 2. 向上找 Sources/ 或 target 根目录，在其下递归搜索
    const searchRoots: string | any[] = [];
    if (projectRoot) {
      const sourcesDir = pathResolve(projectRoot, 'Sources');
      if (existsSync(sourcesDir)) {
        searchRoots.push(sourcesDir);
      }
      searchRoots.push(projectRoot);
    }
    // 也从当前文件向上找 Sources 目录
    let dir = currentDir;
    for (let i = 0; i < 8; i++) {
      const base = basename(dir);
      if (base === 'Sources' || base === 'Source' || base === 'src') {
        searchRoots.unshift(dir);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }

    // 在 searchRoots 中递归查找 headerName（限深度 6）
    for (const root of searchRoots) {
      const found = findFileRecursive(root, headerName, 6);
      if (found) {
        let rel = relative(currentDir, found);
        // 统一用 / 分隔
        rel = rel.split(sep).join('/');
        return rel;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 递归查找文件（限最大深度）
 */
export function findFileRecursive(dir: string, fileName: string, maxDepth: number): string | null {
  if (maxDepth <= 0) {
    return null;
  }
  try {
    const entries = readdirSync(dir);
    // 先在当前层查找
    for (const e of entries) {
      if (e === fileName) {
        return pathResolve(dir, e);
      }
    }
    // 再递归子目录（跳过隐藏目录和常见无关目录）
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules' || e === 'build' || e === 'DerivedData') {
        continue;
      }
      const full = pathResolve(dir, e);
      try {
        if (statSync(full).isDirectory()) {
          const found: string | null = findFileRecursive(full, fileName, maxDepth - 1);
          if (found) {
            return found;
          }
        }
      } catch {
        /* 跳过不可访问的目录 */
      }
    }
  } catch {
    /* 跳过不可读目录 */
  }
  return null;
}

/**
 * 根据当前文件 target 和 header 的 module 关系，生成正确格式的 import 行
 *
 * 规则:
 *   Swift: 始终 `import Module`
 *   ObjC 同 target:  `#import "Header.h"` (quoted format)
 *   ObjC 跨 target:  `#import <Module/Header.h>` (angle-bracket format)
 *   @import 格式保持原样
 *
 * @param {string} rawHeader  原始 header 字符串
 * @param {object} ctx        { currentTarget, headerModuleName, isSwift, fullPath, projectRoot }
 *   - currentTarget:    当前文件所属的 target 名
 *   - headerModuleName: header 所属的 module/target 名（来自 recipe.moduleName 或推断）
 *   - isSwift:          目标文件是否是 Swift
 *   - fullPath:         当前编辑文件的绝对路径（用于计算同 target 相对路径）
 *   - projectRoot:      项目根目录（用于搜索头文件物理位置）
 * @returns {string} 格式化后的完整 import 行
 */
export function resolveHeaderFormat(
  rawHeader: string,
  ctx: {
    currentTarget: string | null;
    headerModuleName: string | null;
    isSwift: boolean;
    fullPath: string;
    projectRoot: string | null;
  }
) {
  const { currentTarget, headerModuleName, isSwift, fullPath, projectRoot } = ctx;
  const parsed = parseHeaderString(rawHeader);

  // Swift: 始终 `import Module`
  if (isSwift || parsed.isSwiftImport) {
    // 已经是完整 swift import 语句
    if (parsed.isSwiftImport) {
      return rawHeader.trim();
    }
    // 从 ObjC 格式推断 swift import
    const mod = parsed.moduleName || headerModuleName || '';
    if (mod) {
      return `import ${mod}`;
    }
    return rawHeader.trim(); // 无法推断，原样返回
  }

  // @import 保持原样（模块级引用不受 target 影响）
  if (parsed.isAtImport) {
    return rawHeader.trim();
  }

  // 已经是尖括号格式 → 保持（明确的跨模块引用）
  if (parsed.isAngle) {
    return rawHeader.trim();
  }

  // ── ObjC: 判断同 target vs 跨 target ──
  const effectiveModule = parsed.moduleName || headerModuleName || '';

  // 如果没有 target 信息，无法判断，保持原样
  if (!currentTarget || !effectiveModule) {
    return rawHeader.trim();
  }

  const isSameTarget = currentTarget === effectiveModule;

  if (isSameTarget) {
    // 同 target → 引号格式，计算相对路径
    if (parsed.headerName && fullPath) {
      const relPath = findHeaderRelativePath(parsed.headerName, fullPath, projectRoot);
      if (relPath) {
        return `#import "${relPath}"`;
      }
    }
    if (parsed.quotedPath) {
      return `#import "${parsed.quotedPath}"`;
    }
    if (parsed.headerName) {
      return `#import "${parsed.headerName}"`;
    }
    return rawHeader.trim();
  }

  // 跨 target → 尖括号格式 <Module/Header.h>
  if (parsed.headerName) {
    return `#import <${effectiveModule}/${parsed.headerName}>`;
  }
  // 没有 headerName（裸模块名），用 @import
  return `@import ${effectiveModule};`;
}

// ═══════════════════════════════════════════════════════════════
// 三级 import 去重
// ═══════════════════════════════════════════════════════════════

/**
 * 从文件中收集已有的 import 语句
 */
export function collectImportsFromFile(filePath: string, isSwift: boolean) {
  try {
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const imports: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (isSwift) {
        if (t.startsWith('import ')) {
          imports.push(t);
        }
      } else {
        if (t.startsWith('#import ') || t.startsWith('@import ') || t.startsWith('#include ')) {
          imports.push(t);
        }
      }
    }
    return imports;
  } catch {
    return [];
  }
}

/**
 * 收集 .m 文件对应 .h 文件中的 imports（ObjC 接口/实现配对去重）
 */
export function collectImportsFromHeaderFile(sourcePath: string, importArray: string[]) {
  const dotIndex = sourcePath.lastIndexOf('.');
  if (dotIndex <= 0) {
    return;
  }
  const headerPath = `${sourcePath.substring(0, dotIndex)}.h`;
  const importReg = /^#import\s*<[A-Za-z0-9_]+\/[A-Za-z0-9_+.-]+\.h>$/;
  try {
    if (!existsSync(headerPath)) {
      return;
    }
    const data = readFileSync(headerPath, 'utf8');
    for (const line of data.split('\n')) {
      const t = line.trim();
      if (importReg.test(t) && !importArray.includes(t)) {
        importArray.push(t);
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 三级 import 去重检查
 *
 *   hasHeader        精确匹配（同一 import 行）
 *   hasModule        模块级匹配（同模块不同头文件，或 @import）
 *   hasSimilarHeader 文件名 case-insensitive 匹配
 *
 * @param {string[]} importArray 已有的 import 行
 * @param {string}   headerLine 待插入的 import 行
 * @param {boolean}  isSwift
 */
export function checkImportStatus(importArray: string[], headerLine: string, isSwift: boolean) {
  const trimmed = headerLine.trim();

  // 提取 module / headerFileName
  let moduleName = '';
  let headerFileName = '';

  if (isSwift) {
    const m = trimmed.match(/^import\s+(\w+)/);
    if (m) {
      moduleName = m[1];
    }
    headerFileName = moduleName;
  } else {
    const angle = trimmed.match(/<([^/]+)\/([^>]+)>/);
    if (angle) {
      moduleName = angle[1];
      headerFileName = angle[2];
    }
    const quote = trimmed.match(/"([^"]+)"/);
    if (quote) {
      headerFileName = basename(quote[1]);
    }
  }

  const headerFileNameLower = headerFileName.toLowerCase();

  for (const imp of importArray) {
    const impT = imp.trim();

    // ── 级别 1: 精确匹配 ──
    if (impT === trimmed) {
      return { hasHeader: true, hasModule: false, hasSimilarHeader: false };
    }
    // 去掉可能的 AutoSnippet 注释后缀再比较
    const impTClean = impT.replace(/\s*\/\/\s*AutoSnippet.*$/, '').trim();
    if (impTClean === trimmed) {
      return { hasHeader: true, hasModule: false, hasSimilarHeader: false };
    }

    if (isSwift) {
      // ── 级别 2: Swift 模块匹配 ──
      const m2 = impT.match(/^import\s+(\w+)/);
      if (m2 && m2[1] === moduleName) {
        return { hasHeader: false, hasModule: true, hasSimilarHeader: false };
      }
    } else {
      // ── 级别 2: ObjC 模块匹配（<Module/xxx> 或 @import Module） ──
      if (moduleName) {
        const impAngle = impT.match(/<([^/]+)\//);
        if (impAngle && impAngle[1] === moduleName) {
          return { hasHeader: false, hasModule: true, hasSimilarHeader: false };
        }
        const impAt = impT.match(/@import\s+(\w+)/);
        if (impAt && impAt[1] === moduleName) {
          return { hasHeader: false, hasModule: true, hasSimilarHeader: false };
        }
      }

      // ── 级别 3: 相似头文件名匹配（case-insensitive） ──
      if (headerFileNameLower) {
        let importedFileName: string | null = null;
        const a = impT.match(/<[^/]+\/([^>]+)>/);
        if (a) {
          importedFileName = a[1].toLowerCase();
        }
        const q = impT.match(/"([^"]+)"/);
        if (q) {
          importedFileName = basename(q[1]).toLowerCase();
        }
        if (importedFileName && importedFileName === headerFileNameLower) {
          return { hasHeader: false, hasModule: false, hasSimilarHeader: true };
        }
      }
    }
  }

  return { hasHeader: false, hasModule: false, hasSimilarHeader: false };
}

// ═══════════════════════════════════════════════════════════════
// 模块名推断
// ═══════════════════════════════════════════════════════════════

/**
 * 从 import 语句推断模块名
 *
 *   #import <Module/Header.h>  → Module
 *   @import Module;            → Module
 *   import Module (Swift)      → Module
 *   #import "Local.h"          → null
 */
export function inferModulesFromHeaders(headers: string[]) {
  const modules = new Set<string>();
  for (const h of headers) {
    const t = h.trim();
    let m;
    m = t.match(/^#import\s+<([^/> ]+)/);
    if (m) {
      modules.add(m[1]);
      continue;
    }
    m = t.match(/^@import\s+(\w+)/);
    if (m) {
      modules.add(m[1]);
      continue;
    }
    m = t.match(/^import\s+(\w+)/);
    if (m && !['class', 'struct', 'enum', 'protocol'].includes(m[1])) {
      modules.add(m[1]);
    }
  }
  return [...modules];
}
