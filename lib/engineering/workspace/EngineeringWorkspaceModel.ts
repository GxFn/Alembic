import fs from "node:fs";
import path from "node:path";

export const ENGINEERING_WORKSPACE_REGISTRY_VERSION = 1;
export const ENGINEERING_DEFAULT_GLOBAL_ROOT = ".asd";
export const ENGINEERING_DEFAULT_GLOBAL_WORKSPACES_DIR = "workspaces";
export const ENGINEERING_DEFAULT_RUNTIME_DIR = ".asd";
export const ENGINEERING_DEFAULT_KNOWLEDGE_BASE_DIR = "Alembic";
export const ENGINEERING_BOX_SPEC_FILENAME = "Alembic.boxspec.json";

export type EngineeringWorkspaceMode = "standard" | "ghost";
export type EngineeringDataRootSource = "project-root" | "ghost-registry";

export interface EngineeringWorkspaceFolderNames {
  readonly global: {
    readonly root: string;
    readonly workspaces: string;
    readonly cache: string;
    readonly snippets: string;
  };
  readonly project: {
    readonly runtime: string;
    readonly knowledgeBase: string;
    readonly recipes: string;
    readonly candidates: string;
    readonly skills: string;
    readonly wiki: string;
    readonly logs: string;
    readonly cache: string;
    readonly context: string;
  };
  readonly ide: {
    readonly cursorRoot: string;
    readonly vscodeRoot: string;
    readonly githubRoot: string;
  };
}

export type PartialEngineeringWorkspaceFolderNames = {
  readonly [SectionKey in keyof EngineeringWorkspaceFolderNames]?: Partial<
    EngineeringWorkspaceFolderNames[SectionKey]
  >;
};

export const ENGINEERING_DEFAULT_WORKSPACE_FOLDER_NAMES: EngineeringWorkspaceFolderNames = {
  global: {
    root: ENGINEERING_DEFAULT_GLOBAL_ROOT,
    workspaces: ENGINEERING_DEFAULT_GLOBAL_WORKSPACES_DIR,
    cache: "cache",
    snippets: "snippets",
  },
  project: {
    runtime: ENGINEERING_DEFAULT_RUNTIME_DIR,
    knowledgeBase: ENGINEERING_DEFAULT_KNOWLEDGE_BASE_DIR,
    recipes: "recipes",
    candidates: "candidates",
    skills: "skills",
    wiki: "wiki",
    logs: "logs",
    cache: "cache",
    context: "context",
  },
  ide: {
    cursorRoot: ".cursor",
    vscodeRoot: ".vscode",
    githubRoot: ".github",
  },
};

export function resolveEngineeringWorkspaceFolderNames(
  overrides: PartialEngineeringWorkspaceFolderNames = {},
): EngineeringWorkspaceFolderNames {
  const resolved: EngineeringWorkspaceFolderNames = {
    global: { ...ENGINEERING_DEFAULT_WORKSPACE_FOLDER_NAMES.global, ...overrides.global },
    project: { ...ENGINEERING_DEFAULT_WORKSPACE_FOLDER_NAMES.project, ...overrides.project },
    ide: { ...ENGINEERING_DEFAULT_WORKSPACE_FOLDER_NAMES.ide, ...overrides.ide },
  };

  for (const [sectionName, section] of Object.entries(resolved)) {
    for (const [fieldName, value] of Object.entries(section)) {
      validateEngineeringFolderName(value, `${sectionName}.${fieldName}`);
    }
  }
  return resolved;
}

export function detectEngineeringKnowledgeBaseDir(
  projectRoot: string,
  fallbackDir = ENGINEERING_DEFAULT_KNOWLEDGE_BASE_DIR,
): string {
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        fs.existsSync(path.join(projectRoot, entry.name, ENGINEERING_BOX_SPEC_FILENAME))
      ) {
        return entry.name;
      }
    }
  } catch {
    /* Pure engineering probes treat unreadable projects as "no marker". */
  }
  return fallbackDir;
}

export function engineeringPathContains(targetPath: string, basePath: string): boolean {
  const target = path.resolve(targetPath);
  const base = path.resolve(basePath);
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeEngineeringProjectPath(projectRoot: string): string {
  try {
    return fs.realpathSync(projectRoot);
  } catch {
    return path.resolve(projectRoot);
  }
}

export function normalizeEngineeringRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function validateEngineeringFolderName(name: unknown, label: string): string {
  if (typeof name !== "string") {
    throw new Error(`${label} must be a string folder name`);
  }
  if (name.trim() !== name || name.length === 0) {
    throw new Error(`${label} must be a non-empty folder name without surrounding whitespace`);
  }
  if (name === "." || name === "..") {
    throw new Error(`${label} must not be a relative path marker`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`${label} must be a single folder name, not a path`);
  }
  if (name.startsWith("~")) {
    throw new Error(`${label} must be a folder name, not a home-relative path`);
  }
  return name;
}
