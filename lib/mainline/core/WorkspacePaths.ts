import path from "node:path";

export type MainlineWorkspaceMode = "standard" | "ghost";
export type MainlineDataRootSource = "project-root" | "ghost-registry" | "explicit" | "derived";

export interface MainlineWorkspacePathInput {
  readonly projectRoot: string;
  readonly mode?: MainlineWorkspaceMode;
  readonly dataRoot?: string;
  readonly projectId?: string;
  readonly homeDir?: string;
}

export interface MainlineWorkspacePathSnapshot {
  readonly mode: MainlineWorkspaceMode;
  readonly ghost: boolean;
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly dataRootSource: MainlineDataRootSource;
  readonly runtimeDir: string;
  readonly databasePath: string;
  readonly logsDir: string;
  readonly reportsDir: string;
  readonly cacheDir: string;
  readonly contextDir: string;
  readonly knowledgeDir: string;
  readonly recipesDir: string;
  readonly skillsDir: string;
  readonly candidatesDir: string;
  readonly wikiDir: string;
}

/**
 * MainlineWorkspacePaths 是 Ghost 模式的纯路径模型。
 * projectRoot 永远指向真实代码；dataRoot 是运行时数据、数据库和知识库的写入边界。
 */
export class MainlineWorkspacePaths {
  readonly #snapshot: MainlineWorkspacePathSnapshot;

  constructor(input: MainlineWorkspacePathInput) {
    const projectRoot = path.resolve(input.projectRoot);
    const mode =
      input.mode ??
      (input.dataRoot && path.resolve(input.dataRoot) !== projectRoot ? "ghost" : "standard");
    const dataRootSource = resolveDataRootSource(input, mode);
    const dataRoot = resolveDataRoot(input, projectRoot, mode);
    const runtimeDir = path.join(dataRoot, ".asd");
    const knowledgeDir = path.join(dataRoot, "Alembic");

    this.#snapshot = {
      mode,
      ghost: mode === "ghost",
      projectRoot,
      dataRoot,
      dataRootSource,
      runtimeDir,
      databasePath: path.join(runtimeDir, "alembic.db"),
      logsDir: path.join(runtimeDir, "logs"),
      reportsDir: path.join(runtimeDir, "logs", "reports"),
      cacheDir: path.join(runtimeDir, "cache"),
      contextDir: path.join(runtimeDir, "context"),
      knowledgeDir,
      recipesDir: path.join(knowledgeDir, "recipes"),
      skillsDir: path.join(knowledgeDir, "skills"),
      candidatesDir: path.join(knowledgeDir, "candidates"),
      wikiDir: path.join(knowledgeDir, "wiki"),
    };
  }

  get mode(): MainlineWorkspaceMode {
    return this.#snapshot.mode;
  }

  get ghost(): boolean {
    return this.#snapshot.ghost;
  }

  get projectRoot(): string {
    return this.#snapshot.projectRoot;
  }

  get dataRoot(): string {
    return this.#snapshot.dataRoot;
  }

  get runtimeDir(): string {
    return this.#snapshot.runtimeDir;
  }

  get databasePath(): string {
    return this.#snapshot.databasePath;
  }

  get logsDir(): string {
    return this.#snapshot.logsDir;
  }

  get knowledgeDir(): string {
    return this.#snapshot.knowledgeDir;
  }

  get recipesDir(): string {
    return this.#snapshot.recipesDir;
  }

  get candidatesDir(): string {
    return this.#snapshot.candidatesDir;
  }

  snapshot(): MainlineWorkspacePathSnapshot {
    return { ...this.#snapshot };
  }
}

function resolveDataRoot(
  input: MainlineWorkspacePathInput,
  projectRoot: string,
  mode: MainlineWorkspaceMode,
): string {
  if (input.dataRoot) {
    return path.resolve(input.dataRoot);
  }
  if (mode === "standard") {
    return projectRoot;
  }

  const homeDir = path.resolve(input.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? ".");
  return path.join(
    homeDir,
    ".asd",
    "workspaces",
    input.projectId ?? stableWorkspaceId(projectRoot),
  );
}

function resolveDataRootSource(
  input: MainlineWorkspacePathInput,
  mode: MainlineWorkspaceMode,
): MainlineDataRootSource {
  if (input.dataRoot) {
    return "explicit";
  }
  if (mode !== "ghost") {
    return "project-root";
  }
  return input.projectId ? "ghost-registry" : "derived";
}

function stableWorkspaceId(projectRoot: string): string {
  // FNV-1a 32-bit：足够做 fallback 路径名，不承担安全哈希语义。
  let hash = 2166136261;
  for (const char of projectRoot) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `ml-${(hash >>> 0).toString(16)}`;
}
