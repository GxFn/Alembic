/**
 * DrawerContent — 抽屉正文共享 section 组件库
 *
 * 每个 section 只关心 **数据 → 渲染**，由调用方决定顺序和可见性。
 * 三个视图（Candidates / Recipes / Knowledge）只需传入不同的 i18n key 和数据即可。
 *
 * 用法示例：
 *   <DrawerContent.Description label={t('candidates.description')} text={cand.description} />
 *   <DrawerContent.Reasoning label={t('knowledge.reasoning')} reasoning={r} labels={...} />
 */
import React from 'react';
import { FileCode, FileText, Shield, Layers, Lightbulb } from 'lucide-react';
import CodeBlock from './CodeBlock';
import MarkdownWithHighlight from './MarkdownWithHighlight';

/* ══════════════════════════════════════════════════════════
 * 1. Description / Summary
 * ══════════════════════════════════════════════════════════ */
export interface DescriptionProps {
  label: string;
  text?: string | null;
}

const Description: React.FC<DescriptionProps> = ({ label, text }) => {
  if (!text) return null;
  return (
    <div className="px-6 py-4 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-1.5 block">{label}</label>
      <p className="text-sm text-[var(--fg-secondary)] leading-relaxed">{text}</p>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 2. Reasoning — 推理依据 (amber theme)
 * ══════════════════════════════════════════════════════════ */
export interface ReasoningData {
  whyStandard?: string | null;
  sources?: string[];
  confidence?: number | null;
  alternatives?: string[];
}

export interface ReasoningLabels {
  section: string;       // e.g. t('knowledge.reasoning')
  source: string;        // e.g. t('candidates.source') + ':'
  confidence: string;    // e.g. t('candidates.confidence') + ':'
  alternatives: string;  // e.g. t('candidates.viewDetail') + ':'
}

export interface ReasoningProps {
  reasoning?: ReasoningData | null;
  labels: ReasoningLabels;
  /** 过滤掉 "Submitted via …" 的 whyStandard */
  filterSubmitted?: boolean;
}

const Reasoning: React.FC<ReasoningProps> = ({ reasoning, labels, filterSubmitted = false }) => {
  if (!reasoning) return null;
  const r = reasoning;
  const showWhy = r.whyStandard && (!filterSubmitted || !/^Submitted via /i.test(r.whyStandard));
  const hasSomething = showWhy || (r.sources && r.sources.length > 0) || (r.confidence != null && r.confidence > 0);
  if (!hasSomething) return null;
  return (
    <div className="px-6 py-4 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
        <Lightbulb size={11} className="text-amber-400" /> {labels.section}
      </label>
      <div className="bg-amber-50/30 border border-amber-100 rounded-xl p-4 space-y-2.5">
        {showWhy && <p className="text-sm text-[var(--fg-primary)] leading-relaxed">{r.whyStandard}</p>}
        {r.sources && r.sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-[var(--fg-muted)] font-bold">{labels.source}</span>
            {r.sources.map((src, i) => (
              <code key={i} className="text-[10px] px-2 py-0.5 bg-[var(--bg-surface)] border border-amber-200 rounded text-amber-700 font-mono">{src}</code>
            ))}
          </div>
        )}
        {r.confidence != null && r.confidence > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--fg-muted)] font-bold">{labels.confidence}</span>
            <div className="flex-1 max-w-[160px] h-1.5 bg-[var(--border-default)] rounded-full overflow-hidden">
              <div className="h-full bg-amber-400 rounded-full" style={{ width: `${Math.round((r.confidence ?? 0) * 100)}%` }} />
            </div>
            <span className="text-[10px] font-bold text-amber-600">{Math.round((r.confidence ?? 0) * 100)}%</span>
          </div>
        )}
        {r.alternatives && r.alternatives.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[10px] text-[var(--fg-muted)] font-bold">{labels.alternatives}</span>
            {r.alternatives.map((alt, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded text-[var(--fg-secondary)]">{alt}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 3. Quality — 质量评级
 * ══════════════════════════════════════════════════════════ */
export interface QualityData {
  grade?: string | null;
  completeness?: number | null;
  adaptation?: number | null;
  documentation?: number | null;
}

export interface QualityLabels {
  section: string;
  completeness: string;
  adaptation: string;
  documentation: string;
}

export interface QualityProps {
  quality?: QualityData | null;
  labels: QualityLabels;
}

const Quality: React.FC<QualityProps> = ({ quality, labels }) => {
  if (!quality?.grade || quality.grade === 'F') return null;
  const fmt = (v: number) => v.toFixed(2);
  return (
    <div className="px-6 py-3 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{labels.section}</label>
      <div className="flex items-center gap-4">
        <span className={`text-2xl font-black ${
          quality.grade === 'A' ? 'text-emerald-600' :
          quality.grade === 'B' ? 'text-blue-600' :
          quality.grade === 'C' ? 'text-amber-600' :
          quality.grade === 'D' ? 'text-orange-600' : 'text-[var(--fg-muted)]'
        }`}>{quality.grade}</span>
        <div className="flex-1 grid grid-cols-3 gap-2 text-xs">
          {quality.completeness != null && quality.completeness > 0 && (
            <div className="text-center">
              <div className="text-sm font-bold text-[var(--fg-primary)]">{fmt(quality.completeness)}</div>
              <div className="text-[var(--fg-muted)]">{labels.completeness}</div>
            </div>
          )}
          {quality.adaptation != null && quality.adaptation > 0 && (
            <div className="text-center">
              <div className="text-sm font-bold text-[var(--fg-primary)]">{fmt(quality.adaptation)}</div>
              <div className="text-[var(--fg-muted)]">{labels.adaptation}</div>
            </div>
          )}
          {quality.documentation != null && quality.documentation > 0 && (
            <div className="text-center">
              <div className="text-sm font-bold text-[var(--fg-primary)]">{fmt(quality.documentation)}</div>
              <div className="text-[var(--fg-muted)]">{labels.documentation}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 4. Markdown 文档 (blue theme)
 * ══════════════════════════════════════════════════════════ */
export interface MarkdownSectionProps {
  label: string;
  content?: string | null;
}

const MarkdownSection: React.FC<MarkdownSectionProps> = ({ label, content }) => {
  if (!content) return null;
  return (
    <div className="px-6 py-4 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
        <FileText size={11} className="text-blue-400" /> {label}
      </label>
      <div className="bg-blue-50/30 border border-blue-100 rounded-xl p-4">
        <div className="markdown-body text-sm text-[var(--fg-primary)] leading-relaxed">
          <MarkdownWithHighlight content={content} />
        </div>
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 5. Code Pattern (emerald icon)
 * ══════════════════════════════════════════════════════════ */
export interface CodePatternProps {
  label: string;
  code?: string | null;
  language?: string;
}

const CodePattern: React.FC<CodePatternProps> = ({ label, code, language }) => {
  if (!code) return null;
  const lang = language === 'objc' || language === 'objective-c' ? 'objectivec' : (language || 'text');
  return (
    <div className="px-6 py-4 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
        <FileCode size={11} className="text-emerald-500" /> {label}
      </label>
      <CodeBlock code={code} language={lang} showLineNumbers />
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 6. Headers (violet pills)
 * ══════════════════════════════════════════════════════════ */
export interface HeadersProps {
  label: string;
  headers?: string[] | null;
}

const Headers: React.FC<HeadersProps> = ({ label, headers }) => {
  if (!headers || headers.length === 0) return null;
  return (
    <div className="px-6 py-3 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {headers.map((h, i) => (
          <code key={i} className="px-2.5 py-1 bg-violet-50 text-violet-700 border border-violet-100 rounded-md text-[10px] font-mono font-medium">{h}</code>
        ))}
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 7. Rationale (subtle bg)
 * ══════════════════════════════════════════════════════════ */
export interface RationaleProps {
  label: string;
  text?: string | null;
}

const Rationale: React.FC<RationaleProps> = ({ label, text }) => {
  if (!text) return null;
  return (
    <div className="px-6 py-4 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{label}</label>
      <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-xl p-4">
        <p className="text-sm text-[var(--fg-secondary)] leading-relaxed">{text}</p>
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 8. Steps (numbered list with optional code)
 * ══════════════════════════════════════════════════════════ */
export interface StepsProps {
  label: string;
  steps?: Array<string | { title?: string; description?: string; code?: string }> | null;
}

const Steps: React.FC<StepsProps> = ({ label, steps }) => {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="px-6 py-4 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block">{label}</label>
      <div className="space-y-2">
        {steps.map((step, i) => {
          if (typeof step === 'string') {
            return (
              <div key={i} className="bg-[var(--bg-subtle)] rounded-lg p-3 border border-[var(--border-default)] flex items-start gap-2.5">
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded-full w-5 h-5 flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                <p className="text-xs text-[var(--fg-primary)] leading-relaxed">{step}</p>
              </div>
            );
          }
          const title = typeof step.title === 'string' ? step.title : '';
          const desc = typeof step.description === 'string' ? step.description : '';
          const code = typeof step.code === 'string' ? step.code : '';
          return (
            <div key={i} className="bg-[var(--bg-subtle)] rounded-lg p-3 border border-[var(--border-default)]">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 rounded-full w-5 h-5 flex items-center justify-center shrink-0">{i + 1}</span>
                {title && <span className="text-xs font-bold text-[var(--fg-primary)]">{title}</span>}
              </div>
              {desc && <p className="text-xs text-[var(--fg-secondary)] ml-7 leading-relaxed">{desc}</p>}
              {code && <pre className="text-[11px] font-mono bg-slate-800 text-green-300 p-2.5 rounded-md mt-1.5 ml-7 overflow-x-auto whitespace-pre-wrap">{code}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 9. Constraints (guards / boundaries / preconditions / sideEffects)
 * ══════════════════════════════════════════════════════════ */
export interface ConstraintsData {
  guards?: Array<{ pattern: string; severity: string; message?: string }>;
  boundaries?: string[];
  preconditions?: string[];
  sideEffects?: string[];
}

export interface ConstraintsProps {
  label: string;
  constraints?: ConstraintsData | null;
}

const Constraints: React.FC<ConstraintsProps> = ({ label, constraints }) => {
  if (!constraints) return null;
  const c = constraints;
  const total = (c.guards?.length || 0) + (c.boundaries?.length || 0) + (c.preconditions?.length || 0) + (c.sideEffects?.length || 0);
  if (!total) return null;
  return (
    <div className="px-6 py-4 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
        <Shield size={11} className="text-amber-500" /> {label} <span className="text-amber-500 font-mono">{total}</span>
      </label>
      <div className="space-y-1.5 text-xs text-[var(--fg-secondary)]">
        {c.guards?.map((g, i) => (
          <div key={i} className="flex gap-1.5 items-start">
            <span className={`text-xs mt-0.5 ${g.severity === 'error' ? 'text-[var(--status-error)]' : 'text-[var(--status-warning)]'}`}>●</span>
            <code className="font-mono text-[10px] bg-[var(--bg-subtle)] px-1.5 py-0.5 rounded">{g.pattern}</code>
            {g.message && <span className="text-[10px] text-[var(--fg-muted)]">— {g.message}</span>}
          </div>
        ))}
        {c.boundaries?.map((b, i) => <div key={i} className="flex gap-1.5"><span className="text-[var(--status-warning)]">●</span>{b}</div>)}
        {c.preconditions?.map((p, i) => <div key={i} className="flex gap-1.5"><span className="text-[var(--accent)]">◆</span>{p}</div>)}
        {c.sideEffects?.map((s, i) => <div key={i} className="flex gap-1.5"><span className="text-pink-400">⚡</span>{s}</div>)}
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * 10. Delivery (Cursor — indigo theme)
 * ══════════════════════════════════════════════════════════ */
export interface DeliveryData {
  topicHint?: string | null;
  whenClause?: string | null;
  doClause?: string | null;
  dontClause?: string | null;
  coreCode?: string | null;
}

export interface DeliveryProps {
  delivery?: DeliveryData | null;
  language?: string;
}

const Delivery: React.FC<DeliveryProps> = ({ delivery, language }) => {
  if (!delivery) return null;
  const { topicHint, whenClause, doClause, dontClause, coreCode } = delivery;
  if (!doClause && !whenClause && !dontClause && !topicHint && !coreCode) return null;
  const lang = language === 'objectivec' || language === 'objc' || language === 'objective-c' ? 'objectivec' : (language || 'text');
  return (
    <div className="px-6 py-4 border-b border-[var(--border-default)]">
      <label className="text-[10px] font-bold text-[var(--fg-muted)] uppercase mb-2 block flex items-center gap-1.5">
        <Layers size={11} className="text-indigo-400" /> Cursor Delivery
      </label>
      <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-xl p-4 text-xs space-y-1.5">
        {topicHint && <div><span className="text-indigo-400 font-medium">Topic：</span><span className="text-[var(--fg-primary)]">{topicHint}</span></div>}
        {whenClause && <div><span className="text-blue-400 font-medium">When：</span><span className="text-[var(--fg-primary)]">{whenClause}</span></div>}
        {doClause && <div><span className="text-emerald-400 font-medium">Do：</span><span className="text-[var(--fg-primary)]">{doClause}</span></div>}
        {dontClause && <div><span className="text-red-400 font-medium">Don't：</span><span className="text-[var(--fg-primary)]">{dontClause}</span></div>}
        {coreCode && (
          <div>
            <span className="text-purple-400 font-medium">Core Code：</span>
            <div className="mt-1">
              <CodeBlock code={coreCode} language={lang} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════════
 * Export compound namespace
 * ══════════════════════════════════════════════════════════ */
const DrawerContent = {
  Description,
  Reasoning,
  Quality,
  MarkdownSection,
  CodePattern,
  Headers,
  Rationale,
  Steps,
  Constraints,
  Delivery,
};

export default DrawerContent;
