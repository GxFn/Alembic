# Guard 规范检查系统

Guard 是 Alembic 的代码规范检查引擎，提供 50+ 内置规则，支持正则匹配、AST 语义分析和跨文件检查。

---

## 概述

Guard 系统的核心组件：

| 组件 | 职责 |
|------|------|
| `GuardService` | Guard 服务入口，协调各组件 |
| `GuardCheckEngine` | 规则引擎核心（1765 行），内置 50+ 规则 |
| `SourceFileCollector` | 源文件收集（按扩展名、gitignore、排除规则） |
| `ExclusionManager` | 排除规则管理（路径、文件、规则级别） |
| `ComplianceReporter` | 合规报告生成（JSON / Text / Markdown） |
| `ViolationsStore` | 违规记录持久化 |
| `RuleLearner` | 基于 Recipe 自动学习新规则 |
| `GuardFeedbackLoop` | 反馈闭环（误报/漏报收集） |

---

## 使用方式

### CLI

```bash
# 检查单个文件
alembic guard src/utils/helper.ts

# 检查整个项目（CI 模式）
alembic guard:ci --report markdown --output guard-report.md

# 检查 git staged 文件（pre-commit）
alembic guard:staged
```

### 文件指令

在源代码中添加指令，VS Code 扩展或 `alembic watch` 自动触发：

```javascript
// as:a  ← 对当前文件运行 Guard 审计
```

### MCP 工具

AI 助手通过 `alembic_guard` 工具调用：

```json
{
  "tool": "alembic_guard",
  "arguments": {
    "files": ["src/utils/helper.ts"],
    "scope": "file"
  }
}
```

---

## 规则分类

### 按检查维度

| 维度 | 说明 | 示例 |
|------|------|------|
| `file` | 单文件内检查 | 正则匹配、代码级检查 |
| `target` | 模块/Target 级检查 | 跨文件依赖分析 |
| `project` | 全项目检查 | 循环依赖、命名冲突 |

### 按严重级别

| 级别 | 描述 | CI 行为 |
|------|------|--------|
| `error` | 严重问题，必须修复 | 默认阻断（`--fail-on-error`） |
| `warning` | 潜在问题，建议修复 | 超过阈值阻断（`--max-warnings`） |
| `info` | 建议优化 | 仅报告 |

### 按分类

| 分类 | 说明 |
|------|------|
| `correctness` | 正确性（逻辑错误、死锁、资源泄露） |
| `safety` | 安全性（eval、exec、注入风险） |
| `style` | 代码风格（命名、格式约定） |
| `performance` | 性能（不必要的拷贝、循环中的分配） |

---

## 内置规则速查

### Objective-C / Swift

| 规则 ID | 描述 | 级别 |
|---------|------|------|
| `no-main-thread-sync` | `dispatch_sync(dispatch_get_main_queue())` 死锁 | error |
| `main-thread-sync-swift` | `DispatchQueue.main.sync` 死锁 | error |
| `objc-dealloc-async` | `dealloc` 内禁用 `dispatch_async` 等 | error |
| `objc-block-retain-cycle` | block 内直接使用 `self`（循环引用） | warning |
| `objc-assign-object` | `assign` 用于对象类型属性 | warning |
| `swift-force-cast` | `as!` 强制类型转换 | warning |
| `swift-force-try` | `try!` 强制 try | warning |
| `objc-timer-retain-cycle` | `NSTimer` 的 `self` 强引用 | warning |
| `objc-possible-main-thread-blocking` | `sleep` / `usleep` 主线程阻塞 | warning |

### JavaScript / TypeScript

| 规则 ID | 描述 | 级别 |
|---------|------|------|
| `js-no-eval` | `eval()` 使用 | error |
| `js-no-debugger` | `debugger` 语句 | error |
| `js-no-var` | `var` 声明（应使用 `let`/`const`） | warning |
| `js-no-alert` | `alert()` 调用 | warning |
| `ts-no-non-null-assertion` | `!` 非空断言操作符 | warning |
| `js-no-console-log` | `console.log`（排除测试和脚本） | info |

### Python

| 规则 ID | 描述 | 级别 |
|---------|------|------|
| `py-no-exec` | `exec()` 使用 | error |
| `py-no-bare-except` | 裸 `except:` 语句 | warning |
| `py-no-mutable-default` | 可变默认参数（`def f(x=[])`） | warning |
| `py-no-star-import` | `from X import *` | warning |
| `py-no-assert-in-prod` | 生产代码中的 `assert`（排除测试） | info |

### Java / Kotlin

| 规则 ID | 描述 | 级别 |
|---------|------|------|
| `java-no-system-exit` | `System.exit()` | error |
| `java-no-thread-stop` | `Thread.stop()`（已废弃的不安全方法） | error |
| `java-no-raw-type` | 原始类型（如 `List` 而非 `List<String>`） | warning |
| `java-no-empty-catch` | 空 `catch` 块 | warning |
| `kotlin-no-force-unwrap` | `!!` 强制解包 | warning |

### Go

| 规则 ID | 描述 | 级别 |
|---------|------|------|
| `go-no-panic` | `panic()` 调用 | warning |
| `go-no-err-ignored` | 忽略 `error` 返回值（排除测试） | warning |
| `go-no-init-abuse` | `init()` 中的复杂逻辑 | info |
| `go-no-global-var` | 全局可变变量（排除接口满足断言和测试） | info |

### Dart / Flutter

| 规则 ID | 描述 | 级别 |
|---------|------|------|
| `dart-no-build-context-across-async` | `BuildContext` 跨 `async` 传递 | warning |
| `dart-dispose-controller` | Controller 未 `dispose()` | warning |
| `dart-avoid-bang-operator` | `!` 空断言操作符 | warning |
| `dart-avoid-dynamic` | `dynamic` 类型（排除 `Map<String, dynamic>` JSON 模式） | warning |
| `dart-no-set-state-after-dispose` | `setState` 无 `mounted` 检查 | info |
| `dart-no-print` | `print()` 调用 | info |
| `dart-prefer-const-constructor` | `new` 而非 `const` 构造函数 | info |
| `dart-no-relative-import` | 相对导入路径 | info |

### Rust

| 规则 ID | 描述 | 级别 |
|---------|------|------|
| `rust-no-unwrap` | `.unwrap()` 调用（跳过注释和测试块） | warning |
| `rust-unsafe-block` | `unsafe` 块 | warning |
| `rust-no-todo-macro` | `todo!` / `unimplemented!` 宏 | warning |
| `rust-no-panic-in-lib` | 库代码中的 `panic!` | warning |
| `rust-std-mutex-in-async` | 异步代码中使用 `std::sync::Mutex` | warning |
| `rust-no-expect-without-msg` | `.expect("")` 空消息 | info |
| `rust-clone-overuse` | `.clone()` 过度使用 | info |
| `rust-no-string-push-in-loop` | 循环中字符串拼接 | info |

---

## 代码级检查（跨行分析）

超越单行正则匹配的代码模式检查：

| 语言 | 检查项 |
|------|--------|
| ObjC | KVO 缺少 `removeObserver`；Category 同文件重名 |
| JS/TS | Promise 缺少 `.catch()` |
| Go | `defer` 在循环内 |
| Python | 混用 tab/space |
| Swift | 强制解包滥用（>5 处/文件） |
| Java | 资源泄露（无 try-with-resources）；`synchronized` 非 `final` 对象 |
| Kotlin | `GlobalScope.launch`；`runBlocking` |
| Rust | `.unwrap()` 滥用 (>3 处)；过多 `unsafe` (>3 块) |
| Dart | `setState` after dispose（无 `mounted`）；过多 `late` (>3 处) |

---

## 跨文件检查

分析模块/项目级别的问题：

| 检查项 | 语言 | 说明 |
|--------|------|------|
| 循环依赖 | JS/TS | A→B→A 导入循环检测 |
| Category 跨文件重名 | ObjC | 不同文件的 Category 方法同名 |
| 同名类跨文件 | Java/Kotlin | 不同文件定义同名类 |
| 多文件 init() | Go | 同 package 多个文件含 `init()` |
| Extension 方法冲突 | Swift | 不同文件的 Extension 方法同名 |

---

## AST 语义规则

基于 Tree-sitter AST 的深度语义分析：

| 查询类型 | 说明 | 示例 |
|----------|------|------|
| `mustCallThrough` | API 只能通过指定 wrapper 调用 | 网络请求只能通过封装层发起 |
| `mustNotUseInContext` | 特定上下文禁止某模式 | UI 线程禁止同步 I/O |
| `mustConformToProtocol` | 类必须实现指定协议 | ViewController 必须实现 Lifecycle |

---

## 规则属性

每条规则的完整属性结构：

```javascript
{
  message: "规则描述",
  severity: "error" | "warning" | "info",
  pattern: /regex/,                    // 正则模式
  languages: ["javascript", "typescript"],
  dimension: "file" | "target" | "project",
  category: "correctness" | "safety" | "style" | "performance",
  fixSuggestion: "修复建议文本",
  excludePaths: ["test/", "*.test.js"],  // 排除路径
  skipComments: true,                    // 跳过注释行
  skipTestBlocks: true                   // 跳过测试块（如 Rust #[cfg(test)]）
}
```

---

## 自定义规则

### 通过 API 创建

```bash
curl -X POST http://localhost:3000/api/v1/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "no-todo-comments",
    "pattern": "TODO|FIXME|HACK",
    "action": "warn",
    "description": "清理 TODO 注释",
    "languages": ["javascript", "typescript"]
  }'
```

### 通过 Recipe 自动生成

当 Recipe 的 `knowledgeType` 为 `boundary-constraint` 时，`RuleLearner` 自动从中生成 Guard 规则。

---

## CI/CD 集成

### GitHub Actions

```yaml
# .github/workflows/guard.yml
name: Guard Check
on: [push, pull_request]
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install -g alembic-ai
      - run: alembic guard:ci --report markdown --output guard-report.md
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: guard-report
          path: guard-report.md
```

也可使用 `templates/guard-ci.yml` 模板。

### Pre-commit Hook

```bash
# 安装
cp templates/pre-commit-guard.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

或手动配置：

```bash
#!/bin/sh
alembic guard:staged --fail-on-error
```

---

## 排除配置

### 规则级排除

每条规则可设置 `excludePaths`：

```javascript
{
  excludePaths: ["test/", "**/*.test.js", "scripts/", "mock/"]
}
```

### 全局排除

通过 `ExclusionManager` 管理，默认排除：
- `node_modules/`
- `.git/`
- `dist/` / `build/`
- `vendor/`
- `*.min.js`

### 特殊标记

- `skipComments: true` — 跳过注释行（支持 `//`、`///`、`/* */`、`#`、`"""`）
- `skipTestBlocks: true` — 跳过测试块（如 Rust `#[cfg(test)] mod tests { ... }`）

---

## 报告格式

### Text（默认）

```
✗ src/utils/helper.ts:42 [error] js-no-eval
  eval() 存在安全和性能风险
  建议: 使用 JSON.parse() 或 Function constructor 替代

⚠ src/utils/helper.ts:67 [warning] js-no-var
  使用 var 声明变量
  建议: 使用 let 或 const 替代

总计: 1 error, 1 warning, 0 info | 合规分数: 65/100
```

### JSON

```json
{
  "violations": [...],
  "summary": {
    "total": 2,
    "errors": 1,
    "warnings": 1,
    "infos": 0,
    "score": 65
  }
}
```

### Markdown

适合生成 PR 评论或 CI 报告。
