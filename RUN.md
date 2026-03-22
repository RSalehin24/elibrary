# Docker Postgres + Local App

Start Docker services:

```bash
docker-compose up -d postgres redis worker
```

Backend:

```bash
set -a
source .env
export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/bangla_library
export CELERY_BROKER_URL=redis://localhost:6379/0
export CELERY_RESULT_BACKEND=redis://localhost:6379/0
set +a
./ebook-scrapper/bin/python backend/manage.py migrate
./ebook-scrapper/bin/python backend/manage.py seed_superadmin
./ebook-scrapper/bin/python backend/manage.py runserver
```

Frontend:

```bash
cd frontend
set -a
source ../.env
export VITE_DEV_PROXY_TARGET=http://localhost:8000
set +a
npm install
npm run dev
```

Backend: `http://localhost:8000`

Frontend: `http://localhost:5173`

If submissions show Redis connection errors, confirm `redis` and `worker` are both running. The backend can now fall back to inline processing, but the normal queue path still expects Docker Redis plus the Celery worker.

# Re-seed Super Admin

```bash
set -a
source .env
export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/bangla_library
export CELERY_BROKER_URL=redis://localhost:6379/0
export CELERY_RESULT_BACKEND=redis://localhost:6379/0
set +a
./ebook-scrapper/bin/python backend/manage.py seed_superadmin
```
