import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface HighlightedCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onCursorChange?: (cursorPos: number) => void;
  language?: string;
  height?: string;
  className?: string;
  placeholder?: string;
  rows?: number;
  showLineNumbers?: boolean;
}

// ─── Memoised highlight layer ────────────────────────────
const MemoHighlight = React.memo<{
  code: string;
  lang: string;
  editorStyles: Record<string, unknown>;
}>(({ code, lang, editorStyles }) => (
  <SyntaxHighlighter
    language={lang}
    style={oneDark}
    showLineNumbers={false}
    customStyle={{
      margin: 0,
      padding: editorStyles.padding as string,
      fontSize: editorStyles.fontSize as string,
      lineHeight: editorStyles.lineHeight as number,
      borderRadius: '0',
      whiteSpace: 'pre',
      verticalAlign: 'top',
      display: 'inline-block',
      minWidth: '100%',
      minHeight: '100%',
      backgroundColor: '#282c34'
    }}
    codeTagProps={{
      style: {
        fontFamily: editorStyles.fontFamily as string,
        whiteSpace: 'pre' as const,
        verticalAlign: 'top' as const,
        fontSize: editorStyles.fontSize as string,
        lineHeight: editorStyles.lineHeight as number
      }
    }}
    PreTag="div"
  >
    {(() => {
      const content = code;
      return content[content.length - 1] === '\n' ? content + ' ' : content;
    })()}
  </SyntaxHighlighter>
));

// ─── Virtualised line numbers ────────────────────────────
const LINE_HEIGHT_PX = 19.5; // 13px * 1.5 lineHeight

const VirtualLineNumbers: React.FC<{
  totalLines: number;
  scrollTop: number;
  viewportHeight: number;
  fontSize: string;
  lineHeight: number;
  fontFamily: string;
}> = React.memo(({ totalLines, scrollTop, viewportHeight, fontSize, lineHeight, fontFamily }) => {
  const overscan = 10;
  const startLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT_PX) - overscan);
  const visibleCount = Math.ceil(viewportHeight / LINE_HEIGHT_PX) + overscan * 2;
  const endLine = Math.min(totalLines, startLine + visibleCount);

  const topPad = startLine * LINE_HEIGHT_PX;
  const bottomPad = Math.max(0, (totalLines - endLine) * LINE_HEIGHT_PX);

  const lines: React.ReactNode[] = [];
  for (let i = startLine; i < endLine; i++) {
    lines.push(<div key={i}>{i + 1}</div>);
  }

  return (
    <div style={{ paddingTop: topPad, paddingBottom: bottomPad, fontSize, lineHeight, fontFamily }}>
      {lines}
    </div>
  );
});

/**
 * 带代码高亮的编辑器组件
 * 采用分层叠加方案（Overlay Pattern）：
 * - 下层：SyntaxHighlighter 显示高亮代码（不可交互，延迟更新）
 * - 上层：textarea 用于输入（透明背景，实时响应）
 * - 同时滚动保持两层同步
 *
 * 性能优化：
 * 1. 高亮层 debounce（150 ms）—— 打字不卡
 * 2. 行号虚拟化 —— 只渲染可视区域
 * 3. React.memo —— 避免无关渲染
 */
const HighlightedCodeEditor: React.FC<HighlightedCodeEditorProps> = ({
  value,
  onChange,
  onCursorChange,
  language = 'javascript',
  height = '400px',
  className = '',
  placeholder = '',
  rows,
  showLineNumbers = true
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const lineNumberRef = useRef<HTMLDivElement>(null);

  // ── debounced highlight value ──
  const [debouncedValue, setDebouncedValue] = useState(value);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // 短文件直接更新；长文件 debounce
    const delay = value.length > 5000 ? 200 : value.length > 1000 ? 80 : 0;
    if (delay === 0) {
      setDebouncedValue(value);
      return;
    }
    debounceTimerRef.current = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(debounceTimerRef.current);
  }, [value]);

  // ── virtualised line numbers scroll state ──
  const [scrollState, setScrollState] = useState({ top: 0, height: 400 });

  // 语言映射
  const langMap: Record<string, string> = {
    objectivec: 'objectivec', 'objective-c': 'objectivec', 'obj-c': 'objectivec', objc: 'objectivec',
    swift: 'swift', javascript: 'javascript', js: 'javascript',
    typescript: 'typescript', ts: 'typescript', python: 'python', py: 'python',
    bash: 'bash', shell: 'bash', markdown: 'markdown', md: 'markdown', json: 'json', text: 'text'
  };
  const lang = langMap[language?.toLowerCase()] || language?.toLowerCase() || 'text';

  // 统一的样式变量
  const editorStyles = useMemo(() => ({
    padding: '1rem 1.25rem',
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    fontFamily: 'ui-monospace, monospace',
    minHeight: '200px'
  }), []);

  // 处理 textarea 滚动
  const handleScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = textarea.scrollTop;
      highlightRef.current.scrollLeft = textarea.scrollLeft;
    }
    if (lineNumberRef.current) {
      lineNumberRef.current.scrollTop = textarea.scrollTop;
    }
    setScrollState({ top: textarea.scrollTop, height: textarea.clientHeight });
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    if (onCursorChange) {
      onCursorChange(e.target.selectionStart || 0);
    }
  }, [onChange, onCursorChange]);

  const handleCursorUpdate = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    if (!onCursorChange) return;
    onCursorChange((e.currentTarget as HTMLTextAreaElement).selectionStart || 0);
  }, [onCursorChange]);

  const lineCount = useMemo(() => (value || '').split('\n').length, [value]);

  // 初始化 scrollState.height
  useEffect(() => {
    if (textareaRef.current) {
      setScrollState(s => ({ ...s, height: textareaRef.current!.clientHeight }));
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden ${className}`}
      style={{ 
        height: rows ? 'auto' : height,
        minHeight: editorStyles.minHeight,
        display: 'flex',
        borderRadius: '0',
        backgroundColor: '#282c34'
      }}
    >
      {/* 行号列 - 虚拟化渲染 */}
      {showLineNumbers && (
        <div
          ref={lineNumberRef}
          className="flex-shrink-0 overflow-hidden pointer-events-none select-none"
          style={{
            width: '3.5em',
            backgroundColor: '#282c34',
            color: '#5c6370',
            textAlign: 'right',
            paddingTop: '1rem',
            paddingRight: '0.75em',
            paddingBottom: '1rem',
            borderRadius: '0',
            borderRight: '1px solid #333842',
          }}
        >
          <VirtualLineNumbers
            totalLines={lineCount}
            scrollTop={scrollState.top}
            viewportHeight={scrollState.height}
            fontSize={editorStyles.fontSize}
            lineHeight={editorStyles.lineHeight}
            fontFamily={editorStyles.fontFamily}
          />
        </div>
      )}

      {/* 代码区域容器 */}
      <div 
        className="relative flex-1"
        style={{ borderRadius: '0', backgroundColor: '#282c34' }}
      >
        {/* 高亮显示层 - debounce 更新 */}
        <div
          ref={highlightRef}
          className="absolute inset-0 pointer-events-none highlight-scroll-hidden"
          style={{ zIndex: 0, overflow: 'scroll' }}
        >
          <MemoHighlight
            code={debouncedValue || placeholder}
            lang={lang}
            editorStyles={editorStyles}
          />
        </div>

        {/* 输入层 - textarea（透明，实时响应） */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onSelect={handleCursorUpdate}
          onKeyUp={handleCursorUpdate}
          onClick={handleCursorUpdate}
          onScroll={handleScroll}
          rows={rows}
          placeholder={placeholder}
          className="absolute inset-0 w-full h-full resize-none outline-none editor-with-dark-scrollbar"
          style={{
            padding: editorStyles.padding,
            lineHeight: editorStyles.lineHeight,
            fontSize: editorStyles.fontSize,
            fontFamily: editorStyles.fontFamily,
            caretColor: '#61afef',
            backgroundColor: 'transparent',
            color: 'transparent',
            WebkitTextFillColor: 'transparent',
            zIndex: 10,
            border: 'none',
            margin: 0,
            overflow: 'auto',
            overflowX: 'hidden',
            WebkitAppearance: 'none',
            appearance: 'none' as const,
            boxSizing: 'border-box',
            whiteSpace: 'pre'
          }}
        />
      </div>
    </div>
  );
};
export default HighlightedCodeEditor;
