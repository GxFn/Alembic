import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { SkillAdapter } from '../../lib/tools/adapters/SkillAdapter.js';
import {
  SKILL_LOAD_CAPABILITY,
  SKILL_LOAD_RESOURCE_CAPABILITY,
  SKILL_SEARCH_CAPABILITY,
  SKILL_VALIDATE_CAPABILITY,
} from '../../lib/tools/adapters/SkillCapabilities.js';
import type { ToolCapabilityManifest } from '../../lib/tools/catalog/CapabilityManifest.js';
import type { ToolExecutionRequest } from '../../lib/tools/core/ToolContracts.js';

function request(
  manifest: ToolCapabilityManifest,
  args: Record<string, unknown>,
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-adapter-project-'))
): ToolExecutionRequest {
  return {
    manifest,
    args,
    decision: { allowed: true, stage: 'execute' },
    context: {
      callId: 'call-skill',
      toolId: manifest.id,
      surface: 'runtime',
      actor: { role: 'developer' },
      source: { kind: 'runtime', name: 'skill-adapter-test' },
      projectRoot,
      services: {
        get(name: string) {
          throw new Error(`Unexpected service lookup: ${name}`);
        },
      },
    },
  };
}

function createProjectSkill(projectRoot: string, name = 'project-demo') {
  const skillDir = path.join(projectRoot, 'Alembic', 'skills', name);
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: Project demo skill',
      'version: 1.0.0',
      'status: active',
      'triggers: [demo, testing]',
      'requiresTools: [read_project_file]',
      'permissions: [read]',
      '---',
      '',
      '# Project Demo',
      '',
      'Intro content.',
      '',
      '## Usage',
      'Use this skill for tests.',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(path.join(skillDir, 'references', 'RECIPES.md'), 'recipe reference', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'hooks.js'), 'export default {};', 'utf8');
  return skillDir;
}

describe('SkillAdapter', () => {
  test('searches built-in and project skills through the skill adapter', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-search-'));
    createProjectSkill(projectRoot);
    const adapter = new SkillAdapter();

    const result = await adapter.execute(
      request(SKILL_SEARCH_CAPABILITY, { query: 'demo' }, projectRoot)
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      toolId: 'skill_search',
      trust: { source: 'skill', containsUntrustedText: true },
      structuredContent: {
        success: true,
        data: {
          total: 1,
          skills: [
            {
              name: 'project-demo',
              source: 'project',
              description: 'Project demo skill',
              triggers: ['demo', 'testing'],
              requiresTools: ['read_project_file'],
              permissions: ['read'],
            },
          ],
        },
      },
    });
  });

  test('loads skill content and optional sections', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-load-'));
    createProjectSkill(projectRoot);
    const adapter = new SkillAdapter();

    const result = await adapter.execute(
      request(SKILL_LOAD_CAPABILITY, { name: 'project-demo', section: 'Usage' }, projectRoot)
    );

    expect(result).toMatchObject({
      ok: true,
      structuredContent: {
        success: true,
        data: {
          name: 'project-demo',
          source: 'project',
          section: 'Usage',
          content: expect.stringContaining('Use this skill for tests.'),
        },
      },
    });
    expect(String(result.structuredContent?.data)).not.toContain('hooks.js');
  });

  test('loads non-executable skill resources and blocks hook scripts', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-resource-'));
    createProjectSkill(projectRoot);
    const adapter = new SkillAdapter();

    const resource = await adapter.execute(
      request(
        SKILL_LOAD_RESOURCE_CAPABILITY,
        { name: 'project-demo', resourcePath: 'references/RECIPES.md' },
        projectRoot
      )
    );
    const hook = await adapter.execute(
      request(
        SKILL_LOAD_RESOURCE_CAPABILITY,
        { name: 'project-demo', resourcePath: 'hooks.js' },
        projectRoot
      )
    );

    expect(resource).toMatchObject({
      ok: true,
      structuredContent: {
        data: {
          resourcePath: 'references/RECIPES.md',
          content: 'recipe reference',
        },
      },
    });
    expect(hook).toMatchObject({
      ok: false,
      status: 'blocked',
      structuredContent: {
        error: {
          code: 'SKILL_RESOURCE_EXECUTABLE',
        },
      },
    });
  });

  test('validates skill metadata without executing hooks', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-validate-'));
    createProjectSkill(projectRoot);
    const adapter = new SkillAdapter();

    const result = await adapter.execute(
      request(SKILL_VALIDATE_CAPABILITY, { name: 'project-demo' }, projectRoot)
    );

    expect(result).toMatchObject({
      ok: true,
      structuredContent: {
        success: true,
        data: {
          valid: true,
          total: 1,
          results: [
            {
              name: 'project-demo',
              valid: true,
              errors: [],
            },
          ],
        },
      },
    });
  });
});
