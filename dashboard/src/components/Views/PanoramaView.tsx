import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  Grid3X3,
  Layers,
  RefreshCw,
  Share2,
  Shield,
} from 'lucide-react';

import api from '../../api';
import { useI18n } from '../../i18n';
import { getErrorMessage } from '../../utils/error';
import DepGraphView from './DepGraphView';
import KnowledgeGraphView from './KnowledgeGraphView';

/* ═══ Types (match backend PanoramaService.getOverview()) ═══ */

interface LayerModule {
  name: string;
  role: string;
  fileCount: number;
  recipeCount: number;
}

interface PanoramaLayer {
  level: number;
  name: string;
  modules: LayerModule[];
}

interface HealthDimension {
  id: string;
  name: string;
  description: string;
  recipeCount: number;
  score: number;
  status: string;
  level: string;
  topRecipes: string[];
}

interface HealthRadar {
  dimensions: HealthDimension[];
  overallScore: number;
  totalRecipes: number;
  coveredDimensions: number;
  totalDimensions: number;
  dimensionCoverage: number;
}

interface PanoramaOverview {
  projectRoot: string;
  moduleCount: number;
  layerCount: number;
  totalFiles: number;
  totalRecipes: number;
  overallCoverage: number;
  layers: PanoramaLayer[];
  cycleCount: number;
  gapCount: number;
  healthRadar: HealthRadar;
  computedAt: number;
  stale: boolean;
}

interface PanoramaHealth {
  healthRadar: HealthRadar;
  avgCoupling: number;
  cycleCount: number;
  gapCount: number;
  highPriorityGaps: number;
  moduleCount: number;
  healthScore: number;
}

interface KnowledgeGap {
  dimension: string;
  dimensionName: string;
  recipeCount: number;
  status: string;
  priority: string;
  suggestedTopics: string[];
  affectedRoles: string[];
}

/* ═══ Tabs ═══ */

type PanoramaTab = 'overview' | 'dependencies' | 'graph' | 'gaps';

const TAB_CONFIG: { key: PanoramaTab; icon: React.ElementType; labelKey: string }[] = [
  { key: 'overview', icon: Layers, labelKey: 'panorama.overview' },
  { key: 'dependencies', icon: GitBranch, labelKey: 'sidebar.depGraph' },
  { key: 'graph', icon: Share2, labelKey: 'sidebar.knowledgeGraph' },
  { key: 'gaps', icon: AlertTriangle, labelKey: 'panorama.gaps' },
];

/* ═══ Main Component ═══ */

const PanoramaView: React.FC = () => {
  const { t } = useI18n();
  const [tab, setTab] = useState<PanoramaTab>('overview');
  const [overview, setOverview] = useState<PanoramaOverview | null>(null);
  const [health, setHealth] = useState<PanoramaHealth | null>(null);
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const results = await Promise.allSettled([
      api.getPanoramaOverview(),
      api.getPanoramaHealth(),
      api.getPanoramaGaps(),
    ]);

    const [ovResult, hpResult, gpResult] = results;

    if (ovResult.status === 'fulfilled') { setOverview(ovResult.value); }
    if (hpResult.status === 'fulfilled') { setHealth(hpResult.value); }
    if (gpResult.status === 'fulfilled') { setGaps(gpResult.value ?? []); }

    const allFailed = results.every((r) => r.status === 'rejected');
    if (allFailed) {
      const firstErr = (results[0] as PromiseRejectedResult).reason;
      setError(getErrorMessage(firstErr, 'Failed to load panorama data'));
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const isSubViewTab = tab === 'dependencies' || tab === 'graph';

  if (!isSubViewTab && loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-secondary)]">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        {t('panorama.loading')}
      </div>
    );
  }

  if (!isSubViewTab && error && !overview && !health) {
    return (
      <div className="space-y-6">
        <PanoramaHeader t={t} stale={false} onRefresh={fetchData} />
        <TabSwitcher tab={tab} setTab={setTab} t={t} />
        <div className="flex items-center justify-center h-48 text-red-500">
          <AlertTriangle className="w-5 h-5 mr-2" />
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 h-full flex flex-col">
      <PanoramaHeader t={t} stale={overview?.stale} onRefresh={fetchData} />
      <TabSwitcher tab={tab} setTab={setTab} t={t} />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'overview' && (
          <OverviewPanel overview={overview} health={health} gaps={gaps} t={t} />
        )}
        {tab === 'dependencies' && <DepGraphView />}
        {tab === 'graph' && <KnowledgeGraphView />}
        {tab === 'gaps' && <GapsPanel gaps={gaps} t={t} />}
      </div>
    </div>
  );
};

/* ═══ Header & Tab Switcher ═══ */

const PanoramaHeader: React.FC<{ t: (k: string) => string; stale?: boolean; onRefresh: () => void }> = ({ t, stale, onRefresh }) => (
  <div className="flex items-center justify-between shrink-0">
    <div className="flex items-center gap-2">
      <Layers className="w-5 h-5 text-[var(--accent)]" />
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('panorama.title')}</h2>
      {stale && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
          {t('panorama.stale')}
        </span>
      )}
    </div>
    <button
      onClick={onRefresh}
      className="p-2 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors"
    >
      <RefreshCw className="w-4 h-4" />
    </button>
  </div>
);

const TabSwitcher: React.FC<{ tab: PanoramaTab; setTab: (t: PanoramaTab) => void; t: (k: string) => string }> = ({ tab, setTab, t: tr }) => (
  <div className="flex items-center gap-1.5 shrink-0">
    {TAB_CONFIG.map(({ key, icon: Icon, labelKey }) => (
      <button
        key={key}
        onClick={() => setTab(key)}
        className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
          tab === key
            ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-emphasis)]'
            : 'text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] border border-transparent'
        }`}
      >
        <Icon className="w-3.5 h-3.5" />
        {tr(labelKey)}
      </button>
    ))}
  </div>
);

/* ═══ Overview Panel (merged: architecture + health + summary) ═══ */

const OverviewPanel: React.FC<{
  overview: PanoramaOverview | null;
  health: PanoramaHealth | null;
  gaps: KnowledgeGap[];
  t: (k: string) => string;
}> = ({ overview, health, gaps, t }) => {
  if (!overview && !health) {
    return (
      <div className="flex items-center justify-center h-32 text-[var(--text-secondary)]">
        {t('panorama.noData') || 'No panorama data available'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StatsRow overview={overview} health={health} t={t} />
      {overview && overview.layers.length > 0 && (
        <ArchitecturePyramid layers={overview.layers} t={t} />
      )}
      {health && <HealthBar health={health} t={t} />}
      {gaps.length > 0 && <GapsSummary gaps={gaps} t={t} />}
    </div>
  );
};

/* ── Stats Row ── */

const StatsRow: React.FC<{
  overview: PanoramaOverview | null;
  health: PanoramaHealth | null;
  t: (k: string) => string;
}> = ({ overview, health, t }) => {
  const stats = useMemo(() => {
    const items: { label: string; value: string | number; icon: React.ElementType; color: string }[] = [];

    if (overview) {
      items.push(
        { label: t('panorama.modules'), value: overview.moduleCount, icon: Grid3X3, color: 'text-blue-500' },
        { label: t('panorama.layers'), value: overview.layerCount, icon: Layers, color: 'text-violet-500' },
        { label: t('panorama.files'), value: overview.totalFiles, icon: Folder, color: 'text-cyan-500' },
        { label: t('panorama.recipes'), value: overview.totalRecipes, icon: Activity, color: 'text-emerald-500' },
      );
    }

    if (health) {
      const dimCov = health.healthRadar?.dimensionCoverage ?? 0;
      const pct = `${Math.round(dimCov * 100)}%`;
      items.push(
        { label: t('panorama.coverage'), value: pct, icon: BarChart3, color: coverageTextColor(dimCov / 100) },
        { label: t('panorama.cycles'), value: overview?.cycleCount ?? health.cycleCount, icon: GitBranch, color: (overview?.cycleCount ?? health.cycleCount) > 0 ? 'text-red-500' : 'text-green-500' },
      );
    } else if (overview) {
      const pct = overview.totalFiles > 0
        ? `${Math.round((overview.totalRecipes / overview.totalFiles) * 100)}%`
        : '0%';
      items.push(
        { label: t('panorama.coverage'), value: pct, icon: BarChart3, color: 'text-gray-500' },
        { label: t('panorama.cycles'), value: overview.cycleCount, icon: GitBranch, color: overview.cycleCount > 0 ? 'text-red-500' : 'text-green-500' },
      );
    }

    return items;
  }, [overview, health, t]);

  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
      {stats.map((s) => (
        <div
          key={s.label}
          className="p-3 rounded-xl glass-surface border border-[var(--border-muted)] hover:border-[var(--border-hover)] transition-colors"
        >
          <div className="flex items-center gap-1.5 mb-1">
            <s.icon className={`w-3.5 h-3.5 ${s.color}`} />
            <span className="text-[11px] text-[var(--text-tertiary)] truncate">{s.label}</span>
          </div>
          <span className="text-xl font-bold text-[var(--text-primary)]">{s.value}</span>
        </div>
      ))}
    </div>
  );
};

/* ── Architecture Layers ── */

const LAYER_COLORS: string[] = [
  'from-violet-600 to-violet-500',     // highest level
  'from-indigo-600 to-indigo-500',
  'from-blue-600 to-blue-500',
  'from-cyan-600 to-cyan-500',
  'from-teal-600 to-teal-500',
  'from-emerald-600 to-emerald-500',
  'from-sky-600 to-sky-500',
  'from-fuchsia-600 to-fuchsia-500',
];

const LAYER_ACCENTS: string[] = [
  'border-violet-500', 'border-indigo-500', 'border-blue-500', 'border-cyan-500',
  'border-teal-500', 'border-emerald-500', 'border-sky-500', 'border-fuchsia-500',
];

const ROLE_LABELS: Record<string, { label: string; color: string }> = {
  app: { label: 'App', color: 'bg-rose-500/20 text-rose-700 dark:text-rose-300' },
  core: { label: 'Core', color: 'bg-violet-500/20 text-violet-700 dark:text-violet-300' },
  foundation: { label: 'Foundation', color: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-300' },
  service: { label: 'Service', color: 'bg-blue-500/20 text-blue-700 dark:text-blue-300' },
  networking: { label: 'Network', color: 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-300' },
  storage: { label: 'Storage', color: 'bg-teal-500/20 text-teal-700 dark:text-teal-300' },
  model: { label: 'Model', color: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' },
  ui: { label: 'UI', color: 'bg-orange-500/20 text-orange-700 dark:text-orange-300' },
  routing: { label: 'Routing', color: 'bg-amber-500/20 text-amber-700 dark:text-amber-300' },
  utility: { label: 'Utility', color: 'bg-slate-500/20 text-slate-700 dark:text-slate-300' },
  auth: { label: 'Auth', color: 'bg-red-500/20 text-red-700 dark:text-red-300' },
  feature: { label: 'Feature', color: 'bg-gray-500/20 text-gray-700 dark:text-gray-300' },
  config: { label: 'Config', color: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300' },
  test: { label: 'Test', color: 'bg-pink-500/20 text-pink-700 dark:text-pink-300' },
};

const ArchitecturePyramid: React.FC<{ layers: PanoramaLayer[]; t: (k: string) => string }> = ({ layers, t }) => {
  const [expandedLayer, setExpandedLayer] = useState<number | null>(null);

  const sortedLayers = useMemo(() =>
    [...layers].sort((a, b) => b.level - a.level),
    [layers],
  );

  return (
    <div>
      <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
        <Layers className="w-4 h-4" />
        {t('panorama.layers')}
      </h3>
      <div className="flex flex-col gap-2">
        {sortedLayers.map((layer, idx) => {
          const colorIdx = idx % LAYER_COLORS.length;
          const gradient = LAYER_COLORS[colorIdx];
          const accent = LAYER_ACCENTS[colorIdx];
          const isExpanded = expandedLayer === layer.level;
          const moduleCount = layer.modules.length;
          const totalFiles = layer.modules.reduce((s, m) => s + m.fileCount, 0);
          const totalRecipes = layer.modules.reduce((s, m) => s + m.recipeCount, 0);

          return (
            <div key={layer.level} className="w-full">
              <button
                type="button"
                onClick={() => setExpandedLayer(isExpanded ? null : layer.level)}
                className={`w-full rounded-lg border-l-4 ${accent} bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] px-4 py-2.5 flex items-center justify-between transition-all cursor-pointer`}
              >
                <div className="flex items-center gap-2.5">
                  {isExpanded
                    ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                    : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />}
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded bg-gradient-to-r ${gradient} text-white`}>
                    L{layer.level}
                  </span>
                  <span className="font-semibold text-sm text-[var(--text-primary)]">{layer.name}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)] shrink-0 ml-3">
                  <span>{moduleCount} {t('panorama.modules').toLowerCase()}</span>
                  {totalFiles > 0 && <span>{totalFiles} {t('panorama.files').toLowerCase()}</span>}
                  {totalRecipes > 0 && (
                    <span className="bg-emerald-500/15 text-emerald-400 rounded-full px-2 py-0.5 font-medium">
                      {totalRecipes} recipes
                    </span>
                  )}
                </div>
              </button>

              {isExpanded && layer.modules.length > 0 && (
                <div className="mt-1.5 ml-5 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1.5">
                  {layer.modules.map((mod) => {
                    const role = ROLE_LABELS[mod.role] ?? ROLE_LABELS.feature;
                    const cov = mod.fileCount > 0 ? Math.round((mod.recipeCount / mod.fileCount) * 100) : 0;
                    return (
                      <div
                        key={mod.name}
                        className="p-2 rounded-lg glass-surface border border-[var(--border-muted)] hover:border-[var(--border-hover)] transition-colors"
                      >
                        <div className="text-xs font-medium text-[var(--text-primary)] truncate" title={mod.name}>
                          {mod.name}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${role.color}`}>{role.label}</span>
                          {mod.fileCount > 0 && (
                            <span className="text-[10px] text-[var(--text-tertiary)]">{mod.fileCount}f</span>
                          )}
                          {cov > 0 && (
                            <span className={`text-[10px] font-medium ${covTextColor(cov)}`}>{cov}%</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ── Health Bar ── */

const HealthBar: React.FC<{ health: PanoramaHealth; t: (k: string) => string }> = ({ health, t }) => {
  const score = health.healthScore;
  const barColor = score >= 80 ? 'bg-green-500' : score >= 50 ? 'bg-yellow-500' : 'bg-red-500';
  const textColor = score >= 80 ? 'text-green-500' : score >= 50 ? 'text-yellow-500' : 'text-red-500';

  return (
    <div className="p-4 rounded-xl glass-surface border border-[var(--border-muted)]">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-[var(--text-tertiary)]" />
          <span className="text-sm font-semibold text-[var(--text-secondary)]">{t('panorama.healthScore')}</span>
        </div>
        <span className={`text-2xl font-bold ${textColor}`}>{score}<span className="text-sm text-[var(--text-tertiary)] font-normal">/100</span></span>
      </div>
      <div className="w-full h-2 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${score}%` }} />
      </div>
      <div className="flex gap-4 mt-2 text-xs text-[var(--text-tertiary)]">
        <span>{t('panorama.avgCoupling')}: {health.avgCoupling.toFixed(1)}</span>
        <span>{t('panorama.cycles')}: {health.cycleCount}</span>
        <span>{t('panorama.gaps')}: {health.gapCount}</span>
        {health.highPriorityGaps > 0 && (
          <span className="text-red-500">{t('panorama.highPriorityGaps')}: {health.highPriorityGaps}</span>
        )}
      </div>
    </div>
  );
};

/* ── Gaps Summary (on overview tab) ── */

const GapsSummary: React.FC<{ gaps: KnowledgeGap[]; t: (k: string) => string }> = ({ gaps, t }) => {
  const sorted = [...gaps].sort((a, b) => (PRIORITY_CONFIG[a.priority]?.order ?? 2) - (PRIORITY_CONFIG[b.priority]?.order ?? 2));
  const shown = sorted.slice(0, 5);

  return (
    <div>
      <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-2 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-yellow-500" />
        {t('panorama.gaps')}
        <span className="text-xs font-normal text-[var(--text-tertiary)]">({gaps.length})</span>
      </h3>
      <div className="space-y-1">
        {shown.map((g, i) => (
          <GapRow key={`${g.dimension}-${i}`} gap={g} />
        ))}
      </div>
    </div>
  );
};

/* ═══ Gaps Panel (full tab) ═══ */

const PRIORITY_CONFIG: Record<string, { color: string; order: number }> = {
  high: { color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', order: 0 },
  medium: { color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400', order: 1 },
  low: { color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', order: 2 },
};

const GapsPanel: React.FC<{ gaps: KnowledgeGap[]; t: (k: string) => string }> = ({ gaps, t }) => {
  if (gaps.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-[var(--text-secondary)]">
        {t('panorama.noGaps')}
      </div>
    );
  }

  const sorted = useMemo(() =>
    [...gaps].sort((a, b) => (PRIORITY_CONFIG[a.priority]?.order ?? 2) - (PRIORITY_CONFIG[b.priority]?.order ?? 2)),
    [gaps],
  );

  return (
    <div className="space-y-1.5">
      {sorted.map((g, i) => (
        <GapRow key={`${g.dimension}-${i}`} gap={g} detailed />
      ))}
    </div>
  );
};

const GapRow: React.FC<{ gap: KnowledgeGap; detailed?: boolean }> = ({ gap, detailed }) => {
  const pConf = PRIORITY_CONFIG[gap.priority] ?? PRIORITY_CONFIG.low;

  return (
    <div className="flex items-center justify-between p-2.5 rounded-lg glass-surface border border-[var(--border-muted)] hover:border-[var(--border-hover)] transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">{gap.dimensionName}</span>
          <span className="text-[11px] text-[var(--text-tertiary)] shrink-0">
            {gap.recipeCount}r · {gap.status}
          </span>
        </div>
        {detailed && gap.suggestedTopics && gap.suggestedTopics.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {gap.suggestedTopics.map((f) => (
              <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-tertiary)]">{f}</span>
            ))}
          </div>
        )}
        {detailed && gap.affectedRoles && gap.affectedRoles.length > 0 && (
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">Affected: {gap.affectedRoles.join(', ')}</p>
        )}
      </div>
      <span className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ml-2 ${pConf.color}`}>
        {gap.priority}
      </span>
    </div>
  );
};

/* ═══ Helpers ═══ */

function coverageTextColor(ratio: number): string {
  const pct = ratio * 100;
  if (pct >= 80) { return 'text-green-500'; }
  if (pct >= 50) { return 'text-yellow-500'; }
  return 'text-red-500';
}

function covTextColor(pct: number): string {
  if (pct >= 80) { return 'text-green-500'; }
  if (pct >= 50) { return 'text-yellow-500'; }
  if (pct > 0) { return 'text-red-500'; }
  return 'text-[var(--text-tertiary)]';
}

export default PanoramaView;
