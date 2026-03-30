/**
 * ReverseGuard 单元测试
 */
import { describe, expect, it, vi } from 'vitest';
import { ReverseGuard } from '../../lib/service/guard/ReverseGuard.js';

function createMockDb(
  options: {
    recipes?: {
      id: string;
      title: string;
      core_code: string | null;
      guard_pattern: string | null;
      stats: string | null;
    }[];
    codeEntities?: string[];
    guardHits?: Record<string, number>;
    staleSourceRefs?: Record<string, string[]>;
  } = {}
) {
  const { recipes = [], codeEntities = [], guardHits = {}, staleSourceRefs = {} } = options;
  const entitySet = new Set(codeEntities);

  return {
    prepare(sql: string) {
      return {
        all(...params: unknown[]) {
          if (sql.includes('knowledge_entries') && sql.includes('lifecycle')) {
            return recipes;
          }
          if (sql.includes('recipe_source_refs') && sql.includes('stale')) {
            const recipeId = params[0] as string;
            const paths = staleSourceRefs[recipeId] ?? [];
            return paths.map((p) => ({ source_path: p }));
          }
          return [];
        },
        get(...params: unknown[]) {
          if (sql.includes('code_entities') && sql.includes('name = ?')) {
            const name = params[0] as string;
            if (entitySet.has(name)) {
              return { name };
            }
            return undefined;
          }
          if (sql.includes('json_extract(stats')) {
            const id = params[0] as string;
            return { hits: guardHits[id] ?? 0 };
          }
          return undefined;
        },
      };
    },
  };
}

describe('ReverseGuard', () => {
  it('should return healthy for recipe with no drift', () => {
    const db = createMockDb({
      codeEntities: ['BDNetworkManager', 'URLSession'],
    });
    const guard = new ReverseGuard(db);

    const result = guard.checkRecipe(
      {
        id: 'r1',
        title: 'Network Rule',
        core_code: 'BDNetworkManager.shared().request()',
        guard_pattern: null,
        stats: null,
      },
      []
    );

    expect(result.recommendation).toBe('healthy');
    expect(result.signals).toHaveLength(0);
  });

  it('should detect symbol_missing when coreCode references removed symbols', () => {
    const db = createMockDb({
      codeEntities: [], // nothing in codebase
    });
    const guard = new ReverseGuard(db);

    const result = guard.checkRecipe(
      {
        id: 'r1',
        title: 'Deprecated API Rule',
        core_code: 'BDOldManager.doSomething()',
        guard_pattern: null,
        stats: null,
      },
      []
    );

    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals[0].type).toBe('symbol_missing');
    expect(result.signals[0].severity).toBe('high');
    expect(result.recommendation).not.toBe('healthy');
  });

  it('should detect zero_match when guard pattern matches nothing', () => {
    const db = createMockDb({});
    const guard = new ReverseGuard(db);

    const result = guard.checkRecipe(
      {
        id: 'r1',
        title: 'Pattern Rule',
        core_code: null,
        guard_pattern: 'dispatch_sync\\s*\\([^)]*main',
        stats: null,
      },
      [
        { path: 'file1.m', content: 'void doSomething() { return; }' },
        { path: 'file2.m', content: 'int main() { return 0; }' },
      ]
    );

    expect(result.signals.some((s) => s.type === 'zero_match')).toBe(true);
  });

  it('should detect match_rate_drop when historical hits are much higher', () => {
    const db = createMockDb({
      guardHits: { r1: 100 },
    });
    const guard = new ReverseGuard(db);

    const result = guard.checkRecipe(
      {
        id: 'r1',
        title: 'Drop Rule',
        core_code: null,
        guard_pattern: 'TODO',
        stats: null,
      },
      [{ path: 'a.m', content: '// TODO: fix this\n// TODO: refactor' }]
    );

    // 2 matches vs 100 historical → 2% → match_rate_drop
    expect(result.signals.some((s) => s.type === 'match_rate_drop')).toBe(true);
  });

  it('should return healthy when pattern matches and no historical drop', () => {
    const db = createMockDb({ guardHits: {} });
    const guard = new ReverseGuard(db);

    const result = guard.checkRecipe(
      {
        id: 'r1',
        title: 'Active Rule',
        core_code: null,
        guard_pattern: 'dispatch_async',
        stats: null,
      },
      [{ path: 'a.m', content: 'dispatch_async(dispatch_get_main_queue(), ^{ });' }]
    );

    expect(result.recommendation).toBe('healthy');
  });

  it('should recommend decay when multiple high-severity signals', () => {
    const db = createMockDb({
      codeEntities: [], // nothing found
    });
    const guard = new ReverseGuard(db);

    const result = guard.checkRecipe(
      {
        id: 'r1',
        title: 'Multi Drift',
        core_code: 'BDOldClass.method()\nBDRemovedHelper.run()',
        guard_pattern: 'NEVER_MATCH_THIS_UNIQUE_STRING_12345',
        stats: null,
      },
      [{ path: 'a.swift', content: 'let x = 1' }]
    );

    // 2+ symbol_missing (high) + zero_match (high) → decay
    expect(result.recommendation).toBe('decay');
  });

  it('should emit signal to SignalBus on drift', () => {
    const signalBus = { send: vi.fn() };
    const db = createMockDb({ codeEntities: [] });
    const guard = new ReverseGuard(db, { signalBus: signalBus as never });

    guard.checkRecipe(
      {
        id: 'r1',
        title: 'Signal Test',
        core_code: 'BDMissing.doIt()',
        guard_pattern: null,
        stats: null,
      },
      []
    );

    expect(signalBus.send).toHaveBeenCalledWith(
      'quality',
      'ReverseGuard',
      expect.any(Number),
      expect.objectContaining({ target: 'r1' })
    );
  });

  it('should batch audit all active rule recipes', () => {
    const db = createMockDb({
      recipes: [
        { id: 'r1', title: 'Rule 1', core_code: null, guard_pattern: 'TODO', stats: null },
        { id: 'r2', title: 'Rule 2', core_code: null, guard_pattern: 'FIXME', stats: null },
      ],
    });
    const guard = new ReverseGuard(db);

    const results = guard.auditAllRules([
      { path: 'a.m', content: '// TODO: fix\n// FIXME: broken' },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.recommendation === 'healthy')).toBe(true);
  });

  it('should detect source_ref_stale when sourceRefs are stale', () => {
    const db = createMockDb({
      codeEntities: ['BDNetworkManager'],
      staleSourceRefs: {
        r1: ['Sources/Old/Removed.swift', 'Sources/Old/Gone.swift', 'Sources/Old/Missing.swift'],
      },
    });
    const guard = new ReverseGuard(db);

    const result = guard.checkRecipe(
      {
        id: 'r1',
        title: 'Stale Refs Rule',
        core_code: 'BDNetworkManager.shared()',
        guard_pattern: null,
        stats: null,
      },
      []
    );

    expect(result.signals.some((s) => s.type === 'source_ref_stale')).toBe(true);
    const staleSignal = result.signals.find((s) => s.type === 'source_ref_stale');
    expect(staleSignal?.severity).toBe('high'); // ≥3 stale refs
    expect(staleSignal?.detail).toContain('3 source file(s)');
  });

  it('should not detect source_ref_stale when no stale refs', () => {
    const db = createMockDb({
      staleSourceRefs: {}, // empty — no stale refs
    });
    const guard = new ReverseGuard(db);

    const result = guard.checkRecipe(
      {
        id: 'r1',
        title: 'Clean Rule',
        core_code: null,
        guard_pattern: null,
        stats: null,
      },
      []
    );

    expect(result.signals.some((s) => s.type === 'source_ref_stale')).toBe(false);
    expect(result.recommendation).toBe('healthy');
  });

  it('should filter drift results', () => {
    const db = createMockDb({ codeEntities: [] });
    const guard = new ReverseGuard(db);

    const results = [
      guard.checkRecipe(
        { id: 'r1', title: 'Healthy', core_code: null, guard_pattern: null, stats: null },
        []
      ),
      guard.checkRecipe(
        {
          id: 'r2',
          title: 'Drifting',
          core_code: 'BDGone.call()',
          guard_pattern: null,
          stats: null,
        },
        []
      ),
    ];

    const drift = guard.getDriftResults(results);
    expect(drift.length).toBeGreaterThanOrEqual(1);
    expect(drift.every((r) => r.recommendation !== 'healthy')).toBe(true);
  });
});
