import { type HTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  /* base */
  "inline-flex items-center rounded-[var(--radius-sm)] px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap transition-all",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--bg-subtle)] text-[var(--fg-muted)] border border-[var(--border-default)]",
        blue:
          "bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent)]/15",
        green:
          "bg-[var(--success-subtle)] text-[var(--success)] border border-[var(--success)]/15",
        amber:
          "bg-[var(--warning-subtle)] text-[var(--warning)] border border-[var(--warning)]/15",
        red:
          "bg-[var(--danger-subtle)] text-[var(--danger)] border border-[var(--danger)]/15",
        info:
          "bg-[var(--info-subtle)] text-[var(--info)] border border-[var(--info)]/15",
        outline:
          "border border-[var(--border-default)] text-[var(--fg-muted)] bg-transparent",
        gradient:
          "text-white border-0",
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
  ({ className, variant, style, ...props }, ref) => {
    const gradientStyle = variant === 'gradient' ? { background: 'var(--accent-gradient)', ...style } : style;
    return (
      <span
        ref={ref}
        className={cn(badgeVariants({ variant, className }))}
        style={gradientStyle}
        {...props}
      />
    );
  }
);

Badge.displayName = "Badge";

export { Badge, badgeVariants };
