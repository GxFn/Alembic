import React, { useState, useEffect, useCallback } from 'react';
import {
  ScrollText, Plus, RefreshCw, ChevronRight, ChevronDown,
  Sparkles, X, Package, FolderOpen, Copy, Check,
  AlertCircle, Loader2, FileText, Bot, User, Cpu,
  Pencil, Trash2, Save,
} from 'lucide-react';
import api from '../../api';
import { getErrorMessage, getErrorStatus } from '../../utils/error';
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
}

const SkillsView: React.FC<SkillsViewProps> = ({ onRefresh }) => {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [filter, setFilter] = useState<'all' | 'builtin' | 'project'>('all');
  const [copied, setCopied] = useState(false);
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
    } catch (err: unknown) {
      // Skills 路由可能未注册 — 静默处理 404
      const status = getErrorStatus(err);
      if (status !== 404) {
        notify(getErrorMessage(err, ''), { title: t('skills.fetchFailed'), type: 'error' });
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
    } catch (err: unknown) {
      notify(`"${name}" ${t('skills.loadError')}`, { title: t('skills.loadSkillFailed'), type: 'error' });
    } finally {
      setLoadingDetail(false);
    }
  };

  /* ── Copy content ── */
  const handleCopy = () => {
    if (!selectedSkill?.content) return;
    navigator.clipboard.writeText(selectedSkill.content).catch(() => { /* clipboard fallback: user denied or insecure context */ });
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
    } catch (err: unknown) {
      notify(getErrorMessage(err, ''), { title: t('skills.updateFailed'), type: 'error' });
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
    } catch (err: unknown) {
      notify(getErrorMessage(err, ''), { title: t('skills.deleteFailed'), type: 'error' });
    } finally {
      setDeleting(false);
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
          <div className="w-10 h-10 rounded-xl bg-violet-50 border border-violet-100 flex items-center justify-center shrink-0">
            <ScrollText size={20} className="text-violet-600" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg xl:text-xl font-bold text-[var(--fg-primary)]">{t('skills.title')}</h2>
            <p className="text-xs text-[var(--fg-muted)] mt-0.5 truncate">
              {t('skills.subtitle')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={fetchSkills}
            className="p-2 rounded-lg text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)] transition-colors"
            title={t('common.refresh')}
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold text-violet-600 dark:text-violet-400 bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-all"
          >
            <Sparkles size={14} />
            {t('skills.addSkill')}
          </button>
        </div>
      </div>

      {/* ── Filter tabs ── */}
      <div className="flex items-center gap-1.5 mb-4">
        {([
          { key: 'all' as const, label: t('common.all'), count: skills.length },
          { key: 'project' as const, label: t('skills.filterProject'), count: projectCount, icon: FolderOpen },
          { key: 'builtin' as const, label: t('skills.filterBuiltin'), count: builtinCount, icon: Package },
        ]).map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === f.key
                ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-emphasis)]'
                : 'text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] border border-transparent'
            }`}
          >
            {f.icon && <f.icon size={12} />}
            {f.label}
            <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] ${
              filter === f.key ? 'bg-[var(--accent-subtle)] text-[var(--accent)]' : 'bg-[var(--bg-subtle)] text-[var(--fg-secondary)]'
            }`}>{f.count}</span>
          </button>
        ))}
      </div>

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
              <ScrollText size={40} className="mx-auto mb-3 opacity-40" />
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
                <ScrollText size={40} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm">{t('skills.selectToView')}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Create Modal ── */}
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
 *  Create Modal
 * ═══════════════════════════════════════════════════════ */

const CreateSkillModal: React.FC<{
  onClose: () => void;
  onCreated: () => void;
}> = ({ onClose, onCreated }) => {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /* ── Save ── */
  const handleSave = async () => {
    if (!name.trim() || !description.trim() || !content.trim()) {
      setError(t('skills.fillRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createSkill({
        name: name.trim(),
        description: description.trim(),
        content: content.trim(),
        createdBy: 'manual',
      });
      notify(t('skills.savedToKB'), { title: `Skill "${name}" ${t('skills.createSuccess')}` });
      onCreated();
    } catch (err: unknown) {
      setError(t('skills.createFailed') + ': ' + getErrorMessage(err, ''));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageOverlay className="z-40 flex items-center justify-center">
      <PageOverlay.Backdrop className="bg-black/20 dark:bg-black/40 backdrop-blur-sm" />
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
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
        </div>
      </div>
    </PageOverlay>
  );
};

export default SkillsView;
