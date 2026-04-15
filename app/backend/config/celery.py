import os

from celery import Celery
from celery.schedules import crontab

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("bangla_library")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
app.conf.beat_schedule = {
    "run-catalog-automation-scheduler": {
        "task": "apps.ingestion.tasks.run_catalog_automation_schedule_task",
        "schedule": crontab(),
    },
    "recover-stale-processing-jobs": {
        "task": "apps.ingestion.tasks.recover_stale_processing_jobs_task",
        "schedule": crontab(),
    },
}
