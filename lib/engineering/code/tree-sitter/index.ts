import path from "node:path";
import type {
  EngineeringCodeAstFactsFileSummary,
  EngineeringCodeAstFactsProjectSummary,
  EngineeringCodeAstPropertyTypeFact,
} from "../ast/index.js";
import {
  normalizeEngineeringCodeAstFileSummary,
  normalizeEngineeringCodeAstSummary,
} from "../ast/index.js";
import { asRecord, stringArray, stringValue } from "../ast/normalizer-utils.js";
import { generateContextForAgent } from "./agent-context.js";
import { getCallSiteExtractor } from "./call-sites.js";
import { resolveTreeSitterLanguageId } from "./language-id.js";
import { computeMetrics } from "./metrics.js";
import { getParserClass, isParserReady } from "./parser-init.js";
import {
  aggregateProjectMetrics,
  buildPatternStats,
  dominantLanguage,
  type EngineeringInheritanceEdge,
  withFile,
} from "./project-summary.js";
import {
  getLanguagePlugin,
  hasRegisteredLanguage,
  initializeTreeSitterRuntime,
  knownLanguages,
  onLanguageRegistryChanged,
  registerLanguage,
  supportedLanguages,
} from "./registry.js";
import type {
  EngineeringTreeSitterAnalyzeFileOptions,
  EngineeringTreeSitterAnalyzeFileRequest,
  EngineeringTreeSitterAnalyzeProjectOptions,
  EngineeringTreeSitterContext,
  EngineeringTreeSitterLanguageId,
  EngineeringTreeSitterParseResult,
  EngineeringTreeSitterProjectFile,
  TreeSitterParser,
} from "./types.js";

const parserCache = new Map<EngineeringTreeSitterLanguageId, TreeSitterParser>();
onLanguageRegistryChanged(() => parserCache.clear());

export { generateContextForAgent };
export { initializeTreeSitterRuntime, knownLanguages, registerLanguage, supportedLanguages };
export type {
  EngineeringTreeSitterAnalyzeFileOptions,
  EngineeringTreeSitterAnalyzeFileRequest,
  EngineeringTreeSitterAnalyzeProjectOptions,
  EngineeringTreeSitterFileSummary,
  EngineeringTreeSitterLanguageId,
  EngineeringTreeSitterParseResult,
  EngineeringTreeSitterProjectFile,
  EngineeringTreeSitterProjectSummary,
  TreeSitterNode,
  TreeSitterTree,
} from "./types.js";

export function isAvailable(languageId?: string): boolean {
  const normalized = languageId ? resolveTreeSitterLanguageId(languageId, undefined) : null;
  if (languageId && !normalized) {
    return false;
  }
  return isParserReady() && hasRegisteredLanguage(normalized ?? undefined);
}

export function parseToTree(
  source: string,
  languageId: string,
  options: { readonly filePath?: string } = {},
): EngineeringTreeSitterParseResult | null {
  const normalized = resolveTreeSitterLanguageId(languageId, options.filePath);
  if (!normalized) {
    return null;
  }
  const parser = getParser(normalized);
  if (!parser) {
    return null;
  }
  try {
    const tree = parser.parse(source);
    return tree.rootNode ? { rootNode: tree.rootNode, tree } : null;
  } catch {
    return null;
  }
}

export function analyzeFile(
  requestOrSource: EngineeringTreeSitterAnalyzeFileRequest | string,
  languageId?: string,
  options: EngineeringTreeSitterAnalyzeFileOptions = {},
): EngineeringCodeAstFactsFileSummary | null {
  const request =
    typeof requestOrSource === "string"
      ? ({
          source: requestOrSource,
          ...options,
          ...(languageId ? { languageId } : {}),
        } satisfies EngineeringTreeSitterAnalyzeFileRequest)
      : requestOrSource;
  const filePath = filePathFromRequest(request);
  const source = sourceFromRequest(request);
  const normalizedLanguageId = resolveTreeSitterLanguageId(
    request.languageId ?? languageId,
    filePath,
  );
  if (!source || !normalizedLanguageId) {
    return null;
  }

  const parsed = parseToTree(source, normalizedLanguageId, { filePath });
  if (!parsed) {
    return null;
  }
  const plugin = getLanguagePlugin(normalizedLanguageId);
  if (!plugin) {
    return null;
  }

  const context = createContext(filePath, normalizedLanguageId, source);
  plugin.walk(parsed.rootNode, context);

  if (request.extractCallSites !== false) {
    const extractor =
      plugin.extractCallSites ?? getCallSiteExtractor(normalizedLanguageId) ?? (() => undefined);
    try {
      // 中文说明：legacy walker 的调用点提取器第三参需要语言 ID，新实现会自动忽略。
      (extractor as (rootNode: unknown, context: unknown, languageId: string) => void)(
        parsed.rootNode,
        context,
        normalizedLanguageId,
      );
    } catch {
      // 中文说明：调用点是增强事实，失败不能阻断基础符号/import 输出。
    }
  }

  try {
    context.patterns.push(...(plugin.detectPatterns?.(parsed.rootNode, context) ?? []));
  } catch {
    try {
      // 中文说明：兼容 legacy 插件的 detectPatterns(root, lang, methods, properties, classes)。
      context.patterns.push(
        ...((
          plugin.detectPatterns as unknown as (
            rootNode: unknown,
            languageId: string,
            methods: unknown,
            properties: unknown,
            classes: unknown,
          ) => readonly Record<string, unknown>[] | undefined
        )?.(
          parsed.rootNode,
          normalizedLanguageId,
          context.methods,
          context.properties,
          context.classes,
        ) ?? []),
      );
    } catch {
      // 中文说明：模式识别依赖启发式，迁移期只作为可选补充事实。
    }
  }

  for (const fact of propertyTypeFactsFromProperties(context.properties, filePath)) {
    context.propertyTypes.push(fact);
  }

  const inheritanceGraph = buildInheritanceGraph(
    context.classes,
    context.protocols,
    context.categories,
  );

  return normalizeEngineeringCodeAstFileSummary({
    file: filePath,
    filePath,
    languageId: normalizedLanguageId,
    lang: normalizedLanguageId,
    classes: context.classes,
    protocols: context.protocols,
    categories: context.categories,
    methods: context.methods,
    properties: context.properties,
    imports: context.imports,
    importFacts: context.imports,
    exports: context.exports,
    callSites: context.callSites,
    references: context.references,
    textFacts: context.textFacts,
    propertyTypes: context.propertyTypes,
    receiverTypes: context.receiverTypes,
    inheritanceGraph,
    patterns: context.patterns,
    metrics: computeMetrics(context.methods),
  });
}

export function analyzeProject(
  files: readonly EngineeringTreeSitterProjectFile[],
  languageIdOrOptions?: string | EngineeringTreeSitterAnalyzeProjectOptions,
  maybeOptions: EngineeringTreeSitterAnalyzeProjectOptions = {},
): EngineeringCodeAstFactsProjectSummary {
  const options =
    typeof languageIdOrOptions === "string"
      ? { ...maybeOptions, languageId: languageIdOrOptions }
      : (languageIdOrOptions ?? maybeOptions);
  const fileSummaries: EngineeringCodeAstFactsFileSummary[] = [];

  for (const file of files) {
    const rawPath = file.filePath ?? file.relativePath ?? file.path ?? file.name ?? "(unknown)";
    const source = file.content ?? file.source ?? file.text ?? "";
    let content = source;
    let fileLanguageId = file.languageId ?? file.lang ?? options.languageId;

    const preprocessed = options.preprocessFile?.(source, path.extname(rawPath), file);
    if (preprocessed) {
      content = preprocessed.content;
      fileLanguageId = preprocessed.languageId ?? fileLanguageId;
    }

    const fileRequest: EngineeringTreeSitterAnalyzeFileRequest = {
      filePath: rawPath,
      source: content,
      ...(fileLanguageId ? { languageId: fileLanguageId } : {}),
      ...(options.extractCallSites === undefined
        ? {}
        : { extractCallSites: options.extractCallSites }),
    };
    const summary = analyzeFile(fileRequest);
    if (summary) {
      fileSummaries.push(summary);
    }
  }

  const normalized = normalizeEngineeringCodeAstSummary({ fileSummaries });
  const projectSummary = {
    ...normalized,
    lang: dominantLanguage(normalized.fileSummaries),
    fileCount: normalized.fileSummaries.length,
    classes: normalized.fileSummaries.flatMap((summary) => withFile(summary.classes, summary.file)),
    protocols: normalized.fileSummaries.flatMap((summary) =>
      withFile(summary.protocols, summary.file),
    ),
    categories: normalized.fileSummaries.flatMap((summary) =>
      withFile(summary.categories, summary.file),
    ),
    inheritanceGraph: buildInheritanceGraph(
      normalized.fileSummaries.flatMap((summary) => summary.classes),
      normalized.fileSummaries.flatMap((summary) => summary.protocols),
      normalized.fileSummaries.flatMap((summary) => summary.categories),
    ),
    patternStats: buildPatternStats(normalized.fileSummaries),
    projectMetrics: aggregateProjectMetrics(normalized.fileSummaries),
  };
  return projectSummary as EngineeringCodeAstFactsProjectSummary;
}

export function findCallExpressions(
  source: string,
  languageId: string,
  targetCallee: string,
): Array<{ line: number; snippet: string; enclosingClass: string | null }> {
  const summary = analyzeFile({
    filePath: `(inline).${languageId}`,
    source,
    languageId,
    extractCallSites: true,
  });
  if (!summary) {
    return [];
  }
  const lines = source.split(/\r?\n/);
  return summary.callSites
    .filter((callSite) => callSite.callee.includes(targetCallee))
    .map((callSite) => ({
      line: callSite.line ?? 0,
      snippet: lines[(callSite.line ?? 1) - 1]?.trim().slice(0, 120) ?? "",
      enclosingClass: callSite.callerClass,
    }));
}

export function findPatternInContext(
  source: string,
  languageId: string,
  pattern: string,
  contextFilter: { readonly forbiddenContext?: string; readonly requiredContext?: string } = {},
): Array<{ line: number; snippet: string; context: string | null }> {
  const parsed = parseToTree(source, languageId, { filePath: `(inline).${languageId}` });
  if (!parsed) {
    return [];
  }
  const results: Array<{ line: number; snippet: string; context: string | null }> = [];
  const lines = source.split(/\r?\n/);

  function walk(node: {
    readonly childCount: number;
    readonly text: string;
    readonly startPosition: { readonly row: number };
    readonly parent?: unknown;
    child(index: number): unknown;
  }): void {
    if (node.childCount === 0 && node.text.includes(pattern)) {
      const context = nearestContextName(node);
      const forbiddenMatched =
        contextFilter.forbiddenContext && context === contextFilter.forbiddenContext;
      const requiredMissing =
        contextFilter.requiredContext && context !== contextFilter.requiredContext;
      if (
        (!contextFilter.forbiddenContext && !contextFilter.requiredContext) ||
        forbiddenMatched ||
        requiredMissing
      ) {
        results.push({
          line: node.startPosition.row + 1,
          snippet: lines[node.startPosition.row]?.trim().slice(0, 120) ?? "",
          context,
        });
      }
    }
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (isTreeSitterNodeLike(child)) {
        walk(child);
      }
    }
  }

  walk(parsed.rootNode);
  return results;
}

export function checkProtocolConformance(
  source: string,
  languageId: string,
  className: string,
  protocolName: string,
): {
  readonly conforms: boolean;
  readonly classFound: boolean;
  readonly classDeclLine: number | null;
  readonly direct: boolean;
  readonly viaCategory: boolean;
  readonly viaInheritedProtocol: boolean;
} {
  const summary = analyzeFile({
    filePath: `(inline).${languageId}`,
    source,
    languageId,
    extractCallSites: false,
  });
  if (!summary) {
    return protocolResult(false, false, null, false, false, false);
  }

  const classInfo = summary.classes.find((entry) => entry.name === className);
  if (!classInfo) {
    return protocolResult(false, false, null, false, false, false);
  }
  const direct = classInfo.protocols?.includes(protocolName) ?? false;
  const viaCategory = summary.categories.some(
    (entry) => entry.className === className && (entry.protocols?.includes(protocolName) ?? false),
  );
  const inheritedProtocols = new Set<string>();
  for (const protocol of summary.protocols) {
    if (protocol.name === protocolName) {
      for (const parent of protocol.inherits ?? []) {
        inheritedProtocols.add(parent);
      }
    }
  }
  const viaInheritedProtocol = [...inheritedProtocols].some(
    (parent) =>
      (classInfo.protocols?.includes(parent) ?? false) ||
      summary.categories.some(
        (entry) => entry.className === className && (entry.protocols?.includes(parent) ?? false),
      ),
  );

  return protocolResult(
    direct || viaCategory || viaInheritedProtocol,
    true,
    classInfo.line ?? null,
    direct,
    viaCategory,
    viaInheritedProtocol,
  );
}

function getParser(languageId: EngineeringTreeSitterLanguageId): TreeSitterParser | null {
  const cached = parserCache.get(languageId);
  if (cached) {
    return cached;
  }
  const Parser = getParserClass();
  const plugin = getLanguagePlugin(languageId);
  if (!Parser || !plugin) {
    return null;
  }
  const grammar = plugin.getGrammar();
  if (!grammar) {
    return null;
  }

  try {
    const parser = new Parser();
    parser.setLanguage(grammar);
    parserCache.set(languageId, parser);
    return parser;
  } catch {
    return null;
  }
}

function createContext(
  filePath: string,
  languageId: EngineeringTreeSitterLanguageId,
  source: string,
): EngineeringTreeSitterContext {
  return {
    filePath,
    languageId,
    source,
    classes: [],
    protocols: [],
    categories: [],
    methods: [],
    properties: [],
    patterns: [],
    imports: [],
    exports: [],
    callSites: [],
    references: [],
    textFacts: [],
    propertyTypes: [],
    receiverTypes: [],
  };
}

function propertyTypeFactsFromProperties(
  properties: readonly { readonly className?: string | null; readonly name: string }[],
  filePath: string,
): EngineeringCodeAstPropertyTypeFact[] {
  return properties.flatMap((property) => {
    const rawProperty = property as unknown as Record<string, unknown>;
    const className = stringValue(property.className, "");
    const propertyName = stringValue(property.name, "");
    const type = stringValue(rawProperty.type ?? rawProperty.typeAnnotation, "");
    if (!className || !propertyName || !type) {
      return [];
    }
    return [
      {
        className,
        propertyName,
        type,
        filePath,
        line: typeof rawProperty.line === "number" ? rawProperty.line : null,
        source: "tree-sitter",
      },
    ];
  });
}

function filePathFromRequest(request: EngineeringTreeSitterAnalyzeFileRequest): string {
  return request.filePath ?? request.path ?? request.file ?? "(unknown)";
}

function sourceFromRequest(request: EngineeringTreeSitterAnalyzeFileRequest): string {
  return request.content ?? request.source ?? request.text ?? "";
}

function buildInheritanceGraph(
  classes: readonly unknown[],
  protocols: readonly unknown[],
  categories: readonly unknown[],
): EngineeringInheritanceEdge[] {
  const edges: EngineeringInheritanceEdge[] = [];

  for (const rawClass of classes) {
    const cls = asRecord(rawClass);
    const name = stringValue(cls.name, "");
    if (!name) {
      continue;
    }
    const superclass = stringValue(cls.superClass ?? cls.superclass ?? cls.extends, "");
    if (superclass) {
      edges.push({ from: name, to: superclass, type: "inherits" });
    }
    for (const protocol of stringArray(cls.protocols ?? cls.implements ?? cls.conformsTo)) {
      edges.push({ from: name, to: protocol, type: "conforms" });
    }
  }

  for (const rawProtocol of protocols) {
    const protocol = asRecord(rawProtocol);
    const name = stringValue(protocol.name, "");
    if (!name) {
      continue;
    }
    for (const parent of stringArray(protocol.inherits ?? protocol.extends)) {
      edges.push({ from: name, to: parent, type: "inherits" });
    }
  }

  for (const rawCategory of categories) {
    const category = asRecord(rawCategory);
    const className = stringValue(category.className ?? category.targetClass, "");
    if (!className) {
      continue;
    }
    const categoryName = stringValue(category.categoryName ?? category.name, "extension");
    edges.push({ from: `${className}(${categoryName})`, to: className, type: "extends" });
    for (const protocol of stringArray(category.protocols ?? category.implements)) {
      edges.push({ from: className, to: protocol, type: "conforms" });
    }
  }

  return [
    ...new Map(edges.map((edge) => [`${edge.from}\0${edge.to}\0${edge.type}`, edge])).values(),
  ];
}

function protocolResult(
  conforms: boolean,
  classFound: boolean,
  classDeclLine: number | null,
  direct: boolean,
  viaCategory: boolean,
  viaInheritedProtocol: boolean,
) {
  return { conforms, classFound, classDeclLine, direct, viaCategory, viaInheritedProtocol };
}

function nearestContextName(node: { readonly parent?: unknown }): string | null {
  let current = node.parent;
  while (isTreeSitterNodeLike(current)) {
    if (
      [
        "class_declaration",
        "struct_declaration",
        "class_interface",
        "class_implementation",
        "method_definition",
        "function_declaration",
        "method_declaration",
      ].includes(current.type)
    ) {
      return firstIdentifierText(current) ?? null;
    }
    current = current.parent;
  }
  return null;
}

function firstIdentifierText(node: {
  readonly namedChildCount: number;
  namedChild(index: number): unknown;
}): string | null {
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (
      isTreeSitterNodeLike(child) &&
      ["identifier", "simple_identifier", "type_identifier", "property_identifier"].includes(
        child.type,
      )
    ) {
      return child.text;
    }
  }
  return null;
}

function isTreeSitterNodeLike(value: unknown): value is {
  readonly type: string;
  readonly text: string;
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly startPosition: { readonly row: number };
  readonly parent?: unknown;
  child(index: number): unknown;
  namedChild(index: number): unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly type?: unknown }).type === "string" &&
    typeof (value as { readonly text?: unknown }).text === "string" &&
    typeof (value as { readonly childCount?: unknown }).childCount === "number" &&
    typeof (value as { readonly namedChildCount?: unknown }).namedChildCount === "number" &&
    typeof (value as { readonly child?: unknown }).child === "function" &&
    typeof (value as { readonly namedChild?: unknown }).namedChild === "function"
  );
}
