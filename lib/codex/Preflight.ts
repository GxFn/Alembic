import type { CodexAiConfigState } from './AiConfigState.js';
import type { CodexKnowledgeState } from './KnowledgeState.js';
import {
  buildCodexProjectRootRequiredActions,
  buildCodexProjectRootRequiredMessage,
  type CodexProjectRootResolution,
  isTrustedCodexProjectRoot,
  summarizeCodexProjectRootResolution,
} from './ProjectRootResolver.js';
import {
  CODEX_ADMIN_ENABLE_ENV,
  CODEX_DEFAULT_MCP_TIER,
  CODEX_MCP_TIER_ENV,
} from './RuntimeContext.js';
import { buildCodexKnowledgeGateActions, buildCodexRecommendedAction } from './StatusService.js';
import {
  allowedCodexToolNames,
  CODEX_LOCAL_TOOLS,
  type CodexToolDefinition,
  resolveCodexToolPolicy,
} from './ToolPolicy.js';

export type CodexPreflightStage = 'before-auto-init' | 'execute';

export interface CodexPreflightInput<T extends CodexToolDefinition = CodexToolDefinition> {
  aiConfig?: CodexAiConfigState | null;
  adminEnabled?: boolean;
  args?: Record<string, unknown>;
  coreTools: T[];
  knowledge: CodexKnowledgeState;
  projectRootResolution: CodexProjectRootResolution;
  stage: CodexPreflightStage;
  tierName?: string;
  tierOrder: Record<string, number>;
  toolName: string;
}

export interface CodexPreflightOk {
  autoInit: boolean;
  ok: true;
  state: {
    aiConfig?: CodexAiConfigState | null;
    allowedTools: string[];
    stage: CodexPreflightStage;
  };
}

export interface CodexPreflightBlocked {
  failure: Record<string, unknown>;
  ok: false;
}

export type CodexPreflightResult = CodexPreflightOk | CodexPreflightBlocked;

const INIT_ON_DEMAND_TOOL_NAMES = new Set([
  'alembic_codex_dashboard',
  'alembic_codex_bootstrap',
  'alembic_codex_rescan',
  'alembic_codex_job',
]);

const PROJECT_ROOT_DISCOVERY_TOOL_NAMES = new Set([
  'alembic_codex_status',
  'alembic_codex_diagnostics',
]);

const INTERNAL_AI_TOOL_NAMES = new Set(['alembic_codex_bootstrap', 'alembic_codex_rescan']);

export function preflightCodexTool<T extends CodexToolDefinition>(
  input: CodexPreflightInput<T>
): CodexPreflightResult {
  const tool = findKnownTool(input.toolName, input.coreTools);
  if (!tool) {
    return {
      ok: false,
      failure: codexFailure(input.toolName, `Unknown Alembic tool: ${input.toolName}`, {
        errorCode: 'CODEX_UNKNOWN_TOOL',
      }),
    };
  }

  if (
    !isTrustedCodexProjectRoot(input.projectRootResolution) &&
    !PROJECT_ROOT_DISCOVERY_TOOL_NAMES.has(input.toolName)
  ) {
    const errorCode =
      input.projectRootResolution.trust === 'rejected'
        ? 'CODEX_PROJECT_ROOT_REJECTED'
        : 'CODEX_PROJECT_ROOT_UNRESOLVED';
    return {
      ok: false,
      failure: codexFailure(
        input.toolName,
        buildCodexProjectRootRequiredMessage(input.projectRootResolution),
        {
          errorCode,
          needsUserInput: true,
          projectRootResolution: summarizeCodexProjectRootResolution(input.projectRootResolution),
          required: { projectRoot: 'absolute path' },
          requiredActions: buildCodexProjectRootRequiredActions(),
        }
      ),
    };
  }

  const policy = resolveCodexToolPolicy({
    adminEnabled: input.adminEnabled ?? process.env[CODEX_ADMIN_ENABLE_ENV] === '1',
    coreTools: input.coreTools,
    knowledge: input.knowledge,
    tierName: input.tierName || process.env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER,
    tierOrder: input.tierOrder,
  });
  const visibleToolNames = new Set(policy.visibleTools.map((visibleTool) => visibleTool.name));
  if (!visibleToolNames.has(input.toolName)) {
    return {
      ok: false,
      failure: buildToolHiddenFailure({
        allowedTools: [...allowedCodexToolNames(input.knowledge)],
        coreTools: input.coreTools,
        effectiveTier: policy.effectiveTier,
        knowledge: input.knowledge,
        toolName: input.toolName,
      }),
    };
  }

  const autoInit =
    input.stage === 'before-auto-init' &&
    !input.knowledge.initialized &&
    INIT_ON_DEMAND_TOOL_NAMES.has(input.toolName);

  if (
    input.stage === 'execute' &&
    INTERNAL_AI_TOOL_NAMES.has(input.toolName) &&
    input.aiConfig?.allowsInternalBootstrap !== true
  ) {
    const provider = input.aiConfig?.provider || null;
    const missingKeyEnv = input.aiConfig?.missingKeyEnv || input.aiConfig?.requiredKeyEnv || null;
    return {
      ok: false,
      failure: codexFailure(
        input.toolName,
        'Alembic internal bootstrap/rescan requires a real AI Provider. Configure an AI API key or choose the external-agent route.',
        {
          aiConfig: input.aiConfig || null,
          errorCode: 'AI_PROVIDER_REQUIRED',
          needsUserInput: true,
          required: {
            aiProvider: provider || 'deepseek | openai | claude | google | ollama',
            ...(missingKeyEnv ? { apiKeyEnv: missingKeyEnv } : {}),
          },
          nextActions: [
            buildCodexRecommendedAction({
              label: 'Configure AI Provider',
              reason:
                'Internal Alembic knowledge mining cannot run with mock or missing provider credentials.',
              startsDaemon: false,
              tool: 'alembic_codex_ai_config',
            }),
            buildCodexRecommendedAction({
              label: 'Check workspace status',
              reason: 'Inspect current AI, initialization, and knowledge readiness state.',
              startsDaemon: false,
              tool: 'alembic_codex_status',
            }),
          ],
        }
      ),
    };
  }

  return {
    ok: true,
    autoInit,
    state: {
      aiConfig: input.aiConfig,
      allowedTools: [...visibleToolNames],
      stage: input.stage,
    },
  };
}

export function isCodexInitOnDemandTool(name: string): boolean {
  return INIT_ON_DEMAND_TOOL_NAMES.has(name);
}

export function isCodexProjectRootDiscoveryTool(name: string): boolean {
  return PROJECT_ROOT_DISCOVERY_TOOL_NAMES.has(name);
}

function buildToolHiddenFailure(input: {
  allowedTools: string[];
  coreTools: CodexToolDefinition[];
  effectiveTier: string;
  knowledge: CodexKnowledgeState;
  toolName: string;
}): Record<string, unknown> {
  const coreTool = input.coreTools.find((tool) => tool.name === input.toolName);
  if (coreTool?.tier === 'admin' && input.effectiveTier !== 'admin') {
    return codexFailure(
      input.toolName,
      'This Alembic admin tool is hidden until Codex admin mode is explicitly enabled.',
      {
        allowedTools: input.allowedTools,
        errorCode: 'CODEX_ADMIN_OPT_IN_REQUIRED',
        needsUserInput: true,
        required: { env: `${CODEX_ADMIN_ENABLE_ENV}=1`, tier: 'admin' },
        requiredActions: [
          `Set ${CODEX_ADMIN_ENABLE_ENV}=1 only for explicit admin workflows.`,
          `Set ${CODEX_MCP_TIER_ENV}=admin for this Codex plugin session.`,
        ],
      }
    );
  }

  if (!input.knowledge.usable) {
    return codexFailure(
      input.toolName,
      'Alembic project-knowledge tools are hidden until this project has a usable Alembic knowledge base. Use the cold-start initialization tools first.',
      {
        allowedTools: input.allowedTools,
        errorCode: 'CODEX_ALEMBIC_KNOWLEDGE_REQUIRED',
        nextActions: buildCodexKnowledgeGateActions(input.knowledge),
      }
    );
  }

  return codexFailure(input.toolName, `Alembic tool is not available: ${input.toolName}`, {
    allowedTools: input.allowedTools,
    errorCode: 'CODEX_TOOL_NOT_AVAILABLE',
  });
}

function findKnownTool<T extends CodexToolDefinition>(
  toolName: string,
  coreTools: T[]
): T | CodexToolDefinition | null {
  return (
    CODEX_LOCAL_TOOLS.find((tool) => tool.name === toolName) ||
    coreTools.find((tool) => tool.name === toolName) ||
    null
  );
}

function codexFailure(
  tool: string,
  message: string,
  data: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    success: false,
    message,
    errorCode: 'CODEX_MCP_ERROR',
    tool,
    data,
  };
}
