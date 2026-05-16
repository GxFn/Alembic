import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { CodexKnowledgeState } from './KnowledgeState.js';
import {
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
  resolveEffectiveCodexTier,
} from './RuntimeContext.js';

export interface CodexToolDefinition {
  annotations?: ToolAnnotations;
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  tier?: string;
}

export interface CodexToolPolicyInput<T extends CodexToolDefinition = CodexToolDefinition> {
  adminEnabled?: boolean;
  channelId?: string;
  coreTools: T[];
  daemon?: {
    message?: string;
    ready?: boolean;
    status?: string;
  };
  knowledge: CodexKnowledgeState;
  tierName?: string;
  tierOrder: Record<string, number>;
}

export type CodexToolPolicyState =
  | 'bootstrap_running'
  | 'daemon_stale'
  | 'needs_bootstrap'
  | 'needs_init'
  | 'ready'
  | 'ready_refreshing'
  | 'ready_stale';

export interface CodexToolPolicySignal {
  code: string;
  message: string;
  severity: 'info' | 'warning';
}

export interface CodexToolPolicyResult<T extends CodexToolDefinition = CodexToolDefinition> {
  allowedLocalToolNames: Set<string>;
  effectiveTier: string;
  hiddenReason: string | null;
  signals: CodexToolPolicySignal[];
  state: CodexToolPolicyState;
  visibleTools: Array<T | CodexToolDefinition>;
}

// Codex 插件当前只有 alembic-codex 一个入口；这里维护单插件工具策略，不做多插件抽象。
export const CODEX_PROJECT_ROOT_PROPERTY = {
  type: 'string',
  description:
    'Absolute target project root. Pass the current workspace directory when Alembic cannot determine the project.',
};

function codexInputSchema(properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      projectRoot: CODEX_PROJECT_ROOT_PROPERTY,
      ...properties,
    },
    additionalProperties: false,
  };
}

export const CODEX_DISCOVERY_TOOL_NAMES = new Set([
  'alembic_codex_status',
  'alembic_codex_diagnostics',
]);

export const CODEX_INIT_TOOL_NAMES = new Set([
  ...CODEX_DISCOVERY_TOOL_NAMES,
  'alembic_codex_init',
  'alembic_codex_ai_config',
]);

export const CODEX_INIT_ON_DEMAND_TOOL_NAMES = new Set([
  'alembic_codex_dashboard',
  'alembic_codex_bootstrap',
  'alembic_codex_rescan',
  'alembic_codex_job',
]);

export const CODEX_COLD_START_TOOL_NAMES = new Set([
  ...CODEX_INIT_TOOL_NAMES,
  ...CODEX_INIT_ON_DEMAND_TOOL_NAMES,
]);

export const CODEX_LOCAL_TOOLS: CodexToolDefinition[] = [
  {
    name: 'alembic_codex_status',
    tier: 'agent',
    description:
      'Check Alembic Codex plugin status without starting the daemon. Reports workspace, Ghost data root, initialization, daemon state, and the recommended next tool call.',
    inputSchema: codexInputSchema(),
  },
  {
    name: 'alembic_codex_diagnostics',
    tier: 'agent',
    description:
      'Run Alembic Codex runtime diagnostics without starting the daemon. Checks Node, npm, npx, embedded runtime wiring, daemon version, offline fallback, admin mode gate, and first-run next actions.',
    inputSchema: codexInputSchema(),
  },
  {
    name: 'alembic_codex_init',
    tier: 'agent',
    description:
      'Initialize Alembic for Codex plugin use. Defaults to Ghost mode, skips IDE file deployment, and returns next actions for bootstrap or priming.',
    inputSchema: codexInputSchema({
      force: {
        type: 'boolean',
        description: 'Overwrite existing Alembic Codex setup artifacts.',
      },
      seed: { type: 'boolean', description: 'Create seed example Recipes.' },
      standard: {
        type: 'boolean',
        description: 'Write Alembic data into the project instead of the Ghost data root.',
      },
    }),
  },
  {
    name: 'alembic_codex_ai_config',
    tier: 'agent',
    description:
      'Inspect or configure Alembic Codex workspace AI settings. Use status to check masked provider/key readiness, or configure after explicit user confirmation to store API keys in the workspace secrets file.',
    inputSchema: codexInputSchema({
      mode: {
        type: 'string',
        enum: ['status', 'configure'],
        description: 'Read masked AI config status or update workspace AI config.',
      },
      provider: {
        type: 'string',
        enum: ['deepseek', 'openai', 'claude', 'google', 'ollama'],
        description: 'AI provider used by Alembic internal bootstrap/rescan.',
      },
      model: { type: 'string', description: 'Optional model id for the selected provider.' },
      apiKey: {
        type: 'string',
        description:
          'Provider API key. Requires confirmChatSecret=true because the key passes through the Codex tool call.',
      },
      proxy: { type: 'string', description: 'Optional AI proxy URL.' },
      reasoningEffort: { type: 'string', description: 'Optional reasoning effort hint.' },
      confirmChatSecret: {
        type: 'boolean',
        description:
          'Required when apiKey is provided. Confirms the user accepts sending the secret through this Codex tool call.',
      },
    }),
  },
  {
    name: 'alembic_codex_dashboard',
    tier: 'agent',
    description:
      'Start or connect to the project Alembic daemon and return the local Dashboard URL plus follow-up job actions. If the workspace is not initialized yet, this first performs safe Ghost initialization.',
    inputSchema: codexInputSchema(),
  },
  {
    name: 'alembic_codex_bootstrap',
    tier: 'agent',
    description:
      'Start or connect to the daemon and enqueue an internal Alembic bootstrap job. If the workspace is not initialized yet, this first performs safe Ghost initialization. Returns immediately with a recoverable job id.',
    inputSchema: codexInputSchema({
      maxFiles: { type: 'number', description: 'Maximum files to include in project analysis.' },
      skipGuard: { type: 'boolean', description: 'Skip Guard audit during bootstrap analysis.' },
      contentMaxLines: {
        type: 'number',
        description: 'Maximum lines of content sampled per file.',
      },
    }),
  },
  {
    name: 'alembic_codex_rescan',
    tier: 'agent',
    description:
      'Start or connect to the daemon and enqueue an internal Alembic rescan job. If the workspace is not initialized yet, this first performs safe Ghost initialization. Returns immediately with a recoverable job id.',
    inputSchema: codexInputSchema({
      reason: { type: 'string', description: 'Short reason for the rescan.' },
      dimensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional dimension ids to rescan.',
      },
    }),
  },
  {
    name: 'alembic_codex_job',
    tier: 'agent',
    description:
      'Read Alembic daemon job status from the local JobStore without starting the daemon. If the workspace is not initialized yet, this first performs safe Ghost initialization. Pass jobId for one job, or omit it to list recent jobs.',
    inputSchema: codexInputSchema({
      jobId: {
        type: 'string',
        description: 'Job id returned by alembic_codex_bootstrap or alembic_codex_rescan.',
      },
      kind: { type: 'string', enum: ['bootstrap', 'rescan'] },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
      },
      limit: { type: 'number', description: 'Maximum jobs to return when listing.' },
    }),
  },
  {
    name: 'alembic_codex_stop',
    tier: 'agent',
    description: 'Stop the current project Alembic daemon.',
    inputSchema: codexInputSchema({
      waitMs: { type: 'number', description: 'Milliseconds to wait for graceful daemon stop.' },
    }),
  },
  {
    name: 'alembic_codex_cleanup',
    tier: 'agent',
    description:
      'Preview or explicitly clean Alembic Codex runtime files. Plugin uninstall never removes user data automatically; this tool requires confirm=true before deleting runtime state.',
    inputSchema: codexInputSchema({
      confirm: {
        type: 'boolean',
        description: 'When true, stop the daemon and delete runtime state/log/job files.',
      },
    }),
  },
];

export function resolveCodexToolPolicy<T extends CodexToolDefinition>(
  input: CodexToolPolicyInput<T>
): CodexToolPolicyResult<T> {
  const allowedLocalToolNames = allowedCodexToolNames(input.knowledge);
  const tierName = input.tierName || process.env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER;
  const adminEnabled = input.adminEnabled ?? process.env[CODEX_ADMIN_ENABLE_ENV] === '1';
  const effectiveTier = resolveEffectiveCodexTier(tierName, adminEnabled);
  const maxTier = input.tierOrder[effectiveTier] ?? input.tierOrder[CODEX_DEFAULT_MCP_TIER] ?? 0;
  const localTools = CODEX_LOCAL_TOOLS.filter((tool) => allowedLocalToolNames.has(tool.name));
  const coreTools = input.coreTools.filter(
    (tool) => input.knowledge.usable && (input.tierOrder[tool.tier || 'agent'] ?? 0) <= maxTier
  );
  const state = resolveCodexToolPolicyState(input);
  return {
    allowedLocalToolNames,
    effectiveTier,
    hiddenReason: input.knowledge.usable ? null : 'CODEX_ALEMBIC_KNOWLEDGE_REQUIRED',
    signals: buildCodexToolPolicySignals(input, state),
    state,
    visibleTools: [...localTools, ...coreTools],
  };
}

export function allowedCodexToolNames(knowledge: CodexKnowledgeState): Set<string> {
  if (knowledge.usable) {
    return new Set(CODEX_LOCAL_TOOLS.map((tool) => tool.name));
  }
  if (knowledge.initialized) {
    return CODEX_COLD_START_TOOL_NAMES;
  }
  return new Set([...CODEX_INIT_TOOL_NAMES, ...CODEX_INIT_ON_DEMAND_TOOL_NAMES]);
}

export function isToolAllowedForCodexKnowledge(
  name: string,
  knowledge: CodexKnowledgeState
): boolean {
  if (knowledge.usable) {
    return true;
  }
  return allowedCodexToolNames(knowledge).has(name);
}

export function resolveCodexToolPolicyState(input: CodexToolPolicyInput): CodexToolPolicyState {
  const knowledge = input.knowledge;
  if (!knowledge.initialized) {
    return 'needs_init';
  }
  if (!knowledge.usable && knowledge.jobs?.bootstrapRunning) {
    return 'bootstrap_running';
  }
  if (!knowledge.usable) {
    return 'needs_bootstrap';
  }
  if (input.daemon?.status === 'stale') {
    return 'daemon_stale';
  }
  if (knowledge.freshness?.stale) {
    return 'ready_stale';
  }
  if (knowledge.jobs?.running) {
    return 'ready_refreshing';
  }
  return 'ready';
}

export function buildCodexToolPolicySignals(
  input: CodexToolPolicyInput,
  state: CodexToolPolicyState
): CodexToolPolicySignal[] {
  const signals: CodexToolPolicySignal[] = [];
  if (state === 'bootstrap_running') {
    signals.push({
      code: 'CODEX_BOOTSTRAP_RUNNING',
      message: 'A bootstrap job is already running; use alembic_codex_job to recover progress.',
      severity: 'info',
    });
  }
  if (state === 'ready_refreshing') {
    signals.push({
      code: 'CODEX_REFRESH_RUNNING',
      message: 'A bootstrap or rescan job is refreshing project knowledge in the background.',
      severity: 'info',
    });
  }
  if (state === 'ready_stale') {
    signals.push({
      code:
        input.knowledge.freshness?.status === 'source_refs_stale'
          ? 'CODEX_SOURCE_REFS_STALE'
          : 'CODEX_KNOWLEDGE_REFRESH_FAILED',
      message:
        input.knowledge.freshness?.reason ||
        'The latest bootstrap or rescan did not complete after the current knowledge was built.',
      severity: 'warning',
    });
  }
  if (state === 'daemon_stale') {
    signals.push({
      code: 'CODEX_DAEMON_STALE',
      message: input.daemon?.message || 'Daemon state exists but is not healthy.',
      severity: 'warning',
    });
  }
  if (input.knowledge.vector?.skipped) {
    signals.push({
      code: 'CODEX_VECTOR_SKIPPED_NON_BLOCKING',
      message:
        input.knowledge.vector.reason ||
        'Semantic vector index is unavailable; Codex tools remain available.',
      severity: 'info',
    });
  }
  return signals;
}
