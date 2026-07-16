import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStrictProductionAuthorization } from '../../lib/recipe-pipeline/generate/strict/StrictAuthorization.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true })));
});

describe('strict production authorization', () => {
  it('binds run/project/data/hash and keeps journal, receipt, and public route outside reset', async () => {
    const fixture = await authorizationFixture();
    const loaded = await loadStrictProductionAuthorization({
      dataRoot: fixture.dataRoot,
      projectRoot: fixture.projectRoot,
      request: {
        schemaVersion: 1,
        authorizationReceiptHash: fixture.receipt.authorizationHash,
        authorizationReceiptPath: fixture.receiptPath,
        ownerId: 'daemon-job:one',
        runId: 'run-a',
      },
    });

    expect(loaded.authorizationHash).toBe(fixture.receipt.authorizationHash);
    expect(loaded.runId).toBe('run-a');
  });

  it('fails closed for tamper and reset overlap with durable/public authority', async () => {
    const fixture = await authorizationFixture();
    await fsp.writeFile(
      path.join(fixture.dataRoot, fixture.receiptPath),
      `${JSON.stringify({ ...fixture.receipt, runId: 'tampered' })}\n`
    );
    await expect(
      loadStrictProductionAuthorization({
        dataRoot: fixture.dataRoot,
        projectRoot: fixture.projectRoot,
        request: {
          schemaVersion: 1,
          authorizationReceiptHash: fixture.receipt.authorizationHash,
          authorizationReceiptPath: fixture.receiptPath,
          ownerId: 'daemon-job:one',
          runId: 'run-a',
        },
      })
    ).rejects.toThrow('STRICT_AUTHORIZATION_BINDING_MISMATCH');

    const overlap = buildReceipt(fixture.projectRoot, fixture.dataRoot, {
      resetPaths: ['strict-production'],
    });
    await fsp.writeFile(
      path.join(fixture.dataRoot, fixture.receiptPath),
      `${JSON.stringify(overlap)}\n`
    );
    await expect(
      loadStrictProductionAuthorization({
        dataRoot: fixture.dataRoot,
        projectRoot: fixture.projectRoot,
        request: {
          schemaVersion: 1,
          authorizationReceiptHash: overlap.authorizationHash,
          authorizationReceiptPath: fixture.receiptPath,
          ownerId: 'daemon-job:one',
          runId: 'run-a',
        },
      })
    ).rejects.toThrow('STRICT_AUTHORIZATION_ROOT_OVERLAP');
  });

  it('rejects a regular receipt reached through a symlinked parent', async () => {
    const fixture = await authorizationFixture();
    const externalRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-auth-external-'));
    roots.push(externalRoot);
    await fsp.writeFile(
      path.join(externalRoot, 'run-a.json'),
      `${JSON.stringify(fixture.receipt)}\n`
    );
    await fsp.symlink(externalRoot, path.join(fixture.dataRoot, 'linked-authorizations'));

    await expect(
      loadStrictProductionAuthorization({
        dataRoot: fixture.dataRoot,
        projectRoot: fixture.projectRoot,
        request: {
          schemaVersion: 1,
          authorizationReceiptHash: fixture.receipt.authorizationHash,
          authorizationReceiptPath: 'linked-authorizations/run-a.json',
          ownerId: 'daemon-job:one',
          runId: 'run-a',
        },
      })
    ).rejects.toThrow('STRICT_AUTHORIZATION_SYMLINK_FORBIDDEN');
  });
});

async function authorizationFixture() {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-auth-'));
  roots.push(dataRoot);
  const projectRoot = path.join(dataRoot, 'project');
  await fsp.mkdir(projectRoot);
  const receiptPath = 'strict-production/authorizations/run-a.json';
  const receipt = buildReceipt(projectRoot, dataRoot);
  await fsp.mkdir(path.dirname(path.join(dataRoot, receiptPath)), { recursive: true });
  await fsp.writeFile(path.join(dataRoot, receiptPath), `${JSON.stringify(receipt)}\n`);
  return { dataRoot, projectRoot, receipt, receiptPath };
}

function buildReceipt(
  projectRoot: string,
  dataRoot: string,
  options: { resetPaths?: string[] } = {}
) {
  const semantic = {
    schemaVersion: 1 as const,
    runId: 'run-a',
    projectRoot,
    dataRoot,
    operationRoot: 'strict-production/operations/run-a',
    publicRoutePath: 'public/active.json',
    expectedPublicRouteHash: null,
    pcfBaselineReceiptHash: sha('pcf'),
    reset: { relativePaths: options.resetPaths ?? ['cache/candidates'], tables: ['recipes'] },
    planning: {
      factQueryFamilies: [
        {
          id: 'syntax-idiom',
          capabilityId: 'tree-sitter-query',
          supportedScales: ['source-range'],
          loadedProducer: 'strict-main-test',
          producerManifestHash: sha('producer'),
          loadReceiptHash: sha('load'),
          positiveFixtureHash: sha('positive'),
          negativeFixtureHash: sha('negative'),
          edgeFixtureHash: sha('edge'),
        },
      ],
      modelHash: sha('model'),
      promptHash: sha('prompt'),
      strictConfig: { sourceArtifactHash: sha('config'), strictColdStart: {}, fieldSources: {} },
      reviewer: {
        calibrationReceiptHash: sha('calibration'),
        identity: { provider: 'independent', model: 'reviewer', method: 'frozen-evidence' },
      },
    },
    privateCorpus: {
      acceptedMigrationBundleSemanticHash: sha('migration'),
      credentialLocationSymbol: 'env:TEST_ONLY',
    },
  };
  return Object.freeze({ ...semantic, authorizationHash: hashCanonicalJson(semantic) });
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}
