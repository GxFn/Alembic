## Alembic Project Notes

This repository is the fresh mainline package for `alembic-ai`. It is a source
repository for the Codex-first runtime and Codex plugin package, not a user
project workspace.

### Do Not Do

- Do not treat this repository as a user's Alembic knowledge base.
- Do not create project-local runtime data such as `.asd/`, `Alembic/`, or
  candidate knowledge directories while testing repository code.
- Do not run user-facing setup or project-ingestion commands against the source
  repository unless the task explicitly asks for a repository-self-test and the
  command uses a temporary `ALEMBIC_HOME`.
- Do not assume old monorepo surfaces exist here. This package no longer has a
  Dashboard app, VS Code extension project, or integration-test suite.

### Current Scope

- Node 22 ESM TypeScript package for the `alembic-ai` runtime.
- CLI entrypoint in `bin/cli.ts`.
- Codex MCP entrypoint in `bin/codex-mcp.ts`.
- Codex runtime, daemon bridge, Guard, and workflow code under `lib/`.
- Codex plugin payload under `plugins/alembic-codex/`.
- Repository-local Codex marketplace entry under `.agents/plugins/marketplace.json`.

### Development Commands

- `npm run typecheck` checks TypeScript without emitting files.
- `npm run lint` runs Biome over the repository.
- `npm run build` compiles TypeScript into `dist/`.
- `npm run test:unit` runs the Vitest unit suite.
- `npm run verify:codex-plugin` validates package metadata and the Codex plugin
  payload.

### Coding Conventions

- Use TypeScript with ESM imports. Relative runtime imports must include the
  `.js` extension.
- Keep code compatible with Node.js 22 and newer.
- Prefer explicit interfaces and type guards over `as any`.
- Use `catch (err: unknown)` and narrow errors before reading properties.
- Keep tests close to the code they cover using `*.test.ts` or `*.spec.ts` in
  `bin/`, `lib/`, or `scripts/`.
- Keep public plugin behavior aligned across `package.json`,
  `.agents/plugins/marketplace.json`, `plugins/alembic-codex/.mcp.json`, and
  `plugins/alembic-codex/README.md`.

### Release Expectations

- CI runs on pushes and pull requests to `main`.
- Publishing is tag-driven: push an annotated `v*` tag whose version matches
  `package.json`.
- The Release workflow uses `secrets.NPM_TOKEN` and `npm publish --provenance`.
- Before tagging, run `npm run typecheck`, `npm run lint`, `npm run build`,
  `npm run test:unit`, and `npm run verify:codex-plugin`.
