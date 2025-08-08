// src/lib/constants.ts
import { Building2, ShoppingBag, TrendingUp, Search, Zap } from "lucide-react";
import type { Agent } from "./types";

export const agents: Agent[] = [
    {
        id: "hr-policies",
        name: "HR Policies Agent",
        description: "Human resources policies and procedures specialist",
        icon: Building2
    },
    {
        id: "retail",
        name: "Retail Agent",
        description: "Retail operations and customer service expert",
        icon: ShoppingBag
    },
    {
        id: "marketing",
        name: "Marketing Agent",
        description: "Marketing strategies and campaign optimization",
        icon: TrendingUp
    },
    {
        id: "orthodox",
        name: "Orthodox Agent",
        description: "Orthodox biblical and theological insights",
        icon: Search
    },
    {
        id: "deep-research",
        name: "DeepResearch Agent",
        description: "Advanced research and competitive intelligence",
        icon: Zap
    },
];
