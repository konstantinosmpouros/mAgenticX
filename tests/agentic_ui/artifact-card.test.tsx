// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ArtifactCard } from "@/features/chat/components/message_parts/ArtifactCard";
import type { ArtifactBlock, MessageOut } from "@/shared/lib/types";

/**
 * A presented file in the run timeline: an image shows as the image itself
 * (fetched through `onLoad`), anything else — or an image that can't be
 * fetched — as the generated-document card.
 */
const message = (name: string, mime: string) =>
  ({
    id: "m1",
    attachments: [{ id: "a1", name, mime, blobId: "b1", origin: "generated", presented: true }],
  }) as unknown as MessageOut;

const block = (filename: string, mime: string) =>
  ({ type: "artifact", filename, mime, title: "Flipped photo", summary: "Mirrored." }) as unknown as ArtifactBlock;

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:flipped");
  URL.revokeObjectURL = vi.fn();
});

describe("artifact card", () => {
  it("shows a presented image in the chat, with a download button", async () => {
    const onLoad = vi.fn(async () => new Blob(["x"], { type: "image/jpeg" }));
    render(
      <ArtifactCard
        block={block("flipped.jpg", "image/jpeg")}
        message={message("flipped.jpg", "image/jpeg")}
        onLoad={onLoad}
        onDownload={vi.fn()}
      />,
    );
    const img = await screen.findByRole("img", { name: "Mirrored." });
    expect(img).toHaveAttribute("src", "blob:flipped");
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Download Flipped photo" })).toBeInTheDocument();
    expect(screen.queryByText("Generated document")).not.toBeInTheDocument();

    // A click opens it larger, in the shared lightbox.
    fireEvent.click(screen.getByRole("button", { name: "View Flipped photo larger" }));
    expect(await screen.findByRole("button", { name: "Close image preview" })).toBeInTheDocument();
  });

  it("keeps the card for a document, and for an image that can't be loaded", async () => {
    const { unmount } = render(
      <ArtifactCard
        block={block("report.pdf", "application/pdf")}
        message={message("report.pdf", "application/pdf")}
        onLoad={vi.fn()}
      />,
    );
    expect(screen.getByText("Generated document")).toBeInTheDocument();
    unmount();

    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    render(
      <ArtifactCard block={block("x.png", "image/png")} message={message("x.png", "image/png")} onLoad={failing} />,
    );
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(screen.getByText("Generated document")).toBeInTheDocument();
  });
});
