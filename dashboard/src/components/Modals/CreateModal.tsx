import React from 'react';
import { Plus, X, FileSearch, Clipboard, Zap, Cpu } from 'lucide-react';
import { ICON_SIZES } from '../../constants/icons';
import PageOverlay from '../Shared/PageOverlay';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';

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
  const { isDark } = useTheme();
  return (
  <PageOverlay className="z-40 flex items-center justify-center p-4">
    <PageOverlay.Backdrop className="bg-slate-900/50 backdrop-blur-sm" />
    <div className={`relative w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden ${isDark ? 'bg-[#1e1e1e]' : 'bg-white'}`}>
     <div className={`p-6 border-b flex justify-between items-center ${isDark ? 'bg-[#252526] border-[#3e3e42]' : 'bg-slate-50 border-slate-100'}`}>
      <h2 className={`text-xl font-bold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-800'}`}><Plus size={ICON_SIZES.xl} className="text-blue-600" /> {t('createModal.title')}</h2>
      <button onClick={() => setShowCreateModal(false)} className={`p-2 rounded-full transition-all duration-150 ${isDark ? 'text-slate-400 hover:bg-[#3e3e42] hover:text-slate-200' : 'text-slate-500 hover:bg-white hover:text-slate-700'}`}><X size={ICON_SIZES.lg} /></button>
     </div>
     <div className="p-8 space-y-6">
      <div className="space-y-3">
         <label className={`flex items-center gap-2 text-xs font-bold uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}><FileSearch size={ICON_SIZES.sm} /> {t('createModal.importFromPath')}</label>
         <div className="flex gap-2">
          <input className={`flex-1 p-3 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 border ${isDark ? 'bg-[#2a2d35] border-[#3e3e42] text-slate-200 placeholder-slate-500' : 'bg-slate-100 border-slate-200 text-slate-900'}`} placeholder={t('createModal.pathPlaceholder')} value={createPath} onChange={e => setCreatePath(e.target.value)} />
          <button onClick={handleCreateFromPath} disabled={!createPath || isExtracting} className={`px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-50 transition-all duration-150 ${isDark ? 'bg-slate-200 text-slate-900 hover:bg-white' : 'bg-slate-900 text-white hover:bg-slate-800'}`}>{t('createModal.scanFile')}</button>
         </div>
      </div>
      <div className="relative"><div className="absolute inset-0 flex items-center"><div className={`w-full border-t ${isDark ? 'border-[#3e3e42]' : 'border-slate-100'}`}></div></div><div className="relative flex justify-center text-xs uppercase"><span className={`px-2 font-bold ${isDark ? 'bg-[#1e1e1e] text-slate-500' : 'bg-white text-slate-300'}`}>{t('createModal.or')}</span></div></div>
      <div className="space-y-3">
         <label className={`flex items-center gap-2 text-xs font-bold uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}><Clipboard size={ICON_SIZES.sm} /> {t('createModal.importFromClipboard')}</label>
         <button onClick={() => handleCreateFromClipboard()} disabled={isExtracting} className={`w-full flex items-center justify-center gap-3 p-4 rounded-xl font-bold transition-all duration-150 border ${isDark ? 'bg-blue-500/10 text-blue-300 border-blue-500/20 hover:bg-blue-500/20 hover:border-blue-400/30' : 'bg-blue-50 text-blue-700 border-blue-100 hover:bg-blue-100'}`}>
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
