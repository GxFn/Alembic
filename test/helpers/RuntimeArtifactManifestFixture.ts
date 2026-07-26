import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';

type LoadedPackageRoots = Readonly<{
  agent: string;
  core: string;
  main: string;
}>;

type EmbeddedPackageRoots = Readonly<
  Partial<Record<'mainAgent' | 'mainCore' | 'pluginCore', string>>
>;

type LoadedPackageFixture = Readonly<{
  key: keyof LoadedPackageRoots;
  packageRoot: string;
  name: string;
  version: string;
  entrypoint: string;
  entry: Buffer;
  distFiles: ReadonlyMap<string, Buffer>;
}>;

interface RuntimeArtifactFixtureManifest extends Record<string, unknown> {
  manifestHash: string;
  compatibilityMatrix: Array<Record<string, unknown>>;
}

const SYNTHETIC_EVIDENCE_BOUNDARY = Object.freeze({
  classification: 'synthetic-runtime-load-fixture',
  exactPluginArtifact: false,
  crossRepositoryAcceptance: 'forbidden',
} as const);

export async function createRuntimeArtifactManifestFixture(input: {
  readonly root: string;
  readonly loadedPackageRoots: LoadedPackageRoots;
  readonly embeddedPackageRoots?: EmbeddedPackageRoots;
}) {
  const { embeddedPackageRoots = {}, loadedPackageRoots, root } = input;
  const evidenceRoot = path.join(
    root,
    '.wakeflow-active/current/demand/evidence/controller-runtime-artifact-manifest'
  );
  const artifactsRoot = path.join(evidenceRoot, 'artifacts');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const loaded = await loadPackageFixtures(loadedPackageRoots);
  const byKey = new Map(loaded.map((row) => [row.key, row] as const));
  const embeddedDistFiles = await loadEmbeddedPackageFixtures(embeddedPackageRoots);
  const { coreArtifactPath, packageRows } = await writeRuntimePackageArtifacts({
    artifactsRoot,
    byKey,
    embeddedDistFiles,
  });
  const evidence = await writeRuntimeEvidenceReceipts(root, evidenceRoot);
  const manifest = createRuntimeArtifactFixtureManifest(packageRows, evidence);
  manifest.manifestHash = semanticHash(manifest, 'manifestHash');
  const manifestPath = path.join(evidenceRoot, 'runtime-artifact-manifest.json');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await fs.writeFile(manifestPath, manifestBytes);
  return {
    coreArtifactPath,
    // 该 helper 只证明 Main 的隔离 runtime-load/fail-closed 行为；其中 plugin-entry
    // 是合成占位，严禁作为 AlembicPlugin 发布包或跨仓 PC-F 验收证据。
    evidenceBoundary: SYNTHETIC_EVIDENCE_BOUNDARY,
    loadedPackageRoots,
    manifest,
    manifestContentHash: `sha256:${hashBytes(manifestBytes)}`,
    manifestPath,
    root,
  };
}

async function loadPackageFixtures(
  loadedPackageRoots: LoadedPackageRoots
): Promise<LoadedPackageFixture[]> {
  return Promise.all(
    (Object.entries(loadedPackageRoots) as Array<[keyof LoadedPackageRoots, string]>).map(
      async ([key, packageRoot]) => {
        const pkg = JSON.parse(
          await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')
        ) as {
          name: string;
          version: string;
          main: string;
        };
        return {
          key,
          packageRoot,
          name: pkg.name,
          version: pkg.version,
          entrypoint: pkg.main,
          entry: await fs.readFile(path.join(packageRoot, pkg.main)),
          distFiles: await readRegularTree(path.join(packageRoot, 'dist')),
        };
      }
    )
  );
}

async function loadEmbeddedPackageFixtures(
  embeddedPackageRoots: EmbeddedPackageRoots
): Promise<Map<'mainAgent' | 'mainCore' | 'pluginCore', Map<string, Buffer>>> {
  return new Map(
    await Promise.all(
      (
        Object.entries(embeddedPackageRoots) as Array<
          ['mainAgent' | 'mainCore' | 'pluginCore', string]
        >
      ).map(
        async ([key, packageRoot]) =>
          [key, await readRegularTree(path.join(packageRoot, 'dist'))] as const
      )
    )
  );
}

async function writeRuntimePackageArtifacts(input: {
  readonly artifactsRoot: string;
  readonly byKey: ReadonlyMap<keyof LoadedPackageRoots, LoadedPackageFixture>;
  readonly embeddedDistFiles: ReadonlyMap<
    'mainAgent' | 'mainCore' | 'pluginCore',
    ReadonlyMap<string, Buffer>
  >;
}): Promise<{
  coreArtifactPath: string;
  packageRows: Array<Record<string, unknown>>;
}> {
  const packageRows: Array<Record<string, unknown>> = [];
  let coreArtifactPath = '';
  for (const spec of [
    ['core-package-dist', 'core', 'alembic-core-0.3.0.tgz'],
    ['agent-package-dist', 'agent', 'alembic-agent-0.3.0.tgz'],
    ['alembic-runtime-release', 'main', 'alembic-ai-0.3.0.tgz'],
  ] as const) {
    const [artifactId, key, file] = spec;
    const source = input.byKey.get(key);
    if (!source) {
      throw new Error(`missing loaded package fixture:${key}`);
    }
    const embedded =
      key === 'main'
        ? [
            ...prefixedFiles(
              'node_modules/@alembic/core',
              input.embeddedDistFiles.get('mainCore') ??
                input.byKey.get('core')?.distFiles ??
                new Map()
            ),
            ...prefixedFiles(
              'node_modules/@alembic/agent',
              input.embeddedDistFiles.get('mainAgent') ??
                input.byKey.get('agent')?.distFiles ??
                new Map()
            ),
          ]
        : [];
    const bytes = createPackageTgz(
      source.name,
      source.version,
      source.entrypoint,
      source.distFiles,
      embedded
    );
    const artifactPath = path.join(input.artifactsRoot, file);
    await fs.writeFile(artifactPath, bytes);
    if (artifactId === 'core-package-dist') {
      coreArtifactPath = artifactPath;
    }
    packageRows.push(createLoadedPackageManifestRow(artifactId, file, source, bytes, input.byKey));
  }
  packageRows.push(await writeSyntheticPluginArtifact(input));
  return { coreArtifactPath, packageRows };
}

function createLoadedPackageManifestRow(
  artifactId: 'core-package-dist' | 'agent-package-dist' | 'alembic-runtime-release',
  file: string,
  source: LoadedPackageFixture,
  bytes: Buffer,
  byKey: ReadonlyMap<keyof LoadedPackageRoots, LoadedPackageFixture>
): Record<string, unknown> {
  return {
    artifactId,
    status: 'required-present',
    packageName: source.name,
    packageVersion: source.version,
    artifactRef: `evidence/controller-runtime-artifact-manifest/artifacts/${file}`,
    artifactSha256: hashBytes(bytes),
    byteSize: bytes.byteLength,
    entrypoint: source.entrypoint,
    entrypointSha256: hashBytes(source.entry),
    distContentHash: hashDistContent(source.distFiles),
    ...(artifactId === 'agent-package-dist'
      ? { dependencyContract: { package: '@alembic/core', version: byKey.get('core')?.version } }
      : {}),
    ...(artifactId === 'alembic-runtime-release'
      ? {
          bundledDependencies: ['@alembic/core@0.3.0', '@alembic/agent@0.3.0'],
          embeddedCoreDistContentHash: hashDistContent(byKey.get('core')?.distFiles ?? new Map()),
          embeddedAgentDistContentHash: hashDistContent(byKey.get('agent')?.distFiles ?? new Map()),
        }
      : {}),
    schemas: { package: source.version },
  };
}

async function writeSyntheticPluginArtifact(input: {
  readonly artifactsRoot: string;
  readonly byKey: ReadonlyMap<keyof LoadedPackageRoots, LoadedPackageFixture>;
  readonly embeddedDistFiles: ReadonlyMap<
    'mainAgent' | 'mainCore' | 'pluginCore',
    ReadonlyMap<string, Buffer>
  >;
}): Promise<Record<string, unknown>> {
  const pluginDistFiles = new Map([['index.js', Buffer.from('plugin-entry')]]);
  const pluginBytes = createPackageTgz(
    'alembic-runtime',
    '0.3.0',
    'dist/index.js',
    pluginDistFiles,
    [
      ...prefixedFiles(
        'node_modules/@alembic/core',
        input.embeddedDistFiles.get('pluginCore') ?? input.byKey.get('core')?.distFiles ?? new Map()
      ),
    ]
  );
  await fs.writeFile(path.join(input.artifactsRoot, 'alembic-runtime-0.3.0.tgz'), pluginBytes);
  return {
    artifactId: 'plugin-mcp-package-server',
    status: 'required-present',
    packageName: 'alembic-runtime',
    packageVersion: '0.3.0',
    artifactRef:
      'evidence/controller-runtime-artifact-manifest/artifacts/alembic-runtime-0.3.0.tgz',
    artifactSha256: hashBytes(pluginBytes),
    byteSize: pluginBytes.byteLength,
    entrypoint: 'dist/index.js',
    entrypointSha256: hashBytes(Buffer.from('plugin-entry')),
    distContentHash: hashDistContent(pluginDistFiles),
    bundledDependencies: ['@alembic/core@0.3.0'],
    embeddedCoreDistContentHash: hashDistContent(input.byKey.get('core')?.distFiles ?? new Map()),
    schemas: { package: '0.3.0' },
  };
}

async function writeRuntimeEvidenceReceipts(root: string, evidenceRoot: string) {
  const contentSets = [
    'prompt-sop-evaluator-bundle',
    'fact-query-pack-code-fact-backends',
    'migration-bundle',
    'vector-adapter',
  ].map((artifactId) => ({
    artifactId,
    byteSize: artifactId.length,
    contentSetHash: hashCanonicalJson(artifactId),
  }));
  const contentSetManifest: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'RuntimeArtifactContentSetManifest',
    contentSets,
    manifestHash: '',
  };
  contentSetManifest.manifestHash = semanticHash(contentSetManifest, 'manifestHash');
  const contentSetBytes = Buffer.from(`${JSON.stringify(contentSetManifest)}\n`);
  await fs.writeFile(
    path.join(evidenceRoot, 'artifact-content-set-manifest.json'),
    contentSetBytes
  );
  const dashboardReceipt = selfHashed('receiptHash', {
    schemaVersion: 1,
    kind: 'DashboardTriggerDecisionReceipt',
    decision: 'not-applicable',
    runtimeConsequences: { dashboardStartup: 'forbidden' },
  });
  const dashboardBytes = Buffer.from(`${JSON.stringify(dashboardReceipt)}\n`);
  await fs.writeFile(
    path.join(evidenceRoot, 'dashboard-trigger-decision-receipt.json'),
    dashboardBytes
  );
  const regressionReceipt = selfHashed('receiptHash', {
    schemaVersion: 1,
    kind: 'FinalArtifactPCFRegressionReceipt',
    verdict: 'passed',
  });
  const regressionBytes = Buffer.from(`${JSON.stringify(regressionReceipt)}\n`);
  await fs.writeFile(
    path.join(evidenceRoot, 'final-artifact-pcf-regression-receipt.json'),
    regressionBytes
  );
  const baselineBytes = Buffer.from('{}\n');
  const baselinePath = path.join(root, 'wakeflow-ledger/AlembicWorkspace/demand/pcf.json');
  await fs.mkdir(path.dirname(baselinePath), { recursive: true });
  await fs.writeFile(baselinePath, baselineBytes);
  return {
    baselineBytes,
    contentSetBytes,
    contentSetManifest,
    contentSets,
    dashboardBytes,
    dashboardReceipt,
    regressionBytes,
    regressionReceipt,
  };
}

function createRuntimeArtifactFixtureManifest(
  packageRows: Array<Record<string, unknown>>,
  evidence: Awaited<ReturnType<typeof writeRuntimeEvidenceReceipts>>
): RuntimeArtifactFixtureManifest {
  return {
    schemaVersion: 1,
    kind: 'RuntimeArtifactManifest',
    manifestId: 'runtime-artifact-manifest-fixture',
    demandKey: 'demand',
    stateRoot: '.wakeflow-active/current/demand',
    status: 'accepted-for-runtime-load-check',
    pcfLineage: {
      baselineReceiptRef: 'wakeflow-ledger/AlembicWorkspace/demand/pcf.json',
      baselineReceiptSha256: hashBytes(evidence.baselineBytes),
      finalRegressionReceiptRef:
        'evidence/controller-runtime-artifact-manifest/final-artifact-pcf-regression-receipt.json',
      finalRegressionReceiptFileSha256: hashBytes(evidence.regressionBytes),
      finalRegressionReceiptHash: evidence.regressionReceipt.receiptHash,
      lineageResult: 'unchanged',
    },
    contentSetManifest: {
      ref: 'evidence/controller-runtime-artifact-manifest/artifact-content-set-manifest.json',
      fileSha256: hashBytes(evidence.contentSetBytes),
      manifestHash: evidence.contentSetManifest.manifestHash,
    },
    artifacts: [
      ...packageRows,
      ...evidence.contentSets.map((row) => ({
        artifactId: row.artifactId,
        status: 'required-present',
        provider: 'source-bound-content-set',
        artifactRef: `evidence/controller-runtime-artifact-manifest/artifact-content-set-manifest.json#${row.artifactId}`,
        artifactSha256: row.contentSetHash.replace('sha256:', ''),
        byteSize: row.byteSize,
        schemas: { version: 1 },
      })),
      {
        artifactId: 'dashboard-build',
        status: 'not-applicable',
        artifactRef: null,
        artifactSha256: null,
        byteSize: null,
        compatibility: 'not-applicable',
        loadReceipt: 'not-applicable',
        startupDecision: 'forbidden',
        triggerDecisionReceiptRef:
          'evidence/controller-runtime-artifact-manifest/dashboard-trigger-decision-receipt.json',
        triggerDecisionReceiptFileSha256: hashBytes(evidence.dashboardBytes),
        triggerDecisionReceiptHash: evidence.dashboardReceipt.receiptHash,
      },
    ],
    compatibilityMatrix: [
      { compatibilityId: 'pcf-final-contract', status: 'passed' },
      {
        compatibilityId: 'vector-three-owner',
        status: 'artifact-compatible-runtime-config-pending',
      },
      {
        compatibilityId: 'dashboard-build',
        status: 'not-applicable',
        startupDecision: 'forbidden',
      },
    ],
    runtimeLoadPolicy: {
      owner: 'Alembic',
      failureMode: 'fail-closed-before-target-root-mutation',
      loadReceiptKind: 'RuntimeArtifactLoadReceiptV1',
    },
    manifestHash: '',
  };
}

export async function materializeLoadedPackageFixture(
  root: string,
  name: string,
  entry: string,
  entrypoint = 'dist/index.js'
): Promise<void> {
  await fs.mkdir(path.join(root, path.dirname(entrypoint)), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name, version: '0.3.0', main: entrypoint })}\n`
  );
  await fs.writeFile(path.join(root, entrypoint), entry);
  const secondaryPath = path.join(root, 'dist/internal/secondary.js');
  await fs.mkdir(path.dirname(secondaryPath), { recursive: true });
  await fs.writeFile(secondaryPath, `${name}-secondary\n`);
}

export function semanticHash(value: Record<string, unknown>, key: string): string {
  const { [key]: _omitted, ...semantic } = value;
  return hashCanonicalJson(semantic);
}

function createPackageTgz(
  name: string,
  version: string,
  entrypoint: string,
  distFiles: ReadonlyMap<string, Buffer>,
  additionalFiles: readonly (readonly [string, Buffer])[] = []
): Buffer {
  const packageJson = Buffer.from(`${JSON.stringify({ name, version, main: entrypoint })}\n`);
  const files: Array<readonly [string, Buffer]> = [
    ['package/package.json', packageJson],
    ...[...distFiles.entries()].map(
      ([relativePath, bytes]) => [`package/dist/${relativePath}`, bytes] as const
    ),
    ...additionalFiles.map(([relativePath, bytes]) => [`package/${relativePath}`, bytes] as const),
  ];
  files.sort(([left], [right]) => left.localeCompare(right));
  return gzipSync(
    Buffer.concat([...files.map(([file, bytes]) => tarEntry(file, bytes)), Buffer.alloc(1024)])
  );
}

function tarEntry(name: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(512);
  const { entryName, prefix } = splitTarPath(name);
  header.write(entryName, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${bytes.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512)]);
}

async function readRegularTree(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  async function visit(directory: string, relativeRoot: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(filePath, relativePath);
      } else if (entry.isFile()) {
        result.set(relativePath, await fs.readFile(filePath));
      } else {
        throw new Error(`unsupported loaded package fixture entry:${relativePath}`);
      }
    }
  }
  await visit(root, '');
  return result;
}

function prefixedFiles(
  prefix: string,
  files: ReadonlyMap<string, Buffer>
): Array<readonly [string, Buffer]> {
  return [...files.entries()].map(
    ([relativePath, bytes]) => [`${prefix}/dist/${relativePath}`, bytes] as const
  );
}

function hashDistContent(files: ReadonlyMap<string, Buffer>): string {
  const rows = [...files.entries()].map(
    ([relativePath, bytes]) => `${relativePath} ${hashBytes(bytes)}\n`
  );
  rows.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return `sha256:${hashBytes(Buffer.from(rows.join('')))}`;
}

function splitTarPath(value: string): { entryName: string; prefix: string } {
  if (Buffer.byteLength(value, 'utf8') <= 100) {
    return { entryName: value, prefix: '' };
  }
  for (let index = value.lastIndexOf('/'); index > 0; index = value.lastIndexOf('/', index - 1)) {
    const prefix = value.slice(0, index);
    const entryName = value.slice(index + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(entryName, 'utf8') <= 100) {
      return { entryName, prefix };
    }
  }
  throw new Error(`fixture tar path is too long:${value}`);
}

function selfHashed<T extends Record<string, unknown>, K extends string>(
  key: K,
  semantic: T
): T & Record<K, string> {
  return { ...semantic, [key]: hashCanonicalJson(semantic) } as T & Record<K, string>;
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
