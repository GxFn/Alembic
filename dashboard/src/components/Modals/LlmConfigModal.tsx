import React, { useState, useEffect } from 'react';
import { X, Save, Loader2, Eye, EyeOff, CheckCircle2, AlertTriangle } from 'lucide-react';
import api from '../../api';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';

interface LlmConfigModalProps {
  onClose: () => void;
  onSaved: () => void;
}

const PROVIDERS = [
  { id: 'google', labelKey: 'llmConfig.providers.gemini' as const, defaultModel: 'gemini-2.0-flash', keyEnv: 'ASD_GOOGLE_API_KEY' },
  { id: 'openai', labelKey: 'llmConfig.providers.openai' as const, defaultModel: 'gpt-4o', keyEnv: 'ASD_OPENAI_API_KEY' },
  { id: 'deepseek', labelKey: 'llmConfig.providers.deepseek' as const, defaultModel: 'deepseek-chat', keyEnv: 'ASD_DEEPSEEK_API_KEY' },
  { id: 'claude', labelKey: 'llmConfig.providers.claude' as const, defaultModel: 'claude-3-5-sonnet-20240620', keyEnv: 'ASD_CLAUDE_API_KEY' },
  { id: 'ollama', labelKey: 'llmConfig.providers.ollama' as const, defaultModel: 'llama3', keyEnv: '' },
];

const LlmConfigModal: React.FC<LlmConfigModalProps> = ({ onClose, onSaved }) => {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasEnvFile, setHasEnvFile] = useState(false);
  const [provider, setProvider] = useState('google');
  const [model, setModel] = useState('gemini-2.0-flash');
  const [apiKey, setApiKey] = useState('');
  const [proxy, setProxy] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [existingKeys, setExistingKeys] = useState<Record<string, string>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const data = await api.getLlmEnvConfig();
      setHasEnvFile(data.hasEnvFile);
      const vars = data.vars || {};
      if (vars.ASD_AI_PROVIDER) setProvider(vars.ASD_AI_PROVIDER);
      if (vars.ASD_AI_MODEL) setModel(vars.ASD_AI_MODEL);
      if (vars.ASD_AI_PROXY) setProxy(vars.ASD_AI_PROXY);
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
      });
      setSaveSuccess(true);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 800);
    } catch (err: any) {
      alert(err?.message || t('llmConfig.saveFailed'));
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
        className={`rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden ${isDark ? 'bg-[#1e1e1e]' : 'bg-white'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${isDark ? 'border-[#3e3e42]' : 'border-slate-100'}`}>
          <h2 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-slate-800'}`}>{t('llmConfig.title')}</h2>
          <button onClick={onClose} className={`p-1 rounded-lg transition-all duration-150 ${isDark ? 'hover:bg-[#3e3e42] text-slate-400 hover:text-slate-200' : 'hover:bg-slate-100 text-slate-400'}`}>
            <X size={ICON_SIZES.md} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
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
                <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{t('llmConfig.provider')}</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {PROVIDERS.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handleProviderChange(p.id)}
                      className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                        provider === p.id
                          ? isDark
                            ? 'bg-blue-500/20 border-blue-500/40 text-blue-300 ring-1 ring-blue-500/30'
                            : 'bg-blue-50 border-blue-300 text-blue-700 ring-1 ring-blue-200'
                          : isDark
                            ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-300 hover:border-slate-500 hover:bg-[#333842]'
                            : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {t(p.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Model */}
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{t('llmConfig.model')}</label>
                <input
                  type="text"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder={selectedProviderInfo?.defaultModel || ''}
                  className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-300 ${isDark ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-200 placeholder-slate-500' : 'border-slate-200'}`}
                />
              </div>

              {/* API Key */}
              {currentKeyEnv && (
                <div>
                  <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
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
                      className={`w-full px-3 py-2 pr-10 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-300 ${isDark ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-200 placeholder-slate-500' : 'border-slate-200'}`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(v => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                    >
                      {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Proxy */}
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {t('llmConfig.proxy')} <span className={`text-xs font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('llmConfig.optional')}</span>
                </label>
                <input
                  type="text"
                  value={proxy}
                  onChange={e => setProxy(e.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-300 ${isDark ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-200 placeholder-slate-500' : 'border-slate-200'}`}
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${isDark ? 'border-[#3e3e42] bg-[#252526]' : 'border-slate-100 bg-slate-50/50'}`}>
          <button
            onClick={onClose}
            className={`px-4 py-2 text-sm font-medium transition-colors ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-600 hover:text-slate-800'}`}
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
