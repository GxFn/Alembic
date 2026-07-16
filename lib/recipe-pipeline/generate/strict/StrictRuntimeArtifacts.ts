import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { PACKAGE_ROOT } from '../../../shared/package-assets.js';

const PACKAGE_ARTIFACT_IDS = [
  'agent-package-dist',
  'alembic-runtime-release',
  'core-package-dist',
  'plugin-mcp-package-server',
] as const;

const CONTENT_ARTIFACT_IDS = [
  'fact-query-pack-code-fact-backends',
  'migration-bundle',
  'prompt-sop-evaluator-bundle',
  'vector-adapter',
] as const;

const ALL_ARTIFACT_IDS = [
  ...PACKAGE_ARTIFACT_IDS,
  ...CONTENT_ARTIFACT_IDS,
  'dashboard-build',
].sort();

type LoadedPackageKey = 'agent' | 'core' | 'main';

export interface RuntimeArtifactLoadReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: 'RuntimeArtifactLoadReceiptV1';
  readonly manifestHash: string;
  readonly manifestContentHash: string;
  readonly manifestSymbol: string;
  readonly artifacts: readonly {
    readonly artifactId: string;
    readonly status: string;
    readonly artifactHash: string | null;
    readonly packageName?: string;
    readonly packageVersion?: string;
    readonly loadedPathSymbol?: string;
    readonly entrypointHash?: string;
    readonly schemasHash: string;
  }[];
  readonly pcfLineage: {
    readonly baselineReceiptHash: string;
    readonly finalRegressionReceiptHash: string;
    readonly lineageResult: string;
  };
  readonly dashboard: {
    readonly status: 'not-applicable';
    readonly startupDecision: 'forbidden';
    readonly triggerDecisionReceiptHash: string;
  };
  readonly dependencyResolution: {
    readonly singleCoreCopy: true;
    readonly loadedPackageSetHash: string;
    readonly compatibilityMatrixHash: string;
  };
  readonly artifactBindings: {
    readonly promptSopEvaluatorBundleHash: string;
    readonly vectorAdapterHash: string;
  };
  readonly receiptHash: string;
}

export interface RuntimeArtifactVerificationV1 {
  readonly receipt: RuntimeArtifactLoadReceiptV1;
  readonly artifactBindings: RuntimeArtifactLoadReceiptV1['artifactBindings'];
}

interface RuntimeArtifactManifestV1 extends Record<string, unknown> {
  schemaVersion: number;
  kind: string;
  stateRoot: string;
  status: string;
  manifestHash: string;
  pcfLineage: Record<string, unknown>;
  contentSetManifest: Record<string, unknown>;
  artifacts: Record<string, unknown>[];
  compatibilityMatrix: Record<string, unknown>[];
  runtimeLoadPolicy: Record<string, unknown>;
}

interface LoadedPackageRecord {
  readonly key: LoadedPackageKey;
  readonly root: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly entrypoint: string;
  readonly entrypointHash: string;
}

interface VerifiedArtifactRecord {
  readonly artifactId: string;
  readonly status: string;
  readonly artifactHash: string | null;
  readonly schemasHash: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly entrypointHash?: string;
}

/**
 * Validate the controller-owned artifact manifest and the exact loaded Main/Core/Agent entries.
 * All physical paths stay transient; the returned receipt contains only symbols and hashes.
 */
export async function verifyRuntimeArtifactManifestV1(input: {
  readonly expectedManifestContentHash: string;
  readonly expectedManifestHash: string;
  readonly manifestPath: string;
  readonly manifestSymbol: string;
  readonly loadedPackageRoots?: Readonly<Record<LoadedPackageKey, string>>;
}): Promise<RuntimeArtifactVerificationV1> {
  if (
    !path.isAbsolute(input.manifestPath) ||
    !isSha(input.expectedManifestContentHash) ||
    !isSha(input.expectedManifestHash) ||
    input.manifestSymbol !== 'controller:runtime-artifact-manifest'
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_BINDING_INVALID');
  }
  const manifestBytes = await readRegularFile(input.manifestPath);
  if (asSha(hashBytes(manifestBytes)) !== input.expectedManifestContentHash) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_CONTENT_HASH_MISMATCH');
  }
  const manifest = parseManifest(manifestBytes);
  if (manifest.manifestHash !== input.expectedManifestHash) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_HASH_MISMATCH');
  }
  assertManifestContract(manifest);

  const roots = input.loadedPackageRoots ?? (await resolveDefaultLoadedPackageRoots());
  const stateRoot = resolveStateRoot(input.manifestPath, manifest.stateRoot);
  const workspaceRoot = resolveWorkspaceRoot(stateRoot, manifest.stateRoot);
  const rowsById = assertExactArtifactSet(manifest.artifacts);

  const packageArtifacts = await Promise.all(
    PACKAGE_ARTIFACT_IDS.map((artifactId) =>
      verifyPackageArtifact({
        artifactId,
        row: requiredRow(rowsById, artifactId),
        stateRoot,
      })
    )
  );
  const packageRowsByName = new Map(
    packageArtifacts.map((artifact) => [artifact.packageName, artifact] as const)
  );
  const loadedPackages = await verifyLoadedPackages(roots, packageRowsByName);
  await assertSingleCoreResolution(roots);
  assertPackageDependencyContracts(rowsById);

  const contentSetManifest = await verifyContentSetManifest(manifest.contentSetManifest, stateRoot);
  const contentArtifacts = CONTENT_ARTIFACT_IDS.map((artifactId) =>
    verifyContentArtifact(requiredRow(rowsById, artifactId), artifactId, contentSetManifest)
  );
  const dashboard = await verifyDashboard(requiredRow(rowsById, 'dashboard-build'), stateRoot);
  const pcfLineage = await verifyPcfLineage(manifest.pcfLineage, stateRoot, workspaceRoot);
  const compatibilityMatrixHash = assertCompatibilityMatrix(manifest.compatibilityMatrix);

  const loadedByName = new Map(loadedPackages.map((record) => [record.packageName, record]));
  const artifacts: Array<RuntimeArtifactLoadReceiptV1['artifacts'][number]> = [
    ...([...packageArtifacts, ...contentArtifacts] as VerifiedArtifactRecord[]).map((artifact) => {
      const loaded = loadedByName.get(artifact.packageName ?? '');
      return Object.freeze({
        artifactId: artifact.artifactId,
        status: artifact.status,
        artifactHash: artifact.artifactHash,
        ...(artifact.packageName
          ? {
              packageName: artifact.packageName,
              packageVersion: artifact.packageVersion,
              loadedPathSymbol:
                artifact.packageName === 'alembic-runtime'
                  ? 'archive-only:plugin-mcp-package-server'
                  : `loaded:${artifact.packageName}`,
              entrypointHash: loaded?.entrypointHash ?? artifact.entrypointHash,
            }
          : {}),
        schemasHash: artifact.schemasHash,
      });
    }),
    Object.freeze({
      artifactId: 'dashboard-build',
      status: dashboard.status,
      artifactHash: null,
      schemasHash: hashCanonicalJson({
        loadReceipt: 'not-applicable',
        startupDecision: dashboard.startupDecision,
      }),
    }),
  ];
  artifacts.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  const artifactBindings = Object.freeze({
    promptSopEvaluatorBundleHash: requiredArtifactHash(
      requiredRow(rowsById, 'prompt-sop-evaluator-bundle')
    ),
    vectorAdapterHash: requiredArtifactHash(requiredRow(rowsById, 'vector-adapter')),
  });
  const dependencyResolution = Object.freeze({
    singleCoreCopy: true as const,
    loadedPackageSetHash: hashCanonicalJson(
      loadedPackages.map(({ packageName, packageVersion, entrypointHash }) => ({
        entrypointHash,
        packageName,
        packageVersion,
      }))
    ),
    compatibilityMatrixHash,
  });
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'RuntimeArtifactLoadReceiptV1' as const,
    manifestHash: manifest.manifestHash,
    manifestContentHash: asSha(hashBytes(manifestBytes)),
    manifestSymbol: input.manifestSymbol,
    artifacts: Object.freeze(artifacts),
    pcfLineage,
    dashboard,
    dependencyResolution,
    artifactBindings,
  };
  const receipt = Object.freeze({ ...semantic, receiptHash: hashCanonicalJson(semantic) });
  return Object.freeze({ receipt, artifactBindings });
}

async function resolveDefaultLoadedPackageRoots(): Promise<Record<LoadedPackageKey, string>> {
  return {
    main: await fsp.realpath(PACKAGE_ROOT),
    core: await fsp.realpath(path.join(PACKAGE_ROOT, 'node_modules/@alembic/core')),
    agent: await fsp.realpath(path.join(PACKAGE_ROOT, 'node_modules/@alembic/agent')),
  };
}

function parseManifest(bytes: Buffer): RuntimeArtifactManifestV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_INVALID');
  }
  if (!isRecord(value)) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_INVALID');
  }
  return value as RuntimeArtifactManifestV1;
}

function assertManifestContract(manifest: RuntimeArtifactManifestV1): void {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'RuntimeArtifactManifest' ||
    manifest.status !== 'accepted-for-runtime-load-check' ||
    !isSha(manifest.manifestHash) ||
    !safeRelativePath(manifest.stateRoot) ||
    !Array.isArray(manifest.artifacts) ||
    !Array.isArray(manifest.compatibilityMatrix) ||
    !isRecord(manifest.pcfLineage) ||
    !isRecord(manifest.contentSetManifest) ||
    !isRecord(manifest.runtimeLoadPolicy) ||
    manifest.runtimeLoadPolicy.owner !== 'Alembic' ||
    manifest.runtimeLoadPolicy.failureMode !== 'fail-closed-before-target-root-mutation' ||
    manifest.runtimeLoadPolicy.loadReceiptKind !== 'RuntimeArtifactLoadReceiptV1'
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_INVALID');
  }
}

function resolveStateRoot(manifestPath: string, stateRootRef: string): string {
  const stateRoot = path.dirname(path.dirname(path.dirname(path.resolve(manifestPath))));
  if (path.basename(path.dirname(manifestPath)) !== 'controller-runtime-artifact-manifest') {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_PATH_MISMATCH');
  }
  const workspaceRoot = resolveWorkspaceRoot(stateRoot, stateRootRef);
  if (path.resolve(workspaceRoot, stateRootRef) !== stateRoot) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_PATH_MISMATCH');
  }
  return stateRoot;
}

function resolveWorkspaceRoot(stateRoot: string, stateRootRef: string): string {
  return stateRootRef.split(/[\\/]/u).reduce((cursor) => path.dirname(cursor), stateRoot);
}

function assertExactArtifactSet(
  rows: Record<string, unknown>[]
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const artifactId = readText(row.artifactId);
    if (!artifactId || result.has(artifactId)) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_INVALID');
    }
    result.set(artifactId, row);
  }
  if (JSON.stringify([...result.keys()].sort()) !== JSON.stringify(ALL_ARTIFACT_IDS)) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_SET_MISMATCH');
  }
  return result;
}

function requiredRow(
  rows: Map<string, Record<string, unknown>>,
  artifactId: string
): Record<string, unknown> {
  const row = rows.get(artifactId);
  if (!row) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_SET_MISMATCH');
  }
  return row;
}

async function verifyPackageArtifact(input: {
  artifactId: string;
  row: Record<string, unknown>;
  stateRoot: string;
}) {
  const { artifactId, row, stateRoot } = input;
  const packageName = requiredText(row.packageName);
  const packageVersion = requiredText(row.packageVersion);
  const entrypoint = requiredSafePath(row.entrypoint);
  if (
    row.status !== 'required-present' ||
    !isRecord(row.schemas) ||
    Object.keys(row.schemas).length === 0
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_SCHEMA_MISMATCH');
  }
  const archivePath = resolveStateRootRef(stateRoot, requiredText(row.artifactRef));
  const archive = await readRegularFile(archivePath, stateRoot);
  if (
    archive.byteLength !== row.byteSize ||
    hashBytes(archive) !== stripShaPrefix(requiredText(row.artifactSha256))
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_HASH_MISMATCH');
  }
  const tar = readTarFiles(archive);
  const packageJson = parsePackageJson(tar.get('package/package.json'));
  const entryBytes = tar.get(`package/${entrypoint}`);
  if (
    packageJson.name !== packageName ||
    packageJson.version !== packageVersion ||
    (packageJson.main !== entrypoint && !packageJson.bin.includes(entrypoint)) ||
    !entryBytes ||
    hashBytes(entryBytes) !== stripShaPrefix(requiredText(row.entrypointSha256))
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_PACKAGE_MISMATCH');
  }
  return Object.freeze({
    artifactId,
    status: 'required-present',
    artifactHash: asSha(requiredText(row.artifactSha256)),
    packageName,
    packageVersion,
    entrypoint,
    entrypointHash: asSha(requiredText(row.entrypointSha256)),
    schemasHash: hashCanonicalJson(row.schemas),
  });
}

async function verifyLoadedPackages(
  roots: Readonly<Record<LoadedPackageKey, string>>,
  packageRows: ReadonlyMap<string, Awaited<ReturnType<typeof verifyPackageArtifact>>>
): Promise<LoadedPackageRecord[]> {
  const expected: Readonly<Record<LoadedPackageKey, string>> = {
    agent: '@alembic/agent',
    core: '@alembic/core',
    main: 'alembic-ai',
  };
  const records = await Promise.all(
    (Object.keys(expected) as LoadedPackageKey[]).map(async (key) => {
      const root = await fsp.realpath(roots[key]);
      const packageJson = parsePackageJson(
        await readRegularFile(path.join(root, 'package.json'), root)
      );
      const row = packageRows.get(expected[key]);
      if (
        !row ||
        packageJson.name !== row.packageName ||
        packageJson.version !== row.packageVersion
      ) {
        throw new Error('STRICT_RUNTIME_ARTIFACT_LOADED_PACKAGE_MISMATCH');
      }
      const entrypoint = requiredSafePath(packageJson.main);
      if (entrypoint !== row.entrypoint) {
        throw new Error('STRICT_RUNTIME_ARTIFACT_LOADED_PACKAGE_MISMATCH');
      }
      const entrypointHash = asSha(
        hashBytes(await readRegularFile(path.join(root, entrypoint), root))
      );
      if (entrypointHash !== row.entrypointHash) {
        throw new Error('STRICT_RUNTIME_ARTIFACT_STALE_DIST');
      }
      return Object.freeze({
        key,
        root,
        packageName: row.packageName,
        packageVersion: row.packageVersion,
        entrypoint,
        entrypointHash,
      });
    })
  );
  return records.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

async function assertSingleCoreResolution(
  roots: Readonly<Record<LoadedPackageKey, string>>
): Promise<void> {
  const coreRoot = await fsp.realpath(roots.core);
  const agentCore = path.join(roots.agent, 'node_modules/@alembic/core');
  if (existsSync(agentCore) && (await fsp.realpath(agentCore)) !== coreRoot) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_SECOND_COPY');
  }
}

function assertPackageDependencyContracts(rows: Map<string, Record<string, unknown>>): void {
  const core = requiredRow(rows, 'core-package-dist');
  const agent = requiredRow(rows, 'agent-package-dist');
  const main = requiredRow(rows, 'alembic-runtime-release');
  const plugin = requiredRow(rows, 'plugin-mcp-package-server');
  const coreVersion = requiredText(core.packageVersion);
  const agentVersion = requiredText(agent.packageVersion);
  const dependency = readRecord(agent.dependencyContract);
  if (
    agent.dependencyContract !== undefined &&
    (dependency.package !== '@alembic/core' || dependency.version !== coreVersion)
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_DEPENDENCY_MISMATCH');
  }
  if (
    !hasString(main.bundledDependencies, `@alembic/core@${coreVersion}`) ||
    !hasString(main.bundledDependencies, `@alembic/agent@${agentVersion}`) ||
    !hasString(plugin.bundledDependencies, `@alembic/core@${coreVersion}`)
  ) {
    // Compact fixture manifests may omit embedded dependency detail; exact production manifests
    // must carry it whenever any bundledDependencies field is present.
    if (main.bundledDependencies !== undefined || plugin.bundledDependencies !== undefined) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_DEPENDENCY_MISMATCH');
    }
  }
  if (
    main.embeddedCoreDistContentHash !== undefined &&
    main.embeddedCoreDistContentHash !== core.distContentHash
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_DEPENDENCY_MISMATCH');
  }
  if (
    main.embeddedAgentDistContentHash !== undefined &&
    main.embeddedAgentDistContentHash !== agent.distContentHash
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_DEPENDENCY_MISMATCH');
  }
  if (
    plugin.embeddedCoreDistContentHash !== undefined &&
    plugin.embeddedCoreDistContentHash !== core.distContentHash
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_DEPENDENCY_MISMATCH');
  }
}

async function verifyContentSetManifest(
  binding: Record<string, unknown>,
  stateRoot: string
): Promise<Record<string, unknown>> {
  const filePath = resolveStateRootRef(stateRoot, requiredText(binding.ref));
  const bytes = await readRegularFile(filePath, stateRoot);
  if (hashBytes(bytes) !== stripShaPrefix(requiredText(binding.fileSha256))) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_HASH_MISMATCH');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('STRICT_RUNTIME_ARTIFACT_CONTENT_SET_MISMATCH');
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'RuntimeArtifactContentSetManifest' ||
    value.manifestHash !== binding.manifestHash ||
    !Array.isArray(value.contentSets)
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_CONTENT_SET_MISMATCH');
  }
  return value;
}

function verifyContentArtifact(
  row: Record<string, unknown>,
  artifactId: string,
  contentManifest: Record<string, unknown>
) {
  const contentSets = contentManifest.contentSets as unknown[];
  const content = contentSets.find((value) => isRecord(value) && value.artifactId === artifactId);
  if (
    !isRecord(content) ||
    row.status !== 'required-present' ||
    row.byteSize !== content.byteSize ||
    stripShaPrefix(requiredText(row.artifactSha256)) !==
      stripShaPrefix(requiredText(content.contentSetHash)) ||
    !isRecord(row.schemas) ||
    Object.keys(row.schemas).length === 0
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_CONTENT_SET_MISMATCH');
  }
  return Object.freeze({
    artifactId,
    status: 'required-present',
    artifactHash: asSha(requiredText(row.artifactSha256)),
    schemasHash: hashCanonicalJson(row.schemas),
  });
}

async function verifyDashboard(row: Record<string, unknown>, stateRoot: string) {
  if (
    row.status !== 'not-applicable' ||
    row.startupDecision !== 'forbidden' ||
    row.artifactRef !== null ||
    row.artifactSha256 !== null
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_DASHBOARD_MISMATCH');
  }
  const receiptPath = resolveStateRootRef(stateRoot, requiredText(row.triggerDecisionReceiptRef));
  const receiptBytes = await readRegularFile(receiptPath, stateRoot);
  if (
    hashBytes(receiptBytes) !== stripShaPrefix(requiredText(row.triggerDecisionReceiptFileSha256))
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_HASH_MISMATCH');
  }
  const receipt = parseRecord(receiptBytes, 'STRICT_RUNTIME_ARTIFACT_DASHBOARD_MISMATCH');
  if (
    receipt.receiptHash !== row.triggerDecisionReceiptHash ||
    receipt.decision !== 'not-applicable' ||
    readRecord(receipt.runtimeConsequences).dashboardStartup !== 'forbidden'
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_DASHBOARD_MISMATCH');
  }
  return Object.freeze({
    status: 'not-applicable' as const,
    startupDecision: 'forbidden' as const,
    triggerDecisionReceiptHash: requiredText(row.triggerDecisionReceiptHash),
  });
}

async function verifyPcfLineage(
  lineage: Record<string, unknown>,
  stateRoot: string,
  workspaceRoot: string
) {
  const baselinePath = resolveWorkspaceRef(workspaceRoot, requiredText(lineage.baselineReceiptRef));
  const regressionPath = resolveStateRootRef(
    stateRoot,
    requiredText(lineage.finalRegressionReceiptRef)
  );
  const [baseline, regression] = await Promise.all([
    readRegularFile(baselinePath, workspaceRoot),
    readRegularFile(regressionPath, stateRoot),
  ]);
  if (
    hashBytes(baseline) !== stripShaPrefix(requiredText(lineage.baselineReceiptSha256)) ||
    hashBytes(regression) !==
      stripShaPrefix(requiredText(lineage.finalRegressionReceiptFileSha256)) ||
    lineage.lineageResult !== 'unchanged'
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_PCF_LINEAGE_MISMATCH');
  }
  const regressionReceipt = parseRecord(regression, 'STRICT_RUNTIME_ARTIFACT_PCF_LINEAGE_MISMATCH');
  if (
    regressionReceipt.receiptHash !== lineage.finalRegressionReceiptHash ||
    regressionReceipt.verdict !== 'passed'
  ) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_PCF_LINEAGE_MISMATCH');
  }
  return Object.freeze({
    baselineReceiptHash: asSha(requiredText(lineage.baselineReceiptSha256)),
    finalRegressionReceiptHash: requiredText(lineage.finalRegressionReceiptHash),
    lineageResult: 'unchanged',
  });
}

function assertCompatibilityMatrix(rows: Record<string, unknown>[]): string {
  const allowed = new Set([
    'passed',
    'passed-artifact-presence',
    'artifact-compatible-runtime-config-pending',
    'not-applicable',
  ]);
  const ids = new Set<string>();
  for (const row of rows) {
    const compatibilityId = readText(row.compatibilityId);
    const status = readText(row.status);
    if (!compatibilityId || ids.has(compatibilityId) || !status || !allowed.has(status)) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_COMPATIBILITY_MISMATCH');
    }
    ids.add(compatibilityId);
    if (
      status === 'not-applicable' &&
      row.compatibilityId === 'dashboard-build' &&
      row.startupDecision !== 'forbidden'
    ) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_COMPATIBILITY_MISMATCH');
    }
    if (row.expected !== undefined && row.expected !== row.actual) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_COMPATIBILITY_MISMATCH');
    }
  }
  for (const required of ['pcf-final-contract', 'vector-three-owner', 'dashboard-build']) {
    if (!ids.has(required)) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_COMPATIBILITY_MISMATCH');
    }
  }
  return hashCanonicalJson(rows);
}

function resolveStateRootRef(stateRoot: string, ref: string): string {
  const [fileRef] = ref.split('#', 1);
  if (!fileRef || !safeRelativePath(fileRef) || !fileRef.startsWith('evidence/')) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_REFERENCE_INVALID');
  }
  const resolved = path.resolve(stateRoot, fileRef);
  if (!resolved.startsWith(`${stateRoot}${path.sep}`)) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_REFERENCE_INVALID');
  }
  return resolved;
}

function resolveWorkspaceRef(workspaceRoot: string, ref: string): string {
  if (!safeRelativePath(ref) || !ref.startsWith('wakeflow-ledger/')) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_REFERENCE_INVALID');
  }
  const resolved = path.resolve(workspaceRoot, ref);
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_REFERENCE_INVALID');
  }
  return resolved;
}

async function readRegularFile(filePath: string, allowedRoot?: string): Promise<Buffer> {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_REFERENCE_INVALID');
  }
  if (allowedRoot) {
    const [physicalFile, physicalRoot] = await Promise.all([
      fsp.realpath(filePath),
      fsp.realpath(allowedRoot),
    ]);
    if (!physicalFile.startsWith(`${physicalRoot}${path.sep}`)) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_REFERENCE_INVALID');
    }
  }
  return fsp.readFile(filePath);
}

function readTarFiles(archive: Buffer): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new Error('STRICT_RUNTIME_ARTIFACT_PACKAGE_MISMATCH');
  }
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = nullTerminated(header.subarray(0, 100));
    const prefix = nullTerminated(header.subarray(345, 500));
    const size = Number.parseInt(nullTerminated(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_PACKAGE_MISMATCH');
    }
    const fileName = prefix ? `${prefix}/${name}` : name;
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.byteLength) {
      throw new Error('STRICT_RUNTIME_ARTIFACT_PACKAGE_MISMATCH');
    }
    if (header[156] === 0x30 || header[156] === 0) {
      files.set(fileName, Buffer.from(tar.subarray(contentStart, contentEnd)));
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function nullTerminated(value: Buffer): string {
  const terminator = value.indexOf(0);
  return value.subarray(0, terminator === -1 ? value.length : terminator).toString('utf8');
}

function parsePackageJson(bytes: Buffer | undefined): {
  name: string;
  version: string;
  main: string;
  bin: string[];
} {
  if (!bytes) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_PACKAGE_MISMATCH');
  }
  const value = parseRecord(bytes, 'STRICT_RUNTIME_ARTIFACT_PACKAGE_MISMATCH');
  return {
    name: requiredText(value.name),
    version: requiredText(value.version),
    main: requiredSafePath(value.main),
    bin: Object.values(readRecord(value.bin)).map(requiredSafePath),
  };
}

function parseRecord(bytes: Buffer, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Normalized below.
  }
  throw new Error(code);
}

function requiredArtifactHash(row: Record<string, unknown>): string {
  return asSha(requiredText(row.artifactSha256));
}

function safeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).some((segment) => segment === '' || segment === '..')
  );
}

function requiredSafePath(value: unknown): string {
  if (!safeRelativePath(value)) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_REFERENCE_INVALID');
  }
  return value;
}

function requiredText(value: unknown): string {
  const result = readText(value);
  if (!result) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_MANIFEST_INVALID');
  }
  return result;
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

function hasString(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function stripShaPrefix(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

function asSha(value: string): string {
  const digest = stripShaPrefix(value);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('STRICT_RUNTIME_ARTIFACT_HASH_INVALID');
  }
  return `sha256:${digest}`;
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
