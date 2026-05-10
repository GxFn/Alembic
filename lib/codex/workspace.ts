import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ProjectEntry {
  id: string;
  ghost: boolean;
  createdAt: string;
}

export interface RegistryData {
  version: 1;
  projects: Record<string, ProjectEntry>;
}

export interface WorkspaceInspection {
  candidatesDir: string;
  dataRoot: string;
  dataRootSource: "ghost-registry" | "project-root";
  databasePath: string;
  expectedProjectId: string;
  ghost: boolean;
  initialized: boolean;
  knowledgeDir: string;
  mode: "ghost" | "standard";
  projectId: string | null;
  projectRealpath: string;
  projectRoot: string;
  recipesDir: string;
  registryPath: string;
  registered: boolean;
  runtimeDir: string;
  skillsDir: string;
  wikiDir: string;
}

export interface InitOptions {
  force?: boolean;
  projectRoot?: string;
  seed?: boolean;
  standard?: boolean;
}

export function resolveProjectRoot(input?: string): string {
  return resolve(input || process.env.ALEMBIC_PROJECT_DIR || process.cwd());
}

export function getAlembicHome(): string {
  const home = process.env.ALEMBIC_HOME || process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error("Cannot resolve user home for Alembic registry.");
  }
  // 沿用 legacy 的 ~/.asd 注册表位置，方便后续 mainline 数据层继续接入。
  return join(home, ".asd");
}

export function registryPath(): string {
  return join(getAlembicHome(), "projects.json");
}

export function normalizeProjectPath(projectRoot: string): string {
  try {
    return realpathSync(projectRoot);
  } catch {
    return resolve(projectRoot);
  }
}

export function generateProjectId(projectRoot: string): string {
  return createHash("sha256").update(normalizeProjectPath(projectRoot)).digest("hex").slice(0, 8);
}

export function ghostWorkspaceDir(projectId: string): string {
  return join(getAlembicHome(), "workspaces", projectId);
}

export function loadRegistry(): RegistryData {
  const path = registryPath();
  if (!existsSync(path)) {
    return { version: 1, projects: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RegistryData>;
    if (parsed.version === 1 && parsed.projects && typeof parsed.projects === "object") {
      return { version: 1, projects: parsed.projects };
    }
  } catch {
    // 注册表损坏时不能拖垮 diagnostics，先返回空注册表让用户能继续修复。
  }
  return { version: 1, projects: {} };
}

export function saveRegistry(data: RegistryData): void {
  const path = registryPath();
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function inspectWorkspace(projectRootInput?: string): WorkspaceInspection {
  const projectRoot = resolveProjectRoot(projectRootInput);
  const projectRealpath = normalizeProjectPath(projectRoot);
  const expectedProjectId = generateProjectId(projectRoot);
  const registry = loadRegistry();
  const entry = registry.projects[projectRealpath] ?? null;
  const ghost = entry?.ghost === true;
  const projectId = entry?.id ?? null;
  // Ghost 模式把运行数据放到用户目录，避免在业务项目内写 .asd 或 Alembic。
  const dataRoot = ghost && projectId ? ghostWorkspaceDir(projectId) : projectRoot;
  const runtimeDir = join(dataRoot, ".asd");
  const knowledgeDir = join(dataRoot, "Alembic");
  const recipesDir = join(knowledgeDir, "recipes");
  const candidatesDir = join(knowledgeDir, "candidates");
  const skillsDir = join(knowledgeDir, "skills");
  const wikiDir = join(knowledgeDir, "wiki");

  return {
    candidatesDir,
    dataRoot,
    dataRootSource: ghost ? "ghost-registry" : "project-root",
    databasePath: join(runtimeDir, "alembic.db"),
    expectedProjectId,
    ghost,
    initialized: existsSync(runtimeDir) && existsSync(knowledgeDir),
    knowledgeDir,
    mode: ghost ? "ghost" : "standard",
    projectId,
    projectRealpath,
    projectRoot,
    recipesDir,
    registered: entry !== null,
    registryPath: registryPath(),
    runtimeDir,
    skillsDir,
    wikiDir,
  };
}

export function initializeCodexWorkspace(options: InitOptions = {}): WorkspaceInspection {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const projectRealpath = normalizeProjectPath(projectRoot);
  const ghost = options.standard !== true;
  const registry = loadRegistry();
  const existing = registry.projects[projectRealpath];
  const entry: ProjectEntry =
    existing && !options.force
      ? { ...existing, ghost }
      : {
          id: existing?.id ?? generateProjectId(projectRoot),
          ghost,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };

  registry.projects[projectRealpath] = entry;
  saveRegistry(registry);

  const dataRoot = ghost ? ghostWorkspaceDir(entry.id) : projectRoot;
  const runtimeDir = join(dataRoot, ".asd");
  const knowledgeDir = join(dataRoot, "Alembic");
  // 首批只创建 Codex 插件需要的最小目录，daemon/job/mainline 后续批次再补。
  for (const dir of [
    runtimeDir,
    join(runtimeDir, "context"),
    join(runtimeDir, "logs"),
    knowledgeDir,
    join(knowledgeDir, "recipes"),
    join(knowledgeDir, "candidates"),
    join(knowledgeDir, "skills"),
    join(knowledgeDir, "wiki"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const configPath = join(runtimeDir, "config.json");
  if (!existsSync(configPath) || options.force) {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          profile: "codex-plugin",
          ghost,
          projectRoot,
          projectRealpath,
          projectId: entry.id,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  if (options.seed) {
    const seedPath = join(knowledgeDir, "candidates", "seed-example.md");
    if (!existsSync(seedPath) || options.force) {
      writeFileSync(
        seedPath,
        "# Seed Example\n\nThis placeholder candidate confirms Alembic Ghost storage is writable.\n",
      );
    }
  }

  return inspectWorkspace(projectRoot);
}

export function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) {
    return 0;
  }
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      count += countMarkdownFiles(fullPath);
    } else if (entry.endsWith(".md")) {
      count += 1;
    }
  }
  return count;
}
