// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Edit profile — the display name and the photo.
 *
 * Pinned: Save stays off until the name really changes (whitespace alone is not
 * a change); saving sends the normalized name and puts the saved profile in the
 * store; a blank name and "Use my Microsoft name" both send null; the reset is
 * offered only when the user has a name of their own. A picked photo is
 * uploaded unless it is the wrong type or too large; "Remove photo" appears
 * only for a photo of the user's own; the profile's avatar URL is built at the
 * edge from avatarUpdatedAt (versioned) and wins over a provider URL.
 */
vi.mock("@/shared/lib/api", () => ({ updateProfileName: vi.fn(), uploadAvatar: vi.fn(), removeAvatar: vi.fn() }));

import { removeAvatar, updateProfileName, uploadAvatar } from "@/shared/lib/api";
import { normalizeUserProfile } from "@/shared/lib/utils";
import EditProfileDialog from "@/features/settings/components/EditProfileDialog";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import type { UserProfile } from "@/shared/lib/types";

const user = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  id: "u1",
  username: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const nameInput = () => screen.getByLabelText("Display name") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Save" });

describe("EditProfileDialog", () => {
  beforeEach(() => {
    vi.mocked(updateProfileName).mockReset();
    vi.mocked(uploadAvatar).mockReset();
    vi.mocked(removeAvatar).mockReset();
    useWorkspaceStore.getState().setUserProfile(null);
  });

  it("enables Save only for a real change and saves the normalized name", async () => {
    const saved = user({ displayName: "Alice Liddell", preferredName: "Alice Liddell" });
    vi.mocked(updateProfileName).mockResolvedValue(saved);
    const onClose = vi.fn();
    render(<EditProfileDialog open onClose={onClose} user={user()} />);

    expect(nameInput().value).toBe("Alice");
    expect(saveButton()).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: "  Alice  " } });
    expect(saveButton()).toBeDisabled();

    fireEvent.change(nameInput(), { target: { value: "  Alice   Liddell " } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateProfileName).toHaveBeenCalledWith("u1", "Alice Liddell");
    expect(useWorkspaceStore.getState().userProfile).toEqual(saved);
  });

  it("sends null for a blank name — back to Microsoft's", async () => {
    vi.mocked(updateProfileName).mockResolvedValue(user());
    render(<EditProfileDialog open onClose={vi.fn()} user={user({ displayName: "Mine", preferredName: "Mine" })} />);

    fireEvent.change(nameInput(), { target: { value: "   " } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(updateProfileName).toHaveBeenCalledWith("u1", null));
  });

  it("offers the Microsoft name only when the user has their own", async () => {
    vi.mocked(updateProfileName).mockResolvedValue(user());
    const { rerender } = render(<EditProfileDialog open onClose={vi.fn()} user={user()} />);
    expect(screen.queryByRole("button", { name: "Use my Microsoft name" })).toBeNull();

    rerender(<EditProfileDialog open onClose={vi.fn()} user={user({ displayName: "Mine", preferredName: "Mine" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Use my Microsoft name" }));
    await waitFor(() => expect(updateProfileName).toHaveBeenCalledWith("u1", null));
  });

  const pick = (file: File) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  };

  it("uploads a picked photo and stores the saved profile", async () => {
    const saved = user({ hasOwnAvatar: true, avatarUrl: "/api/v1/account/u1/avatar?v=1" });
    vi.mocked(uploadAvatar).mockResolvedValue(saved);
    render(<EditProfileDialog open onClose={vi.fn()} user={user()} />);

    const photo = new File([new Uint8Array(10)], "me.png", { type: "image/png" });
    pick(photo);

    await waitFor(() => expect(uploadAvatar).toHaveBeenCalledWith("u1", photo));
    await waitFor(() => expect(useWorkspaceStore.getState().userProfile).toEqual(saved));
  });

  it("refuses the wrong type or an oversized photo without uploading", async () => {
    render(<EditProfileDialog open onClose={vi.fn()} user={user()} />);
    pick(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    pick(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it("offers Remove photo only for a photo of the user's own", async () => {
    vi.mocked(removeAvatar).mockResolvedValue(user());
    const { rerender } = render(<EditProfileDialog open onClose={vi.fn()} user={user()} />);
    expect(screen.queryByRole("button", { name: "Remove photo" })).toBeNull();

    rerender(<EditProfileDialog open onClose={vi.fn()} user={user({ hasOwnAvatar: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    await waitFor(() => expect(removeAvatar).toHaveBeenCalledWith("u1"));
  });
});

describe("normalizeUserProfile", () => {
  it("builds a versioned avatar URL that wins over a provider's", () => {
    const at = "2026-10-10T09:00:00Z";
    const profile = normalizeUserProfile({ id: "u 1", avatarUrl: "https://idp/pic.png", avatarUpdatedAt: at });
    expect(profile.avatarUrl).toBe(`/api/v1/account/u%201/avatar?v=${Date.parse(at)}`);
    expect(profile.hasOwnAvatar).toBe(true);

    const none = normalizeUserProfile({ id: "u1", avatarUrl: "https://idp/pic.png", avatarUpdatedAt: null });
    expect(none.avatarUrl).toBe("https://idp/pic.png");
    expect(none.hasOwnAvatar).toBe(false);
  });
});
