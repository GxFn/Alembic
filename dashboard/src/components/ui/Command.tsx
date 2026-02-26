import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "../../lib/utils";

/* ═══════════════════════════════════════════════════════
 * Command Palette — cmdk wrapper (Raycast/Linear 风格)
 * ═══════════════════════════════════════════════════════ */

const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-xl)] text-[var(--fg-default)]",
      className
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

/* ── Input ── */
const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex items-center border-b border-[var(--border-muted)] px-3">
    <Search className="mr-2 h-4 w-4 shrink-0 text-[var(--fg-subtle)]" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-12 w-full bg-transparent py-3 text-sm text-[var(--fg-default)] outline-none placeholder:text-[var(--fg-subtle)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitive.Input.displayName;

/* ── List ── */
const CommandList = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden p-1", className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

/* ── Empty ── */
const CommandEmpty = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="py-6 text-center text-sm text-[var(--fg-subtle)]"
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

/* ── Group ── */
const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden p-1 text-[var(--fg-default)]",
      "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--fg-subtle)]",
      className
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

/* ── Separator ── */
const CommandSeparator = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 h-px bg-[var(--border-muted)]", className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

/* ── Item ── */
const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default gap-2 select-none items-center rounded-[var(--radius-md)] px-2.5 py-2 text-sm outline-none transition-colors",
      "data-[selected=true]:bg-[var(--accent-subtle)] data-[selected=true]:text-[var(--accent)]",
      "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      className
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;

/* ── Shortcut ── */
function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest text-[var(--fg-subtle)]", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
