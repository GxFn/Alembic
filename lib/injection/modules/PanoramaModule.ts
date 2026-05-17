/**
 * PanoramaModule — DI 注册
 *
 * 注册全景服务到 ServiceContainer:
 *   - moduleDiscoverer
 *   - roleRefiner
 *   - couplingAnalyzer
 *   - layerInferrer
 *   - panoramaAggregator
 *   - panoramaScanner
 *   - panoramaService
 *
 * @module PanoramaModule
 */

import {
  CouplingAnalyzer,
  DimensionAnalyzer,
  LayerInferrer,
  ModuleDiscoverer,
  PanoramaAggregator,
  PanoramaScanner,
  PanoramaService,
  RoleRefiner,
} from '@alembic/core/project-intelligence';
import type {
  BootstrapRepository,
  CodeEntityRepository,
  KnowledgeEdgeRepository,
  KnowledgeRepository,
} from '@alembic/core/repositories';
import type { ServiceContainer } from '../ServiceContainer.js';

export const PanoramaModule = {
  register(container: ServiceContainer): void {
    const ct = container as unknown as {
      singleton(name: string, factory: (c: unknown) => unknown): void;
      singletons: Record<string, unknown>;
      config: { projectRoot?: string };
    };

    const getProjectRoot = () => ct.config?.projectRoot ?? process.cwd();

    const getBootstrapRepo = () =>
      container.get('bootstrapRepository') as unknown as BootstrapRepository;
    const getEntityRepo = () =>
      container.get('codeEntityRepository') as unknown as CodeEntityRepository;
    const getEdgeRepo = () =>
      container.get('knowledgeEdgeRepository') as unknown as KnowledgeEdgeRepository;
    const getKnowledgeRepo = () =>
      container.get('knowledgeRepository') as unknown as KnowledgeRepository;

    ct.singleton(
      'moduleDiscoverer',
      () => new ModuleDiscoverer(getEntityRepo(), getEdgeRepo(), getProjectRoot())
    );

    ct.singleton(
      'roleRefiner',
      () => new RoleRefiner(getBootstrapRepo(), getEntityRepo(), getEdgeRepo(), getProjectRoot())
    );

    ct.singleton(
      'couplingAnalyzer',
      () => new CouplingAnalyzer(getEdgeRepo(), getEntityRepo(), getProjectRoot())
    );

    ct.singleton('layerInferrer', () => new LayerInferrer());

    ct.singleton(
      'dimensionAnalyzer',
      () =>
        new DimensionAnalyzer(
          getBootstrapRepo(),
          getEntityRepo(),
          getKnowledgeRepo(),
          getProjectRoot()
        )
    );

    ct.singleton('panoramaAggregator', (c: unknown) => {
      const sc = c as ServiceContainer;
      const roleRefiner = sc.get('roleRefiner') as RoleRefiner;
      const couplingAnalyzer = sc.get('couplingAnalyzer') as CouplingAnalyzer;
      const layerInferrer = sc.get('layerInferrer') as LayerInferrer;
      const dimensionAnalyzer = sc.get('dimensionAnalyzer') as DimensionAnalyzer;

      return new PanoramaAggregator({
        roleRefiner,
        couplingAnalyzer,
        layerInferrer,
        bootstrapRepo: getBootstrapRepo(),
        entityRepo: getEntityRepo(),
        edgeRepo: getEdgeRepo(),
        knowledgeRepo: getKnowledgeRepo(),
        projectRoot: getProjectRoot(),
        dimensionAnalyzer,
      });
    });

    ct.singleton('panoramaScanner', () => {
      const logger = (ct.singletons.logger ?? {
        info() {},
        warn() {},
      }) as import('@alembic/core/project-intelligence').ScannerLogger;
      return new PanoramaScanner({
        projectRoot: getProjectRoot(),
        container: container,
        entityRepo: getEntityRepo(),
        edgeRepo: getEdgeRepo(),
        logger,
      });
    });

    ct.singleton('panoramaService', (c: unknown) => {
      const sc = c as ServiceContainer;
      const aggregator = sc.get('panoramaAggregator') as PanoramaAggregator;
      const scanner = sc.get('panoramaScanner') as PanoramaScanner;
      const moduleDiscoverer = sc.get('moduleDiscoverer') as ModuleDiscoverer;

      return new PanoramaService({
        aggregator,
        edgeRepo: getEdgeRepo(),
        knowledgeRepo: getKnowledgeRepo(),
        projectRoot: getProjectRoot(),
        scanner,
        moduleDiscoverer,
      });
    });
  },
};
