import React from 'react';
import { categoryConfigs } from '../../constants';
import { ICON_SIZES } from '../../constants/icons';

interface CategoryBarProps {
  selectedCategory: string;
  setSelectedCategory: (category: string) => void;
}

const CategoryBar: React.FC<CategoryBarProps> = ({ selectedCategory, setSelectedCategory }) => {
  return (
  <div className="bg-white border-b border-slate-100 shrink-0 overflow-hidden">
    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar px-4 xl:px-6 2xl:px-8 py-3">
    {Object.entries(categoryConfigs).map(([cat, config]) => {
      const Icon = config.icon;
      const isSelected = selectedCategory === cat;
      return (
      <button
        key={cat}
        onClick={() => setSelectedCategory(cat)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all border whitespace-nowrap
        ${isSelected 
          ? `${config.bg} ${config.color} ${config.border} shadow-sm scale-105` 
          : 'bg-white text-slate-400 border-slate-100 hover:border-slate-200 hover:text-slate-600'}`}
      >
        <Icon size={ICON_SIZES.xs} />
        {cat}
      </button>
      );
    })}
    </div>
  </div>
  );
};

export default CategoryBar;
