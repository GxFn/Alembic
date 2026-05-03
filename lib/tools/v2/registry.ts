/**
 * @module tools/v2/registry
 *
 * V2 工具注册表 — 单一真相源。
 * 所有工具 metadata、action 参数 schema、handler 函数在此声明式定义。
 * 新增工具/action 只需在此文件加一行。
 */

import { handle as handleCode } from './handlers/code.js';
import { handle as handleGraph } from './handlers/graph.js';
import { handle as handleKnowledge } from './handlers/knowledge.js';
import { handle as handleMemory } from './handlers/memory.js';
import { handle as handleMeta } from './handlers/meta.js';
import { handle as handleTerminal } from './handlers/terminal.js';
import type { ToolRegistry, ToolSpec } from './types.js';

/* ================================================================== */
/*  code — 代码智能                                                    */
/* ================================================================== */

const CODE_SPEC: ToolSpec = {
  name: 'code',
  description: 'Code intelligence: search, read, outline, structure, write',
  actions: {
    search: {
      summary: 'Search source code with patterns',
      description:
        'Search project source code using ripgrep. Supports batch patterns, glob filtering, regex mode.',
      params: {
        type: 'object',
        properties: {
          patterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Search patterns (max 10)',
          },
          glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
          maxResults: { type: 'number', description: 'Max results (default 10, max 50)' },
          contextLines: { type: 'number', description: 'Context lines around match (default 2)' },
          regex: { type: 'boolean', description: 'Use regex mode (default false)' },
        },
        required: ['patterns'],
      },
      handler: async (p, ctx) => handleCode('search', p, ctx),
      cache: 'session',
      concurrency: 'parallel',
      risk: 'read-only',
      maxOutputTokens: 3000,
    },
    read: {
      summary: 'Read file content (adaptive: full/outline/delta)',
      description:
        'Read file with adaptive strategy: ≤500 lines returns full text, >500 lines returns AST outline. Supports line ranges. Delta cache returns "[unchanged]" for re-reads.',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          startLine: { type: 'number', description: '1-based start line (inclusive)' },
          endLine: { type: 'number', description: '1-based end line (inclusive)' },
        },
        required: ['path'],
      },
      handler: async (p, ctx) => handleCode('read', p, ctx),
      cache: 'delta',
      concurrency: 'parallel',
      risk: 'read-only',
      maxOutputTokens: 5000,
    },
    outline: {
      summary: 'File AST skeleton (Tree-sitter)',
      description:
        'Extract file structural skeleton using Tree-sitter AST: classes, functions, interfaces, types with line ranges.',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          kinds: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['class', 'function', 'interface', 'type', 'method', 'enum'],
            },
            description: 'Filter: class/function/interface/type/method/enum',
          },
          maxDepth: { type: 'number', description: 'Max nesting depth' },
        },
        required: ['path'],
      },
      handler: async (p, ctx) => handleCode('outline', p, ctx),
      cache: 'session',
      concurrency: 'parallel',
      risk: 'read-only',
      maxOutputTokens: 2000,
    },
    structure: {
      summary: 'Directory tree listing',
      description:
        'List project directory structure as compact ASCII tree. Ignores node_modules, .git, etc.',
      params: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Directory to list (default: project root)' },
          depth: { type: 'number', description: 'Max depth (default 3, max 5)' },
        },
      },
      handler: async (p, ctx) => handleCode('structure', p, ctx),
      cache: 'session',
      concurrency: 'parallel',
      risk: 'read-only',
      maxOutputTokens: 2000,
    },
    write: {
      summary: 'Write file content',
      description:
        'Create or overwrite a file. Protected paths (.git, node_modules, .env) are blocked.',
      params: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
          content: { type: 'string', description: 'File content' },
          createDirectories: { type: 'boolean', description: 'Create parent dirs (default false)' },
        },
        required: ['path', 'content'],
      },
      handler: async (p, ctx) => handleCode('write', p, ctx),
      concurrency: 'exclusive',
      risk: 'write',
    },
  },
};

/* ================================================================== */
/*  terminal — 终端执行                                                */
/* ================================================================== */

const TERMINAL_SPEC: ToolSpec = {
  name: 'terminal',
  description: 'Execute commands in sandbox with structured output compression',
  actions: {
    exec: {
      summary: 'Execute a shell command',
      description:
        'Run a command in the project directory. Output is automatically compressed (git status, test results, lint output, etc.).',
      params: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute (e.g. "git status")' },
          cwd: { type: 'string', description: 'Working directory (default: project root)' },
          timeout: { type: 'number', description: 'Timeout in ms (default 30000, max 120000)' },
        },
        required: ['command'],
      },
      handler: async (p, ctx) => handleTerminal('exec', p, ctx),
      concurrency: 'single',
      risk: 'side-effect',
      maxOutputTokens: 4000,
    },
  },
};

/* ================================================================== */
/*  knowledge — 知识管理                                               */
/* ================================================================== */

const KNOWLEDGE_SPEC: ToolSpec = {
  name: 'knowledge',
  description: 'Knowledge management: search, submit, detail, manage',
  actions: {
    search: {
      summary: 'Search knowledge base (recipes & candidates)',
      description: 'Search existing recipes and candidates using BM25 + optional vector search.',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          kind: {
            type: 'string',
            enum: ['recipe', 'candidate', 'all'],
            description: 'Filter by kind (default: all)',
          },
          limit: { type: 'number', description: 'Max results (default 10)' },
          category: { type: 'string', description: 'Filter by category' },
        },
        required: ['query'],
      },
      handler: async (p, ctx) => handleKnowledge('search', p, ctx),
      cache: 'session',
      concurrency: 'parallel',
      risk: 'read-only',
    },
    submit: {
      summary: 'Submit knowledge candidate (with auto dedup)',
      description:
        'Create a new knowledge candidate. Auto-checks for duplicates (similarity ≥0.7). Requires complete fields.',
      params: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          content: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              rationale: { type: 'string' },
              pattern: { type: 'string' },
            },
            required: ['markdown', 'rationale'],
          },
          kind: { type: 'string', enum: ['rule', 'pattern', 'fact'] },
          trigger: { type: 'string' },
          whenClause: { type: 'string' },
          doClause: { type: 'string' },
          dontClause: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          reasoning: {
            type: 'object',
            properties: {
              whyStandard: { type: 'string' },
              sources: { type: 'array', items: { type: 'string' } },
              confidence: { type: 'number' },
            },
          },
        },
        required: ['title', 'description', 'content', 'kind', 'trigger', 'whenClause', 'doClause'],
      },
      handler: async (p, ctx) => handleKnowledge('submit', p, ctx),
      concurrency: 'single',
      risk: 'write',
    },
    detail: {
      summary: 'Get recipe/candidate detail by ID',
      description: 'Retrieve full details of a recipe or candidate, including related recipes.',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Recipe or candidate ID' },
        },
        required: ['id'],
      },
      handler: async (p, ctx) => handleKnowledge('detail', p, ctx),
      concurrency: 'parallel',
      risk: 'read-only',
    },
    manage: {
      summary: 'Lifecycle operations (approve/reject/publish/deprecate/evolve/...)',
      description:
        'Perform lifecycle management on recipes: approve, reject, publish, deprecate, update, score, validate, evolve, skip_evolution.',
      params: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: [
              'approve',
              'reject',
              'publish',
              'deprecate',
              'update',
              'score',
              'validate',
              'evolve',
              'skip_evolution',
            ],
          },
          id: { type: 'string' },
          reason: { type: 'string' },
          data: { type: 'object' },
        },
        required: ['operation', 'id'],
      },
      handler: async (p, ctx) => handleKnowledge('manage', p, ctx),
      concurrency: 'single',
      risk: 'write',
    },
  },
};

/* ================================================================== */
/*  graph — 代码图谱                                                   */
/* ================================================================== */

const GRAPH_SPEC: ToolSpec = {
  name: 'graph',
  description: 'Code graph: AST overview, entity/relationship queries',
  actions: {
    overview: {
      summary: 'Project AST overview (languages, modules, stats)',
      description:
        'Get a high-level overview of the project AST: languages, file counts, definition counts, module structure.',
      params: { type: 'object', properties: {} },
      handler: async (p, ctx) => handleGraph('overview', p, ctx),
      cache: 'session',
      concurrency: 'parallel',
      risk: 'read-only',
    },
    query: {
      summary: 'Query code entities and relationships',
      description:
        'Query AST graph for class info, hierarchy, callers/callees, overrides, extensions, impact analysis, or search.',
      params: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'class',
              'protocol',
              'hierarchy',
              'callers',
              'callees',
              'overrides',
              'extensions',
              'impact',
              'search',
            ],
          },
          entity: { type: 'string', description: 'Entity name (class/method/function)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['type'],
      },
      handler: async (p, ctx) => handleGraph('query', p, ctx),
      cache: 'session',
      concurrency: 'parallel',
      risk: 'read-only',
    },
  },
};

/* ================================================================== */
/*  memory — Agent 工作记忆                                            */
/* ================================================================== */

const MEMORY_SPEC: ToolSpec = {
  name: 'memory',
  description: 'Agent working memory: save findings, recall across turns',
  actions: {
    save: {
      summary: 'Save a finding to working memory',
      description: 'Record a key finding for cross-turn recall. Supports tags for filtering.',
      params: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Finding identifier' },
          content: { type: 'string', description: 'Finding content' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering' },
          category: { type: 'string', description: 'Dimension ID (bootstrap scenario)' },
        },
        required: ['key', 'content'],
      },
      handler: async (p, ctx) => handleMemory('save', p, ctx),
      concurrency: 'parallel',
      risk: 'write',
    },
    recall: {
      summary: 'Recall findings from working memory',
      description: 'Retrieve saved findings by keyword query or tags.',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword query' },
          tags: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
      },
      handler: async (p, ctx) => handleMemory('recall', p, ctx),
      concurrency: 'parallel',
      risk: 'read-only',
    },
    note_finding: {
      summary: 'Record a structured key finding to ActiveContext scratchpad',
      description:
        'Record an important discovery with evidence and importance rating. These findings feed into QualityGate evaluation (evidenceScore) and are preserved across context compression.',
      params: {
        type: 'object',
        properties: {
          finding: { type: 'string', description: 'Key finding description' },
          evidence: {
            type: 'string',
            description: 'Evidence reference (file path:line, e.g. "src/App.tsx:42")',
          },
          importance: {
            type: 'number',
            description: 'Importance rating 1-10 (default 5)',
          },
        },
        required: ['finding'],
      },
      handler: async (p, ctx) => handleMemory('note_finding', p, ctx),
      concurrency: 'parallel',
      risk: 'write',
    },
  },
};

/* ================================================================== */
/*  meta — 元工具                                                      */
/* ================================================================== */

const META_SPEC: ToolSpec = {
  name: 'meta',
  description: 'Agent self-reflection: tool schema queries, planning, review',
  actions: {
    tools: {
      summary: 'Query available tools and their full schemas',
      description:
        'Without name: list all tools with summaries. With name: return full action parameter schemas.',
      params: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tool name to get detailed schema for' },
        },
      },
      handler: async (p, ctx) => handleMeta('tools', p, ctx),
      concurrency: 'parallel',
      risk: 'read-only',
    },
    plan: {
      summary: 'Record execution plan',
      description: 'Record a structured execution plan for the current task.',
      params: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                action: { type: 'string' },
                tool: { type: 'string' },
              },
            },
          },
          strategy: { type: 'string' },
        },
        required: ['steps', 'strategy'],
      },
      handler: async (p, ctx) => handleMeta('plan', p, ctx),
      concurrency: 'parallel',
      risk: 'write',
    },
    review: {
      summary: 'Self-review submitted candidates',
      description: 'Review quality of knowledge candidates submitted in this session.',
      params: { type: 'object', properties: {} },
      handler: async (p, ctx) => handleMeta('review', p, ctx),
      concurrency: 'parallel',
      risk: 'read-only',
    },
  },
};

/* ================================================================== */
/*  Registry export                                                    */
/* ================================================================== */

export const TOOL_REGISTRY: ToolRegistry = {
  code: CODE_SPEC,
  terminal: TERMINAL_SPEC,
  knowledge: KNOWLEDGE_SPEC,
  graph: GRAPH_SPEC,
  memory: MEMORY_SPEC,
  meta: META_SPEC,
};

/** 获取所有已注册的工具名 */
export function getToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}

/** 获取指定工具的所有 action 名 */
export function getActionNames(tool: string): string[] {
  const spec = TOOL_REGISTRY[tool];
  return spec ? Object.keys(spec.actions) : [];
}

/** 生成轻量 schema（首轮发给 LLM） */
export function generateLightweightSchemas(
  allowedTools?: Record<string, string[]>
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const schemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }> =
    [];

  for (const [name, spec] of Object.entries(TOOL_REGISTRY)) {
    const allowedActions = allowedTools?.[name];
    if (allowedTools && !allowedActions) {
      continue;
    }

    const actionEnum = allowedActions ?? Object.keys(spec.actions);

    schemas.push({
      name: spec.name,
      description: spec.description,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: actionEnum },
          params: { type: 'object' },
        },
        required: ['action', 'params'],
      },
    });
  }

  return schemas;
}
