# Frontend

This folder contains the React/Vite application and the Playwright browser suite.

## Local Development

Use the repo-level guide in [docs/local-development.md](../docs/local-development.md). The preferred workflow now runs the frontend through the Docker development overlay with Vite hot reload.

## Runtime Notes

- App code: `frontend/src/`
- Browser tests: `frontend/tests/e2e/`
- Vite config: `frontend/vite.config.js`

## Container Targets

- `frontend/Dockerfile` `dev` target: Vite dev server
- `frontend/Dockerfile` `build` target: production bundle build
- `frontend/Dockerfile` `runtime` target: standalone static Nginx image
