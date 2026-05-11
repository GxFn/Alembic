import { MainlineEmbeddingPortBatchEmbedder } from "../mainline/compile/index.js";
import { type ContextIndexSnapshot, InMemoryContextIndex } from "../mainline/data/index.js";
import {
  InMemoryMainlineSearchIndex,
  JsonMainlineVectorStore,
  MainlineHybridSearch,
  type MainlineHybridSearchHit,
  type MainlineSearchDocument,
  type MainlineSearchDocumentKind,
  type MainlineSearchHit,
  type MainlineSearchIndexSnapshot,
  projectMainlineSearchDocuments,
} from "../mainline/search/index.js";
import { createCodexEmbeddingProviderFromEnv } from "./ai-provider.js";
import {
  type CodexRuntimeReadiness,
  codexReadModelPaths,
  inspectCodexRuntimeReadiness,
  readCodexJsonModel,
} from "./read-models.js";
import { inspectWorkspace } from "./workspace.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SEARCH_KINDS = [
  "recipe",
  "source-ref",
  "symbol",
  "file",
  "note",
  "graph-node",
] satisfies MainlineSearchDocumentKind[];
const SEARCH_KIND_SET = new Set<string>(SEARCH_KINDS);

export interface CodexSearchResult {
  readonly status: "completed" | "invalid-input" | "missing-runtime-snapshot" | "uninitialized";
  readonly message: string;
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly readiness: CodexRuntimeReadiness;
  readonly warnings: readonly string[];
  readonly query: CodexSearchQuerySummary;
  readonly hitCount: number;
  readonly hits: readonly CodexSearchHit[];
  readonly sources: CodexSearchSources;
}

type CodexSearchBackendHit = MainlineSearchHit | MainlineHybridSearchHit;

export interface CodexSearchQuerySummary {
  readonly text?: string;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly kinds: readonly MainlineSearchDocumentKind[];
  readonly limit: number;
}

export interface CodexSearchHit {
  readonly id: string;
  readonly kind: MainlineSearchDocumentKind;
  readonly title?: string;
  readonly path?: string;
  readonly symbol?: string;
  readonly summary?: string;
  readonly recipeId?: string;
  readonly sourceRefId?: string;
  readonly tags: readonly string[];
  readonly score: number;
  readonly confidence: number;
  readonly reasons: readonly string[];
}

export interface CodexSearchSources {
  readonly contextSnapshotPath: string;
  readonly searchSnapshotPath: string;
  readonly vectorSnapshotPath: string;
  readonly searchDocumentCount: number;
  readonly contextDocumentCount: number;
  readonly vectorDocumentCount: number;
  readonly semantic: "hybrid" | "sparse";
}

interface ParsedSearchInput {
  readonly projectRoot?: string;
  readonly query: CodexSearchQuerySummary;
}

export async function runCodexSearch(
  args: Record<string, unknown> = {},
): Promise<CodexSearchResult> {
  const parsed = parseSearchInput(args);
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
      query: parsed.query,
      sources: {
        contextSnapshotPath: paths.contextSnapshotPath,
        searchSnapshotPath: paths.searchSnapshotPath,
        vectorSnapshotPath: paths.vectorSnapshotPath,
        searchDocumentCount: 0,
        contextDocumentCount: 0,
        vectorDocumentCount: 0,
        semantic: "sparse",
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
      query: parsed.input.query,
      sources: {
        contextSnapshotPath: paths.contextSnapshotPath,
        searchSnapshotPath: paths.searchSnapshotPath,
        vectorSnapshotPath: paths.vectorSnapshotPath,
        searchDocumentCount: 0,
        contextDocumentCount: 0,
        vectorDocumentCount: 0,
        semantic: "sparse",
      },
    });
  }

  const searchSnapshot = await readCodexJsonModel<MainlineSearchIndexSnapshot>(
    paths.searchSnapshotPath,
    "search_snapshot",
    warnings,
  );
  const contextSnapshot = await readCodexJsonModel<ContextIndexSnapshot>(
    paths.contextSnapshotPath,
    "context_snapshot",
    warnings,
  );

  if (!searchSnapshot && !contextSnapshot) {
    warnings.push("runtime_search_and_context_snapshots_missing");
    return emptyResult({
      status: "missing-runtime-snapshot",
      message:
        "Alembic runtime search and context snapshots are missing. Run bootstrap or rescan first.",
      workspace,
      readiness,
      warnings,
      query: parsed.input.query,
      sources: {
        contextSnapshotPath: paths.contextSnapshotPath,
        searchSnapshotPath: paths.searchSnapshotPath,
        vectorSnapshotPath: paths.vectorSnapshotPath,
        searchDocumentCount: 0,
        contextDocumentCount: 0,
        vectorDocumentCount: 0,
        semantic: "sparse",
      },
    });
  }

  if (!searchSnapshot) {
    warnings.push("search_snapshot_missing_used_context_index");
  }
  if (!contextSnapshot) {
    warnings.push("context_snapshot_missing_search_only");
  }

  // 中文注释：public search 同时恢复 SearchIndexSnapshot 与 ContextIndex；
  // ContextIndex 只作为运行期读模型补充投影，不能回扫 Markdown 或调用 Agent tools。
  const contextIndex = contextSnapshot ? new InMemoryContextIndex(contextSnapshot) : null;
  const contextDocuments = contextIndex
    ? projectMainlineSearchDocuments({ snapshot: contextIndex.snapshot() })
    : [];
  const searchDocuments = normalizeSearchSnapshotDocuments(searchSnapshot);
  const index = new InMemoryMainlineSearchIndex();
  index.upsert([...searchDocuments, ...contextDocuments]);

  const searchQuery = {
    ...(parsed.input.query.text ? { text: parsed.input.query.text } : {}),
    paths: parsed.input.query.paths,
    symbols: parsed.input.query.symbols,
    ...(parsed.input.query.kinds.length > 0 ? { kinds: parsed.input.query.kinds } : {}),
    limit: parsed.input.query.limit,
  };
  const searchResult = await searchWithOptionalHybrid({
    index,
    query: searchQuery,
    vectorSnapshotPath: paths.vectorSnapshotPath,
    warnings,
  });

  return {
    status: "completed",
    message: "Search completed.",
    projectRoot: workspace.projectRoot,
    dataRoot: workspace.dataRoot,
    readiness,
    warnings,
    query: parsed.input.query,
    hitCount: searchResult.hits.length,
    hits: searchResult.hits.map(summarizeHit),
    sources: {
      contextSnapshotPath: paths.contextSnapshotPath,
      searchSnapshotPath: paths.searchSnapshotPath,
      vectorSnapshotPath: paths.vectorSnapshotPath,
      searchDocumentCount: searchDocuments.length,
      contextDocumentCount: contextDocuments.length,
      vectorDocumentCount: searchResult.vectorDocumentCount,
      semantic: searchResult.semantic,
    },
  };
}

async function searchWithOptionalHybrid(input: {
  readonly index: InMemoryMainlineSearchIndex;
  readonly query: Parameters<InMemoryMainlineSearchIndex["search"]>[0];
  readonly vectorSnapshotPath: string;
  readonly warnings: string[];
}): Promise<{
  readonly hits: readonly CodexSearchBackendHit[];
  readonly vectorDocumentCount: number;
  readonly semantic: CodexSearchSources["semantic"];
}> {
  const sparseHits = () => ({
    hits: input.index.search(input.query),
    vectorDocumentCount: 0,
    semantic: "sparse" as const,
  });
  if (!input.query.text?.trim()) {
    return sparseHits();
  }

  const vectorStore = new JsonMainlineVectorStore(input.vectorSnapshotPath);
  let vectorDocumentCount = 0;
  try {
    await vectorStore.load();
    vectorDocumentCount = (await vectorStore.snapshot()).length;
  } catch {
    input.warnings.push("vector_snapshot_unreadable");
    return sparseHits();
  }
  if (vectorDocumentCount === 0) {
    return sparseHits();
  }

  const embeddingProvider = createCodexEmbeddingProviderFromEnv();
  if (!embeddingProvider) {
    input.warnings.push("semantic_search_embedding_provider_missing");
    return {
      hits: input.index.search(input.query),
      vectorDocumentCount,
      semantic: "sparse",
    };
  }

  try {
    const hybrid = new MainlineHybridSearch({
      searchIndex: input.index,
      vectorStore,
      embedder: new MainlineEmbeddingPortBatchEmbedder(embeddingProvider),
    });
    return {
      hits: await hybrid.search(input.query, {
        sparseLimit: Math.max(input.query.limit ?? DEFAULT_LIMIT, 50),
        vectorLimit: Math.max(input.query.limit ?? DEFAULT_LIMIT, 50),
      }),
      vectorDocumentCount,
      semantic: "hybrid",
    };
  } catch {
    input.warnings.push("semantic_search_failed_used_sparse");
    return {
      hits: input.index.search(input.query),
      vectorDocumentCount,
      semantic: "sparse",
    };
  }
}

function parseSearchInput(args: Record<string, unknown>):
  | { readonly status: "ok"; readonly projectRoot?: string; readonly input: ParsedSearchInput }
  | {
      readonly status: "invalid-input";
      readonly projectRoot?: string;
      readonly message: string;
      readonly query: CodexSearchQuerySummary;
    } {
  const projectRoot = stringValue(args.projectRoot);
  const text = stringValue(args.query) ?? stringValue(args.text);
  const paths = stringList(args.paths);
  const symbols = stringList(args.symbols);
  const limit = boundedInteger(args.limit, 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
  const kindsInput = stringList(args.kinds ?? args.kind);
  const kinds: MainlineSearchDocumentKind[] = [];
  for (const kind of kindsInput) {
    if (!isSearchKind(kind)) {
      return {
        status: "invalid-input",
        ...(projectRoot ? { projectRoot } : {}),
        message: `Unsupported alembic_search kind: ${kind}`,
        query: {
          ...(text ? { text } : {}),
          paths,
          symbols,
          kinds,
          limit,
        },
      };
    }
    kinds.push(kind);
  }

  return {
    status: "ok",
    ...(projectRoot ? { projectRoot } : {}),
    input: {
      ...(projectRoot ? { projectRoot } : {}),
      query: {
        ...(text ? { text } : {}),
        paths,
        symbols,
        kinds: [...new Set(kinds)],
        limit,
      },
    },
  };
}

function emptyResult(input: {
  readonly status: CodexSearchResult["status"];
  readonly message: string;
  readonly workspace: { readonly projectRoot: string; readonly dataRoot: string };
  readonly readiness: CodexRuntimeReadiness;
  readonly warnings: readonly string[];
  readonly query: CodexSearchQuerySummary;
  readonly sources: CodexSearchSources;
}): CodexSearchResult {
  return {
    status: input.status,
    message: input.message,
    projectRoot: input.workspace.projectRoot,
    dataRoot: input.workspace.dataRoot,
    readiness: input.readiness,
    warnings: input.warnings,
    query: input.query,
    hitCount: 0,
    hits: [],
    sources: input.sources,
  };
}

function summarizeHit(hit: CodexSearchBackendHit): CodexSearchHit {
  const document = hit.document;
  const recipeId = metadataString(document, "recipeId");
  const sourceRefId = metadataString(document, "sourceRefId");
  const summary = documentSummary(document);
  return {
    id: document.id,
    kind: document.kind,
    ...(document.title ? { title: document.title } : {}),
    ...(document.path ? { path: document.path } : {}),
    ...(document.symbol ? { symbol: document.symbol } : {}),
    ...(summary ? { summary } : {}),
    ...(recipeId ? { recipeId } : {}),
    ...(sourceRefId ? { sourceRefId } : {}),
    tags: [...(document.tags ?? [])].slice(0, 8),
    score: round(hit.score),
    confidence: round(hit.confidence ?? hit.score),
    reasons: hit.reasons.slice(0, 8),
  };
}

function normalizeSearchSnapshotDocuments(
  snapshot: MainlineSearchIndexSnapshot | null,
): MainlineSearchDocument[] {
  return Array.isArray(snapshot?.documents) ? [...snapshot.documents] : [];
}

function documentSummary(document: MainlineSearchDocument): string | undefined {
  const metadataSummary =
    metadataString(document, "summary") || metadataString(document, "description");
  const bodySummary = document.body?.replace(/\s+/g, " ").trim();
  const summary = metadataSummary || bodySummary;
  return summary ? summary.slice(0, 240) : undefined;
}

function metadataString(document: MainlineSearchDocument, key: string): string {
  const value = document.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [
    ...new Set(rawValues.map(stringValue).filter((entry): entry is string => Boolean(entry))),
  ];
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isSearchKind(value: string): value is MainlineSearchDocumentKind {
  return SEARCH_KIND_SET.has(value);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
