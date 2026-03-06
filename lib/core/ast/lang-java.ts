/**
 * @module lang-java
 * @description Java AST Walker 插件
 *
 * 提取: class, interface, enum, record, method, field, import, annotation
 * 模式: Singleton, Builder, Factory, DI, Stream Pipeline
 */

import { ImportRecord } from '../analysis/ImportRecord.js';

function walkJava(root, ctx) {
  _walkJavaNode(root, ctx, null);
}

function _walkJavaNode(node, ctx, parentClassName) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);

    switch (child.type) {
      case 'import_declaration': {
        const isStatic = child.namedChildren.some((c) => c.text === 'static');
        const path = child.namedChildren.find((c) => c.type === 'scoped_identifier');
        if (path) {
          const fullPath = path.text; // e.g. com.example.MyClass or com.example.MyClass.myMethod
          const segments = fullPath.split('.');
          const lastName = segments[segments.length - 1];
          // Java wildcard: import com.example.*
          const isWildcard = child.text.includes('.*');
          if (isWildcard) {
            ctx.imports.push(new ImportRecord(fullPath, { symbols: ['*'], kind: 'namespace' }));
          } else if (isStatic) {
            // static import: import static com.example.MyClass.method
            ctx.imports.push(
              new ImportRecord(fullPath, { symbols: [lastName], kind: 'named', isTypeOnly: false })
            );
          } else {
            // regular: import com.example.MyClass
            ctx.imports.push(
              new ImportRecord(fullPath, { symbols: [lastName], alias: lastName, kind: 'named' })
            );
          }
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
        const m: any = _parseJavaMethod(child, className);
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
        (inner as any).outerClass = className;
        ctx.classes.push(inner);
        const innerBody = child.namedChildren.find((c) => c.type === 'class_body');
        if (innerBody) {
          _walkJavaClassBody(innerBody, ctx, inner.name);
        }
        break;
      }
      case 'interface_declaration': {
        const inner: any = _parseJavaInterface(child);
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
  let superclass: any = null;
  const protocols: any[] = [];

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
  const inherits: any[] = [];

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

  // Phase 5.3: Extract field type for DI resolution
  // field_declaration: [modifiers] type_identifier variable_declarator
  let typeAnnotation: any = null;
  const typeNode = node.namedChildren.find(
    (c) =>
      c.type === 'type_identifier' ||
      c.type === 'generic_type' ||
      c.type === 'scoped_type_identifier'
  );
  if (typeNode) {
    // Strip generics: List<User> → List, Repository<User, Long> → Repository
    const text = typeNode.text;
    const bracketIdx = text.indexOf('<');
    typeAnnotation = bracketIdx > 0 ? text.slice(0, bracketIdx) : text;
  }

  return {
    name,
    className,
    isStatic,
    isFinal,
    isPrivate,
    annotations,
    typeAnnotation,
    line: node.startPosition.row + 1,
  };
}

// ── Java 模式检测 ──

function detectJavaPatterns(root, lang, methods, properties, classes) {
  const patterns: any[] = [];

  // Singleton: private constructor + static getInstance
  const classMethodMap: Record<string, any> = {};
  for (const m of methods) {
    if (m.className) {
      if (!classMethodMap[m.className]) {
        classMethodMap[m.className] = [];
      }
      classMethodMap[m.className].push(m);
    }
  }

  for (const [cls, methodList] of Object.entries(classMethodMap) as [string, any[]][]) {
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

// ── Java Call Site 提取 (Phase 5) ─────────────────────────────

/**
 * 从 Java AST root 提取所有调用点
 * 遍历 method_declaration / constructor_declaration 中的 block → method_invocation / object_creation_expression
 */
function extractCallSitesJava(root, ctx, _lang) {
  const scopes = _collectJavaScopes(root);
  for (const scope of scopes) {
    _extractJavaCallSitesFromBody(scope.body, scope.className, scope.methodName, ctx);
  }
}

/**
 * 递归收集 Java 中所有方法体作用域
 */
function _collectJavaScopes(root) {
  const scopes: { body: any; className: any; methodName: any }[] = [];

  function visit(node, className) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);

      if (
        child.type === 'class_declaration' ||
        child.type === 'enum_declaration' ||
        child.type === 'record_declaration'
      ) {
        const name = child.namedChildren.find((c) => c.type === 'identifier')?.text;
        const body = child.namedChildren.find(
          (c) => c.type === 'class_body' || c.type === 'enum_body'
        );
        if (body) {
          visit(body, name || className);
        }
      } else if (child.type === 'interface_declaration') {
        const name = child.namedChildren.find((c) => c.type === 'identifier')?.text;
        const body = child.namedChildren.find((c) => c.type === 'interface_body');
        if (body) {
          visit(body, name || className);
        }
      } else if (child.type === 'method_declaration' || child.type === 'constructor_declaration') {
        const name = child.namedChildren.find((c) => c.type === 'identifier')?.text || '<init>';
        const body = child.namedChildren.find((c) => c.type === 'block');
        if (body) {
          scopes.push({ body, className, methodName: name });
        }
      }
    }
  }

  visit(root, null);
  return scopes;
}

/**
 * 从 Java method body 中递归提取调用点
 */
function _extractJavaCallSitesFromBody(bodyNode, className, methodName, ctx) {
  if (!bodyNode) {
    return;
  }

  const JAVA_NOISE = new Set([
    'System',
    'Math',
    'String',
    'Integer',
    'Long',
    'Double',
    'Float',
    'Boolean',
    'Character',
    'Byte',
    'Short',
    'Arrays',
    'Collections',
    'Objects',
    'Optional',
    'Stream',
    'Collectors',
    'List',
    'Map',
    'Set',
  ]);

  function walk(node) {
    if (!node || node.type === 'ERROR' || node.isMissing) {
      return;
    }

    if (node.type === 'method_invocation') {
      // obj.method(args) or method(args)
      // In Java tree-sitter: namedChildren = [object?, name(identifier), argument_list]
      // The method name is the LAST identifier before argument_list
      const identifiers = node.namedChildren.filter((c) => c.type === 'identifier');
      const args = node.namedChildren.find((c) => c.type === 'argument_list');
      const argCount = args ? args.namedChildCount : 0;

      let callee,
        receiver: string | null = null,
        receiverType: string | null = null,
        callType;

      if (identifiers.length >= 2) {
        // obj.method() — first identifier is receiver, last is method name
        const objectNode = identifiers[0];
        const methodNode = identifiers[identifiers.length - 1];
        receiver = objectNode.text?.slice(0, 80);
        callee = methodNode.text;
        callType = 'method';

        // Check known noise
        if (receiver && JAVA_NOISE.has(receiver.split('.')[0])) {
          receiverType = receiver;
          callType = 'static';
        }
      } else if (identifiers.length === 1) {
        // Could be: unqualified method(args) or receiver is an expression
        const objectNode = node.namedChildren[0];
        if (objectNode && objectNode.type !== 'identifier' && objectNode.type !== 'argument_list') {
          // Expression receiver: e.g. getService().doWork() or super.method()
          receiver = objectNode.text?.slice(0, 80);
          callee = identifiers[0].text;
          callType = 'method';
          // super.xxx() → CHA 解析到父类
          if (receiver === 'super') {
            callType = 'super';
            receiverType = className;
          }
        } else {
          callee = identifiers[0].text;
          callType = 'function'; // unqualified method call within same class
        }
      } else {
        callee = node.text?.split('(')[0]?.slice(0, 80) || 'unknown';
        callType = 'function';
      }

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
      if (args) {
        walkChildren(args);
      }
      return;
    }

    if (node.type === 'object_creation_expression') {
      // new ClassName(args)
      const typeNode = node.namedChildren.find(
        (c) =>
          c.type === 'type_identifier' ||
          c.type === 'generic_type' ||
          c.type === 'scoped_type_identifier'
      );
      const args = node.namedChildren.find((c) => c.type === 'argument_list');
      const argCount = args ? args.namedChildCount : 0;

      const typeName = typeNode?.text || 'Unknown';

      ctx.callSites.push({
        callee: typeName,
        callerMethod: methodName,
        callerClass: className,
        callType: 'constructor',
        receiver: null,
        receiverType: typeName,
        argCount,
        line: node.startPosition.row + 1,
        isAwait: false,
      });

      if (args) {
        walkChildren(args);
      }
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

let _grammar: any = null;
function getGrammar() {
  return _grammar;
}
export function setGrammar(grammar) {
  _grammar = grammar;
}

export const plugin = {
  getGrammar,
  walk: walkJava,
  detectPatterns: detectJavaPatterns,
  extractCallSites: extractCallSitesJava,
  extensions: ['.java'],
};
