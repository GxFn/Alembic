/**
 * @module SymbolTableBuilder
 * @description Phase 5: 从 analyzeProject 结果构建全局符号表
 *
 * 符号表是调用图解析的核心数据结构，将 AST 提取的声明信息组织为可查询的全局表。
 *
 * 数据流:
 *   ProjectAstSummary → SymbolTableBuilder.build() → SymbolTable {
 *     declarations: Map<FQN, SymbolDeclaration>
 *     fileExports: Map<FilePath, string[]>
 *     fileImports: Map<FilePath, ImportRecord[]>
 *   }
 */

import { ImportRecord } from './ImportRecord.js';

/**
 * @typedef {object} SymbolDeclaration
 * @property {string} fqn - Fully Qualified Name e.g. "src/service/UserService.ts::UserService.getUser"
 * @property {string} name 短名 e.g. "getUser"
 * @property {string|null} className 所属类
 * @property {string} file 声明文件 (相对路径)
 * @property {number} line 行号
 * @property {'class'|'function'|'method'|'variable'|'interface'|'type'} kind
 * @property {boolean} isExported 是否导出
 */

/**
 * @typedef {object} SymbolTable
 * @property {Map<string, SymbolDeclaration>} declarations 符号 FQN → 声明
 * @property {Map<string, string[]>} fileExports 文件 → 导出符号名列表
 * @property {Map<string, ImportRecord[]>} fileImports 文件 → ImportRecord 列表
 * @property {Set<string>} instantiatedClasses - Phase 5.3 RTA: 程序中实际实例化的类名集合
 * @property {Map<string, Map<string, string>>} propertyTypes - Phase 5.3 DI: className → (fieldName → typeName)
 */

export class SymbolTableBuilder {
  /**
   * 从 analyzeProject 结果构建全局符号表
   *
   * @param {object} projectSummary - analyzeProject() 返回的 ProjectAstSummary
   * @returns {SymbolTable}
   */
  static build(projectSummary) {
    /** @type {SymbolTable} */
    const table = {
      declarations: new Map(),
      fileExports: new Map(),
      fileImports: new Map(),
      // Phase 5.3: RTA — track classes that are actually instantiated in the program
      instantiatedClasses: new Set(),
      // Phase 5.3: DI — property type annotations: className → (fieldName → typeName)
      propertyTypes: new Map(),
    };

    if (!projectSummary?.fileSummaries) {
      return table;
    }

    for (const fileSummary of projectSummary.fileSummaries) {
      const filePath = fileSummary.file;

      // 1. 提取导出名列表 (用于后续 import resolution)
      const exportNames = _extractExportNames(fileSummary.exports || []);

      // 2. 注册类声明
      for (const cls of fileSummary.classes || []) {
        if (!cls.name || cls.name === 'Unknown') {
          continue;
        }
        const fqn = `${filePath}::${cls.name}`;
        table.declarations.set(fqn, {
          fqn,
          name: cls.name,
          className: null,
          file: filePath,
          line: cls.line || 0,
          kind: cls.kind === 'enum' ? 'type' : cls.kind === 'type' ? 'type' : 'class',
          isExported: _isExported(cls.name, exportNames),
        });
      }

      // 3. 注册接口/协议声明
      for (const proto of fileSummary.protocols || []) {
        if (!proto.name || proto.name === 'Unknown') {
          continue;
        }
        const fqn = `${filePath}::${proto.name}`;
        table.declarations.set(fqn, {
          fqn,
          name: proto.name,
          className: null,
          file: filePath,
          line: proto.line || 0,
          kind: 'interface',
          isExported: _isExported(proto.name, exportNames),
        });
      }

      // 4. 注册方法/函数声明
      for (const method of fileSummary.methods || []) {
        if (!method.name || method.name === 'unknown') {
          continue;
        }
        const scope = method.className || '';
        const fqn = `${filePath}::${scope ? `${scope}.` : ''}${method.name}`;
        table.declarations.set(fqn, {
          fqn,
          name: method.name,
          className: method.className || null,
          file: filePath,
          line: method.line || 0,
          kind: method.className ? 'method' : 'function',
          isExported: !method.className && _isExported(method.name, exportNames),
        });
      }

      // 5. 注册导出
      table.fileExports.set(filePath, exportNames);

      // 6. 注册导入 (兼容 string 和 ImportRecord)
      const imports = (fileSummary.imports || []).map((imp) =>
        imp instanceof ImportRecord ? imp : new ImportRecord(String(imp))
      );
      table.fileImports.set(filePath, imports);

      // 7. Phase 5.3 RTA: Collect instantiated classes from callSites
      //    new ClassName() → callType='constructor', receiverType=ClassName
      //    <Component /> → callType='constructor', receiverType=Component (JSX)
      for (const cs of fileSummary.callSites || []) {
        if (cs.callType === 'constructor' && cs.receiverType) {
          table.instantiatedClasses.add(cs.receiverType);
        }
      }

      // 8. Phase 5.3 DI: Collect property type annotations
      //    property { name, className, typeAnnotation } → propertyTypes[className][name] = type
      for (const prop of fileSummary.properties || []) {
        if (prop.typeAnnotation && prop.className) {
          if (!table.propertyTypes.has(prop.className)) {
            table.propertyTypes.set(prop.className, new Map());
          }
          table.propertyTypes.get(prop.className).set(prop.name, prop.typeAnnotation);
        }
      }
    }

    return table;
  }
}

// ── 内部工具函数 ───────────────────────────────────────────

/**
 * 从 exports 数组中提取导出名
 * exports 格式可能是:
 *   - string[]
 *   - { line, text }[] (TypeScript walker 的格式)
 *   - { name, ... }[]
 *
 * @param {Array} exports
 * @returns {string[]}
 */
function _extractExportNames(exports) {
  const names = [];

  for (const exp of exports) {
    if (typeof exp === 'string') {
      names.push(exp);
      continue;
    }

    if (exp?.name) {
      names.push(exp.name);
      continue;
    }

    if (exp?.text) {
      // 从 export 文本中尝试提取名称
      // e.g. "export class UserService" → "UserService"
      // e.g. "export function getUser" → "getUser"
      // e.g. "export const config" → "config"
      // e.g. "export default class" → "default"
      const text = exp.text;
      const match = text.match(
        /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum|abstract\s+class)\s+(\w+)/
      );
      if (match) {
        names.push(match[1]);
      } else if (text.includes('export default')) {
        names.push('default');
      }
      // export { A, B, C }
      const namedMatch = text.match(/export\s*\{([^}]+)\}/);
      if (namedMatch) {
        const items = namedMatch[1].split(',').map((s) => {
          // 处理 "A as B" 的情况
          const parts = s.trim().split(/\s+as\s+/);
          return parts[parts.length - 1].trim();
        });
        names.push(...items.filter(Boolean));
      }
    }
  }

  return names;
}

/**
 * 检查符号是否被导出
 * @param {string} name
 * @param {string[]} exportNames
 * @returns {boolean}
 */
function _isExported(name, exportNames) {
  return exportNames.includes(name) || exportNames.includes('default');
}

export default SymbolTableBuilder;
