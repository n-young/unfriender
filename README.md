# Unfriendr

A personal, local-first PWA for reviewing LinkedIn connections, Facebook friends, and Instagram follows. The phone UI is served from the owner's computer through Tailscale Serve. Review decisions are durable; removals are explicitly batched, delayed, serialized, and independently verified.

## Safety status

The local application, SQLite state machine, cancellation behavior, mixed deck, and PWA are implemented. Facebook unfriending and Instagram unfollowing have each passed one exact live canary and now use narrow browser-backed adapters in the serial worker. LinkedIn discovery and the Remove connection menu path are verified, but LinkedIn mutation remains disabled until its explicitly named canary is approved and the absent postcondition is proven. Running the repository never mutates a platform until the owner stages relationships and applies that exact batch.

## Setup

Requires Node 22.5 or newer.

```sh
npm install
npm run build
cp .env.example .env
```

Set `ALLOWED_TAILSCALE_LOGIN` to the owner's exact Tailscale login and `APP_ORIGIN` to the HTTPS Serve origin. Keep `HOST=127.0.0.1`, `LOCAL_DEV_BYPASS=false`, and `FAKE_ADAPTERS=false` for normal use.
`npm start` loads this root `.env` file automatically; existing shell environment variables take precedence.

```sh
npm start
tailscale serve --bg 3000
```

Use the exact HTTPS URL printed by Tailscale. Do not use Funnel. The computer must remain awake and connected to the tailnet.

On the owner's current machine, port 443 remains assigned to Tutalage and Dockge uses 8443. Unfriendr is therefore published separately with:

```sh
tailscale serve --bg --https=8444 3000
```

Its installed PWA origin is `https://tutor.salmon-pleco.ts.net:8444/`. The matching `APP_ORIGIN` value must include `:8444`.

### Docker Compose / Dockge

The normal always-on deployment is the checked-in Compose stack:

```sh
./deployment/manage.sh up
./deployment/manage.sh status
```

It builds `social-cleanup-app:local`, publishes only `127.0.0.1:3000`, persists session/database state in the ignored `.data/` directory, runs with a read-only root filesystem and dropped Linux capabilities, and exposes a container-local health check.

For Dockge installations that should not mount `~/Programming`, a runtime-only copy of `deployment/dockge.compose.yaml` can instead live inside Dockge's existing stacks directory with its own private `.env` and `data/`. Dockge can then start, stop, recreate, and inspect the local image without reading the source tree. Rebuild `social-cleanup-app:local` from this repository before recreating that runtime-only stack after a code change.

On the owner's current machine, broader access was explicitly approved. Dockge mounts `~/Programming`, and its existing stacks tree contains `unfriender`, a symlink to this repository. This makes the checked-in `compose.yaml` the stack Dockge operates while preserving the requested repository location.

Headed platform login remains a host-side command (`npm run login -- <platform>`), because login and MFA require the Mac desktop session. Each sync exports browser storage into the ignored `.data/` directory mounted by the app container. The container includes pinned headless Chromium for verified browser-backed checks and removals.

For a safe local demo with generated relationships:

```sh
LOCAL_DEV_BYPASS=true FAKE_ADAPTERS=true npm start
```

Then open `http://127.0.0.1:3000`. Fake mode is explicit in `/api/status`; it is not enabled in `.env.example`.

## Account profiles

The login helper uses an installed Google Chrome on macOS with a dedicated profile. On other systems, install Playwright Chromium once if requested with `npx playwright install chromium`, then run on the computer:

```sh
npm run login -- linkedin
npm run login -- facebook
npm run login -- instagram
```

Profiles stay under `.data/profiles/` with private directory permissions and are ignored by Git. The PWA never asks for platform passwords. Complete the spike checklist before wiring any private request.

LinkedIn has a verified read-only bridge. After login, close the dedicated browser and run:

```sh
npm run spike:linkedin
npm run sync:linkedin
```

The sync verifies `/voyager/api/me`, scrolls the authenticated virtualized connection list to exhaustion (or the configured safety ceiling), and writes a private snapshot to `.data/platform-cache/linkedin.json`. LinkedIn removal remains disabled until one exact canary and its absent postcondition are verified.

Facebook also has a read-only host snapshot command:

```sh
npm run spike:facebook
npm run sync:facebook
```

It verifies the account URL and accumulates friend cards across Facebook's virtualized list. The verified worker path checks the acting account and exact target, then uses **Friends → Unfriend** once and independently confirms that **Add friend** replaces the friendship control.

Instagram also has a read-only following snapshot command:

```sh
npm run spike:instagram
npm run sync:instagram
```

The sync verifies the acting account, opens its Following panel, then paginates the exact observed read-only endpoint using stable numeric account IDs. Read-only pages have a 1.5-second request floor and bounded exponential backoff for HTTP 429/5xx responses. The verified worker path checks the numeric friendship state, uses the profile's **Following → Unfollow** flow once, then reads the friendship state again.

The current owner snapshots completed at 2,459 LinkedIn connections, 2,285 Facebook friends, and 1,620 Instagram follows. Snapshot contents, cookies, profiles, and canary reports stay in ignored `.data/` files.

## Commands

- `npm run dev` — local web/server development with fake adapters.
- `npm run build` — builds shared types, PWA, and server.
- `npm test` — state machine and worker tests using fake adapters.
- `npm run typecheck` — strict TypeScript checks.
- `npm run smoke` — checks a running backend.
- `npm run live-test:browser -- facebook|linkedin` — guarded one-target browser canary; requires the platform-specific exact-handle environment variable, and remains a dry run unless `LIVE_BROWSER_REMOVAL` repeats that same handle.

The server uses one SQLite database and one in-process mutation worker. An instance lock prevents two processes from using the same data directory. Startup turns in-flight mutations into `unknown` and pauses unstarted applied work; explicit resume starts a fresh grace window. Mutations are serialized with a 15-second minimum interval. A rate limit during a read-only preflight defers that platform with bounded exponential backoff; once a mutation has been dispatched, any unclear response becomes `unknown` and is never retried automatically.

## Deliberate limitations

- Personal, single-owner use only; Tailscale identity is the product access boundary.
- No imports, cloud relay, device pairing, multiple users, public hosting, daily cap, AI ranking, or offline mutation queue.
- Instagram means unfollowing accounts the owner follows.
- A completed removal has no Undo. Only pending work can be cancelled.
- Private APIs and browser selectors are expected to break and require manual repair.
- `BROWSER_ADAPTERS` is an explicit allowlist. The default Compose value is `facebook,instagram`; LinkedIn remains read-only.
