import { afterEach, describe, expect, test, vi } from 'vitest';

const envBackup = { ...process.env };

afterEach(() => {
  process.env = { ...envBackup };
  vi.doUnmock('@alembic/core/shared');
  vi.resetModules();
});

async function loadModule() {
  return await import('@alembic/core/host-agent-workflows');
}

function mockTerminalToolset(toolset = 'terminal-run') {
  process.env.ALEMBIC_TERMINAL_TOOLSET = toolset;
  vi.doMock('@alembic/core/shared', () => ({
    getTestModeConfig: () => ({
      enabled: false,
      bootstrapDims: [],
      rescanDims: [],
      terminal: { enabled: toolset !== 'baseline', toolset },
      sandbox: { mode: 'enforce', available: true },
    }),
  }));
}

describe('BootstrapTerminalToolset', () => {
  test('defaults to sandboxed terminal-run', async () => {
    delete process.env.ALEMBIC_TERMINAL_TOOLSET;
    mockTerminalToolset();

    const { resolveBootstrapTerminalToolset, getBootstrapStageTerminalTools } = await loadModule();
    const config = resolveBootstrapTerminalToolset();

    expect(config).toEqual({
      enabled: true,
      toolset: 'terminal-run',
      modes: ['run'],
    });
    expect(getBootstrapStageTerminalTools('analyze', config)).toEqual(['terminal']);
    expect(getBootstrapStageTerminalTools('produce', config)).toEqual([]);
  });

  test('allows explicit baseline to disable terminal tools', async () => {
    mockTerminalToolset('baseline');
    const { resolveBootstrapTerminalToolset, getBootstrapStageTerminalTools } = await loadModule();
    const config = resolveBootstrapTerminalToolset();

    expect(config).toEqual({
      enabled: false,
      toolset: 'baseline',
      modes: [],
    });
    expect(getBootstrapStageTerminalTools('analyze', config)).toEqual([]);
  });

  test('collapses legacy wider terminal toolsets to live terminal exec', async () => {
    mockTerminalToolset('terminal-pty');
    const { resolveBootstrapTerminalToolset, getBootstrapStageTerminalTools } = await loadModule();
    const config = resolveBootstrapTerminalToolset();

    expect(config).toEqual({
      enabled: true,
      toolset: 'terminal-run',
      modes: ['run'],
    });
    expect(getBootstrapStageTerminalTools('analyze', config)).toEqual(['terminal']);
    expect(getBootstrapStageTerminalTools('evolve', config)).toEqual(['terminal']);
  });
});
