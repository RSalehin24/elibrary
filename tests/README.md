# Test Suite

The root `tests/` folder keeps all automated coverage organized by execution layer:

- `tests/backend/`: Django, ingestion, access, and catalog tests executed with `pytest`
- `tests/pytest.ini`: shared pytest configuration for backend runs inside and outside Docker
- `tests/frontend/unit/`: frontend unit coverage executed with `node --test`
- `tests/frontend/e2e/`: Playwright browser stories executed against the real Dockerized local application
- `tests/frontend/playwright.config.js`: shared Playwright config and live auth/bootstrap setup
- `tests/TEST_MATRIX.md`: feature coverage map for backend and browser scenarios

For full-stack verification, run:

```bash
local/scripts/verify.sh
```

This flow uses the live local Docker stack, not mocked services or SQLite.

Run the suites separately when you want narrower feedback:

```bash
local/scripts/test-backend.sh
local/scripts/test-frontend-unit.sh
cd app/frontend && npm run build
local/scripts/test-e2e.sh
```

Run the same full verifier through the convenience wrapper:

```bash
local/scripts/test-all.sh
```

For additional confidence on stateful flows, repeat the verifier:

```bash
local/scripts/verify.sh --repeat 3
```
