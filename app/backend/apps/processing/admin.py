from django.contrib import admin

from .models import (
    BookCreationRequest,
    BookRecord,
    ProcessingAutomationSettings,
    ProcessingSyncState,
)


@admin.register(BookRecord)
class BookRecordAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "category",
        "book_creation_state",
        "writer",
        "publisher",
        "updated_at",
    )
    search_fields = (
        "id",
        "name",
        "url",
        "writer",
        "translator",
        "composer",
        "publisher",
    )
    list_filter = (
        "book_creation_state",
        "category",
        "was_incomplete",
        "resolved_from_incomplete",
        "is_duplicate",
    )
    readonly_fields = ("created_at", "updated_at")


@admin.register(BookCreationRequest)
class BookCreationRequestAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "book_record",
        "state",
        "is_resumed",
        "is_confirmed_not_duplicate",
        "updated_at",
    )
    search_fields = ("id", "book_record__id", "book_record__name", "error_message")
    list_filter = (
        "state",
        "is_resumed",
        "is_confirmed_not_duplicate",
        "duplicate_confirmed",
    )
    raw_id_fields = (
        "book_record",
        "duplicate_of_request",
        "duplicate_of_record",
        "linked_book",
    )
    readonly_fields = ("created_at", "updated_at")


@admin.register(ProcessingSyncState)
class ProcessingSyncStateAdmin(admin.ModelAdmin):
    list_display = (
        "singleton_key",
        "status",
        "page_index",
        "fetched_count",
        "updated_count",
        "appended_count",
        "updated_at",
    )
    search_fields = ("singleton_key", "message")
    list_filter = ("status",)
    readonly_fields = ("created_at", "updated_at")


@admin.register(ProcessingAutomationSettings)
class ProcessingAutomationSettingsAdmin(admin.ModelAdmin):
    list_display = (
        "kind",
        "enabled",
        "interval",
        "time",
        "saved",
        "last_run_at",
        "updated_at",
    )
    list_filter = ("kind", "enabled", "saved")
    readonly_fields = ("created_at", "updated_at")
