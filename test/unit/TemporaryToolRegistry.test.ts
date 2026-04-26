import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TemporaryToolRegistry } from '../../lib/agent/forge/TemporaryToolRegistry.js';

/* ────────── Mock ToolRegistry ────────── */

function createMockRegistry() {
  const tools = new Map<string, unknown>();
  return {
    projectForgedTool: vi.fn((def: { name: string }) => {
      tools.set(def.name, def);
    }),
    revokeForgedTool: vi.fn((name: string) => tools.delete(name)),
    hasInternalTool: vi.fn((name: string) => tools.has(name)),
    _tools: tools,
  };
}

function createMockSignalBus() {
  return {
    send: vi.fn(),
    emit: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as import('../../lib/infrastructure/signal/SignalBus.js').SignalBus;
}

const TOOL_BASE = {
  description: 'test tool',
  parameters: {},
  handler: async () => ({ ok: true }),
  forgeMode: 'generate' as const,
};

describe('TemporaryToolRegistry', () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let signalBus: ReturnType<typeof createMockSignalBus>;
  let tempReg: TemporaryToolRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = createMockRegistry();
    signalBus = createMockSignalBus();
    tempReg = new TemporaryToolRegistry(registry, { signalBus });
  });

  afterEach(() => {
    tempReg.dispose();
    vi.useRealTimers();
  });

  describe('registerTemporary', () => {
    it('should project generated tool to forged internal store', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'my_tool' });
      expect(registry.projectForgedTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my_tool',
          description: 'test tool',
          forgeMode: 'generate',
        })
      );
    });

    it('should emit forge signal on register', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'sig_tool' });
      expect(signalBus.send).toHaveBeenCalledWith(
        'forge',
        'TemporaryToolRegistry',
        1,
        expect.objectContaining({ target: 'sig_tool' })
      );
    });

    it('should replace existing temp tool with same name', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'dup' });
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'dup' });
      expect(registry.revokeForgedTool).toHaveBeenCalledWith('dup');
      const list = tempReg.list();
      expect(list.filter((t) => t.name === 'dup')).toHaveLength(1);
    });

    it('should reject a temporary tool that conflicts with an existing static tool', () => {
      registry._tools.set('read_project_file', {});
      expect(() => {
        tempReg.registerTemporary({ ...TOOL_BASE, name: 'read_project_file' });
      }).toThrow('conflicts with an existing static tool');
    });

    it('should reject non-generated temporary tools from internal-store projection', () => {
      expect(() => {
        tempReg.registerTemporary({ ...TOOL_BASE, name: 'workflow_tool', forgeMode: 'compose' });
      }).toThrow('cannot be projected as a forged internal tool');
    });

    it('should track temporary capability without projecting it to the internal store', () => {
      tempReg.registerTemporary(
        { ...TOOL_BASE, name: 'workflow_tool', forgeMode: 'compose' },
        1000,
        {
          projectIntoInternalToolStore: false,
        }
      );

      expect(tempReg.isTemporary('workflow_tool')).toBe(true);
      expect(registry.projectForgedTool).not.toHaveBeenCalled();
      expect(tempReg.list()).toEqual([
        expect.objectContaining({
          name: 'workflow_tool',
          forgeMode: 'compose',
          projectedIntoInternalToolStore: false,
        }),
      ]);
    });
  });

  describe('revoke', () => {
    it('should remove temp tool and revoke from forged internal store', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'rev_tool' });
      const result = tempReg.revoke('rev_tool');
      expect(result).toBe(true);
      expect(registry.revokeForgedTool).toHaveBeenCalledWith('rev_tool');
      expect(tempReg.list()).toHaveLength(0);
    });

    it('should revoke tracked-only temporary capability without touching internal store', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'workflow_rev' }, 1000, {
        projectIntoInternalToolStore: false,
      });
      const result = tempReg.revoke('workflow_rev');

      expect(result).toBe(true);
      expect(registry.revokeForgedTool).not.toHaveBeenCalledWith('workflow_rev');
      expect(tempReg.list()).toHaveLength(0);
    });

    it('should return false for non-existent tool', () => {
      expect(tempReg.revoke('ghost')).toBe(false);
    });

    it('should emit forge signal on revoke', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'sig_rev' });
      signalBus.send = vi.fn(); // reset
      tempReg.revoke('sig_rev');
      expect(signalBus.send).toHaveBeenCalledWith(
        'forge',
        'TemporaryToolRegistry',
        0,
        expect.objectContaining({ target: 'sig_rev' })
      );
    });
  });

  describe('renew', () => {
    it('should extend TTL', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'ren' }, 1000);
      const before = tempReg.list().find((t) => t.name === 'ren');
      expect(before).toBeTruthy();

      vi.advanceTimersByTime(500);
      const renewed = tempReg.renew('ren', 5000);
      expect(renewed).toBe(true);

      const after = tempReg.list().find((t) => t.name === 'ren');
      expect(after?.remainingMs).toBeGreaterThan(4000);
    });

    it('should return false for non-existent tool', () => {
      expect(tempReg.renew('ghost', 1000)).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should auto-remove expired tools', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'exp_tool' }, 2000);
      expect(tempReg.list()).toHaveLength(1);

      // 推进时间到过期
      vi.advanceTimersByTime(60_000 + 2001);
      expect(tempReg.list()).toHaveLength(0);
      expect(registry.revokeForgedTool).toHaveBeenCalledWith('exp_tool');
    });

    it('should expire tracked-only capability without revoking from internal store', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'exp_workflow' }, 2000, {
        projectIntoInternalToolStore: false,
      });

      vi.advanceTimersByTime(60_000 + 2001);
      expect(tempReg.list()).toHaveLength(0);
      expect(registry.revokeForgedTool).not.toHaveBeenCalledWith('exp_workflow');
    });

    it('should not remove tool with TTL=0 (never expires)', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'forever_tool' }, 0);
      vi.advanceTimersByTime(120_000);
      expect(tempReg.list()).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('should return info for all temporary tools', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'a', forgeMode: 'compose' }, undefined, {
        projectIntoInternalToolStore: false,
      });
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'b', forgeMode: 'generate' });

      const list = tempReg.list();
      expect(list).toHaveLength(2);
      expect(list.map((t) => t.name).sort()).toEqual(['a', 'b']);
      expect(list.find((t) => t.name === 'a')?.forgeMode).toBe('compose');
    });
  });

  describe('dispose', () => {
    it('should revoke all temp tools and stop cleanup', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'x' });
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'y' });
      tempReg.dispose();
      expect(tempReg.list()).toHaveLength(0);
      expect(registry.revokeForgedTool).toHaveBeenCalledWith('x');
      expect(registry.revokeForgedTool).toHaveBeenCalledWith('y');
    });
  });
});
