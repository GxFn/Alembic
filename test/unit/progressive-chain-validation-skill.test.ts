import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { INTERNAL_SKILLS_DIR, PACKAGE_ROOT } from '../../lib/shared/package-root.js';

const SKILL_NAME = 'progressive-chain-validation';
const SKILL_DIR = path.join(INTERNAL_SKILLS_DIR, SKILL_NAME);

type SkillMetadata = {
  name?: unknown;
  description?: unknown;
  'argument-hint'?: unknown;
};

function readSkillFile(relativePath: string): string {
  return fs.readFileSync(path.join(SKILL_DIR, relativePath), 'utf8');
}

function assertString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
}

function parseSkill(): { metadata: SkillMetadata; body: string } {
  const text = readSkillFile('SKILL.md');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) {
    throw new Error('SKILL.md must start with YAML frontmatter');
  }

  return {
    metadata: yaml.load(match[1]) as SkillMetadata,
    body: text.slice(match[0].length),
  };
}

describe('progressive-chain-validation internal skill', () => {
  test('declares valid plan-centric skill metadata for discovery', () => {
    const { metadata, body } = parseSkill();

    assertString(metadata.name, 'name');
    assertString(metadata.description, 'description');
    assertString(metadata['argument-hint'], 'argument-hint');

    expect(path.basename(SKILL_DIR)).toBe(SKILL_NAME);
    expect(metadata.name).toBe(SKILL_NAME);
    expect(metadata.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(metadata.description.length).toBeLessThanOrEqual(1024);
    expect(metadata.description).toContain('Use when:');
    expect(metadata.description).toContain('source-derived chain maps');
    expect(metadata.description).toContain('long-chain execution plans');
    expect(metadata.description).toContain('Alembic cold-start');
    expect(metadata['argument-hint']).toContain('<workflow-or-feature>');

    expect(body).toContain('patient section-by-section execution');
    expect(body).toContain('treat `report/plan.md` as the state machine');
    expect(body).toContain('node-specific design/test plan');
    expect(body).toContain('benchmark-style operational guidance block');
    expect(body).toContain('goal, execution range, evidence checklist, pass standard');
    expect(body).toContain('Terminal stability constraints');
    expect(body).toContain('Do not run unbounded synchronous terminal commands');
    expect(body).toContain('## Node Isolation Contract');
    expect(body).toContain('## Section Task Workflow');
    expect(body).toContain('intake, design, fixture setup, isolated execution');
    expect(body).toContain(
      'it is acceptable and often correct to finish a turn with only one node improved'
    );
    expect(body).toContain('node-local simulated data or frozen upstream artifact');
    expect(body).toContain('scheduler, worker/start, producer, persistence, finalizer');
    expect(body).toContain('Do not create separate manifest, nodes, chain-map');
    expect(body).toContain('Optional attachments only when needed');
    expect(body).toContain('## Execution Control Protocol');
    expect(body).toContain('## Evidence Contract');
  });

  test('uses relative resource links and keeps only one plan template', () => {
    const { body } = parseSkill();
    const links = Array.from(body.matchAll(/\]\((\.\/(?:references|templates)\/[^)]+)\)/g)).map(
      (match) => match[1]
    );
    const uniqueLinks = Array.from(new Set(links));

    expect(uniqueLinks.sort()).toEqual(
      [
        './references/alembic-adapter.md',
        './references/artifact-layout.md',
        './references/chain-plan-generation.md',
        './references/data-location-preflight.md',
        './references/domain-overlays.md',
        './references/overlays/alembic-coldstart-rescan.md',
        './references/plan-quality-standard.md',
        './references/safety-boundaries.md',
        './templates/plan.md',
      ].sort()
    );

    for (const link of uniqueLinks) {
      expect(fs.existsSync(path.join(SKILL_DIR, link))).toBe(true);
    }

    expect(fs.readdirSync(path.join(SKILL_DIR, 'templates')).sort()).toEqual(['plan.md']);
  });

  test('plan template embeds state, evidence, review, and execution logs', () => {
    const plan = readSkillFile('templates/plan.md');

    expect(plan).toContain('Required artifact: this `report/plan.md` file');
    expect(plan).toContain('Attachment rule: every optional attachment');
    expect(plan).toContain('## Source Chain Map');
    expect(plan).toContain('## Reference Alignment');
    expect(plan).toContain('## Reference Benchmark Review');
    expect(plan).toContain('## Per-Node Design/Test Plan Index');
    expect(plan).toContain('## Node Plan');
    expect(plan).toContain('Node design/test plan');
    expect(plan).toContain('Operational guidance');
    expect(plan).toContain('Terminal execution is bounded');
    expect(plan).toContain('Terminal mode and timeout budget');
    expect(plan).toContain('Terminal hang recovery');
    expect(plan).toContain('Terminal stability plan for commands');
    expect(plan).toContain('Evidence checklist');
    expect(plan).toContain('Failure taxonomy');
    expect(plan).toContain('Optimization actions');
    expect(plan).toContain('Recheck metrics');
    expect(plan).toContain('Isolation design');
    expect(plan).toContain('Section task workflow');
    expect(plan).toContain('Current section phase');
    expect(plan).toContain('progress is measured by current-section quality');
    expect(plan).toContain('Node-local fixture or frozen upstream artifact');
    expect(plan).toContain('Downstream cut point for the next action');
    expect(plan).toContain('Isolation criteria: downstream artifacts are absent');
    expect(plan).toContain('Execution log');
    expect(plan).toContain('## Final Outcome');
    expect(plan).toContain('Attachments, if any');
    expect(plan).not.toContain('report/rounds/');
    expect(plan).not.toContain('report/skill-review.md');
    expect(plan).not.toContain('evidence/chain-map.json');
    expect(plan).not.toContain('report/nodes.json');
  });

  test('references require plan-centric artifacts instead of bookkeeping files', () => {
    const artifactLayout = readSkillFile('references/artifact-layout.md');
    const chainPlanGeneration = readSkillFile('references/chain-plan-generation.md');
    const domainOverlays = readSkillFile('references/domain-overlays.md');
    const dataPreflight = readSkillFile('references/data-location-preflight.md');
    const planQuality = readSkillFile('references/plan-quality-standard.md');
    const safety = readSkillFile('references/safety-boundaries.md');
    const alembicAdapter = readSkillFile('references/alembic-adapter.md');
    const alembicOverlay = readSkillFile('references/overlays/alembic-coldstart-rescan.md');

    expect(artifactLayout).toContain('Plan-Centric Layout');
    expect(artifactLayout).toContain(
      '`report/plan.md` is the primary and only required run artifact'
    );
    expect(artifactLayout).toContain('Do not create separate manifest, node-state, chain-map');
    expect(chainPlanGeneration).toContain('single required artifact');
    expect(chainPlanGeneration).toContain('## Node Isolation Design');
    expect(chainPlanGeneration).toContain('Section workflow pass');
    expect(chainPlanGeneration).toContain('Guidance pass');
    expect(chainPlanGeneration).toContain('Terminal stability pass');
    expect(chainPlanGeneration).toContain('Never make an unbounded synchronous terminal command');
    expect(chainPlanGeneration).toContain('benchmark-style operational block');
    expect(chainPlanGeneration).toContain(
      'Patience rule: the correct unit of progress is one section becoming trustworthy'
    );
    expect(chainPlanGeneration).toContain(
      'Simulated input, fixture state, or frozen upstream artifact'
    );
    expect(chainPlanGeneration).toContain('enqueue/schedule, worker claim, preparation');
    expect(chainPlanGeneration).toContain('Use optional attachments only for large command output');
    expect(chainPlanGeneration).toContain(
      'Node Plan and Execution Log sections in `report/plan.md`'
    );
    expect(domainOverlays).toContain("plan's Source Chain Map section");
    expect(domainOverlays).toContain("plan's Reference Alignment section");
    expect(dataPreflight).toContain('N0 data-location section of `report/plan.md`');
    expect(planQuality).toContain('complete its benchmark review section');
    expect(planQuality).toContain('Operational guidance');
    expect(planQuality).toContain('concrete evidence checklist');
    expect(planQuality).toContain('Terminal stability');
    expect(planQuality).toContain('unbounded synchronous terminal execution');
    expect(planQuality).toContain('Isolation design');
    expect(planQuality).toContain('downstream cut point, reset rule, and isolation proof');
    expect(planQuality).toContain('Section task workflow');
    expect(planQuality).toContain('The executor may spend the whole turn on this section');
    expect(safety).toContain('## Terminal Stability Contract');
    expect(safety).toContain('Do not use unbounded `timeout=0`');
    expect(safety).toContain('Hang recovery');
    expect(alembicAdapter).toContain('terminal stability guard');
    expect(alembicOverlay).toContain("plan's Source Chain Map section");
    expect(alembicOverlay).toContain('N11 Produce Guidance Floor');
    expect(alembicOverlay).toContain('submitted, accepted, and rejected counts');
    expect(alembicOverlay).toContain('Rejected candidates have actionable field-level reasons');
  });

  test('can render the plan template as the single startup artifact', () => {
    const runId = 'pcv-20260507-1200-cold-start';
    const target = 'Alembic cold-start chain';
    const startedAt = '2026-05-07T12:00:00.000Z';
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-plan-only-'));
    const planPath = path.join(tempRoot, runId, 'report', 'plan.md');

    const plan = readSkillFile('templates/plan.md')
      .replaceAll('<pcv-YYYYMMDD-HHMM-target-slug>', runId)
      .replaceAll('<workflow-or-feature>', target)
      .replaceAll('<absolute-path-or-n/a>', PACKAGE_ROOT)
      .replaceAll('<agent-or-person>', 'unit-test')
      .replaceAll('<iso-time>', startedAt);

    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, plan, 'utf8');

    const rendered = fs.readFileSync(planPath, 'utf8');
    expect(rendered).toContain(runId);
    expect(rendered).toContain(target);
    expect(rendered).toContain('## Source Chain Map');
    expect(rendered).toContain('## Execution Control Gate');
    expect(rendered).toContain('## Final Outcome');
  });

  test('keeps the internal skill out of npm package builtin skill exports', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
    ) as {
      files: string[];
    };

    expect(packageJson.files).toContain('injectable-skills');
    expect(packageJson.files).not.toContain('skills');
  });
});
