import { randomUUID } from 'node:crypto';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';

export const STRICT_PRODUCTION_STATES_V1 = [
  'PC_F_ACCEPTED',
  'AUTHORIZED',
  'JOURNAL_OPEN',
  'SNAPSHOT_VERIFIED',
  'PRISTINE_ABSENT',
  'BLANK',
  'PROJECT_FACTS_READY',
  'REQUIRED_FACT_UNIVERSE_READY',
  'PLAN_COGNITION_ACCEPTED',
  'PLAN_COMPILED',
  'BASELINE_FACT_SCHEDULE_FROZEN',
  'CODE_FACTS_READY',
  'BASELINE_POPULATIONS_READY',
  'ANALYSIS_EPOCHS_OPEN',
  'ANALYSIS_FIXPOINT_CLOSED',
  'EXPRESSION_BATCH_OPEN',
  'HYPOTHESIS_EXPRESSION_SETS_CLOSED',
  'CONTENT_READY_CORPUS_SEALED',
  'CANDIDATE_COVERAGE_CLOSED',
  'CANDIDATE_ASSEMBLED',
  'INDEXES_BUILT',
  'CANDIDATE_DATA_SEALED',
  'G4_READY',
  'SERVING_RECONCILED',
  'FINAL_COVERAGE_BOUND',
  'SERVING_SNAPSHOT_VALIDATED',
  'SERVING_MANIFEST_READY',
  'PUBLIC_CAS_PREPARED',
  'PUBLIC_CAS_COMMITTED',
  'FINALIZED',
] as const;

export type StrictProductionStateV1 = (typeof STRICT_PRODUCTION_STATES_V1)[number];

export const STRICT_SETUP_STATES_V2 = [
  'PRE_QUIESCE_INVENTORY_VERIFIED',
  'QUIESCE_REQUESTED',
  'QUIESCE_ACCEPTED',
  'QUIESCE_DRAINED',
  'QUIESCE_NOT_RUNNING',
  'QUIESCED_OBSERVED',
  'SNAPSHOT_COPY_STARTED',
  'SNAPSHOT_VERIFIED',
  'PRISTINE_ABSENT',
  'RESET_STARTED',
  'BLANK',
] as const;

export type StrictSetupStateV2 = (typeof STRICT_SETUP_STATES_V2)[number];

export const STRICT_RECOVERY_STATES_V2 = [
  'RECOVERY_PREPARED',
  'RECOVERY_TARGET_QUARANTINED',
  'RECOVERY_INSTALLED',
  'RECOVERY_VERIFIED',
] as const;

export type StrictRecoveryStateV2 = (typeof STRICT_RECOVERY_STATES_V2)[number];

interface StrictSetupJournalEventV2 {
  readonly schemaVersion: 2;
  readonly kind: 'StrictRunJournalEventV2';
  readonly sequence: number;
  readonly runId: string;
  readonly track: 'setup';
  readonly state: StrictSetupStateV2;
  readonly previousEntryHash: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly eventHash: string;
}

interface StrictRecoveryJournalEventV2 {
  readonly schemaVersion: 2;
  readonly kind: 'StrictRunJournalEventV2';
  readonly sequence: number;
  readonly runId: string;
  readonly track: 'recovery';
  readonly state: StrictRecoveryStateV2;
  readonly previousEntryHash: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly eventHash: string;
}

export interface StrictProductionJournalEntryV1 {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly runId: string;
  readonly ownerId: string;
  readonly state: StrictProductionStateV1;
  readonly timestamp: string;
  readonly previousEntryHash: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly entryHash: string;
}

interface OpenStrictProductionJournalInput {
  readonly expectedHeaderHash?: string;
  readonly operationRoot: string;
  readonly ownerId: string;
  readonly resumeOwnerId?: string;
  readonly runId: string;
}

interface StrictJournalOwnerLockV1 {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly ownerPid: number;
  readonly nonce: string;
  readonly runId: string;
  readonly acquiredAt: number;
}

const JOURNAL_FILE = 'strict-production.journal.jsonl';
const LOCK_FILE = 'strict-production.journal.lock';

/**
 * The only strict cold-start durable authority. Rows are append-only, hash chained and fsynced;
 * the daemon's generic display/event files are deliberately not consulted.
 */
export class StrictProductionJournal {
  readonly #journalPath: string;
  readonly #lockPath: string;
  readonly #lock: FileHandle;
  readonly #ownerId: string;
  readonly #runId: string;
  #entries: StrictProductionJournalEntryV1[];
  #chainTailHash: string | null;
  #nextSequence: number;
  #closed = false;

  private constructor(input: {
    entries: StrictProductionJournalEntryV1[];
    chainTailHash: string | null;
    nextSequence: number;
    journalPath: string;
    lock: FileHandle;
    lockPath: string;
    ownerId: string;
    runId: string;
  }) {
    this.#entries = input.entries;
    this.#chainTailHash = input.chainTailHash;
    this.#nextSequence = input.nextSequence;
    this.#journalPath = input.journalPath;
    this.#lock = input.lock;
    this.#lockPath = input.lockPath;
    this.#ownerId = input.ownerId;
    this.#runId = input.runId;
  }

  static async open(input: OpenStrictProductionJournalInput): Promise<StrictProductionJournal> {
    assertIdentity(input.runId, 'STRICT_JOURNAL_RUN_ID_INVALID');
    assertIdentity(input.ownerId, 'STRICT_JOURNAL_OWNER_ID_INVALID');
    await fsp.mkdir(input.operationRoot, { recursive: true });
    const operationStat = await fsp.lstat(input.operationRoot);
    if (!operationStat.isDirectory() || operationStat.isSymbolicLink()) {
      throw new Error('STRICT_JOURNAL_OPERATION_ROOT_INVALID');
    }
    const journalPath = path.join(input.operationRoot, JOURNAL_FILE);
    const lockPath = path.join(input.operationRoot, LOCK_FILE);
    const lock = await acquireOwnerLock(lockPath);
    try {
      const ownerLock: StrictJournalOwnerLockV1 = {
        schemaVersion: 1,
        ownerId: input.ownerId,
        ownerPid: process.pid,
        nonce: randomUUID(),
        runId: input.runId,
        acquiredAt: Date.now(),
      };
      await lock.writeFile(`${JSON.stringify(ownerLock)}\n`, 'utf8');
      await lock.sync();
      const verified = await readAndVerifyJournal(
        journalPath,
        input.runId,
        input.expectedHeaderHash
      );
      const lastOwnerId = verified.entries.at(-1)?.ownerId;
      if (lastOwnerId && lastOwnerId !== input.ownerId && input.resumeOwnerId !== lastOwnerId) {
        throw new Error('STRICT_JOURNAL_RESUME_OWNER_REQUIRED');
      }
      return new StrictProductionJournal({
        entries: verified.entries,
        chainTailHash: verified.chainTailHash,
        nextSequence: verified.nextSequence,
        journalPath,
        lock,
        lockPath,
        ownerId: input.ownerId,
        runId: input.runId,
      });
    } catch (error) {
      await lock.close().catch(() => {});
      await fsp.rm(lockPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  get entries(): readonly StrictProductionJournalEntryV1[] {
    return this.#entries;
  }

  get resumePoint(): StrictProductionStateV1 | null {
    return this.#entries.at(-1)?.state ?? null;
  }

  async append(
    state: StrictProductionStateV1,
    payload: Readonly<Record<string, unknown>>
  ): Promise<StrictProductionJournalEntryV1> {
    if (this.#closed) {
      throw new Error('STRICT_JOURNAL_CLOSED');
    }
    assertStateTransition(this.resumePoint, state);
    const semantic = {
      schemaVersion: 1 as const,
      sequence: this.#nextSequence,
      runId: this.#runId,
      ownerId: this.#ownerId,
      state,
      timestamp: new Date().toISOString(),
      previousEntryHash: this.#chainTailHash,
      payload,
    };
    const entry = Object.freeze({ ...semantic, entryHash: hashCanonicalJson(semantic) });
    const file = await fsp.open(this.#journalPath, 'a', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    this.#entries = [...this.#entries, entry];
    this.#chainTailHash = entry.entryHash;
    this.#nextSequence += 1;
    return entry;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#lock.close();
    await fsp.rm(this.#lockPath, { force: true });
  }
}

export async function readStrictProductionResumePoint(input: {
  readonly expectedHeaderHash?: string;
  readonly operationRoot: string;
  readonly runId: string;
}): Promise<StrictProductionStateV1 | null> {
  const verified = await readAndVerifyJournal(
    path.join(input.operationRoot, JOURNAL_FILE),
    input.runId,
    input.expectedHeaderHash
  );
  return verified.entries.at(-1)?.state ?? null;
}

export async function appendStrictSetupJournalEvent(input: {
  readonly expectedHeaderHash: string;
  readonly operationRoot: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly state: StrictSetupStateV2;
}): Promise<void> {
  const journalPath = path.join(input.operationRoot, JOURNAL_FILE);
  const verified = await readAndVerifyJournal(journalPath, input.runId, input.expectedHeaderHash);
  if (verified.entries.length > 0) {
    throw new Error('STRICT_SETUP_JOURNAL_AFTER_PRODUCTION_FORBIDDEN');
  }
  const existing = verified.setupEvents.find((event) => event.state === input.state);
  if (existing) {
    if (hashCanonicalJson(existing.payload) !== hashCanonicalJson(input.payload)) {
      throw new Error('STRICT_SETUP_JOURNAL_REPLAY_CONFLICT');
    }
    return;
  }
  assertSetupStateTransition(verified.setupEvents.at(-1)?.state ?? null, input.state);
  const semantic = {
    schemaVersion: 2 as const,
    kind: 'StrictRunJournalEventV2' as const,
    sequence: verified.nextSequence,
    runId: input.runId,
    track: 'setup' as const,
    state: input.state,
    previousEntryHash: verified.chainTailHash,
    payload: input.payload,
  };
  const event = Object.freeze({ ...semantic, eventHash: hashCanonicalJson(semantic) });
  const file = await fsp.open(journalPath, 'a', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function appendStrictRecoveryJournalEvent(input: {
  readonly expectedHeaderHash: string;
  readonly operationRoot: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly state: StrictRecoveryStateV2;
}): Promise<void> {
  const journalPath = path.join(input.operationRoot, JOURNAL_FILE);
  const verified = await readAndVerifyJournal(journalPath, input.runId, input.expectedHeaderHash);
  const existing = verified.recoveryEvents.find((event) => event.state === input.state);
  if (existing) {
    if (hashCanonicalJson(existing.payload) !== hashCanonicalJson(input.payload)) {
      throw new Error('STRICT_RECOVERY_JOURNAL_REPLAY_CONFLICT');
    }
    return;
  }
  assertRecoveryStateTransition(verified.recoveryEvents.at(-1)?.state ?? null, input.state);
  const semantic = {
    schemaVersion: 2 as const,
    kind: 'StrictRunJournalEventV2' as const,
    sequence: verified.nextSequence,
    runId: input.runId,
    track: 'recovery' as const,
    state: input.state,
    previousEntryHash: verified.chainTailHash,
    payload: input.payload,
  };
  const event = Object.freeze({ ...semantic, eventHash: hashCanonicalJson(semantic) });
  const file = await fsp.open(journalPath, 'a', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

async function acquireOwnerLock(lockPath: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fsp.open(lockPath, 'wx', 0o600);
    } catch (error: unknown) {
      if (readCode(error) !== 'EEXIST') {
        throw error;
      }
      if (!(await reclaimDeadOwnerLock(lockPath))) {
        throw new Error('STRICT_JOURNAL_OWNER_ACTIVE');
      }
    }
  }
  throw new Error('STRICT_JOURNAL_OWNER_ACTIVE');
}

async function reclaimDeadOwnerLock(lockPath: string): Promise<boolean> {
  let raw: string;
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    [raw, stat] = await Promise.all([fsp.readFile(lockPath, 'utf8'), fsp.stat(lockPath)]);
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return true;
    }
    throw error;
  }
  const record = parseOwnerLock(raw);
  if (!record || isProcessAlive(record.ownerPid)) {
    return false;
  }
  try {
    const [latestRaw, latestStat] = await Promise.all([
      fsp.readFile(lockPath, 'utf8'),
      fsp.stat(lockPath),
    ]);
    if (latestRaw !== raw || latestStat.ino !== stat.ino || latestStat.mtimeMs !== stat.mtimeMs) {
      return false;
    }
    await fsp.rm(lockPath);
    return true;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

function parseOwnerLock(raw: string): StrictJournalOwnerLockV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<StrictJournalOwnerLockV1>;
    return value.schemaVersion === 1 &&
      typeof value.ownerId === 'string' &&
      Number.isSafeInteger(value.ownerPid) &&
      Number(value.ownerPid) > 0 &&
      typeof value.nonce === 'string' &&
      typeof value.runId === 'string' &&
      Number.isFinite(value.acquiredAt)
      ? (value as StrictJournalOwnerLockV1)
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return readCode(error) === 'EPERM';
  }
}

async function readAndVerifyJournal(
  journalPath: string,
  runId: string,
  expectedHeaderHash?: string
): Promise<{
  readonly chainTailHash: string | null;
  readonly entries: StrictProductionJournalEntryV1[];
  readonly nextSequence: number;
  readonly recoveryEvents: StrictRecoveryJournalEventV2[];
  readonly setupEvents: StrictSetupJournalEventV2[];
}> {
  let content: string;
  try {
    content = await fsp.readFile(journalPath, 'utf8');
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      if (expectedHeaderHash) {
        throw new Error('STRICT_JOURNAL_HEADER_MISMATCH');
      }
      return {
        chainTailHash: null,
        entries: [],
        nextSequence: 1,
        recoveryEvents: [],
        setupEvents: [],
      };
    }
    throw error;
  }
  const rows = content.split('\n').filter(Boolean);
  const first = parseJsonRecord(rows[0]);
  const hasHeader = first?.kind === 'StrictRunJournalHeaderV2';
  if (expectedHeaderHash) {
    if (
      !hasHeader ||
      first?.schemaVersion !== 2 ||
      first.runId !== runId ||
      first.headerHash !== expectedHeaderHash
    ) {
      throw new Error('STRICT_JOURNAL_HEADER_MISMATCH');
    }
    const { headerHash, ...semantic } = first;
    if (headerHash !== hashCanonicalJson(semantic)) {
      throw new Error('STRICT_JOURNAL_HEADER_MISMATCH');
    }
  } else if (hasHeader) {
    throw new Error('STRICT_JOURNAL_HEADER_UNAUTHORIZED');
  }
  const entries: StrictProductionJournalEntryV1[] = [];
  const setupEvents: StrictSetupJournalEventV2[] = [];
  const recoveryEvents: StrictRecoveryJournalEventV2[] = [];
  let chainTailHash: string | null = null;
  for (const [index, row] of rows.slice(hasHeader ? 1 : 0).entries()) {
    const record = parseJsonRecord(row);
    if (record?.kind === 'StrictRunJournalEventV2') {
      const { eventHash, ...semantic } = record;
      const setupState = record.state as StrictSetupStateV2;
      const recoveryState = record.state as StrictRecoveryStateV2;
      const validTrackState =
        (record.track === 'setup' && STRICT_SETUP_STATES_V2.includes(setupState)) ||
        (record.track === 'recovery' && STRICT_RECOVERY_STATES_V2.includes(recoveryState));
      if (
        record.schemaVersion !== 2 ||
        record.sequence !== index + 1 ||
        record.runId !== runId ||
        !validTrackState ||
        record.previousEntryHash !== chainTailHash ||
        typeof eventHash !== 'string' ||
        eventHash !== hashCanonicalJson(semantic)
      ) {
        throw new Error('STRICT_JOURNAL_HASH_MISMATCH');
      }
      if (record.track === 'setup') {
        const event = Object.freeze(record as unknown as StrictSetupJournalEventV2);
        assertSetupStateTransition(setupEvents.at(-1)?.state ?? null, event.state);
        setupEvents.push(event);
        chainTailHash = event.eventHash;
      } else {
        const event = Object.freeze(record as unknown as StrictRecoveryJournalEventV2);
        assertRecoveryStateTransition(recoveryEvents.at(-1)?.state ?? null, event.state);
        recoveryEvents.push(event);
        chainTailHash = event.eventHash;
      }
      continue;
    }
    let parsed: StrictProductionJournalEntryV1;
    try {
      parsed = JSON.parse(row) as StrictProductionJournalEntryV1;
    } catch {
      throw new Error('STRICT_JOURNAL_ROW_INVALID');
    }
    const { entryHash, ...semantic } = parsed;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.sequence !== index + 1 ||
      parsed.runId !== runId ||
      !STRICT_PRODUCTION_STATES_V1.includes(parsed.state) ||
      parsed.previousEntryHash !== chainTailHash ||
      entryHash !== hashCanonicalJson(semantic)
    ) {
      throw new Error('STRICT_JOURNAL_HASH_MISMATCH');
    }
    assertStateTransition(entries.at(-1)?.state ?? null, parsed.state);
    entries.push(Object.freeze(parsed));
    chainTailHash = parsed.entryHash;
  }
  return {
    chainTailHash,
    entries,
    nextSequence: rows.length - (hasHeader ? 1 : 0) + 1,
    recoveryEvents,
    setupEvents,
  };
}

function parseJsonRecord(row: string | undefined): Record<string, unknown> | null {
  if (!row) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(row);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function assertStateTransition(
  previous: StrictProductionStateV1 | null,
  next: StrictProductionStateV1
): void {
  const expected =
    previous === null
      ? ['PC_F_ACCEPTED']
      : previous === 'JOURNAL_OPEN'
        ? ['SNAPSHOT_VERIFIED', 'PRISTINE_ABSENT']
        : previous === 'SNAPSHOT_VERIFIED' || previous === 'PRISTINE_ABSENT'
          ? ['BLANK']
          : [STRICT_PRODUCTION_STATES_V1[STRICT_PRODUCTION_STATES_V1.indexOf(previous) + 1]];
  if (!expected.includes(next)) {
    throw new Error('STRICT_JOURNAL_STATE_TRANSITION_INVALID');
  }
}

function assertSetupStateTransition(
  previous: StrictSetupStateV2 | null,
  next: StrictSetupStateV2
): void {
  const expected: readonly StrictSetupStateV2[] =
    previous === null
      ? ['PRE_QUIESCE_INVENTORY_VERIFIED', 'PRISTINE_ABSENT']
      : previous === 'PRE_QUIESCE_INVENTORY_VERIFIED'
        ? ['QUIESCE_REQUESTED', 'QUIESCE_NOT_RUNNING']
        : previous === 'QUIESCE_REQUESTED'
          ? ['QUIESCE_ACCEPTED']
          : previous === 'QUIESCE_ACCEPTED'
            ? ['QUIESCE_DRAINED']
            : previous === 'QUIESCE_DRAINED' || previous === 'QUIESCE_NOT_RUNNING'
              ? ['QUIESCED_OBSERVED']
              : previous === 'QUIESCED_OBSERVED'
                ? ['SNAPSHOT_COPY_STARTED']
                : previous === 'SNAPSHOT_COPY_STARTED'
                  ? ['SNAPSHOT_VERIFIED']
                  : previous === 'SNAPSHOT_VERIFIED' || previous === 'PRISTINE_ABSENT'
                    ? ['RESET_STARTED']
                    : previous === 'RESET_STARTED'
                      ? ['BLANK']
                      : [];
  if (!expected.includes(next)) {
    throw new Error('STRICT_SETUP_JOURNAL_STATE_TRANSITION_INVALID');
  }
}

function assertRecoveryStateTransition(
  previous: StrictRecoveryStateV2 | null,
  next: StrictRecoveryStateV2
): void {
  const expected: readonly StrictRecoveryStateV2[] =
    previous === null
      ? ['RECOVERY_PREPARED']
      : previous === 'RECOVERY_PREPARED'
        ? ['RECOVERY_TARGET_QUARANTINED', 'RECOVERY_VERIFIED']
        : previous === 'RECOVERY_TARGET_QUARANTINED'
          ? ['RECOVERY_INSTALLED']
          : previous === 'RECOVERY_INSTALLED'
            ? ['RECOVERY_VERIFIED']
            : [];
  if (!expected.includes(next)) {
    throw new Error('STRICT_RECOVERY_JOURNAL_STATE_TRANSITION_INVALID');
  }
}

function assertIdentity(value: string, code: string): void {
  if (!value || value.trim() !== value || value.length > 256) {
    throw new Error(code);
  }
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
