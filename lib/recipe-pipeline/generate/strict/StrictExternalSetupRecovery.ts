import { createHash, randomUUID } from 'node:crypto';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type { StrictProductionAuthorizationReceiptV1 } from './StrictAuthorization.js';
import { readStrictProductionResumePoint } from './StrictProductionJournal.js';
import {
  createMainStrictResetDatabasePort,
  executeExactStrictReset,
  type StrictResetReceiptV1,
} from './StrictResetProtocol.js';

const AUTHORITY_ENV = 'ALEMBIC_STRICT_SETUP_AUTHORITY_PATH';
const ACTION_ENV = 'ALEMBIC_STRICT_SETUP_ACTION_PATH';
const RUNTIME_ARTIFACT_MANIFEST_ENV = 'ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH';
const AUTHORITY_KIND = 'StrictSetupAuthorityReceiptV1';
const OPERATION_LOCK_FILE = 'strict-production.operation.lock';
const JOURNAL_FILE = 'strict-production.journal.jsonl';
const SETUP_STATE_FILE = 'strict-external-setup-state.json';
const RECOVERY_TRANSACTION_FILE = 'strict-external-recovery-transaction.json';

export interface StrictPlannedAbsentPathReceiptV1 {
  readonly schemaVersion: 1;
  readonly authorizedExistingParentRealpathHash: string;
  readonly normalizedLeafChain: readonly string[];
  readonly parentIdentityHash: string;
  readonly lstatNoSymlink: true;
  readonly leafAbsent: true;
  readonly receiptHash: string;
}

interface StrictExternalRootBindingV1 {
  readonly ref: string;
  readonly relativePath?: string;
  readonly pathHash: string;
  readonly plannedAbsentPathReceipt?: StrictPlannedAbsentPathReceiptV1;
}

export interface StrictExternalAuthorizationV1
  extends Omit<
    StrictProductionAuthorizationReceiptV1,
    'schemaVersion' | 'runId' | 'projectRoot' | 'dataRoot' | 'operationRoot' | 'authorizationHash'
  > {}

export interface StrictSetupAuthorityReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof AUTHORITY_KIND;
  readonly runId: string;
  readonly scenario: 'pristine' | 'rebuild';
  readonly projectRootHash: string;
  readonly authorityRootHash: string;
  readonly roots: {
    readonly dataRoot: StrictExternalRootBindingV1;
    readonly operationLockRoot: StrictExternalRootBindingV1 & {
      readonly relativePath: string;
    };
    readonly evidenceRoot: StrictExternalRootBindingV1 & {
      readonly relativePath: string;
    };
    readonly snapshotRoot: (StrictExternalRootBindingV1 & { readonly relativePath: string }) | null;
  };
  readonly pathPlanHash: string;
  readonly plannedAbsentPathReceiptHash: string;
  readonly preResetObservation: StrictPreResetObservationV1 | null;
  readonly restorePolicy: {
    readonly kind: 'pristine-discard' | 'rebuild-whole-root';
    readonly ref: string;
    readonly allowPreCasRestore: boolean;
    readonly allowPostCasRestore: boolean;
    readonly restorePolicyHash: string;
  };
  readonly authorization: StrictExternalAuthorizationV1;
  readonly authorityHash: string;
}

interface StrictPreResetObservationV1 {
  readonly schemaVersion: 1;
  readonly ref: string;
  readonly rootTreeHash: string;
  readonly configHash: string;
  readonly readerStateHash: string;
  readonly markerHash: string;
  readonly baselineReadHash: string;
  readonly publicRouteHash: string;
  readonly observationHash: string;
}

interface StrictSetupActionReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: 'StrictSetupActionReceiptV1';
  readonly runId: string;
  readonly setupAuthorityHash: string;
  readonly action: 'execute' | 'recover' | 'complete';
  readonly actionHash: string;
}

export interface StrictExternalSetupSession {
  readonly authority: StrictSetupAuthorityReceiptV1;
  readonly authorityPath: string;
  readonly action: 'execute' | 'recover' | 'complete';
  readonly actionHash: string;
  readonly dataRoot: string;
  readonly evidenceRoot: string;
  readonly operationLockRoot: string;
  readonly operationRoot: string;
  readonly projectRoot: string;
  readonly resumedFromHeader: boolean;
  readonly runtimeArtifactManifestPathHash: string;
  readonly scenario: 'pristine' | 'rebuild';
  readonly snapshotRoot: string | null;
  readonly journalHeaderHash: string;
  close(): Promise<void>;
}

export interface StrictExternalSetupStateV1 {
  readonly schemaVersion: 1;
  readonly scenario: 'pristine' | 'rebuild';
  readonly setupAuthorityHash: string;
  readonly sourceTreeHash: string | null;
  readonly snapshotTreeHash: string | null;
  readonly restoreProbeTreeHash: string | null;
  readonly preResetProtectedHash: string | null;
  readonly resetReceipt: StrictResetReceiptV1 | null;
  readonly targetInitialized: true;
  readonly stateHash: string;
}

export interface StrictExternalRecoveryReceiptV1 {
  readonly schemaVersion: 1;
  readonly scenario: 'pristine' | 'rebuild';
  readonly setupAuthorityHash: string;
  readonly restoredTreeHash: string | null;
  readonly preResetObservationHash: string | null;
  readonly targetAbsent: boolean;
  readonly receiptHash: string;
}

interface ActiveSession extends StrictExternalSetupSession {
  readonly lock: FileHandle;
  readonly lockPath: string;
}

interface StrictRecoveryTransactionV1 {
  readonly schemaVersion: 1;
  readonly setupAuthorityHash: string;
  readonly expectedTreeHash: string;
  readonly restoreLeaf: string;
  readonly quarantineLeaf: string;
  readonly phase: 'prepared' | 'target-quarantined' | 'installed';
  readonly transactionHash: string;
}

let activeSession: ActiveSession | null = null;

export async function createStrictPlannedAbsentPathReceipt(
  targetPath: string
): Promise<StrictPlannedAbsentPathReceiptV1> {
  const target = path.resolve(targetPath);
  const { existingParent, leafChain } = await findExistingParent(target);
  await assertNoSymlinkSegments(existingParent, target);
  if (await exists(target)) {
    throw new Error('STRICT_SETUP_PLANNED_PATH_ALREADY_EXISTS');
  }
  const realParent = await fsp.realpath(existingParent);
  const stat = await fsp.lstat(realParent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('STRICT_SETUP_PLANNED_PARENT_INVALID');
  }
  const parentRealpathHash = hashPath(realParent);
  const semantic = {
    schemaVersion: 1 as const,
    authorizedExistingParentRealpathHash: parentRealpathHash,
    normalizedLeafChain: leafChain,
    parentIdentityHash: hashCanonicalJson({
      device: String(stat.dev),
      inode: String(stat.ino),
      realpathHash: parentRealpathHash,
    }),
    lstatNoSymlink: true as const,
    leafAbsent: true as const,
  };
  return Object.freeze({
    ...semantic,
    receiptHash: hashCanonicalJson(semantic),
  });
}

export async function createStrictPreResetObservation(input: {
  readonly dataRoot: string;
  readonly ref: string;
}): Promise<StrictPreResetObservationV1> {
  if (!isSymbol(input.ref)) {
    throw new Error('STRICT_SETUP_PRE_RESET_OBSERVATION_INVALID');
  }
  const dataRoot = path.resolve(input.dataRoot);
  const configHash = await hashOptionalFile(path.join(dataRoot, '.asd/config.json'));
  const readerStateHash = await hashOptionalTree(
    path.join(dataRoot, '.asd/context/recipe-publications')
  );
  const markerHash = await hashOptionalJson(
    path.join(dataRoot, '.asd/context/recipe-publications/marker.json')
  );
  const publicRouteHash = await hashOptionalJson(
    path.join(dataRoot, '.asd/context/recipe-publications/active.json')
  );
  const semantic = {
    schemaVersion: 1 as const,
    ref: input.ref,
    rootTreeHash: await hashWholeRoot(dataRoot),
    configHash,
    readerStateHash,
    markerHash,
    baselineReadHash: hashCanonicalJson({ readerStateHash, publicRouteHash }),
    publicRouteHash,
  };
  return Object.freeze({
    ...semantic,
    observationHash: hashCanonicalJson(semantic),
  });
}

export async function prepareStrictExternalSetupFromEnvironment(input: {
  readonly dataRoot: string;
  readonly projectRoot: string;
}): Promise<StrictExternalSetupSession | null> {
  const configured = process.env[AUTHORITY_ENV]?.trim();
  if (!configured) {
    return null;
  }
  if (!path.isAbsolute(configured)) {
    throw new Error('STRICT_SETUP_AUTHORITY_PATH_INVALID');
  }
  const authorityPath = path.resolve(configured);
  await assertExistingRegularFileWithoutSymlink(authorityPath);
  const authority = await readAuthority(authorityPath);
  const authorityRoot = path.dirname(authorityPath);
  const actionReceipt = await readSetupActionReceipt(authorityRoot, authority);
  const dataRoot = path.resolve(input.dataRoot);
  const projectRoot = path.resolve(input.projectRoot);
  await assertExistingDirectoryWithoutSymlink(projectRoot);
  if (
    authority.authorityRootHash !== hashPath(authorityRoot) ||
    authority.projectRootHash !== hashPath(projectRoot) ||
    authority.roots.dataRoot.pathHash !== hashPath(dataRoot)
  ) {
    throw new Error('STRICT_SETUP_ROOT_BINDING_MISMATCH');
  }
  const operationLockRoot = resolveExternalRoot(authorityRoot, authority.roots.operationLockRoot);
  const evidenceRoot = resolveExternalRoot(authorityRoot, authority.roots.evidenceRoot);
  const snapshotRoot = authority.roots.snapshotRoot
    ? resolveExternalRoot(authorityRoot, authority.roots.snapshotRoot)
    : null;
  assertTopology({
    authorityPath,
    dataRoot,
    evidenceRoot,
    operationLockRoot,
    projectRoot,
    snapshotRoot,
  });
  const runtimeArtifactManifestPathHash = await validateRuntimeArtifactManifestBoundary({
    authorityPath,
    dataRoot,
    evidenceRoot,
    operationLockRoot,
    projectRoot,
    snapshotRoot,
  });
  const resumedFromHeader = await hasMatchingExternalHeader(evidenceRoot, authority);
  const resumedFromLease = await hasMatchingExternalLease(operationLockRoot, authority);
  const operationRoot = path.join(evidenceRoot, 'strict-run-journal', authority.runId);
  const recoveryInterrupted = await hasResumableRecoveryTransaction({
    authority,
    dataRoot,
    operationRoot,
  });
  await verifyPlannedBinding(
    dataRoot,
    authority.roots.dataRoot,
    authority.scenario === 'pristine',
    resumedFromHeader,
    recoveryInterrupted
  );
  await verifyPlannedBinding(
    operationLockRoot,
    authority.roots.operationLockRoot,
    true,
    resumedFromHeader || resumedFromLease
  );
  await verifyPlannedBinding(
    evidenceRoot,
    authority.roots.evidenceRoot,
    true,
    resumedFromHeader || resumedFromLease
  );
  if (authority.scenario === 'pristine' && snapshotRoot !== null) {
    throw new Error('STRICT_SETUP_PRISTINE_SNAPSHOT_FORBIDDEN');
  }
  if (authority.scenario === 'rebuild' && snapshotRoot === null) {
    throw new Error('STRICT_SETUP_REBUILD_SNAPSHOT_REQUIRED');
  }
  if (snapshotRoot && authority.roots.snapshotRoot) {
    await verifyPlannedBinding(snapshotRoot, authority.roots.snapshotRoot, true, resumedFromHeader);
  }
  if (activeSession) {
    if (
      activeSession.authority.authorityHash !== authority.authorityHash ||
      activeSession.actionHash !== actionReceipt.actionHash
    ) {
      throw new Error('STRICT_SETUP_SESSION_ALREADY_ACTIVE');
    }
    return activeSession;
  }
  await fsp.mkdir(operationLockRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(operationLockRoot, OPERATION_LOCK_FILE);
  const lock = await acquireOperationLock(lockPath, authority);
  try {
    await fsp.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const journalHeaderHash = await initializeExternalJournalHeader({
      authority,
      operationRoot,
      runtimeArtifactManifestPathHash,
    });
    await persistSanitizedTopologyReceipt({
      authority,
      operationRoot,
      runtimeArtifactManifestPathHash,
      actionHash: actionReceipt.actionHash,
    });
    const session: ActiveSession = {
      authority,
      authorityPath,
      action: actionReceipt.action,
      actionHash: actionReceipt.actionHash,
      dataRoot,
      evidenceRoot,
      lock,
      lockPath,
      operationLockRoot,
      operationRoot,
      projectRoot,
      resumedFromHeader,
      runtimeArtifactManifestPathHash,
      scenario: authority.scenario,
      snapshotRoot,
      journalHeaderHash,
      async close() {
        await closeOperationLock(this);
      },
    };
    activeSession = session;
    return session;
  } catch (error: unknown) {
    await lock.close().catch(() => {});
    await fsp.rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function getStrictExternalSetupSession(): StrictExternalSetupSession | null {
  return activeSession;
}

export async function releaseStrictExternalSetupSession(): Promise<void> {
  if (!activeSession) {
    return;
  }
  const session = activeSession;
  activeSession = null;
  await closeOperationLock(session);
}

/**
 * Runs before ordinary Alembic logging/database initialization. Rebuild snapshots cover the
 * complete target root and are verified through a disposable restore probe; pristine creates the
 * target only after the external lock and journal header are durable.
 */
export async function initializeStrictExternalSetupTarget(
  session: StrictExternalSetupSession
): Promise<StrictExternalSetupStateV1> {
  const existing = await readSetupState(session);
  if (existing) {
    await verifySetupState(session, existing, true);
    return existing;
  }
  let sourceTreeHash: string | null = null;
  let snapshotTreeHash: string | null = null;
  let restoreProbeTreeHash: string | null = null;
  let preResetProtectedHash: string | null = null;
  if (session.scenario === 'pristine') {
    if (session.authority.authorization.expectedPublicRouteHash !== null) {
      throw new Error('STRICT_SETUP_PRISTINE_PUBLIC_ROUTE_FORBIDDEN');
    }
    if (await exists(session.dataRoot)) {
      if (!session.resumedFromHeader) {
        throw new Error('STRICT_SETUP_PRISTINE_TARGET_NOT_ABSENT');
      }
      await assertExistingDirectoryWithoutSymlink(session.dataRoot);
    } else {
      await fsp.mkdir(session.dataRoot, { recursive: false, mode: 0o700 });
      await syncDirectory(path.dirname(session.dataRoot));
    }
  } else {
    if (!session.snapshotRoot) {
      throw new Error('STRICT_SETUP_REBUILD_SNAPSHOT_REQUIRED');
    }
    await assertExistingDirectoryWithoutSymlink(session.dataRoot);
    if (await exists(path.join(session.dataRoot, '.asd/secrets.json'))) {
      throw new Error('STRICT_SETUP_CREDENTIAL_IN_TARGET');
    }
    await assertExpectedPublicRouteBinding(session);
    preResetProtectedHash = await hashPreResetProtectedBindings(session.dataRoot);
    sourceTreeHash = await hashWholeRoot(session.dataRoot);
    const expectedObservation = session.authority.preResetObservation;
    if (!expectedObservation) {
      throw new Error('STRICT_SETUP_PRE_RESET_OBSERVATION_INVALID');
    }
    const observed = await createStrictPreResetObservation({
      dataRoot: session.dataRoot,
      ref: expectedObservation.ref,
    });
    if (hashCanonicalJson(observed) !== hashCanonicalJson(expectedObservation)) {
      throw new Error('STRICT_SETUP_PRE_RESET_OBSERVATION_MISMATCH');
    }
    const snapshot = path.join(session.snapshotRoot, 'whole-root');
    const probe = path.join(session.snapshotRoot, 'restore-probe');
    if (!(await exists(snapshot))) {
      await fsp.mkdir(session.snapshotRoot, { recursive: true, mode: 0o700 });
      await copyWholeRoot(session.dataRoot, snapshot);
      await syncTree(snapshot);
      await copyWholeRoot(snapshot, probe);
      await syncTree(probe);
    }
    snapshotTreeHash = await hashWholeRoot(snapshot);
    restoreProbeTreeHash = await hashWholeRoot(probe);
    if (snapshotTreeHash !== sourceTreeHash || restoreProbeTreeHash !== sourceTreeHash) {
      throw new Error('STRICT_SETUP_RESTORE_PROBE_DIVERGENCE');
    }
  }
  return await persistSetupState(session, {
    sourceTreeHash,
    snapshotTreeHash,
    restoreProbeTreeHash,
    preResetProtectedHash,
    resetReceipt: null,
  });
}

/** Runs after the existing database connection is open and before migrations or strict work. */
export async function executeStrictExternalSetupReset(input: {
  readonly database: unknown;
  readonly session: StrictExternalSetupSession;
}): Promise<StrictExternalSetupStateV1> {
  const current = await initializeStrictExternalSetupTarget(input.session);
  if (current.resetReceipt || input.session.scenario === 'pristine') {
    return current;
  }
  if (
    !current.preResetProtectedHash ||
    (await hashPreResetProtectedBindings(input.session.dataRoot)) !== current.preResetProtectedHash
  ) {
    throw new Error('STRICT_SETUP_PRE_RESET_PROTECTED_DRIFT');
  }
  const resetReceipt = await executeExactStrictReset({
    allowedRelativePaths: input.session.authority.authorization.reset.relativePaths,
    allowedTables: input.session.authority.authorization.reset.tables,
    dataRoot: input.session.dataRoot,
    database: createMainStrictResetDatabasePort(input.database),
  });
  if (
    (await hashPreResetProtectedBindings(input.session.dataRoot)) !== current.preResetProtectedHash
  ) {
    throw new Error('STRICT_SETUP_RESET_TOUCHED_PROTECTED_STATE');
  }
  return await persistSetupState(input.session, {
    sourceTreeHash: current.sourceTreeHash,
    snapshotTreeHash: current.snapshotTreeHash,
    restoreProbeTreeHash: current.restoreProbeTreeHash,
    preResetProtectedHash: current.preResetProtectedHash,
    resetReceipt,
  });
}

export async function readStrictExternalSetupState(
  session: StrictExternalSetupSession
): Promise<StrictExternalSetupStateV1> {
  const state = await readSetupState(session);
  if (!state) {
    throw new Error('STRICT_SETUP_STATE_MISSING');
  }
  await verifySetupState(session, state);
  return state;
}

/** Restores the whole rebuild root or removes a pristine demand-owned root. */
export async function recoverStrictExternalSetup(
  session: StrictExternalSetupSession
): Promise<StrictExternalRecoveryReceiptV1> {
  const existingReceipt = await readExistingRecoveryReceipt(session);
  if (existingReceipt) {
    return existingReceipt;
  }
  await assertRecoveryPolicy(session);
  let restoredTreeHash: string | null = null;
  let preResetObservationHash: string | null = null;
  if (session.scenario === 'pristine') {
    await fsp.rm(session.dataRoot, { force: true, recursive: true });
    await syncDirectory(path.dirname(session.dataRoot));
    if (await exists(session.dataRoot)) {
      throw new Error('STRICT_SETUP_PRISTINE_DISCARD_FAILED');
    }
  } else {
    if (!session.snapshotRoot) {
      throw new Error('STRICT_SETUP_REBUILD_SNAPSHOT_REQUIRED');
    }
    const state = await readStrictExternalSetupState(session);
    const snapshot = path.join(session.snapshotRoot, 'whole-root');
    if (!state.snapshotTreeHash || (await hashWholeRoot(snapshot)) !== state.snapshotTreeHash) {
      throw new Error('STRICT_SETUP_SNAPSHOT_HASH_MISMATCH');
    }
    if (!state.sourceTreeHash) {
      throw new Error('STRICT_SETUP_STATE_INVALID');
    }
    restoredTreeHash = await restoreWholeRootCrashSafely({
      expectedTreeHash: state.sourceTreeHash,
      session,
      snapshot,
    });
    if ((await hashWholeRoot(session.dataRoot)) !== restoredTreeHash) {
      throw new Error('STRICT_SETUP_RESTORE_READBACK_MISMATCH');
    }
    const expectedObservation = session.authority.preResetObservation;
    if (!expectedObservation) {
      throw new Error('STRICT_SETUP_PRE_RESET_OBSERVATION_INVALID');
    }
    const observed = await createStrictPreResetObservation({
      dataRoot: session.dataRoot,
      ref: expectedObservation.ref,
    });
    if (hashCanonicalJson(observed) !== hashCanonicalJson(expectedObservation)) {
      throw new Error('STRICT_SETUP_RESTORE_RESELECTION_MISMATCH');
    }
    preResetObservationHash = observed.observationHash;
  }
  const semantic = {
    schemaVersion: 1 as const,
    scenario: session.scenario,
    setupAuthorityHash: session.authority.authorityHash,
    restoredTreeHash,
    preResetObservationHash,
    targetAbsent: session.scenario === 'pristine',
  };
  const receipt = Object.freeze({
    ...semantic,
    receiptHash: hashCanonicalJson(semantic),
  });
  await fsp.rm(path.join(session.operationRoot, SETUP_STATE_FILE), {
    force: true,
  });
  await writeDurableJson(path.join(session.operationRoot, 'strict-recovery-receipt.json'), receipt);
  return receipt;
}

export async function dispatchStrictExternalSetupStartup(
  session: StrictExternalSetupSession
): Promise<
  | {
      readonly startRuntime: true;
      readonly receipt: StrictExternalSetupStateV1;
    }
  | {
      readonly startRuntime: false;
      readonly receipt: StrictExternalRecoveryReceiptV1 | Readonly<Record<string, unknown>>;
    }
> {
  if (session.action === 'execute') {
    return {
      startRuntime: true,
      receipt: await initializeStrictExternalSetupTarget(session),
    };
  }
  if (session.action === 'recover') {
    const receipt = await recoverStrictExternalSetup(session);
    await releaseStrictExternalSetupSession();
    return { startRuntime: false, receipt };
  }
  const resumePoint = await readExternalResumePoint(session);
  if (resumePoint !== 'FINALIZED') {
    throw new Error('STRICT_SETUP_COMPLETE_BEFORE_FINALIZED');
  }
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'StrictExternalSetupCompletionReceiptV1' as const,
    runIdHash: hashCanonicalJson(session.authority.runId),
    setupAuthorityHash: session.authority.authorityHash,
    actionHash: session.actionHash,
  };
  const receipt = Object.freeze({
    ...semantic,
    receiptHash: hashCanonicalJson(semantic),
  });
  await writeDurableJson(
    path.join(session.operationRoot, 'strict-completion-receipt.json'),
    receipt
  );
  await releaseStrictExternalSetupSession();
  return { startRuntime: false, receipt };
}

async function assertRecoveryPolicy(session: StrictExternalSetupSession): Promise<void> {
  const resumePoint = await readExternalResumePoint(session);
  const postCas = resumePoint === 'PUBLIC_CAS_COMMITTED' || resumePoint === 'FINALIZED';
  if (
    (postCas && !session.authority.restorePolicy.allowPostCasRestore) ||
    (!postCas && !session.authority.restorePolicy.allowPreCasRestore)
  ) {
    throw new Error('STRICT_SETUP_RECOVERY_PHASE_UNAUTHORIZED');
  }
}

async function readExternalResumePoint(
  session: StrictExternalSetupSession
): Promise<string | null> {
  return await readStrictProductionResumePoint({
    expectedHeaderHash: session.journalHeaderHash,
    operationRoot: session.operationRoot,
    runId: session.authority.runId,
  });
}

async function readExistingRecoveryReceipt(
  session: StrictExternalSetupSession
): Promise<StrictExternalRecoveryReceiptV1 | null> {
  let value: unknown;
  try {
    value = JSON.parse(
      await fsp.readFile(path.join(session.operationRoot, 'strict-recovery-receipt.json'), 'utf8')
    );
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!isRecord(value)) {
    throw new Error('STRICT_SETUP_RECOVERY_RECEIPT_INVALID');
  }
  const { receiptHash, ...semantic } = value;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'scenario',
      'setupAuthorityHash',
      'restoredTreeHash',
      'preResetObservationHash',
      'targetAbsent',
      'receiptHash',
    ]) ||
    value.schemaVersion !== 1 ||
    value.scenario !== session.scenario ||
    value.setupAuthorityHash !== session.authority.authorityHash ||
    receiptHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_SETUP_RECOVERY_RECEIPT_INVALID');
  }
  return Object.freeze(value as unknown as StrictExternalRecoveryReceiptV1);
}

async function restoreWholeRootCrashSafely(input: {
  readonly expectedTreeHash: string;
  readonly session: StrictExternalSetupSession;
  readonly snapshot: string;
}): Promise<string> {
  const parent = path.dirname(input.session.dataRoot);
  const token = input.session.authority.authorityHash.slice(
    'sha256:'.length,
    'sha256:'.length + 16
  );
  const restoreLeaf = `${path.basename(input.session.dataRoot)}.strict-restore-${token}`;
  const quarantineLeaf = `${path.basename(input.session.dataRoot)}.strict-quarantine-${token}`;
  const restoreRoot = path.join(parent, restoreLeaf);
  const quarantineRoot = path.join(parent, quarantineLeaf);
  let transaction = await readRecoveryTransaction(input.session.operationRoot);
  if (!transaction) {
    await fsp.rm(restoreRoot, { recursive: true, force: true });
    await copyWholeRoot(input.snapshot, restoreRoot);
    await syncTree(restoreRoot);
    if ((await hashWholeRoot(restoreRoot)) !== input.expectedTreeHash) {
      throw new Error('STRICT_SETUP_RESTORE_HASH_MISMATCH');
    }
    transaction = await writeRecoveryTransaction(input.session.operationRoot, {
      setupAuthorityHash: input.session.authority.authorityHash,
      expectedTreeHash: input.expectedTreeHash,
      restoreLeaf,
      quarantineLeaf,
      phase: 'prepared',
    });
  }
  assertRecoveryTransactionBinding(transaction, input.session, input.expectedTreeHash);

  const targetExists = await exists(input.session.dataRoot);
  const restoreExists = await exists(restoreRoot);
  const quarantineExists = await exists(quarantineRoot);
  if (targetExists && restoreExists && !quarantineExists) {
    await fsp.rename(input.session.dataRoot, quarantineRoot);
    await syncDirectory(parent);
    transaction = await writeRecoveryTransaction(input.session.operationRoot, {
      ...withoutTransactionHash(transaction),
      phase: 'target-quarantined',
    });
  }
  if (!(await exists(input.session.dataRoot)) && (await exists(restoreRoot))) {
    if (!(await exists(quarantineRoot))) {
      throw new Error('STRICT_SETUP_RECOVERY_TRANSACTION_DIVERGENCE');
    }
    await fsp.rename(restoreRoot, input.session.dataRoot);
    await syncDirectory(parent);
    transaction = await writeRecoveryTransaction(input.session.operationRoot, {
      ...withoutTransactionHash(transaction),
      phase: 'installed',
    });
  }
  if (
    (await exists(input.session.dataRoot)) &&
    !(await exists(restoreRoot)) &&
    !(await exists(quarantineRoot)) &&
    (await hashWholeRoot(input.session.dataRoot)) === input.expectedTreeHash
  ) {
    await fsp.rm(path.join(input.session.operationRoot, RECOVERY_TRANSACTION_FILE), {
      force: true,
    });
    await syncDirectory(input.session.operationRoot);
    return input.expectedTreeHash;
  }
  if (!(await exists(input.session.dataRoot)) || !(await exists(quarantineRoot))) {
    throw new Error('STRICT_SETUP_RECOVERY_TRANSACTION_DIVERGENCE');
  }
  const restoredHash = await hashWholeRoot(input.session.dataRoot);
  if (restoredHash !== input.expectedTreeHash) {
    throw new Error('STRICT_SETUP_RESTORE_READBACK_MISMATCH');
  }
  await fsp.rm(quarantineRoot, { recursive: true, force: true });
  await syncDirectory(parent);
  await fsp.rm(path.join(input.session.operationRoot, RECOVERY_TRANSACTION_FILE), { force: true });
  await syncDirectory(input.session.operationRoot);
  return restoredHash;
}

async function readRecoveryTransaction(
  operationRoot: string
): Promise<StrictRecoveryTransactionV1 | null> {
  let value: unknown;
  try {
    value = JSON.parse(
      await fsp.readFile(path.join(operationRoot, RECOVERY_TRANSACTION_FILE), 'utf8')
    );
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!isRecord(value)) {
    throw new Error('STRICT_SETUP_RECOVERY_TRANSACTION_INVALID');
  }
  const { transactionHash, ...semantic } = value;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'setupAuthorityHash',
      'expectedTreeHash',
      'restoreLeaf',
      'quarantineLeaf',
      'phase',
      'transactionHash',
    ]) ||
    value.schemaVersion !== 1 ||
    !isSha(value.setupAuthorityHash) ||
    !isSha(value.expectedTreeHash) ||
    !isSafeLeaf(value.restoreLeaf) ||
    !isSafeLeaf(value.quarantineLeaf) ||
    (value.phase !== 'prepared' &&
      value.phase !== 'target-quarantined' &&
      value.phase !== 'installed') ||
    transactionHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_SETUP_RECOVERY_TRANSACTION_INVALID');
  }
  return Object.freeze(value as unknown as StrictRecoveryTransactionV1);
}

async function writeRecoveryTransaction(
  operationRoot: string,
  semantic: Omit<StrictRecoveryTransactionV1, 'schemaVersion' | 'transactionHash'>
): Promise<StrictRecoveryTransactionV1> {
  const value = Object.freeze({
    schemaVersion: 1 as const,
    ...semantic,
    transactionHash: hashCanonicalJson({ schemaVersion: 1, ...semantic }),
  });
  await writeDurableJson(path.join(operationRoot, RECOVERY_TRANSACTION_FILE), value);
  return value;
}

function withoutTransactionHash(
  value: StrictRecoveryTransactionV1
): Omit<StrictRecoveryTransactionV1, 'schemaVersion' | 'transactionHash'> {
  return {
    setupAuthorityHash: value.setupAuthorityHash,
    expectedTreeHash: value.expectedTreeHash,
    restoreLeaf: value.restoreLeaf,
    quarantineLeaf: value.quarantineLeaf,
    phase: value.phase,
  };
}

function assertRecoveryTransactionBinding(
  value: StrictRecoveryTransactionV1,
  session: StrictExternalSetupSession,
  expectedTreeHash: string
): void {
  const token = session.authority.authorityHash.slice('sha256:'.length, 'sha256:'.length + 16);
  if (
    value.setupAuthorityHash !== session.authority.authorityHash ||
    value.expectedTreeHash !== expectedTreeHash ||
    value.restoreLeaf !== `${path.basename(session.dataRoot)}.strict-restore-${token}` ||
    value.quarantineLeaf !== `${path.basename(session.dataRoot)}.strict-quarantine-${token}`
  ) {
    throw new Error('STRICT_SETUP_RECOVERY_TRANSACTION_DIVERGENCE');
  }
}

async function hasResumableRecoveryTransaction(input: {
  readonly authority: StrictSetupAuthorityReceiptV1;
  readonly dataRoot: string;
  readonly operationRoot: string;
}): Promise<boolean> {
  const transaction = await readRecoveryTransaction(input.operationRoot);
  if (!transaction) {
    return false;
  }
  assertRecoveryTransactionBinding(
    transaction,
    {
      authority: input.authority,
      dataRoot: input.dataRoot,
    } as StrictExternalSetupSession,
    transaction.expectedTreeHash
  );
  return true;
}

function isSafeLeaf(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && path.basename(value) === value;
}

export function assertStrictSetupRequestBinding(input: {
  readonly request: {
    readonly authorizationReceiptHash: string;
    readonly runId: string;
    readonly setupAuthority?: {
      readonly action: 'execute' | 'recover' | 'complete';
      readonly scenario: 'pristine' | 'rebuild';
      readonly snapshotRootRef: string;
      readonly operationLockRootRef: string;
      readonly evidenceRootRef: string;
      readonly plannedAbsentPathReceiptHash: string;
      readonly preResetObservationRef: string;
      readonly restorePolicyRef: string;
      readonly pathPlanHash: string;
    };
  };
  readonly session: StrictExternalSetupSession;
}): void {
  const { request, session } = input;
  const setup = request.setupAuthority;
  const authorizationHash = hashCanonicalJson(session.authority.authorization);
  const expectedSnapshotRef =
    session.authority.roots.snapshotRoot?.ref ?? 'NOT_APPLICABLE_PHYSICAL_ABSENCE';
  const expectedObservationRef =
    session.authority.preResetObservation === null
      ? 'NOT_APPLICABLE_PHYSICAL_ABSENCE'
      : readRequiredSymbol(session.authority.preResetObservation.ref);
  if (
    !setup ||
    setup.action !== session.action ||
    request.runId !== session.authority.runId ||
    request.authorizationReceiptHash !== authorizationHash ||
    setup.scenario !== session.scenario ||
    setup.snapshotRootRef !== expectedSnapshotRef ||
    setup.operationLockRootRef !== session.authority.roots.operationLockRoot.ref ||
    setup.evidenceRootRef !== session.authority.roots.evidenceRoot.ref ||
    setup.plannedAbsentPathReceiptHash !== session.authority.plannedAbsentPathReceiptHash ||
    setup.preResetObservationRef !== expectedObservationRef ||
    setup.restorePolicyRef !== session.authority.restorePolicy.ref ||
    setup.pathPlanHash !== session.authority.pathPlanHash
  ) {
    throw new Error('STRICT_SETUP_REQUEST_BINDING_MISMATCH');
  }
}

export async function persistStrictExternalAuthorizationLoadReceipt(input: {
  readonly authorizationHash: string;
  readonly session: StrictExternalSetupSession;
}): Promise<string> {
  if (!isSha(input.authorizationHash)) {
    throw new Error('STRICT_SETUP_AUTHORIZATION_HASH_INVALID');
  }
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'StrictExternalAuthorizationLoadReceiptV1' as const,
    setupAuthorityHash: input.session.authority.authorityHash,
    authorizationHash: input.authorizationHash,
    runIdHash: hashCanonicalJson(input.session.authority.runId),
    migrationBundleHash:
      input.session.authority.authorization.privateCorpus.acceptedMigrationBundleSemanticHash,
    credentialLocationSymbolHash: hashCanonicalJson(
      input.session.authority.authorization.privateCorpus.credentialLocationSymbol
    ),
  };
  const receipt = Object.freeze({
    ...semantic,
    receiptHash: hashCanonicalJson(semantic),
  });
  await writeDurableJson(
    path.join(input.session.operationRoot, 'strict-authorization-load-receipt.json'),
    receipt
  );
  return receipt.receiptHash;
}

async function closeOperationLock(session: ActiveSession): Promise<void> {
  await session.lock.close().catch(() => {});
  await fsp.rm(session.lockPath, { force: true }).catch(() => {});
}

async function persistSetupState(
  session: StrictExternalSetupSession,
  value: Omit<
    StrictExternalSetupStateV1,
    'schemaVersion' | 'scenario' | 'setupAuthorityHash' | 'stateHash' | 'targetInitialized'
  >
): Promise<StrictExternalSetupStateV1> {
  const semantic = {
    schemaVersion: 1 as const,
    scenario: session.scenario,
    setupAuthorityHash: session.authority.authorityHash,
    sourceTreeHash: value.sourceTreeHash,
    snapshotTreeHash: value.snapshotTreeHash,
    restoreProbeTreeHash: value.restoreProbeTreeHash,
    preResetProtectedHash: value.preResetProtectedHash,
    resetReceipt: value.resetReceipt,
    targetInitialized: true as const,
  };
  const state = Object.freeze({
    ...semantic,
    stateHash: hashCanonicalJson(semantic),
  });
  await writeDurableJson(path.join(session.operationRoot, SETUP_STATE_FILE), state);
  return state;
}

async function persistSanitizedTopologyReceipt(input: {
  readonly authority: StrictSetupAuthorityReceiptV1;
  readonly operationRoot: string;
  readonly runtimeArtifactManifestPathHash: string;
  readonly actionHash?: string;
}): Promise<void> {
  const roots = Object.fromEntries(
    Object.entries(input.authority.roots).map(([name, binding]) => [
      name,
      binding === null
        ? null
        : {
            ref: binding.ref,
            pathHash: binding.pathHash,
            plannedAbsentPathReceiptHash: binding.plannedAbsentPathReceipt?.receiptHash ?? null,
          },
    ])
  );
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'StrictExternalTopologyReceiptV1' as const,
    setupAuthorityHash: input.authority.authorityHash,
    actionHash: input.actionHash ?? null,
    projectRootHash: input.authority.projectRootHash,
    authorityRootHash: input.authority.authorityRootHash,
    pathPlanHash: input.authority.pathPlanHash,
    runtimeArtifactManifestPathHash: input.runtimeArtifactManifestPathHash,
    roots,
    overlapCheck: 'NON_OVERLAPPING' as const,
    symlinkPolicy: 'LSTAT_NO_SYMLINK' as const,
  };
  await writeDurableJson(
    path.join(input.operationRoot, 'strict-setup-topology-receipt.json'),
    Object.freeze({ ...semantic, receiptHash: hashCanonicalJson(semantic) })
  );
}

async function readSetupState(
  session: StrictExternalSetupSession
): Promise<StrictExternalSetupStateV1 | null> {
  const statePath = path.join(session.operationRoot, SETUP_STATE_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return null;
    }
    throw new Error('STRICT_SETUP_STATE_INVALID');
  }
  if (!isRecord(value)) {
    throw new Error('STRICT_SETUP_STATE_INVALID');
  }
  const { stateHash, ...semantic } = value;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'scenario',
      'setupAuthorityHash',
      'sourceTreeHash',
      'snapshotTreeHash',
      'restoreProbeTreeHash',
      'preResetProtectedHash',
      'resetReceipt',
      'targetInitialized',
      'stateHash',
    ]) ||
    value.schemaVersion !== 1 ||
    value.targetInitialized !== true ||
    value.scenario !== session.scenario ||
    value.setupAuthorityHash !== session.authority.authorityHash ||
    stateHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_SETUP_STATE_INVALID');
  }
  return Object.freeze(value as unknown as StrictExternalSetupStateV1);
}

async function verifySetupState(
  session: StrictExternalSetupSession,
  state: StrictExternalSetupStateV1,
  requireTarget = false
): Promise<void> {
  if (requireTarget) {
    await assertExistingDirectoryWithoutSymlink(session.dataRoot);
  }
  if (state.scenario === 'rebuild') {
    if (
      !session.snapshotRoot ||
      !state.sourceTreeHash ||
      !state.snapshotTreeHash ||
      !state.restoreProbeTreeHash ||
      !state.preResetProtectedHash
    ) {
      throw new Error('STRICT_SETUP_STATE_INVALID');
    }
    if (
      (await hashWholeRoot(path.join(session.snapshotRoot, 'whole-root'))) !==
      state.snapshotTreeHash
    ) {
      throw new Error('STRICT_SETUP_SNAPSHOT_HASH_MISMATCH');
    }
    if (
      (await hashWholeRoot(path.join(session.snapshotRoot, 'restore-probe'))) !==
      state.restoreProbeTreeHash
    ) {
      throw new Error('STRICT_SETUP_RESTORE_PROBE_DIVERGENCE');
    }
    if (requireTarget) {
      if ((await hashPreResetProtectedBindings(session.dataRoot)) !== state.preResetProtectedHash) {
        throw new Error('STRICT_SETUP_PRE_RESET_PROTECTED_DRIFT');
      }
      if (!state.resetReceipt && (await hashWholeRoot(session.dataRoot)) !== state.sourceTreeHash) {
        throw new Error('STRICT_SETUP_TARGET_PHASE_MISMATCH');
      }
    }
  }
}

async function readAuthority(authorityPath: string): Promise<StrictSetupAuthorityReceiptV1> {
  let value: unknown;
  try {
    value = JSON.parse(await fsp.readFile(authorityPath, 'utf8'));
  } catch {
    throw new Error('STRICT_SETUP_AUTHORITY_RECEIPT_INVALID');
  }
  if (!isRecord(value)) {
    throw new Error('STRICT_SETUP_AUTHORITY_RECEIPT_INVALID');
  }
  const { authorityHash, ...semantic } = value;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'runId',
      'scenario',
      'projectRootHash',
      'authorityRootHash',
      'roots',
      'pathPlanHash',
      'plannedAbsentPathReceiptHash',
      'preResetObservation',
      'restorePolicy',
      'authorization',
      'authorityHash',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== AUTHORITY_KIND ||
    !isIdentity(value.runId) ||
    (value.scenario !== 'pristine' && value.scenario !== 'rebuild') ||
    !isSha(value.projectRootHash) ||
    !isSha(value.authorityRootHash) ||
    !isSha(value.pathPlanHash) ||
    !isSha(value.plannedAbsentPathReceiptHash) ||
    !isRecord(value.roots) ||
    !isRecord(value.authorization) ||
    !isExternalAuthorization(value.authorization) ||
    !isRecord(value.restorePolicy) ||
    authorityHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_SETUP_AUTHORITY_RECEIPT_INVALID');
  }
  const roots = value.roots;
  if (
    !hasExactKeys(roots, ['dataRoot', 'operationLockRoot', 'evidenceRoot', 'snapshotRoot']) ||
    !isRootBinding(roots.dataRoot, false) ||
    !isRootBinding(roots.operationLockRoot, true) ||
    !isRootBinding(roots.evidenceRoot, true) ||
    (roots.snapshotRoot !== null && !isRootBinding(roots.snapshotRoot, true)) ||
    value.pathPlanHash !== hashCanonicalJson(roots)
  ) {
    throw new Error('STRICT_SETUP_PATH_PLAN_INVALID');
  }
  const restorePolicy = value.restorePolicy;
  const { restorePolicyHash, ...restoreSemantic } = restorePolicy;
  if (
    !hasExactKeys(restorePolicy, [
      'kind',
      'ref',
      'allowPreCasRestore',
      'allowPostCasRestore',
      'restorePolicyHash',
    ]) ||
    (restorePolicy.kind !== 'pristine-discard' && restorePolicy.kind !== 'rebuild-whole-root') ||
    !isSymbol(restorePolicy.ref) ||
    typeof restorePolicy.allowPreCasRestore !== 'boolean' ||
    typeof restorePolicy.allowPostCasRestore !== 'boolean' ||
    restorePolicyHash !== hashCanonicalJson(restoreSemantic)
  ) {
    throw new Error('STRICT_SETUP_RESTORE_POLICY_INVALID');
  }
  if (
    (value.scenario === 'pristine' &&
      (restorePolicy.kind !== 'pristine-discard' || roots.snapshotRoot !== null)) ||
    (value.scenario === 'rebuild' &&
      (restorePolicy.kind !== 'rebuild-whole-root' || roots.snapshotRoot === null))
  ) {
    throw new Error('STRICT_SETUP_SCENARIO_POLICY_MISMATCH');
  }
  if (value.scenario === 'pristine' && value.authorization.expectedPublicRouteHash !== null) {
    throw new Error('STRICT_SETUP_PRISTINE_PUBLIC_ROUTE_FORBIDDEN');
  }
  if (
    (value.scenario === 'pristine' && value.preResetObservation !== null) ||
    (value.scenario === 'rebuild' && !isStrictPreResetObservation(value.preResetObservation))
  ) {
    throw new Error('STRICT_SETUP_PRE_RESET_OBSERVATION_INVALID');
  }
  return Object.freeze(value as unknown as StrictSetupAuthorityReceiptV1);
}

async function readSetupActionReceipt(
  authorityRoot: string,
  authority: StrictSetupAuthorityReceiptV1
): Promise<StrictSetupActionReceiptV1> {
  const configured = process.env[ACTION_ENV]?.trim();
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error('STRICT_SETUP_ACTION_RECEIPT_REQUIRED');
  }
  const actionPath = path.resolve(configured);
  if (path.dirname(actionPath) !== authorityRoot) {
    throw new Error('STRICT_SETUP_ACTION_RECEIPT_INVALID');
  }
  await assertExistingRegularFileWithoutSymlink(actionPath);
  let value: unknown;
  try {
    value = JSON.parse(await fsp.readFile(actionPath, 'utf8'));
  } catch {
    throw new Error('STRICT_SETUP_ACTION_RECEIPT_INVALID');
  }
  if (!isRecord(value)) {
    throw new Error('STRICT_SETUP_ACTION_RECEIPT_INVALID');
  }
  const { actionHash, ...semantic } = value;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'runId',
      'setupAuthorityHash',
      'action',
      'actionHash',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'StrictSetupActionReceiptV1' ||
    value.runId !== authority.runId ||
    value.setupAuthorityHash !== authority.authorityHash ||
    (value.action !== 'execute' && value.action !== 'recover' && value.action !== 'complete') ||
    actionHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_SETUP_ACTION_RECEIPT_INVALID');
  }
  return Object.freeze(value as unknown as StrictSetupActionReceiptV1);
}

async function initializeExternalJournalHeader(input: {
  readonly authority: StrictSetupAuthorityReceiptV1;
  readonly operationRoot: string;
  readonly runtimeArtifactManifestPathHash: string;
}): Promise<string> {
  await fsp.mkdir(input.operationRoot, { recursive: true, mode: 0o700 });
  const journalPath = path.join(input.operationRoot, JOURNAL_FILE);
  const authorization = input.authority.authorization;
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'StrictRunJournalHeaderV1' as const,
    runId: input.authority.runId,
    scenario: input.authority.scenario,
    setupAuthorityHash: input.authority.authorityHash,
    pathPlanHash: input.authority.pathPlanHash,
    plannedAbsentPathReceiptHash: input.authority.plannedAbsentPathReceiptHash,
    preResetObservationHash:
      input.authority.preResetObservation === null
        ? null
        : hashCanonicalJson(input.authority.preResetObservation),
    restorePolicyHash: input.authority.restorePolicy.restorePolicyHash,
    runtimeArtifactManifestHash: authorization.runtimeArtifacts.manifestHash,
    runtimeArtifactManifestContentHash: authorization.runtimeArtifacts.manifestContentHash,
    runtimeArtifactManifestPathHash: input.runtimeArtifactManifestPathHash,
    runtimeConfigBindingHash: hashCanonicalJson(authorization.planning.strictConfig),
  };
  const header = { ...semantic, headerHash: hashCanonicalJson(semantic) };
  let existing: string | null = null;
  try {
    existing = await fsp.readFile(journalPath, 'utf8');
  } catch (error: unknown) {
    if (readCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  if (existing !== null) {
    const first = existing.split('\n').find(Boolean);
    if (!first || hashCanonicalJson(JSON.parse(first)) !== hashCanonicalJson(header)) {
      throw new Error('STRICT_SETUP_JOURNAL_HEADER_MISMATCH');
    }
    return header.headerHash;
  }
  const handle = await fsp.open(journalPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(header)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(input.operationRoot);
  return header.headerHash;
}

async function acquireOperationLock(
  lockPath: string,
  authority: StrictSetupAuthorityReceiptV1
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      const record = {
        schemaVersion: 1,
        kind: 'StrictExternalOperationLeaseV1',
        runId: authority.runId,
        setupAuthorityHash: authority.authorityHash,
        ownerPid: process.pid,
        nonce: randomUUID(),
        heartbeatAt: Date.now(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      return handle;
    } catch (error: unknown) {
      if (readCode(error) !== 'EEXIST') {
        throw error;
      }
      if (!(await reclaimDeadOperationLock(lockPath, authority))) {
        throw new Error('STRICT_SETUP_OPERATION_OWNER_ACTIVE');
      }
    }
  }
  throw new Error('STRICT_SETUP_OPERATION_OWNER_ACTIVE');
}

async function reclaimDeadOperationLock(
  lockPath: string,
  authority: StrictSetupAuthorityReceiptV1
): Promise<boolean> {
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
  let record: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) {
      return false;
    }
    record = value;
  } catch {
    return false;
  }
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'StrictExternalOperationLeaseV1' ||
    record.runId !== authority.runId ||
    record.setupAuthorityHash !== authority.authorityHash ||
    !Number.isSafeInteger(record.ownerPid) ||
    Number(record.ownerPid) <= 0 ||
    isProcessAlive(Number(record.ownerPid))
  ) {
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

function resolveExternalRoot(
  authorityRoot: string,
  binding: StrictExternalRootBindingV1 & { readonly relativePath: string }
): string {
  const relativePath = binding.relativePath;
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some((segment) => !segment || segment === '..')
  ) {
    throw new Error('STRICT_SETUP_EXTERNAL_ROOT_INVALID');
  }
  const resolved = path.resolve(authorityRoot, relativePath);
  if (
    !resolved.startsWith(`${authorityRoot}${path.sep}`) ||
    hashPath(resolved) !== binding.pathHash
  ) {
    throw new Error('STRICT_SETUP_ROOT_BINDING_MISMATCH');
  }
  return resolved;
}

async function verifyPlannedBinding(
  target: string,
  binding: StrictExternalRootBindingV1,
  mustBeAbsent: boolean,
  allowExisting = false,
  allowMissing = false
): Promise<void> {
  if (hashPath(target) !== binding.pathHash) {
    throw new Error('STRICT_SETUP_ROOT_BINDING_MISMATCH');
  }
  if (!mustBeAbsent) {
    if (allowMissing && !(await exists(target))) {
      return;
    }
    await assertExistingDirectoryWithoutSymlink(target);
    return;
  }
  if (!binding.plannedAbsentPathReceipt) {
    throw new Error('STRICT_SETUP_PLANNED_PATH_RECEIPT_REQUIRED');
  }
  if (await exists(target)) {
    if (!allowExisting) {
      throw new Error('STRICT_SETUP_PLANNED_PATH_ALREADY_EXISTS');
    }
    await assertExistingDirectoryWithoutSymlink(target);
    return;
  }
  const actual = await createStrictPlannedAbsentPathReceipt(target);
  if (hashCanonicalJson(actual) !== hashCanonicalJson(binding.plannedAbsentPathReceipt)) {
    throw new Error('STRICT_SETUP_PLANNED_PATH_RECEIPT_MISMATCH');
  }
}

async function hasMatchingExternalHeader(
  evidenceRoot: string,
  authority: StrictSetupAuthorityReceiptV1
): Promise<boolean> {
  const journalPath = path.join(evidenceRoot, 'strict-run-journal', authority.runId, JOURNAL_FILE);
  let firstRow: string;
  try {
    firstRow = (await fsp.readFile(journalPath, 'utf8')).split('\n').find(Boolean) ?? '';
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
  try {
    const value: unknown = JSON.parse(firstRow);
    if (!isRecord(value)) {
      return false;
    }
    const { headerHash, ...semantic } = value;
    return (
      value.schemaVersion === 1 &&
      value.kind === 'StrictRunJournalHeaderV1' &&
      value.runId === authority.runId &&
      value.scenario === authority.scenario &&
      value.setupAuthorityHash === authority.authorityHash &&
      headerHash === hashCanonicalJson(semantic)
    );
  } catch {
    return false;
  }
}

async function hasMatchingExternalLease(
  operationLockRoot: string,
  authority: StrictSetupAuthorityReceiptV1
): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(
      await fsp.readFile(path.join(operationLockRoot, OPERATION_LOCK_FILE), 'utf8')
    );
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return false;
    }
    return false;
  }
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.kind === 'StrictExternalOperationLeaseV1' &&
    value.runId === authority.runId &&
    value.setupAuthorityHash === authority.authorityHash &&
    Number.isSafeInteger(value.ownerPid) &&
    Number(value.ownerPid) > 0
  );
}

function assertTopology(input: {
  readonly authorityPath: string;
  readonly dataRoot: string;
  readonly evidenceRoot: string;
  readonly operationLockRoot: string;
  readonly projectRoot: string;
  readonly snapshotRoot: string | null;
}): void {
  const mutableRoots = [
    input.dataRoot,
    input.evidenceRoot,
    input.operationLockRoot,
    ...(input.snapshotRoot ? [input.snapshotRoot] : []),
  ];
  for (let index = 0; index < mutableRoots.length; index += 1) {
    const left = mutableRoots[index];
    if (!left) {
      continue;
    }
    if (pathsOverlap(left, input.projectRoot) || pathsOverlap(left, input.authorityPath)) {
      throw new Error('STRICT_SETUP_PROTECTED_ROOT_OVERLAP');
    }
    for (const right of mutableRoots.slice(index + 1)) {
      if (pathsOverlap(left, right)) {
        throw new Error('STRICT_SETUP_ROOT_OVERLAP');
      }
    }
  }
}

async function validateRuntimeArtifactManifestBoundary(input: {
  readonly authorityPath: string;
  readonly dataRoot: string;
  readonly evidenceRoot: string;
  readonly operationLockRoot: string;
  readonly projectRoot: string;
  readonly snapshotRoot: string | null;
}): Promise<string> {
  const configured = process.env[RUNTIME_ARTIFACT_MANIFEST_ENV]?.trim();
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error('STRICT_SETUP_RUNTIME_ARTIFACT_MANIFEST_REQUIRED');
  }
  const manifestPath = path.resolve(configured);
  await assertExistingRegularFileWithoutSymlink(manifestPath);
  for (const protectedTarget of [
    input.authorityPath,
    input.dataRoot,
    input.evidenceRoot,
    input.operationLockRoot,
    input.projectRoot,
    ...(input.snapshotRoot ? [input.snapshotRoot] : []),
  ]) {
    if (pathsOverlap(manifestPath, protectedTarget)) {
      throw new Error('STRICT_SETUP_RUNTIME_ARTIFACT_MANIFEST_OVERLAP');
    }
  }
  return hashPath(manifestPath);
}

async function findExistingParent(
  target: string
): Promise<{ existingParent: string; leafChain: string[] }> {
  let cursor = target;
  const leafChain: string[] = [];
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error('STRICT_SETUP_PLANNED_PARENT_MISSING');
    }
    leafChain.unshift(path.basename(cursor));
    cursor = parent;
  }
  return { existingParent: cursor, leafChain };
}

async function assertNoSymlinkSegments(existingParent: string, target: string): Promise<void> {
  let cursor = existingParent;
  const parentStat = await fsp.lstat(cursor);
  if (parentStat.isSymbolicLink()) {
    throw new Error('STRICT_SETUP_SYMLINK_FORBIDDEN');
  }
  for (const segment of path.relative(existingParent, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await fsp.lstat(cursor)).isSymbolicLink()) {
        throw new Error('STRICT_SETUP_SYMLINK_FORBIDDEN');
      }
    } catch (error: unknown) {
      if (readCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

async function assertExistingRegularFileWithoutSymlink(filePath: string): Promise<void> {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (await fsp.realpath(filePath)) !== filePath) {
    throw new Error('STRICT_SETUP_AUTHORITY_PATH_INVALID');
  }
}

async function assertExistingDirectoryWithoutSymlink(directory: string): Promise<void> {
  const stat = await fsp.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fsp.realpath(directory)) !== directory
  ) {
    throw new Error('STRICT_SETUP_TARGET_ROOT_INVALID');
  }
}

async function copyWholeRoot(source: string, destination: string): Promise<void> {
  if (await exists(destination)) {
    throw new Error('STRICT_SETUP_COPY_DESTINATION_EXISTS');
  }
  await fsp.cp(source, destination, {
    dereference: false,
    errorOnExist: true,
    preserveTimestamps: true,
    recursive: true,
    verbatimSymlinks: true,
  });
  await hashWholeRoot(destination);
}

async function hashWholeRoot(root: string): Promise<string> {
  await assertExistingDirectoryWithoutSymlink(root);
  const rows: Array<{
    readonly hash?: string;
    readonly mode: number;
    readonly relativePath: string;
    readonly size?: number;
    readonly type: 'directory' | 'file';
  }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolute);
      const stat = await fsp.lstat(absolute);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error('STRICT_SETUP_SYMLINK_FORBIDDEN');
      }
      if (entry.isDirectory()) {
        rows.push({ mode: stat.mode & 0o777, relativePath, type: 'directory' });
        await visit(absolute);
      } else if (entry.isFile()) {
        rows.push({
          hash: `sha256:${createHash('sha256')
            .update(await fsp.readFile(absolute))
            .digest('hex')}`,
          mode: stat.mode & 0o777,
          relativePath,
          size: stat.size,
          type: 'file',
        });
      } else {
        throw new Error('STRICT_SETUP_SPECIAL_FILE_FORBIDDEN');
      }
    }
  };
  await visit(root);
  return hashCanonicalJson(rows);
}

async function hashPreResetProtectedBindings(dataRoot: string): Promise<string> {
  const rows: Array<{
    readonly binding: string;
    readonly hash: string | null;
    readonly type: 'absent' | 'directory' | 'file';
  }> = [];
  for (const relativePath of ['.asd/config.json', '.asd/context/recipe-publications'] as const) {
    const target = path.join(dataRoot, relativePath);
    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(target);
    } catch (error: unknown) {
      if (readCode(error) === 'ENOENT') {
        rows.push({ binding: relativePath, hash: null, type: 'absent' });
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('STRICT_SETUP_SYMLINK_FORBIDDEN');
    }
    if (stat.isDirectory()) {
      rows.push({
        binding: relativePath,
        hash: await hashWholeRoot(target),
        type: 'directory',
      });
    } else if (stat.isFile()) {
      rows.push({
        binding: relativePath,
        hash: `sha256:${createHash('sha256')
          .update(await fsp.readFile(target))
          .digest('hex')}`,
        type: 'file',
      });
    } else {
      throw new Error('STRICT_SETUP_SPECIAL_FILE_FORBIDDEN');
    }
  }
  return hashCanonicalJson(rows);
}

async function hashOptionalFile(filePath: string): Promise<string> {
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('STRICT_SETUP_PRE_RESET_OBSERVATION_INVALID');
    }
    return `sha256:${createHash('sha256')
      .update(await fsp.readFile(filePath))
      .digest('hex')}`;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return hashCanonicalJson({ state: 'absent' });
    }
    throw error;
  }
}

async function hashOptionalTree(directory: string): Promise<string> {
  try {
    return await hashWholeRoot(directory);
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return hashCanonicalJson({ state: 'absent' });
    }
    throw error;
  }
}

async function hashOptionalJson(filePath: string): Promise<string> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    return hashCanonicalJson(value);
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return hashCanonicalJson({ state: 'absent' });
    }
    throw new Error('STRICT_SETUP_PRE_RESET_OBSERVATION_INVALID');
  }
}

async function syncTree(root: string): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('STRICT_SETUP_SYMLINK_FORBIDDEN');
    }
    if (entry.isDirectory()) {
      await syncTree(absolute);
    } else if (entry.isFile()) {
      const handle = await fsp.open(absolute, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new Error('STRICT_SETUP_SPECIAL_FILE_FORBIDDEN');
    }
  }
  await syncDirectory(root);
}

async function writeDurableJson(target: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return (
    leftResolved === rightResolved ||
    leftResolved.startsWith(`${rightResolved}${path.sep}`) ||
    rightResolved.startsWith(`${leftResolved}${path.sep}`)
  );
}

function hashPath(value: string): string {
  return `sha256:${createHash('sha256').update(path.resolve(value)).digest('hex')}`;
}

function isRootBinding(value: unknown, relativeRequired: boolean): boolean {
  if (!isRecord(value) || !isSymbol(value.ref) || !isSha(value.pathHash)) {
    return false;
  }
  if (!hasExactKeys(value, ['ref', 'relativePath', 'pathHash', 'plannedAbsentPathReceipt'])) {
    return false;
  }
  if (relativeRequired && !isSymbol(value.relativePath)) {
    return false;
  }
  return (
    value.plannedAbsentPathReceipt === undefined ||
    isPlannedAbsentReceipt(value.plannedAbsentPathReceipt)
  );
}

function isStrictPreResetObservation(value: unknown): value is StrictPreResetObservationV1 {
  if (!isRecord(value)) {
    return false;
  }
  const { observationHash, ...semantic } = value;
  return (
    hasExactKeys(value, [
      'schemaVersion',
      'ref',
      'rootTreeHash',
      'configHash',
      'readerStateHash',
      'markerHash',
      'baselineReadHash',
      'publicRouteHash',
      'observationHash',
    ]) &&
    value.schemaVersion === 1 &&
    isSymbol(value.ref) &&
    isSha(value.rootTreeHash) &&
    isSha(value.configHash) &&
    isSha(value.readerStateHash) &&
    isSha(value.markerHash) &&
    isSha(value.baselineReadHash) &&
    isSha(value.publicRouteHash) &&
    observationHash === hashCanonicalJson(semantic)
  );
}

function isPlannedAbsentReceipt(value: unknown): value is StrictPlannedAbsentPathReceiptV1 {
  if (!isRecord(value)) {
    return false;
  }
  const { receiptHash, ...semantic } = value;
  return (
    value.schemaVersion === 1 &&
    isSha(value.authorizedExistingParentRealpathHash) &&
    Array.isArray(value.normalizedLeafChain) &&
    value.normalizedLeafChain.length > 0 &&
    value.normalizedLeafChain.every((segment) =>
      typeof segment === 'string' ? /^[^/\\]+$/u.test(segment) && segment !== '..' : false
    ) &&
    isSha(value.parentIdentityHash) &&
    value.lstatNoSymlink === true &&
    value.leafAbsent === true &&
    receiptHash === hashCanonicalJson(semantic)
  );
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u.test(value);
}

function isSymbol(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,511}$/u.test(value);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function readRequiredSymbol(value: unknown): string {
  if (!isSymbol(value)) {
    throw new Error('STRICT_SETUP_AUTHORITY_RECEIPT_INVALID');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isExternalAuthorization(value: Record<string, unknown>): boolean {
  if (
    !hasExactKeys(value, [
      'expectedPublicRouteHash',
      'pcfBaselineReceiptHash',
      'runtimeArtifacts',
      'reset',
      'planning',
      'privateCorpus',
    ]) ||
    (value.expectedPublicRouteHash !== null && !isSha(value.expectedPublicRouteHash)) ||
    !isSha(value.pcfBaselineReceiptHash)
  ) {
    return false;
  }
  const runtimeArtifacts = isRecord(value.runtimeArtifacts) ? value.runtimeArtifacts : {};
  const reset = isRecord(value.reset) ? value.reset : {};
  const planning = isRecord(value.planning) ? value.planning : {};
  const reviewer = isRecord(planning.reviewer) ? planning.reviewer : {};
  const identity = isRecord(reviewer.identity) ? reviewer.identity : {};
  const privateCorpus = isRecord(value.privateCorpus) ? value.privateCorpus : {};
  const resetPaths = Array.isArray(reset.relativePaths) ? reset.relativePaths : [];
  return (
    isSha(runtimeArtifacts.manifestHash) &&
    isSha(runtimeArtifacts.manifestContentHash) &&
    runtimeArtifacts.manifestSymbol === 'controller:runtime-artifact-manifest' &&
    Array.isArray(reset.relativePaths) &&
    resetPaths.every(isSafeRelativePath) &&
    !resetPaths.some((value) => (typeof value === 'string' ? isProtectedResetPath(value) : true)) &&
    Array.isArray(reset.tables) &&
    reset.tables.every((table) => typeof table === 'string' && /^[a-z][a-z0-9_]*$/u.test(table)) &&
    Array.isArray(planning.factQueryFamilies) &&
    planning.factQueryFamilies.length > 0 &&
    isSha(planning.modelHash) &&
    isSha(planning.promptHash) &&
    isRecord(planning.strictConfig) &&
    isSha(reviewer.calibrationReceiptHash) &&
    isSymbol(identity.provider) &&
    isSymbol(identity.model) &&
    isSymbol(identity.method) &&
    isSha(privateCorpus.projectIdentityHash) &&
    isSha(privateCorpus.acceptedMigrationBundleSemanticHash) &&
    typeof privateCorpus.credentialLocationSymbol === 'string' &&
    /^(?:env|keychain|secret-store):[a-zA-Z0-9._-]+$/u.test(privateCorpus.credentialLocationSymbol)
  );
}

async function assertExpectedPublicRouteBinding(
  session: StrictExternalSetupSession
): Promise<void> {
  const activePath = path.join(
    session.dataRoot,
    '.asd',
    'context',
    'recipe-publications',
    'active.json'
  );
  let actualHash: string | null = null;
  try {
    const stat = await fsp.lstat(activePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('STRICT_SETUP_PUBLIC_ROUTE_INVALID');
    }
    const parsed: unknown = JSON.parse(await fsp.readFile(activePath, 'utf8'));
    if (!isRecord(parsed)) {
      throw new Error('STRICT_SETUP_PUBLIC_ROUTE_INVALID');
    }
    actualHash = hashCanonicalJson(parsed);
  } catch (error: unknown) {
    if (readCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  if (actualHash !== session.authority.authorization.expectedPublicRouteHash) {
    throw new Error('STRICT_SETUP_PUBLIC_ROUTE_BINDING_MISMATCH');
  }
}

function isProtectedResetPath(value: string): boolean {
  const normalized = value.split(/[\\/]/u).join('/');
  return (
    normalized === '.asd/config.json' ||
    normalized === '.asd/context/recipe-publications' ||
    normalized.startsWith('.asd/context/recipe-publications/')
  );
}

function isSafeRelativePath(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).some((segment) => !segment || segment === '..')
  );
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return readCode(error) === 'EPERM';
  }
}
