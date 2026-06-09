import { readFileSync } from 'node:fs';
import path from 'node:path';
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
      'search.compatibility-fallback',
    ]);
    expect(searchFixtures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fixtureId: 'search.compatibility-fallback',
          payload: expect.objectContaining({
            data: expect.objectContaining({
              searchMeta: expect.objectContaining({
                actualMode: 'legacy-fallback',
                compatibility: expect.objectContaining({
                  contractId: 'I22.search.compatibility-fallback',
                  fallback: true,
                  reason: 'search-engine-unavailable',
                }),
              }),
            }),
          }),
        }),
      ])
    );
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
      expect.arrayContaining(['success', 'failure', 'partial', 'cancelled', 'unavailable-runtime'])
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
