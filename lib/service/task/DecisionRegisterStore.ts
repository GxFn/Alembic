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

export type DecisionRegisterStatus = 'active' | 'revoked' | 'deleted';
export type DecisionRegisterEvent = 'created' | 'updated' | 'revoked' | 'deleted';
export type DecisionRegisterRetrievalLifecycle = 'effective' | 'audit';

export interface DecisionRegisterWorkspaceIdentity {
  dataRootSource?: string | null;
  projectId?: string | null;
  projectScopeId?: string | null;
  workspaceMode?: string | null;
}

export interface DecisionRegisterScopeInput {
  dataRootSource?: unknown;
  projectId?: unknown;
  projectScopeId?: unknown;
  workspaceMode?: unknown;
}

export interface DecisionRegisterRecord {
  createdAt: string;
  createdBy?: string;
  dataRootSource?: string | null;
  decision: string;
  decisionId: string;
  deletedAt?: string;
  deleteReason?: string;
  detailRefs: string[];
  detailRefKeys: string[];
  intentRef?: string;
  metadata?: Record<string, unknown>;
  projectId?: string | null;
  projectScopeId?: string | null;
  rationale?: string;
  revokedAt?: string;
  revokeReason?: string;
  revision: number;
  sessionKey?: string;
  sourceRefs: string[];
  sourceRefKeys: string[];
  status: DecisionRegisterStatus;
  tags: string[];
  title: string;
  turnKey?: string;
  updatedAt: string;
  updatedBy?: string;
  version: 1;
  workRef?: string;
  workspaceMode?: string | null;
}

export interface DecisionRegisterCreateInput {
  createdBy?: unknown;
  decision?: unknown;
  decisionId?: unknown;
  description?: unknown;
  detailRefs?: unknown;
  intentRef?: unknown;
  metadata?: unknown;
  rationale?: unknown;
  scope?: DecisionRegisterScopeInput | null;
  sessionId?: unknown;
  sourceRefs?: unknown;
  tags?: unknown;
  title?: unknown;
  turnId?: unknown;
  workRef?: unknown;
}

export interface DecisionRegisterUpdateInput {
  decision?: unknown;
  description?: unknown;
  detailRefs?: unknown;
  intentRef?: unknown;
  metadata?: unknown;
  rationale?: unknown;
  scope?: DecisionRegisterScopeInput | null;
  sessionId?: unknown;
  sourceRefs?: unknown;
  tags?: unknown;
  title?: unknown;
  turnId?: unknown;
  updatedBy?: unknown;
  workRef?: unknown;
}

export interface DecisionRegisterTerminalInput {
  reason?: unknown;
  scope?: DecisionRegisterScopeInput | null;
  updatedBy?: unknown;
}

export interface DecisionRegisterListOptions {
  includeDeleted?: boolean;
  limit?: number;
  sessionId?: unknown;
  status?: DecisionRegisterStatus | 'all';
}

export interface DecisionRegisterSearchableOptions {
  includeAudit?: boolean;
  limit?: number;
  query?: unknown;
  sessionId?: unknown;
  status?: DecisionRegisterStatus | 'all';
}

export interface DecisionRegisterSearchablePolicy {
  acceptedStatuses: DecisionRegisterStatus[];
  auditReadback: {
    includeAudit: true;
    status: 'all';
  };
  defaultLifecycle: 'active-effective-only';
  excludedStatuses: DecisionRegisterStatus[];
  sourceRefGate: 'observe-only';
  vectorAdmission: 'accepted-only';
}

export interface DecisionRegisterSearchableDocument {
  acceptedForRetrieval: boolean;
  content: string;
  createdAt: string;
  decision: string;
  decisionId: string;
  detailRefs: string[];
  detailRefKeys: string[];
  id: string;
  intentRef?: string;
  kind: 'decision';
  knowledgeType: 'decision-register';
  metadata: {
    decisionRegister: {
      acceptedForRetrieval: boolean;
      defaultLifecycle: 'active-effective-only';
      decisionId: string;
      retrievalLifecycle: DecisionRegisterRetrievalLifecycle;
      status: DecisionRegisterStatus;
      vectorAdmission: 'accepted-only';
    };
    quality: {
      detailRefCount: number;
      sourceRefCount: number;
      tagCount: number;
    };
  };
  projectId?: string | null;
  projectScopeId?: string | null;
  rationale?: string;
  retrievalLifecycle: DecisionRegisterRetrievalLifecycle;
  revision: number;
  score: number;
  sourceRefKeys: string[];
  sourceRefs: string[];
  status: DecisionRegisterStatus;
  tags: string[];
  title: string;
  trigger: string;
  updatedAt: string;
  whySelected: string[];
  workRef?: string;
  workspaceMode?: string | null;
}

export interface DecisionRegisterSearchableView {
  acceptedCount: number;
  auditCount: number;
  auditExcludedCount: number;
  documents: DecisionRegisterSearchableDocument[];
  policy: DecisionRegisterSearchablePolicy;
  query: string | null;
  status: DecisionRegisterStatus | 'all';
  totalMatched: number;
}

export interface DecisionRegisterStoreOptions {
  dataRoot: string;
  maxRecent?: number;
  now?: () => Date;
  workspace?: DecisionRegisterWorkspaceIdentity;
}

interface DecisionRegisterIndex {
  decisions: DecisionRegisterRecord[];
  updatedAt: string;
  version: 1;
}

interface DecisionRegisterRefSet {
  keys: string[];
  refs: string[];
}

const STORE_DIR = path.join('.asd', 'decision-register');
const INDEX_FILE = 'index.json';
const AUDIT_FILE = 'decisions.jsonl';
const MAX_TEXT_LENGTH = 2000;
const MAX_SHORT_TEXT_LENGTH = 240;
const MAX_REF_COUNT = 40;

export class DecisionRegisterStoreError extends Error {
  readonly reasonCode: string;
  readonly statusCode: number;

  constructor(message: string, options: { reasonCode: string; statusCode?: number }) {
    super(message);
    this.name = 'DecisionRegisterStoreError';
    this.reasonCode = options.reasonCode;
    this.statusCode = options.statusCode ?? 400;
  }
}

export class DecisionRegisterStore {
  readonly dataRoot: string;
  readonly maxRecent: number;

  #now: () => Date;
  #workspace: DecisionRegisterWorkspaceIdentity;

  constructor(options: DecisionRegisterStoreOptions) {
    this.dataRoot = options.dataRoot;
    this.maxRecent = Math.max(1, Math.min(options.maxRecent ?? 500, 2_000));
    this.#now = options.now ?? (() => new Date());
    this.#workspace = options.workspace ?? {};
  }

  create(input: DecisionRegisterCreateInput): DecisionRegisterRecord {
    this.#assertScope(input.scope);
    const now = this.#isoNow();
    const title = sanitizeText(input.title, MAX_SHORT_TEXT_LENGTH);
    const decision = sanitizeText(input.decision ?? input.description, MAX_TEXT_LENGTH);
    if (!title) {
      throw new DecisionRegisterStoreError('Decision title is required', {
        reasonCode: 'missing-title',
      });
    }
    if (!decision) {
      throw new DecisionRegisterStoreError('Decision text is required', {
        reasonCode: 'missing-decision',
      });
    }
    const decisionId = sanitizeDecisionId(input.decisionId) || createDecisionId(now);
    if (this.get(decisionId)) {
      throw new DecisionRegisterStoreError(`Decision already exists: ${decisionId}`, {
        reasonCode: 'duplicate-decision',
        statusCode: 409,
      });
    }
    const sourceRefs = collectRefSet(input.sourceRefs);
    const detailRefs = collectRefSet(input.detailRefs);
    const record: DecisionRegisterRecord = {
      createdAt: now,
      ...(sanitizeText(input.createdBy, 120)
        ? { createdBy: sanitizeText(input.createdBy, 120) }
        : {}),
      dataRootSource: this.#workspace.dataRootSource ?? null,
      decision,
      decisionId,
      detailRefKeys: detailRefs.keys,
      detailRefs: detailRefs.refs,
      ...(sanitizeRef(input.intentRef) ? { intentRef: sanitizeRef(input.intentRef) } : {}),
      ...(sanitizeMetadata(input.metadata) ? { metadata: sanitizeMetadata(input.metadata) } : {}),
      projectId: this.#workspace.projectId ?? null,
      projectScopeId: this.#workspace.projectScopeId ?? null,
      ...(sanitizeText(input.rationale, MAX_TEXT_LENGTH)
        ? { rationale: sanitizeText(input.rationale, MAX_TEXT_LENGTH) }
        : {}),
      revision: 1,
      ...(optionalKey(input.sessionId, toDecisionRegisterSessionKey)
        ? { sessionKey: optionalKey(input.sessionId, toDecisionRegisterSessionKey) as string }
        : {}),
      sourceRefKeys: sourceRefs.keys,
      sourceRefs: sourceRefs.refs,
      status: 'active',
      tags: collectTags(input.tags),
      title,
      ...(optionalKey(input.turnId, toDecisionRegisterSessionKey)
        ? { turnKey: optionalKey(input.turnId, toDecisionRegisterSessionKey) as string }
        : {}),
      updatedAt: now,
      version: 1,
      ...(sanitizeRef(input.workRef) ? { workRef: sanitizeRef(input.workRef) } : {}),
      workspaceMode: this.#workspace.workspaceMode ?? null,
    };

    this.#persist(record, 'created');
    return cloneRecord(record);
  }

  update(decisionId: string, input: DecisionRegisterUpdateInput): DecisionRegisterRecord | null {
    this.#assertScope(input.scope);
    const current = this.get(decisionId);
    if (!current) {
      return null;
    }
    if (current.status !== 'active') {
      throw new DecisionRegisterStoreError(`Decision cannot be updated while ${current.status}`, {
        reasonCode: `decision-${current.status}`,
        statusCode: 409,
      });
    }
    const now = this.#isoNow();
    const title = sanitizeText(input.title, MAX_SHORT_TEXT_LENGTH);
    const decision = sanitizeText(input.decision ?? input.description, MAX_TEXT_LENGTH);
    const sourceRefs = input.sourceRefs === undefined ? null : collectRefSet(input.sourceRefs);
    const detailRefs = input.detailRefs === undefined ? null : collectRefSet(input.detailRefs);
    const next: DecisionRegisterRecord = {
      ...current,
      ...(title ? { title } : {}),
      ...(decision ? { decision } : {}),
      ...(sanitizeText(input.rationale, MAX_TEXT_LENGTH)
        ? { rationale: sanitizeText(input.rationale, MAX_TEXT_LENGTH) }
        : {}),
      ...(sourceRefs ? { sourceRefKeys: sourceRefs.keys, sourceRefs: sourceRefs.refs } : {}),
      ...(detailRefs ? { detailRefKeys: detailRefs.keys, detailRefs: detailRefs.refs } : {}),
      ...(Array.isArray(input.tags) ? { tags: collectTags(input.tags) } : {}),
      ...(sanitizeRef(input.intentRef) ? { intentRef: sanitizeRef(input.intentRef) } : {}),
      ...(sanitizeRef(input.workRef) ? { workRef: sanitizeRef(input.workRef) } : {}),
      ...(sanitizeMetadata(input.metadata) ? { metadata: sanitizeMetadata(input.metadata) } : {}),
      ...(optionalKey(input.sessionId, toDecisionRegisterSessionKey)
        ? { sessionKey: optionalKey(input.sessionId, toDecisionRegisterSessionKey) as string }
        : {}),
      ...(optionalKey(input.turnId, toDecisionRegisterSessionKey)
        ? { turnKey: optionalKey(input.turnId, toDecisionRegisterSessionKey) as string }
        : {}),
      revision: current.revision + 1,
      updatedAt: now,
      ...(sanitizeText(input.updatedBy, 120)
        ? { updatedBy: sanitizeText(input.updatedBy, 120) }
        : {}),
    };
    this.#persist(next, 'updated');
    return cloneRecord(next);
  }

  revoke(
    decisionId: string,
    input: DecisionRegisterTerminalInput = {}
  ): DecisionRegisterRecord | null {
    this.#assertScope(input.scope);
    const current = this.get(decisionId);
    if (!current) {
      return null;
    }
    if (current.status === 'deleted') {
      throw new DecisionRegisterStoreError('Deleted decisions cannot be revoked', {
        reasonCode: 'decision-deleted',
        statusCode: 409,
      });
    }
    const now = this.#isoNow();
    const next: DecisionRegisterRecord = {
      ...current,
      revision: current.revision + 1,
      revokedAt: now,
      ...(sanitizeText(input.reason, MAX_TEXT_LENGTH)
        ? { revokeReason: sanitizeText(input.reason, MAX_TEXT_LENGTH) }
        : {}),
      status: 'revoked',
      updatedAt: now,
      ...(sanitizeText(input.updatedBy, 120)
        ? { updatedBy: sanitizeText(input.updatedBy, 120) }
        : {}),
    };
    this.#persist(next, 'revoked');
    return cloneRecord(next);
  }

  delete(
    decisionId: string,
    input: DecisionRegisterTerminalInput = {}
  ): DecisionRegisterRecord | null {
    this.#assertScope(input.scope);
    const current = this.get(decisionId);
    if (!current) {
      return null;
    }
    const now = this.#isoNow();
    const next: DecisionRegisterRecord = {
      ...current,
      deletedAt: now,
      ...(sanitizeText(input.reason, MAX_TEXT_LENGTH)
        ? { deleteReason: sanitizeText(input.reason, MAX_TEXT_LENGTH) }
        : {}),
      revision: current.status === 'deleted' ? current.revision : current.revision + 1,
      status: 'deleted',
      updatedAt: now,
      ...(sanitizeText(input.updatedBy, 120)
        ? { updatedBy: sanitizeText(input.updatedBy, 120) }
        : {}),
    };
    this.#persist(next, 'deleted');
    return cloneRecord(next);
  }

  get(decisionId: string): DecisionRegisterRecord | null {
    const safeId = sanitizeDecisionId(decisionId);
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

  list(options: DecisionRegisterListOptions = {}): DecisionRegisterRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, this.maxRecent));
    const sessionKey = optionalKey(options.sessionId, toDecisionRegisterSessionKey);
    return this.#readIndex()
      .decisions.filter((record) => {
        if (sessionKey && record.sessionKey !== sessionKey) {
          return false;
        }
        if (options.status && options.status !== 'all') {
          return record.status === options.status;
        }
        if (options.status === 'all') {
          return true;
        }
        return options.includeDeleted === true || record.status !== 'deleted';
      })
      .slice(0, limit)
      .map(cloneRecord);
  }

  searchable(options: DecisionRegisterSearchableOptions = {}): DecisionRegisterSearchableView {
    const limit = Math.max(1, Math.min(options.limit ?? 20, this.maxRecent));
    const sessionKey = optionalKey(options.sessionId, toDecisionRegisterSessionKey);
    const query = sanitizeText(options.query, 500);
    const includeAudit = options.includeAudit === true || options.status === 'all';
    const status = includeAudit ? (options.status ?? 'all') : 'active';
    const policy = buildSearchablePolicy();
    const queryMatched = this.#readIndex().decisions.filter((record) => {
      if (sessionKey && record.sessionKey !== sessionKey) {
        return false;
      }
      return decisionMatchesQuery(record, query);
    });
    const lifecycleMatched = queryMatched.filter((record) => {
      if (!includeAudit) {
        return record.status === 'active';
      }
      return status === 'all' ? true : record.status === status;
    });
    const documents = lifecycleMatched
      .map((record) => toSearchableDocument(record, query, policy))
      .sort(compareSearchableDocuments)
      .slice(0, limit);

    return {
      acceptedCount: documents.filter((document) => document.acceptedForRetrieval).length,
      auditCount: documents.filter((document) => !document.acceptedForRetrieval).length,
      auditExcludedCount: queryMatched.filter((record) => record.status !== 'active').length,
      documents,
      policy,
      query: query || null,
      status,
      totalMatched: queryMatched.length,
    };
  }

  storeSummary(): { dataRoot: string; recordsDir: string; storeDir: string } {
    return {
      dataRoot: this.dataRoot,
      recordsDir: this.#recordsDir(),
      storeDir: this.#storeDir(),
    };
  }

  #assertScope(scopeInput: DecisionRegisterScopeInput | null | undefined): void {
    if (!scopeInput || typeof scopeInput !== 'object') {
      return;
    }
    const expected: DecisionRegisterWorkspaceIdentity = {
      dataRootSource: normalizeOptional(scopeInput.dataRootSource),
      projectId: normalizeOptional(scopeInput.projectId),
      projectScopeId: normalizeOptional(scopeInput.projectScopeId),
      workspaceMode: normalizeOptional(scopeInput.workspaceMode),
    };
    const mismatches = scopeMismatches(expected, this.#workspace);
    if (mismatches.length > 0) {
      throw new DecisionRegisterStoreError(
        `Decision scope does not match current Alembic workspace: ${mismatches.join(', ')}`,
        {
          reasonCode: 'project-scope-mismatch',
          statusCode: 409,
        }
      );
    }
  }

  #persist(record: DecisionRegisterRecord, event: DecisionRegisterEvent): void {
    this.#ensureStoreDirs();
    this.#writeRecord(record);
    this.#writeIndex(record);
    this.#appendAudit(record, event);
  }

  #writeRecord(record: DecisionRegisterRecord): void {
    const filePath = path.join(this.#recordsDir(), `${sanitizeDecisionId(record.decisionId)}.json`);
    writeJsonAtomic(filePath, record);
  }

  #writeIndex(record: DecisionRegisterRecord): void {
    const existing = this.#readIndex().decisions.filter(
      (candidate) => candidate.decisionId !== record.decisionId
    );
    existing.unshift(record);
    const index: DecisionRegisterIndex = {
      decisions: existing.slice(0, this.maxRecent),
      updatedAt: this.#isoNow(),
      version: 1,
    };
    writeJsonAtomic(path.join(this.#storeDir(), INDEX_FILE), index);
  }

  #appendAudit(record: DecisionRegisterRecord, event: DecisionRegisterEvent): void {
    const filePath = path.join(this.#storeDir(), AUDIT_FILE);
    const line = `${JSON.stringify({ event, record, ts: this.#isoNow() })}\n`;
    appendFileSync(filePath, line, { mode: 0o600 });
  }

  #readIndex(): DecisionRegisterIndex {
    try {
      const parsed = JSON.parse(readFileSync(path.join(this.#storeDir(), INDEX_FILE), 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.decisions)) {
        return { decisions: [], updatedAt: this.#isoNow(), version: 1 };
      }
      return {
        decisions: parsed.decisions.map(normalizeRecord).filter(isRecordPresent),
        updatedAt: sanitizeText(parsed.updatedAt, 80) || this.#isoNow(),
        version: 1,
      };
    } catch {
      return { decisions: [], updatedAt: this.#isoNow(), version: 1 };
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

export function toDecisionRegisterSessionKey(value: unknown): string {
  const normalized = sanitizeText(value, 500) || 'unknown';
  return `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

export function toDecisionRegisterRefKey(value: unknown): string {
  const normalized = sanitizeText(value, 500) || 'unknown';
  return `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

function createDecisionId(now: string): string {
  const compactTime = now.replace(/[^0-9]/g, '').slice(0, 17);
  return `decision_${compactTime}_${randomUUID().slice(0, 8)}`;
}

function buildSearchablePolicy(): DecisionRegisterSearchablePolicy {
  return {
    acceptedStatuses: ['active'],
    auditReadback: {
      includeAudit: true,
      status: 'all',
    },
    defaultLifecycle: 'active-effective-only',
    excludedStatuses: ['revoked', 'deleted'],
    sourceRefGate: 'observe-only',
    vectorAdmission: 'accepted-only',
  };
}

function decisionMatchesQuery(record: DecisionRegisterRecord, query: string): boolean {
  if (!query) {
    return true;
  }
  return decisionSearchText(record).includes(query.toLowerCase());
}

function decisionSearchText(record: DecisionRegisterRecord): string {
  return [
    record.decisionId,
    record.title,
    record.decision,
    record.rationale,
    record.intentRef,
    record.workRef,
    ...record.tags,
    ...record.sourceRefs,
    ...record.detailRefs,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function toSearchableDocument(
  record: DecisionRegisterRecord,
  query: string,
  policy: DecisionRegisterSearchablePolicy
): DecisionRegisterSearchableDocument {
  const acceptedForRetrieval = record.status === 'active';
  const retrievalLifecycle: DecisionRegisterRetrievalLifecycle = acceptedForRetrieval
    ? 'effective'
    : 'audit';
  return {
    acceptedForRetrieval,
    content: [record.title, record.decision, record.rationale].filter(Boolean).join('\n\n'),
    createdAt: record.createdAt,
    decision: record.decision,
    decisionId: record.decisionId,
    detailRefKeys: [...record.detailRefKeys],
    detailRefs: [...record.detailRefs],
    id: `decision:${record.decisionId}`,
    ...(record.intentRef ? { intentRef: record.intentRef } : {}),
    kind: 'decision',
    knowledgeType: 'decision-register',
    metadata: {
      decisionRegister: {
        acceptedForRetrieval,
        defaultLifecycle: policy.defaultLifecycle,
        decisionId: record.decisionId,
        retrievalLifecycle,
        status: record.status,
        vectorAdmission: policy.vectorAdmission,
      },
      quality: {
        detailRefCount: record.detailRefs.length,
        sourceRefCount: record.sourceRefs.length,
        tagCount: record.tags.length,
      },
    },
    projectId: record.projectId ?? null,
    projectScopeId: record.projectScopeId ?? null,
    ...(record.rationale ? { rationale: record.rationale } : {}),
    retrievalLifecycle,
    revision: record.revision,
    score: decisionSearchScore(record, query),
    sourceRefKeys: [...record.sourceRefKeys],
    sourceRefs: [...record.sourceRefs],
    status: record.status,
    tags: [...record.tags],
    title: record.title,
    trigger: record.title,
    updatedAt: record.updatedAt,
    whySelected: decisionWhySelected(record, query, acceptedForRetrieval),
    ...(record.workRef ? { workRef: record.workRef } : {}),
    workspaceMode: record.workspaceMode ?? null,
  };
}

function decisionSearchScore(record: DecisionRegisterRecord, query: string): number {
  if (!query) {
    return record.status === 'active' ? 0.75 : 0.1;
  }
  const normalized = query.toLowerCase();
  if (record.title.toLowerCase().includes(normalized)) {
    return 0.99;
  }
  if (record.decision.toLowerCase().includes(normalized)) {
    return 0.92;
  }
  if ((record.rationale ?? '').toLowerCase().includes(normalized)) {
    return 0.84;
  }
  if (record.tags.some((tag) => tag.toLowerCase().includes(normalized))) {
    return 0.78;
  }
  if (
    [...record.sourceRefs, ...record.detailRefs].some((ref) =>
      ref.toLowerCase().includes(normalized)
    )
  ) {
    return 0.7;
  }
  return record.status === 'active' ? 0.5 : 0.05;
}

function decisionWhySelected(
  record: DecisionRegisterRecord,
  query: string,
  acceptedForRetrieval: boolean
): string[] {
  const reasons = [
    acceptedForRetrieval
      ? 'decisionRegister.status:active'
      : `decisionRegister.status:${record.status}`,
    acceptedForRetrieval
      ? 'decisionRegister.lifecycle:effective'
      : 'decisionRegister.lifecycle:audit-only',
  ];
  if (query) {
    reasons.push('decisionRegister.query-match');
  }
  if (record.sourceRefs.length > 0) {
    reasons.push('decisionRegister.sourceRefs:present');
  }
  if (record.detailRefs.length > 0) {
    reasons.push('decisionRegister.detailRefs:present');
  }
  return reasons.slice(0, 8);
}

function compareSearchableDocuments(
  left: DecisionRegisterSearchableDocument,
  right: DecisionRegisterSearchableDocument
): number {
  if (left.acceptedForRetrieval !== right.acceptedForRetrieval) {
    return left.acceptedForRetrieval ? -1 : 1;
  }
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}

function collectRefSet(value: unknown): DecisionRegisterRefSet {
  const refs: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const raw of stringsFrom(value)) {
    const ref = sanitizeRef(raw);
    const key = toDecisionRegisterRefKey(raw);
    if (!ref || seen.has(key)) {
      continue;
    }
    refs.push(ref);
    keys.push(key);
    seen.add(key);
    if (keys.length >= MAX_REF_COUNT) {
      break;
    }
  }
  return { keys, refs };
}

function collectRefs(value: unknown): string[] {
  return collectRefSet(value).refs;
}

function collectSensitiveMetadataRefs(value: unknown): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const raw of stringsFrom(value)) {
    const key = toDecisionRegisterRefKey(raw);
    if (seen.has(key)) {
      continue;
    }
    keys.push(key);
    seen.add(key);
    if (keys.length >= MAX_REF_COUNT) {
      break;
    }
  }
  return keys;
}

function collectTags(value: unknown): string[] {
  return stringsFrom(value)
    .map((tag) => sanitizeText(tag, 80))
    .filter(Boolean)
    .slice(0, 24);
}

function sanitizeRef(value: unknown): string | undefined {
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

function sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeRecord(value, 12);
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeRecord(value: unknown, maxKeys: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, unknown> = {};
  for (const [rawKey, raw] of Object.entries(value as Record<string, unknown>).slice(0, maxKeys)) {
    const key = sanitizeText(rawKey, 120);
    if (!key) {
      continue;
    }
    if (Array.isArray(raw)) {
      output[key] = isSensitiveMetadataRefKey(key)
        ? collectSensitiveMetadataRefs(raw).slice(0, 16)
        : collectRefs(raw).slice(0, 16);
    } else if (raw && typeof raw === 'object') {
      output[key] = sanitizeRecord(raw, 8);
    } else if (typeof raw === 'string') {
      output[key] = sanitizeMetadataString(key, raw);
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      output[key] = raw;
    } else if (typeof raw === 'boolean' || raw === null) {
      output[key] = raw;
    }
  }
  return output;
}

function sanitizeMetadataString(key: string, value: unknown): string | undefined {
  if (isSensitiveMetadataSessionKey(key)) {
    return optionalKey(value, toDecisionRegisterSessionKey) ?? undefined;
  }
  if (isSensitiveMetadataRefKey(key)) {
    return optionalKey(value, toDecisionRegisterRefKey) ?? undefined;
  }
  return sanitizeRef(value);
}

function isSensitiveMetadataSessionKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes('thread') || normalized.includes('session') || normalized.includes('turn')
  );
}

function isSensitiveMetadataRefKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes('sourceref') || normalized.includes('detailref');
}

function stringsFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsFrom(item));
  }
  const normalized = sanitizeText(value, 500);
  return normalized ? [normalized] : [];
}

function optionalKey(value: unknown, keyBuilder: (input: unknown) => string): string | null {
  const normalized = sanitizeText(value, 500);
  return normalized ? keyBuilder(normalized) : null;
}

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
}

function sanitizeDecisionId(value: unknown): string {
  const normalized = sanitizeText(value, 160);
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : '';
}

function normalizeOptional(value: unknown): string | null {
  const normalized = sanitizeText(value, 200);
  return normalized || null;
}

function scopeMismatches(
  requested: DecisionRegisterWorkspaceIdentity,
  workspace: DecisionRegisterWorkspaceIdentity
): string[] {
  const mismatches: string[] = [];
  for (const key of ['dataRootSource', 'projectId', 'projectScopeId', 'workspaceMode'] as const) {
    const expected = requested[key];
    if (!expected) {
      continue;
    }
    const actual = workspace[key] ?? null;
    if (actual !== expected) {
      mismatches.push(key);
    }
  }
  return mismatches;
}

function normalizeRecord(value: unknown): DecisionRegisterRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as DecisionRegisterRecord;
  if (!sanitizeDecisionId(record.decisionId) || record.version !== 1) {
    return null;
  }
  if (!['active', 'revoked', 'deleted'].includes(record.status)) {
    return null;
  }
  return {
    ...record,
    detailRefKeys: Array.isArray(record.detailRefKeys) ? record.detailRefKeys : [],
    detailRefs: Array.isArray(record.detailRefs) ? record.detailRefs : [],
    sourceRefKeys: Array.isArray(record.sourceRefKeys) ? record.sourceRefKeys : [],
    sourceRefs: Array.isArray(record.sourceRefs) ? record.sourceRefs : [],
    tags: Array.isArray(record.tags) ? record.tags : [],
  };
}

function isRecordPresent(record: DecisionRegisterRecord | null): record is DecisionRegisterRecord {
  return record !== null;
}

function cloneRecord(record: DecisionRegisterRecord): DecisionRegisterRecord {
  return JSON.parse(JSON.stringify(record)) as DecisionRegisterRecord;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}
