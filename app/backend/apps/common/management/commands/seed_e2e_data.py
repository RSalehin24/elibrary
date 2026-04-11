from __future__ import annotations

from dataclasses import dataclass
from datetime import time

from django.conf import settings
from django.core.cache import cache
from django.core.files.base import ContentFile
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q

from apps.access.models import Bookmark, PermissionGrant, PermissionScope, ReadingSession
from apps.accounts.models import User
from apps.catalog.models import (
    Book,
    BookSource,
    BookRecordType,
    GeneratedAsset,
    GeneratedAssetStatus,
    GeneratedAssetType,
)
from apps.catalog.models.choices import ContributorRole
from apps.catalog.services import replace_book_relations
from apps.common.models import LifecycleState, ReviewState
from apps.common.text import normalize_catalog_text
from apps.ingestion.models import (
    BookSubmission,
    CatalogAutomationSettings,
    JobStatus,
    JobType,
    ProcessingJob,
    ResolutionStatus,
    SourceCatalogEntry,
    SourceCatalogRefreshState,
    SourceCatalogRefreshStatus,
    SubmissionInputType,
    SubmissionOrigin,
    SubmissionStatus,
)


E2E_TITLE_PREFIX = "E2E "
E2E_EMAIL_DOMAIN = "@e2e.local"
E2E_SOURCE_PREFIX = "https://www.ebanglalibrary.com/books/e2e-"
DEFAULT_WRITER = "E2E Writer"
DEFAULT_CATEGORY = "E2E Fiction"
DEFAULT_SERIES = "E2E Starter Series"
INCOMPLETE_CATEGORY = "অসম্পূর্ণ বই"


@dataclass(frozen=True)
class SeedBook:
    title: str
    source_url: str
    with_assets: bool = False
    categories: tuple[str, ...] = (DEFAULT_CATEGORY,)
    series: tuple[str, ...] = (DEFAULT_SERIES,)


BOOK_DEFINITIONS = {
    "home_primary": SeedBook(
        title="E2E Home Library Book",
        source_url=f"{E2E_SOURCE_PREFIX}home-library-book/",
    ),
    "home_secondary": SeedBook(
        title="E2E Search Companion Book",
        source_url=f"{E2E_SOURCE_PREFIX}search-companion-book/",
    ),
    "detail": SeedBook(
        title="E2E Detail Book",
        source_url=f"{E2E_SOURCE_PREFIX}detail-book/",
        with_assets=True,
    ),
    "preview": SeedBook(
        title="E2E Preview Book",
        source_url=f"{E2E_SOURCE_PREFIX}preview-book/",
        with_assets=True,
    ),
    "access": SeedBook(
        title="E2E Access Grant Book",
        source_url=f"{E2E_SOURCE_PREFIX}access-grant-book/",
    ),
    "incomplete": SeedBook(
        title="E2E Incomplete Catalog Book",
        source_url=f"{E2E_SOURCE_PREFIX}incomplete-catalog-book/",
        categories=(INCOMPLETE_CATEGORY,),
    ),
}

SUBMISSION_TITLES = (
    "E2E Alpha Submission",
    "E2E Beta Submission",
)

CATALOG_ENTRIES = (
    {
        "title": "E2E Alpha Catalog Book",
        "source_url": f"{E2E_SOURCE_PREFIX}alpha-catalog-book/",
        "author_line": DEFAULT_WRITER,
        "category": DEFAULT_CATEGORY,
    },
    {
        "title": "E2E Beta Catalog Book",
        "source_url": f"{E2E_SOURCE_PREFIX}beta-catalog-book/",
        "author_line": DEFAULT_WRITER,
        "category": DEFAULT_CATEGORY,
    },
    {
        "title": "E2E Incomplete Catalog Book",
        "source_url": f"{E2E_SOURCE_PREFIX}incomplete-catalog-book/",
        "author_line": DEFAULT_WRITER,
        "category": INCOMPLETE_CATEGORY,
    },
)

ACCESS_USER_EMAIL = f"access-manager{E2E_EMAIL_DOMAIN}"
ACCESS_USER_PASSWORD = "E2E-access-pass-123"


class Command(BaseCommand):
    help = "Reset and seed deterministic local E2E data for real browser tests."

    def handle(self, *args, **options):
        if not settings.SUPER_ADMIN_EMAIL or not settings.SUPER_ADMIN_PASSWORD:
            raise CommandError(
                "SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set before seeding E2E data."
            )

        call_command("seed_superadmin")
        admin = User.objects.filter(email=settings.SUPER_ADMIN_EMAIL).first()
        if admin is None:
            raise CommandError("Could not resolve the configured super admin account.")

        # Reset throttle/session cache so repeated live-browser runs start cleanly.
        cache.clear()

        with transaction.atomic():
            self.cleanup_existing_records()
            access_user = self.create_access_user(admin)
            books = self.create_books()
            self.create_access_grants(admin, access_user)
            self.create_reader_state(admin, books["detail"])
            self.create_submissions(admin, books)
            self.create_catalog_state(admin)

        self.stdout.write(
            self.style.SUCCESS(
                "Seeded live E2E data for access, catalog, book detail, and processing flows."
            )
        )

    def cleanup_existing_records(self):
        for asset in GeneratedAsset.objects.select_related("book").filter(book__title__startswith=E2E_TITLE_PREFIX):
            if asset.file and asset.file.name:
                asset.file.delete(save=False)

        Book.objects.filter(title__startswith=E2E_TITLE_PREFIX).delete()
        SourceCatalogEntry.objects.filter(source_url__startswith=E2E_SOURCE_PREFIX).delete()
        BookSubmission.objects.filter(
            Q(original_input__startswith=E2E_TITLE_PREFIX)
            | Q(original_input__startswith=E2E_SOURCE_PREFIX)
            | Q(resolved_url__startswith=E2E_SOURCE_PREFIX)
        ).delete()
        PermissionGrant.objects.filter(user__email__endswith=E2E_EMAIL_DOMAIN).delete()
        User.objects.filter(email__endswith=E2E_EMAIL_DOMAIN).delete()

    def create_access_user(self, admin: User) -> User:
        access_user = User.objects.create_user(
            email=ACCESS_USER_EMAIL,
            password=ACCESS_USER_PASSWORD,
            full_name="E2E Access Manager",
            is_active=True,
        )
        PermissionGrant.objects.create(
            user=access_user,
            scope=PermissionScope.METADATA_EDIT,
            granted_by=admin,
        )
        return access_user

    def create_books(self) -> dict[str, Book]:
        books: dict[str, Book] = {}
        for key, definition in BOOK_DEFINITIONS.items():
            book = Book.objects.create(
                title=definition.title,
                summary=f"{definition.title} summary for live browser coverage.",
                state=LifecycleState.READY,
                review_state=ReviewState.APPROVED,
                record_type=BookRecordType.DIGITAL,
                source_site="e2e.local",
                raw_scraped_metadata={"seed": "e2e"},
                raw_scrape_payload={"seed": "e2e"},
                main_content_html=f"<h1>{definition.title}</h1><p>Seeded content.</p>",
                book_info_html="<p>Book ID: seeded-e2e</p>",
                toc=[{"label": "Chapter 1", "href": "#chapter-1"}],
                content_items=[{"title": "Chapter 1", "slug": "chapter-1"}],
            )
            replace_book_relations(
                book,
                contributors=[{"name": DEFAULT_WRITER, "role": ContributorRole.AUTHOR}],
                series_names=list(definition.series),
                category_names=list(definition.categories),
            )
            BookSource.objects.create(
                book=book,
                source_url=definition.source_url,
                normalized_source_url=definition.source_url,
                source_type="e2e_source",
                source_title=definition.title,
                is_primary=True,
            )
            if definition.with_assets:
                self.attach_asset(
                    book,
                    GeneratedAssetType.HTML,
                    "book.html",
                    "text/html",
                    f"<html><body><h1>{definition.title}</h1><p>HTML preview</p></body></html>",
                )
                self.attach_asset(
                    book,
                    GeneratedAssetType.EPUB,
                    "book.epub",
                    "application/epub+zip",
                    f"Seeded EPUB content for {definition.title}".encode("utf-8"),
                )
            books[key] = book
        return books

    def attach_asset(
        self,
        book: Book,
        asset_type: str,
        filename: str,
        content_type: str,
        content: bytes | str,
    ):
        payload = content.encode("utf-8") if isinstance(content, str) else content
        asset = GeneratedAsset.objects.create(
            book=book,
            asset_type=asset_type,
            status=GeneratedAssetStatus.READY,
            content_type=content_type,
            file_size=len(payload),
            is_protected=True,
        )
        asset.file.save(filename, ContentFile(payload), save=False)
        asset.storage_path = asset.file.name
        asset.save()

    def create_access_grants(self, admin: User, access_user: User):
        access_book = Book.objects.get(title=BOOK_DEFINITIONS["access"].title)
        PermissionGrant.objects.create(
            user=access_user,
            book=access_book,
            scope=PermissionScope.METADATA_EDIT,
            granted_by=admin,
        )

    def create_reader_state(self, admin: User, detail_book: Book):
        ReadingSession.objects.create(
            user=admin,
            book=detail_book,
            last_location="chapter-1",
            progress_percent=42.0,
        )
        Bookmark.objects.create(
            user=admin,
            book=detail_book,
            location="chapter-1",
            label="Seeded Bookmark",
            note="Remove me during the live test.",
        )

    def create_submissions(self, admin: User, books: dict[str, Book]):
        alpha = BookSubmission.objects.create(
            submitter=admin,
            input_type=SubmissionInputType.TITLE,
            origin=SubmissionOrigin.USER,
            original_input=SUBMISSION_TITLES[0],
            normalized_input=normalize_catalog_text(SUBMISSION_TITLES[0]),
            resolved_url=f"{E2E_SOURCE_PREFIX}alpha-submission/",
            resolution_status=ResolutionStatus.RESOLVED,
            resolution_confidence=0.97,
            status=SubmissionStatus.READY,
            review_state=ReviewState.APPROVED,
            linked_book=books["detail"],
        )
        beta = BookSubmission.objects.create(
            submitter=admin,
            input_type=SubmissionInputType.TITLE,
            origin=SubmissionOrigin.USER,
            original_input=SUBMISSION_TITLES[1],
            normalized_input=normalize_catalog_text(SUBMISSION_TITLES[1]),
            resolved_url=f"{E2E_SOURCE_PREFIX}beta-submission/",
            resolution_status=ResolutionStatus.RESOLVED,
            resolution_confidence=0.91,
            status=SubmissionStatus.QUEUED,
            review_state=ReviewState.PENDING,
            linked_book=books["home_primary"],
        )
        ProcessingJob.objects.create(
            submission=alpha,
            book=books["detail"],
            job_type=JobType.INGESTION,
            status=JobStatus.SUCCEEDED,
            queue_name="default",
        )
        ProcessingJob.objects.create(
            submission=beta,
            book=books["home_primary"],
            job_type=JobType.INGESTION,
            status=JobStatus.QUEUED,
            queue_name="default",
        )

    def create_catalog_state(self, admin: User):
        CatalogAutomationSettings.objects.update_or_create(
            singleton_key="default",
            defaults={
                "enabled": False,
                "daily_run_time": time(2, 0),
                "frequency": "daily",
                "mode": "pending",
                "refresh_max_pages": 80,
                "updated_by": admin,
            },
        )
        SourceCatalogRefreshState.objects.update_or_create(
            singleton_key="default",
            defaults={
                "status": SourceCatalogRefreshStatus.IDLE,
                "max_pages": 80,
                "requested_by": admin,
            },
        )
        for entry in CATALOG_ENTRIES:
            SourceCatalogEntry.objects.create(
                source_url=entry["source_url"],
                title=entry["title"],
                author_line=entry["author_line"],
                normalized_title=normalize_catalog_text(entry["title"]),
                normalized_display=normalize_catalog_text(
                    f"{entry['title']} {entry['author_line']}"
                ),
                raw_data={
                    "title": entry["title"],
                    "author": entry["author_line"],
                    "category": entry["category"],
                },
            )
