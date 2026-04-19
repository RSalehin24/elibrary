import logging

from django.conf import settings
from django.core.mail import EmailMessage, get_connection
from django.http import FileResponse
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.catalog.models import Book, GeneratedAssetType
from apps.common.permissions import user_can_download_book_assets, user_can_view_book_cover

from .preview_html import html_asset_response
from .shared import (
    asset_download_filename,
    asset_is_available,
    read_asset_bytes,
    missing_asset_response,
    open_asset_stream,
    resolve_asset,
)

logger = logging.getLogger(__name__)


class BookAssetDownloadView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, slug, asset_type):
        book = Book.objects.get(slug=slug)
        can_access = (
            user_can_view_book_cover(request.user, book)
            if asset_type == GeneratedAssetType.COVER
            else user_can_download_book_assets(request.user, book)
        )
        if not can_access:
            raise PermissionDenied("You do not have download access for this book.")

        asset = resolve_asset(book, asset_type)
        if not asset_is_available(asset):
            return missing_asset_response(book, asset, actor=request.user)
        if asset.asset_type == GeneratedAssetType.HTML:
            return html_asset_response(book, asset)
        return FileResponse(
            open_asset_stream(asset),
            as_attachment=asset.asset_type != GeneratedAssetType.HTML,
            filename=asset_download_filename(book, asset),
        )


class BookSendToKindleView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, slug):
        book = get_object_or_404(Book, slug=slug)
        if not user_can_download_book_assets(request.user, book):
            raise PermissionDenied("You do not have download access for this book.")

        kindle_emails = [
            str(email or "").strip().lower()
            for email in (request.user.kindle_emails or [])
            if str(email or "").strip()
        ]
        if not kindle_emails:
            return Response(
                {
                    "detail": "Add at least one Kindle email in your profile before sending.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        asset = resolve_asset(book, GeneratedAssetType.EPUB)
        if not asset_is_available(asset):
            return missing_asset_response(book, asset, actor=request.user)

        attachment_bytes, _source_name, _path = read_asset_bytes(asset)
        filename = asset_download_filename(book, asset)
        sender = getattr(settings, "KINDLE_DELIVERY_FROM_EMAIL", "") or getattr(
            settings,
            "DEFAULT_FROM_EMAIL",
            "",
        )
        delivered = []
        failed = []

        with get_connection() as connection:
            for kindle_email in kindle_emails:
                message = EmailMessage(
                    subject=book.title,
                    body=(
                        "Bangla Library attached this EPUB for Kindle delivery.\n\n"
                        "If Amazon rejects the file, add the sender email to your "
                        "Approved Personal Document E-mail List."
                    ),
                    from_email=sender,
                    to=[kindle_email],
                    connection=connection,
                )
                message.attach(filename, attachment_bytes, "application/epub+zip")
                try:
                    message.send(fail_silently=False)
                except Exception:
                    logger.exception(
                        "Kindle delivery failed for %s to %s.",
                        book.slug,
                        kindle_email,
                    )
                    failed.append(kindle_email)
                else:
                    delivered.append(kindle_email)

        if not delivered:
            return Response(
                {
                    "detail": (
                        "Kindle delivery failed for every configured address. "
                        "Check the outgoing mail settings and Amazon approved sender list."
                    ),
                    "failedEmails": failed,
                    "senderEmail": sender,
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        detail = (
            f"Sent to {len(delivered)} Kindle email(s)."
            if not failed
            else (
                f"Sent to {len(delivered)} Kindle email(s). "
                f"{len(failed)} delivery attempt(s) failed."
            )
        )
        return Response(
            {
                "detail": detail,
                "deliveredEmails": delivered,
                "failedEmails": failed,
                "senderEmail": sender,
            }
        )


__all__ = ["BookAssetDownloadView", "BookSendToKindleView"]
