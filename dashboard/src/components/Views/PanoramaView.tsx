import React, { useState, useEffect } from 'react';
import { Layers, Activity, AlertTriangle, BarChart3, RefreshCw } from 'lucide-react';
import api from '../../api';
import { useI18n } from '../../i18n';
import { getErrorMessage } from '../../utils/error';

interface PanoramaOverview {
  projectRoot: string;
  moduleCount: number;
  layerCount: number;
  totalFiles: number;
  totalRecipes: number;
  overallCoverage: number;
  layers: { name: string; moduleCount: number; fileCount?: number }[];
  cycleCount: number;
  gapCount: number;
  computedAt: string;
  stale: boolean;
}

interface PanoramaHealth {
  overallCoverage: number;
  avgCoupling: number;
  cycleCount: number;
  gapCount: number;
  highPriorityGaps: number;
  moduleCount: number;
  healthScore: number;
}

interface KnowledgeGap {
  module: string;
  type: string;
  description?: string;
  priority: string;
}

type PanoramaTab = 'overview' | 'health' | 'gaps';

const PanoramaView: React.FC = () => {
  const { t } = useI18n();
  const [tab, setTab] = useState<PanoramaTab>('overview');
  const [overview, setOverview] = useState<PanoramaOverview | null>(null);
  const [health, setHealth] = useState<PanoramaHealth | null>(null);
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, hp, gp] = await Promise.all([
        api.getPanoramaOverview(),
        api.getPanoramaHealth(),
        api.getPanoramaGaps(),
      ]);
      setOverview(ov);
      setHealth(hp);
      setGaps(gp);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to load panorama data'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-secondary)]">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        {t('panorama.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-500">
        <AlertTriangle className="w-5 h-5 mr-2" />
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-[var(--accent)]" />
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('panorama.title')}</h2>
          {overview?.stale && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
              {t('panorama.stale')}
            </span>
          )}
        </div>
        <button
          onClick={fetchData}
          className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-1 p-1 rounded-lg bg-[var(--bg-elevated)]">
        {(['overview', 'health', 'gaps'] as PanoramaTab[]).map((t2) => (
          <button
            key={t2}
            onClick={() => setTab(t2)}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === t2
                ? 'bg-[var(--accent)] text-white shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t(`panorama.${t2}`)}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'overview' && overview && <OverviewPanel overview={overview} t={t} />}
      {tab === 'health' && health && <HealthPanel health={health} t={t} />}
      {tab === 'gaps' && <GapsPanel gaps={gaps} t={t} />}
    </div>
  );
};

/* ───────────── Overview Panel ───────────── */
const OverviewPanel: React.FC<{ overview: PanoramaOverview; t: (key: string) => string }> = ({ overview, t }) => {
  const stats = [
    { label: t('panorama.modules'), value: overview.moduleCount, icon: Layers },
    { label: t('panorama.layers'), value: overview.layerCount, icon: BarChart3 },
    { label: t('panorama.files'), value: overview.totalFiles, icon: Activity },
    { label: t('panorama.recipes'), value: overview.totalRecipes, icon: Activity },
    { label: t('panorama.coverage'), value: `${overview.overallCoverage}%`, icon: BarChart3 },
    { label: t('panorama.cycles'), value: overview.cycleCount, icon: AlertTriangle },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="p-4 rounded-xl glass-surface border border-[var(--border-muted)]"
          >
            <div className="flex items-center gap-2 mb-1">
              <s.icon className="w-4 h-4 text-[var(--text-tertiary)]" />
              <span className="text-xs text-[var(--text-tertiary)]">{s.label}</span>
            </div>
            <span className="text-2xl font-bold text-[var(--text-primary)]">{s.value}</span>
          </div>
        ))}
      </div>

      {/* Layers */}
      {overview.layers.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">{t('panorama.layers')}</h3>
          <div className="space-y-2">
            {overview.layers.map((layer) => (
              <div
                key={layer.name}
                className="flex items-center justify-between p-3 rounded-lg glass-surface border border-[var(--border-muted)]"
              >
                <span className="text-sm font-medium text-[var(--text-primary)]">{layer.name}</span>
                <div className="flex gap-4 text-xs text-[var(--text-tertiary)]">
                  <span>{layer.moduleCount} {t('panorama.modules').toLowerCase()}</span>
                  {layer.fileCount !== undefined && (
                    <span>{layer.fileCount} {t('panorama.files').toLowerCase()}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ───────────── Health Panel ───────────── */
const HealthPanel: React.FC<{ health: PanoramaHealth; t: (key: string) => string }> = ({ health, t }) => {
  const scoreColor =
    health.healthScore >= 80
      ? 'text-green-500'
      : health.healthScore >= 50
        ? 'text-yellow-500'
        : 'text-red-500';

  const metrics = [
    { label: t('panorama.coverage'), value: `${health.overallCoverage}%` },
    { label: t('panorama.avgCoupling'), value: health.avgCoupling.toFixed(2) },
    { label: t('panorama.modules'), value: health.moduleCount },
    { label: t('panorama.cycles'), value: health.cycleCount },
    { label: t('panorama.gaps'), value: health.gapCount },
    { label: t('panorama.highPriorityGaps'), value: health.highPriorityGaps },
  ];

  return (
    <div className="space-y-6">
      {/* Score */}
      <div className="flex flex-col items-center p-8 rounded-xl glass-surface border border-[var(--border-muted)]">
        <span className="text-xs text-[var(--text-tertiary)] mb-2">{t('panorama.healthScore')}</span>
        <span className={`text-5xl font-bold ${scoreColor}`}>{health.healthScore}</span>
        <span className="text-sm text-[var(--text-tertiary)] mt-1">/ 100</span>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {metrics.map((m) => (
          <div key={m.label} className="p-4 rounded-xl glass-surface border border-[var(--border-muted)]">
            <span className="text-xs text-[var(--text-tertiary)]">{m.label}</span>
            <div className="text-xl font-bold text-[var(--text-primary)] mt-1">{m.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ───────────── Gaps Panel ───────────── */
const GapsPanel: React.FC<{ gaps: KnowledgeGap[]; t: (key: string) => string }> = ({ gaps, t }) => {
  if (gaps.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-[var(--text-secondary)]">
        {t('panorama.noGaps')}
      </div>
    );
  }

  const priorityColor: Record<string, string> = {
    high: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    low: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  };

  return (
    <div className="space-y-2">
      {gaps.map((g, i) => (
        <div
          key={`${g.module}-${g.type}-${i}`}
          className="flex items-center justify-between p-3 rounded-lg glass-surface border border-[var(--border-muted)]"
        >
          <div className="flex-1">
            <span className="text-sm font-medium text-[var(--text-primary)]">{g.module}</span>
            <span className="text-xs text-[var(--text-tertiary)] ml-2">{g.type}</span>
            {g.description && (
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">{g.description}</p>
            )}
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${priorityColor[g.priority] ?? priorityColor.low}`}>
            {g.priority}
          </span>
        </div>
      ))}
    </div>
  );
};

export default PanoramaView;
