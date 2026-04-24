export const MANUAL_BOOKS_EXPORT_STORAGE_KEY = "manual-books-export";

export const emptyManualBookForm = {
  title: "",
  summary: "",
  writers: [],
  translators: [],
  compilers: [],
  editors: [],
  categories: [],
  series: [],
  is_compilation: false,
  binding: "",
  publisher: "",
  price: ""
};

export const defaultManualBookFilters = {
  q: "",
  book_code: "",
  writer_code: "",
  category_code: "",
  author: "",
  series: "",
  category: "",
  created_after: "",
  created_before: "",
  sort: "-created_at"
};

export const manualBookFilterFields = [
  { key: "book_code", label: "Book code" },
  { key: "writer_code", label: "Writer code" },
  { key: "category_code", label: "Category code" },
  { key: "author", label: "Writer" },
  { key: "series", label: "Series" },
  { key: "category", label: "Category" },
  { key: "created_after", label: "Created after", type: "date" },
  { key: "created_before", label: "Created before", type: "date" },
  {
    key: "sort",
    label: "Sort",
    type: "select",
    options: [
      { value: "-created_at", label: "Newest first" },
      { value: "created_at", label: "Oldest first" },
      { value: "catalog_code", label: "Code ascending" },
      { value: "-catalog_code", label: "Code descending" },
      { value: "title", label: "Title A-Z" },
      { value: "-title", label: "Title Z-A" }
    ]
  }
];

export const manualBookToolbarFields = manualBookFilterFields.filter(
  (field) => field.key !== "sort"
);

export const manualBookSortOptions =
  manualBookFilterFields.find((field) => field.key === "sort")?.options || [];
