import type { RecipeInput, RecipeKind, RecipeStatus } from "./Recipe.js";
import {
  createRecipeKnowledgePayload,
  type RecipeKnowledgePayload,
} from "./RecipeKnowledgePayload.js";

export interface RecipeSubmission {
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly trigger?: string | undefined;
  readonly dimensionIds?: readonly string[] | undefined;
  readonly dimensionId?: string | undefined;
  readonly tags?: readonly string[] | string | undefined;
  readonly sourceRefIds?: readonly string[] | string | undefined;
  readonly sourceRefs?: readonly string[] | string | undefined;
  readonly confidence?: number | undefined;
  readonly updatedAt?: number | string | undefined;
  readonly knowledge?: Partial<RecipeKnowledgePayload> | undefined;
  readonly content?: Record<string, unknown> | undefined;
  readonly reasoning?: Record<string, unknown> | undefined;
  readonly relations?: Record<string, unknown> | undefined;
  readonly constraints?: Record<string, unknown> | undefined;
  readonly quality?: Record<string, unknown> | undefined;
  readonly stats?: Record<string, unknown> | undefined;
  readonly [key: string]: unknown;
}

export interface NormalizeRecipeSubmissionOptions {
  readonly id?: string | undefined;
  readonly status?: RecipeStatus | undefined;
  readonly defaultKind?: RecipeKind | undefined;
  readonly updatedAt?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

const RECIPE_KIND_ALIASES: Record<string, RecipeKind> = {
  "anti-pattern": "risk",
  architecture: "pattern",
  "best-practice": "convention",
  "boundary-constraint": "guard-rule",
  "call-chain": "fact",
  "code-pattern": "pattern",
  "code-relation": "fact",
  "code-standard": "convention",
  "code-style": "convention",
  convention: "convention",
  "data-flow": "fact",
  "dev-document": "fact",
  fact: "fact",
  guard: "guard-rule",
  "guard-rule": "guard-rule",
  inheritance: "fact",
  "module-dependency": "fact",
  pattern: "pattern",
  rule: "guard-rule",
  risk: "risk",
  solution: "workflow",
  workflow: "workflow",
};

const RECIPE_STATUS_ALIASES: Record<string, RecipeStatus> = {
  active: "active",
  candidate: "candidate",
  decaying: "stale",
  deprecated: "superseded",
  evolving: "active",
  pending: "candidate",
  rejected: "rejected",
  staging: "candidate",
  stale: "stale",
  superseded: "superseded",
};

/**
 * 归一化 AI/人工提交的 Recipe。
 * 输入可以是推荐的嵌套 knowledge 形态，也可以是旧工具使用的扁平字段形态。
 */
export function normalizeRecipeSubmissionToInput(
  submission: RecipeSubmission,
  options: NormalizeRecipeSubmissionOptions = {},
): RecipeInput {
  const snapshot = submissionSnapshot(submission);
  const knowledge = mergeKnowledgePayload(
    createRecipeKnowledgePayload(snapshot),
    submission.knowledge,
  );
  const confidence =
    numberValue(submission.confidence) ??
    numberValue(knowledge.reasoning.confidence) ??
    numberValue(knowledge.quality.overall) ??
    0;

  return {
    id: requiredString(options.id ?? submission.id, "recipeSubmission.id"),
    title: requiredString(submission.title, "recipeSubmission.title"),
    kind: normalizeRecipeKind(submission.kind ?? snapshot.knowledgeType, options.defaultKind),
    status: normalizeRecipeStatus(submission.status, options.status),
    summary: firstString(submission.summary, submission.description, snapshot.doClause) ?? "",
    trigger: firstString(submission.trigger, knowledge.delivery.trigger),
    dimensionIds: uniqueStrings([
      ...stringList(submission.dimensionIds),
      ...stringList(submission.dimensionId),
      ...stringList(snapshot.dimensionId),
    ]),
    tags: stringList(submission.tags),
    sourceRefIds: uniqueStrings([
      ...stringList(submission.sourceRefIds),
      ...stringList(submission.sourceRefs),
      ...stringList(snapshot.sourceFile),
    ]),
    confidence,
    updatedAt: epochSeconds(submission.updatedAt) ?? options.updatedAt,
    knowledge,
    metadata: {
      ...options.metadata,
      ingestion: {
        sourceShape: submission.knowledge ? "managed-knowledge" : "flat-compatible",
      },
    },
  };
}

function submissionSnapshot(submission: RecipeSubmission): Record<string, unknown> {
  const knowledge = recordValue(submission.knowledge);
  const classification = recordValue(knowledge.classification);
  const delivery = recordValue(knowledge.delivery);
  const body = recordValue(knowledge.body);
  const reasoning = recordValue(knowledge.reasoning);
  const relations = recordValue(knowledge.relations);
  const constraints = recordValue(knowledge.constraints);
  const quality = recordValue(knowledge.quality);
  const usage = recordValue(knowledge.usage);
  const governance = recordValue(knowledge.governance);
  const source = recordValue(knowledge.source);
  const headers = recordValue(knowledge.headers);
  const ai = recordValue(knowledge.ai);

  return {
    ...submission,
    language: submission.language ?? classification.language,
    category: submission.category ?? classification.category,
    knowledgeType: submission.knowledgeType ?? classification.knowledgeType,
    complexity: submission.complexity ?? classification.complexity,
    scope: submission.scope ?? classification.scope,
    difficulty: submission.difficulty ?? classification.difficulty,
    moduleName: submission.moduleName ?? classification.moduleName,
    trigger: submission.trigger ?? delivery.trigger,
    topicHint: submission.topicHint ?? delivery.topicHint,
    whenClause: submission.whenClause ?? delivery.whenClause,
    doClause: submission.doClause ?? delivery.doClause,
    dontClause: submission.dontClause ?? delivery.dontClause,
    coreCode: submission.coreCode ?? delivery.coreCode,
    usageGuide: submission.usageGuide ?? delivery.usageGuide,
    content: {
      ...recordValue(submission.content),
      ...body,
      pattern: recordValue(submission.content).pattern ?? submission.code ?? body.pattern,
      rationale:
        recordValue(submission.content).rationale ?? submission.rationale ?? body.rationale,
    },
    relations: submission.relations ?? relations.buckets ?? relations,
    constraints: submission.constraints ?? constraints,
    reasoning: submission.reasoning ?? reasoning,
    quality: submission.quality ?? quality,
    stats: submission.stats ?? usage,
    lifecycle: governance.lifecycle,
    lifecycleHistory: governance.lifecycleHistory,
    autoApprovable: governance.autoApprovable,
    stagingDeadline: governance.stagingDeadline,
    source: submission.source ?? source.source,
    sourceFile: submission.sourceFile ?? source.sourceFile,
    sourceCandidateId: submission.sourceCandidateId ?? source.sourceCandidateId,
    contentHash: source.contentHash,
    headers: submission.headers ?? headers.headers,
    headerPaths: submission.headerPaths ?? headers.headerPaths,
    includeHeaders: submission.includeHeaders ?? headers.includeHeaders,
    agentNotes: submission.agentNotes ?? ai.agentNotes,
    aiInsight: submission.aiInsight ?? ai.aiInsight,
  };
}

function mergeKnowledgePayload(
  base: RecipeKnowledgePayload,
  override: Partial<RecipeKnowledgePayload> | undefined,
): RecipeKnowledgePayload {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    classification: { ...base.classification, ...override.classification },
    delivery: { ...base.delivery, ...override.delivery },
    body: { ...base.body, ...override.body },
    relations: { ...base.relations, ...override.relations },
    constraints: { ...base.constraints, ...override.constraints },
    reasoning: { ...base.reasoning, ...override.reasoning },
    quality: { ...base.quality, ...override.quality },
    usage: { ...base.usage, ...override.usage },
    governance: { ...base.governance, ...override.governance },
    source: { ...base.source, ...override.source },
    headers: { ...base.headers, ...override.headers },
    ai: { ...base.ai, ...override.ai },
  };
}

function normalizeRecipeKind(value: unknown, fallback = "pattern" as RecipeKind): RecipeKind {
  return RECIPE_KIND_ALIASES[normalizeKey(value)] ?? fallback;
}

function normalizeRecipeStatus(
  value: unknown,
  fallback = "candidate" as RecipeStatus,
): RecipeStatus {
  return RECIPE_STATUS_ALIASES[normalizeKey(value)] ?? fallback;
}

function requiredString(value: unknown, fieldName: string): string {
  const text = firstString(value);
  if (!text) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return text;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return stringList(parsed);
      }
    } catch {
      return [trimmed];
    }
  }
  return uniqueStrings(trimmed.split(","));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function epochSeconds(value: unknown): number | undefined {
  const number = numberValue(value);
  if (number !== undefined) {
    return Math.floor(number > 10_000_000_000 ? number / 1000 : number);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
