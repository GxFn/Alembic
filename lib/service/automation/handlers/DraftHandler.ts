/**
 * DraftHandler — 处理 _draft_*.md 文件保存
 */

import { LanguageService } from '../../../shared/LanguageService.js';

/**
 * @param {import('../FileWatcher.js').FileWatcher} watcher
 * @param {string} fullPath
 * @param {string} relativePath
 * @param {string} content
 */
export async function handleDraft(watcher: any, fullPath: any, relativePath: any, content: any) {
  if (!content || content.trim().length < 20) {
    return;
  }

  try {
    const { RecipeParser } = await import('../../recipe/RecipeParser.js');
    const parser = new RecipeParser();

    const normalize = (arr: any) =>
      arr.map((r: any) => ({
        title: r.title,
        summary: r.summary || r.description || '',
        trigger: r.trigger,
        category: r.category || 'Utility',
        language: r.language || 'unknown',
        code: r.code,
        usageGuide: r.usageGuide || '',
        headers: r.headers || [],
      }));

    const allRecipes = parser.parseAll(content);
    if (allRecipes.length > 0) {
      const items = normalize(allRecipes);
      await watcher._appendCandidates(items, 'draft-file');
      const msg =
        allRecipes.length === 1
          ? `已创建候选「${allRecipes[0].title}」`
          : `已创建 ${allRecipes.length} 条候选`;
      watcher._notify(msg);
      return;
    }

    if (parser.isCompleteRecipe(content)) {
      const one = parser.parse(content);
      if (one) {
        const item = normalize([one])[0];
        await watcher._appendCandidates([item], 'draft-file');
        watcher._notify(`已创建候选「${one.title}」`);
        return;
      }
    }

    // AI 摘要回退（通过 Agent 统一管道）
    try {
      const { getServiceContainer } = await import('../../../injection/ServiceContainer.js');
      const container = getServiceContainer();
      const agentFactory = container.get('agentFactory');
      const lang = LanguageService.inferLang(relativePath) || 'unknown';
      const result = await agentFactory.scanKnowledge({
        label: relativePath,
        files: [{ name: relativePath, content, language: lang }],
        task: 'summarize',
      });
      if (result && !result.error && result.title && result.code) {
        await watcher._appendCandidates([result], 'draft-file');
        watcher._notify(`已创建候选「${result.title}」`);
      }
    } catch {
      /* AgentFactory 不可用 */
    }
  } catch (e: any) {
    console.warn('[Watcher] 草稿文件解析失败:', e.message);
  }
}
