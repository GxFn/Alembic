/**
 * SnippetFactory — IDE 无关的 Snippet 生成工厂
 *
 * 职责:
 *   1. Recipe → SnippetSpec (IDE 无关的中间表示)
 *   2. 查询/列表操作 (listSnippets, getSnippet)
 *   3. 委托 Codec 生成最终 IDE 格式 (generate, generateBatch)
 *
 * Codec 注册:
 *   factory.registerCodec(codec)  — 注册 XcodeCodec / VSCodeCodec
 *   factory.generate(spec, 'xcode')  — 按 target 生成
 */

import { XcodeCodec } from './codecs/XcodeCodec.js';

export class SnippetFactory {
  /** @type {Map<string, import('./codecs/SnippetCodec.js').SnippetCodec>} */
  #codecs = new Map();

  /**
   * @param {object} [knowledgeRepository] — KnowledgeRepositoryImpl（可选）
   */
  constructor(knowledgeRepository) {
    this._recipeRepo = knowledgeRepository || null;
  }

  // ─────────────── Codec 注册 ───────────────

  /**
   * 注册一个 IDE codec
   * @param {import('./codecs/SnippetCodec.js').SnippetCodec} codec
   */
  registerCodec(codec) {
    this.#codecs.set(codec.id, codec);
  }

  /**
   * 获取已注册的 codec
   * @param {string} target — 'xcode' | 'vscode'
   * @returns {import('./codecs/SnippetCodec.js').SnippetCodec|undefined}
   */
  getCodec(target) {
    return this.#codecs.get(target);
  }

  /**
   * 获取所有已注册 codec 的 ID 列表
   * @returns {string[]}
   */
  getRegisteredTargets() {
    return [...this.#codecs.keys()];
  }

  // ─────────────── 依赖注入 ───────────────

  /**
   * 运行时注入 knowledgeRepository（用于延迟绑定场景）
   */
  setKnowledgeRepository(repo) {
    this._recipeRepo = repo;
  }

  // ─────────────── Recipe → Snippet 查询 ───────────────

  /**
   * 从 Recipe 列表实时生成 Snippet 列表
   * @param {object} [filters] — { language, category, keyword }
   * @param {object} [pagination]
   * @returns {Promise<Array>}
   */
  async listSnippets(filters = {}, pagination = { page: 1, pageSize: 50 }) {
    if (!this._recipeRepo) {
      return [];
    }

    const dbFilters = { status: 'active' };
    if (filters.language) {
      dbFilters.language = filters.language;
    }
    if (filters.category) {
      dbFilters.category = filters.category;
    }

    let result;
    if (filters.keyword) {
      result = await this._recipeRepo.search(filters.keyword, pagination);
    } else {
      result = await this._recipeRepo.findWithPagination(dbFilters, pagination);
    }

    const recipes = result?.data || result?.items || [];
    return recipes.map((r) => this.fromRecipe(r));
  }

  /**
   * 从单个 Recipe ID 实时生成 Snippet
   */
  async getSnippet(recipeId) {
    if (!this._recipeRepo) {
      return null;
    }
    const recipe = await this._recipeRepo.findById(recipeId);
    if (!recipe) {
      return null;
    }
    return this.fromRecipe(recipe);
  }

  // ─────────────── Codec 委托生成 ───────────────

  /**
   * 使用指定 codec 从 spec 生成 IDE 格式内容
   * @param {object} spec — SnippetSpec
   * @param {string} [target='xcode'] — codec ID
   * @returns {string}
   */
  generate(spec, target = 'xcode') {
    const codec = this.#resolveCodec(target);
    return codec.generate(spec);
  }

  /**
   * 批量生成 (委托 codec)
   * @param {Array} recipes
   * @param {string} [target='xcode']
   * @returns {Array<{ filename: string, content: string, spec: object }> | { filename: string, content: string, specs: object[] }}
   */
  generateBatch(recipes, target = 'xcode') {
    const codec = this.#resolveCodec(target);
    const specs = recipes.map((r) => this.fromRecipe(r));

    const bundleFilename = codec.getBundleFilename();
    if (bundleFilename) {
      // VSCode 模式: 单 bundle 文件
      return {
        filename: bundleFilename,
        content: codec.generateBundle(specs),
        specs,
      };
    }

    // Xcode 模式: 每个 snippet 一个文件
    return specs.map((spec) => ({
      filename: `${spec.identifier}${codec.fileExtension}`,
      content: codec.generate(spec),
      spec,
    }));
  }

  // ─────────────── Recipe → SnippetSpec ───────────────

  /**
   * 从 Recipe/Candidate 生成 IDE 无关的 snippet spec
   * @param {object} recipe — { id, title, trigger, code, description, language }
   * @returns {object} — SnippetSpec
   */
  fromRecipe(recipe) {
    return {
      identifier: `com.autosnippet.${recipe.id || this.#slugify(recipe.title)}`,
      title: recipe.title,
      completion: recipe.trigger || this.#slugify(recipe.title),
      summary: recipe.description || recipe.summary || '',
      code: recipe.code,
      language: recipe.language || 'unknown',
    };
  }

  // ─────────────── Private ───────────────

  /**
   * @param {string} target
   * @returns {import('./codecs/SnippetCodec.js').SnippetCodec}
   */
  #resolveCodec(target) {
    const codec = this.#codecs.get(target);
    if (!codec) {
      throw new Error(`No codec registered for target "${target}". Available: [${this.getRegisteredTargets().join(', ')}]`);
    }
    return codec;
  }

  #slugify(str) {
    if (!str) {
      return 'unnamed';
    }
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 50);
  }
}
