import {
  buildRelationsPipelineStages,
  buildScanPipelineStages,
  SCAN_TASK_CONFIGS,
} from '../domain/scan-prompts.js';
import { PRESETS } from '../presets.js';

export type AgentStageFactoryInput = {
  params: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type AgentStageFactory = (input: AgentStageFactoryInput) => Record<string, unknown>[];

export class AgentStageFactoryRegistry {
  #factories = new Map<string, AgentStageFactory>();

  constructor() {
    this.registerDefaults();
  }

  register(name: string, factory: AgentStageFactory) {
    if (!name) {
      throw new Error('Agent stage factory name is required');
    }
    this.#factories.set(name, factory);
    return this;
  }

  resolve(name: string) {
    const factory = this.#factories.get(name);
    if (!factory) {
      throw new Error(`Unknown agent stage factory: "${name}"`);
    }
    return factory;
  }

  build(name: string, input: AgentStageFactoryInput) {
    return this.resolve(name)(input);
  }

  list() {
    return [...this.#factories.keys()];
  }

  private registerDefaults() {
    this.register('scanPipeline', ({ params }) => {
      const task = params.task === 'summarize' ? 'summarize' : 'extract';
      const taskConfig = SCAN_TASK_CONFIGS[task];
      const files = Array.isArray(params.files)
        ? (params.files as Array<{ name?: string; relativePath?: string; content?: string }>)
        : undefined;
      return buildScanPipelineStages({
        task,
        producePrompt: taskConfig.producePrompt,
        analyzeCaps: ['code_analysis'],
        produceCaps: ['scan_production'],
        files,
        analyzeMaxIter: task === 'summarize' ? 12 : 24,
      }) as Record<string, unknown>[];
    });

    this.register('relationsPipeline', () => buildRelationsPipelineStages());
    this.register('bootstrapDimensionPipeline', ({ params, context }) => {
      const presetStages = PRESETS.insight.strategy.stages;
      const evolutionPresetStages = PRESETS.evolution.strategy.stages;
      const needsCandidates = params.needsCandidates !== false;
      const hasExistingRecipes = params.hasExistingRecipes === true;
      const prescreenDone = params.prescreenDone === true;
      const memoryCoordinator = context?.memoryCoordinator as
        | { allocateBudget?: (role: string) => void }
        | undefined;

      const analyzeStage = { ...presetStages[0] };
      if (!needsCandidates) {
        return [analyzeStage] as Record<string, unknown>[];
      }

      const produceStage = {
        ...presetStages[2],
        promptBuilder: (ctx: Record<string, unknown>) => {
          memoryCoordinator?.allocateBudget?.('producer');
          return presetStages[2].promptBuilder?.(ctx);
        },
      };

      if (hasExistingRecipes && !prescreenDone) {
        return [
          evolutionPresetStages[0],
          evolutionPresetStages[1],
          analyzeStage,
          presetStages[1],
          produceStage,
          presetStages[3],
        ] as Record<string, unknown>[];
      }

      return [analyzeStage, presetStages[1], produceStage, presetStages[3]] as Record<
        string,
        unknown
      >[];
    });
  }
}

export default AgentStageFactoryRegistry;
