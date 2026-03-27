import EmptyState from "./EmptyState";
import LoadingSpinner from "./LoadingSpinner";
import StatusPill from "./StatusPill";
import { formatBookDateTime } from "../utils/bookPresentation";

function renderProcessingCardLoader(label) {
  const screenReaderLabel = label || "Loading";
  return (
    <div
      className="processing-inline-loader"
      role="status"
      aria-live="polite"
      aria-label={screenReaderLabel}
    >
      <LoadingSpinner size={16} />
      <span>Loading...</span>
    </div>
  );
}

export default function ProcessingJobReviewCard({
  visible,
  title,
  emptyTitle,
  cardClassName = "",
  loading = false,
  loadingLabel = "",
  headerAside,
  toolbar,
  jobs,
  selectedJobIdSet,
  allSelected,
  jobIdsOnPage,
  onToggleAll,
  onToggleJob,
  selectedSubmissionIds,
  submissionIds,
  actionKey,
  bulkActionKey,
  creationActionsDisabled,
  onCreate,
  selectedActionLabel,
  activeJobId,
  onActiveJobChange,
  showStatusColumn = false,
  layoutClassName = "processing-requeue-layout",
  tableWrapClassName = "processing-requeue-table-wrap",
  detailTitle,
  detailRegionAriaLabel,
  emptySelectionMessage,
  renderDetailBody,
  getRequestPrimaryText,
  jobTypeLabel,
  getJobActivityAt,
  selectAllAriaLabel,
  clearAllAriaLabel,
  rowAriaLabel,
}) {
  if (!visible) {
    return null;
  }

  const activeJob =
    jobs.find((job) => job.id === activeJobId) || jobs[0] || null;
  const shellContent = loading ? (
    renderProcessingCardLoader(loadingLabel || `Loading ${title.toLowerCase()}`)
  ) : jobs.length ? (
    <div className={layoutClassName}>
      <div className={tableWrapClassName}>
        <table className="simple-table processing-table">
          <thead>
            <tr>
              <th className="processing-col-select processing-incomplete-col-select">
                <input
                  type="checkbox"
                  className="processing-checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  aria-label={
                    allSelected ? clearAllAriaLabel : selectAllAriaLabel
                  }
                />
              </th>
              <th className="processing-col-request">Request</th>
              {showStatusColumn ? (
                <th className="processing-col-status">Status</th>
              ) : null}
              <th className="processing-col-type">Step</th>
              <th className="processing-col-time">Updated</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const isActive = activeJob?.id === job.id;

              return (
                <tr key={job.id} className={isActive ? "is-active-row" : ""}>
                  <td className="processing-col-select processing-incomplete-col-select">
                    <input
                      type="checkbox"
                      className="processing-checkbox"
                      checked={selectedJobIdSet.has(job.id)}
                      onChange={() => onToggleJob(job.id)}
                      aria-label={rowAriaLabel(job)}
                    />
                  </td>
                  <td className="processing-col-request processing-incomplete-col-book">
                    <button
                      type="button"
                      className="ghost-button processing-requeue-select"
                      onClick={() => onActiveJobChange(job.id)}
                    >
                      {getRequestPrimaryText(job.submission_input)}
                    </button>
                  </td>
                  {showStatusColumn ? (
                    <td>
                      <StatusPill value={job.status} />
                    </td>
                  ) : null}
                  <td>{jobTypeLabel(job.job_type)}</td>
                  <td>{formatBookDateTime(getJobActivityAt(job))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <aside className="processing-requeue-error-panel">
        <h3>{detailTitle}</h3>
        {activeJob ? (
          <>
            <p className="table-note">
              {getRequestPrimaryText(activeJob.submission_input)}
            </p>
            <div
              className="processing-requeue-error-scroll"
              role="region"
              aria-label={detailRegionAriaLabel}
            >
              {renderDetailBody(activeJob)}
            </div>
          </>
        ) : (
          <p className="table-note">{emptySelectionMessage}</p>
        )}
      </aside>
    </div>
  ) : (
    <EmptyState title={emptyTitle} />
  );

  return (
    <section
      className={`detail-card processing-card processing-list-card ${cardClassName}`.trim()}
    >
      <div className="processing-card-head">
        {headerAside ? (
          <div className="processing-card-head-meta">
            <div className="section-title-block">
              <h2>{title}</h2>
            </div>
          </div>
        ) : (
          <div className="section-title-block">
            <h2>{title}</h2>
          </div>
        )}
        {headerAside ? (
          <div className="processing-card-head-aside">{headerAside}</div>
        ) : null}
      </div>
      {toolbar ? (
        <div className="processing-card-toolbar">{toolbar}</div>
      ) : null}
      <div className="processing-bulk-bar">
        <div className="processing-card-actions processing-card-actions-grouped">
          <div className="processing-card-action-row">
            <button
              type="button"
              className="ghost-button"
              disabled={
                !selectedSubmissionIds.length ||
                bulkActionKey === actionKey ||
                creationActionsDisabled
              }
              onClick={() => onCreate(selectedSubmissionIds, actionKey)}
            >
              {selectedActionLabel(
                "Create selected",
                selectedSubmissionIds.length,
              )}
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={
                !submissionIds.length ||
                bulkActionKey === actionKey ||
                creationActionsDisabled
              }
              onClick={() => onCreate(submissionIds, actionKey)}
            >
              Create all
            </button>
          </div>
        </div>
      </div>
      <div className={`processing-table-shell${loading ? " is-loading" : ""}`}>
        {shellContent}
      </div>
    </section>
  );
}
