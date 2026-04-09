import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { RefreshCw, Layers, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import api from '../../api';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { getErrorMessage } from '../../utils/error';

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

/* ── 自适应布局参数 ─────────────────────────────── */

/** 根据节点总数和容器宽度计算布局参数 */
function computeLayoutParams(nodeCount: number, containerWidth: number) {
  // 紧凑模式阈值
  const compact = nodeCount > 40;
  const ultraCompact = nodeCount > 120;

  const nodeWidth = ultraCompact ? 100 : compact ? 120 : 140;
  const nodeHeight = ultraCompact ? 30 : compact ? 34 : 40;
  const nodeGap = ultraCompact ? 6 : compact ? 8 : 16;
  const layerGap = ultraCompact ? 6 : compact ? 8 : 12; // 层与层之间的间距
  const layerPadY = ultraCompact ? 4 : compact ? 5 : 6;  // 层背景上下内边距
  const subRowGap = ultraCompact ? 4 : compact ? 5 : 8;  // 同层多行的行间距
  const padding = ultraCompact ? 12 : compact ? 16 : 24;
  const layerSidePadding = ultraCompact ? 10 : compact ? 14 : 20;
  const fontSize = ultraCompact ? 9 : compact ? 10.5 : 12;
  const labelMaxChars = ultraCompact ? 10 : compact ? 13 : 16;

  // 根据容器宽度计算每行最大节点数
  const usableWidth = Math.max(400, containerWidth) - padding * 2 - layerSidePadding * 2;
  const maxPerRow = Math.max(4, Math.floor((usableWidth + nodeGap) / (nodeWidth + nodeGap)));

  return { nodeWidth, nodeHeight, nodeGap, layerGap, layerPadY, subRowGap, padding, layerSidePadding, fontSize, labelMaxChars, maxPerRow };
}

type LayoutParams = ReturnType<typeof computeLayoutParams>;

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
function subRowCount(count: number, maxPerRow: number): number {
  return Math.ceil(count / maxPerRow);
}

interface TierRange { y: number; h: number; contentW: number }

/** 金字塔分层布局：顶层（根包）在上，底层（基础依赖）在下；同层节点过多时自动换行；每层背景宽度适配节点数 */
function pyramidLayout(
  nodes: DepGraphNode[],
  edges: DepGraphEdge[],
  lp: LayoutParams,
): { positions: Map<string, { x: number; y: number }>; tiers: Map<string, number>; tierOrder: number[]; tierYRanges: Map<number, TierRange>; totalWidth: number } {
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
  const tierYRanges = new Map<number, TierRange>();

  // 计算全局最宽行的宽度（用于居中对齐）
  const globalMaxPerRow = Math.min(lp.maxPerRow, Math.max(...tierOrder.map(t => (tierToIds.get(t) ?? []).length), 1));
  const totalWidth = globalMaxPerRow * lp.nodeWidth + (globalMaxPerRow - 1) * lp.nodeGap + lp.layerSidePadding * 2;
  const centerX = lp.padding + totalWidth / 2;

  let currentY = lp.padding;
  displayOrder.forEach((tier, idx) => {
  const ids = tierToIds.get(tier) ?? [];
  const rows = subRowCount(ids.length, lp.maxPerRow);

  // 计算该层最宽行（首行或节点最多行）的内容宽度
  let tierMaxRowW = 0;
  for (let row = 0; row < rows; row++) {
    const rowIds = ids.slice(row * lp.maxPerRow, (row + 1) * lp.maxPerRow);
    const rowW = rowIds.length * lp.nodeWidth + (rowIds.length - 1) * lp.nodeGap;
    tierMaxRowW = Math.max(tierMaxRowW, rowW);
  }
  const tierContentW = tierMaxRowW + lp.layerSidePadding * 2;

  const tierStartY = currentY;
  currentY += lp.layerPadY; // 层内顶部留白

  for (let row = 0; row < rows; row++) {
    const rowIds = ids.slice(row * lp.maxPerRow, (row + 1) * lp.maxPerRow);
    const rowW = rowIds.length * lp.nodeWidth + (rowIds.length - 1) * lp.nodeGap;
    rowIds.forEach((id, i) => {
    const x = centerX - rowW / 2 + i * (lp.nodeWidth + lp.nodeGap) + lp.nodeWidth / 2;
    const y = currentY + lp.nodeHeight / 2;
    positions.set(id, { x, y });
    });
    currentY += lp.nodeHeight + (row < rows - 1 ? lp.subRowGap : 0);
  }

  currentY += lp.layerPadY; // 层内底部留白
  const tierH = currentY - tierStartY;
  tierYRanges.set(tier, { y: tierStartY, h: tierH, contentW: tierContentW });

  // 层与层之间的间距
  if (idx < displayOrder.length - 1) {
    currentY += lp.layerGap;
  }
  });
  return { positions, tiers, tierOrder, tierYRanges, totalWidth };
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
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(900);

  // 监测容器宽度变化
  useEffect(() => {
    const el = containerRef.current;
    if (!el) { return; }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const handleZoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.2, 3)), []);
  const handleZoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.2, 0.3)), []);
  const handleZoomReset = useCallback(() => setZoom(1), []);

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
  } catch (err: unknown) {
    setError(getErrorMessage(err, 'Failed to load dependency graph'));
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

  // 自适应布局参数
  const lp = useMemo(() => computeLayoutParams(nodes.length, containerWidth), [nodes.length, containerWidth]);

  const { positions, tiers, tierOrder, tierYRanges, totalWidth } = useMemo(
  () => pyramidLayout(nodes, edges, lp),
  [nodes, edges, lp]
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

  const effectivePerRow = Math.min(lp.maxPerRow, Math.max(...tierOrder.map((t) => (tierToIds.get(t) ?? []).length), 1));
  const svgW = lp.padding * 2 + totalWidth;
  // 总高度：取所有节点最大 y + 余量
  const maxY = Math.max(...[...positions.values()].map(p => p.y), 0);
  const svgH = Math.max(320, maxY + lp.nodeHeight / 2 + lp.padding);

  // 自动适配缩放：当图形自然宽度 > 容器宽度时缩小以完整展示
  const autoScale = useMemo(() => {
    if (containerWidth <= 0 || svgW <= 0) { return 1; }
    const fitScale = containerWidth / svgW;
    return fitScale < 1 ? fitScale : 1;
  }, [containerWidth, svgW]);
  const effectiveZoom = zoom * autoScale;

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

    {/* 图区域：金字塔分层，点击节点在浮窗显示依赖 */}
    <div ref={containerRef} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-subtle)] overflow-auto shadow-sm relative" style={{ minHeight: 320, maxHeight: '75vh' }}>
    {/* 缩放控制 */}
    <div className="sticky top-2 right-2 z-20 flex items-center gap-1 float-right mr-2 mt-2">
      <button type="button" onClick={handleZoomOut} className="p-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:border-[var(--border-hover)] transition-colors" title="Zoom out">
      <ZoomOut size={14} />
      </button>
      <span className="text-[10px] text-[var(--fg-muted)] min-w-[3em] text-center tabular-nums">{Math.round(effectiveZoom * 100)}%</span>
      <button type="button" onClick={handleZoomIn} className="p-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:border-[var(--border-hover)] transition-colors" title="Zoom in">
      <ZoomIn size={14} />
      </button>
      <button type="button" onClick={handleZoomReset} className="p-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:border-[var(--border-hover)] transition-colors" title="Reset zoom">
      <Maximize2 size={14} />
      </button>
    </div>
    <svg
      width={svgW * effectiveZoom}
      height={svgH * effectiveZoom}
      viewBox={`0 0 ${svgW} ${svgH}`}
      className="block mx-auto"
    >
      <defs>
      <filter id="nodeShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.12" />
      </filter>
      </defs>
      {/* 层背景条：统一全宽 */}
      {displayOrder.map((tier, displayIndex) => {
      const style = getTierStyle(displayIndex);
      const range = tierYRanges.get(tier);
      if (!range) return null;
      return (
        <rect
        key={tier}
        x={lp.padding}
        y={range.y}
        width={totalWidth}
        height={range.h}
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
      const label = node.label.length > lp.labelMaxChars ? node.label.slice(0, lp.labelMaxChars - 1) + '…' : node.label;
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
        <title>{node.label}</title>
        <rect
          x={pos.x - lp.nodeWidth / 2}
          y={pos.y - lp.nodeHeight / 2}
          width={lp.nodeWidth}
          height={lp.nodeHeight}
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
          fontSize={lp.fontSize}
          fontWeight="600"
          fill={nodeStyle.text}
          pointerEvents="none"
        >
          {label}
        </text>
        {typeStyle.badge && lp.nodeHeight >= 32 && (
          <text
          x={pos.x}
          y={pos.y + 12}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={Math.max(7, lp.fontSize - 3)}
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
