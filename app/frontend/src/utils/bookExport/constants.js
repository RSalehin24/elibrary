export const PDF_LAYOUT = {
  canvasWidth: 1320,
  canvasHeight: 934,
  pdfWidth: 842,
  pdfHeight: 595,
  scale: 2,
  marginX: 40,
  marginY: 34,
  headerHeight: 36,
  rowMinHeight: 42,
  cellPaddingX: 10,
  cellPaddingY: 9,
  lineHeight: 15,
  titleY: 42,
  subtitleY: 76,
  tableY: 112,
};

export const PDF_COLUMNS = [
  { key: "catalogCode", label: "ID", width: 110, weight: 700 },
  { key: "title", label: "Title", width: 260, weight: 700 },
  { key: "contributors", label: "Contributors", width: 320, weight: 500 },
  { key: "categories", label: "Category", width: 150, weight: 500 },
  { key: "series", label: "Series", width: 130, weight: 500 },
  { key: "type", label: "Type", width: 100, weight: 700 },
  { key: "createdAt", label: "Created", width: 170, weight: 500 },
];

export const MAX_CELL_LINES = 6;

