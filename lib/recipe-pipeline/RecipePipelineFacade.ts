/**
 * RecipePipelineFacade —— daemon 调 Recipe pipeline 的唯一入口(W5-B4,O-3)。
 *
 * 此前 DaemonJobRunner 直 import 三执行器(planGate/deepMining/moduleMining)+
 * 两处动态 import GenerateWorkflow,daemon 深度耦合 pipeline 内部布局;本 facade
 * 把 job kind/generationStage → 执行器的分派收拢为一个入口(原 executeApiAiWorkflow
 * 本体整体迁入,行为字节不变),daemon 只知本文件。
 * 助手函数(unwrapEnvelope/generationStageArg 等)仍住 daemon(它们同时服务
 * daemon 其余路径,recipe-pipeline→daemon 是 layer-contract 既有方向)。
 */
import {
  asRecord,
  buildDaemonRescanWorkflowArgs,
  generationStageArg,
  stringArrayArg,
  unwrapEnvelope,
} from '../daemon/DaemonJobWorkflowHelpers.js';
import type { RunDaemonJobOptions } from '../daemon/DaemonJobWorkflowTypes.js';
import { runDeepMiningRounds } from './generate/DeepMiningRoundGate.js';
import { runModuleMiningWorkflow } from './generate/ModuleMiningWorkflow.js';
import { runGeneratePlanGate } from './plan/PlanSelectionGate.js';

/**
 * kind==='bootstrap' → planGate+GenerateWorkflow(mode:'full');
 * generationStage 分派 deepMining/moduleMining;默认 → incremental 重扫。
 */
export async function executeRecipePipelineJob(options: RunDaemonJobOptions): Promise<unknown> {
  if (options.kind === 'bootstrap') {
    const planGate = await runGeneratePlanGate(options);
    const { runGenerateWorkflow } = await import('./generate/GenerateWorkflow.js');
    const raw = await runGenerateWorkflow(
      { container: options.container, logger: options.logger },
      {
        maxFiles: planGate.projection.budget.maxFiles,
        skipGuard: Boolean(options.args?.skipGuard || false),
        contentMaxLines: planGate.projection.budget.contentMaxLines,
        dimensions: stringArrayArg(options.args?.dimensions),
        loadSkills: true,
        planSelectionProjection: planGate.projection,
        projectContextFacts: planGate.projectContextFacts,
      },
      { mode: 'full' }
    );
    const result = unwrapEnvelope(raw);
    return { ...asRecord(result), asyncFill: true };
  }

  const generationStage = generationStageArg(options.args?.generationStage);
  if (generationStage === 'deepMining') {
    return runDeepMiningRounds(options);
  }
  if (generationStage === 'moduleMining') {
    return runModuleMiningWorkflow(options);
  }

  const { runGenerateWorkflow } = await import('./generate/GenerateWorkflow.js');
  const raw = await runGenerateWorkflow(
    { container: options.container, logger: options.logger },
    buildDaemonRescanWorkflowArgs({ args: options.args, source: options.source }),
    { mode: 'incremental' }
  );
  const result = unwrapEnvelope(raw);
  return { ...asRecord(result), asyncFill: true };
}
