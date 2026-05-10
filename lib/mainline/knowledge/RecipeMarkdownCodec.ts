import { createRequire } from "node:module";
import { createRecipe, type Recipe, type RecipeInput } from "./Recipe.js";
import type { RecipeKnowledgePayload } from "./RecipeKnowledgePayload.js";
import {
  type NormalizeRecipeSubmissionOptions,
  normalizeRecipeSubmissionToInput,
  type RecipeSubmission,
} from "./RecipeSubmission.js";

interface YamlCodec {
  dump(value: unknown, options?: Record<string, unknown>): string;
  load(value: string): unknown;
}

const yaml = loadYamlCodec();

export interface RecipeMarkdownParseResult {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
  readonly submission: RecipeSubmission;
}

const MANAGED_FIELD_LABELS: Record<string, string> = {
  summary: "Summary",
  "knowledge.delivery.whenClause": "When",
  "knowledge.delivery.doClause": "Do",
  "knowledge.delivery.dontClause": "Don't",
  "knowledge.delivery.coreCode": "Core Code",
  "knowledge.delivery.usageGuide": "Usage Guide",
  "knowledge.body.markdown": "Body Markdown",
  "knowledge.body.rationale": "Rationale",
  "knowledge.body.pattern": "Pattern",
};

/**
 * RecipeMarkdownCodec 是统一 Recipe 实体的人类可读存储层。
 * Frontmatter 保存完整 managed knowledge 和旧字段镜像，正文只暴露最常编辑的交付字段；
 * 解析时正文托管段会覆盖 frontmatter，最后仍回到 RecipeSubmission 归一化入口。
 */
export class RecipeMarkdownCodec {
  toMarkdown(recipe: Recipe): string {
    const frontmatter = recipeFrontmatter(recipe);
    const body = recipeBody(recipe);
    const serializedFrontmatter = yaml.dump(frontmatter, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });

    return `${["---", serializedFrontmatter.trimEnd(), "---", "", body].join("\n").trimEnd()}\n`;
  }

  parse(markdown: string): RecipeMarkdownParseResult {
    const { frontmatter, body } = splitRecipeMarkdown(markdown);
    const submission = submissionFromFrontmatter(frontmatter);
    applyManagedSections(submission, extractManagedSections(body));

    return {
      frontmatter,
      body,
      submission,
    };
  }

  toSubmission(markdown: string): RecipeSubmission {
    return this.parse(markdown).submission;
  }

  toRecipeInput(markdown: string, options: NormalizeRecipeSubmissionOptions = {}): RecipeInput {
    const parsed = this.parse(markdown);
    return normalizeRecipeSubmissionToInput(parsed.submission, {
      ...options,
      metadata: mergeRecords(recordValue(parsed.frontmatter.metadata), options.metadata),
    });
  }

  toRecipe(markdown: string, options: NormalizeRecipeSubmissionOptions = {}): Recipe {
    return createRecipe(this.toRecipeInput(markdown, options));
  }
}

function recipeFrontmatter(recipe: Recipe): Record<string, unknown> {
  const knowledge = recipe.knowledge;
  const legacyFull = recordValue(recordValue(recipe.metadata?.legacyKnowledgeEntry).full);
  const base = compactDeep({
    schemaVersion: 1,
    id: recipe.id,
    title: recipe.title,
    kind: recipe.kind,
    status: recipe.status,
    summary: recipe.summary,
    trigger: recipe.trigger,
    dimensionIds: recipe.dimensionIds,
    tags: recipe.tags,
    sourceRefIds: recipe.sourceRefIds,
    confidence: recipe.confidence,
    updatedAt: recipe.updatedAt,
    knowledge,
    metadata: recipe.metadata,
  });

  return compactDeep({
    ...base,
    ...legacyMirrorFields(knowledge, legacyFull),
  });
}

function legacyMirrorFields(
  knowledge: RecipeKnowledgePayload | undefined,
  legacyFull: Record<string, unknown>,
): Record<string, unknown> {
  return {
    language: firstValue(knowledge?.classification.language, legacyFull.language),
    dimensionId: legacyFull.dimensionId,
    category: firstValue(knowledge?.classification.category, legacyFull.category),
    knowledgeType: firstValue(knowledge?.classification.knowledgeType, legacyFull.knowledgeType),
    complexity: firstValue(knowledge?.classification.complexity, legacyFull.complexity),
    scope: firstValue(knowledge?.classification.scope, legacyFull.scope),
    difficulty: firstValue(knowledge?.classification.difficulty, legacyFull.difficulty),
    moduleName: firstValue(knowledge?.classification.moduleName, legacyFull.moduleName),
    topicHint: firstValue(knowledge?.delivery.topicHint, legacyFull.topicHint),
    whenClause: firstValue(knowledge?.delivery.whenClause, legacyFull.whenClause),
    doClause: firstValue(knowledge?.delivery.doClause, legacyFull.doClause),
    dontClause: firstValue(knowledge?.delivery.dontClause, legacyFull.dontClause),
    coreCode: firstValue(knowledge?.delivery.coreCode, legacyFull.coreCode),
    usageGuide: firstValue(knowledge?.delivery.usageGuide, legacyFull.usageGuide),
    source: firstValue(knowledge?.source.source, legacyFull.source),
    sourceFile: firstValue(knowledge?.source.sourceFile, legacyFull.sourceFile),
    sourceCandidateId: firstValue(
      knowledge?.source.sourceCandidateId,
      legacyFull.sourceCandidateId,
    ),
    contentHash: firstValue(
      knowledge?.source.contentHash,
      legacyFull.contentHash,
      legacyFull._contentHash,
    ),
    headers: nonEmptyArray(knowledge?.headers.headers) ?? legacyFull.headers,
    headerPaths: nonEmptyArray(knowledge?.headers.headerPaths) ?? legacyFull.headerPaths,
    includeHeaders: firstValue(knowledge?.headers.includeHeaders, legacyFull.includeHeaders),
    autoApprovable: firstValue(knowledge?.governance.autoApprovable, legacyFull.autoApprovable),
    stagingDeadline: firstValue(knowledge?.governance.stagingDeadline, legacyFull.stagingDeadline),
    createdBy: firstValue(knowledge?.governance.createdBy, legacyFull.createdBy),
    createdAt: firstValue(knowledge?.governance.createdAt, legacyFull.createdAt),
    publishedAt: firstValue(knowledge?.governance.publishedAt, legacyFull.publishedAt),
    publishedBy: firstValue(knowledge?.governance.publishedBy, legacyFull.publishedBy),
    reviewedBy: firstValue(knowledge?.governance.reviewedBy, legacyFull.reviewedBy),
    reviewedAt: firstValue(knowledge?.governance.reviewedAt, legacyFull.reviewedAt),
    rejectionReason: firstValue(knowledge?.governance.rejectionReason, legacyFull.rejectionReason),
    _content: firstValue(knowledge?.body, legacyFull.content),
    _relations: firstValue(knowledge?.relations.buckets, legacyFull.relations),
    _constraints: firstValue(knowledge?.constraints, legacyFull.constraints),
    _reasoning: firstValue(knowledge?.reasoning, legacyFull.reasoning),
    _quality: firstValue(knowledge?.quality, legacyFull.quality),
    _stats: firstValue(knowledge?.usage, legacyFull.stats),
    _lifecycleHistory: firstValue(
      knowledge?.governance.lifecycleHistory,
      legacyFull.lifecycleHistory,
    ),
    _agentNotes: firstValue(knowledge?.ai.agentNotes, legacyFull.agentNotes),
    _aiInsight: firstValue(knowledge?.ai.aiInsight, legacyFull.aiInsight),
  };
}

function recipeBody(recipe: Recipe): string {
  const knowledge = recipe.knowledge;
  const sections = [
    managedSection("summary", recipe.summary),
    managedSection("knowledge.delivery.whenClause", knowledge?.delivery.whenClause),
    managedSection("knowledge.delivery.doClause", knowledge?.delivery.doClause),
    managedSection("knowledge.delivery.dontClause", knowledge?.delivery.dontClause),
    managedSection("knowledge.delivery.coreCode", knowledge?.delivery.coreCode),
    managedSection("knowledge.delivery.usageGuide", knowledge?.delivery.usageGuide),
    managedSection("knowledge.body.markdown", knowledge?.body.markdown),
    managedSection("knowledge.body.rationale", knowledge?.body.rationale),
    managedSection("knowledge.body.pattern", knowledge?.body.pattern),
  ].filter((section): section is string => section !== null);

  return [`# ${recipe.title}`, ...sections].join("\n\n").trimEnd();
}

function managedSection(fieldPath: string, value: unknown): string | null {
  const text = stringValue(value);
  if (!text) {
    return null;
  }
  return [
    `## ${MANAGED_FIELD_LABELS[fieldPath] ?? fieldPath}`,
    `<!-- alembic:field ${fieldPath} -->`,
    text,
    "<!-- /alembic:field -->",
  ].join("\n");
}

function splitRecipeMarkdown(markdown: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const rawFrontmatter = normalized.slice(4, end);
  const parsed = yaml.load(rawFrontmatter);
  const body = normalized
    .slice(end + 4)
    .replace(/^\n/, "")
    .trim();
  return {
    frontmatter: recordValue(parsed),
    body,
  };
}

function submissionFromFrontmatter(frontmatter: Record<string, unknown>): RecipeSubmission {
  const knowledge = mergeRecords(
    recordValue(frontmatter.knowledge),
    knowledgePatchFromLegacyMirrors(frontmatter),
  ) as Partial<RecipeKnowledgePayload>;

  return {
    ...unknownFrontmatterFields(frontmatter),
    id: stringValue(frontmatter.id),
    title: stringValue(frontmatter.title),
    kind: stringValue(frontmatter.kind),
    status: stringValue(frontmatter.status ?? frontmatter.lifecycle),
    summary: stringValue(frontmatter.summary),
    trigger: stringValue(frontmatter.trigger),
    dimensionIds: stringList(frontmatter.dimensionIds),
    dimensionId: stringValue(frontmatter.dimensionId),
    tags: stringList(frontmatter.tags),
    sourceRefIds: stringList(frontmatter.sourceRefIds),
    sourceRefs: stringList(frontmatter.sourceRefs),
    confidence: numberValue(frontmatter.confidence),
    updatedAt: frontmatter.updatedAt as number | string | undefined,
    knowledge,
    content: recordValue(frontmatter._content ?? frontmatter.content),
    relations: recordValue(frontmatter._relations ?? frontmatter.relations),
    constraints: recordValue(frontmatter._constraints ?? frontmatter.constraints),
    reasoning: recordValue(frontmatter._reasoning ?? frontmatter.reasoning),
    quality: recordValue(frontmatter._quality ?? frontmatter.quality),
    stats: recordValue(frontmatter._stats ?? frontmatter.stats),
    agentNotes: stringOrNull(frontmatter._agentNotes ?? frontmatter.agentNotes),
    aiInsight: stringOrNull(frontmatter._aiInsight ?? frontmatter.aiInsight),
  };
}

function knowledgePatchFromLegacyMirrors(
  frontmatter: Record<string, unknown>,
): Record<string, unknown> {
  return compactDeep({
    classification: {
      language: frontmatter.language,
      category: frontmatter.category,
      knowledgeType: frontmatter.knowledgeType ?? legacyKnowledgeTypeFromKind(frontmatter.kind),
      complexity: frontmatter.complexity,
      scope: frontmatter.scope,
      difficulty: frontmatter.difficulty,
      moduleName: frontmatter.moduleName,
    },
    delivery: {
      trigger: frontmatter.trigger,
      topicHint: frontmatter.topicHint,
      whenClause: frontmatter.whenClause,
      doClause: frontmatter.doClause,
      dontClause: frontmatter.dontClause,
      coreCode: frontmatter.coreCode,
      usageGuide: frontmatter.usageGuide,
    },
    body: recordValue(frontmatter._content ?? frontmatter.content),
    relations: {
      buckets: recordValue(frontmatter._relations ?? frontmatter.relations),
    },
    constraints: recordValue(frontmatter._constraints ?? frontmatter.constraints),
    reasoning: recordValue(frontmatter._reasoning ?? frontmatter.reasoning),
    quality: recordValue(frontmatter._quality ?? frontmatter.quality),
    usage: recordValue(frontmatter._stats ?? frontmatter.stats),
    governance: {
      lifecycle: frontmatter.lifecycle,
      lifecycleHistory: frontmatter._lifecycleHistory,
      autoApprovable: frontmatter.autoApprovable,
      stagingDeadline: frontmatter.stagingDeadline,
      reviewedBy: frontmatter.reviewedBy,
      reviewedAt: frontmatter.reviewedAt,
      rejectionReason: frontmatter.rejectionReason,
      createdBy: frontmatter.createdBy,
      createdAt: frontmatter.createdAt,
      publishedAt: frontmatter.publishedAt,
      publishedBy: frontmatter.publishedBy,
    },
    source: {
      source: frontmatter.source,
      sourceFile: frontmatter.sourceFile,
      sourceCandidateId: frontmatter.sourceCandidateId,
      contentHash: firstValue(frontmatter.contentHash, frontmatter._contentHash),
    },
    headers: {
      headers: frontmatter.headers,
      headerPaths: frontmatter.headerPaths,
      includeHeaders: frontmatter.includeHeaders,
    },
    ai: {
      agentNotes: frontmatter._agentNotes ?? frontmatter.agentNotes,
      aiInsight: frontmatter._aiInsight ?? frontmatter.aiInsight,
    },
  });
}

function applyManagedSections(
  submission: RecipeSubmission,
  sections: ReadonlyMap<string, string>,
): void {
  const mutable = submission as RecipeSubmission & {
    knowledge?: Record<string, unknown> | undefined;
    summary?: string | undefined;
  };
  const knowledge = recordValue(mutable.knowledge);

  for (const [fieldPath, value] of sections) {
    if (fieldPath === "summary") {
      mutable.summary = value;
      continue;
    }
    if (fieldPath.startsWith("knowledge.")) {
      setNestedValue(knowledge, fieldPath.slice("knowledge.".length), value);
    }
  }
  mutable.knowledge = knowledge;
}

function extractManagedSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const pattern =
    /<!--\s*alembic:field\s+([A-Za-z0-9_.-]+)\s*-->\n?([\s\S]*?)\n?<!--\s*\/alembic:field\s*-->/g;

  for (const match of body.matchAll(pattern)) {
    const fieldPath = match[1]?.trim();
    const value = match[2]?.trim();
    if (fieldPath && value) {
      sections.set(fieldPath, value);
    }
  }
  return sections;
}

function unknownFrontmatterFields(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const known = new Set([
    "schemaVersion",
    "id",
    "title",
    "kind",
    "status",
    "summary",
    "trigger",
    "dimensionIds",
    "dimensionId",
    "tags",
    "sourceRefIds",
    "sourceRefs",
    "confidence",
    "updatedAt",
    "contentHash",
    "_contentHash",
    "knowledge",
    "metadata",
    "content",
    "relations",
    "constraints",
    "reasoning",
    "quality",
    "stats",
    "_content",
    "_relations",
    "_constraints",
    "_reasoning",
    "_quality",
    "_stats",
    "_agentNotes",
    "_aiInsight",
  ]);
  return Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !known.has(key)));
}

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = recordValue(cursor[part]);
    cursor[part] = next;
    cursor = next;
  }
  const last = parts.at(-1);
  if (last) {
    cursor[last] = value;
  }
}

function mergeRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!right) {
    return { ...left };
  }
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = mergeRecords(merged[key] as Record<string, unknown>, value);
    } else {
      merged[key] = value;
    }
  }
  return compactDeep(merged);
}

function compactDeep(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    if (Array.isArray(entry)) {
      if (entry.length > 0) {
        result[key] = entry.map((item) => (isRecord(item) ? compactDeep(item) : item));
      }
      continue;
    }
    if (isRecord(entry)) {
      const nested = compactDeep(entry);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
      continue;
    }
    if (entry !== "") {
      result[key] = entry;
    }
  }
  return result;
}

function firstValue<T>(...values: readonly T[]): T | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

function nonEmptyArray<T>(value: readonly T[] | undefined): readonly T[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return stringValue(value);
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

function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  if (value.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return stringList(parsed);
      }
    } catch {
      return [value.trim()];
    }
  }
  return uniqueStrings(value.split(","));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyKnowledgeTypeFromKind(kind: unknown): string | undefined {
  const text = stringValue(kind);
  if (!text || ["convention", "pattern", "fact", "risk", "workflow", "guard-rule"].includes(text)) {
    return undefined;
  }
  return text;
}

function loadYamlCodec(): YamlCodec {
  const require = createRequire(import.meta.url);
  try {
    return require("js-yaml") as YamlCodec;
  } catch {
    return jsonFrontmatterCodec;
  }
}

const jsonFrontmatterCodec: YamlCodec = {
  dump(value: unknown): string {
    return JSON.stringify(value, null, 2);
  },
  load(value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return parseFlatYaml(trimmed);
    }
  },
};

function parseFlatYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    result[match[1]] = parseFlatYamlScalar(match[2] ?? "");
  }
  return result;
}

function parseFlatYamlScalar(value: string): unknown {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  if (unquoted === "true") {
    return true;
  }
  if (unquoted === "false") {
    return false;
  }
  const numeric = Number(unquoted);
  return Number.isFinite(numeric) && unquoted.trim() !== "" ? numeric : unquoted;
}
