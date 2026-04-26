import {
  buildTerminalCommandPolicyInput,
  buildTerminalPtyPolicyInput,
  buildTerminalScriptPolicyInput,
  buildTerminalShellPolicyInput,
  evaluateTerminalCommandPolicy,
  evaluateTerminalPtyPolicy,
  evaluateTerminalScriptPolicy,
  evaluateTerminalShellPolicy,
} from '#tools/adapters/TerminalCommandPolicy.js';
import {
  InMemoryTerminalSessionManager,
  type TerminalSessionManager,
} from '#tools/adapters/TerminalSessionManager.js';
import { executeTerminalRequest } from '#tools/adapters/terminal-adapter/TerminalExecutors.js';
import type {
  ToolExecutionAdapter,
  ToolExecutionPreviewRequest,
  ToolExecutionRequest,
} from '#tools/core/ToolContracts.js';
import type { ToolExecutionPreview } from '#tools/core/ToolDecision.js';
import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';

export class TerminalAdapter implements ToolExecutionAdapter {
  readonly kind = 'terminal-profile' as const;

  readonly #fallbackSessionManager: TerminalSessionManager;

  constructor(options: { sessionManager?: TerminalSessionManager } = {}) {
    this.#fallbackSessionManager = options.sessionManager ?? new InMemoryTerminalSessionManager();
  }

  preview(request: ToolExecutionPreviewRequest): ToolExecutionPreview {
    if (request.manifest.id === 'terminal_session_close') {
      return {
        kind: 'terminal-session',
        summary: `Close terminal session ${String(request.args.id ?? '')}`,
        risk: 'low',
        details: { action: 'close', id: request.args.id },
      };
    }
    if (request.manifest.id === 'terminal_session_status') {
      return {
        kind: 'terminal-session',
        summary:
          typeof request.args.id === 'string'
            ? `Inspect terminal session ${request.args.id}`
            : 'List terminal sessions',
        risk: 'low',
        details: { action: 'status', id: request.args.id },
      };
    }
    if (request.manifest.id === 'terminal_session_cleanup') {
      return {
        kind: 'terminal-session',
        summary: 'Cleanup closed or expired terminal sessions',
        risk: 'low',
        details: { action: 'cleanup' },
      };
    }
    if (request.manifest.id === 'terminal_script') {
      const built = buildTerminalScriptPolicyInput(
        request.args,
        request.projectRoot,
        request.manifest.execution.timeoutMs
      );
      if (!built.ok) {
        return {
          kind: 'terminal-script',
          summary: 'Invalid terminal script',
          risk: 'high',
          details: { error: built.error },
        };
      }
      const policy = evaluateTerminalScriptPolicy(built.input);
      return {
        kind: 'terminal-script',
        summary: `Run /bin/sh script ${built.input.scriptHash.slice(0, 12)}`,
        risk: policy.risk,
        details: {
          ...policy.preview,
          allowed: policy.allowed,
          reason: policy.reason,
          matchedRule: policy.matchedRule,
        },
      };
    }
    if (request.manifest.id === 'terminal_shell') {
      const built = buildTerminalShellPolicyInput(
        request.args,
        request.projectRoot,
        request.manifest.execution.timeoutMs
      );
      if (!built.ok) {
        return {
          kind: 'terminal-shell',
          summary: 'Invalid terminal shell command',
          risk: 'high',
          details: { error: built.error },
        };
      }
      const policy = evaluateTerminalShellPolicy(built.input);
      return {
        kind: 'terminal-shell',
        summary: `Run /bin/sh -lc command ${built.input.commandHash.slice(0, 12)}`,
        risk: policy.risk,
        details: {
          ...policy.preview,
          allowed: policy.allowed,
          reason: policy.reason,
          matchedRule: policy.matchedRule,
        },
      };
    }
    if (request.manifest.id === 'terminal_pty') {
      const built = buildTerminalPtyPolicyInput(
        request.args,
        request.projectRoot,
        request.manifest.execution.timeoutMs
      );
      if (!built.ok) {
        return {
          kind: 'terminal-pty',
          summary: 'Invalid terminal PTY command',
          risk: 'high',
          details: { error: built.error },
        };
      }
      const policy = evaluateTerminalPtyPolicy(built.input);
      return {
        kind: 'terminal-pty',
        summary: `Observe PTY command ${built.input.commandHash.slice(0, 12)}`,
        risk: policy.risk,
        details: {
          ...policy.preview,
          allowed: policy.allowed,
          reason: policy.reason,
          matchedRule: policy.matchedRule,
        },
      };
    }

    const built = buildTerminalCommandPolicyInput(
      request.args,
      request.projectRoot,
      request.manifest.execution.timeoutMs
    );
    if (!built.ok) {
      return {
        kind: 'terminal-command',
        summary: 'Invalid terminal command',
        risk: 'high',
        details: { error: built.error },
      };
    }
    const policy = evaluateTerminalCommandPolicy(built.input);
    return {
      kind: 'terminal-command',
      summary: policy.preview.command,
      risk: policy.risk,
      details: {
        ...policy.preview,
        allowed: policy.allowed,
        reason: policy.reason,
        matchedRule: policy.matchedRule,
      },
    };
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    return executeTerminalRequest(request, this.#fallbackSessionManager);
  }
}

export default TerminalAdapter;
