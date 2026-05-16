import { afterEach, describe, expect, test, vi } from 'vitest';

const envBackup = { ...process.env };

afterEach(() => {
  process.env = { ...envBackup };
  vi.doUnmock('#shared/test-mode.js');
  vi.resetModules();
});

async function loadModule() {
  return await import(
    '../../lib/workflows/capabilities/planning/dimensions/BootstrapTerminalToolset.js'
  );
}

function mockTerminalToolset(toolset = 'terminal-run') {
  vi.doMock('#shared/test-mode.js', () => ({
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

  test('supports wider terminal toolsets through explicit configuration', async () => {
    mockTerminalToolset('terminal-pty');
    const { resolveBootstrapTerminalToolset, getBootstrapStageTerminalTools } = await loadModule();
    const config = resolveBootstrapTerminalToolset();

    expect(config).toEqual({
      enabled: true,
      toolset: 'terminal-pty',
      modes: ['run', 'shell', 'pty'],
    });
    expect(getBootstrapStageTerminalTools('analyze', config)).toEqual([
      'terminal',
      'terminal_shell',
      'terminal_pty',
    ]);
    expect(getBootstrapStageTerminalTools('evolve', config)).toEqual([
      'terminal',
      'terminal_shell',
    ]);
  });
});
