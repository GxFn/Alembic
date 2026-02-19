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
| **Snippets** | AutoSnippet 根 spec `list` 或 `AutoSnippet/snippets/*.json` | Code snippets synced to Xcode CodeSnippets; developers use them by trigger (completion). |
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
| **Index sources** | `recipe` (AutoSnippet/recipes/*.md), `doc` (docs dir), `target-readme` (SPM target READMEs) |
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
- **`headers`**: MUST be complete import/include statements from the code. Swift: `["import ModuleName"]`, ObjC: `["#import <Module/Header.h>"]`. NOT just module names.
- **`trigger`**: MUST start with `@` (e.g. `@requestManager`). Lowercase, no spaces.
- **`language`**: MUST be `swift` or `objectivec` (lowercase).
- **`summary_cn` / `summary_en`**: MUST be concise; `summary_cn` ≤ 100 字，`summary_en` ≤ 100 words.

**Standard Category Definitions (8 categories - MUST use exactly these):**

| Category | When to Use | Examples |
|----------|-------------|----------|
| `View` | UI components, view controllers, custom views | UITableViewCell, UIViewController subclass, custom UIView |
| `Service` | Business logic services, managers, coordinators | UserService, LocationManager, PaymentCoordinator |
| `Tool` | Utility classes, helpers, extensions | StringHelper, DateFormatter extension, validation utils |
| `Model` | Data models, entities, value objects | User model, APIResponse, configuration objects |
| `Network` | Network requests, API clients, HTTP/WebSocket | URLSession wrapper, Alamofire usage, API request |
| `Storage` | Persistence, caching, database operations | CoreData, UserDefaults, file I/O, cache manager |
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
| `trigger` | 触发词（Snippet/检索） | 人工命名 | **必填**；`@` 开头，小写/下划线/无空格；唯一 |
| `category` | 8 类标准分类 | 人工判断 | **必填**；必须为 8 类之一 |
| `language` | 代码语言 | 从代码确定 | **必填**；`swift` / `objectivec` |
| `summary_cn` | 中文摘要 | 人工/AI | **必填**；≤100 字 |
| `summary_en` | 英文摘要 | 人工/AI | **必填**；≤100 words |
| `headers` | 完整 import/#import | 从代码提取 | **必填**；数组；必须是完整语句 |
| `keywords` | 语义标签 | AI/人工 | 可选；数组；用于检索 |
| `tags` | 额外标签 | 人工 | 可选；数组；非语义必需 |
| `version` | 版本号 | 系统/人工 | 可选；语义化版本（如 `1.0.0`） |
| `author` | 作者/团队 | 人工 | 可选；字符串 |
| `deprecated` | 是否弃用 | 人工 | 可选；布尔值 |
| `id` | 唯一标识 | 系统生成 | 可选；若提供需唯一 |
| `moduleName` | 模块名 | 从 headers 解析 | 自动；不手填 |
| `deps` | 依赖关系 | 系统解析 | 可选；对象 `{ targets, imports }` |
| `difficulty` | 难度等级 | 系统评估 | 可选；`beginner/intermediate/advanced` |
| `authority` | 权威评分 | 审核设置 | 可选；1～5 |

**系统字段（自动生成，无需手填）**：`created`、`lastModified`、`contentHash`。

**批量解析规则**：
- 多段 Recipe 可在同一文本中，使用「空行 + `---` + 下一段 Frontmatter」分隔。
- 当内容已是完整 Recipe MD（含 Frontmatter + Snippet + Usage Guide）时，系统直接解析入库，无需 AI 重写。

**Complete Recipe Template (ALWAYS use this structure):**

````markdown
---
id: recipe_network_001
title: Request with Retry
trigger: @requestRetry
category: Network
language: objectivec
summary_cn: 带自动重试的网络请求
summary_en: Make HTTP request with automatic retry
headers:
  - "#import <BDNetworkControl/BDBaseRequest.h>"
  - "#import <BDNetworkControl/BDRequestDefine.h>"
keywords: [network, retry]
tags: [network, resilience]
version: "1.0.0"
author: team_name
deprecated: false
moduleName: BDNetworkControl
deps:
  targets: ["BDNetworkControl"]
  imports: ["BDNetworkControl"]
difficulty: intermediate
authority: 3
---

## Snippet / Code Reference

```objectivec
#import <BDNetworkControl/BDBaseRequest.h>

// Usage example - make it runnable and focused
BDBaseRequest *request = [[BDBaseRequest alloc] init];
request.url = @"https://api.example.com/endpoint";
request.method = BDRequestMethodGET;

[request startWithCompletionBlock:^(BDBaseRequest *req) {
  // Handle success
  id responseData = req.responseJson;
  NSLog(@"Success: %@", responseData);
} failure:^(BDBaseRequest *req, NSError *error) {
  // Handle error
  NSLog(@"Error: %@", error.localizedDescription);
}];
```

## AI Context / Usage Guide

### When to Use
- Describe the specific scenario where this Recipe applies
- List conditions or contexts that make this Recipe relevant

### Key Points
- Important considerations when using this code
- Common pitfalls to avoid
- Best practices specific to this usage

### Parameters & Customization
- Explain what developers need to customize
- Document placeholder values and their meanings

### Dependencies & Preconditions
- Required modules, permissions, and minimum OS version

### Error Handling & Edge Cases
- Common failure modes, retry/timeout, and fallback behavior

### Performance & Resources
- Cache, threading, and memory considerations

### Security & Compliance
- Sensitive data handling, auth, and logging guidance

### Common Pitfalls
- Typical misuse and how to avoid it

### Related Patterns
- Link to related Recipes (use @trigger format)
- Note alternative approaches if applicable
````

**Template Usage Rules:**
1. **NEVER skip any section** - include all three: Frontmatter, Snippet, Usage Guide
2. **RECOMMEND providing English version** (beneficial for search, Cursor AI understanding, and knowledge reuse):
   - **Why**: 
   - 🔍 **Search**: English users and English keyword searches benefit from EN version
   - 🧠 **Cursor AI**: English LLM processes English text naturally, improving pattern comprehension
   - 📚 **Knowledge reuse**: Global team can access knowledge more effectively
   - **Token cost**: Only ~20-30% increase (minimal impact)
   - **Optional approach**: Chinese-only is acceptable; English improves discoverability
  - **How** (if providing): Generate both `summary_cn` and `summary_en` in frontmatter + both Chinese and English usage guide sections
  - When submitting via MCP, can include just Chinese or both Chinese + English (`summary_cn` + `summary_en` + `usageGuide_cn` + `usageGuide_en`)
3. **DO NOT include `type: full`** - this field is deprecated and should be removed
4. **Headers MUST be complete import statements** - `#import <Module/File.h>` not just filenames
5. **Required frontmatter fields (必须齐全)**:
  - `title`, `trigger`, `category`, `language`, `summary_cn`, `summary_en`, `headers`
6. **Snippet section** - runnable code example with context and comments
7. **Usage Guide section** - explain When/How/Why, dependencies, error handling, performance, security, pitfalls, and related patterns
8. **Use placeholders** - use Xcode placeholders like `<#URL#>` and explain them in Usage Guide
9. **Make trigger unique**: Format `@featureName`, all lowercase, no spaces
10. **Be specific in summary**: Describe the exact use case, not general concepts

---

## Common Mistakes & How to Fix Them

- **类别误用**：category 只能是 8 类之一，不能写模块名
- **headers 不完整**：必须是完整 import/#import 语句数组，不能是文件名
- **缺失必填**：`title`/`trigger`/`category`/`language`/`summary_cn`/`summary_en`/`headers` 必须齐全
- **trigger 格式错误**：必须 `@` 开头，小写、无空格
- **字段滥用**：不要使用已弃用的 `type` 字段
- **合并多模式**：一个 Recipe 只描述一个具体场景

### ✅ Quick Checklist Before Submitting

- [ ] Has all 3 sections: Frontmatter + Snippet + Usage Guide
- [ ] **summary_cn + summary_en** (建议同时提供；中文可接受但不推荐)
- [ ] Required fields filled: `title`, `trigger`, `category`, `language`, `summary_cn`, `summary_en`, `headers`
- [ ] `category` is ONE of: View, Service, Tool, Model, Network, Storage, UI, Utility
- [ ] `headers` contains complete `#import` or `import` statements
- [ ] `trigger` starts with `@` and is lowercase
- [ ] `language` is `swift` or `objectivec` (lowercase)
- [ ] Code snippet is runnable with minimal edits
- [ ] Summary describes the specific use case (not generic)
- [ ] No `type:` field (this is deprecated)
- [ ] Optional fields (if provided) are well-formed: `keywords`, `tags`, `version`, `author`, `deprecated`

### Recipe Creation Principles

When creating or extracting Recipes:
1. **建议提供中英双语**：`summary_cn` + `summary_en`，并可补充双语 usage guide
2. **保持单场景**：一个 Recipe 只讲一个具体用法
3. **字段严格**：必填字段必须齐全、格式正确
   - Tools like Dashboard `/api/v1/ai/translate` can help auto-generate missing language, but it's better to provide both
2. **Split, don't combine**: If you identify 3 usage patterns in a module, create 3 separate Recipes, not 1 combined Recipe.
3. **Each Recipe has a clear trigger**: One `@trigger` for one specific scenario. E.g. `@WebViewLoadURL`, `@NetworkRetry`, `@AsyncError`.
4. **Reusable and focused**: Developer should be able to copy-paste the Recipe's code snippet and use it directly for that ONE scenario.
5. **Summary should be specific**: "Use async/await for sequential API calls" NOT "Async programming guide".
6. **Category MUST use standard values**: ONLY use one of these 8 categories: `View`, `Service`, `Tool`, `Model`, `Network`, `Storage`, `UI`, `Utility`. Never use module names (e.g. "BDNetworkControl") or other custom values as category.
7. **Headers must be complete import statements**: Extract all import/include statements from code. Format: `["import ModuleName"]` for Swift, `["#import <Module/Header.h>"]` for ObjC. Include the full statement, not just module names.
8. **Auto-extract moduleName** (ObjC): Parse from headers. Example: `["#import <BDNetworkControl/BDBaseRequest.h>"]` → `moduleName: BDNetworkControl`. If multiple modules exist, use the primary/main one.
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

## Snippet

- **Definition**: A single code snippet entry (title, trigger, body, headers, etc.) listed in the root spec or under `AutoSnippet/snippets/`.
- **Role**: Synced to Xcode CodeSnippets via **`asd install`**; developers insert by trigger or from the snippet library.
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
| **Dependency graph** | `AutoSnippet/AutoSnippet.spmmap.json`; `asd spm-map` to update; MCP graph tools for querying | autosnippet-structure |
| **Vector store** | Built by `asd embed`; `autosnippet_search(mode=context)` for on-demand lookup. Use as context storage to save space | autosnippet-concepts / autosnippet-recipes |
| **MCP tools** | `autosnippet_search` (统合搜索), `autosnippet_guard` (Guard 检查) | — |

**Principles**: Recipe is project standard, over project implementation; do not modify AutoSnippet/ directly, submit via Dashboard or MCP candidate submission. Context storage is safe; Skills express semantics, MCP provides capability; Cursor calls on demand to save space.

---

## Project-Specific Context (BiliDemo Objective-C)

This project uses **Objective-C** and is organized around several key modules and patterns:

### Module Organization

| Module | Category | Primary Use Cases |
|--------|----------|-------------------|
| **BDNetworkControl** | Network | HTTP requests, response handling, retries, timeouts, status codes |
| **BDPyramid** | Service | Module system, lifecycle hooks, context management, startup monitoring |
| **BDUIKit** | UI | Custom UI components, alerts, views, collections, animations |
| **BDFoundation** | Utility | KVO patterns, NSArray/NSDictionary helpers, type safety |
| **BDAuthor** | View | Author profile pages, custom transitions, animations |
| **BDWBISigner** | Tool | URL parameter handling, WBI signature generation |

### Objective-C Recipe Best Practices

**Headers format** (complete imports, not just module names):
```yaml
headers:
  - "#import <BDNetworkControl/BDBaseRequest.h>"
  - "#import <BDNetworkControl/BDRequestDefine.h>"
```

**Trigger naming** (use class or pattern name):
- `@BDBaseRequest` - core class patterns
- `@BDBaseRequestRetry` - specific feature patterns  
- `@BDPModule` - framework/architecture patterns
- `@KVOSafe` - safety/best practice patterns
- `@URLParameterConversion` - utility/helper patterns

**Category selection** (use 8 standard categories, not module names):
- `Network` - BDNetworkControl usage, API calls, response handling
- `Service` - BDPyramid modules, architecture, lifecycle
- `UI` - BDUIKit custom components, layouts
- `Utility` - helpers, converters, safe wrappers
- `Tool` - WBISigner, signature generation, specialized tools
- `View` - custom views, author pages, animations
- `Storage` - persistence, caching (if applicable)
- `Model` - data structures, model patterns (if applicable)

### Real-World Recipe Examples (BiliDemo)

**Example 1: Network Request Response Handling**
```yaml
id: BDBaseRequest.ResponseHandling
title: BDBaseRequest 响应与错误处理
trigger: @BDBaseRequestResponse
category: Network
language: objectivec
summary_cn: 使用 responseJson/responseString 获取成功响应，failure block 中使用 NSError。
summary_en: Use responseJson/responseString for success and NSError in failure block.
headers:
  - "#import <BDNetworkControl/BDBaseRequest.h>"
keywords: [network, response, error-handling]
tags: [network]
version: "1.0.0"
author: team_name
deprecated: false
moduleName: BDNetworkControl
deps:
  targets: ["BDNetworkControl"]
  imports: ["BDNetworkControl"]
difficulty: beginner
authority: 3
---

## Snippet / Code Reference

```objc
[req startWithCompletionBlock:^(BDBaseRequest *r) {
  id json = r.responseJson;
  NSString *raw = r.responseString;
  NSData *data = r.responseData;
  NSInteger code = r.responseStatusCode;
  NSDictionary *headers = r.responseHeaders;
} failure:^(BDBaseRequest *r, NSError *error) {
  NSLog(@"Error domain: %@, code: %ld", error.domain, (long)error.code);
}];
```

## AI Context / Usage Guide

成功响应用 responseJson（自动 JSON 解析）、responseString（raw 文本）或 responseData（二进制）；失败用 NSError 的 domain 和 code；可读 HTTP 状态码和响应头。
```

**Example 2: Module Lifecycle Pattern**
```yaml
id: BDPyramid.ModuleLifecycle
title: BDPyramid Module 定义与生命周期
trigger: @BDPyramidModule
category: Service
language: objectivec
summary_cn: 使用 ModuleDefine 声明组件，实现 BDPModuleProtocol 的注册和初始化方法。
summary_en: Define module with ModuleDefine and implement BDPModuleProtocol lifecycle.
headers:
  - "#import <BDPyramid/BDPyramid.h>"
  - "#import <BDPyramid/BDPModuleProtocol.h>"
keywords: [module, lifecycle, registration]
tags: [architecture]
version: "1.0.0"
author: team_name
deprecated: false
moduleName: BDPyramid
deps:
  targets: ["BDPyramid"]
  imports: ["BDPyramid"]
difficulty: intermediate
authority: 3
---

## Snippet / Code Reference

```objc
ModuleDefine(MyCustomModule);

@interface MyCustomModule : NSObject <BDPModuleProtocol>
@end

@implementation MyCustomModule
+ (NSInteger)modulePriority {
  return BDPModulePriorityHigh;  // Priority: higher = earlier execution
}

- (void)moduleRegister:(BDPContext *)context {
  // Register module with framework, setup initial state
}

- (void)moduleInit:(BDPContext *)context {
  // Initialize module after all modules registered
}

- (void)applicationEnvironmentDidSetup:(BDPContext *)context {
  // Called when app environment ready (window visible, etc.)
}
@end
```

## AI Context / Usage Guide

Priority 值越大越先执行；moduleRegister 用于框架内注册，moduleInit 用于初始化逻辑；可以按需实现其他生命周期方法。
```

**Example 3: Safe KVO Pattern**
```yaml
id: NSObject.KVOSafe
title: NSObject KVO 安全添加与移除
trigger: @KVOSafe
category: Utility
language: objectivec
summary_cn: 避免 KVO 重复注册或泄漏，需配对 addObserver 和 removeObserver，避免循环引用。
summary_en: Pair addObserver/removeObserver to avoid leaks and crashes.
headers:
  - "#import <Foundation/Foundation.h>"
keywords: [kvo, safety, lifecycle]
tags: [safety]
version: "1.0.0"
author: team_name
deprecated: false
moduleName: Foundation
deps:
  targets: ["Foundation"]
  imports: ["Foundation"]
difficulty: beginner
authority: 3
---

## Snippet / Code Reference

```objc
// Add observer (in init or setup)
[self.targetObject addObserver:self 
           forKeyPath:@"property" 
            options:NSKeyValueObservingOptionNew | NSKeyValueObservingOptionOld
            context:NULL];

// Observe changes
- (void)observeValueForKeyPath:(NSString *)keyPath 
            ofObject:(id)object 
            change:(NSDictionary *)change 
             context:(void *)context {
  if ([keyPath isEqualToString:@"property"]) {
    id newValue = change[NSKeyValueChangeNewKey];
    // Handle change
  }
}

// Remove observer (in dealloc, CRITICAL)
- (void)dealloc {
  [self.targetObject removeObserver:self forKeyPath:@"property"];
}
```

## AI Context / Usage Guide

必须在 dealloc 中移除，否则会导致 EXC_BAD_ACCESS；使用 weakly-held reference 避免循环引用；可用 context 参数区分多个观察者。
```

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
