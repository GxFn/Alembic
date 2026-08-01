import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createStrictTestPrivateWorkspace,
  resolveStrictTestPrivateWorkspacePolicy,
} from '../../lib/recipe-pipeline/generate/strict/StrictTestPrivateWorkspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-strict-test-workspace-'));
  roots.push(root);
  const controlRoot = path.join(root, 'control');
  const projectRoot = path.join(controlRoot, 'sources', 'project');
  const productionDataRoot = path.join(controlRoot, 'production-data');
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(productionDataRoot, { recursive: true });
  const baseResolver = new WorkspaceResolver({ projectRoot });
  return { baseResolver, controlRoot, productionDataRoot, projectRoot, root };
}

describe('StrictTestPrivateWorkspace', () => {
  test('derives and owns an absent private run root without changing the source resolver', async () => {
    const value = await fixture();
    const authority = {
      canonicalProjectIdentityHash: `sha256:${'a'.repeat(64)}`,
      controlRoot: value.controlRoot,
      demandKey: 'demand-1',
      productionDataRoot: value.productionDataRoot,
      projectRoot: value.projectRoot,
      runId: 'run-1',
      sourceRoots: [value.projectRoot],
    };
    const policy = await resolveStrictTestPrivateWorkspacePolicy(authority);
    const controlRootIdentity = await fsp.realpath(value.controlRoot);
    expect(policy.runRoot).toBe(
      path.join(controlRootIdentity, 'strict-test-runs', 'demand-1', 'run-1')
    );
    await expect(fsp.lstat(policy.runRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    const workspace = await createStrictTestPrivateWorkspace({
      authority,
      baseResolver: value.baseResolver,
    });
    const owner = JSON.parse(await fsp.readFile(workspace.ownerPath, 'utf8')) as {
      policyHash: string;
    };

    expect(owner.policyHash).toBe(policy.policyHash);
    expect(workspace.resolver.projectRoot).toBe(value.projectRoot);
    expect(workspace.resolver.dataRoot.startsWith(`${workspace.runRoot}${path.sep}`)).toBe(true);
    expect(workspace.resolver.dataRoot).not.toBe(value.productionDataRoot);
  });

  test('reopens only the exact same owner and immutable policy', async () => {
    const value = await fixture();
    const authority = {
      canonicalProjectIdentityHash: `sha256:${'a'.repeat(64)}`,
      controlRoot: value.controlRoot,
      demandKey: 'demand-1',
      productionDataRoot: value.productionDataRoot,
      projectRoot: value.projectRoot,
      runId: 'run-1',
      sourceRoots: [value.projectRoot],
    };
    const first = await createStrictTestPrivateWorkspace({
      authority,
      baseResolver: value.baseResolver,
    });
    const reopened = await createStrictTestPrivateWorkspace({
      authority,
      baseResolver: value.baseResolver,
    });
    expect(reopened.policyHash).toBe(first.policyHash);

    await expect(
      createStrictTestPrivateWorkspace({
        authority: { ...authority, canonicalProjectIdentityHash: `sha256:${'b'.repeat(64)}` },
        baseResolver: value.baseResolver,
      })
    ).rejects.toThrow('STRICT_TEST_PRIVATE_WORKSPACE_OWNER_MISMATCH');
  });

  test('rejects a private data-root alias on resume', async () => {
    const value = await fixture();
    const authority = {
      canonicalProjectIdentityHash: `sha256:${'a'.repeat(64)}`,
      controlRoot: value.controlRoot,
      demandKey: 'demand-1',
      productionDataRoot: value.productionDataRoot,
      projectRoot: value.projectRoot,
      runId: 'run-1',
      sourceRoots: [value.projectRoot],
    };
    const first = await createStrictTestPrivateWorkspace({
      authority,
      baseResolver: value.baseResolver,
    });
    await fsp.rm(first.privateDataRoot, { recursive: true });
    await fsp.symlink(value.productionDataRoot, first.privateDataRoot);

    await expect(
      createStrictTestPrivateWorkspace({ authority, baseResolver: value.baseResolver })
    ).rejects.toThrow('STRICT_TEST_PRIVATE_WORKSPACE_DATA_ROOT_INVALID');
  });

  test('rejects source/production overlap before creating the run root', async () => {
    const value = await fixture();
    const authority = {
      canonicalProjectIdentityHash: `sha256:${'a'.repeat(64)}`,
      controlRoot: value.projectRoot,
      demandKey: 'demand-1',
      productionDataRoot: value.productionDataRoot,
      projectRoot: value.projectRoot,
      runId: 'run-1',
      sourceRoots: [value.projectRoot],
    };
    await expect(
      createStrictTestPrivateWorkspace({ authority, baseResolver: value.baseResolver })
    ).rejects.toThrow('STRICT_TEST_PRIVATE_WORKSPACE_OVERLAP');
    await expect(
      fsp.lstat(path.join(value.projectRoot, 'strict-test-runs', 'demand-1', 'run-1'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects a symlink/alias control root before any private write', async () => {
    const value = await fixture();
    const alias = path.join(value.root, 'control-alias');
    await fsp.symlink(value.controlRoot, alias);
    const authority = {
      canonicalProjectIdentityHash: `sha256:${'a'.repeat(64)}`,
      controlRoot: alias,
      demandKey: 'demand-1',
      productionDataRoot: value.productionDataRoot,
      projectRoot: value.projectRoot,
      runId: 'run-1',
      sourceRoots: [value.projectRoot],
    };

    await expect(
      createStrictTestPrivateWorkspace({ authority, baseResolver: value.baseResolver })
    ).rejects.toThrow('STRICT_TEST_PRIVATE_WORKSPACE_SYMLINK_FORBIDDEN');
    await expect(
      fsp.lstat(path.join(value.controlRoot, 'strict-test-runs', 'demand-1', 'run-1'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
