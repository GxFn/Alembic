import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readAlembicMigrationBundleManifest } from '@alembic/core/database';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { createProjectDescriptor, createProjectScopeRegistryDocument } from '@alembic/core/shared';
import { getProjectRegistryDir } from '@alembic/core/workspace';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type AppRuntime from '../../lib/Bootstrap.js';
import { DaemonSupervisor } from '../../lib/daemon/runtime/DaemonSupervisor.js';
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
  appendStrictSetupJournalEvent,
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
const BUILT_STRICT_STAGE_SCRIPT = `
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
const runtime = await import(process.env.ALEMBIC_TEST_STRICT_MODULE_URL);
const input = JSON.parse(process.env.ALEMBIC_TEST_STRICT_STAGE_INPUT);
const originalFetch = globalThis.fetch;
if (input.fetchGate === 'before-request') {
  globalThis.fetch = async () => {
    await fsp.writeFile(input.gatePath, 'before-request');
    await new Promise(() => {});
  };
} else if (input.fetchGate === 'after-response') {
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    process.kill(input.pausePid, 'SIGSTOP');
    await fsp.writeFile(input.gatePath, 'after-response');
    while (true) {
      try {
        await fsp.stat(input.releasePath);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return response;
  };
}
const session = await runtime.prepareStrictExternalSetupFromEnvironment({
  dataRoot: input.dataRoot,
  projectRoot: input.projectRoot,
});
if (!session) throw new Error('STRICT_STAGE_SESSION_MISSING');
try {
  let result;
  if (input.operation === 'reset') {
    const initialized = await runtime.initializeStrictExternalSetupTarget(session);
    const database = new Database(':memory:');
    try {
      result = await runtime.executeStrictExternalSetupReset({ database, session });
    } finally {
      database.close();
    }
    result = { initialized, result };
  } else if (input.operation === 'recover') {
    result = await runtime.recoverStrictExternalSetup(session);
  } else {
    result = await runtime.initializeStrictExternalSetupTarget(session);
  }
  process.stdout.write(JSON.stringify(result));
} finally {
  await runtime.releaseStrictExternalSetupSession();
}
`;

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
      kind: 'StrictRunJournalHeaderV2',
      runId: fixture.runId,
      scenario: 'pristine',
    });
    expect(journalRows[0]).not.toHaveProperty('planHash');
    expect(journalRows[0]).not.toHaveProperty('manifestHash');
  });

  it('fresh-process stage matrix reclaims a dead pre-header lease before target mutation', async () => {
    const fixture = await rebuildAuthorityFixture();
    await fsp.mkdir(fixture.operationLockRoot, { recursive: true });
    await writeLease(fixture, 2_147_483_647);
    await expect(
      fsp.stat(path.join(fixture.operationRoot, 'strict-production.journal.jsonl'))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await runBuiltStrictStage({ fixture });
    const journalRows = (
      await fsp.readFile(
        path.join(fixture.operationRoot, 'strict-production.journal.jsonl'),
        'utf8'
      )
    )
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as Record<string, unknown>);

    expect(journalRows.filter((row) => row.kind === 'StrictRunJournalHeaderV2')).toHaveLength(1);
    expect(journalRows[0]).toMatchObject({
      kind: 'StrictRunJournalHeaderV2',
      runId: fixture.runId,
      setupAuthorityHash: fixture.authorityHash,
    });
    expect(result.sourceTreeHash).toBe(result.snapshotTreeHash);
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

  it('seals post-quiesce state and snapshots it even when stale control removal changes the V1 root', async () => {
    const fixture = await rebuildAuthorityFixture();
    await Promise.all([
      fsp.writeFile(
        path.join(fixture.dataRoot, '.asd/daemon.json'),
        '{"token":"must-not-enter-snapshot"}\n'
      ),
      fsp.writeFile(path.join(fixture.dataRoot, '.asd/daemon.pid'), '2147483647\n'),
    ]);
    const authority = JSON.parse(await fsp.readFile(fixture.authorityPath, 'utf8')) as {
      preResetObservation: { rootTreeHash: string };
    };
    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!session) {
      throw new Error('fixture session missing');
    }

    const setup = await initializeStrictExternalSetupTarget(session);
    const receipt = JSON.parse(
      await fsp.readFile(
        path.join(fixture.operationRoot, 'quiesced-pre-reset-observation-receipt.json'),
        'utf8'
      )
    ) as Record<string, unknown>;

    expect(receipt).toMatchObject({
      kind: 'QuiescedPreResetObservationReceiptV1',
      disposition: 'not-running',
      rootTreeHash: setup.sourceTreeHash,
      quiesceRequestHash: null,
      quiesceAcceptedAckHash: null,
    });
    expect(receipt.preQuiesceInventoryHash).not.toBe(authority.preResetObservation.rootTreeHash);
    expect(receipt.rootTreeHash).toBe(authority.preResetObservation.rootTreeHash);
    await expect(
      fsp.stat(path.join(fixture.snapshotRoot, 'whole-root/.asd/daemon.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsp.stat(path.join(fixture.snapshotRoot, 'whole-root/.asd/daemon.pid'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fresh-process resume backfills QUIESCED_OBSERVED from the durable receipt before snapshot', async () => {
    const fixture = await rebuildAuthorityFixture();
    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    await initializeStrictExternalSetupTarget(first);
    await releaseStrictExternalSetupSession();

    await truncateStrictSetupJournalBeforeState(fixture.operationRoot, 'QUIESCED_OBSERVED');
    await Promise.all([
      fsp.rm(path.join(fixture.operationRoot, 'strict-external-setup-state.json'), {
        force: true,
      }),
      fsp.rm(fixture.snapshotRoot, { force: true, recursive: true }),
    ]);

    const setup = await runBuiltStrictStage({ fixture });
    const states = await readStrictSetupJournalStates(fixture.operationRoot);

    expect(states).toEqual([
      'PRE_QUIESCE_INVENTORY_VERIFIED',
      'QUIESCE_NOT_RUNNING',
      'QUIESCED_OBSERVED',
      'SNAPSHOT_COPY_STARTED',
      'SNAPSHOT_VERIFIED',
    ]);
    expect(setup.sourceTreeHash).toBe(setup.snapshotTreeHash);
  });

  it('fresh-process resume completes exact stale control removal persisted after not-running progress', async () => {
    const fixture = await rebuildAuthorityFixture();
    const statePath = path.join(fixture.dataRoot, '.asd/daemon.json');
    const pidPath = path.join(fixture.dataRoot, '.asd/daemon.pid');
    const staleState = '{"token":"stale-control-must-not-enter-snapshot"}\n';
    const stalePid = '2147483647\n';
    await Promise.all([fsp.writeFile(statePath, staleState), fsp.writeFile(pidPath, stalePid)]);

    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    await initializeStrictExternalSetupTarget(first);
    await releaseStrictExternalSetupSession();

    await truncateStrictSetupJournalBeforeState(
      fixture.operationRoot,
      'PRE_QUIESCE_INVENTORY_VERIFIED'
    );
    await Promise.all([
      fsp.rm(path.join(fixture.operationRoot, 'quiesced-pre-reset-observation-receipt.json'), {
        force: true,
      }),
      fsp.rm(path.join(fixture.operationRoot, 'strict-external-setup-state.json'), {
        force: true,
      }),
      fsp.rm(fixture.snapshotRoot, { force: true, recursive: true }),
    ]);
    await Promise.all([fsp.writeFile(statePath, staleState), fsp.writeFile(pidPath, stalePid)]);

    await runBuiltStrictStage({ fixture });

    await expect(fsp.stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(pidPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsp.stat(path.join(fixture.snapshotRoot, 'whole-root/.asd/daemon.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsp.stat(path.join(fixture.snapshotRoot, 'whole-root/.asd/daemon.pid'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fresh-process resume still fails closed on an unknown post-progress root delta', async () => {
    const fixture = await rebuildAuthorityFixture();
    const statePath = path.join(fixture.dataRoot, '.asd/daemon.json');
    const pidPath = path.join(fixture.dataRoot, '.asd/daemon.pid');
    const staleState = '{"token":"stale-control"}\n';
    const stalePid = '2147483647\n';
    await Promise.all([fsp.writeFile(statePath, staleState), fsp.writeFile(pidPath, stalePid)]);
    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    await initializeStrictExternalSetupTarget(first);
    await releaseStrictExternalSetupSession();

    await truncateStrictSetupJournalBeforeState(
      fixture.operationRoot,
      'PRE_QUIESCE_INVENTORY_VERIFIED'
    );
    await Promise.all([
      fsp.rm(path.join(fixture.operationRoot, 'quiesced-pre-reset-observation-receipt.json'), {
        force: true,
      }),
      fsp.rm(path.join(fixture.operationRoot, 'strict-external-setup-state.json'), {
        force: true,
      }),
      fsp.rm(fixture.snapshotRoot, { force: true, recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(statePath, staleState),
      fsp.writeFile(pidPath, stalePid),
      fsp.writeFile(path.join(fixture.dataRoot, 'unknown-after-progress.txt'), 'unauthorized'),
    ]);

    await expect(runBuiltStrictStage({ fixture })).rejects.toThrow(
      'STRICT_QUIESCE_UNKNOWN_ROOT_DELTA:unknown-after-progress.txt'
    );
    await expect(
      fsp.stat(path.join(fixture.operationRoot, 'quiesced-pre-reset-observation-receipt.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(fixture.snapshotRoot, 'whole-root'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    'observed-before-copy',
    'snapshot-before-probe',
    'probe-before-verified-event',
    'verified-event-before-state',
  ] as const)('fresh-process stage matrix resumes snapshot/probe prefix: %s', async (stage) => {
    const fixture = await rebuildAuthorityFixture();
    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    const expected = await initializeStrictExternalSetupTarget(first);
    await releaseStrictExternalSetupSession();
    await fsp.rm(path.join(fixture.operationRoot, 'strict-external-setup-state.json'), {
      force: true,
    });

    if (stage === 'observed-before-copy') {
      await truncateStrictSetupJournalBeforeState(fixture.operationRoot, 'SNAPSHOT_COPY_STARTED');
      await fsp.rm(fixture.snapshotRoot, { force: true, recursive: true });
    } else if (stage === 'snapshot-before-probe') {
      await truncateStrictSetupJournalBeforeState(fixture.operationRoot, 'SNAPSHOT_VERIFIED');
      await fsp.rm(path.join(fixture.snapshotRoot, 'restore-probe'), {
        force: true,
        recursive: true,
      });
    } else if (stage === 'probe-before-verified-event') {
      await truncateStrictSetupJournalBeforeState(fixture.operationRoot, 'SNAPSHOT_VERIFIED');
    }

    const resumed = await runBuiltStrictStage({ fixture });
    const states = await readStrictSetupJournalStates(fixture.operationRoot);
    expect(resumed).toMatchObject({
      sourceTreeHash: expected.sourceTreeHash,
      snapshotTreeHash: expected.snapshotTreeHash,
      restoreProbeTreeHash: expected.restoreProbeTreeHash,
    });
    for (const state of ['QUIESCED_OBSERVED', 'SNAPSHOT_COPY_STARTED', 'SNAPSHOT_VERIFIED']) {
      expect(states.filter((candidate) => candidate === state)).toHaveLength(1);
    }
  });

  it.each([
    'initialized-before-reset',
    'reset-started-before-mutation',
    'reset-mutation-before-receipt',
    'reset-receipt-before-blank-event',
  ] as const)('fresh-process stage matrix resumes reset prefix: %s', async (stage) => {
    const fixture = await rebuildAuthorityFixture();
    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    const initialized = await initializeStrictExternalSetupTarget(first);
    const statePath = path.join(fixture.operationRoot, 'strict-external-setup-state.json');
    const initializedState = await fsp.readFile(statePath);

    if (stage === 'reset-started-before-mutation') {
      await appendStrictSetupJournalEvent({
        expectedHeaderHash: first.journalHeaderHash,
        operationRoot: first.operationRoot,
        payload: { preResetProtectedHash: initialized.preResetProtectedHash },
        runId: fixture.runId,
        state: 'RESET_STARTED',
      });
    } else if (
      stage === 'reset-mutation-before-receipt' ||
      stage === 'reset-receipt-before-blank-event'
    ) {
      const database = new Database(':memory:');
      try {
        await executeStrictExternalSetupReset({ database, session: first });
      } finally {
        database.close();
      }
      await truncateStrictSetupJournalBeforeState(fixture.operationRoot, 'BLANK');
      if (stage === 'reset-mutation-before-receipt') {
        await fsp.writeFile(statePath, initializedState);
      }
    }
    await releaseStrictExternalSetupSession();

    const childResult = await runBuiltStrictStage({ fixture, operation: 'reset' });
    const resetResult = childResult.result as Record<string, unknown>;
    const resetReceipt = resetResult.resetReceipt as Record<string, unknown>;
    const states = await readStrictSetupJournalStates(fixture.operationRoot);
    expect(resetReceipt).toMatchObject({ blank: true, clearedPaths: ['candidate-cache'] });
    expect(states.filter((candidate) => candidate === 'RESET_STARTED')).toHaveLength(1);
    expect(states.filter((candidate) => candidate === 'BLANK')).toHaveLength(1);
    await expect(fsp.stat(path.join(fixture.dataRoot, 'candidate-cache'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fresh-process reset resume rejects a non-authorized phase delta', async () => {
    const fixture = await rebuildAuthorityFixture();
    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    const initialized = await initializeStrictExternalSetupTarget(first);
    await appendStrictSetupJournalEvent({
      expectedHeaderHash: first.journalHeaderHash,
      operationRoot: first.operationRoot,
      payload: { preResetProtectedHash: initialized.preResetProtectedHash },
      runId: fixture.runId,
      state: 'RESET_STARTED',
    });
    await fsp.writeFile(path.join(fixture.dataRoot, 'unknown-reset-delta.txt'), 'unauthorized');
    await releaseStrictExternalSetupSession();

    await expect(runBuiltStrictStage({ fixture, operation: 'reset' })).rejects.toThrow(
      'STRICT_SETUP_TARGET_PHASE_MISMATCH:unknown-reset-delta.txt'
    );
    const states = await readStrictSetupJournalStates(fixture.operationRoot);
    expect(states).not.toContain('BLANK');
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

  it('fresh-process stage matrix completes setup-state cleanup after a durable recovery receipt', async () => {
    const fixture = await rebuildAuthorityFixture();
    const first = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
    });
    if (!first) {
      throw new Error('fixture session missing');
    }
    await initializeStrictExternalSetupTarget(first);
    const statePath = path.join(fixture.operationRoot, 'strict-external-setup-state.json');
    const stateBytes = await fsp.readFile(statePath);
    const originalReceipt = await recoverStrictExternalSetup(first);
    await fsp.writeFile(statePath, stateBytes);
    await releaseStrictExternalSetupSession();
    await configureActionReceipt(fixture.authorityRoot, {
      action: 'recover',
      authorityHash: fixture.authorityHash,
      runId: fixture.runId,
    });

    const resumedReceipt = await runBuiltStrictStage({ fixture, operation: 'recover' });

    expect(resumedReceipt.receiptHash).toBe(originalReceipt.receiptHash);
    await expect(fsp.stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsp.stat(path.join(fixture.operationRoot, 'strict-external-recovery-transaction.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('fresh-process stage matrix replays the same request-unaccepted hash to the live daemon', async () => {
    const fixture = await rebuildAuthorityFixture();
    const oldDaemon = await startBuiltOldDaemon(fixture, 'request-unaccepted');
    const gatePath = path.join(fixture.authorityRoot, 'request-unaccepted.gate');
    const progressPath = path.join(fixture.operationRoot, 'strict-quiesce-progress.json');
    const interrupted = spawnBuiltStrictStage({
      fixture,
      fetchGate: 'before-request',
      gatePath,
      extraEnvironment: {
        ALEMBIC_STRICT_QUIESCE_STDIO_EVIDENCE: oldDaemon.stdioEvidence,
      },
    });
    try {
      await waitForPath(gatePath);
      const before = await waitForJsonStage(progressPath, 'request-unaccepted');
      const requestHash = (before.request as Record<string, unknown>).requestHash;
      interrupted.kill('SIGKILL');
      await waitForChildExit(interrupted);
      expect(isPidAlive(oldDaemon.state.pid)).toBe(true);

      await runBuiltStrictStage({ fixture });
      await waitForProcessExit(oldDaemon.state.pid, 10_000);
      const after = JSON.parse(await fsp.readFile(progressPath, 'utf8')) as Record<string, unknown>;
      const receipt = JSON.parse(
        await fsp.readFile(
          path.join(fixture.operationRoot, 'quiesced-pre-reset-observation-receipt.json'),
          'utf8'
        )
      ) as Record<string, unknown>;
      expect((after.request as Record<string, unknown>).requestHash).toBe(requestHash);
      expect(receipt.quiesceRequestHash).toBe(requestHash);
      expect(after.stage).toBe('old-pid-exited-checkpoint-complete');
    } finally {
      interrupted.kill('SIGKILL');
      await stopBuiltOldDaemon(oldDaemon.child);
    }
  }, 30_000);

  it('fresh-process stage matrix resumes accepted-draining after the old daemon exits', async () => {
    const fixture = await rebuildAuthorityFixture();
    const oldDaemon = await startBuiltOldDaemon(fixture, 'accepted-draining');
    const gatePath = path.join(fixture.authorityRoot, 'accepted-draining.gate');
    const releasePath = path.join(fixture.authorityRoot, 'accepted-draining.release');
    const progressPath = path.join(fixture.operationRoot, 'strict-quiesce-progress.json');
    const interrupted = spawnBuiltStrictStage({
      fixture,
      fetchGate: 'after-response',
      gatePath,
      pausePid: oldDaemon.state.pid,
      releasePath,
      extraEnvironment: {
        ALEMBIC_STRICT_QUIESCE_STDIO_EVIDENCE: oldDaemon.stdioEvidence,
      },
    });
    let oldDaemonStopped = false;
    try {
      await waitForPath(gatePath);
      oldDaemonStopped = true;
      await fsp.writeFile(releasePath, 'continue');
      const before = await waitForJsonStage(progressPath, 'accepted-draining');
      const ackHash = (before.ack as Record<string, unknown>).ackHash;
      interrupted.kill('SIGKILL');
      await waitForChildExit(interrupted);
      process.kill(oldDaemon.state.pid, 'SIGCONT');
      oldDaemonStopped = false;
      await waitForProcessExit(oldDaemon.state.pid, 10_000);

      await runBuiltStrictStage({ fixture });
      const after = JSON.parse(await fsp.readFile(progressPath, 'utf8')) as Record<string, unknown>;
      const receipt = JSON.parse(
        await fsp.readFile(
          path.join(fixture.operationRoot, 'quiesced-pre-reset-observation-receipt.json'),
          'utf8'
        )
      ) as Record<string, unknown>;
      expect((after.ack as Record<string, unknown>).ackHash).toBe(ackHash);
      expect(receipt.quiesceAcceptedAckHash).toBe(ackHash);
      expect(after.stage).toBe('old-pid-exited-checkpoint-complete');
    } finally {
      interrupted.kill('SIGKILL');
      if (oldDaemonStopped && isPidAlive(oldDaemon.state.pid)) {
        process.kill(oldDaemon.state.pid, 'SIGCONT');
      }
      await stopBuiltOldDaemon(oldDaemon.child);
    }
  }, 30_000);

  it('built strict replacement quiesces a live writer and publishes a fresh daemon identity', async () => {
    const fixture = await rebuildAuthorityFixture();
    const alembicHome = path.join(fixture.authorityRoot, 'live-daemon-home');
    await configureBuiltProjectScope(fixture, alembicHome);
    const logPath = path.join(fixture.dataRoot, '.asd/daemon.log');
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    const logHandle = await fsp.open(logPath, 'a');
    const oldDaemon = spawn(
      process.execPath,
      [path.join(process.cwd(), 'dist/bin/daemon-server.js')],
      {
        cwd: fixture.projectRoot,
        env: {
          ...process.env,
          ALEMBIC_DAEMON_FILE_CHANGES: '0',
          ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP: '0',
          ALEMBIC_HOME: alembicHome,
          ALEMBIC_PROJECT_DIR: fixture.projectRoot,
          ALEMBIC_QUIET: '1',
          ALEMBIC_STRICT_SETUP_ACTION_PATH: '',
          ALEMBIC_STRICT_SETUP_AUTHORITY_PATH: '',
          NODE_ENV: 'test',
        },
        stdio: ['ignore', logHandle.fd, logHandle.fd],
      }
    );
    await logHandle.close();
    const statePath = path.join(fixture.dataRoot, '.asd/daemon.json');
    const oldState = await waitForDaemonState(statePath, oldDaemon.pid ?? -1);
    await fsp.writeFile(path.join(fixture.dataRoot, '.asd/daemon.pid'), `${oldState.pid}\n`, {
      mode: 0o600,
    });
    const strictChildLog = await fsp.open(
      path.join(fixture.authorityRoot, 'strict-child.log'),
      'a'
    );
    const supervisor = new DaemonSupervisor({
      daemonEntryPath: path.join(process.cwd(), 'dist/bin/daemon-server.js'),
      spawnDaemon: (command, args, options) =>
        spawn(command, args, {
          ...options,
          stdio: ['ignore', strictChildLog.fd, strictChildLog.fd],
        }),
    });

    try {
      const replacement = await supervisor.start({
        projectRoot: fixture.projectRoot,
        waitUntilReadyMs: 20_000,
      });
      await strictChildLog.close();
      if (!replacement.ready) {
        throw new Error(
          `${replacement.message ?? 'strict replacement failed'}\n${await fsp.readFile(
            path.join(fixture.authorityRoot, 'strict-child.log'),
            'utf8'
          )}`
        );
      }
      expect(replacement).toMatchObject({ ready: true, status: 'ready' });
      expect(replacement.state?.pid).not.toBe(oldState.pid);
      expect(replacement.state?.token).not.toBe(oldState.token);
      await waitForProcessExit(oldState.pid, 10_000);

      const receipt = JSON.parse(
        await fsp.readFile(
          path.join(fixture.operationRoot, 'quiesced-pre-reset-observation-receipt.json'),
          'utf8'
        )
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        kind: 'QuiescedPreResetObservationReceiptV1',
        disposition: 'live-graceful',
        databaseProof: {
          checkpointTerminal: true,
          integrityCheck: 'ok',
          walSize: null,
          shmSize: null,
        },
      });
      expect(receipt.quiesceRequestHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(receipt.quiesceAcceptedAckHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      await expect(
        fsp.stat(path.join(fixture.snapshotRoot, 'whole-root/.asd/daemon.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fsp.stat(path.join(fixture.snapshotRoot, 'whole-root/.asd/daemon.pid'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await strictChildLog.close().catch(() => {});
      await supervisor.stop({ projectRoot: fixture.projectRoot, waitMs: 10_000 }).catch(() => {});
      if (oldDaemon.pid && isPidAlive(oldDaemon.pid)) {
        oldDaemon.kill('SIGKILL');
      }
    }
  }, 35_000);

  it('built strict replacement fails closed when a live reader prevents terminal checkpoint', async () => {
    const fixture = await rebuildAuthorityFixture();
    const alembicHome = path.join(fixture.authorityRoot, 'busy-daemon-home');
    await configureBuiltProjectScope(fixture, alembicHome);
    const logPath = path.join(fixture.dataRoot, '.asd/daemon.log');
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    const logHandle = await fsp.open(logPath, 'a');
    const oldDaemon = spawn(
      process.execPath,
      [path.join(process.cwd(), 'dist/bin/daemon-server.js')],
      {
        cwd: fixture.projectRoot,
        env: {
          ...process.env,
          ALEMBIC_DAEMON_FILE_CHANGES: '0',
          ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP: '0',
          ALEMBIC_HOME: alembicHome,
          ALEMBIC_PROJECT_DIR: fixture.projectRoot,
          ALEMBIC_QUIET: '1',
          ALEMBIC_STRICT_SETUP_ACTION_PATH: '',
          ALEMBIC_STRICT_SETUP_AUTHORITY_PATH: '',
          NODE_ENV: 'test',
        },
        stdio: ['ignore', logHandle.fd, logHandle.fd],
      }
    );
    await logHandle.close();
    const statePath = path.join(fixture.dataRoot, '.asd/daemon.json');
    const oldState = await waitForDaemonState(statePath, oldDaemon.pid ?? -1);
    await fsp.writeFile(path.join(fixture.dataRoot, '.asd/daemon.pid'), `${oldState.pid}\n`, {
      mode: 0o600,
    });
    const writer = new Database(oldState.databasePath);
    writer.exec(
      "CREATE TABLE IF NOT EXISTS strict_checkpoint_probe (id INTEGER PRIMARY KEY, value TEXT); DELETE FROM strict_checkpoint_probe; INSERT INTO strict_checkpoint_probe(value) VALUES ('before-reader')"
    );
    const reader = new Database(oldState.databasePath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM strict_checkpoint_probe').all();
    writer.exec("INSERT INTO strict_checkpoint_probe(value) VALUES ('after-reader')");
    writer.close();
    const strictChildLog = await fsp.open(
      path.join(fixture.authorityRoot, 'strict-busy-child.log'),
      'a'
    );
    const supervisor = new DaemonSupervisor({
      daemonEntryPath: path.join(process.cwd(), 'dist/bin/daemon-server.js'),
      spawnDaemon: (command, args, options) =>
        spawn(command, args, {
          ...options,
          stdio: ['ignore', strictChildLog.fd, strictChildLog.fd],
        }),
    });

    try {
      const replacement = await supervisor.start({
        projectRoot: fixture.projectRoot,
        waitUntilReadyMs: 20_000,
      });
      await strictChildLog.close();
      expect(replacement).toMatchObject({ ready: false, status: 'failed' });
      await waitForProcessExit(oldState.pid, 10_000);
      await expect(fsp.stat(statePath)).resolves.toBeDefined();
      await expect(fsp.stat(path.join(fixture.dataRoot, '.asd/daemon.pid'))).resolves.toBeDefined();
      await expect(
        fsp.stat(path.join(fixture.operationRoot, 'quiesced-pre-reset-observation-receipt.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fsp.stat(path.join(fixture.snapshotRoot, 'whole-root'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      reader.close();
      await strictChildLog.close().catch(() => {});
      await supervisor.stop({ projectRoot: fixture.projectRoot, waitMs: 10_000 }).catch(() => {});
      if (oldDaemon.pid && isPidAlive(oldDaemon.pid)) {
        oldDaemon.kill('SIGKILL');
      }
    }
  }, 35_000);

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
    operationLockRoot,
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
  await configureBuiltProjectScope(input.fixture, alembicHome);
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

function builtStrictStageEnvironment(input: {
  fixture: { dataRoot: string; projectRoot: string };
  operation?: 'initialize' | 'recover' | 'reset';
  fetchGate?: 'after-response' | 'before-request';
  gatePath?: string;
  pausePid?: number;
  releasePath?: string;
  extraEnvironment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...input.extraEnvironment,
    ALEMBIC_TEST_STRICT_MODULE_URL: pathToFileURL(
      path.join(
        process.cwd(),
        'dist/lib/recipe-pipeline/generate/strict/StrictExternalSetupRecovery.js'
      )
    ).href,
    ALEMBIC_TEST_STRICT_STAGE_INPUT: JSON.stringify({
      dataRoot: input.fixture.dataRoot,
      projectRoot: input.fixture.projectRoot,
      operation: input.operation ?? 'initialize',
      fetchGate: input.fetchGate ?? null,
      gatePath: input.gatePath ?? null,
      pausePid: input.pausePid ?? null,
      releasePath: input.releasePath ?? null,
    }),
    NODE_ENV: 'test',
  };
}

async function runBuiltStrictStage(input: {
  fixture: { dataRoot: string; projectRoot: string };
  operation?: 'initialize' | 'recover' | 'reset';
  extraEnvironment?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> {
  const result = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', BUILT_STRICT_STAGE_SCRIPT],
    {
      cwd: process.cwd(),
      env: builtStrictStageEnvironment(input),
      timeout: 15_000,
    }
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function spawnBuiltStrictStage(input: {
  fixture: { dataRoot: string; projectRoot: string };
  fetchGate?: 'after-response' | 'before-request';
  gatePath?: string;
  pausePid?: number;
  releasePath?: string;
  extraEnvironment?: NodeJS.ProcessEnv;
}) {
  return spawn(process.execPath, ['--input-type=module', '--eval', BUILT_STRICT_STAGE_SCRIPT], {
    cwd: process.cwd(),
    env: builtStrictStageEnvironment(input),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForJsonStage(
  filePath: string,
  stage: string,
  timeoutMs = 10_000
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = JSON.parse(await fsp.readFile(filePath, 'utf8')) as Record<string, unknown>;
      if (value.stage === stage) {
        return value;
      }
    } catch {
      // Durable stage files appear atomically; absence is expected while the child advances.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for stage ${stage}: ${filePath}`);
}

async function waitForPath(filePath: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fsp.stat(filePath);
      return;
    } catch {
      // The gate is created by the independent child at the requested fault boundary.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for path: ${filePath}`);
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 10_000
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for child exit')),
      timeoutMs
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function configureBuiltProjectScope(
  fixture: {
    authorityRoot: string;
    dataRoot: string;
    projectRoot: string;
  },
  alembicHome: string
): Promise<void> {
  await fsp.mkdir(alembicHome, { recursive: true });
  process.env.ALEMBIC_HOME = alembicHome;
  const projectScope = createProjectDescriptor({
    controlRoot: path.dirname(fixture.projectRoot),
    dataRoot: fixture.dataRoot,
    displayName: 'strict server entry fixture',
    folders: [{ path: fixture.projectRoot, role: 'primary-source' }],
    projectId: 'strict-server-entry-fixture',
    projectScopeId: 'strict-server-entry-fixture-scope',
  });
  const registryPath = path.join(getProjectRegistryDir(), 'project-scopes.json');
  await fsp.mkdir(path.dirname(registryPath), { recursive: true });
  await fsp.writeFile(
    registryPath,
    `${JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)}\n`
  );
}

async function startBuiltOldDaemon(
  fixture: { authorityRoot: string; dataRoot: string; projectRoot: string },
  label: string
): Promise<{
  child: ReturnType<typeof spawn>;
  state: { databasePath: string; pid: number; token: string };
  stdioEvidence: string;
}> {
  const alembicHome = path.join(fixture.authorityRoot, `${label}-daemon-home`);
  await configureBuiltProjectScope(fixture, alembicHome);
  const logPath = path.join(fixture.dataRoot, '.asd/daemon.log');
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  const logHandle = await fsp.open(logPath, 'a');
  const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/bin/daemon-server.js')], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      ALEMBIC_DAEMON_FILE_CHANGES: '0',
      ALEMBIC_EVOLUTION_MAINTENANCE_SWEEP: '0',
      ALEMBIC_HOME: alembicHome,
      ALEMBIC_PROJECT_DIR: fixture.projectRoot,
      ALEMBIC_QUIET: '1',
      ALEMBIC_STRICT_SETUP_ACTION_PATH: '',
      ALEMBIC_STRICT_SETUP_AUTHORITY_PATH: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  await logHandle.close();
  const state = await waitForDaemonState(
    path.join(fixture.dataRoot, '.asd/daemon.json'),
    child.pid ?? -1
  );
  await fsp.writeFile(path.join(fixture.dataRoot, '.asd/daemon.pid'), `${state.pid}\n`, {
    mode: 0o600,
  });
  const stat = await fsp.stat(logPath);
  const semantic = {
    schemaVersion: 1 as const,
    ownerPid: state.pid,
    relativePathHash: sha256Text('.asd/daemon.log'),
    inode: String(stat.ino),
    initialSize: stat.size,
  };
  return {
    child,
    state,
    stdioEvidence: JSON.stringify({
      ...semantic,
      evidenceHash: sha256Text(JSON.stringify(semantic)),
    }),
  };
}

async function stopBuiltOldDaemon(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || !isPidAlive(child.pid)) {
    return;
  }
  child.kill('SIGTERM');
  try {
    await waitForProcessExit(child.pid, 5_000);
  } catch {
    child.kill('SIGKILL');
    await waitForProcessExit(child.pid, 5_000);
  }
}

async function waitForDaemonState(
  statePath: string,
  expectedPid: number,
  timeoutMs = 15_000
): Promise<{ databasePath: string; pid: number; token: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const state = JSON.parse(await fsp.readFile(statePath, 'utf8')) as {
        databasePath?: unknown;
        pid?: unknown;
        token?: unknown;
      };
      if (
        state.pid === expectedPid &&
        typeof state.token === 'string' &&
        state.token &&
        typeof state.databasePath === 'string'
      ) {
        return { pid: expectedPid, token: state.token, databasePath: state.databasePath };
      }
    } catch {
      // The daemon writes state only after its health endpoint is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for daemon state: ${statePath}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function sha256Text(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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

async function truncateStrictSetupJournalBeforeState(
  operationRoot: string,
  state: string
): Promise<void> {
  const journalPath = path.join(operationRoot, 'strict-production.journal.jsonl');
  const rows = (await fsp.readFile(journalPath, 'utf8')).trim().split('\n');
  const boundary = rows.findIndex((row) => {
    const parsed = JSON.parse(row) as { state?: unknown };
    return parsed.state === state;
  });
  if (boundary < 0) {
    throw new Error(`fixture journal state missing: ${state}`);
  }
  await fsp.writeFile(journalPath, `${rows.slice(0, boundary).join('\n')}\n`);
}

async function readStrictSetupJournalStates(operationRoot: string): Promise<string[]> {
  const rows = (
    await fsp.readFile(path.join(operationRoot, 'strict-production.journal.jsonl'), 'utf8')
  )
    .trim()
    .split('\n');
  return rows
    .map((row) => JSON.parse(row) as { state?: unknown; track?: unknown })
    .filter((row) => row.track === 'setup' && typeof row.state === 'string')
    .map((row) => String(row.state));
}

function sha(value: string): string {
  return `sha256:${value.length.toString(16).padStart(64, 'a').slice(-64)}`;
}
