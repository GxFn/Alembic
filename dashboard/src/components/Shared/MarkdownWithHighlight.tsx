import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';
import MermaidBlock from './MermaidBlock';

/** 移除 YAML frontmatter（--- 包裹的元数据块），供复制等场景使用 */
export function stripFrontmatter(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() || text;
}

/* ═══════════════════════════════════════════════════════
 *  内容预处理工具
 * ═══════════════════════════════════════════════════════ */

/** 处理双重转义的换行符 \\n -> \n */
function normalizeNewlines(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\\\\n/g, '\n');
}

/** 将单换行符转换为 Markdown 硬换行（行尾两空格），保留双换行（段落分隔）
 *  逐行处理，跳过代码围栏块内部，避免破坏代码块解析 */
function enableMarkdownHardBreaks(text: string): string {
  if (!text || typeof text !== 'string') return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const next = lines[i + 1];
    if (line !== '' && next !== undefined && next !== '') {
      out.push(line + '  ');
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/* ═══════════════════════════════════════════════════════
 *  Mermaid 提取：在 Markdown 渲染前拆分内容
 *  将 ```mermaid ... ``` 块提取为独立段落，
 *  ReactMarkdown 只负责文字和代码高亮
 * ═══════════════════════════════════════════════════════ */

const MERMAID_KEYWORDS = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline|journey|quadrantChart|sankey|xychart|block)\b/i;

interface ContentSegment {
  type: 'markdown' | 'mermaid';
  content: string;
}

/** 将 markdown 文本拆分为普通文本段和 mermaid 图表段 */
function splitMermaidSegments(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  let inMermaid = false;
  let inOtherFence = false;
  let mermaidLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);

    if (fenceMatch && !inOtherFence && !inMermaid) {
      const lang = fenceMatch[2].trim().toLowerCase();
      if (lang === 'mermaid') {
        // 开始 mermaid 块：先保存之前的 markdown 段
        if (current.length > 0) {
          segments.push({ type: 'markdown', content: current.join('\n') });
          current = [];
        }
        inMermaid = true;
        mermaidLines = [];
        continue;
      } else {
        // 其他代码围栏块
        inOtherFence = true;
        current.push(line);
        continue;
      }
    }

    if (inMermaid && fenceMatch) {
      // mermaid 块结束
      segments.push({ type: 'mermaid', content: mermaidLines.join('\n') });
      inMermaid = false;
      mermaidLines = [];
      continue;
    }

    if (inOtherFence && fenceMatch) {
      inOtherFence = false;
      current.push(line);
      continue;
    }

    if (inMermaid) {
      mermaidLines.push(line);
    } else {
      // 无语言标注的围栏块：检测内容是否以 mermaid 关键词开头
      current.push(line);
    }
  }

  // 尾部残余
  if (inMermaid && mermaidLines.length > 0) {
    segments.push({ type: 'mermaid', content: mermaidLines.join('\n') });
  }
  if (current.length > 0) {
    segments.push({ type: 'markdown', content: current.join('\n') });
  }

  return segments;
}

/* ═══════════════════════════════════════════════════════
 *  ReactMarkdown 渲染组件（纯 Markdown + 代码高亮）
 * ═══════════════════════════════════════════════════════ */

const markdownComponents = (showLineNumbers: boolean) => ({
  /* 用 div 替换默认 <pre>，避免 white-space:pre 溢出；
     min-w-0 确保 flex 布局下代码块不撑破容器 */
  pre({ children }: any) {
    return <div className="min-w-0">{children}</div>;
  },
  code({ node, className: codeClassName, children, ...props }: any) {
    const match = /language-(\w+)/.exec(codeClassName || '');
    const raw = Array.isArray(children) ? children.join('') : String(children);
    const codeStr = raw.replace(/\n$/, '');
    const isBlock = raw.includes('\n') || !!match;

    // 无语言标注但内容以 mermaid 关键词开头（AI 遗漏 language 标注的情况）
    if (isBlock && MERMAID_KEYWORDS.test(codeStr)) {
      return <MermaidBlock code={codeStr} />;
    }
    if (isBlock && match) {
      return (
        <CodeBlock
          code={codeStr}
          language={match[1]}
          showLineNumbers={showLineNumbers}
        />
      );
    }
    if (isBlock) {
      return (
        <CodeBlock
          code={codeStr}
          language="text"
          showLineNumbers={showLineNumbers}
        />
      );
    }
    return (
      <code className="px-1.5 py-0.5 bg-[var(--bg-subtle)] text-[var(--fg-primary)] rounded text-[0.9em] font-mono border border-[var(--border-default)]" {...props}>
        {children}
      </code>
    );
  },
  /* ── Typography ── */
  p: ({ children }: any) => <p className="mb-4 leading-7 last:mb-0">{children}</p>,
  h1: ({ children, ...props }: any) => {
    const id = typeof children === 'string' ? children.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, '') : undefined;
    return <h1 id={id} className="text-[1.75rem] font-bold mb-4 mt-8 first:mt-0 pb-2 border-b border-[var(--border-default)] text-[var(--fg-primary)] leading-tight scroll-mt-20" {...props}>{children}</h1>;
  },
  h2: ({ children, ...props }: any) => {
    const id = typeof children === 'string' ? children.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, '') : undefined;
    return <h2 id={id} className="text-xl font-bold mb-3 mt-8 pb-1.5 border-b border-[var(--border-default)] text-[var(--fg-primary)] leading-snug scroll-mt-20" {...props}>{children}</h2>;
  },
  h3: ({ children, ...props }: any) => {
    const id = typeof children === 'string' ? children.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, '') : undefined;
    return <h3 id={id} className="text-lg font-semibold mb-2 mt-6 text-[var(--fg-primary)] leading-snug scroll-mt-20" {...props}>{children}</h3>;
  },
  h4: ({ children, ...props }: any) => {
    const id = typeof children === 'string' ? children.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, '') : undefined;
    return <h4 id={id} className="text-base font-semibold mb-2 mt-5 text-[var(--fg-primary)] scroll-mt-20" {...props}>{children}</h4>;
  },
  strong: ({ children }: any) => <strong className="font-semibold text-[var(--fg-primary)]">{children}</strong>,
  em: ({ children }: any) => <em className="italic text-[var(--fg-secondary)]">{children}</em>,
  del: ({ children }: any) => <del className="line-through text-[var(--fg-muted)]">{children}</del>,
  hr: () => <hr className="my-8 border-0 h-px bg-[var(--border-default)]" />,

  /* ── Lists ── */
  ul: ({ children }: any) => <ul className="list-disc pl-6 mb-4 space-y-1.5 marker:text-[var(--fg-muted)]">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-6 mb-4 space-y-1.5 marker:text-[var(--fg-secondary)]">{children}</ol>,
  li: ({ children, ...props }: any) => {
    const node = props.node;
    const isTask = node?.children?.[0]?.type === 'element' && node?.children?.[0]?.tagName === 'input';
    return <li className={`leading-7 ${isTask ? 'list-none -ml-6 flex items-start gap-2' : ''}`}>{children}</li>;
  },

  /* ── Blockquote ── */
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-4 border-blue-300 bg-blue-50/40 pl-4 pr-3 py-2 my-4 text-[var(--fg-secondary)] rounded-r-lg [&>p]:mb-2 [&>p:last-child]:mb-0">
      {children}
    </blockquote>
  ),

  /* ── Links & Images ── */
  a: ({ href, children }: any) => {
    if (href?.startsWith('#')) {
      return (
        <a href={href} className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 decoration-blue-300/70 transition-colors">
          {children}
        </a>
      );
    }
    return (
      <a href={href} className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 decoration-blue-300/70 transition-colors" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img: ({ src, alt }: any) => (
    <img src={src} alt={alt || ''} className="max-w-full h-auto rounded-lg border border-[var(--border-default)] my-4" loading="lazy" />
  ),

  /* ── Table (GFM) ── */
  table: ({ children }: any) => (
    <div className="my-5 overflow-x-auto rounded-lg border border-[var(--border-default)]">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => <thead className="bg-[var(--bg-subtle)] border-b border-[var(--border-default)]">{children}</thead>,
  tbody: ({ children }: any) => <tbody className="divide-y divide-[var(--border-default)]">{children}</tbody>,
  tr: ({ children }: any) => <tr className="hover:bg-[var(--bg-subtle)] transition-colors">{children}</tr>,
  th: ({ children }: any) => <th className="px-4 py-2.5 text-left text-xs font-semibold text-[var(--fg-secondary)] uppercase tracking-wider">{children}</th>,
  td: ({ children }: any) => <td className="px-4 py-2.5 text-[var(--fg-primary)] align-top">{children}</td>,

  /* ── Input (GFM task list checkboxes) ── */
  input: ({ checked }: any) => (
    <input type="checkbox" checked={checked} readOnly className="mt-1 w-4 h-4 rounded border-[var(--border-default)] text-blue-600 cursor-default" />
  ),
});

/* ═══════════════════════════════════════════════════════
 *  主组件
 * ═══════════════════════════════════════════════════════ */

interface MarkdownWithHighlightProps {
  content: string;
  className?: string;
  showLineNumbers?: boolean;
  stripFrontmatter?: boolean;
}

const MarkdownWithHighlight: React.FC<MarkdownWithHighlightProps> = ({
  content,
  className = '',
  showLineNumbers = false,
  stripFrontmatter: doStrip = false,
}) => {
  const components = useMemo(() => markdownComponents(showLineNumbers), [showLineNumbers]);

  const segments = useMemo(() => {
    let text = doStrip ? stripFrontmatter(content) : content;
    text = normalizeNewlines(text);
    text = enableMarkdownHardBreaks(text);
    return splitMermaidSegments(text);
  }, [content, doStrip]);

  return (
    <div className={`markdown-body text-[var(--fg-primary)] ${className}`}>
      {segments.map((seg, i) =>
        seg.type === 'mermaid' ? (
          <MermaidBlock key={`mermaid-${i}`} code={seg.content} />
        ) : (
          <ReactMarkdown key={`md-${i}`} remarkPlugins={[remarkGfm]} components={components}>
            {seg.content}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
};

export default MarkdownWithHighlight;