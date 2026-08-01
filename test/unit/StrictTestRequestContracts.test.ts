import { describe, expect, test } from 'vitest';
import {
  assertNoLegacyStrictTestActivation,
  parseStrictTestPreflightRequest,
  parseStrictTestRunRequest,
} from '../../lib/recipe-pipeline/generate/strict/StrictTestRequestContracts.js';

const PROJECT_ROOT = '/workspace/project';
const PREFLIGHT_HASH = `sha256:${'a'.repeat(64)}`;

describe('StrictTestRequestContracts', () => {
  test('accepts only the exact explicit preflight identity', () => {
    expect(
      parseStrictTestPreflightRequest({
        demandKey: 'demand-1',
        projectRoot: PROJECT_ROOT,
        runId: 'strict-run-1',
      })
    ).toEqual({
      demandKey: 'demand-1',
      projectRoot: PROJECT_ROOT,
      runId: 'strict-run-1',
    });
  });

  test.each([
    ['caller dimension', { dimension: 'architecture' }],
    ['manual confirmation', { confirmation: 'confirm' }],
    ['legacy dimensions', { dimensions: ['architecture'] }],
    ['legacy production authority', { strictProduction: {} }],
    ['environment-style test mode', { testMode: true }],
    ['caller private root', { privateRoot: '/tmp/private' }],
    ['module subset', { moduleScope: ['module-a'] }],
  ])('rejects %s on the preflight profile', (_label, extra) => {
    expect(() =>
      parseStrictTestPreflightRequest({
        demandKey: 'demand-1',
        projectRoot: PROJECT_ROOT,
        runId: 'strict-run-1',
        ...extra,
      })
    ).toThrow();
  });

  test('accepts only demand/run/preflightHash when starting a run', () => {
    expect(
      parseStrictTestRunRequest({
        demandKey: 'demand-1',
        preflightHash: PREFLIGHT_HASH,
        runId: 'strict-run-1',
      })
    ).toEqual({
      demandKey: 'demand-1',
      preflightHash: PREFLIGHT_HASH,
      runId: 'strict-run-1',
    });
  });

  test.each([
    ['dimension', { dimension: 'architecture' }],
    ['confirmation', { confirmation: 'confirm' }],
    ['project override', { projectRoot: PROJECT_ROOT }],
    ['production profile', { strictProduction: { schemaVersion: 1 } }],
    ['test mode', { testMode: true }],
  ])('rejects %s when starting a run', (_label, extra) => {
    expect(() =>
      parseStrictTestRunRequest({
        demandKey: 'demand-1',
        preflightHash: PREFLIGHT_HASH,
        runId: 'strict-run-1',
        ...extra,
      })
    ).toThrow();
  });

  test.each([
    {},
    { demandKey: 'demand-1', projectRoot: '', runId: 'strict-run-1' },
    { demandKey: '../escape', projectRoot: PROJECT_ROOT, runId: 'strict-run-1' },
    { demandKey: 'demand-1', projectRoot: PROJECT_ROOT, runId: '../escape' },
    { demandKey: 'demand-1', preflightHash: 'not-a-hash', runId: 'strict-run-1' },
  ])('rejects missing or unsafe identity input %#', (input) => {
    const parser = Object.hasOwn(input, 'preflightHash')
      ? parseStrictTestRunRequest
      : parseStrictTestPreflightRequest;
    expect(() => parser(input)).toThrow();
  });

  test.each([
    { profile: 'strict-test-dimension' },
    { testMode: true },
    { confirmation: 'confirm' },
    { dimension: 'architecture' },
    { demandKey: 'demand-1' },
    { preflightHash: PREFLIGHT_HASH },
    { privateRoot: '/tmp/private' },
  ])('rejects strict-test activation fields on the legacy bootstrap boundary %#', (input) => {
    expect(() => assertNoLegacyStrictTestActivation(input)).toThrow(
      'STRICT_TEST_LEGACY_ACTIVATION_FORBIDDEN'
    );
  });

  test('does not reinterpret legacy production dimensions as strict-test selection', () => {
    expect(() =>
      assertNoLegacyStrictTestActivation({ dimensions: ['architecture'], maxFiles: 20 })
    ).not.toThrow();
  });
});
