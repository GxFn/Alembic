---
title: Thread Safety with Actor Pattern
trigger: @thread_safe
category: Service
language: swift
summary_cn: 使用 Actor 或串行队列保护共享状态，避免数据竞争。
summary_en: Thread safety patterns using Actor or serial queues.
headers: ["import Foundation"]
knowledgeType: best-practice
keywords: ["线程安全", "Actor", "并发", "数据竞争", "DispatchQueue"]
tags: [concurrency, thread-safety, best-practice]
whenToUse: |
  - 多线程访问共享可变状态时
  - Service 层单例需要保护内部状态时
whenNotToUse: |
  - 纯值类型且无共享引用时
  - iOS 13 以下不支持 Actor 时使用 serial queue 替代
difficulty: advanced
authority: 4
version: "1.0.0"
---

## Snippet / Code Reference

```swift
// Swift 5.5+ Actor Pattern
actor UserSessionManager {
    private var currentUser: User?
    private var token: String?

    func login(user: User, token: String) {
        self.currentUser = user
        self.token = token
    }

    func logout() {
        currentUser = nil
        token = nil
    }

    var isLoggedIn: Bool { currentUser != nil }
}

// Legacy: Serial Queue Pattern
final class LegacyCache {
    private let queue = DispatchQueue(label: "com.app.cache")
    private var storage: [String: Any] = [:]

    func set(_ value: Any, forKey key: String) {
        queue.async { self.storage[key] = value }
    }

    func get(_ key: String) -> Any? {
        queue.sync { storage[key] }
    }
}
```

## AI Context / Usage Guide

### 关键点

- 优先使用 Actor（Swift 5.5+），编译器自动保证线程安全
- Legacy 代码使用串行 DispatchQueue，读用 sync、写用 async
- 避免在 Actor 内调用耗时同步操作
