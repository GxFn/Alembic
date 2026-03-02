/**
 * ast-graph.js — AST 结构化分析 + Agent Memory 工具 (10)
 *
 * 44. get_project_overview  项目 AST 概览
 * 45. get_class_hierarchy   类继承层级
 * 46. get_class_info        类详细信息
 * 47. get_protocol_info     协议详细信息
 * 48. get_method_overrides  方法覆写查询
 * 49. get_category_map      Category 扩展映射
 * 50. get_previous_analysis 前序维度分析结果
 * 51. note_finding          记录关键发现
 * 52. get_previous_evidence 检索前序维度证据
 * 53. query_code_graph      查询代码实体图谱
 */

// ════════════════════════════════════════════════════════════
// AST 结构化分析 (7) — v3.0 AI-First Bootstrap AST 工具
// ════════════════════════════════════════════════════════════

/**
 * 辅助: 安全获取 ProjectGraph 实例
 * @param {object} ctx
 * @returns {import('../../../core/ast/ProjectGraph.js').default|null}
 */
function _getProjectGraph(ctx) {
  try {
    return ctx.container?.get('projectGraph') || null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// 44. get_project_overview — 项目 AST 概览
// ────────────────────────────────────────────────────────────
export const getProjectOverview = {
  name: 'get_project_overview',
  description:
    '获取项目的整体结构概览：文件统计、模块列表、入口点、类/协议/Category 数量。' +
    '适用场景：了解项目规模和架构布局，规划探索路径。',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) {
      return 'AST 分析不可用 — ProjectGraph 未构建。请检查 tree-sitter 是否已安装。';
    }

    const o = graph.getOverview();
    const lines = [
      `📊 项目 AST 概览 (构建耗时 ${o.buildTimeMs}ms)`,
      ``,
      `文件: ${o.totalFiles} | 类: ${o.totalClasses} | 协议: ${o.totalProtocols} | Category: ${o.totalCategories} | 方法: ${o.totalMethods}`,
      ``,
      `── 模块 ──`,
    ];
    for (const mod of o.topLevelModules) {
      const count = o.classesPerModule[mod] || 0;
      lines.push(`  ${mod}/ — ${count} 个类`);
    }
    if (o.entryPoints.length > 0) {
      lines.push(``, `── 入口点 ──`);
      for (const ep of o.entryPoints) {
        lines.push(`  ${ep}`);
      }
    }
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 45. get_class_hierarchy — 类继承层级
// ────────────────────────────────────────────────────────────
export const getClassHierarchy = {
  name: 'get_class_hierarchy',
  description:
    '查看指定类的继承链（向上到根类）和直接子类列表。' +
    '传入 className 查看指定类，不传则返回项目中所有根类及其子树。',
  parameters: {
    type: 'object',
    properties: {
      className: { type: 'string', description: '类名 (可选, 不填则返回完整层级)' },
    },
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) {
      return 'AST 分析不可用 — ProjectGraph 未构建。';
    }

    const className = params.className || params.class_name;
    if (className) {
      const chain = graph.getInheritanceChain(className);
      const subs = graph.getSubclasses(className);
      if (chain.length === 0) {
        return `未找到类 ${className}`;
      }

      const lines = [`🔗 ${className} 继承链:`, `  ${chain.join(' → ')}`];
      if (subs.length > 0) {
        lines.push(``, `直接子类 (${subs.length}):`);
        for (const s of subs) {
          lines.push(`  ├── ${s}`);
        }
      }
      return lines.join('\n');
    }

    // 全量: 找出所有根类 (没有父类或父类不在项目中的类)
    const allClasses = graph.getAllClassNames();
    const roots = allClasses.filter((c) => {
      const chain = graph.getInheritanceChain(c);
      return chain.length <= 1 || !allClasses.includes(chain[1]);
    });

    const lines = [`🌳 项目类层级 (${allClasses.length} 个类, ${roots.length} 棵树)`];
    for (const root of roots.slice(0, 30)) {
      const descendants = graph.getAllDescendants(root);
      lines.push(`  ${root} (${descendants.length} 个后代)`);
      for (const d of descendants.slice(0, 5)) {
        lines.push(`    └── ${d}`);
      }
      if (descendants.length > 5) {
        lines.push(`    ... 还有 ${descendants.length - 5} 个`);
      }
    }
    if (roots.length > 30) {
      lines.push(`... 还有 ${roots.length - 30} 棵树`);
    }
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 46. get_class_info — 类详细信息
// ────────────────────────────────────────────────────────────
export const getClassInfo = {
  name: 'get_class_info',
  description: '获取指定类的详细信息: 属性、方法签名、导入、继承关系、Category 扩展。',
  parameters: {
    type: 'object',
    properties: {
      className: { type: 'string', description: '类名 (必填)' },
    },
    required: ['className'],
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) {
      return 'AST 分析不可用 — ProjectGraph 未构建。';
    }

    const className = params.className || params.class_name;
    const info = graph.getClassInfo(className);
    if (!info) {
      return `未找到类 "${className}"。可以使用 get_project_overview 查看项目中的所有类。`;
    }

    const chain = graph.getInheritanceChain(className);
    const cats = graph.getCategoryExtensions(className);
    const subs = graph.getSubclasses(className);

    const lines = [
      `📦 ${info.name}`,
      `文件: ${info.filePath}:${info.line}`,
      `继承: ${chain.join(' → ')}`,
    ];

    if (info.protocols.length > 0) {
      lines.push(`遵循: <${info.protocols.join(', ')}>`);
    }

    if (info.properties.length > 0) {
      lines.push(``, `── 属性 (${info.properties.length}) ──`);
      for (const p of info.properties) {
        const attrs = p.attributes.length > 0 ? ` (${p.attributes.join(', ')})` : '';
        lines.push(`  ${p.name}: ${p.type}${attrs}`);
      }
    }

    if (info.methods.length > 0) {
      lines.push(``, `── 方法 (${info.methods.length}) ──`);
      const classMethods = info.methods.filter((m) => m.isClassMethod);
      const instanceMethods = info.methods.filter((m) => !m.isClassMethod);
      for (const m of classMethods) {
        const cx = m.complexity > 3 ? ` [复杂度:${m.complexity}]` : '';
        lines.push(`  + ${m.selector} → ${m.returnType}${cx}`);
      }
      for (const m of instanceMethods) {
        const cx = m.complexity > 3 ? ` [复杂度:${m.complexity}]` : '';
        lines.push(`  - ${m.selector} → ${m.returnType}${cx}`);
      }
    }

    if (cats.length > 0) {
      lines.push(``, `── Category 扩展 (${cats.length}) ──`);
      for (const cat of cats) {
        const methodNames = cat.methods.map((m) => m.selector).join(', ');
        lines.push(`  ${info.name}(${cat.categoryName}) — ${cat.filePath} — [${methodNames}]`);
      }
    }

    if (subs.length > 0) {
      lines.push(``, `── 直接子类 (${subs.length}) ──`);
      for (const s of subs) {
        lines.push(`  ${s}`);
      }
    }

    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 47. get_protocol_info — 协议详细信息
// ────────────────────────────────────────────────────────────
export const getProtocolInfo = {
  name: 'get_protocol_info',
  description: '获取指定协议的定义（必选/可选方法）及所有遵循该协议的类。',
  parameters: {
    type: 'object',
    properties: {
      protocolName: { type: 'string', description: '协议名 (必填)' },
    },
    required: ['protocolName'],
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) {
      return 'AST 分析不可用 — ProjectGraph 未构建。';
    }

    const protocolName = params.protocolName || params.protocol_name;
    const info = graph.getProtocolInfo(protocolName);
    if (!info) {
      return `未找到协议 "${protocolName}"。可以使用 get_project_overview 查看项目中的所有协议。`;
    }

    const lines = [`📋 @protocol ${info.name}`, `文件: ${info.filePath}:${info.line}`];

    if (info.inherits.length > 0) {
      lines.push(`继承: <${info.inherits.join(', ')}>`);
    }

    if (info.requiredMethods.length > 0) {
      lines.push(``, `── @required (${info.requiredMethods.length}) ──`);
      for (const m of info.requiredMethods) {
        lines.push(`  ${m.isClassMethod ? '+' : '-'} ${m.selector} → ${m.returnType}`);
      }
    }

    if (info.optionalMethods.length > 0) {
      lines.push(``, `── @optional (${info.optionalMethods.length}) ──`);
      for (const m of info.optionalMethods) {
        lines.push(`  ${m.isClassMethod ? '+' : '-'} ${m.selector} → ${m.returnType}`);
      }
    }

    if (info.conformers.length > 0) {
      lines.push(``, `── 遵循者 (${info.conformers.length}) ──`);
      for (const c of info.conformers) {
        lines.push(`  ${c}`);
      }
    } else {
      lines.push(``, `⚠️ 暂未发现遵循此协议的类`);
    }

    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 48. get_method_overrides — 方法覆写查询
// ────────────────────────────────────────────────────────────
export const getMethodOverrides = {
  name: 'get_method_overrides',
  description: '查找覆写了指定方法的所有子类。适用于理解方法在继承树中的多态行为。',
  parameters: {
    type: 'object',
    properties: {
      className: { type: 'string', description: '定义该方法的基类名 (必填)' },
      methodName: { type: 'string', description: '方法名或 selector (必填)' },
    },
    required: ['className', 'methodName'],
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) {
      return 'AST 分析不可用 — ProjectGraph 未构建。';
    }

    const className = params.className || params.class_name;
    const methodName = params.methodName || params.method_name;
    const overrides = graph.getMethodOverrides(className, methodName);

    if (overrides.length === 0) {
      return `"${className}.${methodName}" 没有在任何子类中被覆写。`;
    }

    const lines = [`🔀 ${className}.${methodName} 的覆写 (${overrides.length} 处):`];
    for (const o of overrides) {
      const cx = o.method.complexity > 3 ? ` [复杂度:${o.method.complexity}]` : '';
      lines.push(`  ${o.className} — ${o.filePath}:${o.method.line}${cx}`);
    }
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 49. get_category_map — Category 扩展映射
// ────────────────────────────────────────────────────────────
export const getCategoryMap = {
  name: 'get_category_map',
  description:
    '获取指定类或整个项目的 ObjC Category 扩展映射。Category 是 ObjC 的核心模式，了解它有助于发现功能划分。',
  parameters: {
    type: 'object',
    properties: {
      className: {
        type: 'string',
        description: '类名 — 可选, 不填则返回整个项目中有 Category 的类列表',
      },
    },
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) {
      return 'AST 分析不可用 — ProjectGraph 未构建。';
    }

    const className = params.className || params.class_name;
    if (className) {
      const cats = graph.getCategoryExtensions(className);
      if (cats.length === 0) {
        return `"${className}" 没有 Category 扩展。`;
      }

      const lines = [`📂 ${className} 的 Category 扩展 (${cats.length}):`];
      for (const cat of cats) {
        lines.push(`  ${className}(${cat.categoryName}) — ${cat.filePath}:${cat.line}`);
        for (const m of cat.methods) {
          lines.push(`    ${m.isClassMethod ? '+' : '-'} ${m.selector}`);
        }
        if (cat.protocols.length > 0) {
          lines.push(`    遵循: <${cat.protocols.join(', ')}>`);
        }
      }
      return lines.join('\n');
    }

    // 全量概览
    const allClasses = graph.getAllClassNames();
    const withCats = allClasses
      .map((c) => ({ name: c, cats: graph.getCategoryExtensions(c) }))
      .filter((x) => x.cats.length > 0)
      .sort((a, b) => b.cats.length - a.cats.length);

    if (withCats.length === 0) {
      return '项目中没有发现 Category 扩展。';
    }

    const lines = [`📂 项目 Category 概览 (${withCats.length} 个类有 Category):`];
    for (const { name, cats } of withCats.slice(0, 30)) {
      const catNames = cats.map((c) => c.categoryName).join(', ');
      lines.push(`  ${name} — ${cats.length} 个: (${catNames})`);
    }
    if (withCats.length > 30) {
      lines.push(`... 还有 ${withCats.length - 30} 个类`);
    }
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 50. get_previous_analysis — 前序维度分析结果 (可选)
// ────────────────────────────────────────────────────────────

export const getPreviousAnalysis = {
  name: 'get_previous_analysis',
  description:
    '获取前序维度的分析摘要。在 bootstrap 中，每个维度可能有前面维度的分析结果可用。' +
    '调用此工具可以获取之前维度产出的候选标题、设计决策等上下文，避免重复分析。' +
    '注意: 只有在你认为前序上下文对当前任务有帮助时才调用。',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, ctx) => {
    // 从 ctx._dimensionMeta 读取前序分析
    const meta = ctx._dimensionMeta;
    if (!meta || !meta.previousAnalysis) {
      return '没有前序维度的分析结果可用。';
    }

    const prev = meta.previousAnalysis;
    if (typeof prev === 'string') {
      return prev;
    }

    // 格式化前序分析
    const lines = ['📋 前序维度分析摘要:'];
    if (Array.isArray(prev)) {
      for (const item of prev) {
        if (typeof item === 'string') {
          lines.push(`  ${item}`);
        } else if (item.dimension && item.summary) {
          lines.push(``, `── ${item.dimension} ──`);
          lines.push(`  ${item.summary}`);
          if (item.candidateTitles?.length > 0) {
            lines.push(`  已提交候选: ${item.candidateTitles.join(', ')}`);
          }
        }
      }
    } else if (typeof prev === 'object') {
      for (const [key, value] of Object.entries(prev)) {
        lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
    }
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 51. note_finding — 记录关键发现到工作记忆 (Scratchpad)
// ────────────────────────────────────────────────────────────
export const noteFinding = {
  name: 'note_finding',
  description:
    '记录一个关键发现到工作记忆的 Scratchpad。在分析过程中发现重要模式、设计决策或事实时调用。' +
    '这些发现会在上下文窗口压缩后依然保留，确保分析后期不会遗忘早期重要发现。' +
    '建议在发现关键架构模式、核心类职责、重要设计约束时调用。',
  parameters: {
    type: 'object',
    properties: {
      finding: {
        type: 'string',
        description:
          '关键发现描述 (≤150 字)。应是具体、可验证的陈述，例如 "BDNetworkManager 使用单例模式，所有请求通过其发起"',
      },
      evidence: {
        type: 'string',
        description: '支持证据 (文件路径:行号)，例如 "BDNetworkManager.m:45"',
      },
      importance: {
        type: 'number',
        description: '重要性评分 1-10。8+ = 影响全局架构，5-7 = 常见模式，1-4 = 细节备注',
      },
    },
    required: ['finding'],
  },
  handler: async (params, ctx) => {
    // v5.0: 通过 MemoryCoordinator
    const coordinator = ctx._memoryCoordinator;
    if (coordinator) {
      const finding = params.finding || '';
      const evidence = params.evidence || '';
      const importance = params.importance || 5;
      const round = ctx._currentRound || 0;
      const scopeId = ctx._dimensionScopeId || undefined;
      return coordinator.noteFinding(finding, evidence, importance, round, scopeId);
    }

    return '⚠ 工作记忆未初始化 (仅在 bootstrap 分析期间可用)';
  },
};

// ────────────────────────────────────────────────────────────
// 52. get_previous_evidence — 检索前序维度的代码证据
// ────────────────────────────────────────────────────────────
export const getPreviousEvidence = {
  name: 'get_previous_evidence',
  description:
    '获取前序维度对特定文件/类/模式的分析证据。避免重复搜索和读取已经被其他维度分析过的内容。' +
    '当你要搜索某个类名或文件时，先调用此工具看前序维度是否已有发现。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询 (文件名、类名、模式名、关键词)',
      },
      dimId: {
        type: 'string',
        description: '指定维度 ID (可选，默认搜索所有前序维度)',
      },
    },
    required: ['query'],
  },
  handler: async (params, ctx) => {
    // v5.0: 通过 MemoryCoordinator 获取 SessionStore
    const coordinator = ctx._memoryCoordinator;
    const sessionStore = coordinator?.getSessionStore();
    if (!sessionStore) {
      return '没有前序维度的证据可用。';
    }

    const results = sessionStore.searchEvidence(params.query, params.dimId || undefined);

    if (results.length === 0) {
      return `没有找到与 "${params.query}" 相关的前序证据。建议自行搜索。`;
    }

    const lines = [`📋 前序维度证据 (匹配 "${params.query}", ${results.length} 条):`];
    for (const r of results.slice(0, 8)) {
      lines.push(`  📄 ${r.filePath}`);
      lines.push(
        `     [${r.evidence.dimId}] [${r.evidence.importance || 5}/10] ${r.evidence.finding}`
      );
    }
    if (results.length > 8) {
      lines.push(`  …还有 ${results.length - 8} 条证据`);
    }
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 53. query_code_graph — 查询代码实体图谱
// ────────────────────────────────────────────────────────────
export const queryCodeGraph = {
  name: 'query_code_graph',
  description:
    '查询代码实体图谱 (Code Entity Graph)。可查询类继承链、协议遵循者、实体搜索、影响分析等。' +
    '图谱包含从 AST 提取的类、协议、Category、模块、设计模式及其关系。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'search',
          'inheritance_chain',
          'descendants',
          'conformances',
          'impact',
          'topology',
          'entity_edges',
        ],
        description:
          '查询动作: search=搜索实体, inheritance_chain=继承链, descendants=子类/遵循者, conformances=协议遵循, impact=影响分析, topology=拓扑概览, entity_edges=实体的所有边',
      },
      entity_id: {
        type: 'string',
        description: '实体 ID (类名/协议名)。search 时为搜索关键词。',
      },
      entity_type: {
        type: 'string',
        enum: ['class', 'protocol', 'category', 'module', 'pattern'],
        description: '实体类型过滤 (可选)',
      },
      max_depth: {
        type: 'number',
        description: '遍历深度 (默认 3)',
      },
    },
    required: ['action', 'entity_id'],
  },
  handler: async (params, ctx) => {
    try {
      const { CodeEntityGraph } = await import('../../knowledge/CodeEntityGraph.js');
      const db = ctx?.container?.get('database');
      if (!db) {
        return '代码实体图谱不可用: 数据库未初始化';
      }

      const projectRoot = ctx?.projectRoot || process.env.ASD_PROJECT_DIR || '';
      const ceg = new CodeEntityGraph(db, { projectRoot });
      const maxDepth = params.max_depth || 3;

      switch (params.action) {
        case 'search': {
          const results = ceg.searchEntities(params.entity_id, {
            type: params.entity_type,
            limit: 15,
          });
          if (results.length === 0) {
            return `未找到匹配 "${params.entity_id}" 的代码实体。`;
          }
          const lines = [`🔍 代码实体搜索 "${params.entity_id}" (${results.length} 条):`];
          for (const e of results) {
            lines.push(
              `  • ${e.entityType}: \`${e.name}\`${e.filePath ? ` (${e.filePath}:${e.line || '?'})` : ''}${e.superclass ? ` → ${e.superclass}` : ''}`
            );
          }
          return lines.join('\n');
        }

        case 'inheritance_chain': {
          const chain = ceg.getInheritanceChain(params.entity_id, maxDepth);
          if (chain.length <= 1) {
            return `\`${params.entity_id}\` 没有已知的继承关系。`;
          }
          return `📐 继承链: \`${chain.join(' → ')}\``;
        }

        case 'descendants': {
          const type = params.entity_type || 'class';
          const desc = ceg.getDescendants(params.entity_id, type, maxDepth);
          if (desc.length === 0) {
            return `\`${params.entity_id}\` 没有已知的子类/遵循者。`;
          }
          const lines = [`📊 ${params.entity_id} 的后代 (${desc.length}):`];
          for (const d of desc.slice(0, 20)) {
            lines.push(`  ${'  '.repeat(d.depth - 1)}└─ \`${d.id}\` (${d.type}, ${d.relation})`);
          }
          return lines.join('\n');
        }

        case 'conformances': {
          const protos = ceg.getConformances(params.entity_id);
          if (protos.length === 0) {
            return `\`${params.entity_id}\` 没有已知的协议遵循。`;
          }
          return `📋 \`${params.entity_id}\` 遵循: ${protos.map((p) => `\`${p}\``).join(', ')}`;
        }

        case 'impact': {
          const type = params.entity_type || 'class';
          const impact = ceg.getImpactRadius(params.entity_id, type, maxDepth);
          if (impact.length === 0) {
            return `修改 \`${params.entity_id}\` 没有检测到直接影响。`;
          }
          const lines = [`⚡ 修改 \`${params.entity_id}\` 的影响范围 (${impact.length}):`];
          for (const i of impact.slice(0, 20)) {
            lines.push(`  ${'  '.repeat(i.depth - 1)}⬆ \`${i.id}\` (${i.type}, via ${i.relation})`);
          }
          return lines.join('\n');
        }

        case 'topology': {
          const topo = ceg.getTopology();
          if (topo.totalEntities === 0) {
            return '代码实体图谱为空。需先执行 Bootstrap。';
          }
          const lines = ['📈 代码实体图谱概览:'];
          lines.push('  实体:');
          for (const [type, count] of Object.entries(topo.entities)) {
            lines.push(`    • ${type}: ${count}`);
          }
          lines.push(`  总边数: ${topo.totalEdges}`);
          if (topo.hotNodes.length > 0) {
            lines.push('  核心实体 (入度最高):');
            for (const n of topo.hotNodes.slice(0, 8)) {
              lines.push(`    • \`${n.id}\` (${n.type}, 入度=${n.inDegree})`);
            }
          }
          return lines.join('\n');
        }

        case 'entity_edges': {
          const type = params.entity_type || 'class';
          const edges = ceg.getEntityEdges(params.entity_id, type);
          const total = edges.outgoing.length + edges.incoming.length;
          if (total === 0) {
            return `\`${params.entity_id}\` 没有已知的图谱边。`;
          }
          const lines = [`🔗 \`${params.entity_id}\` 的关系 (${total} 条):`];
          if (edges.outgoing.length > 0) {
            lines.push('  出边:');
            for (const e of edges.outgoing.slice(0, 10)) {
              lines.push(`    → \`${e.toId}\` (${e.toType}, ${e.relation})`);
            }
          }
          if (edges.incoming.length > 0) {
            lines.push('  入边:');
            for (const e of edges.incoming.slice(0, 10)) {
              lines.push(`    ← \`${e.fromId}\` (${e.fromType}, ${e.relation})`);
            }
          }
          return lines.join('\n');
        }

        default:
          return `未知动作: ${params.action}`;
      }
    } catch (err) {
      return `代码实体图谱查询失败: ${err.message}`;
    }
  },
};
