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
      deleted: 0,
    },
  );
}

export function orderExpandableCards(cards, prioritizedExpandedKey = "") {
  const expandedCards = [];
  const collapsedCards = [];

  (cards || []).forEach((card) => {
    if (!card) {
      return;
    }
    if (card.expanded) {
      expandedCards.push(card);
      return;
    }
    collapsedCards.push(card);
  });

  if (!prioritizedExpandedKey) {
    return [...expandedCards, ...collapsedCards];
  }

  const prioritizedIndex = expandedCards.findIndex(
    (card) => card.key === prioritizedExpandedKey,
  );

  if (prioritizedIndex === -1) {
    return [...expandedCards, ...collapsedCards];
  }

  const [prioritizedCard] = expandedCards.splice(prioritizedIndex, 1);
  return [prioritizedCard, ...expandedCards, ...collapsedCards];
}

export function formatRemovedRangeLabel(range) {
  if (range === "year") {
    return "Past Year";
  }
  if (range === "month") {
    return "Past Month";
  }
  if (range === "day") {
    return "Past Day";
  }
  return "Past Week";
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
