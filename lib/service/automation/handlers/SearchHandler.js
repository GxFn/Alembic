/**
 * SearchHandler — 处理 // as:s 指令
 */

/**
 * @param {import('../FileWatcher.js').FileWatcher} watcher
 * @param {string} fullPath
 * @param {string} relativePath
 * @param {string} searchLine
 */
export async function handleSearch(watcher, fullPath, relativePath, searchLine) {
  const query = searchLine
    .replace(/^\/\/\s*(?:autosnippet|as):(?:search|s)\s*/, '')
    .trim();

  if (!query) {
    console.log(`[as:search] 请在指令后写搜索关键词，如 // as:s 网络请求`);
    return;
  }

  console.log(`\n🔍 [Search] "${query}" ...`);

  let results = [];
  try {
    const { ServiceContainer } = await import('../../../injection/ServiceContainer.js');
    const container = ServiceContainer.getInstance();
    const searchEngine = container.get('searchEngine');

    // 诊断：输出索引状态
    const stats = searchEngine.getStats();
    if (stats.totalDocuments === 0) {
      console.log(`  ⚠️  知识库为空（索引 0 条记录），请先通过 asd setup / Dashboard 添加知识条目`);
    } else {
      console.log(`  📊 索引 ${stats.totalDocuments} 条知识`);
    }

    // BM25 → keyword 逐级降级：空结果也触发降级（中文分词不足时 BM25 可能零命中）
    try {
      results = await searchEngine.search(query, { limit: 10, mode: 'bm25' });
      if (!results || (results.items || []).length === 0) {
        results = await searchEngine.search(query, { limit: 10, mode: 'keyword' });
      }
    } catch {
      results = await searchEngine.search(query, { limit: 10, mode: 'keyword' });
    }
  } catch (err) {
    console.warn(`  ⚠️ 搜索失败: ${err.message}`);
    console.log(`  ℹ️  未找到「${query}」的相关结果`);
    watcher._notify(`搜索「${query}」失败: ${err.message}`);
    return;
  }

  const items = normalizeSearchResults(results);

  if (items.length === 0) {
    console.log(`  ℹ️  未找到「${query}」的相关结果`);
    watcher._notify(`未找到「${query}」的相关结果`);
    return;
  }

  console.log(`  📋 找到 ${items.length} 条结果`);

  // NativeUI 交互选择
  const NU = await import('../../../infrastructure/external/NativeUi.js');
  const selectedIndex = NU.showCombinedWindow(items, query);

  if (selectedIndex < 0 || selectedIndex >= items.length) {
    console.log(`  ℹ️  用户取消选择`);
    return;
  }

  const selected = items[selectedIndex];
  console.log(`  ✅ 选中: ${selected.title}`);

  // 如果 selected 没有 moduleName，尝试从当前文件路径推断
  if (!selected.moduleName && selected.headers && selected.headers.length > 0) {
    try {
      const HeaderResolver = await import('../../../infrastructure/paths/HeaderResolver.js');
      const resolved = await HeaderResolver.resolveHeadersForText(
        watcher.projectRoot,
        relativePath,
        (await import('node:fs')).readFileSync(fullPath, 'utf8')
      );
      if (resolved && resolved.moduleName) {
        selected.moduleName = resolved.moduleName;
      }
    } catch { /* 解析失败不阻塞 */ }
  }

  // 自动插入代码到 Xcode
  const { insertCodeToXcode } = await import('../XcodeIntegration.js');
  await insertCodeToXcode(watcher, fullPath, selected, searchLine);
}

/**
 * 将搜索结果标准化为 NativeUI 可展示格式
 */
export function normalizeSearchResults(results) {
  if (!results) return [];
  const arr = Array.isArray(results) ? results : (results.items || []);

  return arr.map(r => {
    let code = '';
    let explanation = '';
    let headers = [];
    if (r.content) {
      try {
        const content = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
        code = content.code || content.pattern || content.markdown
          || content.content || content.body || content.snippet
          || content.solution || content.example || '';
        explanation = content.rationale || content.description
          || content.summary || content.explanation || '';
        if (Array.isArray(content.headers) && content.headers.length > 0) {
          headers = content.headers;
        }
      } catch { /* ignore */ }
    }
    // V3: headers 是独立 JSON 列（字符串），优先解析
    if (headers.length === 0 && r.headers) {
      try {
        const parsed = typeof r.headers === 'string' ? JSON.parse(r.headers) : r.headers;
        if (Array.isArray(parsed) && parsed.length > 0) {
          headers = parsed;
        }
      } catch { /* ignore */ }
    }
    // moduleName: 优先从独立列取
    let moduleName = r.moduleName || null;
    if (!moduleName && r.content) {
      try {
        const content = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
        moduleName = content.moduleName || null;
      } catch { /* ignore */ }
    }
    if (!moduleName) {
      moduleName = r.moduleName || null;
    }

    return {
      title: r.title || r.name || r.id || 'Recipe',
      code: code || r.code || r.description || r.trigger || '(无预览内容)',
      explanation: explanation || r.summary || r.description || '',
      headers,
      moduleName,
      trigger: r.trigger || r.completionKey || '',
    };
  }).filter(item => item.title);
}
