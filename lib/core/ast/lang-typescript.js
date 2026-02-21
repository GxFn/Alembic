/**
 * @module lang-typescript
 * @description TypeScript AST Walker 插件
 *
 * 提取: class, interface, type alias, enum, function, method, property, import, export
 * 模式检测: Singleton, Factory, Observer, React Hook/Component, Middleware, Decorator
 */

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
          ctx.imports.push(source.text.replace(/^['"]|['"]$/g, ''));
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
        const classInfo = _parseTSClass(child);
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

  return {
    name,
    className,
    isStatic,
    isReadonly,
    line: node.startPosition.row + 1,
  };
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
      }
    }
  }
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
  extensions: ['.tsx'],
};
