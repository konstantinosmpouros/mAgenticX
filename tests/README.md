# Tests

This repository keeps tests in an outer-layer `tests/` tree, grouped by service.

Current structure:

- `tests/dialogue_bridge`
- `tests/rag_service`
- `tests/agents`
- `tests/mcp_gateway`
- `tests/agentic_ui`
- `tests/integration`

Why this layout:

- keeps service folders focused on runtime code
- gives one obvious place for all test code
- still preserves separation by service

## Setup

Install the Python test dependencies with:

```bash
python -m pip install -r tests/requirements.txt
python -m pip install -r src/dialogue_bridge/requirements.txt
python -m pip install -r src/rag_service/requirements.txt
python -m pip install -r src/agents/requirements.txt
```

## Run

Run all tests:

```bash
python -m pytest
```

Run only the dialogue bridge tests:

```bash
python -m pytest tests/dialogue_bridge -q
```

Run only the RAG service tests:

```bash
python -m pytest tests/rag_service -q
```

Run only the agents service tests:

```bash
python -m pytest tests/agents -q
```

Run only backend integration flows:

```bash
python -m pytest tests/integration -q
```

Run a single test file:

```bash
python -m pytest tests/dialogue_bridge/test_conversations.py -q
```

## Notes

- `pytest.ini` stays at the repository root because it is project-level test runner configuration.
- The current `dialogue_bridge` tests use an isolated async SQLite database and dependency overrides for auth/CSRF so they can validate API behavior without booting the full production stack.
- `tests/rag_service` and `tests/agents` use service-specific import isolation so all suites can run in one pytest process without `main` / `schemas` / `utils` module collisions.
- `tests/integration` covers multi-route backend flows using deterministic service doubles. Browser-level E2E tests should live under `tests/agentic_ui/e2e` when a browser runner is added.
- Frontend coverage currently includes static contract tests for the Vite app/API layer plus normal `npm run lint` / `npm run build` checks.
