```skill
---
name: autosnippet-reference-go
description: Go 业界最佳实践参考。涵盖模块组织、命名约定、错误处理、接口与组合、并发(goroutine/channel)、Context、struct 设计、测试，为冷启动分析提供高质量参考标准。
---

# Go 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 Go 项目时，请参考以下业界标准产出高质量候选。
> **来源**: Effective Go, Go Code Review Comments, Go Proverbs (Rob Pike), Google Go Style Guide, Uber Go Style Guide

---

## 1. 模块与包结构

### 核心规则

```json
{
  "title": "Go: 包组织与导入规范",
  "content": {
    "markdown": "## Go: 包组织与导入规范\n\n### 标准模式\n```go\n// ✅ 标准项目布局 (community convention)\nmyproject/\n├── cmd/\n│   └── myapp/\n│       └── main.go          // 入口，薄层，只做 wiring\n├── internal/                 // 不可被外部导入\n│   ├── user/\n│   │   ├── handler.go\n│   │   ├── service.go\n│   │   └── repository.go\n│   └── order/\n├── pkg/                      // 可被外部导入的公共库\n│   └── httputil/\n├── api/                      // OpenAPI/proto 定义\n├── go.mod\n└── go.sum\n\n// ✅ 包名规范\npackage user       // 小写、单数、简短\npackage httputil   // 不用下划线或驼峰\npackage main       // cmd 入口\n\n// ✅ 导入分三段，用空行分隔\nimport (\n    // 标准库\n    \"context\"\n    \"fmt\"\n    \"net/http\"\n\n    // 第三方\n    \"github.com/gin-gonic/gin\"\n    \"go.uber.org/zap\"\n\n    // 项目内部\n    \"myproject/internal/user\"\n    \"myproject/pkg/httputil\"\n)\n\n// ❌ 不要用 package utils/common/helpers — 包名应描述功能\n// ❌ 不要循环导入 — Go 编译器会报错\n```",
    "pattern": "// ✅ 标准项目布局 (community convention)\nmyproject/\n├── cmd/\n│   └── myapp/\n│       └── main.go          // 入口，薄层，只做 wiring\n├── internal/                 // 不可被外部导入\n│   ├── user/\n│   │   ├── handler.go\n│   │   ├── service.go\n│   │   └── repository.go\n│   └── order/\n├── pkg/                      // 可被外部导入的公共库\n│   └── httputil/\n├── api/                      // OpenAPI/proto 定义\n├── go.mod\n└── go.sum\n\n// ✅ 包名规范\npackage user       // 小写、单数、简短\npackage httputil   // 不用下划线或驼峰\npackage main       // cmd 入口\n\n// ✅ 导入分三段，用空行分隔\nimport (\n    // 标准库\n    \"context\"\n    \"fmt\"\n    \"net/http\"\n\n    // 第三方\n    \"github.com/gin-gonic/gin\"\n    \"go.uber.org/zap\"\n\n    // 项目内部\n    \"myproject/internal/user\"\n    \"myproject/pkg/httputil\"\n)\n\n// ❌ 不要用 package utils/common/helpers — 包名应描述功能\n// ❌ 不要循环导入 — Go 编译器会报错",
    "rationale": "Go 社区推荐 cmd/internal/pkg 布局，internal/ 提供编译器级别的封装保护"
  },
  "description": "Go: 包组织与导入规范",
  "kind": "fact",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "architecture",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: 包组织与导入规范的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "package utils  // 或 package common",
    "why": "万能包会膨胀为垃圾抽屉，失去内聚性",
    "fix": "按功能拆包：package httputil, package validate, package auth"
  },
  "reasoning": {
    "whyStandard": "Go Blog: Organizing Go code; golang-standards/project-layout (community)",
    "sources": [
      "Effective Go - Package names",
      "Go Blog - Organizing Go code"
    ],
    "confidence": 0.9
  }
}
```

### 包设计原则

| 原则 | 说明 | 示例 |
|------|------|------|
| 按功能分包 | 一个包解决一个领域问题 | `user/`, `order/`, `auth/` |
| 包名 = 目录名 | 保持一致 | `internal/user` → `package user` |
| 避免 `internal` 导出 | `internal/` 下的包仅项目内可用 | 编译器强制 |
| 尽量少的公开 API | 未导出符号是默认 | 小写开头 = 私有 |
| 包文档 `doc.go` | 大包应有 `doc.go` 文件 | `// Package user provides ...` |

---

## 2. 命名约定

```json
{
  "title": "Go: Effective Go 命名规范",
  "content": {
    "markdown": "## Go: Effective Go 命名规范\n\n### 标准模式\n```go\n// ✅ 导出名: PascalCase (UpperCamelCase)\ntype UserService struct { ... }\nfunc NewUserService(repo UserRepository) *UserService { ... }\nvar ErrNotFound = errors.New(\"not found\")\n\n// ✅ 非导出名: camelCase (lowerCamelCase)\ntype userCache struct { ... }\nfunc (s *UserService) validateInput(req *Request) error { ... }\nvar defaultTimeout = 30 * time.Second\n\n// ✅ 缩写保持全大写或全小写\nvar userID int         // ✅ (非导出)\nvar UserID int         // ✅ (导出)\nfunc ServeHTTP(...)    // ✅ HTTP 全大写\nfunc parseURL(...)     // ✅ URL 全大写\nvar xmlParser = ...    // ✅ XML 全小写\n\n// ✅ 接口命名\ntype Reader interface { Read(p []byte) (n int, err error) }\ntype Stringer interface { String() string }\ntype UserRepository interface { ... }  // 多方法接口按功能命名\n\n// ✅ Getter 不加 Get 前缀\nfunc (u *User) Name() string { return u.name }      // ✅\nfunc (u *User) SetName(name string) { u.name = name } // ✅ Setter 加 Set\n\n// ✅ 构造函数: New + 类型名\nfunc NewServer(addr string) *Server { ... }\nfunc NewUserService(repo UserRepository) *UserService { ... }\n\n// ❌ 反模式\nfunc (u *User) GetName() string { ... }  // Go 不用 Get 前缀\nvar userId int    // 应为 userID\ntype IUserService interface { ... }  // 不用 I 前缀\n```",
    "pattern": "// ✅ 导出名: PascalCase (UpperCamelCase)\ntype UserService struct { ... }\nfunc NewUserService(repo UserRepository) *UserService { ... }\nvar ErrNotFound = errors.New(\"not found\")\n\n// ✅ 非导出名: camelCase (lowerCamelCase)\ntype userCache struct { ... }\nfunc (s *UserService) validateInput(req *Request) error { ... }\nvar defaultTimeout = 30 * time.Second\n\n// ✅ 缩写保持全大写或全小写\nvar userID int         // ✅ (非导出)\nvar UserID int         // ✅ (导出)\nfunc ServeHTTP(...)    // ✅ HTTP 全大写\nfunc parseURL(...)     // ✅ URL 全大写\nvar xmlParser = ...    // ✅ XML 全小写\n\n// ✅ 接口命名\ntype Reader interface { Read(p []byte) (n int, err error) }\ntype Stringer interface { String() string }\ntype UserRepository interface { ... }  // 多方法接口按功能命名\n\n// ✅ Getter 不加 Get 前缀\nfunc (u *User) Name() string { return u.name }      // ✅\nfunc (u *User) SetName(name string) { u.name = name } // ✅ Setter 加 Set\n\n// ✅ 构造函数: New + 类型名\nfunc NewServer(addr string) *Server { ... }\nfunc NewUserService(repo UserRepository) *UserService { ... }\n\n// ❌ 反模式\nfunc (u *User) GetName() string { ... }  // Go 不用 Get 前缀\nvar userId int    // 应为 userID\ntype IUserService interface { ... }  // 不用 I 前缀",
    "rationale": "Go 的导出机制通过大小写控制可见性，命名约定直接影响 API 设计"
  },
  "description": "Go: Effective Go 命名规范",
  "kind": "rule",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: Effective Go 命名规范的标准实现模式。",
  "antiPattern": {
    "bad": "func (u *User) GetName() string",
    "why": "Go 不用 Get 前缀 (Effective Go)，直接用属性名作方法名",
    "fix": "func (u *User) Name() string"
  },
  "reasoning": {
    "whyStandard": "Effective Go - Names; Go Code Review Comments - Initialisms",
    "sources": [
      "Effective Go",
      "Go Code Review Comments"
    ],
    "confidence": 0.95
  }
}
```

### 命名速查表

| 标识符类型 | 风格 | 示例 |
|-----------|------|------|
| 导出类型 | `PascalCase` | `UserService`, `HTTPClient` |
| 非导出类型 | `camelCase` | `userCache`, `httpClient` |
| 接口 (单方法) | 方法名 + `er` | `Reader`, `Writer`, `Stringer` |
| 接口 (多方法) | 功能名 | `UserRepository`, `EventBus` |
| 构造函数 | `New` + 类型名 | `NewServer()`, `NewRouter()` |
| 错误变量 | `Err` + 描述 | `ErrNotFound`, `ErrTimeout` |
| 错误类型 | 描述 + `Error` | `NotFoundError`, `ValidationError` |
| 缩写 | 全大写或全小写 | `ID`, `URL`, `HTTP`, `userID` |
| 包名 | 全小写单词 | `user`, `httputil` |
| 测试文件 | `_test.go` 后缀 | `user_test.go` |

### 命名反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `GetName()` | Go 不用 Get 前缀 | `Name()` |
| `IUserService` | I 前缀不符合 Go 风格 | `UserService` |
| `userId` | 缩写应全大写 | `userID` |
| `package utils` | 无语义包名 | `package validate` / `package httputil` |
| `type User_Info` | 下划线命名 | `type UserInfo` |
| `const MAX_SIZE` | SCREAMING_SNAKE 非 Go 风格 | `const MaxSize` (导出) 或 `maxSize` |

---

## 3. 错误处理

```json
{
  "title": "Go: 错误处理最佳实践",
  "content": {
    "markdown": "## Go: 错误处理最佳实践\n\n### 标准模式\n```go\n// ✅ 自定义错误类型\ntype NotFoundError struct {\n    Resource string\n    ID       any\n}\n\nfunc (e *NotFoundError) Error() string {\n    return fmt.Sprintf(\"%s not found: %v\", e.Resource, e.ID)\n}\n\n// ✅ Sentinel 错误 (包级别)\nvar (\n    ErrNotFound   = errors.New(\"not found\")\n    ErrForbidden  = errors.New(\"forbidden\")\n    ErrConflict   = errors.New(\"conflict\")\n)\n\n// ✅ 错误包装 — 添加上下文但保留原始错误\nfunc (s *UserService) FindByID(ctx context.Context, id int64) (*User, error) {\n    user, err := s.repo.Get(ctx, id)\n    if err != nil {\n        return nil, fmt.Errorf(\"UserService.FindByID(%d): %w\", id, err)\n    }\n    return user, nil\n}\n\n// ✅ errors.Is / errors.As 类型检查\nif errors.Is(err, ErrNotFound) {\n    // handle not found\n}\n\nvar nfErr *NotFoundError\nif errors.As(err, &nfErr) {\n    log.Printf(\"resource %s not found\", nfErr.Resource)\n}\n\n// ✅ 延迟错误处理 (defer + named return)\nfunc (s *Store) Transaction(fn func(tx *Tx) error) (err error) {\n    tx, err := s.db.Begin()\n    if err != nil {\n        return fmt.Errorf(\"begin tx: %w\", err)\n    }\n    defer func() {\n        if err != nil {\n            tx.Rollback()\n        } else {\n            err = tx.Commit()\n        }\n    }()\n    return fn(tx)\n}\n\n// ❌ 反模式\n_ = doSomething()           // 忽略错误\nif err != nil { panic(err) }  // 不要在库代码中 panic\nreturn err                   // 不加上下文直接返回\n```",
    "pattern": "// ✅ 自定义错误类型\ntype NotFoundError struct {\n    Resource string\n    ID       any\n}\n\nfunc (e *NotFoundError) Error() string {\n    return fmt.Sprintf(\"%s not found: %v\", e.Resource, e.ID)\n}\n\n// ✅ Sentinel 错误 (包级别)\nvar (\n    ErrNotFound   = errors.New(\"not found\")\n    ErrForbidden  = errors.New(\"forbidden\")\n    ErrConflict   = errors.New(\"conflict\")\n)\n\n// ✅ 错误包装 — 添加上下文但保留原始错误\nfunc (s *UserService) FindByID(ctx context.Context, id int64) (*User, error) {\n    user, err := s.repo.Get(ctx, id)\n    if err != nil {\n        return nil, fmt.Errorf(\"UserService.FindByID(%d): %w\", id, err)\n    }\n    return user, nil\n}\n\n// ✅ errors.Is / errors.As 类型检查\nif errors.Is(err, ErrNotFound) {\n    // handle not found\n}\n\nvar nfErr *NotFoundError\nif errors.As(err, &nfErr) {\n    log.Printf(\"resource %s not found\", nfErr.Resource)\n}\n\n// ✅ 延迟错误处理 (defer + named return)\nfunc (s *Store) Transaction(fn func(tx *Tx) error) (err error) {\n    tx, err := s.db.Begin()\n    if err != nil {\n        return fmt.Errorf(\"begin tx: %w\", err)\n    }\n    defer func() {\n        if err != nil {\n            tx.Rollback()\n        } else {\n            err = tx.Commit()\n        }\n    }()\n    return fn(tx)\n}\n\n// ❌ 反模式\n_ = doSomething()           // 忽略错误\nif err != nil { panic(err) }  // 不要在库代码中 panic\nreturn err                   // 不加上下文直接返回",
    "rationale": "Go 的显式错误处理是核心哲学: 'Errors are values' (Rob Pike)"
  },
  "description": "Go: 错误处理最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: 错误处理最佳实践的标准实现模式。",
  "antiPattern": {
    "bad": "_ = f.Close()  // 或 if err != nil { return err } 无上下文",
    "why": "忽略错误可能导致资源泄漏；无上下文的错误难以定位",
    "fix": "if err := f.Close(); err != nil { return fmt.Errorf(\"close file: %w\", err) }"
  },
  "reasoning": {
    "whyStandard": "Go Proverbs: 'Errors are values'; Go Blog: 'Error handling and Go'",
    "sources": [
      "Go Blog - Error handling and Go",
      "Go Proverbs",
      "Uber Go Style Guide"
    ],
    "confidence": 0.95
  }
}
```

### 错误处理反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `_ = f.Close()` | 忽略 Close 错误 | `if err := f.Close(); err != nil { ... }` |
| `panic(err)` in library | 库不应 crash 调用方 | `return fmt.Errorf("...: %w", err)` |
| `return err` 无上下文 | 无法定位错误来源 | `return fmt.Errorf("operation: %w", err)` |
| `if err != nil { return err }` ×20 | 大量重复 | 可用 helper/表驱动/defer 减少 |
| `log.Fatal(err)` in library | 调用 `os.Exit(1)` | 返回 error，让 main 决定 |
| `err.Error() == "not found"` | 字符串比较脆弱 | `errors.Is(err, ErrNotFound)` |

---

## 4. 接口与组合

```json
{
  "title": "Go: 接口设计 — 小接口 + 组合",
  "content": {
    "markdown": "## Go: 接口设计 — 小接口 + 组合\n\n### 标准模式\n```go\n// ✅ 小接口 — 1-2 个方法足矣\ntype Reader interface {\n    Read(p []byte) (n int, err error)\n}\n\ntype Writer interface {\n    Write(p []byte) (n int, err error)\n}\n\n// ✅ 组合接口\ntype ReadWriter interface {\n    Reader\n    Writer\n}\n\n// ✅ 在消费者侧定义接口 (Go 惯例)\n// 不要在实现侧定义！\npackage userhttp\n\n// UserFinder 仅声明本 handler 需要的方法\ntype UserFinder interface {\n    FindByID(ctx context.Context, id int64) (*user.User, error)\n}\n\ntype Handler struct {\n    users UserFinder  // 依赖接口而非具体类型\n}\n\n// ✅ 接口自动满足 (structural typing)\n// UserService 无需显式声明 implements\ntype UserService struct { repo *UserRepo }\nfunc (s *UserService) FindByID(ctx context.Context, id int64) (*user.User, error) { ... }\n// → 自动满足 UserFinder 接口\n\n// ✅ 接口合规性校验 (编译期)\nvar _ UserFinder = (*UserService)(nil)\n\n// ✅ 函数类型适配器 (标准库模式)\ntype HandlerFunc func(http.ResponseWriter, *http.Request)\nfunc (f HandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) { f(w, r) }\n\n// ❌ 反模式\ntype UserServiceInterface interface {  // 不要在实现侧定义大接口\n    FindByID(...) ...\n    FindAll(...) ...\n    Create(...) ...\n    Update(...) ...\n    Delete(...) ...\n}\n```",
    "pattern": "// ✅ 小接口 — 1-2 个方法足矣\ntype Reader interface {\n    Read(p []byte) (n int, err error)\n}\n\ntype Writer interface {\n    Write(p []byte) (n int, err error)\n}\n\n// ✅ 组合接口\ntype ReadWriter interface {\n    Reader\n    Writer\n}\n\n// ✅ 在消费者侧定义接口 (Go 惯例)\n// 不要在实现侧定义！\npackage userhttp\n\n// UserFinder 仅声明本 handler 需要的方法\ntype UserFinder interface {\n    FindByID(ctx context.Context, id int64) (*user.User, error)\n}\n\ntype Handler struct {\n    users UserFinder  // 依赖接口而非具体类型\n}\n\n// ✅ 接口自动满足 (structural typing)\n// UserService 无需显式声明 implements\ntype UserService struct { repo *UserRepo }\nfunc (s *UserService) FindByID(ctx context.Context, id int64) (*user.User, error) { ... }\n// → 自动满足 UserFinder 接口\n\n// ✅ 接口合规性校验 (编译期)\nvar _ UserFinder = (*UserService)(nil)\n\n// ✅ 函数类型适配器 (标准库模式)\ntype HandlerFunc func(http.ResponseWriter, *http.Request)\nfunc (f HandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) { f(w, r) }\n\n// ❌ 反模式\ntype UserServiceInterface interface {  // 不要在实现侧定义大接口\n    FindByID(...) ...\n    FindAll(...) ...\n    Create(...) ...\n    Update(...) ...\n    Delete(...) ...\n}",
    "rationale": "Go Proverb: 'The bigger the interface, the weaker the abstraction'"
  },
  "description": "Go: 接口设计 — 小接口 + 组合",
  "kind": "pattern",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: 接口设计 — 小接口 + 组合的标准实现模式。",
  "antiPattern": {
    "bad": "type UserServiceInterface interface { FindByID; FindAll; Create; Update; Delete }",
    "why": "大接口难以 mock、替换、组合；违背接口隔离原则",
    "fix": "在消费者侧定义只包含实际需要方法的小接口"
  },
  "reasoning": {
    "whyStandard": "Go Proverbs; Effective Go - Interfaces; Go Code Review Comments - Interfaces",
    "sources": [
      "Go Proverbs",
      "Effective Go",
      "Go Code Review Comments"
    ],
    "confidence": 0.95
  }
}
```

### 接口设计原则

| 原则 | 说明 |
|------|------|
| 在消费者侧定义 | 不要在实现包中定义接口，在使用接口的包中定义 |
| 尽量小 | 1-2 方法的接口最有价值（io.Reader/Writer） |
| 组合优于继承 | 通过嵌入小接口组成大接口 |
| 隐式满足 | 不要 `implements` 关键字，自动匹配 |
| 编译期校验 | `var _ Interface = (*Impl)(nil)` 确认实现 |
| 返回具体类型 | 函数返回具体类型，接受接口参数 |
| `Accept interfaces, return structs` | 大多数情况下的最佳实践 |

---

## 5. 并发 (Goroutine / Channel / sync)

```json
{
  "title": "Go: 并发最佳实践",
  "content": {
    "markdown": "## Go: 并发最佳实践\n\n### 标准模式\n```go\n// ✅ 使用 errgroup 管理 goroutine 组\nimport \"golang.org/x/sync/errgroup\"\n\nfunc fetchAll(ctx context.Context, urls []string) ([]Response, error) {\n    g, ctx := errgroup.WithContext(ctx)\n    results := make([]Response, len(urls))\n\n    for i, url := range urls {\n        g.Go(func() error {\n            resp, err := fetch(ctx, url)\n            if err != nil {\n                return err\n            }\n            results[i] = resp  // 每个 goroutine 写独立索引，无竞争\n            return nil\n        })\n    }\n\n    if err := g.Wait(); err != nil {\n        return nil, err\n    }\n    return results, nil\n}\n\n// ✅ Channel 作为通信机制\nfunc produce(ctx context.Context) <-chan Item {\n    ch := make(chan Item)\n    go func() {\n        defer close(ch)\n        for {\n            item, err := nextItem()\n            if err != nil {\n                return\n            }\n            select {\n            case ch <- item:\n            case <-ctx.Done():\n                return\n            }\n        }\n    }()\n    return ch\n}\n\n// ✅ sync.Once 安全初始化\nvar (\n    instance *DB\n    once     sync.Once\n)\n\nfunc GetDB() *DB {\n    once.Do(func() {\n        instance = connectDB()\n    })\n    return instance\n}\n\n// ✅ sync.Mutex 保护共享状态\ntype SafeCounter struct {\n    mu sync.Mutex\n    v  map[string]int\n}\n\nfunc (c *SafeCounter) Inc(key string) {\n    c.mu.Lock()\n    defer c.mu.Unlock()\n    c.v[key]++\n}\n\n// ✅ 使用 context 控制 goroutine 生命周期\nfunc worker(ctx context.Context) {\n    for {\n        select {\n        case <-ctx.Done():\n            return  // 优雅退出\n        default:\n            doWork()\n        }\n    }\n}\n\n// ❌ 反模式\ngo func() { ... }()  // 裸 goroutine — 无法等待、无法取消、panic 不受控\ntime.Sleep(time.Second)  // 用 sleep 做同步 → 用 channel/WaitGroup\n```",
    "pattern": "// ✅ 使用 errgroup 管理 goroutine 组\nimport \"golang.org/x/sync/errgroup\"\n\nfunc fetchAll(ctx context.Context, urls []string) ([]Response, error) {\n    g, ctx := errgroup.WithContext(ctx)\n    results := make([]Response, len(urls))\n\n    for i, url := range urls {\n        g.Go(func() error {\n            resp, err := fetch(ctx, url)\n            if err != nil {\n                return err\n            }\n            results[i] = resp  // 每个 goroutine 写独立索引，无竞争\n            return nil\n        })\n    }\n\n    if err := g.Wait(); err != nil {\n        return nil, err\n    }\n    return results, nil\n}\n\n// ✅ Channel 作为通信机制\nfunc produce(ctx context.Context) <-chan Item {\n    ch := make(chan Item)\n    go func() {\n        defer close(ch)\n        for {\n            item, err := nextItem()\n            if err != nil {\n                return\n            }\n            select {\n            case ch <- item:\n            case <-ctx.Done():\n                return\n            }\n        }\n    }()\n    return ch\n}\n\n// ✅ sync.Once 安全初始化\nvar (\n    instance *DB\n    once     sync.Once\n)\n\nfunc GetDB() *DB {\n    once.Do(func() {\n        instance = connectDB()\n    })\n    return instance\n}\n\n// ✅ sync.Mutex 保护共享状态\ntype SafeCounter struct {\n    mu sync.Mutex\n    v  map[string]int\n}\n\nfunc (c *SafeCounter) Inc(key string) {\n    c.mu.Lock()\n    defer c.mu.Unlock()\n    c.v[key]++\n}\n\n// ✅ 使用 context 控制 goroutine 生命周期\nfunc worker(ctx context.Context) {\n    for {\n        select {\n        case <-ctx.Done():\n            return  // 优雅退出\n        default:\n            doWork()\n        }\n    }\n}\n\n// ❌ 反模式\ngo func() { ... }()  // 裸 goroutine — 无法等待、无法取消、panic 不受控\ntime.Sleep(time.Second)  // 用 sleep 做同步 → 用 channel/WaitGroup",
    "rationale": "Go Proverb: 'Don't communicate by sharing memory, share memory by communicating'"
  },
  "description": "Go: 并发最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: 并发最佳实践的标准实现模式。",
  "antiPattern": {
    "bad": "go func() { result = compute() }(); time.Sleep(time.Second)",
    "why": "裸 goroutine 不可控: 无等待、无取消、panic 崩全进程; Sleep 同步不可靠",
    "fix": "使用 errgroup / WaitGroup + context 取消 + recover"
  },
  "reasoning": {
    "whyStandard": "Effective Go - Concurrency; Go Proverbs; Go Blog - Pipelines",
    "sources": [
      "Effective Go",
      "Go Proverbs",
      "Go Blog - Pipelines and cancellation"
    ],
    "confidence": 0.95
  }
}
```

### 并发模式速查

| 模式 | 工具 | 适用场景 |
|------|------|---------|
| Fan-out/Fan-in | `errgroup` / channel | 并行调 N 个服务，合并结果 |
| Worker Pool | buffered channel + N goroutines | 限制并发数 |
| Pipeline | channel chain | 数据流处理 |
| Pub/Sub | channel | 事件广播 |
| Singleton | `sync.Once` | 延迟初始化单例 |
| 互斥访问 | `sync.Mutex` / `sync.RWMutex` | 保护共享 map/slice |
| 原子操作 | `sync/atomic` | 计数器/标志位 |
| 超时控制 | `context.WithTimeout` | API 调用/DB 查询 |

### 并发反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| 裸 `go func()` | panic 不受控，无取消 | `errgroup` / 带 `recover` 的 wrapper |
| `time.Sleep` 同步 | 不可靠，浪费时间 | WaitGroup / channel / errgroup.Wait |
| goroutine 泄漏 | 无退出信号 | context 取消 / done channel |
| 锁粒度过大 | `sync.Mutex` 锁整个方法 | 缩小临界区 / 用 channel 替代 |
| 向 nil channel 发送 | 永久阻塞 | 初始化 channel |

---

## 6. Context

```json
{
  "title": "Go: context.Context 使用规范",
  "content": {
    "markdown": "## Go: context.Context 使用规范\n\n### 标准模式\n```go\n// ✅ Context 作为第一个参数\nfunc (s *UserService) FindByID(ctx context.Context, id int64) (*User, error) {\n    // 传播到所有下游调用\n    user, err := s.repo.Get(ctx, id)\n    if err != nil {\n        return nil, fmt.Errorf(\"find user %d: %w\", id, err)\n    }\n    return user, nil\n}\n\n// ✅ HTTP handler 中获取 context\nfunc (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {\n    ctx := r.Context()\n    user, err := h.service.FindByID(ctx, userID)\n    // ...\n}\n\n// ✅ 超时控制\nctx, cancel := context.WithTimeout(ctx, 5*time.Second)\ndefer cancel()  // 必须调用 cancel 释放资源\n\nresult, err := slowOperation(ctx)\nif errors.Is(err, context.DeadlineExceeded) {\n    // 超时处理\n}\n\n// ✅ Context Values — 仅限请求范围元数据\ntype ctxKey string\nconst requestIDKey ctxKey = \"requestID\"\n\nfunc WithRequestID(ctx context.Context, id string) context.Context {\n    return context.WithValue(ctx, requestIDKey, id)\n}\n\nfunc RequestID(ctx context.Context) string {\n    id, _ := ctx.Value(requestIDKey).(string)\n    return id\n}\n\n// ❌ 反模式\nfunc DoWork(id int, ctx context.Context) { }  // ctx 不是第一个参数\nctx = context.WithValue(ctx, \"key\", val)       // 字符串 key 可能冲突\nvar ctx context.Context                        // 不要存储在 struct 中\n```",
    "pattern": "// ✅ Context 作为第一个参数\nfunc (s *UserService) FindByID(ctx context.Context, id int64) (*User, error) {\n    // 传播到所有下游调用\n    user, err := s.repo.Get(ctx, id)\n    if err != nil {\n        return nil, fmt.Errorf(\"find user %d: %w\", id, err)\n    }\n    return user, nil\n}\n\n// ✅ HTTP handler 中获取 context\nfunc (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {\n    ctx := r.Context()\n    user, err := h.service.FindByID(ctx, userID)\n    // ...\n}\n\n// ✅ 超时控制\nctx, cancel := context.WithTimeout(ctx, 5*time.Second)\ndefer cancel()  // 必须调用 cancel 释放资源\n\nresult, err := slowOperation(ctx)\nif errors.Is(err, context.DeadlineExceeded) {\n    // 超时处理\n}\n\n// ✅ Context Values — 仅限请求范围元数据\ntype ctxKey string\nconst requestIDKey ctxKey = \"requestID\"\n\nfunc WithRequestID(ctx context.Context, id string) context.Context {\n    return context.WithValue(ctx, requestIDKey, id)\n}\n\nfunc RequestID(ctx context.Context) string {\n    id, _ := ctx.Value(requestIDKey).(string)\n    return id\n}\n\n// ❌ 反模式\nfunc DoWork(id int, ctx context.Context) { }  // ctx 不是第一个参数\nctx = context.WithValue(ctx, \"key\", val)       // 字符串 key 可能冲突\nvar ctx context.Context                        // 不要存储在 struct 中",
    "rationale": "context.Context 是 Go 的请求生命周期管理核心，贯穿整个调用链"
  },
  "description": "Go: context.Context 使用规范",
  "kind": "rule",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: context.Context 使用规范的标准实现模式。",
  "antiPattern": {
    "bad": "func DoWork(name string, ctx context.Context, id int)",
    "why": "Go 约定 ctx 始终为第一个参数; 存储在 struct 中会导致跨请求复用",
    "fix": "func DoWork(ctx context.Context, name string, id int)"
  },
  "reasoning": {
    "whyStandard": "Go Blog - Context; Go Code Review Comments - Contexts",
    "sources": [
      "Go Blog - Context",
      "Go Code Review Comments"
    ],
    "confidence": 0.95
  }
}
```

### Context 使用原则

| 原则 | 说明 |
|------|------|
| 第一个参数 | `func Foo(ctx context.Context, ...)` |
| 不要存在 struct 中 | Context 是请求级的，不应跨请求复用 |
| 向下传播 | 每一层都传递 ctx 到下游 |
| Always cancel | `defer cancel()` 紧跟 WithTimeout/WithCancel |
| Value 用自定义 key 类型 | 避免字符串 key 冲突 |
| 参数名用 `ctx` | 不要用 `c` 或 `context` |

---

## 7. Struct 与方法设计

```json
{
  "title": "Go: Struct 设计与方法接收者",
  "content": {
    "markdown": "## Go: Struct 设计与方法接收者\n\n### 标准模式\n```go\n// ✅ 构造函数模式\ntype Server struct {\n    addr     string\n    port     int\n    logger   *zap.Logger\n    handler  http.Handler\n    timeout  time.Duration\n}\n\n// ✅ Functional Options 模式（参数 >3 个时推荐）\ntype Option func(*Server)\n\nfunc WithPort(port int) Option {\n    return func(s *Server) { s.port = port }\n}\n\nfunc WithTimeout(d time.Duration) Option {\n    return func(s *Server) { s.timeout = d }\n}\n\nfunc NewServer(addr string, opts ...Option) *Server {\n    s := &Server{\n        addr:    addr,\n        port:    8080,            // 默认值\n        timeout: 30 * time.Second, // 默认值\n        logger:  zap.NewNop(),\n    }\n    for _, opt := range opts {\n        opt(s)\n    }\n    return s\n}\n\n// 使用: server := NewServer(\"0.0.0.0\", WithPort(9090), WithTimeout(10*time.Second))\n\n// ✅ 指针接收者 vs 值接收者\n// 指针接收者: 需要修改字段、大 struct、实现含指针接收者的接口\nfunc (s *Server) Start() error {\n    s.running = true  // 修改状态 → 指针接收者\n    return http.ListenAndServe(fmt.Sprintf(\"%s:%d\", s.addr, s.port), s.handler)\n}\n\n// 值接收者: 小的、不可变的类型\ntype Point struct { X, Y float64 }\nfunc (p Point) Distance(q Point) float64 {\n    return math.Sqrt((p.X-q.X)*(p.X-q.X) + (p.Y-q.Y)*(p.Y-q.Y))\n}\n\n// ✅ Struct 嵌入（组合代替继承）\ntype Engine struct {\n    RouterGroup  // 嵌入 RouterGroup 的方法\n    pool sync.Pool\n}\n\n// ❌ 反模式\ntype Config struct {\n    A, B, C, D, E, F, G string  // 参数爆炸\n}\nfunc NewConfig(a, b, c, d, e, f, g string) *Config { ... }  // 参数不可读\n```",
    "pattern": "// ✅ 构造函数模式\ntype Server struct {\n    addr     string\n    port     int\n    logger   *zap.Logger\n    handler  http.Handler\n    timeout  time.Duration\n}\n\n// ✅ Functional Options 模式（参数 >3 个时推荐）\ntype Option func(*Server)\n\nfunc WithPort(port int) Option {\n    return func(s *Server) { s.port = port }\n}\n\nfunc WithTimeout(d time.Duration) Option {\n    return func(s *Server) { s.timeout = d }\n}\n\nfunc NewServer(addr string, opts ...Option) *Server {\n    s := &Server{\n        addr:    addr,\n        port:    8080,            // 默认值\n        timeout: 30 * time.Second, // 默认值\n        logger:  zap.NewNop(),\n    }\n    for _, opt := range opts {\n        opt(s)\n    }\n    return s\n}\n\n// 使用: server := NewServer(\"0.0.0.0\", WithPort(9090), WithTimeout(10*time.Second))\n\n// ✅ 指针接收者 vs 值接收者\n// 指针接收者: 需要修改字段、大 struct、实现含指针接收者的接口\nfunc (s *Server) Start() error {\n    s.running = true  // 修改状态 → 指针接收者\n    return http.ListenAndServe(fmt.Sprintf(\"%s:%d\", s.addr, s.port), s.handler)\n}\n\n// 值接收者: 小的、不可变的类型\ntype Point struct { X, Y float64 }\nfunc (p Point) Distance(q Point) float64 {\n    return math.Sqrt((p.X-q.X)*(p.X-q.X) + (p.Y-q.Y)*(p.Y-q.Y))\n}\n\n// ✅ Struct 嵌入（组合代替继承）\ntype Engine struct {\n    RouterGroup  // 嵌入 RouterGroup 的方法\n    pool sync.Pool\n}\n\n// ❌ 反模式\ntype Config struct {\n    A, B, C, D, E, F, G string  // 参数爆炸\n}\nfunc NewConfig(a, b, c, d, e, f, g string) *Config { ... }  // 参数不可读",
    "rationale": "Functional Options 是 Go 社区公认的可扩展构造模式 (Dave Cheney)"
  },
  "description": "Go: Struct 设计与方法接收者",
  "kind": "pattern",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: Struct 设计与方法接收者的标准实现模式。",
  "antiPattern": {
    "bad": "func NewServer(addr string, port int, timeout int, logger Logger, tls bool)",
    "why": "参数列表过长，调用方需记忆位置",
    "fix": "Functional Options: NewServer(addr, WithPort(9090), WithTimeout(...))"
  },
  "reasoning": {
    "whyStandard": "Dave Cheney - Functional Options; Effective Go - Methods",
    "sources": [
      "Dave Cheney Blog",
      "Effective Go - Methods"
    ],
    "confidence": 0.9
  }
}
```

### 接收者选择规则

| 条件 | 使用 | 理由 |
|------|------|------|
| 修改 struct 字段 | `*T` 指针 | 值接收者是副本，修改不可见 |
| struct 较大 (>3 字段) | `*T` 指针 | 避免拷贝开销 |
| 一致性 | `*T` 指针 | 如果类型有任何指针方法，全部用指针 |
| 小的不可变类型 | `T` 值 | `time.Time`, `Point`, `Color` |
| map/slice/channel 类型 | `T` 值 | 已经是引用类型 |

---

## 8. 测试

```json
{
  "title": "Go: 测试最佳实践",
  "content": {
    "markdown": "## Go: 测试最佳实践\n\n### 标准模式\n```go\n// ✅ 表驱动测试 (Table-driven tests)\nfunc TestAdd(t *testing.T) {\n    tests := []struct {\n        name     string\n        a, b     int\n        expected int\n    }{\n        {\"positive\", 1, 2, 3},\n        {\"zero\", 0, 0, 0},\n        {\"negative\", -1, -2, -3},\n        {\"mixed\", -1, 2, 1},\n    }\n\n    for _, tt := range tests {\n        t.Run(tt.name, func(t *testing.T) {\n            got := Add(tt.a, tt.b)\n            if got != tt.expected {\n                t.Errorf(\"Add(%d, %d) = %d, want %d\", tt.a, tt.b, got, tt.expected)\n            }\n        })\n    }\n}\n\n// ✅ 使用 testify 断言 (社区标准)\nimport \"github.com/stretchr/testify/assert\"\n\nfunc TestFindByID(t *testing.T) {\n    service := NewUserService(mockRepo)\n    user, err := service.FindByID(context.Background(), 1)\n    assert.NoError(t, err)\n    assert.Equal(t, \"Alice\", user.Name)\n    assert.NotNil(t, user.CreatedAt)\n}\n\n// ✅ 使用接口做依赖注入 (便于 mock)\ntype UserRepository interface {\n    Get(ctx context.Context, id int64) (*User, error)\n}\n\ntype mockUserRepo struct {\n    users map[int64]*User\n}\n\nfunc (m *mockUserRepo) Get(ctx context.Context, id int64) (*User, error) {\n    if u, ok := m.users[id]; ok {\n        return u, nil\n    }\n    return nil, ErrNotFound\n}\n\n// ✅ TestMain 做全局 setup/teardown\nfunc TestMain(m *testing.M) {\n    setup()\n    code := m.Run()\n    teardown()\n    os.Exit(code)\n}\n\n// ✅ 子测试 + 并行\nfunc TestAPI(t *testing.T) {\n    t.Run(\"Create\", func(t *testing.T) {\n        t.Parallel()\n        // ...\n    })\n    t.Run(\"Delete\", func(t *testing.T) {\n        t.Parallel()\n        // ...\n    })\n}\n\n// ✅ Golden file 测试\nfunc TestRender(t *testing.T) {\n    got := Render(input)\n    golden := filepath.Join(\"testdata\", t.Name()+\".golden\")\n    if *update {\n        os.WriteFile(golden, got, 0o644)\n    }\n    want, _ := os.ReadFile(golden)\n    assert.Equal(t, string(want), string(got))\n}\n```",
    "pattern": "// ✅ 表驱动测试 (Table-driven tests)\nfunc TestAdd(t *testing.T) {\n    tests := []struct {\n        name     string\n        a, b     int\n        expected int\n    }{\n        {\"positive\", 1, 2, 3},\n        {\"zero\", 0, 0, 0},\n        {\"negative\", -1, -2, -3},\n        {\"mixed\", -1, 2, 1},\n    }\n\n    for _, tt := range tests {\n        t.Run(tt.name, func(t *testing.T) {\n            got := Add(tt.a, tt.b)\n            if got != tt.expected {\n                t.Errorf(\"Add(%d, %d) = %d, want %d\", tt.a, tt.b, got, tt.expected)\n            }\n        })\n    }\n}\n\n// ✅ 使用 testify 断言 (社区标准)\nimport \"github.com/stretchr/testify/assert\"\n\nfunc TestFindByID(t *testing.T) {\n    service := NewUserService(mockRepo)\n    user, err := service.FindByID(context.Background(), 1)\n    assert.NoError(t, err)\n    assert.Equal(t, \"Alice\", user.Name)\n    assert.NotNil(t, user.CreatedAt)\n}\n\n// ✅ 使用接口做依赖注入 (便于 mock)\ntype UserRepository interface {\n    Get(ctx context.Context, id int64) (*User, error)\n}\n\ntype mockUserRepo struct {\n    users map[int64]*User\n}\n\nfunc (m *mockUserRepo) Get(ctx context.Context, id int64) (*User, error) {\n    if u, ok := m.users[id]; ok {\n        return u, nil\n    }\n    return nil, ErrNotFound\n}\n\n// ✅ TestMain 做全局 setup/teardown\nfunc TestMain(m *testing.M) {\n    setup()\n    code := m.Run()\n    teardown()\n    os.Exit(code)\n}\n\n// ✅ 子测试 + 并行\nfunc TestAPI(t *testing.T) {\n    t.Run(\"Create\", func(t *testing.T) {\n        t.Parallel()\n        // ...\n    })\n    t.Run(\"Delete\", func(t *testing.T) {\n        t.Parallel()\n        // ...\n    })\n}\n\n// ✅ Golden file 测试\nfunc TestRender(t *testing.T) {\n    got := Render(input)\n    golden := filepath.Join(\"testdata\", t.Name()+\".golden\")\n    if *update {\n        os.WriteFile(golden, got, 0o644)\n    }\n    want, _ := os.ReadFile(golden)\n    assert.Equal(t, string(want), string(got))\n}",
    "rationale": "表驱动测试是 Go 社区的标准测试模式，减少重复并提高覆盖率"
  },
  "description": "Go: 测试最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: 测试最佳实践的标准实现模式。",
  "antiPattern": {
    "bad": "func TestAdd1(t *testing.T) { ... } func TestAdd2(t *testing.T) { ... }",
    "why": "重复代码多，难以新增测试用例",
    "fix": "使用表驱动测试 + t.Run 子测试"
  },
  "reasoning": {
    "whyStandard": "Go Wiki - TableDrivenTests; Go Blog - Subtests and Sub-benchmarks",
    "sources": [
      "Go Wiki - TableDrivenTests",
      "Go Blog - Subtests"
    ],
    "confidence": 0.95
  }
}
```

### 测试命名约定

| 类型 | 命名 | 示例 |
|------|------|------|
| 测试文件 | `*_test.go` | `user_service_test.go` |
| 测试函数 | `Test` + 功能描述 | `TestFindByID` |
| 子测试 | 描述性名称 | `t.Run("not found", ...)` |
| Benchmark | `Benchmark` + 操作 | `BenchmarkSerialize` |
| Example | `Example` + 函数名 | `ExampleNewServer` |
| Fixtures | `testdata/` 目录 | `testdata/input.json` |

---

## 9. defer 使用

```json
{
  "title": "Go: defer 最佳实践",
  "content": {
    "markdown": "## Go: defer 最佳实践\n\n### 标准模式\n```go\n// ✅ 资源清理 — 打开后立即 defer 关闭\nfunc ReadFile(name string) ([]byte, error) {\n    f, err := os.Open(name)\n    if err != nil {\n        return nil, err\n    }\n    defer f.Close()  // 紧跟 Open，确保不遗漏\n\n    return io.ReadAll(f)\n}\n\n// ✅ Mutex unlock\nfunc (c *Cache) Get(key string) (string, bool) {\n    c.mu.RLock()\n    defer c.mu.RUnlock()\n    v, ok := c.data[key]\n    return v, ok\n}\n\n// ✅ Recover from panic (HTTP middleware)\nfunc Recovery() gin.HandlerFunc {\n    return func(c *gin.Context) {\n        defer func() {\n            if r := recover(); r != nil {\n                log.Printf(\"panic recovered: %v\\n%s\", r, debug.Stack())\n                c.AbortWithStatus(http.StatusInternalServerError)\n            }\n        }()\n        c.Next()\n    }\n}\n\n// ✅ 处理 defer 中的错误\nfunc WriteFile(name string, data []byte) (err error) {\n    f, err := os.Create(name)\n    if err != nil {\n        return err\n    }\n    defer func() {\n        if cerr := f.Close(); err == nil {\n            err = cerr  // 仅在没有其他错误时上报 Close 错误\n        }\n    }()\n    _, err = f.Write(data)\n    return err\n}\n\n// ❌ 循环中 defer — 可能资源积压到函数结束\nfor _, name := range files {\n    f, _ := os.Open(name)\n    defer f.Close()  // ❌ 全部在函数返回时才 Close\n```",
    "pattern": "// ✅ 资源清理 — 打开后立即 defer 关闭\nfunc ReadFile(name string) ([]byte, error) {\n    f, err := os.Open(name)\n    if err != nil {\n        return nil, err\n    }\n    defer f.Close()  // 紧跟 Open，确保不遗漏\n\n    return io.ReadAll(f)\n}\n\n// ✅ Mutex unlock\nfunc (c *Cache) Get(key string) (string, bool) {\n    c.mu.RLock()\n    defer c.mu.RUnlock()\n    v, ok := c.data[key]\n    return v, ok\n}\n\n// ✅ Recover from panic (HTTP middleware)\nfunc Recovery() gin.HandlerFunc {\n    return func(c *gin.Context) {\n        defer func() {\n            if r := recover(); r != nil {\n                log.Printf(\"panic recovered: %v\\n%s\", r, debug.Stack())\n                c.AbortWithStatus(http.StatusInternalServerError)\n            }\n        }()\n        c.Next()\n    }\n}\n\n// ✅ 处理 defer 中的错误\nfunc WriteFile(name string, data []byte) (err error) {\n    f, err := os.Create(name)\n    if err != nil {\n        return err\n    }\n    defer func() {\n        if cerr := f.Close(); err == nil {\n            err = cerr  // 仅在没有其他错误时上报 Close 错误\n        }\n    }()\n    _, err = f.Write(data)\n    return err\n}\n\n// ❌ 循环中 defer — 可能资源积压到函数结束\nfor _, name := range files {\n    f, _ := os.Open(name)\n    defer f.Close()  // ❌ 全部在函数返回时才 Close",
    "rationale": "Go: defer 最佳实践的标准实现模式。"
  },
  "description": "Go: defer 最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: defer 最佳实践的标准实现模式。",
  "antiPattern": {
    "bad": "for _, name := range files { f, _ := os.Open(name); defer f.Close() }",
    "why": "defer 在函数退出时才执行，循环中会积压大量未关闭的文件",
    "fix": "将循环体提取为单独函数，或在循环内手动 Close"
  },
  "reasoning": {
    "whyStandard": "Effective Go - Defer; Go Blog - Defer, Panic, and Recover",
    "sources": [
      "Effective Go - Defer",
      "Go Blog - Defer, Panic, and Recover"
    ],
    "confidence": 0.9
  }
}
```

---

## 10. 代码文档

```json
{
  "title": "Go: godoc 注释规范",
  "content": {
    "markdown": "## Go: godoc 注释规范\n\n### 标准模式\n```go\n// ✅ 包注释 — doc.go 或第一个文件\n// Package user provides user account management functionality\n// including CRUD operations, authentication, and role-based access control.\npackage user\n\n// ✅ 导出符号注释 — 以符号名开头\n// UserService handles user business logic.\n// It is safe for concurrent use.\ntype UserService struct {\n    repo   UserRepository\n    logger *zap.Logger\n}\n\n// NewUserService creates a UserService with the given repository.\n// If logger is nil, a no-op logger is used.\nfunc NewUserService(repo UserRepository, logger *zap.Logger) *UserService {\n    if logger == nil {\n        logger = zap.NewNop()\n    }\n    return &UserService{repo: repo, logger: logger}\n}\n\n// FindByID returns the user with the given ID.\n// It returns ErrNotFound if no user exists with that ID.\nfunc (s *UserService) FindByID(ctx context.Context, id int64) (*User, error) {\n    // ...\n}\n\n// ✅ 示例函数 (godoc 可运行)\nfunc ExampleNewUserService() {\n    svc := NewUserService(NewMemoryRepo(), nil)\n    user, _ := svc.FindByID(context.Background(), 1)\n    fmt.Println(user.Name)\n    // Output: Alice\n}\n\n// ❌ 不要\n// This function returns the user  // 不以符号名开头\n// getter for name field            // 无意义注释\n```",
    "pattern": "// ✅ 包注释 — doc.go 或第一个文件\n// Package user provides user account management functionality\n// including CRUD operations, authentication, and role-based access control.\npackage user\n\n// ✅ 导出符号注释 — 以符号名开头\n// UserService handles user business logic.\n// It is safe for concurrent use.\ntype UserService struct {\n    repo   UserRepository\n    logger *zap.Logger\n}\n\n// NewUserService creates a UserService with the given repository.\n// If logger is nil, a no-op logger is used.\nfunc NewUserService(repo UserRepository, logger *zap.Logger) *UserService {\n    if logger == nil {\n        logger = zap.NewNop()\n    }\n    return &UserService{repo: repo, logger: logger}\n}\n\n// FindByID returns the user with the given ID.\n// It returns ErrNotFound if no user exists with that ID.\nfunc (s *UserService) FindByID(ctx context.Context, id int64) (*User, error) {\n    // ...\n}\n\n// ✅ 示例函数 (godoc 可运行)\nfunc ExampleNewUserService() {\n    svc := NewUserService(NewMemoryRepo(), nil)\n    user, _ := svc.FindByID(context.Background(), 1)\n    fmt.Println(user.Name)\n    // Output: Alice\n}\n\n// ❌ 不要\n// This function returns the user  // 不以符号名开头\n// getter for name field            // 无意义注释",
    "rationale": "godoc 从注释生成文档，注释以符号名开头是 Go 的核心约定"
  },
  "description": "Go: godoc 注释规范",
  "kind": "rule",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: godoc 注释规范的标准实现模式。",
  "reasoning": {
    "whyStandard": "Effective Go - Commentary; Go Code Review Comments - Comment Sentences",
    "sources": [
      "Effective Go",
      "Go Code Review Comments"
    ],
    "confidence": 0.95
  }
}
```

---

## 11. HTTP 与 Web 模式

```json
{
  "title": "Go: HTTP 服务最佳实践",
  "content": {
    "markdown": "## Go: HTTP 服务最佳实践\n\n### 标准模式\n```go\n// ✅ 结构化 Handler\ntype UserHandler struct {\n    service UserService\n    logger  *zap.Logger\n}\n\nfunc (h *UserHandler) RegisterRoutes(r *gin.RouterGroup) {\n    users := r.Group(\"/users\")\n    {\n        users.GET(\"\", h.List)\n        users.GET(\"/:id\", h.GetByID)\n        users.POST(\"\", h.Create)\n        users.PUT(\"/:id\", h.Update)\n        users.DELETE(\"/:id\", h.Delete)\n    }\n}\n\n// ✅ Middleware 链\nfunc Logger(logger *zap.Logger) gin.HandlerFunc {\n    return func(c *gin.Context) {\n        start := time.Now()\n        c.Next()\n        logger.Info(\"request\",\n            zap.String(\"method\", c.Request.Method),\n            zap.String(\"path\", c.Request.URL.Path),\n            zap.Int(\"status\", c.Writer.Status()),\n            zap.Duration(\"latency\", time.Since(start)),\n        )\n    }\n}\n\n// ✅ Graceful Shutdown\nfunc main() {\n    srv := &http.Server{Addr: \":8080\", Handler: router}\n\n    go func() {\n        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {\n            log.Fatalf(\"listen: %s\", err)\n        }\n    }()\n\n    quit := make(chan os.Signal, 1)\n    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)\n    <-quit\n\n    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)\n    defer cancel()\n    if err := srv.Shutdown(ctx); err != nil {\n        log.Fatal(\"server shutdown:\", err)\n    }\n}\n\n// ✅ 统一错误响应\ntype APIError struct {\n    Code    int    `json:\"code\"`\n    Message string `json:\"message\"`\n}\n\nfunc ErrorResponse(c *gin.Context, status int, msg string) {\n    c.JSON(status, APIError{Code: status, Message: msg})\n}\n```",
    "pattern": "// ✅ 结构化 Handler\ntype UserHandler struct {\n    service UserService\n    logger  *zap.Logger\n}\n\nfunc (h *UserHandler) RegisterRoutes(r *gin.RouterGroup) {\n    users := r.Group(\"/users\")\n    {\n        users.GET(\"\", h.List)\n        users.GET(\"/:id\", h.GetByID)\n        users.POST(\"\", h.Create)\n        users.PUT(\"/:id\", h.Update)\n        users.DELETE(\"/:id\", h.Delete)\n    }\n}\n\n// ✅ Middleware 链\nfunc Logger(logger *zap.Logger) gin.HandlerFunc {\n    return func(c *gin.Context) {\n        start := time.Now()\n        c.Next()\n        logger.Info(\"request\",\n            zap.String(\"method\", c.Request.Method),\n            zap.String(\"path\", c.Request.URL.Path),\n            zap.Int(\"status\", c.Writer.Status()),\n            zap.Duration(\"latency\", time.Since(start)),\n        )\n    }\n}\n\n// ✅ Graceful Shutdown\nfunc main() {\n    srv := &http.Server{Addr: \":8080\", Handler: router}\n\n    go func() {\n        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {\n            log.Fatalf(\"listen: %s\", err)\n        }\n    }()\n\n    quit := make(chan os.Signal, 1)\n    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)\n    <-quit\n\n    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)\n    defer cancel()\n    if err := srv.Shutdown(ctx); err != nil {\n        log.Fatal(\"server shutdown:\", err)\n    }\n}\n\n// ✅ 统一错误响应\ntype APIError struct {\n    Code    int    `json:\"code\"`\n    Message string `json:\"message\"`\n}\n\nfunc ErrorResponse(c *gin.Context, status int, msg string) {\n    c.JSON(status, APIError{Code: status, Message: msg})\n}",
    "rationale": "结构化 handler + 依赖注入 + middleware 链是 Go web 服务的标准架构"
  },
  "description": "Go: HTTP 服务最佳实践",
  "kind": "fact",
  "doClause": "Apply the Go pattern as described",
  "language": "go",
  "headers": [],
  "knowledgeType": "architecture",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Go: HTTP 服务最佳实践的标准实现模式。",
  "reasoning": {
    "whyStandard": "Go Blog - Writing Web Applications; Gin/Echo best practices",
    "sources": [
      "Go Blog",
      "Gin Documentation",
      "Uber Go Style Guide"
    ],
    "confidence": 0.85
  }
}
```

---

## 12. Go 特有维度 (extraDimensions)

冷启动分析 Go 项目时，除了通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **错误处理模式** | sentinel error、错误包装 `%w`、自定义错误类型、`errors.Is/As` 使用 | `code-pattern` |
| **接口设计** | 消费者侧接口、小接口组合、编译期合规性检查 | `best-practice` |
| **并发模型** | goroutine 管理、channel 模式、errgroup、sync 原语 | `code-pattern` |
| **Context 传播** | ctx 第一参数、超时控制、Value 使用规范 | `code-standard` |
| **Functional Options** | WithXxx 构造模式、默认值策略 | `code-pattern` |
| **项目布局** | cmd/internal/pkg 分层、包命名、API 定义 | `architecture` |
| **测试模式** | 表驱动测试、golden file、testdata/、接口 mock | `best-practice` |
| **构建工具** | go.mod 依赖管理、go generate、build tags | `config` |
| **Web/gRPC 模式** | Handler 结构、Middleware 链、Graceful Shutdown | `architecture` |
| **性能** | sync.Pool、pprof 集成、避免不必要的内存分配 | `best-practice` |

---

## 关联 Skills

- **autosnippet-coldstart**: 冷启动分析模板
- **autosnippet-reference-java**: Java 业界最佳实践参考
- **autosnippet-reference-kotlin**: Kotlin 业界最佳实践参考
- **autosnippet-reference-python**: Python 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
