# MCP 工具参考

AutoSnippet 通过 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 向 IDE 中的 AI 助手提供知识库访问能力。

---

## 概述

MCP 服务器通过 stdio 协议运行，IDE（Cursor / VS Code / Trae / Qoder / Claude Code）自动启动并连接。

**共 16 个工具：**
- **Agent Tier (12)** — IDE AI 可直接调用
- **Admin Tier (4)** — 管理员/CI 工具

所有工具经过 Gateway 管线校验（validate → guard → route → audit）。

---

## Agent Tier 工具

### 1. autosnippet_health

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

### 2. autosnippet_search

统合搜索知识库。支持多种搜索模式，自动选择最优策略。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | ✅ | 搜索查询 |
| `mode` | string | — | 搜索模式：`auto` / `keyword` / `bm25` / `semantic` / `context`（默认 `auto`） |
| `type` | string | — | 类型过滤：`all` / `recipe` / `solution` / `rule` |
| `limit` | number | — | 最大结果数（默认 10） |
| `language` | string | — | 语言过滤 |

**搜索模式：**

| 模式 | 检索管线 | 场景 |
|------|---------|------|
| `auto` | 自动选择 | 默认推荐 |
| `keyword` | 精确关键词匹配 | 已知确切术语 |
| `bm25` | BM25 (TF-IDF) 评分 | 常规查询 |
| `semantic` | 向量语义相似度 | 概念性/模糊查询 |
| `context` | 4 层检索漏斗 (keyword→semantic→fusion→rerank) | 最高质量检索 |

---

### 3. autosnippet_knowledge

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

### 4. autosnippet_structure

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

### 5. autosnippet_graph

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

### 6. autosnippet_guard

代码规范检查。检查代码片段或文件列表是否符合 Guard 规则。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | — | 要检查的代码（与 `files` 二选一） |
| `files` | string[] | — | 要检查的文件路径列表 |
| `language` | string | — | 代码语言（`code` 模式时） |
| `scope` | string | — | 检查范围：`file` / `target` / `project` |

---

### 7. autosnippet_submit_knowledge

提交单条知识。会经过严格的前置校验和去重检测。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 知识标题 |
| `language` | string | ✅ | 编程语言 |
| `content` | string | ✅ | 代码内容 |
| `kind` | string | ✅ | 类型：`rule` / `pattern` / `fact` |
| `category` | string | ✅ | 分类 |
| `knowledgeType` | string | ✅ | 知识类型（如 `code-pattern`, `code-standard` 等） |
| `description` | string | ✅ | 描述 |
| `doClause` | string | ✅ | "应该做什么"的规则描述 |
| `trigger` | string | ✅ | 触发条件 |
| `headers` | object | ✅ | 头信息（do, trigger, usageGuide） |
| `usageGuide` | string | ✅ | 使用指南 |
| `reasoning` | string | — | 推理过程（chat_agent 角色必填） |

---

### 8. autosnippet_submit_knowledge_batch

批量提交知识条目。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target_name` | string | ✅ | 目标/模块名称 |
| `items` | object[] | ✅ | 知识条目数组（每个元素结构同 `autosnippet_submit_knowledge`） |

---

### 9. autosnippet_save_document

保存开发文档到知识库。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 文档标题 |
| `markdown` | string | ✅ | Markdown 内容 |

---

### 10. autosnippet_skill

Skill 管理。创建、加载、更新、删除项目 Skills。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | 操作：`list` / `load` / `create` / `update` / `delete` / `suggest` |
| `name` | string | — | Skill 名称（`load`/`update`/`delete` 时必填） |
| `content` | string | — | Skill 内容（`create`/`update` 时必填） |

---

### 11. autosnippet_bootstrap

冷启动和扫描操作。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `operation` | string | ✅ | 操作：`knowledge` / `refine` / `scan` |
| `target` | string | — | 扫描目标路径（`scan` 时） |
| `dimensions` | string[] | — | 指定维度（`knowledge` 时） |
| `maxFiles` | number | — | 最大文件数 |

**operation 说明：**

| 操作 | 作用 |
|------|------|
| `knowledge` | 全量冷启动（多维度分析 + AI 填充） |
| `refine` | 润色现有候选条目（AI 增强描述和元数据） |
| `scan` | 扫描指定目标（等同于 `asd ais`） |

---

### 12. autosnippet_capabilities

列出所有可用 MCP 工具概览。帮助 AI 了解自己能做什么。

**参数：** 无

---

## Admin Tier 工具

### 13. autosnippet_enrich_candidates

候选字段完整性诊断（纯逻辑检查，不调用 AI）。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `candidateIds` | string[] | ✅ | 候选条目 ID 列表 |

---

### 14. autosnippet_knowledge_lifecycle

知识条目生命周期操作。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 知识条目 ID |
| `action` | string | ✅ | 操作：`submit` / `approve` / `reject` / `publish` / `deprecate` / `reactivate` / `to_draft` / `fast_track` |
| `reason` | string | — | 操作原因 |

**生命周期状态图：**

```
draft → pending → approved → active → deprecated
  ↑        ↓          ↓                    ↓
  └── rejected   ← to_draft ←─────── reactivate
```

---

### 15. autosnippet_validate_candidate

独立候选结构化预校验（5 层检查）。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `candidate` | object | ✅ | 候选条目对象 |

**校验层次：**
1. 必填字段完整性
2. 字段格式合规
3. 内容质量评估
4. 语义重复检测
5. 知识类型合规

---

### 16. autosnippet_check_duplicate

相似度检测，检查候选是否与现有知识重复。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `candidate` | object | ✅ | 候选条目对象 |

**返回：**
```json
{
  "isDuplicate": false,
  "similarEntries": [
    { "id": "...", "title": "...", "similarity": 0.82 }
  ],
  "threshold": 0.85
}
```

---

## Gateway 权限映射

MCP 工具与 Gateway Action 的映射关系：

| 工具 | Gateway Action | 角色要求 |
|------|---------------|---------|
| `autosnippet_search` | `read:recipes` | 所有角色 |
| `autosnippet_knowledge` (list/get) | `read:recipes` | 所有角色 |
| `autosnippet_submit_knowledge` | `submit:knowledge` | `external_agent` / `developer` |
| `autosnippet_guard` | `read:guard_rules` | 所有角色 |
| `autosnippet_skill` (create) | `create:skills` | `external_agent` / `developer` |
| `autosnippet_bootstrap` | `knowledge:bootstrap` | `external_agent` / `developer` |
| `autosnippet_knowledge_lifecycle` | 按 action 动态路由 | `developer` |

---

## IDE 配置

### Cursor

`.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "autosnippet": {
      "command": "node",
      "args": ["/path/to/autosnippet/bin/mcp-server.js"],
      "env": { "ASD_PROJECT_ROOT": "/path/to/your-project" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:
```json
{
  "servers": {
    "autosnippet": {
      "command": "node",
      "args": ["/path/to/autosnippet/bin/mcp-server.js"],
      "env": { "ASD_PROJECT_ROOT": "/path/to/your-project" }
    }
  }
}
```

这些配置由 `asd setup` 自动生成。
