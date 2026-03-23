# Frontend

This folder is a standalone React/Vite deployment unit.

## Environment

Start from:

```bash
cp .env.example .env
```

Important variables:

- `VITE_API_BASE_URL`

For the unified Docker stack in this repo, keep:

```bash
VITE_API_BASE_URL=/api
```

## Local Run

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
```

## Docker Build / Deploy

This folder can now be deployed directly as its own build context:

```bash
docker build -t bangla-library-frontend .
```

The Dockerfile assumes this folder is the build root.

For the full stack used both locally and on the server, use the root-level Docker Compose setup instead:

```bash
docker-compose up -d --build
```

That build copies the frontend production bundle into Nginx so the browser stays on one origin and only Nginx is public.
