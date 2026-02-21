---
name: autosnippet-reference-swift
description: Swift 业界最佳实践参考。涵盖命名规范、Swift Concurrency、SwiftUI 模式、错误处理、内存管理、设计模式，为冷启动分析提供高质量参考标准。
---

# Swift 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 Swift 项目时，请参考以下业界标准产出高质量候选。
> **来源**: Apple API Design Guidelines, Google Swift Style Guide, Swift Language Guide, Swift Evolution Proposals

---

## 1. 命名规范 (Naming Conventions)

### 核心规则

| 标识符类型 | 风格 | 示例 |
|-----------|------|------|
| 类/结构体/枚举/协议 | `UpperCamelCase` | `NetworkManager`, `Codable` |
| 方法/函数/属性/变量 | `lowerCamelCase` | `fetchUser()`, `isEnabled` |
| 全局常量 | `lowerCamelCase` | `secondsPerMinute = 60` |
| 枚举成员 | `lowerCamelCase` | `.ascending`, `.notFound` |
| 泛型参数 | 单大写字母或 `UpperCamelCase` | `<T>`, `<Element>` |

### 命名最佳实践候选模板

```json
{
  "title": "Swift 命名: 方法名读起来像英语句子",
  "content": {
    "markdown": "## Swift 命名: 方法名读起来像英语句子\n\n### 标准模式\n```swift\n// ✅ 好的命名 — 读起来像自然语言\nfunc insert(_ element: Element, at index: Int)\nfunc distance(from start: Point, to end: Point) -> Double\nfunc makeIterator() -> Iterator\nfunc index(_ i: Index, offsetBy distance: Int) -> Index\n\n// ❌ 差的命名\nfunc insert(_ element: Element, position: Int)  // 缺少介词\nfunc dist(p1: Point, p2: Point) -> Double  // 缩写不清晰\nfunc getIterator() -> Iterator  // 不要用 get 前缀\n```",
    "pattern": "// ✅ 好的命名 — 读起来像自然语言\nfunc insert(_ element: Element, at index: Int)\nfunc distance(from start: Point, to end: Point) -> Double\nfunc makeIterator() -> Iterator\nfunc index(_ i: Index, offsetBy distance: Int) -> Index\n\n// ❌ 差的命名\nfunc insert(_ element: Element, position: Int)  // 缺少介词\nfunc dist(p1: Point, p2: Point) -> Double  // 缩写不清晰\nfunc getIterator() -> Iterator  // 不要用 get 前缀",
    "rationale": "Apple API Design Guidelines: 方法名应在调用点读起来像英语短语。参数标签选择应使调用自然流畅。"
  },
  "description": "Swift 命名: 方法名读起来像英语句子",
  "kind": "rule",
  "doClause": "Apply the Swift 命名 pattern as described",
  "language": "swift",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Swift 命名: 方法名读起来像英语句子的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "func getHeight() -> CGFloat",
    "why": "返回属性的方法不加 get 前缀（遵循 Cocoa 惯例）",
    "fix": "var height: CGFloat { ... }  // 或 func height() -> CGFloat"
  },
  "reasoning": {
    "whyStandard": "Swift API Design Guidelines 明确要求: 方法名在使用点可读、工厂方法以 make 开头、Bool 属性读作断言",
    "sources": [
      "Apple API Design Guidelines",
      "Google Swift Style Guide - Naming"
    ],
    "confidence": 0.95
  }
}
```

### 常见命名反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `kMaxRetryCount` | 匈牙利 k 前缀非 Swift 风格 | `maxRetryCount` |
| `SECONDS_PER_MINUTE` | SCREAMING_SNAKE 非 Swift 风格 | `secondsPerMinute` |
| `getHeight()` | get 前缀多余 | `height` (computed property) |
| `INetworkService` | I 前缀不符合 Swift 命名 | `NetworkService` 或 `NetworkServicing` |
| `calculateHeight()` | 返回属性时避免动词 | `height` |

### 文件命名

- 包含单一类型: `MyType.swift`
- 扩展+协议遵循: `MyType+MyProtocol.swift`
- 扩展+功能: `MyType+Additions.swift`

---

## 2. Swift Concurrency (async/await/Actor)

### 核心模式候选模板

```json
{
  "title": "Swift Concurrency: async/await 基本模式",
  "content": {
    "markdown": "## Swift Concurrency: async/await 基本模式\n\n### 标准模式\n```swift\n// ✅ 推荐: 使用 async/await\nfunc fetchUser(id: String) async throws -> User {\n  let (data, response) = try await URLSession.shared.data(from: url)\n  guard let httpResponse = response as? HTTPURLResponse,\n        httpResponse.statusCode == 200 else {\n    throw NetworkError.invalidResponse\n  }\n  return try JSONDecoder().decode(User.self, from: data)\n}\n\n// 调用\ndo {\n  let user = try await fetchUser(id: \"123\")\n  await updateUI(with: user)\n} catch {\n  handleError(error)\n}\n```",
    "pattern": "// ✅ 推荐: 使用 async/await\nfunc fetchUser(id: String) async throws -> User {\n  let (data, response) = try await URLSession.shared.data(from: url)\n  guard let httpResponse = response as? HTTPURLResponse,\n        httpResponse.statusCode == 200 else {\n    throw NetworkError.invalidResponse\n  }\n  return try JSONDecoder().decode(User.self, from: data)\n}\n\n// 调用\ndo {\n  let user = try await fetchUser(id: \"123\")\n  await updateUI(with: user)\n} catch {\n  handleError(error)\n}",
    "rationale": "async/await 替代 completion handler，使异步代码像同步代码一样可读。throws 传播错误信息而非 Result 嵌套。"
  },
  "description": "Swift Concurrency: async/await 基本模式",
  "kind": "pattern",
  "doClause": "Apply the Swift Concurrency pattern as described",
  "language": "swift",
  "headers": [],
  "category": "Service",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Swift Concurrency: async/await 基本模式的标准实现模式。",
  "scope": "universal",
  "reasoning": {
    "whyStandard": "Swift 5.5+ 的 structured concurrency 是 Apple 推荐的异步编程模型",
    "sources": [
      "Swift Language Guide - Concurrency",
      "WWDC 2021"
    ],
    "confidence": 0.95
  }
}
```

### 并行执行

```swift
// ✅ async let — 并行下载
async let firstPhoto = downloadPhoto(named: photoNames[0])
async let secondPhoto = downloadPhoto(named: photoNames[1])
let photos = await [firstPhoto, secondPhoto]

// ✅ TaskGroup — 动态数量的并行任务
let photos = await withTaskGroup(of: Data.self) { group in
  for name in photoNames {
    group.addTask { await downloadPhoto(named: name) }
  }
  var results: [Data] = []
  for await photo in group { results.append(photo) }
  return results
}
```

### Actor 隔离

```json
{
  "title": "Actor 模式: 保护共享可变状态",
  "content": {
    "markdown": "## Actor 模式: 保护共享可变状态\n\n### 标准模式\n```swift\n// ✅ 用 Actor 保护共享状态\nactor CacheStore {\n  private var cache: [String: Data] = [:]\n  \n  func get(_ key: String) -> Data? {\n    cache[key]  // actor 内部访问不需要 await\n  }\n  \n  func set(_ key: String, data: Data) {\n    cache[key] = data\n  }\n}\n\n// 外部访问需要 await\nlet store = CacheStore()\nlet data = await store.get(\"user\")\n```",
    "pattern": "// ✅ 用 Actor 保护共享状态\nactor CacheStore {\n  private var cache: [String: Data] = [:]\n  \n  func get(_ key: String) -> Data? {\n    cache[key]  // actor 内部访问不需要 await\n  }\n  \n  func set(_ key: String, data: Data) {\n    cache[key] = data\n  }\n}\n\n// 外部访问需要 await\nlet store = CacheStore()\nlet data = await store.get(\"user\")",
    "rationale": "Actor 保证同一时间只有一个任务访问其可变状态，从编译器级别消除数据竞争"
  },
  "description": "Actor 模式: 保护共享可变状态",
  "kind": "pattern",
  "doClause": "Apply the Actor 模式 pattern as described",
  "language": "swift",
  "headers": [],
  "category": "Service",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Actor 模式: 保护共享可变状态的标准实现模式。",
  "scope": "universal",
  "reasoning": {
    "whyStandard": "Actor 是 Swift Concurrency 的核心原语，取代手动 lock/queue 同步",
    "sources": [
      "Swift Language Guide - Actors"
    ],
    "confidence": 0.95
  }
}
```

### @MainActor

```swift
// ✅ UI 相关代码标注 @MainActor
@MainActor
class ProfileViewModel: ObservableObject {
  @Published var userName: String = ""

  func loadProfile() async {
    let user = await userService.fetchProfile()
    userName = user.name  // 安全: 已是主 Actor
  }
}

// ✅ 单个方法标注
@MainActor func updateUI(with data: Data) { ... }

// ✅ 闭包标注
Task { @MainActor in
  show(photo)
}
```

### Sendable

```swift
// ✅ 值类型自动 Sendable
struct TemperatureReading: Sendable {
  var measurement: Int
}

// ✅ 不可变 class 可以 Sendable
final class Config: Sendable {
  let apiURL: URL
  let timeout: TimeInterval
}

// ❌ 可变 class 不能直接 Sendable
class MutableState: Sendable {  // 编译错误
  var count = 0
}
```

---

## 3. SwiftUI 模式

### 状态管理

```json
{
  "title": "SwiftUI 状态管理: @State / @Binding / @ObservedObject / @StateObject",
  "content": {
    "markdown": "## SwiftUI 状态管理: @State / @Binding / @ObservedObject / @StateObject\n\n### 标准模式\n```swift\n// @State — View 拥有的简单值\nstruct CounterView: View {\n  @State private var count = 0\n  var body: some View {\n    Button(\"Count: \\(count)\") { count += 1 }\n  }\n}\n\n// @StateObject — View 拥有的引用类型（只创建一次）\nstruct ProfileView: View {\n  @StateObject private var viewModel = ProfileViewModel()\n}\n\n// @ObservedObject — 外部传入的引用类型（不拥有生命周期）\nstruct DetailView: View {\n  @ObservedObject var viewModel: DetailViewModel\n}\n\n// @Binding — 双向绑定子 View 到父 View 的状态\nstruct ToggleRow: View {\n  @Binding var isOn: Bool\n}\n```",
    "pattern": "// @State — View 拥有的简单值\nstruct CounterView: View {\n  @State private var count = 0\n  var body: some View {\n    Button(\"Count: \\(count)\") { count += 1 }\n  }\n}\n\n// @StateObject — View 拥有的引用类型（只创建一次）\nstruct ProfileView: View {\n  @StateObject private var viewModel = ProfileViewModel()\n}\n\n// @ObservedObject — 外部传入的引用类型（不拥有生命周期）\nstruct DetailView: View {\n  @ObservedObject var viewModel: DetailViewModel\n}\n\n// @Binding — 双向绑定子 View 到父 View 的状态\nstruct ToggleRow: View {\n  @Binding var isOn: Bool\n}",
    "rationale": "选择正确的属性包装器是 SwiftUI 正确工作的关键: @StateObject 保证只初始化一次, @ObservedObject 不持有生命周期"
  },
  "description": "SwiftUI 状态管理: @State / @Binding / @ObservedObject / @StateObject",
  "kind": "pattern",
  "doClause": "Apply the SwiftUI 状态管理 pattern as described",
  "language": "swift",
  "headers": [],
  "category": "View",
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取SwiftUI 状态管理: @State / @Binding / @ObservedObject / @StateObject的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "@ObservedObject var viewModel = ViewModel()  // ⚠️ 每次 body 重新求值都会创建新实例",
    "why": "@ObservedObject 不持有对象生命周期，如果在初始化器中创建会导致反复重建",
    "fix": "@StateObject var viewModel = ViewModel()  // ✅ 只创建一次"
  },
  "reasoning": {
    "whyStandard": "Apple WWDC 2020+ 多次强调 @StateObject vs @ObservedObject 的区别",
    "sources": [
      "Apple SwiftUI Documentation",
      "WWDC 2020 - Data Essentials in SwiftUI"
    ],
    "confidence": 0.95
  }
}
```

### Observable (iOS 17+)

```swift
// iOS 17+ 新 @Observable 宏
@Observable
class UserStore {
  var name: String = ""
  var email: String = ""
  var isLoggedIn: Bool = false
}

// 使用: 不再需要 @Published 和 @ObservedObject
struct ContentView: View {
  var store = UserStore()
  var body: some View {
    Text(store.name)  // 自动追踪细粒度变化
  }
}
```

---

## 4. 错误处理

### 推荐模式

```swift
// ✅ Typed Error enum（推荐）
enum APIError: Error, LocalizedError {
  case invalidURL
  case unauthorized
  case serverError(statusCode: Int, message: String)
  case decodingFailed(underlying: Error)

  var errorDescription: String? {
    switch self {
    case .invalidURL: return "Invalid URL"
    case .unauthorized: return "Unauthorized access"
    case .serverError(let code, let msg): return "Server error \(code): \(msg)"
    case .decodingFailed(let err): return "Decoding failed: \(err.localizedDescription)"
    }
  }
}

// ✅ throws + do-catch（推荐）
func fetchUser(id: String) throws -> User {
  guard let url = URL(string: endpoint) else {
    throw APIError.invalidURL
  }
  // ...
}

do {
  let user = try fetchUser(id: "123")
} catch APIError.unauthorized {
  redirectToLogin()
} catch {
  showAlert(error.localizedDescription)
}
```

### 错误处理反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `return nil` on error | 丢失错误信息 | `throws` |
| Generic `Error` string | 无法精确 catch | typed `enum Error` |
| `try!` in production | 运行时崩溃 | `do-catch` 或 `try?` |
| `catch { }` 空 catch | 吞掉错误 | 至少 log |

### guard 早返回

```swift
// ✅ guard 用于前置条件检查
func process(data: Data?) throws -> Result {
  guard let data = data else {
    throw ProcessError.noData
  }
  guard data.count > 0 else {
    throw ProcessError.emptyData
  }
  guard let decoded = try? JSONDecoder().decode(Result.self, from: data) else {
    throw ProcessError.decodingFailed
  }
  return decoded
}
```

---

## 5. 内存管理 (ARC)

### 核心规则

```json
{
  "title": "ARC 内存管理: [weak self] 在逃逸闭包中",
  "content": {
    "markdown": "## ARC 内存管理: [weak self] 在逃逸闭包中\n\n### 标准模式\n```swift\n// ✅ 正确: 逃逸闭包使用 [weak self]\nclass ViewModel {\n  func startObserving() {\n    NotificationCenter.default.addObserver(\n      forName: .dataChanged, object: nil, queue: .main\n    ) { [weak self] notification in\n      self?.handleDataChange(notification)\n    }\n  }\n}\n\n// ✅ 正确: 非逃逸闭包不需要 weak self\nlet filtered = items.filter { $0.isActive }  // 不需要 [weak self]\nlet mapped = items.map { transform($0) }  // 不需要 [weak self]\n\n// ❌ 错误: delegate 使用 strong 引用\nclass Parent {\n  let child = Child()\n  init() { child.delegate = self }  // retain cycle!\n}\n// ✅ 修复\nweak var delegate: ChildDelegate?\n```",
    "pattern": "// ✅ 正确: 逃逸闭包使用 [weak self]\nclass ViewModel {\n  func startObserving() {\n    NotificationCenter.default.addObserver(\n      forName: .dataChanged, object: nil, queue: .main\n    ) { [weak self] notification in\n      self?.handleDataChange(notification)\n    }\n  }\n}\n\n// ✅ 正确: 非逃逸闭包不需要 weak self\nlet filtered = items.filter { $0.isActive }  // 不需要 [weak self]\nlet mapped = items.map { transform($0) }  // 不需要 [weak self]\n\n// ❌ 错误: delegate 使用 strong 引用\nclass Parent {\n  let child = Child()\n  init() { child.delegate = self }  // retain cycle!\n}\n// ✅ 修复\nweak var delegate: ChildDelegate?",
    "rationale": "ARC 内存管理: [weak self] 在逃逸闭包中的标准实现模式。"
  },
  "description": "ARC 内存管理: [weak self] 在逃逸闭包中",
  "kind": "pattern",
  "doClause": "Apply the ARC 内存管理 pattern as described",
  "language": "swift",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取ARC 内存管理: [weak self] 在逃逸闭包中的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "closure { self.doSomething() }  // 在异步/存储的闭包中",
    "why": "如果 self 持有闭包（直接或通过中间对象），形成 retain cycle",
    "fix": "closure { [weak self] in self?.doSomething() }"
  },
  "reasoning": {
    "whyStandard": "ARC 下闭包默认 strong capture，是 iOS 开发中最常见的内存泄漏来源",
    "sources": [
      "Apple ARC Documentation",
      "WWDC Memory Management Sessions"
    ],
    "confidence": 0.95
  }
}
```

### 判断是否需要 [weak self]

| 场景 | 需要 weak self? | 原因 |
|------|----------------|------|
| `map`/`filter`/`reduce` | ❌ | 非逃逸闭包 |
| `UIView.animate` | ❌ | 系统不持有，执行完释放 |
| `NotificationCenter.addObserver` | ✅ | 长期持有 |
| `DispatchQueue.async`（延迟/重复） | ✅ | 可能延长 self 生命周期 |
| 存储为属性的闭包 | ✅ | 形成 self → closure → self |
| `Task { }` | 视情况 | Task 不形成 retain cycle，但可能延长生命周期 |

---

## 6. 设计模式

### Protocol-Delegate

```swift
// ✅ 标准 Delegate 模式
protocol DataSourceDelegate: AnyObject {  // AnyObject 允许 weak
  func dataSource(_ dataSource: DataSource, didUpdateItems items: [Item])
  func dataSourceDidFinishLoading(_ dataSource: DataSource)
}

class DataSource {
  weak var delegate: DataSourceDelegate?  // weak 防止 retain cycle

  func reload() {
    // ...
    delegate?.dataSource(self, didUpdateItems: items)
    delegate?.dataSourceDidFinishLoading(self)
  }
}
```

### MVVM

```swift
// ✅ MVVM with Combine
@MainActor
class UserListViewModel: ObservableObject {
  @Published private(set) var users: [User] = []
  @Published private(set) var isLoading = false
  @Published private(set) var error: Error?

  private let userService: UserServiceProtocol

  init(userService: UserServiceProtocol) {
    self.userService = userService
  }

  func loadUsers() async {
    isLoading = true
    defer { isLoading = false }
    do {
      users = try await userService.fetchUsers()
    } catch {
      self.error = error
    }
  }
}
```

### Protocol Extensions (Mixin)

```swift
// ✅ Protocol Extension 提供默认实现
protocol Loadable {
  var isLoading: Bool { get set }
  func showLoadingIndicator()
  func hideLoadingIndicator()
}

extension Loadable where Self: UIViewController {
  func showLoadingIndicator() {
    // 默认实现: 添加 ActivityIndicator
  }
  func hideLoadingIndicator() {
    // 默认实现: 移除 ActivityIndicator
  }
}
```

---

## 7. 代码格式与风格

### 关键规则速查

| 规则 | 标准 |
|------|------|
| 列宽限制 | 100 字符 |
| 缩进 | 2 空格（Google）/ 4 空格（Apple 默认） |
| 大括号 | K&R 风格（开括号不换行） |
| 分号 | 不使用 |
| trailing comma | 多行数组/字典末尾必须加逗号 |
| `self` | 仅在 init 赋值消歧义时使用显式 self |
| `guard` | 前置条件检查优先用 guard 而非嵌套 if |
| `for-where` | `for item in list where item.isActive` 代替 `for + if` |
| Switch case | 不使用 fallthrough，用逗号合并 case |
| 属性 | 只读 computed property 省略 get { } |
| import | 按字母排序，@testable 放最后 |

### trailing closure

```swift
// ✅ 单个尾随闭包: 省略括号
let squares = [1, 2, 3].map { $0 * $0 }

Timer.scheduledTimer(timeInterval: 30, repeats: false) { timer in
  print("Done!")
}

// ✅ 多个闭包参数: 不使用尾随闭包语法
UIView.animate(
  withDuration: 0.5,
  animations: {
    view.alpha = 1.0
  },
  completion: { finished in
    print("Done")
  }
)
```

---

## 8. Swift 特有维度 (extraDimensions)

冷启动分析 Swift 项目时，除了 9 通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **Swift Concurrency 模式** | Task/async-let/TaskGroup/Actor 使用方式 | `best-practice` |
| **SwiftUI 状态管理** | @State/@Binding/@StateObject/@Observable 使用 | `code-pattern` |
| **Combine 管道** | Publisher 链、订阅管理、内存 | `data-flow` |
| **Protocol 组合** | 协议继承、默认实现、类型擦除 | `code-pattern` |
| **Property Wrapper** | @Published/@AppStorage/自定义包装器 | `code-pattern` |
| **Result Builder** | @ViewBuilder/自定义 DSL | `code-pattern` |
| **Macro** | Swift 5.9+ 宏使用 | `code-pattern` |

---

## Related Skills

- **autosnippet-coldstart**: 完整冷启动流程（本 Skill 的主 Skill）
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
