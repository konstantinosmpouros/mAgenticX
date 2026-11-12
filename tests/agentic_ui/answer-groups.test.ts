import { describe, expect, it } from "vitest";

import { answerGroupText, groupAnswers } from "@/features/chat/lib/answerGroups";
import type { MessageOut } from "@/shared/lib/types";

/**
 * An orchestrator with background tasks answers in several runs (its reply, then
 * one reply per finished task, each after a hidden task notice). They stay
 * separate messages, but the chat shows one action bar for them, on the last;
 * Try again goes to the first, so the whole answer is regenerated.
 */

const msg = (id: string, sender: "user" | "ai", extra: Partial<MessageOut> = {}): MessageOut =>
  ({ id, sender, content: `text ${id}`, created_at: new Date(0), ...extra }) as MessageOut;
const notice = (id: string) => msg(id, "user", { kind: "task_notification" });

describe("answer groups", () => {
  it("joins the replies a task notice separates into one answer", () => {
    const places = groupAnswers([
      msg("u1", "user"),
      msg("a1", "ai"),
      notice("n1"),
      msg("a2", "ai"),
      notice("n2"),
      msg("a3", "ai"),
    ]);
    expect(places.get("a1")).toMatchObject({ isTail: false });
    expect(places.get("a2")).toMatchObject({ isTail: false });
    expect(places.get("a3")).toMatchObject({ isTail: true });
    const group = places.get("a3")!.group;
    expect(group.head.id).toBe("a1");
    expect(group.members.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    expect(places.has("u1")).toBe(false);
    expect(places.has("n1")).toBe(false);
  });

  it("starts a new answer at every real user message", () => {
    const places = groupAnswers([msg("u1", "user"), msg("a1", "ai"), msg("u2", "user"), msg("a2", "ai")]);
    expect(places.get("a1")).toMatchObject({ isTail: true });
    expect(places.get("a1")!.group.members).toHaveLength(1);
    expect(places.get("a2")!.group.head.id).toBe("a2");
  });

  it("copies every part of the answer, in order, skipping empty ones", () => {
    const places = groupAnswers([
      msg("u1", "user"),
      msg("a1", "ai", { content: "First." }),
      notice("n1"),
      msg("a2", "ai", { content: "  " }),
      notice("n2"),
      msg("a3", "ai", { content: "Last." }),
    ]);
    expect(answerGroupText(places.get("a3")!.group)).toBe("First.\n\nLast.");
  });
});
