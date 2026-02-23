---
name: autosnippet-concepts
description: Teaches the agent AutoSnippet's core concepts: knowledge base (知识库), Recipe (配方), Snippet, Candidates, context storage (向量库), and where they live. Recipe priority over project implementation. Includes capability and content summary. Use when the user asks about "知识库", Recipe, Snippet, 向量库, or the structure of AutoSnippet project data.
---

# AutoSnippet Concepts (Knowledge Base and Recipe)

This skill explains [AutoSnippet](https://github.com/GxFn/AutoSnippet)'s **knowledge base** (知识库) and related concepts so the agent can answer "what is X" and "where does Y live."

## Instructions for the agent

1. **Project root** = directory containing `AutoSnippet/AutoSnippet.boxspec.json`. All paths below are relative to the project root.
2. For **looking up** existing Recipe content or **searching** recipes, use the **autosnippet-recipes** skill.
3. For **creating** a new Recipe or Snippet, use the **autosnippet-create** skill.
4. For **project structure** (targets/dep graph), use **autosnippet-structure**.

5. **Self-check & Fallback (统一 Envelope)**
  - Before heavy operations, call `autosnippet_health`.
  - All MCP tools return a JSON Envelope: `{ success, errorCode?, message?, data?, meta }`.
  - On failure or empty results, do NOT retry within the same cycle; fall back to static context or ask user for minimal confirmation, then continue with reduced scope.

---

## Knowledge base (知识库)

In AutoSnippet, the **知识库** is the set of project-owned artifacts under **`AutoSnippet/`** used for standards, reuse, and AI context:

| Part | Location | Meaning |
|------|----------|---------|
| **Snippets** | AutoSnippet 根 spec `list` 或 `AutoSnippet/snippets/*.json` | Code snippets synced to IDE (Xcode CodeSnippets / VSCode .code-snippets); developers use them by trigger (completion). |
| **Recipes** | `AutoSnippet/recipes/*.md` (or `recipes.dir` in root spec) | Markdown docs: standard code + usage guide; used for AI context, Guard, and search. |
| **Candidates** | `AutoSnippet/.autosnippet/candidates.json` | AI-scanned candidates; review in Dashboard **Candidates** then approve or delete. |
| **Context index** | `AutoSnippet/.autosnippet/context/` | Vector index built by `asd embed`; used for on-demand semantic search and Guard. |

---

## Context Storage and Vector Store

The knowledge base has **context storage** capability: Recipes, docs, etc. are embedded and support semantic search. The agent queries on demand via MCP tool `autosnippet_search(mode=context)` without preloading all content.

**Safety and role statement**:
- Context storage and vector store are **safe** external storage; they only hold project knowledge (Recipes, docs, etc.), with no user privacy or sensitive data exposure risk.
- **Skills express semantics** (when to query, what to query, how to use); **MCP provides capability** (connection, retrieval, response).
- **Cursor can use Context storage and vector store as external context**: call `autosnippet_search(mode=context)` on demand to fetch relevant chunks instead of loading all knowledge into the conversation, thus **saving context space** (tokens/context window).

| Item | Description |
|------|-------------|
| **Storage path** | `AutoSnippet/.autosnippet/context/` |
| **Build command** | Run `asd embed` from project root |
| **Index sources** | `recipe` (AutoSnippet/recipes/*.md), `doc` (docs dir), `target-readme` (module target READMEs) |
| **Storage adapter** | Default `json` |
| **Usage** | With `asd ui` running, MCP tool `autosnippet_search(mode=context)` takes `query`, `limit?` for semantic search |
| **Use cases** | On-demand lookup of relevant Recipe/docs; Guard review against knowledge base; Dashboard semantic search |

**Prerequisites**: `asd embed` run, `asd ui` started, MCP configured.

**Usage guidance for Cursor**: Assume `asd ui` is kept running when calling MCP tools (`autosnippet_search`, etc.). If a call fails (e.g. connection refused, API error), do **not** retry within the current agent cycle; fall back to static index (`references/project-recipes-context.md` 轻量索引) or in-context lookup instead.

**Envelope reading guidance**:
- Parse Envelope fields:
  - `success === true` → use `data` and respect `meta.source`.
  - `success === false` → check `errorCode` and `message`; propose safe fallback.
- Preferred fallbacks:
  - Use local static context and previously loaded Recipe docs.
  - Narrow query (reduce `limit`, add keywords), or switch intent (e.g., from semantic search to direct Recipe lookup).
  - If operation requires UI (open/create/submit) and fails, inform the user and provide minimal manual steps.

**Self-check & safety**:
- Use `autosnippet_health` to verify UI and service availability before heavy operations.
- Authentication and HTTP wiring live in MCP, not in Skills. Do not hardcode URLs/HTTP in Skills.

---

## MCP Tool Map (Concept-level)

This is a conceptual map. Skills stay semantic; MCP provides capability.

| Intent | Primary tool(s) |
|---|---|
| 统合搜索 | `autosnippet_search`（mode=auto 融合 BM25+语义） |
| 语义检索 | `autosnippet_search(mode=context)` |
| 精确检索 | `autosnippet_search(mode=keyword)` |
| 向量搜索 | `autosnippet_search(mode=semantic)` |
| 知识浏览 | `autosnippet_knowledge(operation=list/get/insights)` |
| 结构发现 | `autosnippet_structure(operation=targets/files/metadata)` |
| 知识图谱 | `autosnippet_graph(operation=query/impact/path/stats)` |
| 候选提交 | `autosnippet_submit_knowledge`, `autosnippet_submit_knowledge_batch` |
| Guard 检查 | `autosnippet_guard`（code 单条 / files[] 批量 — 自动路由） |
| 使用确认 | `autosnippet_knowledge(operation=confirm_usage)` |
| 项目扫描 | `autosnippet_bootstrap(operation=scan)` |
| 冷启动 | `autosnippet_bootstrap(operation=knowledge/refine)` |
| Skills 管理 | `autosnippet_skill(operation=list/load/create/update/delete/suggest)` |
| 自检 | `autosnippet_health` |

### Failure Handling (Examples)
- 检索失败（`SEARCH_FAILED`）：改用静态 Recipe 目录或缩小关键词后再试（下一轮）。
- 目标文件获取失败（`GET_TARGET_FILES_FAILED`）：提示检查 `asd ui` 与 `targetName`，改为从本地源路径列举（下一轮）。
- 候选提交失败（`SUBMIT_FAILED`）：检查必填字段是否齐全；缩小批次后重试（下一轮）。
- Guard 检查失败（`GUARD_ERROR`）：提示检查 `asd ui` 运行状态；降级到静态 Recipe 比对。

---

## Recipe (配方)

- **Definition**: One Recipe = one `.md` file in `AutoSnippet/recipes/` (or the path in root spec `recipes.dir`). **Each Recipe represents a SINGLE independent usage pattern or code snippet**.
- **Content**: YAML frontmatter (id, title, trigger, summary, language, category, …) + body with **Snippet / Code Reference** (fenced code block) and **AI Context / Usage Guide**.
- **Granularity**: 
  - ✅ **One Recipe = One specific usage scenario**: e.g. "Load URL in WebView", "Make network request with retry", "Handle async error".
  - ❌ **NOT a comprehensive tutorial**: Don't put multiple patterns (e.g. "async/await basics + Promise.all + error handling") into one Recipe.
  - ✅ **Documentation-only is OK**: Recipe can be pure doc/guide without code snippet, for concepts or best practices.
  - ✅ **Code = single focused example**: If Recipe includes code, it should be ONE focused, reusable code snippet for ONE specific use case.
- **Role**: The unit of "project standard" for a given pattern or module; used for Guard, search, AI Assistant, and (optionally) linked Snippet.
- **Lookup**: Use the **autosnippet-recipes** skill to read or search Recipe content.

### Recipe 结构（新版）

**完整 Recipe Markdown 必须包含：**
1. **Frontmatter**（`---` 包裹的 YAML，`title`、`trigger` 必填）
2. **Snippet / Code Reference** 标题 + 代码块
3. **AI Context / Usage Guide** 标题 + 使用说明

**CRITICAL RULES for Frontmatter fields:**
- **`category`**: MUST be ONE of these 8 values: `View`, `Service`, `Tool`, `Model`, `Network`, `Storage`, `UI`, `Utility`. NEVER use module names (e.g. "BDNetworkControl") or custom categories.
- **`headers`**: MUST be complete import/include statements from the code. Examples by language:
  - Swift: `["import Foundation"]`
  - ObjC: `["#import <Module/Header.h>"]`
  - Go: `["import \"fmt\""]`
  - Python: `["import os"]` / `["from pathlib import Path"]`
  - Java: `["import java.util.List;"]`
  - Kotlin: `["import kotlinx.coroutines.*"]`
  - JS/TS: `["import fs from 'node:fs'"]`
  - Dart: `["import 'package:flutter/material.dart'"]`
  - Rust: `["use std::collections::HashMap;"]`
- **`trigger`**: MUST start with `@` (e.g. `@request-manager`). kebab-case, no spaces.
- **`language`**: MUST be one of the supported languages (lowercase): `swift`, `objectivec`, `go`, `python`, `java`, `kotlin`, `javascript`, `typescript`, `dart`, `rust`.
- **`kind`**: MUST be one of: `rule`, `pattern`, `fact`.
- **`doClause`**: English imperative sentence, ≤60 tokens.
- **`description`**: 中文摘要 ≤80字。
- **`content`**: 对象 `{ markdown (≥200字), pattern (核心代码), rationale (设计原理) }`。
- **`usageGuide`**: Markdown `###` 章节格式的使用指南。
- **`knowledgeType`**: 如 `code-pattern` / `architecture` / `best-practice` / `code-standard` 等。
- **`reasoning`**: `{ whyStandard, sources[], confidence }`。

**Standard Category Definitions (8 categories - MUST use exactly these):**

| Category | When to Use | Examples |
|----------|-------------|----------|
| `View` | UI components, view controllers, custom views | React Component, SwiftUI View, UIViewController, Android Activity |
| `Service` | Business logic services, managers, coordinators | UserService, LocationManager, PaymentCoordinator |
| `Tool` | Utility classes, helpers, extensions | StringHelper, DateFormatter, validation utils |
| `Model` | Data models, entities, value objects | User model, APIResponse, configuration objects |
| `Network` | Network requests, API clients, HTTP/WebSocket | fetch/axios wrapper, URLSession, OkHttp, net/http |
| `Storage` | Persistence, caching, database operations | SQLite, Redis, UserDefaults, file I/O, cache manager |
| `UI` | UI-related utilities not specific to one view | Theme manager, color palette, UI constants |
| `Utility` | General utilities that don't fit other categories | Logger, error handler, general helpers |

**How to choose category:**
1. If it's about network/API → `Network`
2. If it's about data persistence → `Storage`
3. If it's a business logic manager → `Service`
4. If it's a UI component → `View`
5. If it's data structure → `Model`
6. If it's UI-related utilities → `UI`
7. If it's code utilities/helpers → `Tool`
8. If none above fit → `Utility`

**Frontmatter 字段（三维说明：含义 / 来源 / 规则）**：

| 字段 | 含义 | 来源 | 规则 |
| :--- | :--- | :--- | :--- |
| `title` | 标准用法的名称 | 人工命名 | **必填**；**中文**；简短精准（✅ "颜色工具方法"、"异步请求处理"；❌ 避免 "Use xxx"）；≤20 字 |
| `trigger` | 触发词（Snippet/检索） | 人工命名 | **必填**；`@` 开头，kebab-case、无空格；唯一 |
| `category` | 8 类标准分类 | 人工判断 | **必填**；必须为 8 类之一 |
| `language` | 代码语言 | 从代码确定 | **必填**；支持 `swift` / `objectivec` / `go` / `python` / `java` / `kotlin` / `javascript` / `typescript` / `dart` / `rust` |
| `kind` | 知识类型 | 人工/AI | **必填**；`rule` / `pattern` / `fact` |
| `doClause` | 英文祈使句指令 | AI/人工 | **必填**；≤60 tokens |
| `description` | 中文功能摘要 | 人工/AI | **必填**；≤80字 |
| `content` | 内容对象 | 从代码/AI | **必填**；`{ markdown (≥200字), pattern (核心代码), rationale (设计原理) }` |
| `headers` | 完整 import/include 语句 | 从代码提取 | **必填**；数组；无 import 传 `[]` |
| `usageGuide` | 使用指南 | AI/人工 | **必填**；Markdown `###` 章节格式 |
| `knowledgeType` | 知识维度 | AI/人工 | **必填**；如 `code-pattern` / `architecture` / `best-practice` / `code-standard` 等 |
| `reasoning` | 推理依据 | Agent 必填 | **必填**；`{ whyStandard, sources[], confidence }` |
| `keywords` | 语义标签 | AI/人工 | 可选；数组；用于检索 |
| `tags` | 额外标签 | 人工 | 可选；数组 |
| `difficulty` | 难度等级 | 系统评估 | 可选；`beginner/intermediate/advanced` |
| `scope` | 适用范围 | AI/人工 | 可选；`universal/project-specific/target-specific` |

**系统字段（自动生成，无需手填）**：`created`、`lastModified`、`contentHash`。

**批量解析规则**：
- 多段 Recipe 可在同一文本中，使用「空行 + `---` + 下一段 Frontmatter」分隔。
- 当内容已是完整 Recipe MD（含 Frontmatter + Snippet + Usage Guide）时，系统直接解析入库，无需 AI 重写。

**Complete Recipe Template (V3 — ALWAYS use this structure):**

```json
{
  "title": "带重试的 HTTP GET 请求",
  "trigger": "@request-retry",
  "category": "Network",
  "language": "javascript",
  "kind": "pattern",
  "doClause": "Use fetchWithRetry for HTTP GET requests with automatic retry and exponential backoff",
  "description": "封装带自动重试和指数退避的 HTTP GET 请求，适用于不稳定网络环境下的数据获取场景",
  "headers": ["import fetch from 'node-fetch'"],
  "content": {
    "markdown": "## 带重试的 HTTP GET 请求\n\n在网络不稳定的场景中，单次 HTTP 请求可能因超时或服务端故障而失败。本模式封装了自动重试逻辑与指数退避策略，确保请求在合理次数内成功返回。\n\n### 核心实现\n\n```javascript\nimport fetch from 'node-fetch';\n\nasync function fetchWithRetry(url, options = {}, maxRetries = 3) {\n  for (let attempt = 1; attempt <= maxRetries; attempt++) {\n    try {\n      const response = await fetch(url, options);\n      if (!response.ok) throw new Error(`HTTP ${response.status}`);\n      return await response.json();\n    } catch (error) {\n      if (attempt === maxRetries) throw error;\n      await new Promise(r => setTimeout(r, 1000 * attempt));\n    }\n  }\n}\n\n// Usage\nconst data = await fetchWithRetry('https://api.example.com/endpoint');\nconsole.log('Success:', data);\n```\n\n### 设计要点\n- 指数退避：每次重试等待时间递增（1s, 2s, 3s），避免服务端过载\n- 最大重试次数可配置，默认 3 次\n- 非 2xx 状态码也视为失败并触发重试",
    "pattern": "async function fetchWithRetry(url, options = {}, maxRetries = 3) {\n  for (let attempt = 1; attempt <= maxRetries; attempt++) {\n    try {\n      const response = await fetch(url, options);\n      if (!response.ok) throw new Error(`HTTP ${response.status}`);\n      return await response.json();\n    } catch (error) {\n      if (attempt === maxRetries) throw error;\n      await new Promise(r => setTimeout(r, 1000 * attempt));\n    }\n  }\n}",
    "rationale": "指数退避策略是处理网络不稳定的行业标准做法，既保证了请求的可靠性，又通过递增等待避免了对服务端的冲击。封装为独立函数便于全项目统一使用。"
  },
  "usageGuide": "### When to Use\n- 需要对不稳定 API 进行可靠调用时\n- 网络环境可能出现间歇性故障的场景\n\n### Key Points\n- maxRetries 默认 3，可根据场景调整\n- 退避时间为线性递增（1s × attempt），可改为指数递增\n- 非 2xx 响应也会触发重试\n\n### Parameters & Customization\n- `url`: 请求地址\n- `options`: fetch 选项（method, headers, body 等）\n- `maxRetries`: 最大重试次数\n\n### Error Handling\n- 超过最大重试次数后抛出最后一次错误\n- 建议在调用处用 try/catch 捕获\n\n### Related Patterns\n- @http-client-base 基础 HTTP 客户端\n- @circuit-breaker 熔断器模式",
  "knowledgeType": "code-pattern",
  "reasoning": {
    "whyStandard": "指数退避 + 自动重试是 HTTP 客户端的行业最佳实践，被 AWS SDK、Google Cloud 等广泛采用",
    "sources": ["node-fetch documentation", "MDN Fetch API", "AWS SDK retry strategy"],
    "confidence": 0.9
  },
  "keywords": ["network", "retry", "http", "fetch", "exponential-backoff"],
  "tags": ["network", "resilience"]
}
```

**Template Usage Rules:**
1. **NEVER skip required fields** — 所有 V3 必填字段必须齐全
2. **V3 必填字段清单（缺一不可）**：
   - `title` — 中文 ≤20字
   - `trigger` — `@` 开头 kebab-case
   - `category` — 8 类之一: View/Service/Tool/Model/Network/Storage/UI/Utility
   - `language` — 编程语言标识
   - `kind` — rule / pattern / fact
   - `doClause` — 英文祈使句 ≤60 tokens
   - `dontClause` — 英文反向约束（描述禁止的做法）
   - `whenClause` — 英文触发场景（描述何时适用）
   - `coreCode` — 3-8 行纯代码骨架（语法完整、可直接复制）
   - `description` — 中文摘要 ≤80字
   - `content` — `{ markdown (≥200字), pattern (核心代码), rationale (设计原理) }`
   - `headers` — import 语句数组（无 import 传 `[]`）
   - `usageGuide` — Markdown `###` 章节格式
   - `knowledgeType` — 如 `code-pattern` / `architecture` / `best-practice` 等
   - `reasoning` — `{ whyStandard, sources[], confidence }`
3. **DO NOT include `type: full`** — this field is deprecated and should be removed
4. **Headers MUST be complete import statements** — e.g. `import X`, `#import <X>`, `from X import Y`, `import "fmt"` — not just filenames
5. **content.markdown** — 需包含完整代码示例 + 说明文字，≥200 字
6. **content.pattern** — 核心骨架代码，不含注释和使用示例
7. **content.rationale** — 为什么这样写的设计原理
8. **usageGuide** — 解释 When/How/Why、依赖、错误处理、性能、安全、陷阱和相关模式
9. **Use placeholders** — use IDE-appropriate placeholders: Xcode uses `<#placeholder#>`, VSCode uses `${1:placeholder}`. In Recipe source, prefer Xcode format (auto-converted on install). Explain placeholders in Usage Guide.
10. **Make trigger unique**: Format `@feature-name`, kebab-case, no spaces

---

## Common Mistakes & How to Fix Them

- **类别误用**：category 只能是 8 类之一，不能写模块名
- **headers 不完整**：必须是完整 import/#import 语句数组，不能是文件名
- **缺失必填**：`title`/`trigger`/`category`/`language`/`kind`/`doClause`/`dontClause`/`whenClause`/`coreCode`/`description`/`headers`/`content`(markdown+rationale)/`usageGuide`/`knowledgeType`/`reasoning` 必须齐全
- **trigger 格式错误**：必须 `@` 开头，小写、无空格
- **字段滥用**：不要使用已弃用的 `type` 字段
- **合并多模式**：一个 Recipe 只描述一个具体场景

### ✅ Quick Checklist Before Submitting

- [ ] Has all required V3 fields filled
- [ ] **title**: 中文简短标题（≤20字）
- [ ] **content**: `{ markdown (≥200字), pattern (核心代码), rationale (设计原理) }`
- [ ] **trigger**: `@` 开头 kebab-case
- [ ] **kind**: `rule` / `pattern` / `fact`
- [ ] **doClause**: 英文祈使句（≠60 tokens）
- [ ] **dontClause**: 英文反向约束（描述禁止的做法）
- [ ] **whenClause**: 英文触发场景（描述何时适用）
- [ ] **coreCode**: 3-8 行纯代码骨架（语法完整、可直接复制）
- [ ] **description**: 中文摘要 ≤80字
- [ ] **category**: ONE of View/Service/Tool/Model/Network/Storage/UI/Utility
- [ ] **language**: `swift`/`objectivec`/`go`/`python`/`java`/`kotlin`/`javascript`/`typescript`/`dart`/`rust`
- [ ] **headers**: 完整 import 语句数组（无 import 传 `[]`）
- [ ] **usageGuide**: Markdown `###` 章节格式
- [ ] **knowledgeType**: `code-pattern` / `architecture` / `best-practice` 等
- [ ] **reasoning**: `{ whyStandard, sources[], confidence }`
- [ ] Code snippet is runnable with minimal edits
- [ ] No `type:` field (this is deprecated)
- [ ] No `code` / `summary_cn` / `summary_en` (use V3 `content` + `description` instead)

### Recipe Creation Principles

When creating or extracting Recipes:
1. **V3 必填字段一次性填写**：title, content(markdown+pattern+rationale), trigger, kind, doClause, dontClause, whenClause, coreCode, description, category, language, headers, usageGuide, knowledgeType, reasoning
2. **保持单场景**：一个 Recipe 只讲一个具体用法
3. **字段严格**：必填字段必须齐全、格式正确
   - Tools like Dashboard `/api/v1/ai/translate` can help auto-generate missing language, but it's better to provide both
2. **Split, don't combine**: If you identify 3 usage patterns in a module, create 3 separate Recipes, not 1 combined Recipe.
3. **Each Recipe has a clear trigger**: One `@trigger` for one specific scenario. E.g. `@WebViewLoadURL`, `@NetworkRetry`, `@AsyncError`.
4. **Reusable and focused**: Developer should be able to copy-paste the Recipe's code snippet and use it directly for that ONE scenario.
5. **Summary should be specific**: "Use async/await for sequential API calls" NOT "Async programming guide".
6. **Category MUST use standard values**: ONLY use one of these 8 categories: `View`, `Service`, `Tool`, `Model`, `Network`, `Storage`, `UI`, `Utility`. Never use module names (e.g. "BDNetworkControl") or other custom values as category.
7. **Headers must be complete import statements**: Extract all import/include statements from code. Format by language:
   - Swift: `["import ModuleName"]`
   - ObjC: `["#import <Module/Header.h>"]`
   - Go: `["import \"fmt\""]`
   - Python: `["import os"]` / `["from pathlib import Path"]`
   - Java/Kotlin: `["import java.util.List;"]`
   - JS/TS: `["import fs from 'node:fs'"]`
   Include the full statement, not just module names.
8. **Auto-extract moduleName**: Parse from headers. Examples:
   - ObjC: `["#import <BDNetworkControl/BDBaseRequest.h>"]` → `moduleName: BDNetworkControl`
   - Swift: `["import Foundation"]` → `moduleName: Foundation`
   - Go: `["import \"net/http\""]` → `moduleName: net/http`
   - Python: `["from flask import Flask"]` → `moduleName: flask`
   - Java: `["import com.google.gson.Gson;"]` → `moduleName: com.google.gson`
   - JS/TS: `["import express from 'express'"]` → `moduleName: express`
   If multiple modules exist, use the primary/main one.
9. **Auto-generate tags**: Analyze code to extract 2-4 keyword tags:
   - **Functionality**: network, storage, ui, animation, async, cache, threading
   - **Patterns**: template, singleton, factory, observer, delegate
   - **Domain**: api, database, navigation, gesture, notification
   - Example: Network request code → `tags: [network, api, async]`
10. **Auto-judge difficulty**: Analyze code complexity:
   - **beginner**: Simple property setup, basic UI layout, straightforward method calls
   - **intermediate**: Moderate logic, callbacks/blocks, error handling, common patterns (default)
   - **advanced**: Complex architecture, async coordination, custom protocols, performance optimization
10. **Set authority: 3** by default (reviewers adjust 1-5 in Dashboard)

### Candidate-only Rule (重要)

- **If the user asks for candidates**: Extract structured items and submit via MCP **`autosnippet_submit_knowledge_batch`**.

---

## 其他升级后的结构（2026）

| 结构 | 位置 | 说明 |
|------|------|------|
| **Recipe 使用统计** | `AutoSnippet/.autosnippet/recipe-stats.json` | 记录 byTrigger/byFile 的使用次数与权威分（0～5）。用于排序与推荐。 |
| **统计权重配置** | `AutoSnippet/.autosnippet/recipe-stats-weights.json` 或 boxspec `recipes.statsWeights` | 使用热度与权威分的权重配置。 |
| **Candidates** | `AutoSnippet/.autosnippet/candidates.json` | 批量扫描/候选池，由 Dashboard 审核入库。 |
| **向量索引** | `AutoSnippet/.autosnippet/context/` | `asd embed` 生成的语义索引，供检索与 Guard。 |

### Recipe Priority Over Project Implementation

When both Recipe and project source code have relevant implementations, **prefer Recipe**. Recipe is the curated project standard; source code may be legacy, incomplete, or non-standard. When answering, suggesting code, or running Guard, cite Recipe's Snippet/Code Reference instead of raw search results.

---

## Multi-Language Recipe Examples (V3)

> 以下展示不同语言的标准 V3 Recipe 示例，展示所有必填字段在各语言下的写法。

### Example 1: Swift — 网络请求（iOS/macOS）

```json
{
  "title": "URLSession 异步 GET 请求",
  "trigger": "@url-session-get",
  "category": "Network",
  "language": "swift",
  "kind": "pattern",
  "doClause": "Use async/await URLSession for GET requests with error handling and JSON decoding",
  "description": "使用 async/await 的 URLSession GET 请求，包含错误处理与 JSON 解码，适用于 iOS/macOS 网络层",
  "headers": ["import Foundation"],
  "content": {
    "markdown": "## URLSession 异步 GET 请求\n\n使用 Swift concurrency 的 async/await 语法封装 URLSession GET 请求，自动校验 HTTP 状态码并解码 JSON。\n\n```swift\nfunc fetchData<T: Decodable>(from url: URL) async throws -> T {\n  let (data, response) = try await URLSession.shared.data(from: url)\n  guard let http = response as? HTTPURLResponse,\n        (200..<300).contains(http.statusCode) else {\n    throw URLError(.badServerResponse)\n  }\n  return try JSONDecoder().decode(T.self, from: data)\n}\n\n// Usage\nlet users: [User] = try await fetchData(from: URL(string: \"https://api.example.com/users\")!)\n```\n\n### 设计要点\n- 泛型 Decodable 约束，支持任意 JSON 模型\n- 校验 HTTP 2xx 范围状态码\n- 利用 Swift Concurrency 自动管理线程",
    "pattern": "func fetchData<T: Decodable>(from url: URL) async throws -> T {\n  let (data, response) = try await URLSession.shared.data(from: url)\n  guard let http = response as? HTTPURLResponse,\n        (200..<300).contains(http.statusCode) else {\n    throw URLError(.badServerResponse)\n  }\n  return try JSONDecoder().decode(T.self, from: data)\n}",
    "rationale": "async/await 是 Swift 5.5+ 推荐的异步模式，相比 completion handler 更清晰且不易出错，泛型解码减少重复代码。"
  },
  "usageGuide": "### When to Use\n- iOS/macOS 项目中需要从 REST API 获取 JSON 数据\n- 使用 Swift 5.5+ 的项目\n\n### Key Points\n- 必须在 async 上下文中调用\n- 返回类型需遵循 Decodable 协议\n\n### Error Handling\n- 非 2xx 抛出 URLError(.badServerResponse)\n- JSON 解码失败抛出 DecodingError",
  "knowledgeType": "code-pattern",
  "reasoning": {
    "whyStandard": "Apple 官方推荐 async/await URLSession API，是 Swift Concurrency 标准做法",
    "sources": ["Apple URLSession documentation", "Swift Concurrency WWDC21"],
    "confidence": 0.95
  },
  "keywords": ["network", "async", "urlsession", "json"],
  "tags": ["network", "template"]
}
```

### Example 2: Objective-C — KVO 安全模式

```json
{
  "title": "NSObject KVO 安全订阅",
  "trigger": "@kvo-safe",
  "category": "Utility",
  "language": "objectivec",
  "kind": "rule",
  "doClause": "Pair addObserver and removeObserver to prevent KVO leaks and crashes",
  "description": "配对 addObserver/removeObserver，避免 KVO 泄漏与崩溃，确保生命周期安全",
  "headers": ["#import <Foundation/Foundation.h>"],
  "content": {
    "markdown": "## NSObject KVO 安全订阅\n\nKVO 是 Cocoa 的核心机制，但未正确移除观察者会导致崩溃。本规则要求 addObserver 与 removeObserver 必须配对。\n\n```objectivec\n// Add observer\n[self.target addObserver:self\n              forKeyPath:@\"<#property#>\"\n                 options:NSKeyValueObservingOptionNew | NSKeyValueObservingOptionOld\n                 context:NULL];\n\n// Handle changes\n- (void)observeValueForKeyPath:(NSString *)keyPath\n                      ofObject:(id)object\n                        change:(NSDictionary *)change\n                       context:(void *)context {\n  if ([keyPath isEqualToString:@\"<#property#>\"]) {\n    id newValue = change[NSKeyValueChangeNewKey];\n    // Handle change\n  }\n}\n\n// MUST remove in dealloc\n- (void)dealloc {\n  [self.target removeObserver:self forKeyPath:@\"<#property#>\"];\n}\n```\n\n### 设计要点\n- addObserver 与 removeObserver 必须一一配对\n- dealloc 中移除是最后的安全网\n- 使用 context 区分不同观察",
    "pattern": "[self.target addObserver:self forKeyPath:@\"<#property#>\" options:NSKeyValueObservingOptionNew context:NULL];\n- (void)dealloc { [self.target removeObserver:self forKeyPath:@\"<#property#>\"]; }",
    "rationale": "KVO 观察者未移除会在对象释放后导致野指针崩溃，配对管理是 Cocoa 开发的基本安全规则。"
  },
  "usageGuide": "### When to Use\n- 使用 KVO 监听属性变化时\n- 任何 addObserver 调用都必须有对应的 removeObserver\n\n### Common Pitfalls\n- 忘记在 dealloc 中移除观察者\n- 重复添加同一 keyPath 的观察者\n- 多线程环境下的竞态条件",
  "knowledgeType": "code-standard",
  "reasoning": {
    "whyStandard": "Apple 官方文档明确要求 KVO 观察者必须在释放前移除，否则会触发异常",
    "sources": ["Apple KVO Programming Guide", "NSObject Protocol Reference"],
    "confidence": 0.95
  },
  "keywords": ["kvo", "safety", "lifecycle"],
  "tags": ["safety"]
}
```

### Example 3: Go — HTTP Handler with Middleware

```json
{
  "title": "Go HTTP Handler 中间件链",
  "trigger": "@go-handler",
  "category": "Network",
  "language": "go",
  "kind": "pattern",
  "doClause": "Use middleware chain pattern for net/http handlers with logging and recovery",
  "description": "标准 net/http Handler + 中间件链模式，含日志和 panic 恢复中间件",
  "headers": ["import \"net/http\"", "import \"log\""],
  "content": {
    "markdown": "## Go HTTP Handler 中间件链\n\n使用函数式中间件链组合 HTTP 处理器，每个中间件负责单一职责（日志、恢复等），通过 Chain 函数串联。\n\n```go\ntype Middleware func(http.Handler) http.Handler\n\nfunc LoggingMiddleware(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tlog.Printf(\"%s %s\", r.Method, r.URL.Path)\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n\nfunc RecoveryMiddleware(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tdefer func() {\n\t\t\tif err := recover(); err != nil {\n\t\t\t\thttp.Error(w, \"Internal Server Error\", 500)\n\t\t\t\tlog.Printf(\"panic recovered: %v\", err)\n\t\t\t}\n\t\t}()\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n\nfunc Chain(h http.Handler, mws ...Middleware) http.Handler {\n\tfor i := len(mws) - 1; i >= 0; i-- {\n\t\tmw := mws[i]\n\t\th = mw(h)\n\t}\n\treturn h\n}\n```\n\n### 设计要点\n- Middleware 类型签名统一：`func(http.Handler) http.Handler`\n- Chain 从右向左包装，保证执行顺序与传入顺序一致\n- RecoveryMiddleware 防止 panic 导致进程崩溃",
    "pattern": "type Middleware func(http.Handler) http.Handler\n\nfunc Chain(h http.Handler, mws ...Middleware) http.Handler {\n\tfor i := len(mws) - 1; i >= 0; i-- {\n\t\tmw := mws[i]\n\t\th = mw(h)\n\t}\n\treturn h\n}",
    "rationale": "中间件链是 Go HTTP 服务的标准架构模式，被 chi、gorilla/mux 等主流框架广泛采用，通过函数组合实现关注点分离。"
  },
  "usageGuide": "### When to Use\n- 构建 Go HTTP 服务时需要统一的请求处理流水线\n- 需要日志、认证、恢复等通用功能\n\n### Key Points\n- 中间件顺序很重要：Recovery 应在最外层\n- 可自由扩展: Auth、CORS、RateLimit 等\n\n### Related Patterns\n- @go-graceful-shutdown 优雅关闭\n- @go-context-propagation 上下文传递",
  "knowledgeType": "code-pattern",
  "reasoning": {
    "whyStandard": "函数式中间件链是 Go 社区的标准 HTTP 服务架构，与 net/http 原生接口完全兼容",
    "sources": ["Go net/http documentation", "chi router middleware pattern"],
    "confidence": 0.9
  },
  "keywords": ["http", "handler", "middleware", "server"],
  "tags": ["network", "pattern"]
}
```

### Example 4: Python — 异步数据库查询

```json
{
  "title": "异步 PostgreSQL 连接池查询",
  "trigger": "@async-db",
  "category": "Storage",
  "language": "python",
  "kind": "pattern",
  "doClause": "Use asyncpg connection pool for async PostgreSQL queries with proper error handling",
  "description": "使用 asyncpg 连接池执行异步 PostgreSQL 查询，含连接管理与错误处理",
  "headers": ["import asyncpg", "import asyncio"],
  "content": {
    "markdown": "## 异步 PostgreSQL 连接池查询\n\nasyncpg 连接池管理数据库连接的生命周期，避免频繁创建/销毁连接的开销。\n\n```python\nimport asyncpg\nimport asyncio\n\nasync def create_pool(dsn: str) -> asyncpg.Pool:\n    return await asyncpg.create_pool(dsn, min_size=5, max_size=20)\n\nasync def fetch_users(pool: asyncpg.Pool, limit: int = 100) -> list[dict]:\n    async with pool.acquire() as conn:\n        rows = await conn.fetch(\n            \"SELECT id, name, email FROM users WHERE active = $1 LIMIT $2\",\n            True, limit\n        )\n        return [dict(row) for row in rows]\n\n# Usage\npool = await create_pool(\"postgresql://user:pass@localhost/mydb\")\ntry:\n    users = await fetch_users(pool)\nfinally:\n    await pool.close()\n```\n\n### 设计要点\n- 连接池 min_size/max_size 控制资源消耗\n- async with pool.acquire() 自动归还连接\n- 参数化查询防止 SQL 注入",
    "pattern": "async def create_pool(dsn: str) -> asyncpg.Pool:\n    return await asyncpg.create_pool(dsn, min_size=5, max_size=20)\n\nasync def fetch_users(pool: asyncpg.Pool, limit: int = 100) -> list[dict]:\n    async with pool.acquire() as conn:\n        rows = await conn.fetch(query, *params)\n        return [dict(row) for row in rows]",
    "rationale": "连接池是数据库访问的标准做法，asyncpg 是 Python 社区性能最优的 PostgreSQL 异步驱动，参数化查询确保安全。"
  },
  "usageGuide": "### When to Use\n- Python 异步应用中访问 PostgreSQL\n- 需要高并发数据库访问的场景\n\n### Key Points\n- 必须在 asyncio 事件循环中使用\n- 应用退出前调用 pool.close()\n- 使用参数化查询（$1, $2）而非字符串拼接\n\n### Dependencies\n- asyncpg >= 0.27.0\n- PostgreSQL 9.5+",
  "knowledgeType": "code-pattern",
  "reasoning": {
    "whyStandard": "asyncpg 连接池是 Python 异步 PostgreSQL 访问的行业标准，被 FastAPI、Starlette 等框架推荐",
    "sources": ["asyncpg documentation", "PostgreSQL connection pooling best practices"],
    "confidence": 0.9
  },
  "keywords": ["database", "async", "postgresql", "pool"],
  "tags": ["storage", "async"]
}
```

### Example 5: TypeScript — React 自定义 Hook

```json
{
  "title": "React 通用 useFetch Hook",
  "trigger": "@use-fetch",
  "category": "Tool",
  "language": "typescript",
  "kind": "pattern",
  "doClause": "Use generic useFetch hook with loading state, error handling, and auto-cancellation",
  "description": "通用 useFetch Hook，支持泛型、loading 状态、错误处理与请求自动取消",
  "headers": ["import { useState, useEffect } from 'react'"],
  "content": {
    "markdown": "## React 通用 useFetch Hook\n\n封装 fetch 请求为自定义 Hook，统一管理 loading/data/error 三态，URL 变化时自动取消上一次请求。\n\n```typescript\nimport { useState, useEffect } from 'react';\n\ninterface FetchState<T> {\n  data: T | null;\n  loading: boolean;\n  error: Error | null;\n}\n\nfunction useFetch<T>(url: string): FetchState<T> {\n  const [state, setState] = useState<FetchState<T>>({\n    data: null, loading: true, error: null,\n  });\n\n  useEffect(() => {\n    const controller = new AbortController();\n    setState(prev => ({ ...prev, loading: true, error: null }));\n\n    fetch(url, { signal: controller.signal })\n      .then(res => {\n        if (!res.ok) throw new Error(`HTTP ${res.status}`);\n        return res.json();\n      })\n      .then(data => setState({ data, loading: false, error: null }))\n      .catch(err => {\n        if (err.name !== 'AbortError') {\n          setState({ data: null, loading: false, error: err });\n        }\n      });\n\n    return () => controller.abort();\n  }, [url]);\n\n  return state;\n}\n```\n\n### 设计要点\n- AbortController 在组件卸载或 URL 变化时取消请求\n- 泛型 T 支持任意返回类型\n- 三态（loading/data/error）覆盖所有 UI 场景",
    "pattern": "function useFetch<T>(url: string): FetchState<T> {\n  const [state, setState] = useState<FetchState<T>>({ data: null, loading: true, error: null });\n  useEffect(() => {\n    const controller = new AbortController();\n    fetch(url, { signal: controller.signal }).then(res => res.json()).then(data => setState({ data, loading: false, error: null }));\n    return () => controller.abort();\n  }, [url]);\n  return state;\n}",
    "rationale": "自定义 Hook 是 React 的标准复用模式，AbortController 防止内存泄漏，泛型确保类型安全。"
  },
  "usageGuide": "### When to Use\n- React 函数组件中需要 fetch 远程数据\n- 需要统一的 loading/error 状态管理\n\n### Key Points\n- URL 变化会自动重新请求\n- 组件卸载时自动取消进行中的请求\n- 返回 { data, loading, error } 三态\n\n### Common Pitfalls\n- 不要在 Hook 外部修改返回的 state\n- 复杂场景考虑使用 React Query / SWR",
  "knowledgeType": "code-pattern",
  "reasoning": {
    "whyStandard": "自定义 Hook + AbortController 是 React 官方推荐的数据获取模式",
    "sources": ["React documentation - Custom Hooks", "MDN AbortController"],
    "confidence": 0.9
  },
  "keywords": ["react", "hook", "fetch", "typescript"],
  "tags": ["ui", "pattern"]
}
```

### Example 6: Java — 泛型 Repository 模式

```json
{
  "title": "泛型 Repository 接口",
  "trigger": "@java-repo",
  "category": "Service",
  "language": "java",
  "kind": "pattern",
  "doClause": "Use generic Repository interface with Optional returns for type-safe data access",
  "description": "Spring Data 风格泛型 Repository 接口，使用 Optional 避免空指针，统一数据访问层",
  "headers": ["import java.util.Optional;", "import java.util.List;"],
  "content": {
    "markdown": "## 泛型 Repository 接口\n\n定义统一的泛型数据访问层接口，使用 Optional 返回值避免 NullPointerException，所有实体 Repository 统一实现此接口。\n\n```java\npublic interface Repository<T, ID> {\n    Optional<T> findById(ID id);\n    List<T> findAll();\n    T save(T entity);\n    void deleteById(ID id);\n    boolean existsById(ID id);\n}\n\n// Implementation\npublic class UserRepository implements Repository<User, Long> {\n    @Override\n    public Optional<User> findById(Long id) {\n        return Optional.ofNullable(queryResult);\n    }\n\n    @Override\n    public User save(User entity) {\n        // persist entity\n        return entity;\n    }\n    // ... other methods\n}\n```\n\n### 设计要点\n- 泛型 <T, ID> 支持任意实体类型\n- Optional 返回避免 null 判断\n- 接口统一，实现可替换（内存/数据库/远程）",
    "pattern": "public interface Repository<T, ID> {\n    Optional<T> findById(ID id);\n    List<T> findAll();\n    T save(T entity);\n    void deleteById(ID id);\n    boolean existsById(ID id);\n}",
    "rationale": "Repository 模式是 DDD 的核心模式，Spring Data 将其标准化。泛型接口减少重复代码，Optional 是 Java 8+ 避免 NPE 的标准做法。"
  },
  "usageGuide": "### When to Use\n- Java 项目需要统一的数据访问层\n- 使用 Spring Data 或自定义 ORM 时\n\n### Key Points\n- 每个实体创建对应的 Repository 实现\n- findById 返回 Optional，调用方用 orElse/orElseThrow 处理\n- save 方法同时处理新增和更新\n\n### Related Patterns\n- @java-service-layer 服务层模式\n- @java-entity-base 基础实体类",
  "knowledgeType": "architecture",
  "reasoning": {
    "whyStandard": "Repository 模式是 Spring Data 的核心抽象，是 Java 企业级开发的行业标准",
    "sources": ["Spring Data documentation", "Domain-Driven Design by Eric Evans"],
    "confidence": 0.95
  },
  "keywords": ["repository", "generics", "optional", "pattern"],
  "tags": ["architecture", "pattern"]
}
```

### Example 7: Kotlin — 协程 Flow 数据流

```json
{
  "title": "Kotlin Flow 异步数据流",
  "trigger": "@kotlin-flow",
  "category": "Service",
  "language": "kotlin",
  "kind": "pattern",
  "doClause": "Use Kotlin Flow with retry and error handling for async data streams",
  "description": "使用 Kotlin Flow 处理异步数据流，含 retry 重试和错误恢复机制",
  "headers": ["import kotlinx.coroutines.flow.*", "import kotlinx.coroutines.delay"],
  "content": {
    "markdown": "## Kotlin Flow 异步数据流\n\n使用 Flow 构建响应式数据流，结合 retry 和 catch 操作符实现自动重试与错误恢复。\n\n```kotlin\nfun fetchUsersFlow(): Flow<List<User>> = flow {\n    val users = apiClient.getUsers()\n    emit(users)\n}.retry(retries = 3) { cause ->\n    cause is IOException && run { delay(1000); true }\n}.catch { e ->\n    emit(emptyList())\n    logger.error(\"Failed to fetch users\", e)\n}.flowOn(Dispatchers.IO)\n\n// Collect in ViewModel\nviewModelScope.launch {\n    fetchUsersFlow()\n        .collect { users ->\n            _uiState.value = UiState.Success(users)\n        }\n}\n```\n\n### 设计要点\n- flow builder 在协程中发射数据\n- retry 操作符对 IOException 自动重试 3 次\n- catch 操作符兜底：发射空列表并记录日志\n- flowOn(Dispatchers.IO) 确保网络请求在 IO 线程",
    "pattern": "fun fetchUsersFlow(): Flow<List<User>> = flow {\n    val data = apiClient.getData()\n    emit(data)\n}.retry(retries = 3) { cause ->\n    cause is IOException && run { delay(1000); true }\n}.catch { e ->\n    emit(emptyList())\n}.flowOn(Dispatchers.IO)",
    "rationale": "Kotlin Flow 是 Kotlin 协程的标准响应式流 API，retry + catch 组合是处理不稳定数据源的最佳实践，flowOn 确保线程安全。"
  },
  "usageGuide": "### When to Use\n- Android/Kotlin 项目中需要响应式数据流\n- ViewModel 向 UI 层提供可观察数据\n\n### Key Points\n- collect 是终端操作符，必须在协程中调用\n- flowOn 只影响上游操作符\n- retry 中的 delay 实现退避策略\n\n### Common Pitfalls\n- 不要在 catch 之后再使用 retry\n- collect 在主线程调用时确保 flowOn 指定了合适的调度器\n\n### Related Patterns\n- @kotlin-stateflow StateFlow 状态管理\n- @kotlin-coroutine-scope 协程作用域",
  "knowledgeType": "code-pattern",
  "reasoning": {
    "whyStandard": "Kotlin Flow 是 JetBrains 官方推荐的异步流 API，Google Android 团队推荐替代 RxJava",
    "sources": ["Kotlin Flow documentation", "Android Developer Guide - Kotlin Flow"],
    "confidence": 0.9
  },
  "keywords": ["flow", "coroutine", "async", "stream"],
  "tags": ["async", "pattern"]
}
```

### Headers 格式速查表

| Language | headers 格式示例 |
|----------|-----------------|
| Swift | `["import Foundation"]`, `["import UIKit"]` |
| ObjC | `["#import <Foundation/Foundation.h>"]`, `["#import <UIKit/UIKit.h>"]` |
| Go | `["import \"net/http\""]`, `["import \"fmt\""]` |
| Python | `["import asyncio"]`, `["from pathlib import Path"]` |
| Java | `["import java.util.List;"]`, `["import java.util.Optional;"]` |
| Kotlin | `["import kotlinx.coroutines.flow.*"]` |
| JavaScript | `["import express from 'express'"]`, `["const fs = require('fs')"]` |
| TypeScript | `["import { useState } from 'react'"]`, `["import type { Config } from './types'"]` |

### Placeholder 格式速查表

| 目标 IDE | 格式 | 示例 |
|----------|------|------|
| Xcode | `<#name#>` | `<#URL#>`, `<#Token#>`, `<#completion#>` |
| VSCode | `${N:name}` | `${1:url}`, `${2:token}`, `${3:callback}` |

> **写法建议**: Recipe 源文件中统一使用 Xcode 格式 `<#...#>`，`asd install` 会自动按目标 IDE 转换。

---

## Snippet

- **Definition**: A single code snippet entry (title, trigger, body, headers, etc.) listed in the root spec or under `AutoSnippet/snippets/`.
- **Role**: Synced to IDE (Xcode CodeSnippets / VSCode .code-snippets) via **`asd install`**; developers insert by trigger or from the snippet library.
- **Relation**: A Recipe can describe the same pattern as a Snippet; creating from Dashboard can produce both.

---

## On-Demand Context (when asd ui is running)

When `asd ui` is running in the project root, use the HTTP API for on-demand semantic search:
- MCP tool `autosnippet_search(mode=context)` (pass `query`, `limit?`) → returns relevant Recipe/docs
- Used to fetch Recipe/docs relevant to the current task dynamically instead of loading all at once.

---

## Quick Summary

| Capability | Description | Skill |
|------------|-------------|-------|
| **Recipe lookup** | Read `references/project-recipes-context.md` 轻量索引，需全文调 MCP `autosnippet_knowledge(operation=get, id)` / `autosnippet_search(mode=context)`. Recipe over source | autosnippet-recipes |
| **Create Recipe** | Dashboard New Recipe; or write to `_draft_recipe.md` and watch auto-adds; or MCP `autosnippet_submit_knowledge_batch` | autosnippet-create |
| **Search & insert** | `ass` shortcut or `// as:search`, `asd search`, Dashboard search | autosnippet-search |
| **Audit review** | `// as:audit`; watch runs AI review against knowledge base | autosnippet-guard |
| **Dependency graph** | `AutoSnippet/AutoSnippet.spmmap.json`; `asd spm-map` to update; MCP graph tools for querying (supports SPM/Node/Go/JVM/Python) | autosnippet-structure |
| **Vector store** | Built by `asd embed`; `autosnippet_search(mode=context)` for on-demand lookup. Use as context storage to save space | autosnippet-concepts / autosnippet-recipes |
| **MCP tools** | `autosnippet_search` (统合搜索), `autosnippet_guard` (Guard 检查) | — |

**Principles**: Recipe is project standard, over project implementation; do not modify AutoSnippet/ directly, submit via Dashboard or MCP candidate submission. Context storage is safe; Skills express semantics, MCP provides capability; Cursor calls on demand to save space.

---

## Introducing and using new knowledge

**New knowledge** means content not yet in the knowledge base, or just submitted as candidates (new Recipe, new doc). How to add and use it:

### How to add new knowledge

1. **Single code / single Recipe**: Copy to clipboard → open Dashboard (run `asd ui` if not running) → Use Copied Code, paste, review, save; or write `_draft_recipe.md` and let watch auto-add to Candidates. Or use `autosnippet_submit_knowledge_batch` via MCP.
2. **Multiple drafts (recommended)**: Create a **draft folder** (e.g. `.autosnippet-drafts`), **one .md file per Recipe**—do not put everything in one big file. Call MCP **`autosnippet_submit_knowledge_batch`** with those file paths to submit to Candidates, then review in Dashboard **Candidates**. **After submit, delete the draft folder** (use `deleteAfterSubmit: true` or `rm -rf .autosnippet-drafts`).
3. **Intro-only docs**: Recipe candidates can be intro-only (frontmatter + usage guide, no code); after approval they become Recipes and **do not generate a Snippet**—used only for search and Guard context.

### How to use knowledge once it’s in the base

- **Search**: MCP `autosnippet_search` (mode=context/keyword/semantic/auto), or terminal `asd search`, Dashboard search, `ass` shortcut or `// as:search`.
- **Audit**: `// as:audit` runs Guard against Recipe standards. Or call `autosnippet_guard` via MCP for on-demand checking (with `code` for single snippet or `files[]` for batch).
- **Record adoption**: When the user confirms use, call `autosnippet_knowledge(operation=confirm_usage)` to record human usage (affects authority and ranking).

---

## Relation to other skills

- **autosnippet-recipes**: Read project context, search recipes, find code on demand.
- **autosnippet-create**: Creation flow (Dashboard, CLI, `// as:create`).
- **autosnippet-structure**: SPM dependency structure and knowledge graph.

```
