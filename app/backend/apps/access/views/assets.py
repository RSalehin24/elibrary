from django.http import FileResponse
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from apps.catalog.models import Book, GeneratedAssetType
from apps.common.permissions import user_can_download_book_assets, user_can_view_book_cover

from .preview_html import html_asset_response
from .shared import (
    asset_download_filename,
    asset_is_available,
    missing_asset_response,
    open_asset_stream,
    resolve_asset,
)


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


__all__ = ["BookAssetDownloadView"]
