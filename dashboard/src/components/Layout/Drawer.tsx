import React from 'react';
import { X, ChevronLeft, ChevronRight, Minimize2, Maximize2 } from 'lucide-react';
import PageOverlay from '../Shared/PageOverlay';
import { Button } from '../ui';
import { cn } from '../../lib/utils';

/* ═══════════════════════════════════════════════════════════
 * Drawer — 统一侧边抽屉模板
 *
 * 设计规范：
 *   - 从右侧滑入 (slideInRight 0.25s)
 *   - 背景: bg-surface, border-l
 *   - 统一 PageOverlay + Backdrop 遮罩
 *   - Header: 44px 高, px-5 py-3, 底部 border
 *   - Body: flex-1, overflow-y-auto
 *   - Footer (可选): 底部 border-t, px-5 py-3
 *   - 宽度: 支持窄/宽双模式切换
 *
 * 用法：
 *   <Drawer open={!!selected} onClose={() => setSelected(null)}>
 *     <Drawer.Header title="详情">
 *       <Drawer.Nav ... />
 *       <Drawer.HeaderActions>
 *         <Button>自定义操作</Button>
 *       </Drawer.HeaderActions>
 *     </Drawer.Header>
 *     <Drawer.Body>内容</Drawer.Body>
 *     <Drawer.Footer>操作栏</Drawer.Footer>
 *   </Drawer>
 * ═══════════════════════════════════════════════════════════ */

// ── 宽度预设 ──────────────────────────────────────────────

export type DrawerSize = 'sm' | 'md' | 'md-lg' | 'lg' | 'xl' | 'full';

const SIZE_MAP: Record<DrawerSize, string> = {
  sm:     'w-[min(92vw,560px)]',
  md:     'w-[min(92vw,700px)]',
  'md-lg':'w-[min(92vw,800px)]',
  lg:     'w-[min(92vw,960px)]',
  xl:     'w-[min(92vw,1100px)]',
  full:   'w-[min(96vw,1280px)]',
};

// ── Props ─────────────────────────────────────────────────

interface DrawerProps {
  /** 是否显示 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 抽屉宽度尺寸 */
  size?: DrawerSize;
  /** 抽屉容器额外 className */
  className?: string;
  /** 动画时长 (默认 0.25s) */
  animationDuration?: string;
  children: React.ReactNode;
}

interface DrawerHeaderProps {
  /** 标题文本 */
  title?: React.ReactNode;
  /** 标题区域额外元素 (放在标题下方) */
  subtitle?: React.ReactNode;
  /** 头部额外 className */
  className?: string;
  children?: React.ReactNode;
}

interface DrawerNavProps {
  /** 当前索引 (0-based) */
  currentIndex: number;
  /** 总条数 */
  total: number;
  /** 上一条 */
  onPrev: () => void;
  /** 下一条 */
  onNext: () => void;
  /** 前一条是否可用 */
  hasPrev?: boolean;
  /** 后一条是否可用 */
  hasNext?: boolean;
}

interface DrawerWidthToggleProps {
  /** 是否已展开 */
  isWide: boolean;
  /** 切换回调 */
  onToggle: () => void;
  /** tooltip 文案 */
  title?: string;
}

interface DrawerBodyProps {
  /** body 额外 className */
  className?: string;
  /** 是否添加默认 padding (p-5) */
  padded?: boolean;
  children: React.ReactNode;
}

interface DrawerFooterProps {
  /** footer 额外 className */
  className?: string;
  children: React.ReactNode;
}

// ── 子组件: Header ────────────────────────────────────────

function DrawerHeader({ title, subtitle, className, children }: DrawerHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0',
        className
      )}
    >
      {/* 左侧: 标题区 */}
      {title && (
        <div className="flex-1 min-w-0 mr-3">
          <h3 className="font-bold text-[var(--fg-primary)] text-lg leading-snug break-words">
            {title}
          </h3>
          {subtitle && (
            <span className="text-xs text-[var(--fg-muted)] mt-0.5 block truncate">
              {subtitle}
            </span>
          )}
        </div>
      )}
      {/* 右侧: 操作区 (children = Nav + HeaderActions + Close) */}
      {children && (
        <div className="flex items-center gap-1 shrink-0">{children}</div>
      )}
    </div>
  );
}

// ── 子组件: Nav (Prev/Next 导航) ──────────────────────────

function DrawerNav({ currentIndex, total, onPrev, onNext, hasPrev, hasNext }: DrawerNavProps) {
  const prevDisabled = hasPrev !== undefined ? !hasPrev : currentIndex <= 0;
  const nextDisabled = hasNext !== undefined ? !hasNext : currentIndex >= total - 1;

  return (
    <>
      <Button variant="ghost" size="icon-sm" onClick={onPrev} disabled={prevDisabled}>
        <ChevronLeft size={16} />
      </Button>
      <span className="text-xs text-[var(--fg-muted)] tabular-nums">
        {currentIndex + 1}/{total}
      </span>
      <Button variant="ghost" size="icon-sm" onClick={onNext} disabled={nextDisabled}>
        <ChevronRight size={16} />
      </Button>
    </>
  );
}

// ── 子组件: WidthToggle ──────────────────────────────────

function DrawerWidthToggle({ isWide, onToggle, title }: DrawerWidthToggleProps) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onToggle} title={title}>
      {isWide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </Button>
  );
}

// ── 子组件: HeaderActions (分隔线 + 自定义按钮的容器) ─────

function DrawerHeaderActions({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="w-px h-5 bg-[var(--border-default)] mx-1" />
      {children}
    </>
  );
}

// ── 子组件: CloseButton ──────────────────────────────────

function DrawerCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onClose}>
      <X size={16} />
    </Button>
  );
}

// ── 子组件: Body ──────────────────────────────────────────

function DrawerBody({ className, padded = false, children }: DrawerBodyProps) {
  return (
    <div
      className={cn(
        'flex-1 overflow-y-auto',
        padded && 'p-5 space-y-5',
        className
      )}
    >
      {children}
    </div>
  );
}

// ── 子组件: Footer ────────────────────────────────────────

function DrawerFooter({ className, children }: DrawerFooterProps) {
  return (
    <div
      className={cn(
        'shrink-0 border-t border-[var(--border-default)] px-5 py-3 bg-[var(--bg-surface)] flex items-center justify-between',
        className
      )}
    >
      {children}
    </div>
  );
}

// ── 子组件: Panel (裸面板，用于多面板共享一个 PageOverlay 的场景) ──

interface DrawerPanelProps {
  /** 自定义宽度 className (覆盖 size 预设) */
  width?: string;
  /** 或使用预设尺寸 */
  size?: DrawerSize;
  /** 动画时长 */
  animationDuration?: string;
  /** 额外 className */
  className?: string;
  children: React.ReactNode;
}

function DrawerPanel({ width, size = 'md', animationDuration = '0.25s', className, children }: DrawerPanelProps) {
  return (
    <div
      className={cn(
        'relative h-full bg-[var(--bg-surface)] dark:bg-[var(--bg-surface)]/95 dark:backdrop-blur-xl shadow-2xl flex flex-col border-l border-[var(--border-default)] dark:border-[var(--glass-border)]',
        width || SIZE_MAP[size],
        className
      )}
      style={{ animation: `slideInRight ${animationDuration} ease-out` }}
      onClick={e => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

// ── 主组件: Drawer ────────────────────────────────────────

function Drawer({
  open,
  onClose,
  size = 'md',
  className,
  animationDuration = '0.25s',
  children,
}: DrawerProps) {
  if (!open) return null;

  return (
    <PageOverlay className="z-30 flex justify-end" onClick={onClose}>
      <PageOverlay.Backdrop className="bg-black/20 dark:bg-black/40 backdrop-blur-sm" />
      <div
        className={cn(
          'relative h-full bg-[var(--bg-surface)] dark:bg-[var(--bg-surface)]/95 dark:backdrop-blur-xl shadow-2xl flex flex-col border-l border-[var(--border-default)] dark:border-[var(--glass-border)] dark:shadow-[0_0_80px_rgba(0,0,0,0.5)]',
          SIZE_MAP[size],
          className
        )}
        style={{ animation: `slideInRight ${animationDuration} ease-out` }}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </PageOverlay>
  );
}

// ── 复合组件导出 ──────────────────────────────────────────

Drawer.Header = DrawerHeader;
Drawer.Nav = DrawerNav;
Drawer.WidthToggle = DrawerWidthToggle;
Drawer.HeaderActions = DrawerHeaderActions;
Drawer.CloseButton = DrawerCloseButton;
Drawer.Body = DrawerBody;
Drawer.Footer = DrawerFooter;
Drawer.Panel = DrawerPanel;

export { Drawer, DrawerPanel, DrawerHeader, DrawerNav, DrawerWidthToggle, DrawerHeaderActions, DrawerCloseButton, DrawerBody, DrawerFooter };
export type { DrawerProps, DrawerPanelProps, DrawerHeaderProps, DrawerNavProps, DrawerWidthToggleProps, DrawerBodyProps, DrawerFooterProps };
