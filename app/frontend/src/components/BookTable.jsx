import { Fragment } from "react";
import { Link } from "react-router-dom";
import BookRouteLink from "./BookRouteLink";
import { formatBookDate, getWriterColumnGroups } from "../utils/bookPresentation";
import { toQueryString } from "../utils/query";

function renderLinkedValues(values, queryKey, linkFilters) {
  return values.map((value, index) => (
    <Fragment key={`${queryKey}-${value}`}>
      <Link to={`/library${toQueryString({ ...(linkFilters || {}), [queryKey]: value })}`} className="meta-link">
        {value}
      </Link>
      {index < values.length - 1 ? <span className="meta-divider">, </span> : null}
    </Fragment>
  ));
}

function renderWriterCell(book, linkFilters) {
  const groups = getWriterColumnGroups(book);
  if (!groups.length) {
    return <span className="table-muted">Contributor unavailable</span>;
  }

  return (
    <div className="table-writer-stack">
      {groups.map((group, index) => (
        <div key={`${book.id}-writer-${index}`} className="table-writer-line">
          {group.label ? <span className="table-role-label">{group.label}</span> : null}
          <span>{renderLinkedValues(group.names, group.queryKey, linkFilters)}</span>
        </div>
      ))}
    </div>
  );
}

export default function BookTable({ books, emptyLabel = "No books found.", linkFilters = {}, highlightedBookId = "" }) {
  if (!books?.length) {
    return <div className="page-state">{emptyLabel}</div>;
  }

  return (
    <div className="catalog-table-shell">
      <table className="catalog-table book-table">
        <colgroup>
          <col className="book-table-col-id" />
          <col className="book-table-col-title" />
          <col className="book-table-col-writer" />
          <col className="book-table-col-category" />
          <col className="book-table-col-series" />
          <col className="book-table-col-type" />
          <col className="book-table-col-created" />
          <col className="book-table-col-action" />
        </colgroup>
        <thead>
          <tr>
            <th>Book ID</th>
            <th>Title</th>
            <th>Contributors</th>
            <th>Category</th>
            <th>Series</th>
            <th>Type</th>
            <th>Created</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {books.map((book) => {
            const categories = book.categories || [];
            const series = book.series || [];

            return (
              <tr key={book.id} className={highlightedBookId === book.id ? "is-highlighted" : ""}>
                <td className="table-code-cell">
                  <BookRouteLink slug={book.slug} className="table-code-link">
                    {book.catalog_code || "Pending"}
                  </BookRouteLink>
                </td>
                <td className="table-title-cell">
                  <BookRouteLink slug={book.slug} className="table-title-link">
                    {book.title}
                  </BookRouteLink>
                  <span className="table-secondary-line">
                    {book.primary_source?.display_path || (book.record_type === "manual" ? "Manual entry" : "Library record")}
                  </span>
                </td>
                <td>{renderWriterCell(book, linkFilters)}</td>
                <td>
                  {categories.length ? renderLinkedValues(categories, "category", linkFilters) : <span className="table-muted">Unsorted</span>}
                </td>
                <td>{series.length ? series.join(", ") : <span className="table-muted">Standalone</span>}</td>
                <td>
                  <span className={`table-type-pill table-type-pill-${book.record_type || "digital"}`}>
                    {book.record_type === "manual" ? "Manual" : "Digital"}
                  </span>
                </td>
                <td>{formatBookDate(book.created_at)}</td>
                <td className="table-action-cell">
                  <BookRouteLink
                    slug={book.slug}
                    className="ghost-button table-row-action"
                  >
                    Open
                  </BookRouteLink>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
