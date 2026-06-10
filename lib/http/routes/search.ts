/**
 * Search API 路由
 * 统一搜索接口 - 搜 Recipe（含所有知识类型）
 */

import Logger from '@alembic/core/logging';
import type { SearchResponse, SearchResponseMeta } from '@alembic/core/search';
import { resolveProjectRoot, type WorkspaceResolver } from '@alembic/core/workspace';
import express, { type Request, type Response } from 'express';
import type { z } from 'zod';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { resolveAlembicWorkspace } from '../../project-scope/ProjectScopeRegistry.js';
import type {
  DecisionRegisterSearchableDocument,
  DecisionRegisterSearchableView,
  DecisionRegisterStore,
} from '../../service/task/DecisionRegisterStore.js';
import {
  createHostIntentContextMeta,
  type HostIntentContextMeta,
  normalizeHostIntentContext,
} from '../../service/task/HostIntentContext.js';
import type { IntentEpisodeStore } from '../../service/task/IntentEpisodeStore.js';
import {
  buildIntentEvidence,
  type IntentEvidence,
  type RelationEvidenceProvider,
} from '../../service/task/IntentEvidence.js';
import {
  buildIntentSearchPlan,
  type IntentSearchPlan,
  summarizeIntentSearchPlan,
} from '../../service/task/IntentSearchPlan.js';
import {
  buildPrimeInjectionPackage,
  type PrimeInjectionPackage,
} from '../../service/task/PrimeInjectionPackage.js';
import {
  ContextAwareSearchBody,
  GraphImpactQuery,
  GraphQuery,
  ResidentSearchBody,
  SearchQuery,
  SimilarityBody,
} from '../../shared/schemas/http-requests.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { safeInt } from '../utils/routeHelpers.js';

/** Search result from SearchEngine */
interface SearchEngineItem {
  title?: string;
  id?: string;
  content?: string | Record<string, string>;
  score?: number;
  authorityScore?: number;
  qualityScore?: number;
  usageCount?: number;
  code?: string;
  trigger?: string;
}

/** Knowledge entry from KnowledgeService */
interface KnowledgeItem {
  title?: string;
  id?: string;
  content?: { pattern?: string; markdown?: string };
  quality?: { overall?: number };
}

interface SearchRouteItem {
  id?: string;
  score?: number;
  vectorScore?: number;
  semanticScore?: number;
  [key: string]: unknown;
}

interface SearchRouteResult {
  items?: SearchRouteItem[];
  total?: number;
  query?: string;
  mode?: string;
  type?: string;
  ranked?: boolean;
  searchMeta?: SearchResponseMeta;
  [key: string]: unknown;
}

type SearchFallbackResults = Record<
  string,
  { data?: unknown[]; pagination?: Record<string, unknown> }
>;

interface ResidentSearchInput {
  confidence?: number;
  degraded?: boolean;
  degradedReason?: string;
  groupByKind: boolean;
  hostDeclaredIntent?: unknown;
  hostTurnMeta?: unknown;
  intentContext?: unknown;
  language?: string;
  limit: number;
  mode: string;
  page: number;
  q: string;
  scenario?: string;
  searchIntent?: string;
  sessionHistory?: Array<Record<string, unknown>>;
  sourceRefs?: string[];
  type: string;
}

interface ResidentSearchVectorStats {
  count: number;
  dimension: number;
  embedProviderAvailable: boolean;
  hasIndex: boolean;
  indexSize?: number;
  quantized?: boolean;
}

interface ResidentSearchMeta {
  route: 'resident-search';
  service: 'alembic-daemon';
  coreRoute: string | null;
  requestedMode: string;
  actualMode: string;
  semanticRequested: boolean;
  semanticUsed: boolean;
  vectorUsed: boolean;
  degraded: boolean;
  degradedReason: string | null;
  fallbackReason?: string;
  hostIntentApplied?: boolean;
  hostIntentConfidence?: number;
  hostIntentDegraded?: boolean;
  hostIntentDegradedReason?: string;
  hostIntentSourceRefs?: string[];
  intentEvidence?: IntentEvidence;
  intentSearchPlan?: IntentSearchPlan;
  primeInjectionPackage?: PrimeInjectionPackage;
  decisionRegister: {
    acceptedCount: number;
    acceptedDecisionRefs: string[];
    auditExcludedCount: number;
    available: boolean;
    defaultLifecycle: 'active-effective-only';
    endpoint: '/api/v1/decision-register/searchable';
    excludedStatuses: string[];
    vectorAdmission: 'accepted-only';
  };
  feedback: {
    observeOnly: true;
    recorder: 'HitRecorder';
    supportedSignals: string[];
    version: 1;
  };
  retrievalQuality: {
    decisionRefCount: number;
    feedbackSignalCount: number;
    relationEvidenceCount: number;
    sourceRefCoverage: number;
    version: 1;
  };
  durationMs: number;
  resultCount: number;
  topScore: number | null;
  residentVector: {
    available: boolean;
    endpoint: '/api/v1/search';
    reason: string | null;
    stats: ResidentSearchVectorStats | null;
  };
  vector: {
    available: boolean;
    reason: string | null;
    stats: ResidentSearchVectorStats | null;
  };
  workspace: {
    dataRoot: string | null;
    dataRootSource: string | null;
    databasePath: string | null;
    projectId: string | null;
    projectRoot: string;
    runtimeDir: string | null;
    workspaceMode: string | null;
  };
}

const router = express.Router();
const logger = Logger.getInstance();
const RESIDENT_SEARCH_ENDPOINT = '/api/v1/search';

/**
 * GET /api/v1/search
 * 统一搜索
 * ?q=keyword&type=all|recipe|solution|rule&limit=20&mode=keyword|bm25|semantic&groupByKind=true
 */
router.get('/', validateQuery(SearchQuery), async (req: Request, res: Response): Promise<void> => {
  const { q, type = 'all', mode = 'keyword' } = req.query as Record<string, string>;
  return handleResidentSearch(req, res, {
    groupByKind:
      req.query.groupByKind === 'true' ||
      (req.query as Record<string, unknown>).groupByKind === true,
    limit: safeInt(req.query.limit, 20, 1, 100),
    mode,
    page: safeInt(req.query.page, 1),
    q,
    type,
  });
});

router.post(
  '/',
  validate(ResidentSearchBody),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof ResidentSearchBody>;
    return handleResidentSearch(req, res, {
      confidence: body.confidence,
      degraded: body.degraded,
      degradedReason: body.degradedReason,
      groupByKind: body.groupByKind,
      hostDeclaredIntent: body.hostDeclaredIntent,
      hostTurnMeta: body.hostTurnMeta,
      intentContext: body.intentContext,
      language: body.language,
      limit: body.limit,
      mode: body.mode,
      page: body.page,
      q: body.query ?? body.q ?? '',
      scenario: body.scenario,
      searchIntent: body.searchIntent,
      sessionHistory: body.sessionHistory,
      sourceRefs: body.sourceRefs,
      type: body.type,
    });
  }
);

async function handleResidentSearch(
  _req: Request,
  res: Response,
  input: ResidentSearchInput
): Promise<void> {
  const container = getServiceContainer();
  const hostIntentContext = normalizeHostIntentContext({
    confidence: input.confidence,
    degraded: input.degraded,
    degradedReason: input.degradedReason,
    hostDeclaredIntent: input.hostDeclaredIntent,
    hostTurnMeta: input.hostTurnMeta,
    intentContext: input.intentContext,
    language: input.language,
    scenario: input.scenario,
    searchIntent: input.searchIntent,
    sessionHistory: input.sessionHistory,
    sourceRefs: input.sourceRefs,
    userQuery: input.q,
  });
  const hostIntentMeta = createHostIntentContextMeta(hostIntentContext);
  const intentSearchPlan = buildIntentSearchPlan({
    episodeStore: getOptionalIntentEpisodeStore(container),
    hostDeclaredIntent: input.hostDeclaredIntent,
    hostIntentContext,
    hostTurnMeta: input.hostTurnMeta,
    intentContext: input.intentContext,
    kind: input.type,
    mode: input.mode,
    rawQuery: input.q,
  });
  const query = intentSearchPlan.executableQuery || hostIntentContext.userQuery || input.q;
  const decisionRegisterView = readDecisionRegisterSearchableView(container, input, query);

  // 所有模式优先通过 SearchEngine（含 auto/bm25/semantic/keyword/ranking）
  try {
    const searchEngine = container.get('searchEngine');
    const startedAt = performance.now();
    const result = (await searchEngine.search(query, {
      type: input.type,
      limit: input.limit,
      mode: input.mode,
      groupByKind: input.groupByKind,
      ...(hostIntentMeta
        ? {
            context: {
              intent: hostIntentContext.searchIntent ?? hostIntentContext.scenario ?? 'search',
              language: hostIntentContext.language,
              sessionHistory: hostIntentContext.sessionHistory,
            },
          }
        : {}),
    })) as SearchResponse & SearchRouteResult;
    const mergedResult = mergeDecisionRegisterResults(result, decisionRegisterView, input);
    const durationMs = Math.round(performance.now() - startedAt);
    const searchMeta = await buildResidentSearchMeta({
      container,
      decisionRegisterView,
      durationMs,
      hostIntent: hostIntentMeta,
      intentSearchPlan,
      query,
      requestedMode: input.mode,
      result: mergedResult,
    });
    return void res.json({ success: true, data: { ...mergedResult, query, searchMeta } });
  } catch (err: unknown) {
    logger.warn('SearchEngine 搜索失败，降级到传统搜索', {
      mode: input.mode,
      error: (err as Error).message,
    });
  }

  const fallback = await buildSearchCompatibilityFallback({
    container,
    decisionRegisterView,
    input,
    query,
  });

  res.json({
    success: true,
    data: {
      query,
      type: input.type,
      mode: input.mode,
      totalResults: fallback.totalResults,
      searchMeta: await buildLegacySearchMeta({
        container,
        decisionRegisterView,
        hostIntent: hostIntentMeta,
        intentSearchPlan,
        items: fallback.decisionItems,
        mode: input.mode,
        resultCount: fallback.totalResults,
      }),
      ...fallback.results,
    },
  });
}

async function buildSearchCompatibilityFallback({
  container,
  decisionRegisterView,
  input,
  query,
}: {
  container: ReturnType<typeof getServiceContainer>;
  decisionRegisterView?: DecisionRegisterSearchableView | null;
  input: ResidentSearchInput;
  query: string;
}): Promise<{
  decisionItems: SearchRouteItem[];
  results: SearchFallbackResults;
  totalResults: number;
}> {
  const results: SearchFallbackResults = {};
  const pagination = { page: input.page, pageSize: input.limit };
  await appendKnowledgeFallbackResults({ container, input, pagination, query, results });
  await appendGuardFallbackResults({ container, input, pagination, query, results });
  appendDecisionRegisterFallbackResults({ decisionRegisterView, input, results });
  return {
    decisionItems: legacyDecisionRegisterItems(decisionRegisterView ?? null, input),
    results,
    totalResults: countSearchFallbackResults(results),
  };
}

async function appendKnowledgeFallbackResults({
  container,
  input,
  pagination,
  query,
  results,
}: {
  container: ReturnType<typeof getServiceContainer>;
  input: ResidentSearchInput;
  pagination: { page: number; pageSize: number };
  query: string;
  results: SearchFallbackResults;
}): Promise<void> {
  if (!shouldReadKnowledgeFallback(input.type)) {
    return;
  }
  try {
    const knowledgeService = container.get('knowledgeService');
    const searchResult = await knowledgeService.search(query, pagination);
    if (input.type === 'all') {
      results.recipes = searchResult;
      results.candidates = searchResult;
    } else if (input.type === 'candidate') {
      results.candidates = searchResult;
    } else {
      results.recipes = searchResult;
    }
  } catch (err: unknown) {
    logger.warn('Knowledge 搜索失败', { query, error: (err as Error).message });
    if (input.type === 'all' || input.type === 'recipe' || input.type === 'solution') {
      results.recipes = emptyFallbackPage(input);
    }
    if (input.type === 'all' || input.type === 'candidate') {
      results.candidates = emptyFallbackPage(input);
    }
  }
}

async function appendGuardFallbackResults({
  container,
  input,
  pagination,
  query,
  results,
}: {
  container: ReturnType<typeof getServiceContainer>;
  input: ResidentSearchInput;
  pagination: { page: number; pageSize: number };
  query: string;
  results: SearchFallbackResults;
}): Promise<void> {
  if (input.type !== 'all' && input.type !== 'rule') {
    return;
  }
  try {
    const guardService = container.get('guardService');
    results.rules = await guardService.searchRules(query, pagination);
  } catch (err: unknown) {
    logger.warn('Guard Rule 搜索失败', { query, error: (err as Error).message });
    results.rules = emptyFallbackPage(input);
  }
}

function appendDecisionRegisterFallbackResults({
  decisionRegisterView,
  input,
  results,
}: {
  decisionRegisterView?: DecisionRegisterSearchableView | null;
  input: ResidentSearchInput;
  results: SearchFallbackResults;
}): void {
  if (!decisionRegisterView || !shouldReadDecisionRegister(input.type)) {
    return;
  }
  const documents = decisionRegisterView.documents.filter(
    (document) => document.acceptedForRetrieval
  );
  if (documents.length === 0) {
    return;
  }
  results.decisions = {
    data: documents.map(decisionDocumentToSearchItem),
    pagination: {
      page: input.page,
      pageSize: input.limit,
      total: documents.length,
      pages: 1,
    },
  };
}

function shouldReadKnowledgeFallback(type: string): boolean {
  return type === 'all' || type === 'recipe' || type === 'solution' || type === 'candidate';
}

function emptyFallbackPage(input: ResidentSearchInput): {
  data: never[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
} {
  return {
    data: [],
    pagination: { page: input.page, pageSize: input.limit, total: 0, pages: 0 },
  };
}

function countSearchFallbackResults(results: SearchFallbackResults): number {
  return Object.values(results).reduce(
    (sum, result) =>
      sum +
      ((result.pagination as Record<string, number> | undefined)?.total ||
        result.data?.length ||
        0),
    0
  );
}

async function buildResidentSearchMeta({
  container,
  decisionRegisterView,
  durationMs,
  hostIntent,
  intentSearchPlan,
  query,
  requestedMode,
  result,
}: {
  container: ReturnType<typeof getServiceContainer>;
  decisionRegisterView?: DecisionRegisterSearchableView | null;
  durationMs: number;
  hostIntent?: HostIntentContextMeta | null;
  intentSearchPlan?: IntentSearchPlan | null;
  query: string;
  requestedMode: string;
  result: SearchRouteResult;
}): Promise<ResidentSearchMeta> {
  const coreMeta = result.searchMeta;
  const actualMode = String(coreMeta?.actualMode || result.mode || requestedMode);
  const vectorStats = await readVectorStats(container);
  const residentVector = buildResidentVectorMeta(vectorStats);
  const semanticRequested = requestedMode === 'semantic';
  // Core SearchResponse.searchMeta 是 semantic/vector 是否真实命中的唯一事实源。
  // Alembic resident service 只补 HTTP/workspace/vector-index 观测信息；不能用 rrf/hybrid 字符串二次推断，
  // 否则 embed 失败后的 sparse-only RRF 会被误报成真实向量命中。
  const semanticUsed =
    typeof coreMeta?.semanticUsed === 'boolean'
      ? coreMeta.semanticUsed
      : inferLegacySemanticUsageWithoutRrf(actualMode);
  const vectorUsed =
    typeof coreMeta?.vectorUsed === 'boolean'
      ? coreMeta.vectorUsed
      : hasVectorLikeScore(result.items ?? []);
  const fallbackReason = coreMeta?.fallbackReason ?? null;
  const degraded =
    Boolean(fallbackReason) ||
    (semanticRequested && !semanticUsed) ||
    Boolean(hostIntent?.degraded);
  const resultCount =
    typeof coreMeta?.resultCount === 'number'
      ? coreMeta.resultCount
      : typeof result.total === 'number'
        ? result.total
        : (result.items ?? []).length;
  const metaDurationMs =
    typeof coreMeta?.durationMs === 'number' ? coreMeta.durationMs : durationMs;
  const intentEvidence = await buildIntentEvidence({
    actualMode,
    decisionRegister: decisionRegisterContext(decisionRegisterView),
    intentSearchPlan,
    items: result.items ?? [],
    relationProvider: getOptionalRelationProvider(container),
    requestedMode,
    semanticUsed,
    vectorAvailable: residentVector.available,
    vectorUsed,
  });
  const primeInjectionPackage = buildPrimeInjectionPackage({
    decisionRegister: decisionRegisterContext(decisionRegisterView),
    hostIntent,
    intentEvidence,
    intentSearchPlan,
    items: result.items ?? [],
    search: {
      actualMode,
      filteredCount: resultCount,
      query,
      queries: intentSearchPlan?.lexicalQueries,
      requestedMode,
      resultCount,
    },
    semanticUsed,
    vectorAvailable: residentVector.available,
    vectorUsed,
  });
  const decisionRegister = buildDecisionRegisterMeta(decisionRegisterView);

  return {
    route: 'resident-search',
    service: 'alembic-daemon',
    coreRoute: typeof coreMeta?.route === 'string' ? coreMeta.route : null,
    requestedMode: coreMeta?.requestedMode ?? requestedMode,
    actualMode,
    semanticRequested,
    semanticUsed,
    vectorUsed,
    degraded,
    degradedReason:
      fallbackReason ??
      hostIntent?.degradedReason ??
      (degraded ? `semantic search requested but resident service returned ${actualMode}` : null),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(hostIntent
      ? {
          hostIntentApplied: true,
          hostIntentConfidence: hostIntent.confidence,
          hostIntentDegraded: hostIntent.degraded,
          hostIntentDegradedReason: hostIntent.degradedReason,
          hostIntentSourceRefs: hostIntent.sourceRefs,
        }
      : {}),
    ...(intentSearchPlan ? { intentSearchPlan: summarizeIntentSearchPlan(intentSearchPlan) } : {}),
    intentEvidence,
    primeInjectionPackage,
    decisionRegister,
    feedback: primeInjectionPackage.feedback,
    retrievalQuality: primeInjectionPackage.retrievalQuality,
    durationMs: metaDurationMs,
    resultCount,
    topScore: extractTopScore(result.items ?? []),
    residentVector,
    vector: {
      available: residentVector.available,
      reason: residentVector.reason,
      stats: residentVector.stats,
    },
    workspace: buildSearchWorkspaceIdentity(container),
  };
}

async function buildLegacySearchMeta({
  container,
  decisionRegisterView,
  hostIntent,
  intentSearchPlan,
  items,
  mode,
  resultCount,
}: {
  container: ReturnType<typeof getServiceContainer>;
  decisionRegisterView?: DecisionRegisterSearchableView | null;
  hostIntent?: HostIntentContextMeta | null;
  intentSearchPlan?: IntentSearchPlan | null;
  items?: SearchRouteItem[];
  mode: string;
  resultCount: number;
}): Promise<ResidentSearchMeta> {
  const degraded = mode === 'semantic' || Boolean(hostIntent?.degraded);
  const intentEvidence = await buildIntentEvidence({
    decisionRegister: decisionRegisterContext(decisionRegisterView),
    intentSearchPlan,
    items: items ?? [],
    relationProvider: getOptionalRelationProvider(container),
    requestedMode: mode,
    semanticUsed: false,
    vectorAvailable: false,
    vectorUsed: false,
  });
  const primeInjectionPackage = buildPrimeInjectionPackage({
    decisionRegister: decisionRegisterContext(decisionRegisterView),
    hostIntent,
    intentEvidence,
    intentSearchPlan,
    items: items ?? [],
    search: {
      actualMode: 'legacy-fallback',
      filteredCount: 0,
      query: intentSearchPlan?.executableQuery,
      queries: intentSearchPlan?.lexicalQueries,
      requestedMode: mode,
      resultCount,
    },
    semanticUsed: false,
    vectorAvailable: false,
    vectorUsed: false,
  });
  const decisionRegister = buildDecisionRegisterMeta(decisionRegisterView);
  return {
    route: 'resident-search',
    service: 'alembic-daemon',
    coreRoute: null,
    requestedMode: mode,
    actualMode: 'legacy-fallback',
    semanticRequested: mode === 'semantic',
    semanticUsed: false,
    vectorUsed: false,
    degraded,
    degradedReason:
      mode === 'semantic'
        ? 'SearchEngine unavailable; resident service used legacy non-vector fallback'
        : (hostIntent?.degradedReason ?? null),
    ...(hostIntent
      ? {
          hostIntentApplied: true,
          hostIntentConfidence: hostIntent.confidence,
          hostIntentDegraded: hostIntent.degraded,
          hostIntentDegradedReason: hostIntent.degradedReason,
          hostIntentSourceRefs: hostIntent.sourceRefs,
        }
      : {}),
    ...(intentSearchPlan ? { intentSearchPlan: summarizeIntentSearchPlan(intentSearchPlan) } : {}),
    intentEvidence,
    primeInjectionPackage,
    decisionRegister,
    feedback: primeInjectionPackage.feedback,
    retrievalQuality: primeInjectionPackage.retrievalQuality,
    durationMs: 0,
    resultCount,
    topScore: null,
    residentVector: {
      available: false,
      endpoint: RESIDENT_SEARCH_ENDPOINT,
      reason: 'SearchEngine unavailable; vector route was not attempted',
      stats: null,
    },
    vector: {
      available: false,
      reason: 'SearchEngine unavailable; vector route was not attempted',
      stats: null,
    },
    workspace: buildSearchWorkspaceIdentity(container),
  };
}

function getOptionalRelationProvider(
  container: ReturnType<typeof getServiceContainer>
): RelationEvidenceProvider | null {
  try {
    return container.get('knowledgeGraphService') as RelationEvidenceProvider;
  } catch {
    return null;
  }
}

function buildResidentVectorMeta({
  available,
  reason,
  stats,
}: {
  available: boolean;
  reason: string | null;
  stats: ResidentSearchVectorStats | null;
}): ResidentSearchMeta['residentVector'] {
  return {
    available,
    endpoint: RESIDENT_SEARCH_ENDPOINT,
    reason: available ? null : reason || 'vector service unavailable',
    stats,
  };
}

async function readVectorStats(container: ReturnType<typeof getServiceContainer>): Promise<{
  available: boolean;
  reason: string | null;
  stats: ResidentSearchVectorStats | null;
}> {
  try {
    const vectorService = container.get('vectorService') as unknown as {
      getStats?: () => Promise<{
        count?: number;
        dimension?: number;
        embedProviderAvailable?: boolean;
        indexSize?: number;
        quantized?: boolean;
      }>;
    } | null;
    if (!vectorService || typeof vectorService.getStats !== 'function') {
      return { available: false, reason: 'vectorService is not registered', stats: null };
    }

    const rawStats = await vectorService.getStats();
    const count = numberFrom(rawStats.count);
    const dimension = numberFrom(rawStats.dimension);
    const embedProviderAvailable = rawStats.embedProviderAvailable === true;
    return {
      available: count > 0 && dimension > 0 && embedProviderAvailable,
      reason:
        count > 0 && dimension > 0 && embedProviderAvailable
          ? null
          : 'vector index or embedding provider is unavailable',
      stats: {
        count,
        dimension,
        embedProviderAvailable,
        hasIndex: count > 0,
        indexSize: numberFrom(rawStats.indexSize),
        quantized: rawStats.quantized === true,
      },
    };
  } catch (err: unknown) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      stats: null,
    };
  }
}

function buildSearchWorkspaceIdentity(container: ReturnType<typeof getServiceContainer>) {
  const projectRoot = resolveProjectRoot(container);
  try {
    const resolver =
      (container.singletons?._workspaceResolver as WorkspaceResolver | undefined) ??
      resolveAlembicWorkspace(projectRoot);
    const facts = resolver.toFacts();
    return {
      dataRoot: resolver.dataRoot,
      dataRootSource: facts.dataRootSource,
      databasePath: resolver.databasePath,
      projectId: resolver.projectId,
      projectScope: facts.projectScope,
      projectScopeId: facts.projectScopeId,
      projectRoot: resolver.projectRoot,
      runtimeDir: resolver.runtimeDir,
      workspaceMode: facts.mode,
    };
  } catch {
    return {
      dataRoot: null,
      dataRootSource: null,
      databasePath: null,
      projectId: null,
      projectRoot,
      runtimeDir: null,
      workspaceMode: null,
    };
  }
}

function getOptionalIntentEpisodeStore(
  container: ReturnType<typeof getServiceContainer>
): IntentEpisodeStore | null {
  try {
    return container.get('intentEpisodeStore') as IntentEpisodeStore;
  } catch {
    return null;
  }
}

function readDecisionRegisterSearchableView(
  container: ReturnType<typeof getServiceContainer>,
  input: ResidentSearchInput,
  query: string
): DecisionRegisterSearchableView | null {
  if (!shouldReadDecisionRegister(input.type)) {
    return null;
  }
  try {
    const store = container.get('decisionRegisterStore') as DecisionRegisterStore | null;
    if (!store || typeof store.searchable !== 'function') {
      return null;
    }
    return store.searchable({
      limit: input.limit,
      query,
    });
  } catch {
    return null;
  }
}

function shouldReadDecisionRegister(type: string): boolean {
  return type === 'all' || type === 'decision' || type === 'decision-register';
}

function isDecisionRegisterOnly(type: string): boolean {
  return type === 'decision' || type === 'decision-register';
}

function mergeDecisionRegisterResults(
  result: SearchRouteResult,
  view: DecisionRegisterSearchableView | null,
  input: ResidentSearchInput
): SearchRouteResult {
  if (!view || !shouldReadDecisionRegister(input.type)) {
    return result;
  }
  const decisionItems = view.documents
    .filter((document) => document.acceptedForRetrieval)
    .map(decisionDocumentToSearchItem);
  if (decisionItems.length === 0 && !isDecisionRegisterOnly(input.type)) {
    return result;
  }
  const existingItems = Array.isArray(result.items) ? result.items : [];
  const mergedItems = dedupeSearchItems([
    ...decisionItems,
    ...(isDecisionRegisterOnly(input.type) ? [] : existingItems),
  ]).slice(0, input.limit);
  const existingTotal = typeof result.total === 'number' ? result.total : existingItems.length;
  return {
    ...result,
    items: mergedItems,
    total: isDecisionRegisterOnly(input.type)
      ? decisionItems.length
      : existingTotal + decisionItems.length,
  };
}

function legacyDecisionRegisterItems(
  view: DecisionRegisterSearchableView | null,
  input: ResidentSearchInput
): SearchRouteItem[] {
  if (!view || !shouldReadDecisionRegister(input.type)) {
    return [];
  }
  return view.documents
    .filter((document) => document.acceptedForRetrieval)
    .map(decisionDocumentToSearchItem)
    .slice(0, input.limit);
}

function decisionDocumentToSearchItem(
  document: DecisionRegisterSearchableDocument
): SearchRouteItem {
  return {
    acceptedForRetrieval: document.acceptedForRetrieval,
    content: document.content,
    decision: document.decision,
    decisionId: document.decisionId,
    id: document.id,
    kind: document.kind,
    knowledgeType: document.knowledgeType,
    metadata: document.metadata,
    retrievalLifecycle: document.retrievalLifecycle,
    score: document.score,
    sourceRefs: document.sourceRefs,
    status: document.status,
    tags: document.tags,
    title: document.title,
    trigger: document.trigger,
    whySelected: document.whySelected,
  };
}

function dedupeSearchItems(items: SearchRouteItem[]): SearchRouteItem[] {
  const seen = new Set<string>();
  const output: SearchRouteItem[] = [];
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : '';
    const key = id || JSON.stringify(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function decisionRegisterContext(view: DecisionRegisterSearchableView | null | undefined) {
  if (!view) {
    return null;
  }
  return {
    acceptedDecisionRefs: view.documents
      .filter((document) => document.acceptedForRetrieval)
      .map((document) => document.id),
    auditExcludedCount: view.auditExcludedCount,
    available: true,
  };
}

function buildDecisionRegisterMeta(
  view: DecisionRegisterSearchableView | null | undefined
): ResidentSearchMeta['decisionRegister'] {
  const acceptedDecisionRefs =
    view?.documents
      .filter((document) => document.acceptedForRetrieval)
      .map((document) => document.id)
      .slice(0, 16) ?? [];
  return {
    acceptedCount: acceptedDecisionRefs.length,
    acceptedDecisionRefs,
    auditExcludedCount: view?.auditExcludedCount ?? 0,
    available: Boolean(view),
    defaultLifecycle: 'active-effective-only',
    endpoint: '/api/v1/decision-register/searchable',
    excludedStatuses: ['revoked', 'deleted'],
    vectorAdmission: 'accepted-only',
  };
}

function inferLegacySemanticUsageWithoutRrf(actualMode: string): boolean {
  const normalized = actualMode.toLowerCase();
  return normalized === 'semantic' || normalized.includes('semantic') || normalized === 'hybrid';
}

function hasVectorLikeScore(items: SearchRouteItem[]): boolean {
  return items.some((item) => item.vectorScore !== undefined || item.semanticScore !== undefined);
}

function extractTopScore(items: SearchRouteItem[]): number | null {
  const firstScore = items[0]?.score ?? items[0]?.vectorScore ?? items[0]?.semanticScore;
  return typeof firstScore === 'number' && Number.isFinite(firstScore) ? firstScore : null;
}

function numberFrom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * GET /api/v1/search/graph
 * 知识图谱查询
 * ?nodeId=xxx&nodeType=recipe
 */
router.get(
  '/graph',
  validateQuery(GraphQuery),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId, nodeType, relation, direction = 'both' } = req.query as Record<string, string>;

    const container = getServiceContainer();
    const graphService = container.get('knowledgeGraphService');

    if (!graphService) {
      return void res.json({ success: true, data: { outgoing: [], incoming: [] } });
    }

    const edges = relation
      ? await graphService.getRelated(nodeId, nodeType, relation)
      : await graphService.getEdges(nodeId, nodeType, direction);

    res.json({ success: true, data: edges });
  }
);

/**
 * GET /api/v1/search/graph/impact
 * 影响分析
 */
router.get(
  '/graph/impact',
  validateQuery(GraphImpactQuery),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId, nodeType } = req.query as Record<string, string>;
    const maxDepth = safeInt(req.query.maxDepth, 3, 1, 5);

    const container = getServiceContainer();
    const graphService = container.get('knowledgeGraphService');

    if (!graphService) {
      return void res.json({ success: true, data: [] });
    }

    const impact = await graphService.getImpactAnalysis(nodeId, nodeType, maxDepth);
    res.json({ success: true, data: impact });
  }
);

/**
 * GET /api/v1/search/graph/all
 * 全量知识图谱边（Dashboard 可视化用）
 * ?limit=500
 */
router.get('/graph/all', async (req: Request, res: Response): Promise<void> => {
  const limit = safeInt(req.query.limit, 500, 1, 2000);

  const container = getServiceContainer();
  const graphService = container.get('knowledgeGraphService');

  if (!graphService) {
    return void res.json({ success: true, data: { edges: [], nodeLabels: {} } });
  }

  // 默认不过滤 nodeType，返回所有知识相关边（recipe + knowledge）
  // 仅当显式指定 nodeType 时才过滤（module 类由 /spm/dep-graph 提供）
  const rawNodeType = req.query.nodeType as string | undefined;
  const nodeType = rawNodeType === 'all' ? undefined : rawNodeType || undefined;
  // 取更多原始边，因为 UUID 过滤会淘汰大量非 UUID 的代码分析边（method/class 等）
  // LIMIT 在 UUID 过滤之后应用，确保不会因为非 UUID 边占满配额导致返回 0
  const allEdges = await graphService.getAllEdges(limit * 10, nodeType);

  // 过滤掉非 UUID 节点（AI 生成的类名引用等幽灵节点）
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const edges = allEdges
    .filter((e) => UUID_RE.test(e.fromId) && UUID_RE.test(e.toId))
    .slice(0, limit);

  // 收集节点 ID + 类型 → 按类型查标签
  const nodeMap = new Map(); // id → Set<type>
  for (const e of edges) {
    if (!nodeMap.has(e.fromId)) {
      nodeMap.set(e.fromId, new Set());
    }
    nodeMap.get(e.fromId).add(e.fromType);
    if (!nodeMap.has(e.toId)) {
      nodeMap.set(e.toId, new Set());
    }
    nodeMap.get(e.toId).add(e.toType);
  }

  const nodeLabels: Record<string, string> = {};
  const nodeTypes: Record<string, string> = {}; // id → 主要类型（供前端区分渲染）
  const nodeCategories: Record<string, string> = {}; // id → category/target 名（供前端分组布局）
  if (nodeMap.size > 0) {
    const knowledgeRepo = container.get('knowledgeRepository');
    for (const [id, types] of nodeMap) {
      const primaryType = types.has('recipe') ? 'recipe' : [...types][0];
      nodeTypes[id] = primaryType;

      if ((primaryType === 'recipe' || primaryType === 'knowledge') && knowledgeRepo) {
        try {
          const r = (await knowledgeRepo.findById(id)) as {
            title?: string;
            category?: string;
          } | null;
          if (r) {
            nodeLabels[id] = r.title || id;
            nodeCategories[id] = r.category || '';
            continue;
          }
        } catch {
          /* not found – fall through */
        }
      }
      nodeLabels[id] = id;
    }
  }

  res.json({ success: true, data: { edges, nodeLabels, nodeTypes, nodeCategories } });
});

/**
 * GET /api/v1/search/graph/stats
 * 图谱统计
 */
router.get('/graph/stats', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const graphService = container.get('knowledgeGraphService');

  if (!graphService) {
    return void res.json({
      success: true,
      data: { totalEdges: 0, byRelation: {}, nodeTypes: [] },
    });
  }

  const rawStatsType = req.query.nodeType as string | undefined;
  const statsNodeType = rawStatsType === 'all' ? undefined : rawStatsType || undefined;
  const stats = await graphService.getStats(statsNodeType);
  res.json({ success: true, data: stats });
});

/**
 * POST /api/v1/search/context-aware
 * 上下文感知搜索 — SearchEngine 内置 Ranking Pipeline（CoarseRanker + MultiSignalRanker + ContextBoost）
 */
router.post(
  '/context-aware',
  validate(ContextAwareSearchBody),
  async (req: Request, res: Response): Promise<void> => {
    const { keyword, limit, language, sessionHistory } = req.body;
    const t0 = Date.now();
    const container = getServiceContainer();
    const pageSize = Math.min(limit || 10, 100);
    let results: Record<string, unknown>[] = [];
    let source = 'knowledgeService';

    // SearchEngine BM25 + 内置 Ranking Pipeline
    try {
      const searchEngine = container.get('searchEngine');
      const result = await searchEngine.search(keyword, {
        mode: 'bm25',
        limit: pageSize,
        rank: true,
        context: { intent: 'search', language, sessionHistory: sessionHistory || [] },
      });
      const items = result?.items || [];
      if (items.length > 0) {
        source = result.ranked ? 'search-engine+ranking' : 'search-engine';
        results = items.map((r: SearchEngineItem) => {
          let contentStr = '';
          try {
            const c =
              typeof r.content === 'string' && r.content.startsWith('{')
                ? JSON.parse(r.content)
                : r.content || {};
            contentStr = c.pattern || c.markdown || c.code || '';
          } catch {
            contentStr = (r.content || r.code || '') as string;
          }
          return {
            name: `${r.title || r.id}.md`,
            content: contentStr,
            similarity: r.score || 0,
            authority: r.authorityScore || 0,
            matchType: result.ranked ? 'ranked' : 'bm25',
            qualityScore: r.qualityScore || 0,
            usageCount: r.usageCount || 0,
          };
        });
      }
    } catch (err: unknown) {
      logger.warn('SearchEngine context-aware 失败，降级到 KnowledgeService', {
        error: (err as Error).message,
      });
    }

    // 降级: SearchEngine 完全不可用时，KnowledgeService SQL LIKE (Dashboard 冷启动)
    if (results.length === 0) {
      try {
        const knowledgeService = container.get('knowledgeService');
        const list = await knowledgeService.search(keyword, { page: 1, pageSize });
        const items = list.data || [];
        results = items.map((r: KnowledgeItem) => ({
          name: `${r.title || r.id}.md`,
          content: r.content?.pattern || r.content?.markdown || '',
          similarity: 1,
          authority: r.quality?.overall || 0,
          matchType: 'keyword',
          qualityScore: r.quality?.overall || 0,
        }));
        source = 'knowledgeService';
      } catch {
        /* 全部失败 */
      }
    }

    const elapsed = Date.now() - t0;
    res.json({
      success: true,
      data: {
        results,
        context: {},
        total: results.length,
        hasAiEvaluation: false,
        searchTime: elapsed,
        source,
      },
    });
  }
);

/* ═══ 相似度检测 ════════════════════════════════════════ */

/**
 * POST /api/v1/search/similarity
 * 候选与已有 Recipe 的相似度检测
 * Body: { code, language } 或 { targetName, candidateId } 或 { candidate: {title, summary, code} }
 */
router.post(
  '/similarity',
  validate(SimilarityBody),
  async (req: Request, res: Response): Promise<void> => {
    const { code, targetName, candidateId, candidate } = req.body;
    let dataRoot: string;
    try {
      const { resolveDataRoot } = await import('@alembic/core/workspace');
      const container = getServiceContainer();
      dataRoot = resolveDataRoot(container) || process.env.ALEMBIC_PROJECT_DIR || process.cwd();
    } catch {
      dataRoot = process.env.ALEMBIC_PROJECT_DIR || process.cwd();
    }

    let candidateObj:
      | { title: string; summary: string; code: string; usageGuide: string }
      | undefined;

    if (candidateId && targetName) {
      // 从知识库加载候选
      try {
        const container = getServiceContainer();
        const knowledgeService = container.get('knowledgeService');
        const entry = await knowledgeService.get(candidateId);
        if (entry) {
          const json = typeof entry.toJSON === 'function' ? entry.toJSON() : entry;
          candidateObj = {
            title: json.title || '',
            summary: json.description || '',
            code: json.content?.pattern || '',
            usageGuide: json.content?.markdown || '',
          };
        }
      } catch (err: unknown) {
        logger.warn('similarity: failed to load candidate', {
          candidateId,
          error: (err as Error).message,
        });
      }
    } else if (candidate) {
      candidateObj = {
        title: candidate.title || '',
        summary: candidate.summary || candidate.description || '',
        code: candidate.code || candidate.pattern || '',
        usageGuide: candidate.usageGuide || candidate.markdown || '',
      };
    } else if (code) {
      candidateObj = { title: '', summary: '', code: code || '', usageGuide: '' };
    }

    if (!candidateObj) {
      return void res.json({ success: true, data: { similar: [] } });
    }

    try {
      const { findSimilarRecipes } = await import('@alembic/core/service/candidate');
      const similar = findSimilarRecipes(dataRoot, candidateObj, { threshold: 0.3, topK: 10 });

      // 映射为前端期望格式
      const mapped = similar.map((s) => ({
        recipeName: s.title || s.file?.replace(/\.md$/, '') || '',
        similarity: s.similarity,
        file: s.file,
      }));

      res.json({ success: true, data: { similar: mapped } });
    } catch (err: unknown) {
      logger.warn('similarity search failed', { error: (err as Error).message });
      res.json({ success: true, data: { similar: [] } });
    }
  }
);

export default router;
