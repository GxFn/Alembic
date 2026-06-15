import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  ProjectContextEnvelope,
  ProjectContextRef,
  ProjectContextResult,
  ProjectMap,
  RepoContext,
} from '@alembic/core/project-context';
import { ProjectContext } from '@alembic/core/project-context';
import { LanguageService } from '@alembic/core/shared';

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
  return ProjectContext.execute({
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

function targetPathFromRefs(refs: readonly ProjectContextRef[], projectRoot: string): string {
  const filePath = refs.find((ref) => ref.scope.filePath)?.scope.filePath;
  if (!filePath) {
    return projectRoot;
  }
  const absoluteFile = resolveProjectFilePath(filePath, projectRoot);
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
