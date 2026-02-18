import React, { useState, useEffect } from 'react';
import { Shield, AlertTriangle, AlertCircle, Trash2, ChevronDown, ChevronRight, ExternalLink, BookOpen, Wrench, Link2 } from 'lucide-react';
import api from '../../api';
import { notify } from '../../utils/notification';
import { GITHUB_ISSUES_NEW_GUARD_URL } from '../../constants';
import { ICON_SIZES } from '../../constants/icons';

interface GuardRule {
  message: string;
  severity: string;
  pattern: string;
  languages: string[];
  note?: string;
  /** 审查规模：仅在该规模下运行；无则任意规模均运行 */
  dimension?: 'file' | 'target' | 'project';
  /** 规则溯源：为什么存在这条规则 */
  rationale?: string;
  /** 修复建议列表 */
  fixSuggestions?: string[];
  /** 关联的 Recipe ID/名称 */
  sourceRecipe?: string;
}

interface GuardViolation {
  ruleId: string;
  message: string;
  severity: string;
  line: number;
  snippet: string;
  /** 审查维度：同文件 / 同 target / 同项目 */
  dimension?: 'file' | 'target' | 'project';
  /** 违反所在文件（target/project 范围时可能来自其他文件） */
  filePath?: string;
}

interface GuardRun {
  id: string;
  filePath: string;
  triggeredAt: string;
  violations: GuardViolation[];
}

const GuardView: React.FC<{ onRefresh?: () => void }> = ({ onRefresh }) => {
  const [rules, setRules] = useState<Record<string, GuardRule>>({});
  const [runs, setRuns] = useState<GuardRun[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAiWriteRule, setShowAiWriteRule] = useState(false);
  const [showAddRule, setShowAddRule] = useState(false);
  const [semanticInput, setSemanticInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [addRuleForm, setAddRuleForm] = useState({
  ruleId: '',
  message: '',
  severity: 'warning' as 'warning' | 'error',
  pattern: '',
  languages: ['objc', 'swift'] as string[],
  note: '',
  dimension: '' as '' | 'file' | 'target' | 'project'
  });
  const [addRuleSubmitting, setAddRuleSubmitting] = useState(false);
  const [addRuleError, setAddRuleError] = useState('');

  const fetchGuard = async () => {
  try {
    const [rulesResult, violationsResult] = await Promise.all([
    api.getGuardRules(),
    api.getGuardViolations()
    ]);
    setRules(rulesResult?.rules || {});
    setRuns(violationsResult?.runs || []);
  } catch (_) {
    setRules({});
    setRuns([]);
  } finally {
    setLoading(false);
  }
  };

  useEffect(() => {
  fetchGuard();
  }, []);

  const handleClearViolations = async () => {
  if (!window.confirm('确定清空所有 Guard 违反记录？')) return;
  try {
    await api.clearViolations();
    fetchGuard();
    onRefresh?.();
  } catch (err: any) {
    notify(err?.message || '清空违反记录失败', { title: '操作失败', type: 'error' });
  }
  };

  const handleToggleLang = (lang: string) => {
  setAddRuleForm(prev => ({
    ...prev,
    languages: prev.languages.includes(lang)
    ? prev.languages.filter(l => l !== lang)
    : [...prev.languages, lang]
  }));
  };

  const handleGenerateRule = async () => {
  if (!semanticInput.trim()) {
    setAddRuleError('请先输入语义描述');
    return;
  }
  setAddRuleError('');
  setGenerating(true);
  try {
    const res = await api.generateGuardRule({
    description: semanticInput.trim()
    });
    const data = res;
    const dim = (data as { dimension?: string }).dimension;
    setAddRuleForm({
    ruleId: data.ruleId || '',
    message: data.message || '',
    severity: data.severity === 'error' ? 'error' : 'warning',
    pattern: data.pattern || '',
    languages: Array.isArray(data.languages) && data.languages.length > 0 ? data.languages : ['objc', 'swift'],
    note: data.note != null ? String(data.note) : '',
    dimension: dim === 'file' || dim === 'target' || dim === 'project' ? dim : ''
    });
    setShowAddRule(true);
  } catch (err: any) {
    setAddRuleError(err?.response?.data?.error || err?.message || 'AI 生成失败');
  } finally {
    setGenerating(false);
  }
  };

  const handleAddRule = async (e: React.FormEvent) => {
  e.preventDefault();
  setAddRuleError('');
  if (!addRuleForm.ruleId.trim() || !addRuleForm.message.trim() || !addRuleForm.pattern.trim() || addRuleForm.languages.length === 0) {
    setAddRuleError('请填写规则 ID、说明、正则和至少一种语言');
    return;
  }
  setAddRuleSubmitting(true);
  try {
    await api.saveGuardRule({
    ruleId: addRuleForm.ruleId.trim(),
    message: addRuleForm.message.trim(),
    severity: addRuleForm.severity,
    pattern: addRuleForm.pattern.trim(),
    languages: addRuleForm.languages,
    note: addRuleForm.note.trim() || undefined,
    ...(addRuleForm.dimension ? { dimension: addRuleForm.dimension } : {})
    });
    setAddRuleForm({ ruleId: '', message: '', severity: 'warning', pattern: '', languages: ['objc', 'swift'], note: '', dimension: '' });
    setSemanticInput('');
    setShowAddRule(false);
    fetchGuard();
    onRefresh?.();
  } catch (err: any) {
    setAddRuleError(err?.response?.data?.error || err?.message || '写入失败');
  } finally {
    setAddRuleSubmitting(false);
  }
  };

  if (loading) {
  return <div className="p-6 text-slate-500">加载中...</div>;
  }

  const ruleEntries = Object.entries(rules);
  const totalViolations = runs.reduce((s, r) => s + r.violations.length, 0);

  return (
  <div className="flex-1 flex flex-col overflow-hidden">
    {/* ── 页面头部 ── */}
    <div className="mb-4 flex justify-between items-center shrink-0">
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
      <Shield className="text-blue-600" size={20} />
      </div>
      <div>
      <h2 className="text-xl font-bold text-slate-800">Guard 规则与违反记录</h2>
      <p className="text-xs text-slate-400 mt-0.5">静态规则检查 · 自动审计代码变更</p>
      </div>
    </div>
    <div className="flex items-center gap-2">
      <a
      href={GITHUB_ISSUES_NEW_GUARD_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100"
      >
      <ExternalLink size={14} /> 提交误报
      </a>
      <button
      type="button"
      onClick={() => setShowAiWriteRule(!showAiWriteRule)}
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100"
      >
      {showAiWriteRule ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      AI 写入规则
      </button>
      {runs.length > 0 && (
      <button
        type="button"
        onClick={handleClearViolations}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all text-red-600 bg-red-50 border border-red-200 hover:bg-red-100"
      >
        <Trash2 size={14} /> 清空历史
      </button>
      )}
      <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-100">
        <Shield size={14} className="text-slate-400" />
        <span className="text-slate-500">规则 <strong className="text-slate-700">{ruleEntries.length}</strong> 条</span>
      </div>
      {totalViolations > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-100">
        <AlertTriangle size={14} className="text-amber-400" />
        <span className="text-amber-600">违反 <strong className="text-amber-700">{totalViolations}</strong></span>
        </div>
      )}
      </div>
    </div>
    </div>

    {/* ── 内容区域 ── */}
    <div className="flex-1 overflow-y-auto pr-1">

    {/* AI 写入规则：默认折叠，点击标题行展开 */}
    {showAiWriteRule && (
    <section className="mb-6">
    <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
      <div>
      <label htmlFor="semantic-input" className="block text-xs font-medium text-slate-600 mb-1">语义描述（由 AI 生成规则表单）</label>
      <textarea
      id="semantic-input"
      name="semanticInput"
        value={semanticInput}
        onChange={e => { setSemanticInput(e.target.value); setAddRuleError(''); }}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-y min-h-[80px]"
        placeholder="例如：禁止在主线程使用 dispatch_sync 调用 main queue，易死锁"
        rows={3}
      />
      <button
        type="button"
        onClick={handleGenerateRule}
        disabled={generating || !semanticInput.trim()}
        className="mt-2 px-4 py-2 bg-slate-600 text-white text-sm rounded-lg hover:bg-slate-700 disabled:opacity-50"
      >
        {generating ? '生成中...' : 'AI 生成'}
      </button>
      {addRuleError && <p className="mt-2 text-sm text-red-600">{addRuleError}</p>}
      </div>
      <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setShowAddRule(!showAddRule)}
        className="text-sm font-medium text-blue-600 hover:text-blue-700"
      >
        {showAddRule ? '收起表单' : '展开 / 编辑表单'}
      </button>
      {addRuleForm.ruleId && <span className="text-xs text-slate-500">已生成规则 ID：{addRuleForm.ruleId}</span>}
      </div>
    </div>
    {showAddRule && (
      <form onSubmit={handleAddRule} className="mt-3 p-4 bg-white border border-slate-200 rounded-xl space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
        <label htmlFor="rule-id" className="block text-xs font-medium text-slate-600 mb-1">规则 ID（英文，如 no-force-unwrap）</label>
        <input
        id="rule-id"
        name="ruleId"
          type="text"
          value={addRuleForm.ruleId}
          onChange={e => setAddRuleForm(f => ({ ...f, ruleId: e.target.value }))}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
          placeholder="my-rule-id"
        />
        </div>
        <div>
        <label htmlFor="rule-severity" className="block text-xs font-medium text-slate-600 mb-1">严重性</label>
        <select
        id="rule-severity"
        name="severity"
          value={addRuleForm.severity}
          onChange={e => setAddRuleForm(f => ({ ...f, severity: e.target.value as 'error' | 'warning' }))}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
        >
          <option value="warning">warning</option>
          <option value="error">error</option>
        </select>
        </div>
      </div>
      <div>
      <label htmlFor="rule-message" className="block text-xs font-medium text-slate-600 mb-1">说明（违反时提示）</label>
      <input
        id="rule-message"
        name="message"
        type="text"
        value={addRuleForm.message}
        onChange={e => setAddRuleForm(f => ({ ...f, message: e.target.value }))}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
        placeholder="禁止在主线程上使用 dispatch_sync(main)"
        />
      </div>
      <div>
      <label htmlFor="rule-pattern" className="block text-xs font-medium text-slate-600 mb-1">正则（对每行匹配，JSON 中反斜杠需双写）</label>
      <input
        id="rule-pattern"
        name="pattern"
        type="text"
        value={addRuleForm.pattern}
        onChange={e => setAddRuleForm(f => ({ ...f, pattern: e.target.value }))}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
        placeholder="dispatch_sync\\s*\\([^)]*main"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">适用语言</label>
        <div className="flex gap-4">
        <label htmlFor="lang-objc" className="flex items-center gap-2 text-sm">
        <input id="lang-objc" name="languages" type="checkbox" checked={addRuleForm.languages.includes('objc')} onChange={() => handleToggleLang('objc')} />
        objc
        </label>
        <label htmlFor="lang-swift" className="flex items-center gap-2 text-sm">
        <input id="lang-swift" name="languages" type="checkbox" checked={addRuleForm.languages.includes('swift')} onChange={() => handleToggleLang('swift')} />
          swift
        </label>
        </div>
      </div>
      <div>
      <label htmlFor="rule-dimension" className="block text-xs font-medium text-slate-600 mb-1">审查规模（可选，as:audit 后缀可限定）</label>
      <select
      id="rule-dimension"
      name="dimension"
        value={addRuleForm.dimension}
        onChange={e => setAddRuleForm(f => ({ ...f, dimension: e.target.value as '' | 'file' | 'target' | 'project' }))}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
      >
        <option value="">不限制（任意 as:audit / as:audit file / as:audit target / as:audit project 均运行）</option>
        <option value="file">同文件（仅 as:audit file 时运行）</option>
        <option value="target">同 target（仅 as:audit target 时运行）</option>
        <option value="project">同项目（仅 as:audit project 时运行）</option>
        </select>
      </div>
      <div>
      <label htmlFor="rule-note" className="block text-xs font-medium text-slate-600 mb-1">备注（可选）</label>
      <input
        id="rule-note"
        name="note"
        type="text"
        value={addRuleForm.note}
        onChange={e => setAddRuleForm(f => ({ ...f, note: e.target.value }))}
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
        placeholder="仅作简单模式提示"
        />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={addRuleSubmitting} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
        {addRuleSubmitting ? '写入中...' : '确认写入'}
        </button>
        <button type="button" onClick={() => setShowAddRule(false)} className="px-4 py-2 text-slate-600 text-sm rounded-lg hover:bg-slate-100">
        收起
        </button>
      </div>
      </form>
    )}
    </section>
    )}

    {/* 规则表 */}
    <section className="mb-8">
    <h3 className="text-sm font-semibold text-slate-700 mb-3">iOS 版本规则（guard-rules.json）</h3>
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
      <thead className="bg-slate-50 border-b border-slate-200">
        <tr>
        <th className="text-left py-2 px-4 font-medium text-slate-600">规则 ID</th>
        <th className="text-left py-2 px-4 font-medium text-slate-600">严重性</th>
        <th className="text-left py-2 px-4 font-medium text-slate-600">说明</th>
        <th className="text-left py-2 px-4 font-medium text-slate-600">适用语言</th>
        <th className="text-left py-2 px-4 font-medium text-slate-600">审查规模</th>
        </tr>
      </thead>
      <tbody>
        {ruleEntries.length === 0 ? (
        <tr><td colSpan={5} className="py-4 px-4 text-slate-500">暂无规则</td></tr>
        ) : (
        ruleEntries.map(([id, r]) => (
          <tr key={id} className="border-b border-slate-100 last:border-0">
          <td className="py-2 px-4 font-mono text-xs">{id}</td>
          <td className="py-2 px-4">
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${r.severity === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
            {r.severity}
            </span>
          </td>
          <td className="py-2 px-4 text-slate-700">{r.message}</td>
          <td className="py-2 px-4 text-slate-500">{(r.languages || []).join(', ')}</td>
          <td className="py-2 px-4 text-slate-500 text-xs">
            {r.dimension === 'file' ? '同文件' : r.dimension === 'target' ? '同 target' : r.dimension === 'project' ? '同项目' : '—'}
          </td>
          </tr>
        ))
        )}
      </tbody>
      </table>
    </div>
    </section>

    {/* 违反记录 */}
    <section>
    <h3 className="text-sm font-semibold text-slate-700 mb-3">
      违反记录（共 {runs.length} 次运行，{totalViolations} 处违反）
    </h3>
    {runs.length === 0 ? (
      <div className="bg-slate-50 border border-slate-200 rounded-xl py-12 text-center text-slate-500">
      暂无违反记录。在源码中写入 <code className="bg-slate-200 px-1 rounded">// as:audit</code> 并保存，watch 会执行静态规则检查并记录在此。
      </div>
    ) : (
      <div className="space-y-2">
      {runs.map((run) => {
        const isExpanded = expandedRunId === run.id;
        const hasViolations = run.violations.length > 0;
        return (
        <div key={run.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <button
          type="button"
          onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
          className="w-full flex items-center gap-2 py-3 px-4 text-left hover:bg-slate-50 transition-colors"
          >
          {isExpanded ? <ChevronDown size={ICON_SIZES.md} /> : <ChevronRight size={ICON_SIZES.md} />}
          <span className="font-mono text-sm text-slate-700">{run.filePath}</span>
          <span className="text-xs text-slate-400">
            {new Date(run.triggeredAt).toLocaleString()}
          </span>
          {hasViolations ? (
            <span className="ml-auto flex items-center gap-1 text-amber-600 text-xs font-medium">
            <AlertTriangle size={ICON_SIZES.sm} /> {run.violations.length} 处违反
            </span>
          ) : (
            <span className="ml-auto text-slate-400 text-xs">无违反</span>
          )}
          </button>
          {isExpanded && (
          <div className="border-t border-slate-100 bg-slate-50/50 p-4">
            {run.violations.length === 0 ? (
            <p className="text-sm text-slate-500">本次运行未发现违反。</p>
            ) : (
            <ul className="space-y-2">
              {run.violations.map((v, i) => {
              const matchedRule = rules[v.ruleId];
              return (
              <li key={i} className="flex items-start gap-2 text-sm">
                {v.severity === 'error' ? (
                <AlertCircle size={ICON_SIZES.md} className="text-red-500 shrink-0 mt-0.5" />
                ) : (
                <AlertTriangle size={ICON_SIZES.md} className="text-amber-500 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 space-y-1.5">
                <div>
                  <span className="font-mono text-xs text-slate-500">[{v.ruleId}] {v.filePath ? `${v.filePath}:${v.line}` : `L${v.line}`}</span>
                  {v.dimension && (
                  <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
                    {v.dimension === 'file' ? '同文件' : v.dimension === 'target' ? '同 target' : '同项目'}
                  </span>
                  )}
                  <span className="text-slate-700 ml-2">{v.message}</span>
                </div>
                {v.snippet && (
                  <pre className="text-xs text-slate-600 bg-slate-100 p-2 rounded overflow-x-auto">
                  {v.snippet}
                  </pre>
                )}
                {/* ── 规则溯源增强 ── */}
                {matchedRule && (matchedRule.rationale || matchedRule.fixSuggestions?.length || matchedRule.sourceRecipe || matchedRule.note) && (
                  <div className="mt-1 rounded-lg border border-blue-100 bg-blue-50/50 p-2.5 text-xs space-y-1.5">
                  {matchedRule.rationale && (
                    <div className="flex items-start gap-1.5">
                    <BookOpen size={12} className="text-blue-500 shrink-0 mt-0.5" />
                    <div><span className="font-bold text-blue-700">技术原因：</span><span className="text-slate-600">{matchedRule.rationale}</span></div>
                    </div>
                  )}
                  {matchedRule.fixSuggestions && matchedRule.fixSuggestions.length > 0 && (
                    <div className="flex items-start gap-1.5">
                    <Wrench size={12} className="text-emerald-500 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold text-emerald-700">修复建议：</span>
                      <ul className="mt-0.5 space-y-0.5 text-slate-600">
                      {matchedRule.fixSuggestions.map((s, j) => (
                        <li key={j} className="flex items-start gap-1">
                        <span className="text-emerald-400 mt-0.5">•</span>
                        <span>{s}</span>
                        <button
                          className="ml-1 text-blue-500 hover:text-blue-700"
                          title="复制修复建议"
                          onClick={() => navigator.clipboard.writeText(s)}
                        >
                          ⎘
                        </button>
                        </li>
                      ))}
                      </ul>
                    </div>
                    </div>
                  )}
                  {matchedRule.sourceRecipe && (
                    <div className="flex items-center gap-1.5">
                    <Link2 size={12} className="text-indigo-500 shrink-0" />
                    <span className="font-bold text-indigo-700">来源 Recipe：</span>
                    <span className="text-indigo-600 font-mono">{matchedRule.sourceRecipe}</span>
                    </div>
                  )}
                  {!matchedRule.rationale && matchedRule.note && (
                    <div className="text-slate-500 italic">备注：{matchedRule.note}</div>
                  )}
                  </div>
                )}
                </div>
              </li>
              );
              })}
            </ul>
            )}
          </div>
          )}
        </div>
        );
      })}
      </div>
    )}
    </section>
    </div>
  </div>
  );
};

export default GuardView;
