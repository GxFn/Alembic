---
name: alembic-devdocs
description: Generate and publish project Wiki documentation using asd_wiki MCP tool (plan → write → finalize). Use when user says "generate wiki/docs", "write documentation", or agent needs to produce structured project documentation from the knowledge base.
---

# Alembic — Wiki Documentation Generation

This skill guides the agent through generating structured **Wiki documentation** from the Alembic knowledge base using the `asd_wiki` MCP tool.

## When to use this skill

- User asks to **generate project documentation** or **wiki**
- After a **cold-start bootstrap** completes — produce docs from newly captured knowledge
- When the user says "generate docs" / "write wiki" / "create documentation"
- After significant **knowledge base changes** — refresh documentation

## MCP Tools

| Tool | Operation | Description |
|------|-----------|-------------|
| `asd_wiki` | `plan` | Plan topics + data packages (returns topic list + per-topic data for writing) |
| `asd_wiki` | `finalize` | Complete generation (write meta.json, dedup check, validate completeness) |
| `asd_search` | — | Search knowledge for additional context during writing |
| `asd_knowledge` | `get` | Retrieve full Recipe content for reference |

## Workflow

### Step 1: Plan topics

```json
{
  "operation": "plan",
  "language": "en"
}
```

Returns:
- **topics[]** — Recommended documentation topics based on knowledge base content
- **dataPackages** — Per-topic data bundles (related Recipes, code patterns, architecture info)
- **sessionId** — Session identifier for the finalize step

### Step 2: Write articles

For each topic in the plan:
1. Read the **dataPackage** for that topic
2. Write a well-structured Markdown article to the wiki directory (`Alembic/wiki/`)
3. Use Recipe content as source of truth — cite Recipe titles
4. Follow the structure: Overview → Details → Code Examples → Related Topics

### Step 3: Finalize

```json
{
  "operation": "finalize",
  "sessionId": "<from plan>",
  "articlesWritten": ["Alembic/wiki/topic-1.md", "Alembic/wiki/topic-2.md"]
}
```

This triggers:
- **meta.json** generation — topic index with cross-references
- **Dedup check** — detect overlapping articles
- **Completeness validation** — ensure all planned topics are covered

## Writing guidelines

- Use **clear headings** (`##`, `###`) — helps search and scanning
- Include a **summary section** at the top of each article
- Reference **file paths** and **class names** concretely — improves search relevance
- Cite **Recipe triggers** (e.g., `@bilidili-feature-url-routing`) as knowledge sources
- For architecture docs: Context → Design → Implementation → Trade-offs
- For pattern docs: When to Use → How to Use → Code Example → Anti-patterns

## Language parameter

| Value | Effect |
|-------|--------|
| `"en"` | English documentation (default) |
| `"zh"` | Chinese documentation |

## Related Skills

| Skill | When to use |
|-------|-------------|
| `alembic-create` | Submitting **code patterns/recipes** to KB (not documents) |
| `alembic-devdocs` (this) | Generating **Wiki documentation** from KB |
| `alembic-recipes` | Looking up existing knowledge for reference |
