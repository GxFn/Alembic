import React, { useEffect, useState, useMemo } from 'react';
import api from '../../api';

interface DailyRow {
  date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  call_count: number;
}

interface SourceRow {
  source: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  call_count: number;
}

interface Summary {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  call_count: number;
  avg_per_call: number;
}

/** 格式化 token 数字：1234 → "1.2k", 1234567 → "1.2M" */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/** 近 7 天日期标签完整填充（无数据的日期补 0） */
function fillDates(daily: DailyRow[]): DailyRow[] {
  const map = new Map(daily.map(d => [d.date, d]));
  const result: DailyRow[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push(map.get(key) || { date: key, input_tokens: 0, output_tokens: 0, total_tokens: 0, call_count: 0 });
  }
  return result;
}

const SOURCE_COLORS: Record<string, string> = {
  user: 'bg-blue-500',
  mcp: 'bg-purple-500',
  bootstrap: 'bg-amber-500',
  guard: 'bg-rose-500',
  analyst: 'bg-indigo-500',
  producer: 'bg-green-500',
};

const TokenUsageChart: React.FC = () => {
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [bySource, setBySource] = useState<SourceRow[]>([]);
  const [summary, setSummary] = useState<Summary>({ input_tokens: 0, output_tokens: 0, total_tokens: 0, call_count: 0, avg_per_call: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getTokenUsage7Days();
        if (cancelled) return;
        setDaily(data.daily || []);
        setBySource(data.bySource || []);
        setSummary(data.summary || { input_tokens: 0, output_tokens: 0, total_tokens: 0, call_count: 0, avg_per_call: 0 });
      } catch (e: any) {
        if (!cancelled) setError(e.message || '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filledDaily = useMemo(() => fillDates(daily), [daily]);
  const maxTokens = useMemo(() => Math.max(...filledDaily.map(d => d.total_tokens), 1), [filledDaily]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent" />
        <span className="ml-2 text-slate-500 text-sm">加载 Token 用量…</span>
      </div>
    );
  }

  if (error) {
    return <p className="text-red-500 text-sm py-4 text-center">{error}</p>;
  }

  const isEmpty = summary.total_tokens === 0;

  return (
    <div className="space-y-5">
      {/* ── 摘要卡片 ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="总 Token" value={fmtTokens(summary.total_tokens)} sub="7 日合计" color="blue" />
        <SummaryCard label="输入" value={fmtTokens(summary.input_tokens)} sub="Prompt" color="green" />
        <SummaryCard label="输出" value={fmtTokens(summary.output_tokens)} sub="Completion" color="purple" />
        <SummaryCard label="调用" value={String(summary.call_count)} sub={`均 ${fmtTokens(summary.avg_per_call)}/次`} color="amber" />
      </div>

      {isEmpty ? (
        <div className="text-center py-8 text-slate-400 text-sm">
          暂无 Token 使用记录，使用 ChatAgent 或 MCP 后数据将自动记录
        </div>
      ) : (
        <>
          {/* ── 每日柱状图 ── */}
          <div>
            <h4 className="text-sm font-semibold text-slate-700 mb-3">每日用量</h4>
            <div className="flex items-end gap-1.5 h-40">
              {filledDaily.map((d) => {
                const inputH = (d.input_tokens / maxTokens) * 100;
                const outputH = (d.output_tokens / maxTokens) * 100;
                const weekday = ['日', '一', '二', '三', '四', '五', '六'][new Date(d.date + 'T00:00:00').getDay()];
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1 group relative">
                    {/* tooltip */}
                    <div className="absolute -top-16 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-xs rounded px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                      <p>{d.date}</p>
                      <p>输入 {fmtTokens(d.input_tokens)} · 输出 {fmtTokens(d.output_tokens)}</p>
                      <p>{d.call_count} 次调用</p>
                    </div>
                    {/* bars */}
                    <div className="w-full flex flex-col justify-end" style={{ height: '120px' }}>
                      <div className="bg-green-400 rounded-t-sm w-full transition-all" style={{ height: `${inputH}%`, minHeight: d.input_tokens > 0 ? '2px' : '0' }} />
                      <div className="bg-purple-400 rounded-b-sm w-full transition-all" style={{ height: `${outputH}%`, minHeight: d.output_tokens > 0 ? '2px' : '0' }} />
                    </div>
                    <span className="text-[10px] text-slate-400">{weekday}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-4 mt-2 text-xs text-slate-500 justify-center">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-400 inline-block" /> 输入</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-purple-400 inline-block" /> 输出</span>
            </div>
          </div>

          {/* ── 来源分布 ── */}
          {bySource.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-slate-700 mb-3">来源分布</h4>
              <div className="space-y-2">
                {bySource.map((s) => {
                  const pct = summary.total_tokens > 0 ? (s.total_tokens / summary.total_tokens) * 100 : 0;
                  const barColor = SOURCE_COLORS[s.source] || 'bg-slate-400';
                  return (
                    <div key={s.source} className="flex items-center gap-3">
                      <span className="w-20 text-xs text-slate-600 text-right truncate">{s.source}</span>
                      <div className="flex-1 bg-slate-100 rounded-full h-3 overflow-hidden">
                        <div className={`${barColor} h-full rounded-full transition-all`} style={{ width: `${pct}%`, minWidth: pct > 0 ? '4px' : '0' }} />
                      </div>
                      <span className="w-16 text-xs text-slate-500 text-right">{fmtTokens(s.total_tokens)}</span>
                      <span className="w-12 text-xs text-slate-400 text-right">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

/* ── 小卡片 ── */
function SummaryCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
  };
  const cls = colorMap[color] || colorMap.blue;
  return (
    <div className={`rounded-lg border p-3 ${cls}`}>
      <p className="text-xs opacity-70">{label}</p>
      <p className="text-xl font-bold">{value}</p>
      <p className="text-[10px] opacity-60">{sub}</p>
    </div>
  );
}

export default TokenUsageChart;
