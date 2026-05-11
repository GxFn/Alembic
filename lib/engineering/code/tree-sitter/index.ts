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
import { getCallSiteExtractor } from "./call-sites.js";
import { resolveTreeSitterLanguageId } from "./language-id.js";
import { computeMetrics } from "./metrics.js";
import { getParserClass, isParserReady } from "./parser-init.js";
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

interface EngineeringInheritanceEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "inherits" | "conforms" | "extends";
}

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

export function generateContextForAgent(projectSummary: {
  readonly fileCount?: number;
  readonly classes?: readonly Record<string, unknown>[];
  readonly protocols?: readonly Record<string, unknown>[];
  readonly categories?: readonly Record<string, unknown>[];
  readonly inheritanceGraph?: readonly EngineeringInheritanceEdge[];
  readonly patternStats?: Record<string, { readonly count?: number }>;
  readonly projectMetrics?: Record<string, unknown>;
}): string {
  const classes = projectSummary.classes ?? [];
  const protocols = projectSummary.protocols ?? [];
  const categories = projectSummary.categories ?? [];
  const inheritanceGraph = projectSummary.inheritanceGraph ?? [];
  const patternStats = projectSummary.patternStats ?? {};
  const projectMetrics = projectSummary.projectMetrics ?? {};
  const lines = ["## 项目代码结构分析（AST）", ""];

  lines.push("### 代码规模");
  lines.push(`- 已分析文件: ${projectSummary.fileCount ?? 0}`);
  lines.push(`- 类/结构体: ${classes.length}`);
  lines.push(`- 协议: ${protocols.length}`);
  lines.push(`- Category/Extension: ${categories.length}`);
  lines.push(`- 平均方法数/类: ${formatMetric(projectMetrics.avgMethodsPerClass)}`);
  lines.push(`- 最大嵌套深度: ${formatMetric(projectMetrics.maxNestingDepth)}`);
  lines.push("");

  if (inheritanceGraph.length > 0) {
    lines.push("### 继承关系图");
    lines.push("```");
    lines.push(renderInheritanceTree(inheritanceGraph));
    lines.push("```");
    lines.push("");
  }

  const conformances = classes.filter((entry) => stringArray(entry.protocols).length > 0);
  if (conformances.length > 0) {
    lines.push("### 协议遵循");
    for (const entry of conformances.slice(0, 20)) {
      lines.push(
        `- \`${stringValue(entry.name, "Unknown")}\` -> ${stringArray(entry.protocols)
          .map((protocol) => `\`${protocol}\``)
          .join(", ")}`,
      );
    }
    lines.push("");
  }

  if (categories.length > 0) {
    lines.push("### Category / Extension");
    for (const entry of categories.slice(0, 15)) {
      const className = stringValue(entry.className ?? entry.targetClass, "Unknown");
      const categoryName = stringValue(entry.categoryName ?? entry.name, "extension");
      lines.push(`- \`${className}(${categoryName})\``);
    }
    lines.push("");
  }

  if (Object.keys(patternStats).length > 0) {
    lines.push("### 检测到的设计模式");
    for (const [type, stat] of Object.entries(patternStats)) {
      lines.push(`- **${type}**: ${stat.count ?? 0} 处`);
    }
    lines.push("");
  }

  return lines.join("\n");
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

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
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

function buildPatternStats(
  fileSummaries: readonly EngineeringCodeAstFactsFileSummary[],
): Record<string, { count: number; files: string[]; instances: Record<string, unknown>[] }> {
  const stats: Record<
    string,
    { count: number; files: string[]; instances: Record<string, unknown>[] }
  > = {};
  for (const summary of fileSummaries) {
    const summaryRecord = summary as unknown as Record<string, unknown>;
    const patterns = Array.isArray(summaryRecord.patterns)
      ? (summaryRecord.patterns as readonly unknown[])
      : [];
    for (const pattern of patterns) {
      if (!isRecord(pattern)) {
        continue;
      }
      const type = stringValue(pattern.type, "unknown");
      stats[type] ??= { count: 0, files: [], instances: [] };
      stats[type].count += 1;
      if (!stats[type].files.includes(summary.file)) {
        stats[type].files.push(summary.file);
      }
      stats[type].instances.push({ ...pattern, file: summary.file });
    }
  }
  return stats;
}

function aggregateProjectMetrics(
  fileSummaries: readonly EngineeringCodeAstFactsFileSummary[],
): Record<string, unknown> {
  const methods = fileSummaries.flatMap((summary) => summary.methods);
  const definitionMethods = methods.filter(
    (method) => (method as unknown as Record<string, unknown>).kind === "definition",
  );
  const classMethodCounts = new Map<string, number>();
  for (const method of definitionMethods) {
    if (method.className) {
      classMethodCounts.set(method.className, (classMethodCounts.get(method.className) ?? 0) + 1);
    }
  }
  const methodCountValues = [...classMethodCounts.values()];

  return {
    totalMethods: definitionMethods.length,
    totalClasses: fileSummaries.reduce((sum, summary) => sum + summary.classes.length, 0),
    avgMethodsPerClass:
      methodCountValues.length === 0
        ? 0
        : methodCountValues.reduce((sum, count) => sum + count, 0) / methodCountValues.length,
    maxNestingDepth: maxNumeric(definitionMethods, "nestingDepth"),
    longMethods: definitionMethods.filter((method) => numericValue(method.bodyLines) > 50),
    complexMethods: definitionMethods.filter((method) => numericValue(method.complexity) > 10),
  };
}

function renderInheritanceTree(edges: readonly EngineeringInheritanceEdge[]): string {
  const targets = new Set(edges.map((edge) => edge.to));
  const sources = new Set(edges.map((edge) => edge.from));
  const roots = [...targets].filter((target) => !sources.has(target)).slice(0, 5);
  const childMap = new Map<string, string[]>();
  for (const edge of edges) {
    const children = childMap.get(edge.to) ?? [];
    const label = edge.type === "conforms" ? `${edge.from} [conforms]` : edge.from;
    if (!children.includes(label)) {
      children.push(label);
    }
    childMap.set(edge.to, children);
  }

  const lines: string[] = [];
  function render(name: string, depth: number): void {
    lines.push(`${"  ".repeat(depth)}${name}`);
    for (const child of (childMap.get(name) ?? []).slice(0, 10)) {
      render(child, depth + 1);
    }
  }
  for (const root of roots) {
    render(root, 0);
  }
  return lines.join("\n");
}

function dominantLanguage(fileSummaries: readonly EngineeringCodeAstFactsFileSummary[]): string {
  const counts = new Map<string, number>();
  for (const summary of fileSummaries) {
    counts.set(summary.languageId, (counts.get(summary.languageId) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? "unknown"
  );
}

function withFile<T extends object>(
  records: readonly T[],
  file: string,
): Array<T & { file: string }> {
  return records.map((record) => ({ ...record, file }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function formatMetric(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "0";
}

function maxNumeric(records: readonly unknown[], key: string): number {
  return records.reduce<number>(
    (max, record) => Math.max(max, numericValue(asRecord(record)[key])),
    0,
  );
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
