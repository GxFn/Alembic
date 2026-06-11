/**
 * Plugin host intent context consumer adapter.
 *
 * AO2 keeps the resident MCP input schema stable while making the internal mode
 * explicit. Plugin may pass a small host-declared intent frame; Alembic still
 * owns the legacy userQuery / activeFile / language fallback until the recorded
 * cleanup trigger is satisfied.
 */

import {
  HOST_INTENT_CONTEXT_MODES,
  HOST_INTENT_LEGACY_COMPATIBILITY,
  type HostIntentContextMode,
} from '../../shared/semantic-taxonomy.js';
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
  hostIntentMode?: unknown;
  hostDeclaredIntent?: unknown;
  hostTurnMeta?: unknown;
  intentContext?: unknown;
}

export interface NormalizedHostIntentContext {
  activeFile?: string;
  applied: boolean;
  confidence?: number;
  compatibility: HostIntentCompatibilityPolicy;
  degraded: boolean;
  degradedReason?: string;
  keywordHints: string[];
  language?: string;
  mode: HostIntentContextMode;
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
  compatibility: HostIntentCompatibilityPolicy;
  degraded: boolean;
  degradedReason?: string;
  mode: HostIntentContextMode;
  scenario?: SearchScenario;
  searchIntent?: string;
  sessionHistoryCount: number;
  sourceRefs: string[];
  sources: string[];
}

export interface HostIntentCompatibilityPolicy {
  consumer: 'alembic-plugin';
  cleanupTrigger: string;
  fallbackAllowed: boolean;
  fallbackFields: string[];
  mode: HostIntentContextMode;
  owner: 'alembic-main';
  redacted: true;
  removalCondition: string;
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

  const userQuery = resolveHostIntentUserQuery(input, declared, context, turn);
  const activeFile = resolveHostIntentActiveFile(input, declared, context, turn);
  const language = resolveHostIntentLanguage(input, declared, context, turn);
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
    sourceName(declared, 'hostDeclaredIntent'),
    sourceName(context, 'intentContext'),
    sourceName(turn, 'hostTurnMeta'),
  ].filter((source): source is string => Boolean(source));
  const legacyFields = hostIntentLegacyFields(input);
  const mode = resolveHostIntentMode(input.hostIntentMode, {
    hostIntentFramePresent: records.length > 0,
    legacyFields,
  });
  const applied = hasAppliedHostIntentContext({
    confidence,
    degraded,
    keywordHints,
    queryHints,
    records,
    sessionHistory,
    sourceRefs,
  });

  return {
    activeFile,
    applied,
    confidence,
    compatibility: buildHostIntentCompatibilityPolicy(mode, legacyFields),
    degraded,
    degradedReason,
    keywordHints,
    language,
    mode,
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
    compatibility: context.compatibility,
    degraded: context.degraded,
    degradedReason: context.degradedReason,
    mode: context.mode,
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

function sourceName(record: Record<string, unknown> | null, name: string): string | null {
  return record ? name : null;
}

function resolveHostIntentUserQuery(
  input: HostIntentContextInput,
  declared: Record<string, unknown> | null,
  context: Record<string, unknown> | null,
  turn: Record<string, unknown> | null
): string {
  return (
    firstString([
      declared?.query,
      declared?.normalizedQuery,
      context?.query,
      turn?.userQuery,
      turn?.prompt,
      input.userQuery,
    ]) ?? ''
  );
}

function resolveHostIntentActiveFile(
  input: HostIntentContextInput,
  declared: Record<string, unknown> | null,
  context: Record<string, unknown> | null,
  turn: Record<string, unknown> | null
): string | undefined {
  return (
    firstString([
      turn?.activeFile,
      turn?.currentFile,
      context?.activeFile,
      declared?.activeFile,
      input.activeFile,
    ]) ?? undefined
  );
}

function resolveHostIntentLanguage(
  input: HostIntentContextInput,
  declared: Record<string, unknown> | null,
  context: Record<string, unknown> | null,
  turn: Record<string, unknown> | null
): string | undefined {
  return (
    firstString([declared?.language, context?.language, turn?.language, input.language]) ??
    undefined
  );
}

function hasAppliedHostIntentContext(options: {
  confidence?: number;
  degraded: boolean;
  keywordHints: string[];
  queryHints: string[];
  records: Record<string, unknown>[];
  sessionHistory: Array<{ content: string }>;
  sourceRefs: string[];
}): boolean {
  return (
    options.records.length > 0 ||
    options.sessionHistory.length > 0 ||
    options.sourceRefs.length > 0 ||
    options.queryHints.length > 0 ||
    options.keywordHints.length > 0 ||
    options.confidence !== undefined ||
    options.degraded
  );
}

function buildHostIntentCompatibilityPolicy(
  mode: HostIntentContextMode,
  fallbackFields: string[]
): HostIntentCompatibilityPolicy {
  return {
    cleanupTrigger: HOST_INTENT_LEGACY_COMPATIBILITY.cleanupTrigger,
    consumer: HOST_INTENT_LEGACY_COMPATIBILITY.consumer,
    fallbackAllowed: fallbackFields.length > 0,
    fallbackFields,
    mode,
    owner: HOST_INTENT_LEGACY_COMPATIBILITY.owner,
    redacted: true,
    removalCondition: HOST_INTENT_LEGACY_COMPATIBILITY.cleanupTrigger,
  };
}

function resolveHostIntentMode(
  explicitMode: unknown,
  options: { hostIntentFramePresent: boolean; legacyFields: string[] }
): HostIntentContextMode {
  const normalized = stringValue(explicitMode);
  if (normalized && HOST_INTENT_CONTEXT_MODES.includes(normalized as HostIntentContextMode)) {
    return normalized as HostIntentContextMode;
  }
  if (options.hostIntentFramePresent) {
    return options.legacyFields.length > 0
      ? 'mixed-host-intent-and-legacy-args'
      : 'host-intent-frame';
  }
  return 'legacy-args-only';
}

function hostIntentLegacyFields(input: HostIntentContextInput): string[] {
  const fields: string[] = [];
  if (stringValue(input.userQuery)) {
    fields.push('userQuery');
  }
  if (stringValue(input.activeFile)) {
    fields.push('activeFile');
  }
  if (stringValue(input.language)) {
    fields.push('language');
  }
  return fields;
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
