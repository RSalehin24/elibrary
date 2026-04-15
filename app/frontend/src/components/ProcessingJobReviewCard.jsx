import EmptyState from "./EmptyState";
import StatusPill from "./StatusPill";
import { formatBookDateTime } from "../utils/bookPresentation";
import {
  ProcessingTableSkeletonActions,
  ProcessingTableSkeletonCheckbox,
  ProcessingTableSkeletonStack,
} from "../features/processing/components/ProcessingScaffold";

export default function ProcessingJobReviewCard({
  visible,
  title,
  emptyTitle,
  cardClassName = "",
  loading = false,
  loadingLabel = "",
  headerAside,
  toolbar,
  actions,
  jobs,
  selectedJobIdSet,
  allSelected,
  jobIdsOnPage,
  onToggleAll,
  onToggleJob,
  selectedSubmissionIds,
  actionKey,
  bulkActionKey,
  creationActionsDisabled,
  onCreate,
  selectedActionLabel,
  showCreateActions = true,
  createSelectedLabel = "Create selected",
  activeJobId,
  onActiveJobChange,
  showStatusColumn = false,
  showDetailPanel = true,
  layoutClassName = "processing-requeue-layout",
  tableWrapClassName = "processing-requeue-table-wrap",
  detailTitle,
  detailRegionAriaLabel,
  emptySelectionMessage,
  renderDetailBody,
  errorColumnLabel = "",
  renderErrorCell = null,
  getRequestPrimaryText,
  jobTypeLabel,
  getJobActivityAt,
  selectAllAriaLabel,
  clearAllAriaLabel,
  rowAriaLabel,
  replaceOnLoading = false,
}) {
  if (!visible) {
    return null;
  }

  const activeJob = showDetailPanel
    ? jobs.find((job) => job.id === activeJobId) || jobs[0] || null
    : null;
  const shellContent = loading || jobs.length ? (
    <div className={showDetailPanel ? layoutClassName : undefined}>
      <div className={tableWrapClassName}>
        <table className="simple-table processing-table">
          <thead>
            <tr>
              <th className="processing-col-select processing-incomplete-col-select">
                {loading ? (
                  <ProcessingTableSkeletonCheckbox />
                ) : (
                  <input
                    type="checkbox"
                    className="processing-checkbox"
                    checked={allSelected}
                    onChange={onToggleAll}
                    aria-label={
                      allSelected ? clearAllAriaLabel : selectAllAriaLabel
                    }
                  />
                )}
              </th>
              <th className="processing-col-request">Request</th>
              {showStatusColumn ? (
                <th className="processing-col-status">Status</th>
              ) : null}
              <th className="processing-col-type">Step</th>
              <th className="processing-col-time">Updated</th>
              {errorColumnLabel ? (
                <th className="processing-col-error">{errorColumnLabel}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {(loading ? Array.from({ length: 5 }, (_, index) => index) : jobs).map(
              (jobOrIndex) => {
              if (loading) {
                return (
                  <tr key={`loading-${jobOrIndex}`}>
                    <td className="processing-col-select processing-incomplete-col-select">
                      <ProcessingTableSkeletonCheckbox />
                    </td>
                    <td className="processing-col-request processing-incomplete-col-book">
                      <ProcessingTableSkeletonStack lines={["xl", "sm"]} />
                    </td>
                    {showStatusColumn ? (
                      <td>
                        <ProcessingTableSkeletonStack lines={["sm"]} />
                      </td>
                    ) : null}
                    <td>
                      <ProcessingTableSkeletonStack lines={["sm"]} />
                    </td>
                    <td>
                      <ProcessingTableSkeletonStack lines={["sm"]} />
                    </td>
                    {errorColumnLabel ? (
                      <td className="processing-col-error">
                        <ProcessingTableSkeletonStack lines={["xl", "sm"]} />
                      </td>
                    ) : null}
                  </tr>
                );
              }

              const job = jobOrIndex;
              const isActive = showDetailPanel && activeJob?.id === job.id;
              const requestText = getRequestPrimaryText(job.submission_input);

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
                    {showDetailPanel ? (
                      <button
                        type="button"
                        className="ghost-button processing-requeue-select"
                        onClick={() => onActiveJobChange(job.id)}
                      >
                        {requestText}
                      </button>
                    ) : (
                      requestText
                    )}
                  </td>
                  {showStatusColumn ? (
                    <td>
                      <StatusPill value={job.status} />
                    </td>
                  ) : null}
                  <td>{jobTypeLabel(job.job_type)}</td>
                  <td>{formatBookDateTime(getJobActivityAt(job))}</td>
                  {errorColumnLabel ? (
                    <td className="processing-col-error">
                      {renderErrorCell ? renderErrorCell(job) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showDetailPanel ? (
        <aside className="processing-requeue-error-panel">
          {detailTitle ? <h3>{detailTitle}</h3> : null}
          {!loading && activeJob ? (
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
            loading ? (
              <ProcessingTableSkeletonStack lines={["lg", "xl", "xl"]} />
            ) : (
              <p className="table-note">{emptySelectionMessage}</p>
            )
          )}
        </aside>
      ) : null}
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
      {actions ? (
        <div className="processing-bulk-bar">{actions}</div>
      ) : showCreateActions ? (
        <div className="processing-bulk-bar">
          <div className="processing-card-actions processing-card-actions-grouped">
            <div className="processing-card-action-row">
              {loading ? (
                <ProcessingTableSkeletonActions />
              ) : (
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
                    createSelectedLabel,
                    selectedSubmissionIds.length,
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      <div
        className={`processing-table-shell${loading && replaceOnLoading ? " is-loading" : ""}`}
      >
        {shellContent}
      </div>
    </section>
  );
}
