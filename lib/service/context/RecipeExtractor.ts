/**
 * RecipeExtractor — Recipe 内容提取器
 * 从 Markdown 文件提取 Recipe 元数据、代码块、语义标签、质量评分
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';

export class RecipeExtractor {
  #options;

  constructor(options: any = {}) {
    this.#options = {
      extractSemanticTags: options.extractSemanticTags !== false,
      analyzeCodeQuality: options.analyzeCodeQuality !== false,
      computeQualityScore: options.computeQualityScore !== false,
      contentHashEnabled: options.contentHashEnabled !== false,
    };
  }

  /**
   * 从文件提取 Recipe
   * @param {string} filePath
   * @returns {object|null}
   */
  extractFromFile(filePath) {
    if (!existsSync(filePath)) {
      return null;
    }
    const content = readFileSync(filePath, 'utf-8');
    return this.extractFromContent(content, basename(filePath), filePath);
  }

  /**
   * 从内容提取 Recipe
   * @param {string} content
   * @param {string} filename
   * @param {string} filePath
   * @returns {object}
   */
  extractFromContent(content, filename = 'unknown', filePath = '') {
    // 1. 解析 frontmatter
    const { frontmatter, body }: any = this.#parseFrontmatter(content);

    // 2. 提取标题
    const title = frontmatter.title || this.#extractTitle(body) || filename.replace(/\.[^.]+$/, '');

    // 3. 提取代码块
    const codeBlocks = this.#extractCodeBlocks(body);

    // 4. 推断语言
    const language = frontmatter.language || this.#inferLanguage(body, filename, codeBlocks);

    // 5. 推断分类
    const category = frontmatter.category || this.#inferCategory(title, body, language);

    // 6. 语义标签
    const semanticTags = this.#options.extractSemanticTags
      ? this.#extractSemanticTags(body, codeBlocks)
      : [];

    // 7. 代码质量分析
    const quality = this.#options.analyzeCodeQuality
      ? this.#analyzeCodeQuality(codeBlocks, body)
      : {};

    // 8. 内容 hash
    const contentHash = this.#options.contentHashEnabled
      ? createHash('sha256').update(content).digest('hex').slice(0, 16)
      : null;

    return {
      id: frontmatter.id || this.#generateId(filePath || filename),
      title,
      language,
      category,
      code: codeBlocks.map((b) => b.code).join('\n\n'),
      description: frontmatter.description || this.#extractDescription(body),
      content: body,
      filePath,
      codeBlocks,
      semanticTags,
      quality,
      contentHash,
      metadata: {
        ...frontmatter,
        filename,
        extractedAt: Date.now(),
      },
    };
  }

  // --- Frontmatter ---

  #parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      return { frontmatter: {}, body: content };
    }

    const frontmatter = {};
    const lines = match[1].split('\n');
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        // 简单 YAML 值解析
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
        } else if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        } else if (/^\d+$/.test(value)) {
          value = parseInt(value, 10);
        } else {
          value = value.replace(/^['"]|['"]$/g, '');
        }
        frontmatter[key] = value;
      }
    }

    return { frontmatter, body: match[2] };
  }

  // --- Title ---

  #extractTitle(body) {
    const match = body.match(/^#\s+(.+)/m);
    return match ? match[1].trim() : null;
  }

  // --- Code Blocks ---

  #extractCodeBlocks(body) {
    const blocks = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
      blocks.push({
        language: match[1] || 'text',
        code: match[2].trim(),
        startIndex: match.index,
      });
    }
    return blocks;
  }

  // --- Language Detection ---

  #inferLanguage(body, filename, codeBlocks) {
    // 从代码块推断
    if (codeBlocks.length > 0) {
      const lang = codeBlocks[0].language;
      if (lang && lang !== 'text') {
        return lang;
      }
    }
    // 从文件名推断 —— 委托给 LanguageService
    const detected = LanguageService.inferLang(filename);
    if (detected !== 'unknown') {
      return detected;
    }
    // 从内容关键词推断
    if (/\bSwiftUI\b|\bUIKit\b|\bfunc\s/.test(body)) {
      return 'swift';
    }
    if (/\bimport\s+React\b|\bconst\s/.test(body)) {
      return 'javascript';
    }
    if (/\bdef\s+\w+.*:/.test(body)) {
      return 'python';
    }
    if (/\bclass\s+\w+.*\{/.test(body) && /\bimport\s+java\./.test(body)) {
      return 'java';
    }
    if (/\bpackage\s+\w+/.test(body) && /\bfunc\s/.test(body)) {
      return 'go';
    }
    if (/\bfun\s+\w+/.test(body) && /\bval\s|\bvar\s/.test(body)) {
      return 'kotlin';
    }
    return 'markdown';
  }

  // --- Category ---

  #inferCategory(title, body, language) {
    const text = `${title} ${body}`.toLowerCase();
    const categories = [
      {
        name: 'networking',
        keywords: ['network', 'api', 'http', 'url', 'fetch', 'request', 'response'],
      },
      { name: 'ui', keywords: ['ui', 'view', 'button', 'label', 'layout', 'component', 'render'] },
      {
        name: 'storage',
        keywords: ['storage', 'database', 'cache', 'persist', 'save', 'file', 'coredata'],
      },
      { name: 'testing', keywords: ['test', 'spec', 'assert', 'mock', 'expect', 'coverage'] },
      {
        name: 'security',
        keywords: ['security', 'auth', 'encrypt', 'token', 'permission', 'keychain'],
      },
      {
        name: 'performance',
        keywords: ['performance', 'optimize', 'speed', 'memory', 'async', 'concurrency'],
      },
      {
        name: 'error-handling',
        keywords: ['error', 'exception', 'catch', 'throw', 'fault', 'recovery'],
      },
      {
        name: 'architecture',
        keywords: ['mvvm', 'mvc', 'pattern', 'dependency', 'inject', 'protocol', 'design'],
      },
    ];

    let bestCat = 'general';
    let bestScore = 0;
    for (const { name, keywords } of categories) {
      const score = keywords.filter((kw) => text.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestCat = name;
      }
    }
    return bestCat;
  }

  // --- Semantic Tags ---

  #extractSemanticTags(body, codeBlocks) {
    const tags = new Set();
    const text = body.toLowerCase();
    const code = codeBlocks.map((b) => b.code).join('\n');

    // 关键词标签
    const tagPatterns = [
      { tag: 'async', pattern: /\basync\b|\bawait\b|\bPromise\b/i },
      { tag: 'error-handling', pattern: /\btry\b.*\bcatch\b|\bthrow\b|\bError\b/i },
      { tag: 'generics', pattern: /\b<\w+>\b|<T>|<Element>/i },
      { tag: 'protocol', pattern: /\bprotocol\b|\binterface\b|\bimplements\b/i },
      { tag: 'closure', pattern: /\bclosure\b|\bcallback\b|=>\s*{/i },
      { tag: 'testing', pattern: /\bXCTest\b|\bdescribe\b|\bit\b.*\bshould\b/i },
      { tag: 'reactive', pattern: /\bCombine\b|\bRxSwift\b|\bObservable\b|\buseState\b/i },
      { tag: 'caching', pattern: /\bcache\b|\bNSCache\b|\bmemoize\b/i },
      { tag: 'concurrency', pattern: /\bDispatchQueue\b|\bTask\s*{|\bactor\b/i },
    ];

    for (const { tag, pattern } of tagPatterns) {
      if (pattern.test(text) || pattern.test(code)) {
        tags.add(tag);
      }
    }

    return [...tags];
  }

  // --- Quality Analysis ---

  #analyzeCodeQuality(codeBlocks, body) {
    if (codeBlocks.length === 0) {
      return { score: 0.5, hasCode: false };
    }

    const allCode = codeBlocks.map((b) => b.code).join('\n');
    let score = 0.5;

    // 有测试 +0.1
    if (/test|spec|assert|expect/i.test(allCode)) {
      score += 0.1;
    }
    // 有文档注释 +0.1
    if (/\/\/\/|\/\*\*|"""/.test(allCode)) {
      score += 0.1;
    }
    // 有错误处理 +0.1
    if (/try|catch|throw|guard|Result</.test(allCode)) {
      score += 0.1;
    }
    // 合理长度 +0.1
    const lines = allCode.split('\n').length;
    if (lines >= 5 && lines <= 200) {
      score += 0.1;
    }
    // 无安全红旗 +0.1
    if (!/eval\(|exec\(|force_unwrap/.test(allCode)) {
      score += 0.1;
    }

    return {
      score: Math.min(score, 1.0),
      hasCode: true,
      codeLineCount: lines,
      codeBlockCount: codeBlocks.length,
      hasTests: /test|spec|assert/i.test(allCode),
      hasDocs: /\/\/\/|\/\*\*|"""/.test(allCode),
      hasErrorHandling: /try|catch|throw/.test(allCode),
    };
  }

  // --- Description ---

  #extractDescription(body) {
    // 取第一段非标题非代码的文本
    const lines = body.split('\n');
    const paragraphs = [];
    let inCode = false;

    for (const line of lines) {
      if (line.startsWith('```')) {
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        continue;
      }
      if (line.startsWith('#')) {
        continue;
      }
      if (line.trim().length > 0) {
        paragraphs.push(line.trim());
      }
      if (paragraphs.length >= 3) {
        break;
      }
    }

    return paragraphs.join(' ').slice(0, 300) || '';
  }

  // --- ID Generation ---

  #generateId(input) {
    return createHash('md5').update(input).digest('hex').slice(0, 12);
  }
}
