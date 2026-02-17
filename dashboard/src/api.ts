/**
 * AutoSnippet Dashboard API Client
 *
 * 直接调用 V3 RESTful API（/api/v1/*）。
 * 前端统一使用 V3 KnowledgeEntry 类型，不做字段映射。
 */

import axios from 'axios';
import type {
  Snippet,
  Recipe,
  RecipeStats,
  ProjectData,
  SPMTarget,
  ExtractedRecipe,
  KnowledgeEntry,
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

/** V3 KnowledgeEntry → 前端 Recipe 视图类型 */
function toRecipe(r: any): Recipe {
  const quality = r.quality || {};
  const statistics = r.stats || r.statistics || {};
  const contentObj = r.content || {};

  const trigger =
    r.trigger ||
    '@' + (r.title || '').replace(/[\s_-]+(.)?/g, (_: string, c: string) => (c ? c.toUpperCase() : ''));

  const stats: RecipeStats = {
    authority: statistics.authority || quality.overall || 0,
    authorityScore: statistics.authority || quality.overall || 0,
    guardUsageCount: statistics.applications || 0,
    humanUsageCount: statistics.adoptions || 0,
    aiUsageCount: 0,
    lastUsedAt: r.updatedAt || null,
  };

  return {
    id: r.id,
    name: (r.title || r.name || r.id) + '.md',
    content: contentObj as any,
    category: r.category || '',
    language: r.language || '',
    description: r.description || '',
    status: r.lifecycle || r.status || 'pending',
    kind: r.kind || undefined,
    knowledgeType: r.knowledgeType || undefined,
    // v2Content removed — content is now the V3 structured object
    relations: r.relations || null,
    constraints: r.constraints || null,
    tags: r.tags || [],
    stats,
    trigger,
    source: r.source || '',
    sourceFile: r.sourceFile || '',
    moduleName: r.moduleName || '',
    usageGuide: contentObj.markdown || r.doClause || '',
    reasoning: r.reasoning || null,
    quality: r.quality || null,
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
  let language = 'swift',
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
function toCandidatePayload(item: any, targetName: string, source: string) {
  return {
    code: item.content?.pattern || '',
    language: item.language || 'swift',
    category: Array.isArray(item.category) ? item.category[0] : item.category || targetName || 'general',
    source: source || 'manual',
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
      category: Array.isArray(item.category) ? item.category[0] : item.category || '',
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
  const found = items.find((r: any) => {
    const title = r.title || r.name || '';
    return title === cleaned || title + '.md' === idOrName;
  });
  if (found?.id) return found.id;
  throw new Error(`Knowledge entry not found: ${idOrName}`);
}

// ═══════════════════════════════════════════════════════
//  API Methods
// ═══════════════════════════════════════════════════════

export const api = {
  // ── Data (bulk fetch) ──────

  async fetchData(): Promise<ProjectData> {
    const [knowledgeRes, aiConfigRes] = await Promise.all([
      http.get('/knowledge?limit=1000').catch(() => ({ data: { success: true, data: { data: [] } } })),
      http.get('/ai/config').catch(() => ({ data: { success: true, data: { provider: '', model: '' } } })),
    ]);

    // All knowledge entries from V3 backend
    const allEntries: any[] = knowledgeRes.data?.data?.data || knowledgeRes.data?.data?.items || [];

    // Recipes = active lifecycle entries (auto-approved / manually approved)
    const activeEntries = allEntries.filter((e: any) => e.lifecycle === 'active');
    const recipes = activeEntries.map(toRecipe);

    // Candidates 视图仅展示待审核状态，过滤掉已发布/已弃用的条目
    const rawEntries = allEntries.filter((e: any) => e.lifecycle === 'pending');
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

    return {
      rootSpec: { list: [] },
      recipes,
      candidates,
      projectRoot: '',
      watcherStatus: 'active',
      aiConfig: { provider: aiConfig.provider || '', model: aiConfig.model || '' },
    };
  },

  // ── SPM ─────────────────────────────────────────────

  async fetchTargets(): Promise<SPMTarget[]> {
    const res = await http.get('/spm/targets');
    const data = res.data?.data || {};
    return data.targets || [];
  },

  async getTargetFiles(target: SPMTarget, signal?: AbortSignal) {
    const res = await http.post('/spm/target-files', { target }, { signal });
    const data = res.data?.data || {};
    return { files: data.files || [], count: data.total || data.files?.length || 0 };
  },

  async scanTarget(target: SPMTarget, signal?: AbortSignal) {
    const res = await http.post('/spm/scan', { target }, { signal, timeout: 600000 });
    const data = res.data?.data || {};
    // Unify response: could be {recipes, scannedFiles} or {result, scannedFiles}
    const recipes = data.recipes || data.result || [];
    return { recipes, scannedFiles: data.scannedFiles || [], message: data.message || '' };
  },

  /** 全项目扫描：AI 提取 + Guard 审计 */
  async scanProject(signal?: AbortSignal) {
    const res = await http.post('/spm/scan-project', {}, { signal, timeout: 600000 });
    const data = res.data?.data || {};
    return {
      targets: data.targets || [],
      recipes: data.recipes || [],
      guardAudit: data.guardAudit || null,
      scannedFiles: data.scannedFiles || [],
      partial: data.partial || false,
    };
  },

  /** 冷启动：快速骨架 + 异步逐维度填充（v5） */
  async bootstrap(signal?: AbortSignal) {
    const res = await http.post('/spm/bootstrap', {}, { signal, timeout: 300000 });
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
    const res = await http.get('/spm/bootstrap/status');
    return res.data?.data || { status: 'idle' };
  },

  async getDepGraph(level: string) {
    const res = await http.get(`/spm/dep-graph?level=${level}`);
    return res.data?.data || {};
  },

  // ── Commands ────────────────────────────────────────

  async syncToXcode(): Promise<void> {
    await http.post('/commands/install');
  },

  async refreshProject(): Promise<void> {
    await http.post('/commands/spm-map');
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
    const constraintsObj: Record<string, any> = {};
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

    const recipeData: Record<string, any> = {
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

  async updateRecipeRelations(idOrName: string, relations: Record<string, any[]>): Promise<void> {
    const knowledgeId = await resolveKnowledgeId(idOrName);
    await http.patch(`/knowledge/${knowledgeId}`, { relations });
  },

  async searchRecipes(
    q: string,
  ): Promise<{ results: Array<{ name: string; content: string }>; total: number }> {
    const res = await http.get(`/search?q=${encodeURIComponent(q)}&type=recipe`);
    const data = res.data?.data || {};
    const recipes = data.recipes || [];
    return {
      results: recipes.map((r: any) => ({
        name: r.title || r.name || '',
        content: (r.content || {}).pattern || (r.content || {}).markdown || '',
      })),
      total: data.totalResults || recipes.length,
    };
  },

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
  async promoteCandidateToRecipe(candidateId: string, _overrides?: Record<string, any>): Promise<{ recipe: any; candidate: any }> {
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
  async bootstrapRefine(candidateIds?: string[], userPrompt?: string, dryRun?: boolean): Promise<{ refined: number; total: number; errors: any[]; results: any[] }> {
    const res = await http.post('/candidates/bootstrap-refine', { candidateIds, userPrompt, dryRun }, { timeout: 300000 });
    return res.data?.data || { refined: 0, total: 0, errors: [], results: [] };
  },

  /** 对话式润色 — 预览：单条候选 dryRun，返回 before/after 对比 */
  async refinePreview(candidateId: string, userPrompt?: string): Promise<{ candidateId: string; before: Record<string, any>; after: Record<string, any>; preview: Record<string, any> }> {
    const res = await http.post('/candidates/refine-preview', { candidateId, userPrompt }, { timeout: 120000 });
    return res.data?.data || {};
  },

  /** 对话式润色 — 应用：确认写入变更 */
  async refineApply(candidateId: string, userPrompt?: string): Promise<{ refined: number; total: number; candidate: any }> {
    const res = await http.post('/candidates/refine-apply', { candidateId, userPrompt }, { timeout: 120000 });
    return res.data?.data || {};
  },

  /** 获取全量知识图谱（边 + 节点标签） */
  async getKnowledgeGraph(limit = 500): Promise<{ edges: any[]; nodeLabels: Record<string, string>; nodeTypes: Record<string, string>; nodeCategories: Record<string, string> }> {
    const res = await http.get(`/search/graph/all?limit=${limit}`);
    return res.data?.data || { edges: [], nodeLabels: {}, nodeTypes: {}, nodeCategories: {} };
  },

  /** 获取知识图谱统计 */
  async getGraphStats(): Promise<{ totalEdges: number; byRelation: Record<string, number>; nodeTypes: any[] }> {
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
    item: any,
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
    params: { targetName?: string; candidateId?: string; candidate?: any },
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

  async getAiProviders(): Promise<any[]> {
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

  async summarizeCode(code: string, language: string): Promise<any> {
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

  // ── Search ──────────────────────────────────────────

  async semanticSearch(keyword: string, limit: number = 10): Promise<any[]> {
    const res = await http.get(
      `/search?q=${encodeURIComponent(keyword)}&mode=semantic&limit=${limit}`,
    );
    const data = res.data?.data || {};
    const recipes = data.recipes || [];
    return recipes.map((r: any) => ({
      name: (r.title || r.name || '') + '.md',
      content: (r.content || {}).pattern || (r.content || {}).markdown || '',
      similarity: r.similarity || r.score || 0,
      metadata: { type: 'recipe', name: (r.title || r.name || '') + '.md' },
    }));
  },

  async xcodeSimulateSearch(data: any): Promise<any> {
    const res = await http
      .post('/search/xcode-simulate', data)
      .catch(() => ({ data: { data: {} } }));
    return res.data?.data || {};
  },

  async contextAwareSearch(data: any): Promise<any> {
    const res = await http
      .post('/search/context-aware', data)
      .catch(() => ({ data: { data: {} } }));
    return res.data?.data || {};
  },

  // ── Guard ───────────────────────────────────────────

  async getGuardRules(): Promise<{ rules: Record<string, any> }> {
    const res = await http.get('/rules?limit=100');
    const data = res.data?.data || {};
    const items: any[] = data.data || data.items || [];
    const rules: Record<string, any> = {};
    for (const r of items) {
      rules[r.id] = r;
    }
    return { rules };
  },

  async getGuardViolations(): Promise<{ runs: any[] }> {
    const res = await http.get('/violations');
    const data = res.data?.data || {};
    return { runs: data.data || data.items || [] };
  },

  async clearViolations(): Promise<void> {
    await http.post('/violations/clear');
  },

  async generateGuardRule(ruleData: any): Promise<any> {
    const res = await http.post('/violations/rules/generate', ruleData);
    return res.data?.data || {};
  },

  async saveGuardRule(ruleData: any): Promise<any> {
    const res = await http.post('/rules', ruleData);
    return res.data?.data || {};
  },

  // ── Misc ────────────────────────────────────────────

  /** Stub — not fully implemented */
  async insertAtSearchMark(_data: any): Promise<{ success: boolean }> {
    return { success: false };
  },

  /** Fetch recipe search results (for SearchModal) */
  async searchRecipesForModal(
    q: string,
    signal?: AbortSignal,
  ): Promise<{ results: Array<{ name: string; path: string; content: string; qualityScore?: number; recommendReason?: string }>; total: number }> {
    const res = await http.get(`/search?q=${encodeURIComponent(q)}&type=recipe`, { signal });
    const data = res.data?.data || {};
    const recipes = data.recipes || [];
    return {
      results: recipes.map((r: any) => ({
        name: (r.title || r.name || '') + '.md',
        path: '',
        content: toRecipe(r).content,
        qualityScore: (r.quality || {}).overall || 0,
        recommendReason: '',
      })),
      total: data.totalResults || recipes.length,
    };
  },

  // ── Skills ──────────────────────────────────────────

  /** 获取所有 Skills 列表 */
  async listSkills(): Promise<{ skills: any[]; total: number; hint?: string }> {
    const res = await http.get('/skills');
    return res.data?.data || { skills: [], total: 0 };
  },

  /** 加载指定 Skill 完整内容 */
  async loadSkill(name: string, section?: string): Promise<any> {
    const params = section ? `?section=${encodeURIComponent(section)}` : '';
    const res = await http.get(`/skills/${encodeURIComponent(name)}${params}`);
    return res.data?.data || {};
  },

  /** 创建项目级 Skill */
  async createSkill(data: { name: string; description: string; content: string; overwrite?: boolean; createdBy?: string }): Promise<any> {
    const res = await http.post('/skills', data);
    return res.data?.data || {};
  },

  /** 更新项目级 Skill */
  async updateSkill(name: string, data: { description?: string; content?: string }): Promise<any> {
    const res = await http.put(`/skills/${encodeURIComponent(name)}`, data);
    return res.data?.data || {};
  },

  /** 删除项目级 Skill */
  async deleteSkill(name: string): Promise<any> {
    const res = await http.delete(`/skills/${encodeURIComponent(name)}`);
    return res.data?.data || {};
  },

  /** 基于使用模式推荐创建 Skill */
  async suggestSkills(): Promise<any> {
    const res = await http.get('/skills/suggest');
    return res.data?.data || { suggestions: [], analysisContext: {} };
  },

  /** 获取 SignalCollector 后台服务状态 */
  async getSignalStatus(): Promise<{ running: boolean; mode: string; snapshot: any; suggestions?: any[] }> {
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
  async knowledgeUpdateQuality(id: string): Promise<{ quality: any }> {
    const res = await http.patch(`/knowledge/${id}/quality`);
    return res.data?.data || { quality: {} };
  },
};

export default api;
