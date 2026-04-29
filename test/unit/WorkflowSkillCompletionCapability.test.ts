import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { WriteZone } from '#infra/io/WriteZone.js';
import { generateSkill } from '#workflows/capabilities/execution/skills/WorkflowSkillCompletionCapability.js';

describe('WorkflowSkillCompletionCapability', () => {
  test('rejects skill generation when analysis text is below quality threshold', async () => {
    const result = await generateSkill(createContext(), { id: 'api', label: 'API' }, 'short');

    expect(result.success).toBe(false);
    expect(result.skillName).toBe('project-api');
    expect(result.error).toContain('analysisText too short');
  });

  test('creates project skill content through the configured write zone', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-skill-test-'));
    const writes = new Map<string, string>();
    const writeZone = createWriteZone(dataRoot, writes);

    try {
      const result = await generateSkill(
        createContext(writeZone),
        {
          id: 'workflow-skill-test',
          label: 'Workflow Skill Test',
          skillMeta: { name: 'project-workflow-skill-test', description: 'Workflow skill test' },
        },
        [
          '## Analysis',
          '',
          '- This analysis has enough structure and project-specific content.',
          '',
          '```ts',
          'const workflowSkill = true;',
          '```',
        ].join('\n'),
        ['src/workflow.ts'],
        ['workflow skill generated'],
        'unit-test'
      );

      expect(result).toEqual({ success: true, skillName: 'project-workflow-skill-test' });
      const skillWrite = [...writes.entries()].find(([filePath]) => filePath.endsWith('SKILL.md'));
      expect(skillWrite?.[1]).toContain('name: project-workflow-skill-test');
      expect(skillWrite?.[1]).toContain('# Workflow Skill Test');
      expect(skillWrite?.[1]).toContain('## Referenced Files');
      const indexWrite = [...writes.entries()].find(([filePath]) =>
        filePath.endsWith('.cursor/rules/alembic-skills.mdc')
      );
      expect(indexWrite?.[1]).toContain('Alembic Project Skills Index');
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

function createContext(writeZone?: WriteZone) {
  return {
    container: {
      singletons: writeZone ? { writeZone, _projectRoot: writeZone.dataRoot } : {},
      get: () => undefined,
    },
  };
}

function createWriteZone(dataRoot: string, writes: Map<string, string>): WriteZone {
  const zone = {
    dataRoot,
    data: (relativePath: string) => ({ absolute: path.join(dataRoot, relativePath) }),
    project: (relativePath: string) => ({ absolute: path.join(dataRoot, 'project', relativePath) }),
    ensureDir: vi.fn(),
    writeFile: vi.fn((target: { absolute: string }, content: string | Buffer) => {
      fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
      fs.writeFileSync(target.absolute, content);
      writes.set(target.absolute, content.toString());
    }),
    remove: vi.fn(),
  };
  return zone as unknown as WriteZone;
}
