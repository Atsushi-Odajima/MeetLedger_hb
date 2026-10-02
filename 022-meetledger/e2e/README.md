# MeetLedger E2E tests (Playwright)

The 9 required end-to-end scenarios (spec §39) plus a web smoke test. Every spec file starts **its own MeetLedger
server** (API + built PWA) on a free port with a **fresh PostgreSQL database**, so files run in parallel and never
share state.

| File | Scenario |
| --- | --- |
| `e2e-01-calendar-to-followup.spec.ts` | E2E-1 ICS import (Settings > コネクタ) → Pre-brief → Capture (consent → upload) → Transcript → Summary → Review Inbox → confirm Decision/Action/Commitment → Follow-up draft (confirmed items only) → next meeting's Brief |
| `e2e-02-decision-change.spec.ts` | E2E-2 「公開日は10月にします」 → 「公開日は11月に変更します」 → 「変更ですか？」 → human confirms → old decision Superseded in the history |
| `e2e-03-unassigned-action.spec.ts` | E2E-3 owner-less Action stays an unassigned candidate → human assigns + due → due reminder (`followup.tick`) → Done |
| `e2e-04-my-commitment.spec.ts` | E2E-4 「資料をお送りします」 (speaker mapped to me) → overdue → next meeting Brief「自分の未完了の約束」→ reschedule |
| `e2e-05-person-memory.spec.ts` | E2E-5 People → person timeline + Search with source citations (title / date / timestamp link) |
| `e2e-06-confidential-no-external.spec.ts` | E2E-6 Confidential (AI OFF) → fake external AI/transcription server receives 0 requests; cloud meeting = positive control |
| `e2e-07-local-asr.spec.ts` | E2E-7 Local mode with the **real** sherpa-onnx SenseVoice model on `ja.wav` → transcript, 0 external requests, local-rules summary |
| `e2e-08-mobile-pwa.spec.ts` | E2E-8 iPhone 15 / Pixel 8 viewports: manifest + service worker, Upcoming / Brief / My Actions, offline cached views, 「未同期」 action change, sync when back online, desktop review |
| `e2e-09-export-import.spec.ts` | E2E-9 full export (Settings > データ) → self sign-up of a NEW tenant → restore into its empty workspace → meetings / decisions (incl. supersede link) / actions / commitments match |
| `web-smoke.spec.ts` | First-run setup in the UI, notes autosave, offline notes conflict handling, license screen, write connectors |

## Run

```bash
# once: dependencies (repo root) and, for E2E-7, the local ASR models
npm ci
bash scripts/download-models.sh            # → models/ (E2E-7 is skipped when the model is missing)

npm run e2e                                # = playwright test -c e2e/playwright.config.ts
npx playwright test -c e2e/playwright.config.ts e2e-06   # a single scenario
E2E_WORKERS=1 npm run e2e                  # serial (default: 3 files in parallel)
```

`e2e/global-setup.ts` runs before the suite and

1. starts the local PostgreSQL 16 test cluster (`bash scripts/pg-test.sh start`, idempotent; port 55432, role `meetledger`),
2. builds `apps/web` when `apps/web/dist` is missing or older than the sources,
3. checks that `ffmpeg` is on `PATH` (the fixture WAV files are generated with it).

A full run takes about one minute on 4 CPU cores.

## How the isolation works (`e2e/support/`)

- **`server.ts`** – per spec file: `createdb` (`ml_e2e_<name>_<random>`), free port, temp dir with `storage/`, `tmp/`,
  a `models` **symlink** to the repo's `models/`, and `fixtures/transcripts/`. Starts
  `node_modules/.bin/tsx apps/server/src/index.ts` with `WEB_DIST_DIR=apps/web/dist`, `NODE_ENV=test`,
  `APP_ORIGIN=http://127.0.0.1:<port>` (the server migrates on start). After the file: process group killed, DB
  dropped (`dropdb --force`), temp dir removed. `kill()` / `restart()` keep DB + port (used for the offline test).
  `sql()` runs harness queries as the cluster admin (row level security hides tenant rows from a plain session).
- **`audio.ts`** – deterministic Japanese meetings: a sine-tone WAV per meeting (distinct frequency), normalized with
  **exactly the server's ffmpeg arguments**, SHA-256 of the PCM `data` chunk → `<tmp>/fixtures/transcripts/<sha>.json`.
  The server runs with `LOCAL_TRANSCRIPTION_PROVIDER=fixture`, so a "local" transcription returns that transcript.
  Nothing is written into the repository.
- **`fakeExternal.ts`** – a tiny OpenAI-compatible HTTP server that records every request. E2E-6/7 point
  `OPENAI_BASE_URL` at it with `CLOUD_TRANSCRIPTION_PROVIDER=openai`, `AI_PROVIDER=openai`, `OPENAI_API_KEY=sk-fake…`
  and the workspace opts in to cloud transcription / AI / embeddings — so any leak would be counted.
- **`api.ts` / `flows.ts`** – JSON client (session cookie + `x-csrf-token` + `Origin`) for test setup and assertions;
  user-facing steps are performed in the UI.
- `followup.tick` (notifications) is triggered by inserting a system job row (`INSERT INTO jobs … 'followup.tick'`)
  and waiting until the worker marks it `succeeded`; quiet hours are switched off for the test user.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_WORKERS` | `3` | Parallel spec files |
| `PW_CHROMIUM_PATH` | `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (if present) | Chromium binary when Playwright's own revision is not installed |
| `E2E_PG_HOST` / `E2E_PG_PORT` / `E2E_PG_USER` / `E2E_PG_PASSWORD` | `127.0.0.1` / `55432` / `meetledger` / `meetledger` | Test cluster |
| `E2E_PG_ADMIN_USER` | `postgres` | Role for harness SQL (trust auth in the test cluster) |
| `E2E_SKIP_PG=1` | – | Do not run `scripts/pg-test.sh start` |
| `E2E_SKIP_BUILD=1` | – | Never rebuild `apps/web` |
| `E2E_MODELS_DIR` | `<repo>/models` | Local ASR models (E2E-7) |
| `E2E_SERVER_LOG_LEVEL` | `info` | Server log level (log is attached to failed tests as `server.log`) |
| `E2E_KEEP_TMP=1` | – | Keep the per-file temp dirs (server log, storage) for debugging |

## Limitations

- **Chromium only.** WebKit/Firefox are not installed in the build environment; E2E-8 emulates iPhone 15 / Pixel 8
  (viewport, user agent, touch, `isMobile`) in Chromium. Real Safari behaviour (e.g. iOS "Add to Home Screen", WebKit
  service-worker quirks) is not covered.
- Offline is simulated by stopping the test server **and** `context.setOffline(true)` (Chromium does not apply
  `setOffline` to service-worker fetches).
- Browser microphone capture is not exercised (no real audio device); uploads cover the processing path.
- Google / Microsoft OAuth, Slack / HubSpot / Gmail delivery are not called (no external network); the connector
  forms are covered without sending.
