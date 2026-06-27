import type { AgentService } from '@alembic/agent/service';
import {
  applyPlanSelection,
  assertPlanSelectionStageRequirements,
  type PlanStageId,
} from '@alembic/core/plans';
import { resolveProjectScopeAnalysisContext } from '../project-scope/ProjectScopeAnalysis.js';
import { buildProjectContextWorkflowFacts } from '../workflows/project-context/ProjectContextWorkflowFacts.js';
import { getJobProcessEventRecorder } from './DaemonJobServices.js';
import { numberArg, recordJobProcessEvent } from './DaemonJobWorkflowHelpers.js';
import type { BootstrapPlanGateResult, RunDaemonJobOptions } from './DaemonJobWorkflowTypes.js';

export async function runBootstrapPlanGate(
  options: RunDaemonJobOptions
): Promise<BootstrapPlanGateResult> {
  return runPlanSelectionGate(options, {
    generationStage: 'coldStart',
    label: 'Bootstrap',
    source: 'alembic-main-bootstrap',
  });
}

export async function runPlanSelectionGate(
  options: RunDaemonJobOptions,
  gate: {
    generationStage: PlanStageId;
    label: string;
    source: 'alembic-main-bootstrap' | 'alembic-main-rescan';
  }
): Promise<BootstrapPlanGateResult> {
  const recorder = getJobProcessEventRecorder(options.container);
  const maxFiles = numberArg(options.args?.maxFiles, 500);
  const contentMaxLines = numberArg(options.args?.contentMaxLines, 120);
  const eventTitlePrefix = `${gate.label} plan gate`;

  try {
    const analysisScope = resolveProjectScopeAnalysisContext(options.container);
    const projectContextFacts = await buildProjectContextWorkflowFacts({
      analysisScope,
      contentMaxLines,
      ctx: { container: options.container, logger: options.logger },
      maxFiles,
      projectRoot: analysisScope.projectRoot,
      source: gate.source,
    });
    const { runPlanAgent } = await import('@alembic/agent/service');
    const selection = await runPlanAgent({
      agentService: options.container.get('agentService') as Pick<AgentService, 'run'>,
      generationStage: gate.generationStage,
      projectContextFacts,
    });

    // 主仓库执行边界复用 Core 阶段约束，避免 deepMining/moduleMining 空模块目标先报 gate 成功。
    assertPlanSelectionStageRequirements(selection, { expectedStage: gate.generationStage });

    const projection = applyPlanSelection(selection);

    if (projection.executionDimensions.length === 0) {
      throw new Error(`Plan agent returned no executable dimensions for ${gate.generationStage}.`);
    }

    options.logger.info(`${eventTitlePrefix} completed`, {
      budget: projection.budget,
      executionDimensions: projection.executionDimensions,
      jobId: options.jobId,
      moduleScope: projection.moduleScope,
      stage: `${gate.generationStage}-plan-gate`,
      unknownDimensionIds: projection.unknownDimensionIds ?? [],
    });
    recordJobProcessEvent(recorder, {
      jobId: options.jobId,
      kind: 'checkpoint',
      metadata: {
        budget: projection.budget,
        executionDimensions: projection.executionDimensions,
        generationStage: gate.generationStage,
        moduleScope: projection.moduleScope,
        source: options.source || 'system',
        unknownDimensionIds: projection.unknownDimensionIds ?? [],
      },
      phase: 'plan-gate',
      severity: 'success',
      summary: `Plan agent selected ${projection.executionDimensions.length} ${gate.generationStage} dimension(s).`,
      title: `${eventTitlePrefix} completed`,
    });

    return { projectContextFacts, projection, selection };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.error(`${eventTitlePrefix} failed; aborting ${gate.generationStage} job`, {
      error: message,
      generationStage: gate.generationStage,
      jobId: options.jobId,
      stage: `${gate.generationStage}-plan-gate`,
    });
    recordJobProcessEvent(recorder, {
      content: {
        mimeType: 'text/plain',
        role: 'assistant',
        text: `${eventTitlePrefix} failed before ${gate.generationStage}: ${message}`,
      },
      jobId: options.jobId,
      kind: 'error',
      metadata: {
        generationStage: gate.generationStage,
        source: options.source || 'system',
      },
      phase: 'plan-gate',
      severity: 'error',
      summary: `${eventTitlePrefix} failed before ${gate.generationStage}: ${message}`,
      title: `${eventTitlePrefix} failed`,
    });
    throw new Error(`${eventTitlePrefix} failed: ${message}`);
  }
}
