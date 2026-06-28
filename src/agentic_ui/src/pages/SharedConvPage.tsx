import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Building2, CalendarDays, Home, Send, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import ChatBody from "@/components/chat/ChatBody";
import { getSharedConversation, startInference } from "@/lib/api";
import { getInferenceStartErrorCopy } from "@/runtime";
import type { MessageOut, SharedConversationDetail } from "@/lib/types";
import type { AttachmentLike } from "@/components/chat/message_parts/MessageAttachments";
import { useToast } from "@/hooks/use-toast";
import { isSessionValid, loadSession, updateSession } from "@/lib/authStorage";
import { ChatInterface } from "./ChatPage";

const b64ToBlob = (data: string, mime: string) => {
  const bytes = atob(data);
  const chunks: BlobPart[] = [];
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    const slice = bytes.slice(offset, offset + 1024);
    const numbers = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i += 1) {
      numbers[i] = slice.charCodeAt(i);
    }
    chunks.push(numbers);
  }
  return new Blob(chunks, { type: mime || "application/octet-stream" });
};

export default function SharedConversationPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [detail, setDetail] = useState<SharedConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [continuing, setContinuing] = useState(false);
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
        if ((err as { status?: number }).status === 404) {
          navigate("/404", { replace: true });
          return;
        }
        setError("This shared conversation is unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [navigate, token]);

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

  const handleContinueSharedConversation = async () => {
    const content = replyDraft.trim();
    if (!content || continuing) return;

    const session = loadSession();
    if (!isSessionValid(session)) {
      toast({ title: "Sign in to continue", description: "Create your own copy of this shared conversation after signing in.", duration: 2600 });
      navigate("/login");
      return;
    }
    const userId = session.userId;

    setContinuing(true);
    try {
      const response = await startInference(userId, {
        mode: "shared_continue",
        sharedConversationToken: token,
        message: {
          sender: "user",
          content,
          parentMessageId: null,
        },
      });
      updateSession({ lastConversationId: response.detail.id });
      toast({ title: "Conversation added", description: "The agent response is now running in your workspace.", duration: 2200 });
      navigate("/");
    } catch (err) {
      console.error("Failed to continue shared conversation:", err);
      const copy = getInferenceStartErrorCopy(err, {
        title: "Could not continue conversation",
        description: err instanceof Error ? err.message : "Please try again.",
      });
      toast({ ...copy, variant: "destructive", duration: 3000 });
    } finally {
      setContinuing(false);
    }
  };

  const AgentIcon = detail?.agent.icon ?? Building2;
  const pageTitle = detail?.title || "Shared conversation";
  const shareLabel =
    detail?.shareMode === "message"
      ? "Shared response"
      : detail?.shareMode === "branch"
        ? "Shared thread"
        : "Shared conversation";
  const sharedDate = detail?.createdAt
    ? detail.createdAt.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  if (!loading && detail?.shareMode === "full" && isSessionValid(loadSession())) {
    return (
      <ChatInterface
        sharedConversationToken={token}
        initialSharedConversation={detail}
      />
    );
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(240_7%_8%)_58%,hsl(220_13%_9%)_100%)] text-foreground">
      <header className="shrink-0 border-b border-white/10 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
              <img
                src="/logo2_white_magentaX.png"
                alt="mAgenticX"
                className="h-6 w-6 object-contain"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span>{shareLabel}</span>
              </div>
              <h1 className="truncate text-sm font-semibold md:text-base">
                {pageTitle}
              </h1>
            </div>
          </div>
          <Button
            variant="ghost"
            asChild
            className="h-9 shrink-0 rounded-full px-3 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          >
            <Link to="/">
              <Home className="h-4 w-4" />
              <span className="hidden sm:inline">Home</span>
            </Link>
          </Button>
        </div>
      </header>

      <section className="shrink-0 border-b border-white/10 bg-card/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 md:px-6 md:py-5">
          {loading ? (
            <div className="space-y-3">
              <div className="loading-skeleton h-4 w-36 rounded-full" />
              <div className="loading-skeleton h-7 w-full max-w-xl rounded-lg" />
              <div className="flex gap-2">
                <div className="loading-skeleton h-9 w-28 rounded-lg" />
                <div className="loading-skeleton h-9 w-28 rounded-lg" />
              </div>
            </div>
          ) : detail ? (
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div className="min-w-0 space-y-2">
                <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  <AgentIcon className="h-3.5 w-3.5" />
                  <span className="truncate">{detail.agent.name}</span>
                </div>
                <div>
                  <h2 className="line-clamp-2 text-xl font-semibold tracking-tight md:text-2xl">
                    {pageTitle}
                  </h2>
                  {detail.agent.description ? (
                    <p className="mt-1 line-clamp-2 max-w-2xl text-sm text-muted-foreground">
                      {detail.agent.description}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center text-sm">
                {sharedDate ? (
                  <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-background/45 px-3 py-2 text-muted-foreground">
                    <CalendarDays className="h-4 w-4 text-foreground/80" />
                    <span>{sharedDate}</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-0 py-0 md:px-6 md:py-5">
        {loading ? (
          <div className="mx-auto flex h-full w-full max-w-6xl items-center justify-center rounded-none border-white/10 bg-card/20 text-sm text-muted-foreground md:rounded-2xl md:border">
            Loading shared conversation...
          </div>
        ) : error || !detail ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="max-w-md rounded-2xl border border-white/10 bg-card/50 p-6 shadow-card">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <X className="h-5 w-5" />
              </div>
              <h2 className="text-lg font-semibold">Share unavailable</h2>
              <p className="mt-2 text-sm text-muted-foreground">{error}</p>
              <Button asChild className="mt-5">
                <Link to="/">
                  <Home className="h-4 w-4" />
                  Return home
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-hidden border-white/10 bg-background/45 shadow-[0_24px_80px_rgba(0,0,0,0.28)] md:rounded-2xl md:border">
            <ChatBody
              messages={detail.messages}
              loadingConversation={false}
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
          </div>
        )}
      </main>

      {!loading && detail && !error && detail.shareMode === "full" ? (
        <section className="shrink-0 border-t border-white/10 bg-background/90 px-4 py-3 backdrop-blur-xl md:px-6">
          <div className="mx-auto flex w-full max-w-6xl items-end gap-2">
            <Textarea
              value={replyDraft}
              onChange={(event) => setReplyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleContinueSharedConversation();
                }
              }}
              disabled={continuing}
              placeholder="Continue this conversation in your workspace..."
              className="min-h-11 max-h-32 resize-none rounded-xl border-white/10 bg-card/70 px-4 py-3 text-sm shadow-sm"
            />
            <Button
              type="button"
              onClick={() => void handleContinueSharedConversation()}
              disabled={!replyDraft.trim() || continuing}
              className="h-11 shrink-0 rounded-xl px-4"
              aria-label="Continue shared conversation"
            >
              <Send className="h-4 w-4" />
              <span className="hidden sm:inline">{continuing ? "Creating..." : "Continue"}</span>
            </Button>
          </div>
        </section>
      ) : null}

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
