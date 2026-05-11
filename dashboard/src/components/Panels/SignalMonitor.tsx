import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Radio, Activity, X } from 'lucide-react';
import api, { type SignalEntry } from '../../api';
import { getSocket } from '../../lib/socket';
import { useI18n } from '../../i18n';

interface SignalEvent {
  type: string;
  source: string;
  target?: string | null;
  value?: number;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

interface SignalMonitorProps {
  open: boolean;
  onClose: () => void;
}

const MAX_EVENTS = 200;

const SignalMonitor: React.FC<SignalMonitorProps> = ({ open, onClose }) => {
  const { t } = useI18n();
  const [events, setEvents] = useState<SignalEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Load recent signals from REST API as initial data
    let cancelled = false;
    api.getSignalTrace({ limit: 100 }).then((result) => {
      if (cancelled) {
        return;
      }
      const mapped: SignalEvent[] = result.signals.map((s: SignalEntry) => ({
        type: s.type,
        source: s.source,
        target: s.target,
        value: s.value,
        metadata: s.metadata,
        timestamp: s.timestamp,
      }));
      setEvents(mapped);
    }).catch(() => {
      // Silently ignore – WebSocket will still work
    });

    // Listen for new real-time signals via WebSocket
    const socket = getSocket();

    const handler = (data: SignalEvent) => {
      if (paused) {
        return;
      }
      setEvents((prev) => {
        const next = [data, ...prev];
        if (next.length > MAX_EVENTS) {
          return next.slice(0, MAX_EVENTS);
        }
        return next;
      });
    };

    socket.on('signal:event', handler);

    return () => {
      cancelled = true;
      socket.off('signal:event', handler);
    };
  }, [open, paused]);

  const filtered = filter
    ? events.filter(
        (e) =>
          e.type.toLowerCase().includes(filter.toLowerCase()) ||
          e.source.toLowerCase().includes(filter.toLowerCase()),
      )
    : events;

  const typeColors: Record<string, string> = {
    guard: 'text-red-500',
    search: 'text-blue-500',
    usage: 'text-green-500',
    lifecycle: 'text-purple-500',
    exploration: 'text-cyan-500',
    quality: 'text-yellow-500',
    panorama: 'text-indigo-500',
    decay: 'text-orange-500',
    forge: 'text-pink-500',
  };

  const barColors: Record<string, string> = {
    guard: '#ef4444',
    search: '#3b82f6',
    usage: '#22c55e',
    lifecycle: '#a855f7',
    decay: '#f97316',
  };

  const STAT_TYPES = ['guard', 'search', 'usage', 'lifecycle', 'decay'] as const;
  const ANOMALY_THRESHOLD = 50;

  const signalStats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of STAT_TYPES) {
      counts[t] = 0;
    }
    for (const e of events) {
      if (e.type in counts) {
        counts[e.type]++;
      }
    }
    const max = Math.max(1, ...Object.values(counts));
    return { counts, max };
  }, [events]);

  const anomalies = useMemo(() => {
    const alerts: string[] = [];
    for (const t of STAT_TYPES) {
      if (signalStats.counts[t] > ANOMALY_THRESHOLD) {
        alerts.push(`${t} 信号量过高 (${signalStats.counts[t]})`);
      }
    }
    if (events.length > 0) {
      const latest = events[0].timestamp;
      if (Date.now() - latest > 5 * 60 * 1000) {
        alerts.push('超过 5 分钟未收到新信号');
      }
    } else if (open) {
      alerts.push('尚未收到任何信号');
    }
    return alerts;
  }, [events, signalStats, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed right-0 top-0 h-full w-80 glass-surface border-l border-[var(--border-muted)] shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-[var(--border-muted)]">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-[var(--accent)]" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">Signal Monitor</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
            {events.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPaused(!paused)}
            className={`p-1 rounded text-xs ${paused ? 'text-red-500' : 'text-green-500'} hover:bg-[var(--bg-elevated)]`}
          >
            {paused ? '▶' : '⏸'}
          </button>
          <button
            onClick={() => setEvents([])}
            className="p-1 rounded text-xs text-[var(--text-tertiary)] hover:bg-[var(--bg-elevated)]"
          >
            Clear
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-elevated)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="p-2 border-b border-[var(--border-muted)]">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by type or source..."
          className="w-full px-2 py-1 text-xs rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-muted)] focus:outline-none focus:border-[var(--accent)]"
        />
      </div>

      {/* Events List */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-[var(--text-tertiary)]">
            <Activity className="w-5 h-5 mb-2 opacity-50" />
            <span className="text-xs">Waiting for signals...</span>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-muted)]">
            {filtered.map((e, i) => (
              <div key={`${e.type}-${e.timestamp}-${i}`} className="p-2 hover:bg-[var(--bg-elevated)] transition-colors">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-mono font-semibold ${typeColors[e.type] ?? 'text-[var(--text-secondary)]'}`}>
                    {e.type}
                  </span>
                  <span className="text-[10px] text-[var(--text-tertiary)]">
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5 truncate">
                  {e.source}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 24h Signal Statistics */}
      <div className="border-t border-[var(--border-muted)] p-3 shrink-0">
        <h3 className="text-xs font-medium text-[var(--fg-muted)] uppercase tracking-wider mb-2">
          Signal Statistics
        </h3>
        <div className="space-y-1.5">
          {STAT_TYPES.map((type) => (
            <div key={type} className="flex items-center gap-2">
              <span className="text-[10px] font-mono w-14 text-[var(--text-tertiary)] text-right">
                {type}
              </span>
              <div className="flex-1 h-3 rounded-sm bg-[var(--bg-elevated)] overflow-hidden">
                <div
                  className="h-full rounded-sm transition-all duration-300"
                  style={{
                    width: `${(signalStats.counts[type] / signalStats.max) * 100}%`,
                    backgroundColor: barColors[type],
                  }}
                />
              </div>
              <span className="text-[10px] font-mono w-6 text-[var(--text-tertiary)] text-right">
                {signalStats.counts[type]}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Anomaly Alerts */}
      {anomalies.length > 0 && (
        <div className="border-t border-[var(--border-muted)] p-3 shrink-0">
          <h3 className="text-xs font-medium text-[var(--fg-muted)] uppercase tracking-wider mb-2">
            Anomaly Alerts
          </h3>
          <div className="space-y-1">
            {anomalies.map((msg, i) => (
              <div
                key={i}
                className="text-[11px] text-yellow-500 bg-yellow-500/10 rounded px-2 py-1"
              >
                ⚠️ {msg}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SignalMonitor;
