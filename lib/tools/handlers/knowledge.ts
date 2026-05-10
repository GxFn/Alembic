import type {
  ContextIndexReader,
  RecipeEdge,
  RecipeMarkdownFileIndex,
  SourceRef,
} from "../../mainline/data/index.js";
import type {
  MainlineSearchDocument,
  MainlineSearchDocumentKind,
  MainlineSearchHit,
  MainlineSearchQuery,
} from "../../mainline/search/index.js";
import type { ToolHandler, ToolResultEnvelope } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

const SEARCH_DOCUMENT_KINDS = new Set<MainlineSearchDocumentKind>([
  "recipe",
  "source-ref",
  "symbol",
  "file",
  "note",
  "graph-node",
]);

interface KnowledgeSearchInput {
  readonly text?: string;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly kinds?: readonly MainlineSearchDocumentKind[];
  readonly limit: number;
  readonly includeContext: boolean;
}

export const knowledgeSearchHandler: ToolHandler = async (
  invocation,
  context,
): Promise<ToolResultEnvelope> => {
  const parsed = parseKnowledgeSearchInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const searchIndex = context.dependencies.searchIndex;
  if (!searchIndex) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "search_index_unavailable",
      message: "knowledge.search requires a MainlineSearchIndex dependency.",
    });
  }

  const query = toSearchQuery(parsed.input);
  const hits = searchIndex.search(query);
  const contextSummary = await buildContextSummary({
    ...(context.dependencies.contextIndex
      ? { contextIndex: context.dependencies.contextIndex }
      : {}),
    hits,
    includeContext: parsed.input.includeContext,
  });

  return toolSuccess(context.descriptor, {
    query,
    hits: hits.map(formatSearchHit),
    context: contextSummary,
  });
};

function parseKnowledgeSearchInput(
  input: unknown,
):
  | { readonly ok: true; readonly input: KnowledgeSearchInput }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (input !== undefined && !isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "knowledge.search input must be an object." },
    };
  }

  const record = input ?? {};
  const text = optionalString(record.query) ?? optionalString(record.text);
  const paths = optionalStringArray(record.paths);
  const symbols = optionalStringArray(record.symbols);
  const kinds = optionalSearchKinds(record.kinds);
  const limit = boundedLimit(record.limit, 10, 50);
  const includeContext = record.includeContext !== false;

  if (record.limit !== undefined && limit === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "knowledge.search limit must be an integer." },
    };
  }
  if (record.kinds !== undefined && kinds === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "knowledge.search kinds contains an unknown kind." },
    };
  }
  if (!text && paths.length === 0 && symbols.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "knowledge.search requires query/text, paths, or symbols.",
      },
    };
  }

  return {
    ok: true,
    input: {
      ...(text ? { text } : {}),
      paths,
      symbols,
      ...(kinds ? { kinds } : {}),
      limit: limit ?? 10,
      includeContext,
    },
  };
}

function toSearchQuery(input: KnowledgeSearchInput): MainlineSearchQuery {
  return {
    ...(input.text ? { text: input.text } : {}),
    ...(input.paths.length > 0 ? { paths: input.paths } : {}),
    ...(input.symbols.length > 0 ? { symbols: input.symbols } : {}),
    ...(input.kinds ? { kinds: input.kinds } : {}),
    limit: input.limit,
  };
}

async function buildContextSummary(input: {
  readonly contextIndex?: ContextIndexReader;
  readonly hits: readonly MainlineSearchHit[];
  readonly includeContext: boolean;
}) {
  const recipeIds = uniqueStrings(input.hits.map((hit) => recipeIdFromDocument(hit.document)));
  if (!input.includeContext) {
    return { included: false, reason: "disabled", recipeIds };
  }
  if (!input.contextIndex) {
    return { included: false, reason: "context_index_unavailable", recipeIds };
  }
  if (recipeIds.length === 0) {
    return { included: true, recipeIds, recipeFiles: [], edges: [], sourceRefs: [] };
  }

  const [recipeFiles, edges, sourceRefs] = await Promise.all([
    input.contextIndex.findRecipeFilesByRecipeIds(recipeIds),
    input.contextIndex.findRecipeEdges(recipeIds),
    input.contextIndex.findSourceRefs(recipeIds),
  ]);

  return {
    included: true,
    recipeIds,
    recipeFiles: recipeFiles.map(formatRecipeFile),
    edges: edges.map(formatRecipeEdge),
    sourceRefs: sourceRefs.map(formatSourceRef),
  };
}

function formatSearchHit(hit: MainlineSearchHit) {
  return {
    document: formatSearchDocument(hit.document),
    score: round(hit.score),
    confidence: round(hit.confidence),
    reasons: [...hit.reasons].sort(),
  };
}

function formatSearchDocument(document: MainlineSearchDocument) {
  return {
    id: document.id,
    kind: document.kind,
    ...(document.title ? { title: document.title } : {}),
    ...(document.body ? { body: document.body } : {}),
    ...(document.path ? { path: document.path } : {}),
    ...(document.symbol ? { symbol: document.symbol } : {}),
    ...(document.tags ? { tags: [...document.tags].sort() } : {}),
    ...(document.metadata ? { metadata: document.metadata } : {}),
  };
}

function formatRecipeFile(file: RecipeMarkdownFileIndex) {
  return {
    recipeId: file.recipeId,
    bucket: file.bucket,
    relativePath: file.relativePath,
    contentHash: file.contentHash,
    ...(file.updatedAt === undefined ? {} : { updatedAt: file.updatedAt }),
  };
}

function formatRecipeEdge(edge: RecipeEdge) {
  return {
    id: edge.id,
    fromRecipeId: edge.fromRecipeId,
    toRecipeId: edge.toRecipeId,
    relation: edge.relation,
    weight: edge.weight,
    evidenceSource: edge.evidenceSource,
    sourceRefIds: [...edge.sourceRefIds].sort(),
    ...(edge.createdAt === undefined ? {} : { createdAt: edge.createdAt }),
  };
}

function formatSourceRef(sourceRef: SourceRef) {
  return {
    id: sourceRef.id,
    kind: sourceRef.kind,
    location: sourceRef.location,
    status: sourceRef.status,
    ...(sourceRef.verifiedAt === undefined ? {} : { verifiedAt: sourceRef.verifiedAt }),
    ...(sourceRef.contentHash === undefined ? {} : { contentHash: sourceRef.contentHash }),
    ...(sourceRef.summary === undefined ? {} : { summary: sourceRef.summary }),
  };
}

function recipeIdFromDocument(document: MainlineSearchDocument): string {
  if (document.kind !== "recipe") {
    return "";
  }
  if (document.id.startsWith("recipe:")) {
    return document.id.slice("recipe:".length);
  }
  return typeof document.metadata?.recipeId === "string" ? document.metadata.recipeId : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.map(optionalString));
}

function optionalSearchKinds(value: unknown): MainlineSearchDocumentKind[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const kinds = value.map(optionalString);
  if (
    kinds.some((kind) => !kind || !SEARCH_DOCUMENT_KINDS.has(kind as MainlineSearchDocumentKind))
  ) {
    return undefined;
  }
  return uniqueStrings(kinds) as MainlineSearchDocumentKind[];
}

function boundedLimit(value: unknown, fallback: number, max: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return Math.min(value, max);
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].sort();
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
