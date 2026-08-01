import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { WorkspaceResolver } from '@alembic/core/workspace';

const OWNER_FILE = 'strict-test-workspace-owner.json';
const PRIVATE_DATA_DIRECTORY = 'private-data';
const IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u;

export interface StrictTestPrivateWorkspaceAuthorityV1 {
  readonly canonicalProjectIdentityHash: string;
  readonly controlRoot: string;
  readonly demandKey: string;
  readonly productionDataRoot: string;
  readonly projectRoot: string;
  readonly runId: string;
  readonly sourceRoots: readonly string[];
}

export interface StrictTestPrivateWorkspacePolicyV1 {
  readonly schemaVersion: 1;
  readonly profile: 'strict-test-dimension';
  readonly demandKey: string;
  readonly runId: string;
  readonly canonicalProjectIdentityHash: string;
  readonly controlRootIdentity: string;
  readonly projectRootIdentity: string;
  readonly productionDataRootIdentity: string;
  readonly sourceRootIdentities: readonly string[];
  readonly runRoot: string;
  readonly privateDataRoot: string;
  readonly policyHash: string;
}

export interface StrictTestPrivateWorkspaceV1 extends StrictTestPrivateWorkspacePolicyV1 {
  readonly ownerPath: string;
  readonly resolver: WorkspaceResolver;
}

export async function resolveStrictTestPrivateWorkspacePolicy(
  authority: StrictTestPrivateWorkspaceAuthorityV1
): Promise<StrictTestPrivateWorkspacePolicyV1> {
  if (!IDENTITY_PATTERN.test(authority.demandKey) || !IDENTITY_PATTERN.test(authority.runId)) {
    throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_IDENTITY_INVALID');
  }
  await assertDirectPathIsNotSymlink(authority.controlRoot);
  const controlRoot = await requireRealDirectory(authority.controlRoot, 'CONTROL_ROOT');
  const projectRoot = await requireRealDirectory(authority.projectRoot, 'PROJECT_ROOT');
  const productionDataRoot = await requireRealDirectory(
    authority.productionDataRoot,
    'PRODUCTION_DATA_ROOT'
  );
  const sourceRoots = [
    ...new Set(
      await Promise.all(
        authority.sourceRoots.map((root) => requireRealDirectory(root, 'SOURCE_ROOT'))
      )
    ),
  ].sort();
  if (sourceRoots.length === 0 || !sourceRoots.includes(projectRoot)) {
    throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_SOURCE_AUTHORITY_INVALID');
  }
  const runRoot = path.join(controlRoot, 'strict-test-runs', authority.demandKey, authority.runId);
  const privateDataRoot = path.join(runRoot, PRIVATE_DATA_DIRECTORY);
  for (const forbiddenRoot of [productionDataRoot, ...sourceRoots]) {
    if (pathsOverlap(runRoot, forbiddenRoot)) {
      throw new Error(`STRICT_TEST_PRIVATE_WORKSPACE_OVERLAP:${forbiddenRoot}`);
    }
  }
  const semantic = {
    schemaVersion: 1 as const,
    profile: 'strict-test-dimension' as const,
    demandKey: authority.demandKey,
    runId: authority.runId,
    canonicalProjectIdentityHash: authority.canonicalProjectIdentityHash,
    controlRootIdentity: controlRoot,
    projectRootIdentity: projectRoot,
    productionDataRootIdentity: productionDataRoot,
    sourceRootIdentities: sourceRoots,
    runRoot,
    privateDataRoot,
  };
  return Object.freeze({ ...semantic, policyHash: hashCanonicalJson(semantic) });
}

export async function createStrictTestPrivateWorkspace(input: {
  readonly authority: StrictTestPrivateWorkspaceAuthorityV1;
  readonly baseResolver: WorkspaceResolver;
}): Promise<StrictTestPrivateWorkspaceV1> {
  const policy = await resolveStrictTestPrivateWorkspacePolicy(input.authority);
  if ((await fsp.realpath(input.baseResolver.projectRoot)) !== policy.projectRootIdentity) {
    throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_RESOLVER_MISMATCH');
  }
  const ownerPath = path.join(policy.runRoot, OWNER_FILE);
  const existing = await readExistingOwner(ownerPath, policy.runRoot);
  if (existing) {
    if (
      existing.policyHash !== policy.policyHash ||
      existing.demandKey !== policy.demandKey ||
      existing.runId !== policy.runId
    ) {
      throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_OWNER_MISMATCH');
    }
  } else {
    await createDirectoryTreeWithoutSymlinks(policy.controlRootIdentity, [
      'strict-test-runs',
      policy.demandKey,
      policy.runId,
    ]);
    try {
      await fsp.writeFile(
        ownerPath,
        `${JSON.stringify({
          schemaVersion: 1,
          profile: policy.profile,
          demandKey: policy.demandKey,
          runId: policy.runId,
          policyHash: policy.policyHash,
        })}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      );
    } catch (error: unknown) {
      if (readCode(error) !== 'EEXIST') {
        throw error;
      }
      const raced = await readExistingOwner(ownerPath, policy.runRoot);
      if (
        !raced ||
        raced.policyHash !== policy.policyHash ||
        raced.demandKey !== policy.demandKey ||
        raced.runId !== policy.runId
      ) {
        throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_OWNER_MISMATCH');
      }
    }
  }
  await ensurePrivateDataRoot(policy.privateDataRoot);
  return Object.freeze({
    ...policy,
    ownerPath,
    resolver: createPrivateResolver(input.baseResolver, policy.privateDataRoot),
  });
}

function createPrivateResolver(base: WorkspaceResolver, dataRoot: string): WorkspaceResolver {
  const resolver = Object.create(WorkspaceResolver.prototype) as WorkspaceResolver;
  Object.defineProperties(resolver, {
    projectRoot: { value: base.projectRoot, enumerable: true },
    dataRoot: { value: dataRoot, enumerable: true },
    ghost: { value: true, enumerable: true },
    projectId: { value: base.projectId, enumerable: true },
    projectScope: { value: base.projectScope, enumerable: true },
    currentFolderId: { value: base.currentFolderId, enumerable: true },
    knowledgeBaseDir: { value: base.knowledgeBaseDir, enumerable: true },
    folderNames: { value: base.folderNames, enumerable: true },
  });
  return resolver;
}

async function ensurePrivateDataRoot(privateDataRoot: string): Promise<void> {
  try {
    await fsp.mkdir(privateDataRoot, { mode: 0o700 });
  } catch (error: unknown) {
    if (readCode(error) !== 'EEXIST') {
      throw error;
    }
  }
  const stat = await fsp.lstat(privateDataRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_DATA_ROOT_INVALID');
  }
  if ((await fsp.realpath(privateDataRoot)) !== privateDataRoot) {
    throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_DATA_ROOT_ALIAS_FORBIDDEN');
  }
}

async function readExistingOwner(
  ownerPath: string,
  runRoot: string
): Promise<{ demandKey?: unknown; runId?: unknown; policyHash?: unknown } | null> {
  try {
    const stat = await fsp.lstat(runRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_ROOT_INVALID');
    }
    const ownerStat = await fsp.lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
      throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_OWNER_INVALID');
    }
    const value = JSON.parse(await fsp.readFile(ownerPath, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_OWNER_INVALID');
    }
    const owner = value as Record<string, unknown>;
    const keys = Object.keys(owner).sort();
    if (
      JSON.stringify(keys) !==
        JSON.stringify(['demandKey', 'policyHash', 'profile', 'runId', 'schemaVersion']) ||
      owner.schemaVersion !== 1 ||
      owner.profile !== 'strict-test-dimension' ||
      typeof owner.demandKey !== 'string' ||
      typeof owner.runId !== 'string' ||
      typeof owner.policyHash !== 'string'
    ) {
      throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_OWNER_INVALID');
    }
    return owner;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      try {
        await fsp.lstat(runRoot);
      } catch (rootError: unknown) {
        if (readCode(rootError) === 'ENOENT') {
          return null;
        }
        throw rootError;
      }
      throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_OWNER_MISSING');
    }
    throw error;
  }
}

async function createDirectoryTreeWithoutSymlinks(root: string, segments: readonly string[]) {
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      await fsp.mkdir(cursor, { mode: 0o700 });
    } catch (error: unknown) {
      if (readCode(error) !== 'EEXIST') {
        throw error;
      }
    }
    const stat = await fsp.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_SYMLINK_FORBIDDEN');
    }
  }
}

async function requireRealDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  const stat = await fsp.lstat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`STRICT_TEST_PRIVATE_WORKSPACE_${label}_INVALID`);
  }
  return fsp.realpath(resolved);
}

async function assertDirectPathIsNotSymlink(value: string): Promise<void> {
  if ((await fsp.lstat(path.resolve(value))).isSymbolicLink()) {
    throw new Error('STRICT_TEST_PRIVATE_WORKSPACE_SYMLINK_FORBIDDEN');
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftRoot = path.resolve(left);
  const rightRoot = path.resolve(right);
  return (
    leftRoot === rightRoot ||
    leftRoot.startsWith(`${rightRoot}${path.sep}`) ||
    rightRoot.startsWith(`${leftRoot}${path.sep}`)
  );
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
