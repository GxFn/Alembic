import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock,
  FileText,
  Filter,
  Loader2,
  Radio,
  RefreshCw,
  Zap,
} from 'lucide-react';

import api, { type ReportEntry, type SignalEntry } from '../../api';
import { useI18n } from '../../i18n';
import { getErrorMessage } from '../../utils/error';

/* ═══ Constants ═══ */

const SIGNAL_TYPE_COLORS: Record<string, string> = {
  guard: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  search: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  forge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  usage: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  lifecycle: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  quality: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  decay: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  context: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  anomaly: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  intent: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  exploration: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  panorama: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
};

const REPORT_CATEGORY_COLORS: Record<string, string> = {
  governance: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  compliance: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  metrics: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  analysis: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
};

const TIME_RANGE_KEYS = ['time1h', 'time6h', 'time24h', 'time7d', 'timeAll'] as const;
const TIME_RANGE_MS = [3600_000, 21600_000, 86400_000, 604800_000, 0] as const;

type ViewMode = 'signals' | 'reports' | 'stats';

/* ═══ Helpers ═══ */

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getBadgeClass(key: string, map: Record<string, string>): string {
  return map[key] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300';
}

/* ═══ Sub-components ═══ */

function SignalCard({ signal }: { signal: SignalEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="border border-[var(--border-default)] rounded-lg p-3 hover:bg-[var(--bg-muted)]/40 transition-colors cursor-pointer"
      onClick={() => { setExpanded(!expanded); }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${getBadgeClass(signal.type, SIGNAL_TYPE_COLORS)}`}>
          {signal.type}
        </span>
        <span className="text-[var(--fg-default)] font-medium truncate">{signal.source}</span>
        {signal.target && (
          <span className="text-[var(--fg-subtle)] truncate">→ {signal.target}</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-xs text-[var(--fg-subtle)]">
          {(signal.value * 100).toFixed(0)}%
        </span>
        <span className="shrink-0 text-xs text-[var(--fg-subtle)] tabular-nums">
          {formatTime(signal.timestamp)}
        </span>
      </div>
      {expanded && signal.metadata && (
        typeof signal.metadata === 'object' && !Array.isArray(signal.metadata) ? (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs bg-[var(--bg-muted)] rounded p-2.5">
            {Object.entries(signal.metadata).map(([k, v]) => (
              <React.Fragment key={k}>
                <span className="text-[var(--fg-secondary)] font-medium">{k}</span>
                <span className="text-[var(--fg-default)] tabular-nums">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
              </React.Fragment>
            ))}
          </div>
        ) : (
          <pre className="mt-2 text-xs text-[var(--fg-secondary)] bg-[var(--bg-muted)] rounded p-2.5 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(signal.metadata, null, 2)}
          </pre>
        )
      )}
    </div>
  );
}

function ReportCard({ report }: { report: ReportEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="border border-[var(--border-default)] rounded-lg p-3 hover:bg-[var(--bg-muted)]/40 transition-colors cursor-pointer"
      onClick={() => { setExpanded(!expanded); }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${getBadgeClass(report.category, REPORT_CATEGORY_COLORS)}`}>
          {report.category}
        </span>
        <span className="text-[var(--fg-default)] font-medium truncate">{report.type}</span>
        <span className="text-[var(--fg-subtle)] text-xs truncate">{report.producer}</span>
        {report.duration_ms != null && (
          <span className="text-xs text-[var(--fg-subtle)]">{report.duration_ms}ms</span>
        )}
        <span className="ml-auto shrink-0 text-xs text-[var(--fg-subtle)] tabular-nums">
          {formatTime(report.timestamp)}
        </span>
      </div>
      {expanded && (
        typeof report.data === 'object' && report.data && !Array.isArray(report.data) ? (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs bg-[var(--bg-muted)] rounded p-2.5">
            {Object.entries(report.data).map(([k, v]) => (
              <React.Fragment key={k}>
                <span className="text-[var(--fg-secondary)] font-medium">{k}</span>
                <span className="text-[var(--fg-default)] tabular-nums">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
              </React.Fragment>
            ))}
          </div>
        ) : (
          <pre className="mt-2 text-xs text-[var(--fg-secondary)] bg-[var(--bg-muted)] rounded p-2.5 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(report.data, null, 2)}
          </pre>
        )
      )}
    </div>
  );
}

function StatsBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 truncate text-[var(--fg-subtle)]">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-[var(--bg-muted)] overflow-hidden">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-12 text-right text-xs tabular-nums text-[var(--fg-subtle)]">{value}</span>
    </div>
  );
}

/* ═══ Main View ═══ */

const SignalReportView: React.FC = () => {
  const { t } = useI18n();

  const [viewMode, setViewMode] = useState<ViewMode>('signals');
  const [timeRange, setTimeRange] = useState(2); // index into TIME_RANGES => 24h
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data
  const [signals, setSignals] = useState<SignalEntry[]>([]);
  const [signalTotal, setSignalTotal] = useState(0);
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [reportTotal, setReportTotal] = useState(0);
  const [stats, setStats] = useState<{
    total: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
  } | null>(null);

  const timeOpts = useMemo(() => {
    const ms = TIME_RANGE_MS[timeRange];
    if (ms === 0) { return {}; }
    return { from: Date.now() - ms };
  }, [timeRange]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (viewMode === 'signals') {
        const typeArr = typeFilter ? typeFilter.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const result = await api.getSignalTrace({ ...timeOpts, type: typeArr, limit: 100 });
        setSignals(result.signals);
        setSignalTotal(result.total);
      } else if (viewMode === 'reports') {
        const result = await api.getReports({ ...timeOpts, limit: 50 });
        setReports(result.reports);
        setReportTotal(result.total);
      } else {
        const result = await api.getSignalStats(timeOpts);
        setStats(result);
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [viewMode, timeOpts, typeFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const maxStatValue = useMemo(() => {
    if (!stats) { return 1; }
    const vals = Object.values(stats.byType);
    return Math.max(...vals, 1);
  }, [stats]);

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Radio size={20} className="text-[var(--accent)]" />
          <h2 className="text-lg font-semibold text-[var(--fg-default)]">{t('signals.title')}</h2>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Type filter (signals mode) */}
          {viewMode === 'signals' && (
            <div className="relative">
              <Filter size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--fg-subtle)]" />
              <input
                type="text"
                placeholder={t('signals.filterPlaceholder')}
                value={typeFilter}
                onChange={(e) => { setTypeFilter(e.target.value); }}
                className="pl-7 pr-2 py-1.5 text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--fg-default)] w-40"
              />
            </div>
          )}

          {/* View mode tabs */}
          <div className="flex items-center gap-1">
            {([
              ['signals', <Zap key="s" size={13} />, t('signals.tabSignals')],
              ['reports', <FileText key="r" size={13} />, t('signals.tabReports')],
              ['stats', <BarChart3 key="st" size={13} />, t('signals.tabStats')],
            ] as [ViewMode, React.ReactNode, string][]).map(([mode, icon, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => { setViewMode(mode); }}
                className={`flex items-center gap-1 px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewMode === mode
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-emphasis)]'
                    : 'text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] border border-transparent'
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          {/* Time range */}
          <div className="flex items-center gap-1">
            {TIME_RANGE_KEYS.map((key, i) => (
              <button
                key={key}
                type="button"
                onClick={() => { setTimeRange(i); }}
                className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  timeRange === i
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-emphasis)]'
                    : 'text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] border border-transparent'
                }`}
              >
                {t(`signals.${key}`)}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-[var(--border-default)] text-[var(--fg-subtle)] hover:bg-[var(--bg-muted)] transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {t('signals.refresh')}
          </button>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="flex items-center gap-2 p-3 text-sm rounded-lg bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {/* ── Content ── */}
      {loading && !signals.length && !reports.length && !stats ? (
        <div className="flex items-center justify-center py-20 text-[var(--fg-subtle)]">
          <Loader2 size={24} className="animate-spin mr-2" />
          {t('signals.loading')}
        </div>
      ) : viewMode === 'signals' ? (
        <div className="space-y-2">
          <div className="text-xs text-[var(--fg-subtle)]">
            {t('signals.showingSignals', { shown: signals.length, total: signalTotal })}
          </div>
          {signals.length === 0 ? (
            <div className="text-center py-12 text-[var(--fg-subtle)]">
              <Activity size={32} className="mx-auto mb-2 opacity-40" />
              <p>{t('signals.noSignals')}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {signals.map((s, i) => (
                <SignalCard key={`${s.timestamp}-${i}`} signal={s} />
              ))}
            </div>
          )}
        </div>
      ) : viewMode === 'reports' ? (
        <div className="space-y-2">
          <div className="text-xs text-[var(--fg-subtle)]">
            {t('signals.showingReports', { shown: reports.length, total: reportTotal })}
          </div>
          {reports.length === 0 ? (
            <div className="text-center py-12 text-[var(--fg-subtle)]">
              <FileText size={32} className="mx-auto mb-2 opacity-40" />
              <p>{t('signals.noReports')}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {reports.map((r) => (
                <ReportCard key={r.id} report={r} />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Stats view */
        <div className="space-y-6">
          {stats ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="border border-[var(--border-default)] rounded-lg p-4">
                  <div className="text-xs text-[var(--fg-subtle)] mb-1">{t('signals.totalSignals')}</div>
                  <div className="text-2xl font-bold text-[var(--fg-default)] tabular-nums">{stats.total}</div>
                </div>
                <div className="border border-[var(--border-default)] rounded-lg p-4">
                  <div className="text-xs text-[var(--fg-subtle)] mb-1">{t('signals.signalTypes')}</div>
                  <div className="text-2xl font-bold text-[var(--fg-default)] tabular-nums">{Object.keys(stats.byType).length}</div>
                </div>
                <div className="border border-[var(--border-default)] rounded-lg p-4">
                  <div className="text-xs text-[var(--fg-subtle)] mb-1">{t('signals.sources')}</div>
                  <div className="text-2xl font-bold text-[var(--fg-default)] tabular-nums">{Object.keys(stats.bySource).length}</div>
                </div>
              </div>

              <div className="border border-[var(--border-default)] rounded-lg p-4">
                <h3 className="text-sm font-medium text-[var(--fg-default)] mb-3">{t('signals.byType')}</h3>
                <div className="space-y-2">
                  {Object.entries(stats.byType)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, count]) => (
                      <StatsBar key={type} label={type} value={count} max={maxStatValue} />
                    ))}
                </div>
              </div>

              <div className="border border-[var(--border-default)] rounded-lg p-4">
                <h3 className="text-sm font-medium text-[var(--fg-default)] mb-3">{t('signals.bySource')}</h3>
                <div className="space-y-2">
                  {Object.entries(stats.bySource)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 15)
                    .map(([source, count]) => (
                      <StatsBar key={source} label={source} value={count} max={maxStatValue} />
                    ))}
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-[var(--fg-subtle)]">
              <BarChart3 size={32} className="mx-auto mb-2 opacity-40" />
              <p>{t('signals.noStats')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SignalReportView;
