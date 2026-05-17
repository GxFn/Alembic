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
import type { ServiceContainer } from '../ServiceContainer.js';

export const PanoramaModule = {
  register(container: ServiceContainer): void {
    const ct = container as unknown as {
      singleton(name: string, factory: (c: unknown) => unknown): void;
      singletons: Record<string, unknown>;
      config: { projectRoot?: string };
    };

    const getProjectRoot = () => ct.config?.projectRoot ?? process.cwd();

    const getBootstrapRepo = (): unknown => container.get('bootstrapRepository');
    const getEntityRepo = (): unknown => container.get('codeEntityRepository');
    const getEdgeRepo = (): unknown => container.get('knowledgeEdgeRepository');
    const getKnowledgeRepo = (): unknown => container.get('knowledgeRepository');

    ct.singleton(
      'moduleDiscoverer',
      () =>
        new ModuleDiscoverer(
          getEntityRepo() as ConstructorParameters<typeof ModuleDiscoverer>[0],
          getEdgeRepo() as ConstructorParameters<typeof ModuleDiscoverer>[1],
          getProjectRoot()
        )
    );

    ct.singleton(
      'roleRefiner',
      () =>
        new RoleRefiner(
          getBootstrapRepo() as ConstructorParameters<typeof RoleRefiner>[0],
          getEntityRepo() as ConstructorParameters<typeof RoleRefiner>[1],
          getEdgeRepo() as ConstructorParameters<typeof RoleRefiner>[2],
          getProjectRoot()
        )
    );

    ct.singleton(
      'couplingAnalyzer',
      () =>
        new CouplingAnalyzer(
          getEdgeRepo() as ConstructorParameters<typeof CouplingAnalyzer>[0],
          getEntityRepo() as ConstructorParameters<typeof CouplingAnalyzer>[1],
          getProjectRoot()
        )
    );

    ct.singleton('layerInferrer', () => new LayerInferrer());

    ct.singleton(
      'dimensionAnalyzer',
      () =>
        new DimensionAnalyzer(
          getBootstrapRepo() as ConstructorParameters<typeof DimensionAnalyzer>[0],
          getEntityRepo() as ConstructorParameters<typeof DimensionAnalyzer>[1],
          getKnowledgeRepo() as ConstructorParameters<typeof DimensionAnalyzer>[2],
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
      } as unknown as ConstructorParameters<typeof PanoramaAggregator>[0]);
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
      } as unknown as ConstructorParameters<typeof PanoramaScanner>[0]);
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
      } as unknown as ConstructorParameters<typeof PanoramaService>[0]);
    });
  },
};
