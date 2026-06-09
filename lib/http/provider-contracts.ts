import {
  CORE_CONTRACT_SPINE_ROWS,
  CORE_CONTRACT_SPINE_VERSION,
  type CoreContractFunctionClass,
  type CoreContractSpineRowId,
} from '@alembic/core/shared';

export const ALEMBIC_PROVIDER_CONTRACT_VERSION = 1;

export type AlembicProviderRegistryRowId = CoreContractSpineRowId | 'I09' | 'I10' | 'I11' | 'I22';
export type AlembicProviderRouteRowId = Exclude<AlembicProviderRegistryRowId, 'I01'>;
export type AlembicProviderFixtureScenario =
  | 'success'
  | 'failure'
  | 'partial'
  | 'cancelled'
  | 'unavailable-runtime';
export type AlembicProviderTransport = 'http' | 'rest-recovery' | 'socket.io' | 'sse';
export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';
export type JsonSchema = {
  readonly [key: string]: unknown;
};

export interface AlembicProviderRouteContract {
  readonly artifactPolicy: string;
  readonly capabilityDiscovery: readonly string[];
  readonly contractId: string;
  readonly errorKinds: readonly string[];
  readonly exposureClasses: readonly string[];
  readonly fixtureIds: readonly string[];
  readonly functionClass: CoreContractFunctionClass | 'rest-command';
  readonly method: HttpMethod;
  readonly operationId: string;
  readonly path: string;
  readonly registryRowId: AlembicProviderRegistryRowId;
  readonly responseSchemas: Readonly<Record<string, JsonSchema>>;
  readonly summary: string;
  readonly supportedScenarios: readonly AlembicProviderFixtureScenario[];
  readonly tags: readonly string[];
}

export interface AlembicProviderEventContract {
  readonly contractId: string;
  readonly eventName: string;
  readonly fixtureIds: readonly string[];
  readonly metadataSchema: JsonSchema;
  readonly payloadSchema: JsonSchema;
  readonly registryRowId: AlembicProviderRegistryRowId;
  readonly supportedScenarios: readonly AlembicProviderFixtureScenario[];
  readonly transport: AlembicProviderTransport;
}

export interface AlembicProviderFixture {
  readonly contractId: string;
  readonly fixtureId: string;
  readonly payload: Record<string, unknown>;
  readonly registryRowId: AlembicProviderRegistryRowId;
  readonly scenario: AlembicProviderFixtureScenario;
}

export interface AlembicProviderRouteMount {
  readonly fullPath: string;
  readonly registryRowId: AlembicProviderRegistryRowId;
  readonly requiredBy: 'd3-provider-contract';
}

export interface AlembicProviderContractSummary {
  readonly coreSpineVersion: typeof CORE_CONTRACT_SPINE_VERSION;
  readonly eventCount: number;
  readonly fixtureCount: number;
  readonly routeCount: number;
  readonly routeMountCount: number;
  readonly rowIds: AlembicProviderRegistryRowId[];
  readonly version: typeof ALEMBIC_PROVIDER_CONTRACT_VERSION;
}

const envelopeBase = {
  type: 'object',
  required: ['success'],
  additionalProperties: true,
  properties: {
    success: { type: 'boolean' },
  },
} as const satisfies JsonSchema;

const objectSchema = {
  type: 'object',
  additionalProperties: true,
} as const satisfies JsonSchema;

const problemSchema = {
  type: 'object',
  required: ['success', 'error'],
  additionalProperties: false,
  properties: {
    success: { const: false },
    error: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            reasonCode: { type: 'string' },
          },
        },
      ],
    },
  },
} as const satisfies JsonSchema;

const eventMetadataSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contractId: { type: 'string' },
    correlationId: { type: 'string' },
    eventId: { type: 'string' },
    emittedAt: { type: 'string', format: 'date-time' },
    jobId: { type: 'string' },
    sequence: { type: 'number' },
    source: { type: 'string' },
    transport: { type: 'string' },
  },
} as const satisfies JsonSchema;

function dataEnvelope(dataSchema: JsonSchema): JsonSchema {
  return {
    ...envelopeBase,
    properties: {
      ...((envelopeBase.properties as Record<string, unknown>) ?? {}),
      data: dataSchema,
    },
  };
}

function arrayDataEnvelope(itemSchema: JsonSchema): JsonSchema {
  return dataEnvelope({
    type: 'object',
    additionalProperties: true,
    properties: {
      items: { type: 'array', items: itemSchema },
      total: { type: 'number' },
    },
  });
}

const routeRows = {
  I03: {
    artifactPolicy: 'Health summary inline; logs and state snapshots by detailRef.',
    capabilityDiscovery: ['GET /api/v1/daemon/health capabilities'],
    errorKinds: ['unavailable', 'capability-mismatch', 'stale-runtime', 'internal-error'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['runtime-health.ready', 'runtime-health.partial', 'runtime-health.unavailable'],
    scenarios: ['success', 'partial', 'unavailable-runtime'],
  },
  I04: {
    artifactPolicy: 'Project runtime summary inline; diagnostics by detailRef.',
    capabilityDiscovery: ['GET /api/v1/daemon/health', 'GET /api/v1/projects/status'],
    errorKinds: ['conflict', 'timeout', 'cancelled', 'not-found', 'internal-error'],
    exposureClasses: ['consumer-needed', 'diagnostic'],
    fixtureIds: ['project-runtime.success', 'project-runtime.conflict'],
    scenarios: ['success', 'failure'],
  },
  I05: {
    artifactPolicy: 'ProjectScope summary inline; registry snapshots by artifactRef.',
    capabilityDiscovery: ['daemon health projectScope capability', '/api/v1/project-scope'],
    errorKinds: ['invalid-input', 'conflict', 'not-found', 'internal-error'],
    exposureClasses: ['consumer-needed', 'diagnostic'],
    fixtureIds: ['project-scope.success', 'project-scope.failure'],
    scenarios: ['success', 'failure'],
  },
  I06: {
    artifactPolicy: 'Compact job summary inline; reports/logs/snapshots by artifactRef/detailRef.',
    capabilityDiscovery: ['daemon health jobs capability'],
    errorKinds: ['invalid-input', 'timeout', 'cancelled', 'conflict', 'not-found'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['jobs.queued', 'jobs.cancelled', 'jobs.unavailable'],
    scenarios: ['success', 'cancelled', 'unavailable-runtime'],
  },
  I07: {
    artifactPolicy:
      'Developer-facing events inline; raw-provider, secret, and hidden reasoning hidden by default.',
    capabilityDiscovery: ['daemon health jobs.processEvents capability'],
    errorKinds: ['partial', 'unavailable', 'not-found', 'internal-error'],
    exposureClasses: ['developer-facing', 'machine-only', 'raw-provider', 'secret'],
    fixtureIds: ['job-event.visible', 'job-event.partial'],
    scenarios: ['success', 'partial'],
  },
  I08: {
    artifactPolicy: 'Snapshot manifest inline; large reports, logs, and LLM IO by artifactRef.',
    capabilityDiscovery: ['jobs capability', 'snapshot manifest'],
    errorKinds: ['not-found', 'artifact-missing', 'artifact-unreadable', 'checksum-mismatch'],
    exposureClasses: ['public', 'developer-facing', 'diagnostic', 'sensitive'],
    fixtureIds: ['job-snapshot.success', 'job-artifact.missing'],
    scenarios: ['success', 'failure'],
  },
  I09: {
    artifactPolicy: 'Route summaries inline; long reports/logs via artifact routes.',
    capabilityDiscovery: ['/api-spec', '/api/v1/daemon/health'],
    errorKinds: ['invalid-input', 'permission-denied', 'unavailable', 'timeout', 'not-found'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['api-spec.success', 'route.not-found'],
    scenarios: ['success', 'failure'],
  },
  I10: {
    artifactPolicy: 'Compact decision summary inline; large evidence payloads by ref.',
    capabilityDiscovery: ['/api/v1/decision-register/capability'],
    errorKinds: ['invalid-input', 'unavailable', 'capability-mismatch', 'conflict'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['decision-register.success', 'decision-register.scope-mismatch'],
    scenarios: ['success', 'failure'],
  },
  I11: {
    artifactPolicy: 'Intent/work summaries inline; long histories by detailRef.',
    capabilityDiscovery: ['/api/v1/intent-episodes capability block'],
    errorKinds: ['invalid-input', 'unavailable', 'capability-mismatch', 'not-found'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['intent-episode.success', 'intent-episode.not-found'],
    scenarios: ['success', 'failure'],
  },
  I21: {
    artifactPolicy: 'Compact guard findings inline; full reports by artifactRef.',
    capabilityDiscovery: ['/api/v1/guard', '/api/v1/rules'],
    errorKinds: ['invalid-input', 'unavailable', 'capability-mismatch', 'internal-error'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['guard.success', 'guard.invalid-input'],
    scenarios: ['success', 'failure'],
  },
  I22: {
    artifactPolicy: 'Workflow summaries inline; reports/snapshots by artifactRef.',
    capabilityDiscovery: ['/api/v1/knowledge', '/api/v1/modules', '/api/v1/candidates'],
    errorKinds: ['invalid-input', 'unavailable', 'timeout', 'not-found', 'internal-error'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['knowledge.success', 'workflow.unavailable'],
    scenarios: ['success', 'unavailable-runtime'],
  },
  I23: {
    artifactPolicy: 'Diagnostic summaries inline; logs and reports as detailRef.',
    capabilityDiscovery: ['runtime health fileMonitor capability', 'diagnostic routes'],
    errorKinds: ['invalid-input', 'unavailable', 'permission-denied', 'not-found'],
    exposureClasses: ['diagnostic', 'internal', 'consumer-needed', 'sensitive'],
    fixtureIds: ['diagnostic.success', 'diagnostic.failure'],
    scenarios: ['success', 'failure'],
  },
} as const satisfies Record<
  AlembicProviderRouteRowId,
  {
    readonly artifactPolicy: string;
    readonly capabilityDiscovery: readonly string[];
    readonly errorKinds: readonly string[];
    readonly exposureClasses: readonly string[];
    readonly fixtureIds: readonly string[];
    readonly scenarios: readonly AlembicProviderFixtureScenario[];
  }
>;

export const ALEMBIC_PROVIDER_ROUTE_CONTRACTS = [
  route('I09', 'get', '/api-spec', 'getApiSpec', 'OpenAPI provider contract document', ['System']),
  route('I09', 'get', '/health', 'getHealth', 'Health check route family', ['System']),
  route(
    'I03',
    'get',
    '/daemon/health',
    'getDaemonHealth',
    'Runtime health and capability discovery',
    ['Runtime']
  ),
  route('I04', 'get', '/projects', 'listProjects', 'Project runtime snapshot and control family', [
    'Runtime',
  ]),
  route(
    'I04',
    'post',
    '/projects/{projectId}/switch',
    'switchProject',
    'Project runtime switch command',
    ['Runtime']
  ),
  route(
    'I05',
    'get',
    '/project-scope',
    'getProjectScope',
    'ProjectScope read/list/resolve family',
    ['Runtime']
  ),
  route('I06', 'get', '/jobs', 'listJobs', 'Job list and status family', ['Jobs']),
  route('I06', 'post', '/jobs/bootstrap', 'startBootstrapJob', 'Bootstrap job command', ['Jobs']),
  route('I06', 'post', '/jobs/rescan', 'startRescanJob', 'Rescan job command', ['Jobs']),
  route('I06', 'post', '/jobs/{jobId}/cancel', 'cancelJob', 'Job cancellation command', ['Jobs']),
  route(
    'I07',
    'get',
    '/jobs/{jobId}/events',
    'listJobProcessEvents',
    'Job process event recovery',
    ['Jobs', 'Events']
  ),
  route(
    'I08',
    'get',
    '/jobs/{jobId}/display-snapshot',
    'getJobDisplaySnapshot',
    'Job display snapshot',
    ['Jobs']
  ),
  route(
    'I08',
    'get',
    '/jobs/{jobId}/artifacts/{artifactId}',
    'getJobArtifact',
    'Job artifact read',
    ['Jobs']
  ),
  route(
    'I10',
    'post',
    '/decision-register',
    'createDecisionRegisterRecord',
    'Decision Register create',
    ['DecisionRegister']
  ),
  route(
    'I10',
    'get',
    '/decision-register/searchable',
    'searchDecisionRegister',
    'Decision Register searchable view',
    ['DecisionRegister']
  ),
  route('I11', 'post', '/intent-episodes', 'startIntentEpisode', 'Intent/work continuity start', [
    'Intent',
  ]),
  route(
    'I11',
    'patch',
    '/intent-episodes/{episodeId}',
    'updateIntentEpisode',
    'Intent/work continuity outcome',
    ['Intent']
  ),
  route('I21', 'post', '/guard', 'runGuard', 'Guard check route family', ['Guard']),
  route('I21', 'get', '/guard/report', 'getGuardReport', 'Guard report route family', ['Guard']),
  route('I21', 'get', '/rules', 'listGuardRules', 'Guard rules route family', ['Guard']),
  route('I21', 'get', '/violations', 'listViolations', 'Violations route family', ['Guard']),
  route('I22', 'get', '/knowledge', 'listKnowledge', 'Knowledge route family', ['Knowledge']),
  route('I22', 'get', '/recipes', 'listRecipes', 'Recipe route family', ['Knowledge']),
  route('I22', 'post', '/candidates/enrich', 'enrichCandidates', 'Candidate enrichment command', [
    'Knowledge',
  ]),
  route('I22', 'post', '/modules/scan', 'scanModules', 'Module scan command', ['Knowledge']),
  route('I22', 'post', '/wiki/generate', 'generateWiki', 'Wiki generation command', ['Knowledge']),
  route('I22', 'get', '/panorama', 'getPanorama', 'Panorama route family', ['Knowledge']),
  route(
    'I22',
    'get',
    '/evolution/proposals',
    'listEvolutionProposals',
    'Evolution proposal route family',
    ['Knowledge']
  ),
  route('I23', 'post', '/file-changes', 'submitFileChanges', 'File change diagnostic intake', [
    'Diagnostics',
  ]),
  route('I23', 'get', '/signals/trace', 'getSignalTrace', 'Signal trace diagnostic route', [
    'Diagnostics',
  ]),
  route('I23', 'get', '/audit', 'listAuditEntries', 'Audit route family', ['Diagnostics']),
  route('I23', 'get', '/monitoring/health', 'getMonitoringHealth', 'Monitoring health route', [
    'Diagnostics',
  ]),
  route('I23', 'get', '/logs', 'listLogs', 'Log route family', ['Diagnostics']),
] as const satisfies readonly AlembicProviderRouteContract[];

export const ALEMBIC_PROVIDER_ROUTE_MOUNTS = [
  mount('I09', '/api-spec'),
  mount('I09', '/api/v1/health'),
  mount('I03', '/api/v1/daemon'),
  mount('I06', '/api/v1/jobs'),
  mount('I04', '/api/v1/projects'),
  mount('I05', '/api/v1/project-scope'),
  mount('I09', '/api/v1/auth'),
  mount('I09', '/api/v1/auth/probe'),
  mount('I23', '/api/v1/monitoring'),
  mount('I21', '/api/v1/guard'),
  mount('I21', '/api/v1/guard/report'),
  mount('I21', '/api/v1/rules'),
  mount('I09', '/api/v1/task'),
  mount('I11', '/api/v1/intent-episodes'),
  mount('I10', '/api/v1/decision-register'),
  mount('I22', '/api/v1/search'),
  mount('I22', '/api/v1/ai'),
  mount('I22', '/api/v1/extract'),
  mount('I22', '/api/v1/commands'),
  mount('I22', '/api/v1/skills'),
  mount('I22', '/api/v1/candidates'),
  mount('I22', '/api/v1/modules'),
  mount('I21', '/api/v1/violations'),
  mount('I22', '/api/v1/knowledge'),
  mount('I22', '/api/v1/recipes'),
  mount('I22', '/api/v1/wiki'),
  mount('I22', '/api/v1/panorama'),
  mount('I22', '/api/v1/evolution'),
  mount('I23', '/api/v1/file-changes'),
  mount('I23', '/api/v1/signals'),
  mount('I23', '/api/v1/audit'),
  mount('I23', '/api/v1/logs'),
] as const satisfies readonly AlembicProviderRouteMount[];

export const ALEMBIC_PROVIDER_EVENT_CONTRACTS = [
  eventContract({
    contractId: 'I07.job-process-event.socket',
    eventName: 'job:process-event',
    fixtureIds: ['job-event.visible', 'job-event.partial'],
    registryRowId: 'I07',
    scenarios: ['success', 'partial'],
    transport: 'socket.io',
  }),
  eventContract({
    contractId: 'I07.job-process-event.recovery',
    eventName: 'job-process-events',
    fixtureIds: ['job-event.visible', 'job-event.partial'],
    registryRowId: 'I07',
    scenarios: ['success', 'partial'],
    transport: 'rest-recovery',
  }),
  eventContract({
    contractId: 'I22.ai-chat.sse',
    eventName: 'ai.chat.events',
    fixtureIds: ['sse.ai-chat.success', 'workflow.unavailable'],
    registryRowId: 'I22',
    scenarios: ['success', 'unavailable-runtime'],
    transport: 'sse',
  }),
  eventContract({
    contractId: 'I22.module-scan.sse',
    eventName: 'modules.scan.events',
    fixtureIds: ['sse.module-scan.success', 'workflow.unavailable'],
    registryRowId: 'I22',
    scenarios: ['success', 'unavailable-runtime'],
    transport: 'sse',
  }),
  eventContract({
    contractId: 'I22.candidate-refine.sse',
    eventName: 'candidates.refine-preview.events',
    fixtureIds: ['sse.candidate-refine.success', 'workflow.unavailable'],
    registryRowId: 'I22',
    scenarios: ['success', 'unavailable-runtime'],
    transport: 'sse',
  }),
  eventContract({
    contractId: 'I23.realtime-notification.socket',
    eventName:
      'candidate-created|candidate-status-changed|recipe-created|recipe-published|rule-created|rule-status-changed|token-usage-updated',
    fixtureIds: ['diagnostic.success'],
    registryRowId: 'I23',
    scenarios: ['success'],
    transport: 'socket.io',
  }),
] as const satisfies readonly AlembicProviderEventContract[];

export const ALEMBIC_PROVIDER_FIXTURES = [
  fixture('I03', 'I03.runtime-health.get', 'runtime-health.ready', 'success', {
    success: true,
    data: {
      mode: 'daemon',
      capabilities: {
        jobs: { available: true, processEvents: { available: true } },
        projectScope: { available: true },
      },
      residentService: { owner: 'alembic', route: 'local-alembic-daemon' },
    },
  }),
  fixture('I03', 'I03.runtime-health.get', 'runtime-health.partial', 'partial', {
    success: true,
    data: {
      mode: 'daemon',
      capabilities: {
        apiAi: { available: false, configSource: 'empty', provider: null },
        fileMonitor: {
          available: true,
          degraded: true,
          degradedReason: 'native watcher unavailable',
        },
      },
    },
  }),
  fixture('I03', 'I03.runtime-health.get', 'runtime-health.unavailable', 'unavailable-runtime', {
    success: false,
    error: { code: 'UNAVAILABLE_RUNTIME', message: 'Alembic daemon is not ready' },
  }),
  fixture('I04', 'I04.projects.get', 'project-runtime.success', 'success', {
    success: true,
    data: { state: { activeProjectId: 'project-alpha' }, projects: [{ id: 'project-alpha' }] },
  }),
  fixture('I04', 'I04.projects.get', 'project-runtime.conflict', 'failure', {
    success: false,
    data: { ok: false, error: 'Project is already switching', reasonCode: 'conflict' },
  }),
  fixture('I05', 'I05.project-scope.get', 'project-scope.success', 'success', {
    success: true,
    data: { projectScopeId: 'scope-alpha', folders: [{ id: 'src', label: 'src' }] },
  }),
  fixture('I05', 'I05.project-scope.get', 'project-scope.failure', 'failure', {
    success: false,
    error: { code: 'INVALID_INPUT', message: 'folder path is required' },
  }),
  fixture('I06', 'I06.jobs.get', 'jobs.queued', 'success', {
    success: true,
    data: { jobs: [{ id: 'job-bootstrap-1', kind: 'bootstrap', status: 'queued' }] },
  }),
  fixture('I06', 'I06.jobs.cancel.post', 'jobs.cancelled', 'cancelled', {
    success: true,
    data: { job: { id: 'job-bootstrap-1', status: 'cancelled', reasonCode: 'user-cancelled' } },
  }),
  fixture('I06', 'I06.jobs.get', 'jobs.unavailable', 'unavailable-runtime', {
    success: false,
    error: { code: 'UNAVAILABLE_RUNTIME', message: 'Job store unavailable' },
  }),
  fixture('I07', 'I07.job-events.get', 'job-event.visible', 'success', {
    jobId: 'job-bootstrap-1',
    event: {
      eventId: 'evt-1',
      sequence: 1,
      phase: 'bootstrap',
      sourceClass: 'developer-facing',
      displayPolicy: 'visible',
      content: { text: 'Indexed project files.' },
    },
  }),
  fixture('I07', 'I07.job-events.get', 'job-event.partial', 'partial', {
    jobId: 'job-bootstrap-1',
    retainedCount: 50,
    events: [],
    incompleteReason: 'event-retention-window',
  }),
  fixture('I08', 'I08.job-snapshot.get', 'job-snapshot.success', 'success', {
    success: true,
    data: {
      persisted: true,
      snapshot: { snapshotVersion: 1, jobId: 'job-bootstrap-1', artifacts: [] },
      validation: { valid: true, issues: [] },
    },
  }),
  fixture('I08', 'I08.job-artifact.get', 'job-artifact.missing', 'failure', {
    success: false,
    error: 'Artifact not found',
  }),
  fixture('I09', 'I09.api-spec.get', 'api-spec.success', 'success', {
    openapi: '3.0.0',
    info: { title: 'Alembic API', version: '2.0.0' },
  }),
  fixture('I09', 'I09.route.not-found', 'route.not-found', 'failure', {
    success: false,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  }),
  fixture('I10', 'I10.decision-register.post', 'decision-register.success', 'success', {
    success: true,
    data: { decision: { decisionId: 'decision-alpha', status: 'active' } },
  }),
  fixture('I10', 'I10.decision-register.post', 'decision-register.scope-mismatch', 'failure', {
    success: false,
    reasonCode: 'project-scope-mismatch',
    error: 'Decision scope does not match current Alembic workspace',
  }),
  fixture('I11', 'I11.intent-episodes.post', 'intent-episode.success', 'success', {
    success: true,
    data: { episode: { episodeId: 'intent-alpha', status: 'open' } },
  }),
  fixture('I11', 'I11.intent-episodes.patch', 'intent-episode.not-found', 'failure', {
    success: false,
    error: 'IntentEpisode not found',
  }),
  fixture('I21', 'I21.guard.post', 'guard.success', 'success', {
    success: true,
    data: { summary: { total: 1, errors: 0, warnings: 1 } },
  }),
  fixture('I21', 'I21.guard.post', 'guard.invalid-input', 'failure', {
    success: false,
    error: { code: 'INVALID_INPUT', message: 'code is required' },
  }),
  fixture('I22', 'I22.knowledge.get', 'knowledge.success', 'success', {
    success: true,
    data: { items: [{ id: 'knowledge-alpha', title: 'Boundary rule' }], total: 1 },
  }),
  fixture('I22', 'I22.workflow', 'workflow.unavailable', 'unavailable-runtime', {
    success: false,
    error: { code: 'UNAVAILABLE_RUNTIME', message: 'Provider capability is unavailable' },
  }),
  fixture('I22', 'I22.ai-chat.sse', 'sse.ai-chat.success', 'success', {
    event: 'message',
    data: { type: 'text_delta', text: 'Ready' },
  }),
  fixture('I22', 'I22.module-scan.sse', 'sse.module-scan.success', 'success', {
    event: 'message',
    data: { type: 'progress', completed: 1, total: 3 },
  }),
  fixture('I22', 'I22.candidate-refine.sse', 'sse.candidate-refine.success', 'success', {
    event: 'message',
    data: { type: 'preview', candidateId: 'candidate-alpha' },
  }),
  fixture('I23', 'I23.diagnostics.get', 'diagnostic.success', 'success', {
    success: true,
    data: { source: 'alembic-daemon', operation: 'diagnostic.read', detailRefs: [] },
  }),
  fixture('I23', 'I23.diagnostics.get', 'diagnostic.failure', 'failure', {
    success: false,
    error: { code: 'DIAGNOSTIC_UNAVAILABLE', message: 'Diagnostic source unavailable' },
  }),
] as const satisfies readonly AlembicProviderFixture[];

export const ALEMBIC_PROVIDER_COMPONENT_SCHEMAS = {
  SuccessEnvelope: dataEnvelope(objectSchema),
  ProblemEnvelope: problemSchema,
  RouteFamilyResponse: dataEnvelope(objectSchema),
  RouteFamilyListResponse: arrayDataEnvelope(objectSchema),
  ProviderEventMetadata: eventMetadataSchema,
  ProviderEventPayload: objectSchema,
} as const satisfies Readonly<Record<string, JsonSchema>>;

export function buildAlembicProviderOpenApiSpec() {
  return {
    openapi: '3.0.0',
    info: {
      title: 'Alembic API',
      description:
        'Alembic provider-owned REST, runtime, job, event, and diagnostic contracts generated from the checked provider contract manifest.',
      version: '2.0.0',
      contact: {
        name: 'Alembic Team',
        url: 'https://github.com/GxFn/Alembic',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000/api/v1',
        description: 'Development server',
      },
      {
        url: 'https://api.asd.dev/api/v1',
        description: 'Production server',
      },
    ],
    tags: uniqueStrings(ALEMBIC_PROVIDER_ROUTE_CONTRACTS.flatMap((contract) => contract.tags)).map(
      (name) => ({ name })
    ),
    paths: buildOpenApiPaths(ALEMBIC_PROVIDER_ROUTE_CONTRACTS),
    components: {
      schemas: ALEMBIC_PROVIDER_COMPONENT_SCHEMAS,
    },
    'x-alembic-provider-contract': {
      summary: summarizeAlembicProviderContracts(),
      routeMounts: ALEMBIC_PROVIDER_ROUTE_MOUNTS,
      events: ALEMBIC_PROVIDER_EVENT_CONTRACTS.map((event) => ({
        contractId: event.contractId,
        eventName: event.eventName,
        registryRowId: event.registryRowId,
        transport: event.transport,
      })),
    },
  };
}

export function summarizeAlembicProviderContracts(): AlembicProviderContractSummary {
  return {
    coreSpineVersion: CORE_CONTRACT_SPINE_VERSION,
    eventCount: ALEMBIC_PROVIDER_EVENT_CONTRACTS.length,
    fixtureCount: ALEMBIC_PROVIDER_FIXTURES.length,
    routeCount: ALEMBIC_PROVIDER_ROUTE_CONTRACTS.length,
    routeMountCount: ALEMBIC_PROVIDER_ROUTE_MOUNTS.length,
    rowIds: uniqueStrings([
      ...CORE_CONTRACT_SPINE_ROWS.map((row) => row.id).filter(isAlembicProviderRowId),
      ...ALEMBIC_PROVIDER_ROUTE_CONTRACTS.map((contract) => contract.registryRowId),
      ...ALEMBIC_PROVIDER_EVENT_CONTRACTS.map((contract) => contract.registryRowId),
    ]) as AlembicProviderRegistryRowId[],
    version: ALEMBIC_PROVIDER_CONTRACT_VERSION,
  };
}

function route(
  registryRowId: AlembicProviderRouteRowId,
  method: HttpMethod,
  path: string,
  operationId: string,
  summary: string,
  tags: readonly string[]
): AlembicProviderRouteContract {
  const row = routeRows[registryRowId];
  return {
    artifactPolicy: row.artifactPolicy,
    capabilityDiscovery: row.capabilityDiscovery,
    contractId: `${registryRowId}.${operationId}`,
    errorKinds: row.errorKinds,
    exposureClasses: row.exposureClasses,
    fixtureIds: row.fixtureIds,
    functionClass: functionClassFor(registryRowId),
    method,
    operationId,
    path,
    registryRowId,
    responseSchemas: responseSchemasFor(row.scenarios),
    summary,
    supportedScenarios: row.scenarios,
    tags,
  };
}

function mount(
  registryRowId: AlembicProviderRouteRowId,
  fullPath: string
): AlembicProviderRouteMount {
  return {
    fullPath,
    registryRowId,
    requiredBy: 'd3-provider-contract',
  };
}

function eventContract(options: {
  contractId: string;
  eventName: string;
  fixtureIds: readonly string[];
  registryRowId: AlembicProviderRegistryRowId;
  scenarios: readonly AlembicProviderFixtureScenario[];
  transport: AlembicProviderTransport;
}): AlembicProviderEventContract {
  return {
    contractId: options.contractId,
    eventName: options.eventName,
    fixtureIds: options.fixtureIds,
    metadataSchema: eventMetadataSchema,
    payloadSchema: objectSchema,
    registryRowId: options.registryRowId,
    supportedScenarios: options.scenarios,
    transport: options.transport,
  };
}

function fixture(
  registryRowId: AlembicProviderRegistryRowId,
  contractId: string,
  fixtureId: string,
  scenario: AlembicProviderFixtureScenario,
  payload: Record<string, unknown>
): AlembicProviderFixture {
  return { contractId, fixtureId, payload, registryRowId, scenario };
}

function responseSchemasFor(
  scenarios: readonly AlembicProviderFixtureScenario[]
): Readonly<Record<string, JsonSchema>> {
  const schemas: Record<string, JsonSchema> = {
    200: dataEnvelope(objectSchema),
  };
  if (scenarios.includes('success') && scenarios.includes('unavailable-runtime')) {
    schemas[503] = problemSchema;
  }
  if (scenarios.includes('failure')) {
    schemas[400] = problemSchema;
    schemas[404] = problemSchema;
    schemas[409] = problemSchema;
  }
  if (scenarios.includes('cancelled')) {
    schemas[409] = problemSchema;
  }
  if (scenarios.includes('partial')) {
    schemas[206] = dataEnvelope(objectSchema);
  }
  return schemas;
}

function functionClassFor(
  rowId: AlembicProviderRegistryRowId
): CoreContractFunctionClass | 'rest-command' {
  const coreRow = CORE_CONTRACT_SPINE_ROWS.find((row) => row.id === rowId);
  if (coreRow) {
    return coreRow.functionClass;
  }
  if (rowId === 'I09') {
    return 'rest-query';
  }
  return 'rest-command';
}

function buildOpenApiPaths(contracts: readonly AlembicProviderRouteContract[]) {
  const paths: Record<string, Partial<Record<HttpMethod, Record<string, unknown>>>> = {};
  for (const contract of contracts) {
    const pathItem = paths[contract.path] ?? {};
    pathItem[contract.method] = {
      operationId: contract.operationId,
      summary: contract.summary,
      tags: contract.tags,
      responses: Object.fromEntries(
        Object.entries(contract.responseSchemas).map(([status, schema]) => [
          status,
          {
            description: descriptionForStatus(status),
            content: {
              'application/json': {
                schema,
              },
            },
          },
        ])
      ),
      'x-alembic-contract': {
        artifactPolicy: contract.artifactPolicy,
        capabilityDiscovery: contract.capabilityDiscovery,
        contractId: contract.contractId,
        errorKinds: contract.errorKinds,
        exposureClasses: contract.exposureClasses,
        fixtureIds: contract.fixtureIds,
        functionClass: contract.functionClass,
        registryRowId: contract.registryRowId,
        supportedScenarios: contract.supportedScenarios,
      },
    };
    paths[contract.path] = pathItem;
  }
  return paths;
}

function descriptionForStatus(status: string): string {
  if (status === '200') {
    return 'Successful provider response.';
  }
  if (status === '206') {
    return 'Partial provider response with retained contract metadata.';
  }
  if (status === '503') {
    return 'Runtime or provider capability unavailable.';
  }
  return 'Structured provider problem response.';
}

function isAlembicProviderRowId(rowId: string): rowId is AlembicProviderRegistryRowId {
  return ['I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I21', 'I23'].includes(rowId);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
