import { Download, FileType2, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

type PreviewMessageProps = {
  title: string;
  description?: string;
  onDownload?: () => void;
  tone?: "default" | "error";
};

export function PreviewLoading({ label = "Opening preview..." }: { label?: string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#222]/70 backdrop-blur-sm">
      <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <span className="text-sm text-white">{label}</span>
      </div>
    </div>
  );
}

export function PreviewMessage({
  title,
  description,
  onDownload,
  tone = "default",
}: PreviewMessageProps) {
  const Icon = tone === "error" ? XCircle : FileType2;
  const iconClass = tone === "error" ? "bg-destructive/10 text-destructive" : "bg-white/[0.06] text-white/75";

  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-lg rounded-[1.5rem] border border-white/10 bg-[#262626] px-6 py-7 text-center shadow-sm">
        <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl ${iconClass}`}>
          <Icon className="h-6 w-6" />
        </div>
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        {description ? <p className="mt-2 text-sm text-white/60">{description}</p> : null}
        {onDownload ? (
          <Button type="button" className="mt-5 gap-2" onClick={onDownload}>
            <Download className="h-4 w-4" />
            Download original file
          </Button>
        ) : null}
      </div>
    </div>
  );
}
