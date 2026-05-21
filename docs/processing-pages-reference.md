# Processing Pages Reference

Validated on: 2026-04-15

This document describes the current processing pages, the cards that are rendered on each page, the actions available inside those cards, the regressions that were fixed, and the test coverage used to verify the real development frontend and backend.

## Fixes Applied

- The catalog page regression was caused by heavy catalog queries and full in-memory source-catalog snapshot building during normal browse requests. Browse mode now uses lightweight, paginated catalog entry responses, while overview mode uses a separate summary path.
- Heavy book payload fields are now deferred in the catalog and ingestion querysets/serializers so list pages do not pull HTML blobs, raw scrape payloads, or large JSON fields unless they are actually needed.
- Processing pages now avoid unnecessary development-only duplicate frontend requests and avoid broad background polling when no active work exists, which reduced backend pressure and the worker-loss cascade seen during the failing runs.
- The local development worker now runs in Celery `solo` mode with single-task settings pinned in compose, which stopped the repeated prefork `SIGKILL` crashes while draining the existing submission backlog.

## Validated Edge Cases

- Large catalog browse against the current dev dataset with thousands of source rows, including sort changes, page changes, and rows-per-page changes.
- Failed page layout isolation: the failed route intentionally renders only the overview plus `Failed Requests`, not the wider queue board.
- Duplicate page behavior when the matched existing book has already been deleted: `Same Book` is hidden and `New Book` remains available.
- Collapsible `Stopped`, `Queued`, and `Deleted` cards render only when they still have matching rows, so the `Deleted` card can disappear completely after the final deleted request is requeued.
- Submission and processing cards only expose state-valid actions such as `Start`, `Stop`, `Resume`, `Retry`, `Add Again to Queue`, and `Recreate` when the underlying row actually supports them.
- Catalog rows correctly handle ready/open rows, stopped rows that can be resumed, deleted/local-book-missing rows, and non-creatable rows that remain read-only.
- Incomplete checks cover missing source categories, books removed from unfinished tracking, empty removed-history ranges, and single-row versus bulk reprocess flows.

## Shared Card Behavior

### Submission cards

These cards are reused across multiple pages under different titles such as `Requests`, `Automation Requests`, `Ready`, `Queued`, `Stopped`, and `Deleted`.

Common behavior:

- search and filter drawer
- row selection and select-all
- delete confirmation dialog

Bulk actions by state:

- default/request-style cards: `Stop selected`, `Delete selected`
- stopped cards: `Resume selected`, `Delete selected`
- deleted cards: `Add selected to queue`, `Delete selected`
- ready cards: `Delete selected`

Row actions by row state:

- `Open` when a linked book exists
- `Review` when a title match needs manual confirmation
- `Start` when a queued job has not been dispatched yet
- `Stop` while work is active
- `Resume` for stopped work
- `Retry` for failed or review-needed work
- `Add Again to Queue` for deleted requests
- `Recreate` when the previous linked book was deleted
- `Delete` on every submission row

### Processing job cards

These are the `Processing` cards.

Common behavior:

- search and filter drawer
- row selection and select-all
- bulk `Resume selected`
- bulk `Stop selected`
- bulk `Delete selected`

Row actions by row state:

- `Open` when a target book exists
- `Recreate` when the target book was deleted
- `Start` for queued-but-not-dispatched jobs
- `Stop` for active jobs
- `Resume` for stopped jobs
- `Retry` for failed jobs
- `Delete` for any row

### Duplicate review card

Used on the duplicate page.

Common behavior:

- search and filter drawer
- row selection and select-all
- bulk `Same Book selected`
- bulk `New Book selected`
- bulk `Delete selected`

Row actions:

- `Same Book`
- `New Book`
- `Delete`

### Failed requests card

Used on the failed page.

Common behavior:

- search and filter drawer
- row selection and select-all
- bulk `Retry selected`
- bulk `Delete selected`

Row behavior:

- rows expose request, step, status, updated time, and error details
- there are no row-level action buttons on this card

### Run history card

Used on pages with curation run history.

Common behavior:

- search and filter drawer
- row selection and select-all
- bulk `Stop selected`
- bulk `Delete selected`

Row actions:

- `Stop` for active runs
- `Delete` for any run row

### Review Match dialog

This modal appears after clicking `Review` on ambiguous submission rows.

Actions:

- choose a candidate to confirm the source
- close the dialog without confirming

## Page Map

### `/processing-my-requests`

Heading: `My Requests`

Cards:

- `My Requests Overview`
- `Requests`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`

How it works:

- this page is scoped to the current user’s own requests
- the overview card is summary-only
- the operational cards are the shared submission/job cards described above

### `/processing-catalog-books`

Heading: `Catalog`

Cards:

- `Catalog Overview`
- `Catalog Books`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`

`Catalog Books` actions:

- search
- filter drawer
- sort chooser
- rows-per-page chooser
- pagination: `First`, `Prev`, `Next`, `Last`
- sync control: `Sync catalog` and `Stop catalog sync`
- bulk `Create selected`
- bulk `Delete selected`
- row `Open` when a local ready book exists
- row `Create` for creatable rows
- row `Resume` for stopped catalog rows
- row `Delete`

How it works:

- `Catalog Overview` is summary-only
- `Catalog Books` is the main source-catalog queue
- the other cards reuse the shared submission/job behavior

### `/processing-automation`

Heading: `Automation`

Cards:

- `Automation Overview`
- `Automation`
- `Automation Requests`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`
- `Run History`

`Automation` card actions:

- enable/disable toggle
- set `Time`
- set `Frequency`
- set `Mode`
- set `Pages`
- `Save automation`

How it works:

- the overview card is summary-only
- `Automation` changes catalog automation settings
- `Run History` tracks scheduled/manual curation runs
- request and processing cards use the shared behaviors

### `/processing-failed-requests`

Heading: `Failed Requests`

Cards:

- `Failed Requests Overview`
- `Failed Requests`

How it works:

- this page is intentionally narrow and does not render the generic ready/processing/run-history board
- the overview card is summary-only
- the action card is the shared failed-requests review card

### `/processing-duplicate-requests`

Heading shown in the UI: `Deplicate Requests`

Cards:

- `Deplicate Requests Overview`
- `Deplicate Requests`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`

How it works:

- the overview card is summary-only
- `Deplicate Requests` is the duplicate-review card with `Same Book`, `New Book`, and delete actions
- the remaining cards reuse the shared submission/job behavior

### `/processing-incomplete-check`

Heading: `Incomplete Requests`

Cards:

- `Incomplete Overview`
- `Automation Setup`
- `Incomplete Catalog`
- `Removed from Unfinished`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`
- `Run History`

`Automation Setup` actions:

- enable/disable toggle
- set `Time`
- set `Frequency`
- `Save automation`

`Incomplete Catalog` actions:

- search
- `Reload`
- bulk `Reprocess selected`
- row `Reprocess`

`Removed from Unfinished` actions:

- search
- range filter

How it works:

- `Incomplete Overview` is summary-only
- `Automation Setup` controls the incomplete-check schedule
- `Incomplete Catalog` queues reprocessing for incomplete-category books
- `Removed from Unfinished` is read-only history
- `Run History` uses the shared run controls

## Validation

### Backend regression tests

Command:

```bash
bash tests/scripts/test-backend.sh tests/backend/ingestion/test_ingestion_03.py tests/backend/catalog_management/test_catalog_management_04.py
```

Result:

- `10 passed in 11.66s`

Covered here:

- lightweight catalog browse payloads and pagination
- overview-only catalog summary responses
- deleted/status-filtered source catalog rows
- heavy catalog book columns staying out of list queries

### Frontend unit checks

Command:

```bash
cd app/frontend && node --test ../../tests/frontend/unit/processingCatalog.test.js ../../tests/frontend/unit/localWorkerConfig.test.js ../../tests/frontend/unit/localStackConfig.test.js
```

Result:

- `9 passed`

Covered here:

- tracked catalog-creation edge cases
- local stack safer worker defaults
- local stack `CELERY_TASK_ALWAYS_EAGER` plumbing

### Live frontend/backend checks

Commands:

```bash
cd app/frontend && npm run test:e2e:existing-server -- processing-pages-live.spec.js --workers=1
```

Results:

- `processing-pages-live.spec.js`: `8 passed (58.3s)`

Live scenarios covered:

- my-requests resume and add-again flows
- failed and duplicate resolution flows
- catalog stop, resume, requeue, and sync flows
- automation settings save flow
- incomplete-page automation save and incomplete-book reprocess flow
- library server-side pagination

### Mocked browser edge-case sweep

Command:

```bash
cd app/frontend && npm run test:e2e:existing-server -- processing-pages.spec.js --workers=1
```

Result:

- `14 passed (59.6s)`

This suite covers:

- per-card search controls and result counts
- filter-drawer isolation
- collapsible-card ordering
- automation settings persistence
- incomplete reprocess controls
- failed/duplicate page layout constraints
- catalog queue, sync, and selection edge cases
