import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPackageInfo } from "./package-info.js";
import {
  countMarkdownFiles,
  initializeCodexWorkspace,
  inspectWorkspace,
  type WorkspaceInspection,
} from "./workspace.js";

export interface CodexToolDefinition {
  annotations?: Record<string, boolean>;
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
}

// MCP 首屏保持轻量：只暴露诊断、状态和初始化，避免 stdio 启动时拉起 daemon。
export const CODEX_TOOLS: CodexToolDefinition[] = [
  {
    name: "alembic_codex_diagnostics",
    description:
      "Run Alembic Codex runtime diagnostics without starting the daemon. Checks Node, npm, package pinning, plugin files, and first-run next actions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "alembic_codex_status",
    description:
      "Check Alembic Codex plugin status without starting the daemon. Reports workspace initialization, Ghost data root, and the recommended next tool call.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "alembic_codex_init",
    description:
      "Initialize Alembic for Codex plugin use. Defaults to Ghost mode, skips IDE file deployment, and returns next actions for bootstrap or priming.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "Overwrite existing setup artifacts." },
        seed: { type: "boolean", description: "Create a seed example candidate." },
        standard: {
          type: "boolean",
          description: "Write Alembic data into the project instead of the Ghost data root.",
        },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
  },
];

export interface ToolResult {
  data?: unknown;
  message?: string;
  success: boolean;
}

export async function handleCodexTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  switch (name) {
    case "alembic_codex_diagnostics":
      return { success: true, data: buildDiagnostics() };
    case "alembic_codex_status":
      return { success: true, data: buildStatus() };
    case "alembic_codex_init": {
      const workspace = initializeCodexWorkspace({
        force: Boolean(args.force),
        seed: Boolean(args.seed),
        standard: args.standard === true,
      });
      return {
        success: true,
        message: workspace.ghost
          ? "Alembic Codex Ghost workspace initialized."
          : "Alembic standard workspace initialized.",
        data: {
          status: buildStatus(workspace),
          nextActions: buildPostInitActions(workspace),
        },
      };
    }
    default:
      return {
        success: false,
        message: `Unknown Alembic Codex tool: ${name}`,
        data: { availableTools: CODEX_TOOLS.map((tool) => tool.name) },
      };
  }
}

export function buildStatus(workspace = inspectWorkspace()): Record<string, unknown> {
  const recipeCount = countMarkdownFiles(workspace.recipesDir);
  const candidateCount = countMarkdownFiles(workspace.candidatesDir);
  const skillCount = countMarkdownFiles(workspace.skillsDir);
  // 显式报告项目污染风险，后续 smoke 用它验证 Ghost mode 没写入用户项目。
  const projectArtifacts = {
    cursorDirExists: existsSync(join(workspace.projectRoot, ".cursor")),
    knowledgeExists: existsSync(join(workspace.projectRoot, "Alembic")),
    runtimeExists: existsSync(join(workspace.projectRoot, ".asd")),
    vscodeMcpExists: existsSync(join(workspace.projectRoot, ".vscode", "mcp.json")),
  };

  return {
    initialized: workspace.initialized,
    projectRoot: workspace.projectRoot,
    registry: {
      path: workspace.registryPath,
      registered: workspace.registered,
      projectId: workspace.projectId,
      expectedProjectId: workspace.expectedProjectId,
    },
    workspace: {
      mode: workspace.mode,
      ghost: workspace.ghost,
      dataRoot: workspace.dataRoot,
      dataRootSource: workspace.dataRootSource,
      runtimeDir: workspace.runtimeDir,
      databasePath: workspace.databasePath,
      knowledgeDir: workspace.knowledgeDir,
      recipesDir: workspace.recipesDir,
      candidatesDir: workspace.candidatesDir,
      skillsDir: workspace.skillsDir,
      wikiDir: workspace.wikiDir,
    },
    knowledge: {
      usable: recipeCount > 0,
      recipeCount,
      candidateCount,
      skillCount,
    },
    projectArtifacts,
    daemon: {
      state: readDaemonState(workspace),
      running: false,
      note: "Daemon support is scheduled for the next migration batch.",
    },
    onboarding: buildOnboarding(workspace, recipeCount),
  };
}

export function buildDiagnostics(): Record<string, unknown> {
  // diagnostics 必须保持只读；这里只检查本地环境和插件包完整性。
  const info = readPackageInfo();
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  const npm = safeExec("npm", ["--version"]);
  const npx = safeExec("npx", ["--version"]);
  const pluginRoot = join(info.packageRoot, "plugins", "alembic-codex");
  const mcpPath = join(pluginRoot, ".mcp.json");
  const issues: string[] = [];

  if (nodeMajor < 22) {
    issues.push(`Node.js >=22 is required; current version is ${process.versions.node}.`);
  }
  if (!npm.ok) {
    issues.push("npm is not available on PATH.");
  }
  if (!npx.ok) {
    issues.push("npx is not available on PATH.");
  }
  if (!existsSync(join(pluginRoot, ".codex-plugin", "plugin.json"))) {
    issues.push("Codex plugin manifest is missing.");
  }
  if (!existsSync(mcpPath)) {
    issues.push("Codex plugin MCP config is missing.");
  }

  const mcpConfig = readText(mcpPath);
  if (mcpConfig && !mcpConfig.includes(`alembic-ai@${info.version}`)) {
    issues.push(`Codex plugin MCP config should pin alembic-ai@${info.version}.`);
  }
  if (mcpConfig && !mcpConfig.includes("alembic-codex-mcp")) {
    issues.push("Codex plugin MCP config should call alembic-codex-mcp.");
  }

  return {
    ok: issues.length === 0,
    issues,
    node: {
      version: process.versions.node,
      ok: nodeMajor >= 22,
    },
    npm,
    npx,
    package: {
      root: info.packageRoot,
      version: info.version,
    },
    codex: {
      requestedTier: process.env.ALEMBIC_MCP_TIER || "agent",
      effectiveTier: "agent",
      adminEnabled: process.env.ALEMBIC_CODEX_ENABLE_ADMIN === "1",
    },
    plugin: {
      root: pluginRoot,
      manifestExists: existsSync(join(pluginRoot, ".codex-plugin", "plugin.json")),
      mcpExists: existsSync(mcpPath),
      skillsRootExists: existsSync(join(pluginRoot, "skills")),
    },
    primaryAction: {
      tool: issues.length > 0 ? "alembic_codex_diagnostics" : "alembic_codex_status",
      startsDaemon: false,
    },
    offlineFallback: {
      command: `npm install -g alembic-ai@${info.version}`,
      binary: "alembic-codex-mcp",
    },
  };
}

function buildOnboarding(
  workspace: WorkspaceInspection,
  recipeCount: number,
): Record<string, unknown> {
  // onboarding 只给下一步建议，不在 status 阶段隐式启动长任务。
  if (!workspace.initialized) {
    return {
      state: "needs_init",
      primaryAction: { tool: "alembic_codex_init", startsDaemon: false },
      nextActions: ["Initialize Ghost workspace: call alembic_codex_init"],
    };
  }
  if (recipeCount === 0) {
    return {
      state: "needs_bootstrap",
      primaryAction: { tool: "alembic_codex_bootstrap", startsDaemon: true },
      nextActions: ["Bootstrap support lands in the next migration batch."],
    };
  }
  return {
    state: "ready",
    primaryAction: {
      tool: "alembic_task",
      arguments: { operation: "prime" },
      startsDaemon: true,
    },
    nextActions: ["Prime Codex before coding work."],
  };
}

function buildPostInitActions(workspace: WorkspaceInspection): Array<Record<string, unknown>> {
  return [
    {
      tool: "alembic_codex_status",
      label: "Check status",
      startsDaemon: false,
      reason: "Verify Ghost workspace paths and project artifact isolation.",
    },
    {
      tool: "alembic_codex_bootstrap",
      label: "Start bootstrap",
      startsDaemon: true,
      reason: workspace.ghost
        ? "Build project knowledge in the Ghost data root."
        : "Build project knowledge in the standard data root.",
    },
  ];
}

function readDaemonState(workspace: WorkspaceInspection): unknown {
  const statePath = join(workspace.runtimeDir, "daemon", "state.json");
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { unreadable: true, path: statePath };
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function safeExec(command: string, args: string[]): Record<string, unknown> {
  try {
    return {
      ok: true,
      version: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
