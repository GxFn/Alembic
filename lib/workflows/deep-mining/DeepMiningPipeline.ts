import { runScanAgentTask } from '#agent/runs/scan/ScanAgentRun.js';
import type { AgentService, SystemRunContextFactory } from '#agent/service/index.js';
import type { KnowledgeRetrievalPipeline } from '#workflows/scan/retrieval/KnowledgeRetrievalPipeline.js';
import type { DeepMiningRequest, DeepMiningResult } from '#workflows/scan/ScanTypes.js';

export interface DeepMiningWorkflowOptions {
  retrievalPipeline: KnowledgeRetrievalPipeline;
  agentService?: AgentService | null;
  systemRunContextFactory?: SystemRunContextFactory | null;
}

export class DeepMiningWorkflow {
  readonly #retrievalPipeline: KnowledgeRetrievalPipeline;
  readonly #agentService: AgentService | null;
  readonly #systemRunContextFactory: SystemRunContextFactory | null;

  constructor(options: DeepMiningWorkflowOptions) {
    this.#retrievalPipeline = options.retrievalPipeline;
    this.#agentService = options.agentService ?? null;
    this.#systemRunContextFactory = options.systemRunContextFactory ?? null;
  }

  async run(request: DeepMiningRequest): Promise<DeepMiningResult> {
    const baseline = request.baseline ?? projectRequestBaseline(request);
    const evidencePack = await this.#retrievalPipeline.retrieve({
      projectRoot: request.projectRoot,
      mode: 'deep-mining',
      intent: 'fill-coverage-gap',
      baseline,
      depth: request.depth ?? 'deep',
      primaryLang: request.primaryLang,
      files: request.files,
      scope: {
        dimensions: request.dimensions,
        modules: request.modules,
        query: request.query,
      },
      budget: {
        maxKnowledgeItems: request.maxNewCandidates,
      },
    });

    if (request.runAgent !== true) {
      return {
        mode: 'deep-mining',
        baseline,
        evidencePack,
        scanResult: null,
        skippedAgentReason: 'agent execution not requested',
      };
    }
    if (!this.#agentService || !this.#systemRunContextFactory) {
      return {
        mode: 'deep-mining',
        baseline,
        evidencePack,
        scanResult: null,
        skippedAgentReason: 'agent runtime unavailable',
      };
    }

    const scanResult = await runScanAgentTask({
      agentService: this.#agentService,
      systemRunContextFactory: this.#systemRunContextFactory,
      label:
        request.query ||
        request.dimensions?.join(', ') ||
        request.modules?.join(', ') ||
        'deep-mining',
      files: evidencePack.files.map((file) => ({
        name: file.relativePath,
        relativePath: file.relativePath,
        content: file.content ?? file.excerpt ?? '',
        language: file.language,
      })),
      task: 'deep-scan',
      lang: evidencePack.project.primaryLang,
      comprehensive: true,
      source: 'system-workflow',
    });

    return { mode: 'deep-mining', baseline, evidencePack, scanResult };
  }
}

export class DeepMiningPipeline extends DeepMiningWorkflow {}

function projectRequestBaseline(request: DeepMiningRequest): DeepMiningResult['baseline'] {
  if (!request.baselineRunId && !request.baselineSnapshotId) {
    return null;
  }
  return {
    runId: request.baselineRunId ?? null,
    snapshotId: request.baselineSnapshotId ?? null,
    source: 'request',
  };
}
