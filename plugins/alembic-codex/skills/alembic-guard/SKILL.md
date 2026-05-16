---
name: alembic-guard
description: Check code against Alembic Recipe standards with `alembic_guard`. Trigger for audits, lint-like review, diff checks, compliance checks, and "does this follow our conventions?" questions.
---

# Alembic Guard

Guard checks code against project Recipes. Use it after edits and whenever the user asks whether code follows local standards.

## Tool

Use `alembic_guard`.

Common calls:

```json
{}
```

Checks the current git diff. Prefer this after you change code.

```json
{
  "files": [
    { "path": "src/network/apiClient.ts" },
    { "path": "src/network/requestManager.ts" }
  ],
  "scope": "project"
}
```

Checks specific files.

```json
{
  "code": "URLSession.shared.dataTask(with: url) { ... }",
  "language": "swift",
  "filePath": "Sources/Network/LegacyClient.swift"
}
```

Checks an inline snippet.

## Workflow

For quick checks:

1. Call `alembic_guard`.
2. Summarize violations by severity.
3. Fix issues using the returned do/dont clauses, core code, and Recipe references.
4. Re-run Guard when the fix is meaningful.

For module audits:

1. Use `alembic_structure(operation: "targets")` to find relevant modules.
2. Use `alembic_structure(operation: "files")` for the chosen module.
3. Call `alembic_guard` with the selected files.
4. Report the highest-severity issues first.

## Knowledge Source

Guard uses approved Recipes:

- `kind: "rule"` entries become enforceable rules.
- `kind: "pattern"` entries provide best-practice guidance.
- Guard constraints can include patterns for automated detection.

If code appears correct but Guard reports an outdated standard, do not silently ignore it. Explain the conflict and consider submitting an evolution candidate.
