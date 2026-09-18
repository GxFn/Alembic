import { stripSourceRangeSuffix } from '@alembic/core/knowledge';
import {
  buildProjectScopeSourceRefIndex,
  type ProjectDescriptor,
  type ProjectScopeSourceRefIndex,
  resolveProjectScopeSourceRef,
} from '@alembic/core/shared';
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
  projectScopeId: string | null;
  qualifiedPath: string;
  relativePath: string;
}

export const PROJECT_SCOPE_SOURCE_IDENTITY_MAP_CONTRACT = 'ProjectScopeSourceIdentityMap';
export const PROJECT_SCOPE_SOURCE_IDENTITY_MAP_CONTRACT_VERSION = 1;

export interface ProjectScopeSourceIdentityMapEntry {
  absolutePath: string | null;
  folderDisplayName: string | null;
  folderId: string | null;
  folderPath: string | null;
  folderRelativeRoot: string | null;
  projectScopeId: string | null;
  qualifiedPath: string;
  relativePath: string;
}

export interface ProjectScopeSourceIdentityMap {
  contract: typeof PROJECT_SCOPE_SOURCE_IDENTITY_MAP_CONTRACT;
  contractVersion: typeof PROJECT_SCOPE_SOURCE_IDENTITY_MAP_CONTRACT_VERSION;
  entries: ProjectScopeSourceIdentityMapEntry[];
  preferredRef: 'qualifiedPath';
  rejectPolicy: {
    missingPath: 'reject';
  };
  sourceCount: number;
}

export type ProjectScopeSourceRefNormalizationReason =
  | 'qualified-path'
  | 'absolute-path'
  | 'ambiguous-path'
  | 'not-found';
export type ProjectScopeSourceRefNormalizationStatus = 'active' | 'missing' | 'ambiguous';

export interface NormalizedProjectScopeSourceRef {
  absolutePath: string | null;
  folderDisplayName: string | null;
  folderId: string | null;
  folderPath: string | null;
  input: string;
  normalizedRef: string | null;
  projectScopeId: string | null;
  qualifiedPath: string | null;
  reason: ProjectScopeSourceRefNormalizationReason;
  relativePath: string | null;
  status: ProjectScopeSourceRefNormalizationStatus;
}

export interface ProjectScopeRejectedSourceRef extends NormalizedProjectScopeSourceRef {
  input: string;
}

export interface ProjectScopeSourceRefNormalizationResult {
  activeSourceRefs: string[];
  normalized: NormalizedProjectScopeSourceRef[];
  rejected: ProjectScopeRejectedSourceRef[];
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

export function attachProjectScopeToScanOptions<T extends Record<string, unknown>>(
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

export function collectProjectScopeSourceIdentities(result: {
  allFiles: unknown;
}): ProjectScopeSourceIdentity[] {
  return collectProjectScopeSourceIdentitiesFromFiles(result.allFiles);
}

export function collectProjectScopeSourceIdentitiesFromFiles(
  files: unknown
): ProjectScopeSourceIdentity[] {
  if (!Array.isArray(files)) {
    return [];
  }
  return files
    .map((file) => (isProjectScopeSourceIdentity(file) ? file : getFileSourceIdentity(file)))
    .filter((identity): identity is ProjectScopeSourceIdentity => Boolean(identity));
}

export function buildProjectScopeSourceIdentityMap(
  sourceIdentities: readonly ProjectScopeSourceIdentity[]
): ProjectScopeSourceIdentityMap | null {
  const identities = dedupeSourceIdentities(sourceIdentities);
  if (identities.length === 0) {
    return null;
  }
  return {
    contract: PROJECT_SCOPE_SOURCE_IDENTITY_MAP_CONTRACT,
    contractVersion: PROJECT_SCOPE_SOURCE_IDENTITY_MAP_CONTRACT_VERSION,
    entries: identities.map((identity) => ({
      absolutePath: identity.absolutePath,
      folderDisplayName: identity.folderDisplayName,
      folderId: identity.folderId,
      folderPath: identity.folderPath,
      folderRelativeRoot: identity.folderRelativeRoot,
      projectScopeId: identity.projectScopeId,
      qualifiedPath: identity.qualifiedPath,
      relativePath: identity.relativePath,
    })),
    preferredRef: 'qualifiedPath',
    rejectPolicy: {
      missingPath: 'reject',
    },
    sourceCount: identities.length,
  };
}

export function normalizeProjectScopeSourceRefsForRuntime(
  sourceRefs: readonly string[],
  sourceIdentities: readonly ProjectScopeSourceIdentity[]
): ProjectScopeSourceRefNormalizationResult {
  const rawRefs = uniqueStrings(sourceRefs);
  const identities = dedupeSourceIdentities(sourceIdentities);
  if (identities.length === 0) {
    return {
      activeSourceRefs: rawRefs,
      normalized: [],
      rejected: [],
    };
  }

  const index = buildProjectScopeSourceIdentityIndex(identities);
  const activeSourceRefs: string[] = [];
  const normalized: NormalizedProjectScopeSourceRef[] = [];
  const rejected: ProjectScopeRejectedSourceRef[] = [];

  for (const rawRef of rawRefs) {
    const { pathPart, suffix } = splitSourceRefLocation(rawRef);
    const result = normalizeProjectScopeSourceRefForRuntime(pathPart, index);
    if (result.status === 'active' && result.normalizedRef) {
      const normalizedRef = `${result.normalizedRef}${suffix}`;
      activeSourceRefs.push(normalizedRef);
      normalized.push({
        ...result,
        input: rawRef,
        normalizedRef,
      });
      continue;
    }
    rejected.push({
      ...result,
      input: rawRef,
    });
  }

  return {
    activeSourceRefs: uniqueStrings(activeSourceRefs),
    normalized,
    rejected,
  };
}

function normalizeProjectScopeSourceRefForRuntime(
  sourceRef: string,
  index: ProjectScopeSourceIdentityIndex
): NormalizedProjectScopeSourceRef {
  const resolution = resolveProjectScopeSourceRef(sourceRef, index);
  // Main既有政策只接受qualified ref；新增明确绝对identity不能退回歧义显示名。
  // 不使用Core的单folder relative fallback，避免改变旧宿主准入规则。
  if (
    resolution.identity &&
    (resolution.reason === 'qualified-path' || resolution.reason === 'absolute-path')
  ) {
    return normalizedActiveSourceRef(sourceRef, resolution.identity, resolution.reason);
  }
  if (resolution.status === 'ambiguous') {
    return normalizedRejectedSourceRef(sourceRef, 'ambiguous-path', 'ambiguous');
  }
  return normalizedRejectedSourceRef(sourceRef, 'not-found', 'missing');
}

export function attachProjectScopeSourceIdentitiesToView<T extends object>(
  view: T,
  sourceIdentities: readonly ProjectScopeSourceIdentity[]
): T {
  const identities = dedupeSourceIdentities(sourceIdentities);
  if (identities.length === 0) {
    return view;
  }
  return {
    ...view,
    projectScopeSourceIdentities: identities,
    projectScopeSourceIdentityMap: buildProjectScopeSourceIdentityMap(identities),
  };
}

export function resolveProjectScopeSourceIdentitiesFromCarrier(
  value: unknown
): ProjectScopeSourceIdentity[] {
  const record = isRecord(value) ? value : null;
  const explicit = collectProjectScopeSourceIdentitiesFromFiles(
    record?.projectScopeSourceIdentities
  );
  if (explicit.length > 0) {
    return explicit;
  }
  const snapshot = isRecord(record?.snapshot) ? record.snapshot : null;
  return collectProjectScopeSourceIdentitiesFromFiles(snapshot?.allFiles);
}

export function resolveProjectScopeSourceIdentitiesFromContainer(
  container: ContainerLike | null | undefined
): ProjectScopeSourceIdentity[] {
  return collectProjectScopeSourceIdentitiesFromFiles(
    container?.singletons?._projectScopeSourceIdentities
  );
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
    isNullableString(value.projectScopeId) &&
    typeof value.qualifiedPath === 'string' &&
    typeof value.relativePath === 'string'
  );
}

function dedupeSourceIdentities(
  identities: readonly ProjectScopeSourceIdentity[]
): ProjectScopeSourceIdentity[] {
  const byIdentity = new Map<string, ProjectScopeSourceIdentity>();
  for (const identity of identities) {
    if (!identity.qualifiedPath.trim()) {
      continue;
    }
    // 显示名不是folder身份；两个common目录必须都抵达Core，不能先在adapter丢失一个。
    const key = JSON.stringify([
      identity.projectScopeId,
      identity.folderId ?? identity.folderPath,
      identity.relativePath,
      identity.absolutePath,
    ]);
    byIdentity.set(key, identity);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.qualifiedPath.localeCompare(right.qualifiedPath)
  );
}

type ProjectScopeSourceIdentityIndex = ProjectScopeSourceRefIndex;

function buildProjectScopeSourceIdentityIndex(
  identities: readonly ProjectScopeSourceIdentity[]
): ProjectScopeSourceIdentityIndex {
  return buildProjectScopeSourceRefIndex(identities);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function splitSourceRefLocation(sourceRef: string): { pathPart: string; suffix: string } {
  const trimmed = sourceRef.trim();
  // 与Core仓储/漂移检查共用同一范围语义，保留原行号/片段后缀，不把歧义误写成missing。
  const pathPart = stripSourceRangeSuffix(trimmed);
  return {
    pathPart,
    suffix: trimmed.slice(pathPart.length),
  };
}

function normalizedActiveSourceRef(
  input: string,
  identity: ProjectScopeSourceIdentity,
  reason: ProjectScopeSourceRefNormalizationReason
): NormalizedProjectScopeSourceRef {
  return {
    absolutePath: identity.absolutePath,
    folderDisplayName: identity.folderDisplayName,
    folderId: identity.folderId,
    folderPath: identity.folderPath,
    input,
    normalizedRef: reason === 'absolute-path' ? input : identity.qualifiedPath,
    projectScopeId: identity.projectScopeId,
    qualifiedPath: identity.qualifiedPath,
    reason,
    relativePath: identity.relativePath,
    status: 'active',
  };
}

function normalizedRejectedSourceRef(
  input: string,
  reason: ProjectScopeSourceRefNormalizationReason,
  status: ProjectScopeSourceRefNormalizationStatus
): NormalizedProjectScopeSourceRef {
  return {
    absolutePath: null,
    folderDisplayName: null,
    folderId: null,
    folderPath: null,
    input,
    normalizedRef: null,
    projectScopeId: null,
    qualifiedPath: null,
    reason,
    relativePath: null,
    status,
  };
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
