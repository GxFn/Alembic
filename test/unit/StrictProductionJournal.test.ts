import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { afterEach, describe, expect, it } from 'vitest';
import { assertStrictPublicRouteResumeCompatibility } from '../../lib/recipe-pipeline/generate/strict/StrictColdStartOrchestrator.js';
import {
  STRICT_PRODUCTION_STATES_V1,
  StrictProductionJournal,
  type StrictProductionStateV1,
} from '../../lib/recipe-pipeline/generate/strict/StrictProductionJournal.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true })));
});

describe('StrictProductionJournal', () => {
  it('orders validation, prepared CAS evidence, commit, and finalization literally', () => {
    expect(STRICT_PRODUCTION_STATES_V1.slice(-8)).toEqual([
      'G4_READY',
      'SERVING_RECONCILED',
      'FINAL_COVERAGE_BOUND',
      'SERVING_SNAPSHOT_VALIDATED',
      'SERVING_MANIFEST_READY',
      'PUBLIC_CAS_PREPARED',
      'PUBLIC_CAS_COMMITTED',
      'FINALIZED',
    ]);
    expect(STRICT_PRODUCTION_STATES_V1).not.toContain('CANDIDATE_ORACLE_PASSED');
  });

  it('accepts either the old expected route or prepared bytes only in the PREPARED crash window', () => {
    expect(() =>
      assertStrictPublicRouteResumeCompatibility({
        exactExpectedRouteObserved: true,
        exactPreparedRouteObserved: false,
        resumePoint: 'PUBLIC_CAS_PREPARED',
      })
    ).not.toThrow();
    expect(() =>
      assertStrictPublicRouteResumeCompatibility({
        exactExpectedRouteObserved: false,
        exactPreparedRouteObserved: true,
        resumePoint: 'PUBLIC_CAS_PREPARED',
      })
    ).not.toThrow();
    expect(() =>
      assertStrictPublicRouteResumeCompatibility({
        exactExpectedRouteObserved: true,
        exactPreparedRouteObserved: false,
        resumePoint: 'PUBLIC_CAS_COMMITTED',
      })
    ).toThrow('STRICT_PUBLIC_ROUTE_COMMIT_READBACK_MISSING');
  });

  it('rehydrates the exact durable substate with a verified append-only hash chain', async () => {
    const root = await temporaryRoot();
    const created = await StrictProductionJournal.open({
      operationRoot: root,
      ownerId: 'daemon:100',
      runId: 'run-a',
    });
    await created.append('PC_F_ACCEPTED', { receiptHash: sha('pcf') });
    await created.append('AUTHORIZED', { authorizationHash: sha('authorization') });
    await created.append('JOURNAL_OPEN', { observedPointersHash: sha('pointers') });
    await created.close();

    const resumed = await StrictProductionJournal.open({
      operationRoot: root,
      ownerId: 'daemon:200',
      resumeOwnerId: 'daemon:100',
      runId: 'run-a',
    });

    expect(resumed.resumePoint).toBe('JOURNAL_OPEN');
    expect(resumed.entries.map((entry) => entry.state)).toEqual([
      'PC_F_ACCEPTED',
      'AUTHORIZED',
      'JOURNAL_OPEN',
    ]);
    expect(resumed.entries[2]?.previousEntryHash).toBe(resumed.entries[1]?.entryHash);
    await resumed.close();
  });

  it('fails closed for a tampered row and an unowned resume', async () => {
    const root = await temporaryRoot();
    const journal = await StrictProductionJournal.open({
      operationRoot: root,
      ownerId: 'daemon:100',
      runId: 'run-b',
    });
    await journal.append('PC_F_ACCEPTED', { receiptHash: sha('pcf') });
    await journal.close();

    await expect(
      StrictProductionJournal.open({
        operationRoot: root,
        ownerId: 'daemon:other',
        runId: 'run-b',
      })
    ).rejects.toThrow('STRICT_JOURNAL_RESUME_OWNER_REQUIRED');

    const journalPath = path.join(root, 'strict-production.journal.jsonl');
    const rows = (await fsp.readFile(journalPath, 'utf8')).trim().split('\n');
    const row = JSON.parse(rows[0] ?? '{}') as Record<string, unknown>;
    row.state = 'FINALIZED' satisfies StrictProductionStateV1;
    await fsp.writeFile(journalPath, `${JSON.stringify(row)}\n`, 'utf8');

    await expect(
      StrictProductionJournal.open({
        operationRoot: root,
        ownerId: 'daemon:200',
        resumeOwnerId: 'daemon:100',
        runId: 'run-b',
      })
    ).rejects.toThrow('STRICT_JOURNAL_HASH_MISMATCH');
  });

  it('rejects a concurrent owner and every out-of-order state transition', async () => {
    const root = await temporaryRoot();
    const journal = await StrictProductionJournal.open({
      operationRoot: root,
      ownerId: 'daemon:owner',
      runId: 'run-c',
    });
    await expect(
      StrictProductionJournal.open({
        operationRoot: root,
        ownerId: 'daemon:competitor',
        runId: 'run-c',
      })
    ).rejects.toThrow('STRICT_JOURNAL_OWNER_ACTIVE');
    await expect(journal.append('AUTHORIZED', {})).rejects.toThrow(
      'STRICT_JOURNAL_STATE_TRANSITION_INVALID'
    );
    await journal.append('PC_F_ACCEPTED', { receiptHash: sha('pcf') });
    await journal.append('AUTHORIZED', { authorizationHash: sha('authorization') });
    await journal.append('JOURNAL_OPEN', { observedPointersHash: sha('pointers') });
    await expect(journal.append('BLANK', {})).rejects.toThrow(
      'STRICT_JOURNAL_STATE_TRANSITION_INVALID'
    );
    await journal.close();
  });

  it('reclaims only a well-formed dead-process lease for fresh-process resume', async () => {
    const root = await temporaryRoot();
    const created = await StrictProductionJournal.open({
      operationRoot: root,
      ownerId: 'daemon:old',
      runId: 'run-d',
    });
    await created.append('PC_F_ACCEPTED', { receiptHash: sha('pcf') });
    await created.close();
    const lockPath = path.join(root, 'strict-production.journal.lock');
    await fsp.writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        ownerId: 'daemon:old',
        ownerPid: 2_147_483_647,
        nonce: 'dead-owner',
        runId: 'run-d',
        acquiredAt: 1,
      })}\n`
    );
    const resumed = await StrictProductionJournal.open({
      operationRoot: root,
      ownerId: 'daemon:new',
      resumeOwnerId: 'daemon:old',
      runId: 'run-d',
    });
    expect(resumed.resumePoint).toBe('PC_F_ACCEPTED');
    await resumed.close();

    await fsp.writeFile(lockPath, '{"legacy":"unknown-owner"}\n');
    await expect(
      StrictProductionJournal.open({
        operationRoot: root,
        ownerId: 'daemon:another',
        resumeOwnerId: 'daemon:new',
        runId: 'run-d',
      })
    ).rejects.toThrow('STRICT_JOURNAL_OWNER_ACTIVE');
  });

  it('binds an external run header without counting it as a state row', async () => {
    const root = await temporaryRoot();
    const semantic = {
      schemaVersion: 1,
      kind: 'StrictRunJournalHeaderV1',
      runId: 'run-external',
      scenario: 'pristine',
      setupAuthorityHash: sha('authority'),
    };
    const headerHash = hashCanonicalJson(semantic);
    await fsp.writeFile(
      path.join(root, 'strict-production.journal.jsonl'),
      `${JSON.stringify({ ...semantic, headerHash })}\n`
    );

    const journal = await StrictProductionJournal.open({
      expectedHeaderHash: headerHash,
      operationRoot: root,
      ownerId: 'daemon:external',
      runId: 'run-external',
    });
    expect(journal.entries).toHaveLength(0);
    await journal.append('PC_F_ACCEPTED', { receiptHash: sha('pcf') });
    await journal.close();

    await expect(
      StrictProductionJournal.open({
        expectedHeaderHash: sha('wrong-header'),
        operationRoot: root,
        ownerId: 'daemon:external',
        runId: 'run-external',
      })
    ).rejects.toThrow('STRICT_JOURNAL_HEADER_MISMATCH');

    await fsp.rm(path.join(root, 'strict-production.journal.jsonl'));
    await expect(
      StrictProductionJournal.open({
        expectedHeaderHash: headerHash,
        operationRoot: root,
        ownerId: 'daemon:external',
        runId: 'run-external',
      })
    ).rejects.toThrow('STRICT_JOURNAL_HEADER_MISMATCH');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-journal-'));
  roots.push(root);
  return root;
}

function sha(value: string): string {
  return `sha256:${value.padEnd(64, '0').slice(0, 64)}`;
}
