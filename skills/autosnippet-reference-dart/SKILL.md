```skill
---
name: autosnippet-reference-dart
description: Dart (Flutter) 业界最佳实践参考。涵盖命名约定、空安全、Widget 设计、状态管理 (BLoC/Riverpod/Provider)、异步 (Future/Stream)、Freezed 不可变模型、测试、Clean Architecture，为冷启动分析提供高质量参考标准。
---

# Dart (Flutter) 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 Dart / Flutter 项目时，请参考以下业界标准产出高质量候选。
> **来源**: Effective Dart (dart.dev), Flutter Style Guide, Dart Lints (flutter_lints / very_good_analysis), Reso Coder Clean Architecture, Vandad Nahavandipoor Flutter Tips

---

## 1. 命名约定

### 核心规则

```json
{
  "title": "Dart: Effective Dart 命名规范",
  "content": {
    "markdown": "## Dart: Effective Dart 命名规范\n\n### 标准模式\n```dart\n// ✅ 类/枚举/typedef/extension: UpperCamelCase\nclass UserService { }\nenum AuthStatus { authenticated, unauthenticated }\ntypedef JsonMap = Map<String, dynamic>;\nextension StringX on String { }\n\n// ✅ 变量/函数/参数/命名参数: lowerCamelCase\nfinal currentUser = User();\nvoid fetchUserProfile() { }\nWidget build({required String title}) { }\n\n// ✅ 常量: lowerCamelCase (不用 SCREAMING_CAPS)\nconst defaultTimeout = Duration(seconds: 30);\nconst maxRetryCount = 3;\n\n// ✅ 文件名: snake_case\n// user_service.dart\n// home_page.dart\n// auth_repository.dart\n\n// ✅ library / package: snake_case\nlibrary my_app;\n\n// ✅ 私有成员: 下划线前缀\nclass _UserState extends State<UserPage> { }\nfinal _logger = Logger('AuthService');\n\n// ✅ bool 变量/getter: is/has/can/should 前缀\nbool get isLoading => _isLoading;\nbool hasPermission(String role) => ...;\n\n// ❌ 反模式\nconst MAX_RETRY_COUNT = 3;  // Dart 不用 SCREAMING_CAPS\nclass user_service { }       // 类名应 UpperCamelCase\nString UserName = '';         // 变量应 lowerCamelCase\n```",
    "pattern": "class UserService { }\nenum AuthStatus { authenticated, unauthenticated }\ntypedef JsonMap = Map<String, dynamic>;\nfinal currentUser = User();\nvoid fetchUserProfile() { }\nconst defaultTimeout = Duration(seconds: 30);\n// 文件名: user_service.dart",
    "rationale": "Effective Dart 规定类名 UpperCamelCase，变量/函数 lowerCamelCase，常量也用 lowerCamelCase（区别于 Java/C++），文件名 snake_case"
  },
  "description": "Dart: Effective Dart 命名规范",
  "kind": "rule",
  "doClause": "Apply the Dart naming conventions as described",
  "language": "dart",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取 Dart 命名规范的标准模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "const MAX_RETRY = 3;\nclass user_service { }",
    "why": "SCREAMING_CAPS 和下划线类名不符合 Dart 惯例",
    "fix": "const maxRetry = 3;\nclass UserService { }"
  },
  "reasoning": {
    "whyStandard": "Effective Dart - Style; dart_lints enforce",
    "sources": [
      "Effective Dart - Style",
      "Dart Linter Rules"
    ],
    "confidence": 0.95
  }
}
```

### 命名速查表

| 标识符类型 | 风格 | 示例 |
|-----------|------|------|
| 类/枚举/extension | `UpperCamelCase` | `UserService`, `AuthStatus` |
| 变量/函数/参数 | `lowerCamelCase` | `currentUser`, `fetchData()` |
| 常量 | `lowerCamelCase` | `defaultTimeout`, `maxRetry` |
| 文件名 | `snake_case` | `user_service.dart` |
| 私有成员 | `_` 前缀 | `_isLoading`, `_UserState` |
| 布尔值 | `is/has/can/should` 前缀 | `isLoading`, `hasPermission` |

---

## 2. 空安全 (Null Safety)

```json
{
  "title": "Dart: 空安全最佳实践",
  "content": {
    "markdown": "## Dart: 空安全最佳实践\n\n### 标准模式\n```dart\n// ✅ 优先使用不可空类型\nString name = 'Alice';\nint count = 0;\n\n// ✅ 确实可能为 null 时用 nullable\nUser? findUserById(int id) {\n  return _cache[id]; // 可能不存在\n}\n\n// ✅ 安全调用链 + ?? 默认值\nfinal city = user?.address?.city ?? 'Unknown';\n\n// ✅ null-aware 赋值\n_cache ??= {};\nname ??= 'Guest';\n\n// ✅ 模式匹配（Dart 3+）\nif (user case User(:final name, :final email)) {\n  print('$name: $email');\n}\n\n// ✅ late 用于确定会初始化但无法在声明时赋值的场景\nlate final TextEditingController _controller;\n\n@override\nvoid initState() {\n  super.initState();\n  _controller = TextEditingController();\n}\n\n// ❌ 避免 ! 强制解包\nfinal name = user!.name;  // 可能抛 TypeError\n\n// ❌ 避免不必要的 nullable\nString? getName() => 'Alice';  // String 就够了\n\n// ❌ 避免 late 滥用\nlate String title;  // 如果不确定会赋值，用 String? 更安全\n```",
    "pattern": "final city = user?.address?.city ?? 'Unknown';\n_cache ??= {};\nif (user case User(:final name, :final email)) { ... }\nlate final TextEditingController _controller;",
    "rationale": "Dart 3 的 sound null safety 在编译期防止 null 错误，应充分利用"
  },
  "description": "Dart: 空安全最佳实践",
  "kind": "rule",
  "doClause": "Apply Dart null safety best practices",
  "language": "dart",
  "headers": [],
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n处理可空值时参考此规范。",
  "antiPattern": {
    "bad": "final name = user!.name;",
    "why": "! 绕过编译器保护，运行时可能 TypeError",
    "fix": "final name = user?.name ?? 'Unknown';"
  },
  "reasoning": {
    "whyStandard": "Dart Sound Null Safety 官方规范",
    "sources": [
      "Effective Dart - Usage (Null)",
      "Dart Null Safety Migration Guide"
    ],
    "confidence": 0.95
  }
}
```

---

## 3. Widget 设计

```json
{
  "title": "Dart: Widget 组合与设计原则",
  "content": {
    "markdown": "## Flutter: Widget 组合设计\n\n### 标准模式\n```dart\n// ✅ 小组件拆分 — 每个 Widget 职责单一\nclass UserAvatar extends StatelessWidget {\n  const UserAvatar({super.key, required this.url, this.radius = 24});\n\n  final String url;\n  final double radius;\n\n  @override\n  Widget build(BuildContext context) {\n    return CircleAvatar(\n      radius: radius,\n      backgroundImage: NetworkImage(url),\n    );\n  }\n}\n\n// ✅ const 构造函数 — 优化 Widget 重建\nclass AppButton extends StatelessWidget {\n  const AppButton({super.key, required this.label, required this.onPressed});\n\n  final String label;\n  final VoidCallback onPressed;\n\n  @override\n  Widget build(BuildContext context) {\n    return ElevatedButton(\n      onPressed: onPressed,\n      child: Text(label),\n    );\n  }\n}\n\n// 使用时加 const\nconst AppButton(label: 'Submit', onPressed: _handleSubmit);\n\n// ✅ 组合优于继承 — 不要继承 MaterialApp/Scaffold 等\nclass HomePage extends StatelessWidget {\n  const HomePage({super.key});\n\n  @override\n  Widget build(BuildContext context) {\n    return Scaffold(\n      appBar: const HomeAppBar(),\n      body: const HomeBody(),\n      floatingActionButton: const HomeFab(),\n    );\n  }\n}\n\n// ✅ BuildContext 不要跨 async gap\nFuture<void> _handleTap(BuildContext context) async {\n  final navigator = Navigator.of(context); // 缓存 navigator\n  await someAsyncWork();\n  navigator.push(...); // 安全使用\n}\n\n// ❌ 反模式: 超大 build 方法\n// ❌ 反模式: Widget 中直接用 MediaQuery.of(context).size（触发全局重建）\n// ❌ 反模式: 在 build 中创建 controller / 订阅 Stream\n```",
    "pattern": "class UserAvatar extends StatelessWidget {\n  const UserAvatar({super.key, required this.url, this.radius = 24});\n  final String url;\n  final double radius;\n  @override\n  Widget build(BuildContext context) { ... }\n}",
    "rationale": "Flutter Widget 是廉价对象，应大量拆分小 Widget 而非写超大 build 方法"
  },
  "description": "Flutter Widget 组合设计原则",
  "kind": "rule",
  "doClause": "Design widgets following composition over inheritance with const constructors",
  "language": "dart",
  "headers": ["import 'package:flutter/material.dart';"],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n创建新 Widget 时参考组合设计原则。",
  "antiPattern": {
    "bad": "// 500 行的 build 方法\n@override\nWidget build(BuildContext context) { /* 500 行嵌套 */ }",
    "why": "超大 build 方法难以维护和测试，也无法利用 const 优化",
    "fix": "拆分为多个小型 StatelessWidget，加 const 构造函数"
  },
  "reasoning": {
    "whyStandard": "Flutter 官方 Performance Best Practices; Widget inspector 推荐",
    "sources": [
      "Flutter Performance Best Practices",
      "Flutter Widget Catalog"
    ],
    "confidence": 0.9
  }
}
```

### Widget 拆分速查表

| 场景 | 正确做法 | 错误做法 |
|------|---------|---------|
| 重复 UI 块 | 提取为 `const StatelessWidget` | 复制粘贴、用函数返回 Widget |
| 有状态组件 | `StatefulWidget` + 最小化状态 | 所有状态放在一个巨型 `State` |
| 动画 | `AnimatedFoo` / `TweenAnimationBuilder` | 手动 `Timer` |
| 列表项 | 独立 Widget（利于 `const` 缓存） | 在 `ListView.builder` 内联 |

---

## 4. 状态管理

```json
{
  "title": "Dart: 状态管理方案比较与最佳实践",
  "content": {
    "markdown": "## Flutter: 状态管理\n\n### BLoC / Cubit 模式\n```dart\n// ✅ Cubit — 简单状态\nclass CounterCubit extends Cubit<int> {\n  CounterCubit() : super(0);\n\n  void increment() => emit(state + 1);\n  void decrement() => emit(state - 1);\n}\n\n// ✅ BLoC — 事件驱动\nsealed class AuthEvent {}\nclass LoginRequested extends AuthEvent {\n  final String email;\n  final String password;\n  LoginRequested({required this.email, required this.password});\n}\nclass LogoutRequested extends AuthEvent {}\n\nsealed class AuthState {}\nclass AuthInitial extends AuthState {}\nclass AuthLoading extends AuthState {}\nclass AuthAuthenticated extends AuthState {\n  final User user;\n  AuthAuthenticated(this.user);\n}\nclass AuthError extends AuthState {\n  final String message;\n  AuthError(this.message);\n}\n\nclass AuthBloc extends Bloc<AuthEvent, AuthState> {\n  AuthBloc({required AuthRepository authRepo})\n      : _authRepo = authRepo,\n        super(AuthInitial()) {\n    on<LoginRequested>(_onLogin);\n    on<LogoutRequested>(_onLogout);\n  }\n\n  final AuthRepository _authRepo;\n\n  Future<void> _onLogin(LoginRequested event, Emitter<AuthState> emit) async {\n    emit(AuthLoading());\n    try {\n      final user = await _authRepo.login(event.email, event.password);\n      emit(AuthAuthenticated(user));\n    } catch (e) {\n      emit(AuthError(e.toString()));\n    }\n  }\n\n  Future<void> _onLogout(LogoutRequested event, Emitter<AuthState> emit) async {\n    await _authRepo.logout();\n    emit(AuthInitial());\n  }\n}\n```\n\n### Riverpod 模式\n```dart\n// ✅ Riverpod 2.0 — 声明式 Provider\n@riverpod\nFuture<List<User>> users(UsersRef ref) async {\n  final repo = ref.watch(userRepositoryProvider);\n  return repo.fetchAll();\n}\n\n@riverpod\nclass Counter extends _$Counter {\n  @override\n  int build() => 0;\n\n  void increment() => state++;\n  void decrement() => state--;\n}\n\n// 在 Widget 中消费\nclass UsersPage extends ConsumerWidget {\n  const UsersPage({super.key});\n\n  @override\n  Widget build(BuildContext context, WidgetRef ref) {\n    final asyncUsers = ref.watch(usersProvider);\n    return asyncUsers.when(\n      data: (users) => ListView.builder(...),\n      loading: () => const CircularProgressIndicator(),\n      error: (e, st) => Text('Error: $e'),\n    );\n  }\n}\n```\n\n### Provider (ChangeNotifier)\n```dart\n// ✅ 简单场景可用 ChangeNotifier\nclass CartNotifier extends ChangeNotifier {\n  final List<CartItem> _items = [];\n  List<CartItem> get items => List.unmodifiable(_items);\n\n  void add(CartItem item) {\n    _items.add(item);\n    notifyListeners();\n  }\n\n  void remove(int index) {\n    _items.removeAt(index);\n    notifyListeners();\n  }\n}\n```",
    "pattern": "// Cubit\nclass CounterCubit extends Cubit<int> {\n  CounterCubit() : super(0);\n  void increment() => emit(state + 1);\n}\n\n// BLoC\nclass AuthBloc extends Bloc<AuthEvent, AuthState> { ... }\n\n// Riverpod\n@riverpod\nclass Counter extends _$Counter { ... }",
    "rationale": "BLoC 适合复杂事件驱动流程，Riverpod 适合声明式数据流，ChangeNotifier 适合简单场景"
  },
  "description": "Flutter 状态管理方案与最佳实践",
  "kind": "pattern",
  "doClause": "Choose state management approach based on complexity",
  "language": "dart",
  "headers": ["import 'package:flutter_bloc/flutter_bloc.dart';"],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n选择状态管理方案时参考此对比。",
  "reasoning": {
    "whyStandard": "Flutter 官方推荐 + 社区主流方案",
    "sources": [
      "flutter_bloc documentation",
      "Riverpod documentation",
      "Flutter State Management"
    ],
    "confidence": 0.9
  }
}
```

### 状态管理选型

| 方案 | 适合场景 | 核心概念 |
|------|---------|---------|
| `setState` | 单 Widget 局部状态 | 最简单，不超出 Widget 边界 |
| `ChangeNotifier` + `Provider` | 中小型应用 | 熟悉的观察者模式 |
| `BLoC / Cubit` | 复杂事件驱动流程 | Event → State 单向数据流 |
| `Riverpod` | 声明式数据流 + 依赖注入 | Provider + code generation |
| `GetX` | 快速原型 | 响应式 + 路由 + DI 一体化 |

---

## 5. 异步编程 (Future / Stream / async-await)

```json
{
  "title": "Dart: 异步编程最佳实践",
  "content": {
    "markdown": "## Dart: 异步编程\n\n### Future / async-await\n```dart\n// ✅ async-await — 清晰的异步控制流\nFuture<User> fetchUser(int id) async {\n  final response = await http.get(Uri.parse('/api/users/$id'));\n  if (response.statusCode != 200) {\n    throw HttpException('Failed to fetch user: ${response.statusCode}');\n  }\n  return User.fromJson(jsonDecode(response.body));\n}\n\n// ✅ 并发请求 — Future.wait\nFuture<(User, List<Order>)> fetchUserWithOrders(int userId) async {\n  final results = await Future.wait([\n    fetchUser(userId),\n    fetchOrders(userId),\n  ]);\n  return (results[0] as User, results[1] as List<Order>);\n}\n\n// ✅ 超时控制\nfinal user = await fetchUser(id).timeout(\n  const Duration(seconds: 10),\n  onTimeout: () => throw TimeoutException('fetchUser timeout'),\n);\n```\n\n### Stream\n```dart\n// ✅ StreamController — 自管理 Stream\nclass PositionService {\n  final _controller = StreamController<Position>.broadcast();\n  Stream<Position> get positionStream => _controller.stream;\n\n  void updatePosition(Position pos) {\n    _controller.add(pos);\n  }\n\n  void dispose() {\n    _controller.close(); // 务必关闭！\n  }\n}\n\n// ✅ async* 生成器\nStream<int> countDown(int from) async* {\n  for (var i = from; i >= 0; i--) {\n    yield i;\n    await Future.delayed(const Duration(seconds: 1));\n  }\n}\n\n// ✅ Stream 变换\nfinal filtered = positionStream\n    .where((pos) => pos.accuracy < 10)\n    .map((pos) => LatLng(pos.latitude, pos.longitude))\n    .distinct();\n\n// ❌ 反模式: 忘记取消 StreamSubscription\n// ❌ 反模式: 忘记关闭 StreamController\n```",
    "pattern": "Future<User> fetchUser(int id) async {\n  final response = await http.get(...);\n  return User.fromJson(jsonDecode(response.body));\n}\n\nStream<int> countDown(int from) async* {\n  for (var i = from; i >= 0; i--) {\n    yield i;\n    await Future.delayed(const Duration(seconds: 1));\n  }\n}",
    "rationale": "Dart 的 async-await 基于 Future，Stream 用于多值异步，两者是 Dart 异步编程的核心"
  },
  "description": "Dart 异步编程: Future/Stream/async-await",
  "kind": "pattern",
  "doClause": "Use async-await for single values, Stream for multiple async values",
  "language": "dart",
  "headers": ["import 'dart:async';"],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n处理异步操作时参考此规范。",
  "antiPattern": {
    "bad": "// 忘记 await\nfetchUser(id); // Future 被忽略，错误静默丢失\n// 忘记取消订阅\nstream.listen(print); // 永不取消",
    "why": "未 await 的 Future 错误会静默丢失；未取消的 StreamSubscription 导致内存泄漏",
    "fix": "await fetchUser(id);\nfinal sub = stream.listen(print);\n// 在 dispose 中: sub.cancel();"
  },
  "reasoning": {
    "whyStandard": "Dart 语言官方异步编程指南",
    "sources": [
      "Dart Asynchronous Programming",
      "Effective Dart - Usage (Async)"
    ],
    "confidence": 0.95
  }
}
```

---

## 6. 不可变数据模型 (Freezed / sealed class)

```json
{
  "title": "Dart: Freezed 不可变数据模型",
  "content": {
    "markdown": "## Dart: Freezed + sealed class 数据建模\n\n### Freezed — 不可变值对象 + union type\n```dart\n// ✅ Freezed 数据类\n@freezed\nclass User with _$User {\n  const factory User({\n    required int id,\n    required String name,\n    required String email,\n    @Default('') String avatarUrl,\n  }) = _User;\n\n  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);\n}\n\n// 使用: copyWith 创建修改后的副本\nfinal updated = user.copyWith(name: 'Bob');\n\n// ✅ Freezed union (ADT)\n@freezed\nsealed class Result<T> with _$Result<T> {\n  const factory Result.success(T data) = Success<T>;\n  const factory Result.failure(String message) = Failure<T>;\n  const factory Result.loading() = Loading<T>;\n}\n\n// 使用: 模式匹配 (Dart 3)\nfinal widget = switch (result) {\n  Success(:final data) => Text('$data'),\n  Failure(:final message) => Text('Error: $message'),\n  Loading() => const CircularProgressIndicator(),\n};\n```\n\n### Dart 3 sealed class（无 Freezed）\n```dart\n// ✅ 纯 Dart 3 sealed class\nsealed class AuthState {}\n\nclass Authenticated extends AuthState {\n  final User user;\n  Authenticated(this.user);\n}\n\nclass Unauthenticated extends AuthState {}\n\nclass AuthLoading extends AuthState {}\n\n// 编译器强制 exhaustive switch\nString describe(AuthState state) => switch (state) {\n  Authenticated(:final user) => 'Hello ${user.name}',\n  Unauthenticated() => 'Please login',\n  AuthLoading() => 'Loading...',\n};\n```",
    "pattern": "@freezed\nclass User with _$User {\n  const factory User({required int id, required String name}) = _User;\n  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);\n}\n\nsealed class Result<T> with _$Result<T> {\n  const factory Result.success(T data) = Success<T>;\n  const factory Result.failure(String message) = Failure<T>;\n}",
    "rationale": "Freezed 自动生成 copyWith/==/hashCode/toString/JSON 序列化，sealed class 配合 Dart 3 模式匹配实现编译器级别的穷尽检查"
  },
  "description": "Dart Freezed 不可变数据模型 + sealed class",
  "kind": "pattern",
  "doClause": "Use Freezed for immutable data models and sealed class for union types",
  "language": "dart",
  "headers": ["import 'package:freezed_annotation/freezed_annotation.dart';"],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n定义数据模型或状态类型时参考。",
  "antiPattern": {
    "bad": "class User {\n  String name;\n  User(this.name);\n  // 手写 ==, hashCode, copyWith, toString, toJson ...\n}",
    "why": "手写样板代码容易出错且维护成本高",
    "fix": "使用 @freezed 自动生成"
  },
  "reasoning": {
    "whyStandard": "Freezed 是 Flutter 社区最流行的代码生成方案",
    "sources": [
      "freezed package documentation",
      "Dart 3 Patterns and Records"
    ],
    "confidence": 0.9
  }
}
```

---

## 7. 错误处理

```json
{
  "title": "Dart: 错误处理最佳实践",
  "content": {
    "markdown": "## Dart: 错误处理\n\n### 标准模式\n```dart\n// ✅ 自定义 Exception 类型\nclass NetworkException implements Exception {\n  final int statusCode;\n  final String message;\n  const NetworkException(this.statusCode, this.message);\n\n  @override\n  String toString() => 'NetworkException($statusCode): $message';\n}\n\nclass TimeoutException extends NetworkException {\n  const TimeoutException() : super(408, 'Request timeout');\n}\n\n// ✅ 明确 catch 类型\nFuture<User> getUser(int id) async {\n  try {\n    return await _api.fetchUser(id);\n  } on TimeoutException {\n    return _cache.getUser(id) ?? rethrow;\n  } on NetworkException catch (e) {\n    _logger.warning('Network error: $e');\n    rethrow;\n  } on FormatException catch (e) {\n    _logger.severe('Parse error: $e');\n    throw DataException('Invalid response format');\n  }\n}\n\n// ✅ Result 类型（函数式风格）\nsealed class Result<T> {\n  const Result();\n}\nclass Success<T> extends Result<T> {\n  final T data;\n  const Success(this.data);\n}\nclass Failure<T> extends Result<T> {\n  final Object error;\n  final StackTrace stackTrace;\n  const Failure(this.error, this.stackTrace);\n}\n\nFuture<Result<User>> getUserSafe(int id) async {\n  try {\n    final user = await _api.fetchUser(id);\n    return Success(user);\n  } catch (e, st) {\n    return Failure(e, st);\n  }\n}\n\n// ❌ 避免: catch 所有错误后忽略\ntry { ... } catch (_) { } // 吞掉所有错误\n\n// ❌ 避免: 用 String 表示错误\nthrow 'Something went wrong'; // 没有堆栈信息\n```",
    "pattern": "class NetworkException implements Exception {\n  final int statusCode;\n  final String message;\n  const NetworkException(this.statusCode, this.message);\n}\n\ntry {\n  ...\n} on TimeoutException {\n  ...\n} on NetworkException catch (e) {\n  rethrow;\n}",
    "rationale": "Dart 用 on .. catch 精确捕获不同异常类型，rethrow 保留原始堆栈"
  },
  "description": "Dart 错误处理: 自定义 Exception + on-catch + Result 模式",
  "kind": "pattern",
  "doClause": "Use custom Exception types with specific on-catch blocks",
  "language": "dart",
  "headers": [],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n设计错误处理逻辑时参考。",
  "antiPattern": {
    "bad": "try { ... } catch (_) { }  // 或 throw 'error string'",
    "why": "吞掉所有错误让 bug 难以排查；throw String 丢失堆栈信息",
    "fix": "自定义 Exception 类 + on .. catch 精确捕获 + rethrow"
  },
  "reasoning": {
    "whyStandard": "Effective Dart - Error handling",
    "sources": [
      "Effective Dart - Usage (Errors)",
      "Dart Language Tour - Exceptions"
    ],
    "confidence": 0.95
  }
}
```

---

## 8. 依赖注入

```json
{
  "title": "Dart: 依赖注入模式",
  "content": {
    "markdown": "## Dart: 依赖注入\n\n### get_it + injectable\n```dart\n// ✅ 定义抽象层\nabstract class UserRepository {\n  Future<User> getById(int id);\n  Future<List<User>> getAll();\n}\n\n// ✅ 实现\n@LazySingleton(as: UserRepository)\nclass UserRepositoryImpl implements UserRepository {\n  final ApiClient _api;\n  final LocalDatabase _db;\n\n  UserRepositoryImpl(this._api, this._db);\n\n  @override\n  Future<User> getById(int id) async {\n    try {\n      return await _api.fetchUser(id);\n    } catch (_) {\n      return await _db.getUser(id);\n    }\n  }\n\n  @override\n  Future<List<User>> getAll() => _api.fetchUsers();\n}\n\n// ✅ 注册 (injectable 自动生成)\n@InjectableInit()\nvoid configureDependencies() => getIt.init();\n\n// ✅ 消费\nclass UserBloc extends Bloc<UserEvent, UserState> {\n  UserBloc({required UserRepository userRepo})\n      : _userRepo = userRepo,\n        super(UserInitial());\n\n  final UserRepository _userRepo;\n}\n```\n\n### Riverpod DI（无 get_it）\n```dart\n// ✅ Riverpod 天然 DI\n@riverpod\nUserRepository userRepository(UserRepositoryRef ref) {\n  return UserRepositoryImpl(\n    ref.watch(apiClientProvider),\n    ref.watch(localDatabaseProvider),\n  );\n}\n\n// 测试时 override\nvoid main() {\n  testWidgets('...', (tester) async {\n    await tester.pumpWidget(\n      ProviderScope(\n        overrides: [\n          userRepositoryProvider.overrideWithValue(MockUserRepository()),\n        ],\n        child: const MyApp(),\n      ),\n    );\n  });\n}\n```",
    "pattern": "@LazySingleton(as: UserRepository)\nclass UserRepositoryImpl implements UserRepository { ... }\n\n@InjectableInit()\nvoid configureDependencies() => getIt.init();",
    "rationale": "DI 解耦接口与实现，便于测试 mock 和替换"
  },
  "description": "Dart 依赖注入: get_it + injectable / Riverpod",
  "kind": "pattern",
  "doClause": "Use DI to decouple interface from implementation",
  "language": "dart",
  "headers": ["import 'package:injectable/injectable.dart';", "import 'package:get_it/get_it.dart';"],
  "knowledgeType": "architecture",
  "usageGuide": "### 使用场景\\n设计服务层依赖关系时参考。",
  "reasoning": {
    "whyStandard": "get_it + injectable 是 Flutter DI 最流行方案; Riverpod 自带 DI",
    "sources": [
      "get_it package documentation",
      "injectable package documentation",
      "Riverpod documentation"
    ],
    "confidence": 0.9
  }
}
```

---

## 9. Clean Architecture

```json
{
  "title": "Dart: Flutter Clean Architecture",
  "content": {
    "markdown": "## Flutter: Clean Architecture\n\n### 标准分层\n```\nlib/\n├── core/                     # 共享基础设施\n│   ├── error/                # Exception / Failure 定义\n│   ├── network/              # Dio/http 封装\n│   ├── router/               # GoRouter 路由配置\n│   └── theme/                # 主题定义\n├── features/                 # 按功能模块划分\n│   └── auth/\n│       ├── data/\n│       │   ├── datasources/  # Remote + Local 数据源\n│       │   ├── models/       # DTO (JSON 序列化)\n│       │   └── repositories/ # Repository 实现\n│       ├── domain/\n│       │   ├── entities/     # 业务实体 (纯 Dart)\n│       │   ├── repositories/ # Repository 抽象接口\n│       │   └── usecases/     # 用例 (业务逻辑)\n│       └── presentation/\n│           ├── bloc/         # BLoC / Cubit\n│           ├── pages/        # 页面 Widget\n│           └── widgets/      # 局部 Widget\n├── injection_container.dart  # DI 配置\n└── main.dart\n```\n\n### 依赖规则\n```\nPresentation → Domain ← Data\n     ↓           ↑         ↓\n   BLoC     UseCase   Repository\n     ↓           ↑         ↓\n   Widget   Entity    DataSource\n```\n\n- **Domain 层不依赖任何外层** (纯 Dart, 无 Flutter import)\n- **Data 层实现 Domain 定义的抽象接口**\n- **Presentation 层只依赖 Domain 层**\n\n### UseCase 模式\n```dart\nabstract class UseCase<Type, Params> {\n  Future<Either<Failure, Type>> call(Params params);\n}\n\nclass GetUser implements UseCase<User, int> {\n  final UserRepository _repo;\n  GetUser(this._repo);\n\n  @override\n  Future<Either<Failure, User>> call(int id) {\n    return _repo.getById(id);\n  }\n}\n```",
    "pattern": "lib/\n├── core/\n├── features/\n│   └── auth/\n│       ├── data/ (datasources, models, repositories impl)\n│       ├── domain/ (entities, repository interfaces, usecases)\n│       └── presentation/ (bloc, pages, widgets)\n├── injection_container.dart\n└── main.dart",
    "rationale": "Clean Architecture 保证核心业务逻辑（Domain）不依赖框架和外部库，Data 和 Presentation 可独立替换"
  },
  "description": "Flutter Clean Architecture 分层结构",
  "kind": "fact",
  "doClause": "Follow Clean Architecture layering: Presentation → Domain ← Data",
  "language": "dart",
  "headers": [],
  "knowledgeType": "architecture",
  "usageGuide": "### 使用场景\\n设计项目架构时参考。",
  "reasoning": {
    "whyStandard": "Reso Coder Flutter Clean Architecture 系列 + Uncle Bob Clean Architecture",
    "sources": [
      "Reso Coder - Flutter TDD Clean Architecture",
      "Robert C. Martin - Clean Architecture"
    ],
    "confidence": 0.85
  }
}
```

---

## 10. Extension 与 Mixin

```json
{
  "title": "Dart: Extension 与 Mixin",
  "content": {
    "markdown": "## Dart: Extension 与 Mixin\n\n### Extension — 为已有类型添加方法\n```dart\n// ✅ 为 BuildContext 添加便捷方法\nextension BuildContextX on BuildContext {\n  ThemeData get theme => Theme.of(this);\n  TextTheme get textTheme => Theme.of(this).textTheme;\n  ColorScheme get colorScheme => Theme.of(this).colorScheme;\n  MediaQueryData get mediaQuery => MediaQuery.of(this);\n  double get screenWidth => mediaQuery.size.width;\n\n  void showSnackBar(String message) {\n    ScaffoldMessenger.of(this).showSnackBar(\n      SnackBar(content: Text(message)),\n    );\n  }\n}\n\n// ✅ 为 String 添加工具方法\nextension StringX on String {\n  String get capitalized =>\n      isEmpty ? this : '${this[0].toUpperCase()}${substring(1)}';\n  bool get isValidEmail =>\n      RegExp(r'^[\\w-\\.]+@[\\w-]+\\.[a-z]{2,}$').hasMatch(this);\n}\n\n// ✅ 为 DateTime 添加格式化\nextension DateTimeX on DateTime {\n  String get ymd => '$year-${month.toString().padLeft(2, '0')}-${day.toString().padLeft(2, '0')}';\n  bool get isToday {\n    final now = DateTime.now();\n    return year == now.year && month == now.month && day == now.day;\n  }\n}\n```\n\n### Mixin — 跨类复用行为\n```dart\n// ✅ Mixin 复用日志能力\nmixin LoggerMixin {\n  late final Logger _logger = Logger(runtimeType.toString());\n\n  void logInfo(String msg) => _logger.info(msg);\n  void logWarning(String msg) => _logger.warning(msg);\n  void logError(String msg, [Object? error]) => _logger.severe(msg, error);\n}\n\nclass AuthService with LoggerMixin {\n  Future<void> login(String email, String password) async {\n    logInfo('Attempting login for $email');\n    // ...\n  }\n}\n\n// ✅ Mixin with on — 约束宿主类型\nmixin AutoDisposeMixin on State {\n  final _disposables = <VoidCallback>[];\n\n  void autoDispose(VoidCallback callback) => _disposables.add(callback);\n\n  @override\n  void dispose() {\n    for (final fn in _disposables) { fn(); }\n    super.dispose();\n  }\n}\n```",
    "pattern": "extension BuildContextX on BuildContext {\n  ThemeData get theme => Theme.of(this);\n  void showSnackBar(String message) { ... }\n}\n\nmixin LoggerMixin {\n  late final Logger _logger = Logger(runtimeType.toString());\n  void logInfo(String msg) => _logger.info(msg);\n}",
    "rationale": "Extension 为已有类型添加方法而不修改源码；Mixin 在类间复用行为而不用继承"
  },
  "description": "Dart Extension 与 Mixin 复用模式",
  "kind": "pattern",
  "doClause": "Use Extension for utility methods on existing types, Mixin for cross-class behavior reuse",
  "language": "dart",
  "headers": [],
  "knowledgeType": "code-pattern",
  "usageGuide": "### 使用场景\\n需要为已有类型添加方法或跨类复用逻辑时参考。",
  "reasoning": {
    "whyStandard": "Dart 语言特性，社区广泛使用",
    "sources": [
      "Dart Language Tour - Extensions",
      "Dart Language Tour - Mixins"
    ],
    "confidence": 0.9
  }
}
```

---

## 11. 测试

```json
{
  "title": "Dart: Flutter 测试最佳实践",
  "content": {
    "markdown": "## Flutter: 测试金字塔\n\n### 单元测试\n```dart\n// ✅ 用 group + test 组织\ngroup('UserRepository', () {\n  late MockApiClient mockApi;\n  late UserRepositoryImpl repo;\n\n  setUp(() {\n    mockApi = MockApiClient();\n    repo = UserRepositoryImpl(mockApi);\n  });\n\n  test('getById returns user on success', () async {\n    when(() => mockApi.fetchUser(1)).thenAnswer(\n      (_) async => UserModel(id: 1, name: 'Alice'),\n    );\n\n    final result = await repo.getById(1);\n\n    expect(result.name, equals('Alice'));\n    verify(() => mockApi.fetchUser(1)).called(1);\n  });\n\n  test('getById throws on network error', () {\n    when(() => mockApi.fetchUser(any())).thenThrow(\n      const NetworkException(500, 'Server error'),\n    );\n\n    expect(() => repo.getById(1), throwsA(isA<NetworkException>()));\n  });\n});\n```\n\n### Widget 测试\n```dart\ntestWidgets('LoginPage shows error on invalid input', (tester) async {\n  await tester.pumpWidget(\n    const MaterialApp(home: LoginPage()),\n  );\n\n  // 点击提交（空输入）\n  await tester.tap(find.byType(ElevatedButton));\n  await tester.pump();\n\n  // 验证错误提示\n  expect(find.text('Email is required'), findsOneWidget);\n});\n```\n\n### BLoC 测试\n```dart\nblocTest<AuthBloc, AuthState>(\n  'emits [AuthLoading, AuthAuthenticated] on successful login',\n  build: () {\n    when(() => mockRepo.login(any(), any())).thenAnswer(\n      (_) async => User(id: 1, name: 'Alice'),\n    );\n    return AuthBloc(authRepo: mockRepo);\n  },\n  act: (bloc) => bloc.add(\n    LoginRequested(email: 'a@b.com', password: '123'),\n  ),\n  expect: () => [\n    isA<AuthLoading>(),\n    isA<AuthAuthenticated>(),\n  ],\n);\n```\n\n### Golden 测试\n```dart\ntestWidgets('UserCard matches golden', (tester) async {\n  await tester.pumpWidget(\n    MaterialApp(\n      home: UserCard(user: User(id: 1, name: 'Alice')),\n    ),\n  );\n\n  await expectLater(\n    find.byType(UserCard),\n    matchesGoldenFile('goldens/user_card.png'),\n  );\n});\n```",
    "pattern": "// 单元测试\ngroup('UserRepository', () {\n  test('getById returns user', () async { ... });\n});\n\n// Widget 测试\ntestWidgets('...', (tester) async {\n  await tester.pumpWidget(...);\n  expect(find.text('...'), findsOneWidget);\n});\n\n// BLoC 测试\nblocTest<AuthBloc, AuthState>('...', build: () => ..., act: ..., expect: ...);",
    "rationale": "Flutter 提供三层测试: unit → widget → integration，应优先保证 unit 和 widget 覆盖"
  },
  "description": "Flutter 测试: 单元/Widget/BLoC/Golden",
  "kind": "pattern",
  "doClause": "Write unit, widget, BLoC, and golden tests following the test pyramid",
  "language": "dart",
  "headers": ["import 'package:flutter_test/flutter_test.dart';", "import 'package:mocktail/mocktail.dart';"],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n编写测试代码时参考。",
  "reasoning": {
    "whyStandard": "Flutter 官方测试指南 + bloc_test 文档",
    "sources": [
      "Flutter Testing Documentation",
      "bloc_test package",
      "mocktail package"
    ],
    "confidence": 0.9
  }
}
```

### 测试工具速查表

| 工具 | 用途 |
|------|------|
| `flutter_test` | Widget 测试 |
| `mocktail` / `mockito` | Mock 框架 |
| `bloc_test` | BLoC/Cubit 测试 |
| `golden_toolkit` | Golden 截图测试 |
| `integration_test` | 集成/E2E 测试 |
| `patrol` | 原生 UI 测试 |

---

## 12. 导航与路由

```json
{
  "title": "Dart: Flutter 路由最佳实践",
  "content": {
    "markdown": "## Flutter: 声明式路由 (GoRouter)\n\n### 标准模式\n```dart\n// ✅ GoRouter 声明式路由\nfinal router = GoRouter(\n  initialLocation: '/',\n  redirect: (context, state) {\n    final isAuth = ref.read(authProvider).isAuthenticated;\n    if (!isAuth && !state.matchedLocation.startsWith('/login')) {\n      return '/login';\n    }\n    return null;\n  },\n  routes: [\n    GoRoute(\n      path: '/',\n      builder: (context, state) => const HomePage(),\n      routes: [\n        GoRoute(\n          path: 'users/:id',\n          builder: (context, state) {\n            final id = int.parse(state.pathParameters['id']!);\n            return UserDetailPage(userId: id);\n          },\n        ),\n      ],\n    ),\n    GoRoute(\n      path: '/login',\n      builder: (context, state) => const LoginPage(),\n    ),\n  ],\n);\n\n// ✅ 类型安全路由 (go_router_builder)\n@TypedGoRoute<HomeRoute>(path: '/')\nclass HomeRoute extends GoRouteData {\n  const HomeRoute();\n  @override\n  Widget build(BuildContext context, GoRouterState state) => const HomePage();\n}\n\n// ✅ 导航\ncontext.go('/users/42');           // 替换\ncontext.push('/users/42');         // 压栈\ncontext.pop();                     // 返回\nconst HomeRoute().go(context);     // 类型安全\n```",
    "pattern": "final router = GoRouter(\n  routes: [\n    GoRoute(path: '/', builder: (_, __) => const HomePage()),\n  ],\n);\ncontext.go('/users/42');",
    "rationale": "GoRouter 是 Flutter 官方推荐的声明式路由方案，支持深链接和 Web"
  },
  "description": "Flutter 声明式路由 (GoRouter)",
  "kind": "pattern",
  "doClause": "Use GoRouter for declarative routing with type-safe navigation",
  "language": "dart",
  "headers": ["import 'package:go_router/go_router.dart';"],
  "knowledgeType": "architecture",
  "usageGuide": "### 使用场景\\n设计应用路由时参考。",
  "reasoning": {
    "whyStandard": "GoRouter 是 Flutter 官方维护的路由库",
    "sources": [
      "go_router documentation",
      "Flutter Navigation and Routing"
    ],
    "confidence": 0.9
  }
}
```

---

## 13. 平台通道与 FFI

```json
{
  "title": "Dart: 平台通道与 FFI",
  "content": {
    "markdown": "## Flutter: 平台通道\n\n### MethodChannel (消息传递)\n```dart\n// ✅ Dart 侧\nclass BatteryService {\n  static const _channel = MethodChannel('com.example/battery');\n\n  Future<int> getBatteryLevel() async {\n    final level = await _channel.invokeMethod<int>('getBatteryLevel');\n    return level ?? -1;\n  }\n}\n\n// ✅ Android 侧 (Kotlin)\nclass MainActivity : FlutterActivity() {\n  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {\n    MethodChannel(flutterEngine.dartExecutor, \"com.example/battery\")\n      .setMethodCallHandler { call, result ->\n        if (call.method == \"getBatteryLevel\") {\n          result.success(getBatteryLevel())\n        } else {\n          result.notImplemented()\n        }\n      }\n  }\n}\n```\n\n### Pigeon (类型安全)\n```dart\n// ✅ 用 Pigeon 生成类型安全的通道代码\n@HostApi()\nabstract class BatteryApi {\n  int getBatteryLevel();\n  bool isCharging();\n}\n\n// 自动生成 Dart + Kotlin/Swift 代码\n// pigeon --input pigeons/battery.dart\n```\n\n### dart:ffi (C 互操作)\n```dart\n// ✅ FFI 调用原生库\nfinal dylib = DynamicLibrary.open('libnative.so');\ntypedef NativeAdd = Int32 Function(Int32, Int32);\ntypedef DartAdd = int Function(int, int);\nfinal add = dylib.lookupFunction<NativeAdd, DartAdd>('add');\nprint(add(3, 4)); // 7\n```",
    "pattern": "static const _channel = MethodChannel('com.example/battery');\nfinal level = await _channel.invokeMethod<int>('getBatteryLevel');",
    "rationale": "MethodChannel 适合简单 RPC；Pigeon 消除手动序列化错误；FFI 适合高性能 C 库调用"
  },
  "description": "Flutter 平台通道: MethodChannel / Pigeon / FFI",
  "kind": "fact",
  "doClause": "Use Pigeon for type-safe platform channels, FFI for C interop",
  "language": "dart",
  "headers": ["import 'package:flutter/services.dart';"],
  "knowledgeType": "architecture",
  "usageGuide": "### 使用场景\\n需要调用原生平台 API 时参考。",
  "reasoning": {
    "whyStandard": "Flutter 官方平台交互文档",
    "sources": [
      "Flutter Platform Channels",
      "Pigeon documentation",
      "dart:ffi documentation"
    ],
    "confidence": 0.85
  }
}
```

---

## 14. 性能优化

```json
{
  "title": "Dart: Flutter 性能优化",
  "content": {
    "markdown": "## Flutter: 性能优化\n\n### Widget 重建优化\n```dart\n// ✅ const Widget — 避免不必要重建\nconst SizedBox(height: 16);\nconst Divider();\nconst AppHeader(title: 'Home');\n\n// ✅ RepaintBoundary — 隔离重绘区域\nRepaintBoundary(\n  child: ComplexAnimation(),\n)\n\n// ✅ 避免在 build 中创建对象\n// ❌ 错误\n@override\nWidget build(BuildContext context) {\n  final style = TextStyle(fontSize: 16);  // 每次 build 都创建\n  return Text('Hello', style: style);\n}\n\n// ✅ 正确\nstatic const _style = TextStyle(fontSize: 16);\n@override\nWidget build(BuildContext context) {\n  return const Text('Hello', style: _style);\n}\n```\n\n### 列表优化\n```dart\n// ✅ ListView.builder (懒加载)\nListView.builder(\n  itemCount: items.length,\n  itemBuilder: (context, index) => ItemCard(item: items[index]),\n)\n\n// ✅ 指定 itemExtent 提升滚动性能\nListView.builder(\n  itemCount: items.length,\n  itemExtent: 72,  // 固定高度\n  itemBuilder: (context, index) => ItemCard(item: items[index]),\n)\n\n// ❌ 避免 ListView(children: []) 一次加载所有子 Widget\n```\n\n### 图片优化\n```dart\n// ✅ 指定 cacheWidth/cacheHeight 降低解码内存\nImage.network(\n  imageUrl,\n  cacheWidth: 200,  // 按显示尺寸解码\n  cacheHeight: 200,\n)\n\n// ✅ 使用 cached_network_image\nCachedNetworkImage(\n  imageUrl: url,\n  placeholder: (_, __) => const Shimmer(),\n  errorWidget: (_, __, ___) => const Icon(Icons.error),\n)\n```",
    "pattern": "const Widget(...);\nRepaintBoundary(child: ...);\nListView.builder(itemExtent: 72, itemBuilder: ...);\nImage.network(url, cacheWidth: 200);",
    "rationale": "Flutter 60fps 要求每帧 16ms，优化 Widget 重建和图片解码是关键"
  },
  "description": "Flutter 性能优化: const Widget / RepaintBoundary / 列表懒加载",
  "kind": "rule",
  "doClause": "Use const constructors, RepaintBoundary, and ListView.builder for performance",
  "language": "dart",
  "headers": ["import 'package:flutter/material.dart';"],
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n需要优化 Flutter 渲染性能时参考。",
  "reasoning": {
    "whyStandard": "Flutter Performance Best Practices 官方文档",
    "sources": [
      "Flutter Performance Best Practices",
      "Flutter DevTools Profiling"
    ],
    "confidence": 0.9
  }
}
```

---

## 15. Dart (Flutter) 特有维度 (extraDimensions)

冷启动分析 Dart / Flutter 项目时，除了通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **Widget 设计模式** | StatelessWidget 拆分、const 使用率、组合 vs 继承 | `code-pattern` |
| **状态管理** | BLoC/Cubit/Riverpod/Provider/GetX 选型与使用模式 | `architecture` |
| **空安全** | nullable 使用、! 操作符频率、late 使用场景 | `code-standard` |
| **不可变模型** | Freezed 使用、sealed class/union type、copyWith 模式 | `code-pattern` |
| **路由架构** | GoRouter/auto_route 配置、深链接、路由守卫 | `architecture` |
| **异步模式** | Future/Stream 使用、StreamController 生命周期、取消策略 | `code-pattern` |
| **平台交互** | MethodChannel/Pigeon/FFI、iOS/Android 原生集成 | `architecture` |
| **测试覆盖** | Widget test/BLoC test/Golden test/Integration test 策略 | `best-practice` |
| **依赖注入** | get_it + injectable / Riverpod DI / Provider | `architecture` |
| **构建配置** | Flavors/多环境、build_runner、code generation | `config` |
| **性能** | const Widget、RepaintBoundary、ListView.builder、图片缓存 | `best-practice` |
| **项目布局** | Clean Architecture 分层、features/ 模块化、Melos monorepo | `architecture` |

---

## 关联 Skills

- **autosnippet-coldstart**: 冷启动分析模板
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-objc**: Objective-C 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-python**: Python 业界最佳实践参考
- **autosnippet-reference-java**: Java 业界最佳实践参考
- **autosnippet-reference-kotlin**: Kotlin 业界最佳实践参考
- **autosnippet-reference-go**: Go 业界最佳实践参考
```
