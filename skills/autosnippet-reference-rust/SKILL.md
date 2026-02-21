```skill
---
name: autosnippet-reference-rust
description: Rust 业界最佳实践参考。涵盖所有权与借用、生命周期、trait 系统、错误处理(Result/Option/?)、async/await、unsafe、宏、测试、Cargo 约定，为冷启动分析提供高质量参考标准。
---

# Rust 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 Rust 项目时，请参考以下业界标准产出高质量候选。
> **来源**: The Rust Book, Rust API Guidelines, Clippy Lints, Rust Design Patterns (unofficial), Rust RFC, Tokio Best Practices

---

## 1. 项目结构与 Cargo 约定

### 核心规则

```json
{
  "title": "Rust: Cargo 项目结构与模块组织",
  "content": {
    "markdown": "## Rust: Cargo 项目结构与模块组织\n\n### 标准模式\n```rust\n// ✅ 标准 Cargo 项目布局\nmyproject/\n├── Cargo.toml            // 包元数据 + 依赖\n├── Cargo.lock            // 锁定依赖版本 (bin crate 必须提交)\n├── src/\n│   ├── main.rs           // 二进制入口 (bin crate)\n│   ├── lib.rs            // 库入口 (lib crate)\n│   ├── config.rs         // 模块文件\n│   └── handlers/\n│       ├── mod.rs         // 子模块声明 (传统方式)\n│       └── user.rs\n├── tests/                // 集成测试 (每个文件为独立 crate)\n│   └── integration_test.rs\n├── benches/              // 基准测试\n│   └── benchmark.rs\n├── examples/             // 示例代码\n│   └── demo.rs\n└── build.rs              // 构建脚本 (可选)\n\n// ✅ Cargo workspace (多 crate 项目)\n[workspace]\nmembers = [\n    \"crates/core\",\n    \"crates/api\",\n    \"crates/cli\",\n]\n\n// ✅ 模块声明\n// src/lib.rs\npub mod config;\npub mod handlers;\nmod internal;             // 私有模块\n\n// ❌ 不要在 lib crate 提交 Cargo.lock\n// ❌ 不要创建过深的模块层级 (>4 层需考虑拆 crate)\n```",
    "pattern": "src/main.rs src/lib.rs tests/ benches/ examples/ Cargo.toml",
    "rationale": "Cargo 约定布局提供零配置的构建体验，workspace 支持大型项目的 crate 拆分"
  },
  "description": "Rust: Cargo 项目结构与模块组织",
  "kind": "fact",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "architecture",
  "scope": "universal",
  "antiPattern": {
    "bad": "单个 crate 超过 10000 行无模块拆分",
    "why": "编译时间线性增长，代码内聚性下降",
    "fix": "按领域拆分为 workspace 多 crate: core, api, cli"
  },
  "reasoning": {
    "whyStandard": "Cargo Book - Package Layout; Rust API Guidelines",
    "sources": ["The Cargo Book", "Rust API Guidelines"],
    "confidence": 0.95
  }
}
```

### 项目结构原则

| 原则 | 说明 | 示例 |
|------|------|------|
| 按功能拆 crate | 一个 crate 解决一个领域 | `core/`, `api/`, `cli/` |
| lib + bin 分离 | 逻辑在 lib.rs，入口在 main.rs | `main.rs` 仅调用 `lib.rs` |
| workspace 共享依赖 | 减少重复编译 | `[workspace.dependencies]` |
| 模块文件 vs 目录 | 简单用 `foo.rs`，复杂用 `foo/mod.rs` | Rust 2018 edition 推荐前者 |
| features 管理可选功能 | 编译期条件编译 | `#[cfg(feature = "serde")]` |

---

## 2. 所有权与借用

```json
{
  "title": "Rust: 所有权、借用与生命周期规范",
  "content": {
    "markdown": "## Rust: 所有权、借用与生命周期\n\n### 标准模式\n```rust\n// ✅ 优先借用而非获取所有权\nfn process(data: &[u8]) -> Result<Output, Error> { ... }\nfn display(name: &str) { ... }   // &str 而非 String\n\n// ✅ 需要修改时使用可变借用\nfn update(config: &mut Config) { ... }\n\n// ✅ 需要所有权时使用 move\nfn spawn_task(data: Vec<u8>) {\n    tokio::spawn(async move {\n        process(&data).await;\n    });\n}\n\n// ✅ Clone: 仅在语义上确实需要独立副本时\nlet backup = config.clone();\n\n// ✅ Cow 用于可能不需要克隆的场景\nuse std::borrow::Cow;\nfn normalize(input: &str) -> Cow<'_, str> {\n    if input.contains(' ') {\n        Cow::Owned(input.replace(' ', '_'))\n    } else {\n        Cow::Borrowed(input)\n    }\n}\n\n// ✅ 生命周期: 仅在编译器无法推断时显式标注\nfn longest<'a>(x: &'a str, y: &'a str) -> &'a str {\n    if x.len() > y.len() { x } else { y }\n}\n\n// ❌ 不要过度 clone() 来\"解决\"借用检查\n// ❌ 不要用 Rc/Arc 替代合理的生命周期设计\n// ❌ 不要为了方便而到处使用 'static\n```",
    "rationale": "所有权系统是 Rust 的核心创新，正确使用可消除数据竞争和内存安全问题"
  },
  "description": "Rust: 所有权、借用与生命周期规范",
  "kind": "rule",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "code-standard",
  "antiPattern": {
    "bad": "data.clone() // 到处 clone 绕过借用检查",
    "why": "掩盖了设计问题，增加不必要的内存分配",
    "fix": "重新设计数据流，使用借用或 Cow 减少克隆"
  },
  "reasoning": {
    "whyStandard": "The Rust Book Ch.4 - Understanding Ownership",
    "sources": ["The Rust Book", "Rust Nomicon"],
    "confidence": 0.95
  }
}
```

### 所有权决策表

| 场景 | 推荐方式 | 说明 |
|------|---------|------|
| 只读访问 | `&T` | 不可变借用 |
| 需要修改 | `&mut T` | 可变借用 |
| 转移所有权 | `T` (by value) | 函数需要拥有数据 |
| 可能需要克隆 | `Cow<'_, T>` | 延迟到实际需要时 |
| 共享所有权 | `Arc<T>` | 跨线程共享 |
| 内部可变性 | `RefCell<T>` / `Mutex<T>` | 运行时借用检查 |

---

## 3. 错误处理

```json
{
  "title": "Rust: 错误处理最佳实践 (Result/Option/?)",
  "content": {
    "markdown": "## Rust: 错误处理最佳实践\n\n### 标准模式\n```rust\n// ✅ 定义领域错误枚举\n#[derive(Debug, thiserror::Error)]\npub enum AppError {\n    #[error(\"database error: {0}\")]\n    Database(#[from] sqlx::Error),\n    #[error(\"not found: {entity} with id {id}\")]\n    NotFound { entity: &'static str, id: String },\n    #[error(\"validation failed: {0}\")]\n    Validation(String),\n}\n\n// ✅ 使用 ? 操作符传播错误\npub fn load_config(path: &Path) -> Result<Config, AppError> {\n    let content = std::fs::read_to_string(path)?;\n    let config: Config = serde_json::from_str(&content)?;\n    Ok(config)\n}\n\n// ✅ 对于 main/顶层使用 anyhow::Result\nfn main() -> anyhow::Result<()> {\n    let config = load_config(Path::new(\"config.toml\"))?;\n    run_server(config).await?;\n    Ok(())\n}\n\n// ✅ Option 用于可选值，不用于错误\nfn find_user(id: u64) -> Option<User> { ... }\n\n// ✅ 组合子链式处理\nlet name = user\n    .as_ref()\n    .map(|u| u.name.as_str())\n    .unwrap_or(\"anonymous\");\n\n// ❌ 避免 unwrap() 在生产代码中\n// ❌ 不要用 panic! 处理预期错误\n// ❌ 不要返回 Box<dyn Error> (库代码应用具体类型)\n```",
    "rationale": "Rust 通过类型系统强制错误处理，消除了未处理异常的风险"
  },
  "description": "Rust: 错误处理最佳实践",
  "kind": "rule",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "code-standard",
  "antiPattern": {
    "bad": "value.unwrap() // 生产代码中直接 unwrap",
    "why": "None/Err 时 panic，导致程序崩溃",
    "fix": "使用 ? 传播、unwrap_or_default()、expect(\"明确原因\") 或 match"
  },
  "reasoning": {
    "whyStandard": "The Rust Book Ch.9 - Error Handling; thiserror/anyhow 是社区标准",
    "sources": ["The Rust Book", "thiserror crate", "anyhow crate"],
    "confidence": 0.95
  }
}
```

### 错误处理策略

| 场景 | 工具 | 说明 |
|------|------|------|
| 库代码 | `thiserror` | 定义具体错误枚举 |
| 应用代码 | `anyhow` | 灵活的动态错误类型 |
| 错误传播 | `?` 操作符 | 自动 From 转换 + 提前返回 |
| 可选值 | `Option<T>` | `None` 不是错误 |
| 不可恢复 | `panic!` | 仅用于程序 bug / 不变量违反 |
| 上下文添加 | `.context("msg")?` | anyhow 上下文链 |

---

## 4. Trait 系统与泛型

```json
{
  "title": "Rust: Trait 与泛型最佳实践",
  "content": {
    "markdown": "## Rust: Trait 与泛型\n\n### 标准模式\n```rust\n// ✅ trait 定义行为契约\npub trait Repository {\n    type Error;\n    fn find_by_id(&self, id: &str) -> Result<Option<Entity>, Self::Error>;\n    fn save(&self, entity: &Entity) -> Result<(), Self::Error>;\n}\n\n// ✅ 泛型函数约束用 trait bounds\npub fn process<T: Serialize + Debug>(item: &T) -> Result<String, Error> { ... }\n\n// ✅ 复杂 bounds 用 where 子句\npub fn merge<I, T>(iter: I) -> Vec<T>\nwhere\n    I: IntoIterator<Item = T>,\n    T: Ord + Clone,\n{ ... }\n\n// ✅ impl Trait 用于返回类型 (隐藏具体类型)\npub fn create_handler() -> impl Handler { ... }\n\n// ✅ 常用 derive 宏\n#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]\npub struct UserId(String);\n\n// ✅ 为自定义类型实现标准 trait\nimpl Display for AppError {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { ... }\n}\n\n// ❌ 不要过度泛型化 — 具体类型足够时不用泛型\n// ❌ 不要在热路径使用 dyn Trait (有虚表开销)\n```",
    "rationale": "Trait 是 Rust 的多态核心，零成本抽象通过单态化实现"
  },
  "description": "Rust: Trait 与泛型最佳实践",
  "kind": "rule",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "code-standard",
  "antiPattern": {
    "bad": "fn process(item: &dyn Any)",
    "why": "丢失类型信息，需要运行时向下转型",
    "fix": "使用泛型 fn process<T: MyTrait>(item: &T) 保持静态分发"
  },
  "reasoning": {
    "whyStandard": "The Rust Book Ch.10 - Generic Types, Traits",
    "sources": ["The Rust Book", "Rust API Guidelines"],
    "confidence": 0.9
  }
}
```

---

## 5. 异步编程 (async/await)

```json
{
  "title": "Rust: 异步编程最佳实践 (tokio/async)",
  "content": {
    "markdown": "## Rust: 异步编程 (tokio)\n\n### 标准模式\n```rust\n// ✅ tokio 运行时入口\n#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    let listener = TcpListener::bind(\"0.0.0.0:8080\").await?;\n    // ...\n    Ok(())\n}\n\n// ✅ async fn 返回 Future\nasync fn fetch_data(url: &str) -> Result<Response, reqwest::Error> {\n    reqwest::get(url).await?.json().await\n}\n\n// ✅ 并发执行多个 Future\nlet (users, orders) = tokio::try_join!(\n    fetch_users(),\n    fetch_orders(),\n)?;\n\n// ✅ spawn 独立任务\ntokio::spawn(async move {\n    if let Err(e) = background_job(data).await {\n        tracing::error!(\"background job failed: {e}\");\n    }\n});\n\n// ✅ 使用 select! 竞争\ntokio::select! {\n    result = operation() => handle(result),\n    _ = tokio::time::sleep(Duration::from_secs(5)) => {\n        return Err(TimeoutError);\n    }\n}\n\n// ❌ 不要在 async 中调用阻塞 API (用 spawn_blocking)\n// ❌ 不要持有 MutexGuard 跨 await 点\n// ❌ 不要在 async fn 中使用 std::sync::Mutex (用 tokio::sync::Mutex)\n```",
    "rationale": "Rust async 是零成本抽象，编译为状态机，tokio 是事实标准运行时"
  },
  "description": "Rust: 异步编程最佳实践",
  "kind": "rule",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "code-standard",
  "antiPattern": {
    "bad": "let guard = mutex.lock().unwrap();\nsome_async_fn().await;  // 持有锁跨 await",
    "why": "std::sync::MutexGuard 不是 Send，且跨 await 点持有锁会阻塞",
    "fix": "限制锁的作用域，或使用 tokio::sync::Mutex"
  },
  "reasoning": {
    "whyStandard": "Tokio Tutorial; Async Book",
    "sources": ["Tokio Documentation", "The Async Book"],
    "confidence": 0.9
  }
}
```

---

## 6. Unsafe 使用规范

```json
{
  "title": "Rust: unsafe 使用规范",
  "content": {
    "markdown": "## Rust: unsafe\n\n### 标准模式\n```rust\n// ✅ unsafe 块应尽可能小，并加安全注释\n/// # Safety\n/// `ptr` must be a valid, aligned pointer to an initialized `T`.\nunsafe fn deref_raw<T>(ptr: *const T) -> &T {\n    // SAFETY: caller guarantees ptr is valid and aligned\n    &*ptr\n}\n\n// ✅ 封装 unsafe 为安全 API\npub fn get_unchecked(slice: &[u8], index: usize) -> Option<u8> {\n    if index < slice.len() {\n        // SAFETY: index is bounds-checked above\n        Some(unsafe { *slice.get_unchecked(index) })\n    } else {\n        None\n    }\n}\n\n// ✅ FFI unsafe 隔离在专用模块\nmod ffi {\n    extern \"C\" {\n        fn external_fn(ptr: *const u8, len: usize) -> i32;\n    }\n    pub fn safe_wrapper(data: &[u8]) -> i32 {\n        // SAFETY: passing valid slice pointer and length\n        unsafe { external_fn(data.as_ptr(), data.len()) }\n    }\n}\n\n// ❌ 不要在应用代码中随意使用 unsafe\n// ❌ 不要省略 SAFETY 注释\n// ❌ 不要用 unsafe 绕过借用检查器\n```",
    "rationale": "unsafe 是 Rust 安全系统的逃生舱口，必须谨慎使用并充分文档化"
  },
  "description": "Rust: unsafe 使用规范",
  "kind": "rule",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "code-standard",
  "antiPattern": {
    "bad": "unsafe { ... } // 无 SAFETY 注释的大块 unsafe",
    "why": "无法审计安全性，违反 Rust 的安全契约",
    "fix": "缩小 unsafe 范围，每个 unsafe 块添加 SAFETY 注释说明前置条件"
  },
  "reasoning": {
    "whyStandard": "The Rustonomicon; Rust API Guidelines - Unsafe",
    "sources": ["The Rustonomicon", "Rust API Guidelines"],
    "confidence": 0.95
  }
}
```

---

## 7. 结构体设计与构建器

```json
{
  "title": "Rust: 结构体设计模式 (Builder / Newtype / Default)",
  "content": {
    "markdown": "## Rust: 结构体设计模式\n\n### 标准模式\n```rust\n// ✅ Builder 模式 — 多个可选参数\n#[derive(Debug)]\npub struct ServerConfig {\n    host: String,\n    port: u16,\n    max_connections: usize,\n    tls: bool,\n}\n\nimpl ServerConfig {\n    pub fn builder() -> ServerConfigBuilder {\n        ServerConfigBuilder::default()\n    }\n}\n\n#[derive(Default)]\npub struct ServerConfigBuilder {\n    host: Option<String>,\n    port: Option<u16>,\n    max_connections: Option<usize>,\n    tls: bool,\n}\n\nimpl ServerConfigBuilder {\n    pub fn host(mut self, host: impl Into<String>) -> Self {\n        self.host = Some(host.into()); self\n    }\n    pub fn port(mut self, port: u16) -> Self {\n        self.port = Some(port); self\n    }\n    pub fn build(self) -> Result<ServerConfig, ConfigError> {\n        Ok(ServerConfig {\n            host: self.host.unwrap_or_else(|| \"localhost\".to_string()),\n            port: self.port.unwrap_or(8080),\n            max_connections: self.max_connections.unwrap_or(100),\n            tls: self.tls,\n        })\n    }\n}\n\n// ✅ Newtype 模式 — 类型安全包装\npub struct UserId(pub u64);\npub struct Email(String);\n\nimpl Email {\n    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {\n        let s = value.into();\n        if s.contains('@') { Ok(Self(s)) } else { Err(ValidationError::InvalidEmail) }\n    }\n}\n\n// ✅ Default trait\nimpl Default for Config {\n    fn default() -> Self {\n        Self { timeout: Duration::from_secs(30), retries: 3 }\n    }\n}\n\n// ✅ new() 构造函数约定\nimpl UserService {\n    pub fn new(repo: Arc<dyn UserRepository>) -> Self {\n        Self { repo }\n    }\n}\n```",
    "rationale": "Builder 解决多参数构造，Newtype 提供类型安全，Default 提供零值语义"
  },
  "description": "Rust: 结构体设计模式",
  "kind": "fact",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "architecture",
  "antiPattern": {
    "bad": "pub fn new(a: &str, b: &str, c: u16, d: bool, e: usize) -> Self",
    "why": "5+ 参数构造函数可读性和可维护性差",
    "fix": "使用 Builder 模式或参数结构体"
  },
  "reasoning": {
    "whyStandard": "Rust Design Patterns - Builder; Rust API Guidelines - C-BUILDER",
    "sources": ["Rust Design Patterns", "Rust API Guidelines"],
    "confidence": 0.9
  }
}
```

---

## 8. 测试规范

```json
{
  "title": "Rust: 测试最佳实践",
  "content": {
    "markdown": "## Rust: 测试最佳实践\n\n### 标准模式\n```rust\n// ✅ 单元测试 — 放在同一文件底部的 tests 模块\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn test_parse_valid_input() {\n        let result = parse(\"hello\").unwrap();\n        assert_eq!(result, Expected { name: \"hello\" });\n    }\n\n    #[test]\n    #[should_panic(expected = \"empty input\")]\n    fn test_parse_empty_panics() {\n        parse(\"\").unwrap();\n    }\n\n    #[test]\n    fn test_error_case() {\n        let err = parse(\"invalid\").unwrap_err();\n        assert!(matches!(err, ParseError::Invalid { .. }));\n    }\n}\n\n// ✅ 集成测试 — tests/ 目录，每个文件独立 crate\n// tests/api_test.rs\nuse myproject::api;\n\n#[tokio::test]\nasync fn test_create_user() {\n    let app = setup_test_app().await;\n    let resp = app.post(\"/users\").json(&new_user).send().await;\n    assert_eq!(resp.status(), StatusCode::CREATED);\n}\n\n// ✅ 测试 fixtures & helpers\n// tests/common/mod.rs\npub fn setup_test_db() -> TestDb { ... }\n\n// ✅ proptest / quickcheck 基于属性的测试\nproptest! {\n    #[test]\n    fn roundtrip_serialize(val: MyStruct) {\n        let encoded = serde_json::to_string(&val)?;\n        let decoded: MyStruct = serde_json::from_str(&encoded)?;\n        prop_assert_eq!(val, decoded);\n    }\n}\n\n// ❌ 不要忽略失败的测试 (#[ignore] 应有注释说明)\n// ❌ 不要用全局状态 — 测试可能并行执行\n```",
    "rationale": "Rust 内建测试框架零配置，同文件单元测试是社区标准做法"
  },
  "description": "Rust: 测试最佳实践",
  "kind": "rule",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "code-standard",
  "antiPattern": {
    "bad": "#[ignore] fn test_broken() { ... } // 无注释的 ignore",
    "why": "被忽略的测试会被遗忘，技术债积累",
    "fix": "添加注释说明原因和修复计划，或真正修复测试"
  },
  "reasoning": {
    "whyStandard": "The Rust Book Ch.11 - Writing Automated Tests",
    "sources": ["The Rust Book", "Rust Testing Guide"],
    "confidence": 0.9
  }
}
```

---

## 9. 命名约定

```json
{
  "title": "Rust: 命名约定 (RFC 430)",
  "content": {
    "markdown": "## Rust: 命名约定\n\n### 标准模式\n```rust\n// ✅ 类型 & Trait: UpperCamelCase\nstruct HttpClient { ... }\ntrait IntoIterator { ... }\nenum ParseError { ... }\n\n// ✅ 函数 & 方法 & 变量: snake_case\nfn parse_config(path: &Path) -> Result<Config> { ... }\nlet user_name = \"alice\";\n\n// ✅ 常量 & 静态变量: SCREAMING_SNAKE_CASE\nconst MAX_RETRIES: u32 = 3;\nstatic GLOBAL_CONFIG: OnceLock<Config> = OnceLock::new();\n\n// ✅ 模块 & crate: snake_case\nmod http_client;\n// Cargo.toml: name = \"my-crate\" (kebab-case)\n// use: use my_crate::... (自动转 snake_case)\n\n// ✅ 生命周期: 短小的小写字母\nfn parse<'a>(input: &'a str) -> &'a str { ... }\n\n// ✅ 类型参数: 单大写字母或描述性名称\nfn process<T: Send>(item: T) { ... }\nfn query<Conn: DatabaseConnection>(conn: &Conn) { ... }\n\n// ✅ 转换方法命名约定\nimpl Foo {\n    fn as_bar(&self) -> &Bar { ... }      // 廉价引用转换\n    fn to_bar(&self) -> Bar { ... }        // 可能有开销的转换\n    fn into_bar(self) -> Bar { ... }       // 消费 self 的转换\n}\n\n// ❌ 不要用 camelCase 命名函数\n// ❌ 不要用匈牙利命名法\n```",
    "rationale": "RFC 430 规定了 Rust 的命名约定，Clippy 会自动检查命名风格"
  },
  "description": "Rust: 命名约定",
  "kind": "rule",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "code-standard",
  "antiPattern": {
    "bad": "fn parseConfig() { ... }  // camelCase 函数名",
    "why": "违反 Rust 命名约定 (RFC 430)，Clippy 会发出警告",
    "fix": "fn parse_config() { ... }  // snake_case"
  },
  "reasoning": {
    "whyStandard": "RFC 430 - Naming Conventions; Rust API Guidelines",
    "sources": ["RFC 430", "Rust API Guidelines"],
    "confidence": 0.95
  }
}
```

### 转换方法命名速查

| 前缀 | 所有权 | 开销 | 示例 |
|------|--------|------|------|
| `as_` | 借用 → 借用 | 零成本 | `as_str()`, `as_bytes()` |
| `to_` | 借用 → 拥有 | 可能分配 | `to_string()`, `to_vec()` |
| `into_` | 拥有 → 拥有 | 消费 self | `into_inner()`, `into_vec()` |
| `from_` | 静态构造 | 变化 | `from_str()`, `from_utf8()` |
| `try_` | 可能失败 | 返回 Result | `try_from()`, `try_into()` |

---

## 10. 性能与惯用法

```json
{
  "title": "Rust: 性能与惯用法",
  "content": {
    "markdown": "## Rust: 性能与惯用法\n\n### 标准模式\n```rust\n// ✅ 迭代器链 (零成本抽象)\nlet sum: u64 = items.iter()\n    .filter(|x| x.is_valid())\n    .map(|x| x.value())\n    .sum();\n\n// ✅ 使用 collect 进行类型驱动的转换\nlet names: Vec<String> = users.iter().map(|u| u.name.clone()).collect();\nlet lookup: HashMap<&str, &User> = users.iter().map(|u| (u.id.as_str(), u)).collect();\n\n// ✅ 预分配容量\nlet mut results = Vec::with_capacity(items.len());\n\n// ✅ 使用 &str 而非 String 作为函数参数\nfn greet(name: &str) { println!(\"Hello, {name}\"); }\n\n// ✅ 使用 impl Into<String> 接受多种输入类型\nfn set_name(&mut self, name: impl Into<String>) {\n    self.name = name.into();\n}\n\n// ✅ match 穷举 + 编译器保证\nmatch status {\n    Status::Active => handle_active(),\n    Status::Inactive => handle_inactive(),\n    // 新增变体时编译器会报错\n}\n\n// ✅ 使用 clippy 全套 lint\n#![warn(clippy::all, clippy::pedantic)]\n\n// ❌ 不要手动循环能用迭代器解决的问题\n// ❌ 不要忽略 clippy 警告\n```",
    "rationale": "Rust 迭代器是零成本抽象，编译后与手写循环性能相当"
  },
  "description": "Rust: 性能与惯用法",
  "kind": "rule",
  "doClause": "Apply the Rust pattern as described",
  "language": "rust",
  "headers": [],
  "knowledgeType": "code-standard",
  "antiPattern": {
    "bad": "let mut result = Vec::new(); for item in &items { if item.valid { result.push(item.val); } }",
    "why": "手动循环不如迭代器链表达力强，且可能遗漏预分配",
    "fix": "items.iter().filter(|i| i.valid).map(|i| i.val).collect()"
  },
  "reasoning": {
    "whyStandard": "The Rust Book Ch.13 - Iterators; Clippy documentation",
    "sources": ["The Rust Book", "Clippy Lints"],
    "confidence": 0.9
  }
}
```

---

## 11. 宏使用规范

### 宏选择策略

| 场景 | 推荐方式 | 说明 |
|------|---------|------|
| 派生标准 trait | `#[derive(...)]` | 零成本，编译期生成 |
| 减少样板代码 | 声明宏 `macro_rules!` | 简单模式匹配 |
| 需要类型检查 | 过程宏 `proc_macro` | 复杂但强大 |
| 属性注解 | `#[attribute]` | 如 `#[tokio::main]`, `#[test]` |
| 编译期断言 | `static_assert!` | 类型/大小检查 |

### 常用 derive 宏清单

```text
调试:     Debug
拷贝:     Clone, Copy
比较:     PartialEq, Eq, PartialOrd, Ord
哈希:     Hash
默认值:   Default
序列化:   Serialize, Deserialize (serde)
错误类型: Error (thiserror)
```

---

## 12. 并发与同步原语

### 选择指南

| 场景 | 推荐 | 说明 |
|------|------|------|
| 跨线程共享不可变数据 | `Arc<T>` | 引用计数 |
| 跨线程共享可变数据 | `Arc<Mutex<T>>` | 互斥锁 |
| 读多写少 | `Arc<RwLock<T>>` | 读写锁 |
| 单次初始化 | `OnceLock<T>` / `LazyLock<T>` | std 1.80+ |
| 消息传递 | `mpsc::channel` | 多生产者单消费者 |
| async 消息传递 | `tokio::sync::mpsc` | 异步通道 |
| 原子操作 | `AtomicBool` / `AtomicUsize` | 无锁 |

```
