/**
 * @module lang-javascript
 * @description JavaScript AST Walker 插件
 *
 * 与 TypeScript walker 共享大部分逻辑，grammar 使用 tree-sitter-javascript
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// JavaScript walker 与 TypeScript walker 结构相同
// 复用 lang-typescript 的 walker 逻辑

function walkJavaScript(root, ctx) {
  _walkJSNode(root, ctx, null);
}

function _walkJSNode(node, ctx, parentClassName) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_statement': {
        const source = child.namedChildren.find(
          (c) => c.type === 'string' || c.type === 'string_fragment'
        );
        if (source) {
          ctx.imports.push(source.text.replace(/^['"]|['"]$/g, ''));
        }
        break;
      }

      case 'export_statement': {
        ctx.exports = ctx.exports || [];
        ctx.exports.push({ line: child.startPosition.row + 1, text: child.text.substring(0, 100) });
        _walkJSNode(child, ctx, parentClassName);
        break;
      }

      case 'class_declaration': {
        const classInfo = _parseJSClass(child);
        ctx.classes.push(classInfo);
        const body = child.namedChildren.find((c) => c.type === 'class_body');
        if (body) {
          _walkJSClassBody(body, ctx, classInfo.name);
        }
        break;
      }

      case 'function_declaration': {
        ctx.methods.push(_parseJSFunction(child, parentClassName));
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        _parseJSVariableDecl(child, ctx, parentClassName);
        break;
      }

      default: {
        if (
          child.namedChildCount > 0 &&
          !['function_body', 'statement_block', 'template_string'].includes(child.type)
        ) {
          _walkJSNode(child, ctx, parentClassName);
        }
      }
    }
  }
}

function _walkJSClassBody(body, ctx, className) {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child.type === 'method_definition') {
      const name =
        child.namedChildren.find((c) => c.type === 'property_identifier' || c.type === 'identifier')
          ?.text || 'unknown';

      const isStatic = child.text.trimStart().startsWith('static');
      const bodyNode = child.namedChildren.find((c) => c.type === 'statement_block');
      const bodyLines = bodyNode ? bodyNode.endPosition.row - bodyNode.startPosition.row + 1 : 0;

      ctx.methods.push({
        name,
        className,
        isClassMethod: isStatic,
        bodyLines,
        complexity: bodyNode ? _estimateComplexity(bodyNode) : 1,
        nestingDepth: bodyNode ? _maxNesting(bodyNode, 0) : 0,
        line: child.startPosition.row + 1,
        kind: 'definition',
      });
    } else if (child.type === 'field_definition' || child.type === 'public_field_definition') {
      const name = child.namedChildren.find((c) => c.type === 'property_identifier')?.text;
      if (name) {
        ctx.properties.push({ name, className, line: child.startPosition.row + 1 });
      }
    }
  }
}

function _parseJSClass(node) {
  const name = node.namedChildren.find((c) => c.type === 'identifier')?.text || 'Unknown';
  let superclass = null;

  for (const child of node.namedChildren) {
    if (child.type === 'class_heritage') {
      const ext = child.namedChildren.find((c) => c.type === 'extends_clause');
      if (ext) {
        const typeNode = ext.namedChildren.find(
          (c) => c.type === 'identifier' || c.type === 'member_expression'
        );
        if (typeNode) {
          superclass = typeNode.text;
        }
      }
    }
  }

  return {
    name,
    kind: 'class',
    superclass,
    protocols: [],
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function _parseJSFunction(node, className) {
  const name = node.namedChildren.find((c) => c.type === 'identifier')?.text || 'unknown';
  const body = node.namedChildren.find((c) => c.type === 'statement_block');
  const isAsync = node.text.trimStart().startsWith('async');

  return {
    name,
    className,
    isClassMethod: false,
    isAsync,
    bodyLines: body ? body.endPosition.row - body.startPosition.row + 1 : 0,
    complexity: body ? _estimateComplexity(body) : 1,
    nestingDepth: body ? _maxNesting(body, 0) : 0,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

function _parseJSVariableDecl(node, ctx, parentClassName) {
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
      }
    }
  }
}

function detectJSPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  for (const m of methods) {
    if (/^use[A-Z]/.test(m.name) && !m.className) {
      patterns.push({ type: 'react-hook', methodName: m.name, line: m.line, confidence: 0.9 });
    }
    if (/^create[A-Z]|^make[A-Z]/.test(m.name)) {
      patterns.push({
        type: 'factory',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.8,
      });
    }
    if (/^on[A-Z]|^emit$|^addEventListener$|^subscribe$/.test(m.name)) {
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

let _grammar = null;
function getGrammar() {
  if (!_grammar) {
    _grammar = require('tree-sitter-javascript');
  }
  return _grammar;
}

export const plugin = {
  getGrammar,
  walk: walkJavaScript,
  detectPatterns: detectJSPatterns,
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
};
