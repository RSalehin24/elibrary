import { Link } from "react-router-dom";
import StatusPill from "./StatusPill";

function formatDate(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

export default function BookCard({ book }) {
  return (
    <article className="book-card">
      <div className="book-cover-placeholder" aria-hidden="true">
        <span>{book.title.slice(0, 1)}</span>
      </div>
      <div className="book-card-body">
        <div className="book-card-topline">
          <StatusPill value={book.state} />
          <StatusPill value={book.review_state} />
        </div>
        <h3>{book.title}</h3>
        <p className="book-meta">{book.authors?.join(", ") || "Contributor pending review"}</p>
        <p className="book-taxonomy">
          {(book.series || []).join(" · ") || "Standalone"} {(book.categories || []).length ? "• " : ""}
          {(book.categories || []).join(" · ")}
        </p>
        {book.latest_submission_at ? (
          <p className="book-timestamp">Added by you on {formatDate(book.latest_submission_at)}</p>
        ) : null}
        <Link to={`/books/${book.slug}`} className="primary-link">
          Open record
        </Link>
      </div>
    </article>
  );
}
