# Codex Channel

The Codex channel is the stable entrypoint for the current Alembic Codex plugin.

Current scope is intentionally narrow:

- exactly one Codex plugin: `alembic-codex`
- exactly one embedded npm runtime package: `alembic-ai`
- exactly one MCP runtime bin used by the plugin: `alembic-codex-mcp`
- exactly one generic runtime mode for plugin-packaged execution: `plugin`
- exactly one current plugin host id: `codex`
- exactly one channel id for feature checks: `codex`
- exactly one installable plugin distribution repo: `GxFn/AlembicCodex`

`channels/codex/channel.json` records this wiring so Codex runtime checks do not
infer behavior from a plugin path, binary name, marketplace name, or install
location. This file is not a multi-plugin abstraction point for the current
phase; expanding it requires a deliberate plan.

Validate the channel with:

```bash
npm run verify:codex-channel
```
