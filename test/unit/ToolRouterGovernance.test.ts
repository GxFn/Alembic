import { describe, expect, test, vi } from 'vitest';
import { InternalToolAdapter } from '../../lib/agent/adapters/InternalToolAdapter.js';
import { TerminalAdapter } from '../../lib/agent/adapters/TerminalAdapter.js';
import { TERMINAL_RUN_CAPABILITY } from '../../lib/agent/adapters/TerminalCapabilities.js';
import { GovernanceEngine } from '../../lib/agent/core/GovernanceEngine.js';
import type {
  ToolCallRequest,
  ToolExecutionAdapter,
  ToolExecutionRequest,
} from '../../lib/agent/core/ToolContracts.js';
import type { ToolResultEnvelope } from '../../lib/agent/core/ToolResultEnvelope.js';
import { ToolRouter } from '../../lib/agent/core/ToolRouter.js';
import { PolicyEngine, SafetyPolicy } from '../../lib/agent/policies.js';
import { CapabilityCatalog } from '../../lib/agent/tools/CapabilityCatalog.js';
import type { ToolCapabilityManifest } from '../../lib/agent/tools/CapabilityManifest.js';
import { buildInternalToolCapabilities } from '../../lib/agent/tools/CapabilityProjection.js';
import { TOOL_CAPABILITY_CATALOG } from '../../lib/agent/tools/index.js';
import { ToolRegistry } from '../../lib/agent/tools/ToolRegistry.js';

function baseRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    toolId: 'read_project_file',
    args: { filePath: 'README.md' },
    surface: 'runtime',
    actor: { role: 'developer', user: 'local' },
    source: { kind: 'runtime', name: 'test' },
    ...overrides,
  };
}

async function envelopeFor(request: ToolExecutionRequest): Promise<ToolResultEnvelope> {
  return {
    ok: true,
    toolId: request.manifest.id,
    callId: request.context.callId,
    parentCallId: request.context.parentCallId,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    status: 'success',
    text: `executed ${request.manifest.id}`,
    structuredContent: { args: request.args },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

function testManifest(
  id: string,
  concurrency: ToolCapabilityManifest['execution']['concurrency']
): ToolCapabilityManifest {
  const manifest = TOOL_CAPABILITY_CATALOG.getManifest('read_project_file');
  if (!manifest) {
    throw new Error('read_project_file manifest missing');
  }
  return {
    ...manifest,
    id,
    execution: {
      ...manifest.execution,
      timeoutMs: 0,
      cachePolicy: 'none',
      concurrency,
    },
  };
}

async function waitForRouterTurn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ToolRouter + GovernanceEngine', () => {
  test('executes allowed capabilities through the registered adapter', async () => {
    const execute = vi.fn(envelopeFor);
    const adapter: ToolExecutionAdapter = { kind: 'internal-tool', execute };
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      governance: new GovernanceEngine(),
      adapters: [adapter],
    });

    const result = await router.execute(baseRequest());

    expect(result).toMatchObject({ ok: true, toolId: 'read_project_file', status: 'success' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'read_project_file' }),
        args: { filePath: 'README.md' },
        context: expect.objectContaining({
          surface: 'runtime',
          actor: { role: 'developer', user: 'local' },
        }),
      })
    );
  });

  test('routes terminal-profile capabilities through TerminalAdapter', async () => {
    const router = new ToolRouter({
      catalog: new CapabilityCatalog([TERMINAL_RUN_CAPABILITY]),
      adapters: [new TerminalAdapter()],
      projectRoot: process.cwd(),
    });

    const result = await router.execute(
      baseRequest({
        toolId: 'terminal_run',
        args: {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write("router-terminal")'],
        },
      })
    );

    expect(result).toMatchObject({
      ok: true,
      toolId: 'terminal_run',
      status: 'success',
      trust: { source: 'terminal', containsUntrustedText: true },
      structuredContent: {
        exitCode: 0,
        stdout: 'router-terminal',
        bin: process.execPath,
      },
    });
  });

  test('adds terminal execution preview to explain decisions', async () => {
    const router = new ToolRouter({
      catalog: new CapabilityCatalog([TERMINAL_RUN_CAPABILITY]),
      adapters: [new TerminalAdapter()],
      projectRoot: process.cwd(),
    });

    const decision = await router.explain(
      baseRequest({
        toolId: 'terminal_run',
        args: {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write("preview")'],
        },
      })
    );

    expect(decision).toMatchObject({
      allowed: true,
      stage: 'execute',
      preview: {
        kind: 'terminal-command',
        summary: expect.stringContaining(process.execPath),
        risk: 'medium',
        details: {
          command: expect.stringContaining('preview'),
          cwd: process.cwd(),
          network: 'none',
          filesystem: 'read-only',
          allowed: true,
        },
      },
    });
  });

  test('includes terminal preview in blocked router envelopes', async () => {
    const router = new ToolRouter({
      catalog: new CapabilityCatalog([
        {
          ...TERMINAL_RUN_CAPABILITY,
          governance: {
            ...TERMINAL_RUN_CAPABILITY.governance,
            approvalPolicy: 'confirm-every-time',
          },
        },
      ]),
      adapters: [new TerminalAdapter()],
      projectRoot: process.cwd(),
    });

    const result = await router.execute(
      baseRequest({
        toolId: 'terminal_run',
        args: { bin: process.execPath, args: ['-e', 'process.stdout.write("needs-confirmation")'] },
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'needs-confirmation',
      structuredContent: {
        preview: {
          kind: 'terminal-command',
          details: {
            command: expect.stringContaining('needs-confirmation'),
            allowed: true,
          },
        },
      },
    });
  });

  test('applies runtime SafetyPolicy to terminal_run before adapter execution', async () => {
    const execute = vi.fn(envelopeFor);
    const router = new ToolRouter({
      catalog: new CapabilityCatalog([TERMINAL_RUN_CAPABILITY]),
      adapters: [{ kind: 'terminal-profile', execute }],
      projectRoot: process.cwd(),
    });

    const result = await router.execute(
      baseRequest({
        toolId: 'terminal_run',
        args: { bin: 'rm', args: ['-rf', '/'] },
        runtime: {
          agentId: 'runtime-terminal',
          policyValidator: new PolicyEngine([new SafetyPolicy()]),
        },
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: expect.stringContaining('[SafetyPolicy] 命令拦截'),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('normalizes tool input before governance and adapter execution', async () => {
    const execute = vi.fn(envelopeFor);
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      governance: new GovernanceEngine(),
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(baseRequest({ args: { file_path: 'README.md' } }));

    expect(result).toMatchObject({ ok: true, status: 'success' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { filePath: 'README.md' },
      })
    );
  });

  test('blocks invalid input during the governance plan stage', async () => {
    const execute = vi.fn(envelopeFor);
    const manifest = TOOL_CAPABILITY_CATALOG.getManifest('read_project_file');
    if (!manifest) {
      throw new Error('read_project_file manifest missing');
    }
    const catalog = new CapabilityCatalog([
      {
        ...manifest,
        id: 'validate_input_tool',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
      },
    ]);
    const router = new ToolRouter({
      catalog,
      governance: new GovernanceEngine(),
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(baseRequest({ toolId: 'validate_input_tool', args: {} }));

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: expect.stringContaining('input validation failed'),
    });
    expect(result.diagnostics.gateFailures[0]).toMatchObject({ stage: 'plan' });
    expect(execute).not.toHaveBeenCalled();
  });

  test('blocks unknown capabilities before adapter execution', async () => {
    const execute = vi.fn(envelopeFor);
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(baseRequest({ toolId: 'missing_tool' }));

    expect(result).toMatchObject({
      ok: false,
      toolId: 'missing_tool',
      status: 'blocked',
    });
    expect(result.diagnostics.gateFailures[0]).toMatchObject({ stage: 'discover' });
    expect(execute).not.toHaveBeenCalled();
  });

  test('blocks capabilities that are not exposed on the requested surface', async () => {
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute: vi.fn(envelopeFor) }],
    });

    const result = await router.execute(baseRequest({ surface: 'dashboard' }));

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: expect.stringContaining('not exposed on dashboard'),
    });
  });

  test('blocks non-composable tools from composer child calls', async () => {
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute: vi.fn(envelopeFor) }],
    });

    const result = await router.executeChildCall(
      baseRequest({
        toolId: 'get_tool_details',
        surface: 'composer',
        parentCallId: 'parent-1',
      }) as ToolCallRequest & { parentCallId: string }
    );

    expect(result).toMatchObject({
      ok: false,
      parentCallId: 'parent-1',
      status: 'blocked',
      text: expect.stringContaining('not composable'),
    });
  });

  test('returns needs-confirmation without executing the adapter', async () => {
    const manifest = TOOL_CAPABILITY_CATALOG.getManifest('read_project_file');
    if (!manifest) {
      throw new Error('read_project_file manifest missing');
    }
    const catalog = new CapabilityCatalog([
      {
        ...manifest,
        id: 'confirm_tool',
        governance: {
          ...manifest.governance,
          approvalPolicy: 'confirm-every-time',
        },
      },
    ]);
    const execute = vi.fn(envelopeFor);
    const router = new ToolRouter({
      catalog,
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(baseRequest({ toolId: 'confirm_tool' }));

    expect(result).toMatchObject({
      ok: false,
      status: 'needs-confirmation',
      nextActionHint: expect.stringContaining('confirmation'),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('blocks disallowed roles on external surfaces', async () => {
    const execute = vi.fn(envelopeFor);
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(
      baseRequest({
        surface: 'http',
        actor: { role: 'visitor', user: 'anonymous' },
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: expect.stringContaining("Role 'visitor' is not allowed"),
    });
    expect(result.diagnostics.gateFailures[0]).toMatchObject({ stage: 'approve' });
    expect(execute).not.toHaveBeenCalled();
  });

  test('runs Gateway checkOnly during approve when governance metadata is present', async () => {
    const execute = vi.fn(envelopeFor);
    const checkOnly = vi.fn().mockResolvedValue({ success: true, requestId: 'gw-ok' });
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute }],
      services: {
        get: <T = unknown>(name: string) => (name === 'gateway' ? { checkOnly } : null) as T,
      },
    });

    const result = await router.execute(
      baseRequest({
        surface: 'http',
        actor: { role: 'developer', user: 'local', sessionId: 's1' },
      })
    );

    expect(result).toMatchObject({ ok: true, status: 'success' });
    expect(checkOnly).toHaveBeenCalledWith({
      actor: 'developer',
      action: 'read:project',
      resource: 'project',
      data: expect.objectContaining({
        tool: 'read_project_file',
        args: { filePath: 'README.md' },
        surface: 'http',
        _resolvedUser: 'local',
      }),
      session: 's1',
    });
  });

  test('blocks execution when Gateway checkOnly denies capability', async () => {
    const execute = vi.fn(envelopeFor);
    const checkOnly = vi.fn().mockResolvedValue({
      success: false,
      requestId: 'gw-denied',
      error: { message: 'Permission denied', code: 'PERMISSION_DENIED', statusCode: 403 },
    });
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute }],
      services: {
        get: <T = unknown>(name: string) => (name === 'gateway' ? { checkOnly } : null) as T,
      },
    });

    const result = await router.execute(
      baseRequest({
        surface: 'http',
        actor: { role: 'developer', user: 'local' },
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: 'Permission denied',
    });
    expect(result.diagnostics.gateFailures[0]).toMatchObject({
      stage: 'approve',
      reason: 'Permission denied',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('blocks runtime execution when the runtime policy denies the tool call', async () => {
    const execute = vi.fn(envelopeFor);
    const policyValidator = {
      validateToolCall: vi.fn().mockReturnValue({
        ok: false,
        reason: '[SafetyPolicy] 命令拦截: dangerous command',
      }),
    };
    const router = new ToolRouter({
      catalog: new CapabilityCatalog([TERMINAL_RUN_CAPABILITY]),
      adapters: [{ kind: 'terminal-profile', execute }],
    });

    const result = await router.execute(
      baseRequest({
        toolId: 'terminal_run',
        args: { bin: 'rm', args: ['-rf', '/tmp/demo'] },
        runtime: {
          agentId: 'runtime-1',
          presetName: 'remote-exec',
          iteration: 1,
          policyValidator,
        },
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: '[SafetyPolicy] 命令拦截: dangerous command',
    });
    expect(result.diagnostics.gateFailures[0]).toMatchObject({
      stage: 'approve',
      reason: '[SafetyPolicy] 命令拦截: dangerous command',
    });
    expect(policyValidator.validateToolCall).toHaveBeenCalledWith('terminal_run', {
      bin: 'rm',
      args: ['-rf', '/tmp/demo'],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('passes runtime execution when the runtime policy allows the tool call', async () => {
    const execute = vi.fn(envelopeFor);
    const policyValidator = {
      validateToolCall: vi.fn().mockReturnValue({ ok: true }),
    };
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(
      baseRequest({
        runtime: {
          agentId: 'runtime-1',
          presetName: 'chat',
          iteration: 1,
          policyValidator,
        },
      })
    );

    expect(result).toMatchObject({ ok: true, status: 'success' });
    expect(policyValidator.validateToolCall).toHaveBeenCalledWith('read_project_file', {
      filePath: 'README.md',
    });
    expect(execute).toHaveBeenCalled();
  });

  test('returns aborted when abortSignal is already aborted before adapter execution', async () => {
    const execute = vi.fn(envelopeFor);
    const abortController = new AbortController();
    abortController.abort();
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(
      baseRequest({
        abortSignal: abortController.signal,
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'aborted',
      text: 'Tool execution aborted before start',
    });
    expect(result.diagnostics.gateFailures[0]).toMatchObject({
      stage: 'execute',
      reason: 'Tool execution aborted before start',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('returns cached runtime results before adapter execution when manifest allows caching', async () => {
    const execute = vi.fn(envelopeFor);
    const cache = {
      getCachedResult: vi.fn().mockReturnValue({ content: 'cached file' }),
      cacheToolResult: vi.fn(),
    };
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(
      baseRequest({
        runtime: {
          agentId: 'runtime-1',
          cache,
        },
      })
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      structuredContent: { content: 'cached file' },
      cache: { hit: true, policy: 'session' },
    });
    expect(cache.getCachedResult).toHaveBeenCalledWith('read_project_file', {
      filePath: 'README.md',
    });
    expect(cache.cacheToolResult).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test('writes successful runtime results to cache according to manifest cache policy', async () => {
    const execute = vi.fn(envelopeFor);
    const cache = {
      getCachedResult: vi.fn().mockReturnValue(null),
      cacheToolResult: vi.fn(),
    };
    const router = new ToolRouter({
      catalog: TOOL_CAPABILITY_CATALOG,
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(
      baseRequest({
        runtime: {
          agentId: 'runtime-1',
          cache,
        },
      })
    );

    expect(result).toMatchObject({ ok: true, status: 'success' });
    expect(execute).toHaveBeenCalled();
    expect(cache.cacheToolResult).toHaveBeenCalledWith(
      'read_project_file',
      { filePath: 'README.md' },
      expect.objectContaining({
        ok: true,
        toolId: 'read_project_file',
        cache: { hit: false, policy: 'session' },
      })
    );
  });

  test('returns timeout and aborts the adapter signal when execution exceeds manifest timeout', async () => {
    const manifest = TOOL_CAPABILITY_CATALOG.getManifest('read_project_file');
    if (!manifest) {
      throw new Error('read_project_file manifest missing');
    }
    const catalog = new CapabilityCatalog([
      {
        ...manifest,
        id: 'timeout_tool',
        execution: {
          ...manifest.execution,
          timeoutMs: 5,
          cachePolicy: 'none',
        },
      },
    ]);
    const captured: { signal: AbortSignal | null } = { signal: null };
    const execute = vi.fn((request: ToolExecutionRequest) => {
      captured.signal = request.context.abortSignal || null;
      return new Promise<ToolResultEnvelope>(() => {
        /* unresolved adapter; ToolRouter owns the timeout */
      });
    });
    const router = new ToolRouter({
      catalog,
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const result = await router.execute(baseRequest({ toolId: 'timeout_tool' }));

    expect(result).toMatchObject({
      ok: false,
      toolId: 'timeout_tool',
      status: 'timeout',
      text: "Tool 'timeout_tool' timed out after 5ms",
      diagnostics: {
        timedOutStages: ['timeout_tool'],
        gateFailures: [
          {
            stage: 'execute',
            action: 'timeout',
            reason: "Tool 'timeout_tool' timed out after 5ms",
          },
        ],
      },
    });
    expect(execute).toHaveBeenCalled();
    if (!captured.signal) {
      throw new Error('adapter abort signal was not captured');
    }
    expect(captured.signal.aborted).toBe(true);
  });

  test('blocks overlapping calls for single-concurrency capabilities', async () => {
    const execute = vi.fn(
      () =>
        new Promise<ToolResultEnvelope>(() => {
          /* keep the first call running */
        })
    );
    const router = new ToolRouter({
      catalog: new CapabilityCatalog([testManifest('single_tool', 'single')]),
      adapters: [{ kind: 'internal-tool', execute }],
    });

    void router.execute(baseRequest({ toolId: 'single_tool' }));
    await waitForRouterTurn();

    const result = await router.execute(baseRequest({ toolId: 'single_tool' }));

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: "Capability 'single_tool' is already running",
      diagnostics: {
        gateFailures: [
          {
            stage: 'execute',
            action: 'concurrency',
            reason: "Capability 'single_tool' is already running",
          },
        ],
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('releases single-concurrency slots after adapter completion', async () => {
    const execute = vi.fn(envelopeFor);
    const router = new ToolRouter({
      catalog: new CapabilityCatalog([testManifest('single_tool', 'single')]),
      adapters: [{ kind: 'internal-tool', execute }],
    });

    const first = await router.execute(baseRequest({ toolId: 'single_tool' }));
    const second = await router.execute(baseRequest({ toolId: 'single_tool' }));

    expect(first).toMatchObject({ ok: true, status: 'success' });
    expect(second).toMatchObject({ ok: true, status: 'success' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('blocks all other capabilities while an exclusive capability is running', async () => {
    const execute = vi.fn(
      () =>
        new Promise<ToolResultEnvelope>(() => {
          /* keep the exclusive call running */
        })
    );
    const router = new ToolRouter({
      catalog: new CapabilityCatalog([
        testManifest('exclusive_tool', 'exclusive'),
        testManifest('parallel_tool', 'parallel-safe'),
      ]),
      adapters: [{ kind: 'internal-tool', execute }],
    });

    void router.execute(baseRequest({ toolId: 'exclusive_tool' }));
    await waitForRouterTurn();

    const result = await router.execute(baseRequest({ toolId: 'parallel_tool' }));

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: "Capability 'parallel_tool' cannot start while exclusive capability 'exclusive_tool' is running",
      diagnostics: {
        gateFailures: [
          {
            stage: 'execute',
            action: 'concurrency',
            reason:
              "Capability 'parallel_tool' cannot start while exclusive capability 'exclusive_tool' is running",
          },
        ],
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('runs registry calls through router and InternalToolAdapter when wired', async () => {
    const handler = vi.fn(
      async (
        params: Record<string, unknown>,
        context: { projectRoot: string; toolCallContext?: { callId: string; toolId: string } }
      ) => ({
        greeting: `Hello ${params.name}`,
        projectRoot: context.projectRoot,
        toolCallId: context.toolCallContext?.callId,
        toolCallToolId: context.toolCallContext?.toolId,
      })
    );
    const tool = {
      name: 'greet_user',
      description: 'Greet a user',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      handler,
    };
    const capabilities = buildInternalToolCapabilities([tool]);
    const registry = new ToolRegistry();
    registry.registerAll(capabilities.tools);
    const router = new ToolRouter({
      catalog: capabilities.catalog,
      adapters: [new InternalToolAdapter(registry)],
      projectRoot: '/tmp/project',
      services: { get: <T = unknown>() => null as T },
    });
    registry.setRouter(router);

    const envelope = await router.execute(
      baseRequest({ toolId: 'greet_user', args: { name: 'Ada' } })
    );

    expect(envelope).toMatchObject({
      ok: true,
      status: 'success',
      structuredContent: {
        greeting: 'Hello Ada',
        projectRoot: '/tmp/project',
        toolCallToolId: 'greet_user',
      },
      trust: { source: 'internal', sanitized: true },
    });
    expect(envelope.structuredContent).toMatchObject({
      toolCallId: expect.any(String),
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect('executeInternal' in registry).toBe(false);
  });
});
