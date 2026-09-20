/** 知识演化装配：引用维护、生命周期、提案与生产入口；仓储由 Infra 提供。 */
import {
  ConsolidationAdvisor,
  ContentPatcher,
  DecayDetector,
  EnhancementSuggester,
  LifecycleStateMachine,
  ProposalExecutor,
  ProposalGateway,
  RedundancyAnalyzer,
  StagingManager,
} from '@alembic/core/evolution';
import { RecipeProductionGateway, SourceRefReconciler } from '@alembic/core/knowledge';
import { findSimilarRecipes } from '@alembic/core/service/candidate';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { resolveProjectScopeSourceIdentitiesFromContainer } from '../../project-scope/ProjectScopeAnalysis.js';
import { createMainDriftGitReader } from '../../recipe-pipeline/sustain/driftBaseline.js';
import { InProcessFileChangeHandler } from '../../recipe-pipeline/sustain/evolution/InProcessFileChangeHandler.js';
import { FileChangeDispatcher } from '../../service/FileChangeDispatcher.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function registerKnowledgeEvolution(c: ServiceContainer) {
  // ═══ Governance / Evolution ═══

  c.singleton('sourceRefReconciler', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    const sourceRefRepo = ct.get('recipeSourceRefRepository');
    const knowledgeRepo = ct.get('knowledgeRepository');
    // P-C:注入 gitReader,配合调用方传 baselineCommit 后 drifted 可细分
    // line-shift/content-change(与 Plugin KnowledgeModule 同款,parity)。
    return new SourceRefReconciler(projectRoot, sourceRefRepo, knowledgeRepo, {
      // RuntimeInitializer按每轮generate替换身份集合，singleton不能缓存构造时的空/旧scope。
      sourceIdentityProvider: () => resolveProjectScopeSourceIdentitiesFromContainer(ct),
      signalBus: ct.singletons.signalBus || undefined,
      gitReader: createMainDriftGitReader(projectRoot),
    } as ConstructorParameters<typeof SourceRefReconciler>[3]);
  });

  c.singleton('stagingManager', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new StagingManager(knowledgeRepo, {
      fileStore: ct.get('knowledgeFileWriter'),
      lifecycle: ct.services.lifecycleStateMachine ? ct.get('lifecycleStateMachine') : undefined,
      signalBus: ct.singletons.signalBus || undefined,
    } as ConstructorParameters<typeof StagingManager>[1]);
  });

  c.singleton('decayDetector', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new DecayDetector(knowledgeRepo, {
      signalBus: ct.singletons.signalBus || undefined,
      knowledgeEdgeRepo: ct.services.knowledgeEdgeRepository
        ? ct.get('knowledgeEdgeRepository')
        : undefined,
      sourceRefRepo: ct.services.recipeSourceRefRepository
        ? ct.get('recipeSourceRefRepository')
        : undefined,
      lifecycleStateMachine: ct.services.lifecycleStateMachine
        ? ct.get('lifecycleStateMachine')
        : undefined,
      drizzle: ct.get('database').getDrizzle(),
    } as ConstructorParameters<typeof DecayDetector>[1]);
  });

  c.singleton('redundancyAnalyzer', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new RedundancyAnalyzer(knowledgeRepo, {
      signalBus: ct.singletons.signalBus || undefined,
    } as ConstructorParameters<typeof RedundancyAnalyzer>[1]);
  });

  c.singleton('enhancementSuggester', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new EnhancementSuggester(knowledgeRepo, {
      signalBus: ct.singletons.signalBus || undefined,
    } as ConstructorParameters<typeof EnhancementSuggester>[1]);
  });

  c.singleton('contentPatcher', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    const sourceRefRepo = ct.get('recipeSourceRefRepository');
    // P-B:注入 projectRoot,update 提案执行后 refs 立即带 region 指纹落锚。
    return new ContentPatcher(knowledgeRepo, sourceRefRepo, {
      projectRoot: resolveProjectRoot(ct),
      fileStore: ct.get('knowledgeFileWriter'),
    });
  });

  c.singleton('lifecycleStateMachine', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    const lifecycleEventRepo = ct.get('lifecycleEventRepository');
    const signalBus = ct.get('signalBus');
    const proposalRepo = ct.get('proposalRepository');
    // 进化与人工知识写入共用 Markdown 真相源，后续 sync 不得回滚状态。
    return new LifecycleStateMachine(
      knowledgeRepo,
      lifecycleEventRepo,
      signalBus,
      proposalRepo,
      undefined,
      {
        fileStore: ct.get('knowledgeFileWriter'),
      }
    );
  });

  c.singleton('proposalExecutor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    const proposalRepo = ct.get('proposalRepository');
    const lifecycle = ct.get('lifecycleStateMachine');
    const contentPatcher = ct.get('contentPatcher');
    const edgeRepo = ct.get('knowledgeEdgeRepository');
    return new ProposalExecutor(knowledgeRepo, proposalRepo, lifecycle, contentPatcher, edgeRepo);
  });

  c.singleton('consolidationAdvisor', (ct: ServiceContainer) => {
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new ConsolidationAdvisor(knowledgeRepo);
  });

  c.singleton('proposalGateway', (ct: ServiceContainer) => {
    const proposalRepo = ct.get('proposalRepository');
    const lifecycle = ct.get('lifecycleStateMachine');
    const knowledgeRepo = ct.get('knowledgeRepository');
    return new ProposalGateway(proposalRepo, lifecycle, knowledgeRepo);
  });

  c.singleton('recipeProductionGateway', (ct: ServiceContainer) => {
    const knowledgeService = ct.get('knowledgeService');
    const dataRoot = resolveDataRoot(ct) as string;
    let consolidationAdvisor = null;
    let proposalRepository = null;
    let proposalGateway = null;
    try {
      consolidationAdvisor = ct.get('consolidationAdvisor');
    } catch {
      /* optional */
    }
    try {
      proposalRepository = ct.get('proposalRepository');
    } catch {
      /* optional */
    }
    try {
      proposalGateway = ct.get('proposalGateway');
    } catch {
      /* optional */
    }
    return new RecipeProductionGateway({
      knowledgeService,
      projectRoot: dataRoot,
      consolidationAdvisor: consolidationAdvisor as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['consolidationAdvisor'],
      proposalRepository: proposalRepository as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['proposalRepository'],
      proposalGateway: proposalGateway as unknown as ConstructorParameters<
        typeof RecipeProductionGateway
      >[0]['proposalGateway'],
      findSimilarRecipes,
    });
  });

  c.singleton('fileChangeHandler', (ct: ServiceContainer) => {
    const sourceRefRepo = ct.get('recipeSourceRefRepository');
    const knowledgeRepo = ct.get('knowledgeRepository');
    const contentPatcher = ct.get('contentPatcher');
    const gateway = ct.get('proposalGateway');
    const dataRoot = resolveDataRoot(ct) as string;
    const projectRoot = resolveProjectRoot(ct);
    return new InProcessFileChangeHandler(sourceRefRepo, knowledgeRepo, contentPatcher, {
      signalBus:
        (ct.singletons.signalBus as import('@alembic/core/events').SignalBus | undefined) ||
        undefined,
      proposalGateway: gateway,
      dataRoot,
      projectRoot,
    });
  });

  c.singleton('fileChangeDispatcher', (ct: ServiceContainer) => {
    const dispatcher = new FileChangeDispatcher();
    const handler = ct.get('fileChangeHandler');
    dispatcher.register(handler);
    return dispatcher;
  });
}
