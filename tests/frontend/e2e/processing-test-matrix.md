# Processing E2E Test Matrix

## User Stories

1. As an operator, I need each request to appear in exactly one matching card so the queue state is unambiguous.
2. As an operator, I need failed requests to show the failure message in the failed table row so I can scan errors without opening a side panel.
3. As an operator, I need card actions to target only the records shown in that card so bulk actions do not affect hidden rows.
4. As an operator, I need searches and filters to change the visible row set and counts for the active card only.
5. As an operator, I need page-specific cards to appear only where they belong, such as failed requests on the failed page and duplicate reviews on the duplicate page.

## Matrix

| Page | Card | Primary scenario | Expected result |
| --- | --- | --- | --- |
| My Requests | Requests | Pending/manual requests load | Pending request stays out of processing, ready, queued, stopped, and deleted cards |
| My Requests | Processing | Active request is stopped | Request moves from Processing to Stopped |
| My Requests | Deleted | Deleted request is requeued | Request leaves Deleted and appears in Ready |
| Catalog | Processing/Ready/Queued/Stopped/Deleted | Seeded curation requests render | Each seeded request appears in one card only |
| Catalog | Catalog Books | Sort control changes order | Visible catalog rows remain correct after sort change |
| Catalog | Catalog Books | Create selected and leave the page mid-run | Create controls keep loading, selection stays disabled, and both clear only after the tracked rows reach a terminal result |
| Catalog | Catalog Sync | Start sync | Sync control switches to an active loading state immediately after the action starts |
| Catalog | Processing/Stopped/Deleted/Catalog Books | Stop, resume, requeue, and delete from visible rows | Each live action updates the matching card or row without manual refresh |
| Automation | Processing/Ready/Queued/Stopped/Deleted | Seeded automation requests render | Each seeded request appears in one card only |
| Automation | Run History | Expand/collapse and persistence | Expanded run history rises to the top and saved settings persist after reload |
| Failed Requests | Failed Requests | Failed rows render with Errors column | Row shows failure message inline and no side log panel is rendered |
| Failed Requests | Failed Requests search | Search by error text | Only matching failed row remains visible |
| Deplicate Requests | Deplicate Requests | Duplicate resolution action | Duplicate row leaves duplicate card and moves into normal processing flow |
| Incomplete Requests | Incomplete Catalog | Reprocess selected incomplete book | Reprocess action queues the selected incomplete item |
| Incomplete Requests | Run History | Failed/stopped run details | Run history stays collapsible and failed runs expose error disclosure |

## Real-Browser Coverage

- `tests/frontend/e2e/processing-pages.spec.js`
- Uses the live frontend and backend stack with seeded deterministic data
- Validates card ownership, counts via visible rows, search/filter behavior, and destructive/non-destructive actions
