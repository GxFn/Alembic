---
name: autosnippet-structure
description: Discover project structure (targets, files, dependency graph) and browse the knowledge graph (relations between Recipes). Use when the user asks about module structure, SPM targets, dependency relationships, or knowledge graph navigation.
---

# AutoSnippet — Structure & Dependencies & Knowledge Graph

> Self-check & Fallback: MCP 工具返回统一 JSON Envelope（{ success, errorCode?, message?, data?, meta }）。重操作前调用 `autosnippet_health`；失败时不在同一轮重试，转用静态上下文或缩小范围后再试。

Use this skill when the user asks about **project structure**, **SPM targets**, **dependency graph**, or **knowledge graph relationships**.

## When to use

- "有哪些 Target？"
- "某个 Target 包含哪些文件？"
- "依赖关系/谁依赖谁？"
- "SPM 结构/模块拓扑"
- "这两个 Recipe 之间有什么关联？"
- "知识图谱统计 / 关联密度"
- "修改这个 Recipe 会影响哪些？"

---

## MCP Tools — Project Structure

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `autosnippet_structure(operation=targets)` | List all SPM Targets (with file count, language stats, inferred role) | `includeSummary` (default true) |
| `autosnippet_structure(operation=files)` | Get source files for a Target | `targetName` (required), `includeContent`, `contentMaxLines`, `maxFiles` |
| `autosnippet_structure(operation=metadata)` | Get Target metadata (dependencies, package info, inferred role, graph edges) | `targetName` (required) |

### Workflow: Discover project structure
1. `autosnippet_structure(operation=targets)` → see all Targets with roles
2. `autosnippet_structure(operation=files, targetName)` → drill into specific Target
3. `autosnippet_structure(operation=metadata, targetName)` → get dependencies and relations

---

## MCP Tools — Knowledge Graph

The knowledge graph captures **relationships between Recipes** (dependencies, extensions, conflicts, etc.).

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `autosnippet_graph(operation=query)` | Get all relations for a Recipe node | `nodeId` (Recipe ID), `relation` (filter), `direction` (out/in/both) |
| `autosnippet_graph(operation=impact)` | Impact analysis: what downstream depends on this Recipe | `nodeId`, `maxDepth` (default 3) |
| `autosnippet_graph(operation=path)` | Find shortest path between two Recipes (BFS) | `fromId`, `toId`, `maxDepth` (1-10) |
| `autosnippet_graph(operation=stats)` | Global graph statistics: edge count, relation type distribution | (none) |

### Workflow: Explore knowledge graph
1. `autosnippet_graph(operation=stats)` → overview: how many edges, relation types
2. `autosnippet_graph(operation=query, nodeId)` → see all connections for a specific Recipe
3. `autosnippet_graph(operation=impact, nodeId)` → before changing a Recipe, check downstream impact
4. `autosnippet_graph(operation=path, fromId, toId)` → discover indirect relationships between Recipes

### When to use graph tools
- User asks "修改这个 Recipe 会影响什么？" → `autosnippet_graph(operation=impact)`
- User asks "这两个模块有什么关联？" → `autosnippet_graph(operation=path)`
- User wants overview of knowledge connections → `autosnippet_graph(operation=stats)`
- User wants to see all dependencies/extends/conflicts for a Recipe → `autosnippet_graph(operation=query)`

---

## Dependency Structure File

The SPM dependency structure is stored in `AutoSnippet/AutoSnippet.spmmap.json`:
- **`graph.packages`**: Package declarations with targets
- **`graph.edges`**: "from depends on to" relationships
- **Update**: Run `asd spm-map` from project root to refresh

---

## Notes

- Keep results concise: show target name, type, path, and key dependencies.
- If a user requests code generation, switch to **autosnippet-recipes** or **autosnippet-candidates** after clarifying the structure.
- Use Dashboard dep graph visualization for team presentations (requires `asd ui`).

---

## Related Skills

- **autosnippet-recipes**: Recipe content used as project standards.
- **autosnippet-candidates**: After understanding structure, generate candidates per Target.
- **autosnippet-analysis**: Deep project analysis uses structure + graph tools.

```
