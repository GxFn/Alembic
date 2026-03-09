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

/** Input shape for the project summary from analyzeProject */
interface ProjectSummaryInput {
  fileSummaries?: Array<{
    file: string;
    exports?: Array<string | { name?: string; text?: string }>;
    classes?: Array<{ name?: string; line?: number; kind?: string }>;
    protocols?: Array<{ name?: string; line?: number }>;
    methods?: Array<{ name?: string; className?: string; line?: number }>;
    imports?: unknown[];
    callSites?: Array<{ callType?: string; receiverType?: string | null }>;
    properties?: Array<{ name: string; className?: string; typeAnnotation?: string }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export class SymbolTableBuilder {
  /**
   * 从 analyzeProject 结果构建全局符号表
   *
   * @param projectSummary analyzeProject() 返回的 ProjectAstSummary
   */
  static build(projectSummary: ProjectSummaryInput) {
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
      const imports = (fileSummary.imports || []).map((imp: unknown) =>
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
 */
function _extractExportNames(exports: Array<string | { name?: string; text?: string }>) {
  const names: string[] = [];

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
        const items = namedMatch[1].split(',').map((s: string) => {
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

/** 检查符号是否被导出 */
function _isExported(name: string, exportNames: string[]) {
  return exportNames.includes(name) || exportNames.includes('default');
}

export default SymbolTableBuilder;
