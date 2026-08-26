# Agents Tests

This folder holds tests for the `agents` backend.

## The `agents_service` fixture

Every test that needs the service asks for `agents_service`, which returns a
`SimpleNamespace` of the service's already-imported modules (`main`, the
routers, `utils.*`, `runtime.*`, `core.settings`, …). Patch endpoint
dependencies on the **router** module that looks them up, not on `main`.

Two things about it are worth knowing before you add a test:

**The service is imported once per session, not once per test.** Importing it
costs ~1s — `main` pulls in langchain/langgraph/deepagents, and `utils.agents`
runs the full agent discovery at import time (`AGENT_REGISTRY =
_build_registry()`). Paying that per test made this suite take ~7 minutes to run
a few hundred millisecond-long assertions; it now runs in ~6s.

**Because the modules are shared, isolation is explicit.** The old per-test
reload silently reset any global a test scribbled on. `agents_service` now does
that on purpose, around every test:

- the whole `settings` tree is snapshotted and restored in place, so writing
  `settings.filesystem.workspaces_root = tmp_path` (as `skills_fs` and the
  retention helper do) cannot leak into the next test;
- the service's process-global caches are cleared — the module-level ones listed
  in `_DICT_CACHES` / `_SINGLETON_CACHES` in `conftest.py`, plus every
  `functools.lru_cache` in the service, which are found automatically.

So: **if you add a new module-level cache to the service, add it to one of those
two tuples.** `lru_cache`-based ones need nothing. Prefer `monkeypatch` for
patching anyway — it is undone for you and needs no registration.

The suite is order-independent; it is checked under shuffled orderings. If you
introduce a test that only passes in file order, that is a bug in the test.
