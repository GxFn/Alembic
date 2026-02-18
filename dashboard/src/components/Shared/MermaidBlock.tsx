import React, { useEffect, useState } from 'react';
import mermaid from 'mermaid';

// 全局只初始化一次
let mermaidInitialized = false;
let idCounter = 0;

function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
  });
  mermaidInitialized = true;
}

interface MermaidBlockProps {
  code: string;
}

/**
 * Mermaid 图表渲染组件
 * 与 ReactMarkdown 完全独立——由外层 splitMermaidSegments 拆分并直接挂载
 */
const MermaidBlock: React.FC<MermaidBlockProps> = ({ code }) => {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid_${idCounter++}`;

    async function render() {
      ensureMermaidInit();
      try {
        const { svg: result } = await mermaid.render(id, code.trim());
        if (!cancelled) {
          setSvg(result);
          setError('');
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Mermaid render failed');
          setSvg('');
        }
        // mermaid.render 失败时可能在 DOM 中残留错误容器，清理
        try { document.getElementById('d' + id)?.remove(); } catch {}
      }
    }

    render();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="my-4 p-4 bg-slate-800 text-slate-200 rounded-lg overflow-x-auto text-sm font-mono whitespace-pre-wrap">
        {code}
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-4 flex items-center justify-center py-8 text-slate-400 text-sm">
        渲染图表中…
      </div>
    );
  }

  return (
    <div
      className="my-5 flex justify-center overflow-x-auto rounded-lg border border-slate-200 bg-white p-4"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

export default MermaidBlock;
