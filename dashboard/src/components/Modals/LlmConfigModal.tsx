import React, { useState, useEffect, useCallback } from 'react';
import {
  X, Save, Loader2, Eye, EyeOff, CheckCircle2, AlertTriangle,
  ChevronDown, ChevronRight, Zap, Wifi, WifiOff, Brain, Wrench,
  ImageIcon, MessageSquare,
} from 'lucide-react';
import api, { type AiProviderInfo, type AiProviderModelInfo, type AiProbeResult } from '../../api';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import { getErrorMessage } from '../../utils/error';

interface LlmConfigModalProps {
  onClose: () => void;
  onSaved: () => void;
}

const PROVIDER_LABEL_KEYS: Record<string, string> = {
  google: 'llmConfig.providers.gemini',
  openai: 'llmConfig.providers.openai',
  deepseek: 'llmConfig.providers.deepseek',
  claude: 'llmConfig.providers.claude',
  ollama: 'llmConfig.providers.ollama',
  mock: 'llmConfig.providers.mock',
};

const PROVIDER_KEY_ENVS: Record<string, string> = {
  google: 'ALEMBIC_GOOGLE_API_KEY',
  openai: 'ALEMBIC_OPENAI_API_KEY',
  deepseek: 'ALEMBIC_DEEPSEEK_API_KEY',
  claude: 'ALEMBIC_CLAUDE_API_KEY',
};

const EMBED_PROVIDERS = [
  { id: '', labelKey: 'llmConfig.embedProviders.followLlm' as const, defaultModel: '' },
  { id: 'ollama', labelKey: 'llmConfig.providers.ollama' as const, defaultModel: 'qwen3-embedding:0.6b' },
  { id: 'google', labelKey: 'llmConfig.providers.gemini' as const, defaultModel: 'gemini-embedding-001' },
  { id: 'openai', labelKey: 'llmConfig.providers.openai' as const, defaultModel: 'text-embedding-3-small' },
];

type ProbeStatus = 'idle' | 'probing' | 'connected' | 'error';

interface ProviderState {
  apiKey: string;
  probeStatus: ProbeStatus;
  probeResult?: AiProbeResult;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

const LlmConfigModal: React.FC<LlmConfigModalProps> = ({ onClose, onSaved }) => {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasEnvFile, setHasEnvFile] = useState(false);
  const [provider, setProvider] = useState('google');
  const [model, setModel] = useState('');
  const [proxy, setProxy] = useState('');
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [existingKeys, setExistingKeys] = useState<Record<string, string>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [embedExpanded, setEmbedExpanded] = useState(false);
  const [embedProvider, setEmbedProvider] = useState('');
  const [embedModel, setEmbedModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);

  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
  const [activeTab, setActiveTab] = useState<string>('');

  useEffect(() => { loadConfig(); }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const [data, providerList] = await Promise.all([
        api.getLlmEnvConfig(),
        api.getAiProviders().catch(() => [] as AiProviderInfo[]),
      ]);
      const filtered = providerList.filter(p => p.id !== 'mock');
      if (filtered.length > 0) setProviders(filtered);

      setHasEnvFile(data.hasEnvFile);
      const vars = data.vars || {};
      const currentProvider = vars.ALEMBIC_AI_PROVIDER || 'google';
      setProvider(currentProvider);
      if (vars.ALEMBIC_AI_MODEL) setModel(vars.ALEMBIC_AI_MODEL);
      if (vars.ALEMBIC_AI_PROXY) setProxy(vars.ALEMBIC_AI_PROXY);
      if (vars.ALEMBIC_AI_REASONING_EFFORT) setReasoningEffort(vars.ALEMBIC_AI_REASONING_EFFORT);
      if (vars.ALEMBIC_EMBED_PROVIDER) {
        setEmbedProvider(vars.ALEMBIC_EMBED_PROVIDER);
        setEmbedExpanded(true);
      }
      if (vars.ALEMBIC_EMBED_MODEL) setEmbedModel(vars.ALEMBIC_EMBED_MODEL);
      setExistingKeys(vars);
      setActiveTab(currentProvider);

      const states: Record<string, ProviderState> = {};
      for (const p of filtered) {
        states[p.id] = { apiKey: '', probeStatus: 'idle' };
      }
      setProviderStates(states);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const selectedProviderInfo = providers.find(p => p.id === provider);
  const tabProviderInfo = providers.find(p => p.id === activeTab);

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    const info = providers.find(p => p.id === newProvider);
    if (info) setModel(info.defaultModel);
    setActiveTab(newProvider);
  };

  const handleKeyChange = (pid: string, key: string) => {
    setProviderStates(prev => ({
      ...prev,
      [pid]: { ...prev[pid], apiKey: key, probeStatus: 'idle' },
    }));
  };

  const handleProbe = useCallback(async (pid: string) => {
    setProviderStates(prev => ({
      ...prev,
      [pid]: { ...prev[pid], probeStatus: 'probing' },
    }));
    try {
      const key = providerStates[pid]?.apiKey || undefined;
      const result = await api.probeProvider(pid, key);
      setProviderStates(prev => ({
        ...prev,
        [pid]: { ...prev[pid], probeStatus: result.status === 'connected' ? 'connected' : 'error', probeResult: result },
      }));
    } catch {
      setProviderStates(prev => ({
        ...prev,
        [pid]: { ...prev[pid], probeStatus: 'error' },
      }));
    }
  }, [providerStates]);

  const handleSave = async () => {
    if (!provider) return;
    const currentKeyEnv = PROVIDER_KEY_ENVS[provider] || '';
    const hasExistingKey = currentKeyEnv ? !!existingKeys[currentKeyEnv] : true;
    const activeKey = providerStates[provider]?.apiKey?.trim() || '';
    if (currentKeyEnv && !hasExistingKey && !activeKey) {
      alert(t('llmConfig.apiKeyRequired'));
      return;
    }

    setSaving(true);
    setSaveSuccess(false);
    try {
      const providerKeys: Record<string, string> = {};
      for (const [pid, state] of Object.entries(providerStates)) {
        if (state.apiKey.trim()) {
          providerKeys[pid] = state.apiKey.trim();
        }
      }
      await api.saveLlmEnvConfig({
        provider,
        model: model || undefined,
        proxy: proxy.trim() || undefined,
        reasoningEffort: reasoningEffort || undefined,
        embedProvider: embedProvider || undefined,
        embedModel: embedModel || undefined,
        providerKeys: Object.keys(providerKeys).length > 0 ? providerKeys : undefined,
      });
      setSaveSuccess(true);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 800);
    } catch (err: unknown) {
      alert(getErrorMessage(err, t('llmConfig.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const maskKey = (key: string) => {
    if (!key || key.length < 10) return key ? '••••••' : '';
    return `${key.slice(0, 6)}••••${key.slice(-4)}`;
  };

  const renderProviderTab = (p: AiProviderInfo) => {
    const isActive = p.id === provider;
    const isSelected = p.id === activeTab;
    const keyEnv = PROVIDER_KEY_ENVS[p.id] || '';
    const hasKey = keyEnv ? !!existingKeys[keyEnv] : true;
    const probeStatus = providerStates[p.id]?.probeStatus || 'idle';

    return (
      <button
        key={p.id}
        onClick={() => setActiveTab(p.id)}
        className={`flex items-center gap-2 px-3 py-2.5 text-left text-sm rounded-lg transition-all w-full ${
          isSelected
            ? 'bg-[var(--accent-subtle)] border border-[var(--accent-emphasis)] text-[var(--accent)]'
            : 'border border-transparent text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)]'
        }`}
      >
        <span className="flex-1 font-medium truncate">
          {PROVIDER_LABEL_KEYS[p.id] ? t(PROVIDER_LABEL_KEYS[p.id] as Parameters<typeof t>[0]) : p.label}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {isActive && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" title={t('llmConfig.active')} />
          )}
          {probeStatus === 'connected' && <Wifi size={12} className="text-green-500" />}
          {probeStatus === 'error' && <WifiOff size={12} className="text-red-400" />}
          {!hasKey && keyEnv && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-600 font-medium">
              {t('llmConfig.noKey')}
            </span>
          )}
          {hasKey && keyEnv && probeStatus === 'idle' && (
            <CheckCircle2 size={12} className="text-green-500/60" />
          )}
        </span>
      </button>
    );
  };

  const renderModelOption = (m: AiProviderModelInfo) => (
    <option key={m.id} value={m.id} disabled={m.deprecated}>
      {m.name} — {formatContextWindow(m.contextWindow)}{m.deprecated ? ' (deprecated)' : ''}
    </option>
  );

  const renderModelCapabilities = (m?: AiProviderModelInfo) => {
    if (!m) return null;
    const caps = m.capabilities;
    const reasoning = m.reasoning;
    return (
      <div className="flex flex-wrap gap-1.5 mt-2">
        {reasoning?.supported && (
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">
            <Brain size={10} /> {reasoning.mode || 'reasoning'}
          </span>
        )}
        {caps?.toolCalling && (
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
            <Wrench size={10} /> Tools
          </span>
        )}
        {caps?.vision && (
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
            <ImageIcon size={10} /> Vision
          </span>
        )}
        {caps?.jsonMode && (
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
            <MessageSquare size={10} /> JSON
          </span>
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium">
          ctx {formatContextWindow(m.contextWindow)}
        </span>
        {m.maxOutputTokens && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium">
            out {formatContextWindow(m.maxOutputTokens)}
          </span>
        )}
      </div>
    );
  };

  const renderProviderPanel = (p: AiProviderInfo) => {
    const keyEnv = PROVIDER_KEY_ENVS[p.id] || '';
    const hasExistingKey = keyEnv ? !!existingKeys[keyEnv] : true;
    const state = providerStates[p.id] || { apiKey: '', probeStatus: 'idle' };
    const isActiveProvider = p.id === provider;
    const selectedModel = p.models?.find(m => m.id === model);

    return (
      <div className="space-y-4">
        {/* Active Provider Toggle */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--fg-primary)]">
            {PROVIDER_LABEL_KEYS[p.id] ? t(PROVIDER_LABEL_KEYS[p.id] as Parameters<typeof t>[0]) : p.label}
          </span>
          {!isActiveProvider ? (
            <button
              type="button"
              onClick={() => handleProviderChange(p.id)}
              className="text-xs px-3 py-1 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 transition-opacity font-medium"
            >
              {t('llmConfig.setAsActive')}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-green-100 text-green-700 font-medium">
              <Zap size={10} /> {t('llmConfig.active')}
            </span>
          )}
        </div>

        {/* API Key */}
        {keyEnv && (
          <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--fg-primary)]">
              API Key
              {hasExistingKey && (
                <span className="ml-2 text-xs text-green-600 font-normal">
                  ({t('llmConfig.configured')} {maskKey(existingKeys[keyEnv])})
                </span>
              )}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey[p.id] ? 'text' : 'password'}
                  value={state.apiKey}
                  onChange={e => handleKeyChange(p.id, e.target.value)}
                  placeholder={hasExistingKey ? t('llmConfig.apiKeyPlaceholderSet') : t('llmConfig.apiKeyPlaceholderEmpty')}
                  className="w-full px-3 py-2 pr-10 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]/20 focus:border-[var(--accent-emphasis)] border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-primary)]"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(v => ({ ...v, [p.id]: !v[p.id] }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]"
                >
                  {showKey[p.id] ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => handleProbe(p.id)}
                disabled={state.probeStatus === 'probing'}
                className={`shrink-0 px-3 py-2 rounded-lg text-xs font-medium border transition-all flex items-center gap-1.5 ${
                  state.probeStatus === 'connected'
                    ? 'border-green-300 bg-green-50 text-green-700'
                    : state.probeStatus === 'error'
                      ? 'border-red-300 bg-red-50 text-red-700'
                      : 'border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)]'
                }`}
              >
                {state.probeStatus === 'probing' ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : state.probeStatus === 'connected' ? (
                  <Wifi size={12} />
                ) : state.probeStatus === 'error' ? (
                  <WifiOff size={12} />
                ) : (
                  <Zap size={12} />
                )}
                {t('llmConfig.testConnection')}
              </button>
            </div>
            {state.probeStatus === 'connected' && state.probeResult && (
              <p className="mt-1.5 text-xs text-green-600">
                ✓ {t('llmConfig.connected')} ({state.probeResult.latencyMs}ms)
              </p>
            )}
            {state.probeStatus === 'error' && state.probeResult?.error && (
              <p className="mt-1.5 text-xs text-red-500">
                ✗ {state.probeResult.error.slice(0, 100)}
              </p>
            )}
          </div>
        )}

        {/* Model Selection */}
        {isActiveProvider && (
          <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--fg-primary)]">{t('llmConfig.model')}</label>
            {p.models && p.models.length > 0 ? (
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]/20 focus:border-[var(--accent-emphasis)] border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-primary)] appearance-none"
                style={{ backgroundImage: 'url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23666\' stroke-width=\'2\'%3e%3cpolyline points=\'6 9 12 15 18 9\'%3e%3c/polyline%3e%3c/svg%3e")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.5rem center', backgroundSize: '1.2em' }}
              >
                {p.models.map(renderModelOption)}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder={p.defaultModel || ''}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]/20 focus:border-[var(--accent-emphasis)] border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-primary)]"
              />
            )}
            {renderModelCapabilities(selectedModel)}
          </div>
        )}

        {/* Thinking Depth / Reasoning Effort */}
        {isActiveProvider && selectedModel?.reasoning?.supported && selectedModel.reasoning.effortLevels && selectedModel.reasoning.effortLevels.length > 0 && (
          <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--fg-primary)]">
              <span className="inline-flex items-center gap-1.5">
                <Brain size={14} className="text-purple-500" />
                {t('llmConfig.thinkingDepth')}
              </span>
            </label>
            <p className="text-xs text-[var(--fg-muted)] mb-2">{t('llmConfig.thinkingDepthHint')}</p>
            <div className="flex gap-1.5 flex-wrap">
              {selectedModel.reasoning.effortLevels.map(level => {
                const isSelected = (reasoningEffort || selectedModel.reasoning?.defaultEffort || '') === level;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setReasoningEffort(level)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                      isSelected
                        ? 'bg-purple-50 border-purple-300 text-purple-700 ring-1 ring-purple-300/30'
                        : 'bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--fg-secondary)] hover:border-purple-200 hover:bg-purple-50/50'
                    }`}
                  >
                    {t(`llmConfig.effort.${level}` as Parameters<typeof t>[0])}
                  </button>
                );
              })}
            </div>
            {selectedModel.reasoning.mode && (
              <p className="mt-1.5 text-[10px] text-[var(--fg-muted)]">
                {t('llmConfig.thinkingMode')}: {selectedModel.reasoning.mode}
              </p>
            )}
          </div>
        )}

        {/* Model Gallery (non-active providers) */}
        {!isActiveProvider && p.models && p.models.length > 0 && (
          <div>
            <label className="block text-xs font-medium mb-1.5 text-[var(--fg-muted)]">{t('llmConfig.availableModels')}</label>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {p.models.filter(m => !m.deprecated).map(m => (
                <div key={m.id} className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-[var(--bg-subtle)] text-xs">
                  <span className="text-[var(--fg-secondary)] font-medium">{m.name}</span>
                  <span className="text-[var(--fg-muted)]">{formatContextWindow(m.contextWindow)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="rounded-2xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden bg-[var(--bg-surface)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-lg font-semibold text-[var(--fg-primary)]">{t('llmConfig.title')}</h2>
          <button onClick={onClose} className="p-1 rounded-lg transition-all duration-150 hover:bg-[var(--bg-subtle)] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]">
            <X size={ICON_SIZES.md} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-blue-500" />
            </div>
          ) : (
            <div className="flex h-[480px]">
              {/* Left: Provider Tabs */}
              <div className="w-48 shrink-0 border-r border-[var(--border-default)] p-3 space-y-1 overflow-y-auto bg-[var(--bg-subtle)]/50">
                {providers.map(renderProviderTab)}
              </div>

              {/* Right: Provider Detail Panel */}
              <div className="flex-1 p-5 overflow-y-auto space-y-5">
                {!hasEnvFile && (
                  <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <span>{t('llmConfig.envWarning')}</span>
                  </div>
                )}

                {tabProviderInfo && renderProviderPanel(tabProviderInfo)}

                {/* Proxy (only on active provider tab) */}
                {activeTab === provider && (
                  <div>
                    <label className="block text-sm font-medium mb-1.5 text-[var(--fg-primary)]">
                      {t('llmConfig.proxy')} <span className="text-xs font-normal text-[var(--fg-muted)]">{t('llmConfig.optional')}</span>
                    </label>
                    <input
                      type="text"
                      value={proxy}
                      onChange={e => setProxy(e.target.value)}
                      placeholder="http://127.0.0.1:7890"
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]/20 focus:border-[var(--accent-emphasis)] border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-primary)]"
                    />
                  </div>
                )}

                {/* Embedding (only on active provider tab) */}
                {activeTab === provider && (
                  <div className="border border-[var(--border-default)] rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setEmbedExpanded(v => !v)}
                      className="flex items-center justify-between w-full px-4 py-2.5 text-sm font-medium text-[var(--fg-primary)] hover:bg-[var(--bg-subtle)] transition-colors"
                    >
                      <span className="flex items-center gap-2">
                        {t('llmConfig.embedTitle')}
                        <span className="text-xs font-normal text-[var(--fg-muted)]">{t('llmConfig.optional')}</span>
                        {!embedExpanded && embedProvider && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 font-medium">
                            {embedProvider}{embedModel ? ` / ${embedModel}` : ''}
                          </span>
                        )}
                      </span>
                      {embedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    {embedExpanded && (
                      <div className="px-4 pb-3 pt-2 space-y-3 border-t border-[var(--border-default)]">
                        <p className="text-xs text-[var(--fg-muted)]">{t('llmConfig.embedHint')}</p>
                        <div>
                          <label className="block text-xs font-medium mb-1.5 text-[var(--fg-primary)]">{t('llmConfig.provider')}</label>
                          <div className="flex gap-1.5 flex-wrap">
                            {EMBED_PROVIDERS.map(ep => (
                              <button
                                key={ep.id}
                                type="button"
                                onClick={() => {
                                  setEmbedProvider(ep.id);
                                  setEmbedModel(ep.defaultModel || '');
                                }}
                                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all whitespace-nowrap ${
                                  embedProvider === ep.id
                                    ? 'bg-[var(--accent-subtle)] border-[var(--accent-emphasis)] text-[var(--accent)] ring-1 ring-[var(--accent-emphasis)]/30'
                                    : 'bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--fg-secondary)] hover:border-[var(--border-emphasis)] hover:bg-[var(--bg-subtle)]'
                                }`}
                              >
                                {t(ep.labelKey)}
                              </button>
                            ))}
                          </div>
                        </div>
                        {embedProvider && (
                          <div>
                            <label className="block text-xs font-medium mb-1.5 text-[var(--fg-primary)]">{t('llmConfig.embedModel')}</label>
                            <input
                              type="text"
                              value={embedModel}
                              onChange={e => setEmbedModel(e.target.value)}
                              placeholder={EMBED_PROVIDERS.find(ep => ep.id === embedProvider)?.defaultModel || ''}
                              className="w-full px-3 py-1.5 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]/20 focus:border-[var(--accent-emphasis)] border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-primary)]"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border-default)] bg-[var(--bg-subtle)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium transition-colors text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
          >
            {t('llmConfig.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading || saveSuccess}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              saveSuccess
                ? 'bg-green-500 text-white'
                : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
            } disabled:opacity-60`}
          >
            {saving ? (
              <Loader2 size={16} className="animate-spin" />
            ) : saveSuccess ? (
              <CheckCircle2 size={16} />
            ) : (
              <Save size={16} />
            )}
            {saveSuccess ? t('llmConfig.saved') : t('llmConfig.saveToEnv')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LlmConfigModal;
