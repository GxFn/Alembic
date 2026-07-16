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
  #closed = false;

  private constructor(input: {
    entries: StrictProductionJournalEntryV1[];
    journalPath: string;
    lock: FileHandle;
    lockPath: string;
    ownerId: string;
    runId: string;
  }) {
    this.#entries = input.entries;
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
      const entries = await readAndVerifyJournal(journalPath, input.runId);
      const lastOwnerId = entries.at(-1)?.ownerId;
      if (lastOwnerId && lastOwnerId !== input.ownerId && input.resumeOwnerId !== lastOwnerId) {
        throw new Error('STRICT_JOURNAL_RESUME_OWNER_REQUIRED');
      }
      return new StrictProductionJournal({
        entries,
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
      sequence: this.#entries.length + 1,
      runId: this.#runId,
      ownerId: this.#ownerId,
      state,
      timestamp: new Date().toISOString(),
      previousEntryHash: this.#entries.at(-1)?.entryHash ?? null,
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
  runId: string
): Promise<StrictProductionJournalEntryV1[]> {
  let content: string;
  try {
    content = await fsp.readFile(journalPath, 'utf8');
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const entries: StrictProductionJournalEntryV1[] = [];
  for (const [index, row] of content.split('\n').filter(Boolean).entries()) {
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
      parsed.previousEntryHash !== (entries.at(-1)?.entryHash ?? null) ||
      entryHash !== hashCanonicalJson(semantic)
    ) {
      throw new Error('STRICT_JOURNAL_HASH_MISMATCH');
    }
    assertStateTransition(entries.at(-1)?.state ?? null, parsed.state);
    entries.push(Object.freeze(parsed));
  }
  return entries;
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
