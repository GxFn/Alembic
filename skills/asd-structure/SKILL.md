---
name: asd-structure
description: Discover project structure (targets, files, dependency graph) and browse the knowledge graph (relations between Recipes). Use when the user asks about module structure, project targets, dependency relationships, or knowledge graph navigation.
---

# Alembic — Structure & Dependencies & Knowledge Graph

Use this skill when the user asks about **project structure**, **module targets**, **dependency graph**, or **knowledge graph relationships**.

---

## Project Structure Tools

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `asd_structure(operation=targets)` | List all module Targets (file count, language stats, inferred role) | `includeSummary` |
| `asd_structure(operation=files)` | Get source files for a Target | `targetName` (required) |
| `asd_structure(operation=metadata)` | Target metadata (dependencies, package info, graph edges) | `targetName` (required) |

### Workflow
1. `targets` → see all Targets with roles
2. `files` → drill into specific Target
3. `metadata` → get dependencies and relations

---

## Knowledge Graph Tools

Captures **relationships between Recipes** (dependencies, extensions, conflicts, etc.).

| Tool | Purpose | Key Input |
|------|---------|-----------|
| `asd_graph(operation=query)` | Get all relations for a Recipe node | `nodeId`, `relation`, `direction` |
| `asd_graph(operation=impact)` | Impact analysis: downstream dependencies | `nodeId`, `maxDepth` |
| `asd_graph(operation=path)` | Shortest path between two Recipes (BFS) | `fromId`, `toId` |
| `asd_graph(operation=stats)` | Global graph statistics | — |

### When to use
- "修改这个 Recipe 会影响什么？" → `impact`
- "这两个模块有什么关联？" → `path`
- "知识图谱统计" → `stats`

---

## Dependency Structure File

SPM dependency structure: `Alembic/Alembic.spmmap.json`
- Run `asd spm-map` to refresh (supports SPM / Node / Go / JVM / Python / Dart / Rust)

---

## Related Skills

- **asd-recipes**: Recipe content used as project standards
- **asd-create**: After understanding structure, submit knowledge candidates
