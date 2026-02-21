/**
 * @module lang-python
 * @description Python AST Walker 插件
 *
 * 提取: class, function, import, decorator, docstring, module-level assignments
 * 模式: Singleton, Factory, Context Manager, Decorator pattern, Data Class
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function walkPython(root, ctx) {
  _walkPyNode(root, ctx, null);
}

function _walkPyNode(node, ctx, parentClassName) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_statement': {
        const modNode = child.namedChildren.find((c) => c.type === 'dotted_name');
        if (modNode) {
          ctx.imports.push(modNode.text);
        }
        break;
      }

      case 'import_from_statement': {
        const modNode = child.namedChildren.find(
          (c) => c.type === 'dotted_name' || c.type === 'relative_import'
        );
        if (modNode) {
          ctx.imports.push(modNode.text);
        }
        break;
      }

      case 'class_definition': {
        const classInfo = _parsePyClass(child);
        ctx.classes.push(classInfo);

        // 递归遍历类体
        const body = child.namedChildren.find((c) => c.type === 'block');
        if (body) {
          _walkPyClassBody(body, ctx, classInfo.name);
        }
        break;
      }

      case 'function_definition': {
        const funcInfo = _parsePyFunction(child, parentClassName);
        ctx.methods.push(funcInfo);
        break;
      }

      case 'decorated_definition': {
        // decorated_definition 包含 decorator + 实际定义
        const actualDef = child.namedChildren.find(
          (c) => c.type === 'class_definition' || c.type === 'function_definition'
        );
        const decorators = child.namedChildren
          .filter((c) => c.type === 'decorator')
          .map((d) => d.text);

        if (actualDef?.type === 'class_definition') {
          const classInfo = _parsePyClass(actualDef);
          classInfo.decorators = decorators;
          if (decorators.some((d) => d.includes('dataclass'))) {
            classInfo.isDataclass = true;
          }
          ctx.classes.push(classInfo);
          const body = actualDef.namedChildren.find((c) => c.type === 'block');
          if (body) {
            _walkPyClassBody(body, ctx, classInfo.name);
          }
        } else if (actualDef?.type === 'function_definition') {
          const funcInfo = _parsePyFunction(actualDef, parentClassName);
          funcInfo.decorators = decorators;
          ctx.methods.push(funcInfo);
        }
        break;
      }

      case 'expression_statement': {
        // 模块级赋值 → properties
        if (!parentClassName) {
          const assignNode = child.namedChildren.find((c) => c.type === 'assignment');
          if (assignNode) {
            const nameNode = assignNode.namedChildren.find((c) => c.type === 'identifier');
            if (nameNode && /^[A-Z_][A-Z_0-9]*$/.test(nameNode.text)) {
              ctx.properties.push({
                name: nameNode.text,
                className: null,
                isModuleLevel: true,
                line: child.startPosition.row + 1,
              });
            }
          }
        }
        break;
      }

      default: {
        if (child.namedChildCount > 0 && child.type !== 'block') {
          _walkPyNode(child, ctx, parentClassName);
        }
      }
    }
  }
}

function _walkPyClassBody(body, ctx, className) {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);

    if (child.type === 'function_definition') {
      const func = _parsePyFunction(child, className);
      ctx.methods.push(func);
    } else if (child.type === 'decorated_definition') {
      const actualDef = child.namedChildren.find((c) => c.type === 'function_definition');
      const decorators = child.namedChildren
        .filter((c) => c.type === 'decorator')
        .map((d) => d.text);

      if (actualDef) {
        const func = _parsePyFunction(actualDef, className);
        func.decorators = decorators;
        if (decorators.some((d) => d.includes('staticmethod'))) {
          func.isStaticMethod = true;
        }
        if (decorators.some((d) => d.includes('classmethod'))) {
          func.isClassMethod = true;
        }
        if (decorators.some((d) => d.includes('property'))) {
          // 作为属性处理
          ctx.properties.push({
            name: func.name,
            className,
            isProperty: true,
            line: func.line,
          });
        }
        ctx.methods.push(func);
      }
    } else if (child.type === 'expression_statement') {
      // 类级别赋值
      const assign = child.namedChildren.find((c) => c.type === 'assignment');
      if (assign) {
        const nameNode = assign.namedChildren.find((c) => c.type === 'identifier');
        if (nameNode) {
          ctx.properties.push({
            name: nameNode.text,
            className,
            line: child.startPosition.row + 1,
          });
        }
      }
    }
  }
}

function _parsePyClass(node) {
  const name = node.namedChildren.find((c) => c.type === 'identifier')?.text || 'Unknown';
  const _superclass = null;
  const protocols = [];

  // bases
  const argList = node.namedChildren.find((c) => c.type === 'argument_list');
  if (argList) {
    const bases = argList.namedChildren.filter(
      (c) => c.type === 'identifier' || c.type === 'attribute'
    );
    for (let i = 0; i < bases.length; i++) {
      const baseName = bases[i].text;
      protocols.push(baseName);
    }
  }

  // 约定: 第一个 base 可能是 superclass（如果不是 Protocol/ABC/Mixin）
  let detectedSuper = null;
  if (protocols.length > 0) {
    const first = protocols[0];
    if (!/Protocol$|ABC$|Mixin$|Base$/i.test(first)) {
      detectedSuper = first;
    }
  }

  return {
    name,
    kind: 'class',
    superclass: detectedSuper,
    protocols,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function _parsePyFunction(node, className) {
  const name = node.namedChildren.find((c) => c.type === 'identifier')?.text || 'unknown';
  const body = node.namedChildren.find((c) => c.type === 'block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  // 检查是否有 self 参数
  const params = node.namedChildren.find((c) => c.type === 'parameters');
  let hasSelf = false;
  const isAsync = node.text.trimStart().startsWith('async');
  if (params) {
    const firstParam = params.namedChildren.find((c) => c.type === 'identifier');
    hasSelf = firstParam?.text === 'self';
  }

  return {
    name,
    className,
    isClassMethod: false,
    isInstanceMethod: hasSelf && !!className,
    isAsync,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

// ── Python 模式检测 ──

function detectPyPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  // Singleton: 模块级实例
  // Factory: create_xxx / build_xxx / make_xxx
  for (const m of methods) {
    if (/^create_|^build_|^make_|^get_instance$/.test(m.name)) {
      patterns.push({
        type: 'factory',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.8,
      });
    }
  }

  // Context Manager: __enter__ + __exit__
  const classMethodMap = {};
  for (const m of methods) {
    if (m.className) {
      if (!classMethodMap[m.className]) {
        classMethodMap[m.className] = [];
      }
      classMethodMap[m.className].push(m.name);
    }
  }
  for (const [cls, methodNames] of Object.entries(classMethodMap)) {
    if (methodNames.includes('__enter__') && methodNames.includes('__exit__')) {
      patterns.push({ type: 'context-manager', className: cls, confidence: 0.95 });
    }
    if (methodNames.includes('__iter__') && methodNames.includes('__next__')) {
      patterns.push({ type: 'iterator', className: cls, confidence: 0.9 });
    }
  }

  // Data Class
  for (const cls of classes) {
    if (cls.isDataclass) {
      patterns.push({ type: 'dataclass', className: cls.name, line: cls.line, confidence: 0.95 });
    }
    if (cls.protocols?.some((p) => p === 'BaseModel' || p.endsWith('.BaseModel'))) {
      patterns.push({
        type: 'pydantic-model',
        className: cls.name,
        line: cls.line,
        confidence: 0.9,
      });
    }
  }

  // Decorator pattern: 函数名以 _ 开头且内部定义了 wrapper
  for (const m of methods) {
    if (
      m.decorators?.some(
        (d) =>
          d.includes('app.route') ||
          d.includes('app.get') ||
          d.includes('app.post') ||
          d.includes('router.')
      )
    ) {
      patterns.push({
        type: 'route-handler',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.9,
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
    'while_statement',
    'elif_clause',
    'except_clause',
    'with_statement',
    'conditional_expression',
    'list_comprehension',
  ]);
  function walk(n) {
    if (BRANCH_TYPES.has(n.type)) {
      complexity++;
    }
    if (n.type === 'boolean_operator') {
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
    'if_statement',
    'for_statement',
    'while_statement',
    'with_statement',
    'try_statement',
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

// ── 插件导出 ──

let _grammar = null;
function getGrammar() {
  if (!_grammar) {
    _grammar = require('tree-sitter-python');
  }
  return _grammar;
}

export const plugin = {
  getGrammar,
  walk: walkPython,
  detectPatterns: detectPyPatterns,
  extensions: ['.py'],
};
