import type { LucideIcon } from "lucide-react";
import * as Icons from "lucide-react";

/**
 * Convert a backend-provided Lucide icon name into the actual icon component.
 * Falls back to `Building2` when the icon name is missing or invalid.
 */
export const mapIcon = (name: string | null | undefined): LucideIcon => {
  if (!name) {
    return Icons.Building2;
  }
  const Icon = (Icons as unknown as Record<string, LucideIcon | undefined>)[name];
  return Icon ?? Icons.Building2;
};
