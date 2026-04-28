import {
  type EvolutionAuditRecipe,
  runEvolutionAudit,
} from '#agent/runs/evolution/EvolutionAgentRun.js';
import type { AgentService } from '#agent/service/index.js';
import type { FileChangeDispatcher } from '#service/FileChangeDispatcher.js';
import type {
  FileChangeEvent,
  FileChangeEventSource,
  ReactiveEvolutionReport,
} from '#types/reactive-evolution.js';
import {
  collectChangeSetFiles,
  eventsToChangeSet,
  eventsToSource,
} from '#workflows/scan/normalization/ScanChangeSetNormalizer.js';
import type { KnowledgeRetrievalPipeline } from '#workflows/scan/retrieval/KnowledgeRetrievalPipeline.js';
import type {
  EvidenceKnowledgeItem,
  IncrementalCorrectionResult,
  IncrementalCorrectionRunInput,
} from '#workflows/scan/ScanTypes.js';

export { collectChangeSetFiles, eventsToChangeSet, eventsToSource };

export interface IncrementalCorrectionWorkflowOptions {
  fileChangeDispatcher: FileChangeDispatcher;
  retrievalPipeline: KnowledgeRetrievalPipeline;
  agentService?: AgentService | null;
}

export class IncrementalCorrectionWorkflow {
  readonly #fileChangeDispatcher: FileChangeDispatcher;
  readonly #retrievalPipeline: KnowledgeRetrievalPipeline;
  readonly #agentService: AgentService | null;

  constructor(options: IncrementalCorrectionWorkflowOptions) {
    this.#fileChangeDispatcher = options.fileChangeDispatcher;
    this.#retrievalPipeline = options.retrievalPipeline;
    this.#agentService = options.agentService ?? null;
  }

  async run(input: IncrementalCorrectionRunInput): Promise<IncrementalCorrectionResult> {
    const reactiveReport = input.reactiveReport
      ? withEventSource(input.reactiveReport, input.events)
      : input.runDeterministic === false
        ? emptyReactiveReport(eventsToSource(input.events))
        : await this.#fileChangeDispatcher.dispatch(input.events);
    const changeSet = eventsToChangeSet(input.events);
    const evidencePack = await this.#retrievalPipeline.retrieve({
      projectRoot: input.projectRoot,
      mode: 'incremental-correction',
      intent: 'audit-impacted-recipes',
      depth: input.depth ?? 'standard',
      changeSet,
      budget: input.budget,
      primaryLang: input.primaryLang,
      reports: { reactive: reactiveReport },
      scope: {
        files: collectChangeSetFiles(changeSet),
      },
    });

    const shouldAudit =
      input.runAgent === true || (input.runAgent !== false && reactiveReport.suggestReview);
    const recipes = toEvolutionAuditRecipes(
      evidencePack.knowledge,
      evidencePack.changes?.impactedRecipeIds ?? []
    );
    if (!shouldAudit) {
      return {
        mode: 'incremental-correction',
        reactiveReport,
        evidencePack,
        auditResult: null,
        skippedAgentReason: 'reactive report did not request review',
      };
    }
    if (!this.#agentService) {
      return {
        mode: 'incremental-correction',
        reactiveReport,
        evidencePack,
        auditResult: null,
        skippedAgentReason: 'agent service unavailable',
      };
    }
    if (recipes.length === 0) {
      return {
        mode: 'incremental-correction',
        reactiveReport,
        evidencePack,
        auditResult: null,
        skippedAgentReason: 'no impacted recipes',
      };
    }

    const auditResult = await runEvolutionAudit({
      agentService: this.#agentService,
      recipes,
      projectOverview: evidencePack.project,
      dimensionId: 'incremental-correction',
      dimensionLabel: '增量修正扫描',
    });

    return { mode: 'incremental-correction', reactiveReport, evidencePack, auditResult };
  }
}

export class IncrementalCorrectionPipeline extends IncrementalCorrectionWorkflow {}

function emptyReactiveReport(
  eventSource: FileChangeEventSource | undefined
): ReactiveEvolutionReport {
  return {
    fixed: 0,
    deprecated: 0,
    skipped: 0,
    needsReview: 0,
    suggestReview: false,
    details: [],
    eventSource,
  };
}

function withEventSource(
  report: ReactiveEvolutionReport,
  events: FileChangeEvent[]
): ReactiveEvolutionReport {
  return {
    ...report,
    eventSource: report.eventSource ?? eventsToSource(events),
  };
}

function toEvolutionAuditRecipes(
  knowledge: EvidenceKnowledgeItem[],
  impactedRecipeIds: string[]
): EvolutionAuditRecipe[] {
  const impacted = new Set(impactedRecipeIds);
  return knowledge
    .filter((item) => impacted.size === 0 || impacted.has(item.id))
    .map((item) => ({
      id: item.id,
      title: item.title,
      trigger: item.trigger ?? '',
      content: item.content
        ? {
            markdown: item.content.markdown,
            rationale: item.content.rationale,
            coreCode: item.content.coreCode,
          }
        : undefined,
      sourceRefs: item.sourceRefs,
      auditHint: null,
    }));
}
