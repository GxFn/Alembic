import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

/** 支持的语法：Objective-C、Swift、Markdown */
export type CodeLanguage = 'objectivec' | 'objc' | 'swift' | 'markdown';

const LANGUAGE_MAP: Record<string, string> = {
  objectivec: 'objectivec',
  objc: 'objectivec',
  'objective-c': 'objectivec',
  'obj-c': 'objectivec',
  swift: 'swift',
  markdown: 'markdown',
  md: 'markdown',
};

interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
  showLineNumbers?: boolean;
}

/**
 * 规范化代码字符串：修复 AI 生成时产生的 regex 转义和字面量 \n
 *
 * 症状: AI 将代码放入 content.pattern 时，有时会把 [ ^ * ( ) { } 等
 * 字符做 regex 转义（\[、\*、\^…），并把换行写成字面量 \n 而非真实换行。
 * 这导致代码在前端显示为单行且含大量反斜杠。
 *
 * 策略:
 * 1. 若字符串不含真实换行但包含字面量 \n → 替换为真实换行
 * 2. 若存在 3+ 个 regex 转义序列（\[、\*、\^…）→ 反转义
 */
export function normalizeCode(raw: string): string {
  if (!raw) return raw;

  let code = raw;

  // Step 1: 字面量 \n → 真实换行（仅当整段代码无真实换行时）
  if (!code.includes('\n') && code.includes('\\n')) {
    code = code.replace(/\\n/g, '\n');
  }

  // Step 2: 检测 regex 转义并还原
  // 只检测常见 regex 元字符前的反斜杠：[ ] { } ( ) * + ? ^ $ . |
  const regexEscapes = code.match(/\\(?=[\[\]{}()*+?^$.|])/g);
  if (regexEscapes && regexEscapes.length >= 3) {
    code = code.replace(/\\([\[\]{}()*+?^$.|])/g, '$1');
  }

  return code;
}

const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language = 'text',
  className = '',
  showLineNumbers = false,
}) => {
  const lang = LANGUAGE_MAP[language?.toLowerCase()] || language?.toLowerCase() || 'text';
  const noRadius = className.includes('!rounded-none');
  const normalized = normalizeCode(code);
  return (
  <div className={`rounded-xl overflow-x-auto text-sm min-w-0 ${className}`}>
    <SyntaxHighlighter
    language={lang}
    style={oneDark}
    showLineNumbers={showLineNumbers}
    customStyle={{
      margin: 0,
      padding: '1rem 1.25rem',
      fontSize: '0.8125rem',
      lineHeight: 1.5,
      borderRadius: noRadius ? 0 : '0.75rem',
      overflowX: 'auto',
    }}
    codeTagProps={{ className: 'language-highlighted', style: { fontFamily: 'ui-monospace, monospace' } }}
    PreTag="div"
    >
    {normalized}
    </SyntaxHighlighter>
  </div>
  );
};

export default CodeBlock;
