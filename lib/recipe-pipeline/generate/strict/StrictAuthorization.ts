import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  FactQueryFamilyV1,
  StrictColdStartConfigProjectionInputV1,
} from '@alembic/core/plans';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type { StrictProductionRuntimeRequestV1 } from './StrictProductionContracts.js';

export interface StrictProductionAuthorizationReceiptV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly operationRoot: string;
  readonly publicRoutePath: string;
  readonly expectedPublicRouteHash: string | null;
  readonly pcfBaselineReceiptHash: string;
  readonly reset: {
    readonly relativePaths: readonly string[];
    readonly tables: readonly string[];
  };
  readonly planning: {
    readonly factQueryFamilies: readonly FactQueryFamilyV1[];
    readonly modelHash: string;
    readonly promptHash: string;
    readonly strictConfig: StrictColdStartConfigProjectionInputV1;
    readonly reviewer: {
      readonly calibrationReceiptHash: string;
      readonly identity: {
        readonly provider: string;
        readonly model: string;
        readonly method: string;
      };
    };
  };
  readonly privateCorpus: {
    readonly acceptedMigrationBundleSemanticHash: string;
    readonly credentialLocationSymbol: string;
  };
  readonly authorizationHash: string;
}

export async function loadStrictProductionAuthorization(input: {
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly request: StrictProductionRuntimeRequestV1;
}): Promise<StrictProductionAuthorizationReceiptV1> {
  const receiptPath = confinedPath(input.dataRoot, input.request.authorizationReceiptPath);
  await assertNoSymlinkTraversal(input.dataRoot, receiptPath);
  const stat = await fsp.lstat(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('STRICT_AUTHORIZATION_RECEIPT_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(await fsp.readFile(receiptPath, 'utf8'));
  } catch {
    throw new Error('STRICT_AUTHORIZATION_RECEIPT_INVALID');
  }
  if (!isRecord(value)) {
    throw new Error('STRICT_AUTHORIZATION_RECEIPT_INVALID');
  }
  const { authorizationHash, ...semantic } = value;
  const computed = hashCanonicalJson(semantic);
  if (
    value.schemaVersion !== 1 ||
    value.runId !== input.request.runId ||
    value.projectRoot !== path.resolve(input.projectRoot) ||
    value.dataRoot !== path.resolve(input.dataRoot) ||
    authorizationHash !== computed ||
    authorizationHash !== input.request.authorizationReceiptHash
  ) {
    throw new Error('STRICT_AUTHORIZATION_BINDING_MISMATCH');
  }
  assertReceiptShape(value);
  const receipt = value as unknown as StrictProductionAuthorizationReceiptV1;
  if (receipt.expectedPublicRouteHash !== null) {
    throw new Error('STRICT_PUBLIC_ROUTE_EXPECTED_ABSENT');
  }
  const operationRoot = confinedPath(input.dataRoot, receipt.operationRoot);
  const publicRoutePath = confinedPath(input.dataRoot, receipt.publicRoutePath);
  const resetPaths = receipt.reset.relativePaths.map((relativePath) =>
    confinedPath(input.dataRoot, relativePath)
  );
  await Promise.all(
    [operationRoot, publicRoutePath, ...resetPaths].map((target) =>
      assertNoSymlinkTraversal(input.dataRoot, target)
    )
  );
  if (
    resetPaths.some(
      (resetPath) =>
        operationRoot === resetPath ||
        operationRoot.startsWith(`${resetPath}${path.sep}`) ||
        publicRoutePath === resetPath ||
        publicRoutePath.startsWith(`${resetPath}${path.sep}`) ||
        receiptPath === resetPath ||
        receiptPath.startsWith(`${resetPath}${path.sep}`)
    ) ||
    publicRoutePath === operationRoot ||
    publicRoutePath.startsWith(`${operationRoot}${path.sep}`)
  ) {
    throw new Error('STRICT_AUTHORIZATION_ROOT_OVERLAP');
  }
  return Object.freeze(receipt);
}

async function assertNoSymlinkTraversal(dataRoot: string, target: string): Promise<void> {
  const root = path.resolve(dataRoot);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('STRICT_AUTHORIZATION_DATA_ROOT_INVALID');
  }
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await fsp.lstat(cursor)).isSymbolicLink()) {
        throw new Error('STRICT_AUTHORIZATION_SYMLINK_FORBIDDEN');
      }
    } catch (error: unknown) {
      if (readCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

export function confinedPath(dataRoot: string, relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('STRICT_AUTHORIZATION_PATH_OUT_OF_SCOPE');
  }
  const root = path.resolve(dataRoot);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('STRICT_AUTHORIZATION_PATH_OUT_OF_SCOPE');
  }
  return resolved;
}

function assertReceiptShape(value: Record<string, unknown>): void {
  const reset = readRecord(value.reset);
  const planning = readRecord(value.planning);
  const privateCorpus = readRecord(value.privateCorpus);
  if (
    !readText(value.operationRoot) ||
    !readText(value.publicRoutePath) ||
    (value.expectedPublicRouteHash !== null && !isSha(value.expectedPublicRouteHash)) ||
    !isSha(value.pcfBaselineReceiptHash) ||
    !hasValidResetShape(reset) ||
    !hasValidPlanningShape(planning) ||
    !hasValidPrivateCorpusShape(privateCorpus)
  ) {
    throw new Error('STRICT_AUTHORIZATION_RECEIPT_INVALID');
  }
}

function hasValidResetShape(reset: Record<string, unknown>): boolean {
  return (
    Array.isArray(reset.relativePaths) &&
    reset.relativePaths.every((item) => readText(item)) &&
    Array.isArray(reset.tables) &&
    reset.tables.every((item) => readText(item))
  );
}

function hasValidPlanningShape(planning: Record<string, unknown>): boolean {
  const reviewer = readRecord(planning.reviewer);
  const identity = readRecord(reviewer.identity);
  return (
    Array.isArray(planning.factQueryFamilies) &&
    planning.factQueryFamilies.length > 0 &&
    isSha(planning.modelHash) &&
    isSha(planning.promptHash) &&
    isRecord(planning.strictConfig) &&
    isSha(reviewer.calibrationReceiptHash) &&
    Boolean(readText(identity.provider)) &&
    Boolean(readText(identity.model)) &&
    Boolean(readText(identity.method))
  );
}

function hasValidPrivateCorpusShape(privateCorpus: Record<string, unknown>): boolean {
  return (
    isSha(privateCorpus.acceptedMigrationBundleSemanticHash) &&
    Boolean(readText(privateCorpus.credentialLocationSymbol))
  );
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
