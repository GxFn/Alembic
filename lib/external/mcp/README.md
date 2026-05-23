# Retired MCP Source Entrypoints

Alembic no longer owns Codex-facing MCP runtime code in this repository.
The remaining resident tool schema and handlers live under:

- `lib/resident/tool-schema/`
- `lib/resident/tool-handlers/`

This directory is intentionally kept as a boundary marker during the CCIC
cleanup waves. Do not add TypeScript modules here; update callers to the
resident paths instead.
