/**
 * @module lang-kotlin
 * @description Kotlin AST Walker 插件
 *
 * 提取: class, interface, object, enum, sealed class, function, property, import, annotation
 * 模式: Singleton (object), Factory (companion), DSL, Flow, Sealed
 */

import { ImportRecord } from '../analysis/ImportRecord.js';

function walkKotlin(root, ctx) {
  _walkKtNode(root, ctx, null);
}

function _walkKtNode(node, ctx, parentClassName) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_header':
      case 'import_directive': {
        const id = child.namedChildren.find(
          (c) => c.type === 'identifier' || c.type === 'user_type'
        );
        if (id) {
          const fullPath = id.text; // e.g. com.example.MyClass or com.example.myFunc
          const segments = fullPath.split('.');
          const lastName = segments[segments.length - 1];
          // Kotlin: import com.example.* (wildcard)
          const isWildcard = child.text.includes('.*');
          // Kotlin: import com.example.MyClass as Alias
          const aliasNode = child.namedChildren.find((c) => c.type === 'import_alias');
          const alias = aliasNode?.namedChildren?.find((c) => c.type === 'type_identifier' || c.type === 'simple_identifier')?.text;

          if (isWildcard) {
            ctx.imports.push(
              new ImportRecord(fullPath, { symbols: ['*'], kind: 'namespace' })
            );
          } else {
            ctx.imports.push(
              new ImportRecord(fullPath, {
                symbols: [lastName],
                alias: alias || lastName,
                kind: 'named',
              })
            );
          }
        }
        break;
      }

      case 'class_declaration': {
        const classInfo = _parseKtClass(child);
        ctx.classes.push(classInfo);

        // Phase 5.3: Extract primary constructor parameter properties (Kotlin DI pattern)
        // class UserService(private val repo: UserRepo) → property { name: 'repo', typeAnnotation: 'UserRepo' }
        _extractKtConstructorProperties(child, ctx, classInfo.name);

        const body = child.namedChildren.find((c) => c.type === 'class_body');
        if (body) {
          _walkKtClassBody(body, ctx, classInfo.name);
        }
        break;
      }

      case 'object_declaration': {
        const name =
          child.namedChildren.find(
            (c) => c.type === 'type_identifier' || c.type === 'simple_identifier'
          )?.text || 'Unknown';
        ctx.classes.push({
          name,
          kind: 'object',
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
        const body = child.namedChildren.find((c) => c.type === 'class_body');
        if (body) {
          _walkKtClassBody(body, ctx, name);
        }
        break;
      }

      case 'function_declaration': {
        const func = _parseKtFunction(child, parentClassName);
        ctx.methods.push(func);
        break;
      }

      case 'property_declaration': {
        const prop = _parseKtProperty(child, parentClassName);
        if (prop) {
          ctx.properties.push(prop);
        }
        break;
      }

      default: {
        if (
          child.namedChildCount > 0 &&
          !['function_body', 'lambda_literal', 'string_literal'].includes(child.type)
        ) {
          _walkKtNode(child, ctx, parentClassName);
        }
      }
    }
  }
}

function _walkKtClassBody(body, ctx, className) {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);

    switch (child.type) {
      case 'function_declaration': {
        ctx.methods.push(_parseKtFunction(child, className));
        break;
      }
      case 'property_declaration': {
        const prop = _parseKtProperty(child, className);
        if (prop) {
          ctx.properties.push(prop);
        }
        break;
      }
      case 'companion_object': {
        const companionBody = child.namedChildren.find((c) => c.type === 'class_body');
        if (companionBody) {
          _walkKtClassBody(companionBody, ctx, className);
        }
        break;
      }
      case 'class_declaration': {
        const inner = _parseKtClass(child);
        (inner as any).outerClass = className;
        ctx.classes.push(inner);
        // Phase 5.3: Extract primary constructor params for inner classes too
        _extractKtConstructorProperties(child, ctx, inner.name);
        const innerBody = child.namedChildren.find((c) => c.type === 'class_body');
        if (innerBody) {
          _walkKtClassBody(innerBody, ctx, inner.name);
        }
        break;
      }
      case 'object_declaration': {
        const name =
          child.namedChildren.find(
            (c) => c.type === 'type_identifier' || c.type === 'simple_identifier'
          )?.text || 'Unknown';
        ctx.classes.push({
          name,
          kind: 'object',
          outerClass: className,
          line: child.startPosition.row + 1,
        });
        const objBody = child.namedChildren.find((c) => c.type === 'class_body');
        if (objBody) {
          _walkKtClassBody(objBody, ctx, name);
        }
        break;
      }
    }
  }
}

function _parseKtClass(node) {
  const name =
    node.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'simple_identifier')
      ?.text || 'Unknown';

  // 检查修饰符: data, sealed, abstract, open, enum
  const modifiers = [];
  for (const child of node.namedChildren) {
    if (child.type === 'modifiers' || child.type === 'modifier') {
      modifiers.push(child.text);
    }
  }

  let kind = 'class';
  if (modifiers.some((m) => /\bdata\b/.test(m))) {
    kind = 'data-class';
  }
  if (modifiers.some((m) => /\bsealed\b/.test(m))) {
    kind = 'sealed-class';
  }
  if (modifiers.some((m) => /\benum\b/.test(m))) {
    kind = 'enum';
  }
  if (modifiers.some((m) => /\babstract\b/.test(m))) {
    kind = 'abstract-class';
  }

  // 继承
  const _superclass = null;
  const protocols = [];
  for (const child of node.namedChildren) {
    if (child.type === 'delegation_specifier' || child.type === 'delegation_specifiers') {
      // 简化处理
      const typeRefs = _collectTypeRefs(child);
      protocols.push(...typeRefs);
    }
  }

  let detectedSuper = null;
  if (protocols.length > 0) {
    detectedSuper = protocols[0];
  }

  // 注解
  const annotations = node.namedChildren.filter((c) => c.type === 'annotation').map((a) => a.text);

  return {
    name,
    kind,
    superclass: detectedSuper,
    protocols,
    annotations,
    modifiers,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function _parseKtFunction(node, className) {
  const name = node.namedChildren.find((c) => c.type === 'simple_identifier')?.text || 'unknown';
  const body = node.namedChildren.find((c) => c.type === 'function_body' || c.type === 'block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  const modifiers = [];
  for (const child of node.namedChildren) {
    if (child.type === 'modifiers' || child.type === 'modifier') {
      modifiers.push(child.text);
    }
  }

  const isSuspend = modifiers.some((m) => /\bsuspend\b/.test(m));
  const isOverride = modifiers.some((m) => /\boverride\b/.test(m));

  // 检测扩展函数: fun Type.name()
  const receiverType = node.namedChildren.find((c) => c.type === 'user_type');
  const isExtension =
    !!receiverType &&
    receiverType.startPosition.column <
      (node.namedChildren.find((c) => c.type === 'simple_identifier')?.startPosition?.column ||
        999);

  return {
    name,
    className,
    isClassMethod: false,
    isSuspend,
    isOverride,
    isExtension,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

function _parseKtProperty(node, className) {
  const name =
    node.namedChildren.find(
      (c) => c.type === 'simple_identifier' || c.type === 'variable_declaration'
    )?.text || null;
  if (!name) {
    return null;
  }

  const isVal = node.text.trimStart().startsWith('val') || node.text.includes(' val ');
  const isVar = node.text.trimStart().startsWith('var') || node.text.includes(' var ');
  const isLazy = node.text.includes('by lazy');
  const isLateinit = node.text.includes('lateinit');

  // Phase 5.3: Extract property type for DI resolution
  // Kotlin property types can be in variable_declaration or directly on the node:
  //   val userRepo: UserRepo  →  variable_declaration { simple_identifier, user_type }
  //   lateinit var service: UserService  →  user_type directly on property_declaration
  let typeAnnotation = null;

  // 1. Try from variable_declaration child
  const varDecl = node.namedChildren.find((c) => c.type === 'variable_declaration');
  if (varDecl) {
    const typeNode = varDecl.namedChildren.find(
      (c) => c.type === 'user_type' || c.type === 'nullable_type'
    );
    if (typeNode) {
      typeAnnotation = _extractKtTypeName(typeNode);
    }
  }

  // 2. Fallback: try direct children (lateinit var patterns)
  if (!typeAnnotation) {
    const typeNode = node.namedChildren.find(
      (c) => c.type === 'user_type' || c.type === 'nullable_type'
    );
    if (typeNode) {
      typeAnnotation = _extractKtTypeName(typeNode);
    }
  }

  // Phase 5.3: Extract annotations on property (e.g. @Inject, @Autowired)
  const annotations: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'annotation' || child.type === 'single_annotation') {
      annotations.push(child.text);
    }
  }
  // Also check modifiers block
  const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
  if (modifiers) {
    for (const child of modifiers.namedChildren) {
      if (child.type === 'annotation' || child.type === 'single_annotation') {
        annotations.push(child.text);
      }
    }
  }

  return {
    name,
    className,
    isConstant: isVal,
    isMutable: isVar,
    isLazy,
    isLateinit,
    typeAnnotation,
    annotations: annotations.length > 0 ? annotations : undefined,
    line: node.startPosition.row + 1,
  };
}

/**
 * Phase 5.3: Extract Kotlin primary constructor parameter properties
 *
 * Kotlin constructors: class Svc(private val repo: UserRepo, val logger: Logger)
 * Each val/var parameter in a primary_constructor becomes a class property.
 *
 * AST: class_declaration → primary_constructor → class_parameter[]
 * Each class_parameter may contain: modifiers, val/var keyword, simple_identifier, user_type
 *
 * @param {object} classNode - class_declaration AST node
 * @param {object} ctx - walker context
 * @param {string} className
 */
function _extractKtConstructorProperties(classNode, ctx, className) {
  const primaryCtor = classNode.namedChildren.find(
    (c) => c.type === 'primary_constructor'
  );
  if (!primaryCtor) return;

  for (const param of primaryCtor.namedChildren) {
    if (param.type !== 'class_parameter') continue;

    // Only val/var params become properties
    const text = param.text;
    const isVal = text.includes('val ');
    const isVar = text.includes('var ');
    if (!isVal && !isVar) continue;

    const name = param.namedChildren.find(
      (c) => c.type === 'simple_identifier'
    )?.text;
    if (!name) continue;

    // Extract type annotation
    let typeAnnotation = null;
    const typeNode = param.namedChildren.find(
      (c) => c.type === 'user_type' || c.type === 'nullable_type'
    );
    if (typeNode) {
      typeAnnotation = _extractKtTypeName(typeNode);
    }

    // Extract annotations (e.g. @Inject)
    const annotations: any[] = [];
    for (const child of param.namedChildren) {
      if (child.type === 'annotation' || child.type === 'single_annotation' || child.type === 'modifiers') {
        if (child.type === 'modifiers') {
          for (const mod of child.namedChildren) {
            if (mod.type === 'annotation' || mod.type === 'single_annotation') {
              annotations.push(mod.text);
            }
          }
        } else {
          annotations.push(child.text);
        }
      }
    }

    ctx.properties.push({
      name,
      className,
      isConstant: isVal,
      isMutable: isVar,
      isLazy: false,
      isLateinit: false,
      isConstructorParam: true,
      typeAnnotation,
      annotations: annotations.length > 0 ? annotations : undefined,
      line: param.startPosition.row + 1,
    });
  }
}

/**
 * Phase 5.3: Extract Kotlin type name from user_type or nullable_type node
 * Strips generics and nullable marker
 */
function _extractKtTypeName(typeNode) {
  if (typeNode.type === 'nullable_type') {
    const inner = typeNode.namedChildren.find((c) => c.type === 'user_type');
    if (inner) {
      const text = inner.text;
      const bracketIdx = text.indexOf('<');
      return bracketIdx > 0 ? text.slice(0, bracketIdx) : text;
    }
    return null;
  }
  // user_type
  const text = typeNode.text;
  const bracketIdx = text.indexOf('<');
  return bracketIdx > 0 ? text.slice(0, bracketIdx) : text;
}

function _collectTypeRefs(node) {
  const refs = [];
  function walk(n) {
    if (n.type === 'user_type' || n.type === 'type_identifier' || n.type === 'simple_identifier') {
      refs.push(n.text);
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      walk(n.namedChild(i));
    }
  }
  walk(node);
  return refs;
}

// ── Kotlin 模式检测 ──

function detectKtPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  // Singleton: object declaration
  for (const cls of classes) {
    if (cls.kind === 'object') {
      patterns.push({ type: 'singleton', className: cls.name, line: cls.line, confidence: 0.95 });
    }
  }

  // Sealed class
  for (const cls of classes) {
    if (cls.kind === 'sealed-class') {
      patterns.push({
        type: 'sealed-class',
        className: cls.name,
        line: cls.line,
        confidence: 0.95,
      });
    }
  }

  // Data class
  for (const cls of classes) {
    if (cls.kind === 'data-class') {
      patterns.push({ type: 'data-class', className: cls.name, line: cls.line, confidence: 0.95 });
    }
  }

  // Factory: companion object 中的 create/of/from
  for (const m of methods) {
    if (/^create$|^of$|^from$|^newInstance$/.test(m.name)) {
      patterns.push({
        type: 'factory',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.8,
      });
    }
  }

  // Extension function
  for (const m of methods) {
    if (m.isExtension) {
      patterns.push({
        type: 'extension-function',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.9,
      });
    }
  }

  // Android patterns
  for (const cls of classes) {
    if (cls.annotations?.some((a) => /@Composable/.test(a))) {
      patterns.push({ type: 'composable', className: cls.name, line: cls.line, confidence: 0.95 });
    }
    if (cls.annotations?.some((a) => /@HiltAndroidApp|@AndroidEntryPoint/.test(a))) {
      patterns.push({ type: 'hilt-di', className: cls.name, line: cls.line, confidence: 0.95 });
    }
    if (cls.superclass && /ViewModel$/.test(cls.superclass)) {
      patterns.push({ type: 'viewmodel', className: cls.name, line: cls.line, confidence: 0.9 });
    }
  }

  // Composable functions
  for (const m of methods) {
    if (m.name && /^[A-Z]/.test(m.name) && !m.className) {
      // Possible Composable function (PascalCase top-level fun)
      // Would need annotation check for higher confidence
    }
  }

  return patterns;
}

// ── 工具函数 ──

function _estimateComplexity(node) {
  let complexity = 1;
  const BRANCH_TYPES = new Set([
    'if_expression',
    'for_statement',
    'while_statement',
    'when_expression',
    'when_entry',
    'catch_block',
    'try_expression',
  ]);
  function walk(n) {
    if (BRANCH_TYPES.has(n.type)) {
      complexity++;
    }
    if (n.type === 'conjunction_expression' || n.type === 'disjunction_expression') {
      complexity++;
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
    'if_expression',
    'for_statement',
    'while_statement',
    'when_expression',
    'try_expression',
    'lambda_literal',
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

// ── Kotlin Call Site 提取 (Phase 5) ──────────────────────────

/**
 * 从 Kotlin AST root 提取所有调用点
 */
function extractCallSitesKotlin(root, ctx, _lang) {
  const scopes = _collectKtScopes(root);
  for (const scope of scopes) {
    _extractKtCallSitesFromBody(scope.body, scope.className, scope.methodName, ctx);
  }
}

/**
 * 递归收集 Kotlin 中所有函数体作用域
 */
function _collectKtScopes(root) {
  const scopes = [];

  function visit(node, className) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);

      if (child.type === 'class_declaration' || child.type === 'object_declaration') {
        const name = child.namedChildren.find(
          (c) => c.type === 'type_identifier' || c.type === 'simple_identifier'
        )?.text;
        const body = child.namedChildren.find((c) => c.type === 'class_body');
        if (body) {
          visit(body, name || className);
        }
      } else if (child.type === 'companion_object') {
        const body = child.namedChildren.find((c) => c.type === 'class_body');
        if (body) {
          visit(body, className);
        }
      } else if (child.type === 'function_declaration') {
        const name = child.namedChildren.find((c) => c.type === 'simple_identifier')?.text || 'unknown';
        const body = child.namedChildren.find((c) => c.type === 'function_body' || c.type === 'block');
        if (body) {
          scopes.push({ body, className, methodName: name });
        }
      } else if (child.type === 'property_declaration') {
        // property with getter/setter or initializer with lambda
        const getter = child.namedChildren.find((c) => c.type === 'getter');
        const setter = child.namedChildren.find((c) => c.type === 'setter');
        const propName = child.namedChildren.find((c) => c.type === 'simple_identifier' || c.type === 'variable_declaration')?.text;
        if (getter) {
          const body = getter.namedChildren.find((c) => c.type === 'function_body' || c.type === 'block');
          if (body) scopes.push({ body, className, methodName: `get_${propName || 'prop'}` });
        }
        if (setter) {
          const body = setter.namedChildren.find((c) => c.type === 'function_body' || c.type === 'block');
          if (body) scopes.push({ body, className, methodName: `set_${propName || 'prop'}` });
        }
      }
    }
  }

  visit(root, null);
  return scopes;
}

/**
 * 从 Kotlin function body 中递归提取调用点
 */
function _extractKtCallSitesFromBody(bodyNode, className, methodName, ctx) {
  if (!bodyNode) return;

  const KT_NOISE = new Set([
    'println', 'print', 'require', 'check', 'error', 'TODO',
    'listOf', 'mapOf', 'setOf', 'mutableListOf', 'mutableMapOf', 'mutableSetOf',
    'arrayOf', 'intArrayOf', 'emptyList', 'emptyMap', 'emptySet',
    'lazy', 'repeat', 'run', 'let', 'also', 'apply', 'with',
  ]);

  function walk(node) {
    if (!node || node.type === 'ERROR' || node.isMissing) return;

    if (node.type === 'call_expression') {
      const func = node.namedChildren[0];
      if (!func) { walkChildren(node); return; }

      let callee, receiver = null, receiverType = null, callType;

      if (func.type === 'navigation_expression') {
        // obj.method() or Pkg.func()
        const parts = func.text.split('.');
        if (parts.length >= 2) {
          receiver = parts.slice(0, -1).join('.');
          callee = parts[parts.length - 1];
          if (receiver === 'this' || receiver === 'self') {
            receiverType = className;
            callType = 'method';
          } else if (receiver === 'super') {
            receiverType = className;
            callType = 'super';
          } else if (/^[A-Z]/.test(receiver)) {
            receiverType = receiver;
            callType = 'static';
          } else {
            callType = 'method';
            receiverType = null;
          }
        } else {
          callee = func.text;
          callType = 'function';
        }
      } else if (func.type === 'simple_identifier') {
        callee = func.text;
        if (KT_NOISE.has(callee)) {
          walkChildren(node);
          return;
        }
        // PascalCase → constructor
        callType = /^[A-Z]/.test(callee) ? 'constructor' : 'function';
        if (callType === 'constructor') {
          receiverType = callee;
        }
      } else {
        callee = func.text?.slice(0, 80) || 'unknown';
        callType = 'function';
      }

      // 计算参数数量
      const valueArgs = node.namedChildren.find((c) => c.type === 'call_suffix' || c.type === 'value_arguments');
      const argCount = valueArgs ? valueArgs.namedChildCount : 0;

      ctx.callSites.push({
        callee,
        callerMethod: methodName,
        callerClass: className,
        callType,
        receiver,
        receiverType,
        argCount,
        line: node.startPosition.row + 1,
        isAwait: false,
      });

      // walk arguments for nested calls
      if (valueArgs) walkChildren(valueArgs);
      // also check trailing lambda
      const lambda = node.namedChildren.find((c) => c.type === 'annotated_lambda' || c.type === 'lambda_literal');
      if (lambda) walkChildren(lambda);
      return;
    }

    walkChildren(node);
  }

  function walkChildren(node) {
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
  }

  walk(bodyNode);
}

// ── 插件导出 ──

let _grammar = null;
function getGrammar() {
  return _grammar;
}
export function setGrammar(grammar) {
  _grammar = grammar;
}

export const plugin = {
  getGrammar,
  walk: walkKotlin,
  detectPatterns: detectKtPatterns,
  extractCallSites: extractCallSitesKotlin,
  extensions: ['.kt', '.kts'],
};
