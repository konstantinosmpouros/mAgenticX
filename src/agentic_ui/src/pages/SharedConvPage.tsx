import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Building2, Home, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import ChatBody from "@/components/chat/ChatBody";
import { getSharedConversation } from "@/lib/api";
import type { MessageOut, SharedConversationDetail } from "@/lib/types";
import type { AttachmentLike } from "@/components/chat/message_parts/MessageAttachments";
import { useToast } from "@/hooks/use-toast";

const b64ToBlob = (data: string, mime: string) => {
  const bytes = atob(data);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    const slice = bytes.slice(offset, offset + 1024);
    const numbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i += 1) {
      numbers[i] = slice.charCodeAt(i);
    }
    chunks.push(new Uint8Array(numbers));
  }
  return new Blob(chunks, { type: mime || "application/octet-stream" });
};

export default function SharedConversationPage() {
  const { token = "" } = useParams();
  const { toast } = useToast();
  const [detail, setDetail] = useState<SharedConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getSharedConversation(token)
      .then((shared) => {
        if (cancelled) return;
        setDetail(shared);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load shared conversation:", err);
        setError("This shared conversation is unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleCopy = (content: string, messageId: string) => {
    void navigator.clipboard?.writeText(content);
    setCopiedId(messageId);
    window.setTimeout(() => setCopiedId(null), 1200);
  };

  const isImageFile = (attachment: AttachmentLike): boolean => {
    if (typeof attachment === "object" && attachment !== null) {
      const mime = String((attachment as any).mime || (attachment as any).mime_type || "");
      if (mime) return mime.startsWith("image/");
    }
    return false;
  };

  const downloadAttachment = (attachment: AttachmentLike) => {
    if (typeof attachment !== "object" || attachment === null || !(attachment as any).data) {
      toast({ title: "Download unavailable", description: "This shared attachment has no downloadable data.", variant: "destructive" });
      return;
    }

    const name = String((attachment as any).name || "attachment");
    const mime = String((attachment as any).mime || "application/octet-stream");
    const blob = b64ToBlob(String((attachment as any).data), mime);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const previewAttachment = (attachment: AttachmentLike) => {
    if (typeof attachment !== "object" || attachment === null || !(attachment as any).data) {
      downloadAttachment(attachment);
      return;
    }
    const mime = String((attachment as any).mime || "application/octet-stream");
    const blob = b64ToBlob(String((attachment as any).data), mime);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const toggleThinking = (messageId: string) => {
    setExpandedThinking((prev) => ({ ...prev, [messageId]: !prev[messageId] }));
  };

  const AgentIcon = detail?.agent.icon ?? Building2;

  return (
    <div className="flex min-h-svh max-h-svh flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border/70 px-4 md:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span>Read-only shared conversation</span>
          </div>
          <h1 className="truncate text-base font-semibold md:text-lg">
            {detail?.title || "Shared conversation"}
          </h1>
        </div>
        <Button variant="ghost" asChild className="shrink-0">
          <Link to="/">
            <Home className="h-4 w-4" />
            Home
          </Link>
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading shared conversation...
          </div>
        ) : error || !detail ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Share unavailable</h2>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        ) : (
          <ChatBody
            messages={detail.messages}
            loadingConversation={false}
            isClearing={false}
            expandedThinking={expandedThinking}
            isImageFile={isImageFile}
            onDownloadAttachment={downloadAttachment}
            onPreviewAttachment={previewAttachment}
            onImageClick={setSelectedImage}
            onToggleThinking={toggleThinking}
            copiedId={copiedId}
            onCopy={handleCopy}
            onLike={() => undefined}
            onDislike={() => undefined}
            stickyUserBarId={null}
            onFlashUserActionBar={() => undefined}
            thinkingState={null}
            messagesEndRef={messagesEndRef}
            AgentIcon={AgentIcon}
            currentAgent={detail.agent}
            readOnly
            isStreaming={false}
          />
        )}
      </main>

      {selectedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setSelectedImage(null)}
        >
          <button
            onClick={() => setSelectedImage(null)}
            className="absolute right-4 top-4 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:text-gray-300"
            aria-label="Close image preview"
          >
            <X size={24} />
          </button>
          <img
            src={selectedImage}
            alt="Full preview"
            className="h-auto max-h-[95vh] w-auto max-w-[95vw] rounded-lg object-contain shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
