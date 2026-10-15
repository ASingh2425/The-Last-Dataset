# THE LAST DATASET — FORENSIC AUDIT REPORT
**Event:** TechTatva 2026 | MAHE Manipal  
**Date:** 2026-10-14  
**Audit Scope:** Multi-repository production recovery covering all 12 event applications.  
**Auditor:** Principal Software Architect, Application Security Engineer & Production Release Manager

---

## 1. Executive Summary & Repository Status Matrix

The Last Dataset event platform consists of 12 interconnected repositories designed to execute a strict progression lifecycle:
$$\text{Opening Storyline} \longrightarrow \text{Sanctuary Zero} \longrightarrow \text{Yellow} \longrightarrow \text{Blue} \longrightarrow \text{Orange} \longrightarrow \text{Red} \longrightarrow \text{Purple (PRALAYA Core)} \longrightarrow \text{Escape}$$

All 12 repositories were audited across entry points, routing, build configurations, authentication mechanisms, database models, and trust boundaries.

### Audited Repositories Overview

| # | Repository Name | Path | Upstream Remote URL | Branch | Head Commit | Build Status | Uncommitted Changes |
|---|---|---|---|---|---|---|---|
| 1 | **Main Hub & Central Backend** | Root (`/`) | `https://github.com/ASingh2425/Last_Dataset.git` | `main` | `5da55c8` | PASS (`npm test`: 43/43 pass) | Yes (2 files modified, 1 untracked) |
| 2 | **Opening Storyline** | `repos/intro_stroyline` | `https://github.com/SrinithiBidvai/intro_stroyline.git` | `main` | `5b0e7dd` | **FAIL** (Next.js 16 TS PageProps union error) | None (Clean) |
| 3 | **Sanctuary Zero** | `repos/lastDataset_sanc` | `https://github.com/SrinithiBidvai/lastDataset_sanc.git` | `main` | `d4992f6` | PASS (Needs npm install in clean env) | None (Clean) |
| 4 | **Yellow Zone** | `repos/yellowzone` | `https://github.com/vedicvipers-pixel/yellowzone.git` | `main` | `cb6fe6e` | **FAIL** (Missing dataset TS files, TS compilation error) | None (Clean) |
| 5 | **Yellow-to-Blue Slideshow** | `repos/yellow_to_blue_slideshow` | `https://github.com/SrinithiBidvai/yellow_to_blue_slideshow.git` | `main` | `ae9f335` | **FAIL** (Next.js 16 TS PageProps union error) | None (Clean) |
| 6 | **Blue Zone** | `repos/bluezone` | `https://github.com/devpeeyushh/bluezone.git` | `main` | `23ed81f` | PASS (`next build` clean) | Yes (2 files modified) |
| 7 | **Blue-to-Orange Slideshow** | `repos/blue_orange_slideshow` | `https://github.com/SrinithiBidvai/blue_orange_slideshow.git` | `main` | `d68cf3e` | **FAIL** (Next.js 15 TS PageProps union error) | None (Clean) |
| 8 | **Orange Zone** | `repos/or_light` | `https://github.com/bihaninakul07-art/or_light.git` | `main` | `f80b62b` | PASS (`next build` clean) | None (Clean) |
| 9 | **Orange-to-Red Slideshow** | `repos/orange_to_red_slideshow` | `https://github.com/SrinithiBidvai/orange_to_red_slideshow.git` | `main` | `32cb0d0` | **FAIL** (Next.js 15 TS PageProps union error) | None (Clean) |
| 10 | **Red Zone** | `repos/red` | `https://github.com/dk0204-tech/red.git` | `main` | `95b5405` | PASS (Static HTML/JS deployment) | None (Clean) |
| 11 | **Red-to-Purple Slideshow** | `repos/red_purple_slideshow` | `https://github.com/SrinithiBidvai/red_purple_slideshow.git` | `main` | `6759ab2` | **FAIL** (Next.js 15 TS PageProps union error) | None (Clean) |
| 12 | **Purple ML Frontend** | `repos/PURPLEZONE_FRONTEND` | `https://github.com/ASingh2425/PURPLEZONE_FRONTEND.git` | `main` | `903ac4b` | PASS (`vite build` clean, redirects to in-hub) | None (Clean) |

---

## 2. Forensic Findings Table

| Ref | Repository | Severity | Defect | Evidence | Root Cause | Player Impact | Creator Impact | Dependencies | Recommended Fix | Verification |
|---|---|---|---|---|---|---|---|---|---|---|
| **F-01** | `yellowzone` | **P0** | Critical Build Failure: Missing module `investigationData` & `communityDataset` | `src/App.tsx(16,30)`, `MainInvestigationPanel.tsx(4,65)` | Files were added in sibling `yellow_zone` repo during refactor but never committed to upstream `yellowzone` | App cannot build or deploy on Vercel; runtime crash | Live Yellow Zone deployment broken | `yellow_zone` | Port missing data files and interface typings from `yellow_zone` into `yellowzone` | `npm run build` exits 0 |
| **F-02** | `yellow_to_blue_slideshow`, `blue_orange_slideshow`, `orange_to_red_slideshow`, `red_purple_slideshow`, `intro_stroyline` | **P0** | Critical Build Failure: Invalid Next.js 15/16 `searchParams` union type on Page components | `.next/types/app/radio/page.ts(39,29)`, `forensics/page.ts(34,29)` | Page component types defined `searchParams?: Promise<{...}> \| {...}` which violates Next.js `PageProps` constraint | Transition apps fail Vercel deployment builds | All inter-zone transitions blocked on rebuild | None | Type `searchParams?: Promise<{ [key: string]: string \| string[] \| undefined }>` and `await` consistently | `npm run build` succeeds on Next.js 15/16 across all 5 repos |
| **F-03** | Central Hub (`Last_Dataset`) | **P0** | Live Supabase service role key invalid (`Unregistered API key`) | `scripts/verify-production-state.js` lines 243-247; PostgREST returns 401 | `.env` contains an `sb_secret_...` key (length 41) rather than a Supabase PostgREST service_role JWT | Database synchronization fails; live queries revert to local store | Progression and leaderboard not persistent across multi-instance serverless | Supabase Postgres | Update `.env` with genuine Supabase service_role JWT or configure Upstash Redis REST | `node scripts/verify-production-state.js` passes Section 6 |
| **F-04** | `yellowzone`, `red` | **P0** | Hardcoded central service token in public client bundles | `yellowzone/src/utils/supabaseSync.ts:4`, `red/index.html:3386, 3502, 3936` | Developers placed administrative `SERVICE_TOKEN` in client code to communicate with `/api/integrations/` | Any player opening DevTools can forge solve completions for any team | Complete compromise of competition score integrity | Central Hub | Remove service tokens from frontends; route all challenge solves through authoritative server endpoints | Source search confirms no service tokens in client bundles |
| **F-05** | `yellowzone` | **P0** | Client-side challenge verification bypassing server authority | `yellowzone/src/components/MainInvestigationPanel.tsx:172` | Frontend compares `flagInput === CANONICAL_FLAG` and directly notifies Hub with service token | Player can submit arbitrary text or invoke `recordYellowCtfSolve` directly from console | Scoring unearned points; fake solves | Central Hub | Implement server-side verification route on Central Hub or trusted API | Test with fake flag; verify rejection |
| **F-06** | `or_light` | **P1** | Blind success reporting on Orange completion network failure | `or_light/app/api/orange-zone/complete/route.ts:54-59` | Function returns `ok: true` regardless of `response.ok` from Central Hub | Player sees success animation and proceeds, but Hub has not awarded points or unlocked Red Zone | Score desynchronization; player stuck at Red Zone lock | Central Hub | Fail closed: return `502/500` if Hub rejects completion or request fails | Simulate Hub failure; verify client error response |
| **F-07** | Central Hub / `config/zones.json` | **P1** | Scoring and challenge contract mismatch for Orange and Red Zones | `config/zones.json:77-85, 98-106` vs `or_light/lib/challenges.ts` (4 sectors) and `red/index.html` (5 CTFs) | Central configuration defined single dummy CTF (`orange-01`, `red-01`) while zones run multi-challenge architectures | Admin overview and zone status report inaccurate challenge granularity | Confusion in scoring ledger audit | All zones | Reconcile canonical contract: Document Orange as 4-sector 600 pt clear and Red as 5-challenge 800 pt clear | Audit matches `CANONICAL_GAME_CONTRACT.md` exactly |
| **F-08** | `bluezone` | **P1** | Unauthenticated team impersonation fallback | `bluezone/src/features/blue-zone/server/auth.ts:114-135` | If launchToken is missing, server accepts raw `x-team-id` or `?team=` as valid session | Player can supply another team's ID in URL and submit flags on their behalf | Score theft / griefing between teams | Central Hub | Require verifiable launchToken or cryptographic session cookie | Request with forged `?team=` fails 401 |
| **F-09** | `PURPLEZONE_FRONTEND` vs In-Hub `/purple` | **P2** | Architectural split between standalone and in-hub Purple frontends | `PURPLEZONE_FRONTEND/index.html:9` vs `public/purple/purple.js` | Author created standalone Vite repo then redirected it to avoid cross-domain CORS/auth issues | Redundant repo; confusing deploy target | Maintenance overhead | Central Hub | Maintain canonical implementation in Central Hub (`public/purple`); ensure redirect in standalone preserves query | Loading standalone URL seamlessly preserves team & launch token |
| **F-10** | All frontends | **P2** | Lingering test team ID (`TECHTEAM10328`) purge logic | Occurs in 10+ files across repositories | Hardcoded test team used during prototyping was patched with ad-hoc purge blocks | Fragile state handling in `localStorage` / `sessionStorage` | Stale cache risks during live competition | Browser storage | Cleanly isolate session state by team ID; reject `TECHTEAM10328` as inactive | Verify test team cannot earn live points |

---

## 3. Detailed Forensic Analysis by Subsystem

### 3.1 Authentication & Cross-Zone Handoff
- **Launch Token Architecture:** The Central Hub implements HMAC-SHA256 launch tokens (`lib/security.js:signLaunchToken`) signed with `SESSION_SECRET`.
- **Vulnerability:** Several frontends (`bluezone`, `or_light`, `red`) accept unverified `?team=` query parameters when `launchToken` is absent, creating an identity spoofing risk if players share URLs.
- **Remediation:** Enforce that cross-application transitions carry and validate cryptographic launch tokens signed by Central Hub.

### 3.2 Challenge Adjudication & Scoring Authority
- **Yellow Zone:** Adjudication is performed entirely in browser JavaScript. The secret flag `FLAG{CONTINUITY_841_0217_UNIT404}` is in plain text inside `investigationData.ts`. A client-side fetch invokes `/api/integrations/zone-ctf-complete` with a leaked service token.
- **Blue Zone:** Implements trusted server-side adjudication in `app/api/ctf/verify/route.ts` against `CANONICAL_FLAGS` and notifies Central Hub via HMAC-signed completion.
- **Orange Zone:** Implements server-side SHA-256 verification in `app/api/verify-flag/route.ts` for each of the 4 sectors. However, completion handoff relies on a hardcoded service token.
- **Red Zone:** Implements 5 progressive CTFs. The client has local fallback adjudication with SHA-256 hashes and communicates via Central Hub proxy (`/api/ctf/verify`).
- **Purple Zone:** Strictly server-side evaluated on Central Hub (`lib/evaluator.js`). Requires 120 survivor predictions evaluated against hidden ground truth with $R^2 \ge 0.80$. Permanent escape lock is enforced.

### 3.3 Database & State Persistence
- **Supabase Status:** PostgREST rejected requests with `401 Unauthorized: Unregistered API key`.
- **Root Store Resilience:** Central Hub has dual-store capability (`lib/store.js`). When Supabase is unavailable, it gracefully operates via local store / Upstash Redis with distributed locking (`createLocalLock` / `createUpstashStore`), enabling all 43 test suites to pass.
- **Atomic Operations:** Supabase migrations (001-005) contain ACID-compliant stored procedures (`complete_zone_atomic`, `reserve_ml_attempt`, `finalize_qualifying_ml_submission`, `complete_challenge_idempotent`).

---

## 4. Minimal Safe Repair Sequence

1. **Phase 1: Canonical Contract Documentation** — Lock challenge IDs, scores, and transition URLs.
2. **Phase 2: Repair Transition Repositories** — Fix TypeScript `PageProps` union types in `yellow_to_blue_slideshow`, `blue_orange_slideshow`, `orange_to_red_slideshow`, `red_purple_slideshow`, and `intro_stroyline`.
3. **Phase 3: Repair Yellow Zone** — Copy missing datasets from `yellow_zone` to `yellowzone`, fix type definitions, and verify clean build.
4. **Phase 4: Secure Trust Boundaries** — Remove hardcoded service tokens from frontends; ensure all completions require proper authorization.
5. **Phase 5: Automated & End-to-End Testing** — Run comprehensive test matrix covering multi-team concurrency, prerequisites, and score idempotency.
6. **Phase 6: Deployment Verification** — Verify production configurations and prepare rollback procedures.
