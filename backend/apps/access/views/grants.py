from rest_framework import generics
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.models import (
    ACCOUNT_MANAGEABLE_PERMISSION_SCOPES,
    SCOPED_PERMISSION_SCOPES,
    PermissionGrant,
)
from apps.access.serializers import PermissionGrantSerializer
from apps.catalog.models import Book, Category, Contributor, ContributorRole
from apps.common.permissions import IsSuperAdmin


class PermissionGrantListCreateView(generics.ListCreateAPIView):
    permission_classes = [IsSuperAdmin]
    serializer_class = PermissionGrantSerializer
    queryset = PermissionGrant.objects.select_related("user", "book", "category", "contributor").all()

    def perform_create(self, serializer):
        if serializer.validated_data.get("user") == self.request.user:
            raise PermissionDenied("You cannot change your own scoped access rules.")
        serializer.save(granted_by=self.request.user)


class PermissionGrantDetailView(generics.DestroyAPIView):
    permission_classes = [IsSuperAdmin]
    serializer_class = PermissionGrantSerializer
    queryset = PermissionGrant.objects.select_related("user", "book", "category", "contributor").all()

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.user_id == request.user.id:
            raise PermissionDenied("You cannot change your own scoped access rules.")
        return super().destroy(request, *args, **kwargs)


class AccessReferenceDataView(APIView):
    permission_classes = [IsSuperAdmin]

    def get(self, request):
        users = [
            {
                "id": user.id,
                "email": user.email,
                "name": user.display_name,
                "is_staff": user.is_staff,
                "is_superuser": user.is_superuser,
                "capabilities": user.capability_scopes,
                "grant_count": user.permission_grants.count(),
            }
            for user in request.user.__class__.objects.order_by("email")
        ]
        books = [{"id": book.id, "title": book.title, "slug": book.slug} for book in Book.objects.order_by("title")]
        categories = [{"id": category.id, "name": category.name, "slug": category.slug} for category in Category.objects.order_by("name")]
        writers = [
            {"id": contributor.id, "name": contributor.name, "slug": contributor.slug}
            for contributor in Contributor.objects.filter(book_contributions__role=ContributorRole.AUTHOR).distinct().order_by("name")
        ]
        account_scopes = [{"value": scope.value, "label": scope.label} for scope in ACCOUNT_MANAGEABLE_PERMISSION_SCOPES]
        scoped_scopes = [{"value": scope.value, "label": scope.label} for scope in SCOPED_PERMISSION_SCOPES]
        return Response(
            {
                "users": users,
                "books": books,
                "categories": categories,
                "writers": writers,
                "account_scopes": account_scopes,
                "scoped_scopes": scoped_scopes,
            }
        )


__all__ = [
    "AccessReferenceDataView",
    "PermissionGrantDetailView",
    "PermissionGrantListCreateView",
]
