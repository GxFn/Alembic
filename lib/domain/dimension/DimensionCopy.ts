/**
 * @module DimensionCopyRegistry
 * @description 维度文案注册表 - 按编程语言提供差异化的 label 和 guide
 *
 * Bootstrap 的 baseDimensions 中每个维度的 label/guide 不再硬编码为 ObjC/Swift 视角，
 * 而是通过此注册表按项目主语言动态选择最匹配的文案。
 *
 * ---
 * 使用方式：
 *   import { DimensionCopy } from '#domain/dimension/DimensionCopy.js';
 *   const copy = DimensionCopy.get('design-patterns', 'python');
 *   // → { label: '设计模式与代码惯例', guide: '装饰器/描述器/上下文管理器/生成器/ABC 抽象基类/Mixin 模式' }
 */

import { getDimension } from './DimensionRegistry.js';

// ═══════════════════════════════════════════════════════════
// 语言族定义
// ═══════════════════════════════════════════════════════════

/**
 * 将具体语言归入语言族（用于文案选择 fallback）
 * @returns 语言族 ID
 */
function _langFamily(lang: string) {
  switch (lang) {
    case 'swift':
    case 'objectivec':
      return 'apple';
    case 'typescript':
    case 'javascript':
      return 'js';
    case 'java':
    case 'kotlin':
      return 'jvm';
    default:
      return lang; // python, go, rust, ruby 等本身就是族
  }
}

// ═══════════════════════════════════════════════════════════
// 通用维度文案 — 各语言差异化
// ═══════════════════════════════════════════════════════════

/**
 * 维度文案格式: { label: string, guide: string }
 * - `_default` 为兜底
 * - 按语言族 key (apple/js/jvm/python/go/rust/ruby) 覆盖
 *
 * 注意：条件维度（objc-deep-scan 等）不需要多语言文案，因为它们本身就是特定语言才激活
 */
const COPY_REGISTRY = {
  // ── ① 代码规范 ──────────────────────────────────────
  'coding-standards': {
    apple: {
      label: '代码规范',
      guide:
        '命名约定（类名前缀/方法签名风格/API 命名）、注释风格（语言/格式/MARK 分段）、文件组织规范',
    },
    js: {
      label: '代码规范',
      guide:
        '命名约定（camelCase/PascalCase/UPPER_CASE）、ESLint/Prettier 风格、文件/目录命名、注释与 JSDoc 规范',
    },
    jvm: {
      label: '代码规范',
      guide:
        '命名约定（类名/方法名/常量）、包结构组织、Javadoc/KDoc 注释规范、代码格式化（Checkstyle/ktlint）',
    },
    python: {
      label: '代码规范',
      guide:
        '命名约定（PEP 8 snake_case/PascalCase）、docstring 风格（Google/NumPy/Sphinx）、import 排序、Black/Ruff 格式化',
    },
    go: {
      label: '代码规范',
      guide: '命名约定（exported/unexported、MixedCaps）、gofmt 格式化、注释规范（godoc）、包组织',
    },
    dart: {
      label: '代码规范',
      guide:
        '命名约定（lowerCamelCase/UpperCamelCase/snake_case 文件名）、dart format 格式化、/// 文档注释、library 组织、effective dart 规范',
    },
    rust: {
      label: '代码规范',
      guide:
        '命名约定（snake_case/CamelCase）、rustfmt 格式化、/// 文档注释、模块组织（mod.rs/lib.rs）',
    },
  },

  // ── ② 设计模式与代码惯例 ─────────────────────────────
  'design-patterns': {
    apple: {
      label: '设计模式与代码惯例',
      guide: '单例/委托/Category·Extension/工厂/Builder/观察者/Coordinator 模式、继承关系',
    },
    js: {
      label: '设计模式与代码惯例',
      guide:
        '模块模式/工厂函数/观察者(EventEmitter)/中间件/高阶函数/组合模式、框架特有 Hooks/Composition 模式',
    },
    jvm: {
      label: '设计模式与代码惯例',
      guide:
        'Builder/Factory/Singleton/Strategy/Observer 模式、DI 容器注入模式、Repository/Service 分层惯例',
    },
    python: {
      label: '设计模式与代码惯例',
      guide:
        '装饰器/描述器/上下文管理器/生成器/ABC 抽象基类/Mixin 模式、dataclass/Protocol 接口惯例',
    },
    go: {
      label: '设计模式与代码惯例',
      guide:
        'functional options/table-driven tests/interface 消费侧定义/errgroup 并发/middleware 链/构造器函数',
    },
    dart: {
      label: '设计模式与代码惯例',
      guide:
        'Factory/Singleton/Repository/Builder 模式、Widget 组合模式、Mixin 复用、Extension 扩展、Freezed 不可变数据类、Provider/Riverpod 依赖注入',
    },
    rust: {
      label: '设计模式与代码惯例',
      guide:
        'Builder(owned self)/NewType/类型状态/From·Into 转换/Iterator 链/enum 代数类型/derive 宏',
    },
  },

  // ── ③ 架构模式 ──────────────────────────────────────
  architecture: {
    apple: {
      label: '架构模式',
      guide: '分层架构（MVVM/VIPER/TCA）、Package/Target 模块边界、依赖图、import 约束规则',
    },
    js: {
      label: '架构模式',
      guide:
        '分层架构（MVC/MVVM/Hexagonal）、monorepo/package 划分、barrel export 边界、循环依赖检测',
    },
    jvm: {
      label: '架构模式',
      guide:
        '分层架构（Controller→Service→Repository）、模块划分（multi-module/micro-service）、DI 容器组织、依赖反转',
    },
    python: {
      label: '架构模式',
      guide:
        '分层架构（Router→Service→Repository）、包结构（src layout/flat layout）、依赖注入、接口隔离',
    },
    go: {
      label: '架构模式',
      guide:
        '分层架构（Handler→Service→Repository）、internal 包隔离、接口在消费侧定义、依赖注入（wire/fx）',
    },
    dart: {
      label: '架构模式',
      guide:
        '分层架构（Presentation→Domain→Data）、Clean Architecture/MVVM、Package 模块化、Melos monorepo、barrel export 边界、依赖注入（get_it/injectable）',
    },
    rust: {
      label: '架构模式',
      guide: '分层架构、Workspace/crate 边界、pub/pub(crate) 可见性、trait object 抽象层',
    },
  },

  // ── ④ 错误韧性 ──────────────────────────────────────
  'error-resilience': {
    apple: {
      label: '最佳实践',
      guide:
        '错误处理、并发安全（Swift Concurrency/GCD）、内存管理（ARC/weak/unowned）、日志规范、XCTest 模式',
    },
    js: {
      label: '最佳实践',
      guide:
        '错误处理（try-catch/Error 边界）、异步安全（Promise/async-await）、内存泄漏检测、日志规范、Jest/Vitest 测试',
    },
    jvm: {
      label: '最佳实践',
      guide:
        '错误处理（checked/unchecked exception）、并发安全（synchronized/虚拟线程/协程）、连接池管理、日志（SLF4J）、JUnit 测试',
    },
    python: {
      label: '最佳实践',
      guide:
        '错误处理（except Exception/自定义异常）、并发（asyncio/threading/multiprocessing）、资源管理（with 语句）、日志（logging）、pytest 测试',
    },
    go: {
      label: '最佳实践',
      guide:
        '错误处理（error interface/wrapped errors）、并发安全（goroutine/channel/mutex）、defer 资源释放、结构化日志（slog）、table-driven tests',
    },
    dart: {
      label: '最佳实践',
      guide:
        '错误处理（try-catch/自定义 Exception）、异步安全（async-await/Stream/Completer）、内存管理（dispose/mounted 检查）、日志规范（logger 替代 print）、Widget 测试/集成测试/Golden 测试',
    },
    rust: {
      label: '最佳实践',
      guide:
        '错误处理（Result/? 操作符/thiserror）、并发安全（Send+Sync/Arc/Mutex）、生命周期管理、日志（tracing）、#[test] 模式',
    },
  },

  // ── ⑤ 数据与事件流 ─────────────────────────────────
  'data-event-flow': {
    apple: {
      label: '事件与数据流',
      guide:
        '事件传播（Delegate/Notification/Block·Closure/Target-Action）、数据状态管理（KVO/属性观察/Combine/SwiftUI State）',
    },
    js: {
      label: '事件与数据流',
      guide:
        '事件传播（EventEmitter/DOM Events/Custom Events）、状态管理（Redux/Vuex/Pinia/Zustand/Context）、响应式流（RxJS/Observable）',
    },
    jvm: {
      label: '事件与数据流',
      guide:
        '事件传播（Spring Events/LiveData/StateFlow/EventBus）、状态管理（ViewModel/Repository Cache）、消息队列（Kafka/RabbitMQ）',
    },
    python: {
      label: '事件与数据流',
      guide:
        '事件传播（Signal/Slot/Callback/asyncio Event）、状态管理（Pydantic Model/dataclass）、消息队列（Celery/Redis Pub-Sub）',
    },
    go: {
      label: '事件与数据流',
      guide:
        '事件传播（channel/context）、select 多路复用、fan-out/fan-in 模式、NATS/Redis Pub-Sub',
    },
    dart: {
      label: '事件与数据流',
      guide:
        '事件传播（Stream/StreamController/BroadcastStream）、状态管理（BLoC/Cubit/Provider/Riverpod/GetX/ValueNotifier）、响应式流（RxDart/StreamTransformer）、InheritedWidget 数据传递',
    },
    rust: {
      label: '事件与数据流',
      guide:
        '事件传播（tokio channel/crossbeam-channel）、Stream trait、Actor 模式（Actix）、状态管理（Arc<RwLock<T>>）',
    },
  },

  // ── ⑥ Agent 开发注意事项 ─────────────────────────────
  'agent-guidelines': {
    apple: {
      label: 'Agent 开发注意事项',
      guide:
        '三大核心原则（严谨性/深度特征挖掘/完整性）、命名强制、线程安全、内存约束、已废弃 API 标记、架构约束注释、TODO/FIXME',
    },
    js: {
      label: 'Agent 开发注意事项',
      guide:
        '三大核心原则（严谨性/深度特征挖掘/完整性）、命名约定遵循、类型安全（strict/no-any）、异步错误处理、已废弃 API 标记、ESLint 配置遵循',
    },
    jvm: {
      label: 'Agent 开发注意事项',
      guide:
        '三大核心原则（严谨性/深度特征挖掘/完整性）、命名约定遵循、线程安全、@Deprecated 标记、架构约束注释、Nullable 标注',
    },
    python: {
      label: 'Agent 开发注意事项',
      guide:
        '三大核心原则（严谨性/深度特征挖掘/完整性）、命名约定（PEP 8）、type hints 覆盖、已废弃 API 标记（DeprecationWarning）、docstring 覆盖',
    },
    go: {
      label: 'Agent 开发注意事项',
      guide:
        '三大核心原则（严谨性/深度特征挖掘/完整性）、命名约定遵循、error 必须处理、goroutine 泄漏防护、Deprecated 注释、go vet 通过',
    },
    dart: {
      label: 'Agent 开发注意事项',
      guide:
        '三大核心原则（严谨性/深度特征挖掘/完整性）、命名约定遵循（Effective Dart）、类型安全（避免 dynamic）、Widget 生命周期管理（dispose/mounted）、dart analyze 通过、避免 ! 空断言',
    },
    rust: {
      label: 'Agent 开发注意事项',
      guide:
        '三大核心原则（严谨性/深度特征挖掘/完整性）、命名约定遵循、unsafe 最小化、clippy lint 通过、#[deprecated] 标记、文档注释覆盖',
    },
  },
};

// ═══════════════════════════════════════════════════════════
// DimensionCopy — 文案查询服务
// ═══════════════════════════════════════════════════════════

export class DimensionCopy {
  /**
   * 获取指定维度在指定语言下的文案
   * @param dimId 维度 ID (如 'code-standard')
   * @param lang 主语言 ID (如 'python', 'typescript')
   * @returns | null}
   */
  static get(dimId: string, lang: string) {
    const entry = (
      COPY_REGISTRY as Record<string, Record<string, { label: string; guide: string }>>
    )[dimId];

    if (entry) {
      const family = _langFamily(lang);
      const match = entry[family] || entry[lang];
      if (match) {
        return match;
      }
    }

    // 回退到 Registry 元数据（消除 _default 双源）
    const dim = getDimension(dimId);
    if (dim) {
      return { label: dim.label, guide: dim.extractionGuide };
    }

    return null;
  }

  /**
   * 批量为维度数组注入语言差异化文案（单语言版本）
   * 会直接修改维度对象的 label 和 guide 字段
   * @param dimensions
   * @param lang 主语言
   * @returns >} 原数组引用
   */
  static apply(dimensions: Array<{ id: string; label: string; guide: string }>, lang: string) {
    for (const dim of dimensions) {
      const copy = DimensionCopy.get(dim.id, lang);
      if (copy) {
        dim.label = copy.label;
        dim.guide = copy.guide;
      }
    }
    return dimensions;
  }

  /**
   * 多语言版本 — 合并主语言 + 次要语言的 guide 文案
   *
   * 策略:
   *   - label 使用主语言的 label（各语言族 label 基本一致）
   *   - guide 以主语言为主体，追加次要语言的差异化要点
   *   - 如果主语言和次要语言属于同一语言族，跳过（避免重复）
   *
   * @param dimensions
   * @param primary 主语言 ID
   * @param secondary 次要语言 ID 列表
   * @returns >} 原数组引用
   */
  static applyMulti(
    dimensions: Array<{ id: string; label: string; guide: string }>,
    primary: string,
    secondary: string[] = []
  ) {
    if (!secondary || secondary.length === 0) {
      return DimensionCopy.apply(dimensions, primary);
    }

    const primaryFamily = _langFamily(primary);

    // 过滤掉与主语言同族的次要语言（如 swift + objectivec 同属 apple）
    const effectiveSecondary = secondary.filter((lang) => _langFamily(lang) !== primaryFamily);

    for (const dim of dimensions) {
      const primaryCopy = DimensionCopy.get(dim.id, primary);
      if (!primaryCopy) {
        continue;
      }

      dim.label = primaryCopy.label;

      if (effectiveSecondary.length === 0) {
        dim.guide = primaryCopy.guide;
        continue;
      }

      // 收集次要语言的差异化 guide 片段
      const secondaryGuides: string[] = [];
      const seenFamilies = new Set([primaryFamily]);
      for (const lang of effectiveSecondary) {
        const fam = _langFamily(lang);
        if (seenFamilies.has(fam)) {
          continue;
        } // 同族去重
        seenFamilies.add(fam);
        const copy = DimensionCopy.get(dim.id, lang);
        if (copy && copy.guide !== primaryCopy.guide) {
          const displayName = lang.charAt(0).toUpperCase() + lang.slice(1);
          secondaryGuides.push(`[${displayName}] ${copy.guide}`);
        }
      }

      dim.guide =
        secondaryGuides.length > 0
          ? `${primaryCopy.guide}\n${secondaryGuides.join('\n')}`
          : primaryCopy.guide;
    }
    return dimensions;
  }

  /** 获取所有已有文案的维度 ID 列表 */
  static registeredDimIds() {
    return Object.keys(COPY_REGISTRY);
  }

  /** 获取某维度所有可用语言族 */
  static availableFamilies(dimId: string) {
    const entry = (
      COPY_REGISTRY as Record<string, Record<string, { label: string; guide: string }>>
    )[dimId];
    if (!entry) {
      return [];
    }
    return Object.keys(entry).filter((k) => k !== '_default');
  }
}

export default DimensionCopy;
