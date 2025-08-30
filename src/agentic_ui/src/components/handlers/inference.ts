import { createConversation, addMessageToConversation } from '@/lib/api';
import { convertFileAttachments } from '@/lib/utils';
import { validateAttachmentsForUpload } from '@/lib/uploadGuards';
import { startThinking } from './thinking';
import type { Agent, ConversationDetail, ConversationIn, MessageIn, MessageOut, FileAttachment } from '@/lib/types';

type InferenceCtx = {
  userId: string | null;
  selectedAgent: string;
  isPrivateMode: boolean;
  messages: MessageOut[];
  attachments: File[];
  agents: Agent[];
  currentConversation: ConversationDetail | null;
  currentMessage: string;
  isSendingMessage?: boolean;

  // setters
  setMessages: (updater: (prev: MessageOut[]) => MessageOut[]) => void | ((v: MessageOut[]) => void);
  setCurrentMessage: (v: string) => void;
  setAttachments: (v: File[] | ((prev: File[]) => File[])) => void;
  setIsSendingMessage: (v: boolean) => void;
  setCurrentConversation: (v: ConversationDetail | null) => void;
  setConversations: (updater: (prev: any[]) => any[]) => void;
  toast: (opts: { title: string; description?: string; variant?: string; duration?: number }) => void;

  // helpers from attachments
  isImageFile: (file: File | any) => boolean;
  getImageUrl: (file: File | any) => string;

  // thinking
  setThinkingState: (updater: any) => void;
};

export function createInferenceHandlers(ctx: InferenceCtx) {
  const {
    userId,
    selectedAgent,
    isPrivateMode,
    messages,
    attachments,
    agents,
    currentConversation,
    setMessages,
    setCurrentMessage,
    setAttachments,
    setIsSendingMessage,
    setCurrentConversation,
    setConversations,
    toast,
    isImageFile,
    getImageUrl,
    setThinkingState,
  } = ctx;

  const handleSendMessage = async () => {
    const currentMessage = ctx.currentMessage;

    if (!currentMessage && attachments.length === 0) return;
    if (ctx.isSendingMessage) return;

    if (attachments.length) {
      const sizeErr = validateAttachmentsForUpload(attachments);
      if (sizeErr) {
        toast({ title: 'Attachment too large', description: sizeErr, variant: 'destructive' });
        return;
      }
    }

    setIsSendingMessage(true);
    const currentAgent = agents.find(a => a.id === selectedAgent);

    try {
      if (messages.length === 0) {
        const messageAttachments: FileAttachment[] = attachments.map(file => ({
          file,
          url: isImageFile(file) ? getImageUrl(file) : '',
          name: file.name,
          type: file.type,
        }));

        const apiAttachments = await convertFileAttachments(messageAttachments);

        const conversationPayload: ConversationIn = {
          agentId: selectedAgent,
          isPrivate: isPrivateMode,
          title: undefined,
          firstMessage: {
            sender: 'user',
            type: attachments.length > 0 ? 'file' : 'text',
            content: currentMessage || undefined,
            attachments: apiAttachments,
          },
        };

        const response = await createConversation(userId!, conversationPayload);
        setCurrentConversation(response.detail);
        setMessages(() => response.detail.messages);
        setConversations(prev => [response.summary, ...prev]);
        setCurrentMessage('');
        setAttachments([]);
        setIsSendingMessage(false);
      } else {
        const messageAttachments: FileAttachment[] = attachments.map(file => ({
          file,
          url: isImageFile(file) ? getImageUrl(file) : '',
          name: file.name,
          type: file.type,
        }));

        const apiAttachments = await convertFileAttachments(messageAttachments);

        const messagePayload: MessageIn = {
          sender: 'user',
          type: attachments.length > 0 ? 'file' : 'text',
          content: currentMessage || undefined,
          attachments: apiAttachments,
        };

        const response = await addMessageToConversation(userId!, currentConversation!.id, messagePayload);
        setCurrentConversation(response.detail);
        setMessages(() => response.detail.messages);
        setConversations(prev => prev.map(conv => (conv.id === response.summary.id ? response.summary : conv)));
        setCurrentMessage('');
        setAttachments([]);
        setIsSendingMessage(false);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      toast({ title: 'Error', description: 'Failed to send message. Please try again.', variant: 'destructive' });

      if (messages.length === 0) {
        const conversationId = Date.now().toString();
        const conversation: ConversationDetail = {
          id: conversationId,
          agentId: selectedAgent,
          agentName: currentAgent?.name || '',
          title: '',
          created_at: new Date(),
          updated_at: new Date(),
          messages: [],
          isPrivate: isPrivateMode,
        } as any;
        setCurrentConversation(conversation);
      }

      const messageAttachments: FileAttachment[] = attachments.map(file => ({
        file,
        url: isImageFile(file) ? getImageUrl(file) : '',
        name: file.name,
        type: file.type,
      }));

      const newMessage: MessageOut = {
        id: Date.now().toString(),
        content: currentMessage,
        sender: 'user',
        type: attachments.length > 0 ? 'file' : 'text',
        created_at: new Date(),
        updated_at: new Date(),
        attachments: messageAttachments as any,
      };

      setMessages(prev => [...prev, newMessage]);
      setCurrentMessage('');
      setAttachments([]);
      setIsSendingMessage(false);
    }

    startThinking({ setThinkingState });
  };

  return { handleSendMessage };
}
