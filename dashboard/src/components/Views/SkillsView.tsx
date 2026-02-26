import React, { useState, useEffect, useCallback } from 'react';
import {
  BookOpen, Plus, RefreshCw, ChevronRight, ChevronDown,
  Sparkles, X, Send, Package, FolderOpen, Copy, Check,
  AlertCircle, Loader2, FileText, Lightbulb, Zap, Bot, User, Cpu,
  Pencil, Trash2, Save,
} from 'lucide-react';
import api from '../../api';
import { notify } from '../../utils/notification';
import PageOverlay from '../Shared/PageOverlay';
import { useI18n } from '../../i18n';

/* ═══════════════════════════════════════════════════════
 *  Types
 * ═══════════════════════════════════════════════════════ */

interface SkillItem {
  name: string;
  source: 'builtin' | 'project';
  summary: string;
  useCase: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

interface SkillDetail {
  skillName: string;
  source: string;
  content: string;
  charCount: number;
  useCase: string | null;
  relatedSkills: string[];
  createdBy: string | null;
  createdAt: string | null;
}

/** createdBy 标签配置 */
const CREATED_BY_CONFIG: Record<string, { label: string; color: string; icon: typeof Bot }> = {
  'manual':      { label: 'manual',     color: 'bg-[var(--bg-subtle)] text-[var(--fg-secondary)]',   icon: User },
  'user-ai':     { label: 'user-ai',  color: 'bg-violet-100 text-violet-600', icon: Sparkles },
  'system-ai':   { label: 'system-ai',     color: 'bg-amber-100 text-amber-600',   icon: Cpu },
  'external-ai': { label: 'external-ai',  color: 'bg-cyan-100 text-cyan-600',     icon: Bot },
};

/* ═══════════════════════════════════════════════════════
 *  Main Component
 * ═══════════════════════════════════════════════════════ */

interface SkillsViewProps {
  onRefresh?: () => void;
  signalSuggestionCount?: number;
  onSuggestionCountChange?: (count: number) => void;
}

const SkillsView: React.FC<SkillsViewProps> = ({ onRefresh, signalSuggestionCount = 0, onSuggestionCountChange }) => {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [filter, setFilter] = useState<'all' | 'builtin' | 'project'>('all');
  const [copied, setCopied] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [creatingSuggestion, setCreatingSuggestion] = useState<string | null>(null);

  /* ── Edit & Delete state ── */
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSavingSkill] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* ── Fetch skills list ── */
  const fetchSkills = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSkills();
      setSkills(data.skills || []);
    } catch (err: any) {
      // Skills 路由可能未注册 — 静默处理 404
      const status = err.response?.status;
      if (status !== 404) {
        notify(err.message || '', { title: t('skills.fetchFailed'), type: 'error' });
      }
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  /* ── Load skill detail ── */
  const handleSelectSkill = async (name: string) => {
    if (selectedSkill?.skillName === name) {
      setSelectedSkill(null);
      return;
    }
    setEditing(false);
    setConfirmDelete(false);
    setLoadingDetail(true);
    try {
      const data = await api.loadSkill(name);
      setSelectedSkill(data);
    } catch (err: any) {
      notify(`"${name}" ${t('skills.loadError')}`, { title: t('skills.loadSkillFailed'), type: 'error' });
    } finally {
      setLoadingDetail(false);
    }
  };

  /* ── Copy content ── */
  const handleCopy = () => {
    if (!selectedSkill?.content) return;
    navigator.clipboard.writeText(selectedSkill.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* ── Enter edit mode ── */
  const handleStartEdit = () => {
    if (!selectedSkill) return;
    setEditContent(selectedSkill.content);
    setEditing(true);
  };

  /* ── Cancel edit ── */
  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent('');
  };

  /* ── Save edit ── */
  const handleSaveEdit = async () => {
    if (!selectedSkill || !editContent.trim()) return;
    setSavingSkill(true);
    try {
      await api.updateSkill(selectedSkill.skillName, { content: editContent });
      notify(t('skills.saveSuccess'), { title: `Skill "${selectedSkill.skillName}" ${t('skills.updateSuccess')}` });
      setEditing(false);
      // Reload detail
      const data = await api.loadSkill(selectedSkill.skillName);
      setSelectedSkill(data);
    } catch (err: any) {
      notify(err.message || '', { title: t('skills.updateFailed'), type: 'error' });
    } finally {
      setSavingSkill(false);
    }
  };

  /* ── Delete skill ── */
  const handleDelete = async () => {
    if (!selectedSkill) return;
    setDeleting(true);
    try {
      await api.deleteSkill(selectedSkill.skillName);
      notify(t('skills.deleteSuccess'), { title: `Skill "${selectedSkill.skillName}" ${t('skills.deleteSuccess')}` });
      setSelectedSkill(null);
      setConfirmDelete(false);
      setEditing(false);
      fetchSkills();
      onRefresh?.();
    } catch (err: any) {
      notify(err.message || '', { title: t('skills.deleteFailed'), type: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  /* ── Fetch skill suggestions (merge rule-based + AI signal) ── */
  const handleSuggest = async () => {
    setLoadingSuggestions(true);
    setShowSuggestions(true);
    try {
      // 并行获取两个来源
      const [ruleData, signalData] = await Promise.allSettled([
        api.suggestSkills(),
        api.getSignalStatus(),
      ]);

      const ruleSuggestions = ruleData.status === 'fulfilled' ? (ruleData.value.suggestions || []) : [];
      const signalSuggestions = signalData.status === 'fulfilled' ? (signalData.value.suggestions || []) : [];

      // 合并去重（以 name 为 key，signal AI 建议优先）
      const merged = new Map<string, any>();
      for (const s of ruleSuggestions) merged.set(s.name, s);
      for (const s of signalSuggestions) merged.set(s.name, { ...merged.get(s.name), ...s });
      const list = [...merged.values()];

      setSuggestions(list);
      // 同步角标数量为实际推荐数
      onSuggestionCountChange?.(list.length);
    } catch (err: any) {
      notify(err.message || '', { title: t('skills.aiRecommendFailed'), type: 'error' });
      setSuggestions([]);
      onSuggestionCountChange?.(0);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  /* ── 角标 > 0 时自动加载推荐 ── */
  useEffect(() => {
    if (signalSuggestionCount > 0 && suggestions.length === 0 && !showSuggestions) {
      handleSuggest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Create skill from suggestion (AI generate content) ── */
  const handleCreateFromSuggestion = async (suggestion: any) => {
    setCreatingSuggestion(suggestion.name);
    try {
      // 使用 AI 生成 Skill 内容
      const desc = suggestion.description || suggestion.rationale || suggestion.name;
      const prompt = `${t('skillsView.aiPromptPrefix')}\n\n名称：${suggestion.name}\n描述：${desc}\n推荐原因：${suggestion.rationale}\n\n请直接生成 Skill 正文内容（Markdown 格式），不需要 frontmatter，不需要输出 JSON 元数据。内容应该详细、实用，包含具体的操作指南和示例。`;
      const aiResult = await api.aiGenerateSkill(prompt);
      let content = aiResult.reply || suggestion.body || `# ${desc}\n\n${suggestion.rationale || ''}`;
      // 剥离 AI 可能输出的 JSON 元数据首行
      content = content.replace(/^\s*\{["']name["']\s*:.*\}\s*\n?/, '').trim();

      await api.createSkill({
        name: suggestion.name,
        description: desc,
        content,
        createdBy: 'user-ai',
      });
      notify(t('skills.createAddedToKB'), { title: `Skill "${suggestion.name}" ${t('skills.createSuccess')}` });
      setSuggestions(prev => {
        const next = prev.filter(s => s.name !== suggestion.name);
        onSuggestionCountChange?.(next.length);
        return next;
      });
      fetchSkills();
    } catch (err: any) {
      notify(err.message || '', { title: t('skills.createFailed'), type: 'error' });
    } finally {
      setCreatingSuggestion(null);
    }
  };

  /* ── Filter ── */
  const filteredSkills = skills.filter(s => {
    if (filter === 'all') return true;
    return s.source === filter;
  }).sort((a, b) => {
    if (a.source === b.source) return a.name.localeCompare(b.name);
    return a.source === 'project' ? -1 : 1;
  });

  const builtinCount = skills.filter(s => s.source === 'builtin').length;
  const projectCount = skills.filter(s => s.source === 'project').length;

  return (
    <div className="h-full flex flex-col">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 bg-violet-100 rounded-xl flex items-center justify-center shrink-0">
            <BookOpen size={20} className="text-violet-600" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg xl:text-xl font-bold text-[var(--fg-primary)]">{t('skills.title')}</h2>
            <p className="text-sm text-[var(--fg-secondary)]">
              {t('skills.subtitle')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSuggest}
            disabled={loadingSuggestions}
            className="flex items-center gap-2 px-3 py-2 border border-amber-300 text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors text-sm font-medium disabled:opacity-50"
            title={t('skills.aiRecommendTooltip')}
          >
            {loadingSuggestions ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />}
            {t('skills.aiRecommend')}
          </button>
          <button
            onClick={fetchSkills}
            className="p-2 rounded-lg text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)] transition-colors"
            title={t('common.refresh')}
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors text-sm font-medium"
          >
            <Sparkles size={14} />
            {t('skills.addSkill')}
          </button>
        </div>
      </div>

      {/* ── Filter tabs ── */}
      <div className="flex items-center gap-1 mb-4 p-1 bg-[var(--bg-subtle)] rounded-lg w-fit">
        {([
          { key: 'all' as const, label: t('common.all'), count: skills.length },
          { key: 'project' as const, label: t('skills.filterProject'), count: projectCount, icon: FolderOpen },
          { key: 'builtin' as const, label: t('skills.filterBuiltin'), count: builtinCount, icon: Package },
        ]).map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === f.key
                ? 'bg-[var(--bg-surface)] text-violet-700 shadow-sm'
                : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
            }`}
          >
            {f.icon && <f.icon size={12} />}
            {f.label}
            <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] ${
              filter === f.key ? 'bg-violet-100 text-violet-600' : 'bg-[var(--bg-subtle)] text-[var(--fg-secondary)]'
            }`}>{f.count}</span>
          </button>
        ))}
      </div>

      {/* ── Skill Suggestions Panel ── */}
      {showSuggestions && (
        <div className="mb-4 border border-amber-200 bg-amber-50/50 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Lightbulb size={16} className="text-amber-600" />
              <span className="text-sm font-semibold text-amber-800">{t('skills.aiRecommendDesc')}</span>
              {suggestions.length > 0 && (
                <span className="px-1.5 py-0.5 bg-amber-200 text-amber-700 text-[10px] font-bold rounded-full">{suggestions.length}</span>
              )}
            </div>
            <button onClick={() => setShowSuggestions(false)} className="p-1 text-amber-400 hover:text-amber-600">
              <X size={14} />
            </button>
          </div>
          {loadingSuggestions ? (
            <div className="flex items-center gap-2 text-amber-600 text-xs py-2">
              <Loader2 size={14} className="animate-spin" />
              {t('skills.aiRecommending')}
            </div>
          ) : suggestions.length === 0 ? (
            <p className="text-xs text-amber-600/70">{t('skills.noRecommendations')}</p>
          ) : (
            <div className="space-y-2">
              {suggestions.map(s => (
                <div key={s.name} className="flex items-start gap-3 p-3 bg-[var(--bg-surface)] rounded-lg border border-amber-100">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs font-semibold text-[var(--fg-primary)]">{s.name}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        s.priority === 'high' ? 'bg-red-100 text-red-600'
                        : s.priority === 'medium' ? 'bg-amber-100 text-amber-600'
                        : 'bg-[var(--bg-subtle)] text-[var(--fg-secondary)]'
                      }`}>{s.priority}</span>
                      <span className="text-[10px] text-[var(--fg-muted)]">{s.source}</span>
                    </div>
                    <p className="text-xs text-[var(--fg-secondary)] mb-1">{s.description}</p>
                    <p className="text-[11px] text-[var(--fg-muted)] line-clamp-2">{s.rationale}</p>
                  </div>
                  <button
                    onClick={() => handleCreateFromSuggestion(s)}
                    disabled={creatingSuggestion === s.name}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors text-xs font-medium disabled:opacity-50"
                  >
                    {creatingSuggestion === s.name ? (
                      <><Loader2 size={12} className="animate-spin" /> {t('skills.creating')}</>
                    ) : (
                      <><Zap size={12} /> {t('skills.acceptRecommend')}</>
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Content ── */}
      <div className="flex-1 flex gap-4 xl:gap-6 min-h-0 overflow-hidden">
        {/* Skills list */}
        <div className="w-1/2 overflow-y-auto pr-2 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={24} className="animate-spin text-violet-400" />
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="text-center py-20 text-[var(--fg-muted)]">
              <BookOpen size={40} className="mx-auto mb-3 opacity-40" />
              <p>{t('skills.noResults')}</p>
            </div>
          ) : (
            filteredSkills.map(skill => (
              <button
                key={skill.name}
                onClick={() => handleSelectSkill(skill.name)}
                className={`w-full text-left p-4 rounded-xl border transition-all ${
                  selectedSkill?.skillName === skill.name
                    ? 'border-violet-300 bg-violet-50 shadow-sm'
                    : 'border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-[var(--border-emphasis)] hover:shadow-sm'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 shrink-0 ${
                    selectedSkill?.skillName === skill.name ? 'text-violet-500' : 'text-[var(--fg-muted)]'
                  }`}>
                    {selectedSkill?.skillName === skill.name ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-sm font-semibold text-[var(--fg-primary)]">{skill.name}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                        skill.source === 'builtin'
                          ? 'bg-blue-100 text-blue-600'
                          : 'bg-emerald-100 text-emerald-600'
                      }`}>
                        {skill.source === 'builtin' ? t('skills.filterBuiltin') : t('skills.filterProject')}
                      </span>
                      {skill.createdBy && CREATED_BY_CONFIG[skill.createdBy] && (() => {
                        const cfg = CREATED_BY_CONFIG[skill.createdBy!];
                        const Icon = cfg.icon;
                        return (
                          <span className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${cfg.color}`}>
                            <Icon size={10} />
                            {cfg.label}
                          </span>
                        );
                      })()}
                    </div>
                    <p className="text-xs text-[var(--fg-secondary)] line-clamp-2">{skill.summary}</p>
                    {skill.useCase && (
                      <p className="text-[11px] text-violet-500 mt-1 italic">
                        {t('skills.useCase')}：{skill.useCase}
                      </p>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail panel */}
        <div className="w-1/2 overflow-y-auto border border-[var(--border-default)] rounded-xl bg-[var(--bg-surface)]">
          {loadingDetail ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={24} className="animate-spin text-violet-400" />
            </div>
          ) : selectedSkill ? (
            <div className="h-full flex flex-col">
              {/* Detail header */}
              <div className="flex items-center justify-between p-4 border-b border-[var(--border-default)]">
                <div className="flex items-center gap-2">
                  <FileText size={16} className="text-violet-500" />
                  <span className="font-mono font-semibold text-sm">{selectedSkill.skillName}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                    selectedSkill.source === 'builtin'
                      ? 'bg-blue-100 text-blue-600'
                      : 'bg-emerald-100 text-emerald-600'
                  }`}>
                    {selectedSkill.source === 'builtin' ? t('skills.filterBuiltin') : t('skills.filterProject')}
                  </span>
                  {selectedSkill.createdBy && CREATED_BY_CONFIG[selectedSkill.createdBy] && (() => {
                    const cfg = CREATED_BY_CONFIG[selectedSkill.createdBy!];
                    const Icon = cfg.icon;
                    return (
                      <span className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${cfg.color}`}>
                        <Icon size={10} />
                        {t(`skills.createdBy.${selectedSkill.createdBy}`)}
                      </span>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[var(--fg-muted)]">{selectedSkill.charCount} {t('skills.chars')}</span>
                  <button
                    onClick={handleCopy}
                    className="p-1.5 rounded-md hover:bg-[var(--bg-subtle)] transition-colors text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]"
                    title={t('common.copy')}
                  >
                    {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                  </button>
                  {selectedSkill.source === 'project' && !editing && (
                    <>
                      <button
                        onClick={handleStartEdit}
                        className="p-1.5 rounded-md hover:bg-blue-50 transition-colors text-[var(--fg-muted)] hover:text-blue-600"
                        title={t('common.edit')}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => setConfirmDelete(true)}
                        className="p-1.5 rounded-md hover:bg-red-50 transition-colors text-[var(--fg-muted)] hover:text-red-500"
                        title={t('common.delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                  {editing && (
                    <>
                      <button
                        onClick={handleSaveEdit}
                        disabled={saving}
                        className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors text-xs font-medium disabled:opacity-50"
                      >
                        {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        {t('common.save')}
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="px-2.5 py-1 border border-[var(--border-default)] text-[var(--fg-secondary)] rounded-md hover:bg-[var(--bg-subtle)] transition-colors text-xs"
                      >
                        {t('common.cancel')}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Related skills */}
              {selectedSkill.relatedSkills.length > 0 && (
                <div className="px-4 py-2 border-b border-[var(--border-default)] flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-[var(--fg-muted)] uppercase font-bold">{t('skills.related')}:</span>
                  {selectedSkill.relatedSkills.map(rs => (
                    <button
                      key={rs}
                      onClick={() => handleSelectSkill(rs)}
                      className="text-[11px] text-violet-600 hover:text-violet-800 bg-violet-50 px-2 py-0.5 rounded-full transition-colors"
                    >
                      {rs}
                    </button>
                  ))}
                </div>
              )}

              {/* Content */}
              <div className="flex-1 overflow-y-auto p-4 relative">
                {editing ? (
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full h-full min-h-[300px] text-xs text-[var(--fg-primary)] font-mono leading-relaxed border border-blue-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none bg-blue-50/30"
                    spellCheck={false}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-xs text-[var(--fg-primary)] font-mono leading-relaxed">
                    {selectedSkill.content}
                  </pre>
                )}

                {/* Delete confirmation overlay */}
                {confirmDelete && (
                  <div className="absolute inset-0 bg-white/90 backdrop-blur-sm flex items-center justify-center z-10">
                    <div className="bg-[var(--bg-surface)] border border-red-200 rounded-xl shadow-lg p-6 max-w-sm text-center">
                      <Trash2 size={32} className="mx-auto mb-3 text-red-400" />
                      <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('skills.deleteConfirm')}</h3>
                      <p className="text-sm text-[var(--fg-secondary)] mb-4">
                        {t('skills.deleteSkillConfirmMsg', { name: selectedSkill.skillName })}
                      </p>
                      <div className="flex gap-3 justify-center">
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="px-4 py-2 border border-[var(--border-default)] text-[var(--fg-secondary)] rounded-lg hover:bg-[var(--bg-subtle)] text-sm"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          onClick={handleDelete}
                          disabled={deleting}
                          className="flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
                        >
                          {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          {t('skills.confirmDelete')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-[var(--fg-muted)]">
              <div className="text-center">
                <BookOpen size={40} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">{t('skills.selectToView')}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── AI Create Modal ── */}
      {showCreateModal && (
        <CreateSkillModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            fetchSkills();
            onRefresh?.();
          }}
        />
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
 *  AI Create Modal
 * ═══════════════════════════════════════════════════════ */

const CreateSkillModal: React.FC<{
  onClose: () => void;
  onCreated: () => void;
}> = ({ onClose, onCreated }) => {
  const { t } = useI18n();
  const [mode, setMode] = useState<'ai' | 'manual'>('ai');
  const [aiPrompt, setAiPrompt] = useState('');
  const [generating, setGenerating] = useState(false);

  // Manual / AI-generated fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [aiGenerated, setAiGenerated] = useState(false);

  /* ── AI Generate ── */
  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    setError('');
    try {
      const result = await api.aiGenerateSkill(aiPrompt);
      const reply = result.reply || '';

      // 解析 AI 回复 — 提取元数据 JSON（支持裸 JSON 行 / ```json 代码块 / 散落在正文中）
      let metaName = '';
      let metaDesc = '';
      let bodyContent = reply;

      // 策略 1：找 ```json { ... } ``` 代码块
      const codeBlockRe = /```(?:json)?\s*\n?\s*(\{[^}]*"name"[^}]*\})\s*\n?\s*```/i;
      const cbMatch = reply.match(codeBlockRe);
      if (cbMatch) {
        try {
          const meta = JSON.parse(cbMatch[1]);
          metaName = meta.name || '';
          metaDesc = meta.description || '';
          bodyContent = reply.replace(cbMatch[0], '').trim();
        } catch { /* ignore */ }
      }

      // 策略 2：找第一行裸 JSON 对象
      if (!metaName) {
        const lines = reply.split('\n');
        for (let i = 0; i < Math.min(lines.length, 5); i++) {
          const line = lines[i].trim();
          if (!line || line.startsWith('```')) continue;
          if (line.startsWith('{') && line.endsWith('}')) {
            try {
              const meta = JSON.parse(line);
              if (meta.name) {
                metaName = meta.name;
                metaDesc = meta.description || '';
                // 正文 = 跳过该行及其后的空行
                let bodyStart = i + 1;
                while (bodyStart < lines.length && !lines[bodyStart].trim()) bodyStart++;
                bodyContent = lines.slice(bodyStart).join('\n').trim();
                break;
              }
            } catch { /* not JSON */ }
          }
        }
      }

      // 策略 3：正则兜底 — 从正文提取 name / description
      if (!metaName) {
        const nameRe = /"name"\s*:\s*"([a-z][a-z0-9-]{1,62}[a-z0-9])"/;
        const descRe = /"description"\s*:\s*"([^"]+)"/;
        const nm = reply.match(nameRe);
        const dm = reply.match(descRe);
        if (nm) metaName = nm[1];
        if (dm) metaDesc = dm[1];
      }

      // 清理正文中残留的元数据代码块
      bodyContent = bodyContent
        .replace(/```(?:json)?\s*\n?\s*\{[^}]*"name"[^}]*\}\s*\n?\s*```/gi, '')
        .replace(/^\s*\{[^}]*"name"[^}]*\}\s*$/gm, '')
        .trim();

      if (metaName) setName(metaName);
      if (metaDesc) setDescription(metaDesc);
      setContent(bodyContent || reply.trim());

      setAiGenerated(true);
      setMode('manual'); // Switch to manual to let user review/edit
      notify(t('skills.checkGenerated'), { title: t('skills.aiGenerated') });
    } catch (err: any) {
      setError(t('skills.aiGenFailed') + ': ' + (err.message || ''));
    } finally {
      setGenerating(false);
    }
  };

  /* ── Save ── */
  const handleSave = async () => {
    if (!name.trim() || !description.trim() || !content.trim()) {
      setError(t('skills.fillRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createSkill({ name: name.trim(), description: description.trim(), content: content.trim(), createdBy: aiGenerated ? 'user-ai' : 'manual' });
      notify(t('skills.savedToKB'), { title: `Skill "${name}" ${t('skills.createSuccess')}` });
      onCreated();
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message || '';
      setError(t('skills.createFailed') + ': ' + msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageOverlay className="z-40 flex items-center justify-center">
      <PageOverlay.Backdrop className="bg-black/40 backdrop-blur-sm" />
        <div className="relative bg-[var(--bg-surface)] rounded-2xl shadow-2xl w-[720px] max-h-[85vh] flex flex-col">
        {/* Modal header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-violet-100 rounded-lg flex items-center justify-center">
              <Sparkles size={16} className="text-violet-600" />
            </div>
            <h3 className="font-bold text-lg">{t('skills.addSkill')}</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-subtle)] transition-colors">
            <X size={18} className="text-[var(--fg-muted)]" />
          </button>
        </div>

        {/* Mode toggle */}
        <div className="px-6 pt-4">
          <div className="inline-flex items-center gap-1 p-1 bg-[var(--bg-subtle)] rounded-lg">
            <button
              onClick={() => setMode('ai')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                mode === 'ai' ? 'bg-[var(--bg-surface)] text-violet-700 shadow-sm' : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
              }`}
            >
              <Sparkles size={12} />
              {t('skills.aiGenMode')}
            </button>
            <button
              onClick={() => setMode('manual')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                mode === 'manual' ? 'bg-[var(--bg-surface)] text-violet-700 shadow-sm' : 'text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]'
              }`}
            >
              <FileText size={12} />
              {t('skills.manualMode')}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {mode === 'ai' ? (
            /* AI mode */
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--fg-primary)] mb-1.5">
                  {t('skills.describeSkill')}
                </label>
                <div className="relative">
                  <textarea
                    value={aiPrompt}
                    onChange={e => setAiPrompt(e.target.value)}
                    placeholder={t('skillsView.placeholderDesc')}
                    className="w-full h-32 px-4 py-3 border border-[var(--border-default)] rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                    disabled={generating}
                  />
                </div>
              </div>
              <button
                onClick={handleGenerate}
                disabled={generating || !aiPrompt.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-violet-600 text-white rounded-xl hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
              >
                {generating ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {t('skills.aiGeneratingContent')}
                  </>
                ) : (
                  <>
                    <Send size={16} />
                    {t('skills.generateSkill')}
                  </>
                )}
              </button>
            </div>
          ) : (
            /* Manual mode / Edit generated */
            <div className="space-y-4">
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--fg-primary)] mb-1.5">
                    {t('skills.skillName')} <span className="text-[var(--fg-muted)] text-xs">(kebab-case)</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="my-custom-skill"
                    className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--fg-primary)] mb-1.5">
                    {t('skills.skillDescription')}
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder={t('skillsView.placeholderName')}
                    className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--fg-primary)] mb-1.5">
                  {t('skills.skillContent')} <span className="text-[var(--fg-muted)] text-xs">(Markdown)</span>
                </label>
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  placeholder={t('skillsView.placeholderContent')}
                  className="w-full h-64 px-4 py-3 border border-[var(--border-default)] rounded-xl text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-400 leading-relaxed"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--border-default)] flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] transition-colors"
          >
            {t('common.cancel')}
          </button>
          {mode === 'manual' && (
            <button
              onClick={handleSave}
              disabled={saving || !name.trim() || !description.trim() || !content.trim()}
              className="flex items-center gap-2 px-5 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {saving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {t('common.saving')}
                </>
              ) : (
                <>
                  <Plus size={14} />
                  {t('skills.addSkill')}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </PageOverlay>
  );
};

export default SkillsView;
