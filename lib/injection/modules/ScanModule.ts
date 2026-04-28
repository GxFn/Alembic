import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { ColdStartWorkflow } from '#workflows/cold-start/dimension-execution/ColdStartWorkflow.js';
import { DeepMiningWorkflow } from '#workflows/deep-mining/DeepMiningPipeline.js';
import { IncrementalBootstrap } from '#workflows/deprecated-cold-start/incremental/IncrementalBootstrap.js';
import { IncrementalCorrectionWorkflow } from '#workflows/incremental-correction/IncrementalCorrectionPipeline.js';
import { MaintenanceWorkflow } from '#workflows/maintenance/MaintenancePipeline.js';
import { ColdStartBaselinePipeline } from '#workflows/scan/lifecycle/ColdStartBaselinePipeline.js';
import { ScanLifecycleRunner } from '#workflows/scan/lifecycle/ScanLifecycleRunner.js';
import { EvidenceBudgeter } from '#workflows/scan/retrieval/EvidenceBudgeter.js';
import { KnowledgeRetrievalPipeline } from '#workflows/scan/retrieval/KnowledgeRetrievalPipeline.js';
import { ScanJobQueue } from '#workflows/scan/ScanJobQueue.js';
import { ScanOrchestrator } from '#workflows/scan/ScanOrchestrator.js';
import { ScanPlanService } from '#workflows/scan/ScanPlanService.js';
import { ScanEvidencePackRepository } from '../../repository/scan/ScanEvidencePackRepository.js';
import { ScanRecommendationRepository } from '../../repository/scan/ScanRecommendationRepository.js';
import { ScanRunRepository } from '../../repository/scan/ScanRunRepository.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function register(container: ServiceContainer): void {
  container.singleton('evidenceBudgeter', () => new EvidenceBudgeter());
  container.singleton('scanJobQueue', () => new ScanJobQueue());

  container.singleton('scanRunRepository', (currentContainer: ServiceContainer) => {
    const db = currentContainer.get('database') as unknown as { getDrizzle(): unknown };
    return new ScanRunRepository(
      db.getDrizzle() as ConstructorParameters<typeof ScanRunRepository>[0]
    );
  });

  container.singleton('scanEvidencePackRepository', (currentContainer: ServiceContainer) => {
    const db = currentContainer.get('database') as unknown as { getDrizzle(): unknown };
    return new ScanEvidencePackRepository(
      db.getDrizzle() as ConstructorParameters<typeof ScanEvidencePackRepository>[0]
    );
  });

  container.singleton('scanRecommendationRepository', (currentContainer: ServiceContainer) => {
    const db = currentContainer.get('database') as unknown as { getDrizzle(): unknown };
    return new ScanRecommendationRepository(
      db.getDrizzle() as ConstructorParameters<typeof ScanRecommendationRepository>[0]
    );
  });

  container.singleton('scanLifecycleRunner', (currentContainer: ServiceContainer) =>
    ScanLifecycleRunner.fromContainer(currentContainer, currentContainer.logger)
  );

  container.singleton('scanPlanService', (currentContainer: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(currentContainer);
    return new ScanPlanService({
      incrementalPlanner: new IncrementalBootstrap(currentContainer.get('database'), projectRoot, {
        logger: currentContainer.logger,
      }),
    });
  });

  container.singleton(
    'knowledgeRetrievalPipeline',
    (currentContainer: ServiceContainer) =>
      new KnowledgeRetrievalPipeline({
        projectRoot: resolveProjectRoot(currentContainer),
        knowledgeRepository: currentContainer.get('knowledgeRepository'),
        sourceRefRepository: currentContainer.get('recipeSourceRefRepository'),
        searchEngine: currentContainer.get('searchEngine'),
        knowledgeGraphService: currentContainer.get('knowledgeGraphService'),
        codeEntityGraph: currentContainer.get('codeEntityGraph'),
        budgeter: currentContainer.get('evidenceBudgeter'),
      })
  );

  container.singleton('coldStartWorkflow', () => new ColdStartWorkflow());

  container.singleton(
    'coldStartBaselinePipeline',
    (currentContainer: ServiceContainer) =>
      new ColdStartBaselinePipeline(currentContainer.get('coldStartWorkflow'))
  );

  container.singleton(
    'deepMiningWorkflow',
    (currentContainer: ServiceContainer) =>
      new DeepMiningWorkflow({
        retrievalPipeline: currentContainer.get('knowledgeRetrievalPipeline'),
        agentService: currentContainer.get('agentService'),
        systemRunContextFactory: currentContainer.get('systemRunContextFactory'),
      })
  );

  container.singleton(
    'incrementalCorrectionWorkflow',
    (currentContainer: ServiceContainer) =>
      new IncrementalCorrectionWorkflow({
        fileChangeDispatcher: currentContainer.get('fileChangeDispatcher'),
        retrievalPipeline: currentContainer.get('knowledgeRetrievalPipeline'),
        agentService: currentContainer.get('agentService'),
      })
  );

  container.singleton(
    'maintenanceWorkflow',
    (currentContainer: ServiceContainer) =>
      new MaintenanceWorkflow({
        sourceRefReconciler: currentContainer.get('sourceRefReconciler'),
        proposalExecutor: currentContainer.get('proposalExecutor'),
        searchEngine: currentContainer.get('searchEngine'),
        decayDetector: currentContainer.get('decayDetector'),
        enhancementSuggester: currentContainer.get('enhancementSuggester'),
        redundancyAnalyzer: currentContainer.get('redundancyAnalyzer'),
      })
  );

  container.singleton(
    'scanOrchestrator',
    (currentContainer: ServiceContainer) =>
      new ScanOrchestrator({
        scanPlanService: currentContainer.get('scanPlanService'),
        coldStartWorkflow: currentContainer.get('coldStartWorkflow'),
        deepMiningWorkflow: currentContainer.get('deepMiningWorkflow'),
        incrementalCorrectionWorkflow: currentContainer.get('incrementalCorrectionWorkflow'),
        maintenanceWorkflow: currentContainer.get('maintenanceWorkflow'),
      })
  );
}
