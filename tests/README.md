# Test Suite

The root `tests/` folder keeps all automated coverage organized by execution layer:

- `tests/backend/`: Django, ingestion, access, and catalog tests executed with `pytest`
- `tests/pytest.ini`: shared pytest configuration for backend runs inside and outside Docker
- `tests/frontend/unit/`: frontend unit coverage executed with `node --test`
- `tests/frontend/e2e/`: Playwright browser stories executed against the real Dockerized local application
- `tests/frontend/playwright.config.js`: shared Playwright config and live auth/bootstrap setup
- `tests/TEST_MATRIX.md`: feature coverage map for backend and browser scenarios

All repo-facing helpers under `tests/scripts/` support `-h` or `--help` for usage details. Use `--` before passthrough flags when you want to forward options such as `-k` or `--workers` to the underlying test runner.

## Script Guide

`tests/scripts/seed-e2e-data.sh`

- Starts the local Docker stack if needed.
- Waits for the backend to become reachable.
- Seeds deterministic browser and access-management data inside the backend container.

`tests/scripts/test-backend.sh`

- Starts the local Docker stack if needed.
- Waits for the backend to become reachable.
- Runs backend `pytest` inside the backend container.
- Accepts optional pytest paths or flags.

`tests/scripts/test-frontend-unit.sh`

- Runs the frontend unit tests locally from `app/frontend`.
- Does not start Docker services because these tests do not need the live stack.
- Accepts optional Node test runner flags.

`tests/scripts/test-e2e.sh`

- Starts the local Docker stack if needed.
- Waits for both frontend and backend to become reachable.
- Reseeds deterministic live E2E data through `tests/scripts/seed-e2e-data.sh`.
- Runs the Playwright browser suite against the live application.
- Accepts optional Playwright spec paths or flags.

`tests/scripts/verify.sh`

- Starts or refreshes the local Docker stack.
- Waits for frontend and backend readiness.
- Reseeds deterministic live E2E data.
- Runs backend tests, frontend unit tests, the frontend production build, and the live Playwright suite.
- Accepts `--repeat N` to execute the full verification flow multiple times.

`tests/scripts/test-all.sh`

- Convenience wrapper around `tests/scripts/verify.sh`.
- Accepts the same arguments as `verify.sh`.

## Common Runs

For full-stack verification, run:

```bash
tests/scripts/verify.sh
```

This flow uses the live local Docker stack, not mocked services or SQLite.

Run the suites separately when you want narrower feedback:

```bash
tests/scripts/seed-e2e-data.sh
tests/scripts/test-backend.sh
tests/scripts/test-frontend-unit.sh
tests/scripts/test-e2e.sh
```

Run the same full verifier through the convenience wrapper:

```bash
tests/scripts/test-all.sh
```

For additional confidence on stateful flows, repeat the verifier:

```bash
tests/scripts/verify.sh --repeat 3
```
