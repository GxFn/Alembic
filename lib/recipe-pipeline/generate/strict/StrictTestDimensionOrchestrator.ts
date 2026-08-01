import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CompiledColdStartPlanV2 } from '@alembic/core/plans';
import {
  assertStrictTestPrivateTerminalReceiptV1,
  createStrictTestAuditReportV1,
  createStrictTestAutomaticSelectionReceiptV1,
  createStrictTestDimensionExecutionProjectionV1,
  createStrictTestPreflightPreviewV1,
  createStrictTestPrivateCompletionReceiptV1,
  createStrictTestPrivateFailureReceiptV1,
  type FinalCoverageBindingReceiptV1,
  type ServingSnapshotManifestV1,
  type StrictTestAuditReportV1,
  type StrictTestAutomaticSelectionReceiptV1,
  type StrictTestDimensionExecutionProjectionV1,
  type StrictTestFailureStageV1,
  type StrictTestPreflightBindingsV1,
  type StrictTestPreflightPreviewV1,
  type StrictTestPreflightReceiptV1,
  type StrictTestPrivateTerminalReceiptV1,
  validateStrictTestPreflightV1,
} from '@alembic/core/production';
import { type CanonicalSha256, hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type {
  StrictTestPreflightRequestV1,
  StrictTestRunRequestV1,
} from './StrictTestRequestContracts.js';

const CHECKPOINT_FILE = 'strict-test-dimension.checkpoint.json';
const NONMUTATION_VIOLATION_FILE = 'strict-test-nonmutation-violation.json';

export interface StrictTestPreparedPreflightV1 {
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly currentBindings: StrictTestPreflightBindingsV1;
  readonly privateEvidenceRefs: readonly string[];
  readonly executionContext?: unknown;
}

export interface StrictTestPrivateExecutionResultV1 {
  readonly finalCoverageBinding: FinalCoverageBindingReceiptV1;
  readonly servingSnapshotManifest: ServingSnapshotManifestV1;
  readonly privateG4ReceiptHash: CanonicalSha256;
  readonly privateServingValidationHash: CanonicalSha256;
  readonly privateEvidenceRefs: readonly string[];
}

export interface StrictTestDimensionOrchestratorDependencies {
  clock(): string;
  execute(input: {
    readonly runRoot: string;
    readonly compiledPlan: CompiledColdStartPlanV2;
    readonly currentBindings: StrictTestPreflightBindingsV1;
    readonly preflight: StrictTestPreflightReceiptV1;
    readonly automaticSelection: StrictTestAutomaticSelectionReceiptV1;
    readonly projection: StrictTestDimensionExecutionProjectionV1;
    readonly executionContext?: unknown;
    readonly reportStage: (stage: StrictTestFailureStageV1) => void;
  }): Promise<StrictTestPrivateExecutionResultV1>;
  findRunRoot(runId: string): Promise<string>;
  observeNonMutation(): Promise<{
    readonly productionStateHash: CanonicalSha256;
    readonly publicRouteStateHash: CanonicalSha256;
  }>;
  preparePreflight(input: StrictTestPreflightRequestV1): Promise<StrictTestPreparedPreflightV1>;
  revalidate(checkpoint: StrictTestDimensionCheckpointV1): Promise<StrictTestPreflightBindingsV1>;
  resolveRunRoot(demandKey: string, runId: string): string;
  verifyCompletedRun(checkpoint: StrictTestDimensionCheckpointV1): Promise<void>;
  verificationCommands: readonly string[];
}

export interface StrictTestDimensionCheckpointV1 {
  readonly schemaVersion: 1;
  readonly profile: 'strict-test-dimension';
  readonly demandKey: string;
  readonly runId: string;
  readonly projectRoot: string;
  readonly runRoot: string;
  readonly phase:
    | 'AUTOMATIC_SELECTION_READY'
    | 'SELECTION_AUTO_SELECTED'
    | 'PRIVATE_WORKSPACE_READY'
    | 'STRICT_TEST_COMPLETED_PRIVATE'
    | 'STRICT_TEST_FAILED';
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly currentBindings: StrictTestPreflightBindingsV1;
  readonly preflight: StrictTestPreflightReceiptV1;
  readonly preview: StrictTestPreflightPreviewV1;
  readonly automaticSelection: StrictTestAutomaticSelectionReceiptV1 | null;
  readonly projection: StrictTestDimensionExecutionProjectionV1 | null;
  readonly terminal: StrictTestPrivateTerminalReceiptV1 | null;
  readonly report: StrictTestAuditReportV1 | null;
  readonly privateEvidenceRefs: readonly string[];
  readonly executionContextHash: CanonicalSha256 | null;
  readonly executionContext?: unknown;
}

/**
 * Main strict-test 的唯一状态机。所有公开读取都重新打开 durable checkpoint；这个类不把
 * Promise、Dashboard 状态或模型回复当作 terminal authority。
 */
export class StrictTestDimensionOrchestrator {
  private readonly activeStarts = new Map<
    string,
    {
      readonly authorityKey: CanonicalSha256;
      readonly promise: Promise<StrictTestDimensionCheckpointV1>;
    }
  >();

  constructor(private readonly dependencies: StrictTestDimensionOrchestratorDependencies) {}

  async preflight(input: StrictTestPreflightRequestV1) {
    const runRoot = this.dependencies.resolveRunRoot(input.demandKey, input.runId);
    const existing = await readOptionalCheckpoint(runRoot);
    if (existing) {
      assertRequestIdentity(existing, input);
      return { preflight: existing.preflight, preview: existing.preview };
    }
    const prepared = await this.dependencies.preparePreflight(input);
    const preflight = validateStrictTestPreflightV1(
      prepared.compiledPlan,
      prepared.currentBindings
    );
    const preview = createStrictTestPreflightPreviewV1(preflight);
    const checkpoint: StrictTestDimensionCheckpointV1 = {
      schemaVersion: 1,
      profile: 'strict-test-dimension',
      demandKey: input.demandKey,
      runId: input.runId,
      projectRoot: input.projectRoot,
      runRoot,
      phase: 'AUTOMATIC_SELECTION_READY',
      compiledPlan: prepared.compiledPlan,
      currentBindings: prepared.currentBindings,
      preflight,
      preview,
      automaticSelection: null,
      projection: null,
      terminal: null,
      report: null,
      privateEvidenceRefs: [...prepared.privateEvidenceRefs],
      executionContextHash:
        prepared.executionContext === undefined
          ? null
          : hashCanonicalJson(prepared.executionContext),
      ...(prepared.executionContext !== undefined
        ? { executionContext: prepared.executionContext }
        : {}),
    };
    await writeCheckpoint(checkpoint);
    return { preflight, preview };
  }

  async start(input: StrictTestRunRequestV1): Promise<StrictTestDimensionCheckpointV1> {
    const authorityKey = hashCanonicalJson(input);
    const active = this.activeStarts.get(input.runId);
    if (active) {
      if (active.authorityKey !== authorityKey) {
        throw new Error('STRICT_TEST_START_CONCURRENT_AUTHORITY_MISMATCH');
      }
      return active.promise;
    }
    const promise = this.startOnce(input).finally(() => {
      if (this.activeStarts.get(input.runId)?.promise === promise) {
        this.activeStarts.delete(input.runId);
      }
    });
    this.activeStarts.set(input.runId, { authorityKey, promise });
    return promise;
  }

  private async startOnce(input: StrictTestRunRequestV1): Promise<StrictTestDimensionCheckpointV1> {
    const runRoot = await this.dependencies.findRunRoot(input.runId);
    let checkpoint = await readRequiredCheckpoint(runRoot);
    if (
      checkpoint.demandKey !== input.demandKey ||
      checkpoint.runId !== input.runId ||
      checkpoint.preflight.preflightHash !== input.preflightHash
    ) {
      throw new Error('STRICT_TEST_START_AUTHORITY_MISMATCH');
    }
    if (checkpoint.terminal) {
      return checkpoint;
    }

    let failedStage: StrictTestFailureStageV1 = 'AUTOMATIC_SELECTION_READY';
    try {
      const currentBindings = await this.dependencies.revalidate(checkpoint);
      const automaticSelection =
        checkpoint.automaticSelection ??
        createStrictTestAutomaticSelectionReceiptV1({
          preflight: checkpoint.preflight,
          currentBindings,
          selectedAt: this.dependencies.clock(),
        });
      failedStage = 'SELECTION_AUTO_SELECTED';
      if (!checkpoint.automaticSelection) {
        checkpoint = {
          ...checkpoint,
          phase: 'SELECTION_AUTO_SELECTED',
          currentBindings,
          automaticSelection,
        };
        await writeCheckpoint(checkpoint);
      }
      const projection =
        checkpoint.projection ??
        createStrictTestDimensionExecutionProjectionV1({
          preflight: checkpoint.preflight,
          automaticSelection,
          currentBindings,
          projectedAt: this.dependencies.clock(),
        });
      failedStage = 'PRIVATE_WORKSPACE_READY';
      if (!checkpoint.projection) {
        checkpoint = {
          ...checkpoint,
          phase: 'PRIVATE_WORKSPACE_READY',
          currentBindings,
          automaticSelection,
          projection,
          ...(checkpoint.executionContext !== undefined
            ? { executionContext: checkpoint.executionContext }
            : {}),
        };
        await writeCheckpoint(checkpoint);
      }
      const executed = await this.dependencies.execute({
        runRoot,
        compiledPlan: checkpoint.compiledPlan,
        currentBindings,
        preflight: checkpoint.preflight,
        automaticSelection,
        projection,
        reportStage: (stage) => {
          failedStage = stage;
        },
        ...(checkpoint.executionContext !== undefined
          ? { executionContext: checkpoint.executionContext }
          : {}),
      });
      failedStage = 'PRIVATE_SERVING_VALIDATED';
      const observed = await this.dependencies.observeNonMutation();
      const privateEvidenceRefs = uniqueStrings([
        ...checkpoint.privateEvidenceRefs,
        ...executed.privateEvidenceRefs,
      ]);
      const terminal = createStrictTestPrivateCompletionReceiptV1({
        preflight: checkpoint.preflight,
        automaticSelection,
        projection,
        currentBindings,
        finalCoverageBinding: executed.finalCoverageBinding,
        servingSnapshotManifest: executed.servingSnapshotManifest,
        privateG4ReceiptHash: executed.privateG4ReceiptHash,
        privateServingValidationHash: executed.privateServingValidationHash,
        productionAfterStateHash: observed.productionStateHash,
        publicRouteAfterStateHash: observed.publicRouteStateHash,
        privateEvidenceRefs,
        completedAt: this.dependencies.clock(),
      });
      const context = {
        currentBindings,
        preflight: checkpoint.preflight,
        automaticSelection,
        projection,
      };
      const report = createStrictTestAuditReportV1({
        context,
        terminal,
        verificationCommands: this.dependencies.verificationCommands,
        privateArtifactRefs: privateEvidenceRefs,
      });
      checkpoint = {
        ...checkpoint,
        phase: 'STRICT_TEST_COMPLETED_PRIVATE',
        terminal,
        report,
        privateEvidenceRefs,
      };
      await writeCheckpoint(checkpoint);
      return checkpoint;
    } catch (error: unknown) {
      const taggedStage = readFailureStage(error);
      if (taggedStage) {
        failedStage = taggedStage;
      }
      const observed = await this.dependencies.observeNonMutation();
      const currentBindings = checkpoint.currentBindings;
      if (
        observed.productionStateHash !== currentBindings.productionBeforeStateHash ||
        observed.publicRouteStateHash !== currentBindings.publicRouteBeforeStateHash
      ) {
        const violationSemantic = {
          schemaVersion: 1 as const,
          profile: 'strict-test-dimension' as const,
          demandKey: checkpoint.demandKey,
          runId: checkpoint.runId,
          failedStage,
          errorCode: errorCode(error),
          productionBeforeStateHash: currentBindings.productionBeforeStateHash,
          productionAfterStateHash: observed.productionStateHash,
          publicRouteBeforeStateHash: currentBindings.publicRouteBeforeStateHash,
          publicRouteAfterStateHash: observed.publicRouteStateHash,
          detectedAt: this.dependencies.clock(),
        };
        await writeJsonAtomic(path.join(runRoot, NONMUTATION_VIOLATION_FILE), {
          ...violationSemantic,
          violationHash: hashCanonicalJson(violationSemantic),
        });
        // production/public drift 是完整性事件，不得伪装成普通 private terminal。保留独立
        // sealed evidence 后立即失败关闭，原 durable checkpoint 仍停在最后一个合法私有阶段。
        throw new Error('STRICT_TEST_PRODUCTION_MUTATION_DETECTED', { cause: error });
      }
      const terminal = createStrictTestPrivateFailureReceiptV1({
        context: {
          currentBindings,
          preflight: checkpoint.preflight,
          automaticSelection: authorityForFailure(failedStage).automaticSelection
            ? checkpoint.automaticSelection
            : null,
          projection: authorityForFailure(failedStage).projection ? checkpoint.projection : null,
        },
        failedStage,
        errorCode: errorCode(error),
        privateEvidenceRefs: uniqueStrings([
          ...checkpoint.privateEvidenceRefs,
          `private:error:${errorCode(error)}`,
        ]),
        productionAfterStateHash: observed.productionStateHash,
        publicRouteAfterStateHash: observed.publicRouteStateHash,
        failedAt: this.dependencies.clock(),
      });
      const context = {
        currentBindings,
        preflight: checkpoint.preflight,
        automaticSelection: terminal.automaticSelectionHash ? checkpoint.automaticSelection : null,
        projection: terminal.projectionHash ? checkpoint.projection : null,
      };
      const report = createStrictTestAuditReportV1({
        context,
        terminal,
        verificationCommands: this.dependencies.verificationCommands,
        privateArtifactRefs: checkpoint.privateEvidenceRefs,
      });
      checkpoint = { ...checkpoint, phase: 'STRICT_TEST_FAILED', terminal, report };
      await writeCheckpoint(checkpoint);
      throw error;
    }
  }

  async status(runId: string): Promise<StrictTestDimensionCheckpointV1> {
    const checkpoint = await readRequiredCheckpoint(await this.dependencies.findRunRoot(runId));
    if (checkpoint.terminal?.terminalState === 'STRICT_TEST_COMPLETED_PRIVATE') {
      await this.dependencies.verifyCompletedRun(checkpoint);
    }
    return checkpoint;
  }

  async report(runId: string): Promise<StrictTestAuditReportV1> {
    const checkpoint = await this.status(runId);
    if (!checkpoint.report) {
      throw new Error('STRICT_TEST_REPORT_NOT_READY');
    }
    return checkpoint.report;
  }
}

function authorityForFailure(failedStage: StrictTestFailureStageV1) {
  const selection = failedStage !== 'AUTOMATIC_SELECTION_READY';
  const projection = !['AUTOMATIC_SELECTION_READY', 'SELECTION_AUTO_SELECTED'].includes(
    failedStage
  );
  return { automaticSelection: selection, projection };
}

function readFailureStage(error: unknown): StrictTestFailureStageV1 | null {
  if (!error || typeof error !== 'object' || !('failedStage' in error)) {
    return null;
  }
  return (error as { failedStage?: StrictTestFailureStageV1 }).failedStage ?? null;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.split(':', 1)[0] : 'STRICT_TEST_FAILED';
}

function assertRequestIdentity(
  checkpoint: StrictTestDimensionCheckpointV1,
  input: StrictTestPreflightRequestV1
): void {
  if (
    checkpoint.demandKey !== input.demandKey ||
    checkpoint.runId !== input.runId ||
    checkpoint.projectRoot !== input.projectRoot
  ) {
    throw new Error('STRICT_TEST_PREFLIGHT_RESUME_IDENTITY_MISMATCH');
  }
}

async function readRequiredCheckpoint(runRoot: string): Promise<StrictTestDimensionCheckpointV1> {
  const checkpoint = await readOptionalCheckpoint(runRoot);
  if (!checkpoint) {
    throw new Error('STRICT_TEST_RUN_NOT_FOUND');
  }
  return checkpoint;
}

async function readOptionalCheckpoint(
  runRoot: string
): Promise<StrictTestDimensionCheckpointV1 | null> {
  try {
    const value = JSON.parse(
      await fsp.readFile(path.join(runRoot, CHECKPOINT_FILE), 'utf8')
    ) as StrictTestDimensionCheckpointV1;
    if (
      value.schemaVersion !== 1 ||
      value.profile !== 'strict-test-dimension' ||
      value.runRoot !== runRoot
    ) {
      throw new Error('STRICT_TEST_CHECKPOINT_INVALID');
    }
    assertDurableCheckpoint(value);
    return value;
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function assertDurableCheckpoint(checkpoint: StrictTestDimensionCheckpointV1): void {
  try {
    if (
      (checkpoint.executionContext === undefined) !== (checkpoint.executionContextHash === null) ||
      (checkpoint.executionContext !== undefined &&
        hashCanonicalJson(checkpoint.executionContext) !== checkpoint.executionContextHash)
    ) {
      throw new Error('execution-context');
    }
    const preflight = validateStrictTestPreflightV1(
      checkpoint.compiledPlan,
      checkpoint.currentBindings
    );
    const preview = createStrictTestPreflightPreviewV1(preflight);
    if (
      preflight.preflightHash !== checkpoint.preflight.preflightHash ||
      hashCanonicalJson(preview) !== hashCanonicalJson(checkpoint.preview)
    ) {
      throw new Error('preflight');
    }
    if (checkpoint.automaticSelection) {
      const selection = createStrictTestAutomaticSelectionReceiptV1({
        preflight,
        currentBindings: checkpoint.currentBindings,
        selectedAt: checkpoint.automaticSelection.selectedAt,
      });
      if (
        selection.automaticSelectionHash !== checkpoint.automaticSelection.automaticSelectionHash
      ) {
        throw new Error('automatic-selection');
      }
    }
    if (checkpoint.projection) {
      if (!checkpoint.automaticSelection) {
        throw new Error('projection-without-selection');
      }
      const projection = createStrictTestDimensionExecutionProjectionV1({
        preflight,
        automaticSelection: checkpoint.automaticSelection,
        currentBindings: checkpoint.currentBindings,
        projectedAt: checkpoint.projection.projectedAt,
      });
      if (projection.projectionHash !== checkpoint.projection.projectionHash) {
        throw new Error('projection');
      }
    }
    if (checkpoint.terminal) {
      const context = {
        currentBindings: checkpoint.currentBindings,
        preflight,
        automaticSelection: checkpoint.terminal.automaticSelectionHash
          ? checkpoint.automaticSelection
          : null,
        projection: checkpoint.terminal.projectionHash ? checkpoint.projection : null,
      };
      assertStrictTestPrivateTerminalReceiptV1(checkpoint.terminal, context);
      if (!checkpoint.report) {
        throw new Error('terminal-without-report');
      }
      const report = createStrictTestAuditReportV1({
        context,
        terminal: checkpoint.terminal,
        verificationCommands: checkpoint.report.verificationCommands,
        privateArtifactRefs: checkpoint.report.privateArtifactRefs,
      });
      if (
        report.reportHash !== checkpoint.report.reportHash ||
        hashCanonicalJson(report) !== hashCanonicalJson(checkpoint.report)
      ) {
        throw new Error('report');
      }
    } else if (checkpoint.report) {
      throw new Error('report-without-terminal');
    }
    if (
      (checkpoint.phase === 'AUTOMATIC_SELECTION_READY' &&
        (checkpoint.automaticSelection || checkpoint.projection || checkpoint.terminal)) ||
      (checkpoint.phase === 'SELECTION_AUTO_SELECTED' &&
        (!checkpoint.automaticSelection || checkpoint.projection || checkpoint.terminal)) ||
      (checkpoint.phase === 'PRIVATE_WORKSPACE_READY' &&
        (!checkpoint.automaticSelection || !checkpoint.projection || checkpoint.terminal)) ||
      (checkpoint.phase === 'STRICT_TEST_COMPLETED_PRIVATE' &&
        checkpoint.terminal?.terminalState !== 'STRICT_TEST_COMPLETED_PRIVATE') ||
      (checkpoint.phase === 'STRICT_TEST_FAILED' &&
        checkpoint.terminal?.terminalState !== 'STRICT_TEST_FAILED')
    ) {
      throw new Error('terminal-phase');
    }
  } catch (error: unknown) {
    throw new Error('STRICT_TEST_CHECKPOINT_INVALID', { cause: error });
  }
}

async function writeCheckpoint(checkpoint: StrictTestDimensionCheckpointV1): Promise<void> {
  await fsp.mkdir(checkpoint.runRoot, { recursive: true });
  const target = path.join(checkpoint.runRoot, CHECKPOINT_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, target);
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, target);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort();
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
