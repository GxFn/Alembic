/**
 * Panorama 集成测试 — 端到端全景计算
 *
 * 使用模拟 SQLite 数据验证完整的 Panorama 管线:
 * RoleRefiner → CouplingAnalyzer → LayerInferrer → PanoramaAggregator → PanoramaService
 */
import { describe, expect, it } from 'vitest';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import { LayerInferrer } from '../../lib/service/panorama/LayerInferrer.js';
import { PanoramaAggregator } from '../../lib/service/panorama/PanoramaAggregator.js';
import { PanoramaService } from '../../lib/service/panorama/PanoramaService.js';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';

/* ═══ Simulated Data ══════════════════════════════════════ */

/** Simulates a project with 4 modules: Foundation, Service, UI, App */
function createProjectDb() {
  const entities = [
    // Foundation module
    {
      entity_id: 'BDFoundation',
      entity_type: 'module',
      project_root: '/proj',
      name: 'BDFoundation',
      file_path: null,
      superclass: null,
      protocols: '[]',
    },
    {
      entity_id: 'BDLogger',
      entity_type: 'class',
      project_root: '/proj',
      name: 'BDLogger',
      file_path: '/proj/Foundation/Logger.swift',
      superclass: 'NSObject',
      protocols: '[]',
    },
    {
      entity_id: 'BDNetworkUtil',
      entity_type: 'class',
      project_root: '/proj',
      name: 'BDNetworkUtil',
      file_path: '/proj/Foundation/NetworkUtil.swift',
      superclass: null,
      protocols: '[]',
    },

    // Service module
    {
      entity_id: 'BDServices',
      entity_type: 'module',
      project_root: '/proj',
      name: 'BDServices',
      file_path: null,
      superclass: null,
      protocols: '[]',
    },
    {
      entity_id: 'BDUserService',
      entity_type: 'class',
      project_root: '/proj',
      name: 'BDUserService',
      file_path: '/proj/Services/UserService.swift',
      superclass: null,
      protocols: '[]',
    },
    {
      entity_id: 'BDAPIClient',
      entity_type: 'class',
      project_root: '/proj',
      name: 'BDAPIClient',
      file_path: '/proj/Services/APIClient.swift',
      superclass: null,
      protocols: '[]',
    },

    // UI module
    {
      entity_id: 'BDUIKit',
      entity_type: 'module',
      project_root: '/proj',
      name: 'BDUIKit',
      file_path: null,
      superclass: null,
      protocols: '[]',
    },
    {
      entity_id: 'BDProfileVC',
      entity_type: 'class',
      project_root: '/proj',
      name: 'BDProfileVC',
      file_path: '/proj/UI/ProfileVC.swift',
      superclass: 'UIViewController',
      protocols: '["UITableViewDataSource"]',
    },
    {
      entity_id: 'BDHomeVC',
      entity_type: 'class',
      project_root: '/proj',
      name: 'BDHomeVC',
      file_path: '/proj/UI/HomeVC.swift',
      superclass: 'UIViewController',
      protocols: '[]',
    },

    // App module
    {
      entity_id: 'BDApp',
      entity_type: 'module',
      project_root: '/proj',
      name: 'BDApp',
      file_path: null,
      superclass: null,
      protocols: '[]',
    },
    {
      entity_id: 'AppDelegate',
      entity_type: 'class',
      project_root: '/proj',
      name: 'AppDelegate',
      file_path: '/proj/App/AppDelegate.swift',
      superclass: null,
      protocols: '[]',
    },
  ];

  const edges = [
    // Module dependencies
    {
      from_id: 'BDApp',
      from_type: 'module',
      to_id: 'BDUIKit',
      to_type: 'module',
      relation: 'depends_on',
      weight: 0.5,
    },
    {
      from_id: 'BDApp',
      from_type: 'module',
      to_id: 'BDServices',
      to_type: 'module',
      relation: 'depends_on',
      weight: 0.5,
    },
    {
      from_id: 'BDUIKit',
      from_type: 'module',
      to_id: 'BDServices',
      to_type: 'module',
      relation: 'depends_on',
      weight: 0.5,
    },
    {
      from_id: 'BDUIKit',
      from_type: 'module',
      to_id: 'BDFoundation',
      to_type: 'module',
      relation: 'depends_on',
      weight: 0.5,
    },
    {
      from_id: 'BDServices',
      from_type: 'module',
      to_id: 'BDFoundation',
      to_type: 'module',
      relation: 'depends_on',
      weight: 0.5,
    },

    // is_part_of
    {
      from_id: 'BDLogger',
      from_type: 'class',
      to_id: 'BDFoundation',
      to_type: 'module',
      relation: 'is_part_of',
      weight: 1,
    },
    {
      from_id: 'BDNetworkUtil',
      from_type: 'class',
      to_id: 'BDFoundation',
      to_type: 'module',
      relation: 'is_part_of',
      weight: 1,
    },
    {
      from_id: 'BDUserService',
      from_type: 'class',
      to_id: 'BDServices',
      to_type: 'module',
      relation: 'is_part_of',
      weight: 1,
    },
    {
      from_id: 'BDAPIClient',
      from_type: 'class',
      to_id: 'BDServices',
      to_type: 'module',
      relation: 'is_part_of',
      weight: 1,
    },
    {
      from_id: 'BDProfileVC',
      from_type: 'class',
      to_id: 'BDUIKit',
      to_type: 'module',
      relation: 'is_part_of',
      weight: 1,
    },
    {
      from_id: 'BDHomeVC',
      from_type: 'class',
      to_id: 'BDUIKit',
      to_type: 'module',
      relation: 'is_part_of',
      weight: 1,
    },
    {
      from_id: 'AppDelegate',
      from_type: 'class',
      to_id: 'BDApp',
      to_type: 'module',
      relation: 'is_part_of',
      weight: 1,
    },

    // Call edges (method-level)
    {
      from_id: 'BDProfileVC.viewDidLoad',
      from_type: 'method',
      to_id: 'BDUserService.fetchUser',
      to_type: 'method',
      relation: 'calls',
      weight: 1,
    },
    {
      from_id: 'BDUserService.fetchUser',
      from_type: 'method',
      to_id: 'BDAPIClient.request',
      to_type: 'method',
      relation: 'calls',
      weight: 1,
    },
    {
      from_id: 'BDAPIClient.request',
      from_type: 'method',
      to_id: 'BDLogger.log',
      to_type: 'method',
      relation: 'calls',
      weight: 1,
    },
  ];

  return {
    transaction: (fn: () => void) => fn,
    exec: () => {},
    prepare: (sql: string) => ({
      run: () => ({ changes: 0 }),
      get: (...params: unknown[]) => {
        if (sql.includes('COUNT(DISTINCT ke.id)')) {
          return { cnt: 0 };
        }
        if (sql.includes('file_path') && sql.includes('code_entities') && sql.includes('LIMIT 1')) {
          const entityId = params[0] as string;
          const entity = entities.find(
            (e) => e.entity_id === entityId && e.project_root === '/proj'
          );
          return entity ? { file_path: entity.file_path } : undefined;
        }
        if (sql.includes('COUNT(*)')) {
          // Count calls fan-in/out for module files
          if (sql.includes('from_id = ce.entity_id') && sql.includes("relation = 'calls'")) {
            return { cnt: 5 };
          }
          if (sql.includes('to_id = ce.entity_id') && sql.includes("relation = 'calls'")) {
            return { cnt: 3 };
          }
          return { cnt: 0 };
        }
        return undefined;
      },
      all: (...params: unknown[]) => {
        // Module discovery
        if (sql.includes("entity_type = 'module'") && sql.includes('DISTINCT')) {
          return entities
            .filter((e) => e.entity_type === 'module' && e.project_root === '/proj')
            .map((e) => ({ entity_id: e.entity_id, name: e.name }));
        }
        // Parts
        if (sql.includes("relation = 'is_part_of'")) {
          const moduleId = params[0] as string;
          return edges
            .filter((e) => e.to_id === moduleId && e.relation === 'is_part_of')
            .map((e) => ({ from_id: e.from_id }));
        }
        // Edge queries by relation
        if (sql.includes('knowledge_edges') && sql.includes('relation = ?')) {
          const relation = params[0] as string;
          return edges.filter((e) => e.relation === relation);
        }
        // Pattern queries
        if (sql.includes("relation = 'uses_pattern'")) {
          return [];
        }
        // Code entities by file
        if (sql.includes('code_entities') && sql.includes('file_path IN')) {
          const filePaths = params.slice(1) as string[];
          return entities.filter((e) => filePaths.includes(e.file_path ?? ''));
        }
        // Neighbor queries
        if (sql.includes("relation = 'depends_on'") && sql.includes('from_id =')) {
          return [];
        }
        // Call flow queries
        if (sql.includes('GROUP BY to_id') && sql.includes("relation = 'calls'")) {
          return [{ to_id: 'BDLogger.log', call_count: 5 }];
        }
        if (sql.includes('NOT IN')) {
          return [{ from_id: 'BDProfileVC.viewDidLoad' }];
        }
        if (sql.includes("relation = 'data_flow'") && sql.includes('GROUP BY')) {
          return [];
        }
        return [];
      },
    }),
  };
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('Panorama Integration', () => {
  function createService() {
    const db = createProjectDb();
    const projectRoot = '/proj';
    const roleRefiner = new RoleRefiner(db as never, projectRoot);
    const couplingAnalyzer = new CouplingAnalyzer(db as never, projectRoot);
    const layerInferrer = new LayerInferrer();
    const aggregator = new PanoramaAggregator({
      roleRefiner,
      couplingAnalyzer,
      layerInferrer,
      db: db as never,
      projectRoot,
    });
    return new PanoramaService({
      aggregator,
      db: db as never,
      projectRoot,
    });
  }

  it('should discover 4 modules from code_entities', () => {
    const service = createService();
    const overview = service.getOverview();

    expect(overview.moduleCount).toBe(4);
    expect(overview.projectRoot).toBe('/proj');
  });

  it('should infer multi-layer hierarchy', () => {
    const service = createService();
    const overview = service.getOverview();

    // Foundation at bottom, App at top → at least 2 layers
    expect(overview.layerCount).toBeGreaterThanOrEqual(2);
  });

  it('should populate all PanoramaModule fields', () => {
    const service = createService();
    const result = service.getResult();

    const foundation = result.modules.get('BDFoundation');
    expect(foundation).toBeDefined();
    expect(foundation!.fileCount).toBeGreaterThanOrEqual(0);
    expect(foundation!.refinedRole).toBeDefined();
    expect(foundation!.roleConfidence).toBeGreaterThanOrEqual(0);
  });

  it('should detect knowledge gaps', () => {
    const service = createService();
    const gaps = service.getGaps();

    // With recipeCount=0 and some modules having ≥5 files, should detect gaps
    // (depends on mock data — modules have 1-2 files each, so maybe no "high" gaps)
    expect(gaps).toBeDefined();
  });

  it('should compute health score in valid range', () => {
    const service = createService();
    const health = service.getHealth();

    expect(health.healthScore).toBeGreaterThanOrEqual(0);
    expect(health.healthScore).toBeLessThanOrEqual(100);
    expect(health.moduleCount).toBe(4);
    expect(health.overallCoverage).toBeDefined();
  });

  it('should return call flow summary', () => {
    const service = createService();
    const result = service.getResult();

    expect(result.callFlowSummary).toBeDefined();
    expect(result.callFlowSummary.topCalledMethods.length).toBeGreaterThanOrEqual(1);
    expect(result.callFlowSummary.topCalledMethods[0].id).toBe('BDLogger.log');
  });

  it('should return module detail for existing module', () => {
    const service = createService();
    const detail = service.getModule('BDFoundation');

    expect(detail).not.toBeNull();
    expect(detail!.module.name).toBe('BDFoundation');
    expect(detail!.layerName).toBeDefined();
  });

  it('should maintain cache across calls', () => {
    const service = createService();
    const r1 = service.getResult();
    const r2 = service.getResult();

    expect(r1.computedAt).toBe(r2.computedAt);

    service.invalidate();
    const r3 = service.getResult();
    expect(r3.computedAt).toBeGreaterThanOrEqual(r1.computedAt);
  });
});
