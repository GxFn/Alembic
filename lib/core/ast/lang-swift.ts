/**
 * @module lang-swift
 * @description Swift AST Walker 插件 - 从 AstAnalyzer.js 迁移
 *
 * Phase 5: 新增 ImportRecord 结构化导入 + extractCallSites 调用点提取
 */

import { ImportRecord } from '../analysis/ImportRecord.js';

// ── Swift AST 遍历 ──

function walkSwift(root: any, ctx: any) {
  _walkSwiftNode(root, ctx, null);
}

function _walkSwiftNode(node: any, ctx: any, parentClassName: any) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_declaration': {
        const mod = child.namedChildren.find(
          (c: any) => c.type === 'identifier' || c.type === 'simple_identifier'
        );
        if (mod) {
          ctx.imports.push(
            new ImportRecord(mod.text, { symbols: ['*'], alias: mod.text, kind: 'namespace' })
          );
        }
        break;
      }

      case 'class_declaration':
      case 'struct_declaration':
      case 'enum_declaration': {
        // tree-sitter-swift maps protocol/extension to class_declaration too.
        // Detect the actual keyword child and dispatch accordingly.
        const keyword = _findKeywordChild(child);
        if (keyword === 'protocol') {
          const protoInfo = _parseSwiftProtocol(child);
          ctx.protocols.push(protoInfo);
          break;
        }
        if (keyword === 'extension') {
          const extInfo = _parseSwiftExtension(child);
          ctx.categories.push(extInfo);
          const extBody = child.namedChildren.find(
            (c: any) => c.type === 'class_body' || c.type === 'extension_body'
          );
          if (extBody) {
            _walkSwiftNode(extBody, ctx, extInfo.className);
          }
          break;
        }

        const classInfo = _parseSwiftTypeDecl(child);
        ctx.classes.push(classInfo);
        const body = child.namedChildren.find(
          (c: any) =>
            c.type === 'class_body' ||
            c.type === 'struct_body' ||
            c.type === 'enum_body' ||
            c.type === 'enum_class_body'
        );
        if (body) {
          _walkSwiftNode(body, ctx, classInfo.name);
        }
        break;
      }

      case 'protocol_declaration': {
        const protoInfo = _parseSwiftProtocol(child);
        ctx.protocols.push(protoInfo);
        break;
      }

      case 'extension_declaration': {
        const extInfo = _parseSwiftExtension(child);
        ctx.categories.push(extInfo);
        const body = child.namedChildren.find((c: any) => c.type === 'extension_body');
        if (body) {
          _walkSwiftNode(body, ctx, extInfo.className);
        }
        break;
      }

      case 'function_declaration': {
        const m = _parseSwiftFunction(child, parentClassName);
        ctx.methods.push(m);
        break;
      }

      case 'property_declaration': {
        const p = _parseSwiftProperty(child, parentClassName);
        if (p) {
          ctx.properties.push(p);
        }
        break;
      }

      default: {
        if (
          child.namedChildCount > 0 &&
          !['function_body', 'computed_property', 'willSet_didSet_block'].includes(child.type)
        ) {
          _walkSwiftNode(child, ctx, parentClassName);
        }
      }
    }
  }
}

/** Detect the actual Swift keyword from a class_declaration node's children. */
const _swiftKeywords = ['struct', 'class', 'enum', 'actor', 'protocol', 'extension'];
function _findKeywordChild(node: any): string {
  for (let i = 0; i < node.childCount; i++) {
    const childType = node.child(i).type;
    if (_swiftKeywords.includes(childType)) {
      return childType;
    }
  }
  return 'class';
}

function _parseSwiftTypeDecl(node: any) {
  const name =
    node.namedChildren.find(
      (c: any) => c.type === 'type_identifier' || c.type === 'simple_identifier'
    )?.text || 'Unknown';

  // tree-sitter-swift maps struct/class/enum/actor all to `class_declaration`.
  // Detect the actual kind from the keyword child node (e.g. struct="struct").
  const kind = _findKeywordChild(node);

  const _superclass = null;
  const protocols: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'inheritance_specifier') {
      const typeNode = child.namedChildren.find((c: any) => c.type === 'user_type');
      if (typeNode) {
        const typeName = typeNode.namedChildren.find(
          (c: any) => c.type === 'type_identifier' || c.type === 'simple_identifier'
        )?.text;
        if (typeName) {
          protocols.push(typeName);
        }
      }
    }
  }

  let detectedSuper: any = null;
  if (protocols.length > 0 && kind === 'class') {
    const first = protocols[0];
    if (
      !first.endsWith('Protocol') &&
      !first.endsWith('Delegate') &&
      !first.endsWith('DataSource')
    ) {
      detectedSuper = first;
    }
  }

  return {
    name,
    kind,
    superclass: detectedSuper,
    protocols,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function _parseSwiftProtocol(node: any) {
  const name =
    node.namedChildren.find(
      (c: any) => c.type === 'type_identifier' || c.type === 'simple_identifier'
    )?.text || 'Unknown';
  const inherits: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'inheritance_specifier') {
      const t = child.namedChildren.find((c: any) => c.type === 'user_type');
      if (t) {
        const n = t.namedChildren.find(
          (c: any) => c.type === 'type_identifier' || c.type === 'simple_identifier'
        );
        if (n) {
          inherits.push(n.text);
        }
      }
    }
  }
  return { name, inherits, line: node.startPosition.row + 1 };
}

function _parseSwiftExtension(node: any) {
  const className =
    node.namedChildren.find((c: any) => c.type === 'user_type' || c.type === 'type_identifier')
      ?.text || 'Unknown';
  const protocols: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'inheritance_specifier') {
      const t = child.namedChildren.find((c: any) => c.type === 'user_type');
      if (t) {
        const n = t.namedChildren.find(
          (c: any) => c.type === 'type_identifier' || c.type === 'simple_identifier'
        );
        if (n) {
          protocols.push(n.text);
        }
      }
    }
  }

  const methods: any[] = [];
  const body = node.namedChildren.find(
    (c: any) => c.type === 'extension_body' || c.type === 'class_body'
  );
  if (body) {
    for (const child of body.namedChildren) {
      if (child.type === 'function_declaration') {
        methods.push(_parseSwiftFunction(child, className));
      }
    }
  }

  return {
    className,
    categoryName: protocols.length > 0 ? protocols.join('+') : 'ext',
    protocols,
    methods,
    line: node.startPosition.row + 1,
  };
}

function _parseSwiftFunction(node: any, className: any) {
  const name =
    node.namedChildren.find((c: any) => c.type === 'simple_identifier')?.text || 'unknown';

  const modifiers: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'modifiers' || child.type === 'modifier') {
      modifiers.push(child.text);
    }
  }
  const isClassMethod = modifiers.some((m) => /\b(static|class)\b/.test(m));

  const body = node.namedChildren.find((c: any) => c.type === 'function_body');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  return {
    name,
    className,
    isClassMethod,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

function _parseSwiftProperty(node: any, className: any) {
  const name =
    node.namedChildren.find((c: any) => c.type === 'simple_identifier' || c.type === 'pattern')
      ?.text || null;
  if (!name) {
    return null;
  }

  const modifiers: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'modifiers' || child.type === 'modifier') {
      modifiers.push(child.text);
    }
  }

  const isStatic = modifiers.some((m) => /\b(static|class)\b/.test(m));
  const isLet = node.text.includes(' let ');

  return {
    name,
    className,
    isStatic,
    isConstant: isLet,
    attributes: modifiers,
    line: node.startPosition.row + 1,
  };
}

// ── Swift 模式检测 ──

function detectSwiftPatterns(root: any, _lang: any, methods: any, properties: any, classes: any) {
  const patterns: any[] = [];

  // Index properties by className for quick lookup
  const propsByClass = new Map<string, any[]>();
  for (const p of properties) {
    if (p.className) {
      const arr = propsByClass.get(p.className) || [];
      arr.push(p);
      propsByClass.set(p.className, arr);
    }
  }

  // Index methods by className
  const methodsByClass = new Map<string, any[]>();
  for (const m of methods) {
    if (m.className && m.kind === 'definition') {
      const arr = methodsByClass.get(m.className) || [];
      arr.push(m);
      methodsByClass.set(m.className, arr);
    }
  }

  for (const cls of classes) {
    const kind = cls.kind as string;
    const className = cls.name as string;
    const clsProps = propsByClass.get(className) || [];
    const clsMethods = methodsByClass.get(className) || [];

    // ── 1. Singleton: `static let shared = ...` 属性 ──
    const sharedProp = clsProps.find(
      (p: any) =>
        p.isStatic &&
        (p.isConstant || p.isConst) &&
        /^shared$|^default$|^instance$|^current$/.test(p.name)
    );
    if (sharedProp) {
      patterns.push({
        type: 'singleton',
        className,
        propertyName: sharedProp.name,
        line: sharedProp.line,
        confidence: 0.95,
      });
    }

    // ── 2. Delegate: `weak var delegate` 属性或 protocol 命名以 Delegate/DataSource 结尾 ──
    for (const p of clsProps) {
      if (/delegate/i.test(p.name) && !p.name.startsWith('_')) {
        patterns.push({
          type: 'delegate',
          className,
          propertyName: p.name,
          isWeakRef: /weak/.test(`${(p.attributes || []).join(' ')} ${p.modifiers || ''}`),
          line: p.line,
          confidence: 0.95,
        });
      }
    }

    // ── 3. Factory: `static func make/create/from/build` ──
    for (const m of clsMethods) {
      if (m.isClassMethod && /^make|^create|^from|^build/.test(m.name)) {
        patterns.push({
          type: 'factory',
          className,
          methodName: m.name,
          line: m.line,
          confidence: 0.85,
        });
      }
    }

    // ── 4. Actor: Swift concurrency primitive ──
    if (kind === 'actor') {
      patterns.push({
        type: 'actor',
        className,
        line: cls.line,
        confidence: 0.95,
      });
    }

    // ── 5. Value type (struct): immutable-by-default semantics ──
    if (kind === 'struct' && !className.endsWith('Error')) {
      // Only flag structs with methods (not pure data containers)
      if (clsMethods.length > 0) {
        patterns.push({
          type: 'value-type',
          className,
          methodCount: clsMethods.length,
          line: cls.line,
          confidence: 0.9,
        });
      }
    }

    // ── 6. Protocol-oriented default implementation ──
    // (detected via categories/extensions that match a protocol name)
    // Handled below after the class loop.

    // ── 7. ViewModel: class name ends with ViewModel ──
    if (/ViewModel$/.test(className)) {
      patterns.push({
        type: 'viewmodel',
        className,
        line: cls.line,
        confidence: 0.9,
      });
    }

    // ── 8. Coordinator pattern ──
    if (/Coordinator$/.test(className)) {
      patterns.push({
        type: 'coordinator',
        className,
        line: cls.line,
        confidence: 0.85,
      });
    }

    // ── 9. Error type: enum conforming to Error ──
    if (kind === 'enum') {
      const conformsError = (cls.protocols || []).some(
        (p: string) => p === 'Error' || p === 'LocalizedError'
      );
      if (conformsError || className.endsWith('Error')) {
        patterns.push({
          type: 'error-type',
          className,
          line: cls.line,
          confidence: 0.9,
        });
      }
    }

    // ── 10. Middleware / Interceptor pattern ──
    if (/Middleware$|Interceptor$/.test(className)) {
      patterns.push({
        type: 'middleware',
        className,
        line: cls.line,
        confidence: 0.85,
      });
    }
  }

  // ── 11. Observer: methods matching didChange/willChange/observe/subscribe ──
  for (const m of methods) {
    if (m.kind !== 'definition') {
      continue;
    }
    if (/^didChange|^willChange|^observe|^addObserver|^subscribe|^on[A-Z]/.test(m.name)) {
      patterns.push({
        type: 'observer',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.7,
      });
    }
  }

  return patterns;
}

// ── 工具函数 ──

function _findIdentifier(node: any) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child.type === 'identifier' ||
      child.type === 'simple_identifier' ||
      child.type === 'type_identifier'
    ) {
      return child.text;
    }
  }
  return null;
}

function _estimateComplexity(node: any) {
  let complexity = 1;
  const BRANCH_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'switch_statement',
    'case_statement',
    'catch_clause',
    'conditional_expression',
    'ternary_expression',
    'guard_statement',
  ]);
  function walk(n: any) {
    if (BRANCH_TYPES.has(n.type)) {
      complexity++;
    }
    if (n.type === 'binary_expression') {
      const op = n.children?.find(
        (c: any) => c.type === '&&' || c.type === '||' || c.text === '&&' || c.text === '||'
      );
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

function _maxNesting(node: any, depth: any) {
  const NESTING_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'switch_statement',
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

// ── Swift Call Site 提取 (Phase 5) ───────────────────────────

/**
 * 从 Swift AST root 提取所有调用点
 * 遍历 function_declaration 中的 function_body → call_expression
 */
function extractCallSitesSwift(root: any, ctx: any, _lang: any) {
  const scopes = _collectSwiftScopes(root);
  for (const scope of scopes) {
    _extractSwiftCallSitesFromBody(scope.body, scope.className, scope.methodName, ctx);
  }
}

/** 递归收集 Swift 中所有函数体作用域 */
function _collectSwiftScopes(root: any) {
  const scopes: any[] = [];

  function visit(node: any, className: any) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);

      if (
        child.type === 'class_declaration' ||
        child.type === 'struct_declaration' ||
        child.type === 'enum_declaration'
      ) {
        const name = child.namedChildren.find(
          (c: any) => c.type === 'type_identifier' || c.type === 'simple_identifier'
        )?.text;
        const body = child.namedChildren.find(
          (c: any) =>
            c.type === 'class_body' ||
            c.type === 'struct_body' ||
            c.type === 'enum_body' ||
            c.type === 'enum_class_body'
        );
        if (body) {
          visit(body, name || className);
        }
      } else if (child.type === 'extension_declaration') {
        const extName = child.namedChildren.find(
          (c: any) => c.type === 'user_type' || c.type === 'type_identifier'
        )?.text;
        const body = child.namedChildren.find((c: any) => c.type === 'extension_body');
        if (body) {
          visit(body, extName || className);
        }
      } else if (child.type === 'function_declaration') {
        const name =
          child.namedChildren.find((c: any) => c.type === 'simple_identifier')?.text || 'unknown';
        const body = child.namedChildren.find((c: any) => c.type === 'function_body');
        if (body) {
          scopes.push({ body, className, methodName: name });
        }
      } else if (child.type === 'property_declaration') {
        // computed property with getter
        const computed = child.namedChildren.find(
          (c: any) => c.type === 'computed_property' || c.type === 'willSet_didSet_block'
        );
        if (computed) {
          const propName = child.namedChildren.find(
            (c: any) => c.type === 'simple_identifier' || c.type === 'pattern'
          )?.text;
          scopes.push({ body: computed, className, methodName: `get_${propName || 'prop'}` });
        }
      }
    }
  }

  visit(root, null);
  return scopes;
}

/** 从 Swift function body 中递归提取调用点 */
function _extractSwiftCallSitesFromBody(bodyNode: any, className: any, methodName: any, ctx: any) {
  if (!bodyNode) {
    return;
  }

  const SWIFT_NOISE = new Set([
    'print',
    'debugPrint',
    'dump',
    'fatalError',
    'precondition',
    'preconditionFailure',
    'assert',
    'assertionFailure',
    'NSLog',
    'min',
    'max',
    'abs',
    'stride',
    'zip',
    'type',
  ]);

  function walk(node: any) {
    if (!node || node.type === 'ERROR' || node.isMissing) {
      return;
    }

    // call_expression in Swift tree-sitter
    if (node.type === 'call_expression') {
      const func = node.namedChildren[0];
      if (!func) {
        walkChildren(node);
        return;
      }

      let callee: string,
        receiver: string | null = null,
        receiverType: string | null = null,
        callType: string;
      let isAwait = false;

      // Check if parent is await
      if (node.parent?.type === 'await_expression') {
        isAwait = true;
      }

      if (func.type === 'navigation_expression' || func.type === 'member_access') {
        // obj.method() or Type.staticMethod()
        const parts = func.text.split('.');
        if (parts.length >= 2) {
          receiver = parts.slice(0, -1).join('.');
          callee = parts[parts.length - 1];
          if (receiver === 'self') {
            receiverType = className;
            callType = 'method';
          } else if (receiver === 'super') {
            receiverType = className;
            callType = 'super';
          } else if (/^[A-Z]/.test(receiver!)) {
            receiverType = receiver;
            callType = 'static';
          } else {
            callType = 'method';
          }
        } else {
          callee = func.text;
          callType = 'function';
        }
      } else if (func.type === 'simple_identifier' || func.type === 'identifier') {
        callee = func.text;
        if (SWIFT_NOISE.has(callee)) {
          walkChildren(node);
          return;
        }
        // PascalCase → constructor (Swift initializer)
        callType = /^[A-Z]/.test(callee) ? 'constructor' : 'function';
        if (callType === 'constructor') {
          receiverType = callee;
        }
      } else {
        callee = func.text?.slice(0, 80) || 'unknown';
        callType = 'function';
      }

      // Count arguments
      const callSuffix = node.namedChildren.find(
        (c: any) => c.type === 'call_suffix' || c.type === 'value_arguments'
      );
      const argCount = callSuffix ? callSuffix.namedChildCount : 0;

      ctx.callSites.push({
        callee,
        callerMethod: methodName,
        callerClass: className,
        callType,
        receiver,
        receiverType,
        argCount,
        line: node.startPosition.row + 1,
        isAwait,
      });

      // walk arguments for nested calls
      if (callSuffix) {
        walkChildren(callSuffix);
      }
      return;
    }

    // try expression → walk into children
    if (node.type === 'try_expression' || node.type === 'await_expression') {
      walkChildren(node);
      return;
    }

    walkChildren(node);
  }

  function walkChildren(node: any) {
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
  }

  walk(bodyNode);
}

// ── 插件导出 ──

let _grammar: any = null;
function getGrammar() {
  return _grammar;
}
export function setGrammar(grammar: any) {
  _grammar = grammar;
}

export const plugin = {
  getGrammar,
  walk: walkSwift,
  detectPatterns: detectSwiftPatterns,
  extractCallSites: extractCallSitesSwift,
  extensions: ['.swift'],
};
