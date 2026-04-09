/**
 * PanoramaService 单元测试
 */
import { describe, expect, it } from 'vitest';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import { LayerInferrer } from '../../lib/service/panorama/LayerInferrer.js';
import { PanoramaAggregator } from '../../lib/service/panorama/PanoramaAggregator.js';
import { PanoramaService } from '../../lib/service/panorama/PanoramaService.js';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';

/* ═══ Mock DB ═════════════════════════════════════════════ */

function createMockDb(
  opts: {
    modules?: Array<Record<string, unknown>>;
    parts?: Array<Record<string, unknown>>;
    entityFiles?: Array<Record<string, unknown>>;
    allFiles?: Array<Record<string, unknown>>;
    recipeCount?: number;
  } = {}
) {
  return {
    transaction: (fn: () => void) => fn,
    exec: () => {},
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (...params: unknown[]) => {
        if (sql.includes('file_path') && sql.includes('code_entities') && sql.includes('LIMIT 1')) {
          const entityId = params[0] as string;
          const entity = (opts.entityFiles ?? []).find((e) => e.entity_id === entityId);
          return entity ? { file_path: entity.file_path } : undefined;
        }
        if (
          sql.includes('COUNT(*)') &&
          sql.includes('knowledge_entries') &&
          sql.includes('lifecycle')
        ) {
          return { cnt: opts.recipeCount ?? 0 };
        }
        if (sql.includes('COUNT(*)')) {
          return { cnt: 0 };
        }
        return undefined;
      },
      all: (..._params: unknown[]) => {
        if (sql.includes("entity_type = 'module'") && sql.includes('DISTINCT')) {
          return opts.modules ?? [];
        }
        if (sql.includes("relation = 'is_part_of'")) {
          return opts.parts ?? [];
        }
        if (sql.includes('DISTINCT file_path') && sql.includes('code_entities')) {
          return opts.allFiles ?? [];
        }
        if (sql.includes('knowledge_edges') && sql.includes('relation = ?')) {
          return [];
        }
        if (sql.includes('knowledge_edges') && sql.includes("relation = 'depends_on'")) {
          return [];
        }
        if (sql.includes('knowledge_entries') && sql.includes('lifecycle')) {
          return [];
        }
        if (sql.includes('GROUP BY')) {
          return [];
        }
        if (sql.includes('NOT IN')) {
          return [];
        }
        return [];
      },
    }),
  };
}

function makeService(db: ReturnType<typeof createMockDb>) {
  const projectRoot = '/test';
  const aggregator = new PanoramaAggregator({
    roleRefiner: new RoleRefiner(db as never, projectRoot),
    couplingAnalyzer: new CouplingAnalyzer(db as never, projectRoot),
    layerInferrer: new LayerInferrer(),
    db: db as never,
    projectRoot,
  });
  return new PanoramaService({
    aggregator,
    db: db as never,
    projectRoot,
  });
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('PanoramaService', () => {
  it('should return overview with modules from code_entities', () => {
    const db = createMockDb({
      modules: [
        { entity_id: 'BDFoundation', name: 'BDFoundation' },
        { entity_id: 'BDUIKit', name: 'BDUIKit' },
      ],
      parts: [],
    });
    const service = makeService(db);

    const overview = service.getOverview();

    expect(overview.moduleCount).toBe(2);
    expect(overview.projectRoot).toBe('/test');
    expect(overview.computedAt).toBeGreaterThan(0);
    expect(overview.stale).toBe(false);
  });

  it('should return empty panorama when no module entities (scanner responsibility)', () => {
    const db = createMockDb({
      modules: [],
      allFiles: [
        { file_path: '/test/Services/a.swift' },
        { file_path: '/test/Services/b.swift' },
        { file_path: '/test/UI/c.swift' },
      ],
    });
    const service = makeService(db);

    const overview = service.getOverview();

    expect(overview.moduleCount).toBe(0); // No module entities → empty (scanner handles fallback)
  });

  it('should return null for non-existent module', () => {
    const db = createMockDb({ modules: [] });
    const service = makeService(db);

    const detail = service.getModule('NonExistent');
    expect(detail).toBeNull();
  });

  it('should return gaps', () => {
    const db = createMockDb({
      modules: [{ entity_id: 'BigMod', name: 'BigMod' }],
      parts: [
        { from_id: 'ClassA' },
        { from_id: 'ClassB' },
        { from_id: 'ClassC' },
        { from_id: 'ClassD' },
        { from_id: 'ClassE' },
      ],
      entityFiles: [
        { entity_id: 'ClassA', file_path: '/test/a' },
        { entity_id: 'ClassB', file_path: '/test/b' },
        { entity_id: 'ClassC', file_path: '/test/c' },
        { entity_id: 'ClassD', file_path: '/test/d' },
        { entity_id: 'ClassE', file_path: '/test/e' },
      ],
      recipeCount: 0,
    });
    const service = makeService(db);

    const gaps = service.getGaps();

    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps[0].priority).toBe('high');
  });

  it('should compute health score', () => {
    const db = createMockDb({
      modules: [{ entity_id: 'Mod', name: 'Mod' }],
      parts: [],
      recipeCount: 0,
    });
    const service = makeService(db);

    const health = service.getHealth();

    expect(health.healthScore).toBeGreaterThanOrEqual(0);
    expect(health.healthScore).toBeLessThanOrEqual(100);
    expect(health.moduleCount).toBe(1);
  });

  it('should cache result and invalidate', () => {
    const db = createMockDb({ modules: [] });
    const service = makeService(db);

    const result1 = service.getResult();
    const result2 = service.getResult();
    expect(result1).toBe(result2); // same reference = cached

    service.invalidate();
    const result3 = service.getResult();
    expect(result3).not.toBe(result1); // different reference
  });

  it('should return getModule detail for existing module', () => {
    const db = createMockDb({
      modules: [{ entity_id: 'TestMod', name: 'TestMod' }],
      parts: [{ from_id: 'Entity1' }],
      entityFiles: [{ entity_id: 'Entity1', file_path: '/test/e1.swift' }],
      recipeCount: 1,
    });
    const service = makeService(db);

    const detail = service.getModule('TestMod');

    expect(detail).not.toBeNull();
    expect(detail!.module.name).toBe('TestMod');
    expect(detail!.layerName).toBeDefined();
    expect(Array.isArray(detail!.fileGroups)).toBe(true);
    expect(Array.isArray(detail!.recipes)).toBe(true);
    expect(typeof detail!.summary).toBe('string');
    expect(typeof detail!.uncoveredFileCount).toBe('number');
  });

  it('should enrich module files when modules exist but have no is_part_of edges', () => {
    const db = createMockDb({
      modules: [
        { entity_id: 'BDFoundation', name: 'BDFoundation' },
        { entity_id: 'BDUIKit', name: 'BDUIKit' },
      ],
      parts: [],
      allFiles: [
        { file_path: '/test/Sources/BDFoundation/a.swift' },
        { file_path: '/test/Sources/BDFoundation/b.swift' },
        { file_path: '/test/Sources/BDUIKit/c.swift' },
      ],
    });
    const service = makeService(db);

    const overview = service.getOverview();

    expect(overview.moduleCount).toBe(2);
    expect(overview.totalFiles).toBe(3);

    const foundationLayer = overview.layers
      .flatMap((l) => l.modules)
      .find((m) => m.name === 'BDFoundation');
    expect(foundationLayer?.fileCount).toBe(2);

    const uikitLayer = overview.layers.flatMap((l) => l.modules).find((m) => m.name === 'BDUIKit');
    expect(uikitLayer?.fileCount).toBe(1);
  });

  it('getModule should not hang when files have divergent paths (commonPathPrefix regression)', () => {
    const db = createMockDb({
      modules: [{ entity_id: 'TestMod', name: 'TestMod' }],
      parts: [{ from_id: 'fileA' }, { from_id: 'fileB' }, { from_id: 'fileC' }],
      entityFiles: [
        { entity_id: 'fileA', file_path: '/project/ModA/Sources/A.swift' },
        { entity_id: 'fileB', file_path: '/project/ModB/Sources/B.swift' },
        { entity_id: 'fileC', file_path: '/project/ModC/Sources/C.swift' },
      ],
    });
    const service = makeService(db);

    // Should complete without hanging (was an infinite loop before the fix)
    const detail = service.getModule('TestMod');
    expect(detail).not.toBeNull();
    expect(detail!.module.name).toBe('TestMod');
    expect(detail!.fileGroups.length).toBeGreaterThan(0);
  });

  it('getModule should handle files in completely different trees', () => {
    const db = createMockDb({
      modules: [{ entity_id: 'DivMod', name: 'DivMod' }],
      parts: [{ from_id: 'x1' }, { from_id: 'x2' }],
      entityFiles: [
        { entity_id: 'x1', file_path: '/alpha/src/a.ts' },
        { entity_id: 'x2', file_path: '/beta/src/b.ts' },
      ],
    });
    const service = makeService(db);

    const detail = service.getModule('DivMod');
    expect(detail).not.toBeNull();
    // With no common path, groups should be at root level
    expect(detail!.module.fileCount).toBe(2);
  });
});
