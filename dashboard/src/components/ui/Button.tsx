import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  /* base */
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-all cursor-pointer select-none disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-root)] active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--bg-emphasis)] text-[var(--fg-on-emphasis)] hover:opacity-90",
        secondary:
          "bg-[var(--bg-root)] text-[var(--fg-default)] border border-[var(--border-default)] hover:bg-[var(--bg-subtle)] hover:border-[var(--border-emphasis)]",
        ghost:
          "bg-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg-default)]",
        danger:
          "bg-[var(--danger)] text-white hover:opacity-90",
        accent:
          "bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90",
      },
      size: {
        sm: "h-7 px-2.5 text-xs rounded-[var(--radius-md)]",
        md: "h-9 px-4 text-sm rounded-[var(--radius-md)]",
        lg: "h-11 px-5 text-base rounded-[var(--radius-md)]",
        icon: "h-8 w-8 rounded-[var(--radius-md)]",
        "icon-sm": "h-7 w-7 rounded-[var(--radius-sm)]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <svg
            className="h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";

export { Button, buttonVariants };
