import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CORE_D25_REQUIRED_FAILURE_KINDS,
  type CoreFieldFailureKind,
  getCoreFailureTaxonomyEntry,
} from '@alembic/core/shared';
import { describe, expect, test } from 'vitest';
import apiSpec from '../../lib/http/api-spec.js';
import {
  ALEMBIC_PROVIDER_CONTRACT_VERSION,
  ALEMBIC_PROVIDER_EVENT_CONTRACTS,
  ALEMBIC_PROVIDER_FIXTURES,
  ALEMBIC_PROVIDER_ROUTE_CONTRACTS,
  ALEMBIC_PROVIDER_ROUTE_MOUNTS,
  type AlembicProviderFixtureScenario,
  buildAlembicProviderOpenApiSpec,
  summarizeAlembicProviderContracts,
} from '../../lib/http/provider-contracts.js';

describe('Alembic provider contracts', () => {
  test('covers D3 provider registry rows with route schemas and fixtures', () => {
    const summary = summarizeAlembicProviderContracts();
    expect(summary.version).toBe(ALEMBIC_PROVIDER_CONTRACT_VERSION);
    expect(summary.rowIds).toEqual(
      expect.arrayContaining([
        'I03',
        'I04',
        'I05',
        'I06',
        'I07',
        'I08',
        'I09',
        'I10',
        'I11',
        'I21',
        'I22',
        'I23',
      ])
    );

    const routeRows = new Set(ALEMBIC_PROVIDER_ROUTE_CONTRACTS.map((route) => route.registryRowId));
    for (const rowId of summary.rowIds) {
      expect(routeRows.has(rowId)).toBe(true);
    }

    for (const route of ALEMBIC_PROVIDER_ROUTE_CONTRACTS) {
      expect(route.responseSchemas[200]).toBeDefined();
      expect(route.capabilityDiscovery.length).toBeGreaterThan(0);
      expect(route.errorKinds.length).toBeGreaterThan(0);
      expect(route.exposureClasses).not.toContain('raw-store');
      expect(route.fixtureIds.length).toBeGreaterThan(0);
    }
  });

  test('generates OpenAPI from the provider manifest and keeps route operations unique', () => {
    const generated = buildAlembicProviderOpenApiSpec();
    expect(apiSpec).toEqual(generated);
    expect(generated.openapi).toBe('3.0.0');

    const paths = generated.paths as Record<string, Record<string, { operationId?: string }>>;
    const operationIds = new Set<string>();
    for (const route of ALEMBIC_PROVIDER_ROUTE_CONTRACTS) {
      expect(paths[route.path]?.[route.method]).toBeDefined();
      const operationId = paths[route.path]?.[route.method]?.operationId;
      expect(operationId).toBe(route.operationId);
      expect(operationIds.has(route.operationId)).toBe(false);
      operationIds.add(route.operationId);
    }

    const extension = generated['x-alembic-provider-contract'] as Record<string, unknown>;
    expect(extension.summary).toMatchObject({
      eventCount: ALEMBIC_PROVIDER_EVENT_CONTRACTS.length,
      fixtureCount: ALEMBIC_PROVIDER_FIXTURES.length,
      routeCount: ALEMBIC_PROVIDER_ROUTE_CONTRACTS.length,
    });
  });

  test('declares resident search provider routes and scopes fallback as compatibility metadata', () => {
    expect(ALEMBIC_PROVIDER_ROUTE_CONTRACTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'get',
          operationId: 'searchKnowledge',
          path: '/search',
          registryRowId: 'I22',
        }),
        expect.objectContaining({
          method: 'post',
          operationId: 'searchKnowledgeWithHostIntent',
          path: '/search',
          registryRowId: 'I22',
        }),
      ])
    );

    const searchFixtures = ALEMBIC_PROVIDER_FIXTURES.filter((fixture) =>
      fixture.fixtureId.startsWith('search.')
    );
    expect(searchFixtures.map((fixture) => fixture.fixtureId)).toEqual([
      'search.success',
      'search.degraded',
    ]);
    expect(searchFixtures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fixtureId: 'search.degraded',
          payload: expect.objectContaining({
            data: expect.objectContaining({
              searchMeta: expect.objectContaining({
                actualMode: 'legacy-fallback',
                degraded: true,
                degradedReason:
                  'SearchEngine unavailable; resident service used legacy non-vector fallback',
                residentVector: expect.objectContaining({
                  available: false,
                  endpoint: '/api/v1/search',
                  reason: 'SearchEngine unavailable; vector route was not attempted',
                }),
              }),
            }),
          }),
        }),
      ])
    );
    expect(JSON.stringify(searchFixtures)).not.toContain('compatibility');
    expect(JSON.stringify(searchFixtures)).not.toContain('legacyDecisionRegisterItems');
  });

  test('keeps HttpServer mounted API routes aligned with the provider mount manifest', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib/http/HttpServer.ts'), 'utf8');
    const mounted = extractMountedProviderPaths(source);
    const expected = ALEMBIC_PROVIDER_ROUTE_MOUNTS.map((mount) => mount.fullPath).sort();
    expect(mounted).toEqual(expected);
  });

  test('fixtures cover non-happy paths without leaking internal stores or local paths', () => {
    const fixtureIds = new Set(ALEMBIC_PROVIDER_FIXTURES.map((fixture) => fixture.fixtureId));
    const scenarios = new Set<AlembicProviderFixtureScenario>(
      ALEMBIC_PROVIDER_FIXTURES.map((fixture) => fixture.scenario)
    );
    expect([...scenarios]).toEqual(
      expect.arrayContaining([
        'success',
        'failure',
        'partial',
        'cancelled',
        'conflict',
        'not-found',
        'permission-denied',
        'timeout',
        'unavailable-runtime',
      ])
    );

    for (const route of ALEMBIC_PROVIDER_ROUTE_CONTRACTS) {
      for (const fixtureId of route.fixtureIds) {
        expect(fixtureIds.has(fixtureId)).toBe(true);
      }
    }

    for (const event of ALEMBIC_PROVIDER_EVENT_CONTRACTS) {
      for (const fixtureId of event.fixtureIds) {
        expect(fixtureIds.has(fixtureId)).toBe(true);
      }
    }

    const serialized = JSON.stringify(ALEMBIC_PROVIDER_FIXTURES);
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('singletons');
    expect(serialized).not.toContain('storeDir');
    expect(serialized).not.toContain('rawProviderPayload');
  });

  test('closes ordinary provider schemas and names typed extension points', () => {
    const generated = buildAlembicProviderOpenApiSpec();
    const serialized = JSON.stringify(generated);
    expect(serialized).not.toContain('"additionalProperties":true');

    const schemas = generated.components.schemas as Record<string, Record<string, unknown>>;
    expect(schemas.SuccessEnvelope?.additionalProperties).toBe(false);
    expect(schemas.ProblemEnvelope?.additionalProperties).toBe(false);

    const routeData = schemas.RouteFamilyResponse?.properties as Record<string, unknown>;
    const dataSchema = routeData.data as Record<string, unknown>;
    expect(dataSchema['x-alembic-extension-point']).toMatchObject({
      name: 'provider.route-data',
      owner: 'Alembic provider route contract',
      schemaClosurePolicy: 'typed-extension',
    });

    const problemProperties = schemas.ProblemEnvelope?.properties as Record<string, unknown>;
    const errorSchema = problemProperties.error as Record<string, unknown>;
    expect(errorSchema.required).toEqual(
      expect.arrayContaining([
        'canonicalHttpStatus',
        'code',
        'detailExposureClass',
        'exposureClass',
        'failureId',
        'failureStatus',
        'mcpErrorCode',
        'message',
        'problemClass',
        'reasonCode',
        'refPolicy',
        'retryPolicy',
        'retryable',
        'status',
        'taxonomyVersion',
      ])
    );
    expect(errorSchema.oneOf).toBeUndefined();
    expect(errorSchema.type).toBe('object');
  });

  test('normalizes failure fixtures to Core D25 provider problem taxonomy objects', () => {
    const representativeFailureKinds = [
      'invalid-input',
      'not-found',
      'conflict',
      'permission-denied',
      'timeout',
      'cancelled',
      'unavailable',
      'degraded',
      'partial',
      'capability-mismatch',
      'needs-confirmation',
      'provider-error',
      'host-failure',
      'internal-error',
    ] as const satisfies readonly CoreFieldFailureKind[];
    const observedFailureKinds = new Set<CoreFieldFailureKind>();

    for (const fixture of ALEMBIC_PROVIDER_FIXTURES) {
      if (fixture.payload.success !== false) {
        continue;
      }
      const payload = fixture.payload as Record<string, unknown>;
      const error = payload.error as Record<string, unknown>;
      const reasonCode = error.reasonCode as CoreFieldFailureKind;
      const taxonomy = getCoreFailureTaxonomyEntry(reasonCode);
      observedFailureKinds.add(reasonCode);
      expect(error).toMatchObject({
        canonicalHttpStatus: taxonomy.httpStatus,
        code: expect.any(String),
        detailExposureClass: taxonomy.detailExposureClass,
        exposureClass: taxonomy.exposureClass,
        failureId: taxonomy.stableId,
        failureStatus: taxonomy.status,
        mcpErrorCode: taxonomy.mcpErrorCode,
        message: expect.any(String),
        privateDataSafe: true,
        problemClass: taxonomy.problemClass,
        reasonCode,
        refPolicy: taxonomy.refPolicy,
        retryPolicy: taxonomy.retryPolicy,
        status: expect.any(Number),
        taxonomyVersion: 1,
      });
      expect(typeof payload.error).toBe('object');
      expect(payload.reasonCode).toBeUndefined();
    }

    expect([...observedFailureKinds]).toEqual(expect.arrayContaining(representativeFailureKinds));
    expect([...observedFailureKinds]).toEqual(
      expect.arrayContaining([...CORE_D25_REQUIRED_FAILURE_KINDS])
    );
  });

  test('event manifest covers socket, recovery, and SSE provider events', () => {
    const transports = new Set(ALEMBIC_PROVIDER_EVENT_CONTRACTS.map((event) => event.transport));
    expect(transports).toEqual(new Set(['rest-recovery', 'socket.io', 'sse']));
    expect(ALEMBIC_PROVIDER_EVENT_CONTRACTS.map((event) => event.eventName)).toEqual(
      expect.arrayContaining([
        'job:process-event',
        'job-process-events',
        'ai.chat.events',
        'modules.scan.events',
        'candidates.refine-preview.events',
      ])
    );
  });
});

function extractMountedProviderPaths(source: string): string[] {
  const paths = new Set<string>();
  for (const match of source.matchAll(/this\.app\.use\(`\$\{apiPrefix\}\/([^`]+)`/g)) {
    paths.add(`/api/v1/${match[1]}`);
  }
  for (const match of source.matchAll(/this\.app\.get\(`\$\{apiPrefix\}\/([^`]+)`/g)) {
    paths.add(`/api/v1/${match[1]}`);
  }
  if (source.includes("this.app.get('/api-spec'")) {
    paths.add('/api-spec');
  }
  return [...paths].sort();
}
