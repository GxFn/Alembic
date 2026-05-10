import {
  type MainlineAstParser,
  type MainlineCallSite,
  type MainlineImportRecord,
  type MainlineSourceSymbol,
  MainlineSymbolTableBuilder,
  StructuralMainlineAstParser,
} from "../code/index.js";
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
  | "constructs";

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

export interface MainlineProjectIntelligenceArtifact {
  readonly projectRoot?: string;
  readonly generatedAt?: number;
  readonly files: MainlineProjectIntelligenceFile[];
  readonly symbols: MainlineProjectIntelligenceSymbol[];
  readonly callSites: MainlineCallSite[];
  readonly projectGraph: MainlineProjectGraph;
  readonly semanticEdges: MainlineProjectIntelligenceEdge[];
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
    this.#parser = dependencies.parser ?? new StructuralMainlineAstParser();
    this.#graphBuilder = dependencies.graphBuilder ?? new MainlineProjectGraphBuilder();
    this.#symbolTableBuilder = dependencies.symbolTableBuilder ?? new MainlineSymbolTableBuilder();
  }

  async build(
    input: MainlineProjectIntelligenceBuildInput,
  ): Promise<MainlineProjectIntelligenceArtifact> {
    const parsedFiles = await this.#parseFiles(input.files);
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
      semanticEdges: buildSemanticEdges(projectGraph, parsedFiles),
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
      });
    }
    return parsedFiles.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function buildSemanticEdges(
  projectGraph: MainlineProjectGraph,
  files: readonly ParsedFileFacts[],
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

  return uniqueSemanticEdges([...graphEdges, ...callEdges]).sort(
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
