/**
 * CouplingAnalyzer 单元测试
 */
import { describe, expect, it } from 'vitest';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';

/* ═══ Mock DB ═════════════════════════════════════════════ */

function createMockDb(
  edges: Array<{
    from_id: string;
    from_type: string;
    to_id: string;
    to_type: string;
    relation: string;
  }> = [],
  entities: Array<{
    entity_id: string;
    file_path: string;
  }> = []
) {
  return {
    transaction: (fn: () => void) => fn,
    exec: () => {},
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (...params: unknown[]) => {
        if (sql.includes('file_path') && sql.includes('code_entities')) {
          const entityId = params[0] as string;
          const entity = entities.find((e) => e.entity_id === entityId);
          return entity ? { file_path: entity.file_path } : undefined;
        }
        return undefined;
      },
      all: (...params: unknown[]) => {
        if (sql.includes('knowledge_edges') && sql.includes('relation = ?')) {
          const relation = params[0] as string;
          return edges.filter((e) => e.relation === relation);
        }
        return [];
      },
    }),
  };
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('CouplingAnalyzer', () => {
  it('should return empty result for no modules', () => {
    const db = createMockDb();
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const result = analyzer.analyze(new Map());

    expect(result.cycles).toHaveLength(0);
    expect(result.metrics.size).toBe(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should detect module-to-module depends_on edges', () => {
    const db = createMockDb([
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModB',
        to_type: 'module',
        relation: 'depends_on',
      },
    ]);
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([
      ['ModA', ['/test/a.swift']],
      ['ModB', ['/test/b.swift']],
    ]);

    const result = analyzer.analyze(moduleFiles);

    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges.find((e) => e.from === 'ModA' && e.to === 'ModB');
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(0.5); // depends_on weight
  });

  it('should compute fanIn/fanOut correctly', () => {
    const db = createMockDb([
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModB',
        to_type: 'module',
        relation: 'depends_on',
      },
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModC',
        to_type: 'module',
        relation: 'depends_on',
      },
      {
        from_id: 'ModC',
        from_type: 'module',
        to_id: 'ModB',
        to_type: 'module',
        relation: 'depends_on',
      },
    ]);
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([
      ['ModA', ['/test/a.swift']],
      ['ModB', ['/test/b.swift']],
      ['ModC', ['/test/c.swift']],
    ]);

    const result = analyzer.analyze(moduleFiles);

    // ModB: fanIn=2 (from A and C), fanOut=0
    expect(result.metrics.get('ModB')!.fanIn).toBe(2);
    expect(result.metrics.get('ModB')!.fanOut).toBe(0);

    // ModA: fanIn=0, fanOut=2 (to B and C)
    expect(result.metrics.get('ModA')!.fanIn).toBe(0);
    expect(result.metrics.get('ModA')!.fanOut).toBe(2);
  });

  it('should detect cyclic dependencies via Tarjan SCC', () => {
    const db = createMockDb([
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModB',
        to_type: 'module',
        relation: 'depends_on',
      },
      {
        from_id: 'ModB',
        from_type: 'module',
        to_id: 'ModC',
        to_type: 'module',
        relation: 'depends_on',
      },
      {
        from_id: 'ModC',
        from_type: 'module',
        to_id: 'ModA',
        to_type: 'module',
        relation: 'depends_on',
      },
    ]);
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([
      ['ModA', []],
      ['ModB', []],
      ['ModC', []],
    ]);

    const result = analyzer.analyze(moduleFiles);

    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    const cycle = result.cycles[0];
    expect(cycle.cycle).toHaveLength(3);
    expect(cycle.severity).toBe('warning'); // 3 nodes = warning
  });

  it('should mark large cycles as error severity', () => {
    const db = createMockDb([
      { from_id: 'A', from_type: 'module', to_id: 'B', to_type: 'module', relation: 'depends_on' },
      { from_id: 'B', from_type: 'module', to_id: 'C', to_type: 'module', relation: 'depends_on' },
      { from_id: 'C', from_type: 'module', to_id: 'D', to_type: 'module', relation: 'depends_on' },
      { from_id: 'D', from_type: 'module', to_id: 'A', to_type: 'module', relation: 'depends_on' },
    ]);
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([
      ['A', []],
      ['B', []],
      ['C', []],
      ['D', []],
    ]);

    const result = analyzer.analyze(moduleFiles);

    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    expect(result.cycles[0].severity).toBe('error'); // >3 nodes
  });

  it('should resolve entity-to-entity edges to module edges', () => {
    const db = createMockDb(
      [
        {
          from_id: 'ClassA',
          from_type: 'method',
          to_id: 'ClassB',
          to_type: 'method',
          relation: 'calls',
        },
      ],
      [
        { entity_id: 'ClassA', file_path: '/test/modA/a.swift' },
        { entity_id: 'ClassB', file_path: '/test/modB/b.swift' },
      ]
    );
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([
      ['ModA', ['/test/modA/a.swift']],
      ['ModB', ['/test/modB/b.swift']],
    ]);

    const result = analyzer.analyze(moduleFiles);

    const edge = result.edges.find((e) => e.from === 'ModA' && e.to === 'ModB');
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(1.0); // calls weight
  });

  it('should skip self-edges', () => {
    const db = createMockDb([
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModA',
        to_type: 'module',
        relation: 'depends_on',
      },
    ]);
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([['ModA', []]]);

    const result = analyzer.analyze(moduleFiles);

    expect(result.edges).toHaveLength(0);
  });
});
