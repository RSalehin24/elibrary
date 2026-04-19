from django.urls import path

from .views import (
    ProcessingCatalogAutomationRunView,
    ProcessingCatalogAutomationView,
    ProcessingIncompleteAutomationRunView,
    ProcessingIncompleteAutomationView,
    ProcessingPipelineAdvanceView,
    ProcessingRecordCreateRequestsView,
    ProcessingRequestActionView,
    ProcessingTableView,
    ProcessingSyncAdvanceView,
    ProcessingStateView,
    ProcessingSyncPauseView,
    ProcessingSyncResumeView,
    ProcessingSyncStopView,
    ProcessingSyncStartView,
)


urlpatterns = [
    path("state/", ProcessingStateView.as_view(), name="processing-state"),
    path("table/", ProcessingTableView.as_view(), name="processing-table"),
    path("pipeline/advance/", ProcessingPipelineAdvanceView.as_view(), name="processing-pipeline-advance"),
    path("sync/start/", ProcessingSyncStartView.as_view(), name="processing-sync-start"),
    path("sync/pause/", ProcessingSyncPauseView.as_view(), name="processing-sync-pause"),
    path("sync/advance/", ProcessingSyncAdvanceView.as_view(), name="processing-sync-advance"),
    path("sync/resume/", ProcessingSyncResumeView.as_view(), name="processing-sync-resume"),
    path("sync/stop/", ProcessingSyncStopView.as_view(), name="processing-sync-stop"),
    path("records/create-requests/", ProcessingRecordCreateRequestsView.as_view(), name="processing-record-create-requests"),
    path("requests/action/", ProcessingRequestActionView.as_view(), name="processing-request-action"),
    path("automation/catalog/", ProcessingCatalogAutomationView.as_view(), name="processing-catalog-automation"),
    path("automation/catalog/run/", ProcessingCatalogAutomationRunView.as_view(), name="processing-catalog-automation-run"),
    path("automation/incomplete/", ProcessingIncompleteAutomationView.as_view(), name="processing-incomplete-automation"),
    path("automation/incomplete/run/", ProcessingIncompleteAutomationRunView.as_view(), name="processing-incomplete-automation-run"),
]
