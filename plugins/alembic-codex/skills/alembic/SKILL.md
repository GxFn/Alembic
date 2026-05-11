---
name: alembic
description: Use Alembic from Codex. Start here for status, initialization, project priming, Guard checks, bootstrap/rescan jobs, Dashboard handoff, and permission boundaries.
---

# Alembic Codex Workflow

Use this skill when the user asks Codex to work with project conventions, local knowledge, Guard checks, bootstrap/rescan workflows, or Alembic itself.

## First Move

Call `alembic_codex_status` before assuming Alembic is initialized. This status check is local and must not start the daemon.

If status reports runtime or environment problems, call `alembic_codex_diagnostics` and surface the suggested fix. Diagnostics also runs without starting the daemon.

If the workspace is not initialized and the user wants Alembic knowledge for this project, call `alembic_codex_init`. The default profile is Ghost mode, so Alembic data is stored in the external workspace data root and Codex does not write IDE configuration into the project.

## Daily Coding Flow

For non-trivial coding tasks:

1. Call `alembic_task` with `operation: "prime"` and include the user's task.
2. Use `alembic_search`, `alembic_knowledge`, or `alembic_structure` when more project context is needed.
3. Make code changes according to approved Recipes and project evidence.
4. Call `alembic_guard` after meaningful edits, especially before summarizing completion.
5. If a reusable convention appears, submit a candidate with `alembic_submit_knowledge`; do not write Recipe files directly.

## Long-Running Work

Use `alembic_codex_bootstrap` for internal bootstrap jobs and `alembic_codex_rescan` for internal rescan jobs. These tools start or connect to the daemon, enqueue work, and return a recoverable job id.

Use `alembic_codex_job` to check job status later. Job lookup is local and should not start the daemon.

Use `alembic_codex_dashboard` when the user needs review, candidates, or progress visualization. Return the Dashboard URL instead of opening a browser yourself.

## Permission Boundary

Default Codex mode is agent tier. It may search knowledge, prime tasks, run Guard, start daemon jobs, and submit candidates.

Do not publish, deprecate, delete, or directly edit Recipes from the default tier. Admin tools only appear when both `ALEMBIC_MCP_TIER=admin` and `ALEMBIC_CODEX_ENABLE_ADMIN=1` are set.

Do not edit `.cursor`, `.vscode/mcp.json`, `AGENTS.md`, or project Alembic data unless the user explicitly asks for a standard, project-written setup.

## Cleanup

Plugin uninstall never removes user data. Use `alembic_codex_cleanup` for explicit cleanup. The default call is a dry run; `confirm=true` only removes daemon runtime state, logs, locks, and job files.

## Related Skills

- `alembic-recipes`: Recipe lookup and application.
- `alembic-create`: Candidate submission rules.
- `alembic-guard`: Compliance checks.
- `alembic-structure`: Project targets, files, metadata, graph, and call context.
- `alembic-devdocs`: Wiki planning, article writing, and finalize.
