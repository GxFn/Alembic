/**
 * KnowledgeCompressor — 知识条目压缩器（v2 无降级版）
 *
 * 将 KnowledgeEntry（含 AI 预计算字段）格式化为 Cursor 交付格式：
 *   - Channel A: compressToRuleLine() → 一行式强制规则
 *   - Channel B: compressToWhenDoDont() → When/Do/Don't + Template 格式
 *
 * 原则：只做格式化，无字段 = 不输出，不做启发式猜测。
 */

export class KnowledgeCompressor {
  /**
   * Channel A — 一行式规则
   * @param {Array<Object>} entries - KnowledgeEntry 数组 (kind='rule')
   * @returns {Array<string>}
   */
  compressToRuleLine(entries) {
    return entries
      .filter((e) => e.doClause) // 无 doClause → 跳过，不猜
      .map((e) => {
        let line = e.doClause;
        if (e.dontClause) {
          // AI 可能返回 "Don't ..." / "Do not ..." 开头，去掉冗余前缀
          const stripped = e.dontClause.replace(/^(Don't|Do not|Never)\s+/i, '');
          line += `. Do NOT ${stripped}`;
        }
        return `- ${line}.`;
      });
  }

  /**
   * Channel B — When/Do/Don't + Template
   * @param {Array<Object>} entries - KnowledgeEntry 数组 (kind='pattern')
   * @returns {Array<{ trigger: string, when: string, do: string, dont: string, template: string }>}
   */
  compressToWhenDoDont(entries) {
    const seen = new Set();
    return entries
      .filter((e) => e.trigger && e.whenClause && e.doClause) // 缺任一 → 跳过
      .map((e) => {
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
        return {
          trigger,
          when: e.whenClause,
          do: e.doClause,
          dont: e.dontClause || '',
          template: e.coreCode || '',
        };
      });
  }

  /**
   * 将 When/Do/Don't 结果格式化为 Markdown 字符串
   * @param {Array<Object>} compressed - compressToWhenDoDont 输出
   * @param {string} [language=''] - 代码围栏语言标识
   * @returns {string}
   */
  formatWhenDoDont(compressed, language = '') {
    const lang = language || '';
    return compressed
      .map((item) => {
        const lines = [`### ${item.trigger}`];
        lines.push(`- **When**: ${item.when}`);
        lines.push(`- **Do**: ${item.do}`);
        if (item.dont) {
          const stripped = item.dont.replace(/^(Don't|Do not|Never)\s+/i, '');
          lines.push(`- **Don't**: ${stripped}`);
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
}

export default KnowledgeCompressor;
