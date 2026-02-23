/**
 * dimension-configs.js — v3.0 维度配置 + Tier Reflection
 *
 * 从 orchestrator.js 拆分，包含:
 * - DIMENSION_CONFIGS_V3: 所有维度的配置定义
 * - buildTierReflection: Tier 级反思聚合 (规则化, 不需要 AI)
 *
 * @module pipeline/dimension-configs
 */

// ──────────────────────────────────────────────────────────────────
// v3.0 维度配置 (增加 focusAreas 用于 Analyst prompt)
// ──────────────────────────────────────────────────────────────────

export const DIMENSION_CONFIGS_V3 = {
  'project-profile': {
    label: '项目概貌',
    guide: '分析项目的整体结构、技术栈、模块划分和入口点。',
    focusAreas: ['项目结构和模块划分', '技术栈和框架依赖', '核心入口点和启动流程'],
    outputType: 'dual',
    allowedKnowledgeTypes: ['architecture'],
  },
  'objc-deep-scan': {
    label: '深度扫描（常量/Hook）',
    guide: '扫描 #define 宏、extern/static 常量、Method Swizzling hook。',
    focusAreas: [
      '#define 值宏和函数宏',
      'extern/static 常量定义',
      'Method Swizzling hook 和 load/initialize 方法',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'code-pattern'],
  },
  'category-scan': {
    label: '基础类分类方法扫描',
    guide: '扫描 Foundation/UIKit 的 Category/Extension 方法及其实现。',
    focusAreas: [
      'NSString/NSArray/NSDictionary 等基础类的 Category',
      'UIView/UIColor/UIImage 等 UI 组件的 Category',
      '各 Category 方法的使用场景和频率',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'code-pattern'],
  },
  'code-standard': {
    label: '代码规范',
    guide: '分析项目的命名约定、注释风格、文件组织方式。',
    focusAreas: [
      '类名前缀和命名约定 (BD/BDUIKit 等)',
      '方法签名风格和 API 命名',
      '注释风格 (语言/格式/MARK 分段)',
      '文件组织和目录规范',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'code-style'],
  },
  architecture: {
    label: '架构模式',
    guide: '分析项目的分层架构、模块职责和依赖关系。',
    focusAreas: [
      '分层架构 (MVC/MVVM/其他)',
      '模块间通信方式 (Protocol/Notification/Target-Action)',
      '依赖管理和服务注册',
      '模块边界约束',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['architecture', 'module-dependency', 'boundary-constraint'],
  },
  'code-pattern': {
    label: '设计模式',
    guide: '识别项目中使用的设计模式和架构模式。',
    focusAreas: [
      '创建型模式 (Singleton, Factory, Builder)',
      '结构型模式 (Proxy, Adapter, Decorator, Composite)',
      '行为型模式 (Observer, Strategy, Template Method, Delegate)',
      '架构模式 (MVC/MVVM, Service Locator, Coordinator)',
    ],
    outputType: 'candidate',
    allowedKnowledgeTypes: ['code-pattern', 'code-relation', 'inheritance'],
  },
  'event-and-data-flow': {
    label: '事件与数据流',
    guide: '分析事件传播和数据状态管理方式。',
    focusAreas: [
      '事件传播 (Delegate/Notification/Block/Target-Action)',
      '数据状态管理 (KVO/属性观察/响应式)',
      '数据持久化方案',
      '数据流转路径和状态同步',
    ],
    outputType: 'candidate',
    allowedKnowledgeTypes: ['call-chain', 'data-flow', 'event-and-data-flow'],
  },
  'best-practice': {
    label: '最佳实践',
    guide: '分析错误处理、并发安全、内存管理等工程实践。',
    focusAreas: [
      '错误处理策略和模式',
      '并发安全 (GCD/NSOperation/锁)',
      '内存管理 (ARC 下的弱引用/循环引用处理)',
      '日志规范和调试基础设施',
    ],
    outputType: 'candidate',
    allowedKnowledgeTypes: ['best-practice'],
  },
  'agent-guidelines': {
    label: '项目开发强制规范',
    guide: '总结在此项目开发时必须遵守的强制规则和约束。',
    focusAreas: [
      '命名强制规则和前缀约定',
      '线程安全约束',
      '已废弃 API 标记',
      '架构约束注释 (TODO/FIXME)',
    ],
    outputType: 'skill',
    allowedKnowledgeTypes: ['boundary-constraint', 'code-standard'],
  },

  // ── 语言条件维度（v3.1: 多语言支持）──────────────────────

  'module-export-scan': {
    label: '模块导出分析',
    guide: '分析 TS/JS 模块的导出结构和 public API surface。',
    focusAreas: [
      'barrel export 结构和 re-export 链路',
      'public API surface 合规性',
      'tree-shaking 兼容性',
      '循环依赖检测',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'architecture'],
  },
  'framework-convention-scan': {
    label: '框架约定扫描',
    guide: '分析前端框架约定（组件结构、状态管理、路由）。',
    focusAreas: [
      '组件目录结构和命名约定',
      '状态管理模式 (Redux/Vuex/Pinia/Zustand)',
      '路由约定和数据获取模式',
      '样式约定 (CSS Module/Tailwind/CSS-in-JS)',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'architecture'],
  },
  'python-package-scan': {
    label: 'Python 包结构分析',
    guide: '分析 Python 包的导入风格、类型标注和 __init__.py 策略。',
    focusAreas: [
      '__init__.py 导出策略和 __all__ 定义',
      '相对/绝对导入风格',
      'type hints 覆盖率和 Protocol 使用',
      'decorator 使用模式',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-standard', 'architecture'],
  },
  'jvm-annotation-scan': {
    label: '注解/Annotation 扫描',
    guide: '扫描 Java/Kotlin 项目中的 DI、ORM、API 注解使用模式。',
    focusAreas: [
      'DI 注解 (@Inject/@Autowired/@Component)',
      'ORM 注解 (@Entity/@Table/@Column)',
      'API 注解 (@RestController/@RequestMapping)',
      '自定义注解和元编程模式',
    ],
    outputType: 'dual',
    allowedKnowledgeTypes: ['code-pattern', 'architecture'],
  },
};

// ──────────────────────────────────────────────────────────────────
// v4.0: Tier Reflection — 综合分析 (规则化, 不需要 AI)
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Tier 级 Reflection — 在每个 Tier 完成后调用
 *
 * 无需 AI 调用，通过规则化聚合维度发现:
 * - 收集所有维度的关键发现并按重要性排序
 * - 检测跨维度重复模式
 * - 为下一 Tier 生成建议
 *
 * @param {number} tierIndex — Tier 索引 (0-based)
 * @param {Map<string, object>} tierResults — 本 Tier 的维度结果
 * @param {import('./EpisodicMemory.js').EpisodicMemory} episodicMemory
 * @returns {object} TierReflection
 */
export function buildTierReflection(tierIndex, tierResults, episodicMemory) {
  const completedDimensions = [...tierResults.keys()];

  // 收集本 Tier 所有维度的 findings
  const allFindings = [];
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    if (report?.findings) {
      for (const f of report.findings) {
        allFindings.push({ dimId, ...f });
      }
    }
  }

  // Top findings by importance
  const topFindings = allFindings
    .sort((a, b) => (b.importance || 5) - (a.importance || 5))
    .slice(0, 10);

  // 检测跨维度模式 (多个维度提到同一文件/关键词)
  const fileMentions = {};
  const keywordMentions = {};

  for (const f of allFindings) {
    // 统计文件引用频率
    if (f.evidence) {
      const file = f.evidence.split(':')[0];
      if (file) {
        fileMentions[file] = (fileMentions[file] || 0) + 1;
      }
    }
    // 统计关键词
    const words = (f.finding || '').split(/[\s,，。.]+/).filter((w) => w.length > 3);
    for (const w of words) {
      keywordMentions[w] = (keywordMentions[w] || 0) + 1;
    }
  }

  const crossDimensionPatterns = [];

  // 多维度引用的文件 = 跨维度热点
  for (const [file, count] of Object.entries(fileMentions)) {
    if (count >= 2) {
      crossDimensionPatterns.push(`文件 "${file}" 被 ${count} 个维度引用 — 可能是系统核心组件`);
    }
  }

  // 多维度提及的关键词
  for (const [word, count] of Object.entries(keywordMentions)) {
    if (count >= 3) {
      crossDimensionPatterns.push(`关键词 "${word}" 出现 ${count} 次 — 跨维度关联主题`);
    }
  }

  // 为下一 Tier 生成建议
  const suggestionsForNextTier = [];

  // 找出 gaps (各维度报告的未覆盖方面)
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    const gaps = report?.digest?.gaps || [];
    for (const gap of gaps) {
      if (gap && typeof gap === 'string' && gap.length > 5) {
        suggestionsForNextTier.push(`[${dimId}] 未覆盖: ${gap}`);
      }
    }
  }

  // remainingTasks
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    const remaining = report?.digest?.remainingTasks || [];
    for (const task of remaining) {
      if (task?.signal) {
        suggestionsForNextTier.push(
          `[${dimId}] 遗留信号: ${task.signal} (${task.reason || '未处理'})`
        );
      }
    }
  }

  return {
    tierIndex,
    completedDimensions,
    topFindings,
    crossDimensionPatterns: crossDimensionPatterns.slice(0, 5),
    suggestionsForNextTier: suggestionsForNextTier.slice(0, 8),
  };
}
