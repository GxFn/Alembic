---
# Required Fields
title: Your Recipe Title Here (English, ≤50 chars, verb-based)
trigger: @my_trigger
category: Network  # MUST be one of: View, Service, Tool, Model, Network, Storage, UI, Utility
language: swift  # swift, objectivec, go, python, java, kotlin, javascript, typescript, dart, rust
summary_cn: Chinese summary, ≤100 chars
summary_en: English summary, ≤100 words
headers: ["import Foundation"]  # Complete import statement array
knowledgeType: code-pattern  # code-pattern, architecture, best-practice, code-standard, code-style, code-relation, data-flow, event-and-data-flow, module-dependency, boundary-constraint, solution, anti-pattern

# V3 Cursor Delivery Required Fields
kind: pattern  # rule = mandatory constraint | pattern = reusable pattern | fact = project fact
doClause: "Use dependency injection via constructor"  # English imperative, verb-first, ≤60 tokens
dontClause: "Don't instantiate services with new directly"  # English negative constraint
whenClause: "When creating a new service class"  # English trigger scenario
coreCode: |
  class MyService {
    constructor(private db: Database) {}
  }
usageGuide: |
  ### When to Use
  When creating a new Service class
  ### Convention
  Always use constructor injection

# Optional Fields (recommended)
keywords: ["keyword1", "keyword2", "keyword3"]
tags: [tag1, tag2]
whenToUse: |
  - Applicable scenario 1
  - Applicable scenario 2
  - Applicable scenario 3
whenNotToUse: |
  - Scenario to avoid 1
  - Scenario to avoid 2
difficulty: beginner  # beginner, intermediate, advanced
authority: 1  # 1~5
relatedRecipes: ["@related_recipe_trigger"]
version: "1.0.0"
updatedAt: 1706515200
author: team_name
deprecated: false
---

## Snippet / Code Reference

```
// Paste or write code snippet here (ideally runnable, with error handling and comments)
```

## AI Context / Usage Guide

### When to Use

- Applicable scenario description
- Typical business or technical context
- Typical user role

### When Not to Use

- Exclusion scenarios, easy-to-misuse cases
- When to apply alternatives

### Steps

1. Step 1: Preparation or prerequisites
2. Step 2: Core logic
3. Step 3: Result handling or follow-up

### Key Points

- Error-prone areas, easily overlooked details
- Thread/memory/lifecycle constraints
- Performance characteristics or limitations

### Dependencies & Prerequisites

- Required modules/frameworks to import
- Minimum system/API version
- 权限、配置或环境要求

### 错误处理

- 常见失败场景和处理方式
- 重试、超时、降级策略
- 异常分支处理

### 性能与资源

- 缓存、内存使用、线程安全
- 频率限制或节流建议
- 大数据量或高并发处理

### 安全与合规

- 敏感信息处理（token、密钥等）
- 鉴权、日志脱敏策略
- 合规要求（数据保护、用户隐私）

### 常见误用

- ❌ 错误做法 1：原因分析
- ❌ 错误做法 2：原因分析
- ✅ 正确做法：推荐方式

### 最佳实践

- 推荐做法 1：适用场景或原因
- 推荐做法 2：性能或可维护性考量
- 推荐工具或设计模式

### 替代方案

- **方案 A**：优缺点对比
- **方案 B**：何时优先使用
- **其他 Recipe**：关联或互补方案

### 相关 Recipe

- `@相关_trigger_1`：简要说明关系
- `@相关_trigger_2`：简要说明关系
