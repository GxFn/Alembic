/**
 * @module lang-swift
 * @description Swift AST Walker 插件 — 从 AstAnalyzer.js 迁移
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Swift AST 遍历 ──

function walkSwift(root, ctx) {
  _walkSwiftNode(root, ctx, null);
}

function _walkSwiftNode(node, ctx, parentClassName) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_declaration': {
        const mod = child.namedChildren.find(
          (c) => c.type === 'identifier' || c.type === 'simple_identifier'
        );
        if (mod) {
          ctx.imports.push(mod.text);
        }
        break;
      }

      case 'class_declaration':
      case 'struct_declaration':
      case 'enum_declaration': {
        const classInfo = _parseSwiftTypeDecl(child);
        ctx.classes.push(classInfo);
        const body = child.namedChildren.find(
          (c) => c.type === 'class_body' || c.type === 'struct_body' || c.type === 'enum_body'
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
        const body = child.namedChildren.find((c) => c.type === 'extension_body');
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

function _parseSwiftTypeDecl(node) {
  const name =
    node.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'simple_identifier')
      ?.text || 'Unknown';
  const kind = node.type.replace('_declaration', '');

  const _superclass = null;
  const protocols = [];
  for (const child of node.namedChildren) {
    if (child.type === 'inheritance_specifier') {
      const typeNode = child.namedChildren.find((c) => c.type === 'user_type');
      if (typeNode) {
        const typeName = typeNode.namedChildren.find(
          (c) => c.type === 'type_identifier' || c.type === 'simple_identifier'
        )?.text;
        if (typeName) {
          protocols.push(typeName);
        }
      }
    }
  }

  let detectedSuper = null;
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

function _parseSwiftProtocol(node) {
  const name =
    node.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'simple_identifier')
      ?.text || 'Unknown';
  const inherits = [];
  for (const child of node.namedChildren) {
    if (child.type === 'inheritance_specifier') {
      const t = child.namedChildren.find((c) => c.type === 'user_type');
      if (t) {
        const n = t.namedChildren.find(
          (c) => c.type === 'type_identifier' || c.type === 'simple_identifier'
        );
        if (n) {
          inherits.push(n.text);
        }
      }
    }
  }
  return { name, inherits, line: node.startPosition.row + 1 };
}

function _parseSwiftExtension(node) {
  const className =
    node.namedChildren.find((c) => c.type === 'user_type' || c.type === 'type_identifier')?.text ||
    'Unknown';
  const protocols = [];
  for (const child of node.namedChildren) {
    if (child.type === 'inheritance_specifier') {
      const t = child.namedChildren.find((c) => c.type === 'user_type');
      if (t) {
        const n = t.namedChildren.find(
          (c) => c.type === 'type_identifier' || c.type === 'simple_identifier'
        );
        if (n) {
          protocols.push(n.text);
        }
      }
    }
  }

  const methods = [];
  const body = node.namedChildren.find((c) => c.type === 'extension_body');
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

function _parseSwiftFunction(node, className) {
  const name = node.namedChildren.find((c) => c.type === 'simple_identifier')?.text || 'unknown';

  const modifiers = [];
  for (const child of node.namedChildren) {
    if (child.type === 'modifiers' || child.type === 'modifier') {
      modifiers.push(child.text);
    }
  }
  const isClassMethod = modifiers.some((m) => /\b(static|class)\b/.test(m));

  const body = node.namedChildren.find((c) => c.type === 'function_body');
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

function _parseSwiftProperty(node, className) {
  const name =
    node.namedChildren.find((c) => c.type === 'simple_identifier' || c.type === 'pattern')?.text ||
    null;
  if (!name) {
    return null;
  }

  const modifiers = [];
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

function detectSwiftPatterns(root, lang, methods, properties, classes) {
  return [];
}

// ── 工具函数 ──

function _findIdentifier(node) {
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

function _estimateComplexity(node) {
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
  function walk(n) {
    if (BRANCH_TYPES.has(n.type)) {
      complexity++;
    }
    if (n.type === 'binary_expression') {
      const op = n.children?.find(
        (c) => c.type === '&&' || c.type === '||' || c.text === '&&' || c.text === '||'
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

function _maxNesting(node, depth) {
  const NESTING_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'switch_statement',
    'compound_statement',
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
  if (!_grammar) {
    _grammar = require('tree-sitter-swift');
  }
  return _grammar;
}

export const plugin = {
  getGrammar,
  walk: walkSwift,
  detectPatterns: detectSwiftPatterns,
  extensions: ['.swift'],
};
