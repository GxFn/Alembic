import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { GenerateSessionManager } from '@alembic/core/host-agent-workflows';
import {
  hashCanonicalJson,
  type ProjectContextConsumerProjectionReceiptV2,
} from '@alembic/core/project-context-foundation';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertMainCertifiedProjectFactsCarrier,
  buildStrictProjectContextWorkflowFacts,
  captureMainCertifiedProjectFacts,
  type MainCertifiedProjectFactsCarrier,
  type MainCertifiedProjectionPayload,
  readMainCertifiedCarrierFromProjectContext,
  serializeMainCertifiedProjectFactsCarrier,
} from '../../lib/project-facts/CertifiedProjectFactsRuntime.js';
import { ModuleService } from '../../lib/service/module/ModuleService.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe('Alembic Main strict-v2 ProjectContext adapters', () => {
  test('captures once, persists, reopens and projects the four loaded Main consumers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'alembic-main-certified-'));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, 'project');
    const dataRoot = path.join(root, 'data');
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'src/index.ts'), 'export const value = 1;\n');
    await writeFile(path.join(projectRoot, 'src/extra.ts'), 'export const extra = value + 1;\n');
    await execFileAsync('git', ['-C', projectRoot, 'init', '--quiet']);
    await execFileAsync('git', ['-C', projectRoot, 'config', 'user.email', 'pcf@example.invalid']);
    await execFileAsync('git', ['-C', projectRoot, 'config', 'user.name', 'PCF Test']);
    await execFileAsync('git', ['-C', projectRoot, 'add', '.']);
    await execFileAsync('git', ['-C', projectRoot, 'commit', '--quiet', '-m', 'fixture']);

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
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      projectRoot,
      source: 'alembic-main-bootstrap',
    });

    expect(certified.baseReadbackUnchanged).toBe(true);
    expect(Object.keys(certified.receipts).sort()).toEqual([
      'dependency-graph',
      'module-coverage',
      'plan',
      'recipe-generation',
    ]);
    for (const receipt of Object.values(certified.receipts)) {
      expect(receipt).toMatchObject({
        artifactId: certified.artifactId,
        certificationBindingHash: certified.certificationBindingHash,
        factsContentHash: certified.factsContentHash,
        sourceVectorHash: certified.sourceVectorHash,
      });
    }
    expect(certified.projections['recipe-generation']?.files).toHaveLength(2);
    expect(certified.projections['recipe-generation']?.files[0]?.contentBase64).toBeTruthy();
    expect(certified.counters).toEqual({
      cappedModuleProjectionCount: 0,
      directProjectContextCallCount: 0,
      rawFilesystemFallbackCount: 0,
      synthesizedProjectScopeFactCount: 0,
    });

    const workflowFacts = buildStrictProjectContextWorkflowFacts({
      certified,
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      projectRoot,
      source: 'alembic-main-bootstrap',
    });
    expect(workflowFacts.allFiles).toHaveLength(2);
    expect(workflowFacts.report).toMatchObject({
      projectInformationSource: 'certified-project-facts',
    });

    const firstManager = new GenerateSessionManager({ dataRoot });
    const session = firstManager.createSession({
      dimensions: workflowFacts.dimensions,
      projectContext: {
        certifiedProjectFacts: serializeMainCertifiedProjectFactsCarrier(certified),
      },
      projectRoot,
    });
    const freshManager = new GenerateSessionManager({ dataRoot });
    const reopenedSession = freshManager.getAnySession(session.id, { projectRoot });
    const reopenedCarrier = readMainCertifiedCarrierFromProjectContext(
      reopenedSession?.toSnapshot().projectContext
    );
    expect(reopenedCarrier).toMatchObject({
      artifactId: certified.artifactId,
      certificationBindingHash: certified.certificationBindingHash,
      factsContentHash: certified.factsContentHash,
      sourceVectorHash: certified.sourceVectorHash,
    });

    await rm(projectRoot, { force: true, recursive: true });
    const moduleService = new ModuleService(projectRoot, {
      certifiedFactsProvider: () => reopenedCarrier,
    });
    const targets = await moduleService.listTargets();
    expect(targets.length).toBeGreaterThan(0);
    const firstTarget = targets[0];
    if (!firstTarget) {
      throw new Error('Expected certified module coverage target.');
    }
    const moduleFiles = await moduleService.getTargetFiles(firstTarget);
    expect(moduleFiles).toHaveLength(2);
    expect(moduleFiles[0]).toMatchObject({ content: expect.any(String) });
    await expect(moduleService.getDependencyGraph()).resolves.toMatchObject({
      edges: expect.any(Array),
      nodes: expect.any(Array),
    });
  }, 30_000);

  test('conserves more than 12 files and 80 modules without completeness caps', () => {
    const carrier = makeCarrier(13, 85);
    expect(() => assertMainCertifiedProjectFactsCarrier(carrier)).not.toThrow();
    expect(carrier.projections['recipe-generation']?.files).toHaveLength(13);
    expect(carrier.projections['module-coverage']?.modules).toHaveLength(85);
    expect(carrier.counters.cappedModuleProjectionCount).toBe(0);
  });

  test('conserves a ProjectScope control root plus four member repositories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'alembic-main-mr5-'));
    temporaryRoots.push(root);
    const controlRoot = path.join(root, 'control');
    const dataRoot = path.join(root, 'data');
    await mkdir(controlRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    const folders = [];
    for (let index = 0; index < 5; index += 1) {
      const folderPath = path.join(controlRoot, `repo-${index + 1}`);
      await mkdir(path.join(folderPath, 'src'), { recursive: true });
      await writeFile(
        path.join(folderPath, 'src/index.ts'),
        `export const repo${index + 1} = ${index + 1};\n`
      );
      folders.push({
        addedAt: null,
        displayName: `Repo ${index + 1}`,
        id: `folder-${index + 1}`,
        metadata: {},
        path: folderPath,
        realpath: folderPath,
        repositoryId: `repo-${index + 1}`,
        role: 'source',
        state: 'active',
      });
    }
    const firstFolder = folders[0];
    if (!firstFolder) {
      throw new Error('Expected MR5 fixture folders.');
    }

    const certified = await captureMainCertifiedProjectFacts({
      analysisScope: {
        controlRoot,
        currentFolderId: 'folder-1',
        dataRoot,
        folderCount: folders.length,
        projectRoot: firstFolder.path,
        projectScope: {
          controlRoot: { path: controlRoot },
          folders,
          projectId: 'mr5-fixture',
          projectScopeId: 'mr5-scope',
        } as never,
        projectScopeId: 'mr5-scope',
      },
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      projectRoot: firstFolder.path,
      source: 'alembic-main-bootstrap',
    });

    expect(
      new Set(certified.projections['recipe-generation']?.files.map((file) => file.repoId))
    ).toEqual(new Set(['repo-1', 'repo-2', 'repo-3', 'repo-4', 'repo-5']));
    expect(certified.projections['recipe-generation']?.files).toHaveLength(5);
    expect(Object.values(certified.receipts)).toHaveLength(4);
  }, 60_000);

  test.each([
    ['partial', (carrier: MainCertifiedProjectFactsCarrier) => delete carrier.receipts.plan],
    [
      'scope',
      (carrier: MainCertifiedProjectFactsCarrier) =>
        (carrier.canonicalScopeHash = hashCanonicalJson({ scope: 'other' })),
    ],
    [
      'vector',
      (carrier: MainCertifiedProjectFactsCarrier) =>
        (carrier.sourceVectorHash = hashCanonicalJson({ vector: 'other' })),
    ],
    [
      'payload-hash',
      (carrier: MainCertifiedProjectFactsCarrier) => {
        const projection = carrier.projections.plan;
        const firstFile = projection?.files[0];
        if (!projection || !firstFile) {
          throw new Error('Expected plan fixture projection.');
        }
        projection.files.push(firstFile);
      },
    ],
    [
      'stale-binding',
      (carrier: MainCertifiedProjectFactsCarrier) =>
        (carrier.certificationBindingHash = hashCanonicalJson({ binding: 'stale' })),
    ],
  ])('rejects %s mutation before consumer use', (_name, mutate) => {
    const carrier = structuredClone(makeCarrier(13, 85));
    mutate(carrier);
    expect(() => assertMainCertifiedProjectFactsCarrier(carrier)).toThrow(/certified/i);
  });
});

function makeCarrier(fileCount: number, moduleCount: number): MainCertifiedProjectFactsCarrier {
  const artifactId = `cpf-v1:${'a'.repeat(64)}`;
  const canonicalScopeHash = hashCanonicalJson({ scope: 'fixture' });
  const certificationBindingHash = hashCanonicalJson({ binding: 'fixture' });
  const factsContentHash = hashCanonicalJson({ facts: 'fixture' });
  const sourceVectorHash = hashCanonicalJson({ vector: 'fixture' });
  const runId = 'main-fixture';
  const files = Array.from({ length: fileCount }, (_, index) => ({
    blobHash: hashCanonicalJson({ file: index }),
    byteLength: 1,
    contentBase64: 'eA==',
    language: 'typescript',
    moduleIds: [`module:${index % moduleCount}`],
    relativePath: `src/file-${index}.ts`,
    repoId: 'fixture',
  }));
  const modules = Array.from({ length: moduleCount }, (_, index) => ({
    moduleId: `module:${index}`,
    moduleName: `module-${index}`,
    ownedFiles: index < fileCount ? [`fixture/src/file-${index}.ts`] : [],
    repoId: 'fixture',
  }));
  const consumers = ['plan', 'recipe-generation', 'dependency-graph', 'module-coverage'] as const;
  const projections = {} as Record<string, MainCertifiedProjectionPayload>;
  const receipts = {} as Record<string, ProjectContextConsumerProjectionReceiptV2>;
  for (const consumer of consumers) {
    const projection: MainCertifiedProjectionPayload = {
      canonicalScopeHash,
      consumer,
      envelopes: [],
      files,
      modules,
      requestKinds: ['repo', 'map'],
      ...(consumer === 'dependency-graph'
        ? {
            dependencyGraph: {
              edges: [],
              nodes: modules.map((module) => ({ id: module.moduleId })),
              projectInformationSource: 'project-context' as const,
            },
          }
        : {}),
    };
    projections[consumer] = projection;
    const semantic = {
      adapterVersion: 'fixture-v1',
      artifactId,
      certificationBindingHash,
      consumer,
      entrypoint: 'test/actual-adapters/main-fixture.ts',
      factsContentHash,
      kind: 'ProjectContextConsumerProjectionReceiptV2' as const,
      loadEvidenceHash: hashCanonicalJson({ loaded: true }),
      payloadSchemaHash: hashCanonicalJson({ consumer, schema: 1 }),
      projectionContentHash: hashCanonicalJson(projection),
      runId,
      sourceVectorHash,
      version: 2 as const,
    };
    receipts[consumer] = { ...semantic, receiptHash: hashCanonicalJson(semantic) };
  }
  return {
    artifactId,
    canonicalScopeHash,
    certificationBindingHash,
    counters: {
      cappedModuleProjectionCount: 0,
      directProjectContextCallCount: 0,
      rawFilesystemFallbackCount: 0,
      synthesizedProjectScopeFactCount: 0,
    },
    factsContentHash,
    preparationId: 'prep-v1:fixture',
    projections,
    receipts,
    runId,
    sourceVectorHash,
  };
}
