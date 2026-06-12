# Declared Effects — Alembic Public Entrypoint Families (AD6)

What state each public entrypoint family may touch. Pinned by
`test/unit/DeclaredEffects.test.ts` (state snapshot before/after on
representative calls inside a sandbox project root — never the real
`~/.asd`). Anything a family changes outside its declared set is a defect.

## Common storage funnel (all write paths)

Every persistent write funnels through the Core-owned storage opened at the
CONFIGURED project data root:

- `.asd/alembic.db` (+ `-wal`, `-shm` SQLite sidecars) — knowledge DB via
  `@alembic/core/database` (PathGuard confines writes to `.asd/` and the
  knowledge-base dir; excluded projects are redirected — see Core docs).
- Knowledge-base projections under the project (`Alembic/` dir by default:
  recipes/candidates/wiki/skills markdown), written by Core services.
- `.asd/.trash/<ts>/` — archival snapshots (bootstrap/lifecycle archives).
- Job state via Core `JobStore` / `JobDisplaySnapshotStore` at the data
  root (daemon family).
- Logs via the Logger sink; process stdout/stderr.

## Families

### HTTP routes (`lib/http/routes/*`, incl. the 6 wiki routes)

- READ routes (lists, search, status, files): DB reads only — no disk
  writes. Representative pinned: zero-effect paths leave the sandbox tree
  byte-identical (auth login additionally touches no DB at all; its only
  state is the in-process lazy auth config + env write-back, documented in
  routes/auth.ts).
- WRITE routes (knowledge/candidates/skills/wiki generate, decision
  register): the common storage funnel above, plus SSE session state
  (in-memory `SseSessionRegistry`, no disk) and the in-memory rate limiter.

### Resident tool handlers (`lib/resident/tool-handlers/*`)

- Usage-gate/validation failures (problem envelopes): zero disk effects —
  representative pinned.
- submit/lifecycle/bootstrap/rescan handlers: the common storage funnel
  (DB + projections + `.trash`), guard violations via Core ViolationsStore
  (DB), in-memory review state (`GuardReviewState`).

### Daemon jobs (`lib/daemon/*`)

- Delegates persistence to Core `JobStore`/`JobDisplaySnapshotStore` at the
  data root plus the common funnel for job work (bootstrap/rescan handlers
  above). Alembic-owned daemon state is in-memory only
  (`DaemonJobFallbacks`, timers). No Alembic-unique disk surface.

### CLI commands (`bin/cli.ts`, `lib/cli/*`)

- Delegation family: every CLI command drives the same services as the
  HTTP/resident families (scan → ModuleService, setup → config writes via
  Core config loader at the project root, start → daemon). stdout/stderr
  plus the common funnel; no CLI-unique persistent surface.

## DB-write funnel representative (pinned)

The storage funnel itself is pinned by a sandbox representative: opening
the stable `@alembic/core/database` facade at a sandbox root, running the
full migration set, and inserting via drizzle changes ONLY
`.asd/alembic.db*` — nothing else in the sandbox tree.

## Audit residue (explicit, for the next AD6 iteration)

- Full-container WRITE-route representatives (e.g. POST /knowledge through
  a real service container in a sandbox) are not yet snapshot-pinned — the
  current pins cover the zero-effect paths and the shared storage funnel
  the write routes delegate to.
- The bootstrap/rescan `.trash` archival shape is documented from the
  Train H attribution evidence, not yet snapshot-pinned here.
