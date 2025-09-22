import * as React from "react"

import { cn } from "@/lib/utils"

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          // base textarea styling
          "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
          "ring-offset-background placeholder:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",

          // make textarea scrollbars thin with a transparent track
          "overflow-auto [scrollbar-color:rgba(var(--muted-foreground)/.2) transparent]",
          "[&::-webkit-scrollbar]:w-1.5",
          "[&::-webkit-scrollbar-track]:bg-transparent",
          "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20",
          "[&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/30",

          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
