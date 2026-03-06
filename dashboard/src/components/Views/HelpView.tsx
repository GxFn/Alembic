import React, { useState } from 'react';
import { BookOpen, Rocket, Database, Zap, Search, Shield, Code, GitBranch, MessageSquare, Terminal, FileCode, List, ChevronDown, ChevronRight, Layers, RefreshCw, ArrowRightLeft, BarChart3, Network, MonitorSmartphone, Lock, Brain } from 'lucide-react';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import TokenUsageChart from '../Charts/TokenUsageChart';

const Section = ({ id, title, icon, isExpanded, onToggle, children }: { id: string; title: string; icon: React.ReactNode; isExpanded: boolean; onToggle: (id: string) => void; children: React.ReactNode }) => {
  return (
    <section className="border border-[var(--border-default)] rounded-lg overflow-hidden">
      <button
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between p-4 bg-[var(--bg-subtle)] hover:bg-[var(--bg-muted)] active:bg-[var(--bg-muted)] outline-none focus:outline-none focus-visible:outline-none transition-colors"
      >
        <div className="flex items-center gap-3">
          {icon}
          <h2 className="text-lg font-bold text-[var(--fg-primary)]">{title}</h2>
        </div>
        {isExpanded ? <ChevronDown size={ICON_SIZES.lg} /> : <ChevronRight size={ICON_SIZES.lg} />}
      </button>
      {isExpanded && <div className="p-4 bg-[var(--bg-surface)]">{children}</div>}
    </section>
  );
};

const HelpView: React.FC = () => {
  const { t } = useI18n();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['quick-start']));

  const toggleSection = (section: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(section)) {
      newExpanded.delete(section);
    } else {
      newExpanded.add(section);
    }
    setExpandedSections(newExpanded);
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      {/* 头部 */}
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-bold text-[var(--fg-primary)] mb-4 flex items-center justify-center gap-3">
          <BookOpen size={ICON_SIZES.xxl} className="text-blue-600" />
          {t('help.pageTitle')}
        </h1>
        <p className="text-[var(--fg-secondary)] text-lg max-w-3xl mx-auto text-center">
          {t('help.subtitle')}
        </p>
        <p className="text-[var(--fg-muted)] text-sm mt-2">{t('help.techSpecs')}</p>
        <div className="mt-6 flex gap-4 justify-center text-sm">
          <a href="https://github.com/GxFn/AutoSnippet" target="_blank" rel="noopener noreferrer" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            {t('help.viewGithub')}
          </a>
          <a href="https://github.com/GxFn/AutoSnippet/blob/main/README.md" target="_blank" rel="noopener noreferrer" className="px-4 py-2 border border-[var(--border-default)] text-[var(--fg-primary)] rounded-lg hover:bg-[var(--bg-subtle)] transition-colors">
            {t('help.fullDocs')}
          </a>
        </div>
      </div>

      <div className="space-y-4">
        {/* Token 用量统计 */}
        <Section id="token-usage" title={t('help.tokenUsageLast7Days')} icon={<BarChart3 size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('token-usage')} onToggle={toggleSection}>
          <TokenUsageChart />
        </Section>

        {/* 快速开始 */}
        <Section id="quick-start" title={t('help.quickStart')} icon={<Rocket size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('quick-start')} onToggle={toggleSection}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <div className="bg-blue-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">1</div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.step1Title')}</h3>
              <pre className="bg-blue-100/70 text-blue-900 px-3 py-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all"><code>npm install -g autosnippet{'\n'}cd your-project{'\n'}asd setup</code></pre>
            </div>
            <div className="bg-green-50 rounded-lg p-4 border border-green-200">
              <div className="bg-green-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">2</div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.step2Title')}</h3>
              <pre className="bg-green-100/70 text-green-900 px-3 py-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all"><code>asd ui</code></pre>
              <p className="text-[var(--fg-secondary)] text-xs mt-2">{t('help.step2Desc')}</p>
            </div>
            <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
              <div className="bg-purple-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">3</div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.step3Title')}</h3>
              <pre className="bg-purple-100/70 text-purple-900 px-3 py-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all"><code>asd upgrade</code></pre>
              <p className="text-[var(--fg-secondary)] text-xs mt-2">{t('help.step3Desc')}</p>
            </div>
            <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
              <div className="bg-amber-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">4</div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.step4Title')}</h3>
              <pre className="bg-amber-100/70 text-amber-900 px-3 py-2 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all mb-2"><code>asd coldstart</code></pre>
              <p className="text-[var(--fg-secondary)] text-xs">{t('help.step4Desc1')}</p>
              <p className="text-[var(--fg-secondary)] text-xs">{t('help.step4Desc2')}</p>
            </div>
          </div>
        </Section>

        {/* 核心概念 */}
        <Section id="concepts" title={t('help.coreConcepts')} icon={<Database size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('concepts')} onToggle={toggleSection}>
          {/* 三大角色 */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-[var(--fg-primary)] mb-3">{t('help.threeRoles')}</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full border border-[var(--border-default)] rounded-lg text-sm">
                <thead>
                  <tr className="bg-[var(--bg-subtle)]">
                    <th className="px-4 py-3 border-b text-left font-semibold">{t('help.roleColumn')}</th>
                    <th className="px-4 py-3 border-b text-left font-semibold">{t('help.responsibilityColumn')}</th>
                    <th className="px-4 py-3 border-b text-left font-semibold">{t('help.capabilityColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="hover:bg-[var(--bg-subtle)]">
                    <td className="px-4 py-3 border-b font-medium text-blue-700">{t('help.roleDeveloper')}</td>
                    <td className="px-4 py-3 border-b">{t('help.developerResp')}</td>
                    <td className="px-4 py-3 border-b text-xs" dangerouslySetInnerHTML={{ __html: t('help.developerCap') }} />
                  </tr>
                  <tr className="hover:bg-[var(--bg-subtle)]">
                    <td className="px-4 py-3 border-b font-medium text-green-700">{t('help.roleCursorAgent')}</td>
                    <td className="px-4 py-3 border-b">{t('help.cursorAgentResp')}</td>
                    <td className="px-4 py-3 border-b text-xs" dangerouslySetInnerHTML={{ __html: t('help.cursorAgentCap') }} />
                  </tr>
                  <tr className="hover:bg-[var(--bg-subtle)]">
                    <td className="px-4 py-3 font-medium text-purple-700">{t('help.roleChatAgent')}</td>
                    <td className="px-4 py-3">{t('help.chatAgentResp')}</td>
                    <td className="px-4 py-3 text-xs" dangerouslySetInnerHTML={{ __html: t('help.chatAgentCap') }} />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* 核心组件 — Agent 优先，知识生产管线紧邻 */}
          <div>
            <h3 className="text-lg font-semibold text-[var(--fg-primary)] mb-3">{t('help.coreComponents')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 [&_li]:break-words">
              {/* 1. Bootstrap — 知识生产起点 */}
              <div className="bg-green-50 rounded-lg p-4 border border-green-200">
                <h4 className="font-semibold text-green-900 mb-2 flex items-center gap-2">
                  <Zap size={ICON_SIZES.lg} />
                  {t('help.bootstrapLabel')}
                </h4>
                <p className="text-green-800 text-sm mb-3">{t('help.bootstrapDesc')}</p>
                <ul className="text-green-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.bootstrapBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.bootstrapBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.bootstrapBullet3') }} />
                </ul>
              </div>
              {/* 2. Candidates — 知识生产中间态 */}
              <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                <h4 className="font-semibold text-purple-900 mb-2 flex items-center gap-2">
                  <List size={ICON_SIZES.lg} />
                  {t('help.candidatesLabel')}
                </h4>
                <p className="text-purple-800 text-sm mb-3">{t('help.candidatesDesc')}</p>
                <ul className="text-purple-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.candidatesBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.candidatesBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.candidatesBullet3') }} />
                </ul>
              </div>
              {/* 3. Recipe — 知识生产终态 */}
              <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                <h4 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                  <FileCode size={ICON_SIZES.lg} />
                  {t('help.recipeLabel')}
                </h4>
                <p className="text-blue-800 text-sm mb-3">{t('help.recipeDesc')}</p>
                <ul className="text-blue-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.recipeBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.recipeBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.recipeBullet3') }} />
                </ul>
              </div>
              {/* 5. Agent Runtime */}
              <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200">
                <h4 className="font-semibold text-indigo-900 mb-2 flex items-center gap-2">
                  <ArrowRightLeft size={ICON_SIZES.lg} />
                  {t('help.chatAgentLabel')}
                </h4>
                <p className="text-indigo-800 text-sm mb-3">{t('help.chatAgentDesc')}</p>
                <ul className="text-indigo-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.chatAgentCompBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.chatAgentCompBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.chatAgentCompBullet3') }} />
                </ul>
              </div>
              {/* 6. Search Pipeline */}
              <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
                <h4 className="font-semibold text-amber-900 mb-2 flex items-center gap-2">
                  <Search size={ICON_SIZES.lg} />
                  {t('help.searchPipelineLabel')}
                </h4>
                <p className="text-amber-800 text-sm mb-3">{t('help.searchPipelineDesc')}</p>
                <ul className="text-amber-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.searchPipelineBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.searchPipelineBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.searchPipelineBullet3') }} />
                </ul>
              </div>
              {/* 6. TaskGraph */}
              <div className="bg-cyan-50 rounded-lg p-4 border border-cyan-200">
                <h4 className="font-semibold text-cyan-900 mb-2 flex items-center gap-2">
                  <Network size={ICON_SIZES.lg} />
                  {t('help.taskGraphLabel')}
                </h4>
                <p className="text-cyan-800 text-sm mb-3">{t('help.taskGraphDesc')}</p>
                <ul className="text-cyan-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.taskGraphBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.taskGraphBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.taskGraphBullet3') }} />
                </ul>
              </div>
              {/* 7. Guard */}
              <div className="bg-rose-50 rounded-lg p-4 border border-rose-200">
                <h4 className="font-semibold text-rose-900 mb-2 flex items-center gap-2">
                  <Shield size={ICON_SIZES.lg} />
                  {t('help.guardLabel')}
                </h4>
                <p className="text-rose-800 text-sm mb-3">{t('help.guardDesc')}</p>
                <ul className="text-rose-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.guardCompBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.guardCompBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.guardCompBullet3') }} />
                </ul>
              </div>
              {/* 8. IDE Integration */}
              <div className="bg-teal-50 rounded-lg p-4 border border-teal-200">
                <h4 className="font-semibold text-teal-900 mb-2 flex items-center gap-2">
                  <MonitorSmartphone size={ICON_SIZES.lg} />
                  {t('help.ideIntegrationLabel')}
                </h4>
                <p className="text-teal-800 text-sm mb-3">{t('help.ideIntegrationDesc')}</p>
                <ul className="text-teal-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.ideIntegrationBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.ideIntegrationBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.ideIntegrationBullet3') }} />
                </ul>
              </div>
              {/* 9. Security */}
              <div className="bg-orange-50 rounded-lg p-4 border border-orange-200">
                <h4 className="font-semibold text-orange-900 mb-2 flex items-center gap-2">
                  <Lock size={ICON_SIZES.lg} />
                  {t('help.securityLabel')}
                </h4>
                <p className="text-orange-800 text-sm mb-3">{t('help.securityDesc')}</p>
                <ul className="text-orange-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.securityBullet1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.securityBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.securityBullet3') }} />
                </ul>
              </div>
            </div>
          </div>

          {/* 端到端架构流 */}
          <div className="mt-6 mb-6 p-4 bg-[var(--bg-subtle)] rounded-lg border border-[var(--border-default)]">
            <h3 className="text-lg font-semibold text-[var(--fg-primary)] mb-3">{t('help.archOverviewLabel')}</h3>
            <div className="flex items-center justify-between gap-1 text-xs overflow-x-auto pb-2">
              <div className="bg-indigo-100 text-indigo-700 px-3 py-2 rounded-lg font-medium text-center shrink-0">{t('help.archOverviewBootstrap')}</div>
              <span className="text-[var(--fg-muted)] shrink-0">→</span>
              <div className="bg-blue-100 text-blue-700 px-3 py-2 rounded-lg font-medium text-center shrink-0">{t('help.archOverviewKB')}</div>
              <span className="text-[var(--fg-muted)] shrink-0">→</span>
              <div className="bg-blue-100 text-blue-700 px-3 py-2 rounded-lg font-medium text-center shrink-0">{t('help.archOverviewPipeline')}</div>
              <span className="text-[var(--fg-muted)] shrink-0">→</span>
              <div className="bg-emerald-100 text-emerald-700 px-3 py-2 rounded-lg font-medium text-center shrink-0">{t('help.archOverviewAgent')}</div>
              <span className="text-[var(--fg-muted)] shrink-0">→</span>
              <div className="bg-amber-100 text-amber-700 px-3 py-2 rounded-lg font-medium text-center shrink-0">{t('help.archOverviewTask')}</div>
              <span className="text-[var(--fg-muted)] shrink-0">→</span>
              <div className="bg-emerald-100 text-emerald-700 px-3 py-2 rounded-lg font-medium text-center shrink-0">{t('help.archOverviewOutput')}</div>
            </div>
            <div className="mt-2 flex items-center justify-center gap-3 text-xs">
              <span className="bg-rose-100 text-rose-700 px-3 py-1.5 rounded-lg font-medium">↕ {t('help.archOverviewSecurity')} ↕</span>
              <span className="bg-teal-100 text-teal-700 px-3 py-1.5 rounded-lg font-medium">↕ {t('help.archOverviewIDE')} ↕</span>
            </div>
          </div>

          {/* 闭环流程 */}
          <div className="mt-6 rounded-lg p-5 border border-[var(--border-default)] bg-[var(--bg-subtle)]">
            <h3 className="text-lg font-semibold text-[var(--fg-primary)] mb-5">{t('help.knowledgeLoop')}</h3>
            <div className="flex items-start justify-between gap-0 overflow-x-auto pb-2">
              {[
                { step: 1, color: 'blue',   key: 'loopStep1', subKey: 'loopStep1Sub' },
                { step: 2, color: 'green',  key: 'loopStep2', subKey: 'loopStep2Sub' },
                { step: 3, color: 'purple', key: 'loopStep3', subKey: 'loopStep3Sub' },
                { step: 4, color: 'amber',  key: 'loopStep4', subKey: 'loopStep4Sub' },
                { step: 5, color: 'rose',   key: 'loopStep5', subKey: 'loopStep5Sub' },
              ].map((item, idx) => (
                <React.Fragment key={item.step}>
                  <div className="flex-1 min-w-[90px] flex flex-col items-center text-center">
                    <div className={`w-11 h-11 rounded-full flex items-center justify-center font-bold text-lg text-white shadow-md mb-2.5 bg-${item.color}-500`}>
                      {item.step}
                    </div>
                    <p className="text-[var(--fg-primary)] font-semibold text-sm leading-tight">{t(`help.${item.key}`)}</p>
                    <p className="text-[var(--fg-muted)] text-xs mt-1 font-mono">{t(`help.${item.subKey}`)}</p>
                  </div>
                  {idx < 4 && (
                    <div className="flex items-center pt-3 px-1 shrink-0">
                      <div className="w-6 h-px bg-[var(--border-default)]" />
                      <span className="text-[var(--fg-muted)] text-xs mx-0.5">›</span>
                      <div className="w-6 h-px bg-[var(--border-default)]" />
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-center">
              <div className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
                <span className="inline-block w-8 h-px bg-rose-400/50" />
                <span className="italic">{t('help.loopStep5')}</span>
                <span>→</span>
                <span className="italic">{t('help.loopStep1')}</span>
                <span className="inline-block w-8 h-px bg-blue-400/50" />
              </div>
            </div>
          </div>
        </Section>

        {/* Agent 架构 */}
        <Section id="agent-arch" title={t('help.agentArchTitle')} icon={<Brain size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('agent-arch')} onToggle={toggleSection}>
          <p className="text-[var(--fg-secondary)] text-sm mb-5">{t('help.agentArchDesc')}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {/* Preset Modes */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
                  <Layers size={ICON_SIZES.lg} className="text-indigo-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.agentArchPresetTitle')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.agentArchPresetDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchPresetChat') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchPresetInsight') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchPresetLark') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchPresetRemoteExec') }} />
              </ul>
            </div>
            {/* Strategies */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                  <GitBranch size={ICON_SIZES.lg} className="text-emerald-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.agentArchStrategyTitle')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.agentArchStrategyDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchStrategySingle') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchStrategyPipeline') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchStrategyFanOut') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchStrategyAdaptive') }} />
              </ul>
            </div>
            {/* Capabilities */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                  <Zap size={ICON_SIZES.lg} className="text-blue-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.agentArchCapTitle')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.agentArchCapDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchCapConversation') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchCapCodeAnalysis') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchCapKnowledgeProd') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchCapScanProd') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchCapSystem') }} />
              </ul>
            </div>
            {/* Memory */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-purple-100 flex items-center justify-center shrink-0">
                  <Database size={ICON_SIZES.lg} className="text-purple-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.agentArchMemoryTitle')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.agentArchMemoryDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchMemoryWorking') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchMemorySession') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchMemoryPersistent') }} />
              </ul>
            </div>
            {/* Context Management */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                  <ArrowRightLeft size={ICON_SIZES.lg} className="text-amber-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.agentArchContextTitle')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.agentArchContextDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchContextWindow') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchContextTracker') }} />
              </ul>
            </div>
            {/* Tools & Router */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
                  <Terminal size={ICON_SIZES.lg} className="text-rose-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.agentArchToolsTitle')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.agentArchToolsDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchToolsInternal') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.agentArchToolsMcp') }} />
              </ul>
              <div className="mt-3 pt-3 border-t border-[var(--border-default)]">
                <p className="text-xs font-semibold text-[var(--fg-primary)] mb-1">{t('help.agentArchRouterTitle')}</p>
                <p className="text-xs text-[var(--fg-secondary)]">{t('help.agentArchRouterDesc')}</p>
              </div>
            </div>
          </div>
        </Section>

        {/* 核心功能 */}
        <Section id="features" title={t('help.coreFeatures')} icon={<Zap size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('features')} onToggle={toggleSection}>
          <p className="text-[var(--fg-secondary)] text-sm mb-5">{t('help.coreFeaturesDesc')}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {/* Knowledge Build */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                  <Code size={ICON_SIZES.lg} className="text-blue-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.knowledgeBuild')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.kbBuildDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.kbBuildBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.kbBuildBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.kbBuildBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.kbBuildBullet4') }} />
              </ul>
            </div>
            {/* Semantic Search */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                  <Search size={ICON_SIZES.lg} className="text-emerald-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.semanticSearchLabel')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.semSearchDescShort')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.semSearchBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.semSearchBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.semSearchBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.semSearchBullet4') }} />
              </ul>
            </div>
            {/* Guard Compliance */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-purple-100 flex items-center justify-center shrink-0">
                  <Shield size={ICON_SIZES.lg} className="text-purple-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.guardCompliance')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.guardComplianceDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.auditFeatureBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.auditFeatureBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.auditFeatureBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.auditFeatureBullet4') }} />
              </ul>
            </div>
            {/* TaskGraph */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                  <Network size={ICON_SIZES.lg} className="text-amber-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.featureTaskGraphTitle')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.featureTaskGraphDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.featureTaskGraphBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.featureTaskGraphBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.featureTaskGraphBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.featureTaskGraphBullet4') }} />
              </ul>
            </div>
            {/* Wiki Doc Generation */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
                  <FileCode size={ICON_SIZES.lg} className="text-rose-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.wikiDocGen')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.wikiDocGenDesc')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.wikiDocBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.wikiDocBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.wikiDocBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.wikiDocBullet4') }} />
              </ul>
            </div>
            {/* Data Sync */}
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-teal-100 flex items-center justify-center shrink-0">
                  <RefreshCw size={ICON_SIZES.lg} className="text-teal-600" />
                </div>
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.dataSync')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mb-3">{t('help.syncDescShort')}</p>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.syncBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.syncBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.syncBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.syncBullet4') }} />
              </ul>
            </div>
          </div>
        </Section>

        {/* 编辑器指令 */}
        <Section id="editor-directives" title={t('help.editorDirectives')} icon={<Terminal size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('editor-directives')} onToggle={toggleSection}>
          <p className="text-[var(--fg-secondary)] text-sm mb-4">{t('help.editorDirectivesNote')}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[var(--bg-subtle)] rounded-lg p-4 border border-[var(--border-default)]">
              <h4 className="font-semibold text-[var(--fg-primary)] mb-2"><code className="bg-slate-200 px-2 py-1 rounded">// as:create</code> · <code className="bg-slate-200 px-2 py-1 rounded">asc</code></h4>
              <p className="text-[var(--fg-secondary)] text-sm mb-2">{t('help.createDirective')}</p>
              <ul className="text-[var(--fg-secondary)] text-xs space-y-1 list-disc list-inside">
                <li>{t('help.createDirBullet1')}</li>
                <li dangerouslySetInnerHTML={{ __html: t('help.createDirBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.createDirBullet3') }} />
              </ul>
            </div>
            <div className="bg-[var(--bg-subtle)] rounded-lg p-4 border border-[var(--border-default)]">
              <h4 className="font-semibold text-[var(--fg-primary)] mb-2"><code className="bg-slate-200 px-2 py-1 rounded">// as:search</code> · <code className="bg-slate-200 px-2 py-1 rounded">ass</code></h4>
              <p className="text-[var(--fg-secondary)] text-sm mb-2">{t('help.searchDirective')}</p>
              <ul className="text-[var(--fg-secondary)] text-xs space-y-1 list-disc list-inside">
                <li>{t('help.searchDirBullet1')}</li>
                <li>{t('help.searchDirBullet2')}</li>
                <li>{t('help.searchDirBullet3')}</li>
              </ul>
            </div>
            <div className="bg-[var(--bg-subtle)] rounded-lg p-4 border border-[var(--border-default)]">
              <h4 className="font-semibold text-[var(--fg-primary)] mb-2"><code className="bg-slate-200 px-2 py-1 rounded">// as:audit</code> · <code className="bg-slate-200 px-2 py-1 rounded">asa</code></h4>
              <p className="text-[var(--fg-secondary)] text-sm mb-2">{t('help.auditDirective')}</p>
              <ul className="text-[var(--fg-secondary)] text-xs space-y-1 list-disc list-inside">
                <li>{t('help.auditDirBullet1')}</li>
                <li dangerouslySetInnerHTML={{ __html: t('help.auditDirBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.auditDirBullet3') }} />
              </ul>
            </div>
            <div className="bg-[var(--bg-subtle)] rounded-lg p-4 border border-[var(--border-default)]">
              <h4 className="font-semibold text-[var(--fg-primary)] mb-2"><code className="bg-slate-200 px-2 py-1 rounded">// as:include</code> · <code className="bg-slate-200 px-2 py-1 rounded">// as:import</code></h4>
              <p className="text-[var(--fg-secondary)] text-sm mb-2">{t('help.includeDirective')}</p>
              <ul className="text-[var(--fg-secondary)] text-xs space-y-1 list-disc list-inside">
                <li>{t('help.includeDirBullet1')}</li>
                <li>{t('help.includeDirBullet2')}</li>
              </ul>
            </div>
          </div>
        </Section>

        {/* Cursor 集成 */}
        <Section id="cursor-integration" title={t('help.cursorIntegration')} icon={<MessageSquare size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('cursor-integration')} onToggle={toggleSection}>
          {/* Skills */}
          <div className="mb-5">
            <h3 className="font-semibold text-[var(--fg-primary)] mb-3">{t('help.skills10')}</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {[
                { name: 'intent', descKey: 'help.skillIntent' },
                { name: 'concepts', descKey: 'help.skillConcepts' },
                { name: 'candidates', descKey: 'help.skillCandidates' },
                { name: 'recipes', descKey: 'help.skillRecipes' },
                { name: 'guard', descKey: 'help.skillGuard' },
                { name: 'structure', descKey: 'help.skillStructure' },
                { name: 'analysis', descKey: 'help.skillAnalysis' },
                { name: 'coldstart', descKey: 'help.skillColdstart' },
                { name: 'create', descKey: 'help.skillCreate' },
                { name: 'lifecycle', descKey: 'help.skillLifecycle' },
                { name: 'devdocs', descKey: 'help.skillDevdocs' },
              ].map(s => (
                <div key={s.name} className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-center">
                  <p className="text-xs font-mono text-blue-600">{s.name}</p>
                  <p className="text-xs text-[var(--fg-secondary)] mt-0.5">{t(s.descKey)}</p>
                </div>
              ))}
            </div>
          </div>

          {/* MCP 工具 */}
          <div className="mb-5">
            <h3 className="font-semibold text-[var(--fg-primary)] mb-3">{t('help.mcp16')}</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full border border-[var(--border-default)] rounded-lg text-xs">
                <thead>
                  <tr className="bg-[var(--bg-subtle)]">
                    <th className="px-3 py-2 border-b text-left">{t('help.mcpLayerHeader')}</th>
                    <th className="px-3 py-2 border-b text-left">{t('help.mcpToolHeader')}</th>
                    <th className="px-3 py-2 border-b text-left">{t('help.mcpDescHeader')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-blue-50/30"><td colSpan={3} className="px-3 py-1.5 border-b font-semibold text-blue-700 text-xs">{t('help.mcpAgentLayerHeader')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>health</code></td><td className="px-3 py-2 border-b">{t('help.mcpHealthDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>capabilities</code></td><td className="px-3 py-2 border-b">{t('help.mcpCapabilitiesDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>search</code></td><td className="px-3 py-2 border-b">{t('help.mcpSearchDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>knowledge</code></td><td className="px-3 py-2 border-b">{t('help.mcpKnowledgeDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>structure</code></td><td className="px-3 py-2 border-b">{t('help.mcpStructureDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>graph</code></td><td className="px-3 py-2 border-b">{t('help.mcpGraphDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>call_context</code></td><td className="px-3 py-2 border-b">{t('help.mcpCallContextDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>guard</code></td><td className="px-3 py-2 border-b">{t('help.mcpGuardDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>submit_knowledge</code> / <code>submit_knowledge_batch</code> / <code>save_document</code></td><td className="px-3 py-2 border-b">{t('help.mcpSubmitDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>skill</code></td><td className="px-3 py-2 border-b">{t('help.mcpSkillDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>bootstrap</code></td><td className="px-3 py-2 border-b">{t('help.mcpBootstrapDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>dimension_complete</code></td><td className="px-3 py-2 border-b">{t('help.mcpDimensionCompleteDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>wiki_plan</code> / <code>wiki_finalize</code></td><td className="px-3 py-2 border-b">{t('help.mcpWikiPlanDesc')} · {t('help.mcpWikiFinalizeDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>task</code></td><td className="px-3 py-2 border-b">{t('help.mcpTaskDesc')}</td></tr>
                  <tr className="bg-amber-50/30"><td colSpan={3} className="px-3 py-1.5 border-b font-semibold text-amber-700 text-xs">{t('help.mcpAdminLayerHeader')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">admin</td><td className="px-3 py-2 border-b"><code>enrich_candidates</code> / <code>validate_candidate</code> / <code>check_duplicate</code></td><td className="px-3 py-2 border-b">{t('help.mcpEnrichDesc')}</td></tr>
                  <tr><td className="px-3 py-2 font-medium">admin</td><td className="px-3 py-2"><code>knowledge_lifecycle</code></td><td className="px-3 py-2">{t('help.mcpLifecycleDesc')}</td></tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-[var(--fg-secondary)] mt-2">{t('help.mcpWriteNote')}</p>
          </div>

          {/* 使用示例 */}
          <div>
            <h3 className="font-semibold text-[var(--fg-primary)] mb-3">{t('help.usageExamples')}</h3>
            <div className="space-y-3">
              <div className="bg-blue-50 rounded p-3 border border-blue-200">
                <p className="font-medium text-blue-900 text-sm mb-1">{t('help.exampleSearchKB')}</p>
                <p className="text-blue-800 text-xs">{t('help.exampleSearchKBDesc')}</p>
              </div>
              <div className="bg-green-50 rounded p-3 border border-green-200">
                <p className="font-medium text-green-900 text-sm mb-1">{t('help.exampleBatchScan')}</p>
                <p className="text-green-800 text-xs">{t('help.exampleBatchScanDesc')}</p>
              </div>
              <div className="bg-purple-50 rounded p-3 border border-purple-200">
                <p className="font-medium text-purple-900 text-sm mb-1">{t('help.exampleSubmitCode')}</p>
                <p className="text-purple-800 text-xs">{t('help.exampleSubmitCodeDesc')}</p>
              </div>
            </div>
          </div>

          {/* VSCode Extension */}
          <div className="mt-5">
            <h3 className="font-semibold text-[var(--fg-primary)] mb-3 flex items-center gap-2">
              <MonitorSmartphone size={ICON_SIZES.lg} className="text-blue-600" />
              {t('help.vscodeExtension')}
            </h3>
            <p className="text-[var(--fg-secondary)] text-sm mb-3">{t('help.vscodeExtDesc')}</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-lg p-3">
                <h4 className="font-semibold text-[var(--fg-primary)] text-sm mb-1">{t('help.vscodeExtTaskTool')}</h4>
                <p className="text-[var(--fg-secondary)] text-xs">{t('help.vscodeExtTaskToolDesc')}</p>
              </div>
              <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-lg p-3">
                <h4 className="font-semibold text-[var(--fg-primary)] text-sm mb-1">{t('help.vscodeExtGuardDiag')}</h4>
                <p className="text-[var(--fg-secondary)] text-xs">{t('help.vscodeExtGuardDiagDesc')}</p>
              </div>
              <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-lg p-3">
                <h4 className="font-semibold text-[var(--fg-primary)] text-sm mb-1">{t('help.vscodeExtCodeLens')}</h4>
                <p className="text-[var(--fg-secondary)] text-xs">{t('help.vscodeExtCodeLensDesc')}</p>
              </div>
            </div>
            <div className="bg-[var(--bg-subtle)] border border-[var(--border-default)] rounded-lg p-3">
              <h4 className="font-semibold text-[var(--fg-primary)] text-sm mb-2">Commands</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs text-[var(--fg-secondary)]">
                <p>{t('help.vscodeExtCmd1')}</p>
                <p>{t('help.vscodeExtCmd2')}</p>
                <p>{t('help.vscodeExtCmd3')}</p>
                <p>{t('help.vscodeExtCmd4')}</p>
                <p>{t('help.vscodeExtCmd5')}</p>
              </div>
            </div>
          </div>
        </Section>

        {/* 命令速查 */}
        <Section id="cli-reference" title={t('help.cliReference')} icon={<Terminal size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('cli-reference')} onToggle={toggleSection}>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.initAndEnv')}</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd setup</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliSetupDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd status</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliStatusDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd ui</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliUiDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd upgrade</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliUpgradeDesc')}</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.kbManagement')}</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd sync</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliSyncDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd ais [Target]</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliAisDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd watch</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliWatchDesc')}</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.cliColdstartAndScan')}</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd coldstart</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliColdstartDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd cursor-rules</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliCursorRulesDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd mirror</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliMirrorDesc')}</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.searchAndAudit')}</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd search &lt;query&gt;</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliSearchDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd guard &lt;file&gt;</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliGuardDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd guard:ci</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliGuardCiDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd guard:staged</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliGuardStagedDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd server</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliServerDesc')}</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.cliTaskManagement')}</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd task list</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliTaskListDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd task ready</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliTaskReadyDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd task prime</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliTaskPrimeDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd task stats</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliTaskStatsDesc')}</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.maintenanceUpgrade')}</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd upgrade</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliUpgradeMcpDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd sync --force</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliSyncForceDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd sync --dry-run</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliSyncDryDesc')}</span>
                </div>
              </div>
            </div>
          </div>
        </Section>
      </div>

      {/* 底部提示 */}
      <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg text-center">
        <p className="text-[var(--fg-primary)] text-sm" dangerouslySetInnerHTML={{
          __html: t('help.footerHint', {
            link: `<a href="https://github.com/GxFn/AutoSnippet" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline font-medium">${t('help.footerGithubReadme')}</a>`,
            cmd: '<code class="bg-blue-100 px-1.5 py-0.5 rounded text-xs">asd status</code>'
          })
        }} />
      </div>
    </div>
  );
};

export default HelpView;
