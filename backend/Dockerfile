FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements /app/requirements
RUN pip install --upgrade pip && pip install -r /app/requirements/backend.txt

COPY backend /app/backend
COPY code /app/code

WORKDIR /app/backend

CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
