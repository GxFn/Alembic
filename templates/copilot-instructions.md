<!-- autosnippet:begin -->
<!-- On every human message, call autosnippet_ready() as your first action. No exceptions. -->
<!-- On any explicit user agreement/disagreement about a plan/decision, call autosnippet_decide(...) immediately to persist team memory. -->

# AutoSnippet Copilot Instructions

> Every time you receive a message from the user, your **first action** must be:
>
> ```
> autosnippet_ready()
> ```
>
> This applies to every message — questions, follow-ups, confirmations, one-word replies, all of them.
> The call loads live project context; without it your answers will be based on outdated information.
>
> When the user explicitly agrees/disagrees with a方案/约定, your **immediate action** must be:
>
> ```
> autosnippet_decide({ operation: "record" | "revise" | "unpin", ... })
> ```
>
> Persist the decision first, then continue execution.

---

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
1. **每次收到用户消息，第一步调 `autosnippet_ready()`** — 加载最新决策和任务上下文，跳过会导致回答与团队约定矛盾。
2. **当用户明确同意/否决某方案时，立即调用 `autosnippet_decide` 持久化**（record/revise/unpin）— 先写入团队记忆，再继续后续动作。
3. **禁止直接修改** 知识库目录内容（`AutoSnippet/recipes/`、`.autosnippet/` 等）。
4. 创建或入库必须走 **Dashboard** 或 MCP 工具流程（`autosnippet_submit_knowledge`、`autosnippet_submit_knowledge_batch`）。
5. **优先使用 Recipe** 作为项目标准；源代码仅作补充。
6. MCP 检索优先：使用 `autosnippet_search`（默认 auto 融合模式，也可指定 mode=context 做上下文感知检索）。
7. MCP 调用失败时，**不要在同一轮重复重试**，回退到已读文档或静态上下文。
8. Skills 负责语义与流程，MCP 负责能力与调用；不要在 Skill 内硬编码 URL/HTTP。

## MCP 工具速查（20 个整合工具）

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
- `autosnippet_submit_knowledge` — 单条提交（严格前置校验，缺少必要字段直接拒绝不入库。必填: title, language, content(+rationale), kind, doClause, dontClause, whenClause, coreCode, category, trigger, description, headers, usageGuide, knowledgeType, reasoning(+whyStandard+sources+confidence)。所有字段必须在单次调用中一次性提供）
- `autosnippet_submit_knowledge_batch` — 批量提交（含去重 + 限流 + 逐条严格校验，缺字段的条目被拒绝）

### 开发文档
- `autosnippet_save_document` — 保存开发文档（title + markdown，自动发布）

### Guard
- `autosnippet_guard` — 代码规范检查（传 `code` 单文件 / 传 `files[]` 批量审计，自动路由）

### Skills
- `autosnippet_skill` — Skill 管理（`operation`: list / load / create / update / delete / suggest）

### 冷启动 & 扫描
- `autosnippet_bootstrap` — 冷启动 Mission Briefing（无参数，返回项目分析 + 维度任务清单）
- `autosnippet_dimension_complete` — 维度分析完成通知（dimensionId + analysisText 必填）

### Wiki 文档
- `autosnippet_wiki_plan` — Wiki 文档规划（扫描项目生成主题数据包）
- `autosnippet_wiki_finalize` — Wiki 完成（meta.json + 去重 + 验证）

### 任务管理
- `autosnippet_ready` — **每次收到用户消息第一步调用**：加载活跃决策、就绪任务、知识上下文
- `autosnippet_decide` — 决策管理：record / revise / unpin / list（**用户明确同意/否决方案时立即调用并先持久化**）
- `autosnippet_task` — 任务 CRUD：create / claim / close / fail / defer / progress / decompose / dep_add 等
- `asd` — VS Code Agent Mode 专用通道（`#asd` 引用激活，代理所有操作）

### 系统
- `autosnippet_health` — 服务健康状态与知识库统计（可检测空 KB 触发冷启动）
- `autosnippet_capabilities` — 服务能力清单（列出所有可用 MCP 工具，供 Agent 自发现）

### 管理员工具（Admin Tier）
- `autosnippet_enrich_candidates` — 候选字段完整性诊断（不使用 AI）
- `autosnippet_knowledge_lifecycle` — 知识条目生命周期操作（publish/deprecate/reactivate 等）
- `autosnippet_validate_candidate` — 候选结构化预校验（调试用）
- `autosnippet_check_duplicate` — 相似度检测（调试用）

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

## 冷启动必读（首次使用必看）

执行冷启动前，**必须**先加载 Skill 获取完整指引：
```
autosnippet_skill({ operation: "load", name: "autosnippet-coldstart" })
```
Skill 包含：完整的 V3 字段格式、JSON 示例模板、维度分析策略。
**不加载 Skill 直接提交知识会因字段格式问题被反复拒绝。**

## Guard 诊断响应

当编辑器出现来自 "AutoSnippet Guard" 的诊断（黄色/红色波浪线）时：
1. 读取诊断消息中的 `ruleId`
2. 调用 `autosnippet_search(query: ruleId)` 查找对应 Recipe
3. 按 Recipe 的 `doClause` + `coreCode` 修复代码
4. 保存文件并确认诊断消失

灯泡菜单中可快捷搜索知识库或禁用该行检查。

## 决策与任务管理（VS Code Agent Mode）

在 VS Code Agent Mode 中，输入 `#asd` 后跟消息即可激活项目记忆。
工具会自动加载项目决策和任务，Agent 应遵守所有返回的决策。

- `_decisions` / `_activeDecisions` — 必须遵守的团队决策
- `_decisionHint` — 决策行为提示
- 用户同意或否决某方案时，使用 `autosnippet_decide({ operation: "record" })` 记录

### V3 字段格式关键提醒
- `content` **必须是 JSON 对象**（不是字符串）：`{ "pattern": "代码...", "markdown": "## 标题\n正文...", "rationale": "设计原理" }`
- `reasoning` **必须是 JSON 对象**：`{ "whyStandard": "原因", "sources": ["file.ts"], "confidence": 0.85 }`
- `headers` **必须是数组**：`["import Foundation"]`，无 import 时传 `[]`
- 所有 15 个必填字段必须在**单次调用中一次性提供**，缺字段直接拒绝

## 推荐工作流
1. **收到消息后第一步**：`autosnippet_ready()` — 加载决策 + 任务上下文（**每次都要，不可跳过**）
2. **用户同意/否决方案时第一步**：`autosnippet_decide({ operation: "record" | "revise" | "unpin" })` — 先持久化决策再执行。
3. **查找**：`autosnippet_search`（推荐 mode=auto）或 mode=context（上下文感知）。
- **产出候选**：`autosnippet_submit_knowledge` 提交（严格前置校验，必须一次性提供所有必填字段，缺字段直接拒绝不入库）。
- **冷启动**：`autosnippet_bootstrap`（无参数）→ 逐维度分析代码 → `autosnippet_submit_knowledge_batch` → `autosnippet_dimension_complete`。
- **Skills 创建**：`autosnippet_skill` op=suggest 分析 → `autosnippet_skill` op=create 固化知识。
- **采纳反馈**：`autosnippet_knowledge` op=confirm_usage（记录使用量影响排序权重）。

## 与 Cursor 规则联动
- 本文件与 `templates/cursor-rules/autosnippet-conventions.mdc` 保持一致。
- 如有冲突，以 **禁止修改 Knowledge** 与 **Recipe 优先** 原则为准。

---
<!-- REMINDER: If you have not yet called autosnippet_ready(), do it now before responding. -->
<!-- REMINDER: If user has explicitly agreed/disagreed with a plan, call autosnippet_decide(...) before continuing. -->
<!-- autosnippet:end -->
