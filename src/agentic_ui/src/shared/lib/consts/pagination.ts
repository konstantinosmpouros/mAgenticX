/**
 * Conversation-list paging.
 *
 * The sidebar fetches a large first page so the rail is populated on open —
 * scrolling for the second screenful immediately is the common case, and one
 * request is cheaper than four. After that it pages in small increments, which
 * keeps the infinite-scroll appends light.
 *
 * The two sizes have to divide evenly, and that is not cosmetic. The bridge
 * paginates by `offset = (page - 1) * size`, so a 40-item first page covers the
 * same rows as pages 1–4 at size 10. Resuming at page 2 with size 10 would
 * re-request rows 10–19 — items the rail already has — and the second screenful
 * would silently be a repeat of the first. `CONV_FIRST_PAGE_INDEX` is that
 * conversion, and it is why the first "next page" is 5.
 */
export const CONV_INITIAL_PAGE_SIZE = 40;
export const CONV_PAGE_SIZE = 10;

/**
 * The page number the initial fetch is equivalent to, expressed in `CONV_PAGE_SIZE`
 * units — the cursor `loadMore` continues from.
 */
export const CONV_FIRST_PAGE_INDEX = CONV_INITIAL_PAGE_SIZE / CONV_PAGE_SIZE;
