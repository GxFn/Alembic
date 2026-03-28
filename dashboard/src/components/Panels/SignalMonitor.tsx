import React, { useState, useEffect, useRef } from 'react';
import { Radio, Activity, X } from 'lucide-react';
import { getSocket } from '../../lib/socket';
import { useI18n } from '../../i18n';

interface SignalEvent {
  id: string;
  type: string;
  source: string;
  timestamp: number;
  data?: Record<string, unknown>;
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
      socket.off('signal:event', handler);
    };
  }, [open, paused]);

  if (!open) {
    return null;
  }

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
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-[var(--text-tertiary)]">
            <Activity className="w-5 h-5 mb-2 opacity-50" />
            <span className="text-xs">Waiting for signals...</span>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-muted)]">
            {filtered.map((e) => (
              <div key={e.id} className="p-2 hover:bg-[var(--bg-elevated)] transition-colors">
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
    </div>
  );
};

export default SignalMonitor;
