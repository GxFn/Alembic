# Alembic Adapter

This reference adapts progressive chain validation to Alembic development.

## Repository Boundary

The Alembic source repository is not a user project environment. Do not run user-facing Alembic commands here, including setup, embed, search, or workflow commands intended to initialize or mutate a user project.

Allowed in this repository:

- Read source files.
- Edit Alembic source code.
- Run unit tests, integration tests, build, typecheck, and lint commands.
- Create internal development documents under `docs-dev/`.
- Create temporary development artifacts under `scratch/`.

Not allowed in this repository:

- Create `.asd/`.
- Create `Alembic/candidates/` or `Alembic/wiki/` as runtime output.
- Treat the repository root as a user knowledge base.
- Start test dashboard or frontend services unless explicitly required by a development task.

## Validation Strategy

For Alembic cold-start, rescan, bootstrap, delivery, or skill-generation chains:

1. Read the relevant workflow code and tests first.
2. Build a node plan that follows actual modules and side effects.
3. Use external test projects or Ghost workspaces for user-project runtime behavior.
4. Prefer focused unit tests before end-to-end manual commands.
5. If an `alembic` command must be tested, first build/link the dev package and use a developer-provided external project path.

## Useful Commands

Use commands appropriate to the changed surface:

```text
npm run typecheck
npx vitest run test/unit/<file>.test.ts
npm run test:unit
npm run build
```

Do not run user-project commands from the Alembic repository root.
