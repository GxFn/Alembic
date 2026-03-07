/**
 * AutoSnippet Dashboard API Client
 *
 * 直接调用 V3 RESTful API（/api/v1/*）。
 * 前端统一使用 V3 KnowledgeEntry 类型，不做字段映射。
 *
 * SSE 架构: Session + EventSource（POST 创建会话 → GET EventSource 消费事件）
 */

import axios from 'axios';
import type {
  Recipe,
  RecipeStats,
  ProjectData,
  SPMTarget,
  ExtractedRecipe,
  KnowledgeEntry,
  KnowledgeContent,
  KnowledgeQuality,
  KnowledgeStats,
  KnowledgePaginatedResponse,
  KnowledgeStatsResponse,
  KnowledgeLifecycle,
  KnowledgeKind,
} from './types';

// ═══════════════════════════════════════════════════════
//  Base HTTP Client
// ═══════════════════════════════════════════════════════

const http = axios.create({ baseURL: '/api/v1' });

// ═══════════════════════════════════════════════════════
//  Type Mappers
// ═══════════════════════════════════════════════════════

/** API 返回的 raw 知识条目（可能含别名字段如 name/statistics/status） */
type RawKnowledgeRecord = Partial<KnowledgeEntry> & {
  name?: string;
  statistics?: Record<string, number>;
  status?: string;
  version?: string;
};

/** 候选条目输入类型 — 兼容 ExtractedRecipe 和 KnowledgeEntry 字段 */
type CandidateInput = Partial<ExtractedRecipe & KnowledgeEntry> & {
  isMarked?: boolean;
};

/** V3 KnowledgeEntry → 前端 Recipe 视图类型 */
function toRecipe(r: RawKnowledgeRecord): Recipe {
  const quality = r.quality || {} as KnowledgeQuality;
  const statistics = r.stats || r.statistics || {} as KnowledgeStats;
  const contentObj = r.content || {} as KnowledgeContent;

  const trigger =
    r.trigger ||
    '@' + (r.title || '').replace(/[\s_-]+(.)?/g, (_: string, c: string) => (c ? c.toUpperCase() : ''));

  const stats: RecipeStats = {
    authority: statistics.authority || quality.overall || 0,
    authorityScore: statistics.authority || quality.overall || 0,
    guardUsageCount: statistics.applications || 0,
    humanUsageCount: statistics.adoptions || 0,
    aiUsageCount: 0,
    lastUsedAt: (r.updatedAt ?? null) as string | null,
  };

  return {
    id: r.id,
    name: (r.title || r.name || r.id || '') + '.md',
    content: contentObj,
    category: r.category || '',
    language: r.language || '',
    description: r.description || '',
    status: r.lifecycle || r.status || 'pending',
    kind: r.kind || undefined,
    knowledgeType: r.knowledgeType || undefined,
    // v2Content removed — content is now the V3 structured object
    relations: (r.relations ?? null) as Recipe['relations'],
    constraints: (r.constraints ?? null) as Recipe['constraints'],
    tags: r.tags || [],
    stats,
    trigger,
    source: r.source || '',
    sourceFile: r.sourceFile || '',
    moduleName: r.moduleName || '',
    usageGuide: contentObj.markdown || r.doClause || '',
    reasoning: (r.reasoning ?? null) as Recipe['reasoning'],
    quality: (r.quality ?? null) as Recipe['quality'],
    scope: r.scope || '',
    complexity: r.complexity || '',
    difficulty: r.difficulty || r.complexity || '',
    version: r.version || '',
    headers: r.headers || [],
    updatedAt: r.updatedAt || null,
  };
}

// ═══════════════════════════════════════════════════════
//  Frontmatter Parser (client-side)
// ═══════════════════════════════════════════════════════

function parseFrontmatter(markdownContent: string) {
  let language = '',
    category = 'general',
    title = '',
    trigger = '',
    summary = '';
  let summaryEn = '',
    knowledgeType = '',
    complexity = '',
    scope = '';
  let tags: string[] = [],
    headers: string[] = [],
    difficulty = '',
    authority = 0,
    version = '1.0.0';
  let usageGuide = '',
    usageGuideEn = '',
    rationaleText = '',
    bestPracticesText = '',
    standardsText = '';
  let kind = '', doClause = '', dontClause = '', whenClause = '', topicHint = '';
  let codePattern = markdownContent;

  const fmMatch = markdownContent.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const getField = (key: string): string | null => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    language = getField('language') || language;
    category = getField('category') || category;
    title = getField('title') || title;
    trigger = getField('trigger') || '';
    summary = getField('summary_cn') || getField('summary') || getField('description') || summary;
    summaryEn = getField('summary_en') || '';
    knowledgeType = getField('knowledge_type') || getField('knowledgeType') || '';
    complexity = getField('complexity') || '';
    scope = getField('scope') || '';
    difficulty = getField('difficulty') || '';
    version = getField('version') || '1.0.0';
    const authStr = getField('authority');
    if (authStr) authority = parseInt(authStr) || 0;
    const tagsStr = getField('tags');
    if (tagsStr) {
      try {
        tags = JSON.parse(tagsStr);
      } catch {
        tags = tagsStr.split(',').map((t) => t.trim()).filter(Boolean);
      }
    }
    const headersStr = getField('headers');
    if (headersStr) {
      try {
        headers = JSON.parse(headersStr);
      } catch {
        headers = [headersStr];
      }
    }
    kind = getField('kind') || '';
    doClause = getField('doClause') || '';
    dontClause = getField('dontClause') || '';
    whenClause = getField('whenClause') || '';
    topicHint = getField('topicHint') || '';

    // Extract code block
    const codeBlock = markdownContent.match(/```[\w]*\n([\s\S]*?)```/);
    if (codeBlock) codePattern = codeBlock[1].trim();

    // Extract body sections
    const bodyAfterFm = markdownContent.replace(/^---\n[\s\S]*?\n---/, '').trim();
    const usageMatch = bodyAfterFm.match(
      /## (?:AI Context \/ )?Usage Guide(?:\s*\(CN\))?\n\n([\s\S]*?)(?=\n## |$)/,
    );
    if (usageMatch) usageGuide = usageMatch[1].trim();
    const usageEnMatch = bodyAfterFm.match(
      /## (?:AI Context \/ )?Usage Guide\s*\(EN\)\n\n([\s\S]*?)(?=\n## |$)/,
    );
    if (usageEnMatch) usageGuideEn = usageEnMatch[1].trim();
    const archMatch = bodyAfterFm.match(/## Architecture Usage\n\n([\s\S]*?)(?=\n## |$)/);
    if (archMatch) rationaleText = archMatch[1].trim();
    const bpMatch = bodyAfterFm.match(/## Best Practices\n\n([\s\S]*?)(?=\n## |$)/);
    if (bpMatch) bestPracticesText = bpMatch[1].trim();
    const stdMatch = bodyAfterFm.match(/## Standards\n\n([\s\S]*?)(?=\n## |$)/);
    if (stdMatch) standardsText = stdMatch[1].trim();
  }

  return {
    title,
    language,
    category,
    trigger,
    summary,
    summaryEn,
    knowledgeType,
    complexity,
    scope,
    tags,
    headers,
    difficulty,
    authority,
    version,
    codePattern,
    usageGuide,
    usageGuideEn,
    rationaleText,
    bestPracticesText,
    standardsText,
    kind,
    doClause,
    dontClause,
    whenClause,
    topicHint,
  };
}

// ═══════════════════════════════════════════════════════
//  Request Payload Builders
// ═══════════════════════════════════════════════════════

/** 构建 POST /knowledge 请求体（从前端 item 转为 API payload） */
function toCandidatePayload(item: CandidateInput, targetName: string, source: string) {
  const categoryVal = Array.isArray(item.category) ? item.category[0] : item.category || targetName || 'general';
  return {
    // ── POST /api/v1/knowledge 必填字段 ──
    title: item.title || 'Untitled',
    content: item.content || { pattern: '', markdown: '', rationale: '' },
    // ── 候选元数据 ──
    description: item.description || '',
    trigger: item.trigger || '',
    language: item.language || '',
    category: categoryVal,
    kind: item.kind || 'pattern',
    knowledgeType: item.knowledgeType || 'code-pattern',
    complexity: item.complexity || 'intermediate',
    source: source || 'manual',
    lifecycle: 'pending',
    tags: item.tags || [],
    sourceFile: item.sourceFile || '',
    moduleName: item.moduleName || '',
    headers: item.headers || [],
    headerPaths: item.headerPaths || [],
    reasoning: {
      whyStandard: item.description || item.title || 'Extracted from project',
      sources: [source || 'unknown'],
      confidence: 0.6,
    },
    metadata: {
      targetName: targetName || '',
      title: item.title || '',
      trigger: item.trigger || '',
      description: item.description || '',
      category: categoryVal,
      headers: item.headers || [],
      headerPaths: item.headerPaths || [],
      moduleName: item.moduleName || '',
      isMarked: item.isMarked || false,
    },
  };
}

// ═══════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════

/** 从 idOrName 解析 knowledge ID：如果看起来像 UUID/hash 则直接用，否则按标题搜索 */
async function resolveKnowledgeId(idOrName: string): Promise<string> {
  const cleaned = idOrName.replace(/\.md$/i, '');
  // 如果已经是 ID 格式（UUID 或 hash-like），直接返回
  if (/^[a-f0-9-]{8,}$/i.test(cleaned)) return cleaned;
  // 搜索 knowledge 条目
  const res = await http.get(`/knowledge?limit=1000`);
  const items = res.data?.data?.data || res.data?.data || [];
  const found = items.find((r: { title?: string; name?: string; id?: string }) => {
    const title = r.title || r.name || '';
    return title === cleaned || title + '.md' === idOrName;
  });
  if (found?.id) return found.id;
  throw new Error(`Knowledge entry not found: ${idOrName}`);
}

// ═══════════════════════════════════════════════════════
//  SSE Stream Consumer — 统一协议 v2
// ═══════════════════════════════════════════════════════

/** SSE 统一协议事件类型 */
export type SSEEventType =
  | 'stream:start' | 'stream:done' | 'stream:error'
  | 'step:start' | 'step:end'
  | 'tool:start' | 'tool:end'
  | 'text:start' | 'text:delta' | 'text:end'
  | 'data:progress' | 'data:preview'
  | 'ping';

export interface SSEEvent {
  type: SSEEventType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SSE events have dynamic payloads
  [key: string]: any;
}

/** AI 工具调用 */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}

/** 知识图谱边 */
export interface GraphEdge {
  id: number;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  relation: string;
  weight: number;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

/** 搜索结果条目 */
export interface SearchResultItem {
  title: string;
  content: KnowledgeContent;
  score: number;
  qualityScore?: number;
  usageCount?: number;
  authorityScore?: number;
  matchType?: string;
  [key: string]: unknown;
}

/** AI 服务商信息 */
export interface AiProviderInfo {
  id: string;
  name: string;
  label: string;
  defaultModel: string;
  hasKey?: boolean;
  models?: string[];
  [key: string]: unknown;
}

/** Skill 元信息 */
export interface SkillInfo {
  name: string;
  source: 'builtin' | 'project';
  summary: string;
  useCase: string | null;
  createdBy: string | null;
  createdAt: string | null;
  description?: string;
  [key: string]: unknown;
}

/** 搜索 API 返回的原始结果条目 */
interface RawSearchResult {
  name?: string;
  content?: unknown;
  similarity?: number;
  qualityScore?: number;
  usageCount?: number;
  authority?: number;
  matchType?: string;
  [key: string]: unknown;
}

/**
 * 统一 SSE 流消费器 — 从 fetch Response 中逐行读取 SSE events
 *
 * 支持统一协议的所有事件类型:
 *   stream:start — 会话开始
 *   step:start   — 推理步骤开始
 *   tool:start   — 工具调用开始
 *   tool:end     — 工具调用结束
 *   text:start   — 文本流开始
 *   text:delta   — 文本分块
 *   text:end     — 文本流结束
 *   step:end     — 推理步骤结束
 *   data:progress — 进度事件（润色等场景）
 *   stream:done  — 会话完成
 *   stream:error — 会话错误
 *
 * @param response   fetch 返回的 Response（body 为 ReadableStream）
 * @param onEvent    收到任意事件时的完整回调
 * @returns          通过 text:delta 拼接的完整文本（chat 场景使用）
 */
async function _consumeSSE(
  response: Response,
  onEvent: (evt: SSEEvent) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('ReadableStream not available');

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let chunkCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunkCount++;
    const text = decoder.decode(value, { stream: true });

    buffer += text;
    const lines = buffer.split('\n');
    // 保留最后一个不完整行
    buffer = lines.pop() || '';

    for (const line of lines) {
      // 心跳 :ping 注释 — 忽略
      if (line.startsWith(':')) continue;
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const evt: SSEEvent = JSON.parse(payload);
        onEvent(evt);

        // text:delta — 拼接完整文本
        if (evt.type === 'text:delta' && evt.delta) {
          fullText += evt.delta;
        }
        // stream:done — 如果携带 text 则覆盖
        else if (evt.type === 'stream:done' && evt.text) {
          fullText = evt.text;
        }
        // stream:error — 抛出错误
        else if (evt.type === 'stream:error') {
          throw new Error(evt.message || 'Stream error');
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // 非 JSON 行忽略
        throw e;
      }
    }
  }

  return fullText;
}

// ═══════════════════════════════════════════════════════
//  API Methods  (v2 — EventSource architecture)
// ═══════════════════════════════════════════════════════
export const api = {
  // ── Data (bulk fetch) ──────

  async fetchData(): Promise<ProjectData> {
    const [knowledgeRes, aiConfigRes, projectInfoRes] = await Promise.all([
      http.get('/knowledge?limit=1000').catch(() => ({ data: { success: true, data: { data: [] } } })),
      http.get('/ai/config').catch(() => ({ data: { success: true, data: { provider: '', model: '' } } })),
      http.get('/modules/project-info').catch(() => ({ data: { success: true, data: { projectRoot: '' } } })),
    ]);

    // All knowledge entries from V3 backend
    const allEntries: KnowledgeEntry[] = knowledgeRes.data?.data?.data || knowledgeRes.data?.data?.items || [];

    // Recipes = active lifecycle entries (auto-approved / manually approved)
    const activeEntries = allEntries.filter((e) => e.lifecycle === 'active');
    const recipes = activeEntries.map(toRecipe);

    // Candidates 视图仅展示待审核状态，过滤掉已发布/已弃用的条目
    const rawEntries = allEntries.filter((e) => e.lifecycle === 'pending');
    const candidates: ProjectData['candidates'] = {};
    for (const entry of rawEntries) {
      const target = entry.category || entry.language || '_pending';
      if (!candidates[target]) {
        candidates[target] = { targetName: target, scanTime: entry.createdAt, items: [] };
      }
      candidates[target].items.push(entry);
    }

    // AI Config
    const aiConfig = aiConfigRes.data?.data || { provider: '', model: '' };

    // 全局 ID→标题 查找表 (将 UUID 关联解析为可读标题)
    const idTitleMap: Record<string, string> = {};
    for (const e of allEntries) {
      if (e.id && e.title) idTitleMap[e.id] = e.title;
    }

    // Project root for per-project storage isolation
    const projectRoot = projectInfoRes.data?.data?.projectRoot || '';
    const projectName = projectInfoRes.data?.data?.projectName || '';

    return {
      rootSpec: { list: [] },
      recipes,
      candidates,
      projectRoot,
      projectName,
      watcherStatus: 'active',
      aiConfig: { provider: aiConfig.provider || '', model: aiConfig.model || '' },
      idTitleMap,
    };
  },

  // ── Modules (多语言统一模块扫描) ───────

  async fetchTargets(): Promise<SPMTarget[]> {
    const res = await http.get('/modules/targets');
    const data = res.data?.data || {};
    return data.targets || [];
  },

  async getTargetFiles(target: SPMTarget, signal?: AbortSignal) {
    const res = await http.post('/modules/target-files', { target }, { signal });
    const data = res.data?.data || {};
    return { files: data.files || [], count: data.total || data.files?.length || 0 };
  },

  async scanTarget(target: SPMTarget, signal?: AbortSignal) {
    const res = await http.post('/modules/scan', { target }, { signal, timeout: 600000 });
    const data = res.data?.data || {};
    const recipes = data.recipes || data.result || [];
    return { recipes, scannedFiles: data.scannedFiles || [], message: data.message || '', noAi: !!data.noAi };
  },

  /**
   * 流式 Target 扫描 — SSE Session + EventSource 架构
   * POST 创建 session → EventSource 消费进度事件 → scan:result 携带最终结果
   */
  async scanTargetStream(
    target: SPMTarget,
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<{ recipes: ExtractedRecipe[]; scannedFiles: string[]; message: string; noAi?: boolean }> {
    // Step 1: POST 创建流式扫描会话
    let sessionId: string;
    const startRes = await fetch('/api/v1/modules/scan/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
      signal,
    });
    if (!startRes.ok) throw new Error(`Scan stream start failed: ${startRes.status}`);
    const startData = await startRes.json();
    sessionId = startData.sessionId;
    if (!sessionId) throw new Error(`No sessionId returned`);

    // Step 2: EventSource 消费 SSE 事件
    return new Promise((resolve, reject) => {
      const esUrl = `/api/v1/modules/scan/events/${sessionId}`;
      const es = new EventSource(esUrl);
      let resolved = false;
      let finalResult = { recipes: [] as ExtractedRecipe[], scannedFiles: [] as string[], message: '', noAi: false };

      function cleanup() { es.close(); }

      es.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          onEvent(evt);

          if (evt.type === 'scan:result') {
            finalResult = {
              recipes: evt.recipes || [],
              scannedFiles: evt.scannedFiles || [],
              message: evt.message || '',
              noAi: !!evt.noAi,
            };
          }

          if (evt.type === 'stream:done') {
            cleanup();
            resolved = true;
            resolve(finalResult);
          }

          if (evt.type === 'stream:error') {
            cleanup();
            resolved = true;
            reject(new Error(evt.message || 'Scan stream error'));
          }
        } catch { /* ignore JSON parse errors */ }
      };

      es.onerror = () => {
        if (!resolved) {
          cleanup();
          resolved = true;
          // If we already have results, resolve with them
          if (finalResult.recipes.length > 0) {
            resolve(finalResult);
          } else {
            reject(new Error('EventSource connection failed'));
          }
        }
      };

      if (signal) {
        const onAbort = () => {
          if (!resolved) {
            cleanup();
            resolved = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  },

  /** 全项目扫描：AI 提取 + Guard 审计 */
  async scanProject(signal?: AbortSignal) {
    const res = await http.post('/modules/scan-project', {}, { signal, timeout: 600000 });
    const data = res.data?.data || {};
    return {
      targets: data.targets || [],
      recipes: data.recipes || [],
      guardAudit: data.guardAudit || null,
      scannedFiles: data.scannedFiles || [],
      partial: data.partial || false,
    };
  },

  /**
   * 浏览项目目录结构 — 供目录选择器使用
   */
  async browseDirectories(basePath = '', depth = 3): Promise<import('./types').ProjectDirectory[]> {
    const params = new URLSearchParams();
    if (basePath) params.set('path', basePath);
    if (depth) params.set('depth', String(depth));
    const res = await http.get(`/modules/browse-dirs?${params.toString()}`);
    return res.data?.data?.directories || [];
  },

  /**
   * 流式扫描任意目录 — SSE Session 架构
   * 复用已有 scan-events SSE 通道
   */
  async scanFolderStream(
    folderPath: string,
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<{ recipes: ExtractedRecipe[]; scannedFiles: string[]; message: string; noAi?: boolean }> {
    // Step 1: POST 创建流式扫描会话
    const startRes = await fetch('/api/v1/modules/scan-folder/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath }),
      signal,
    });
    if (!startRes.ok) throw new Error(`Scan folder start failed: ${startRes.status}`);
    const startData = await startRes.json();
    const sessionId = startData.sessionId;
    if (!sessionId) throw new Error('No sessionId returned');

    // Step 2: EventSource 消费 SSE 事件（复用已有通道）
    return new Promise((resolve, reject) => {
      const esUrl = `/api/v1/modules/scan/events/${sessionId}`;
      const es = new EventSource(esUrl);
      let resolved = false;
      let finalResult = { recipes: [] as ExtractedRecipe[], scannedFiles: [] as string[], message: '', noAi: false };

      function cleanup() { es.close(); }

      es.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          onEvent(evt);

          if (evt.type === 'scan:result') {
            finalResult = {
              recipes: evt.recipes || [],
              scannedFiles: evt.scannedFiles || [],
              message: evt.message || '',
              noAi: !!evt.noAi,
            };
          }

          if (evt.type === 'stream:done') {
            cleanup();
            resolved = true;
            resolve(finalResult);
          }

          if (evt.type === 'stream:error') {
            cleanup();
            resolved = true;
            reject(new Error(evt.message || 'Scan folder stream error'));
          }
        } catch { /* ignore */ }
      };

      es.onerror = () => {
        if (!resolved) {
          cleanup();
          resolved = true;
          if (finalResult.recipes.length > 0) {
            resolve(finalResult);
          } else {
            reject(new Error('EventSource connection failed'));
          }
        }
      };

      if (signal) {
        const onAbort = () => {
          if (!resolved) {
            cleanup();
            resolved = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  },

  /** 冷启动：快速骨架 + 异步逐维度填充（v5） */
  async bootstrap(signal?: AbortSignal) {
    const res = await http.post('/modules/bootstrap', {}, { signal, timeout: 300000 });
    const data = res.data?.data || {};
    return {
      report: data.report || {},
      targets: data.targets || [],
      filesByTarget: data.filesByTarget || {},
      dependencyGraph: data.dependencyGraph || null,
      languageStats: data.languageStats || {},
      primaryLanguage: data.primaryLanguage || '',
      guardSummary: data.guardSummary || null,
      guardViolationFiles: data.guardViolationFiles || [],
      bootstrapCandidates: data.bootstrapCandidates || { created: 0, failed: 0 },
      bootstrapSession: data.bootstrapSession || null,
      asyncFill: data.asyncFill || false,
      message: data.message || '',
    };
  },

  /** 查询 bootstrap 异步填充进度（Socket.io 不可用时的 fallback） */
  async getBootstrapStatus() {
    const res = await http.get('/modules/bootstrap/status');
    return res.data?.data || { status: 'idle' };
  },

  async getDepGraph(level: string) {
    const res = await http.get(`/modules/dep-graph?level=${level}`);
    return res.data?.data || {};
  },

  /** 获取项目信息（检测到的语言、框架等） */
  async getProjectInfo() {
    try {
      const res = await http.get('/modules/project-info');
      return res.data?.data || {};
    } catch {
      return { primaryLanguage: 'unknown', discoverers: [], hasSpm: false };
    }
  },

  // ── Commands ────────────────────────────────────────

  async syncSnippets(target: 'xcode' | 'vscode' | 'all' = 'all'): Promise<Record<string, unknown>> {
    const res = await http.post('/commands/install', { target });
    return res.data;
  },

  async refreshProject(): Promise<void> {
    try {
      await http.post('/modules/update-map');
    } catch {
      await http.post('/commands/spm-map');
    }
  },

  // ── Extract ─────────────────────────────────────────

  async extractFromPath(
    relativePath: string,
  ): Promise<{ result: ExtractedRecipe[]; isMarked: boolean }> {
    const res = await http.post('/extract/path', { relativePath });
    const data = res.data?.data || {};
    return { result: data.result || [], isMarked: data.isMarked || false };
  },

  async extractFromText(
    text: string,
    relativePath?: string,
  ): Promise<ExtractedRecipe> {
    const res = await http.post('/extract/text', {
      text,
      ...(relativePath ? { relativePath } : {}),
    });
    const data = res.data?.data || {};
    // API returns {result: [], source} — take first item or the whole object
    if (Array.isArray(data.result) && data.result.length > 0) {
      return data.result[0];
    }
    // fallback: might return the item directly
    return data as ExtractedRecipe;
  },

  // ── Recipes ─────────────────────────────────────────

  /**
   * Save recipe from markdown content.
   * Parses frontmatter → structured data, creates or updates.
   */
  async saveRecipe(name: string, markdownContent: string): Promise<void> {
    const parsed = parseFrontmatter(markdownContent);
    const title = parsed.title || name.replace(/\.md$/, '');

    const dimensions = {
      trigger: parsed.trigger,
      headers: parsed.headers,
      difficulty: parsed.difficulty,
      authority: parsed.authority,
      version: parsed.version,
    };

    const contentObj = {
      pattern: parsed.codePattern || '',
      rationale: parsed.rationaleText || '',
      steps: parsed.bestPracticesText ? [parsed.bestPracticesText] : [],
      codeChanges: [],
      verification: null,
      markdown: parsed.usageGuide || '',
    };

    // 解析 Standards 文本为结构化 constraints
    const constraintsObj: Record<string, unknown> = {};
    if (parsed.standardsText) {
      // 解析 "**Preconditions:**\n- item1\n- item2" 格式
      const lines = parsed.standardsText.split('\n').map((l: string) => l.trim()).filter(Boolean);
      const preconditions = lines
        .filter((l: string) => l.startsWith('- '))
        .map((l: string) => l.slice(2).trim());
      if (preconditions.length > 0) {
        constraintsObj.preconditions = preconditions;
      }
      // 非列表内容保留为 boundaries
      const nonList = lines.filter((l: string) => !l.startsWith('- ') && !l.startsWith('**'));
      if (nonList.length > 0) {
        constraintsObj.boundaries = nonList;
      }
    }

    const recipeData: Record<string, unknown> = {
      title,
      language: parsed.language,
      category: parsed.category,
      description: parsed.summary,
      knowledgeType: parsed.knowledgeType || 'code-pattern',
      complexity: parsed.complexity || 'intermediate',
      scope: parsed.scope || null,
      tags: parsed.tags || [],
      content: contentObj,
      constraints: constraintsObj,
      dimensions,
    };
    if (parsed.kind) recipeData.kind = parsed.kind;
    if (parsed.doClause) recipeData.doClause = parsed.doClause;
    if (parsed.dontClause) recipeData.dontClause = parsed.dontClause;
    if (parsed.whenClause) recipeData.whenClause = parsed.whenClause;
    if (parsed.topicHint) recipeData.topicHint = parsed.topicHint;

    // Try to find existing recipe by ID or title → update
    try {
      const knowledgeId = await resolveKnowledgeId(name);
      await http.patch(`/knowledge/${knowledgeId}`, recipeData);
      return;
    } catch {
      /* create new */
    }

    await http.post('/knowledge', recipeData);
  },

  async deleteRecipe(idOrName: string): Promise<void> {
    // 优先用 ID（V3），否则按名称搜索
    const knowledgeId = await resolveKnowledgeId(idOrName);
    await http.delete(`/knowledge/${knowledgeId}`);
  },

  async getRecipeByName(
    name: string,
  ): Promise<{ name: string; content: string }> {
    const knowledgeId = await resolveKnowledgeId(name);
    const res = await http.get(`/knowledge/${knowledgeId}`);
    const r = res.data?.data;
    if (!r) throw new Error('Recipe not found');
    const c = r.content || {};
    return { name, content: c.pattern || c.markdown || '' };
  },

  async setRecipeAuthority(idOrName: string, authority: number): Promise<void> {
    const knowledgeId = await resolveKnowledgeId(idOrName);
    await http.patch(`/knowledge/${knowledgeId}/quality`, {
      codeCompleteness: authority,
      projectAdaptation: authority,
      documentationClarity: authority,
    });
  },

  async updateRecipeRelations(idOrName: string, relations: Record<string, unknown[]>): Promise<void> {
    const knowledgeId = await resolveKnowledgeId(idOrName);
    await http.patch(`/knowledge/${knowledgeId}`, { relations });
  },

  // searchRecipes — removed, use search() instead

  // ── Candidates (via V3 Knowledge API) ──────────────────────────────────────

  /** 获取单个知识条目详情 */
  async getCandidate(candidateId: string): Promise<KnowledgeEntry> {
    const res = await http.get(`/knowledge/${candidateId}`);
    const raw = res.data?.data;
    if (!raw) throw new Error('Knowledge entry not found');
    return raw as KnowledgeEntry;
  },

  async deleteCandidate(candidateId: string): Promise<void> {
    await http.delete(`/knowledge/${candidateId}`);
  },

  /** 一键将 Candidate 发布为 Recipe (V3: publish → active) */
  async promoteCandidateToRecipe(candidateId: string, _overrides?: Record<string, unknown>): Promise<{ recipe: KnowledgeEntry; candidate: KnowledgeEntry }> {
    const res = await http.patch(`/knowledge/${candidateId}/publish`);
    const entry = res.data?.data;
    return { recipe: entry, candidate: entry };
  },

  /** AI 语义字段补全 — 对候选批量补充缺失字段 */
  async enrichCandidates(candidateIds: string[]): Promise<{ enriched: number; total: number; results: Array<{ id: string; enriched: boolean; filledFields: string[] }> }> {
    const res = await http.post('/candidates/enrich', { candidateIds });
    return res.data?.data || { enriched: 0, total: 0, results: [] };
  },

  /** ② 内容润色 — 对 Bootstrap 候选进行 AI 精炼（支持自定义提示词） */
  async bootstrapRefine(candidateIds?: string[], userPrompt?: string, dryRun?: boolean): Promise<{ refined: number; total: number; errors: unknown[]; results: unknown[] }> {
    const res = await http.post('/candidates/bootstrap-refine', { candidateIds, userPrompt, dryRun }, { timeout: 300000 });
    return res.data?.data || { refined: 0, total: 0, errors: [], results: [] };
  },

  /** 对话式润色 — 预览：单条候选 dryRun，返回 before/after 对比 */
  async refinePreview(candidateId: string, userPrompt?: string): Promise<{ candidateId: string; before: Record<string, unknown>; after: Record<string, unknown>; preview: Record<string, unknown> }> {
    const res = await http.post('/candidates/refine-preview', { candidateId, userPrompt }, { timeout: 120000 });
    return res.data?.data || {};
  },

  /** 对话式润色 — 应用：确认写入变更（优先传 preview 避免二次 AI 调用） */
  async refineApply(candidateId: string, userPrompt?: string, preview?: Record<string, unknown>): Promise<{ refined: number; total: number; candidate: KnowledgeEntry }> {
    const res = await http.post('/candidates/refine-apply', { candidateId, userPrompt, preview }, { timeout: 120000 });
    return res.data?.data || {};
  },

  /** 获取全量知识图谱（边 + 节点标签） */
  async getKnowledgeGraph(limit = 500): Promise<{ edges: GraphEdge[]; nodeLabels: Record<string, string>; nodeTypes: Record<string, string>; nodeCategories: Record<string, string> }> {
    const res = await http.get(`/search/graph/all?limit=${limit}`);
    return res.data?.data || { edges: [], nodeLabels: {}, nodeTypes: {}, nodeCategories: {} };
  },

  /** 获取知识图谱统计 */
  async getGraphStats(): Promise<{ totalEdges: number; byRelation: Record<string, number>; nodeTypes: unknown[] }> {
    const res = await http.get('/search/graph/stats');
    return res.data?.data || { totalEdges: 0, byRelation: {}, nodeTypes: [] };
  },

  /** AI 批量发现 Recipe 知识图谱关系（异步启动） */
  async discoverRelations(batchSize = 20): Promise<{ status: string; startedAt?: string; message?: string; error?: string }> {
    const res = await http.post('/recipes/discover-relations', { batchSize });
    if (!res.data?.success) throw new Error(res.data?.error?.message || '启动失败');
    return res.data?.data || { status: 'unknown' };
  },

  /** 查询关系发现任务状态 */
  async getDiscoverRelationsStatus(): Promise<{ status: string; discovered?: number; totalPairs?: number; batchErrors?: number; error?: string; elapsed?: number; message?: string; startedAt?: string }> {
    const res = await http.get('/recipes/discover-relations/status');
    return res.data?.data || { status: 'idle' };
  },

  async deleteAllCandidatesInTarget(targetName: string): Promise<{ deleted: number }> {
    // V3: list all entries with this category then delete individually
    const res = await http.get(`/knowledge?category=${encodeURIComponent(targetName)}&limit=1000`);
    const items = res.data?.data?.data || [];
    let deleted = 0;
    for (const item of items) {
      try {
        await http.delete(`/knowledge/${item.id}`);
        deleted++;
      } catch { /* skip */ }
    }
    return { deleted };
  },

  async promoteToCandidate(
    item: CandidateInput,
    targetName: string,
  ): Promise<{ ok: boolean; candidateId: string }> {
    const data = toCandidatePayload(item, targetName, 'review-promote');
    const res = await http.post('/knowledge', data);
    return { ok: true, candidateId: res.data?.data?.id || '' };
  },

  async getCandidateSimilarity(
    code: string,
    language: string,
  ): Promise<{ similar: Array<{ recipeName: string; similarity: number }> }> {
    const res = await http.post('/search/similarity', { code, language }).catch(() => ({ data: { data: { similar: [] } } }));
    return res.data?.data || { similar: [] };
  },

  /** getCandidateSimilarityEx: supports targetName+candidateId or candidate object */
  async getCandidateSimilarityEx(
    params: { targetName?: string; candidateId?: string; candidate?: Partial<KnowledgeEntry> },
  ): Promise<{ similar: Array<{ recipeName: string; similarity: number }> }> {
    const res = await http.post('/search/similarity', params).catch(() => ({ data: { data: { similar: [] } } }));
    return res.data?.data || { similar: [] };
  },

  /** Get recipe content by name (for compare modals) */
  async getRecipeContentByName(
    name: string,
  ): Promise<{ name: string; content: string }> {
    const knowledgeId = await resolveKnowledgeId(name);
    const res = await http.get(`/knowledge/${knowledgeId}`);
    const r = res.data?.data;
    if (!r) throw new Error('Recipe not found');
    const recipe = toRecipe(r);
    // 将 V3 结构化 content 序列化为 markdown 字符串（用于 compare drawer 等需要纯文本的场景）
    const c = recipe.content;
    const contentStr = [c?.pattern, c?.markdown].filter(Boolean).join('\n\n') || '';
    return { name, content: contentStr };
  },

  // ── AI ──────────────────────────────────────────────

  async getAiProviders(): Promise<AiProviderInfo[]> {
    const res = await http.get('/ai/providers');
    return res.data?.data || [];
  },

  async setAiConfig(
    provider: string,
    model: string,
  ): Promise<{ provider: string; model: string }> {
    const res = await http.post('/ai/config', { provider, model });
    return res.data?.data || { provider, model };
  },

  async chat(
    prompt: string,
    history: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
  ): Promise<{ text: string; hasContext?: boolean }> {
    const res = await http.post('/ai/chat', { prompt, history }, { signal });
    const data = res.data?.data || {};
    return { text: data.reply || data.text || '', hasContext: data.hasContext };
  },

  /**
   * 流式 AI 对话 (SSE) — 统一协议 v2
   *
   * 事件类型（按时间顺序）:
   *   - stream:start  — 会话开始
   *   - step:start    — 新推理步骤 { step, maxSteps, phase }
   *   - tool:start    — 工具调用开始 { id, tool, args }
   *   - tool:end      — 工具调用结束 { tool, status, resultSize?, duration?, error? }
   *   - text:start    — 文本流开始 { id, role }
   *   - text:delta    — 文本分块 { id, delta }  ← 逐块推送，前端可逐字渲染
   *   - text:end      — 文本流结束 { id }
   *   - step:end      — 推理步骤结束 { step }
   *   - stream:done   — 全部完成 { text, toolCalls, hasContext }
   *   - stream:error  — 错误 { message }
   *
   * @param prompt       用户消息
   * @param history      对话历史
   * @param onEvent      每收到一个 SSE 事件的回调（前端根据 type 分别处理）
   * @param signal       可选 AbortSignal
   * @returns            { text, toolCalls, hasContext }
   */
  async chatStream(
    prompt: string,
    history: Array<{ role: string; content: string }>,
    onEvent: (event: SSEEvent) => void,
    signal?: AbortSignal,
    /** UI language preference — forwarded to Agent for reply language control */
    lang?: 'zh' | 'en',
  ): Promise<{ text: string; toolCalls?: ToolCall[]; hasContext?: boolean }> {

    // ── Step 1: POST 启动对话 ──
    const startRes = await fetch('/api/v1/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, history, ...(lang ? { lang } : {}) }),
      signal,
    });
    if (!startRes.ok) throw new Error(`Chat start failed: ${startRes.status}`);

    const contentType = startRes.headers.get('content-type') || '';

    // ── 兼容检测: 旧后端返回 text/event-stream, 新后端返回 JSON ──
    if (contentType.includes('text/event-stream')) {
      // 旧后端 — 直接用 fetch ReadableStream 消费 SSE（降级模式）
      let finalResult: { text: string; toolCalls?: ToolCall[]; hasContext?: boolean } = { text: '' };
      const fullText = await _consumeSSE(startRes, (evt) => {
        onEvent(evt);
        if (evt.type === 'stream:done') {
          if (evt.text) finalResult.text = evt.text;
          finalResult.toolCalls = evt.toolCalls;
          finalResult.hasContext = evt.hasContext;
        }
      });
      if (!finalResult.text && fullText) finalResult.text = fullText;
      return finalResult;
    }

    // ── 新后端: 获取 sessionId → EventSource ──
    const startData = await startRes.json();
    const sessionId = startData.sessionId;
    if (!sessionId) throw new Error(`No sessionId returned: ${JSON.stringify(startData)}`);

    // ── Step 2: 通过 EventSource 消费 SSE 事件 ──
    return new Promise<{ text: string; toolCalls?: ToolCall[]; hasContext?: boolean }>((resolve, reject) => {
      const esUrl = `/api/v1/ai/chat/events/${sessionId}`;
      const es = new EventSource(esUrl);
      let fullText = '';
      let finalResult: { text: string; toolCalls?: ToolCall[]; hasContext?: boolean } = { text: '' };
      let resolved = false;

      function cleanup() {
        es.close();
      }

      es.onmessage = (e) => {
        try {
          const evt: SSEEvent = JSON.parse(e.data);

          // 跳过内部的 stream:start（EventSource 基础设施事件）
          if (evt.type === 'stream:start') return;

          // 交付事件给上层回调
          onEvent(evt);

          // 累积 text:delta 文本
          if (evt.type === 'text:delta' && evt.delta) {
            fullText += evt.delta;
          }

          // 会话完成
          if (evt.type === 'stream:done') {
            finalResult = {
              text: evt.text || fullText,
              toolCalls: evt.toolCalls,
              hasContext: evt.hasContext,
            };
            cleanup();
            resolved = true;
            resolve(finalResult);
          }

          // 会话错误
          if (evt.type === 'stream:error') {
            cleanup();
            resolved = true;
            reject(new Error(evt.message || 'Stream error'));
          }
        } catch {
          // 忽略 JSON 解析错误
        }
      };

      es.onerror = () => {
        if (!resolved) {
          cleanup();
          if (fullText) {
            resolved = true;
            resolve({ text: fullText });
          } else {
            resolved = true;
            reject(new Error('EventSource connection failed'));
          }
        }
      };

      // 处理 AbortSignal
      if (signal) {
        const onAbort = () => {
          if (!resolved) {
            cleanup();
            resolved = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });
  },

  /**
   * 润色预览 (SSE) — 统一协议 v2
   * 不再推送 JSON 碎片，改为进度事件 + 最终结构化结果
   *
   * 事件类型:
   *   - stream:start   — 会话开始
   *   - data:progress   — AI 润色进度 { stage, message }
   *   - stream:done     — 完成 { candidateId, before, after, preview }
   *   - stream:error    — 错误 { message }
   *
   * @param candidateId  候选条目 ID
   * @param userPrompt   用户润色指令
   * @param onEvent      每收到一个 SSE 事件的回调（前端根据 type 处理进度 UI）
   * @param signal       可选 AbortSignal
   * @returns            { candidateId, before, after, preview }
   */
  async refinePreviewStream(
    candidateId: string,
    userPrompt: string,
    onEvent: (event: SSEEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ candidateId: string; before: Record<string, unknown>; after: Record<string, unknown>; preview: Record<string, unknown> | null }> {
    // Step 1: POST 创建流式润色会话
    const startRes = await fetch('/api/v1/candidates/refine-preview-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId, userPrompt }),
      signal,
    });
    if (!startRes.ok) throw new Error(`Refine stream start failed: ${startRes.status}`);
    const startData = await startRes.json();
    const sessionId = startData.sessionId;
    if (!sessionId) throw new Error('No sessionId returned');

    // Step 2: EventSource 消费 SSE 事件
    return new Promise((resolve, reject) => {
      const esUrl = `/api/v1/candidates/refine-preview/events/${sessionId}`;
      const es = new EventSource(esUrl);
      let resolved = false;

      function cleanup() { es.close(); }

      // 如果外部 signal 触发 abort，关闭 EventSource
      if (signal) {
        signal.addEventListener('abort', () => {
          cleanup();
          if (!resolved) {
            resolved = true;
            reject(new DOMException('Aborted', 'AbortError'));
          }
        }, { once: true });
      }

      es.onmessage = (e) => {
        try {
          const evt: SSEEvent = JSON.parse(e.data);
          onEvent(evt);

          if (evt.type === 'stream:done') {
            cleanup();
            resolved = true;
            resolve({
              candidateId: (evt.candidateId as string) || candidateId,
              before: (evt.before as Record<string, unknown>) || {},
              after: (evt.after as Record<string, unknown>) || {},
              preview: (evt.preview as Record<string, unknown>) || null,
            });
          }

          if (evt.type === 'stream:error') {
            cleanup();
            resolved = true;
            reject(new Error((evt.message as string) || 'Refine stream error'));
          }
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        cleanup();
        if (!resolved) {
          resolved = true;
          reject(new Error('Refine EventSource connection lost'));
        }
      };
    });
  },

  async summarizeCode(code: string, language: string): Promise<Record<string, unknown>> {
    const res = await http.post('/ai/summarize', { code, language });
    return res.data?.data || res.data || {};
  },

  async translate(
    summary: string,
    usageGuide: string,
  ): Promise<{ summaryEn: string; usageGuideEn: string; warning?: string }> {
    const res = await http.post('/ai/translate', { summary, usageGuide });
    const data = res.data?.data || { summaryEn: '', usageGuideEn: '' };
    if (res.data?.warning) data.warning = res.data.warning;
    return data;
  },

  // ── Search (统一入口) ─────────────────────────────────

  /**
   * 统一搜索 — 合并 keyword/bm25/semantic/auto/context-aware 全场景
   *
   * - 无 context → GET /search (keyword/bm25/semantic/auto)
   * - 有 context → POST /search/context-aware (BM25 + Ranking + ContextBoost)
   *
   * 返回的 items 中 content 已从 JSON 字符串解析为对象。
   */
  async search(
    query: string,
    options: {
      mode?: 'keyword' | 'bm25' | 'semantic' | 'auto';
      type?: string;
      limit?: number;
      signal?: AbortSignal;
      context?: { language?: string; sessionHistory?: unknown[]; [key: string]: unknown };
    } = {},
  ): Promise<{ items: SearchResultItem[]; total: number; mode?: string; ranked?: boolean }> {
    const { mode = 'bm25', type, limit = 20, signal, context } = options;

    // 解析 content JSON 字符串为对象
    const parseContent = (raw: unknown): KnowledgeContent => {
      if (!raw) return {} as KnowledgeContent;
      if (typeof raw === 'object') return raw as KnowledgeContent;
      try { return JSON.parse(String(raw)) as KnowledgeContent; } catch { return { markdown: String(raw) }; }
    };

    // ── 有 context: POST /search/context-aware ──
    if (context) {
      const res = await http.post('/search/context-aware', {
        keyword: query, limit,
        language: context.language,
        sessionHistory: context.sessionHistory || [],
      }, { signal }).catch(() => ({ data: { data: {} } }));
      const data = res.data?.data || {};
      const items: SearchResultItem[] = (data.results || []).map((r: RawSearchResult) => {
        const content = parseContent(r.content);
        return {
          title: (r.name || '').replace(/\.md$/, ''),
          content,
          score: r.similarity || 0,
          qualityScore: r.qualityScore || 0,
          usageCount: r.usageCount || 0,
          authorityScore: r.authority || 0,
          matchType: r.matchType,
        };
      });
      return { items, total: data.total || items.length, mode: 'bm25', ranked: true };
    }

    // ── 无 context: GET /search ──
    const params = new URLSearchParams({ q: query, mode, limit: String(limit) });
    if (type) params.set('type', type);
    const res = await http.get(`/search?${params}`, { signal });
    const data = res.data?.data || {};
    const items: SearchResultItem[] = (data.items || []).map((r: RawSearchResult) => ({
      ...r,
      content: parseContent(r.content),
    }));
    return {
      items,
      total: data.totalResults || data.total || items.length,
      mode: data.mode,
      ranked: data.ranked,
    };
  },

  async xcodeSimulateSearch(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await http
      .post('/search/xcode-simulate', data)
      .catch(() => ({ data: { data: {} } }));
    return res.data?.data || {};
  },

  // ── Guard ───────────────────────────────────────────

  async getGuardRules(): Promise<{ rules: Record<string, any>; projectLanguages: string[] }> {
    const res = await http.get('/rules?limit=100');
    const data = res.data?.data || {};
    const items: Array<{ id: string; [key: string]: unknown }> = data.data || data.items || [];
    const rules: Record<string, Record<string, unknown>> = {};
    for (const r of items) {
      rules[r.id] = r;
    }
    return { rules, projectLanguages: data.projectLanguages || [] };
  },

  async getGuardViolations(): Promise<{ runs: any[] }> {
    const res = await http.get('/violations');
    const data = res.data?.data || {};
    return { runs: data.data || data.items || [] };
  },

  async clearViolations(): Promise<void> {
    await http.post('/violations/clear');
  },

  async saveGuardRule(ruleData: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await http.post('/rules', ruleData);
    return res.data?.data || {};
  },

  // ── Misc ────────────────────────────────────────────

  /** Stub — not fully implemented */
  async insertAtSearchMark(_data: Record<string, unknown>): Promise<{ success: boolean }> {
    return { success: false };
  },

  // ── Skills ──────────────────────────────────────────

  /** 获取所有 Skills 列表 */
  async listSkills(): Promise<{ skills: SkillInfo[]; total: number; hint?: string }> {
    const res = await http.get('/skills');
    return res.data?.data || { skills: [], total: 0 };
  },

  /** 加载指定 Skill 完整内容 */
  async loadSkill(name: string, section?: string): Promise<{
    skillName: string; source: string; content: string; charCount: number;
    useCase: string | null; relatedSkills: string[]; createdBy: string | null; createdAt: string | null;
  }> {
    const params = section ? `?section=${encodeURIComponent(section)}` : '';
    const res = await http.get(`/skills/${encodeURIComponent(name)}${params}`);
    return res.data?.data || {};
  },

  /** 创建项目级 Skill */
  async createSkill(data: { name: string; description: string; content: string; overwrite?: boolean; createdBy?: string }): Promise<Record<string, unknown>> {
    const res = await http.post('/skills', data);
    return res.data?.data || {};
  },

  /** 更新项目级 Skill */
  async updateSkill(name: string, data: { description?: string; content?: string }): Promise<Record<string, unknown>> {
    const res = await http.put(`/skills/${encodeURIComponent(name)}`, data);
    return res.data?.data || {};
  },

  /** 删除项目级 Skill */
  async deleteSkill(name: string): Promise<Record<string, unknown>> {
    const res = await http.delete(`/skills/${encodeURIComponent(name)}`);
    return res.data?.data || {};
  },

  /** 基于使用模式推荐创建 Skill */
  async suggestSkills(): Promise<{ suggestions: Array<{ name: string; [key: string]: any }>; analysisContext?: any }> {
    const res = await http.get('/skills/suggest');
    return res.data?.data || { suggestions: [], analysisContext: {} };
  },

  /** 获取 SignalCollector 后台服务状态 */
  async getSignalStatus(): Promise<{
    running: boolean;
    mode: string;
    snapshot: { lastResult?: { newSuggestions?: number; [key: string]: any }; [key: string]: any } | null;
    suggestions?: Array<{ name: string; [key: string]: any }>;
  }> {
    const res = await http.get('/skills/signal-status');
    return res.data?.data || { running: false, mode: 'off', snapshot: null };
  },

  /** AI 生成 Skill 内容（通过 ChatAgent 对话） */
  async aiGenerateSkill(prompt: string): Promise<{ reply: string; hasContext?: boolean }> {
    const systemPrompt = `你是一个 AutoSnippet Skill 文档生成助手。用户会描述他们想创建的 Skill，你需要生成完整的 SKILL.md 内容。

Skill 文档格式要求：
1. 开头用 Markdown 标题说明 Skill 的目的
2. 包含清晰的使用场景说明
3. 列出具体的操作步骤和指南
4. 如有必要，包含代码示例
5. 使用中文撰写

请严格按以下格式输出（不要用代码块包裹 JSON）：

第一行：一个 JSON 对象，包含 name（kebab-case，3-64 字符）和 description（一句话中文描述）
第二行：空行
第三行起：Skill 文档正文内容（Markdown 格式，不含 frontmatter）

示例输出：
{"name": "swiftui-animation-guide", "description": "SwiftUI 动画最佳实践指南"}

# SwiftUI 动画最佳实践

## 使用场景
...`;

    const res = await http.post('/ai/chat', {
      prompt: `${systemPrompt}\n\n用户需求：${prompt}`,
      history: [],
    });
    return res.data?.data || { reply: '' };
  },

  // ── LLM .env 配置 ──────────────────────────────────

  /** 读取用户项目 .env 中的 LLM 配置 */
  async getLlmEnvConfig(): Promise<{
    vars: Record<string, string>;
    hasEnvFile: boolean;
    llmReady: boolean;
  }> {
    const res = await http.get('/ai/env-config');
    return res.data?.data || { vars: {}, hasEnvFile: false, llmReady: false };
  },

  /** 近 7 日 Token 消耗报告 */
  async getTokenUsage7Days(): Promise<{
    daily: Array<{ date: string; input_tokens: number; output_tokens: number; total_tokens: number; call_count: number }>;
    bySource: Array<{ source: string; input_tokens: number; output_tokens: number; total_tokens: number; call_count: number }>;
    summary: { input_tokens: number; output_tokens: number; total_tokens: number; call_count: number; avg_per_call: number };
  }> {
    const res = await http.get('/ai/token-usage');
    return res.data?.data || { daily: [], bySource: [], summary: { input_tokens: 0, output_tokens: 0, total_tokens: 0, call_count: 0, avg_per_call: 0 } };
  },

  /** 写入 / 更新用户项目 .env 中的 LLM 配置 */
  async saveLlmEnvConfig(config: {
    provider: string;
    model?: string;
    apiKey?: string;
    proxy?: string;
  }): Promise<{
    vars: Record<string, string>;
    hasEnvFile: boolean;
    llmReady: boolean;
  }> {
    const res = await http.post('/ai/env-config', config);
    return res.data?.data || { vars: {}, hasEnvFile: false, llmReady: false };
  },

  // ═══════════════════════════════════════════════════════
  //  V3 Knowledge API — 统一知识条目（直通 wire format，无映射）
  // ═══════════════════════════════════════════════════════

  /** 获取知识条目列表（V3 统一 API） */
  async knowledgeList(params: {
    page?: number;
    limit?: number;
    lifecycle?: KnowledgeLifecycle;
    kind?: KnowledgeKind;
    category?: string;
    language?: string;
    keyword?: string;
    tag?: string;
    source?: string;
  } = {}): Promise<KnowledgePaginatedResponse> {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.lifecycle) query.set('lifecycle', params.lifecycle);
    if (params.kind) query.set('kind', params.kind);
    if (params.category) query.set('category', params.category);
    if (params.language) query.set('language', params.language);
    if (params.keyword) query.set('keyword', params.keyword);
    if (params.tag) query.set('tag', params.tag);
    if (params.source) query.set('source', params.source);
    const qs = query.toString();
    const res = await http.get(`/knowledge${qs ? `?${qs}` : ''}`);
    return res.data?.data || { data: [], pagination: { page: 1, pageSize: 20, total: 0 } };
  },

  /** 获取知识条目统计 */
  async knowledgeStats(): Promise<KnowledgeStatsResponse> {
    const res = await http.get('/knowledge/stats');
    return res.data?.data || { total: 0, pending: 0, active: 0, deprecated: 0, rules: 0, patterns: 0, facts: 0 };
  },

  /** 获取知识条目详情 */
  async knowledgeGet(id: string): Promise<KnowledgeEntry> {
    const res = await http.get(`/knowledge/${id}`);
    return res.data?.data;
  },

  /** 创建知识条目 */
  async knowledgeCreate(data: Partial<KnowledgeEntry>): Promise<KnowledgeEntry> {
    const res = await http.post('/knowledge', data);
    return res.data?.data;
  },

  /** 更新知识条目 */
  async knowledgeUpdate(id: string, data: Partial<KnowledgeEntry>): Promise<KnowledgeEntry> {
    const res = await http.patch(`/knowledge/${id}`, data);
    return res.data?.data;
  },

  /** 删除知识条目 */
  async knowledgeDelete(id: string): Promise<void> {
    await http.delete(`/knowledge/${id}`);
  },

  /** 知识条目生命周期操作 */
  async knowledgeLifecycle(id: string, action: string, reason?: string): Promise<KnowledgeEntry> {
    const res = await http.patch(`/knowledge/${id}/${action}`, reason ? { reason } : {});
    return res.data?.data;
  },

  /** 批量发布 */
  async knowledgeBatchPublish(ids: string[]): Promise<{ published: KnowledgeEntry[]; failed: Array<{ id: string; error: string }>; successCount: number; failureCount: number }> {
    const res = await http.post('/knowledge/batch-publish', { ids });
    return res.data?.data || { published: [], failed: [], successCount: 0, failureCount: 0 };
  },

  /** 记录使用 */
  async knowledgeRecordUsage(id: string, type: string = 'adoption', feedback?: string): Promise<void> {
    await http.post(`/knowledge/${id}/usage`, { type, feedback });
  },

  /** 重新计算质量评分 */
  async knowledgeUpdateQuality(id: string): Promise<{ quality: KnowledgeQuality }> {
    const res = await http.patch(`/knowledge/${id}/quality`);
    return res.data?.data || { quality: {} };
  },

  // ── Wiki ──────────────────────────────────────────────

  /** 触发 Wiki 全量生成 */
  async wikiGenerate(): Promise<void> {
    await http.post('/wiki/generate');
  },

  /** 触发 Wiki 增量更新 */
  async wikiUpdate(): Promise<void> {
    await http.post('/wiki/update');
  },

  /** 中止 Wiki 生成 */
  async wikiAbort(): Promise<void> {
    await http.post('/wiki/abort');
  },

  /** 获取 Wiki 状态 */
  async wikiStatus(): Promise<{
    task: {
      status: 'idle' | 'running' | 'done' | 'error';
      phase?: string;
      progress?: number;
      message?: string;
      startedAt?: number;
      finishedAt?: number;
      result?: any;
      error?: string;
    };
    wiki?: {
      exists: boolean;
      generatedAt?: string;
      filesCount?: number;
      version?: string;
      hasChanges?: boolean;
    };
  }> {
    const res = await http.get('/wiki/status');
    return res.data?.data || { task: { status: 'idle' } };
  },

  /** 列出 Wiki 文件 */
  async wikiFiles(): Promise<{ files: Array<{ path: string; name: string; size: number; modifiedAt: string }>; exists: boolean }> {
    const res = await http.get('/wiki/files');
    return res.data?.data || { files: [], exists: false };
  },

  /** 读取 Wiki 文件内容 */
  async wikiFileContent(filePath: string): Promise<{ path: string; content: string; size: number }> {
    const res = await http.get(`/wiki/file/${filePath}`);
    return res.data?.data || { path: filePath, content: '', size: 0 };
  },

  // ── Language preference ──────

  /** 获取服务端默认 UI 语言 */
  async getLang(): Promise<'zh' | 'en'> {
    const res = await http.get('/ai/lang');
    return res.data?.data?.lang || 'zh';
  },

  /** 同步 UI 语言偏好到服务端 */
  async setLang(lang: 'zh' | 'en'): Promise<void> {
    await http.post('/ai/lang', { lang });
  },
};

export default api;
