import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind CSS classes with proper conflict resolution.
 * Combines clsx (conditional classes) + tailwind-merge (deduplication).
 *
 * @example
 * cn("px-4 py-2", variant === "ghost" && "bg-transparent", className)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
