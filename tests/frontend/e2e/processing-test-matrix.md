# Processing E2E Test Matrix

## User Stories

1. As an operator, I need catalog sync to run end to end, pause safely, resume from the beginning, and complete without leaving records behind.
2. As an operator, I need every processing page card to isolate its own loaders, disabled controls, search, filters, and visible counts.
3. As an operator, I need automatic request progression to keep moving across `initial`, `queued`, `processing`, and terminal states without requiring manual refreshes.
4. As an operator, I need paused, failed, duplicate, deleted, and incomplete records to move between pages predictably with valid actions only.
5. As an operator, I need notifications when actions complete and when the system detects duplicates or failures so I can react without inspecting every card manually.
6. As an operator, I need long-running processing work to stop surfacing as active work once it exceeds the allowed window and be visible as a failure instead.

## Matrix

| Area | Story | Scenario | Expected result |
| --- | --- | --- | --- |
| Catalog | Manual sync | Start sync and let it run | Sync advances through all remote pages, returns to idle automatically, shows completion status, and leaves all fetched rows in the table |
| Catalog | Manual sync | Pause during an active sync | Pause button switches to `Pausing...`, current page finishes, progress is saved, and resume restarts reconciliation from page 1 |
| Catalog | Records card | Create requests from selectable rows | Only eligible rows can be selected, bulk create shows a loader in the records card only, and created requests enter the pipeline |
| Catalog | Automation | Run catalog automation | Only `not_created`, `failed`, and `deleted` records receive new initial requests, then the pipeline auto-advances them |
| Create | Requests / Queue / Processing / Created | Card isolation | A busy card disables only its own controls while the other create-page cards remain interactive |
| Create | Processing | Pause active work | Progress is saved, the row leaves `Processing`, and the request appears in `On Hold / Paused` |
| Create | Created | Delete completed work | The row leaves `Created`, moves to `On Hold / Deleted`, and linked-book deletion is requested when applicable |
| On Hold | Paused | Resume paused requests | Resume sets `isResumed`, returns the row to `Create / Requests`, and the pipeline keeps moving afterward |
| On Hold | Failed | Retry failed requests | Retry returns the row to `Create / Requests` and clears the previous failure message |
| On Hold | Duplicate | Confirm duplicate | Duplicate confirmation keeps the catalog row locked until the original request reaches a terminal failure or deletion state |
| On Hold | Deleted | Create again | Deleted rows can be recreated back into `Create / Requests` without affecting unrelated cards |
| Incomplete | Automation | Resolve incomplete records | Automation reclassifies completed records, updates overview counts, and surfaces the resolved rows in `Completed Books` |
| Incomplete | Completed Books | Recreate or delete resolved items | Recreate sends the request back to `Create / Requests`; delete moves it to `On Hold / Deleted` |
| Notifications | Action feedback | Create / save / sync completion | Success or info toasts appear for request creation, automation saves, sync start, sync pause, and sync completion |
| Notifications | Terminal feedback | Duplicate, failed, stale, and created transitions | Duplicate detection shows a notice, failed requests show an alert, created requests show success, and stale processing is surfaced as failed work |

## Covered Edge Cases

- Full manual sync completion with no explicit pause
- Pause-after-current-page sync behavior
- Automated request creation eligibility filtering
- Duplicate confirmation locking and unlock after the original request becomes terminal
- Stale processing timeout after 20 minutes
- Cross-card loader and disabled-control isolation
- Read-only incomplete rows with no actions
- Action completion notifications plus duplicate/failure transition notifications

## Automated Coverage

- `tests/backend/processing/test_processing_api.py`
- `tests/frontend/e2e/processing-pages.spec.js`
- `tests/frontend/e2e/processing-pages-live.spec.js` for live smoke coverage when the local frontend base URL is available
