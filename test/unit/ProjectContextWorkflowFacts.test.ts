import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildProjectContextWorkflowFacts } from '../../lib/workflows/project-context/ProjectContextWorkflowFacts.js';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('ProjectContextWorkflowFacts', () => {
  test('executes direct ProjectContext facts for built-in Agent workflow output', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'alembic-pci4-project-context-'));
    fixtures.push(projectRoot);

    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(projectRoot, 'lib'), { recursive: true });
      await fs.writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'pci4-fixture', type: 'module' })
      );
      await fs.writeFile(
        join(projectRoot, 'lib/index.ts'),
        'export function answer(): number { return 42; }\n'
      );
    });

    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-bootstrap',
    });

    expect(facts.projectContextSummary).toMatchObject({ source: 'project-context' });
    expect(facts.requestKinds).toContain('space');
    expect(facts.requestKinds).toContain('repo');
    expect(facts.requestKinds).toContain('map');
    expect(facts.requestKinds).toContain('source-slice');
    expect(facts.allFiles.some((file) => file.relativePath.endsWith('lib/index.ts'))).toBe(true);
    expect(JSON.stringify(facts.projectContextSummary)).toContain('project-context');
  });

  test('removes built-in Agent legacy adapter and carrier imports from workflow routes', async () => {
    await expect(
      stat(
        join(process.cwd(), 'lib/workflows/agent-project-context/AgentProjectContextAnalysis.ts')
      )
    ).rejects.toThrow();

    const coldStart = await readFile(
      join(process.cwd(), 'lib/workflows/cold-start/ColdStartWorkflow.ts'),
      'utf8'
    );
    const rescan = await readFile(
      join(process.cwd(), 'lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.ts'),
      'utf8'
    );
    const combined = `${coldStart}\n${rescan}`;

    expect(combined).not.toContain('runAgentProjectContextAnalysis');
    expect(combined).not.toContain('AgentProjectContextAnalysis');
    expect(combined).not.toContain('buildProjectSnapshot');
    expect(combined).not.toContain('ProjectSnapshot');
    expect(combined).not.toContain('@alembic/core/workflows/capabilities/project-intelligence');
  });
});
