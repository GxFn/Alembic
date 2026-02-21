/**
 * @module lang-java
 * @description Java AST Walker 插件
 *
 * 提取: class, interface, enum, record, method, field, import, annotation
 * 模式: Singleton, Builder, Factory, DI, Stream Pipeline
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function walkJava(root, ctx) {
  _walkJavaNode(root, ctx, null);
}

function _walkJavaNode(node, ctx, parentClassName) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_declaration': {
        const path = child.namedChildren.find((c) => c.type === 'scoped_identifier');
        if (path) {
          ctx.imports.push(path.text);
        }
        break;
      }

      case 'package_declaration': {
        const pkg = child.namedChildren.find((c) => c.type === 'scoped_identifier');
        if (pkg) {
          ctx.metadata = ctx.metadata || {};
          ctx.metadata.packageName = pkg.text;
        }
        break;
      }

      case 'class_declaration': {
        const classInfo = _parseJavaClass(child);
        ctx.classes.push(classInfo);
        const body = child.namedChildren.find((c) => c.type === 'class_body');
        if (body) {
          _walkJavaClassBody(body, ctx, classInfo.name);
        }
        break;
      }

      case 'interface_declaration': {
        const ifaceInfo = _parseJavaInterface(child);
        ctx.protocols.push(ifaceInfo);
        const body = child.namedChildren.find((c) => c.type === 'interface_body');
        if (body) {
          _walkJavaInterfaceBody(body, ctx, ifaceInfo.name);
        }
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

      case 'record_declaration': {
        const name = child.namedChildren.find((c) => c.type === 'identifier')?.text || 'Unknown';
        ctx.classes.push({
          name,
          kind: 'record',
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
        break;
      }

      default: {
        if (child.namedChildCount > 0 && child.type !== 'block') {
          _walkJavaNode(child, ctx, parentClassName);
        }
      }
    }
  }
}

function _walkJavaClassBody(body, ctx, className) {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);

    switch (child.type) {
      case 'method_declaration': {
        ctx.methods.push(_parseJavaMethod(child, className));
        break;
      }
      case 'constructor_declaration': {
        const m = _parseJavaMethod(child, className);
        m.isConstructor = true;
        ctx.methods.push(m);
        break;
      }
      case 'field_declaration': {
        const p = _parseJavaField(child, className);
        if (p) {
          ctx.properties.push(p);
        }
        break;
      }
      case 'class_declaration': {
        // 内部类
        const inner = _parseJavaClass(child);
        inner.outerClass = className;
        ctx.classes.push(inner);
        const innerBody = child.namedChildren.find((c) => c.type === 'class_body');
        if (innerBody) {
          _walkJavaClassBody(innerBody, ctx, inner.name);
        }
        break;
      }
      case 'interface_declaration': {
        const inner = _parseJavaInterface(child);
        inner.outerClass = className;
        ctx.protocols.push(inner);
        break;
      }
      case 'enum_declaration': {
        const name = child.namedChildren.find((c) => c.type === 'identifier')?.text || 'Unknown';
        ctx.classes.push({
          name,
          kind: 'enum',
          outerClass: className,
          line: child.startPosition.row + 1,
        });
        break;
      }
    }
  }
}

function _walkJavaInterfaceBody(body, ctx, ifaceName) {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child.type === 'method_declaration') {
      ctx.methods.push(_parseJavaMethod(child, ifaceName));
    }
  }
}

function _parseJavaClass(node) {
  const name = node.namedChildren.find((c) => c.type === 'identifier')?.text || 'Unknown';
  let superclass = null;
  const protocols = [];

  for (const child of node.namedChildren) {
    if (child.type === 'superclass') {
      const typeId = child.namedChildren.find((c) => c.type === 'type_identifier');
      if (typeId) {
        superclass = typeId.text;
      }
    }
    if (child.type === 'super_interfaces') {
      for (const impl of child.namedChildren) {
        if (impl.type === 'type_list') {
          for (const t of impl.namedChildren) {
            if (t.type === 'type_identifier' || t.type === 'generic_type') {
              protocols.push(t.text);
            }
          }
        }
      }
    }
  }

  // 提取注解
  const annotations = node.namedChildren
    .filter((c) => c.type === 'marker_annotation' || c.type === 'annotation')
    .map((a) => a.text);

  // 修饰符
  const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
  const isAbstract = modifiers?.text?.includes('abstract') || false;

  return {
    name,
    kind: 'class',
    superclass,
    protocols,
    annotations,
    abstract: isAbstract,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function _parseJavaInterface(node) {
  const name = node.namedChildren.find((c) => c.type === 'identifier')?.text || 'Unknown';
  const inherits = [];

  for (const child of node.namedChildren) {
    if (child.type === 'extends_interfaces') {
      for (const ext of child.namedChildren) {
        if (ext.type === 'type_list') {
          for (const t of ext.namedChildren) {
            if (t.type === 'type_identifier' || t.type === 'generic_type') {
              inherits.push(t.text);
            }
          }
        }
      }
    }
  }

  return { name, inherits, line: node.startPosition.row + 1 };
}

function _parseJavaMethod(node, className) {
  const name = node.namedChildren.find((c) => c.type === 'identifier')?.text || 'unknown';
  const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
  const isStatic = modifiers?.text?.includes('static') || false;

  const body = node.namedChildren.find((c) => c.type === 'block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  const annotations = node.namedChildren
    .filter((c) => c.type === 'marker_annotation' || c.type === 'annotation')
    .map((a) => a.text);

  return {
    name,
    className,
    isClassMethod: isStatic,
    annotations,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

function _parseJavaField(node, className) {
  const declNode = node.namedChildren.find((c) => c.type === 'variable_declarator');
  const name = declNode?.namedChildren?.find((c) => c.type === 'identifier')?.text;
  if (!name) {
    return null;
  }

  const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
  const isStatic = modifiers?.text?.includes('static') || false;
  const isFinal = modifiers?.text?.includes('final') || false;
  const isPrivate = modifiers?.text?.includes('private') || false;

  const annotations = node.namedChildren
    .filter((c) => c.type === 'marker_annotation' || c.type === 'annotation')
    .map((a) => a.text);

  return {
    name,
    className,
    isStatic,
    isFinal,
    isPrivate,
    annotations,
    line: node.startPosition.row + 1,
  };
}

// ── Java 模式检测 ──

function detectJavaPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  // Singleton: private constructor + static getInstance
  const classMethodMap = {};
  for (const m of methods) {
    if (m.className) {
      if (!classMethodMap[m.className]) {
        classMethodMap[m.className] = [];
      }
      classMethodMap[m.className].push(m);
    }
  }

  for (const [cls, methodList] of Object.entries(classMethodMap)) {
    const _hasPrivateConstructor = methodList.some((m) => m.isConstructor);
    const hasGetInstance = methodList.some(
      (m) => m.isClassMethod && /^getInstance$|^get$/.test(m.name)
    );
    if (hasGetInstance) {
      patterns.push({ type: 'singleton', className: cls, confidence: 0.85 });
    }

    // Builder pattern: 内部 Builder 类
    const builderClass = classes.find((c) => c.name === 'Builder' && c.outerClass === cls);
    if (builderClass) {
      patterns.push({ type: 'builder', className: cls, confidence: 0.9 });
    }
  }

  // Factory: static create/of/from
  for (const m of methods) {
    if (m.isClassMethod && /^create$|^of$|^from$|^newInstance$|^build$/.test(m.name)) {
      patterns.push({
        type: 'factory',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.8,
      });
    }
  }

  // DI: @Inject/@Autowired
  for (const p of properties) {
    if (p.annotations?.some((a) => /@Inject|@Autowired/.test(a))) {
      patterns.push({
        type: 'dependency-injection',
        className: p.className,
        propertyName: p.name,
        line: p.line,
        confidence: 0.95,
      });
    }
  }
  for (const m of methods) {
    if (m.annotations?.some((a) => /@Inject|@Autowired/.test(a))) {
      patterns.push({
        type: 'dependency-injection',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.95,
      });
    }
  }

  // Spring annotations
  for (const cls of classes) {
    if (cls.annotations?.some((a) => /@RestController|@Controller/.test(a))) {
      patterns.push({
        type: 'rest-controller',
        className: cls.name,
        line: cls.line,
        confidence: 0.95,
      });
    }
    if (cls.annotations?.some((a) => /@Service/.test(a))) {
      patterns.push({ type: 'service', className: cls.name, line: cls.line, confidence: 0.9 });
    }
    if (cls.annotations?.some((a) => /@Repository/.test(a))) {
      patterns.push({ type: 'repository', className: cls.name, line: cls.line, confidence: 0.9 });
    }
    if (cls.annotations?.some((a) => /@Entity/.test(a))) {
      patterns.push({ type: 'entity', className: cls.name, line: cls.line, confidence: 0.95 });
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
    'enhanced_for_statement',
    'while_statement',
    'switch_expression',
    'switch_block_statement_group',
    'catch_clause',
    'ternary_expression',
    'do_statement',
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
    'enhanced_for_statement',
    'while_statement',
    'switch_expression',
    'block',
    'try_statement',
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
    _grammar = require('tree-sitter-java');
  }
  return _grammar;
}

export const plugin = {
  getGrammar,
  walk: walkJava,
  detectPatterns: detectJavaPatterns,
  extensions: ['.java'],
};
