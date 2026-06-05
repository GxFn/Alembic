import path from 'node:path';
import type { IntentSearchPlan } from './IntentSearchPlan.js';

export interface SemanticAnchor {
  kind: 'query' | 'token' | 'source-ref';
  source: string;
  value: string;
  weight: number;
}

export interface TopAnchorMatch {
  anchor: string;
  itemId: string;
  matchType: 'text' | 'semantic-score' | 'vector-score';
  rank: number;
  score: number | null;
  sourceRefs: string[];
  title?: string;
}

export interface IntentScoreBreakdown {
  itemId: string;
  rank: number;
  finalScore: number | null;
  lexicalScore: number | null;
  relationScore: number | null;
  semanticScore: number | null;
  signals: string[];
  vectorScore: number | null;
}

export interface RelationEvidence {
  direction: 'incoming' | 'outgoing' | 'unknown';
  itemId: string;
  relatedId: string;
  relatedType?: string;
  relation: string;
  source: 'knowledgeGraphService' | 'relations-fallback';
}

export interface IntentEvidence {
  decisionRegister: {
    acceptedDecisionRefs: string[];
    auditExcludedCount: number;
    available: boolean;
    defaultLifecycle: 'active-effective-only';
    excludedStatuses: string[];
    route: '/api/v1/decision-register/searchable';
  };
  degraded: boolean;
  degradedReasons: string[];
  feedback: {
    observeOnly: true;
    supportedSignals: string[];
    version: 1;
  };
  relationEvidence: RelationEvidence[];
  retrievalQuality: {
    decisionRefCount: number;
    feedbackSignalCount: number;
    relationEvidenceCount: number;
    sourceRefCoverage: number;
    version: 1;
  };
  scoreBreakdown: IntentScoreBreakdown[];
  semanticAnchors: SemanticAnchor[];
  topAnchorMatches: TopAnchorMatch[];
  version: 1;
}

export interface RelationEvidenceProvider {
  getEdges?: (nodeId: string, nodeType: string, direction?: string) => Promise<unknown>;
  getRelated?: (nodeId: string, nodeType: string, relation?: string) => Promise<unknown>;
}

interface IntentEvidenceItem {
  content?: unknown;
  description?: unknown;
  id?: unknown;
  kind?: unknown;
  knowledgeType?: unknown;
  metadata?: unknown;
  score?: unknown;
  semanticScore?: unknown;
  sourceRefs?: unknown;
  title?: unknown;
  trigger?: unknown;
  vectorScore?: unknown;
}

export interface BuildIntentEvidenceOptions {
  actualMode?: string;
  decisionRegister?: {
    acceptedDecisionRefs?: string[];
    auditExcludedCount?: number;
    available?: boolean;
  } | null;
  intentSearchPlan?: IntentSearchPlan | null;
  items?: IntentEvidenceItem[];
  maxItems?: number;
  relationProvider?: RelationEvidenceProvider | null;
  requestedMode?: string;
  semanticUsed?: boolean;
  vectorAvailable?: boolean;
  vectorUsed?: boolean;
}

const MAX_ANCHORS = 12;
const MAX_MATCHES = 10;
const MAX_RELATIONS = 12;
const MAX_SCORE_ITEMS = 8;
const STOP_WORDS = new Set([
  'and',
  'for',
  'from',
  'into',
  'the',
  'this',
  'that',
  'with',
  'using',
  'about',
  'should',
  'would',
]);

export async function buildIntentEvidence(
  options: BuildIntentEvidenceOptions
): Promise<IntentEvidence> {
  const items = (options.items ?? []).slice(0, options.maxItems ?? MAX_SCORE_ITEMS);
  const semanticAnchors = buildSemanticAnchors(options.intentSearchPlan);
  const relationEvidence = await collectRelationEvidence(items, options.relationProvider);
  const scoreBreakdown = buildScoreBreakdown(items, relationEvidence);
  const decisionRegister = buildDecisionRegisterEvidence(options, items);
  const feedback = buildFeedbackEvidence();
  const retrievalQuality = buildRetrievalQualityEvidence({
    decisionRegister,
    feedback,
    items,
    relationEvidence,
  });
  const topAnchorMatches = buildTopAnchorMatches({
    anchors: semanticAnchors,
    items,
    semanticUsed: options.semanticUsed,
    vectorUsed: options.vectorUsed,
  });
  const degradedReasons = buildDegradedReasons(options, semanticAnchors, relationEvidence);

  return {
    decisionRegister,
    degraded: degradedReasons.length > 0,
    degradedReasons,
    feedback,
    relationEvidence,
    retrievalQuality,
    scoreBreakdown,
    semanticAnchors,
    topAnchorMatches,
    version: 1,
  };
}

export function summarizeIntentEvidence(evidence: IntentEvidence): IntentEvidence {
  return {
    decisionRegister: {
      ...evidence.decisionRegister,
      acceptedDecisionRefs: evidence.decisionRegister.acceptedDecisionRefs.slice(0, 8),
    },
    degraded: evidence.degraded,
    degradedReasons: evidence.degradedReasons.slice(0, 8),
    feedback: {
      ...evidence.feedback,
      supportedSignals: evidence.feedback.supportedSignals.slice(0, 8),
    },
    relationEvidence: evidence.relationEvidence.slice(0, MAX_RELATIONS),
    retrievalQuality: evidence.retrievalQuality,
    scoreBreakdown: evidence.scoreBreakdown.slice(0, MAX_SCORE_ITEMS),
    semanticAnchors: evidence.semanticAnchors.slice(0, MAX_ANCHORS),
    topAnchorMatches: evidence.topAnchorMatches.slice(0, MAX_MATCHES),
    version: 1,
  };
}

function buildDecisionRegisterEvidence(
  options: BuildIntentEvidenceOptions,
  items: IntentEvidenceItem[]
): IntentEvidence['decisionRegister'] {
  const itemDecisionRefs = items
    .filter(isDecisionRegisterItem)
    .map((item) => stringValue(item.id))
    .filter((value): value is string => Boolean(value));
  return {
    acceptedDecisionRefs: uniqueStrings([
      ...(options.decisionRegister?.acceptedDecisionRefs ?? []),
      ...itemDecisionRefs,
    ]).slice(0, 16),
    auditExcludedCount: Math.max(0, Math.floor(options.decisionRegister?.auditExcludedCount ?? 0)),
    available: options.decisionRegister?.available === true || itemDecisionRefs.length > 0,
    defaultLifecycle: 'active-effective-only',
    excludedStatuses: ['revoked', 'deleted'],
    route: '/api/v1/decision-register/searchable',
  };
}

function buildFeedbackEvidence(): IntentEvidence['feedback'] {
  return {
    observeOnly: true,
    supportedSignals: ['searchHit', 'view', 'adoption', 'application', 'guardHit'],
    version: 1,
  };
}

function buildRetrievalQualityEvidence({
  decisionRegister,
  feedback,
  items,
  relationEvidence,
}: {
  decisionRegister: IntentEvidence['decisionRegister'];
  feedback: IntentEvidence['feedback'];
  items: IntentEvidenceItem[];
  relationEvidence: RelationEvidence[];
}): IntentEvidence['retrievalQuality'] {
  const sourceRefItems = items.filter((item) => collectSourceRefs(item).length > 0).length;
  return {
    decisionRefCount: decisionRegister.acceptedDecisionRefs.length,
    feedbackSignalCount: feedback.supportedSignals.length,
    relationEvidenceCount: relationEvidence.length,
    sourceRefCoverage: items.length === 0 ? 0 : sourceRefItems / items.length,
    version: 1,
  };
}

function buildSemanticAnchors(plan: IntentSearchPlan | null | undefined): SemanticAnchor[] {
  if (!plan) {
    return [];
  }
  const anchors: SemanticAnchor[] = [];
  pushAnchor(anchors, {
    kind: 'query',
    source: 'intentSearchPlan.executableQuery',
    value: plan.executableQuery,
    weight: plan.applied ? 1 : 0.45,
  });
  for (const query of plan.lexicalQueries.slice(0, 4)) {
    pushAnchor(anchors, {
      kind: 'query',
      source: 'intentSearchPlan.lexicalQueries',
      value: query,
      weight: plan.applied ? 0.85 : 0.4,
    });
  }
  for (const ref of plan.sourceRefs.slice(0, 4)) {
    pushAnchor(anchors, {
      kind: 'source-ref',
      source: 'intentSearchPlan.sourceRefs',
      value: redactRef(ref),
      weight: 0.55,
    });
  }
  for (const token of tokenizeAnchors([plan.executableQuery, ...plan.lexicalQueries].join(' '))) {
    pushAnchor(anchors, {
      kind: 'token',
      source: 'intentSearchPlan.tokens',
      value: token,
      weight: plan.applied ? 0.65 : 0.35,
    });
  }
  return anchors.slice(0, MAX_ANCHORS);
}

function buildTopAnchorMatches({
  anchors,
  items,
  semanticUsed,
  vectorUsed,
}: {
  anchors: SemanticAnchor[];
  items: IntentEvidenceItem[];
  semanticUsed?: boolean;
  vectorUsed?: boolean;
}): TopAnchorMatch[] {
  const matches: TopAnchorMatch[] = [];
  const searchableAnchors = anchors.filter((anchor) => anchor.kind !== 'source-ref');
  for (let index = 0; index < items.length; index++) {
    const item = items[index] ?? {};
    const itemId = stringValue(item.id);
    if (!itemId) {
      continue;
    }
    const haystack = itemText(item).toLowerCase();
    for (const anchor of searchableAnchors) {
      if (!anchor.value || matches.length >= MAX_MATCHES) {
        break;
      }
      if (haystack.includes(anchor.value.toLowerCase())) {
        matches.push(matchFromItem(item, anchor.value, index, 'text'));
      }
    }
    if (matches.length >= MAX_MATCHES) {
      break;
    }
    if (matches.some((match) => match.itemId === itemId)) {
      continue;
    }
    const firstAnchor = searchableAnchors[0]?.value;
    if (!firstAnchor) {
      continue;
    }
    if (numberValue(item.semanticScore) !== null || semanticUsed === true) {
      matches.push(matchFromItem(item, firstAnchor, index, 'semantic-score'));
    } else if (numberValue(item.vectorScore) !== null || vectorUsed === true) {
      matches.push(matchFromItem(item, firstAnchor, index, 'vector-score'));
    }
  }
  return matches.slice(0, MAX_MATCHES);
}

function buildScoreBreakdown(
  items: IntentEvidenceItem[],
  relationEvidence: RelationEvidence[]
): IntentScoreBreakdown[] {
  const relationCounts = new Map<string, number>();
  for (const relation of relationEvidence) {
    relationCounts.set(relation.itemId, (relationCounts.get(relation.itemId) ?? 0) + 1);
  }
  return items.slice(0, MAX_SCORE_ITEMS).flatMap((item, index) => {
    const itemId = stringValue(item.id);
    if (!itemId) {
      return [];
    }
    const semanticScore = numberValue(item.semanticScore);
    const vectorScore = numberValue(item.vectorScore);
    const finalScore = numberValue(item.score);
    const relationScore = relationCounts.has(itemId)
      ? Math.min(1, (relationCounts.get(itemId) ?? 0) / 3)
      : null;
    const signals = [
      finalScore !== null ? 'final-score' : null,
      semanticScore !== null ? 'semantic-score' : null,
      vectorScore !== null ? 'vector-score' : null,
      relationScore !== null ? 'relation-evidence' : null,
    ].filter((signal): signal is string => Boolean(signal));
    return [
      {
        itemId,
        rank: index + 1,
        finalScore,
        lexicalScore: semanticScore === null && vectorScore === null ? finalScore : null,
        relationScore,
        semanticScore,
        signals,
        vectorScore,
      },
    ];
  });
}

async function collectRelationEvidence(
  items: IntentEvidenceItem[],
  provider: RelationEvidenceProvider | null | undefined
): Promise<RelationEvidence[]> {
  if (!provider) {
    return [];
  }
  const relations: RelationEvidence[] = [];
  for (const item of items.slice(0, 4)) {
    const itemId = stringValue(item.id);
    if (!itemId) {
      continue;
    }
    const rawEdges = await safeReadEdges(provider, itemId);
    for (const edge of rawEdges) {
      const relation = normalizeRelation(edge, itemId);
      if (relation) {
        relations.push(relation);
      }
      if (relations.length >= MAX_RELATIONS) {
        return relations;
      }
    }
  }
  return relations;
}

async function safeReadEdges(
  provider: RelationEvidenceProvider,
  itemId: string
): Promise<unknown[]> {
  try {
    const raw = provider.getEdges
      ? await provider.getEdges(itemId, 'recipe', 'both')
      : await provider.getRelated?.(itemId, 'recipe');
    return arrayFromGraphResult(raw);
  } catch (err: unknown) {
    process.stderr.write(
      `[IntentEvidence] relation evidence read failed for ${itemId}: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return [];
  }
}

function normalizeRelation(edge: unknown, itemId: string): RelationEvidence | null {
  const record = asRecord(edge);
  if (!record) {
    return null;
  }
  const fromId = stringValue(record.fromId) ?? stringValue(record.from_id);
  const toId = stringValue(record.toId) ?? stringValue(record.to_id);
  const relation = stringValue(record.relation) ?? stringValue(record.type);
  if (!relation) {
    return null;
  }
  const direction =
    fromId === itemId ? 'outgoing' : toId === itemId ? 'incoming' : ('unknown' as const);
  const relatedId =
    direction === 'outgoing' ? toId : direction === 'incoming' ? fromId : (toId ?? fromId);
  if (!relatedId) {
    return null;
  }
  const relatedType =
    direction === 'outgoing'
      ? (stringValue(record.toType) ?? stringValue(record.to_type))
      : (stringValue(record.fromType) ?? stringValue(record.from_type));
  return {
    direction,
    itemId,
    relatedId,
    ...(relatedType ? { relatedType } : {}),
    relation,
    source: 'knowledgeGraphService',
  };
}

function buildDegradedReasons(
  options: BuildIntentEvidenceOptions,
  anchors: SemanticAnchor[],
  relationEvidence: RelationEvidence[]
): string[] {
  const reasons: string[] = [];
  if (!options.intentSearchPlan) {
    reasons.push('intentSearchPlan:missing');
  }
  if (anchors.length === 0) {
    reasons.push('semanticAnchors:empty');
  }
  if (options.requestedMode === 'semantic' && options.semanticUsed === false) {
    reasons.push('semantic:degraded');
  }
  if (options.vectorAvailable === false || options.vectorUsed === false) {
    reasons.push('vector:evidence-observe-only');
  }
  if (options.relationProvider && relationEvidence.length === 0) {
    reasons.push('relationEvidence:empty');
  }
  return uniqueStrings(reasons);
}

function matchFromItem(
  item: IntentEvidenceItem,
  anchor: string,
  index: number,
  matchType: TopAnchorMatch['matchType']
): TopAnchorMatch {
  return {
    anchor,
    itemId: stringValue(item.id) ?? '',
    matchType,
    rank: index + 1,
    score: numberValue(item.score),
    sourceRefs: collectSourceRefs(item),
    ...(stringValue(item.title) ? { title: stringValue(item.title) } : {}),
  };
}

function pushAnchor(anchors: SemanticAnchor[], candidate: SemanticAnchor): void {
  const normalized = stringValue(candidate.value);
  if (!normalized) {
    return;
  }
  const key = `${candidate.kind}:${normalized.toLowerCase()}`;
  if (anchors.some((anchor) => `${anchor.kind}:${anchor.value.toLowerCase()}` === key)) {
    return;
  }
  anchors.push({ ...candidate, value: normalized.slice(0, 160) });
}

function tokenizeAnchors(input: string): string[] {
  const tokens = input.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return uniqueStrings(
    tokens
      .map((token) => token.toLowerCase())
      .filter((token) => !STOP_WORDS.has(token))
      .slice(0, 16)
  );
}

function itemText(item: IntentEvidenceItem): string {
  return [
    stringValue(item.title),
    stringValue(item.trigger),
    stringValue(item.description),
    textFromContent(item.content),
    textFromContent(asRecord(item.metadata)?.description),
    textFromContent(asRecord(item.metadata)?.sourceRefs),
  ]
    .filter(Boolean)
    .join('\n');
}

function isDecisionRegisterItem(item: IntentEvidenceItem): boolean {
  const metadata = asRecord(item.metadata);
  const decisionMetadata = asRecord(metadata?.decisionRegister);
  return (
    stringValue(item.kind) === 'decision' ||
    stringValue(item.knowledgeType) === 'decision-register' ||
    stringValue(item.id)?.startsWith('decision:') === true ||
    stringValue(decisionMetadata?.decisionId) !== undefined
  );
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') {
    return value.slice(0, 2000);
  }
  if (Array.isArray(value)) {
    return value.map(textFromContent).filter(Boolean).join(' ');
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map(textFromContent)
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function collectSourceRefs(item: IntentEvidenceItem): string[] {
  const metadata = asRecord(item.metadata);
  return uniqueStrings([
    ...stringsFrom(item.sourceRefs),
    ...stringsFrom(metadata?.sourceRefs),
    ...stringsFrom(metadata?.sourceRef),
  ])
    .map(redactRef)
    .slice(0, 8);
}

function arrayFromGraphResult(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  return [
    ...arrayFromGraphResult(record.outgoing),
    ...arrayFromGraphResult(record.incoming),
    ...arrayFromGraphResult(record.edges),
  ];
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
