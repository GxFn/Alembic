/**
 * CreateHandler — 处理 // as:c 指令
 * 从 FileWatcher 拆分，负责候选创建逻辑
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { REGEX } from '../DirectiveDetector.js';
import { saveEventFilter } from '../SaveEventFilter.js';

/**
 * 处理 // as:c 指令
 * @param {import('../FileWatcher.js').FileWatcher} watcher
 * @param {string} fullPath
 * @param {string} relativePath
 * @param {string} createOption 'c' | 'f' | undefined
 */
export async function handleCreate(watcher, fullPath, relativePath, createOption) {
  const XA = await import('../../../infrastructure/external/XcodeAutomation.js');
  const CM = await import('../../../infrastructure/external/ClipboardManager.js');

  // 1. 读剪贴板（仅 -c 模式）
  let textToExtract = '';
  if (createOption === 'c') {
    textToExtract = CM.read().trim();
  }

  // 2. 自动移除触发行
  let cutSucceeded = false;
  try {
    const content = readFileSync(fullPath, 'utf8');
    const lineNumber = findCreateLineNumber(content);

    if (XA.isXcodeRunning() && lineNumber > 0) {
      const savedClip = CM.read();
      cutSucceeded = XA.cutLineInXcode(lineNumber);
      if (cutSucceeded && savedClip) {
        await _sleep(200);
        CM.write(savedClip);
      }
    }

    if (!cutSucceeded) {
      const newContent = content.replace(REGEX.CREATE_REMOVE, '');
      saveEventFilter.markWrite(fullPath, newContent);
      writeFileSync(fullPath, newContent, 'utf8');
    }
  } catch (err) {
    console.error('[Watcher] Failed to remove as:create mark', err.message);
  }

  // 3. 无 -c 选项：打开 Dashboard
  if (createOption !== 'c') {
    const autoScan = createOption === 'f' ? '&autoScan=1' : '';
    console.log(
      createOption === 'f'
        ? '[as:create -f] 已打开 Dashboard，自动执行 Scan File'
        : '[as:create] 已打开 Dashboard，请选择 Scan File 或 Use Copied Code'
    );
    watcher._openDashboard(`/?action=create&path=${encodeURIComponent(relativePath)}${autoScan}`);
    return;
  }

  // 4. -c 模式：剪贴板为空则打开 Dashboard
  if (textToExtract.length === 0) {
    console.log('[as:create -c] 剪贴板为空，已打开 Dashboard');
    watcher._openDashboard(`/?action=create&path=${encodeURIComponent(relativePath)}`);
    return;
  }

  // 5. -c 模式：静默创建候选
  try {
    await silentCreateCandidate(watcher, textToExtract, relativePath);
  } catch (e) {
    console.warn('[Watcher] 静默创建候选失败，回退到打开浏览器:', e.message);
    watcher._openDashboard(`/?action=create&path=${encodeURIComponent(relativePath)}&source=clipboard`);
  }
}

/**
 * 静默创建候选（从剪贴板文本解析 Recipe 并提交）
 */
async function silentCreateCandidate(watcher, text, relativePath) {
  const { RecipeParser } = await import('../../recipe/RecipeParser.js');
  const parser = new RecipeParser();

  const normalize = (arr) =>
    arr.map((r) => ({
      title: r.title,
      summary: r.summary || r.summary_cn || '',
      trigger: r.trigger,
      category: r.category || 'Utility',
      language: r.language === 'swift' ? 'swift' : 'objc',
      code: r.code,
      usageGuide: r.usageGuide || '',
      headers: r.headers || [],
    }));

  // 先尝试批量解析（仅对 Recipe Markdown 格式有效）
  const allRecipes = parser.parseAll(text);
  const validRecipes = allRecipes.filter(r => r.title && r.title.trim());
  if (validRecipes.length > 0) {
    const items = normalize(validRecipes);
    await watcher._resolveHeadersIfNeeded(items[0], relativePath, text);
    await watcher._appendCandidates(items, 'watch-create');
    const msg =
      validRecipes.length === 1
        ? `已创建候选「${validRecipes[0].title}」，请在 Dashboard Candidates 页审核`
        : `已创建 ${validRecipes.length} 条候选，请在 Dashboard Candidates 页审核`;
    console.log(`✅ [as:create] ${msg}`);
    watcher._notify(msg);
    return;
  }

  // 尝试单条解析
  if (parser.isCompleteRecipe(text)) {
    const one = parser.parse(text);
    if (one && one.title && one.title.trim()) {
      const item = normalize([one])[0];
      await watcher._resolveHeadersIfNeeded(item, relativePath, text);
      await watcher._appendCandidates([item], 'watch-create');
      console.log(`✅ [as:create] 已静默创建候选「${one.title}」，请在 Dashboard Candidates 页审核`);
      watcher._notify(`已创建候选「${one.title}」，请在 Candidates 页审核`);
      return;
    }
  }

  // -c 模式：剪贴板内容整体作为一条候选（不拆分）
  // 先用 AI 生成标题和摘要，code 保持剪贴板原文
  const lang = relativePath && /\.swift$/i.test(relativePath) ? 'swift' : 'objc';
  const fileName = relativePath
    ? relativePath.split('/').pop()
    : `clipboard.${lang === 'swift' ? 'swift' : 'm'}`;

  let title = fileName.replace(/\.\w+$/, '') || 'Clipboard Snippet';
  let summary = '';
  let usageGuide = '';
  let category = 'Utility';
  let headers = [];
  let tags = [];
  let trigger = '';

  // 尝试用 AI 生成摘要信息（但 code 始终保持原文）
  try {
    const { getServiceContainer } = await import('../../../injection/ServiceContainer.js');
    const container = getServiceContainer();
    const chatAgent = container.get('chatAgent');
    const aiResult = await chatAgent.executeTool('summarize_code', { code: text, language: lang });
    if (aiResult && !aiResult.error) {
      title = aiResult.title || title;
      summary = aiResult.summary || aiResult.summary_cn || '';
      usageGuide = aiResult.usageGuide || aiResult.usageGuide_cn || '';
      category = aiResult.category || category;
      headers = aiResult.headers || [];
      tags = aiResult.tags || [];
      trigger = aiResult.trigger || '';
    }
  } catch { /* AI 不可用，使用默认值 */ }

  const item = {
    title,
    summary,
    summary_cn: summary,
    trigger,
    category,
    language: lang,
    code: text,  // 剪贴板原文整体
    usageGuide,
    usageGuide_cn: usageGuide,
    headers,
    tags,
  };

  await watcher._resolveHeadersIfNeeded(item, relativePath, text);
  await watcher._appendCandidates([item], 'watch-create');
  console.log(`✅ [as:create -c] 已创建候选「${title}」，请在 Candidates 页审核`);
  watcher._notify(`已创建候选「${title}」，请在 Candidates 页审核`);
}

/**
 * 查找 // as:c 的行号 (1-based)
 */
export function findCreateLineNumber(content) {
  if (!content) return -1;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('// as:create') || t.startsWith('// as:c')) {
      return i + 1;
    }
  }
  return -1;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
