import json
from datetime import timedelta

import pytest
from django.utils import timezone
from django.utils.text import slugify

from apps.access.models import PermissionGrant, PermissionScope
from apps.accounts.models import User
from apps.catalog.models import Book, BookContributor, Category, Contributor, MetadataReview, MetadataVersion, Series
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
def test_book_slug_and_normalized_title_preserve_bengali_marks():
    book = Book.objects.create(title="ম্যালিস", state="ready", review_state="pending")

    assert book.title == "ম্যালিস"
    assert book.normalized_title == "ম্যালিস"
    assert book.slug == "ম্যালিস"

    book.title = "ম্যালিস সমগ্র"
    book.save()

    assert book.normalized_title == "ম্যালিস সমগ্র"
    assert book.slug == "ম্যালিস-সমগ্র"


@pytest.mark.django_db
def test_book_detail_lookup_accepts_legacy_slug_for_unicode_titles(client):
    user = User.objects.create_user(email="reader@example.com", password="strong-password-123")
    book = Book.objects.create(title="ম্যালিস", state="ready", review_state="pending")
    client.force_login(user)

    response = client.get(f"/api/catalog/books/{slugify(book.title, allow_unicode=True)}/")

    assert response.status_code == 200
    assert response.json()["slug"] == "ম্যালিস"


@pytest.mark.django_db
def test_book_detail_surfaces_front_matter_and_missing_role_contributors(client):
    user = User.objects.create_user(email="reader2@example.com", password="strong-password-123")
    book = Book.objects.create(
        title="সাজানো বই",
        state="ready",
        review_state="pending",
        book_info_html="""
        <p><strong>অনুবাদ</strong>: অনুবাদক এক</p>
        <p><strong>প্রথম প্রকাশ</strong>: ২০০৫</p>
        <p><strong>প্রকাশক</strong>: প্রকাশনী ঘর</p>
        """,
    )
    client.force_login(user)

    response = client.get(f"/api/catalog/books/{book.slug}/")

    assert response.status_code == 200
    payload = response.json()
    assert {"name": "অনুবাদক এক", "role": "translator"} in payload["contributors"]
    assert {"name": "প্রকাশনী ঘর", "role": "publisher"} in payload["contributors"]
    assert payload["front_matter"] == [
        {
            "key": "first_published",
            "label": "প্রথম প্রকাশ",
            "value": "২০০৫",
            "role": "",
        }
    ]


@pytest.mark.django_db
def test_book_detail_falls_back_to_leading_main_content_front_matter(client):
    user = User.objects.create_user(email="reader-main-content@example.com", password="strong-password-123")
    book = Book.objects.create(
        title="ম্যালিস",
        state="ready",
        review_state="pending",
        main_content_html="""
        <div>
          <h2 class="wp-block-heading">ম্যালিস – কিয়েগো হিগাশিনো</h2>
          <p><strong>ম্যালিস – কিয়েগো হিগাশিনো</strong><br/>অনুবাদ: সালমান হক, ইশরাক অর্ণব</p>
          <p>প্রথম প্রকাশ: মার্চ ২০২৩</p>
          <p><strong>ভূমিকা</strong></p>
          <p>এটাই মূল কনটেন্ট।</p>
        </div>
        """,
    )
    client.force_login(user)

    response = client.get(f"/api/catalog/books/{book.slug}/")

    assert response.status_code == 200
    payload = response.json()
    assert {"name": "সালমান হক", "role": "translator"} in payload["contributors"]
    assert {"name": "ইশরাক অর্ণব", "role": "translator"} in payload["contributors"]
    assert {
        "key": "first_published",
        "label": "প্রথম প্রকাশ",
        "value": "মার্চ ২০২৩",
        "role": "",
    } in payload["front_matter"]


@pytest.mark.django_db
def test_book_detail_hides_author_role_when_same_person_is_translator(client):
    user = User.objects.create_user(email="reader-roles@example.com", password="strong-password-123")
    book = Book.objects.create(
        title="ভূমিকা সহ বই",
        state="ready",
        review_state="pending",
        book_info_html="""
        <p><strong>অনুবাদ</strong>: ইশরাক অর্ণব</p>
        """,
    )
    shared_contributor = get_or_create_contributor("ইশরাক অর্ণব")
    other_author = get_or_create_contributor("সালমান হক")
    BookContributor.objects.create(book=book, contributor=shared_contributor, role="author", sort_order=0)
    BookContributor.objects.create(book=book, contributor=other_author, role="author", sort_order=1)
    client.force_login(user)

    response = client.get(f"/api/catalog/books/{book.slug}/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["authors"] == ["সালমান হক"]
    assert {"name": "ইশরাক অর্ণব", "role": "translator"} in payload["contributors"]
    assert {"name": "ইশরাক অর্ণব", "role": "author"} not in payload["contributors"]


@pytest.mark.django_db
def test_book_list_includes_translators_for_card_display(client):
    user = User.objects.create_user(email="reader-list@example.com", password="strong-password-123")
    book = Book.objects.create(title="কার্ড বই", state="ready", review_state="pending")
    author = get_or_create_contributor("কেইগো হিগাশিনো")
    translator = get_or_create_contributor("সালমান হক")
    BookContributor.objects.create(book=book, contributor=author, role="author", sort_order=0)
    BookContributor.objects.create(book=book, contributor=translator, role="translator", sort_order=1)
    client.force_login(user)

    response = client.get("/api/catalog/books/")

    assert response.status_code == 200
    payload = response.json()[0]
    assert payload["authors"] == ["কেইগো হিগাশিনো"]
    assert {"name": "সালমান হক", "role": "translator"} in payload["contributors"]


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
def test_metadata_update_drops_author_role_when_same_name_is_translator_or_editor(client):
    admin = User.objects.create_superuser(email="dedupe-admin@example.com", password="strong-password-123")
    book = Book.objects.create(title="রোল সাজানো বই", state="ready", review_state="pending")
    client.force_login(admin)

    response = client.patch(
        f"/api/catalog/books/{book.slug}/metadata/",
        data=json.dumps(
            {
                "contributors": [
                    {"name": "ইশরাক অর্ণব", "role": "author"},
                    {"name": "ইশরাক অর্ণব", "role": "translator"},
                    {"name": "কেইগো হিগাশিনো", "role": "author"},
                    {"name": "কেইগো হিগাশিনো", "role": "editor"},
                ],
                "notes": "Normalize contributor roles",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    contributor_roles = {(relation.contributor.name, relation.role) for relation in book.book_contributors.all()}
    assert ("ইশরাক অর্ণব", "translator") in contributor_roles
    assert ("কেইগো হিগাশিনো", "editor") in contributor_roles
    assert ("ইশরাক অর্ণব", "author") not in contributor_roles
    assert ("কেইগো হিগাশিনো", "author") not in contributor_roles


@pytest.mark.django_db
def test_metadata_edit_scope_allows_non_staff_editor_to_soft_delete_book(client):
    editor = User.objects.create_user(email="delete-editor@example.com", password="strong-password-123")
    book = Book.objects.create(title="মুছে ফেলার বই", state="ready", review_state="approved")
    PermissionGrant.objects.create(user=editor, book=book, scope=PermissionScope.METADATA_EDIT)
    client.force_login(editor)

    response = client.delete(f"/api/catalog/books/{book.slug}/")

    assert response.status_code == 204
    book.refresh_from_db()
    assert book.deleted_at is not None
    assert book.state == "soft_deleted"


@pytest.mark.django_db
def test_book_delete_requires_metadata_edit_scope(client):
    user = User.objects.create_user(email="reader-delete@example.com", password="strong-password-123")
    book = Book.objects.create(title="নিরাপদ বই", state="ready", review_state="approved")
    client.force_login(user)

    response = client.delete(f"/api/catalog/books/{book.slug}/")

    assert response.status_code == 403
    book.refresh_from_db()
    assert book.deleted_at is None


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
