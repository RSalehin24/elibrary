export function normalizeTimeInput(value) {
  return (value || "02:00:00").slice(0, 5);
}

export function automationFormFromSettings(settings) {
  return {
    enabled: Boolean(settings?.enabled),
    daily_run_time: normalizeTimeInput(settings?.daily_run_time),
    frequency: settings?.frequency || "daily",
    mode: settings?.mode || "pending",
    refresh_max_pages: String(settings?.refresh_max_pages || 80),
  };
}

export function runTypeLabel(run) {
  return run.trigger === "scheduled" ? "Scheduled" : "Manual";
}

export function runModeLabel(mode) {
  return mode === "all" ? "All tracked" : "New + unfinished";
}

export function runSummaryLabel(run) {
  const summary = run.summary || {};
  return [
    `${summary.queued_creates || 0} create`,
    `${summary.queued_updates || 0} update`,
    `${summary.skipped_ready || 0} ready`,
  ].join(" · ");
}
