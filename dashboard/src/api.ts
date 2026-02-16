/**
 * AutoSnippet Dashboard API Client
 *
 * 直接调用 V2 RESTful API（/api/v1/*），消除 v1-compat 中间层。
 * 负责：
 *   1. 统一 {success, data} 信封解包
 *   2. V2 → V1 前端类型转换（保持 UI 组件不变）
 *   3. V1→V2 请求格式转换（snippet/recipe 保存）
 */

import axios from 'axios';
import type {
  Snippet,
  Recipe,
  RecipeStats,
  ProjectData,
  SPMTarget,
  ExtractedRecipe,
  CandidateItem,
} from './types';

// ═══════════════════════════════════════════════════════
//  Base HTTP Client
// ═══════════════════════════════════════════════════════

const http = axios.create({ baseURL: '/api/v1' });

// ═══════════════════════════════════════════════════════
//  V2 → V1 Transformations
// ═══════════════════════════════════════════════════════

/** V2 Snippet → V1 Snippet (for rootSpec.list) */
function mapV2SnippetToV1(s: any): Snippet {
  const meta = s.metadata || {};
  return {
    identifier: s.identifier || s.id,
    title: s.title || '',
    completionKey: s.completion || s.completionKey || '',
    summary: s.summary || '',
    category: s.category || 'Utility',
    language: s.language || 'swift',
    content: s.code ? s.code.split('\n') : (s.content || []),
    body: s.code ? s.code.split('\n') : undefined,
    headers: meta.headers || [],
    headerPaths: meta.headerPaths || [],
    moduleName: meta.moduleName || '',
    includeHeaders: meta.includeHeaders !== false,
    link: meta.link || undefined,
  };
}

/** V2 Recipe entity → V1 Recipe (with reconstructed markdown `content`) */
function mapV2RecipeToV1(r: any): Recipe {
  const quality = r.quality || {};
  const statistics = r.statistics || {};
  const contentObj = r.content || {};
  const dims = r.dimensions || {};

  // ── Reconstruct frontmatter + body markdown ──
  const trigger =
    dims.trigger ||
    '@' + (r.title || '').replace(/[\s_-]+(.)?/g, (_: string, c: string) => (c ? c.toUpperCase() : ''));
  const tags: string[] = r.tags || [];
  const headers: string[] = dims.headers || [];

  let md = '---\n';
  md += `title: ${r.title || ''}\n`;
  md += `trigger: ${trigger}\n`;
  md += `language: ${r.language || 'swift'}\n`;
  md += `category: ${r.category || 'Utility'}\n`;
  // summary: 直接从一级字段读取
  const summaryCn = r.summaryCn || r.description || '';
  const summaryEn = r.summaryEn || '';
  md += `summary: ${summaryCn}\n`;
  md += `summary_cn: ${summaryCn}\n`;
  if (summaryEn) md += `summary_en: ${summaryEn}\n`;
  if (r.scope) md += `scope: ${r.scope}\n`;
  if (r.knowledgeType) md += `knowledge_type: ${r.knowledgeType}\n`;
  if (r.complexity) md += `complexity: ${r.complexity}\n`;
  if (tags.length > 0) md += `tags: ${JSON.stringify(tags)}\n`;
  if (headers.length > 0) md += `headers: ${JSON.stringify(headers)}\n`;
  const diff = dims.difficulty || r.complexity || '';
  if (diff) md += `difficulty: ${diff}\n`;
  const auth = quality.overall || dims.authority || 0;
  if (auth) md += `authority: ${auth}\n`;
  md += `version: ${dims.version || '1.0.0'}\n`;
  md += `status: ${r.status || 'draft'}\n`;
  const updatedMs = r.updatedAt ? (r.updatedAt < 1e12 ? r.updatedAt * 1000 : r.updatedAt) : Date.now();
  md += `updatedAt: ${updatedMs}\n`;
  md += '---\n\n';

  const pattern = contentObj.pattern || '';
  if (pattern) md += `\`\`\`${r.language || 'swift'}\n${pattern}\n\`\`\`\n\n`;
  const rationale = contentObj.rationale || '';
  if (rationale) md += `## Architecture Usage\n\n${rationale}\n\n`;
  // UsageGuide: 直接从一级字段读取
  const usageGuideCn = r.usageGuideCn || '';
  const usageGuideEn = r.usageGuideEn || '';
  if (usageGuideCn) md += `## AI Context / Usage Guide\n\n${usageGuideCn}\n\n`;
  if (usageGuideEn) md += `## AI Context / Usage Guide (EN)\n\n${usageGuideEn}\n\n`;
  const stepsArr: any[] = contentObj.steps || [];
  const safeStr = (v: any): string => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  };
  const stepsStr = stepsArr.map((s: any, i: number) => {
    if (typeof s === 'string') return `${i + 1}. ${s}`;
    if (typeof s !== 'object' || s === null) return `${i + 1}. ${String(s)}`;
    const title = safeStr(s.title);
    const desc = safeStr(s.description);
    const code = safeStr(s.code);
    const parts = [title, desc].filter(Boolean).join(': ');
    let line = `${i + 1}. ${parts || '(步骤)'}`;
    if (code) line += `\n\n\`\`\`\n${code}\n\`\`\``;
    return line;
  }).join('\n');
  if (stepsStr.trim()) md += `## Best Practices\n\n${stepsStr}\n\n`;
  const standardsText = (r.constraints || {}).standards || '';
  if (standardsText) md += `## Standards\n\n${standardsText}\n\n`;

  const stats: RecipeStats = {
    authority: quality.overall || 0,
    authorityScore: quality.overall || 0,
    guardUsageCount: statistics.applicationCount || 0,
    humanUsageCount: statistics.adoptionCount || 0,
    aiUsageCount: 0,
    lastUsedAt: r.updatedAt || null,
  };

  return {
    id: r.id,
    name: (r.title || r.name || r.id) + '.md',
    content: md,
    category: r.category || '',
    language: r.language || '',
    description: r.description || '',
    status: r.status || 'draft',
    kind: r.kind || undefined,
    knowledgeType: r.knowledgeType || undefined,
    v2Content: r.content || null,
    relations: r.relations || null,
    constraints: r.constraints || null,
    tags: r.tags || [],
    stats,
    usageGuide: r.usageGuideCn || r.usageGuideEn || '',
    usageGuide_cn: r.usageGuideCn || '',
    usageGuide_en: r.usageGuideEn || '',
  };
}

/** V2 Candidate entity → V1 CandidateItem (flat) */
function mapV2CandidateToV1(c: any): CandidateItem {
  const meta = c.metadata || {};
  const reasoning = c.reasoning || {};
  return {
    id: c.id,
    title: meta.title || reasoning.summary || (c.code ? c.code.substring(0, 60) : ''),
    summary: meta.summary_cn || meta.summary || reasoning.summary || '',
    summary_cn: meta.summary_cn || meta.summary || '',
    summary_en: meta.summary_en || '',
    trigger: meta.trigger || '',
    category: meta.category || c.category || '',
    language: c.language || '',
    code: c.code || '',
    headers: meta.headers || [],
    headerPaths: meta.headerPaths || [],
    moduleName: meta.moduleName || '',
    usageGuide: meta.usageGuide_cn || meta.usageGuide || '',
    usageGuide_cn: meta.usageGuide_cn || '',
    usageGuide_en: meta.usageGuide_en || '',
    source: c.source || 'unknown',
    createdAt: c.createdAt,
    status: c.status,
    quality: c.quality || meta.quality || null,
    reviewNotes: c.reviewNotes || meta.reviewNotes || null,
    relatedRecipes: c.relatedRecipes || meta.relatedRecipes || [],
    knowledgeType: meta.knowledgeType || c.knowledgeType || undefined,
    tags: meta.tags || c.tags || [],
    reasoning: reasoning.whyStandard
      ? {
          whyStandard: reasoning.whyStandard || '',
          sources: reasoning.sources || [],
          confidence: reasoning.confidence ?? null,
        }
      : null,
    // ── 润色产生的额外字段 ──
    agentNotes: meta.agentNotes || null,
    aiInsight: meta.aiInsight || null,
    relations: meta.relations || null,
    refinedConfidence: meta.refinedConfidence ?? null,
    rationale: meta.rationale || '',
    scope: meta.scope || '',
    steps: meta.steps || [],
    complexity: meta.complexity || undefined,
  } as CandidateItem;
}

// ═══════════════════════════════════════════════════════
//  Frontmatter Parser (client-side, replaces v1-compat parsing)
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
    summary = getField('summary_cn') || getField('summary') || summary;
    summaryEn = getField('summary_en') || '';
    knowledgeType = getField('knowledge_type') || '';
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
  };
}

// ═══════════════════════════════════════════════════════
//  V1→V2 Request Transformations
// ═══════════════════════════════════════════════════════

/** Build V2 createCandidate payload from V1 item */
function mapV1ItemToV2Candidate(item: any, targetName: string, source: string) {
  return {
    code: item.code || '',
    language: item.language || 'swift',
    category: Array.isArray(item.category) ? item.category[0] : item.category || targetName || 'general',
    source: source || 'manual',
    reasoning: {
      whyStandard: item.summary_cn || item.summary || item.title || 'Extracted from project',
      sources: [source || 'unknown'],
      confidence: 0.6,
    },
    metadata: {
      targetName: targetName || '',
      title: item.title || '',
      trigger: item.trigger || '',
      summary: item.summary || '',
      summary_cn: item.summary_cn || '',
      summary_en: item.summary_en || '',
      usageGuide: item.usageGuide || '',
      usageGuide_cn: item.usageGuide_cn || '',
      usageGuide_en: item.usageGuide_en || '',
      category: Array.isArray(item.category) ? item.category[0] : item.category || '',
      headers: item.headers || [],
      headerPaths: item.headerPaths || [],
      moduleName: item.moduleName || '',
      isMarked: item.isMarked || false,
    },
  };
}

// ═══════════════════════════════════════════════════════
//  API Methods
// ═══════════════════════════════════════════════════════

export const api = {
  // ── Data (bulk fetch) ──────

  async fetchData(): Promise<ProjectData> {
    const [recipesRes, candidatesRes, aiConfigRes] = await Promise.all([
      http.get('/recipes?limit=1000').catch(() => ({ data: { success: true, data: { data: [] } } })),
      http.get('/candidates?limit=1000').catch(() => ({ data: { success: true, data: { data: [] } } })),
      http.get('/ai/config').catch(() => ({ data: { success: true, data: { provider: '', model: '' } } })),
    ]);

    // Recipes
    const rawRecipes = recipesRes.data?.data?.data || recipesRes.data?.data?.items || [];
    const recipes = rawRecipes.map(mapV2RecipeToV1);

    // Candidates → grouped by targetName
    const rawCandidates = candidatesRes.data?.data?.data || candidatesRes.data?.data?.items || [];
    const candidates: ProjectData['candidates'] = {};
    for (const c of rawCandidates) {
      const meta = c.metadata || {};
      const target = meta.targetName || c.category || c.language || '_pending';
      if (!candidates[target]) {
        candidates[target] = { targetName: target, scanTime: c.createdAt, items: [] };
      }
      candidates[target].items.push(mapV2CandidateToV1(c));
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
    // V2 returns {result: [], source} — take first item or the whole object
    if (Array.isArray(data.result) && data.result.length > 0) {
      return data.result[0];
    }
    // fallback: might return the item directly
    return data as ExtractedRecipe;
  },

  // ── Recipes ─────────────────────────────────────────

  /**
   * Save recipe from markdown content.
   * Parses frontmatter → V2 structured data, creates or updates.
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
      markdown: '',
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

    const recipeData = {
      title,
      language: parsed.language,
      category: parsed.category,
      description: parsed.summary,
      summaryCn: parsed.summary || '',
      summaryEn: parsed.summaryEn || '',
      usageGuideCn: parsed.usageGuide || '',
      usageGuideEn: parsed.usageGuideEn || '',
      knowledgeType: parsed.knowledgeType || 'code-pattern',
      complexity: parsed.complexity || 'intermediate',
      scope: parsed.scope || null,
      tags: parsed.tags || [],
      content: contentObj,
      constraints: constraintsObj,
      dimensions,
    };

    // Try to find existing recipe by title → update
    try {
      const searchRes = await http.get(`/recipes?keyword=${encodeURIComponent(title)}&limit=5`);
      const items = searchRes.data?.data?.data || searchRes.data?.data?.items || [];
      const existing = items.find((r: any) => r.title === title);
      if (existing) {
        await http.patch(`/recipes/${existing.id}`, recipeData);
        return;
      }
    } catch {
      /* create new */
    }

    await http.post('/recipes', recipeData);
  },

  async deleteRecipe(name: string): Promise<void> {
    const title = name.replace(/\.md$/, '');
    const searchRes = await http.get(`/recipes?keyword=${encodeURIComponent(title)}&limit=5`);
    const items = searchRes.data?.data?.data || searchRes.data?.data?.items || [];
    const recipe = items.find((r: any) => r.title === title) || items[0];
    if (recipe?.id) {
      await http.delete(`/recipes/${recipe.id}`);
    } else {
      throw new Error('Recipe not found');
    }
  },

  async getRecipeByName(
    name: string,
  ): Promise<{ name: string; content: string }> {
    const title = name.replace(/\.md$/, '');
    const searchRes = await http.get(`/recipes?keyword=${encodeURIComponent(title)}&limit=5`);
    const items = searchRes.data?.data?.data || searchRes.data?.data?.items || [];
    if (items.length === 0) throw new Error('Recipe not found');
    const r = items[0];
    const c = r.content || {};
    return { name, content: c.pattern || c.markdown || '' };
  },

  async setRecipeAuthority(name: string, authority: number): Promise<void> {
    const title = name.replace(/\.md$/, '');
    const searchRes = await http.get(`/recipes?keyword=${encodeURIComponent(title)}&limit=5`);
    const items = searchRes.data?.data?.data || searchRes.data?.data?.items || [];
    if (items.length > 0 && items[0].id) {
      await http.patch(`/recipes/${items[0].id}/quality`, {
        codeCompleteness: authority,
        projectAdaptation: authority,
        documentationClarity: authority,
      });
    }
  },

  async updateRecipeRelations(name: string, relations: Record<string, any[]>): Promise<void> {
    const title = name.replace(/\.md$/, '');
    const searchRes = await http.get(`/recipes?keyword=${encodeURIComponent(title)}&limit=5`);
    const items = searchRes.data?.data?.data || searchRes.data?.data?.items || [];
    const recipe = items.find((r: any) => r.title === title) || items[0];
    if (recipe?.id) {
      await http.patch(`/recipes/${recipe.id}`, { relations });
    } else {
      throw new Error('Recipe not found');
    }
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

  // ── Candidates ──────────────────────────────────────

  /** 获取单个候选详情（V2 → V1 映射） */
  async getCandidate(candidateId: string): Promise<CandidateItem> {
    const res = await http.get(`/candidates/${candidateId}`);
    const raw = res.data?.data;
    if (!raw) throw new Error('Candidate not found');
    return mapV2CandidateToV1(raw);
  },

  async deleteCandidate(candidateId: string): Promise<void> {
    await http.delete(`/candidates/${candidateId}`);
  },

  /** 一键将已批准的 Candidate 提升为 Recipe */
  async promoteCandidateToRecipe(candidateId: string, overrides?: Record<string, any>): Promise<{ recipe: any; candidate: any }> {
    const res = await http.post(`/candidates/${candidateId}/promote`, overrides || {});
    return res.data?.data || { recipe: null, candidate: null };
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
    const res = await http.post('/candidates/batch-delete', { targetName });
    return res.data?.data || { deleted: 0 };
  },

  async promoteToCandidate(
    item: any,
    targetName: string,
  ): Promise<{ ok: boolean; candidateId: string }> {
    const data = mapV1ItemToV2Candidate(item, targetName, 'review-promote');
    const res = await http.post('/candidates', data);
    return { ok: true, candidateId: res.data?.data?.id || '' };
  },

  async getCandidateSimilarity(
    code: string,
    language: string,
  ): Promise<{ similar: Array<{ recipeName: string; similarity: number }> }> {
    const res = await http.post('/candidates/similarity', { code, language });
    return res.data?.data || { similar: [] };
  },

  /** getCandidateSimilarityEx: supports targetName+candidateId or candidate object */
  async getCandidateSimilarityEx(
    params: { targetName?: string; candidateId?: string; candidate?: any },
  ): Promise<{ similar: Array<{ recipeName: string; similarity: number }> }> {
    const res = await http.post('/candidates/similarity', params);
    return res.data?.data || { similar: [] };
  },

  /** Get recipe content by name (for compare modals) */
  async getRecipeContentByName(
    name: string,
  ): Promise<{ name: string; content: string }> {
    const title = name.replace(/\.md$/, '');
    const searchRes = await http.get(`/recipes?keyword=${encodeURIComponent(title)}&limit=5`);
    const items = searchRes.data?.data?.data || searchRes.data?.data?.items || [];
    const found = items.find((r: any) => r.title === title) || items[0];
    if (!found) throw new Error('Recipe not found');
    const r = found;
    const mapped = mapV2RecipeToV1(r);
    return { name, content: mapped.content };
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
  ): Promise<{ summary_en: string; usageGuide_en: string; warning?: string }> {
    const res = await http.post('/ai/translate', { summary, usageGuide });
    const data = res.data?.data || { summary_en: '', usageGuide_en: '' };
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

  /** Stub — was not fully implemented in v1-compat */
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
        content: mapV2RecipeToV1(r).content,
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
};

export default api;
