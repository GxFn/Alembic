---
name: autosnippet-reference-java
description: Java 业界最佳实践参考。涵盖 OOP 设计、泛型、Optional、注解、异常处理、并发、Stream API、Record、不可变性、命名约定，为冷启动分析提供高质量参考标准。
---

# Java 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 Java 项目时，请参考以下业界标准产出高质量候选。
> **来源**: Google Java Style Guide, Effective Java 3rd Ed. (Bloch), Spring Framework Best Practices, JEP/JDK Release Notes

---

## 1. 包结构与导入

### 核心规则

```json
{
  "title": "Java: 按功能分包 + 导入规范",
  "content": {
    "markdown": "## Java: 按功能分包 + 导入规范\n\n### 标准模式\n```java\n// ✅ 按功能分包 (Feature-based, 推荐)\ncom.example.app\n├── user/\n│   ├── UserController.java\n│   ├── UserService.java\n│   ├── UserRepository.java\n│   └── UserDto.java\n├── order/\n│   ├── OrderController.java\n│   └── OrderService.java\n└── common/\n    ├── exception/\n    └── config/\n\n// ❌ 按层分包 (Layer-based, 不推荐)\ncom.example.app\n├── controller/  // 所有 controller 混在一起\n├── service/\n├── repository/\n└── dto/\n\n// ✅ 导入规范 (Google Java Style §3.3)\nimport com.example.app.user.User;      // 具体类导入\nimport java.util.List;                  // 标准库\nimport java.util.Optional;\n\n// ❌ 不要使用通配符导入\nimport java.util.*;  // 隐式依赖，合并冲突风险\n\n// ❌ 不要导入未使用的类\nimport java.io.File;  // unused → 删除\n```",
    "pattern": "// ✅ 按功能分包 (Feature-based, 推荐)\ncom.example.app\n├── user/\n│   ├── UserController.java\n│   ├── UserService.java\n│   ├── UserRepository.java\n│   └── UserDto.java\n├── order/\n│   ├── OrderController.java\n│   └── OrderService.java\n└── common/\n    ├── exception/\n    └── config/\n\n// ❌ 按层分包 (Layer-based, 不推荐)\ncom.example.app\n├── controller/  // 所有 controller 混在一起\n├── service/\n├── repository/\n└── dto/\n\n// ✅ 导入规范 (Google Java Style §3.3)\nimport com.example.app.user.User;      // 具体类导入\nimport java.util.List;                  // 标准库\nimport java.util.Optional;\n\n// ❌ 不要使用通配符导入\nimport java.util.*;  // 隐式依赖，合并冲突风险\n\n// ❌ 不要导入未使用的类\nimport java.io.File;  // unused → 删除",
    "rationale": "按功能分包提高内聚性，便于模块化拆分和团队协作"
  },
  "description": "Java: 按功能分包 + 导入规范",
  "kind": "fact",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "architecture",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: 按功能分包 + 导入规范的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "import java.util.*;  // 通配符导入",
    "why": "隐式依赖，IDE 重构时丢失引用；合并冲突难解决",
    "fix": "逐个导入需要的类：import java.util.List;"
  },
  "reasoning": {
    "whyStandard": "Clean Architecture + Google Java Style Guide §3.3",
    "sources": [
      "Clean Architecture",
      "Google Java Style Guide §3.3"
    ],
    "confidence": 0.9
  }
}
```

---

## 2. 命名约定

```json
{
  "title": "Java: Google Java Style 命名约定",
  "content": {
    "markdown": "## Java: Google Java Style 命名约定\n\n### 标准模式\n```java\n// ✅ 类名: UpperCamelCase\npublic class UserService { }\npublic interface UserRepository { }\npublic enum OrderStatus { PENDING, CONFIRMED, SHIPPED }\n\n// ✅ 方法/变量: lowerCamelCase\npublic User findUserById(long userId) { ... }\nint maxRetryCount = 3;\n\n// ✅ 常量: UPPER_SNAKE_CASE (static final 不可变)\npublic static final int MAX_CONNECTIONS = 100;\npublic static final String DEFAULT_CHARSET = \"UTF-8\";\n\n// ✅ 包名: 全小写，无下划线\npackage com.example.userservice;\n\n// ✅ 泛型参数: 单大写字母或有意义名称 + T\npublic class Response<T> { }\npublic interface Converter<InputT, OutputT> { }\n\n// ✅ 测试方法: 可用下划线增强可读性\nvoid givenInvalidInput_whenValidate_thenThrows() { }\n```",
    "pattern": "// ✅ 类名: UpperCamelCase\npublic class UserService { }\npublic interface UserRepository { }\npublic enum OrderStatus { PENDING, CONFIRMED, SHIPPED }\n\n// ✅ 方法/变量: lowerCamelCase\npublic User findUserById(long userId) { ... }\nint maxRetryCount = 3;\n\n// ✅ 常量: UPPER_SNAKE_CASE (static final 不可变)\npublic static final int MAX_CONNECTIONS = 100;\npublic static final String DEFAULT_CHARSET = \"UTF-8\";\n\n// ✅ 包名: 全小写，无下划线\npackage com.example.userservice;\n\n// ✅ 泛型参数: 单大写字母或有意义名称 + T\npublic class Response<T> { }\npublic interface Converter<InputT, OutputT> { }\n\n// ✅ 测试方法: 可用下划线增强可读性\nvoid givenInvalidInput_whenValidate_thenThrows() { }",
    "rationale": "统一的命名约定降低团队认知负担，提升代码可预测性"
  },
  "description": "Java: Google Java Style 命名约定",
  "kind": "rule",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: Google Java Style 命名约定的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Java Style Guide §5",
    "sources": [
      "Google Java Style Guide §5"
    ],
    "confidence": 0.95
  }
}
```

### 命名速查表

| 标识符类型 | 风格 | 示例 |
|-----------|------|------|
| 类/接口/枚举 | `UpperCamelCase` | `UserService`, `Runnable` |
| 方法 | `lowerCamelCase` | `findUserById()` |
| 局部变量/参数 | `lowerCamelCase` | `maxRetryCount` |
| 常量 (`static final`) | `UPPER_SNAKE_CASE` | `MAX_CONNECTIONS` |
| 包 | 全小写 | `com.example.userservice` |
| 泛型参数 | 单字母或 `XxxT` | `T`, `InputT` |
| 枚举值 | `UPPER_SNAKE_CASE` | `PENDING`, `CONFIRMED` |

### 命名反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `IUserService` (I 前缀) | 非 Java 约定（C# 风格） | `UserService` |
| `UserServiceImpl` (唯一实现) | 无意义后缀 | `DefaultUserService` 或直接 `UserService` |
| `userDTO` (缩写大小写不一致) | Google Style: 缩写视为普通词 | `UserDto` |
| `m_field` / `s_field` | 匈牙利标记 | 直接 `field` |
| `getData()` 返回 void | 方法名暗示返回值 | `loadData()` 或 `fetchData()` |

---

## 3. 接口与抽象类

```json
{
  "title": "Java: 面向接口编程 + sealed interface (17+)",
  "content": {
    "markdown": "## Java: 面向接口编程 + sealed interface (17+)\n\n### 标准模式\n```java\n// ✅ 定义接口约定行为\npublic interface UserRepository {\n    Optional<User> findById(long id);\n    List<User> findByName(String name);\n    User save(User user);\n    void deleteById(long id);\n}\n\n// ✅ 实现类命名: 按实现方式而非 Impl 后缀\npublic class JpaUserRepository implements UserRepository {\n    @Override\n    public Optional<User> findById(long id) { ... }\n}\n\n// ✅ 使用接口类型声明依赖\n@Service\npublic class UserService {\n    private final UserRepository userRepository;\n\n    public UserService(UserRepository userRepository) {\n        this.userRepository = userRepository;\n    }\n}\n\n// ✅ sealed interface (Java 17+) — 受限实现\npublic sealed interface Shape\n    permits Circle, Rectangle, Triangle {\n    double area();\n}\n\npublic record Circle(double radius) implements Shape {\n    @Override public double area() { return Math.PI * radius * radius; }\n}\n\n// ✅ pattern matching (Java 21+)\ndouble area = switch (shape) {\n    case Circle c    -> Math.PI * c.radius() * c.radius();\n    case Rectangle r -> r.width() * r.height();\n    case Triangle t  -> 0.5 * t.base() * t.height();\n};\n```",
    "pattern": "// ✅ 定义接口约定行为\npublic interface UserRepository {\n    Optional<User> findById(long id);\n    List<User> findByName(String name);\n    User save(User user);\n    void deleteById(long id);\n}\n\n// ✅ 实现类命名: 按实现方式而非 Impl 后缀\npublic class JpaUserRepository implements UserRepository {\n    @Override\n    public Optional<User> findById(long id) { ... }\n}\n\n// ✅ 使用接口类型声明依赖\n@Service\npublic class UserService {\n    private final UserRepository userRepository;\n\n    public UserService(UserRepository userRepository) {\n        this.userRepository = userRepository;\n    }\n}\n\n// ✅ sealed interface (Java 17+) — 受限实现\npublic sealed interface Shape\n    permits Circle, Rectangle, Triangle {\n    double area();\n}\n\npublic record Circle(double radius) implements Shape {\n    @Override public double area() { return Math.PI * radius * radius; }\n}\n\n// ✅ pattern matching (Java 21+)\ndouble area = switch (shape) {\n    case Circle c    -> Math.PI * c.radius() * c.radius();\n    case Rectangle r -> r.width() * r.height();\n    case Triangle t  -> 0.5 * t.base() * t.height();\n};",
    "rationale": "Java: 面向接口编程 + sealed interface (17+)的标准实现模式。"
  },
  "description": "Java: 面向接口编程 + sealed interface (17+)",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: 面向接口编程 + sealed interface (17+)的标准实现模式。",
  "antiPattern": {
    "bad": "public class UserServiceImpl implements UserService { }",
    "why": "如果只有一个实现，接口可能不必要；Impl 后缀不提供语义",
    "fix": "按具体实现命名: JpaUserRepository, InMemoryUserRepository"
  },
  "reasoning": {
    "whyStandard": "Effective Java Item 20: Prefer interfaces to abstract classes",
    "sources": [
      "Effective Java §20",
      "JEP 409 (Sealed Classes)"
    ],
    "confidence": 0.9
  }
}
```

---

## 4. 异常处理

```json
{
  "title": "Java: 异常处理最佳实践",
  "content": {
    "markdown": "## Java: 异常处理最佳实践\n\n### 标准模式\n```java\n// ✅ 自定义异常体系 — unchecked (RuntimeException)\npublic abstract class AppException extends RuntimeException {\n    private final String errorCode;\n    protected AppException(String message, String errorCode) {\n        super(message);\n        this.errorCode = errorCode;\n    }\n    protected AppException(String message, String errorCode, Throwable cause) {\n        super(message, cause);\n        this.errorCode = errorCode;\n    }\n    public String getErrorCode() { return errorCode; }\n}\n\npublic class NotFoundException extends AppException {\n    public NotFoundException(String resource, Object id) {\n        super(resource + \" not found: \" + id, \"NOT_FOUND\");\n    }\n}\n\n// ✅ 精确捕获 + 异常链\ntry {\n    User user = userRepository.findById(id)\n        .orElseThrow(() -> new NotFoundException(\"User\", id));\n} catch (NotFoundException e) {\n    throw e;  // 不要吞掉业务异常\n} catch (DataAccessException e) {\n    log.error(\"Database error for user {}\", id, e);\n    throw new ServiceException(\"Internal error\", \"DB_ERROR\", e);  // 保留 cause\n}\n\n// ✅ try-with-resources\ntry (var conn = dataSource.getConnection();\n     var stmt = conn.prepareStatement(sql)) {\n    return stmt.executeQuery();\n}\n\n// ✅ 多异常捕获 (Java 7+)\ncatch (IOException | SQLException e) {\n    throw new ServiceException(\"IO/DB failure\", e);\n}\n```",
    "pattern": "// ✅ 自定义异常体系 — unchecked (RuntimeException)\npublic abstract class AppException extends RuntimeException {\n    private final String errorCode;\n    protected AppException(String message, String errorCode) {\n        super(message);\n        this.errorCode = errorCode;\n    }\n    protected AppException(String message, String errorCode, Throwable cause) {\n        super(message, cause);\n        this.errorCode = errorCode;\n    }\n    public String getErrorCode() { return errorCode; }\n}\n\npublic class NotFoundException extends AppException {\n    public NotFoundException(String resource, Object id) {\n        super(resource + \" not found: \" + id, \"NOT_FOUND\");\n    }\n}\n\n// ✅ 精确捕获 + 异常链\ntry {\n    User user = userRepository.findById(id)\n        .orElseThrow(() -> new NotFoundException(\"User\", id));\n} catch (NotFoundException e) {\n    throw e;  // 不要吞掉业务异常\n} catch (DataAccessException e) {\n    log.error(\"Database error for user {}\", id, e);\n    throw new ServiceException(\"Internal error\", \"DB_ERROR\", e);  // 保留 cause\n}\n\n// ✅ try-with-resources\ntry (var conn = dataSource.getConnection();\n     var stmt = conn.prepareStatement(sql)) {\n    return stmt.executeQuery();\n}\n\n// ✅ 多异常捕获 (Java 7+)\ncatch (IOException | SQLException e) {\n    throw new ServiceException(\"IO/DB failure\", e);\n}",
    "rationale": "Java: 异常处理最佳实践的标准实现模式。"
  },
  "description": "Java: 异常处理最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: 异常处理最佳实践的标准实现模式。",
  "antiPattern": {
    "bad": "catch (Exception e) { log.error(e); return null; }",
    "why": "吞掉异常并返回 null → 下游 NPE，难以追踪根因",
    "fix": "精确捕获，保留异常链传播上层"
  },
  "reasoning": {
    "whyStandard": "Effective Java §69-77; Google Java Style Guide §6.2",
    "sources": [
      "Effective Java §69-77",
      "Google Java Style Guide"
    ],
    "confidence": 0.95
  }
}
```

### 异常处理反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `catch (Exception e) {}` | 空 catch 吞掉所有错误 | 至少 log 或 rethrow |
| `catch (Throwable t)` | 捕获 Error (OOM 等) | `catch (Exception e)` |
| `throws Exception` | 调用方无法精确处理 | 声明具体异常类型 |
| 异常做流程控制 | 性能差，语义不清 | 用条件判断替代 |
| `e.printStackTrace()` | 生产环境日志不规范 | `log.error("msg", e)` |
| 每层重新包装 | 异常链过深 | 只在层边界转换异常类型 |

---

## 5. 注解与依赖注入

```json
{
  "title": "Java: 构造函数注入 > 字段注入",
  "content": {
    "markdown": "## Java: 构造函数注入 > 字段注入\n\n### 标准模式\n```java\n// ✅ 构造函数注入（推荐，不可变依赖）\n@Service\npublic class OrderService {\n    private final UserRepository userRepo;\n    private final PaymentGateway gateway;\n\n    // Spring 4.3+: 单构造函数可省略 @Autowired\n    public OrderService(UserRepository userRepo, PaymentGateway gateway) {\n        this.userRepo = Objects.requireNonNull(userRepo);\n        this.gateway = Objects.requireNonNull(gateway);\n    }\n}\n\n// ✅ Lombok 简化（团队统一使用时）\n@Service\n@RequiredArgsConstructor\npublic class OrderService {\n    private final UserRepository userRepo;\n    private final PaymentGateway gateway;\n}\n\n// ❌ 字段注入（不推荐）\n@Service\npublic class OrderService {\n    @Autowired\n    private UserRepository userRepo;  // 不可测试、隐式依赖、反射注入\n}\n\n// ✅ 自定义注解组合\n@Target(ElementType.TYPE)\n@Retention(RetentionPolicy.RUNTIME)\n@Service\n@Transactional(readOnly = true)\npublic @interface ReadOnlyService { }\n```",
    "pattern": "// ✅ 构造函数注入（推荐，不可变依赖）\n@Service\npublic class OrderService {\n    private final UserRepository userRepo;\n    private final PaymentGateway gateway;\n\n    // Spring 4.3+: 单构造函数可省略 @Autowired\n    public OrderService(UserRepository userRepo, PaymentGateway gateway) {\n        this.userRepo = Objects.requireNonNull(userRepo);\n        this.gateway = Objects.requireNonNull(gateway);\n    }\n}\n\n// ✅ Lombok 简化（团队统一使用时）\n@Service\n@RequiredArgsConstructor\npublic class OrderService {\n    private final UserRepository userRepo;\n    private final PaymentGateway gateway;\n}\n\n// ❌ 字段注入（不推荐）\n@Service\npublic class OrderService {\n    @Autowired\n    private UserRepository userRepo;  // 不可测试、隐式依赖、反射注入\n}\n\n// ✅ 自定义注解组合\n@Target(ElementType.TYPE)\n@Retention(RetentionPolicy.RUNTIME)\n@Service\n@Transactional(readOnly = true)\npublic @interface ReadOnlyService { }",
    "rationale": "Java: 构造函数注入 > 字段注入的标准实现模式。"
  },
  "description": "Java: 构造函数注入 > 字段注入",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: 构造函数注入 > 字段注入的标准实现模式。",
  "antiPattern": {
    "bad": "@Autowired private UserRepository userRepo;",
    "why": "字段注入: 无法 final、难以单元测试、隐藏依赖数量",
    "fix": "构造函数注入 + final 字段"
  },
  "reasoning": {
    "whyStandard": "Spring 官方文档推荐构造函数注入; Effective Java §17",
    "sources": [
      "Spring Docs - DI",
      "Effective Java §17"
    ],
    "confidence": 0.95
  }
}
```

---

## 6. 泛型 (Generics)

```json
{
  "title": "Java: 泛型最佳实践",
  "content": {
    "markdown": "## Java: 泛型最佳实践\n\n### 标准模式\n```java\n// ✅ 类型安全的泛型方法\npublic <T extends Comparable<T>> T max(Collection<T> items) {\n    return items.stream()\n        .max(Comparator.naturalOrder())\n        .orElseThrow();\n}\n\n// ✅ 通配符: PECS (Producer Extends, Consumer Super)\npublic <T> void copy(\n    List<? extends T> src,   // producer → extends\n    List<? super T> dest     // consumer → super\n) {\n    for (T item : src) {\n        dest.add(item);\n    }\n}\n\n// ✅ 泛型接口 + 约束\npublic interface Repository<T, ID extends Serializable> {\n    Optional<T> findById(ID id);\n    T save(T entity);\n    void deleteById(ID id);\n}\n\npublic class UserRepository implements Repository<User, Long> {\n    @Override\n    public Optional<User> findById(Long id) { ... }\n}\n\n// ❌ 不要使用原始类型\nList list = new ArrayList();       // raw type\nList<Object> list = new ArrayList<>();  // 至少用 Object\n\n// ❌ 不要对泛型参数用 instanceof\nif (item instanceof T) { }  // 编译错误，类型擦除\n```",
    "pattern": "// ✅ 类型安全的泛型方法\npublic <T extends Comparable<T>> T max(Collection<T> items) {\n    return items.stream()\n        .max(Comparator.naturalOrder())\n        .orElseThrow();\n}\n\n// ✅ 通配符: PECS (Producer Extends, Consumer Super)\npublic <T> void copy(\n    List<? extends T> src,   // producer → extends\n    List<? super T> dest     // consumer → super\n) {\n    for (T item : src) {\n        dest.add(item);\n    }\n}\n\n// ✅ 泛型接口 + 约束\npublic interface Repository<T, ID extends Serializable> {\n    Optional<T> findById(ID id);\n    T save(T entity);\n    void deleteById(ID id);\n}\n\npublic class UserRepository implements Repository<User, Long> {\n    @Override\n    public Optional<User> findById(Long id) { ... }\n}\n\n// ❌ 不要使用原始类型\nList list = new ArrayList();       // raw type\nList<Object> list = new ArrayList<>();  // 至少用 Object\n\n// ❌ 不要对泛型参数用 instanceof\nif (item instanceof T) { }  // 编译错误，类型擦除",
    "rationale": "泛型在编译期保证类型安全，PECS 原则最大化灵活性"
  },
  "description": "Java: 泛型最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: 泛型最佳实践的标准实现模式。",
  "reasoning": {
    "whyStandard": "Effective Java §26-33: 优先使用泛型和通配符",
    "sources": [
      "Effective Java §26-33"
    ],
    "confidence": 0.9
  }
}
```

---

## 7. Optional

```json
{
  "title": "Java: Optional 正确使用 (Effective Java §55)",
  "content": {
    "markdown": "## Java: Optional 正确使用 (Effective Java §55)\n\n### 标准模式\n```java\n// ✅ Optional 作为返回值 — 表示可能缺失\npublic Optional<User> findByEmail(String email) {\n    return Optional.ofNullable(userMap.get(email));\n}\n\n// ✅ 链式处理\nString displayName = findByEmail(email)\n    .map(User::getDisplayName)\n    .orElse(\"Anonymous\");\n\n// ✅ orElseThrow 替代 get()\nUser user = findById(id)\n    .orElseThrow(() -> new NotFoundException(\"User\", id));\n\n// ✅ Java 9+ ifPresentOrElse\nfindByEmail(email).ifPresentOrElse(\n    user -> sendEmail(user),\n    () -> log.warn(\"User not found: {}\", email)\n);\n\n// ✅ Stream 集成 (Java 9+)\nList<User> admins = userIds.stream()\n    .map(this::findById)\n    .flatMap(Optional::stream)  // 过滤空值\n    .toList();\n\n// ❌ 不要做\nOptional<User> user = ...;\nif (user.isPresent()) { user.get(); }  // 等于没用 Optional\n\n// ❌ Optional 作为字段或参数\nprivate Optional<String> name;          // 用 @Nullable String\npublic void setName(Optional<String> n); // 直接 String\n```",
    "pattern": "// ✅ Optional 作为返回值 — 表示可能缺失\npublic Optional<User> findByEmail(String email) {\n    return Optional.ofNullable(userMap.get(email));\n}\n\n// ✅ 链式处理\nString displayName = findByEmail(email)\n    .map(User::getDisplayName)\n    .orElse(\"Anonymous\");\n\n// ✅ orElseThrow 替代 get()\nUser user = findById(id)\n    .orElseThrow(() -> new NotFoundException(\"User\", id));\n\n// ✅ Java 9+ ifPresentOrElse\nfindByEmail(email).ifPresentOrElse(\n    user -> sendEmail(user),\n    () -> log.warn(\"User not found: {}\", email)\n);\n\n// ✅ Stream 集成 (Java 9+)\nList<User> admins = userIds.stream()\n    .map(this::findById)\n    .flatMap(Optional::stream)  // 过滤空值\n    .toList();\n\n// ❌ 不要做\nOptional<User> user = ...;\nif (user.isPresent()) { user.get(); }  // 等于没用 Optional\n\n// ❌ Optional 作为字段或参数\nprivate Optional<String> name;          // 用 @Nullable String\npublic void setName(Optional<String> n); // 直接 String",
    "rationale": "Java: Optional 正确使用 (Effective Java §55)的标准实现模式。"
  },
  "description": "Java: Optional 正确使用 (Effective Java §55)",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: Optional 正确使用 (Effective Java §55)的标准实现模式。",
  "antiPattern": {
    "bad": "if (optional.isPresent()) { return optional.get(); }",
    "why": "Optional 的意义是函数式处理缺失值，isPresent+get 等于回到 null 检查",
    "fix": "optional.map(...).orElse(...) 或 orElseThrow()"
  },
  "reasoning": {
    "whyStandard": "Effective Java §55: Return optionals judiciously",
    "sources": [
      "Effective Java §55"
    ],
    "confidence": 0.95
  }
}
```

---

## 8. Stream API

```json
{
  "title": "Java: Stream API 最佳实践",
  "content": {
    "markdown": "## Java: Stream API 最佳实践\n\n### 标准模式\n```java\n// ✅ 简洁的 Stream 管道\nList<String> activeUserNames = users.stream()\n    .filter(User::isActive)\n    .map(User::getName)\n    .sorted()\n    .toList();  // Java 16+\n\n// ✅ Collectors 常用模式\nMap<Role, List<User>> byRole = users.stream()\n    .collect(Collectors.groupingBy(User::getRole));\n\nString csv = names.stream()\n    .collect(Collectors.joining(\", \"));\n\n// ✅ 方法引用优先于 lambda\n.map(User::getName)      // ✅ 方法引用\n.map(u -> u.getName())   // ❌ 等价但冗余\n\n// ✅ 大数据集使用 parallelStream（谨慎）\nlong count = hugeList.parallelStream()\n    .filter(this::isExpensive)\n    .count();\n\n// ❌ 避免过长链（>5 步拆分）\n// ❌ 避免 Stream 中的副作用\nusers.stream().forEach(u -> u.setActive(true));  // 副作用 → 用 for 循环\n\n// ❌ 不要重用 Stream\nStream<User> s = users.stream();\ns.count(); s.toList(); // IllegalStateException!\n```",
    "pattern": "// ✅ 简洁的 Stream 管道\nList<String> activeUserNames = users.stream()\n    .filter(User::isActive)\n    .map(User::getName)\n    .sorted()\n    .toList();  // Java 16+\n\n// ✅ Collectors 常用模式\nMap<Role, List<User>> byRole = users.stream()\n    .collect(Collectors.groupingBy(User::getRole));\n\nString csv = names.stream()\n    .collect(Collectors.joining(\", \"));\n\n// ✅ 方法引用优先于 lambda\n.map(User::getName)      // ✅ 方法引用\n.map(u -> u.getName())   // ❌ 等价但冗余\n\n// ✅ 大数据集使用 parallelStream（谨慎）\nlong count = hugeList.parallelStream()\n    .filter(this::isExpensive)\n    .count();\n\n// ❌ 避免过长链（>5 步拆分）\n// ❌ 避免 Stream 中的副作用\nusers.stream().forEach(u -> u.setActive(true));  // 副作用 → 用 for 循环\n\n// ❌ 不要重用 Stream\nStream<User> s = users.stream();\ns.count(); s.toList(); // IllegalStateException!",
    "rationale": "Java: Stream API 最佳实践的标准实现模式。"
  },
  "description": "Java: Stream API 最佳实践",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: Stream API 最佳实践的标准实现模式。",
  "antiPattern": {
    "bad": "users.stream().forEach(u -> u.setActive(true));",
    "why": "Stream forEach 中的副作用破坏函数式语义，parallelStream 下更危险",
    "fix": "副作用操作使用传统 for 循环"
  },
  "reasoning": {
    "whyStandard": "Effective Java §45-48: 谨慎使用 Stream",
    "sources": [
      "Effective Java §45-48"
    ],
    "confidence": 0.9
  }
}
```

---

## 9. Record 与不可变性 (Java 16+)

```json
{
  "title": "Java: Record + 不可变设计",
  "content": {
    "markdown": "## Java: Record + 不可变设计\n\n### 标准模式\n```java\n// ✅ Record — 不可变数据载体，自动生成 equals/hashCode/toString\npublic record UserDto(\n    long id,\n    String name,\n    String email,\n    Instant createdAt\n) {\n    // 紧凑构造函数进行校验\n    public UserDto {\n        Objects.requireNonNull(name, \"name must not be null\");\n        Objects.requireNonNull(email, \"email must not be null\");\n    }\n}\n\n// ✅ 泛型 Record\npublic record ApiResponse<T>(boolean success, T data, String message) {\n    public static <T> ApiResponse<T> ok(T data) {\n        return new ApiResponse<>(true, data, null);\n    }\n    public static ApiResponse<Void> error(String msg) {\n        return new ApiResponse<>(false, null, msg);\n    }\n}\n\n// ✅ 不可变类设计 (Effective Java §17)\npublic final class Money {\n    private final BigDecimal amount;\n    private final Currency currency;\n\n    public Money(BigDecimal amount, Currency currency) {\n        this.amount = Objects.requireNonNull(amount);\n        this.currency = Objects.requireNonNull(currency);\n    }\n\n    // 返回新实例而非修改状态\n    public Money add(Money other) {\n        if (!this.currency.equals(other.currency))\n            throw new IllegalArgumentException(\"Currency mismatch\");\n        return new Money(this.amount.add(other.amount), this.currency);\n    }\n\n    // 防御性拷贝集合\n    public List<String> getTags() {\n        return List.copyOf(tags);  // 不可变副本\n    }\n}\n```",
    "pattern": "// ✅ Record — 不可变数据载体，自动生成 equals/hashCode/toString\npublic record UserDto(\n    long id,\n    String name,\n    String email,\n    Instant createdAt\n) {\n    // 紧凑构造函数进行校验\n    public UserDto {\n        Objects.requireNonNull(name, \"name must not be null\");\n        Objects.requireNonNull(email, \"email must not be null\");\n    }\n}\n\n// ✅ 泛型 Record\npublic record ApiResponse<T>(boolean success, T data, String message) {\n    public static <T> ApiResponse<T> ok(T data) {\n        return new ApiResponse<>(true, data, null);\n    }\n    public static ApiResponse<Void> error(String msg) {\n        return new ApiResponse<>(false, null, msg);\n    }\n}\n\n// ✅ 不可变类设计 (Effective Java §17)\npublic final class Money {\n    private final BigDecimal amount;\n    private final Currency currency;\n\n    public Money(BigDecimal amount, Currency currency) {\n        this.amount = Objects.requireNonNull(amount);\n        this.currency = Objects.requireNonNull(currency);\n    }\n\n    // 返回新实例而非修改状态\n    public Money add(Money other) {\n        if (!this.currency.equals(other.currency))\n            throw new IllegalArgumentException(\"Currency mismatch\");\n        return new Money(this.amount.add(other.amount), this.currency);\n    }\n\n    // 防御性拷贝集合\n    public List<String> getTags() {\n        return List.copyOf(tags);  // 不可变副本\n    }\n}",
    "rationale": "不可变对象线程安全、可安全共享、易于推理"
  },
  "description": "Java: Record + 不可变设计",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: Record + 不可变设计的标准实现模式。",
  "reasoning": {
    "whyStandard": "Effective Java §17: Minimize mutability; JEP 395 (Records)",
    "sources": [
      "Effective Java §17",
      "JEP 395"
    ],
    "confidence": 0.9
  }
}
```

---

## 10. 并发与虚拟线程

```json
{
  "title": "Java: 现代并发模式",
  "content": {
    "markdown": "## Java: 现代并发模式\n\n### 标准模式\n```java\n// ✅ CompletableFuture 异步编排\npublic CompletableFuture<Dashboard> loadDashboard(long userId) {\n    var userFuture = CompletableFuture.supplyAsync(\n        () -> userService.findById(userId), executor);\n    var ordersFuture = CompletableFuture.supplyAsync(\n        () -> orderService.findByUser(userId), executor);\n\n    return userFuture.thenCombine(ordersFuture, Dashboard::new)\n        .exceptionally(ex -> {\n            log.error(\"Dashboard load failed\", ex);\n            return Dashboard.empty();\n        });\n}\n\n// ✅ 虚拟线程 (Java 21+, Project Loom)\ntry (var executor = Executors.newVirtualThreadPerTaskExecutor()) {\n    List<Future<User>> futures = userIds.stream()\n        .map(id -> executor.submit(() -> fetchUser(id)))\n        .toList();\n}\n\n// ✅ Structured Concurrency (Java 21 Preview)\ntry (var scope = new StructuredTaskScope.ShutdownOnFailure()) {\n    var userTask = scope.fork(() -> findUser(userId));\n    var ordersTask = scope.fork(() -> findOrders(userId));\n    scope.join().throwIfFailed();\n    return new Dashboard(userTask.get(), ordersTask.get());\n}\n\n// ✅ 线程安全的集合\nMap<String, User> cache = new ConcurrentHashMap<>();\nList<Event> events = new CopyOnWriteArrayList<>();\n\n// ❌ 反模式\nsynchronized (this) { ... }  // 锁范围过大\nnew Thread(() -> ...).start();  // 未管理线程生命周期\n```",
    "pattern": "// ✅ CompletableFuture 异步编排\npublic CompletableFuture<Dashboard> loadDashboard(long userId) {\n    var userFuture = CompletableFuture.supplyAsync(\n        () -> userService.findById(userId), executor);\n    var ordersFuture = CompletableFuture.supplyAsync(\n        () -> orderService.findByUser(userId), executor);\n\n    return userFuture.thenCombine(ordersFuture, Dashboard::new)\n        .exceptionally(ex -> {\n            log.error(\"Dashboard load failed\", ex);\n            return Dashboard.empty();\n        });\n}\n\n// ✅ 虚拟线程 (Java 21+, Project Loom)\ntry (var executor = Executors.newVirtualThreadPerTaskExecutor()) {\n    List<Future<User>> futures = userIds.stream()\n        .map(id -> executor.submit(() -> fetchUser(id)))\n        .toList();\n}\n\n// ✅ Structured Concurrency (Java 21 Preview)\ntry (var scope = new StructuredTaskScope.ShutdownOnFailure()) {\n    var userTask = scope.fork(() -> findUser(userId));\n    var ordersTask = scope.fork(() -> findOrders(userId));\n    scope.join().throwIfFailed();\n    return new Dashboard(userTask.get(), ordersTask.get());\n}\n\n// ✅ 线程安全的集合\nMap<String, User> cache = new ConcurrentHashMap<>();\nList<Event> events = new CopyOnWriteArrayList<>();\n\n// ❌ 反模式\nsynchronized (this) { ... }  // 锁范围过大\nnew Thread(() -> ...).start();  // 未管理线程生命周期",
    "rationale": "Java: 现代并发模式的标准实现模式。"
  },
  "description": "Java: 现代并发模式",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: 现代并发模式的标准实现模式。",
  "reasoning": {
    "whyStandard": "JEP 444 (Virtual Threads), JEP 453 (Structured Concurrency)",
    "sources": [
      "Effective Java §78-84",
      "JEP 444",
      "JEP 453"
    ],
    "confidence": 0.85
  }
}
```

---

## 11. Builder 与工厂模式

```json
{
  "title": "Java: Builder 模式 (Effective Java §2)",
  "content": {
    "markdown": "## Java: Builder 模式 (Effective Java §2)\n\n### 标准模式\n```java\n// ✅ Builder 模式 — 参数多于 4 个时使用\npublic class ServerConfig {\n    private final String host;\n    private final int port;\n    private final int maxConnections;\n    private final Duration timeout;\n    private final boolean ssl;\n\n    private ServerConfig(Builder builder) {\n        this.host = builder.host;\n        this.port = builder.port;\n        this.maxConnections = builder.maxConnections;\n        this.timeout = builder.timeout;\n        this.ssl = builder.ssl;\n    }\n\n    public static class Builder {\n        // 必填\n        private final String host;\n        private final int port;\n        // 可选 + 默认值\n        private int maxConnections = 100;\n        private Duration timeout = Duration.ofSeconds(30);\n        private boolean ssl = false;\n\n        public Builder(String host, int port) {\n            this.host = host;\n            this.port = port;\n        }\n\n        public Builder maxConnections(int val) {\n            this.maxConnections = val; return this;\n        }\n        public Builder timeout(Duration val) {\n            this.timeout = val; return this;\n        }\n        public Builder ssl(boolean val) {\n            this.ssl = val; return this;\n        }\n        public ServerConfig build() {\n            return new ServerConfig(this);\n        }\n    }\n}\n\n// ✅ Lombok @Builder 简化\n@Builder\n@Value  // 不可变\npublic class ServerConfig {\n    String host;\n    int port;\n    @Builder.Default int maxConnections = 100;\n    @Builder.Default Duration timeout = Duration.ofSeconds(30);\n}\n\n// ✅ 静态工厂方法 (Effective Java §1)\npublic static ServerConfig ofLocal(int port) {\n    return new Builder(\"localhost\", port).build();\n}\n```",
    "pattern": "// ✅ Builder 模式 — 参数多于 4 个时使用\npublic class ServerConfig {\n    private final String host;\n    private final int port;\n    private final int maxConnections;\n    private final Duration timeout;\n    private final boolean ssl;\n\n    private ServerConfig(Builder builder) {\n        this.host = builder.host;\n        this.port = builder.port;\n        this.maxConnections = builder.maxConnections;\n        this.timeout = builder.timeout;\n        this.ssl = builder.ssl;\n    }\n\n    public static class Builder {\n        // 必填\n        private final String host;\n        private final int port;\n        // 可选 + 默认值\n        private int maxConnections = 100;\n        private Duration timeout = Duration.ofSeconds(30);\n        private boolean ssl = false;\n\n        public Builder(String host, int port) {\n            this.host = host;\n            this.port = port;\n        }\n\n        public Builder maxConnections(int val) {\n            this.maxConnections = val; return this;\n        }\n        public Builder timeout(Duration val) {\n            this.timeout = val; return this;\n        }\n        public Builder ssl(boolean val) {\n            this.ssl = val; return this;\n        }\n        public ServerConfig build() {\n            return new ServerConfig(this);\n        }\n    }\n}\n\n// ✅ Lombok @Builder 简化\n@Builder\n@Value  // 不可变\npublic class ServerConfig {\n    String host;\n    int port;\n    @Builder.Default int maxConnections = 100;\n    @Builder.Default Duration timeout = Duration.ofSeconds(30);\n}\n\n// ✅ 静态工厂方法 (Effective Java §1)\npublic static ServerConfig ofLocal(int port) {\n    return new Builder(\"localhost\", port).build();\n}",
    "rationale": "Builder 模式提供流畅、可读的对象构建方式，避免需要多种构造函数重载"
  },
  "description": "Java: Builder 模式 (Effective Java §2)",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: Builder 模式 (Effective Java §2)的标准实现模式。",
  "reasoning": {
    "whyStandard": "Effective Java §1-2: 静态工厂 + Builder 模式",
    "sources": [
      "Effective Java §1-2"
    ],
    "confidence": 0.9
  }
}
```

---

## 12. 测试模式

```json
{
  "title": "Java: JUnit 5 + Mockito 测试模式",
  "content": {
    "markdown": "## Java: JUnit 5 + Mockito 测试模式\n\n### 标准模式\n```java\n// ✅ 测试类结构\n@ExtendWith(MockitoExtension.class)\nclass UserServiceTest {\n\n    @Mock\n    private UserRepository userRepository;\n\n    @InjectMocks\n    private UserService userService;\n\n    // ✅ Given-When-Then 结构\n    @Test\n    @DisplayName(\"findById - 存在的用户 - 返回 UserDto\")\n    void findById_existingUser_returnsDto() {\n        // Given\n        var user = new User(1L, \"Alice\", \"alice@test.com\");\n        when(userRepository.findById(1L)).thenReturn(Optional.of(user));\n\n        // When\n        var result = userService.findById(1L);\n\n        // Then\n        assertThat(result)\n            .isNotNull()\n            .extracting(UserDto::name, UserDto::email)\n            .containsExactly(\"Alice\", \"alice@test.com\");\n    }\n\n    // ✅ 异常测试\n    @Test\n    void findById_notFound_throwsException() {\n        when(userRepository.findById(99L)).thenReturn(Optional.empty());\n\n        assertThatThrownBy(() -> userService.findById(99L))\n            .isInstanceOf(NotFoundException.class)\n            .hasMessageContaining(\"99\");\n    }\n\n    // ✅ 参数化测试\n    @ParameterizedTest\n    @CsvSource({\"1,Alice\", \"2,Bob\", \"3,Charlie\"})\n    void findById_variousIds_returnsCorrectName(long id, String name) {\n        when(userRepository.findById(id))\n            .thenReturn(Optional.of(new User(id, name, name + \"@test.com\")));\n        assertThat(userService.findById(id).name()).isEqualTo(name);\n    }\n}\n```",
    "pattern": "// ✅ 测试类结构\n@ExtendWith(MockitoExtension.class)\nclass UserServiceTest {\n\n    @Mock\n    private UserRepository userRepository;\n\n    @InjectMocks\n    private UserService userService;\n\n    // ✅ Given-When-Then 结构\n    @Test\n    @DisplayName(\"findById - 存在的用户 - 返回 UserDto\")\n    void findById_existingUser_returnsDto() {\n        // Given\n        var user = new User(1L, \"Alice\", \"alice@test.com\");\n        when(userRepository.findById(1L)).thenReturn(Optional.of(user));\n\n        // When\n        var result = userService.findById(1L);\n\n        // Then\n        assertThat(result)\n            .isNotNull()\n            .extracting(UserDto::name, UserDto::email)\n            .containsExactly(\"Alice\", \"alice@test.com\");\n    }\n\n    // ✅ 异常测试\n    @Test\n    void findById_notFound_throwsException() {\n        when(userRepository.findById(99L)).thenReturn(Optional.empty());\n\n        assertThatThrownBy(() -> userService.findById(99L))\n            .isInstanceOf(NotFoundException.class)\n            .hasMessageContaining(\"99\");\n    }\n\n    // ✅ 参数化测试\n    @ParameterizedTest\n    @CsvSource({\"1,Alice\", \"2,Bob\", \"3,Charlie\"})\n    void findById_variousIds_returnsCorrectName(long id, String name) {\n        when(userRepository.findById(id))\n            .thenReturn(Optional.of(new User(id, name, name + \"@test.com\")));\n        assertThat(userService.findById(id).name()).isEqualTo(name);\n    }\n}",
    "rationale": "Given-When-Then 结构清晰; AssertJ 流式断言可读性高; 参数化减少重复"
  },
  "description": "Java: JUnit 5 + Mockito 测试模式",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: JUnit 5 + Mockito 测试模式的标准实现模式。",
  "reasoning": {
    "whyStandard": "JUnit 5 Best Practices + Spring Test 官方指南",
    "sources": [
      "JUnit 5 User Guide",
      "Spring Testing Docs"
    ],
    "confidence": 0.9
  }
}
```

---

## 13. 字符串与文本块

```json
{
  "title": "Java: Text Blocks + 字符串处理 (Java 15+)",
  "content": {
    "markdown": "## Java: Text Blocks + 字符串处理 (Java 15+)\n\n### 标准模式\n```java\n// ✅ Text Block — 多行字符串 (Java 15+)\nString json = \"\"\"\n        {\n            \"name\": \"%s\",\n            \"age\": %d\n        }\n        \"\"\".formatted(name, age);\n\n// ✅ String.formatted() 替代 String.format()\nString msg = \"User %s (id=%d) created\".formatted(name, id);\n\n// ✅ StringBuilder 拼接大量字符串\nvar sb = new StringBuilder(256);\nfor (var item : items) {\n    sb.append(item.name()).append(\", \");\n}\n\n// ✅ String.join / Collectors.joining\nString csv = String.join(\", \", names);\nString csv2 = names.stream().collect(Collectors.joining(\", \", \"[\", \"]\"));\n\n// ❌ 循环中用 + 拼接字符串\nString result = \"\";\nfor (var s : list) { result += s; }  // O(n²)\n```",
    "pattern": "// ✅ Text Block — 多行字符串 (Java 15+)\nString json = \"\"\"\n        {\n            \"name\": \"%s\",\n            \"age\": %d\n        }\n        \"\"\".formatted(name, age);\n\n// ✅ String.formatted() 替代 String.format()\nString msg = \"User %s (id=%d) created\".formatted(name, id);\n\n// ✅ StringBuilder 拼接大量字符串\nvar sb = new StringBuilder(256);\nfor (var item : items) {\n    sb.append(item.name()).append(\", \");\n}\n\n// ✅ String.join / Collectors.joining\nString csv = String.join(\", \", names);\nString csv2 = names.stream().collect(Collectors.joining(\", \", \"[\", \"]\"));\n\n// ❌ 循环中用 + 拼接字符串\nString result = \"\";\nfor (var s : list) { result += s; }  // O(n²)",
    "rationale": "Java: Text Blocks + 字符串处理 (Java 15+)的标准实现模式。"
  },
  "description": "Java: Text Blocks + 字符串处理 (Java 15+)",
  "kind": "pattern",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: Text Blocks + 字符串处理 (Java 15+)的标准实现模式。",
  "antiPattern": {
    "bad": "String result = \"\"; for (s : list) result += s;",
    "why": "String 不可变，每次 + 创建新对象，O(n²) 性能",
    "fix": "StringBuilder 或 String.join / Collectors.joining"
  },
  "reasoning": {
    "whyStandard": "JEP 378 (Text Blocks); Effective Java §63",
    "sources": [
      "JEP 378",
      "Effective Java §63"
    ],
    "confidence": 0.9
  }
}
```

---

## 14. Javadoc 规范

```json
{
  "title": "Java: Javadoc 规范 (Google Java Style §7)",
  "content": {
    "markdown": "## Java: Javadoc 规范 (Google Java Style §7)\n\n### 标准模式\n```java\n/**\n * 用户服务，提供用户的 CRUD 操作。\n *\n * <p>所有方法都是线程安全的。使用构造函数注入依赖。\n *\n * @since 2.0\n * @author team-backend\n */\n@Service\npublic class UserService {\n\n    /**\n     * 按 ID 查找用户。\n     *\n     * <p>如果用户不存在则抛出 {@link NotFoundException}。\n     *\n     * @param id 用户的唯一标识符，必须大于 0\n     * @return 找到的用户实体，不为 null\n     * @throws NotFoundException 如果用户不存在\n     * @throws IllegalArgumentException 如果 id <= 0\n     */\n    public User findById(long id) {\n        if (id <= 0) throw new IllegalArgumentException(\"id must be > 0\");\n        return userRepository.findById(id)\n            .orElseThrow(() -> new NotFoundException(\"User\", id));\n    }\n}\n```",
    "pattern": "/**\n * 用户服务，提供用户的 CRUD 操作。\n *\n * <p>所有方法都是线程安全的。使用构造函数注入依赖。\n *\n * @since 2.0\n * @author team-backend\n */\n@Service\npublic class UserService {\n\n    /**\n     * 按 ID 查找用户。\n     *\n     * <p>如果用户不存在则抛出 {@link NotFoundException}。\n     *\n     * @param id 用户的唯一标识符，必须大于 0\n     * @return 找到的用户实体，不为 null\n     * @throws NotFoundException 如果用户不存在\n     * @throws IllegalArgumentException 如果 id <= 0\n     */\n    public User findById(long id) {\n        if (id <= 0) throw new IllegalArgumentException(\"id must be > 0\");\n        return userRepository.findById(id)\n            .orElseThrow(() -> new NotFoundException(\"User\", id));\n    }\n}",
    "rationale": "Javadoc 是 Java 生态的标准文档方式，@param/@return/@throws 提供完整 API 契约"
  },
  "description": "Java: Javadoc 规范 (Google Java Style §7)",
  "kind": "rule",
  "doClause": "Apply the Java pattern as described",
  "language": "java",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取Java: Javadoc 规范 (Google Java Style §7)的标准实现模式。",
  "reasoning": {
    "whyStandard": "Google Java Style Guide §7; 所有 public API 必须有 Javadoc",
    "sources": [
      "Google Java Style Guide §7"
    ],
    "confidence": 0.95
  }
}
```

### Javadoc 反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `/** Gets the name. */` | 重复方法名，无额外信息 | 描述行为、边界和异常 |
| 缺少 `@throws` | 调用方不知道可能的异常 | 列出所有非检查异常 |
| `@param id id` | 参数解释等于没有 | `@param id 用户唯一标识符，必须大于 0` |
| private 方法写 Javadoc | 过度文档化 | 代码自解释 + 行内注释 |

---

## 15. Java 特有维度 (extraDimensions)

冷启动分析 Java 项目时，除了通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **Java 版本特性** | Record, sealed class, pattern matching, 虚拟线程 | `code-pattern` |
| **不可变设计** | final class/field, 防御性拷贝, Immutables/Lombok @Value | `best-practice` |
| **泛型使用** | PECS, 有界通配符, 泛型方法 vs 泛型类 | `code-pattern` |
| **Optional** | 返回值 Optional, 避免 isPresent+get, stream 集成 | `best-practice` |
| **并发模式** | CompletableFuture, VirtualThread, ConcurrentHashMap | `code-pattern` |
| **框架模式** | Spring Boot autoconfiguration, DI, AOP | `architecture` |
| **构建工具** | Maven/Gradle, 多模块, BOM 依赖管理 | `config` |
| **测试** | JUnit 5, Mockito, TestContainers, Spring Boot Test | `best-practice` |

---

## 关联 Skills

- **autosnippet-coldstart**: 冷启动分析模板
- **autosnippet-reference-kotlin**: Kotlin 业界最佳实践参考
- **autosnippet-reference-python**: Python 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
