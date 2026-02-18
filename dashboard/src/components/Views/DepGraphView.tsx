import React, { useState, useEffect, useMemo } from 'react';
import { RefreshCw, Layers } from 'lucide-react';
import api from '../../api';
import { ICON_SIZES } from '../../constants/icons';

interface DepGraphNode {
  id: string;
  label: string;
  type: string;
  packageDir?: string;
  packageSwift?: string;
  packageName?: string;
  targets?: string[];
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

const NODE_R = 20;
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
  const [data, setData] = useState<DepGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphLevel, setGraphLevel] = useState<'package' | 'target'>('package');

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

  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const edges = Array.isArray(data?.edges) ? data.edges : [];

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

  const tierColors = [
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
      重试
    </button>
    </div>
  );
  }

  if (!data || nodes.length === 0) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-slate-600 shadow-sm">
    <p className="font-medium text-slate-700">当前项目内未扫描到 SPM 包依赖关系。</p>
    <p className="mt-2 text-sm">请确保项目根目录下存在 <code className="bg-slate-200 px-1.5 py-0.5 rounded text-slate-800">Package.swift</code> 或子目录中的 SPM 包，然后点击「Refresh Project」或执行 <code className="bg-slate-200 px-1.5 py-0.5 rounded">asd spm-map</code> 刷新。</p>
    </div>
  );
  }

  return (
  <div className="flex-1 flex flex-col overflow-hidden">
    {/* ── 页面头部 ── */}
    <div className="mb-4 flex justify-between items-center shrink-0">
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
      <Layers className="text-blue-600" size={20} />
      </div>
      <div>
      <h2 className="text-xl font-bold text-slate-800">项目依赖关系图</h2>
      <p className="text-xs text-slate-400 mt-0.5">
        SPM 包依赖结构可视化
        {data.projectRoot && (
        <span className="ml-1">· {data.projectRoot}</span>
        )}
      </p>
      </div>
    </div>
    <div className="flex items-center gap-2">
      <button
      type="button"
      onClick={() => {
        fetchGraph();
      }}
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100"
      >
      <RefreshCw size={14} /> 刷新
      </button>
      <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-100">
        <Layers size={14} className="text-slate-400" />
        <span className="text-slate-500">包 <strong className="text-slate-700">{nodes.length}</strong></span>
      </div>
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-100">
        <span className="text-emerald-500">依赖</span>
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
    <div className="flex-1 overflow-y-auto pr-1 space-y-6">

    {/* 图区域：金字塔分层（不画连线），点击节点在浮窗显示依赖 */}
    <div className="rounded-xl border border-slate-200 bg-slate-50/50 overflow-auto shadow-sm min-h-[480px] flex items-center justify-center relative">
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
        strokeWidth="1"
        opacity={0.6}
        />
      );
      })}
      {/* 节点：选中时依赖/被依赖高亮，无关置灰 */}
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
      const nodeStyle = (() => {
        if (!selectedNodeId) return { fill: 'white', stroke: baseStyle.border, text: baseStyle.text, strokeWidth: 2, opacity: 1 };
        if (isSelected) return { fill: 'white', stroke: 'rgb(59 130 246)', text: 'rgb(30 64 175)', strokeWidth: 3, opacity: 1 };
        if (isDependency) return { fill: 'rgb(240 253 244)', stroke: 'rgb(34 197 94)', text: 'rgb(22 101 52)', strokeWidth: 2, opacity: 1 };
        if (isDependent) return { fill: 'rgb(245 243 255)', stroke: 'rgb(139 92 246)', text: 'rgb(91 33 182)', strokeWidth: 2, opacity: 1 };
        return { fill: 'rgb(248 250 252)', stroke: 'rgb(203 213 225)', text: 'rgb(148 163 184)', strokeWidth: 1, opacity: 0.6 };
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
        />
        <text
          x={pos.x}
          y={pos.y}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="12"
          fontWeight="600"
          fill={nodeStyle.text}
          pointerEvents="none"
        >
          {label}
        </text>
        </g>
      );
      })}
    </svg>
    {/* 浮窗：选中节点的依赖 / 被依赖 */}
    {selectedNodeId && (
      <div
      className="absolute top-4 right-4 w-72 rounded-xl border border-slate-200 bg-white shadow-lg z-10 p-4"
      role="dialog"
      aria-label="依赖关系"
      >
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
        <span className="font-bold text-slate-800">{selectedNodeId}</span>
        <button
        type="button"
        onClick={() => setSelectedNodeId(null)}
        className="text-slate-400 hover:text-slate-600 text-lg leading-none"
        aria-label="关闭"
        >
        ×
        </button>
      </div>
      <div className="space-y-3 text-sm">
        <div>
        <div className="font-semibold text-slate-600 mb-1">依赖</div>
        <ul className="text-slate-700 space-y-0.5">
          {(dependsOn.get(selectedNodeId) ?? []).length === 0 ? (
          <li className="text-slate-400">无</li>
          ) : (
          (dependsOn.get(selectedNodeId) ?? []).map((id) => (
            <li key={id}>→ {id}</li>
          ))
          )}
        </ul>
        </div>
        <div>
        <div className="font-semibold text-slate-600 mb-1">被依赖</div>
        <ul className="text-slate-700 space-y-0.5">
          {(dependedBy.get(selectedNodeId) ?? []).length === 0 ? (
          <li className="text-slate-400">无</li>
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
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-bold text-slate-800 mb-3 pb-2 border-b border-slate-100">包列表 ({nodes.length})</h3>
      <ul className="text-sm space-y-3 max-h-[280px] overflow-y-auto pr-1">
      {nodes.map((n) => (
        <li key={n.id} className="pb-3 border-b border-slate-100 last:border-0 last:pb-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold text-slate-800">{n.id}</span>
          {n.packageDir && (
          <span className="text-slate-500 text-xs">· {n.packageDir}</span>
          )}
        </div>
        {n.targets && n.targets.length > 0 && (
          <div className="mt-1.5 text-slate-500 text-xs pl-0">
          Targets: <span className="text-slate-600">{n.targets.join(', ')}</span>
          </div>
        )}
        </li>
      ))}
      </ul>
    </div>
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-bold text-slate-800 mb-3 pb-2 border-b border-slate-100">依赖关系（小图）({edges.length})</h3>
      <p className="text-xs text-slate-500 mb-2">主图不显示连线，点击节点可在浮窗查看该包依赖；此处列出全部 From → To。</p>
      <ul className="text-sm space-y-2 max-h-[280px] overflow-y-auto pr-1">
      {edges.map((e, i) => (
        <li key={`${e.from}-${e.to}-${i}`} className="flex items-center gap-2 text-slate-700">
        <span className="font-semibold text-slate-800">{e.from}</span>
        <span className="text-slate-400 shrink-0">→</span>
        <span className="font-semibold text-slate-800">{e.to}</span>
        </li>
      ))}
      </ul>
    </div>
    {graphLevel === 'target' && (
    <p className="text-xs text-slate-500 mt-2">
      Target 级节点格式：<span className="font-mono">Package::Target</span>
    </p>
    )}
    </div>
    </div>
  </div>
  );
};

export default DepGraphView;
