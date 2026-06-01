import {
  type ProjectAnalysisResult,
  type ProjectAnalysisScanOptions,
} from '@alembic/core/project-intelligence';
import type { ProjectDescriptor } from '@alembic/core/shared';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { resolveAlembicWorkspace } from './ProjectScopeRegistry.js';

interface ContainerLike {
  singletons?: {
    _workspaceResolver?: unknown;
    [key: string]: unknown;
  };
}

interface WorkspaceResolverLike {
  currentFolderId: string | null;
  dataRoot: string;
  projectRoot: string;
  projectScope: ProjectDescriptor | null;
}

export interface ProjectScopeAnalysisContext {
  controlRoot: string | null;
  currentFolderId: string | null;
  dataRoot: string;
  folderCount: number;
  projectRoot: string;
  projectScope: ProjectDescriptor | null;
  projectScopeId: string | null;
}

export interface ProjectScopeSourceIdentity {
  absolutePath: string | null;
  folderDisplayName: string | null;
  folderId: string | null;
  folderPath: string | null;
  folderRelativeRoot: string | null;
  legacyPath: string;
  projectScopeId: string | null;
  qualifiedPath: string;
  relativePath: string;
}

// Alembic 侧只做结构化适配：新 Core 会产出 sourceIdentity，旧 Core 没有该字段时保持空集合。
export function resolveProjectScopeAnalysisContext(
  container: ContainerLike | null | undefined
): ProjectScopeAnalysisContext {
  const projectRoot = resolveProjectRoot(container);
  const resolver = getContainerWorkspaceResolver(container) ?? resolveAlembicWorkspace(projectRoot);
  const projectScope = resolver.projectScope ?? null;
  const dataRoot = resolver.dataRoot || resolveDataRoot(container);

  return {
    controlRoot: projectScope?.controlRoot.path ?? null,
    currentFolderId: resolver.currentFolderId ?? projectScope?.currentFolderId ?? null,
    dataRoot,
    folderCount: projectScope?.folders.length ?? 0,
    projectRoot: resolver.projectRoot || projectRoot,
    projectScope,
    projectScopeId: projectScope?.projectScopeId ?? null,
  };
}

export function attachProjectScopeToScanOptions<T extends ProjectAnalysisScanOptions>(
  scan: T,
  analysis: ProjectScopeAnalysisContext
): T {
  if (!analysis.projectScope || analysis.folderCount === 0) {
    return scan;
  }
  return {
    ...scan,
    projectScope: analysis.projectScope,
  };
}

export function buildProjectScopeAnalysisLogMeta(
  analysis: ProjectScopeAnalysisContext
): Record<string, unknown> {
  return {
    controlRoot: analysis.controlRoot,
    currentFolderId: analysis.currentFolderId,
    dataRoot: analysis.dataRoot,
    folderCount: analysis.folderCount,
    projectRoot: analysis.projectRoot,
    projectScopeId: analysis.projectScopeId,
    sourceFolders: analysis.projectScope?.folders.map((folder) => ({
      displayName: folder.displayName,
      folderId: folder.id,
      path: folder.path,
      role: folder.role,
    })),
  };
}

export function collectProjectScopeSourceIdentities(
  result: ProjectAnalysisResult
): ProjectScopeSourceIdentity[] {
  return result.allFiles
    .map((file) => getFileSourceIdentity(file))
    .filter((identity): identity is ProjectScopeSourceIdentity => Boolean(identity));
}

function getContainerWorkspaceResolver(
  container: ContainerLike | null | undefined
): WorkspaceResolverLike | null {
  const candidate = container?.singletons?._workspaceResolver;
  if (!isRecord(candidate)) {
    return null;
  }
  const projectRoot = stringValue(candidate.projectRoot);
  const dataRoot = stringValue(candidate.dataRoot);
  if (!projectRoot || !dataRoot) {
    return null;
  }
  return {
    currentFolderId: nullableStringValue(candidate.currentFolderId),
    dataRoot,
    projectRoot,
    projectScope: isProjectDescriptor(candidate.projectScope) ? candidate.projectScope : null,
  };
}

function isProjectDescriptor(value: unknown): value is ProjectDescriptor {
  return (
    isRecord(value) &&
    typeof value.projectScopeId === 'string' &&
    isRecord(value.controlRoot) &&
    typeof value.controlRoot.path === 'string' &&
    Array.isArray(value.folders)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getFileSourceIdentity(file: unknown): ProjectScopeSourceIdentity | null {
  if (!isRecord(file)) {
    return null;
  }
  return isProjectScopeSourceIdentity(file.sourceIdentity) ? file.sourceIdentity : null;
}

function isProjectScopeSourceIdentity(value: unknown): value is ProjectScopeSourceIdentity {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNullableString(value.absolutePath) &&
    isNullableString(value.folderDisplayName) &&
    isNullableString(value.folderId) &&
    isNullableString(value.folderPath) &&
    isNullableString(value.folderRelativeRoot) &&
    typeof value.legacyPath === 'string' &&
    isNullableString(value.projectScopeId) &&
    typeof value.qualifiedPath === 'string' &&
    typeof value.relativePath === 'string'
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
