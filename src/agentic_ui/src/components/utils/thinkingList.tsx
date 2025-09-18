import { cn } from "@/lib/utils";
import { Wrench, } from "lucide-react";
import { LuCircleCheck } from "react-icons/lu";
import { MarkdownRenderer } from "@/components/utils/markdownRenderer";


import { FaCog } from "react-icons/fa";
import { BiSolidCog } from "react-icons/bi";


type ThinkingListProps = {
  thoughts: string[];
  className?: string;
  isComplete?: boolean;
};

type Entry = {
  key: string;
  text: string;
  isTool: boolean;
  isDone?: boolean;
};

export function ThinkingList({ thoughts, className, isComplete = false }: ThinkingListProps) {
  const toolPattern = /^\s*\[tool\]\s*/i;
  const entries: Entry[] = (thoughts || []).map((raw, index) => {
    const thought = String(raw ?? "");
    const isTool = toolPattern.test(thought);
    const text = thought.replace(toolPattern, "");
    return { key: `thought-${index}`, text, isTool };
  });

  if (isComplete) {
    entries.push({ key: "thought-done", text: "Done!", isTool: false, isDone: true });
  }

  return (
    <div className={cn(className)}>
      <div className="flex flex-col space-y-3">
        {entries.map((entry, index) => {
          const isLast = index === entries.length - 1;
          const icon = entry.isDone ? (
            <LuCircleCheck className="h-4 w-4 text-muted-foreground/90" />
          ) : entry.isTool ? (
            <BiSolidCog className="h-3.5 w-3.5 text-muted-foreground/90" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/90" />
          );

          return (
            <div
              key={entry.key}
              className="flex items-stretch gap-2 text-sm md:text-base text-muted-foreground/90 animate-fade-in"
            >
              <div className="flex flex-col items-center w-5">
                <div className="flex h-5 w-full items-center justify-center translate-y-px">
                  {icon}
                </div>
                {!isLast && (
                  <div className="mt-[2px] mb-[-12px] w-px flex-1 bg-muted-foreground/30" />
                )}
              </div>
              <div className="flex-1">
                <MarkdownRenderer content={entry.text} className="leading-relaxed" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ThinkingList;
