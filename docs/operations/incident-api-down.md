# Runbook: the API is down

Covers the failure mode seen on 2026-10-06: the app stops serving while
`docker ps` still reports the container as running. There is **no automation
here on purpose** — the host health and sqlite-backup cron jobs were retired on
2026-10-06 because they caused disk problems on the operator's machine, and
the backup script was deleted with them. Detection is the manual daily check.

## 1. Confirm the symptom

```bash
curl -s -o /dev/null -w '%{http_code}\n' -m 10 http://127.0.0.1:8080/v1/health
docker ps --format '{{.Names}}\t{{.Status}}' | grep webcap
```

A healthy deployment answers `200`, and the container reads
`Up ... (healthy)`. `(unhealthy)` with a hanging `curl` is the failure.

## 2. Normal case — container unhealthy, daemon still answers

```bash
cd /home/shoutsid/code/webcap
docker compose up -d
```

`docker inspect`, `docker logs` and `docker exec` all return promptly here.
`bin/webcap-health.sh` does this same restart (plus a re-check) if you would
rather run one command — it is a **manual** tool, not scheduled.

## 3. Wedged container — the daemon will not answer

Symptoms (all of these, together, are what 2026-10-06 looked like):

- `docker inspect`, `docker logs`, `docker exec`, `docker stop`, `docker kill`
  **hang** on `webcap-webcap-1`
- `docker create` / `docker run` also hang, while `docker ps` and
  `docker exec` into *other* containers still work
- the app never exits, so `restart: unless-stopped` never fires

Per-container recovery is impossible in this state. Bounce Docker Desktop —
it is a systemd **user** service, so no sudo is needed:

```bash
systemctl --user restart docker-desktop
```

All containers restart with it. `webcap` comes back on its own
(`restart: unless-stopped`) with the `/data` volume intact — no data is lost.

## 4. Verify recovery

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep webcap     # Up ... (healthy)
curl -s -o /dev/null -w '%{http_code}\n' -m 10 http://127.0.0.1:8080/v1/health
```

Then re-run the day's numbers:

```bash
docker cp scripts/daily-check.mjs webcap-webcap-1:/app/daily-check.mjs
docker exec -w /app webcap-webcap-1 node daily-check.mjs
```

Its `OVERVIEW` block now prints `newest hit` and raises an ATTENTION flag when
the newest hit is more than 2 hours old, which is how a wedge shows up as a
metric after the fact.

## What to watch for next time

A container that is *running but wedged* is invisible to Docker's restart
policy, so the only reliable signal is the hit gap above. If this recurs, the
cause is most likely the Chromium capture path exhausting processes or
`/dev/shm`; `docker-compose.yml` sets `shm_size`, `init` and `pids_limit` for
exactly that reason.
