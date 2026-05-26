/**
 * Plugin host intent context consumer adapter.
 *
 * Stage 1 keeps the contract Alembic-side and permissive: Plugin may pass a
 * small host-declared intent frame, while Alembic still falls back to the
 * legacy userQuery / activeFile / language path when that frame is absent.
 */

import type { ExtractedIntent, SearchScenario } from './IntentExtractor.js';

const VALID_SCENARIOS = new Set<SearchScenario>(['lint', 'generate', 'search', 'learning']);

export interface HostIntentContextInput {
  userQuery?: unknown;
  activeFile?: unknown;
  language?: unknown;
  sessionHistory?: unknown;
  sourceRefs?: unknown;
  confidence?: unknown;
  degraded?: unknown;
  degradedReason?: unknown;
  searchIntent?: unknown;
  scenario?: unknown;
  hostDeclaredIntent?: unknown;
  hostTurnMeta?: unknown;
  intentContext?: unknown;
}

export interface NormalizedHostIntentContext {
  activeFile?: string;
  applied: boolean;
  confidence?: number;
  degraded: boolean;
  degradedReason?: string;
  keywordHints: string[];
  language?: string;
  queryHints: string[];
  scenario?: SearchScenario;
  searchIntent?: string;
  sessionHistory: Array<{ content: string }>;
  sourceRefs: string[];
  sources: string[];
  userQuery: string;
}

export interface HostIntentContextMeta {
  applied: boolean;
  confidence?: number;
  degraded: boolean;
  degradedReason?: string;
  scenario?: SearchScenario;
  searchIntent?: string;
  sessionHistoryCount: number;
  sourceRefs: string[];
  sources: string[];
}

export function normalizeHostIntentContext(
  input: HostIntentContextInput
): NormalizedHostIntentContext {
  const declared = asRecord(input.hostDeclaredIntent);
  const turn = asRecord(input.hostTurnMeta);
  const context = asRecord(input.intentContext);
  const records = [declared, context, turn].filter((record): record is Record<string, unknown> =>
    Boolean(record)
  );

  const queryHints = uniqueStrings([
    ...stringsFrom(declared?.queries),
    ...stringsFrom(declared?.queryHints),
    ...stringsFrom(context?.queries),
    ...stringsFrom(context?.queryHints),
    stringValue(declared?.normalizedQuery),
    stringValue(declared?.query),
    stringValue(context?.query),
  ]);
  const keywordHints = uniqueStrings([
    ...stringsFrom(declared?.keywords),
    ...stringsFrom(declared?.terms),
    ...stringsFrom(context?.keywords),
    ...stringsFrom(context?.terms),
  ]);
  const sessionHistory = normalizeSessionHistory([
    input.sessionHistory,
    turn?.sessionHistory,
    context?.sessionHistory,
    turn?.recentTurns,
  ]);
  const sourceRefs = uniqueStrings([
    ...stringsFrom(input.sourceRefs),
    ...stringsFrom(declared?.sourceRefs),
    ...stringsFrom(context?.sourceRefs),
    ...stringsFrom(turn?.sourceRefs),
    ...stringsFrom(declared?.referencedFiles),
    ...stringsFrom(context?.referencedFiles),
  ]).slice(0, 20);

  const userQuery =
    firstString([
      declared?.query,
      declared?.normalizedQuery,
      context?.query,
      turn?.userQuery,
      turn?.prompt,
      input.userQuery,
    ]) ?? '';
  const activeFile =
    firstString([
      turn?.activeFile,
      turn?.currentFile,
      context?.activeFile,
      declared?.activeFile,
      input.activeFile,
    ]) ?? undefined;
  const language =
    firstString([declared?.language, context?.language, turn?.language, input.language]) ??
    undefined;
  const scenario = scenarioValue(
    firstString([
      input.scenario,
      declared?.scenario,
      context?.scenario,
      declared?.intent,
      context?.intent,
    ])
  );
  const searchIntent =
    firstString([
      input.searchIntent,
      declared?.intent,
      context?.intent,
      declared?.label,
      context?.label,
    ]) ?? scenario;
  const confidence = numberValue(
    firstDefined([declared?.confidence, context?.confidence, input.confidence])
  );
  const degradedReason =
    firstString([
      declared?.degradedReason,
      context?.degradedReason,
      input.degradedReason,
      declared?.fallbackReason,
      context?.fallbackReason,
    ]) ?? undefined;
  const degraded =
    declared?.degraded === true ||
    context?.degraded === true ||
    turn?.degraded === true ||
    input.degraded === true ||
    Boolean(degradedReason);
  const sources = [
    declared ? 'hostDeclaredIntent' : null,
    context ? 'intentContext' : null,
    turn ? 'hostTurnMeta' : null,
  ].filter((source): source is string => Boolean(source));
  const applied =
    records.length > 0 ||
    sessionHistory.length > 0 ||
    sourceRefs.length > 0 ||
    queryHints.length > 0 ||
    keywordHints.length > 0 ||
    confidence !== undefined ||
    degraded;

  return {
    activeFile,
    applied,
    confidence,
    degraded,
    degradedReason,
    keywordHints,
    language,
    queryHints,
    scenario,
    searchIntent,
    sessionHistory,
    sourceRefs,
    sources,
    userQuery,
  };
}

export function applyHostIntentContext(
  intent: ExtractedIntent,
  context: NormalizedHostIntentContext
): ExtractedIntent {
  if (!context.applied) {
    return intent;
  }
  return {
    ...intent,
    keywordQueries: uniqueStrings([...intent.keywordQueries, ...context.keywordHints]),
    language: context.language ?? intent.language,
    queries: uniqueStrings([...intent.queries, ...context.queryHints]),
    raw: {
      activeFile: context.activeFile,
      language: context.language,
      userQuery: context.userQuery,
    },
    scenario: context.scenario ?? intent.scenario,
  };
}

export function createHostIntentContextMeta(
  context: NormalizedHostIntentContext
): HostIntentContextMeta | null {
  if (!context.applied) {
    return null;
  }
  return {
    applied: true,
    confidence: context.confidence,
    degraded: context.degraded,
    degradedReason: context.degradedReason,
    scenario: context.scenario,
    searchIntent: context.searchIntent,
    sessionHistoryCount: context.sessionHistory.length,
    sourceRefs: context.sourceRefs,
    sources: context.sources,
  };
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

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function firstDefined(values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampConfidence(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return clampConfidence(parsed);
    }
  }
  return undefined;
}

function clampConfidence(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function stringsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsFrom(item));
  }
  if (typeof value === 'string') {
    return stringValue(value) ? [stringValue(value) as string] : [];
  }
  return [];
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

function normalizeSessionHistory(values: unknown[]): Array<{ content: string }> {
  const result: Array<{ content: string }> = [];
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      const content = typeof item === 'string' ? item : firstString([asRecord(item)?.content]);
      if (content) {
        result.push({ content });
      }
      if (result.length >= 8) {
        return result;
      }
    }
  }
  return result;
}

function scenarioValue(value: string | undefined): SearchScenario | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return VALID_SCENARIOS.has(normalized as SearchScenario)
    ? (normalized as SearchScenario)
    : undefined;
}
