/**
 * PanoramaScanner 单元测试
 */
import { describe, expect, it, vi } from 'vitest';
import { PanoramaScanner } from '../../lib/service/panorama/PanoramaScanner.js';

/* ═══ Mock Container ══════════════════════════════════════ */

function createMockContainer(entityCount = 0) {
  const mockDb = {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes('COUNT(*)')) {
          return { cnt: entityCount };
        }
        return undefined;
      },
    }),
  };

  return {
    get(name: string) {
      if (name === 'database') {
        return { getDb: () => mockDb };
      }
      return undefined;
    },
  };
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('PanoramaScanner', () => {
  it('hasData returns false when no entities exist', () => {
    const scanner = new PanoramaScanner({
      projectRoot: '/test',
      container: createMockContainer(0),
    });

    expect(scanner.hasData()).toBe(false);
  });

  it('hasData returns true when entities exist', () => {
    const scanner = new PanoramaScanner({
      projectRoot: '/test',
      container: createMockContainer(42),
    });

    expect(scanner.hasData()).toBe(true);
  });

  it('ensureData returns null when data already exists', async () => {
    const scanner = new PanoramaScanner({
      projectRoot: '/test',
      container: createMockContainer(10),
    });

    const result = await scanner.ensureData();
    expect(result).toBeNull();
  });

  it('ensureData returns null on second call (already scanned)', async () => {
    const scanner = new PanoramaScanner({
      projectRoot: '/nonexistent-test-path',
      container: createMockContainer(0),
    });

    // First call — triggers scan (will fail gracefully due to nonexistent path)
    const result1 = await scanner.ensureData();
    expect(result1).not.toBeNull();

    // Second call — should skip (already scanned)
    const result2 = await scanner.ensureData();
    expect(result2).toBeNull();
  });

  it('reset allows re-scanning', async () => {
    const scanner = new PanoramaScanner({
      projectRoot: '/nonexistent-test-path',
      container: createMockContainer(0),
    });

    await scanner.ensureData();
    scanner.reset();

    // After reset, ensureData should attempt scan again
    const result = await scanner.ensureData();
    expect(result).not.toBeNull();
  });

  it('scan returns result with metrics', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const scanner = new PanoramaScanner({
      projectRoot: '/nonexistent-test-path',
      container: createMockContainer(0),
      logger,
    });

    const result = await scanner.scan();

    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('edges');
    expect(result).toHaveProperty('modules');
    expect(result).toHaveProperty('durationMs');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
