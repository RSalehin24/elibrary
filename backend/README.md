# Backend

This folder is a standalone Django deployment unit.

It includes:

- Django API and admin/auth flows
- catalog, access, and ingestion apps
- Celery worker support
- legacy scraper/export pipeline in `apps/ingestion/legacy/`
- backend-owned local media under `storage/`
- backend-owned generated export output under `outputs/`

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
- `FRONTEND_BASE_URL`
- `DJANGO_ALLOWED_HOSTS`
- `DJANGO_CORS_ALLOWED_ORIGINS`
- `DJANGO_CSRF_TRUSTED_ORIGINS`
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

## Tests

```bash
python -m pytest
```

Or with the local virtualenv:

```bash
../ebook-scrapper/bin/python -m pytest
```

## Docker Build / Deploy

This folder can now be deployed directly as its own build context:

```bash
docker build -t bangla-library-backend .
```

The Dockerfile assumes this folder is the build root.

## Legacy Scraper

The old scraper/export code is now integrated into:

```bash
backend/apps/ingestion/legacy/
```

Run batch ingestion through Django instead of a separate standalone script:

```bash
python manage.py process_legacy_batch --url https://www.ebanglalibrary.com/books/sample/ --sync
```
