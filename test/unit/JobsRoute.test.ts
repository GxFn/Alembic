import type { DaemonJobRecord } from '@alembic/core/daemon/JobStore';
import type { Request } from 'express';
import { describe, expect, test } from 'vitest';
import {
  buildJobStatusUrl,
  buildJobsApiOrigin,
  decorateJobForResponse,
} from '../../lib/http/routes/jobs.js';

describe('jobs route URL helpers', () => {
  test('uses the request Host header when it is available', () => {
    const request = makeRequest({ host: '127.0.0.1:39127' });

    expect(buildJobsApiOrigin(request)).toBe('http://127.0.0.1:39127');
    expect(buildJobStatusUrl(request, 'bootstrap_abc')).toBe(
      'http://127.0.0.1:39127/api/v1/jobs/bootstrap_abc'
    );
  });

  test('falls back to the local socket address and port', () => {
    const request = makeRequest({ localAddress: '0.0.0.0', localPort: 39127 });

    expect(buildJobsApiOrigin(request)).toBe('http://127.0.0.1:39127');
  });
});

describe('jobs route response decoration', () => {
  test('adds live bootstrap progress to matching running jobs', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_live',
      status: 'running',
    });

    const decorated = decorateJobForResponse(job, {
      id: 'bs_live',
      status: 'running',
      progress: 40,
      total: 5,
      completed: 2,
      failed: 0,
      filling: 1,
      skeleton: 2,
      totalToolCalls: 7,
      tasks: [
        {
          id: 'dim_architecture',
          status: 'filling',
          meta: { label: 'Architecture' },
        },
      ],
    });

    expect(decorated.progress).toMatchObject({
      activeTaskId: 'dim_architecture',
      activeTaskLabel: 'Architecture',
      completed: 2,
      percent: 40,
      sessionId: 'bs_live',
      total: 5,
      totalToolCalls: 7,
    });
  });

  test('derives final progress and summary from completed session payloads', () => {
    const job = makeJob({
      bootstrapSessionId: 'bs_done',
      status: 'completed',
      result: {
        finalSession: {
          sessionId: 'bs_done',
          summary: {
            completed: 3,
            duration: 4200,
            failed: 0,
            totalTasks: 3,
          },
        },
      },
    });

    const decorated = decorateJobForResponse(job);

    expect(decorated.progress).toMatchObject({
      completed: 3,
      failed: 0,
      percent: 100,
      sessionId: 'bs_done',
      total: 3,
    });
    expect(decorated.summary).toMatchObject({
      completed: 3,
      failed: 0,
      totalTasks: 3,
    });
  });
});

function makeRequest(options: {
  host?: string;
  localAddress?: string;
  localPort?: number;
  protocol?: string;
}): Request {
  return {
    protocol: options.protocol || 'http',
    get(headerName: string): string | undefined {
      return headerName.toLowerCase() === 'host' ? options.host : undefined;
    },
    socket: {
      localAddress: options.localAddress,
      localPort: options.localPort,
    },
  } as unknown as Request;
}

function makeJob(overrides: Partial<DaemonJobRecord> = {}): DaemonJobRecord {
  const now = new Date('2026-05-08T00:00:00.000Z').toISOString();
  return {
    id: 'bootstrap_test',
    kind: 'bootstrap',
    status: 'queued',
    source: 'dashboard',
    projectRoot: '/tmp/project',
    dataRoot: '/tmp/project/.alembic',
    projectId: 'test',
    request: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
