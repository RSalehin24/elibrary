from django.contrib import admin

from apps.access.models import Bookmark, PermissionGrant, PreviewAccessSession, ReadingSession

admin.site.register(PermissionGrant)
admin.site.register(PreviewAccessSession)
admin.site.register(ReadingSession)
admin.site.register(Bookmark)

# Register your models here.
