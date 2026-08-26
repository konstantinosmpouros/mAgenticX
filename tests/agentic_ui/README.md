# Agentic UI Tests

Repository-level frontend tests. Two suites live here, in two languages, because
they answer two different questions.

## `test_static_contracts.py` — pytest

Static assertions about the frontend↔bridge contract, made by reading the source
as text: route prefixes, CSRF on every mutating call, the attachment-preview
registry, upload MIME inference, and that the wire transformers still read the
snake_case aliases the bridge emits. These catch drift that type-checking cannot,
because the other side of the contract is a Python service.

```bash
python -m pytest tests/agentic_ui -q          # from the repo root
```

Two conventions keep these from breaking on unrelated changes:

- `read_module_source(SHARED_LIB, name)` reads a module whether it is a single
  file or a folder behind a barrel — `api`, `types` and `consts` are all folders.
- Assertions never pin a quote character. The source is Prettier-formatted, and a
  reformat must not be able to fail a contract test.

## `*.test.ts` — Vitest

Behavioural tests for the logic with the most invariants and the least visibility:
the run-timeline reducer, the wire→app transforms, and session/consent storage.

```bash
cd src/agentic_ui
npm run test            # once
npm run test:watch      # watch mode
npm run test:coverage    # v8 coverage, scoped to the modules under test
```

Config is `src/agentic_ui/vitest.config.ts` — deliberately separate from
`vite.config.ts` so the app build never loads the test toolchain. It points
`include` and `setupFiles` back at this folder and re-declares the `@/` alias,
which is what lets a test two directories up import `@/features/...`.

These files are also inside `tsconfig.app.json`'s `include`, so `npm run typecheck`
covers them. That is load-bearing for at least one test: `session.test.ts` asserts
that `isSessionValid` *narrows* its argument, which is a compile-time claim — it
would still pass at runtime if the predicate regressed to a plain `boolean`.

### Component tests

Not present yet, and the jsdom + React Testing Library packages are deliberately
not installed — nothing imports them. They land with the ChatPage / workspace-bundle
restructure, which is the work that actually needs them. `setup.ts` documents the
four steps to turn them on. Note jsdom requires Node >= 22 (on Node 20 it fails at
import with `ERR_REQUIRE_ESM` from its CSS parser); CI and the Docker image are on 22.
