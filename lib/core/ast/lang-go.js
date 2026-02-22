/**
 * @module lang-go
 * @description Go AST Walker 插件
 *
 * 提取: struct, interface, method (with receiver), function, field, import
 * 模式: Singleton (sync.Once), Factory (New*), Constructor (New*),
 *        Goroutine, Channel, Middleware (http.Handler chain)
 */

function walkGo(root, ctx) {
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);

    switch (child.type) {
      case 'package_clause': {
        const pkgId = child.namedChildren.find((c) => c.type === 'package_identifier');
        if (pkgId) {
          ctx.metadata = ctx.metadata || {};
          ctx.metadata.packageName = pkgId.text;
        }
        break;
      }

      case 'import_declaration': {
        const specList = child.namedChildren.find((c) => c.type === 'import_spec_list');
        if (specList) {
          for (let j = 0; j < specList.namedChildCount; j++) {
            const spec = specList.namedChild(j);
            if (spec.type === 'import_spec') {
              const strLit = spec.namedChildren.find(
                (c) => c.type === 'interpreted_string_literal'
              );
              if (strLit) {
                ctx.imports.push(strLit.text.replace(/"/g, ''));
              }
            }
          }
        } else {
          // 单行 import
          const spec = child.namedChildren.find((c) => c.type === 'import_spec');
          if (spec) {
            const strLit = spec.namedChildren.find((c) => c.type === 'interpreted_string_literal');
            if (strLit) {
              ctx.imports.push(strLit.text.replace(/"/g, ''));
            }
          }
        }
        break;
      }

      case 'type_declaration': {
        _walkTypeDeclaration(child, ctx);
        break;
      }

      case 'function_declaration': {
        const funcInfo = _parseFunctionDecl(child);
        if (funcInfo) {
          ctx.methods.push(funcInfo);
        }
        break;
      }

      case 'method_declaration': {
        const methodInfo = _parseMethodDecl(child);
        if (methodInfo) {
          ctx.methods.push(methodInfo);
        }
        break;
      }

      case 'const_declaration':
      case 'var_declaration': {
        _walkVarConstDecl(child, ctx);
        break;
      }

      default:
        break;
    }
  }
}

// ── Type Declaration ─────────────────────────────────────────

function _walkTypeDeclaration(node, ctx) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const spec = node.namedChild(i);
    if (spec.type !== 'type_spec') {
      continue;
    }

    const nameNode = spec.namedChildren.find((c) => c.type === 'type_identifier');
    const name = nameNode?.text || 'Unknown';

    // 判断是 struct / interface / type alias
    const structType = spec.namedChildren.find((c) => c.type === 'struct_type');
    const ifaceType = spec.namedChildren.find((c) => c.type === 'interface_type');

    if (structType) {
      _parseStruct(name, structType, spec, ctx);
    } else if (ifaceType) {
      _parseInterface(name, ifaceType, spec, ctx);
    } else {
      // type alias (e.g. type HandlerFunc func(*Context))
      ctx.classes.push({
        name,
        kind: 'type-alias',
        line: spec.startPosition.row + 1,
        endLine: spec.endPosition.row + 1,
      });
    }
  }
}

function _parseStruct(name, structNode, specNode, ctx) {
  const fields = [];
  const embeddedTypes = [];

  const fieldList = structNode.namedChildren.find((c) => c.type === 'field_declaration_list');
  if (fieldList) {
    for (let i = 0; i < fieldList.namedChildCount; i++) {
      const field = fieldList.namedChild(i);
      if (field.type !== 'field_declaration') {
        continue;
      }

      const fieldId = field.namedChildren.find((c) => c.type === 'field_identifier');
      if (fieldId) {
        // Named field
        const fieldName = fieldId.text;
        const isExported = fieldName[0] === fieldName[0].toUpperCase();
        ctx.properties.push({
          name: fieldName,
          className: name,
          isExported,
          line: field.startPosition.row + 1,
        });
        fields.push(fieldName);
      } else {
        // Embedded type (anonymous field)
        const typeId = field.namedChildren.find(
          (c) => c.type === 'type_identifier' || c.type === 'qualified_type'
        );
        if (typeId) {
          embeddedTypes.push(typeId.text);
        }
      }
    }
  }

  ctx.classes.push({
    name,
    kind: 'struct',
    superclass: embeddedTypes[0] || null,
    protocols: embeddedTypes.length > 1 ? embeddedTypes.slice(1) : [],
    embeddedTypes,
    fieldCount: fields.length,
    line: specNode.startPosition.row + 1,
    endLine: specNode.endPosition.row + 1,
  });
}

function _parseInterface(name, ifaceNode, specNode, ctx) {
  const methods = [];
  const embeddedInterfaces = [];

  for (let i = 0; i < ifaceNode.namedChildCount; i++) {
    const child = ifaceNode.namedChild(i);

    if (child.type === 'method_elem') {
      const methodName = child.namedChildren.find((c) => c.type === 'field_identifier');
      if (methodName) {
        methods.push(methodName.text);
      }
    } else if (child.type === 'type_elem') {
      // Embedded interface / type constraint
      const typeId = child.namedChildren.find(
        (c) => c.type === 'type_identifier' || c.type === 'qualified_type'
      );
      if (typeId) {
        embeddedInterfaces.push(typeId.text);
      }
    } else if (child.type === 'constraint_elem') {
      // Go generics type constraint
      const typeId = child.namedChildren.find((c) => c.type === 'type_identifier');
      if (typeId) {
        embeddedInterfaces.push(typeId.text);
      }
    }
  }

  ctx.protocols.push({
    name,
    inherits: embeddedInterfaces,
    methods,
    line: specNode.startPosition.row + 1,
    endLine: specNode.endPosition.row + 1,
  });
}

// ── Function & Method ────────────────────────────────────────

function _parseFunctionDecl(node) {
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  const name = nameNode?.text;
  if (!name) {
    return null;
  }

  const params = node.namedChildren.find((c) => c.type === 'parameter_list');
  const paramCount = params ? _countParams(params) : 0;

  const body = node.namedChildren.find((c) => c.type === 'block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  return {
    name,
    className: null,
    isClassMethod: true, // package-level function == "static"
    isExported: name[0] === name[0].toUpperCase(),
    paramCount,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

function _parseMethodDecl(node) {
  // 第一个 parameter_list 是 receiver
  const paramLists = node.namedChildren.filter((c) => c.type === 'parameter_list');
  const receiverList = paramLists[0];
  const paramList = paramLists[1];

  let receiverType = null;
  let isPointerReceiver = false;
  if (receiverList) {
    const paramDecl = receiverList.namedChildren.find((c) => c.type === 'parameter_declaration');
    if (paramDecl) {
      const pointer = paramDecl.namedChildren.find((c) => c.type === 'pointer_type');
      if (pointer) {
        isPointerReceiver = true;
        const typeId = pointer.namedChildren.find((c) => c.type === 'type_identifier');
        receiverType = typeId?.text || null;
      } else {
        const typeId = paramDecl.namedChildren.find((c) => c.type === 'type_identifier');
        receiverType = typeId?.text || null;
      }
    }
  }

  const nameNode = node.namedChildren.find((c) => c.type === 'field_identifier');
  const name = nameNode?.text;
  if (!name) {
    return null;
  }

  const paramCount = paramList ? _countParams(paramList) : 0;
  const body = node.namedChildren.find((c) => c.type === 'block');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  return {
    name,
    className: receiverType,
    isClassMethod: false,
    isExported: name[0] === name[0].toUpperCase(),
    isPointerReceiver,
    paramCount,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

// ── Var / Const ──────────────────────────────────────────────

function _walkVarConstDecl(node, ctx) {
  const isConst = node.type === 'const_declaration';
  for (let i = 0; i < node.namedChildCount; i++) {
    const spec = node.namedChild(i);
    if (spec.type !== 'const_spec' && spec.type !== 'var_spec') {
      continue;
    }
    const nameNode = spec.namedChildren.find((c) => c.type === 'identifier');
    if (nameNode) {
      ctx.properties.push({
        name: nameNode.text,
        className: null, // package-level
        isExported: nameNode.text[0] === nameNode.text[0].toUpperCase(),
        isConst,
        line: spec.startPosition.row + 1,
      });
    }
  }
}

// ── Go Pattern Detection ─────────────────────────────────────

function detectGoPatterns(root, lang, methods, properties, classes) {
  const patterns = [];

  // 构建 struct → methods 索引
  const structMethodMap = {};
  for (const m of methods) {
    if (m.className) {
      if (!structMethodMap[m.className]) {
        structMethodMap[m.className] = [];
      }
      structMethodMap[m.className].push(m);
    }
  }

  // Singleton (sync.Once pattern): var instance + func GetInstance / sync.Once
  for (const cls of classes) {
    if (cls.kind !== 'struct') {
      continue;
    }
    // 检查是否有 package-level var 指向此 struct
    const hasPackageVar = properties.some((p) => !p.className && !p.isConst && !p.isExported);
    const hasNewFunc = methods.some(
      (m) => !m.className && /^(?:New|Get|Default)/.test(m.name) && m.isExported
    );
    if (hasPackageVar && hasNewFunc) {
      patterns.push({
        type: 'singleton',
        className: cls.name,
        confidence: 0.6,
      });
    }
  }

  // Factory: New* / Create* package-level functions
  for (const m of methods) {
    if (!m.className && m.isExported && /^(?:New|Create|Make|Build|Open|Connect)/.test(m.name)) {
      patterns.push({
        type: 'factory',
        methodName: m.name,
        line: m.line,
        confidence: 0.85,
      });
    }
  }

  // Interface satisfaction: struct 的方法集合覆盖某 interface
  // (简化版: 不做完整检查, 只记录 struct-has-methods 的关系)
  for (const [structName, methodList] of Object.entries(structMethodMap)) {
    if (methodList.length >= 3) {
      patterns.push({
        type: 'struct-methods',
        className: structName,
        methodCount: methodList.length,
        confidence: 0.7,
      });
    }
  }

  // Goroutine launching
  _detectGoroutines(root, patterns);

  // Channel usage
  _detectChannels(root, patterns);

  // HTTP Handler / Middleware pattern
  for (const m of methods) {
    if (m.className && m.isExported && /^(?:ServeHTTP|Handle|Handler)$/.test(m.name)) {
      patterns.push({
        type: 'http-handler',
        className: m.className,
        methodName: m.name,
        line: m.line,
        confidence: 0.9,
      });
    }
  }

  return patterns;
}

function _detectGoroutines(root, patterns) {
  let count = 0;
  function walk(node) {
    if (node.type === 'go_statement') {
      count++;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
  }
  walk(root);
  if (count > 0) {
    patterns.push({
      type: 'goroutine',
      count,
      confidence: 0.95,
    });
  }
}

function _detectChannels(root, patterns) {
  let chanMakeCount = 0;
  let selectCount = 0;
  function walk(node) {
    if (node.type === 'channel_type') {
      chanMakeCount++;
    }
    if (node.type === 'select_statement') {
      selectCount++;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
  }
  walk(root);
  if (chanMakeCount > 0 || selectCount > 0) {
    patterns.push({
      type: 'channel',
      channels: chanMakeCount,
      selects: selectCount,
      confidence: 0.9,
    });
  }
}

// ── Utility ──────────────────────────────────────────────────

function _countParams(paramList) {
  let count = 0;
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const child = paramList.namedChild(i);
    if (child.type === 'parameter_declaration' || child.type === 'variadic_parameter_declaration') {
      // Each identifier in the same declaration is a parameter
      const ids = child.namedChildren.filter((c) => c.type === 'identifier');
      count += Math.max(ids.length, 1);
    }
  }
  return count;
}

function _estimateComplexity(node) {
  let complexity = 1;
  const BRANCH_TYPES = new Set([
    'if_statement',
    'for_statement',
    'expression_switch_statement',
    'type_switch_statement',
    'expression_case',
    'type_case',
    'select_statement',
    'communication_case',
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
    'expression_switch_statement',
    'type_switch_statement',
    'select_statement',
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
  walk: walkGo,
  detectPatterns: detectGoPatterns,
  extensions: ['.go'],
};
