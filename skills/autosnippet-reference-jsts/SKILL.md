---
name: autosnippet-reference-jsts
description: JavaScript/TypeScript 业界最佳实践参考。涵盖类型系统、模块化、错误处理、async/await、命名、ESLint 规则，为冷启动分析提供高质量参考标准。
---

# JavaScript / TypeScript 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 JS/TS 项目时，请参考以下业界标准产出高质量候选。
> **来源**: Google TypeScript Style Guide, MDN Web Docs, TypeScript Handbook, Node.js Best Practices

---

## 1. 模块与导入导出

### 核心规则

```json
{
  "title": "TS 模块: 使用 named export，避免 default export",
  "content": {
    "markdown": "## TS 模块: 使用 named export，避免 default export\n\n### 标准模式\n```typescript\n// ✅ 使用 named export\nexport class UserService { ... }\nexport function parseConfig(raw: string): Config { ... }\nexport const MAX_RETRY = 3;\n\n// 导入时 — 明确看到导入了什么\nimport { UserService, parseConfig } from './user-service';\n\n// ❌ 避免 default export\nexport default class UserService { ... }\n// 导入时可以随意改名，不利于搜索和重构\nimport Whatever from './user-service';\n```",
    "pattern": "// ✅ 使用 named export\nexport class UserService { ... }\nexport function parseConfig(raw: string): Config { ... }\nexport const MAX_RETRY = 3;\n\n// 导入时 — 明确看到导入了什么\nimport { UserService, parseConfig } from './user-service';\n\n// ❌ 避免 default export\nexport default class UserService { ... }\n// 导入时可以随意改名，不利于搜索和重构\nimport Whatever from './user-service';",
    "rationale": "named export 强制导入方使用一致的名称，方便 IDE 自动补全、全局搜索和安全重构"
  },
  "description": "TS 模块: 使用 named export，避免 default export",
  "kind": "rule",
  "doClause": "Apply the TS 模块 pattern as described",
  "language": "typescript",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取TS 模块: 使用 named export，避免 default export的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "export default function handler() { ... }",
    "why": "default export 允许导入方任意命名，导致同一模块在不同文件中有不同名称",
    "fix": "export function handler() { ... }"
  },
  "reasoning": {
    "whyStandard": "Google TypeScript Style Guide 明确推荐 named export，AirBnb 和社区也倾向于此",
    "sources": [
      "Google TypeScript Style Guide - Exports"
    ],
    "confidence": 0.9
  }
}
```

### 导入顺序

```typescript
// ✅ 推荐顺序
// 1. Node.js 内置模块
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 2. 第三方包
import express from 'express';
import { z } from 'zod';

// 3. 项目内模块 (绝对路径)
import { UserService } from '@/services/user-service';

// 4. 相对路径模块
import { formatDate } from './utils';
import type { Config } from './types';

// ✅ type-only import 单独标记
import type { Request, Response } from 'express';
```

---

## 2. 变量声明

### const / let / var

```typescript
// ✅ 优先 const
const MAX_RETRIES = 3;
const config = loadConfig();  // 引用不变，内容可以修改
const users = [];
users.push(newUser);  // OK — 不修改引用本身

// ✅ 需要重新赋值时用 let
let currentIndex = 0;
for (let i = 0; i < items.length; i++) { ... }

// ❌ 永远不用 var
var name = 'Alice';  // 函数作用域 + 变量提升 → bug 来源
```

### 解构

```typescript
// ✅ 对象解构 — 只取需要的字段
const { name, email, role = 'user' } = user;

// ✅ 数组解构
const [first, second, ...rest] = items;

// ✅ 函数参数解构
function createUser({ name, email }: { name: string; email: string }) { ... }

// ❌ 反模式: 逐个取值
const name = user.name;
const email = user.email;
const role = user.role || 'user';
```

---

## 3. 类型系统

### interface vs type

```json
{
  "title": "TS 类型: interface 优先于 type alias",
  "content": {
    "markdown": "## TS 类型: interface 优先于 type alias\n\n### 标准模式\n```typescript\n// ✅ interface — 可扩展、声明可合并、错误信息更清晰\ninterface User {\n  id: string;\n  name: string;\n  email: string;\n}\n\n// ✅ interface 继承\ninterface AdminUser extends User {\n  permissions: string[];\n}\n\n// ✅ type 适合: 联合类型、映射类型、元组\ntype Status = 'active' | 'inactive' | 'suspended';\ntype Pair<T> = [T, T];\ntype ReadOnly<T> = { readonly [K in keyof T]: T[K] };\n\n// ❌ 避免: 用 type 定义简单对象结构\ntype User = {\n  id: string;\n  name: string;\n};\n```",
    "pattern": "// ✅ interface — 可扩展、声明可合并、错误信息更清晰\ninterface User {\n  id: string;\n  name: string;\n  email: string;\n}\n\n// ✅ interface 继承\ninterface AdminUser extends User {\n  permissions: string[];\n}\n\n// ✅ type 适合: 联合类型、映射类型、元组\ntype Status = 'active' | 'inactive' | 'suspended';\ntype Pair<T> = [T, T];\ntype ReadOnly<T> = { readonly [K in keyof T]: T[K] };\n\n// ❌ 避免: 用 type 定义简单对象结构\ntype User = {\n  id: string;\n  name: string;\n};",
    "rationale": "interface 支持声明合并和继承，TypeScript 编译器对 interface 有更好的优化和错误提示"
  },
  "description": "TS 类型: interface 优先于 type alias",
  "kind": "rule",
  "doClause": "Apply the TS 类型 pattern as described",
  "language": "typescript",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取TS 类型: interface 优先于 type alias的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "type Props = { title: string; onClick: () => void }",
    "why": "简单对象形状应该用 interface，type 更适合联合/交叉/映射类型",
    "fix": "interface Props { title: string; onClick: () => void }"
  },
  "reasoning": {
    "whyStandard": "Google TypeScript Style Guide: 'use interfaces to define object types, not type aliases'",
    "sources": [
      "Google TypeScript Style Guide - Interfaces vs Type Aliases"
    ],
    "confidence": 0.9
  }
}
```

### unknown vs any

```typescript
// ✅ 使用 unknown — 类型安全的 "任意类型"
function processInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input === 'number') return String(input);
  if (input instanceof Error) return input.message;
  throw new TypeError(`Unexpected input: ${typeof input}`);
}

// ❌ 避免 any — 关闭所有类型检查
function processInput(input: any): string {
  return input.name.toUpperCase();  // 运行时可能崩溃，编译器不会报错
}
```

### 其他类型规则

| 规则 | 推荐 | 避免 |
|------|------|------|
| 对象类型 | `Record<string, T>` | `{ [key: string]: T }` |
| 数组（简单） | `string[]` | `Array<string>` |
| 数组（复杂元素） | `Array<string \| number>` | `(string \| number)[]` |
| 可选属性 | `name?: string` | `name: string \| undefined` |
| 非空断言 | 尽量避免 `!` | `value!.property` |
| 类型断言 | `value as Type` | `<Type>value` (JSX 冲突) |
| 返回类型 | 让 TS 推断，复杂时标注 | 每个函数都标注 |

---

## 4. 错误处理

### 推荐模式

```json
{
  "title": "TS 错误处理: 抛出 Error 子类，不抛字符串",
  "content": {
    "markdown": "## TS 错误处理: 抛出 Error 子类，不抛字符串\n\n### 标准模式\n```typescript\n// ✅ 自定义 Error 子类\nclass AppError extends Error {\n  constructor(\n    message: string,\n    public readonly code: string,\n    public readonly statusCode: number = 500\n  ) {\n    super(message);\n    this.name = 'AppError';\n  }\n}\n\nclass NotFoundError extends AppError {\n  constructor(resource: string, id: string) {\n    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);\n    this.name = 'NotFoundError';\n  }\n}\n\n// 使用\nasync function getUser(id: string): Promise<User> {\n  const user = await db.findUser(id);\n  if (!user) throw new NotFoundError('User', id);\n  return user;\n}\n\n// 精确 catch\ntry {\n  await getUser('123');\n} catch (error) {\n  if (error instanceof NotFoundError) {\n    res.status(404).json({ error: error.message });\n  } else if (error instanceof AppError) {\n    res.status(error.statusCode).json({ error: error.message });\n  } else {\n    throw error;  // 未知错误继续向上抛\n  }\n}\n```",
    "pattern": "// ✅ 自定义 Error 子类\nclass AppError extends Error {\n  constructor(\n    message: string,\n    public readonly code: string,\n    public readonly statusCode: number = 500\n  ) {\n    super(message);\n    this.name = 'AppError';\n  }\n}\n\nclass NotFoundError extends AppError {\n  constructor(resource: string, id: string) {\n    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);\n    this.name = 'NotFoundError';\n  }\n}\n\n// 使用\nasync function getUser(id: string): Promise<User> {\n  const user = await db.findUser(id);\n  if (!user) throw new NotFoundError('User', id);\n  return user;\n}\n\n// 精确 catch\ntry {\n  await getUser('123');\n} catch (error) {\n  if (error instanceof NotFoundError) {\n    res.status(404).json({ error: error.message });\n  } else if (error instanceof AppError) {\n    res.status(error.statusCode).json({ error: error.message });\n  } else {\n    throw error;  // 未知错误继续向上抛\n  }\n}",
    "rationale": "Error 子类提供 stack trace + instanceof 检查 + 类型安全的额外属性"
  },
  "description": "TS 错误处理: 抛出 Error 子类，不抛字符串",
  "kind": "pattern",
  "doClause": "Apply the TS 错误处理 pattern as described",
  "language": "typescript",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取TS 错误处理: 抛出 Error 子类，不抛字符串的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "throw 'Something went wrong';",
    "why": "字符串没有 stack trace，无法用 instanceof 区分，catch 中无法获取结构化信息",
    "fix": "throw new AppError('Something went wrong', 'UNKNOWN');"
  },
  "reasoning": {
    "whyStandard": "Google TypeScript Style Guide: 'always throw Error or subclass, never throw string/number'",
    "sources": [
      "Google TypeScript Style Guide - Exceptions",
      "Node.js Best Practices"
    ],
    "confidence": 0.95
  }
}
```

### 错误处理反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `throw 'error message'` | 无 stack trace, 无 instanceof | `throw new Error('...')` |
| `catch (e) { }` 空 catch | 吞掉错误 | 至少 log 或 rethrow |
| `catch (e: any)` | 丢失类型安全 | `catch (e: unknown)` + 类型守卫 |
| `.catch(() => null)` | 静默失败 | 明确处理或 rethrow |

---

## 5. async/await 模式

### 基本模式

```typescript
// ✅ async/await 替代 Promise 链
async function fetchUserPosts(userId: string): Promise<Post[]> {
  const user = await userService.getUser(userId);
  const posts = await postService.getPostsByAuthor(user.id);
  return posts.filter(p => p.isPublished);
}

// ✅ 并行执行 — Promise.all
async function loadDashboard(userId: string) {
  const [user, posts, notifications] = await Promise.all([
    userService.getUser(userId),
    postService.getPosts(userId),
    notificationService.getUnread(userId),
  ]);
  return { user, posts, notifications };
}

// ✅ Promise.allSettled — 允许部分失败
const results = await Promise.allSettled([
  fetchCriticalData(),
  fetchOptionalData(),
]);
const successes = results
  .filter((r): r is PromiseFulfilledResult<Data> => r.status === 'fulfilled')
  .map(r => r.value);
```

### async 反模式

```typescript
// ❌ 不必要的 async
async function getUser(id: string): Promise<User> {
  return db.findUser(id);  // 已经返回 Promise，不需要 async
}
// ✅ 直接返回
function getUser(id: string): Promise<User> {
  return db.findUser(id);
}

// ❌ 串行执行独立的任务
const users = await getUsers();
const posts = await getPosts();  // 等 users 完成后才开始!
// ✅ 并行
const [users, posts] = await Promise.all([getUsers(), getPosts()]);

// ❌ for 循环中 await
for (const id of ids) {
  const user = await getUser(id);  // N 个串行请求
}
// ✅ 并行
const users = await Promise.all(ids.map(id => getUser(id)));
```

---

## 6. 函数与箭头函数

### 选择规则

```typescript
// ✅ 顶层 / 导出函数: function 声明（hoisting + 可读性）
export function createRouter(config: RouterConfig): Router {
  // ...
}

// ✅ 回调 / 内联: 箭头函数
const activeUsers = users.filter(u => u.isActive);
const names = users.map(u => u.name);
emitter.on('data', (chunk) => { process(chunk); });

// ✅ 箭头函数保持 this 绑定
class Timer {
  start() {
    setInterval(() => {
      this.tick();  // this 指向 Timer 实例
    }, 1000);
  }
}

// ❌ 不要用箭头函数作为类方法
class Service {
  handle = (req: Request) => { ... };  // 每个实例创建一份，不在原型链上
}
```

---

## 7. 命名规范

| 标识符 | 风格 | 示例 |
|--------|------|------|
| 类/接口/类型/枚举 | `PascalCase` | `UserService`, `HttpStatus` |
| 函数/方法/属性/变量 | `camelCase` | `getUserById`, `isEnabled` |
| 常量（模块级） | `UPPER_SNAKE_CASE` 或 `camelCase` | `MAX_RETRIES` 或 `maxRetries` |
| 枚举成员 | `PascalCase` | `HttpStatus.NotFound` |
| 泛型参数 | 单大写字母 | `<T>`, `<K, V>` |
| 私有属性 | 不加下划线前缀 | `private count` 不是 `_count` |
| Boolean | `is`/`has`/`should` 前缀 | `isActive`, `hasPermission` |
| 文件名 | kebab-case | `user-service.ts` |

### 命名反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `IUserService` | I 前缀非 TS 惯例 | `UserService` |
| `_privateVar` | 下划线前缀应留给框架 | `private` 修饰符 |
| `userInfo` (interface) | 应 PascalCase | `UserInfo` |
| `HANDLE_CLICK` (function) | 函数应 camelCase | `handleClick` |

---

## 8. 相等与控制流

### 严格相等

```typescript
// ✅ 始终使用 === 和 !==
if (value === null) { ... }
if (status !== 'active') { ... }

// ❌ 不要用 == 和 !=
if (value == null) { ... }  // null 和 undefined 都匹配
if (status != 'active') { ... }  // 类型转换可能导致意外结果
```

### 循环

```typescript
// ✅ for-of 遍历数组
for (const item of items) {
  process(item);
}

// ✅ for-of + Object.entries 遍历对象
for (const [key, value] of Object.entries(config)) {
  console.log(`${key}: ${value}`);
}

// ❌ for-in 遍历数组 — 遍历索引(字符串)，可能包含原型属性
for (const i in items) {
  items[i];  // i 是字符串 "0", "1", ...
}
```

---

## 9. 类与面向对象

### 参数属性

```typescript
// ✅ 使用 parameter properties 简化构造器
class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly logger: Logger,
    private readonly config: Config,
  ) {}

  async getUser(id: string): Promise<User> {
    this.logger.info(`Fetching user: ${id}`);
    return this.userRepo.findById(id);
  }
}

// ❌ 冗余的手动赋值
class UserService {
  private userRepo: UserRepository;
  private logger: Logger;
  constructor(userRepo: UserRepository, logger: Logger) {
    this.userRepo = userRepo;
    this.logger = logger;
  }
}
```

### readonly

```typescript
// ✅ 不会修改的属性标为 readonly
interface Config {
  readonly apiUrl: string;
  readonly timeout: number;
  readonly retryCount: number;
}

// ✅ 构造后不变的类属性
class EventEmitter {
  private readonly listeners = new Map<string, Function[]>();
}
```

---

## 10. 模板字面量与字符串

```typescript
// ✅ 模板字面量 — 包含变量时
const greeting = `Hello, ${user.name}!`;
const url = `${baseUrl}/api/v${version}/users/${userId}`;

// ✅ 多行字符串
const query = `
  SELECT *
  FROM users
  WHERE status = $1
  ORDER BY created_at DESC
`;

// ❌ 字符串拼接
const greeting = 'Hello, ' + user.name + '!';
const url = baseUrl + '/api/v' + version + '/users/' + userId;
```

---

## 11. JS/TS 特有维度 (extraDimensions)

冷启动分析 JS/TS 项目时，除了 9 通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **模块模式** | ESM vs CJS、barrel exports、circular deps | `code-pattern` |
| **类型安全** | strict mode、unknown vs any、type guards | `code-standard` |
| **async 模式** | Promise.all 并行、error boundary、取消 | `best-practice` |
| **Null 安全** | optional chaining (?.)、nullish coalescing (??) | `code-pattern` |
| **Node.js 特有** | EventEmitter、Stream、worker_threads | `code-pattern` |
| **框架模式** | React hooks、Express middleware、NestJS DI | `code-pattern` |
| **构建工具** | tsconfig 配置、bundler 设置、path alias | `config` |

---

## Related Skills

- **autosnippet-coldstart**: 完整冷启动流程（本 Skill 的主 Skill）
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
