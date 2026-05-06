import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { isAlembicDevRepo, isExcludedProject } from '../../lib/shared/isOwnDevRepo.js';
import { INTERNAL_SKILLS_DIR, PACKAGE_ROOT } from '../../lib/shared/package-root.js';

const SKILL_NAME = 'progressive-chain-validation';
const SKILL_DIR = path.join(INTERNAL_SKILLS_DIR, SKILL_NAME);

type SkillMetadata = {
  name?: unknown;
  description?: unknown;
  'argument-hint'?: unknown;
};

type NodeTemplate = {
  schemaVersion: number;
  runId: string;
  target: string;
  statusValues: string[];
  writeBoundary: {
    targetProjectRoot: string;
    dataRoot: string;
    allowedWriteRoots: string[];
    requiresApproval: string[];
  };
  nodes: Array<{
    id: string;
    status: string;
    attempts: number;
    commands: string[];
    evidence: string[];
    passCriteria: string[];
    failurePolicy: string;
  }>;
  transitionRules: string[];
};

type StartupManifest = {
  schemaVersion: number;
  runId: string;
  target: string;
  status: string;
  owner: string;
  startedAt: string;
  currentNode: string;
  nextNode: string;
  writeBoundary: {
    targetProjectRoot: string;
    dataRoot: string;
    allowedWriteRoots: string[];
    requiresApproval: string[];
  };
  startupChecks: {
    safetyBoundariesLoaded: boolean;
    alembicAdapterLoaded: boolean;
    dataLocationPreflightLoaded: boolean;
    artifactLayoutLoaded: boolean;
    runtimeWritesAllowed: boolean;
  };
};

type DataLocationEvidence = {
  schemaVersion: number;
  nodeId: string;
  targetProjectRoot: string;
  projectRealpath: string;
  isAlembicDevRepo: boolean;
  isExcludedProject: boolean;
  registryPath: string;
  dataRoot: string;
  runtimeDir: string;
  databasePath: string;
  knowledgeDir: string;
  skillsDir: string;
  candidatesDir: string;
  wikiDir: string;
  writeMode: string;
  runtimeWritesAllowed: boolean;
  requiresUserConfirmation: boolean;
  decision: string;
  notes: string[];
};

function readSkillFile(relativePath: string): string {
  return fs.readFileSync(path.join(SKILL_DIR, relativePath), 'utf8');
}

function assertString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
}

function writeRunFile(runRoot: string, relativePath: string, content: string): void {
  const filePath = path.join(runRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
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
  test('declares valid skill metadata for discovery', () => {
    const { metadata, body } = parseSkill();

    assertString(metadata.name, 'name');
    assertString(metadata.description, 'description');
    assertString(metadata['argument-hint'], 'argument-hint');

    expect(path.basename(SKILL_DIR)).toBe(SKILL_NAME);
    expect(metadata.name).toBe(SKILL_NAME);
    expect(metadata.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(metadata.description.length).toBeLessThanOrEqual(1024);
    expect(metadata.description).toContain('Use when:');
    expect(metadata.description).toContain('long-chain workflow');
    expect(metadata.description).toContain('Alembic cold-start');
    expect(metadata['argument-hint']).toContain('<workflow-or-feature>');
    expect(body).toContain('## Node Contract');
    expect(body).toContain('## Failure Handling');
    expect(body).toContain('## Evidence Contract');
  });

  test('uses relative resource links and all linked resources exist', () => {
    const { body } = parseSkill();
    const links = Array.from(body.matchAll(/\]\((\.\/(?:references|templates)\/[^)]+)\)/g)).map(
      (match) => match[1]
    );
    const uniqueLinks = Array.from(new Set(links));

    expect(uniqueLinks.sort()).toEqual(
      [
        './references/alembic-adapter.md',
        './references/artifact-layout.md',
        './references/data-location-preflight.md',
        './references/safety-boundaries.md',
        './templates/N0-data-location.json',
        './templates/commands.md',
        './templates/final-report.md',
        './templates/manifest.json',
        './templates/nodes.json',
        './templates/plan.md',
        './templates/round.md',
      ].sort()
    );

    for (const link of uniqueLinks) {
      expect(fs.existsSync(path.join(SKILL_DIR, link))).toBe(true);
    }

    const resourceMentionLines = body
      .split('\n')
      .filter((line) => /\b(?:references|templates)\//.test(line));
    for (const line of resourceMentionLines) {
      expect(line).toContain('./');
    }
  });

  test('defines a machine-checkable node template with mandatory N0 preflight', () => {
    const nodeTemplate = JSON.parse(readSkillFile('templates/nodes.json')) as NodeTemplate;
    const n0 = nodeTemplate.nodes.find((node) => node.id === 'N0-data-location');

    expect(nodeTemplate.schemaVersion).toBe(1);
    expect(nodeTemplate.statusValues).toEqual([
      'pending',
      'running',
      'pass',
      'fail',
      'blocked',
      'skipped',
    ]);
    expect(nodeTemplate.writeBoundary.allowedWriteRoots).toContain('scratch/chain-runs/<run-id>');
    expect(nodeTemplate.transitionRules.join('\n')).toContain('fail -> running');
    expect(n0).toBeDefined();
    expect(n0?.status).toBe('pending');
    expect(n0?.evidence).toContain('evidence/N0-data-location.json');
    expect(n0?.passCriteria.join('\n')).toContain('isAlembicDevRepo');
    expect(n0?.passCriteria.join('\n')).toContain('writeMode');
    expect(n0?.failurePolicy).toContain('Stop the run');
  });

  test('can start a cold-start validation run with read-only N0 evidence', () => {
    const runId = 'pcv-20260506-1200-cold-start';
    const target = 'Alembic cold-start chain';
    const startedAt = '2026-05-06T12:00:00.000Z';
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-startup-'));
    const runRoot = path.join(tempRoot, runId);
    const projectRealpath = fs.realpathSync(PACKAGE_ROOT);
    const exclusion = isExcludedProject(PACKAGE_ROOT);

    const manifest = JSON.parse(readSkillFile('templates/manifest.json')) as StartupManifest;
    manifest.runId = runId;
    manifest.target = target;
    manifest.owner = 'unit-test';
    manifest.startedAt = startedAt;
    manifest.currentNode = 'N0-data-location';
    manifest.nextNode = 'N1-entry-model';
    manifest.writeBoundary.targetProjectRoot = PACKAGE_ROOT;
    manifest.writeBoundary.dataRoot = 'n/a';
    manifest.writeBoundary.allowedWriteRoots = [`scratch/chain-runs/${runId}`];
    manifest.startupChecks = {
      safetyBoundariesLoaded: true,
      alembicAdapterLoaded: true,
      dataLocationPreflightLoaded: true,
      artifactLayoutLoaded: true,
      runtimeWritesAllowed: false,
    };

    const nodes = JSON.parse(readSkillFile('templates/nodes.json')) as NodeTemplate;
    nodes.runId = runId;
    nodes.target = target;
    nodes.writeBoundary.targetProjectRoot = PACKAGE_ROOT;
    nodes.writeBoundary.dataRoot = 'n/a';
    nodes.writeBoundary.allowedWriteRoots = [`scratch/chain-runs/${runId}`];
    const n0 = nodes.nodes.find((node) => node.id === 'N0-data-location');
    if (!n0) {
      throw new Error('N0-data-location node is required');
    }
    n0.status = 'pass';
    n0.attempts = 1;
    n0.commands = ['read-only source checks'];

    const evidence = JSON.parse(
      readSkillFile('templates/N0-data-location.json')
    ) as DataLocationEvidence;
    evidence.targetProjectRoot = PACKAGE_ROOT;
    evidence.projectRealpath = projectRealpath;
    evidence.isAlembicDevRepo = isAlembicDevRepo(PACKAGE_ROOT);
    evidence.isExcludedProject = exclusion.excluded;
    evidence.registryPath = 'n/a';
    evidence.dataRoot = 'n/a';
    evidence.runtimeDir = 'n/a';
    evidence.databasePath = 'n/a';
    evidence.knowledgeDir = 'n/a';
    evidence.skillsDir = 'n/a';
    evidence.candidatesDir = 'n/a';
    evidence.wikiDir = 'n/a';
    evidence.writeMode = 'read-only';
    evidence.runtimeWritesAllowed = false;
    evidence.requiresUserConfirmation = false;
    evidence.decision = 'pass';
    evidence.notes = [
      'Cold-start chain startup smoke only; runtime writes are blocked in the Alembic source repo.',
    ];

    const plan = readSkillFile('templates/plan.md')
      .replaceAll('<pcv-YYYYMMDD-HHMM-target-slug>', runId)
      .replaceAll('<workflow-or-feature>', target)
      .replaceAll('<absolute-path-or-n/a>', PACKAGE_ROOT)
      .replaceAll('<agent-or-person>', 'unit-test')
      .replaceAll('<iso-time>', startedAt);
    const round = readSkillFile('templates/round.md')
      .replaceAll('<node-id>', 'N0-data-location')
      .replaceAll('<pending|running|pass|fail|blocked|skipped>', 'pass')
      .replaceAll('<number>', '1')
      .replaceAll('<iso-time>', startedAt)
      .replaceAll('<iso-time-or-empty>', startedAt);
    const commands = readSkillFile('templates/commands.md').replaceAll(
      '<pcv-YYYYMMDD-HHMM-target-slug>',
      runId
    );

    writeRunFile(runRoot, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    writeRunFile(runRoot, 'report/nodes.json', `${JSON.stringify(nodes, null, 2)}\n`);
    writeRunFile(runRoot, 'report/plan.md', plan);
    writeRunFile(runRoot, 'report/commands.md', commands);
    writeRunFile(runRoot, 'report/rounds/N0-data-location.md', round);
    writeRunFile(
      runRoot,
      'evidence/N0-data-location.json',
      `${JSON.stringify(evidence, null, 2)}\n`
    );

    expect(JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8'))).toMatchObject({
      runId,
      target,
      status: 'running',
      currentNode: 'N0-data-location',
      nextNode: 'N1-entry-model',
      startupChecks: { runtimeWritesAllowed: false },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(runRoot, 'evidence/N0-data-location.json'), 'utf8'))
    ).toMatchObject({
      nodeId: 'N0-data-location',
      targetProjectRoot: PACKAGE_ROOT,
      projectRealpath,
      isAlembicDevRepo: true,
      isExcludedProject: true,
      dataRoot: 'n/a',
      writeMode: 'read-only',
      runtimeWritesAllowed: false,
      decision: 'pass',
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(runRoot, 'report/nodes.json'), 'utf8'))
    ).toMatchObject({
      runId,
      target,
      nodes: [
        {
          id: 'N0-data-location',
          status: 'pass',
          attempts: 1,
          evidence: ['evidence/N0-data-location.json'],
        },
        { id: 'N1-entry-model', status: 'pending' },
      ],
    });
    expect(fs.readFileSync(path.join(runRoot, 'report/plan.md'), 'utf8')).toContain(target);
    expect(
      fs.readFileSync(path.join(runRoot, 'report/rounds/N0-data-location.md'), 'utf8')
    ).toContain('Status: `pass`');
  });

  test('templates and references preserve Alembic safety and repair guidance', () => {
    const plan = readSkillFile('templates/plan.md');
    const round = readSkillFile('templates/round.md');
    const commands = readSkillFile('templates/commands.md');
    const finalReport = readSkillFile('templates/final-report.md');
    const artifactLayout = readSkillFile('references/artifact-layout.md');
    const alembicAdapter = readSkillFile('references/alembic-adapter.md');
    const dataPreflight = readSkillFile('references/data-location-preflight.md');
    const safety = readSkillFile('references/safety-boundaries.md');
    const manifestTemplate = readSkillFile('templates/manifest.json');
    const n0EvidenceTemplate = readSkillFile('templates/N0-data-location.json');

    expect(plan).toContain(
      'Status values: `pending`, `running`, `pass`, `fail`, `blocked`, `skipped`'
    );
    expect(plan).toContain('Fix only the current failing node');
    expect(round).toContain('Rerun command');
    expect(commands).toContain('User-facing Alembic project commands');
    expect(commands).toContain('Do not run setup, embed, search, rescan');
    expect(finalReport).toContain('Safety Boundary Confirmation');
    expect(artifactLayout).toContain('scratch/chain-runs/<run-id>');
    expect(artifactLayout).toContain('manifest.json');
    expect(artifactLayout).toContain('templates/N0-data-location.json');
    expect(alembicAdapter).toContain('Do not begin with a full end-to-end user command');
    expect(dataPreflight).toContain('isAlembicDevRepo');
    expect(dataPreflight).toContain('Block when `dataRoot` equals an Alembic source repository');
    expect(safety).toContain('runtime-write');
    expect(safety).toContain('Do not advance a failed node');
    expect(JSON.parse(manifestTemplate)).toMatchObject({ currentNode: 'N0-data-location' });
    expect(JSON.parse(n0EvidenceTemplate)).toMatchObject({
      nodeId: 'N0-data-location',
      writeMode: 'read-only',
      runtimeWritesAllowed: false,
    });
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
