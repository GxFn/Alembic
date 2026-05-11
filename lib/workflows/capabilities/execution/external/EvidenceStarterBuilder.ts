import type {
  AstClassInfo,
  AstFileSummary,
  AstProtocolInfo,
  AstSummary,
  CallGraphResult,
  DependencyGraph,
  DependencyNode,
  DimensionDef,
  GuardAudit,
  GuardViolation,
} from '#types/project-snapshot.js';

export interface EvidenceStarterOpts {
  astData?: AstSummary | null;
  guardAudit?: GuardAudit | null;
  depGraphData?: DependencyGraph | null;
  callGraphResult?: CallGraphResult | null;
  panoramaResult?: Record<string, unknown> | null;
}

type EvidenceStarter = { hint: string; data: unknown };
type WeightedEvidenceStarter = EvidenceStarter & { strength: number };

export function buildEvidenceStarters(
  dim: DimensionDef,
  { astData, guardAudit, depGraphData, callGraphResult, panoramaResult }: EvidenceStarterOpts
): Record<string, WeightedEvidenceStarter> | undefined {
  const starters: Record<string, EvidenceStarter> = {};
  const dimId = dim.id;
  const dimLabel = (dim.label || '').toLowerCase();
  const dimGuide = (dim.guide || '').toLowerCase();
  const dimKeywords = `${dimLabel} ${dimGuide}`;

  if (astData) {
    const classes = astData.classes || [];
    const protocols = astData.protocols || [];
    const patterns = astData.patternStats || {};
    const fileSummaries = astData.fileSummaries || [];

    if (
      dimId === 'naming-conventions' ||
      dimId === 'code-standard' ||
      dimKeywords.includes('命名') ||
      dimKeywords.includes('naming')
    ) {
      const prefixStats: Record<string, number> = {};
      for (const cls of classes) {
        const prefix = (cls.name || '').match(/^[A-Z]{2,4}/)?.[0];
        if (prefix) {
          prefixStats[prefix] = (prefixStats[prefix] || 0) + 1;
        }
      }
      if (classes.length === 0) {
        const funcPrefixes: Record<string, number> = {};
        for (const fileSummary of fileSummaries) {
          for (const method of fileSummary.methods || []) {
            if (!method.className) {
              const functionPrefix = (method.name || '').match(
                /^(use|handle|get|set|create|make|fetch|on|is|has|with|to)[A-Z]/
              )?.[1];
              if (functionPrefix) {
                funcPrefixes[functionPrefix] = (funcPrefixes[functionPrefix] || 0) + 1;
              }
            }
          }
        }
        const topFuncPrefixes = (Object.entries(funcPrefixes) as [string, number][])
          .sort(([, left], [, right]) => right - left)
          .slice(0, 5);
        if (topFuncPrefixes.length > 0) {
          starters.functionNamingPatterns = {
            hint: '顶层函数命名前缀分布 — 用于分析函数式代码命名约定',
            data: topFuncPrefixes.map(([prefix, count]) => `${prefix}Xxx (${count} functions)`),
          };
        }
      }
      if (Object.keys(prefixStats).length > 0) {
        starters.namingPatterns = {
          hint: '项目类名前缀分布 — 用于分析命名约定',
          data: (Object.entries(prefixStats) as [string, number][])
            .sort((left, right) => right[1] - left[1])
            .slice(0, 5)
            .map(([prefix, count]) => `${prefix}* (${count} classes)`),
        };
      }
    }

    if (
      dimId === 'patterns-architecture' ||
      dimId === 'architecture' ||
      dimId === 'code-pattern' ||
      dimKeywords.includes('架构') ||
      dimKeywords.includes('pattern') ||
      dimKeywords.includes('模式')
    ) {
      if (Object.keys(patterns).length > 0) {
        const compactPatterns: Record<string, string | number | boolean> = {};
        for (const [key, val] of Object.entries(patterns)) {
          if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
            compactPatterns[key] = val;
          } else if (Array.isArray(val)) {
            compactPatterns[key] = `${val.length} items`;
          } else if (val && typeof val === 'object') {
            compactPatterns[key] = Object.keys(val).slice(0, 10).join(', ');
          }
        }
        starters.detectedPatterns = {
          hint: 'AST 自动检测到的设计模式 — 作为架构分析起点',
          data: compactPatterns,
        };
      }
      const baseClasses: Record<string, number> = {};
      for (const cls of classes) {
        if (cls.superclass) {
          baseClasses[cls.superclass] = (baseClasses[cls.superclass] || 0) + 1;
        }
      }
      const topBases = (Object.entries(baseClasses) as [string, number][])
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5);
      if (topBases.length > 0) {
        starters.inheritanceHotspots = {
          hint: '最常被继承的基类 — 关注其设计模式和扩展约定',
          data: topBases.map(([cls, count]) => `${cls} (${count} subclasses)`),
        };
      }
    }

    if (
      dimKeywords.includes('protocol') ||
      dimKeywords.includes('协议') ||
      dimKeywords.includes('interface')
    ) {
      if (protocols.length > 0) {
        starters.protocolSummary = {
          hint: `项目定义了 ${protocols.length} 个协议/接口`,
          data: protocols.slice(0, 8).map((protocol: AstProtocolInfo) => ({
            name: protocol.name,
            methods: protocol.methodCount || protocol.methods?.length || 0,
            conformers: (protocol.conformers || []).length,
          })),
        };
      }
    }

    const totalMethods = astData.projectMetrics?.totalMethods || 0;
    const fileCount = astData.fileCount || 0;
    if (classes.length === 0 && totalMethods > 0) {
      const exportCount = fileSummaries.reduce(
        (sum: number, fileSummary: AstFileSummary) => sum + (fileSummary.exports?.length || 0),
        0
      );
      const asyncCount = fileSummaries.reduce(
        (sum: number, fileSummary: AstFileSummary) =>
          sum +
          (fileSummary.methods || []).filter((method: { isAsync?: boolean }) => method.isAsync)
            .length,
        0
      );
      const complexMethods = astData.projectMetrics?.complexMethods || [];

      if (
        dimId === 'code-pattern' ||
        dimId === 'best-practice' ||
        dimId === 'event-and-data-flow' ||
        dimKeywords.includes('模式') ||
        dimKeywords.includes('实践') ||
        dimKeywords.includes('事件')
      ) {
        const summary = [
          `${totalMethods} functions across ${fileCount} files`,
          exportCount > 0 ? `${exportCount} exports` : null,
          asyncCount > 0 ? `${asyncCount} async functions` : null,
          complexMethods.length > 0 ? `${complexMethods.length} high-complexity functions` : null,
        ].filter(Boolean);
        if (summary.length > 0) {
          starters.codeSummary = {
            hint: '函数式代码结构统计 — 用于分析代码模式和最佳实践',
            data: summary,
          };
        }
      }
    }
  }

  if (guardAudit?.files) {
    const dimRelatedViolations: { file: string; rule: string; message: string }[] = [];
    for (const fileResult of guardAudit.files) {
      for (const violation of fileResult.violations || []) {
        const ruleText = `${violation.ruleId || ''} ${violation.message || ''}`.toLowerCase();
        if (dimId.split('-').some((word: string) => word.length > 3 && ruleText.includes(word))) {
          dimRelatedViolations.push({
            file: fileResult.filePath,
            rule: violation.ruleId || '',
            message: (violation.message || '').substring(0, 100),
          });
        }
      }
    }
    if (dimRelatedViolations.length > 0) {
      starters.guardViolations = {
        hint: `Guard 审计发现 ${dimRelatedViolations.length} 条与本维度相关的违规 — 可作为分析切入点`,
        data: dimRelatedViolations.slice(0, 5),
      };
    }

    const crossFileViolations = guardAudit.crossFileViolations || [];
    if (
      crossFileViolations.length > 0 &&
      (dimId === 'architecture' ||
        dimId === 'best-practice' ||
        dimId === 'code-standard' ||
        dimKeywords.includes('架构') ||
        dimKeywords.includes('层级') ||
        dimKeywords.includes('依赖方向'))
    ) {
      starters.crossFileViolations = {
        hint: `Guard 检测到 ${crossFileViolations.length} 条跨文件违规（如层级穿透、循环引用） — 这是架构分析的关键信号`,
        data: crossFileViolations.slice(0, 5).map((violation: GuardViolation) => ({
          rule: violation.ruleId,
          message: (violation.message || '').substring(0, 120),
          files: violation.locations?.slice(0, 2).map((location) => location.filePath) || [],
        })),
      };
    }
  }

  if (depGraphData?.nodes) {
    const nodeCount = (depGraphData.nodes || []).length;
    const edgeCount = (depGraphData.edges || []).length;
    if (
      nodeCount > 0 &&
      (dimId === 'patterns-architecture' ||
        dimId === 'architecture' ||
        dimId === 'data-flow-patterns' ||
        dimId === 'project-profile' ||
        dimId === 'module-export-scan' ||
        dimKeywords.includes('架构') ||
        dimKeywords.includes('模块') ||
        dimKeywords.includes('依赖'))
    ) {
      starters.dependencyOverview = {
        hint: `依赖图包含 ${nodeCount} 个模块、${edgeCount} 条依赖 — 分析模块间耦合关系`,
        data: {
          totalModules: nodeCount,
          totalEdges: edgeCount,
          topModules: (depGraphData.nodes || [])
            .slice(0, 5)
            .map((node: string | DependencyNode) =>
              typeof node === 'string' ? node : node.label || node.id
            ),
        },
      };
    }
  }

  if (astData) {
    const categories = astData.categories || [];
    if (
      categories.length > 0 &&
      (dimId === 'category-scan' ||
        dimId === 'category-extension' ||
        dimKeywords.includes('category') ||
        dimKeywords.includes('分类') ||
        dimKeywords.includes('extension'))
    ) {
      const catByBase: Record<string, string[]> = {};
      for (const category of categories) {
        const base = category.baseClass || category.extendedClass || 'Unknown';
        if (!catByBase[base]) {
          catByBase[base] = [];
        }
        catByBase[base].push(category.name || '(anonymous)');
      }
      const topBases = (Object.entries(catByBase) as [string, string[]][])
        .sort((left, right) => right[1].length - left[1].length)
        .slice(0, 8);
      starters.categorySummary = {
        hint: `项目定义了 ${categories.length} 个 Category — 关注命名前缀、功能归类、与基类的关系`,
        data: topBases.map(([base, categories]) => ({
          baseClass: base,
          categoryCount: categories.length,
          categories: categories.slice(0, 5),
        })),
      };
    }
  }

  if (
    astData &&
    (dimId === 'event-and-data-flow' ||
      dimId === 'data-flow-patterns' ||
      dimKeywords.includes('事件') ||
      dimKeywords.includes('event') ||
      dimKeywords.includes('数据流'))
  ) {
    const protocols = astData.protocols || [];
    const delegateProtocols = protocols.filter((protocol: AstProtocolInfo) => {
      const name = (protocol.name || '').toLowerCase();
      return name.includes('delegate') || name.includes('datasource');
    });
    if (delegateProtocols.length > 0) {
      starters.delegatePatterns = {
        hint: `发现 ${delegateProtocols.length} 个 Delegate/DataSource 协议 — 项目的核心事件/数据传递通道`,
        data: delegateProtocols.slice(0, 8).map((protocol: AstProtocolInfo) => ({
          name: protocol.name,
          methods: protocol.methodCount || protocol.methods?.length || 0,
        })),
      };
    }
    const classes = astData.classes || [];
    const observerClasses = classes.filter((cls: AstClassInfo) => {
      const name = (cls.name || '').toLowerCase();
      return name.includes('observer') || name.includes('notification') || name.includes('event');
    });
    if (observerClasses.length > 0) {
      starters.observerPatterns = {
        hint: `发现 ${observerClasses.length} 个 Observer/Notification/Event 类`,
        data: observerClasses.slice(0, 5).map((cls: AstClassInfo) => cls.name),
      };
    }
  }

  if (callGraphResult) {
    const callEdges = (callGraphResult as Record<string, unknown>).edgesCreated as
      | number
      | undefined;
    const methodEntities = (callGraphResult as Record<string, unknown>).entitiesUpserted as
      | number
      | undefined;
    if (
      callEdges &&
      callEdges > 0 &&
      (dimId === 'best-practice' ||
        dimId === 'event-and-data-flow' ||
        dimId === 'code-pattern' ||
        dimKeywords.includes('并发') ||
        dimKeywords.includes('concurrency') ||
        dimKeywords.includes('事件') ||
        dimKeywords.includes('flow'))
    ) {
      starters.callGraphSummary = {
        hint: `调用图包含 ${methodEntities || 0} 个方法实体、${callEdges} 条调用边 — 关注高扇入/扇出方法和异步调用链`,
        data: {
          methodEntities: methodEntities || 0,
          callEdges,
          durationMs: (callGraphResult as Record<string, unknown>).durationMs || 0,
          analysisHint:
            dimId === 'best-practice'
              ? '关注扇入最高的方法（核心抽象）和扇出最高的方法（协调者），以及 async/await 调用链'
              : dimId === 'event-and-data-flow'
                ? '关注数据流边和事件传播路径，特别是跨模块的观察者和回调链'
                : '关注方法调用模式中的设计模式（如 Template Method、Chain of Responsibility）',
        },
      };
    }
  }

  if (panoramaResult) {
    const panoramaModules = panoramaResult.modules as
      | Map<string, { name: string; fanIn: number; fanOut: number }>
      | undefined;
    const panoramaCycles =
      (panoramaResult.cycles as Array<{ cycle: string[]; severity: string }>) ?? [];

    if (
      panoramaModules instanceof Map &&
      (dimId === 'architecture' ||
        dimId === 'project-profile' ||
        dimId === 'best-practice' ||
        dimKeywords.includes('架构') ||
        dimKeywords.includes('模块') ||
        dimKeywords.includes('耦合'))
    ) {
      const hotspots: { module: string; fanIn: number; fanOut: number }[] = [];
      for (const [, mod] of panoramaModules) {
        if (mod.fanIn >= 5 || mod.fanOut >= 5) {
          hotspots.push({ module: mod.name, fanIn: mod.fanIn, fanOut: mod.fanOut });
        }
      }
      hotspots.sort((left, right) => right.fanIn + right.fanOut - (left.fanIn + left.fanOut));
      if (hotspots.length > 0) {
        starters.couplingHotspots = {
          hint: `全景分析发现 ${hotspots.length} 个高耦合模块 — 优先分析其架构边界和依赖方向`,
          data: hotspots
            .slice(0, 8)
            .map(
              (hotspot) => `${hotspot.module} (fanIn=${hotspot.fanIn}, fanOut=${hotspot.fanOut})`
            ),
        };
      }
    }

    if (
      panoramaCycles.length > 0 &&
      (dimId === 'architecture' ||
        dimId === 'best-practice' ||
        dimKeywords.includes('架构') ||
        dimKeywords.includes('依赖'))
    ) {
      starters.cyclicDependencies = {
        hint: `全景分析检测到 ${panoramaCycles.length} 组循环依赖 — 需要在分析中识别并记录`,
        data: panoramaCycles.slice(0, 5).map((cycle) => ({
          cycle: cycle.cycle.join(' → '),
          severity: cycle.severity,
        })),
      };
    }
  }

  if (Object.keys(starters).length === 0) {
    return undefined;
  }

  const withStrength: Record<string, WeightedEvidenceStarter> = {};
  for (const [key, value] of Object.entries(starters)) {
    let strength = 50;
    const dataArr = Array.isArray(value.data) ? value.data : null;
    const dataCount = dataArr ? dataArr.length : 0;

    if (key === 'namingPrefixSuffix' || key === 'patternStats' || key === 'inheritanceChains') {
      strength = Math.min(90, 40 + dataCount * 10);
    } else if (key === 'guardViolations') {
      const violations = (value.data as { totalViolations?: number })?.totalViolations || dataCount;
      strength = Math.min(95, 50 + violations * 5);
    } else if (key === 'crossFileViolations') {
      strength = Math.min(95, 75 + dataCount * 8);
    } else if (key === 'callGraphSummary') {
      const edges = (value.data as { callEdges?: number })?.callEdges ?? 0;
      strength = edges > 50 ? 85 : edges > 10 ? 70 : 55;
    } else if (key === 'couplingHotspots') {
      strength = Math.min(90, 60 + dataCount * 8);
    } else if (key === 'cyclicDependencies') {
      strength = Math.min(95, 70 + dataCount * 10);
    } else if (key === 'delegatePatterns' || key === 'observerPatterns') {
      strength = Math.min(85, 45 + dataCount * 8);
    } else if (key === 'depGraph') {
      strength = 60;
    }

    withStrength[key] = { ...value, strength };
  }

  return Object.fromEntries(
    Object.entries(withStrength).sort(([, left], [, right]) => right.strength - left.strength)
  );
}
