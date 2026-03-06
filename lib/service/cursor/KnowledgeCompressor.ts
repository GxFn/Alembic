/**
 * KnowledgeCompressor — 知识条目压缩器（v3 优化版）
 *
 * 将 KnowledgeEntry（含 AI 预计算字段）格式化为 Cursor 交付格式：
 *   - Channel A: compressToRuleLine() → 一行式强制规则（含可选 language 前缀）
 *   - Channel B: compressToWhenDoDont() → When/Do/Don't/Why + Template 格式
 *
 * 原则：只做格式化，无字段 = 不输出，不做启发式猜测。
 *
 * v3 变更:
 *   - Channel A: 多语言项目中增加 [language] 前缀
 *   - Channel B: 增加 Why 行（content.rationale 首句）
 *   - Channel B: coreCode 骨架化（去注释 + 截断 ≤15 行）
 */

/** 从 rationale 提取首句（≤120 字符），用于 Channel B 的 Why 行 */
function _extractFirstSentence(rationale: any) {
  if (!rationale) {
    return '';
  }
  // 优先按句号或换行分割
  const first = rationale.split(/[.\n。！？!?]/)[0]?.trim();
  if (!first) {
    return '';
  }
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

/** 骨架化 coreCode：去注释 + 截断 ≤ maxLines 行 */
function _skeletonize(code: any, maxLines = 15) {
  if (!code) {
    return '';
  }
  const lines = code
    .split('\n')
    // 去掉纯注释行（// 或 /* 或 * (JSDoc续行) 或 # 开头）
    .filter((l: any) => !/^\s*(\/\/|\/\*|\*\s|#\s)/.test(l))
    // 去掉空行连续超过 1 行
    .reduce((acc: any, line: any) => {
      if (line.trim() === '' && acc.length > 0 && acc[acc.length - 1].trim() === '') {
        return acc; // 跳过连续空行
      }
      acc.push(line);
      return acc;
    }, []);
  if (lines.length <= maxLines) {
    return lines.join('\n');
  }
  return `${lines.slice(0, maxLines).join('\n')}\n// ... (truncated)`;
}

export class KnowledgeCompressor {
  /**
   * Channel A — 一行式规则（含可选 language 前缀）
   *
   * 多语言项目中增加 [language] 前缀，帮助 Agent 判断规则适用性。
   * scope='universal' 或无 language 的规则不加前缀。
   *
   * @param {Array<Object>} entries - KnowledgeEntry 数组 (kind='rule')
   * @returns {Array<string>}
   */
  compressToRuleLine(entries: any) {
    return entries
      .filter((e: any) => e.doClause) // 无 doClause → 跳过，不猜
      .map((e: any) => {
        // 可选 language 前缀
        const langPrefix = e.language && e.scope !== 'universal' ? `[${e.language}] ` : '';
        const doText = e.doClause.replace(/\.+$/, ''); // 去尾 .
        let line = `${langPrefix}${doText}`;
        if (e.dontClause) {
          // AI 可能返回 "Don't ..." / "Do not ..." / "Never ..." 开头，去掉冗余前缀后统一为 "Do NOT"
          const stripped = e.dontClause
            .replace(/^(Don't|Do not|Never)\s+/i, '')
            .replace(/\.+$/, '');
          line += `. Do NOT ${stripped}`;
        }
        return `- ${line}.`;
      });
  }

  /**
   * Channel B — When/Do/Don't/Why + Template（骨架化）
   * @param {Array<Object>} entries - KnowledgeEntry 数组 (kind='pattern')
   * @returns {Array<{ trigger: string, when: string, do: string, dont: string, why: string, template: string }>}
   */
  compressToWhenDoDont(entries: any) {
    const seen = new Set();
    return entries
      .filter((e: any) => e.trigger && e.whenClause && e.doClause) // 缺任一 → 跳过
      .map((e: any) => {
        let trigger = e.trigger.startsWith('@') ? e.trigger : `@${e.trigger}`;
        // trigger 去重（AI 应保证唯一，但防御性检查）
        if (seen.has(trigger)) {
          let i = 2;
          while (seen.has(`${trigger}-${i}`)) {
            i++;
          }
          trigger = `${trigger}-${i}`;
        }
        seen.add(trigger);

        // 提取 rationale 首句作 Why 行
        const rationale = e.content?.rationale || '';
        const why = _extractFirstSentence(rationale);

        return {
          trigger,
          when: e.whenClause,
          do: e.doClause,
          dont: e.dontClause || '',
          why,
          template: _skeletonize(e.coreCode),
        };
      });
  }

  /**
   * 将 When/Do/Don't/Why 结果格式化为 Markdown 字符串
   * @param {Array<Object>} compressed - compressToWhenDoDont 输出
   * @param {string} [language=''] 代码围栏语言标识
   * @returns {string}
   */
  formatWhenDoDont(compressed: any, language = '') {
    const lang = language || '';
    return compressed
      .map((item: any) => {
        const lines = [`### ${item.trigger}`];
        lines.push(`- **When**: ${item.when}`);
        lines.push(`- **Do**: ${item.do}`);
        if (item.dont) {
          const stripped = item.dont.replace(/^(Don't|Do not|Never)\s+/i, '');
          lines.push(`- **Don't**: ${stripped}`);
        }
        if (item.why) {
          lines.push(`- **Why**: ${item.why}`);
        }
        if (item.template) {
          lines.push('');
          lines.push(`\`\`\`${lang}`);
          lines.push(item.template);
          lines.push('```');
        }
        return lines.join('\n');
      })
      .join('\n\n');
  }

  /**
   * Channel B — Fact 条目压缩为 "Know" 行
   *
   * fact 类型没有 trigger/whenClause/doClause 结构，
   * 采用 "Know: {title} — {description}" 的简洁格式，
   * 让 Agent 获取项目事实性知识（技术选型、架构决策等）。
   *
   * @param {Array<Object>} facts - KnowledgeEntry 数组 (kind='fact')
   * @returns {Array<{ title: string, summary: string }>}
   */
  compressToFactLines(facts: any) {
    return facts
      .filter((e: any) => e.title)
      .map((e: any) => {
        const summary = e.description || e.content?.markdown || '';
        const shortSummary = summary.length > 150 ? `${summary.slice(0, 147)}...` : summary;
        return { title: e.title, summary: shortSummary };
      });
  }

  /**
   * 将 Fact 压缩结果格式化为 Markdown 字符串
   * @param {Array<{ title: string, summary: string }>} factLines
   * @returns {string}
   */
  formatFactLines(factLines: any) {
    if (factLines.length === 0) {
      return '';
    }
    const lines = ['', '## Context Facts', ''];
    for (const f of factLines) {
      if (f.summary) {
        lines.push(`- **${f.title}**: ${f.summary}`);
      } else {
        lines.push(`- **${f.title}**`);
      }
    }
    return lines.join('\n');
  }
}

export default KnowledgeCompressor;
