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

describe('GenerateTerminalToolset', () => {
  test('defaults to sandboxed terminal-run', async () => {
    delete process.env.ALEMBIC_TERMINAL_TOOLSET;
    mockTerminalToolset();

    const { resolveGenerateTerminalToolset, getGenerateStageTerminalTools } = await loadModule();
    const config = resolveGenerateTerminalToolset();

    expect(config).toEqual({
      enabled: true,
      toolset: 'terminal-run',
      modes: ['run'],
    });
    expect(getGenerateStageTerminalTools('analyze', config)).toEqual(['terminal']);
    expect(getGenerateStageTerminalTools('produce', config)).toEqual([]);
  });

  test('allows explicit baseline to disable terminal tools', async () => {
    mockTerminalToolset('baseline');
    const { resolveGenerateTerminalToolset, getGenerateStageTerminalTools } = await loadModule();
    const config = resolveGenerateTerminalToolset();

    expect(config).toEqual({
      enabled: false,
      toolset: 'baseline',
      modes: [],
    });
    expect(getGenerateStageTerminalTools('analyze', config)).toEqual([]);
  });

  test('collapses legacy wider terminal toolsets to live terminal exec', async () => {
    mockTerminalToolset('terminal-pty');
    const { resolveGenerateTerminalToolset, getGenerateStageTerminalTools } = await loadModule();
    const config = resolveGenerateTerminalToolset();

    expect(config).toEqual({
      enabled: true,
      toolset: 'terminal-run',
      modes: ['run'],
    });
    expect(getGenerateStageTerminalTools('analyze', config)).toEqual(['terminal']);
    expect(getGenerateStageTerminalTools('evolve', config)).toEqual(['terminal']);
  });
});
