# AutoSnippet Copilot Instructions

## 项目概览
- 项目名称：AutoSnippet
- 版本：V3（ESM, SQLite, MCP 11 工具 — 整合版）
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
4. MCP 检索优先：使用 `autosnippet_search`（默认 auto 融合模式，也可指定 mode=context 做上下文感知检索）。
5. MCP 调用失败时，**不要在同一轮重复重试**，回退到已读文档或静态上下文。
6. Skills 负责语义与流程，MCP 负责能力与调用；不要在 Skill 内硬编码 URL/HTTP。

## MCP 工具速查（12 个整合工具）

### 检索
- `autosnippet_search` — 统合搜索入口（通过 `mode` 参数切换）
  - `mode=auto`（默认）— BM25 + 语义融合去重
  - `mode=context` — 智能上下文检索（4 层漏斗 + 会话连续性），支持 `sessionHistory`/`language`
  - `mode=keyword` — SQL LIKE 精确关键词
  - `mode=semantic` — 向量语义搜索

### 知识浏览
- `autosnippet_knowledge` — 统一知识访问入口（通过 `operation` 参数切换）
  - `operation=list` — 列出 Recipe/Rule/Pattern/Fact（支持 `kind`/`language`/`category`/`status` 多条件过滤）
  - `operation=get` — 按 ID 获取单个 Recipe 详情
  - `operation=insights` — 获取 Recipe 质量洞察（分数/统计/关系）
  - `operation=confirm_usage` — 确认 Recipe 被采纳/应用

### 项目结构
- `autosnippet_structure` — SPM Target 结构发现（`operation`: targets / files / metadata）

### 知识图谱
- `autosnippet_graph` — 图谱查询（`operation`: query / impact / path / stats）

### 候选提交
- `autosnippet_submit_knowledge` — 单条提交（严格前置校验，缺少必要字段直接拒绝不入库。必填: title, language, content(+rationale), kind, doClause, category, trigger, description, headers, usageGuide, knowledgeType。所有字段必须在单次调用中一次性提供）
- `autosnippet_submit_knowledge_batch` — 批量提交（含去重 + 限流 + 逐条严格校验，缺字段的条目被拒绝）

### 开发文档
- `autosnippet_save_document` — 保存开发文档（title + markdown，自动发布）

### Guard
- `autosnippet_guard` — 代码规范检查（传 `code` 单文件 / 传 `files[]` 批量审计，自动路由）

### Skills
- `autosnippet_skill` — Skill 管理（`operation`: list / load / create / update / delete / suggest）

### 冷启动 & 扫描
- `autosnippet_bootstrap` — 项目冷启动与扫描（`operation`: knowledge / refine / scan）

### 系统
- `autosnippet_health` — 服务健康状态与知识库统计（可检测空 KB 触发冷启动）
- `autosnippet_capabilities` — 服务能力清单（列出所有可用 MCP 工具，供 Agent 自发现）

## Recipe 结构要点
- 必须包含：Frontmatter（`title`、`trigger` 必填）+ `## Snippet / Code Reference` + `## AI Context / Usage Guide`。
- Frontmatter 必填字段（7）：`title`、`trigger`（@开头）、`category`（8 选 1）、`language`、`summary_cn`、`summary_en`、`headers`。
- Usage Guide 必须用 `###` 三级标题分段，列表式书写，禁止一行文字墙。

## Project Skills
- **发现**：`autosnippet_skill` — `operation=list` 列出所有可用 Skills（内置 + 项目级）
- **加载**：`autosnippet_skill` — `operation=load, name=<skillName>` 获取 Skill 完整操作指南
- **创建**：`autosnippet_skill` — `operation=create, name, description, content` 创建项目级 Skill
- **推荐**：`autosnippet_skill` — `operation=suggest` 基于使用模式推荐创建 Skill
- **Bootstrap 自动生成**：冷启动 Phase 5.5 自动生成 4 个 Project Skills（code-standard, architecture, project-profile, agent-guidelines）
- **优先级**：项目级 Skill 同名覆盖内置；宏观知识查 Skill，微观代码模式查 Recipe

## 推荐工作流
- **查找**：`autosnippet_search`（推荐 mode=auto）或 `autosnippet_search` mode=context（上下文感知）。
- **产出候选**：`autosnippet_submit_knowledge` 提交（严格前置校验，必须一次性提供所有必填字段，缺字段直接拒绝不入库）。
- **冷启动**：`autosnippet_bootstrap` op=knowledge → `autosnippet_bootstrap` op=refine → 逐 Target 深入 → `autosnippet_submit_knowledge_batch`。
- **Skills 创建**：`autosnippet_skill` op=suggest 分析 → `autosnippet_skill` op=create 固化知识。
- **采纳反馈**：`autosnippet_knowledge` op=confirm_usage（记录使用量影响排序权重）。

## 与 Cursor 规则联动
- 本文件与 `templates/cursor-rules/autosnippet-conventions.mdc` 保持一致。
- 如有冲突，以 **禁止修改 Knowledge** 与 **Recipe 优先** 原则为准。
