import type { ClientAction } from "@/features/chat/lib/slashCommands";
import type { ContextCompactionControl } from "@/shared/lib/types";

type CommandActionsCtx = {
  conversationId: string | null;
  compaction: ContextCompactionControl | null;
  handleNewChat: () => void;
  openProfilePanel: (tab?: string) => void;
  /** The current agent's page, on its Memory section (the agents gallery without one). */
  openAgentMemory: () => void;
  handleRenameConversation: (conversationId: string, newTitle: string) => void | Promise<void>;
  openFullConversationShareDialog: () => void;
  exportConversationPdf: () => void | Promise<void>;
  notify: (title: string, description?: string) => void;
};

/**
 * The slash-command actions (plan 35): each one calls what its button calls, so
 * a command and a button can never behave differently — `/compact` runs the
 * ring's compaction with the ring's guards, `/share` opens the same dialog.
 *
 * Returns `runAction(name, text)`; `text` is what followed the command
 * (`/rename Quarterly plan`). A name outside {@link ClientAction} is ignored —
 * the menu never offers one.
 */
export function createCommandActions(ctx: CommandActionsCtx) {
  const actions: Record<ClientAction, (text: string) => void> = {
    compact: () => {
      const compaction = ctx.compaction;
      if (!compaction) {
        ctx.notify("Nothing to compact yet", "Start a conversation first.");
      } else if (compaction.disabledReason) {
        ctx.notify("Can't compact right now", compaction.disabledReason);
      } else {
        compaction.compact();
      }
    },
    new: () => ctx.handleNewChat(),
    memories: () => ctx.openAgentMemory(),
    skills: () => ctx.openProfilePanel("skills"),
    usage: () => ctx.openProfilePanel("usage"),
    share: () => ctx.openFullConversationShareDialog(),
    export: () => void ctx.exportConversationPdf(),
    rename: (text) => {
      const id = ctx.conversationId;
      if (!id || id.startsWith("shared:")) {
        ctx.notify("Nothing to rename yet", "Open one of your conversations first.");
      } else if (!text) {
        ctx.notify("Type the new title after /rename");
      } else {
        void ctx.handleRenameConversation(id, text);
      }
    },
  };

  return (name: string, text: string) => {
    const action = (actions as Record<string, ((text: string) => void) | undefined>)[name];
    action?.(text);
  };
}
