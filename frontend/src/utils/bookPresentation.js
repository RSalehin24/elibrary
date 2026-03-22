const STATUS_META = {
  draft: {
    label: "Draft",
    description: "This record is still being prepared."
  },
  processing: {
    label: "Processing",
    description: "The system is still generating or organizing this book."
  },
  queued: {
    label: "Queued",
    description: "This task is waiting to start."
  },
  ready: {
    label: "Ready",
    description: "This book is ready to open and download."
  },
  published: {
    label: "Published",
    description: "This record has been finalized for readers."
  },
  archived: {
    label: "Archived",
    description: "This record is kept for reference."
  },
  pending: {
    label: "Awaiting review",
    description: "Metadata exists, but no one has reviewed it yet."
  },
  needs_review: {
    label: "Needs review",
    description: "This record should be checked before users rely on it."
  },
  approved: {
    label: "Reviewed",
    description: "Metadata has been reviewed and approved."
  },
  rejected: {
    label: "Needs correction",
    description: "A reviewer requested changes to this metadata."
  },
  pending_resolution: {
    label: "Resolving source",
    description: "The system is still matching this submission to the right source."
  },
  ambiguous: {
    label: "Needs choice",
    description: "More than one possible source matched this title."
  },
  failed: {
    label: "Failed",
    description: "Something went wrong and needs attention."
  },
  cancelled: {
    label: "Cancelled",
    description: "This task was stopped before it finished."
  },
  duplicate: {
    label: "Duplicate",
    description: "This request matches an existing book."
  },
  new: {
    label: "New",
    description: "This source has not been created locally yet."
  },
  unfinished: {
    label: "Unfinished",
    description: "This source still needs another processing pass."
  },
  deleted: {
    label: "Deleted",
    description: "This source points to a deleted local book."
  },
  succeeded: {
    label: "Completed",
    description: "The background job finished successfully."
  }
};

const CONTRIBUTOR_ROLE_ORDER = ["author", "translator", "editor", "illustrator", "cover_artist", "publisher", "other"];
const PRIMARY_CONTRIBUTOR_ROLE_ORDER = ["author", "translator", "editor"];
const CONTRIBUTOR_ROLE_LABELS = {
  author: "",
  translator: "Translator",
  editor: "Editor",
  illustrator: "Illustration",
  cover_artist: "Cover",
  publisher: "Publisher",
  other: "Contributor"
};

function normalizeContributorName(value) {
  return (value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function getNormalizedContributorEntries(book) {
  if (book.contributors?.length) {
    const exactSeen = new Set();
    const entries = [];
    const nonAuthorNames = new Set();

    book.contributors.forEach((entry) => {
      if (!entry?.name) {
        return;
      }

      const role = entry.role || "other";
      const normalizedName = normalizeContributorName(entry.name);
      const contributorKey = `${normalizedName}|${role}`;
      if (!normalizedName || exactSeen.has(contributorKey)) {
        return;
      }

      exactSeen.add(contributorKey);
      if (role === "translator" || role === "editor") {
        nonAuthorNames.add(normalizedName);
      }
      entries.push({ name: entry.name, role });
    });

    return entries.filter(
      (entry) => !(entry.role === "author" && nonAuthorNames.has(normalizeContributorName(entry.name)))
    );
  }

  if (book.authors?.length) {
    return book.authors.filter(Boolean).map((name) => ({ name, role: "author" }));
  }

  return [];
}

export function getStatusMeta(value) {
  if (!value) {
    return {
      label: "Unknown",
      description: "No status is available yet."
    };
  }

  return (
    STATUS_META[value] || {
      label: value.replace(/_/g, " "),
      description: ""
    }
  );
}

export function formatRole(value) {
  return (value || "contributor").replace(/_/g, " ");
}

export function getContributorRoleLabel(value) {
  return CONTRIBUTOR_ROLE_LABELS[value] || formatRole(value);
}

export function formatBookDate(value, options = {}) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...options
  }).format(new Date(value));
}

export function formatBookDateTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function getPrimaryContributorName(book) {
  return getPrimaryContributorGroup(book)?.names?.[0] || "";
}

export function getContributorNamesByRole(book, role) {
  return getNormalizedContributorEntries(book)
    .filter((entry) => entry.role === role)
    .map((entry) => entry.name)
    .filter(Boolean);
}

export function getAuthorNames(book) {
  return getContributorNamesByRole(book, "author");
}

export function getContributorGroups(book) {
  const grouped = new Map();

  getNormalizedContributorEntries(book).forEach((entry) => {
    const role = entry.role || "other";
    const names = grouped.get(role) || [];
    if (!names.includes(entry.name)) {
      grouped.set(role, [...names, entry.name]);
    }
  });

  return CONTRIBUTOR_ROLE_ORDER.filter((role) => grouped.has(role)).map((role) => ({
    role,
    label: getContributorRoleLabel(role),
    names: grouped.get(role)
  }));
}

export function getPrimaryContributorGroup(book) {
  const groups = getContributorGroups(book);
  return groups.find((group) => PRIMARY_CONTRIBUTOR_ROLE_ORDER.includes(group.role)) || groups[0] || null;
}

export function getContributorLine(book) {
  const groups = getContributorGroups(book);
  if (!groups.length) {
    return "";
  }

  return groups
    .map((group) => (group.label ? `${group.label}: ${group.names.join(", ")}` : group.names.join(", ")))
    .join(" · ");
}

export function getBookCardCaption(book) {
  const sourceTitle = book.primary_source?.source_title;
  const sourcePath = book.primary_source?.display_path;
  return sourceTitle || sourcePath || "Source record will appear here after review";
}

export function getSourceLabel(source) {
  if (!source) {
    return "";
  }

  return source.source_title || source.display_path || source.display_url || source.url || "";
}

export function getSourceHostLabel(source) {
  if (!source?.site) {
    return "";
  }

  return source.site.replace(/^www\./, "");
}

export function getBookReadinessSummary(book) {
  const lifecycle = getStatusMeta(book.state);
  const review = getStatusMeta(book.review_state);
  return [lifecycle.label, review.label].filter(Boolean).join(" · ");
}
