import React, { useState, useCallback, useRef, useEffect, ReactNode } from 'react';
import { X, Send, ChevronDown, Loader2, MessageSquare, Brain, Code2 } from 'lucide-react';
import { useI18n } from '../../i18n';

/* ═══════════════════════════════════════════════════════════
 * ChatPanel — 通用对话式交互面板（基础组件）
 *
 * 提供右侧滑出的对话面板骨架，包含:
 *   1. 可自定义 Header
 *   2. 可选的上下文信息区（含可折叠代码预览）
 *   3. 通用对话区域（消息列表 + 自定义消息渲染）
 *   4. 底部输入框 + 发送按钮
 *   5. 可自定义的操作栏（Action Bar）
 *
 * 本组件不包含任何业务逻辑，仅提供 UI 骨架和交互基础能力。
 * 具体场景（润色、分析、问答等）通过 props 注入逻辑。
 *
 * 扩展方式:
 *   <ChatPanel
 *     title="对话式润色"
 *     onSend={handleRefine}
 *     renderActions={...}
 *   />
 * ═══════════════════════════════════════════════════════════ */

// ─── 公共类型 ────────────────────────────────────────────

/** 对话消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 业务扩展数据 — 不同场景自行定义（如 diff / preview） */
  extra?: Record<string, any>;
  timestamp: number;
}

/** 上下文信息条目（显示在 Header 下方） */
export interface ChatContextItem {
  /** 标题 */
  title: string;
  /** 副标题/摘要 */
  subtitle?: string;
  /** 右上角徽标 */
  badge?: string;
  /** 标签列表 */
  tags?: string[];
  /** 右上角指标（如置信度） */
  indicator?: { label: string; value: string };
  /** 可折叠的代码/文档内容 */
  code?: string;
  /** 代码区标题（默认 "文档内容"） */
  codeLabel?: string;
}

/** ChatPanel Props */
export interface ChatPanelProps {
  // ── 外观 ──
  /** 面板标题 */
  title: string;
  /** 标题旁的徽标（如 "1 / 5"） */
  titleBadge?: string;
  /** 副标题 */
  subtitle?: string;
  /** Header 图标（默认 MessageSquare） */
  headerIcon?: ReactNode;
  /** 面板宽度 class（默认 "w-[680px] max-w-[90vw]"） */
  widthClass?: string;
  /** 主题色 class 名前缀（默认 "emerald"）— 影响按钮/高亮/图标颜色 */
  themeColor?: 'emerald' | 'blue' | 'violet' | 'amber';

  // ── 上下文 ──
  /** 上下文信息（显示在 Header 下方） */
  context?: ChatContextItem;
  /** 代码区默认展开（默认 true） */
  defaultCodeExpanded?: boolean;

  // ── 消息 ──
  /** 消息列表 */
  messages: ChatMessage[];
  /** 是否正在加载 */
  loading?: boolean;
  /** 加载中提示文案 */
  loadingText?: string;
  /** 空状态标题 */
  emptyTitle?: string;
  /** 空状态描述 */
  emptyDescription?: string;
  /** 空状态快捷建议按钮 */
  suggestions?: string[];
  /** 空状态图标（默认 Sparkles） */
  emptyIcon?: ReactNode;
  /** AI 助手名称（消息头显示，默认 "AI 助手"） */
  assistantName?: string;
  /** 自定义消息渲染（额外内容追加在消息文本下方） */
  renderMessageExtra?: (msg: ChatMessage) => ReactNode;

  // ── 输入 ──
  /** 输入框占位符 */
  placeholder?: string;
  /** 输入框底部提示文案 */
  inputHint?: string;
  /** 是否禁用输入 */
  inputDisabled?: boolean;

  // ── 行为 ──
  /** 发送消息回调 */
  onSend: (text: string) => void | Promise<void>;
  /** 关闭面板 */
  onClose: () => void;
  /** 点击快捷建议时的回调（默认填入输入框） */
  onSuggestionClick?: (text: string) => void;

  // ── 操作栏 ──
  /** 消息列表与输入框之间的操作栏区域 */
  renderActions?: () => ReactNode;

  // ── 高级 ──
  /** 子组件渲染在输入框上方（操作栏下方、输入区上方） */
  children?: ReactNode;
  /** 嵌入模式 — 不渲染 fixed 遮罩层，直接输出面板内容（由父组件控制定位） */
  embedded?: boolean;
}

/** 生成随机 ID */
export const uid = () => Math.random().toString(36).substring(2, 10);

// ─── 主题色映射 ────────────────────────────────────────────

const THEME = {
  emerald: {
    iconBg: 'from-emerald-50 to-teal-50',
    iconBorder: 'border-emerald-100',
    iconText: 'text-emerald-600',
    sendBtn: 'from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700',
    focusRing: 'focus:ring-emerald-200 focus:border-emerald-400',
    userBubble: 'bg-emerald-600',
    assistantIcon: 'text-emerald-500',
    assistantLabel: 'text-emerald-600',
    loadingIcon: 'text-emerald-500',
    suggestionHover: 'hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200',
    emptyIconBg: 'bg-emerald-50 border-emerald-100',
    emptyIconColor: 'text-emerald-500',
  },
  blue: {
    iconBg: 'from-blue-50 to-indigo-50',
    iconBorder: 'border-blue-100',
    iconText: 'text-blue-600',
    sendBtn: 'from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700',
    focusRing: 'focus:ring-blue-200 focus:border-blue-400',
    userBubble: 'bg-blue-600',
    assistantIcon: 'text-blue-500',
    assistantLabel: 'text-blue-600',
    loadingIcon: 'text-blue-500',
    suggestionHover: 'hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200',
    emptyIconBg: 'bg-blue-50 border-blue-100',
    emptyIconColor: 'text-blue-500',
  },
  violet: {
    iconBg: 'from-violet-50 to-purple-50',
    iconBorder: 'border-violet-100',
    iconText: 'text-violet-600',
    sendBtn: 'from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700',
    focusRing: 'focus:ring-violet-200 focus:border-violet-400',
    userBubble: 'bg-violet-600',
    assistantIcon: 'text-violet-500',
    assistantLabel: 'text-violet-600',
    loadingIcon: 'text-violet-500',
    suggestionHover: 'hover:bg-violet-50 hover:text-violet-700 hover:border-violet-200',
    emptyIconBg: 'bg-violet-50 border-violet-100',
    emptyIconColor: 'text-violet-500',
  },
  amber: {
    iconBg: 'from-amber-50 to-orange-50',
    iconBorder: 'border-amber-100',
    iconText: 'text-amber-600',
    sendBtn: 'from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700',
    focusRing: 'focus:ring-amber-200 focus:border-amber-400',
    userBubble: 'bg-amber-600',
    assistantIcon: 'text-amber-500',
    assistantLabel: 'text-amber-600',
    loadingIcon: 'text-amber-500',
    suggestionHover: 'hover:bg-amber-50 hover:text-amber-700 hover:border-amber-200',
    emptyIconBg: 'bg-amber-50 border-amber-100',
    emptyIconColor: 'text-amber-500',
  },
} as const;

// ─── ChatPanel 组件 ────────────────────────────────────────

const ChatPanel: React.FC<ChatPanelProps> = (props) => {
  const { t } = useI18n();
  const {
    title,
    titleBadge,
    subtitle,
    headerIcon,
    widthClass = 'w-[680px] max-w-[90vw]',
    themeColor = 'emerald',

    context,
    defaultCodeExpanded = true,

    messages,
    loading = false,
    loadingText = t('chatPanel.defaultLoading'),
    emptyTitle = t('chatPanel.defaultEmptyTitle'),
    emptyDescription = t('chatPanel.defaultEmptyDesc'),
    suggestions,
    emptyIcon,
    assistantName = t('chatPanel.defaultAssistant'),
    renderMessageExtra,

    placeholder = t('chatPanel.defaultPlaceholder'),
    inputHint = t('chatPanel.defaultInputHint'),
    inputDisabled = false,

    onSend,
    onClose,
    onSuggestionClick,

    renderActions,

    children,
    embedded = false,
  } = props;
  const [input, setInput] = useState('');
  const [codeExpanded, setCodeExpanded] = useState(defaultCodeExpanded);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const theme = THEME[themeColor];

  // 自动滚动到底部
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 聚焦输入框
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 300);
  }, []);

  /** 发送 */
  const handleSend = useCallback(() => {
    if (!input.trim() || loading || inputDisabled) return;
    const text = input.trim();
    setInput('');
    onSend(text);
  }, [input, loading, inputDisabled, onSend]);

  /** 键盘: Enter 发送, Shift+Enter 换行 */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  /** 快捷建议点击 */
  const handleSuggestion = useCallback((text: string) => {
    if (onSuggestionClick) {
      onSuggestionClick(text);
    } else {
      setInput(text);
      inputRef.current?.focus();
    }
  }, [onSuggestionClick]);

  // ── 面板主体内容（Header + 消息列表 + 输入区） ──
  const panelContent = (
    <>
      {/* ── Header ── */}
      <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${theme.iconBg} border ${theme.iconBorder} flex items-center justify-center`}>
            {headerIcon || <MessageSquare className={theme.iconText} size={18} />}
          </div>
          <div>
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                {title}
                {titleBadge && (
                  <span className={`text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 ${theme.assistantLabel} font-medium`}>
                    {titleBadge}
                  </span>
                )}
              </h3>
              {subtitle && (
                <p className="text-[11px] text-slate-400 truncate max-w-[400px]">
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X size={18} className="text-slate-400" />
          </button>
        </div>

        {/* ── 上下文信息区 ── */}
        {context && (
          <div className="border-b border-slate-100 bg-slate-50/50 shrink-0">
            <div className="px-5 py-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-slate-700 truncate">{context.title}</span>
                    {context.badge && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100">
                        {context.badge}
                      </span>
                    )}
                  </div>
                  {context.subtitle && (
                    <p className="text-[11px] text-slate-500 line-clamp-2 leading-relaxed">
                      {context.subtitle}
                    </p>
                  )}
                  {context.tags && context.tags.length > 0 && (
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      {context.tags.slice(0, 8).map(t => (
                        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{t}</span>
                      ))}
                      {context.tags.length > 8 && (
                        <span className="text-[10px] text-slate-400">+{context.tags.length - 8}</span>
                      )}
                    </div>
                  )}
                </div>
                {context.indicator && (
                  <div className="text-center shrink-0">
                    <div className="text-[10px] text-slate-400">{context.indicator.label}</div>
                    <div className="text-sm font-bold text-slate-700">{context.indicator.value}</div>
                  </div>
                )}
              </div>
            </div>

            {/* 可折叠代码/文档内容 */}
            {context.code && (
              <div className="border-t border-slate-200/60">
                <button
                  onClick={() => setCodeExpanded(prev => !prev)}
                  className="w-full px-5 py-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100/50 transition-colors"
                >
                  <Code2 size={12} />
                  <span>{context.codeLabel || t('chatPanel.docContent')}</span>
                  <ChevronDown size={12} className={`ml-auto transition-transform ${codeExpanded ? '' : '-rotate-90'}`} />
                </button>
                {codeExpanded && (
                  <div className="px-5 pb-3">
                    <pre className="text-[11px] text-slate-600 bg-slate-100/80 border border-slate-200/60 rounded-lg p-3 overflow-auto max-h-52 font-mono leading-relaxed whitespace-pre-wrap break-words scrollbar-light">
                      {context.code}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── 对话区域 ── */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 min-h-0 scrollbar-light">
          {/* 空状态 */}
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div className={`w-14 h-14 rounded-2xl ${theme.emptyIconBg} border flex items-center justify-center mb-4`}>
                {emptyIcon || (
                  <svg className={theme.emptyIconColor} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                    <path d="M5 3v4" /><path d="M19 17v4" /><path d="M3 5h4" /><path d="M17 19h4" />
                  </svg>
                )}
              </div>
              <h4 className="text-sm font-bold text-slate-700 mb-1">{emptyTitle}</h4>
              <p className="text-xs text-slate-400 max-w-sm leading-relaxed mb-4">{emptyDescription}</p>
              {suggestions && suggestions.length > 0 && (
                <div className="flex flex-wrap gap-2 justify-center">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleSuggestion(s)}
                      className={`text-[11px] px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 ${theme.suggestionHover} transition-colors border border-transparent`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 消息列表 */}
          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[95%] ${
                msg.role === 'user'
                  ? `${theme.userBubble} text-white rounded-2xl rounded-tr-md px-4 py-2.5`
                  : msg.role === 'system'
                    ? 'bg-slate-50 border border-slate-200 text-slate-600 rounded-2xl px-4 py-2.5 w-full'
                    : 'bg-white border border-slate-200 rounded-2xl rounded-tl-md px-4 py-3 shadow-sm w-full'
              }`}>
                {/* assistant 消息头 */}
                {msg.role === 'assistant' && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <Brain size={14} className={theme.assistantIcon} />
                    <span className={`text-[11px] font-bold ${theme.assistantLabel}`}>{assistantName}</span>
                  </div>
                )}

                {/* 消息文本 */}
                <p className={`text-xs leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user' ? '' : msg.role === 'system' ? 'text-slate-500' : 'text-slate-700'
                }`}>
                  {msg.content}
                </p>

                {/* 业务扩展渲染 */}
                {renderMessageExtra?.(msg)}
              </div>
            </div>
          ))}

          {/* Loading */}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-md px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className={`animate-spin ${theme.loadingIcon}`} />
                  <span className="text-xs text-slate-500">{loadingText}</span>
                </div>
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* ── 操作栏（由业务场景注入） ── */}
        {renderActions?.()}

        {/* ── 子组件插槽 ── */}
        {children}

        {/* ── 输入区域 ── */}
        <div className="px-5 py-3 border-t border-slate-200 bg-white shrink-0">
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={2}
              className={`flex-1 px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 ${theme.focusRing} resize-none placeholder:text-slate-300`}
              disabled={loading || inputDisabled}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading || inputDisabled}
              className={`self-stretch w-10 flex items-center justify-center rounded-xl bg-gradient-to-r ${theme.sendBtn} text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm shrink-0`}
            >
              <Send size={16} />
            </button>
          </div>
          {inputHint && (
            <p className="text-[10px] text-slate-400 mt-1.5">{inputHint}</p>
          )}
        </div>
    </>
  );

  // ── embedded 模式：不渲染 fixed 遮罩，由父组件定位 ──
  if (embedded) {
    return (
      <div className="h-full bg-white flex flex-col">
        {panelContent}
      </div>
    );
  }

  // ── 标准模式：fixed 遮罩 + 右侧面板 ──
  return (
    <div className="fixed inset-0 z-50 flex">
      {/* 遮罩 */}
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      {/* 右侧面板 */}
      <div className={`${widthClass} bg-white shadow-2xl flex flex-col animate-slide-in-right`}>
        {panelContent}
      </div>

      {/* 滑入动画 */}
      <style>{`
        @keyframes slide-in-right {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.25s ease-out;
        }
      `}</style>
    </div>
  );
};

export default ChatPanel;
