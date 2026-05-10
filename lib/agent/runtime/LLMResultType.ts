export const LLMResultType = Object.freeze({
  FINAL_ANSWER: "final_answer",
  CONTINUE: "continue",
} as const);

export type LLMResultTypeValue = (typeof LLMResultType)[keyof typeof LLMResultType];

export function continueResult(text = "继续。"): { readonly type: string; readonly text: string } {
  return { type: LLMResultType.CONTINUE, text };
}
