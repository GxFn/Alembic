# Testing

## Unit Tests

- `npm run test:unit` runs the complete unit suite. It includes sandbox tests that need an environment allowed to bind `127.0.0.1` and run `sandbox-exec`.
- `npm run test:unit:codex` runs the Codex sandbox-safe unit baseline. It uses the same unit scope but excludes:
  - `test/unit/SandboxNetworkProxy.test.ts`

Use `test:unit:codex` inside restricted Codex desktop sessions. Use the full `test:unit` before release or when validating sandbox behavior.

The host suite runs up to four workers by default because recovery and build tests also spawn processes. Use `--maxWorkers` to override this for a focused run; keep the normal timeout and assertion limits. Test setup allocates temporary data roots per worker. Do not supply one shared `ALEMBIC_HOME` or `ALEMBIC_PROJECT_DIR` to a parallel full suite.

## Test ownership

Agent internals are tested in `AlembicAgent`: SDK wire formats, model routing, runtime policies, successful tool receipts, event request/reply, and registry projection. Extend the existing owner suite when these contracts change. Main consumes the built `@alembic/agent` entry points and tests its host behavior through `AgentPublicSurfaceSmoke`, `MainToolAvailability`, `ToolContextFactory`, `ToolContextScope`, and the generate/runtime tests.

Embedding configuration and host lifecycle belong here: the provider, isolation, route and generation tests use the real Core adapters with controlled HTTP and temporary storage. The direct Core indexing integration fixture must represent stored chunks with real producer/source metadata; an attempted operation or partial object is not evidence that indexing or persistence completed.

Before removing a duplicate test, map its meaningful positive and negative cases to owner coverage and retain a Main consumer test for the actual adapter. SDK mocks must use real `Response` objects and valid protocol payloads. Gate fixtures must include confirmed tool results, and request/reply tests must publish a distinct correlated reply. Never weaken production validation to preserve an obsolete fixture.
