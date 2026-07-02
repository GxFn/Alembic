import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildAiDimensionCompletionSummary } from '../../lib/recipe-pipeline/generate/execution/AiDimensionFinalizer.js';
import { runWorkflowCompletionFinalizer } from '../../lib/workflows/completion/CompletionFinalizer.js';

const tmpDirs: string[] = [];

describe('WorkflowCompletionFinalizer', () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips retired project delivery and schedules wiki after retired project refresh', async () => {
    const events: string[] = [];
    const container = createContainer(events);

    const result = await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      projectRoot: process.cwd(),
      dataRoot: process.cwd(),
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => container,
        scheduleTask: () => events.push('schedule'),
      },
      semanticMemory: { mode: 'immediate' },
    });

    expect(events).toEqual(['schedule']);
    expect(result.semanticMemoryResult).toBeNull();
    expect(result.deliveryStatus).toBe('skipped');
  });

  test('schedules bootstrap wiki generation under ghost dataRoot', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const projectRoot = makeTempProject('alembic-wiki-project-');
    const dataRoot = makeTempProject('alembic-wiki-data-');

    await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      projectRoot,
      dataRoot,
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => createWikiContainer(),
        scheduleTask: (task) => scheduled.push(task),
      },
      semanticMemory: { mode: 'skip' },
    });

    expect(scheduled).toHaveLength(1);
    await scheduled[0]();

    expect(existsSync(join(dataRoot, 'Alembic', 'wiki', 'meta.json'))).toBe(true);
    expect(existsSync(join(projectRoot, 'Alembic'))).toBe(false);
  });

  test('scheduled semantic memory shares the same scheduler boundary as wiki', async () => {
    const scheduled: Array<() => Promise<void>> = [];

    await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      projectRoot: process.cwd(),
      dataRoot: process.cwd(),
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => ({ services: {}, get: () => undefined }),
        scheduleTask: (task) => scheduled.push(task),
      },
    });

    expect(scheduled).toHaveLength(2);
  });

  test('can skip target delivery and wiki while keeping scheduled semantic memory', async () => {
    const events: string[] = [];
    const scheduled: Array<() => Promise<void>> = [];

    const result = await runWorkflowCompletionFinalizer({
      ctx: { container: { get: () => undefined } },
      session: { id: 'session-1' },
      projectRoot: process.cwd(),
      dataRoot: process.cwd(),
      log: { info: vi.fn(), warn: vi.fn() },
      dependencies: {
        getServiceContainer: () => createContainer(events),
        scheduleTask: (task) => scheduled.push(task),
      },
      steps: { delivery: 'skip', wiki: 'skip' },
    });

    expect(events).toEqual([]);
    expect(scheduled).toHaveLength(1);
    expect(result).toMatchObject({
      deliveryVerification: null,
      deliveryStatus: 'skipped',
      wikiStatus: 'skipped',
    });
  });

  test('internal finalizer delegates completion side effects to workflow finalizer', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/recipe-pipeline/generate/execution/AiDimensionFinalizer.ts'),
      'utf8'
    );

    expect(source).toContain('runWorkflowCompletionFinalizer');
    expect(source).not.toContain('consumeBootstrapDeliveryAndWiki');
    expect(source).not.toContain('consumeBootstrapSemanticMemory');
  });

  test('summarizes rescan finalizer as pipeline isolation', () => {
    expect(
      buildAiDimensionCompletionSummary({
        pipelineMode: 'rescan',
        workflowCompletion: { deliveryVerification: null, semanticMemoryResult: null },
      })
    ).toMatchObject({
      mode: 'rescan',
      isolation: 'pipeline-isolation',
      delivery: { status: 'skipped' },
      wiki: { status: 'skipped' },
      semanticMemory: { status: 'skipped' },
    });
  });

  test('summarizes bootstrap finalizer as full completion', () => {
    expect(
      buildAiDimensionCompletionSummary({
        pipelineMode: 'bootstrap',
        workflowCompletion: {
          deliveryVerification: null,
          semanticMemoryResult: {
            total: { added: 1, updated: 0, merged: 0, skipped: 0 },
            durationMs: 10,
          },
        },
      })
    ).toMatchObject({
      mode: 'bootstrap',
      isolation: 'full-completion',
      delivery: { status: 'skipped' },
      wiki: { status: 'scheduled' },
      semanticMemory: { status: 'completed' },
    });
  });

  test('summarizes skipped bootstrap delivery and wiki from finalizer result', () => {
    expect(
      buildAiDimensionCompletionSummary({
        pipelineMode: 'bootstrap',
        workflowCompletion: {
          deliveryVerification: null,
          semanticMemoryResult: null,
          deliveryStatus: 'skipped',
          wikiStatus: 'skipped',
        },
      })
    ).toMatchObject({
      mode: 'bootstrap',
      isolation: 'full-completion',
      delivery: { status: 'skipped' },
      wiki: { status: 'skipped' },
      semanticMemory: { status: 'skipped' },
    });
  });

  test('keeps completion side effects in dedicated step modules', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/workflows/completion/CompletionFinalizer.ts'),
      'utf8'
    );

    expect(source).toContain('CompletionSteps.js');
    expect(source).toContain('generateWiki');
    expect(source).toContain('consolidateSemanticMemory');
  });
});

function createContainer(events: string[]) {
  void events;
  return {
    services: {},
    get: () => undefined,
  };
}

function makeTempProject(prefix: string): string {
  const root = mkdirTemp(prefix);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: prefix, version: '1.0.0' }));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  return root;
}

function mkdirTemp(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function createWikiContainer() {
  return {
    services: {},
    get: (name: string) => {
      if (name === 'moduleService') {
        return {
          load: vi.fn(async () => undefined),
          listTargets: vi.fn(async () => [
            { name: 'App', type: 'application', path: 'src', dependencies: [] },
          ]),
          getProjectInfo: vi.fn(() => ({
            name: 'GhostWikiProject',
            primaryLanguage: 'typescript',
            sourceFiles: [],
            languages: { typescript: 1 },
          })),
          getDependencyGraph: vi.fn(async () => ({ edges: [] })),
        };
      }
      if (name === 'knowledgeService') {
        return {
          list: vi.fn(async () => ({ data: [] })),
          getStats: vi.fn(async () => ({ total: 0, active: 0, deprecated: 0 })),
        };
      }
      return undefined;
    },
  };
}
