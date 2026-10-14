# UX round 5 local preview deployment

Final state: deployment complete; app Docker-healthy and connected to Redmine, canWrite=true, formatter common_mark. Existing data volume and write opt-in preserved. All main/CSS/lazy assets return 200; real mutation smoke was not performed. The sections below retain intermediate build and recovery evidence.

## Pre-deploy snapshot

This snapshot records the running preview before the approved rollout. It has since been replaced by the final image as documented below.

The running preview is container `redmine-ui-app-1` (`242c653c0b62`), image `redmine-ui-app`, healthy for 8 days at inspection, bound to `127.0.0.1:3010 -> 3000/tcp`.

The compose service builds from the repository Dockerfile, stores application data in the named volume `workspace-data:/data`, restarts unless stopped, and has a GET health check against `/api/health`. The runtime uses `/data/workspace.sqlite`. `.dockerignore` excludes `.env`, `.env.*`, `data`, SQLite files, and build/test output. The multi-stage Dockerfile builds the app and runs `dist/server/server/index.js` as the unprivileged `node` user.

Safe health metadata from an in-container GET: HTTP 200, `ok=true`, `mode=redmine`, `connected=true`, `readOnly=false`, `canWrite=true`. The host-side Node fetch probe failed with `TypeError`; the equivalent in-container request succeeded. No environment values, tokens, or full health/config responses were read or printed.

Commands run for this snapshot:

```sh
docker ps --format '{{.ID}} {{.Image}} {{.Names}} {{.Status}} {{.Ports}}'
docker exec redmine-ui-app-1 node -e 'fetch("http://127.0.0.1:3000/api/health").then(async r=>{const d=await r.json(); console.log(JSON.stringify({httpStatus:r.status,ok:d.ok,mode:d.mode,connected:d.connected,readOnly:d.readOnly,canWrite:d.canWrite}))}).catch(e=>{console.log(JSON.stringify({error:e.name,cause:e.cause?.code||e.message}));process.exitCode=1})'
```

The compose review confirmed the persistent named volume and loopback-only published port. `docker compose config`, Docker `Config.Env`, and `.env` were not inspected. No Redmine or Trello writes were performed.

## Deployment

The first preparation build was attempted with `docker compose build`; it failed at Dockerfile `RUN npm ci` with npm `EUSAGE`: `package.json` and `package-lock.json` were out of sync because the lock file was missing `@floating-ui/dom@1.8.0`. The lockfile was corrected by the project owner. A second `docker compose build` then succeeded and produced `redmine-ui-app:latest` (manifest-list digest `d317f751929d93eccd5aead9149a622c305f78f3025ba4a033b914fa8385dfb4`). Clean install added 376 packages and reported 0 vulnerabilities; the production build completed typecheck, Vite, server TypeScript compilation, and production prune. Vite reported a large-chunk warning (the IssueDialog chunk is about 1,059 kB before gzip). npm 11 also warned that install scripts for `better-sqlite3` and several packages are not covered by `allowScripts`; runtime readiness still needs to be confirmed after the authorized container update. No `up`, recreate, or deployment health check was run; the existing container and named `workspace-data` volume remain untouched.

The `better-sqlite3` native binding was checked in a disposable container from this image with `--network none`, no `.env`, no mounts, and no app startup. The command loaded the binding, opened `:memory:`, ran `SELECT 1 AS ok`, and closed successfully (`{"binding":"loaded","query":1,"closed":true}`). No package changes were needed for this preflight.

After the final client source gate, `docker compose build` was run again and succeeded from the updated source. The image remains `redmine-ui-app:latest`, now with manifest-list digest `e829014862828b2dfd5c5c977b33e0629305d4c947a067f6de46df57e3976342`. Docker reused the dependency install layers; typecheck, Vite build, server TypeScript compilation, and production prune all completed. The large Vite chunk warning remains, as does npm's `better-sqlite3` `allowScripts` warning. The isolated SQLite binding check was repeated on this final image with the same successful in-memory `SELECT 1` result. No `up`, recreate, or app health request was run, and the named workspace volume was not mounted or changed.

After the demo `allowedStatusIds` fix, `docker compose build` succeeded once more with manifest-list digest `83ad56904d9227a637145304584d4a9b89c29d3163afef48781af6665dba278f`. Docker reused the dependency layer; the app typecheck, client build, server compilation, and production prune succeeded. A new `--network none` disposable-container SQLite `:memory:`/`SELECT 1` check passed. No `up`, recreate, app health request, or volume mount was performed; the preview container remains untouched pending the browser gate.

After the final visual-QA UI cleanup, `docker compose build` succeeded again with manifest-list digest `b4401cb9a215a26a2a9197e3124ec80551d073bbbb96ed0f5ec06fb242d86353`. Docker reused the dependency layer; typecheck, client and server builds, and production prune passed. The `better-sqlite3` warning about `allowScripts` and the Vite large-chunk warning remain. A disposable `--network none` container again passed the in-memory SQLite binding query. No `up`, recreate, runtime health call, or volume access was made; deployment still awaits the full Chromium gate.

## Approved deployment result

After the full Chromium gate passed, `docker compose up -d --wait --no-build` completed successfully using the already-built final image. The container was recreated and became Docker-healthy. Before deployment, container `242c653c0b62…` mounted named volume `redmine-ui_workspace-data` at `/data`; after deployment, container `bc0f6549a20f…` mounted that same named volume at `/data`. The runtime configuration and existing opt-in were left to Compose unchanged; no environment values were inspected or printed.

The initial post-deployment GET-only checks returned HTTP 200 for `/api/health`, `/api/bootstrap`, `/`, the main JS, CSS, and lazy IssueDialog JS. At that point whitelisted app metadata showed `mode=redmine`, `readOnly=false`, `connected=false`, `canWrite=false`, and `textFormat=null`. The health response contained a connection error, but its raw text was not read into output. The container-level health check means the app process serves HTTP, not that Redmine connectivity succeeded. The connection was diagnosed and restored below.

Asset fingerprints from the final deployed image:

- Index `/`: HTTP 200.
- Main JS `/assets/index-D--Q2jyb.js`: HTTP 200, SHA-256 `73a096b76dd2fd5f848ebc93588b145989109f464e7884a6f6ef9b3cf2f53dc7`.
- CSS `/assets/index-CRqTZ0qk.css`: HTTP 200, SHA-256 `4a658e27e78457421f9efe47c5a44fe6428ba081be3b364b02ee7762def5b18b`.
- Lazy IssueDialog `/assets/IssueDialog-CMhMTGKP.js`: HTTP 200, SHA-256 `0a0b52b31c55f750671a1cd8c0967539733056da92acc55a45217eb86f7b986a`.

The deployment command caused no user-created Redmine writes; health/bootstrap and assets were read with GET requests only. No `.env` contents, `Config.Env`, or expanded Compose environment were printed or inspected.

## Redmine connectivity restoration

The first backend-only connection diagnosis forced `writeEnabled=false` and attempted only GET `/users/current.json`. Before the configuration correction, the request failed before receiving an HTTP response with cause code `ENOTFOUND`. A safe hostname classification showed that the recreated service had received the invalid placeholder host. A GET to the previously confirmed Redmine host then returned HTTP 200, so only the `REDMINE_URL` assignment was restored in the ignored project `.env`; the file mode and all other contents were preserved. No `.env` value was printed, and the API token and write opt-in were not changed.

`docker compose up -d --wait --no-build` was run again without a process override. The app became healthy, stayed on image `redmine-ui-app`, and still mounts `redmine-ui_workspace-data` at `/data`. Subsequent GET-only verification returned `/api/health` HTTP 200 with `mode=redmine`, `connected=true`, `readOnly=false`, `canWrite=true`; `/api/bootstrap` HTTP 200 with `connected=true` and `textFormat=common_mark`. The GET to `/users/current.json` returned HTTP 200 under an explicitly forced read-only adapter configuration. Main JS, CSS, and lazy IssueDialog JS each returned HTTP 200 with the same SHA-256 fingerprints recorded above. No Redmine mutations were performed.

## Final adapter guard image

The backend now treats Redmine's `allowed_statuses` as unknown unless it is an array of positive safe integer status IDs. Missing, `null`, non-array, and malformed entries therefore cannot break a full sync or enable a guessed status transition; an explicit empty array remains an empty allowed-transition list. Targeted adapter and sync tests passed (36/36), and `npm run typecheck` passed.

After those checks, `docker compose build` succeeded with manifest-list digest `948c2939aabbefc103dbb8926afb4e6b61323ac88a9f65fd9afa2ea6dd7b7b6e`. `docker compose up -d --wait --no-build` recreated the app and returned healthy. The final container mounts the same `redmine-ui_workspace-data` volume. GET-only verification again returned health HTTP 200 with `mode=redmine`, `connected=true`, `readOnly=false`, `canWrite=true`; bootstrap HTTP 200 with `connected=true`, `textFormat=common_mark`; and HTTP 200 for the main JS, CSS, and IssueDialog JS with the fingerprints above. No external mutations were executed.
