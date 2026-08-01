import {
  CORE_CONTRACT_SPINE_ROWS,
  CORE_CONTRACT_SPINE_VERSION,
  CORE_FAILURE_PROBLEM_CLASSES,
  CORE_FAILURE_REF_POLICIES,
  CORE_FAILURE_RETRY_POLICIES,
  CORE_FAILURE_STATUSES,
  CORE_FAILURE_TAXONOMY,
  CORE_FAILURE_TAXONOMY_VERSION,
  CORE_FIELD_CLASSES,
  CORE_FIELD_FAILURE_KINDS,
  type CoreContractFunctionClass,
  type CoreContractSpineRowId,
  type CoreFieldFailureKind,
  getCoreFailureTaxonomyEntry,
} from '@alembic/core/shared';
import {
  STRICT_TEST_EMPTY_QUERY_JSON_SCHEMA,
  STRICT_TEST_PREFLIGHT_REQUEST_JSON_SCHEMA,
  STRICT_TEST_RUN_ID_JSON_SCHEMA,
  STRICT_TEST_RUN_REQUEST_JSON_SCHEMA,
} from '../recipe-pipeline/generate/strict/StrictTestRequestContracts.js';
import { buildAlembicHttpProblem } from './problem-taxonomy.js';

export const ALEMBIC_PROVIDER_CONTRACT_VERSION = 1;

export type AlembicProviderRegistryRowId = CoreContractSpineRowId | 'I09' | 'I22';
export type AlembicProviderRouteRowId = Exclude<AlembicProviderRegistryRowId, 'I01'>;
export type AlembicProviderFixtureScenario =
  | 'success'
  | 'failure'
  | 'unavailable-runtime'
  | CoreFieldFailureKind;
export type AlembicProviderTransport = 'http' | 'rest-recovery' | 'socket.io' | 'sse';
export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';
export type JsonSchema = {
  readonly [key: string]: unknown;
};

export interface AlembicProviderRouteContract {
  readonly artifactPolicy: string;
  readonly capabilityDiscovery: readonly string[];
  readonly contractId: string;
  readonly errorKinds: readonly CoreFieldFailureKind[];
  readonly exposureClasses: readonly string[];
  readonly fixtureIds: readonly string[];
  readonly functionClass: CoreContractFunctionClass | 'rest-command';
  readonly method: HttpMethod;
  readonly operationId: string;
  readonly path: string;
  readonly pathParameterSchemas: Readonly<Record<string, JsonSchema>>;
  readonly querySchema: JsonSchema | null;
  readonly registryRowId: AlembicProviderRegistryRowId;
  readonly requestBodySchema: JsonSchema | null;
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
  additionalProperties: false,
  properties: {
    success: { type: 'boolean' },
  },
} as const satisfies JsonSchema;

const jsonValueSchema = {
  // JSON integer 同时也是 number；使用 anyOf 才能让扩展点正确接受所有 JSON 值。
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'integer' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', items: {} },
    { type: 'object' },
  ],
} as const satisfies JsonSchema;

const refArraySchema = {
  type: 'array',
  items: { type: 'string' },
} as const satisfies JsonSchema;

const coreFailureStableIds = CORE_FAILURE_TAXONOMY.map((entry) => entry.stableId);
const coreFailureAgentBranches = uniqueStrings(
  CORE_FAILURE_TAXONOMY.map((entry) => entry.agentBranch)
);
const coreFailureMcpErrorCodes = CORE_FAILURE_TAXONOMY.map((entry) => entry.mcpErrorCode);

const problemDetailRequiredFields = [
  'agentBranch',
  'canonicalHttpStatus',
  'code',
  'dashboardState',
  'detailExposureClass',
  'exposureClass',
  'failureId',
  'failureStatus',
  'mcpErrorCode',
  'mcpStatus',
  'message',
  'privateDataSafe',
  'problemClass',
  'reasonCode',
  'refPolicy',
  'retryPolicy',
  'retryable',
  'status',
  'taxonomyVersion',
] as const;

const objectSchema = typedExtensionObjectSchema({
  consumer: 'Dashboard API adapter, Plugin resident client, and controller fixture replay',
  description:
    'Route-specific provider data. Consumers may only depend on fields declared by the owning route family or a named typed extension point.',
  exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
  name: 'provider.route-data',
  owner: 'Alembic provider route contract',
});

const problemDetailSchema = {
  type: 'object',
  required: problemDetailRequiredFields,
  additionalProperties: false,
  properties: {
    agentBranch: { enum: coreFailureAgentBranches },
    artifactRefs: refArraySchema,
    canonicalHttpStatus: { type: 'number' },
    code: { type: 'string' },
    dashboardState: { enum: CORE_FIELD_FAILURE_KINDS },
    detailExposureClass: { enum: CORE_FIELD_CLASSES },
    detailRefs: refArraySchema,
    exposureClass: { enum: CORE_FIELD_CLASSES },
    failureId: { enum: coreFailureStableIds },
    failureStatus: { enum: CORE_FAILURE_STATUSES },
    mcpErrorCode: { enum: coreFailureMcpErrorCodes },
    mcpStatus: { enum: CORE_FIELD_FAILURE_KINDS },
    message: { type: 'string' },
    privateDataSafe: { const: true },
    problemClass: { enum: CORE_FAILURE_PROBLEM_CLASSES },
    reasonCode: { enum: CORE_FIELD_FAILURE_KINDS },
    refPolicy: { enum: CORE_FAILURE_REF_POLICIES },
    retryPolicy: { enum: CORE_FAILURE_RETRY_POLICIES },
    retryable: { type: 'boolean' },
    status: { type: 'number' },
    taxonomyVersion: { const: CORE_FAILURE_TAXONOMY_VERSION },
  },
} as const satisfies JsonSchema;

const problemSchema = {
  type: 'object',
  required: ['success', 'error'],
  additionalProperties: false,
  properties: {
    data: typedExtensionObjectSchema({
      consumer: 'Dashboard action normalizer and Plugin resident diagnostics',
      description:
        'Optional route-owned failure context. The stable problem remains in error; data is limited to the route public projection.',
      exposureClasses: ['consumer-needed', 'diagnostic'],
      name: 'provider.problem-failure-data',
      owner: 'Alembic provider route contract',
    }),
    success: { const: false },
    error: problemDetailSchema,
  },
} as const satisfies JsonSchema;

/** strict-test 错误不继承 provider 通用任意 data 扩展；无持久失败投影时必须完全无 data。 */
const strictTestProblemWithoutDataSchema = {
  allOf: [problemSchema, { not: { required: ['data'] } }],
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
    required: ['success', 'data'],
    properties: {
      ...((envelopeBase.properties as Record<string, unknown>) ?? {}),
      data: dataSchema,
    },
  };
}

function strictTestSuccessEnvelope(dataSchema: JsonSchema): JsonSchema {
  return {
    type: 'object',
    required: ['success', 'data'],
    additionalProperties: false,
    properties: {
      success: { const: true },
      data: dataSchema,
    },
  };
}

const nonEmptyStringSchema = { type: 'string', minLength: 1 } as const satisfies JsonSchema;
const nullableStringSchema = {
  oneOf: [nonEmptyStringSchema, { type: 'null' }],
} as const satisfies JsonSchema;
const nonNegativeIntegerSchema = {
  type: 'integer',
  minimum: 0,
} as const satisfies JsonSchema;
const strictTestStringArraySchema = {
  type: 'array',
  items: nonEmptyStringSchema,
} as const satisfies JsonSchema;
const strictTestAutomaticSelectionSchema = {
  type: 'object',
  required: [
    'selectedDimensionId',
    'selectedCellIds',
    'selectedCellSetHash',
    'automaticSelectionHash',
    'projectionHash',
  ],
  additionalProperties: false,
  properties: {
    selectedDimensionId: nonEmptyStringSchema,
    selectedCellIds: strictTestStringArraySchema,
    selectedCellSetHash: nonEmptyStringSchema,
    automaticSelectionHash: nonEmptyStringSchema,
    projectionHash: nonEmptyStringSchema,
  },
} as const satisfies JsonSchema;
const strictTestTerminalSchema = {
  type: 'object',
  required: [
    'terminalState',
    'terminalHash',
    'failedStage',
    'errorCode',
    'productionFinalized',
    'publicRouteChanged',
  ],
  additionalProperties: false,
  properties: {
    terminalState: { enum: ['STRICT_TEST_COMPLETED_PRIVATE', 'STRICT_TEST_FAILED'] },
    terminalHash: nonEmptyStringSchema,
    failedStage: nullableStringSchema,
    errorCode: nullableStringSchema,
    productionFinalized: { const: false },
    publicRouteChanged: { const: false },
  },
} as const satisfies JsonSchema;
const strictTestPreflightPublicSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'profile',
    'demandKey',
    'runId',
    'phase',
    'preflightHash',
    'previewHash',
    'canAutoSelect',
    'recommendation',
    'fullUniverse',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    profile: { const: 'strict-test-dimension' },
    demandKey: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    phase: { const: 'AUTOMATIC_SELECTION_READY' },
    preflightHash: nonEmptyStringSchema,
    previewHash: nonEmptyStringSchema,
    canAutoSelect: { type: 'boolean' },
    recommendation: {
      type: 'object',
      required: ['dimensionId', 'reasonCode'],
      additionalProperties: false,
      properties: {
        dimensionId: nonEmptyStringSchema,
        reasonCode: nonEmptyStringSchema,
      },
    },
    fullUniverse: {
      type: 'object',
      required: [
        'dimensionCount',
        'cellCount',
        'eligibleCellCount',
        'excludedCellCount',
        'fullCellUniverseHash',
      ],
      additionalProperties: false,
      properties: {
        dimensionCount: nonNegativeIntegerSchema,
        cellCount: nonNegativeIntegerSchema,
        eligibleCellCount: nonNegativeIntegerSchema,
        excludedCellCount: nonNegativeIntegerSchema,
        fullCellUniverseHash: nonEmptyStringSchema,
      },
    },
  },
} as const satisfies JsonSchema;
const strictTestRunStatusPublicSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'profile',
    'demandKey',
    'runId',
    'phase',
    'preflightHash',
    'automaticSelection',
    'terminal',
    'reportHash',
    'evidenceRefs',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    profile: { const: 'strict-test-dimension' },
    demandKey: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    phase: {
      enum: [
        'AUTOMATIC_SELECTION_READY',
        'SELECTION_AUTO_SELECTED',
        'PRIVATE_WORKSPACE_READY',
        'STRICT_TEST_COMPLETED_PRIVATE',
        'STRICT_TEST_FAILED',
      ],
    },
    preflightHash: nonEmptyStringSchema,
    automaticSelection: {
      oneOf: [strictTestAutomaticSelectionSchema, { type: 'null' }],
    },
    terminal: { oneOf: [strictTestTerminalSchema, { type: 'null' }] },
    reportHash: nullableStringSchema,
    evidenceRefs: strictTestStringArraySchema,
  },
} as const satisfies JsonSchema;
const strictTestProblemWithStatusSchema = {
  type: 'object',
  required: ['success', 'error', 'data'],
  additionalProperties: false,
  properties: {
    success: { const: false },
    error: problemDetailSchema,
    data: strictTestRunStatusPublicSchema,
  },
} as const satisfies JsonSchema;
const strictTestStartProblemSchema = {
  oneOf: [strictTestProblemWithoutDataSchema, strictTestProblemWithStatusSchema],
} as const satisfies JsonSchema;
const strictTestReportPublicSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'profile',
    'demandKey',
    'runId',
    'terminalState',
    'terminalHash',
    'reportHash',
    'preflightHash',
    'automaticSelectionHash',
    'projectionHash',
    'fullUniverse',
    'executedProjection',
    'unexecutedDimensionIds',
    'failure',
    'evidenceRefs',
    'productionFinalized',
    'publicRouteChanged',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    profile: { const: 'strict-test-dimension' },
    demandKey: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    terminalState: { enum: ['STRICT_TEST_COMPLETED_PRIVATE', 'STRICT_TEST_FAILED'] },
    terminalHash: nonEmptyStringSchema,
    reportHash: nonEmptyStringSchema,
    preflightHash: nullableStringSchema,
    automaticSelectionHash: nullableStringSchema,
    projectionHash: nullableStringSchema,
    fullUniverse: {
      oneOf: [
        {
          type: 'object',
          required: [
            'dimensionCount',
            'cellCount',
            'eligibleCellCount',
            'excludedCellCount',
            'cellUniverseHash',
          ],
          additionalProperties: false,
          properties: {
            dimensionCount: nonNegativeIntegerSchema,
            cellCount: nonNegativeIntegerSchema,
            eligibleCellCount: nonNegativeIntegerSchema,
            excludedCellCount: nonNegativeIntegerSchema,
            cellUniverseHash: nonEmptyStringSchema,
          },
        },
        { type: 'null' },
      ],
    },
    executedProjection: {
      oneOf: [
        {
          type: 'object',
          required: ['dimensionId', 'cellCount', 'cellSetHash'],
          additionalProperties: false,
          properties: {
            dimensionId: nonEmptyStringSchema,
            cellCount: nonNegativeIntegerSchema,
            cellSetHash: nonEmptyStringSchema,
          },
        },
        { type: 'null' },
      ],
    },
    unexecutedDimensionIds: {
      oneOf: [strictTestStringArraySchema, { type: 'null' }],
    },
    failure: {
      oneOf: [
        {
          type: 'object',
          required: ['failedStage', 'errorCode'],
          additionalProperties: false,
          properties: {
            failedStage: nonEmptyStringSchema,
            errorCode: nonEmptyStringSchema,
          },
        },
        { type: 'null' },
      ],
    },
    evidenceRefs: strictTestStringArraySchema,
    productionFinalized: { const: false },
    publicRouteChanged: { const: false },
  },
} as const satisfies JsonSchema;

const strictTestPreflightResponseSchemas = {
  200: strictTestSuccessEnvelope(strictTestPreflightPublicSchema),
  400: strictTestProblemWithoutDataSchema,
  422: strictTestProblemWithoutDataSchema,
} as const satisfies Readonly<Record<string, JsonSchema>>;
const strictTestStartResponseSchemas = {
  202: strictTestSuccessEnvelope(strictTestRunStatusPublicSchema),
  400: strictTestProblemWithoutDataSchema,
  404: strictTestProblemWithoutDataSchema,
  422: strictTestStartProblemSchema,
} as const satisfies Readonly<Record<string, JsonSchema>>;
const strictTestStatusResponseSchemas = {
  200: strictTestSuccessEnvelope(strictTestRunStatusPublicSchema),
  400: strictTestProblemWithoutDataSchema,
  404: strictTestProblemWithoutDataSchema,
  422: strictTestProblemWithoutDataSchema,
} as const satisfies Readonly<Record<string, JsonSchema>>;
const strictTestReportResponseSchemas = {
  200: strictTestSuccessEnvelope(strictTestReportPublicSchema),
  400: strictTestProblemWithoutDataSchema,
  404: strictTestProblemWithoutDataSchema,
  409: strictTestProblemWithoutDataSchema,
  422: strictTestProblemWithoutDataSchema,
} as const satisfies Readonly<Record<string, JsonSchema>>;

const retrievalReadinessDiagnosticSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: { type: 'string' },
    field: { type: 'string' },
    message: { type: 'string' },
    provenanceRefs: refArraySchema,
  },
} as const satisfies JsonSchema;

const retrievalReadinessWarningSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
} as const satisfies JsonSchema;

const retrievalReadinessReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ready', 'schemaVersion', 'profileHash', 'documentSetHash', 'violations', 'warnings'],
  properties: {
    ready: { type: 'boolean' },
    schemaVersion: { type: 'string' },
    profileHash: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    documentSetHash: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    violations: { type: 'array', items: retrievalReadinessDiagnosticSchema },
    warnings: { type: 'array', items: retrievalReadinessWarningSchema },
  },
} as const satisfies JsonSchema;

function arrayDataEnvelope(itemSchema: JsonSchema): JsonSchema {
  return dataEnvelope({
    type: 'object',
    additionalProperties: false,
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
    errorKinds: ['unavailable', 'capability-mismatch', 'degraded', 'internal-error'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['runtime-health.ready', 'runtime-health.partial', 'runtime-health.unavailable'],
    scenarios: ['success', 'partial', 'unavailable-runtime'],
  },
  I04: {
    artifactPolicy: 'Project runtime summary inline; diagnostics by detailRef.',
    capabilityDiscovery: ['GET /api/v1/daemon/health', 'GET /api/v1/projects/status'],
    errorKinds: ['conflict', 'timeout', 'cancelled', 'not-found', 'internal-error'],
    exposureClasses: ['consumer-needed', 'diagnostic'],
    fixtureIds: ['project-runtime.success', 'project-runtime.conflict', 'project-runtime.timeout'],
    scenarios: ['success', 'conflict', 'timeout'],
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
    fixtureIds: ['jobs.queued', 'jobs.cancelled', 'jobs.cancelled-problem', 'jobs.unavailable'],
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
    errorKinds: ['not-found', 'schema-drift', 'internal-error'],
    exposureClasses: ['public', 'developer-facing', 'diagnostic', 'sensitive'],
    fixtureIds: ['job-snapshot.success', 'job-artifact.missing'],
    scenarios: ['success', 'not-found'],
  },
  I09: {
    artifactPolicy: 'Route summaries inline; long reports/logs via artifact routes.',
    capabilityDiscovery: ['/api-spec', '/api/v1/daemon/health'],
    errorKinds: ['invalid-input', 'permission-denied', 'unavailable', 'timeout', 'not-found'],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: ['api-spec.success', 'route.not-found', 'route.permission-denied'],
    scenarios: ['success', 'not-found', 'permission-denied'],
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
    artifactPolicy:
      'Workflow and resident search summaries inline; reports/snapshots by artifactRef and degraded resident search state by canonical degraded telemetry.',
    capabilityDiscovery: ['/api/v1/knowledge', '/api/v1/modules', '/api/v1/candidates'],
    errorKinds: [
      'invalid-input',
      'unavailable',
      'timeout',
      'not-found',
      'degraded',
      'partial',
      'capability-mismatch',
      'provider-error',
      'host-failure',
      'internal-error',
    ],
    exposureClasses: ['public', 'consumer-needed', 'diagnostic'],
    fixtureIds: [
      'knowledge.success',
      'search.success',
      'search.degraded',
      'workflow.unavailable',
      'workflow.degraded',
      'workflow.partial',
      'workflow.capability-mismatch',
      'workflow.provider-error',
      'workflow.host-failure',
      'workflow.internal-error',
    ],
    scenarios: [
      'success',
      'unavailable-runtime',
      'degraded',
      'partial',
      'capability-mismatch',
      'provider-error',
      'host-failure',
      'internal-error',
    ],
  },
  I23: {
    artifactPolicy: 'Diagnostic summaries inline; logs and reports as detailRef.',
    capabilityDiscovery: ['runtime health fileMonitor capability', 'diagnostic routes'],
    errorKinds: [
      'invalid-input',
      'unavailable',
      'permission-denied',
      'not-found',
      'internal-error',
    ],
    exposureClasses: ['diagnostic', 'internal', 'consumer-needed', 'sensitive'],
    fixtureIds: ['diagnostic.success', 'diagnostic.failure', 'diagnostic.internal-error'],
    scenarios: ['success', 'unavailable-runtime', 'internal-error'],
  },
} as const satisfies Record<
  AlembicProviderRouteRowId,
  {
    readonly artifactPolicy: string;
    readonly capabilityDiscovery: readonly string[];
    readonly errorKinds: readonly CoreFieldFailureKind[];
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
    'I22',
    'post',
    '/strict-test-dimension/preflight',
    'preflightStrictTestDimension',
    'Freeze the strict-test full-universe preflight authority',
    ['Knowledge', 'Strict Test'],
    {
      querySchema: STRICT_TEST_EMPTY_QUERY_JSON_SCHEMA,
      requestBodySchema: STRICT_TEST_PREFLIGHT_REQUEST_JSON_SCHEMA,
      responseSchemas: strictTestPreflightResponseSchemas,
    }
  ),
  route(
    'I22',
    'post',
    '/strict-test-dimension/runs',
    'startStrictTestDimensionRun',
    'Automatically select and start one private strict-test dimension run',
    ['Knowledge', 'Strict Test'],
    {
      querySchema: STRICT_TEST_EMPTY_QUERY_JSON_SCHEMA,
      requestBodySchema: STRICT_TEST_RUN_REQUEST_JSON_SCHEMA,
      responseSchemas: strictTestStartResponseSchemas,
    }
  ),
  route(
    'I22',
    'get',
    '/strict-test-dimension/runs/{runId}',
    'getStrictTestDimensionRun',
    'Read durable strict-test phase and terminal state',
    ['Knowledge', 'Strict Test'],
    {
      pathParameterSchemas: { runId: STRICT_TEST_RUN_ID_JSON_SCHEMA },
      querySchema: STRICT_TEST_EMPTY_QUERY_JSON_SCHEMA,
      responseSchemas: strictTestStatusResponseSchemas,
    }
  ),
  route(
    'I22',
    'get',
    '/strict-test-dimension/runs/{runId}/report',
    'getStrictTestDimensionReport',
    'Read the durable canonical strict-test audit report',
    ['Knowledge', 'Strict Test'],
    {
      pathParameterSchemas: { runId: STRICT_TEST_RUN_ID_JSON_SCHEMA },
      querySchema: STRICT_TEST_EMPTY_QUERY_JSON_SCHEMA,
      responseSchemas: strictTestReportResponseSchemas,
    }
  ),
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
  route('I21', 'post', '/guard', 'runGuard', 'Guard check route family', ['Guard']),
  route('I21', 'get', '/rules', 'listGuardRules', 'Guard rules route family', ['Guard']),
  route('I21', 'get', '/violations', 'listViolations', 'Violations route family', ['Guard']),
  route('I22', 'get', '/knowledge', 'listKnowledge', 'Knowledge route family', ['Knowledge']),
  route(
    'I22',
    'get',
    '/knowledge/{knowledgeId}/retrieval-readiness',
    'getKnowledgeRetrievalReadiness',
    'Read-only Core Recipe retrieval readiness report',
    ['Knowledge'],
    {
      dataSchema: retrievalReadinessReportSchema,
      fixtureIds: [
        'knowledge-readiness.native',
        'knowledge-readiness.compatibility',
        'knowledge-readiness.blocked',
        'knowledge-readiness.runtime-warnings',
        'knowledge-readiness.not-found',
      ],
      functionClass: 'rest-query',
    }
  ),
  route('I22', 'get', '/search', 'searchKnowledge', 'Resident search query', ['Knowledge']),
  route('I22', 'post', '/search', 'searchKnowledgeWithHostIntent', 'Resident search command', [
    'Knowledge',
  ]),
  route('I22', 'get', '/recipes', 'listRecipes', 'Recipe route family', ['Knowledge']),
  // POST /candidates/enrich (I22) deleted in the Train B DCR wave (P0 all-delete
  // verdict, zero external consumers).
  route('I22', 'post', '/modules/scan', 'scanModules', 'Module scan command', ['Knowledge']),
  route(
    'I22',
    'get',
    '/commands/recipe-index-generation',
    'getRecipeIndexGeneration',
    'Recipe vector generation status',
    ['Knowledge', 'Commands']
  ),
  route(
    'I22',
    'post',
    '/commands/recipe-index-generation/dry-run',
    'previewRecipeIndexGeneration',
    'Preview Recipe vector generation without writes',
    ['Knowledge', 'Commands']
  ),
  route(
    'I22',
    'post',
    '/commands/recipe-index-generation/rebuild',
    'rebuildRecipeIndexGeneration',
    'Build, verify, and atomically activate a Recipe vector generation',
    ['Knowledge', 'Commands']
  ),
  route(
    'I22',
    'post',
    '/commands/recipe-index-generation/rollback',
    'rollbackRecipeIndexGeneration',
    'Roll back active Recipe vector generation',
    ['Knowledge', 'Commands']
  ),
  route('I22', 'get', '/panorama', 'getPanoramaOverview', 'Panorama overview route family', [
    'Knowledge',
    'Panorama',
  ]),
  route('I22', 'get', '/panorama/health', 'getPanoramaHealth', 'Panorama health route family', [
    'Knowledge',
    'Panorama',
  ]),
  route('I22', 'get', '/panorama/gaps', 'getPanoramaGaps', 'Panorama gaps route family', [
    'Knowledge',
    'Panorama',
  ]),
  route('I22', 'post', '/wiki/generate', 'generateWiki', 'Wiki generation command', ['Knowledge']),
  route('I22', 'get', '/governance', 'getGovernance', 'Governance route family', ['Knowledge']),
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
  route('I23', 'get', '/logs', 'listLogs', 'Log route family', ['Diagnostics']),
] as const satisfies readonly AlembicProviderRouteContract[];

export const ALEMBIC_PROVIDER_ROUTE_MOUNTS = [
  mount('I09', '/api-spec'),
  mount('I09', '/api/v1/health'),
  mount('I03', '/api/v1/daemon'),
  mount('I06', '/api/v1/jobs'),
  mount('I22', '/api/v1/strict-test-dimension'),
  mount('I04', '/api/v1/projects'),
  mount('I05', '/api/v1/project-scope'),
  mount('I09', '/api/v1/auth/probe'),
  mount('I21', '/api/v1/guard'),
  mount('I21', '/api/v1/rules'),
  mount('I22', '/api/v1/search'),
  mount('I22', '/api/v1/ai'),
  mount('I22', '/api/v1/extract'),
  mount('I22', '/api/v1/commands'),
  mount('I22', '/api/v1/skills'),
  mount('I22', '/api/v1/candidates'),
  mount('I22', '/api/v1/modules'),
  mount('I22', '/api/v1/panorama'),
  mount('I21', '/api/v1/violations'),
  mount('I22', '/api/v1/knowledge'),
  mount('I22', '/api/v1/recipes'),
  mount('I22', '/api/v1/wiki'),
  mount('I22', '/api/v1/governance'),
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
    error: providerProblem('UNAVAILABLE_RUNTIME', 'Alembic daemon is not ready', 'unavailable', {
      retryable: true,
      status: 503,
    }),
  }),
  fixture('I04', 'I04.projects.get', 'project-runtime.success', 'success', {
    success: true,
    data: { state: { activeProjectId: 'project-alpha' }, projects: [{ id: 'project-alpha' }] },
  }),
  fixture('I04', 'I04.projects.get', 'project-runtime.conflict', 'conflict', {
    success: false,
    data: { action: 'switch', error: 'Project is already switching', ok: false },
    error: providerProblem('PROJECT_RUNTIME_CONFLICT', 'Project is already switching', 'conflict', {
      status: 409,
    }),
  }),
  fixture('I04', 'I04.projects.start.post', 'project-runtime.timeout', 'timeout', {
    success: false,
    data: { action: 'start', error: 'Target daemon did not become ready', ok: false },
    error: providerProblem(
      'PROJECT_RUNTIME_TIMEOUT',
      'Target daemon did not become ready',
      'timeout',
      {
        retryable: true,
        status: 504,
      }
    ),
  }),
  fixture('I05', 'I05.project-scope.get', 'project-scope.success', 'success', {
    success: true,
    data: { projectScopeId: 'scope-alpha', folders: [{ id: 'src', label: 'src' }] },
  }),
  fixture('I05', 'I05.project-scope.get', 'project-scope.failure', 'failure', {
    success: false,
    error: providerProblem('INVALID_INPUT', 'folder path is required', 'invalid-input', {
      status: 400,
    }),
  }),
  fixture('I06', 'I06.jobs.get', 'jobs.queued', 'success', {
    success: true,
    data: { jobs: [{ id: 'job-bootstrap-1', kind: 'bootstrap', status: 'queued' }] },
  }),
  fixture('I06', 'I06.jobs.cancel.post', 'jobs.cancelled', 'cancelled', {
    success: true,
    data: { job: { id: 'job-bootstrap-1', status: 'cancelled', reasonCode: 'user-cancelled' } },
  }),
  fixture('I06', 'I06.jobs.cancel.post', 'jobs.cancelled-problem', 'cancelled', {
    success: false,
    error: providerProblem('JOB_CANCELLED', 'Bootstrap job was cancelled', 'cancelled', {
      status: 409,
    }),
  }),
  fixture('I06', 'I06.jobs.get', 'jobs.unavailable', 'unavailable-runtime', {
    success: false,
    error: providerProblem('UNAVAILABLE_RUNTIME', 'Job store unavailable', 'unavailable', {
      retryable: true,
      status: 503,
    }),
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
  fixture('I08', 'I08.job-artifact.get', 'job-artifact.missing', 'not-found', {
    success: false,
    error: providerProblem('ARTIFACT_MISSING', 'Artifact not found', 'not-found', {
      artifactRefs: ['artifact://job-bootstrap-1/missing-report'],
      status: 404,
    }),
  }),
  fixture('I09', 'I09.api-spec.get', 'api-spec.success', 'success', {
    openapi: '3.0.0',
    info: { title: 'Alembic API', version: '2.0.0' },
  }),
  fixture('I09', 'I09.route.not-found', 'route.not-found', 'not-found', {
    success: false,
    error: providerProblem('NOT_FOUND', 'Route not found', 'not-found', { status: 404 }),
  }),
  fixture('I09', 'I09.route.permission-denied', 'route.permission-denied', 'permission-denied', {
    success: false,
    error: providerProblem('PERMISSION_DENIED', 'Permission denied', 'permission-denied', {
      status: 403,
    }),
  }),
  fixture('I21', 'I21.guard.post', 'guard.success', 'success', {
    success: true,
    data: { summary: { total: 1, errors: 0, warnings: 1 } },
  }),
  fixture('I21', 'I21.guard.post', 'guard.invalid-input', 'failure', {
    success: false,
    error: providerProblem('INVALID_INPUT', 'code is required', 'invalid-input', { status: 400 }),
  }),
  fixture('I22', 'I22.knowledge.get', 'knowledge.success', 'success', {
    success: true,
    data: { items: [{ id: 'knowledge-alpha', title: 'Boundary rule' }], total: 1 },
  }),
  fixture('I22', 'I22.getKnowledgeRetrievalReadiness', 'knowledge-readiness.native', 'success', {
    success: true,
    data: {
      ready: true,
      schemaVersion: '1',
      profileHash: 'profile-hash-native',
      documentSetHash: 'document-set-hash-native',
      violations: [],
      warnings: [],
    },
  }),
  fixture(
    'I22',
    'I22.getKnowledgeRetrievalReadiness',
    'knowledge-readiness.compatibility',
    'success',
    {
      success: true,
      data: {
        ready: false,
        schemaVersion: '1',
        profileHash: null,
        documentSetHash: null,
        violations: [
          {
            code: 'retrieval.profile.missing',
            field: 'retrievalProfile',
            message: 'A native retrieval profile is required before active publish.',
          },
        ],
        warnings: [],
      },
    }
  ),
  fixture('I22', 'I22.getKnowledgeRetrievalReadiness', 'knowledge-readiness.blocked', 'success', {
    success: true,
    data: {
      ready: false,
      schemaVersion: '1',
      profileHash: 'profile-hash-incomplete',
      documentSetHash: 'document-set-hash-incomplete',
      violations: [
        {
          code: 'retrieval.profile.primary-summary-missing',
          field: 'retrievalProfile.summary.primary',
          message: 'Primary-language retrieval summary is required.',
        },
      ],
      warnings: [],
    },
  }),
  fixture(
    'I22',
    'I22.getKnowledgeRetrievalReadiness',
    'knowledge-readiness.runtime-warnings',
    'success',
    {
      success: true,
      data: {
        ready: true,
        schemaVersion: '1',
        profileHash: 'profile-hash-native',
        documentSetHash: 'document-set-hash-native',
        violations: [],
        warnings: [
          {
            code: 'retrieval.provider.unavailable',
            message: 'Embedding provider is unavailable; truth readiness is unchanged.',
          },
          {
            code: 'retrieval.vector-store.unavailable',
            message: 'Vector storage is unavailable; truth readiness is unchanged.',
          },
          {
            code: 'retrieval.index.pending',
            message: 'Vector generation is pending; publish readiness is unchanged.',
          },
          {
            code: 'retrieval.ranking.metrics-missing',
            message: 'Ranking metrics are unavailable; truth readiness is unchanged.',
          },
        ],
      },
    }
  ),
  fixture(
    'I22',
    'I22.getKnowledgeRetrievalReadiness',
    'knowledge-readiness.not-found',
    'not-found',
    {
      success: false,
      error: providerProblem('NOT_FOUND', 'Knowledge entry not found', 'not-found', {
        status: 404,
      }),
    }
  ),
  fixture('I22', 'I22.search.get', 'search.success', 'success', {
    success: true,
    data: {
      query: 'decision register scope',
      items: [{ id: 'knowledge-alpha', kind: 'pattern', title: 'Boundary rule' }],
      searchMeta: {
        actualMode: 'keyword',
        appliedFilters: { language: 'typescript' },
        semanticUsed: false,
        vectorUsed: false,
      },
    },
  }),
  fixture('I22', 'I22.search.get', 'search.degraded', 'degraded', {
    success: true,
    data: {
      query: 'decision register scope',
      totalResults: 0,
      searchMeta: {
        actualMode: 'legacy-fallback',
        appliedFilters: {},
        degraded: true,
        degradedReason:
          'SearchEngine unavailable; resident service used legacy non-vector fallback',
        residentVector: {
          available: false,
          endpoint: '/api/v1/search',
          reason: 'SearchEngine unavailable; vector route was not attempted',
          stats: null,
        },
        semanticUsed: false,
        vectorUsed: false,
      },
    },
  }),
  fixture('I22', 'I22.workflow', 'workflow.unavailable', 'unavailable-runtime', {
    success: false,
    error: providerProblem(
      'UNAVAILABLE_RUNTIME',
      'Provider capability is unavailable',
      'unavailable',
      {
        retryable: true,
        status: 503,
      }
    ),
  }),
  fixture('I22', 'I22.workflow', 'workflow.degraded', 'degraded', {
    success: false,
    error: providerProblem('WORKFLOW_DEGRADED', 'Workflow capability is degraded', 'degraded', {
      detailRefs: ['diagnostics://workflow/degraded'],
      retryable: true,
      status: 503,
    }),
  }),
  fixture('I22', 'I22.workflow', 'workflow.partial', 'partial', {
    success: false,
    error: providerProblem('WORKFLOW_PARTIAL', 'Workflow returned a partial result', 'partial', {
      artifactRefs: ['artifact://workflow/partial-result'],
      retryable: true,
      status: 206,
    }),
  }),
  fixture('I22', 'I22.workflow', 'workflow.capability-mismatch', 'capability-mismatch', {
    success: false,
    error: providerProblem(
      'CAPABILITY_MISMATCH',
      'Provider route does not support the requested capability',
      'capability-mismatch',
      { detailRefs: ['diagnostics://workflow/capability-mismatch'], status: 501 }
    ),
  }),
  fixture('I22', 'I22.workflow', 'workflow.provider-error', 'provider-error', {
    success: false,
    error: providerProblem(
      'PROVIDER_ERROR',
      'Upstream provider returned an error',
      'provider-error',
      {
        detailRefs: ['diagnostics://provider/error-redacted'],
        retryable: true,
        status: 502,
      }
    ),
  }),
  fixture('I22', 'I22.workflow', 'workflow.host-failure', 'host-failure', {
    success: false,
    error: providerProblem('HOST_FAILURE', 'Host runtime failed the workflow', 'host-failure', {
      detailRefs: ['diagnostics://host/failure-redacted'],
      status: 424,
    }),
  }),
  fixture('I22', 'I22.workflow', 'workflow.internal-error', 'internal-error', {
    success: false,
    error: providerProblem('INTERNAL_ERROR', 'Workflow failed internally', 'internal-error', {
      detailRefs: ['diagnostics://workflow/internal-error'],
      status: 500,
    }),
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
  fixture('I23', 'I23.diagnostics.get', 'diagnostic.failure', 'unavailable-runtime', {
    success: false,
    error: providerProblem(
      'DIAGNOSTIC_UNAVAILABLE',
      'Diagnostic source unavailable',
      'unavailable',
      {
        retryable: true,
        status: 503,
      }
    ),
  }),
  fixture('I23', 'I23.diagnostics.get', 'diagnostic.internal-error', 'internal-error', {
    success: false,
    error: providerProblem(
      'DIAGNOSTIC_INTERNAL_ERROR',
      'Diagnostic route failed',
      'internal-error',
      {
        detailRefs: ['diagnostics://route/internal-error'],
        status: 500,
      }
    ),
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
  tags: readonly string[],
  options: {
    dataSchema?: JsonSchema;
    fixtureIds?: readonly string[];
    functionClass?: CoreContractFunctionClass | 'rest-command';
    pathParameterSchemas?: Readonly<Record<string, JsonSchema>>;
    querySchema?: JsonSchema;
    requestBodySchema?: JsonSchema;
    responseSchemas?: Readonly<Record<string, JsonSchema>>;
  } = {}
): AlembicProviderRouteContract {
  const row = routeRows[registryRowId];
  return {
    artifactPolicy: row.artifactPolicy,
    capabilityDiscovery: row.capabilityDiscovery,
    contractId: `${registryRowId}.${operationId}`,
    errorKinds: row.errorKinds,
    exposureClasses: row.exposureClasses,
    fixtureIds: options.fixtureIds ?? row.fixtureIds,
    functionClass: options.functionClass ?? functionClassFor(registryRowId),
    method,
    operationId,
    path,
    pathParameterSchemas: options.pathParameterSchemas ?? Object.freeze({}),
    querySchema: options.querySchema ?? null,
    registryRowId,
    requestBodySchema: options.requestBodySchema ?? null,
    responseSchemas:
      options.responseSchemas ??
      Object.freeze({
        ...responseSchemasFor(row.errorKinds, row.scenarios),
        ...(options.dataSchema ? { 200: dataEnvelope(options.dataSchema) } : {}),
      }),
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
  errorKinds: readonly CoreFieldFailureKind[],
  scenarios: readonly AlembicProviderFixtureScenario[]
): Readonly<Record<string, JsonSchema>> {
  const schemas: Record<string, JsonSchema> = {
    200: dataEnvelope(objectSchema),
  };
  for (const errorKind of errorKinds) {
    schemas[providerStatusForFailureKind(errorKind)] = problemSchema;
  }
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
  if (scenarios.includes('conflict')) {
    schemas[409] = problemSchema;
  }
  if (scenarios.includes('not-found')) {
    schemas[404] = problemSchema;
  }
  if (scenarios.includes('permission-denied')) {
    schemas[403] = problemSchema;
  }
  if (scenarios.includes('timeout')) {
    schemas[504] = problemSchema;
  }
  if (scenarios.includes('partial') && !errorKinds.includes('partial')) {
    schemas[206] = dataEnvelope(objectSchema);
  }
  return schemas;
}

function providerStatusForFailureKind(errorKind: CoreFieldFailureKind): number {
  switch (errorKind) {
    case 'cancelled':
      return 409;
    case 'timeout':
      return 504;
    default:
      return getCoreFailureTaxonomyEntry(errorKind).httpStatus;
  }
}

function typedExtensionObjectSchema(options: {
  consumer: string;
  description: string;
  exposureClasses: readonly string[];
  name: string;
  owner: string;
}): JsonSchema {
  return {
    type: 'object',
    additionalProperties: jsonValueSchema,
    description: options.description,
    'x-alembic-extension-point': {
      consumer: options.consumer,
      exposureClasses: options.exposureClasses,
      name: options.name,
      owner: options.owner,
      schemaClosurePolicy: 'typed-extension',
    },
  };
}

function providerProblem(
  code: string,
  message: string,
  reasonCode: CoreFieldFailureKind,
  options: {
    artifactRefs?: readonly string[];
    detailRefs?: readonly string[];
    retryable?: boolean;
    status?: number;
  }
) {
  return buildAlembicHttpProblem(code, message, reasonCode, options);
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
      ...(contract.requestBodySchema
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: contract.requestBodySchema },
              },
            },
          }
        : {}),
      ...(Object.keys(contract.pathParameterSchemas).length > 0
        ? {
            parameters: Object.entries(contract.pathParameterSchemas).map(([name, schema]) => ({
              in: 'path',
              name,
              required: true,
              schema,
            })),
          }
        : {}),
      ...(contract.querySchema ? { 'x-alembic-query-schema': contract.querySchema } : {}),
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
        ...(Object.keys(contract.pathParameterSchemas).length > 0
          ? { pathParameterSchemas: contract.pathParameterSchemas }
          : {}),
        ...(contract.querySchema ? { querySchema: contract.querySchema } : {}),
        registryRowId: contract.registryRowId,
        ...(contract.requestBodySchema ? { requestBodySchema: contract.requestBodySchema } : {}),
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
