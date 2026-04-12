const processingRangeField = {
  key: "range",
  label: "Range",
  type: "select",
  options: [
    { value: "", label: "Any" },
    { value: "week", label: "Past Week" },
    { value: "month", label: "Past Month" },
    { value: "year", label: "Past Year" },
  ],
};

export const submissionFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "ready", label: "Ready" },
      { value: "failed", label: "Failed" },
      { value: "stopped", label: "Stopped" },
      { value: "duplicate", label: "Duplicate" },
      { value: "deleted", label: "Deleted" },
    ],
  },
  processingRangeField,
];

export const readySubmissionFilterFields = [processingRangeField];

export const jobFilterFields = [
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
      { value: "succeeded", label: "Ready" },
    ],
  },
  processingRangeField,
];

export const catalogFilterFields = [
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "", label: "Any" },
      { value: "new", label: "New" },
      { value: "queued", label: "Queued" },
      { value: "processing", label: "Processing" },
      { value: "stopped", label: "Stopped" },
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
      { value: "succeeded", label: "Ready" },
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
