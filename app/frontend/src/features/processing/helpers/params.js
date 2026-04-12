import {
  AUTOMATION_TAB,
  INCOMPLETE_TAB,
  SOURCE_TAB,
  USER_TAB,
  defaultJobFilters,
} from "../constants";
import { cutoffForPeriod } from "./activity";

export function getOriginForTab(tab) {
  if (tab === SOURCE_TAB || tab === INCOMPLETE_TAB) {
    return "curation";
  }
  if (tab === AUTOMATION_TAB) {
    return "automation";
  }
  if (tab === USER_TAB) {
    return "user";
  }
  return "";
}

export function normalizeStatusForApi(value) {
  return value === "stopped" ? "cancelled" : value;
}

export function buildJobsParams(filters, tab) {
  const { range = "", ...rawFilters } = filters || {};
  const params = {
    q: rawFilters.q,
    limit: 60,
  };
  if (rawFilters.status) {
    const normalizedStatus = normalizeStatusForApi(rawFilters.status);
    if (
      ["succeeded", "queued", "processing", "failed", "cancelled"].includes(
        normalizedStatus,
      )
    ) {
      params.status = normalizedStatus;
    } else if (
      ["needs_review", "ready", "duplicate"].includes(normalizedStatus)
    ) {
      params.submission_status = normalizedStatus;
    }
  }
  if (range) {
    params.created_after = cutoffForPeriod(range).toISOString();
  }
  const origin = getOriginForTab(tab);
  if (origin) {
    params.origin = origin;
  }
  return params;
}

export function isDefaultJobRequest(filters) {
  return (
    String(filters?.q || "") === defaultJobFilters.q &&
    String(filters?.status || "") === defaultJobFilters.status &&
    String(filters?.range || "") === defaultJobFilters.range
  );
}

export function buildSubmissionParams(filters, tab) {
  const { range = "", ...rawFilters } = filters || {};
  const params = { ...rawFilters, limit: 60 };
  if (params.status) {
    params.status = normalizeStatusForApi(params.status);
  }
  if (range) {
    params.created_after = cutoffForPeriod(range).toISOString();
  }
  const origin = getOriginForTab(tab);
  if (origin) {
    params.origin = origin;
  }
  return params;
}

export function buildReviewParams(filters, tab) {
  const params = { ...filters, limit: 40 };
  const origin = getOriginForTab(tab);
  if (origin) {
    params.origin = origin;
  }
  return params;
}

export function buildRunParams(filters, tab) {
  const params = { ...filters, limit: 20 };
  if (params.status) {
    params.status = normalizeStatusForApi(params.status);
  }
  if (tab === AUTOMATION_TAB) {
    params.trigger = "scheduled";
  }
  return params;
}
