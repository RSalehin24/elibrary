from django.urls import path

from apps.catalog.views import (
    BookDetailView,
    BookEpubReplaceView,
    BookListView,
    BookMetadataUpdateView,
    BookRegenerateView,
    MetadataReviewListCreateView,
    MetadataReviewUpdateView,
    MetadataVersionListView,
)


urlpatterns = [
    path("books/", BookListView.as_view(), name="catalog-book-list"),
    path(
        "books/<path:slug>/metadata/",
        BookMetadataUpdateView.as_view(),
        name="catalog-book-metadata-update",
    ),
    path(
        "books/<path:slug>/assets/epub/",
        BookEpubReplaceView.as_view(),
        name="catalog-book-epub-replace",
    ),
    path(
        "books/<path:slug>/regenerate/",
        BookRegenerateView.as_view(),
        name="catalog-book-regenerate",
    ),
    path(
        "books/<path:slug>/metadata-versions/",
        MetadataVersionListView.as_view(),
        name="catalog-book-metadata-versions",
    ),
    path(
        "books/<path:slug>/metadata-reviews/",
        MetadataReviewListCreateView.as_view(),
        name="catalog-book-metadata-review-list",
    ),
    path(
        "metadata-reviews/<uuid:pk>/",
        MetadataReviewUpdateView.as_view(),
        name="catalog-metadata-review-update",
    ),
    path("books/<path:slug>/", BookDetailView.as_view(), name="catalog-book-detail"),
]
