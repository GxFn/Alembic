import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Custom Select — 项目统一下拉选择器
 *
 * 替代原生 <select>，使用 CSS 变量风格，支持亮/暗模式。
 */

export interface SelectOption {
  value: string;
  label: string;
  /** 选项前缀图标文字（如 emoji） */
  icon?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** 触发器额外 className */
  className?: string;
  /** 下拉面板额外 className */
  contentClassName?: string;
  /** 占位文本 */
  placeholder?: string;
  disabled?: boolean;
  /** 尺寸 */
  size?: 'xs' | 'sm' | 'md';
  /** 触发器最小宽度 */
  minWidth?: number;
  /** 下拉方向：auto 自动检测（默认）、up 向上、down 向下 */
  direction?: 'auto' | 'up' | 'down';
  id?: string;
  name?: string;
}

const SIZE_CLASSES: Record<string, string> = {
  xs: 'h-6 text-[10px] px-1.5 gap-1 rounded',
  sm: 'h-7 text-[11px] px-2 gap-1.5 rounded-md',
  md: 'h-9 text-sm px-3 gap-2 rounded-lg',
};

const ITEM_SIZE_CLASSES: Record<string, string> = {
  xs: 'text-[10px] px-1.5 py-1',
  sm: 'text-[11px] px-2 py-1.5',
  md: 'text-sm px-3 py-2',
};

const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  className,
  contentClassName,
  placeholder = '—',
  disabled = false,
  size = 'sm',
  minWidth,
  direction = 'auto',
  id,
  name,
}) => {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [dropUp, setDropUp] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(o => o.value === value);

  // 同步计算展开方向
  const resolveDirection = useCallback(() => {
    if (direction === 'up') return true;
    if (direction === 'down') return false;
    if (!triggerRef.current) return false;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const estimatedHeight = Math.min(options.length * 28 + 8, 248);
    return spaceBelow < estimatedHeight && rect.top > estimatedHeight;
  }, [direction, options.length]);

  // 封装 open，打开前先同步算好方向
  const openDropdown = useCallback(() => {
    setDropUp(resolveDirection());
    setOpen(true);
    setHighlightIndex(options.findIndex(o => o.value === value));
  }, [resolveDirection, options, value]);

  // Click-outside close
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        listRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled) return;
    const enabledOptions = options.filter(o => !o.disabled);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) {
        openDropdown();
      } else if (highlightIndex >= 0 && highlightIndex < enabledOptions.length) {
        onChange(enabledOptions[highlightIndex].value);
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        openDropdown();
      } else {
        setHighlightIndex(i => Math.min(i + 1, enabledOptions.length - 1));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => Math.max(i - 1, 0));
    }
  }, [disabled, open, highlightIndex, options, value, onChange, openDropdown]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || highlightIndex < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-select-item]');
    items[highlightIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex, open]);

  const handleSelect = (val: string) => {
    onChange(val);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="relative inline-block" style={minWidth ? { minWidth } : undefined}>
      {/* Hidden native input for form compatibility */}
      {name && <input type="hidden" name={name} value={value} />}

      {/* Trigger */}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => { if (!disabled) { if (open) { setOpen(false); } else { openDropdown(); } } }}
        onKeyDown={handleKeyDown}
        className={cn(
          'inline-flex items-center justify-between border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--fg-default)] font-medium transition-colors',
          'hover:border-[var(--border-emphasis)] hover:bg-[var(--bg-subtle)]',
          'disabled:opacity-50 disabled:pointer-events-none',
          SIZE_CLASSES[size],
          className
        )}
      >
        <span className="truncate">
          {selectedOption ? (
            <>
              {selectedOption.icon && <span className="mr-1">{selectedOption.icon}</span>}
              {selectedOption.label}
            </>
          ) : placeholder}
        </span>
        <ChevronDown size={size === 'xs' ? 10 : size === 'sm' ? 12 : 14} className={cn('shrink-0 text-[var(--fg-muted)] transition-transform', open && 'rotate-180')} />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={cn(
            'absolute z-50 min-w-full max-h-60 overflow-y-auto',
            'rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-lg)] p-0.5',
            dropUp
              ? 'bottom-full mb-1 animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1'
              : 'top-full mt-1 animate-in fade-in-0 zoom-in-95 slide-in-from-top-1',
            contentClassName
          )}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isHighlighted = i === highlightIndex;
            return (
              <div
                key={opt.value}
                data-select-item
                role="option"
                aria-selected={isSelected}
                onClick={() => !opt.disabled && handleSelect(opt.value)}
                onMouseEnter={() => !opt.disabled && setHighlightIndex(i)}
                className={cn(
                  'flex items-center justify-between cursor-pointer rounded-[var(--radius-sm)] transition-colors',
                  ITEM_SIZE_CLASSES[size],
                  opt.disabled && 'opacity-40 pointer-events-none',
                  isHighlighted && 'bg-[var(--bg-subtle)]',
                  isSelected && 'text-[var(--accent)] font-semibold',
                )}
              >
                <span className="flex items-center gap-1.5 truncate">
                  {opt.icon && <span>{opt.icon}</span>}
                  {opt.label}
                </span>
                {isSelected && <Check size={size === 'xs' ? 10 : 12} className="shrink-0 text-[var(--accent)]" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Select;
