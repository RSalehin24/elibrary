from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import uuid4

from rest_framework import serializers
from rest_framework.reverse import reverse

from apps.catalog.models import (
    Book,
    BookRecordType,
    Category,
    Contributor,
    ContributorRole,
    GeneratedAsset,
    GeneratedAssetStatus,
    GeneratedAssetType,
    ManualBindingType,
    MetadataReview,
    MetadataVersion,
)
from apps.catalog.services import replace_book_relations
from apps.catalog.services import normalize_book_contributors
from apps.common.models import LifecycleState, ReviewState
from apps.common.permissions import user_can_download_book_assets, user_can_view_book_cover
from apps.common.url_utils import public_api_url
from apps.ingestion.services.normalization import combined_front_matter_html, extract_front_matter_entries, split_multi_value


class GeneratedAssetSerializer(serializers.ModelSerializer):
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = GeneratedAsset
        fields = [
            "id",
            "asset_type",
            "status",
            "content_type",
            "file_size",
            "download_url",
        ]

    def get_download_url(self, obj):
        request = self.context.get("request")
        if request is not None:
            if obj.asset_type == GeneratedAssetType.COVER:
                if not user_can_view_book_cover(request.user, obj.book):
                    return ""
            elif not user_can_download_book_assets(request.user, obj.book):
                return ""
        return public_api_url(
            "access-book-asset-download",
            kwargs={"slug": obj.book.slug, "asset_type": obj.asset_type},
            request=request,
        )


class BookListSerializer(serializers.ModelSerializer):
    authors = serializers.SerializerMethodField()
    translators = serializers.SerializerMethodField()
    editors = serializers.SerializerMethodField()
    contributors = serializers.SerializerMethodField()
    series = serializers.SerializerMethodField()
    categories = serializers.SerializerMethodField()
    cover_download_url = serializers.SerializerMethodField()
    latest_submission_at = serializers.SerializerMethodField()
    primary_source = serializers.SerializerMethodField()
    binding = serializers.SerializerMethodField()
    publisher = serializers.CharField(source="manual_publisher", read_only=True)
    price = serializers.DecimalField(source="manual_price", read_only=True, max_digits=10, decimal_places=2, allow_null=True)
    is_compilation = serializers.BooleanField(source="manual_is_compilation", read_only=True)

    class Meta:
        model = Book
        fields = [
            "id",
            "catalog_code",
            "record_type",
            "title",
            "slug",
            "state",
            "review_state",
            "authors",
            "translators",
            "editors",
            "contributors",
            "series",
            "categories",
            "binding",
            "publisher",
            "price",
            "is_compilation",
            "cover_download_url",
            "latest_submission_at",
            "primary_source",
            "created_at",
        ]

    def get_authors(self, obj):
        contributors = self.get_contributors(obj)
        return [entry["name"] for entry in contributors if entry["role"] == ContributorRole.AUTHOR]

    def get_contributors(self, obj):
        return normalize_book_contributors(
            [{"name": rel.contributor.name, "role": rel.role} for rel in obj.book_contributors.all()]
        )

    def get_translators(self, obj):
        return [entry["name"] for entry in self.get_contributors(obj) if entry["role"] == ContributorRole.TRANSLATOR]

    def get_editors(self, obj):
        return [entry["name"] for entry in self.get_contributors(obj) if entry["role"] == ContributorRole.EDITOR]

    def get_series(self, obj):
        return [rel.series.name for rel in obj.book_series.all()]

    def get_categories(self, obj):
        return [rel.category.name for rel in obj.book_categories.all()]

    def get_cover_download_url(self, obj):
        request = self.context.get("request")
        if request is not None and not user_can_view_book_cover(request.user, obj):
            return ""
        cover = next(
            (
                asset
                for asset in obj.generated_assets.all()
                if asset.asset_type == GeneratedAssetType.COVER and asset.status == GeneratedAssetStatus.READY
            ),
            None,
        )
        if not cover:
            return ""
        return public_api_url(
            "access-book-asset-download",
            kwargs={"slug": obj.slug, "asset_type": "cover"},
            request=request,
        )

    def get_latest_submission_at(self, obj):
        return getattr(obj, "latest_submission_at", None)

    def serialize_source_record(self, source):
        url = source.normalized_source_url or source.source_url
        parsed = urlparse(url)
        display_url = unquote(url)
        display_path = unquote(parsed.path).strip("/") or parsed.netloc
        return {
            "url": url,
            "display_url": display_url,
            "display_path": display_path,
            "source_title": source.source_title,
            "source_type": source.source_type,
            "site": parsed.netloc,
            "is_primary": source.is_primary,
        }

    def get_primary_source(self, obj):
        sources = list(obj.source_urls.all())
        if not sources:
            return None
        primary = next((source for source in sources if source.is_primary), sources[0])
        return self.serialize_source_record(primary)

    def get_binding(self, obj):
        return obj.get_manual_binding_display() if obj.manual_binding else ""


class BookDetailSerializer(BookListSerializer):
    assets = GeneratedAssetSerializer(source="generated_assets", many=True, read_only=True)
    source_urls = serializers.SerializerMethodField()
    source_records = serializers.SerializerMethodField()
    front_matter = serializers.SerializerMethodField()
    latest_processing_job = serializers.SerializerMethodField()
    book_info_html = serializers.CharField()
    dedication_html = serializers.CharField()
    toc = serializers.JSONField()
    raw_provenance = serializers.SerializerMethodField()

    class Meta(BookListSerializer.Meta):
        fields = BookListSerializer.Meta.fields + [
            "assets",
            "source_urls",
            "source_records",
            "front_matter",
            "latest_processing_job",
            "book_info_html",
            "dedication_html",
            "toc",
            "metadata_last_reviewed_at",
            "raw_provenance",
        ]

    def build_contributors_payload(self, obj):
        front_matter_html = combined_front_matter_html(obj.book_info_html, obj.main_content_html)
        payload = []
        for relation in obj.book_contributors.all():
            payload.append(
                {
                    "name": relation.contributor.name,
                    "role": relation.role,
                }
            )

        for entry in extract_front_matter_entries(front_matter_html):
            if not entry["role"]:
                continue
            for name in split_multi_value(entry["value"]):
                payload.append({"name": name, "role": entry["role"]})

        return normalize_book_contributors(payload)

    def get_authors(self, obj):
        return [entry["name"] for entry in self.build_contributors_payload(obj) if entry["role"] == ContributorRole.AUTHOR]

    def get_contributors(self, obj):
        return self.build_contributors_payload(obj)

    def get_source_urls(self, obj):
        return [source.normalized_source_url for source in obj.source_urls.all()]

    def get_source_records(self, obj):
        return [self.serialize_source_record(source) for source in obj.source_urls.all()]

    def get_front_matter(self, obj):
        front_matter_html = combined_front_matter_html(obj.book_info_html, obj.main_content_html)
        return [entry for entry in extract_front_matter_entries(front_matter_html) if not entry["role"]]

    def get_latest_processing_job(self, obj):
        job = obj.processing_jobs.first()
        if not job:
            return None
        return {
            "id": str(job.id),
            "job_type": job.job_type,
            "status": job.status,
            "queue_name": job.queue_name,
            "retry_count": job.retry_count,
            "last_error": job.last_error,
            "created_at": job.created_at,
            "started_at": job.started_at,
            "finished_at": job.finished_at,
        }

    def get_raw_provenance(self, obj):
        request = self.context.get("request")
        if request and request.user.is_authenticated and request.user.is_staff:
            return {
                "raw_scraped_metadata": obj.raw_scraped_metadata,
                "raw_scrape_payload": obj.raw_scrape_payload,
            }
        return {}


class CategoryListSerializer(serializers.ModelSerializer):
    book_count = serializers.IntegerField(read_only=True)
    digital_book_count = serializers.IntegerField(read_only=True)
    manual_book_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Category
        fields = [
            "id",
            "catalog_code",
            "name",
            "slug",
            "book_count",
            "digital_book_count",
            "manual_book_count",
            "created_at",
        ]


class WriterListSerializer(serializers.ModelSerializer):
    book_count = serializers.IntegerField(read_only=True)
    digital_book_count = serializers.IntegerField(read_only=True)
    manual_book_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Contributor
        fields = [
            "id",
            "catalog_code",
            "name",
            "slug",
            "book_count",
            "digital_book_count",
            "manual_book_count",
            "created_at",
        ]


def normalize_name_list(values):
    seen = set()
    normalized_values = []
    for raw_value in values or []:
        value = (raw_value or "").strip()
        if not value:
            continue
        normalized_key = value.casefold()
        if normalized_key in seen:
            continue
        seen.add(normalized_key)
        normalized_values.append(value)
    return normalized_values


class ManualBookCreateSerializer(serializers.Serializer):
    title = serializers.CharField()
    summary = serializers.CharField(required=False, allow_blank=True)
    writers = serializers.ListField(child=serializers.CharField(), allow_empty=False)
    translators = serializers.ListField(child=serializers.CharField(), required=False, allow_empty=True)
    editors = serializers.ListField(child=serializers.CharField(), required=False, allow_empty=True)
    categories = serializers.ListField(child=serializers.CharField(), allow_empty=False)
    series = serializers.ListField(child=serializers.CharField(), required=False, allow_empty=True)
    is_compilation = serializers.BooleanField(required=False, default=False)
    binding = serializers.ChoiceField(choices=ManualBindingType.choices, required=False, allow_blank=True)
    publisher = serializers.CharField(required=False, allow_blank=True)
    price = serializers.DecimalField(required=False, allow_null=True, max_digits=10, decimal_places=2)

    def validate_title(self, value):
        title = value.strip()
        if not title:
            raise serializers.ValidationError("This field may not be blank.")
        return title

    def validate_writers(self, value):
        writers = normalize_name_list(value)
        if not writers:
            raise serializers.ValidationError("Add at least one writer.")
        return writers

    def validate_categories(self, value):
        categories = normalize_name_list(value)
        if not categories:
            raise serializers.ValidationError("Add at least one category.")
        return categories

    def validate_translators(self, value):
        return normalize_name_list(value)

    def validate_editors(self, value):
        return normalize_name_list(value)

    def validate_series(self, value):
        return normalize_name_list(value)

    def create(self, validated_data):
        writer_names = validated_data.pop("writers", [])
        translator_names = validated_data.pop("translators", [])
        editor_names = validated_data.pop("editors", [])
        category_names = validated_data.pop("categories", [])
        series_names = validated_data.pop("series", [])
        book = Book.objects.create(
            title=validated_data["title"],
            summary=validated_data.get("summary", ""),
            state=LifecycleState.READY,
            review_state=ReviewState.APPROVED,
            record_type=BookRecordType.MANUAL,
            manual_is_compilation=validated_data.get("is_compilation", False),
            manual_binding=validated_data.get("binding", ""),
            manual_publisher=validated_data.get("publisher", ""),
            manual_price=validated_data.get("price"),
            source_site=f"manual-library:{uuid4().hex}",
            raw_scraped_metadata={"manual_entry": True},
            raw_scrape_payload={"manual_entry": True},
        )
        replace_book_relations(
            book,
            contributors=[
                *[{"name": writer_name, "role": ContributorRole.AUTHOR} for writer_name in writer_names],
                *[{"name": translator_name, "role": ContributorRole.TRANSLATOR} for translator_name in translator_names],
                *[{"name": editor_name, "role": ContributorRole.EDITOR} for editor_name in editor_names],
            ],
            series_names=series_names,
            category_names=category_names,
        )
        return book


class EpubAssetReplaceSerializer(serializers.Serializer):
    file = serializers.FileField()

    def validate_file(self, value):
        if Path(value.name).suffix.lower() != ".epub":
            raise serializers.ValidationError("Please upload an EPUB file.")
        return value


class MetadataContributorInputSerializer(serializers.Serializer):
    name = serializers.CharField()
    role = serializers.ChoiceField(choices=ContributorRole.choices)


class BookMetadataUpdateSerializer(serializers.ModelSerializer):
    contributors = MetadataContributorInputSerializer(many=True, required=False)
    series = serializers.ListField(child=serializers.CharField(), required=False)
    categories = serializers.ListField(child=serializers.CharField(), required=False)
    notes = serializers.CharField(required=False, allow_blank=True, write_only=True)

    class Meta:
        model = Book
        fields = [
            "title",
            "summary",
            "state",
            "review_state",
            "book_info_html",
            "dedication_html",
            "main_content_html",
            "toc",
            "contributors",
            "series",
            "categories",
            "notes",
        ]

    def snapshot(self, instance):
        return {
            "title": instance.title,
            "summary": instance.summary,
            "state": instance.state,
            "review_state": instance.review_state,
            "book_info_html": instance.book_info_html,
            "dedication_html": instance.dedication_html,
            "main_content_html": instance.main_content_html,
            "toc": instance.toc,
            "contributors": [
                {"name": relation.contributor.name, "role": relation.role}
                for relation in instance.book_contributors.all()
            ],
            "series": [relation.series.name for relation in instance.book_series.all()],
            "categories": [relation.category.name for relation in instance.book_categories.all()],
        }

    def update(self, instance, validated_data):
        notes = validated_data.pop("notes", "")
        contributors = validated_data.pop("contributors", None)
        series = validated_data.pop("series", None)
        categories = validated_data.pop("categories", None)
        actor = self.context["request"].user

        MetadataVersion.objects.create(
            book=instance,
            snapshot=self.snapshot(instance),
            source="manual_edit_before",
            notes=notes,
            created_by=actor,
        )

        for field, value in validated_data.items():
            setattr(instance, field, value)
        instance.save()

        replace_book_relations(
            instance,
            contributors=contributors,
            series_names=series,
            category_names=categories,
        )

        MetadataVersion.objects.create(
            book=instance,
            snapshot=self.snapshot(instance),
            source="manual_edit_after",
            notes=notes,
            created_by=actor,
        )
        return instance


class MetadataReviewSerializer(serializers.ModelSerializer):
    requested_by_email = serializers.EmailField(source="requested_by.email", read_only=True)
    reviewer_email = serializers.EmailField(source="reviewer.email", read_only=True)

    class Meta:
        model = MetadataReview
        fields = [
            "id",
            "state",
            "notes",
            "requested_by",
            "requested_by_email",
            "reviewer",
            "reviewer_email",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["requested_by", "reviewer", "created_at", "updated_at"]


class MetadataReviewDecisionSerializer(serializers.ModelSerializer):
    class Meta:
        model = MetadataReview
        fields = ["state", "notes"]
