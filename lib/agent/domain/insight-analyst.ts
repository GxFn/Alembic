/**
 * insight-analyst.js — Insight Analyst 领域函数
 *
 * 从旧 AnalystAgent.js 提取的纯领域逻辑:
 * - Analyst System Prompt
 * - 工具白名单
 * - 预算常量
 * - 9 段式 Prompt 构建器
 *
 * 被 PipelineStrategy 的 bootstrap preset 直接引用。
 * 不再包含任何 Agent 类 — Agent 由 AgentRuntime + PipelineStrategy 驱动。
 *
 * @module insight-analyst
 */

import { getDimensionSOP } from '#domain/dimension/DimensionSop.js';

// ──────────────────────────────────────────────────────────────────
// 本地类型定义
// ──────────────────────────────────────────────────────────────────

/** 维度配置 (Analyst) */
interface AnalystDimConfig {
  id: string;
  label: string;
  guide?: string;
  focusKeywords?: string[];
  outputType?: string;
  allowedKnowledgeTypes?: string[];
}

/** 项目信息 (Analyst) */
interface AnalystProjectInfo {
  name: string;
  lang: string;
  fileCount: number;
}

/** DimensionContext 最小接口 */
interface DimensionContextLike {
  buildContextForDimension(dimId: string): {
    previousDimensions: Record<string, DimensionDigestLike>;
  };
}

/** 维度摘要 */
interface DimensionDigestLike {
  summary?: string;
  keyFindings: string[];
  crossRefs?: Record<string, string>;
}

/** EpisodicMemory (SessionStore) 最小接口 */
interface EpisodicMemoryLike {
  buildContextForDimension(dimId: string, focusKeywords: string[]): string | null;
  getRelevantReflections(dimId: string): string | null;
}

/** PersistentMemory 最小接口 */
interface SemanticMemoryLike {
  toPromptSection(opts: {
    source: string;
    query: string;
    limit: number;
  }): Promise<string | null> | string | null;
}

/** CodeEntityGraph 最小接口 */
interface CodeEntityGraphLike {
  generateContextForAgent(opts: { maxEntities: number; maxEdges: number }): string | null;
}

// ──────────────────────────────────────────────────────────────────
// System Prompt — Analyst 专用 (~100 tokens)
// ──────────────────────────────────────────────────────────────────

export const ANALYST_SYSTEM_PROMPT = `你是一位高级软件架构师，正在深度分析一个真实项目的某个维度。

## 执行计划
你有 **N 轮**工具调用机会（系统会告知具体数字）。请严格按以下节奏分配：

| 阶段 | 轮次占比 | 目标 |
|------|---------|------|
| 1. 全局扫描 | 第 1-3 轮 | get_project_overview + list_project_structure 了解项目结构 |
| 2. 结构化探索 | 第 4-N×60% 轮 | get_class_hierarchy / get_class_info 理解核心类；search_project_code 批量搜索关键模式 |
| 3. 深度验证 | 第 N×60%-N×80% 轮 | read_project_file 阅读关键实现，确认细节 |
| 4. 输出总结 | 最后 20% | **停止调用工具**，直接输出你的分析文本 |

## 关键规则
- **到达 80% 轮次时必须开始写总结**，不要等系统提醒
- 每一轮都必须调用工具获取新信息，不要花轮次在纯文本思考上
- 不要重复搜索相同关键词或读取相同文件（系统会返回缓存并扣轮次）

## 工具效率
- **批量搜索**: search_project_code({ patterns: ["keywordA", "keywordB", "keywordC"] }) — 一次搜 3-5 个
- **批量读文件**: read_project_file({ filePaths: ["a.m", "b.m", "c.m"] }) — 一次读 3-5 个
- **结构化查询优先**: get_class_hierarchy / get_class_info 比文本搜索更精确高效

## 输出要求
输出你的分析发现，包括具体的文件完整相对路径（从项目根目录开始）和行号。
每个文件引用格式: (来源: Full/Relative/Path/FileName.ext:行号)
禁止只写文件名，必须写从项目根开始的完整路径。
标注每个发现所属的模块/包名。
用自然语言描述你的理解，不需要特定格式。`;

// ──────────────────────────────────────────────────────────────────
// Analyst 可用工具白名单 — 只做探索，不做提交
// ──────────────────────────────────────────────────────────────────

export const ANALYST_TOOLS = [
  // AST 结构化分析
  'get_project_overview',
  'get_class_hierarchy',
  'get_class_info',
  'get_protocol_info',
  'get_method_overrides',
  'get_category_map',
  // 文件访问
  'search_project_code',
  'read_project_file',
  'list_project_structure',
  'get_file_summary',
  'semantic_search_code',
  // 前序上下文 (可选)
  'get_previous_analysis',
  // Agent Memory (v4.0) — 工作记忆 + 情景记忆
  'note_finding',
  'get_previous_evidence',
  // Phase E: 代码实体图谱查询
  'query_code_graph',
];

// ──────────────────────────────────────────────────────────────────
// Analyst 预算 — 使用 analyst 策略（自由探索，无阶段约束）
// ──────────────────────────────────────────────────────────────────

export const ANALYST_BUDGET = {
  maxIterations: 24,
  searchBudget: 18,
  searchBudgetGrace: 10,
  maxSubmits: 0,
  softSubmitLimit: 0,
  idleRoundsToExit: 2,
};

// ──────────────────────────────────────────────────────────────────
// 维度 Prompt 模板 (9 段式)
// ──────────────────────────────────────────────────────────────────

/** Panorama context — module role, layer, coupling, gaps */
interface PanoramaContextLike {
  moduleRole: string | null;
  moduleLayer: number | null;
  moduleCoupling: { fanIn: number; fanOut: number } | null;
  knownGaps: string[];
  layerContext: string | null;
}

/** Evidence starters — per-dimension evidence hints from Phase 1-4 */
interface EvidenceStarterEntry {
  hint: string;
  data: unknown;
  strength?: number;
}

/** Rescan context — existing recipes in this dimension */
interface RescanContextLike {
  existingRecipes: Array<{ title: string; trigger: string }>;
  decayingRecipes?: Array<{ title: string; trigger: string; id?: string; decayReason?: string }>;
  gap: number;
  existing: number;
}

/**
 * 构建 Analyst Prompt
 *
 * 12 段结构:
 *   §1 任务描述
 *   §2 维度指引
 *   §3 SOP (分析步骤 + 常见错误)
 *   §4 输出要求
 *   §5 工具提示
 *   §6 前序维度上下文 (SessionStore / DimensionContext)
 *   §7 Tier Reflection 洞察
 *   §8 历史语义记忆 (Tier 3)
 *   §9 代码实体图谱 (Phase E)
 *   §ES 分析起点证据 (Phase 1-4 Evidence Starters)
 *   §M1 全景上下文 (Panorama Phase 1.8)
 *   §10 Rescan 已有知识上下文
 *
 * @param dimConfig 维度配置 { id, label, guide, focusKeywords, outputType }
 * @param projectInfo { name, lang, fileCount }
 * @param [dimensionContext] DimensionContext 实例 (跨维度上下文)
 * @param [episodicMemory] SessionStore 实例 (v4.0 增强上下文)
 * @param [semanticMemory] PersistentMemory 实例 (v4.1 历史记忆)
 * @param [codeEntityGraph] CodeEntityGraph 实例 (Phase E 代码实体图谱)
 * @param [rescanContext] Rescan 已有知识上下文 (增量扫描时注入)
 * @param [panorama] 全景上下文 — 模块角色/层级/耦合/空白区 (Phase 1.8)
 * @param [evidenceStarters] Phase 1-4 证据启发 — 维度级分析起点
 */
export async function buildAnalystPrompt(
  dimConfig: AnalystDimConfig,
  projectInfo: AnalystProjectInfo,
  dimensionContext: DimensionContextLike | null | undefined,
  episodicMemory: EpisodicMemoryLike | null | undefined,
  semanticMemory: SemanticMemoryLike | null | undefined,
  codeEntityGraph: CodeEntityGraphLike | null | undefined,
  rescanContext?: RescanContextLike | null,
  panorama?: PanoramaContextLike | null,
  evidenceStarters?: Record<string, EvidenceStarterEntry> | null
) {
  const parts: string[] = [];

  // §1 任务描述
  parts.push(
    `分析项目 ${projectInfo.name} (${projectInfo.lang}, ${projectInfo.fileCount} 个文件) 的 ${dimConfig.label}。`
  );

  // §2 维度指引
  if (dimConfig.guide) {
    parts.push(dimConfig.guide);
  }

  // §3 结构化 SOP (优先) — 替代 focusAreas
  const sop = getDimensionSOP(dimConfig.id);
  if (sop) {
    parts.push('## 分析步骤 (SOP)');
    for (const step of sop.steps) {
      parts.push(`### ${step.phase}`);
      parts.push(step.action);
      if (step.expectedOutput) {
        parts.push(`→ 预期产出: ${step.expectedOutput}`);
      }
    }
    // §3.1 常见错误 (关键质量防护)
    if (sop.commonMistakes && sop.commonMistakes.length > 0) {
      parts.push('## ⚠️ 常见错误（务必避免）');
      for (const m of sop.commonMistakes) {
        parts.push(`- ${m}`);
      }
    }
  } else if (dimConfig.guide) {
    const items = dimConfig.guide
      .split(/[、，,/]/)
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (items.length > 1) {
      parts.push(`重点关注:\n${items.map((f: string) => `- ${f}`).join('\n')}`);
    } else {
      parts.push(`重点关注: ${dimConfig.guide}`);
    }
  }

  // §4 输出要求
  const outputType = dimConfig.outputType || 'analysis';
  const needsCandidates = outputType === 'dual' || outputType === 'candidate';
  const depthHint = needsCandidates
    ? '你的分析将被转化为知识候选，请确保每个发现都有足够的代码证据和文件引用。按实际发现总结，有几个独立知识点就写几个。'
    : '';

  parts.push(`请将分析组织成结构化段落，包含:
1. 在哪些文件/类中发现 (写出从项目根目录开始的完整相对路径+行号，如 Packages/ModuleName/Sources/.../FileName.swift:42)
2. 具体的实现方式和代码特征
3. 为什么选择这种方式（设计意图）
4. 统计数据 (如数量、占比)
5. 所属模块/包名（特别是来自本地子包的发现）

每个关键发现用编号列表呈现，引用 3 个以上具体文件（完整相对路径）。
禁止只写文件名（如 NetworkClient.swift），必须写完整路径（如 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Client/NetworkClient.swift:42）。
${depthHint}
重要: 务必使用 read_project_file 阅读代码确认，不要假设文件存在。引用的每个文件路径都必须是你亲眼看到的。
【跨维度去重】只分析属于当前维度视角的内容。不要将其他维度的知识点混入本维度来充数。例如: 分析 code-standard 时只关注命名/注释/文件组织，不要混入设计模式(code-pattern)或分层架构(architecture)的内容。如果某个发现与多个维度相关，则只从当前维度的核心视角分析，避免与其他维度产生重叠。
【本地子包覆盖】如果项目有本地子包/模块（如 Packages/ 目录下的包），必须同时分析其内部实现，不得仅看主项目对其的调用。`);

  // §5 前序上下文提示
  parts.push('可以调用 get_previous_analysis 获取前序维度的分析结果，避免重复分析。');
  parts.push('使用 note_finding 工具记录关键发现到工作记忆，确保重要信息不会在后期被遗忘。');
  parts.push('使用 get_previous_evidence 工具查询前序维度对特定文件/类的分析证据，避免重复搜索。');

  // §6 前序维度分析摘要 (Tier 2+ 才有)
  if (episodicMemory) {
    const emContext = episodicMemory.buildContextForDimension(
      dimConfig.id,
      dimConfig.focusKeywords || []
    );
    if (emContext) {
      parts.push(emContext);
    }

    // §7: Tier Reflection 洞察
    const reflections = episodicMemory.getRelevantReflections(dimConfig.id);
    if (reflections) {
      parts.push('## 跨维度综合洞察');
      parts.push(reflections);
    }
  } else if (dimensionContext) {
    const snapshot = dimensionContext.buildContextForDimension(dimConfig.id);
    const prevDims = Object.entries(snapshot.previousDimensions) as [string, DimensionDigestLike][];
    if (prevDims.length > 0) {
      parts.push(`## 前序维度分析摘要（避免重复探索）`);
      for (const [dimId, digest] of prevDims) {
        parts.push(`### ${dimId}\n${digest.summary || '(无摘要)'}`);
        if (digest.keyFindings?.length > 0) {
          parts.push(`关键发现: ${digest.keyFindings.join('; ')}`);
        }
        if (digest.crossRefs?.[dimConfig.id]) {
          parts.push(`💡 对本维度的建议: ${digest.crossRefs[dimConfig.id]}`);
        }
      }
    }
  }

  // §8: 历史语义记忆 (Tier 3)
  if (semanticMemory) {
    try {
      const query = `${dimConfig.label} ${dimConfig.guide || ''} ${projectInfo.lang}`;
      const section = await semanticMemory.toPromptSection({
        source: 'bootstrap',
        query,
        limit: 10,
      });
      if (section) {
        parts.push(section);
      }
    } catch {
      /* SemanticMemory retrieval failed, non-critical */
    }
  }

  // §9: 代码实体图谱 (Phase E)
  if (codeEntityGraph) {
    try {
      const graphCtx = codeEntityGraph.generateContextForAgent({ maxEntities: 20, maxEdges: 40 });
      if (graphCtx) {
        parts.push(graphCtx);
        parts.push('使用 query_code_graph 工具可以查询更详细的继承链、影响分析等。');
      }
    } catch {
      /* CodeEntityGraph context failed, non-critical */
    }
  }

  // §ES: 分析起点证据 (Phase 1-4 Evidence Starters)
  if (evidenceStarters && Object.keys(evidenceStarters).length > 0) {
    const esLines = ['## 📊 分析起点 (Phase 1-4 自动检测)'];
    esLines.push('以下是自动化分析阶段检测到的与本维度相关的信号，可作为分析起点:');
    // 按 strength 降序排列，取前 6 个最强信号
    const sorted = Object.entries(evidenceStarters)
      .sort(([, a], [, b]) => (b.strength ?? 50) - (a.strength ?? 50))
      .slice(0, 6);
    for (const [key, entry] of sorted) {
      const strengthBadge = (entry.strength ?? 50) >= 75 ? '⚠️' : '📝';
      esLines.push(`${strengthBadge} **${key}**: ${entry.hint}`);
      if (entry.data) {
        const dataStr = Array.isArray(entry.data)
          ? entry.data
              .slice(0, 5)
              .map((d) => `  - ${typeof d === 'string' ? d : JSON.stringify(d)}`)
              .join('\n')
          : typeof entry.data === 'string'
            ? `  ${entry.data}`
            : `  ${JSON.stringify(entry.data, null, 0).slice(0, 300)}`;
        esLines.push(dataStr);
      }
    }
    esLines.push('');
    esLines.push('利用上述信号作为分析切入点，用 read_project_file 验证并深入探索。');
    parts.push(esLines.join('\n'));
  }

  // §M1: 全景上下文 (Panorama Phase 1.8) — 模块角色/层级/耦合/空白区
  if (panorama) {
    const pLines = ['## 🏗️ 项目全景 (Panorama)'];
    if (panorama.layerContext) {
      pLines.push(`架构层级: ${panorama.layerContext}`);
    }
    if (panorama.moduleRole) {
      pLines.push(
        `当前模块角色: ${panorama.moduleRole}${panorama.moduleLayer !== null ? ` (L${panorama.moduleLayer})` : ''}`
      );
    }
    if (panorama.moduleCoupling) {
      pLines.push(
        `耦合度: fanIn=${panorama.moduleCoupling.fanIn}, fanOut=${panorama.moduleCoupling.fanOut}`
      );
    }
    if (panorama.knownGaps.length > 0) {
      pLines.push(`已知空白区: ${panorama.knownGaps.join(', ')}`);
      pLines.push('分析时请特别关注上述空白区，它们是最可能产出新知识的方向。');
    }
    parts.push(pLines.join('\n'));
  }

  // §10a: Rescan 有效知识上下文 — 避免重复分析已覆盖的模式
  if (rescanContext && rescanContext.existingRecipes.length > 0) {
    const lines = [
      '## ⚠️ 增量扫描模式 — 已有知识 (勿重复)',
      `本维度已有 ${rescanContext.existing} 个有效 Recipe，需补齐 ${rescanContext.gap} 个。`,
      '已有 Recipe 标题:',
    ];
    for (const r of rescanContext.existingRecipes.slice(0, 10)) {
      const triggerTag = r.trigger ? ` (trigger: ${r.trigger})` : '';
      lines.push(`- "${r.title}"${triggerTag}`);
    }
    if (rescanContext.existingRecipes.length > 10) {
      lines.push(`- ... 共 ${rescanContext.existingRecipes.length} 个`);
    }
    lines.push('');
    lines.push(
      '**你的任务**: 专注发现上述 Recipe **尚未覆盖**的新模式。不要重复分析相同的代码特征。'
    );
    parts.push(lines.join('\n'));
  }

  // §10b: Rescan 衰退知识 — 可以替换
  if (rescanContext?.decayingRecipes && rescanContext.decayingRecipes.length > 0) {
    const dLines = [
      '## 🔄 衰退中的知识 (可替换)',
      '以下 Recipe 正在衰退，其描述的模式可能已过时或迁移：',
    ];
    for (const r of rescanContext.decayingRecipes.slice(0, 5)) {
      dLines.push(`- "${r.title}" — 衰退原因: ${r.decayReason || '未知'}`);
    }
    dLines.push('如果你在分析中发现了这些模式的**更新版本**（例如类改名、迁移到新模块），');
    dLines.push('请记录下来，后续 Producer 可以用 supersedes 参数提交替代版本。');
    parts.push(dLines.join('\n'));
  }

  return parts.join('\n\n');
}
