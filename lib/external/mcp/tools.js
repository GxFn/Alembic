/**
 * MCP 工具定义 — V3 整合版 (15 agent + 4 admin = 19 工具)
 *
 * 从 39 → 19 工具（参数路由合并同类工具 + 外部 Agent 冷启动新架构）。
 * 每个工具声明增加 tier 字段（agent / admin）。
 * tools.js 只包含 JSON Schema 声明 + Gateway 映射，不含业务逻辑。
 *
 * 外部 Agent 冷启动新工具 (v3.1):
 *   - autosnippet_bootstrap:          参数化 → 无参数化 Mission Briefing
 *   - autosnippet_dimension_complete:  维度分析完成通知
 *   - autosnippet_wiki_plan:           Wiki 主题规划
 *   - autosnippet_wiki_finalize:       Wiki 元数据 + 去重
 */

// ─── Tier 定义 ──────────────────────────────────────────────
export const TIER_ORDER = { agent: 0, admin: 1 };

// ─── Gateway 映射（仅写操作需要 gating） ────────────────────

export const TOOL_GATEWAY_MAP = {
  // bootstrap — 无参数化 Mission Briefing（只读分析，无需 gating）
  // autosnippet_bootstrap: null,
  // dimension_complete — 写操作（recipe tagging + skill creation + checkpoint）
  autosnippet_dimension_complete: { action: 'knowledge:bootstrap', resource: 'knowledge' },
  // wiki_finalize — 写操作（meta.json）
  autosnippet_wiki_finalize: { action: 'knowledge:create', resource: 'knowledge' },
  // guard 写操作（仅 files 模式）
  autosnippet_guard: {
    resolver: (args) =>
      args?.files && Array.isArray(args.files)
        ? { action: 'guard_rule:check_code', resource: 'guard_rules' }
        : null, // code 模式只读，跳过 Gateway
  },
  // skill 写操作（create/update/delete）
  autosnippet_skill: {
    resolver: (args) =>
      ({
        create: { action: 'create:skills', resource: 'skills' },
        update: { action: 'update:skills', resource: 'skills' },
        delete: { action: 'delete:skills', resource: 'skills' },
      })[args?.operation] || null, // list/load/suggest 只读
  },
  // 知识提交
  autosnippet_submit_knowledge: { action: 'knowledge:create', resource: 'knowledge' },
  autosnippet_submit_knowledge_batch: { action: 'knowledge:create', resource: 'knowledge' },
  autosnippet_save_document: { action: 'knowledge:create', resource: 'knowledge' },
  // admin 工具
  autosnippet_enrich_candidates: { action: 'knowledge:update', resource: 'knowledge' },
  autosnippet_knowledge_lifecycle: { action: 'knowledge:update', resource: 'knowledge' },
};

// ─── 工具声明 ────────────────────────────────────────────────

export const TOOLS = [
  // ══════════════════════════════════════════════════════
  //  Tier: agent — Agent 核心工具集 (15 个)
  // ══════════════════════════════════════════════════════

  // 1. 健康检查
  {
    name: 'autosnippet_health',
    tier: 'agent',
    description: '检查服务健康状态与知识库统计。total=0 时表示需要冷启动。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // 2. 统合搜索（4 → 1）
  {
    name: 'autosnippet_search',
    tier: 'agent',
    description: '统合搜索入口。支持 4 种模式（mode 参数），返回 byKind 分组结果。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        mode: {
          type: 'string',
          enum: ['auto', 'keyword', 'bm25', 'semantic', 'context'],
          default: 'auto',
          description:
            'auto=BM25+semantic 融合 | keyword=SQL LIKE 精确 | semantic=向量语义 | context=4层漏斗+会话感知',
        },
        kind: {
          type: 'string',
          enum: ['all', 'rule', 'pattern', 'fact'],
          default: 'all',
          description: '按知识类型过滤',
        },
        limit: { type: 'number', default: 10 },
        language: { type: 'string', description: '当前编程语言（mode=context 时用于重排）' },
        sessionId: { type: 'string', description: '会话 ID（mode=context 连续对话）' },
        sessionHistory: {
          type: 'array',
          items: { type: 'object' },
          description: '会话历史（mode=context 启用 Layer 4）',
        },
      },
      required: ['query'],
    },
  },

  // 3. 知识浏览（7 → 1）
  {
    name: 'autosnippet_knowledge',
    tier: 'agent',
    description:
      '知识浏览与使用确认。list=列表过滤 | get=单条详情 | insights=质量洞察 | confirm_usage=记录采纳。',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get', 'insights', 'confirm_usage'],
          default: 'list',
          description: 'list=列表过滤 | get=获取详情 | insights=质量洞察 | confirm_usage=确认采纳',
        },
        id: { type: 'string', description: 'Recipe ID（get/insights/confirm_usage 必填）' },
        kind: {
          type: 'string',
          enum: ['all', 'rule', 'pattern', 'fact'],
          description: '按知识类型过滤（list）',
        },
        language: { type: 'string', description: '语言过滤' },
        category: { type: 'string', description: '分类过滤' },
        knowledgeType: { type: 'string', description: '知识类型过滤' },
        status: { type: 'string', description: '状态过滤：active/draft/deprecated' },
        complexity: { type: 'string', description: '复杂度过滤' },
        limit: { type: 'number', default: 20 },
        usageType: {
          type: 'string',
          enum: ['adoption', 'application'],
          description: '使用类型（confirm_usage）',
        },
        feedback: { type: 'string', description: '使用反馈（confirm_usage）' },
      },
      required: [],
    },
  },

  // 4. 项目结构（3 → 1）
  {
    name: 'autosnippet_structure',
    tier: 'agent',
    description: '项目结构探查。targets=目标列表 | files=文件列表 | metadata=元数据与依赖。',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['targets', 'files', 'metadata'],
          default: 'targets',
          description: 'targets=目标列表 | files=文件列表 | metadata=元数据',
        },
        targetName: { type: 'string', description: 'Target 名称（files/metadata 必填）' },
        includeSummary: { type: 'boolean', default: true, description: '附带摘要统计（targets）' },
        includeContent: { type: 'boolean', default: false, description: '返回文件内容（files）' },
        contentMaxLines: { type: 'number', default: 100, description: '截断行数（files）' },
        maxFiles: { type: 'number', default: 500, description: '最大文件数（files）' },
      },
      required: [],
    },
  },

  // 5. 知识图谱（4 → 1）
  {
    name: 'autosnippet_graph',
    tier: 'agent',
    description:
      '知识图谱查询。query=节点关系 | impact=影响分析 | path=路径查找 | stats=全局统计。',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['query', 'impact', 'path', 'stats'],
          description: 'query=节点关系 | impact=影响分析 | path=路径查找 | stats=全局统计',
        },
        nodeId: { type: 'string', description: '节点 ID（query/impact）' },
        nodeType: { type: 'string', default: 'recipe' },
        fromId: { type: 'string', description: '起始节点（path）' },
        toId: { type: 'string', description: '目标节点（path）' },
        direction: {
          type: 'string',
          enum: ['out', 'in', 'both'],
          default: 'both',
          description: '关系方向（query）',
        },
        maxDepth: { type: 'number', default: 3, description: '最大深度' },
        relation: { type: 'string', description: '关系类型过滤' },
      },
      required: ['operation'],
    },
  },

  // 6. Guard 检查（2 → 1）
  {
    name: 'autosnippet_guard',
    tier: 'agent',
    description: '代码规范检查。传 code=单文件检查，传 files[]=多文件批量审计（自动路由）。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '待检查代码（单文件模式，与 files 二选一）' },
        language: { type: 'string', description: '编程语言' },
        filePath: { type: 'string', description: '文件路径（单文件模式）' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path'],
          },
          description: '文件列表（批量模式，与 code 二选一）',
        },
        scope: {
          type: 'string',
          enum: ['file', 'target', 'project'],
          default: 'project',
          description: '审计范围（批量模式）',
        },
      },
      required: [],
    },
  },

  // 7. 提交知识（严格前置校验 + 去重检测）
  {
    name: 'autosnippet_submit_knowledge',
    tier: 'agent',
    description:
      '提交单条知识到知识库（V3 统一实体）。严格前置校验，缺少必要字段将被直接拒绝（不入库）。\n' +
      '所有必填字段必须在单次调用中一次性提供，不要分步提交。\n' +
      '⚠️ content 必须是对象: { "pattern": "代码片段", "markdown": "## 标题\\n正文...", "rationale": "设计原理" }（pattern/markdown 至少一个 + rationale 必填）\n' +
      '⚠️ reasoning 必须是对象: { "whyStandard": "原因", "sources": ["file.ts"], "confidence": 0.85 }\n' +
      '必填: title, language, content, kind, doClause, dontClause, whenClause, coreCode, category, trigger, description, headers, usageGuide, knowledgeType, reasoning',
    inputSchema: {
      type: 'object',
      properties: {
        // ── 必填 ──
        title: { type: 'string', description: '中文标题（≤20字）' },
        language: { type: 'string', description: '编程语言（小写）' },
        content: {
          type: 'object',
          description:
            '内容值对象（JSON 对象，不是字符串！）。必须包含: pattern(代码片段) 或 markdown(Markdown正文) 至少一个 + rationale(设计原理) 必填。' +
            '示例: { "pattern": "func example() { ... }", "markdown": "## 标题\\n正文≥200字...", "rationale": "为什么这样设计" }',
          properties: {
            pattern: { type: 'string', description: '核心代码片段（与 markdown 至少提供一个）' },
            markdown: { type: 'string', description: 'Markdown 正文（≥200字符，与 pattern 至少提供一个）' },
            rationale: { type: 'string', description: '设计原理说明（必填）' },
            steps: { type: 'array', items: { type: 'object' } },
            codeChanges: { type: 'array', items: { type: 'object' } },
            verification: { type: 'object' },
          },
          required: ['rationale'],
        },
        kind: {
          type: 'string',
          enum: ['rule', 'pattern', 'fact'],
          description: 'rule=规则 | pattern=模板 | fact=参考',
        },
        doClause: { type: 'string', description: '正向指令（英文祈使句 ≤60 tokens）' },
        category: {
          type: 'string',
          description: '分类（必填）: View/Service/Tool/Model/Network/Storage/UI/Utility',
        },
        trigger: { type: 'string', description: '触发关键词（必填，@前缀，如 @video-cover-cell）' },
        description: { type: 'string', description: '中文简述（必填）≤80 字' },
        headers: {
          type: 'array',
          items: { type: 'string' },
          description: '完整 import/include 语句数组（必填）',
        },
        usageGuide: {
          type: 'string',
          description: '使用指南（必填，Markdown ### 章节格式，描述何时/如何使用此知识）',
        },
        knowledgeType: {
          type: 'string',
          description:
            '知识维度（必填）: code-pattern | architecture | best-practice | code-standard | code-style | code-relation | data-flow | event-and-data-flow | module-dependency | boundary-constraint | solution | anti-pattern',
        },
        // ── Cursor Delivery ──
        dontClause: { type: 'string', description: '反向约束（必填，描述禁止的做法）' },
        whenClause: { type: 'string', description: '触发场景（必填，描述何时适用此规则）' },
        topicHint: { type: 'string', description: '主题分组' },
        coreCode: { type: 'string', description: '精华代码骨架（必填，3-8行，必须语法完整、括号配对）' },
        // ── 可选 ──
        complexity: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        scope: { type: 'string', enum: ['universal', 'project-specific', 'target-specific'] },
        difficulty: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'object', description: '约束' },
        relations: { type: 'object', description: '关系' },
        reasoning: {
          type: 'object',
          description:
            '推理依据（JSON 对象，必填）。示例: { "whyStandard": "28/30 files follow this pattern", "sources": ["src/UserService.ts"], "confidence": 0.85 }',
          properties: {
            whyStandard: { type: 'string', description: '为什么这是标准做法（必填）' },
            sources: { type: 'array', items: { type: 'string' }, description: '参考的文件路径数组（必填，至少 1 个）' },
            confidence: { type: 'number', description: '置信度 0.0-1.0（推荐 0.7-0.9）' },
            qualitySignals: { type: 'object' },
            alternatives: { type: 'array', items: { type: 'string' } },
          },
          required: ['whyStandard', 'sources', 'confidence'],
        },
        headerPaths: { type: 'array', items: { type: 'string' } },
        moduleName: { type: 'string' },
        includeHeaders: { type: 'boolean' },
        source: { type: 'string', description: '来源标识' },
        client_id: { type: 'string', description: '客户端标识' },
        // ── 增强控制 ──
        skipDuplicateCheck: { type: 'boolean', default: false, description: '跳过去重检测' },
        dimensionId: { type: 'string', description: 'Bootstrap 维度 ID（可选，冷启动时传递当前维度以改善追踪准确性）' },
      },
      required: [
        'title',
        'language',
        'content',
        'kind',
        'doClause',
        'dontClause',
        'whenClause',
        'coreCode',
        'category',
        'trigger',
        'description',
        'headers',
        'usageGuide',
        'knowledgeType',
        'reasoning',
      ],
    },
  },

  // 8. 批量知识提交
  {
    name: 'autosnippet_submit_knowledge_batch',
    tier: 'agent',
    description:
      '批量提交知识条目（V3 统一实体）。每条字段要求同 submit_knowledge。支持去重。\n' +
      '⚠️ items 数组中每条的 content 和 reasoning 都必须是 JSON 对象（不是字符串）。\n' +
      'content 格式: { "pattern": "代码...", "markdown": "正文...", "rationale": "原理..." }\n' +
      'reasoning 格式: { "whyStandard": "原因", "sources": ["file.ts"], "confidence": 0.85 }',
    inputSchema: {
      type: 'object',
      properties: {
        target_name: { type: 'string', description: 'Target 名称' },
        items: {
          type: 'array',
          description: '知识条目数组，每项字段同 submit_knowledge',
          items: { type: 'object' },
        },
        source: { type: 'string', default: 'cursor-scan' },
        deduplicate: { type: 'boolean', default: true },
        client_id: { type: 'string' },
        dimensionId: { type: 'string', description: 'Bootstrap 维度 ID（可选，冷启动时传递当前维度以改善追踪准确性）' },
      },
      required: ['target_name', 'items'],
    },
  },

  // 9. 保存开发文档
  {
    name: 'autosnippet_save_document',
    tier: 'agent',
    description:
      '保存开发文档（设计文档、排查报告、ADR 等）。仅需 title + markdown，自动以 dev-document 存储。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题' },
        markdown: { type: 'string', description: 'Markdown 全文' },
        description: { type: 'string', description: '一句话摘要' },
        tags: { type: 'array', items: { type: 'string' } },
        scope: {
          type: 'string',
          enum: ['universal', 'project-specific'],
          default: 'project-specific',
        },
        source: { type: 'string' },
      },
      required: ['title', 'markdown'],
    },
  },

  // 10. Skill 管理（6 → 1）
  {
    name: 'autosnippet_skill',
    tier: 'agent',
    description:
      'Skill 管理。list=列表 | load=加载 | create=创建 | update=更新 | delete=删除 | suggest=AI推荐。',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'load', 'create', 'update', 'delete', 'suggest'],
          description:
            'list=列表 | load=加载 | create=创建 | update=更新 | delete=删除 | suggest=推荐',
        },
        name: { type: 'string', description: 'Skill 名称（load/create/update/delete）' },
        skillName: { type: 'string', description: 'Skill 名称（load 的别名，兼容旧调用）' },
        section: { type: 'string', description: '章节过滤（load）' },
        description: { type: 'string', description: '描述（create/update）' },
        content: { type: 'string', description: 'Markdown 正文（create/update）' },
        overwrite: { type: 'boolean', default: false, description: '覆盖已存在（create）' },
        createdBy: {
          type: 'string',
          enum: ['manual', 'user-ai', 'system-ai', 'external-ai'],
          default: 'external-ai',
        },
      },
      required: ['operation'],
    },
  },

  // 11. 冷启动 Mission Briefing（无参数，返回项目分析 + 执行计划）
  {
    name: 'autosnippet_bootstrap',
    tier: 'agent',
    description:
      '冷启动 Mission Briefing — 自动分析项目结构、AST、依赖图和 Guard 审计，返回完整的执行计划和维度任务清单。无需任何参数，直接调用即可。不依赖数据库，DB 不可用时也能正常工作。\n' +
      '💡 建议先加载 Skill 获取详细冷启动指引: autosnippet_skill({ operation: "load", name: "autosnippet-coldstart" })\n' +
      '返回的 submissionSchema.example 包含完整的提交 JSON 示例，请严格按其格式提交知识。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // 11b. 维度完成通知
  {
    name: 'autosnippet_dimension_complete',
    tier: 'agent',
    description:
      '维度分析完成通知 — Agent 完成一个维度的分析后调用。负责 Recipe 关联、Skill 生成、Checkpoint 保存、进度推送、跨维度 Hints 分发。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'bootstrap 返回的 session.id（可选，自动查找）' },
        dimensionId: { type: 'string', description: '维度 ID（如 project-profile, language-scans）' },
        submittedRecipeIds: {
          type: 'array',
          items: { type: 'string' },
          description: '本维度通过 submit_knowledge/submit_knowledge_batch 提交的 recipe ID 列表',
        },
        analysisText: { type: 'string', description: '分析报告全文（Markdown）' },
        referencedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '引用的文件路径列表',
        },
        keyFindings: {
          type: 'array',
          items: { type: 'string' },
          description: '关键发现摘要 (3-5 条)',
        },
        candidateCount: { type: 'number', description: '本维度提交的候选数量' },
        crossDimensionHints: {
          type: 'object',
          description: '对其他维度的建议 { targetDimId: "hint text" }',
        },
      },
      required: ['dimensionId', 'analysisText'],
    },
  },

  // 11c. Wiki 主题规划
  {
    name: 'autosnippet_wiki_plan',
    tier: 'agent',
    description:
      '规划 Wiki 文档生成 — 扫描项目结构、分析 AST 和依赖、整合知识库，返回发现的文档主题及每个主题的数据包。Agent 根据规划自行撰写文章后写入 wiki 目录。',
    inputSchema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['zh', 'en'],
          default: 'zh',
          description: 'Wiki 文档语言',
        },
        sessionId: { type: 'string', description: 'bootstrap session ID（可选，用于复用缓存）' },
      },
    },
  },

  // 11d. Wiki 完成（meta.json + 去重）
  {
    name: 'autosnippet_wiki_finalize',
    tier: 'agent',
    description:
      '完成 Wiki 生成 — 写入 meta.json、执行去重检查、验证文件完整性。在所有 Wiki 文章写入完成后调用。',
    inputSchema: {
      type: 'object',
      properties: {
        articlesWritten: {
          type: 'array',
          items: { type: 'string' },
          description: '已写入的 Wiki 文件路径列表（相对于 AutoSnippet/wiki/）',
        },
      },
      required: ['articlesWritten'],
    },
  },

  // 12. 能力声明（Agent 自发现）
  {
    name: 'autosnippet_capabilities',
    tier: 'agent',
    description: '列出所有可用 MCP 工具的概览，供 Agent 自发现服务能力。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ══════════════════════════════════════════════════════
  //  Tier: admin — 管理员/CI 工具 (额外 +4)
  // ══════════════════════════════════════════════════════

  // 13. 候选字段诊断
  {
    name: 'autosnippet_enrich_candidates',
    tier: 'admin',
    description: '候选字段完整性诊断（不使用 AI）。返回 missingFields 列表，Agent 自行补全。',
    inputSchema: {
      type: 'object',
      properties: {
        candidateIds: {
          type: 'array',
          items: { type: 'string' },
          description: '候选 ID 列表（最多20条）',
        },
      },
      required: ['candidateIds'],
    },
  },

  // 14. 知识条目生命周期
  {
    name: 'autosnippet_knowledge_lifecycle',
    tier: 'admin',
    description:
      '知识条目生命周期操作：submit/approve/reject/publish/deprecate/reactivate/fast_track。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '知识条目 ID' },
        action: {
          type: 'string',
          enum: [
            'submit',
            'approve',
            'reject',
            'publish',
            'deprecate',
            'reactivate',
            'to_draft',
            'fast_track',
          ],
        },
        reason: { type: 'string', description: 'reject/deprecate 原因' },
      },
      required: ['id', 'action'],
    },
  },

  // 15. 独立候选校验（调试）
  {
    name: 'autosnippet_validate_candidate',
    tier: 'admin',
    description: '对候选做结构化预校验（5层），调试用（Agent 层的 submit_knowledge 已内置校验）。',
    inputSchema: {
      type: 'object',
      properties: {
        candidate: {
          type: 'object',
          description: '候选结构',
          properties: {
            title: { type: 'string' },
            code: { type: 'string' },
            language: { type: 'string' },
            category: { type: 'string' },
            knowledgeType: { type: 'string' },
            complexity: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
            scope: { type: 'string', enum: ['universal', 'project-specific', 'target-specific'] },
            tags: { type: 'array', items: { type: 'string' } },
            description: { type: 'string' },
            trigger: { type: 'string' },
            usageGuide: { type: 'string' },
            rationale: { type: 'string' },
            headers: { type: 'array', items: { type: 'string' } },
            steps: { type: 'array', items: { type: 'object' } },
            codeChanges: { type: 'array', items: { type: 'object' } },
            constraints: { type: 'object' },
            reasoning: {
              type: 'object',
              properties: {
                whyStandard: { type: 'string' },
                sources: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number' },
              },
            },
          },
        },
        strict: { type: 'boolean', default: false },
      },
      required: ['candidate'],
    },
  },

  // 16. 独立去重检测（调试）
  {
    name: 'autosnippet_check_duplicate',
    tier: 'admin',
    description: '相似度检测（调试用，Agent 层的 submit_knowledge 已内置去重）。',
    inputSchema: {
      type: 'object',
      properties: {
        candidate: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            usageGuide: { type: 'string' },
            code: { type: 'string' },
          },
        },
        threshold: { type: 'number', default: 0.7 },
        topK: { type: 'number', default: 5 },
      },
      required: ['candidate'],
    },
  },
];
