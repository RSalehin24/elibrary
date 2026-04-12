export const USER_TAB = "user";
export const SOURCE_TAB = "source";
export const AUTOMATION_TAB = "automation";
export const ALL_TAB = "all";
export const INCOMPLETE_TAB = "incomplete";

export const LOAD_SCOPE_SUBMISSIONS = "submissions";
export const LOAD_SCOPE_JOBS = "jobs";
export const LOAD_SCOPE_JOB_REVIEWS = "jobReviews";
export const LOAD_SCOPE_REVIEWS = "reviews";
export const LOAD_SCOPE_CATALOG_BROWSE = "catalogBrowse";
export const LOAD_SCOPE_CATALOG_OVERVIEW = "catalogOverview";
export const LOAD_SCOPE_RUNS = "runs";
export const LOAD_SCOPE_AUTOMATION = "automation";
export const LOAD_SCOPE_INCOMPLETE_BROWSE = "incompleteBrowse";
export const LOAD_SCOPE_INCOMPLETE_OVERVIEW = "incompleteOverview";

export const ALL_LOAD_SCOPES = [
  LOAD_SCOPE_SUBMISSIONS,
  LOAD_SCOPE_JOBS,
  LOAD_SCOPE_JOB_REVIEWS,
  LOAD_SCOPE_REVIEWS,
  LOAD_SCOPE_CATALOG_BROWSE,
  LOAD_SCOPE_CATALOG_OVERVIEW,
  LOAD_SCOPE_RUNS,
  LOAD_SCOPE_AUTOMATION,
  LOAD_SCOPE_INCOMPLETE_BROWSE,
  LOAD_SCOPE_INCOMPLETE_OVERVIEW,
];

export const defaultSubmissionFilters = {
  q: "",
  status: "",
  range: "",
};

export const defaultJobFilters = {
  q: "",
  status: "",
  range: "",
};

export const defaultCatalogFilters = {
  q: "",
  status: "",
  sort: "status_recent",
  page: 1,
  limit: 180,
};

export const defaultCatalogStatusFilters = {
  q: "",
};

export const defaultCatalogPagination = {
  page: 1,
  limit: 180,
  total_count: 0,
  page_count: 1,
  has_previous: false,
  has_next: false,
};

export const defaultRunFilters = {
  q: "",
  status: "",
  mode: "",
};

export const defaultReviewFilters = {
  q: "",
  status: "",
};

export const defaultIncompleteFilters = {
  q: "",
  status: "",
};

export const defaultRemovedFilters = {
  q: "",
  range: "week",
};

export const defaultCatalogSummary = {
  total: 0,
  new: 0,
  queued: 0,
  processing: 0,
  stopped: 0,
  unfinished: 0,
  failed: 0,
  ready: 0,
  deleted: 0,
};

export const defaultIncompleteSummary = {
  total_incomplete_books: 0,
  removed_from_unfinished: 0,
  still_in_unfinished: 0,
  missing_in_catalog: 0,
  queued: 0,
  processing: 0,
  failed: 0,
  stopped: 0,
};
