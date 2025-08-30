import { downloadAttachment } from '@/lib/api';
import type { MessageOut } from '@/lib/types';

type DownloadsCtx = {
  userId: string | null;
  currentConversation: { id: string } | null;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;
};

export function createDownloadHandlers(ctx: DownloadsCtx) {
  const { userId, currentConversation, toast } = ctx;

  const triggerFileDownload = (blob: Blob, filename: string, _mimeType: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleFileDownload = async (attachment: any, message: MessageOut) => {
    if (!userId || !currentConversation) return;

    if (!attachment.blobId) {
      toast({ title: 'Download unavailable', description: 'This attachment cannot be downloaded', variant: 'destructive', duration: 3000 });
      return;
    }

    try {
      toast({ title: 'Downloading file...', description: `Starting download of ${attachment.name}`, duration: 2000 });

      const blob = await downloadAttachment(userId, currentConversation.id, message.id, attachment.blobId);

      triggerFileDownload(blob, attachment.name, attachment.mime);

      toast({ title: 'Download complete', description: `${attachment.name} has been downloaded`, duration: 2000 });
    } catch (error) {
      console.error('Download failed:', error);
      toast({ title: 'Download failed', description: 'Unable to download the file. Please try again.', variant: 'destructive', duration: 3000 });
    }
  };

  return { handleFileDownload };
}

