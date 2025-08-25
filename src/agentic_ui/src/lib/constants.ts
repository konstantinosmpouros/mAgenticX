import type { LucideIcon } from "lucide-react";
import * as Icons from "lucide-react";

export const mapIcon = (name: string): LucideIcon => {
    const Icon = (Icons as Record<string, any>)[name] as LucideIcon | undefined;
    // Fallback gracefully to Building2 if icon name is invalid
    return Icon || Icons.Building2;
};