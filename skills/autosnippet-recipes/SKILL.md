---
name: autosnippet-recipes
description: Provides this project's Recipe-based context to the agent. Recipes are the project's standard knowledge (code patterns + usage guides + structured relations). Use when answering about project standards, Guard, conventions, or when suggesting code. Supports in-context lookup, terminal search (asd search), and on-demand semantic search via MCP tool autosnippet_search (mode=context).
---

# AutoSnippet Recipe Context (Project Context)

> Self-check and Fallback: MCP tools return unified JSON Envelope. Before heavy ops call `autosnippet_health`. On failure do not retry in same turn; use static context or narrow scope.

This skill provides the agent with this project's context from AutoSnippet Recipes. Recipes are the project's standard knowledge base: code patterns, usage guides, and structured relations.

---

## Core Rule: Agent Permission Boundary

**Agent CANNOT directly produce or modify Recipes.** Agent's role is:

| Allowed | Forbidden |
|---------|-----------|
| Submit Recipe candidates (submit_candidate / submit_candidates / submit_draft_recipes) | Directly create Recipe |
| Validate candidates (validate_candidate / check_duplicate) | Modify existing Recipe content |
| Search/query Recipes (list_recipes / get_recipe / context_search / list_facts) | Publish/deprecate/delete Recipe |
| Confirm usage (confirm_usage) - record adoption/application telemetry | Modify Recipe quality scores |
| Enhance candidate info (add rationale/steps/codeChanges etc.) | Bypass candidate review to write to recipes/ |

Recipe creation, review, publish, update, deprecate, delete are **human-only via Dashboard or HTTP API**.

---

## V3 Recipe Model

Recipe is the core knowledge unit. V3 uses a unified structured model:

- **kind**: rule (mandatory norm, Guard enforced) | pattern (best practice) | fact (structural knowledge)
- **knowledgeType**: code-pattern | architecture | best-practice | naming | error-handling | performance | security | testing | api-usage | workflow | dependency | rule
- **complexity**: beginner | intermediate | advanced
- **scope**: universal | project-specific | target-specific
- **content**: { pattern, rationale, steps[], codeChanges[], verification, markdown }
- **relations**: { inherits[], implements[], calls[], dependsOn[], dataFlow[], conflicts[], extends[], related[] }
- **constraints**: { boundaries[], preconditions[], sideEffects[], guards[] }
- **status**: draft -> active -> deprecated

---

## Instructions for the agent

1. **Project context**: Read `references/project-recipes-context.md` in this skill folder for **Recipe 轻量索引**（title/trigger/category/summary 表格）。如需 Recipe 全文，调用 MCP `autosnippet_knowledge(operation=get, id)` 或 `autosnippet_search(query)`。索引缺失时，可直接读 `AutoSnippet/recipes/` 目录。

2. **Finding code on demand**: Look up matching Recipe by title/summary/usage guide, use its code as standard to suggest. Cite the Recipe title.

3. **Recipe over code search**: When both Recipe and code search find matches, prefer Recipe as source of truth.

4. **Search - three ways**:
   - In-context: `references/project-recipes-context.md` 轻量索引按 title/trigger/summary 匹配
   - Terminal: `asd search <keyword>` or `asd search --semantic <keyword>`
   - MCP: `autosnippet_search` (mode=auto 或 mode=context) with query and optional limit

5. **Browsing Recipes via MCP**:
   - `autosnippet_knowledge(operation=list)` - list with kind/language/category/knowledgeType/status/complexity filters
   - `autosnippet_knowledge(operation=get, id)` - get single Recipe by ID (full content/relations/constraints)
   - `autosnippet_knowledge(operation=list, kind=fact)` - list kind=fact structural knowledge

6. **Confirming usage**: Call `autosnippet_knowledge(operation=confirm_usage, id, usageType)` when user adopts a Recipe. Telemetry only.

7. **Updating context**: After user changes Recipes, tell them to run `asd install:cursor-skill` to regenerate references.

---

## How to use this context

1. For project standards/Guard/conventions: Use Recipe content as source of truth.
2. Recipe priority: Prefer Recipe over codebase implementations. Cite Recipe code.
3. For "how we do X here": Base answer on Recipe content.
4. For drafting candidates: Follow autosnippet-candidates flow. Never write to `AutoSnippet/recipes/`.
5. For Audit/as:audit: Suggestions should match Recipe content.
6. Usage Guide depth: Include deps, steps, error handling, perf, security, pitfalls, related Recipes.
7. Placeholders: Prefer Xcode placeholders (e.g. `<#URL#>`, `<#Token#>`).

---

## MCP Tools Reference (20 个整合工具)

### Query (Agent can freely use)

| Tool | Description |
|------|-------------|
| `autosnippet_health` | Health check + KB stats |
| `autosnippet_search` | Unified search (`mode`: auto/context/keyword/semantic) |
| `autosnippet_knowledge` | Knowledge browse (`operation`: list/get/insights/confirm_usage) |
| `autosnippet_graph` | Knowledge graph (`operation`: query/impact/path/stats) |
| `autosnippet_structure` | Project structure (`operation`: targets/files/metadata) |
| `autosnippet_capabilities` | Service capability discovery |

### Candidate Submit (Agent core capability)

| Tool | Description |
|------|-------------|
| `autosnippet_submit_knowledge` | Submit single candidate (**strict validation** — missing required fields rejected immediately, no fallback). Must provide ALL fields in one call: title, language, content(+rationale), kind, doClause, dontClause, whenClause, coreCode, category, trigger, description, headers, usageGuide, knowledgeType, reasoning |
| `autosnippet_submit_knowledge_batch` | Batch submit candidates (per-item strict validation + dedup + rate-limit) |
| `autosnippet_save_document` | Save development document (design doc, debug report, ADR) — title + markdown only |

### Guard & Scan & Bootstrap

| Tool | Description |
|------|-------------|
| `autosnippet_guard` | Code Guard check (`code` single / `files[]` batch — auto-routed) |
| `autosnippet_bootstrap` | Cold-start Mission Briefing (no params — returns project analysis + dimension tasks) |
| `autosnippet_dimension_complete` | Dimension analysis completion (dimensionId + analysisText required) |

### Wiki

| Tool | Description |
|------|-------------|
| `autosnippet_wiki_plan` | Plan Wiki doc generation (scan project → topic data packages) |
| `autosnippet_wiki_finalize` | Finalize Wiki (meta.json + dedup + validation) |

### Task Management

| Tool | Description |
|------|-------------|
| `autosnippet_task` | Unified task & decision management (`operation`: prime/create/claim/close/fail/defer/progress/decompose/record_decision/revise_decision/unpin_decision/list_decisions) |

### Skills Management

| Tool | Description |
|------|-------------|
| `autosnippet_skill` | Skill management (`operation`: list/load/create/update/delete/suggest) |

---

## How Recipes are used in the project

| Use | How |
|-----|-----|
| Audit | `// as:audit` in source; `asd watch` runs AI review against Recipes. Or MCP `autosnippet_guard` |
| Search | `asd search keyword` or MCP `autosnippet_search` (mode=auto/context/keyword/semantic) |
| AI Assistant | Dashboard RAG and AI chat use Recipes as context |
| Xcode | Recipes linked to Snippets; synced to Xcode CodeSnippets |
| Guard | kind=rule Recipes enforced by Guard checks during audit |
| Insights | `autosnippet_knowledge(operation=insights, id)` for quality scores, usage stats, and relation summary |
| Graph | `autosnippet_graph(operation=query/impact/path)` for relationship analysis |

---

## Auto-Extracting Headers for New Candidates

1. From code (Recommended): Extract all import statements from user's code
2. From existing Recipes: Check `references/project-recipes-context.md` index for matching modules, then call MCP `autosnippet_knowledge(operation=get, id)` for full content
3. Via semantic search: Call `autosnippet_search(mode=context)` with query like "import ModuleName headers"

Use Option 1 first, then verify with Option 2 for consistency.
