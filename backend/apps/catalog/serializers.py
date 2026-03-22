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
    series = serializers.SerializerMethodField()
    categories = serializers.SerializerMethodField()
    cover_download_url = serializers.SerializerMethodField()
    latest_submission_at = serializers.SerializerMethodField()

    class Meta:
        model = Book
        fields = [
            "id",
            "title",
            "slug",
            "state",
            "review_state",
            "authors",
            "series",
            "categories",
            "cover_download_url",
            "latest_submission_at",
            "created_at",
        ]

    def get_authors(self, obj):
        return [
            rel.contributor.name
            for rel in obj.book_contributors.all()
            if rel.role == "author"
        ]

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


class BookDetailSerializer(BookListSerializer):
    contributors = serializers.SerializerMethodField()
    assets = GeneratedAssetSerializer(source="generated_assets", many=True, read_only=True)
    source_urls = serializers.SerializerMethodField()
    book_info_html = serializers.CharField()
    dedication_html = serializers.CharField()
    main_content_html = serializers.CharField()
    toc = serializers.JSONField()
    raw_provenance = serializers.SerializerMethodField()

    class Meta(BookListSerializer.Meta):
        fields = BookListSerializer.Meta.fields + [
            "contributors",
            "assets",
            "source_urls",
            "book_info_html",
            "dedication_html",
            "main_content_html",
            "toc",
            "metadata_last_reviewed_at",
            "raw_provenance",
        ]

    def get_contributors(self, obj):
        payload = []
        for relation in obj.book_contributors.all():
            payload.append(
                {
                    "name": relation.contributor.name,
                    "role": relation.role,
                }
            )
        return payload

    def get_source_urls(self, obj):
        return [source.normalized_source_url for source in obj.source_urls.all()]

    def get_raw_provenance(self, obj):
        request = self.context.get("request")
        if request and request.user.is_authenticated and request.user.is_staff:
            return {
                "raw_scraped_metadata": obj.raw_scraped_metadata,
                "raw_scrape_payload": obj.raw_scrape_payload,
            }
        return {}


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
