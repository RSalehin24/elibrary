# Log Viewing

Use [logs/show-logs.sh](../../logs/show-logs.sh) for both local and deployed environments.

Captured log files are written to:

- `logs/local/frontend/frontend.log`
- `logs/local/backend/backend.log`
- `logs/local/celery/worker.log`
- `logs/local/celery/beat.log`
- `logs/remote/frontend/frontend.log`
- `logs/remote/backend/backend.log`

Those generated log files are gitignored, while the `.gitkeep` files inside `logs/local/**` and `logs/remote/**` keep the folder structure in the repository.

## Local Logs

Frontend dev server logs:

```bash
logs/show-logs.sh frontend
```

Backend service logs:

```bash
logs/show-logs.sh backend
```

For the backend group, the script tails the files inside `logs/local/`:

- `backend`
- `worker`
- `beat`

## Remote Logs

Remote backend logs:

```bash
logs/show-logs.sh backend remote
```

Remote frontend logs:

```bash
logs/show-logs.sh frontend remote
```

Remote log behavior:

- `backend remote` streams remote Docker Compose logs and writes them to `logs/remote/backend/backend.log`
- `frontend remote` streams remote Nginx access/error logs and writes them to `logs/remote/frontend/frontend.log`

## Deploy Settings Used For Remote Logs

Remote log streaming uses `deploy/env/.host.env`, especially:

- `DEPLOY_USER_NAME`
- `DEPLOY_IP`
- `DEPLOY_REMOTE_APP_DIR` if you override the default remote path
