import { Link } from "react-router-dom";
import StatusPill from "./StatusPill";

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
        <Link to={`/books/${book.slug}`} className="primary-link">
          Open record
        </Link>
      </div>
    </article>
  );
}
