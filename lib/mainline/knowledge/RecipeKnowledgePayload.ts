export interface RecipeKnowledgePayload {
  readonly schemaVersion: 1;
  readonly classification: RecipeKnowledgeClassification;
  readonly delivery: RecipeKnowledgeDelivery;
  readonly body: RecipeKnowledgeBody;
  readonly relations: RecipeKnowledgeRelations;
  readonly constraints: RecipeKnowledgeConstraints;
  readonly reasoning: RecipeKnowledgeReasoning;
  readonly quality: RecipeKnowledgeQuality;
  readonly usage: RecipeKnowledgeUsageStats;
  readonly governance: RecipeKnowledgeGovernance;
  readonly source: RecipeKnowledgeSource;
  readonly headers: RecipeKnowledgeHeaders;
  readonly ai: RecipeKnowledgeAiNotes;
}

export interface RecipeKnowledgeClassification {
  /** 主要适用语言，用于搜索过滤、交付渲染和 Guard 规则筛选。 */
  readonly language?: string | undefined;
  /** 人类维护时的业务分组，不决定实体类型。 */
  readonly category?: string | undefined;
  /** 旧体系里的细粒度知识类型，保留给 AI 提交和迁移去重。 */
  readonly knowledgeType?: string | undefined;
  /** 知识使用难度，服务审核和注入排序。 */
  readonly complexity?: string | undefined;
  /** 适用范围：project/module/universal 等。 */
  readonly scope?: string | undefined;
  readonly difficulty?: string | null | undefined;
  readonly moduleName?: string | undefined;
}

export interface RecipeKnowledgeDelivery {
  /** 可记忆的召回触发词，适合 @xxx 或短语，不等同于适用条件。 */
  readonly trigger?: string | undefined;
  /** 搜索/prime 时的主题提示，帮助 AI 在相近 Recipe 中定位语境。 */
  readonly topicHint?: string | undefined;
  /** 适用条件：什么时候应该考虑这条 Recipe。 */
  readonly whenClause?: string | undefined;
  /** 正向交付动作：应该怎么做，是注入给 AI 的核心行动指南。 */
  readonly doClause?: string | undefined;
  /** 反向交付约束：不要做什么，用于避免错误实现或过度泛化。 */
  readonly dontClause?: string | undefined;
  /** 最小关键代码/接口片段，帮助 AI 快速落地，而不是完整源码归档。 */
  readonly coreCode?: string | undefined;
  /** 更完整的人类/AI 使用说明，可包含步骤、注意事项、上下文。 */
  readonly usageGuide?: string | undefined;
}

export interface RecipeKnowledgeBody {
  readonly pattern?: string | undefined;
  readonly markdown?: string | undefined;
  readonly rationale?: string | undefined;
  readonly steps: readonly RecipeKnowledgeStep[];
  readonly codeChanges: readonly RecipeKnowledgeCodeChange[];
  readonly verification?: Record<string, unknown> | null | undefined;
}

export interface RecipeKnowledgeStep {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly code?: string | undefined;
}

export interface RecipeKnowledgeCodeChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly explanation: string;
}

export interface RecipeKnowledgeRelations {
  readonly buckets: Record<string, readonly RecipeKnowledgeRelationEntry[]>;
}

export interface RecipeKnowledgeRelationEntry {
  readonly target: string;
  readonly description?: string | undefined;
}

export interface RecipeKnowledgeConstraints {
  readonly guards: readonly Record<string, unknown>[];
  readonly boundaries: readonly string[];
  readonly preconditions: readonly string[];
  readonly sideEffects: readonly string[];
}

export interface RecipeKnowledgeReasoning {
  readonly whyStandard?: string | undefined;
  readonly sources: readonly string[];
  readonly confidence?: number | undefined;
  readonly qualitySignals: Record<string, unknown>;
  readonly alternatives: readonly string[];
}

export interface RecipeKnowledgeQuality {
  readonly completeness?: number | undefined;
  readonly adaptation?: number | undefined;
  readonly documentation?: number | undefined;
  readonly overall?: number | undefined;
  readonly grade?: string | undefined;
}

export interface RecipeKnowledgeUsageStats {
  readonly views?: number | undefined;
  readonly adoptions?: number | undefined;
  readonly applications?: number | undefined;
  readonly guardHits?: number | undefined;
  readonly searchHits?: number | undefined;
  readonly authority?: number | undefined;
  readonly lastHitAt?: number | null | undefined;
  readonly lastSearchedAt?: number | null | undefined;
  readonly lastGuardHitAt?: number | null | undefined;
  readonly hitsLast30d?: number | undefined;
  readonly hitsLast90d?: number | undefined;
  readonly searchHitsLast30d?: number | undefined;
  readonly version?: number | undefined;
  readonly ruleFalsePositiveRate?: number | null | undefined;
}

export interface RecipeKnowledgeGovernance {
  readonly lifecycle?: string | undefined;
  readonly lifecycleHistory: readonly Record<string, unknown>[];
  readonly autoApprovable?: boolean | undefined;
  readonly stagingDeadline?: number | null | undefined;
  readonly reviewedBy?: string | null | undefined;
  readonly reviewedAt?: number | null | undefined;
  readonly rejectionReason?: string | null | undefined;
  readonly createdBy?: string | undefined;
  readonly createdAt?: number | undefined;
  readonly publishedAt?: number | null | undefined;
  readonly publishedBy?: string | null | undefined;
}

export interface RecipeKnowledgeSource {
  readonly source?: string | undefined;
  readonly sourceFile?: string | null | undefined;
  readonly sourceCandidateId?: string | null | undefined;
  readonly contentHash?: string | undefined;
}

export interface RecipeKnowledgeHeaders {
  readonly headers: readonly string[];
  readonly headerPaths: readonly string[];
  readonly includeHeaders?: boolean | undefined;
}

export interface RecipeKnowledgeAiNotes {
  readonly agentNotes?: string | null | undefined;
  readonly aiInsight?: string | null | undefined;
}

/**
 * RecipeKnowledgePayload 是新主线受管理的知识字段结构。
 * 它承接旧 KnowledgeEntry 的业务字段，但不把这些字段铺到 Recipe 一等索引模型上。
 */
export function createRecipeKnowledgePayload(
  snapshot: Record<string, unknown>,
): RecipeKnowledgePayload {
  const content = recordValue(snapshot.content);
  const relations = recordValue(snapshot.relations);
  const constraints = recordValue(snapshot.constraints);
  const reasoning = recordValue(snapshot.reasoning);
  const quality = recordValue(snapshot.quality);
  const stats = recordValue(snapshot.stats);

  return {
    schemaVersion: 1,
    classification: compactRecord({
      language: stringValue(snapshot.language),
      category: stringValue(snapshot.category),
      knowledgeType: stringValue(snapshot.knowledgeType),
      complexity: stringValue(snapshot.complexity),
      scope: stringValue(snapshot.scope),
      difficulty: nullableString(snapshot.difficulty),
      moduleName: stringValue(snapshot.moduleName),
    }),
    delivery: compactRecord({
      trigger: stringValue(snapshot.trigger),
      topicHint: stringValue(snapshot.topicHint),
      whenClause: stringValue(snapshot.whenClause),
      doClause: stringValue(snapshot.doClause),
      dontClause: stringValue(snapshot.dontClause),
      coreCode: stringValue(snapshot.coreCode),
      usageGuide: stringValue(snapshot.usageGuide),
    }),
    body: {
      ...compactRecord({
        pattern: stringValue(content.pattern),
        markdown: stringValue(content.markdown),
        rationale: stringValue(content.rationale),
        verification: recordOrNull(content.verification),
      }),
      steps: objectArray(content.steps),
      codeChanges: objectArray(content.codeChanges).map((change) => ({
        file: stringValue(change.file) ?? "",
        before: stringValue(change.before) ?? "",
        after: stringValue(change.after) ?? "",
        explanation: stringValue(change.explanation) ?? "",
      })),
    },
    relations: {
      buckets: relationBuckets(relations),
    },
    constraints: {
      guards: objectArray(constraints.guards),
      boundaries: stringList(constraints.boundaries),
      preconditions: stringList(constraints.preconditions),
      sideEffects: stringList(constraints.sideEffects),
    },
    reasoning: {
      ...compactRecord({
        whyStandard: stringValue(reasoning.whyStandard),
        confidence: numberValue(reasoning.confidence),
      }),
      sources: stringList(reasoning.sources),
      qualitySignals: recordValue(reasoning.qualitySignals),
      alternatives: stringList(reasoning.alternatives),
    },
    quality: compactRecord({
      completeness: numberValue(quality.completeness),
      adaptation: numberValue(quality.adaptation),
      documentation: numberValue(quality.documentation),
      overall: numberValue(quality.overall),
      grade: stringValue(quality.grade),
    }),
    usage: compactRecord({
      views: numberValue(stats.views),
      adoptions: numberValue(stats.adoptions),
      applications: numberValue(stats.applications),
      guardHits: numberValue(stats.guardHits),
      searchHits: numberValue(stats.searchHits),
      authority: numberValue(stats.authority),
      lastHitAt: nullableNumber(stats.lastHitAt),
      lastSearchedAt: nullableNumber(stats.lastSearchedAt),
      lastGuardHitAt: nullableNumber(stats.lastGuardHitAt),
      hitsLast30d: numberValue(stats.hitsLast30d),
      hitsLast90d: numberValue(stats.hitsLast90d),
      searchHitsLast30d: numberValue(stats.searchHitsLast30d),
      version: numberValue(stats.version),
      ruleFalsePositiveRate: nullableNumber(stats.ruleFalsePositiveRate),
    }),
    governance: {
      ...compactRecord({
        lifecycle: stringValue(snapshot.lifecycle),
        autoApprovable: booleanValue(snapshot.autoApprovable),
        stagingDeadline: nullableNumber(snapshot.stagingDeadline),
        reviewedBy: nullableString(snapshot.reviewedBy),
        reviewedAt: nullableNumber(snapshot.reviewedAt),
        rejectionReason: nullableString(snapshot.rejectionReason),
        createdBy: stringValue(snapshot.createdBy),
        createdAt: numberValue(snapshot.createdAt),
        publishedAt: nullableNumber(snapshot.publishedAt),
        publishedBy: nullableString(snapshot.publishedBy),
      }),
      lifecycleHistory: objectArray(snapshot.lifecycleHistory),
    },
    source: compactRecord({
      source: stringValue(snapshot.source),
      sourceFile: nullableString(snapshot.sourceFile),
      sourceCandidateId: nullableString(snapshot.sourceCandidateId),
      contentHash: stringValue(snapshot.contentHash),
    }),
    headers: {
      headers: stringList(snapshot.headers),
      headerPaths: stringList(snapshot.headerPaths),
      includeHeaders: booleanValue(snapshot.includeHeaders),
    },
    ai: compactRecord({
      agentNotes: nullableString(snapshot.agentNotes),
      aiInsight: nullableString(snapshot.aiInsight),
    }),
  };
}

function relationBuckets(
  relations: Record<string, unknown>,
): Record<string, RecipeKnowledgeRelationEntry[]> {
  const buckets: Record<string, RecipeKnowledgeRelationEntry[]> = {};
  for (const [bucket, rawEntries] of Object.entries(relations)) {
    const entries = Array.isArray(rawEntries) ? rawEntries : [];
    const normalized = entries.flatMap((entry) => {
      if (typeof entry === "string") {
        return entry.trim() ? [{ target: entry.trim() }] : [];
      }
      if (!isRecord(entry)) {
        return [];
      }
      const target = stringValue(entry.target);
      if (!target) {
        return [];
      }
      return [
        compactRecord({
          target,
          description: stringValue(entry.description),
        }),
      ];
    });
    if (normalized.length > 0) {
      buckets[bucket] = normalized;
    }
  }
  return Object.fromEntries(
    Object.entries(buckets).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function objectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => ({ ...entry }));
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

function recordOrNull(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) {
    return null;
  }
  return isRecord(value) ? { ...value } : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function compactRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null | undefined {
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

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return numberValue(value);
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
