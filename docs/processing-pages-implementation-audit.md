# Processing Pages Implementation Audit

This document describes the real implementation of the processing dropdown pages as of 2026-04-16.

It is based on the frontend routes/components and backend views/services, not on the existing processing docs.

## Verification Performed

- Frontend unit tests: `./tests/scripts/test-frontend-unit.sh`
- Backend test suite: `bash tests/scripts/test-backend.sh`
- Processing Playwright spec: `npm run test:e2e:existing-server -- processing-pages.spec.js --workers=1` from `app/frontend`

## Real Page Model

The processing dropdown currently routes to six pages:

- `Catalog` -> `/processing-catalog-books`
- `Automation` -> `/processing-automation`
- `My Requests` -> `/processing-my-requests`
- `Failed Requests` -> `/processing-failed-requests`
- `Deplicate Requests` -> `/processing-duplicate-requests`
- `Incomplete Requests` -> `/processing-incomplete-check`

The real category/origin mapping is implemented in [app/frontend/src/features/processing/helpers/params.js](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/features/processing/helpers/params.js) and the backend filters in [app/backend/apps/ingestion/views/filters.py](/Users/rsalehin24/Documents/ebook-scrapping/app/backend/apps/ingestion/views/filters.py):

- `My Requests` loads `origin=user`
- `Catalog` loads `origin=curation`
- `Automation` loads `origin=automation`
- `Incomplete Requests` also loads `origin=curation`
- `Failed Requests` does not filter by origin
- `Deplicate Requests` does not filter by origin

Important consequences:

- `Incomplete Requests` is not its own stored request category. It shares the same request origin as `Catalog`.
- There is no persisted "last page category" field on `BookSubmission`, `ProcessingJob`, or `DuplicateReview`.
- Failed and duplicate pages cannot filter by the page the request came from.
- Catalog-origin requests and incomplete-origin reprocess requests are indistinguishable once they become normal submissions/jobs, because both are stored as `origin=curation`.

## Shared Card Families

### Overview Cards

These are summary-only cards with no row actions.

- `My Requests Overview`
- `Catalog Overview`
- `Automation Overview`
- `Failed Requests Overview`
- `Deplicate Requests Overview`
- `Incomplete Overview`

They all show counts, but not necessarily the same buckets.

### Submission List Card Family

Implemented inline in the page components and reused in:

- `Requests`
- `Automation Requests`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`

Columns:

- request value
- status
- linked book
- updated time
- action

The request cell is rendered through [RequestValue](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/features/processing/components/ProcessingScaffold.jsx), so it shows:

- a primary request label
- a secondary URL/host line when the input is a URL
- a collapsible `View error` block when an error exists

Single-row actions are conditional:

- `Open`: opens the linked book when `linked_book_slug` exists
- `Recreate`: retries when the linked book record was deleted
- `Review`: opens candidate selection when the submission is ambiguous
- `Start`: resumes a queued job that has no `task_id`
- `Stop`: stops an active job
- `Add Again to Queue`: retries a deleted submission
- `Resume`: resumes a stopped request
- `Retry`: retries a failed or `needs_review` request
- `Delete`: deletes the request or soft-deletes it first

Bulk actions depend on card mode:

- default/request cards: `Resume selected`, `Stop selected`, `Delete selected`
- deleted cards: `Add selected to queue`, `Delete selected`
- ready cards: `Delete selected`
- stopped cards: `Resume selected`, `Delete selected`

### Processing Job Card Family

Rendered as `Processing` on most pages.

Columns:

- request
- status
- step
- updated
- action

Step labels come from [jobTypeLabel](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/features/processing/helpers/request.js):

- `ingestion` -> `Create`
- `resolution` -> `Match`
- `reprocess` -> `Regenerate`

Single-row actions:

- `Open`: when the target book exists
- `Recreate`: retries if the target book record was deleted
- `Start`: resumes a queued job without a task id
- `Stop`: stops an active job
- `Resume`: resumes a stopped job
- `Retry`: retries a failed job by retrying the submission
- `Delete`: deletes the job history row when not active

Bulk actions:

- `Resume selected`
- `Stop selected`
- `Delete selected`

### Duplicate Review Card Family

Visible only on `Deplicate Requests`, even though helper implementations exist in several other pages.

Columns:

- request
- existing book
- duplicate review status
- action

Single-row actions:

- `Same Book`: confirm the existing book match
- `New Book`: dismiss the duplicate and queue a new book flow
- `Delete`: remove the duplicate request

Bulk actions:

- `Same Book selected`
- `New Book selected`
- `Delete selected`

### Failed Jobs Card Family

Visible only on `Failed Requests`, even though helper implementations exist in several other pages.

Columns:

- request
- step
- updated
- inline error text

Visible actions are bulk-only:

- `Retry selected`
- `Delete selected`

There are no per-row action buttons on this page.

### Run History Card Family

Visible on:

- `Automation`
- `Incomplete Requests`

Columns:

- run summary
- status
- mode
- updated
- action

Single-row actions:

- `Stop`: when the run is `queued` or `processing`
- `Delete`: remove the run from history

Bulk actions:

- `Stop selected`
- `Delete selected`

### Catalog Books Card Family

Visible only on `Catalog`.

Columns:

- book
- categories
- curation status
- local book
- updated
- action

Top controls:

- search
- status filter
- sort
- page size
- pagination
- sync catalog / stop sync

Bulk actions:

- `Create selected`
- `Delete selected`

Single-row actions:

- `Open`: when the local book exists and the catalog row is `ready`
- `Create`: create a book from a `new`, `failed`, `stopped`, `unfinished`, `deleted`, or `requeued` row
- `Resume`: same button path as `Create`, but the label becomes `Resume` when the row status is `stopped`
- `Delete`: delete the catalog row

The actual "create is still running" tracking for this card is implemented through `catalogCreationTracker` plus [resolvePendingCatalogCreationEntries](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/features/processing/helpers/catalog.js).

### Incomplete Catalog Card Family

Visible only on `Incomplete Requests`.

Columns:

- book
- local categories
- source categories
- synthetic status
- action

Top actions:

- `Reload`
- `Reprocess selected`

Single-row action:

- `Reprocess`

The row status here is derived locally:

- `ready` when the book was removed from unfinished
- `unfinished` when the catalog still marks it unfinished
- `needs_review` when the book is missing from the catalog snapshot

### Removed From Unfinished Card

Visible only on `Incomplete Requests`.

Columns:

- book
- updated

Actions:

- none

It is just a filtered informational list with search and range filters.

## Page-By-Page Inventory

## My Requests

Rendered by [app/frontend/src/pages/ProcessingMyRequestsPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingMyRequestsPage.jsx)

Visible cards:

- `My Requests Overview`
- `Requests`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`

What is unique here:

- It is the only page scoped to `origin=user`.
- It shows failed and duplicate counts in the overview, but it does not render failed or duplicate row cards.

What overlaps with other pages:

- `Requests`, `Ready`, `Stopped`, `Queued`, and `Deleted` use the same submission-card behavior family used on `Automation`, `Catalog`, `Incomplete Requests`, and parts of `Deplicate Requests`.
- `Processing` uses the same processing-job card family used on `Catalog`, `Automation`, `Incomplete Requests`, and `Deplicate Requests`.

Current gaps:

- failed and duplicate rows leave this page and are only represented by counts
- helper implementations for duplicate, failed, and requeue-review cards exist in this file but are not rendered

## Catalog

Rendered by [app/frontend/src/pages/ProcessingCatalogBooksPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingCatalogBooksPage.jsx)

Visible cards:

- `Catalog Overview`
- `Catalog Books`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`

What is unique here:

- `Catalog Books` is the only catalog snapshot browser.
- It includes sync, sort, paging, and create-from-catalog actions.
- It is the only page that currently tracks create progress until the catalog entry reaches a terminal state.

What overlaps with other pages:

- `Processing`, `Ready`, `Stopped`, `Queued`, and `Deleted` are the same card families used elsewhere, but filtered to `origin=curation`.

Current gaps:

- failed/requeued catalog status-card helpers exist in this file but are not rendered anywhere
- duplicate is not a first-class catalog snapshot status; duplicate outcomes surface through duplicate reviews, while catalog snapshot status collapses that state into `failed` or later terminal submission/job state

## Automation

Rendered by [app/frontend/src/pages/ProcessingAutomationPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingAutomationPage.jsx)

Visible cards:

- `Automation Overview`
- `Automation`
- `Automation Requests`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`
- `Run History`

What is unique here:

- `Automation` settings card shows the toggle, next-run time, schedule fields, mode, page limit, and `Save automation`.
- `Run History` is scoped to scheduled automation runs (`trigger=scheduled`).

What overlaps with other pages:

- `Automation Requests`, `Ready`, `Stopped`, `Queued`, `Deleted` use the shared submission-card behavior.
- `Processing` uses the shared job-card behavior.
- `Run History` is the same run-history card family used on `Incomplete Requests`.

Current gaps:

- failed and duplicate row cards are not rendered here; only the counts survive in the overview

## Failed Requests

Rendered through [app/frontend/src/pages/ProcessingFailedRequestsPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingFailedRequestsPage.jsx) -> [app/frontend/src/pages/ProcessingAllActivityPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingAllActivityPage.jsx)

Visible cards:

- `Failed Requests Overview`
- `Failed Requests`

What is unique here:

- This page loads only failed-job review data by default.
- It is a job review page, not a submission queue page.
- It shows inline error text and bulk-only actions.

What overlaps with other pages:

- The `Failed Requests` helper exists in other page files, but only this shared all-activity page actually renders it.

Current gaps:

- there is no origin/page filter, so you cannot narrow failed rows by `My Requests`, `Catalog`, `Automation`, or `Incomplete Requests`
- there are no single-row buttons; all retry/delete handling is bulk

## Deplicate Requests

Rendered through [app/frontend/src/pages/ProcessingDuplicateRequestsPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingDuplicateRequestsPage.jsx) -> [app/frontend/src/pages/ProcessingAllActivityPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingAllActivityPage.jsx)

Visible cards:

- `Deplicate Requests Overview`
- `Deplicate Requests`
- `Processing`
- `Ready`
- `Stopped`
- `Queued`
- `Deleted`

What is unique here:

- `Deplicate Requests` is the only visible duplicate-review card.
- It can resolve duplicates either as `Same Book` or `New Book`.

What overlaps with other pages:

- `Processing`, `Ready`, `Stopped`, `Queued`, and `Deleted` reuse the same shared card families as the other queue pages.

Current gaps:

- the visible label is misspelled as `Deplicate Requests`
- there is no filter for the page/category the duplicate came from

## Incomplete Requests

Rendered by [app/frontend/src/pages/ProcessingIncompleteAutomationPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingIncompleteAutomationPage.jsx)

Visible cards:

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

What is unique here:

- `Incomplete Catalog` is a book-level reprocess list, not a submission list.
- `Removed from Unfinished` is informational only.
- `Automation Setup` is a smaller automation form than the full `Automation` page.

What overlaps with other pages:

- `Processing`, `Ready`, `Stopped`, `Queued`, `Deleted` use the same shared submission/job card families.
- `Run History` uses the same run-history family as `Automation`.

Current gaps:

- the page loads and processes `origin=curation`, the same as `Catalog`
- this means `Processing`, `Ready`, `Stopped`, `Queued`, and `Deleted` on this page are not isolated to incomplete-page reprocess requests
- requests created from here can show up on `Catalog`, and catalog requests can show up here

## Clear Bugs

### 1. Catalog sync stop is optimistic in the UI but not safely cancellable in the backend

Frontend stop flow:

- [stopCatalogRefresh in ProcessingCatalogBooksPage.jsx](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingCatalogBooksPage.jsx) immediately flips the visual state to idle and clears the task id before the backend work has really proven it stopped

Backend stop flow:

- [cancel_source_catalog_refresh in services/curation.py](/Users/rsalehin24/Documents/ebook-scrapping/app/backend/apps/ingestion/services/curation.py) revokes the Celery task and immediately finalizes the refresh state as stopped/idle
- [process_source_catalog_refresh in services/curation_support/source_refresh.py](/Users/rsalehin24/Documents/ebook-scrapping/app/backend/apps/ingestion/services/curation_support/source_refresh.py) then calls `TitleResolver().refresh_catalog(...)`
- [TitleResolver.refresh_catalog in services/resolution.py](/Users/rsalehin24/Documents/ebook-scrapping/app/backend/apps/ingestion/services/resolution.py) has no cooperative cancellation checks inside its page loop

Result:

- the UI can show "stopped"
- the persisted refresh state can already be idle
- the background sync work can still keep fetching/upserting catalog pages until the worker is actually killed or the loop finishes

This matches the reported behavior: start sync, stop it, but syncing continues in the background.

### 2. Selection checkboxes are generally not locked during pending actions

Across the submission, job, duplicate, failed-job, and run-history tables:

- bulk buttons usually disable correctly while `bulkActionKey` is active
- row action buttons usually disable correctly while `busyActionId`, `busyRunId`, or global lock flags are active
- select-all checkboxes and row checkboxes are usually still enabled

This is visible in:

- `renderSubmissionsCard` implementations
- `renderJobsCard` implementations
- `ProcessingJobReviewCard`
- `renderDuplicateCard`
- `renderRunsCard`

Effect:

- while a single or bulk action is pending, the user can still change row selection
- that does not satisfy the requested lock rule that selection and actions should stay disabled until the action finishes

### 3. Incomplete-page reprocess is only tracked until queueing returns, not until the request finishes

`Catalog Books` correctly keeps `Create` locked through tracked pending work.

`Incomplete Catalog` does not. In [queueIncompleteBooks](/Users/rsalehin24/Documents/ebook-scrapping/app/frontend/src/pages/ProcessingIncompleteAutomationPage.jsx):

- `creatingCatalog` is set only around the queueing API request
- after the API returns and one reload finishes, the lock is released
- there is no equivalent to the catalog page's `catalogCreationTracker`

Effect:

- `Reprocess selected` can stop showing loading even though the created request is still queued or processing
- controls can re-enable before the resulting book request reaches `ready`, `stopped`, `deleted`, `failed`, or `duplicate`

This does not match the requested "create book is not finished until terminal state" rule.

### 4. Incomplete Requests is not a separate request category

The page looks separate in the UI, but it is not separate in stored request identity:

- `Catalog` uses `origin=curation`
- `Incomplete Requests` also uses `origin=curation`

Effect:

- the same curation request stream is reused by both pages
- last-category ownership between `Catalog` and `Incomplete Requests` is lost
- the same request can surface on both pages' queue cards

This violates the requested rule that requests stay in one category until they become failed/duplicate, and then continue from their last category after that.

### 5. Failed and duplicate pages cannot filter by the originating category

There is no stored "came from page X" value, and the visible filter fields do not include origin/category.

Effect:

- once rows move into `Failed Requests` or `Deplicate Requests`, the user cannot filter them back down to `My Requests`, `Catalog`, `Automation`, or `Incomplete Requests`
- the code only preserves `origin`, and even that is not exposed as a filter on these pages

### 6. UI naming typo

The navigation label, page title, and duplicate card title use `Deplicate Requests` instead of `Duplicate Requests`.

## Requires Structural Change Or Explicit Product Direction

These are not small one-line fixes.

- If `Incomplete Requests` must be a true request category, it needs its own persisted origin/category or a stored last-page field. The current data model cannot distinguish catalog-created curation work from incomplete-page reprocess work.
- If failed and duplicate pages must filter by previous category, that previous category has to be stored or derivable in a way richer than the current `origin`.
- If duplicate must be a catalog-page status as well as a separate page, catalog snapshot status handling has to stop collapsing duplicate outcomes into broader failure-like states.

## Existing Test Coverage Gaps

The current automated coverage is useful, but it does not fully prove the behavior you asked for.

Covered today:

- shared helper logic
- catalog tracked create loading/disable behavior
- basic stop/resume/delete flows on visible queue cards
- mocked catalog sync start/stop UI behavior

Not covered well enough:

- true backend cancellation of source catalog refresh after stop
- checkbox lock behavior during single and bulk actions on every card family
- incomplete-page create/reprocess tracking until terminal state
- filtering failed/duplicate rows by originating page/category

