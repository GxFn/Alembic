---
name: alembic-recipes
description: Provides this project's Recipe-based context to the agent. Recipes are the project's standard knowledge (code patterns + usage guides + structured relations). Use when answering about project standards, Guard, conventions, or when suggesting code. Supports in-context lookup, terminal search (alembic search), and on-demand semantic search via MCP tool alembic_search (mode=context).
---

# Alembic Recipe Context (Project Context)

This skill provides the agent with this project's context from Alembic Recipes. Recipes are the project's standard knowledge base: code patterns, usage guides, and structured relations.

---

## Knowledge Base Overview

| Part | Location | Purpose |
|------|----------|---------|
| **Recipes** | `Alembic/recipes/*.md` | Standard code patterns + usage guides; used for AI context, Guard, search |
| **Snippets** | `Alembic/snippets/*.json` | Code snippets synced to IDE via `alembic install` |
| **Candidates** | `Alembic/.asd/candidates.json` | AI-scanned candidates; review in Dashboard then approve |
| **Context index** | `Alembic/.asd/context/` | Vector index built by `alembic embed`; semantic search via `alembic_search(mode=context)` |

**Recipe** = one `.md` file = one specific usage pattern or code snippet. **kind**: `rule` (Guard enforced) / `pattern` (best practice) / `fact` (structural knowledge). **Recipe over project code**: When both exist, prefer Recipe as curated standard.

---

## Agent Permission Boundary

| Allowed | Forbidden |
|---------|-----------|
| Submit candidates (`alembic_submit_knowledge` / `_batch`) | Directly create/modify Recipes |
| Search/query (`alembic_search` / `alembic_knowledge`) | Publish/deprecate/delete |
| Confirm usage (`confirm_usage`) | Write to `Alembic/recipes/` |

---

## How to Find Recipes

1. **In-context index**: Read `references/project-recipes-context.md` in this skill folder
2. **MCP browse**: `alembic_knowledge(operation=list)` with kind/language/category filters
3. **MCP get**: `alembic_knowledge(operation=get, id)` for full content
4. **MCP search**: `alembic_search(mode=auto)` for unified FieldWeighted+semantic search
5. **Terminal**: `alembic search <keyword>`

**Recipe over code search**: When both find matches, prefer Recipe as source of truth. Cite Recipe title.

---

## How to Use This Context

1. **Project standards/Guard**: Use Recipe content as source of truth
2. **"How we do X here"**: Base answer on Recipe content
3. **Suggesting code**: Cite Recipe's code snippet, not raw search results
4. **Guard/Audit**: `// as:audit` or MCP `alembic_guard` — both use Recipes as standard
5. **Confirm adoption**: `alembic_knowledge(operation=confirm_usage, id, usageType)` when user uses a Recipe

---

## Auto-Extracting Headers for New Candidates

1. **From code** (Recommended): Extract all import statements from user's code
2. **From existing Recipes**: Check index for matching modules, then `alembic_knowledge(operation=get, id)` for full content
3. **Via semantic search**: `alembic_search(mode=context)` with query like "import ModuleName"

---

## Related Skills

- **alembic-create**: Submit knowledge candidates (V3 fields, validation, lifecycle)
- **alembic-guard**: Code compliance checking against Recipe standards
- **alembic-structure**: Project structure and knowledge graph
