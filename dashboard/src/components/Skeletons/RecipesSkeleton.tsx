import { Skeleton } from '../ui/Skeleton';

/**
 * RecipesView 骨架屏 — 4 张卡片骨架 (Resend 风格)
 * 用于数据首次加载时显示
 */
export function RecipesSkeleton() {
  return (
    <div className="space-y-0 divide-y divide-[var(--border-default)]">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="px-4 py-4 space-y-3">
          {/* Title row */}
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-[45%]" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
          {/* Description */}
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-[70%]" />
          </div>
          {/* Tags row */}
          <div className="flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
