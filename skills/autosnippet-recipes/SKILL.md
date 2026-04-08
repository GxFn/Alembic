---
name: autosnippet-recipes
description: Provides this project's Recipe-based context to the agent. Recipes are the project's standard knowledge (code patterns + usage guides + structured relations). Use when answering about project standards, Guard, conventions, or when suggesting code. Supports in-context lookup, terminal search (asd search), and on-demand semantic search via MCP tool autosnippet_search (mode=context).
---

# AutoSnippet Recipe Context (Project Context)

This skill provides the agent with this project's context from AutoSnippet Recipes. Recipes are the project's standard knowledge base: code patterns, usage guides, and structured relations.

---

## Knowledge Base Overview

| Part | Location | Purpose |
|------|----------|---------|
| **Recipes** | `AutoSnippet/recipes/*.md` | Standard code patterns + usage guides; used for AI context, Guard, search |
| **Snippets** | `AutoSnippet/snippets/*.json` | Code snippets synced to IDE via `asd install` |
| **Candidates** | `AutoSnippet/.autosnippet/candidates.json` | AI-scanned candidates; review in Dashboard then approve |
| **Context index** | `AutoSnippet/.autosnippet/context/` | Vector index built by `asd embed`; semantic search via `autosnippet_search(mode=context)` |

**Recipe** = one `.md` file = one specific usage pattern or code snippet. **kind**: `rule` (Guard enforced) / `pattern` (best practice) / `fact` (structural knowledge). **Recipe over project code**: When both exist, prefer Recipe as curated standard.

---

## Agent Permission Boundary

| Allowed | Forbidden |
|---------|-----------|
| Submit candidates (`autosnippet_submit_knowledge` / `_batch`) | Directly create/modify Recipes |
| Search/query (`autosnippet_search` / `autosnippet_knowledge`) | Publish/deprecate/delete |
| Confirm usage (`confirm_usage`) | Write to `AutoSnippet/recipes/` |

---

## How to Find Recipes

1. **In-context index**: Read `references/project-recipes-context.md` in this skill folder
2. **MCP browse**: `autosnippet_knowledge(operation=list)` with kind/language/category filters
3. **MCP get**: `autosnippet_knowledge(operation=get, id)` for full content
4. **MCP search**: `autosnippet_search(mode=auto)` for unified FieldWeighted+semantic search
5. **Terminal**: `asd search <keyword>`

**Recipe over code search**: When both find matches, prefer Recipe as source of truth. Cite Recipe title.

---

## How to Use This Context

1. **Project standards/Guard**: Use Recipe content as source of truth
2. **"How we do X here"**: Base answer on Recipe content
3. **Suggesting code**: Cite Recipe's code snippet, not raw search results
4. **Guard/Audit**: `// as:audit` or MCP `autosnippet_guard` — both use Recipes as standard
5. **Confirm adoption**: `autosnippet_knowledge(operation=confirm_usage, id, usageType)` when user uses a Recipe

---

## Auto-Extracting Headers for New Candidates

1. **From code** (Recommended): Extract all import statements from user's code
2. **From existing Recipes**: Check index for matching modules, then `autosnippet_knowledge(operation=get, id)` for full content
3. **Via semantic search**: `autosnippet_search(mode=context)` with query like "import ModuleName"

---

## Related Skills

- **autosnippet-create**: Submit knowledge candidates (V3 fields, validation, lifecycle)
- **autosnippet-guard**: Code compliance checking against Recipe standards
- **autosnippet-structure**: Project structure and knowledge graph
