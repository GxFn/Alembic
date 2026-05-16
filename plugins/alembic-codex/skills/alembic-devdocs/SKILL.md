---
name: alembic-devdocs
description: Generate Alembic Wiki documentation through `alembic_wiki` using plan, article writing, and finalize.
---

# Alembic Wiki Documentation

Use this skill when the user asks to generate project docs, write wiki pages, refresh documentation after bootstrap, or turn Alembic knowledge into readable project documentation.

## Tools

| Tool | Operation | Use |
| --- | --- | --- |
| `alembic_wiki` | `plan` | Plan topics and return data packages |
| `alembic_wiki` | `finalize` | Validate written articles and create wiki metadata |
| `alembic_search` | any | Fetch additional knowledge context |
| `alembic_knowledge` | `get` | Retrieve full Recipe content |

## Workflow

1. Call `alembic_wiki` with `operation: "plan"` and optional `language`.
2. For each planned topic, write a focused Markdown article using the returned data package.
3. Store articles in the wiki directory for the current Alembic workspace. In standard mode this is usually `Alembic/wiki/`; in Ghost mode it lives under the external Alembic data root.
4. Call `alembic_wiki` with `operation: "finalize"`, the `sessionId`, and `articlesWritten`.

Plan call:

```json
{
  "operation": "plan",
  "language": "en"
}
```

Finalize call:

```json
{
  "operation": "finalize",
  "sessionId": "<session-id-from-plan>",
  "articlesWritten": [
    "Alembic/wiki/network-client.md",
    "Alembic/wiki/routing.md"
  ]
}
```

If the workspace is in Ghost mode, replace those paths with the actual external wiki paths returned or implied by the Alembic workspace.

## Writing Guidelines

- Use Recipe content as the source of truth.
- Cite Recipe titles or triggers when explaining standards.
- Include concrete file paths and class/function names.
- For architecture docs, use Context, Design, Implementation, and Trade-offs.
- For pattern docs, use When to Use, How to Use, Code Example, and Anti-patterns.
- Do not publish lifecycle changes while writing docs.

## Language

Use `"en"` for English documentation and `"zh"` for Chinese documentation.
