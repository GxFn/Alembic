import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

/* ── Card Root ── */
const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] transition-[border-color,box-shadow]",
        "duration-200 hover:border-[var(--border-emphasis)] hover:shadow-[var(--shadow-md)]",
        className
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

/* ── Card Header ── */
const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex items-center justify-between p-5 pb-0", className)}
      {...props}
    />
  )
);
CardHeader.displayName = "CardHeader";

/* ── Card Title ── */
const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn(
        "text-sm font-medium text-[var(--fg-default)] leading-tight",
        className
      )}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

/* ── Card Description ── */
const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("text-sm text-[var(--fg-muted)] leading-relaxed", className)}
      {...props}
    />
  )
);
CardDescription.displayName = "CardDescription";

/* ── Card Content ── */
const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("p-5", className)}
      {...props}
    />
  )
);
CardContent.displayName = "CardContent";

/* ── Card Footer ── */
const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex items-center px-5 pb-5 pt-0",
        className
      )}
      {...props}
    />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
