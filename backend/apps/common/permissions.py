from django.db import models
from rest_framework.permissions import BasePermission

from apps.access.models import PermissionGrant, PermissionScope


def granted_scope_queryset(user, book=None):
    if not getattr(user, "is_authenticated", False):
        return PermissionGrant.objects.none()

    queryset = PermissionGrant.objects.active_for_user(user)
    if book is None:
        return queryset.filter(book__isnull=True)

    return queryset.filter(models.Q(book__isnull=True) | models.Q(book=book))


def user_has_scope(user, scopes, book=None):
    if not getattr(user, "is_authenticated", False):
        return False

    if user.is_superuser or user.is_staff:
        return True

    return granted_scope_queryset(user, book=book).filter(
        models.Q(scope=PermissionScope.ADMIN_FULL_CONTROL) | models.Q(scope__in=scopes)
    ).exists()


class ScopePermission(BasePermission):
    required_scopes = ()
    allow_book_scoped = False

    def has_permission(self, request, view):
        user = request.user
        if not getattr(user, "is_authenticated", False):
            return False

        if user.is_superuser or user.is_staff:
            return True

        if self.allow_book_scoped:
            return True

        return user_has_scope(user, self.required_scopes)

    def has_object_permission(self, request, view, obj):
        user = request.user
        if not getattr(user, "is_authenticated", False):
            return False

        if user.is_superuser or user.is_staff:
            return True

        book = getattr(obj, "book", obj) if self.allow_book_scoped else None
        return user_has_scope(user, self.required_scopes, book=book)


class CanManageAccess(ScopePermission):
    required_scopes = (PermissionScope.ACCESS_MANAGE,)


class CanManageProcessing(ScopePermission):
    required_scopes = (PermissionScope.PROCESSING_MANAGE,)


class CanEditMetadata(ScopePermission):
    required_scopes = (PermissionScope.METADATA_EDIT,)
    allow_book_scoped = True
