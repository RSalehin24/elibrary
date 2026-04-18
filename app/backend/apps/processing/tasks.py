from celery import shared_task

from .services import kickoff_request_processing, run_processing_sync


@shared_task(bind=True)
def run_processing_sync_task(self, singleton_key="default"):
    return run_processing_sync(singleton_key=singleton_key, task_id=self.request.id)


@shared_task(bind=True)
def kickoff_book_creation_request_task(self, request_id):
    request = kickoff_request_processing(request_id)
    return {
        "request_id": str(request.id),
        "state": request.state,
        "submission_id": str(request.submission_id or ""),
    }
