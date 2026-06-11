# Alembic Internal Semantics

This document is the Alembic main-repo glossary for AO2 responsibility and
semantic cleanup. It records internal names only; it does not change resident
MCP input schemas or cross-repository contracts.

## Responsibility Terms

- session: a live resident/tool conversation state with intent, tool usage, and
  activity timestamps.
- job: daemon-owned long running bootstrap/rescan work, persisted through job
  storage and surfaced through job routes.
- search: retrieval over knowledge, recipes, decisions, and guard context. A
  search can request one mode and execute another mode when fallback is needed.
- tool: a callable resident or adapter capability. MCP tools are external
  contracts; internal adapters are host-owned implementation details.

## Mode Fields

- requestedMode: caller intent before routing or fallback.
- actualMode: engine mode that actually returned data.
- degradedMode: requested capability was not met; response must explain why.
- hookMode: test or local hook behavior; do not report it as engine execution.
- runtimeMode: process capability mode owned by daemon/resident runtime.
- legacyFallbackMode: compatibility route when the primary engine is unavailable.

## Host Intent Context

`HostIntentContext` has three explicit internal modes:

- host-intent-frame
- mixed-host-intent-and-legacy-args
- legacy-args-only

The legacy `userQuery` / `activeFile` / `language` path is owned by Alembic main
for the AlembicPlugin consumer. Its cleanup trigger is: remove the legacy
fallback only after the Plugin host-intent frame is the only current consumer
input path. Until then, Alembic records the compatibility mode and redacts legacy
values from metadata.

## Deprecated Lifecycle Causes

The public lifecycle label remains `deprecated`. Internally, AO2 distinguishes
three causes:

- manual-curation: a developer or dashboard action intentionally retired it.
- evolution-decay: automated evolution found the entry decayed or superseded.
- source-orphan-cleanup: source sync or cleanup found the backing artifact gone.

AO0 did not approve a resident MCP schema change, so deprecated causes stay
internal documentation and type taxonomy unless a later phase authorizes a
visible contract field.
