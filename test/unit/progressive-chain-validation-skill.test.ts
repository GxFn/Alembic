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
  planGeneration: {
    sourceFirst: boolean;
    requiredArtifacts: string[];
    analysisSteps: string[];
    nodeDerivationRules: string[];
    referenceAlignmentRules: string[];
  };
  granularity: {
    minimumNodesForLongChain: number;
    planningRule: string;
    antiPattern: string;
    sourceBoundaryRule: string;
    overlayRule: string;
    branchRule: string;
    scopeExpansionRule: string;
    domainOverlays: Array<{
      id: string;
      path: string;
      loadWhen: string;
      alignmentRequired: boolean;
      statusValues: string[];
    }>;
  };
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

type ChainMapTemplate = {
  schemaVersion: number;
  runId: string;
  target: string;
  sourceFirst: boolean;
  sourceInputs: {
    executorScope: string;
  };
  entryPoints: Array<{
    id: string;
    kind: string;
    file: string;
    symbol: string;
  }>;
  callPath: Array<{
    order: number;
    from: string;
    to: string;
    file: string;
  }>;
  stateBoundaries: Array<{
    id: string;
    kind: string;
    stopCondition: string;
    nodeCandidate: string;
  }>;
  sideEffects: Array<{
    kind: string;
    boundary: string;
    approvalRequired: boolean;
  }>;
  branches: Array<{
    id: string;
    trigger: string;
    decision: string;
  }>;
  degradationPaths: Array<{
    id: string;
    condition: string;
    downstreamImpact: string;
  }>;
  artifactSurfaces: Array<{
    artifact: string;
    producerBoundary: string;
    validationMethod: string;
  }>;
  observabilityGaps: Array<{
    boundary: string;
    missingEvidence: string;
    firstObservationRepair: string;
  }>;
  derivedNodes: Array<{
    id: string;
    sourceBoundary: string;
    stopCondition: string;
    evidence: string[];
    passCriteria: string[];
    failureClasses: string[];
  }>;
  referenceAlignment: Array<{
    reference: string;
    referenceNode: string;
    derivedNode: string;
    status: string;
    action: string;
  }>;
  decision: string;
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
  registered: boolean;
  mode: string;
  ghost: boolean;
  projectId: string;
  expectedProjectId: string;
  dataRoot: string;
  dataRootSource: string;
  workspaceExists: boolean;
  ghostMarker: unknown;
  runtimeDir: string;
  databasePath: string;
  knowledgeBaseDir: string;
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
    expect(metadata.description).toContain('source-derived chain maps');
    expect(metadata.description).toContain('long-chain execution plans');
    expect(metadata.description).toContain('long-chain workflow');
    expect(metadata.description).toContain('optional domain overlays');
    expect(metadata.description).toContain('Alembic cold-start');
    expect(metadata['argument-hint']).toContain('<workflow-or-feature>');
    expect(body).toContain('Executor scope');
    expect(body).toContain('## Node Contract');
    expect(body).toContain('## Source-Derived Planning');
    expect(body).toContain('## Granularity Gate');
    expect(body).toContain('## Primary Deliverable');
    expect(body).toContain('## Work Loop');
    expect(body).toContain('## Failure Handling');
    expect(body).toContain('## Evidence Contract');
    expect(body).toContain(
      'Generate the node plan from source boundaries before applying target documents or domain overlays'
    );
    expect(body).toContain('Record branch and degradation paths');
    expect(body).toContain('A long chain normally needs 10 or more nodes');
    expect(body).toContain('Core posture: plan-first, source-first, and overlay-light');
    expect(body).toContain('`report/plan.md`: a self-contained execution document');
    expect(body).toContain('report/skill-review.md');
    expect(body).toContain('at least as clear as `docs-dev/bootstrap-rescan-chain-test-plan.md`');
    expect(body).toContain('expanded node sections, not only `nodes.json` or a summary table');
    expect(body).toContain('skeleton-only observation and full async execution');
    expect(body).toContain('source chain map before selecting any domain overlay');
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
        './references/chain-plan-generation.md',
        './references/data-location-preflight.md',
        './references/domain-overlays.md',
        './references/overlays/alembic-coldstart-rescan.md',
        './references/plan-quality-standard.md',
        './references/safety-boundaries.md',
        './templates/N0-data-location.json',
        './templates/chain-map.json',
        './templates/commands.md',
        './templates/final-report.md',
        './templates/manifest.json',
        './templates/nodes.json',
        './templates/plan-alignment.md',
        './templates/plan.md',
        './templates/round.md',
        './templates/skill-review.md',
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
    expect(nodeTemplate.planGeneration.sourceFirst).toBe(true);
    expect(nodeTemplate.planGeneration.requiredArtifacts).toEqual([
      'report/plan.md',
      'evidence/chain-map.json',
      'report/plan-alignment.md',
      'report/skill-review.md',
    ]);
    expect(nodeTemplate.planGeneration.analysisSteps.join('\n')).toContain('follow the call path');
    expect(nodeTemplate.planGeneration.analysisSteps.join('\n')).toContain(
      'declare executor scope'
    );
    expect(nodeTemplate.planGeneration.analysisSteps.join('\n')).toContain(
      'record branches and degradation paths'
    );
    expect(nodeTemplate.planGeneration.analysisSteps.join('\n')).toContain(
      'self-contained report/plan.md'
    );
    expect(nodeTemplate.planGeneration.analysisSteps.join('\n')).toContain('benchmark review');
    expect(nodeTemplate.planGeneration.analysisSteps.join('\n')).toContain(
      'node-to-test coverage map'
    );
    expect(nodeTemplate.planGeneration.nodeDerivationRules.join('\n')).toContain('stop condition');
    expect(nodeTemplate.planGeneration.nodeDerivationRules.join('\n')).toContain(
      'recheck standard, and advance rule'
    );
    expect(nodeTemplate.planGeneration.nodeDerivationRules.join('\n')).toContain(
      'skip, block, or degrade later nodes'
    );
    expect(nodeTemplate.planGeneration.referenceAlignmentRules.join('\n')).toContain(
      'coverage oracles, not substitutes for source analysis'
    );
    expect(nodeTemplate.planGeneration.referenceAlignmentRules.join('\n')).toContain(
      'not-applicable, or conditional'
    );
    expect(nodeTemplate.transitionRules.join('\n')).toContain('fail -> running');
    expect(nodeTemplate.transitionRules.join('\n')).toContain(
      'a later broad command cannot pass an earlier node'
    );
    expect(nodeTemplate.transitionRules.join('\n')).toContain(
      'reference documents cannot pass nodes by themselves'
    );
    expect(nodeTemplate.transitionRules.join('\n')).toContain(
      'a skipped, mocked, or degraded branch cannot pass downstream nodes'
    );
    expect(nodeTemplate.transitionRules.join('\n')).toContain(
      'report/plan.md must contain expanded node sections'
    );
    expect(nodeTemplate.transitionRules.join('\n')).toContain('skeleton-only observation');
    expect(nodeTemplate.transitionRules.join('\n')).toContain('expansion nodes');
    expect(nodeTemplate.granularity.minimumNodesForLongChain).toBe(10);
    expect(nodeTemplate.granularity.antiPattern).toContain('single smoke command');
    expect(nodeTemplate.granularity.planningRule).toContain('domain overlays');
    expect(nodeTemplate.granularity.sourceBoundaryRule).toContain('async');
    expect(nodeTemplate.granularity.overlayRule).toContain('optional coverage oracles');
    expect(nodeTemplate.granularity.branchRule).toContain('downstream impact');
    expect(nodeTemplate.granularity.scopeExpansionRule).toContain('one variable at a time');
    expect(nodeTemplate.granularity.domainOverlays[0]).toMatchObject({
      id: '<overlay-id-or-none>',
      alignmentRequired: true,
    });
    expect(nodeTemplate.granularity.domainOverlays[0]?.statusValues).toContain('not-applicable');
    expect(nodeTemplate.granularity.domainOverlays[0]?.statusValues).toContain('conditional');
    expect(nodeTemplate.granularity).not.toHaveProperty('canonicalNodeTaxonomy');
    expect(nodeTemplate.granularity).not.toHaveProperty('coldStartOrder');
    expect(nodeTemplate.granularity).not.toHaveProperty('rescanOrder');
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
    evidence.registered = false;
    evidence.mode = 'standard';
    evidence.ghost = false;
    evidence.projectId = 'n/a';
    evidence.expectedProjectId = 'n/a';
    evidence.dataRoot = 'n/a';
    evidence.dataRootSource = 'project-root';
    evidence.workspaceExists = false;
    evidence.ghostMarker = null;
    evidence.runtimeDir = 'n/a';
    evidence.databasePath = 'n/a';
    evidence.knowledgeBaseDir = 'Alembic';
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
      registered: false,
      mode: 'standard',
      ghost: false,
      projectId: 'n/a',
      dataRoot: 'n/a',
      dataRootSource: 'project-root',
      workspaceExists: false,
      ghostMarker: null,
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
    const planAlignment = readSkillFile('templates/plan-alignment.md');
    const skillReview = readSkillFile('templates/skill-review.md');
    const round = readSkillFile('templates/round.md');
    const commands = readSkillFile('templates/commands.md');
    const finalReport = readSkillFile('templates/final-report.md');
    const chainMap = JSON.parse(readSkillFile('templates/chain-map.json')) as ChainMapTemplate;
    const artifactLayout = readSkillFile('references/artifact-layout.md');
    const alembicAdapter = readSkillFile('references/alembic-adapter.md');
    const chainPlanGeneration = readSkillFile('references/chain-plan-generation.md');
    const domainOverlays = readSkillFile('references/domain-overlays.md');
    const alembicOverlay = readSkillFile('references/overlays/alembic-coldstart-rescan.md');
    const planQuality = readSkillFile('references/plan-quality-standard.md');
    const dataPreflight = readSkillFile('references/data-location-preflight.md');
    const safety = readSkillFile('references/safety-boundaries.md');
    const manifestTemplate = readSkillFile('templates/manifest.json');
    const n0EvidenceTemplate = readSkillFile('templates/N0-data-location.json');

    expect(plan).toContain(
      'Status values: `pending`, `running`, `pass`, `fail`, `blocked`, `skipped`'
    );
    expect(plan).toContain('## Granularity Gate');
    expect(plan).toContain('Primary deliverable: this document is the execution guide');
    expect(plan).toContain(
      'Minimum reference standard: `docs-dev/bootstrap-rescan-chain-test-plan.md`'
    );
    expect(plan).toContain('## Plan Quality Standard');
    expect(plan).toContain('## Source-First Chain Analysis');
    expect(plan).toContain('## Analysis Chain Narrative');
    expect(plan).toContain('## Node Cut Strategy');
    expect(plan).toContain('Executor scope:');
    expect(plan).toContain('Plan mode:');
    expect(plan).toContain('Source-first plan complete');
    expect(plan).toContain('Reference documents and selected domain overlays are coverage oracles');
    expect(plan).toContain('Domain overlay selected');
    expect(plan).toContain('Overlay alignment required before execution');
    expect(plan).toContain('## Branch And Degradation Paths');
    expect(plan).toContain('Skipped, mocked, degraded, or alternate-route branches cannot pass');
    expect(plan).toContain('## Workflow Variant Orders');
    expect(plan).toContain('Skeleton-only observation variant');
    expect(plan).toContain('Full async execution variant');
    expect(plan).toContain('## Reference Alignment');
    expect(plan).toContain('<covered|split|merged|missing|not-applicable|conditional>');
    expect(plan).toContain('## Reference Benchmark Review');
    expect(plan).toContain('## Node-To-Test Coverage Map');
    expect(plan).toContain('Do not leave the plan at N0/N1 plus one broad smoke node');
    expect(plan).toContain('## Expanded Node Sections');
    expect(plan).toContain('Downstream behavior intentionally not evaluated');
    expect(plan).toContain('First optimization action');
    expect(plan).toContain('Recheck standard');
    expect(plan).toContain('Advance rule');
    expect(plan).toContain('## Full-Run Readiness Gate');
    expect(plan).toContain('Focused validation has passed before any expansion node');
    expect(plan).toContain('## Expansion Strategy');
    expect(plan).toContain('## Execution Handoff');
    expect(plan).toContain('Fix only the current failing node');
    expect(planAlignment).toContain('Compare source-derived nodes against target documents');
    expect(planAlignment).toContain('<covered|split|merged|missing|not-applicable|conditional>');
    expect(planAlignment).toContain('Marked conditional');
    expect(planAlignment).toContain('Ready to execute node plan');
    expect(skillReview).toContain('Generated plan meets benchmark clarity');
    expect(skillReview).toContain('Overlay Applicability Decisions');
    expect(skillReview).toContain('<covered|split|merged|missing|not-applicable|conditional>');
    expect(skillReview).toContain('Skill Gaps Found By This Run');
    expect(chainMap.sourceFirst).toBe(true);
    expect(chainMap.sourceInputs.executorScope).toContain('internal-agent|external-agent');
    expect(chainMap.entryPoints[0]?.kind).toContain('cli|http|mcp');
    expect(chainMap.branches[0]?.trigger).toContain('flag-route-state-or-condition');
    expect(chainMap.branches[0]?.decision).toContain('pass-current-node');
    expect(chainMap.degradationPaths[0]?.condition).toContain('missing-service');
    expect(chainMap.degradationPaths[0]?.downstreamImpact).toContain(
      'nodes-that-cannot-be-marked-pass'
    );
    expect(chainMap.stateBoundaries[0]?.stopCondition).toContain('how-to-stop');
    expect(chainMap.derivedNodes[0]?.failureClasses).toContain('observability');
    expect(chainMap.referenceAlignment[0]?.status).toContain('covered|split|merged');
    expect(round).toContain('Rerun command');
    expect(commands).toContain('User-facing Alembic project commands');
    expect(commands).toContain('Do not run setup, embed, search, rescan');
    expect(finalReport).toContain('Safety Boundary Confirmation');
    expect(artifactLayout).toContain('scratch/chain-runs/<run-id>');
    expect(artifactLayout).toContain('manifest.json');
    expect(artifactLayout).toContain('primary self-contained execution plan');
    expect(artifactLayout).toContain('chain map, plan, alignment, skill review');
    expect(artifactLayout).toContain('N0 evidence templates');
    expect(artifactLayout).toContain('selected domain overlays');
    expect(alembicAdapter).toContain('Do not begin with a full end-to-end user command');
    expect(chainPlanGeneration).toContain('The plan must come from the code path first');
    expect(chainPlanGeneration).toContain('Analysis Passes');
    expect(chainPlanGeneration).toContain('Executor pass');
    expect(chainPlanGeneration).toContain('Branch pass');
    expect(chainPlanGeneration).toContain('Branch and Degradation Contract');
    expect(chainPlanGeneration).toContain('self-contained execution document');
    expect(chainPlanGeneration).toContain('expanded node sections');
    expect(chainPlanGeneration).toContain('target documents and selected domain overlays');
    expect(chainPlanGeneration).toContain(
      'For each reference node or requirement, record one status'
    );
    expect(chainPlanGeneration).toContain('not-applicable');
    expect(chainPlanGeneration).toContain('conditional');
    expect(chainPlanGeneration).toContain('report/skill-review.md');
    expect(domainOverlays).toContain('optional coverage oracles');
    expect(domainOverlays).toContain('Do not load an overlay before the source chain map exists');
    expect(domainOverlays).toContain('Overlay Contract');
    expect(domainOverlays).toContain('expanded `report/plan.md` node sections');
    expect(domainOverlays).toContain('not-applicable');
    expect(domainOverlays).toContain('conditional');
    expect(domainOverlays).toContain('Alembic cold-start/rescan overlay');
    expect(planQuality).toContain('minimum quality floor');
    expect(planQuality).toContain('Required Reader Outcomes');
    expect(planQuality).toContain('Information Accuracy Rules');
    expect(planQuality).toContain('Node Cut Algorithm');
    expect(planQuality).toContain('Required Node Section');
    expect(planQuality).toContain('Completeness Gate');
    expect(planQuality).toContain('Better-Than-Reference Requirement');
    expect(planQuality).toContain('Benchmark Review Requirement');
    expect(planQuality).toContain('node-to-test');
    expect(alembicOverlay).toContain('Use this overlay for Alembic cold-start');
    expect(alembicOverlay).toContain('coverage oracle, not a ready-made plan');
    expect(alembicOverlay).toContain(
      'must meet or exceed `docs-dev/bootstrap-rescan-chain-test-plan.md`'
    );
    expect(alembicOverlay).toContain('Rendering Hints');
    expect(alembicOverlay).toContain('first optimization action');
    expect(alembicOverlay).toContain('mark N5 rescan preservation as `not-applicable`');
    expect(alembicOverlay).toContain('N10 evolve/prescreen as `conditional`');
    expect(alembicOverlay).toContain('Declare executor scope before choosing commands');
    expect(alembicOverlay).toContain('Mandatory Internal Source Splits');
    expect(alembicOverlay).toContain('Full-reset cleanup between N2 and N3');
    expect(alembicOverlay).toContain('Skeleton response and async dispatch after N7');
    expect(alembicOverlay).toContain('Runtime preparation before N8/N9');
    expect(alembicOverlay).toContain(
      'A broad smoke command or full run can provide observation evidence'
    );
    expect(alembicOverlay).toContain('skipAsyncFill=true');
    expect(alembicOverlay).toContain('For internal rescan, add these split points');
    expect(alembicOverlay).toContain('Fixture state before N5');
    expect(alembicOverlay).toContain('Incremental diff mode before N4/N6 planning');
    expect(alembicOverlay).toContain('session superseding or abort logs');
    expect(alembicOverlay).toContain('## Recommended Variant Orders');
    expect(alembicOverlay).toContain('N9 single-dimension analyze');
    expect(alembicOverlay).toContain('Internal rescan');
    expect(alembicOverlay).toContain('N5 existing recipe snapshot and cleanup');
    expect(dataPreflight).toContain('isAlembicDevRepo');
    expect(dataPreflight).toContain('Block when `dataRoot` equals an Alembic source repository');
    expect(dataPreflight).toContain('Isolated Real-Project Runs');
    expect(dataPreflight).toContain('isolated-ghost-runtime');
    expect(safety).toContain('runtime-write');
    expect(safety).toContain('Do not advance a failed node');
    expect(JSON.parse(manifestTemplate)).toMatchObject({ currentNode: 'N0-data-location' });
    expect(JSON.parse(n0EvidenceTemplate)).toMatchObject({
      nodeId: 'N0-data-location',
      mode: 'standard',
      dataRootSource: 'project-root',
      workspaceExists: false,
      ghostMarker: null,
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
