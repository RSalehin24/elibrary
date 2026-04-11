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
  return jobRows.filter((job) => {
    if (filters.status && job.status !== filters.status) {
      return false;
    }
    if (filters.job_type && job.job_type !== filters.job_type) {
      return false;
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
