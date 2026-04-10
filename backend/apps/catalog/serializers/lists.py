from rest_framework import serializers

from apps.catalog.models import Category, Contributor, Series


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


class ContributorListSerializer(serializers.ModelSerializer):
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


class SeriesListSerializer(serializers.ModelSerializer):
    book_count = serializers.IntegerField(read_only=True)
    digital_book_count = serializers.IntegerField(read_only=True)
    manual_book_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Series
        fields = [
            "id",
            "name",
            "slug",
            "book_count",
            "digital_book_count",
            "manual_book_count",
            "created_at",
        ]
