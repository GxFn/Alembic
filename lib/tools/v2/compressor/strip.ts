/**
 * @module tools/v2/compressor/strip
 *
 * 文本清理工具: ANSI 控制字符去除 + 连续重复行折叠。
 * 用于终端输出的预处理，节省 10-30% 无用 token。
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require matching control characters
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** 去除 ANSI 控制字符 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 折叠连续重复行。
 * 例如: 10 行 "." → 第一行 + "(repeated 9 times)"
 */
export function collapseRepeats(text: string, threshold = 3): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let prevLine = '';
  let repeatCount = 0;

  for (const line of lines) {
    if (line === prevLine) {
      repeatCount++;
    } else {
      if (repeatCount >= threshold) {
        result.push(`  (repeated ${repeatCount} times)`);
      } else {
        for (let i = 0; i < repeatCount; i++) {
          result.push(prevLine);
        }
      }
      result.push(line);
      prevLine = line;
      repeatCount = 0;
    }
  }

  if (repeatCount >= threshold) {
    result.push(`  (repeated ${repeatCount} times)`);
  } else {
    for (let i = 0; i < repeatCount; i++) {
      result.push(prevLine);
    }
  }

  return result.join('\n');
}

/**
 * 通用截断: head(40%) + 省略提示 + tail(10%)
 * 保留 stderr 完整输出。
 */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const headRatio = 0.4;
  const tailRatio = 0.1;
  const headLen = Math.floor(maxChars * headRatio);
  const tailLen = Math.floor(maxChars * tailRatio);

  const lines = text.split('\n');
  const totalLines = lines.length;

  let headContent = '';
  let headLineCount = 0;
  for (const line of lines) {
    if (headContent.length + line.length + 1 > headLen) {
      break;
    }
    headContent += (headContent ? '\n' : '') + line;
    headLineCount++;
  }

  let tailContent = '';
  let tailLineCount = 0;
  for (let i = lines.length - 1; i >= headLineCount; i--) {
    const candidate = lines[i] + (tailContent ? '\n' : '') + tailContent;
    if (candidate.length > tailLen) {
      break;
    }
    tailContent = candidate;
    tailLineCount++;
  }

  const omitted = totalLines - headLineCount - tailLineCount;
  return `${headContent}\n\n... (${omitted} lines omitted) ...\n\n${tailContent}`;
}

/** 完整清理流水线: stripAnsi → collapseRepeats */
export function cleanOutput(text: string): string {
  return collapseRepeats(stripAnsi(text));
}
