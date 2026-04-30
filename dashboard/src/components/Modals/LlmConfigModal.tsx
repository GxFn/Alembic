import React, { useState, useEffect } from 'react';
import { X, Save, Loader2, Eye, EyeOff, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../api';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import { getErrorMessage } from '../../utils/error';

interface LlmConfigModalProps {
  onClose: () => void;
  onSaved: () => void;
}

const PROVIDERS = [
  { id: 'google', labelKey: 'llmConfig.providers.gemini' as const, defaultModel: 'gemini-3-flash-preview', keyEnv: 'ALEMBIC_GOOGLE_API_KEY' },
  { id: 'openai', labelKey: 'llmConfig.providers.openai' as const, defaultModel: 'gpt-5.4', keyEnv: 'ALEMBIC_OPENAI_API_KEY' },
  { id: 'deepseek', labelKey: 'llmConfig.providers.deepseek' as const, defaultModel: 'deepseek-v4-flash', keyEnv: 'ALEMBIC_DEEPSEEK_API_KEY' },
  { id: 'claude', labelKey: 'llmConfig.providers.claude' as const, defaultModel: 'claude-sonnet-4-20250514', keyEnv: 'ALEMBIC_CLAUDE_API_KEY' },
  { id: 'ollama', labelKey: 'llmConfig.providers.ollama' as const, defaultModel: 'llama3', keyEnv: '' },
];

const EMBED_PROVIDERS = [
  { id: '', labelKey: 'llmConfig.embedProviders.followLlm' as const, defaultModel: '' },
  { id: 'ollama', labelKey: 'llmConfig.providers.ollama' as const, defaultModel: 'qwen3-embedding:0.6b' },
  { id: 'google', labelKey: 'llmConfig.providers.gemini' as const, defaultModel: 'gemini-embedding-001' },
  { id: 'openai', labelKey: 'llmConfig.providers.openai' as const, defaultModel: 'text-embedding-3-small' },
];

const LlmConfigModal: React.FC<LlmConfigModalProps> = ({ onClose, onSaved }) => {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasEnvFile, setHasEnvFile] = useState(false);
  const [provider, setProvider] = useState('google');
  const [model, setModel] = useState('gemini-3-flash-preview');
  const [apiKey, setApiKey] = useState('');
  const [proxy, setProxy] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [existingKeys, setExistingKeys] = useState<Record<string, string>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [embedExpanded, setEmbedExpanded] = useState(false);
  const [embedProvider, setEmbedProvider] = useState('');
  const [embedModel, setEmbedModel] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const data = await api.getLlmEnvConfig();
      setHasEnvFile(data.hasEnvFile);
      const vars = data.vars || {};
      if (vars.ALEMBIC_AI_PROVIDER) setProvider(vars.ALEMBIC_AI_PROVIDER);
      if (vars.ALEMBIC_AI_MODEL) setModel(vars.ALEMBIC_AI_MODEL);
      if (vars.ALEMBIC_AI_PROXY) setProxy(vars.ALEMBIC_AI_PROXY);
      if (vars.ALEMBIC_EMBED_PROVIDER) {
        setEmbedProvider(vars.ALEMBIC_EMBED_PROVIDER);
        setEmbedExpanded(true);
      }
      if (vars.ALEMBIC_EMBED_MODEL) setEmbedModel(vars.ALEMBIC_EMBED_MODEL);
      setExistingKeys(vars);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const selectedProviderInfo = PROVIDERS.find(p => p.id === provider);
  const currentKeyEnv = selectedProviderInfo?.keyEnv || '';
  const hasExistingKey = currentKeyEnv ? !!existingKeys[currentKeyEnv] : true;

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    const info = PROVIDERS.find(p => p.id === newProvider);
    if (info) setModel(info.defaultModel);
    setApiKey('');
  };

  const handleSave = async () => {
    if (!provider) return;
    // 需要 API Key 的 provider 且没有旧 key 也没输入新 key
    if (currentKeyEnv && !hasExistingKey && !apiKey.trim()) {
      alert(t('llmConfig.apiKeyRequired'));
      return;
    }

    setSaving(true);
    setSaveSuccess(false);
    try {
      await api.saveLlmEnvConfig({
        provider,
        model: model || undefined,
        apiKey: apiKey.trim() || undefined,
        proxy: proxy.trim() || undefined,
        embedProvider: embedProvider || undefined,
        embedModel: embedModel || undefined,
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

  /** 遮盖已有的 API Key，仅显示前后几位 */
  const maskKey = (key: string) => {
    if (!key || key.length < 10) return key ? '••••••' : '';
    return `${key.slice(0, 6)}••••${key.slice(-4)}`;
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden bg-[var(--bg-surface)]"
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
        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-blue-500" />
            </div>
          ) : (
            <>
              {!hasEnvFile && (
                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>{t('llmConfig.envWarning')}</span>
                </div>
              )}

              {/* Provider */}
              <div>
                <label className="block text-sm font-medium mb-2 text-[var(--fg-primary)]">{t('llmConfig.provider')}</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {PROVIDERS.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handleProviderChange(p.id)}
                      className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                        provider === p.id
                          ? 'bg-[var(--accent-subtle)] border-[var(--accent-emphasis)] text-[var(--accent)] ring-1 ring-[var(--accent-emphasis)]/30'
                          : 'bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--fg-secondary)] hover:border-[var(--border-emphasis)] hover:bg-[var(--bg-subtle)]'
                      }`}
                    >
                      {t(p.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Model */}
              <div>
                <label className="block text-sm font-medium mb-1.5 text-[var(--fg-primary)]">{t('llmConfig.model')}</label>
                <input
                  type="text"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder={selectedProviderInfo?.defaultModel || ''}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]/20 focus:border-[var(--accent-emphasis)] border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-primary)]"
                />
              </div>

              {/* API Key */}
              {currentKeyEnv && (
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-[var(--fg-primary)]">
                    {t('llmConfig.apiKey')}
                    {hasExistingKey && (
                      <span className="ml-2 text-xs text-green-600 font-normal">
                        ({t('llmConfig.configured')} {maskKey(existingKeys[currentKeyEnv])})
                      </span>
                    )}
                  </label>
                  <div className="relative">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                      placeholder={hasExistingKey ? t('llmConfig.apiKeyPlaceholderSet') : t('llmConfig.apiKeyPlaceholderEmpty')}
                      className="w-full px-3 py-2 pr-10 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)]/20 focus:border-[var(--accent-emphasis)] border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-primary)]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(v => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--fg-muted)] hover:text-[var(--fg-secondary)]"
                    >
                      {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Proxy */}
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

              {/* Embedding Provider */}
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
                    {/* Embed Provider */}
                    <div>
                      <label className="block text-xs font-medium mb-1.5 text-[var(--fg-primary)]">{t('llmConfig.provider')}</label>
                      <div className="flex gap-1.5 flex-wrap">
                        {EMBED_PROVIDERS.map(ep => (
                          <button
                            key={ep.id}
                            type="button"
                            onClick={() => {
                              setEmbedProvider(ep.id);
                              if (ep.defaultModel) { setEmbedModel(ep.defaultModel); }
                              else { setEmbedModel(''); }
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
                    {/* Embed Model */}
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
            </>
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
