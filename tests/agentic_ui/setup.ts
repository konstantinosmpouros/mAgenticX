/**
 * Vitest setup, shared by every JS test in this folder.
 *
 * Intentionally near-empty. The suite is pure logic — reducers, wire transforms,
 * session storage — so it runs in the `node` environment with no DOM and no
 * browser-API stubs to maintain.
 *
 * When component tests arrive (they land with the ChatPage/workspace-bundle
 * restructure, which is what actually needs them), this is where the jsdom
 * scaffolding goes:
 *   1. `npm i -D jsdom @testing-library/react @testing-library/jest-dom`
 *   2. add `import "@testing-library/jest-dom/vitest";` as a STATIC import here
 *      (it is a global type augmentation and cannot be `await import()`-ed)
 *   3. stub `window.matchMedia` and `ResizeObserver`, which jsdom lacks and the
 *      shell touches on mount
 *   4. opt individual files in with `// @vitest-environment jsdom` on line 1
 *
 * Those packages are deliberately NOT installed yet: nothing imports them, and
 * jsdom additionally requires Node >= 22 (on Node 20 it fails at import with
 * ERR_REQUIRE_ESM from its CSS parser).
 */
export {};
