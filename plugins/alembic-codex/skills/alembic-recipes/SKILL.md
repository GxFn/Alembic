---
name: alembic-recipes
description: Use Alembic Recipes as the project's curated source of truth for conventions, code patterns, facts, and Guard standards. Trigger when answering questions about project standards or when implementation should follow local knowledge.
---

# Alembic Recipes

Recipes are Alembic's curated project knowledge: code patterns, usage guides, rules, and structural facts. Prefer Recipe content over raw code search when both are available.

## Knowledge Base Shape

| Part | Purpose |
| --- | --- |
| Recipes | Standard code patterns, rules, and facts used for context, Guard, and search |
| Candidates | Agent-submitted knowledge awaiting user review |
| Context index | Search and semantic context used by `alembic_search` |
| Wiki | Generated project documentation based on approved knowledge |

In standard mode these files usually live under `Alembic/` in the project. In Ghost mode they live under Alembic's external data root for the project. Use MCP tools instead of assuming a physical path.

## Permission Boundary

Allowed:

- Search or browse knowledge with `alembic_search` and `alembic_knowledge`.
- Submit candidates with `alembic_submit_knowledge`.
- Confirm usage with `alembic_knowledge(operation: "confirm_usage")` when the user adopts a Recipe.

Do not:

- Directly edit Recipe files.
- Publish, deprecate, or delete Recipes from the default Codex plugin tier.
- Treat unreviewed candidates as established project standards.

## Lookup Order

1. Call `alembic_task(operation: "prime")` at the start of meaningful coding work.
2. Use `alembic_search(mode: "auto")` for general lookup.
3. Use `alembic_search(mode: "context")` for coding assistance.
4. Use `alembic_knowledge(operation: "list")` with filters when browsing by kind, language, or category.
5. Use `alembic_knowledge(operation: "get", id)` for full Recipe content.

## How To Apply Recipes

- For project standards, cite the Recipe title or trigger when explaining a decision.
- For code suggestions, adapt the Recipe's core code and usage guide to the current file.
- For Guard failures, fix according to the Recipe's do/dont clauses and core code.
- For ambiguous conflicts between code and Recipe, treat the Recipe as the current standard and submit a candidate if the code suggests the standard should evolve.

## Related Skills

- `alembic-create`: Submit candidate knowledge.
- `alembic-guard`: Check code against Recipe standards.
- `alembic-structure`: Inspect project structure and graph context.
