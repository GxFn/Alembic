import os from 'node:os';
import type {
  ToolExecutionAdapter,
  ToolExecutionRequest,
  ToolResultEnvelope,
  ToolResultStatus,
} from '@alembic/agent/tools';

export class MacSystemAdapter implements ToolExecutionAdapter {
  readonly kind = 'macos-adapter' as const;

  readonly #platform: NodeJS.Platform;

  constructor(
    options: {
      platform?: NodeJS.Platform;
    } = {}
  ) {
    this.#platform = options.platform ?? process.platform;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const result = await this.#execute(request);
      return envelopeForMacResult(request, startedAt, startedMs, result.status, result.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return envelopeForMacResult(request, startedAt, startedMs, 'error', {
        success: false,
        error: { code: 'MACOS_ADAPTER_ERROR', message },
      });
    }
  }

  async #execute(request: ToolExecutionRequest): Promise<{
    status: ToolResultStatus;
    content: Record<string, unknown>;
  }> {
    switch (request.manifest.id) {
      case 'mac_system_info':
        return { status: 'success', content: this.#systemInfo() };
      case 'mac_permission_status':
        return { status: 'success', content: this.#permissionStatus(request) };
      default:
        return macBlocked(
          `Unknown macOS capability "${request.manifest.id}"`,
          'UNKNOWN_MACOS_CAPABILITY'
        );
    }
  }

  #systemInfo() {
    return {
      success: true,
      data: {
        platform: this.#platform,
        isMacOS: this.#platform === 'darwin',
        arch: os.arch(),
        release: os.release(),
        version: typeof os.version === 'function' ? os.version() : null,
        hostname: os.hostname(),
      },
    };
  }

  #permissionStatus(request: ToolExecutionRequest) {
    const requested = normalizePermission(request.args.permission);
    const permissions = requested === 'all' ? ['accessibility', 'automation'] : [requested];
    return {
      success: true,
      data: {
        platform: this.#platform,
        permissions: permissions.map((permission) => this.#describePermission(permission)),
        policy: {
          checkedWithoutPrompt: true,
          promptsUser: false,
          bypassesTcc: false,
        },
      },
    };
  }

  #describePermission(permission: string) {
    if (this.#platform !== 'darwin') {
      return {
        permission,
        status: 'unavailable',
        reason: 'macOS permissions are only available on darwin.',
      };
    }
    return {
      permission,
      status: 'unknown',
      reason: 'This adapter does not prompt for or bypass TCC permissions.',
    };
  }
}

function normalizePermission(value: unknown) {
  return value === 'accessibility' || value === 'automation' || value === 'all' ? value : 'all';
}

function macBlocked(
  message: string,
  code: string
): { status: ToolResultStatus; content: Record<string, unknown> } {
  return {
    status: 'blocked',
    content: {
      success: false,
      error: { code, message },
    },
  };
}

function envelopeForMacResult(
  request: ToolExecutionRequest,
  startedAt: Date,
  startedMs: number,
  status: ToolResultStatus,
  structuredContent: Record<string, unknown>
): ToolResultEnvelope {
  const success = structuredContent.success !== false && status === 'success';
  const message =
    extractMessage(structuredContent) ||
    (success ? 'macOS capability completed.' : 'macOS capability failed.');
  return {
    ok: success,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    status,
    text: message,
    structuredContent,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: success
        ? []
        : [{ code: 'macos_adapter_error', message, tool: request.manifest.id }],
      timedOutStages: [],
      blockedTools: status === 'blocked' ? [{ tool: request.manifest.id, reason: message }] : [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures:
        status === 'blocked' ? [{ stage: 'execute', action: 'macos-policy', reason: message }] : [],
    },
    trust: {
      source: 'macos',
      sanitized: true,
      containsUntrustedText: request.manifest.externalTrust?.outputContainsUntrustedText ?? false,
      containsSecrets: false,
    },
  };
}

function extractMessage(content: Record<string, unknown>) {
  const error = content.error as { message?: unknown } | undefined;
  if (typeof error?.message === 'string') {
    return error.message;
  }
  if (typeof content.message === 'string') {
    return content.message;
  }
  return null;
}

export default MacSystemAdapter;
