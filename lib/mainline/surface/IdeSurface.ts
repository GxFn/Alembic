export type MainlineIdeKind = "cursor" | "vscode" | "github-copilot" | "codex" | "claude";
export type MainlineSurfaceArtifactCategory =
  | "mcp"
  | "rules"
  | "agent-instructions"
  | "gitignore"
  | "skills";
export type MainlineGhostDeployPolicy = "deploy" | "skip" | "global";

export interface MainlineIdeArtifact {
  readonly id: string;
  readonly ide: MainlineIdeKind;
  readonly relativePath: string;
  readonly category: MainlineSurfaceArtifactCategory;
  readonly strategy: "merge-json" | "inject-marker" | "overwrite" | "create-only";
  readonly ghostPolicy: MainlineGhostDeployPolicy;
  readonly managedByAlembic: boolean;
}

export interface MainlineMcpServerEntryOptions {
  readonly global?: boolean;
  readonly command?: string;
}

const WORKSPACE_FOLDER_VARIABLE = "$" + "{workspaceFolder}";

export const MAINLINE_IDE_ARTIFACTS: readonly MainlineIdeArtifact[] = [
  {
    id: "cursor-mcp",
    ide: "cursor",
    relativePath: ".cursor/mcp.json",
    category: "mcp",
    strategy: "merge-json",
    ghostPolicy: "deploy",
    managedByAlembic: true,
  },
  {
    id: "vscode-mcp",
    ide: "vscode",
    relativePath: ".vscode/mcp.json",
    category: "mcp",
    strategy: "merge-json",
    ghostPolicy: "deploy",
    managedByAlembic: true,
  },
  {
    id: "cursor-conventions",
    ide: "cursor",
    relativePath: ".cursor/rules/alembic-conventions.mdc",
    category: "rules",
    strategy: "overwrite",
    ghostPolicy: "deploy",
    managedByAlembic: true,
  },
  {
    id: "cursor-skills",
    ide: "cursor",
    relativePath: ".cursor/rules/alembic-skills.mdc",
    category: "rules",
    strategy: "overwrite",
    ghostPolicy: "deploy",
    managedByAlembic: true,
  },
  {
    id: "copilot-instructions",
    ide: "github-copilot",
    relativePath: ".github/copilot-instructions.md",
    category: "agent-instructions",
    strategy: "inject-marker",
    ghostPolicy: "deploy",
    managedByAlembic: true,
  },
  {
    id: "agents-md",
    ide: "codex",
    relativePath: "AGENTS.md",
    category: "agent-instructions",
    strategy: "inject-marker",
    ghostPolicy: "deploy",
    managedByAlembic: true,
  },
  {
    id: "claude-md",
    ide: "claude",
    relativePath: "CLAUDE.md",
    category: "agent-instructions",
    strategy: "inject-marker",
    ghostPolicy: "deploy",
    managedByAlembic: true,
  },
] as const;

export function listMainlineIdeArtifacts(
  options: { ide?: MainlineIdeKind; category?: MainlineSurfaceArtifactCategory } = {},
): MainlineIdeArtifact[] {
  return MAINLINE_IDE_ARTIFACTS.filter((artifact) => {
    if (options.ide && artifact.ide !== options.ide) {
      return false;
    }
    return !(options.category && artifact.category !== options.category);
  }).map((artifact) => ({ ...artifact }));
}

/**
 * 主线只生成 MCP server 条目，不执行部署。
 * 项目级配置使用 ${workspaceFolder}，全局配置必须写绝对 projectRoot。
 */
export function buildMainlineMcpServerEntry(
  projectRoot: string,
  ide: "cursor" | "vscode",
  options: MainlineMcpServerEntryOptions = {},
): Record<string, unknown> {
  const base = {
    command: options.command ?? "alembic-mcp",
    env: { ALEMBIC_PROJECT_DIR: options.global ? projectRoot : WORKSPACE_FOLDER_VARIABLE },
  };
  return ide === "vscode" ? { type: "stdio", ...base } : base;
}
