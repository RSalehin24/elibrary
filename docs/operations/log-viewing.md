# Log Viewing

Use [logs/show-logs.sh](../../logs/show-logs.sh) for both local and deployed environments.

Captured log files are written to:

- `logs/local/frontend/frontend.log`
- `logs/local/backend/backend.log`
- `logs/local/celery/worker.log`
- `logs/local/celery/beat.log`
- `logs/remote/frontend/frontend.log`
- `logs/remote/backend/backend.log`
- `logs/remote/celery/worker.log`
- `logs/remote/celery/beat.log`

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

Individual Celery logs:

```bash
logs/show-logs.sh worker
logs/show-logs.sh beat
```

For the backend group, the script tails these files inside `logs/local/`:

- `backend`
- `worker`
- `beat`

## Remote Logs

Remote backend logs:

```bash
logs/show-logs.sh backend remote
```

Remote worker logs:

```bash
logs/show-logs.sh worker remote
```

Remote beat logs:

```bash
logs/show-logs.sh beat remote
```

Remote frontend logs:

```bash
logs/show-logs.sh frontend remote
```

Remote log behavior:

- `backend remote` streams the remote `backend`, `worker`, and `beat` Docker Compose logs together and writes them to `logs/remote/backend/backend.log`
- `worker remote` streams only the remote Celery worker logs and writes them to `logs/remote/celery/worker.log`
- `beat remote` streams only the remote Celery beat logs and writes them to `logs/remote/celery/beat.log`
- `frontend remote` streams remote Nginx access/error logs and writes them to `logs/remote/frontend/frontend.log`

Every repo-facing script also supports `-h` or `--help` to print usage without running the underlying action.

## Deploy Settings Used For Remote Logs

Remote log streaming uses `deploy/env/.host.env`, especially:

- `DEPLOY_USER_NAME`
- `DEPLOY_IP`
- `DEPLOY_REMOTE_APP_DIR` if you override the default remote path
