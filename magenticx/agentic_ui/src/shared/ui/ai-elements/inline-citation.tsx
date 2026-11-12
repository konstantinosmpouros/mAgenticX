/**
 * Inline citations — ported from Vercel AI Elements' `inline-citation`
 * (https://ai-sdk.dev/elements, shadcn.io/ui/inline-citation) and made ours:
 *
 * - The pill is a link to its (first) page, styled with our Badge variants:
 *   a click or tap opens the page in a new tab. Hovering it (or focusing it
 *   from the keyboard) shows the card — our Radix `HoverCard`, portalled.
 *   Its tap area is a 44px `::after` overlay on touch screens, so the pill
 *   itself stays text-sized inside the line.
 * - The upstream carousel sits on Embla; we have no carousel primitive and a
 *   card shows a handful of sources at most, so this one is a small index with
 *   previous / next buttons — no new dependency.
 * - Links are http(s) only, open in a new tab with
 *   `rel="noopener noreferrer nofollow"`; titles and snippets are plain text.
 * - Semantic tokens only, light and dark; the pill fades in (opacity only,
 *   160ms) and not at all under reduced motion.
 *
 * `SourceCitation` composes the family for a marker's ids, resolved against
 * the conversation's sources (`CitationSourcesContext`).
 */
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";

import { citationHostname, plainSnippet } from "@/shared/lib/citations";
import { useCitationSources } from "@/shared/lib/citations-context";
import { isHttpUrl } from "@/shared/lib/schemas";
import type { CitationSource } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { badgeVariants } from "@/shared/ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/shared/ui/hover-card";
import { SiteIcon } from "@/shared/ui/site-icon";

// A 44px tap target on touch screens, laid over the pill instead of growing it.
const TOUCH_HIT_AREA =
  "relative [@media(hover:none)]:after:absolute [@media(hover:none)]:after:left-1/2 [@media(hover:none)]:after:top-1/2 [@media(hover:none)]:after:h-11 [@media(hover:none)]:after:w-11 [@media(hover:none)]:after:-translate-x-1/2 [@media(hover:none)]:after:-translate-y-1/2 [@media(hover:none)]:after:content-['']";

const HOVER_QUERY = "(hover: hover)";

function useHoverCapable(): boolean {
  const [canHover, setCanHover] = useState(
    () =>
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia(HOVER_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(HOVER_QUERY);
    const update = () => setCanHover(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return canHover;
}

// ------------------------------------------------------
// Inline wrapper + text
// ------------------------------------------------------

export const InlineCitation = ({ className, ...props }: ComponentProps<"span">) => (
  <span
    className={cn(
      "group/citation inline whitespace-nowrap motion-safe:animate-[mx-fade-in_160ms_linear_both]",
      className,
    )}
    {...props}
  />
);

export const InlineCitationText = ({ className, ...props }: ComponentProps<"span">) => (
  <span
    className={cn("rounded-sm transition-colors group-hover/citation:bg-accent", className)}
    {...props}
  />
);

// ------------------------------------------------------
// Card (hover on desktop, tap on touch)
// ------------------------------------------------------

type CardState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  canHover: boolean;
  triggerRef: RefObject<HTMLAnchorElement>;
};

const CardContext = createContext<CardState | null>(null);

export const InlineCitationCard = ({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: ComponentProps<typeof HoverCard>) => {
  const canHover = useHoverCapable();
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openProp],
  );
  const state = useMemo(
    () => ({ open, setOpen, canHover, triggerRef }),
    [canHover, open, setOpen],
  );
  return (
    <CardContext.Provider value={state}>
      <HoverCard
        openDelay={canHover ? 150 : 0}
        closeDelay={120}
        open={open}
        onOpenChange={setOpen}
        {...props}
      >
        {children}
      </HoverCard>
    </CardContext.Provider>
  );
};

type InlineCitationCardTriggerProps = ComponentProps<"a"> & {
  /** The cited URLs; the pill names the first one's site, "+N" the rest. */
  sources: string[];
};

/** The pill: a link to its first page (a click opens it), whose hover shows the card. */
export const InlineCitationCardTrigger = ({
  sources,
  className,
  onClick,
  ...props
}: InlineCitationCardTriggerProps) => {
  const card = useContext(CardContext);
  const hosts = sources.map(citationHostname).filter(Boolean);
  const first = hosts[0] ?? "source";
  const more = sources.length - 1;
  const href = sources.find(isHttpUrl);
  // The page opens in a new tab: close the card and let go of focus, or the
  // focused pill would keep it open over the text until something else is hovered.
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    card?.setOpen(false);
    event.currentTarget.blur();
  };

  return (
    <HoverCardTrigger asChild>
      <a
        ref={card?.triggerRef}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        aria-label={`Open ${first}${more > 0 ? ` (and ${more} more source${more > 1 ? "s" : ""})` : ""}`}
        className={cn(
          badgeVariants({ variant: "secondary" }),
          TOUCH_HIT_AREA,
          "ml-1 cursor-pointer gap-1 px-1.5 py-0 align-baseline text-[0.7rem] font-medium leading-5",
          // A link inside the answer's markdown: not the answer's link colour or
          // underline — the pill keeps the badge's own text colour in every state.
          "!text-secondary-foreground !no-underline hover:!no-underline visited:!text-secondary-foreground",
          "hover:bg-accent data-[state=open]:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        onClick={handleClick}
        {...props}
      >
        {sources[0] ? <SiteIcon site={sources[0]} size={14} /> : null}
        <span className="max-w-[12rem] truncate">{first}</span>
        {more > 0 ? <span className="text-muted-foreground">+{more}</span> : null}
      </a>
    </HoverCardTrigger>
  );
};

export const InlineCitationCardBody = ({
  className,
  onPointerDownOutside,
  ...props
}: ComponentProps<typeof HoverCardContent>) => {
  const card = useContext(CardContext);
  return (
    <HoverCardContent
      className={cn("relative w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0 shadow-lg", className)}
      // A tap on the pill while the card is open is the pill's own toggle, not
      // an outside press — without this the card would close and reopen.
      onPointerDownOutside={(event) => {
        onPointerDownOutside?.(event);
        const target = event.target as Node | null;
        if (target && card?.triggerRef.current?.contains(target)) event.preventDefault();
      }}
      {...props}
    />
  );
};

// ------------------------------------------------------
// Carousel (one source at a time)
// ------------------------------------------------------

type CarouselState = { index: number; count: number; setIndex: (index: number) => void };

const CarouselContext = createContext<CarouselState>({ index: 0, count: 0, setIndex: () => {} });

export const InlineCitationCarousel = ({
  count,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { count: number }) => {
  const [index, setIndexState] = useState(0);
  const safeIndex = Math.min(index, Math.max(count - 1, 0));
  const setIndex = useCallback(
    (next: number) => setIndexState(Math.max(0, Math.min(next, count - 1))),
    [count],
  );
  const state = useMemo(
    () => ({ index: safeIndex, count, setIndex }),
    [count, safeIndex, setIndex],
  );
  return (
    <CarouselContext.Provider value={state}>
      <div
        role="group"
        aria-roledescription="carousel"
        className={cn("w-full", className)}
        {...props}
      >
        {children}
      </div>
    </CarouselContext.Provider>
  );
};

/** Shows the carousel's current item only. */
export const InlineCitationCarouselContent = ({ children }: { children: ReactNode }) => {
  const { index } = useContext(CarouselContext);
  return <>{Children.toArray(children)[index] ?? null}</>;
};

export const InlineCitationCarouselItem = ({ className, ...props }: ComponentProps<"div">) => {
  const { index, count } = useContext(CarouselContext);
  return (
    <div
      role="group"
      aria-roledescription="slide"
      aria-label={count > 1 ? `${index + 1} of ${count}` : undefined}
      className={cn("w-full space-y-2 p-4", className)}
      {...props}
    />
  );
};

export const InlineCitationCarouselHeader = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "flex items-center justify-between gap-1 rounded-t-md border-b border-border/60 bg-secondary px-1 py-0.5",
      className,
    )}
    {...props}
  />
);

export const InlineCitationCarouselIndex = ({
  className,
  children,
  ...props
}: ComponentProps<"div">) => {
  const { index, count } = useContext(CarouselContext);
  return (
    <div
      aria-live="polite"
      className={cn(
        "flex flex-1 items-center justify-end px-3 py-1 text-xs tabular-nums text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children ?? `${count ? index + 1 : 0}/${count}`}
    </div>
  );
};

const CAROUSEL_BUTTON = cn(
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
  "hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "[@media(hover:none)]:h-11 [@media(hover:none)]:w-11",
);

export const InlineCitationCarouselPrev = ({ className, ...props }: ComponentProps<"button">) => {
  const { index, setIndex } = useContext(CarouselContext);
  return (
    <button
      type="button"
      aria-label="Previous source"
      disabled={index <= 0}
      className={cn(CAROUSEL_BUTTON, className)}
      onClick={() => setIndex(index - 1)}
      {...props}
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
    </button>
  );
};

export const InlineCitationCarouselNext = ({ className, ...props }: ComponentProps<"button">) => {
  const { index, count, setIndex } = useContext(CarouselContext);
  return (
    <button
      type="button"
      aria-label="Next source"
      disabled={index >= count - 1}
      className={cn(CAROUSEL_BUTTON, className)}
      onClick={() => setIndex(index + 1)}
      {...props}
    >
      <ArrowRight className="size-4" aria-hidden="true" />
    </button>
  );
};

// ------------------------------------------------------
// One source
// ------------------------------------------------------

type InlineCitationSourceProps = ComponentProps<"div"> & {
  title?: string;
  url?: string;
  description?: string;
};

export const InlineCitationSource = ({
  title,
  url,
  description,
  className,
  children,
  ...props
}: InlineCitationSourceProps) => {
  const safeUrl = url && isHttpUrl(url) ? url : null;
  const host = safeUrl ? citationHostname(safeUrl) : "";
  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      {host ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <SiteIcon site={safeUrl ?? host} size={16} />
          <span className="truncate font-medium">{host}</span>
        </div>
      ) : null}
      {title && safeUrl ? (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="group/title flex items-start gap-1 rounded-sm text-sm font-semibold leading-snug text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="line-clamp-2 underline-offset-2 group-hover/title:underline">{title}</span>
          <ArrowUpRight
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover/title:text-foreground"
            aria-hidden
          />
        </a>
      ) : title ? (
        <h4 className="line-clamp-2 text-sm font-semibold leading-snug">{title}</h4>
      ) : null}
      {description ? (
        <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </div>
  );
};

/** A source's excerpt: plain, quiet text under its title. */
export const InlineCitationQuote = ({ children, className, ...props }: ComponentProps<"p">) => (
  <p className={cn("line-clamp-4 text-xs leading-relaxed text-muted-foreground", className)} {...props}>
    {children}
  </p>
);

// ------------------------------------------------------
// A marker's pill, resolved against the conversation's sources
// ------------------------------------------------------

/**
 * The pill for one `[src:…]` marker. Ids the conversation has no source for
 * are dropped; with none left it renders nothing — a citation is shown only
 * for a source a tool really returned.
 */
export const SourceCitation = ({ ids }: { ids: readonly string[] }) => {
  const registry = useCitationSources();
  const sources = useMemo(
    () =>
      ids
        .map((id) => registry.get(id))
        .filter((source): source is CitationSource => Boolean(source && isHttpUrl(source.url))),
    [ids, registry],
  );
  if (!sources.length) return null;
  return (
    <InlineCitation data-testid="inline-citation">
      <InlineCitationCard>
        <InlineCitationCardTrigger sources={sources.map((source) => source.url)} />
        <InlineCitationCardBody>
          <InlineCitationCarousel count={sources.length}>
            {sources.length > 1 ? (
              <InlineCitationCarouselHeader>
                <InlineCitationCarouselPrev />
                <InlineCitationCarouselIndex />
                <InlineCitationCarouselNext />
              </InlineCitationCarouselHeader>
            ) : null}
            <InlineCitationCarouselContent>
              {sources.map((source) => (
                <InlineCitationCarouselItem key={source.id}>
                  <InlineCitationSource
                    title={source.title || citationHostname(source.url)}
                    url={source.url}
                    description={plainSnippet(source.snippet) || undefined}
                  />
                </InlineCitationCarouselItem>
              ))}
            </InlineCitationCarouselContent>
          </InlineCitationCarousel>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  );
};

/** What a markdown renderer maps the `mx-citation` element to. */
export const CitationElement = (props: { "data-ids"?: unknown }) => {
  const raw = typeof props["data-ids"] === "string" ? props["data-ids"] : "";
  const ids = useMemo(() => raw.split(",").filter(Boolean), [raw]);
  return <SourceCitation ids={ids} />;
};
