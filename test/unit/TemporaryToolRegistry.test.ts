import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TemporaryToolRegistry } from '../../lib/agent/forge/TemporaryToolRegistry.js';

/* ────────── Mock ToolRegistry ────────── */

function createMockRegistry() {
  const tools = new Map<string, unknown>();
  return {
    register: vi.fn((def: { name: string }) => {
      tools.set(def.name, def);
    }),
    unregister: vi.fn((name: string) => tools.delete(name)),
    has: vi.fn((name: string) => tools.has(name)),
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
    it('should register tool to main registry with forged prefix', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'my_tool' });
      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my_tool',
          description: expect.stringContaining('[Forged:generate]'),
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
      expect(registry.unregister).toHaveBeenCalledWith('dup');
      const list = tempReg.list();
      expect(list.filter((t) => t.name === 'dup')).toHaveLength(1);
    });
  });

  describe('revoke', () => {
    it('should remove temp tool and unregister from main registry', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'rev_tool' });
      const result = tempReg.revoke('rev_tool');
      expect(result).toBe(true);
      expect(registry.unregister).toHaveBeenCalledWith('rev_tool');
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
      expect(after!.remainingMs).toBeGreaterThan(4000);
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
      expect(registry.unregister).toHaveBeenCalledWith('exp_tool');
    });

    it('should not remove tool with TTL=0 (never expires)', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'forever_tool' }, 0);
      vi.advanceTimersByTime(120_000);
      expect(tempReg.list()).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('should return info for all temporary tools', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'a', forgeMode: 'compose' });
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'b', forgeMode: 'generate' });

      const list = tempReg.list();
      expect(list).toHaveLength(2);
      expect(list.map((t) => t.name).sort()).toEqual(['a', 'b']);
      expect(list.find((t) => t.name === 'a')!.forgeMode).toBe('compose');
    });
  });

  describe('dispose', () => {
    it('should revoke all temp tools and stop cleanup', () => {
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'x' });
      tempReg.registerTemporary({ ...TOOL_BASE, name: 'y' });
      tempReg.dispose();
      expect(tempReg.list()).toHaveLength(0);
      expect(registry.unregister).toHaveBeenCalledWith('x');
      expect(registry.unregister).toHaveBeenCalledWith('y');
    });
  });
});
