import type { PlacedIssue } from "@/features/agents/lib/agentIssues";

/** The aria wiring a control needs to announce its issues (see fields.tsx). */
export const invalidProps = (issues: PlacedIssue[], describedBy: string) =>
  issues.length
    ? {
        "aria-invalid": issues.some((item) => item.severity === "error") || undefined,
        "aria-describedby": describedBy || undefined,
      }
    : {};
