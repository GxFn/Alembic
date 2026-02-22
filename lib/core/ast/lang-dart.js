/**
 * @module lang-dart
 * @description Dart AST Walker 插件
 *
 * 提取: class, mixin, extension, enum, typedef, function, method, field, import
 * 模式: Flutter Widget (Stateless/Stateful/Consumer), Factory, Singleton,
 *        Builder, BLoC/Cubit, Provider/Riverpod, Freezed
 *
 * 注意: tree-sitter-dart 目前尚无兼容 tree-sitter ≥0.25 的稳定版。
 *       已迁移至 web-tree-sitter (WASM)，无原生编译依赖。
 */

function walkDart(root, ctx) {
  _walkNode(root, ctx, null);
}

function _walkNode(node, ctx, parentClassName) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_or_export': // tree-sitter-dart import 节点
      case 'import_specification':
      case 'library_import': {
        const uri = child.namedChildren.find(
          (c) => c.type === 'uri' || c.type === 'string_literal' || c.type === 'configurable_uri'
        );
        if (uri) {
          ctx.imports.push(uri.text.replace(/['"]/g, ''));
        }
        break;
      }

      case 'class_definition': {
        _parseClassDef(child, ctx);
        break;
      }

      case 'mixin_declaration': {
        _parseMixinDecl(child, ctx);
        break;
      }

      case 'extension_declaration': {
        _parseExtensionDecl(child, ctx);
        break;
      }

      case 'enum_declaration': {
        _parseEnumDecl(child, ctx);
        break;
      }

      case 'type_alias': {
        const nameNode = child.namedChildren.find(
          (c) => c.type === 'identifier' || c.type === 'type_identifier'
        );
        if (nameNode) {
          ctx.classes.push({
            name: nameNode.text,
            kind: 'typedef',
            line: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          });
        }
        break;
      }

      case 'function_signature':
      case 'function_definition':
      case 'top_level_definition': {
        const func = _parseFunctionDef(child, parentClassName);
        if (func) {
          ctx.methods.push(func);
        }
        break;
      }

      case 'initialized_variable_definition':
      case 'static_final_declaration':
      case 'declaration': {
        const prop = _parsePropertyDecl(child, parentClassName);
        if (prop) {
          ctx.properties.push(prop);
        }
        break;
      }

      default: {
        // 递归进入未明确处理的容器节点
        if (
          child.namedChildCount > 0 &&
          !['function_body', 'block', 'string_literal', 'arguments'].includes(child.type)
        ) {
          _walkNode(child, ctx, parentClassName);
        }
      }
    }
  }
}

// ── Class ────────────────────────────────────────────────────

function _parseClassDef(node, ctx) {
  const nameNode = node.namedChildren.find(
    (c) => c.type === 'identifier' || c.type === 'type_identifier'
  );
  const name = nameNode?.text || 'Unknown';

  // 检查修饰符
  const isAbstract = node.text.trimStart().startsWith('abstract');
  const isSealed = node.text.trimStart().startsWith('sealed');

  // 父类 (extends)
  let superclass = null;
  const superClause = node.namedChildren.find((c) => c.type === 'superclass');
  if (superClause) {
    const superType = superClause.namedChildren.find(
      (c) => c.type === 'type_identifier' || c.type === 'identifier'
    );
    superclass = superType?.text || null;
  }

  // 实现的接口 (implements)
  const implClause = node.namedChildren.find((c) => c.type === 'interfaces');
  const protocols = [];
  if (implClause) {
    for (let i = 0; i < implClause.namedChildCount; i++) {
      const t = implClause.namedChild(i);
      if (t.type === 'type_identifier' || t.type === 'identifier') {
        protocols.push(t.text);
      }
    }
  }

  // Mixin (with)
  const mixinClause = node.namedChildren.find((c) => c.type === 'mixins');
  const mixins = [];
  if (mixinClause) {
    for (let i = 0; i < mixinClause.namedChildCount; i++) {
      const t = mixinClause.namedChild(i);
      if (t.type === 'type_identifier' || t.type === 'identifier') {
        mixins.push(t.text);
      }
    }
  }

  let kind = 'class';
  if (isAbstract) {
    kind = 'abstract-class';
  }
  if (isSealed) {
    kind = 'sealed-class';
  }

  ctx.classes.push({
    name,
    kind,
    superclass,
    protocols,
    mixins,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });

  // Walk class body
  const body = node.namedChildren.find((c) => c.type === 'class_body');
  if (body) {
    _walkClassBody(body, ctx, name);
  }
}

function _walkClassBody(body, ctx, className) {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);

    switch (child.type) {
      case 'method_signature':
      case 'function_definition':
      case 'getter_signature':
      case 'setter_signature': {
        const method = _parseFunctionDef(child, className);
        if (method) {
          ctx.methods.push(method);
        }
        break;
      }

      case 'declaration':
      case 'initialized_variable_definition':
      case 'static_final_declaration': {
        const prop = _parsePropertyDecl(child, className);
        if (prop) {
          ctx.properties.push(prop);
        }
        break;
      }

      case 'constructor_signature': {
        const nameNode = child.namedChildren.find(
          (c) => c.type === 'identifier' || c.type === 'constructor_name'
        );
        const isFactory = child.text.trimStart().startsWith('factory');
        ctx.methods.push({
          name: nameNode?.text || className,
          className,
          isClassMethod: false,
          isExported: true,
          isFactory,
          paramCount: _countChildParams(child),
          line: child.startPosition.row + 1,
          kind: isFactory ? 'factory' : 'constructor',
        });
        break;
      }

      default: {
        if (child.namedChildCount > 0) {
          _walkNode(child, ctx, className);
        }
      }
    }
  }
}

// ── Mixin ────────────────────────────────────────────────────

function _parseMixinDecl(node, ctx) {
  const nameNode = node.namedChildren.find(
    (c) => c.type === 'identifier' || c.type === 'type_identifier'
  );
  const name = nameNode?.text || 'Unknown';

  const onClause = node.namedChildren.find(
    (c) => c.type === 'on_clause' || c.type === 'superclass'
  );
  const constraints = [];
  if (onClause) {
    for (let i = 0; i < onClause.namedChildCount; i++) {
      const t = onClause.namedChild(i);
      if (t.type === 'type_identifier' || t.type === 'identifier') {
        constraints.push(t.text);
      }
    }
  }

  ctx.classes.push({
    name,
    kind: 'mixin',
    superclass: constraints[0] || null,
    protocols: constraints.slice(1),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });

  const body = node.namedChildren.find((c) => c.type === 'class_body');
  if (body) {
    _walkClassBody(body, ctx, name);
  }
}

// ── Extension ────────────────────────────────────────────────

function _parseExtensionDecl(node, ctx) {
  const nameNode = node.namedChildren.find(
    (c) => c.type === 'identifier' || c.type === 'type_identifier'
  );
  const name = nameNode?.text || 'anonymous_extension';

  // on Type
  const onType = node.namedChildren.find((c) => c.type === 'type_identifier' && c !== nameNode);

  ctx.categories.push({
    name,
    targetClass: onType?.text || null,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });

  const body = node.namedChildren.find(
    (c) => c.type === 'class_body' || c.type === 'extension_body'
  );
  if (body) {
    _walkClassBody(body, ctx, name);
  }
}

// ── Enum ─────────────────────────────────────────────────────

function _parseEnumDecl(node, ctx) {
  const nameNode = node.namedChildren.find(
    (c) => c.type === 'identifier' || c.type === 'type_identifier'
  );
  const name = nameNode?.text || 'Unknown';

  ctx.classes.push({
    name,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });
}

// ── Function / Method ────────────────────────────────────────

function _parseFunctionDef(node, className) {
  const nameNode = node.namedChildren.find(
    (c) => c.type === 'identifier' || c.type === 'function_name'
  );
  const name = nameNode?.text;
  if (!name) {
    return null;
  }

  const isStatic = node.text.includes('static ');
  const isAsync = node.text.includes('async') || node.text.includes('async*');
  const isOverride = node.text.includes('@override');

  const body = node.namedChildren.find((c) => c.type === 'function_body' || c.type === 'block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  return {
    name,
    className: className || null,
    isClassMethod: isStatic || !className,
    isExported: !name.startsWith('_'),
    isAsync,
    isOverride,
    paramCount: _countChildParams(node),
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

// ── Property / Field ─────────────────────────────────────────

function _parsePropertyDecl(node, className) {
  const nameNode = node.namedChildren.find(
    (c) => c.type === 'identifier' || c.type === 'initialized_identifier'
  );
  if (!nameNode) {
    return null;
  }

  const name = nameNode.text;
  const text = node.text;
  const isFinal = text.includes('final ');
  const isLate = text.includes('late ');
  const isConst = text.includes('const ');
  const isStatic = text.includes('static ');

  return {
    name,
    className: className || null,
    isExported: !name.startsWith('_'),
    isFinal,
    isLate,
    isConst,
    isStatic,
    line: node.startPosition.row + 1,
  };
}

// ── Dart Pattern Detection ───────────────────────────────────

function detectDartPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  // 构建 class → methods/properties 索引
  const classMethodMap = {};
  const classPropMap = {};
  for (const m of methods) {
    if (m.className) {
      if (!classMethodMap[m.className]) {
        classMethodMap[m.className] = [];
      }
      classMethodMap[m.className].push(m);
    }
  }
  for (const p of properties) {
    if (p.className) {
      if (!classPropMap[p.className]) {
        classPropMap[p.className] = [];
      }
      classPropMap[p.className].push(p);
    }
  }

  for (const cls of classes) {
    // Flutter Widget 模式
    if (
      cls.superclass === 'StatelessWidget' ||
      cls.superclass === 'HookWidget' ||
      cls.superclass === 'HookConsumerWidget' ||
      cls.superclass === 'ConsumerWidget'
    ) {
      patterns.push({
        type: 'stateless-widget',
        className: cls.name,
        superclass: cls.superclass,
        line: cls.line,
        confidence: 0.95,
      });
    }

    if (cls.superclass === 'StatefulWidget') {
      patterns.push({
        type: 'stateful-widget',
        className: cls.name,
        line: cls.line,
        confidence: 0.95,
      });
    }

    if (cls.superclass === 'State') {
      patterns.push({
        type: 'state-class',
        className: cls.name,
        line: cls.line,
        confidence: 0.9,
      });
    }

    // BLoC / Cubit 模式
    if (cls.superclass === 'Bloc' || cls.superclass === 'Cubit') {
      patterns.push({
        type: 'bloc',
        className: cls.name,
        variant: cls.superclass.toLowerCase(),
        line: cls.line,
        confidence: 0.95,
      });
    }

    // ChangeNotifier (Provider pattern)
    if (cls.superclass === 'ChangeNotifier' || cls.mixins?.includes('ChangeNotifier')) {
      patterns.push({
        type: 'change-notifier',
        className: cls.name,
        line: cls.line,
        confidence: 0.9,
      });
    }

    // Singleton pattern — private constructor + static instance
    const classMethods = classMethodMap[cls.name] || [];
    const classProps = classPropMap[cls.name] || [];
    const hasPrivateConstructor = classMethods.some(
      (m) => m.kind === 'constructor' && m.name.startsWith('_')
    );
    const hasStaticInstance = classProps.some((p) => p.isStatic && (p.isFinal || p.isConst));
    const hasFactoryConstructor = classMethods.some((m) => m.kind === 'factory');

    if (hasPrivateConstructor && (hasStaticInstance || hasFactoryConstructor)) {
      patterns.push({
        type: 'singleton',
        className: cls.name,
        line: cls.line,
        confidence: 0.85,
      });
    }

    // Factory pattern — factory constructors
    if (hasFactoryConstructor) {
      patterns.push({
        type: 'factory',
        className: cls.name,
        line: cls.line,
        confidence: 0.8,
      });
    }

    // Mixin pattern
    if (cls.kind === 'mixin') {
      patterns.push({
        type: 'mixin',
        className: cls.name,
        line: cls.line,
        confidence: 0.9,
      });
    }

    // Sealed class (algebraic data type)
    if (cls.kind === 'sealed-class') {
      patterns.push({
        type: 'sealed-class',
        className: cls.name,
        line: cls.line,
        confidence: 0.95,
      });
    }

    // Freezed pattern — @freezed/@Freezed annotation + with _$ClassName mixin
    if (cls.mixins?.some((m) => m.startsWith('_$'))) {
      patterns.push({
        type: 'freezed',
        className: cls.name,
        line: cls.line,
        confidence: 0.9,
      });
    }

    // Repository 分层
    if (cls.kind === 'abstract-class' && /(Repository|DataSource|Service)$/.test(cls.name)) {
      patterns.push({
        type: 'repository-abstraction',
        className: cls.name,
        line: cls.line,
        confidence: 0.7,
      });
    }
  }

  // Extension methods
  _detectExtensions(root, patterns);

  // Stream 使用
  _detectStreamUsage(root, patterns);

  return patterns;
}

function _detectExtensions(root, patterns) {
  let count = 0;
  function walk(node) {
    if (node.type === 'extension_declaration') {
      count++;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
  }
  walk(root);
  if (count > 0) {
    patterns.push({
      type: 'extension-methods',
      count,
      confidence: 0.9,
    });
  }
}

function _detectStreamUsage(root, patterns) {
  let streamCount = 0;
  function walk(node) {
    if (node.type === 'type_identifier' && node.text === 'Stream') {
      streamCount++;
    }
    if (
      node.type === 'identifier' &&
      (node.text === 'StreamController' || node.text === 'StreamSubscription')
    ) {
      streamCount++;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
  }
  walk(root);
  if (streamCount > 0) {
    patterns.push({
      type: 'stream-reactive',
      count: streamCount,
      confidence: 0.85,
    });
  }
}

// ── Utility ──────────────────────────────────────────────────

function _countChildParams(node) {
  let count = 0;
  function walk(n) {
    if (
      n.type === 'formal_parameter' ||
      n.type === 'normal_formal_parameter' ||
      n.type === 'default_formal_parameter'
    ) {
      count++;
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      walk(n.namedChild(i));
    }
  }
  walk(node);
  return count;
}

function _estimateComplexity(node) {
  let complexity = 1;
  const BRANCH_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'switch_expression',
    'case_clause',
    'catch_clause',
    'conditional_expression', // ternary ? :
  ]);
  function walk(n) {
    if (BRANCH_TYPES.has(n.type)) {
      complexity++;
    }
    if (n.type === 'binary_expression') {
      const text = n.text;
      if (text.includes('&&') || text.includes('||')) {
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
    'do_statement',
    'switch_statement',
    'block',
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

// ── Plugin Export ────────────────────────────────────────────

let _grammar = null;
function getGrammar() {
  return _grammar;
}
export function setGrammar(grammar) {
  _grammar = grammar;
}

export const plugin = {
  getGrammar,
  walk: walkDart,
  detectPatterns: detectDartPatterns,
  extensions: ['.dart'],
};
