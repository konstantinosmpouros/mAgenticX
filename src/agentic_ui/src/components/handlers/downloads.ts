import type { MessageOut } from '@/lib/types';

type DownloadsCtx = {
  userId: string | null;
  currentConversation: { id: string } | null;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
};

export function createDownloadHandlers(ctx: DownloadsCtx) {
  const { userId, currentConversation, toast } = ctx;

  const triggerDirectDownload = (url: string, filename?: string) => {
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename; // optional; Content-Disposition also sets it
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleFileDownload = async (attachment: any, message: MessageOut) => {
    if (!userId || !currentConversation) return;

    if (!attachment.blobId) {
      toast({ title: 'Download unavailable', description: 'This attachment cannot be downloaded', variant: 'destructive', duration: 3000 });
      return;
    }

    try {
      toast({ title: 'Download starting', description: `Preparing ${attachment.name}`, duration: 2000 });

      const url = `/api/users/${userId}/conversations/${currentConversation.id}/messages/${message.id}/blobs/${attachment.blobId}`;
      // Let the browser handle streaming + progress natively
      triggerDirectDownload(url, attachment.name);
    } catch (error) {
      console.error('Download failed:', error);
      toast({ title: 'Download failed', description: 'Unable to download the file. Please try again.', variant: 'destructive', duration: 3000 });
    }
  };

  return { handleFileDownload };
}

