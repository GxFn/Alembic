---
name: autosnippet-reference-kotlin
description: Kotlin 业界最佳实践参考。涵盖空安全、协程、Flow、扩展函数、sealed class、DSL、委托、集合、Compose、测试，为冷启动分析提供高质量参考标准。
---

# Kotlin 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 Kotlin 项目时，请参考以下业界标准产出高质量候选。
> **来源**: Kotlin Coding Conventions (kotlinlang.org), Android Kotlin Style Guide, Effective Kotlin (Moskała), Kotlin Coroutines Guide

---

## 1. 空安全

### 核心规则

```json
{
  "title": "Kotlin: 空安全最佳实践",
  "content": {
    "markdown": "## Kotlin: 空安全最佳实践\n\n### 标准模式\n```kotlin\n// ✅ 优先使用不可空类型\nfun getUser(id: Long): User { ... }\n\n// ✅ 当值确实可能为 null 时才使用 nullable\nfun findUser(id: Long): User? {\n    return userRepository.findById(id)\n}\n\n// ✅ 安全调用链 + Elvis\nval city = user?.address?.city ?: \"Unknown\"\n\n// ✅ let + 安全调用处理 nullable\nuser?.let { activeUser ->\n    sendWelcomeEmail(activeUser)\n}\n\n// ✅ require / check 做前置条件校验\nfun updateUser(user: User?) {\n    requireNotNull(user) { \"user must not be null\" }\n    require(user.age >= 0) { \"age must be non-negative\" }\n    check(user.isActive) { \"user must be active\" }\n}\n\n// ✅ 当表达式真正需要 early return\nval name = user?.name ?: return\nval email = user?.email ?: throw IllegalStateException(\"email required\")\n\n// ❌ 避免 !! 操作符\nval name = user!!.name  // 可能抛 NPE\n\n// ❌ 避免无意义的 nullable\nfun getCount(): Int? = 42  // Int 就够了\n```",
    "pattern": "// ✅ 优先使用不可空类型\nfun getUser(id: Long): User { ... }\n\n// ✅ 当值确实可能为 null 时才使用 nullable\nfun findUser(id: Long): User? {\n    return userRepository.findById(id)\n}\n\n// ✅ 安全调用链 + Elvis\nval city = user?.address?.city ?: \"Unknown\"\n\n// ✅ let + 安全调用处理 nullable\nuser?.let { activeUser ->\n    sendWelcomeEmail(activeUser)\n}\n\n// ✅ require / check 做前置条件校验\nfun updateUser(user: User?) {\n    requireNotNull(user) { \"user must not be null\" }\n    require(user.age >= 0) { \"age must be non-negative\" }\n    check(user.isActive) { \"user must be active\" }\n}\n\n// ✅ 当表达式真正需要 early return\nval name = user?.name ?: return\nval email = user?.email ?: throw IllegalStateException(\"email required\")\n\n// ❌ 避免 !! 操作符\nval name = user!!.name  // 可能抛 NPE\n\n// ❌ 避免无意义的 nullable\nfun getCount(): Int? = 42  // Int 就够了",
    "rationale": "Kotlin 的类型系统在编译期防止 NPE，应充分利用这一能力"
  },
  "description": "Kotlin: 空安全最佳实践",
  "kind": "rule",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 空安全最佳实践的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "val name = user!!.name  // 或 user?.let { it.name } ?: \"\" 嵌套过深",
    "why": "!! 绕过编译器保护，运行时可能 NPE；过深 let 嵌套降低可读性",
    "fix": "使用 Elvis 操作符 ?: 或 early return；require/check 做入口校验"
  },
  "reasoning": {
    "whyStandard": "Kotlin 官方编程约定及 Android 推荐",
    "sources": [
      "Kotlin Coding Conventions",
      "Android Kotlin Style Guide"
    ],
    "confidence": 0.95
  }
}
```

---

## 2. 命名约定

```json
{
  "title": "Kotlin: 命名约定",
  "content": {
    "markdown": "## Kotlin: 命名约定\n\n### 标准模式\n```kotlin\n// ✅ 类/接口/对象: PascalCase\nclass UserService\ninterface UserRepository\nobject AppConfig\nsealed class Result<out T>\n\n// ✅ 函数/属性: camelCase\nfun getUserById(userId: Long): User\nval maxRetryCount = 3\n\n// ✅ 常量: UPPER_SNAKE_CASE\nconst val MAX_CONNECTIONS = 100\nval DEFAULT_TIMEOUT = 30.seconds  // Duration, 非 const\n\n// ✅ 包名: 全小写，无下划线\npackage com.example.userservice\n\n// ✅ 后备属性: 下划线前缀\nprivate val _users = MutableStateFlow<List<User>>(emptyList())\nval users: StateFlow<List<User>> = _users.asStateFlow()\n\n// ✅ Composable 函数: PascalCase (特例)\n@Composable\nfun UserProfile(user: User) { ... }\n\n// ✅ 测试方法: 反引号允许空格\n@Test\nfun `findById returns user when exists`() { ... }\n```",
    "pattern": "// ✅ 类/接口/对象: PascalCase\nclass UserService\ninterface UserRepository\nobject AppConfig\nsealed class Result<out T>\n\n// ✅ 函数/属性: camelCase\nfun getUserById(userId: Long): User\nval maxRetryCount = 3\n\n// ✅ 常量: UPPER_SNAKE_CASE\nconst val MAX_CONNECTIONS = 100\nval DEFAULT_TIMEOUT = 30.seconds  // Duration, 非 const\n\n// ✅ 包名: 全小写，无下划线\npackage com.example.userservice\n\n// ✅ 后备属性: 下划线前缀\nprivate val _users = MutableStateFlow<List<User>>(emptyList())\nval users: StateFlow<List<User>> = _users.asStateFlow()\n\n// ✅ Composable 函数: PascalCase (特例)\n@Composable\nfun UserProfile(user: User) { ... }\n\n// ✅ 测试方法: 反引号允许空格\n@Test\nfun `findById returns user when exists`() { ... }",
    "rationale": "统一的命名约定降低认知负担，后备属性是 Kotlin 惯用法"
  },
  "description": "Kotlin: 命名约定",
  "kind": "rule",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 命名约定的标准实现模式。",
  "reasoning": {
    "whyStandard": "Kotlin Coding Conventions - Naming rules",
    "sources": [
      "Kotlin Coding Conventions"
    ],
    "confidence": 0.95
  }
}
```

### 命名速查表

| 标识符类型 | 风格 | 示例 |
|-----------|------|------|
| 类/接口/object | `PascalCase` | `UserService`, `Runnable` |
| 函数/属性 | `camelCase` | `getUserById`, `isActive` |
| 编译时常量 | `UPPER_SNAKE_CASE` | `MAX_RETRIES` |
| 后备属性 | `_camelCase` | `_users`, `_uiState` |
| 包 | 全小写 | `com.example.data` |
| 泛型参数 | 单字母或 `out T` | `T`, `out R` |
| 枚举值 | `UPPER_SNAKE_CASE` 或 `PascalCase` | `PENDING`, `Loading` |
| @Composable | `PascalCase` | `UserCard()` |
| 测试方法 | `` `descriptive name` `` | `` `should return user` `` |

### 命名反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `IUserRepository` | 非 Kotlin 约定 | `UserRepository` |
| `mUserName` (m 前缀) | 匈牙利标记 | `userName` |
| `Companion.create()` | 伴生对象方法暴露 Companion | `User.create()` + `@JvmStatic` |
| `fun GetUser()` | 函数首字母大写 | `fun getUser()`（除 @Composable） |

---

## 3. Data Class 与 Sealed Class

```json
{
  "title": "Kotlin: data class 和 sealed class/interface",
  "content": {
    "markdown": "## Kotlin: data class 和 sealed class/interface\n\n### 标准模式\n```kotlin\n// ✅ data class: 不可变数据载体\ndata class User(\n    val id: Long,\n    val name: String,\n    val email: String,\n    val createdAt: Instant = Instant.now(),\n)\n\n// ✅ copy() 创建修改后的副本\nval updated = user.copy(name = \"New Name\")\n\n// ✅ sealed interface (推荐, 比 sealed class 更灵活)\nsealed interface Result<out T> {\n    data class Success<T>(val data: T) : Result<T>\n    data class Error(val message: String, val cause: Throwable? = null) : Result<Nothing>\n    data object Loading : Result<Nothing>\n}\n\n// ✅ when 穷举 sealed class — 编译器确保完整\nfun handleResult(result: Result<User>) = when (result) {\n    is Result.Success -> showUser(result.data)\n    is Result.Error -> showError(result.message)\n    is Result.Loading -> showLoading()\n    // 无需 else\n}\n\n// ✅ value class (内联类，零开销包装)\n@JvmInline\nvalue class UserId(val value: Long)\n\n@JvmInline\nvalue class Email(val value: String) {\n    init { require(value.contains('@')) { \"Invalid email\" } }\n}\n\nfun findUser(id: UserId): User  // 类型安全，zero overhead\n```",
    "pattern": "// ✅ data class: 不可变数据载体\ndata class User(\n    val id: Long,\n    val name: String,\n    val email: String,\n    val createdAt: Instant = Instant.now(),\n)\n\n// ✅ copy() 创建修改后的副本\nval updated = user.copy(name = \"New Name\")\n\n// ✅ sealed interface (推荐, 比 sealed class 更灵活)\nsealed interface Result<out T> {\n    data class Success<T>(val data: T) : Result<T>\n    data class Error(val message: String, val cause: Throwable? = null) : Result<Nothing>\n    data object Loading : Result<Nothing>\n}\n\n// ✅ when 穷举 sealed class — 编译器确保完整\nfun handleResult(result: Result<User>) = when (result) {\n    is Result.Success -> showUser(result.data)\n    is Result.Error -> showError(result.message)\n    is Result.Loading -> showLoading()\n    // 无需 else\n}\n\n// ✅ value class (内联类，零开销包装)\n@JvmInline\nvalue class UserId(val value: Long)\n\n@JvmInline\nvalue class Email(val value: String) {\n    init { require(value.contains('@')) { \"Invalid email\" } }\n}\n\nfun findUser(id: UserId): User  // 类型安全，zero overhead",
    "rationale": "Kotlin: data class 和 sealed class/interface的标准实现模式。"
  },
  "description": "Kotlin: data class 和 sealed class/interface",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: data class 和 sealed class/interface的标准实现模式。",
  "antiPattern": {
    "bad": "sealed class Result { class Success(val data: Any) : Result() }",
    "why": "data 关键字缺失 → 无 equals/hashCode/copy/toString；Any 类型不安全",
    "fix": "使用 data class + 泛型参数"
  },
  "reasoning": {
    "whyStandard": "Kotlin 官方推荐的 ADT 模式",
    "sources": [
      "Kotlin Docs - Sealed Classes",
      "Kotlin Docs - Inline Classes"
    ],
    "confidence": 0.95
  }
}
```

---

## 4. 协程 (Coroutines)

```json
{
  "title": "Kotlin: 协程最佳实践",
  "content": {
    "markdown": "## Kotlin: 协程最佳实践\n\n### 标准模式\n```kotlin\nimport kotlinx.coroutines.*\n\n// ✅ suspend 函数 — 主线程安全\nsuspend fun fetchUser(id: Long): User =\n    withContext(Dispatchers.IO) {\n        api.getUser(id)\n    }\n\n// ✅ 结构化并发 — coroutineScope 自动等待所有子任务\nsuspend fun loadDashboard(userId: Long): Dashboard =\n    coroutineScope {\n        val user = async { fetchUser(userId) }\n        val orders = async { fetchOrders(userId) }\n        Dashboard(user.await(), orders.await())\n    }\n\n// ✅ supervisorScope — 子任务失败不影响兄弟\nsuspend fun loadDashboardSafe(userId: Long): Dashboard =\n    supervisorScope {\n        val user = async { fetchUser(userId) }\n        val orders = async {\n            try { fetchOrders(userId) }\n            catch (e: Exception) { emptyList() }\n        }\n        Dashboard(user.await(), orders.await())\n    }\n\n// ✅ 异常处理\nval handler = CoroutineExceptionHandler { _, exception ->\n    log.error(\"Coroutine failed\", exception)\n}\n\nscope.launch(handler) {\n    riskyOperation()\n}\n\n// ✅ 取消协作: 检查 isActive 或使用 ensureActive()\nsuspend fun processItems(items: List<Item>) {\n    for (item in items) {\n        ensureActive()  // 抛 CancellationException 如果已取消\n        process(item)\n    }\n}\n\n// ❌ 反模式\nGlobalScope.launch { ... }  // 不受结构化并发管理，泄漏风险\nrunBlocking { ... }         // 阻塞线程，慎用（仅 main/test）\n```",
    "pattern": "import kotlinx.coroutines.*\n\n// ✅ suspend 函数 — 主线程安全\nsuspend fun fetchUser(id: Long): User =\n    withContext(Dispatchers.IO) {\n        api.getUser(id)\n    }\n\n// ✅ 结构化并发 — coroutineScope 自动等待所有子任务\nsuspend fun loadDashboard(userId: Long): Dashboard =\n    coroutineScope {\n        val user = async { fetchUser(userId) }\n        val orders = async { fetchOrders(userId) }\n        Dashboard(user.await(), orders.await())\n    }\n\n// ✅ supervisorScope — 子任务失败不影响兄弟\nsuspend fun loadDashboardSafe(userId: Long): Dashboard =\n    supervisorScope {\n        val user = async { fetchUser(userId) }\n        val orders = async {\n            try { fetchOrders(userId) }\n            catch (e: Exception) { emptyList() }\n        }\n        Dashboard(user.await(), orders.await())\n    }\n\n// ✅ 异常处理\nval handler = CoroutineExceptionHandler { _, exception ->\n    log.error(\"Coroutine failed\", exception)\n}\n\nscope.launch(handler) {\n    riskyOperation()\n}\n\n// ✅ 取消协作: 检查 isActive 或使用 ensureActive()\nsuspend fun processItems(items: List<Item>) {\n    for (item in items) {\n        ensureActive()  // 抛 CancellationException 如果已取消\n        process(item)\n    }\n}\n\n// ❌ 反模式\nGlobalScope.launch { ... }  // 不受结构化并发管理，泄漏风险\nrunBlocking { ... }         // 阻塞线程，慎用（仅 main/test）",
    "rationale": "Kotlin: 协程最佳实践的标准实现模式。"
  },
  "description": "Kotlin: 协程最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 协程最佳实践的标准实现模式。",
  "antiPattern": {
    "bad": "GlobalScope.launch { fetchUser(id) }",
    "why": "GlobalScope 不受生命周期管理，协程泄漏；异常无法传播",
    "fix": "使用 viewModelScope / lifecycleScope / 自定义 CoroutineScope"
  },
  "reasoning": {
    "whyStandard": "Kotlin Coroutines Guide: Structured Concurrency",
    "sources": [
      "Kotlin Coroutines Guide",
      "Android Coroutines Best Practices"
    ],
    "confidence": 0.95
  }
}
```

### 协程反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `GlobalScope.launch` | 生命周期泄漏 | 使用结构化 scope |
| `runBlocking` 在主线程 | 阻塞 UI 线程 | `suspend` + scope.launch |
| 忽略 `CancellationException` | 破坏取消传播 | 重新抛出或不捕获 |
| `Dispatchers.IO` 到处用 | 不区分 CPU/IO | CPU 密集用 `Default` |
| `async { }.await()` 立即 | 失去并发意义 | 直接调用 suspend 函数 |

---

## 5. Flow

```json
{
  "title": "Kotlin: Flow 响应式数据流",
  "content": {
    "markdown": "## Kotlin: Flow 响应式数据流\n\n### 标准模式\n```kotlin\nimport kotlinx.coroutines.flow.*\n\n// ✅ Flow 生产者\nfun observeUsers(): Flow<List<User>> =\n    userDao.observeAll()\n        .map { entities -> entities.map { it.toUser() } }\n        .distinctUntilChanged()\n        .flowOn(Dispatchers.IO)  // 上游切换到 IO 线程\n\n// ✅ StateFlow — 状态持有（替代 LiveData）\nclass UserViewModel : ViewModel() {\n    private val _uiState = MutableStateFlow<UiState>(UiState.Loading)\n    val uiState: StateFlow<UiState> = _uiState.asStateFlow()\n\n    fun loadUsers() {\n        viewModelScope.launch {\n            _uiState.value = UiState.Loading\n            try {\n                val users = fetchUsers()\n                _uiState.value = UiState.Success(users)\n            } catch (e: Exception) {\n                _uiState.value = UiState.Error(e.message ?: \"Unknown error\")\n            }\n        }\n    }\n\n    // ✅ stateIn 转换 Flow → StateFlow\n    val users: StateFlow<List<User>> = userRepository.observeUsers()\n        .stateIn(\n            scope = viewModelScope,\n            started = SharingStarted.WhileSubscribed(5_000),\n            initialValue = emptyList(),\n        )\n}\n\n// ✅ 在 Compose 中安全收集\n@Composable\nfun UserScreen(viewModel: UserViewModel = hiltViewModel()) {\n    val uiState by viewModel.uiState.collectAsStateWithLifecycle()\n    ...\n}\n\n// ✅ combine 合并多个 Flow\nval dashboard: Flow<Dashboard> = combine(\n    userFlow,\n    ordersFlow,\n    notificationsFlow,\n) { user, orders, notifs -> Dashboard(user, orders, notifs) }\n```",
    "pattern": "import kotlinx.coroutines.flow.*\n\n// ✅ Flow 生产者\nfun observeUsers(): Flow<List<User>> =\n    userDao.observeAll()\n        .map { entities -> entities.map { it.toUser() } }\n        .distinctUntilChanged()\n        .flowOn(Dispatchers.IO)  // 上游切换到 IO 线程\n\n// ✅ StateFlow — 状态持有（替代 LiveData）\nclass UserViewModel : ViewModel() {\n    private val _uiState = MutableStateFlow<UiState>(UiState.Loading)\n    val uiState: StateFlow<UiState> = _uiState.asStateFlow()\n\n    fun loadUsers() {\n        viewModelScope.launch {\n            _uiState.value = UiState.Loading\n            try {\n                val users = fetchUsers()\n                _uiState.value = UiState.Success(users)\n            } catch (e: Exception) {\n                _uiState.value = UiState.Error(e.message ?: \"Unknown error\")\n            }\n        }\n    }\n\n    // ✅ stateIn 转换 Flow → StateFlow\n    val users: StateFlow<List<User>> = userRepository.observeUsers()\n        .stateIn(\n            scope = viewModelScope,\n            started = SharingStarted.WhileSubscribed(5_000),\n            initialValue = emptyList(),\n        )\n}\n\n// ✅ 在 Compose 中安全收集\n@Composable\nfun UserScreen(viewModel: UserViewModel = hiltViewModel()) {\n    val uiState by viewModel.uiState.collectAsStateWithLifecycle()\n    ...\n}\n\n// ✅ combine 合并多个 Flow\nval dashboard: Flow<Dashboard> = combine(\n    userFlow,\n    ordersFlow,\n    notificationsFlow,\n) { user, orders, notifs -> Dashboard(user, orders, notifs) }",
    "rationale": "StateFlow 替代 LiveData 成为 Android 推荐的状态管理方案"
  },
  "description": "Kotlin: Flow 响应式数据流",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: Flow 响应式数据流的标准实现模式。",
  "reasoning": {
    "whyStandard": "Android 官方推荐 StateFlow + collectAsStateWithLifecycle",
    "sources": [
      "Android Docs - StateFlow",
      "Kotlin Flow Guide"
    ],
    "confidence": 0.95
  }
}
```

---

## 6. 扩展函数与 Scope Functions

```json
{
  "title": "Kotlin: 扩展函数 + Scope Functions 使用指南",
  "content": {
    "markdown": "## Kotlin: 扩展函数 + Scope Functions 使用指南\n\n### 标准模式\n```kotlin\n// ✅ 工具类扩展 — 替代 Java static util 方法\nfun String.toSlug(): String =\n    lowercase()\n        .replace(Regex(\"[^a-z0-9\\\\s-]\"), \"\")\n        .replace(Regex(\"\\\\s+\"), \"-\")\n        .trim('-')\n\n// ✅ 为第三方类添加领域方法\nfun Instant.toLocalDate(zone: ZoneId = ZoneId.systemDefault()): LocalDate =\n    atZone(zone).toLocalDate()\n\n// ━━━ Scope Functions 选择指南 ━━━\n//\n//   | 函数   | 对象引用 | 返回值   | 典型场景             |\n//   |--------|---------|---------|---------------------|\n//   | let    | it      | lambda  | 非空转换、作用域限定    |\n//   | run    | this    | lambda  | 对象配置 + 返回结果    |\n//   | with   | this    | lambda  | 对已知非空对象操作     |\n//   | apply  | this    | 对象    | 对象初始化/配置       |\n//   | also   | it      | 对象    | 副作用（日志、调试）   |\n\n// ✅ apply: 初始化配置\nval config = ServerConfig().apply {\n    host = \"localhost\"\n    port = 8080\n    maxConnections = 100\n}\n\n// ✅ let: 安全调用 + 转换\nval email = user?.email?.let { parseEmail(it) }\n\n// ✅ also: 日志/调试副作用\nreturn fetchUser(id).also {\n    logger.info(\"Fetched user: ${it.name}\")\n}\n\n// ❌ 避免嵌套过深的 scope function\nuser?.let { u ->\n    u.address?.let { addr ->\n        addr.city?.let { ... }  // 3 层嵌套 → 用 ?.chain\n    }\n}\n```",
    "pattern": "// ✅ 工具类扩展 — 替代 Java static util 方法\nfun String.toSlug(): String =\n    lowercase()\n        .replace(Regex(\"[^a-z0-9\\\\s-]\"), \"\")\n        .replace(Regex(\"\\\\s+\"), \"-\")\n        .trim('-')\n\n// ✅ 为第三方类添加领域方法\nfun Instant.toLocalDate(zone: ZoneId = ZoneId.systemDefault()): LocalDate =\n    atZone(zone).toLocalDate()\n\n// ━━━ Scope Functions 选择指南 ━━━\n//\n//   | 函数   | 对象引用 | 返回值   | 典型场景             |\n//   |--------|---------|---------|---------------------|\n//   | let    | it      | lambda  | 非空转换、作用域限定    |\n//   | run    | this    | lambda  | 对象配置 + 返回结果    |\n//   | with   | this    | lambda  | 对已知非空对象操作     |\n//   | apply  | this    | 对象    | 对象初始化/配置       |\n//   | also   | it      | 对象    | 副作用（日志、调试）   |\n\n// ✅ apply: 初始化配置\nval config = ServerConfig().apply {\n    host = \"localhost\"\n    port = 8080\n    maxConnections = 100\n}\n\n// ✅ let: 安全调用 + 转换\nval email = user?.email?.let { parseEmail(it) }\n\n// ✅ also: 日志/调试副作用\nreturn fetchUser(id).also {\n    logger.info(\"Fetched user: ${it.name}\")\n}\n\n// ❌ 避免嵌套过深的 scope function\nuser?.let { u ->\n    u.address?.let { addr ->\n        addr.city?.let { ... }  // 3 层嵌套 → 用 ?.chain\n    }\n}",
    "rationale": "Kotlin: 扩展函数 + Scope Functions 使用指南的标准实现模式。"
  },
  "description": "Kotlin: 扩展函数 + Scope Functions 使用指南",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 扩展函数 + Scope Functions 使用指南的标准实现模式。",
  "antiPattern": {
    "bad": "user?.let { it.address?.let { it.city?.let { ... } } }",
    "why": "多层 let 嵌套降低可读性，比 Java null check 更难读",
    "fix": "使用安全调用链: user?.address?.city?.let { ... }"
  },
  "reasoning": {
    "whyStandard": "Kotlin Coding Conventions - Scope functions",
    "sources": [
      "Kotlin Docs - Scope Functions"
    ],
    "confidence": 0.9
  }
}
```

---

## 7. 集合与序列

```json
{
  "title": "Kotlin: 集合操作最佳实践",
  "content": {
    "markdown": "## Kotlin: 集合操作最佳实践\n\n### 标准模式\n```kotlin\n// ✅ 不可变集合 (默认)\nval users: List<User> = listOf(user1, user2)\nval userMap: Map<Long, User> = mapOf(1L to user1, 2L to user2)\n\n// ✅ 可变集合 — 仅在需要时使用\nval mutableUsers = mutableListOf<User>()\nmutableUsers.add(newUser)\n\n// ✅ 集合变换 — 链式操作\nval activeEmails = users\n    .filter { it.isActive }\n    .map { it.email }\n    .sorted()\n    .distinct()\n\n// ✅ Sequence — 大集合惰性求值\nval result = hugeList.asSequence()\n    .filter { it.isValid() }      // 惰性\n    .map { it.transform() }       // 惰性\n    .take(10)                      // 短路\n    .toList()                      // 终端操作触发计算\n\n// ✅ buildList / buildMap (Kotlin 1.6+)\nval items = buildList {\n    add(\"header\")\n    addAll(body)\n    if (showFooter) add(\"footer\")\n}\n\n// ✅ groupBy / associateBy\nval usersByRole: Map<Role, List<User>> = users.groupBy { it.role }\nval userById: Map<Long, User> = users.associateBy { it.id }\n\n// ✅ 解构\nval (name, age) = user  // data class 解构\nfor ((key, value) in map) { ... }\n\n// ❌ 小集合不需要 Sequence\nlistOf(1, 2, 3).asSequence()  // 过度优化\n\n// ❌ 可变集合暴露给外部\nclass Repo {\n    val items = mutableListOf<Item>()  // 外部可修改\n}\n```",
    "pattern": "// ✅ 不可变集合 (默认)\nval users: List<User> = listOf(user1, user2)\nval userMap: Map<Long, User> = mapOf(1L to user1, 2L to user2)\n\n// ✅ 可变集合 — 仅在需要时使用\nval mutableUsers = mutableListOf<User>()\nmutableUsers.add(newUser)\n\n// ✅ 集合变换 — 链式操作\nval activeEmails = users\n    .filter { it.isActive }\n    .map { it.email }\n    .sorted()\n    .distinct()\n\n// ✅ Sequence — 大集合惰性求值\nval result = hugeList.asSequence()\n    .filter { it.isValid() }      // 惰性\n    .map { it.transform() }       // 惰性\n    .take(10)                      // 短路\n    .toList()                      // 终端操作触发计算\n\n// ✅ buildList / buildMap (Kotlin 1.6+)\nval items = buildList {\n    add(\"header\")\n    addAll(body)\n    if (showFooter) add(\"footer\")\n}\n\n// ✅ groupBy / associateBy\nval usersByRole: Map<Role, List<User>> = users.groupBy { it.role }\nval userById: Map<Long, User> = users.associateBy { it.id }\n\n// ✅ 解构\nval (name, age) = user  // data class 解构\nfor ((key, value) in map) { ... }\n\n// ❌ 小集合不需要 Sequence\nlistOf(1, 2, 3).asSequence()  // 过度优化\n\n// ❌ 可变集合暴露给外部\nclass Repo {\n    val items = mutableListOf<Item>()  // 外部可修改\n}",
    "rationale": "Kotlin 默认不可变集合提供安全性；Sequence 在大集合时避免中间分配"
  },
  "description": "Kotlin: 集合操作最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 集合操作最佳实践的标准实现模式。",
  "reasoning": {
    "whyStandard": "Kotlin Docs - Collections; Effective Kotlin Item 1: 优先使用不可变",
    "sources": [
      "Kotlin Docs - Collections",
      "Effective Kotlin"
    ],
    "confidence": 0.9
  }
}
```

---

## 8. 委托 (Delegation)

```json
{
  "title": "Kotlin: 属性委托与类委托",
  "content": {
    "markdown": "## Kotlin: 属性委托与类委托\n\n### 标准模式\n```kotlin\nimport kotlin.properties.Delegates\n\n// ✅ by lazy — 线程安全的延迟初始化\nval heavyObject: HeavyThing by lazy {\n    HeavyThing.create()  // 第一次访问时初始化\n}\n\n// ✅ Delegates.observable — 属性变更监听\nvar name: String by Delegates.observable(\"initial\") { _, old, new ->\n    logger.info(\"name changed: $old → $new\")\n}\n\n// ✅ Delegates.vetoable — 带校验的属性\nvar age: Int by Delegates.vetoable(0) { _, _, new ->\n    new >= 0  // return false 拒绝修改\n}\n\n// ✅ 自定义委托\nclass SharedPreferenceDelegate<T>(\n    private val key: String,\n    private val default: T,\n) : ReadWriteProperty<Any, T> {\n    override fun getValue(thisRef: Any, property: KProperty<*>): T = ...\n    override fun setValue(thisRef: Any, property: KProperty<*>, value: T) { ... }\n}\n\nvar userName: String by SharedPreferenceDelegate(\"user_name\", \"\")\n\n// ✅ 类委托 — 替代继承实现复用\nclass CountingSet<T>(\n    private val inner: MutableSet<T> = mutableSetOf()\n) : MutableSet<T> by inner {\n    var count = 0\n        private set\n\n    override fun add(element: T): Boolean {\n        count++\n        return inner.add(element)\n    }\n}\n\n// ✅ Android: by viewModels() / by activityViewModels()\nclass UserFragment : Fragment() {\n    private val viewModel: UserViewModel by viewModels()\n    private val sharedVm: SharedViewModel by activityViewModels()\n}\n```",
    "pattern": "import kotlin.properties.Delegates\n\n// ✅ by lazy — 线程安全的延迟初始化\nval heavyObject: HeavyThing by lazy {\n    HeavyThing.create()  // 第一次访问时初始化\n}\n\n// ✅ Delegates.observable — 属性变更监听\nvar name: String by Delegates.observable(\"initial\") { _, old, new ->\n    logger.info(\"name changed: $old → $new\")\n}\n\n// ✅ Delegates.vetoable — 带校验的属性\nvar age: Int by Delegates.vetoable(0) { _, _, new ->\n    new >= 0  // return false 拒绝修改\n}\n\n// ✅ 自定义委托\nclass SharedPreferenceDelegate<T>(\n    private val key: String,\n    private val default: T,\n) : ReadWriteProperty<Any, T> {\n    override fun getValue(thisRef: Any, property: KProperty<*>): T = ...\n    override fun setValue(thisRef: Any, property: KProperty<*>, value: T) { ... }\n}\n\nvar userName: String by SharedPreferenceDelegate(\"user_name\", \"\")\n\n// ✅ 类委托 — 替代继承实现复用\nclass CountingSet<T>(\n    private val inner: MutableSet<T> = mutableSetOf()\n) : MutableSet<T> by inner {\n    var count = 0\n        private set\n\n    override fun add(element: T): Boolean {\n        count++\n        return inner.add(element)\n    }\n}\n\n// ✅ Android: by viewModels() / by activityViewModels()\nclass UserFragment : Fragment() {\n    private val viewModel: UserViewModel by viewModels()\n    private val sharedVm: SharedViewModel by activityViewModels()\n}",
    "rationale": "委托消除样板代码，是 Kotlin 区别于 Java 的核心惯用法之一"
  },
  "description": "Kotlin: 属性委托与类委托",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 属性委托与类委托的标准实现模式。",
  "reasoning": {
    "whyStandard": "Kotlin Docs - Delegated Properties; Effective Kotlin Item 21",
    "sources": [
      "Kotlin Docs - Delegation"
    ],
    "confidence": 0.9
  }
}
```

---

## 9. 依赖注入

```json
{
  "title": "Kotlin: 构造函数注入 (Hilt/Koin)",
  "content": {
    "markdown": "## Kotlin: 构造函数注入 (Hilt/Koin)\n\n### 标准模式\n```kotlin\n// ━━━ Hilt (推荐 Android 项目) ━━━\n\n@HiltAndroidApp\nclass MyApplication : Application()\n\n@AndroidEntryPoint\nclass UserFragment : Fragment() {\n    private val viewModel: UserViewModel by viewModels()\n}\n\n@HiltViewModel\nclass UserViewModel @Inject constructor(\n    private val userRepository: UserRepository,\n    private val savedStateHandle: SavedStateHandle,\n) : ViewModel() { ... }\n\n// ✅ Hilt Module 绑定接口\n@Module\n@InstallIn(SingletonComponent::class)\nabstract class RepositoryModule {\n    @Binds\n    abstract fun bindUserRepo(impl: UserRepositoryImpl): UserRepository\n}\n\n// ━━━ Koin (轻量级, 多平台) ━━━\n\nval appModule = module {\n    single<UserRepository> { UserRepositoryImpl(get()) }\n    viewModel { UserViewModel(get()) }\n    factory { CreateUserUseCase(get()) }\n}\n\n// ❌ 反模式\nclass UserViewModel {\n    val repo = UserRepositoryImpl()  // 硬编码依赖，不可测试\n}\n```",
    "pattern": "// ━━━ Hilt (推荐 Android 项目) ━━━\n\n@HiltAndroidApp\nclass MyApplication : Application()\n\n@AndroidEntryPoint\nclass UserFragment : Fragment() {\n    private val viewModel: UserViewModel by viewModels()\n}\n\n@HiltViewModel\nclass UserViewModel @Inject constructor(\n    private val userRepository: UserRepository,\n    private val savedStateHandle: SavedStateHandle,\n) : ViewModel() { ... }\n\n// ✅ Hilt Module 绑定接口\n@Module\n@InstallIn(SingletonComponent::class)\nabstract class RepositoryModule {\n    @Binds\n    abstract fun bindUserRepo(impl: UserRepositoryImpl): UserRepository\n}\n\n// ━━━ Koin (轻量级, 多平台) ━━━\n\nval appModule = module {\n    single<UserRepository> { UserRepositoryImpl(get()) }\n    viewModel { UserViewModel(get()) }\n    factory { CreateUserUseCase(get()) }\n}\n\n// ❌ 反模式\nclass UserViewModel {\n    val repo = UserRepositoryImpl()  // 硬编码依赖，不可测试\n}",
    "rationale": "构造函数注入让依赖可见、可测试、不可变"
  },
  "description": "Kotlin: 构造函数注入 (Hilt/Koin)",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 构造函数注入 (Hilt/Koin)的标准实现模式。",
  "reasoning": {
    "whyStandard": "Android 官方推荐 Hilt; Koin 是 Kotlin 优先的轻量方案",
    "sources": [
      "Android Hilt Guide",
      "Koin Docs"
    ],
    "confidence": 0.9
  }
}
```

---

## 10. Jetpack Compose

```json
{
  "title": "Kotlin: Composable 函数约定",
  "content": {
    "markdown": "## Kotlin: Composable 函数约定\n\n### 标准模式\n```kotlin\n@Composable\nfun UserCard(\n    user: User,\n    onEdit: (User) -> Unit,\n    modifier: Modifier = Modifier,  // modifier 参数排最后\n) {\n    // ✅ remember 缓存计算\n    val formattedDate = remember(user.createdAt) {\n        dateFormatter.format(user.createdAt)\n    }\n\n    // ✅ 单向数据流: state hoisting\n    Card(modifier = modifier) {\n        Text(text = user.name)\n        Text(text = formattedDate)\n        Button(onClick = { onEdit(user) }) {\n            Text(\"Edit\")\n        }\n    }\n}\n\n// ✅ 状态管理 + collectAsStateWithLifecycle\n@Composable\nfun UserScreen(viewModel: UserViewModel = hiltViewModel()) {\n    val uiState by viewModel.uiState.collectAsStateWithLifecycle()\n    when (val state = uiState) {\n        is UiState.Loading -> CircularProgressIndicator()\n        is UiState.Success -> UserList(state.users)\n        is UiState.Error -> ErrorMessage(state.message)\n    }\n}\n\n// ✅ 副作用 API\n@Composable\nfun UserScreen(userId: Long, viewModel: UserViewModel = hiltViewModel()) {\n    // LaunchedEffect: 在 Composition 中启动协程\n    LaunchedEffect(userId) {\n        viewModel.loadUser(userId)\n    }\n\n    // DisposableEffect: 需要清理的副作用\n    DisposableEffect(Unit) {\n        val listener = EventBus.subscribe { ... }\n        onDispose { listener.unsubscribe() }\n    }\n}\n\n// ✅ Compose 命名约定\n// Stateful: UserScreen() — 包含 ViewModel\n// Stateless: UserContent(state, onAction) — 纯 UI\n\n// ❌ 在 @Composable 中直接调 ViewModel 方法修改状态\n// ❌ remember {} 不带 key — 值永远不更新\n```",
    "pattern": "@Composable\nfun UserCard(\n    user: User,\n    onEdit: (User) -> Unit,\n    modifier: Modifier = Modifier,  // modifier 参数排最后\n) {\n    // ✅ remember 缓存计算\n    val formattedDate = remember(user.createdAt) {\n        dateFormatter.format(user.createdAt)\n    }\n\n    // ✅ 单向数据流: state hoisting\n    Card(modifier = modifier) {\n        Text(text = user.name)\n        Text(text = formattedDate)\n        Button(onClick = { onEdit(user) }) {\n            Text(\"Edit\")\n        }\n    }\n}\n\n// ✅ 状态管理 + collectAsStateWithLifecycle\n@Composable\nfun UserScreen(viewModel: UserViewModel = hiltViewModel()) {\n    val uiState by viewModel.uiState.collectAsStateWithLifecycle()\n    when (val state = uiState) {\n        is UiState.Loading -> CircularProgressIndicator()\n        is UiState.Success -> UserList(state.users)\n        is UiState.Error -> ErrorMessage(state.message)\n    }\n}\n\n// ✅ 副作用 API\n@Composable\nfun UserScreen(userId: Long, viewModel: UserViewModel = hiltViewModel()) {\n    // LaunchedEffect: 在 Composition 中启动协程\n    LaunchedEffect(userId) {\n        viewModel.loadUser(userId)\n    }\n\n    // DisposableEffect: 需要清理的副作用\n    DisposableEffect(Unit) {\n        val listener = EventBus.subscribe { ... }\n        onDispose { listener.unsubscribe() }\n    }\n}\n\n// ✅ Compose 命名约定\n// Stateful: UserScreen() — 包含 ViewModel\n// Stateless: UserContent(state, onAction) — 纯 UI\n\n// ❌ 在 @Composable 中直接调 ViewModel 方法修改状态\n// ❌ remember {} 不带 key — 值永远不更新",
    "rationale": "状态提升 + 单向数据流是 Compose 核心架构原则"
  },
  "description": "Kotlin: Composable 函数约定",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: Composable 函数约定的标准实现模式。",
  "reasoning": {
    "whyStandard": "Android Compose 官方架构指南",
    "sources": [
      "Android Compose Docs",
      "Compose API Guidelines"
    ],
    "confidence": 0.9
  }
}
```

---

## 11. DSL 与高阶函数

```json
{
  "title": "Kotlin: DSL 构建器模式",
  "content": {
    "markdown": "## Kotlin: DSL 构建器模式\n\n### 标准模式\n```kotlin\n// ✅ 类型安全的 DSL Builder\n@DslMarker\nannotation class HtmlDsl\n\n@HtmlDsl\nclass HTML {\n    private val children = mutableListOf<Element>()\n    fun head(init: Head.() -> Unit) { children += Head().apply(init) }\n    fun body(init: Body.() -> Unit) { children += Body().apply(init) }\n}\n\nfun html(init: HTML.() -> Unit): HTML = HTML().apply(init)\n\n// 使用\nval page = html {\n    head { title(\"My Page\") }\n    body {\n        h1(\"Hello\")\n        p(\"World\")\n    }\n}\n\n// ✅ 高阶函数 — inline 避免 lambda 对象分配\ninline fun <T> measureTime(block: () -> T): Pair<T, Duration> {\n    val start = System.nanoTime()\n    val result = block()\n    val elapsed = (System.nanoTime() - start).nanoseconds\n    return result to elapsed\n}\n\n// ✅ trailing lambda 语法\nuserList.filter { it.isActive }\n    .sortedBy { it.name }\n    .forEach { println(it) }\n\n// ❌ @DslMarker 缺失会导致外层 receiver 泄漏\nhtml {\n    body {\n        head { ... }  // 不应在 body 内调 head\n    }\n}\n```",
    "pattern": "// ✅ 类型安全的 DSL Builder\n@DslMarker\nannotation class HtmlDsl\n\n@HtmlDsl\nclass HTML {\n    private val children = mutableListOf<Element>()\n    fun head(init: Head.() -> Unit) { children += Head().apply(init) }\n    fun body(init: Body.() -> Unit) { children += Body().apply(init) }\n}\n\nfun html(init: HTML.() -> Unit): HTML = HTML().apply(init)\n\n// 使用\nval page = html {\n    head { title(\"My Page\") }\n    body {\n        h1(\"Hello\")\n        p(\"World\")\n    }\n}\n\n// ✅ 高阶函数 — inline 避免 lambda 对象分配\ninline fun <T> measureTime(block: () -> T): Pair<T, Duration> {\n    val start = System.nanoTime()\n    val result = block()\n    val elapsed = (System.nanoTime() - start).nanoseconds\n    return result to elapsed\n}\n\n// ✅ trailing lambda 语法\nuserList.filter { it.isActive }\n    .sortedBy { it.name }\n    .forEach { println(it) }\n\n// ❌ @DslMarker 缺失会导致外层 receiver 泄漏\nhtml {\n    body {\n        head { ... }  // 不应在 body 内调 head\n    }\n}",
    "rationale": "DSL 是 Kotlin 特色能力 (Gradle Kotlin DSL, Ktor routing, Compose)"
  },
  "description": "Kotlin: DSL 构建器模式",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: DSL 构建器模式的标准实现模式。",
  "reasoning": {
    "whyStandard": "Kotlin Docs - Type-safe Builders; Effective Kotlin Item 43-44",
    "sources": [
      "Kotlin Docs - Type-safe Builders"
    ],
    "confidence": 0.85
  }
}
```

---

## 12. 错误处理

```json
{
  "title": "Kotlin: 错误处理模式",
  "content": {
    "markdown": "## Kotlin: 错误处理模式\n\n### 标准模式\n```kotlin\n// ✅ sealed class Result 替代异常 (业务层)\nsealed interface AppResult<out T> {\n    data class Success<T>(val data: T) : AppResult<T>\n    data class Failure(val error: AppError) : AppResult<Nothing>\n}\n\nsealed class AppError {\n    data class NotFound(val resource: String) : AppError()\n    data class Validation(val field: String, val message: String) : AppError()\n    data class Network(val cause: Throwable) : AppError()\n}\n\n// ✅ runCatching — stdlib 的 Result 封装\nval result: Result<User> = runCatching { api.getUser(id) }\nresult\n    .onSuccess { user -> display(user) }\n    .onFailure { error -> log.error(\"Failed\", error) }\n\n// ✅ getOrElse / getOrDefault\nval user = runCatching { api.getUser(id) }\n    .getOrElse { User.anonymous() }\n\n// ✅ 异常仅用于真正异常情况\nfun parseAge(input: String): Int {\n    return input.toIntOrNull()\n        ?: throw ValidationException(\"Invalid age: $input\")\n}\n\n// ❌ 不要吞掉 CancellationException\ntry {\n    suspendFunction()\n} catch (e: Exception) {\n    // ⚠️ 如果 e 是 CancellationException，必须重新抛出\n    if (e is CancellationException) throw e\n    handleError(e)\n}\n```",
    "pattern": "// ✅ sealed class Result 替代异常 (业务层)\nsealed interface AppResult<out T> {\n    data class Success<T>(val data: T) : AppResult<T>\n    data class Failure(val error: AppError) : AppResult<Nothing>\n}\n\nsealed class AppError {\n    data class NotFound(val resource: String) : AppError()\n    data class Validation(val field: String, val message: String) : AppError()\n    data class Network(val cause: Throwable) : AppError()\n}\n\n// ✅ runCatching — stdlib 的 Result 封装\nval result: Result<User> = runCatching { api.getUser(id) }\nresult\n    .onSuccess { user -> display(user) }\n    .onFailure { error -> log.error(\"Failed\", error) }\n\n// ✅ getOrElse / getOrDefault\nval user = runCatching { api.getUser(id) }\n    .getOrElse { User.anonymous() }\n\n// ✅ 异常仅用于真正异常情况\nfun parseAge(input: String): Int {\n    return input.toIntOrNull()\n        ?: throw ValidationException(\"Invalid age: $input\")\n}\n\n// ❌ 不要吞掉 CancellationException\ntry {\n    suspendFunction()\n} catch (e: Exception) {\n    // ⚠️ 如果 e 是 CancellationException，必须重新抛出\n    if (e is CancellationException) throw e\n    handleError(e)\n}",
    "rationale": "Kotlin: 错误处理模式的标准实现模式。"
  },
  "description": "Kotlin: 错误处理模式",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 错误处理模式的标准实现模式。",
  "antiPattern": {
    "bad": "try { ... } catch (e: Exception) { /* ignore */ }",
    "why": "吞掉 CancellationException 破坏协程取消机制",
    "fix": "捕获具体异常，或重新抛出 CancellationException"
  },
  "reasoning": {
    "whyStandard": "Kotlin 偏向 sealed class Result 处理预期错误; 异常留给真正异常情况",
    "sources": [
      "Kotlin Result",
      "Effective Kotlin Item 7"
    ],
    "confidence": 0.9
  }
}
```

---

## 13. inline / reified

```json
{
  "title": "Kotlin: inline 函数与 reified 类型参数",
  "content": {
    "markdown": "## Kotlin: inline 函数与 reified 类型参数\n\n### 标准模式\n```kotlin\n// ✅ inline 消除 lambda 对象分配开销\ninline fun <T> retry(\n    times: Int = 3,\n    block: () -> T,\n): T {\n    var lastException: Exception? = null\n    repeat(times) {\n        try { return block() }\n        catch (e: Exception) { lastException = e }\n    }\n    throw lastException!!\n}\n\n// ✅ reified — 保留泛型类型信息 (仅 inline 函数可用)\ninline fun <reified T> List<*>.filterIsInstance(): List<T> =\n    filter { it is T }.map { it as T }\n\n// ✅ reified + startActivity\ninline fun <reified T : Activity> Context.startActivity(\n    vararg extras: Pair<String, Any?>,\n) {\n    val intent = Intent(this, T::class.java)\n    extras.forEach { (key, value) ->\n        when (value) {\n            is String -> intent.putExtra(key, value)\n            is Int -> intent.putExtra(key, value)\n            is Boolean -> intent.putExtra(key, value)\n        }\n    }\n    startActivity(intent)\n}\n\n// 使用\ncontext.startActivity<DetailActivity>(\n    \"user_id\" to userId,\n    \"show_header\" to true,\n)\n\n// ✅ crossinline — 禁止 non-local return\ninline fun transaction(crossinline block: () -> Unit) {\n    try {\n        begin()\n        block()  // block 不能 return 外层函数\n        commit()\n    } catch (e: Exception) {\n        rollback()\n    }\n}\n\n// ❌ 大型 inline 函数会导致调用点代码膨胀\ninline fun heavyOperation() { /* 100+ 行 */ }  // 不应 inline\n```",
    "pattern": "// ✅ inline 消除 lambda 对象分配开销\ninline fun <T> retry(\n    times: Int = 3,\n    block: () -> T,\n): T {\n    var lastException: Exception? = null\n    repeat(times) {\n        try { return block() }\n        catch (e: Exception) { lastException = e }\n    }\n    throw lastException!!\n}\n\n// ✅ reified — 保留泛型类型信息 (仅 inline 函数可用)\ninline fun <reified T> List<*>.filterIsInstance(): List<T> =\n    filter { it is T }.map { it as T }\n\n// ✅ reified + startActivity\ninline fun <reified T : Activity> Context.startActivity(\n    vararg extras: Pair<String, Any?>,\n) {\n    val intent = Intent(this, T::class.java)\n    extras.forEach { (key, value) ->\n        when (value) {\n            is String -> intent.putExtra(key, value)\n            is Int -> intent.putExtra(key, value)\n            is Boolean -> intent.putExtra(key, value)\n        }\n    }\n    startActivity(intent)\n}\n\n// 使用\ncontext.startActivity<DetailActivity>(\n    \"user_id\" to userId,\n    \"show_header\" to true,\n)\n\n// ✅ crossinline — 禁止 non-local return\ninline fun transaction(crossinline block: () -> Unit) {\n    try {\n        begin()\n        block()  // block 不能 return 外层函数\n        commit()\n    } catch (e: Exception) {\n        rollback()\n    }\n}\n\n// ❌ 大型 inline 函数会导致调用点代码膨胀\ninline fun heavyOperation() { /* 100+ 行 */ }  // 不应 inline",
    "rationale": "inline 消除高阶函数开销; reified 是 Kotlin 独有能力，突破 JVM 类型擦除"
  },
  "description": "Kotlin: inline 函数与 reified 类型参数",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: inline 函数与 reified 类型参数的标准实现模式。",
  "reasoning": {
    "whyStandard": "Kotlin Docs - Inline Functions; Effective Kotlin Item 46-48",
    "sources": [
      "Kotlin Docs - Inline Functions",
      "Effective Kotlin"
    ],
    "confidence": 0.9
  }
}
```

---

## 14. 测试模式

```json
{
  "title": "Kotlin: 测试最佳实践 (JUnit 5 + Coroutines)",
  "content": {
    "markdown": "## Kotlin: 测试最佳实践 (JUnit 5 + Coroutines)\n\n### 标准模式\n```kotlin\n// ✅ 描述性测试方法名（反引号语法）\nclass UserServiceTest {\n\n    private val mockRepo = mockk<UserRepository>()\n    private val service = UserService(mockRepo)\n\n    @Test\n    fun `findById returns user when exists`() {\n        // Given\n        val user = User(1L, \"Alice\", \"alice@test.com\")\n        every { mockRepo.findById(1L) } returns user\n\n        // When\n        val result = service.findById(1L)\n\n        // Then\n        assertThat(result).isEqualTo(user)\n        verify(exactly = 1) { mockRepo.findById(1L) }\n    }\n\n    @Test\n    fun `findById throws when not found`() {\n        every { mockRepo.findById(99L) } returns null\n\n        assertThrows<NotFoundException> {\n            service.findById(99L)\n        }\n    }\n}\n\n// ✅ 协程测试 (kotlinx-coroutines-test)\nclass UserViewModelTest {\n\n    @Test\n    fun `loadUsers updates state`() = runTest {\n        val repo = FakeUserRepository()\n        val viewModel = UserViewModel(repo)\n\n        viewModel.loadUsers()\n        advanceUntilIdle()  // 等待协程完成\n\n        assertThat(viewModel.uiState.value)\n            .isInstanceOf(UiState.Success::class.java)\n    }\n}\n\n// ✅ Turbine 测试 Flow\n@Test\nfun `observeUsers emits updates`() = runTest {\n    val flow = repo.observeUsers()\n    flow.test {\n        assertThat(awaitItem()).isEmpty()\n        repo.insert(user)\n        assertThat(awaitItem()).containsExactly(user)\n        cancelAndIgnoreRemainingEvents()\n    }\n}\n```",
    "pattern": "// ✅ 描述性测试方法名（反引号语法）\nclass UserServiceTest {\n\n    private val mockRepo = mockk<UserRepository>()\n    private val service = UserService(mockRepo)\n\n    @Test\n    fun `findById returns user when exists`() {\n        // Given\n        val user = User(1L, \"Alice\", \"alice@test.com\")\n        every { mockRepo.findById(1L) } returns user\n\n        // When\n        val result = service.findById(1L)\n\n        // Then\n        assertThat(result).isEqualTo(user)\n        verify(exactly = 1) { mockRepo.findById(1L) }\n    }\n\n    @Test\n    fun `findById throws when not found`() {\n        every { mockRepo.findById(99L) } returns null\n\n        assertThrows<NotFoundException> {\n            service.findById(99L)\n        }\n    }\n}\n\n// ✅ 协程测试 (kotlinx-coroutines-test)\nclass UserViewModelTest {\n\n    @Test\n    fun `loadUsers updates state`() = runTest {\n        val repo = FakeUserRepository()\n        val viewModel = UserViewModel(repo)\n\n        viewModel.loadUsers()\n        advanceUntilIdle()  // 等待协程完成\n\n        assertThat(viewModel.uiState.value)\n            .isInstanceOf(UiState.Success::class.java)\n    }\n}\n\n// ✅ Turbine 测试 Flow\n@Test\nfun `observeUsers emits updates`() = runTest {\n    val flow = repo.observeUsers()\n    flow.test {\n        assertThat(awaitItem()).isEmpty()\n        repo.insert(user)\n        assertThat(awaitItem()).containsExactly(user)\n        cancelAndIgnoreRemainingEvents()\n    }\n}",
    "rationale": "runTest 确保协程在测试中可控; Turbine 是 Flow 测试的事实标准"
  },
  "description": "Kotlin: 测试最佳实践 (JUnit 5 + Coroutines)",
  "kind": "pattern",
  "doClause": "Apply the Kotlin pattern as described",
  "language": "kotlin",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Kotlin: 测试最佳实践 (JUnit 5 + Coroutines)的标准实现模式。",
  "reasoning": {
    "whyStandard": "kotlinx-coroutines-test + Turbine 是 Android 官方推荐测试方案",
    "sources": [
      "Kotlin Coroutines Testing",
      "Turbine Docs"
    ],
    "confidence": 0.9
  }
}
```

### 测试反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `runBlocking` 测试协程 | 无法控制 Dispatchers | `runTest` |
| `Thread.sleep(1000)` | 脆弱、慢 | `advanceUntilIdle()` |
| 测试使用真实网络 | 不稳定、慢 | 使用 `FakeRepository` 或 MockWebServer |
| 未验证 StateFlow 初始值 | 遗漏边界情况 | 用 Turbine 依次验证每个 emission |

---

## 15. Kotlin 特有维度 (extraDimensions)

冷启动分析 Kotlin 项目时，除了通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **空安全** | `!!` 使用率、nullable vs non-null 比例、require/check | `code-standard` |
| **协程模式** | CoroutineScope 管理、Dispatchers 使用、结构化并发 | `code-pattern` |
| **Flow/状态** | StateFlow, SharedFlow, stateIn, collectAsState | `code-pattern` |
| **数据建模** | data class, sealed class/interface, value class | `code-pattern` |
| **Compose** | 状态提升、remember、LaunchedEffect、副作用管理 | `code-pattern` |
| **委托** | by lazy, by viewModels, 自定义委托 | `code-pattern` |
| **扩展函数** | 合理使用 vs 滥用、scope function 嵌套深度 | `best-practice` |
| **多平台** | expect/actual, commonMain, KMP 库选择 | `architecture` |
| **Gradle** | Kotlin DSL (build.gradle.kts), 版本目录 | `config` |

---

## 关联 Skills

- **autosnippet-coldstart**: 冷启动分析模板
- **autosnippet-reference-java**: Java 业界最佳实践参考
- **autosnippet-reference-python**: Python 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
