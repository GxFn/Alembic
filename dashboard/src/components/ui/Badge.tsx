import { type HTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  /* base */
  "inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-medium leading-none whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--bg-subtle)] text-[var(--fg-muted)] border border-[var(--border-default)]",
        blue:
          "bg-[var(--accent-subtle)] text-[var(--accent)] border-transparent",
        green:
          "bg-[var(--success-subtle)] text-[var(--success)] border-transparent",
        amber:
          "bg-[var(--warning-subtle)] text-[var(--warning)] border-transparent",
        red:
          "bg-[var(--danger-subtle)] text-[var(--danger)] border-transparent",
        info:
          "bg-[var(--info-subtle)] text-[var(--info)] border-transparent",
        outline:
          "border border-[var(--border-default)] text-[var(--fg-muted)] bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  )
);

Badge.displayName = "Badge";

export { Badge, badgeVariants };
