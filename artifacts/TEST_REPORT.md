# THE LAST DATASET — Map Hub QA Report

**Run date:** 2026-10-10  
**Node:** v22.16.0  
**Browser available:** Chromium 144 (DevTools Protocol)  
**External runtime dependencies:** none

## Build and test results

- `npm install --offline --ignore-scripts --no-audit --no-fund`: PASS; no third-party runtime dependencies are required.
- `npm test`: PASS, 6/6 tests.
- `node --check` on all server, library, script, test and browser JavaScript files: PASS.
- Live server smoke on port 4179: `/api/health` returned 200; new-team registration returned the expected first-run states; direct Blue Zone and Blue CTF requests returned 403; opening Yellow CTF returned 200; placeholder CTF HTML returned 200 with `X-Frame-Options: SAMEORIGIN` and a matching `frame-ancestors 'self'` policy.
- UI interaction smoke: 9/9 assertions PASS, with zero browser console errors and zero uncaught JavaScript exceptions. See `browser/ui-smoke-report.json` for text-based UI smoke results. Screenshot assets from the earlier run were removed because they contained the retired event branding.

## Mandatory checklist

| # | Check | Result | Evidence / qualification |
|---:|---|---|---|
| 1 | Hero, infected title, boot and atmospheric effects | **PASS (visual smoke)** | Text-based UI smoke report; no console/runtime errors. This was an injected source bundle, not a normal browser navigation. |
| 2 | Team registration, validation, whitelist, returning team and locked name | **PASS (server tests + UI smoke)** | Integration tests cover markup-like name rejection, whitelist rules, immutable team name, and resuming saved progress. |
| 3 | Sanctuary-centred map, five zones, order/colours and start state | **PASS (visual smoke)** | UI smoke assertions cover the map state: central Sanctuary, Yellow available, other zones quarantined, and the travel beacon. |
| 4 | Only Yellow available initially; locked-zone click is denied | **PASS** | Live requests to `/api/zones/blue` and `/api/ctfs/blue-01/open` both returned 403. |
| 5 | Locked-zone server enforcement and client tamper attempts | **PARTIAL** | Direct locked-zone API/CTF access, malformed cookie handling, and absence of locked CTF URLs are tested. A full adversarial browser matrix for edited cookies/localStorage/replayed public requests was not run; progression is not stored in localStorage. |
| 6 | Full progression and zone-unlock cinematics through Purple/finale | **PARTIAL** | Backend test cleared all 15 configured challenges in strict order. The UI cinematic was visually exercised for Yellow → Blue; the complete Purple finale was not browser-verified. |
| 7 | HMAC completion validation, timestamp, replay and idempotency | **PASS (server tests)** | Valid signatures succeed; wrong secret/signature, expired timestamp and exact replay reject; a fresh signed duplicate completion is idempotent. |
| 8 | Hovering HUD, progress, countdown, log and collapse controls | **PARTIAL** | HUD renders, team/progress/log are populated and visible. Every HUD control/countdown edge state was not exhaustively interacted with in the browser. |
| 9 | CTF frame, Back to Map, unreachable/signal-lost behavior | **PARTIAL** | UI smoke verified frame state and Back to Map; live HTTP confirmed the placeholder endpoint and embed headers. Browser policy prevented a normal page navigation, so actual iframe rendering and unreachable-frame timing were not verified in-browser. |
| 10 | Refresh restores the current screen/state | **PARTIAL** | Session view is persisted on the server and startup contains restoration paths; returning-team progress is tested. Refresh was not automated at every UI screen. |
| 11 | Responsive sizes, reduced motion, clarity mode, fallback | **PARTIAL** | Responsive and reduced-motion CSS/logic is present; no full viewport matrix or dedicated reduced-motion browser run was possible. Rendering uses Canvas 2D/CSS, not WebGL, so there is no WebGL-only path to fail. |
| 12 | Performance and FPS/quality-tier report | **NOT VERIFIED** | A meaningful FPS measurement was not available in this environment. High/Low effects modes exist, but the 60-fps target is not claimed as measured. |
| 13 | Clean install and documented startup | **PASS** | Offline `npm install`, six tests, syntax checks, and a real HTTP server smoke all passed. Start with `npm install && npm start`; default port is 4179. |

## Browser testing limitation

The managed Chromium policy in this workspace blocks all navigable URLs, including localhost. Installing Playwright also timed out. Therefore the UI smoke runner used Chromium DevTools Protocol to inject the exact HTML/CSS/JavaScript sources into an `about:blank` document and mock API responses in-page. This verifies layout, DOM interactions and transition states, but it is **not** a substitute for an unrestricted Playwright run against a real browser-loaded app. Backend/API behavior was tested separately through Node integration tests and live HTTP requests.

Earlier screenshots and frame captures were intentionally removed from the deliverable because their pixels contained the retired organizer/event branding. Text-based interaction results remain in `browser/ui-smoke-report.json`; captures are not included in this branding-clean package.

## Security summary

- A signed, `HttpOnly`, `SameSite=Strict` cookie carries only a random session ID and signature; team identity and progress are stored server-side.
- Zone unlocks are calculated server-side in configured order. Public bootstrap does not expose locked CTF IDs/URLs, and protected APIs re-check zone access.
- CTF completion uses per-challenge HMAC secrets, a five-minute timestamp window, timing-safe signature comparison and exact-request replay rejection. Completion remains idempotent.
- Developer solve API/panel is only registered outside production when `ENABLE_DEV_TOOLS=true`; production mode disables it even if the flag is set.
- The server applies basic rate limits, input validation, same-origin mutation checks, body-size limits, and security response headers.

## Known limitations / before launch

1. `config/event.json` has a clearly marked demo schedule. Replace it with the official start and end timestamps.
2. `config/zones.json` contains 15 placeholder CTFs. Replace each `url` with its existing CTF application URL and keep IDs/order stable.
3. Set a strong `SESSION_SECRET` and one unique 32+ character `CTF_SECRET_*` for every integrated CTF. Copy `.env.example` only for local/demo use; never deploy its placeholder values.
4. Each CTF owner must call the documented `reportVerifiedSolve()` helper **from the CTF backend after it independently verifies the team's successful solve**. Share the secret with the backend only—never ship it to browser code. The helper signs `TEAMID_UPPERCASE.CTF_ID.UNIX_TIMESTAMP_SECONDS` with HMAC-SHA256 and POSTs to `/api/internal/complete`.
5. Team ID + Team Name is not password-grade authentication. For a closed event, enable whitelist mode and distribute team credentials out-of-band.
6. The JSON store is appropriate for a demo/single process; use transactional persistent storage and shared rate-limit/replay storage for multi-instance production.
7. The visual identity uses local system font stacks rather than bundled font files, so exact typography varies slightly by OS. There are no external font/CDN/runtime network requests.
8. No Git repository or existing CTF projects were mounted in the build workspace. Consequently a `git status` / `git diff` comparison cannot be supplied. All authored project files and QA artifacts are inside this new `Map Hub/` directory; the final ZIP is a separate delivery copy.
