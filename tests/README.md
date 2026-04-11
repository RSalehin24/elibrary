# Test Suite

The root `tests/` folder keeps all automated coverage organized by execution layer:

- `tests/backend/`: Django, ingestion, access, and catalog tests executed with `pytest`
- `tests/pytest.ini`: shared pytest configuration for backend runs inside and outside Docker
- `tests/frontend/unit/`: frontend unit coverage executed with `node --test`
- `tests/frontend/e2e/`: Playwright browser stories executed against the real Dockerized local application
- `tests/frontend/playwright.config.js`: shared Playwright config and live auth/bootstrap setup

All repo-facing helpers under `tests/scripts/` support `-h` or `--help` for usage details. Use `--` before passthrough flags when you want to forward options such as `-k` or `--workers` to the underlying test runner.

## Coverage Map

### Backend Coverage

| Feature Area | Coverage Layer | Main Location |
| --- | --- | --- |
| Authentication and session behavior | `pytest` | `tests/backend/auth/` |
| Access grants, reader access, and permission logic | `pytest` | `tests/backend/access/` |
| Catalog metadata and manual-book workflows | `pytest` | `tests/backend/catalog_management/` |
| Ingestion pipeline, curation, queue logic, processing activity summaries, and processing-state regressions | `pytest` | `tests/backend/ingestion/` |
| Shared/common behavior and legacy pipeline compatibility | `pytest` | `tests/backend/test_common.py`, `tests/backend/test_legacy_pipeline.py` |

### Frontend Unit Coverage

| Feature Area | Coverage Layer | Main Location |
| --- | --- | --- |
| Processing activity payload normalization and polling rules | `node --test` | `tests/frontend/unit/activityTracker.test.js` |
| Request text formatting and job-filter helpers | `node --test` | `tests/frontend/unit/requestHelpers.test.js` |

### Live Browser Coverage

| User Story | Coverage Layer | Main Location |
| --- | --- | --- |
| Sign in and search the live catalog | Playwright against Dockerized app | `tests/frontend/e2e/auth-pages.spec.js` |
| Edit a managed user without losing filters | Playwright against Dockerized app | `tests/frontend/e2e/access-page.spec.js` |
| Create a scoped book access rule from the browser | Playwright against Dockerized app | `tests/frontend/e2e/access-page.spec.js` |
| Remove a bookmark while saving metadata edits | Playwright against Dockerized app | `tests/frontend/e2e/book-detail-page.spec.js` |
| Keep EPUB actions usable when the HTML preview is already locked | Playwright against Dockerized app | `tests/frontend/e2e/book-detail-page.spec.js` |
| Open category-filtered library results from the browser | Playwright against Dockerized app | `tests/frontend/e2e/catalog-pages.spec.js` |
| Open series-filtered library results from the browser | Playwright against Dockerized app | `tests/frontend/e2e/catalog-pages.spec.js` |
| Open writer-filtered library results from the browser | Playwright against Dockerized app | `tests/frontend/e2e/catalog-pages.spec.js` |
| Search seeded owned books from the browser | Playwright against Dockerized app | `tests/frontend/e2e/catalog-pages.spec.js` |
| Reuse an existing source URL and launch the live reader | Playwright against Dockerized app | `tests/frontend/e2e/create-books.spec.js` |
| Reuse an existing source URL and start a protected download | Playwright against Dockerized app | `tests/frontend/e2e/create-books.spec.js` |
| Create a manual book from the browser and find it again | Playwright against Dockerized app | `tests/frontend/e2e/manual-books.spec.js` |
| Show no stale processing header spinner when shared activity is idle | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Keep the processing header spinner visible while activity remains active across processing routes | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Search live processing requests | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Search live source catalog entries | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Save automation settings and confirm they persist after reload | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Search shared all-activity requests in the live queue view | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Reprocess an incomplete catalog record and observe the live outcome | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |

### Runtime Data Strategy

- Live browser tests use the real local Docker stack started by `local/scripts/dev.sh up`.
- Deterministic browser data is reset by `tests/scripts/seed-e2e-data.sh`.
- Seeded records are intentionally prefixed with `E2E ` or use the `@e2e.local` domain so they are easy to identify and clean between runs.
- The full repo verifier is `tests/scripts/verify.sh` or `tests/scripts/test-all.sh`, which runs backend pytest in Docker, frontend unit tests, the frontend production build, and the live Playwright suite against the local stack.

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
