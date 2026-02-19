import React, { useState } from 'react';
import { BookOpen, Rocket, Database, Zap, Search, Shield, Code, GitBranch, MessageSquare, Terminal, FileCode, List, ChevronDown, ChevronRight, Lock, Layers, RefreshCw, ArrowRightLeft, Brain, Network, BarChart3 } from 'lucide-react';
import { ICON_SIZES } from '../../constants/icons';
import TokenUsageChart from '../Charts/TokenUsageChart';

const HelpView: React.FC = () => {
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

  const Section = ({ id, title, icon, children }: { id: string; title: string; icon: React.ReactNode; children: React.ReactNode }) => {
    const isExpanded = expandedSections.has(id);
    return (
      <section className="border border-slate-200 rounded-lg overflow-hidden">
        <button
          onClick={() => toggleSection(id)}
          className="w-full flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 transition-colors"
        >
          <div className="flex items-center gap-3">
            {icon}
            <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          </div>
          {isExpanded ? <ChevronDown size={ICON_SIZES.lg} /> : <ChevronRight size={ICON_SIZES.lg} />}
        </button>
        {isExpanded && <div className="p-4 bg-white">{children}</div>}
      </section>
    );
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      {/* 头部 */}
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-bold text-slate-900 mb-4 flex items-center justify-center gap-3">
          <BookOpen size={ICON_SIZES.xxl} className="text-blue-600" />
          AutoSnippet V3 使用说明
        </h1>
        <p className="text-slate-600 text-lg max-w-3xl mx-auto whitespace-nowrap">
          连接开发者、AI 与项目知识库：ChatAgent 智能对话 · Skills 开放平台 · 知识库持续生长
        </p>
        <p className="text-slate-400 text-sm mt-2">Node.js ≥ 20 · 13 Skills · AI 可自建 · 16 MCP 工具 · ChatAgent 对话 · 4 层检索管线</p>
        <div className="mt-6 flex gap-4 justify-center text-sm">
          <a href="https://github.com/GxFn/AutoSnippet" target="_blank" rel="noopener noreferrer" className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
            查看 GitHub
          </a>
          <a href="https://github.com/GxFn/AutoSnippet/blob/main/README.md" target="_blank" rel="noopener noreferrer" className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors">
            完整文档
          </a>
        </div>
      </div>

      <div className="space-y-4">
        {/* Token 用量统计 */}
        <Section id="token-usage" title="Token 用量（近 7 日）" icon={<BarChart3 size={ICON_SIZES.xl} className="text-blue-600" />}>
          <TokenUsageChart />
        </Section>

        {/* 快速开始 */}
        <Section id="quick-start" title="快速开始" icon={<Rocket size={ICON_SIZES.xl} className="text-blue-600" />}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <div className="bg-blue-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">1</div>
              <h3 className="font-semibold text-slate-800 mb-2">安装与初始化</h3>
              <pre className="bg-blue-100/70 text-blue-900 px-3 py-2 rounded text-xs overflow-hidden"><code>npm install -g autosnippet{'\n'}cd your-project{'\n'}asd setup</code></pre>
            </div>
            <div className="bg-green-50 rounded-lg p-4 border border-green-200">
              <div className="bg-green-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">2</div>
              <h3 className="font-semibold text-slate-800 mb-2">启动 Dashboard</h3>
              <pre className="bg-green-100/70 text-green-900 px-3 py-2 rounded text-xs overflow-hidden"><code>asd ui</code></pre>
              <p className="text-slate-600 text-xs mt-2">启动 HTTP API + Dashboard + FileWatcher</p>
            </div>
            <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
              <div className="bg-purple-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">3</div>
              <h3 className="font-semibold text-slate-800 mb-2">IDE 集成</h3>
              <pre className="bg-purple-100/70 text-purple-900 px-3 py-2 rounded text-xs overflow-hidden"><code>asd upgrade</code></pre>
              <p className="text-slate-600 text-xs mt-2">安装 MCP + Skills + Cursor Rules</p>
            </div>
            <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
              <div className="bg-amber-600 text-white rounded-full w-8 h-8 flex items-center justify-center mb-3 font-bold">4</div>
              <h3 className="font-semibold text-slate-800 mb-2">创建第一个 Recipe</h3>
              <p className="text-slate-600 text-sm mb-1">Dashboard → <strong>New Recipe</strong></p>
              <p className="text-slate-600 text-sm">Use Copied Code → AI 填充 → 保存</p>
            </div>
          </div>
        </Section>

        {/* 核心概念 */}
        <Section id="concepts" title="核心概念" icon={<Database size={ICON_SIZES.xl} className="text-blue-600" />}>
          {/* 三大角色 */}
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-slate-700 mb-3">三大角色</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full border border-slate-200 rounded-lg text-sm">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="px-4 py-3 border-b text-left font-semibold">角色</th>
                    <th className="px-4 py-3 border-b text-left font-semibold">职责</th>
                    <th className="px-4 py-3 border-b text-left font-semibold">能力</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="hover:bg-slate-50">
                    <td className="px-4 py-3 border-b font-medium text-blue-700">开发者</td>
                    <td className="px-4 py-3 border-b">审核与决策、维护项目标准</td>
                    <td className="px-4 py-3 border-b text-xs">Dashboard 审核候选、保存 Recipe；Snippet 补全、<code className="bg-slate-100 px-1 rounded">// as:search</code>；运行 <code className="bg-slate-100 px-1 rounded">asd ui</code></td>
                  </tr>
                  <tr className="hover:bg-slate-50">
                    <td className="px-4 py-3 border-b font-medium text-green-700">Cursor Agent</td>
                    <td className="px-4 py-3 border-b">按规范生成代码、检索知识库</td>
                    <td className="px-4 py-3 border-b text-xs">13 个 Skills 理解规范；16 个 MCP 工具按需检索、提交候选；写操作经 Gateway 审核</td>
                  </tr>
                  <tr className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-purple-700">ChatAgent</td>
                    <td className="px-4 py-3">提取、摘要、扫描、审查</td>
                    <td className="px-4 py-3 text-xs"><code className="bg-slate-100 px-1 rounded">asd ais</code> 批量扫描；分析剪贴板；Guard 审查；Dashboard RAG</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* 五大组件 */}
          <div>
            <h3 className="text-lg font-semibold text-slate-700 mb-3">核心组件</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="bg-green-50 rounded-lg p-4 border border-green-200">
                <h4 className="font-semibold text-green-900 mb-2 flex items-center gap-2">
                  <Zap size={ICON_SIZES.lg} />
                  Bootstrap（冷启动）
                </h4>
                <p className="text-green-800 text-sm mb-3">9 维度自动知识提取引擎</p>
                <ul className="text-green-700 text-xs space-y-1 list-disc list-inside">
                  <li>扫描 SPM Target + AST 分析源码</li>
                  <li>启发式提取 → AI 精炼 → 生成 Candidate</li>
                  <li>MCP 工具：<code className="bg-green-100 px-1 rounded">bootstrap</code>（operation: knowledge / refine / scan）</li>
                </ul>
              </div>
              <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                <h4 className="font-semibold text-purple-900 mb-2 flex items-center gap-2">
                  <List size={ICON_SIZES.lg} />
                  Candidates（候选）
                </h4>
                <p className="text-purple-800 text-sm mb-3">待审核的 Recipe 草案</p>
                <ul className="text-purple-700 text-xs space-y-1 list-disc list-inside">
                  <li>来源：AI 扫描、Cursor、剪贴板、Dashboard</li>
                  <li>审核后入库为 Recipe，确保质量</li>
                  <li>Reasoning 字段记录 AI 推理过程</li>
                </ul>
              </div>
              <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                <h4 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                  <FileCode size={ICON_SIZES.lg} />
                  Recipe（配方）
                </h4>
                <p className="text-blue-800 text-sm mb-3">Markdown 知识文档（Source of Truth）</p>
                <ul className="text-blue-700 text-xs space-y-1 list-disc list-inside">
                  <li>位置：<code className="bg-blue-100 px-1 rounded">AutoSnippet/recipes/*.md</code></li>
                  <li>.md 文件 = 唯一数据源，DB 仅作索引缓存</li>
                  <li><code className="bg-blue-100 px-1 rounded">asd sync</code> 增量同步 .md → DB</li>
                </ul>
              </div>
              <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200">
                <h4 className="font-semibold text-indigo-900 mb-2 flex items-center gap-2">
                  <ArrowRightLeft size={ICON_SIZES.lg} />
                  ChatAgent（智能对话）
                </h4>
                <p className="text-indigo-800 text-sm mb-3">多 Agent 协作架构，可持续扩展</p>
                <ul className="text-indigo-700 text-xs space-y-1 list-disc list-inside">
                  <li>AnalystAgent 分析意图 → ProducerAgent 执行操作</li>
                  <li>HandoffProtocol 自动切换 + 轻量记忆持久化</li>
                  <li>项目感知：自动注入知识库状态上下文</li>
                </ul>
              </div>
              <div className="bg-amber-50 rounded-lg p-4 border border-amber-200">
                <h4 className="font-semibold text-amber-900 mb-2 flex items-center gap-2">
                  <Search size={ICON_SIZES.lg} />
                  4 层检索管线
                </h4>
                <p className="text-amber-800 text-sm mb-3">多模式语义搜索引擎</p>
                <ul className="text-amber-700 text-xs space-y-1 list-disc list-inside">
                  <li>InvertedIndex → CoarseRanker → MultiSignalRanker → RetrievalFunnel</li>
                  <li>BM25 + keyword + semantic 三路融合</li>
                  <li>search MCP 工具：mode 参数路由 auto / keyword / semantic / context 四种模式</li>
                </ul>
              </div>
              <div className="bg-rose-50 rounded-lg p-4 border border-rose-200">
                <h4 className="font-semibold text-rose-900 mb-2 flex items-center gap-2">
                  <Shield size={ICON_SIZES.lg} />
                  Guard（代码审查）
                </h4>
                <p className="text-rose-800 text-sm mb-3">知识库驱动的代码审查</p>
                <ul className="text-rose-700 text-xs space-y-1 list-disc list-inside">
                  <li>内建规则 + 自定义规则 + Recipe 关联</li>
                  <li><code className="bg-rose-100 px-1 rounded">// as:audit</code> 触发 / <code className="bg-rose-100 px-1 rounded">asd guard &lt;file&gt;</code></li>
                  <li>MCP：<code className="bg-rose-100 px-1 rounded">guard</code>（code=单文件 / files=批量）、<code className="bg-rose-100 px-1 rounded">bootstrap</code>（operation: scan）</li>
                </ul>
              </div>
            </div>
          </div>

          {/* 闭环流程 */}
          <div className="mt-6 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-5 border border-slate-200">
            <h3 className="text-lg font-semibold text-slate-700 mb-4">知识库闭环</h3>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-blue-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">1</div>
                <p className="text-slate-700 font-medium text-sm">扫描提取</p>
                <p className="text-slate-500 text-xs">AI/Cursor</p>
              </div>
              <div className="text-slate-400 text-2xl">→</div>
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-green-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">2</div>
                <p className="text-slate-700 font-medium text-sm">人工审核</p>
                <p className="text-slate-500 text-xs">Dashboard</p>
              </div>
              <div className="text-slate-400 text-2xl">→</div>
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-purple-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">3</div>
                <p className="text-slate-700 font-medium text-sm">知识沉淀</p>
                <p className="text-slate-500 text-xs">.md 落盘</p>
              </div>
              <div className="text-slate-400 text-2xl">→</div>
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-amber-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">4</div>
                <p className="text-slate-700 font-medium text-sm">智能使用</p>
                <p className="text-slate-500 text-xs">Cursor/Xcode</p>
              </div>
              <div className="text-slate-400 text-2xl">→</div>
              <div className="flex-1 min-w-[100px] text-center">
                <div className="bg-rose-500 text-white rounded-full w-10 h-10 flex items-center justify-center mx-auto mb-2 font-bold text-lg">5</div>
                <p className="text-slate-700 font-medium text-sm">持续优化</p>
                <p className="text-slate-500 text-xs">asd sync</p>
              </div>
            </div>
          </div>
        </Section>

        {/* 核心功能 */}
        <Section id="features" title="核心功能" icon={<Zap size={ICON_SIZES.xl} className="text-blue-600" />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="border border-slate-200 rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-2 mb-3">
                <Code size={ICON_SIZES.lg} className="text-blue-600" />
                <h3 className="font-semibold text-slate-800">知识库构建</h3>
              </div>
              <ul className="text-slate-600 text-sm space-y-2 list-disc list-inside">
                <li><strong>AI 扫描</strong>：<code className="bg-slate-100 px-1 rounded text-xs">asd ais [Target]</code> 批量提取</li>
                <li><strong>Cursor 扫描</strong>：对 Copilot 说 "扫描 Module"</li>
                <li><strong>手动创建</strong>：New Recipe → Use Copied Code</li>
                <li><strong>编辑器内</strong>：复制代码 → <code className="bg-slate-100 px-1 rounded text-xs">// as:create -c</code></li>
              </ul>
            </div>
            <div className="border border-slate-200 rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-2 mb-3">
                <Search size={ICON_SIZES.lg} className="text-blue-600" />
                <h3 className="font-semibold text-slate-800">语义检索</h3>
              </div>
              <ul className="text-slate-600 text-sm space-y-2 list-disc list-inside">
                <li><strong>4 层管线</strong>：InvertedIndex → CoarseRanker → MultiSignalRanker → RetrievalFunnel</li>
                <li><strong>编辑器内</strong>：<code className="bg-slate-100 px-1 rounded text-xs">// as:search keyword</code></li>
                <li><strong>Cursor MCP</strong>：search 统合工具（mode 路由 4 种模式）</li>
                <li><strong>Dashboard</strong>：搜索框支持语义 + 关键词</li>
              </ul>
            </div>
            <div className="border border-slate-200 rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-2 mb-3">
                <Shield size={ICON_SIZES.lg} className="text-blue-600" />
                <h3 className="font-semibold text-slate-800">代码审查（Audit）</h3>
              </div>
              <ul className="text-slate-600 text-sm space-y-2 list-disc list-inside">
                <li><strong>文件审查</strong>：<code className="bg-slate-100 px-1 rounded text-xs">// as:audit</code></li>
                <li><strong>Target 审查</strong>：<code className="bg-slate-100 px-1 rounded text-xs">// as:audit target</code></li>
                <li><strong>Guard 审查</strong>：MCP <code className="bg-slate-100 px-1 rounded text-xs">guard</code>（code / files 参数）</li>
                <li><strong>Dashboard</strong>：Guard 页面可视化审查</li>
              </ul>
            </div>
            <div className="border border-slate-200 rounded-lg p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-center gap-2 mb-3">
                <RefreshCw size={ICON_SIZES.lg} className="text-blue-600" />
                <h3 className="font-semibold text-slate-800">数据同步</h3>
              </div>
              <ul className="text-slate-600 text-sm space-y-2 list-disc list-inside">
                <li><strong>同步</strong>：<code className="bg-slate-100 px-1 rounded text-xs">asd sync</code> .md → DB（增量）</li>
                <li><strong>Hash 校验</strong>：<code className="bg-slate-100 px-1 rounded text-xs">_contentHash</code> 检测手动编辑</li>
                <li><strong>向量索引</strong>：启动时自动构建语义索引</li>
                <li><strong>依赖图</strong>：<code className="bg-slate-100 px-1 rounded text-xs">structure</code>（operation: targets / files）MCP 工具</li>
              </ul>
            </div>
          </div>
        </Section>

        {/* 编辑器指令 */}
        <Section id="editor-directives" title="编辑器指令" icon={<Terminal size={ICON_SIZES.xl} className="text-blue-600" />}>
          <p className="text-slate-600 text-sm mb-4">需先运行 <code className="bg-slate-100 px-1 rounded">asd watch</code> 或 <code className="bg-slate-100 px-1 rounded">asd ui</code>；支持快捷写法 <code className="bg-slate-100 px-1 rounded">asc</code> <code className="bg-slate-100 px-1 rounded">ass</code> <code className="bg-slate-100 px-1 rounded">asa</code></p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
              <h4 className="font-semibold text-slate-800 mb-2"><code className="bg-slate-200 px-2 py-1 rounded">// as:create</code> · <code className="bg-slate-200 px-2 py-1 rounded">asc</code></h4>
              <p className="text-slate-600 text-sm mb-2">创建 Recipe/Snippet</p>
              <ul className="text-slate-600 text-xs space-y-1 list-disc list-inside">
                <li>无选项：打开 Dashboard</li>
                <li><code>-c</code>：从剪贴板静默创建</li>
                <li><code>-f</code>：扫描当前文件</li>
              </ul>
            </div>
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
              <h4 className="font-semibold text-slate-800 mb-2"><code className="bg-slate-200 px-2 py-1 rounded">// as:search</code> · <code className="bg-slate-200 px-2 py-1 rounded">ass</code></h4>
              <p className="text-slate-600 text-sm mb-2">搜索并插入</p>
              <ul className="text-slate-600 text-xs space-y-1 list-disc list-inside">
                <li>从知识库检索 Recipe/Snippet</li>
                <li>选择后插入代码，替换该行</li>
                <li>记录一次人工使用</li>
              </ul>
            </div>
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
              <h4 className="font-semibold text-slate-800 mb-2"><code className="bg-slate-200 px-2 py-1 rounded">// as:audit</code> · <code className="bg-slate-200 px-2 py-1 rounded">asa</code></h4>
              <p className="text-slate-600 text-sm mb-2">代码审查</p>
              <ul className="text-slate-600 text-xs space-y-1 list-disc list-inside">
                <li>无后缀：审查当前文件</li>
                <li><code>target</code>：审查当前 Target</li>
                <li><code>project</code>：审查整个项目</li>
              </ul>
            </div>
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
              <h4 className="font-semibold text-slate-800 mb-2"><code className="bg-slate-200 px-2 py-1 rounded">// as:include</code> · <code className="bg-slate-200 px-2 py-1 rounded">// as:import</code></h4>
              <p className="text-slate-600 text-sm mb-2">自动注入头文件/模块</p>
              <ul className="text-slate-600 text-xs space-y-1 list-disc list-inside">
                <li>Snippet 中包含此标记</li>
                <li>补全后自动注入 import</li>
              </ul>
            </div>
          </div>
        </Section>

        {/* Cursor 集成 */}
        <Section id="cursor-integration" title="Cursor AI 集成" icon={<MessageSquare size={ICON_SIZES.xl} className="text-blue-600" />}>
          {/* Skills */}
          <div className="mb-5">
            <h3 className="font-semibold text-slate-800 mb-3">10 个 Skills</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {[
                { name: 'intent', desc: '意图路由' },
                { name: 'concepts', desc: '概念教学' },
                { name: 'candidates', desc: '候选提交' },
                { name: 'recipes', desc: 'Recipe 检索' },
                { name: 'guard', desc: '代码合规' },
                { name: 'structure', desc: '项目结构' },
                { name: 'analysis', desc: '深度分析' },
                { name: 'coldstart', desc: '冷启动' },
                { name: 'create', desc: '引导创建' },
                { name: 'lifecycle', desc: '生命周期' },
              ].map(s => (
                <div key={s.name} className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-center">
                  <p className="text-xs font-mono text-blue-600">{s.name}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* MCP 工具 */}
          <div className="mb-5">
            <h3 className="font-semibold text-slate-800 mb-3">16 个 MCP 工具（V3 参数化统合）</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full border border-slate-200 rounded-lg text-xs">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="px-3 py-2 border-b text-left">层级</th>
                    <th className="px-3 py-2 border-b text-left">工具</th>
                    <th className="px-3 py-2 border-b text-left">说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-blue-50/30"><td colSpan={3} className="px-3 py-1.5 border-b font-semibold text-blue-700 text-xs">Agent 层（12 个）— 默认对外暴露</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>health</code></td><td className="px-3 py-2 border-b">服务健康检查</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>capabilities</code></td><td className="px-3 py-2 border-b">服务能力清单（Agent 自发现）</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>search</code></td><td className="px-3 py-2 border-b">mode 路由 auto / keyword / semantic / context</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>knowledge</code></td><td className="px-3 py-2 border-b">operation 路由 list / get / insights / confirm_usage</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>structure</code></td><td className="px-3 py-2 border-b">operation 路由 targets / files / metadata</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>graph</code></td><td className="px-3 py-2 border-b">operation 路由 query / impact / path / stats</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>guard</code></td><td className="px-3 py-2 border-b">code=单文件审查 / files=批量审查</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>submit_knowledge</code> / <code>submit_knowledge_batch</code> / <code>save_document</code></td><td className="px-3 py-2 border-b">提交候选 / 批量 / 保存文档</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>skill</code></td><td className="px-3 py-2 border-b">operation 路由 list / load / create / update / delete / suggest</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">agent</td><td className="px-3 py-2 border-b"><code>bootstrap</code></td><td className="px-3 py-2 border-b">operation 路由 knowledge / refine / scan</td></tr>
                  <tr className="bg-amber-50/30"><td colSpan={3} className="px-3 py-1.5 border-b font-semibold text-amber-700 text-xs">Admin 层（4 个）— 需设置 ASD_MCP_TIER=admin</td></tr>
                  <tr><td className="px-3 py-2 border-b font-medium">admin</td><td className="px-3 py-2 border-b"><code>enrich_candidates</code> / <code>validate_candidate</code> / <code>check_duplicate</code></td><td className="px-3 py-2 border-b">AI 润色 / 校验 / 查重</td></tr>
                  <tr><td className="px-3 py-2 font-medium">admin</td><td className="px-3 py-2"><code>knowledge_lifecycle</code></td><td className="px-3 py-2">批量生命周期操作</td></tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500 mt-2">写操作工具（submit_knowledge、guard、bootstrap 等）通过 Gateway 权限 / 宪法 / 审计三重保护。</p>
          </div>

          {/* 使用示例 */}
          <div>
            <h3 className="font-semibold text-slate-800 mb-3">使用示例</h3>
            <div className="space-y-3">
              <div className="bg-blue-50 rounded p-3 border border-blue-200">
                <p className="font-medium text-blue-900 text-sm mb-1">检索知识库</p>
                <p className="text-blue-800 text-xs">对 Cursor 说："查找网络请求错误处理的代码"</p>
              </div>
              <div className="bg-green-50 rounded p-3 border border-green-200">
                <p className="font-medium text-green-900 text-sm mb-1">批量扫描</p>
                <p className="text-green-800 text-xs">对 Cursor 说："扫描 NetworkModule，生成 Recipes 到候选"</p>
              </div>
              <div className="bg-purple-50 rounded p-3 border border-purple-200">
                <p className="font-medium text-purple-900 text-sm mb-1">提交代码</p>
                <p className="text-purple-800 text-xs">对 Cursor 说："把这段代码保存为 Recipe"</p>
              </div>
            </div>
          </div>
        </Section>

        {/* V2 架构亮点 */}
        <Section id="v2-architecture" title="V3 架构" icon={<Layers size={ICON_SIZES.xl} className="text-blue-600" />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="border border-slate-200 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={ICON_SIZES.lg} className="text-indigo-600" />
                <h3 className="font-semibold text-slate-800">Bootstrap 冷启动引擎</h3>
              </div>
              <p className="text-slate-600 text-sm mb-2">3 步完成知识库从 0 → 1：</p>
              <div className="bg-slate-50 rounded p-3 text-xs font-mono text-slate-700 space-y-1">
                <p>① 项目扫描 → 依赖 / 目录 / 入口分析</p>
                <p>② AI 批量提取 → Candidate 候选列表</p>
                <p>③ 审阅 + Promote → Recipe 知识库就绪</p>
              </div>
              <p className="text-slate-500 text-xs mt-2">支持 bootstrap 工具（operation: refine）持续迭代、resume 断点续跑</p>
            </div>
            <div className="border border-slate-200 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <Search size={ICON_SIZES.lg} className="text-indigo-600" />
                <h3 className="font-semibold text-slate-800">4 层检索管线</h3>
              </div>
              <p className="text-slate-600 text-sm mb-2">多信号融合的精准检索：</p>
              <div className="space-y-2 text-xs">
                <div className="flex items-start gap-2">
                  <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-medium shrink-0">L1</span>
                  <span className="text-slate-600">InvertedIndex — 倒排索引快速召回</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded font-medium shrink-0">L2</span>
                  <span className="text-slate-600">CoarseRanker — BM25 + TF-IDF 粗排</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-medium shrink-0">L3</span>
                  <span className="text-slate-600">MultiSignalRanker — 多维信号精排</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded font-medium shrink-0">L4</span>
                  <span className="text-slate-600">RetrievalFunnel — 漏斗截断 + 上下文装配</span>
                </div>
              </div>
            </div>
            <div className="border border-slate-200 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <ArrowRightLeft size={ICON_SIZES.lg} className="text-indigo-600" />
                <h3 className="font-semibold text-slate-800">ChatAgent 对话系统</h3>
              </div>
              <p className="text-slate-600 text-sm mb-2">多 Agent 协作架构，可持续扩展：</p>
              <div className="bg-slate-50 rounded p-3 text-xs text-slate-700 space-y-1.5">
                <p><strong>AnalystAgent</strong>：分析用户意图 → 检索知识库 → 给出建议 → 信心信号分级</p>
                <p><strong>ProducerAgent</strong>：生成代码 → 创建候选 → 执行操作 → 结果聚合</p>
                <p><strong>HandoffProtocol</strong>：两个 Agent 之间的自动切换协议</p>
                <p><strong>轻量记忆</strong>：跨对话偏好/决策/上下文持久化（JSONL，TTL 过期）</p>
                <p><strong>项目感知</strong>：自动注入知识库状态（Recipe 分布、候选积压量、Guard 规则数）</p>
              </div>
            </div>
            <div className="border border-slate-200 rounded-lg p-5">
              <div className="flex items-center gap-2 mb-3">
                <GitBranch size={ICON_SIZES.lg} className="text-indigo-600" />
                <h3 className="font-semibold text-slate-800">五个入口通道</h3>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <span className="font-medium">CLI</span><span className="text-slate-500">asd × 10 命令</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <span className="font-medium">MCP Server</span><span className="text-slate-500">stdio × 16 工具</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <span className="font-medium">HTTP API</span><span className="text-slate-500">Express × 14 路由模块</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <span className="font-medium">Dashboard</span><span className="text-slate-500">React 19 + Vite 6 + Tailwind 4</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <span className="font-medium">Skills</span><span className="text-slate-500">13 个 Cursor/Copilot</span>
                </div>
              </div>
            </div>
          </div>
        </Section>

        {/* 命令速查 */}
        <Section id="cli-reference" title="命令行速查" icon={<Terminal size={ICON_SIZES.xl} className="text-blue-600" />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h3 className="font-semibold text-slate-800 mb-2">初始化与环境</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd setup</code>
                  <span className="text-slate-500 text-xs">初始化项目</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd status</code>
                  <span className="text-slate-500 text-xs">环境自检</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd ui</code>
                  <span className="text-slate-500 text-xs">启动 Dashboard</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd upgrade</code>
                  <span className="text-slate-500 text-xs">升级 IDE 集成</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-slate-800 mb-2">知识库管理</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd sync</code>
                  <span className="text-slate-500 text-xs">.md → DB 增量同步</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd ais [Target]</code>
                  <span className="text-slate-500 text-xs">AI 扫描提取 Candidates</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd ais --force</code>
                  <span className="text-slate-500 text-xs">强制重新扫描全量</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd watch</code>
                  <span className="text-slate-500 text-xs">文件监控 + 指令触发</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-slate-800 mb-2">搜索与审查</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd search &lt;query&gt;</code>
                  <span className="text-slate-500 text-xs">搜索知识库</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd search -m semantic</code>
                  <span className="text-slate-500 text-xs">语义搜索模式</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd guard &lt;file&gt;</code>
                  <span className="text-slate-500 text-xs">Guard 规则检查</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd server</code>
                  <span className="text-slate-500 text-xs">单独启动 API 服务</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-slate-800 mb-2">维护与升级</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd upgrade</code>
                  <span className="text-slate-500 text-xs">升级 MCP / Skills / Rules</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd install:full</code>
                  <span className="text-slate-500 text-xs">全量安装 IDE 集成</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd sync --force</code>
                  <span className="text-slate-500 text-xs">全量重建 DB</span>
                </div>
                <div className="flex justify-between bg-slate-50 px-3 py-2 rounded">
                  <code>asd sync --dry-run</code>
                  <span className="text-slate-500 text-xs">预览同步变更</span>
                </div>
              </div>
            </div>
          </div>
        </Section>
      </div>

      {/* 底部提示 */}
      <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg text-center">
        <p className="text-slate-700 text-sm">
          需要更详细的说明？查看 <a href="https://github.com/GxFn/AutoSnippet" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">GitHub README</a> 或运行 <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs">asd status</code> 检查环境
        </p>
      </div>
    </div>
  );
};

export default HelpView;
