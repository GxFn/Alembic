import React, { useEffect, useRef, useState, useId } from 'react';
import mermaid from 'mermaid';

// 全局只初始化一次
let mermaidInitialized = false;

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

const MermaidBlock: React.FC<MermaidBlockProps> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const uniqueId = useId().replace(/:/g, '_');

  useEffect(() => {
    let cancelled = false;

    async function render() {
      ensureMermaidInit();
      try {
        const { svg: rendered } = await mermaid.render(`mermaid_${uniqueId}`, code.trim());
        if (!cancelled) {
          setSvg(rendered);
          setError('');
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Mermaid render failed');
          setSvg('');
        }
        // mermaid.render 失败时会在 DOM 中插入错误节点，清理掉
        const errNode = document.getElementById(`dmermaid_${uniqueId}`);
        if (errNode) errNode.remove();
      }
    }

    render();
    return () => { cancelled = true; };
  }, [code, uniqueId]);

  if (error) {
    // 渲染失败时回退显示原始代码
    return (
      <pre className="my-4 p-4 bg-slate-800 text-slate-200 rounded-lg overflow-x-auto text-sm font-mono">
        <code>{code}</code>
      </pre>
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
      ref={containerRef}
      className="my-5 flex justify-center overflow-x-auto rounded-lg border border-slate-200 bg-white p-4"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

export default MermaidBlock;
