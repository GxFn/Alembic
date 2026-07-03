# Environment Variables And Configuration

Alembic does not load `.env` files. The env-file configuration path was removed
from the runtime long ago, and the stale `.env.example` was retired on
2026-07-04. Configuration comes from two sources:

1. **Workspace settings (preferred for AI config)** — managed by
   `alembic ai configure` / `alembic ai import-env`, stored per selected folder
   identity under the workspace runtime directory: `settings.json`
   (provider / model / proxy / reasoning effort, mode 644) and `secrets.json`
   (provider API keys, mode 600). Inspect effective values, their source, and
   the file paths with `alembic ai status`.
2. **Process environment (explicit override)** — the variables below are
   honored when set in the shell. For AI settings, an explicitly set process
   variable wins over the persisted workspace settings.

## AI settings (persisted by `alembic ai configure`)

| Variable | Meaning |
| --- | --- |
| `ALEMBIC_AI_PROVIDER` | AI provider id (`google` / `openai` / `claude` / `deepseek`) |
| `ALEMBIC_AI_MODEL` | Model id for the selected provider |
| `ALEMBIC_AI_PROXY` | HTTP/HTTPS proxy for provider calls |
| `ALEMBIC_AI_REASONING_EFFORT` | Reasoning effort passthrough (`low` / `medium` / `high`) |
| `ALEMBIC_GOOGLE_API_KEY` / `ALEMBIC_OPENAI_API_KEY` / `ALEMBIC_CLAUDE_API_KEY` / `ALEMBIC_DEEPSEEK_API_KEY` | Provider API keys; written to `secrets.json` when configured through the CLI |

## Embedding settings (process env only)

`ALEMBIC_EMBED_PROVIDER`, `ALEMBIC_EMBED_MODEL`, `ALEMBIC_EMBED_BASE_URL`, and
`ALEMBIC_EMBED_API_KEY` select the dedicated embedding provider (consumed by
the AI injection module). They take effect as process environment variables;
the workspace settings store does not persist embedding fields.

## Runtime overrides (process env only)

| Variable | Meaning |
| --- | --- |
| `ALEMBIC_PROJECT_DIR` | Project root override (defaults to cwd; MCP mode has no cwd fallback) |
| `ALEMBIC_HOME` | Overrides the home directory used to locate the `~/.asd` data root (sandboxed runs / tests) |
| `ALEMBIC_SNIPPETS_PATH` | Overrides the snippets storage path |
| `ALEMBIC_CACHE_PATH` | Overrides the cache path |
| `ALEMBIC_LOG_LEVEL` | Log level: `debug` / `info` / `warn` / `error` |
| `ALEMBIC_DEBUG=1` | CLI debug output to stderr |
| `ALEMBIC_QUIET=1` | Suppress non-essential CLI/log output |
| `ALEMBIC_WIKI_LANG` | Wiki generation language (defaults to `zh`) |
| `NODE_ENV` | Standard Node environment switch (`development` / `production`) |

Other `ALEMBIC_*` variables that appear in the source (`ALEMBIC_MCP_MODE`,
`ALEMBIC_DAEMON_*`, `ALEMBIC_SANDBOX_*`, internal tokens, …) are process
coordination details between Alembic components, not a public configuration
contract; do not rely on them.

## Retired variables

The following variables documented by the old `.env.example` no longer exist in
code and have no effect: `ALEMBIC_AUTH_USERNAME`, `ALEMBIC_AUTH_PASSWORD`,
`ALEMBIC_WATCH_POLLING`, `ALEMBIC_FIX_SPM_DEPS_MODE`, `ALEMBIC_SIGNAL_MODE`,
`ALEMBIC_LARK_APP_ID`, `ALEMBIC_LARK_APP_SECRET`, `ALEMBIC_LARK_ALLOWED_USERS`,
`VITE_API_BASE_URL`. The Dashboard login toggle `VITE_AUTH_ENABLED` is a
build-time variable of the AlembicDashboard repository, not an Alembic runtime
variable.
