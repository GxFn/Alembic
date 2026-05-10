# Alembic

Lightweight Codex-first Alembic runtime package.

This repository is the fresh mainline package for `alembic-ai`. The initial shape is intentionally small: a Node 22 ESM TypeScript package that will host the Codex MCP runtime and the Codex plugin payload.

## Current Scope

- Codex plugin package under `plugins/alembic-codex`.
- Lightweight MCP entrypoint exposing diagnostics, status, and Ghost init.
- CLI helper commands under `alembic codex`.
- Ghost workspace registry under `~/.asd/projects.json`, with project data stored outside the project by default.

Daemon, bootstrap/rescan jobs, Tools V2, Guard, and mainline Recipe runtime are the next migration batches.

## Scripts

- `npm run build` compiles TypeScript into `dist`.
- `npm run typecheck` runs TypeScript without emitting files.
- `npm run test:unit` runs Vitest unit tests.
- `npm run verify:codex-plugin` checks root package metadata and validates the Codex plugin payload when it is present.

## Package Entrypoints

- `alembic` resolves to `dist/bin/cli.js`.
- `alembic-codex-mcp` resolves to `dist/bin/codex-mcp.js`.

## Smoke Checks

- `node dist/bin/cli.js codex diagnostics --json`
- `node dist/bin/cli.js codex status --json`
- `env ALEMBIC_HOME=/private/tmp/alembic-codex-smoke node dist/bin/cli.js codex init --json`
