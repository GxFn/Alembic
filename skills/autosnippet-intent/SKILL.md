---
name: autosnippet-intent
description: A light-weight router skill. Decide which AutoSnippet capability should be used (recipes/search/create/candidates/guard/structure/concepts). Use this to pick the right skill, then delegate to that skill for detailed steps.
---

# AutoSnippet — Intent Router

Use this skill when the user's intent is unclear or overlaps multiple capabilities. Your job is to select **one** primary capability, then hand off to the specific skill.

## Decision map (pick one primary path)

| User intent / situation | Primary skill | Notes |
|---|---|---|
| "冷启动 / 初始化知识库 / 首次接入 / bootstrap" | **autosnippet-coldstart** | Full 9-dimension cold-start. |
| "全项目分析 / 提取架构模式 / 生成知识库" | **autosnippet-coldstart** | Same — full project analysis. |
| "有没有现成写法 / 查一下规范 / 给我标准代码" | **autosnippet-recipes** | Use Recipe context first. |
| "把这段加入知识库 / 提交到知识库" | **autosnippet-create** | Submit via Dashboard or draft. |
| "生成候选 / 批量扫描 / 扫 Target" | **autosnippet-candidates** | Generate rich candidates. |
| "帮我审计 / Lint / 规范检查" | **autosnippet-guard** | Use Recipe as audit standard. |
| "依赖关系 / 目标结构 / targets / spmmap" | **autosnippet-structure** | Targets + dep graph. |
| "知识库/Recipe/Trigger 是什么" | **autosnippet-concepts** | Explain concepts. |
| "补全候选字段 / enrich / 深度分析" | **autosnippet-analysis** | Semantic enrichment. |

## Rules

1. **Pick one primary path**. Avoid sending multiple flows unless the user explicitly asks.
2. **Do not force a flow**. Recommend softly (“可以…”), and only when relevant.
3. After choosing, **use the chosen skill** for the detailed steps.

## Deprecated skills (removed — do not reference)

- `autosnippet-when` → replaced by this skill (autosnippet-intent)
- `autosnippet-search` → merged into autosnippet-recipes
- `autosnippet-batch-scan` / `autosnippet-recipe-candidates` → merged into autosnippet-candidates
- `autosnippet-dep-graph` → merged into autosnippet-structure

## MCP tools (reference only — 12 个整合工具)

- System: `autosnippet_health`, `autosnippet_capabilities`
- Search: `autosnippet_search` (mode: auto / context / keyword / semantic)
- Knowledge: `autosnippet_knowledge` (operation: list / get / insights / confirm_usage)
- Graph: `autosnippet_graph` (operation: query / impact / path / stats)
- Structure: `autosnippet_structure` (operation: targets / files / metadata)
- Submit: `autosnippet_submit_knowledge`, `autosnippet_submit_knowledge_batch`
- Document: `autosnippet_save_document`
- Guard: `autosnippet_guard` (code 单文件 / files[] 批量)
- Bootstrap: `autosnippet_bootstrap` (no params — Mission Briefing) + `autosnippet_dimension_complete`
- Skills: `autosnippet_skill` (operation: list / load / create / update / delete / suggest)

This skill is a router only; it does not perform actions itself.

```
