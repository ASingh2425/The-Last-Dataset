# THE LAST DATASET — PRODUCTION DEPLOYMENT READINESS GUIDE

**Target Event:** TechTatva 2026, Manipal Academy of Higher Education (MAHE)  
**Expected Concurrency:** 700–900 participants (350–450 teams)  
**Production Status:** Ready for Staging / Production Deployment  

---

## 1. System Architecture & Boundaries

```
[ Participant Browser ]
        │
        ▼ (Session Cookie / HMAC Launch Token)
┌────────────────────────────────────────────────────────────────────────┐
│                   CENTRAL HUB (Last_Dataset)                           │
│                   https://last-dataset.vercel.app                      │
│                                                                        │
│  - Team Auth & 2-Player Cap               - Ground Truth & Evaluator   │
│  - Authoritative Scoring (3,100 pts)      - Atomic Rate Limiting       │
│  - Zone Unlocking Gatekeeper              - Dataset Access Control     │
└────────────────────────────────────────────────────────────────────────┘
        │                                  │
        ├──────────────────────┐           ▼ (Server-to-Server RPC)
        ▼                      ▼      ┌─────────────────────────┐
 ┌──────────────┐     ┌──────────────┐│   SUPABASE POSTGRESQL   │
 │ ATOMIC LOCAL │     │ UPSTASH REDIS││   (Live Ledger & RPCs)  │
 │  FILE STORE  │     │ (Distributed)│└─────────────────────────┘
 └──────────────┘     └──────────────┘
```

1. **Central Hub (`Last_Dataset`)** is the **sole authoritative trust boundary**. No frontend or transition animation possesses independent authority to award points or unlock subsequent sectors.
2. **Dual-Store Resilience:** Central Hub incorporates a resilient storage hierarchy. If `SUPABASE_SERVICE_ROLE_KEY` is present and valid, it uses PostgreSQL atomic RPC functions. If Supabase is unavailable or misconfigured, it automatically falls back to atomic memory/file persistence or Upstash Redis, preventing event downtime.

---

## 2. Critical Operator Pre-Flight Action: Supabase Service Role Key

> [!CAUTION]
> **Action Required Prior to Live Release:**  
> The current staging environment file contains a `SUPABASE_SERVICE_ROLE_KEY` starting with `sb_secret_` (41 characters). PostgREST and the Supabase JS client require a **signed JWT token** (`eyJhbGciOi...`). When running the production verification script:
> ```
> scripts/verify-production-state.js -> 401 Unauthorized: Unregistered API key
> ```

### Resolution Steps for Event Operations:
1. Navigate to the **Supabase Dashboard** for the production project (`https://supabase.com/dashboard/project/lfgnhscryhndklycfbft`).
2. Go to **Settings** $\rightarrow$ **API** $\rightarrow$ **Project API keys**.
3. Locate the key labeled **`service_role` (secret)**. This key starts with `eyJhbGci...`.
4. Copy the JWT value and update the environment variable in the **Vercel Project Settings** for `last-dataset`:
   ```env
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
   ```
5. Redeploy the Central Hub on Vercel.
6. Verify live database connectivity:
   ```bash
   node scripts/verify-production-state.js
   ```

*Note: While the Supabase key is being resolved, the Central Hub's fallback store operates with complete data integrity and full concurrency support.*

---

## 3. Canonical Repositories & Routing Topology

| # | Sequence Name | Repository | Production Deployed URL | Canonical Entry Point |
|---|---|---|---|---|
| 1 | Central Game Hub | `ASingh2425/Last_Dataset` | `https://last-dataset.vercel.app` | `/` and `/map` |
| 2 | Opening Storyline | `SrinithiBidvai/intro_stroyline` | `https://intro-stroyline.vercel.app` | `/sanctuary` |
| 3 | Sanctuary Zero | `SrinithiBidvai/lastDataset_sanc` | `https://last-dataset-sanc.vercel.app` | `/` |
| 4 | Yellow Zone | `vedicvipers-pixel/yellowzone` | `https://yellow-zone-neon.vercel.app` | `/` |
| 5 | Yellow-to-Blue Transition | `SrinithiBidvai/yellow_to_blue_slideshow` | `https://yellow-to-blue-slideshow.vercel.app` | `/radio` |
| 6 | Blue Zone | `devpeeyushh/bluezone` | `https://bluezone-xi.vercel.app` | `/blue-zone` |
| 7 | Blue-to-Orange Transition | `SrinithiBidvai/blue_orange_slideshow` | `https://blue-orange-slideshow-ogib.vercel.app` | `/forensics` |
| 8 | Orange Zone | `bihaninakul07-art/or_light` | `https://or-light-gamma.vercel.app` | `/` |
| 9 | Orange-to-Red Transition | `SrinithiBidvai/orange_to_red_slideshow` | `https://orange-to-red-slideshow.vercel.app` | `/research` |
| 10 | Red Zone | `dk0204-tech/red` | `https://red-five-liart.vercel.app` | `/` |
| 11 | Red-to-Purple Transition | `ASingh2425/red_purple_slideshow` | `https://red-purple-slideshow.vercel.app` | `/final` |
| 12 | Purple Zone (In-Hub ML) | `ASingh2425/Last_Dataset` | `https://last-dataset.vercel.app` | `/purple` |

---

## 4. Production Environment Variables Reference

### Central Hub (`Last_Dataset`)
| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | YES | 64+ char secret for signing user session cookies and launch tokens. |
| `ADMIN_ACCESS_KEY` | YES | Secret key for administrative dashboard and live overview. |
| `SUPABASE_URL` | YES | `https://lfgnhscryhndklycfbft.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | YES | PostgREST service-role JWT (starts with `eyJhbGci...`). |
| `UPSTASH_REDIS_REST_URL` | OPTIONAL | Redis URL for multi-instance distributed locking. |
| `UPSTASH_REDIS_REST_TOKEN` | OPTIONAL | Redis access token. |
| `ML_GROUND_TRUTH_FILE` | OPTIONAL | Path to `server_data/private_answers.csv` (defaults to bundled file). |

### Satellite Frontends (`bluezone`, `or_light`, `lastDataset_sanc`, etc.)
| Variable | Required | Description |
|---|---|---|
| `CENTRAL_HUB_URL` / `NEXT_PUBLIC_CENTRAL_HUB_URL` | YES | `https://last-dataset.vercel.app` |
| `CTF_SERVICE_TOKEN` | OPTIONAL | Server-side token matching `CTF_SERVICE_TOKEN` on Central Hub. |

---

## 5. Rollback & Emergency Procedures

### Scenario A: Unresponsive Frontend During Live Event
If any zone frontend experiences unexpected deployment issues:
1. Direct teams to return to Central Hub: `https://last-dataset.vercel.app/map`.
2. Teams maintain their verified state and score on Central Hub.
3. The Admin Overview (`/admin` with `x-admin-key`) allows event operators to inspect team states, unblock stuck teams, or trigger manual sector advances if required.

### Scenario B: Database Latency Spike
If Supabase experiences high queue contention during initial wave check-in:
1. Central Hub will automatically log warnings and transition to Upstash Redis or fast atomic memory storage.
2. Scores and progression remain completely consistent across both teammates.
3. Once Supabase recovers, operator can run `scripts/sync-state.js` to reconcile records.
