import type { ToolCallRequest } from '@alembic/agent';
import { ToolRouterAdapter } from '@alembic/agent/tools/runtime';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ToolContextFactory } from '../../lib/tools/v2/ToolContextFactory.js';

const sandboxExecMock = vi.hoisted(() => vi.fn());

vi.mock('#sandbox/SandboxExecutor.js', () => ({
  sandboxExec: sandboxExecMock,
}));

const PROJECT_ROOT = process.cwd();

describe('ToolContextFactory', () => {
  beforeEach(() => {
    sandboxExecMock.mockReset();
  });

  test('injects auditSink from the host auditLogger service', () => {
    const auditLogger = { log: vi.fn() };
    const factory = new ToolContextFactory({
      container: {
        get: (name: string) => (name === 'auditLogger' ? auditLogger : undefined),
      },
      projectRoot: PROJECT_ROOT,
    });

    const ctx = factory.create({
      args: { action: 'exec', params: { command: 'echo hello' } },
      toolId: 'terminal',
    } as ToolCallRequest);

    expect(ctx.auditSink).toBe(auditLogger);
  });

  test('passes sandbox degradation diagnostics through terminal.exec envelopes', async () => {
    sandboxExecMock.mockResolvedValue({
      degradeReason: 'seatbelt_unavailable',
      exitCode: 0,
      sandboxed: false,
      stderr: '',
      stdout: 'bridge ok\n',
    });
    const factory = new ToolContextFactory({
      container: { get: () => undefined },
      projectRoot: PROJECT_ROOT,
    });
    const adapter = new ToolRouterAdapter({ contextFactory: factory });

    const envelope = await adapter.execute({
      actor: { role: 'runtime', user: 'test' },
      args: { action: 'exec', params: { command: 'echo bridge ok' } },
      source: { kind: 'runtime', name: 'test' },
      surface: 'runtime',
      toolId: 'terminal',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.text).toContain('bridge ok');
    expect(envelope.text).toContain('[unsandboxed:seatbelt_unavailable]');
    expect(envelope.diagnostics.fallbackUsed).toBe(true);
    expect(envelope.diagnostics.warnings).toContainEqual(
      expect.objectContaining({
        code: 'terminal_sandbox_fallback',
        message: expect.stringContaining('degradeReason=seatbelt_unavailable'),
      })
    );
    expect(sandboxExecMock).toHaveBeenCalledTimes(1);
  });
});
