/**
 * PanoramaScanner 单元测试
 */
import { describe, expect, it, vi } from 'vitest';
import { PanoramaScanner } from '../../lib/service/panorama/PanoramaScanner.js';
import { createMockRepos } from '../helpers/panorama-mocks.js';

/* ═══ Mock Container ══════════════════════════════════════ */

function createMockContainer() {
  return {
    get(name: string) {
      if (name === 'database') {
        return { getDb: () => ({}) };
      }
      return undefined;
    },
  };
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('PanoramaScanner', () => {
  it('hasData returns false when no entities exist', async () => {
    const repos = createMockRepos({ entityCount: 0 });
    const scanner = new PanoramaScanner({
      projectRoot: '/test',
      container: createMockContainer(),
      entityRepo: repos.entityRepo,
      edgeRepo: repos.edgeRepo,
    });

    expect(await scanner.hasData()).toBe(false);
  });

  it('hasData returns true when entities exist', async () => {
    const repos = createMockRepos({ entityCount: 42 });
    const scanner = new PanoramaScanner({
      projectRoot: '/test',
      container: createMockContainer(),
      entityRepo: repos.entityRepo,
      edgeRepo: repos.edgeRepo,
    });

    expect(await scanner.hasData()).toBe(true);
  });

  it('ensureData returns null when data already exists', async () => {
    const repos = createMockRepos({ entityCount: 10 });
    const scanner = new PanoramaScanner({
      projectRoot: '/test',
      container: createMockContainer(),
      entityRepo: repos.entityRepo,
      edgeRepo: repos.edgeRepo,
    });

    const result = await scanner.ensureData();
    expect(result).toBeNull();
  });

  it('ensureData returns null on second call (already scanned)', async () => {
    const repos = createMockRepos({ entityCount: 0 });
    const scanner = new PanoramaScanner({
      projectRoot: '/nonexistent-test-path',
      container: createMockContainer(),
      entityRepo: repos.entityRepo,
      edgeRepo: repos.edgeRepo,
    });

    // First call — triggers scan (will fail gracefully due to nonexistent path)
    const result1 = await scanner.ensureData();
    expect(result1).not.toBeNull();

    // Second call — should skip (already scanned)
    const result2 = await scanner.ensureData();
    expect(result2).toBeNull();
  });

  it('reset allows re-scanning', async () => {
    const repos = createMockRepos({ entityCount: 0 });
    const scanner = new PanoramaScanner({
      projectRoot: '/nonexistent-test-path',
      container: createMockContainer(),
      entityRepo: repos.entityRepo,
      edgeRepo: repos.edgeRepo,
    });

    await scanner.ensureData();
    scanner.reset();

    // After reset, ensureData should attempt scan again
    const result = await scanner.ensureData();
    expect(result).not.toBeNull();
  });

  it('scan returns result with metrics', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const repos = createMockRepos({ entityCount: 0 });
    const scanner = new PanoramaScanner({
      projectRoot: '/nonexistent-test-path',
      container: createMockContainer(),
      entityRepo: repos.entityRepo,
      edgeRepo: repos.edgeRepo,
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
