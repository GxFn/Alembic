import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type DaemonJobRecord, JobStore } from '../../../lib/daemon/JobStore.js';
import { analyzeScenarioResult, buildScenarioFacts } from './AgentOutputAnalyzer.js';
import { CodexScenarioAgentSimulator } from './AgentSimulator.js';
import { readScenarioSecretWritten, setupCodexScenarioFixture } from './Fixtures.js';
import { type AlembicMcpHarness, createCodexMcpHarness } from './McpHarness.js';
import type {
  CodexScenarioRunOptions,
  CodexSessionRunResult,
  CodexSessionScenario,
} from './ScenarioTypes.js';
import { TranscriptWriter } from './TranscriptWriter.js';

export async function runCodexSessionScenario(
  scenario: CodexSessionScenario,
  options: CodexScenarioRunOptions = {}
): Promise<CodexSessionRunResult> {
  const fixture = setupCodexScenarioFixture(scenario, options);
  const transcriptPath = path.join(fixture.runDir, 'transcript.jsonl');
  const resultPath = path.join(fixture.runDir, 'result.json');
  const runConfigPath = path.join(fixture.runDir, 'run-config.json');
  const summaryPath = path.join(fixture.runDir, 'summary.md');
  const transcript = new TranscriptWriter({
    filePath: transcriptPath,
    secrets: fixture.redactions,
  });
  let harness: AlembicMcpHarness | null = null;

  try {
    transcript.record({
      data: {
        alembicHome: fixture.config.alembicHome,
        alembicHomeMode: fixture.config.alembicHomeMode,
        expectedProjectRoot:
          scenario.fixture.projectRoot === 'explicit' ? fixture.projectRoot : null,
        projectRoot: fixture.projectRoot,
        projectRootMode: scenario.fixture.projectRoot || 'explicit',
        projectRootSource: fixture.config.projectRootSource,
        runDir: fixture.runDir,
        scenarioId: scenario.id,
        harnessMode: fixture.config.harnessMode,
      },
      type: 'run.started',
    });
    harness = createCodexMcpHarness({
      mode: fixture.config.harnessMode,
      projectRoot: fixture.projectRoot,
      scenario,
      transcript,
      waitUntilReadyMs: fixture.config.waitUntilReadyMs,
    });
    const agent = new CodexScenarioAgentSimulator({
      harness,
      projectRoot: fixture.projectRoot,
      scenario,
      transcript,
    });
    for (const [index, turn] of scenario.turns.entries()) {
      await agent.runTurn(index + 1, turn.user);
    }
    if (fixture.config.harnessMode === 'live-local' && fixture.config.waitJobTimeoutMs > 0) {
      await waitForLiveJobs({
        harness,
        pollIntervalMs: fixture.config.jobPollIntervalMs,
        projectRoot: fixture.projectRoot,
        timeoutMs: fixture.config.waitJobTimeoutMs,
        transcript,
      });
    }

    const facts = buildScenarioFacts({
      assistantFinalText: agent.finalAssistantText,
      harness,
      harnessMode: fixture.config.harnessMode,
      projectRoot: fixture.projectRoot,
      projectRootMode: scenario.fixture.projectRoot || 'explicit',
      projectRootSource: fixture.config.projectRootSource,
      redactions: fixture.redactions,
      secretWritten: readScenarioSecretWritten(fixture.projectRoot),
      transcriptPath,
    });
    const errors = analyzeScenarioResult({
      expectation: scenario.expect,
      facts,
      scenario,
      transcriptPath,
    });
    const result: CodexSessionRunResult = {
      errors,
      facts,
      runConfig: fixture.config,
      runConfigPath,
      resultPath,
      runDir: fixture.runDir,
      scenario,
      summaryPath,
      transcriptPath,
    };
    transcript.record({
      data: { errors, status: errors.length ? 'failed' : 'passed' },
      type: 'run.completed',
    });
    writeRunArtifacts(result);
    return result;
  } finally {
    harness?.restore();
    fixture.restore();
  }
}

export function loadCodexSessionScenarios(
  options: { filter?: string } = {}
): CodexSessionScenario[] {
  const filter = options.filter?.trim();
  if (filter && fs.existsSync(filter) && filter.endsWith('.json')) {
    return [JSON.parse(fs.readFileSync(filter, 'utf8')) as CodexSessionScenario];
  }
  const root = path.resolve('test/codex-scenarios');
  const files = listJsonFiles(root);
  const scenarios = files.map(
    (file) => JSON.parse(fs.readFileSync(file, 'utf8')) as CodexSessionScenario
  );
  const selected = filter
    ? scenarios.filter((scenario) => scenario.id === filter || scenario.id.includes(filter))
    : scenarios.filter((scenario) => !scenario.manual);
  return selected;
}

async function waitForLiveJobs(options: {
  harness: AlembicMcpHarness;
  pollIntervalMs: number;
  projectRoot: string;
  timeoutMs: number;
  transcript: TranscriptWriter;
}): Promise<void> {
  const jobIds = extractCreatedJobIds(options.harness.toolCalls);
  options.transcript.record({
    data: { jobIds, timeoutMs: options.timeoutMs },
    type: 'harness.live_job_wait.started',
  });
  if (jobIds.length === 0) {
    options.transcript.record({
      data: { reason: 'no bootstrap/rescan job id was returned' },
      type: 'harness.live_job_wait.skipped',
    });
    return;
  }

  const store = new JobStore({ projectRoot: options.projectRoot });
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() <= deadline) {
    const jobs = jobIds.map((id) => store.get(id));
    const visibleJobs = jobs.filter((job): job is DaemonJobRecord => Boolean(job));
    options.transcript.record({
      data: {
        jobs: visibleJobs.map((job) => ({
          id: job.id,
          kind: job.kind,
          status: job.status,
          updatedAt: job.updatedAt,
        })),
        missingJobIds: jobIds.filter((id) => !visibleJobs.some((job) => job.id === id)),
      },
      type: 'harness.live_job_wait.poll',
    });
    if (
      visibleJobs.length === jobIds.length &&
      visibleJobs.every((job) => isTerminalJobStatus(job.status))
    ) {
      options.transcript.record({
        data: {
          jobs: visibleJobs.map((job) => ({
            completedAt: job.completedAt,
            error: job.error,
            id: job.id,
            kind: job.kind,
            status: job.status,
          })),
        },
        type: 'harness.live_job_wait.completed',
      });
      return;
    }
    await sleep(Math.max(250, options.pollIntervalMs));
  }
  options.transcript.record({
    data: { jobIds, timeoutMs: options.timeoutMs },
    type: 'harness.live_job_wait.timeout',
  });
}

function extractCreatedJobIds(toolCalls: AlembicMcpHarness['toolCalls']): string[] {
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

function isTerminalJobStatus(status: string): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed';
}

function listJsonFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function writeRunArtifacts(result: CodexSessionRunResult): void {
  fs.writeFileSync(
    result.resultPath,
    `${JSON.stringify(
      {
        errors: result.errors,
        facts: result.facts,
        runConfig: result.runConfig,
        scenario: { id: result.scenario.id, description: result.scenario.description || '' },
        transcriptPath: result.transcriptPath,
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    result.summaryPath,
    [
      `# ${result.scenario.id}`,
      '',
      result.errors.length ? 'Status: failed' : 'Status: passed',
      '',
      `Project root: ${result.runConfig.projectRoot}`,
      `Project root source: ${result.runConfig.projectRootSource}`,
      `Harness mode: ${result.runConfig.harnessMode}`,
      `Alembic home mode: ${result.runConfig.alembicHomeMode}`,
      `Alembic home: ${result.runConfig.alembicHome}`,
      `Jobs: ${result.facts.jobs.latest.map((job) => `${job.id}:${job.status}`).join(', ') || 'none'}`,
      `Knowledge entries: ${result.facts.knowledgeArtifacts.database.totalEntries}`,
      `Candidate files: ${result.facts.knowledgeArtifacts.candidateFiles.length}`,
      `Recipe files: ${result.facts.knowledgeArtifacts.recipeFiles.length}`,
      '',
      `Transcript: ${result.transcriptPath}`,
      `Run config: ${result.runConfigPath}`,
      result.errors.length
        ? `\nErrors:\n${result.errors.map((error) => `- ${error}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
  fs.writeFileSync(result.runConfigPath, `${JSON.stringify(result.runConfig, null, 2)}\n`);
}
