---
name: autosnippet-recipes
description: Provides this project's Recipe-based context to the agent. Recipes are the project's standard knowledge (code patterns + usage guides + structured relations). Use when answering about project standards, Guard, conventions, or when suggesting code. Supports in-context lookup, terminal search (asd search), and on-demand semantic search via MCP tool autosnippet_context_search.
---

# AutoSnippet Recipe Context (Project Context)

> Self-check and Fallback: MCP tools return unified JSON Envelope. Before heavy ops call autosnippet_health/autosnippet_capabilities. On failure do not retry in same turn; use static context or narrow scope.

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

1. **Project context**: Read `references/project-recipes-context.md` in this skill folder for **Recipe 轻量索引**（title/trigger/category/summary 表格）。如需 Recipe 全文，调用 MCP `autosnippet_get_recipe(id)` 或 `autosnippet_search(query)`。索引缺失时，可直接读 `AutoSnippet/recipes/` 目录。

2. **Finding code on demand**: Look up matching Recipe by title/summary/usage guide, use its code as standard to suggest. Cite the Recipe title.

3. **Recipe over code search**: When both Recipe and code search find matches, prefer Recipe as source of truth.

4. **Search - three ways**:
   - In-context: `references/project-recipes-context.md` 轻量索引按 title/trigger/summary 匹配
   - Terminal: `asd search <keyword>` or `asd search --semantic <keyword>`
   - MCP: `autosnippet_context_search` with query and optional limit

5. **Browsing Recipes via MCP**:
   - `autosnippet_list_recipes` - list with kind/language/category/knowledgeType/status/complexity filters
   - `autosnippet_get_recipe` - get single Recipe by ID (full content/relations/constraints)
   - `autosnippet_list_facts` - list kind=fact structural knowledge

6. **Confirming usage**: Call `autosnippet_confirm_usage` with recipeId and usageType (adoption/application) when user adopts a Recipe. Telemetry only.

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

## MCP Tools Reference (38 tools)

### Query (Agent can freely use)

| Tool | Description |
|------|-------------|
| autosnippet_health | Health check |
| autosnippet_capabilities | List all tool capabilities |
| autosnippet_search | Unified search (auto: BM25+semantic fusion) |
| autosnippet_context_search | Smart context retrieval (intent → multi-agent → 4-layer funnel) |
| autosnippet_keyword_search | SQL LIKE exact keyword search |
| autosnippet_semantic_search | Vector semantic search |
| autosnippet_list_rules | List kind=rule |
| autosnippet_list_patterns | List kind=pattern |
| autosnippet_list_facts | List kind=fact |
| autosnippet_list_recipes | General list (multi-filter) |
| autosnippet_get_recipe | Get Recipe details |
| autosnippet_recipe_insights | Recipe quality insights (scores, usage stats, relations summary) |
| autosnippet_compliance_report | Compliance assessment report |
| autosnippet_graph_query | Knowledge graph query |
| autosnippet_graph_impact | Graph impact analysis |
| autosnippet_graph_path | Graph path finding (BFS shortest path between Recipes) |
| autosnippet_graph_stats | Graph global statistics (edge count, relation distribution) |
| autosnippet_get_targets | List project Targets |
| autosnippet_get_target_files | Get Target file list |
| autosnippet_get_target_metadata | Get Target metadata |

### Candidate Submit/Validate (Agent core capability)

| Tool | Description |
|------|-------------|
| autosnippet_submit_knowledge | Submit single candidate (supports structured content) |
| autosnippet_submit_knowledge_batch | Batch submit candidates |
| autosnippet_submit_knowledge_batch | Submit draft .md files as candidates |
| autosnippet_validate_candidate | Validate candidate quality |
| autosnippet_check_duplicate | Dedup check |
| autosnippet_enrich_candidates | AI semantic field enrichment for candidates |

### Guard & Scan

| Tool | Description |
|------|-------------|
| autosnippet_guard_check | Single code Guard rule check |
| autosnippet_guard_audit_files | Multi-file batch Guard audit |
| autosnippet_scan_project | Lightweight project scan + Guard audit |
| autosnippet_bootstrap_knowledge | Cold-start knowledge base initialization (9 dimensions) |
| autosnippet_bootstrap_refine | AI refinement of bootstrap candidates (Phase 6) |

### Skills Management

| Tool | Description |
|------|-------------|
| autosnippet_list_skills | List all available Agent Skills |
| autosnippet_load_skill | Load Skill document for domain guidance |
| autosnippet_create_skill | Create project-level Skill |
| autosnippet_update_skill | Update project-level Skill |
| autosnippet_delete_skill | Delete project-level Skill |
| autosnippet_suggest_skills | AI-powered Skill creation suggestions |

### Usage Telemetry

| Tool | Description |
|------|-------------|
| autosnippet_confirm_usage | Confirm Recipe adopted/applied |

---

## How Recipes are used in the project

| Use | How |
|-----|-----|
| Audit | `// as:audit` in source; `asd watch` runs AI review against Recipes. Or MCP `autosnippet_guard_check` / `autosnippet_guard_audit_files` |
| Search | `asd search keyword` or MCP `autosnippet_search` / `autosnippet_context_search` |
| AI Assistant | Dashboard RAG and AI chat use Recipes as context |
| Xcode | Recipes linked to Snippets; synced to Xcode CodeSnippets |
| Guard | kind=rule Recipes enforced by Guard checks during audit |
| Insights | `autosnippet_recipe_insights` for quality scores, usage stats, and relation summary |
| Graph | `autosnippet_graph_query` / `autosnippet_graph_impact` / `autosnippet_graph_path` for relationship analysis |

---

## Auto-Extracting Headers for New Candidates

1. From code (Recommended): Extract all import statements from user's code
2. From existing Recipes: Check `references/project-recipes-context.md` index for matching modules, then call MCP `autosnippet_get_recipe(id)` for full content
3. Via semantic search: Call `autosnippet_context_search` with query like "import ModuleName headers"

Use Option 1 first, then verify with Option 2 for consistency.
