---
name: autosnippet-create
description: Submit knowledge to AutoSnippet. Covers single/batch MCP submission, V3 field requirements, quality validation, and lifecycle. Use when user says "提交知识/加入知识库/create recipe" or agent needs to persist code patterns, rules, or facts.
---

# AutoSnippet Create — 知识提交

> 前置：MCP 工具返回统一 JSON Envelope `{ success, errorCode?, message?, data?, meta }`。操作前调用 `autosnippet_health` 确认服务可用。

本 Skill 指导 Agent 将代码模式、规则、事实提交到 AutoSnippet 知识库。提交后的条目进入 **Candidates**（pending 状态），用户在 Dashboard 审核后发布。

关联 Skill：**autosnippet-recipes**（检索已有知识）。

---

## 提交路径

| 路径 | 工具 | 适用场景 |
|------|------|----------|
| **单条提交** | `autosnippet_submit_knowledge` | Agent 精心构造一条完整知识 |
| **批量提交** | `autosnippet_submit_knowledge_batch` | 冷启动维度分析、批量扫描 |
| **Dashboard** | 浏览器 `http://localhost:3000` | 用户手动粘贴/扫描文件 |

**Agent 首选 MCP 提交**，无需浏览器。

---

## 单条提交 — autosnippet_submit_knowledge

一次提交一条完整的 V3 知识条目。即使部分字段校验未通过也会入库，返回中附带 `recipeReadyHints` 提示缺失字段。

### V3 必填字段（16 个）

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 知识标题，简洁明确 |
| `description` | string | 一句话描述用途 |
| `trigger` | string | 触发关键词，如 `@NetworkMonitor` |
| `language` | string | 编程语言，如 `typescript`、`swift` |
| `kind` | enum | `rule`（规范）/ `pattern`（模式）/ `fact`（事实） |
| `category` | string | `View`/`Service`/`Tool`/`Model`/`Network`/`Storage`/`UI`/`Utility` |
| `knowledgeType` | string | 知识类型标识 |
| `doClause` | string | ✅ 应该做什么（Channel A+B 硬依赖） |
| `dontClause` | string | ❌ 不应该做什么 |
| `whenClause` | string | 何时适用（Channel B 硬依赖） |
| `coreCode` | string | 核心代码片段 |
| `headers` | string[] | 完整 import 语句列表 |
| `usageGuide` | string | 使用指南（Markdown，见下方格式要求） |
| `content` | object | `{ markdown: string, rationale: string }` 至少提供 markdown |
| `reasoning` | object | `{ whyStandard: string, sources: string[], confidence: number }` |

### 可选字段

`topicHint`、`complexity`（beginner/intermediate/advanced）、`scope`（universal/project-specific/target-specific）、`tags`（string[]）、`constraints`、`relations`、`skipDuplicateCheck`（默认 false）

### usageGuide 格式要求

**必须**使用 Markdown 分节，禁止写成一行长文本。

```markdown
### 何时用
- 场景 A
- 场景 B

### 何时不用
- 排除场景

### 使用步骤
1. 第一步
2. 第二步

### 关键点
- 注意事项 A
- 注意事项 B
```

可选章节：依赖与前置条件、错误处理、性能与资源、安全与合规、常见误用、替代方案、相关知识。

---

## 批量提交 — autosnippet_submit_knowledge_batch

一次提交多条知识。每条单独校验，不通过的拒绝但不阻塞其他。

### 参数

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `target_name` | ✅ | string | 批量来源标识（如 `network-module-scan`） |
| `items` | ✅ | object[] | 知识条目数组，每条结构同单条提交的字段 |
| `source` | | string | 来源标记，默认 `cursor-scan` |
| `deduplicate` | | boolean | 基于 title 去重，默认 `true` |

### 返回值

```json
{
  "count": 3,
  "total": 5,
  "ids": ["id1", "id2", "id3"],
  "errors": ["item[2]: missing doClause"],
  "rejectedItems": [2, 4],
  "rejectedSummary": { "commonMissingFields": ["doClause", "reasoning"] }
}
```

**批量提交校验更严格**：单条提交校验不通过仍入库（附 hints），**批量提交校验不通过直接拒绝**。

---

## 提交工作流

### 标准流程（Agent 通过 MCP）

```
1. 分析代码 → 构造 V3 字段
2. autosnippet_submit_knowledge / _batch → 入库为 pending
3. 检查返回值：
   - 成功 → 告知用户"已提交，请在 Dashboard Candidates 审核"
   - 有 rejectedItems → 根据 rejectedSummary.commonMissingFields 补全后重试
4. [可选] autosnippet_enrich_candidates → 诊断候选字段完整性
```

### 一条知识一个场景

拆分原则：不同使用场景、不同 API 入口、不同配置方式→各自一条知识。禁止将多个模式合并为一条。

---

## 提交后管理

| 需求 | 工具 |
|------|------|
| 查看候选状态 | `autosnippet_knowledge(operation=list)` |
| 诊断缺失字段 | `autosnippet_enrich_candidates` |
| 审核/发布 | `autosnippet_knowledge_lifecycle(operation=approve/publish/fast_track)` |
| 搜索已有知识避免重复 | `autosnippet_search(mode=context, query=...)` |

---

## kind 路由与管线影响

| kind | 用途 | 管线产出 |
|------|------|----------|
| `rule` | 编码规范、约束 | → Channel A（.mdc 规则文件） |
| `pattern` | 代码模式、用法 | → Channel B（.mdc 模式文件 + Snippet） |
| `fact` | 项目事实、架构决策 | → 搜索/Guard 上下文，不直接产出文件 |

`doClause` 是 Channel A+B 的**硬依赖**——缺少此字段则完全无法生成 .mdc 文件。

---

## 示例：提交一条知识

```json
{
  "title": "Network Monitor — 网络状态监听",
  "description": "使用 NWPathMonitor 监听网络连通性变化",
  "trigger": "@NetworkMonitor",
  "language": "swift",
  "kind": "pattern",
  "category": "Network",
  "knowledgeType": "api-usage",
  "doClause": "使用 NWPathMonitor 监听网络状态变化，在主队列回调更新 UI",
  "dontClause": "不要用 Reachability 旧库，不要在后台线程直接更新 UI",
  "whenClause": "需要实时感知网络连通性变化时",
  "coreCode": "let monitor = NWPathMonitor()\nmonitor.pathUpdateHandler = { path in\n  DispatchQueue.main.async {\n    self.isConnected = path.status == .satisfied\n  }\n}\nmonitor.start(queue: DispatchQueue.global())",
  "headers": ["import Network"],
  "usageGuide": "### 何时用\n- App 需要实时网络状态\n- 启动时初始化一次\n\n### 关键点\n- 单例模式访问 sharedMonitor\n- start() 开始监听，cancel() 停止\n- 回调在 global queue，更新 UI 需切主线程",
  "content": {
    "markdown": "NWPathMonitor 是 iOS 12+ 推荐的网络状态监听方案，替代废弃的 Reachability。",
    "rationale": "Apple 官方推荐，线程安全，支持蜂窝/WiFi/有线判断。"
  },
  "reasoning": {
    "whyStandard": "Apple Developer Documentation 推荐方案，替代 SCNetworkReachability",
    "sources": ["Apple Developer Documentation - NWPathMonitor"],
    "confidence": 0.95
  }
}
```
