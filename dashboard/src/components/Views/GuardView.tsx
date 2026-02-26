import React, { useState, useEffect, useMemo } from 'react';
import { Shield, AlertTriangle, AlertCircle, Trash2, ChevronDown, ChevronRight, ExternalLink, BookOpen, Wrench, Link2, Filter, Info } from 'lucide-react';
import api from '../../api';
import { notify } from '../../utils/notification';
import { GITHUB_ISSUES_NEW_GUARD_URL, LANGUAGE_OPTIONS } from '../../constants';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import Select from '../ui/Select';

interface GuardRule {
  message: string;
  severity: string;
  pattern: string;
  languages: string[];
  note?: string;
  /** 审查规模：仅在该规模下运行；无则任意规模均运行 */
  dimension?: 'file' | 'target' | 'project';
  /** 规则分类 */
  category?: 'safety' | 'correctness' | 'performance' | 'style' | '';
  /** 修复建议 */
  fixSuggestion?: string;
  /** 规则溯源：为什么存在这条规则 */
  rationale?: string;
  /** 修复建议列表 */
  fixSuggestions?: string[];
  /** 关联的 Recipe ID/名称 */
  sourceRecipe?: string;
}

interface GuardViolation {
  ruleId: string;
  message: string;
  severity: string;
  line: number;
  snippet: string;
  /** 审查维度：同文件 / 同 target / 同项目 */
  dimension?: 'file' | 'target' | 'project';
  /** 违反所在文件（target/project 范围时可能来自其他文件） */
  filePath?: string;
}

interface GuardRun {
  id: string;
  filePath: string;
  triggeredAt: string;
  violations: GuardViolation[];
}

const GuardView: React.FC<{ onRefresh?: () => void }> = ({ onRefresh }) => {
  const { t } = useI18n();
  const [rules, setRules] = useState<Record<string, GuardRule>>({});
  const [runs, setRuns] = useState<GuardRun[]>([]);
  const [projectLanguages, setProjectLanguages] = useState<string[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAiWriteRule, setShowAiWriteRule] = useState(false);
  const [showAddRule, setShowAddRule] = useState(false);
  const [semanticInput, setSemanticInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [addRuleForm, setAddRuleForm] = useState({
  ruleId: '',
  message: '',
  severity: 'warning' as 'warning' | 'error',
  pattern: '',
  languages: [] as string[],
  note: '',
  dimension: '' as '' | 'file' | 'target' | 'project'
  });
  const [addRuleSubmitting, setAddRuleSubmitting] = useState(false);
  const [addRuleError, setAddRuleError] = useState('');

  const fetchGuard = async () => {
  try {
    const [rulesResult, violationsResult] = await Promise.all([
    api.getGuardRules(),
    api.getGuardViolations()
    ]);
    setRules(rulesResult?.rules || {});
    setProjectLanguages(rulesResult?.projectLanguages || []);
    setRuns(violationsResult?.runs || []);
  } catch (_) {
    setRules({});
    setRuns([]);
  } finally {
    setLoading(false);
  }
  };

  useEffect(() => {
  fetchGuard();
  }, []);

  const handleClearViolations = async () => {
  if (!window.confirm(t('guard.clearConfirm'))) return;
  try {
    await api.clearViolations();
    fetchGuard();
    onRefresh?.();
  } catch (err: any) {
    notify(err?.message || t('common.operationFailed'), { title: t('common.operationFailed'), type: 'error' });
  }
  };

  const handleToggleLang = (lang: string) => {
  setAddRuleForm(prev => ({
    ...prev,
    languages: prev.languages.includes(lang)
    ? prev.languages.filter(l => l !== lang)
    : [...prev.languages, lang]
  }));
  };

  const handleGenerateRule = async () => {
  if (!semanticInput.trim()) {
    setAddRuleError(t('guard.aiGenPlaceholder'));
    return;
  }
  setAddRuleError('');
  setGenerating(true);
  try {
    const res = await api.generateGuardRule({
    description: semanticInput.trim()
    });
    const data = res;
    const dim = (data as { dimension?: string }).dimension;
    setAddRuleForm({
    ruleId: data.ruleId || '',
    message: data.message || '',
    severity: data.severity === 'error' ? 'error' : 'warning',
    pattern: data.pattern || '',
    languages: Array.isArray(data.languages) && data.languages.length > 0 ? data.languages : [],
    note: data.note != null ? String(data.note) : '',
    dimension: dim === 'file' || dim === 'target' || dim === 'project' ? dim : ''
    });
    setShowAddRule(true);
  } catch (err: any) {
    setAddRuleError(err?.response?.data?.error || err?.message || t('guard.aiGenFailed'));
  } finally {
    setGenerating(false);
  }
  };

  const handleAddRule = async (e: React.FormEvent) => {
  e.preventDefault();
  setAddRuleError('');
  if (!addRuleForm.ruleId.trim() || !addRuleForm.message.trim() || !addRuleForm.pattern.trim() || addRuleForm.languages.length === 0) {
    setAddRuleError(t('guard.addRuleValidation'));
    return;
  }
  setAddRuleSubmitting(true);
  try {
    await api.saveGuardRule({
    ruleId: addRuleForm.ruleId.trim(),
    message: addRuleForm.message.trim(),
    severity: addRuleForm.severity,
    pattern: addRuleForm.pattern.trim(),
    languages: addRuleForm.languages,
    note: addRuleForm.note.trim() || undefined,
    ...(addRuleForm.dimension ? { dimension: addRuleForm.dimension } : {})
    });
    setAddRuleForm({ ruleId: '', message: '', severity: 'warning', pattern: '', languages: [], note: '', dimension: '' });
    setSemanticInput('');
    setShowAddRule(false);
    fetchGuard();
    onRefresh?.();
  } catch (err: any) {
    setAddRuleError(err?.response?.data?.error || err?.message || t('common.saveFailed'));
  } finally {
    setAddRuleSubmitting(false);
  }
  };

  // ── 按项目语言过滤规则：仅展示当前项目涉及的语言 ──
  const projectRuleEntries = useMemo(() => {
    const all = Object.entries(rules);
    // 如果后端未返回项目语言（如 moduleService 未加载），显示全部
    if (projectLanguages.length === 0) return all;
    return all.filter(([, r]) => {
      if (!r.languages || r.languages.length === 0) return true;
      return r.languages.some(l => projectLanguages.includes(l));
    });
  }, [rules, projectLanguages]);

  const ruleEntries = projectRuleEntries;
  const totalViolations = runs.reduce((s, r) => s + r.violations.length, 0);

  // ── 筛选状态 ──
  const [langFilter, setLangFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');

  // ── 从规则中提取所有涉及的语言（用于动态 tab）──
  const presentLanguages = useMemo(() => {
    const langSet = new Set<string>();
    for (const [, r] of ruleEntries) {
      (r.languages || []).forEach(l => langSet.add(l));
    }
    // 按 LANGUAGE_OPTIONS 顺序排列
    const ordered = LANGUAGE_OPTIONS.filter(o => langSet.has(o.id)).map(o => o.id);
    // 附加不在 LANGUAGE_OPTIONS 里的
    for (const l of langSet) {
      if (!ordered.includes(l)) ordered.push(l);
    }
    return ordered;
  }, [ruleEntries]);

  // ── 语言显示名映射 ──
  const langLabel = (id: string) => LANGUAGE_OPTIONS.find(o => o.id === id)?.label || id;

  // ── 严重性统计 ──
  const severityCounts = useMemo(() => {
    const counts = { error: 0, warning: 0, info: 0 };
    for (const [, r] of ruleEntries) {
      const s = r.severity as keyof typeof counts;
      if (counts[s] !== undefined) counts[s]++;
    }
    return counts;
  }, [ruleEntries]);

  // ── 分类显示名 ──
  const categoryLabel = (cat?: string) => {
    const map: Record<string, string> = { safety: t('guard.categorySafety'), correctness: t('guard.categoryCorrectness'), performance: t('guard.categoryPerformance'), style: t('guard.categoryStyle') };
    return cat ? map[cat] || cat : '—';
  };

  // ── 规则 message / fixSuggestion 国际化：优先用 locale key，回退到后端原文 ──
  const ruleMsg = (ruleId: string, fallback: string) => {
    const key = `guardRuleMessages.${ruleId}`;
    const translated = t(key);
    return translated !== key ? translated : fallback;
  };
  const ruleFix = (ruleId: string, fallback?: string) => {
    if (!fallback) return fallback;
    const key = `guardRuleFixSuggestions.${ruleId}`;
    const translated = t(key);
    return translated !== key ? translated : fallback;
  };

  // ── 筛选后的规则 ──
  const filteredEntries = useMemo(() => {
    return ruleEntries.filter(([, r]) => {
      if (langFilter !== 'all' && !(r.languages || []).includes(langFilter)) return false;
      if (severityFilter !== 'all' && r.severity !== severityFilter) return false;
      return true;
    });
  }, [ruleEntries, langFilter, severityFilter]);

  if (loading) {
  return <div className="p-6 text-[var(--fg-secondary)]">{t('common.loading')}</div>;
  }

  return (
  <div className="flex-1 flex flex-col overflow-hidden">
    {/* ── 页面头部 ── */}
    <div className="mb-4 flex flex-wrap justify-between items-center gap-3 shrink-0">
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0">
      <Shield className="text-blue-600" size={20} />
      </div>
      <div className="min-w-0">
      <h2 className="text-lg xl:text-xl font-bold text-[var(--fg-primary)]">{t('guard.title')}</h2>
      <p className="text-xs text-[var(--fg-muted)] mt-0.5 truncate">
        {t('guard.summary')}
        {projectLanguages.length > 0 && (
        <span className="ml-1.5">· {t('guard.currentProject')}：{projectLanguages.map(l => langLabel(l)).join(' / ')}</span>
        )}
      </p>
      </div>
    </div>
    <div className="flex items-center gap-2 flex-wrap">
      <a
      href={GITHUB_ISSUES_NEW_GUARD_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border border-[var(--border-default)] hover:bg-[var(--bg-subtle)]"
      >
      <ExternalLink size={14} /> {t('guard.reportIssue')}
      </a>
      <button
      type="button"
      onClick={() => setShowAiWriteRule(!showAiWriteRule)}
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100"
      >
      {showAiWriteRule ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      {t('guard.aiGenRule')}
      </button>
      {runs.length > 0 && (
      <button
        type="button"
        onClick={handleClearViolations}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all text-red-600 bg-red-50 border border-red-200 hover:bg-red-100"
      >
        <Trash2 size={14} /> {t('guard.clearHistory')}
      </button>
      )}
      <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-default)]">
        <Shield size={14} className="text-[var(--fg-muted)]" />
        <span className="text-[var(--fg-secondary)]">{t('guard.tableHeaders.rule')} <strong className="text-[var(--fg-primary)]">{ruleEntries.length}</strong></span>
      </div>
      {totalViolations > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-100">
        <AlertTriangle size={14} className="text-amber-400" />
        <span className="text-amber-600">{t('guard.totalViolations', { count: totalViolations })}</span>
        </div>
      )}
      </div>
    </div>
    </div>

    {/* ── 内容区域 ── */}
    <div className="flex-1 overflow-y-auto pr-1 pb-6">

    {/* AI 写入规则：默认折叠，点击标题行展开 */}
    {showAiWriteRule && (
    <section className="mb-6">
    <div className="p-4 bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-xl space-y-3">
      <div>
      <label htmlFor="semantic-input" className="block text-xs font-medium text-[var(--fg-secondary)] mb-1">{t('guard.aiGenRuleDesc')}</label>
      <textarea
      id="semantic-input"
      name="semanticInput"
        value={semanticInput}
        onChange={e => { setSemanticInput(e.target.value); setAddRuleError(''); }}
        className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg text-sm resize-y min-h-[80px]"
        placeholder={t('guard.aiGenPlaceholder')}
        rows={3}
      />
      <button
        type="button"
        onClick={handleGenerateRule}
        disabled={generating || !semanticInput.trim()}
        className="mt-2 px-4 py-2 bg-slate-600 text-white text-sm rounded-lg hover:bg-slate-700 disabled:opacity-50"
      >
        {generating ? t('guard.aiGenerating') : t('guard.aiGenRule')}
      </button>
      {addRuleError && <p className="mt-2 text-sm text-red-600">{addRuleError}</p>}
      </div>
      <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setShowAddRule(!showAddRule)}
        className="text-sm font-medium text-blue-600 hover:text-blue-700"
      >
        {showAddRule ? t('common.collapse') : t('common.expand')}
      </button>
      {addRuleForm.ruleId && <span className="text-xs text-[var(--fg-secondary)]">{t('guard.generatedRuleId')}：{addRuleForm.ruleId}</span>}
      </div>
    </div>
    {showAddRule && (
      <form onSubmit={handleAddRule} className="mt-3 p-4 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
        <label htmlFor="rule-id" className="block text-xs font-medium text-[var(--fg-secondary)] mb-1">{t('guard.ruleId')}</label>
        <input
        id="rule-id"
        name="ruleId"
          type="text"
          value={addRuleForm.ruleId}
          onChange={e => setAddRuleForm(f => ({ ...f, ruleId: e.target.value }))}
          className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg text-sm"
          placeholder="my-rule-id"
        />
        </div>
        <div>
        <label htmlFor="rule-severity" className="block text-xs font-medium text-[var(--fg-secondary)] mb-1">{t('guard.severity')}</label>
        <Select
          id="rule-severity"
          name="severity"
          value={addRuleForm.severity}
          onChange={v => setAddRuleForm(f => ({ ...f, severity: v as 'error' | 'warning' }))}
          options={[
            { value: 'warning', label: 'warning' },
            { value: 'error', label: 'error' },
          ]}
          size="md"
          className="w-full"
        />
        </div>
      </div>
      <div>
      <label htmlFor="rule-message" className="block text-xs font-medium text-[var(--fg-secondary)] mb-1">{t('guard.message')}</label>
      <input
        id="rule-message"
        name="message"
        type="text"
        value={addRuleForm.message}
        onChange={e => setAddRuleForm(f => ({ ...f, message: e.target.value }))}
        className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg text-sm"
        placeholder={t('guard.aiGenPlaceholder')}
        />
      </div>
      <div>
      <label htmlFor="rule-pattern" className="block text-xs font-medium text-[var(--fg-secondary)] mb-1">{t('guard.patternLabel')}</label>
      <input
        id="rule-pattern"
        name="pattern"
        type="text"
        value={addRuleForm.pattern}
        onChange={e => setAddRuleForm(f => ({ ...f, pattern: e.target.value }))}
        className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg text-sm font-mono"
        placeholder="dispatch_sync\\s*\\([^)]*main"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-[var(--fg-secondary)] mb-1">{t('guard.languagesLabel')}</label>
        <div className="flex gap-3 flex-wrap">
        {(projectLanguages.length > 0
          ? LANGUAGE_OPTIONS.filter(o => projectLanguages.includes(o.id))
          : LANGUAGE_OPTIONS.slice(0, 8)
        ).map(opt => (
        <label key={opt.id} htmlFor={`lang-${opt.id}`} className="flex items-center gap-1.5 text-sm">
        <input id={`lang-${opt.id}`} name="languages" type="checkbox" checked={addRuleForm.languages.includes(opt.id)} onChange={() => handleToggleLang(opt.id)} />
        {opt.label}
        </label>
        ))}
        </div>
      </div>
      <div>
      <label htmlFor="rule-dimension" className="block text-xs font-medium text-[var(--fg-secondary)] mb-1">{t('guard.dimensionLabel')}</label>
      <Select
        id="rule-dimension"
        name="dimension"
        value={addRuleForm.dimension}
        onChange={v => setAddRuleForm(f => ({ ...f, dimension: v as '' | 'file' | 'target' | 'project' }))}
        options={[
          { value: '', label: t('guard.dimNoLimit') },
          { value: 'file', label: t('guard.dimFile') },
          { value: 'target', label: t('guard.dimTarget') },
          { value: 'project', label: t('guard.dimProject') },
        ]}
        size="md"
        className="w-full"
      />
      </div>
      <div>
      <label htmlFor="rule-note" className="block text-xs font-medium text-[var(--fg-secondary)] mb-1">{t('guard.noteLabel')}</label>
      <input
        id="rule-note"
        name="note"
        type="text"
        value={addRuleForm.note}
        onChange={e => setAddRuleForm(f => ({ ...f, note: e.target.value }))}
        className="w-full px-3 py-2 border border-[var(--border-default)] rounded-lg text-sm"
        placeholder={t('guard.notePlaceholder')}
        />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={addRuleSubmitting} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
        {addRuleSubmitting ? t('common.saving') : t('common.confirm')}
        </button>
        <button type="button" onClick={() => setShowAddRule(false)} className="px-4 py-2 text-[var(--fg-secondary)] text-sm rounded-lg hover:bg-[var(--bg-subtle)]">
        {t('common.collapse')}
        </button>
      </div>
      </form>
    )}
    </section>
    )}

    {/* 规则表 */}
    <section className="mb-8">
    {/* ── 规则筛选栏 ── */}
    <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
      <h3 className="text-sm font-semibold text-[var(--fg-primary)] flex items-center gap-1.5">
        <Filter size={14} className="text-[var(--fg-muted)]" />
        {t('guard.tableHeaders.rule')}
        <span className="text-[var(--fg-muted)] font-normal">（{filteredEntries.length}/{ruleEntries.length}）</span>
      </h3>
      <div className="flex items-center gap-2 flex-wrap">
        {/* 严重性筛选 */}
        <div className="flex items-center gap-1 text-xs">
          <button onClick={() => setSeverityFilter('all')}
            className={`px-2 py-1 rounded-md border transition-all ${severityFilter === 'all' ? 'bg-slate-700 text-white border-slate-700' : 'bg-[var(--bg-surface)] text-[var(--fg-secondary)] border-[var(--border-default)] hover:bg-[var(--bg-subtle)]'}`}>
            {t('common.all')}
          </button>
          <button onClick={() => setSeverityFilter('error')}
            className={`px-2 py-1 rounded-md border transition-all flex items-center gap-1 ${severityFilter === 'error' ? 'bg-red-600 text-white border-red-600' : 'bg-[var(--bg-surface)] text-red-600 border-red-200 hover:bg-red-50'}`}>
            <AlertCircle size={12} /> error <span className="opacity-70">({severityCounts.error})</span>
          </button>
          <button onClick={() => setSeverityFilter('warning')}
            className={`px-2 py-1 rounded-md border transition-all flex items-center gap-1 ${severityFilter === 'warning' ? 'bg-amber-500 text-white border-amber-500' : 'bg-[var(--bg-surface)] text-amber-600 border-amber-200 hover:bg-amber-50'}`}>
            <AlertTriangle size={12} /> warning <span className="opacity-70">({severityCounts.warning})</span>
          </button>
          <button onClick={() => setSeverityFilter('info')}
            className={`px-2 py-1 rounded-md border transition-all flex items-center gap-1 ${severityFilter === 'info' ? 'bg-blue-500 text-white border-blue-500' : 'bg-[var(--bg-surface)] text-blue-600 border-blue-200 hover:bg-blue-50'}`}>
            <Info size={12} /> info <span className="opacity-70">({severityCounts.info})</span>
          </button>
        </div>
      </div>
    </div>
    {/* ── 语言标签栏 ── */}
    <div className="flex items-center gap-1.5 mb-3 flex-wrap">
      <button onClick={() => setLangFilter('all')}
        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${langFilter === 'all' ? 'bg-slate-700 text-white border-slate-700' : 'bg-[var(--bg-surface)] text-[var(--fg-secondary)] border-[var(--border-default)] hover:bg-[var(--bg-subtle)]'}`}>
        {t('guard.allLanguages')}
      </button>
      {presentLanguages.map(lang => {
        const count = ruleEntries.filter(([, r]) => (r.languages || []).includes(lang)).length;
        return (
          <button key={lang} onClick={() => setLangFilter(langFilter === lang ? 'all' : lang)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${langFilter === lang ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-[var(--bg-surface)] text-[var(--fg-secondary)] border-[var(--border-default)] hover:bg-[var(--bg-subtle)]'}`}>
            {langLabel(lang)} <span className="opacity-60">({count})</span>
          </button>
        );
      })}
    </div>
    {/* ── Code-Level / Cross-File 配置提示 ── */}
    <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-100 text-xs text-indigo-700">
      <Info size={14} className="shrink-0 mt-0.5" />
      <div>
        <span>{t('guard.codeLevelConfigTip')}</span>
        <span className="ml-1 font-mono text-[11px] text-indigo-500">{t('guard.codeLevelConfigPath')}</span>
      </div>
    </div>
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl overflow-hidden">
      <table className="w-full text-sm">
      <thead className="bg-[var(--bg-subtle)] border-b border-[var(--border-default)]">
        <tr>
        <th className="text-left py-2 px-4 font-medium text-[var(--fg-secondary)]">{t('guard.ruleId')}</th>
        <th className="text-left py-2 px-4 font-medium text-[var(--fg-secondary)] w-20">{t('guard.severity')}</th>
        <th className="text-left py-2 px-4 font-medium text-[var(--fg-secondary)]">{t('guard.message')}</th>
        <th className="text-left py-2 px-4 font-medium text-[var(--fg-secondary)] w-28">{t('guard.languagesLabel')}</th>
        <th className="text-left py-2 px-4 font-medium text-[var(--fg-secondary)] w-20">{t('guard.category')}</th>
        </tr>
      </thead>
      <tbody>
        {filteredEntries.length === 0 ? (
        <tr><td colSpan={5} className="py-4 px-4 text-[var(--fg-secondary)] text-center">
          {ruleEntries.length === 0 ? t('common.noData') : t('guard.noMatchingRules')}
        </td></tr>
        ) : (
        filteredEntries.map(([id, r]) => (
          <tr key={id} className="border-b border-[var(--border-default)] last:border-0 hover:bg-[var(--bg-subtle)]">
          <td className="py-2 px-4 font-mono text-xs text-[var(--fg-primary)]">{id}</td>
          <td className="py-2 px-4">
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
              r.severity === 'error' ? 'bg-red-100 text-red-700'
              : r.severity === 'info' ? 'bg-blue-100 text-blue-700'
              : 'bg-amber-100 text-amber-700'
            }`}>
            {r.severity}
            </span>
          </td>
          <td className="py-2 px-4 text-[var(--fg-primary)]">
            {ruleMsg(id, r.message)}
            {r.fixSuggestion && (
              <span className="ml-1.5 text-xs text-emerald-600" title={ruleFix(id, r.fixSuggestion)}>💡</span>
            )}
          </td>
          <td className="py-2 px-4">
            <div className="flex flex-wrap gap-1">
            {(r.languages || []).map(l => (
              <span key={l} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-100 font-medium">
                {langLabel(l)}
              </span>
            ))}
            </div>
          </td>
          <td className="py-2 px-4 text-xs text-[var(--fg-secondary)]">
            {categoryLabel((r as any).category)}
          </td>
          </tr>
        ))
        )}
      </tbody>
      </table>
    </div>
    </section>

    {/* 违反记录 */}
    <section>
    <h3 className="text-sm font-semibold text-[var(--fg-primary)] mb-3">
      {t('guard.violationRecords', { runs: runs.length, count: totalViolations })}
    </h3>
    {runs.length === 0 ? (
      <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-xl py-12 text-center text-[var(--fg-secondary)]">
      {t('guard.noViolations')}
      </div>
    ) : (
      <div className="space-y-2">
      {runs.map((run) => {
        const isExpanded = expandedRunId === run.id;
        const hasViolations = run.violations.length > 0;
        return (
        <div key={run.id} className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <button
          type="button"
          onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
          className="w-full flex items-center gap-2 py-3 px-4 text-left hover:bg-[var(--bg-subtle)] transition-colors"
          >
          {isExpanded ? <ChevronDown size={ICON_SIZES.md} /> : <ChevronRight size={ICON_SIZES.md} />}
          <span className="font-mono text-sm text-[var(--fg-primary)]">{run.filePath}</span>
          <span className="text-xs text-[var(--fg-muted)]">
            {new Date(run.triggeredAt).toLocaleString()}
          </span>
          {hasViolations ? (
            <span className="ml-auto flex items-center gap-1 text-amber-600 text-xs font-medium">
            <AlertTriangle size={ICON_SIZES.sm} /> {t('guard.totalViolations', { count: run.violations.length })}
            </span>
          ) : (
            <span className="ml-auto text-[var(--fg-muted)] text-xs">{t('guard.noViolations')}</span>
          )}
          </button>
          {isExpanded && (
          <div className="border-t border-[var(--border-default)] bg-[var(--bg-subtle)] p-4">
            {run.violations.length === 0 ? (
            <p className="text-sm text-[var(--fg-secondary)]">{t('guard.noViolations')}</p>
            ) : (
            <ul className="space-y-2">
              {run.violations.map((v, i) => {
              const matchedRule = rules[v.ruleId];
              return (
              <li key={i} className="flex items-start gap-2 text-sm">
                {v.severity === 'error' ? (
                <AlertCircle size={ICON_SIZES.md} className="text-red-500 shrink-0 mt-0.5" />
                ) : (
                <AlertTriangle size={ICON_SIZES.md} className="text-amber-500 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 space-y-1.5">
                <div>
                  <span className="font-mono text-xs text-[var(--fg-secondary)]">[{v.ruleId}] {v.filePath ? `${v.filePath}:${v.line}` : `L${v.line}`}</span>
                  {v.dimension && (
                  <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--fg-secondary)]">
                    {v.dimension === 'file' ? t('guard.dimFile') : v.dimension === 'target' ? t('guard.dimTarget') : t('guard.dimProject')}
                  </span>
                  )}
                  <span className="text-[var(--fg-primary)] ml-2">{ruleMsg(v.ruleId, v.message)}</span>
                </div>
                {v.snippet && (
                  <pre className="text-xs text-[var(--fg-secondary)] bg-[var(--bg-subtle)] p-2 rounded overflow-x-auto">
                  {v.snippet}
                  </pre>
                )}
                {/* ── 规则溯源增强 ── */}
                {matchedRule && (matchedRule.rationale || matchedRule.fixSuggestions?.length || matchedRule.sourceRecipe || matchedRule.note) && (
                  <div className="mt-1 rounded-lg border border-blue-100 bg-blue-50/50 p-2.5 text-xs space-y-1.5">
                  {matchedRule.rationale && (
                    <div className="flex items-start gap-1.5">
                    <BookOpen size={12} className="text-blue-500 shrink-0 mt-0.5" />
                    <div><span className="font-bold text-blue-700">{t('guard.rationale')}：</span><span className="text-[var(--fg-secondary)]">{matchedRule.rationale}</span></div>
                    </div>
                  )}
                  {matchedRule.fixSuggestions && matchedRule.fixSuggestions.length > 0 && (
                    <div className="flex items-start gap-1.5">
                    <Wrench size={12} className="text-emerald-500 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold text-emerald-700">{t('guard.fixSuggestion')}：</span>
                      <ul className="mt-0.5 space-y-0.5 text-[var(--fg-secondary)]">
                      {matchedRule.fixSuggestions.map((s, j) => (
                        <li key={j} className="flex items-start gap-1">
                        <span className="text-emerald-400 mt-0.5">•</span>
                        <span>{s}</span>
                        <button
                          className="ml-1 text-blue-500 hover:text-blue-700"
                          title={t('guard.copyFixSuggestion')}
                          onClick={() => navigator.clipboard.writeText(s)}
                        >
                          ⎘
                        </button>
                        </li>
                      ))}
                      </ul>
                    </div>
                    </div>
                  )}
                  {matchedRule.sourceRecipe && (
                    <div className="flex items-center gap-1.5">
                    <Link2 size={12} className="text-indigo-500 shrink-0" />
                    <span className="font-bold text-indigo-700">{t('guard.sourceRecipe')}：</span>
                    <span className="text-indigo-600 font-mono">{matchedRule.sourceRecipe}</span>
                    </div>
                  )}
                  {!matchedRule.rationale && matchedRule.note && (
                    <div className="text-[var(--fg-secondary)] italic">{t('guard.noteLabel')}：{matchedRule.note}</div>
                  )}
                  </div>
                )}
                </div>
              </li>
              );
              })}
            </ul>
            )}
          </div>
          )}
        </div>
        );
      })}
      </div>
    )}
    </section>
    </div>
  </div>
  );
};

export default GuardView;
