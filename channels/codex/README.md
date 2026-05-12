# Codex Channel

The Codex channel is the entrypoint for everything Alembic exposes to Codex.
It is intentionally above a single plugin:

- `plugins[]` lists installable Codex plugin artifacts.
- `packages[]` lists npm packages that must be published or installed for those
  plugins and for non-plugin Codex usage.
- `marketplace` points at the Codex marketplace manifest used by the channel.

Today this channel contains one plugin, `alembic-codex`, and one global npm
runtime package, `alembic-ai`. The plugin launches the `alembic-codex-mcp` bin
from the pinned npm package, while the same package also exposes the non-plugin
global commands `alembic` and `alembic-mcp`.

Runtime feature checks should use the stable channel id `codex`, exposed as
`ALEMBIC_CHANNEL_ID=codex` and returned by Codex diagnostics/status. Do not infer
channel behavior from a plugin name, binary name, marketplace name, or install
path; those can change as more Codex plugins and npm packages are added.

Add future Codex plugins to `plugins[]` and future non-plugin npm packages to
`packages[]`. Keep channel wiring here instead of embedding channel assumptions
inside a single plugin README or release script.

Validate the channel with:

```bash
npm run verify:codex-channel
```
