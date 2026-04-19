from celery import shared_task

from .models import BookCreationRequest, BookCreationRequestState
from .services import (
    kickoff_request_processing,
    run_processing_sync,
    sync_state_task_payload,
)


@shared_task(bind=True)
def run_processing_sync_task(self, singleton_key="default"):
    state = run_processing_sync(singleton_key=singleton_key, task_id=self.request.id)
    return sync_state_task_payload(state)


@shared_task(bind=True, acks_late=True, reject_on_worker_lost=True)
def kickoff_book_creation_request_task(self, request_id):
    try:
        request = kickoff_request_processing(request_id)
    except BookCreationRequest.DoesNotExist:
        return {
            "request_id": str(request_id),
            "state": BookCreationRequestState.DELETED,
            "submission_id": "",
            "missing": True,
        }

    return {
        "request_id": str(request.id),
        "state": request.state,
        "submission_id": str(request.submission_id or ""),
    }
