import type {
  DashboardStrictTestDimensionOperationIdV1,
  DashboardStrictTestDimensionOperationMapV1,
  DashboardStrictTestEmptyQueryV1,
  DashboardStrictTestOrdinaryProblemV1,
  DashboardStrictTestPreflightPublicDtoV1,
  DashboardStrictTestPreflightRequestV1,
  DashboardStrictTestProblemDetailV1,
  DashboardStrictTestReportPublicDtoV1,
  DashboardStrictTestRunPathParametersV1,
  DashboardStrictTestRunRequestV1,
  DashboardStrictTestRunStatusPublicDtoV1,
  DashboardStrictTestStartProblemV1,
  DashboardStrictTestSuccessEnvelopeV1,
} from '../../lib/generated/dashboard-api-types.js';
import {
  validateDashboardStrictTestOperationRequest,
  validateDashboardStrictTestOperationResponse,
} from '../../lib/generated/dashboard-api-types.js';

const preflightRequest: DashboardStrictTestPreflightRequestV1 = {
  demandKey: 'demand-1',
  projectRoot: '/workspace/project',
  runId: 'run-1',
};
const runRequest: DashboardStrictTestRunRequestV1 = {
  demandKey: 'demand-1',
  preflightHash: `sha256:${'a'.repeat(64)}`,
  runId: 'run-1',
};
const pathParameters: DashboardStrictTestRunPathParametersV1 = { runId: 'run-1' };
const emptyQuery: DashboardStrictTestEmptyQueryV1 = {};

const preflightData: DashboardStrictTestPreflightPublicDtoV1 = {
  schemaVersion: 1,
  profile: 'strict-test-dimension',
  demandKey: 'demand-1',
  runId: 'run-1',
  phase: 'AUTOMATIC_SELECTION_READY',
  preflightHash: `sha256:${'a'.repeat(64)}`,
  previewHash: `sha256:${'b'.repeat(64)}`,
  canAutoSelect: true,
  recommendation: { dimensionId: 'architecture', reasonCode: 'backend-recommendation' },
  fullUniverse: {
    dimensionCount: 26,
    cellCount: 52,
    eligibleCellCount: 26,
    excludedCellCount: 26,
    fullCellUniverseHash: `sha256:${'c'.repeat(64)}`,
  },
};
const preflightResponse: DashboardStrictTestSuccessEnvelopeV1<DashboardStrictTestPreflightPublicDtoV1> =
  {
    success: true,
    data: preflightData,
  };

const statusData: DashboardStrictTestRunStatusPublicDtoV1 = {
  schemaVersion: 1,
  profile: 'strict-test-dimension',
  demandKey: 'demand-1',
  runId: 'run-1',
  phase: 'AUTOMATIC_SELECTION_READY',
  preflightHash: `sha256:${'a'.repeat(64)}`,
  automaticSelection: null,
  terminal: null,
  reportHash: null,
  evidenceRefs: [],
};

const problemDetail = {} as DashboardStrictTestProblemDetailV1;
const ordinaryProblem: DashboardStrictTestOrdinaryProblemV1 = {
  success: false,
  error: problemDetail,
};
const startProblem: DashboardStrictTestStartProblemV1 = {
  success: false,
  error: problemDetail,
  data: statusData,
};

type Operations = DashboardStrictTestDimensionOperationMapV1;
const operationId: DashboardStrictTestDimensionOperationIdV1 = 'preflightStrictTestDimension';
const startOperationRequest: Operations['startStrictTestDimensionRun']['request'] = {
  body: runRequest,
  pathParameters: {},
  query: emptyQuery,
};
const statusOperationRequest: Operations['getStrictTestDimensionRun']['request'] = {
  pathParameters,
  query: emptyQuery,
};
const acceptedStartResponse: Operations['startStrictTestDimensionRun']['responses'][202] = {
  success: true,
  data: statusData,
};

declare const reportData: DashboardStrictTestReportPublicDtoV1;
void reportData;

const callerSelectedDimension: DashboardStrictTestPreflightRequestV1 = {
  ...preflightRequest,
  // @ts-expect-error 调用者不得选择维度。
  dimension: 'architecture',
};
const productionOverride: DashboardStrictTestRunRequestV1 = {
  ...runRequest,
  // @ts-expect-error start 不能携带 production authority。
  strictProduction: {},
};
const getWithBody: Operations['getStrictTestDimensionRun']['request'] = {
  // @ts-expect-error GET operation 没有 request body。
  body: runRequest,
  pathParameters,
  query: emptyQuery,
};
const pathEscape: DashboardStrictTestRunPathParametersV1 = {
  runId: 'run-1',
  // @ts-expect-error path authority 只有 runId。
  privateRoot: '/private',
};
// @ts-expect-error exact empty query 不接受 caller switch。
const callerQuery: DashboardStrictTestEmptyQueryV1 = { testMode: 'true' };
// @ts-expect-error consumer DTO 必须 readonly。
preflightData.fullUniverse.dimensionCount = 1;
const ordinaryProblemWithData: DashboardStrictTestOrdinaryProblemV1 = {
  ...ordinaryProblem,
  // @ts-expect-error ordinary problem 不得携带 route-owned data。
  data: statusData,
};
const privateStartProblem: DashboardStrictTestStartProblemV1 = {
  ...startProblem,
  data: {
    ...statusData,
    // @ts-expect-error public problem data 不能泄露私有 runRoot。
    runRoot: '/private/run',
  },
};
// @ts-expect-error start 只声明 202/400/404/422。
const undeclaredStartStatus: Operations['startStrictTestDimensionRun']['responses'][200] =
  acceptedStartResponse;
// @ts-expect-error operation id 是封闭联合。
const unknownOperation: DashboardStrictTestDimensionOperationIdV1 = 'legacyBootstrap';

declare const unknownPreflightRequest: unknown;
if (
  validateDashboardStrictTestOperationRequest(
    'preflightStrictTestDimension',
    unknownPreflightRequest,
    { 'alembic-canonical-absolute-path-v1': () => true }
  )
) {
  const narrowedRequest: Operations['preflightStrictTestDimension']['request'] =
    unknownPreflightRequest;
  void narrowedRequest.body.projectRoot;
}

declare const unknownReportResponse: unknown;
if (
  validateDashboardStrictTestOperationResponse(
    'getStrictTestDimensionReport',
    200,
    unknownReportResponse
  )
) {
  const narrowedResponse: Operations['getStrictTestDimensionReport']['responses'][200] =
    unknownReportResponse;
  void narrowedResponse.data.reportHash;
}

void preflightResponse;
void ordinaryProblem;
void startOperationRequest;
void statusOperationRequest;
void acceptedStartResponse;
void operationId;
void callerSelectedDimension;
void productionOverride;
void getWithBody;
void pathEscape;
void callerQuery;
void ordinaryProblemWithData;
void privateStartProblem;
void undeclaredStartStatus;
void unknownOperation;
