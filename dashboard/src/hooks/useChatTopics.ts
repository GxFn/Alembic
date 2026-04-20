import { useState, useCallback, useRef, useEffect } from 'react';

/* ═══════════════════════════════════════════════════════════
 * useChatTopics — 聊天话题本地化持久存储
 *
 * 每个话题包含 id、标题、消息列表、创建/更新时间。
 * 数据存储在 localStorage 的 `alembic-chat-topics` 键中。
 * ═══════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'alembic-chat-topics';
const MAX_TOPICS = 50; // 最多保留 50 个话题

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  diff?: Array<{ field: string; label: string; before: string; after: string }>;
  preview?: Record<string, any>;
  timestamp: number;
}

export interface ChatTopic {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/** 从首条用户消息中提取标题（截取前 30 字） */
function extractTitle(messages: ChatMessage[]): string {
  const first = messages.find(m => m.role === 'user');
  if (!first) return '新话题';
  const text = first.content.trim().replace(/\n/g, ' ');
  return text.length > 30 ? text.slice(0, 30) + '…' : text;
}

function loadTopics(): ChatTopic[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveTopics(topics: ChatTopic[]): void {
  try {
    // 只保留最新 MAX_TOPICS 个
    const trimmed = topics.slice(0, MAX_TOPICS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('[ChatTopics] localStorage save failed:', e);
  }
}

export function useChatTopics() {
  const [topics, setTopicsState] = useState<ChatTopic[]>(() => loadTopics());
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const topicsRef = useRef(topics);

  // 同步 ref
  useEffect(() => { topicsRef.current = topics; }, [topics]);

  // 同步持久化
  const setTopics = useCallback((updater: ChatTopic[] | ((prev: ChatTopic[]) => ChatTopic[])) => {
    setTopicsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveTopics(next);
      return next;
    });
  }, []);

  /** 创建新话题并激活，返回新话题 ID */
  const createTopic = useCallback((initialTitle?: string): string => {
    const id = generateId();
    const topic: ChatTopic = {
      id,
      title: initialTitle || '新话题',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setTopics(prev => [topic, ...prev]);
    setActiveTopicId(id);
    return id;
  }, [setTopics]);

  /** 删除话题 */
  const deleteTopic = useCallback((id: string) => {
    setTopics(prev => prev.filter(t => t.id !== id));
    setActiveTopicId(prev => prev === id ? null : prev);
  }, [setTopics]);

  /** 更新活跃话题的消息（自动提取标题）*/
  const saveTopic = useCallback((topicId: string, messages: ChatMessage[]) => {
    setTopics(prev => {
      const idx = prev.findIndex(t => t.id === topicId);
      if (idx < 0) return prev;
      const updated = { ...prev[idx], messages, updatedAt: Date.now() };
      // 用第一条用户消息作为标题
      const title = extractTitle(messages);
      if (title !== '新话题') updated.title = title;
      const next = [...prev];
      next[idx] = updated;
      // 将更新的话题移到最前
      next.splice(idx, 1);
      next.unshift(updated);
      return next;
    });
  }, [setTopics]);

  /** 获取指定话题 */
  const getTopic = useCallback((id: string): ChatTopic | undefined => {
    return topicsRef.current.find(t => t.id === id);
  }, []);

  /** 切换到指定话题 */
  const switchTopic = useCallback((id: string) => {
    setActiveTopicId(id);
  }, []);

  /** 获取当前活跃话题 */
  const activeTopic = topics.find(t => t.id === activeTopicId) ?? null;

  return {
    topics,
    activeTopicId,
    activeTopic,
    createTopic,
    deleteTopic,
    saveTopic,
    getTopic,
    switchTopic,
    setActiveTopicId,
  };
}

export type ChatTopicsAPI = ReturnType<typeof useChatTopics>;
