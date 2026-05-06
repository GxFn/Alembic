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
