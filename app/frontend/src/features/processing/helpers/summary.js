export function buildSubmissionOverviewSummary(submissionRows) {
  return (submissionRows || []).reduce(
    (summary, submission) => {
      const status = submission?.status;
      if (status && Object.hasOwn(summary, status)) {
        summary[status] += 1;
      }
      summary.total += 1;
      return summary;
    },
    {
      total: 0,
      pending_resolution: 0,
      queued: 0,
      processing: 0,
      needs_review: 0,
      ready: 0,
      failed: 0,
      stopped: 0,
      duplicate: 0,
    },
  );
}

export function summarizeResponse(payload, labels) {
  const parts = Object.entries(labels)
    .map(([key, label]) => {
      const value = payload?.[key];
      return typeof value === "number" && value ? `${value} ${label}` : "";
    })
    .filter(Boolean);

  return parts.join(" · ");
}
