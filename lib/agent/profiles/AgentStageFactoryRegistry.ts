import {
  buildBootstrapTerminalPolicyHints,
  getBootstrapStageTerminalTools,
  resolveBootstrapTerminalToolset,
} from '#workflows/bootstrap/config/BootstrapTerminalToolset.js';
import { PRESETS } from '../profiles/presets.js';
import {
  buildRelationsPipelineStages,
  buildScanPipelineStages,
  SCAN_TASK_CONFIGS,
} from '../prompts/scan-prompts.js';

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
      const terminalToolset = resolveBootstrapTerminalToolset({
        terminalTest: params.terminalTest ?? context?.terminalTest,
        terminalToolset: params.terminalToolset ?? context?.terminalToolset,
        allowedTerminalModes: params.allowedTerminalModes ?? context?.allowedTerminalModes,
      });
      const terminalPolicyHints = buildBootstrapTerminalPolicyHints(terminalToolset);
      const memoryCoordinator = context?.memoryCoordinator as
        | { allocateBudget?: (role: string) => void }
        | undefined;

      const withTerminalPromptContext = (ctx: Record<string, unknown>) => ({
        ...ctx,
        terminalTest: terminalToolset.terminalTest,
        terminalToolset: terminalToolset.terminalToolset,
        allowedTerminalModes: terminalToolset.allowedTerminalModes,
        toolPolicyHints: terminalPolicyHints,
      });

      const analyzeStage = {
        ...presetStages[0],
        additionalTools: getBootstrapStageTerminalTools('analyze', terminalToolset),
        promptBuilder: (ctx: Record<string, unknown>) =>
          presetStages[0].promptBuilder?.(withTerminalPromptContext(ctx)),
      };
      if (!needsCandidates) {
        return [analyzeStage] as Record<string, unknown>[];
      }

      const produceStage = {
        ...presetStages[2],
        promptBuilder: (ctx: Record<string, unknown>) => {
          memoryCoordinator?.allocateBudget?.('producer');
          return presetStages[2].promptBuilder?.(withTerminalPromptContext(ctx));
        },
      };

      if (hasExistingRecipes && !prescreenDone) {
        return [
          {
            ...evolutionPresetStages[0],
            additionalTools: getBootstrapStageTerminalTools(
              evolutionPresetStages[0].name || 'evolve',
              terminalToolset
            ),
            promptBuilder: (ctx: Record<string, unknown>) =>
              evolutionPresetStages[0].promptBuilder?.(withTerminalPromptContext(ctx)),
          },
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
