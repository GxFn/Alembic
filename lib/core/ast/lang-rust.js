/**
 * @module lang-rust
 * @description Rust AST Walker 插件
 *
 * 提取: struct, enum, trait, impl, function, method, mod, use, const/static
 * 模式: Builder, Newtype, Factory (new/from), Error Handling (Result/Option/?),
 *        Async (tokio/async-std), Unsafe block, Derive macro
 *
 * Phase 5: 新增 ImportRecord 结构化导入 + extractCallSites 调用点提取
 */

import { ImportRecord } from '../analysis/ImportRecord.js';

function walkRust(root, ctx) {
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    _walkNode(child, ctx);
  }
}

function _walkNode(node, ctx) {
  switch (node.type) {
    case 'use_declaration': {
      _parseUseDecl(node, ctx);
      break;
    }

    case 'mod_item': {
      _parseModItem(node, ctx);
      break;
    }

    case 'struct_item': {
      _parseStruct(node, ctx);
      break;
    }

    case 'enum_item': {
      _parseEnum(node, ctx);
      break;
    }

    case 'trait_item': {
      _parseTrait(node, ctx);
      break;
    }

    case 'impl_item': {
      _parseImpl(node, ctx);
      break;
    }

    case 'function_item': {
      const funcInfo = _parseFunctionItem(node);
      if (funcInfo) {
        ctx.methods.push(funcInfo);
      }
      break;
    }

    case 'const_item':
    case 'static_item': {
      _parseConstStatic(node, ctx);
      break;
    }

    case 'type_item': {
      _parseTypeAlias(node, ctx);
      break;
    }

    case 'macro_definition': {
      _parseMacroDef(node, ctx);
      break;
    }

    // 带 attribute 的顶层项
    case 'attribute_item':
    case 'inner_attribute_item':
      break;

    default:
      break;
  }
}

// ── Use Declaration ──────────────────────────────────────────

function _parseUseDecl(node, ctx) {
  const argNode = node.namedChildren.find(
    (c) =>
      c.type === 'use_wildcard' ||
      c.type === 'use_list' ||
      c.type === 'use_as_clause' ||
      c.type === 'scoped_identifier' ||
      c.type === 'identifier' ||
      c.type === 'scoped_use_list'
  );
  if (!argNode) return;

  const text = argNode.text;

  if (argNode.type === 'use_as_clause') {
    // use crate::mod::Foo as Bar
    const pathNode = argNode.namedChildren.find(
      (c) => c.type === 'scoped_identifier' || c.type === 'identifier'
    );
    const aliasNode = argNode.namedChildren.find((c) => c.type === 'identifier' && c !== pathNode);
    const fullPath = pathNode?.text || text;
    const segments = fullPath.split('::');
    const lastName = segments[segments.length - 1];
    ctx.imports.push(
      new ImportRecord(fullPath, {
        symbols: [lastName],
        alias: aliasNode?.text || lastName,
        kind: 'named',
      })
    );
  } else if (argNode.type === 'use_wildcard') {
    // use crate::mod::*
    const pathPart = text.replace(/::\*$/, '');
    ctx.imports.push(
      new ImportRecord(pathPart, { symbols: ['*'], kind: 'namespace' })
    );
  } else if (argNode.type === 'use_list' || argNode.type === 'scoped_use_list') {
    // use crate::mod::{A, B, C}  or  use {A, B}
    // Extract path prefix and symbol list from text
    const match = text.match(/^(.+)::\{(.+)\}$/s);
    if (match) {
      const prefix = match[1];
      const symbolsStr = match[2];
      const symbols = symbolsStr.split(',').map((s) => s.trim().split('::').pop().split(' as ')[0].trim()).filter(Boolean);
      ctx.imports.push(
        new ImportRecord(prefix, { symbols, kind: 'named' })
      );
    } else {
      ctx.imports.push(new ImportRecord(text));
    }
  } else if (argNode.type === 'scoped_identifier') {
    // use crate::mod::Struct
    const segments = text.split('::');
    const lastName = segments[segments.length - 1];
    const prefix = segments.slice(0, -1).join('::');
    ctx.imports.push(
      new ImportRecord(prefix || text, { symbols: [lastName], alias: lastName, kind: 'named' })
    );
  } else {
    // use identifier (rare: e.g. `use std;`)
    ctx.imports.push(new ImportRecord(text, { symbols: ['*'], alias: text, kind: 'namespace' }));
  }
}

// ── Mod Item ─────────────────────────────────────────────────

function _parseModItem(node, ctx) {
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  if (nameNode) {
    ctx.metadata = ctx.metadata || {};
    ctx.metadata.modules = ctx.metadata.modules || [];
    ctx.metadata.modules.push(nameNode.text);
  }
  // 如果是 inline mod { ... }，递归内部声明
  const body = node.namedChildren.find((c) => c.type === 'declaration_list');
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      _walkNode(body.namedChild(i), ctx);
    }
  }
}

// ── Struct ───────────────────────────────────────────────────

function _parseStruct(node, ctx) {
  const nameNode = node.namedChildren.find((c) => c.type === 'type_identifier');
  const name = nameNode?.text || 'Unknown';

  const fields = [];
  const derives = _extractDerives(node);

  // Named fields (struct Foo { field: Type })
  const fieldList = node.namedChildren.find((c) => c.type === 'field_declaration_list');
  if (fieldList) {
    for (let i = 0; i < fieldList.namedChildCount; i++) {
      const field = fieldList.namedChild(i);
      if (field.type !== 'field_declaration') {
        continue;
      }
      const fieldId = field.namedChildren.find((c) => c.type === 'field_identifier');
      if (fieldId) {
        const isPublic = _hasPubVisibility(field);
        ctx.properties.push({
          name: fieldId.text,
          className: name,
          isExported: isPublic,
          line: field.startPosition.row + 1,
        });
        fields.push(fieldId.text);
      }
    }
  }

  // Tuple struct fields (struct Foo(Type1, Type2))
  const orderedFields = node.namedChildren.find((c) => c.type === 'ordered_field_declaration_list');
  if (orderedFields) {
    let idx = 0;
    for (let i = 0; i < orderedFields.namedChildCount; i++) {
      const child = orderedFields.namedChild(i);
      // Skip visibility markers
      if (child.type === 'visibility_modifier') {
        continue;
      }
      if (
        child.type.includes('type') ||
        child.type === 'primitive_type' ||
        child.type === 'scoped_type_identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'generic_type' ||
        child.type === 'reference_type'
      ) {
        fields.push(`${idx}`);
        idx++;
      }
    }
  }

  ctx.classes.push({
    name,
    kind: 'struct',
    superclass: null,
    protocols: [],
    derives,
    fieldCount: fields.length,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });
}

// ── Enum ─────────────────────────────────────────────────────

function _parseEnum(node, ctx) {
  const nameNode = node.namedChildren.find((c) => c.type === 'type_identifier');
  const name = nameNode?.text || 'Unknown';
  const derives = _extractDerives(node);

  const variants = [];
  const body = node.namedChildren.find((c) => c.type === 'enum_variant_list');
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const variant = body.namedChild(i);
      if (variant.type === 'enum_variant') {
        const variantName = variant.namedChildren.find((c) => c.type === 'identifier');
        if (variantName) {
          variants.push(variantName.text);
        }
      }
    }
  }

  ctx.classes.push({
    name,
    kind: 'enum',
    superclass: null,
    protocols: [],
    derives,
    variants,
    variantCount: variants.length,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });
}

// ── Trait ─────────────────────────────────────────────────────

function _parseTrait(node, ctx) {
  const nameNode = node.namedChildren.find((c) => c.type === 'type_identifier');
  const name = nameNode?.text || 'Unknown';

  const methods = [];
  const superTraits = [];

  // Trait bounds (trait Foo: Bar + Baz)
  const bounds = node.namedChildren.find((c) => c.type === 'trait_bounds');
  if (bounds) {
    for (let i = 0; i < bounds.namedChildCount; i++) {
      const bound = bounds.namedChild(i);
      if (
        bound.type === 'type_identifier' ||
        bound.type === 'scoped_type_identifier' ||
        bound.type === 'generic_type'
      ) {
        superTraits.push(bound.text);
      }
    }
  }

  // Trait body — collect method signatures
  const body = node.namedChildren.find((c) => c.type === 'declaration_list');
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const item = body.namedChild(i);
      if (item.type === 'function_signature_item' || item.type === 'function_item') {
        const methodName = item.namedChildren.find((c) => c.type === 'identifier');
        if (methodName) {
          methods.push(methodName.text);
        }
      }
    }
  }

  ctx.protocols.push({
    name,
    inherits: superTraits,
    methods,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  });
}

// ── Impl Block ───────────────────────────────────────────────

function _parseImpl(node, ctx) {
  // impl Type { ... } 或 impl Trait for Type { ... }
  let selfType = null;
  let traitName = null;

  const typeIdNodes = node.namedChildren.filter(
    (c) =>
      c.type === 'type_identifier' ||
      c.type === 'scoped_type_identifier' ||
      c.type === 'generic_type'
  );

  // 检查是否有 "for" — trait impl
  const hasFor = node.children?.some((c) => c.type === 'for');

  if (hasFor && typeIdNodes.length >= 2) {
    traitName = typeIdNodes[0]?.text;
    selfType = typeIdNodes[1]?.text;
  } else if (typeIdNodes.length >= 1) {
    selfType = typeIdNodes[0]?.text;
  }

  const body = node.namedChildren.find((c) => c.type === 'declaration_list');
  if (!body || !selfType) {
    return;
  }

  for (let i = 0; i < body.namedChildCount; i++) {
    const item = body.namedChild(i);
    if (item.type === 'function_item') {
      const methodInfo = _parseImplMethod(item, selfType, traitName);
      if (methodInfo) {
        ctx.methods.push(methodInfo);
      }
    }
  }
}

function _parseImplMethod(node, selfType, traitName) {
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  const name = nameNode?.text;
  if (!name) {
    return null;
  }

  const params = node.namedChildren.find((c) => c.type === 'parameters');
  const { paramCount, hasSelfParam } = params
    ? _countRustParams(params)
    : { paramCount: 0, hasSelfParam: false };

  const isPublic = _hasPubVisibility(node);
  const isAsync = node.children?.some((c) => c.text === 'async') || false;

  const body = node.namedChildren.find((c) => c.type === 'block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  return {
    name,
    className: selfType,
    isClassMethod: !hasSelfParam, // 无 self → associated function (static)
    isExported: isPublic,
    isAsync,
    traitImpl: traitName || null,
    paramCount,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

// ── Function Item (free fn) ──────────────────────────────────

function _parseFunctionItem(node) {
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  const name = nameNode?.text;
  if (!name) {
    return null;
  }

  const params = node.namedChildren.find((c) => c.type === 'parameters');
  const { paramCount } = params ? _countRustParams(params) : { paramCount: 0 };

  const isPublic = _hasPubVisibility(node);
  const isAsync = node.children?.some((c) => c.text === 'async') || false;
  const isUnsafe = node.children?.some((c) => c.text === 'unsafe') || false;

  const body = node.namedChildren.find((c) => c.type === 'block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  return {
    name,
    className: null,
    isClassMethod: true, // free function → "static" equivalent
    isExported: isPublic,
    isAsync,
    isUnsafe,
    paramCount,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

// ── Const / Static ───────────────────────────────────────────

function _parseConstStatic(node, ctx) {
  const isConst = node.type === 'const_item';
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  if (nameNode) {
    ctx.properties.push({
      name: nameNode.text,
      className: null,
      isExported: _hasPubVisibility(node),
      isConst,
      isStatic: !isConst,
      line: node.startPosition.row + 1,
    });
  }
}

// ── Type Alias ───────────────────────────────────────────────

function _parseTypeAlias(node, ctx) {
  const nameNode = node.namedChildren.find((c) => c.type === 'type_identifier');
  if (nameNode) {
    ctx.classes.push({
      name: nameNode.text,
      kind: 'type-alias',
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    });
  }
}

// ── Macro Definition ─────────────────────────────────────────

function _parseMacroDef(node, ctx) {
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  if (nameNode) {
    ctx.metadata = ctx.metadata || {};
    ctx.metadata.macros = ctx.metadata.macros || [];
    ctx.metadata.macros.push({
      name: nameNode.text,
      line: node.startPosition.row + 1,
    });
  }
}

// ── Rust Pattern Detection ───────────────────────────────────

function detectRustPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  // 构建 type → methods 索引
  const typeMethodMap = {};
  for (const m of methods) {
    if (m.className) {
      if (!typeMethodMap[m.className]) {
        typeMethodMap[m.className] = [];
      }
      typeMethodMap[m.className].push(m);
    }
  }

  // Builder pattern: struct 有 builder() 或一系列链式 with_*/set_* 方法
  for (const [typeName, methodList] of Object.entries(typeMethodMap)) {
    const hasBuilder = methodList.some((m) => m.name === 'builder' || m.name === 'build');
    const chainMethods = methodList.filter((m) => /^(?:with_|set_|add_)/.test(m.name));
    if (hasBuilder || chainMethods.length >= 3) {
      patterns.push({
        type: 'builder',
        className: typeName,
        confidence: hasBuilder ? 0.9 : 0.7,
      });
    }
  }

  // Factory: new() / from() / create() associated functions
  for (const m of methods) {
    if (
      m.className &&
      m.isClassMethod && // associated function (no self)
      /^(?:new|from|create|open|connect|with_capacity|default)$/.test(m.name)
    ) {
      patterns.push({
        type: 'factory',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.85,
      });
    }
  }

  // Newtype pattern: struct with single field
  for (const cls of classes) {
    if (cls.kind === 'struct' && cls.fieldCount === 1) {
      patterns.push({
        type: 'newtype',
        className: cls.name,
        line: cls.line,
        confidence: 0.75,
      });
    }
  }

  // Error enum pattern: enum with Error/Err suffix or derives thiserror
  for (const cls of classes) {
    if (cls.kind === 'enum' && /(?:Error|Err)$/.test(cls.name)) {
      patterns.push({
        type: 'error-enum',
        className: cls.name,
        variantCount: cls.variantCount || 0,
        line: cls.line,
        confidence: 0.9,
      });
    }
  }

  // Trait impl richness: types with many methods suggest impl-heavy design
  for (const [typeName, methodList] of Object.entries(typeMethodMap)) {
    if (methodList.length >= 3) {
      const traitImpls = new Set(methodList.filter((m) => m.traitImpl).map((m) => m.traitImpl));
      patterns.push({
        type: 'impl-rich',
        className: typeName,
        methodCount: methodList.length,
        traitImplCount: traitImpls.size,
        confidence: 0.7,
      });
    }
  }

  // Unsafe usage
  _detectUnsafe(root, patterns);

  // Async usage
  _detectAsync(root, patterns);

  // Derive macro analysis
  _detectDerives(classes, patterns);

  return patterns;
}

function _detectUnsafe(root, patterns) {
  let count = 0;
  function walk(node) {
    if (node.type === 'unsafe_block') {
      count++;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
  }
  walk(root);
  if (count > 0) {
    patterns.push({
      type: 'unsafe',
      count,
      confidence: 0.95,
    });
  }
}

function _detectAsync(root, patterns) {
  let asyncFnCount = 0;
  let awaitCount = 0;
  function walk(node) {
    if (node.type === 'function_item' || node.type === 'function_signature_item') {
      const isAsync = node.children?.some((c) => c.text === 'async');
      if (isAsync) {
        asyncFnCount++;
      }
    }
    if (node.type === 'await_expression') {
      awaitCount++;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
  }
  walk(root);
  if (asyncFnCount > 0 || awaitCount > 0) {
    patterns.push({
      type: 'async',
      asyncFunctions: asyncFnCount,
      awaitExpressions: awaitCount,
      confidence: 0.9,
    });
  }
}

function _detectDerives(classes, patterns) {
  const deriveCounts = {};
  for (const cls of classes) {
    if (cls.derives) {
      for (const d of cls.derives) {
        deriveCounts[d] = (deriveCounts[d] || 0) + 1;
      }
    }
  }
  const commonDerives = Object.entries(deriveCounts)
    .filter(([, count]) => count >= 2)
    .map(([name, count]) => ({ name, count }));

  if (commonDerives.length > 0) {
    patterns.push({
      type: 'derive-usage',
      derives: commonDerives,
      confidence: 0.8,
    });
  }
}

// ── Helper: Extract #[derive(...)] ──────────────────────────

function _extractDerives(node) {
  const derives = [];
  // Look at preceding siblings (attribute_item nodes)
  if (node.parent) {
    const siblings = [];
    for (let i = 0; i < node.parent.namedChildCount; i++) {
      const sib = node.parent.namedChild(i);
      if (sib === node) {
        break;
      }
      siblings.push(sib);
    }
    // Collect attribute_item nodes immediately before this node
    for (let i = siblings.length - 1; i >= 0; i--) {
      const sib = siblings[i];
      if (sib.type !== 'attribute_item') {
        break;
      }
      const text = sib.text;
      const deriveMatch = text.match(/#\[derive\(([^)]+)\)\]/);
      if (deriveMatch) {
        const items = deriveMatch[1].split(',').map((s) => s.trim());
        derives.push(...items);
      }
    }
  }
  return derives;
}

// ── Helper: Visibility ──────────────────────────────────────

function _hasPubVisibility(node) {
  return node.children?.some((c) => c.type === 'visibility_modifier' || c.text === 'pub') || false;
}

// ── Helper: Count Parameters ────────────────────────────────

function _countRustParams(paramList) {
  let paramCount = 0;
  let hasSelfParam = false;

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const child = paramList.namedChild(i);
    if (child.type === 'self_parameter') {
      hasSelfParam = true;
      // Don't count self in paramCount
    } else if (child.type === 'parameter') {
      paramCount++;
    }
  }
  return { paramCount, hasSelfParam };
}

// ── Utility: Complexity ─────────────────────────────────────

function _estimateComplexity(node) {
  let complexity = 1;
  const BRANCH_TYPES = new Set([
    'if_expression',
    'if_let_expression',
    'for_expression',
    'while_expression',
    'while_let_expression',
    'loop_expression',
    'match_expression',
    'match_arm',
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
    'if_expression',
    'if_let_expression',
    'for_expression',
    'while_expression',
    'while_let_expression',
    'loop_expression',
    'match_expression',
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

// ── Rust Call Site 提取 (Phase 5) ────────────────────────────

/**
 * 从 Rust AST root 提取所有调用点
 * 遍历 function_item / impl method 中的 block → call_expression / method_call_expression
 *
 * @param {TreeSitterNode} root
 * @param {object} ctx
 * @param {string} _lang
 */
function extractCallSitesRust(root, ctx, _lang) {
  const scopes = _collectRustScopes(root);
  for (const scope of scopes) {
    _extractRustCallSitesFromBody(scope.body, scope.className, scope.methodName, ctx);
  }
}

/**
 * 递归收集 Rust 中所有函数/方法体作用域
 */
function _collectRustScopes(root) {
  const scopes = [];

  function visit(node, className) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);

      if (child.type === 'impl_item') {
        // impl Type { ... } or impl Trait for Type { ... }
        const typeIdNodes = child.namedChildren.filter(
          (c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier' || c.type === 'generic_type'
        );
        const hasFor = child.children?.some((c) => c.type === 'for');
        let selfType = null;
        if (hasFor && typeIdNodes.length >= 2) {
          selfType = typeIdNodes[1]?.text;
        } else if (typeIdNodes.length >= 1) {
          selfType = typeIdNodes[0]?.text;
        }
        const body = child.namedChildren.find((c) => c.type === 'declaration_list');
        if (body) {
          visit(body, selfType || className);
        }
      } else if (child.type === 'function_item') {
        const name = child.namedChildren.find((c) => c.type === 'identifier')?.text;
        const body = child.namedChildren.find((c) => c.type === 'block');
        if (name && body) {
          scopes.push({ body, className, methodName: name });
        }
      } else if (child.type === 'mod_item') {
        const body = child.namedChildren.find((c) => c.type === 'declaration_list');
        if (body) {
          visit(body, null);
        }
      }
    }
  }

  visit(root, null);
  return scopes;
}

/**
 * 从 Rust block 中递归提取调用点
 */
function _extractRustCallSitesFromBody(bodyNode, className, methodName, ctx) {
  if (!bodyNode) return;

  const RUST_NOISE = new Set([
    'println', 'eprintln', 'print', 'eprint', 'dbg', 'format',
    'vec', 'panic', 'assert', 'assert_eq', 'assert_ne', 'debug_assert',
    'todo', 'unimplemented', 'unreachable', 'cfg',
    'write', 'writeln', 'log', 'info', 'warn', 'error', 'debug', 'trace',
  ]);

  function walk(node, isAwaited) {
    if (!node || node.type === 'ERROR' || node.isMissing) return;

    // await expression: expr.await
    if (node.type === 'await_expression') {
      for (let i = 0; i < node.namedChildCount; i++) {
        walk(node.namedChild(i), true);
      }
      return;
    }

    // call_expression: func(args) or Struct::method(args)
    if (node.type === 'call_expression') {
      const func = node.namedChildren[0];
      if (!func) { walkChildren(node, false); return; }

      let callee, receiver = null, receiverType = null, callType;

      if (func.type === 'scoped_identifier' || func.type === 'scoped_type_identifier') {
        // Struct::method() or crate::mod::func()
        const parts = func.text.split('::');
        if (parts.length >= 2) {
          callee = parts[parts.length - 1];
          receiver = parts.slice(0, -1).join('::');
          // Check if receiver looks like a type (PascalCase)
          const lastReceiver = parts[parts.length - 2];
          if (/^[A-Z]/.test(lastReceiver)) {
            receiverType = lastReceiver;
            callType = callee === 'new' || callee === 'default' ? 'constructor' : 'static';
          } else {
            callType = 'function'; // module-qualified function
          }
        } else {
          callee = func.text;
          callType = 'function';
        }
      } else if (func.type === 'field_expression') {
        // obj.func() — though Rust usually uses method_call_expression for this
        const parts = func.text.split('.');
        if (parts.length >= 2) {
          receiver = parts.slice(0, -1).join('.');
          callee = parts[parts.length - 1];
          callType = 'method';
          if (receiver === 'self' || receiver === '&self' || receiver === '&mut self') {
            receiverType = className;
          }
        } else {
          callee = func.text;
          callType = 'function';
        }
      } else if (func.type === 'identifier') {
        callee = func.text;
        if (RUST_NOISE.has(callee)) { walkChildren(node, false); return; }
        // PascalCase → constructor pattern (rare in Rust — turbofish/struct literal more common)
        callType = /^[A-Z]/.test(callee) ? 'constructor' : 'function';
        if (callType === 'constructor') receiverType = callee;
      } else {
        callee = func.text?.slice(0, 80) || 'unknown';
        callType = 'function';
      }

      const args = node.namedChildren.find((c) => c.type === 'arguments');
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

      if (args) walkChildren(args, false);
      return;
    }

    // method_call_expression: obj.method(args) — Rust-specific
    if (node.type === 'method_call_expression') {
      const valueNode = node.namedChildren.find(
        (c) => c.type !== 'field_identifier' && c.type !== 'arguments' && c.type !== 'type_arguments'
      );
      const nameNode = node.namedChildren.find((c) => c.type === 'field_identifier');
      const args = node.namedChildren.find((c) => c.type === 'arguments');

      const callee = nameNode?.text || 'unknown';
      const receiver = valueNode?.text?.slice(0, 80) || null;
      let receiverType = null;
      let callType = 'method';

      if (receiver === 'self' || receiver === '&self' || receiver === '&mut self') {
        receiverType = className;
      } else if (receiver && /^[A-Z]/.test(receiver)) {
        receiverType = receiver;
      }

      // Skip noise methods
      if (RUST_NOISE.has(callee)) { walkChildren(node, false); return; }

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

      if (args) walkChildren(args, false);
      return;
    }

    // macro_invocation: some_macro!(args) — skip noise macros
    if (node.type === 'macro_invocation') {
      const macroName = node.namedChildren.find((c) => c.type === 'identifier')?.text;
      if (macroName && !RUST_NOISE.has(macroName) && !RUST_NOISE.has(macroName.replace(/!$/, ''))) {
        // Only record non-noise macros as function calls
        ctx.callSites.push({
          callee: macroName,
          callerMethod: methodName,
          callerClass: className,
          callType: 'function',
          receiver: null,
          receiverType: null,
          argCount: 0,
          line: node.startPosition.row + 1,
          isAwait: false,
        });
      }
      // Don't recurse into macro bodies
      return;
    }

    walkChildren(node, false);
  }

  function walkChildren(node, isAwaited) {
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i), isAwaited);
    }
  }

  walk(bodyNode, false);
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
  walk: walkRust,
  detectPatterns: detectRustPatterns,
  extractCallSites: extractCallSitesRust,
  extensions: ['.rs'],
};
