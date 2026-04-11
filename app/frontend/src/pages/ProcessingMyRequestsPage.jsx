import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api/client";
import BookRouteLink from "../components/BookRouteLink";
import CatalogToolbar, { CatalogSearchRow } from "../components/CatalogToolbar";
import ConfirmationDialog from "../components/ConfirmationDialog";
import LoadingSpinner from "../components/LoadingSpinner";
import ProcessingJobReviewCard from "../components/ProcessingJobReviewCard";
import StatusPill from "../components/StatusPill";
import {
  ALL_LOAD_SCOPES,
  LOAD_SCOPE_JOB_REVIEWS,
  LOAD_SCOPE_JOBS,
  LOAD_SCOPE_REVIEWS,
  LOAD_SCOPE_SUBMISSIONS,
  USER_TAB,
  defaultJobFilters,
  defaultReviewFilters,
  defaultSubmissionFilters,
} from "../features/processing/constants";
import { jobFilterFields, reviewFilterFields, submissionFilterFields } from "../features/processing/filterFields";
import {
  buildJobsParams,
  buildReviewParams,
  buildSubmissionOverviewSummary,
  buildSubmissionParams,
  filterJobsByControls,
  getJobActivityAt,
  getRequeueReasonText,
  getRequestPrimaryText,
  getSubmissionActivityAt,
  getUniqueSubmissionIds,
  isActiveStatus,
  isDefaultJobRequest,
  isResumableJob,
  jobTypeLabel,
  normalizeTimeInput,
  selectedActionLabel,
  summarizeResponse,
  toggleSelectedId,
  toggleVisibleSelection,
} from "../features/processing/helpers";
import {
  BookLinkCell,
  QueueTableCard,
  RequestValue,
  renderProcessingCardLoader,
} from "../features/processing/components/ProcessingScaffold";
import { useProcessingActivity } from "../features/processing/ProcessingActivityProvider";
import { useSession } from "../hooks/useSession";
import { useToast } from "../hooks/useToast";
import { formatBookDateTime } from "../utils/bookPresentation";
import { hasCapability } from "../utils/capabilities";
import { toQueryString } from "../utils/query";

export default function ProcessingMyRequestsPage() {
  const { user } = useSession();
  const toast = useToast();
  const { busy: processingActivityBusy } = useProcessingActivity();
  const canManageProcessing = hasCapability(user, "processing:manage");
  const activeTab = USER_TAB;
  const [jobs, setJobs] = useState([]);
  const [jobReviewRows, setJobReviewRows] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [duplicateReviews, setDuplicateReviews] = useState([]);
  const [submissionFilters, setSubmissionFilters] = useState(
    defaultSubmissionFilters,
  );
  const [jobFilters, setJobFilters] = useState(defaultJobFilters);
  const [reviewFilters, setReviewFilters] = useState(defaultReviewFilters);
  const [requeueFilters, setRequeueFilters] = useState(defaultJobFilters);
  const [failedFilters, setFailedFilters] = useState(defaultJobFilters);
  const [submissionFiltersExpanded, setSubmissionFiltersExpanded] =
    useState(false);
  const [jobFiltersExpanded, setJobFiltersExpanded] = useState(false);
  const [reviewFiltersExpanded, setReviewFiltersExpanded] = useState(false);
  const [requeueFiltersExpanded, setRequeueFiltersExpanded] = useState(false);
  const [failedFiltersExpanded, setFailedFiltersExpanded] = useState(false);
  const [selectedSubmissionIds, setSelectedSubmissionIds] = useState([]);
  const [selectedJobIds, setSelectedJobIds] = useState([]);
  const [selectedRequeueJobIds, setSelectedRequeueJobIds] = useState([]);
  const [selectedFailedJobIds, setSelectedFailedJobIds] = useState([]);
  const [selectedDuplicateReviewIds, setSelectedDuplicateReviewIds] = useState(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [submissionsLoading, setSubmissionsLoading] = useState(true);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobReviewsLoading, setJobReviewsLoading] = useState(true);
  const [reviewsLoading, setReviewsLoading] = useState(canManageProcessing);
  const [error, setError] = useState("");
  const [reviewSubmission, setReviewSubmission] = useState(null);
  const [busyActionId, setBusyActionId] = useState("");
  const [busyDeleteId, setBusyDeleteId] = useState("");
  const [activeRequeueJobId, setActiveRequeueJobId] = useState("");
  const [activeFailedJobId, setActiveFailedJobId] = useState("");
  const [activeFailedJobLogs, setActiveFailedJobLogs] = useState([]);
  const [loadingFailedLogs, setLoadingFailedLogs] = useState(false);
  const [bulkActionKey, setBulkActionKey] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const defaultScopes = useMemo(
    () => [
      LOAD_SCOPE_SUBMISSIONS,
      LOAD_SCOPE_JOBS,
      LOAD_SCOPE_JOB_REVIEWS,
      ...(canManageProcessing ? [LOAD_SCOPE_REVIEWS] : []),
    ],
    [canManageProcessing],
  );

  const globalActionsLocked = Boolean(
    busyActionId ||
    busyDeleteId ||
    bulkActionKey ||
    confirmLoading,
  );
  const sourceTabButtonsDisabled = globalActionsLocked;
  const creationActionsDisabled = globalActionsLocked;

  function setScopeLoading(scopes, isLoading) {
    if (scopes.has(LOAD_SCOPE_SUBMISSIONS)) {
      setSubmissionsLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_JOBS)) {
      setJobsLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_JOB_REVIEWS)) {
      setJobReviewsLoading(isLoading);
    }
    if (scopes.has(LOAD_SCOPE_REVIEWS) && canManageProcessing) {
      setReviewsLoading(isLoading);
    }
  }

  async function load(options = {}) {
    const {
      nextJobFilters = jobFilters,
      nextSubmissionFilters = submissionFilters,
      nextReviewFilters = reviewFilters,
      silent = false,
      scopes = defaultScopes,
    } = options;
    const scopeSet = new Set(scopes);
    const isFullLoad =
      scopeSet.size === defaultScopes.length &&
      defaultScopes.every((scope) => scopeSet.has(scope));

    if (!silent) {
      if (isFullLoad) {
        setLoading(true);
      }
      setScopeLoading(scopeSet, true);
    }

    try {
      const requests = [];
      const shouldReuseJobReviewRows =
        scopeSet.has(LOAD_SCOPE_JOBS) &&
        scopeSet.has(LOAD_SCOPE_JOB_REVIEWS) &&
        isDefaultJobRequest(nextJobFilters);
      const queueScopeRequest = (scope, url) => {
        requests.push(
          apiFetch(url).then((payload) => ({
            scope,
            payload,
          })),
        );
      };

      if (scopeSet.has(LOAD_SCOPE_JOBS)) {
        queueScopeRequest(
          LOAD_SCOPE_JOBS,
          `/ingestion/jobs/${toQueryString(
            buildJobsParams(nextJobFilters, activeTab),
          )}`,
        );
      }

      if (scopeSet.has(LOAD_SCOPE_JOB_REVIEWS)) {
        if (!shouldReuseJobReviewRows) {
          queueScopeRequest(
            LOAD_SCOPE_JOB_REVIEWS,
            `/ingestion/jobs/${toQueryString(
              buildJobsParams(defaultJobFilters, activeTab),
            )}`,
          );
        }
      }

      if (scopeSet.has(LOAD_SCOPE_SUBMISSIONS)) {
        queueScopeRequest(
          LOAD_SCOPE_SUBMISSIONS,
          `/ingestion/submissions/${toQueryString(
            buildSubmissionParams(nextSubmissionFilters, activeTab),
          )}`,
        );
      }

      if (scopeSet.has(LOAD_SCOPE_REVIEWS) && canManageProcessing) {
        queueScopeRequest(
          LOAD_SCOPE_REVIEWS,
          `/ingestion/duplicate-reviews/${toQueryString(
            buildReviewParams(nextReviewFilters, activeTab),
          )}`,
        );
      }

      const payloads = await Promise.all(requests);
      const payloadByScope = new Map(
        payloads.map(({ scope, payload }) => [scope, payload]),
      );

      if (payloadByScope.has(LOAD_SCOPE_JOBS)) {
        setJobs(payloadByScope.get(LOAD_SCOPE_JOBS) || []);
      }

      if (payloadByScope.has(LOAD_SCOPE_JOB_REVIEWS) || shouldReuseJobReviewRows) {
        setJobReviewRows(
          (shouldReuseJobReviewRows
            ? payloadByScope.get(LOAD_SCOPE_JOBS)
            : payloadByScope.get(LOAD_SCOPE_JOB_REVIEWS)) || [],
        );
      }

      if (payloadByScope.has(LOAD_SCOPE_SUBMISSIONS)) {
        setSubmissions(payloadByScope.get(LOAD_SCOPE_SUBMISSIONS) || []);
      }

      if (payloadByScope.has(LOAD_SCOPE_REVIEWS)) {
        setDuplicateReviews(payloadByScope.get(LOAD_SCOPE_REVIEWS) || []);
      }

      setError("");
    } catch (nextError) {
      if (!silent) {
        setError(nextError.message);
        toast.error(nextError.message);
      }
    } finally {
      if (!silent) {
        setScopeLoading(scopeSet, false);
        if (isFullLoad) {
          setLoading(false);
        }
      }
    }
  }

  useEffect(() => {
    load().catch(() => {});
  }, [user?.id, canManageProcessing]);

  useEffect(() => {
    const hasActiveJobs = [...jobs, ...jobReviewRows].some((job) =>
      isActiveStatus(job.status),
    );
    if (!hasActiveJobs) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      load({ silent: true }).catch(() => {});
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    jobs,
    jobReviewRows,
    jobFilters,
    submissionFilters,
    reviewFilters,
    canManageProcessing,
  ]);

  useEffect(() => {
    setSelectedSubmissionIds((current) =>
      current.filter((id) =>
        submissions.some((submission) => submission.id === id),
      ),
    );
  }, [submissions]);

  useEffect(() => {
    setSelectedJobIds((current) =>
      current.filter((id) => jobs.some((job) => job.id === id)),
    );
  }, [jobs]);

  function resetWithLoad(nextValue, setter, key, scopes) {
    setter(nextValue);
    load({
      [key]: nextValue,
      scopes,
    }).catch(() => {});
  }

  async function reloadScoped(scopes, options = {}) {
    await load({ scopes, ...options });
  }

  async function reloadCurrent(options = {}) {
    await load(options);
  }

  async function retrySubmission(submissionId) {
    if (creationActionsDisabled) {
      return;
    }
    setBusyActionId(submissionId);
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/retry/`, {
        method: "POST",
        body: {},
      });
      toast.success("Request queued.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function confirmCandidate(submissionId, candidateId) {
    if (creationActionsDisabled) {
      return;
    }
    setBusyActionId(submissionId);
    try {
      await apiFetch(
        `/ingestion/submissions/${submissionId}/confirm-candidate/`,
        {
          method: "POST",
          body: { candidate_id: candidateId },
        },
      );
      setReviewSubmission(null);
      toast.success("Source selected.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function resolveDuplicate(reviewId, decision) {
    setBusyActionId(reviewId);
    try {
      await apiFetch(`/ingestion/duplicate-reviews/${reviewId}/resolve/`, {
        method: "POST",
        body: { decision },
      });
      toast.success(
        decision === "confirm_existing"
          ? "Existing book kept."
          : "New book queued.",
      );
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function resolveDuplicateBulk(reviewIds, decision) {
    const uniqueIds = Array.from(new Set((reviewIds || []).filter(Boolean)));
    if (!uniqueIds.length) {
      return;
    }

    setBulkActionKey(`duplicate:${decision}`);
    try {
      let resolvedCount = 0;
      for (const reviewId of uniqueIds) {
        await apiFetch(`/ingestion/duplicate-reviews/${reviewId}/resolve/`, {
          method: "POST",
          body: { decision },
        });
        resolvedCount += 1;
      }
      toast.success(
        decision === "confirm_existing"
          ? `${resolvedCount} duplicate checks kept existing book.`
          : `${resolvedCount} duplicate checks queued as new.`,
      );
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBulkActionKey("");
    }
  }

  async function retrySubmissionsBulk(submissionIds, actionKey) {
    const uniqueIds = Array.from(
      new Set((submissionIds || []).filter(Boolean)),
    );
    if (!uniqueIds.length || creationActionsDisabled) {
      return;
    }

    setBulkActionKey(actionKey);
    try {
      const payload = await apiFetch("/ingestion/submissions/bulk-retry/", {
        method: "POST",
        body: { ids: uniqueIds },
      });
      toast.success(
        summarizeResponse(payload, {
          queued_count: "queued",
          skipped_duplicate_targets: "grouped",
          skipped_invalid: "skipped",
        }) || "Requests queued.",
      );
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBulkActionKey("");
    }
  }

  async function resumeJob(jobId) {
    if (creationActionsDisabled) {
      return;
    }
    setBusyActionId(jobId);
    try {
      await apiFetch(`/ingestion/jobs/${jobId}/resume/`, {
        method: "POST",
        body: {},
      });
      toast.success("Book creation started.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function stopJob(jobId) {
    setBusyActionId(jobId);
    try {
      await apiFetch(`/ingestion/jobs/${jobId}/stop/`, {
        method: "POST",
        body: {},
      });
      toast.success("Book creation stopped.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyActionId("");
    }
  }

  async function deleteSubmission(submissionId) {
    setBusyDeleteId(`submission:${submissionId}`);
    try {
      await apiFetch(`/ingestion/submissions/${submissionId}/`, {
        method: "DELETE",
      });
      setSelectedSubmissionIds((current) =>
        current.filter((id) => id !== submissionId),
      );
      toast.success("Request deleted.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyDeleteId("");
    }
  }

  async function deleteJob(jobId) {
    setBusyDeleteId(`job:${jobId}`);
    try {
      await apiFetch(`/ingestion/jobs/${jobId}/`, {
        method: "DELETE",
      });
      setSelectedJobIds((current) => current.filter((id) => id !== jobId));
      toast.success("Book creation deleted.");
      await reloadCurrent();
    } catch (nextError) {
      toast.error(nextError.message);
    } finally {
      setBusyDeleteId("");
    }
  }

  async function runBulkAction(key, requestFactory, successMessage) {
    if (bulkActionKey) {
      return null;
    }

    setBulkActionKey(key);
    try {
      const payload = await requestFactory();
      toast.success(successMessage(payload));
      await reloadCurrent();
      return payload;
    } catch (nextError) {
      toast.error(nextError.message);
      return null;
    } finally {
      setBulkActionKey("");
    }
  }

  function openDeleteDialog(scope, ids, title, body) {
    setConfirmState({ scope, ids, title, body });
  }

  async function handleConfirmDelete() {
    if (!confirmState) {
      return;
    }

    const { scope, ids } = confirmState;
    setConfirmLoading(true);
    try {
      if (scope === "submission-single") {
        await deleteSubmission(ids[0]);
      } else if (scope === "job-single") {
        await deleteJob(ids[0]);
      } else if (scope === "submission-bulk") {
        const payload = await runBulkAction(
          "submissions:delete",
          () =>
            apiFetch("/ingestion/submissions/bulk-delete/", {
              method: "POST",
              body: { ids },
            }),
          (payload) =>
            summarizeResponse(payload, {
              deleted_count: "deleted",
              skipped_active: "active",
            }) || "Requests deleted.",
        );
        if (payload) {
          const deletedIdSet = new Set(ids);
          setSelectedSubmissionIds((current) =>
            current.filter((id) => !deletedIdSet.has(id)),
          );
        }
      } else if (scope === "job-bulk") {
        const payload = await runBulkAction(
          "jobs:delete",
          () =>
            apiFetch("/ingestion/jobs/bulk-delete/", {
              method: "POST",
              body: { ids },
            }),
          (payload) =>
            summarizeResponse(payload, {
              deleted_count: "deleted",
              skipped_active: "active",
            }) || "Book creation deleted.",
        );
        if (payload) {
          const deletedIdSet = new Set(ids);
          setSelectedJobIds((current) =>
            current.filter((id) => !deletedIdSet.has(id)),
          );
        }
      }
    } finally {
      setConfirmLoading(false);
      setConfirmState(null);
    }
  }

  const selectedSubmissionIdSet = useMemo(
    () => new Set(selectedSubmissionIds),
    [selectedSubmissionIds],
  );
  const submissionIdsOnPage = useMemo(
    () => submissions.map((submission) => submission.id),
    [submissions],
  );
  const selectedSubmissionCount = selectedSubmissionIds.length;
  const selectedSubmissionCountOnPage = submissionIdsOnPage.filter((id) =>
    selectedSubmissionIdSet.has(id),
  ).length;
  const allSubmissionsSelected =
    submissions.length > 0 &&
    selectedSubmissionCountOnPage === submissions.length;
  const submissionOverview = useMemo(
    () => buildSubmissionOverviewSummary(submissions),
    [submissions],
  );

  const selectedJobIdSet = useMemo(
    () => new Set(selectedJobIds),
    [selectedJobIds],
  );
  const jobIdsOnPage = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const selectedJobCount = selectedJobIds.length;
  const selectedJobCountOnPage = jobIdsOnPage.filter((id) =>
    selectedJobIdSet.has(id),
  ).length;
  const allJobsSelected =
    jobs.length > 0 && selectedJobCountOnPage === jobs.length;

  const submissionResumeIds = submissions
    .map((submission) => submission.latest_job)
    .filter((job) => isResumableJob(job))
    .map((job) => job.id);
  const submissionStopIds = submissions
    .map((submission) => submission.latest_job)
    .filter((job) => job && isActiveStatus(job.status))
    .map((job) => job.id);
  const jobResumeIds = jobs
    .filter((job) => isResumableJob(job))
    .map((job) => job.id);
  const jobStopIds = jobs
    .filter((job) => isActiveStatus(job.status))
    .map((job) => job.id);
  const failedJobs = useMemo(
    () => jobReviewRows.filter((job) => job.status === "failed"),
    [jobReviewRows],
  );
  const requeuedJobs = useMemo(
    () =>
      jobReviewRows.filter(
        (job) => job.is_requeued || job.job_type === "reprocess",
      ),
    [jobReviewRows],
  );
  const filteredRequeuedJobs = useMemo(
    () => filterJobsByControls(requeuedJobs, requeueFilters),
    [requeuedJobs, requeueFilters],
  );
  const filteredFailedJobs = useMemo(
    () => filterJobsByControls(failedJobs, failedFilters),
    [failedJobs, failedFilters],
  );

  const selectedRequeueJobIdSet = useMemo(
    () => new Set(selectedRequeueJobIds),
    [selectedRequeueJobIds],
  );
  const requeueJobIdsOnPage = useMemo(
    () => filteredRequeuedJobs.map((job) => job.id),
    [filteredRequeuedJobs],
  );
  const selectedRequeueCountOnPage = requeueJobIdsOnPage.filter((id) =>
    selectedRequeueJobIdSet.has(id),
  ).length;
  const allRequeueSelected =
    filteredRequeuedJobs.length > 0 &&
    selectedRequeueCountOnPage === filteredRequeuedJobs.length;
  const selectedRequeueSubmissionIds = getUniqueSubmissionIds(
    filteredRequeuedJobs,
    selectedRequeueJobIdSet,
  );
  const requeueSubmissionIds = getUniqueSubmissionIds(filteredRequeuedJobs);

  const selectedFailedJobIdSet = useMemo(
    () => new Set(selectedFailedJobIds),
    [selectedFailedJobIds],
  );
  const failedJobIdsOnPage = useMemo(
    () => filteredFailedJobs.map((job) => job.id),
    [filteredFailedJobs],
  );
  const selectedFailedCountOnPage = failedJobIdsOnPage.filter((id) =>
    selectedFailedJobIdSet.has(id),
  ).length;
  const allFailedSelected =
    filteredFailedJobs.length > 0 &&
    selectedFailedCountOnPage === filteredFailedJobs.length;
  const selectedFailedSubmissionIds = getUniqueSubmissionIds(
    filteredFailedJobs,
    selectedFailedJobIdSet,
  );
  const failedSubmissionIds = getUniqueSubmissionIds(filteredFailedJobs);

  const selectedDuplicateReviewIdSet = useMemo(
    () => new Set(selectedDuplicateReviewIds),
    [selectedDuplicateReviewIds],
  );
  const duplicateIdsOnPage = useMemo(
    () => duplicateReviews.map((review) => review.id),
    [duplicateReviews],
  );
  const selectedDuplicateCount = selectedDuplicateReviewIds.length;
  const selectedDuplicateCountOnPage = duplicateIdsOnPage.filter((id) =>
    selectedDuplicateReviewIdSet.has(id),
  ).length;
  const allDuplicatesSelected =
    duplicateReviews.length > 0 &&
    selectedDuplicateCountOnPage === duplicateReviews.length;
  const selectedDuplicateConfirmIds = duplicateReviews
    .filter(
      (review) =>
        selectedDuplicateReviewIdSet.has(review.id) &&
        !review.existing_book_deleted,
    )
    .map((review) => review.id);
  const selectedDuplicateDismissIds = duplicateReviews
    .filter((review) => selectedDuplicateReviewIdSet.has(review.id))
    .map((review) => review.id);
  const selectedSubmissionResumeIds = submissions
    .filter((submission) => selectedSubmissionIdSet.has(submission.id))
    .map((submission) => submission.latest_job)
    .filter((job) => isResumableJob(job))
    .map((job) => job.id);
  const selectedSubmissionStopIds = submissions
    .filter((submission) => selectedSubmissionIdSet.has(submission.id))
    .map((submission) => submission.latest_job)
    .filter((job) => job && isActiveStatus(job.status))
    .map((job) => job.id);
  const selectedJobResumeIds = jobs
    .filter((job) => selectedJobIdSet.has(job.id) && isResumableJob(job))
    .map((job) => job.id);
  const selectedJobStopIds = jobs
    .filter((job) => selectedJobIdSet.has(job.id) && isActiveStatus(job.status))
    .map((job) => job.id);

  useEffect(() => {
    setSelectedRequeueJobIds((current) =>
      current.filter((id) => requeuedJobs.some((job) => job.id === id)),
    );
  }, [requeuedJobs]);

  useEffect(() => {
    setSelectedFailedJobIds((current) =>
      current.filter((id) => failedJobs.some((job) => job.id === id)),
    );
  }, [failedJobs]);

  useEffect(() => {
    setSelectedDuplicateReviewIds((current) =>
      current.filter((id) => duplicateReviews.some((review) => review.id === id)),
    );
  }, [duplicateReviews]);

  useEffect(() => {
    if (!requeuedJobs.length) {
      setActiveRequeueJobId("");
      return;
    }

    const exists = requeuedJobs.some((job) => job.id === activeRequeueJobId);
    if (!exists) {
      setActiveRequeueJobId(requeuedJobs[0].id);
    }
  }, [activeRequeueJobId, requeuedJobs]);

  useEffect(() => {
    if (!failedJobs.length) {
      setActiveFailedJobId("");
      setActiveFailedJobLogs([]);
      return;
    }

    const exists = failedJobs.some((job) => job.id === activeFailedJobId);
    if (!exists) {
      setActiveFailedJobId(failedJobs[0].id);
    }
  }, [activeFailedJobId, failedJobs]);

  useEffect(() => {
    if (!activeFailedJobId) {
      setActiveFailedJobLogs([]);
      return;
    }

    let cancelled = false;
    setLoadingFailedLogs(true);
    apiFetch(`/ingestion/jobs/${activeFailedJobId}/logs/`)
      .then((payload) => {
        if (!cancelled) {
          setActiveFailedJobLogs(payload || []);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFailedLogs(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeFailedJobId]);

  useEffect(() => {
    if (!filteredRequeuedJobs.length) {
      setActiveRequeueJobId("");
      return;
    }

    const exists = filteredRequeuedJobs.some(
      (job) => job.id === activeRequeueJobId,
    );
    if (!exists) {
      setActiveRequeueJobId(filteredRequeuedJobs[0].id);
    }
  }, [activeRequeueJobId, filteredRequeuedJobs]);

  useEffect(() => {
    if (!filteredFailedJobs.length) {
      setActiveFailedJobId("");
      setActiveFailedJobLogs([]);
      return;
    }

    const exists = filteredFailedJobs.some(
      (job) => job.id === activeFailedJobId,
    );
    if (!exists) {
      setActiveFailedJobId(filteredFailedJobs[0].id);
    }
  }, [activeFailedJobId, filteredFailedJobs]);

  function renderCardHeaderSearch({
    filters,
    setFilters,
    fields,
    defaultFilters,
    filtersExpanded,
    setFiltersExpanded,
    searchPlaceholder,
    resultCount,
    resultCountLoading = false,
    drawerId,
    onSubmit,
    onSearchClear,
    buttonsDisabled = false,
  }) {
    return (
      <CatalogSearchRow
        filters={filters}
        setFilters={setFilters}
        fields={fields}
        defaultFilters={defaultFilters}
        filtersExpanded={filtersExpanded}
        setFiltersExpanded={setFiltersExpanded}
        searchPlaceholder={searchPlaceholder}
        resultCount={resultCount}
        resultCountLoading={resultCountLoading}
        drawerId={drawerId}
        compact
        onSubmit={onSubmit}
        onSearchClear={onSearchClear}
        buttonsDisabled={buttonsDisabled}
      />
    );
  }

  function renderUserOverviewCard() {
    const countPill = (
      <span className="processing-card-count">
        {submissionsLoading ? (
          <LoadingSpinner size={14} />
        ) : (
          submissionOverview.total
        )}
      </span>
    );

    return (
      <section className="detail-card processing-card processing-summary-card">
        <div className="processing-card-head">
          <div className="section-title-block">
            <h2>My Requests Overview</h2>
          </div>
          {countPill}
        </div>
        {submissionsLoading ? (
          renderProcessingCardLoader("Loading my requests overview")
        ) : (
          <div className="processing-summary-bar processing-summary-bar--catalog">
            {[
              ["Resolving", submissionOverview.pending_resolution],
              ["Queued", submissionOverview.queued],
              ["Processing", submissionOverview.processing],
              ["Needs Review", submissionOverview.needs_review],
              ["Ready", submissionOverview.ready],
              ["Failed", submissionOverview.failed],
              ["Stopped", submissionOverview.stopped],
              ["Duplicate", submissionOverview.duplicate],
            ].map(([label, value]) => (
              <article key={label} className="processing-summary-stat">
                <span className="fact-label">{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderSubmissionsCard(title, cardClassName = "") {
    return (
      <QueueTableCard
        title={title}
        emptyTitle="No requests"
        cardClassName={cardClassName}
        loading={submissionsLoading}
        loadingLabel={`Loading ${title.toLowerCase()}`}
        headerAside={renderCardHeaderSearch({
          filters: submissionFilters,
          setFilters: setSubmissionFilters,
          fields: submissionFilterFields,
          defaultFilters: defaultSubmissionFilters,
          filtersExpanded: submissionFiltersExpanded,
          setFiltersExpanded: setSubmissionFiltersExpanded,
          searchPlaceholder: "Search requests",
          resultCount: submissions.length,
          resultCountLoading: submissionsLoading,
          drawerId: `${activeTab}-submission-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setSubmissionFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_SUBMISSIONS], {
              nextSubmissionFilters: nextFilters,
            }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            setSubmissionFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_SUBMISSIONS], {
              nextSubmissionFilters: nextFilters,
            }).catch(() => {});
          },
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={submissionFilters}
            setFilters={setSubmissionFilters}
            fields={submissionFilterFields}
            defaultFilters={defaultSubmissionFilters}
            filtersExpanded={submissionFiltersExpanded}
            setFiltersExpanded={setSubmissionFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
              reloadScoped([LOAD_SCOPE_SUBMISSIONS], {
                nextSubmissionFilters: submissionFilters,
              }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(
                defaultSubmissionFilters,
                setSubmissionFilters,
                "nextSubmissionFilters",
                [LOAD_SCOPE_SUBMISSIONS],
              )
            }
            searchPlaceholder="Search requests"
            resultCount={submissions.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-submission-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={submissionsLoading}
          />
        }
        actions={
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedSubmissionResumeIds.length ||
                  bulkActionKey === "submissions:resume" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "submissions:resume",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-resume/", {
                        method: "POST",
                        body: { ids: selectedSubmissionResumeIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        resumed_count: "started",
                        skipped_invalid: "skipped",
                      }) || "Requests started.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "submissions:resume" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Resume selected",
                    selectedSubmissionResumeIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedSubmissionStopIds.length ||
                  bulkActionKey === "submissions:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "submissions:stop",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-stop/", {
                        method: "POST",
                        body: { ids: selectedSubmissionStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Requests stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "submissions:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Stop selected",
                    selectedSubmissionStopIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !selectedSubmissionCount ||
                  bulkActionKey === "submissions:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "submission-bulk",
                    selectedSubmissionIds,
                    "Delete selected requests",
                    "This will remove the selected requests in this list.",
                  )
                }
              >
                {selectedActionLabel(
                  "Delete selected",
                  selectedSubmissionCount,
                )}
              </button>
            </div>
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !submissionResumeIds.length ||
                  bulkActionKey === "submissions:resume" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "submissions:resume",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-resume/", {
                        method: "POST",
                        body: { ids: submissionResumeIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        resumed_count: "started",
                        skipped_invalid: "skipped",
                      }) || "Requests started.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "submissions:resume" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Resume all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !submissionStopIds.length ||
                  bulkActionKey === "submissions:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "submissions:stop",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-stop/", {
                        method: "POST",
                        body: { ids: submissionStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Requests stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "submissions:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Stop all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !submissions.length ||
                  bulkActionKey === "submissions:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "submission-bulk",
                    submissions.map((submission) => submission.id),
                    "Delete requests",
                    "This will remove every visible request in this list.",
                  )
                }
              >
                Delete all
              </button>
            </div>
          </div>
        }
      >
        {submissions.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allSubmissionsSelected}
                    onChange={() =>
                      setSelectedSubmissionIds((current) =>
                        toggleVisibleSelection(
                          current,
                          submissionIdsOnPage,
                          allSubmissionsSelected,
                        ),
                      )
                    }
                    aria-label={
                      allSubmissionsSelected
                        ? "Clear visible request selections"
                        : "Select all visible requests"
                    }
                  />
                </th>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-book">Book</th>
                <th className="processing-col-time">Updated</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((submission) => {
                const latestJob = submission.latest_job || null;
                const isBusy =
                  busyActionId === submission.id ||
                  busyActionId === latestJob?.id;
                const isDeleting =
                  busyDeleteId === `submission:${submission.id}`;
                const isSelected = selectedSubmissionIdSet.has(submission.id);
                const primaryError =
                  submission.error_message || latestJob?.last_error || "";
                const showDelete = true;

                return (
                  <tr key={submission.id}>
                    <td className="processing-col-select">
                      <input
                        type="checkbox"
                        className="processing-checkbox"
                        checked={isSelected}
                        onChange={() =>
                          setSelectedSubmissionIds((current) =>
                            toggleSelectedId(current, submission.id),
                          )
                        }
                        aria-label={`Select request ${getRequestPrimaryText(submission.original_input)}`}
                      />
                    </td>
                    <td className="processing-col-request">
                      <RequestValue
                        value={submission.original_input}
                        error={primaryError}
                      />
                    </td>
                    <td>
                      <StatusPill value={submission.status} />
                    </td>
                    <td>
                      <BookLinkCell submission={submission} />
                    </td>
                    <td>
                      {formatBookDateTime(getSubmissionActivityAt(submission))}
                    </td>
                    <td>
                      <div className="table-actions">
                        {submission.linked_book_slug ? (
                          <BookRouteLink
                            slug={submission.linked_book_slug}
                            className="ghost-button"
                          >
                            Open
                          </BookRouteLink>
                        ) : submission.linked_book_deleted ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => retrySubmission(submission.id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Queueing..." : "Recreate"}
                          </button>
                        ) : submission.resolution_status === "ambiguous" &&
                          submission.candidates?.length ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setReviewSubmission(submission)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            Review
                          </button>
                        ) : latestJob?.status === "queued" &&
                          !latestJob.task_id ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => resumeJob(latestJob.id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Starting..." : "Start"}
                          </button>
                        ) : latestJob && isActiveStatus(latestJob.status) ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => stopJob(latestJob.id)}
                            disabled={isBusy || sourceTabButtonsDisabled}
                          >
                            {isBusy ? "Stopping..." : "Stop"}
                          </button>
                        ) : [
                            "deleted",
                            "failed",
                            "stopped",
                            "needs_review",
                          ].includes(submission.status) ||
                          latestJob?.status === "failed" ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => retrySubmission(submission.id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Queueing..." : "Retry"}
                          </button>
                        ) : (
                          <span className="table-note">-</span>
                        )}
                        {showDelete ? (
                          <button
                            type="button"
                            className="ghost-button danger-button processing-inline-danger"
                            onClick={() =>
                              openDeleteDialog(
                                "submission-single",
                                [submission.id],
                                "Delete request",
                                "This request will be removed from the queue.",
                              )
                            }
                            disabled={isDeleting || sourceTabButtonsDisabled}
                          >
                            {isDeleting ? "Deleting..." : "Delete"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderJobsCard(title, cardClassName = "") {
    return (
      <QueueTableCard
        title={title}
        emptyTitle="No book creation"
        cardClassName={cardClassName}
        loading={jobsLoading}
        loadingLabel={`Loading ${title.toLowerCase()}`}
        headerAside={renderCardHeaderSearch({
          filters: jobFilters,
          setFilters: setJobFilters,
          fields: jobFilterFields,
          defaultFilters: defaultJobFilters,
          filtersExpanded: jobFiltersExpanded,
          setFiltersExpanded: setJobFiltersExpanded,
          searchPlaceholder: "Search book creation",
          resultCount: jobs.length,
          resultCountLoading: jobsLoading,
          drawerId: `${activeTab}-job-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setJobFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_JOBS], {
              nextJobFilters: nextFilters,
            }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            setJobFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_JOBS], {
              nextJobFilters: nextFilters,
            }).catch(() => {});
          },
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={jobFilters}
            setFilters={setJobFilters}
            fields={jobFilterFields}
            defaultFilters={defaultJobFilters}
            filtersExpanded={jobFiltersExpanded}
            setFiltersExpanded={setJobFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
              reloadScoped([LOAD_SCOPE_JOBS], {
                nextJobFilters: jobFilters,
              }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(
                defaultJobFilters,
                setJobFilters,
                "nextJobFilters",
                [LOAD_SCOPE_JOBS],
              )
            }
            searchPlaceholder="Search book creation"
            resultCount={jobs.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-job-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={jobsLoading}
          />
        }
        actions={
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedJobResumeIds.length ||
                  bulkActionKey === "jobs:resume" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "jobs:resume",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-resume/", {
                        method: "POST",
                        body: { ids: selectedJobResumeIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        resumed_count: "started",
                        skipped_invalid: "skipped",
                      }) || "Book creation started.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "jobs:resume" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Resume selected",
                    selectedJobResumeIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedJobStopIds.length ||
                  bulkActionKey === "jobs:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "jobs:stop",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-stop/", {
                        method: "POST",
                        body: { ids: selectedJobStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Book creation stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "jobs:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Stop selected",
                    selectedJobStopIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !selectedJobCount ||
                  bulkActionKey === "jobs:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "job-bulk",
                    selectedJobIds,
                    "Delete selected book creation rows",
                    "This will remove the selected book creation rows.",
                  )
                }
              >
                {selectedActionLabel("Delete selected", selectedJobCount)}
              </button>
            </div>
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !jobResumeIds.length ||
                  bulkActionKey === "jobs:resume" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "jobs:resume",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-resume/", {
                        method: "POST",
                        body: { ids: jobResumeIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        resumed_count: "started",
                        skipped_invalid: "skipped",
                      }) || "Book creation started.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "jobs:resume" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Resume all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !jobStopIds.length ||
                  bulkActionKey === "jobs:stop" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  runBulkAction(
                    "jobs:stop",
                    () =>
                      apiFetch("/ingestion/jobs/bulk-stop/", {
                        method: "POST",
                        body: { ids: jobStopIds },
                      }),
                    (payload) =>
                      summarizeResponse(payload, {
                        stopped_count: "stopped",
                        skipped_complete: "done",
                      }) || "Book creation stopped.",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "jobs:stop" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Stop all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button danger-button processing-inline-danger"
                disabled={
                  !jobs.length ||
                  bulkActionKey === "jobs:delete" ||
                  sourceTabButtonsDisabled
                }
                onClick={() =>
                  openDeleteDialog(
                    "job-bulk",
                    jobs.map((job) => job.id),
                    "Delete book creation",
                    "This will remove every visible row in this book creation list.",
                  )
                }
              >
                Delete all
              </button>
            </div>
          </div>
        }
      >
        {jobs.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allJobsSelected}
                    onChange={() =>
                      setSelectedJobIds((current) =>
                        toggleVisibleSelection(
                          current,
                          jobIdsOnPage,
                          allJobsSelected,
                        ),
                      )
                    }
                    aria-label={
                      allJobsSelected
                        ? "Clear visible book creation selections"
                        : "Select all visible book creation rows"
                    }
                  />
                </th>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-type">Step</th>
                <th className="processing-col-time">Updated</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const isBusy = busyActionId === job.id;
                const isDeleting = busyDeleteId === `job:${job.id}`;
                const isSelected = selectedJobIdSet.has(job.id);
                return (
                  <tr key={job.id}>
                    <td className="processing-col-select">
                      <input
                        type="checkbox"
                        className="processing-checkbox"
                        checked={isSelected}
                        onChange={() =>
                          setSelectedJobIds((current) =>
                            toggleSelectedId(current, job.id),
                          )
                        }
                        aria-label={`Select job ${getRequestPrimaryText(job.submission_input)}`}
                      />
                    </td>
                    <td className="processing-col-request">
                      <RequestValue
                        value={job.submission_input}
                        error={job.last_error}
                      />
                    </td>
                    <td>
                      <StatusPill value={job.status} />
                    </td>
                    <td>{jobTypeLabel(job.job_type)}</td>
                    <td>{formatBookDateTime(getJobActivityAt(job))}</td>
                    <td>
                      <div className="table-actions">
                        {job.target_book_slug ? (
                          <BookRouteLink
                            slug={job.target_book_slug}
                            className="ghost-button"
                          >
                            Open
                          </BookRouteLink>
                        ) : job.target_book_deleted ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => retrySubmission(job.submission_id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Queueing..." : "Recreate"}
                          </button>
                        ) : null}
                        {job.status === "queued" && !job.task_id ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => resumeJob(job.id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Starting..." : "Start"}
                          </button>
                        ) : isActiveStatus(job.status) ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => stopJob(job.id)}
                            disabled={isBusy || sourceTabButtonsDisabled}
                          >
                            {isBusy ? "Stopping..." : "Stop"}
                          </button>
                        ) : job.status === "stopped" ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => retrySubmission(job.submission_id)}
                            disabled={isBusy || creationActionsDisabled}
                          >
                            {isBusy ? "Resuming..." : "Resume"}
                          </button>
                        ) : job.target_book_slug ? null : (
                          <span className="table-note">-</span>
                        )}
                        <button
                          type="button"
                          className="ghost-button danger-button processing-inline-danger"
                          onClick={() =>
                            openDeleteDialog(
                              "job-single",
                              [job.id],
                              "Delete book creation",
                              "This row will be removed from book creation history.",
                            )
                          }
                          disabled={isDeleting || sourceTabButtonsDisabled}
                        >
                          {isDeleting ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderDuplicateCard(title) {
    if (!canManageProcessing) {
      return null;
    }

    return (
      <QueueTableCard
        title={title}
        emptyTitle="No duplicates"
        loading={reviewsLoading}
        loadingLabel={`Loading ${title.toLowerCase()}`}
        headerAside={renderCardHeaderSearch({
          filters: reviewFilters,
          setFilters: setReviewFilters,
          fields: reviewFilterFields,
          defaultFilters: defaultReviewFilters,
          filtersExpanded: reviewFiltersExpanded,
          setFiltersExpanded: setReviewFiltersExpanded,
          searchPlaceholder: "Search duplicate checks",
          resultCount: duplicateReviews.length,
          resultCountLoading: reviewsLoading,
          drawerId: `${activeTab}-review-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setReviewFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_REVIEWS], {
              nextReviewFilters: nextFilters,
            }).catch(() => {});
          },
          onSearchClear: (nextFilters) => {
            setReviewFilters(nextFilters);
            reloadScoped([LOAD_SCOPE_REVIEWS], {
              nextReviewFilters: nextFilters,
            }).catch(() => {});
          },
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={reviewFilters}
            setFilters={setReviewFilters}
            fields={reviewFilterFields}
            defaultFilters={defaultReviewFilters}
            filtersExpanded={reviewFiltersExpanded}
            setFiltersExpanded={setReviewFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
              reloadScoped([LOAD_SCOPE_REVIEWS], {
                nextReviewFilters: reviewFilters,
              }).catch(() => {});
            }}
            onReset={() =>
              resetWithLoad(
                defaultReviewFilters,
                setReviewFilters,
                "nextReviewFilters",
                [LOAD_SCOPE_REVIEWS],
              )
            }
            searchPlaceholder="Search duplicate checks"
            resultCount={duplicateReviews.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-review-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={reviewsLoading}
          />
        }
        actions={
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedDuplicateConfirmIds.length ||
                  bulkActionKey === "duplicate:confirm_existing" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  resolveDuplicateBulk(
                    selectedDuplicateConfirmIds,
                    "confirm_existing",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "duplicate:confirm_existing" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Use existing selected",
                    selectedDuplicateConfirmIds.length,
                  )}
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !selectedDuplicateDismissIds.length ||
                  bulkActionKey === "duplicate:dismiss" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  resolveDuplicateBulk(selectedDuplicateDismissIds, "dismiss")
                }
              >
                <span className="button-label">
                  {bulkActionKey === "duplicate:dismiss" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  {selectedActionLabel(
                    "Keep new selected",
                    selectedDuplicateDismissIds.length,
                  )}
                </span>
              </button>
            </div>
            <div className="processing-card-action-row">
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !duplicateReviews.some(
                    (review) => !review.existing_book_deleted,
                  ) ||
                  bulkActionKey === "duplicate:confirm_existing" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  resolveDuplicateBulk(
                    duplicateReviews
                      .filter((review) => !review.existing_book_deleted)
                      .map((review) => review.id),
                    "confirm_existing",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "duplicate:confirm_existing" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Use existing all
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={
                  !duplicateReviews.length ||
                  bulkActionKey === "duplicate:dismiss" ||
                  creationActionsDisabled
                }
                onClick={() =>
                  resolveDuplicateBulk(
                    duplicateReviews.map((review) => review.id),
                    "dismiss",
                  )
                }
              >
                <span className="button-label">
                  {bulkActionKey === "duplicate:dismiss" ? (
                    <LoadingSpinner size={14} />
                  ) : null}
                  Keep new all
                </span>
              </button>
            </div>
          </div>
        }
      >
        {duplicateReviews.length ? (
          <table className="simple-table processing-table">
            <thead>
              <tr>
                <th className="processing-col-select">
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allDuplicatesSelected}
                    onChange={() =>
                      setSelectedDuplicateReviewIds((current) =>
                        toggleVisibleSelection(
                          current,
                          duplicateIdsOnPage,
                          allDuplicatesSelected,
                        ),
                      )
                    }
                    aria-label={
                      allDuplicatesSelected
                        ? "Clear visible duplicate selections"
                        : "Select all visible duplicate checks"
                    }
                  />
                </th>
                <th className="processing-col-request">Request</th>
                <th className="processing-col-book">Existing</th>
                <th className="processing-col-status">Status</th>
                <th className="processing-col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {duplicateReviews.map((review) => (
                <tr key={review.id}>
                  <td className="processing-col-select">
                    <input
                      type="checkbox"
                      className="processing-checkbox"
                      checked={selectedDuplicateReviewIdSet.has(review.id)}
                      onChange={() =>
                        setSelectedDuplicateReviewIds((current) =>
                          toggleSelectedId(current, review.id),
                        )
                      }
                      aria-label={`Select duplicate check ${review.id}`}
                    />
                  </td>
                  <td className="processing-col-request">
                    <RequestValue value={review.submission?.original_input} />
                  </td>
                  <td>
                    {review.existing_book?.title ||
                      (review.existing_book_deleted ? "Deleted record" : "-")}
                  </td>
                  <td>
                    <StatusPill value={review.status} />
                  </td>
                  <td>
                    <div className="table-actions">
                      {!review.existing_book_deleted ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() =>
                            resolveDuplicate(review.id, "confirm_existing")
                          }
                          disabled={
                            busyActionId === review.id ||
                            creationActionsDisabled
                          }
                        >
                          Use existing
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => resolveDuplicate(review.id, "dismiss")}
                        disabled={
                          busyActionId === review.id || creationActionsDisabled
                        }
                      >
                        {review.existing_book_deleted ? "Recreate" : "Keep new"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </QueueTableCard>
    );
  }

  function renderRequeueReviewCard() {
    return (
      <ProcessingJobReviewCard
        visible
        title="Requeued Jobs Create Queue"
        emptyTitle="No requeued jobs match these filters"
        cardClassName="processing-requeue-card"
        loading={jobReviewsLoading}
        loadingLabel="Loading requeued jobs"
        headerAside={renderCardHeaderSearch({
          filters: requeueFilters,
          setFilters: setRequeueFilters,
          fields: jobFilterFields,
          defaultFilters: defaultJobFilters,
          filtersExpanded: requeueFiltersExpanded,
          setFiltersExpanded: setRequeueFiltersExpanded,
          searchPlaceholder: "Search requeued jobs",
          resultCount: filteredRequeuedJobs.length,
          resultCountLoading: jobReviewsLoading,
          drawerId: `${activeTab}-requeue-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setRequeueFilters(nextFilters);
          },
          onSearchClear: (nextFilters) => setRequeueFilters(nextFilters),
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={requeueFilters}
            setFilters={setRequeueFilters}
            fields={jobFilterFields}
            defaultFilters={defaultJobFilters}
            filtersExpanded={requeueFiltersExpanded}
            setFiltersExpanded={setRequeueFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
            }}
            onReset={() => {
              setRequeueFilters(defaultJobFilters);
              setRequeueFiltersExpanded(false);
            }}
            searchPlaceholder="Search requeued jobs"
            resultCount={filteredRequeuedJobs.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-requeue-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={jobReviewsLoading}
          />
        }
        jobs={filteredRequeuedJobs}
        selectedJobIdSet={selectedRequeueJobIdSet}
        allSelected={allRequeueSelected}
        jobIdsOnPage={requeueJobIdsOnPage}
        onToggleAll={() =>
          setSelectedRequeueJobIds((current) =>
            toggleVisibleSelection(
              current,
              requeueJobIdsOnPage,
              allRequeueSelected,
            ),
          )
        }
        onToggleJob={(jobId) =>
          setSelectedRequeueJobIds((current) => toggleSelectedId(current, jobId))
        }
        selectedSubmissionIds={selectedRequeueSubmissionIds}
        submissionIds={requeueSubmissionIds}
        actionKey="requeue:create"
        bulkActionKey={bulkActionKey}
        creationActionsDisabled={creationActionsDisabled}
        onCreate={retrySubmissionsBulk}
        selectedActionLabel={selectedActionLabel}
        activeJobId={activeRequeueJobId}
        onActiveJobChange={setActiveRequeueJobId}
        showStatusColumn
        detailTitle="Requeue Error Details"
        detailRegionAriaLabel="Requeue error details"
        emptySelectionMessage="No requeued job selected."
        renderDetailBody={(job) => <pre>{getRequeueReasonText(job)}</pre>}
        getRequestPrimaryText={getRequestPrimaryText}
        jobTypeLabel={jobTypeLabel}
        getJobActivityAt={getJobActivityAt}
        selectAllAriaLabel="Select all visible requeued jobs"
        clearAllAriaLabel="Clear visible requeued selections"
        rowAriaLabel={(job) => `Select requeued job ${job.id}`}
      />
    );
  }

  function renderFailedJobsCard() {
    return (
      <ProcessingJobReviewCard
        visible
        title="Failed Jobs Create Queue"
        emptyTitle="No failed jobs match these filters"
        cardClassName="processing-failed-card"
        loading={jobReviewsLoading}
        loadingLabel="Loading failed jobs"
        headerAside={renderCardHeaderSearch({
          filters: failedFilters,
          setFilters: setFailedFilters,
          fields: jobFilterFields,
          defaultFilters: defaultJobFilters,
          filtersExpanded: failedFiltersExpanded,
          setFiltersExpanded: setFailedFiltersExpanded,
          searchPlaceholder: "Search failed jobs",
          resultCount: filteredFailedJobs.length,
          resultCountLoading: jobReviewsLoading,
          drawerId: `${activeTab}-failed-filters`,
          onSubmit: (event, nextFilters) => {
            event.preventDefault();
            setFailedFilters(nextFilters);
          },
          onSearchClear: (nextFilters) => setFailedFilters(nextFilters),
          buttonsDisabled: sourceTabButtonsDisabled,
        })}
        toolbar={
          <CatalogToolbar
            filters={failedFilters}
            setFilters={setFailedFilters}
            fields={jobFilterFields}
            defaultFilters={defaultJobFilters}
            filtersExpanded={failedFiltersExpanded}
            setFiltersExpanded={setFailedFiltersExpanded}
            onSubmit={(event) => {
              event.preventDefault();
            }}
            onReset={() => {
              setFailedFilters(defaultJobFilters);
              setFailedFiltersExpanded(false);
            }}
            searchPlaceholder="Search failed jobs"
            resultCount={filteredFailedJobs.length}
            showSearchRow={false}
            inline
            drawerId={`${activeTab}-failed-filters`}
            buttonsDisabled={sourceTabButtonsDisabled}
            buttonsLoading={jobReviewsLoading}
          />
        }
        jobs={filteredFailedJobs}
        selectedJobIdSet={selectedFailedJobIdSet}
        allSelected={allFailedSelected}
        jobIdsOnPage={failedJobIdsOnPage}
        onToggleAll={() =>
          setSelectedFailedJobIds((current) =>
            toggleVisibleSelection(current, failedJobIdsOnPage, allFailedSelected),
          )
        }
        onToggleJob={(jobId) =>
          setSelectedFailedJobIds((current) => toggleSelectedId(current, jobId))
        }
        selectedSubmissionIds={selectedFailedSubmissionIds}
        submissionIds={failedSubmissionIds}
        actionKey="failed:create"
        bulkActionKey={bulkActionKey}
        creationActionsDisabled={creationActionsDisabled}
        onCreate={retrySubmissionsBulk}
        selectedActionLabel={selectedActionLabel}
        activeJobId={activeFailedJobId}
        onActiveJobChange={setActiveFailedJobId}
        layoutClassName="processing-failed-layout"
        tableWrapClassName="processing-failed-table-wrap"
        detailTitle="Failure Cause & Log"
        detailRegionAriaLabel="Failed job error and logs"
        emptySelectionMessage="No failed job selected."
        renderDetailBody={(job) => (
          <>
            <pre>{job.last_error || "No error message found."}</pre>
            <hr />
            {loadingFailedLogs ? (
              <p className="table-note">Loading logs...</p>
            ) : activeFailedJobLogs.length ? (
              <pre>
                {activeFailedJobLogs
                  .map(
                    (entry) =>
                      `${entry.created_at} [${entry.level}] ${entry.message}`,
                  )
                  .join("\n")}
              </pre>
            ) : (
              <p className="table-note">No logs found for this job.</p>
            )}
          </>
        )}
        getRequestPrimaryText={getRequestPrimaryText}
        jobTypeLabel={jobTypeLabel}
        getJobActivityAt={getJobActivityAt}
        selectAllAriaLabel="Select all visible failed jobs"
        clearAllAriaLabel="Clear visible failed selections"
        rowAriaLabel={(job) => `Select failed job ${job.id}`}
      />
    );
  }

  function renderUserTab() {
    return (
      <div className="processing-section-grid">
        {renderUserOverviewCard()}
        {renderSubmissionsCard("Requests")}
        {renderJobsCard("Book Creation")}
        {renderRequeueReviewCard()}
        {renderFailedJobsCard()}
        {renderDuplicateCard("Duplicate Checks")}
      </div>
    );
  }

  return (
    <div
      className={`page-stack processing-page${globalActionsLocked ? " is-actions-locked" : ""}`}
    >
      <section className="detail-card">
        <div className="panel-header">
          <div className="section-title-block">
            <h1>My Requests</h1>
          </div>
          {loading || processingActivityBusy ? (
            <LoadingSpinner size={18} />
          ) : null}
        </div>
        {error ? (
          <div className="page-state page-state-error">{error}</div>
        ) : null}
      </section>

      {renderUserTab()}

      {reviewSubmission ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="dialog-card" role="dialog" aria-modal="true">
            <div className="dialog-header">
              <h2>Review Match</h2>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setReviewSubmission(null)}
              >
                Close
              </button>
            </div>
            <div className="dialog-stack">
              {reviewSubmission.candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="candidate-button"
                  onClick={() =>
                    confirmCandidate(reviewSubmission.id, candidate.id)
                  }
                >
                  <span>{candidate.candidate_title}</span>
                  <small>
                    {candidate.candidate_author ||
                      `${Math.round(candidate.confidence * 100)}%`}
                  </small>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <ConfirmationDialog
        open={Boolean(confirmState)}
        title={confirmState?.title || ""}
        body={confirmState?.body || ""}
        confirmLabel="Delete"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmState(null)}
        loading={confirmLoading}
      />
    </div>
  );
}
