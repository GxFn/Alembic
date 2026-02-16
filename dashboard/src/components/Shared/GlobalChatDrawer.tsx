import React, { useState, useCallback, useEffect, useRef, createContext, useContext } from 'react';
import { MessageSquare, X, Send, Brain, Loader2, Check, RotateCcw, ChevronRight, ArrowRight, Sparkles, Plus } from 'lucide-react';
import MarkdownWithHighlight from './MarkdownWithHighlight';
import api from '../../api';
import { notify } from '../../utils/notification';
import { KnowledgeEntry } from '../../types';
import { useChatTopics, type ChatMessage } from '../../hooks/useChatTopics';

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

const REFINE_FIELD_DEFS: { key: string; label: string; format?: (v: any) => string }[] = [
  { key: 'summary_cn', label: '摘要' },
  { key: 'pattern', label: '内容文档' },
  { key: 'tags', label: '标签', format: (v) => (Array.isArray(v) ? v.join(', ') : String(v || '')) },
  { key: 'confidence', label: '置信度', format: (v) => String(v ?? '—') },
  { key: 'ai_insight', label: 'AI 洞察' },
  { key: 'agent_notes', label: 'Agent 笔记', format: (v) => (Array.isArray(v) ? v.join('\n') : String(v || '')) },
  { key: 'relations', label: '关联关系', format: (v) => JSON.stringify(v || {}, null, 2) },
];

function buildDiffFields(before: Record<string, any>, after: Record<string, any>): DiffField[] {
  const fields: DiffField[] = [];
  for (const def of REFINE_FIELD_DEFS) {
    const fmt = def.format || ((v: any) => String(v ?? ''));
    const bStr = fmt(before[def.key]);
    const aStr = fmt(after[def.key]);
    if (aStr && aStr !== bStr) {
      fields.push({ field: def.key, label: def.label, before: bStr, after: aStr });
    }
  }
  return fields;
}

function extractBefore(cand: KnowledgeEntry): Record<string, any> {
  return {
    title: cand.title || '', summary_cn: cand.summary_cn || '', pattern: cand.content?.pattern || '',
    tags: cand.tags || [], confidence: cand.reasoning?.confidence ?? 0.6,
    relations: cand.relations || {}, ai_insight: cand.ai_insight || null, agent_notes: cand.agent_notes || null,
  };
}

// ─── DiffView ────────────────────────────────────────────

const DiffView: React.FC<{ diff: DiffField[] }> = ({ diff }) => {
  if (diff.length === 0) return <p className="text-xs text-slate-400 italic py-2">未检测到变更</p>;
  return (
    <div className="space-y-2 mt-2">
      {diff.map((d) => (
        <div key={d.field} className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-2.5 py-1 bg-slate-50 border-b border-slate-200 flex items-center gap-1.5">
            <ArrowRight size={10} className="text-emerald-500" />
            <span className="text-[10px] font-bold text-slate-600">{d.label}</span>
          </div>
          <div className="p-2 bg-red-50/30 border-b border-slate-200">
            <div className="text-[9px] font-bold text-red-400 mb-0.5 uppercase">Before</div>
            <pre className="text-[11px] text-slate-600 whitespace-pre-wrap break-words max-h-40 overflow-auto font-mono leading-relaxed scrollbar-light">
              {d.before || <span className="italic text-slate-300">（空）</span>}
            </pre>
          </div>
          <div className="p-2 bg-emerald-50/30">
            <div className="text-[9px] font-bold text-emerald-500 mb-0.5 uppercase">After</div>
            <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words max-h-40 overflow-auto font-mono leading-relaxed scrollbar-light">
              {d.after}
            </pre>
          </div>
        </div>
      ))}
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
        content: `🎯 润色模式 — **${currentRefineCandidate.title}**\n\n当前摘要: ${currentRefineCandidate.summary_cn || '(无)'}\n\n**输入润色指令，AI 将根据你的指令定向修改候选内容**，下方有常用指令可直接点击使用。`,
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
      const id = topicsMgr.createTopic(`润色: ${currentRefineCandidate.title || '未命名'}`);
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
    && messages.some(m => m.role === 'assistant' && m.diff && m.diff.length > 0)
    && !applied.has(currentRefineId);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    // 通用对话首次发送时自动创建话题
    if (!isRefineMode) ensurePanelTopic();

    setInput('');
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text, timestamp: Date.now() }]);
    setLoading(true);

    if (isRefineMode && currentRefineId) {
      setLastPrompt(text);
      try {
        const result = await api.refinePreview(currentRefineId, text);
        const before = result.before || (currentRefineCandidate ? extractBefore(currentRefineCandidate) : {});
        const diff = buildDiffFields(before, result.after || {});
        setMessages(prev => [...prev, {
          id: uid(), role: 'assistant',
          content: diff.length > 0 ? `已生成润色预览，共 ${diff.length} 个字段变更：` : '未检测到变更，请尝试更具体的指令。',
          diff: diff.length > 0 ? diff : undefined, preview: diff.length > 0 ? result.preview : undefined,
          timestamp: Date.now(),
        }]);
      } catch (err: any) {
        setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: `润色预览失败: ${err.response?.data?.error || err.message}`, timestamp: Date.now() }]);
      }
    } else {
      chatHistoryRef.current.push({ role: 'user', content: text });
      try {
        const result = await api.chat(text, chatHistoryRef.current);
        chatHistoryRef.current.push({ role: 'model', content: result.text });
        setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: result.text, timestamp: Date.now() }]);
      } catch (err: any) {
        setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: `请求失败: ${err.message}`, timestamp: Date.now() }]);
      }
    }
    setLoading(false);
  }, [input, loading, isRefineMode, currentRefineId, currentRefineCandidate, ensurePanelTopic]);

  const handleRefineAccept = useCallback(async () => {
    if (applying || !currentRefineId || !refineCtx) return;
    setApplying(true);
    try {
      await api.refineApply(currentRefineId, lastPrompt);
      setApplied(prev => new Set(prev).add(currentRefineId));
      refineCtx.onCandidateUpdated?.(currentRefineId);
      setMessages(prev => [...prev, { id: uid(), role: 'system', content: '✅ 变更已应用到候选！', timestamp: Date.now() }]);
      notify('候选内容已更新为润色后版本', { title: '润色已应用' });
    } catch (err: any) {
      notify(err.response?.data?.error || err.message, { title: '应用失败', type: 'error' });
    } finally { setApplying(false); }
  }, [applying, currentRefineId, lastPrompt, refineCtx]);

  const handleRefineNext = useCallback(() => {
    if (!refineCtx || refineCtx.currentIdx >= refineCtx.candidateIds.length - 1) return;
    setRefineCtx(prev => prev ? { ...prev, currentIdx: prev.currentIdx + 1 } : null);
  }, [refineCtx]);

  const handleExitRefine = useCallback(() => {
    panelTopicIdRef.current = null;
    setRefineCtx(null);
    setMessages(prev => [...prev, { id: uid(), role: 'system', content: '已退出润色模式，回到通用对话。', timestamp: Date.now() }]);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  return (
    <aside className="w-[420px] h-full bg-white border-l border-slate-200 flex flex-col shrink-0">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 flex items-center justify-center">
            {isRefineMode ? <Sparkles className="text-emerald-500" size={16} /> : <MessageSquare className="text-blue-600" size={16} />}
          </div>
          <div>
            <h3 className="text-[13px] font-bold text-slate-800 flex items-center gap-2">
              {isRefineMode ? 'AI 润色' : 'AI Chat'}
              {isRefineMode && isBatchRefine && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 font-medium">
                  {(refineCtx?.currentIdx ?? 0) + 1}/{refineCtx?.candidateIds.length}
                </span>
              )}
            </h3>
            <p className="text-[10px] text-slate-400 truncate max-w-[250px]">
              {isRefineMode ? currentRefineCandidate?.title || '润色中...' : '询问任何关于项目的问题'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {isRefineMode && (
            <button onClick={handleExitRefine} className="px-2 py-1 text-[10px] font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors">退出润色</button>
          )}
          {!isRefineMode && messages.length > 0 && (
            <button onClick={() => { panelTopicIdRef.current = null; setMessages([]); chatHistoryRef.current = []; setLastPrompt(''); }}
              className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors" title="开启新话题">
              <Plus size={16} className="text-slate-400" />
            </button>
          )}
          <button onClick={close} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors" title="关闭 AI Chat">
            <X size={16} className="text-slate-400" />
          </button>
        </div>
      </div>

      {/* 润色上下文卡片 */}
      {isRefineMode && currentRefineCandidate && (
        <div className="border-b border-slate-100 bg-emerald-50/30 px-4 py-2 shrink-0">
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
            <h4 className="text-sm font-bold text-slate-700 mb-1">AI Chat</h4>
            <p className="text-xs text-slate-400 max-w-[280px] leading-relaxed mb-3">询问项目相关问题，或使用 AI 功能分析代码、润色候选等。</p>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {['分析项目架构', '查找重复代码', '推荐优化方向'].map(t => (
                <button key={t} onClick={() => { setInput(t); inputRef.current?.focus(); }}
                  className="text-[10px] px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-700 transition-colors">{t}</button>
              ))}
            </div>
          </div>
        )}

        {/* 润色模式预设指令建议 */}
        {isRefineMode && messages.length <= 1 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {[
              '增加具体使用案例，不要修改其他内容',
              '优化代码注释和说明',
              '补充常见错误用法和注意事项',
              '提升摘要质量，更简洁专业',
              '补充性能注意事项',
            ].map(t => (
              <button key={t} onClick={() => { setInput(t); inputRef.current?.focus(); }}
                className="text-[10px] px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors">
                {t}
              </button>
            ))}
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[95%] ${
              msg.role === 'user' ? 'bg-blue-600 text-white rounded-2xl rounded-tr-md px-3.5 py-2'
                : msg.role === 'system' ? 'bg-slate-50 border border-slate-200 text-slate-600 rounded-2xl px-3.5 py-2 w-full'
                : 'bg-white border border-slate-200 rounded-2xl rounded-tl-md px-3.5 py-2.5 shadow-sm w-full'
            }`}>
              {msg.role === 'assistant' && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Brain size={12} className={isRefineMode ? 'text-emerald-500' : 'text-blue-500'} />
                  <span className={`text-[10px] font-bold ${isRefineMode ? 'text-emerald-600' : 'text-blue-600'}`}>
                    {isRefineMode ? 'AI 润色助手' : 'AI 助手'}
                  </span>
                </div>
              )}
              {msg.role === 'assistant' && !msg.diff ? (
                <MarkdownWithHighlight content={msg.content} className="text-xs text-slate-700" />
              ) : (
                <p className={`text-xs leading-relaxed whitespace-pre-wrap ${msg.role === 'user' ? '' : msg.role === 'system' ? 'text-slate-500' : 'text-slate-700'}`}>{msg.content}</p>
              )}
              {msg.diff && msg.diff.length > 0 && <DiffView diff={msg.diff} />}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-md px-3.5 py-2.5 shadow-sm">
              <div className="flex items-center gap-2">
                <Loader2 size={12} className={`animate-spin ${isRefineMode ? 'text-emerald-500' : 'text-blue-500'}`} />
                <span className="text-xs text-slate-500">{isRefineMode ? 'AI 正在分析...' : 'AI 思考中...'}</span>
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* 润色操作栏 */}
      {isRefineMode && hasPendingDiff && !loading && (
        <div className="px-4 py-2 border-t border-slate-100 bg-emerald-50/50 flex items-center gap-2 shrink-0">
          <button onClick={handleRefineAccept} disabled={applying}
            className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-white bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 rounded-lg shadow-sm disabled:opacity-50">
            {applying ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
            {applying ? '应用中...' : '确认应用'}
          </button>
          <button className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-slate-500 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors">
            <RotateCcw size={11} /> 继续调整
          </button>
          {isBatchRefine && applied.has(currentRefineId!) && refineCtx!.currentIdx < refineCtx!.candidateIds.length - 1 && (
            <button onClick={handleRefineNext} className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-blue-600 hover:text-blue-700 rounded-lg hover:bg-blue-50 transition-colors ml-auto">
              下一条 <ChevronRight size={11} />
            </button>
          )}
        </div>
      )}

      {isRefineMode && !hasPendingDiff && !loading && isBatchRefine
        && applied.has(currentRefineId!) && refineCtx!.currentIdx < refineCtx!.candidateIds.length - 1 && (
        <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-center shrink-0">
          <button onClick={handleRefineNext}
            className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold text-blue-600 hover:text-blue-700 rounded-lg bg-blue-50 hover:bg-blue-100 transition-colors">
            下一条 ({(refineCtx?.currentIdx ?? 0) + 2}/{refineCtx?.candidateIds.length}) <ChevronRight size={12} />
          </button>
        </div>
      )}

      {/* 输入区域 */}
      <div className="px-4 py-2.5 border-t border-slate-200 bg-white shrink-0">
        <div className="flex gap-2">
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder={isRefineMode ? '输入定向润色指令，如"增加使用案例"、"优化摘要"...' : '输入你的问题...'} rows={2}
            className={`flex-1 px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 ${
              isRefineMode ? 'focus:ring-emerald-200 focus:border-emerald-400' : 'focus:ring-blue-200 focus:border-blue-400'
            } resize-none placeholder:text-slate-300`}
            disabled={loading || applying} />
          <button onClick={handleSend} disabled={!input.trim() || loading || applying}
            className={`self-stretch w-9 flex items-center justify-center rounded-xl bg-gradient-to-r ${
              isRefineMode ? 'from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700'
                : 'from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700'
            } text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm shrink-0`}>
            <Send size={14} />
          </button>
        </div>
        <p className="text-[9px] text-slate-400 mt-1">
          {isRefineMode ? 'Enter 发送 · Shift+Enter 换行 · 先预览再应用' : 'Enter 发送 · Shift+Enter 换行'}
        </p>
      </div>
    </aside>
  );
};

export default GlobalChatProvider;
