from pathlib import Path
from urllib.parse import unquote, urlparse

from rest_framework import serializers
from rest_framework.reverse import reverse

from apps.catalog.models import (
    Book,
    ContributorRole,
    GeneratedAsset,
    MetadataReview,
    MetadataVersion,
)
from apps.catalog.services import replace_book_relations
from apps.catalog.services import normalize_book_contributors
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
        return reverse(
            "access-book-asset-download",
            kwargs={"slug": obj.book.slug, "asset_type": obj.asset_type},
            request=request,
        )


class BookListSerializer(serializers.ModelSerializer):
    authors = serializers.SerializerMethodField()
    contributors = serializers.SerializerMethodField()
    series = serializers.SerializerMethodField()
    categories = serializers.SerializerMethodField()
    cover_download_url = serializers.SerializerMethodField()
    latest_submission_at = serializers.SerializerMethodField()
    primary_source = serializers.SerializerMethodField()

    class Meta:
        model = Book
        fields = [
            "id",
            "title",
            "slug",
            "state",
            "review_state",
            "authors",
            "contributors",
            "series",
            "categories",
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

    def get_series(self, obj):
        return [rel.series.name for rel in obj.book_series.all()]

    def get_categories(self, obj):
        return [rel.category.name for rel in obj.book_categories.all()]

    def get_cover_download_url(self, obj):
        request = self.context.get("request")
        cover = next((asset for asset in obj.generated_assets.all() if asset.asset_type == "cover"), None)
        if not cover:
            return ""
        return reverse(
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
