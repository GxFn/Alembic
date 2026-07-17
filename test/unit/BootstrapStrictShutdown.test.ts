import { describe, expect, it, vi } from 'vitest';
import AppRuntime from '../../lib/Bootstrap.js';

describe('AppRuntime strict shutdown', () => {
  it('attempts close but rejects a busy nonterminal checkpoint', async () => {
    const close = vi.fn();
    const pragma = vi.fn(() => [{ busy: 1, log: 4, checkpointed: 3 }]);
    const runtime = new AppRuntime();
    runtime.components.db = {
      close,
      getDb: () => ({ pragma }),
    } as unknown as NonNullable<typeof runtime.components.db>;

    await expect(runtime.shutdown({ failClosedCheckpoint: true })).rejects.toThrow(
      'STRICT_QUIESCE_CHECKPOINT_FAILED'
    );
    expect(pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps ordinary shutdown checkpoint best-effort compatible', async () => {
    const close = vi.fn();
    const runtime = new AppRuntime();
    runtime.components.db = {
      close,
      getDb: () => ({
        pragma: vi.fn(() => {
          throw new Error('checkpoint unavailable');
        }),
      }),
    } as unknown as NonNullable<typeof runtime.components.db>;

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
