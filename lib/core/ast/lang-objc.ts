/**
 * @module lang-objc
 * @description ObjC AST Walker 插件 - 从 AstAnalyzer.js 迁移
 */

// ── ObjC AST 遍历 ──

function walkObjC(root: any, ctx: any) {
  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);

    switch (node.type) {
      case 'preproc_include': {
        const pathNode = node.namedChildren.find(
          (c: any) => c.type === 'string_literal' || c.type === 'system_lib_string'
        );
        if (pathNode) {
          ctx.imports.push(pathNode.text.replace(/^["<]|[">]$/g, ''));
        }
        break;
      }

      case 'class_interface': {
        const classInfo = _parseObjCInterface(node);
        if (classInfo.isCategory) {
          ctx.categories.push(classInfo);
        } else {
          ctx.classes.push(classInfo);
        }
        for (const child of node.namedChildren) {
          if (child.type === 'method_declaration') {
            ctx.methods.push(_parseObjCMethodDecl(child, classInfo.name));
          } else if (child.type === 'property_declaration') {
            ctx.properties.push(_parseObjCProperty(child, classInfo.name));
          }
        }
        break;
      }

      case 'protocol_declaration': {
        ctx.protocols.push(_parseObjCProtocol(node));
        break;
      }

      case 'class_implementation': {
        const implName = _findIdentifier(node);
        for (const child of node.namedChildren) {
          if (child.type === 'implementation_definition') {
            for (const implChild of child.namedChildren) {
              if (implChild.type === 'method_definition') {
                const m = _parseObjCMethodDef(implChild, implName);
                ctx.methods.push(m);
              }
            }
          }
        }
        break;
      }

      case 'category_implementation': {
        const catImplName = _findIdentifier(node);
        for (const child of node.namedChildren) {
          if (child.type === 'implementation_definition') {
            for (const implChild of child.namedChildren) {
              if (implChild.type === 'method_definition') {
                ctx.methods.push(_parseObjCMethodDef(implChild, catImplName));
              }
            }
          }
        }
        break;
      }
    }
  }
}

function _parseObjCInterface(node: any) {
  const identifiers = node.namedChildren.filter((c: any) => c.type === 'identifier');
  const name = identifiers[0]?.text || 'Unknown';

  const isCategory =
    node.text.includes('(') &&
    identifiers.length >= 2 &&
    node.text.indexOf('(') < node.text.indexOf(identifiers[1].text);

  let superclass: any = null;
  let categoryName: any = null;
  if (isCategory) {
    categoryName = identifiers[1]?.text;
  } else if (identifiers.length >= 2) {
    superclass = identifiers[1]?.text;
  }

  const protocols: any[] = [];
  const protoList = node.namedChildren.find((c: any) => c.type === 'parameterized_arguments');
  if (protoList) {
    for (const child of protoList.namedChildren) {
      if (child.type === 'type_name') {
        const ti = child.namedChildren.find((c: any) => c.type === 'type_identifier');
        if (ti) {
          protocols.push(ti.text);
        }
      }
    }
  }

  const methods: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'method_declaration') {
      methods.push(_parseObjCMethodDecl(child, name));
    }
  }

  const result: any = {
    name,
    superclass,
    protocols,
    isCategory,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
  if (isCategory) {
    result.className = name;
    result.categoryName = categoryName;
    result.methods = methods;
  }
  return result;
}

function _parseObjCProtocol(node: any) {
  const name = _findIdentifier(node) || 'Unknown';
  const inherits: any[] = [];
  const protoRef = node.namedChildren.find((c: any) => c.type === 'protocol_reference_list');
  if (protoRef) {
    for (const child of protoRef.namedChildren) {
      if (child.type === 'identifier') {
        inherits.push(child.text);
      }
    }
  }

  const methods: any[] = [];
  let isOptional = false;
  for (const child of node.namedChildren) {
    if (child.type === 'qualified_protocol_interface_declaration') {
      isOptional = true;
      for (const sub of child.namedChildren) {
        if (sub.type === 'method_declaration') {
          const m: any = _parseObjCMethodDecl(sub, name);
          m.isOptional = true;
          methods.push(m);
        }
      }
    } else if (child.type === 'method_declaration') {
      const m: any = _parseObjCMethodDecl(child, name);
      m.isOptional = isOptional;
      methods.push(m);
    }
  }

  return { name, inherits, methods, line: node.startPosition.row + 1 };
}

function _parseObjCMethodDecl(node: any, className: any) {
  const isClassMethod = node.text.trimStart().startsWith('+');
  const name = _findIdentifier(node) || 'unknown';

  const params: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'method_parameter') {
      const paramName = _findIdentifier(child);
      params.push(paramName || '?');
    }
  }

  let returnType = 'void';
  const methodType = node.namedChildren.find((c: any) => c.type === 'method_type');
  if (methodType) {
    const tn = methodType.namedChildren.find((c: any) => c.type === 'type_name');
    if (tn) {
      const ti = tn.namedChildren.find(
        (c: any) => c.type === 'type_identifier' || c.type === 'primitive_type'
      );
      if (ti) {
        returnType = ti.text;
      }
    }
  }

  const selector =
    params.length > 0
      ? `${name}:${params
          .slice(1)
          .map((p) => `${p}:`)
          .join('')}`
      : name;

  return {
    name,
    selector,
    className,
    isClassMethod,
    returnType,
    paramCount: params.length,
    line: node.startPosition.row + 1,
    kind: 'declaration',
  };
}

function _parseObjCMethodDef(node: any, className: any) {
  const isClassMethod = node.text.trimStart().startsWith('+');
  const name = _findIdentifier(node) || 'unknown';

  const params: any[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'method_parameter') {
      const paramName = _findIdentifier(child);
      params.push(paramName || '?');
    }
  }

  const body = node.namedChildren.find((c: any) => c.type === 'compound_statement');
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  const complexity = body ? _estimateComplexity(body) : 1;
  const nestingDepth = body ? _maxNesting(body, 0) : 0;

  return {
    name,
    className,
    isClassMethod,
    paramCount: params.length,
    bodyLines,
    complexity,
    nestingDepth,
    line: node.startPosition.row + 1,
    kind: 'definition',
  };
}

function _parseObjCProperty(node: any, className: any) {
  const attrs: any[] = [];
  const attrDecl = node.namedChildren.find(
    (c: any) => c.type === 'property_attributes_declaration'
  );
  if (attrDecl) {
    for (const attr of attrDecl.namedChildren) {
      if (attr.type === 'property_attribute') {
        const id = attr.namedChildren.find((c: any) => c.type === 'identifier');
        if (id) {
          attrs.push(id.text);
        }
      }
    }
  }

  let propName = 'unknown';
  let propType = 'id';
  const structDecl = node.namedChildren.find((c: any) => c.type === 'struct_declaration');
  if (structDecl) {
    const ti = structDecl.namedChildren.find((c: any) => c.type === 'type_identifier');
    if (ti) {
      propType = ti.text;
    }

    const sd = structDecl.namedChildren.find((c: any) => c.type === 'struct_declarator');
    if (sd) {
      const findName = (n: any): any => {
        if (n.type === 'identifier') {
          return n.text;
        }
        for (let j = 0; j < n.namedChildCount; j++) {
          const r: any = findName(n.namedChild(j));
          if (r) {
            return r;
          }
        }
        return null;
      };
      propName = findName(sd) || propName;
    }
  }

  return {
    name: propName,
    type: propType,
    attributes: attrs,
    className,
    line: node.startPosition.row + 1,
  };
}

// ── ObjC 模式检测 ──

function detectObjCPatterns(root: any, lang: any, methods: any, properties: any, classes: any) {
  // ObjC 特有的模式检测交由 AstAnalyzer 内的通用 _detectPatterns 处理
  // 此函数可扩展 ObjC 特有模式（如 Category 模式）
  return [];
}

// ── 工具函数 ──

function _findIdentifier(node: any) {
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

function _estimateComplexity(node: any) {
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
    'for_in_expression',
  ]);
  function walk(n: any) {
    if (BRANCH_TYPES.has(n.type)) {
      complexity++;
    }
    if (n.type === 'binary_expression') {
      const op = n.children?.find(
        (c: any) => c.type === '&&' || c.type === '||' || c.text === '&&' || c.text === '||'
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

function _maxNesting(node: any, depth: any) {
  const NESTING_TYPES = new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
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

// ── 插件导出 ──

let _grammar: any = null;
function getGrammar() {
  return _grammar;
}
export function setGrammar(grammar: any) {
  _grammar = grammar;
}

export const plugin = {
  getGrammar,
  walk: walkObjC,
  detectPatterns: detectObjCPatterns,
  extensions: ['.m', '.h', '.mm'],
};
