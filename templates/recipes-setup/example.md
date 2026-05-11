---
# 必填字段
title: Basic URLSession GET Request Template
trigger: @request
category: Network
language: swift
summary_cn: 使用 URLSession 发起 GET 请求并解析 JSON 的标准写法，适用于不依赖第三方库的场景。
summary_en: Standard URLSession GET request with JSON parsing. No third-party dependencies.
headers: ["import Foundation"]

# 可选字段（强烈推荐）
knowledgeType: code-pattern
keywords: ["网络请求", "URLSession", "async", "JSON", "GET", "HTTP"]
tags: [network, template, production-ready]
whenToUse: |
  - 需要从远端 API 发起简单 GET 请求并拿到 JSON 时
  - 不引入第三方网络库、仅用系统 URLSession 时
  - 作为团队统一的请求写法模板，再按需替换 URL/Header/解析逻辑时
whenNotToUse: |
  - 生产环境已有统一网络层（AF/Alamofire 或自研 Client）时应优先用现有方案
  - 需要 WebSocket、长连接、流式响应时应用专用方案
  - 需要复杂重试、超时策略时建议用更完整封装
difficulty: intermediate
authority: 4
relatedRecipes: ["@error_handling", "@async_await"]
version: "1.0.0"
updatedAt: 1706515200
author: team
deprecated: false
---

## Snippet / Code Reference

```swift
let url = URL(string: "https://api.example.com/resource")!
var request = URLRequest(url: url)
request.httpMethod = "GET"
request.setValue("application/json", forHTTPHeaderField: "Accept")

URLSession.shared.dataTask(with: request) { data, response, error in
  if let error = error {
    print("Request failed: \(error)")
    return
  }
  guard let data = data,
      let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
    return
  }
  if let json = try? JSONSerialization.jsonObject(with: data) {
    print(json)
  }
}.resume()
```

## AI Context / Usage Guide

### 什么时候用

- 在 App 内需要发起简单 GET 请求并拿到 JSON 时。
- 不依赖第三方库、仅用系统 URLSession 的场景。
- 作为「请求模板」统一团队写法，再按需替换 URL、Header、解析逻辑。

### 何时不用

- 生产环境应统一用项目内的网络层（如已有 AF/Alamofire 或自研 Client），本片段仅作标准写法参考。
- 需要 POST、自定义 Header、Body 时，在 `request` 上设置 `httpMethod`、`setValue`、`httpBody` 即可；大响应或流式场景请用 `URLSessionDelegate` 或 `URLSessionStreamTask`，不要仅靠 `dataTask`。

### 使用步骤

1. 构造 `URL` 与 `URLRequest`，按需设置 `httpMethod`、Header。
2. 使用 `URLSession.shared.dataTask(with:completionHandler:)` 发起请求。
3. 在 completion 中先处理 `error`，再校验 `response` 状态码与 `data`，最后解析 JSON 或直接使用 data。

### 关键点

- 错误处理这里仅 `print`，实际应通过回调或 async/await 向上传递。
- 回调在后台线程执行，若需更新 UI 请切回主线程（如 `DispatchQueue.main.async`）。
- 大响应或流式场景请用 `URLSessionDelegate` 或流式 API，不要仅靠一次性 `dataTask`。

### 依赖与前置条件

- 需导入 `Foundation`。
- 如需网络权限，确保 App Transport Security 配置正确。

### 错误处理

- 对 `error` 做分支处理，必要时做重试或降级。
- 对超时/无网络场景给出用户提示。

### 性能与资源

- 大响应建议启用缓存或分块处理。
- 频繁请求应做节流或合并。

### 安全与合规

- 不要在日志中输出敏感信息或完整 token。
- 必要时启用证书校验或签名。

### 常见误用

- 直接在回调线程更新 UI。
- 忽略状态码只判断 `error`。

### 最佳实践

- 将 URL、超时、重试等配置集中管理，避免散落各处。
- 使用 `async/await` 时可用 `URLSession.shared.data(for: request)`（iOS 15+），逻辑更清晰。
- 需要超时、取消时，在 `URLSessionConfiguration` 或 `URLSessionTask` 上配置。

### 替代方案

- **URLSession.data(for:)**：iOS 15+ 原生 async/await，无需回调。
- **Alamofire / 自研 Client**：需要统一重试、日志、拦截器时使用。
- **WebSocket / 流式**：实时或流式场景选用对应 API。

### 相关 Recipe

- `@error_handling`
- `@async_await`
