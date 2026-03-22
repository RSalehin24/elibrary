import json
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.access.models import PermissionGrant, PermissionScope
from apps.accounts.models import User
from apps.catalog.models import Book, Category, Contributor, MetadataReview, MetadataVersion, Series
from apps.catalog.services import get_or_create_category, get_or_create_contributor, get_or_create_series
from apps.ingestion.models import BookSubmission, DuplicateReview


@pytest.mark.django_db
def test_admin_metadata_update_reuses_existing_related_names_and_versions(client):
    admin = User.objects.create_superuser(email="admin@example.com", password="strong-password-123")
    existing_author = get_or_create_contributor("লেখক এক")
    existing_series = get_or_create_series("রহস্য সিরিজ")
    existing_category = get_or_create_category("উপন্যাস")
    book = Book.objects.create(title="পরিবর্তনশীল বই", state="ready", review_state="needs_review")
    client.force_login(admin)

    response = client.patch(
        f"/api/catalog/books/{book.slug}/metadata/",
        data=json.dumps(
            {
                "title": "পরিবর্তনশীল বই",
                "summary": "নতুন সারাংশ",
                "contributors": [
                    {"name": "লেখক-এক", "role": "author"},
                    {"name": "অনুবাদক এক", "role": "translator"},
                ],
                "series": ["রহস্য-সিরিজ"],
                "categories": ["উপন্যাস", "উপন্যাস"],
                "notes": "ম্যানুয়াল পর্যালোচনা",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    book.refresh_from_db()

    assert book.summary == "নতুন সারাংশ"
    assert Contributor.objects.filter(normalized_name=existing_author.normalized_name).count() == 1
    assert Series.objects.filter(normalized_name=existing_series.normalized_name).count() == 1
    assert Category.objects.filter(normalized_name=existing_category.normalized_name).count() == 1
    assert MetadataVersion.objects.filter(book=book).count() == 2


@pytest.mark.django_db
def test_staff_can_confirm_duplicate_review_to_existing_book(client):
    admin = User.objects.create_superuser(email="review-admin@example.com", password="strong-password-123")
    submitter = User.objects.create_user(email="submitter2@example.com", password="strong-password-123")
    existing_book = Book.objects.create(title="বিদ্যমান বই", state="ready", review_state="approved")
    submission = BookSubmission.objects.create(
        submitter=submitter,
        input_type="title",
        original_input="বিদ্যমান বই",
        normalized_input="বিদ্যমান বই",
        resolved_url="https://www.ebanglalibrary.com/books/existing-title/",
        resolution_status="resolved",
        resolution_confidence=0.82,
        status="duplicate",
        review_state="needs_review",
    )
    review = DuplicateReview.objects.create(submission=submission, existing_book=existing_book)
    client.force_login(admin)

    response = client.post(
        f"/api/ingestion/duplicate-reviews/{review.id}/resolve/",
        data=json.dumps({"decision": "confirm_existing", "notes": "Confirmed by staff"}),
        content_type="application/json",
    )

    assert response.status_code == 200
    submission.refresh_from_db()
    review.refresh_from_db()

    assert submission.linked_book_id == existing_book.id
    assert submission.status == "ready"
    assert review.status == "confirmed"


@pytest.mark.django_db
def test_metadata_edit_scope_allows_non_staff_editor(client):
    editor = User.objects.create_user(email="editor@example.com", password="strong-password-123")
    book = Book.objects.create(title="সম্পাদনাযোগ্য বই", state="ready", review_state="needs_review")
    PermissionGrant.objects.create(user=editor, book=book, scope=PermissionScope.METADATA_EDIT)
    client.force_login(editor)

    response = client.patch(
        f"/api/catalog/books/{book.slug}/metadata/",
        data=json.dumps({"summary": "সম্পাদিত সারাংশ", "notes": "Scoped editor"}),
        content_type="application/json",
    )

    assert response.status_code == 200
    book.refresh_from_db()
    assert book.summary == "সম্পাদিত সারাংশ"


@pytest.mark.django_db
def test_processing_manage_scope_allows_non_staff_duplicate_resolution(client):
    reviewer = User.objects.create_user(email="processor@example.com", password="strong-password-123")
    submitter = User.objects.create_user(email="submitter3@example.com", password="strong-password-123")
    existing_book = Book.objects.create(title="প্রসেসিং বই", state="ready", review_state="approved")
    submission = BookSubmission.objects.create(
        submitter=submitter,
        input_type="title",
        original_input="প্রসেসিং বই",
        normalized_input="প্রসেসিং বই",
        resolved_url="https://www.ebanglalibrary.com/books/processing-book/",
        resolution_status="resolved",
        resolution_confidence=0.8,
        status="duplicate",
        review_state="needs_review",
    )
    review = DuplicateReview.objects.create(submission=submission, existing_book=existing_book)
    PermissionGrant.objects.create(user=reviewer, scope=PermissionScope.PROCESSING_MANAGE)
    client.force_login(reviewer)

    response = client.post(
        f"/api/ingestion/duplicate-reviews/{review.id}/resolve/",
        data=json.dumps({"decision": "confirm_existing", "notes": "Scoped reviewer"}),
        content_type="application/json",
    )

    assert response.status_code == 200
    submission.refresh_from_db()
    assert submission.linked_book_id == existing_book.id


@pytest.mark.django_db
def test_metadata_review_endpoints_update_book_review_state(client):
    editor = User.objects.create_user(email="reviewer@example.com", password="strong-password-123")
    book = Book.objects.create(title="রিভিউ বই", state="ready", review_state="needs_review")
    PermissionGrant.objects.create(user=editor, book=book, scope=PermissionScope.METADATA_EDIT)
    client.force_login(editor)

    created = client.post(
        f"/api/catalog/books/{book.slug}/metadata-reviews/",
        data=json.dumps({"state": "approved", "notes": "Reviewed and approved"}),
        content_type="application/json",
    )
    assert created.status_code == 201
    book.refresh_from_db()
    assert book.review_state == "approved"
    assert MetadataReview.objects.filter(book=book).count() == 1

    listed = client.get(f"/api/catalog/books/{book.slug}/metadata-reviews/")
    assert listed.status_code == 200
    assert listed.json()[0]["state"] == "approved"

    updated = client.patch(
        f"/api/catalog/metadata-reviews/{created.json()['id']}/",
        data=json.dumps({"state": "rejected", "notes": "Needs more work"}),
        content_type="application/json",
    )
    assert updated.status_code == 200
    book.refresh_from_db()
    assert book.review_state == "rejected"


@pytest.mark.django_db
def test_catalog_can_filter_books_created_by_current_user(client):
    owner = User.objects.create_user(email="owner@example.com", password="strong-password-123")
    other_user = User.objects.create_user(email="other@example.com", password="strong-password-123")
    owner_book = Book.objects.create(title="আমার বই", state="ready", review_state="approved")
    shared_book = Book.objects.create(title="শেয়ার্ড বই", state="ready", review_state="approved")
    other_book = Book.objects.create(title="অন্য বই", state="ready", review_state="approved")

    older_submission = BookSubmission.objects.create(
        submitter=owner,
        input_type="title",
        original_input="আমার বই",
        normalized_input="আমার বই",
        linked_book=owner_book,
        status="ready",
        resolution_status="resolved",
    )
    newest_owner_submission = BookSubmission.objects.create(
        submitter=owner,
        input_type="title",
        original_input="শেয়ার্ড বই",
        normalized_input="শেয়ার্ড বই",
        linked_book=shared_book,
        status="ready",
        resolution_status="resolved",
    )
    BookSubmission.objects.create(
        submitter=other_user,
        input_type="title",
        original_input="শেয়ার্ড বই",
        normalized_input="শেয়ার্ড বই",
        linked_book=shared_book,
        status="ready",
        resolution_status="resolved",
    )
    BookSubmission.objects.create(
        submitter=other_user,
        input_type="title",
        original_input="অন্য বই",
        normalized_input="অন্য বই",
        linked_book=other_book,
        status="ready",
        resolution_status="resolved",
    )

    older_timestamp = timezone.now() - timedelta(days=2)
    newest_timestamp = timezone.now() - timedelta(hours=2)
    BookSubmission.objects.filter(pk=older_submission.pk).update(created_at=older_timestamp)
    BookSubmission.objects.filter(pk=newest_owner_submission.pk).update(created_at=newest_timestamp)

    client.force_login(owner)
    response = client.get("/api/catalog/books/?ownership=mine&sort=-requested_at")

    assert response.status_code == 200
    payload = response.json()
    assert [entry["slug"] for entry in payload] == [shared_book.slug, owner_book.slug]
    assert other_book.slug not in {entry["slug"] for entry in payload}
    assert payload[0]["latest_submission_at"]
    assert payload[1]["latest_submission_at"]
