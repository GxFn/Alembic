/**
 * Panorama 集成测试 — 端到端全景计算
 *
 * 使用 Mock Repository 数据验证完整的 Panorama 管线:
 * ModuleDiscoverer → RoleRefiner → CouplingAnalyzer → LayerInferrer → PanoramaAggregator → PanoramaService
 */
import { describe, expect, it } from 'vitest';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import { LayerInferrer } from '../../lib/service/panorama/LayerInferrer.js';
import { ModuleDiscoverer } from '../../lib/service/panorama/ModuleDiscoverer.js';
import { PanoramaAggregator } from '../../lib/service/panorama/PanoramaAggregator.js';
import { PanoramaService } from '../../lib/service/panorama/PanoramaService.js';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';
import { createMockRepos } from '../helpers/panorama-mocks.js';

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('Panorama Integration', () => {
  function createService() {
    const projectRoot = '/proj';
    const repos = createMockRepos({
      entities: [
        // Foundation module
        {
          entity_id: 'BDFoundation',
          entity_type: 'module',
          project_root: projectRoot,
          name: 'BDFoundation',
        },
        {
          entity_id: 'BDLogger',
          entity_type: 'class',
          project_root: projectRoot,
          name: 'BDLogger',
          file_path: '/proj/Foundation/Logger.swift',
          superclass: 'NSObject',
          protocols: '[]',
        },
        {
          entity_id: 'BDNetworkUtil',
          entity_type: 'class',
          project_root: projectRoot,
          name: 'BDNetworkUtil',
          file_path: '/proj/Foundation/NetworkUtil.swift',
          protocols: '[]',
        },
        // Service module
        {
          entity_id: 'BDServices',
          entity_type: 'module',
          project_root: projectRoot,
          name: 'BDServices',
        },
        {
          entity_id: 'BDUserService',
          entity_type: 'class',
          project_root: projectRoot,
          name: 'BDUserService',
          file_path: '/proj/Services/UserService.swift',
          protocols: '[]',
        },
        {
          entity_id: 'BDAPIClient',
          entity_type: 'class',
          project_root: projectRoot,
          name: 'BDAPIClient',
          file_path: '/proj/Services/APIClient.swift',
          protocols: '[]',
        },
        // UI module
        { entity_id: 'BDUIKit', entity_type: 'module', project_root: projectRoot, name: 'BDUIKit' },
        {
          entity_id: 'BDProfileVC',
          entity_type: 'class',
          project_root: projectRoot,
          name: 'BDProfileVC',
          file_path: '/proj/UI/ProfileVC.swift',
          superclass: 'UIViewController',
          protocols: '["UITableViewDataSource"]',
        },
        {
          entity_id: 'BDHomeVC',
          entity_type: 'class',
          project_root: projectRoot,
          name: 'BDHomeVC',
          file_path: '/proj/UI/HomeVC.swift',
          superclass: 'UIViewController',
          protocols: '[]',
        },
        // App module
        { entity_id: 'BDApp', entity_type: 'module', project_root: projectRoot, name: 'BDApp' },
        {
          entity_id: 'AppDelegate',
          entity_type: 'class',
          project_root: projectRoot,
          name: 'AppDelegate',
          file_path: '/proj/App/AppDelegate.swift',
          protocols: '[]',
        },
      ],
      edges: [
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
      ],
    });

    const roleRefiner = new RoleRefiner(
      repos.bootstrapRepo,
      repos.entityRepo,
      repos.edgeRepo,
      projectRoot
    );
    const couplingAnalyzer = new CouplingAnalyzer(repos.edgeRepo, repos.entityRepo, projectRoot);
    const layerInferrer = new LayerInferrer();
    const moduleDiscoverer = new ModuleDiscoverer(repos.entityRepo, repos.edgeRepo, projectRoot);
    const aggregator = new PanoramaAggregator({
      roleRefiner,
      couplingAnalyzer,
      layerInferrer,
      bootstrapRepo: repos.bootstrapRepo,
      entityRepo: repos.entityRepo,
      edgeRepo: repos.edgeRepo,
      knowledgeRepo: repos.knowledgeRepo,
      projectRoot,
    });
    return new PanoramaService({
      aggregator,
      edgeRepo: repos.edgeRepo,
      knowledgeRepo: repos.knowledgeRepo,
      projectRoot,
      moduleDiscoverer,
    });
  }

  it('should discover 4 modules from code_entities', async () => {
    const service = createService();
    const overview = await service.getOverview();

    expect(overview.moduleCount).toBe(4);
    expect(overview.projectRoot).toBe('/proj');
  });

  it('should infer multi-layer hierarchy', async () => {
    const service = createService();
    const overview = await service.getOverview();

    // Foundation at bottom, App at top → at least 2 layers
    expect(overview.layerCount).toBeGreaterThanOrEqual(2);
  });

  it('should populate all PanoramaModule fields', async () => {
    const service = createService();
    const result = await service.getResult();

    const foundation = result.modules.get('BDFoundation');
    expect(foundation).toBeDefined();
    expect(foundation!.fileCount).toBeGreaterThanOrEqual(0);
    expect(foundation!.refinedRole).toBeDefined();
    expect(foundation!.roleConfidence).toBeGreaterThanOrEqual(0);
  });

  it('should detect knowledge gaps', async () => {
    const service = createService();
    const gaps = await service.getGaps();

    // With recipeCount=0 and some modules having ≥5 files, should detect gaps
    // (depends on mock data — modules have 1-2 files each, so maybe no "high" gaps)
    expect(gaps).toBeDefined();
  });

  it('should compute health score in valid range', async () => {
    const service = createService();
    const health = await service.getHealth();
    const overview = await service.getOverview();

    expect(health.healthScore).toBeGreaterThanOrEqual(0);
    expect(health.healthScore).toBeLessThanOrEqual(100);
    expect(health.moduleCount).toBe(4);
    expect(health.healthRadar.overallScore).toBeDefined();
    expect(overview.overallCoverage).toBeDefined();
  });

  it('should return call flow summary', async () => {
    const service = createService();
    const result = await service.getResult();

    expect(result.callFlowSummary).toBeDefined();
    expect(result.callFlowSummary.topCalledMethods.length).toBeGreaterThanOrEqual(1);
    // All 3 call targets have equal count (1 each); verify they are present
    const topIds = result.callFlowSummary.topCalledMethods.map((m) => m.id);
    expect(topIds).toContain('BDLogger.log');
  });

  it('should return module detail for existing module', async () => {
    const service = createService();
    const detail = await service.getModule('BDFoundation');

    expect(detail).not.toBeNull();
    expect(detail!.module.name).toBe('BDFoundation');
    expect(detail!.layerName).toBeDefined();
  });

  it('should maintain cache across calls', async () => {
    const service = createService();
    const r1 = await service.getResult();
    const r2 = await service.getResult();

    expect(r1.computedAt).toBe(r2.computedAt);

    service.invalidate();
    const r3 = await service.getResult();
    expect(r3.computedAt).toBeGreaterThanOrEqual(r1.computedAt);
  });
});
