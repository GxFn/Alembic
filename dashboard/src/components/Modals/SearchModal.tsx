import React, { useState, useEffect, useRef } from 'react';
import { X, Search, CheckCircle } from 'lucide-react';
import api from '../../api';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';
import { useI18n } from '../../i18n';

interface SearchResult {
  name: string;
  path: string;
  content: string;
  qualityScore?: number;
  recommendReason?: string;
}

interface SearchModalProps {
  searchQ: string;
  insertPath: string;
  onClose: () => void;
}

function extractCodeFromContent(content: any): string {
  if (!content) return '';
  // content 已被 search() 解析为对象
  if (typeof content === 'object') {
    const text = content.code || content.pattern || content.markdown || content.snippet || content.body || '';
    if (text) return text;
  }
  // 字符串回退: 提取围栏代码块
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  const stripped = str.replace(/^---[\s\S]*?---\s*\n?/, '').trim();
  const match = stripped.match(/```[\w]*\n([\s\S]*?)```/);
  if (match && match[1]) return match[1].trim();
  return stripped.slice(0, 8000);
}

const SearchModal: React.FC<SearchModalProps> = ({ searchQ, insertPath, onClose }) => {
  const { t } = useI18n();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [inserting, setInserting] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    abortControllerRef.current = new AbortController();
    
    api.search(searchQ || '', { mode: 'bm25', type: 'recipe', signal: abortControllerRef.current.signal })
      .then(data => {
        if (isMountedRef.current) {
          setResults((data.items || []).map((r: any) => ({
            name: (r.title || r.name || '') + '.md',
            path: '',
            content: r.content,
            qualityScore: (r.quality || {}).overall || r.qualityScore || 0,
            recommendReason: '',
          })));
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError' && isMountedRef.current) {
          setResults([]);
        }
      })
      .finally(() => {
        if (isMountedRef.current) {
          setLoading(false);
        }
      });

    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [searchQ]);

  const handleInsert = async (result: SearchResult) => {
    setInserting(result.name);
    try {
      const content = extractCodeFromContent(result.content);
      await api.insertAtSearchMark({ path: insertPath, content });
      if (isMountedRef.current) {
        alert(t('searchModal.insertSuccess') + ' ' + insertPath);
        onClose();
      }
    } catch (err) {
      if (isMountedRef.current) {
        alert(t('searchModal.insertFailed'));
      }
    } finally {
      if (isMountedRef.current) {
        setInserting(null);
      }
    }
  };

  return (
  <PageOverlay className="z-40 flex items-center justify-center p-4">
    <PageOverlay.Backdrop className="bg-slate-900/50 backdrop-blur-sm" />
    <div className="relative bg-white w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
    <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
      <h2 className="text-xl font-bold flex items-center gap-2 text-slate-800">
      <Search size={ICON_SIZES.xl} className="text-blue-600" /> {t('searchModal.title')}
      </h2>
      <button onClick={onClose} className="p-2 hover:bg-white rounded-full transition-colors"><X size={ICON_SIZES.lg} /></button>
    </div>
    <div className="p-4 text-sm text-slate-500 border-b border-slate-100">
      {t('searchModal.keyword')} {searchQ || t('searchModal.keywordAll')} · {t('searchModal.insertTo')} {insertPath}
    </div>
    <div className="flex-1 overflow-y-auto p-4">
      {loading ? (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
      ) : results.length === 0 ? (
      <div className="text-slate-500 text-center py-8">{t('searchModal.noResults')}</div>
      ) : (
      <ul className="space-y-2">
        {results.map((r) => (
        <li key={r.name}>
          <button
          type="button"
          onClick={() => handleInsert(r)}
          disabled={inserting !== null}
          className="w-full flex items-center justify-between gap-3 p-4 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-all text-left disabled:opacity-50"
          >
          <div className="flex-1 flex flex-col gap-1">
            <span className="font-medium text-slate-800 truncate">{r.name}</span>
            {(r.qualityScore !== undefined || r.recommendReason) && (
            <div className="flex items-center gap-2 flex-wrap">
              {r.qualityScore !== undefined && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 rounded text-xs text-blue-700 font-medium">
                🤖 {t('searchModal.quality')} {(r.qualityScore * 100).toFixed(0)}%
              </span>
              )}
              {r.recommendReason && (
              <span className="text-xs text-slate-600 italic truncate max-w-xs">
                {r.recommendReason}
              </span>
              )}
            </div>
            )}
          </div>
          {inserting === r.name ? (
            <span className="text-blue-600 text-sm flex items-center gap-1"><span className="animate-spin">⏳</span> {t('searchModal.inserting')}</span>
          ) : (
            <span className="text-blue-600 text-sm flex items-center gap-1"><CheckCircle size={ICON_SIZES.md} /> {t('searchModal.insertBtn')}</span>
          )}
          </button>
        </li>
        ))}
      </ul>
      )}
    </div>
    </div>
  </PageOverlay>
  );
};

export default SearchModal;
