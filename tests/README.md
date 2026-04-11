# Test Suite

The root `tests/` folder keeps all automated coverage organized by execution layer:

- `tests/backend/`: Django, ingestion, access, and catalog tests executed with `pytest`
- `tests/frontend/e2e/`: Playwright browser stories executed against the real Dockerized local application
- `tests/frontend/playwright.config.js`: shared Playwright config and live auth/bootstrap setup
- `tests/TEST_MATRIX.md`: feature coverage map for backend and browser scenarios

For full-stack verification, run:

```bash
local/scripts/verify.sh
```

This flow uses the live local Docker stack, not mocked services or SQLite.

For additional confidence on stateful flows, repeat the verifier:

```bash
local/scripts/verify.sh --repeat 3
```
