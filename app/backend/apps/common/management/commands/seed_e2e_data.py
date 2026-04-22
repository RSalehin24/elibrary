from __future__ import annotations

from dataclasses import dataclass
from datetime import time
import re

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
from apps.common.epub_utils import build_simple_epub
from apps.common.text import normalize_catalog_text
from apps.ingestion.models import (
    BookSubmission,
    CatalogAutomationSettings,
    CatalogCurationMode,
    CatalogCurationRun,
    CatalogCurationTrigger,
    DuplicateReview,
    DuplicateReviewStatus,
    JobStatus,
    JobType,
    ProcessingJob,
    ProcessingLog,
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
        "title": "000 E2E Alpha Catalog Book",
        "source_url": f"{E2E_SOURCE_PREFIX}alpha-catalog-book/",
        "author_line": DEFAULT_WRITER,
        "category": DEFAULT_CATEGORY,
    },
    {
        "title": "001 E2E Beta Catalog Book",
        "source_url": f"{E2E_SOURCE_PREFIX}beta-catalog-book/",
        "author_line": DEFAULT_WRITER,
        "category": DEFAULT_CATEGORY,
    },
    {
        "title": "002 E2E Incomplete Catalog Book",
        "source_url": f"{E2E_SOURCE_PREFIX}incomplete-catalog-book/",
        "author_line": DEFAULT_WRITER,
        "category": INCOMPLETE_CATEGORY,
    },
)

ACCESS_USER_EMAIL = f"access-manager{E2E_EMAIL_DOMAIN}"
ACCESS_USER_PASSWORD = "E2E-access-pass-123"

PROCESSING_SUBMISSION_TITLES = {
    "user_pending": "E2E User Pending Submission",
    "user_processing": "E2E User Processing Submission",
    "user_stopped": "E2E User Stopped Submission",
    "user_deleted": "E2E User Deleted Submission",
    "user_failed": "E2E User Failed Submission",
    "automation_pending": "E2E Automation Pending Submission",
    "automation_ready": "E2E Automation Ready Submission",
    "automation_processing": "E2E Automation Processing Submission",
    "automation_queued": "E2E Automation Queued Submission",
    "automation_stopped": "E2E Automation Stopped Submission",
    "automation_deleted": "E2E Automation Deleted Submission",
    "curation_ready": "E2E Curation Ready Submission",
    "curation_processing": "E2E Curation Processing Submission",
    "curation_queued": "E2E Curation Queued Submission",
    "curation_stopped": "E2E Curation Stopped Submission",
    "curation_deleted": "E2E Curation Deleted Submission",
    "duplicate_review": "E2E Duplicate Review Submission",
}

FAILED_LOG_MESSAGE = "Seeded failed job log entry."

SCHEDULED_RUN_ACTIVE_SUMMARY = {
    "queued_creates": 7,
    "queued_updates": 1,
    "skipped_ready": 2,
}

SCHEDULED_RUN_FAILED_SUMMARY = {
    "queued_creates": 2,
    "queued_updates": 3,
    "skipped_ready": 4,
}


def seed_source_url(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return f"{E2E_SOURCE_PREFIX}{slug}/"


class Command(BaseCommand):
    help = "Reset and seed deterministic local E2E data for real browser tests."

    def handle(self, *args, **options):
        if not settings.SUPER_ADMIN_EMAIL or not settings.SUPER_ADMIN_PASSWORD:
            raise CommandError(
                "SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set before seeding E2E data."
            )

        from apps.processing.models import (
            BookCreationRequest,
            BookCreationRequestState,
            BookRecord,
        )
        from apps.processing.services import (
            rebuild_processing_ui_state,
            reset_processing_data,
            sync_record_state,
        )

        call_command("seed_superadmin")
        admin = User.objects.filter(email=settings.SUPER_ADMIN_EMAIL).first()
        if admin is None:
            raise CommandError("Could not resolve the configured super admin account.")

        # Reset throttle/session cache so repeated live-browser runs start cleanly.
        cache.clear()
        reset_processing_data(revoke_tasks=True, purge_queue=True)

        with transaction.atomic():
            self.cleanup_existing_records()
            access_user = self.create_access_user(admin)
            books = self.create_books()
            self.create_access_grants(admin, access_user)
            self.create_reader_state(admin, books["detail"])
            self.create_submissions(admin, books)
            self.create_catalog_state(admin)
            self.create_processing_state(
                BookRecord=BookRecord,
                BookCreationRequest=BookCreationRequest,
                BookCreationRequestState=BookCreationRequestState,
                sync_record_state=sync_record_state,
            )

        rebuild_processing_ui_state()

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
        CatalogCurationRun.objects.all().delete()
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
                    build_simple_epub(definition.title),
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
            last_location="text/chapter-1.xhtml",
            progress_percent=42.0,
        )
        Bookmark.objects.create(
            user=admin,
            book=detail_book,
            location="text/chapter-1.xhtml",
            label="Seeded Bookmark",
            note="Remove me during the live test.",
        )

    def create_submission_record(
        self,
        *,
        submitter: User,
        title: str,
        origin: str,
        status: str,
        review_state: str = ReviewState.PENDING,
        linked_book: Book | None = None,
        input_type: str = SubmissionInputType.TITLE,
        resolved_url: str | None = None,
        resolution_status: str = ResolutionStatus.RESOLVED,
        resolution_confidence: float = 0.95,
        error_message: str = "",
    ) -> BookSubmission:
        return BookSubmission.objects.create(
            submitter=submitter,
            input_type=input_type,
            origin=origin,
            original_input=title,
            normalized_input=normalize_catalog_text(title),
            resolved_url=resolved_url if resolved_url is not None else seed_source_url(title),
            resolution_status=resolution_status,
            resolution_confidence=resolution_confidence,
            status=status,
            review_state=review_state,
            linked_book=linked_book,
            error_message=error_message,
        )

    def create_processing_job_record(
        self,
        *,
        submission: BookSubmission,
        book: Book | None = None,
        status: str,
        job_type: str = JobType.INGESTION,
        queue_name: str = "",
        task_id: str = "",
        last_error: str = "",
        cancel_requested: bool = False,
    ) -> ProcessingJob:
        return ProcessingJob.objects.create(
            submission=submission,
            book=book,
            job_type=job_type,
            status=status,
            queue_name=queue_name,
            task_id=task_id,
            cancel_requested=cancel_requested,
            last_error=last_error,
        )

    def create_submissions(self, admin: User, books: dict[str, Book]):
        alpha = self.create_submission_record(
            submitter=admin,
            title=SUBMISSION_TITLES[0],
            origin=SubmissionOrigin.USER,
            status=SubmissionStatus.READY,
            review_state=ReviewState.APPROVED,
            linked_book=books["detail"],
            resolved_url=f"{E2E_SOURCE_PREFIX}alpha-submission/",
            resolution_confidence=0.97,
        )
        beta = self.create_submission_record(
            submitter=admin,
            title=SUBMISSION_TITLES[1],
            origin=SubmissionOrigin.USER,
            status=SubmissionStatus.QUEUED,
            review_state=ReviewState.PENDING,
            linked_book=books["home_primary"],
            resolved_url=f"{E2E_SOURCE_PREFIX}beta-submission/",
            resolution_confidence=0.91,
        )
        self.create_processing_job_record(
            submission=alpha,
            book=books["detail"],
            status=JobStatus.SUCCEEDED,
            queue_name="default",
        )
        self.create_processing_job_record(
            submission=beta,
            book=books["home_primary"],
            status=JobStatus.QUEUED,
            queue_name="default",
        )

        self.create_submission_record(
            submitter=admin,
            title=PROCESSING_SUBMISSION_TITLES["user_pending"],
            origin=SubmissionOrigin.USER,
            status=SubmissionStatus.PENDING_RESOLUTION,
            review_state=ReviewState.PENDING,
            resolution_status=ResolutionStatus.UNRESOLVED,
            resolution_confidence=0.0,
            resolved_url="",
        )

        user_processing = self.create_submission_record(
            submitter=admin,
            title=PROCESSING_SUBMISSION_TITLES["user_processing"],
            origin=SubmissionOrigin.USER,
            status=SubmissionStatus.PROCESSING,
            review_state=ReviewState.PENDING,
            linked_book=books["home_secondary"],
            resolved_url=BOOK_DEFINITIONS["home_secondary"].source_url,
        )
        self.create_processing_job_record(
            submission=user_processing,
            book=books["home_secondary"],
            status=JobStatus.PROCESSING,
            queue_name="celery",
            task_id="seed-user-processing",
        )

        user_stopped = self.create_submission_record(
            submitter=admin,
            title=PROCESSING_SUBMISSION_TITLES["user_stopped"],
            origin=SubmissionOrigin.USER,
            status=SubmissionStatus.CANCELLED,
            review_state=ReviewState.PENDING,
            resolved_url=BOOK_DEFINITIONS["detail"].source_url,
            error_message="Stopped by user.",
        )
        self.create_processing_job_record(
            submission=user_stopped,
            status=JobStatus.CANCELLED,
            last_error="Stopped by user.",
        )

        user_deleted = self.create_submission_record(
            submitter=admin,
            title=PROCESSING_SUBMISSION_TITLES["user_deleted"],
            origin=SubmissionOrigin.USER,
            status=SubmissionStatus.DELETED,
            review_state=ReviewState.PENDING,
            resolved_url=BOOK_DEFINITIONS["preview"].source_url,
        )
        self.create_processing_job_record(
            submission=user_deleted,
            status=JobStatus.CANCELLED,
            last_error="Deleted by user.",
        )

        user_failed = self.create_submission_record(
            submitter=admin,
            title=PROCESSING_SUBMISSION_TITLES["user_failed"],
            origin=SubmissionOrigin.USER,
            status=SubmissionStatus.FAILED,
            review_state=ReviewState.NEEDS_REVIEW,
            error_message="Seeded failure for live-browser coverage.",
        )
        failed_job = self.create_processing_job_record(
            submission=user_failed,
            status=JobStatus.FAILED,
            last_error="Seeded failure for live-browser coverage.",
        )
        ProcessingLog.objects.create(
            job=failed_job,
            level="error",
            message=FAILED_LOG_MESSAGE,
            details={"seed": "e2e"},
        )

        duplicate_submission = self.create_submission_record(
            submitter=admin,
            title=PROCESSING_SUBMISSION_TITLES["duplicate_review"],
            origin=SubmissionOrigin.USER,
            status=SubmissionStatus.DUPLICATE,
            review_state=ReviewState.NEEDS_REVIEW,
            linked_book=None,
            resolved_url=BOOK_DEFINITIONS["preview"].source_url,
        )
        DuplicateReview.objects.create(
            submission=duplicate_submission,
            existing_book=books["home_secondary"],
            status=DuplicateReviewStatus.PENDING,
            notes="Seeded duplicate review for live-browser coverage.",
        )

        for title, status, review_state, book_key, resolved_book_key, job_status, task_id in (
            (
                PROCESSING_SUBMISSION_TITLES["automation_pending"],
                SubmissionStatus.PENDING_RESOLUTION,
                ReviewState.PENDING,
                None,
                None,
                "",
                "",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["automation_ready"],
                SubmissionStatus.READY,
                ReviewState.APPROVED,
                "preview",
                "preview",
                JobStatus.SUCCEEDED,
                "",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["automation_processing"],
                SubmissionStatus.PROCESSING,
                ReviewState.PENDING,
                "preview",
                "preview",
                JobStatus.PROCESSING,
                "seed-automation-processing",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["automation_queued"],
                SubmissionStatus.QUEUED,
                ReviewState.PENDING,
                "preview",
                "preview",
                JobStatus.QUEUED,
                "",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["automation_stopped"],
                SubmissionStatus.CANCELLED,
                ReviewState.PENDING,
                None,
                "preview",
                JobStatus.CANCELLED,
                "",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["automation_deleted"],
                SubmissionStatus.DELETED,
                ReviewState.PENDING,
                None,
                "preview",
                JobStatus.CANCELLED,
                "",
            ),
        ):
            submission = self.create_submission_record(
                submitter=admin,
                title=title,
                origin=SubmissionOrigin.AUTOMATION,
                status=status,
                review_state=review_state,
                linked_book=books[book_key] if book_key else None,
                resolution_status=(
                    ResolutionStatus.UNRESOLVED
                    if status == SubmissionStatus.PENDING_RESOLUTION
                    else ResolutionStatus.RESOLVED
                ),
                resolution_confidence=0.0
                if status == SubmissionStatus.PENDING_RESOLUTION
                else 0.9,
                resolved_url=""
                if status == SubmissionStatus.PENDING_RESOLUTION
                else BOOK_DEFINITIONS[resolved_book_key].source_url,
                error_message="Stopped by user."
                if status == SubmissionStatus.CANCELLED
                else "",
            )
            if job_status:
                self.create_processing_job_record(
                    submission=submission,
                    book=books[book_key] if book_key else None,
                    status=job_status,
                    queue_name="celery" if job_status == JobStatus.PROCESSING else "",
                    task_id=task_id,
                    last_error="Stopped by user."
                    if job_status == JobStatus.CANCELLED
                    else "",
                )

        for title, status, review_state, book_key, resolved_book_key, job_status, task_id in (
            (
                PROCESSING_SUBMISSION_TITLES["curation_ready"],
                SubmissionStatus.READY,
                ReviewState.APPROVED,
                "access",
                "access",
                JobStatus.SUCCEEDED,
                "",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["curation_processing"],
                SubmissionStatus.PROCESSING,
                ReviewState.PENDING,
                "access",
                "access",
                JobStatus.PROCESSING,
                "seed-curation-processing",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["curation_queued"],
                SubmissionStatus.QUEUED,
                ReviewState.PENDING,
                "access",
                "access",
                JobStatus.QUEUED,
                "",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["curation_stopped"],
                SubmissionStatus.CANCELLED,
                ReviewState.PENDING,
                None,
                "access",
                JobStatus.CANCELLED,
                "",
            ),
            (
                PROCESSING_SUBMISSION_TITLES["curation_deleted"],
                SubmissionStatus.DELETED,
                ReviewState.PENDING,
                None,
                "access",
                JobStatus.CANCELLED,
                "",
            ),
        ):
            submission = self.create_submission_record(
                submitter=admin,
                title=title,
                origin=SubmissionOrigin.CURATION,
                status=status,
                review_state=review_state,
                linked_book=books[book_key] if book_key else None,
                resolved_url=BOOK_DEFINITIONS[resolved_book_key].source_url,
                error_message="Stopped by user."
                if status == SubmissionStatus.CANCELLED
                else "",
            )
            self.create_processing_job_record(
                submission=submission,
                book=books[book_key] if book_key else None,
                status=job_status,
                queue_name="celery" if job_status == JobStatus.PROCESSING else "",
                task_id=task_id,
                last_error="Stopped by user."
                if job_status == JobStatus.CANCELLED
                else "",
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
        CatalogCurationRun.objects.create(
            trigger=CatalogCurationTrigger.SCHEDULED,
            mode=CatalogCurationMode.PENDING,
            status=JobStatus.CANCELLED,
            refresh_catalog=True,
            refresh_max_pages=12,
            requested_by=admin,
            last_error="Seeded scheduled run stopped.",
            summary=SCHEDULED_RUN_ACTIVE_SUMMARY,
        )
        CatalogCurationRun.objects.create(
            trigger=CatalogCurationTrigger.SCHEDULED,
            mode=CatalogCurationMode.ALL,
            status=JobStatus.FAILED,
            refresh_catalog=True,
            refresh_max_pages=24,
            requested_by=admin,
            last_error="Seeded scheduled automation failure.",
            summary=SCHEDULED_RUN_FAILED_SUMMARY,
        )

    def create_processing_state(
        self,
        *,
        BookRecord,
        BookCreationRequest,
        BookCreationRequestState,
        sync_record_state,
    ):
        created_record, _ = BookRecord.objects.update_or_create(
            url=seed_source_url("seeded-created-flow-record"),
            defaults={
                "name": "000 E2E Seeded Created Flow Record",
                "category": DEFAULT_CATEGORY,
                "writer": DEFAULT_WRITER,
                "translator": "",
                "composer": "",
                "publisher": "",
                "linked_book": None,
                "was_incomplete": False,
                "resolved_from_incomplete": False,
                "will_resolve_to_category": "",
                "is_duplicate": False,
                "duplicate_of_record": None,
                "source_catalog_entry": None,
            },
        )
        BookCreationRequest.objects.create(
            book_record=created_record,
            state=BookCreationRequestState.CREATED,
            origin=SubmissionOrigin.CURATION,
        )
        sync_record_state(created_record)
