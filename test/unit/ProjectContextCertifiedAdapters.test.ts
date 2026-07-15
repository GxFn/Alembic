import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GenerateSessionManager } from '@alembic/core/host-agent-workflows';
import {
  type CertifiedProjectFactsArtifactV1,
  FileCertifiedProjectFactsStore,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertMainCertifiedProjectFactsCarrier,
  buildStrictProjectContextWorkflowFacts,
  captureMainCertifiedProjectFacts,
  MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS,
  type MainCertifiedProjectFactsCarrier,
  projectMainCertifiedConsumerPayload,
  qualifyMainCertifiedPath,
  readMainCertifiedCarrierFromProjectContext,
  reopenMainCertifiedProjectFactsConsumer,
  serializeMainCertifiedProjectFactsCarrier,
  summarizeMainCertifiedInstrumentation,
} from '../../lib/project-facts/CertifiedProjectFactsRuntime.js';
import { prepareAiDimensionPipeline } from '../../lib/recipe-pipeline/generate/execution/AiDimensionPreparation.js';
import {
  createModuleCertifiedFactsSessionBoundary,
  ModuleService,
} from '../../lib/service/module/ModuleService.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe('Alembic Main strict-v2 ProjectContext adapters', () => {
  test('keeps the persisted session carrier bounded after real >12-file projection', async () => {
    const fixture = await captureSingleRepository(13);
    for (const consumer of Object.keys(MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS) as Array<
      keyof typeof MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS
    >) {
      await reopenMainCertifiedProjectFactsConsumer({
        carrier: fixture.certified,
        consumer,
        dataRoot: fixture.dataRoot,
        entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS[consumer],
      });
    }
    const serialized = JSON.stringify(serializeMainCertifiedProjectFactsCarrier(fixture.certified));

    expect(serialized).not.toContain('contentBase64');
    expect(serialized).not.toContain('projections');
    expect(Buffer.byteLength(serialized)).toBeLessThan(32 * 1024);
  }, 60_000);

  test('records distinct canonical receipts at the four actual production entrypoints', async () => {
    const fixture = await captureSingleRepository(2);
    for (const consumer of Object.keys(MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS) as Array<
      keyof typeof MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS
    >) {
      const before = fixture.certified.receipts[consumer];
      expect(before).toBeUndefined();
      await reopenMainCertifiedProjectFactsConsumer({
        carrier: fixture.certified,
        consumer,
        dataRoot: fixture.dataRoot,
        entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS[consumer],
        runId: `test-${consumer}`,
      });
    }

    const receipts = Object.values(fixture.certified.receipts);
    expect(
      Object.fromEntries(receipts.map((receipt) => [receipt?.consumer, receipt?.entrypoint]))
    ).toEqual(MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS);
    expect(new Set(receipts.map((receipt) => receipt?.receiptHash))).toHaveLength(4);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        artifactId: fixture.certified.artifactId,
        certificationBindingHash: fixture.certified.certificationBindingHash,
        factsContentHash: fixture.certified.factsContentHash,
        sourceVectorHash: fixture.certified.sourceVectorHash,
      });
    }
    expect(
      fixture.certified.instrumentation
        .filter((event) => event.kind === 'consumer-reopen')
        .map((event) => [event.consumer, event.entrypoint])
    ).toEqual(
      Object.entries(MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    );
    expect(fixture.certified.instrumentation.some((event) => event.kind === 'legacy-route')).toBe(
      false
    );
    expect(fixture.certified.counters).toEqual({
      cappedModuleProjectionCount: 0,
      directProjectContextCallCount: 0,
      rawFilesystemFallbackCount: 0,
      synthesizedProjectScopeFactCount: 0,
    });
  }, 60_000);

  test('rebinds ModuleService from legacy to certified and rejects certified-to-legacy drift', async () => {
    const fixture = await captureSingleRepository(2);
    let current: MainCertifiedProjectFactsCarrier | null = null;
    const service = new ModuleService(fixture.projectRoot, {
      certifiedFactsPersister: (carrier) => {
        current = serializeMainCertifiedProjectFactsCarrier(carrier);
      },
      certifiedFactsProvider: () => current,
      controlRoot: fixture.projectRoot,
      dataRoot: fixture.dataRoot,
    });

    await service.listTargets();
    current = fixture.certified;
    const certifiedTargets = await service.listTargets();
    expect(certifiedTargets[0]).toMatchObject({
      info: { artifactId: fixture.certified.artifactId },
      type: 'certified-module',
    });

    const addedFile = path.join(fixture.projectRoot, 'src', 'added.ts');
    await writeFile(addedFile, 'export const added = true;\n');
    const changed = await captureMainCertifiedProjectFacts({
      analysisScope: {
        controlRoot: null,
        currentFolderId: null,
        dataRoot: fixture.dataRoot,
        folderCount: 0,
        projectRoot: fixture.projectRoot,
        projectScope: null,
        projectScopeId: null,
      },
      dimensions: dimensions(),
      projectRoot: fixture.projectRoot,
      source: 'alembic-main-bootstrap',
    });
    current = changed;
    expect(await service.listTargets()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          info: expect.objectContaining({ artifactId: changed.artifactId }),
        }),
      ])
    );

    current = null;
    await expect(service.listTargets()).rejects.toThrow(/forbidden raw-filesystem route/i);
    expect(changed.counters.rawFilesystemFallbackCount).toBe(1);
  }, 60_000);

  test('uses ProjectScope relativeRoot when projecting real source paths', async () => {
    const root = await makeTemporaryRoot('alembic-main-relative-root-');
    const controlRoot = path.join(root, 'control');
    const projectRoot = path.join(controlRoot, 'Packages', 'Member');
    const dataRoot = path.join(root, 'data');
    const sourceFile = path.join(projectRoot, 'Sources', 'Member', 'Feature.swift');
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(sourceFile, 'public struct Feature {}\n');
    const folder = projectScopeFolder('member-folder', 'opaque-member-id', projectRoot);
    const certified = await captureMainCertifiedProjectFacts({
      analysisScope: analysisScope(controlRoot, dataRoot, projectRoot, [folder]),
      dimensions: dimensions(),
      projectRoot,
      source: 'alembic-main-bootstrap',
    });
    const recipe = await reopenMainCertifiedProjectFactsConsumer({
      carrier: certified,
      consumer: 'recipe-generation',
      dataRoot,
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['recipe-generation'],
    });
    const facts = buildStrictProjectContextWorkflowFacts({
      certified,
      controlRoot,
      dimensions: dimensions(),
      projection: recipe.projection,
      projectRoot,
      source: 'alembic-main-bootstrap',
    });
    const projected = facts.allFiles.find((file) => file.name === 'Feature.swift');

    expect(projected?.relativePath).toBe('Packages/Member/Sources/Member/Feature.swift');
    expect(projected?.path).toBe(sourceFile);
    await expect(readFile(projected?.path ?? '', 'utf8')).resolves.toContain('Feature');
  }, 60_000);

  test('fresh session reload reopens frozen module files after the live source tree is deleted', async () => {
    const fixture = await captureSingleRepository(2);
    const recipe = await reopenMainCertifiedProjectFactsConsumer({
      carrier: fixture.certified,
      consumer: 'recipe-generation',
      dataRoot: fixture.dataRoot,
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['recipe-generation'],
    });
    const facts = buildStrictProjectContextWorkflowFacts({
      certified: fixture.certified,
      controlRoot: fixture.projectRoot,
      dimensions: dimensions(),
      projection: recipe.projection,
      projectRoot: fixture.projectRoot,
      source: 'alembic-main-bootstrap',
    });
    const firstManager = new GenerateSessionManager({ dataRoot: fixture.dataRoot });
    const session = firstManager.createSession({
      dimensions: facts.dimensions,
      projectContext: {
        certifiedProjectFacts: serializeMainCertifiedProjectFactsCarrier(fixture.certified),
      },
      projectRoot: fixture.projectRoot,
    });
    const freshManager = new GenerateSessionManager({ dataRoot: fixture.dataRoot });
    const reopenedCarrier = readMainCertifiedCarrierFromProjectContext(
      freshManager.getAnySession(session.id, { projectRoot: fixture.projectRoot })?.toSnapshot()
        .projectContext
    );
    expect(reopenedCarrier).not.toBeNull();

    await rm(fixture.projectRoot, { force: true, recursive: true });
    const service = new ModuleService(fixture.projectRoot, {
      certifiedFactsPersister: (carrier) => {
        const current = freshManager.getAnySession(session.id, {
          projectRoot: fixture.projectRoot,
        });
        if (!current) {
          throw new Error('Expected the fresh Generate session during module persistence.');
        }
        current.replaceProjectContext({
          ...current.toSnapshot().projectContext,
          certifiedProjectFacts: serializeMainCertifiedProjectFactsCarrier(carrier),
        });
      },
      certifiedFactsProvider: () => reopenedCarrier,
      controlRoot: fixture.projectRoot,
      dataRoot: fixture.dataRoot,
    });
    const targets = await service.listTargets();
    expect(targets).not.toHaveLength(0);
    await expect(
      service.getTargetFiles(targets[0] as Record<string, unknown>)
    ).resolves.toHaveLength(2);
    await expect(service.getDependencyGraph()).resolves.toMatchObject({
      edges: expect.any(Array),
      nodes: expect.any(Array),
    });
  }, 60_000);

  test('persists four actual-entrypoint receipts through one session and fresh reloads', async () => {
    const fixture = await captureSingleRepository(2);
    await reopenMainCertifiedProjectFactsConsumer({
      carrier: fixture.certified,
      consumer: 'plan',
      dataRoot: fixture.dataRoot,
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS.plan,
    });
    const recipe = await reopenMainCertifiedProjectFactsConsumer({
      carrier: fixture.certified,
      consumer: 'recipe-generation',
      dataRoot: fixture.dataRoot,
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['recipe-generation'],
    });
    const facts = buildStrictProjectContextWorkflowFacts({
      certified: fixture.certified,
      controlRoot: fixture.projectRoot,
      dimensions: dimensions(),
      projection: recipe.projection,
      projectRoot: fixture.projectRoot,
      source: 'alembic-main-bootstrap',
    });
    const sessionManager = new GenerateSessionManager({ dataRoot: fixture.dataRoot });
    const session = sessionManager.createSession({
      dimensions: facts.dimensions,
      projectContext: {
        certifiedProjectFacts: serializeMainCertifiedProjectFactsCarrier(fixture.certified),
      },
      projectRoot: fixture.projectRoot,
    });

    const afterRecipeManager = new GenerateSessionManager({ dataRoot: fixture.dataRoot });
    expect(
      receiptConsumers(readSessionCarrier(afterRecipeManager, session.id, fixture.projectRoot))
    ).toEqual(['plan', 'recipe-generation']);

    const container = {
      singletons: {
        _workspaceResolver: {
          currentFolderId: null,
          dataRoot: fixture.dataRoot,
          projectRoot: fixture.projectRoot,
          projectScope: null,
        },
      },
      get(name: string) {
        if (name === 'generateSessionManager') {
          return afterRecipeManager;
        }
        throw new Error(`missing test service: ${name}`);
      },
    };
    await prepareAiDimensionPipeline(
      {
        bootstrapSession: null,
        ctx: { container },
        projectContextFacts: facts,
        projectRoot: fixture.projectRoot,
        targetFileMap: facts.filesByTarget,
      } as never,
      facts.dimensions
    );

    const afterDependencyManager = new GenerateSessionManager({ dataRoot: fixture.dataRoot });
    expect(
      receiptConsumers(readSessionCarrier(afterDependencyManager, session.id, fixture.projectRoot))
    ).toEqual(['dependency-graph', 'plan', 'recipe-generation']);

    const moduleService = new ModuleService(fixture.projectRoot, {
      ...createModuleCertifiedFactsSessionBoundary({
        projectRoot: fixture.projectRoot,
        sessionProvider: () =>
          afterDependencyManager.getAnySession(session.id, {
            projectRoot: fixture.projectRoot,
          }),
      }),
      controlRoot: fixture.projectRoot,
      dataRoot: fixture.dataRoot,
    });
    await moduleService.listTargets();

    const afterModuleManager = new GenerateSessionManager({ dataRoot: fixture.dataRoot });
    const completed = readSessionCarrier(afterModuleManager, session.id, fixture.projectRoot);
    expect(receiptConsumers(completed)).toEqual([
      'dependency-graph',
      'module-coverage',
      'plan',
      'recipe-generation',
    ]);
    expect(completed).toMatchObject({
      artifactId: fixture.certified.artifactId,
      canonicalScopeHash: fixture.certified.canonicalScopeHash,
      certificationBindingHash: fixture.certified.certificationBindingHash,
      counters: {
        cappedModuleProjectionCount: 0,
        directProjectContextCallCount: 0,
        rawFilesystemFallbackCount: 0,
        synthesizedProjectScopeFactCount: 0,
      },
      factsContentHash: fixture.certified.factsContentHash,
      sourceVectorHash: fixture.certified.sourceVectorHash,
    });
    expect(
      completed.instrumentation
        .filter((event) => event.kind === 'consumer-reopen')
        .map((event) => event.consumer)
        .sort()
    ).toEqual(['dependency-graph', 'module-coverage', 'plan', 'recipe-generation']);
    expect(
      completed.instrumentation.filter((event) => event.kind === 'module-projection')
    ).toHaveLength(1);
    const serialized = JSON.stringify(completed);
    expect(serialized).not.toContain('contentBase64');
    expect(Buffer.byteLength(serialized)).toBeLessThan(32 * 1024);
  }, 60_000);

  test('conserves 81 real owned modules without empty or capped projections', async () => {
    const fixture = await captureSingleRepository(81, true);
    const moduleCoverage = await reopenMainCertifiedProjectFactsConsumer({
      carrier: fixture.certified,
      consumer: 'module-coverage',
      dataRoot: fixture.dataRoot,
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['module-coverage'],
    });
    const { files, modules } = moduleCoverage.projection;
    const ownedUnion = new Set(modules.flatMap((module) => module.ownedFiles));
    const inventory = new Set(files.map(qualifyMainCertifiedPath));

    expect(files).toHaveLength(81);
    expect(modules).toHaveLength(81);
    expect(modules.every((module) => module.ownedFiles.length > 0)).toBe(true);
    expect(ownedUnion).toEqual(inventory);
    expect([...modules.flatMap((module) => module.ownedFiles)]).toHaveLength(81);
    expect(fixture.certified.counters.cappedModuleProjectionCount).toBe(0);
  }, 120_000);

  test('rejects an eligible source that has no certified module owner', async () => {
    const root = await makeTemporaryRoot('alembic-main-unowned-source-');
    const projectRoot = path.join(root, 'project');
    const dataRoot = path.join(root, 'data');
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'src', 'owned.ts'), 'export const owned = true;\n');
    await writeFile(path.join(projectRoot, 'loose.ts'), 'export const loose = true;\n');
    const certified = await captureMainCertifiedProjectFacts({
      analysisScope: {
        controlRoot: null,
        currentFolderId: null,
        dataRoot,
        folderCount: 0,
        projectRoot,
        projectScope: null,
        projectScopeId: null,
      },
      dimensions: dimensions(),
      projectRoot,
      source: 'alembic-main-bootstrap',
    });
    const artifact = await openArtifact(dataRoot, certified);
    expect(
      artifact.facts.inventory.files.find((file) => file.relativePath === 'src/owned.ts')
    ).toMatchObject({ ownerModuleIds: ['module:src'] });
    expect(
      artifact.facts.inventory.files.find((file) => file.relativePath === 'loose.ts')
        ?.ownerModuleIds
    ).toEqual([]);

    await expect(
      reopenMainCertifiedProjectFactsConsumer({
        carrier: certified,
        consumer: 'module-coverage',
        dataRoot,
        entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['module-coverage'],
      })
    ).rejects.toThrow(/eligible source.*owner/i);
    expect(certified.receipts['module-coverage']).toBeUndefined();
  }, 60_000);

  test('conserves the ProjectScope control root itself plus four member repositories', async () => {
    const root = await makeTemporaryRoot('alembic-main-mr5-');
    const controlRoot = path.join(root, 'control');
    const dataRoot = path.join(root, 'data');
    await mkdir(path.join(controlRoot, 'Sources', 'Root'), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(controlRoot, 'Sources', 'Root', 'Root.swift'), 'struct Root {}\n');
    const folders = [projectScopeFolder('root-folder', 'opaque-root', controlRoot)];
    for (let index = 1; index <= 4; index += 1) {
      const memberRoot = path.join(controlRoot, 'Packages', `Member${index}`);
      await mkdir(path.join(memberRoot, 'Sources', `Member${index}`), { recursive: true });
      await writeFile(
        path.join(memberRoot, 'Sources', `Member${index}`, `Feature${index}.swift`),
        `public struct Feature${index} {}\n`
      );
      folders.push(projectScopeFolder(`member-${index}`, `opaque-member-${index}`, memberRoot));
    }
    const certified = await captureMainCertifiedProjectFacts({
      analysisScope: analysisScope(controlRoot, dataRoot, controlRoot, folders),
      dimensions: dimensions(),
      projectRoot: controlRoot,
      source: 'alembic-main-bootstrap',
    });
    const recipe = await reopenMainCertifiedProjectFactsConsumer({
      carrier: certified,
      consumer: 'recipe-generation',
      dataRoot,
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['recipe-generation'],
    });
    const artifact = await openArtifact(dataRoot, certified);
    const expectedRepos = new Set([
      'opaque-root',
      ...Array.from({ length: 4 }, (_, i) => `opaque-member-${i + 1}`),
    ]);

    expect(new Set(recipe.projection.files.map((file) => file.repoId))).toEqual(expectedRepos);
    expect(recipe.projection.files).toHaveLength(5);
    expect(
      new Set(artifact.manifest.projectScopeManifest?.repositories.map((row) => row.repoId))
    ).toEqual(expectedRepos);
    expect(
      new Set(artifact.manifest.sourceRevisionVector.entries.map((row) => row.repoId))
    ).toEqual(expectedRepos);
    expect(artifact.manifest.projectScopeManifest?.canonicalScopeHash).toBe(
      certified.canonicalScopeHash
    );
    for (const file of recipe.projection.files) {
      await expect(
        readFile(path.join(controlRoot, qualifyMainCertifiedPath(file)), 'utf8')
      ).resolves.toBeTruthy();
    }
  }, 120_000);

  test('rejects malformed presenter and missing graph authority instead of synthesizing empties', async () => {
    const fixture = await captureSingleRepository(2);
    const artifact = structuredClone(await openArtifact(fixture.dataRoot, fixture.certified));
    const malformed = artifact.facts.requestOutcomes.find(
      (row) => row.applicability === 'applicable' && row.terminalStatus === 'completed'
    );
    if (!malformed) {
      throw new Error('Expected a completed ProjectContext outcome.');
    }
    malformed.output = { data: {}, queryLevel: 'repo', refs: null } as never;
    expect(() => projectMainCertifiedConsumerPayload(artifact, 'plan')).toThrow();

    const withoutMap = structuredClone(await openArtifact(fixture.dataRoot, fixture.certified));
    withoutMap.facts.requestOutcomes = withoutMap.facts.requestOutcomes.filter(
      (row) => row.kind !== 'map'
    );
    expect(() => projectMainCertifiedConsumerPayload(withoutMap, 'dependency-graph')).toThrow(
      /map authority/i
    );

    const malformedGraph = structuredClone(await openArtifact(fixture.dataRoot, fixture.certified));
    const mapOutcome = malformedGraph.facts.requestOutcomes.find(
      (row) =>
        row.kind === 'map' &&
        row.applicability === 'applicable' &&
        row.terminalStatus === 'completed'
    );
    if (!mapOutcome) {
      throw new Error('Expected a completed map outcome.');
    }
    mapOutcome.output = {
      data: { edges: [{ from: 42, to: 'module:target' }] },
      queryLevel: 'map',
      refs: [],
    } as never;
    expect(() => projectMainCertifiedConsumerPayload(malformedGraph, 'dependency-graph')).toThrow(
      /malformed declared edge/i
    );
  }, 60_000);

  test('derives strict counters from route observations rather than constants', () => {
    expect(
      summarizeMainCertifiedInstrumentation([
        { emittedModuleCount: 80, expectedOwnerModuleCount: 83, kind: 'module-projection' },
        {
          entrypoint: 'probe/direct',
          kind: 'legacy-route',
          route: 'direct-project-context',
        },
        { entrypoint: 'probe/raw', kind: 'legacy-route', route: 'raw-filesystem' },
        {
          entrypoint: 'probe/scope',
          kind: 'legacy-route',
          route: 'synthesized-project-scope',
        },
      ])
    ).toEqual({
      cappedModuleProjectionCount: 3,
      directProjectContextCallCount: 1,
      rawFilesystemFallbackCount: 1,
      synthesizedProjectScopeFactCount: 1,
    });
  });

  test('fails closed for partial, hash, vector, scope and stale carrier mutations', async () => {
    const fixture = await captureSingleRepository(2);
    const mutations: Array<(carrier: MainCertifiedProjectFactsCarrier) => void> = [
      (carrier) => delete (carrier as unknown as Record<string, unknown>).factsContentHash,
      (carrier) => (carrier.factsContentHash = hashCanonicalJson({ facts: 'other' })),
      (carrier) => (carrier.sourceVectorHash = hashCanonicalJson({ vector: 'other' })),
      (carrier) => (carrier.canonicalScopeHash = hashCanonicalJson({ scope: 'other' })),
      (carrier) => (carrier.certificationBindingHash = hashCanonicalJson({ binding: 'stale' })),
    ];
    for (const mutate of mutations) {
      const carrier = structuredClone(fixture.certified);
      mutate(carrier);
      await expect(
        reopenMainCertifiedProjectFactsConsumer({
          carrier,
          consumer: 'recipe-generation',
          dataRoot: fixture.dataRoot,
          entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['recipe-generation'],
        })
      ).rejects.toThrow(/certified|artifact/i);
    }
  }, 60_000);

  test('fails closed when the stored artifact is deleted or its payload is mutated', async () => {
    const deleted = await captureSingleRepository(1);
    await rm(artifactDirectory(deleted.dataRoot, deleted.certified.artifactId), {
      force: true,
      recursive: true,
    });
    await expect(
      reopenMainCertifiedProjectFactsConsumer({
        carrier: deleted.certified,
        consumer: 'recipe-generation',
        dataRoot: deleted.dataRoot,
        entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['recipe-generation'],
      })
    ).rejects.toThrow();

    const mutated = await captureSingleRepository(1);
    const artifactPath = path.join(
      artifactDirectory(mutated.dataRoot, mutated.certified.artifactId),
      'artifact.json'
    );
    const stored = JSON.parse(
      await readFile(artifactPath, 'utf8')
    ) as CertifiedProjectFactsArtifactV1;
    const firstStoredFile = stored.facts.inventory.files[0];
    if (!firstStoredFile) {
      throw new Error('Expected a stored inventory file.');
    }
    firstStoredFile.sizeBytes += 1;
    await writeFile(artifactPath, `${JSON.stringify(stored)}\n`);
    await expect(
      reopenMainCertifiedProjectFactsConsumer({
        carrier: mutated.certified,
        consumer: 'module-coverage',
        dataRoot: mutated.dataRoot,
        entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS['module-coverage'],
      })
    ).rejects.toThrow();
  }, 60_000);
});

async function captureSingleRepository(fileCount: number, splitModules = false) {
  const root = await makeTemporaryRoot('alembic-main-certified-');
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    const relativePath = splitModules
      ? path.join('Sources', 'Core', `module-${String(index).padStart(3, '0')}`, 'file.swift')
      : path.join('src', `file-${index}.ts`);
    const absolutePath = path.join(projectRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `export const value${index} = ${index};\n`);
  }
  const certified = await captureMainCertifiedProjectFacts({
    analysisScope: {
      controlRoot: null,
      currentFolderId: null,
      dataRoot,
      folderCount: 0,
      projectRoot,
      projectScope: null,
      projectScopeId: null,
    },
    dimensions: dimensions(),
    projectRoot,
    source: 'alembic-main-bootstrap',
  });
  return { certified, dataRoot, projectRoot, root };
}

async function makeTemporaryRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function dimensions() {
  return [{ id: 'architecture', label: 'Architecture' }];
}

function readSessionCarrier(
  manager: GenerateSessionManager,
  sessionId: string,
  projectRoot: string
): MainCertifiedProjectFactsCarrier {
  const carrier = readMainCertifiedCarrierFromProjectContext(
    manager.getAnySession(sessionId, { projectRoot })?.toSnapshot().projectContext
  );
  if (!carrier) {
    throw new Error(`Expected certified facts in Generate session ${sessionId}.`);
  }
  return carrier;
}

function receiptConsumers(carrier: MainCertifiedProjectFactsCarrier): string[] {
  return Object.keys(carrier.receipts).sort();
}

function projectScopeFolder(id: string, repositoryId: string, folderPath: string) {
  return {
    addedAt: null,
    displayName: id,
    id,
    metadata: {},
    path: folderPath,
    realpath: folderPath,
    repositoryId,
    role: 'source',
    state: 'active',
  };
}

function analysisScope(
  controlRoot: string,
  dataRoot: string,
  projectRoot: string,
  folders: ReturnType<typeof projectScopeFolder>[]
) {
  return {
    controlRoot,
    currentFolderId: folders[0]?.id ?? null,
    dataRoot,
    folderCount: folders.length,
    projectRoot,
    projectScope: {
      controlRoot: { path: controlRoot },
      folders,
      projectId: 'fixture-project',
      projectScopeId: 'fixture-scope',
    } as never,
    projectScopeId: 'fixture-scope',
  };
}

function storeRoot(dataRoot: string) {
  return path.join(dataRoot, 'context', 'certified-project-facts', 'v2');
}

function artifactDirectory(dataRoot: string, artifactId: string) {
  return path.join(storeRoot(dataRoot), 'artifacts', artifactId.replace(/^cpf-v1:/, ''));
}

async function openArtifact(
  dataRoot: string,
  carrier: MainCertifiedProjectFactsCarrier
): Promise<CertifiedProjectFactsArtifactV1> {
  return new FileCertifiedProjectFactsStore(storeRoot(dataRoot)).open(
    carrier.artifactId,
    carrier.certificationBindingHash
  );
}

test('synthetic carrier assertion still rejects an unobserved nonzero counter', () => {
  const carrier: MainCertifiedProjectFactsCarrier = {
    artifactId: `cpf-v1:${'a'.repeat(64)}`,
    baseReadbackUnchanged: true,
    canonicalScopeHash: hashCanonicalJson({ scope: 'fixture' }),
    certificationBindingHash: hashCanonicalJson({ binding: 'fixture' }),
    counters: {
      cappedModuleProjectionCount: 0,
      directProjectContextCallCount: 1,
      rawFilesystemFallbackCount: 0,
      synthesizedProjectScopeFactCount: 0,
    },
    factsContentHash: hashCanonicalJson({ facts: 'fixture' }),
    instrumentation: [],
    receipts: {},
    sourceVectorHash: hashCanonicalJson({ vector: 'fixture' }),
  };
  expect(() => assertMainCertifiedProjectFactsCarrier(carrier)).toThrow(/observed routes/i);
});
