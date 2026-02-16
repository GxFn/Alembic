# AutoSnippet Copilot Instructions

## 项目概览
- 项目名称：AutoSnippet
- 版本：V2（ESM, SQLite, MCP 31 工具）
- 目标：通过 Recipe 知识库、Guard 规则检查、语义检索构建团队知识管理与代码复用工作流。
- 项目根：包含 `boxspec.json` 的目录。

## 知识库与结构
- 知识库根目录：`AutoSnippet/`（用户项目可通过 boxspec `knowledgeBase.dir` 自定义）
- Recipe：`AutoSnippet/recipes/*.md`（Markdown + Frontmatter + Snippet + Usage Guide）
- **Project Skills**：`AutoSnippet/skills/<name>/SKILL.md`（项目级 AI 知识增强文档，跟随 Git）
- constitution.yaml：`AutoSnippet/constitution.yaml`（权限宪法：角色 + 能力 + 治理规则）
- 运行时 DB：`.autosnippet/autosnippet.db`（SQLite，recipes/candidates/snippets 索引缓存）
- 向量索引：`.autosnippet/context/`（`asd embed` 生成）
- Recipe 统计：`.autosnippet/recipe-stats.json`

## 知识三分类（kind）
知识库中的 Recipe 按 kind 分为三类：
- **rule** — Guard 规则（boundary-constraint），用于代码质量检查
- **pattern** — 可复用代码模式（code-pattern, architecture, best-practice 等）
- **fact** — 结构性知识（code-relation, inheritance, call-chain, data-flow 等）

## 强制规则（必须遵守）
1. **禁止直接修改** 知识库目录内容（`AutoSnippet/recipes/`、`.autosnippet/` 等）。
2. 创建或入库必须走 **Dashboard** 或 MCP 工具流程（`autosnippet_submit_knowledge`、`autosnippet_submit_knowledge_batch`）。
3. **优先使用 Recipe** 作为项目标准；源代码仅作补充。
4. MCP 检索优先：使用 `autosnippet_search` 或 `autosnippet_context_search` 获取语义检索结果。
5. MCP 调用失败时，**不要在同一轮重复重试**，回退到已读文档或静态上下文。
6. Skills 负责语义与流程，MCP 负责能力与调用；不要在 Skill 内硬编码 URL/HTTP。

## MCP 工具速查

### 检索（首选 search / context_search）
- `autosnippet_search` — 统合搜索入口（auto 模式 BM25 + 语义融合去重）
- `autosnippet_context_search` — 智能上下文检索（意图识别 + 4 层漏斗 + 会话连续性）
- `autosnippet_keyword_search` — SQL LIKE 精确关键词
- `autosnippet_semantic_search` — 向量语义搜索

### 知识列表 & 详情
- `autosnippet_list_recipes` / `autosnippet_get_recipe` / `autosnippet_recipe_insights`
- `autosnippet_list_rules` / `autosnippet_list_patterns` / `autosnippet_list_facts`

### 知识图谱
- `autosnippet_graph_query` / `autosnippet_graph_impact` / `autosnippet_graph_path` / `autosnippet_graph_stats`

### 候选提交 & 校验
- `autosnippet_validate_candidate` — 提交前预校验（5 层）
- `autosnippet_check_duplicate` — 相似度检测
- `autosnippet_submit_knowledge` — 单条提交（reasoning 必填）
- `autosnippet_submit_knowledge_batch` — 批量提交（含去重 + 限流）
- `autosnippet_submit_knowledge_batch` — 解析草稿 Markdown 文件
- `autosnippet_enrich_candidates` — AI 补全缺失语义字段

### 项目扫描 & 冷启动
- `autosnippet_get_targets` / `autosnippet_get_target_files` / `autosnippet_get_target_metadata`
- `autosnippet_scan_project` — 轻量探查（文件清单 + Guard 审计）
- `autosnippet_bootstrap_knowledge` — 冷启动知识库初始化（9 维度 + 自动生成 Project Skills）
- `autosnippet_bootstrap_refine` — Bootstrap 候选 AI 润色（summary/insight/relations）

### Guard & 治理
- `autosnippet_guard_check` / `autosnippet_guard_audit_files` / `autosnippet_compliance_report`

### Skills
- `autosnippet_list_skills` — 列出所有可用 Skills（内置 + 项目级）
- `autosnippet_load_skill` — 加载 Skill 完整文档
- `autosnippet_create_skill` — 创建项目级 Skill（写入 `AutoSnippet/skills/`）
- `autosnippet_suggest_skills` — 基于使用模式推荐创建 Skill

### 其它
- `autosnippet_health` / `autosnippet_capabilities` / `autosnippet_confirm_usage`

## Recipe 结构要点
- 必须包含：Frontmatter（`title`、`trigger` 必填）+ `## Snippet / Code Reference` + `## AI Context / Usage Guide`。
- Frontmatter 必填字段（7）：`title`、`trigger`（@开头）、`category`（8 选 1）、`language`、`summary_cn`、`summary_en`、`headers`。
- Usage Guide 必须用 `###` 三级标题分段，列表式书写，禁止一行文字墙。

## Project Skills
- **发现**：`autosnippet_list_skills` — 列出所有可用 Skills（内置 + 项目级）
- **加载**：`autosnippet_load_skill(skillName)` — 获取 Skill 完整操作指南
- **创建**：`autosnippet_create_skill(name, description, content)` — 创建项目级 Skill
- **推荐**：`autosnippet_suggest_skills` — 基于使用模式推荐创建 Skill
- **Bootstrap 自动生成**：冷启动 Phase 5.5 自动生成 4 个 Project Skills（code-standard, architecture, project-profile, agent-guidelines）
- **优先级**：项目级 Skill 同名覆盖内置；宏观知识查 Skill，微观代码模式查 Recipe

## 推荐工作流
- **查找**：`autosnippet_search`（推荐）或 `autosnippet_context_search`（上下文感知）。
- **产出候选**：`autosnippet_validate_candidate` 预校验 → `autosnippet_submit_knowledge` 提交。
- **冷启动**：`autosnippet_bootstrap_knowledge` → `autosnippet_enrich_candidates` → `autosnippet_bootstrap_refine` → 逐 Target 深入 → `autosnippet_submit_knowledge_batch`。
- **Skills 创建**：`autosnippet_suggest_skills` 分析 → `autosnippet_create_skill` 固化知识。
- **采纳反馈**：`autosnippet_confirm_usage`（记录使用量影响排序权重）。

## 与 Cursor 规则联动
- 本文件与 `templates/cursor-rules/autosnippet-conventions.mdc` 保持一致。
- 如有冲突，以 **禁止修改 Knowledge** 与 **Recipe 优先** 原则为准。
