import { formatBookDate, getBookIdentityContributorLine, getContributorNamesByRole } from "./bookPresentation";

const PDF_LAYOUT = {
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
  tableY: 112
};

const PDF_COLUMNS = [
  { key: "catalogCode", label: "ID", width: 110, weight: 700 },
  { key: "title", label: "Title", width: 260, weight: 700 },
  { key: "contributors", label: "Contributors", width: 320, weight: 500 },
  { key: "categories", label: "Category", width: 150, weight: 500 },
  { key: "series", label: "Series", width: 130, weight: 500 },
  { key: "type", label: "Type", width: 100, weight: 700 },
  { key: "createdAt", label: "Created", width: 170, weight: 500 }
];

const MAX_CELL_LINES = 6;

function escapeCsv(value) {
  const stringValue = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, "\"\"")}"`;
  }
  return stringValue;
}

function bookTypeLabel(book) {
  return book?.record_type === "manual" ? "Manual" : "Digital";
}

function bookExportRows(books) {
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
    createdAt: formatBookDate(book.created_at)
  }));
}

function downloadBlob(blob, filename) {
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
}

function slugifyFilename(value) {
  return String(value || "books-export")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "books-export";
}

function wrapLongToken(ctx, token, maxWidth) {
  const segments = [];
  let current = "";

  for (const character of token) {
    const candidate = `${current}${character}`;
    if (!current || ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    segments.push(current);
    current = character;
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

function wrapText(ctx, value, maxWidth) {
  const rawValue = String(value ?? "");
  const paragraphs = rawValue
    .split("\n")
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph, index, collection) => paragraph || collection.length === 1);

  if (!paragraphs.length) {
    return [""];
  }

  const lines = [];

  paragraphs.forEach((paragraph) => {
    if (!paragraph) {
      lines.push("");
      return;
    }

    let currentLine = "";
    const words = paragraph.split(" ");

    words.forEach((word) => {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        currentLine = candidate;
        return;
      }

      if (currentLine) {
        lines.push(currentLine);
        currentLine = "";
      }

      if (ctx.measureText(word).width <= maxWidth) {
        currentLine = word;
        return;
      }

      const pieces = wrapLongToken(ctx, word, maxWidth);
      lines.push(...pieces.slice(0, -1));
      currentLine = pieces.at(-1) || "";
    });

    if (currentLine) {
      lines.push(currentLine);
    }
  });

  return lines.length ? lines : [rawValue.trim()];
}

function clampLineToWidth(ctx, line, maxWidth) {
  if (ctx.measureText(line).width <= maxWidth) {
    return line;
  }

  let nextLine = line;
  while (nextLine.length > 1 && ctx.measureText(`${nextLine}...`).width > maxWidth) {
    nextLine = nextLine.slice(0, -1);
  }

  return `${nextLine}...`;
}

function clampLines(ctx, lines, maxLines, maxWidth) {
  if (lines.length <= maxLines) {
    return lines;
  }

  const truncated = lines.slice(0, maxLines);
  truncated[maxLines - 1] = clampLineToWidth(ctx, truncated[maxLines - 1], maxWidth);
  return truncated;
}

function createPdfCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = PDF_LAYOUT.canvasWidth * PDF_LAYOUT.scale;
  canvas.height = PDF_LAYOUT.canvasHeight * PDF_LAYOUT.scale;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create PDF canvas.");
  }

  context.scale(PDF_LAYOUT.scale, PDF_LAYOUT.scale);
  context.textBaseline = "top";

  return { canvas, context };
}

function drawPageChrome(context, title, rowCount, pageNumber) {
  context.fillStyle = "#f4f8f6";
  context.fillRect(0, 0, PDF_LAYOUT.canvasWidth, PDF_LAYOUT.canvasHeight);

  context.fillStyle = "#ffffff";
  context.fillRect(18, 18, PDF_LAYOUT.canvasWidth - 36, PDF_LAYOUT.canvasHeight - 36);

  context.fillStyle = "rgba(238, 211, 121, 0.18)";
  context.beginPath();
  context.arc(PDF_LAYOUT.canvasWidth - 92, 74, 72, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "rgba(15, 75, 56, 0.08)";
  context.fillRect(PDF_LAYOUT.marginX, 22, PDF_LAYOUT.canvasWidth - PDF_LAYOUT.marginX * 2, 4);

  context.fillStyle = "#17392f";
  context.font = '700 26px "Avenir Next", "Noto Sans Bengali", "Hind Siliguri", sans-serif';
  context.fillText(title, PDF_LAYOUT.marginX, PDF_LAYOUT.titleY);

  context.fillStyle = "#5d7068";
  context.font = '500 12px "Avenir Next", "Noto Sans Bengali", "Hind Siliguri", sans-serif';
  context.fillText(`${rowCount} books exported`, PDF_LAYOUT.marginX, PDF_LAYOUT.subtitleY);

  const dateLabel = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date());
  const pageLabel = `Page ${pageNumber}`;
  const metaLabel = `${dateLabel}  •  ${pageLabel}`;
  const metaWidth = context.measureText(metaLabel).width;
  context.fillText(metaLabel, PDF_LAYOUT.canvasWidth - PDF_LAYOUT.marginX - metaWidth, PDF_LAYOUT.subtitleY);
}

function drawTableHeader(context, startY) {
  let x = PDF_LAYOUT.marginX;

  context.fillStyle = "#17392f";
  context.fillRect(
    PDF_LAYOUT.marginX,
    startY,
    PDF_LAYOUT.canvasWidth - PDF_LAYOUT.marginX * 2,
    PDF_LAYOUT.headerHeight
  );

  PDF_COLUMNS.forEach((column) => {
    context.fillStyle = "#edf6f1";
    context.font = '700 11px "Avenir Next", "Noto Sans Bengali", "Hind Siliguri", sans-serif';
    context.fillText(column.label, x + PDF_LAYOUT.cellPaddingX, startY + 11);

    context.strokeStyle = "rgba(255, 255, 255, 0.16)";
    context.strokeRect(x, startY, column.width, PDF_LAYOUT.headerHeight);
    x += column.width;
  });

  return startY + PDF_LAYOUT.headerHeight;
}

function preparePdfCellMap(row) {
  return {
    catalogCode: row.catalogCode || "Pending",
    title: row.title || "Untitled",
    contributors: row.contributors || "Contributor unavailable",
    categories: row.categories || "Unsorted",
    series: row.series || "Standalone",
    type: row.type || "",
    createdAt: row.createdAt || ""
  };
}

function preparePdfRow(context, row) {
  const cellMap = preparePdfCellMap(row);
  const lineMap = {};
  let maxLines = 1;

  PDF_COLUMNS.forEach((column) => {
    context.font = `${column.weight || 500} 12px "Avenir Next", "Noto Sans Bengali", "Hind Siliguri", sans-serif`;
    const maxTextWidth = column.width - PDF_LAYOUT.cellPaddingX * 2;
    const lines = clampLines(
      context,
      wrapText(context, cellMap[column.key], maxTextWidth),
      MAX_CELL_LINES,
      maxTextWidth
    );
    lineMap[column.key] = lines;
    maxLines = Math.max(maxLines, lines.length);
  });

  return {
    lineMap,
    rowHeight: Math.max(PDF_LAYOUT.rowMinHeight, PDF_LAYOUT.cellPaddingY * 2 + maxLines * PDF_LAYOUT.lineHeight)
  };
}

function drawPdfRow(context, row, preparedRow, startY, rowIndex) {
  let x = PDF_LAYOUT.marginX;
  const tableWidth = PDF_LAYOUT.canvasWidth - PDF_LAYOUT.marginX * 2;

  context.fillStyle = rowIndex % 2 === 0 ? "#ffffff" : "#f7faf8";
  context.fillRect(PDF_LAYOUT.marginX, startY, tableWidth, preparedRow.rowHeight);

  PDF_COLUMNS.forEach((column) => {
    const lines = preparedRow.lineMap[column.key];

    context.strokeStyle = "#d8e4de";
    context.strokeRect(x, startY, column.width, preparedRow.rowHeight);

    lines.forEach((line, lineIndex) => {
      context.fillStyle = column.key === "catalogCode" ? "#0f4b38" : "#17392f";
      context.font = `${column.weight || 500} 12px "Avenir Next", "Noto Sans Bengali", "Hind Siliguri", sans-serif`;
      context.fillText(
        line,
        x + PDF_LAYOUT.cellPaddingX,
        startY + PDF_LAYOUT.cellPaddingY + lineIndex * PDF_LAYOUT.lineHeight
      );
    });

    x += column.width;
  });
}

function renderPdfPages(rows, title) {
  const pages = [];
  let pageNumber = 1;
  let current = createPdfCanvas();
  let currentY = PDF_LAYOUT.tableY;

  drawPageChrome(current.context, title, rows.length, pageNumber);
  currentY = drawTableHeader(current.context, currentY);

  rows.forEach((row, rowIndex) => {
    const preparedRow = preparePdfRow(current.context, row);
    const maxY = PDF_LAYOUT.canvasHeight - PDF_LAYOUT.marginY - 18;

    if (currentY + preparedRow.rowHeight > maxY) {
      pages.push(current.canvas);
      pageNumber += 1;
      current = createPdfCanvas();
      drawPageChrome(current.context, title, rows.length, pageNumber);
      currentY = drawTableHeader(current.context, PDF_LAYOUT.tableY);
    }

    drawPdfRow(current.context, row, preparedRow, currentY, rowIndex);
    currentY += preparedRow.rowHeight;
  });

  pages.push(current.canvas);
  return pages;
}

async function canvasToJpegBytes(canvas) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result);
          return;
        }
        reject(new Error("Unable to render PDF page."));
      },
      "image/jpeg",
      0.92
    );
  });

  return new Uint8Array(await blob.arrayBuffer());
}

function concatUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });

  return output;
}

function buildPdfBlob(pages) {
  const encoder = new TextEncoder();
  const chunks = [];
  const objectOffsets = [];
  let position = 0;

  const push = (value) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    position += bytes.length;
  };

  const beginObject = (id) => {
    objectOffsets[id] = position;
    push(`${id} 0 obj\n`);
  };

  const endObject = () => {
    push("endobj\n");
  };

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xff, 0xff, 0xff, 0xff, 0x0a]));

  const objectCount = 2 + pages.length * 3;
  const pageRefs = pages.map((_, index) => 3 + index * 3);

  beginObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObject();

  beginObject(2);
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(" ")}] >>\n`);
  endObject();

  pages.forEach((page, index) => {
    const pageObjectId = 3 + index * 3;
    const imageObjectId = pageObjectId + 1;
    const contentObjectId = pageObjectId + 2;
    const imageName = `Im${index + 1}`;

    beginObject(pageObjectId);
    push(
      `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /${imageName} ${imageObjectId} 0 R >> >> /MediaBox [0 0 ${PDF_LAYOUT.pdfWidth} ${PDF_LAYOUT.pdfHeight}] /Contents ${contentObjectId} 0 R >>\n`
    );
    endObject();

    beginObject(imageObjectId);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`
    );
    push(page.bytes);
    push("\nendstream\n");
    endObject();

    const content = `q\n${PDF_LAYOUT.pdfWidth} 0 0 ${PDF_LAYOUT.pdfHeight} 0 0 cm\n/${imageName} Do\nQ\n`;
    const contentBytes = encoder.encode(content);

    beginObject(contentObjectId);
    push(`<< /Length ${contentBytes.length} >>\nstream\n`);
    push(contentBytes);
    push("endstream\n");
    endObject();
  });

  const startXref = position;
  push(`xref\n0 ${objectCount + 1}\n`);
  push("0000000000 65535 f \n");

  for (let index = 1; index <= objectCount; index += 1) {
    push(`${String(objectOffsets[index] || 0).padStart(10, "0")} 00000 n \n`);
  }

  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`);

  return new Blob([concatUint8Arrays(chunks)], { type: "application/pdf" });
}

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
    "Created At"
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
        row.createdAt
      ]
        .map(escapeCsv)
        .join(",")
    )
  ];

  downloadBlob(new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }), filename);
}

export async function exportBooksToPdf(books, title) {
  const rows = bookExportRows(books);
  const pageCanvases = renderPdfPages(rows, title);
  const pages = await Promise.all(
    pageCanvases.map(async (canvas) => ({
      width: canvas.width,
      height: canvas.height,
      bytes: await canvasToJpegBytes(canvas)
    }))
  );
  const pdfBlob = buildPdfBlob(pages);
  downloadBlob(pdfBlob, `${slugifyFilename(title)}.pdf`);
}
