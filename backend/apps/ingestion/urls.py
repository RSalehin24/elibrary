from django.urls import path

from apps.ingestion.views import (
    DuplicateReviewListView,
    DuplicateReviewResolveView,
    ProcessingJobListView,
    SourceCatalogRefreshView,
    SubmissionConfirmCandidateView,
    SubmissionDetailView,
    SubmissionListCreateView,
    SubmissionRetryView,
)


urlpatterns = [
    path("submissions/", SubmissionListCreateView.as_view(), name="ingestion-submission-list"),
    path("submissions/<uuid:pk>/", SubmissionDetailView.as_view(), name="ingestion-submission-detail"),
    path(
        "submissions/<uuid:pk>/confirm-candidate/",
        SubmissionConfirmCandidateView.as_view(),
        name="ingestion-submission-confirm-candidate",
    ),
    path("submissions/<uuid:pk>/retry/", SubmissionRetryView.as_view(), name="ingestion-submission-retry"),
    path("jobs/", ProcessingJobListView.as_view(), name="ingestion-job-list"),
    path("catalog/refresh/", SourceCatalogRefreshView.as_view(), name="ingestion-source-catalog-refresh"),
    path("duplicate-reviews/", DuplicateReviewListView.as_view(), name="ingestion-duplicate-review-list"),
    path(
        "duplicate-reviews/<uuid:pk>/resolve/",
        DuplicateReviewResolveView.as_view(),
        name="ingestion-duplicate-review-resolve",
    ),
]
