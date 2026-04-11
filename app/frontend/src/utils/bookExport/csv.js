import { escapeCsv, downloadBlob } from "./helpers";
import { bookExportRows } from "./rows";

export function exportBooksToCsv(books, filename) {
  const rows = bookExportRows(books);
  const header = [
    "Book ID",
    "Title",
    "Writer / Translator / Compiler / Editor",
    "Writers",
    "Translators",
    "Compilers",
    "Editors",
    "Categories",
    "Series",
    "Type",
    "State",
    "Review",
    "Created At",
  ];
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.catalogCode,
        row.title,
        row.contributors,
        row.authors,
        row.translators,
        row.compilers,
        row.editors,
        row.categories,
        row.series,
        row.type,
        row.state,
        row.review,
        row.createdAt,
      ]
        .map(escapeCsv)
        .join(","),
    ),
  ];
  downloadBlob(new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }), filename);
}

