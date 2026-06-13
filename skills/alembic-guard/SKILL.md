---
name: alembic-guard
description: Guard checks code against project Recipe standards via MCP tool alembic_guard (auto-routes by code/files params). Use when the user wants to audit, lint, or verify code compliance.
---

<!-- wakeflow-host:main — title and trigger wording are host-specific -->
# Alembic Guard — Code Compliance Checking

**Use this skill when**: The user wants to **check** whether code meets **project standards** (规范 / Audit / Guard / Lint).

<!-- wakeflow-shared:begin section="scope" -->
Guard is a scoped Recipe-adherence check. It is not repo lint, security audit, general code review, or a whole-diff fallback.
<!-- wakeflow-shared:end -->

---

<!-- wakeflow-host:main — tool contract differs per host (main MCP exposes alembic_guard; plugin exposes alembic_code_guard with files/code/workRef scopes) -->
## MCP Tool: `alembic_guard`

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

<!-- wakeflow-shared:begin section="knowledge-source" -->
## Guard Knowledge Source

Guard uses **Recipe content** as the standard — no separate config:
- **kind=rule** → enforced as Guard rules (severity: error/warning/info)
- **kind=pattern** → best-practice references
- `constraints.guards[].pattern` → regex patterns for automated detection
<!-- wakeflow-shared:end -->

---

<!-- wakeflow-host:main — workflow steps reference main-only tools (alembic_guard auto-routing, alembic_bootstrap project scan) -->
## Agent Workflow

### Quick Check ("检查这段代码")
1. `alembic_guard` with code → present violations + fix suggestions

### Module Audit ("审查网络模块")
1. `alembic_structure(operation=files)` → get file list
2. `alembic_guard` with file paths → summarize by severity

### Project-wide
1. `alembic_bootstrap` → full project scan including Guard audit

---

<!-- wakeflow-shared:begin section="related-skills" -->
## Related Skills

- **alembic-recipes**: Recipe content IS the Guard standard
<!-- wakeflow-shared:end -->
