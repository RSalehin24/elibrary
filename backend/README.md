# Backend

This folder is a standalone Django deployment unit.

It includes:

- Django API and admin/auth flows
- catalog, access, and ingestion apps
- Celery worker and beat scheduler support
- legacy scraper/export pipeline in `apps/ingestion/legacy/`
- backend-owned local media under `storage/`
- temporary ingestion staging under `outputs/`

## Environment

Start from:

```bash
cp .env.example .env
```

Important variables:

- `DJANGO_SECRET_KEY`
- `DATABASE_URL`
- `CELERY_BROKER_URL`
- `CELERY_RESULT_BACKEND`
- `PUBLIC_BASE_URL`
- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD`

## Local Run

```bash
set -a
source .env
set +a
python manage.py migrate
python manage.py seed_superadmin
python manage.py runserver
```

If you use the checked-in local virtualenv instead:

```bash
set -a
source .env
set +a
../ebook-scrapper/bin/python manage.py migrate
../ebook-scrapper/bin/python manage.py seed_superadmin
../ebook-scrapper/bin/python manage.py runserver
```

## Worker

```bash
set -a
source .env
set +a
celery -A config worker --loglevel=info
```

## Beat Scheduler

```bash
set -a
source .env
set +a
celery -A config beat --loglevel=info
```

## Tests

```bash
python -m pytest
```

Or with the local virtualenv:

```bash
../ebook-scrapper/bin/python -m pytest
```

## Docker Build / Deploy

For the unified stack used both locally and on the server, run Docker from the repo root with [`docker-compose.yml`](../docker-compose.yml).

## Legacy Scraper

The old scraper/export code is now integrated into:

```bash
backend/apps/ingestion/legacy/
```

Run batch ingestion through Django instead of a separate standalone script:

```bash
python manage.py process_legacy_batch --url https://www.ebanglalibrary.com/books/sample/ --sync
```
