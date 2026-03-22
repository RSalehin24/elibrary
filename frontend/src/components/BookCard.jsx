import { Fragment } from "react";
import { Link } from "react-router-dom";
import BookCoverArt from "./BookCoverArt";
import StatusPill from "./StatusPill";
import {
  formatBookDate,
  getContributorNamesByRole
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
  const authorNames = getContributorNamesByRole(book, "author");
  const translatorNames = getContributorNamesByRole(book, "translator");
  const editorNames = getContributorNamesByRole(book, "editor");
  const series = book.series || [];
  const categories = book.categories || [];
  const fallbackRoleLabel = !authorNames.length && !translatorNames.length && editorNames.length ? "Editor" : "";
  const fallbackNames = fallbackRoleLabel ? editorNames : [];

  return (
    <article className="book-card">
      <div className="book-card-art">
        <BookCoverArt book={book} className="book-card-cover" ariaHidden />
      </div>

      <div className="book-card-body">
        <div className="book-card-topline">
          <StatusPill value={book.state} />
          <StatusPill value={book.review_state} />
        </div>

        <div className="book-card-heading">
          <h3>{book.title}</h3>
          <div className="book-card-contributors">
            {authorNames.length ? (
              <p className="book-meta">{renderFilterLinks(authorNames, "author", "Contributor unavailable")}</p>
            ) : null}
            {translatorNames.length ? (
              <p className="book-meta book-meta-secondary">
                <span className="book-meta-role">Translator</span>
                <span>{renderFilterLinks(translatorNames, "contributor", "")}</span>
              </p>
            ) : null}
            {!authorNames.length && !translatorNames.length && fallbackNames.length ? (
              <p className="book-meta book-meta-secondary">
                <span className="book-meta-role">{fallbackRoleLabel}</span>
                <span>{renderFilterLinks(fallbackNames, "contributor", "")}</span>
              </p>
            ) : null}
            {!authorNames.length && !translatorNames.length && !fallbackNames.length ? (
              <p className="book-meta">Contributor unavailable</p>
            ) : null}
          </div>
        </div>

        <div className="book-card-details">
          <div className="book-detail-chip">
            <span className="fact-label">Series</span>
            <strong>{renderFilterLinks(series, "series", "Standalone")}</strong>
          </div>
          <div className="book-detail-chip">
            <span className="fact-label">Categories</span>
            <strong>{renderFilterLinks(categories, "category", "Unsorted")}</strong>
          </div>
        </div>

        <div className="book-card-footer">
          <p className="book-timestamp">
            {book.latest_submission_at ? `Added on ${formatBookDate(book.latest_submission_at)}` : "Library record"}
          </p>
          <Link to={`/books/${book.slug}`} className="primary-button book-card-action">
            Open record
          </Link>
        </div>
      </div>
    </article>
  );
}
