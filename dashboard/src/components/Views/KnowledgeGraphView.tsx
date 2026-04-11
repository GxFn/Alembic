import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { RefreshCw, Share2, ZoomIn, ZoomOut, Maximize2, Info, Sparkles } from 'lucide-react';
import api from '../../api';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import { ICON_SIZES } from '../../constants/icons';
import { getErrorMessage } from '../../utils/error';

// ─── Types ────────────────────────────────────────────

interface GraphEdge {
  id: number;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  relation: string;
  weight: number;
  metadata: Record<string, any>;
}

interface GraphNode {
  id: string;
  label: string;
  type: string;
  group: string;         // category/target 分组
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;        // 连接数，用于决定节点大小
}

// ─── Constants ────────────────────────────────────────

const BASE_R = 28;
const MIN_R = 22;
const MAX_R = 50;
const FONT_SIZE = 11;
const LABEL_FONT = 10;

/** 关系类型 → 颜色 */
const RELATION_COLORS: Record<string, string> = {
  depends_on:   '#3b82f6',
  requires:     '#3b82f6',
  extends:      '#10b981',
  implements:   '#10b981',
  inherits:     '#10b981',
  enforces:     '#f59e0b',
  related:      '#8b5cf6',
  conflicts:    '#ef4444',
  calls:        '#06b6d4',
  prerequisite: '#f97316',
  data_flow_to: '#14b8a6',
  references:   '#6b7280',
  alternative:  '#a855f7',
  deprecated_by:'#dc2626',
  solves:       '#22c55e',
};

const RELATION_LABELS: Record<string, string> = {
  depends_on:   '依赖',
  requires:     '需要',
  extends:      '扩展',
  implements:   '实现',
  inherits:     '继承',
  enforces:     '约束',
  related:      '关联',
  conflicts:    '冲突',
  calls:        '调用',
  prerequisite: '前置',
  data_flow_to: '数据流',
  references:   '引用',
  alternative:  '替代',
  deprecated_by:'废弃',
  solves:       '解决',
};

/** 分组颜色色板（按 category 分配）— 浅色模式 */
const GROUP_COLORS = [
  { bg: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8' },   // blue
  { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d' },   // green
  { bg: '#fef3c7', border: '#fde68a', text: '#b45309' },   // amber
  { bg: '#fdf2f8', border: '#fbcfe8', text: '#be185d' },   // pink
  { bg: '#f5f3ff', border: '#ddd6fe', text: '#7c3aed' },   // violet
  { bg: '#ecfeff', border: '#a5f3fc', text: '#0e7490' },   // cyan
  { bg: '#fff7ed', border: '#fed7aa', text: '#c2410c' },   // orange
  { bg: '#f0f9ff', border: '#bae6fd', text: '#0369a1' },   // sky
  { bg: '#fefce8', border: '#fef08a', text: '#a16207' },   // yellow
  { bg: '#f1f5f9', border: '#cbd5e1', text: '#475569' },   // slate
];

/** 分组颜色色板 — 深色模式 */
const GROUP_COLORS_DARK = [
  { bg: 'rgba(59,130,246,0.08)',  border: 'rgba(59,130,246,0.25)',  text: '#60a5fa' },   // blue
  { bg: 'rgba(34,197,94,0.08)',   border: 'rgba(34,197,94,0.25)',   text: '#4ade80' },   // green
  { bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.25)',  text: '#fbbf24' },   // amber
  { bg: 'rgba(236,72,153,0.08)',  border: 'rgba(236,72,153,0.25)',  text: '#f472b6' },   // pink
  { bg: 'rgba(139,92,246,0.08)',  border: 'rgba(139,92,246,0.25)',  text: '#a78bfa' },   // violet
  { bg: 'rgba(6,182,212,0.08)',   border: 'rgba(6,182,212,0.25)',   text: '#22d3ee' },   // cyan
  { bg: 'rgba(249,115,22,0.08)',  border: 'rgba(249,115,22,0.25)',  text: '#fb923c' },   // orange
  { bg: 'rgba(14,165,233,0.08)',  border: 'rgba(14,165,233,0.25)',  text: '#38bdf8' },   // sky
  { bg: 'rgba(234,179,8,0.08)',   border: 'rgba(234,179,8,0.25)',   text: '#facc15' },   // yellow
  { bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)', text: '#94a3b8' },   // slate
];

// ─── Utilities ────────────────────────────────────────

/** 根据节点连接数计算半径 */
function nodeRadius(degree: number): number {
  return Math.min(MAX_R, Math.max(MIN_R, BASE_R + degree * 2));
}

/** 截断标签，保留可读性 */
function truncLabel(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 1) + '…';
}

// ─── Force-directed layout (improved) ─────────────────

function buildNodes(
  edges: GraphEdge[],
  nodeLabels: Record<string, string>,
  nodeTypes: Record<string, string>,
  nodeCategories: Record<string, string>,
): GraphNode[] {
  const degreeMap = new Map<string, number>();
  for (const e of edges) {
    degreeMap.set(e.fromId, (degreeMap.get(e.fromId) || 0) + 1);
    degreeMap.set(e.toId, (degreeMap.get(e.toId) || 0) + 1);
  }
  const ids = [...degreeMap.keys()];

  // 按 group 分组，为每个 group 分配一个簇中心
  const groups = [...new Set(ids.map(id => nodeCategories[id] || 'general'))].sort();
  const groupCenters = new Map<string, { x: number, y: number }>();
  const cols = Math.ceil(Math.sqrt(groups.length));
  const spacing = 400;
  groups.forEach((g, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    groupCenters.set(g, { x: 450 + (col - (cols - 1) / 2) * spacing, y: 350 + (row - (Math.ceil(groups.length / cols) - 1) / 2) * spacing });
  });

  return ids.map((id) => {
    const group = nodeCategories[id] || 'general';
    const center = groupCenters.get(group) || { x: 450, y: 350 };
    // 在簇中心附近随机分布
    const angle = Math.random() * 2 * Math.PI;
    const r = 40 + Math.random() * 80;
    return {
      id,
      label: nodeLabels[id] || id,
      type: nodeTypes[id] || 'recipe',
      group,
      x: center.x + r * Math.cos(angle),
      y: center.y + r * Math.sin(angle),
      vx: 0,
      vy: 0,
      degree: degreeMap.get(id) || 1,
    };
  });
}

/** Improved force layout: group attraction + repulsion + label-aware */
function forceLayout(nodesIn: GraphNode[], edges: GraphEdge[], iterations = 200): GraphNode[] {
  const nodes = nodesIn.map(n => ({ ...n }));
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // 计算每个 group 的簇中心（动态根据节点位置计算）
  function groupCenters(): Map<string, { x: number, y: number, count: number }> {
    const gc = new Map<string, { x: number, y: number, count: number }>();
    for (const n of nodes) {
      const g = gc.get(n.group);
      if (g) { g.x += n.x; g.y += n.y; g.count++; }
      else gc.set(n.group, { x: n.x, y: n.y, count: 1 });
    }
    for (const [, v] of gc) { v.x /= v.count; v.y /= v.count; }
    return gc;
  }

  for (let iter = 0; iter < iterations; iter++) {
    const t = 1 - iter / iterations; // cooling factor
    const repK = 18000 * t;
    const springK = 0.015;
    const damping = 0.8;
    const gc = groupCenters();

    // Repulsion between all node pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = nodeRadius(a.degree) + nodeRadius(b.degree) + 60;
        const effectiveDist = Math.max(dist, 1);
        // 同组节点斥力稍弱，不同组更强
        const groupFactor = a.group === b.group ? 0.6 : 1.4;
        const force = (repK * groupFactor) / (effectiveDist * effectiveDist);
        const overlap = dist < minDist ? (minDist - dist) * 0.5 : 0;
        const totalF = force + overlap;
        const fx = (dx / effectiveDist) * totalF;
        const fy = (dy / effectiveDist) * totalF;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Spring force for connected edges
    for (const e of edges) {
      const a = nodeMap.get(e.fromId);
      const b = nodeMap.get(e.toId);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      // 同组边理想距离短，跨组边理想距离长
      const ideal = a.group === b.group ? 140 : 280;
      const force = springK * (dist - ideal);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // Group attraction: 拉向所属簇中心
    const groupK = 0.008 * t;
    for (const n of nodes) {
      const c = gc.get(n.group);
      if (c) {
        n.vx += (c.x - n.x) * groupK;
        n.vy += (c.y - n.y) * groupK;
      }
    }

    // Apply velocity + damping
    for (const n of nodes) {
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  return nodes;
}

// ─── Curved edge path helper ─────────────────────────

function edgePath(
  x1: number, y1: number, x2: number, y2: number,
  r1: number, r2: number, curvature: number = 0
): string {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  // Start / end clipped to node radius
  const sx = x1 + ux * r1, sy = y1 + uy * r1;
  const ex = x2 - ux * r2, ey = y2 - uy * r2;
  if (curvature === 0) return `M${sx},${sy}L${ex},${ey}`;
  // Quadratic curve offset
  const mx = (sx + ex) / 2 + (-uy) * curvature;
  const my = (sy + ey) / 2 + ux * curvature;
  return `M${sx},${sy}Q${mx},${my},${ex},${ey}`;
}

// ─── Component ────────────────────────────────────────

const KnowledgeGraphView: React.FC = () => {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const palette = isDark ? GROUP_COLORS_DARK : GROUP_COLORS;

  // i18n helper: translate relation labels using locale keys, fallback to module constant
  const relationLabel = (rel: string): string => {
    const keyMap: Record<string, string> = {
      depends_on: 'knowledgeGraph.relationDependsOn', requires: 'knowledgeGraph.relationRequires',
      extends: 'knowledgeGraph.relationExtends', implements: 'knowledgeGraph.relationImplements',
      inherits: 'knowledgeGraph.relationInherits', enforces: 'knowledgeGraph.relationEnforces',
      related: 'knowledgeGraph.relationAssociates', conflicts: 'knowledgeGraph.relationConflicts',
      calls: 'knowledgeGraph.relationCalls', prerequisite: 'knowledgeGraph.relationPrerequisite',
      data_flow_to: 'knowledgeGraph.relationDataFlow', references: 'knowledgeGraph.relationReferences',
      alternative: 'knowledgeGraph.relationAlternative', deprecated_by: 'knowledgeGraph.relationDeprecatedBy',
      solves: 'knowledgeGraph.relationSolves',
    };
    return keyMap[rel] ? t(keyMap[rel]) : (RELATION_LABELS[rel] || rel);
  };

  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [nodeLabels, setNodeLabels] = useState<Record<string, string>>({});
  const [nodeTypes, setNodeTypes] = useState<Record<string, string>>({});
  const [nodeCategories, setNodeCategories] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<{ totalEdges: number; byRelation: Record<string, number> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<string | null>(null);
  const [discoverIsError, setDiscoverIsError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  const fetchGraph = async () => {
    setLoading(true);
    setError(null);
    try {
      const [graphData, statsData] = await Promise.all([
        api.getKnowledgeGraph(),
        api.getGraphStats(),
      ]);
      setEdges(graphData.edges || []);
      setNodeLabels(graphData.nodeLabels || {});
      setNodeTypes(graphData.nodeTypes || {});
      setNodeCategories(graphData.nodeCategories || {});
      setStats(statsData);
    } catch (err: unknown) {
      setError(getErrorMessage(err, t('knowledgeGraph.loadFailed')));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchGraph(); }, []);

  // 启动时检查是否有进行中的发现任务
  useEffect(() => {
    api.getDiscoverRelationsStatus().then(s => {
      if (s.status === 'running') {
        setDiscovering(true);
        setDiscoverResult(t('knowledgeGraph.discoverAnalyzing', { elapsed: s.elapsed ?? 0 }));
      }
    }).catch(() => { /* intentionally ignored: discover status check is best-effort */ });
  }, []);

  // 轮询任务状态（3s间隔，最多 12 分钟）
  useEffect(() => {
    if (!discovering) return;
    let polls = 0;
    const MAX_POLLS = 240; // 240 * 3s = 12min
    const timer = setInterval(async () => {
      polls++;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        setDiscovering(false);
        setDiscoverIsError(true);
        setDiscoverResult(t('knowledgeGraph.discoverPollTimeout'));
        return;
      }
      try {
        const s = await api.getDiscoverRelationsStatus();
        if (s.status === 'done') {
          setDiscovering(false);
          const d = s.discovered ?? 0;
          const tp = s.totalPairs ?? 0;
          const be = s.batchErrors ?? 0;
          if (d === 0 && be === 0) {
            setDiscoverIsError(false);
            setDiscoverResult(t('knowledgeGraph.discoverNoResults', { pairs: tp }));
          } else if (d === 0 && be > 0) {
            setDiscoverIsError(true);
            setDiscoverResult(t('knowledgeGraph.discoverBatchErrors', { errors: be }));
          } else {
            setDiscoverIsError(false);
            const failMsg = be > 0 ? t('knowledgeGraph.discoverBatchFailed', { count: be }) : '';
            setDiscoverResult(t('knowledgeGraph.discoverSuccess', { count: d, pairs: tp, failMsg }));
          }
          fetchGraph();
        } else if (s.status === 'error') {
          setDiscovering(false);
          setDiscoverIsError(true);
          const errMsg = s.error || t('knowledgeGraph.unknownError');
          if (errMsg.includes('AI Provider') || errMsg.includes('API Key')) {
            setDiscoverResult(t('knowledgeGraph.discoverAiNotConfigured', { error: errMsg }));
          } else if (errMsg.includes('超时') || errMsg.includes('timeout')) {
            setDiscoverResult(t('knowledgeGraph.discoverTimeout', { error: errMsg }));
          } else {
            setDiscoverResult(t('knowledgeGraph.discoverFailed', { error: errMsg }));
          }
        } else if (s.status === 'running') {
          setDiscoverResult(t('knowledgeGraph.discoverAnalyzing', { elapsed: s.elapsed ?? 0 }));
        }
      } catch {
        // 网络抖动，继续轮询
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [discovering]);

  /** AI 批量发现 Recipe 关系 */
  const handleDiscover = useCallback(async () => {
    setDiscoverResult(null);
    setDiscoverIsError(false);
    try {
      const resp = await api.discoverRelations();
      if (resp.status === 'empty') {
        setDiscoverResult(resp.message || t('knowledgeGraph.discoverInsufficientRecipes'));
        return;
      }
      if (resp.status === 'timeout') {
        setDiscoverIsError(true);
        setDiscoverResult(resp.error || t('knowledgeGraph.discoverPreviousTimeout'));
        return;
      }
      if (resp.status === 'running') {
        setDiscovering(true);
        setDiscoverResult(t('knowledgeGraph.discoverRunning'));
        return;
      }
      // started
      setDiscovering(true);
      setDiscoverResult(t('knowledgeGraph.discoverStarted'));
    } catch (err: unknown) {
      setDiscoverIsError(true);
      const msg = getErrorMessage(err, t('knowledgeGraph.unknownError'));
      if (msg.includes('ChatAgent') || msg.includes('AI Provider')) {
        setDiscoverResult(t('knowledgeGraph.discoverAiUnavailable', { error: msg }));
      } else {
        setDiscoverResult(t('knowledgeGraph.discoverStartFailed', { error: msg }));
      }
    }
  }, [t]);

  // Force-directed layout
  const nodes = useMemo(() => {
    if (edges.length === 0) return [];
    const raw = buildNodes(edges, nodeLabels, nodeTypes, nodeCategories);
    return forceLayout(raw, edges);
  }, [edges, nodeLabels, nodeTypes, nodeCategories]);

  // Compute group hulls for background rendering
  const groupHulls = useMemo(() => {
    const groups = new Map<string, GraphNode[]>();
    for (const n of nodes) {
      const arr = groups.get(n.group) || [];
      arr.push(n);
      groups.set(n.group, arr);
    }
    const hulls: { group: string; cx: number; cy: number; rx: number; ry: number; count: number }[] = [];
    const sortedGroups = [...groups.keys()].sort();
    for (const g of sortedGroups) {
      const gNodes = groups.get(g)!;
      if (gNodes.length === 0) continue;
      let cx = 0, cy = 0;
      for (const n of gNodes) { cx += n.x; cy += n.y; }
      cx /= gNodes.length; cy /= gNodes.length;
      let rx = 0, ry = 0;
      for (const n of gNodes) {
        const r = nodeRadius(n.degree);
        rx = Math.max(rx, Math.abs(n.x - cx) + r + 35);
        ry = Math.max(ry, Math.abs(n.y - cy) + r + 35);
      }
      hulls.push({ group: g, cx, cy, rx: Math.max(rx, 60), ry: Math.max(ry, 60), count: gNodes.length });
    }
    return hulls;
  }, [nodes]);

  // Group color map
  const groupColorMap = useMemo(() => {
    const groups = [...new Set(nodes.map(n => n.group))].sort();
    const map: Record<string, typeof GROUP_COLORS[0]> = {};
    groups.forEach((g, i) => { map[g] = palette[i % palette.length]; });
    return map;
  }, [nodes, palette]);

  // Compute SVG viewBox
  const viewBox = useMemo(() => {
    if (nodes.length === 0) return { x: 0, y: 0, w: 900, h: 700 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const r = nodeRadius(n.degree);
      minX = Math.min(minX, n.x - r - 80);
      minY = Math.min(minY, n.y - r - 40);
      maxX = Math.max(maxX, n.x + r + 80);
      maxY = Math.max(maxY, n.y + r + 40);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }, [nodes]);

  // Node map for edge rendering
  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  // Connected edges / nodes for highlighting
  const { connectedEdgeIds, connectedNodeIds } = useMemo(() => {
    const focusId = selectedNode || hoveredNode;
    if (!focusId) return { connectedEdgeIds: new Set<number>(), connectedNodeIds: new Set<string>() };
    const eids = new Set<number>();
    const nids = new Set<string>([focusId]);
    for (const e of edges) {
      if (e.fromId === focusId || e.toId === focusId) {
        eids.add(e.id);
        nids.add(e.fromId);
        nids.add(e.toId);
      }
    }
    return { connectedEdgeIds: eids, connectedNodeIds: nids };
  }, [selectedNode, hoveredNode, edges]);

  // Detect duplicate edges for curving
  const edgeCurvature = useMemo(() => {
    const pairCount = new Map<string, number>();
    const pairIndex = new Map<number, number>();
    for (const e of edges) {
      const pairKey = [e.fromId, e.toId].sort().join('|');
      const idx = pairCount.get(pairKey) || 0;
      pairIndex.set(e.id, idx);
      pairCount.set(pairKey, idx + 1);
    }
    const curvatures = new Map<number, number>();
    for (const e of edges) {
      const pairKey = [e.fromId, e.toId].sort().join('|');
      const total = pairCount.get(pairKey) || 1;
      if (total <= 1) { curvatures.set(e.id, 0); continue; }
      const idx = pairIndex.get(e.id) || 0;
      curvatures.set(e.id, (idx - (total - 1) / 2) * 40);
    }
    return curvatures;
  }, [edges]);

  // Relation type filter
  const [activeRelations, setActiveRelations] = useState<Set<string>>(new Set());
  useEffect(() => {
    setActiveRelations(new Set(edges.map(e => e.relation)));
  }, [edges]);

  const filteredEdges = useMemo(() => edges.filter(e => activeRelations.has(e.relation)), [edges, activeRelations]);

  const toggleRelation = (rel: string) => {
    setActiveRelations(prev => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel); else next.add(rel);
      return next;
    });
  };

  // Pan & zoom handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isPanning.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const handleMouseUp = useCallback(() => { isPanning.current = false; }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.min(3, Math.max(0.2, z + delta)));
  }, []);

  // Arrow marker
  const arrowId = (rel: string) => `kg-arrow-${rel.replace(/[^a-z_]/g, '')}`;

  // ─── Render ──────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-red-500">{error}</p>
        <button onClick={fetchGraph} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">{t('knowledgeGraph.retry')}</button>
      </div>
    );
  }

  if (edges.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--fg-secondary)]">
        <Share2 size={48} className="text-[var(--fg-muted)]" />
        <p className="text-lg font-medium">{t('knowledgeGraph.empty')}</p>
        <p className="text-sm text-center max-w-xl">{t('knowledgeGraph.emptyDesc')}</p>
        {discoverResult && (
          <p className={`text-sm ${discoverIsError ? 'text-red-500' : 'text-green-600'}`}>{discoverResult}</p>
        )}
        <button
          onClick={handleDiscover}
          disabled={discovering}
          className="px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium transition-colors disabled:opacity-50 bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-emphasis)] hover:opacity-90"
        >
          {discovering ? (
            <><div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--accent)]" /> {t('knowledgeGraph.discovering')}</>
          ) : (
            <><Sparkles size={ICON_SIZES.sm} /> {t('knowledgeGraph.discoverRelations')}</>
          )}
        </button>
      </div>
    );
  }

  const uniqueRelations = [...new Set(edges.map(e => e.relation))].sort();
  const focusId = selectedNode || hoveredNode;
  const hasFocus = !!focusId;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Compact toolbar — no redundant title since parent tab already shows "知识图谱" */}
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0 overflow-x-auto scrollbar-none">
          {/* Stats badge */}
          {stats && (
            <span className="text-xs px-2 py-0.5 rounded-full whitespace-nowrap text-[var(--fg-secondary)] bg-[var(--bg-subtle)]">
              {t('knowledgeGraph.statsLabel', { nodes: nodes.length, edges: stats.totalEdges })}
            </span>
          )}
          {/* Inline relation filter */}
          {uniqueRelations.map(rel => (
            <button
              key={rel}
              onClick={() => toggleRelation(rel)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-all border whitespace-nowrap ${
                activeRelations.has(rel)
                  ? 'border-transparent shadow-sm'
                  : 'border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--fg-muted)] opacity-40'
              }`}
              style={activeRelations.has(rel) ? {
                backgroundColor: (RELATION_COLORS[rel] || '#6b7280') + '18',
                color: RELATION_COLORS[rel] || '#6b7280',
              } : {}}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: RELATION_COLORS[rel] || '#6b7280' }} />
              {relationLabel(rel)}
              {stats?.byRelation?.[rel] != null && <span className="opacity-60">({stats.byRelation[rel]})</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          <button onClick={() => setZoom(z => Math.min(z + 0.2, 3))} className="p-1 rounded-md transition-colors bg-[var(--bg-subtle)] hover:bg-[var(--border-default)] text-[var(--fg-secondary)]" title={t('knowledgeGraph.zoomIn')}>
            <ZoomIn size={ICON_SIZES.sm} />
          </button>
          <button onClick={() => setZoom(z => Math.max(z - 0.2, 0.2))} className="p-1 rounded-md transition-colors bg-[var(--bg-subtle)] hover:bg-[var(--border-default)] text-[var(--fg-secondary)]" title={t('knowledgeGraph.zoomOut')}>
            <ZoomOut size={ICON_SIZES.sm} />
          </button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="p-1 rounded-md transition-colors bg-[var(--bg-subtle)] hover:bg-[var(--border-default)] text-[var(--fg-secondary)]" title={t('knowledgeGraph.resetView')}>
            <Maximize2 size={ICON_SIZES.sm} />
          </button>
          <button onClick={fetchGraph} className="p-1 rounded-md transition-colors bg-[var(--bg-subtle)] hover:bg-[var(--border-default)] text-[var(--fg-secondary)]" title={t('knowledgeGraph.refresh')}>
            <RefreshCw size={ICON_SIZES.sm} />
          </button>
          <button
            onClick={handleDiscover}
            disabled={discovering}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50 bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-emphasis)] hover:opacity-90"
            title={t('knowledgeGraph.discoverTooltip')}
          >
            {discovering ? (
              <><div className="animate-spin rounded-full h-3 w-3 border-b-2 border-[var(--accent)]" /> {t('knowledgeGraph.discovering')}</>
            ) : (
              <><Sparkles size={ICON_SIZES.sm} /> {t('knowledgeGraph.discoverRelations')}</>
            )}
          </button>
        </div>
      </div>

      {/* SVG Canvas */}
      <div
        ref={containerRef}
        className="flex-1 rounded-xl border overflow-hidden relative min-h-0 border-[var(--border-default)] bg-[var(--bg-subtle)]"
        style={{ cursor: isPanning.current ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)` }}
        >
          <defs>
            {/* Arrow markers */}
            {uniqueRelations.map(rel => (
              <marker
                key={rel}
                id={arrowId(rel)}
                viewBox="0 0 10 8"
                refX="10"
                refY="4"
                markerWidth="7"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,4 L0,8 Z" fill={RELATION_COLORS[rel] || '#6b7280'} />
              </marker>
            ))}
            {/* Glow filter for selected nodes */}
            <filter id="kg-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur" />
              <feFlood floodColor="#3b82f6" floodOpacity="0.3" result="color" />
              <feComposite in="color" in2="blur" operator="in" result="shadow" />
              <feMerge>
                <feMergeNode in="shadow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* ── Group hulls (背景分组区域) ── */}
          <g>
            {groupHulls.map(h => {
              const color = groupColorMap[h.group] || GROUP_COLORS[0];
              return (
                <g key={h.group}>
                  <ellipse
                    cx={h.cx}
                    cy={h.cy}
                    rx={h.rx}
                    ry={h.ry}
                    fill={color.bg}
                    stroke={color.border}
                    strokeWidth={1.5}
                    strokeDasharray="6,4"
                    opacity={0.6}
                  />
                  <text
                    x={h.cx}
                    y={h.cy - h.ry + 14}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill={color.text}
                    opacity={0.8}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {h.group || 'general'} ({h.count})
                  </text>
                </g>
              );
            })}
          </g>

          {/* ── Edges ── */}
          <g>
            {filteredEdges.map(e => {
              const from = nodeMap.get(e.fromId);
              const to = nodeMap.get(e.toId);
              if (!from || !to) return null;

              const isHighlighted = hasFocus ? connectedEdgeIds.has(e.id) : false;
              const isHovered = hoveredEdge === e.id;
              const opacity = hasFocus
                ? (isHighlighted ? 0.85 : 0.06)
                : (isHovered ? 0.9 : 0.35);

              const r1 = nodeRadius(from.degree);
              const r2 = nodeRadius(to.degree);
              const curve = edgeCurvature.get(e.id) || 0;
              const d = edgePath(from.x, from.y, to.x, to.y, r1, r2, curve);

              return (
                <g key={e.id}>
                  {/* Invisible wider hit target */}
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                    onMouseEnter={() => setHoveredEdge(e.id)}
                    onMouseLeave={() => setHoveredEdge(null)}
                    style={{ cursor: 'pointer' }}
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={RELATION_COLORS[e.relation] || '#6b7280'}
                    strokeWidth={isHovered || isHighlighted ? 2 : 1.2}
                    opacity={opacity}
                    markerEnd={`url(#${arrowId(e.relation)})`}
                    strokeDasharray={e.relation === 'related' ? '6,3' : undefined}
                    style={{ transition: 'opacity 0.25s, stroke-width 0.15s', pointerEvents: 'none' }}
                  />
                  {/* Edge label on hover */}
                  {isHovered && (() => {
                    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
                    return (
                      <g>
                        <rect x={mx - 24} y={my - 16} width={48} height={18} rx={4} fill="var(--bg-surface)" stroke={RELATION_COLORS[e.relation] || '#6b7280'} strokeWidth={0.8} opacity={0.95} />
                        <text x={mx} y={my - 4} textAnchor="middle" fontSize={9} fontWeight={600} fill={RELATION_COLORS[e.relation] || '#6b7280'}>
                          {relationLabel(e.relation)}
                        </text>
                      </g>
                    );
                  })()}
                </g>
              );
            })}
          </g>

          {/* ── Nodes ── */}
          <g>
            {nodes.map(n => {
              const r = nodeRadius(n.degree);
              const isSelected = selectedNode === n.id;
              const isConnected = hasFocus && connectedNodeIds.has(n.id);
              const isFocused = isSelected || n.id === hoveredNode;
              const dimmed = hasFocus && !isConnected;
              const opacity = dimmed ? 0.12 : 1;

              // Node fill color — group-aware
              const gc = groupColorMap[n.group] || GROUP_COLORS[0];
              const fillColor = isFocused
                ? gc.border
                : isConnected && !isSelected
                  ? gc.bg
                  : gc.bg;
              const strokeColor = isFocused ? gc.text : isConnected ? gc.border : gc.border;
              const textColor = isFocused ? '#ffffff' : gc.text;
              const labelColor = isFocused ? gc.text : 'var(--fg-muted)';

              return (
                <g
                  key={n.id}
                  onClick={(e) => { e.stopPropagation(); setSelectedNode(isSelected ? null : n.id); }}
                  onMouseEnter={() => setHoveredNode(n.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                  style={{ cursor: 'pointer', transition: 'opacity 0.25s' }}
                  opacity={opacity}
                  filter={isFocused ? 'url(#kg-glow)' : undefined}
                >
                  {/* Node circle */}
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={r}
                    fill={fillColor}
                    stroke={strokeColor}
                    strokeWidth={isFocused ? 2.5 : 1.5}
                  />
                  {/* Abbreviation inside circle */}
                  <text
                    x={n.x}
                    y={n.y + 4}
                    textAnchor="middle"
                    fontSize={Math.min(FONT_SIZE, r * 0.7)}
                    fill={textColor}
                    fontWeight={700}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {truncLabel(n.label, 4).toUpperCase()}
                  </text>
                  {/* Full label below node */}
                  <text
                    x={n.x}
                    y={n.y + r + 14}
                    textAnchor="middle"
                    fontSize={LABEL_FONT}
                    fill={labelColor}
                    fontWeight={isFocused ? 600 : 400}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {truncLabel(n.label, 18)}
                  </text>
                  {/* Degree badge */}
                  {n.degree >= 3 && !dimmed && (
                    <g>
                      <circle cx={n.x + r * 0.7} cy={n.y - r * 0.7} r={8} fill="#3b82f6" stroke="var(--bg-surface)" strokeWidth={1.5} />
                      <text x={n.x + r * 0.7} y={n.y - r * 0.7 + 3.5} textAnchor="middle" fontSize={8} fill="white" fontWeight={700} style={{ pointerEvents: 'none' }}>
                        {n.degree}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Click away to deselect */}
        {selectedNode && (
          <button
            className="absolute top-2 right-2 text-xs px-2 py-1 rounded-md shadow-sm border text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] bg-[var(--bg-surface)] border-[var(--border-default)]"
            onClick={() => setSelectedNode(null)}
          >
            {t('knowledgeGraph.cancelSelection')}
          </button>
        )}

        {/* Floating discover result toast */}
        {discoverResult && (
          <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 max-w-md px-3 py-1.5 rounded-lg text-xs shadow-md border ${discoverIsError ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/60 dark:border-red-800 dark:text-red-300' : 'bg-green-50 border-green-200 text-green-700 dark:bg-green-950/60 dark:border-green-800 dark:text-green-300'}`}>
            {discoverResult}
          </div>
        )}
      </div>

      {/* Selected node detail panel */}
      {selectedNode && (
        <div className="mt-3 p-4 rounded-xl border shadow-sm flex-shrink-0 max-h-48 overflow-y-auto scrollbar-light bg-[var(--bg-surface)] border-[var(--border-default)]">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-[var(--border-default)]">
            <Info size={14} className="text-blue-500" />
            <h3 className="font-semibold text-sm text-[var(--fg-primary)]">
              {nodeLabels[selectedNode] || selectedNode}
            </h3>
            <span className="text-[10px] text-[var(--fg-muted)] ml-auto">ID: {selectedNode}</span>
          </div>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-[var(--fg-secondary)] font-medium">{t('knowledgeGraph.outEdges')}</span>
              <ul className="mt-1.5 space-y-1">
                {edges.filter(e => e.fromId === selectedNode && activeRelations.has(e.relation)).map(e => (
                  <li key={e.id} className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: RELATION_COLORS[e.relation] || '#6b7280' }} />
                    <span className="text-[var(--fg-secondary)]">{relationLabel(e.relation)}</span>
                    <span className="text-[var(--fg-muted)]">→</span>
                    <button className="text-blue-600 hover:underline truncate" onClick={() => setSelectedNode(e.toId)}>
                      {nodeLabels[e.toId] || e.toId.substring(0, 16)}
                    </button>
                  </li>
                ))}
                {edges.filter(e => e.fromId === selectedNode && activeRelations.has(e.relation)).length === 0 && <li className="text-[var(--fg-muted)]">{t('knowledgeGraph.none')}</li>}
              </ul>
            </div>
            <div>
              <span className="text-[var(--fg-secondary)] font-medium">{t('knowledgeGraph.inEdges')}</span>
              <ul className="mt-1.5 space-y-1">
                {edges.filter(e => e.toId === selectedNode && activeRelations.has(e.relation)).map(e => (
                  <li key={e.id} className="flex items-center gap-1.5">
                    <button className="text-blue-600 hover:underline truncate" onClick={() => setSelectedNode(e.fromId)}>
                      {nodeLabels[e.fromId] || e.fromId.substring(0, 16)}
                    </button>
                    <span className="text-[var(--fg-muted)]">→</span>
                    <span className="text-[var(--fg-secondary)]">{relationLabel(e.relation)}</span>
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: RELATION_COLORS[e.relation] || '#6b7280' }} />
                  </li>
                ))}
                {edges.filter(e => e.toId === selectedNode && activeRelations.has(e.relation)).length === 0 && <li className="text-[var(--fg-muted)]">{t('knowledgeGraph.none')}</li>}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default KnowledgeGraphView;
