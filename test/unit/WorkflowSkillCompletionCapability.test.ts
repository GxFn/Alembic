import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WriteZone } from '@alembic/core/io';
import { describe, expect, test, vi } from 'vitest';
import { generateSkill } from '../../lib/recipe-pipeline/generate/skill-delivery/SkillCompletionCapability.js';

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

      expect(result).toMatchObject({
        success: true,
        skillName: 'project-workflow-skill-test',
        deliveryReceipt: {
          route: 'alembic',
          runtimeExport: {
            status: 'pending',
            strategy: 'symlink-first',
          },
          skillName: 'project-workflow-skill-test',
        },
        deliveryReceiptValidation: { ok: true, issues: [] },
      });
      const skillWrite = [...writes.entries()].find(([filePath]) => filePath.endsWith('SKILL.md'));
      expect(skillWrite?.[1]).toContain('name: project-workflow-skill-test');
      expect(skillWrite?.[1]).toContain('# Workflow Skill Test');
      expect(skillWrite?.[1]).toContain('## Referenced Files');
      expect(result.deliveryReceipt?.asset.contentHash).toMatch(/^sha256:/);
      expect(result.deliveryReceipt?.authorization.status).toBe('pending');
      expect(result.deliveryReceipt?.shoutSummary.runtimeVisible).toBe(false);
      expect([...writes.keys()]).toHaveLength(1);
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
