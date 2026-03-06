/**
 * @module lang-typescript
 * @description TypeScript AST Walker 插件
 *
 * 提取: class, interface, type alias, enum, function, method, property, import, export
 * 模式检测: Singleton, Factory, Observer, React Hook/Component, Middleware, Decorator
 *
 * Phase 5: 新增 ImportRecord 结构化导入 + extractCallSites 调用点提取
 */

import { ImportRecord } from '../analysis/ImportRecord.js';
import { extractCallSitesTS } from '../analysis/CallSiteExtractor.js';

function walkTypeScript(root, ctx) {
  _walkTSNode(root, ctx, null);
}

function _walkTSNode(node, ctx, parentClassName) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_statement': {
        const source = child.namedChildren.find(
          (c) => c.type === 'string' || c.type === 'string_fragment'
        );
        if (source) {
          const importPath = source.text.replace(/^['"]|['"]$/g, '');
          const importMeta = _parseImportClause(child);
          ctx.imports.push(new ImportRecord(importPath, importMeta));
        }
        break;
      }

      case 'export_statement': {
        // 提取 export 信息
        const exportInfo = {
          line: child.startPosition.row + 1,
          text: child.text.substring(0, 100),
        };
        ctx.exports = ctx.exports || [];
        ctx.exports.push(exportInfo);

        // 递归处理 export 下的声明
        _walkTSNode(child, ctx, parentClassName);
        break;
      }

      case 'class_declaration': {
        const classInfo = _parseTSClass(child);
        ctx.classes.push(classInfo);
        const body = child.namedChildren.find((c) => c.type === 'class_body');
        if (body) {
          _walkTSClassBody(body, ctx, classInfo.name);
        }
        break;
      }

      case 'abstract_class_declaration': {
        const classInfo: any = _parseTSClass(child);
        classInfo.abstract = true;
        ctx.classes.push(classInfo);
        const body = child.namedChildren.find((c) => c.type === 'class_body');
        if (body) {
          _walkTSClassBody(body, ctx, classInfo.name);
        }
        break;
      }

      case 'interface_declaration': {
        const ifaceInfo = _parseTSInterface(child);
        ctx.protocols.push(ifaceInfo);
        break;
      }

      case 'type_alias_declaration': {
        const name =
          child.namedChildren.find((c) => c.type === 'type_identifier')?.text || 'Unknown';
        ctx.classes.push({
          name,
          kind: 'type',
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
        break;
      }

      case 'enum_declaration': {
        const name = child.namedChildren.find((c) => c.type === 'identifier')?.text || 'Unknown';
        ctx.classes.push({
          name,
          kind: 'enum',
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
        break;
      }

      case 'function_declaration': {
        const funcInfo = _parseTSFunction(child, parentClassName);
        ctx.methods.push(funcInfo);
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        // const x = () => {} — 顶层箭头函数 或 const x = new Xxx()
        _parseTSVariableDecl(child, ctx, parentClassName);
        break;
      }

      default: {
        // 递归进入未识别节点
        if (
          child.namedChildCount > 0 &&
          !['function_body', 'statement_block', 'template_string'].includes(child.type)
        ) {
          _walkTSNode(child, ctx, parentClassName);
        }
      }
    }
  }
}

function _walkTSClassBody(body, ctx, className) {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);

    switch (child.type) {
      case 'method_definition': {
        const m = _parseTSMethod(child, className);
        ctx.methods.push(m);

        // Phase 5.3: Extract constructor parameter properties (DI pattern)
        if (m.name === 'constructor') {
          const constructorProps = _extractTSConstructorProperties(child, className);
          ctx.properties.push(...constructorProps);
        }
        break;
      }

      case 'public_field_definition':
      case 'property_definition': {
        const p = _parseTSProperty(child, className);
        if (p) {
          ctx.properties.push(p);
        }
        break;
      }

      case 'method_signature': {
        const name =
          child.namedChildren.find((c) => c.type === 'property_identifier')?.text || 'unknown';
        ctx.methods.push({
          name,
          className,
          line: child.startPosition.row + 1,
          kind: 'declaration',
        });
        break;
      }

      case 'property_signature': {
        const name =
          child.namedChildren.find((c) => c.type === 'property_identifier')?.text || 'unknown';
        ctx.properties.push({
          name,
          className,
          line: child.startPosition.row + 1,
        });
        break;
      }
    }
  }
}

function _parseTSClass(node) {
  const name =
    node.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'identifier')?.text ||
    'Unknown';

  let superclass = null;
  const protocols = [];
  for (const child of node.namedChildren) {
    if (child.type === 'class_heritage') {
      for (const clause of child.namedChildren) {
        if (clause.type === 'extends_clause') {
          const typeNode = clause.namedChildren.find(
            (c) => c.type === 'identifier' || c.type === 'member_expression'
          );
          if (typeNode) {
            superclass = typeNode.text;
          }
        }
        if (clause.type === 'implements_clause') {
          for (const impl of clause.namedChildren) {
            if (impl.type === 'type_identifier' || impl.type === 'generic_type') {
              protocols.push(impl.text);
            }
          }
        }
      }
    }
  }

  // 检测装饰器
  const decorators = [];
  for (const child of node.namedChildren) {
    if (child.type === 'decorator') {
      decorators.push(child.text);
    }
  }

  return {
    name,
    kind: 'class',
    superclass,
    protocols,
    decorators,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function _parseTSInterface(node) {
  const name = node.namedChildren.find((c) => c.type === 'type_identifier')?.text || 'Unknown';
  const inherits = [];

  for (const child of node.namedChildren) {
    if (child.type === 'extends_type_clause') {
      for (const ext of child.namedChildren) {
        if (ext.type === 'type_identifier' || ext.type === 'generic_type') {
          inherits.push(ext.text);
        }
      }
    }
  }

  return { name, inherits, line: node.startPosition.row + 1 };
}

function _parseTSFunction(node, className) {
  const name = node.namedChildren.find((c) => c.type === 'identifier')?.text || 'unknown';
  const body = node.namedChildren.find((c) => c.type === 'statement_block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  // 检查是否 async
  const isAsync = node.text.trimStart().startsWith('async');

  return {
    name,
    className,
    isClassMethod: false,
    isAsync,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

function _parseTSMethod(node, className) {
  const name =
    node.namedChildren.find(
      (c) =>
        c.type === 'property_identifier' ||
        c.type === 'identifier' ||
        c.type === 'computed_property_name'
    )?.text || 'unknown';

  const isStatic = node.text.trimStart().startsWith('static');
  const isAsync = node.text.includes('async');
  const body = node.namedChildren.find((c) => c.type === 'statement_block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  return {
    name,
    className,
    isClassMethod: isStatic,
    isAsync,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

function _parseTSProperty(node, className) {
  const name = node.namedChildren.find((c) => c.type === 'property_identifier')?.text || null;
  if (!name) {
    return null;
  }

  const isStatic = node.text.trimStart().startsWith('static');
  const isReadonly = node.text.includes('readonly');

  // Phase 5.3: Extract type annotation for DI/RTA resolution
  const typeAnnotation = _extractTypeAnnotation(node);

  // Phase 5.3: Extract decorators on properties (e.g. @Inject)
  const decorators: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'decorator') {
      decorators.push(child.text);
    }
  }

  return {
    name,
    className,
    isStatic,
    isReadonly,
    typeAnnotation,
    decorators: decorators.length > 0 ? decorators : undefined,
    line: node.startPosition.row + 1,
  };
}

/**
 * Phase 5.3: Extract type name from a type_annotation node
 * Handles: type_identifier, generic_type, nested_type_identifier, union_type
 * Strips generics: UserRepo<T> → UserRepo
 *
 * @param {object} parentNode - AST node that may contain a type_annotation child
 * @returns {string|null}
 */
function _extractTypeAnnotation(parentNode) {
  const typeAnnotNode = parentNode.namedChildren.find((c) => c.type === 'type_annotation');
  if (!typeAnnotNode) return null;

  const typeNode = typeAnnotNode.namedChildren.find(
    (c) =>
      c.type === 'type_identifier' ||
      c.type === 'generic_type' ||
      c.type === 'nested_type_identifier'
  );
  if (!typeNode) return null;

  // Strip generics: Repository<User> → Repository
  const text = typeNode.text;
  const bracketIdx = text.indexOf('<');
  return bracketIdx > 0 ? text.slice(0, bracketIdx) : text;
}

/**
 * Phase 5.3: Extract constructor parameter properties (TypeScript DI pattern)
 *
 * TypeScript shorthand: constructor(private userRepo: UserRepo)
 * creates a class property `userRepo` with type `UserRepo`
 *
 * @param {object} constructorNode - method_definition node with name "constructor"
 * @param {string} className
 * @returns {Array} - property objects
 */
function _extractTSConstructorProperties(constructorNode, className) {
  const properties = [];
  const params = constructorNode.namedChildren.find((c) => c.type === 'formal_parameters');
  if (!params) return properties;

  for (const param of params.namedChildren) {
    if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') continue;

    // Check for accessibility modifier (public, private, protected) or readonly
    // These turn constructor params into class properties
    const hasAccessibility = param.namedChildren.some(
      (c) => c.type === 'accessibility_modifier' || c.type === 'override_modifier'
    );
    const hasReadonly = param.text.includes('readonly');

    if (!hasAccessibility && !hasReadonly) continue; // Not a property declaration

    const nameNode = param.namedChildren.find((c) => c.type === 'identifier');
    const name = nameNode?.text;
    if (!name) continue;

    // Extract type annotation
    const typeAnnotation = _extractTypeAnnotation(param);

    // Extract decorators on parameter (e.g. @Inject)
    const decorators: any[] = [];
    for (const child of param.namedChildren) {
      if (child.type === 'decorator') {
        decorators.push(child.text);
      }
    }

    properties.push({
      name,
      className,
      isStatic: false,
      isReadonly: hasReadonly,
      typeAnnotation,
      isConstructorParam: true,
      decorators: decorators.length > 0 ? decorators : undefined,
      line: param.startPosition.row + 1,
    });
  }

  return properties;
}

function _parseTSVariableDecl(node, ctx, parentClassName) {
  for (const child of node.namedChildren) {
    if (child.type === 'variable_declarator') {
      const nameNode = child.namedChildren.find((c) => c.type === 'identifier');
      const valueNode = child.namedChildren.find(
        (c) => c.type === 'arrow_function' || c.type === 'function'
      );
      if (nameNode && valueNode) {
        const body = valueNode.namedChildren.find((c) => c.type === 'statement_block');
        ctx.methods.push({
          name: nameNode.text,
          className: parentClassName,
          isClassMethod: false,
          bodyLines: body ? body.endPosition.row - body.startPosition.row + 1 : 0,
          complexity: body ? _estimateComplexity(body) : 1,
          nestingDepth: body ? _maxNesting(body, 0) : 0,
          line: child.startPosition.row + 1,
          kind: 'definition',
        });
        continue;
      }

      // CJS require(): const x = require('path') / const { a, b } = require('path')
      // Dynamic import(): const mod = await import('./module')
      const callNode = child.namedChildren.find((c) => c.type === 'call_expression');
      if (callNode) {
        const requireImport = _parseCJSRequire(callNode, child);
        if (requireImport) {
          ctx.imports.push(requireImport);
          continue;
        }
        const dynamicImport = _parseDynamicImport(callNode, child);
        if (dynamicImport) {
          ctx.imports.push(dynamicImport);
          continue;
        }
      }
      // await import() — await wraps the call_expression
      const awaitNode = child.namedChildren.find((c) => c.type === 'await_expression');
      if (awaitNode) {
        const awaitedCall = awaitNode.namedChildren.find((c) => c.type === 'call_expression');
        if (awaitedCall) {
          const dynamicImport = _parseDynamicImport(awaitedCall, child);
          if (dynamicImport) {
            ctx.imports.push(dynamicImport);
          }
        }
      }
    }
  }
}

// ── TS/JS Import 解析 ──

/**
 * 从 import_statement 节点解析导入子句的结构化信息
 *
 * @param {TreeSitterNode} importNode - import_statement 节点
 * @returns {{ symbols: string[], kind: string, alias: string|null, isTypeOnly: boolean }}
 */
function _parseImportClause(importNode) {
  const symbols = [];
  let kind = 'side-effect';
  let alias = null;
  let isTypeOnly = false;

  // 检查 type-only import: import type { ... }
  if (importNode.text.trimStart().startsWith('import type')) {
    isTypeOnly = true;
  }

  for (const child of importNode.namedChildren) {
    if (child.type === 'import_clause') {
      for (const clauseChild of child.namedChildren) {
        if (clauseChild.type === 'identifier') {
          // default import: import Foo from '...'
          symbols.push(clauseChild.text);
          kind = 'default';
        } else if (clauseChild.type === 'named_imports') {
          // named imports: import { A, B as C } from '...'
          kind = 'named';
          for (const specifier of clauseChild.namedChildren) {
            if (specifier.type === 'import_specifier') {
              // 收集 specifier 中的所有 identifier / type_identifier
              const identifiers = specifier.namedChildren.filter(
                (c) => c.type === 'identifier' || c.type === 'type_identifier'
              );
              // import { A as B } → identifiers = [A, B] → push B (本地名)
              // import { A }     → identifiers = [A]     → push A
              if (identifiers.length > 0) {
                symbols.push(identifiers[identifiers.length - 1].text);
              }
            }
          }
        } else if (clauseChild.type === 'namespace_import') {
          // namespace import: import * as M from '...'
          kind = 'namespace';
          symbols.push('*');
          const aliasNode = clauseChild.namedChildren.find((c) => c.type === 'identifier');
          if (aliasNode) {
            alias = aliasNode.text;
          }
        }
      }
    }
  }

  return { symbols, kind, alias, isTypeOnly };
}

/**
 * 解析 CJS require() 调用: const x = require('path') / const { a, b } = require('path')
 *
 * @param {TreeSitterNode} callNode - call_expression 节点
 * @param {TreeSitterNode} declaratorNode - variable_declarator 节点 (包含 lhs 绑定)
 * @returns {ImportRecord|null}
 */
function _parseCJSRequire(callNode, declaratorNode) {
  // 检查 callee 是否为 'require'
  const callee = callNode.namedChildren[0];
  if (!callee || callee.type !== 'identifier' || callee.text !== 'require') return null;

  // 提取 require 参数中的路径字符串
  const args = callNode.namedChildren.find((c) => c.type === 'arguments');
  if (!args || args.namedChildCount === 0) return null;

  const firstArg = args.namedChildren[0];
  if (!firstArg || (firstArg.type !== 'string' && firstArg.type !== 'template_string')) return null;

  const importPath = firstArg.text.replace(/^['"`]|['"`]$/g, '');
  if (!importPath) return null;

  // 解析 lhs 绑定模式
  const lhs = declaratorNode.namedChildren[0]; // identifier or object_pattern
  if (!lhs) return new ImportRecord(importPath, { symbols: [], kind: 'side-effect' });

  if (lhs.type === 'identifier') {
    // const express = require('express') → namespace import
    return new ImportRecord(importPath, {
      symbols: ['*'],
      kind: 'namespace',
      alias: lhs.text,
    });
  }

  if (lhs.type === 'object_pattern') {
    // const { readFile, writeFile } = require('fs')
    const symbols: any[] = [];
    for (const prop of lhs.namedChildren) {
      if (prop.type === 'shorthand_property_identifier_pattern' || prop.type === 'shorthand_property_identifier') {
        symbols.push(prop.text);
      } else if (prop.type === 'pair_pattern' || prop.type === 'pair') {
        // { readFile: rf } → 使用本地名 rf
        const identifiers = prop.namedChildren.filter((c) => c.type === 'identifier');
        if (identifiers.length > 0) {
          symbols.push(identifiers[identifiers.length - 1].text);
        }
      }
    }
    return new ImportRecord(importPath, {
      symbols: symbols.length > 0 ? symbols : ['*'],
      kind: symbols.length > 0 ? 'named' : 'namespace',
    });
  }

  // 其他 lhs 模式 (如数组解构), 作为 side-effect 处理
  return new ImportRecord(importPath, { symbols: [], kind: 'side-effect' });
}

/**
 * 解析动态 import() 表达式: const mod = await import('./module')
 *
 * @param {TreeSitterNode} callNode - call_expression 节点
 * @param {TreeSitterNode} declaratorNode - variable_declarator 节点
 * @returns {ImportRecord|null}
 */
function _parseDynamicImport(callNode, declaratorNode) {
  // 动态 import() 在 tree-sitter 中解析为 call_expression, callee 是 'import'
  const callee = callNode.namedChildren[0];
  if (!callee) return null;
  // tree-sitter 可能将 import() 解析为 identifier('import') 或 special node
  if (callee.text !== 'import') return null;

  const args = callNode.namedChildren.find((c) => c.type === 'arguments');
  if (!args || args.namedChildCount === 0) return null;

  const firstArg = args.namedChildren[0];
  if (!firstArg || (firstArg.type !== 'string' && firstArg.type !== 'template_string')) return null;

  const importPath = firstArg.text.replace(/^['"`]|['"`]$/g, '');
  if (!importPath) return null;

  const lhs = declaratorNode?.namedChildren?.[0];
  const alias = lhs?.type === 'identifier' ? lhs.text : null;

  return new ImportRecord(importPath, {
    symbols: ['*'],
    kind: 'dynamic',
    alias,
  });
}

// ── TS/JS 模式检测 ──

function detectTSPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  // Singleton: export const xxx = new Xxx() or getInstance()
  for (const m of methods) {
    if (/^getInstance$|^shared$|^instance$/.test(m.name) && m.isClassMethod) {
      patterns.push({
        type: 'singleton',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.85,
      });
    }
  }

  // Factory: createXxx / makeXxx
  for (const m of methods) {
    if (/^create[A-Z]|^make[A-Z]|^build[A-Z]|^from[A-Z]/.test(m.name)) {
      patterns.push({
        type: 'factory',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.8,
      });
    }
  }

  // React Hook: useXxx
  for (const m of methods) {
    if (/^use[A-Z]/.test(m.name) && !m.className) {
      patterns.push({
        type: 'react-hook',
        className: null,
        methodName: m.name,
        line: m.line,
        confidence: 0.9,
      });
    }
  }

  // Observer: on/emit/addEventListener/subscribe
  for (const m of methods) {
    if (/^on[A-Z]|^emit$|^addEventListener$|^subscribe$|^observe$/.test(m.name)) {
      patterns.push({
        type: 'observer',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.7,
      });
    }
  }

  // Middleware: 匹配 (req, res, next) 参数签名通过方法名推断
  for (const m of methods) {
    if (/^middleware$|^use$|^handle$/.test(m.name)) {
      patterns.push({
        type: 'middleware',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.6,
      });
    }
  }

  // Decorator pattern (via class decorators)
  for (const cls of classes) {
    if (cls.decorators?.length > 0) {
      for (const dec of cls.decorators) {
        if (/@(Injectable|Component|Controller|Module|Guard|Pipe)/.test(dec)) {
          patterns.push({
            type: 'decorator',
            className: cls.name,
            decorator: dec,
            line: cls.line,
            confidence: 0.9,
          });
        }
      }
    }
  }

  return patterns;
}

// ── 工具函数 ──

function _estimateComplexity(node) {
  let complexity = 1;
  const BRANCH_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'switch_statement',
    'case_clause',
    'catch_clause',
    'ternary_expression',
    'conditional_expression',
  ]);
  function walk(n) {
    if (BRANCH_TYPES.has(n.type)) {
      complexity++;
    }
    if (n.type === 'binary_expression') {
      const op = n.children?.find((c) => c.text === '&&' || c.text === '||');
      if (op) {
        complexity++;
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      walk(n.namedChild(i));
    }
  }
  walk(node);
  return complexity;
}

function _maxNesting(node, depth) {
  const NESTING_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'switch_statement',
    'statement_block',
  ]);
  let max = depth;
  const nextDepth = NESTING_TYPES.has(node.type) ? depth + 1 : depth;
  for (let i = 0; i < node.namedChildCount; i++) {
    const childMax = _maxNesting(node.namedChild(i), nextDepth);
    if (childMax > max) {
      max = childMax;
    }
  }
  return max;
}

// ── 插件导出 ──

let _tsGrammar = null;
function getGrammar() {
  return _tsGrammar;
}
export function setGrammar(grammar) {
  _tsGrammar = grammar;
}

export const plugin = {
  getGrammar,
  walk: walkTypeScript,
  detectPatterns: detectTSPatterns,
  extractCallSites: extractCallSitesTS,
  extensions: ['.ts'],
};

// TSX 插件 — 共享 walker，不同 grammar
let _tsxGrammar = null;
function getTsxGrammar() {
  return _tsxGrammar;
}
export function setTsxGrammar(grammar) {
  _tsxGrammar = grammar;
}

export const tsxPlugin = {
  getGrammar: getTsxGrammar,
  walk: walkTypeScript,
  detectPatterns: detectTSPatterns,
  extractCallSites: extractCallSitesTS,
  extensions: ['.tsx'],
};
