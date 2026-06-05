import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DecisionRegisterStore,
  DecisionRegisterStoreError,
  toDecisionRegisterSessionKey,
} from '../../lib/service/task/DecisionRegisterStore.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-decision-register-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('DecisionRegisterStore', () => {
  test('persists ProjectScope scoped decisions with redacted refs and append-only audit', () => {
    const dataRoot = tempRoot();
    const store = new DecisionRegisterStore({
      dataRoot,
      now: () => new Date('2026-06-05T03:30:00.000Z'),
      workspace: {
        dataRootSource: 'ghost-registry',
        projectId: 'project-abc',
        projectScopeId: 'scope-abc',
        workspaceMode: 'ghost',
      },
    });

    const created = store.create({
      createdBy: 'plugin',
      decision: 'Use the durable Alembic route for decision records.',
      detailRefs: ['/Users/private/project/src/detail.ts:8'],
      metadata: {
        nested: { path: '/Users/private/project/src/raw.ts' },
        sourceRef: '/Users/private/project/src/source.ts',
        threadId: 'raw-thread-id',
      },
      rationale: 'Plugin public tool needs durable readback.',
      scope: { projectScopeId: 'scope-abc' },
      sessionId: 'raw-thread-id',
      sourceRefs: ['/Users/private/project/src/route.ts:42', 'recipe:decision'],
      tags: ['afapi', 'stage4b'],
      title: 'Durable decision register',
      turnId: 'raw-turn-id',
      workRef: 'work_123',
    });
    const updated = store.update(created.decisionId, {
      decision: 'Use the Alembic Decision Register route for CRUD.',
      sourceRefs: ['/Users/private/project/src/updated.ts:10'],
      updatedBy: 'plugin',
    });
    const revoked = store.revoke(created.decisionId, { reason: 'superseded' });
    const deleted = store.delete(created.decisionId, { reason: 'cleanup' });

    expect(created).toMatchObject({
      dataRootSource: 'ghost-registry',
      decision: 'Use the durable Alembic route for decision records.',
      projectId: 'project-abc',
      projectScopeId: 'scope-abc',
      sessionKey: toDecisionRegisterSessionKey('raw-thread-id'),
      status: 'active',
      title: 'Durable decision register',
      turnKey: toDecisionRegisterSessionKey('raw-turn-id'),
      workspaceMode: 'ghost',
    });
    expect(created.sourceRefs).toEqual(['[absolute-path]/route.ts:42', 'recipe:decision']);
    expect(created.detailRefs).toEqual(['[absolute-path]/detail.ts:8']);
    expect(created.sourceRefKeys[0]).toMatch(/^sha256:/);
    expect(created.metadata).toMatchObject({
      sourceRef: expect.stringMatching(/^sha256:/),
      threadId: toDecisionRegisterSessionKey('raw-thread-id'),
    });
    expect(updated).toMatchObject({
      revision: 2,
      sourceRefs: ['[absolute-path]/updated.ts:10'],
      status: 'active',
    });
    expect(revoked).toMatchObject({ revision: 3, revokeReason: 'superseded', status: 'revoked' });
    expect(deleted).toMatchObject({ deleteReason: 'cleanup', revision: 4, status: 'deleted' });
    expect(store.list()).toEqual([]);
    expect(store.list({ includeDeleted: true })).toHaveLength(1);
    expect(store.list({ sessionId: 'raw-thread-id', status: 'all' })).toHaveLength(1);

    const storeDir = path.join(dataRoot, '.asd', 'decision-register');
    const recordPath = path.join(storeDir, 'records', `${created.decisionId}.json`);
    const disk = readFileSync(recordPath, 'utf8');
    expect(existsSync(path.join(storeDir, 'index.json'))).toBe(true);
    expect(
      readFileSync(path.join(storeDir, 'decisions.jsonl'), 'utf8').trim().split('\n')
    ).toHaveLength(4);
    expect(disk).not.toContain('raw-thread-id');
    expect(disk).not.toContain('raw-turn-id');
    expect(disk).not.toContain('/Users/private');
  });

  test('blocks writes for mismatched ProjectScope identity', () => {
    const store = new DecisionRegisterStore({
      dataRoot: tempRoot(),
      workspace: {
        dataRootSource: 'ghost-registry',
        projectId: 'project-abc',
        projectScopeId: 'scope-abc',
        workspaceMode: 'ghost',
      },
    });

    expect(() =>
      store.create({
        decision: 'blocked',
        scope: { projectScopeId: 'other-scope' },
        title: 'Blocked scope',
      })
    ).toThrow(DecisionRegisterStoreError);
    try {
      store.create({
        decision: 'blocked',
        scope: { projectScopeId: 'other-scope' },
        title: 'Blocked scope',
      });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DecisionRegisterStoreError);
      expect((err as DecisionRegisterStoreError).reasonCode).toBe('project-scope-mismatch');
      expect((err as DecisionRegisterStoreError).statusCode).toBe(409);
    }
  });

  test('exposes only active effective decisions in the default searchable view', () => {
    const store = new DecisionRegisterStore({
      dataRoot: tempRoot(),
      now: () => new Date('2026-06-05T04:10:00.000Z'),
    });

    const active = store.create({
      decision: 'Use the active producer decision in resident retrieval.',
      detailRefs: ['docs/retrieval.md'],
      sourceRefs: ['/Users/private/project/src/active.ts:12'],
      tags: ['retrieval', 'producer'],
      title: 'Active retrieval decision',
    });
    const revoked = store.create({
      decision: 'Do not expose revoked decisions to default retrieval.',
      sourceRefs: ['/Users/private/project/src/revoked.ts:9'],
      title: 'Revoked retrieval decision',
    });
    const deleted = store.create({
      decision: 'Do not expose deleted decisions to default retrieval.',
      sourceRefs: ['/Users/private/project/src/deleted.ts:7'],
      title: 'Deleted retrieval decision',
    });
    store.revoke(revoked.decisionId, { reason: 'stale' });
    store.delete(deleted.decisionId, { reason: 'removed' });

    const effective = store.searchable({ query: 'retrieval' });
    expect(effective).toMatchObject({
      acceptedCount: 1,
      auditCount: 0,
      auditExcludedCount: 2,
      policy: {
        acceptedStatuses: ['active'],
        defaultLifecycle: 'active-effective-only',
        excludedStatuses: ['revoked', 'deleted'],
        sourceRefGate: 'observe-only',
        vectorAdmission: 'accepted-only',
      },
      status: 'active',
    });
    expect(effective.documents).toHaveLength(1);
    expect(effective.documents[0]).toMatchObject({
      acceptedForRetrieval: true,
      decisionId: active.decisionId,
      id: `decision:${active.decisionId}`,
      kind: 'decision',
      knowledgeType: 'decision-register',
      metadata: {
        decisionRegister: {
          acceptedForRetrieval: true,
          defaultLifecycle: 'active-effective-only',
          retrievalLifecycle: 'effective',
          status: 'active',
        },
      },
      retrievalLifecycle: 'effective',
      sourceRefs: ['[absolute-path]/active.ts:12'],
      status: 'active',
    });
    expect(effective.documents.map((document) => document.decisionId)).not.toContain(
      revoked.decisionId
    );
    expect(effective.documents.map((document) => document.decisionId)).not.toContain(
      deleted.decisionId
    );

    const audit = store.searchable({
      includeAudit: true,
      query: 'retrieval',
      status: 'all',
    });
    expect(audit.documents.map((document) => document.status).sort()).toEqual([
      'active',
      'deleted',
      'revoked',
    ]);
    expect(
      audit.documents
        .filter((document) => document.status !== 'active')
        .every(
          (document) =>
            document.acceptedForRetrieval === false && document.retrievalLifecycle === 'audit'
        )
    ).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('/Users/private');
  });
});
