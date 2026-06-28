import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const projectIndexMock = vi.hoisted(() => ({
  registerProjectIndexWorkflowImplementation: vi.fn(),
  runProjectIndexWorkflow: vi.fn(),
}));

vi.mock('../../lib/workflows/project-index/ProjectIndexWorkflow.js', () => projectIndexMock);

import { runColdStartWorkflow } from '../../lib/workflows/cold-start/ColdStartWorkflow.js';
import { runKnowledgeRescanWorkflow } from '../../lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.js';
import { runProjectIndexWorkflow } from '../../lib/workflows/project-index/ProjectIndexWorkflow.js';

describe('ProjectIndexWorkflow compatibility', () => {
  beforeEach(() => {
    projectIndexMock.runProjectIndexWorkflow.mockReset();
  });

  test('keeps legacy public workflow names as mode wrappers', async () => {
    const ctx = {
      container: {},
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;
    const coldStartArgs = { maxFiles: 10 } as never;
    const rescanArgs = { reason: 'test-rescan' } as never;
    vi.mocked(runProjectIndexWorkflow)
      .mockResolvedValueOnce({ data: { mode: 'full' } })
      .mockResolvedValueOnce({ data: { mode: 'incremental' } });

    await runColdStartWorkflow(ctx, coldStartArgs);
    await runKnowledgeRescanWorkflow(ctx, rescanArgs);

    expect(runProjectIndexWorkflow).toHaveBeenNthCalledWith(1, ctx, coldStartArgs, {
      mode: 'full',
    });
    expect(runProjectIndexWorkflow).toHaveBeenNthCalledWith(2, ctx, rescanArgs, {
      mode: 'incremental',
    });
    expect(projectIndexMock.registerProjectIndexWorkflowImplementation).toHaveBeenCalledWith(
      'full',
      expect.any(Function)
    );
    expect(projectIndexMock.registerProjectIndexWorkflowImplementation).toHaveBeenCalledWith(
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

    expect(combinedConsumers).toContain('runProjectIndexWorkflow');
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
      'registerProjectContextWorkflowSessionReleaseOnBootstrapCompletion',
      'dispatchAiDimensionRuns({'
    );

    const rescanBody = rescanSource.slice(
      rescanSource.indexOf('async function runKnowledgeRescanProjectIndexWorkflow')
    );
    expectOrdered(
      rescanBody,
      'const workflowSessionState =',
      'registerProjectContextWorkflowSessionReleaseOnBootstrapCompletion',
      'dispatchAiDimensionRuns({'
    );
    expect(rescanBody).toContain('runAsyncFillInline');
    expect(`${coldBody}\n${rescanBody}`).toContain('skipAsyncFill');
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
