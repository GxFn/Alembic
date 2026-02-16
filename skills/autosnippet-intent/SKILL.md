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

## MCP tools (reference only)

- System: `autosnippet_health`, `autosnippet_capabilities`
- Search: `autosnippet_search`, `autosnippet_context_search`, `autosnippet_keyword_search`, `autosnippet_semantic_search`
- Browse: `autosnippet_list_recipes`, `autosnippet_get_recipe`, `autosnippet_list_rules`, `autosnippet_list_patterns`, `autosnippet_list_facts`
- Insights: `autosnippet_recipe_insights`, `autosnippet_compliance_report`
- Graph: `autosnippet_graph_query`, `autosnippet_graph_impact`, `autosnippet_graph_path`, `autosnippet_graph_stats`
- Structure: `autosnippet_get_targets`, `autosnippet_get_target_files`, `autosnippet_get_target_metadata`
- Candidates: `autosnippet_validate_candidate`, `autosnippet_check_duplicate`, `autosnippet_submit_candidate`, `autosnippet_submit_candidates`, `autosnippet_submit_draft_recipes`, `autosnippet_enrich_candidates`
- Guard: `autosnippet_guard_check`, `autosnippet_guard_audit_files`, `autosnippet_scan_project`
- Telemetry: `autosnippet_confirm_usage`
- Bootstrap: `autosnippet_bootstrap_knowledge`, `autosnippet_bootstrap_refine`
- Skills: `autosnippet_list_skills`, `autosnippet_load_skill`, `autosnippet_create_skill`, `autosnippet_update_skill`, `autosnippet_delete_skill`, `autosnippet_suggest_skills`

This skill is a router only; it does not perform actions itself.

```
