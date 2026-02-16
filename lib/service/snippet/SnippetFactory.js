/**
 * SnippetFactory — Xcode .codesnippet 生成工厂
 * 纯内存 Recipe → XML 转换器，不依赖 DB
 *
 * Snippet 是 Recipe 的附属产物：从 Recipe 取出 → 生成 XML → 同步 Xcode → 不再使用
 */

const TEMPLATE_TOKENS = ['{identifier}', '{title}', '{completion}', '{summary}', '{content}', '{language}'];

const LANGUAGE_MAP = {
  swift:           'Xcode.SourceCodeLanguage.Swift',
  'objective-c':   'Xcode.SourceCodeLanguage.Objective-C',
  objc:            'Xcode.SourceCodeLanguage.Objective-C',
  c:               'Xcode.SourceCodeLanguage.C',
  'c++':           'Xcode.SourceCodeLanguage.C-Plus-Plus',
  javascript:      'Xcode.SourceCodeLanguage.JavaScript',
};

const SNIPPET_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>IDECodeSnippetCompletionPrefix</key>
\t<string>{completion}</string>
\t<key>IDECodeSnippetCompletionScopes</key>
\t<array>
\t\t<string>All</string>
\t</array>
\t<key>IDECodeSnippetContents</key>
\t<string>{content}</string>
\t<key>IDECodeSnippetIdentifier</key>
\t<string>{identifier}</string>
\t<key>IDECodeSnippetLanguage</key>
\t<string>{language}</string>
\t<key>IDECodeSnippetSummary</key>
\t<string>{summary}</string>
\t<key>IDECodeSnippetTitle</key>
\t<string>{title}</string>
\t<key>IDECodeSnippetUserSnippet</key>
\t<true/>
\t<key>IDECodeSnippetVersion</key>
\t<integer>2</integer>
</dict>
</plist>`;

export class SnippetFactory {
  /**
   * @param {object} [knowledgeRepository] — KnowledgeRepositoryImpl（可选，用于列表查询）
   */
  constructor(knowledgeRepository) {
    this._recipeRepo = knowledgeRepository || null;
  }

  /**
   * 运行时注入 knowledgeRepository（用于延迟绑定场景）
   */
  setKnowledgeRepository(repo) {
    this._recipeRepo = repo;
  }

  // ─────────────── Recipe → Snippet 查询 ───────────────

  /**
   * 从 Recipe 列表实时生成 Snippet 列表（取代原 DB CRUD）
   * @param {object} [filters] — { language, category, keyword }
   * @param {object} [pagination]
   * @returns {Promise<Array>}
   */
  async listSnippets(filters = {}, pagination = { page: 1, pageSize: 50 }) {
    if (!this._recipeRepo) return [];

    const dbFilters = { status: 'active' };
    if (filters.language) dbFilters.language = filters.language;
    if (filters.category) dbFilters.category = filters.category;

    let result;
    if (filters.keyword) {
      result = await this._recipeRepo.search(filters.keyword, pagination);
    } else {
      result = await this._recipeRepo.findWithPagination(dbFilters, pagination);
    }

    const recipes = result?.data || result?.items || [];
    return recipes.map(r => this.fromRecipe(r));
  }

  /**
   * 从单个 Recipe ID 实时生成 Snippet
   */
  async getSnippet(recipeId) {
    if (!this._recipeRepo) return null;
    const recipe = await this._recipeRepo.findById(recipeId);
    if (!recipe) return null;
    return this.fromRecipe(recipe);
  }

  // ─────────────── XML 生成 ───────────────

  /**
   * 从 spec 数据生成 .codesnippet XML 内容
   * @param {object} spec
   *   @param {string} spec.identifier — 唯一标识 (如 "com.autosnippet.xxx")
   *   @param {string} spec.title — 片段标题
   *   @param {string} spec.completion — 触发补全前缀
   *   @param {string} spec.summary — 描述
   *   @param {string|string[]} spec.code — 代码内容（字符串或行数组）
   *   @param {string} spec.language — 语言标识符
   * @returns {string} — XML plist 内容
   */
  generate(spec) {
    if (!spec?.identifier || !spec?.code) {
      throw new Error('Snippet spec must have identifier and code');
    }

    const content = Array.isArray(spec.code) ? spec.code.join('\n') : spec.code;
    const languageKey = LANGUAGE_MAP[(spec.language || 'swift').toLowerCase()] || LANGUAGE_MAP.swift;

    let xml = SNIPPET_TEMPLATE;
    xml = xml.replace('{identifier}', this.#escapeXml(spec.identifier));
    xml = xml.replace('{title}', this.#escapeXml(spec.title || spec.identifier));
    xml = xml.replace('{completion}', this.#escapeXml(spec.completion || spec.identifier));
    xml = xml.replace('{summary}', this.#escapeXml(spec.summary || ''));
    xml = xml.replace('{content}', this.#escapeXml(content));
    xml = xml.replace('{language}', languageKey);

    return xml;
  }

  /**
   * 从 Recipe/Candidate 生成 snippet spec
   * @param {object} recipe — { id, title, trigger, code, description, language }
   * @returns {object} — snippet spec
   */
  fromRecipe(recipe) {
    return {
      identifier: `com.autosnippet.${recipe.id || this.#slugify(recipe.title)}`,
      title: recipe.title,
      completion: recipe.trigger || this.#slugify(recipe.title),
      summary: recipe.description || recipe.summary || '',
      code: recipe.code,
      language: recipe.language || 'swift',
    };
  }

  /**
   * 批量生成
   * @param {Array} recipes
   * @returns {Array<{ filename: string, content: string, spec: object }>}
   */
  generateBatch(recipes) {
    return recipes.map(recipe => {
      const spec = this.fromRecipe(recipe);
      return {
        filename: `${spec.identifier}.codesnippet`,
        content: this.generate(spec),
        spec,
      };
    });
  }

  #escapeXml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  #slugify(str) {
    if (!str) return 'unnamed';
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50);
  }
}
