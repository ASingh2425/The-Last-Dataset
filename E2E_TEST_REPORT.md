# THE LAST DATASET — END-TO-END TEST & VERIFICATION REPORT

**Date of Execution:** October 14, 2026  
**Environment:** Staging / Production Simulation (Node.js v22.12.0, Windows x64)  
**Authoritative Ledger Status:** Verified & Immutable  
**Canonical Point Ceiling:** 3,100 points ($100 + 200 + 400 + 600 + 800 + 1000$)  

---

## 1. Test Suite Execution Summary (`npm test`)

The Central Hub automated test suite was executed against `lib/hub.js`, `lib/evaluator.js`, `lib/store.js`, and associated security modules.

```
TAP version 13
1..43
# tests 43
# suites 0
# pass 43
# fail 0
# cancelled 0
# skipped 0
# duration_ms 18501.727
```

### Breakdown of Test Results

| Category | Tests | Status | Details |
|---|---|---|---|
| **ML Evaluator Logic** | Tests 1–20 | PASS (20/20) | Verified floating point sanitization, column counting, scientific notation, duplicate/missing Sanctuary IDs, UTF-8 BOM handling, and exact $R^2 \ge 0.80$ thresholding. |
| **Hub Lifecycle & Flow** | Tests 21–27 | PASS (7/7) | Verified 2-player registration, team name locking, sequential zone unlocks, HMAC-signed completion verification, replay rejection, returning team restoration, and submission reconciliation. |
| **Security Audits** | Tests 28–41 | PASS (14/14) | Confirmed rejection of spoofed `x-team-id`, inter-team quota isolation, parallel quota race handling (429), path traversal immunity, prerequisite bypass prevention, permanent ML submission locking, 2-player team cap, canonical 3,100 points audit, admin key authorization, and fail-closed ground truth handling. |
| **Distributed Store & Locking**| Test 42 | PASS (1/1) | Upstash atomic distributed locking, state persistence, and automatic lock release. |
| **Two-Player Synchronized E2E**| Test 43 | PASS (1/1) | Full multi-client end-to-end simulation through all 6 zones with cross-player state synchronization. |

---

## 2. High-Concurrency Realistic Load Test

To validate stability under peak live-event conditions (700–900 expected participants), `scripts/load-test.js` was executed with 50 concurrent teams (100 distinct players):

```bash
node scripts/load-test.js --teams 50 --concurrency 10
```

### Load Test Results Matrix

| Metric | Measured Value | Requirement / Benchmark | Status |
|---|---|---|---|
| **Simulated Players** | 100 players | Multi-client concurrency | PASS |
| **Simulated Teams** | 50 teams | Multi-team isolation | PASS |
| **Concurrency Level** | 10 parallel team workers | High connection pooling | PASS |
| **Total HTTP Requests** | 1,254 requests | Multi-stage user journeys | PASS |
| **Elapsed Execution Time** | 5.96 seconds | Sub-10 second completion | PASS |
| **Average Throughput** | 210 requests / sec | Peak event load handling | PASS |
| **Total Errors** | **0 errors** | Zero unhandled failures | PASS |
| **HTTP 5xx Server Errors** | **0 (0.00%)** | Zero system crashes | PASS |
| **HTTP 429 Rate Limits** | 50 (Expected quota locks) | Permanent escape locks enforced | PASS |
| **Latency Min** | 5 ms | Ultra-low local baseline | PASS |
| **Latency Average** | 49 ms | Smooth interactive gameplay | PASS |
| **Latency p50 (Median)** | 45 ms | Consistent request processing | PASS |
| **Latency p90** | 74 ms | Low queue contention | PASS |
| **Latency p95** | 83 ms | Sub-100ms 95th percentile | PASS |
| **Latency p99** | 112 ms | Controlled latency tail | PASS |
| **Latency Max** | 135 ms | Zero connection timeouts | PASS |
| **Qualified Teams** | 50 / 50 (100%) | Full progression completion | PASS |
| **Score Audit (3,100 pts)** | **50 / 50 (100% PASS)** | Authoritative ledger intact | PASS |

---

## 3. Security Boundary Verification

1. **Authentication & Session Isolation:**
   - Client-supplied `x-team-id` headers without valid signed session cookies or HMAC `launchToken` are rejected with HTTP 401.
   - Teammate A cannot submit on behalf of Team B. Attempts to pass an alternate `teamId` in the body are ignored in favor of the cryptographically bound session identity.
2. **Sequential Gate Enforcement:**
   - Direct completion requests to `/api/zone/complete` for Zone $N$ without completing Zone $N-1$ fail closed with HTTP 403 `PREREQUISITE_NOT_MET`.
   - Purple Zone completion requires an authoritative qualifying submission ($R^2 \ge 0.80$) on record; bypass attempts fail closed with HTTP 403.
3. **Idempotency & Score Integrity:**
   - Multiple identical completion requests for any zone or CTF award points exactly once. Subsequent requests return HTTP 200 with the already-confirmed score.
   - Total score cannot exceed 3,100 points under any combination of concurrent or repeated submissions.
4. **Permanent Escape Locking:**
   - Once a team scores $R^2 \ge 0.80$ in Purple Sector, their escape status is permanently locked. All subsequent submission attempts are rejected with HTTP 429 `PURPLE_ALREADY_COMPLETED`, protecting the leaderboard from post-qualification manipulation.

---

## 4. Multi-Repository Build Verification

All 12 component repositories were tested for production build viability:

| Order | Repository / Component | Framework / Toolchain | Build Command | Exit Status |
|---|---|---|---|---|
| 1 | Main Backend Hub (`Last_Dataset`) | Node.js / HTTP / Store | `npm test` | **0 (PASS)** |
| 2 | Opening Storyline (`intro_stroyline`) | Next.js 15.5.9 | `npm run build` | **0 (PASS)** |
| 3 | Sanctuary Zero (`lastDataset_sanc`) | Next.js 15.5.9 | `npm run build` | **0 (PASS)** |
| 4 | Yellow Zone (`yellowzone`) | Vite 8.3.2 + React + TS | `npm run build` | **0 (PASS)** |
| 5 | Yellow-to-Blue (`yellow_to_blue_slideshow`) | Next.js 16.3.4 | `npm run build` | **0 (PASS)** |
| 6 | Blue Zone (`bluezone`) | Next.js 15.5.25 | `npm run build` | **0 (PASS)** |
| 7 | Blue-to-Orange (`blue_orange_slideshow`) | Next.js 15.5.9 | `npm run build` | **0 (PASS)** |
| 8 | Orange Zone (`or_light`) | Next.js 14.2.35 | `npm run build` | **0 (PASS)** |
| 9 | Orange-to-Red (`orange_to_red_slideshow`) | Next.js 15.5.9 | `npm run build` | **0 (PASS)** |
| 10 | Red Zone (`red`) | Vanilla JS / Three.js | Static Syntax Check | **0 (PASS)** |
| 11 | Red-to-Purple (`red_purple_slideshow`) | Next.js 15.5.9 | `npm run build` | **0 (PASS)** |
| 12 | Purple ML Frontend (`PURPLEZONE_FRONTEND`) | Vite + React + TS | `npm run build` | **0 (PASS)** |
