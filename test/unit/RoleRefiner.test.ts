/**
 * RoleRefiner 单元测试
 */
import { describe, expect, it } from 'vitest';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';

/* ═══ Mock DB ═════════════════════════════════════════════ */

function createMockDb(
  opts: {
    entities?: Array<Record<string, unknown>>;
    imports?: Array<Record<string, unknown>>;
    callsOut?: number;
    callsIn?: number;
    dataFlowOut?: number;
    dataFlowIn?: number;
    patterns?: Array<Record<string, unknown>>;
    primaryLang?: string;
  } = {}
) {
  const lang = opts.primaryLang ?? 'swift';

  return {
    transaction: (fn: () => void) => fn,
    exec: () => {},
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (..._params: unknown[]) => {
        if (sql.includes('bootstrap_snapshots')) {
          return { primary_lang: lang };
        }
        if (sql.includes('COUNT(*)') && sql.includes('from_id = ce.entity_id')) {
          return { cnt: opts.callsOut ?? 0 };
        }
        if (sql.includes('COUNT(*)') && sql.includes('to_id = ce.entity_id')) {
          return { cnt: opts.callsIn ?? 0 };
        }
        if (
          sql.includes('COUNT(*)') &&
          sql.includes("relation = 'data_flow'") &&
          sql.includes('from_id = ce.entity_id')
        ) {
          return { cnt: opts.dataFlowOut ?? 0 };
        }
        if (
          sql.includes('COUNT(*)') &&
          sql.includes("relation = 'data_flow'") &&
          sql.includes('to_id = ce.entity_id')
        ) {
          return { cnt: opts.dataFlowIn ?? 0 };
        }
        return undefined;
      },
      all: (..._params: unknown[]) => {
        if (sql.includes("relation = 'uses_pattern'")) {
          return opts.patterns ?? [];
        }
        if (sql.includes('code_entities') && sql.includes('file_path IN')) {
          return opts.entities ?? [];
        }
        if (sql.includes("relation = 'depends_on'")) {
          return opts.imports ?? [];
        }
        // Call count queries
        if (sql.includes("relation = 'calls'") || sql.includes("relation = 'data_flow'")) {
          return [];
        }
        return [];
      },
    }),
  };
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('RoleRefiner', () => {
  it('should return fallback when no signals available', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'MyModule',
      inferredRole: 'feature',
      files: [],
    });

    expect(result.refinedRole).toBe('feature');
    // Only regex baseline signal → low score, no second candidate
    expect(['fallback', 'uncertain']).toContain(result.resolution);
  });

  it('should refine role based on AST superclass signals', () => {
    const db = createMockDb({
      entities: [
        {
          entity_id: 'MyVC',
          entity_type: 'class',
          superclass: 'UIViewController',
          protocols: '[]',
          file_path: '/test/a.swift',
        },
        {
          entity_id: 'MyView',
          entity_type: 'class',
          superclass: 'UIView',
          protocols: '[]',
          file_path: '/test/b.swift',
        },
      ],
    });
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'UIModule',
      inferredRole: 'ui',
      files: ['/test/a.swift', '/test/b.swift'],
    });

    expect(result.refinedRole).toBe('ui');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should refine role based on protocol conformance', () => {
    const db = createMockDb({
      entities: [
        {
          entity_id: 'MyModel',
          entity_type: 'class',
          superclass: null,
          protocols: '["Codable", "Decodable"]',
          file_path: '/test/model.swift',
        },
      ],
    });
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'DataModule',
      inferredRole: 'model',
      files: ['/test/model.swift'],
    });

    expect(result.refinedRole).toBe('model');
  });

  it('should refine role from call graph fan-in heavy → core', () => {
    const db = createMockDb({
      callsIn: 50,
      callsOut: 5,
    });
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'Foundation',
      inferredRole: 'core',
      files: ['/test/foundation.swift'],
    });

    // Should strongly favor core due to high fan-in
    expect(result.refinedRole).toBe('core');
  });

  it('should refine role from call graph fan-out heavy → ui', () => {
    const db = createMockDb({
      callsIn: 3,
      callsOut: 40,
    });
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'ScreenModule',
      inferredRole: 'ui',
      files: ['/test/screen.swift'],
    });

    expect(result.refinedRole).toBe('ui');
  });

  it('should detect singleton pattern → service', () => {
    const db = createMockDb({
      patterns: [{ pattern_name: 'singleton' }],
    });
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'ManagerModule',
      inferredRole: 'service',
      files: ['/test/manager.swift'],
    });

    expect(result.refinedRole).toBe('service');
  });

  it('should handle uncertain resolution when signals conflict', () => {
    // Provide conflicting signals: AST says UI, patterns say service
    const db = createMockDb({
      entities: [
        {
          entity_id: 'MyVC',
          entity_type: 'class',
          superclass: 'UIViewController',
          protocols: '[]',
          file_path: '/test/a.swift',
        },
      ],
      patterns: [{ pattern_name: 'singleton' }],
      callsIn: 20,
      callsOut: 20,
    });
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'HybridModule',
      inferredRole: 'feature',
      files: ['/test/a.swift'],
    });

    // Should have some result, possibly uncertain
    expect(result.refinedRole).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('should batch refine all modules', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const results = refiner.refineAll([
      { name: 'ModA', inferredRole: 'core', files: [] },
      { name: 'ModB', inferredRole: 'ui', files: [] },
    ]);

    expect(results.size).toBe(2);
    expect(results.has('ModA')).toBe(true);
    expect(results.has('ModB')).toBe(true);
  });

  it('should include regex baseline signal', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'TestModule',
      inferredRole: 'service',
      files: [],
    });

    const baselineSignal = result.signals.find((s) => s.source === 'regex-baseline');
    expect(baselineSignal).toBeDefined();
    expect(baselineSignal!.role).toBe('service');
    expect(baselineSignal!.weight).toBe(0.15);
  });

  it('should use language-specific maps — Java Activity → ui', () => {
    const db = createMockDb({
      primaryLang: 'java',
      entities: [
        {
          entity_id: 'MainActivity',
          entity_type: 'class',
          superclass: 'AppCompatActivity',
          protocols: '[]',
          file_path: '/test/Main.java',
        },
      ],
    });
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'AppModule',
      inferredRole: 'feature',
      files: ['/test/Main.java'],
    });

    expect(result.refinedRole).toBe('ui');
  });

  it('should NOT match cross-language superclass — Swift project ignores Activity', () => {
    const db = createMockDb({
      primaryLang: 'swift',
      entities: [
        // Hypothetical: AST parsed an entity named "Activity" in a Swift project
        {
          entity_id: 'Activity',
          entity_type: 'class',
          superclass: 'Activity',
          protocols: '[]',
          file_path: '/test/Act.swift',
        },
      ],
    });
    const refiner = new RoleRefiner(db as never, '/test');

    const result = refiner.refineRole({
      name: 'SomeModule',
      inferredRole: 'feature',
      files: ['/test/Act.swift'],
    });

    // "Activity" is not in the apple family map → no AST signal for it
    // Should fall back to regex baseline
    const astSignals = result.signals.filter((s) => s.source === 'ast-structure');
    expect(astSignals.length).toBe(0);
  });

  it('should fallback to all families when no bootstrap data', () => {
    const db = createMockDb({ primaryLang: '' });
    // Override get to return undefined for bootstrap query
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('bootstrap_snapshots')) {
        return { ...stmt, get: () => undefined };
      }
      return stmt;
    };

    const refiner = new RoleRefiner(db as never, '/test');
    const result = refiner.refineRole({
      name: 'GenericModule',
      inferredRole: 'feature',
      files: [],
    });

    // Should still work (using all families)
    expect(result.refinedRole).toBeDefined();
  });
});
