import React from 'react';
import { cn } from '../../lib/utils';

/**
 * 统一页面容器 — 所有 View 的顶层包装。
 * 提供一致的内边距、滚动行为和页面过渡。
 */
interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
  /** 禁用默认内边距（用于全屏组件如 Graph） */
  noPadding?: boolean;
  /** 禁用滚动（用于自带滚动的页面） */
  noScroll?: boolean;
}

const PageContainer: React.FC<PageContainerProps> = ({
  children,
  className,
  noPadding = false,
  noScroll = false,
}) => {
  return (
    <div
      className={cn(
        "flex-1 min-h-0",
        !noScroll && "overflow-y-auto",
        !noPadding && "p-6",
        className
      )}
    >
      {children}
    </div>
  );
};

export default PageContainer;
