import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyRuntimeArtifactManifestV1 } from '../../lib/recipe-pipeline/generate/strict/StrictRuntimeArtifacts.js';
import {
  createRuntimeArtifactManifestFixture,
  materializeLoadedPackageFixture,
  semanticHash,
} from '../helpers/RuntimeArtifactManifestFixture.js';

describe('RuntimeArtifactLoadReceiptV1', () => {
  it('validates exact package artifacts, loaded entries, compatibility, and one Core copy', async () => {
    const fixture = await createFixture();
    const result = await verifyRuntimeArtifactManifestV1({
      expectedManifestContentHash: fixture.manifestContentHash,
      expectedManifestHash: fixture.manifest.manifestHash,
      loadedPackageRoots: fixture.loadedPackageRoots,
      manifestPath: fixture.manifestPath,
      manifestSymbol: 'controller:runtime-artifact-manifest',
    });

    expect(result.receipt).toMatchObject({
      kind: 'RuntimeArtifactLoadReceiptV1',
      manifestHash: fixture.manifest.manifestHash,
      dashboard: { status: 'not-applicable', startupDecision: 'forbidden' },
      dependencyResolution: {
        singleCoreCopy: true,
        agentCoreResolutionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(
      result.receipt.artifacts
        .filter((row) => row.loadedPathSymbol?.startsWith('loaded:'))
        .map((row) => ({
          distContentHash: row.distContentHash,
          distFileCount: row.distFileCount,
          packageName: row.packageName,
        }))
    ).toEqual([
      {
        distContentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        distFileCount: 2,
        packageName: '@alembic/agent',
      },
      {
        distContentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        distFileCount: 2,
        packageName: 'alembic-ai',
      },
      {
        distContentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        distFileCount: 2,
        packageName: '@alembic/core',
      },
    ]);
    expect(result.receipt.artifacts.map((row) => row.artifactId)).toEqual([
      'agent-package-dist',
      'alembic-runtime-release',
      'core-package-dist',
      'dashboard-build',
      'fact-query-pack-code-fact-backends',
      'migration-bundle',
      'plugin-mcp-package-server',
      'prompt-sop-evaluator-bundle',
      'vector-adapter',
    ]);
    expect(JSON.stringify(result.receipt)).not.toContain(fixture.root);
  });

  it('fails closed on artifact drift before returning a receipt', async () => {
    const fixture = await createFixture();
    await fs.appendFile(fixture.coreArtifactPath, Buffer.from('tamper'));

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: fixture.manifestContentHash,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_HASH_MISMATCH');
  });

  it('fails closed when the accepted Main archive predates the complete loaded dist', async () => {
    const fixture = await createFixture();
    const currentOnlyFile = path.join(
      fixture.loadedPackageRoots.main,
      'dist/internal/current-only.js'
    );
    await fs.writeFile(currentOnlyFile, 'current-only\n');

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: fixture.manifestContentHash,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_STALE_DIST');
  });

  it('fails closed when a non-entry dist file drifts while the entrypoint stays unchanged', async () => {
    const fixture = await createFixture();
    await fs.writeFile(
      path.join(fixture.loadedPackageRoots.core, 'dist/internal/secondary.js'),
      'tampered-non-entry\n'
    );

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: fixture.manifestContentHash,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_STALE_DIST');
  });

  it('fails closed when a loaded dist file is missing while the entrypoint stays unchanged', async () => {
    const fixture = await createFixture();
    await fs.rm(path.join(fixture.loadedPackageRoots.agent, 'dist/internal/secondary.js'));

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: fixture.manifestContentHash,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_STALE_DIST');
  });

  it('recomputes embedded Main dependencies instead of trusting declared hashes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-artifact-embedded-'));
    const main = path.join(root, 'runtime');
    const core = path.join(main, 'node_modules/@alembic/core');
    const agent = path.join(main, 'node_modules/@alembic/agent');
    const rogueCore = path.join(root, 'rogue-core');
    await materializeLoadedPackageFixture(
      main,
      'alembic-ai',
      'main-entry',
      'dist/lib/Bootstrap.js'
    );
    await materializeLoadedPackageFixture(core, '@alembic/core', 'core-entry');
    await materializeLoadedPackageFixture(agent, '@alembic/agent', 'agent-entry');
    await materializeLoadedPackageFixture(rogueCore, '@alembic/core', 'core-entry');
    await fs.writeFile(path.join(rogueCore, 'dist/internal/secondary.js'), 'rogue-embedded-core\n');
    const fixture = await createRuntimeArtifactManifestFixture({
      root,
      loadedPackageRoots: { agent, core, main },
      embeddedPackageRoots: { mainCore: rogueCore },
    });

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: fixture.manifestContentHash,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_DEPENDENCY_MISMATCH');
  });

  it('fails closed when manifest bytes drift while the declared manifest hash is retained', async () => {
    const fixture = await createFixture();
    await fs.appendFile(fixture.manifestPath, ' ');

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: fixture.manifestContentHash,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_MANIFEST_CONTENT_HASH_MISMATCH');
  });

  it('fails closed when Agent resolves a second Core copy', async () => {
    const fixture = await createFixture();
    const duplicateRoot = path.join(fixture.loadedPackageRoots.agent, 'node_modules/@alembic/core');
    await materializeLoadedPackageFixture(duplicateRoot, '@alembic/core', 'core-entry');

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: fixture.manifestContentHash,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_SECOND_COPY');
  });

  it('fails closed when Node resolves an identical Core at a different physical root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-artifact-resolution-'));
    const main = path.join(root, 'runtime');
    const resolvedCore = path.join(main, 'node_modules/@alembic/core');
    const agent = path.join(main, 'node_modules/@alembic/agent');
    const declaredCore = path.join(root, 'declared-core');
    await materializeLoadedPackageFixture(
      main,
      'alembic-ai',
      'main-entry',
      'dist/lib/Bootstrap.js'
    );
    await materializeLoadedPackageFixture(resolvedCore, '@alembic/core', 'core-entry');
    await materializeLoadedPackageFixture(declaredCore, '@alembic/core', 'core-entry');
    await materializeLoadedPackageFixture(agent, '@alembic/agent', 'agent-entry');
    const fixture = await createRuntimeArtifactManifestFixture({
      root,
      loadedPackageRoots: { agent, core: declaredCore, main },
    });

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: fixture.manifestContentHash,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_SECOND_COPY');
  });

  it('fails closed when the accepted compatibility matrix is not terminal-passed', async () => {
    const fixture = await createFixture();
    fixture.manifest.compatibilityMatrix[0].status = 'failed';
    fixture.manifest.manifestHash = semanticHash(fixture.manifest, 'manifestHash');
    const manifestBytes = Buffer.from(`${JSON.stringify(fixture.manifest)}\n`);
    await fs.writeFile(fixture.manifestPath, manifestBytes);

    await expect(
      verifyRuntimeArtifactManifestV1({
        expectedManifestContentHash: `sha256:${semanticHashBytes(manifestBytes)}`,
        expectedManifestHash: fixture.manifest.manifestHash,
        loadedPackageRoots: fixture.loadedPackageRoots,
        manifestPath: fixture.manifestPath,
        manifestSymbol: 'controller:runtime-artifact-manifest',
      })
    ).rejects.toThrow('STRICT_RUNTIME_ARTIFACT_COMPATIBILITY_MISMATCH');
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-artifact-fixture-'));
  const main = path.join(root, 'runtime');
  const core = path.join(main, 'node_modules/@alembic/core');
  const agent = path.join(main, 'node_modules/@alembic/agent');
  await materializeLoadedPackageFixture(main, 'alembic-ai', 'main-entry', 'dist/lib/Bootstrap.js');
  await materializeLoadedPackageFixture(core, '@alembic/core', 'core-entry');
  await materializeLoadedPackageFixture(agent, '@alembic/agent', 'agent-entry');
  return createRuntimeArtifactManifestFixture({
    root,
    loadedPackageRoots: { agent, core, main },
  });
}

function semanticHashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
