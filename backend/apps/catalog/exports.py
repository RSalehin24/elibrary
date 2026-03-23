import csv
from html import escape
from io import BytesIO, StringIO
from pathlib import Path

from django.conf import settings
from django.http import HttpResponse

from apps.catalog.models import BookRecordType, ContributorRole
from apps.catalog.services import normalize_book_contributors


COMMON_PDF_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/NotoSansBengali-Regular.ttf",
    "/Library/Fonts/NotoSans-Regular.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/NotoSansBengali-Regular.ttf",
    "/System/Library/Fonts/Supplemental/NotoSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]


def html_lines(values):
    return "<br/>".join(escape(value) for value in values if value)


def normalized_book_contributors_for_export(book):
    return normalize_book_contributors(
        [{"name": relation.contributor.name, "role": relation.role} for relation in book.book_contributors.all()]
    )


def contributor_names_by_role(book, role):
    return [entry["name"] for entry in normalized_book_contributors_for_export(book) if entry["role"] == role]


def table_contributor_lines(book):
    authors = contributor_names_by_role(book, ContributorRole.AUTHOR)
    translators = contributor_names_by_role(book, ContributorRole.TRANSLATOR)
    editors = contributor_names_by_role(book, ContributorRole.EDITOR)

    lines = []
    if authors:
        lines.append(", ".join(authors))
    if translators:
        lines.append(f"Translator: {', '.join(translators)}")
    elif not authors and editors:
        lines.append(f"Compiler/Editor: {', '.join(editors)}")

    return lines or ["Contributor unavailable"]


def identity_ticket_contributor_line(book):
    authors = contributor_names_by_role(book, ContributorRole.AUTHOR)
    translators = contributor_names_by_role(book, ContributorRole.TRANSLATOR)
    editors = contributor_names_by_role(book, ContributorRole.EDITOR)

    parts = []
    if authors:
        parts.append(", ".join(authors))
    if translators:
        parts.append(f"Translator: {', '.join(translators)}")
    if editors:
        parts.append(f"Compiler/Editor: {', '.join(editors)}")
    return " | ".join(parts) or "Contributor unavailable"


def csv_value(value):
    if value is None:
        return ""
    return str(value)


def book_export_filename(prefix, extension, *, record_type):
    suffix = "manual" if record_type == BookRecordType.MANUAL else "books"
    return f"{prefix}-{suffix}.{extension}"


def build_books_csv_response(books, *, record_type):
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "Book ID",
            "Title",
            "Writer / Translator / Compiler-Editor",
            "Writers",
            "Translators",
            "Compiler-Editors",
            "Categories",
            "Series",
            "Type",
            "Compilation",
            "Binding",
            "Publisher",
            "Price",
            "Created At",
        ]
    )

    for book in books:
        writer.writerow(
            [
                csv_value(book.catalog_code),
                csv_value(book.title),
                csv_value(" | ".join(table_contributor_lines(book))),
                csv_value(", ".join(contributor_names_by_role(book, ContributorRole.AUTHOR))),
                csv_value(", ".join(contributor_names_by_role(book, ContributorRole.TRANSLATOR))),
                csv_value(", ".join(contributor_names_by_role(book, ContributorRole.EDITOR))),
                csv_value(", ".join(relation.category.name for relation in book.book_categories.all())),
                csv_value(", ".join(relation.series.name for relation in book.book_series.all())),
                "Manual" if book.record_type == BookRecordType.MANUAL else "Digital",
                "Yes" if book.manual_is_compilation else "No",
                csv_value(book.get_manual_binding_display() if book.manual_binding else ""),
                csv_value(book.manual_publisher),
                csv_value(book.manual_price),
                csv_value(book.created_at.isoformat() if book.created_at else ""),
            ]
        )

    response = HttpResponse(content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{book_export_filename("catalog", "csv", record_type=record_type)}"'
    response.write("\ufeff")
    response.write(output.getvalue())
    return response


def resolve_pdf_font():
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except ImportError as exc:
        raise RuntimeError("PDF export requires reportlab to be installed.") from exc

    candidate_paths = [settings.CATALOG_EXPORT_FONT_PATH, *COMMON_PDF_FONT_PATHS]
    for index, candidate in enumerate(candidate_paths):
        if not candidate:
            continue
        path = Path(candidate)
        if not path.exists():
            continue
        font_name = f"CatalogExportFont{index}"
        if font_name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(font_name, str(path)))
        return font_name
    return "Helvetica"


def make_book_list_pdf(books, *, record_type):
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as exc:
        raise RuntimeError("PDF export requires reportlab to be installed.") from exc

    font_name = resolve_pdf_font()
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), leftMargin=10 * mm, rightMargin=10 * mm, topMargin=10 * mm, bottomMargin=10 * mm)

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "CatalogPdfTitle",
        parent=styles["Title"],
        fontName=font_name,
        fontSize=16,
        leading=20,
    )
    body_style = ParagraphStyle(
        "CatalogPdfBody",
        parent=styles["BodyText"],
        fontName=font_name,
        fontSize=8.5,
        leading=10.5,
    )
    header_style = ParagraphStyle(
        "CatalogPdfHeader",
        parent=styles["BodyText"],
        fontName=font_name,
        fontSize=8.5,
        leading=10.5,
        textColor=colors.whitesmoke,
    )

    rows = [
        [
            Paragraph("Book ID", header_style),
            Paragraph("Title", header_style),
            Paragraph("Writer", header_style),
            Paragraph("Category", header_style),
            Paragraph("Details", header_style),
            Paragraph("Price", header_style),
            Paragraph("Created", header_style),
        ]
    ]

    for book in books:
        categories = ", ".join(relation.category.name for relation in book.book_categories.all()) or "Unsorted"
        details = []
        if book.record_type == BookRecordType.MANUAL:
            if book.manual_publisher:
                details.append(f"Publisher: {book.manual_publisher}")
            if book.manual_binding:
                details.append(f"Binding: {book.get_manual_binding_display()}")
            details.append(f"Compilation: {'Yes' if book.manual_is_compilation else 'No'}")
        else:
            details.append(", ".join(relation.series.name for relation in book.book_series.all()) or "Standalone")
            details.append("Digital")

        rows.append(
            [
                Paragraph(escape(book.catalog_code or ""), body_style),
                Paragraph(escape(book.title or ""), body_style),
                Paragraph(html_lines(table_contributor_lines(book)), body_style),
                Paragraph(escape(categories), body_style),
                Paragraph(html_lines(details), body_style),
                Paragraph(escape(str(book.manual_price or "")), body_style),
                Paragraph(escape(book.created_at.strftime("%Y-%m-%d") if book.created_at else ""), body_style),
            ]
        )

    table = Table(
        rows,
        colWidths=[26 * mm, 70 * mm, 62 * mm, 42 * mm, 54 * mm, 18 * mm, 22 * mm],
        repeatRows=1,
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0b3d2e")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
                ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#b6ccc3")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.whitesmoke, colors.HexColor("#eef4f1")]),
            ]
        )
    )

    story = [
        Paragraph("Manual Book List" if record_type == BookRecordType.MANUAL else "Book List", title_style),
        Spacer(1, 6 * mm),
        table,
    ]
    doc.build(story)
    return buffer.getvalue()


def make_book_tickets_pdf(books, *, record_type):
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as exc:
        raise RuntimeError("PDF export requires reportlab to be installed.") from exc

    font_name = resolve_pdf_font()
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=8 * mm, rightMargin=8 * mm, topMargin=8 * mm, bottomMargin=8 * mm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "CatalogTicketTitle",
        parent=styles["Title"],
        fontName=font_name,
        fontSize=14,
        leading=18,
    )
    ticket_style = ParagraphStyle(
        "CatalogTicketBody",
        parent=styles["BodyText"],
        fontName=font_name,
        fontSize=8,
        leading=10,
    )

    cells = []
    row = []
    for book in books:
        ticket_html = (
            f"<b>{escape(book.catalog_code or '')}</b><br/>"
            f"{escape(book.title or '')}<br/>"
            f"{escape(identity_ticket_contributor_line(book))}"
        )
        row.append(Paragraph(ticket_html, ticket_style))
        if len(row) == 3:
            cells.append(row)
            row = []
    if row:
        while len(row) < 3:
            row.append("")
        cells.append(row)

    table = Table(cells or [["", "", ""]], colWidths=[64 * mm, 64 * mm, 64 * mm], repeatRows=0)
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.6, colors.HexColor("#9fb8ae")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )

    story = [
        Paragraph("Manual Book Tickets" if record_type == BookRecordType.MANUAL else "Book Tickets", title_style),
        Spacer(1, 4 * mm),
        table,
    ]
    doc.build(story)
    return buffer.getvalue()


def build_books_pdf_response(books, *, record_type):
    payload = make_book_list_pdf(books, record_type=record_type)
    response = HttpResponse(payload, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{book_export_filename("catalog", "pdf", record_type=record_type)}"'
    return response


def build_book_tickets_pdf_response(books, *, record_type):
    payload = make_book_tickets_pdf(books, record_type=record_type)
    response = HttpResponse(payload, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{book_export_filename("catalog-tickets", "pdf", record_type=record_type)}"'
    return response
