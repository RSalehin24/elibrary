from celery import shared_task

from apps.ingestion.services.submissions import process_submission_job


@shared_task(bind=True, autoretry_for=(Exception,), retry_backoff=True, retry_jitter=True, max_retries=3)
def process_submission_task(self, job_id):
    return process_submission_job(job_id, retry_count=self.request.retries, task_id=self.request.id)
