import React from 'react';
import { Plus, X, FileSearch, Clipboard, Zap, Cpu } from 'lucide-react';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';
import { useI18n } from '../../i18n';

interface CreateModalProps {
  setShowCreateModal: (show: boolean) => void;
  createPath: string;
  setCreatePath: (path: string) => void;
  handleCreateFromPath: () => void;
  handleCreateFromClipboard: () => void;
  isExtracting: boolean;
}

const CreateModal: React.FC<CreateModalProps> = ({ 
  setShowCreateModal, 
  createPath, 
  setCreatePath, 
  handleCreateFromPath, 
  handleCreateFromClipboard, 
  isExtracting 
}) => {
  const { t } = useI18n();
  return (
  <PageOverlay className="z-40 flex items-center justify-center p-4">
    <PageOverlay.Backdrop className="bg-black/20 dark:bg-black/40 backdrop-blur-sm" />
    <div className="relative w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden bg-[var(--bg-surface)]">
     <div className="p-6 border-b flex justify-between items-center bg-[var(--bg-subtle)] border-[var(--border-default)]">
      <h2 className="text-xl font-bold flex items-center gap-2 text-[var(--fg-primary)]"><Plus size={ICON_SIZES.xl} className="text-blue-600" /> {t('createModal.title')}</h2>
      <button onClick={() => setShowCreateModal(false)} className="p-2 rounded-full transition-all duration-150 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg-primary)]"><X size={ICON_SIZES.lg} /></button>
     </div>
     <div className="p-8 space-y-6">
      <div className="space-y-3">
         <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[var(--fg-muted)]"><FileSearch size={ICON_SIZES.sm} /> {t('createModal.importFromPath')}</label>
         <div className="flex gap-2">
          <input className="flex-1 p-3 rounded-xl text-sm outline-none focus:ring-2 focus:ring-[var(--accent-emphasis)] border bg-[var(--bg-subtle)] border-[var(--border-default)] text-[var(--fg-primary)]" placeholder={t('createModal.pathPlaceholder')} value={createPath} onChange={e => setCreatePath(e.target.value)} />
          <button onClick={handleCreateFromPath} disabled={!createPath || isExtracting} className="px-5 py-2 rounded-xl text-sm font-bold whitespace-nowrap disabled:opacity-40 transition-all duration-150 bg-[var(--accent)] text-white hover:opacity-90 shadow-sm">
            <FileSearch size={14} className="inline -mt-0.5 mr-1" />{t('createModal.scanFile')}
          </button>
         </div>
      </div>
      <div className="relative"><div className="absolute inset-0 flex items-center"><div className="w-full border-t border-[var(--border-default)]"></div></div><div className="relative flex justify-center text-xs uppercase"><span className="px-2 font-bold bg-[var(--bg-surface)] text-[var(--fg-muted)]">{t('createModal.or')}</span></div></div>
      <div className="space-y-3">
         <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[var(--fg-muted)]"><Clipboard size={ICON_SIZES.sm} /> {t('createModal.importFromClipboard')}</label>
         <button onClick={() => handleCreateFromClipboard()} disabled={isExtracting} className="w-full flex items-center justify-center gap-3 p-4 rounded-xl font-bold transition-all duration-150 border bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent-emphasis)]/20 hover:bg-[var(--accent-emphasis)]/10">
          <Zap size={ICON_SIZES.lg} /> {t('createModal.useClipboard')}
         </button>
      </div>
     </div>
     {isExtracting && (
       <div className="bg-blue-600 text-white p-4 flex items-center justify-center gap-3 animate-pulse">
       <Cpu size={ICON_SIZES.lg} className="animate-spin" />
       <span className="font-bold text-sm">{t('createModal.aiThinking')}</span>
       </div>
     )}
    </div>
  </PageOverlay>
  );
};

export default CreateModal;
