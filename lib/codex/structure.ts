import {
  type MainlineProjectIntelligenceArtifact,
  type MainlineProjectIntelligenceFile,
  MainlineProjectIntelligenceQueries,
  type MainlineProjectIntelligenceSymbol,
  summarizeMainlineProjectIntelligenceReadModel,
} from "../mainline/graph/index.js";
import type {
  MainlineSearchDocument,
  MainlineSearchIndexSnapshot,
} from "../mainline/search/index.js";
import {
  type CodexRuntimeReadiness,
  codexReadModelPaths,
  inspectCodexRuntimeReadiness,
  readCodexJsonModel,
} from "./read-models.js";
import { inspectWorkspace } from "./workspace.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STRUCTURE_OPERATIONS = ["summary", "files", "symbols", "dependencies", "cycles"] as const;

export type CodexStructureOperation = (typeof STRUCTURE_OPERATIONS)[number];

export interface CodexStructureResult {
  readonly status: "completed" | "invalid-input" | "missing-project-intelligence" | "uninitialized";
  readonly message: string;
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly readiness: CodexRuntimeReadiness;
  readonly warnings: readonly string[];
  readonly operation: CodexStructureOperation;
  readonly limit: number;
  readonly summary: unknown;
  readonly files?: readonly CodexStructureFile[];
  readonly symbols?: readonly CodexStructureSymbol[];
  readonly dependencies?: readonly CodexStructureDependencyAdjacency[];
  readonly cycles?: readonly CodexStructureCycle[];
  readonly sources: CodexStructureSources;
}

export interface CodexStructureFile {
  readonly path: string;
  readonly languageId?: string;
  readonly status?: string;
  readonly symbolCount: number;
}

export interface CodexStructureSymbol {
  readonly id: string;
  readonly fqn: string;
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line?: number;
  readonly isExported?: boolean;
}

export interface CodexStructureDependency {
  readonly file: string;
  readonly kind: string;
  readonly specifier?: string;
}

export interface CodexStructureDependencyAdjacency {
  readonly file: string;
  readonly dependencies: readonly CodexStructureDependency[];
  readonly dependents: readonly CodexStructureDependency[];
}

export interface CodexStructureCycle {
  readonly kind: "file";
  readonly nodes: readonly string[];
}

export interface CodexStructureSources {
  readonly projectIntelligencePath: string;
  readonly searchSnapshotPath: string;
  readonly source: "project-intelligence" | "search-index-graph-summary" | "none";
}

interface ParsedStructureInput {
  readonly projectRoot?: string;
  readonly operation: CodexStructureOperation;
  readonly path?: string;
  readonly symbol?: string;
  readonly limit: number;
}

export async function runCodexStructure(
  args: Record<string, unknown> = {},
): Promise<CodexStructureResult> {
  const parsed = parseStructureInput(args);
  const workspace = inspectWorkspace(parsed.projectRoot);
  const readiness = inspectCodexRuntimeReadiness(workspace);
  const paths = codexReadModelPaths(workspace);
  const warnings: string[] = [];

  if (parsed.status === "invalid-input") {
    return emptyResult({
      status: "invalid-input",
      message: parsed.message,
      workspace,
      readiness,
      warnings,
      operation: parsed.operation,
      limit: parsed.limit,
      sources: {
        projectIntelligencePath: paths.projectIntelligencePath,
        searchSnapshotPath: paths.searchSnapshotPath,
        source: "none",
      },
    });
  }

  if (!workspace.initialized) {
    warnings.push("workspace_uninitialized");
    return emptyResult({
      status: "uninitialized",
      message: "Alembic workspace is not initialized.",
      workspace,
      readiness,
      warnings,
      operation: parsed.input.operation,
      limit: parsed.input.limit,
      sources: {
        projectIntelligencePath: paths.projectIntelligencePath,
        searchSnapshotPath: paths.searchSnapshotPath,
        source: "none",
      },
    });
  }

  const artifact = await readCodexJsonModel<MainlineProjectIntelligenceArtifact>(
    paths.projectIntelligencePath,
    "project_intelligence",
    warnings,
  );
  if (artifact) {
    return resultFromArtifact({
      artifact,
      input: parsed.input,
      workspace,
      readiness,
      warnings,
      sources: {
        projectIntelligencePath: paths.projectIntelligencePath,
        searchSnapshotPath: paths.searchSnapshotPath,
        source: "project-intelligence",
      },
    });
  }

  const searchSnapshot = await readCodexJsonModel<MainlineSearchIndexSnapshot>(
    paths.searchSnapshotPath,
    "search_snapshot",
    warnings,
  );
  const searchDocuments = Array.isArray(searchSnapshot?.documents) ? searchSnapshot.documents : [];
  if (searchDocuments.length > 0) {
    warnings.push("project_intelligence_missing_used_search_index_graph_summary");
    return resultFromSearchDocuments({
      documents: searchDocuments,
      input: parsed.input,
      workspace,
      readiness,
      warnings,
      sources: {
        projectIntelligencePath: paths.projectIntelligencePath,
        searchSnapshotPath: paths.searchSnapshotPath,
        source: "search-index-graph-summary",
      },
    });
  }

  warnings.push("project_intelligence_artifact_missing");
  return emptyResult({
    status: "missing-project-intelligence",
    message: "Project intelligence artifact is missing. Run bootstrap or rescan first.",
    workspace,
    readiness,
    warnings,
    operation: parsed.input.operation,
    limit: parsed.input.limit,
    sources: {
      projectIntelligencePath: paths.projectIntelligencePath,
      searchSnapshotPath: paths.searchSnapshotPath,
      source: "none",
    },
  });
}

function resultFromArtifact(input: {
  readonly artifact: MainlineProjectIntelligenceArtifact;
  readonly input: ParsedStructureInput;
  readonly workspace: { readonly projectRoot: string; readonly dataRoot: string };
  readonly readiness: CodexRuntimeReadiness;
  readonly warnings: readonly string[];
  readonly sources: CodexStructureSources;
}): CodexStructureResult {
  const queries = new MainlineProjectIntelligenceQueries(input.artifact);
  const summary = summarizeMainlineProjectIntelligenceReadModel(input.artifact);
  const base = {
    status: "completed" as const,
    message: "Structure query completed.",
    projectRoot: input.workspace.projectRoot,
    dataRoot: input.workspace.dataRoot,
    readiness: input.readiness,
    warnings: input.warnings,
    operation: input.input.operation,
    limit: input.input.limit,
    summary,
    sources: input.sources,
  };

  switch (input.input.operation) {
    case "summary":
      return base;
    case "files":
      return {
        ...base,
        files: filterFiles(input.artifact.files, input.input.path)
          .slice(0, input.input.limit)
          .map(summarizeFile),
      };
    case "symbols":
      return {
        ...base,
        symbols: filterSymbols(input.artifact.symbols, input.input)
          .slice(0, input.input.limit)
          .map(summarizeSymbol),
      };
    case "dependencies":
      return {
        ...base,
        dependencies: queries
          .fileDependencyAdjacency(input.input.path)
          .slice(0, input.input.limit)
          .map((entry) => ({
            file: entry.file,
            dependencies: entry.dependencies.slice(0, input.input.limit).map((dependency) => ({
              file: dependency.file,
              kind: dependency.kind,
              ...(dependency.specifier ? { specifier: dependency.specifier } : {}),
            })),
            dependents: entry.dependents.slice(0, input.input.limit).map((dependency) => ({
              file: dependency.file,
              kind: dependency.kind,
              ...(dependency.specifier ? { specifier: dependency.specifier } : {}),
            })),
          })),
      };
    case "cycles":
      return {
        ...base,
        cycles: queries.cycles(input.input.path).slice(0, input.input.limit),
      };
  }
}

function resultFromSearchDocuments(input: {
  readonly documents: readonly MainlineSearchDocument[];
  readonly input: ParsedStructureInput;
  readonly workspace: { readonly projectRoot: string; readonly dataRoot: string };
  readonly readiness: CodexRuntimeReadiness;
  readonly warnings: readonly string[];
  readonly sources: CodexStructureSources;
}): CodexStructureResult {
  const files = input.documents.filter((document) => document.kind === "file");
  const symbols = input.documents.filter((document) => document.kind === "symbol");
  const graphNodes = input.documents.filter((document) => document.kind === "graph-node");
  const summary = {
    fileCount: files.length,
    symbolCount: symbols.length,
    edgeCount: graphNodes.length,
    languages: summarizeDocumentLanguages(files),
  };
  const base = {
    status: "completed" as const,
    message: "Structure query completed from search graph documents.",
    projectRoot: input.workspace.projectRoot,
    dataRoot: input.workspace.dataRoot,
    readiness: input.readiness,
    warnings: input.warnings,
    operation: input.input.operation,
    limit: input.input.limit,
    summary,
    sources: input.sources,
  };

  switch (input.input.operation) {
    case "summary":
      return base;
    case "files":
      return {
        ...base,
        files: files
          .filter((document) => !input.input.path || document.path?.includes(input.input.path))
          .slice(0, input.input.limit)
          .map((document) => ({
            path: document.path ?? document.title ?? document.id,
            ...(metadataString(document, "languageId")
              ? { languageId: metadataString(document, "languageId") }
              : {}),
            ...(metadataString(document, "status")
              ? { status: metadataString(document, "status") }
              : {}),
            symbolCount: metadataNumber(document, "symbolCount") ?? 0,
          })),
      };
    case "symbols":
      return {
        ...base,
        symbols: symbols
          .filter((document) => {
            const symbol = document.symbol ?? metadataString(document, "fqn");
            const path = document.path ?? "";
            return (
              (!input.input.symbol || symbol.includes(input.input.symbol)) &&
              (!input.input.path || path.includes(input.input.path))
            );
          })
          .slice(0, input.input.limit)
          .map((document) => {
            const line = metadataNumber(document, "line");
            const fqn = document.symbol || metadataString(document, "fqn") || document.id;
            return {
              id: document.id,
              fqn,
              name: document.title ?? document.id,
              kind: metadataString(document, "kind") || "symbol",
              file: document.path ?? "",
              ...(line !== undefined ? { line } : {}),
              ...(typeof document.metadata?.isExported === "boolean"
                ? { isExported: document.metadata.isExported }
                : {}),
            };
          }),
      };
    case "dependencies":
      return {
        ...base,
        dependencies: dependencyAdjacencyFromGraphDocuments(graphNodes, input.input).slice(
          0,
          input.input.limit,
        ),
      };
    case "cycles":
      return { ...base, cycles: [] };
  }
}

function parseStructureInput(args: Record<string, unknown>):
  | { readonly status: "ok"; readonly projectRoot?: string; readonly input: ParsedStructureInput }
  | {
      readonly status: "invalid-input";
      readonly projectRoot?: string;
      readonly message: string;
      readonly operation: CodexStructureOperation;
      readonly limit: number;
    } {
  const projectRoot = stringValue(args.projectRoot);
  const rawOperation = stringValue(args.operation) ?? "summary";
  const limit = boundedInteger(args.limit, 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
  if (!isStructureOperation(rawOperation)) {
    return {
      status: "invalid-input",
      ...(projectRoot ? { projectRoot } : {}),
      message: `Unsupported alembic_structure operation: ${rawOperation}`,
      operation: "summary",
      limit,
    };
  }
  const path = stringValue(args.path) ?? stringValue(args.file) ?? stringValue(args.target);
  const symbol = stringValue(args.symbol);
  return {
    status: "ok",
    ...(projectRoot ? { projectRoot } : {}),
    input: {
      ...(projectRoot ? { projectRoot } : {}),
      operation: rawOperation,
      ...(path ? { path } : {}),
      ...(symbol ? { symbol } : {}),
      limit,
    },
  };
}

function emptyResult(input: {
  readonly status: CodexStructureResult["status"];
  readonly message: string;
  readonly workspace: { readonly projectRoot: string; readonly dataRoot: string };
  readonly readiness: CodexRuntimeReadiness;
  readonly warnings: readonly string[];
  readonly operation: CodexStructureOperation;
  readonly limit: number;
  readonly sources: CodexStructureSources;
}): CodexStructureResult {
  return {
    status: input.status,
    message: input.message,
    projectRoot: input.workspace.projectRoot,
    dataRoot: input.workspace.dataRoot,
    readiness: input.readiness,
    warnings: input.warnings,
    operation: input.operation,
    limit: input.limit,
    summary: {},
    sources: input.sources,
  };
}

function filterFiles(
  files: readonly MainlineProjectIntelligenceFile[],
  pathFilter: string | undefined,
): MainlineProjectIntelligenceFile[] {
  return [...files]
    .filter((file) => !pathFilter || file.path.includes(pathFilter))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function filterSymbols(
  symbols: readonly MainlineProjectIntelligenceSymbol[],
  input: ParsedStructureInput,
): MainlineProjectIntelligenceSymbol[] {
  return [...symbols]
    .filter(
      (symbol) =>
        (!input.path || symbol.file.includes(input.path)) &&
        (!input.symbol || symbol.fqn.includes(input.symbol) || symbol.name.includes(input.symbol)),
    )
    .sort((left, right) => left.fqn.localeCompare(right.fqn));
}

function summarizeFile(file: MainlineProjectIntelligenceFile): CodexStructureFile {
  return {
    path: file.path,
    languageId: file.languageId,
    status: file.status,
    symbolCount: file.symbolIds.length,
  };
}

function summarizeSymbol(symbol: MainlineProjectIntelligenceSymbol): CodexStructureSymbol {
  return {
    id: symbol.id,
    fqn: symbol.fqn,
    name: symbol.name,
    kind: symbol.kind,
    file: symbol.file,
    ...(symbol.line > 0 ? { line: symbol.line } : {}),
    isExported: symbol.isExported,
  };
}

function dependencyAdjacencyFromGraphDocuments(
  graphNodes: readonly MainlineSearchDocument[],
  input: ParsedStructureInput,
): CodexStructureDependencyAdjacency[] {
  const byFile = new Map<
    string,
    { dependencies: CodexStructureDependency[]; dependents: CodexStructureDependency[] }
  >();
  for (const document of graphNodes) {
    const from = metadataString(document, "from");
    const to = metadataString(document, "to");
    const kind = metadataString(document, "kind");
    if (!from.startsWith("file:") || !to.startsWith("file:") || !kind) {
      continue;
    }
    const fromFile = from.slice("file:".length);
    const toFile = to.slice("file:".length);
    if (input.path && fromFile !== input.path && toFile !== input.path) {
      continue;
    }
    const specifier = metadataString(document, "specifier");
    const dependency = {
      file: toFile,
      kind,
      ...(specifier ? { specifier } : {}),
    };
    const dependent = {
      file: fromFile,
      kind,
      ...(specifier ? { specifier } : {}),
    };
    const fromEntry = byFile.get(fromFile) ?? { dependencies: [], dependents: [] };
    fromEntry.dependencies.push(dependency);
    byFile.set(fromFile, fromEntry);
    const toEntry = byFile.get(toFile) ?? { dependencies: [], dependents: [] };
    toEntry.dependents.push(dependent);
    byFile.set(toFile, toEntry);
  }
  return [...byFile.entries()]
    .map(([file, adjacency]) => ({
      file,
      dependencies: sortDependencies(adjacency.dependencies).slice(0, input.limit),
      dependents: sortDependencies(adjacency.dependents).slice(0, input.limit),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function summarizeDocumentLanguages(
  files: readonly MainlineSearchDocument[],
): Array<{ readonly languageId: string; readonly fileCount: number }> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const languageId = metadataString(file, "languageId");
    if (languageId) {
      counts.set(languageId, (counts.get(languageId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([languageId, fileCount]) => ({ languageId, fileCount }))
    .sort(
      (left, right) =>
        right.fileCount - left.fileCount || left.languageId.localeCompare(right.languageId),
    );
}

function sortDependencies(
  dependencies: readonly CodexStructureDependency[],
): CodexStructureDependency[] {
  return [...dependencies].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.kind.localeCompare(right.kind) ||
      (left.specifier ?? "").localeCompare(right.specifier ?? ""),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isStructureOperation(value: string): value is CodexStructureOperation {
  return STRUCTURE_OPERATIONS.includes(value as CodexStructureOperation);
}

function metadataString(document: MainlineSearchDocument, key: string): string {
  const value = document.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function metadataNumber(document: MainlineSearchDocument, key: string): number | undefined {
  const value = document.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
