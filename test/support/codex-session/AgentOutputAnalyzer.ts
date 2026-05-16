import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { inspectCodexAiConfig } from '../../../lib/codex/AiConfigState.js';
import { inspectCodexKnowledge } from '../../../lib/codex/KnowledgeState.js';
import {
  getCodexSavedProjectRootPath,
  readCodexInitMarker,
} from '../../../lib/codex/ProjectRootResolver.js';
import { JobStore } from '../../../lib/daemon/JobStore.js';
import { WorkspaceResolver } from '../../../lib/shared/WorkspaceResolver.js';
import type { AlembicMcpHarness } from './McpHarness.js';
import type {
  CodexScenarioRunFacts,
  CodexScenarioSideEffects,
  CodexSessionExpectation,
  CodexSessionHarnessMode,
  CodexSessionScenario,
} from './ScenarioTypes.js';

export function buildScenarioFacts(options: {
  assistantFinalText: string;
  harness: AlembicMcpHarness;
  harnessMode: CodexSessionHarnessMode;
  projectRoot: string;
  projectRootMode: string;
  projectRootSource: string;
  redactions: string[];
  secretWritten: boolean;
  transcriptPath: string;
}): CodexScenarioRunFacts {
  const transcript = fs.readFileSync(options.transcriptPath, 'utf8');
  const projectRootFacts = collectProjectRootFacts({
    expectedProjectRoot: options.projectRoot,
    mode: options.projectRootMode,
    toolCalls: options.harness.toolCalls,
  });
  const aiConfig = inspectCodexAiConfig(options.projectRoot);
  const knowledge = inspectCodexKnowledge(options.projectRoot);
  const resolver = WorkspaceResolver.fromProject(options.projectRoot);
  const jobs = collectJobFacts(options.projectRoot, options.harness.toolCalls);
  return {
    aiConfig: {
      model: aiConfig.model,
      provider: aiConfig.provider,
      ready: aiConfig.ready,
      source: aiConfig.source,
    },
    assistantFinalText: options.assistantFinalText,
    harnessMode: options.harnessMode,
    initializedAfterRun: knowledge.initialized,
    jobs,
    knowledgeArtifacts: collectKnowledgeArtifacts(resolver),
    leakedSecrets: options.redactions.filter((secret) => secret && transcript.includes(secret)),
    projectRoot: options.projectRoot,
    projectRootDrift: projectRootFacts.drift,
    projectRootMissingToolCalls: projectRootFacts.missing,
    projectRootSource: options.projectRootSource,
    unexpectedProjectRootToolCalls: projectRootFacts.unexpected,
    sideEffects: {
      daemonEnsureCalled: options.harness.supervisor.ensureCalls.length > 0,
      initMarkerWritten: Boolean(readCodexInitMarker(options.projectRoot)),
      jobCreated: options.harness.fetchCalls.some((call) =>
        /\/api\/v1\/jobs\/(?:bootstrap|rescan)/.test(call.url)
      ),
      savedProjectRootWritten: fs.existsSync(getCodexSavedProjectRootPath()),
      secretWritten: options.secretWritten,
    },
    toolCalls: options.harness.toolCalls,
    workspace: {
      configExists: fs.existsSync(resolver.configPath),
      databaseExists: fs.existsSync(resolver.databasePath),
      knowledgeExists: fs.existsSync(resolver.knowledgeDir),
      runtimeExists: fs.existsSync(resolver.runtimeDir),
    },
  };
}

export function analyzeScenarioResult(input: {
  expectation: CodexSessionExpectation;
  facts: CodexScenarioRunFacts;
  scenario: CodexSessionScenario;
  transcriptPath: string;
}): string[] {
  const errors: string[] = [];
  checkProjectRootBinding(input.facts, input.scenario, errors);
  checkToolCalls(input.expectation, input.facts, errors);
  checkSideEffects(input.expectation, input.facts.sideEffects, errors);
  checkState(input.expectation, input.facts, errors);
  checkArtifacts(input.expectation, input.facts, errors);
  checkAssistant(input.expectation, input.facts.assistantFinalText, errors);
  checkRedaction(input, errors);
  return errors.map((error) => `${input.scenario.id}: ${error}`);
}

function checkArtifacts(
  expectation: CodexSessionExpectation,
  facts: CodexScenarioRunFacts,
  errors: string[]
): void {
  const expected = expectation.artifacts;
  if (!expected) {
    return;
  }
  if (
    expected.minCandidateFiles !== undefined &&
    facts.knowledgeArtifacts.candidateFiles.length < expected.minCandidateFiles
  ) {
    errors.push(
      `candidate files expected at least ${expected.minCandidateFiles} but saw ${facts.knowledgeArtifacts.candidateFiles.length}`
    );
  }
  if (
    expected.minRecipeFiles !== undefined &&
    facts.knowledgeArtifacts.recipeFiles.length < expected.minRecipeFiles
  ) {
    errors.push(
      `recipe files expected at least ${expected.minRecipeFiles} but saw ${facts.knowledgeArtifacts.recipeFiles.length}`
    );
  }
  if (
    expected.minKnowledgeEntries !== undefined &&
    facts.knowledgeArtifacts.database.totalEntries < expected.minKnowledgeEntries
  ) {
    errors.push(
      `knowledge_entries expected at least ${expected.minKnowledgeEntries} but saw ${facts.knowledgeArtifacts.database.totalEntries}`
    );
  }
  if (expected.requireTerminalJob && facts.jobs.terminal.length === 0) {
    errors.push('expected at least one terminal daemon job but saw none');
  }
  if (expected.allowedTerminalJobStatuses?.length && facts.jobs.terminal.length > 0) {
    for (const job of facts.jobs.terminal) {
      if (!expected.allowedTerminalJobStatuses.includes(job.status)) {
        errors.push(
          `terminal job ${job.id} status expected one of ${expected.allowedTerminalJobStatuses.join(', ')} but saw ${job.status}`
        );
      }
    }
  }
}

function checkToolCalls(
  expectation: CodexSessionExpectation,
  facts: CodexScenarioRunFacts,
  errors: string[]
): void {
  const expected = expectation.toolCalls || [];
  if (!expected.length) {
    return;
  }
  const actual = facts.toolCalls;
  if (actual.length !== expected.length) {
    errors.push(
      `expected ${expected.length} tool calls but saw ${actual.length}: ${actual.map((call) => call.name).join(', ')}`
    );
    return;
  }
  for (const [index, expectedCall] of expected.entries()) {
    const actualCall = actual[index];
    if (actualCall.name !== expectedCall.name) {
      errors.push(
        `tool call ${index + 1} expected ${expectedCall.name} but saw ${actualCall.name}`
      );
    }
    for (const [key, value] of Object.entries(expectedCall.arguments || {})) {
      const expectedValue = resolveExpectedValue(value, facts);
      if (actualCall.arguments[key] !== expectedValue) {
        errors.push(
          `tool call ${expectedCall.name} argument ${key} expected ${String(expectedValue)} but saw ${String(actualCall.arguments[key])}`
        );
      }
    }
    for (const [path, value] of Object.entries(expectedCall.result || {})) {
      const actualValue = getPath(actualCall.result, path);
      if (actualValue !== value) {
        errors.push(
          `tool call ${expectedCall.name} result ${path} expected ${String(value)} but saw ${String(actualValue)}`
        );
      }
    }
  }
}

function checkProjectRootBinding(
  facts: CodexScenarioRunFacts,
  scenario: CodexSessionScenario,
  errors: string[]
): void {
  const mode = scenario.fixture.projectRoot || 'explicit';
  if (mode === 'explicit') {
    if (facts.projectRootMissingToolCalls.length > 0) {
      errors.push(
        `projectRoot missing from tool calls: ${facts.projectRootMissingToolCalls.join(', ')}`
      );
    }
    if (facts.projectRootDrift.length > 0) {
      errors.push(`projectRoot drift detected: ${facts.projectRootDrift.join('; ')}`);
    }
    return;
  }
  if (facts.unexpectedProjectRootToolCalls.length > 0) {
    errors.push(
      `projectRoot was passed in missing-root scenario: ${facts.unexpectedProjectRootToolCalls.join(', ')}`
    );
  }
}

function checkState(
  expectation: CodexSessionExpectation,
  facts: CodexScenarioRunFacts,
  errors: string[]
): void {
  const expected = expectation.state;
  if (!expected) {
    return;
  }
  if (
    expected.initializedAfterRun !== undefined &&
    facts.initializedAfterRun !== expected.initializedAfterRun
  ) {
    errors.push(
      `state initializedAfterRun expected ${String(expected.initializedAfterRun)} but saw ${String(facts.initializedAfterRun)}`
    );
  }
  if (expected.aiReady !== undefined && facts.aiConfig.ready !== expected.aiReady) {
    errors.push(
      `state aiReady expected ${String(expected.aiReady)} but saw ${String(facts.aiConfig.ready)}`
    );
  }
  if (expected.aiProvider !== undefined && facts.aiConfig.provider !== expected.aiProvider) {
    errors.push(
      `state aiProvider expected ${expected.aiProvider} but saw ${String(facts.aiConfig.provider)}`
    );
  }
  for (const [key, expectedValue] of Object.entries(expected.workspace || {})) {
    const actual = facts.workspace[key as keyof typeof facts.workspace];
    if (actual !== expectedValue) {
      errors.push(`workspace ${key} expected ${String(expectedValue)} but saw ${String(actual)}`);
    }
  }
}

function checkSideEffects(
  expectation: CodexSessionExpectation,
  sideEffects: CodexScenarioSideEffects,
  errors: string[]
): void {
  for (const [key, expected] of Object.entries(expectation.sideEffects || {})) {
    const actual = sideEffects[key as keyof CodexScenarioSideEffects];
    if (actual !== expected) {
      errors.push(`side effect ${key} expected ${String(expected)} but saw ${String(actual)}`);
    }
  }
}

function checkAssistant(
  expectation: CodexSessionExpectation,
  assistantFinalText: string,
  errors: string[]
): void {
  for (const fragment of expectation.assistant?.mustMention || []) {
    if (!assistantFinalText.includes(fragment)) {
      errors.push(`assistant final answer did not mention: ${fragment}`);
    }
  }
  for (const fragment of expectation.assistant?.mustNotMention || []) {
    if (assistantFinalText.includes(fragment)) {
      errors.push(`assistant final answer unexpectedly mentioned: ${fragment}`);
    }
  }
}

function checkRedaction(
  input: {
    expectation: CodexSessionExpectation;
    facts: CodexScenarioRunFacts;
    transcriptPath: string;
  },
  errors: string[]
): void {
  if (input.facts.leakedSecrets.length > 0) {
    errors.push(`transcript leaked secrets: ${input.facts.leakedSecrets.join(', ')}`);
  }
  const transcript = fs.readFileSync(input.transcriptPath, 'utf8');
  for (const fragment of input.expectation.redaction?.mustNotContain || []) {
    if (transcript.includes(fragment)) {
      errors.push(`transcript unexpectedly contained: ${fragment}`);
    }
  }
}

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function collectProjectRootFacts(input: {
  expectedProjectRoot: string;
  mode: string;
  toolCalls: CodexScenarioRunFacts['toolCalls'];
}): { drift: string[]; missing: string[]; unexpected: string[] } {
  const drift: string[] = [];
  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const call of input.toolCalls) {
    const actual = call.arguments.projectRoot;
    if (input.mode === 'missing') {
      if (typeof actual === 'string' && actual.length > 0) {
        unexpected.push(`${call.name}@turn${call.turn}=${actual}`);
      }
      continue;
    }
    if (typeof actual !== 'string' || actual.length === 0) {
      missing.push(`${call.name}@turn${call.turn}`);
      continue;
    }
    if (actual !== input.expectedProjectRoot) {
      drift.push(`${call.name}@turn${call.turn}: ${actual}`);
    }
  }
  return { drift, missing, unexpected };
}

function collectJobFacts(
  projectRoot: string,
  toolCalls: CodexScenarioRunFacts['toolCalls']
): CodexScenarioRunFacts['jobs'] {
  const createdJobIds = extractCreatedJobIds(toolCalls);
  let latest: CodexScenarioRunFacts['jobs']['latest'] = [];
  try {
    const store = new JobStore({ projectRoot });
    latest = store.list({ limit: 20 }).map((job) => ({
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      errorCode: job.error?.code,
      errorMessage: job.error?.message,
      id: job.id,
      kind: job.kind,
      status: job.status,
      updatedAt: job.updatedAt,
    }));
  } catch {
    latest = [];
  }
  return {
    createdJobIds,
    latest,
    terminal: latest.filter((job) => isTerminalJobStatus(job.status)),
  };
}

function collectKnowledgeArtifacts(
  resolver: WorkspaceResolver
): CodexScenarioRunFacts['knowledgeArtifacts'] {
  return {
    candidateFiles: listMarkdownFiles(resolver.candidatesDir),
    candidatesDir: resolver.candidatesDir,
    database: inspectKnowledgeEntries(resolver.databasePath),
    recipeFiles: listMarkdownFiles(resolver.recipesDir, {
      excludeNames: new Set(['_template.md']),
    }),
    recipesDir: resolver.recipesDir,
  };
}

function extractCreatedJobIds(toolCalls: CodexScenarioRunFacts['toolCalls']): string[] {
  const ids: string[] = [];
  for (const call of toolCalls) {
    if (call.name !== 'alembic_codex_bootstrap' && call.name !== 'alembic_codex_rescan') {
      continue;
    }
    const data =
      call.result && typeof call.result === 'object'
        ? (call.result as { data?: unknown }).data
        : null;
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const jobId = typeof record.jobId === 'string' ? record.jobId : null;
    const job =
      record.job && typeof record.job === 'object' ? (record.job as Record<string, unknown>) : {};
    const nestedJobId = typeof job.id === 'string' ? job.id : null;
    const id = jobId || nestedJobId;
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function inspectKnowledgeEntries(
  databasePath: string
): CodexScenarioRunFacts['knowledgeArtifacts']['database'] {
  const base: CodexScenarioRunFacts['knowledgeArtifacts']['database'] = {
    byLifecycle: {},
    error: null,
    path: databasePath,
    tableExists: false,
    totalEntries: 0,
  };
  if (!fs.existsSync(databasePath)) {
    return base;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(databasePath, { fileMustExist: true, readonly: true });
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_entries'")
      .get();
    if (!table) {
      return base;
    }
    const countRow = db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get() as {
      count?: unknown;
    };
    const lifecycleRows = db
      .prepare('SELECT lifecycle, COUNT(*) AS count FROM knowledge_entries GROUP BY lifecycle')
      .all() as Array<{ count?: unknown; lifecycle?: unknown }>;
    const byLifecycle: Record<string, number> = {};
    for (const row of lifecycleRows) {
      const lifecycle = typeof row.lifecycle === 'string' ? row.lifecycle : 'unknown';
      byLifecycle[lifecycle] = Number(row.count || 0);
    }
    return {
      byLifecycle,
      error: null,
      path: databasePath,
      tableExists: true,
      totalEntries: Number(countRow.count || 0),
    };
  } catch (err: unknown) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

function listMarkdownFiles(dir: string, options: { excludeNames?: Set<string> } = {}): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...listMarkdownFiles(fullPath, options).map((child) => path.join(entry.name, child))
      );
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md') && !options.excludeNames?.has(entry.name)) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

function isTerminalJobStatus(status: string): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed';
}

function resolveExpectedValue(value: unknown, facts: CodexScenarioRunFacts): unknown {
  if (value === '$projectRoot') {
    return facts.projectRoot;
  }
  return value;
}
