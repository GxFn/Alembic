/** Final answer cleanup helpers for AgentRuntime text replies. */

export function cleanFinalAnswer(response: string) {
  if (!response) {
    return '';
  }
  return response
    .replace(/^(Final Answer|最终回答|Answer)\s*[:：]\s*/i, '')
    .replace(/\[MEMORY:\w+\]\s*[\s\S]*?\s*\[\/MEMORY\]/g, '')
    .replace(
      /^>\s*(?:searchHints|remainingTasks|candidateCount|crossRefs|keyFindings|gaps)\s*[:：][^\n]*\n?/gm,
      ''
    )
    .replace(
      /^\*{0,2}(?:请在|请直接|请确保|请务必|现在开始|输出你的|不要输出|不要再|不要包含|重要\s*[：:]).*(?:分析文本|分析总结|JSON|工具|输出|文本|报告)\*{0,2}[。.]?\s*$/gm,
      ''
    )
    .replace(/^注意[：:]\s*到达第\s*\d+\s*轮时.*$/gm, '')
    .replace(/^第\s*\d+\/\d+\s*轮\s*\|[^\n]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
