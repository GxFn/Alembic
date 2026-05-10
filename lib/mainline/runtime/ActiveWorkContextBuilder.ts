import { normalizeMainlinePosixPath, uniqueMainlinePosixPaths } from "../core/index.js";
import type { ActiveWorkContext, RuntimeError } from "../knowledge/index.js";

export interface ActiveWorkContextBuildInput {
  readonly projectRoot: string;
  readonly prompt?: string;
  readonly taskText?: string;
  readonly activeFile?: string;
  readonly files?: readonly string[];
  readonly symbols?: readonly string[];
  readonly diff?: string;
  readonly errors?: readonly RuntimeError[];
  readonly commandIntent?: string;
  readonly userFocus?: string;
}

/**
 * ActiveWorkContextBuilder 把 IDE/Codex 的现场信号归一成 runtime 输入。
 * 这里不读文件、不扫 Markdown，也不触发 rescan；它只是运行期检索的边界对象。
 */
export class ActiveWorkContextBuilder {
  build(input: ActiveWorkContextBuildInput): ActiveWorkContext {
    return {
      projectRoot: input.projectRoot,
      taskText: firstNonEmpty(input.taskText, input.prompt),
      files: uniqueMainlinePosixPaths([input.activeFile, ...(input.files ?? [])].filter(isString)),
      symbols: uniqueStrings(input.symbols ?? []),
      diff: nonEmpty(input.diff),
      errors: [...(input.errors ?? [])],
      commandIntent: nonEmpty(input.commandIntent),
      userFocus: nonEmpty(input.userFocus),
    };
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map(nonEmpty).find((value): value is string => Boolean(value));
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && normalizeMainlinePosixPath(value).length > 0;
}
