import type { EngineeringCodeAstClassFact, EngineeringCodeAstMethodFact } from "../ast/index.js";
import { extractCallSitesPython } from "./call-sites.js";
import { createImportFact } from "./import-facts.js";
import { estimateComplexity, maxNesting } from "./metrics.js";
import type {
  EngineeringTreeSitterContext,
  EngineeringTreeSitterLanguagePlugin,
  TreeSitterNode,
} from "./types.js";

let pythonGrammar: unknown = null;

export function setPythonGrammar(grammar: unknown): void {
  pythonGrammar = grammar;
}

export const pythonPlugin: EngineeringTreeSitterLanguagePlugin = {
  extensions: [".py"],
  getGrammar: () => pythonGrammar,
  walk: walkPython,
  detectPatterns: detectPythonPatterns,
  extractCallSites: extractCallSitesPython,
};

function walkPython(rootNode: TreeSitterNode, context: EngineeringTreeSitterContext): void {
  walkPythonNode(rootNode, context, null);
}

function walkPythonNode(
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
        parseImportStatement(child, context);
        break;
      }
      case "import_from_statement": {
        parseImportFromStatement(child, context);
        break;
      }
      case "class_definition": {
        const classInfo = parsePythonClass(child, []);
        context.classes.push(classInfo);
        const body = child.namedChildren.find((entry) => entry.type === "block");
        if (body) {
          walkPythonClassBody(body, context, classInfo.name);
        }
        break;
      }
      case "function_definition": {
        context.methods.push(parsePythonFunction(child, parentClassName, context.filePath, []));
        break;
      }
      case "decorated_definition": {
        parseDecoratedDefinition(child, context, parentClassName);
        break;
      }
      case "expression_statement": {
        if (!parentClassName) {
          parseModuleLevelAssignment(child, context);
        }
        break;
      }
      default: {
        if (child.namedChildCount > 0 && child.type !== "block") {
          walkPythonNode(child, context, parentClassName);
        }
      }
    }
  }
}

function walkPythonClassBody(
  body: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  className: string,
): void {
  for (let index = 0; index < body.namedChildCount; index++) {
    const child = body.namedChild(index);
    if (!child) {
      continue;
    }
    if (child.type === "function_definition") {
      context.methods.push(parsePythonFunction(child, className, context.filePath, []));
    } else if (child.type === "decorated_definition") {
      parseDecoratedDefinition(child, context, className);
    } else if (child.type === "expression_statement") {
      parseClassLevelAssignment(child, context, className);
    }
  }
}

function parseDecoratedDefinition(
  node: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  parentClassName: string | null,
): void {
  const decorators = node.namedChildren
    .filter((entry) => entry.type === "decorator")
    .map((entry) => entry.text);
  const actualDefinition = node.namedChildren.find(
    (entry) => entry.type === "class_definition" || entry.type === "function_definition",
  );
  if (actualDefinition?.type === "class_definition") {
    const classInfo = parsePythonClass(actualDefinition, decorators);
    context.classes.push(classInfo);
    const body = actualDefinition.namedChildren.find((entry) => entry.type === "block");
    if (body) {
      walkPythonClassBody(body, context, classInfo.name);
    }
    return;
  }
  if (actualDefinition?.type === "function_definition") {
    const method = parsePythonFunction(
      actualDefinition,
      parentClassName,
      context.filePath,
      decorators,
    );
    context.methods.push(method);
    if (parentClassName && decorators.some((decorator) => decorator.includes("property"))) {
      context.properties.push({
        name: method.name,
        className: parentClassName,
        line: method.line ?? null,
        attributes: ["property"],
      });
    }
  }
}

function parseImportStatement(node: TreeSitterNode, context: EngineeringTreeSitterContext): void {
  for (const child of node.namedChildren) {
    if (child.type === "dotted_name") {
      context.imports.push(
        createImportFact(child.text, {
          symbols: ["*"],
          alias: child.text.split(".").at(-1) ?? child.text,
          kind: "namespace",
        }),
      );
    } else if (child.type === "aliased_import") {
      const nameNode = child.namedChildren.find(
        (entry) => entry.type === "dotted_name" || entry.type === "identifier",
      );
      const identifiers = child.namedChildren.filter((entry) => entry.type === "identifier");
      const alias = identifiers.at(-1)?.text ?? nameNode?.text.split(".").at(-1) ?? null;
      if (nameNode) {
        context.imports.push(
          createImportFact(nameNode.text, {
            symbols: ["*"],
            alias,
            kind: "namespace",
          }),
        );
      }
    }
  }
}

function parseImportFromStatement(
  node: TreeSitterNode,
  context: EngineeringTreeSitterContext,
): void {
  const moduleNode = node.namedChildren.find(
    (entry) => entry.type === "dotted_name" || entry.type === "relative_import",
  );
  if (!moduleNode) {
    return;
  }
  const symbols: string[] = [];
  for (const child of node.namedChildren) {
    if (child === moduleNode) {
      continue;
    }
    if (child.type === "dotted_name" || child.type === "identifier") {
      symbols.push(child.text);
    } else if (child.type === "aliased_import") {
      const nameNode = child.namedChildren.find(
        (entry) => entry.type === "dotted_name" || entry.type === "identifier",
      );
      if (nameNode) {
        symbols.push(nameNode.text);
      }
    } else if (child.type === "wildcard_import") {
      symbols.push("*");
    }
  }
  context.imports.push(
    createImportFact(moduleNode.text, {
      symbols,
      kind: symbols.includes("*") ? "namespace" : "named",
    }),
  );
}

function parsePythonClass(
  node: TreeSitterNode,
  decorators: readonly string[],
): EngineeringCodeAstClassFact {
  const name = node.namedChildren.find((entry) => entry.type === "identifier")?.text ?? "Unknown";
  const bases: string[] = [];
  const argumentList = node.namedChildren.find((entry) => entry.type === "argument_list");
  if (argumentList) {
    bases.push(
      ...argumentList.namedChildren
        .filter((entry) => entry.type === "identifier" || entry.type === "attribute")
        .map((entry) => entry.text),
    );
  }
  const superclass =
    bases.length > 0 && !/Protocol$|ABC$|Mixin$|Base$/i.test(bases[0] ?? "")
      ? (bases[0] ?? null)
      : null;
  return {
    name,
    kind: "class",
    superclass,
    superClass: superclass,
    protocols: bases,
    decorators,
    isDataclass: decorators.some((decorator) => decorator.includes("dataclass")),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  } as EngineeringCodeAstClassFact;
}

function parsePythonFunction(
  node: TreeSitterNode,
  className: string | null,
  filePath: string,
  decorators: readonly string[],
): EngineeringCodeAstMethodFact {
  const name = node.namedChildren.find((entry) => entry.type === "identifier")?.text ?? "unknown";
  const body = node.namedChildren.find((entry) => entry.type === "block");
  const params = node.namedChildren.find((entry) => entry.type === "parameters");
  const firstParam = params?.namedChildren.find((entry) => entry.type === "identifier");
  const isClassMethod = decorators.some((decorator) => decorator.includes("classmethod"));
  return {
    name,
    selector: name,
    className,
    filePath,
    line: node.startPosition.row + 1,
    isClassMethod,
    isStaticMethod: decorators.some((decorator) => decorator.includes("staticmethod")),
    isInstanceMethod: firstParam?.text === "self" && Boolean(className),
    isAsync: node.text.trimStart().startsWith("async"),
    decorators,
    bodyLines: body ? body.endPosition.row - body.startPosition.row + 1 : 0,
    complexity: body ? estimateComplexity(body, "python") : 1,
    nestingDepth: body ? maxNesting(body, 0, "python") : 0,
    kind: "definition",
  } as EngineeringCodeAstMethodFact;
}

function parseModuleLevelAssignment(
  node: TreeSitterNode,
  context: EngineeringTreeSitterContext,
): void {
  const assignment = node.namedChildren.find((entry) => entry.type === "assignment");
  const name = assignment?.namedChildren.find((entry) => entry.type === "identifier")?.text;
  if (!name || !/^[A-Z_][A-Z_0-9]*$/.test(name)) {
    return;
  }
  context.properties.push({
    name,
    className: null,
    line: node.startPosition.row + 1,
    attributes: ["module-level"],
  });
}

function parseClassLevelAssignment(
  node: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  className: string,
): void {
  const assignment = node.namedChildren.find((entry) => entry.type === "assignment");
  const name = assignment?.namedChildren.find((entry) => entry.type === "identifier")?.text;
  if (!name) {
    return;
  }
  context.properties.push({
    name,
    className,
    line: node.startPosition.row + 1,
    attributes: [],
  });
}

function detectPythonPatterns(
  _rootNode: TreeSitterNode,
  context: EngineeringTreeSitterContext,
): readonly Record<string, unknown>[] {
  const patterns: Record<string, unknown>[] = [];
  for (const method of context.methods) {
    if (/^create_|^build_|^make_|^get_instance$/.test(method.name)) {
      patterns.push({
        type: "factory",
        className: method.className ?? null,
        methodName: method.name,
        line: method.line ?? null,
        confidence: 0.8,
      });
    }
  }

  const methodsByClass = new Map<string, Set<string>>();
  for (const method of context.methods) {
    if (!method.className) {
      continue;
    }
    const methods = methodsByClass.get(method.className) ?? new Set<string>();
    methods.add(method.name);
    methodsByClass.set(method.className, methods);
  }
  for (const [className, methods] of methodsByClass) {
    if (methods.has("__enter__") && methods.has("__exit__")) {
      patterns.push({ type: "context-manager", className, confidence: 0.95 });
    }
    if (methods.has("__iter__") && methods.has("__next__")) {
      patterns.push({ type: "iterator", className, confidence: 0.9 });
    }
  }
  for (const classInfo of context.classes) {
    if ((classInfo as unknown as Record<string, unknown>).isDataclass) {
      patterns.push({
        type: "dataclass",
        className: classInfo.name,
        line: classInfo.line ?? null,
        confidence: 0.95,
      });
    }
  }
  return patterns;
}
