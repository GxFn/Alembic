import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  baseDimensions,
  type DimensionDef,
  GenerateSessionLeaseError,
  GenerateSessionManager,
} from '@alembic/core/host-agent-workflows';
import {
  buildProjectContextPresenterInput,
  type ProjectContextEnvelope,
  type ProjectContextResult,
  type RepoContext,
} from '@alembic/core/project-context';
import type {
  PlanCollectOptions,
  PlanProjectContextAnalysis,
  ProjectSourceFileFact,
} from '@alembic/core/service/planFacts';
import { createProjectDescriptor } from '@alembic/core/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  presentProjectContextColdStartEmptyProject,
  presentProjectContextColdStartResponse,
  presentProjectContextRescanResponse,
} from '../../lib/project-facts/ProjectContextPresenters.js';
import {
  buildProjectContextMissionArtifacts,
  buildProjectContextWorkflowFacts,
  createProjectContextWorkflowSession,
  type ProjectContextWorkflowFacts,
  registerProjectContextWorkflowSessionReleaseOnGenerateCompletion,
  releaseProjectContextWorkflowSessionByProjectRoot,
} from '../../lib/project-facts/ProjectContextWorkflowFacts.js';
import {
  buildProjectMapModules,
  buildProjectMapModulesFromTargets,
} from '../../lib/project-facts/ProjectMapModules.js';

const fixtures: string[] = [];
// F6 之后采集在 Core 的 collectPlanProjectContext 里。这里的夹具仍按请求种类给信封：
// 设了 executeOverride 时，用一个按同样顺序发请求的假采集器把信封合成分析结果；
// 没设时走真实的 Core 采集器。collectCalls 记下适配层交给 Core 的范围与上限。
const projectContextCapabilitiesMock = vi.hoisted(() => ({
  collectCalls: [] as Array<{
    hints: unknown;
    options: PlanCollectOptions | undefined;
    projectRoot: string;
  }>,
  executeOverride: null as null | ((request: ProjectContextRequestMock) => Promise<unknown>),
}));

interface ProjectContextRequestMock {
  kind: string;
  payload?: Record<string, unknown>;
  scope?: {
    projectRoot?: string;
  };
}

vi.mock('@alembic/core/service/planFacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alembic/core/service/planFacts')>();
  return {
    ...actual,
    collectPlanProjectContext: vi.fn(
      async (projectRoot: string, hints: unknown, options?: PlanCollectOptions) => {
        projectContextCapabilitiesMock.collectCalls.push({ hints, options, projectRoot });
        if (!projectContextCapabilitiesMock.executeOverride) {
          return actual.collectPlanProjectContext(projectRoot, hints as never, options);
        }
        return fakeCollectPlanProjectContext(
          projectRoot,
          options,
          projectContextCapabilitiesMock.executeOverride,
          actual
        );
      }
    ),
  };
});

afterEach(async () => {
  projectContextCapabilitiesMock.executeOverride = null;
  projectContextCapabilitiesMock.collectCalls.length = 0;
  vi.clearAllMocks();
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('ProjectContextWorkflowFacts', () => {
  test('releases completed coldStart ProjectContext workflow leases for subsequent rescan sessions', () => {
    const projectRoot = '/tmp/alembic-session-release-project';
    const manager = new GenerateSessionManager();
    const eventBus = new EventEmitter();
    const container = createSessionContainer(manager, eventBus);
    const logger = createSessionLogger();
    const dimensions = createWorkflowDimensions();
    const facts = createWorkflowFacts(projectRoot);

    const coldStartSession = createProjectContextWorkflowSession({
      container,
      dimensions,
      facts,
      projectRoot,
    });
    registerProjectContextWorkflowSessionReleaseOnGenerateCompletion({
      bootstrapSessionId: 'bootstrap-session-complete',
      container,
      logger,
      projectRoot,
      workflow: 'cold-start',
      workflowSessionId: coldStartSession.id,
    });

    expect(() =>
      createProjectContextWorkflowSession({ container, dimensions, facts, projectRoot })
    ).toThrow(GenerateSessionLeaseError);

    eventBus.emit('bootstrap:all-completed', {
      sessionId: 'bootstrap-session-other',
      status: 'completed',
      tasks: [completedBootstrapTask()],
    });
    expect(() =>
      createProjectContextWorkflowSession({ container, dimensions, facts, projectRoot })
    ).toThrow(GenerateSessionLeaseError);

    eventBus.emit('bootstrap:all-completed', {
      sessionId: 'bootstrap-session-complete',
      status: 'completed',
      tasks: [completedBootstrapTask()],
    });

    const rescanSession = createProjectContextWorkflowSession({
      container,
      dimensions,
      facts,
      projectRoot,
    });
    expect(rescanSession.id).not.toBe(coldStartSession.id);
    expect(logger.info).toHaveBeenCalledWith(
      '[ProjectContextWorkflowFacts] Workflow session lease released',
      expect.objectContaining({
        reason: 'cold-start:bootstrap-session-completed',
        released: true,
        workflowSessionId: coldStartSession.id,
      })
    );
  });

  test('retains partial coldStart workflow leases instead of silently deleting evidence', () => {
    const projectRoot = '/tmp/alembic-session-partial-project';
    const manager = new GenerateSessionManager();
    const eventBus = new EventEmitter();
    const container = createSessionContainer(manager, eventBus);
    const logger = createSessionLogger();
    const dimensions = createWorkflowDimensions();
    const facts = createWorkflowFacts(projectRoot);

    const coldStartSession = createProjectContextWorkflowSession({
      container,
      dimensions,
      facts,
      projectRoot,
    });
    registerProjectContextWorkflowSessionReleaseOnGenerateCompletion({
      bootstrapSessionId: 'bootstrap-session-partial',
      container,
      logger,
      projectRoot,
      workflow: 'cold-start',
      workflowSessionId: coldStartSession.id,
    });

    eventBus.emit('bootstrap:all-completed', {
      sessionId: 'bootstrap-session-partial',
      status: 'completed_with_errors',
      tasks: [
        {
          id: 'architecture',
          status: 'failed',
          result: { status: 'error', type: 'error' },
        },
      ],
    });

    expect(manager.getAnySession(coldStartSession.id, { projectRoot })?.id).toBe(
      coldStartSession.id
    );
    expect(() =>
      createProjectContextWorkflowSession({ container, dimensions, facts, projectRoot })
    ).toThrow(GenerateSessionLeaseError);
    expect(logger.warn).toHaveBeenCalledWith(
      '[ProjectContextWorkflowFacts] Workflow session lease retained',
      expect.objectContaining({
        reason: 'bootstrap-session-not-clean-complete',
        status: 'completed_with_errors',
        workflowSessionId: coldStartSession.id,
      })
    );
  });

  test('releases cancelled coldStart workflow leases so retries are not blocked', () => {
    const projectRoot = '/tmp/alembic-session-cancelled-project';
    const manager = new GenerateSessionManager();
    const eventBus = new EventEmitter();
    const container = createSessionContainer(manager, eventBus);
    const logger = createSessionLogger();
    const dimensions = createWorkflowDimensions();
    const facts = createWorkflowFacts(projectRoot);

    const coldStartSession = createProjectContextWorkflowSession({
      container,
      dimensions,
      facts,
      projectRoot,
    });
    registerProjectContextWorkflowSessionReleaseOnGenerateCompletion({
      bootstrapSessionId: 'bootstrap-session-cancelled',
      container,
      logger,
      projectRoot,
      workflow: 'cold-start',
      workflowSessionId: coldStartSession.id,
    });

    eventBus.emit('bootstrap:all-completed', {
      sessionId: 'bootstrap-session-cancelled',
      status: 'aborted',
      summary: {
        aborted: true,
        reason: 'bounded host probe exceeded its window',
      },
      tasks: [
        {
          id: 'architecture',
          status: 'cancelled',
          error: 'bounded host probe exceeded its window',
        },
      ],
      userCancelled: true,
    });

    const retrySession = createProjectContextWorkflowSession({
      container,
      dimensions,
      facts,
      projectRoot,
    });
    expect(retrySession.id).not.toBe(coldStartSession.id);
    expect(manager.getAnySession(coldStartSession.id, { projectRoot })).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      '[ProjectContextWorkflowFacts] Workflow session lease released',
      expect.objectContaining({
        reason: 'cold-start:bootstrap-session-cancelled',
        released: true,
        workflowSessionId: coldStartSession.id,
      })
    );
  });

  test('releases rescan workflow leases by project root during daemon cancellation cleanup', () => {
    const projectRoot = '/tmp/alembic-rescan-session-cancelled-project';
    const manager = new GenerateSessionManager();
    const eventBus = new EventEmitter();
    const container = createSessionContainer(manager, eventBus);
    const logger = createSessionLogger();
    const dimensions = createWorkflowDimensions();
    const facts = createWorkflowFacts(projectRoot);

    const rescanSession = createProjectContextWorkflowSession({
      container,
      dimensions,
      facts,
      projectRoot,
    });

    const released = releaseProjectContextWorkflowSessionByProjectRoot({
      container,
      logger,
      projectRoot,
      reason: 'rescan:bootstrap-session-cancelled',
    });

    expect(released).toEqual({
      released: true,
      workflowSessionId: rescanSession.id,
    });
    expect(manager.getAnySession(rescanSession.id, { projectRoot })).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      '[ProjectContextWorkflowFacts] Workflow session lease released',
      expect.objectContaining({
        reason: 'rescan:bootstrap-session-cancelled',
        released: true,
        workflowSessionId: rescanSession.id,
      })
    );
  });

  test('replaces stale workflow leases only when destructive rebuild explicitly requests it', () => {
    const projectRoot = '/tmp/alembic-session-rebuild-project';
    const manager = new GenerateSessionManager();
    const eventBus = new EventEmitter();
    const container = createSessionContainer(manager, eventBus);
    const dimensions = createWorkflowDimensions();
    const facts = createWorkflowFacts(projectRoot);

    const staleSession = createProjectContextWorkflowSession({
      container,
      dimensions,
      facts,
      projectRoot,
    });
    expect(() =>
      createProjectContextWorkflowSession({ container, dimensions, facts, projectRoot })
    ).toThrow(GenerateSessionLeaseError);

    const rebuildSession = createProjectContextWorkflowSession({
      container,
      dimensions,
      facts,
      projectRoot,
      replaceExisting: true,
    });

    expect(rebuildSession.id).not.toBe(staleSession.id);
    expect(manager.getAnySession(staleSession.id, { projectRoot })).toBeNull();
    expect(manager.getAnySession(rebuildSession.id, { projectRoot })?.id).toBe(rebuildSession.id);
  });

  test('executes direct ProjectContext facts for built-in Agent workflow output', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'alembic-pci4-project-context-'));
    fixtures.push(projectRoot);

    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(projectRoot, 'lib'), { recursive: true });
      await fs.writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'pci4-fixture', type: 'module' })
      );
      await fs.writeFile(
        join(projectRoot, 'lib/index.ts'),
        'export function answer(): number { return 42; }\n'
      );
    });

    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-bootstrap',
    });

    expect(facts.projectContextSummary).toMatchObject({ source: 'project-context' });
    expect(facts.requestKinds).toContain('space');
    expect(facts.requestKinds).toContain('repo');
    expect(facts.requestKinds).toContain('map');
    expect(facts.requestKinds).toContain('source-slice');
    expect(facts.allFiles.some((file) => file.relativePath.endsWith('lib/index.ts'))).toBe(true);
    expect(JSON.stringify(facts.projectContextSummary)).toContain('project-context');
  });

  test('derives ProjectMap modules from target refs and real files when map modules are empty', async () => {
    const projectRoot = '/tmp/alembic-swift-target-project';
    mockSwiftTargetProjectContext(projectRoot);

    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-rescan',
    });

    expect(facts.projectMapModules).toContainEqual(
      expect.objectContaining({
        moduleName: 'AOXFoundationKit',
        modulePath: 'Sources/AOXFoundationKit',
        ownedFiles: ['Sources/AOXFoundationKit/Client.swift'],
      })
    );
    expect(facts.moduleCount).toBeGreaterThan(0);
  });

  test('threads ProjectScope member folders into ProjectContext requests and stamps source identities', async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), 'alembic-project-scope-context-'));
    fixtures.push(controlRoot);
    const alembicRoot = join(controlRoot, 'Alembic');
    const coreRoot = join(controlRoot, 'AlembicCore');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(alembicRoot, 'lib'), { recursive: true });
      await fs.mkdir(join(coreRoot, 'lib'), { recursive: true });
      await fs.writeFile(join(coreRoot, 'lib/index.ts'), 'export const core = true;\n');
    });
    const projectScope = createProjectDescriptor({
      controlRoot,
      dataRoot: join(controlRoot, '.ghost-data'),
      displayName: 'AlembicWorkspace',
      folders: [
        { displayName: 'Alembic', path: alembicRoot, role: 'primary-source' },
        { displayName: 'AlembicCore', path: coreRoot, role: 'source' },
      ],
    });
    const sourceFolders = ['Alembic', 'AlembicCore'];
    const requests: ProjectContextRequestMock[] = [];
    const repoRef = makeProjectContextRef(controlRoot, 'repo:alembic-core', {
      kind: 'repo',
      label: 'AlembicCore',
    });
    const fileRef = makeProjectContextRef(controlRoot, 'file:core:AlembicCore/lib/index.ts', {
      filePath: 'AlembicCore/lib/index.ts',
      kind: 'file',
      label: 'index.ts',
    });

    projectContextCapabilitiesMock.executeOverride = async (request) => {
      requests.push(request);
      switch (request.kind) {
        case 'space':
          return projectContextEnvelope(controlRoot, 'space', {
            boundaries: [],
            nextRefs: [repoRef, fileRef],
            repos: [],
            sourceFolders: [],
            space: { id: 'space', ref: repoRef },
            structuralHotspots: [],
          });
        case 'repo':
          return projectContextEnvelope(
            controlRoot,
            'repo',
            {
              buildSystems: [],
              commands: [],
              configFiles: [],
              entrypoints: [],
              languages: [{ fileCount: 1, language: 'typescript' }],
              localPackages: [],
              nextRefs: [fileRef],
              packageSystems: [],
              repo: { name: 'AlembicWorkspace', ref: repoRef },
              sourceRoots: [],
              targets: [],
              topAreas: [],
            },
            [repoRef, fileRef]
          );
        case 'source-slice':
          return projectContextEnvelope(
            controlRoot,
            'source-slice',
            {
              file: {
                filePath: 'AlembicCore/lib/index.ts',
                language: 'typescript',
                lineCount: 1,
                ref: fileRef,
                repoId: 'alembic-core',
              },
              nextRefs: [],
              range: { endLine: 1, startLine: 1 },
              text: 'export const core = true;',
            },
            [fileRef]
          );
        default:
          return projectContextEnvelope(controlRoot, request.kind, {
            available: false,
            kind: request.kind,
            nextRefs: [fileRef],
            reason: 'fixture unavailable',
          });
      }
    };

    const facts = await buildProjectContextWorkflowFacts({
      analysisScope: {
        controlRoot,
        currentFolderId: projectScope.folders[0].id,
        dataRoot: projectScope.dataRoot,
        folderCount: projectScope.folders.length,
        projectRoot: alembicRoot,
        projectScope,
        projectScopeId: projectScope.projectScopeId,
      },
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot: alembicRoot,
      source: 'alembic-main-bootstrap',
    });

    // 范围交给 Core 采集器：成员文件夹原样作为 space 的文件夹对象，第一个文件夹是 repo 的主仓库，
    // 采集根是控制根（范围里的路径都相对它）。
    expect(projectContextCapabilitiesMock.collectCalls).toHaveLength(1);
    expect(projectContextCapabilitiesMock.collectCalls[0]).toMatchObject({
      options: {
        // 模块种子不设上限（不传 maxModuleSeeds），明细与正文沿用默认值。
        limits: { maxFileDetails: 8, maxModuleDetails: 3, sourceSliceLines: 8 },
        scope: {
          repoRoot: 'Alembic',
          sourceFolders: [
            expect.objectContaining({
              displayName: 'Alembic',
              path: sourceFolders[0],
              role: 'primary-source',
            }),
            expect.objectContaining({ displayName: 'AlembicCore', path: sourceFolders[1] }),
          ],
        },
        source: 'alembic-main-bootstrap',
      },
      projectRoot: controlRoot,
    });
    expect(requests.find((request) => request.kind === 'space')?.payload).toMatchObject({
      sourceFolders: [
        expect.objectContaining({ displayName: 'Alembic', path: sourceFolders[0] }),
        expect.objectContaining({ displayName: 'AlembicCore', path: sourceFolders[1] }),
      ],
    });
    expect(facts.allFiles).toContainEqual(
      expect.objectContaining({
        relativePath: 'AlembicCore/lib/index.ts',
        sourceIdentity: expect.objectContaining({
          folderDisplayName: 'AlembicCore',
          folderId: projectScope.folders[1].id,
          folderPath: coreRoot,
          folderRelativeRoot: 'AlembicCore',
          projectScopeId: projectScope.projectScopeId,
          qualifiedPath: 'AlembicCore/lib/index.ts',
          relativePath: 'lib/index.ts',
        }),
      })
    );
  });

  test('keeps in-process production facts scoped when presenter output contains stale workspace map data', async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), 'alembic-production-scope-facts-'));
    fixtures.push(controlRoot);
    const alembicRoot = join(controlRoot, 'Alembic');
    const coreRoot = join(controlRoot, 'AlembicCore');
    const pluginRoot = join(controlRoot, 'AlembicPlugin');
    const dashboardRoot = join(controlRoot, 'AlembicDashboard');
    const agentRoot = join(controlRoot, 'AlembicAgent');
    const staleRoot = join(controlRoot, 'BiliDili');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(alembicRoot, 'lib'), { recursive: true });
      await fs.mkdir(join(coreRoot, 'src'), { recursive: true });
      await fs.mkdir(join(pluginRoot, 'lib'), { recursive: true });
      await fs.mkdir(join(dashboardRoot, 'src'), { recursive: true });
      await fs.mkdir(join(agentRoot, 'src'), { recursive: true });
      await fs.mkdir(join(staleRoot, 'Sources/Home'), { recursive: true });
      await fs.writeFile(join(alembicRoot, 'lib/index.ts'), 'export const main = true;\n');
      await fs.writeFile(join(coreRoot, 'src/index.ts'), 'export const core = true;\n');
      await fs.writeFile(join(pluginRoot, 'lib/index.ts'), 'export const plugin = true;\n');
      await fs.writeFile(
        join(dashboardRoot, 'src/index.tsx'),
        'export const Dashboard = () => null;\n'
      );
      await fs.writeFile(join(agentRoot, 'src/index.ts'), 'export const agent = true;\n');
      await fs.writeFile(join(staleRoot, 'Sources/Home/Home.swift'), 'public struct Home {}\n');
    });

    const projectScope = createProjectDescriptor({
      controlRoot,
      dataRoot: join(controlRoot, '.ghost-data'),
      displayName: 'AlembicWorkspace',
      folders: [
        { displayName: 'Alembic', path: alembicRoot, role: 'primary-source' },
        { displayName: 'AlembicCore', path: coreRoot, role: 'source' },
        { displayName: 'AlembicPlugin', path: pluginRoot, role: 'source' },
        { displayName: 'AlembicDashboard', path: dashboardRoot, role: 'source' },
        { displayName: 'AlembicAgent', path: agentRoot, role: 'source' },
      ],
    });
    const repoRef = makeProjectContextRef(controlRoot, 'repo:workspace', {
      kind: 'repo',
      label: 'AlembicWorkspace',
    });
    const alembicModuleRef = makeProjectContextRef(controlRoot, 'path:repo:Alembic', {
      filePath: 'Alembic',
      kind: 'path',
      label: 'Alembic',
    });
    const staleModuleRef = makeProjectContextRef(controlRoot, 'path:repo:BiliDili', {
      filePath: 'BiliDili',
      kind: 'path',
      label: 'BiliDili',
    });
    const requests: ProjectContextRequestMock[] = [];
    projectContextCapabilitiesMock.executeOverride = async (request) => {
      requests.push(request);
      switch (request.kind) {
        case 'space':
          return projectContextEnvelope(controlRoot, 'space', {
            boundaries: [],
            nextRefs: [repoRef],
            repos: [],
            sourceFolders: request.payload?.sourceFolders ?? [],
            space: { id: 'space', ref: repoRef },
            structuralHotspots: [],
          });
        case 'repo':
          return projectContextEnvelope(
            controlRoot,
            'repo',
            {
              buildSystems: [],
              commands: [],
              configFiles: [],
              entrypoints: [],
              languages: [{ fileCount: 100, language: 'swift' }],
              localPackages: [],
              nextRefs: [repoRef],
              packageSystems: [],
              repo: { name: 'AlembicWorkspace', ref: repoRef },
              sourceRoots: [],
              targets: [],
              topAreas: [],
            },
            [repoRef]
          );
        case 'map':
          return projectContextEnvelope(controlRoot, 'map', {
            cycles: [],
            dependencySummary: [],
            externalDependencyHotspots: [],
            hotspots: [],
            layers: [],
            majorFlows: [],
            modules: [
              {
                id: 'target:Home:BiliDili',
                kind: 'target',
                name: 'Home',
                ownedFileCount: 1,
                ref: staleModuleRef,
                role: 'target',
              },
              {
                id: 'target:Alembic:Alembic',
                kind: 'project-scope-folder',
                name: 'Alembic',
                ownedFileCount: 1,
                ref: alembicModuleRef,
                role: 'source',
              },
            ],
            nextRefs: [],
            repo: { name: 'AlembicWorkspace', ref: repoRef },
          });
        default:
          return projectContextEnvelope(controlRoot, request.kind, {
            available: false,
            kind: request.kind,
            nextRefs: [],
            reason: 'fixture unavailable',
          });
      }
    };

    const facts = await buildProjectContextWorkflowFacts({
      analysisScope: {
        controlRoot,
        currentFolderId: projectScope.folders[0].id,
        dataRoot: projectScope.dataRoot,
        folderCount: projectScope.folders.length,
        projectRoot: alembicRoot,
        projectScope,
        projectScopeId: projectScope.projectScopeId,
      },
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      maxFileDetails: 0,
      maxFiles: 10,
      maxModuleDetails: 0,
      maxModuleSeeds: 8,
      projectRoot: controlRoot,
      source: 'alembic-main-bootstrap',
    });

    expect(projectContextCapabilitiesMock.collectCalls[0]?.options).toMatchObject({
      limits: { maxFileDetails: 0, maxFiles: 10, maxModuleDetails: 0, maxModuleSeeds: 8 },
      scope: {
        repoRoot: 'Alembic',
        sourceFolders: [
          expect.objectContaining({ path: 'Alembic' }),
          expect.objectContaining({ path: 'AlembicCore' }),
          expect.objectContaining({ path: 'AlembicPlugin' }),
          expect.objectContaining({ path: 'AlembicDashboard' }),
          expect.objectContaining({ path: 'AlembicAgent' }),
        ],
      },
    });
    expect(requests.find((request) => request.kind === 'repo')?.payload).toMatchObject({
      repoRoot: 'Alembic',
    });
    expect(facts.primaryLang).toBe('typescript');
    expect(facts.allFiles.length).toBeGreaterThan(0);
    expect(facts.allFiles.every((file) => !file.relativePath.includes('BiliDili'))).toBe(true);
    expect(facts.allFiles.filter((file) => file.sourceIdentity).length).toBe(facts.allFiles.length);
    expect(JSON.stringify(facts.projectMapModules)).not.toContain('BiliDili');
    expect(facts.projectMapModules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ moduleName: 'Alembic', modulePath: 'Alembic' }),
        expect.objectContaining({ moduleName: 'AlembicCore', modulePath: 'AlembicCore' }),
        expect.objectContaining({ moduleName: 'AlembicPlugin', modulePath: 'AlembicPlugin' }),
        expect.objectContaining({
          moduleName: 'AlembicDashboard',
          modulePath: 'AlembicDashboard',
        }),
        expect.objectContaining({ moduleName: 'AlembicAgent', modulePath: 'AlembicAgent' }),
      ])
    );
  });

  test('derives BiliDili-style SwiftPM modules from root target refs and filesystem-owned files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'alembic-bilidili-module-facts-'));
    fixtures.push(projectRoot);
    const targets = [
      ['ServiceKit', 'Sources/Core/ServiceKit/ServiceProtocols.swift'],
      ['PaginationKit', 'Sources/Core/PaginationKit/PaginationController.swift'],
      ['Networking', 'Sources/Infrastructure/Networking/Client.swift'],
      ['Account', 'Sources/Infrastructure/Account/AccountManager.swift'],
      ['Home', 'Sources/Features/Home/HomeViewController.swift'],
      ['VideoFeed', 'Sources/Features/VideoFeed/VideoFeedViewController.swift'],
      ['Profile', 'Sources/Features/Profile/ProfileViewController.swift'],
      ['LiveChat', 'Sources/Features/LiveChat/LiveChatViewController.swift'],
    ] as const;

    await import('node:fs/promises').then(async (fs) => {
      await fs.writeFile(
        join(projectRoot, 'Package.swift'),
        `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BiliDili",
  targets: [
${targets
  .map(
    ([name, filePath]) =>
      `    .target(name: "${name}", path: "${filePath.split('/').slice(0, -1).join('/')}")`
  )
  .join(',\n')}
  ]
)
`
      );
      for (const [, filePath] of targets) {
        await fs.mkdir(join(projectRoot, filePath.split('/').slice(0, -1).join('/')), {
          recursive: true,
        });
        await fs.writeFile(join(projectRoot, filePath), 'public struct Fixture {}\n');
      }
    });
    mockBiliDiliLikeProjectContext(
      projectRoot,
      targets.map(([name]) => name)
    );

    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 80,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-rescan',
    });

    expect(facts.projectMapModules).toHaveLength(targets.length);
    expect(facts.projectMapModules).toContainEqual(
      expect.objectContaining({
        moduleName: 'Home',
        modulePath: 'Sources/Features/Home',
        ownedFiles: ['Sources/Features/Home/HomeViewController.swift'],
      })
    );
    expect(facts.moduleCount).toBe(targets.length);
  });

  test('prefers nested local Swift package target paths over package root refs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'alembic-local-package-module-facts-'));
    fixtures.push(projectRoot);

    await import('node:fs/promises').then(async (fs) => {
      await fs.writeFile(
        join(projectRoot, 'Package.swift'),
        `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BiliDili",
  dependencies: [.package(path: "Packages/AOXFoundationKit")]
)
`
      );
      await fs.mkdir(join(projectRoot, 'Packages/AOXFoundationKit/Sources/AOXFoundationKit'), {
        recursive: true,
      });
      await fs.writeFile(
        join(projectRoot, 'Packages/AOXFoundationKit/Package.swift'),
        `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "AOXFoundationKit",
  targets: [.target(name: "AOXFoundationKit")]
)
`
      );
      await fs.writeFile(
        join(projectRoot, 'Packages/AOXFoundationKit/Sources/AOXFoundationKit/Logger.swift'),
        'public struct Logger {}\n'
      );
      await fs.writeFile(join(projectRoot, 'Packages/AOXFoundationKit/LICENSE'), 'MIT\n');
    });
    mockLocalSwiftPackageProjectContext(projectRoot);

    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 80,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-rescan',
    });

    expect(facts.projectMapModules).toContainEqual(
      expect.objectContaining({
        moduleName: 'AOXFoundationKit',
        modulePath: 'Packages/AOXFoundationKit/Sources/AOXFoundationKit',
        ownedFiles: ['Packages/AOXFoundationKit/Sources/AOXFoundationKit/Logger.swift'],
      })
    );
  });

  test('builds canonical ProjectMap module ids from fixed map input', () => {
    const projectRoot = '/tmp/alembic-project-map-module-input';
    const moduleRef = makeProjectContextRef(projectRoot, 'path:repo:lib/project-context', {
      filePath: 'lib/project-context',
      kind: 'path',
      label: 'project-context',
    });

    const modules = buildProjectMapModules(
      {
        dependencySummary: [],
        majorFlows: [],
        modules: [
          {
            id: 'module:project-context',
            kind: 'source-root',
            name: 'project-context',
            ownedFileCount: 2,
            ref: moduleRef,
            role: 'workflow-facts',
          },
        ],
      } as never,
      { projectRoot }
    );

    expect(modules).toEqual([
      {
        kind: 'source-root',
        moduleId: 'target:project-context:lib/project-context',
        moduleName: 'project-context',
        modulePath: 'lib/project-context',
        ownedFileCount: 2,
        ownedFiles: ['lib/project-context'],
        ref: moduleRef,
        role: 'workflow-facts',
      },
    ]);
  });

  test('keeps explicit ProjectMap module id fallback when the module path is unavailable', () => {
    const modules = buildProjectMapModules({
      dependencySummary: [],
      majorFlows: [],
      modules: [
        {
          id: 'module:legacy',
          kind: 'logical',
          name: 'legacy',
          ownedFileCount: 0,
          role: 'fallback',
        },
      ],
    } as never);

    expect(modules).toEqual([
      expect.objectContaining({
        moduleId: 'module:legacy',
        moduleName: 'legacy',
      }),
    ]);
  });

  test('filters aggregate ProjectMap root axes before coverage ledger fan-out', () => {
    const projectRoot = '/tmp/BiliDili';
    const rootRef = makeProjectContextRef(projectRoot, 'path:repo:BiliDili', {
      filePath: 'BiliDili',
      kind: 'path',
      label: 'BiliDili',
    });

    const modules = buildProjectMapModules(
      {
        dependencySummary: [],
        majorFlows: [],
        modules: [
          {
            id: 'module:root',
            kind: 'source-root',
            name: 'BiliDili',
            ownedFileCount: 1,
            ref: rootRef,
            role: 'root',
          },
        ],
      } as never,
      { projectRoot }
    );

    expect(modules).toEqual([]);
  });

  test('builds ProjectMap modules from fixed target input without changing shape', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'alembic-target-module-input-'));
    fixtures.push(projectRoot);
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(projectRoot, 'Sources/Home'), { recursive: true });
      await fs.writeFile(
        join(projectRoot, 'Sources/Home/HomeViewController.swift'),
        'public struct HomeViewController {}\n'
      );
    });
    const targetRef = makeProjectContextRef(projectRoot, 'path:repo:Sources/Home', {
      filePath: 'Sources/Home',
      kind: 'path',
      label: 'Home',
    });

    const modules = await buildProjectMapModulesFromTargets({
      allFiles: [
        {
          content: '',
          name: 'HomeViewController.swift',
          path: 'Sources/Home/HomeViewController.swift',
          relativePath: 'Sources/Home/HomeViewController.swift',
          targetName: 'Home',
        },
      ],
      input: {
        repo: {
          localPackages: [],
          targets: [{ kind: 'target', name: 'Home', refs: [targetRef] }],
        },
      } as never,
      projectRoot,
    });

    expect(modules).toEqual([
      {
        kind: 'target',
        moduleId: 'target:Home:Sources/Home',
        moduleName: 'Home',
        modulePath: 'Sources/Home',
        ownedFileCount: 1,
        ownedFiles: ['Sources/Home/HomeViewController.swift'],
        ref: targetRef,
        role: 'target',
      },
    ]);
  });

  test('keeps ProjectContext presenter response envelopes stable', () => {
    const projectRoot = '/tmp/alembic-project-context-presenter';
    const facts = createPresenterFacts(projectRoot);
    const dimension = { id: 'architecture', label: 'Architecture' };
    const bootstrapSession = { toJSON: () => ({ id: 'bootstrap-session-1' }) };

    const coldStart = presentProjectContextColdStartResponse({
      bootstrapSession: bootstrapSession as never,
      cachedSessionId: 'cached-session-1',
      cleanupResult: { clearedTables: ['knowledge'] },
      dimensions: [dimension],
      facts,
      responseTimeMs: 12,
      selectionSummary: { stage: 'coldStart' },
      taskCount: 1,
    });

    expect(coldStart).toMatchObject({
      data: {
        bootstrapSession: { id: 'bootstrap-session-1' },
        dimensionSelection: { stage: 'coldStart' },
        files: 1,
        primaryLanguage: 'typescript',
        projectContext: { source: 'project-context' },
        sessionId: 'cached-session-1',
        taskCount: 1,
      },
      meta: { responseTimeMs: 12, tool: 'alembic_bootstrap' },
      success: true,
    });

    const emptyProject = presentProjectContextColdStartEmptyProject({
      facts,
      responseTimeMs: 3,
    });
    expect(emptyProject).toMatchObject({
      data: {
        message: 'No source files found, nothing to bootstrap',
        projectContext: { source: 'project-context' },
      },
      meta: { responseTimeMs: 3, tool: 'alembic_bootstrap' },
      success: true,
    });

    const rescan = presentProjectContextRescanResponse({
      auditSummary: { recipes: 2 },
      bootstrapSession: bootstrapSession as never,
      cleanResult: { clearedTables: ['project_context_cache'], deletedFiles: 4 },
      facts,
      gapPlan: {
        executionDimensions: [dimension],
        gapDimensions: [dimension],
        produceDimensions: [dimension],
        requestedDimensions: [dimension],
        skippedDimensions: [],
        targetPerDimension: 1,
      },
      inlineFill: {
        coverageSkippedDimensions: 0,
        coverageWrittenCells: 1,
        newRecipesThisRound: 2,
      },
      miningMode: 'deepMining',
      recipeSnapshot: { count: 2 },
      responseTimeMs: 19,
      sessionId: 'rescan-session-1',
    });

    expect(rescan).toMatchObject({
      data: {
        asyncFill: false,
        bootstrapSession: { id: 'bootstrap-session-1' },
        coverageLedger: { skippedDimensions: 0, writtenCells: 1 },
        gapAnalysis: {
          executionDimensions: 1,
          gapDimensions: 1,
          produceDimensions: 1,
          targetPerDimension: 1,
          totalDimensions: 1,
        },
        miningMode: 'deepMining',
        newRecipesThisRound: 2,
        primaryLanguage: 'typescript',
        projectContext: { source: 'project-context' },
        rescan: { cleanedFiles: 4, cleanedTables: 1, preservedRecipes: 2 },
        sessionId: 'rescan-session-1',
        status: 'complete',
      },
      meta: { responseTimeMs: 19, tool: 'alembic_rescan' },
      success: true,
    });
  });

  test('passes rescan evidence into ProjectContext mission briefing artifacts', async () => {
    const projectRoot = '/tmp/alembic-swift-target-project';
    mockSwiftTargetProjectContext(projectRoot);
    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-rescan',
    });

    const artifacts = buildProjectContextMissionArtifacts({
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      facts,
      profile: 'rescan',
      rescan: {
        evidencePlan: {
          allRecipes: [],
          coveredDimensions: 0,
          decayCount: 0,
          dimensionGaps: [],
          executionReasons: {},
          gapSummary: 'no existing recipes',
          occupiedTriggers: [],
          totalCreateBudget: 1,
          totalGap: 1,
        },
        prescreen: {
          autoResolved: [],
          dimensionGaps: {},
          needsVerification: [],
        },
      },
      session: { toJSON: () => ({ id: 'rescan-session' }) } as never,
    });

    expect(artifacts.briefing.meta).toMatchObject({ profile: 'rescan-host-agent' });
    expect(artifacts.hostAgentPacket.profile).toBe('rescan');
    expect(artifacts.ideAgentPacket).toBe(artifacts.hostAgentPacket);
    expect(artifacts.briefing.evidenceHints).toMatchObject({
      rescanMode: true,
      evolutionPrescreen: {
        autoResolved: [],
        needsVerification: [],
      },
    });
  });

  test('removes built-in Agent legacy adapter and carrier imports from workflow routes', async () => {
    await expect(
      stat(
        join(process.cwd(), 'lib/workflows/agent-project-context/AgentProjectContextAnalysis.ts')
      )
    ).rejects.toThrow();

    const coldStart = await readFile(
      join(process.cwd(), 'lib/recipe-pipeline/generate/ColdStartWorkflow.ts'),
      'utf8'
    );
    const rescan = await readFile(
      join(process.cwd(), 'lib/recipe-pipeline/generate/incremental/IncrementalRescanWorkflow.ts'),
      'utf8'
    );
    const combined = `${coldStart}\n${rescan}`;

    expect(combined).not.toContain('runAgentProjectContextAnalysis');
    expect(combined).not.toContain('AgentProjectContextAnalysis');
    expect(combined).not.toContain('buildProjectSnapshot');
    expect(combined).not.toContain('ProjectSnapshot');
    expect(combined).not.toContain('@alembic/core/workflows/capabilities/project-intelligence');
  });

  test('keeps the moduleSeeds detail loop separate from ProjectMap module fan-out facts', async () => {
    const source = await readFile(
      join(process.cwd(), 'lib/project-facts/ProjectContextWorkflowFacts.ts'),
      'utf8'
    );
    const mapModulesSource = await readFile(
      join(process.cwd(), 'lib/project-facts/ProjectMapModules.ts'),
      'utf8'
    );
    const presentersSource = await readFile(
      join(process.cwd(), 'lib/project-facts/ProjectContextPresenters.ts'),
      'utf8'
    );

    // F6：请求循环、种子推导与文件扫描都在 Core 的共用采集器里；主体只留 ProjectScope 展开与自己的派生。
    expect(source).toContain('await collectPlanProjectContext(collectRoot, undefined, {');
    expect(source).not.toContain('ProjectContextCapabilities');
    expect(source).not.toContain('selectProjectContextModuleSeeds');
    expect(source).not.toContain('PROJECT_SCOPE_LANGUAGE_BY_EXTENSION');
    expect(source).toContain('const projectMapModules = buildScopedProjectMapModules({');
    expect(source).toContain('projectMapModules,');
    expect(source).not.toContain('function buildProjectMapModules(map');
    expect(source).not.toContain('function presentProjectContextColdStartResponse');
    expect(mapModulesSource).toContain('export function buildProjectMapModules');
    expect(mapModulesSource).toContain('export async function buildProjectMapModulesFromTargets');
    expect(presentersSource).toContain('export function presentProjectContextColdStartResponse');
    expect(presentersSource).toContain('export function presentProjectContextRescanResponse');
  });
});

function mockSwiftTargetProjectContext(projectRoot: string): void {
  const targetRef = makeProjectContextRef(projectRoot, 'path:repo:Sources/AOXFoundationKit', {
    filePath: 'Sources/AOXFoundationKit',
    kind: 'path',
    label: 'Sources/AOXFoundationKit',
  });
  const fileRef = makeProjectContextRef(
    projectRoot,
    'file:repo:Sources/AOXFoundationKit/Client.swift',
    {
      filePath: 'Sources/AOXFoundationKit/Client.swift',
      kind: 'file',
      label: 'Client.swift',
    }
  );
  const repoRef = makeProjectContextRef(projectRoot, 'repo:repo', {
    kind: 'repo',
    label: 'SwiftTarget',
  });

  projectContextCapabilitiesMock.executeOverride = async (request) => {
    switch (request.kind) {
      case 'space':
        return projectContextEnvelope(projectRoot, 'space', {
          boundaries: [],
          nextRefs: [],
          repos: [],
          sourceFolders: [],
          space: { id: 'space', ref: repoRef },
          structuralHotspots: [],
        });
      case 'repo':
        return projectContextEnvelope(
          projectRoot,
          'repo',
          {
            buildSystems: [],
            commands: [],
            configFiles: [],
            entrypoints: [],
            languages: [{ fileCount: 1, language: 'swift' }],
            localPackages: [],
            nextRefs: [fileRef],
            packageSystems: [],
            repo: { name: 'SwiftTarget', ref: repoRef },
            sourceRoots: [],
            targets: [{ kind: 'target', name: 'AOXFoundationKit', refs: [targetRef] }],
            topAreas: [],
          },
          [repoRef, targetRef, fileRef]
        );
      case 'source-slice':
        return projectContextEnvelope(
          projectRoot,
          'source-slice',
          {
            file: {
              filePath: 'Sources/AOXFoundationKit/Client.swift',
              language: 'swift',
              lineCount: 1,
              ref: fileRef,
              repoId: 'repo',
            },
            nextRefs: [],
            range: { endLine: 1, startLine: 1 },
            text: 'public struct Client {}',
          },
          [fileRef]
        );
      case 'map':
      case 'module':
      case 'module-layers':
      case 'file-flow':
      case 'file-symbols':
      case 'anchor-range':
        return projectContextEnvelope(projectRoot, request.kind, {
          available: false,
          kind: request.kind,
          nextRefs: [fileRef],
          reason: 'fixture unavailable',
        });
      default:
        return projectContextEnvelope(projectRoot, request.kind, {
          available: false,
          kind: request.kind,
          nextRefs: [],
          reason: 'fixture unavailable',
        });
    }
  };
}

function mockBiliDiliLikeProjectContext(projectRoot: string, targetNames: readonly string[]): void {
  const rootRef = makeProjectContextRef(projectRoot, 'path:repo:.', {
    filePath: '.',
    kind: 'path',
    label: '.',
  });
  const packageRef = makeProjectContextRef(projectRoot, 'file:repo:Package.swift', {
    filePath: 'Package.swift',
    kind: 'file',
    label: 'Package.swift',
  });
  const repoRef = makeProjectContextRef(projectRoot, 'repo:repo', {
    kind: 'repo',
    label: 'BiliDili',
  });

  projectContextCapabilitiesMock.executeOverride = async (request) => {
    switch (request.kind) {
      case 'space':
        return projectContextEnvelope(projectRoot, 'space', {
          boundaries: [],
          nextRefs: [packageRef],
          repos: [],
          sourceFolders: [],
          space: { id: 'space', ref: repoRef },
          structuralHotspots: [],
        });
      case 'repo':
        return projectContextEnvelope(
          projectRoot,
          'repo',
          {
            buildSystems: [],
            commands: [],
            configFiles: [],
            entrypoints: [],
            languages: [{ fileCount: 1, language: 'swift' }],
            localPackages: [],
            nextRefs: [packageRef],
            packageSystems: [],
            repo: { name: 'BiliDili', ref: repoRef },
            sourceRoots: [],
            targets: targetNames.map((name) => ({ kind: 'target', name, refs: [rootRef] })),
            topAreas: [],
          },
          [repoRef, rootRef, packageRef]
        );
      case 'source-slice':
        return projectContextEnvelope(
          projectRoot,
          'source-slice',
          {
            file: {
              filePath: 'Package.swift',
              language: 'swift',
              lineCount: 30,
              ref: packageRef,
              repoId: 'repo',
            },
            nextRefs: [],
            range: { endLine: 30, startLine: 1 },
            text: 'let package = Package(name: "BiliDili")',
          },
          [packageRef]
        );
      case 'map':
      case 'module':
      case 'module-layers':
      case 'file-flow':
      case 'file-symbols':
      case 'anchor-range':
        return projectContextEnvelope(projectRoot, request.kind, {
          available: false,
          kind: request.kind,
          nextRefs: [packageRef],
          reason: 'fixture unavailable',
        });
      default:
        return projectContextEnvelope(projectRoot, request.kind, {
          available: false,
          kind: request.kind,
          nextRefs: [],
          reason: 'fixture unavailable',
        });
    }
  };
}

function mockLocalSwiftPackageProjectContext(projectRoot: string): void {
  const packageRef = makeProjectContextRef(projectRoot, 'path:repo:Packages/AOXFoundationKit', {
    filePath: 'Packages/AOXFoundationKit',
    kind: 'path',
    label: 'AOXFoundationKit',
  });
  const rootPackageRef = makeProjectContextRef(projectRoot, 'file:repo:Package.swift', {
    filePath: 'Package.swift',
    kind: 'file',
    label: 'Package.swift',
  });
  const repoRef = makeProjectContextRef(projectRoot, 'repo:repo', {
    kind: 'repo',
    label: 'BiliDili',
  });

  projectContextCapabilitiesMock.executeOverride = async (request) => {
    switch (request.kind) {
      case 'space':
        return projectContextEnvelope(projectRoot, 'space', {
          boundaries: [],
          nextRefs: [rootPackageRef],
          repos: [],
          sourceFolders: [],
          space: { id: 'space', ref: repoRef },
          structuralHotspots: [],
        });
      case 'repo':
        return projectContextEnvelope(
          projectRoot,
          'repo',
          {
            buildSystems: [],
            commands: [],
            configFiles: [],
            entrypoints: [],
            languages: [{ fileCount: 1, language: 'swift' }],
            localPackages: [
              { kind: 'package', name: 'AOXFoundationKit', path: 'Packages/AOXFoundationKit' },
            ],
            nextRefs: [rootPackageRef],
            packageSystems: [],
            repo: { name: 'BiliDili', ref: repoRef },
            sourceRoots: [],
            targets: [{ kind: 'target', name: 'AOXFoundationKit', refs: [packageRef] }],
            topAreas: [],
          },
          [repoRef, packageRef, rootPackageRef]
        );
      case 'source-slice':
        return projectContextEnvelope(
          projectRoot,
          'source-slice',
          {
            file: {
              filePath: 'Package.swift',
              language: 'swift',
              lineCount: 10,
              ref: rootPackageRef,
              repoId: 'repo',
            },
            nextRefs: [],
            range: { endLine: 10, startLine: 1 },
            text: 'let package = Package(name: "BiliDili")',
          },
          [rootPackageRef]
        );
      case 'map':
      case 'module':
      case 'module-layers':
      case 'file-flow':
      case 'file-symbols':
      case 'anchor-range':
        return projectContextEnvelope(projectRoot, request.kind, {
          available: false,
          kind: request.kind,
          nextRefs: [rootPackageRef],
          reason: 'fixture unavailable',
        });
      default:
        return projectContextEnvelope(projectRoot, request.kind, {
          available: false,
          kind: request.kind,
          nextRefs: [],
          reason: 'fixture unavailable',
        });
    }
  };
}

/**
 * 按 Core 采集器的顺序向夹具发请求（space → repo → map → 文件明细），把信封合成分析结果。
 * 源码清单与语言统计用真实的 Core 实现扫夹具目录（目录不存在时为空）。
 */
async function fakeCollectPlanProjectContext(
  projectRoot: string,
  options: PlanCollectOptions | undefined,
  execute: (request: ProjectContextRequestMock) => Promise<unknown>,
  actual: typeof import('@alembic/core/service/planFacts')
): Promise<PlanProjectContextAnalysis> {
  const envelopes: ProjectContextEnvelope<ProjectContextResult>[] = [];
  const push = async (kind: string, payload?: Record<string, unknown>) => {
    const envelope = (await execute({
      kind,
      payload,
      scope: { projectRoot },
    })) as ProjectContextEnvelope<ProjectContextResult>;
    envelopes.push(envelope);
    return envelope;
  };
  const folders = (options?.scope?.sourceFolders ?? []).map((folder) =>
    typeof folder === 'string' ? { path: folder } : { ...folder }
  );
  await push('space', {
    includeProjectTree: true,
    ...(folders.length > 0 ? { sourceFolders: folders } : {}),
  });
  const repoEnvelope = await push('repo', {
    includeMapSummary: false,
    ...(options?.scope?.repoRoot ? { repoRoot: options.scope.repoRoot } : {}),
  });
  const repo = repoEnvelope.data as RepoContext;
  await push('map', { moduleSeeds: [] });
  const sourceSliceLines = options?.limits?.sourceSliceLines ?? 0;
  const detailFiles = [
    ...new Set(
      envelopes.flatMap((envelope) =>
        envelope.refs.flatMap((ref) => (ref.scope.filePath ? [ref.scope.filePath] : []))
      )
    ),
  ]
    .sort()
    .slice(0, options?.limits?.maxFileDetails ?? 0);
  for (const filePath of detailFiles) {
    await push('file-flow', { filePath });
    await push('file-symbols', { filePath });
    if (sourceSliceLines > 0) {
      await push('source-slice', {
        endLine: sourceSliceLines,
        filePath,
        includeText: true,
        startLine: 1,
      });
    }
    await push('anchor-range', { filePath, line: 1 });
  }
  const presenterInput = buildProjectContextPresenterInput(envelopes);
  const sourceFileFacts: ProjectSourceFileFact[] = existsSync(projectRoot)
    ? await actual.collectProjectSourceFileFacts(projectRoot, {
        ...(options?.limits?.maxFiles ? { maxFiles: options.limits.maxFiles } : {}),
        sourceFolders: folders.map((folder) => folder.path),
      })
    : [];
  const languageStats: Record<string, number> = {};
  for (const fact of sourceFileFacts) {
    if (actual.isProjectCodeFile(fact.filePath, fact.language)) {
      languageStats[fact.language] = (languageStats[fact.language] ?? 0) + 1;
    }
  }
  const primaryLanguage =
    Object.entries(languageStats).sort(([, left], [, right]) => right - left)[0]?.[0] ??
    [...(repo?.languages ?? [])].sort(
      (left, right) => (right.fileCount ?? 0) - (left.fileCount ?? 0)
    )[0]?.language ??
    'unknown';
  const secondaryLanguages = Object.keys(languageStats)
    .filter((language) => language !== primaryLanguage)
    .sort();
  return {
    collection: {
      detailFiles,
      droppedModuleSeeds: [],
      filteredModuleSeeds: [],
      limits: {
        maxFileDetails: options?.limits?.maxFileDetails ?? 0,
        maxFiles: options?.limits?.maxFiles,
        maxModuleDetails: options?.limits?.maxModuleDetails,
        maxModuleSeeds: options?.limits?.maxModuleSeeds,
        sourceSliceLines,
      },
      scopeSource: options?.scope ? 'explicit' : 'project-root',
      seedSource: 'none',
      source: options?.source ?? 'codex-host-plan',
      sourceScanTruncated: false,
    },
    contextStatus: 'complete',
    dimensions: [...baseDimensions],
    envelopes,
    factSource: 'project-context',
    fileCount: Math.max(presenterInput.files.length, sourceFileFacts.length),
    frameworks: [],
    isEmpty: presenterInput.files.length === 0 && presenterInput.refs.length === 0,
    isMultiLang: secondaryLanguages.length > 0,
    languageStats,
    moduleCount: presenterInput.map?.modules.length ?? 0,
    moduleSeeds: [],
    modules: [],
    presenterInput,
    primaryLanguage,
    projectType:
      repo?.packageSystems?.[0]?.kind ??
      repo?.buildSystems?.[0]?.kind ??
      repo?.repo?.name ??
      'project-context',
    requestKinds: [...new Set(envelopes.map((envelope) => envelope.queryLevel))],
    secondaryLanguages,
    sourceFileFacts,
    understandingGaps: [],
  };
}

function projectContextEnvelope(
  projectRoot: string,
  queryLevel: string,
  data: Record<string, unknown>,
  refs: Array<Record<string, unknown>> = []
) {
  return {
    contractVersion: 1,
    data,
    project: { displayName: 'SwiftTarget', projectRoot },
    queryLevel,
    refs,
  } as never;
}

function makeProjectContextRef(
  projectRoot: string,
  id: string,
  input: {
    filePath?: string;
    kind: string;
    label: string;
  }
): Record<string, unknown> {
  return {
    id,
    kind: input.kind,
    label: input.label,
    level: 'repo',
    scope: {
      filePath: input.filePath,
      projectRoot,
      repoId: 'repo',
    },
  };
}

function createSessionContainer(manager: GenerateSessionManager, eventBus: EventEmitter) {
  return {
    get(name: string) {
      if (name === 'generateSessionManager') {
        return manager;
      }
      if (name === 'eventBus') {
        return eventBus;
      }
      return null;
    },
  };
}

function createSessionLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createWorkflowDimensions(): DimensionDef[] {
  return [{ id: 'architecture', label: 'Architecture' }];
}

function createWorkflowFacts(projectRoot: string): ProjectContextWorkflowFacts {
  return {
    fileCount: 1,
    moduleCount: 1,
    primaryLang: 'typescript',
    projectRoot,
  } as ProjectContextWorkflowFacts;
}

function createPresenterFacts(projectRoot: string): ProjectContextWorkflowFacts {
  return {
    allTargets: [{ fileCount: 1, name: 'project', type: 'target' }],
    fileCount: 1,
    filesByTarget: {
      project: [{ name: 'index.ts', path: 'lib/index.ts', relativePath: 'lib/index.ts' }],
    },
    languageStats: { typescript: 1 },
    moduleCount: 1,
    primaryLang: 'typescript',
    projectContextSummary: { source: 'project-context' },
    projectRoot,
    report: { projectInformationSource: 'project-context' },
    secondaryLanguages: [],
    targetCount: 1,
    warnings: [],
  } as unknown as ProjectContextWorkflowFacts;
}

function completedBootstrapTask() {
  return {
    id: 'architecture',
    status: 'completed',
    result: {
      created: 1,
      status: 'v3-pipeline-complete',
      type: 'candidate',
    },
  };
}
