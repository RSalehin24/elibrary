from django.urls import path

from apps.ingestion.views import (
    CatalogAutomationSettingsView,
    CatalogCurationRunListCreateView,
    CatalogCurationRunStopView,
    DuplicateReviewListView,
    DuplicateReviewResolveView,
    ProcessingJobListView,
    ProcessingJobRecoverView,
    ProcessingJobResumeView,
    ProcessingJobStopView,
    SourceCatalogEntryListView,
    SourceCatalogRefreshView,
    SubmissionActionLinksView,
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
    path(
        "submissions/<uuid:pk>/action-links/",
        SubmissionActionLinksView.as_view(),
        name="ingestion-submission-action-links",
    ),
    path("submissions/<uuid:pk>/retry/", SubmissionRetryView.as_view(), name="ingestion-submission-retry"),
    path("jobs/", ProcessingJobListView.as_view(), name="ingestion-job-list"),
    path("jobs/recover/", ProcessingJobRecoverView.as_view(), name="ingestion-job-recover"),
    path("jobs/<uuid:pk>/resume/", ProcessingJobResumeView.as_view(), name="ingestion-job-resume"),
    path("jobs/<uuid:pk>/stop/", ProcessingJobStopView.as_view(), name="ingestion-job-stop"),
    path("catalog/entries/", SourceCatalogEntryListView.as_view(), name="ingestion-source-catalog-entry-list"),
    path("catalog/refresh/", SourceCatalogRefreshView.as_view(), name="ingestion-source-catalog-refresh"),
    path("catalog/curation-runs/", CatalogCurationRunListCreateView.as_view(), name="ingestion-catalog-curation-run-list"),
    path(
        "catalog/curation-runs/<uuid:pk>/stop/",
        CatalogCurationRunStopView.as_view(),
        name="ingestion-catalog-curation-run-stop",
    ),
    path("catalog/automation/", CatalogAutomationSettingsView.as_view(), name="ingestion-catalog-automation-settings"),
    path("duplicate-reviews/", DuplicateReviewListView.as_view(), name="ingestion-duplicate-review-list"),
    path(
        "duplicate-reviews/<uuid:pk>/resolve/",
        DuplicateReviewResolveView.as_view(),
        name="ingestion-duplicate-review-resolve",
    ),
]
