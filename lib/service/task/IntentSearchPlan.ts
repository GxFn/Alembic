import path from 'node:path';
import type { NormalizedHostIntentContext } from './HostIntentContext.js';
import type { IntentEpisodeRecord, IntentEpisodeStore } from './IntentEpisodeStore.js';
import type { ExtractedIntent } from './IntentExtractor.js';

export type IntentSearchPlanRankingProfile =
  | 'bm25-intent'
  | 'keyword-intent'
  | 'prime-intent'
  | 'raw-fallback'
  | 'semantic-observe';

export interface IntentSearchPlanEpisodeSummary {
  episodeId: string;
  query?: string;
  sourceRefs: string[];
  status: string;
}

export interface IntentSearchPlan {
  applied: boolean;
  confidence?: number;
  degraded: boolean;
  degradedReasons: string[];
  episode?: {
    latest: IntentSearchPlanEpisodeSummary | null;
    recent: IntentSearchPlanEpisodeSummary[];
    sessionSource: string | null;
  };
  executableQuery: string;
  filters: {
    kind?: string;
    language?: string;
    scenario?: string;
  };
  lexicalQueries: string[];
  negativeSignals: string[];
  omitted: string[];
  rankingProfile: IntentSearchPlanRankingProfile;
  requestedMode: string;
  sourcePath: string[];
  sourceRefs: string[];
  version: 1;
  whySelected: string[];
}

export interface BuildIntentSearchPlanOptions {
  episodeStore?: IntentEpisodeStore | null;
  hostDeclaredIntent?: unknown;
  hostIntentContext: NormalizedHostIntentContext;
  hostTurnMeta?: unknown;
  intentContext?: unknown;
  kind?: string;
  mode?: string;
  rawQuery: string;
}

const MIN_EXECUTABLE_CONFIDENCE = 0.5;
const MAX_QUERY_COUNT = 6;
const MAX_QUERY_LENGTH = 280;

export function buildIntentSearchPlan(options: BuildIntentSearchPlanOptions): IntentSearchPlan {
  const requestedMode = normalizeMode(options.mode);
  const intentContext = asRecord(options.intentContext);
  const declared = asRecord(options.hostDeclaredIntent);
  const draft =
    asRecord(intentContext?.recognizedIntentDraft) ?? asRecord(declared?.recognizedIntentDraft);
  const latestEpisode = readLatestEpisode(options);
  const recentEpisodes = readRecentEpisodes(options);
  const confidence = numberValue(draft?.confidence) ?? options.hostIntentContext.confidence;
  const draftStatus = stringValue(draft?.status);
  const draftQuery = stringValue(draft?.query);
  const degradedReasons = uniqueStrings([
    ...stringsFrom(draft?.degradedReasons),
    options.hostIntentContext.degradedReason,
  ]);
  const sourceRefs = uniqueStrings([
    ...redactRefs(options.hostIntentContext.sourceRefs),
    ...redactRefs(draft?.sourceRefs),
    ...redactRefs(latestEpisode?.sourceRefs),
  ]).slice(0, 24);
  const canUseDraft =
    Boolean(draftQuery) &&
    (draftStatus === '' || draftStatus === 'recognized') &&
    (confidence === undefined || confidence >= MIN_EXECUTABLE_CONFIDENCE) &&
    draft?.degraded !== true &&
    !options.hostIntentContext.degraded;
  const lexicalMode = isLexicalMode(requestedMode);
  const whySelected: string[] = [];
  const omitted: string[] = [];
  const sourcePath: string[] = [];
  const negativeSignals: string[] = [];

  if (draft) {
    sourcePath.push('intentContext.recognizedIntentDraft');
  }
  if (latestEpisode) {
    sourcePath.push('intentEpisode.latest');
  }
  if (!draftQuery && draft) {
    omitted.push('recognizedIntentDraft.queryMissing');
  }
  if (draftStatus && draftStatus !== 'recognized') {
    omitted.push(`recognizedIntentDraft.status:${draftStatus}`);
    negativeSignals.push(`status:${draftStatus}`);
  }
  if (confidence !== undefined && confidence < MIN_EXECUTABLE_CONFIDENCE) {
    omitted.push('recognizedIntentDraft.lowConfidence');
    negativeSignals.push('low-confidence');
  }
  if (draft?.degraded === true || options.hostIntentContext.degraded) {
    omitted.push('recognizedIntentDraft.degraded');
    negativeSignals.push('degraded');
  }
  if (!lexicalMode) {
    omitted.push(`mode:${requestedMode}:observeOnly`);
  }

  const lexicalQueries = uniqueStrings([
    ...(canUseDraft && lexicalMode ? [draftQuery] : []),
    ...(canUseDraft && lexicalMode ? stringsFrom(draft?.constraints) : []),
    ...(canUseDraft && lexicalMode ? [stringValue(draft?.target)] : []),
    ...(canUseDraft && lexicalMode ? options.hostIntentContext.queryHints : []),
    ...(canUseDraft && lexicalMode ? options.hostIntentContext.keywordHints : []),
    ...(canUseDraft && lexicalMode && latestEpisode?.query ? [latestEpisode.query] : []),
    options.rawQuery,
  ])
    .map((query) => trimQuery(query))
    .filter(Boolean)
    .slice(0, MAX_QUERY_COUNT);

  if (canUseDraft && lexicalMode) {
    whySelected.push('recognizedIntentDraft.query');
    if (stringsFrom(draft?.constraints).length > 0) {
      whySelected.push('recognizedIntentDraft.constraints');
    }
    if (latestEpisode?.query) {
      whySelected.push('intentEpisode.latest.query');
    }
    if (sourceRefs.length > 0) {
      whySelected.push('sourceRefs');
    }
  }

  const applied = canUseDraft && lexicalMode;
  const executableQuery = applied
    ? trimQuery(lexicalQueries.join(' '))
    : trimQuery(options.hostIntentContext.userQuery || options.rawQuery);

  return {
    applied,
    ...(confidence !== undefined ? { confidence } : {}),
    degraded: degradedReasons.length > 0 || !applied,
    degradedReasons: uniqueStrings(degradedReasons),
    episode: {
      latest: summarizeEpisode(latestEpisode),
      recent: recentEpisodes.map(summarizeEpisode).filter(isEpisodeSummary),
      sessionSource: resolveEpisodeSession(options.hostTurnMeta)?.source ?? null,
    },
    executableQuery,
    filters: {
      ...(options.kind && options.kind !== 'all' ? { kind: options.kind } : {}),
      ...(options.hostIntentContext.language
        ? { language: options.hostIntentContext.language }
        : {}),
      ...(options.hostIntentContext.scenario
        ? { scenario: options.hostIntentContext.scenario }
        : {}),
    },
    lexicalQueries: lexicalQueries.length > 0 ? lexicalQueries : [executableQuery],
    negativeSignals: uniqueStrings(negativeSignals),
    omitted: uniqueStrings(omitted),
    rankingProfile: applied ? rankingProfileFor(requestedMode) : fallbackProfileFor(requestedMode),
    requestedMode,
    sourcePath,
    sourceRefs,
    version: 1,
    whySelected,
  };
}

export function applyIntentSearchPlanToExtractedIntent(
  intent: ExtractedIntent,
  plan: IntentSearchPlan | null | undefined
): ExtractedIntent {
  if (!plan?.applied) {
    return intent;
  }
  return {
    ...intent,
    keywordQueries: uniqueStrings([...plan.lexicalQueries.slice(1), ...intent.keywordQueries]),
    queries: uniqueStrings([plan.executableQuery, ...plan.lexicalQueries, ...intent.queries]),
  };
}

export function summarizeIntentSearchPlan(plan: IntentSearchPlan): IntentSearchPlan {
  return {
    ...plan,
    episode: {
      latest: plan.episode?.latest ?? null,
      recent: plan.episode?.recent ?? [],
      sessionSource: plan.episode?.sessionSource ?? null,
    },
  };
}

function readLatestEpisode(options: BuildIntentSearchPlanOptions): IntentEpisodeRecord | null {
  const session = resolveEpisodeSession(options.hostTurnMeta);
  if (!session || !options.episodeStore) {
    return null;
  }
  try {
    return options.episodeStore.latest({ sessionId: session.sessionId });
  } catch (err: unknown) {
    process.stderr.write(
      `[IntentSearchPlan] latest episode read failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return null;
  }
}

function readRecentEpisodes(options: BuildIntentSearchPlanOptions): IntentEpisodeRecord[] {
  const session = resolveEpisodeSession(options.hostTurnMeta);
  if (!session || !options.episodeStore) {
    return [];
  }
  try {
    return options.episodeStore.recent({ limit: 3, sessionId: session.sessionId });
  } catch (err: unknown) {
    process.stderr.write(
      `[IntentSearchPlan] recent episode read failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return [];
  }
}

function resolveEpisodeSession(
  hostTurnMeta: unknown
): { sessionId: string; source: string } | null {
  const turn = asRecord(hostTurnMeta);
  const threadIdHash = stringValue(turn?.threadIdHash);
  if (threadIdHash) {
    return { sessionId: `thread:${threadIdHash}`, source: 'host-thread-hash' };
  }
  const conversationIdHash = stringValue(turn?.conversationIdHash);
  if (conversationIdHash) {
    return { sessionId: `conversation:${conversationIdHash}`, source: 'host-conversation-hash' };
  }
  const sessionIdHash = stringValue(turn?.sessionIdHash);
  if (sessionIdHash) {
    return { sessionId: `host-session:${sessionIdHash}`, source: 'host-session-hash' };
  }
  return null;
}

function summarizeEpisode(
  episode: IntentEpisodeRecord | null | undefined
): IntentSearchPlanEpisodeSummary | null {
  if (!episode) {
    return null;
  }
  return {
    episodeId: episode.episodeId,
    ...(episode.query ? { query: episode.query } : {}),
    sourceRefs: redactRefs(episode.sourceRefs).slice(0, 12),
    status: episode.status,
  };
}

function isEpisodeSummary(
  episode: IntentSearchPlanEpisodeSummary | null
): episode is IntentSearchPlanEpisodeSummary {
  return episode !== null;
}

function isLexicalMode(mode: string): boolean {
  return mode === 'keyword' || mode === 'bm25' || mode === 'weighted' || mode === 'prime';
}

function rankingProfileFor(mode: string): IntentSearchPlanRankingProfile {
  if (mode === 'keyword') {
    return 'keyword-intent';
  }
  if (mode === 'prime') {
    return 'prime-intent';
  }
  return 'bm25-intent';
}

function fallbackProfileFor(mode: string): IntentSearchPlanRankingProfile {
  return mode === 'semantic' ? 'semantic-observe' : 'raw-fallback';
}

function normalizeMode(mode: string | undefined): string {
  const normalized = stringValue(mode)?.toLowerCase();
  return normalized || 'bm25';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : undefined;
  }
  return undefined;
}

function stringsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsFrom(item));
  }
  const normalized = stringValue(value);
  return normalized ? [normalized] : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = stringValue(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function trimQuery(value: string | undefined): string {
  return stringValue(value)?.slice(0, MAX_QUERY_LENGTH) ?? '';
}

function redactRefs(value: unknown): string[] {
  return stringsFrom(value)
    .map((ref) => {
      const withoutNulls = ref.replace(/\0/g, '');
      if (path.isAbsolute(withoutNulls)) {
        return `[absolute-path]/${path.basename(withoutNulls)}`;
      }
      return withoutNulls
        .replace(/\\/g, '/')
        .replace(/\.\.(\/|$)/g, '')
        .replace(/^\/+/, '');
    })
    .filter(Boolean);
}
