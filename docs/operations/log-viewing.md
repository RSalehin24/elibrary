# Log Viewing

Use [logs/show-logs.sh](../../logs/show-logs.sh) for both local and deployed environments.

Captured log files are written to:

- `logs/local/*.log`
- `logs/remote/*.log`

Those generated log files are gitignored, while `logs/local/.gitkeep` and `logs/remote/.gitkeep` keep the folders in the repository.

## Local Logs

Frontend dev server logs:

```bash
logs/show-logs.sh frontend
```

Backend service logs:

```bash
logs/show-logs.sh backend
```

For the backend group, the script tails:

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

- `backend remote` tails Docker Compose logs for `backend`, `worker`, and `beat`
- `frontend remote` tails host Nginx access and error logs

## Deploy Settings Used For Remote Logs

Remote log streaming uses `deploy/env/.host.env`, especially:

- `DEPLOY_USER_NAME`
- `DEPLOY_IP`
- `DEPLOY_REMOTE_APP_DIR` if you override the default remote path
