from django.db import models
from rest_framework.permissions import BasePermission

from apps.access.models import PermissionGrant, PermissionScope
from apps.catalog.models import ContributorRole


def granted_scope_queryset(user, book=None):
    if not getattr(user, "is_authenticated", False):
        return PermissionGrant.objects.none()

    queryset = PermissionGrant.objects.active_for_user(user)
    if book is None:
        return queryset.filter(book__isnull=True, category__isnull=True, contributor__isnull=True)

    return queryset.filter(
        models.Q(book__isnull=True, category__isnull=True, contributor__isnull=True)
        | models.Q(book=book)
        | models.Q(category__books=book)
        | models.Q(
            contributor__book_contributions__book=book,
            contributor__book_contributions__role=ContributorRole.AUTHOR,
        )
    ).distinct()


def user_has_scope(user, scopes, book=None):
    if not getattr(user, "is_authenticated", False):
        return False

    if user.is_superuser or user.is_staff:
        return True

    return granted_scope_queryset(user, book=book).filter(
        models.Q(scope=PermissionScope.ADMIN_FULL_CONTROL) | models.Q(scope__in=scopes)
    ).exists()


def user_owns_book(user, book):
    if not getattr(user, "is_authenticated", False) or book is None:
        return False
    owned_flag = getattr(book, "user_owns_book", None)
    if owned_flag is not None:
        return bool(owned_flag)
    return book.linked_submissions.filter(submitter=user).exists()


def user_can_download_book_assets(user, book):
    return user_has_scope(user, [PermissionScope.DOWNLOAD_FILE], book=book) or user_owns_book(user, book)


def user_can_launch_reader(user, book):
    return user_has_scope(
        user,
        [
            PermissionScope.PREVIEW_READ_ONCE,
            PermissionScope.READ_DURABLE,
            PermissionScope.DOWNLOAD_FILE,
        ],
        book=book,
    ) or user_owns_book(user, book)


def user_can_view_book_cover(user, book):
    return user_can_launch_reader(user, book)


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


class IsSuperAdmin(BasePermission):
    def has_permission(self, request, view):
        user = request.user
        return bool(getattr(user, "is_authenticated", False) and user.is_superuser)
