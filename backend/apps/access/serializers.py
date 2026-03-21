from rest_framework import serializers

from apps.access.models import Bookmark, PermissionGrant, ReadingSession


class PermissionGrantSerializer(serializers.ModelSerializer):
    user_email = serializers.EmailField(source="user.email", read_only=True)
    book_slug = serializers.CharField(source="book.slug", read_only=True)
    book_title = serializers.CharField(source="book.title", read_only=True)
    granted_by_email = serializers.EmailField(source="granted_by.email", read_only=True)

    class Meta:
        model = PermissionGrant
        fields = [
            "id",
            "user",
            "book",
            "scope",
            "is_active",
            "expires_at",
            "notes",
            "user_email",
            "book_slug",
            "book_title",
            "granted_by_email",
        ]


class ReadingSessionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReadingSession
        fields = ["id", "book", "last_location", "progress_percent", "last_opened_at"]
        read_only_fields = ["book", "last_opened_at"]


class BookmarkSerializer(serializers.ModelSerializer):
    class Meta:
        model = Bookmark
        fields = ["id", "book", "location", "label", "note", "created_at"]
        read_only_fields = ["book", "created_at"]
