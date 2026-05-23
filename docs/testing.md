# Testing

## Unit Tests

- `npm run test:unit` runs the complete unit suite. It includes sandbox and terminal adapter tests that need an environment allowed to bind `127.0.0.1` and run `sandbox-exec`.
- `npm run test:unit:codex` runs the Codex sandbox-safe unit baseline. It uses the same unit scope but excludes:
  - `test/unit/SandboxNetworkProxy.test.ts`
  - `test/unit/TerminalAdapter.test.ts`

Use `test:unit:codex` inside restricted Codex desktop sessions. Use the full `test:unit` before release or when validating sandbox / terminal behavior.
