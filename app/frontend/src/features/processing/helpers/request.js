import { cutoffForPeriod, getJobActivityAt } from "./activity";

export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isUrlValue(value) {
  return (value || "").trim().startsWith("http");
}

export function getRequestPrimaryText(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return "-";
  }
  if (!isUrlValue(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const path = safeDecode(url.pathname).replace(/^\/+|\/+$/g, "");
    const label = path
      .replace(/^books\//, "")
      .replace(/-/g, " ")
      .trim();
    return label || safeDecode(trimmed);
  } catch {
    return safeDecode(trimmed);
  }
}

export function getRequestSecondaryText(value) {
  const trimmed = (value || "").trim();
  if (!trimmed || !isUrlValue(trimmed)) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    return `${url.hostname.replace(/^www\./, "")}${safeDecode(url.pathname)}`;
  } catch {
    return safeDecode(trimmed);
  }
}

export function getUniqueSubmissionIds(jobRows, selectedJobIdSet = null) {
  return Array.from(
    new Set(
      (jobRows || [])
        .filter(
          (job) =>
            job.submission_id &&
            (!selectedJobIdSet || selectedJobIdSet.has(job.id)),
        )
        .map((job) => job.submission_id),
    ),
  );
}

export function jobTypeLabel(jobType) {
  if (jobType === "ingestion") {
    return "Create";
  }
  if (jobType === "resolution") {
    return "Match";
  }
  if (jobType === "reprocess") {
    return "Regenerate";
  }
  return jobType;
}

export function filterJobsByControls(jobRows, filters) {
  const query = String(filters.q || "")
    .trim()
    .toLowerCase();
  const cutoff = filters.range ? cutoffForPeriod(filters.range) : null;
  return jobRows.filter((job) => {
    if (filters.status && job.status !== filters.status) {
      return false;
    }
    if (cutoff) {
      const activityAt = getJobActivityAt(job);
      if (!activityAt) {
        return false;
      }
      const activityTime = new Date(activityAt);
      if (Number.isNaN(activityTime.getTime()) || activityTime < cutoff) {
        return false;
      }
    }
    if (!query) {
      return true;
    }
    const requestText = getRequestPrimaryText(job.submission_input)
      .toLowerCase()
      .trim();
    const errorText = String(job.last_error || "").toLowerCase();
    return requestText.includes(query) || errorText.includes(query);
  });
}

export function filterCurrentFailedJobs(jobRows) {
  return (jobRows || []).filter(
    (job) => job?.status === "failed" && job?.submission_status === "failed",
  );
}

export function getSubmissionDisplayStatus(
  submission,
  failedSubmissionIdSet = null,
) {
  if (!submission) {
    return "";
  }

  const latestJobStatus = String(submission.latest_job?.status || "");
  const submissionStatus = String(submission.status || "");

  if (submissionStatus === "deleted") {
    return "deleted";
  }

  if (
    (submission.id && failedSubmissionIdSet?.has(submission.id)) ||
    latestJobStatus === "failed" ||
    submissionStatus === "failed"
  ) {
    return "failed";
  }

  if (latestJobStatus === "stopped" || submissionStatus === "stopped") {
    return "stopped";
  }

  if (latestJobStatus === "processing" || submissionStatus === "processing") {
    return "processing";
  }

  if (latestJobStatus === "queued" || submissionStatus === "queued") {
    return "queued";
  }

  return submissionStatus;
}

export function partitionSubmissionsForCards(
  submissionRows,
  failedSubmissionIdSet = null,
  excludedSubmissionIdSet = null,
) {
  return (submissionRows || []).reduce(
    (groups, submission) => {
      if (submission?.id && excludedSubmissionIdSet?.has(submission.id)) {
        return groups;
      }

      const displayStatus = getSubmissionDisplayStatus(
        submission,
        failedSubmissionIdSet,
      );

      if (displayStatus === "ready") {
        groups.ready.push(submission);
      } else if (displayStatus === "queued") {
        groups.queued.push(submission);
      } else if (displayStatus === "stopped") {
        groups.stopped.push(submission);
      } else if (displayStatus === "deleted") {
        groups.deleted.push(submission);
      } else if (displayStatus === "processing") {
        groups.processing.push(submission);
      } else if (displayStatus === "failed") {
        groups.failed.push(submission);
      } else if (displayStatus !== "duplicate") {
        groups.requests.push(submission);
      }

      return groups;
    },
    {
      requests: [],
      ready: [],
      queued: [],
      stopped: [],
      deleted: [],
      processing: [],
      failed: [],
    },
  );
}
