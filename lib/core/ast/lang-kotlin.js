/**
 * @module lang-kotlin
 * @description Kotlin AST Walker 插件
 *
 * 提取: class, interface, object, enum, sealed class, function, property, import, annotation
 * 模式: Singleton (object), Factory (companion), DSL, Flow, Sealed
 */

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
          ctx.imports.push(id.text);
        }
        break;
      }

      case 'class_declaration': {
        const classInfo = _parseKtClass(child);
        ctx.classes.push(classInfo);
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
        inner.outerClass = className;
        ctx.classes.push(inner);
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

  return {
    name,
    className,
    isConstant: isVal,
    isMutable: isVar,
    isLazy,
    isLateinit,
    line: node.startPosition.row + 1,
  };
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
  extensions: ['.kt', '.kts'],
};
