import React, { useEffect, useState } from 'react';
import mermaid from 'mermaid';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { getErrorMessage } from '../../utils/error';

let idCounter = 0;
let lastTheme = '';

function initMermaid(dark: boolean) {
  const theme = dark ? 'dark' : 'default';
  if (theme === lastTheme) return;
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'loose',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    ...(dark ? { themeVariables: {
      darkMode: true,
      background: '#1e1e1e',
      primaryColor: '#2d3748',
      primaryTextColor: '#e2e8f0',
      primaryBorderColor: '#4a5568',
      lineColor: '#94a3b8',
      secondaryColor: '#283040',
      tertiaryColor: '#1a2332',
      noteBkgColor: '#283040',
      noteTextColor: '#e2e8f0',
      noteBorderColor: '#4a5568',
    }} : {}),
  });
  lastTheme = theme;
}

interface MermaidBlockProps {
  code: string;
}

/**
 * Mermaid 图表渲染组件
 * 与 ReactMarkdown 完全独立——由外层 splitMermaidSegments 拆分并直接挂载
 */
const MermaidBlock: React.FC<MermaidBlockProps> = ({ code }) => {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid_${idCounter++}`;

    async function render() {
      initMermaid(isDark);
      try {
        const { svg: result } = await mermaid.render(id, code.trim());
        if (!cancelled) {
          setSvg(result);
          setError('');
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(getErrorMessage(err, 'Mermaid render failed'));
          setSvg('');
        }
        // mermaid.render 失败时可能在 DOM 中残留错误容器，清理
        try { document.getElementById('d' + id)?.remove(); } catch {}
      }
    }

    render();
    return () => { cancelled = true; };
  }, [code, isDark]);

  if (error) {
    return (
      <div className="my-4 p-4 bg-slate-800 text-slate-200 rounded-lg overflow-x-auto text-sm font-mono whitespace-pre-wrap">
        {code}
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-4 flex items-center justify-center py-8 text-[var(--fg-muted)] text-sm">
        {t('shared.renderingChart')}
      </div>
    );
  }

  return (
    <div
      className="my-5 flex justify-center overflow-x-auto rounded-lg border p-4 border-[var(--border-default)] bg-[var(--bg-surface)]"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

export default MermaidBlock;
