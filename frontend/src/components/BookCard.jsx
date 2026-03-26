import { Fragment } from "react";
import { Link } from "react-router-dom";
import BookRouteLink from "./BookRouteLink";
import BookCoverArt from "./BookCoverArt";
import {
  formatBookDate,
  getWriterColumnGroups
} from "../utils/bookPresentation";
import { toQueryString } from "../utils/query";

function renderFilterLinks(values, queryKey, emptyLabel) {
  if (!values?.length) {
    return emptyLabel;
  }

  return values.map((value, index) => (
    <Fragment key={`${queryKey}-${value}`}>
      <Link to={`/library${toQueryString({ [queryKey]: value })}`} className="meta-link">
        {value}
      </Link>
      {index < values.length - 1 ? <span className="meta-divider">, </span> : null}
    </Fragment>
  ));
}

export default function BookCard({ book }) {
  const contributorGroups = getWriterColumnGroups(book);
  const series = book.series || [];
  const categories = book.categories || [];
  const bookIdLabel = book.catalog_code || "Pending";

  return (
    <article className="book-card">
      <div className="book-card-art">
        <BookCoverArt book={book} className="book-card-cover" ariaHidden />
      </div>

      <div className="book-card-body">
        <div className="book-card-topline">
          <p className="book-card-id">{bookIdLabel}</p>
        </div>

        <div className="book-card-heading">
          <h3>{book.title}</h3>
          <div className="book-card-contributors book-card-contributor-groups">
            {contributorGroups.length ? (
              contributorGroups.map((group, index) => (
                <div key={`${book.id}-contributor-${index}`} className="table-writer-line">
                  {group.label ? <span className="table-role-label">{group.label}</span> : null}
                  <span className="book-meta">{renderFilterLinks(group.names, group.queryKey, "Contributor unavailable")}</span>
                </div>
              ))
            ) : (
              <p className="book-meta">Contributor unavailable</p>
            )}
          </div>
        </div>

        <div className="book-card-details">
          <div className="book-detail-chip">
            <span className="fact-label">Categories</span>
            <strong>{renderFilterLinks(categories, "category", "Unsorted")}</strong>
          </div>
          <div className="book-detail-chip">
            <span className="fact-label">Series</span>
            <strong>{renderFilterLinks(series, "series", "Standalone")}</strong>
          </div>
        </div>

        <div className="book-card-footer">
          <div className="book-meta-stack">
            <p className="book-timestamp">{book.record_type === "manual" ? "Manual entry" : "Library record"}</p>
            {book.latest_submission_at ? <p className="book-timestamp">Added on {formatBookDate(book.latest_submission_at)}</p> : null}
          </div>
          <BookRouteLink
            slug={book.slug}
            className="primary-button book-card-action"
          >
            Open record
          </BookRouteLink>
        </div>
      </div>
    </article>
  );
}
