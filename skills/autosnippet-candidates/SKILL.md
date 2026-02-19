---
name: autosnippet-candidates
description: Generate Recipe candidates with full V3 structured information. Single file scan or batch Target scan. Agent extracts rich metadata matching the complete Recipe schema. Agent submits candidates only; Recipe creation/modification is human-only.
---

# AutoSnippet - Generate Candidates with Structured Content (v3.1)

> Self-check and Fallback: MCP tools return unified JSON Envelope. Before heavy ops call `autosnippet_health`. On failure do not retry in same turn; use static context or narrow scope.

## Core Rule: Agent Permission Boundary

**Agent CANNOT directly produce or modify Recipes.** Agent can only:
- Submit Recipe **candidates** (submit_candidate / submit_candidates / submit_draft_recipes)
- **Validate/enhance** candidates (validate_candidate / check_duplicate)
- **Search/query** existing Recipes for context and dedup

Recipe creation, review, publish, update, deprecate, delete are **human-only via Dashboard**.

---

## ⚠️ Recipe-Ready Checklist (CRITICAL — STRICT ENFORCEMENT)

**MCP 不再使用项目内 AI**——外部 Agent 必须自行提供所有字段。**缺少必要字段的提交将被直接拒绝（不入库）**，不会降级处理。

**严格规则**：
- 所有必填字段必须在**单次调用**中一次性提供
- 缺字段的提交会返回 `errorCode: INCOMPLETE_SUBMISSION`，不会创建任何记录
- **禁止**先提交不完整数据再补全重新提交 — 这会浪费 Token 和时间
- 提交前自行确认所有字段齐全，一次通过

| 字段 | 级别 | 要求 | 示例 |
|------|------|------|------|
| `title` | 必填 | 中文简短标题（≤20字） | "视频封面 Cell 16:9 布局与时长格式化" |
| `content.pattern` / `content.markdown` | 必填 | 代码片段或 Markdown 正文 | 完整可运行的使用示例 |
| `content.rationale` | 必填 | 设计原理说明 | "统一封面布局避免手动计算" |
| `language` | 必填 | `swift` / `objectivec` | 小写，不要用 `objc` |
| `kind` | 必填 | `rule` / `pattern` / `fact` | 知识类型 |
| `doClause` | 必填 | 英文祈使句正向指令（≤60 tokens） | "Use AspectRatioContainer for 16:9 layout" |
| `category` | 必填 | 8 选 1 | View/Service/Tool/Model/Network/Storage/UI/Utility |
| `trigger` | 必填 | @ 开头小写 | `@video-cover-cell` |
| `description` | 必填 | 中文摘要 ≤80字 | "封面图片 16:9 自适应布局…" |
| `headers` | 必填 | 完整 import 语句数组 | `["#import <UIKit/UIKit.h>"]` |
| `usageGuide` | 必填 | Markdown ### 章节格式 | 描述何时/如何使用此知识 |
| `knowledgeType` | 必填 | 知识维度 | `code-pattern` / `architecture` / `best-practice` 等 |
| `reasoning` | 强烈建议 | whyStandard + sources + confidence | 见 Layer 6 |

**工作流程**：
1. Agent 提取候选时**一次性填写全部必填字段**
2. 调用 `autosnippet_submit_knowledge` 提交
3. 若返回 `INCOMPLETE_SUBMISSION` → 检查 `missingFields`，补齐后重新提交
4. 提交成功 = 候选可直接审核为 Recipe

---

## Quick Start

**Scenario 1: User says "scan a module/file to generate candidates"**
1. Read target file/module (including README or examples)
2. Extract public APIs, usage examples, doc comments
3. Generate multiple candidates (one pattern per candidate)
4. Parallel query existing Recipes -> mark similarity/conflicts
5. Score and rank -> submit Candidates

**Scenario 2: User says "batch scan Target"**
1. Call `autosnippet_structure(operation=targets)` -> select targetName
2. Call `autosnippet_structure(operation=files, targetName)`
3. Batch extract candidates (parallel)
4. Dedup, score, similarity mark -> submit Candidates

---

## V3 Complete Candidate Field Model

Every candidate submitted via `submit_candidate` or `submit_candidates` supports the following fields. **The richer the information, the higher the quality of the resulting Recipe.**

### Layer 1: Core Identity (required — submission fails without these)

| Field | Type | Example |
|-------|------|---------|
| **title** | string | "网络请求统一封装 - APIClient" |
| **code** | string | The code pattern (maps to `content.pattern`). Use Xcode placeholders `<#name#>` for variables. |
| **language** | string | swift / objc / javascript / python etc. |

### Layer 2: Classification (strongly recommended — enables filtering & search)

| Field | Type | Values / Example |
|-------|------|-----------------|
| **category** | string | View / Service / Tool / Model / Network / Storage / UI / Utility |
| **knowledgeType** | string | `code-pattern` \| `architecture` \| `best-practice` \| `code-standard` \| `code-relation` \| `inheritance` \| `call-chain` \| `data-flow` \| `module-dependency` \| `boundary-constraint` \| `code-style` \| `solution` \| `dev-document` |
| **complexity** | string | `beginner` \| `intermediate` \| `advanced` |
| **scope** | string | `universal` (通用) \| `project-specific` (本项目) \| `target-specific` (特定 Target) |
| **tags** | string[] | `["networking", "async-await", "error-handling"]` |

### Layer 3: Description & Documentation (强烈建议 — 含双语字段)

| Field | Type | Description |
|-------|------|-------------|
| **description** | string | 一句话功能描述 |
| **summary** | string | 中文详细摘要（等同 summary_cn，Markdown），含功能介绍、设计背景 |
| **summary_cn** | string | 中文摘要（≤100字）— 与 summary 二选一 |
| **summary_en** | string | 英文摘要（≤100 words）— **强烈建议**，提升检索与 AI 理解 |
| **trigger** | string | 触发关键词，**必须** `@` 开头。如 `@api-client` |
| **usageGuide** | string | 中文使用指南（等同 usageGuide_cn，Markdown），包含 `###` 章节 |
| **usageGuide_cn** | string | 中文使用指南 — 与 usageGuide 二选一 |
| **usageGuide_en** | string | 英文使用指南（Markdown ### 章节）— **推荐** |

### Layer 4: Structured Content (high value — enables step-by-step guidance & code diff)

| Field | Type | Structure |
|-------|------|-----------|
| **rationale** | string | 设计原理：为什么选择这种模式、优于其他方案的原因 |
| **steps** | array | 实施步骤：`[{title: "创建 Service", description: "在 Services/ 下创建…", code: "class MyService { ... }"}]` |
| **codeChanges** | array | 代码变更：`[{file: "APIClient.swift", before: "URLSession.shared...", after: "apiClient.request(...)", explanation: "替换为统一封装"}]` |
| **verification** | object | 验证方式：`{method: "unit-test", expectedResult: "所有请求通过 apiClient", testCode: "func testAPI() {...}"}` |
| **headers** | string[] | 需要的 import/include：`["import Foundation", "import Combine"]` |

### Layer 5: Constraints & Relations (high value — enables dependency analysis & Guard rules)

| Field | Type | Structure |
|-------|------|-----------|
| **constraints** | object | `{boundaries: ["仅限 iOS 15+"], preconditions: ["需先初始化 NetworkConfig"], sideEffects: ["修改全局代理设置"], guards: [{pattern: "URLSession\\.shared", severity: "warning", message: "请使用 APIClient"}]}` |
| **relations** | object | `{dependsOn: [{target: "NetworkConfig", description: "依赖网络配置"}], extends: [...], conflicts: [...], related: [...], inherits: [...], implements: [...], calls: [...], dataFlow: [...]}` — 每项 `{target, description}` |

### Layer 6: Reasoning 推理依据 (required — Agent 必填，缺少将被拒绝)

| Field | Type | Description |
|-------|------|-------------|
| **reasoning.whyStandard** | string | 为什么这段代码值得沉淀为知识。必须回答：“它解决了什么问题”“为什么是标准做法”“不用会怎样” |
| **reasoning.sources** | string[] | 来源列表：文件路径、文档链接、上下文引用。如 `["Sources/Network/BiliAPI.swift", "README.md#networking"]` |
| **reasoning.confidence** | number | 置信度 0-1。`0.9`=明确的项目标准，`0.7`=常见模式但未明确规定，`0.5`=可能有用但不确定 |
| reasoning.qualitySignals | object | 质量信号（可选）：`{clarity: 0.9, reusability: 0.8, importance: 0.7}` |
| reasoning.alternatives | string[] | 备选方案（可选）：如果存在替代实现，简要描述 |

> **Reasoning 为什么重要？** 它是审核员判断候选质量的关键依据。没有 Reasoning 的候选无法通过校验。

### Layer 7: Quality & Source (optional — helps prioritize review)

| Field | Type | Structure |
|-------|------|-----------|
| **quality** | object | `{codeCompleteness: 0.9, projectAdaptation: 0.8, documentationClarity: 0.85}` (0-1) |
| **sourceFile** | string | 来源文件路径（相对于项目根目录） |

---

## Information Extraction Strategy

### Per-File Analysis Checklist

When scanning a source file, systematically extract:

1. **What does it do?** → `title`, `description`, `summary`, `category`
2. **How to use it?** → `code` (complete usage example), `trigger`, `usageGuide`, `headers`
3. **Why this design?** → `rationale`, `knowledgeType`
4. **Why is it worth extracting?** → `reasoning.whyStandard` (解决了什么问题？不用会怎样？), `reasoning.confidence`
5. **Where does it come from?** → `reasoning.sources` (文件路径), `sourceFile`
6. **How to implement step by step?** → `steps`, `codeChanges`
7. **What are the constraints?** → `constraints` (boundaries, preconditions, sideEffects)
8. **Any inline rules to enforce?** → `constraints.guards` (regex pattern + severity + message)
9. **What's the difficulty?** → `complexity`
10. **What does it depend on / relate to?** → `relations`, `headers`
11. **How to verify correctness?** → `verification`
12. **Quality assessment** → `quality` (code completeness, project adaptation, doc clarity)

### Knowledge Type Decision Tree

```
Is it a coding rule/standard/naming convention?
  → code-standard | code-style | boundary-constraint

Is it a reusable code pattern/template?
  → code-pattern | solution | best-practice

Is it describing code structure/relationships?
  → code-relation | inheritance | call-chain | data-flow | module-dependency

Is it an architectural decision or design pattern?
  → architecture
```

### Extracting Reasoning (MANDATORY for every candidate)

Agent must answer three questions for every candidate:

1. **whyStandard** — "Why is this code worth documenting as project knowledge?"
   - "This pattern is used in 5+ places and inconsistent implementations cause bugs"
   - "This is the team's agreed-upon approach; deviations lead to maintenance issues"
   - "New contributors frequently make mistakes here without guidance"
   
2. **sources** — "What evidence supports this?"
   - File paths where the pattern is defined or used
   - README sections or doc comments that describe the convention
   - Code review comments or commit messages (if available)

3. **confidence** — "How sure am I?"
   - `0.85-1.0`: Explicit project standard, documented convention, or widely used pattern
   - `0.6-0.85`: Common pattern, reasonable to standardize but not explicitly documented
   - `0.3-0.6`: Potentially useful but context is limited; may need human review
   - Below `0.3`: Do not submit — confidence too low

### Extracting Guards (inline enforcement rules)

When you identify patterns that **should be enforced** (e.g., "always use X instead of Y"), create a `constraints.guards` entry:

```json
{
  "constraints": {
    "guards": [
      {
        "pattern": "URLSession\\.shared\\.dataTask",
        "severity": "warning",
        "message": "请使用 APIClient.request() 代替直接 URLSession 调用"
      }
    ]
  }
}
```

Severity: `error` (must fix) | `warning` (should fix) | `info` (suggestion)

---

## Single File / Module Scan Flow
1. Read file → find public classes/functions/common patterns
2. Per-file checklist extraction (10 dimensions above)
3. Call `autosnippet_search(mode=context)` to mark similarity and fill `relations`
4. `autosnippet_submit_knowledge` submit single (built-in auto-validate + dedup)
6. `autosnippet_submit_knowledge` or `autosnippet_submit_knowledge_batch` to submit

## Batch Target Scan Flow
1. `autosnippet_structure(operation=targets)` → select targetName
2. `autosnippet_structure(operation=files, targetName)`
3. Parallel scan → per-file checklist extraction → aggregate / dedup / score
4. `autosnippet_submit_knowledge_batch` batch submit — **all V3 fields are preserved**

## Draft File Flow (alternative)
1. Create draft folder (e.g. `.autosnippet-drafts/`) outside `AutoSnippet/`
2. Generate one .md per pattern in draft folder
3. Call `autosnippet_submit_knowledge_batch` with filePaths and `deleteAfterSubmit: true`
4. Delete draft folder after submit

---

## MCP Tools for Candidate Workflow

| Tool | Usage |
|------|-------|
| `autosnippet_structure(operation=targets)` | List project Targets for batch scan |
| `autosnippet_structure(operation=files)` | Get files for a Target |
| `autosnippet_structure(operation=metadata)` | Get Target metadata (dependencies, path) |
| `autosnippet_search(mode=context)` | Find similar existing Recipes → fill `relations` |
| `autosnippet_submit_knowledge` | Submit single candidate (**all V3 fields**, built-in auto-validate + dedup) |
| `autosnippet_submit_knowledge_batch` | Batch submit candidates (**all V3 fields preserved**) |

---

## Key Principles

1. **One candidate per pattern** — no "catch-all" candidates
2. **Maximize information density** — Agent's primary value is extracting structured metadata that humans would skip
3. **Always fill Layer 1-3 + Reasoning + Recipe-Ready Checklist** at minimum; Layer 4-7 for complex patterns
4. **Reasoning is mandatory** — Every candidate MUST include `reasoning.whyStandard` + `reasoning.sources` + `reasoning.confidence`. No exceptions.
5. **Bilingual recommended** — `summary_cn` + `summary_en`, `usageGuide` + `usageGuide_en`. English improves AI understanding and search.
6. **Check `recipeReadyHints` in submit response** — If not empty, supplement fields and resubmit
7. **Parallel query existing Recipes** during generation to reduce duplicates and fill `relations`
6. **Code examples**: use Xcode placeholders (`<#URL#>`, `<#Token#>`), explain in `usageGuide`
7. **Failure**: do not retry same turn; narrow scope or use static context

---

## Usage Guide Format (CRITICAL)

**MUST use Markdown format:**
- **MUST use `###` section headings** for each major content block
- **MUST use `-` bullet lists** with each item on its own line
- **NEVER** put all content in one continuous line

**BAD:**
```
When to use: Scenario A; Scenario B. Key points: Point 1; Point 2.
```

**GOOD:**
```
### When to use
- Scenario A
- Scenario B

### Key points
- Point 1: details
- Point 2: details
```

Recommended sections: When to use / When not to use / Key points / Dependencies / Core steps / Error handling / Performance / Security / Common pitfalls / Related Recipes.

---

## Semantic Field Enrichment (Two-Pass Workflow)

**重要：MCP 不再使用项目内 AI。**外部 Agent 必须自行填写所有字段。

### 首选：一次性提交全字段

按上述 Layer 1-7 + Recipe-Ready Checklist，提交时尽量填充全部字段。

### 备选：二次补全流程

Step 1: 提交基本字段（title, code, language）→ 获得 candidate ID（`autosnippet_submit_knowledge` 内置自动校验 + 去重检查）
Step 2: 根据提交返回的校验结果补全缺失字段
Step 3: 重新提交完整候选

> 注：`autosnippet_enrich_candidates` / `autosnippet_validate_candidate` / `autosnippet_check_duplicate` 已移入 admin 层级。Agent 层级的 `autosnippet_submit_knowledge` 已内置自动校验 + 去重，无需额外调用。

需要补全的两层字段：
- **语义字段**: rationale, knowledgeType, complexity, scope, steps, constraints
- **Recipe 必填**: category, trigger, summary_cn, summary_en, headers, usageGuide

---

## Submit Example (batch)

```json
{
  "targetName": "BiliKit",
  "items": [
    {
      "title": "BiliAPI 网络请求封装",
      "code": "class BiliAPI {\n  static func request<T: Decodable>(_ endpoint: Endpoint) async throws -> T {\n    let (data, response) = try await URLSession.shared.data(for: endpoint.urlRequest)\n    guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {\n      throw BiliError.invalidResponse\n    }\n    return try JSONDecoder().decode(T.self, from: data)\n  }\n}",
      "language": "swift",
      "category": "Network",
      "knowledgeType": "code-pattern",
      "complexity": "intermediate",
      "scope": "project-specific",
      "tags": ["networking", "async-await", "generic", "decodable"],
      "description": "统一的 API 请求封装，支持泛型解码和错误处理",
      "summary": "基于 async/await 的网络请求封装层，提供类型安全的 API 调用接口。统一错误处理、响应验证和 JSON 解码。",
      "trigger": "@bili-api-request",
      "usageGuide": "### When to use\n- 所有 B 站 API 调用\n- 需要类型安全的响应解码\n\n### Dependencies\n- Foundation\n- BiliKit/Models (Endpoint, BiliError)\n\n### Core steps\n1. 定义 Endpoint\n2. 调用 BiliAPI.request(endpoint)\n3. 处理 Result",
      "rationale": "统一网络层避免各模块各自实现 URLSession 调用，减少重复代码并统一错误处理策略。",
      "steps": [
        {"title": "定义 Endpoint", "description": "创建符合 Endpoint 协议的请求描述", "code": "struct UserInfoEndpoint: Endpoint { ... }"},
        {"title": "发起请求", "description": "调用统一 API 方法", "code": "let user: UserInfo = try await BiliAPI.request(UserInfoEndpoint(uid: uid))"}
      ],
      "codeChanges": [
        {"file": "Sources/Network/OldAPI.swift", "before": "URLSession.shared.dataTask(with: url) { ... }", "after": "let result: T = try await BiliAPI.request(endpoint)", "explanation": "替换回调式为 async/await"}
      ],
      "headers": ["import Foundation", "import BiliKit"],
      "constraints": {
        "preconditions": ["需要有效的网络连接", "Endpoint 必须实现 urlRequest 属性"],
        "sideEffects": ["发起网络请求"],
        "guards": [{"pattern": "URLSession\\.shared\\.dataTask", "severity": "warning", "message": "请使用 BiliAPI.request() 统一封装"}]
      },
      "quality": {"codeCompleteness": 0.9, "projectAdaptation": 0.85, "documentationClarity": 0.8},
      "sourceFile": "Sources/BiliKit/Network/BiliAPI.swift",
      "reasoning": {
        "whyStandard": "项目中所有模块都通过 BiliAPI 发起请求，新人经常直接使用 URLSession.shared 导致错误处理不统一和重复代码。沉淀为标准后可通过 Guard 自动检查。",
        "sources": ["Sources/BiliKit/Network/BiliAPI.swift", "Sources/BiliKit/Network/Endpoint.swift", "README.md#networking"],
        "confidence": 0.9,
        "qualitySignals": {"clarity": 0.9, "reusability": 0.85, "importance": 0.9},
        "alternatives": ["直接使用 Alamofire 封装，但项目已选择轻量原生方案"]
      }
    }
  ],
  "source": "cursor-scan",
  "deduplicate": true
}
```
