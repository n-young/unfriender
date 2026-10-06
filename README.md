# Social Cleanup

A personal, local-first PWA for reviewing LinkedIn connections, Facebook friends, and Instagram follows. The phone UI is served from the owner's computer through Tailscale Serve. Review decisions are durable; removals are explicitly batched, delayed, serialized, and independently verified.

## Safety status

The local application, fake adapters, SQLite state machine, cancellation behavior, and PWA are implemented. **No real platform adapter is claimed to work.** Real adapters fail closed until the per-account API spike in [docs/adapter-spike.md](docs/adapter-spike.md) is completed. Running this repository does not remove any real relationship by default.

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

For a safe local demo with generated relationships:

```sh
LOCAL_DEV_BYPASS=true FAKE_ADAPTERS=true npm start
```

Then open `http://127.0.0.1:3000`. Fake mode is explicit in `/api/status`; it is not enabled in `.env.example`.

## Account profiles

Install Chromium once if Playwright requests it, then run on the computer:

```sh
npm run login -- linkedin
npm run login -- facebook
npm run login -- instagram
```

Profiles stay under `.data/profiles/` with private directory permissions and are ignored by Git. The PWA never asks for platform passwords. Complete the spike checklist before wiring any private request.

## Commands

- `npm run dev` — local web/server development with fake adapters.
- `npm run build` — builds shared types, PWA, and server.
- `npm test` — state machine and worker tests using fake adapters.
- `npm run typecheck` — strict TypeScript checks.
- `npm run smoke` — checks a running backend.

The server uses one SQLite database and one in-process mutation worker. An instance lock prevents two processes from using the same data directory. Startup turns in-flight mutations into `unknown` and pauses unstarted applied work; explicit resume starts a fresh grace window.

## Deliberate limitations

- Personal, single-owner use only; Tailscale identity is the product access boundary.
- No imports, cloud relay, device pairing, multiple users, public hosting, daily cap, AI ranking, or offline mutation queue.
- Instagram means unfollowing accounts the owner follows.
- A completed removal has no Undo. Only pending work can be cancelled.
- Private APIs and browser selectors are expected to break and require manual repair.
