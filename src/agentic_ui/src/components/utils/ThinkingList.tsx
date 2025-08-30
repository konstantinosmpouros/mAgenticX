import * as React from "react";
import { cn } from "@/lib/utils";
import { Wrench, Loader2, CheckCircle } from "lucide-react";

type ThinkingListProps = {
  thoughts: string[];
  className?: string;
};

export function ThinkingList({ thoughts, className }: ThinkingListProps) {
  const toolPattern = /^(\s*(\[tool\]|\(tool\)|tool:|executing tool|running tool|calling tool))/i;
  return (
    <div className={cn(className)}>
      <div className="space-y-2">
        {thoughts.map((raw, i) => {
          const thought = String(raw ?? "");
          const isTool = toolPattern.test(thought);
          const isActive = i === thoughts.length - 1; // treat last as active for subtle motion on tools
          const isDone = isActive && /^\s*done!?\s*$/i.test(thought.trim());
          return (
            <div key={i} className="flex items-stretch gap-2 text-sm md:text-base text-muted-foreground/80 animate-fade-in">
              {/* Left column: bullet/tool + adaptive vertical line */}
              <div className="w-4 flex-shrink-0 flex flex-col items-center">
                {isDone ? (
                  <CheckCircle className="h-3.5 w-3.5 text-muted-foreground/60" />
                ) : isTool ? (
                  isActive ? (
                    <Loader2 className="h-3.5 w-3.5 text-muted-foreground/70 animate-spin" />
                  ) : (
                    <Wrench className="h-3.5 w-3.5 text-muted-foreground/70" />
                  )
                ) : (
                  <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                )}
                <div className="w-px flex-1 bg-muted-foreground/30 mt-1" />
              </div>
              {/* Right column: content; height determines the left line height */}
              <div className="whitespace-pre-wrap break-words leading-relaxed pr-2">
                {thought}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ThinkingList;
