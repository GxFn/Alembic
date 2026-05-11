import {
  type MainlineAstParser,
  type MainlineCallSite,
  type MainlineImportRecord,
  type MainlineSourceSymbol,
  MainlineSymbolTableBuilder,
  TreeSitterMainlineAstParser,
} from "../../engineering/code/index.js";
import { computeMainlineContentHash } from "../core/Hashing.js";
import { normalizeMainlinePosixPath } from "../core/PathIdentity.js";
import {
  type MainlineProjectGraph,
  MainlineProjectGraphBuilder,
  type MainlineProjectGraphEdgeKind,
} from "./ProjectGraph.js";

export type MainlineProjectIntelligenceEdgeKind =
  | MainlineProjectGraphEdgeKind
  | "calls"
  | "constructs"
  | "data_flow";

export interface MainlineProjectIntelligenceFileInput {
  readonly path: string;
  readonly content: string;
  readonly languageId?: string;
}

export interface MainlineProjectIntelligenceBuildInput {
  readonly projectRoot?: string;
  readonly knownFiles?: readonly string[];
  readonly files: readonly MainlineProjectIntelligenceFileInput[];
  readonly generatedAt?: number;
}

export interface MainlineProjectIntelligenceFile {
  readonly path: string;
  readonly languageId: string;
  readonly status: "parsed" | "unsupported" | "failed";
  readonly contentHash: string;
  readonly symbolIds: string[];
}

export interface MainlineProjectIntelligenceSymbol {
  readonly id: string;
  readonly fqn: string;
  readonly name: string;
  readonly kind: MainlineSourceSymbol["kind"];
  readonly file: string;
  readonly languageId: string;
  readonly line: number;
  readonly containerName: string | null;
  readonly isExported: boolean;
}

export interface MainlineProjectIntelligenceEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: MainlineProjectIntelligenceEdgeKind;
  readonly file?: string;
  readonly line?: number;
  readonly specifier?: string;
}

export interface MainlineLegacyAstProjectSummary {
  readonly lang: string;
  readonly fileCount: number;
  readonly classes: readonly Record<string, unknown>[];
  readonly protocols: readonly Record<string, unknown>[];
  readonly categories: readonly Record<string, unknown>[];
  readonly inheritanceGraph: readonly Record<string, unknown>[];
  readonly patternStats: Record<string, unknown>;
  readonly projectMetrics: Record<string, unknown>;
  readonly fileSummaries: readonly MainlineLegacyAstFileSummary[];
}

export interface MainlineLegacyAstFileSummary extends Record<string, unknown> {
  readonly file: string;
  readonly lang?: string;
  readonly classes?: readonly Record<string, unknown>[];
  readonly protocols?: readonly Record<string, unknown>[];
  readonly categories?: readonly Record<string, unknown>[];
  readonly methods?: readonly Record<string, unknown>[];
  readonly properties?: readonly Record<string, unknown>[];
  readonly imports?: readonly unknown[];
  readonly exports?: readonly unknown[];
  readonly callSites?: readonly Record<string, unknown>[];
  readonly inheritanceGraph?: readonly Record<string, unknown>[];
  readonly metrics?: Record<string, unknown>;
}

export interface MainlineProjectCallGraphEdge {
  readonly caller: string;
  readonly callee: string;
  readonly callType: string;
  readonly resolveMethod: string;
  readonly line: number;
  readonly file: string;
  readonly isAwait: boolean;
  readonly argCount: number;
}

export interface MainlineProjectDataFlowEdge {
  readonly from: string;
  readonly to: string;
  readonly flowType: string;
  readonly direction: string;
  readonly confidence?: number;
}

export interface MainlineProjectCallGraphFacts {
  readonly callEdges: readonly MainlineProjectCallGraphEdge[];
  readonly dataFlowEdges: readonly MainlineProjectDataFlowEdge[];
  readonly stats: Record<string, unknown>;
}

export interface MainlineProjectIntelligenceArtifact {
  readonly projectRoot?: string;
  readonly generatedAt?: number;
  readonly files: MainlineProjectIntelligenceFile[];
  readonly symbols: MainlineProjectIntelligenceSymbol[];
  readonly callSites: MainlineCallSite[];
  readonly projectGraph: MainlineProjectGraph;
  readonly semanticEdges: MainlineProjectIntelligenceEdge[];
  readonly astProjectSummary?: MainlineLegacyAstProjectSummary;
  readonly callGraph?: MainlineProjectCallGraphFacts;
}

interface ParsedFileFacts {
  readonly input: MainlineProjectIntelligenceFileInput;
  readonly path: string;
  readonly content: string;
  readonly languageId: string;
  readonly status: MainlineProjectIntelligenceFile["status"];
  readonly symbols: readonly MainlineSourceSymbol[];
  readonly imports: readonly MainlineImportRecord[];
  readonly callSites: readonly MainlineCallSite[];
  readonly legacySummary?: MainlineLegacyAstFileSummary;
}

export interface MainlineProjectIntelligenceBuilderDependencies {
  readonly parser?: MainlineAstParser;
  readonly graphBuilder?: MainlineProjectGraphBuilder;
  readonly symbolTableBuilder?: MainlineSymbolTableBuilder;
}

/**
 * ProjectIntelligenceArtifact 是 Round 2 的编译期事实包。
 * 它把轻量 AST、符号表、文件依赖图和保守调用点合成一个可序列化 artifact；
 * 这里不写数据库，也不把代码事实伪装成 Recipe。
 */
export class MainlineProjectIntelligenceBuilder {
  readonly #parser: MainlineAstParser;
  readonly #graphBuilder: MainlineProjectGraphBuilder;
  readonly #symbolTableBuilder: MainlineSymbolTableBuilder;

  constructor(dependencies: MainlineProjectIntelligenceBuilderDependencies = {}) {
    this.#parser = dependencies.parser ?? new TreeSitterMainlineAstParser();
    this.#graphBuilder = dependencies.graphBuilder ?? new MainlineProjectGraphBuilder();
    this.#symbolTableBuilder = dependencies.symbolTableBuilder ?? new MainlineSymbolTableBuilder();
  }

  async build(
    input: MainlineProjectIntelligenceBuildInput,
  ): Promise<MainlineProjectIntelligenceArtifact> {
    const parsedFiles = await this.#parseFiles(input.files);
    const astProjectSummary = buildLegacyAstProjectSummary(parsedFiles);
    const callGraph =
      astProjectSummary === undefined
        ? undefined
        : await analyzeLegacyProjectCallGraph(astProjectSummary, input.projectRoot ?? "/");
    const symbolTable = this.#symbolTableBuilder.build(
      parsedFiles.map((file) => ({
        path: file.path,
        languageId: file.languageId,
        symbols: file.symbols,
        imports: file.imports,
      })),
    );
    const symbols = [...symbolTable.declarations.values()].map((declaration) => ({
      id: symbolNodeId(declaration.fqn),
      fqn: declaration.fqn,
      name: declaration.name,
      kind: declaration.kind,
      file: declaration.file,
      languageId: declaration.languageId,
      line: declaration.line,
      containerName: declaration.containerName,
      isExported: declaration.isExported,
    }));
    const knownFiles = input.knownFiles ?? parsedFiles.map((file) => file.path);
    const projectGraph = this.#graphBuilder.build({
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
      knownFiles,
      files: parsedFiles.map((file) => ({
        path: file.path,
        content: file.content,
        languageId: file.languageId,
        symbols: file.symbols,
        // graph 层统一消费 AST/import parser 的结构化 records，不再从 content 里重抽 import。
        imports: file.imports,
      })),
    });
    const files = parsedFiles.map((file) => {
      const symbolIds = symbols
        .filter((symbol) => symbol.file === file.path)
        .map((symbol) => symbol.id)
        .sort();
      return {
        path: file.path,
        languageId: file.languageId,
        status: file.status,
        contentHash: computeMainlineContentHash(file.content),
        symbolIds,
      };
    });

    return {
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
      ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
      files,
      symbols: sortSymbols(symbols),
      callSites: sortCallSites(parsedFiles.flatMap((file) => file.callSites)),
      projectGraph,
      semanticEdges: buildSemanticEdges(projectGraph, parsedFiles, callGraph),
      ...(astProjectSummary === undefined ? {} : { astProjectSummary }),
      ...(callGraph === undefined ? {} : { callGraph }),
    };
  }

  async #parseFiles(
    files: readonly MainlineProjectIntelligenceFileInput[],
  ): Promise<ParsedFileFacts[]> {
    const parsedFiles: ParsedFileFacts[] = [];
    for (const file of files) {
      const normalizedPath = normalizeMainlinePosixPath(file.path);
      if (!normalizedPath) {
        continue;
      }
      const result = await this.#parser.parse({
        path: normalizedPath,
        content: file.content,
        ...(file.languageId
          ? {
              language: {
                languageId: file.languageId,
                path: normalizedPath,
                confidence: 1,
                reason: "Provided by project intelligence input.",
              },
            }
          : {}),
      });
      parsedFiles.push({
        input: file,
        path: normalizedPath,
        content: file.content,
        languageId: result.languageId,
        status: result.status,
        symbols: result.symbols,
        imports: result.imports,
        callSites: result.callSites,
        ...(isLegacyAstFileSummary(result.legacySummary)
          ? { legacySummary: { ...result.legacySummary, file: normalizedPath } }
          : {}),
      });
    }
    return parsedFiles.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function isLegacyAstFileSummary(value: unknown): value is MainlineLegacyAstFileSummary {
  return typeof value === "object" && value !== null;
}

function buildLegacyAstProjectSummary(
  files: readonly ParsedFileFacts[],
): MainlineLegacyAstProjectSummary | undefined {
  const fileSummaries = files
    .filter((file) => file.legacySummary)
    .map((file) => file.legacySummary)
    .filter((summary): summary is MainlineLegacyAstFileSummary => Boolean(summary));
  if (fileSummaries.length === 0) {
    return undefined;
  }

  const classes = fileSummaries.flatMap((summary) => withFile(summary.classes ?? [], summary.file));
  const protocols = fileSummaries.flatMap((summary) =>
    withFile(summary.protocols ?? [], summary.file),
  );
  const categories = fileSummaries.flatMap((summary) =>
    withFile(summary.categories ?? [], summary.file),
  );
  const inheritanceGraph = fileSummaries.flatMap((summary) => summary.inheritanceGraph ?? []);

  return {
    lang: dominantLanguage(files),
    fileCount: fileSummaries.length,
    classes,
    protocols,
    categories,
    inheritanceGraph,
    patternStats: buildPatternStats(fileSummaries),
    projectMetrics: aggregateLegacyMetrics(fileSummaries),
    fileSummaries,
  };
}

async function analyzeLegacyProjectCallGraph(
  astProjectSummary: MainlineLegacyAstProjectSummary,
  projectRoot: string,
): Promise<MainlineProjectCallGraphFacts | undefined> {
  if (!astProjectSummary.fileSummaries.some((summary) => (summary.callSites?.length ?? 0) > 0)) {
    return undefined;
  }

  try {
    const { CallGraphAnalyzer } = await import("../../engineering/code/analysis/index.js");
    const analyzer = new CallGraphAnalyzer(projectRoot);
    const result = await analyzer.analyze(astProjectSummary, {
      timeout: 15_000,
      maxCallSitesPerFile: 500,
      minConfidence: 0.5,
    });
    return {
      callEdges: result.callEdges.map((edge) => ({
        caller: edge.caller,
        callee: edge.callee,
        callType: edge.callType,
        resolveMethod: edge.resolveMethod,
        line: edge.line ?? 0,
        file: edge.filePath,
        isAwait: edge.isAwait,
        argCount: edge.argCount,
      })),
      dataFlowEdges: result.dataFlowEdges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        flowType: edge.flowType,
        direction: edge.direction,
        ...(edge.confidence === null ? {} : { confidence: edge.confidence }),
      })),
      stats: { ...result.stats },
    };
  } catch {
    // 中文说明：调用图是增强事实，失败不能回退到薄 parser，也不能阻断 AST 基础事实落地。
    return undefined;
  }
}

function withFile(
  records: readonly Record<string, unknown>[],
  file: string,
): Record<string, unknown>[] {
  return records.map((record) => ({ ...record, file }));
}

function dominantLanguage(files: readonly ParsedFileFacts[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    counts.set(file.languageId, (counts.get(file.languageId) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? "unknown"
  );
}

function buildPatternStats(
  fileSummaries: readonly MainlineLegacyAstFileSummary[],
): Record<string, unknown> {
  const stats: Record<string, { count: number; files: string[]; instances: unknown[] }> = {};
  for (const summary of fileSummaries) {
    const patterns = Array.isArray(summary.patterns) ? summary.patterns : [];
    for (const pattern of patterns) {
      if (!isRecord(pattern)) {
        continue;
      }
      const type = typeof pattern.type === "string" ? pattern.type : "unknown";
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

function aggregateLegacyMetrics(
  fileSummaries: readonly MainlineLegacyAstFileSummary[],
): Record<string, unknown> {
  const methods = fileSummaries.flatMap((summary) => summary.methods ?? []);
  const classes = fileSummaries.flatMap((summary) => summary.classes ?? []);
  const definitionMethods = methods.filter((method) => method.kind === "definition");
  const classMethodCounts = new Map<string, number>();
  for (const method of definitionMethods) {
    if (typeof method.className === "string") {
      classMethodCounts.set(method.className, (classMethodCounts.get(method.className) ?? 0) + 1);
    }
  }
  const methodCountValues = [...classMethodCounts.values()];

  return {
    totalMethods: definitionMethods.length,
    totalClasses: classes.length,
    avgMethodsPerClass:
      methodCountValues.length === 0
        ? 0
        : methodCountValues.reduce((sum, count) => sum + count, 0) / methodCountValues.length,
    maxNestingDepth: maxNumeric(definitionMethods, "nestingDepth"),
    longMethods: definitionMethods.filter((method) => numericValue(method.bodyLines) > 50),
    complexMethods: definitionMethods.filter((method) => numericValue(method.complexity) > 10),
  };
}

function maxNumeric(records: readonly Record<string, unknown>[], key: string): number {
  return records.reduce((max, record) => Math.max(max, numericValue(record[key])), 0);
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildSemanticEdges(
  projectGraph: MainlineProjectGraph,
  files: readonly ParsedFileFacts[],
  callGraph: MainlineProjectCallGraphFacts | undefined,
): MainlineProjectIntelligenceEdge[] {
  const graphEdges = projectGraph.edges.map((edge) => ({
    from: normalizeGraphNodeId(edge.from),
    to: normalizeGraphNodeId(edge.to),
    kind: edge.kind,
    ...(edge.specifier === undefined ? {} : { specifier: edge.specifier }),
  }));
  const callEdges = files.flatMap((file) =>
    file.callSites.flatMap((callSite) => {
      if (!callSite.callerSymbol || !callSite.targetFqn) {
        return [];
      }
      return [
        {
          from: symbolNodeId(callSite.callerSymbol),
          to: symbolNodeId(callSite.targetFqn),
          kind: callSite.callType === "constructor" ? "constructs" : "calls",
          file: file.path,
          line: callSite.line,
        } satisfies MainlineProjectIntelligenceEdge,
      ];
    }),
  );
  const resolvedCallGraphEdges: MainlineProjectIntelligenceEdge[] = (
    callGraph?.callEdges ?? []
  ).map((edge) => ({
    from: symbolNodeId(edge.caller),
    to: symbolNodeId(edge.callee),
    kind: edge.callType === "constructor" ? "constructs" : "calls",
    file: edge.file,
    line: edge.line,
  }));
  const dataFlowEdges: MainlineProjectIntelligenceEdge[] = (callGraph?.dataFlowEdges ?? []).map(
    (edge) => ({
      from: symbolNodeId(edge.from),
      to: symbolNodeId(edge.to),
      kind: "data_flow",
    }),
  );

  return uniqueSemanticEdges([
    ...graphEdges,
    ...callEdges,
    ...resolvedCallGraphEdges,
    ...dataFlowEdges,
  ]).sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind) ||
      (left.line ?? 0) - (right.line ?? 0),
  );
}

function normalizeGraphNodeId(nodeId: string): string {
  if (nodeId.startsWith("symbol:")) {
    const body = nodeId.slice("symbol:".length);
    const separator = body.lastIndexOf("#");
    if (separator > 0) {
      return symbolNodeId(`${body.slice(0, separator)}::${body.slice(separator + 1)}`);
    }
  }
  return nodeId;
}

function symbolNodeId(fqn: string): string {
  return `symbol:${fqn}`;
}

function uniqueSemanticEdges(
  edges: readonly MainlineProjectIntelligenceEdge[],
): MainlineProjectIntelligenceEdge[] {
  return [
    ...new Map(
      edges.map((edge) => [
        `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.specifier ?? ""}\u0000${
          edge.line ?? 0
        }`,
        edge,
      ]),
    ).values(),
  ];
}

function sortCallSites(callSites: readonly MainlineCallSite[]): MainlineCallSite[] {
  return [...callSites].sort(
    (left, right) =>
      left.line - right.line ||
      left.callee.localeCompare(right.callee) ||
      left.callType.localeCompare(right.callType),
  );
}

function sortSymbols(
  symbols: readonly MainlineProjectIntelligenceSymbol[],
): MainlineProjectIntelligenceSymbol[] {
  return [...symbols].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.name.localeCompare(right.name) ||
      left.kind.localeCompare(right.kind),
  );
}
