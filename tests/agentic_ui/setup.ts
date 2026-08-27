// `toBeInTheDocument` and friends. A static import because the module is a
// global type augmentation, which cannot be `await import()`-ed; it only
// registers matchers on `expect`, so it is harmless under the node env too.
import "@testing-library/jest-dom/vitest";

/**
 * Vitest setup, shared by every JS test in this folder.
 *
 * Runs under BOTH environments: the default `node` (pure-logic tests: reducers,
 * wire transforms, storage) and `happy-dom` (component tests, opted into per
 * file with `// @vitest-environment happy-dom` on line 1). Everything
 * DOM-related is therefore guarded on `window` existing — without the guard the
 * node-environment tests fail at import before a single assertion runs.
 *
 * happy-dom rather than jsdom: jsdom's CSS parser does `require()` of an ES
 * module, which needs Node >= 22, and this repo is developed on Node 20.
 */
const hasDom = typeof window !== "undefined";

if (hasDom) {
  // Not implemented by happy-dom, and the shell touches both on mount.
  // Stubbing centrally keeps the failure legible: a missing browser API is one
  // entry here, not a mystery "not a function" inside an unrelated assertion.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}
