import { cn } from "../../lib/utils";

/* ═══════════════════════════════════════════════════════
 * Skeleton — Shimmer loading placeholder
 *
 * 用法:
 *   <Skeleton className="h-4 w-[200px]" />
 *   <Skeleton className="h-12 w-full rounded-lg" />
 * ═══════════════════════════════════════════════════════ */

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-md)] animate-shimmer",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
