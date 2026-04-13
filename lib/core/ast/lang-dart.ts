/**
 * @module lang-dart
 * @description Dart AST Walker 插件
 *
 * 提取: class, mixin, extension, enum, typedef, function, method, field, import
 * 模式: Flutter Widget (Stateless/Stateful/Consumer), Factory, Singleton,
 *        Builder, BLoC/Cubit, Provider/Riverpod, Freezed
 *
 * Phase 5: 新增 ImportRecord 结构化导入 + extractCallSites 调用点提取
 *
 * 注意: tree-sitter-dart 目前尚无兼容 tree-sitter ≥0.25 的稳定版。
 *       已迁移至 web-tree-sitter (WASM)，无原生编译依赖。
 */

import { ImportRecord, type ImportRecordMeta } from '../analysis/ImportRecord.js';

function walkDart(root: any, ctx: any) {
  _walkNode(root, ctx, null);
}

function _walkNode(node: any, ctx: any, parentClassName: any) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_or_export': // tree-sitter-dart import 节点
      case 'import_specification':
      case 'library_import': {
        // tree-sitter-dart AST 嵌套: import_or_export > library_import > import_specification
        // URI 节点埋在深层，直接从文本中用正则提取更可靠
        const text = child.text;
        const pathMatch = text.match(/import\s+(['"])(.+?)\1/);
        if (pathMatch) {
          const importPath = pathMatch[2];
          // Dart: import 'pkg' as alias
          const asMatch = text.match(/\bas\s+(\w+)/);
          const alias = asMatch ? asMatch[1] : null;
          // Dart: import 'pkg' show A, B
          const showClause = text.match(/\bshow\s+([\w\s,]+)/);
          // Dart: import 'pkg' hide A, B  (暂不使用，记录备查)
          // const hideClause = text.match(/\bhide\s+([\w\s,]+)/);

          let symbols = ['*'];
          let kind: ImportRecordMeta['kind'] = 'namespace';
          if (showClause) {
            symbols = showClause[1]
              .split(',')
              .map((s: any) => s.trim())
              .filter(Boolean);
            kind = 'named';
          }

          ctx.imports.push(new ImportRecord(importPath, { symbols, alias, kind }));
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
          (c: any) => c.type === 'identifier' || c.type === 'type_identifier'
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

      case 'function_signature': {
        // 顶层 function_signature 同样需要向前看兄弟 function_body
        const nextSib = node.namedChild(i + 1);
        const bodyNode = nextSib?.type === 'function_body' ? nextSib : null;
        const func = _parseDartMethod(child, parentClassName, bodyNode);
        if (func) {
          ctx.methods.push(func);
        }
        break;
      }

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

function _parseClassDef(node: any, ctx: any) {
  const nameNode = node.namedChildren.find(
    (c: any) => c.type === 'identifier' || c.type === 'type_identifier'
  );
  const name = nameNode?.text || 'Unknown';

  // 检查修饰符
  const isAbstract = node.text.trimStart().startsWith('abstract');
  const isSealed = node.text.trimStart().startsWith('sealed');

  // 父类 (extends)
  let superclass: any = null;
  const superClause = node.namedChildren.find((c: any) => c.type === 'superclass');
  if (superClause) {
    const superType = superClause.namedChildren.find(
      (c: any) => c.type === 'type_identifier' || c.type === 'identifier'
    );
    superclass = superType?.text || null;
  }

  // 实现的接口 (implements)
  const implClause = node.namedChildren.find((c: any) => c.type === 'interfaces');
  const protocols: any[] = [];
  if (implClause) {
    for (let i = 0; i < implClause.namedChildCount; i++) {
      const t = implClause.namedChild(i);
      if (t.type === 'type_identifier' || t.type === 'identifier') {
        protocols.push(t.text);
      }
    }
  }

  // Mixin (with)
  const mixinClause = node.namedChildren.find((c: any) => c.type === 'mixins');
  const mixins: any[] = [];
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
  const body = node.namedChildren.find((c: any) => c.type === 'class_body');
  if (body) {
    _walkClassBody(body, ctx, name);
  }
}

function _walkClassBody(body: any, ctx: any, className: any) {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);

    switch (child.type) {
      case 'method_signature':
      case 'getter_signature':
      case 'setter_signature': {
        // tree-sitter-dart: method_signature 和 function_body 是兄弟节点
        // 需要向前看下一个兄弟，合并传递给解析器
        const nextSibling = body.namedChild(i + 1);
        const bodyNode = nextSibling?.type === 'function_body' ? nextSibling : null;
        const method = _parseDartMethod(child, className, bodyNode);
        if (method) {
          ctx.methods.push(method);
        }
        break;
      }

      case 'function_definition': {
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
          (c: any) => c.type === 'identifier' || c.type === 'constructor_name'
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

function _parseMixinDecl(node: any, ctx: any) {
  const nameNode = node.namedChildren.find(
    (c: any) => c.type === 'identifier' || c.type === 'type_identifier'
  );
  const name = nameNode?.text || 'Unknown';

  const onClause = node.namedChildren.find(
    (c: any) => c.type === 'on_clause' || c.type === 'superclass'
  );
  const constraints: any[] = [];
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

  const body = node.namedChildren.find((c: any) => c.type === 'class_body');
  if (body) {
    _walkClassBody(body, ctx, name);
  }
}

// ── Extension ────────────────────────────────────────────────

function _parseExtensionDecl(node: any, ctx: any) {
  const nameNode = node.namedChildren.find(
    (c: any) => c.type === 'identifier' || c.type === 'type_identifier'
  );
  const name = nameNode?.text || 'anonymous_extension';

  // on Type
  const onType = node.namedChildren.find(
    (c: any) => c.type === 'type_identifier' && c !== nameNode
  );

  ctx.categories.push({
    name,
    targetClass: onType?.text || null,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });

  const body = node.namedChildren.find(
    (c: any) => c.type === 'class_body' || c.type === 'extension_body'
  );
  if (body) {
    _walkClassBody(body, ctx, name);
  }
}

// ── Enum ─────────────────────────────────────────────────────

function _parseEnumDecl(node: any, ctx: any) {
  const nameNode = node.namedChildren.find(
    (c: any) => c.type === 'identifier' || c.type === 'type_identifier'
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

/**
 * 解析 Dart class body 中的 method_signature / getter_signature / setter_signature。
 * tree-sitter-dart 中这些节点的 identifier 嵌在 function_signature 子节点内，
 * 且 function_body 是兄弟节点而非子节点。
 */
function _parseDartMethod(sigNode: any, className: any, bodyNode: any) {
  // 递归搜索第一个 identifier（跳过类型标识符）
  const name = _findMethodName(sigNode);
  if (!name) {
    return null;
  }

  const text = sigNode.text;
  const isStatic = text.includes('static ');
  const isAsync = bodyNode
    ? bodyNode.text.includes('async') || bodyNode.text.includes('async*')
    : false;
  const isOverride = text.includes('@override');

  const bodyLines = bodyNode ? bodyNode.endPosition.row - bodyNode.startPosition.row + 1 : 0;
  const complexity = bodyNode ? _estimateComplexity(bodyNode) : 1;
  const nestingDepth = bodyNode ? _maxNesting(bodyNode, 0) : 0;

  let kind = 'definition';
  if (sigNode.type === 'getter_signature') {
    kind = 'getter';
  }
  if (sigNode.type === 'setter_signature') {
    kind = 'setter';
  }

  return {
    name,
    className: className || null,
    isClassMethod: isStatic,
    isExported: !name.startsWith('_'),
    isAsync,
    isOverride,
    paramCount: _countChildParams(sigNode),
    bodyLines,
    complexity,
    nestingDepth,
    line: sigNode.startPosition.row + 1,
    kind,
  };
}

function _findMethodName(node: any): string | null {
  // method_signature > function_signature > identifier
  // getter_signature > identifier
  // setter_signature > identifier
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === 'identifier') {
      return c.text;
    }
    if (c.type === 'function_signature') {
      const id = c.namedChildren.find((n: any) => n.type === 'identifier');
      if (id) {
        return id.text;
      }
    }
  }
  return null;
}

function _parseFunctionDef(node: any, className: any) {
  // 先尝试直接子节点，再递归搜索
  let name = node.namedChildren.find(
    (c: any) => c.type === 'identifier' || c.type === 'function_name'
  )?.text;
  if (!name) {
    name = _findMethodName(node);
  }
  if (!name) {
    return null;
  }

  const isStatic = node.text.includes('static ');
  const isAsync = node.text.includes('async') || node.text.includes('async*');
  const isOverride = node.text.includes('@override');

  const body = node.namedChildren.find(
    (c: any) => c.type === 'function_body' || c.type === 'block'
  );
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

function _parsePropertyDecl(node: any, className: any) {
  // tree-sitter-dart property 结构:
  //   declaration > type_identifier + initialized_identifier_list > initialized_identifier > identifier
  //   declaration > identifier (简单)
  //   static_final_declaration > identifier
  let name: string | null = null;

  // 1. 直接子节点 identifier
  const directId = node.namedChildren.find((c: any) => c.type === 'identifier');
  if (directId) {
    name = directId.text;
  }

  // 2. 嵌套在 initialized_identifier_list > initialized_identifier > identifier
  if (!name) {
    const idList = node.namedChildren.find((c: any) => c.type === 'initialized_identifier_list');
    if (idList) {
      const initId = idList.namedChildren.find((c: any) => c.type === 'initialized_identifier');
      if (initId) {
        const id = initId.namedChildren.find((c: any) => c.type === 'identifier');
        if (id) {
          name = id.text;
        }
      }
    }
  }

  // 3. 直接 initialized_identifier
  if (!name) {
    const initId = node.namedChildren.find((c: any) => c.type === 'initialized_identifier');
    if (initId) {
      const id = initId.namedChildren.find((c: any) => c.type === 'identifier');
      name = id?.text || initId.text;
    }
  }

  if (!name) {
    return null;
  }

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

function detectDartPatterns(root: any, lang: any, methods: any, properties: any, classes: any) {
  const patterns: any[] = [];

  // 构建 class → methods/properties 索引
  const classMethodMap: Record<string, any> = {};
  const classPropMap: Record<string, any> = {};
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
      (m: any) => m.kind === 'constructor' && m.name.startsWith('_')
    );
    const hasStaticInstance = classProps.some((p: any) => p.isStatic && (p.isFinal || p.isConst));
    const hasFactoryConstructor = classMethods.some((m: any) => m.kind === 'factory');

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
    if (cls.mixins?.some((m: any) => m.startsWith('_$'))) {
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

function _detectExtensions(root: any, patterns: any) {
  let count = 0;
  function walk(node: any) {
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

function _detectStreamUsage(root: any, patterns: any) {
  let streamCount = 0;
  function walk(node: any) {
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

function _countChildParams(node: any) {
  let count = 0;
  function walk(n: any) {
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

function _estimateComplexity(node: any) {
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
  function walk(n: any) {
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

function _maxNesting(node: any, depth: any) {
  const NESTING_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
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

// ── Dart Call Site 提取 (Phase 5) ────────────────────────────

/**
 * 从 Dart AST root 提取所有调用点
 * 遍历 function_definition / method 中的 body → 各种 invocation 节点
 */
function extractCallSitesDart(root: any, ctx: any, _lang: any) {
  const scopes = _collectDartScopes(root);
  for (const scope of scopes) {
    _extractDartCallSitesFromBody(scope.body, scope.className, scope.methodName, ctx);
  }
}

/** 递归收集 Dart 中所有函数/方法体作用域 */
function _collectDartScopes(root: any) {
  const scopes: any[] = [];

  function visit(node: any, className: any) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);

      if (child.type === 'class_definition') {
        const name = child.namedChildren.find(
          (c: any) => c.type === 'identifier' || c.type === 'type_identifier'
        )?.text;
        const body = child.namedChildren.find((c: any) => c.type === 'class_body');
        if (body) {
          visit(body, name || className);
        }
      } else if (child.type === 'mixin_declaration') {
        const name = child.namedChildren.find(
          (c: any) => c.type === 'identifier' || c.type === 'type_identifier'
        )?.text;
        const body = child.namedChildren.find((c: any) => c.type === 'class_body');
        if (body) {
          visit(body, name || className);
        }
      } else if (child.type === 'extension_declaration') {
        const name = child.namedChildren.find(
          (c: any) => c.type === 'identifier' || c.type === 'type_identifier'
        )?.text;
        const body = child.namedChildren.find(
          (c: any) => c.type === 'class_body' || c.type === 'extension_body'
        );
        if (body) {
          visit(body, name || className);
        }
      } else if (
        child.type === 'function_definition' ||
        child.type === 'method_signature' ||
        child.type === 'function_signature'
      ) {
        // 提取方法/函数名
        let name: string | undefined;
        if (child.type === 'method_signature' || child.type === 'function_signature') {
          // method_signature 可能包含嵌套 function_signature
          const funcSig =
            child.namedChildren.find((c: any) => c.type === 'function_signature') || child;
          name = funcSig.namedChildren.find(
            (c: any) => c.type === 'identifier' || c.type === 'function_name'
          )?.text;
        } else {
          name = child.namedChildren.find(
            (c: any) => c.type === 'identifier' || c.type === 'function_name'
          )?.text;
        }

        // tree-sitter-dart: function_body 可能是子节点或下一个兄弟节点
        let body = child.namedChildren.find(
          (c: any) => c.type === 'function_body' || c.type === 'block'
        );
        // 如果 body 不在子节点中，检查下一个兄弟节点 (tree-sitter-dart 的 sibling 结构)
        if (!body && i + 1 < node.namedChildCount) {
          const nextSibling = node.namedChild(i + 1);
          if (nextSibling?.type === 'function_body' || nextSibling?.type === 'block') {
            body = nextSibling;
            i++; // 跳过已消费的 body 节点
          }
        }
        if (name && body) {
          scopes.push({ body, className, methodName: name });
        }
      } else if (child.type === 'getter_signature' || child.type === 'setter_signature') {
        const name = child.namedChildren.find((c: any) => c.type === 'identifier')?.text;
        let body = child.namedChildren.find(
          (c: any) => c.type === 'function_body' || c.type === 'block'
        );
        if (!body && i + 1 < node.namedChildCount) {
          const nextSibling = node.namedChild(i + 1);
          if (nextSibling?.type === 'function_body' || nextSibling?.type === 'block') {
            body = nextSibling;
            i++;
          }
        }
        if (name && body) {
          scopes.push({ body, className, methodName: `get_${name}` });
        }
      }
    }
  }

  visit(root, null);
  return scopes;
}

/**
 * 从 Dart function body 中递归提取调用点
 *
 * tree-sitter-dart 的调用表达式由 **兄弟节点序列** 构成（而非单个 call_expression 节点）：
 *   Pattern A:  identifier + selector("(args)")                → 直接调用: func(args)
 *   Pattern B:  (identifier|this|super) + selector(".method")  → 方法调用: obj.method(args)
 *               + selector("(args)")
 * 因此需要 sibling-aware scanning，避免逐个 walk 子节点时丢失上下文。
 */
function _extractDartCallSitesFromBody(bodyNode: any, className: any, methodName: any, ctx: any) {
  if (!bodyNode) {
    return;
  }

  const DART_NOISE = new Set([
    'print',
    'debugPrint',
    'log',
    'setState',
    'notifyListeners',
    'List',
    'Map',
    'Set',
    'Future',
    'Stream',
  ]);

  /** 在 selectorNode 的子树中查找 arguments / argument_part */
  function findArgs(selectorNode: any) {
    return selectorNode.namedChildren.find(
      (c: any) => c.type === 'arguments' || c.type === 'argument_part'
    );
  }

  /**
   * 尝试从 parent.namedChild(idx) 开始消费一条调用链。
   * 成功 → 返回消费到的最后一个子节点索引；失败 → 返回 null。
   */
  function tryConsumeCall(parent: any, idx: any, startNode: any, isAwaited: any) {
    const sib1 = parent.namedChild(idx + 1);
    if (!sib1) {
      return null;
    }

    // ── Pattern A: identifier + selector("(args)") → 直接调用 ────────
    if (
      (startNode.type === 'identifier' || startNode.type === 'type_identifier') &&
      sib1.type === 'selector' &&
      /^\s*\(/.test(sib1.text)
    ) {
      const callee = startNode.text;
      if (!DART_NOISE.has(callee)) {
        const callType = /^[A-Z]/.test(callee) ? 'constructor' : 'function';
        const args = findArgs(sib1);
        ctx.callSites.push({
          callee,
          callerMethod: methodName,
          callerClass: className,
          callType,
          receiver: null,
          receiverType: callType === 'constructor' ? callee : null,
          argCount: args ? args.namedChildCount : 0,
          line: startNode.startPosition.row + 1,
          isAwait: isAwaited,
        });
      }
      // 递归扫描 selector 内部（处理嵌套调用，如 MyApp() 内的参数调用）
      scanChildren(sib1, false);
      return idx + 1;
    }

    // ── Pattern B: receiver + methodSelector + argsSelector → 方法调用 ──
    const sib2 = parent.namedChild(idx + 2);
    const isMethodSel =
      sib1.type === 'selector' || sib1.type === 'unconditional_assignable_selector';
    const isArgsSel = sib2?.type === 'selector' && sib2.text.includes('(');

    if (isMethodSel && isArgsSel) {
      const methodMatch = sib1.text.match(/\.(\w+)/);
      if (methodMatch) {
        const callee = methodMatch[1];
        const receiverText = startNode.text;
        const receiver = receiverText;
        let receiverType: any = null;
        let callType: string;

        if (startNode.type === 'this' || receiver === 'this' || receiver === 'self') {
          receiverType = className;
          callType = 'method';
        } else if (startNode.type === 'super' || receiver === 'super') {
          receiverType = className;
          callType = 'super';
        } else if (/^[A-Z]/.test(receiver)) {
          receiverType = receiver;
          callType = 'static';
        } else {
          callType = 'method';
        }

        if (!DART_NOISE.has(callee)) {
          const args = findArgs(sib2);
          ctx.callSites.push({
            callee,
            callerMethod: methodName,
            callerClass: className,
            callType,
            receiver,
            receiverType,
            argCount: args ? args.namedChildCount : 0,
            line: startNode.startPosition.row + 1,
            isAwait: isAwaited,
          });
        }
        // 递归扫描 argsSelector 内部
        scanChildren(sib2, false);
        return idx + 2;
      }
    }

    return null; // 未匹配任何模式
  }

  /**
   * 以 sibling-aware 方式扫描 node 的 namedChildren。
   * 当发现调用起始节点(identifier / this / super)时，尝试消费完整调用链并跳过已消费兄弟。
   */
  function scanChildren(node: any, isAwaited: any) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);

      // await → 标记子树为 awaited
      if (child.type === 'await_expression') {
        scanChildren(child, true);
        continue;
      }

      // function_expression_invocation / method_invocation (部分 grammar 变体)
      if (child.type === 'function_expression_invocation' || child.type === 'method_invocation') {
        _processDartCall(child, className, methodName, ctx, isAwaited, DART_NOISE);
        const args = child.namedChildren.find(
          (c: any) => c.type === 'arguments' || c.type === 'argument_part'
        );
        if (args) {
          scanChildren(args, false);
        }
        continue;
      }

      // 尝试从当前位置消费调用模式
      const isCallStarter =
        child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'this' ||
        child.type === 'super';

      if (isCallStarter) {
        const consumed = tryConsumeCall(node, i, child, isAwaited);
        if (consumed !== null) {
          i = consumed; // 跳过已消费的兄弟
          continue;
        }
      }

      // Dart cascade: obj..method1()..method2()
      if (child.type === 'cascade_section') {
        _processDartCall(child, className, methodName, ctx, isAwaited, DART_NOISE);
        scanChildren(child, false);
        continue;
      }

      // 未匹配 → 递归进入子节点
      scanChildren(child, isAwaited);
    }
  }

  scanChildren(bodyNode, false);
}

/** 处理 Dart 函数/方法调用节点 */
function _processDartCall(
  node: any,
  className: any,
  methodName: any,
  ctx: any,
  isAwaited: any,
  DART_NOISE: any
) {
  const text = node.text || '';
  const callMatch = text.match(/^(?:(\w[\w.]*?)\.)?(\w+)\s*\(/);
  if (!callMatch) {
    return;
  }

  const receiverText = callMatch[1] || null;
  const callee = callMatch[2];

  if (DART_NOISE.has(callee)) {
    return;
  }

  const receiver = receiverText;
  let receiverType: any = null;
  let callType: string;

  if (receiver === 'this' || receiver === 'super') {
    receiverType = className;
    callType = receiver === 'super' ? 'super' : 'method';
  } else if (receiver && /^[A-Z]/.test(receiver)) {
    receiverType = receiver;
    callType = 'static';
  } else if (receiver) {
    callType = 'method';
  } else {
    callType = /^[A-Z]/.test(callee) ? 'constructor' : 'function';
    if (callType === 'constructor') {
      receiverType = callee;
    }
  }

  const args = node.namedChildren.find(
    (c: any) => c.type === 'arguments' || c.type === 'argument_part'
  );
  const argCount = args ? args.namedChildCount : 0;

  ctx.callSites.push({
    callee,
    callerMethod: methodName,
    callerClass: className,
    callType,
    receiver,
    receiverType,
    argCount,
    line: node.startPosition.row + 1,
    isAwait: isAwaited,
  });
}

// ── Plugin Export ────────────────────────────────────────────

let _grammar: any = null;
function getGrammar() {
  return _grammar;
}
export function setGrammar(grammar: any) {
  _grammar = grammar;
}

export const plugin = {
  getGrammar,
  walk: walkDart,
  detectPatterns: detectDartPatterns,
  extractCallSites: extractCallSitesDart,
  extensions: ['.dart'],
};
