---
name: autosnippet-reference-objc
description: Objective-C 业界最佳实践参考。涵盖命名前缀、属性声明、Delegate 模式、内存管理、nullability、错误处理，为冷启动分析提供高质量参考标准。
---

# Objective-C 最佳实践参考 (Industry Reference)

> 本 Skill 为 **autosnippet-coldstart** 的 Companion Skill。在冷启动分析 ObjC 项目时，请参考以下业界标准产出高质量候选。
> **来源**: Apple Coding Guidelines for Cocoa, Google Objective-C Style Guide

---

## 1. 命名前缀与规范

### 核心规则

| 标识符类型 | 规则 | 示例 |
|-----------|------|------|
| 类名 | 3+ 字符前缀 + UpperCamelCase | `ABCNetworkManager` |
| 协议 | 3+ 字符前缀 + UpperCamelCase | `ABCDataSourceDelegate` |
| Category 文件名 | `类名+Category名` | `NSString+ABCUtils.h` |
| Category 方法 | 小写前缀 + 下划线 | `abc_capitalizedString` |
| 方法名 | lowerCamelCase，读作句子 | `insertObject:atIndex:` |
| 属性 | lowerCamelCase | `userName`, `isEnabled` |
| 局部变量 | lowerCamelCase | `currentIndex` |
| 常量 | 前缀 + CamelCase | `ABCMaxRetryCount` |
| 枚举值 | 类型前缀 + 值名 | `ABCColorRed` |
| 宏 | SCREAMING_SNAKE | `ABC_DEPRECATED` |
| Notification | `<前缀><类名><Did|Will><动作>Notification` | `ABCUserDidLoginNotification` |

### 为什么用 3+ 字符前缀

```json
{
  "title": "ObjC 命名: 使用 3+ 字符类前缀避免冲突",
  "content": {
    "markdown": "## ObjC 命名: 使用 3+ 字符类前缀避免冲突\n\n### 标准模式\n```objective-c\n// ✅ 好的命名 — 3 字符前缀\n@interface ABCNetworkManager : NSObject\n@interface ABCUserProfileViewController : UIViewController\n\n// ❌ 差的命名\n@interface NetworkManager : NSObject  // 无前缀，可能与其他库冲突\n@interface NSUser : NSObject  // 使用系统前缀 NS\n@interface ABUser : NSObject  // 只有 2 字符\n```",
    "pattern": "// ✅ 好的命名 — 3 字符前缀\n@interface ABCNetworkManager : NSObject\n@interface ABCUserProfileViewController : UIViewController\n\n// ❌ 差的命名\n@interface NetworkManager : NSObject  // 无前缀，可能与其他库冲突\n@interface NSUser : NSObject  // 使用系统前缀 NS\n@interface ABUser : NSObject  // 只有 2 字符",
    "rationale": "Objective-C 无命名空间，类前缀是避免符号冲突的唯一手段。Apple 保留 2 字符前缀（NS/UI/CG 等），三方代码应用 3+ 字符。"
  },
  "description": "ObjC 命名: 使用 3+ 字符类前缀避免冲突",
  "kind": "rule",
  "doClause": "Apply the ObjC 命名 pattern as described",
  "language": "objective-c",
  "headers": [],
  "category": "Tool",
  "knowledgeType": "code-standard",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取ObjC 命名: 使用 3+ 字符类前缀避免冲突的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "@interface User : NSObject",
    "why": "ObjC 中无命名前缀的类在大型项目或依赖多库时极易命名冲突",
    "fix": "@interface ABCUser : NSObject  // 使用项目 3 字符前缀"
  },
  "reasoning": {
    "whyStandard": "Google ObjC Style Guide 明确要求 3+ 字符前缀，Apple 2 字符已被系统框架保留",
    "sources": [
      "Google Objective-C Style Guide",
      "Apple Coding Guidelines for Cocoa"
    ],
    "confidence": 0.95
  }
}
```

### Category 命名

```objc
// ✅ Category 方法必须加前缀避免冲突
@interface NSString (ABCHTMLUtils)
- (NSString *)abc_stringByUnescapingHTML;
- (NSString *)abc_stringByEscapingHTML;
@end

// ❌ 不加前缀 — 可能覆盖系统方法或与其他库冲突
@interface NSString (HTMLUtils)
- (NSString *)stringByUnescapingHTML;  // 危险!
@end
```

---

## 2. 属性声明 (Properties)

### 属性修饰符选择

| 类型 | 修饰符 | 原因 |
|------|--------|------|
| `NSString` | `copy` | 防止 NSMutableString 被外部修改 |
| `NSArray` | `copy` | 防止 NSMutableArray 被外部修改 |
| `NSDictionary` | `copy` | 防止 NSMutableDictionary 被外部修改 |
| `NSNumber` | `copy` | 值语义 |
| `Block` | `copy` | 将栈 block 拷贝到堆 |
| `Delegate` | `weak` | 避免 retain cycle |
| `IBOutlet` | `weak` | 被 superview 持有 |
| `NSObject` 子类 | `strong` | 默认 |

### 候选模板

```json
{
  "title": "ObjC 属性: NSString 必须用 copy",
  "content": {
    "markdown": "## ObjC 属性: NSString 必须用 copy\n\n### 标准模式\n```objective-c\n// ✅ 正确: NSString 属性用 copy\n@interface ABCUser : NSObject\n@property (nonatomic, copy) NSString *name;\n@property (nonatomic, copy) NSArray<NSString *> *tags;\n@property (nonatomic, weak) id<ABCUserDelegate> delegate;\n@property (nonatomic, strong) ABCProfile *profile;\n@end\n\n// ❌ 危险: NSString 属性用 strong\n@property (nonatomic, strong) NSString *name;\n// 如果传入 NSMutableString 并之后修改:\n// NSMutableString *m = [NSMutableString stringWithString:@\"Alice\"];\n// user.name = m;\n// [m appendString:@\" (hacked)\"];\n// user.name 会变成 \"Alice (hacked)\"!\n```",
    "pattern": "// ✅ 正确: NSString 属性用 copy\n@interface ABCUser : NSObject\n@property (nonatomic, copy) NSString *name;\n@property (nonatomic, copy) NSArray<NSString *> *tags;\n@property (nonatomic, weak) id<ABCUserDelegate> delegate;\n@property (nonatomic, strong) ABCProfile *profile;\n@end\n\n// ❌ 危险: NSString 属性用 strong\n@property (nonatomic, strong) NSString *name;\n// 如果传入 NSMutableString 并之后修改:\n// NSMutableString *m = [NSMutableString stringWithString:@\"Alice\"];\n// user.name = m;\n// [m appendString:@\" (hacked)\"];\n// user.name 会变成 \"Alice (hacked)\"!",
    "rationale": "copy 语义保证属性值不会被外部 mutable 子类修改，是 Cocoa 编程的基础安全准则"
  },
  "description": "ObjC 属性: NSString 必须用 copy",
  "kind": "pattern",
  "doClause": "Apply the ObjC 属性 pattern as described",
  "language": "objective-c",
  "headers": [],
  "category": "Model",
  "knowledgeType": "best-practice",
  "usageGuide": "### 使用场景\\n触发 `@trigger` 获取ObjC 属性: NSString 必须用 copy的标准实现模式。",
  "scope": "universal",
  "antiPattern": {
    "bad": "@property (nonatomic, strong) NSString *title;",
    "why": "如果外部传入 NSMutableString 并修改，strong 引用会看到变化",
    "fix": "@property (nonatomic, copy) NSString *title;"
  },
  "reasoning": {
    "whyStandard": "Apple Memory Management Guide 和 Google ObjC Style Guide 都要求对值类型集合用 copy",
    "sources": [
      "Apple Memory Management Programming Guide",
      "Google Objective-C Style Guide"
    ],
    "confidence": 0.95
  }
}
```

---

## 3. Delegate 模式

### 标准实现

```objc
// ✅ 标准 Delegate 模式
@class ABCDataLoader;

@protocol ABCDataLoaderDelegate <NSObject>
@required
- (void)dataLoader:(ABCDataLoader *)loader didFinishWithData:(NSData *)data;
- (void)dataLoader:(ABCDataLoader *)loader didFailWithError:(NSError *)error;

@optional
- (void)dataLoaderDidStartLoading:(ABCDataLoader *)loader;
- (void)dataLoader:(ABCDataLoader *)loader didUpdateProgress:(float)progress;
@end

@interface ABCDataLoader : NSObject
@property (nonatomic, weak) id<ABCDataLoaderDelegate> delegate;  // 必须 weak!
- (void)startLoading;
@end

@implementation ABCDataLoader
- (void)startLoading {
  // 检查 optional 方法
  if ([self.delegate respondsToSelector:@selector(dataLoaderDidStartLoading:)]) {
    [self.delegate dataLoaderDidStartLoading:self];
  }
  // ...
  [self.delegate dataLoader:self didFinishWithData:data];
}
@end
```

### Delegate 方法命名规范

| 规则 | 示例 |
|------|------|
| 第一个参数传递 sender | `(ABCDataLoader *)loader` |
| did + 过去式表示已完成 | `didFinishWithData:` |
| will + 原形表示即将发生 | `willStartLoading` |
| should + 原形表示询问 | `shouldAllowEditing` → 返回 BOOL |
| 无前缀动词表示动作 | `dataLoaderDidStartLoading:` |

---

## 4. 指定初始化器 (Designated Initializer)

```objc
// ✅ 正确的初始化器链
@interface ABCPerson : NSObject
@property (nonatomic, copy) NSString *name;
@property (nonatomic, assign) NSInteger age;

// 指定初始化器 — 用 NS_DESIGNATED_INITIALIZER 标记
- (instancetype)initWithName:(NSString *)name
                         age:(NSInteger)age NS_DESIGNATED_INITIALIZER;
@end

@implementation ABCPerson

// 指定初始化器: 调用 super 的指定初始化器
- (instancetype)initWithName:(NSString *)name age:(NSInteger)age {
  self = [super init];
  if (self) {
    _name = [name copy];
    _age = age;
  }
  return self;
}

// 便利初始化器: 调用自己的指定初始化器
- (instancetype)init {
  return [self initWithName:@"Unknown" age:0];
}

@end
```

---

## 5. Nullability 注解

### 核心规则

```objc
// ✅ 推荐: 整个头文件用宏包裹
NS_ASSUME_NONNULL_BEGIN

@interface ABCUserService : NSObject

// 默认 nonnull — 不需要标注
- (ABCUser *)currentUser;
- (void)loginWithUsername:(NSString *)username
                password:(NSString *)password
              completion:(void (^)(ABCUser *user, NSError *error))completion;

// nullable 需要显式标注
@property (nonatomic, strong, nullable) ABCUser *cachedUser;
- (nullable ABCUser *)userWithID:(NSString *)userID;

@end

NS_ASSUME_NONNULL_END
```

### nullability 速查

| 注解 | 含义 | Swift 对应 |
|------|------|-----------|
| `nonnull` | 不可为 nil | `T` |
| `nullable` | 可以为 nil | `T?` |
| `null_unspecified` | 未指定 (legacy) | `T!` |
| `null_resettable` | getter nonnull, setter nullable | `T!` (属性) |

---

## 6. 错误处理 (NSError)

### 标准 NSError 模式

```objc
// ✅ 标准 NSError 模式
// 定义 Error Domain 和 Code
NSString * const ABCNetworkErrorDomain = @"com.abc.network";

typedef NS_ERROR_ENUM(ABCNetworkErrorDomain, ABCNetworkErrorCode) {
  ABCNetworkErrorCodeInvalidURL = 1001,
  ABCNetworkErrorCodeTimeout = 1002,
  ABCNetworkErrorCodeUnauthorized = 1003,
};

// 使用
- (BOOL)saveData:(NSData *)data error:(NSError **)error {
  if (!data) {
    if (error) {
      *error = [NSError errorWithDomain:ABCNetworkErrorDomain
                                   code:ABCNetworkErrorCodeInvalidURL
                               userInfo:@{NSLocalizedDescriptionKey: @"Data is nil"}];
    }
    return NO;
  }
  // ...
  return YES;
}

// 调用
NSError *error = nil;
BOOL success = [service saveData:data error:&error];
if (!success) {
  NSLog(@"Error: %@", error.localizedDescription);
}
```

### 错误处理反模式

| 反模式 | 问题 | 修正 |
|--------|------|------|
| `@throw` 用于常规错误 | ObjC 异常不应用于流程控制 | 用 `NSError **` 参数 |
| 忽略 error 参数 | `[obj doThing:nil]` 丢失错误信息 | 传入 `&error` 并检查 |
| 硬编码 domain 字符串 | 碎片化、难以搜索 | 用 `const NSString *` 常量 |

---

## 7. BOOL 陷阱

```objc
// ❌ 危险: BOOL 比较
if (someValue == YES) { ... }  // BOOL 是 signed char，非 0/1 值会出问题
if (someValue == NO)  { ... }  // 类似问题

// ✅ 正确: 直接判断
if (someValue) { ... }
if (!someValue) { ... }

// ❌ 危险: 用强制转换赋值
BOOL b = (BOOL)someIntValue;  // 如果 int 值为 256 (0x100)，低 8 位为 0 → NO!

// ✅ 正确: 用双重否定或比较
BOOL b = !!someIntValue;
BOOL b = (someIntValue != 0);
```

---

## 8. GCD / 线程安全

```objc
// ✅ 串行队列保护共享状态
@interface ABCCache ()
@property (nonatomic, strong) NSMutableDictionary *store;
@property (nonatomic, strong) dispatch_queue_t syncQueue;
@end

@implementation ABCCache

- (instancetype)init {
  self = [super init];
  if (self) {
    _store = [NSMutableDictionary dictionary];
    _syncQueue = dispatch_queue_create("com.abc.cache", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

// 读操作
- (id)objectForKey:(NSString *)key {
  __block id result;
  dispatch_sync(self.syncQueue, ^{
    result = self.store[key];
  });
  return result;
}

// 写操作
- (void)setObject:(id)obj forKey:(NSString *)key {
  dispatch_async(self.syncQueue, ^{
    self.store[key] = obj;
  });
}

@end
```

### 主线程 UI 操作

```objc
// ✅ 回主线程更新 UI
dispatch_async(dispatch_get_main_queue(), ^{
  self.label.text = result;
  [self.tableView reloadData];
});

// ✅ 安全检查当前是否主线程
if ([NSThread isMainThread]) {
  [self updateUI];
} else {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self updateUI];
  });
}
```

---

## 9. Lightweight Generics (泛型)

```objc
// ✅ 使用轻量级泛型提高类型安全
@property (nonatomic, copy) NSArray<NSString *> *names;
@property (nonatomic, copy) NSDictionary<NSString *, ABCUser *> *userMap;
@property (nonatomic, copy) NSSet<NSNumber *> *selectedIDs;

// ✅ 自定义泛型类
@interface ABCStack<__covariant ObjectType> : NSObject
- (void)push:(ObjectType)object;
- (ObjectType)pop;
@property (nonatomic, readonly) ObjectType topObject;
@end

// ❌ 不使用泛型 — 类型不安全
@property (nonatomic, copy) NSArray *names;  // 元素类型未知
```

---

## 10. Import 规范

```objc
// ✅ 推荐顺序
#import "ABCMyClass.h"           // 1. 对应的头文件

#import <Foundation/Foundation.h> // 2. 系统框架
#import <UIKit/UIKit.h>

#import <AFNetworking/AFNetworking.h>  // 3. 第三方库

#import "ABCConstants.h"          // 4. 项目内其他文件
#import "ABCNetworkManager.h"

// ✅ 头文件中用 @class 前向声明，减少编译依赖
@class ABCUser;
@class ABCProfile;

@interface ABCUserViewController : UIViewController
@property (nonatomic, strong) ABCUser *user;
@end
```

---

## 11. ObjC 特有维度 (extraDimensions)

冷启动分析 ObjC 项目时，除了 9 通用维度，还应额外关注：

| 额外维度 | 寻找什么 | 候选类型 |
|---------|---------|---------|
| **属性修饰符** | copy/strong/weak 使用是否正确 | `code-standard` |
| **Nullability** | 是否有 NS_ASSUME_NONNULL + nullable 标注 | `code-standard` |
| **Category 使用** | 方法前缀、合理拆分、避免覆盖 | `code-pattern` |
| **Block 内存管理** | __weak / __strong dance | `best-practice` |
| **GCD 模式** | 串行队列同步、主线程 UI | `code-pattern` |
| **前缀一致性** | 项目统一使用同一前缀 | `code-standard` |
| **Modern ObjC 语法** | 字面量、下标、泛型 | `code-standard` |

---

## Related Skills

- **autosnippet-coldstart**: 完整冷启动流程（本 Skill 的主 Skill）
- **autosnippet-reference-swift**: Swift 业界最佳实践参考
- **autosnippet-reference-jsts**: JavaScript/TypeScript 业界最佳实践参考
- **autosnippet-reference-dart**: Dart (Flutter) 业界最佳实践参考
