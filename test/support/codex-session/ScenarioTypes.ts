export type ScenarioAiState = 'deepseek' | 'missing';

export type ScenarioDaemonState = 'ready' | 'stopped';

export type ScenarioKnowledgeState = 'empty' | 'none' | 'usable';

export type ScenarioProjectKind = 'local-path' | 'minimal-node';

export type ScenarioProjectRootMode = 'explicit' | 'missing';

export type CodexSessionHarnessMode = 'in-process' | 'live-local';

export type CodexScenarioJobStatus = 'cancelled' | 'completed' | 'failed' | 'queued' | 'running';

export interface CodexSessionScenario {
  description?: string;
  expect: CodexSessionExpectation;
  fixture: CodexScenarioFixture;
  id: string;
  manual?: boolean;
  turns: CodexScenarioTurn[];
}

export interface CodexScenarioFixture {
  ai?: ScenarioAiState;
  bootstrapArgs?: Record<string, unknown>;
  daemon?: ScenarioDaemonState;
  initArgs?: Record<string, unknown>;
  initialized?: boolean;
  knowledge?: ScenarioKnowledgeState;
  project?: ScenarioProjectKind;
  projectPath?: string;
  projectRoot?: ScenarioProjectRootMode;
  redactions?: string[];
  useRealAlembicHome?: boolean;
}

export interface CodexScenarioTurn {
  user: string;
}

export interface CodexSessionExpectation {
  assistant?: {
    mustMention?: string[];
    mustNotMention?: string[];
  };
  redaction?: {
    mustNotContain?: string[];
  };
  sideEffects?: Partial<CodexScenarioSideEffects>;
  state?: {
    aiProvider?: string;
    aiReady?: boolean;
    initializedAfterRun?: boolean;
    workspace?: Partial<CodexScenarioRunFacts['workspace']>;
  };
  artifacts?: {
    allowedTerminalJobStatuses?: CodexScenarioJobStatus[];
    minCandidateFiles?: number;
    minKnowledgeEntries?: number;
    minRecipeFiles?: number;
    requireTerminalJob?: boolean;
  };
  toolCalls?: CodexExpectedToolCall[];
}

export interface CodexExpectedToolCall {
  arguments?: Record<string, unknown>;
  name: string;
  result?: Record<string, unknown>;
}

export interface CodexScenarioSideEffects {
  daemonEnsureCalled: boolean;
  initMarkerWritten: boolean;
  jobCreated: boolean;
  savedProjectRootWritten: boolean;
  secretWritten: boolean;
}

export interface CodexSessionTranscriptEvent {
  data?: Record<string, unknown>;
  text?: string;
  tool?: string;
  turn?: number;
  type: string;
}

export interface CodexScenarioToolCallFact {
  arguments: Record<string, unknown>;
  errorCode?: string;
  name: string;
  result: unknown;
  success: boolean | null;
  turn: number;
}

export interface CodexScenarioJobFact {
  completedAt?: string;
  createdAt?: string;
  errorCode?: string;
  errorMessage?: string;
  id: string;
  kind: string;
  status: CodexScenarioJobStatus;
  updatedAt?: string;
}

export interface CodexScenarioKnowledgeArtifacts {
  candidateFiles: string[];
  candidatesDir: string;
  database: {
    byLifecycle: Record<string, number>;
    error: string | null;
    path: string;
    tableExists: boolean;
    totalEntries: number;
  };
  recipeFiles: string[];
  recipesDir: string;
}

export interface CodexScenarioRunFacts {
  aiConfig: {
    model: string | null;
    provider: string | null;
    ready: boolean;
    source: string;
  };
  assistantFinalText: string;
  harnessMode: CodexSessionHarnessMode;
  initializedAfterRun: boolean;
  jobs: {
    createdJobIds: string[];
    latest: CodexScenarioJobFact[];
    terminal: CodexScenarioJobFact[];
  };
  knowledgeArtifacts: CodexScenarioKnowledgeArtifacts;
  leakedSecrets: string[];
  projectRoot: string;
  projectRootDrift: string[];
  projectRootMissingToolCalls: string[];
  projectRootSource: string;
  unexpectedProjectRootToolCalls: string[];
  sideEffects: CodexScenarioSideEffects;
  toolCalls: CodexScenarioToolCallFact[];
  workspace: {
    configExists: boolean;
    databaseExists: boolean;
    knowledgeExists: boolean;
    runtimeExists: boolean;
  };
}

export interface CodexScenarioRunOptions {
  jobPollIntervalMs?: number;
  mode?: CodexSessionHarnessMode;
  projectRoot?: string;
  runRoot?: string;
  useRealAlembicHome?: boolean;
  waitJobTimeoutMs?: number;
  waitUntilReadyMs?: number;
}

export interface CodexScenarioFixtureRunConfig {
  alembicHome: string;
  alembicHomeMode: 'isolated' | 'real';
  harnessMode: CodexSessionHarnessMode;
  jobPollIntervalMs: number;
  projectRoot: string;
  projectRootSource: 'cli-option' | 'env' | 'generated-fixture' | 'scenario-path';
  runRoot: string;
  waitJobTimeoutMs: number;
  waitUntilReadyMs: number;
}

export interface CodexSessionRunResult {
  errors: string[];
  facts: CodexScenarioRunFacts;
  runConfig: CodexScenarioFixtureRunConfig;
  runConfigPath: string;
  resultPath: string;
  runDir: string;
  scenario: CodexSessionScenario;
  summaryPath: string;
  transcriptPath: string;
}
