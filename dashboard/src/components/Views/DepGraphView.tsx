import React, { useState, useEffect, useMemo } from 'react';
import { RefreshCw, Layers } from 'lucide-react';
import api from '../../api';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';

interface DepGraphNode {
  id: string;
  label: string;
  type: string;
  packageDir?: string;
  packageSwift?: string;
  packageName?: string;
  targets?: string[];
  fullPath?: string;
  indirect?: boolean;
  discovererId?: string;
}

interface DepGraphEdge {
  from: string;
  to: string;
}

interface DepGraphData {
  nodes: DepGraphNode[];
  edges: DepGraphEdge[];
  projectRoot: string | null;
  generatedAt?: string;
}

const LAYER_HEIGHT = 72;
const SUB_ROW_HEIGHT = 52;
const NODE_GAP = 24;
const PADDING = 40;
const LAYER_SIDE_PADDING = 36;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 40;
const MAX_PER_ROW = 8;

/** 按依赖关系计算层级：tier 0 = 不依赖任何人（顶层），tier 越大越往下（被依赖的基础层）；遇环则按 0 处理避免栈溢出 */
function computeTiers(nodes: DepGraphNode[], edges: DepGraphEdge[]): Map<string, number> {
  const idSet = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const e of edges) {
  if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
  if (!out.has(e.from)) out.set(e.from, []);
  out.get(e.from)!.push(e.to);
  }
  const tier = new Map<string, number>();
  const computing = new Set<string>();
  function getTier(id: string): number {
  if (tier.has(id)) return tier.get(id)!;
  if (computing.has(id)) return 0;
  computing.add(id);
  const deps = out.get(id);
  if (!deps || deps.length === 0) {
    tier.set(id, 0);
    computing.delete(id);
    return 0;
  }
  const t = 1 + Math.max(...deps.map(getTier));
  tier.set(id, t);
  computing.delete(id);
  return t;
  }
  nodes.forEach((n) => getTier(n.id));
  return tier;
}

/** 计算每层需要多少子行 */
function subRowCount(count: number): number {
  return Math.ceil(count / MAX_PER_ROW);
}

/** 金字塔分层布局：顶层（根包）在上，底层（基础依赖）在下；同层节点过多时自动换行 */
function pyramidLayout(
  nodes: DepGraphNode[],
  edges: DepGraphEdge[]
): { positions: Map<string, { x: number; y: number }>; tiers: Map<string, number>; tierOrder: number[]; tierYRanges: Map<number, { y: number; h: number }> } {
  const tiers = computeTiers(nodes, edges);
  const tierToIds = new Map<number, string[]>();
  for (const n of nodes) {
  const t = tiers.get(n.id) ?? 0;
  if (!tierToIds.has(t)) tierToIds.set(t, []);
  tierToIds.get(t)!.push(n.id);
  }
  const tierOrder = [...new Set(tiers.values())].sort((a, b) => a - b);
  const displayOrder = [...tierOrder].reverse();
  const positions = new Map<string, { x: number; y: number }>();
  const tierYRanges = new Map<number, { y: number; h: number }>();
  // 每行最多 MAX_PER_ROW 个节点，计算最宽行的宽度
  const effectivePerRow = Math.min(MAX_PER_ROW, Math.max(...tierOrder.map(t => (tierToIds.get(t) ?? []).length), 1));
  const maxW = (effectivePerRow - 1) * NODE_GAP + effectivePerRow * NODE_WIDTH;
  let currentY = PADDING;
  displayOrder.forEach((tier) => {
  const ids = tierToIds.get(tier) ?? [];
  const rows = subRowCount(ids.length);
  const tierStartY = currentY;
  for (let row = 0; row < rows; row++) {
    const rowIds = ids.slice(row * MAX_PER_ROW, (row + 1) * MAX_PER_ROW);
    const rowW = (rowIds.length - 1) * NODE_GAP + rowIds.length * NODE_WIDTH;
    const offset = (maxW - rowW) / 2;
    rowIds.forEach((id, i) => {
    const x = PADDING + LAYER_SIDE_PADDING + offset + i * (NODE_WIDTH + NODE_GAP) + NODE_WIDTH / 2;
    const y = currentY + NODE_HEIGHT / 2;
    positions.set(id, { x, y });
    });
    currentY += row < rows - 1 ? SUB_ROW_HEIGHT : LAYER_HEIGHT;
  }
  const tierH = currentY - tierStartY;
  tierYRanges.set(tier, { y: tierStartY, h: tierH });
  });
  return { positions, tiers, tierOrder, tierYRanges };
}

const DepGraphView: React.FC = () => {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [data, setData] = useState<DepGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphLevel, _setGraphLevel] = useState<'package' | 'target'>('package');
  const [nodeFilter, setNodeFilter] = useState<'all' | 'internal' | 'external'>('all');

  const fetchGraph = async () => {
  setLoading(true);
  setError(null);
  try {
    const raw = await api.getDepGraph(graphLevel);
    setData({
    nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw?.edges) ? raw.edges : [],
    projectRoot: raw?.projectRoot ?? null,
    generatedAt: raw?.generatedAt,
    });
  } catch (err: any) {
    setError(err.response?.data?.error || err.message || 'Failed to load dependency graph');
  } finally {
    setLoading(false);
  }
  };

  useEffect(() => {
  fetchGraph();
  }, [graphLevel]);

  const allNodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const allEdges = Array.isArray(data?.edges) ? data.edges : [];

  // 内部/外部筛选
  const hasTypes = allNodes.some(n => n.type === 'internal' || n.type === 'external');
  const nodes = useMemo(() => {
    if (!hasTypes || nodeFilter === 'all') return allNodes;
    if (nodeFilter === 'internal') return allNodes.filter(n => n.type !== 'external');
    return allNodes.filter(n => n.type !== 'internal');
  }, [allNodes, nodeFilter, hasTypes]);
  const nodeIds = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);
  const edges = useMemo(() => {
    return allEdges.filter(e => nodeIds.has(e.from) || nodeIds.has(e.to));
  }, [allEdges, nodeIds]);

  const { positions, tiers, tierOrder, tierYRanges } = useMemo(
  () => pyramidLayout(nodes, edges),
  [nodes, edges]
  );
  const tierToIds = useMemo(() => {
  const m = new Map<number, string[]>();
  nodes.forEach((n) => {
    const t = tiers.get(n.id) ?? 0;
    if (!m.has(t)) m.set(t, []);
    m.get(t)!.push(n.id);
  });
  return m;
  }, [nodes, tiers]);
  const displayOrder = useMemo(() => [...tierOrder].reverse(), [tierOrder]);

  const { dependsOn, dependedBy } = useMemo(() => {
  const out = new Map<string, string[]>();
  const by = new Map<string, string[]>();
  edges.forEach((e) => {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
    if (!by.has(e.to)) by.set(e.to, []);
    by.get(e.to)!.push(e.from);
  });
  return { dependsOn: out, dependedBy: by };
  }, [edges]);

  const effectivePerRow = Math.min(MAX_PER_ROW, Math.max(...tierOrder.map((t) => (tierToIds.get(t) ?? []).length), 1));
  const contentWidth = (effectivePerRow - 1) * NODE_GAP + effectivePerRow * NODE_WIDTH;
  const graphWidth = contentWidth + LAYER_SIDE_PADDING * 2;
  const svgW = Math.max(600, PADDING * 2 + graphWidth);
  // 总高度：取所有节点最大 y + 余量
  const maxY = Math.max(...[...positions.values()].map(p => p.y), 0);
  const svgH = Math.max(420, maxY + NODE_HEIGHT / 2 + PADDING + 20);

  const tierColors = isDark ? [
    { bg: 'rgba(59, 130, 246, 0.14)', border: 'rgba(59, 130, 246, 0.40)', text: 'rgb(147 197 253)' },
    { bg: 'rgba(34, 197, 94, 0.14)', border: 'rgba(34, 197, 94, 0.40)', text: 'rgb(134 239 172)' },
    { bg: 'rgba(234, 179, 8, 0.14)', border: 'rgba(234, 179, 8, 0.40)', text: 'rgb(253 224 71)' },
    { bg: 'rgba(249, 115, 22, 0.14)', border: 'rgba(249, 115, 22, 0.40)', text: 'rgb(253 186 116)' },
    { bg: 'rgba(139, 92, 246, 0.14)', border: 'rgba(139, 92, 246, 0.40)', text: 'rgb(196 181 253)' },
  ] : [
    { bg: 'rgb(239 246 255)', border: 'rgb(147 197 253)', text: 'rgb(30 64 175)' },
    { bg: 'rgb(240 253 244)', border: 'rgb(134 239 172)', text: 'rgb(22 101 52)' },
    { bg: 'rgb(254 249 195)', border: 'rgb(253 224 71)', text: 'rgb(113 63 18)' },
    { bg: 'rgb(254 243 199)', border: 'rgb(253 186 116)', text: 'rgb(154 52 18)' },
    { bg: 'rgb(243 232 255)', border: 'rgb(216 180 254)', text: 'rgb(91 33 182)' },
  ];
  const getTierStyle = (tier: number) => tierColors[Math.min(tier, tierColors.length - 1)] ?? tierColors[0];

  if (loading) {
  return (
    <div className="flex items-center justify-center min-h-[320px]">
    <div className="animate-spin rounded-full h-10 w-10 border-2 border-blue-600 border-t-transparent" />
    </div>
  );
  }

  if (error) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-700 shadow-sm">
    <p>{error}</p>
    <button
      type="button"
      onClick={fetchGraph}
      className="mt-4 px-4 py-2 rounded-lg bg-red-100 hover:bg-red-200 text-red-800 font-medium text-sm transition-colors"
    >
      {t('depGraph.retry')}
    </button>
    </div>
  );
  }

  if (!data || allNodes.length === 0) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-subtle)] p-8 text-[var(--fg-secondary)] shadow-sm">
    <p className="font-medium text-[var(--fg-primary)]">{t('depGraph.noDataTitle')}</p>
    <p className="mt-2 text-sm">{t('depGraph.noDataDesc')}</p>
    </div>
  );
  }

  return (
  <div className="flex-1 flex flex-col overflow-hidden">
    {/* ── 页面头部 ── */}
    <div className="mb-4 flex flex-wrap justify-between items-center gap-3 shrink-0">
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0">
      <Layers className="text-blue-600" size={20} />
      </div>
      <div className="min-w-0">
      <h2 className="text-lg xl:text-xl font-bold text-[var(--fg-primary)]">{t('depGraph.title')}</h2>
      <p className="text-xs text-[var(--fg-muted)] mt-0.5 truncate">
        {t('depGraph.visualization')}
        {data.projectRoot && (
        <span className="ml-1">· {data.projectRoot}</span>
        )}
      </p>
      </div>
    </div>
    <div className="flex items-center gap-2 flex-wrap">
      {hasTypes && (
      <div className="flex items-center border border-[var(--border-default)] rounded-lg overflow-hidden text-xs">
        {(['all', 'internal', 'external'] as const).map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => setNodeFilter(f)}
          className={`px-3 py-1.5 font-medium transition-colors ${nodeFilter === f ? 'bg-blue-600 text-white' : 'bg-[var(--bg-surface)] text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)]'}`}
        >
          {f === 'all' ? t('depGraph.filterAll') : f === 'internal' ? t('depGraph.filterInternal') : t('depGraph.filterExternal')}
        </button>
        ))}
      </div>
      )}
      <button
      type="button"
      onClick={() => {
        fetchGraph();
      }}
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all text-[var(--fg-secondary)] bg-[var(--bg-subtle)] border border-[var(--border-default)] hover:bg-[var(--bg-subtle)]"
      >
      <RefreshCw size={14} /> {t('depGraph.refresh')}
      </button>
      <div className="flex items-center gap-2 xl:gap-3 text-xs flex-wrap">
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-default)]">
        <Layers size={14} className="text-[var(--fg-muted)]" />
        <span className="text-[var(--fg-secondary)]">{t('depGraph.packages')} <strong className="text-[var(--fg-primary)]">{nodes.length}</strong></span>
      </div>
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-100">
        <span className="text-emerald-500">{t('depGraph.dependencies')}</span>
        <strong className="text-emerald-700">{edges.length}</strong>
      </div>
      {data.generatedAt && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100">
        <span className="text-blue-500">{new Date(data.generatedAt).toLocaleString('zh-CN')}</span>
        </div>
      )}
      </div>
    </div>
    </div>

    {/* ── 内容区域 ── */}
    <div className="flex-1 overflow-y-auto pr-1 pb-6 space-y-6">

    {/* 图例 */}
    {hasTypes && (
      <div className="flex items-center gap-4 text-xs text-[var(--fg-secondary)] px-1">
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-3 h-3 rounded border-2 border-[var(--border-emphasis)] bg-[var(--bg-surface)]" /> {t('depGraph.projectRoot')}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-3 h-3 rounded border-2 border-green-400 bg-green-50" /> {t('depGraph.filterInternal')}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-3 h-3 rounded border-2 border-amber-400 bg-amber-50 border-dashed" /> {t('depGraph.filterExternal')}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-3 h-3 rounded border-2 border-amber-400 bg-amber-50 border-dashed opacity-50" /> {t('depGraph.labelIndirect')}
      </div>
      </div>
    )}

    {/* 图区域：金字塔分层（不画连线），点击节点在浮窗显示依赖 */}
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-subtle)] overflow-auto shadow-sm min-h-[480px] flex items-center justify-center relative">
    <svg
      width="100%"
      height={svgH}
      viewBox={`0 0 ${svgW} ${svgH}`}
      className="block min-h-[480px] w-full"
      style={{ maxHeight: 640 }}
    >
      <defs>
      <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.12" />
      </filter>
      </defs>
      {/* 层背景条：相对背景居中 */}
      {displayOrder.map((tier, displayIndex) => {
      const style = getTierStyle(displayIndex);
      const range = tierYRanges.get(tier);
      if (!range) return null;
      return (
        <rect
        key={tier}
        x={PADDING}
        y={range.y - NODE_HEIGHT / 2 - 4}
        width={graphWidth}
        height={range.h + 8}
        rx={8}
        fill={style.bg}
        stroke={style.border}
        strokeWidth={isDark ? 1.5 : 1}
        opacity={isDark ? 1 : 0.6}
        />
      );
      })}
      {/* 节点：选中时依赖/被依赖高亮，无关置灰；按 type 区分默认颜色 */}
      {nodes.map((node) => {
      const pos = positions.get(node.id);
      if (!pos) return null;
      const tier = tiers.get(node.id) ?? 0;
      const baseStyle = getTierStyle(displayOrder.indexOf(tier));
      const label = node.label.length > 14 ? node.label.slice(0, 13) + '…' : node.label;
      const isSelected = selectedNodeId === node.id;
      const isDependency = selectedNodeId ? (dependsOn.get(selectedNodeId) ?? []).includes(node.id) : false;
      const isDependent = selectedNodeId ? (dependedBy.get(selectedNodeId) ?? []).includes(node.id) : false;
      const isDimmed = selectedNodeId && !isSelected && !isDependency && !isDependent;

      // 根据 node.type 确定默认配色
      const typeStyle = (() => {
        if (node.type === 'external') return isDark
          ? { fill: 'rgba(234, 179, 8, 0.1)', stroke: 'rgb(202 138 4)', text: 'rgb(253 224 71)', badge: 'EXT' }
          : { fill: 'rgb(254 252 232)', stroke: 'rgb(234 179 8)', text: 'rgb(113 63 18)', badge: 'EXT' };
        if (node.type === 'internal') return isDark
          ? { fill: 'rgba(34, 197, 94, 0.1)', stroke: 'rgb(22 163 74)', text: 'rgb(134 239 172)', badge: '' }
          : { fill: 'rgb(240 253 244)', stroke: 'rgb(74 222 128)', text: 'rgb(22 101 52)', badge: '' };
        return isDark
          ? { fill: '#1e2433', stroke: baseStyle.border, text: baseStyle.text, badge: '' }
          : { fill: 'white', stroke: baseStyle.border, text: baseStyle.text, badge: '' };
      })();

      const nodeStyle = (() => {
        if (!selectedNodeId) return { fill: typeStyle.fill, stroke: typeStyle.stroke, text: typeStyle.text, strokeWidth: 2, opacity: node.indirect ? 0.55 : 1 };
        if (isSelected) return isDark
          ? { fill: '#283040', stroke: 'rgb(59 130 246)', text: 'rgb(147 197 253)', strokeWidth: 3, opacity: 1 }
          : { fill: 'white', stroke: 'rgb(59 130 246)', text: 'rgb(30 64 175)', strokeWidth: 3, opacity: 1 };
        if (isDependency) return isDark
          ? { fill: 'rgba(34, 197, 94, 0.12)', stroke: 'rgb(34 197 94)', text: 'rgb(134 239 172)', strokeWidth: 2, opacity: 1 }
          : { fill: 'rgb(240 253 244)', stroke: 'rgb(34 197 94)', text: 'rgb(22 101 52)', strokeWidth: 2, opacity: 1 };
        if (isDependent) return isDark
          ? { fill: 'rgba(139, 92, 246, 0.12)', stroke: 'rgb(139 92 246)', text: 'rgb(196 181 253)', strokeWidth: 2, opacity: 1 }
          : { fill: 'rgb(245 243 255)', stroke: 'rgb(139 92 246)', text: 'rgb(91 33 182)', strokeWidth: 2, opacity: 1 };
        return isDark
          ? { fill: '#1a1b23', stroke: 'rgb(51 65 85)', text: 'rgb(100 116 139)', strokeWidth: 1, opacity: 0.6 }
          : { fill: 'rgb(248 250 252)', stroke: 'rgb(203 213 225)', text: 'rgb(148 163 184)', strokeWidth: 1, opacity: 0.6 };
      })();
      return (
        <g
        key={node.id}
        style={{ cursor: 'pointer', opacity: nodeStyle.opacity }}
        onClick={() => setSelectedNodeId(isSelected ? null : node.id)}
        >
        <rect
          x={pos.x - NODE_WIDTH / 2}
          y={pos.y - NODE_HEIGHT / 2}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={10}
          ry={10}
          fill={nodeStyle.fill}
          stroke={nodeStyle.stroke}
          strokeWidth={nodeStyle.strokeWidth}
          filter={isDimmed ? undefined : 'url(#nodeShadow)'}
          strokeDasharray={node.type === 'external' ? '4 2' : undefined}
        />
        <text
          x={pos.x}
          y={pos.y + (typeStyle.badge ? -2 : 0)}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="12"
          fontWeight="600"
          fill={nodeStyle.text}
          pointerEvents="none"
        >
          {label}
        </text>
        {typeStyle.badge && (
          <text
          x={pos.x}
          y={pos.y + 12}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="8"
          fontWeight="500"
          fill={typeStyle.text}
          opacity={0.6}
          pointerEvents="none"
          >
          {typeStyle.badge}
          </text>
        )}
        </g>
      );
      })}
    </svg>
    {/* 浮窗：选中节点的依赖 / 被依赖 */}
    {selectedNodeId && (
      <div
      className="absolute top-4 right-4 w-72 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-lg z-10 p-4"
      role="dialog"
      aria-label={t('depGraph.dependencies')}
      >
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-[var(--border-default)]">
        <span className="font-bold text-[var(--fg-primary)]">{selectedNodeId}</span>
        <button
        type="button"
        onClick={() => setSelectedNodeId(null)}
        className="text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] text-lg leading-none"
        aria-label={t('depGraph.close')}
        >
        ×
        </button>
      </div>
      <div className="space-y-3 text-sm">
        <div>
        <div className="font-semibold text-[var(--fg-secondary)] mb-1">{t('depGraph.dependencies')}</div>
        <ul className="text-[var(--fg-primary)] space-y-0.5">
          {(dependsOn.get(selectedNodeId) ?? []).length === 0 ? (
          <li className="text-[var(--fg-muted)]">{t('depGraph.none')}</li>
          ) : (
          (dependsOn.get(selectedNodeId) ?? []).map((id) => (
            <li key={id}>→ {id}</li>
          ))
          )}
        </ul>
        </div>
        <div>
        <div className="font-semibold text-[var(--fg-secondary)] mb-1">{t('depGraph.dependents')}</div>
        <ul className="text-[var(--fg-primary)] space-y-0.5">
          {(dependedBy.get(selectedNodeId) ?? []).length === 0 ? (
          <li className="text-[var(--fg-muted)]">{t('depGraph.none')}</li>
          ) : (
          (dependedBy.get(selectedNodeId) ?? []).map((id) => (
            <li key={id}>← {id}</li>
          ))
          )}
        </ul>
        </div>
      </div>
      </div>
    )}
    </div>

    {/* 包列表 / 依赖关系小图（列表） */}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-sm">
      <h3 className="text-sm font-bold text-[var(--fg-primary)] mb-3 pb-2 border-b border-[var(--border-default)]">{t('depGraph.packageList')} ({nodes.length})</h3>
      <ul className="text-sm space-y-3 max-h-[280px] overflow-y-auto pr-1">
      {nodes.map((n) => (
        <li key={n.id} className="pb-3 border-b border-[var(--border-default)] last:border-0 last:pb-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold text-[var(--fg-primary)]">{n.label || n.id}</span>
          {n.type === 'external' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 font-medium">{t('depGraph.labelExternal')}</span>
          )}
          {n.type === 'internal' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">{t('depGraph.labelInternal')}</span>
          )}
          {n.indirect && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--fg-secondary)] border border-[var(--border-default)] font-medium">{t('depGraph.labelIndirect')}</span>
          )}
          {n.packageDir && (
          <span className="text-[var(--fg-secondary)] text-xs">· {n.packageDir}</span>
          )}
        </div>
        {n.fullPath && (
          <div className="mt-1 text-[var(--fg-muted)] text-xs truncate">{n.fullPath}</div>
        )}
        {n.targets && n.targets.length > 0 && (
          <div className="mt-1.5 text-[var(--fg-secondary)] text-xs pl-0">
          Targets: <span className="text-[var(--fg-secondary)]">{n.targets.join(', ')}</span>
          </div>
        )}
        </li>
      ))}
      </ul>
    </div>
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-sm">
      <h3 className="text-sm font-bold text-[var(--fg-primary)] mb-3 pb-2 border-b border-[var(--border-default)]">{t('depGraph.depRelations')} ({edges.length})</h3>
      <p className="text-xs text-[var(--fg-secondary)] mb-2">{t('depGraph.depRelationsDesc')}</p>
      <ul className="text-sm space-y-2 max-h-[280px] overflow-y-auto pr-1">
      {edges.map((e, i) => (
        <li key={`${e.from}-${e.to}-${i}`} className="flex items-center gap-2 text-[var(--fg-primary)]">
        <span className="font-semibold text-[var(--fg-primary)]">{e.from}</span>
        <span className="text-[var(--fg-muted)] shrink-0">→</span>
        <span className="font-semibold text-[var(--fg-primary)]">{e.to}</span>
        </li>
      ))}
      </ul>
    </div>
    {graphLevel === 'target' && (
    <p className="text-xs text-[var(--fg-secondary)] mt-2">
      {t('depGraph.targetHint')}<span className="font-mono">Package::Target</span>
    </p>
    )}
    </div>
    </div>
  </div>
  );
};

export default DepGraphView;
