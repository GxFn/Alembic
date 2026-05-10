import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonJob } from "../daemon/index.js";
import {
  cancelCodexDaemonJob,
  enqueueCodexDaemonJob,
  getCodexDaemonJob,
  listCodexDaemonJobs,
} from "./daemon-client.js";
import { runCodexGuard } from "./guard.js";
import { runCodexKnowledge } from "./knowledge.js";
import { readPackageInfo } from "./package-info.js";
import { runCodexPrime } from "./prime.js";
import { runCodexSearch } from "./search.js";
import { runCodexStructure } from "./structure.js";
import { submitCodexKnowledge } from "./submit-knowledge.js";
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

// CodexToolDefinition 是 MCP/插件协议面，不给内部 Agent runtime 直接调用。
// 内部 Agent 工具在 lib/agent/tools；status/diagnostics/init 必须轻量；
// bootstrap/rescan 只排 daemon job，不在 stdio 内跑长任务。
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
  {
    name: "alembic_codex_bootstrap",
    description:
      "Start an Alembic bootstrap job through the local daemon. The MCP call only enqueues durable work and returns a job id.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "Rebuild baseline artifacts even if they exist." },
        scan: { type: "object", description: "Optional scan controls for the workflow." },
        changedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Optional file path hints for a targeted bootstrap.",
        },
        agentFill: {
          type: "boolean",
          description:
            "Also run the internal AgentRuntime dimension fill after the scan lifecycle.",
        },
        maxAgentTasks: {
          type: "integer",
          description: "Optional cap for internal AgentRuntime dimension tasks.",
        },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
  },
  {
    name: "alembic_codex_rescan",
    description:
      "Start an Alembic rescan job through the local daemon. The MCP call only enqueues durable work and returns a job id.",
    inputSchema: {
      type: "object",
      properties: {
        scan: { type: "object", description: "Optional scan controls for the workflow." },
        changedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Changed project files to prioritize during rescan.",
        },
        removedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Removed project files to account for during rescan.",
        },
        diffTextByPath: {
          type: "object",
          description: "Optional project-relative diff text map for Recipe impact analysis.",
        },
        agentFill: {
          type: "boolean",
          description:
            "Also run the internal AgentRuntime dimension and evolution fill after the scan lifecycle.",
        },
        includeEvolution: {
          type: "boolean",
          description: "Whether internal AgentRuntime should plan Recipe evolution tasks.",
        },
        maxAgentTasks: {
          type: "integer",
          description: "Optional cap for internal AgentRuntime dimension/evolution tasks.",
        },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
  },
  {
    name: "alembic_codex_job",
    description:
      "List, inspect, or cancel Alembic daemon jobs. Does not run workflow work inside the MCP stdio process.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "status", "cancel"],
          description: "Job operation to perform.",
        },
        id: { type: "string", description: "Job id for status or cancel." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "alembic_task",
    description:
      "Run an Alembic task. First supported operation is prime, which reads mainline runtime indexes and returns Codex-ready context.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["prime"], description: "Task operation to run." },
        task: { type: "string", description: "Current coding task or user intent." },
        files: { type: "array", items: { type: "string" } },
        symbols: { type: "array", items: { type: "string" } },
        diff: { type: "string" },
        errors: { type: "array", items: { type: "string" } },
        diagnostics: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "alembic_search",
    description:
      "Search Alembic public read models for the current Codex workspace. Reads SearchIndexSnapshot and ContextIndex only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language or code search text." },
        text: { type: "string", description: "Alias for query." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Path filters from the project root.",
        },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Symbol filters or fully qualified names.",
        },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: ["recipe", "source-ref", "symbol", "file", "note", "graph-node"],
          },
          description: "Optional document kinds to include.",
        },
        kind: {
          type: "string",
          enum: ["recipe", "source-ref", "symbol", "file", "note", "graph-node"],
          description: "Single document kind alias.",
        },
        limit: { type: "number", description: "Maximum hits to return, capped at 50." },
        projectRoot: {
          type: "string",
          description: "Explicit project root. Defaults to the current Codex workspace.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "alembic_structure",
    description:
      "Read project structure from Alembic ProjectIntelligence artifacts or graph documents for the current Codex workspace.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["summary", "files", "symbols", "dependencies", "cycles"],
          description: "Structure view to return. Defaults to summary.",
        },
        path: { type: "string", description: "Optional project-relative path filter." },
        file: { type: "string", description: "Alias for path." },
        target: { type: "string", description: "Alias for path." },
        symbol: { type: "string", description: "Optional symbol name or FQN filter." },
        limit: { type: "number", description: "Maximum records to return, capped at 100." },
        projectRoot: {
          type: "string",
          description: "Explicit project root. Defaults to the current Codex workspace.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "alembic_knowledge",
    description:
      "List, publish, or reject Alembic Recipe lifecycle records through the Codex public MCP adapter.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "publish", "reject"],
          description: "Lifecycle operation to run. Defaults to list.",
        },
        status: {
          type: "string",
          enum: ["candidate", "active", "rejected", "all"],
          description: "List filter. Defaults to active for list.",
        },
        id: { type: "string", description: "Recipe id for publish or reject." },
        recipeId: { type: "string", description: "Recipe id for publish or reject." },
        reason: { type: "string", description: "Review reason for reject." },
        reviewer: { type: "string", description: "Reviewer name for publish or reject metadata." },
        publishedBy: { type: "string", description: "Reviewer name for publish metadata." },
        rejectedBy: { type: "string", description: "Reviewer name for reject metadata." },
        limit: { type: "number", description: "Maximum records to return, capped at 100." },
        projectRoot: {
          type: "string",
          description: "Explicit project root. Defaults to the current Codex workspace.",
        },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
  },
  {
    name: "alembic_submit_knowledge",
    description:
      "Submit Alembic Recipe candidates for later review. Default Codex tier writes candidates only and does not publish Recipes.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object" },
          description: "Recipe candidate submissions following the Alembic V3 knowledge shape.",
        },
      },
      additionalProperties: true,
    },
    annotations: { destructiveHint: false },
  },
  {
    name: "alembic_guard",
    description:
      "Check code against Alembic guard-rule Recipes from the mainline runtime index. Reads dataRoot snapshots and project files only when explicitly requested.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Inline code snippet to check." },
        language: { type: "string", description: "Language for inline code or file entries." },
        filePath: { type: "string", description: "Path for the inline snippet." },
        path: { type: "string", description: "Alternative path for the inline snippet." },
        projectRoot: {
          type: "string",
          description: "Explicit project root to inspect. Defaults to the current Codex workspace.",
        },
        files: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                  language: { type: "string" },
                },
                required: ["path"],
                additionalProperties: false,
              },
            ],
          },
        },
        maxFindings: { type: "number" },
        maxFindingsPerRule: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
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
  try {
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
      case "alembic_codex_bootstrap": {
        const job = await enqueueCodexDaemonJob("bootstrap", buildWorkflowJobInput(args));
        return {
          success: true,
          message: "Alembic bootstrap job queued.",
          data: { job, nextAction: { tool: "alembic_codex_job", arguments: { id: job.id } } },
        };
      }
      case "alembic_codex_rescan": {
        const job = await enqueueCodexDaemonJob("rescan", buildWorkflowJobInput(args));
        return {
          success: true,
          message: "Alembic rescan job queued.",
          data: { job, nextAction: { tool: "alembic_codex_job", arguments: { id: job.id } } },
        };
      }
      case "alembic_codex_job":
        return handleCodexJobTool(args);
      case "alembic_task":
        if (args.operation !== "prime") {
          return {
            success: false,
            message: "Unsupported Alembic task operation.",
            data: { supportedOperations: ["prime"] },
          };
        }
        return { success: true, data: await runCodexPrime(args) };
      case "alembic_search":
        // 中文注释：Codex public search 是 MCP 协议面，只读 mainline snapshots；
        // internal Agent tools 仍留在 lib/agent/tools，二者不能共享 envelope 或 registry。
        return { success: true, data: await runCodexSearch(args) };
      case "alembic_structure":
        // 中文注释：Codex public structure 只消费 ProjectIntelligence read model，
        // 不导入 internal Agent graph tool，也不暴露 resource.action 形态。
        return { success: true, data: await runCodexStructure(args) };
      case "alembic_knowledge":
        // 中文注释：Codex public lifecycle adapter，只桥接 RecipeLifecycleStore；
        // 不导入 lib/agent/tools，也不暴露 internal Agent envelope。
        return { success: true, data: await runCodexKnowledge(args) };
      case "alembic_submit_knowledge":
        return { success: true, data: await submitCodexKnowledge(args) };
      case "alembic_guard":
        return { success: true, data: await runCodexGuard(args) };
      default:
        return {
          success: false,
          message: `Unknown Alembic Codex tool: ${name}`,
          data: { availableTools: CODEX_TOOLS.map((tool) => tool.name) },
        };
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      data: { code: "ALEMBIC_CODEX_TOOL_FAILED", tool: name },
    };
  }
}

export function buildStatus(workspace = inspectWorkspace()): Record<string, unknown> {
  const recipeCount = countMarkdownFiles(workspace.recipesDir);
  const candidateCount = countMarkdownFiles(workspace.candidatesDir);
  const skillCount = countMarkdownFiles(workspace.skillsDir);
  const daemonState = readDaemonState(workspace);
  const runtimeReadiness = buildRuntimeReadiness(workspace, recipeCount);
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
      usable: runtimeReadiness.primeReady || runtimeReadiness.recipesReady,
      recipeCount,
      candidateCount,
      skillCount,
      readiness: runtimeReadiness,
    },
    projectArtifacts,
    daemon: {
      state: daemonState,
      running: daemonState !== null,
      note: "Use alembic_codex_bootstrap, alembic_codex_rescan, or alembic_codex_job for durable daemon work.",
    },
    onboarding: buildOnboarding(workspace, runtimeReadiness),
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
  readiness: RuntimeReadiness,
): Record<string, unknown> {
  // onboarding 只给下一步建议，不在 status 阶段隐式启动长任务。
  if (!workspace.initialized) {
    return {
      state: "needs_init",
      primaryAction: { tool: "alembic_codex_init", startsDaemon: false },
      nextActions: ["Initialize Ghost workspace: call alembic_codex_init"],
    };
  }
  if (!readiness.primeReady) {
    return {
      state: "needs_bootstrap",
      primaryAction: { tool: "alembic_codex_bootstrap", startsDaemon: true },
      nextActions: ["Queue a durable bootstrap job: call alembic_codex_bootstrap"],
    };
  }
  if (!readiness.recipesReady) {
    return {
      state: "project_intelligence_ready",
      primaryAction: {
        tool: "alembic_task",
        arguments: { operation: "prime" },
        startsDaemon: false,
      },
      nextActions: [
        "Prime Codex with project intelligence.",
        "Submit reviewed Recipe candidates when durable project knowledge is ready.",
      ],
    };
  }
  return {
    state: "ready",
    primaryAction: {
      tool: "alembic_task",
      arguments: { operation: "prime" },
      startsDaemon: false,
    },
    nextActions: ["Prime Codex before coding work."],
  };
}

interface RuntimeReadiness {
  readonly contextReady: boolean;
  readonly primeReady: boolean;
  readonly projectIntelligenceReady: boolean;
  readonly recipesReady: boolean;
  readonly searchReady: boolean;
}

function buildRuntimeReadiness(
  workspace: WorkspaceInspection,
  recipeCount: number,
): RuntimeReadiness {
  const contextDir = join(workspace.runtimeDir, "context");
  const projectIntelligenceReady = existsSync(
    join(contextDir, "project-intelligence-artifact.json"),
  );
  const contextReady = existsSync(join(contextDir, "context-index.json"));
  const searchReady = existsSync(join(contextDir, "search-index.json"));
  return {
    contextReady,
    primeReady: contextReady && searchReady,
    projectIntelligenceReady,
    recipesReady: recipeCount > 0,
    searchReady,
  };
}

async function handleCodexJobTool(args: Record<string, unknown>): Promise<ToolResult> {
  const action = stringValue(args.action) ?? (stringValue(args.id) ? "status" : "list");
  if (action !== "list" && action !== "status" && action !== "cancel") {
    return {
      success: false,
      message: `Unsupported job action: ${action}`,
      data: { supportedActions: ["list", "status", "cancel"] },
    };
  }
  if (action === "list") {
    const jobs = await listCodexDaemonJobs();
    return { success: true, data: { jobs, progress: jobs.map(summarizeDaemonJobProgress) } };
  }

  const id = stringValue(args.id);
  if (!id) {
    return {
      success: false,
      message: "Job id is required for status or cancel.",
      data: { required: ["id"] },
    };
  }

  if (action === "status") {
    const job = await getCodexDaemonJob(id);
    return { success: true, data: { job, progress: summarizeDaemonJobProgress(job) } };
  }
  if (action === "cancel") {
    const job = await cancelCodexDaemonJob(id);
    return {
      success: true,
      message: "Alembic job cancelled.",
      data: { job, progress: summarizeDaemonJobProgress(job) },
    };
  }
  return { success: false, message: `Unsupported job action: ${action}` };
}

function summarizeDaemonJobProgress(job: DaemonJob): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.progress?.phase ?? job.status,
    percent: job.progress?.percent ?? null,
    message: job.progress?.message ?? null,
    stepCount: job.progress?.steps?.length ?? 0,
    updatedAt: job.progress?.updatedAt ?? job.updatedAt,
  };
}

function buildWorkflowJobInput(args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (typeof args.force === "boolean") {
    input.force = args.force;
  }
  if (isRecord(args.scan)) {
    input.scan = args.scan;
  }
  if (typeof args.agentFill === "boolean") {
    input.agentFill = args.agentFill;
  }
  if (typeof args.includeEvolution === "boolean") {
    input.includeEvolution = args.includeEvolution;
  }
  const maxAgentTasks = integerValue(args.maxAgentTasks);
  if (maxAgentTasks !== undefined) {
    input.maxAgentTasks = maxAgentTasks;
  }
  const changedFiles = stringList(args.changedFiles);
  if (changedFiles.length > 0) {
    input.changedFiles = changedFiles;
  }
  const removedFiles = stringList(args.removedFiles);
  if (removedFiles.length > 0) {
    input.removedFiles = removedFiles;
  }
  if (isStringMap(args.diffTextByPath)) {
    input.diffTextByPath = args.diffTextByPath;
  }
  return input;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) => typeof key === "string" && typeof entry === "string",
    )
  );
}
