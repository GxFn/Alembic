import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { TerminalAdapter } from '../../lib/agent/adapters/TerminalAdapter.js';
import {
  TERMINAL_RUN_CAPABILITY,
  TERMINAL_SESSION_CLEANUP_CAPABILITY,
  TERMINAL_SESSION_CLOSE_CAPABILITY,
} from '../../lib/agent/adapters/TerminalCapabilities.js';
import { InMemoryTerminalSessionManager } from '../../lib/agent/adapters/TerminalSessionManager.js';
import type { ToolExecutionRequest } from '../../lib/agent/core/ToolContracts.js';
import type { ToolCapabilityManifest } from '../../lib/agent/tools/CapabilityManifest.js';

function request(
  args: Record<string, unknown>,
  options: {
    projectRoot?: string;
    maxOutputBytes?: number;
    manifest?: ToolCapabilityManifest;
    services?: Record<string, unknown>;
  } = {}
): ToolExecutionRequest {
  const projectRoot = options.projectRoot || path.resolve(os.tmpdir());
  const manifest = options.manifest || TERMINAL_RUN_CAPABILITY;
  return {
    manifest: {
      ...manifest,
      execution: {
        ...manifest.execution,
        maxOutputBytes: options.maxOutputBytes || manifest.execution.maxOutputBytes,
      },
    },
    args,
    decision: { allowed: true, stage: 'execute' },
    context: {
      callId: 'call-terminal',
      toolId: manifest.id,
      surface: 'runtime',
      actor: { role: 'developer' },
      source: { kind: 'runtime', name: 'terminal-adapter-test' },
      projectRoot,
      services: {
        get(name: string) {
          if (options.services && name in options.services) {
            return options.services[name];
          }
          throw new Error(`Unexpected service lookup: ${name}`);
        },
      },
    },
  };
}

describe('TerminalAdapter', () => {
  test('executes structured command with execFile', async () => {
    const adapter = new TerminalAdapter();

    const result = await adapter.execute(
      request({
        bin: process.execPath,
        args: ['-e', 'process.stdout.write("ok")'],
      })
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      trust: { source: 'terminal', containsUntrustedText: true },
      structuredContent: {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        bin: process.execPath,
        session: {
          mode: 'ephemeral',
          id: null,
          cwdPersistence: 'none',
          envPersistence: 'none',
          processPersistence: 'none',
        },
        interactive: 'never',
        sessionRecord: {
          id: 'ephemeral:call-terminal',
          mode: 'ephemeral',
          status: 'closed',
          activeCallId: null,
          commandCount: 1,
        },
      },
    });
  });

  test('returns error envelope for non-zero exit', async () => {
    const adapter = new TerminalAdapter();

    const result = await adapter.execute(
      request({
        bin: process.execPath,
        args: ['-e', 'process.stderr.write("bad"); process.exit(2)'],
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      structuredContent: {
        exitCode: 2,
        stderr: 'bad',
      },
    });
  });

  test('rejects cwd outside project root', async () => {
    const adapter = new TerminalAdapter();

    const result = await adapter.execute(
      request({
        bin: process.execPath,
        args: ['-e', 'process.stdout.write("no")'],
        cwd: path.resolve(os.tmpdir(), '..'),
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'error',
      structuredContent: {
        error: expect.stringContaining('outside project root'),
      },
    });
  });

  test('returns blocked envelope when terminal policy denies command', async () => {
    const adapter = new TerminalAdapter();

    const result = await adapter.execute(
      request({
        bin: 'bash',
        args: ['-lc', 'echo unsafe'],
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: expect.stringContaining('shell execution'),
      structuredContent: {
        policy: {
          allowed: false,
          matchedRule: 'shell-bin',
        },
      },
      diagnostics: {
        blockedTools: [
          { tool: 'terminal_run', reason: expect.stringContaining('shell execution') },
        ],
      },
    });
  });

  test('blocks commands that request interactive execution', async () => {
    const adapter = new TerminalAdapter();

    const result = await adapter.execute(
      request({
        bin: process.execPath,
        args: ['-e', 'process.stdout.write("prompt")'],
        interactive: 'allowed',
      })
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      text: expect.stringContaining('Interactive terminal commands'),
      structuredContent: {
        policy: {
          allowed: false,
          matchedRule: 'interactive-command',
          preview: {
            interactive: 'allowed',
          },
        },
      },
    });
  });

  test('injects non-interactive environment into child processes', async () => {
    const adapter = new TerminalAdapter();

    const result = await adapter.execute(
      request({
        bin: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({ ci: process.env.CI, gitPrompt: process.env.GIT_TERMINAL_PROMPT, pager: process.env.PAGER }))',
        ],
      })
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(String(result.structuredContent?.stdout))).toEqual({
      ci: '1',
      gitPrompt: '0',
      pager: 'cat',
    });
  });

  test('passes command-scoped environment without persisting it by default', async () => {
    const sessionManager = new InMemoryTerminalSessionManager();
    const adapter = new TerminalAdapter({ sessionManager });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-env-scoped-'));

    const first = await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write(process.env.ALEMBIC_SCOPED_ENV || "")'],
          env: { ALEMBIC_SCOPED_ENV: 'scoped' },
          session: { mode: 'persistent', id: 'env-scoped' },
        },
        { projectRoot }
      )
    );
    const second = await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write(process.env.ALEMBIC_SCOPED_ENV || "")'],
          session: { mode: 'persistent', id: 'env-scoped' },
        },
        { projectRoot }
      )
    );

    expect(first).toMatchObject({
      ok: true,
      structuredContent: {
        stdout: 'scoped',
        env: {
          keys: ['ALEMBIC_SCOPED_ENV'],
          persistence: 'none',
        },
        sessionRecord: {
          envKeys: [],
        },
      },
    });
    expect(second).toMatchObject({
      ok: true,
      structuredContent: {
        stdout: '',
        env: {
          keys: [],
          persistence: 'none',
        },
        sessionRecord: {
          envKeys: [],
        },
      },
    });
  });

  test('persists explicit environment metadata across persistent execFile sessions', async () => {
    const sessionManager = new InMemoryTerminalSessionManager();
    const adapter = new TerminalAdapter({ sessionManager });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-env-persistent-'));
    const session = { mode: 'persistent', id: 'env-persisted', envPersistence: 'explicit' };

    const first = await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write(process.env.ALEMBIC_PERSISTED_ENV || "")'],
          env: { ALEMBIC_PERSISTED_ENV: 'env-value-hidden' },
          session,
        },
        { projectRoot }
      )
    );
    const second = await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write(process.env.ALEMBIC_PERSISTED_ENV || "")'],
          session,
        },
        { projectRoot }
      )
    );

    expect(first).toMatchObject({
      ok: true,
      structuredContent: {
        stdout: 'env-value-hidden',
        env: {
          keys: ['ALEMBIC_PERSISTED_ENV'],
          persistence: 'explicit',
        },
        sessionRecord: {
          envKeys: ['ALEMBIC_PERSISTED_ENV'],
        },
      },
    });
    expect(second).toMatchObject({
      ok: true,
      structuredContent: {
        stdout: 'env-value-hidden',
        env: {
          keys: ['ALEMBIC_PERSISTED_ENV'],
          persistence: 'explicit',
        },
        sessionRecord: {
          envKeys: ['ALEMBIC_PERSISTED_ENV'],
          commandCount: 2,
        },
      },
    });
    expect(sessionManager.snapshot('env-persisted')).toMatchObject({
      envKeys: ['ALEMBIC_PERSISTED_ENV'],
    });
    expect(JSON.stringify(sessionManager.snapshot('env-persisted'))).not.toContain(
      'env-value-hidden'
    );
  });

  test('materializes large stdout as an artifact and keeps inline preview truncated', async () => {
    const adapter = new TerminalAdapter();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-artifacts-'));
    const fullOutput = 'x'.repeat(32);

    const result = await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', `process.stdout.write("${fullOutput}")`],
        },
        { projectRoot, maxOutputBytes: 8 }
      )
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      structuredContent: {
        stdoutTruncated: true,
        stderrTruncated: false,
      },
      artifacts: [
        {
          id: 'call-terminal:stdout',
          kind: 'stdout',
          mimeType: 'text/plain; charset=utf-8',
          sizeBytes: 32,
        },
      ],
    });

    const artifact = result.artifacts?.[0];
    if (!artifact) {
      throw new Error('stdout artifact was not created');
    }
    expect(fs.readFileSync(new URL(artifact.uri), 'utf8')).toBe(fullOutput);
  });

  test('executes structured commands in persistent sessions without opening a shell', async () => {
    const sessionManager = new InMemoryTerminalSessionManager();
    const adapter = new TerminalAdapter({ sessionManager });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-persistent-'));
    const packageRoot = path.join(projectRoot, 'packages', 'app');
    fs.mkdirSync(packageRoot, { recursive: true });
    const realPackageRoot = fs.realpathSync(packageRoot);

    const first = await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write(process.cwd())'],
          cwd: 'packages/app',
          session: { mode: 'persistent', id: 'agent-execfile' },
        },
        { projectRoot }
      )
    );
    const second = await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write(process.cwd())'],
          session: { mode: 'persistent', id: 'agent-execfile' },
        },
        { projectRoot }
      )
    );

    expect(first).toMatchObject({
      ok: true,
      status: 'success',
      structuredContent: {
        stdout: realPackageRoot,
        cwd: packageRoot,
        sessionRecord: {
          id: 'agent-execfile',
          mode: 'persistent',
          status: 'idle',
          commandCount: 1,
        },
      },
    });
    expect(second).toMatchObject({
      ok: true,
      status: 'success',
      structuredContent: {
        stdout: realPackageRoot,
        cwd: packageRoot,
        sessionRecord: {
          id: 'agent-execfile',
          mode: 'persistent',
          status: 'idle',
          commandCount: 2,
        },
      },
    });
    expect(sessionManager.snapshot('agent-execfile')).toMatchObject({
      cwd: packageRoot,
      commandCount: 2,
      status: 'idle',
    });
  });

  test('uses injected terminal session manager for execution leasing', async () => {
    const sessionManager = new InMemoryTerminalSessionManager();
    const adapter = new TerminalAdapter();

    const result = await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write("leased")'],
        },
        { services: { terminalSessionManager: sessionManager } }
      )
    );

    expect(result).toMatchObject({
      ok: true,
      structuredContent: {
        stdout: 'leased',
        sessionRecord: {
          id: 'ephemeral:call-terminal',
          status: 'closed',
          commandCount: 1,
        },
      },
    });
  });

  test('closes and cleans up persistent terminal session metadata', async () => {
    const sessionManager = new InMemoryTerminalSessionManager();
    const adapter = new TerminalAdapter({ sessionManager });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-lifecycle-'));

    await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write("ok")'],
          session: { mode: 'persistent', id: 'session-to-close' },
        },
        { projectRoot }
      )
    );

    const closeResult = await adapter.execute(
      request(
        { id: 'session-to-close' },
        {
          projectRoot,
          manifest: TERMINAL_SESSION_CLOSE_CAPABILITY,
          services: { terminalSessionManager: sessionManager },
        }
      )
    );
    const cleanupResult = await adapter.execute(
      request(
        {},
        {
          projectRoot,
          manifest: TERMINAL_SESSION_CLEANUP_CAPABILITY,
          services: { terminalSessionManager: sessionManager },
        }
      )
    );

    expect(closeResult).toMatchObject({
      ok: true,
      toolId: 'terminal_session_close',
      status: 'success',
      structuredContent: {
        action: 'close',
        id: 'session-to-close',
        closed: true,
        sessionRecord: {
          id: 'session-to-close',
          status: 'closed',
        },
      },
    });
    expect(cleanupResult).toMatchObject({
      ok: true,
      toolId: 'terminal_session_cleanup',
      structuredContent: {
        action: 'cleanup',
        removed: 1,
      },
    });
    expect(sessionManager.snapshot('session-to-close')).toBeNull();
  });

  test('records terminal audit events without including raw output', async () => {
    const auditEntries: Array<Record<string, unknown>> = [];
    const terminalAuditSink = {
      log(entry: Record<string, unknown>) {
        auditEntries.push(entry);
      },
    };
    const sessionManager = new InMemoryTerminalSessionManager();
    const adapter = new TerminalAdapter({ sessionManager });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-audit-'));

    await adapter.execute(
      request(
        {
          bin: process.execPath,
          args: ['-e', 'process.stdout.write("secret-output")'],
          env: { ALEMBIC_AUDIT_ENV: 'secret-env-value' },
          session: { mode: 'persistent', id: 'audit-session' },
        },
        { projectRoot, services: { terminalAuditSink } }
      )
    );
    await adapter.execute(
      request(
        { id: 'audit-session' },
        {
          projectRoot,
          manifest: TERMINAL_SESSION_CLOSE_CAPABILITY,
          services: { terminalAuditSink, terminalSessionManager: sessionManager },
        }
      )
    );

    expect(auditEntries).toHaveLength(2);
    expect(auditEntries[0]).toMatchObject({
      requestId: 'call-terminal',
      action: 'terminal.run',
      resource: 'terminal',
      result: 'success',
      data: {
        toolId: 'terminal_run',
        status: 'success',
        command: {
          bin: process.execPath,
          cwd: projectRoot,
          env: {
            keys: ['ALEMBIC_AUDIT_ENV'],
            persistence: 'none',
          },
          exitCode: 0,
          interactive: 'never',
        },
        session: {
          mode: 'persistent',
          id: 'audit-session',
        },
        sessionRecord: {
          id: 'audit-session',
          status: 'idle',
          commandCount: 1,
        },
      },
    });
    expect(JSON.stringify(auditEntries[0])).not.toContain('secret-output');
    expect(JSON.stringify(auditEntries[0])).not.toContain('secret-env-value');
    expect(auditEntries[1]).toMatchObject({
      action: 'terminal.session.close',
      resource: 'terminal-session',
      result: 'success',
      data: {
        lifecycle: {
          action: 'close',
          id: 'audit-session',
          closed: true,
        },
      },
    });
  });
});
