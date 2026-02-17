/**
 * MCP 工具定义（35 个）+ Gateway 映射
 *
 * 只包含 JSON Schema 级别的声明，不含任何业务逻辑。
 * V3: 旧 submit_candidate / submit_candidates / submit_draft_recipes 已移除，
 *     统一使用 submit_knowledge / submit_knowledge_batch / knowledge_lifecycle。
 */

/**
 * MCP 工具 → Gateway action 映射（仅写操作需要 gating）
 * 只读工具不在此映射中，跳过 Gateway 以保持性能
 */
export const TOOL_GATEWAY_MAP = {
  autosnippet_guard_audit_files: { action: 'guard_rule:check_code', resource: 'guard_rules' },
  autosnippet_scan_project: { action: 'guard_rule:check_code', resource: 'guard_rules' },
  autosnippet_enrich_candidates: { action: 'candidate:update', resource: 'candidates' },
  autosnippet_bootstrap_knowledge: { action: 'knowledge:bootstrap', resource: 'knowledge' },
  autosnippet_bootstrap_refine: { action: 'candidate:update', resource: 'candidates' },
  autosnippet_create_skill: { action: 'create:skills', resource: 'skills' },
  autosnippet_delete_skill: { action: 'delete:skills', resource: 'skills' },
  autosnippet_update_skill: { action: 'update:skills', resource: 'skills' },
  // V3 知识条目
  autosnippet_submit_knowledge: { action: 'knowledge:create', resource: 'knowledge' },
  autosnippet_submit_knowledge_batch: { action: 'knowledge:create', resource: 'knowledge' },
  autosnippet_knowledge_lifecycle: { action: 'knowledge:update', resource: 'knowledge' },
};

export const TOOLS = [
  // 1. 健康检查
  {
    name: 'autosnippet_health',
    description: '检查 AutoSnippet V2 服务健康状态与能力概览。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // 2. 统合搜索（auto 模式同时 BM25+semantic 融合去重）
  {
    name: 'autosnippet_search',
    description: '统合搜索入口（推荐首选）。默认 auto 模式同时执行 BM25 + 向量语义搜索并融合去重，也可指定 keyword/bm25/semantic。返回 byKind 分组。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或自然语言查询' },
        kind: { type: 'string', enum: ['all', 'rule', 'pattern', 'fact'], default: 'all', description: '按知识类型过滤' },
        mode: { type: 'string', enum: ['auto', 'keyword', 'bm25', 'semantic'], default: 'auto', description: 'auto=BM25+semantic 融合; keyword=SQL LIKE 精确; bm25=词频排序; semantic=向量语义' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  // 3. Guard 检查
  {
    name: 'autosnippet_guard_check',
    description: '对代码运行 Guard 规则检查，返回违规列表。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '待检查的源码' },
        language: { type: 'string', description: '语言（objc/swift 等）' },
        filePath: { type: 'string', description: '文件路径（可选，用于语言推断）' },
      },
      required: ['code'],
    },
  },
  // 4. 智能上下文搜索（RetrievalFunnel + SearchEngine 多层检索）
  {
    name: 'autosnippet_context_search',
    description: '智能上下文检索：4 层检索漏斗（倒排索引 + 语义重排 + 多信号加权 + 上下文感知）。返回 byKind 分组结果。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言查询' },
        limit: { type: 'number', default: 5 },
        sessionId: { type: 'string', description: '会话 ID（连续对话上下文）' },
        userId: { type: 'string', description: '用户 ID（个性化推荐）' },
        language: { type: 'string', description: '当前语言（用于上下文感知重排）' },
        sessionHistory: { type: 'array', items: { type: 'object' }, description: '会话历史（用于 Layer 4 上下文感知重排，可选）' },
      },
      required: ['query'],
    },
  },
  // 5. 列出 Guard 规则
  {
    name: 'autosnippet_list_rules',
    description: '列出知识库中的所有 Guard 规则（kind=rule）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20 },
        status: { type: 'string', description: '按状态过滤：active/draft/deprecated' },
        language: { type: 'string', description: '按语言过滤' },
        category: { type: 'string', description: '按分类过滤' },
      },
      required: [],
    },
  },
  // 6. 列出可复用模式
  {
    name: 'autosnippet_list_patterns',
    description: '列出知识库中的可复用模式（kind=pattern）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20 },
        language: { type: 'string' },
        category: { type: 'string' },
      },
      required: [],
    },
  },
  // 7. SQL LIKE 精确关键词搜索
  {
    name: 'autosnippet_keyword_search',
    description: '精确关键词搜索（SQL LIKE），适合已知函数名、类名、ObjC 方法名等精确字符串检索。比 BM25 更精确但无语义理解。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '精确关键词（类名、方法名、字符串片段）' },
        limit: { type: 'number', default: 10 },
        kind: { type: 'string', enum: ['all', 'rule', 'pattern', 'fact'], default: 'all', description: '按知识类型过滤' },
      },
      required: ['query'],
    },
  },
  // 8. 向量语义搜索
  {
    name: 'autosnippet_semantic_search',
    description: '向量语义搜索（embedding 相似度），适合模糊意图/自然语言描述。需要 vectorStore+aiProvider；不可用时自动降级到 BM25 并标注 degraded。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言描述（例如"如何处理网络超时重试"）' },
        limit: { type: 'number', default: 10 },
        kind: { type: 'string', enum: ['all', 'rule', 'pattern', 'fact'], default: 'all', description: '按知识类型过滤' },
      },
      required: ['query'],
    },
  },
  // 9. 知识图谱查询
  {
    name: 'autosnippet_graph_query',
    description: '查询知识图谱：获取 Recipe 的所有关系（依赖、扩展、冲突等）。',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '节点 ID（Recipe ID）' },
        nodeType: { type: 'string', default: 'recipe' },
        relation: { type: 'string', description: '关系类型过滤' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], default: 'both' },
      },
      required: ['nodeId'],
    },
  },
  // 10. 知识影响分析
  {
    name: 'autosnippet_graph_impact',
    description: '影响分析：分析修改某 Recipe 会影响哪些下游依赖。',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '节点 ID' },
        nodeType: { type: 'string', default: 'recipe' },
        maxDepth: { type: 'number', default: 3 },
      },
      required: ['nodeId'],
    },
  },
  // 11. 知识图谱路径查找
  {
    name: 'autosnippet_graph_path',
    description: '查找两个知识节点之间的关联路径（BFS 最短路径），可发现 Recipe 之间的间接关联。',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string', description: '起始节点 ID（Recipe ID）' },
        toId: { type: 'string', description: '目标节点 ID（Recipe ID）' },
        fromType: { type: 'string', default: 'recipe' },
        toType: { type: 'string', default: 'recipe' },
        maxDepth: { type: 'number', default: 5, description: 'BFS 最大搜索深度（1-10）' },
      },
      required: ['fromId', 'toId'],
    },
  },
  // 12. 知识图谱统计
  {
    name: 'autosnippet_graph_stats',
    description: '获取知识图谱全局统计：边总数、各关系类型分布、节点类型分布。用于了解知识库关联密度。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // 13. 获取 SPM Target 列表（含摘要统计）
  {
    name: 'autosnippet_get_targets',
    description: '获取项目所有 SPM Target 列表。默认附带每个 Target 的文件数、语言统计和推断职责（inferredRole）。使用 includeSummary=false 可仅返回基础列表。',
    inputSchema: {
      type: 'object',
      properties: {
        includeSummary: { type: 'boolean', default: true, description: '是否附带文件数与语言统计摘要（默认 true）' },
      },
      required: [],
    },
  },
  // 14. 获取 Target 源码文件
  {
    name: 'autosnippet_get_target_files',
    description: '获取指定 SPM Target 的源码文件列表。支持 includeContent 返回文件内容（可配合 contentMaxLines 截断）。用于逐 Target 深入分析。',
    inputSchema: {
      type: 'object',
      properties: {
        targetName: { type: 'string', description: 'Target 名称' },
        includeContent: { type: 'boolean', default: false, description: '是否返回文件内容' },
        contentMaxLines: { type: 'number', default: 100, description: '每文件最大返回行数（需 includeContent=true）' },
        maxFiles: { type: 'number', default: 500, description: '最大文件数' },
      },
      required: ['targetName'],
    },
  },
  // 15. 获取 Target 元数据
  {
    name: 'autosnippet_get_target_metadata',
    description: '获取指定 SPM Target 的元数据：依赖列表、Package 信息、推断职责、以及 knowledge_edges 中的图谱关系。',
    inputSchema: {
      type: 'object',
      properties: {
        targetName: { type: 'string', description: 'Target 名称' },
      },
      required: ['targetName'],
    },
  },
  // 16. 候选校验
  {
    name: 'autosnippet_validate_candidate',
    description: '对候选 Recipe 进行结构化预校验（字段完整性、格式、规范性）。检查 5 层：核心必填(title/code)、分类(category/knowledgeType/complexity)、描述文档(trigger/summary/usageGuide)、结构化内容(rationale/headers/steps/codeChanges)、约束与推理(constraints/reasoning)。',
    inputSchema: {
      type: 'object',
      properties: {
        candidate: {
          type: 'object',
          description: '候选结构（完整字段校验）',
          properties: {
            title: { type: 'string', description: '中文简短标题（必填）' },
            code: { type: 'string', description: '代码片段（strict 模式下必填）' },
            language: { type: 'string', description: '编程语言' },
            category: { type: 'string', description: '分类：View/Service/Tool/Model/Network/Storage/UI/Utility' },
            knowledgeType: { type: 'string', description: '知识维度：code-pattern|architecture|best-practice|boundary-constraint 等' },
            complexity: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'], description: '复杂度' },
            scope: { type: 'string', enum: ['universal', 'project-specific', 'target-specific'] },
            tags: { type: 'array', items: { type: 'string' } },
            description: { type: 'string', description: '一句话描述' },
            summary: { type: 'string', description: '详细摘要（Markdown）' },
            trigger: { type: 'string', description: '触发关键词（建议 @ 开头）' },
            usageGuide: { type: 'string', description: '使用指南（Markdown）' },
            rationale: { type: 'string', description: '设计原理/为什么这样做' },
            headers: { type: 'array', items: { type: 'string' }, description: 'import/include 依赖声明' },
            steps: { type: 'array', items: { type: 'object' }, description: '实施步骤 [{title, description, code}]' },
            codeChanges: { type: 'array', items: { type: 'object' }, description: '代码变更 [{file, before, after, explanation}]' },
            constraints: { type: 'object', description: '约束 {boundaries[], preconditions[], sideEffects[], guards[]}' },
            reasoning: {
              type: 'object',
              description: '推理依据（强烈建议提供）：{whyStandard, sources[], confidence}',
              properties: {
                whyStandard: { type: 'string' },
                sources: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number', description: '0-1' },
              },
            },
          },
        },
        strict: { type: 'boolean', default: false, description: 'strict 模式下 code 为必填' },
      },
      required: ['candidate'],
    },
  },
  // 17. 相似度检测
  {
    name: 'autosnippet_check_duplicate',
    description: '对候选与现有 Recipe 做相似度检测，返回相似条目列表。',
    inputSchema: {
      type: 'object',
      properties: {
        candidate: {
          type: 'object',
          properties: { title: { type: 'string' }, summary: { type: 'string' }, usageGuide: { type: 'string' }, code: { type: 'string' } },
        },
        threshold: { type: 'number', default: 0.7 },
        topK: { type: 'number', default: 5 },
      },
      required: ['candidate'],
    },
  },
  // 18-20: [已移除] 旧 submit_candidate / submit_candidates / submit_draft_recipes
  //        统一使用 V3 submit_knowledge / submit_knowledge_batch / knowledge_lifecycle
  // 21. 能力声明
  {
    name: 'autosnippet_capabilities',
    description: '列出所有可用 MCP 工具的概览。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // 22. 列出 Recipes（通用，支持多条件组合过滤）
  {
    name: 'autosnippet_list_recipes',
    description: '列出 Recipe 列表（支持 kind/language/category/knowledgeType/status/complexity/tags 多条件组合过滤）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'kind 过滤：rule/pattern/fact' },
        language: { type: 'string' },
        category: { type: 'string' },
        knowledgeType: { type: 'string', description: '知识类型过滤' },
        status: { type: 'string', description: '状态过滤：active/draft/deprecated' },
        complexity: { type: 'string', description: '复杂度过滤' },
        limit: { type: 'number', default: 20 },
      },
      required: [],
    },
  },
  // 23. 获取单个 Recipe
  {
    name: 'autosnippet_get_recipe',
    description: '按 ID 获取单个 Recipe 详细信息。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  // 24. 合规报告
  {
    name: 'autosnippet_compliance_report',
    description: '获取合规评估报告，可按时间范围过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['all', 'daily', 'weekly', 'monthly'], default: 'all', description: '评估时间范围' },
      },
      required: [],
    },
  },
  // 25. 确认使用 Recipe
  {
    name: 'autosnippet_confirm_usage',
    description: '确认 Recipe 被采纳或应用，记录使用统计。',
    inputSchema: {
      type: 'object',
      properties: {
        recipeId: { type: 'string', description: 'Recipe ID' },
        usageType: { type: 'string', enum: ['adoption', 'application'], default: 'adoption', description: 'adoption=采纳, application=应用' },
        feedback: { type: 'string', description: '可选反馈' },
      },
      required: ['recipeId'],
    },
  },
  // 26. 列出结构性知识 (kind=fact)
  {
    name: 'autosnippet_list_facts',
    description: '列出知识库中的结构性知识（kind=fact，包括代码关联、继承、调用链、数据流等）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20 },
        status: { type: 'string', description: '按状态过滤：active/draft/deprecated' },
        language: { type: 'string', description: '按语言过滤' },
        category: { type: 'string', description: '按分类过滤' },
      },
      required: [],
    },
  },
  // 27. Recipe 洞察 (只读聚合)
  {
    name: 'autosnippet_recipe_insights',
    description: '获取指定 Recipe 的质量洞察：质量分数、采纳/应用统计、关联关系摘要、约束条件概览。只读工具，不修改任何数据。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Recipe ID' },
      },
      required: ['id'],
    },
  },
  // 28. 全项目扫描（轻量探查：收集文件 + Guard 审计，不写数据库）
  {
    name: 'autosnippet_scan_project',
    description: '轻量项目探查：收集所有 SPM Target 的源文件列表 + 运行 Guard 规则审计。返回文件清单和 Guard 违规统计。Guard 审计结果会自动记录到 ViolationsStore（Dashboard Guard 页面可见）。' +
      '适用场景：了解项目结构、检查 Guard 状态、快速看一下有多少文件。' +
      '如果要做完整的知识库初始化（冷启动），请使用 autosnippet_bootstrap_knowledge。',
    inputSchema: {
      type: 'object',
      properties: {
        maxFiles: { type: 'number', default: 200, description: '最大文件数（避免超大项目卡死）' },
        includeContent: { type: 'boolean', default: false, description: '是否在结果中包含文件内容（用于 Agent 后续分析）' },
        contentMaxLines: { type: 'number', default: 100, description: '每个文件返回的最大行数（当 includeContent=true）' },
      },
      required: [],
    },
  },
  // 29. Guard 批量审计（多文件）
  {
    name: 'autosnippet_guard_audit_files',
    description: '对多个文件批量运行 Guard 规则审计。传入文件路径列表，返回每个文件的违反详情。结果会自动记录到 ViolationsStore（Dashboard Guard 页面可见）。',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件绝对路径' },
              content: { type: 'string', description: '文件内容（如不提供则从磁盘读取）' },
            },
            required: ['path'],
          },
          description: '待审计的文件列表',
        },
        scope: { type: 'string', enum: ['file', 'target', 'project'], default: 'project', description: '审计范围' },
      },
      required: ['files'],
    },
  },
  // 30. ① 结构补齐：候选字段完整性诊断（不使用内置 AI）
  {
    name: 'autosnippet_enrich_candidates',
    description:
      '① 结构补齐（诊断模式）— 检查候选的字段完整性，返回缺失清单。\n' +
      '检查两层：\n' +
      '  • Recipe 必填：category、trigger(@开头)、description、headers\n' +
      '  • 语义字段：rationale、knowledgeType、complexity、scope、steps、constraints\n' +
      '不调用内置 AI，仅做诊断。返回每条候选的 missingFields 列表。\n' +
      '\n' +
      '⚠️ 调用方职责：拿到 missingFields 后，你必须根据代码内容和项目上下文自行填充缺失字段，然后重新提交更新。\n' +
      '建议在 autosnippet_bootstrap_refine（② 内容润色）之前调用。',
    inputSchema: {
      type: 'object',
      properties: {
        candidateIds: {
          type: 'array',
          items: { type: 'string' },
          description: '要诊断的候选 ID 列表（最多 20 条）',
        },
      },
      required: ['candidateIds'],
    },
  },
  // 31. 冷启动知识库初始化（自动创建 9 维度 Candidate + 4 个 Project Skills）
  {
    name: 'autosnippet_bootstrap_knowledge',
    description:
      '项目冷启动：一键初始化知识库（纯启发式，不使用 AI）。覆盖 9 大知识维度。\n' +
      '自动为每个维度创建 N 条 Candidate（PENDING 状态），基于启发式规则从扫描文件中提取代表性代码。\n' +
      'Phase 5.5 自动为 4 个宏观维度（code-standard, architecture, project-profile, agent-guidelines）生成 Project Skills，写入 AutoSnippet/skills/。\n' +
      '返回 filesByTarget、dependencyGraph、bootstrapCandidates、projectSkills、analysisFramework。\n' +
      '\n' +
      '💡 建议：调用前先加载 autosnippet-coldstart Skill（autosnippet_load_skill），获取完整的 9 维度分析指南和最佳实践。\n' +
      '\n' +
      '⚠️ 产出为启发式初稿，必须执行后续步骤提升质量：\n' +
      '  Step 1: autosnippet_enrich_candidates — 诊断字段缺失，逐条补全必填字段\n' +
      '  Step 2: autosnippet_bootstrap_refine — AI 润色 summary/insight/relations/confidence\n' +
      '  Step 3: 逐 Target 深入分析，补充更细粒度知识条目（autosnippet_submit_knowledge_batch）\n' +
      '  Step 4: 对新候选重复 Step 1-2\n' +
      '\n' +
      '质量标准：每条必须包含 title/code/language/category/trigger/description/headers/reasoning。',
    inputSchema: {
      type: 'object',
      properties: {
        maxFiles: { type: 'number', default: 500, description: '最大扫描文件数（防止超大项目超时）' },
        contentMaxLines: { type: 'number', default: 120, description: '每个文件返回的最大行数（过大可能超出 Token 限制）' },
        skipGuard: { type: 'boolean', default: false, description: '跳过 Guard 审计' },
        loadSkills: { type: 'boolean', default: true, description: '加载 Skills 增强分析维度（推荐）。自动加载 coldstart Skill + 语言参考 Skill，增强 9 维度的 guide 定义。' },
      },
      required: [],
    },
  },
  // 32. Skills 发现：列出所有可用 Agent Skill 及其适用场景
  {
    name: 'autosnippet_list_skills',
    description:
      '列出所有可用的 Agent Skill 文档及其适用场景摘要。\n' +
      'Skills 是 AutoSnippet 的领域知识文档，指导你如何高质量地完成各类任务。\n' +
      '每个 Skill 包含：name（名称）、summary（摘要）、useCase（适用场景）。\n' +
      '\n' +
      '使用建议：\n' +
      '  • 首次使用 AutoSnippet 时调用此工具了解能力全景\n' +
      '  • 不确定该怎么做时，先加载 autosnippet-intent（意图路由 Skill）\n' +
      '  • 执行具体任务前，加载对应的 Skill 获取操作指南和最佳实践',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // 33. Skills 加载：按需获取指定 Skill 的完整操作指南
  {
    name: 'autosnippet_load_skill',
    description:
      '加载指定的 Agent Skill 文档，获取领域操作指南和最佳实践参考。\n' +
      '返回 Skill 的完整 Markdown 内容、适用场景说明、以及相关 Skill 推荐。\n' +
      '\n' +
      '核心 Skills 推荐：\n' +
      '  • autosnippet-intent — 意图路由，不确定该用哪个 Skill 时先加载它\n' +
      '  • autosnippet-coldstart — 冷启动全流程指南（9 维度分析）\n' +
      '  • autosnippet-analysis — 深度项目分析（扫描 + 语义补齐）\n' +
      '  • autosnippet-candidates — 高质量候选生成（V2 全字段）\n' +
      '  • autosnippet-guard — Guard 代码规范审计\n' +
      '  • autosnippet-recipes — 项目标准查询（Recipe 上下文）\n' +
      '  • autosnippet-reference-{swift,objc,jsts} — 语言最佳实践参考',
    inputSchema: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: 'Skill 名称（如 autosnippet-coldstart）。调用 autosnippet_list_skills 可获取完整列表。' },
        section: { type: 'string', description: '可选：只返回指定章节（匹配 ## 标题关键词），减少 Token 消耗' },
      },
      required: ['skillName'],
    },
  },
  // 34. 创建项目级 Skill
  {
    name: 'autosnippet_create_skill',
    description:
      '创建一个项目级 Skill 文档，写入 AutoSnippet/skills/<name>/SKILL.md。\n' +
      'Skill 是 Agent 的领域知识增强文档，帮助 Agent 正确执行特定任务。\n' +
      '创建后自动更新编辑器索引（.cursor/rules/autosnippet-skills.mdc），使 Skill 被 AI Agent 被动发现。\n' +
      '\n' +
      '使用场景：\n' +
      '  • 将反复出现的操作指南/架构决策/编码规范固化为 Skill\n' +
      '  • 为特定 Target/模块创建定制化开发指南\n' +
      '  • 记录项目私有的最佳实践（不适合放入通用知识库）\n' +
      '\n' +
      '⚠️ 注意：Skill 名称建议使用 kebab-case，如 my-auth-guide',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill 名称（kebab-case，如 my-auth-guide）。将作为目录名。',
        },
        description: {
          type: 'string',
          description: 'Skill 一句话描述（写入 SKILL.md frontmatter）',
        },
        content: {
          type: 'string',
          description: 'Skill 正文内容（Markdown 格式，不含 frontmatter）',
        },
        overwrite: {
          type: 'boolean',
          default: false,
          description: '如果同名 Skill 已存在，是否覆盖（默认 false）',
        },
        createdBy: {
          type: 'string',
          enum: ['manual', 'user-ai', 'system-ai', 'external-ai'],
          default: 'external-ai',
          description: '创建者类型：manual=用户手动 | user-ai=用户调用AI | system-ai=系统自动 | external-ai=外部AI Agent',
        },
      },
      required: ['name', 'description', 'content'],
    },
  },
  // 35. Skill 推荐：基于使用模式分析，推荐创建 Skill
  {
    name: 'autosnippet_suggest_skills',
    description:
      '基于项目使用模式分析，推荐创建 Skill。\n' +
      '分析 4 个维度：Guard 违规模式、Memory 偏好积累、Recipe 分布缺口、候选积压率。\n' +
      '返回推荐列表（含 name / description / rationale / priority），Agent 可据此直接调用 autosnippet_create_skill 创建。\n' +
      '\n' +
      '使用时机：\n' +
      '  • 项目使用一段时间后，定期调用检查是否有新的 Skill 需求\n' +
      '  • 用户反复说"我们项目不用…"、"以后都…"等偏好表述时\n' +
      '  • Guard 违规频繁出现同一规则时\n' +
      '  • 候选被大量驳回时',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // 36. 删除项目级 Skill
  {
    name: 'autosnippet_delete_skill',
    description:
      '删除一个项目级 Skill 及其目录。\n' +
      '⚠️ 内置 Skill 不可删除。删除后自动更新编辑器索引。\n' +
      '\n' +
      '使用场景：\n' +
      '  • 清理不再需要的自定义 Skill\n' +
      '  • 移除过时或错误的操作指南',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill 名称（如 my-auth-guide）',
        },
      },
      required: ['name'],
    },
  },
  // 37. 更新项目级 Skill
  {
    name: 'autosnippet_update_skill',
    description:
      '更新已存在的项目级 Skill 的描述或内容。\n' +
      '⚠️ 内置 Skill 不可更新。更新后自动刷新编辑器索引。\n' +
      '\n' +
      '使用场景：\n' +
      '  • 迭代改进已有 Skill 的操作指南\n' +
      '  • 更新过时的最佳实践内容\n' +
      '  • 修正 Skill 描述或补充新章节',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill 名称（必须已存在于项目级 Skills 中）',
        },
        description: {
          type: 'string',
          description: '新的一句话描述（可选，不传则保持原值）',
        },
        content: {
          type: 'string',
          description: '新的正文内容（Markdown 格式，不含 frontmatter）。不传则保持原值',
        },
      },
      required: ['name'],
    },
  },
  // 38. ② 内容润色：Bootstrap 候选 AI 精炼（Phase 6）
  {
    name: 'autosnippet_bootstrap_refine',
    description:
      '② 内容润色 — 使用项目内 AI 逐条精炼 Bootstrap 候选的内容质量。\n' +
      '改善 summary 描述（从模板化 → 精准自然语言）、补充架构 insight 洞察、推断 relations 关联、调整 confidence 评分、丰富 tags。\n' +
      '\n' +
      '⚠️ 必须在 autosnippet_enrich_candidates 之后调用（确保字段完整后再润色）。\n' +
      '建议流程：autosnippet_bootstrap_knowledge → autosnippet_enrich_candidates → 本工具。\n' +
      '需要项目内 AI Provider 已配置。如未配置，请直接用你自己的 AI 能力分析并更新候选。',
    inputSchema: {
      type: 'object',
      properties: {
        candidateIds: { type: 'array', items: { type: 'string' }, description: '指定候选 ID 列表（可选，默认全部 bootstrap 候选）' },
        userPrompt: { type: 'string', description: '用户自定义润色提示词，指导 AI 润色方向（如"侧重描述线程安全注意事项"）' },
        dryRun: { type: 'boolean', default: false, description: '仅预览 AI 润色结果，不写入数据库' },
      },
      required: [],
    },
  },
  // ═══ V3 知识条目（统一实体） ═══════════════════════════════
  // 36. 单条知识提交（V3 wire format 直通）
  {
    name: 'autosnippet_submit_knowledge',
    description:
      '提交单条知识条目到 AutoSnippet 知识库（V3 统一实体）。\n' +
      '参数即 wire format — 直接构造 KnowledgeEntry。\n' +
      '⚠️ Cursor Delivery 字段（kind/doClause/topicHint）直接影响 .mdc 规则文件生成质量，请务必填写。\n' +
      '\n' +
      '核心必填: title + language + content(pattern 或 markdown) + kind + doClause\n' +
      '推荐填写: trigger, topicHint, whenClause, dontClause, coreCode, reasoning, tags\n' +
      '\n' +
      '根据 ConfidenceRouter 自动路由：高置信度自动入库(active)，低置信度待审核(pending)。',
    inputSchema: {
      type: 'object',
      properties: {
        // ── 必填 ──
        title:            { type: 'string', description: '中文标题（≤20字）' },
        language:         { type: 'string', description: '编程语言（swift/objectivec/javascript/typescript/python，小写）' },
        content: {
          type: 'object',
          description: '内容值对象（必须有 pattern 或 markdown）',
          properties: {
            pattern:      { type: 'string', description: '完整代码片段（函数/方法/类实现）' },
            markdown:     { type: 'string', description: '项目特写 Markdown（技术说明文档）' },
            rationale:    { type: 'string', description: '设计原理（英文）' },
            steps:        { type: 'array', items: { type: 'object', properties: {
              title: { type: 'string' }, description: { type: 'string' }, code: { type: 'string' },
            }}},
            codeChanges: { type: 'array', items: { type: 'object' } },
            verification: { type: 'object' },
          },
        },
        // ── Cursor Delivery（关键字段，影响 .mdc 规则生成） ──
        kind:             { type: 'string', enum: ['rule', 'pattern', 'fact'], description: '知识类型: rule=必须遵守的规则, pattern=可复用代码模板, fact=参考信息' },
        doClause:         { type: 'string', description: '正向指令: 英文祈使句 ≤60 tokens（e.g. "Use dependency injection via constructor"）' },
        dontClause:       { type: 'string', description: '反向约束: 英文（不以 Don\'t 开头），e.g. "Instantiate services with new directly"' },
        whenClause:       { type: 'string', description: '触发场景: 英文描述何时应用此知识（e.g. "When creating a new ViewController subclass"）' },
        topicHint:        { type: 'string', description: '主题分组标签，用于 .mdc 文件归类（e.g. "networking", "ui-layout", "error-handling", "data-model"）' },
        coreCode:         { type: 'string', description: '3-8 行精华代码骨架，可直接复制使用（无 Markdown 格式）' },
        trigger:          { type: 'string', description: '触发关键词（@前缀 kebab-case，e.g. "@json-parse"）' },
        // ── 分类 ──
        category:         { type: 'string', description: '分类: View/Service/Tool/Model/Network/Storage/UI/Utility' },
        knowledgeType:    { type: 'string', description: '知识维度: code-pattern|architecture|best-practice|boundary-constraint|...' },
        complexity:       { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        scope:            { type: 'string', enum: ['universal', 'project-specific', 'target-specific'] },
        difficulty:       { type: 'string' },
        tags:             { type: 'array', items: { type: 'string' } },
        // ── 描述 ──
        description:      { type: 'string', description: '中文简述 ≤80 字（引用真实类名/方法名）' },
        // ── 约束与关系 ──
        constraints:      { type: 'object', description: '约束 {guards[], boundaries[], preconditions[], sideEffects[]}' },
        relations:        { type: 'object', description: '关系分桶 {inherits[], extends[], depends_on[], conflicts[], related[], ...}' },
        // ── 推理 ──
        reasoning: {
          type: 'object',
          description: '推理依据',
          properties: {
            whyStandard:  { type: 'string', description: '为什么值得沉淀为知识' },
            sources:      { type: 'array', items: { type: 'string' }, description: '来源文件列表' },
            confidence:   { type: 'number', description: '置信度 0-1' },
            qualitySignals: { type: 'object' },
            alternatives: { type: 'array', items: { type: 'string' } },
          },
        },
        // ── 头文件 ──
        headers:          { type: 'array', items: { type: 'string' }, description: '完整 import/include 语句' },
        headerPaths:      { type: 'array', items: { type: 'string' } },
        moduleName:       { type: 'string' },
        includeHeaders:   { type: 'boolean' },
        // ── 控制 ──
        source:           { type: 'string', description: '来源标识（默认 mcp）' },
        client_id:        { type: 'string', description: '客户端标识（用于限流）' },
      },
      required: ['title', 'language', 'content', 'kind', 'doClause'],
    },
  },
  // 37. 批量知识提交
  {
    name: 'autosnippet_submit_knowledge_batch',
    description:
      '批量提交知识条目到知识库（V3 统一实体）。\n' +
      '每条 item 使用与 autosnippet_submit_knowledge 相同的 wire format。\n' +
      '每条 item 必须包含 Cursor Delivery 字段（kind/doClause），否则生成的 .mdc 规则质量低。\n' +
      '支持去重。返回逐条结果与 recipeReadyHints。',
    inputSchema: {
      type: 'object',
      properties: {
        target_name:  { type: 'string', description: 'Target 名称' },
        items:        { type: 'array', description: '知识条目数组，每项字段同 submit_knowledge（必须含 kind/doClause）', items: { type: 'object' } },
        source:       { type: 'string', default: 'cursor-scan', description: '来源标识' },
        deduplicate:  { type: 'boolean', default: true, description: '是否去重' },
        client_id:    { type: 'string', description: '客户端标识（用于限流）' },
      },
      required: ['target_name', 'items'],
    },
  },
  // 38. 知识条目生命周期操作
  {
    name: 'autosnippet_knowledge_lifecycle',
    description:
      '知识条目生命周期操作。\n' +
      '可用操作: submit(draft→pending), approve(pending→approved), reject(pending→rejected),\n' +
      'publish(approved→active), deprecate(active→deprecated), reactivate(deprecated→active),\n' +
      'to_draft(rejected→draft), fast_track(draft→active 一键发布)。',
    inputSchema: {
      type: 'object',
      properties: {
        id:     { type: 'string', description: '知识条目 ID' },
        action: { type: 'string', enum: ['submit', 'approve', 'reject', 'publish', 'deprecate', 'reactivate', 'to_draft', 'fast_track'], description: '生命周期操作' },
        reason: { type: 'string', description: 'reject/deprecate 时必须提供原因' },
      },
      required: ['id', 'action'],
    },
  },
];
