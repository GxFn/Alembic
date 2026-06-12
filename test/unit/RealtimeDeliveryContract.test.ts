/**
 * AD5/AD6 conformance test for docs/realtime-delivery-contract.md
 * (Alembic's side): pins the service-owned semantics — single opt-in
 * 'notifications' room targeting, join/leave/ack mechanics, and the
 * fire-and-forget shape. Socket.io's own dropout guarantees (room removal
 * on disconnect, no auto-rejoin) are library contracts documented in the
 * doc, not re-tested here.
 */

import { createServer } from 'node:http';
import { vi } from 'vitest';
import { RealtimeService } from '../../lib/infrastructure/realtime/RealtimeService.js';

type Handler = (...args: unknown[]) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Handler>();
  return {
    id: 'fake-socket-1',
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    trigger(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
    },
  };
}

describe('Realtime delivery contract (Alembic side)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let service: RealtimeService;

  beforeEach(() => {
    httpServer = createServer();
    service = new RealtimeService(httpServer);
  });

  afterEach(async () => {
    await service.io.close();
    httpServer.close();
  });

  test('joining is opt-in: join-notifications joins the room and acks; leave exits', () => {
    const connectionHandler = service.io.listeners('connection')[0] as Handler;
    expect(connectionHandler).toBeDefined();

    const socket = makeFakeSocket();
    connectionHandler(socket);

    socket.trigger('join-notifications');
    expect(socket.join).toHaveBeenCalledWith('notifications');
    expect(socket.emit).toHaveBeenCalledWith(
      'notification-joined',
      expect.objectContaining({ message: expect.any(String) })
    );

    socket.trigger('leave-notifications');
    expect(socket.leave).toHaveBeenCalledWith('notifications');
  });

  test('every broadcast targets only the notifications room (fire-and-forget)', () => {
    const roomEmit = vi.fn();
    const toSpy = vi
      .spyOn(service.io, 'to')
      .mockReturnValue({ emit: roomEmit } as unknown as ReturnType<typeof service.io.to>);

    service.broadcastCandidateCreated({ id: 'c1' });
    service.broadcastCandidateStatusChanged('c1', 'active', 'pending');
    service.broadcastTokenUsageUpdated();
    service.broadcastRecipeCreated({ id: 'r1' });
    service.broadcastRecipePublished('r1', { id: 'r1' });
    service.broadcastRuleCreated({ id: 'g1' });
    service.broadcastRuleStatusChanged('g1', true);

    expect(toSpy).toHaveBeenCalledTimes(7);
    for (const call of toSpy.mock.calls) {
      expect(call[0]).toBe('notifications');
    }
    // Fire-and-forget shape: plain emits, type + timestamp payloads.
    for (const [eventName, payload] of roomEmit.mock.calls as Array<
      [string, { type?: string; timestamp?: number }]
    >) {
      expect(eventName).toEqual(expect.any(String));
      expect(payload.type).toEqual(expect.any(String));
      expect(payload.timestamp).toEqual(expect.any(Number));
    }
  });

  test('ping answers pong with a timestamp (heartbeat contract)', () => {
    const connectionHandler = service.io.listeners('connection')[0] as Handler;
    const socket = makeFakeSocket();
    connectionHandler(socket);

    socket.trigger('ping');
    expect(socket.emit).toHaveBeenCalledWith(
      'pong',
      expect.objectContaining({ timestamp: expect.any(Number) })
    );
  });
});
