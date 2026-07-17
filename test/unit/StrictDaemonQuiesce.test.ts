import { createHash } from 'node:crypto';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { describe, expect, it, vi } from 'vitest';
import {
  createStrictQuiesceRequest,
  StrictDaemonQuiesceController,
} from '../../lib/daemon/runtime/StrictDaemonQuiesce.js';
import daemonRouter, { configureStrictDaemonQuiesce } from '../../lib/http/routes/daemon.js';
import { invokeRouter } from '../helpers/express.js';

const binding = {
  runId: 'strict-run-1',
  setupAuthorityHash: sha('authority'),
  journalHeaderHash: sha('header'),
  externalLeaseHash: sha('lease'),
  projectRootHash: sha('project'),
  dataRootHash: sha('data'),
  daemonIdentityHash: sha('daemon'),
};

describe('StrictDaemonQuiesce', () => {
  it('creates a hashes-only request with no path or secret fields', () => {
    const request = createStrictQuiesceRequest(binding);

    expect(request.requestHash).toBe(
      hashCanonicalJson({
        schemaVersion: 1,
        kind: 'StrictQuiesceRequestV1',
        ...binding,
      })
    );
    const serialized = JSON.stringify(request);
    expect(serialized).not.toMatch(/path|token|secret|credential/iu);
  });

  it('requires the daemon token, replays the same ack, and rejects conflicts without shutdown', () => {
    const request = createStrictQuiesceRequest(binding);
    const triggerShutdown = vi.fn();
    const controller = new StrictDaemonQuiesceController({
      daemonToken: 'daemon-secret',
      dataRootHash: binding.dataRootHash,
      daemonIdentityHash: binding.daemonIdentityHash,
      projectRootHash: binding.projectRootHash,
      triggerShutdown,
    });

    expect(controller.accept(request, 'wrong-token')).toMatchObject({ status: 401 });
    expect(triggerShutdown).not.toHaveBeenCalled();

    const first = controller.accept(request, 'daemon-secret');
    const replay = controller.accept(request, 'daemon-secret');
    expect(first.status).toBe(202);
    expect(replay).toEqual(first);
    expect(triggerShutdown).toHaveBeenCalledOnce();

    const conflict = controller.accept(
      createStrictQuiesceRequest({ ...binding, runId: 'strict-run-2' }),
      'daemon-secret'
    );
    expect(conflict).toMatchObject({ status: 409 });
    expect(triggerShutdown).toHaveBeenCalledOnce();
  });

  it('exposes only the existing daemon router and requires the token header', async () => {
    const triggerShutdown = vi.fn();
    configureStrictDaemonQuiesce({
      daemonToken: 'daemon-secret',
      dataRootHash: binding.dataRootHash,
      daemonIdentityHash: binding.daemonIdentityHash,
      projectRootHash: binding.projectRootHash,
      triggerShutdown,
    });
    const request = createStrictQuiesceRequest(binding);

    const unauthorized = await invokeRouter(daemonRouter, {
      method: 'POST',
      mountPath: '/api/v1/daemon',
      path: '/api/v1/daemon/strict-quiesce',
      body: request,
    });
    expect(unauthorized.status).toBe(401);
    expect(triggerShutdown).not.toHaveBeenCalled();

    const accepted = await invokeRouter(daemonRouter, {
      method: 'POST',
      mountPath: '/api/v1/daemon',
      path: '/api/v1/daemon/strict-quiesce',
      body: request,
      headers: { 'x-alembic-daemon-token': 'daemon-secret' },
    });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({
      success: true,
      data: { kind: 'StrictQuiesceAcceptedAckV1', requestHash: request.requestHash },
    });
    expect(triggerShutdown).toHaveBeenCalledOnce();
  });
});

function sha(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
