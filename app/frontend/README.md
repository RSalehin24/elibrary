# Frontend

This folder contains the React and Vite application code.

## Local Development

Use the repo-level guide in [docs/operations/local-development.md](../../docs/operations/local-development.md). The preferred workflow runs the frontend through the Docker development overlay with Vite hot reload.

## Runtime Notes

- App code: `app/frontend/src/`
- Browser tests: `tests/frontend/e2e/`
- Browser config: `tests/frontend/playwright.config.js`
- Vite config: `app/frontend/vite.config.js`

## Container Targets

- [local/docker/frontend.Dockerfile](../../local/docker/frontend.Dockerfile): local Vite development image
- [deploy/docker/frontend.Dockerfile](../../deploy/docker/frontend.Dockerfile): production build and Nginx runtime image
