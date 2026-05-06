# Command Log

Run ID: `<pcv-YYYYMMDD-HHMM-target-slug>`

## Command Boundary

| Category | Allowed In Alembic Source Repo | Notes |
|----------|--------------------------------|-------|
| Read-only source search | yes | Prefer `rg` or workspace search before broad file reads. |
| Typecheck/build/unit tests | yes | Use targeted checks first, then broaden when risk requires it. |
| User-facing Alembic project commands | no | Do not run setup, embed, search, rescan, or similar project-mutating commands here. |
| External test project commands | approval required | Record targetProjectRoot, dataRoot, and writeMode first. |
| Long-running services | approval required | Avoid unless the node explicitly validates a service boundary. |

| Time | Cwd | Command | Purpose | Exit | Output Ref |
|------|-----|---------|---------|------|------------|
| `<iso-time>` | `<cwd>` | `<command>` | `<why>` | `<code>` | `command-output/<file>` |

## Notes

Record commands exactly enough for reproduction. Do not paste secrets, tokens, or private production data.
When output is long, store only the relevant tail or filtered excerpt and mention the truncation rule.
