import type { DimensionDef } from '@alembic/core/types';
import { describe, expect, test } from 'vitest';
import {
  buildProduceSessionProjection,
  buildProduceSessionRoutePlan,
  readControllerProduceSessionRequest,
} from '../../lib/workflows/knowledge-rescan/ProduceSessionRoute.js';

const asqDimension = {
  id: 'asq-publication',
  label: 'ASQ publication',
  skillWorthy: false,
} as DimensionDef;

const apiDimension = {
  id: 'api',
  label: 'API',
  skillWorthy: false,
} as DimensionDef;

function sessionFor(dimIds: string[]) {
  return {
    id: 'bs-asq',
    projectRoot: '/repo/asq',
    getProgress: () => ({ remainingDimIds: dimIds }),
    toJSON: () => ({
      id: 'bs-asq',
      projectRoot: '/repo/asq',
      progress: { remainingDimIds: dimIds },
    }),
  };
}

describe('Knowledge rescan produce session route', () => {
  test('opens an active controller-authorized produce session projection', () => {
    const request = readControllerProduceSessionRequest({
      produceSession: {
        controllerAuthorized: true,
        gaps: [
          {
            createBudget: 3,
            dimensionId: 'asq-publication',
            gapId: 'asq4b1b-knowledge-pack',
            triggerPrefix: 'asq4b1b',
          },
        ],
        source: 'asq-controller',
      },
    });
    const plan = buildProduceSessionRoutePlan({
      allDimensions: [asqDimension, apiDimension],
      gapPlan: {
        executionDecisions: [],
        occupiedTriggers: ['existing-trigger'],
        produceDimensions: [],
      },
      request,
    });
    const projection = buildProduceSessionProjection({
      occupiedTriggers: ['existing-trigger'],
      plan,
      projectRoot: '/repo/asq',
      session: sessionFor(['asq-publication']),
    });

    expect(projection).toMatchObject({
      bootstrapSessionRef: 'bootstrap-session:bs-asq',
      createBudgets: { 'asq-publication': 3 },
      mode: 'controller-authorized-gap-fill',
      required: true,
      sessionId: 'bs-asq',
      status: 'active',
      usable: true,
    });
    expect(projection.constraints).toMatchObject({
      allowedSources: ['asq-controller'],
      occupiedTriggerCount: 1,
      requireProductionSession: true,
      sessionRefFields: ['sessionId', 'bootstrapSessionRef'],
      triggerPrefixes: ['asq4b1b'],
    });
    expect(projection.dimensions).toEqual([
      {
        createBudget: 3,
        gapId: 'asq4b1b-knowledge-pack',
        id: 'asq-publication',
        label: 'ASQ publication',
      },
    ]);
  });

  test('returns a no-produce-session blocker for invalid controller gaps', () => {
    const request = readControllerProduceSessionRequest({
      produceSession: {
        controllerAuthorized: true,
        gaps: [{ createBudget: 2, dimensionId: 'missing-dimension', gapId: 'missing-gap' }],
      },
    });
    const plan = buildProduceSessionRoutePlan({
      allDimensions: [asqDimension],
      gapPlan: { executionDecisions: [], occupiedTriggers: [], produceDimensions: [] },
      request,
    });
    const projection = buildProduceSessionProjection({
      plan,
      projectRoot: '/repo/asq',
      session: null,
    });

    expect(projection).toMatchObject({
      blocker: {
        owner: 'controller-or-alembic-produce-session-route',
        reasonCode: 'no-produce-session',
      },
      required: true,
      status: 'no-produce-session',
      usable: false,
    });
    expect(projection.sessionId).toBeUndefined();
  });

  test('does not expose a session that cannot cover requested produce dimensions', () => {
    const request = readControllerProduceSessionRequest({
      produceSession: {
        controllerAuthorized: true,
        dimensions: ['asq-publication'],
      },
    });
    const plan = buildProduceSessionRoutePlan({
      allDimensions: [asqDimension],
      gapPlan: { executionDecisions: [], occupiedTriggers: [], produceDimensions: [] },
      request,
    });
    const projection = buildProduceSessionProjection({
      plan,
      projectRoot: '/repo/asq',
      session: sessionFor(['api']),
    });

    expect(projection).toMatchObject({
      blocker: {
        reasonCode: 'session-does-not-cover-produce-gaps',
      },
      status: 'no-produce-session',
      usable: false,
    });
  });

  test('projects ordinary rescan produce gaps without requiring controller mode', () => {
    const request = readControllerProduceSessionRequest({});
    const plan = buildProduceSessionRoutePlan({
      allDimensions: [asqDimension],
      gapPlan: {
        executionDecisions: [
          {
            createBudget: 4,
            dimensionId: 'asq-publication',
            mode: 'produce',
          },
        ],
        occupiedTriggers: [],
        produceDimensions: [asqDimension],
      },
      request,
    });
    const projection = buildProduceSessionProjection({
      plan,
      projectRoot: '/repo/asq',
      session: sessionFor(['asq-publication']),
    });

    expect(projection).toMatchObject({
      createBudgets: { 'asq-publication': 4 },
      mode: 'rescan-gap-analysis',
      required: false,
      status: 'active',
      usable: true,
    });
  });
});
