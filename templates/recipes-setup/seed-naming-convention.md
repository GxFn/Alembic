---
title: Naming Convention Standard
trigger: @naming
category: Tool
language: swift
summary_cn: 命名规范：类型 PascalCase、函数/变量 camelCase、常量 UPPER_SNAKE_CASE、布尔值 is/has/should 前缀。
summary_en: Naming conventions for types, functions, variables, and constants.
headers: []
knowledgeType: code-standard
keywords: ["命名", "规范", "convention", "camelCase", "PascalCase"]
tags: [naming, code-standard, style]
whenToUse: |
  - 作为团队统一命名标准的参考
  - 代码审查时对照检查命名规范
difficulty: beginner
authority: 5
version: "1.0.0"
---

## Snippet / Code Reference

```swift
// ✅ Good Naming

// 类型: PascalCase
class UserProfileManager { }
struct NetworkResponse<T: Codable> { }
protocol DataSourceProvider { }
enum LoadingState { case idle, loading, loaded, failed }

// 函数/方法: camelCase, 动词开头
func fetchUserProfile(userId: String) async throws -> User { }
func configureTableView() { }

// 变量/属性: camelCase, 名词
let currentUser: User
var selectedIndex: Int

// 布尔值: is/has/should/can 前缀
var isLoading: Bool
var hasPermission: Bool
var shouldRefresh: Bool

// 常量: 静态常量用类型作用域
enum Constants {
    static let maxRetryCount = 3
    static let defaultTimeout: TimeInterval = 30
}

// ❌ Bad Naming
// class user_profile_mgr { }   // 不符合 PascalCase
// func DoSomething() { }       // 不符合 camelCase
// var flag: Bool                // 不明确
```

## AI Context / Usage Guide

### 关键点

- 类型名应清晰表达职责，避免缩写（Manager 优于 Mgr）
- 布尔值必须用 is/has/should/can 等前缀
- 避免单字母变量（循环计数器除外）
