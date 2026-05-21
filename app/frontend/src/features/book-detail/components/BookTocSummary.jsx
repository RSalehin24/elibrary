function tocLabel(entry, fallbackLabel) {
  return entry?.title || entry?.label || fallbackLabel;
}

function TocBranch({ entries, path = "toc" }) {
  if (!entries?.length) {
    return null;
  }

  return (
    <div className="toc-record-list">
      {entries.map((entry, index) => {
        const itemKey = `${path}-${index}`;
        const children = Array.isArray(entry?.children) ? entry.children : [];
        const label = tocLabel(entry, `Section ${index + 1}`);
        const hasContent = typeof entry?.has_content === "boolean";

        return (
          <article
            key={itemKey}
            className={`toc-record-card${children.length ? "" : " toc-record-card--empty"}`}
          >
            <div className="toc-record-copy">
              <strong>{label}</strong>
              {entry?.type || hasContent ? (
                <div className="inline-pills toc-record-pills">
                  {entry?.type ? (
                    <span className="status-pill">{entry.type}</span>
                  ) : null}
                  {hasContent ? (
                    <span
                      className={`status-pill ${
                        entry.has_content
                          ? "status-ready"
                          : "status-needs_review"
                      }`}
                    >
                      {entry.has_content ? "Content ready" : "TOC only"}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {children.length ? (
              <div className="toc-record-content">
                <TocBranch entries={children} path={itemKey} />
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export default function BookTocSummary({ toc }) {
  return <TocBranch entries={toc} />;
}
