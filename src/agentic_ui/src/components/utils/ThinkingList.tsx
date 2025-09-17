import * as React from "react";
import { cn } from "@/lib/utils";
import { Wrench, Loader2, CheckCircle } from "lucide-react";
import { MarkdownRenderer } from "@/components/utils/MarkdownRenderer";

type ThinkingListProps = {
  thoughts: string[];
  className?: string;
};

export function ThinkingList({ thoughts, className }: ThinkingListProps) {
  const toolPattern = /^\s*\[tool\]\s*/i;
  return (
    <div className={cn(className)}>
      <div className="space-y-2">
        {thoughts.map((raw, i) => {
          const thought = String(raw ?? "");
          const isTool = toolPattern.test(thought);
          const displayText = thought.replace(toolPattern, '');
          return (
            <div key={i} className="flex items-stretch gap-2 text-sm md:text-base text-muted-foreground/90 animate-fade-in">
              {/* Left column: bullet/tool + adaptive vertical line */}
              <div className="w-4 flex-shrink-0 flex flex-col items-center">
                {isTool ? (
                  <Wrench className="mt-[5px] h-3.5 w-3.5 text-muted-foreground/70" />
                ) : (
                  <span className="mt-2.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                )}
                <>
                  <div className="w-px flex-1 bg-muted-foreground/30 mt-1 origin-top animate-line-grow" />
                  <div className="w-px h-3 bg-muted-foreground/30 origin-top animate-line-grow" />
                </>
              </div>
              {/* Right column: content; height determines the left line height */}
              <MarkdownRenderer content={displayText} className="leading-relaxed pr-2" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ThinkingList;
