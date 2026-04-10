export function cutoffForPeriod(period) {
  const now = new Date();
  if (period === "day") {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
  if (period === "week") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (period === "month") {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
}

export function isActiveStatus(value) {
  return ["queued", "processing"].includes(value);
}

export function isResumableJob(job) {
  if (!job) {
    return false;
  }
  if (job.status === "stopped") {
    return true;
  }
  return job.status === "queued" && !job.task_id;
}

export function isCatalogSyncActive(value) {
  return ["queued", "processing"].includes(value);
}

export function getSubmissionActivityAt(submission) {
  return (
    submission.latest_job?.finished_at ||
    submission.latest_job?.started_at ||
    submission.latest_job?.updated_at ||
    submission.updated_at ||
    submission.created_at
  );
}

export function getJobActivityAt(job) {
  return job.finished_at || job.started_at || job.updated_at || job.created_at;
}

export function getRunActivityAt(run) {
  return run.finished_at || run.started_at || run.updated_at || run.created_at;
}

export function getCatalogEntryActivityAt(entry) {
  return entry.activity_at || entry.updated_at || entry.last_seen_at;
}

export function getRequeueReasonText(job) {
  return (
    job.requeue_reason ||
    job.last_error ||
    "No failure details were recorded for this requeue."
  );
}
