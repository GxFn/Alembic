import path from 'node:path';
import type { RecipeSemanticRegionClass } from '@alembic/core/vector';
import type { SearchModeLabel } from '../../shared/semantic-taxonomy.js';
import type {
  IntentEvidence,
  IntentScoreBreakdown,
  RelationEvidence,
  TopAnchorMatch,
} from './IntentEvidence.js';
import type { IntentSearchPlan } from './IntentSearchPlan.js';

export type PrimeInjectionStatus =
  | 'ready'
  | 'candidate'
  | 'needs-confirmation'
  | 'degraded'
  | 'empty';
export type PrimeSelectedKnowledgeStatus = 'selected' | 'candidate';

export interface PrimeSelectedKnowledge {
  evidenceRefs: string[];
  injectionStatus: PrimeSelectedKnowledgeStatus;
  itemId: string;
  kind?: string;
  knowledgeType?: string;
  matchedRegionClasses?: RecipeSemanticRegionClass[];
  matchedRegions?: PrimeMatchedRegionEvidence[];
  rank: number;
  score: number | null;
  scoreBreakdown?: IntentScoreBreakdown;
  sourceRefs: string[];
  title?: string;
  trigger?: string;
  whySelected: string[];
}

export interface PrimeMatchedRegionEvidence {
  regionClass: RecipeSemanticRegionClass;
  score: number;
  snippet: string;
  sourceRefs: string[];
  sourceRefsBridge?: string;
  vectorId: string;
}

export interface PrimeResidentRegionRecipeEvidence {
  matchedRegionClasses: RecipeSemanticRegionClass[];
  matchedRegions: PrimeMatchedRegionEvidence[];
  recipeId: string;
  score: number;
  sourceRefs: string[];
  title?: string;
  trigger?: string;
}

export interface PrimeResidentRegionRetrieval {
  attempted: boolean;
  degradedReasons: string[];
  metadataOnlyFallback: {
    attempted: boolean;
    reason?: string;
    used: boolean;
  };
  queryCount: number;
  regionHitCount: number;
  route: 'resident-vector-recipe-semantic-region';
  selectedRecipes: PrimeResidentRegionRecipeEvidence[];
  used: boolean;
  vectorAvailable: boolean;
  wholeEntryOnlyRejectedCount: number;
}

export interface PrimeInjectionOmission {
  detail?: string;
  itemId?: string;
  reason: string;
  source: string;
}

export interface PrimeInjectionPackage {
  decisionRegister: {
    acceptedDecisionRefs: string[];
    auditExcludedCount: number;
    available: boolean;
    defaultLifecycle: 'active-effective-only';
    excludedStatuses: string[];
    route: '/api/v1/decision-register/searchable';
    source: 'alembic-decision-register';
    vectorAdmission: 'accepted-only';
  };
  feedback: {
    observeOnly: true;
    recorder: 'HitRecorder';
    supportedSignals: string[];
    version: 1;
  };
  injection: {
    degradedReasons: string[];
    omittedCount: number;
    selectedCount: number;
    status: PrimeInjectionStatus;
  };
  intent: {
    applied: boolean;
    confidence?: number;
    degraded: boolean;
    degradedReasons: string[];
    executableQuery: string | null;
    rankingProfile?: string;
    requestedMode?: SearchModeLabel;
    sourceRefs: string[];
    whySelected: string[];
  };
  omitted: PrimeInjectionOmission[];
  relations: {
    evidence: RelationEvidence[];
    omitted: string[];
  };
  residentRegionRetrieval?: PrimeResidentRegionRetrieval;
  retrievalQuality: {
    decisionRefCount: number;
    feedbackSignalCount: number;
    relationEvidenceCount: number;
    selectedWithSourceRefs: number;
    sourceRefCoverage: number;
    version: 1;
  };
  search: {
    actualMode?: SearchModeLabel;
    filteredCount?: number;
    query?: string;
    queries: string[];
    requestedMode?: SearchModeLabel;
    resultCount?: number;
  };
  selectedKnowledge: PrimeSelectedKnowledge[];
  trace: {
    evidenceRefs: string[];
    sourcePath: string[];
    sourceRefs: string[];
    sources: string[];
  };
  vector: {
    omitted: string[];
    scoreBreakdown: IntentScoreBreakdown[];
    semanticAnchors: IntentEvidence['semanticAnchors'];
    semanticUsed?: boolean;
    topAnchorMatches: TopAnchorMatch[];
    vectorAvailable?: boolean;
    vectorUsed?: boolean;
  };
  version: 1;
}

interface PrimeInjectionItem {
  id?: unknown;
  kind?: unknown;
  knowledgeType?: unknown;
  metadata?: unknown;
  score?: unknown;
  sourceRefs?: unknown;
  title?: unknown;
  trigger?: unknown;
}

export interface BuildPrimeInjectionPackageOptions {
  decisionRegister?: {
    acceptedDecisionRefs?: string[];
    auditExcludedCount?: number;
    available?: boolean;
  } | null;
  hostIntent?: {
    confidence?: number;
    degraded?: boolean;
    degradedReason?: string;
    sourceRefs?: string[];
  } | null;
  intentEvidence?: IntentEvidence | null;
  intentSearchPlan?: IntentSearchPlan | null;
  items?: PrimeInjectionItem[];
  maxSelected?: number;
  search?: {
    actualMode?: string;
    filteredCount?: number;
    query?: string;
    queries?: string[];
    requestedMode?: string;
    resultCount?: number;
  };
  residentRegionRetrieval?: PrimeResidentRegionRetrieval;
  semanticUsed?: boolean;
  vectorAvailable?: boolean;
  vectorUsed?: boolean;
}

const MAX_SELECTED = 8;
const MAX_OMITTED = 16;

export function buildPrimeInjectionPackage(
  options: BuildPrimeInjectionPackageOptions
): PrimeInjectionPackage {
  const plan = options.intentSearchPlan ?? null;
  const evidence = options.intentEvidence ?? null;
  const items = (options.items ?? []).slice(0, options.maxSelected ?? MAX_SELECTED);
  const selectedKnowledge = buildSelectedKnowledge(items, plan, evidence);
  const omitted = buildOmitted(options, selectedKnowledge);
  const decisionRegister = buildDecisionRegisterMeta(options, selectedKnowledge);
  const feedback = buildFeedbackMeta();
  const retrievalQuality = buildRetrievalQualityMeta({
    evidence,
    feedback,
    selectedKnowledge,
    decisionRegister,
  });
  const degradedReasons = uniqueStrings([
    ...(plan?.degradedReasons ?? []),
    ...(evidence?.degradedReasons ?? []),
    options.hostIntent?.degradedReason,
    ...selectedKnowledge
      .filter((item) => item.injectionStatus === 'candidate')
      .map((item) => `selectedKnowledge:${item.itemId}:sourceRefs-missing`),
    ...(options.residentRegionRetrieval?.degradedReasons ?? []),
  ]).slice(0, MAX_OMITTED);
  const status = resolveInjectionStatus({
    degradedReasons,
    evidence,
    hostIntent: options.hostIntent,
    plan,
    selectedKnowledge,
  });
  const evidenceRefs = uniqueStrings(selectedKnowledge.flatMap((item) => item.evidenceRefs));
  const sourceRefs = uniqueStrings([
    ...(plan?.sourceRefs ?? []),
    ...(options.hostIntent?.sourceRefs ?? []),
    ...selectedKnowledge.flatMap((item) => item.sourceRefs),
  ]).map(redactRef);

  return {
    decisionRegister,
    feedback,
    injection: {
      degradedReasons,
      omittedCount: omitted.length,
      selectedCount: selectedKnowledge.length,
      status,
    },
    intent: {
      applied: plan?.applied === true,
      ...(typeof plan?.confidence === 'number' ? { confidence: plan.confidence } : {}),
      degraded: plan?.degraded === true || options.hostIntent?.degraded === true,
      degradedReasons: uniqueStrings([
        ...(plan?.degradedReasons ?? []),
        ...(options.hostIntent?.degradedReason ? [options.hostIntent.degradedReason] : []),
      ]).slice(0, 8),
      executableQuery: plan?.executableQuery ?? null,
      ...(plan?.rankingProfile ? { rankingProfile: plan.rankingProfile } : {}),
      ...(plan?.requestedMode ? { requestedMode: plan.requestedMode } : {}),
      sourceRefs: (plan?.sourceRefs ?? []).map(redactRef).slice(0, 12),
      whySelected: (plan?.whySelected ?? []).slice(0, 12),
    },
    omitted,
    relations: {
      evidence: (evidence?.relationEvidence ?? []).slice(0, 12),
      omitted: relationOmissions(evidence),
    },
    ...(options.residentRegionRetrieval
      ? { residentRegionRetrieval: options.residentRegionRetrieval }
      : {}),
    retrievalQuality,
    search: {
      ...(options.search?.actualMode ? { actualMode: options.search.actualMode } : {}),
      ...(typeof options.search?.filteredCount === 'number'
        ? { filteredCount: Math.max(0, Math.floor(options.search.filteredCount)) }
        : {}),
      ...(options.search?.query ? { query: options.search.query } : {}),
      queries: uniqueStrings([
        ...(options.search?.queries ?? []),
        ...(plan?.lexicalQueries ?? []),
        plan?.executableQuery,
      ]).slice(0, 8),
      ...(options.search?.requestedMode ? { requestedMode: options.search.requestedMode } : {}),
      ...(typeof options.search?.resultCount === 'number'
        ? { resultCount: Math.max(0, Math.floor(options.search.resultCount)) }
        : {}),
    },
    selectedKnowledge,
    trace: {
      evidenceRefs,
      sourcePath: (plan?.sourcePath ?? []).slice(0, 12),
      sourceRefs: sourceRefs.slice(0, 16),
      sources: traceSources(plan, evidence),
    },
    vector: {
      omitted: vectorOmissions(evidence),
      scoreBreakdown: (evidence?.scoreBreakdown ?? []).slice(0, 8),
      semanticAnchors: (evidence?.semanticAnchors ?? []).slice(0, 12),
      ...(typeof options.semanticUsed === 'boolean' ? { semanticUsed: options.semanticUsed } : {}),
      topAnchorMatches: (evidence?.topAnchorMatches ?? []).slice(0, 10),
      ...(typeof options.vectorAvailable === 'boolean'
        ? { vectorAvailable: options.vectorAvailable }
        : {}),
      ...(typeof options.vectorUsed === 'boolean' ? { vectorUsed: options.vectorUsed } : {}),
    },
    version: 1,
  };
}

function buildDecisionRegisterMeta(
  options: BuildPrimeInjectionPackageOptions,
  selectedKnowledge: PrimeSelectedKnowledge[]
): PrimeInjectionPackage['decisionRegister'] {
  const selectedDecisionRefs = selectedKnowledge
    .filter(
      (item) =>
        item.kind === 'decision' ||
        item.knowledgeType === 'decision-register' ||
        item.itemId.startsWith('decision:')
    )
    .map((item) => item.itemId);
  return {
    acceptedDecisionRefs: uniqueStrings([
      ...(options.decisionRegister?.acceptedDecisionRefs ?? []),
      ...selectedDecisionRefs,
    ]).slice(0, 16),
    auditExcludedCount: Math.max(0, Math.floor(options.decisionRegister?.auditExcludedCount ?? 0)),
    available: options.decisionRegister?.available === true || selectedDecisionRefs.length > 0,
    defaultLifecycle: 'active-effective-only',
    excludedStatuses: ['revoked', 'deleted'],
    route: '/api/v1/decision-register/searchable',
    source: 'alembic-decision-register',
    vectorAdmission: 'accepted-only',
  };
}

function buildFeedbackMeta(): PrimeInjectionPackage['feedback'] {
  return {
    observeOnly: true,
    recorder: 'HitRecorder',
    supportedSignals: ['searchHit', 'view', 'adoption', 'application', 'guardHit'],
    version: 1,
  };
}

function buildRetrievalQualityMeta({
  decisionRegister,
  evidence,
  feedback,
  selectedKnowledge,
}: {
  decisionRegister: PrimeInjectionPackage['decisionRegister'];
  evidence: IntentEvidence | null;
  feedback: PrimeInjectionPackage['feedback'];
  selectedKnowledge: PrimeSelectedKnowledge[];
}): PrimeInjectionPackage['retrievalQuality'] {
  const selectedWithSourceRefs = selectedKnowledge.filter(
    (item) => item.sourceRefs.length > 0
  ).length;
  return {
    decisionRefCount: decisionRegister.acceptedDecisionRefs.length,
    feedbackSignalCount: feedback.supportedSignals.length,
    relationEvidenceCount: evidence?.relationEvidence.length ?? 0,
    selectedWithSourceRefs,
    sourceRefCoverage:
      selectedKnowledge.length === 0 ? 0 : selectedWithSourceRefs / selectedKnowledge.length,
    version: 1,
  };
}

function buildSelectedKnowledge(
  items: PrimeInjectionItem[],
  plan: IntentSearchPlan | null,
  evidence: IntentEvidence | null
): PrimeSelectedKnowledge[] {
  const scoreById = new Map((evidence?.scoreBreakdown ?? []).map((score) => [score.itemId, score]));
  const matchById = groupMatches(evidence?.topAnchorMatches ?? []);
  const relationById = groupRelations(evidence?.relationEvidence ?? []);

  return items.flatMap((item, index) => {
    const itemId = stringValue(item.id);
    if (!itemId) {
      return [];
    }
    const regionEvidence = collectResidentRegionEvidence(item);
    const scoreBreakdown = scoreById.get(itemId);
    const sourceRefs = collectItemSourceRefs(item);
    const evidenceRefs = uniqueStrings([
      scoreBreakdown ? `scoreBreakdown:${itemId}` : undefined,
      matchById.has(itemId) ? `topAnchorMatch:${itemId}` : undefined,
      relationById.has(itemId) ? `relationEvidence:${itemId}` : undefined,
      ...sourceRefs.map((_, refIndex) => `sourceRef:${itemId}:${refIndex + 1}`),
    ]);
    const whySelected = uniqueStrings([
      ...(plan?.whySelected ?? []),
      ...(scoreBreakdown?.signals ?? []),
      ...(matchById.has(itemId) ? ['anchor-match'] : []),
      ...(relationById.has(itemId) ? ['relation-evidence'] : []),
    ]).slice(0, 12);
    return [
      {
        evidenceRefs,
        injectionStatus: sourceRefs.length > 0 ? 'selected' : 'candidate',
        itemId,
        ...(stringValue(item.kind) ? { kind: stringValue(item.kind) } : {}),
        ...(stringValue(item.knowledgeType)
          ? { knowledgeType: stringValue(item.knowledgeType) }
          : {}),
        ...(regionEvidence
          ? {
              matchedRegionClasses: regionEvidence.matchedRegionClasses,
              matchedRegions: regionEvidence.matchedRegions,
            }
          : {}),
        rank: index + 1,
        score: numberValue(item.score),
        ...(scoreBreakdown ? { scoreBreakdown } : {}),
        sourceRefs,
        ...(stringValue(item.title) ? { title: stringValue(item.title) } : {}),
        ...(stringValue(item.trigger) ? { trigger: stringValue(item.trigger) } : {}),
        whySelected,
      },
    ];
  });
}

function buildOmitted(
  options: BuildPrimeInjectionPackageOptions,
  selectedKnowledge: PrimeSelectedKnowledge[]
): PrimeInjectionOmission[] {
  const plan = options.intentSearchPlan ?? null;
  const evidence = options.intentEvidence ?? null;
  const omitted: PrimeInjectionOmission[] = [];
  if (!plan) {
    omitted.push({ reason: 'intentSearchPlan:missing', source: 'primeInjectionPackage' });
  }
  if (!evidence) {
    omitted.push({ reason: 'intentEvidence:missing', source: 'primeInjectionPackage' });
  }
  for (const reason of plan?.omitted ?? []) {
    omitted.push({ reason, source: 'intentSearchPlan' });
  }
  for (const reason of evidence?.degradedReasons ?? []) {
    omitted.push({ reason, source: 'intentEvidence' });
  }
  for (const reason of options.residentRegionRetrieval?.degradedReasons ?? []) {
    omitted.push({ reason, source: 'residentRegionRetrieval' });
  }
  for (const item of selectedKnowledge) {
    if (item.sourceRefs.length === 0) {
      omitted.push({
        itemId: item.itemId,
        reason: 'sourceRefs:missing',
        source: 'selectedKnowledge',
      });
    }
  }
  const filteredCount = options.search?.filteredCount;
  if (typeof filteredCount === 'number' && filteredCount > selectedKnowledge.length) {
    omitted.push({
      detail: `${filteredCount - selectedKnowledge.length} filtered result(s) not injected`,
      reason: 'selectedKnowledge:truncated',
      source: 'primeSearch',
    });
  }
  if (selectedKnowledge.length === 0) {
    omitted.push({ reason: 'selectedKnowledge:empty', source: 'primeSearch' });
  }
  return dedupeOmitted(omitted).slice(0, MAX_OMITTED);
}

function resolveInjectionStatus({
  degradedReasons,
  evidence,
  hostIntent,
  plan,
  selectedKnowledge,
}: {
  degradedReasons: string[];
  evidence: IntentEvidence | null;
  hostIntent: BuildPrimeInjectionPackageOptions['hostIntent'];
  plan: IntentSearchPlan | null;
  selectedKnowledge: PrimeSelectedKnowledge[];
}): PrimeInjectionStatus {
  if (selectedKnowledge.length === 0) {
    return 'empty';
  }
  const needsConfirmation =
    (typeof plan?.confidence === 'number' && plan.confidence < 0.5) ||
    (plan?.omitted ?? []).some(
      (reason) => reason.includes('lowConfidence') || reason.includes('needs-confirmation')
    ) ||
    (typeof hostIntent?.confidence === 'number' && hostIntent.confidence < 0.5);
  if (needsConfirmation) {
    return 'needs-confirmation';
  }
  if (plan?.degraded || evidence?.degraded || hostIntent?.degraded || degradedReasons.length > 0) {
    return 'degraded';
  }
  if (selectedKnowledge.some((item) => item.injectionStatus === 'candidate')) {
    return 'candidate';
  }
  return 'ready';
}

function groupMatches(matches: TopAnchorMatch[]): Map<string, TopAnchorMatch[]> {
  const grouped = new Map<string, TopAnchorMatch[]>();
  for (const match of matches) {
    grouped.set(match.itemId, [...(grouped.get(match.itemId) ?? []), match]);
  }
  return grouped;
}

function groupRelations(relations: RelationEvidence[]): Map<string, RelationEvidence[]> {
  const grouped = new Map<string, RelationEvidence[]>();
  for (const relation of relations) {
    grouped.set(relation.itemId, [...(grouped.get(relation.itemId) ?? []), relation]);
  }
  return grouped;
}

function relationOmissions(evidence: IntentEvidence | null): string[] {
  return (evidence?.degradedReasons ?? [])
    .filter((reason) => reason.startsWith('relationEvidence:'))
    .slice(0, 8);
}

function vectorOmissions(evidence: IntentEvidence | null): string[] {
  return (evidence?.degradedReasons ?? [])
    .filter(
      (reason) =>
        reason.startsWith('vector:') ||
        reason.startsWith('semantic:') ||
        reason.startsWith('semanticAnchors:')
    )
    .slice(0, 8);
}

function traceSources(plan: IntentSearchPlan | null, evidence: IntentEvidence | null): string[] {
  return uniqueStrings([
    plan ? 'intentSearchPlan' : undefined,
    evidence ? 'intentEvidence' : undefined,
    ...(evidence?.scoreBreakdown.length ? ['scoreBreakdown'] : []),
    ...(evidence?.relationEvidence.length ? ['relationEvidence'] : []),
  ]);
}

function collectItemSourceRefs(item: PrimeInjectionItem): string[] {
  const metadata = asRecord(item.metadata);
  return uniqueStrings([
    ...stringsFrom(item.sourceRefs),
    ...stringsFrom(metadata?.sourceRefs),
    ...stringsFrom(metadata?.sourceRef),
  ])
    .map(redactRef)
    .slice(0, 8);
}

function collectResidentRegionEvidence(
  item: PrimeInjectionItem
): PrimeResidentRegionRecipeEvidence | null {
  const metadata = asRecord(item.metadata);
  const evidence = asRecord(metadata?.residentRegionEvidence);
  const recipeId = stringValue(evidence?.recipeId) ?? stringValue(item.id);
  const matchedRegions = Array.isArray(evidence?.matchedRegions)
    ? evidence.matchedRegions.flatMap((region) => {
        const record = asRecord(region);
        const regionClass = stringValue(record?.regionClass) as
          | RecipeSemanticRegionClass
          | undefined;
        const vectorId = stringValue(record?.vectorId);
        const snippet = stringValue(record?.snippet);
        const score = numberValue(record?.score);
        if (!regionClass || !vectorId || !snippet || score === null) {
          return [];
        }
        const matchedRegion: PrimeMatchedRegionEvidence = {
          regionClass,
          score,
          snippet,
          sourceRefs: stringsFrom(record?.sourceRefs).map(redactRef).slice(0, 8),
          ...(stringValue(record?.sourceRefsBridge)
            ? { sourceRefsBridge: stringValue(record?.sourceRefsBridge) }
            : {}),
          vectorId,
        };
        return [matchedRegion];
      })
    : [];
  const matchedRegionClasses = uniqueStrings([
    ...stringsFrom(evidence?.matchedRegionClasses),
    ...matchedRegions.map((region) => region.regionClass),
  ]) as RecipeSemanticRegionClass[];
  if (!recipeId || matchedRegions.length === 0) {
    return null;
  }
  return {
    matchedRegionClasses,
    matchedRegions,
    recipeId,
    score: numberValue(evidence?.score) ?? numberValue(item.score) ?? 0,
    sourceRefs: uniqueStrings([
      ...stringsFrom(evidence?.sourceRefs),
      ...matchedRegions.flatMap((region) => region.sourceRefs),
    ])
      .map(redactRef)
      .slice(0, 12),
    ...(stringValue(evidence?.title) ? { title: stringValue(evidence?.title) } : {}),
    ...(stringValue(evidence?.trigger) ? { trigger: stringValue(evidence?.trigger) } : {}),
  };
}

function dedupeOmitted(omitted: PrimeInjectionOmission[]): PrimeInjectionOmission[] {
  const seen = new Set<string>();
  const result: PrimeInjectionOmission[] = [];
  for (const item of omitted) {
    const key = `${item.source}:${item.reason}:${item.itemId ?? ''}:${item.detail ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function stringsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(stringsFrom);
  }
  const normalized = stringValue(value);
  return normalized ? [normalized] : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = stringValue(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function redactRef(value: string): string {
  const withoutNulls = value.replace(/\0/g, '');
  if (path.isAbsolute(withoutNulls)) {
    return `[absolute-path]/${path.basename(withoutNulls)}`;
  }
  return withoutNulls
    .replace(/\\/g, '/')
    .replace(/\.\.(\/|$)/g, '')
    .replace(/^\/+/, '')
    .slice(0, 500);
}
