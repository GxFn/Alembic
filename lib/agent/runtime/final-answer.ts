const FINAL_ANSWER_PREFIX =
  /^(?:final\s*answer|final|answer|结论|最终答案|最终答复|总结)\s*[:：]\s*/i;

const FENCE_WRAPPER = /^```(?:\w+)?\n([\s\S]*?)\n```$/;

export interface FinalAnswerCheck {
  readonly isFinalAnswer: boolean;
  readonly cleanedText: string;
}

export function cleanFinalAnswer(text: string): string {
  const trimmed = text.trim();
  const fenced = FENCE_WRAPPER.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  return body
    .replace(FINAL_ANSWER_PREFIX, "")
    .replace(/\[MEMORY:\w+\]\s*[\s\S]*?\s*\[\/MEMORY\]/g, "")
    .replace(
      /^>\s*(?:searchHints|remainingTasks|candidateCount|crossRefs|keyFindings|gaps)\s*[:：][^\n]*\n?/gm,
      "",
    )
    .replace(
      /^\*{0,2}(?:请在|请直接|请确保|请务必|现在开始|输出你的|不要输出|不要再|不要包含|重要\s*[：:]).*(?:分析文本|分析总结|JSON|工具|输出|文本|报告)\*{0,2}[。.]?\s*$/gm,
      "",
    )
    .replace(/^注意[：:]\s*到达第\s*\d+\s*轮时.*$/gm, "")
    .replace(/^第\s*\d+\/\d+\s*轮\s*\|[^\n]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasFinalAnswerPrefix(text: string | null | undefined): boolean {
  return FINAL_ANSWER_PREFIX.test((text ?? "").trim());
}

export function checkFinalAnswer(text: string | null | undefined): FinalAnswerCheck {
  const raw = text ?? "";
  return {
    isFinalAnswer: hasFinalAnswerPrefix(raw),
    cleanedText: cleanFinalAnswer(raw),
  };
}
