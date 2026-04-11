# Logs And Log Streaming

This folder stores local and remote captured logs plus the helper script used to stream them.

## Folder Layout

- `logs/local/`: captured logs from the local Docker development stack
- `logs/remote/`: captured logs streamed from the deployed environment
- `logs/show-logs.sh`: helper script for tailing local or remote logs

## Available Log Targets

`logs/show-logs.sh` supports:

- `frontend`
- `backend`
- `worker`
- `beat`

Use `local` or `remote` as the optional second argument. The default scope is `local`.

## Common Commands

```bash
logs/show-logs.sh frontend
logs/show-logs.sh backend
logs/show-logs.sh worker remote
logs/show-logs.sh beat remote
```

`logs/show-logs.sh` supports `-h` or `--help` for usage details.

## Related Docs

- Full log guide: [docs/operations/log-viewing.md](../docs/operations/log-viewing.md)
- Deployment guide for remote host env settings: [docs/operations/deployment.md](../docs/operations/deployment.md)
