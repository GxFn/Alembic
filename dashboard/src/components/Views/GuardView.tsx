import React, { useState, useEffect, useMemo } from 'react';
import { Shield, AlertTriangle, AlertCircle, Trash2, ChevronDown, ChevronRight, ExternalLink, BookOpen, Wrench, Link2, Filter, Info } from 'lucide-react';
import api from '../../api';
import { notify } from '../../utils/notification';
import { GITHUB_ISSUES_NEW_GUARD_URL, LANGUAGE_OPTIONS } from '../../constants';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import { getErrorMessage } from '../../utils/error';

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

interface GuardReportBoundary {
  type: string;
  description: string;
  affectedRules: string[];
  suggestedAction: string;
}

interface GuardReport {
  complianceScore: number;
  coverageScore: number;
  confidenceScore: number;
  qualityGate: { status: 'PASS' | 'WARN' | 'FAIL'; score: number };
  uncertainSummary: {
    total: number;
    byLayer: Record<string, number>;
    byReason: Record<string, number>;
  };
  boundaries: GuardReportBoundary[];
  summary: {
    filesScanned: number;
    totalViolations: number;
    errors: number;
    warnings: number;
    infos: number;
  };
  topViolations: {
    ruleId: string;
    message: string;
    severity: string;
    fileCount: number;
    occurrences: number;
  }[];
  fileHotspots: { filePath: string; violationCount: number; errorCount: number }[];
  trend: { errorsChange: number; warningsChange: number; hasHistory: boolean };
}

type GuardTab = 'violations' | 'uncertain' | 'rules' | 'boundaries' | 'audit';

const CIRCLE_RADIUS = 36;
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

const CircularProgress: React.FC<{ value: number; label: string; suffix?: string; hint?: string }> = ({ value, label, suffix = '', hint }) => {
  const clamped = Math.max(0, Math.min(100, value));
  const offset = CIRCLE_CIRCUMFERENCE - (clamped / 100) * CIRCLE_CIRCUMFERENCE;
  const color =
    clamped >= 80 ? '#3b82f6' :
    clamped >= 50 ? '#f59e0b' :
    '#ef4444';

  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg width="84" height="84" viewBox="0 0 84 84">
        <circle cx="42" cy="42" r={CIRCLE_RADIUS} fill="none" className="stroke-[var(--border-default)]" strokeWidth="6" opacity={0.3} />
        <circle
          cx="42" cy="42" r={CIRCLE_RADIUS} fill="none"
          stroke={color} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={CIRCLE_CIRCUMFERENCE} strokeDashoffset={offset}
          transform="rotate(-90 42 42)"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
        <text x="42" y="38" textAnchor="middle" fontSize="20" fontWeight="700" fill={color} dominantBaseline="central">
          {clamped}
        </text>
        <text x="42" y="58" textAnchor="middle" fontSize="10" className="fill-[var(--fg-muted)]" dominantBaseline="central">
          {suffix}
        </text>
      </svg>
      <span className="text-xs font-medium text-[var(--fg-secondary)]">{label}</span>
      {hint && <span className="text-[10px] text-[var(--fg-muted)] text-center leading-tight">{hint}</span>}
    </div>
  );
};

const GATE_STYLES: Record<string, string> = {
  PASS: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700',
  WARN: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700',
  FAIL: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700',
};

const GateStatusBadge: React.FC<{ status: string; label: string }> = ({ status, label }) => {
  const key = status.toUpperCase();
  const cls = GATE_STYLES[key] || GATE_STYLES.FAIL;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className={`w-[84px] h-[84px] rounded-full flex items-center justify-center border-2 ${cls}`}>
        <span className="text-lg font-extrabold tracking-wide">{key}</span>
      </div>
      <span className="text-xs font-medium text-[var(--fg-secondary)]">{label}</span>
    </div>
  );
};

const TAB_KEYS: GuardTab[] = ['rules', 'violations', 'uncertain', 'boundaries', 'audit'];
const TAB_I18N_KEYS: Record<GuardTab, string> = {
  violations: 'guard.tabViolations',
  uncertain: 'guard.tabUncertain',
  rules: 'guard.tabRules',
  boundaries: 'guard.tabBoundaries',
  audit: 'guard.tabAudit',
};

const GuardView: React.FC<{ onRefresh?: () => void }> = ({ onRefresh }) => {
  const { t } = useI18n();
  const [rules, setRules] = useState<Record<string, GuardRule>>({});
  const [runs, setRuns] = useState<GuardRun[]>([]);
  const [projectLanguages, setProjectLanguages] = useState<string[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [guardReport, setGuardReport] = useState<GuardReport | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<GuardTab>('violations');
  const [auditLogs, setAuditLogs] = useState<{ timestamp: string; actor: string; action: string; result: string; target: string }[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);

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

  useEffect(() => {
  let cancelled = false;
  setReportLoading(true);
  api.getGuardReport()
    .then((data: GuardReport | null) => {
    if (!cancelled && data) {
      setGuardReport(data);
    }
    })
    .catch(() => {
    if (!cancelled) {
      setGuardReport(null);
    }
    })
    .finally(() => {
    if (!cancelled) {
      setReportLoading(false);
    }
    });
  return () => { cancelled = true; };
  }, []);

  const handleClearViolations = async () => {
  if (!window.confirm(t('guard.clearConfirm'))) return;
  try {
    await api.clearViolations();
    fetchGuard();
    onRefresh?.();
  } catch (err: unknown) {
    notify(getErrorMessage(err, t('common.operationFailed')), { title: t('common.operationFailed'), type: 'error' });
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

    {/* ── 指标卡片 ── */}
    {!reportLoading && guardReport && (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5 shrink-0">
      <div className="flex items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-4 px-3">
        <CircularProgress value={guardReport.complianceScore} label={t('guard.metricCompliance')} suffix="/100" hint={t('guard.hintCompliance')} />
      </div>
      <div className="flex items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-4 px-3">
        <CircularProgress value={guardReport.coverageScore} label={t('guard.metricCoverage')} suffix="/100" hint={t('guard.hintCoverage')} />
      </div>
      <div className="flex items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-4 px-3">
        <CircularProgress value={guardReport.confidenceScore} label={t('guard.metricConfidence')} suffix="%" hint={t('guard.hintConfidence')} />
      </div>
      <div className="flex items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-4 px-3">
        <GateStatusBadge status={guardReport.qualityGate.status} label={t('guard.metricQualityGate')} />
      </div>
    </div>
    )}
    {reportLoading && (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5 shrink-0">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-4 px-3 h-[130px]">
          <div className="w-[84px] h-[84px] rounded-full border-4 border-[var(--border-default)] animate-pulse" />
        </div>
      ))}
    </div>
    )}

    {/* ── Tab 导航 ── */}
    <div className="flex items-center gap-1.5 mb-4 shrink-0">
      {TAB_KEYS.map(tab => {
        const isActive = activeTab === tab;
        let badge: React.ReactNode = null;
        if (tab === 'violations' && totalViolations > 0) {
          badge = <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 font-bold">{totalViolations}</span>;
        }
        if (tab === 'uncertain' && guardReport?.uncertainSummary.total) {
          badge = <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 font-bold">{guardReport.uncertainSummary.total}</span>;
        }
        if (tab === 'rules') {
          badge = <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold">{ruleEntries.length}</span>;
        }
        if (tab === 'boundaries' && guardReport?.boundaries.length) {
          badge = <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-bold">{guardReport.boundaries.length}</span>;
        }
        return (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center ${
            isActive
              ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-emphasis)]'
              : 'text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] border border-transparent'
            }`}
          >
            {t(TAB_I18N_KEYS[tab])}{badge}
          </button>
        );
      })}
    </div>

    {/* ── 内容区域 ── */}
    <div className="flex-1 overflow-y-auto pr-1 pb-6">

    {/* ── Rules Tab ── */}
    {activeTab === 'rules' && (
    <section className="mb-8">
    <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
      <h3 className="text-sm font-semibold text-[var(--fg-primary)] flex items-center gap-1.5">
        <Filter size={14} className="text-[var(--fg-muted)]" />
        {t('guard.tableHeaders.rule')}
        <span className="text-[var(--fg-muted)] font-normal">（{filteredEntries.length}/{ruleEntries.length}）</span>
      </h3>
      <div className="flex items-center gap-2 flex-wrap">
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
            {categoryLabel(r.category)}
          </td>
          </tr>
        ))
        )}
      </tbody>
      </table>
    </div>
    </section>
    )}

    {/* ── Violations Tab ── */}
    {activeTab === 'violations' && (
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
                          onClick={() => navigator.clipboard.writeText(s).catch(() => { /* clipboard fallback: user denied or insecure context */ })}
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
    )}

    {/* ── Uncertain Tab ── */}
    {activeTab === 'uncertain' && (
    <section>
      {!guardReport || guardReport.uncertainSummary.total === 0 ? (
        <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-xl py-12 text-center text-[var(--fg-secondary)]">
          暂无不确定检查结果
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
              <h4 className="text-sm font-semibold text-[var(--fg-primary)] mb-3">按层级分布</h4>
              <div className="space-y-2">
                {Object.entries(guardReport.uncertainSummary.byLayer).map(([layer, count]) => (
                  <div key={layer} className="flex items-center justify-between">
                    <span className="text-sm text-[var(--fg-secondary)]">{layer}</span>
                    <span className="text-sm font-mono font-bold text-purple-600">{count}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
              <h4 className="text-sm font-semibold text-[var(--fg-primary)] mb-3">按原因分布</h4>
              <div className="space-y-2">
                {Object.entries(guardReport.uncertainSummary.byReason).map(([reason, count]) => (
                  <div key={reason} className="flex items-center justify-between">
                    <span className="text-sm text-[var(--fg-secondary)]">{reason}</span>
                    <span className="text-sm font-mono font-bold text-purple-600">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-50 border border-purple-100 text-xs text-purple-700">
            <AlertTriangle size={14} className="shrink-0" />
            <span>共 {guardReport.uncertainSummary.total} 项检查因静态分析局限或规则覆盖不足而无法确定结果，建议补充规则或人工复查。</span>
          </div>
        </div>
      )}
    </section>
    )}

    {/* ── Boundaries Tab ── */}
    {activeTab === 'boundaries' && (
    <section>
      {!guardReport || guardReport.boundaries.length === 0 ? (
        <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-xl py-12 text-center text-[var(--fg-secondary)]">
          暂无能力边界信息
        </div>
      ) : (
        <div className="space-y-3">
          {guardReport.boundaries.map((b, i) => (
            <div key={i} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200 font-medium">
                  {b.type}
                </span>
                <span className="text-sm font-medium text-[var(--fg-primary)]">{b.description}</span>
              </div>
              {b.affectedRules.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-[var(--fg-muted)]">受影响规则：</span>
                  {b.affectedRules.map(rId => (
                    <span key={rId} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 font-mono">
                      {rId}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-start gap-1.5 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                <Wrench size={12} className="shrink-0 mt-0.5" />
                <span>{b.suggestedAction}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
    )}

    {/* ── Audit Tab ── */}
    {activeTab === 'audit' && (
    <AuditTabContent
      logs={auditLogs}
      total={auditTotal}
      loading={auditLoading}
      onLoad={() => {
        setAuditLoading(true);
        api.getAuditLogs({ offset: 0, limit: 50 })
          .then((data) => {
            setAuditLogs(data?.logs ?? []);
            setAuditTotal(data?.total ?? 0);
          })
          .catch(() => {
            setAuditLogs([]);
            setAuditTotal(0);
          })
          .finally(() => setAuditLoading(false));
      }}
      onLoadMore={() => {
        api.getAuditLogs({ offset: auditLogs.length, limit: 50 })
          .then((data) => {
            setAuditLogs((prev) => [...prev, ...(data?.logs ?? [])]);
            setAuditTotal(data?.total ?? 0);
          })
          .catch(() => {});
      }}
      t={t}
    />
    )}

    </div>
  </div>
  );
};

/* ───────────── Audit Tab Content ───────────── */

const AUDIT_ACTION_BADGE: Record<string, string> = {
  create: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  update: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
  delete: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
  transition: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
};

interface AuditTabContentProps {
  logs: { timestamp: string; actor: string; action: string; result: string; target: string }[];
  total: number;
  loading: boolean;
  onLoad: () => void;
  onLoadMore: () => void;
  t: (key: string) => string;
}

const AuditTabContent: React.FC<AuditTabContentProps> = ({ logs, total, loading, onLoad, onLoadMore, t }) => {
  useEffect(() => {
    onLoad();
  }, []);

  if (loading && logs.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-[var(--fg-secondary)]">
        {t('common.loading')}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-[var(--fg-secondary)]">
        {t('guard.noAuditLogs')}
      </div>
    );
  }

  return (
    <section className="space-y-2">
      {logs.map((entry, idx) => {
        const actionCls = AUDIT_ACTION_BADGE[entry.action] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
        const resultCls = entry.result === 'success'
          ? 'text-emerald-600 dark:text-emerald-400'
          : entry.result === 'failure'
            ? 'text-red-600 dark:text-red-400'
            : 'text-[var(--fg-secondary)]';

        return (
          <div key={idx} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-default)]">
            <span className="text-xs text-[var(--fg-muted)] shrink-0 w-36 tabular-nums">
              {new Date(entry.timestamp).toLocaleString()}
            </span>
            <span className="text-xs font-semibold text-[var(--fg-primary)] shrink-0">
              {entry.actor}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${actionCls}`}>
              {entry.action}
            </span>
            <span className={`text-xs font-medium shrink-0 ${resultCls}`}>
              {entry.result === 'success' ? '✓' : entry.result === 'failure' ? '✗' : entry.result}
            </span>
            <span className="text-xs text-[var(--fg-secondary)] truncate min-w-0 flex-1" title={entry.target}>
              {entry.target}
            </span>
          </div>
        );
      })}
      {logs.length < total && (
        <div className="text-center py-2">
          <button
            type="button"
            onClick={onLoadMore}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            {t('guard.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
};

export default GuardView;
