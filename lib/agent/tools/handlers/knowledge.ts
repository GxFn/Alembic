import type {
  ContextIndexReader,
  RecipeEdge,
  RecipeMarkdownFileIndex,
  SourceRef,
} from "../../../mainline/data/index.js";
import {
  createRecipe,
  type Recipe,
  type RecipeLifecycleRecord,
  RecipeSubmissionPolicy,
} from "../../../mainline/knowledge/index.js";
import type {
  MainlineSearchDocument,
  MainlineSearchDocumentKind,
  MainlineSearchHit,
  MainlineSearchQuery,
} from "../../../mainline/search/index.js";
import type { ToolHandler, ToolHandlerContext, ToolResultEnvelope } from "../types.js";
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
  readonly kind?: string;
  readonly category?: string;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly kinds?: readonly MainlineSearchDocumentKind[];
  readonly limit: number;
  readonly includeContext: boolean;
}

type ManageOperation =
  | "approve"
  | "reject"
  | "publish"
  | "deprecate"
  | "update"
  | "score"
  | "validate"
  | "evolve"
  | "skip_evolution";

const MANAGE_OPERATIONS = new Set<ManageOperation>([
  "approve",
  "reject",
  "publish",
  "deprecate",
  "update",
  "score",
  "validate",
  "evolve",
  "skip_evolution",
]);

type RepositoryManageResult =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: "unavailable" | "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };

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
  const hits = searchIndex.search({ ...query, limit: query.limit ? query.limit * 3 : 30 });
  const filteredHits = hits
    .filter((hit) => matchKnowledgeKind(hit.document, parsed.input.kind))
    .filter((hit) => matchKnowledgeCategory(hit.document, parsed.input.category))
    .slice(0, parsed.input.limit);
  const contextSummary = await buildContextSummary({
    ...(context.dependencies.contextIndex
      ? { contextIndex: context.dependencies.contextIndex }
      : {}),
    hits: filteredHits,
    includeContext: parsed.input.includeContext,
  });

  return toolSuccess(context.descriptor, {
    query,
    filters: {
      ...(parsed.input.kind ? { kind: parsed.input.kind } : {}),
      ...(parsed.input.category ? { category: parsed.input.category } : {}),
    },
    hits: filteredHits.map(formatSearchHit),
    context: contextSummary,
  });
};

export const knowledgeDetailHandler: ToolHandler = async (
  invocation,
  context,
): Promise<ToolResultEnvelope> => {
  const id = parseIdInput(invocation.input, "knowledge.detail");
  if (!id.ok) {
    return toolFailure(context.descriptor, "error", id.error);
  }

  const repositoryRecipe = await context.dependencies.knowledgeRepository?.getById(id.value);
  if (repositoryRecipe) {
    return toolSuccess(context.descriptor, {
      recipe: repositoryRecipe,
      source: "knowledgeRepository",
    });
  }

  const lifecycleRecord = await context.dependencies.knowledgeLifecycleStore?.load(id.value, {
    status: "all",
  });
  const contextIndex = context.dependencies.contextIndex;
  const indexedRecipes = await findRecipesByIds(contextIndex, [id.value]);
  const recipe = lifecycleRecord?.recipe ?? indexedRecipes[0];
  if (!recipe) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "recipe_not_found",
      message: `Recipe not found: ${id.value}`,
    });
  }

  const [recipeFiles, edges, sourceRefs] = contextIndex
    ? await Promise.all([
        contextIndex.findRecipeFilesByRecipeIds([recipe.id]),
        contextIndex.findRecipeEdges([recipe.id]),
        contextIndex.findSourceRefs([recipe.id]),
      ])
    : ([[], [], []] as const);

  return toolSuccess(context.descriptor, {
    recipe: formatRecipe(recipe),
    ...(lifecycleRecord ? { lifecycle: formatLifecycleRecord(lifecycleRecord) } : {}),
    context: {
      recipeFiles: recipeFiles.map(formatRecipeFile),
      edges: edges.map(formatRecipeEdge),
      sourceRefs: sourceRefs.map(formatSourceRef),
    },
  });
};

export const knowledgeSubmitHandler: ToolHandler = async (
  invocation,
  context,
): Promise<ToolResultEnvelope> => {
  if (!isRecord(invocation.input)) {
    return toolFailure(context.descriptor, "error", {
      code: "invalid_input",
      message: "knowledge.submit input must be an object.",
    });
  }

  if (context.dependencies.knowledgeGateway) {
    const submission = normalizeAgentKnowledgeSubmission(invocation.input);
    const result = await context.dependencies.knowledgeGateway.create({
      source: "agent-tool",
      items: [submission],
      options: { userId: "agent" },
    });
    const presented = presentKnowledgeGatewayResult(result);
    if (presented.status === "created" || presented.status === "processed") {
      await rememberSubmission(context, submission);
    }
    return toolSuccess(context.descriptor, presented);
  }

  const lifecycle = context.dependencies.knowledgeLifecycleStore;
  if (!lifecycle) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "knowledge_lifecycle_unavailable",
      message: "knowledge.submit requires knowledgeGateway or knowledgeLifecycleStore.",
    });
  }

  const updatedAt = Math.floor((context.dependencies.now?.() ?? Date.now()) / 1000);
  const submission = normalizeAgentKnowledgeSubmission(invocation.input);
  const id = optionalString(submission.id) ?? candidateId(submission);
  const existing = await lifecycle.list({ status: "all" });
  const policy = new RecipeSubmissionPolicy().evaluate(submission, {
    id,
    status: "candidate",
    updatedAt,
    existingRecipes: existing.map((record) => record.recipe),
    metadata: { source: "agent-tool" },
  });
  if (!policy.accepted || !policy.recipeInput) {
    return toolFailure(context.descriptor, "error", {
      code: "candidate_rejected",
      message: policy.errors.join("; ") || "Recipe submission rejected.",
      details: {
        decision: policy.decision,
        errors: policy.errors,
        warnings: policy.warnings,
        similarRecipes: policy.similarRecipes,
      },
    });
  }

  const recipe = createRecipe({
    ...policy.recipeInput,
    id,
    status: "candidate",
    updatedAt,
  });
  const record = await lifecycle.writeCandidate(recipe, { now: updatedAt, submittedBy: "agent" });
  await rememberSubmission(context, { id, title: recipe.title, kind: recipe.kind });
  return toolSuccess(context.descriptor, {
    status: "candidate_created",
    record: formatLifecycleRecord(record),
    recipe: formatRecipe(record.recipe),
    warnings: policy.warnings,
  });
};

export const knowledgeManageHandler: ToolHandler = async (
  invocation,
  context,
): Promise<ToolResultEnvelope> => {
  const parsed = parseManageInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const repository = context.dependencies.knowledgeRepository;
  if (repository && !isEvolutionOperation(parsed.input.operation)) {
    const result = await runRepositoryManage(repository, parsed.input);
    if (result.ok) {
      return toolSuccess(context.descriptor, result.data);
    }
    if (result.error.code !== "repository_operation_unavailable") {
      return toolFailure(context.descriptor, result.status, result.error);
    }
  }

  const lifecycle = context.dependencies.knowledgeLifecycleStore;
  if (lifecycle && (parsed.input.operation === "publish" || parsed.input.operation === "approve")) {
    const record = await lifecycle.publish(parsed.input.id, { publishedBy: "agent" });
    return toolSuccess(context.descriptor, {
      operation: parsed.input.operation,
      status: record.status,
      record: formatLifecycleRecord(record),
    });
  }
  if (lifecycle && parsed.input.operation === "reject") {
    const record = await lifecycle.reject(parsed.input.id, {
      rejectedBy: "agent",
      ...(parsed.input.reason ? { reason: parsed.input.reason } : {}),
    });
    return toolSuccess(context.descriptor, {
      operation: "reject",
      status: "rejected",
      record: formatLifecycleRecord(record),
    });
  }

  if (
    context.dependencies.evolutionGateway &&
    (parsed.input.operation === "evolve" ||
      parsed.input.operation === "deprecate" ||
      parsed.input.operation === "skip_evolution")
  ) {
    const description = optionalString(parsed.input.data?.description);
    const replacedByRecipeId = optionalString(parsed.input.data?.replacedByRecipeId);
    const result = await context.dependencies.evolutionGateway.submit({
      recipeId: parsed.input.id,
      action:
        parsed.input.operation === "evolve"
          ? "update"
          : parsed.input.operation === "deprecate"
            ? "deprecate"
            : "valid",
      source: "ide-agent",
      confidence: numberValue(parsed.input.data?.confidence) ?? 0.8,
      ...(parsed.input.reason ? { reason: parsed.input.reason } : {}),
      ...(description ? { description } : {}),
      ...(Array.isArray(parsed.input.data?.evidence)
        ? { evidence: parsed.input.data.evidence.filter(isRecord) }
        : {}),
      ...(replacedByRecipeId ? { replacedByRecipeId } : {}),
    });
    return toolSuccess(context.descriptor, {
      operation: parsed.input.operation,
      status: evolutionStatus(parsed.input.operation, result),
      result,
    });
  }

  return toolFailure(context.descriptor, "unavailable", {
    code: "knowledge_manage_unavailable",
    message:
      "knowledge.manage requires knowledgeRepository, knowledgeLifecycleStore, or evolutionGateway for the requested operation.",
    details: { operation: parsed.input.operation, id: parsed.input.id },
  });
};

async function runRepositoryManage(
  repository: NonNullable<ToolHandlerContext["dependencies"]["knowledgeRepository"]>,
  input: {
    readonly operation: ManageOperation;
    readonly id: string;
    readonly reason?: string;
    readonly data?: Record<string, unknown>;
  },
): Promise<RepositoryManageResult> {
  switch (input.operation) {
    case "approve":
      if (!repository.approve) {
        return repositoryOperationUnavailable(input.operation);
      }
      await repository.approve(input.id, input.reason);
      return { ok: true, data: { operation: input.operation, id: input.id, status: "approved" } };
    case "reject":
      if (!repository.reject) {
        return repositoryOperationUnavailable(input.operation);
      }
      await repository.reject(input.id, input.reason);
      return { ok: true, data: { operation: input.operation, id: input.id, status: "rejected" } };
    case "publish":
      if (!repository.publish) {
        return repositoryOperationUnavailable(input.operation);
      }
      await repository.publish(input.id);
      return { ok: true, data: { operation: input.operation, id: input.id, status: "published" } };
    case "update":
      if (!repository.update || !input.data) {
        return repositoryOperationUnavailable(input.operation);
      }
      await repository.update(input.id, input.data);
      return { ok: true, data: { operation: input.operation, id: input.id, status: "updated" } };
    case "score": {
      if (!repository.score) {
        return repositoryOperationUnavailable(input.operation);
      }
      const score = numberValue(input.data?.score) ?? 0;
      await repository.score(input.id, score);
      return {
        ok: true,
        data: { operation: input.operation, id: input.id, status: "scored", score },
      };
    }
    case "validate": {
      if (!repository.validate) {
        return repositoryOperationUnavailable(input.operation);
      }
      const result = await repository.validate(input.id);
      return {
        ok: true,
        data: { operation: input.operation, id: input.id, status: "validated", result },
      };
    }
    case "deprecate":
    case "evolve":
    case "skip_evolution":
      return repositoryOperationUnavailable(input.operation);
  }
}

function repositoryOperationUnavailable(operation: string): RepositoryManageResult {
  return {
    ok: false,
    status: "unavailable" as const,
    error: {
      code: "repository_operation_unavailable",
      message: `knowledgeRepository does not support ${operation}.`,
    },
  };
}

function isEvolutionOperation(operation: ManageOperation): boolean {
  return operation === "evolve" || operation === "deprecate" || operation === "skip_evolution";
}

function presentKnowledgeGatewayResult(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) {
    return { status: "processed", result };
  }
  const created = arrayValue(result.created);
  if (created.length > 0) {
    const first = isRecord(created[0]) ? created[0] : {};
    return {
      status: "created",
      id: optionalString(first.id),
      title: optionalString(first.title),
      result,
    };
  }
  const duplicates = arrayValue(result.duplicates);
  if (duplicates.length > 0) {
    return { status: "duplicate_blocked", duplicates, result };
  }
  const rejected = arrayValue(result.rejected);
  if (rejected.length > 0) {
    return { status: "rejected", rejected, result };
  }
  const blocked = arrayValue(result.blocked);
  if (blocked.length > 0) {
    return { status: "blocked", blocked, result };
  }
  if (optionalString(result.status)) {
    return { status: optionalString(result.status), result };
  }
  return { status: "processed", result };
}

function evolutionStatus(operation: ManageOperation, result: unknown): string {
  const outcome = isRecord(result) ? optionalString(result.outcome) : undefined;
  if (operation === "skip_evolution") {
    return outcome === "verified" ? "evolution_verified" : "evolution_skipped";
  }
  if (operation === "deprecate") {
    return outcome === "immediately-executed" ? "deprecated" : "deprecation_proposed";
  }
  return outcome === "proposal-upgraded" ? "evolution_proposal_upgraded" : "evolution_proposed";
}

function parseManageInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: {
        readonly operation: ManageOperation;
        readonly id: string;
        readonly reason?: string;
        readonly data?: Record<string, unknown>;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "knowledge.manage input must be an object." },
    };
  }
  const operation = optionalString(input.operation);
  const id = optionalString(input.id);
  if (!operation || !MANAGE_OPERATIONS.has(operation as ManageOperation)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: `Invalid knowledge.manage operation: ${operation}` },
    };
  }
  if (!id) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "knowledge.manage requires id." },
    };
  }
  const reason = optionalString(input.reason);
  const data = isRecord(input.data) ? input.data : undefined;
  return {
    ok: true,
    input: {
      operation: operation as ManageOperation,
      id,
      ...(reason ? { reason } : {}),
      ...(data ? { data } : {}),
    },
  };
}

async function rememberSubmission(
  context: ToolHandlerContext,
  item: Record<string, unknown>,
): Promise<void> {
  const title = optionalString(item.title) ?? optionalString(item.id) ?? "knowledge-candidate";
  await context.dependencies.memoryStore?.save({
    key: `submit:${title}`,
    content: JSON.stringify({ title, kind: item.kind ?? "unknown" }),
    tags: ["submission"],
    category: "knowledge",
  });
}

function candidateId(item: Record<string, unknown>): string {
  const title = optionalString(item.title) ?? "agent-knowledge";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "agent-knowledge"}-${shortHash(stableJson(item))}`;
}

function normalizeAgentKnowledgeSubmission(item: Record<string, unknown>): Record<string, unknown> {
  const title = cleanRecipeTitle(optionalString(item.title) ?? "Agent Knowledge Candidate");
  const description =
    optionalString(item.description) ??
    optionalString(item.summary) ??
    optionalString(item.doClause) ??
    title;
  const kind = optionalString(item.kind) ?? optionalString(item.knowledgeType) ?? "pattern";
  const language = optionalString(item.language) ?? "typescript";
  const category = optionalString(item.category) ?? optionalString(item.dimensionId) ?? "agent";
  const trigger = optionalString(item.trigger) ?? optionalString(item.topicHint) ?? title;
  const whenClause = optionalString(item.whenClause) ?? `When working on ${trigger}.`;
  const doClause = optionalString(item.doClause) ?? description;
  const dontClause =
    optionalString(item.dontClause) ?? "Do not apply this Recipe outside the stated trigger.";
  const coreCode = optionalString(item.coreCode) ?? extractCodeBlock(item.content) ?? doClause;
  const content = isRecord(item.content) ? item.content : {};
  const reasoning = isRecord(item.reasoning) ? item.reasoning : {};
  const sourceRefs = uniqueStrings([
    ...optionalStringArray(item.sourceRefIds),
    ...optionalStringArray(item.sourceRefs),
    ...optionalStringArray(reasoning.sources),
    ...optionalStringList(item.sourceFile),
  ]);
  return {
    ...item,
    title,
    description,
    summary: optionalString(item.summary) ?? description,
    kind,
    trigger,
    whenClause,
    doClause,
    dontClause,
    coreCode,
    category,
    headers: optionalStringList(item.headers),
    reasoning: {
      whyStandard:
        optionalString(reasoning.whyStandard) ??
        "Captured by the internal Agent tool layer from concrete project evidence.",
      sources: optionalStringArray(reasoning.sources),
      confidence: numberValue(reasoning.confidence) ?? numberValue(item.confidence) ?? 0.7,
      ...reasoning,
    },
    content: {
      markdown: optionalString(content.markdown) ?? description,
      rationale:
        optionalString(content.rationale) ??
        "This candidate preserves AgentRuntime knowledge for later review and reuse.",
      ...content,
    },
    knowledgeType: optionalString(item.knowledgeType) ?? "code-pattern",
    language,
    usageGuide: optionalString(item.usageGuide) ?? `${whenClause}\n\n${doClause}`,
    ...(sourceRefs.length > 0 ? { sourceRefIds: sourceRefs } : {}),
  };
}

function cleanRecipeTitle(value: string): string {
  return value.replace(/^\s*(recipe|knowledge|candidate)\s*[:：-]\s*/i, "").trim() || value;
}

function extractCodeBlock(content: unknown): string | undefined {
  if (!isRecord(content)) {
    return undefined;
  }
  const markdown = optionalString(content.markdown);
  const match = markdown?.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  return match?.[1]?.trim();
}

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
  const kind = optionalString(record.kind);
  const category = optionalString(record.category);
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
      ...(kind ? { kind } : {}),
      ...(category ? { category } : {}),
      paths,
      symbols,
      ...(kinds ? { kinds } : {}),
      limit: limit ?? 10,
      includeContext,
    },
  };
}

function matchKnowledgeKind(document: MainlineSearchDocument, kind: string | undefined): boolean {
  if (!kind || kind === "all") {
    return true;
  }
  const metadata = document.metadata ?? {};
  if (kind === "recipe") {
    return document.kind === "recipe";
  }
  if (kind === "candidate") {
    return (
      metadata.status === "candidate" ||
      metadata.recipeStatus === "candidate" ||
      metadata.lifecycleStatus === "candidate"
    );
  }
  return document.kind === kind || metadata.recipeKind === kind || metadata.knowledgeType === kind;
}

function matchKnowledgeCategory(
  document: MainlineSearchDocument,
  category: string | undefined,
): boolean {
  if (!category) {
    return true;
  }
  const metadata = document.metadata ?? {};
  return (
    metadata.category === category ||
    metadata.topicHint === category ||
    document.tags?.includes(category) === true
  );
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

function formatRecipe(recipe: Recipe) {
  return {
    id: recipe.id,
    title: recipe.title,
    summary: recipe.summary,
    kind: recipe.kind,
    status: recipe.status,
    tags: [...recipe.tags].sort(),
    sourceRefIds: [...recipe.sourceRefIds].sort(),
    confidence: recipe.confidence,
    trigger: recipe.trigger,
    updatedAt: recipe.updatedAt,
    metadata: recipe.metadata,
  };
}

function formatLifecycleRecord(record: RecipeLifecycleRecord) {
  return {
    id: record.id,
    status: record.status,
    metadata: record.metadata,
    ...(record.file ? { file: formatRecipeFile(record.file) } : {}),
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.map(optionalString));
}

function optionalStringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return optionalStringArray(value);
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
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

function shortHash(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16);
}

function stableJson(value: unknown): string {
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = value[key];
  }
  return JSON.stringify(output);
}

async function findRecipesByIds(
  contextIndex: ContextIndexReader | undefined,
  ids: readonly string[],
): Promise<Recipe[]> {
  const reader = contextIndex as
    | (ContextIndexReader & {
        findRecipesByIds?: (recipeIds: readonly string[]) => Promise<Recipe[]>;
      })
    | undefined;
  return reader?.findRecipesByIds ? reader.findRecipesByIds(ids) : [];
}

function parseIdInput(
  input: unknown,
  toolName: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: `${toolName} input must be an object.` },
    };
  }
  const id = optionalString(input.id);
  if (!id) {
    return {
      ok: false,
      error: { code: "invalid_input", message: `${toolName} requires id.` },
    };
  }
  return { ok: true, value: id };
}
