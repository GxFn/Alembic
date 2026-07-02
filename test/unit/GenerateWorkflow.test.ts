import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const projectIndexMock = vi.hoisted(() => ({
  registerGenerateWorkflowImplementation: vi.fn(),
  runGenerateWorkflow: vi.fn(),
}));

vi.mock('../../lib/workflows/project-index/GenerateWorkflow.js', () => projectIndexMock);

import { runColdStartWorkflow } from '../../lib/workflows/cold-start/ColdStartWorkflow.js';
import { runKnowledgeRescanWorkflow } from '../../lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.js';
import { runGenerateWorkflow } from '../../lib/workflows/project-index/GenerateWorkflow.js';

describe('ProjectIndexWorkflow compatibility', () => {
  beforeEach(() => {
    projectIndexMock.runGenerateWorkflow.mockReset();
  });

  test('keeps legacy public workflow names as mode wrappers', async () => {
    const ctx = {
      container: {},
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;
    const coldStartArgs = { maxFiles: 10 } as never;
    const rescanArgs = { reason: 'test-rescan' } as never;
    vi.mocked(runGenerateWorkflow)
      .mockResolvedValueOnce({ data: { mode: 'full' } })
      .mockResolvedValueOnce({ data: { mode: 'incremental' } });

    await runColdStartWorkflow(ctx, coldStartArgs);
    await runKnowledgeRescanWorkflow(ctx, rescanArgs);

    expect(runGenerateWorkflow).toHaveBeenNthCalledWith(1, ctx, coldStartArgs, {
      mode: 'full',
    });
    expect(runGenerateWorkflow).toHaveBeenNthCalledWith(2, ctx, rescanArgs, {
      mode: 'incremental',
    });
    expect(projectIndexMock.registerGenerateWorkflowImplementation).toHaveBeenCalledWith(
      'full',
      expect.any(Function)
    );
    expect(projectIndexMock.registerGenerateWorkflowImplementation).toHaveBeenCalledWith(
      'incremental',
      expect.any(Function)
    );
  });

  test('keeps CLI and daemon project-index consumers explicit by mode', async () => {
    const cliSource = await readFile(join(process.cwd(), 'bin/cli.ts'), 'utf8');
    const daemonSource = await readFile(
      join(process.cwd(), 'lib/daemon/DaemonJobRunner.ts'),
      'utf8'
    );
    const deepMiningSource = await readFile(
      join(process.cwd(), 'lib/daemon/DeepMiningRoundGate.ts'),
      'utf8'
    );
    const combinedConsumers = `${cliSource}\n${daemonSource}\n${deepMiningSource}`;

    expect(combinedConsumers).toContain('runGenerateWorkflow');
    expect(combinedConsumers).toContain("{ mode: 'full' }");
    expect(combinedConsumers).toContain("{ mode: 'incremental' }");
    expect(combinedConsumers).not.toContain("workflows/cold-start/ColdStartWorkflow.js'");
    expect(combinedConsumers).not.toContain(
      "workflows/knowledge-rescan/KnowledgeRescanWorkflow.js'"
    );
  });

  test('keeps workflow session release registration before async dispatch', async () => {
    const coldStartSource = await readFile(
      join(process.cwd(), 'lib/workflows/cold-start/ColdStartWorkflow.ts'),
      'utf8'
    );
    const rescanSource = await readFile(
      join(process.cwd(), 'lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.ts'),
      'utf8'
    );

    const coldBody = coldStartSource.slice(
      coldStartSource.indexOf('async function runColdStartProjectIndexWorkflow')
    );
    expectOrdered(
      coldBody,
      'const workflowSession = createProjectContextWorkflowSession',
      'registerProjectContextWorkflowSessionReleaseOnGenerateCompletion',
      'dispatchAiDimensionRuns({'
    );
    expectOrdered(
      coldBody,
      'const cleanupResult = await runFullResetPolicy',
      'replaceExisting: true',
      'const { taskDefs, bootstrapSession } = startAiDimensionSession'
    );

    const rescanBody = rescanSource.slice(
      rescanSource.indexOf('async function runKnowledgeRescanProjectIndexWorkflow')
    );
    expectOrdered(
      rescanBody,
      'const workflowSessionState =',
      'registerProjectContextWorkflowSessionReleaseOnGenerateCompletion',
      'dispatchAiDimensionRuns({'
    );
    expect(rescanBody).toContain('runAsyncFillInline');
    expect(`${coldBody}\n${rescanBody}`).toContain('skipAsyncFill');
  });

  test('keeps KnowledgeRescan moduleMining result reviewable for selected modules and coverage', async () => {
    const rescanSource = await readFile(
      join(process.cwd(), 'lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.ts'),
      'utf8'
    );
    const moduleMiningBranch = rescanSource.slice(rescanSource.indexOf('perModuleMining &&'));

    expectOrdered(
      moduleMiningBranch,
      'const selectedModules = modules.slice(0, scaleCap);',
      'const sourceRefSnapshotBefore = readModuleMiningSourceRefSnapshot',
      'const result = await runModuleMining({'
    );
    expectOrdered(
      moduleMiningBranch,
      'const sourceRefDelta = readModuleMiningSourceRefDelta',
      'const coverageLedger = writeModuleMiningCoverageLedger',
      'moduleMiningResult = {'
    );
    expect(moduleMiningBranch).toContain('selectedModules: selectedModulePayloads');
    expect(moduleMiningBranch).toContain('sourceRefDelta');
    expect(moduleMiningBranch).toContain('coverageLedger');
  });
});

function expectOrdered(source: string, first: string, second: string, third: string): void {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second, firstIndex);
  const thirdIndex = source.indexOf(third, secondIndex);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThan(firstIndex);
  expect(thirdIndex).toBeGreaterThan(secondIndex);
}
