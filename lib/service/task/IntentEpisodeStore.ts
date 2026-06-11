import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { IntentEvidence } from './IntentEvidence.js';
import type { IntentSearchPlan } from './IntentSearchPlan.js';
import type { PrimeInjectionPackage } from './PrimeInjectionPackage.js';

export type IntentEpisodeStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface IntentEpisodeWorkspaceIdentity {
  dataRootSource?: string | null;
  projectId?: string | null;
  projectScopeId?: string | null;
  workspaceMode?: string | null;
}

export interface IntentEpisodeHostIntentMeta {
  applied?: boolean;
  compatibility?: {
    cleanupTrigger?: string;
    consumer?: string;
    fallbackAllowed?: boolean;
    fallbackFields?: string[];
    mode?: string;
    owner?: string;
    redacted?: boolean;
    removalCondition?: string;
  };
  confidence?: number;
  degraded?: boolean;
  degradedReason?: string;
  scenario?: string;
  searchIntent?: string;
  sessionHistoryCount?: number;
  sourceRefs?: string[];
  sources?: string[];
}

export interface IntentEpisodeSearchMeta {
  filteredCount?: number;
  hostIntentApplied?: boolean;
  hostIntentConfidence?: number;
  hostIntentDegraded?: boolean;
  hostIntentDegradedReason?: string;
  hostIntentSourceRefs?: string[];
  intentEvidence?: IntentEvidence | Record<string, unknown>;
  intentSearchPlan?: IntentSearchPlan | Record<string, unknown>;
  primeInjectionPackage?: PrimeInjectionPackage | Record<string, unknown>;
  queries?: string[];
  resultCount?: number;
}

export interface IntentEpisodeRecord {
  activeFileRef?: string;
  createdAt: string;
  dataRootSource?: string | null;
  endedAt?: string;
  episodeId: string;
  hostIntent?: IntentEpisodeHostIntentMeta | null;
  language?: string | null;
  module?: string | null;
  outcomeReason?: string;
  projectId?: string | null;
  projectScopeId?: string | null;
  query: string;
  scenario?: string | null;
  searchMeta?: IntentEpisodeSearchMeta | null;
  sessionKey: string;
  sourceRefs: string[];
  startedAt: string;
  status: IntentEpisodeStatus;
  taskId?: string;
  turnKey?: string;
  updatedAt: string;
  version: 1;
  workspaceMode?: string | null;
}

export interface IntentEpisodeStartInput {
  activeFile?: unknown;
  hostIntent?: IntentEpisodeHostIntentMeta | null;
  language?: unknown;
  module?: unknown;
  query?: unknown;
  scenario?: unknown;
  searchMeta?: IntentEpisodeSearchMeta | null;
  sessionId?: unknown;
  sourceRefs?: unknown;
  taskId?: unknown;
  turnId?: unknown;
}

export interface IntentEpisodeOutcomeInput {
  endedAt?: string;
  reason?: unknown;
  searchMeta?: IntentEpisodeSearchMeta | null;
  status: Exclude<IntentEpisodeStatus, 'active'>;
  taskId?: unknown;
}

export interface IntentEpisodeStoreOptions {
  dataRoot: string;
  maxRecent?: number;
  now?: () => Date;
  workspace?: IntentEpisodeWorkspaceIdentity;
}

interface IntentEpisodeIndex {
  episodes: IntentEpisodeRecord[];
  updatedAt: string;
  version: 1;
}

const STORE_DIR = path.join('.asd', 'intent-episodes');
const INDEX_FILE = 'index.json';
const LATEST_FILE = 'latest.json';
const AUDIT_FILE = 'episodes.jsonl';
const MAX_TEXT_LENGTH = 1000;
const MAX_REF_COUNT = 20;

export class IntentEpisodeStore {
  readonly dataRoot: string;
  readonly maxRecent: number;

  #now: () => Date;
  #workspace: IntentEpisodeWorkspaceIdentity;

  constructor(options: IntentEpisodeStoreOptions) {
    this.dataRoot = options.dataRoot;
    this.maxRecent = Math.max(1, Math.min(options.maxRecent ?? 100, 500));
    this.#now = options.now ?? (() => new Date());
    this.#workspace = options.workspace ?? {};
  }

  start(input: IntentEpisodeStartInput): IntentEpisodeRecord {
    const now = this.#isoNow();
    const searchMeta = sanitizeSearchMeta(input.searchMeta);
    const hostIntent = sanitizeHostIntent(input.hostIntent);
    const sourceRefs = collectSourceRefs(input.sourceRefs, hostIntent, searchMeta);
    const record: IntentEpisodeRecord = {
      createdAt: now,
      dataRootSource: this.#workspace.dataRootSource ?? null,
      episodeId: createEpisodeId(now),
      hostIntent,
      language: sanitizeNullableText(input.language, 80),
      module: sanitizeNullableText(input.module, 200),
      projectId: this.#workspace.projectId ?? null,
      projectScopeId: this.#workspace.projectScopeId ?? null,
      query: sanitizeText(input.query, MAX_TEXT_LENGTH),
      scenario: sanitizeNullableText(input.scenario, 80) ?? hostIntent?.scenario ?? null,
      searchMeta,
      sessionKey: toIntentEpisodeSessionKey(input.sessionId),
      sourceRefs,
      startedAt: now,
      status: 'active',
      updatedAt: now,
      version: 1,
      workspaceMode: this.#workspace.workspaceMode ?? null,
      ...(sanitizePathRef(input.activeFile)
        ? { activeFileRef: sanitizePathRef(input.activeFile) }
        : {}),
      ...(sanitizeText(input.taskId, 120) ? { taskId: sanitizeText(input.taskId, 120) } : {}),
      ...(sanitizeText(input.turnId, 160)
        ? { turnKey: toIntentEpisodeSessionKey(input.turnId) }
        : {}),
    };

    this.#persist(record, 'started');
    return cloneRecord(record);
  }

  attachTask(episodeId: string, taskId: unknown): IntentEpisodeRecord | null {
    const current = this.get(episodeId);
    if (!current) {
      return null;
    }
    const normalizedTaskId = sanitizeText(taskId, 120);
    if (!normalizedTaskId) {
      return current;
    }
    const next = {
      ...current,
      taskId: normalizedTaskId,
      updatedAt: this.#isoNow(),
    };
    this.#persist(next, 'task-attached');
    return cloneRecord(next);
  }

  updateOutcome(episodeId: string, input: IntentEpisodeOutcomeInput): IntentEpisodeRecord | null {
    const current = this.get(episodeId);
    if (!current) {
      return null;
    }
    const endedAt = input.endedAt ?? this.#isoNow();
    const next: IntentEpisodeRecord = {
      ...current,
      endedAt,
      outcomeReason: sanitizeText(input.reason, MAX_TEXT_LENGTH) || undefined,
      searchMeta: sanitizeSearchMeta(input.searchMeta) ?? current.searchMeta,
      status: input.status,
      taskId: sanitizeText(input.taskId, 120) || current.taskId,
      updatedAt: endedAt,
    };
    this.#persist(next, 'outcome');
    return cloneRecord(next);
  }

  get(episodeId: string): IntentEpisodeRecord | null {
    const safeId = sanitizeEpisodeId(episodeId);
    if (!safeId) {
      return null;
    }
    const filePath = path.join(this.#recordsDir(), `${safeId}.json`);
    try {
      if (!existsSync(filePath)) {
        return null;
      }
      return normalizeRecord(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
      return null;
    }
  }

  latest(options: { sessionId?: unknown } = {}): IntentEpisodeRecord | null {
    const sessionKey = optionalSessionKey(options.sessionId);
    if (!sessionKey) {
      return this.#readLatest();
    }
    return this.recent({ limit: 1, sessionId: options.sessionId })[0] ?? null;
  }

  recent(options: { limit?: number; sessionId?: unknown } = {}): IntentEpisodeRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, this.maxRecent));
    const sessionKey = optionalSessionKey(options.sessionId);
    return this.#readIndex()
      .episodes.filter((record) => !sessionKey || record.sessionKey === sessionKey)
      .slice(0, limit)
      .map(cloneRecord);
  }

  #persist(record: IntentEpisodeRecord, event: string): void {
    this.#ensureStoreDirs();
    this.#writeRecord(record);
    this.#writeLatest(record);
    this.#writeIndex(record);
    this.#appendAudit(record, event);
  }

  #writeRecord(record: IntentEpisodeRecord): void {
    const filePath = path.join(this.#recordsDir(), `${sanitizeEpisodeId(record.episodeId)}.json`);
    writeJsonAtomic(filePath, record);
  }

  #writeLatest(record: IntentEpisodeRecord): void {
    writeJsonAtomic(path.join(this.#storeDir(), LATEST_FILE), record);
  }

  #writeIndex(record: IntentEpisodeRecord): void {
    const existing = this.#readIndex().episodes.filter(
      (candidate) => candidate.episodeId !== record.episodeId
    );
    existing.unshift(record);
    const index: IntentEpisodeIndex = {
      episodes: existing.slice(0, this.maxRecent),
      updatedAt: this.#isoNow(),
      version: 1,
    };
    writeJsonAtomic(path.join(this.#storeDir(), INDEX_FILE), index);
  }

  #appendAudit(record: IntentEpisodeRecord, event: string): void {
    const filePath = path.join(this.#storeDir(), AUDIT_FILE);
    const line = `${JSON.stringify({ event, record, ts: this.#isoNow() })}\n`;
    appendFileSync(filePath, line, { mode: 0o600 });
  }

  #readLatest(): IntentEpisodeRecord | null {
    try {
      const record = JSON.parse(readFileSync(path.join(this.#storeDir(), LATEST_FILE), 'utf8'));
      return normalizeRecord(record);
    } catch {
      return null;
    }
  }

  #readIndex(): IntentEpisodeIndex {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(this.#storeDir(), INDEX_FILE), 'utf8')
      ) as IntentEpisodeIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.episodes)) {
        return { episodes: [], updatedAt: this.#isoNow(), version: 1 };
      }
      return {
        episodes: parsed.episodes.map(normalizeRecord).filter(isRecordPresent),
        updatedAt: parsed.updatedAt,
        version: 1,
      };
    } catch {
      return { episodes: [], updatedAt: this.#isoNow(), version: 1 };
    }
  }

  #ensureStoreDirs(): void {
    mkdirSync(this.#recordsDir(), { recursive: true, mode: 0o700 });
  }

  #storeDir(): string {
    return path.join(this.dataRoot, STORE_DIR);
  }

  #recordsDir(): string {
    return path.join(this.#storeDir(), 'records');
  }

  #isoNow(): string {
    return this.#now().toISOString();
  }
}

export function toIntentEpisodeSessionKey(value: unknown): string {
  const normalized = sanitizeText(value, 500) || 'unknown';
  return `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

export function sanitizeIntentEpisodePathRef(value: unknown): string | undefined {
  return sanitizePathRef(value);
}

function collectSourceRefs(
  explicitRefs: unknown,
  hostIntent: IntentEpisodeHostIntentMeta | null,
  searchMeta: IntentEpisodeSearchMeta | null
): string[] {
  const rawRefs = [
    ...stringsFrom(explicitRefs),
    ...(hostIntent?.sourceRefs ?? []),
    ...(searchMeta?.hostIntentSourceRefs ?? []),
  ];
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of rawRefs) {
    const sanitized = sanitizePathRef(ref);
    if (!sanitized || seen.has(sanitized)) {
      continue;
    }
    refs.push(sanitized);
    seen.add(sanitized);
    if (refs.length >= MAX_REF_COUNT) {
      break;
    }
  }
  return refs;
}

function sanitizeHostIntent(
  value: IntentEpisodeHostIntentMeta | null | undefined
): IntentEpisodeHostIntentMeta | null {
  if (!value) {
    return null;
  }
  return {
    applied: value.applied === true,
    ...(value.compatibility && typeof value.compatibility === 'object'
      ? { compatibility: sanitizeHostIntentCompatibility(value.compatibility) }
      : {}),
    ...(typeof value.confidence === 'number' && Number.isFinite(value.confidence)
      ? { confidence: Math.max(0, Math.min(1, value.confidence)) }
      : {}),
    degraded: value.degraded === true,
    ...(sanitizeText(value.degradedReason, 300)
      ? { degradedReason: sanitizeText(value.degradedReason, 300) }
      : {}),
    ...(sanitizeText(value.scenario, 80) ? { scenario: sanitizeText(value.scenario, 80) } : {}),
    ...(sanitizeText(value.searchIntent, 120)
      ? { searchIntent: sanitizeText(value.searchIntent, 120) }
      : {}),
    ...(typeof value.sessionHistoryCount === 'number' && Number.isFinite(value.sessionHistoryCount)
      ? { sessionHistoryCount: Math.max(0, Math.min(100, Math.floor(value.sessionHistoryCount))) }
      : {}),
    sourceRefs: collectSourceRefs(value.sourceRefs, null, null),
    sources: stringsFrom(value.sources).slice(0, 8),
  };
}

function sanitizeHostIntentCompatibility(
  value: NonNullable<IntentEpisodeHostIntentMeta['compatibility']>
): NonNullable<IntentEpisodeHostIntentMeta['compatibility']> {
  return {
    ...(sanitizeText(value.cleanupTrigger, 300)
      ? { cleanupTrigger: sanitizeText(value.cleanupTrigger, 300) }
      : {}),
    ...(sanitizeText(value.consumer, 80) ? { consumer: sanitizeText(value.consumer, 80) } : {}),
    fallbackAllowed: value.fallbackAllowed === true,
    fallbackFields: stringsFrom(value.fallbackFields).slice(0, 8),
    ...(sanitizeText(value.mode, 120) ? { mode: sanitizeText(value.mode, 120) } : {}),
    ...(sanitizeText(value.owner, 80) ? { owner: sanitizeText(value.owner, 80) } : {}),
    redacted: value.redacted === true,
    ...(sanitizeText(value.removalCondition, 300)
      ? { removalCondition: sanitizeText(value.removalCondition, 300) }
      : {}),
  };
}

function sanitizeSearchMeta(
  value: IntentEpisodeSearchMeta | null | undefined
): IntentEpisodeSearchMeta | null {
  if (!value) {
    return null;
  }
  return {
    ...(typeof value.filteredCount === 'number' && Number.isFinite(value.filteredCount)
      ? { filteredCount: Math.max(0, Math.floor(value.filteredCount)) }
      : {}),
    ...(typeof value.hostIntentApplied === 'boolean'
      ? { hostIntentApplied: value.hostIntentApplied }
      : {}),
    ...(typeof value.hostIntentConfidence === 'number' &&
    Number.isFinite(value.hostIntentConfidence)
      ? { hostIntentConfidence: Math.max(0, Math.min(1, value.hostIntentConfidence)) }
      : {}),
    ...(typeof value.hostIntentDegraded === 'boolean'
      ? { hostIntentDegraded: value.hostIntentDegraded }
      : {}),
    ...(sanitizeText(value.hostIntentDegradedReason, 300)
      ? { hostIntentDegradedReason: sanitizeText(value.hostIntentDegradedReason, 300) }
      : {}),
    hostIntentSourceRefs: collectSourceRefs(value.hostIntentSourceRefs, null, null),
    ...(value.intentEvidence && typeof value.intentEvidence === 'object'
      ? { intentEvidence: sanitizeIntentEvidenceMeta(value.intentEvidence) }
      : {}),
    ...(value.intentSearchPlan && typeof value.intentSearchPlan === 'object'
      ? { intentSearchPlan: sanitizeIntentSearchPlanMeta(value.intentSearchPlan) }
      : {}),
    ...(value.primeInjectionPackage && typeof value.primeInjectionPackage === 'object'
      ? { primeInjectionPackage: sanitizePrimeInjectionPackageMeta(value.primeInjectionPackage) }
      : {}),
    queries: stringsFrom(value.queries).slice(0, 8),
    ...(typeof value.resultCount === 'number' && Number.isFinite(value.resultCount)
      ? { resultCount: Math.max(0, Math.floor(value.resultCount)) }
      : {}),
  };
}

function sanitizeIntentEvidenceMeta(value: object): Record<string, unknown> {
  const evidence = value as Record<string, unknown>;
  return {
    degraded: evidence.degraded === true,
    degradedReasons: stringsFrom(evidence.degradedReasons).slice(0, 8),
    relationEvidence: arrayRecords(evidence.relationEvidence).slice(0, 12),
    scoreBreakdown: arrayRecords(evidence.scoreBreakdown).slice(0, 8),
    semanticAnchors: arrayRecords(evidence.semanticAnchors).slice(0, 12),
    topAnchorMatches: arrayRecords(evidence.topAnchorMatches).slice(0, 10),
    version: 1,
  };
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const output: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(item as Record<string, unknown>)) {
      if (Array.isArray(raw)) {
        output[key] = stringsFrom(raw).map(sanitizePathRef).filter(Boolean).slice(0, 12);
      } else if (typeof raw === 'string') {
        output[key] = sanitizePathRef(raw);
      } else if (raw && typeof raw === 'object') {
        output[key] = sanitizeRecord(raw, 8);
      } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        output[key] = raw;
      } else if (typeof raw === 'boolean' || raw === null) {
        output[key] = raw;
      }
    }
    return [output];
  });
}

function sanitizePrimeInjectionPackageMeta(value: object): Record<string, unknown> {
  const pkg = value as Record<string, unknown>;
  const relations = objectRecord(pkg.relations);
  const vector = objectRecord(pkg.vector);
  return {
    injection: sanitizeRecord(pkg.injection, 12),
    intent: sanitizeRecord(pkg.intent, 12),
    omitted: arrayRecords(pkg.omitted).slice(0, 16),
    relations: {
      evidence: arrayRecords(relations.evidence).slice(0, 12),
      omitted: stringsFrom(relations.omitted).slice(0, 8),
    },
    search: sanitizeRecord(pkg.search, 12),
    selectedKnowledge: arrayRecords(pkg.selectedKnowledge).slice(0, 8),
    trace: sanitizeRecord(pkg.trace, 12),
    vector: {
      ...sanitizeRecord(vector, 12),
      scoreBreakdown: arrayRecords(vector.scoreBreakdown).slice(0, 8),
      semanticAnchors: arrayRecords(vector.semanticAnchors).slice(0, 12),
      topAnchorMatches: arrayRecords(vector.topAnchorMatches).slice(0, 10),
    },
    version: 1,
  };
}

function sanitizeRecord(value: unknown, maxKeys: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, maxKeys)) {
    if (Array.isArray(raw)) {
      output[key] = stringsFrom(raw).map(sanitizePathRef).filter(Boolean).slice(0, 16);
    } else if (raw && typeof raw === 'object') {
      output[key] = sanitizeRecord(raw, 8);
    } else if (typeof raw === 'string') {
      output[key] = sanitizePathRef(raw);
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      output[key] = raw;
    } else if (typeof raw === 'boolean' || raw === null) {
      output[key] = raw;
    }
  }
  return output;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeIntentSearchPlanMeta(value: object): Record<string, unknown> {
  const plan = value as Record<string, unknown>;
  return {
    applied: plan.applied === true,
    degraded: plan.degraded === true,
    degradedReasons: stringsFrom(plan.degradedReasons).slice(0, 8),
    executableQuery: sanitizeText(plan.executableQuery, 280),
    lexicalQueries: stringsFrom(plan.lexicalQueries).slice(0, 6),
    omitted: stringsFrom(plan.omitted).slice(0, 8),
    rankingProfile: sanitizeText(plan.rankingProfile, 80),
    sourceRefs: collectSourceRefs(plan.sourceRefs, null, null),
    whySelected: stringsFrom(plan.whySelected).slice(0, 8),
  };
}

function sanitizePathRef(value: unknown): string | undefined {
  const normalized = sanitizeText(value, 500);
  if (!normalized) {
    return undefined;
  }
  const withoutNulls = normalized.replace(/\0/g, '');
  if (path.isAbsolute(withoutNulls)) {
    return `[absolute-path]/${path.basename(withoutNulls)}`;
  }
  return withoutNulls
    .replace(/\\/g, '/')
    .replace(/\.\.(\/|$)/g, '')
    .replace(/^\/+/, '')
    .slice(0, 500);
}

function sanitizeNullableText(value: unknown, maxLength: number): string | null {
  return sanitizeText(value, maxLength) || null;
}

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
}

function stringsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsFrom(item));
  }
  const normalized = sanitizeText(value, 500);
  return normalized ? [normalized] : [];
}

function optionalSessionKey(value: unknown): string | null {
  const normalized = sanitizeText(value, 500);
  return normalized ? toIntentEpisodeSessionKey(normalized) : null;
}

function createEpisodeId(now: string): string {
  const compactTime = now.replace(/[^0-9]/g, '').slice(0, 17);
  return `episode_${compactTime}_${randomUUID().slice(0, 8)}`;
}

function sanitizeEpisodeId(value: unknown): string {
  const normalized = sanitizeText(value, 160);
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : '';
}

function normalizeRecord(value: unknown): IntentEpisodeRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as IntentEpisodeRecord;
  if (!sanitizeEpisodeId(record.episodeId) || record.version !== 1) {
    return null;
  }
  return {
    ...record,
    sourceRefs: Array.isArray(record.sourceRefs) ? record.sourceRefs : [],
  };
}

function isRecordPresent(record: IntentEpisodeRecord | null): record is IntentEpisodeRecord {
  return record !== null;
}

function cloneRecord(record: IntentEpisodeRecord): IntentEpisodeRecord {
  return JSON.parse(JSON.stringify(record)) as IntentEpisodeRecord;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}
