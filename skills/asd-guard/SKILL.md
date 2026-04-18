---
name: asd-guard
description: Guard checks code against project Recipe standards via MCP tool asd_guard (auto-routes by code/files params). Use when the user wants to audit, lint, or verify code compliance.
---

# Alembic Guard — Code Compliance Checking

**Use this skill when**: The user wants to **check** whether code meets **project standards** (规范 / Audit / Guard / Lint).

---

## MCP Tool: `asd_guard`

**Single code check** (`code` param):
```json
{ "code": "URLSession.shared.dataTask(with: url) { ... }", "language": "objc", "filePath": "Sources/Network/OldAPI.m" }
```

**Multi-file audit** (`files[]` param):
```json
{ "files": [{ "path": "Sources/Network/APIClient.m" }, { "path": "Sources/Network/RequestManager.m" }], "scope": "project" }
```

Returns violations with `{ ruleId, severity, message, line, pattern }`. Batch results auto-recorded to ViolationsStore.

---

## Guard Knowledge Source

Guard uses **Recipe content** as the standard — no separate config:
- **kind=rule** → enforced as Guard rules (severity: error/warning/info)
- **kind=pattern** → best-practice references
- `constraints.guards[].pattern` → regex patterns for automated detection

---

## Agent Workflow

### Quick Check ("检查这段代码")
1. `asd_guard` with code → present violations + fix suggestions

### Module Audit ("审查网络模块")
1. `asd_structure(operation=files)` → get file list
2. `asd_guard` with file paths → summarize by severity

### Project-wide
1. `asd_bootstrap` → full project scan including Guard audit

---

## Related Skills

- **asd-recipes**: Recipe content IS the Guard standard
