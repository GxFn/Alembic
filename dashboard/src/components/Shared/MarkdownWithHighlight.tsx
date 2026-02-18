import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';
import MermaidBlock from './MermaidBlock';

/** 移除 YAML frontmatter（--- 包裹的元数据块），供复制等场景使用 */
export function stripFrontmatter(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() || text;
}

interface MarkdownWithHighlightProps {
  content: string;
  className?: string;
  /** 代码块是否显示行号 */
  showLineNumbers?: boolean;
  /** 是否移除 YAML frontmatter 后渲染（用于 Recipe 对比时只显示正文） */
  stripFrontmatter?: boolean;
}

const MarkdownWithHighlight: React.FC<MarkdownWithHighlightProps> = ({
  content,
  className = '',
  showLineNumbers = false,
  stripFrontmatter: doStrip = false,
}) => {
  /** 处理双重转义的换行符 \\n -> \n */
  const normalizeNewlines = (text: string): string => {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\\\\n/g, '\n');
  };
  
  /** 将单换行符转换为 Markdown 硬换行（行尾两空格），保留双换行（段落分隔） */
  const enableMarkdownHardBreaks = (text: string): string => {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/([^\n])\n(?!\n)/g, '$1  \n');
  };
  
  let renderedContent = doStrip ? stripFrontmatter(content) : content;
  renderedContent = normalizeNewlines(renderedContent);
  renderedContent = enableMarkdownHardBreaks(renderedContent);

  return (
  <div className={`markdown-body text-slate-700 ${className}`}>
    <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      code({ node, className: codeClassName, children, ...props }) {
      const match = /language-(\w+)/.exec(codeClassName || '');
      const codeStr = String(children).replace(/\n$/, '');
      const isBlock = String(children).includes('\n');
      // Mermaid 图表特殊渲染
      if (isBlock && match && match[1] === 'mermaid') {
        return <MermaidBlock code={codeStr} />;
      }
      // 有语言标注的代码块
      if (isBlock && match) {
        return (
        <CodeBlock
          code={codeStr}
          language={match[1]}
          showLineNumbers={showLineNumbers}
        />
        );
      }
      // 无语言标注的多行代码块
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
        <code className="px-1.5 py-0.5 bg-slate-100 text-slate-800 rounded text-[0.9em] font-mono border border-slate-200/60" {...props}>
        {children}
        </code>
      );
      },
      /* ── Typography ── */
      p: ({ children }) => <p className="mb-4 leading-7 last:mb-0">{children}</p>,
      h1: ({ children, ...props }) => {
        const id = typeof children === 'string' ? children.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, '') : undefined;
        return <h1 id={id} className="text-[1.75rem] font-bold mb-4 mt-8 first:mt-0 pb-2 border-b border-slate-200/70 text-slate-900 leading-tight scroll-mt-20" {...props}>{children}</h1>;
      },
      h2: ({ children, ...props }) => {
        const id = typeof children === 'string' ? children.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, '') : undefined;
        return <h2 id={id} className="text-xl font-bold mb-3 mt-8 pb-1.5 border-b border-slate-100 text-slate-800 leading-snug scroll-mt-20" {...props}>{children}</h2>;
      },
      h3: ({ children, ...props }) => {
        const id = typeof children === 'string' ? children.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, '') : undefined;
        return <h3 id={id} className="text-lg font-semibold mb-2 mt-6 text-slate-800 leading-snug scroll-mt-20" {...props}>{children}</h3>;
      },
      h4: ({ children, ...props }) => {
        const id = typeof children === 'string' ? children.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/(^-|-$)/g, '') : undefined;
        return <h4 id={id} className="text-base font-semibold mb-2 mt-5 text-slate-700 scroll-mt-20" {...props}>{children}</h4>;
      },
      strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
      em: ({ children }) => <em className="italic text-slate-600">{children}</em>,
      del: ({ children }) => <del className="line-through text-slate-400">{children}</del>,
      hr: () => <hr className="my-8 border-0 h-px bg-slate-200" />,

      /* ── Lists ── */
      ul: ({ children }) => <ul className="list-disc pl-6 mb-4 space-y-1.5 marker:text-slate-400">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal pl-6 mb-4 space-y-1.5 marker:text-slate-500">{children}</ol>,
      li: ({ children, ...props }) => {
        // GFM task list support
        const node = (props as any).node;
        const isTask = node?.children?.[0]?.type === 'element' && node?.children?.[0]?.tagName === 'input';
        return <li className={`leading-7 ${isTask ? 'list-none -ml-6 flex items-start gap-2' : ''}`}>{children}</li>;
      },

      /* ── Blockquote ── */
      blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-blue-300 bg-blue-50/40 pl-4 pr-3 py-2 my-4 text-slate-600 rounded-r-lg [&>p]:mb-2 [&>p:last-child]:mb-0">
        {children}
      </blockquote>
      ),

      /* ── Links & Images ── */
      a: ({ href, children }) => {
        // 内部锚点链接
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
      img: ({ src, alt }) => (
        <img src={src} alt={alt || ''} className="max-w-full h-auto rounded-lg border border-slate-200 my-4" loading="lazy" />
      ),

      /* ── Table (GFM) ── */
      table: ({ children }) => (
        <div className="my-5 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="bg-slate-50 border-b border-slate-200">{children}</thead>,
      tbody: ({ children }) => <tbody className="divide-y divide-slate-100">{children}</tbody>,
      tr: ({ children }) => <tr className="hover:bg-slate-50/50 transition-colors">{children}</tr>,
      th: ({ children }) => <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">{children}</th>,
      td: ({ children }) => <td className="px-4 py-2.5 text-slate-700 align-top">{children}</td>,

      /* ── Input (for GFM task list checkboxes) ── */
      input: ({ checked, ...props }) => (
        <input type="checkbox" checked={checked} readOnly className="mt-1 w-4 h-4 rounded border-slate-300 text-blue-600 cursor-default" />
      ),
    }}
    >
    {renderedContent}
    </ReactMarkdown>
  </div>
  );
};

export default MarkdownWithHighlight;
