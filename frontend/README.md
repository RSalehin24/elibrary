# Frontend

This folder is a standalone React/Vite deployment unit.

## Environment

Start from:

```bash
cp .env.example .env
```

Important variables:

- `VITE_API_BASE_URL`
- `VITE_DEV_PROXY_TARGET`

For separate deployment, point `VITE_API_BASE_URL` at the deployed backend API origin, for example:

```bash
VITE_API_BASE_URL=https://api.example.com/api
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
