/**
 * RescanCoverageLedgerWriter — 增量重扫 coverage ledger 写入器
 *
 * 结构清洗 W3——自 sustain/KnowledgeRescanWorkflow 尾部（coverage ledger 写入段）
 * 纯移动拆出，零逻辑/日志改动；IncrementalRescanWorkflow 在每个维度完成回调中调用。
 * 跳过分支（无候选/仓库不可用/无 ProjectMap 模块/无 source refs）语义与日志文案保持原样。
 */

import {
  buildCoverageLedgerModuleAxisFromSummaries,
  type CoverageLedgerCandidate,
  type CoverageLedgerModuleAxis,
  type CoverageLedgerWriteResult,
  resolveModuleTier,
  resolvePerCellTargetDefault,
  writeCoverageLedgerForCompletion,
} from '@alembic/core/host-agent-workflows';
import type { CoverageLedgerRepository } from '@alembic/core/repositories';
import type { ProjectContextWorkflowFacts } from '../../../project-facts/ProjectContextWorkflowFacts.js';
import type { GenerateWorkflowMcpContext } from '../GenerateWorkflow.js';
import { getCoverageLedgerRepository, nonNegativeInteger } from './RescanMiningPlanArgs.js';

type RescanMcpContext = GenerateWorkflowMcpContext;

export interface KnowledgeRescanCoverageLedgerWriteInput {
  acceptedSourceRefs?: readonly string[];
  candidateCount: number;
  ctx: RescanMcpContext;
  dimensionId: string;
  projectContextFacts: Pick<ProjectContextWorkflowFacts, 'projectMapModules'>;
  projectRoot: string;
  referencedFiles: readonly string[];
  roundIndex?: number | null;
}

export interface KnowledgeRescanCoverageLedgerSkippedResult {
  reason: string;
  skipped: true;
}

export type KnowledgeRescanCoverageLedgerWriteResult =
  | (CoverageLedgerWriteResult & { skipped?: false })
  | KnowledgeRescanCoverageLedgerSkippedResult;

export function writeKnowledgeRescanCoverageLedgerForDimension(
  input: KnowledgeRescanCoverageLedgerWriteInput
): KnowledgeRescanCoverageLedgerWriteResult {
  if (input.candidateCount <= 0) {
    return { skipped: true, reason: 'no-accepted-candidates' };
  }

  const repository = getCoverageLedgerRepository(input.ctx.container);
  if (!repository) {
    input.ctx.logger.debug?.(
      '[KnowledgeRescanWorkflow] coverage ledger write skipped: repository unavailable'
    );
    return { skipped: true, reason: 'repository-unavailable' };
  }

  const modules = buildKnowledgeRescanCoverageLedgerModules(
    input.projectContextFacts,
    input.projectRoot
  );
  if (modules.length === 0) {
    input.ctx.logger.debug?.(
      '[KnowledgeRescanWorkflow] coverage ledger write skipped: no ProjectMap modules'
    );
    return { skipped: true, reason: 'no-project-map-modules' };
  }

  const sourceRefsForCoverage = input.acceptedSourceRefs ?? input.referencedFiles;
  const coveredPaths = uniqueStrings(
    sourceRefsForCoverage.map(stripSourceRefLineAnchor).filter((path) => path.length > 0)
  );
  if (coveredPaths.length === 0) {
    input.ctx.logger.debug?.(
      '[KnowledgeRescanWorkflow] coverage ledger write skipped: accepted candidates without source refs'
    );
    return { skipped: true, reason: 'no-source-refs' };
  }

  const candidates = buildKnowledgeRescanCoverageLedgerCandidates({
    coveredPaths,
    dimensionId: input.dimensionId,
    modules,
  });
  const tier = resolveModuleTier(modules.length);
  const perCellTarget = resolvePerCellTargetDefault(tier);
  const latestRound =
    input.roundIndex ?? latestCoverageLedgerRoundIndex(repository, input.projectRoot) ?? null;

  const result = writeCoverageLedgerForCompletion({
    repository,
    projectRoot: input.projectRoot,
    modules,
    dimensionIds: [input.dimensionId],
    candidates,
    coveredPaths,
    perCellTarget,
    lastRound: latestRound,
    logger: input.ctx.logger,
  });
  return { ...result, skipped: false };
}

function buildKnowledgeRescanCoverageLedgerModules(
  facts: Pick<ProjectContextWorkflowFacts, 'projectMapModules'>,
  projectRoot: string
): CoverageLedgerModuleAxis[] {
  return buildCoverageLedgerModuleAxisFromSummaries({
    modules: facts.projectMapModules
      .filter((module) => {
        const ownedFiles = uniqueStrings(module.ownedFiles ?? []);
        const hasModuleAxis =
          module.moduleId.trim().length > 0 ||
          (module.moduleName.trim().length > 0 && Boolean(module.modulePath?.trim()));
        return hasModuleAxis && (ownedFiles.length > 0 || Boolean(module.modulePath?.trim()));
      })
      .map((module) => ({
        moduleId: module.moduleId,
        moduleName: module.moduleName || module.moduleId,
        modulePath: module.modulePath,
        ownedFiles: module.ownedFiles,
        projectRoot,
      })),
  });
}

function buildKnowledgeRescanCoverageLedgerCandidates({
  coveredPaths,
  dimensionId,
  modules,
}: {
  coveredPaths: readonly string[];
  dimensionId: string;
  modules: readonly CoverageLedgerModuleAxis[];
}): CoverageLedgerCandidate[] {
  return [
    ...coveredPaths.map((path) => ({
      dimensionIds: [dimensionId],
      sourceRefPaths: [path],
      importance: 60,
    })),
    ...modules.map((module) => ({
      dimensionIds: [dimensionId],
      sourceRefPaths: [...module.ownedPaths],
      importance: 50,
    })),
  ];
}

function latestCoverageLedgerRoundIndex(
  repository: CoverageLedgerRepository,
  projectRoot: string
): number | null {
  return repository.listRoundsByProjectRoot(projectRoot).reduce<number | null>((latest, round) => {
    const roundIndex = nonNegativeInteger(round.roundIndex);
    if (roundIndex === null) {
      return latest;
    }
    return latest === null || roundIndex > latest ? roundIndex : latest;
  }, null);
}

function stripSourceRefLineAnchor(sourceRef: string): string {
  return sourceRef.trim().replace(/:\d+(?:-\d+)?$/, '');
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
