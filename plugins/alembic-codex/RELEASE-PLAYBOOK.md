# Alembic Codex Plugin Release Playbook

This playbook describes how to release, test, and promote the Alembic Codex plugin. It is intentionally operational: every section should help a maintainer decide what to run, what to verify, and what to say publicly.

## Release Model

Alembic for Codex is shipped from the Alembic monorepo as three coupled artifacts:

- The npm runtime package: `alembic-ai`.
- The packaged Codex plugin directory: `plugins/alembic-codex`.
- The repo-local Codex marketplace entry: `.agents/plugins/marketplace.json`.

The plugin MCP config pins the runtime package version:

```json
{
  "command": "npx",
  "args": ["-y", "--package", "alembic-ai@<version>", "alembic-codex-mcp"]
}
```

That means every package version bump must keep these surfaces aligned:

- `package.json`
- `package-lock.json`
- `plugins/alembic-codex/.mcp.json`
- `plugins/alembic-codex/README.md`
- root `README.md` / `README_CN.md` when public instructions change

## Version And Tag Flow

Use the tag-driven GitHub Release workflow as the source of truth. Avoid local manual `npm publish` except for emergency recovery.

1. Choose the version, for example `0.1.0`.
2. Update package and plugin pins to the same version.
3. Run local release checks:

```bash
npm run build
alembic codex diagnostics --json
npm run release:codex-plugin
npm run release:codex-plugin:daemon
```

4. Commit the version and release-readiness changes.
5. Push `main` and wait for CI to pass.
6. Create an annotated tag on the exact green commit:

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

7. Watch the `Release` workflow. It verifies the tag matches `package.json`, builds runtime/Dashboard/VS Code extension, runs lint, unit and integration tests, previews the npm package, uploads the VS Code artifact, and publishes npm with provenance.
8. Confirm the registry:

```bash
npm view alembic-ai version dist-tags.latest
```

The expected result is both values matching the tag version.

## Release Workflow Contract

The GitHub `Release` workflow is expected to do the irreversible publish step.

It must pass:

- Tag/package version equality check.
- `npm ci`.
- Dashboard dependency install.
- VS Code extension dependency install.
- `npm run build`.
- `npm run build:dashboard`.
- `npm run build:vscode-ext`.
- `npm run lint -- --diagnostic-level=error`.
- `npm run test:unit`.
- `npm run test:integration`.
- `npm pack --dry-run`.
- VS Code extension package preview.
- `npm publish --provenance --access public --ignore-scripts`.

`prepublishOnly` still runs `npm run release:codex-plugin` for local safety, but the Release workflow uses `--ignore-scripts` because it already ran the build and test gates.

## Test Matrix

Use the matrix below when changing plugin metadata, MCP startup, daemon lifecycle, jobs, setup, or release scripts.

| Layer | Command / Action | What It Proves | Required When |
| --- | --- | --- | --- |
| Static plugin metadata | `npm run verify:codex-plugin` | Manifest, assets, skills, marketplace entry, MCP pin, README release copy | Every plugin metadata or docs change |
| Runtime build | `npm run build` | TypeScript builds and CLI/MCP bins are generated | Every code change |
| CLI diagnostics | `alembic codex diagnostics --json` | Node, npm/npx, package pin, plugin files, admin gate, daemon version checks work outside Codex | Every release candidate |
| Package/install smoke | `npm run smoke:codex-plugin -- --no-stdio` | npm tarball contents and local marketplace install simulation | Docs/metadata/package files changes |
| MCP stdio smoke | `npm run smoke:codex-plugin` | Real MCP client can list/call Codex tools through stdio | MCP shim changes |
| Daemon smoke | `npm run release:codex-plugin:daemon` | Dashboard daemon startup, daemon state, job recovery | Daemon/job/Dashboard bridge changes |
| Unit tests | `npm run test:unit` | Core behavior and Codex MCP unit contracts | Shared code changes |
| Integration tests | `npm run test:integration` | End-to-end service behavior without relying on the Codex app | HTTP/workflow/storage changes |
| CI | GitHub `CI` on `main` | Linux/Node 22 compatibility and clean checkout behavior | Before tagging |
| Release workflow | GitHub `Release` on `v*` tag | Production publish path | Every npm release |
| Manual Codex app pass | Install/enable plugin, run first-minute prompts | Actual marketplace-style UX | Before public announcement |

## Manual Codex App Pass

Run this against a fresh test repository and one real project before public promotion.

1. Confirm the Alembic plugin appears in Codex plugins.
2. Enable/install the plugin.
3. Run `alembic_codex_diagnostics`.
4. Run `alembic_codex_status`.
5. If uninitialized, run `alembic_codex_init`.
6. Confirm Ghost mode did not create project-local `.asd/`, `Alembic/`, `.cursor/`, `.vscode/mcp.json`, or `.env`.
7. Run `alembic_codex_status` again and confirm the primary action is `alembic_task` with `operation=prime`.
8. Run `alembic_codex_dashboard` and confirm a localhost Dashboard URL is returned.
9. Run `alembic_codex_bootstrap` and capture the job id.
10. Run `alembic_codex_job` with the job id.
11. Restart Codex or stop the daemon, then confirm `alembic_codex_job` returns a recoverable status instead of leaving the job stuck.
12. Run `alembic_codex_cleanup` without `confirm` and verify it is a dry run.

## Failure Triage

| Symptom | First Check | Likely Cause | Fix |
| --- | --- | --- | --- |
| Plugin visible but MCP does not start | `alembic codex diagnostics --json` | Node < 22, missing npm/npx, npx cannot fetch package | Install Node 22, use global `npm install -g alembic-ai@<version>` fallback |
| Diagnostics pin mismatch | `plugins/alembic-codex/.mcp.json` | Version bump missed plugin MCP config | Update pin and rerun `npm run verify:codex-plugin` |
| npm release did not happen | Release workflow logs | Tag mismatch, tests failed, npm token/provenance issue | Fix workflow failure, create a new patch version/tag |
| Daemon starts but tools fail | `alembic daemon status --json` and daemon log path | stale daemon state, missing bridge token, health identity mismatch | Stop daemon, rerun dashboard/bootstrap, inspect `daemon.log` |
| Job remains running forever | `alembic_codex_job` and Dashboard jobs page | daemon restart before interruption marking, old JobStore record | Restart daemon; lifecycle should mark active jobs failed with interruption reason |
| Codex creates project artifacts in Ghost mode | `alembic codex status --json` | setup profile regression or manual standard init | Fix setup profile; rerun on clean test project |

## Promotion Plan

### Positioning

Lead with one sentence:

> Alembic gives Codex local-first project memory, Recipes, Guard checks, and recoverable bootstrap jobs without forcing users to start a terminal service first.

Avoid positioning it as a generic agent framework. The strongest wedge is practical:

- Codex can prime itself with real project conventions before coding.
- Guard can check whether a diff matches those conventions.
- Bootstrap/rescan can build project memory in recoverable daemon jobs.
- Ghost mode keeps installation low-risk and outside the repository by default.

### Phase 1: Trusted Alpha

Goal: prove first-minute UX and reduce support surprises.

Audience:

- 5 to 10 trusted developers who already use Codex daily.
- Projects across TypeScript/React, backend services, Swift/iOS, and one large monorepo.

Ask them to report:

- Did the plugin install and appear without terminal setup?
- Did diagnostics pass?
- Did Ghost init avoid project pollution?
- Did `prime` improve coding answers?
- Did Guard catch anything actionable?
- Where did daemon/job wording feel confusing?

Success bar:

- 80%+ complete diagnostics/status/init without maintainer help.
- No unrecoverable daemon or job failures.
- At least 3 concrete examples where Recipes or Guard changed a coding decision.

### Phase 2: Public Beta

Goal: explain the product clearly and collect real-world issues.

Ship:

- GitHub release notes for the beta version.
- A short GIF or video: diagnostics -> status -> init -> prime -> Guard.
- README quickstart focused on the Codex plugin, not the full Alembic CLI.
- Issue template that asks users to attach redacted `alembic codex diagnostics --json`.
- A known-limitations section: Node 22 required, first run may need npm registry access, daemon is local-only.

Message:

- "Click install, run diagnostics, initialize Ghost mode, then let Codex prime itself."
- "Alembic does not publish or delete Recipes automatically from the plugin."
- "Long jobs are recoverable through job ids and Dashboard."

### Phase 3: Use-Case Content

Goal: make the plugin feel useful, not just installable.

Recommended posts or examples:

- "The first minute with Alembic for Codex."
- "Prime Codex before touching a legacy module."
- "Use Guard as a code-review companion."
- "Bootstrap a project memory map over lunch, then use it all week."
- "How Ghost mode keeps Alembic data outside your repo."

Each example should include:

- Starting project state.
- Exact Codex prompt or tool call.
- Result before/after Alembic prime or Guard.
- One screenshot or short clip.
- A fallback note for offline/npm failures.

### Phase 4: Marketplace Readiness

Goal: prepare for broader marketplace distribution or review without scrambling.

Maintain a submission pack:

- Plugin manifest and screenshots.
- One-paragraph value prop.
- Privacy/local-first explanation.
- Permission and side-effect explanation.
- Test evidence from latest CI and Release workflow.
- Known limitations and support URL.
- `npm view alembic-ai version dist-tags.latest` output.

If a formal marketplace review path is required, submit only after the manual Codex app pass is green on the exact npm version pinned in `.mcp.json`.

## Metrics To Watch

Product health:

- Diagnostics pass rate.
- Time to first successful `alembic_codex_status`.
- Time to first successful Ghost init.
- Daemon startup success rate.
- Bootstrap/rescan job completion or recoverable-failure rate.
- Number of support issues caused by Node/npm/npx.

Adoption:

- npm downloads for `alembic-ai`.
- GitHub stars/watchers.
- Plugin install or enable count when available.
- Repeat usage signals: `prime`, `guard`, `job`, and Dashboard calls.

Quality:

- False-positive Guard reports.
- Recipes that users actually keep or publish.
- Support tickets requiring manual daemon cleanup.
- Reports of project artifacts created unexpectedly in Ghost mode.

## Release Notes Template

```md
## Alembic for Codex <version>

### What changed
- ...

### Why it matters
- ...

### How to try it
1. Install/enable the Alembic Codex plugin.
2. Run `alembic_codex_diagnostics`.
3. Run `alembic_codex_status`.
4. Run `alembic_codex_init` if needed.
5. Use `alembic_task` with `operation=prime` before non-trivial coding.

### Verification
- CI: <link>
- Release: <link>
- npm: `alembic-ai@<version>`

### Known limitations
- Requires Node.js 22+.
- First run through pinned `npx` may need npm registry access.
- Admin tools are disabled by default.
```
