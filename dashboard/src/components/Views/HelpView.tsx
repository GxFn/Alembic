import React, { useState } from 'react';
import { BookOpen, Rocket, Database, Zap, Search, Shield, Code, GitBranch, MessageSquare, Terminal, FileCode, List, ChevronDown, ChevronRight, Layers, RefreshCw, ArrowRightLeft, BarChart3 } from 'lucide-react';
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
              <pre className="bg-blue-100/70 text-blue-900 px-3 py-2 rounded text-xs overflow-hidden"><code>npm install -g autosnippet{'\n'}cd your-project{'\n'}asd setup</code></pre>
            </div>
            <div className="bg-green-50 rounded-lg p-4 border border-green-200">
              <div className="bg-green-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">2</div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.step2Title')}</h3>
              <pre className="bg-green-100/70 text-green-900 px-3 py-2 rounded text-xs overflow-hidden"><code>asd ui</code></pre>
              <p className="text-[var(--fg-secondary)] text-xs mt-2">{t('help.step2Desc')}</p>
            </div>
            <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
              <div className="bg-purple-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">3</div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.step3Title')}</h3>
              <pre className="bg-purple-100/70 text-purple-900 px-3 py-2 rounded text-xs overflow-hidden"><code>asd upgrade</code></pre>
              <p className="text-[var(--fg-secondary)] text-xs mt-2">{t('help.step3Desc')}</p>
            </div>
            <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
              <div className="bg-amber-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">4</div>
              <h3 className="font-semibold text-[var(--fg-primary)] mb-2">{t('help.step4Title')}</h3>
              <p className="text-[var(--fg-secondary)] text-sm mb-1">{t('help.step4Desc1')}</p>
              <p className="text-[var(--fg-secondary)] text-sm">{t('help.step4Desc2')}</p>
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

          {/* 五大组件 */}
          <div>
            <h3 className="text-lg font-semibold text-[var(--fg-primary)] mb-3">{t('help.coreComponents')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="bg-green-50 rounded-lg p-4 border border-green-200">
                <h4 className="font-semibold text-green-900 mb-2 flex items-center gap-2">
                  <Zap size={ICON_SIZES.lg} />
                  {t('help.bootstrapLabel')}
                </h4>
                <p className="text-green-800 text-sm mb-3">{t('help.bootstrapDesc')}</p>
                <ul className="text-green-700 text-xs space-y-1 list-disc list-inside">
                  <li>{t('help.bootstrapBullet1')}</li>
                  <li>{t('help.bootstrapBullet2')}</li>
                  <li dangerouslySetInnerHTML={{ __html: t('help.bootstrapBullet3') }} />
                </ul>
              </div>
              <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                <h4 className="font-semibold text-purple-900 mb-2 flex items-center gap-2">
                  <List size={ICON_SIZES.lg} />
                  {t('help.candidatesLabel')}
                </h4>
                <p className="text-purple-800 text-sm mb-3">{t('help.candidatesDesc')}</p>
                <ul className="text-purple-700 text-xs space-y-1 list-disc list-inside">
                  <li>{t('help.candidatesBullet1')}</li>
                  <li>{t('help.candidatesBullet2')}</li>
                  <li>{t('help.candidatesBullet3')}</li>
                </ul>
              </div>
              <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                <h4 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                  <FileCode size={ICON_SIZES.lg} />
                  {t('help.recipeLabel')}
                </h4>
                <p className="text-blue-800 text-sm mb-3">{t('help.recipeDesc')}</p>
                <ul className="text-blue-700 text-xs space-y-1 list-disc list-inside">
                  <li dangerouslySetInnerHTML={{ __html: t('help.recipeBullet1') }} />
                  <li>{t('help.recipeBullet2')}</li>
                  <li dangerouslySetInnerHTML={{ __html: t('help.recipeBullet3') }} />
                </ul>
              </div>
              <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200">
                <h4 className="font-semibold text-indigo-900 mb-2 flex items-center gap-2">
                  <ArrowRightLeft size={ICON_SIZES.lg} />
                  {t('help.chatAgentLabel')}
                </h4>
                <p className="text-indigo-800 text-sm mb-3">{t('help.chatAgentDesc')}</p>
                <ul className="text-indigo-700 text-xs space-y-1 list-disc list-inside">
                  <li>{t('help.chatAgentCompBullet1')}</li>
                  <li>{t('help.chatAgentCompBullet2')}</li>
                  <li>{t('help.chatAgentCompBullet3')}</li>
                </ul>
              </div>
              <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
                <h4 className="font-semibold text-amber-900 mb-2 flex items-center gap-2">
                  <Search size={ICON_SIZES.lg} />
                  {t('help.searchPipelineLabel')}
                </h4>
                <p className="text-amber-800 text-sm mb-3">{t('help.searchPipelineDesc')}</p>
                <ul className="text-amber-700 text-xs space-y-1 list-disc list-inside">
                  <li>{t('help.searchPipelineBullet1')}</li>
                  <li>{t('help.searchPipelineBullet2')}</li>
                  <li>{t('help.searchPipelineBullet3')}</li>
                </ul>
              </div>
              <div className="bg-rose-50 rounded-lg p-4 border border-rose-200">
                <h4 className="font-semibold text-rose-900 mb-2 flex items-center gap-2">
                  <Shield size={ICON_SIZES.lg} />
                  {t('help.guardLabel')}
                </h4>
                <p className="text-rose-800 text-sm mb-3">{t('help.guardDesc')}</p>
                <ul className="text-rose-700 text-xs space-y-1 list-disc list-inside">
                  <li>{t('help.guardCompBullet1')}</li>
                  <li dangerouslySetInnerHTML={{ __html: t('help.guardCompBullet2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('help.guardCompBullet3') }} />
                </ul>
              </div>
            </div>
          </div>

          {/* 闭环流程 */}
          <div className="mt-6 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-5 border border-[var(--border-default)]">
            <h3 className="text-lg font-semibold text-[var(--fg-primary)] mb-4">{t('help.knowledgeLoop')}</h3>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-blue-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">1</div>
                <p className="text-[var(--fg-primary)] font-medium text-sm">{t('help.loopStep1')}</p>
                <p className="text-[var(--fg-secondary)] text-xs">{t('help.loopStep1Sub')}</p>
              </div>
              <div className="text-[var(--fg-muted)] text-2xl">→</div>
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-green-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">2</div>
                <p className="text-[var(--fg-primary)] font-medium text-sm">{t('help.loopStep2')}</p>
                <p className="text-[var(--fg-secondary)] text-xs">{t('help.loopStep2Sub')}</p>
              </div>
              <div className="text-[var(--fg-muted)] text-2xl">→</div>
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-purple-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">3</div>
                <p className="text-[var(--fg-primary)] font-medium text-sm">{t('help.loopStep3')}</p>
                <p className="text-[var(--fg-secondary)] text-xs">{t('help.loopStep3Sub')}</p>
              </div>
              <div className="text-[var(--fg-muted)] text-2xl">→</div>
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-amber-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">4</div>
                <p className="text-[var(--fg-primary)] font-medium text-sm">{t('help.loopStep4')}</p>
                <p className="text-[var(--fg-secondary)] text-xs">{t('help.loopStep4Sub')}</p>
              </div>
              <div className="text-[var(--fg-muted)] text-2xl">→</div>
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-rose-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">5</div>
                <p className="text-[var(--fg-primary)] font-medium text-sm">{t('help.loopStep5')}</p>
                <p className="text-[var(--fg-secondary)] text-xs">{t('help.loopStep5Sub')}</p>
              </div>
            </div>
          </div>
        </Section>

        {/* 核心功能 */}
        <Section id="features" title={t('help.coreFeatures')} icon={<Zap size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('features')} onToggle={toggleSection}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-2 mb-3">
                <Code size={ICON_SIZES.lg} className="text-blue-600" />
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.knowledgeBuild')}</h3>
              </div>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.kbBuildBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.kbBuildBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.kbBuildBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.kbBuildBullet4') }} />
              </ul>
            </div>
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-2 mb-3">
                <Search size={ICON_SIZES.lg} className="text-blue-600" />
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.semanticSearchLabel')}</h3>
              </div>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.semSearchBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.semSearchBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.semSearchBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.semSearchBullet4') }} />
              </ul>
            </div>
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-2 mb-3">
                <Shield size={ICON_SIZES.lg} className="text-blue-600" />
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.codeAudit')}</h3>
              </div>
              <ul className="text-[var(--fg-secondary)] text-sm space-y-2 list-disc list-inside">
                <li dangerouslySetInnerHTML={{ __html: t('help.auditFeatureBullet1') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.auditFeatureBullet2') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.auditFeatureBullet3') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.auditFeatureBullet4') }} />
              </ul>
            </div>
            <div className="border border-[var(--border-default)] rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-2 mb-3">
                <RefreshCw size={ICON_SIZES.lg} className="text-blue-600" />
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.dataSync')}</h3>
              </div>
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
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>guard</code></td><td className="px-3 py-2 border-b">{t('help.mcpGuardDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>submit_knowledge</code> / <code>submit_knowledge_batch</code> / <code>save_document</code></td><td className="px-3 py-2 border-b">{t('help.mcpSubmitDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>skill</code></td><td className="px-3 py-2 border-b">{t('help.mcpSkillDesc')}</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>bootstrap</code></td><td className="px-3 py-2 border-b">{t('help.mcpBootstrapDesc')}</td></tr>
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
        </Section>

        {/* V2 架构亮点 */}
        <Section id="v2-architecture" title={t('help.v3Architecture')} icon={<Layers size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('v2-architecture')} onToggle={toggleSection}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="border border-[var(--border-default)] rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={ICON_SIZES.lg} className="text-indigo-600" />
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.bootstrapEngine')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-sm mb-2">{t('help.bootstrapEngineDesc')}</p>
              <div className="bg-[var(--bg-subtle)] rounded p-3 text-xs font-mono text-[var(--fg-primary)] space-y-1">
                <p>{t('help.archBootstrapStep1')}</p>
                <p>{t('help.archBootstrapStep2')}</p>
                <p>{t('help.archBootstrapStep3')}</p>
              </div>
              <p className="text-[var(--fg-secondary)] text-xs mt-2">{t('help.archBootstrapNote')}</p>
            </div>
            <div className="border border-[var(--border-default)] rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <Search size={ICON_SIZES.lg} className="text-indigo-600" />
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.fourLayerPipeline')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-sm mb-2">{t('help.fourLayerPipelineDesc')}</p>
              <div className="space-y-2 text-xs">
                <div className="flex items-start gap-2">
                  <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-medium shrink-0">L1</span>
                  <span className="text-[var(--fg-secondary)]">{t('help.archPipelineL1')}</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded font-medium shrink-0">L2</span>
                  <span className="text-[var(--fg-secondary)]">{t('help.archPipelineL2')}</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-medium shrink-0">L3</span>
                  <span className="text-[var(--fg-secondary)]">{t('help.archPipelineL3')}</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded font-medium shrink-0">L4</span>
                  <span className="text-[var(--fg-secondary)]">{t('help.archPipelineL4')}</span>
                </div>
              </div>
            </div>
            <div className="border border-[var(--border-default)] rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <ArrowRightLeft size={ICON_SIZES.lg} className="text-indigo-600" />
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.chatAgentSystem')}</h3>
              </div>
              <p className="text-[var(--fg-secondary)] text-sm mb-2">{t('help.chatAgentSystemDesc')}</p>
              <div className="bg-[var(--bg-subtle)] rounded p-3 text-xs text-[var(--fg-primary)] space-y-1.5">
                <p dangerouslySetInnerHTML={{ __html: t('help.archAnalystAgent') }} />
                <p dangerouslySetInnerHTML={{ __html: t('help.archProducerAgent') }} />
                <p dangerouslySetInnerHTML={{ __html: t('help.archHandoff') }} />
                <p dangerouslySetInnerHTML={{ __html: t('help.archMemory') }} />
                <p dangerouslySetInnerHTML={{ __html: t('help.archProjectAware') }} />
              </div>
            </div>
            <div className="border border-[var(--border-default)] rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <GitBranch size={ICON_SIZES.lg} className="text-indigo-600" />
                <h3 className="font-semibold text-[var(--fg-primary)]">{t('help.fiveEntryChannels')}</h3>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <span className="font-medium">CLI</span><span className="text-[var(--fg-secondary)]">{t('help.archCliDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <span className="font-medium">MCP Server</span><span className="text-[var(--fg-secondary)]">{t('help.archMcpDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <span className="font-medium">HTTP API</span><span className="text-[var(--fg-secondary)]">{t('help.archHttpDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <span className="font-medium">Dashboard</span><span className="text-[var(--fg-secondary)]">React 19 + Vite 6 + Tailwind 4</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <span className="font-medium">Skills</span><span className="text-[var(--fg-secondary)]">{t('help.archSkillsDesc')}</span>
                </div>
              </div>
            </div>
          </div>
        </Section>

        {/* 命令速查 */}
        <Section id="cli-reference" title={t('help.cliReference')} icon={<Terminal size={ICON_SIZES.xl} className="text-blue-600" />} isExpanded={expandedSections.has('cli-reference')} onToggle={toggleSection}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                  <code>asd ais --force</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliAisForceDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd watch</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliWatchDesc')}</span>
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
                  <code>asd search -m semantic</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliSearchSemanticDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd guard &lt;file&gt;</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliGuardDesc')}</span>
                </div>
                <div className="flex justify-between bg-[var(--bg-subtle)] px-3 py-2 rounded">
                  <code>asd server</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliServerDesc')}</span>
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
                  <code>asd install:full</code>
                  <span className="text-[var(--fg-secondary)] text-xs">{t('help.cliInstallFullDesc')}</span>
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
