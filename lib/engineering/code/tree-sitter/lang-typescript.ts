import type { EngineeringCodeAstProtocolFact } from "../ast/facts.js";
import type {
  EngineeringCodeAstClassFact,
  EngineeringCodeAstMethodFact,
  EngineeringCodeAstPropertyFact,
} from "../ast/index.js";
import { extractCallSitesEcma } from "./call-sites.js";
import { createImportFact, type EngineeringTreeSitterImportKind } from "./import-facts.js";
import { estimateComplexity, maxNesting } from "./metrics.js";
import type {
  EngineeringTreeSitterContext,
  EngineeringTreeSitterLanguagePlugin,
  TreeSitterNode,
} from "./types.js";

let typeScriptGrammar: unknown = null;
let tsxGrammar: unknown = null;

export function setTypeScriptGrammar(grammar: unknown): void {
  typeScriptGrammar = grammar;
}

export function setTsxGrammar(grammar: unknown): void {
  tsxGrammar = grammar;
}

export const typescriptPlugin: EngineeringTreeSitterLanguagePlugin = {
  extensions: [".ts"],
  getGrammar: () => typeScriptGrammar,
  walk: walkTypeScript,
  detectPatterns: detectTypeScriptPatterns,
  extractCallSites: extractCallSitesEcma,
};

export const tsxPlugin: EngineeringTreeSitterLanguagePlugin = {
  extensions: [".tsx"],
  getGrammar: () => tsxGrammar,
  walk: walkTypeScript,
  detectPatterns: detectTypeScriptPatterns,
  extractCallSites: extractCallSitesEcma,
};

function walkTypeScript(rootNode: TreeSitterNode, context: EngineeringTreeSitterContext): void {
  walkTypeScriptNode(rootNode, context, null);
}

function walkTypeScriptNode(
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
        walkTypeScriptNode(child, context, parentClassName);
        break;
      }
      case "class_declaration": {
        const classInfo = parseTypeScriptClass(child);
        context.classes.push(classInfo);
        const body = child.namedChildren.find((entry) => entry.type === "class_body");
        if (body) {
          walkTypeScriptClassBody(body, context, classInfo.name);
        }
        break;
      }
      case "abstract_class_declaration": {
        const classInfo = { ...parseTypeScriptClass(child), abstract: true };
        context.classes.push(classInfo);
        const body = child.namedChildren.find((entry) => entry.type === "class_body");
        if (body) {
          walkTypeScriptClassBody(body, context, classInfo.name);
        }
        break;
      }
      case "interface_declaration": {
        context.protocols.push(parseTypeScriptInterface(child));
        break;
      }
      case "type_alias_declaration": {
        const name =
          child.namedChildren.find((entry) => entry.type === "type_identifier")?.text ?? "Unknown";
        context.classes.push({
          name,
          kind: "type",
          filePath: context.filePath,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
        break;
      }
      case "enum_declaration": {
        const name =
          child.namedChildren.find((entry) => entry.type === "identifier")?.text ?? "Unknown";
        context.classes.push({
          name,
          kind: "enum",
          filePath: context.filePath,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
        break;
      }
      case "function_declaration": {
        context.methods.push(parseTypeScriptFunction(child, parentClassName, context.filePath));
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        parseTypeScriptVariableDeclaration(child, context, parentClassName);
        break;
      }
      default: {
        if (
          child.namedChildCount > 0 &&
          !["function_body", "statement_block", "template_string"].includes(child.type)
        ) {
          walkTypeScriptNode(child, context, parentClassName);
        }
      }
    }
  }
}

function walkTypeScriptClassBody(
  body: TreeSitterNode,
  context: EngineeringTreeSitterContext,
  className: string,
): void {
  for (let index = 0; index < body.namedChildCount; index++) {
    const child = body.namedChild(index);
    if (!child) {
      continue;
    }

    switch (child.type) {
      case "method_definition": {
        const method = parseTypeScriptMethod(child, className, context.filePath);
        context.methods.push(method);
        if (method.name === "constructor") {
          context.properties.push(...extractConstructorProperties(child, className));
        }
        break;
      }
      case "public_field_definition":
      case "property_definition": {
        const property = parseTypeScriptProperty(child, className);
        if (property) {
          context.properties.push(property);
        }
        break;
      }
      case "method_signature": {
        const name =
          child.namedChildren.find((entry) => entry.type === "property_identifier")?.text ??
          "unknown";
        context.methods.push({
          name,
          selector: name,
          className,
          filePath: context.filePath,
          line: child.startPosition.row + 1,
          kind: "declaration",
        } as EngineeringCodeAstMethodFact);
        break;
      }
      case "property_signature": {
        const name =
          child.namedChildren.find((entry) => entry.type === "property_identifier")?.text ??
          "unknown";
        context.properties.push({
          name,
          className,
          line: child.startPosition.row + 1,
        });
        break;
      }
      default:
        break;
    }
  }
}

function parseTypeScriptClass(node: TreeSitterNode): EngineeringCodeAstClassFact {
  const name =
    node.namedChildren.find(
      (entry) => entry.type === "type_identifier" || entry.type === "identifier",
    )?.text ?? "Unknown";
  const protocols: string[] = [];
  let superclass: string | null = null;

  for (const child of node.namedChildren) {
    if (child.type !== "class_heritage") {
      continue;
    }
    for (const clause of child.namedChildren) {
      if (clause.type === "extends_clause") {
        const typeNode = clause.namedChildren.find(
          (entry) => entry.type === "identifier" || entry.type === "member_expression",
        );
        superclass = typeNode?.text ?? superclass;
      } else if (clause.type === "implements_clause") {
        protocols.push(
          ...clause.namedChildren
            .filter((entry) => entry.type === "type_identifier" || entry.type === "generic_type")
            .map((entry) => entry.text),
        );
      }
    }
  }

  const decorators = node.namedChildren
    .filter((entry) => entry.type === "decorator")
    .map((entry) => entry.text);

  return {
    name,
    kind: "class",
    superclass,
    superClass: superclass,
    protocols,
    decorators,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  } as EngineeringCodeAstClassFact;
}

function parseTypeScriptInterface(node: TreeSitterNode): EngineeringCodeAstProtocolFact {
  const name =
    node.namedChildren.find((entry) => entry.type === "type_identifier")?.text ?? "Unknown";
  const inherits: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "extends_type_clause") {
      inherits.push(
        ...child.namedChildren
          .filter((entry) => entry.type === "type_identifier" || entry.type === "generic_type")
          .map((entry) => entry.text),
      );
    }
  }
  return { name, inherits, line: node.startPosition.row + 1 };
}

function parseTypeScriptFunction(
  node: TreeSitterNode,
  className: string | null,
  filePath: string,
): EngineeringCodeAstMethodFact {
  const name = node.namedChildren.find((entry) => entry.type === "identifier")?.text ?? "unknown";
  return methodFactFromNode(node, name, className, false, filePath);
}

function parseTypeScriptMethod(
  node: TreeSitterNode,
  className: string,
  filePath: string,
): EngineeringCodeAstMethodFact {
  const name =
    node.namedChildren.find(
      (entry) =>
        entry.type === "property_identifier" ||
        entry.type === "identifier" ||
        entry.type === "computed_property_name",
    )?.text ?? "unknown";
  return methodFactFromNode(
    node,
    name,
    className,
    node.text.trimStart().startsWith("static"),
    filePath,
  );
}

function methodFactFromNode(
  node: TreeSitterNode,
  name: string,
  className: string | null,
  isClassMethod: boolean,
  filePath: string,
): EngineeringCodeAstMethodFact {
  const body = node.namedChildren.find((entry) => entry.type === "statement_block");
  const bodyLines = body ? body.endPosition.row - body.startPosition.row + 1 : 0;
  return {
    name,
    selector: name,
    className,
    filePath,
    line: node.startPosition.row + 1,
    isClassMethod,
    bodyLines,
    complexity: body ? estimateComplexity(body, "ecma") : 1,
    nestingDepth: body ? maxNesting(body, 0, "ecma") : 0,
    isAsync: node.text.trimStart().startsWith("async") || node.text.includes(" async "),
    kind: "definition",
  } as EngineeringCodeAstMethodFact;
}

function parseTypeScriptProperty(
  node: TreeSitterNode,
  className: string,
): EngineeringCodeAstPropertyFact | null {
  const name =
    node.namedChildren.find((entry) => entry.type === "property_identifier")?.text ?? null;
  if (!name) {
    return null;
  }
  const typeAnnotation = extractTypeAnnotation(node);
  return {
    name,
    className,
    line: node.startPosition.row + 1,
    type: typeAnnotation,
    typeAnnotation,
    attributes: [
      ...(node.text.trimStart().startsWith("static") ? ["static"] : []),
      ...(node.text.includes("readonly") ? ["readonly"] : []),
    ],
    isStatic: node.text.trimStart().startsWith("static"),
    isReadonly: node.text.includes("readonly"),
  } as EngineeringCodeAstPropertyFact;
}

function extractConstructorProperties(
  constructorNode: TreeSitterNode,
  className: string,
): EngineeringCodeAstPropertyFact[] {
  const params = constructorNode.namedChildren.find((entry) => entry.type === "formal_parameters");
  if (!params) {
    return [];
  }

  const properties: EngineeringCodeAstPropertyFact[] = [];
  for (const param of params.namedChildren) {
    if (!["required_parameter", "optional_parameter"].includes(param.type)) {
      continue;
    }
    const hasAccessibility = param.namedChildren.some(
      (entry) => entry.type === "accessibility_modifier" || entry.type === "override_modifier",
    );
    const hasReadonly = param.text.includes("readonly");
    if (!hasAccessibility && !hasReadonly) {
      continue;
    }
    const name = param.namedChildren.find((entry) => entry.type === "identifier")?.text;
    if (!name) {
      continue;
    }
    const typeAnnotation = extractTypeAnnotation(param);
    properties.push({
      name,
      className,
      line: param.startPosition.row + 1,
      type: typeAnnotation,
      typeAnnotation,
      attributes: [
        ...(hasAccessibility ? ["constructor-param"] : []),
        ...(hasReadonly ? ["readonly"] : []),
      ],
    } as EngineeringCodeAstPropertyFact);
  }
  return properties;
}

function extractTypeAnnotation(parentNode: TreeSitterNode): string | null {
  const typeAnnotation = parentNode.namedChildren.find((entry) => entry.type === "type_annotation");
  if (!typeAnnotation) {
    return null;
  }
  const typeNode = typeAnnotation.namedChildren.find(
    (entry) =>
      entry.type === "type_identifier" ||
      entry.type === "generic_type" ||
      entry.type === "nested_type_identifier" ||
      entry.type === "predefined_type",
  );
  if (!typeNode) {
    return null;
  }
  const genericIndex = typeNode.text.indexOf("<");
  return genericIndex > 0 ? typeNode.text.slice(0, genericIndex) : typeNode.text;
}

function parseTypeScriptVariableDeclaration(
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
    if (callNode) {
      const commonJsImport = parseCommonJsRequire(callNode, child);
      if (commonJsImport) {
        context.imports.push(commonJsImport);
        continue;
      }
      const dynamicImport = parseDynamicImport(callNode, child);
      if (dynamicImport) {
        context.imports.push(dynamicImport);
        continue;
      }
    }
    const awaitNode = child.namedChildren.find((entry) => entry.type === "await_expression");
    const awaitedCall = awaitNode?.namedChildren.find((entry) => entry.type === "call_expression");
    const dynamicImport = awaitedCall ? parseDynamicImport(awaitedCall, child) : null;
    if (dynamicImport) {
      context.imports.push(dynamicImport);
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

function parseImportClause(importNode: TreeSitterNode): {
  readonly symbols: readonly string[];
  readonly alias: string | null;
  readonly kind: EngineeringTreeSitterImportKind;
  readonly isTypeOnly: boolean;
} {
  const symbols: string[] = [];
  let kind: EngineeringTreeSitterImportKind = "side-effect";
  let alias: string | null = null;
  const isTypeOnly = importNode.text.trimStart().startsWith("import type");

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
          const identifiers = specifier.namedChildren.filter(
            (entry) => entry.type === "identifier" || entry.type === "type_identifier",
          );
          const localName = identifiers.at(-1)?.text;
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

  return { symbols, alias, kind, isTypeOnly };
}

function parseCommonJsRequire(callNode: TreeSitterNode, declaratorNode: TreeSitterNode) {
  const callee = callNode.namedChildren[0];
  if (!callee || callee.type !== "identifier" || callee.text !== "require") {
    return null;
  }
  const importPath = firstStringArgument(callNode);
  if (!importPath) {
    return null;
  }
  const lhs = declaratorNode.namedChildren[0];
  if (!lhs) {
    return createImportFact(importPath);
  }
  if (lhs.type === "identifier") {
    return createImportFact(importPath, {
      symbols: ["*"],
      kind: "namespace",
      alias: lhs.text,
    });
  }
  if (lhs.type === "object_pattern") {
    const symbols: string[] = [];
    for (const prop of lhs.namedChildren) {
      if (
        prop.type === "shorthand_property_identifier_pattern" ||
        prop.type === "shorthand_property_identifier"
      ) {
        symbols.push(prop.text);
      } else if (prop.type === "pair_pattern" || prop.type === "pair") {
        const localName = prop.namedChildren
          .filter((entry) => entry.type === "identifier")
          .at(-1)?.text;
        if (localName) {
          symbols.push(localName);
        }
      }
    }
    return createImportFact(importPath, {
      symbols: symbols.length > 0 ? symbols : ["*"],
      kind: symbols.length > 0 ? "named" : "namespace",
    });
  }
  return createImportFact(importPath);
}

function parseDynamicImport(callNode: TreeSitterNode, declaratorNode: TreeSitterNode) {
  const callee = callNode.namedChildren[0];
  if (!callee || callee.text !== "import") {
    return null;
  }
  const importPath = firstStringArgument(callNode);
  if (!importPath) {
    return null;
  }
  const alias =
    declaratorNode.namedChildren[0]?.type === "identifier"
      ? declaratorNode.namedChildren[0]?.text
      : null;
  return createImportFact(importPath, { symbols: ["*"], kind: "dynamic", alias });
}

function firstStringArgument(callNode: TreeSitterNode): string | null {
  const args = callNode.namedChildren.find((entry) => entry.type === "arguments");
  const firstArg = args?.namedChildren[0];
  if (!firstArg || !["string", "template_string"].includes(firstArg.type)) {
    return null;
  }
  return unquote(firstArg.text);
}

function detectTypeScriptPatterns(
  _rootNode: TreeSitterNode,
  context: EngineeringTreeSitterContext,
): readonly Record<string, unknown>[] {
  const patterns: Record<string, unknown>[] = [];

  for (const method of context.methods) {
    if (
      (method as unknown as Record<string, unknown>).isClassMethod &&
      /^getInstance$|^shared$|^instance$/.test(method.name)
    ) {
      patterns.push({
        type: "singleton",
        className: method.className ?? null,
        methodName: method.name,
        line: method.line ?? null,
        confidence: 0.85,
      });
    }
    if (/^create[A-Z]|^make[A-Z]|^build[A-Z]|^from[A-Z]/.test(method.name)) {
      patterns.push({
        type: "factory",
        className: method.className ?? null,
        methodName: method.name,
        line: method.line ?? null,
        confidence: 0.8,
      });
    }
    if (/^use[A-Z]/.test(method.name) && !method.className) {
      patterns.push({
        type: "react-hook",
        methodName: method.name,
        line: method.line ?? null,
        confidence: 0.9,
      });
    }
  }

  for (const classInfo of context.classes) {
    const decorators = ((classInfo as unknown as Record<string, unknown>).decorators ??
      []) as readonly string[];
    for (const decorator of decorators) {
      if (/@(Injectable|Component|Controller|Module|Guard|Pipe)/.test(decorator)) {
        patterns.push({
          type: "decorator",
          className: classInfo.name,
          decorator,
          line: classInfo.line ?? null,
          confidence: 0.9,
        });
      }
    }
  }

  return patterns;
}

function unquote(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}
