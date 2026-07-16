import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readAlembicMigrationBundleManifest } from '@alembic/core/database';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { createProjectDescriptor, createProjectScopeRegistryDocument } from '@alembic/core/shared';
import { getProjectRegistryDir } from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type AppRuntime from '../../lib/Bootstrap.js';
import { initializeServerRuntime } from '../../lib/daemon/runtime/ServerStartupBoundary.js';
import { loadStrictProductionAuthorization } from '../../lib/recipe-pipeline/generate/strict/StrictAuthorization.js';
import {
  createStrictPlannedAbsentPathReceipt,
  createStrictPreResetObservation,
  dispatchStrictExternalSetupStartup,
  executeStrictExternalSetupReset,
  initializeStrictExternalSetupTarget,
  prepareStrictExternalSetupFromEnvironment,
  readStrictExternalSetupState,
  recoverStrictExternalSetup,
  releaseStrictExternalSetupSession,
} from '../../lib/recipe-pipeline/generate/strict/StrictExternalSetupRecovery.js';
import {
  STRICT_PRODUCTION_STATES_V1,
  StrictProductionJournal,
} from '../../lib/recipe-pipeline/generate/strict/StrictProductionJournal.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_AUTHORITY_PATH = process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH;
const ORIGINAL_ACTION_PATH = process.env.ALEMBIC_STRICT_SETUP_ACTION_PATH;
const ORIGINAL_DAEMON_STATE_PATH = process.env.ALEMBIC_DAEMON_STATE_PATH;
const ORIGINAL_PROJECT_DIR = process.env.ALEMBIC_PROJECT_DIR;
const ORIGINAL_RUNTIME_MANIFEST_PATH = process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH;

afterEach(async () => {
  restoreEnvironment('ALEMBIC_HOME', ORIGINAL_ALEMBIC_HOME);
  if (ORIGINAL_AUTHORITY_PATH === undefined) {
    delete process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH;
  } else {
    process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH = ORIGINAL_AUTHORITY_PATH;
  }
  if (ORIGINAL_RUNTIME_MANIFEST_PATH === undefined) {
    delete process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH;
  } else {
    process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH = ORIGINAL_RUNTIME_MANIFEST_PATH;
  }
  if (ORIGINAL_ACTION_PATH === undefined) {
    delete process.env.ALEMBIC_STRICT_SETUP_ACTION_PATH;
  } else {
    process.env.ALEMBIC_STRICT_SETUP_ACTION_PATH = ORIGINAL_ACTION_PATH;
  }
  restoreEnvironment('ALEMBIC_DAEMON_STATE_PATH', ORIGINAL_DAEMON_STATE_PATH);
  restoreEnvironment('ALEMBIC_PROJECT_DIR', ORIGINAL_PROJECT_DIR);
  await releaseStrictExternalSetupSession();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true })));
});

describe('strict external setup and recovery authority', () => {
  it('server startup boundary passes only a fully initialized runtime', async () => {
    const ready = { startupDisposition: 'runtime-ready' } as AppRuntime['components'];

    await expect(initializeServerRuntime({ initialize: async () => ready })).resolves.toBe(ready);
    await expect(
      initializeServerRuntime({
        initialize: async () =>
          ({ startupDisposition: 'initializing' }) as AppRuntime['components'],
      })
    ).rejects.toThrow('SERVER_STARTUP_RUNTIME_NOT_READY:initializing');
  });

  it('durably opens the external lease and journal header while pristine target remains absent', async () => {
    const fixture = await pristineAuthorityFixture();

    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });

    expect(session).not.toBeNull();
    expect(session?.scenario).toBe('pristine');
    await expect(fsp.stat(fixture.dataRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fsp.stat(path.join(fixture.operationLockRoot, 'strict-production.operation.lock'))
    ).resolves.toBeDefined();
    const journalRows = (
      await fsp.readFile(
        path.join(
          fixture.evidenceRoot,
          'strict-run-journal',
          fixture.runId,
          'strict-production.journal.jsonl'
        ),
        'utf8'
      )
    )
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]).toMatchObject({
      kind: 'StrictRunJournalHeaderV1',
      runId: fixture.runId,
      scenario: 'pristine',
    });
    expect(journalRows[0]).not.toHaveProperty('planHash');
    expect(journalRows[0]).not.toHaveProperty('manifestHash');
  });

  it('loads only the hash-bound external authorization through the exact request contract', async () => {
    const fixture = await pristineAuthorityFixture();
    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    expect(session).not.toBeNull();
    if (!session) {
      throw new Error('fixture session missing');
    }

    const receipt = await loadStrictProductionAuthorization({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
      request: fixture.request,
    });

    expect(receipt.authorizationHash).toBe(fixture.request.authorizationReceiptHash);
    expect(receipt.operationRoot).toBe(session?.operationRoot);
    expect(JSON.stringify(receipt)).not.toContain(fixture.authorityPath);
    const persistedEvidence = await Promise.all(
      ['strict-setup-topology-receipt.json', 'strict-authorization-load-receipt.json'].map(
        async (file) => await fsp.readFile(path.join(session.operationRoot, file), 'utf8')
      )
    );
    expect(persistedEvidence.join('\n')).not.toContain(path.dirname(fixture.projectRoot));
    expect(persistedEvidence.join('\n')).not.toContain('FIXTURE_ONLY');
    await expect(
      loadStrictProductionAuthorization({
        dataRoot: fixture.dataRoot,
        projectRoot: fixture.projectRoot,
        request: {
          ...fixture.request,
          setupAuthority: {
            ...fixture.request.setupAuthority,
            evidenceRootRef: 'ENV.WRONG.evidenceRootRef',
          },
        },
      })
    ).rejects.toThrow('STRICT_SETUP_REQUEST_BINDING_MISMATCH');
  });

  it('resumes a pristine target only when the existing external header binds the same authority', async () => {
    const fixture = await pristineAuthorityFixture();
    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    const initial = await initializeStrictExternalSetupTarget(first);
    await releaseStrictExternalSetupSession();

    const resumed = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });

    expect(resumed?.resumedFromHeader).toBe(true);
    if (!resumed) {
      throw new Error('fixture resume session missing');
    }
    await expect(initializeStrictExternalSetupTarget(resumed)).resolves.toEqual(initial);
  });

  it('snapshots the complete rebuild root, verifies a disposable restore, and restores exact bytes', async () => {
    const fixture = await rebuildAuthorityFixture();
    const originalConfig = await fsp.readFile(path.join(fixture.dataRoot, '.asd/config.json'));
    const originalRoute = await fsp.readFile(
      path.join(fixture.dataRoot, '.asd/context/recipe-publications/active.json')
    );

    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    expect(session).not.toBeNull();
    if (!session) {
      throw new Error('fixture session missing');
    }
    const setup = await initializeStrictExternalSetupTarget(session);

    expect(setup.sourceTreeHash).toBe(setup.snapshotTreeHash);
    expect(setup.restoreProbeTreeHash).toBe(setup.sourceTreeHash);
    const database = new Database(':memory:');
    const resetState = await executeStrictExternalSetupReset({
      database,
      session,
    });
    database.close();
    expect(resetState.resetReceipt?.blank).toBe(true);
    await expect(fsp.stat(path.join(fixture.dataRoot, 'candidate-cache'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fsp.writeFile(path.join(fixture.dataRoot, '.asd/config.json'), '{"mutated":true}\n');
    await fsp.writeFile(
      path.join(fixture.dataRoot, '.asd/context/recipe-publications/active.json'),
      '{"snapshotId":"wrong"}\n'
    );
    await fsp.writeFile(path.join(fixture.dataRoot, 'post-reset-only.txt'), 'remove me');

    const recovery = await recoverStrictExternalSetup(session);

    expect(recovery.restoredTreeHash).toBe(setup.sourceTreeHash);
    expect(await fsp.readFile(path.join(fixture.dataRoot, '.asd/config.json'))).toEqual(
      originalConfig
    );
    expect(
      await fsp.readFile(
        path.join(fixture.dataRoot, '.asd/context/recipe-publications/active.json')
      )
    ).toEqual(originalRoute);
    await expect(
      fsp.readFile(path.join(fixture.dataRoot, 'candidate-cache/sentinel.json'), 'utf8')
    ).resolves.toBe('{"candidate":"old"}\n');
    await expect(
      fsp.stat(path.join(fixture.dataRoot, 'post-reset-only.txt'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readStrictExternalSetupState(session)).rejects.toThrow(
      'STRICT_SETUP_STATE_MISSING'
    );
  });

  it('fails before reset when frozen config or reader state drifts after the snapshot', async () => {
    const fixture = await rebuildAuthorityFixture();
    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!session) {
      throw new Error('fixture session missing');
    }
    await initializeStrictExternalSetupTarget(session);
    await fsp.writeFile(path.join(fixture.dataRoot, '.asd/config.json'), '{"reader":"drift"}\n');
    const database = new Database(':memory:');
    await expect(executeStrictExternalSetupReset({ database, session })).rejects.toThrow(
      'STRICT_SETUP_PRE_RESET_PROTECTED_DRIFT'
    );
    database.close();
  });

  it('rejects a target-local credential before copying the rebuild snapshot', async () => {
    const fixture = await rebuildAuthorityFixture();
    const sentinel = 'sk-fixture-must-never-be-copied';
    await fsp.writeFile(path.join(fixture.dataRoot, '.asd/secrets.json'), sentinel);

    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!session) {
      throw new Error('fixture session missing');
    }
    await expect(initializeStrictExternalSetupTarget(session)).rejects.toThrow(
      'STRICT_SETUP_CREDENTIAL_IN_TARGET'
    );
    await expect(fsp.stat(fixture.snapshotRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const evidence = await fsp.readFile(
      path.join(fixture.operationRoot, 'strict-setup-topology-receipt.json'),
      'utf8'
    );
    expect(evidence).not.toContain(sentinel);
  });

  it('fresh-process recovery resumes a crash after target quarantine without normal initialization', async () => {
    const fixture = await rebuildAuthorityFixture();
    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    const setup = await initializeStrictExternalSetupTarget(first);
    await fsp.writeFile(path.join(fixture.dataRoot, 'post-reset-only.txt'), 'discard');
    await releaseStrictExternalSetupSession();

    const token = fixture.authorityHash.slice('sha256:'.length, 'sha256:'.length + 16);
    const restoreLeaf = `${path.basename(fixture.dataRoot)}.strict-restore-${token}`;
    const quarantineLeaf = `${path.basename(fixture.dataRoot)}.strict-quarantine-${token}`;
    const restoreRoot = path.join(path.dirname(fixture.dataRoot), restoreLeaf);
    const quarantineRoot = path.join(path.dirname(fixture.dataRoot), quarantineLeaf);
    await fsp.cp(path.join(fixture.snapshotRoot, 'whole-root'), restoreRoot, {
      recursive: true,
      preserveTimestamps: true,
    });
    await fsp.rename(fixture.dataRoot, quarantineRoot);
    const transactionSemantic = {
      schemaVersion: 1 as const,
      setupAuthorityHash: fixture.authorityHash,
      expectedTreeHash: setup.sourceTreeHash,
      restoreLeaf,
      quarantineLeaf,
      phase: 'prepared' as const,
    };
    await fsp.writeFile(
      path.join(fixture.operationRoot, 'strict-external-recovery-transaction.json'),
      `${JSON.stringify({
        ...transactionSemantic,
        transactionHash: hashCanonicalJson(transactionSemantic),
      })}\n`
    );
    await configureActionReceipt(fixture.authorityRoot, {
      action: 'recover',
      authorityHash: fixture.authorityHash,
      runId: fixture.runId,
    });

    const daemonStatePath = path.join(fixture.authorityRoot, 'daemon-state.json');
    const child = await runBuiltServerEntrypoint({
      entry: 'daemon-server.js',
      fixture,
      extraEnvironment: {
        ALEMBIC_DAEMON_STATE_PATH: daemonStatePath,
      },
    });

    expect(child.stderr).not.toContain('Failed to start Alembic daemon');
    await expect(fsp.stat(daemonStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsp.readFile(path.join(fixture.dataRoot, '.asd/config.json'), 'utf8')).toBe(
      '{"reader":"legacy"}\n'
    );
    await expect(fsp.stat(quarantineRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fsp.stat(path.join(fixture.dataRoot, 'post-reset-only.txt'))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fresh-process completion terminates the server startup boundary successfully', async () => {
    const fixture = await pristineAuthorityFixture();
    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!session) {
      throw new Error('fixture session missing');
    }
    await initializeStrictExternalSetupTarget(session);
    const journal = await StrictProductionJournal.open({
      expectedHeaderHash: session.journalHeaderHash,
      operationRoot: session.operationRoot,
      ownerId: 'daemon:complete-launcher',
      runId: fixture.runId,
    });
    for (const state of STRICT_PRODUCTION_STATES_V1.filter(
      (candidate) => candidate !== 'SNAPSHOT_VERIFIED'
    )) {
      await journal.append(state, {});
    }
    await journal.close();
    await releaseStrictExternalSetupSession();
    await configureActionReceipt(path.dirname(fixture.authorityPath), {
      action: 'complete',
      authorityHash: fixture.authorityHash,
      runId: fixture.runId,
    });

    const child = await runBuiltServerEntrypoint({
      entry: 'api-server.js',
      fixture,
      extraEnvironment: { PORT: '0' },
    });

    expect(child.stderr).not.toContain('Failed to start HTTP API Server');
    await expect(
      fsp.stat(
        path.join(
          fixture.evidenceRoot,
          'strict-run-journal',
          fixture.runId,
          'strict-completion-receipt.json'
        )
      )
    ).resolves.toBeDefined();
  });

  it('rejects malformed controller observation and finalized recovery without post-CAS authority', async () => {
    const malformed = await rebuildAuthorityFixture();
    const authority = JSON.parse(await fsp.readFile(malformed.authorityPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const observation = {
      ...(authority.preResetObservation as Record<string, unknown>),
    };
    delete observation.configHash;
    const { authorityHash: _oldHash, ...oldSemantic } = authority;
    const changedSemantic = {
      ...oldSemantic,
      preResetObservation: observation,
    };
    const changedAuthorityHash = hashCanonicalJson(changedSemantic);
    await fsp.writeFile(
      malformed.authorityPath,
      `${JSON.stringify({ ...changedSemantic, authorityHash: changedAuthorityHash })}\n`
    );
    await configureActionReceipt(malformed.authorityRoot, {
      action: 'execute',
      authorityHash: changedAuthorityHash,
      runId: malformed.runId,
    });
    await expect(
      prepareStrictExternalSetupFromEnvironment({
        dataRoot: malformed.dataRoot,
        projectRoot: malformed.projectRoot,
      })
    ).rejects.toThrow('STRICT_SETUP_PRE_RESET_OBSERVATION_INVALID');

    const finalized = await pristineAuthorityFixture();
    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: finalized.dataRoot,
      projectRoot: finalized.projectRoot,
    });
    if (!session) {
      throw new Error('fixture session missing');
    }
    await initializeStrictExternalSetupTarget(session);
    const journal = await StrictProductionJournal.open({
      expectedHeaderHash: session.journalHeaderHash,
      operationRoot: session.operationRoot,
      ownerId: 'daemon:finalized',
      runId: finalized.runId,
    });
    for (const state of STRICT_PRODUCTION_STATES_V1.filter(
      (candidate) => candidate !== 'SNAPSHOT_VERIFIED'
    )) {
      await journal.append(state, {});
    }
    await journal.close();
    await releaseStrictExternalSetupSession();
    await configureActionReceipt(path.dirname(finalized.authorityPath), {
      action: 'recover',
      authorityHash: finalized.authorityHash,
      runId: finalized.runId,
    });
    const recoverSession = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: finalized.dataRoot,
      projectRoot: finalized.projectRoot,
    });
    if (!recoverSession) {
      throw new Error('fixture recovery session missing');
    }
    await expect(dispatchStrictExternalSetupStartup(recoverSession)).rejects.toThrow(
      'STRICT_SETUP_RECOVERY_PHASE_UNAUTHORIZED'
    );
    await expect(fsp.stat(finalized.dataRoot)).resolves.toBeDefined();
  });

  it('fails closed on overlapping external roots and a symlinked authority receipt', async () => {
    const overlap = await rebuildAuthorityFixture({
      snapshotRelativePath: 'target-data/snapshot',
    });
    await expect(
      prepareStrictExternalSetupFromEnvironment({
        dataRoot: overlap.dataRoot,
        projectRoot: overlap.projectRoot,
      })
    ).rejects.toThrow('STRICT_SETUP_ROOT_OVERLAP');

    const pristine = await pristineAuthorityFixture();
    const linkedAuthority = path.join(
      path.dirname(pristine.authorityPath),
      'linked-authority.json'
    );
    await fsp.symlink(pristine.authorityPath, linkedAuthority);
    process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH = linkedAuthority;
    await expect(
      prepareStrictExternalSetupFromEnvironment({
        dataRoot: pristine.dataRoot,
        projectRoot: pristine.projectRoot,
      })
    ).rejects.toThrow('STRICT_SETUP_AUTHORITY_PATH_INVALID');
  });

  it('rejects a live external owner and reclaims only a matching dead-process lease', async () => {
    const live = await pristineAuthorityFixture();
    await fsp.mkdir(live.operationLockRoot);
    await writeLease(live, process.pid);
    await expect(
      prepareStrictExternalSetupFromEnvironment({
        dataRoot: live.dataRoot,
        projectRoot: live.projectRoot,
      })
    ).rejects.toThrow('STRICT_SETUP_OPERATION_OWNER_ACTIVE');

    const dead = await pristineAuthorityFixture();
    await fsp.mkdir(dead.operationLockRoot);
    await writeLease(dead, 2_147_483_647);
    const resumed = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: dead.dataRoot,
      projectRoot: dead.projectRoot,
    });
    expect(resumed?.authority.authorityHash).toBe(dead.authorityHash);
  });
});

async function pristineAuthorityFixture() {
  const root = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-external-pristine-'))
  );
  roots.push(root);
  await configureRuntimeArtifactManifest(root);
  const authorityRoot = path.join(root, 'authority-root');
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(authorityRoot, 'target-data');
  const operationLockRoot = path.join(authorityRoot, 'operation-lock');
  const evidenceRoot = path.join(authorityRoot, 'evidence');
  await Promise.all([fsp.mkdir(authorityRoot), fsp.mkdir(projectRoot)]);
  const dataPlan = await createStrictPlannedAbsentPathReceipt(dataRoot);
  const lockPlan = await createStrictPlannedAbsentPathReceipt(operationLockRoot);
  const evidencePlan = await createStrictPlannedAbsentPathReceipt(evidenceRoot);
  const rootsReceipt = {
    dataRoot: {
      ref: 'ENV.TEST_MR_ALEMBIC_PRISTINE.dataRootRef',
      pathHash: hashPath(dataRoot),
      plannedAbsentPathReceipt: dataPlan,
    },
    operationLockRoot: {
      ref: 'ENV.TEST_MR_ALEMBIC_PRISTINE.operationLockRootRef',
      relativePath: 'operation-lock',
      pathHash: hashPath(operationLockRoot),
      plannedAbsentPathReceipt: lockPlan,
    },
    evidenceRoot: {
      ref: 'ENV.TEST_MR_ALEMBIC_PRISTINE.evidenceRootRef',
      relativePath: 'evidence',
      pathHash: hashPath(evidenceRoot),
      plannedAbsentPathReceipt: evidencePlan,
    },
    snapshotRoot: null,
  };
  const pathPlanHash = hashCanonicalJson(rootsReceipt);
  const restorePolicy = {
    kind: 'pristine-discard' as const,
    ref: 'AUTH_MR_PRISTINE_ALLOCATION',
    allowPreCasRestore: true,
    allowPostCasRestore: false,
  };
  const restorePolicyHash = hashCanonicalJson(restorePolicy);
  const runId = 'strict-pristine-run';
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'StrictSetupAuthorityReceiptV1' as const,
    runId,
    scenario: 'pristine' as const,
    projectRootHash: hashPath(projectRoot),
    authorityRootHash: hashPath(authorityRoot),
    roots: rootsReceipt,
    pathPlanHash,
    plannedAbsentPathReceiptHash: hashCanonicalJson([
      dataPlan.receiptHash,
      evidencePlan.receiptHash,
      lockPlan.receiptHash,
    ]),
    preResetObservation: null,
    restorePolicy: { ...restorePolicy, restorePolicyHash },
    authorization: authorization(),
  };
  const authorityHash = hashCanonicalJson(semantic);
  const authorityPath = path.join(authorityRoot, 'strict-setup-authority.json');
  await fsp.writeFile(authorityPath, `${JSON.stringify({ ...semantic, authorityHash })}\n`);
  await configureActionReceipt(authorityRoot, {
    action: 'execute',
    authorityHash,
    runId,
  });
  process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH = authorityPath;
  const request = {
    schemaVersion: 1 as const,
    authorizationReceiptHash: hashCanonicalJson(semantic.authorization),
    authorizationReceiptPath: 'EXTERNAL_SETUP_AUTHORITY',
    runId,
    ownerId: 'daemon:fixture',
    setupAuthority: {
      schemaVersion: 1 as const,
      action: 'execute' as const,
      scenario: 'pristine' as const,
      snapshotRootRef: 'NOT_APPLICABLE_PHYSICAL_ABSENCE',
      operationLockRootRef: rootsReceipt.operationLockRoot.ref,
      evidenceRootRef: rootsReceipt.evidenceRoot.ref,
      plannedAbsentPathReceiptHash: semantic.plannedAbsentPathReceiptHash,
      preResetObservationRef: 'NOT_APPLICABLE_PHYSICAL_ABSENCE',
      restorePolicyRef: restorePolicy.ref,
      pathPlanHash,
    },
  };
  return {
    authorityRoot,
    authorityHash,
    authorityPath,
    dataRoot,
    evidenceRoot,
    operationLockRoot,
    projectRoot,
    request,
    runId,
  };
}

function authorization(expectedPublicRouteHash: string | null = null) {
  return {
    expectedPublicRouteHash,
    pcfBaselineReceiptHash: sha('pcf'),
    runtimeArtifacts: {
      manifestHash: sha('runtime-manifest'),
      manifestContentHash: sha('runtime-content'),
      manifestSymbol: 'controller:runtime-artifact-manifest' as const,
    },
    reset: { relativePaths: ['candidate-cache'], tables: [] },
    planning: {
      factQueryFamilies: [{ id: 'syntax', capabilityId: 'query' }],
      modelHash: sha('model'),
      promptHash: sha('prompt'),
      strictConfig: {},
      reviewer: {
        calibrationReceiptHash: sha('reviewer'),
        identity: { provider: 'fixture', model: 'fixture', method: 'frozen' },
      },
    },
    privateCorpus: {
      projectIdentityHash: sha('project-identity'),
      acceptedMigrationBundleSemanticHash: hashCanonicalJson(readAlembicMigrationBundleManifest()),
      credentialLocationSymbol: 'env:FIXTURE_ONLY',
    },
  };
}

async function rebuildAuthorityFixture(options: { snapshotRelativePath?: string } = {}) {
  const root = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-external-rebuild-'))
  );
  roots.push(root);
  await configureRuntimeArtifactManifest(root);
  const authorityRoot = path.join(root, 'authority-root');
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(authorityRoot, 'target-data');
  const operationLockRoot = path.join(authorityRoot, 'operation-lock');
  const evidenceRoot = path.join(authorityRoot, 'evidence');
  const snapshotRelativePath = options.snapshotRelativePath ?? 'snapshot';
  const snapshotRoot = path.join(authorityRoot, snapshotRelativePath);
  await Promise.all([fsp.mkdir(authorityRoot), fsp.mkdir(projectRoot)]);
  await Promise.all([
    fsp.mkdir(path.join(dataRoot, '.asd'), { recursive: true }),
    fsp.mkdir(path.join(dataRoot, 'empty-dir'), { recursive: true }),
    fsp.mkdir(path.join(dataRoot, 'candidate-cache'), { recursive: true }),
    fsp.mkdir(path.join(dataRoot, '.asd/context/recipe-publications'), {
      recursive: true,
    }),
  ]);
  const publicRoute = {
    schemaVersion: 1,
    kind: 'StrictPublicKnowledgeRouteV1',
    snapshotId: 'pre-reset-reader',
  };
  await Promise.all([
    fsp.writeFile(path.join(dataRoot, '.asd/config.json'), '{"reader":"legacy"}\n'),
    fsp.writeFile(path.join(dataRoot, 'main.sqlite'), Buffer.from([0, 1, 2, 3, 255])),
    fsp.writeFile(
      path.join(dataRoot, '.asd/context/recipe-publications/active.json'),
      `${JSON.stringify(publicRoute)}\n`
    ),
    fsp.writeFile(path.join(dataRoot, 'candidate-cache/sentinel.json'), '{"candidate":"old"}\n'),
  ]);
  const lockPlan = await createStrictPlannedAbsentPathReceipt(operationLockRoot);
  const evidencePlan = await createStrictPlannedAbsentPathReceipt(evidenceRoot);
  const snapshotPlan = await createStrictPlannedAbsentPathReceipt(snapshotRoot);
  const rootsReceipt = {
    dataRoot: {
      ref: 'ENV.TEST_MR_ALEMBIC_REBUILD.dataRootRef',
      pathHash: hashPath(dataRoot),
    },
    operationLockRoot: {
      ref: 'ENV.TEST_MR_ALEMBIC_REBUILD.operationLockRootRef',
      relativePath: 'operation-lock',
      pathHash: hashPath(operationLockRoot),
      plannedAbsentPathReceipt: lockPlan,
    },
    evidenceRoot: {
      ref: 'ENV.TEST_MR_ALEMBIC_REBUILD.evidenceRootRef',
      relativePath: 'evidence',
      pathHash: hashPath(evidenceRoot),
      plannedAbsentPathReceipt: evidencePlan,
    },
    snapshotRoot: {
      ref: 'ENV.TEST_MR_ALEMBIC_REBUILD.snapshotRootRef',
      relativePath: snapshotRelativePath,
      pathHash: hashPath(snapshotRoot),
      plannedAbsentPathReceipt: snapshotPlan,
    },
  };
  const restorePolicy = {
    kind: 'rebuild-whole-root' as const,
    ref: 'AUTH_MR_REBUILD_ALLOCATION',
    allowPreCasRestore: true,
    allowPostCasRestore: true,
  };
  const preResetObservation = await createStrictPreResetObservation({
    dataRoot,
    ref: 'OBS.TEST_MR_ALEMBIC_REBUILD.preResetObservation',
  });
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'StrictSetupAuthorityReceiptV1' as const,
    runId: 'strict-rebuild-run',
    scenario: 'rebuild' as const,
    projectRootHash: hashPath(projectRoot),
    authorityRootHash: hashPath(authorityRoot),
    roots: rootsReceipt,
    pathPlanHash: hashCanonicalJson(rootsReceipt),
    plannedAbsentPathReceiptHash: hashCanonicalJson([
      evidencePlan.receiptHash,
      lockPlan.receiptHash,
      snapshotPlan.receiptHash,
    ]),
    preResetObservation,
    restorePolicy: {
      ...restorePolicy,
      restorePolicyHash: hashCanonicalJson(restorePolicy),
    },
    authorization: authorization(hashCanonicalJson(publicRoute)),
  };
  const authorityPath = path.join(authorityRoot, 'strict-setup-authority.json');
  await fsp.writeFile(
    authorityPath,
    `${JSON.stringify({ ...semantic, authorityHash: hashCanonicalJson(semantic) })}\n`
  );
  await configureActionReceipt(authorityRoot, {
    action: 'execute',
    authorityHash: hashCanonicalJson(semantic),
    runId: semantic.runId,
  });
  process.env.ALEMBIC_STRICT_SETUP_AUTHORITY_PATH = authorityPath;
  return {
    authorityHash: hashCanonicalJson(semantic),
    authorityRoot,
    authorityPath,
    dataRoot,
    evidenceRoot,
    operationRoot: path.join(evidenceRoot, 'strict-run-journal', semantic.runId),
    projectRoot,
    runId: semantic.runId,
    snapshotRoot,
  };
}

async function runBuiltServerEntrypoint(input: {
  entry: 'api-server.js' | 'daemon-server.js';
  extraEnvironment?: NodeJS.ProcessEnv;
  fixture: {
    authorityRoot: string;
    dataRoot: string;
    projectRoot: string;
  };
}): Promise<{ stderr: string; stdout: string }> {
  const alembicHome = path.join(input.fixture.authorityRoot, 'fresh-process-home');
  await fsp.mkdir(alembicHome, { recursive: true });
  process.env.ALEMBIC_HOME = alembicHome;
  const projectScope = createProjectDescriptor({
    controlRoot: path.dirname(input.fixture.projectRoot),
    dataRoot: input.fixture.dataRoot,
    displayName: 'strict server entry fixture',
    folders: [{ path: input.fixture.projectRoot, role: 'primary-source' }],
    projectId: 'strict-server-entry-fixture',
    projectScopeId: 'strict-server-entry-fixture-scope',
  });
  const registryPath = path.join(getProjectRegistryDir(), 'project-scopes.json');
  await fsp.mkdir(path.dirname(registryPath), { recursive: true });
  await fsp.writeFile(
    registryPath,
    `${JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)}\n`
  );

  const result = await execFileAsync(
    process.execPath,
    [path.join(process.cwd(), 'dist', 'bin', input.entry)],
    {
      env: {
        ...process.env,
        ALEMBIC_DAEMON_FILE_CHANGES: '0',
        ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP: '0',
        ALEMBIC_HOME: alembicHome,
        ALEMBIC_PROJECT_DIR: input.fixture.projectRoot,
        ALEMBIC_QUIET: '1',
        NODE_ENV: 'test',
        ...input.extraEnvironment,
      },
      timeout: 10_000,
    }
  );
  return { stderr: result.stderr, stdout: result.stdout };
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function writeLease(
  fixture: { authorityHash: string; operationLockRoot: string; runId: string },
  ownerPid: number
): Promise<void> {
  await fsp.writeFile(
    path.join(fixture.operationLockRoot, 'strict-production.operation.lock'),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'StrictExternalOperationLeaseV1',
      runId: fixture.runId,
      setupAuthorityHash: fixture.authorityHash,
      ownerPid,
      nonce: 'fixture-owner',
      heartbeatAt: 1,
    })}\n`
  );
}

function hashPath(value: string): string {
  return `sha256:${createHash('sha256').update(path.resolve(value)).digest('hex')}`;
}

async function configureRuntimeArtifactManifest(root: string): Promise<void> {
  const manifestPath = path.join(root, 'runtime-artifact-manifest.json');
  await fsp.writeFile(manifestPath, '{}\n');
  process.env.ALEMBIC_RUNTIME_ARTIFACT_MANIFEST_PATH = manifestPath;
}

async function configureActionReceipt(
  authorityRoot: string,
  input: {
    readonly action: 'execute' | 'recover' | 'complete';
    readonly authorityHash: string;
    readonly runId: string;
  }
): Promise<void> {
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'StrictSetupActionReceiptV1' as const,
    runId: input.runId,
    setupAuthorityHash: input.authorityHash,
    action: input.action,
  };
  const actionPath = path.join(authorityRoot, 'strict-setup-action.json');
  await fsp.writeFile(
    actionPath,
    `${JSON.stringify({ ...semantic, actionHash: hashCanonicalJson(semantic) })}\n`
  );
  process.env.ALEMBIC_STRICT_SETUP_ACTION_PATH = actionPath;
}

function sha(value: string): string {
  return `sha256:${value.length.toString(16).padStart(64, 'a').slice(-64)}`;
}
