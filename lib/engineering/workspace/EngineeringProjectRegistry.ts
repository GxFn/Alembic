import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ENGINEERING_WORKSPACE_REGISTRY_VERSION,
  type EngineeringDataRootSource,
  type EngineeringWorkspaceFolderNames,
  type EngineeringWorkspaceMode,
  normalizeEngineeringProjectPath,
  type PartialEngineeringWorkspaceFolderNames,
  resolveEngineeringWorkspaceFolderNames,
} from "./EngineeringWorkspaceModel.js";

export interface EngineeringGhostMarker {
  readonly kind: "project-registry";
  readonly registryPath: string;
  readonly projectRoot: string;
  readonly projectId: string;
}

export interface EngineeringProjectRegistryEntry {
  readonly id: string;
  readonly ghost: boolean;
  readonly createdAt: string;
}

export interface EngineeringProjectRegistryInspection {
  readonly inputProjectRoot: string;
  readonly projectRoot: string;
  readonly projectRealpath: string;
  readonly registryPath: string;
  readonly registered: boolean;
  readonly entry: EngineeringProjectRegistryEntry | null;
  readonly mode: EngineeringWorkspaceMode;
  readonly ghost: boolean;
  readonly projectId: string | null;
  readonly expectedProjectId: string;
  readonly dataRoot: string;
  readonly dataRootSource: EngineeringDataRootSource;
  readonly workspaceExists: boolean;
  readonly ghostMarker: EngineeringGhostMarker | null;
}

export interface EngineeringProjectRegistryListEntry {
  readonly projectRoot: string;
  readonly entry: EngineeringProjectRegistryEntry;
}

export interface EngineeringProjectRegistryDocument {
  readonly version: typeof ENGINEERING_WORKSPACE_REGISTRY_VERSION;
  readonly projects: Record<string, EngineeringProjectRegistryEntry>;
}

export interface EngineeringProjectRegistryOptions {
  readonly registryPath?: string;
  readonly homeDir?: string;
  readonly folderNames?: PartialEngineeringWorkspaceFolderNames;
  readonly now?: () => string;
}

export interface EngineeringProjectRegisterOptions {
  readonly ghost?: boolean;
  readonly createdAt?: string;
}

export class EngineeringProjectRegistry {
  readonly #registryDir: string;
  readonly #registryPath: string;
  readonly #folderNames: EngineeringWorkspaceFolderNames;
  readonly #now: () => string;

  constructor(options: EngineeringProjectRegistryOptions = {}) {
    this.#folderNames = resolveEngineeringWorkspaceFolderNames(options.folderNames);
    this.#registryPath = path.resolve(
      options.registryPath ??
        path.join(
          options.homeDir ?? defaultEngineeringHomeDir(),
          this.#folderNames.global.root,
          "projects.json",
        ),
    );
    this.#registryDir = path.dirname(this.#registryPath);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get registryPath(): string {
    return this.#registryPath;
  }

  get registryDir(): string {
    return this.#registryDir;
  }

  normalizeProjectPath(projectRoot: string): string {
    return normalizeEngineeringProjectPath(projectRoot);
  }

  projectId(projectRoot: string): string {
    return createHash("sha256")
      .update(this.normalizeProjectPath(projectRoot))
      .digest("hex")
      .slice(0, 8);
  }

  ghostWorkspacePath(projectId: string): string {
    return path.join(this.#registryDir, this.#folderNames.global.workspaces, projectId);
  }

  get(projectRoot: string): EngineeringProjectRegistryEntry | null {
    const document = this.#load();
    return document.projects[this.normalizeProjectPath(projectRoot)] ?? null;
  }

  inspect(projectRoot: string): EngineeringProjectRegistryInspection {
    const inputProjectRoot = path.resolve(projectRoot);
    const projectRealpath = this.normalizeProjectPath(projectRoot);
    const document = this.#load();
    const entry = document.projects[projectRealpath] ?? null;
    const ghost = entry?.ghost === true;
    const projectId = entry?.id ?? null;
    const dataRoot = ghost && projectId ? this.ghostWorkspacePath(projectId) : inputProjectRoot;
    const dataRootSource: EngineeringDataRootSource = ghost ? "ghost-registry" : "project-root";

    return {
      inputProjectRoot,
      projectRoot: inputProjectRoot,
      projectRealpath,
      registryPath: this.#registryPath,
      registered: entry !== null,
      entry,
      mode: ghost ? "ghost" : "standard",
      ghost,
      projectId,
      expectedProjectId: this.projectId(projectRoot),
      dataRoot,
      dataRootSource,
      workspaceExists: fs.existsSync(dataRoot),
      ghostMarker:
        ghost && projectId
          ? {
              kind: "project-registry",
              registryPath: this.#registryPath,
              projectRoot: projectRealpath,
              projectId,
            }
          : null,
    };
  }

  register(
    projectRoot: string,
    options: EngineeringProjectRegisterOptions | boolean = {},
  ): EngineeringProjectRegistryEntry {
    const ghost = typeof options === "boolean" ? options : (options.ghost ?? false);
    const createdAt =
      typeof options === "boolean" ? this.#now() : (options.createdAt ?? this.#now());
    const document = this.#load();
    const normalizedRoot = this.normalizeProjectPath(projectRoot);
    const existing = document.projects[normalizedRoot] ?? null;
    const entry: EngineeringProjectRegistryEntry = existing
      ? { ...existing, ghost }
      : {
          id: this.projectId(projectRoot),
          ghost,
          createdAt,
        };

    document.projects[normalizedRoot] = entry;
    this.#save(document);
    return entry;
  }

  unregister(projectRoot: string): boolean {
    const document = this.#load();
    const normalizedRoot = this.normalizeProjectPath(projectRoot);
    if (!document.projects[normalizedRoot]) {
      return false;
    }
    delete document.projects[normalizedRoot];
    this.#save(document);
    return true;
  }

  list(): readonly EngineeringProjectRegistryListEntry[] {
    const document = this.#load();
    return Object.entries(document.projects)
      .map(([projectRoot, entry]) => ({ projectRoot, entry }))
      .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
  }

  #load(): EngineeringProjectRegistryDocument {
    try {
      if (!fs.existsSync(this.#registryPath)) {
        return emptyRegistryDocument();
      }
      const raw = fs.readFileSync(this.#registryPath, "utf8");
      return parseRegistryDocument(JSON.parse(raw)) ?? emptyRegistryDocument();
    } catch {
      return emptyRegistryDocument();
    }
  }

  #save(document: EngineeringProjectRegistryDocument): void {
    fs.mkdirSync(this.#registryDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.#registryPath, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

function defaultEngineeringHomeDir(): string {
  return process.env.ALEMBIC_HOME || process.env.HOME || process.env.USERPROFILE || process.cwd();
}

function emptyRegistryDocument(): EngineeringProjectRegistryDocument {
  return { version: ENGINEERING_WORKSPACE_REGISTRY_VERSION, projects: {} };
}

function parseRegistryDocument(value: unknown): EngineeringProjectRegistryDocument | null {
  if (!isRecord(value) || value.version !== ENGINEERING_WORKSPACE_REGISTRY_VERSION) {
    return null;
  }
  if (!isRecord(value.projects)) {
    return null;
  }

  const projects: Record<string, EngineeringProjectRegistryEntry> = {};
  for (const [projectRoot, candidate] of Object.entries(value.projects)) {
    if (isRegistryEntry(candidate)) {
      projects[projectRoot] = candidate;
    }
  }
  return { version: ENGINEERING_WORKSPACE_REGISTRY_VERSION, projects };
}

function isRegistryEntry(value: unknown): value is EngineeringProjectRegistryEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.ghost === "boolean" &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
