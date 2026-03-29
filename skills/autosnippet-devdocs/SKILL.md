---
name: autosnippet-devdocs
description: Teaches the agent how to save development documents (architecture decisions, debug reports, design docs, research notes) to the AutoSnippet knowledge base using autosnippet_submit_knowledge with knowledgeType 'dev-document'. Use when the agent finishes analysis, debugging, design, or research and wants to persist the findings.
---

# AutoSnippet — Save Development Documents

This skill tells the agent how to **save development documents** (architecture decisions, debug reports, design docs, research notes) to the AutoSnippet knowledge base, so they can be retrieved by future sessions.

## When to use this skill

- After finishing a **debug/troubleshooting session** — save the root cause analysis
- After making an **architecture or design decision** — save the ADR (Architecture Decision Record)
- After completing a **research or investigation** — save findings and conclusions
- After a **performance analysis** — save the benchmark results and optimization notes
- When the user says "保存这个分析" / "记录一下" / "save this to KB"

## MCP Tool

| Tool | Description |
|------|-------------|
| `autosnippet_submit_knowledge` | Unified knowledge submission. For documents, set item `knowledgeType: 'dev-document'` — only needs `title` + `markdown`. Auto-published, no review needed. |
| `autosnippet_search` | Search saved documents by keyword or semantic query. |

## How to save a document

Call `autosnippet_submit_knowledge` with an `items` array containing one document entry:

```json
{
  "items": [{
    "title": "BiliDemo 冷启动性能分析",
    "markdown": "## 问题背景\n\n冷启动耗时 8s...\n\n## 根因分析\n\n...\n\n## 解决方案\n\n...",
    "knowledgeType": "dev-document",
    "description": "冷启动耗时 8s 的根因分析和优化方案",
    "tags": ["debug-report", "performance"],
    "scope": "project-specific"
  }]
}
```

### Required fields

| Field | Description |
|-------|-------------|
| `title` | Document title (Chinese or English) |
| `markdown` | Full Markdown content |

### Optional fields

| Field | Default | Description |
|-------|---------|-------------|
| `description` | `""` | One-line summary |
| `tags` | `[]` | Labels for filtering: `adr`, `debug-report`, `design-doc`, `research`, `performance`, `refactoring` |
| `scope` | `project-specific` | `universal` or `project-specific` |

## Recommended tags

| Tag | Use case |
|-----|----------|
| `adr` | Architecture Decision Record |
| `debug-report` | Bug investigation / root cause analysis |
| `design-doc` | Module/feature design document |
| `research` | Technology research or investigation |
| `performance` | Benchmark results, profiling analysis |
| `refactoring` | Refactoring plan or post-mortem |
| `migration` | Migration guide or plan |
| `meeting-notes` | Technical meeting summary |

## How documents are delivered to Cursor

Documents are stored as `knowledgeType: 'dev-document'` in the knowledge DB. They follow a dedicated delivery path:

1. **NOT compressed** into Cursor Rules (Channel A/B skip dev-documents)
2. **Full text** written to `.cursor/skills/autosnippet-devdocs/references/*.md` (Channel D)
3. **Searchable** via `autosnippet_search("your query")` — full-text search hits documents

## Document format tips

- Use **clear headings** (`##`, `###`) — helps search and scanning
- Include a **summary section** at the top
- Reference **file paths** and **class names** concretely — improves search relevance
- For ADRs, use the structure: Context → Decision → Consequences
- For debug reports: Symptom → Investigation → Root Cause → Fix

## Related Skills

| Skill | When to use |
|-------|-------------|
| `autosnippet-create` | Saving **code patterns/recipes** (needs trigger, doClause, etc.) |
| `autosnippet-devdocs` (this) | Saving **prose documents** (only needs title + markdown) |
| `autosnippet-recipes` | Looking up existing knowledge |
