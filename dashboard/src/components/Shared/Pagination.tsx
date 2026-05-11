import React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { ICON_SIZES } from '../../constants/icons';
import { useI18n } from '../../i18n';
import Select from '../ui/Select';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [12, 24, 48, 96]
}) => {
  if (totalPages <= 1 && totalItems <= pageSizeOptions[0]) {
  return null;
  }

  const { t } = useI18n();

  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);

  // 生成页码数组
  const getPageNumbers = () => {
  const pages: (number | string)[] = [];
  const showPages = 5; // 显示的页码数量

  if (totalPages <= showPages + 2) {
    // 页数较少，全部显示
    for (let i = 1; i <= totalPages; i++) {
    pages.push(i);
    }
  } else {
    // 页数较多，显示省略号
    if (currentPage <= 3) {
    for (let i = 1; i <= showPages; i++) {
      pages.push(i);
    }
    pages.push('...');
    pages.push(totalPages);
    } else if (currentPage >= totalPages - 2) {
    pages.push(1);
    pages.push('...');
    for (let i = totalPages - showPages + 1; i <= totalPages; i++) {
      pages.push(i);
    }
    } else {
    pages.push(1);
    pages.push('...');
    for (let i = currentPage - 1; i <= currentPage + 1; i++) {
      pages.push(i);
    }
    pages.push('...');
    pages.push(totalPages);
    }
  }
  return pages;
  };

  return (
  <div className="flex items-center justify-between mt-6 px-2">
    {/* 左侧：显示统计 */}
    <div className="flex items-center gap-4">
    <span className="text-sm text-[var(--fg-secondary)]">
      {t('pagination.showing', { start: startItem, end: endItem, total: totalItems })}
    </span>
    {onPageSizeChange && (
      <div className="flex items-center gap-2">
      <span className="text-sm text-[var(--fg-secondary)]">{t('pagination.perPage')}</span>
      <Select
        value={String(pageSize)}
        onChange={(v) => onPageSizeChange(Number(v))}
        options={pageSizeOptions.map(size => ({ value: String(size), label: String(size) }))}
        size="sm"
      />
      <span className="text-sm text-[var(--fg-secondary)]">{t('pagination.unit')}</span>
      </div>
    )}
    </div>

    {/* 右侧：分页控件 */}
    <div className="flex items-center gap-1">
    {/* 第一页 */}
    <button
      onClick={() => onPageChange(1)}
      disabled={currentPage === 1}
      className="p-1.5 rounded-md hover:bg-[var(--bg-subtle)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      title={t('pagination.firstPage')}
    >
      <ChevronsLeft size={ICON_SIZES.md} className="text-[var(--fg-secondary)]" />
    </button>

    {/* 上一页 */}
    <button
      onClick={() => onPageChange(currentPage - 1)}
      disabled={currentPage === 1}
      className="p-1.5 rounded-md hover:bg-[var(--bg-subtle)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      title={t('pagination.prevPage')}
    >
      <ChevronLeft size={ICON_SIZES.md} className="text-[var(--fg-secondary)]" />
    </button>

    {/* 页码 */}
    <div className="flex items-center gap-1 mx-2">
      {getPageNumbers().map((page, index) => (
      typeof page === 'number' ? (
        <button
        key={index}
        onClick={() => onPageChange(page)}
        className={`min-w-[32px] h-8 px-2 rounded-md text-sm font-medium transition-colors ${
          currentPage === page
          ? 'bg-blue-600 text-white'
          : 'hover:bg-[var(--bg-subtle)] text-[var(--fg-secondary)]'
        }`}
        >
        {page}
        </button>
      ) : (
        <span key={index} className="px-1 text-[var(--fg-muted)]">
        {page}
        </span>
      )
      ))}
    </div>

    {/* 下一页 */}
    <button
      onClick={() => onPageChange(currentPage + 1)}
      disabled={currentPage === totalPages}
      className="p-1.5 rounded-md hover:bg-[var(--bg-subtle)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      title={t('pagination.nextPage')}
    >
      <ChevronRight size={ICON_SIZES.md} className="text-[var(--fg-secondary)]" />
    </button>

    {/* 最后一页 */}
    <button
      onClick={() => onPageChange(totalPages)}
      disabled={currentPage === totalPages}
      className="p-1.5 rounded-md hover:bg-[var(--bg-subtle)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      title={t('pagination.lastPage')}
    >
      <ChevronsRight size={ICON_SIZES.md} className="text-[var(--fg-secondary)]" />
    </button>
    </div>
  </div>
  );
};

export default Pagination;
