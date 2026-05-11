import type { EngineeringCodeAstCallSiteFact } from "../ast/index.js";
import type { EngineeringTreeSitterContext, TreeSitterNode } from "./types.js";

const EXTRACTORS = new Map([
  ["typescript", extractCallSitesEcma],
  ["tsx", extractCallSitesEcma],
  ["javascript", extractCallSitesEcma],
  ["python", extractCallSitesPython],
]);

type CallType = EngineeringCodeAstCallSiteFact["callType"];

interface Scope {
  readonly body: TreeSitterNode;
  readonly className: string | null;
  readonly methodName: string;
}

export function getCallSiteExtractor(
  languageId: string,
): ((rootNode: TreeSitterNode, context: EngineeringTreeSitterContext) => void) | null {
  return EXTRACTORS.get(languageId) ?? null;
}

export function extractCallSitesEcma(
  rootNode: TreeSitterNode,
  context: EngineeringTreeSitterContext,
): void {
  for (const scope of collectEcmaScopes(rootNode)) {
    extractEcmaCallSitesFromBody(scope.body, scope.className, scope.methodName, context);
  }
}

export function extractCallSitesPython(
  rootNode: TreeSitterNode,
  context: EngineeringTreeSitterContext,
): void {
  for (const scope of collectPythonScopes(rootNode)) {
    extractPythonCallSitesFromBody(scope.body, scope.className, scope.methodName, context);
  }
}

function collectEcmaScopes(rootNode: TreeSitterNode): Scope[] {
  const scopes: Scope[] = [];

  function walk(node: TreeSitterNode, className: string | null): void {
    for (let index = 0; index < node.namedChildCount; index++) {
      const child = node.namedChild(index);
      if (!child) {
        continue;
      }

      switch (child.type) {
        case "class_declaration":
        case "abstract_class_declaration": {
          const name =
            child.namedChildren.find(
              (entry) => entry.type === "type_identifier" || entry.type === "identifier",
            )?.text ?? null;
          const body = child.namedChildren.find((entry) => entry.type === "class_body");
          if (body && name) {
            walk(body, name);
          }
          break;
        }
        case "method_definition": {
          const name =
            child.namedChildren.find(
              (entry) =>
                entry.type === "property_identifier" ||
                entry.type === "identifier" ||
                entry.type === "computed_property_name",
            )?.text ?? "unknown";
          const body = child.namedChildren.find((entry) => entry.type === "statement_block");
          if (body) {
            scopes.push({ body, className, methodName: name });
          }
          break;
        }
        case "function_declaration": {
          const name =
            child.namedChildren.find((entry) => entry.type === "identifier")?.text ?? "unknown";
          const body = child.namedChildren.find((entry) => entry.type === "statement_block");
          if (body) {
            scopes.push({ body, className, methodName: name });
          }
          break;
        }
        case "lexical_declaration":
        case "variable_declaration": {
          collectVariableFunctionScopes(child, className, scopes);
          break;
        }
        case "export_statement": {
          walk(child, className);
          break;
        }
        default: {
          if (
            child.namedChildCount > 0 &&
            !["statement_block", "function_body", "template_string"].includes(child.type)
          ) {
            walk(child, className);
          }
        }
      }
    }
  }

  walk(rootNode, null);
  return scopes;
}

function collectVariableFunctionScopes(
  declarationNode: TreeSitterNode,
  className: string | null,
  scopes: Scope[],
): void {
  for (const declarator of declarationNode.namedChildren) {
    if (declarator.type !== "variable_declarator") {
      continue;
    }
    const nameNode = declarator.namedChildren.find((entry) => entry.type === "identifier");
    const valueNode = declarator.namedChildren.find(
      (entry) => entry.type === "arrow_function" || entry.type === "function",
    );
    const body = valueNode?.namedChildren.find((entry) => entry.type === "statement_block");
    if (nameNode && body) {
      scopes.push({ body, className, methodName: nameNode.text });
    }
  }
}

function extractEcmaCallSitesFromBody(
  bodyNode: TreeSitterNode,
  className: string | null,
  methodName: string,
  context: EngineeringTreeSitterContext,
): void {
  function walk(node: TreeSitterNode, isAwaited: boolean): void {
    if (node.type === "ERROR" || node.isMissing) {
      return;
    }

    if (node.type === "await_expression") {
      for (let index = 0; index < node.namedChildCount; index++) {
        const child = node.namedChild(index);
        if (child) {
          walk(child, true);
        }
      }
      return;
    }

    if (node.type === "call_expression") {
      const callSite = parseEcmaCallExpression(node, className, methodName, isAwaited, context);
      if (callSite) {
        context.callSites.push(callSite);
      }
      walkArguments(node, "arguments", false, walk);
      return;
    }

    if (node.type === "new_expression") {
      const constructorNode = node.namedChildren.find(
        (entry) => entry.type === "identifier" || entry.type === "member_expression",
      );
      if (constructorNode) {
        context.callSites.push({
          callee: constructorNode.text,
          callerMethod: methodName,
          callerClass: className,
          callType: "constructor",
          receiver: null,
          receiverType: constructorNode.text,
          argCount: countArgs(node, "arguments"),
          line: node.startPosition.row + 1,
          isAwait: isAwaited,
          filePath: context.filePath,
          snippet: node.text,
          languageId: context.languageId,
        });
      }
      walkArguments(node, "arguments", false, walk);
      return;
    }

    if (node.type === "jsx_self_closing_element" || node.type === "jsx_opening_element") {
      recordJsxComponentCall(node, className, methodName, context);
      for (const child of node.namedChildren) {
        if (child.type === "jsx_attribute") {
          for (const attributeChild of child.namedChildren) {
            walk(attributeChild, false);
          }
        }
      }
      return;
    }

    for (let index = 0; index < node.namedChildCount; index++) {
      const child = node.namedChild(index);
      if (child) {
        walk(child, false);
      }
    }
  }

  walk(bodyNode, false);
}

function parseEcmaCallExpression(
  node: TreeSitterNode,
  className: string | null,
  methodName: string,
  isAwaited: boolean,
  context: EngineeringTreeSitterContext,
): EngineeringCodeAstCallSiteFact | null {
  const functionNode = node.namedChildren[0];
  if (!functionNode) {
    return null;
  }

  const parsed = parseEcmaCallee(functionNode, className);
  if (!parsed || isNoiseCall(parsed.callee, parsed.receiver)) {
    return null;
  }

  return {
    callee: parsed.callee,
    callerMethod: methodName,
    callerClass: className,
    callType: parsed.callType,
    receiver: parsed.receiver,
    receiverType: parsed.receiverType,
    argCount: countArgs(node, "arguments"),
    line: node.startPosition.row + 1,
    isAwait: isAwaited,
    filePath: context.filePath,
    snippet: node.text,
    languageId: context.languageId,
  };
}

function parseEcmaCallee(
  functionNode: TreeSitterNode,
  className: string | null,
): {
  readonly callee: string;
  readonly receiver: string | null;
  readonly receiverType: string | null;
  readonly callType: CallType;
} | null {
  if (functionNode.type === "member_expression") {
    const object = functionNode.namedChildren.find((entry) => entry.type !== "property_identifier");
    const property = functionNode.namedChildren.find(
      (entry) => entry.type === "property_identifier",
    );
    const receiver = object?.text ?? null;
    let callType: CallType = "method";
    let receiverType: string | null = null;
    if (receiver === "this" || receiver === "self") {
      receiverType = className;
    } else if (receiver === "super") {
      callType = "super";
      receiverType = className;
    } else if (receiver && /^[A-Z]/.test(receiver)) {
      callType = "static";
      receiverType = receiver;
    }
    return {
      callee: property?.text ?? functionNode.text,
      receiver,
      receiverType,
      callType,
    };
  }

  if (functionNode.type === "identifier") {
    return {
      callee: functionNode.text,
      receiver: null,
      receiverType: null,
      callType: "function",
    };
  }

  if (functionNode.type === "super") {
    return {
      callee: "super",
      receiver: null,
      receiverType: className,
      callType: "super",
    };
  }

  return {
    callee: functionNode.text.slice(0, 80) || "unknown",
    receiver: null,
    receiverType: null,
    callType: "function",
  };
}

function recordJsxComponentCall(
  node: TreeSitterNode,
  className: string | null,
  methodName: string,
  context: EngineeringTreeSitterContext,
): void {
  const tagNode =
    node.namedChildren.find(
      (entry) => entry.type === "identifier" || entry.type === "jsx_identifier",
    ) ??
    node.namedChildren.find(
      (entry) => entry.type === "member_expression" || entry.type === "jsx_member_expression",
    );
  const tagName = tagNode?.text;
  if (!tagName || !/^[A-Z]/.test(tagName)) {
    return;
  }
  context.callSites.push({
    callee: tagName,
    callerMethod: methodName,
    callerClass: className,
    callType: "constructor",
    receiver: null,
    receiverType: tagName,
    argCount: node.namedChildren.filter((entry) => entry.type === "jsx_attribute").length,
    line: node.startPosition.row + 1,
    isAwait: false,
    filePath: context.filePath,
    snippet: node.text,
    languageId: context.languageId,
  });
}

function collectPythonScopes(rootNode: TreeSitterNode): Scope[] {
  const scopes: Scope[] = [];

  function walk(node: TreeSitterNode, className: string | null): void {
    for (let index = 0; index < node.namedChildCount; index++) {
      const child = node.namedChild(index);
      if (!child) {
        continue;
      }
      switch (child.type) {
        case "class_definition": {
          const name =
            child.namedChildren.find((entry) => entry.type === "identifier")?.text ?? null;
          const body = child.namedChildren.find((entry) => entry.type === "block");
          if (body && name) {
            walk(body, name);
          }
          break;
        }
        case "function_definition": {
          const name =
            child.namedChildren.find((entry) => entry.type === "identifier")?.text ?? "unknown";
          const body = child.namedChildren.find((entry) => entry.type === "block");
          if (body) {
            scopes.push({ body, className, methodName: name });
          }
          break;
        }
        case "decorated_definition": {
          collectDecoratedPythonScope(child, className, scopes, walk);
          break;
        }
        default: {
          if (child.namedChildCount > 0 && child.type !== "block") {
            walk(child, className);
          }
        }
      }
    }
  }

  walk(rootNode, null);
  return scopes;
}

function collectDecoratedPythonScope(
  node: TreeSitterNode,
  className: string | null,
  scopes: Scope[],
  walkClassBody: (node: TreeSitterNode, className: string | null) => void,
): void {
  const actualDefinition = node.namedChildren.find(
    (entry) => entry.type === "class_definition" || entry.type === "function_definition",
  );
  if (actualDefinition?.type === "class_definition") {
    const name =
      actualDefinition.namedChildren.find((entry) => entry.type === "identifier")?.text ?? null;
    const body = actualDefinition.namedChildren.find((entry) => entry.type === "block");
    if (body && name) {
      walkClassBody(body, name);
    }
    return;
  }
  if (actualDefinition?.type === "function_definition") {
    const name =
      actualDefinition.namedChildren.find((entry) => entry.type === "identifier")?.text ??
      "unknown";
    const body = actualDefinition.namedChildren.find((entry) => entry.type === "block");
    if (body) {
      scopes.push({ body, className, methodName: name });
    }
  }
}

function extractPythonCallSitesFromBody(
  bodyNode: TreeSitterNode,
  className: string | null,
  methodName: string,
  context: EngineeringTreeSitterContext,
): void {
  function walk(node: TreeSitterNode, isAwaited: boolean): void {
    if (node.type === "ERROR" || node.isMissing) {
      return;
    }
    if (node.type === "await") {
      for (let index = 0; index < node.namedChildCount; index++) {
        const child = node.namedChild(index);
        if (child) {
          walk(child, true);
        }
      }
      return;
    }
    if (node.type === "call") {
      const callSite = parsePythonCallExpression(node, className, methodName, isAwaited, context);
      if (callSite) {
        context.callSites.push(callSite);
      }
      walkArguments(node, "argument_list", false, walk);
      return;
    }
    for (let index = 0; index < node.namedChildCount; index++) {
      const child = node.namedChild(index);
      if (child) {
        walk(child, false);
      }
    }
  }

  walk(bodyNode, false);
}

function parsePythonCallExpression(
  node: TreeSitterNode,
  className: string | null,
  methodName: string,
  isAwaited: boolean,
  context: EngineeringTreeSitterContext,
): EngineeringCodeAstCallSiteFact | null {
  const functionNode = node.namedChildren[0];
  if (!functionNode) {
    return null;
  }

  const parsed = parsePythonCallee(functionNode, className);
  if (!parsed || isNoiseCall(parsed.callee, parsed.receiver)) {
    return null;
  }

  return {
    callee: parsed.callee,
    callerMethod: methodName,
    callerClass: className,
    callType: parsed.callType,
    receiver: parsed.receiver,
    receiverType: parsed.receiverType,
    argCount: countArgs(node, "argument_list"),
    line: node.startPosition.row + 1,
    isAwait: isAwaited,
    filePath: context.filePath,
    snippet: node.text,
    languageId: context.languageId,
  };
}

function parsePythonCallee(
  functionNode: TreeSitterNode,
  className: string | null,
): {
  readonly callee: string;
  readonly receiver: string | null;
  readonly receiverType: string | null;
  readonly callType: CallType;
} | null {
  if (functionNode.type === "attribute") {
    const parts = functionNode.text.split(".");
    const receiver = parts.length >= 2 ? parts.slice(0, -1).join(".") : null;
    const callee = parts.at(-1) ?? functionNode.text;
    let callType: CallType = "method";
    let receiverType: string | null = null;
    if (receiver === "self") {
      receiverType = className;
    } else if (receiver === "super()") {
      callType = "super";
      receiverType = className;
    } else if (receiver && /^[A-Z]/.test(receiver)) {
      callType = "static";
      receiverType = receiver;
    }
    return { callee, receiver, receiverType, callType };
  }

  if (functionNode.type === "identifier") {
    const callee = functionNode.text;
    return /^[A-Z]/.test(callee)
      ? { callee, receiver: null, receiverType: callee, callType: "constructor" }
      : { callee, receiver: null, receiverType: null, callType: "function" };
  }

  return {
    callee: functionNode.text.slice(0, 80) || "unknown",
    receiver: null,
    receiverType: null,
    callType: "function",
  };
}

function walkArguments(
  node: TreeSitterNode,
  argumentNodeType: "arguments" | "argument_list",
  isAwaited: boolean,
  walk: (node: TreeSitterNode, isAwaited: boolean) => void,
): void {
  const args = node.namedChildren.find((entry) => entry.type === argumentNodeType);
  if (!args) {
    return;
  }
  for (let index = 0; index < args.namedChildCount; index++) {
    const child = args.namedChild(index);
    if (child) {
      walk(child, isAwaited);
    }
  }
}

function countArgs(node: TreeSitterNode, argumentNodeType: "arguments" | "argument_list"): number {
  return node.namedChildren.find((entry) => entry.type === argumentNodeType)?.namedChildCount ?? 0;
}

function isNoiseCall(callee: string, receiver: string | null): boolean {
  const noiseReceivers = new Set([
    "console",
    "Math",
    "JSON",
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Date",
    "RegExp",
    "Promise",
    "Set",
    "Map",
  ]);
  const noiseCallees = new Set([
    "require",
    "import",
    "log",
    "warn",
    "error",
    "info",
    "debug",
    "setTimeout",
    "setInterval",
    "print",
    "len",
    "range",
    "enumerate",
    "zip",
    "isinstance",
    "issubclass",
    "super",
    "property",
    "staticmethod",
    "classmethod",
  ]);
  return Boolean((receiver && noiseReceivers.has(receiver)) || noiseCallees.has(callee));
}
