import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

/**
 * Vitest config, kept separate from vite.config.ts rather than living under its
 * `test` key so the app build never loads the test toolchain — `vite build`
 * stays exactly what it was.
 *
 * Tests live in the repo-level `tests/agentic_ui/` folder, next to the Python
 * static-contract tests, NOT beside the source they exercise. That is why the
 * `include` and `setupFiles` paths reach outside this package, and why the `@`
 * alias below is required: without it `@/features/...` would not resolve from a
 * test file two directories up.
 */
// Forward slashes on purpose: `include` is a glob, and on Windows a path built
// with path.join() yields backslashes, which the glob matcher treats as escapes
// and silently matches nothing ("No test files found").
const TESTS_DIR = path.resolve(__dirname, "../../tests/agentic_ui").replace(/\\/g, "/");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // `node`: the suite is pure logic and needs no DOM, so it runs fast and on
    // any Node version. Component tests (and the jsdom + RTL packages they
    // need) are deliberately deferred — see tests/agentic_ui/setup.ts.
    environment: "node",
    globals: true,
    root: __dirname,
    setupFiles: [`${TESTS_DIR}/setup.ts`],
    include: [`${TESTS_DIR}/**/*.{test,spec}.{ts,tsx}`],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Scoped to the logic these tests actually target. A repo-wide threshold
      // on a codebase with no prior tests would be either meaningless or
      // red on day one; this keeps the number honest.
      include: [
        "src/features/inference/timeline.ts",
        "src/shared/lib/consts/transforms/**",
        "src/shared/lib/authStorage.ts",
      ],
    },
  },
});
