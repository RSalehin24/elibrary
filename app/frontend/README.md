# Frontend

This folder contains the React and Vite application code.

## Local Development

Use the repo-level guide in [docs/operations/local-development.md](../../docs/operations/local-development.md). The preferred workflow runs the frontend through the Docker development overlay with Vite hot reload.

## Runtime Notes

- App code: `app/frontend/src/`
- Browser tests: `tests/frontend/e2e/`
- Browser config: `tests/frontend/playwright.config.js`
- Vite config: `app/frontend/vite.config.js`

## Routes

| Route               | Page               | Notes                                                           |
| ------------------- | ------------------ | --------------------------------------------------------------- |
| `/home`             | Home               | Landing dashboard                                               |
| `/library`          | Library            | Searchable book catalog                                         |
| `/categories`       | Categories         | Browse by category                                              |
| `/series`           | Series             | Browse by series                                                |
| `/writers`          | Writers            | Browse by writer/translator/editor                              |
| `/books/:slug`      | Book Detail        | Metadata, EPUB/HTML actions, Kindle delivery                    |
| `/reader`           | Reader             | In-browser HTML reader                                          |
| `/catalog`          | Catalog Processing | Source catalog sync, automation, catalog records                |
| `/create`           | Create Processing  | Book creation pipeline: requests → queue → processing → created |
| `/on-hold`          | On Hold            | Paused, failed, duplicate, and deleted requests                 |
| `/incomplete`       | Incomplete         | Incomplete book automation and resolved records                 |
| `/manual-books`     | Manual Books       | Operator-created books without a source URL                     |
| `/my-books`         | My Books           | Books owned or created by the current user                      |
| `/access`           | Users & Access     | User management and per-book permission grants                  |
| `/profile`          | Profile            | User profile and settings                                       |
| `/notes`            | Notes              | Saved reading notes                                             |
| `/login`            | Login              | Email/password sign-in                                          |
| `/reset-password`   | Password Reset     | Self-service password reset request                             |
| `/create-password`  | Password Creation  | Invite-link password setup                                      |
| `/two-factor-setup` | TOTP Setup         | Forced two-factor authentication setup gate                     |

Old `/processing-*` routes redirect automatically to their current equivalents.

## Container Targets

- [local/docker/frontend.Dockerfile](../../local/docker/frontend.Dockerfile): local Vite development image
- [deploy/docker/frontend.Dockerfile](../../deploy/docker/frontend.Dockerfile): production build and Nginx runtime image
