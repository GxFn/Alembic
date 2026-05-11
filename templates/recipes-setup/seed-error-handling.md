---
title: Error Handling Best Practice
trigger: @error_handling
category: Tool
language: swift
summary_cn: 统一错误处理模式：定义专用错误枚举、使用 do-catch/Result、提供用户友好错误信息。
summary_en: Standardized error handling with dedicated error types and user-friendly messages.
headers: ["import Foundation"]
knowledgeType: best-practice
keywords: ["错误处理", "Error", "do-catch", "Result", "异常"]
tags: [error-handling, best-practice, production-ready]
whenToUse: |
  - 需要统一团队的错误处理方式
  - 需要提供用户友好的错误信息
  - 需要区分可恢复和不可恢复的错误
whenNotToUse: |
  - 简单脚本或原型代码
difficulty: intermediate
authority: 4
version: "1.0.0"
---

## Snippet / Code Reference

```swift
enum AppError: LocalizedError {
    case networkUnavailable
    case invalidResponse(statusCode: Int)
    case decodingFailed(underlying: Error)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .networkUnavailable:
            return "网络不可用，请检查连接"
        case .invalidResponse(let code):
            return "服务器响应异常 (\(code))"
        case .decodingFailed:
            return "数据解析失败"
        case .unauthorized:
            return "请重新登录"
        }
    }
}
```

## AI Context / Usage Guide

### 什么时候用

- 创建新模块时定义该模块的专用错误类型
- 需要向用户展示可读的错误信息时

### 使用步骤

1. 定义模块专用 Error 枚举，遵循 LocalizedError
2. 在业务代码中抛出具体错误
3. 在 UI 层捕获并展示 errorDescription
