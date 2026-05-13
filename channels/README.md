# Alembic Channels

Channels describe how Alembic reaches a specific AI surface or distribution path.
They do not own product code. They point to the concrete artifacts that already
exist in the repository, such as Codex plugins, npm global packages, IDE
extensions, skills, or installer bundles.

Each channel gets its own directory:

- `channels/codex/` is the Codex entrypoint. It currently publishes the
  `alembic-codex` plugin, whose installed directory contains an embedded
  `alembic-ai` runtime package at `./runtime` and the npx runtime tarball at
  `./runtime.tgz` in the dedicated
  `GxFn/AlembicCodex` distribution repository.

When a channel grows, add more entries to that channel's `plugins` or
`packages` list instead of hardcoding one-off release logic in a single plugin
directory.

Runtime code should branch on the stable channel id, for example
`ALEMBIC_CHANNEL_ID=codex`, not on install paths or artifact names.

Use `ALEMBIC_RUNTIME_MODE=plugin` for behavior that applies to any packaged
plugin runtime, regardless of host. Use `ALEMBIC_PLUGIN_HOST=codex` only for
Codex-specific behavior. A future Claude Code plugin should keep
`ALEMBIC_RUNTIME_MODE=plugin` and set its own plugin host id.
