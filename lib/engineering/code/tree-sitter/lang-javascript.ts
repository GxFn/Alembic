import type {
  EngineeringCodeAstClassFact,
  EngineeringCodeAstMethodFact,
  EngineeringCodeAstPropertyFact,
} from "../ast/index.js";
import { extractCallSitesEcma } from "./call-sites.js";
import { createImportFact } from "./import-facts.js";
import { estimateComplexity, maxNesting } from "./metrics.js";
import type {
  EngineeringTreeSitterContext,
  EngineeringTreeSitterLanguagePlugin,
  TreeSitterNode,
} from "./types.js";

let javascriptGrammar: unknown = null;

export function setJavaScriptGrammar(grammar: unknown): void {
  javascriptGrammar = grammar;
}

export const javascriptPlugin: EngineeringTreeSitterLanguagePlugin = {
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  getGrammar: () => javascriptGrammar,
  walk: walkJavaScript,
  detectPatterns: detectJavaScriptPatterns,
  extractCallSites: extractCallSitesEcma,
};

function walkJavaScript(rootNode: TreeSitterNode, context: EngineeringTreeSitterContext): void {
  walkJavaScriptNode(rootNode, context, null);
}

function walkJavaScriptNode(
  node: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  parentClassName: string | null,
): void {
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (!child) {
      continue;
    }

    switch (child.type) {
      case "import_statement": {
        const source = child.namedChildren.find(
          (entry) => entry.type === "string" || entry.type === "string_fragment",
        );
        if (source) {
          context.imports.push(createImportFact(unquote(source.text), parseImportClause(child)));
        }
        break;
      }
      case "export_statement": {
        context.exports.push({ line: child.startPosition.row + 1, text: child.text });
        walkJavaScriptNode(child, context, parentClassName);
        break;
      }
      case "class_declaration": {
        const classInfo = parseJavaScriptClass(child);
        context.classes.push(classInfo);
        const body = child.namedChildren.find((entry) => entry.type === "class_body");
        if (body) {
          walkJavaScriptClassBody(body, context, classInfo.name);
        }
        break;
      }
      case "function_declaration": {
        context.methods.push(parseJavaScriptFunction(child, parentClassName, context.filePath));
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        parseJavaScriptVariableDeclaration(child, context, parentClassName);
        break;
      }
      default: {
        if (
          child.namedChildCount > 0 &&
          !["function_body", "statement_block", "template_string"].includes(child.type)
        ) {
          walkJavaScriptNode(child, context, parentClassName);
        }
      }
    }
  }
}

function walkJavaScriptClassBody(
  body: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  className: string,
): void {
  for (let index = 0; index < body.namedChildCount; index++) {
    const child = body.namedChild(index);
    if (!child) {
      continue;
    }
    if (child.type === "method_definition") {
      context.methods.push(parseJavaScriptMethod(child, className, context.filePath));
    } else if (child.type === "field_definition" || child.type === "public_field_definition") {
      const name = child.namedChildren.find((entry) => entry.type === "property_identifier")?.text;
      if (name) {
        context.properties.push({
          name,
          className,
          line: child.startPosition.row + 1,
          attributes: child.text.trimStart().startsWith("static") ? ["static"] : [],
          isStatic: child.text.trimStart().startsWith("static"),
        } as EngineeringCodeAstPropertyFact);
      }
    }
  }

  extractConstructorAssignments(body, context, className);
}

function parseJavaScriptClass(node: TreeSitterNode): EngineeringCodeAstClassFact {
  const name = node.namedChildren.find((entry) => entry.type === "identifier")?.text ?? "Unknown";
  let superclass: string | null = null;
  const heritage = node.namedChildren.find((entry) => entry.type === "class_heritage");
  if (heritage) {
    superclass =
      heritage.namedChildren.find(
        (entry) => entry.type === "identifier" || entry.type === "member_expression",
      )?.text ?? null;
  }
  return {
    name,
    kind: "class",
    superclass,
    superClass: superclass,
    protocols: [],
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function parseJavaScriptFunction(
  node: TreeSitterNode,
  className: string | null,
  filePath: string,
): EngineeringCodeAstMethodFact {
  const name = node.namedChildren.find((entry) => entry.type === "identifier")?.text ?? "unknown";
  return methodFact(node, name, className, false, filePath);
}

function parseJavaScriptMethod(
  node: TreeSitterNode,
  className: string,
  filePath: string,
): EngineeringCodeAstMethodFact {
  const name =
    node.namedChildren.find(
      (entry) => entry.type === "property_identifier" || entry.type === "identifier",
    )?.text ?? "unknown";
  return methodFact(node, name, className, node.text.trimStart().startsWith("static"), filePath);
}

function methodFact(
  node: TreeSitterNode,
  name: string,
  className: string | null,
  isClassMethod: boolean,
  filePath: string,
): EngineeringCodeAstMethodFact {
  const body = node.namedChildren.find((entry) => entry.type === "statement_block");
  return {
    name,
    selector: name,
    className,
    filePath,
    line: node.startPosition.row + 1,
    isClassMethod,
    bodyLines: body ? body.endPosition.row - body.startPosition.row + 1 : 0,
    complexity: body ? estimateComplexity(body, "ecma") : 1,
    nestingDepth: body ? maxNesting(body, 0, "ecma") : 0,
    isAsync: node.text.trimStart().startsWith("async"),
    kind: "definition",
  } as EngineeringCodeAstMethodFact;
}

function parseJavaScriptVariableDeclaration(
  node: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  parentClassName: string | null,
): void {
  for (const child of node.namedChildren) {
    if (child.type !== "variable_declarator") {
      continue;
    }
    const nameNode = child.namedChildren.find((entry) => entry.type === "identifier");
    const valueNode = child.namedChildren.find(
      (entry) => entry.type === "arrow_function" || entry.type === "function",
    );
    if (nameNode && valueNode) {
      context.methods.push(
        methodFactFromVariable(valueNode, nameNode.text, parentClassName, child, context.filePath),
      );
      continue;
    }

    const callNode = child.namedChildren.find((entry) => entry.type === "call_expression");
    const commonJsImport = callNode ? parseCommonJsRequire(callNode, child) : null;
    if (commonJsImport) {
      context.imports.push(commonJsImport);
    }
  }
}

function methodFactFromVariable(
  valueNode: TreeSitterNode,
  name: string,
  className: string | null,
  declarationNode: TreeSitterNode,
  filePath: string,
): EngineeringCodeAstMethodFact {
  const body = valueNode.namedChildren.find((entry) => entry.type === "statement_block");
  return {
    name,
    selector: name,
    className,
    filePath,
    line: declarationNode.startPosition.row + 1,
    isClassMethod: false,
    bodyLines: body ? body.endPosition.row - body.startPosition.row + 1 : 0,
    complexity: body ? estimateComplexity(body, "ecma") : 1,
    nestingDepth: body ? maxNesting(body, 0, "ecma") : 0,
    kind: "definition",
  } as EngineeringCodeAstMethodFact;
}

function extractConstructorAssignments(
  body: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  className: string,
): void {
  const constructorNode = body.namedChildren.find((child) => {
    if (child.type !== "method_definition") {
      return false;
    }
    return child.namedChildren.some(
      (entry) =>
        (entry.type === "property_identifier" || entry.type === "identifier") &&
        entry.text === "constructor",
    );
  });
  const statementBlock = constructorNode?.namedChildren.find(
    (entry) => entry.type === "statement_block",
  );
  if (!statementBlock) {
    return;
  }
  const seen = new Set(
    context.properties
      .filter((property) => property.className === className)
      .map((property) => property.name),
  );
  walkForThisAssignments(statementBlock, context, className, seen);
}

function walkForThisAssignments(
  node: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  className: string,
  seen: Set<string>,
): void {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child) {
      continue;
    }
    if (child.type === "expression_statement") {
      const expression = child.namedChildren.find(
        (entry) => entry.type === "assignment_expression",
      );
      const left = expression?.namedChildren[0];
      const thisNode = left?.namedChildren.find((entry) => entry.type === "this");
      const property = left?.namedChildren.find((entry) => entry.type === "property_identifier");
      if (left?.type === "member_expression" && thisNode && property && !seen.has(property.text)) {
        seen.add(property.text);
        context.properties.push({
          name: property.text,
          className,
          line: child.startPosition.row + 1,
          attributes: [],
        });
      }
    } else if (
      child.namedChildCount > 0 &&
      child.type !== "function" &&
      child.type !== "arrow_function"
    ) {
      walkForThisAssignments(child, context, className, seen);
    }
  }
}

function parseImportClause(importNode: TreeSitterNode) {
  const symbols: string[] = [];
  let kind: "named" | "default" | "namespace" | "side-effect" = "side-effect";
  let alias: string | null = null;

  for (const child of importNode.namedChildren) {
    if (child.type !== "import_clause") {
      continue;
    }
    for (const clauseChild of child.namedChildren) {
      if (clauseChild.type === "identifier") {
        symbols.push(clauseChild.text);
        kind = "default";
      } else if (clauseChild.type === "named_imports") {
        kind = "named";
        for (const specifier of clauseChild.namedChildren) {
          if (specifier.type !== "import_specifier") {
            continue;
          }
          const localName = specifier.namedChildren
            .filter((entry) => entry.type === "identifier")
            .at(-1)?.text;
          if (localName) {
            symbols.push(localName);
          }
        }
      } else if (clauseChild.type === "namespace_import") {
        kind = "namespace";
        symbols.push("*");
        alias =
          clauseChild.namedChildren.find((entry) => entry.type === "identifier")?.text ?? null;
      }
    }
  }

  return { symbols, kind, alias };
}

function parseCommonJsRequire(callNode: TreeSitterNode, declaratorNode: TreeSitterNode) {
  const callee = callNode.namedChildren[0];
  if (!callee || callee.type !== "identifier" || callee.text !== "require") {
    return null;
  }
  const args = callNode.namedChildren.find((entry) => entry.type === "arguments");
  const firstArg = args?.namedChildren[0];
  if (!firstArg || !["string", "template_string"].includes(firstArg.type)) {
    return null;
  }
  const importPath = unquote(firstArg.text);
  const lhs = declaratorNode.namedChildren[0];
  if (lhs?.type === "identifier") {
    return createImportFact(importPath, { symbols: ["*"], kind: "namespace", alias: lhs.text });
  }
  return createImportFact(importPath);
}

function detectJavaScriptPatterns(
  _rootNode: TreeSitterNode,
  context: EngineeringTreeSitterContext,
): readonly Record<string, unknown>[] {
  const patterns: Record<string, unknown>[] = [];
  for (const classInfo of context.classes) {
    const classMethods = context.methods.filter((method) => method.className === classInfo.name);
    if (
      classMethods.some(
        (method) =>
          (method as unknown as Record<string, unknown>).isClassMethod &&
          /^getInstance$|^shared$/.test(method.name),
      )
    ) {
      patterns.push({ type: "singleton", className: classInfo.name, line: classInfo.line ?? null });
    }
    if (
      classMethods.filter((method) =>
        /^on$|^emit$|^addEventListener$|^subscribe$|^addListener$/.test(method.name),
      ).length >= 2
    ) {
      patterns.push({ type: "observer", className: classInfo.name, line: classInfo.line ?? null });
    }
  }
  for (const method of context.methods) {
    if (/^create[A-Z]|^make[A-Z]/.test(method.name)) {
      patterns.push({
        type: "factory",
        className: method.className ?? null,
        methodName: method.name,
        line: method.line ?? null,
      });
    }
  }
  return patterns;
}

function unquote(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}
