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

## Concrete Execution Pattern

Use this order for most Alembic source-repo validation:

1. Search for entry points, command handlers, services, and tests with read-only tools.
2. Read the smallest set of source files that explain the current node.
3. Define a focused verification command before editing.
4. Give that command a terminal stability guard: bounded timeout, non-interactive flags, concise output, and explicit exit evidence when output may be truncated.
5. Apply the minimal code or Skill change for the current node.
6. Run the focused command again with the same guard.
7. Broaden to typecheck, targeted unit tests, or build only when the node touches shared contracts.

Do not begin with a full end-to-end user command from this repository. If a behavior requires CLI validation, use an external project path after `N0-data-location` records the write boundary.

## Node Failure Policy

- `fail`: evidence disproves the hypothesis and a focused repair is possible.
- `blocked`: required approval, fixture, external project, credential, or safe path fact is missing.
- `skipped`: the node is no longer relevant because an earlier node changed the plan.

When a node fails twice for different reasons, split it by module or side effect before making another repair.

## Useful Commands

Use commands appropriate to the changed surface:

```text
npm run typecheck
npx vitest run test/unit/<file>.test.ts
npm run test:unit
npm run build
```

Do not run user-project commands from the Alembic repository root.
