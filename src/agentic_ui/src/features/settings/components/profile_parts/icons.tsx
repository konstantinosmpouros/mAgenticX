import { cn } from "@/shared/lib/utils";
import { MCP_ICON_SRCS, type McpIconVariant } from "@/shared/lib/consts";

export const McpIcon = ({
    size = 22,
    className,
    variant = "grey",
}: {
    size?: number;
    className?: string;
    variant?: McpIconVariant;
}) => (
    <img
        src={MCP_ICON_SRCS[variant]}
        alt="MCP servers"
        width={size}
        height={size}
        className={cn("object-contain", className)}
        draggable={false}
    />
);

export const VoiceGenderIcon = ({
    gender,
    className,
}: {
    gender: "female" | "male";
    className?: string;
}) => (
    <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        {gender === "female" ? (
            <>
                <circle cx="12" cy="8" r="4.5" />
                <path d="M12 12.5v8" />
                <path d="M8.5 17h7" />
            </>
        ) : (
            <>
                <circle cx="9" cy="15" r="4.5" />
                <path d="M12.25 11.75 19 5" />
                <path d="M15 5h4v4" />
            </>
        )}
    </svg>
);
