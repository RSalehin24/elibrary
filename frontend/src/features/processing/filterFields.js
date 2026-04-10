export const submissionFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending_resolution", label: "Resolving" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "needs_review", label: "Needs review" },
      { value: "ready", label: "Ready" },
      { value: "failed", label: "Failed" },
      { value: "stopped", label: "Stopped" },
      { value: "duplicate", label: "Duplicate" },
    ],
  },
  {
    key: "review_state",
    label: "Review",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending", label: "Pending" },
      { value: "needs_review", label: "Needs review" },
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" },
    ],
  },
  {
    key: "resolution_status",
    label: "Match",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "resolved", label: "Resolved" },
      { value: "exact_match", label: "Exact match" },
      { value: "ambiguous", label: "Ambiguous" },
      { value: "invalid", label: "Invalid" },
      { value: "unresolved", label: "Unresolved" },
    ],
  },
  {
    key: "input_type",
    label: "Input",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "url", label: "URL" },
      { value: "title", label: "Title" },
      { value: "csv", label: "CSV" },
    ],
  },
];

export const jobFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "needs_review", label: "Needs review" },
      { value: "ready", label: "Ready" },
      { value: "failed", label: "Failed" },
      { value: "stopped", label: "Stopped" },
      { value: "succeeded", label: "Complete" },
    ],
  },
  {
    key: "job_type",
    label: "Step",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "ingestion", label: "Create" },
      { value: "resolution", label: "Match" },
      { value: "reprocess", label: "Regenerate" },
      { value: "catalog_refresh", label: "Catalog refresh" },
      { value: "curation", label: "Curation run" },
    ],
  },
];

export const catalogFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "new", label: "New" },
      { value: "processing", label: "Processing" },
      { value: "stopped", label: "Stopped" },
      { value: "requeued", label: "Requeued" },
      { value: "failed", label: "Failed" },
      { value: "unfinished", label: "Unfinished" },
      { value: "ready", label: "Ready" },
      { value: "deleted", label: "Deleted" },
    ],
  },
];

export const runFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "failed", label: "Failed" },
      { value: "stopped", label: "Stopped" },
      { value: "succeeded", label: "Complete" },
    ],
  },
  {
    key: "mode",
    label: "Mode",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending", label: "New + unfinished" },
      { value: "all", label: "All tracked" },
    ],
  },
];

export const reviewFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "pending", label: "Pending" },
      { value: "confirmed", label: "Confirmed" },
      { value: "dismissed", label: "Dismissed" },
      { value: "merged", label: "Merged" },
    ],
  },
];

export const incompleteFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "removed", label: "Removed from unfinished" },
      { value: "still", label: "Still in unfinished" },
      { value: "missing", label: "Missing in catalog" },
    ],
  },
];

export const removedFilterFields = [
  {
    key: "range",
    label: "Range",
    type: "select",
    options: [
      { value: "day", label: "Past day" },
      { value: "week", label: "Past week" },
      { value: "month", label: "Past month" },
      { value: "year", label: "Past year" },
    ],
  },
];
