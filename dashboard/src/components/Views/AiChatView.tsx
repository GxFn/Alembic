import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MessageSquare, Send, Brain, Loader2, Plus, Sparkles, ArrowRight, Trash2, Clock, ChevronLeft, ChevronRight as ChevronRightIcon } from 'lucide-react';
import MarkdownWithHighlight from '../Shared/MarkdownWithHighlight';
import { useGlobalChat } from '../Shared/GlobalChatDrawer';
import { useChatTopics, ChatMessage } from '../../hooks/useChatTopics';
import { createStreamEventHandler } from '../../hooks/useChatStream';
import { useI18n } from '../../i18n';
import api from '../../api';

/* ═══════════════════════════════════════════════════════════
 * AiChatView — /ai 页面的全屏 AI 聊天界面
 *
 * 左侧: 话题列表（localStorage 持久化，支持新建/切换/删除）
 * 右侧: 聊天对话区域
 * ═══════════════════════════════════════════════════════════ */

const uid = () => Math.random().toString(36).substring(2, 10);

/** Diff 字段视图 */
const DiffFieldView: React.FC<{ d: { field: string; label: string; before: string; after: string } }> = ({ d }) => {
  const { t } = useI18n();
  return (
  <div className="border border-[var(--border-default)] rounded-lg overflow-hidden">
    <div className="px-2.5 py-1 bg-[var(--bg-subtle)] border-b border-[var(--border-default)] flex items-center gap-1.5">
      <ArrowRight size={10} className="text-emerald-500" />
      <span className="text-[10px] font-bold text-[var(--fg-secondary)]">{d.label}</span>
    </div>
    <div className="p-2.5 bg-red-50/30 border-b border-[var(--border-default)]">
      <div className="text-[9px] font-bold text-red-400 mb-0.5 uppercase">{t('aiChat.diffBefore')}</div>
      <pre className="text-[11px] text-[var(--fg-secondary)] whitespace-pre-wrap break-words max-h-48 overflow-auto font-mono leading-relaxed scrollbar-light">
        {d.before || <span className="italic text-[var(--fg-muted)]">{t('aiChat.diffEmpty')}</span>}
      </pre>
    </div>
    <div className="p-2.5 bg-emerald-50/30">
      <div className="text-[9px] font-bold text-emerald-500 mb-0.5 uppercase">{t('aiChat.diffAfter')}</div>
      <pre className="text-[11px] text-[var(--fg-primary)] whitespace-pre-wrap break-words max-h-48 overflow-auto font-mono leading-relaxed scrollbar-light">
        {d.after}
      </pre>
    </div>
  </div>
  );
};

/** 格式化时间 */
function formatTopicTime(ts: number, t: (key: string, vars?: Record<string, any>) => string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('aiChat.timeJustNow');
  if (diffMin < 60) return t('aiChat.timeMinutesAgo', { n: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('aiChat.timeHoursAgo', { n: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return t('aiChat.timeDaysAgo', { n: diffDay });
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

const AiChatView: React.FC = () => {
  const { t, lang } = useI18n();
  // ── 独立本地状态（不与 GlobalChatDrawer 共享） ──
  const { close, isOpen } = useGlobalChat();
  const [messages, setMessages] = useState<Array<{ id: string; role: string; content: string; diff?: any[]; timestamp: number }>>([]);
  const [loading, setLoading] = useState(false);
  const chatHistoryRef = useRef<{ role: string; content: string }[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const topicsMgr = useChatTopics();
  const { topics, activeTopicId, activeTopic, createTopic, deleteTopic, saveTopic, switchTopic } = topicsMgr;

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 用于跟踪是否正在执行话题切换（防止保存覆盖）
  const isSwitchingRef = useRef(false);

  // 侧边 panel 在 /ai 全屏模式下自动关闭（仅挂载时运行一次）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isOpen) close(); }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 200); }, []);

  // 消息变化时自动保存到当前话题（仅当有消息且有活跃话题时）
  useEffect(() => {
    if (isSwitchingRef.current) return;
    if (activeTopicId && messages.length > 0) {
      saveTopic(activeTopicId, messages as ChatMessage[]);
    }
  }, [messages, activeTopicId, saveTopic]);

  /** 新建话题 */
  const handleNewTopic = useCallback(() => {
    isSwitchingRef.current = true;
    createTopic();
    setMessages([]);
    chatHistoryRef.current = [];
    // 恢复保存
    setTimeout(() => { isSwitchingRef.current = false; }, 50);
  }, [createTopic, setMessages, chatHistoryRef]);

  /** 切换到指定话题 */
  const handleSwitchTopic = useCallback((id: string) => {
    if (id === activeTopicId) return;
    isSwitchingRef.current = true;
    switchTopic(id);
    const topic = topicsMgr.getTopic(id);
    if (topic) {
      setMessages(topic.messages);
      // 重建 chatHistoryRef
      chatHistoryRef.current = topic.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : m.role, content: m.content }));
    } else {
      setMessages([]);
      chatHistoryRef.current = [];
    }
    setTimeout(() => { isSwitchingRef.current = false; }, 50);
  }, [activeTopicId, switchTopic, topicsMgr, setMessages, chatHistoryRef]);

  /** 删除话题 */
  const handleDeleteTopic = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteTopic(id);
    if (id === activeTopicId) {
      isSwitchingRef.current = true;
      setMessages([]);
      chatHistoryRef.current = [];
      setTimeout(() => { isSwitchingRef.current = false; }, 50);
    }
  }, [deleteTopic, activeTopicId, setMessages, chatHistoryRef]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    // 如果没有活跃话题，自动创建一个
    let topicId = activeTopicId;
    if (!topicId) {
      isSwitchingRef.current = true;
      topicId = createTopic();
      setTimeout(() => { isSwitchingRef.current = false; }, 50);
    }

    setInput('');
    setMessages(prev => [...prev, { id: uid(), role: 'user', content: text, timestamp: Date.now() }]);
    setLoading(true);

    const assistantId = uid();
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: `🔄 ${t('aiChat.thinking')}`, timestamp: Date.now() }]);
    chatHistoryRef.current.push({ role: 'user', content: text });

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const { onEvent, getState } = createStreamEventHandler(assistantId, setMessages, t);
      const result = await api.chatStream(text, chatHistoryRef.current, (evt) => {
        onEvent(evt);
      }, abort.signal, lang);

      const finalText = result.text || getState().answerText;
      chatHistoryRef.current.push({ role: 'model', content: finalText });
      setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: finalText } : m));
    } catch (err: any) {
      if (err.name === 'AbortError') {
        const partial = t('aiChat.cancelled');
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: partial } : m));
      } else {
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: t('aiChat.requestFailed', { error: err.message }) } : m));
      }
    } finally {
      abortRef.current = null;
    }
    setLoading(false);
  }, [input, loading, activeTopicId, createTopic, t, lang]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  return (
    <div className="flex-1 flex h-full bg-[var(--bg-subtle)]">
      {/* ═══ 左侧话题列表 ═══ */}
      <div className={`${sidebarCollapsed ? 'w-10' : 'w-64'} shrink-0 bg-[var(--bg-surface)] border-r border-[var(--border-default)] flex flex-col transition-all duration-200`}>
        {sidebarCollapsed ? (
          /* 折叠状态 */
          <div className="flex flex-col items-center py-3 gap-2">
            <button onClick={() => setSidebarCollapsed(false)}
              className="p-1.5 hover:bg-[var(--bg-subtle)] rounded-lg transition-colors text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]" title={t('aiChat.expandTopics')}>
              <ChevronRightIcon size={16} />
            </button>
            <button onClick={handleNewTopic}
              className="p-1.5 hover:bg-[var(--accent-subtle)] rounded-lg transition-colors text-blue-500" title={t('aiChat.newTopic')}>
              <Plus size={16} />
            </button>
          </div>
        ) : (
          <>
            {/* 话题列表头部 */}
            <div className="px-3 py-2.5 border-b border-[var(--border-default)] flex items-center justify-between shrink-0">
              <span className="text-xs font-bold text-[var(--fg-secondary)] uppercase tracking-wider">{t('aiChat.topicRecords')}</span>
              <div className="flex items-center gap-0.5">
                <button onClick={handleNewTopic}
                  className="p-1.5 hover:bg-[var(--accent-subtle)] rounded-lg transition-colors text-[var(--fg-muted)] hover:text-blue-600" title={t('aiChat.newTopic')}>
                  <Plus size={14} />
                </button>
                <button onClick={() => setSidebarCollapsed(true)}
                  className="p-1.5 hover:bg-[var(--bg-subtle)] rounded-lg transition-colors text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]" title={t('common.collapse')}>
                  <ChevronLeft size={14} />
                </button>
              </div>
            </div>

            {/* 话题列表 */}
            <div className="flex-1 overflow-y-auto scrollbar-light">
              {topics.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <MessageSquare size={24} className="text-[var(--fg-muted)] mx-auto mb-2" />
                  <p className="text-xs text-[var(--fg-muted)]">{t('aiChat.noHistory')}</p>
                  <p className="text-[10px] text-[var(--fg-muted)] mt-1">{t('aiChat.autoSaveHint')}</p>
                </div>
              ) : (
                <div className="py-1">
                  {topics.map(topic => {
                    const isActive = topic.id === activeTopicId;
                    const msgCount = topic.messages.filter(m => m.role === 'user').length;
                    return (
                      <div key={topic.id}
                        onClick={() => handleSwitchTopic(topic.id)}
                        className={`group mx-1.5 mb-0.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-[var(--accent-subtle)] border border-blue-200'
                            : 'hover:bg-[var(--bg-subtle)] border border-transparent'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1.5">
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs font-medium truncate leading-snug ${
                              isActive ? 'text-blue-700' : 'text-[var(--fg-primary)]'
                            }`}>
                              {topic.title}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-[var(--fg-muted)] flex items-center gap-0.5">
                                <Clock size={9} />
                                {formatTopicTime(topic.updatedAt, t)}
                              </span>
                              {msgCount > 0 && (
                                <span className="text-[10px] text-[var(--fg-muted)]">{t('aiChat.messageCount', { n: msgCount })}</span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={(e) => handleDeleteTopic(e, topic.id)}
                            className={`p-1 rounded transition-colors shrink-0 ${
                              isActive
                                ? 'text-blue-400 hover:text-red-500 hover:bg-red-50'
                                : 'text-transparent group-hover:text-[var(--fg-muted)] hover:!text-red-500 hover:!bg-red-50'
                            }`}
                            title={t('aiChat.deleteTopic')}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 底部统计 */}
            {topics.length > 0 && (
              <div className="px-3 py-2 border-t border-[var(--border-default)] shrink-0">
                <span className="text-[10px] text-[var(--fg-muted)]">{t('aiChat.topicCount', { count: topics.length })}</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* ═══ 右侧对话区域 ═══ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-6 py-3 border-b border-[var(--border-default)] bg-[var(--bg-surface)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 flex items-center justify-center">
              <MessageSquare className="text-blue-600" size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[var(--fg-primary)]">
                {activeTopic ? activeTopic.title : 'AI Chat'}
              </h2>
              <p className="text-[11px] text-[var(--fg-muted)]">{t('aiChat.askAnything')}</p>
            </div>
          </div>
          {messages.length > 0 && (
            <button onClick={handleNewTopic}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--fg-secondary)] hover:text-blue-600 hover:bg-[var(--accent-subtle)] rounded-lg transition-colors border border-[var(--border-default)] hover:border-blue-200">
              <Plus size={14} />
              {t('aiChat.newTopic')}
            </button>
          )}
        </div>

        {/* 消息区域 */}
        <div className="flex-1 overflow-y-auto min-h-0 scrollbar-light">
          <div className="max-w-3xl mx-auto p-6 space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 flex items-center justify-center mb-4">
                  <Sparkles className="text-blue-500" size={28} />
                </div>
                <h3 className="text-base font-bold text-[var(--fg-primary)] mb-2">{t('aiChat.startChat')}</h3>
                <p className="text-sm text-[var(--fg-muted)] max-w-md leading-relaxed mb-5">
                  {t('aiChat.emptyDescLong')}
                </p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {[
                    { key: 'analyzeArch', label: t('aiChat.quickPrompts.analyzeArch') },
                    { key: 'findDuplicates', label: t('aiChat.quickPrompts.findDuplicates') },
                    { key: 'suggestOptimize', label: t('aiChat.quickPrompts.suggestOptimize') },
                    { key: 'summarize', label: t('aiChat.quickPromptSummarize') },
                  ].map(item => (
                    <button key={item.key} onClick={() => { setInput(item.label); inputRef.current?.focus(); }}
                      className="text-xs px-3.5 py-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--fg-secondary)] hover:bg-[var(--accent-subtle)] hover:text-blue-700 hover:border-blue-200 transition-colors shadow-sm">
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] ${
                  msg.role === 'user' ? 'bg-[var(--accent-subtle)] text-[var(--fg-primary)] rounded-2xl rounded-tr-md px-4 py-2.5'
                    : msg.role === 'system' ? 'bg-[var(--bg-subtle)] border border-[var(--border-default)] text-[var(--fg-secondary)] rounded-2xl px-4 py-2.5 w-full'
                    : 'bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl rounded-tl-md px-4 py-3 shadow-sm w-full'
                }`}>
                  {msg.role === 'assistant' && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <Brain size={13} className="text-blue-500" />
                      <span className="text-[11px] font-bold text-blue-600">{t('aiChat.aiAssistant')}</span>
                    </div>
                  )}
                  {msg.role === 'assistant' && !msg.diff ? (
                    <MarkdownWithHighlight content={msg.content} className="text-sm text-[var(--fg-primary)]" />
                  ) : (
                    <p className={`text-sm leading-relaxed whitespace-pre-wrap ${msg.role === 'user' ? '' : 'text-[var(--fg-secondary)]'}`}>{msg.content}</p>
                  )}
                  {msg.diff && msg.diff.length > 0 && (
                    <div className="space-y-2 mt-2">
                      {msg.diff.map((d: any) => <DiffFieldView key={d.field} d={d} />)}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl rounded-tl-md px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin text-blue-500" />
                    <span className="text-sm text-[var(--fg-secondary)]">{t('aiChat.thinking')}</span>
                    {abortRef.current && (
                      <button onClick={() => abortRef.current?.abort()}
                        className="ml-1 px-1.5 py-0.5 text-[10px] font-bold text-red-500 border border-red-200 rounded hover:bg-red-50 transition-colors">
                        {t('common.stop')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* 输入区域 */}
        <div className="border-t border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0">
          <div className="max-w-3xl mx-auto px-6 py-3">
            <div className="flex gap-2">
              <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder={t('aiChat.inputPlaceholder')} rows={2}
                className="flex-1 px-4 py-2.5 text-sm border border-[var(--border-default)] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 resize-none placeholder:text-[var(--fg-muted)]"
                disabled={loading} />
              <button onClick={handleSend} disabled={!input.trim() || loading}
                className="self-stretch w-10 flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm shrink-0">
                <Send size={16} />
              </button>
            </div>
            <p className="text-[10px] text-[var(--fg-muted)] mt-1.5">{t('aiChat.inputHint')}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AiChatView;
