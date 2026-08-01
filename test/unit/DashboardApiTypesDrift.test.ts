/**
 * IC2 Alembic-side drift gate (runs inside npm run check via test:unit):
 * regenerate the Dashboard api-types artifact and byte-compare it with the
 * committed text. Any change to the inputs (Core wire types, failure
 * taxonomy, provider-contracts route table, problem projection) without a
 * regenerated commit fails here.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DASHBOARD_API_INPUT_SCHEMAS,
  DASHBOARD_API_ROUTES,
  validateDashboardStrictTestOperationRequest,
  validateDashboardStrictTestOperationResponse,
} from '../../lib/generated/dashboard-api-types.js';
import { buildAlembicHttpProblem } from '../../lib/http/problem-taxonomy.js';
import {
  STRICT_TEST_CANONICAL_ABSOLUTE_PATH_FORMAT,
  STRICT_TEST_INPUT_STRING_FORMAT_VALIDATORS,
} from '../../lib/recipe-pipeline/generate/strict/StrictTestRequestContracts.js';
import {
  DASHBOARD_TYPES_ARTIFACT_RELPATH,
  generateDashboardApiTypes,
} from '../../scripts/generate-dashboard-types.js';

describe('Dashboard api-types drift gate (IC2)', () => {
  test('committed artifact matches regenerated output byte-for-byte', () => {
    const repoRoot = process.cwd();
    const artifactPath = path.join(repoRoot, DASHBOARD_TYPES_ARTIFACT_RELPATH);
    const committed = readFileSync(artifactPath, 'utf8');
    const regenerated = generateDashboardApiTypes(repoRoot);
    expect(committed.length).toBe(regenerated.length);
    expect(committed).toBe(regenerated);
  });

  test('generated strict-test routes retain the exact provider status matrix', () => {
    const expectedStatuses = {
      preflightStrictTestDimension: ['200', '400', '422'],
      startStrictTestDimensionRun: ['202', '400', '404', '422'],
      getStrictTestDimensionRun: ['200', '400', '404', '422'],
      getStrictTestDimensionReport: ['200', '400', '404', '409', '422'],
    } as const;

    for (const [operationId, statuses] of Object.entries(expectedStatuses)) {
      const route = DASHBOARD_API_ROUTES.find((candidate) => candidate.operationId === operationId);
      expect(Object.keys(route?.responseSchemas ?? {}).sort()).toEqual([...statuses].sort());
    }
  });

  test('generated strict-test routes retain closed request, path, and query schema metadata', () => {
    const preflight = DASHBOARD_API_ROUTES.find(
      (candidate) => candidate.operationId === 'preflightStrictTestDimension'
    );
    const start = DASHBOARD_API_ROUTES.find(
      (candidate) => candidate.operationId === 'startStrictTestDimensionRun'
    );
    const status = DASHBOARD_API_ROUTES.find(
      (candidate) => candidate.operationId === 'getStrictTestDimensionRun'
    );
    const report = DASHBOARD_API_ROUTES.find(
      (candidate) => candidate.operationId === 'getStrictTestDimensionReport'
    );

    expect(DASHBOARD_API_INPUT_SCHEMAS[preflight?.requestBodySchema ?? 'missing']).toMatchObject({
      required: ['demandKey', 'projectRoot', 'runId'],
      additionalProperties: false,
    });
    expect(DASHBOARD_API_INPUT_SCHEMAS[start?.requestBodySchema ?? 'missing']).toMatchObject({
      required: ['demandKey', 'preflightHash', 'runId'],
      additionalProperties: false,
    });
    for (const route of [preflight, start, status, report]) {
      expect(DASHBOARD_API_INPUT_SCHEMAS[route?.querySchema ?? 'missing']).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: false,
      });
    }
    for (const route of [status, report]) {
      const runIdSchemaId = route?.pathParameterSchemas.runId ?? 'missing';
      expect(DASHBOARD_API_INPUT_SCHEMAS[runIdSchemaId]).toMatchObject({
        type: 'string',
        maxLength: 256,
        pattern: expect.any(String),
      });
    }
  });

  test('generated consumers validate exact requests with injected Main path authority', () => {
    const validPreflight = {
      body: {
        demandKey: 'demand-1',
        projectRoot: '/workspace/project',
        runId: 'strict-run-1',
      },
      pathParameters: {},
      query: {},
    };
    expect(
      validateDashboardStrictTestOperationRequest(
        'preflightStrictTestDimension',
        validPreflight,
        STRICT_TEST_INPUT_STRING_FORMAT_VALIDATORS
      )
    ).toBe(true);
    expect(
      validateDashboardStrictTestOperationRequest(
        'preflightStrictTestDimension',
        { ...validPreflight, body: { ...validPreflight.body, projectRoot: 'workspace/project' } },
        STRICT_TEST_INPUT_STRING_FORMAT_VALIDATORS
      )
    ).toBe(false);
    expect(
      validateDashboardStrictTestOperationRequest(
        'preflightStrictTestDimension',
        validPreflight,
        {}
      )
    ).toBe(false);
    expect(
      validateDashboardStrictTestOperationRequest(
        'preflightStrictTestDimension',
        { ...validPreflight, body: { ...validPreflight.body, dimension: 'architecture' } },
        STRICT_TEST_INPUT_STRING_FORMAT_VALIDATORS
      )
    ).toBe(false);

    const route = DASHBOARD_API_ROUTES.find(
      (candidate) => candidate.operationId === 'preflightStrictTestDimension'
    );
    const schema = DASHBOARD_API_INPUT_SCHEMAS[route?.requestBodySchema ?? 'missing'];
    expect(
      (schema.properties as Record<string, unknown>).projectRoot as Record<string, unknown>
    ).toMatchObject({
      format: STRICT_TEST_CANONICAL_ABSOLUTE_PATH_FORMAT,
      'x-alembic-validator': STRICT_TEST_CANONICAL_ABSOLUTE_PATH_FORMAT,
    });
  });

  test('generated consumers validate declared strict-test response cells without shape reconstruction', () => {
    const problem = {
      success: false,
      error: buildAlembicHttpProblem(
        'STRICT_TEST_INVALID_REQUEST',
        'Strict-test request rejected',
        'invalid-input',
        { status: 400 }
      ),
    };
    expect(
      validateDashboardStrictTestOperationResponse('preflightStrictTestDimension', 400, problem)
    ).toBe(true);
    expect(
      validateDashboardStrictTestOperationResponse('preflightStrictTestDimension', 404, problem)
    ).toBe(false);
    expect(
      validateDashboardStrictTestOperationResponse('startStrictTestDimensionRun', 422, {
        ...problem,
        data: {
          schemaVersion: 1,
          profile: 'strict-test-dimension',
          demandKey: 'demand-1',
          runId: 'strict-run-1',
          phase: 'STRICT_TEST_FAILED',
          preflightHash: `sha256:${'a'.repeat(64)}`,
          automaticSelection: null,
          terminal: null,
          reportHash: null,
          evidenceRefs: [],
        },
      })
    ).toBe(true);
  });
});
