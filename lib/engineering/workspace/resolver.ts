import fs from "node:fs";
import path from "node:path";
import {
  detectEngineeringKnowledgeBaseDir,
  ENGINEERING_BOX_SPEC_FILENAME,
  type EngineeringDataRootSource,
  type EngineeringWorkspaceFolderNames,
  type EngineeringWorkspaceMode,
  type PartialEngineeringWorkspaceFolderNames,
  resolveEngineeringWorkspaceFolderNames,
} from "./model.js";
import {
  type EngineeringGhostMarker,
  EngineeringProjectRegistry,
  type EngineeringProjectRegistryOptions,
} from "./project-registry.js";

export interface WorkspaceFacts {
  readonly targetProjectRoot: string;
  readonly projectRealpath: string;
  readonly registryPath: string;
  readonly registered: boolean;
  readonly mode: EngineeringWorkspaceMode;
  readonly ghost: boolean;
  readonly projectId: string | null;
  readonly expectedProjectId: string;
  readonly dataRoot: string;
  readonly dataRootSource: EngineeringDataRootSource;
  readonly workspaceExists: boolean;
  readonly ghostMarker: EngineeringGhostMarker | null;
  readonly runtimeDir: string;
  readonly databasePath: string;
  readonly knowledgeBaseDir: string;
  readonly knowledgeDir: string;
  readonly recipesDir: string;
  readonly skillsDir: string;
  readonly candidatesDir: string;
  readonly wikiDir: string;
}

export interface EngineeringWorkspaceResolverOptions {
  readonly projectRoot: string;
  readonly ghost?: boolean;
  readonly projectId?: string;
  readonly knowledgeBaseDir?: string;
  readonly folderNames?: PartialEngineeringWorkspaceFolderNames;
  readonly registry?: EngineeringProjectRegistry;
  readonly registryOptions?: EngineeringProjectRegistryOptions;
}

export interface EngineeringWorkspaceResolverFromProjectOptions {
  readonly knowledgeBaseDir?: string;
  readonly folderNames?: PartialEngineeringWorkspaceFolderNames;
  readonly registry?: EngineeringProjectRegistry;
  readonly registryOptions?: EngineeringProjectRegistryOptions;
}

export class EngineeringWorkspaceResolver {
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly ghost: boolean;
  readonly projectId: string | null;
  readonly knowledgeBaseDir: string;
  readonly folderNames: EngineeringWorkspaceFolderNames;
  readonly registry: EngineeringProjectRegistry;

  constructor(options: EngineeringWorkspaceResolverOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.folderNames = resolveEngineeringWorkspaceFolderNames(options.folderNames);
    this.registry =
      options.registry ??
      new EngineeringProjectRegistry(
        mergeRegistryOptions(options.registryOptions, options.folderNames),
      );

    const inspection = this.registry.inspect(this.projectRoot);
    this.ghost = options.ghost ?? inspection.ghost;
    this.projectId = options.projectId ?? inspection.projectId;
    this.knowledgeBaseDir =
      options.knowledgeBaseDir ??
      detectEngineeringKnowledgeBaseDir(this.projectRoot, this.folderNames.project.knowledgeBase);

    if (this.ghost && !this.projectId) {
      throw new Error("[EngineeringWorkspaceResolver] Ghost mode requires a registered projectId");
    }

    this.dataRoot =
      this.ghost && this.projectId
        ? this.registry.ghostWorkspacePath(this.projectId)
        : this.projectRoot;
  }

  static fromProject(
    projectRoot: string,
    options: EngineeringWorkspaceResolverFromProjectOptions = {},
  ): EngineeringWorkspaceResolver {
    const registry =
      options.registry ??
      new EngineeringProjectRegistry(
        mergeRegistryOptions(options.registryOptions, options.folderNames),
      );
    const inspection = registry.inspect(projectRoot);
    return new EngineeringWorkspaceResolver({
      projectRoot,
      ghost: inspection.ghost,
      ...(inspection.projectId ? { projectId: inspection.projectId } : {}),
      ...(options.knowledgeBaseDir ? { knowledgeBaseDir: options.knowledgeBaseDir } : {}),
      ...(options.folderNames ? { folderNames: options.folderNames } : {}),
      registry,
    });
  }

  toFacts(): WorkspaceFacts {
    const inspection = this.registry.inspect(this.projectRoot);
    const dataRootSource: EngineeringDataRootSource = this.ghost
      ? "ghost-registry"
      : "project-root";
    const ghostMarker: EngineeringGhostMarker | null =
      this.ghost && this.projectId
        ? {
            kind: "project-registry",
            registryPath: inspection.registryPath,
            projectRoot: inspection.projectRealpath,
            projectId: this.projectId,
          }
        : null;

    return {
      targetProjectRoot: this.projectRoot,
      projectRealpath: inspection.projectRealpath,
      registryPath: inspection.registryPath,
      registered: inspection.registered,
      mode: this.ghost ? "ghost" : "standard",
      ghost: this.ghost,
      projectId: this.projectId,
      expectedProjectId: inspection.expectedProjectId,
      dataRoot: this.dataRoot,
      dataRootSource,
      workspaceExists: fs.existsSync(this.dataRoot),
      ghostMarker,
      runtimeDir: this.runtimeDir,
      databasePath: this.databasePath,
      knowledgeBaseDir: this.knowledgeBaseDir,
      knowledgeDir: this.knowledgeDir,
      recipesDir: this.recipesDir,
      skillsDir: this.skillsDir,
      candidatesDir: this.candidatesDir,
      wikiDir: this.wikiDir,
    };
  }

  get runtimeDir(): string {
    return path.join(this.dataRoot, this.folderNames.project.runtime);
  }

  get databasePath(): string {
    return path.join(this.runtimeDir, "alembic.db");
  }

  get logsDir(): string {
    return path.join(this.runtimeDir, this.folderNames.project.logs);
  }

  get cacheDir(): string {
    return path.join(this.runtimeDir, this.folderNames.project.cache);
  }

  get contextDir(): string {
    return path.join(this.runtimeDir, this.folderNames.project.context);
  }

  get knowledgeDir(): string {
    return path.join(this.dataRoot, this.knowledgeBaseDir);
  }

  get recipesDir(): string {
    return path.join(this.knowledgeDir, this.folderNames.project.recipes);
  }

  get candidatesDir(): string {
    return path.join(this.knowledgeDir, this.folderNames.project.candidates);
  }

  get skillsDir(): string {
    return path.join(this.knowledgeDir, this.folderNames.project.skills);
  }

  get wikiDir(): string {
    return path.join(this.knowledgeDir, this.folderNames.project.wiki);
  }

  get specPath(): string {
    return path.join(this.knowledgeDir, ENGINEERING_BOX_SPEC_FILENAME);
  }
}

function mergeRegistryOptions(
  registryOptions: EngineeringProjectRegistryOptions | undefined,
  folderNames: PartialEngineeringWorkspaceFolderNames | undefined,
): EngineeringProjectRegistryOptions {
  if (!folderNames) {
    return registryOptions ?? {};
  }
  return registryOptions ? { ...registryOptions, folderNames } : { folderNames };
}
