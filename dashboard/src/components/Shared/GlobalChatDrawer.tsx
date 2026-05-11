import React, { useState, useCallback, useEffect, useRef, createContext, useContext } from 'react';
import { MessageSquare, X, Send, Brain, Loader2, Check, RotateCcw, ChevronRight, ArrowRight, Sparkles, Plus, X as XIcon } from 'lucide-react';
import MarkdownWithHighlight from './MarkdownWithHighlight';
import api from '../../api';
import { notify } from '../../utils/notification';
import { KnowledgeEntry } from '../../types';
import { useChatTopics, type ChatMessage } from '../../hooks/useChatTopics';
import { createStreamEventHandler } from '../../hooks/useChatStream';
import { useI18n } from '../../i18n';
import { getErrorMessage, isAbortError } from '../../utils/error';

/* ═══════════════════════════════════════════════════════════
 * GlobalChatDrawer — 常驻 AI Chat（同层内联面板）
 *
 * 布局方式：
 *   App.tsx 中 flex 并列: <Sidebar> | <main> | <GlobalChatPanel>
 *   打开时 main 被压缩，ChatPanel 同层占位，不覆盖任何内容
 *
 * 通过 GlobalChatContext 提供全局 API:
 *   - openChat()        — 打开通用对话
 *   - openRefine(...)   — 打开润色模式
 *   - close() / toggle()
 *   - isOpen
 * ═══════════════════════════════════════════════════════════ */

// ─── 类型 ────────────────────────────────────────────────

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  diff?: DiffField[];
  preview?: Record<string, any>;
  excludedFields?: string[];
  timestamp: number;
}

interface DiffField {
  field: string;
  label: string;
  before: string;
  after: string;
}

interface RefineContext {
  candidateIds: string[];
  candidates: KnowledgeEntry[];
  currentIdx: number;
  onCandidateUpdated?: (candidateId: string) => void;
}

interface GlobalChatAPI {
  openChat: () => void;
  openRefine: (ctx: {
    candidateIds: string[];
    candidates: KnowledgeEntry[];
    onCandidateUpdated?: (candidateId: string) => void;
  }) => void;
  close: () => void;
  toggle: () => void;
  newTopic: () => void;
  isOpen: boolean;
}

// ─── Context ────────────────────────────────────────────

const GlobalChatContext = createContext<GlobalChatAPI>({
  openChat: () => {},
  openRefine: () => {},
  close: () => {},
  toggle: () => {},
  newTopic: () => {},
  isOpen: false,
});

export const useGlobalChat = () => useContext(GlobalChatContext);

// ─── 工具函数 ────────────────────────────────────────────

const uid = () => Math.random().toString(36).substring(2, 10);

const REFINE_FIELD_DEFS: { key: string; labelKey: string; format?: (v: any) => string }[] = [
  { key: 'description', labelKey: 'globalChat.refineFields.summary' },
  { key: 'pattern', labelKey: 'globalChat.refineFields.code' },
  { key: 'markdown', labelKey: 'globalChat.refineFields.markdown' },
  { key: 'rationale', labelKey: 'globalChat.refineFields.rationale' },
  { key: 'tags', labelKey: 'globalChat.refineFields.tags', format: (v) => (Array.isArray(v) ? v.join(', ') : String(v || '')) },
  { key: 'confidence', labelKey: 'globalChat.refineFields.confidence', format: (v) => String(v ?? '—') },
  { key: 'aiInsight', labelKey: 'globalChat.refineFields.aiInsights' },
  { key: 'agentNotes', labelKey: 'globalChat.refineFields.agentNotes', format: (v) => (Array.isArray(v) ? v.join('\n') : String(v || '')) },
  { key: 'relations', labelKey: 'globalChat.refineFields.relations', format: (v) => JSON.stringify(v || {}, null, 2) },
];

function buildDiffFields(before: Record<string, any>, after: Record<string, any>, t: (key: string) => string): DiffField[] {
  const fields: DiffField[] = [];
  for (const def of REFINE_FIELD_DEFS) {
    const fmt = def.format || ((v: any) => String(v ?? ''));
    const bStr = fmt(before[def.key]);
    const aStr = fmt(after[def.key]);
    if (aStr && aStr !== bStr) {
      fields.push({ field: def.key, label: t(def.labelKey), before: bStr, after: aStr });
    }
  }
  return fields;
}

function extractBefore(cand: KnowledgeEntry): Record<string, unknown> {
  return {
    title: cand.title || '', description: cand.description || '', pattern: cand.content?.pattern || '',
    markdown: cand.content?.markdown || '', rationale: cand.content?.rationale || '',
    tags: cand.tags || [], confidence: cand.reasoning?.confidence ?? 0.6,
    relations: cand.relations || {}, aiInsight: cand.aiInsight || null, agentNotes: cand.agentNotes || null,
  };
}

// ─── DiffView ────────────────────────────────────────────

const DiffView: React.FC<{
  diff: DiffField[];
  excludedFields?: string[];
  onToggleField?: (field: string) => void;
}> = ({ diff, excludedFields = [], onToggleField }) => {
  const { t } = useI18n();
  if (diff.length === 0) return <p className="text-xs text-[var(--fg-muted)] italic py-2">{t('globalChat.diff.noChanges')}</p>;
  return (
    <div className="space-y-2 mt-2">
      {diff.map((d) => {
        const excluded = excludedFields.includes(d.field);
        return (
          <div key={d.field} className={`border rounded-lg overflow-hidden transition-opacity ${excluded ? 'border-[var(--border-default)] opacity-45' : 'border-[var(--border-default)]'}`}>
            <div className={`px-2.5 py-1.5 border-b flex items-center gap-1.5 ${excluded ? 'bg-[var(--bg-subtle)] border-[var(--border-default)]' : 'bg-[var(--bg-subtle)] border-[var(--border-default)]'}`}>
              <ArrowRight size={10} className={excluded ? 'text-[var(--fg-muted)]' : 'text-emerald-500'} />
              <span className={`text-[10px] font-bold flex-1 ${excluded ? 'text-[var(--fg-muted)] line-through' : 'text-[var(--fg-secondary)]'}`}>{d.label}</span>
              {onToggleField && (
                excluded ? (
                  <button
                    onClick={() => onToggleField(d.field)}
                    className="px-2 py-0.5 text-[9px] font-bold rounded-full bg-[var(--bg-subtle)] text-[var(--fg-secondary)] hover:bg-emerald-100 hover:text-emerald-600 transition-colors"
                    title={t('globalChat.diff.excludedRestore')}
                  >
                    {t('globalChat.diff.excludedRestore')}
                  </button>
                ) : (
                  <button
                    onClick={() => onToggleField(d.field)}
                    className="group flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium rounded-full text-[var(--fg-muted)] hover:bg-red-50 hover:text-red-500 transition-colors"
                    title={t('globalChat.diff.exclude')}
                  >
                    <XIcon size={10} className="opacity-60 group-hover:opacity-100" />
                    {t('globalChat.diff.exclude')}
                  </button>
                )
              )}
            </div>
            {!excluded && (
              <>
                <div className="p-2 bg-red-50/30 border-b border-[var(--border-default)]">
                  <div className="text-[9px] font-bold text-red-400 mb-0.5 uppercase">{t('globalChat.diff.before')}</div>
                  <pre className="text-[11px] text-[var(--fg-secondary)] whitespace-pre-wrap break-words max-h-40 overflow-auto font-mono leading-relaxed scrollbar-light">
                    {d.before || <span className="italic text-[var(--fg-muted)]">{t('globalChat.diff.empty')}</span>}
                  </pre>
                </div>
                <div className="p-2 bg-emerald-50/30">
                  <div className="text-[9px] font-bold text-emerald-500 mb-0.5 uppercase">{t('globalChat.diff.after')}</div>
                  <pre className="text-[11px] text-[var(--fg-primary)] whitespace-pre-wrap break-words max-h-40 overflow-auto font-mono leading-relaxed scrollbar-light">
                    {d.after}
                  </pre>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ─── 内部状态 Context（Provider → Panel 传递状态）────────

interface ChatInternalState {
  messages: ChatMsg[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  applying: boolean;
  setApplying: React.Dispatch<React.SetStateAction<boolean>>;
  refineCtx: RefineContext | null;
  setRefineCtx: React.Dispatch<React.SetStateAction<RefineContext | null>>;
  applied: Set<string>;
  setApplied: React.Dispatch<React.SetStateAction<Set<string>>>;
  lastPrompt: string;
  setLastPrompt: React.Dispatch<React.SetStateAction<string>>;
  chatHistoryRef: React.MutableRefObject<{ role: string; content: string }[]>;
  isRefineMode: boolean;
  currentRefineId: string | null;
  currentRefineCandidate: KnowledgeEntry | undefined;
  isBatchRefine: boolean;
  close: () => void;
}

const ChatStateContext = createContext<ChatInternalState>(null!);

/** 供 AiChatView 等外部组件共享聊天内部状态 */
export const useChatState = () => useContext(ChatStateContext);

// ─── Provider（仅管理状态，不渲染面板） ──────────────────

export const GlobalChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  const [refineCtx, setRefineCtx] = useState<RefineContext | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [lastPrompt, setLastPrompt] = useState('');
  const chatHistoryRef = useRef<{ role: string; content: string }[]>([]);

  const isRefineMode = !!refineCtx;
  const currentRefineId = refineCtx ? refineCtx.candidateIds[refineCtx.currentIdx] : null;
  const currentRefineCandidate = refineCtx ? refineCtx.candidates.find(c => c.id === currentRefineId) : undefined;
  const isBatchRefine = refineCtx ? refineCtx.candidateIds.length > 1 : false;

  useEffect(() => {
    if (refineCtx && currentRefineCandidate) {
      setMessages(prev => [...prev, {
        id: uid(), role: 'system',
        content: t('globalChat.system.refinePrefix', { title: currentRefineCandidate.title, description: currentRefineCandidate.description || t('globalChat.system.noDescription') }),
        timestamp: Date.now(),
      }]);
      setLastPrompt('');
    }
  }, [refineCtx?.currentIdx]);

  const openChat = useCallback(() => { setRefineCtx(null); setIsOpen(true); }, []);
  const openRefine = useCallback((ctx: { candidateIds: string[]; candidates: KnowledgeEntry[]; onCandidateUpdated?: (id: string) => void }) => {
    setRefineCtx({ ...ctx, currentIdx: 0 }); setApplied(new Set()); setMessages([]); chatHistoryRef.current = []; setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen(prev => !prev), []);
  const newTopic = useCallback(() => {
    setMessages([]); chatHistoryRef.current = []; setLastPrompt(''); setRefineCtx(null); setApplied(new Set());
  }, []);

  const ctxValue: GlobalChatAPI = { openChat, openRefine, close, toggle, newTopic, isOpen };
  const internalState: ChatInternalState = {
    messages, setMessages, loading, setLoading, applying, setApplying,
    refineCtx, setRefineCtx, applied, setApplied, lastPrompt, setLastPrompt,
    chatHistoryRef, isRefineMode, currentRefineId, currentRefineCandidate, isBatchRefine, close,
  };

  return (
    <GlobalChatContext.Provider value={ctxValue}>
      <ChatStateContext.Provider value={internalState}>
        {children}
      </ChatStateContext.Provider>
    </GlobalChatContext.Provider>
  );
};

// ─── GlobalChatPanel — 内联面板（App.tsx flex 同层） ─────

export const GlobalChatPanel: React.FC = () => {
  const { t, lang } = useI18n();
  const s = useContext(ChatStateContext);
  const {
    messages, setMessages, loading, setLoading, applying, setApplying,
    refineCtx, setRefineCtx, applied, setApplied, lastPrompt, setLastPrompt,
    chatHistoryRef, isRefineMode, currentRefineId, currentRefineCandidate, isBatchRefine, close,
  } = s;

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');

  // ── 话题持久化（润色 & 通用对话共用） ──
  const topicsMgr = useChatTopics();
  const panelTopicIdRef = useRef<string | null>(null);
  const isSwitchingRef = useRef(false);

  // 润色模式进入时自动创建话题
  useEffect(() => {
    if (isRefineMode && currentRefineCandidate) {
      isSwitchingRef.current = true;
      const id = topicsMgr.createTopic(t('globalChat.refineTopicPrefix', { title: currentRefineCandidate.title || t('globalChat.untitled') }));
      panelTopicIdRef.current = id;
      setTimeout(() => { isSwitchingRef.current = false; }, 50);
    }
  }, [refineCtx]);

  // 消息变化时自动保存到当前话题
  useEffect(() => {
    if (isSwitchingRef.current) return;
    if (panelTopicIdRef.current && messages.length > 0) {
      topicsMgr.saveTopic(panelTopicIdRef.current, messages as unknown as ChatMessage[]);
    }
  }, [messages]);

  // 通用对话首次发送时自动创建话题
  const ensurePanelTopic = useCallback(() => {
    if (!panelTopicIdRef.current) {
      isSwitchingRef.current = true;
      const id = topicsMgr.createTopic();
      panelTopicIdRef.current = id;
      setTimeout(() => { isSwitchingRef.current = false; }, 50);
    }
  }, [topicsMgr]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 200); }, []);

  const hasPendingDiff = isRefineMode && currentRefineId
    && messages.some(m => {
      if (m.role !== 'assistant' || !m.diff || m.diff.length === 0) return false;
      // 如果所有 diff 字段都被排除，则没有待应用的变更
      const excluded = m.excludedFields || [];
      return m.diff.some(d => !excluded.includes(d.field));
    })
    && !applied.has(currentRefineId);

  // 切换单个 diff 字段的排除状态
  const handleToggleDiffField = useCallback((msgId: string, field: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m;
      const excluded = m.excludedFields || [];
      const newExcluded = excluded.includes(field)
        ? excluded.filter(f => f !== field)
        : [...excluded, field];
      return { ...m, excludedFields: newExcluded };
    }));
  }, []);

  // 用于中断流式请求
  const abortRef = useRef<AbortController | null>(null);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    // 通用对话首次发送时自动创建话题
    if (!isRefineMode) ensurePanelTopic();

    setInput('');
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text, timestamp: Date.now() }]);
    setLoading(true);

    if (isRefineMode && currentRefineId) {
      // ── 润色模式 — 统一协议 v2 ──
      setLastPrompt(text);
      const assistantId = uid();
      // 插入一个进度消息
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: t('globalChat.system.refining'), timestamp: Date.now() }]);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const result = await api.refinePreviewStream(currentRefineId, text, (evt) => {
          if (evt.type === 'data:progress') {
            // 更新进度提示
            const msg = evt.message || evt.stage || t('globalChat.system.processing');
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: `🔄 ${msg}` } : m));
          }
        }, abort.signal);

        // 完成：用结构化 diff 替换消息
        const before = result.before || (currentRefineCandidate ? extractBefore(currentRefineCandidate) : {});
        const diff = buildDiffFields(before, result.after || {}, t);
        setMessages(prev => prev.map(m => m.id === assistantId ? {
          ...m,
          content: diff.length > 0 ? t('globalChat.previewGenerated', { count: diff.length }) : t('globalChat.noChangeHint'),
          diff: diff.length > 0 ? diff : undefined,
          preview: diff.length > 0 ? result.preview ?? undefined : undefined,
          excludedFields: [],
        } : m));
      } catch (err: unknown) {
        if (isAbortError(err)) {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: t('globalChat.system.cancelled') } : m));
        } else {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: t('globalChat.refinePreviewFailed', { error: getErrorMessage(err) }) } : m));
        }
      } finally {
        abortRef.current = null;
      }
    } else {
      // ── 通用对话 — 统一协议 v2: 状态机驱动 ──
      chatHistoryRef.current.push({ role: 'user', content: text });
      const assistantId = uid();
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: t('globalChat.system.thinking'), timestamp: Date.now() }]);

      const abort = new AbortController();
      abortRef.current = abort;

      const { onEvent, getState } = createStreamEventHandler(assistantId, setMessages, t);
      let answerText = '';

      try {
        const result = await api.chatStream(text, chatHistoryRef.current, (evt) => {
          onEvent(evt);
          answerText = getState().answerText;
        }, abort.signal, lang);

        // 确保最终内容是完整的回答
        const finalText = result.text || answerText;
        chatHistoryRef.current.push({ role: 'model', content: finalText });
        // 最终只保留回答文本
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: finalText } : m));
      } catch (err: unknown) {
        if (isAbortError(err)) {
          const { answerText: partialText, toolLogs } = getState();
          const partial = partialText || (toolLogs.length > 0 ? toolLogs.join('\n') + '\n\n' + t('globalChat.system.cancelled') : t('globalChat.system.cancelled'));
          if (partialText) chatHistoryRef.current.push({ role: 'model', content: partialText });
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: partial } : m));
        } else {
          setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: t('globalChat.requestFailed', { error: getErrorMessage(err) }) } : m));
        }
      } finally {
        abortRef.current = null;
      }
    }
    setLoading(false);
  }, [input, loading, isRefineMode, currentRefineId, currentRefineCandidate, ensurePanelTopic]);

  const handleRefineAccept = useCallback(async () => {
    if (applying || !currentRefineId || !refineCtx) return;
    setApplying(true);
    try {
      // 从最后一条带 preview 的 assistant 消息中取出预览数据，直接应用而非重调 AI
      const lastMsg = [...messages].reverse().find(m => m.role === 'assistant' && m.preview);
      let filteredPreview = lastMsg?.preview;
      // 如果有排除的字段，将其恢复为 before 值，使后端 diff 不检测到变化
      if (filteredPreview && lastMsg?.excludedFields?.length && lastMsg.diff) {
        filteredPreview = { ...filteredPreview };
        const beforeData = currentRefineCandidate ? extractBefore(currentRefineCandidate) : {};
        for (const field of lastMsg.excludedFields) {
          if (field in beforeData) {
            (filteredPreview as Record<string, unknown>)[field] = (beforeData as Record<string, unknown>)[field];
          }
        }
      }
      await api.refineApply(currentRefineId, lastPrompt, filteredPreview);
      setApplied(prev => new Set(prev).add(currentRefineId));
      refineCtx.onCandidateUpdated?.(currentRefineId);
      setMessages(prev => [...prev, { id: uid(), role: 'system', content: t('globalChat.system.changesApplied'), timestamp: Date.now() }]);
      notify(t('globalChat.applySuccess'), { title: t('globalChat.applySuccessTitle') });
    } catch (err: unknown) {
      notify(getErrorMessage(err), { title: t('globalChat.applyFailed'), type: 'error' });
    } finally { setApplying(false); }
  }, [applying, currentRefineId, lastPrompt, refineCtx]);

  const handleRefineNext = useCallback(() => {
    if (!refineCtx || refineCtx.currentIdx >= refineCtx.candidateIds.length - 1) return;
    setRefineCtx(prev => prev ? { ...prev, currentIdx: prev.currentIdx + 1 } : null);
  }, [refineCtx]);

  const handleExitRefine = useCallback(() => {
    panelTopicIdRef.current = null;
    setRefineCtx(null);
    setMessages(prev => [...prev, { id: uid(), role: 'system', content: t('globalChat.system.exitedRefine'), timestamp: Date.now() }]);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  return (
    <aside className="w-[420px] h-full bg-[var(--bg-surface)] border-l border-[var(--border-default)] flex flex-col shrink-0">
      {/* Header */}
      <div className="px-4 h-[var(--topbar-height)] border-b border-[var(--border-default)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 flex items-center justify-center">
            {isRefineMode ? <Sparkles className="text-emerald-500" size={16} /> : <MessageSquare className="text-blue-600" size={16} />}
          </div>
          <div>
            <h3 className="text-[13px] font-bold text-[var(--fg-primary)] flex items-center gap-2">
              {isRefineMode ? t('globalChat.refineTitle') : t('globalChat.chatTitle')}
              {isRefineMode && isBatchRefine && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-medium">
                  {(refineCtx?.currentIdx ?? 0) + 1}/{refineCtx?.candidateIds.length}
                </span>
              )}
            </h3>
            <p className="text-[10px] text-[var(--fg-muted)] truncate max-w-[250px]">
              {isRefineMode ? currentRefineCandidate?.title || t('globalChat.refineSubtitle') : t('globalChat.chatSubtitle')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {isRefineMode && (
            <button onClick={handleExitRefine} className="px-2 py-1 text-[10px] font-medium text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-subtle)] rounded-md transition-colors">{t('globalChat.exitRefine')}</button>
          )}
          {!isRefineMode && messages.length > 0 && (
            <button onClick={() => { panelTopicIdRef.current = null; setMessages([]); chatHistoryRef.current = []; setLastPrompt(''); }}
              className="p-1.5 hover:bg-[var(--bg-subtle)] rounded-lg transition-colors" title={t('globalChat.newTopic')}>
              <Plus size={16} className="text-[var(--fg-muted)]" />
            </button>
          )}
          <button onClick={close} className="p-1.5 hover:bg-[var(--bg-subtle)] rounded-lg transition-colors" title={t('globalChat.closeChat')}>
            <X size={16} className="text-[var(--fg-muted)]" />
          </button>
        </div>
      </div>

      {/* 润色上下文卡片 */}
      {isRefineMode && currentRefineCandidate && (
        <div className="border-b border-[var(--border-default)] bg-emerald-50/30 px-4 py-2 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-emerald-700 truncate flex-1">{currentRefineCandidate.title}</span>
            {currentRefineCandidate.language && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100">{currentRefineCandidate.language}</span>
            )}
          </div>
        </div>
      )}

      {/* 消息区域 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0 scrollbar-light">
        {messages.length === 0 && !isRefineMode && (
          <div className="flex flex-col items-center justify-center h-full text-center py-10">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-3">
              <MessageSquare className="text-blue-500" size={20} />
            </div>
            <h4 className="text-sm font-bold text-[var(--fg-primary)] mb-1">{t('globalChat.emptyTitle')}</h4>
            <p className="text-xs text-[var(--fg-muted)] max-w-[280px] leading-relaxed mb-3">{t('globalChat.emptyDesc')}</p>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {[t('globalChat.quickPrompts.analyzeArch'), t('globalChat.quickPrompts.findDuplicates'), t('globalChat.quickPrompts.suggestOptimize')].map(p => (
                <button key={p} onClick={() => { setInput(p); inputRef.current?.focus(); }}
                  className="text-[10px] px-2.5 py-1 rounded-md bg-[var(--bg-subtle)] text-[var(--fg-secondary)] hover:bg-blue-50 hover:text-blue-700 transition-colors">{p}</button>
              ))}
            </div>
          </div>
        )}

        {/* 润色模式预设指令建议 */}
        {isRefineMode && messages.length <= 1 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {[
              t('globalChat.refinePrompts.addExamples'),
              t('globalChat.refinePrompts.optimizeComments'),
              t('globalChat.refinePrompts.addCaveats'),
              t('globalChat.refinePrompts.improveSummary'),
              t('globalChat.refinePrompts.addPerformance'),
            ].map(p => (
              <button key={p} onClick={() => { setInput(p); inputRef.current?.focus(); }}
                className="text-[10px] px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors">
                {p}
              </button>
            ))}
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[95%] ${
              msg.role === 'user' ? 'bg-blue-600 text-white rounded-2xl rounded-tr-md px-3.5 py-2'
                : msg.role === 'system' ? 'bg-[var(--bg-subtle)] border border-[var(--border-default)] text-[var(--fg-secondary)] rounded-2xl px-3.5 py-2 w-full'
                : 'bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl rounded-tl-md px-3.5 py-2.5 shadow-sm w-full'
            }`}>
              {msg.role === 'assistant' && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Brain size={12} className={isRefineMode ? 'text-emerald-500' : 'text-blue-500'} />
                  <span className={`text-[10px] font-bold ${isRefineMode ? 'text-emerald-600' : 'text-blue-600'}`}>
                    {isRefineMode ? t('globalChat.assistantRefine') : t('globalChat.assistantChat')}
                  </span>
                </div>
              )}
              {msg.role === 'assistant' && !msg.diff ? (
                <MarkdownWithHighlight content={msg.content} className="text-xs text-[var(--fg-primary)]" />
              ) : (
                <p className={`text-xs leading-relaxed whitespace-pre-wrap ${msg.role === 'user' ? '' : msg.role === 'system' ? 'text-[var(--fg-secondary)]' : 'text-[var(--fg-primary)]'}`}>{msg.content}</p>
              )}
              {msg.diff && msg.diff.length > 0 && (
                <DiffView
                  diff={msg.diff}
                  excludedFields={msg.excludedFields}
                  onToggleField={isRefineMode && !applied.has(currentRefineId!) ? (field) => handleToggleDiffField(msg.id, field) : undefined}
                />
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl rounded-tl-md px-3.5 py-2.5 shadow-sm">
              <div className="flex items-center gap-2">
                <Loader2 size={12} className={`animate-spin ${isRefineMode ? 'text-emerald-500' : 'text-blue-500'}`} />
                <span className="text-xs text-[var(--fg-secondary)]">{isRefineMode ? t('globalChat.loading.analyzing') : t('globalChat.loading.thinking')}</span>
                {abortRef.current && (
                  <button onClick={() => abortRef.current?.abort()}
                    className="ml-1 px-1.5 py-0.5 text-[10px] font-bold text-red-500 border border-red-200 rounded hover:bg-red-50 transition-colors">
                    {t('globalChat.stopBtn')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* 润色操作栏 */}
      {isRefineMode && hasPendingDiff && !loading && (() => {
        const lastDiffMsg = [...messages].reverse().find(m => m.role === 'assistant' && m.diff && m.diff.length > 0);
        const totalFields = lastDiffMsg?.diff?.length || 0;
        const excludedCount = lastDiffMsg?.excludedFields?.length || 0;
        const activeCount = totalFields - excludedCount;
        return (
        <div className="px-4 py-2 border-t border-[var(--border-default)] bg-emerald-50/50 flex items-center gap-2 shrink-0">
          <button onClick={handleRefineAccept} disabled={applying}
            className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-white bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 rounded-lg shadow-sm disabled:opacity-50">
            {applying ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
            {applying ? t('globalChat.applyingBtn') : excludedCount > 0 ? t('globalChat.confirmApplyN', { i: activeCount, total: totalFields }) : t('globalChat.confirmApply')}
          </button>
          <button className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] rounded-lg hover:bg-[var(--bg-subtle)] transition-colors">
            <RotateCcw size={11} /> {t('globalChat.continueAdjust')}
          </button>
          {isBatchRefine && applied.has(currentRefineId!) && refineCtx!.currentIdx < refineCtx!.candidateIds.length - 1 && (
            <button onClick={handleRefineNext} className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-blue-600 hover:text-blue-700 rounded-lg hover:bg-blue-50 transition-colors ml-auto">
              {t('globalChat.nextItem')} <ChevronRight size={11} />
            </button>
          )}
        </div>
        );
      })()}

      {isRefineMode && !hasPendingDiff && !loading && isBatchRefine
        && applied.has(currentRefineId!) && refineCtx!.currentIdx < refineCtx!.candidateIds.length - 1 && (
        <div className="px-4 py-2 border-t border-[var(--border-default)] flex items-center justify-center shrink-0">
          <button onClick={handleRefineNext}
            className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-blue-600 hover:text-blue-700 rounded-lg bg-blue-50 hover:bg-blue-100 transition-colors">
            {t('globalChat.nextItem')} ({(refineCtx?.currentIdx ?? 0) + 2}/{refineCtx?.candidateIds.length}) <ChevronRight size={12} />
          </button>
        </div>
      )}

      {/* 输入区域 */}
      <div className="px-4 py-2.5 border-t border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0">
        <div className="flex gap-2">
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder={isRefineMode ? t('globalChat.refinePlaceholder') : t('globalChat.chatPlaceholder')} rows={2}
            className={`flex-1 px-3 py-2 text-sm border border-[var(--border-default)] rounded-xl focus:outline-none focus:ring-2 ${
              isRefineMode ? 'focus:ring-emerald-200 focus:border-emerald-400' : 'focus:ring-blue-200 focus:border-blue-400'
            } resize-none placeholder:text-[var(--fg-muted)]`}
            disabled={loading || applying} />
          <button onClick={handleSend} disabled={!input.trim() || loading || applying}
            className={`self-stretch w-9 flex items-center justify-center rounded-xl bg-gradient-to-r ${
              isRefineMode ? 'from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700'
                : 'from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700'
            } text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm shrink-0`}>
            <Send size={14} />
          </button>
        </div>
        <p className="text-[9px] text-[var(--fg-muted)] mt-1">
          {isRefineMode ? t('globalChat.inputHintRefine') : t('globalChat.inputHintChat')}
        </p>
      </div>
    </aside>
  );
};

export default GlobalChatProvider;
