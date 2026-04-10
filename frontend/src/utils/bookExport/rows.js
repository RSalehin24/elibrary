import { formatBookDate, getBookIdentityContributorLine, getContributorNamesByRole } from "../bookPresentation";

function bookTypeLabel(book) {
  return book?.record_type === "manual" ? "Manual" : "Digital";
}

export function bookExportRows(books) {
  return (books || []).map((book) => ({
    catalogCode: book.catalog_code || "",
    title: book.title || "",
    contributors: getBookIdentityContributorLine(book),
    authors: getContributorNamesByRole(book, "author").join(", "),
    translators: getContributorNamesByRole(book, "translator").join(", "),
    compilers: getContributorNamesByRole(book, "compiler").join(", "),
    editors: getContributorNamesByRole(book, "editor").join(", "),
    categories: (book.categories || []).join(", "),
    series: (book.series || []).join(", "),
    type: bookTypeLabel(book),
    state: book.state || "",
    review: book.review_state || "",
    createdAt: formatBookDate(book.created_at),
  }));
}

