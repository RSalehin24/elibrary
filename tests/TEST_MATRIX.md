# Test Matrix

## Backend Coverage

| Feature Area | Coverage Layer | Main Location |
| --- | --- | --- |
| Authentication and session behavior | `pytest` | `tests/backend/auth/` |
| Access grants, reader access, and permission logic | `pytest` | `tests/backend/access/` |
| Catalog metadata and manual-book workflows | `pytest` | `tests/backend/catalog_management/` |
| Ingestion pipeline, curation, queue logic, and processing | `pytest` | `tests/backend/ingestion/` |
| Shared/common behavior and legacy pipeline compatibility | `pytest` | `tests/backend/test_common.py`, `tests/backend/test_legacy_pipeline.py` |

## Live Browser Coverage

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
| Search live processing requests | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Search live source catalog entries | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Save automation settings and confirm they persist after reload | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Search shared all-activity requests in the live queue view | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |
| Reprocess an incomplete catalog record and observe the live outcome | Playwright against Dockerized app | `tests/frontend/e2e/processing-pages.spec.js` |

## Runtime Data Strategy

- Live browser tests use the real local Docker stack started by `local/scripts/dev.sh up`.
- Deterministic browser data is reset by `local/scripts/seed-e2e-data.sh`.
- Seeded records are intentionally prefixed with `E2E ` or use the `@e2e.local` domain so they are easy to identify and clean between runs.
- The full repo verifier is `local/scripts/verify.sh`, which runs backend pytest in Docker, the frontend production build in Docker, and the live Playwright suite against the local stack.
