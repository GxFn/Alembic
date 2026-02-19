---
name: autosnippet-guard
description: Guard checks code against project Recipe standards. Passive (// as:audit + watch) or active (MCP tool autosnippet_guard — auto-routes by code/files params). Use when the user wants to audit, lint, or verify code compliance.
---

# AutoSnippet Guard — Code Compliance Checking

> Self-check & Fallback: MCP 工具返回统一 JSON Envelope（{ success, errorCode?, message?, data?, meta }）。重操作前调用 `autosnippet_health`；失败时不在同一轮重试，转用静态上下文或缩小范围后再试。

**Use this skill when**: The user wants to **check** whether code meets **project standards** (规范 / Audit / Guard / Lint).

---

## Two Modes of Guard

### Mode 1: Passive — `// as:audit` trigger (requires `asd watch` or `asd ui`)

When the user wants **quick inline audit**:
1. Add `// as:audit` (or `// as:audit keyword`) in the file
2. Save the file → watch detects the save → runs AI review against Recipe standards
3. Results output to terminal / notification

**Recommendation wording**: "在文件中加 `// as:audit`，保存后 watch 会用知识库标准审查代码，结果输出到终端。"

### Mode 2: Active — MCP tools (Agent-driven, no watch needed)

Agent can directly invoke Guard checks via MCP:

#### Single Code Check: `autosnippet_guard` (with `code` param)
Check a code snippet against Guard rules. Best for quick inline checks.

```json
{
  "code": "URLSession.shared.dataTask(with: url) { ... }",
  "language": "objc",
  "filePath": "Sources/Network/OldAPI.m"
}
```

Returns: List of violations with `{ ruleId, severity, message, line, pattern }`.

**When to use**: 
- User pastes code and asks "这段符合规范吗？"
- Agent is reviewing code before suggesting changes
- Quick single-file compliance check

#### Multi-file Audit: `autosnippet_guard` (with `files[]` param)
Batch audit multiple files against Guard rules. Results are automatically recorded to ViolationsStore (visible in Dashboard Guard page).

```json
{
  "files": [
    { "path": "/path/to/Sources/Network/APIClient.m" },
    { "path": "/path/to/Sources/Network/RequestManager.m", "content": "..." }
  ],
  "scope": "project"
}
```

Returns: Per-file violation details with severity and suggestions.

**When to use**:
- User says "审查一下网络模块" / "检查这几个文件"
- After batch code changes, verify compliance
- Periodic module-level audit

---

## Guard Knowledge Source

Guard uses the **same Recipe content** in `AutoSnippet/recipes/` as the standard:
- **kind=rule** Recipes are enforced as Guard rules (severity: error/warning/info)
- **kind=pattern** Recipes serve as best-practice references
- Guard rules with `constraints.guards[].pattern` define regex patterns for automated detection
- No separate config needed — Recipe IS the Guard standard

---

## MCP Tools for Guard

| Tool | Purpose | Input |
|------|---------|-------|
| `autosnippet_guard` | Code Guard check (single or batch — auto-routed by params) | `code` for single, `files[]` for batch, `language`, `filePath`, `scope` |
| `autosnippet_bootstrap(operation=scan)` | Full project scan + Guard audit | `maxFiles`, `includeContent` |
| `autosnippet_knowledge(operation=list, kind=rule)` | List all Guard rules (kind=rule) | `limit`, `status`, `language`, `category` |

---

## Typical Agent Workflow

### Quick Check (user asks "检查这段代码")
1. Call `autosnippet_guard` with the code
2. Present violations to user with severity and fix suggestions
3. If user adopts fixes, optionally `autosnippet_knowledge(operation=confirm_usage)` for the relevant Recipe

### Module Audit (user asks "审查网络模块")
1. Call `autosnippet_structure(operation=files)` to get file list
2. Call `autosnippet_guard` with the file paths
3. Summarize violations grouped by severity
4. Suggest fixes based on Recipe standards

### Project-wide Compliance
1. Call `autosnippet_bootstrap(operation=scan)` for full project scan
2. Present high-severity findings first

---

## Audit trigger syntax

- `// as:audit` — audit entire file against all rules
- `// as:audit keyword` — audit with specific keyword focus  
- `// as:lint` — **deprecated**, use `// as:audit`

---

## Related Skills

- **autosnippet-recipes**: Recipe content IS the Guard standard. Use for looking up what the standard says.
- **autosnippet-intent**: General router; may route Guard-related intents here.
- **autosnippet-analysis**: Deep project scan + Guard baseline via `autosnippet_bootstrap(operation=scan)`.

```
