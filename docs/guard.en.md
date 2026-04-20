# Guard System

Guard is Alembic's code compliance checking engine, providing 50+ built-in rules with support for regex matching, AST semantic analysis, and cross-file checks.

---

## Overview

Core components of the Guard system:

| Component | Responsibility |
|-----------|---------------|
| `GuardService` | Guard service entry point, coordinates all components |
| `GuardCheckEngine` | Rule engine core (1765 lines), 50+ built-in rules |
| `SourceFileCollector` | Source file collection (by extension, gitignore, exclusion rules) |
| `ExclusionManager` | Exclusion rule management (paths, files, rule-level) |
| `ComplianceReporter` | Compliance report generation (JSON / Text / Markdown) |
| `ViolationsStore` | Violation record persistence |
| `RuleLearner` | Auto-learns new rules from Recipes |
| `GuardFeedbackLoop` | Feedback loop (false positive/negative collection) |

---

## Usage

### CLI

```bash
# Check a single file
alembic guard src/utils/helper.ts

# Check entire project (CI mode)
alembic guard:ci --report markdown --output guard-report.md

# Check git staged files (pre-commit)
alembic guard:staged
```

### File Directives

Add a directive in source code, automatically triggered by VS Code extension or `alembic watch`:

```javascript
// as:a  ← Run Guard audit on current file
```

### MCP Tool

AI assistants call via the `alembic_guard` tool:

```json
{
  "tool": "alembic_guard",
  "arguments": {
    "files": ["src/utils/helper.ts"],
    "scope": "file"
  }
}
```

---

## Rule Categories

### By Check Dimension

| Dimension | Description | Example |
|-----------|-------------|---------|
| `file` | Single-file checks | Regex matching, code-level checks |
| `target` | Module/target-level checks | Cross-file dependency analysis |
| `project` | Whole-project checks | Circular dependencies, naming conflicts |

### By Severity Level

| Level | Description | CI Behavior |
|-------|-------------|-------------|
| `error` | Critical issue, must fix | Blocks by default (`--fail-on-error`) |
| `warning` | Potential issue, should fix | Blocks when threshold exceeded (`--max-warnings`) |
| `info` | Optimization suggestion | Report only |

### By Category

| Category | Description |
|----------|-------------|
| `correctness` | Correctness (logic errors, deadlocks, resource leaks) |
| `safety` | Security (eval, exec, injection risks) |
| `style` | Code style (naming, formatting conventions) |
| `performance` | Performance (unnecessary copies, allocations in loops) |

---

## Built-in Rules Quick Reference

### Objective-C / Swift

| Rule ID | Description | Severity |
|---------|-------------|----------|
| `no-main-thread-sync` | `dispatch_sync(dispatch_get_main_queue())` deadlock | error |
| `main-thread-sync-swift` | `DispatchQueue.main.sync` deadlock | error |
| `objc-dealloc-async` | `dispatch_async` etc. in `dealloc` | error |
| `objc-block-retain-cycle` | Direct `self` use in blocks (retain cycle) | warning |
| `objc-assign-object` | `assign` for object-type properties | warning |
| `swift-force-cast` | `as!` forced type cast | warning |
| `swift-force-try` | `try!` forced try | warning |
| `objc-timer-retain-cycle` | `NSTimer` strong reference to `self` | warning |
| `objc-possible-main-thread-blocking` | `sleep` / `usleep` main thread blocking | warning |

### JavaScript / TypeScript

| Rule ID | Description | Severity |
|---------|-------------|----------|
| `js-no-eval` | `eval()` usage | error |
| `js-no-debugger` | `debugger` statement | error |
| `js-no-var` | `var` declaration (should use `let`/`const`) | warning |
| `js-no-alert` | `alert()` call | warning |
| `ts-no-non-null-assertion` | `!` non-null assertion operator | warning |
| `js-no-console-log` | `console.log` (excludes tests and scripts) | info |

### Python

| Rule ID | Description | Severity |
|---------|-------------|----------|
| `py-no-exec` | `exec()` usage | error |
| `py-no-bare-except` | Bare `except:` statement | warning |
| `py-no-mutable-default` | Mutable default argument (`def f(x=[])`) | warning |
| `py-no-star-import` | `from X import *` | warning |
| `py-no-assert-in-prod` | `assert` in production code (excludes tests) | info |

### Java / Kotlin

| Rule ID | Description | Severity |
|---------|-------------|----------|
| `java-no-system-exit` | `System.exit()` | error |
| `java-no-thread-stop` | `Thread.stop()` (deprecated unsafe method) | error |
| `java-no-raw-type` | Raw types (e.g., `List` instead of `List<String>`) | warning |
| `java-no-empty-catch` | Empty `catch` block | warning |
| `kotlin-no-force-unwrap` | `!!` force unwrap | warning |

### Go

| Rule ID | Description | Severity |
|---------|-------------|----------|
| `go-no-panic` | `panic()` call | warning |
| `go-no-err-ignored` | Ignored `error` return value (excludes tests) | warning |
| `go-no-init-abuse` | Complex logic in `init()` | info |
| `go-no-global-var` | Global mutable variables (excludes interface satisfaction assertions and tests) | info |

### Dart / Flutter

| Rule ID | Description | Severity |
|---------|-------------|----------|
| `dart-no-build-context-across-async` | `BuildContext` passed across `async` | warning |
| `dart-dispose-controller` | Controller not `dispose()`d | warning |
| `dart-avoid-bang-operator` | `!` null assertion operator | warning |
| `dart-avoid-dynamic` | `dynamic` type (excludes `Map<String, dynamic>` JSON pattern) | warning |
| `dart-no-set-state-after-dispose` | `setState` without `mounted` check | info |
| `dart-no-print` | `print()` call | info |
| `dart-prefer-const-constructor` | `new` instead of `const` constructor | info |
| `dart-no-relative-import` | Relative import paths | info |

### Rust

| Rule ID | Description | Severity |
|---------|-------------|----------|
| `rust-no-unwrap` | `.unwrap()` call (skips comments and test blocks) | warning |
| `rust-unsafe-block` | `unsafe` block | warning |
| `rust-no-todo-macro` | `todo!` / `unimplemented!` macros | warning |
| `rust-no-panic-in-lib` | `panic!` in library code | warning |
| `rust-std-mutex-in-async` | `std::sync::Mutex` in async code | warning |
| `rust-no-expect-without-msg` | `.expect("")` with empty message | info |
| `rust-clone-overuse` | Excessive `.clone()` usage | info |
| `rust-no-string-push-in-loop` | String concatenation in loops | info |

---

## Code-Level Checks (Cross-line Analysis)

Pattern checks that go beyond single-line regex matching:

| Language | Check |
|----------|-------|
| ObjC | KVO missing `removeObserver`; Category name collision in same file |
| JS/TS | Promise missing `.catch()` |
| Go | `defer` inside loops |
| Python | Mixed tab/space indentation |
| Swift | Force unwrap overuse (>5 per file) |
| Java | Resource leak (no try-with-resources); `synchronized` on non-`final` object |
| Kotlin | `GlobalScope.launch`; `runBlocking` |
| Rust | `.unwrap()` overuse (>3); excessive `unsafe` (>3 blocks) |
| Dart | `setState` after dispose (no `mounted`); excessive `late` (>3) |

---

## Cross-File Checks

Module/project-level issue analysis:

| Check | Languages | Description |
|-------|-----------|-------------|
| Circular dependencies | JS/TS | A→B→A import cycle detection |
| Category name collision | ObjC | Same Category method name across files |
| Duplicate class names | Java/Kotlin | Same class name defined in different files |
| Multiple init() | Go | Multiple files with `init()` in same package |
| Extension method conflict | Swift | Same Extension method name across files |

---

## AST Semantic Rules

Deep semantic analysis based on Tree-sitter AST:

| Query Type | Description | Example |
|------------|-------------|---------|
| `mustCallThrough` | API must only be called through a specified wrapper | Network requests only through the wrapper layer |
| `mustNotUseInContext` | Certain patterns forbidden in specific contexts | No synchronous I/O on UI thread |
| `mustConformToProtocol` | Class must implement a specified protocol | ViewController must implement Lifecycle |

---

## Rule Properties

Complete property structure of each rule:

```javascript
{
  message: "Rule description",
  severity: "error" | "warning" | "info",
  pattern: /regex/,                     // Regex pattern
  languages: ["javascript", "typescript"],
  dimension: "file" | "target" | "project",
  category: "correctness" | "safety" | "style" | "performance",
  fixSuggestion: "Fix suggestion text",
  excludePaths: ["test/", "*.test.js"],   // Excluded paths
  skipComments: true,                     // Skip comment lines
  skipTestBlocks: true                    // Skip test blocks (e.g., Rust #[cfg(test)])
}
```

---

## Custom Rules

### Create via API

```bash
curl -X POST http://localhost:3000/api/v1/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "no-todo-comments",
    "pattern": "TODO|FIXME|HACK",
    "action": "warn",
    "description": "Clean up TODO comments",
    "languages": ["javascript", "typescript"]
  }'
```

### Auto-generated from Recipes

When a Recipe's `knowledgeType` is `boundary-constraint`, `RuleLearner` automatically generates Guard rules from it.

---

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/guard.yml
name: Guard Check
on: [push, pull_request]
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install -g alembic-ai
      - run: alembic guard:ci --report markdown --output guard-report.md
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: guard-report
          path: guard-report.md
```

You can also use the `templates/guard-ci.yml` template.

### Pre-commit Hook

```bash
# Install
cp templates/pre-commit-guard.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Or configure manually:

```bash
#!/bin/sh
alembic guard:staged --fail-on-error
```

---

## Exclusion Configuration

### Rule-Level Exclusion

Each rule can have `excludePaths`:

```javascript
{
  excludePaths: ["test/", "**/*.test.js", "scripts/", "mock/"]
}
```

### Global Exclusion

Managed via `ExclusionManager`, excluded by default:
- `node_modules/`
- `.git/`
- `dist/` / `build/`
- `vendor/`
- `*.min.js`

### Special Flags

- `skipComments: true` — Skip comment lines (supports `//`, `///`, `/* */`, `#`, `"""`)
- `skipTestBlocks: true` — Skip test blocks (e.g., Rust `#[cfg(test)] mod tests { ... }`)

---

## Report Formats

### Text (default)

```
✗ src/utils/helper.ts:42 [error] js-no-eval
  eval() poses security and performance risks
  Suggestion: Use JSON.parse() or Function constructor instead

⚠ src/utils/helper.ts:67 [warning] js-no-var
  Using var to declare variables
  Suggestion: Use let or const instead

Total: 1 error, 1 warning, 0 info | Compliance Score: 65/100
```

### JSON

```json
{
  "violations": [...],
  "summary": {
    "total": 2,
    "errors": 1,
    "warnings": 1,
    "infos": 0,
    "score": 65
  }
}
```

### Markdown

Suitable for generating PR comments or CI reports.
