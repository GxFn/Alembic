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

import { CouplingAnalyzer } from '../../service/panorama/CouplingAnalyzer.js';
import { DimensionAnalyzer } from '../../service/panorama/DimensionAnalyzer.js';
import { LayerInferrer } from '../../service/panorama/LayerInferrer.js';
import { ModuleDiscoverer } from '../../service/panorama/ModuleDiscoverer.js';
import { PanoramaAggregator } from '../../service/panorama/PanoramaAggregator.js';
import { PanoramaScanner } from '../../service/panorama/PanoramaScanner.js';
import { PanoramaService } from '../../service/panorama/PanoramaService.js';
import { RoleRefiner } from '../../service/panorama/RoleRefiner.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export const PanoramaModule = {
  register(container: ServiceContainer): void {
    const ct = container as unknown as {
      singleton(name: string, factory: (c: unknown) => unknown): void;
      singletons: Record<string, unknown>;
      config: { projectRoot?: string };
    };

    const getDb = () => {
      const db = ct.singletons.database as { getDb?: () => unknown } | undefined;
      return (
        db?.getDb ? db.getDb() : db
      ) as import('../../service/panorama/PanoramaTypes.js').CeDbLike;
    };

    const getProjectRoot = () => ct.config?.projectRoot ?? process.cwd();

    ct.singleton('moduleDiscoverer', () => new ModuleDiscoverer(getDb(), getProjectRoot()));

    ct.singleton('roleRefiner', () => new RoleRefiner(getDb(), getProjectRoot()));

    ct.singleton('couplingAnalyzer', () => new CouplingAnalyzer(getDb(), getProjectRoot()));

    ct.singleton('layerInferrer', () => new LayerInferrer());

    ct.singleton('dimensionAnalyzer', () => new DimensionAnalyzer(getDb(), getProjectRoot()));

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
        db: getDb(),
        projectRoot: getProjectRoot(),
        dimensionAnalyzer,
      });
    });

    ct.singleton('panoramaScanner', () => {
      const logger = (ct.singletons.logger ?? {
        info() {},
        warn() {},
      }) as import('../../service/panorama/PanoramaScanner.js').ScannerLogger;
      return new PanoramaScanner({
        projectRoot: getProjectRoot(),
        container: container,
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
        db: getDb(),
        projectRoot: getProjectRoot(),
        scanner,
        moduleDiscoverer,
      });
    });
  },
};
