// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { faviconUrl } from "@/shared/lib/api";
import { CitationSourcesContext } from "@/shared/lib/citations-context";
import { resetSiteIconFailures, siteHost } from "@/shared/lib/siteIcons";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";
import { SourceCitation } from "@/shared/ui/ai-elements/inline-citation";
import { SiteIcon } from "@/shared/ui/site-icon";

/**
 * A source's site icon comes from our own origin only, and falls back to the
 * site's initial when there is no signed-in user or the icon fails (plan 42).
 */

const signIn = (userId: string | null) =>
  useWorkspaceStore.setState({ userId, isLoggedIn: Boolean(userId), pendingDeletion: null });

beforeEach(() => {
  resetSiteIconFailures();
  signIn("u1");
});

afterEach(() => signIn(null));

describe("SiteIcon", () => {
  it("asks our own origin for the icon, never the site or a third party", () => {
    const { container } = render(<SiteIcon site="https://www.Example.com/a/b?q=1" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const src = img!.getAttribute("src") ?? "";
    expect(src).toBe("/api/v1/favicons/u1?host=example.com");
    expect(src.startsWith("/api/v1/")).toBe(true);
    expect(src).not.toMatch(/^[a-z]+:\/\//i);
    expect(img!.getAttribute("alt")).toBe("");
    expect(img!.getAttribute("loading")).toBe("lazy");
    expect(img!.getAttribute("decoding")).toBe("async");
    expect(img!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("shows the site's initial when no user is signed in (a public share page)", () => {
    signIn(null);
    const { container } = render(<SiteIcon site="https://news.example.com/x" />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("site-icon-fallback").getAttribute("data-initial")).toBe("N");
  });

  it("falls back on a load error and does not ask for that host again", () => {
    const { container, unmount } = render(<SiteIcon site="https://broken.example.org" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("site-icon-fallback").getAttribute("data-initial")).toBe("B");
    unmount();
    const again = render(<SiteIcon site="broken.example.org" />);
    expect(again.container.querySelector("img")).toBeNull();
    // Another host still loads.
    const other = render(<SiteIcon site="fine.example.org" />);
    expect(other.container.querySelector("img")).not.toBeNull();
  });

  it("never builds an icon URL from anything but a hostname", () => {
    expect(siteHost("javascript:alert(1)")).toBe("");
    expect(siteHost("https://evil.com/?host=x")).toBe("evil.com");
    expect(siteHost("not a host")).toBe("");
    const { container } = render(<SiteIcon site="javascript:alert(1)" />);
    expect(container.querySelector("img")).toBeNull();
    expect(faviconUrl("u 1", "a.com")).toBe("/api/v1/favicons/u%201?host=a.com");
  });
});

describe("SiteIcon in citations", () => {
  it("sits in the citation pill and the card's source row", () => {
    const source = {
      id: "aaa111",
      url: "https://www.aaa111.example.com/x",
      title: "Page",
      snippet: "",
      tool: "web_search",
    };
    render(
      <CitationSourcesContext.Provider value={new Map([[source.id, source]])}>
        <SourceCitation ids={[source.id]} />
      </CitationSourcesContext.Provider>,
    );
    const pill = screen.getByRole("link", { name: /^Open / });
    expect(pill.querySelector("img")?.getAttribute("src")).toBe(
      "/api/v1/favicons/u1?host=aaa111.example.com",
    );
    vi.useFakeTimers();
    fireEvent.focus(pill);
    act(() => vi.advanceTimersByTime(300));
    vi.useRealTimers();
    const card = document.querySelector('[aria-roledescription="slide"]')!;
    expect(card.querySelector("img")).not.toBeNull();
    expect(card.textContent).toContain("aaa111.example.com");
  });
});
