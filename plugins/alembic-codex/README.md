# Alembic Codex Plugin

Alembic for Codex gives Codex local project memory without turning every chat into a setup session. It starts with a lightweight MCP shim, reports diagnostics and workspace status without initializing the database, initializes in Ghost mode by default, then starts or connects to the per-workspace daemon only when project knowledge, Guard, Dashboard, bootstrap, or rescan work is requested.

Use it when you want Codex to:

- Prime itself with project Recipes before coding.
- Run Guard checks against the current change.
- Build or refresh project knowledge through recoverable daemon jobs.
- Open the local Dashboard only when a visual handoff is useful.

## Runtime

- Node.js 22 or newer is required. Node 22 LTS is recommended for local development; keep the MCP shim and daemon on the same Node executable.
- The marketplace MCP config pins the runtime package as `alembic-ai@0.1.0`.
- The MCP launch command runs `npx` with `--prefix /tmp` so GitHub/local installs inside the Alembic repository cannot shadow the published runtime binaries.
- The default MCP tier is `agent`; admin tools stay hidden unless both `ALEMBIC_MCP_TIER=admin` and `ALEMBIC_CODEX_ENABLE_ADMIN=1` are set.

## First Checks

Use `alembic_codex_diagnostics` first. It reports Node, npm, npx, package version, daemon version, plugin metadata checks, offline fallback guidance, cleanup policy, and structured `issues` / `nextActions`.

Use `alembic_codex_status` to inspect workspace initialization and daemon state without starting the daemon. The response includes an `onboarding` block with a concise state, primary recommended tool call, whether that call starts the daemon, and follow-up actions.

Outside Codex, the same runtime checks are available from the CLI:

```bash
alembic codex diagnostics --json
alembic codex status --json
```

The normal first minute is:

1. `alembic_codex_diagnostics`
2. `alembic_codex_status`
3. `alembic_codex_init` when status reports `needs_init`
4. `alembic_codex_bootstrap` for first project knowledge, or `alembic_task` with `operation=prime` before coding work

## AI Key Setup

When configuring a provider key through Codex, ask the user to copy the raw key only. Do not ask for `apiKey: ...`, `apikey ...`, `ALEMBIC_DEEPSEEK_API_KEY=...`, JSON, or Markdown-wrapped text. Feed the secret through stdin and verify only the masked result:

```bash
pbpaste | alembic ai configure --provider deepseek --model deepseek-v4-pro --key-stdin \
  --embed-provider ollama --embed-model qwen3-embedding:0.6b
alembic ai status --json
```

The CLI and Dashboard config route also normalize common copied wrappers before storing secrets, but raw-key input is the canonical agent flow.

## Long-Running Jobs

`alembic_codex_bootstrap` and `alembic_codex_rescan` return a durable job id immediately. Use `alembic_codex_job` with that id to resume status checks after Codex reconnects or the Dashboard refreshes.

If the Alembic daemon shuts down or restarts before an active job completes, the next daemon lifecycle marks that job as `failed` with an interruption reason instead of leaving it stuck in `queued` or `running`. Start a new bootstrap or rescan job to retry.

## Release Verification

Before publishing, run:

```bash
npm run release:codex-plugin
```

The release check builds the runtime and Dashboard, verifies the local Codex marketplace entry, validates the pinned MCP runtime, checks the lightweight `alembic-codex-mcp` binary, default agent tier, disabled admin gate, declared assets, shipped skills, default prompts, README runtime fallback, package tarball contents, local install simulation, and real MCP stdio calls.

For the full local daemon path, run:

```bash
npm run release:codex-plugin:daemon
```

That optional variant also starts the daemon on a temporary localhost port and verifies interrupted job recovery. `prepublishOnly` runs `release:codex-plugin`.

For the full release, testing, and promotion plan, see [RELEASE-PLAYBOOK.md](./RELEASE-PLAYBOOK.md).

## Local Marketplace

This repository includes `.agents/plugins/marketplace.json` so local Codex builds can discover Alembic as an installable plugin entry. The entry points to `./plugins/alembic-codex`, marks installation as `AVAILABLE`, and uses `ON_INSTALL` authentication policy.

`npm run smoke:codex-plugin` packages the runtime, resolves this marketplace entry from the packed tarball, copies the plugin into a temporary install root, and validates the installed manifest, MCP config, assets, skills, and stdio MCP calls.

## Offline Fallback

The default plugin config launches through pinned `npx`. If the first run cannot reach the npm registry, install the same runtime version globally and run the MCP binary from `PATH`:

```bash
npm install -g alembic-ai@0.1.0
alembic-codex-mcp
```

## Cleanup Policy

Uninstalling the plugin never removes Alembic data automatically. Use `alembic_codex_cleanup` for an explicit cleanup flow. The default call is a dry run; `confirm=true` only removes daemon runtime state, logs, locks, and job files. Knowledge, Recipes, candidates, and project data are left intact.
