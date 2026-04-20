# MCP 工具参考

Alembic 通过 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 向 IDE 中的 AI 助手提供知识库访问能力。

---

## 概述

MCP 服务器通过 stdio 协议运行，IDE（Cursor / VS Code / Trae / Qoder / Claude Code）自动启动并连接。

**共 16 个工具：**
- **Agent Tier (14)** — IDE AI 可直接调用
- **Admin Tier (2)** — 管理员/CI 工具

所有工具经过 Gateway 管线校验（validate → guard → route → audit）。

---

## Agent Tier 工具

### 1. alembic_health

服务健康状态与知识库统计。

**参数：** 无

**返回示例：**
```json
{
  "status": "ok",
  "knowledgeCount": 42,
  "candidateCount": 15,
  "aiProvider": "gemini",
  "dbConnected": true
}
```

---

### 2. alembic_search

统合搜索知识库。支持多种搜索模式，自动选择最优策略。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | ✅ | 搜索查询 |
| `mode` | string | — | 搜索模式：`auto` / `keyword` / `weighted` / `semantic` / `context`（默认 `auto`） |
| `type` | string | — | 类型过滤：`all` / `recipe` / `solution` / `rule` |
| `limit` | number | — | 最大结果数（默认 10） |
| `language` | string | — | 语言过滤 |

**搜索模式：**

| 模式 | 检索管线 | 场景 |
|------|---------|------|
| `auto` | 自动选择 | 默认推荐 |
| `keyword` | 精确关键词匹配 | 已知确切术语 |
| `weighted` | 加权字段评分 | 常规查询 |
| `semantic` | 向量语义相似度 | 概念性/模糊查询 |
| `context` | 4 层检索漏斗 (keyword→semantic→fusion→rerank) | 最高质量检索 |

---

### 3. alembic_knowledge

知识浏览。获取、列表或确认知识条目使用。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | 操作类型：`list` / `get` / `insights` / `confirm_usage` |
| `id` | string | — | 知识条目 ID（`get` / `confirm_usage` 时必填） |
| `page` | number | — | 页码（`list` 时） |
| `limit` | number | — | 每页数量 |
| `filter` | object | — | 过滤条件 |

**operation 说明：**

| 操作 | 作用 |
|------|------|
| `list` | 列出知识条目，支持分页和过滤 |
| `get` | 获取单个条目完整内容 |
| `insights` | 获取知识库洞察（统计、趋势、质量分布） |
| `confirm_usage` | 确认 AI 已使用某条知识（更新使用计数） |

---

### 4. alembic_structure

项目结构探查。帮助 AI 理解项目组织方式。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | 操作类型：`targets` / `files` / `metadata` |
| `target` | string | — | 目标路径（`files` 时） |

**operation 说明：**

| 操作 | 作用 |
|------|------|
| `targets` | 列出项目中的所有模块/Target |
| `files` | 列出指定 Target 内的文件 |
| `metadata` | 获取项目元数据（语言、框架、依赖） |

---

### 5. alembic_graph

知识图谱查询。分析条目间的关联关系。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | 操作类型：`query` / `impact` / `path` / `stats` |
| `id` | string | — | 起始节点 ID |
| `targetId` | string | — | 目标节点 ID（`path` 时） |

**operation 说明：**

| 操作 | 作用 |
|------|------|
| `query` | 查询节点的直接关联 |
| `impact` | 分析变更影响范围 |
| `path` | 查找两个节点间的关联路径 |
| `stats` | 图谱统计（节点数、边数、密度） |

---

### 6. alembic_guard

代码规范检查。检查代码片段或文件列表是否符合 Guard 规则。输出三态结果（pass / violation / uncertain），三维报告（合规度 + 覆盖率 + 置信度）。ReverseGuard 反向验证 Recipe 引用的 API 符号是否仍存在于代码中。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | — | 要检查的代码（与 `files` 二选一） |
| `files` | string[] | — | 要检查的文件路径列表 |
| `language` | string | — | 代码语言（`code` 模式时） |
| `scope` | string | — | 检查范围：`file` / `target` / `project` |

---

### 7. alembic_submit_knowledge

统一知识提交（单条/批量/文档）。使用 `items` 数组格式传入 1~N 条。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `items` | object[] | ✅ | 知识条目数组。每条字段详见下方 |
| `target_name` | string | — | 批量来源标识，如 `network-module-scan` |
| `source` | string | — | 来源标记，默认 `mcp` |
| `deduplicate` | boolean | — | 批量时基于 title 自动去重，默认 `true` |
| `skipConsolidation` | boolean | — | 跳过融合分析（确认独立新建时设为 `true`） |
| `skipDuplicateCheck` | boolean | — | 跳过去重检测 |
| `client_id` | string | — | 客户端 ID |
| `dimensionId` | string | — | 冷启动关联维度 ID |

**items 元素字段（完整知识条目）：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 知识标题 |
| `language` | string | ✅ | 编程语言 |
| `content` | object | ✅ | `{ markdown, pattern?, rationale }` 内容对象 |
| `kind` | string | ✅ | 类型：`rule` / `pattern` / `fact` |
| `doClause` | string | ✅ | 英文祈使句正向规则 |
| `dontClause` | string | ✅ | 英文反向约束 |
| `whenClause` | string | ✅ | 英文触发场景描述 |
| `coreCode` | string | ✅ | 3-8 行纯代码骨架 |
| `category` | string | ✅ | 分类 |
| `trigger` | string | ✅ | `@kebab-case` 唯一标识符 |
| `description` | string | ✅ | 中文简述 ≤80 字 |
| `headers` | array | ✅ | import 语句数组 |
| `usageGuide` | string | ✅ | 使用指南 |
| `knowledgeType` | string | ✅ | 知识类型 |
| `reasoning` | object | ✅ | `{ whyStandard, sources, confidence }` 推理 |

**文档保存模式（items 元素设 `knowledgeType: 'dev-document'`，仅需 `title` + `markdown`）。**

---

### 8. alembic_skill

Skill 管理。创建、加载、更新、删除项目 Skills。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | 操作：`list` / `load` / `create` / `update` / `delete` / `suggest` |
| `name` | string | — | Skill 名称（`load`/`update`/`delete` 时必填） |
| `content` | string | — | Skill 内容（`create`/`update` 时必填） |

---

### 9. alembic_bootstrap

冷启动 — 无需参数，自动分析项目（AST、依赖图、Guard 审计），返回 Mission Briefing。

---

### 9b. alembic_rescan

增量重扫描 — 保留已审核 Recipe，清理衍生缓存，重新执行 Phase 1-4 分析，运行 RecipeRelevanceAuditor 5 维证据审计。返回 Mission Briefing（含 allRecipes 完整内容 + auditHint + evolutionGuide）。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dimensions` | string[] | — | 指定维度列表，空 = 全部活跃维度 |
| `reason` | string | — | 触发原因（记录到报告） |

---

### 9c. alembic_evolve

批量 Recipe 进化决策。双入口工具：
- **Rescan 模式**：每维度内先 evolve 再 gap-fill（evolve → submit_knowledge → dimension_complete）
- **独立模式**：用户主动触发，验证 Recipe 有效性

三种决策类型：
- `propose_evolution` — 代码已变更，建议更新 Recipe（进入观察窗口）
- `confirm_deprecation` — 模式已消失，立即废弃 Recipe
- `skip` — `still_valid`（刷新 lastVerifiedAt）或 `insufficient_info`

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `decisions` | array | ✅ | 进化决策数组 |
| `decisions[].recipeId` | string | ✅ | 目标 Recipe ID |
| `decisions[].action` | string | ✅ | `propose_evolution` / `confirm_deprecation` / `skip` |
| `decisions[].evidence` | object | — | `propose_evolution` 时必填：`{ codeSnippet, filePath, type, suggestedChanges }` |
| `decisions[].reason` | string | — | `confirm_deprecation` 时必填，废弃原因 |
| `decisions[].skipReason` | string | — | `skip` 时必填：`still_valid` / `insufficient_info` |

---

### 10. alembic_dimension_complete

维度分析完成通知 — Agent 完成一个冷启动维度的分析后调用。负责 Recipe 关联、Skill 生成、Checkpoint 保存、进度推送。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dimensionId` | string | ✅ | 维度 ID（如 `project-profile`、`language-scans`） |
| `analysisText` | string | ✅ | 分析报告全文（Markdown） |
| `sessionId` | string | — | bootstrap 返回的 session.id（可选，自动查找） |
| `submittedRecipeIds` | string[] | — | 本维度提交的 recipe ID 列表 |
| `keyFindings` | string[] | — | 关键发现摘要（3-5 条） |
| `candidateCount` | number | — | 本维度提交的候选数量 |

---

### 11. alembic_wiki

Wiki 文档生成。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | `plan`（规划主题 + 数据包）/ `finalize`（写入 meta.json + 验证） |
| `language` | string | — | Wiki 文档语言：`zh`（默认）/ `en` |
| `sessionId` | string | — | bootstrap session ID |
| `articlesWritten` | string[] | — | finalize 时：已写入的文件路径列表 |

---

### 12. alembic_panorama

项目全景查询。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | — | `overview`（默认）/ `module` / `gaps` / `health` / `governance_cycle` / `decay_report` / `staging_check` / `enhancement_suggestions` |
| `module` | string | — | 模块名（`module` 操作时必填） |

**操作说明：**

| 操作 | 说明 |
|------|------|
| `overview` | 全局全景：分层架构、模块角色、耦合度 |
| `module` | 单模块详情：角色、层级、耦合度、知识覆盖率 |
| `gaps` | 知识空白 + 能力缺口报告 |
| `health` | 项目健康度评分 |
| `governance_cycle` | 知识治理周期：矛盾/冗余/衰退检测结果 |
| `decay_report` | 衰退报告：decayScore 详情 + 建议 |
| `staging_check` | staging 暂存期状态检查 |
| `enhancement_suggestions` | 进化建议：合并/增强/拆分提案 |

---

### 13. alembic_task

任务与决策管理（5 operations）。每次对话开始时先调用 `prime` 加载知识上下文。

`prime` 操作内部流程：
1. **IntentExtractor** 提取意图：交叉语言同义词展开、技术术语提取、文件上下文推断、场景分类
2. **PrimeSearchPipeline** 多路并行搜索 + RRF 融合 + 三层质量过滤（绝对阈值 + 相对阈值 + 梯度截断）
3. 返回 Recipe + Guard 规则 + sourceRefs（项目文件路径证据）

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | 操作：`prime` / `create` / `close` / `fail` / `record_decision` |
| `id` | string | — | 任务 ID（close/fail） |
| `title` | string | — | 任务标题（create）/ 决策标题（record_decision） |
| `description` | string | — | 任务描述（create） |
| `reason` | string | — | 原因（close/fail） |

---

## Admin Tier 工具

### 14. alembic_enrich_candidates

候选字段完整性诊断（纯逻辑检查，不调用 AI）。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `candidateIds` | string[] | ✅ | 候选条目 ID 列表 |

---

### 15. alembic_knowledge_lifecycle

知识条目生命周期操作。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 知识条目 ID |
| `action` | string | ✅ | 操作：`submit` / `approve` / `reject` / `publish` / `deprecate` / `reactivate` / `to_draft` / `fast_track` |
| `reason` | string | — | 操作原因 |

**六态生命周期状态图：**

```
pending → staging (72h Grace) → active → evolving (7d Grace) → active
  ↑                                 │
  └── reactivate ── deprecated ── decaying (30d + 3x 确认)
```

staging、evolving、decaying 为系统驱动的中间态，Agent 只能推入中间态，系统规则完成最终转换。

---

---

## Gateway 权限映射

MCP 工具与 Gateway Action 的映射关系：

| 工具 | Gateway Action | 角色要求 |
|------|---------------|---------|
| `alembic_search` | `read:recipes` | 所有角色 |
| `alembic_knowledge` (list/get) | `read:recipes` | 所有角色 |
| `alembic_submit_knowledge` | `submit:knowledge` | `external_agent` / `developer` |
| `alembic_guard` | `read:guard_rules` | 所有角色 |
| `alembic_skill` (create) | `create:skills` | `external_agent` / `developer` |
| `alembic_bootstrap` | `knowledge:bootstrap` | `external_agent` / `developer` |
| `alembic_rescan` | `knowledge:bootstrap` | `external_agent` / `developer` |
| `alembic_evolve` | `knowledge:evolve` | `external_agent` / `developer` |
| `alembic_task` | `task:create` / `task:update`（按 operation 路由） | `external_agent` / `developer` |
| `alembic_knowledge_lifecycle` | 按 action 动态路由 | `developer` |

---

## IDE 配置

### Cursor

`.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "alembic": {
      "command": "node",
      "args": ["/path/to/alembic/bin/mcp-server.js"],
      "env": { "ALEMBIC_PROJECT_ROOT": "/path/to/your-project" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:
```json
{
  "servers": {
    "alembic": {
      "command": "node",
      "args": ["/path/to/alembic/bin/mcp-server.js"],
      "env": { "ALEMBIC_PROJECT_ROOT": "/path/to/your-project" }
    }
  }
}
```

这些配置由 `alembic setup` 自动生成。
