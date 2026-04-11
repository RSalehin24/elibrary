# Frontend

This folder contains the React/Vite application and the Playwright browser suite.

## Local Development

Use the repo-level guide in [docs/operations/local-development.md](../docs/operations/local-development.md). The preferred workflow runs the frontend through the Docker development overlay with Vite hot reload.

## Runtime Notes

- App code: `frontend/src/`
- Browser tests: `frontend/tests/e2e/`
- Vite config: `frontend/vite.config.js`

## Container Targets

- [local/docker/frontend.Dockerfile](../local/docker/frontend.Dockerfile): local Vite development image
- [deploy/docker/frontend.Dockerfile](../deploy/docker/frontend.Dockerfile): production build and Nginx runtime image
