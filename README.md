# THE LAST DATASET — Map Hub

An offline-first, cinematic survivor hub for THE LAST DATASET and the PRALAYA recovery event. The hub owns team identity, progress and zone unlocks; each CTF remains a separate application wired in through `config/zones.json`.

## Run locally

Requirements: Node.js 20+ (tested with Node 22). No third-party runtime packages, CDN assets, hosted fonts, or runtime network dependencies are used.

```bash
cd "Map-Hub"
npm install
npm start
```

Open <http://127.0.0.1:4179>. Port `4179` is the default so the hub avoids the common `3000`, `5173`, and `8080` ports. Change `PORT` in `.env` to use another port. By default the server binds to `127.0.0.1`; set `HOST=0.0.0.0` only when you intentionally want it reachable on your network.

The first screen is a booting, torch-lit ruin. Select **ENTER THE SANCTUARY**, register a Team ID and Team Name, and the first team session begins at the world map. Team progress is stored locally in `data/progress.json` and survives a restart. For a production install, use a persistent writable data volume and set the secrets described below.

## Main screens

- **Hero:** ruined skyline, moving silhouettes, drifting ash/fog, mouse-responsive flashlight shading, brief lurch/eye-glow response, infected title glitches, survivor transmission, reduced-effects mode, and opt-in synthesized ambient audio.
- **Sanctuary check-in:** scanner/gate art, server-validated Team ID and Team Name, locked callsign, dog-tag feedback, and an explicit error for invalid or conflicting identity.
- **World map:** a hand-authored SVG map with the Sanctuary at the centre, five distinct colour-coded zones, roads that illuminate as zones become available, progress arcs, keyboard-accessible zone controls, lock denial, movable/zoomable map, and a collapsible holographic field HUD.
- **Zone terminals:** each unlocked zone shows its configured CTF challenges as field terminals. Solved challenges remain visible and replayable.
- **CTF frame:** a full-height iframe with a persistent Back to Map control, Open in New Tab fallback, loading indicator, and Signal Lost/retry state. The hub does not implement CTF challenge logic.
- **Unlock/finale:** clearing every CTF in a zone produces a quarantine-break transition and unlocks the next zone. Clearing Purple produces **SURVIVOR COMPLETE**.

`prefers-reduced-motion`, the Clarity toggle, and the High/Low Effects toggle are supported. Audio is muted unless a user opts in. The hub avoids external asset requests; type uses local system font stacks for reliable offline display.

## Configuration

### `config/zones.json`

This is the source of truth for zone progression and CTF integrations. Preserve the zone order and the IDs `yellow`, `blue`, `orange`, `red`, `purple` unless you intentionally update your event data and test suite. Each CTF needs a unique `id`, `title`, `briefing`, `url`, and `completion.secretEnv`.

- The default package includes three labelled placeholder CTFs per zone (15 total) at `/mock/ctf/<ctf-id>`.
- To wire a real CTF, change that CTF's `url` to its deployed URL. The map UI and progression logic do not need to change.
- The server only gives CTF details to an authenticated team when that zone is unlocked. It does not return a locked zone's CTF IDs, descriptions, or URLs in the bootstrap response. Challenge URLs are returned only after the server validates an attempt to open an accessible CTF.
- A CTF's `completion.secretEnv` identifies the unique environment variable for that CTF's HMAC secret. Never place that secret in `zones.json`, client JavaScript, an iframe, or the public repository.

### `config/teams.json`

The default mode is `open`: a valid new Team ID may register on first use. The first Team Name associated with an ID becomes immutable; a later registration using the same ID with another name receives `409 TEAM_NAME_LOCKED`. Returning teams use the same ID and exact name. Since the requested flow has no password field, the ID/name pair is an event credential rather than strong account authentication; for higher assurance, distribute team IDs/names privately and use `whitelist` mode.

For whitelist mode, edit the file to resemble:

```json
{
  "mode": "whitelist",
  "allowedIds": ["TEAM-007", "TEAM-013"],
  "teamIdPattern": "^[A-Za-z0-9-]{3,32}$",
  "teamNamePattern": "^[\\p{L}\\p{N} .,'’_()-]{2,40}$"
}
```

Team IDs are normalized to uppercase for storage and comparison. Team ID defaults to 3–32 letters/numbers/dashes; names are trimmed and restricted to 2–40 letters, numbers, spaces and basic punctuation. The browser displays untrusted text with DOM text content or escaped template fields; the server rejects markup in names rather than interpreting it as HTML.

### `config/event.json`

Set `start` and `end` to official ISO-8601 timestamps with an explicit time zone. The supplied values are a **demo schedule only**, not an assertion about the real event start time. The HUD shows Event Not Started, the time remaining while live, or Event Ended.

## Publish this project to GitHub

Create an empty **private** repository named `Map-Hub` under your account at <https://github.com/new>. Do not initialize it with a README, license, or `.gitignore`; this folder already contains those project files. In PowerShell, from this project's root directory, run:

```powershell
git init -b main
git add .
git status --short
git commit -m "Initial Map Hub release"
git remote add origin https://github.com/Saksham-Kanodia/Map-Hub.git
git push -u origin main
```

Review `git status --short` before committing. `.env`, `.env.local`, local `data/progress.json`, and Vercel local metadata are ignored. Do not use `git add -f` on secret or progress files. If Git says `origin` already exists, inspect it with `git remote -v` rather than overwriting an unknown remote.

## Deploy to Vercel (serverless)

This project supports a Vercel Node.js Function adapter. **Do not deploy it with the local JSON file store**: Vercel Functions have a read-only filesystem except for temporary storage, and local files are not durable across instances. The adapter automatically selects the Upstash Redis REST store when `VERCEL` is set, and refuses to start if the Redis connection variables are missing.

### One-time setup

1. Push the project to a GitHub repository. Keep the repository private until you decide to publish it; never commit `.env`, database tokens, real CTF secrets, or team progress.
2. In the Vercel dashboard choose **Add New → Project**, import the repository, and use the repository root as the Root Directory. The included `vercel.json` routes the hub through its Node.js function. No build command is required.
3. In the Vercel Marketplace, add an **Upstash Redis** integration and link it to the project. Ensure it supplies `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to Production and Preview environments. The hub stores progress as a JSON document under `UPSTASH_STATE_KEY` (default `last-dataset-map-hub:state:v1`) and serializes state-changing API requests with a Redis lock.
4. Add `SESSION_SECRET` as a random, high-entropy value of at least 32 characters. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, and `ENABLE_DEV_TOOLS=false`. Add a separate 32+ character secret for each configured CTF `completion.secretEnv` name. Only the hub and that CTF's backend should know its shared secret.
5. Set the official `config/event.json` start/end times and replace placeholder CTF URLs/secrets before the real event. Redeploy after config changes.
6. Deploy, then verify `/api/health`, registration, return-login, locked-zone denial, and one end-to-end test completion.

### Local use of the same handler

Run `npm install`, `npm test`, and `npm start` as usual. The local app continues to use the atomic JSON file at `data/progress.json`, so no Redis account is needed locally. To test Vercel routing locally, install the Vercel CLI and run `npm run vercel:dev` after adding the required environment values to `.env.local` (do not commit that file).

### Vercel caveats

The Redis document approach is suitable for a modest event hub, not a high-write transactional leaderboard. Rate limits currently live in the function instance, so use Vercel Firewall or a shared rate-limiter for a public competitive event. If many simultaneous challenge completions or strict transaction guarantees are expected, use a proper relational store with atomic per-team/per-CTF writes before event day.

## Environment and production

Copy `.env.example` to `.env` and replace every placeholder secret:

```bash
cp .env.example .env
```

At minimum configure:

- `SESSION_SECRET`: at least 32 unpredictable characters. Production startup refuses the development fallback or a missing/short secret.
- `NODE_ENV=production` for production.
- `COOKIE_SECURE=true` when serving HTTPS (the default in production). Do not disable Secure on a public HTTPS deployment.
- `PORT` and `HOST` to match your deployment.
- A unique `CTF_SECRET_*` value for every real challenge with completion reporting enabled. Use at least 32 random bytes for each secret.
- `ENABLE_DEV_TOOLS=true` only for a local/demo environment. Production always disables the dev panel/API regardless of this flag.

Use HTTPS in production, terminate TLS at a trusted reverse proxy, restrict the backing data file/volume permissions, back up `data/progress.json`, and set a strong `SESSION_SECRET`. No third-party package needs installing on the production host. If hosting behind a proxy, ensure the public hostname and Origin checks remain consistent; do not blindly trust forwarded headers.

### Session, access-control, and completion design

- The cookie is `HttpOnly`, `SameSite=Strict`, path `/`, and contains only a random 256-bit session ID plus an HMAC signature. Team identity, view state and progress remain server-side. Cookies do not contain secrets or CTF progress.
- All progression is derived from `data/progress.json` on the server. Yellow is initially available; Blue requires all Yellow CTFs, Orange requires all Blue CTFs, Red requires all Orange CTFs, and Purple requires all Red CTFs. Every public zone/CTF route rechecks access; a direct URL or altered browser state cannot unlock zones.
- Public APIs are rate-limited, JSON request bodies have a size limit, mutation requests check Origin when present, and responses include CSP and other security headers. Registration, CTF completion and progress updates are idempotent where appropriate.
- `/api/internal/complete` is a server-to-server endpoint. For HMAC-SHA256 it signs the exact UTF-8 string `TEAMID_UPPERCASE.CTF_ID.UNIX_TIMESTAMP_SECONDS`. The timestamp must be within five minutes. The exact same signed request cannot be replayed; a second completion with a fresh timestamp remains safe and returns `newlySolved: false` if it was already solved.
- The optional `postMessage` bridge never marks progress by itself. A bridge message is accepted only from the configured URL's origin and only causes the hub to re-fetch server-side progress. Completion state changes only after the server-to-server HMAC endpoint or an explicitly enabled local developer simulation.

## Wiring a real CTF to report completion

1. Give the CTF owner the correct `ctfId`, the hub's HTTPS base URL, and that CTF's unique secret. The secret must be shared privately with the CTF's **server**, not its browser code.
2. Set the CTF's `url` in `config/zones.json` and set the matching `CTF_SECRET_*` environment variable on the hub and the CTF backend.
3. At the point where the CTF backend has independently verified a successful solve, call a function like the following from the CTF's server process. Replace `HUB_URL`, `CTF_ID`, and the secret environment variable for that CTF.

```js
const crypto = require('node:crypto');

async function reportVerifiedSolve({ teamId }) {
  const hubUrl = process.env.HUB_URL; // e.g. https://hub.example.org
  const secret = process.env.CTF_SHARED_SECRET; // server-side only
  const ctfId = process.env.CTF_ID; // e.g. yellow-01
  if (!hubUrl || !secret || !ctfId) throw new Error('Completion reporting is not configured');

  const normalizedTeamId = teamId.trim().toUpperCase();
  const timestamp = Math.floor(Date.now() / 1000);
  const signedText = `${normalizedTeamId}.${ctfId}.${timestamp}`;
  const signature = crypto.createHmac('sha256', secret).update(signedText, 'utf8').digest('hex');

  const response = await fetch(new URL('/api/internal/complete', hubUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ teamId: normalizedTeamId, ctfId, timestamp, signature }),
    signal: AbortSignal.timeout(5000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Hub completion rejected (${response.status}): ${result.error}`);
  return result; // { ok: true, newlySolved: boolean, solved: true, ctfId }
}

// Call ONLY after the CTF backend has verified the answer/flag for this team.
// await reportVerifiedSolve({ teamId: verifiedTeamId });
```

The challenge backend is responsible for mapping its verified submission to the same canonical Team ID registered in the hub. Do not accept `teamId`, `ctfId`, or success state from an untrusted browser as the verification signal; the CTF server must decide that the solve is real before signing. Handle HTTP `401` (bad/expired signature), `409` (exact replay), `403` (zone not accessible), and `503` (hub secret not configured) as integration errors. Retry a transient network error using a **fresh** timestamp/signature.

### Optional instant refresh message

After its server has sent a successful completion report, a CTF page may request an immediate hub refresh:

```js
window.parent.postMessage({ type: 'TLD_CTF_SOLVED' }, 'https://hub.example.org');
```

This message is a UI hint, not proof. The hub re-fetches its own API and ignores the message if its origin differs from the CTF URL origin configured for the active challenge. Use a specific hub origin, not `*`. A CTF may also send `{ type: 'TLD_CTF_RETURN_TO_MAP' }` when its own Back button should return to the hub.

## Developer demo tools

The browser simulation panel, `/api/dev/solve`, and the CLI are enabled only when `NODE_ENV` is not `production` **and** `ENABLE_DEV_TOOLS=true`. The API route is not registered otherwise; production mode wins even if the flag is accidentally true. The browser panel and placeholder button are clearly marked DEV SIMULATION.

```bash
# Set ENABLE_DEV_TOOLS=true in your local .env, then register a team in the UI.
npm run dev:solve -- TEAM-007 yellow-01
npm run dev:solve -- TEAM-007 yellow-02
npm run dev:solve -- TEAM-007 yellow-03
# Blue can now be opened. Repeat the same pattern through all five zones.

# Dangerous: wipes all local teams, sessions, and progress. Requires explicit confirmation.
npm run reset:data -- --confirm
```

The CLI checks that the team exists and that the target zone is already accessible, so it cannot skip the progression sequence. For a clean test use a throwaway data store.

## Tests

```bash
npm test
```

The built-in Node test suite runs without network access or external dependencies. It covers registration and name locking, XSS-like names, malformed-cookie handling, returning-team progress recovery, locked-zone API denial, no locked CTF URLs in bootstrap data, partial-zone gating, full five-zone progression, valid/invalid/wrong-secret/expired/replayed HMACs, idempotent completion, whitelist mode, and the production dev-route guard.

## Known limitations and deployment notes

- The included CTFs are intentionally placeholders, not challenge applications. Replace their URLs in the config to wire your existing independent CTF servers.
- The default persistence is an atomic JSON file store, suited to a single hub process / demo. For multiple server instances or high-volume production, migrate the store to a transactional database and add shared rate-limit/replay storage.
- The requested Team ID + Team Name flow is not password-grade authentication. Whitelist the IDs and distribute access details out-of-band for a closed event; stronger identity requires an additional credential.
- A browser cannot reliably detect every cross-origin iframe policy failure due to browser security boundaries. The frame includes an external-tab fallback; slow/no-load attempts enter the Signal Lost view. Set compatible `frame-ancestors`/`X-Frame-Options` on external CTF apps or instruct teams to use the new-tab fallback.
- The world scene uses authored SVG and Canvas 2D/CSS effects; there is no WebGL dependency, so no WebGL-specific fallback is required. Local system-font stacks are used instead of shipping font files, which keeps the package smaller and avoids font downloads; appearance may vary slightly by operating system.
- The HUD is tuned for desktop/tablet. Narrow screens show a best-viewed-on-larger-screen notice but remain navigable.
- The event dates in `config/event.json` are demo values and must be replaced.
- No existing repository or locked CTF directories were mounted in the build workspace. The project was created as a new top-level `Map Hub/` folder in the supplied output workspace; outside-folder `git status`/`git diff` evidence is therefore unavailable here. All created application files are within this folder.
