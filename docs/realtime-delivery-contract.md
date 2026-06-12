# Realtime Delivery Contract — Alembic's Side (AD5/AD6)

Counterpart to AlembicCore `docs/realtime-delivery-contract.md` (Core's
event primitives, commit 7857600). Core produces fire-and-forget in-process
events; this documents what Alembic's delivery surfaces guarantee — and
deliberately do not guarantee — to Dashboard/clients. Pinned by
`test/unit/RealtimeDeliveryContract.test.ts`.

## Socket.io notifications (`lib/infrastructure/realtime/RealtimeService.ts`)

- **One opt-in room: `notifications`.** A connected client receives nothing
  until it emits `join-notifications`; the server acks with
  `notification-joined`. `leave-notifications` exits the room.
- **All broadcasts target the `notifications` room only**
  (candidate-created/status-changed, recipe-created/published,
  rule-created/status-changed, token-usage-updated, job process events).
  Sockets outside the room never receive them.
- **Room dropout semantics (Socket.io guarantees):** a disconnected socket
  is removed from all rooms by Socket.io; a reconnecting client gets a NEW
  socket that is NOT in `notifications`. There is no server-side auto-rejoin
  — clients MUST re-emit `join-notifications` after every (re)connect.
- **Fire-and-forget, no catch-up.** Broadcasts emitted while a client is
  disconnected or unjoined are lost permanently: no queue, no journal, no
  replay on rejoin. Consumers needing current state must re-fetch it via
  HTTP after rejoining (the Dashboard pattern).
- Transport: websocket with polling fallback; heartbeat ping/pong
  (pingInterval 25s / pingTimeout 20s, Socket.io defaults declared
  explicitly).

## SSE stream sessions (`lib/http/utils/sse-sessions.ts`)

- Per-operation sessions (chat/scan streams), NOT the notifications room.
- **Bounded reconnect catch-up**: events buffer in the session; an
  EventSource (re)connection replays the buffer then receives live events.
  Completed sessions are kept 60s for replay; a hard 5-minute TTL clears
  any session regardless of state (AD4: timers and the session map live in
  the managed `SseSessionRegistry`).
- Per-connection listener disposal on `stream:done`/`stream:error` and on
  response close (verified in the ai/candidates/modules routes).

## What downstream may NOT assume

- No delivery to unjoined/disconnected sockets, ever; no cross-restart
  delivery anywhere (in-memory only, both surfaces).
- No ordering guarantees across event names — only per-emitter sequence
  within one event name (inherited from Core's EventBus contract).
- SSE replay exists only within one session's lifetime window (60s
  completed-keep / 5min TTL); the notifications room has NO replay at all.
