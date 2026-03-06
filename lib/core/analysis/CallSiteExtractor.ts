/**
 * @module CallSiteExtractor
 * @description Phase 5: 从 AST 中提取调用点 (Call Sites)
 *
 * 采用 Post-walk extraction（方案 B）：在 walker 的 walk() 完成后，
 * 通过二次遍历提取调用点，零修改现有 walker 逻辑。
 *
 * 职责:
 *   - 从 statement_block/block 中提取 call_expression / new_expression
 *   - 解析 callee、receiver、callType、argCount 等
 *   - 关联到所在的 className + methodName (上下文推断)
 *
 * 支持语言:
 *   - TypeScript / JavaScript / TSX (P0)
 *   - Python (P0)
 *   - Go / Java / Kotlin (P1 — via lang plugin extractCallSites)
 */

/**
 * @typedef {object} CallSite
 * @property {string} callee 被调用者名称 (尽可能 qualified)
 * @property {string} callerMethod 调用者所在函数
 * @property {string|null} callerClass 调用者所在类
 * @property {'function'|'method'|'constructor'|'super'|'static'} callType
 * @property {string|null} receiver 接收者对象
 * @property {string|null} receiverType 接收者推断类型
 * @property {number} argCount 参数数量
 * @property {number} line 行号
 * @property {boolean} isAwait 是否 await
 */

interface WalkerContext {
  callSites: CallSiteInfo[];
  [key: string]: unknown;
}

export interface CallSiteInfo {
  callee: string;
  callerMethod: string;
  callerClass: string | null;
  callType: 'function' | 'method' | 'constructor' | 'super' | 'static';
  receiver: string | null;
  receiverType: string | null;
  argCount: number;
  line: number;
  isAwait: boolean;
}

// ── TypeScript / JavaScript / TSX ──────────────────────────

/**
 * 从 TS/JS AST root 中提取所有调用点
 * 使用 post-walk 策略，遍历已由 walker 收集的 methods/classes 来定位方法体，
 * 然后从方法体中递归提取 call_expression / new_expression。
 *
 * @param {TreeSitterNode} root - AST root 节点
 * @param {object} ctx - walker context (含 classes, methods, callSites, references 等)
 * @param {string} lang 语言标识
 */
export function extractCallSitesTS(root: TreeSitterNode, ctx: WalkerContext, lang: string) {
  // 收集所有 function/method body 节点与其上下文
  const scopes = _collectTSScopes(root);

  for (const scope of scopes) {
    _extractCallSitesFromBody(scope.body, scope.className, scope.methodName, ctx);
  }
}

/**
 * 收集 TS/JS 中所有函数/方法作用域
 * 遍历 AST 找到 function_declaration / method_definition / arrow_function 等，
 * 以及它们对应的 statement_block 和上下文信息。
 *
 * @param {TreeSitterNode} root
 * @returns {Array<{ body: TreeSitterNode, className: string|null, methodName: string }>}
 */
function _collectTSScopes(root: TreeSitterNode) {
  const scopes: { body: TreeSitterNode; className: string | null; methodName: string }[] = [];

  function walk(node: TreeSitterNode, className: string | null) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) {
        continue;
      }

      switch (child.type) {
        case 'class_declaration':
        case 'abstract_class_declaration': {
          const name =
            child.namedChildren.find(
              (c: TreeSitterNode) => c.type === 'type_identifier' || c.type === 'identifier'
            )?.text || null;
          const body = child.namedChildren.find((c: TreeSitterNode) => c.type === 'class_body');
          if (body && name) {
            walk(body, name);
          }
          break;
        }

        case 'method_definition': {
          const name =
            child.namedChildren.find(
              (c: TreeSitterNode) =>
                c.type === 'property_identifier' ||
                c.type === 'identifier' ||
                c.type === 'computed_property_name'
            )?.text || 'unknown';
          const body = child.namedChildren.find(
            (c: TreeSitterNode) => c.type === 'statement_block'
          );
          if (body) {
            scopes.push({ body, className, methodName: name });
          }
          break;
        }

        case 'function_declaration': {
          const name =
            child.namedChildren.find((c: TreeSitterNode) => c.type === 'identifier')?.text ||
            'unknown';
          const body = child.namedChildren.find(
            (c: TreeSitterNode) => c.type === 'statement_block'
          );
          if (body) {
            scopes.push({ body, className, methodName: name });
          }
          break;
        }

        case 'lexical_declaration':
        case 'variable_declaration': {
          // const foo = () => { ... }
          for (const decl of child.namedChildren) {
            if (decl.type === 'variable_declarator') {
              const nameNode = decl.namedChildren.find(
                (c: TreeSitterNode) => c.type === 'identifier'
              );
              const valueNode = decl.namedChildren.find(
                (c: TreeSitterNode) => c.type === 'arrow_function' || c.type === 'function'
              );
              if (nameNode && valueNode) {
                const body = valueNode.namedChildren.find(
                  (c: TreeSitterNode) => c.type === 'statement_block'
                );
                if (body) {
                  scopes.push({ body, className, methodName: nameNode.text });
                }
              }
            }
          }
          break;
        }

        case 'export_statement': {
          // export 下面可能有 function_declaration / class_declaration
          walk(child, className);
          break;
        }

        default: {
          // 递归进入其他有子节点的容器（但避免进入函数体）
          if (
            child.namedChildCount > 0 &&
            !['statement_block', 'function_body', 'template_string'].includes(child.type)
          ) {
            walk(child, className);
          }
        }
      }
    }
  }

  walk(root, null);
  return scopes;
}

type CallType = CallSiteInfo['callType'];

/**
 * 从方法体中递归提取调用点
 *
 * @param {TreeSitterNode} bodyNode - statement_block 节点
 * @param {string|null} className 所在类名
 * @param {string} methodName 所在方法名
 * @param {object} ctx - walker context
 */
function _extractCallSitesFromBody(
  bodyNode: TreeSitterNode | null,
  className: string | null,
  methodName: string,
  ctx: WalkerContext
) {
  if (!bodyNode) {
    return;
  }

  function walk(node: TreeSitterNode, isAwaited: boolean) {
    // 跳过语法错误节点 (Issue #17: 防御性处理)
    if (!node || node.type === 'ERROR' || node.isMissing) {
      return;
    }

    // await expression → 标记下一层的调用为 awaited
    if (node.type === 'await_expression') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c) {
          walk(c, true);
        }
      }
      return;
    }

    if (node.type === 'call_expression') {
      const callSite = _parseTSCallExpression(node, className, methodName, isAwaited);
      if (callSite) {
        ctx.callSites.push(callSite);
      }
      // 继续遍历参数中的嵌套调用
      const args = node.namedChildren.find((c: TreeSitterNode) => c.type === 'arguments');
      if (args) {
        for (let i = 0; i < args.namedChildCount; i++) {
          const c = args.namedChild(i);
          if (c) {
            walk(c, false);
          }
        }
      }
      return;
    }

    if (node.type === 'new_expression') {
      const ctor = node.namedChildren.find(
        (c: TreeSitterNode) => c.type === 'identifier' || c.type === 'member_expression'
      );
      if (ctor) {
        ctx.callSites.push({
          callee: ctor.text,
          callerMethod: methodName,
          callerClass: className,
          callType: 'constructor',
          receiver: null,
          receiverType: ctor.text,
          argCount: _countArgs(node),
          line: node.startPosition.row + 1,
          isAwait: isAwaited,
        });
      }
      // 继续遍历参数中的嵌套调用
      const args = node.namedChildren.find((c: TreeSitterNode) => c.type === 'arguments');
      if (args) {
        for (let i = 0; i < args.namedChildCount; i++) {
          const c = args.namedChild(i);
          if (c) {
            walk(c, false);
          }
        }
      }
      return;
    }

    // JSX/TSX: 组件渲染视为调用点 (Issue #13)
    // <MyComponent /> 或 <MyComponent>...</MyComponent> → 视为 constructor 调用
    if (node.type === 'jsx_self_closing_element' || node.type === 'jsx_opening_element') {
      const tagNode =
        node.namedChildren.find(
          (c: TreeSitterNode) => c.type === 'identifier' || c.type === 'jsx_identifier'
        ) ||
        node.namedChildren.find(
          (c: TreeSitterNode) =>
            c.type === 'member_expression' || c.type === 'jsx_member_expression'
        );
      if (tagNode) {
        const tagName = tagNode.text;
        // 仅大写开头为组件 (小写为 HTML 原生标签如 div, span)
        if (tagName && /^[A-Z]/.test(tagName)) {
          // 计算 JSX 属性数量作为 argCount
          const attrNodes = node.namedChildren.filter(
            (c: TreeSitterNode) => c.type === 'jsx_attribute'
          );
          ctx.callSites.push({
            callee: tagName,
            callerMethod: methodName,
            callerClass: className,
            callType: 'constructor',
            receiver: null,
            receiverType: tagName,
            argCount: attrNodes.length,
            line: node.startPosition.row + 1,
            isAwait: false,
          });
        }
      }
      // 继续遍历 JSX 表达式中的嵌套调用 (如 onClick={handleClick()})
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) {
          continue;
        }
        if (child.type === 'jsx_attribute') {
          // 属性值中可能有嵌套调用: onClick={doSomething()}
          for (let j = 0; j < child.namedChildCount; j++) {
            const c = child.namedChild(j);
            if (c) {
              walk(c, false);
            }
          }
        }
      }
      return;
    }

    // 递归子节点
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) {
        walk(c, false);
      }
    }
  }

  walk(bodyNode, false);
}

/**
 * 解析 TS/JS 的 call_expression 节点
 *
 * @param {TreeSitterNode} node - call_expression 节点
 * @param {string|null} className 所在类名
 * @param {string} methodName 所在方法名
 * @param {boolean} isAwaited 是否被 await
 * @returns {CallSite|null}
 */
function _parseTSCallExpression(
  node: TreeSitterNode,
  className: string | null,
  methodName: string,
  isAwaited: boolean
): CallSiteInfo | null {
  const func = node.namedChildren[0]; // call_expression 的第一个子节点是被调用者
  if (!func) {
    return null;
  }

  let callee: string;
  let receiver: string | null = null;
  let receiverType: string | null = null;
  let callType: CallType;

  if (func.type === 'member_expression') {
    // obj.method() — method call
    const object = func.namedChildren.find((c: TreeSitterNode) => c.type !== 'property_identifier');
    const prop = func.namedChildren.find((c: TreeSitterNode) => c.type === 'property_identifier');
    receiver = object?.text || null;
    callee = prop?.text || func.text;
    callType = 'method';

    // 推断 receiverType
    if (receiver === 'this' || receiver === 'self') {
      receiverType = className;
    } else if (receiver === 'super') {
      callType = 'super';
      receiverType = className; // 需要 CHA 进一步解析到父类
    } else if (receiver && /^[A-Z]/.test(receiver)) {
      // 静态调用推断 e.g. UserService.create()
      receiverType = receiver;
      callType = 'static';
    } else if (receiver?.startsWith('this.')) {
      // this.xxx.method() → xxx 可能是注入的 field
      receiverType = null; // 后续由 CallEdgeResolver 从 properties 解析
    }
  } else if (func.type === 'identifier') {
    // foo() — function call
    callee = func.text;
    callType = 'function';
  } else if (func.type === 'super') {
    // super() — constructor call
    callee = 'super';
    callType = 'super';
    receiverType = className;
  } else {
    // 复杂表达式调用 (e.g. getFactory()(), callback())
    callee = func.text?.slice(0, 80) || 'unknown';
    callType = 'function';
  }

  // 过滤噪声:跳过常见的内置/工具调用
  if (_isNoiseCall(callee, receiver)) {
    return null;
  }

  return {
    callee,
    callerMethod: methodName,
    callerClass: className,
    callType,
    receiver,
    receiverType,
    argCount: _countArgs(node),
    line: node.startPosition.row + 1,
    isAwait: isAwaited,
  };
}

// ── Python ─────────────────────────────────────────────────

/**
 * 从 Python AST root 中提取所有调用点
 *
 * @param {TreeSitterNode} root - AST root 节点
 * @param {object} ctx - walker context
 * @param {string} lang 语言标识
 */
export function extractCallSitesPython(root: TreeSitterNode, ctx: WalkerContext, lang: string) {
  const scopes = _collectPyScopes(root);

  for (const scope of scopes) {
    _extractPyCallSitesFromBody(scope.body, scope.className, scope.methodName, ctx);
  }
}

/**
 * 收集 Python 中所有函数/方法作用域
 *
 * @param {TreeSitterNode} root
 * @returns {Array<{ body: TreeSitterNode, className: string|null, methodName: string }>}
 */
function _collectPyScopes(root: TreeSitterNode) {
  const scopes: { body: TreeSitterNode; className: string | null; methodName: string }[] = [];

  function walk(node: TreeSitterNode, className: string | null) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) {
        continue;
      }

      switch (child.type) {
        case 'class_definition': {
          const name =
            child.namedChildren.find((c: TreeSitterNode) => c.type === 'identifier')?.text || null;
          const body = child.namedChildren.find((c: TreeSitterNode) => c.type === 'block');
          if (body && name) {
            walk(body, name);
          }
          break;
        }

        case 'function_definition': {
          const name =
            child.namedChildren.find((c: TreeSitterNode) => c.type === 'identifier')?.text ||
            'unknown';
          const body = child.namedChildren.find((c: TreeSitterNode) => c.type === 'block');
          if (body) {
            scopes.push({ body, className, methodName: name });
          }
          break;
        }

        case 'decorated_definition': {
          // decorator 后面跟着 function_definition 或 class_definition
          const actualDef = child.namedChildren.find(
            (c: TreeSitterNode) => c.type === 'class_definition' || c.type === 'function_definition'
          );
          if (actualDef?.type === 'class_definition') {
            const name =
              actualDef.namedChildren.find((c: TreeSitterNode) => c.type === 'identifier')?.text ||
              null;
            const body = actualDef.namedChildren.find((c: TreeSitterNode) => c.type === 'block');
            if (body && name) {
              walk(body, name);
            }
          } else if (actualDef?.type === 'function_definition') {
            const name =
              actualDef.namedChildren.find((c: TreeSitterNode) => c.type === 'identifier')?.text ||
              'unknown';
            const body = actualDef.namedChildren.find((c: TreeSitterNode) => c.type === 'block');
            if (body) {
              scopes.push({ body, className, methodName: name });
            }
          }
          break;
        }

        default: {
          if (child.namedChildCount > 0 && child.type !== 'block') {
            walk(child, className);
          }
        }
      }
    }
  }

  walk(root, null);
  return scopes;
}

/**
 * 从 Python 方法体中递归提取调用点
 *
 * @param {TreeSitterNode} bodyNode - block 节点
 * @param {string|null} className
 * @param {string} methodName
 * @param {object} ctx
 */
function _extractPyCallSitesFromBody(
  bodyNode: TreeSitterNode | null,
  className: string | null,
  methodName: string,
  ctx: WalkerContext
) {
  if (!bodyNode) {
    return;
  }

  function walk(node: TreeSitterNode, isAwaited: boolean) {
    // 跳过语法错误节点 (Issue #17: 防御性处理)
    if (!node || node.type === 'ERROR' || node.isMissing) {
      return;
    }

    if (node.type === 'await') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c) {
          walk(c, true);
        }
      }
      return;
    }

    if (node.type === 'call') {
      const callSite = _parsePyCallExpression(node, className, methodName, isAwaited);
      if (callSite) {
        ctx.callSites.push(callSite);
      }
      // 继续遍历参数中的嵌套调用
      const argList = node.namedChildren.find((c: TreeSitterNode) => c.type === 'argument_list');
      if (argList) {
        for (let i = 0; i < argList.namedChildCount; i++) {
          const c = argList.namedChild(i);
          if (c) {
            walk(c, false);
          }
        }
      }
      return;
    }

    // 递归子节点
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) {
        walk(c, false);
      }
    }
  }

  walk(bodyNode, false);
}

/**
 * 解析 Python 的 call 节点
 *
 * @param {TreeSitterNode} node - call 节点
 * @param {string|null} className
 * @param {string} methodName
 * @param {boolean} isAwaited
 * @returns {CallSite|null}
 */
function _parsePyCallExpression(
  node: TreeSitterNode,
  className: string | null,
  methodName: string,
  isAwaited: boolean
): CallSiteInfo | null {
  // Python call 节点: function 是第一个 named child
  const func = node.namedChildren[0];
  if (!func) {
    return null;
  }

  let callee: string;
  let receiver: string | null = null;
  let receiverType: string | null = null;
  let callType: CallType;

  if (func.type === 'attribute') {
    // obj.method() — method call
    const object = func.namedChildren.find(
      (c: TreeSitterNode) => c.type !== 'identifier' || c === func.namedChildren[0]
    );
    const prop = func.namedChildren.find(
      (c: TreeSitterNode) => c.type === 'identifier' && c !== func.namedChildren[0]
    );

    // attribute 节点结构: object.attribute — 第一个子节点是 object, 第二个是 attribute name
    const parts = func.text.split('.');
    if (parts.length >= 2) {
      receiver = parts.slice(0, -1).join('.');
      callee = parts[parts.length - 1];
    } else {
      receiver = object?.text || null;
      callee = prop?.text || func.text;
    }
    callType = 'method';

    // 推断 receiverType
    if (receiver === 'self') {
      receiverType = className;
    } else if (receiver === 'super()') {
      callType = 'super';
      receiverType = className;
    } else if (receiver && /^[A-Z]/.test(receiver)) {
      receiverType = receiver;
      callType = 'static';
    }
  } else if (func.type === 'identifier') {
    callee = func.text;
    // Python: 大写开头通常是类/构造函数
    if (/^[A-Z]/.test(callee)) {
      callType = 'constructor';
      receiverType = callee;
    } else {
      callType = 'function';
    }
  } else {
    callee = func.text?.slice(0, 80) || 'unknown';
    callType = 'function';
  }

  // 过滤噪声
  if (_isNoiseCall(callee, receiver)) {
    return null;
  }

  return {
    callee,
    callerMethod: methodName,
    callerClass: className,
    callType,
    receiver,
    receiverType,
    argCount: _countPyArgs(node),
    line: node.startPosition.row + 1,
    isAwait: isAwaited,
  };
}

// ── 通用提取器注册 ─────────────────────────────────────────

/** @type {Map<string, (root, ctx, lang) => void>} */
const _extractors = new Map([
  ['typescript', extractCallSitesTS],
  ['tsx', extractCallSitesTS],
  ['javascript', extractCallSitesTS],
  ['python', extractCallSitesPython],
]);

/**
 * 获取特定语言的 CallSite 提取器
 * @param {string} lang
 * @returns {((root: TreeSitterNode, ctx: object, lang: string) => void)|null}
 */
export function getCallSiteExtractor(lang: string) {
  return _extractors.get(lang) || null;
}

/**
 * 默认的 CallSite 提取器 — 用于无专门提取器的语言
 * 使用通用的 call_expression 匹配策略
 *
 * @param {TreeSitterNode} root
 * @param {object} ctx
 * @param {string} lang
 */
export function defaultExtractCallSites(root: TreeSitterNode, ctx: WalkerContext, lang: string) {
  // 对于未适配的语言，暂不提取（降级为空）
  // Phase 5.1 将逐步增加 Go / Rust / Java / Kotlin 等
}

// ── 工具函数 ───────────────────────────────────────────────

/**
 * 计算参数数量 (TS/JS)
 */
function _countArgs(node: TreeSitterNode): number {
  const args = node.namedChildren.find((c: TreeSitterNode) => c.type === 'arguments');
  if (!args) {
    return 0;
  }
  return args.namedChildCount;
}

/**
 * 计算参数数量 (Python)
 */
function _countPyArgs(node: TreeSitterNode): number {
  const args = node.namedChildren.find((c: TreeSitterNode) => c.type === 'argument_list');
  if (!args) {
    return 0;
  }
  return args.namedChildCount;
}

/**
 * 判断是否为噪声调用（内置/console/日志等，不产生有意义的调用边）
 *
 * @param {string} callee
 * @param {string|null} receiver
 * @returns {boolean}
 */
function _isNoiseCall(callee: string, receiver: string | null): boolean {
  // 常见内置调用噪声
  const NOISE_RECEIVERS = new Set([
    'console',
    'Math',
    'JSON',
    'Object',
    'Array',
    'String',
    'Number',
    'Boolean',
    'Date',
    'RegExp',
    'Promise',
    'Set',
    'Map',
    'WeakMap',
    'WeakSet',
    'Symbol',
    'Reflect',
    'Proxy',
    'parseInt',
    'parseFloat',
  ]);

  const NOISE_CALLEES = new Set([
    'require',
    'import',
    'console',
    'log',
    'warn',
    'error',
    'info',
    'debug',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'alert',
    'confirm',
    'prompt',
    'print',
    'len',
    'range',
    'enumerate',
    'zip',
    'map',
    'filter',
    'isinstance',
    'issubclass',
    'hasattr',
    'getattr',
    'setattr',
    'str',
    'int',
    'float',
    'bool',
    'list',
    'dict',
    'tuple',
    'set',
    'type',
    'super',
    'property',
    'staticmethod',
    'classmethod',
  ]);

  if (receiver && NOISE_RECEIVERS.has(receiver)) {
    return true;
  }
  if (callee && NOISE_CALLEES.has(callee)) {
    return true;
  }

  return false;
}
