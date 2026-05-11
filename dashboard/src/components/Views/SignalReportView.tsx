import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  FileText,
  Filter,
  Loader2,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  Zap,
} from 'lucide-react';

import api, {
  type BootstrapReport,
  type BootstrapReportSummary,
  type ReportEntry,
  type SignalEntry,
} from '../../api';
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

type ViewMode = 'signals' | 'reports' | 'logs';
type ReportTypeFilter = 'all' | 'bootstrap' | 'pipeline';

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

function BootstrapReportCard({
  summary,
  detail,
  onLoadDetail,
}: {
  summary: BootstrapReportSummary;
  detail?: BootstrapReport | null;
  onLoadDetail(sessionId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const timestamp = summary.timestamp ? new Date(summary.timestamp).getTime() : Date.now();
  const successRate = ((summary.terminalSuccessRate || 0) * 100).toFixed(0);

  return (
    <div
      className="border border-[var(--border-default)] rounded-lg p-3 hover:bg-[var(--bg-muted)]/40 transition-colors cursor-pointer"
      onClick={() => {
        const next = !expanded;
        setExpanded(next);
        if (next && summary.sessionId && detail === undefined) {
          onLoadDetail(summary.sessionId);
        }
      }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
          bootstrap
        </span>
        <span className="text-[var(--fg-default)] font-medium truncate">
          {summary.terminalCapability || 'baseline'}
        </span>
        <span className="text-[var(--fg-subtle)] text-xs truncate">
          candidates={summary.candidates ?? 0}
        </span>
        <span className="text-[var(--fg-subtle)] text-xs truncate">
          tools={summary.toolCalls ?? 0}
        </span>
        <span className="text-[var(--fg-subtle)] text-xs truncate">
          terminal={summary.terminalEnabled ? `${successRate}%` : 'off'}
        </span>
        <span className="ml-auto shrink-0 text-xs text-[var(--fg-subtle)] tabular-nums">
          {formatTime(timestamp)}
        </span>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 text-xs">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Metric label="duration" value={`${summary.durationMs ?? 0}ms`} />
            <Metric label="mode" value={String(summary.mode || 'full')} />
            <Metric label="terminal" value={summary.terminalEnabled ? 'enabled' : 'baseline'} />
            <Metric label="session" value={summary.sessionId || '-'} />
          </div>
          {detail ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <Metric label="stage toolsets" value={String(detail.stageToolsets?.length || 0)} />
                <Metric label="blocked" value={String(detail.toolUsage?.blocked || 0)} />
                <Metric label="timeouts" value={String(detail.toolUsage?.timeouts || 0)} />
              </div>
              <pre className="text-xs text-[var(--fg-secondary)] bg-[var(--bg-muted)] rounded p-2.5 overflow-x-auto whitespace-pre-wrap max-h-80">
                {JSON.stringify(detail, null, 2)}
              </pre>
            </>
          ) : (
            <div className="text-[var(--fg-subtle)]">Loading report detail...</div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-[var(--bg-muted)] p-2">
      <div className="text-[var(--fg-subtle)]">{label}</div>
      <div className="font-medium text-[var(--fg-default)] truncate">{value}</div>
    </div>
  );
}

/* ═══ Log Entry Types ═══ */

interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  tag?: string;
  raw: string;
}

const LOG_LEVEL_COLORS: Record<string, string> = {
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  debug: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const ts = entry.timestamp ? new Date(entry.timestamp) : null;
  const timeStr = ts
    ? `${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`
    : '';

  return (
    <div
      className="border border-[var(--border-default)] rounded-lg px-3 py-2 hover:bg-[var(--bg-muted)]/40 transition-colors cursor-pointer font-mono text-xs"
      onClick={() => { setExpanded(!expanded); }}
    >
      <div className="flex items-center gap-2">
        {timeStr && (
          <span className="shrink-0 text-[var(--fg-subtle)] tabular-nums">{timeStr}</span>
        )}
        {entry.level && (
          <span className={`px-1.5 py-0.5 rounded text-xs font-medium uppercase ${LOG_LEVEL_COLORS[entry.level] ?? LOG_LEVEL_COLORS.debug}`}>
            {entry.level}
          </span>
        )}
        {entry.tag && (
          <span className="text-[var(--fg-secondary)] shrink-0">[{entry.tag}]</span>
        )}
        <span className="text-[var(--fg-default)] truncate">{entry.message || entry.raw}</span>
      </div>
      {expanded && (
        <pre className="mt-2 text-xs text-[var(--fg-secondary)] bg-[var(--bg-muted)] rounded p-2.5 overflow-x-auto whitespace-pre-wrap">
          {entry.raw}
        </pre>
      )}
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
  const [reportTypeFilter, setReportTypeFilter] = useState<ReportTypeFilter>('all');
  const [bootstrapReports, setBootstrapReports] = useState<BootstrapReportSummary[]>([]);
  const [bootstrapDetails, setBootstrapDetails] = useState<Record<string, BootstrapReport | null>>({});
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logLevel, setLogLevel] = useState<string>('');
  const [logSearch, setLogSearch] = useState<string>('');

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
        if (reportTypeFilter !== 'bootstrap') {
          const result = await api.getReports({ ...timeOpts, limit: 50 });
          setReports(result.reports);
          setReportTotal(result.total);
        } else {
          setReports([]);
          setReportTotal(0);
        }
        if (reportTypeFilter !== 'pipeline') {
          const result = await api.listBootstrapReports();
          setBootstrapReports(result.reports || []);
        } else {
          setBootstrapReports([]);
        }
      } else {
        const result = await api.getLogs({
          limit: 200,
          level: logLevel || undefined,
          search: logSearch || undefined,
        });
        setLogEntries(result.entries);
        setLogTotal(result.total);
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [viewMode, timeOpts, typeFilter, logLevel, logSearch, reportTypeFilter]);

  const loadBootstrapDetail = useCallback(async (sessionId: string) => {
    if (!sessionId) { return; }
    setBootstrapDetails((prev) =>
      Object.prototype.hasOwnProperty.call(prev, sessionId)
        ? prev
        : { ...prev, [sessionId]: null }
    );
    try {
      const detail = await api.getBootstrapReport(sessionId);
      setBootstrapDetails((prev) => ({ ...prev, [sessionId]: detail }));
    } catch {
      setBootstrapDetails((prev) => ({ ...prev, [sessionId]: null }));
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

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

          {viewMode === 'reports' && (
            <select
              value={reportTypeFilter}
              onChange={(e) => { setReportTypeFilter(e.target.value as ReportTypeFilter); }}
              className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--fg-default)] pr-7"
            >
              <option value="all">all reports</option>
              <option value="bootstrap">bootstrap</option>
              <option value="pipeline">pipeline</option>
            </select>
          )}

          {/* Logs filters */}
          {viewMode === 'logs' && (
            <>
              <select
                value={logLevel}
                onChange={(e) => { setLogLevel(e.target.value); }}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--fg-default)] pr-7 appearance-none bg-[length:16px] bg-[right_0.4rem_center] bg-no-repeat bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')]"
              >
                <option value="">{t('signals.logAllLevels')}</option>
                <option value="error">error</option>
                <option value="warn">warn</option>
                <option value="info">info</option>
                <option value="debug">debug</option>
              </select>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--fg-subtle)]" />
                <input
                  type="text"
                  placeholder={t('signals.logSearchPlaceholder')}
                  value={logSearch}
                  onChange={(e) => { setLogSearch(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { fetchData(); } }}
                  className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--fg-default)] w-44"
                />
              </div>
            </>
          )}

          {/* View mode tabs */}
          <div className="flex items-center gap-1">
            {([
              ['signals', <Zap key="s" size={13} />, t('signals.tabSignals')],
              ['reports', <FileText key="r" size={13} />, t('signals.tabReports')],
              ['logs', <ScrollText key="l" size={13} />, t('signals.tabLogs')],
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
      {loading && !signals.length && !reports.length && !logEntries.length ? (
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
            {t('signals.showingReports', {
              shown: reports.length + bootstrapReports.length,
              total: reportTotal + bootstrapReports.length,
            })}
          </div>
          {reports.length === 0 && bootstrapReports.length === 0 ? (
            <div className="text-center py-12 text-[var(--fg-subtle)]">
              <FileText size={32} className="mx-auto mb-2 opacity-40" />
              <p>{t('signals.noReports')}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {bootstrapReports.map((summary) => (
                <BootstrapReportCard
                  key={summary.sessionId}
                  summary={summary}
                  detail={bootstrapDetails[summary.sessionId]}
                  onLoadDetail={loadBootstrapDetail}
                />
              ))}
              {reports.map((r) => (
                <ReportCard key={r.id} report={r} />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Logs view */
        <div className="space-y-2">
          <div className="text-xs text-[var(--fg-subtle)]">
            {t('signals.showingLogs', { count: logTotal })}
          </div>
          {logEntries.length === 0 ? (
            <div className="text-center py-12 text-[var(--fg-subtle)]">
              <ScrollText size={32} className="mx-auto mb-2 opacity-40" />
              <p>{t('signals.noLogs')}</p>
            </div>
          ) : (
            <div className="space-y-1">
              {logEntries.map((entry, i) => (
                <LogEntryRow key={`${entry.timestamp}-${i}`} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SignalReportView;
