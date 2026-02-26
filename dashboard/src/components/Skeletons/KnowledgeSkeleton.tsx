import { Skeleton } from '../ui/Skeleton';

/**
 * KnowledgeView 骨架屏 — 表格行骨架
 * 用于数据首次加载时替代 Loader2 spinner
 */
export function KnowledgeSkeleton() {
  return (
    <div className="space-y-0">
      {/* Table header skeleton */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-[var(--border-default)]">
        <Skeleton className="h-4 w-4 rounded-sm" />
        <Skeleton className="h-3.5 w-[30%]" />
        <Skeleton className="h-3.5 w-[12%]" />
        <Skeleton className="h-3.5 w-[12%]" />
        <Skeleton className="h-3.5 w-[15%]" />
        <Skeleton className="h-3.5 w-6" />
      </div>
      {/* Table rows skeleton */}
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-3 border-b border-[var(--border-default)]"
        >
          <Skeleton className="h-4 w-4 rounded-sm" />
          <Skeleton className="h-3.5 w-[28%]" style={{ width: `${24 + (i % 3) * 8}%` }} />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-3.5 w-[12%]" />
          <Skeleton className="h-5 w-5 rounded" />
        </div>
      ))}
    </div>
  );
}
