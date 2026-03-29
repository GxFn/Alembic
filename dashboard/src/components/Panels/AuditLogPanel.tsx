import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../api';

interface AuditLogEntry {
  timestamp: string;
  actor: string;
  action: string;
  result: string;
  target: string;
  details?: string;
}

interface AuditLogPanelProps {
  open: boolean;
  onToggle: () => void;
}

const PAGE_SIZE = 20;

const ACTION_BADGE: Record<string, string> = {
  create: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  update: 'bg-blue-100 text-blue-700 border-blue-200',
  delete: 'bg-red-100 text-red-700 border-red-200',
  transition: 'bg-purple-100 text-purple-700 border-purple-200',
};

const RESULT_STYLE: Record<string, string> = {
  success: 'text-emerald-600',
  failure: 'text-red-600',
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function truncate(text: string, max = 48): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

const AuditLogPanel: React.FC<AuditLogPanelProps> = ({ open, onToggle }) => {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setLoading(true);

    api
      .getAuditLogs({ offset: 0, limit: PAGE_SIZE })
      .then((data) => {
        if (!cancelled) {
          setLogs(data.logs);
          setTotal(data.total);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLogs([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleLoadMore = () => {
    setLoadingMore(true);
    api
      .getAuditLogs({ offset: logs.length, limit: PAGE_SIZE })
      .then((data) => {
        setLogs((prev) => [...prev, ...data.logs]);
        setTotal(data.total);
      })
      .catch(() => {})
      .finally(() => {
        setLoadingMore(false);
      });
  };

  const hasMore = logs.length < total;

  return (
    <div className="border border-[var(--border-default)] rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 bg-[var(--bg-surface)] cursor-pointer flex items-center justify-between hover:bg-[var(--bg-subtle)] transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--fg-primary)]">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          📋 审计日志
        </span>
        {total > 0 && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-bold border border-slate-200">
            {total}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-[var(--border-default)]">
          {loading ? (
            <div className="px-4 py-6 text-center text-sm text-[var(--fg-secondary)]">
              加载中…
            </div>
          ) : logs.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-[var(--fg-secondary)]">
              暂无审计日志
            </div>
          ) : (
            <>
              <div className="max-h-64 overflow-y-auto divide-y divide-[var(--border-subtle)]">
                {logs.map((entry, idx) => {
                  const actionCls =
                    ACTION_BADGE[entry.action] ??
                    'bg-slate-100 text-slate-600 border-slate-200';
                  const resultCls =
                    RESULT_STYLE[entry.result] ?? 'text-[var(--fg-secondary)]';

                  return (
                    <div key={idx} className="px-4 py-2 text-sm flex items-center gap-3 flex-wrap">
                      <span className="text-xs text-[var(--fg-muted)] shrink-0 w-36">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                      <span className="text-xs font-medium text-[var(--fg-primary)] shrink-0">
                        {entry.actor}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${actionCls}`}
                      >
                        {entry.action}
                      </span>
                      <span className={`text-xs font-medium shrink-0 ${resultCls}`}>
                        {entry.result}
                      </span>
                      <span
                        className="text-xs text-[var(--fg-secondary)] truncate min-w-0"
                        title={entry.target}
                      >
                        {truncate(entry.target)}
                      </span>
                    </div>
                  );
                })}
              </div>
              {hasMore && (
                <div className="px-4 py-2 border-t border-[var(--border-default)] text-center">
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                  >
                    {loadingMore ? '加载中…' : '加载更多'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default AuditLogPanel;
