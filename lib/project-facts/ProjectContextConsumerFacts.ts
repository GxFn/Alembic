import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ProjectContextEnvelope,
  ProjectContextRef,
  ProjectContextResult,
  ProjectMap,
  RepoContext,
} from '@alembic/core/project-context';
import { ProjectContextCapabilities } from '@alembic/core/project-context-capabilities';
import type { ProjectFolderDescriptor } from '@alembic/core/shared';
import { LanguageService } from '@alembic/core/shared';
import { ProjectScopeRegistryStore } from '../project-scope/ProjectScopeRegistry.js';

const PROJECT_CONTEXT_SOURCE = 'alembic-main-consumer';

export interface ProjectContextTargetEntry {
  [key: string]: unknown;
  name: string;
  type: string;
  path: string;
  packageName: string;
  packagePath: string;
  targetDir: string;
  info: Record<string, unknown>;
  metadata: Record<string, unknown>;
  refs: ProjectContextRef[];
  fileCount: number;
  discovererId: 'project-context';
  discovererName: 'ProjectContext';
  language: string;
  projectInformationSource: 'project-context';
}

export interface ProjectContextFileEntry {
  [key: string]: unknown;
  name: string;
  path: string;
  relativePath: string;
  language: string;
  size: number;
  targetName?: string;
  projectInformationSource: 'project-context';
}

export interface ProjectContextDependencyGraph {
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ from: string; to: string; type: string; source: string }>;
  projectRoot: string;
  generatedAt: string;
  dependencySummary?: Record<string, unknown>;
  projectInformationSource: 'project-context';
}

interface ProjectContextTargetSummaryLike {
  name: string;
  kind?: string;
  refs: ProjectContextRef[];
}

export async function loadProjectContextRepo(projectRoot: string): Promise<RepoContext> {
  const projectScopeRepo = loadProjectScopeControlRootRepo(projectRoot);
  if (projectScopeRepo) {
    return projectScopeRepo;
  }

  const envelope = await executeProjectContextRequest('repo', projectRoot, {
    includeMapSummary: true,
  });
  if (!isRepoContext(envelope.data)) {
    throw new Error('ProjectContext repo facts unavailable');
  }
  return envelope.data;
}

export async function loadProjectContextMap(
  projectRoot: string,
  repo?: RepoContext
): Promise<ProjectMap | null> {
  const moduleSeeds = selectModuleSeeds(repo).slice(0, 12);
  const envelope = await executeProjectContextRequest('map', projectRoot, {
    moduleSeeds,
    repoName: repo?.repo.name,
  });
  return isProjectMapContext(envelope.data) ? envelope.data : null;
}

export function projectContextTargets(
  repo: RepoContext,
  projectRoot: string
): ProjectContextTargetEntry[] {
  const targets = repo.targets.length
    ? repo.targets
    : repo.sourceRoots.map(
        (root): ProjectContextTargetSummaryLike => ({
          kind: root.role ?? 'source-root',
          name: basename(root.path) || root.path,
          refs: root.ref ? [root.ref] : [],
        })
      );

  return targets.map((target) => {
    const targetPath = targetPathFromRefs(target.refs, projectRoot);
    return {
      name: target.name,
      type: target.kind ?? 'target',
      path: targetPath,
      packageName: target.name,
      packagePath: targetPath,
      targetDir: targetPath,
      info: {
        fileCount: target.refs.length,
        kind: target.kind ?? 'target',
        source: PROJECT_CONTEXT_SOURCE,
      },
      metadata: {
        refs: target.refs.map((ref) => ref.id),
      },
      refs: target.refs,
      fileCount: target.refs.length,
      discovererId: 'project-context',
      discovererName: 'ProjectContext',
      language: inferTargetLanguage(target.refs),
      projectInformationSource: 'project-context',
    };
  });
}

export function projectContextFilesForTarget(
  target: ProjectContextTargetEntry | Record<string, unknown>,
  projectRoot: string
): ProjectContextFileEntry[] {
  const refs = Array.isArray((target as ProjectContextTargetEntry).refs)
    ? ((target as ProjectContextTargetEntry).refs as ProjectContextRef[])
    : [];
  const targetName = typeof target.name === 'string' ? target.name : undefined;
  return refs
    .flatMap((ref) => (ref.scope.filePath ? [ref.scope.filePath] : []))
    .filter((filePath, index, files) => files.indexOf(filePath) === index)
    .map((filePath) => fileEntryFromPath(filePath, projectRoot, targetName));
}

export async function projectContextModuleFiles(
  projectRoot: string
): Promise<Map<string, string[]>> {
  const repo = await loadProjectContextRepo(projectRoot);
  const moduleFiles = new Map<string, string[]>();
  for (const target of projectContextTargets(repo, projectRoot)) {
    const files = projectContextFilesForTarget(target, projectRoot).map((file) => file.path);
    if (files.length > 0) {
      moduleFiles.set(target.name, files);
    }
  }
  return moduleFiles;
}

export async function projectContextDependencyGraph(
  projectRoot: string,
  repo?: RepoContext
): Promise<ProjectContextDependencyGraph> {
  const resolvedRepo = repo ?? (await loadProjectContextRepo(projectRoot));
  if (isProjectScopeControlRootRepo(resolvedRepo)) {
    const targets = projectContextTargets(resolvedRepo, projectRoot);
    return {
      nodes: targets.map((target) => ({
        id: `project-scope:${target.name}`,
        label: target.name,
        packageDir: target.path,
        projectInformationSource: 'project-scope',
        role: target.type,
        type: 'project-scope-folder',
      })),
      edges: [],
      projectRoot,
      generatedAt: new Date().toISOString(),
      dependencySummary: {
        edgeCount: 0,
        notes: ['ProjectScope control root graph is bounded to registered member folders.'],
      },
      projectInformationSource: 'project-context',
    };
  }
  const map = await loadProjectContextMap(projectRoot, resolvedRepo);
  const targets = projectContextTargets(resolvedRepo, projectRoot);
  const nodes =
    map?.modules.map((module) => ({
      id: module.id,
      label: module.name,
      type: module.kind ?? 'module',
      role: module.role,
      fileCount: module.ownedFileCount,
      projectInformationSource: 'project-context',
    })) ??
    targets.map((target) => ({
      id: target.name,
      label: target.name,
      type: target.type,
      fileCount: target.fileCount,
      projectInformationSource: 'project-context',
    }));

  return {
    nodes,
    edges: [],
    projectRoot,
    generatedAt: new Date().toISOString(),
    dependencySummary: map?.dependencySummary
      ? {
          edgeCount: map.dependencySummary.edgeCount,
          notes: map.dependencySummary.notes,
        }
      : undefined,
    projectInformationSource: 'project-context',
  };
}

export function projectContextProjectInfo(repo: RepoContext, projectRoot: string) {
  const languages = repo.languages.map((language) => language.language);
  const primaryLanguage =
    [...repo.languages].sort((left, right) => (right.fileCount ?? 0) - (left.fileCount ?? 0))[0]
      ?.language ?? 'unknown';
  return {
    projectRoot,
    projectName: repo.repo.name || basename(projectRoot),
    primaryLanguage,
    discoverers: [
      {
        confidence: 1,
        id: 'project-context',
        name: 'ProjectContext',
      },
    ],
    languages,
    hasSpm: repo.packageSystems.some((system) => system.kind === 'spm'),
    projectInformationSource: 'project-context',
  };
}

function executeProjectContextRequest(
  kind: 'repo' | 'map',
  projectRoot: string,
  payload?: Record<string, unknown>
): Promise<ProjectContextEnvelope<ProjectContextResult>> {
  return ProjectContextCapabilities.execute({
    kind,
    payload,
    project: {
      displayName: basename(projectRoot),
      projectRoot,
      source: PROJECT_CONTEXT_SOURCE,
    },
    scope: {
      projectRoot,
    },
  });
}

function loadProjectScopeControlRootRepo(projectRootInput: string): RepoContext | null {
  const projectRoot = resolve(projectRootInput);
  const resolved = new ProjectScopeRegistryStore().resolveFolder(projectRoot);
  const projectScope = resolved?.projectScope ?? null;
  if (!projectScope || !pathsEquivalent(projectScope.controlRoot.path, projectRoot)) {
    return null;
  }

  const folders = [...projectScope.folders].sort((left, right) =>
    left.displayName.localeCompare(right.displayName)
  );
  if (folders.length === 0) {
    return null;
  }

  const repoRef = createProjectScopeRef({
    id: `project-scope:${projectScope.projectScopeId}:repo`,
    kind: 'repo',
    label: projectScope.displayName,
    projectRoot,
  });
  const targetRefs = folders.map((folder) => createProjectScopeFolderRef(projectRoot, folder));

  return {
    repo: {
      id: projectScope.projectScopeId,
      name: projectScope.displayName || basename(projectRoot),
      root: projectRoot,
      ref: repoRef,
    },
    languages: [],
    buildSystems: [],
    packageSystems: [],
    targets: folders.map((folder, index) => ({
      name: folder.displayName || basename(folder.path),
      kind: folder.role ?? 'source',
      refs: [targetRefs[index] as ProjectContextRef],
    })),
    localPackages: [],
    sourceRoots: folders.map((folder, index) => ({
      path: folder.path,
      role: folder.role ?? 'source',
      exists: existsSync(folder.path),
      ref: targetRefs[index],
    })),
    entrypoints: [],
    commands: [],
    topAreas: [],
    configFiles: [],
    mapSummary: {
      moduleCount: folders.length,
      layerCount: 1,
      dependencyEdgeCount: 0,
      cycleCount: 0,
      hotspotCount: 0,
      nextRefs: targetRefs,
    },
    nextRefs: targetRefs,
  };
}

function isProjectScopeControlRootRepo(repo: RepoContext): boolean {
  return repo.repo.ref?.metadata?.producer === 'alembic-project-scope-control-root';
}

function createProjectScopeFolderRef(
  projectRoot: string,
  folder: ProjectFolderDescriptor
): ProjectContextRef {
  return createProjectScopeRef({
    id: `project-scope:${folder.id}`,
    kind: 'path',
    label: folder.displayName || basename(folder.path),
    projectRoot,
    filePath: folder.path,
    metadata: {
      folderId: folder.id,
      folderPath: folder.path,
      pathKind: 'directory',
      producer: 'alembic-project-scope-control-root',
      role: folder.role ?? 'source',
    },
  });
}

function createProjectScopeRef(input: {
  filePath?: string;
  id: string;
  kind: ProjectContextRef['kind'];
  label: string;
  metadata?: ProjectContextRef['metadata'];
  projectRoot: string;
}): ProjectContextRef {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    scope: {
      projectRoot: input.projectRoot,
      ...(input.filePath ? { filePath: input.filePath } : {}),
    },
    metadata: {
      producer: 'alembic-project-scope-control-root',
      ...(input.metadata ?? {}),
    },
  };
}

function targetPathFromRefs(refs: readonly ProjectContextRef[], projectRoot: string): string {
  const filePath = refs.find((ref) => ref.scope.filePath)?.scope.filePath;
  if (!filePath) {
    return projectRoot;
  }
  const absoluteFile = resolveProjectFilePath(filePath, projectRoot);
  if (isExistingDirectory(absoluteFile)) {
    return absoluteFile;
  }
  return dirname(absoluteFile);
}

function fileEntryFromPath(
  filePath: string,
  projectRoot: string,
  targetName?: string
): ProjectContextFileEntry {
  const absolutePath = resolveProjectFilePath(filePath, projectRoot);
  const relativePath = pathRelativeToProject(absolutePath, projectRoot);
  return {
    name: basename(absolutePath),
    path: absolutePath,
    relativePath,
    language: LanguageService.inferLang(absolutePath) || 'unknown',
    size: safeFileSize(absolutePath),
    targetName,
    projectInformationSource: 'project-context',
  };
}

function resolveProjectFilePath(filePath: string, projectRoot: string): string {
  return isAbsolute(filePath) ? filePath : join(projectRoot, filePath);
}

function pathRelativeToProject(filePath: string, projectRoot: string): string {
  const rel = relative(projectRoot, filePath);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) {
    return filePath;
  }
  return rel;
}

function safeFileSize(filePath: string): number {
  try {
    return existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function isExistingDirectory(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function pathsEquivalent(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) {
    return false;
  }
  return resolve(left) === resolve(right);
}

function inferTargetLanguage(refs: readonly ProjectContextRef[]): string {
  const firstFile = refs.find((ref) => ref.scope.filePath)?.scope.filePath;
  return firstFile ? LanguageService.inferLang(firstFile) || 'unknown' : 'unknown';
}

function selectModuleSeeds(repo: RepoContext | undefined): Array<Record<string, unknown>> {
  if (!repo) {
    return [];
  }
  const seeds: Array<Record<string, unknown>> = [
    ...repo.localPackages.map((pkg) => ({
      kind: 'local-package',
      moduleName: pkg.name,
      modulePath: pkg.path ?? pkg.ref?.scope.filePath,
      ref: pkg.ref,
      role: 'local-package',
    })),
    ...repo.sourceRoots.map((root) => ({
      kind: 'source-root',
      moduleName: basename(root.path) || root.path,
      modulePath: root.path,
      ref: root.ref,
      role: root.role ?? 'source-root',
    })),
    ...repo.targets.flatMap((target) =>
      target.refs.flatMap((ref) => {
        if (!ref.scope.filePath) {
          return [];
        }
        return [
          {
            kind: 'file-anchor',
            moduleName: basename(dirname(ref.scope.filePath)) || target.name,
            ownedFiles: [ref.scope.filePath],
            ref,
            role: target.kind ?? 'target',
          },
        ];
      })
    ),
  ];
  return seeds.filter((seed) => seed.modulePath || seed.ownedFiles);
}

function isRepoContext(value: ProjectContextResult): value is RepoContext {
  return (
    !!value &&
    typeof value === 'object' &&
    'repo' in value &&
    'targets' in value &&
    Array.isArray((value as RepoContext).targets)
  );
}

function isProjectMapContext(value: ProjectContextResult): value is ProjectMap {
  return (
    !!value &&
    typeof value === 'object' &&
    'modules' in value &&
    'dependencySummary' in value &&
    Array.isArray((value as ProjectMap).modules)
  );
}
