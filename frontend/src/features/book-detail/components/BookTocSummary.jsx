export default function BookTocSummary({ toc }) {
  return (
    <div className="toc-record-list">
      {toc.map((entry, index) => (
        <article
          key={`${entry.title || "section"}-${index}`}
          className={`toc-record-card${entry.children?.length ? "" : " toc-record-card--empty"}`}
        >
          <strong>{entry.title || `Section ${index + 1}`}</strong>
          {entry.children?.length ? (
            <div className="toc-record-content">
              {entry.children
                .map((child) => child.title)
                .filter(Boolean)
                .map((childTitle, childIndex) => (
                  <span
                    key={`${entry.title || "section"}-${index}-${childIndex}`}
                    className="toc-record-content-item"
                  >
                    {childTitle}
                  </span>
                ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
