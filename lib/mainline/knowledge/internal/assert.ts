/**
 * Knowledge 模型的本地轻量校验工具。
 * 这里不依赖 mainline/core，避免 L2 模型迁移时越过本轮写入边界。
 */
export function requireNonEmptyString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

/** 在置信度、权重等数值进入图谱 artifact 之前做统一归一化。 */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
