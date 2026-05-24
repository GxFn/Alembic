import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DaemonPaths } from '@alembic/core/daemon';
import {
  addProjectScopeFolder,
  type CreateProjectFolderDescriptorInput,
  createProjectDescriptor,
  createProjectScopeEndpointCapability,
  createProjectScopeRegistryDocument,
  type ProjectDescriptor,
  type ProjectFolderDescriptor,
  type ProjectScopeEndpointCapability,
  type ProjectScopeFolderRole,
  type ProjectScopeRegistryDocument,
  type ProjectScopeResolution,
  type ProjectScopeSummary,
  resolveProjectScopeForFolder,
  resolveProjectScopeRegistryFolder,
  summarizeProjectScopeDescriptor,
  upsertProjectScopeInRegistry,
} from '@alembic/core/shared';
import {
  generateProjectId,
  getGhostWorkspaceDir,
  getProjectRegistryDir,
  WorkspaceResolver,
} from '@alembic/core/workspace';

export const PROJECT_SCOPE_REGISTRY_FILENAME = 'project-scopes.json';

export interface ProjectScopeRegistryStoreOptions {
  now?: () => string;
  registryPath?: string;
}

export interface AddProjectScopeFolderOptions {
  controlRoot?: string | null;
  displayName?: string | null;
  folderPath: string;
  projectScopeId?: string | null;
  role?: ProjectScopeFolderRole | null;
}

export interface ProjectScopeRecord {
  projectScope: ProjectDescriptor;
  resolution: ProjectScopeResolution | null;
  summary: ProjectScopeSummary;
}

export interface ProjectScopeFolderAddResult extends ProjectScopeRecord {
  addedFolder: ProjectFolderDescriptor;
  capability: ProjectScopeEndpointCapability;
  registryPath: string;
}

export interface ProjectScopeResolveResult extends ProjectScopeRecord {
  capability: ProjectScopeEndpointCapability;
  registryPath: string;
}

export function getProjectScopeRegistryPath(): string {
  return join(getProjectRegistryDir(), PROJECT_SCOPE_REGISTRY_FILENAME);
}

export function createProjectScopeCapability(available = true): ProjectScopeEndpointCapability {
  return createProjectScopeEndpointCapability({ available });
}

export class ProjectScopeRegistryStore {
  readonly registryPath: string;

  #now: () => string;

  constructor(options: ProjectScopeRegistryStoreOptions = {}) {
    this.registryPath = options.registryPath ?? getProjectScopeRegistryPath();
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  read(): ProjectScopeRegistryDocument {
    try {
      if (!existsSync(this.registryPath)) {
        return createProjectScopeRegistryDocument();
      }
      const parsed = JSON.parse(
        readFileSync(this.registryPath, 'utf8')
      ) as ProjectScopeRegistryDocument;
      if (parsed.version !== 1 || !parsed.scopes || !parsed.folderIndex) {
        return createProjectScopeRegistryDocument();
      }
      return parsed;
    } catch {
      return createProjectScopeRegistryDocument();
    }
  }

  write(document: ProjectScopeRegistryDocument): void {
    mkdirSync(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.registryPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, this.registryPath);
  }

  listScopes(): ProjectDescriptor[] {
    return Object.values(this.read().scopes).sort((left, right) =>
      left.displayName.localeCompare(right.displayName)
    );
  }

  getScope(projectScopeId: string): ProjectDescriptor | null {
    return this.read().scopes[projectScopeId] ?? null;
  }

  findByControlRoot(controlRoot: string): ProjectDescriptor | null {
    const normalized = resolve(controlRoot);
    return (
      Object.values(this.read().scopes).find((scope) =>
        pathsEquivalent(scope.controlRoot.path, normalized)
      ) ?? null
    );
  }

  addFolder(options: AddProjectScopeFolderOptions): ProjectScopeFolderAddResult {
    const document = this.read();
    const folderPath = resolve(options.folderPath);
    const now = this.#now();
    const existingScope = this.resolveTargetScope(document, options, folderPath);
    const folderInput = this.createFolderInput(folderPath, options, now);
    const projectScope = existingScope
      ? addProjectScopeFolder(existingScope, folderInput, { updatedAt: now })
      : this.createScope(folderInput, options, now);
    const nextDocument = upsertProjectScopeInRegistry(document, projectScope);
    this.write(nextDocument);
    mkdirSync(projectScope.dataRoot, { recursive: true, mode: 0o700 });

    const resolution = resolveProjectScopeForFolder(projectScope, folderPath, {
      folderRealpath: folderInput.realpath,
    });
    const addedFolder =
      resolution.currentFolder ??
      projectScope.folders.find((folder) => pathsEquivalent(folder.path, folderPath)) ??
      projectScope.folders[projectScope.folders.length - 1];

    return {
      addedFolder,
      capability: createProjectScopeCapability(true),
      projectScope,
      registryPath: this.registryPath,
      resolution,
      summary: summarizeProjectScopeDescriptor(projectScope, resolution.currentFolderId),
    };
  }

  resolveFolder(folderPathInput: string): ProjectScopeResolveResult | null {
    const document = this.read();
    const folderPath = resolve(folderPathInput);
    const resolution =
      resolveProjectScopeRegistryFolder(document, folderPath) ??
      this.resolveControlRoot(document, folderPath);
    if (!resolution) {
      return null;
    }
    return {
      capability: createProjectScopeCapability(true),
      projectScope: resolution.projectScope,
      registryPath: this.registryPath,
      resolution,
      summary: summarizeProjectScopeDescriptor(resolution.projectScope, resolution.currentFolderId),
    };
  }

  resolveWorkspace(projectRootInput: string): WorkspaceResolver {
    const projectRoot = resolve(projectRootInput);
    const resolved = this.resolveFolder(projectRoot);
    if (!resolved) {
      return WorkspaceResolver.fromProject(projectRoot);
    }
    return WorkspaceResolver.fromProject(projectRoot, {
      currentFolderId: resolved.resolution?.currentFolderId ?? null,
      projectScope: resolved.projectScope,
    });
  }

  resolveTargetScope(
    document: ProjectScopeRegistryDocument,
    options: AddProjectScopeFolderOptions,
    folderPath: string
  ): ProjectDescriptor | null {
    const explicitScopeId = normalizeString(options.projectScopeId);
    if (explicitScopeId) {
      const scope = document.scopes[explicitScopeId];
      if (!scope) {
        throw new Error(`[ProjectScope] scope not found: ${explicitScopeId}`);
      }
      return scope;
    }

    const controlRoot = normalizeString(options.controlRoot);
    if (controlRoot) {
      return this.findScopeInDocumentByControlRoot(document, resolve(controlRoot));
    }

    return resolveProjectScopeRegistryFolder(document, folderPath)?.projectScope ?? null;
  }

  createScope(
    folderInput: CreateProjectFolderDescriptorInput,
    options: AddProjectScopeFolderOptions,
    now: string
  ): ProjectDescriptor {
    const controlRoot = resolve(
      normalizeString(options.controlRoot) ?? defaultControlRootForFolder(folderInput.path)
    );
    const projectId = generateProjectId(controlRoot);
    const dataRoot = getGhostWorkspaceDir(projectId);
    return createProjectDescriptor({
      controlRoot,
      createdAt: now,
      dataRoot,
      displayName: normalizeString(options.displayName) ?? basename(controlRoot),
      folders: [folderInput],
      metadata: {
        producer: 'alembic',
        storagePolicy: 'ghost-only',
      },
      projectId,
      updatedAt: now,
    });
  }

  createFolderInput(
    folderPath: string,
    options: AddProjectScopeFolderOptions,
    now: string
  ): CreateProjectFolderDescriptorInput {
    return {
      addedAt: now,
      displayName: normalizeString(options.displayName) ?? basename(folderPath),
      metadata: {
        producer: 'alembic',
      },
      path: folderPath,
      realpath: safeRealpath(folderPath),
      role: options.role ?? 'source',
    };
  }

  findScopeInDocumentByControlRoot(
    document: ProjectScopeRegistryDocument,
    controlRoot: string
  ): ProjectDescriptor | null {
    return (
      Object.values(document.scopes).find((scope) =>
        pathsEquivalent(scope.controlRoot.path, controlRoot)
      ) ?? null
    );
  }

  resolveControlRoot(
    document: ProjectScopeRegistryDocument,
    folderPath: string
  ): ProjectScopeResolution | null {
    const scope = this.findScopeInDocumentByControlRoot(document, folderPath);
    if (!scope) {
      return null;
    }
    return resolveProjectScopeForFolder(scope, folderPath);
  }
}

export function resolveAlembicWorkspace(projectRoot: string): WorkspaceResolver {
  return new ProjectScopeRegistryStore().resolveWorkspace(projectRoot);
}

export function resolveAlembicDaemonPaths(projectRootInput: string): DaemonPaths {
  const resolver = resolveAlembicWorkspace(projectRootInput);
  return {
    dataRoot: resolver.dataRoot,
    jobsDir: join(resolver.runtimeDir, 'jobs'),
    lockDir: join(resolver.runtimeDir, 'daemon.lock'),
    logPath: join(resolver.runtimeDir, 'daemon.log'),
    pidPath: join(resolver.runtimeDir, 'daemon.pid'),
    projectId: resolver.projectId,
    projectRoot: resolver.projectRoot,
    runtimeDir: resolver.runtimeDir,
    statePath: join(resolver.runtimeDir, 'daemon.json'),
  };
}

export function summarizeProjectScope(scope: ProjectDescriptor): ProjectScopeSummary {
  return summarizeProjectScopeDescriptor(scope, scope.currentFolderId);
}

function defaultControlRootForFolder(folderPath: string): string {
  return dirname(resolve(folderPath));
}

function safeRealpath(folderPath: string): string | null {
  try {
    return realpathSync(folderPath);
  } catch {
    return null;
  }
}

function normalizeString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function pathsEquivalent(left: string | null, right: string | null): boolean {
  if (!left || !right) {
    return false;
  }
  return resolve(left) === resolve(right);
}
