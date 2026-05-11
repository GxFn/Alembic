# Safety Boundaries

Progressive chain validation often touches tests, generated artifacts, runtime data, and source code. Keep these boundaries explicit.

## Allowed Without Extra Approval

- Read repository files.
- Search source code and documentation.
- Edit files directly related to the requested fix.
- Add focused tests for changed behavior.
- Write run evidence under `scratch/chain-runs/<run-id>/`.
- Run non-mutating checks such as typecheck and focused unit tests.

## Requires Explicit Approval

- Deleting user data.
- Rewriting large directories.
- Running commands against production or private external projects.
- Starting long-running services.
- Running user-facing Alembic commands against a project path not provided for testing.
- Changing public path contracts such as `.cursor/skills`, `<dataRoot>/<kbDir>/skills`, or legacy `.asd/skills`.

## Blocked In The Alembic Source Repository

- Creating `.asd/` as runtime data.
- Creating `Alembic/candidates/` or `Alembic/wiki/` as runtime output.
- Treating root `skills/` as product builtin injection source.
- Injecting internal maintenance skills into user projects.

## Repair Rule

Fix the current failing node only. Re-run that node before moving to the next. If a broader refactor becomes necessary, record the reason in the node report before expanding scope.

## Command Triage

Before running a command, classify it:

- `read-only`: source search, file reads, git diff/status/log, static inspection.
- `local-check`: typecheck, build, lint, focused tests in the Alembic source repo.
- `runtime-write`: commands that create `.asd`, knowledge base, candidates, wiki, database, project skills, or IDE integration files.
- `service`: long-running servers, dashboards, watchers, MCP servers.
- `destructive`: delete, reset, rewrite, migration, or production data access.

Only `read-only` and `local-check` are allowed by default in this repository. Everything else needs a recorded path boundary and, when applicable, explicit approval.

## Terminal Stability Contract

Before running a terminal command as node evidence, record these facts in `report/plan.md`:

- Execution mode: `sync` only for short, bounded commands; `async` for servers, watchers, model-backed runs, wait-mode workflows, or commands with uncertain duration.
- Timeout budget: every command needs a hard budget or an explicit async finish/readiness signal. Do not use unbounded `timeout=0` for tests, builds, broad workflow commands, or external-project validation.
- Non-interactive guarantee: commands must pass flags or environment variables that prevent prompts. If a prompt appears, stop and collect the required value explicitly instead of leaving the terminal waiting.
- Output policy: use concise reporters, filters, or an attachment file for bulky output; the plan stores the summary and the attachment path.
- Exit evidence: capture a test summary or append an explicit exit marker such as `exit_code=$?; print "<node-id>-exit:$exit_code"; (( exit_code == 0 ))` when the tool output may be ambiguous. Avoid zsh special variables such as `status`, and do not close the persistent shell just to propagate an exit code.
- Hang recovery: if output stalls past the budget, stop or kill the terminal, record the partial output, mark the current node `blocked` or `fail`, and create a smaller harness or observability repair before rerunning.

Terminal commands are evidence transports, not proof by themselves. A command that times out or is cancelled cannot pass the node even if earlier lines look promising.

## Failure Handling

- Keep failed command output with the node round, not only in the final report.
- Do not advance a failed node by explaining it away; either repair, split, block, or skip with a recorded reason.
- If a repair changes code, add or update a focused test when the behavior is reusable.
