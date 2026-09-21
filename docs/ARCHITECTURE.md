# Jambu — Architecture

**Status:** Approved for P0
**Date:** 2026-09-21
**Source of truth:** `CLAUDE.md` (repo root)
**Decisions folded in:** D1–D10 (see `IMPLEMENTATION_PLAN.md` §5)

---

## 1. System Overview

```text
┌─────────────────────────── Chrome Extension (MV3) ───────────────────────────┐
│                                                                              │
│  service worker          content script           popup / onboarding /       │
│  ├─ activity tracker     └─ Care Card overlay     settings UI                │
│  ├─ idle detector           (shadow DOM)                                     │
│  ├─ sync + buffer                                                            │
│  ├─ alarms (fallback)                                                        │
│  └─ notification fallback                                                    │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │  HTTPS + user JWT
                                    ▼
┌──────────────────────────── Fastify API (Node + TS) ─────────────────────────┐
│  auth proxy · activity ingest · user state · preferences · pause · snooze    │
│  interventions · routines · data export / deletion                           │
│                                                                              │
│      builds CareContext ──► care-engine (pure) ──► CareDecision              │
│                                        │                                     │
│                            persona + message-templates (pure)                │
│                                        │                                     │
│                                   interventions row                          │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │  service-role key (server-side only)
                                    ▼
┌─────────────────────────────────── Supabase ─────────────────────────────────┐
│  PostgreSQL (schema below, RLS enabled)   ·   Supabase Auth (users, JWT)     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**The extension never talks to Supabase directly.** Every request goes through
the Fastify API. This is what keeps §32 ("the backend is authoritative") true
and makes D2's "keep privileged operations server-side" structurally
guaranteed rather than a convention.

---

## 2. Monorepo Layout

Per `CLAUDE.md` §7:

```text
jambu/
├── apps/
│   ├── extension/            # React + TS + MV3 + Tailwind
│   └── api/                  # Node + TS + Fastify
├── packages/
│   ├── care-engine/          # pure · deterministic · zero I/O
│   ├── routine-learning/     # pure · deterministic · zero I/O
│   ├── shared-types/         # API contracts + domain types
│   └── message-templates/    # persona registry + deterministic copy
├── database/
│   ├── migrations/
│   └── seed/
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md       # this file
│   ├── API.md
│   └── IMPLEMENTATION_PLAN.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── README.md
└── CLAUDE.md
```

---

## 3. The Purity Boundary

`care-engine` and `routine-learning` are **pure function packages**:

- no database access, no HTTP, no filesystem
- **no clock reads** — `currentTime` is an input on `CareContext`, never
  `Date.now()` read internally
- no randomness except via an injected selector

This is the single most important structural decision in the system. It is
what makes `CLAUDE.md` §27's test matrix — cooldown, snooze, dismissal, paused
user, DST boundaries, overlapping types — cheap to write, fast to run, and
genuinely deterministic (§13).

An ESLint rule bans `Date`, `Math.random`, `process`, and any I/O import
inside these two packages. Violating it fails CI.

---

## 4. Authentication and Key Handling (D2)

### 4.1 Key placement

| Key | Lives in | Never in |
|---|---|---|
| Supabase **service-role** key | `apps/api` env only | extension, client code, logs, git |
| Supabase **anon** key | `apps/api` env only | extension bundle |
| User **JWT** + refresh token | `chrome.storage` in the extension | logs, analytics |

The extension bundle contains **no Supabase keys of any kind**, because it
never calls Supabase. It only knows the Jambu API base URL. A build-time check
greps the built bundle for `supabase`, `service_role`, `SUPABASE_` and `eyJ`
prefixes and fails the build on a hit.

### 4.2 Auth flow

`CLAUDE.md` §23 defines `/api/auth/register|login|refresh`, so the API
**proxies** Supabase Auth rather than exposing it to the client:

```text
extension ──► POST /api/auth/login ──► supabase.auth.signInWithPassword()
extension ◄── { accessToken, refreshToken, expiresAt } ◄──
```

Subsequent requests carry `Authorization: Bearer <accessToken>`. The API
verifies the JWT, extracts the Supabase user id, and uses that as the
authorization subject for every query.

No password handling is implemented by us (§24).

### 4.3 RLS — and an honest note about it

RLS is enabled on every user-scoped table with `user_id = auth.uid()` policies,
per D2.

**However:** the API connects with the service-role key, which *bypasses RLS*.
So RLS is **defense-in-depth for any future direct-client access**, not the
mechanism protecting data today. The actual protection is the API's
per-request authorization, which scopes every query by the authenticated user
id (§31: "authorize every resource by user ID").

Stating this plainly so nobody later assumes RLS is covering a gap it isn't.
P3's test suite therefore asserts cross-user access returns 403 at the API
layer, independently of RLS.

---

## 5. Care Decision Flow (D4 — hybrid)

### 5.1 Primary path: activity-driven

Evaluation is triggered by data arriving, not by a timer:

```text
1. service worker closes an activity session (or buffer threshold reached)
2. POST /api/activity/session   { sessions: [...] }
3. API persists → rebuilds UserState → runs care-engine
4. if shouldIntervene → persist interventions row
5. the SAME response returns { pendingInterventions: [...] }
6. extension renders the Care Card immediately
```

The pending intervention rides back on the ingest response, so the common case
costs **zero extra requests and has no polling latency**.

### 5.2 Fallback path: `chrome.alarms`

A `chrome.alarms` tick (default 5 minutes) covers the cases the primary path
misses:

- the user has gone idle, so no activity is being posted, yet an end-of-day or
  lunch window has since opened
- an earlier sync failed and the buffer is draining under backoff (§26)
- the service worker was terminated mid-cycle

The alarm calls `GET /api/interventions/today` and renders anything unshown.

### 5.3 `setTimeout` is banned in the background

Per D4 and MV3 reality: the service worker is terminated after ~30s idle, and
pending `setTimeout` callbacks die with it. All persistent scheduling uses
`chrome.alarms`; all state lives in `chrome.storage`, never module scope. An
ESLint rule bans `setTimeout`/`setInterval` under `apps/extension/background/`.

---

## 6. Continuous Work (D6)

**Definition — used identically in the tracker, the API, the Care Engine and
the tests:**

> Continuous work is the current active session. An idle period of **≥ 10
> minutes** ends that session; gaps shorter than 10 minutes are bridged and do
> not reset the counter.

Consequences:

- `UserState.continuousWorkMinutes` measures only the *current* session.
- `lastBreakMinutesAgo` is the time since the end of the previous session.
- A closed browser is treated as **idle**, not `unknown`; `unknown` is reserved
  for "the extension has no recent signal at all" (e.g. first run after
  install).
- The constant lives once, in `shared-types`, as `IDLE_BREAK_THRESHOLD_MINUTES = 10`.
  No second copy anywhere.

---

### 6.1 Derived state — decisions settled in P5

These are properties of `GET /api/user/state` and of any later phase that
reads the same rows. P11 must stay consistent with them unless the data model
is deliberately changed.

- **Local-midnight attribution.** A session that straddles local midnight is
  attributed **wholly to the local day it started in**. Splitting it would mean
  distributing `activeSeconds` across the boundary, which the stored data does
  not support; no session splitting and no extra persistence was introduced to
  avoid that.
- **48-hour read window.** Sessions are read over 48 hours rather than 24. A
  local day can begin up to 14 hours either side of UTC midnight, and
  continuity reconstruction needs the sessions immediately preceding the
  window.
- **`activeSeconds` is the source of truth for minute totals**, never
  wall-clock duration. Seconds are summed first and converted once
  (decision D31).
- **An invalid stored timezone falls back to UTC** rather than failing the
  request and leaving the user with no state at all.
- **Overlapping sessions extend a run**, never shorten it: a session ending
  later than the run it joins carries the run's end forward.
- **Derivation is pure.** `services/user-state.ts` takes `now` as an input and
  must not gain database, clock, network or filesystem dependencies; the reads
  live in `services/user-state-repository.ts`.

---

## 7. Care Engine

### 7.1 Contract

Inputs (`CareContext`) and outputs (`CareDecision`) are exactly as specified in
`CLAUDE.md` §13. The engine decides **whether** to intervene; it never decides
wording (§8).

### 7.1.1 `CareContext` — approved extension (P1)

`CLAUDE.md` §13 presents an *example* interface. It has no way to express
several rules the approved decisions require, and because the engine is pure
(§3) anything it must know has to arrive as an input. The following fields were
added and **approved after P1**:

| Field | Required by |
|---|---|
| `isPaused`, `pausedUntil` | §14 "User paused Jambu −100"; D5 |
| `snoozedUntilByType` | §14 "Recent snooze −20"; §17; D5 per-type scoping |
| `lastDismissalByType` | §14 "Recent dismissal −25" |
| `consecutiveDismissalsByType` | §17 "reduce frequency after repeated dismissals" |
| `lastHydrationConfirmation` | D7 "no recent hydration confirmation" |
| `workHours` | D7 end-of-day fires after the *learned* work-end, not the onboarding preference |

`UserState.lunchWindow.source` (`'default' | 'learned'`) is approved alongside
these, so the D8 fallback window can never be mistaken for a learned pattern.
The dedicated time primitives in `packages/shared-types/src/time.ts` —
`IsoTimestamp`, `TimeOfDay`, `IanaTimeZone` — are approved for the same reason:
they keep UTC instants and local wall-clock times from being confused.

The standing requirement is unchanged and absolute: **the Care Engine must not
touch the database, the clock, browser APIs, the network, the filesystem,
randomness, or persona state.** Every one of those arrives through
`CareContext`, and the ESLint rules in §3 fail the build if the engine reaches
for any of them directly.

### 7.2 Scoring (§14)

Weights live in one editable config object, `packages/care-engine/src/config/scoring.ts`:

```text
Lunch window active                 +30
Continuous work > 120 minutes       +25
Continuous work > 180 minutes       +20
Historical pattern confidence       +20
User currently active                +10
No recent intervention              +10

Recent intervention                 -20
Recent dismissal                    -25
Recent snooze                       -20
Outside normal work period          -30
User paused Jambu                  -100

0–39  → do not intervene
40–69 → monitor
70+   → intervene
```

These are starting points, not product truth (§14). Every intervention row
persists the `score` and `reason` that produced it, so tuning is driven by beta
data rather than intuition.

### 7.3 Type-specific rules

**Lunch (D8).** Requires a lunch window, significant continuous activity, the
user active, no lunch confirmation today, and no recent intervention — never
the clock alone (§15).

Default window for users with insufficient data: **12:30–14:30 local**,
confidence `0`, source `default`. It is explicitly a fallback: once routine
learning reaches ≥3 observations the learned window takes over, and the
`source` field on the window records which one was used so this never silently
becomes a permanent schedule.

**Break.** Continuous work exceeding the learned break interval (or the
default threshold before learning), user active, not recently intervened.

**Hydration (D7) — conservative.** All of the following must hold:

- the user has **opted in** (`hydration_enabled`; **off by default**)
- meaningful continuous activity in the current session
- no hydration confirmation within the recent window
- the user is currently active
- Jambu is not paused

Messages ask a question; they never assert a physical state. "Have you had some
water?" — never "You are dehydrated" (§40).

**End of day (D7).** All of the following:

- current local time is **after the learned work-end time**
- the user has continued working **≥ 30 minutes beyond** that time
- the user is active
- Jambu is not paused

Gentle language only; no medical claims.

### 7.3.1 Type-specific scoring signals (decision D41)

CLAUDE.md §14 gives an explicit positive signal only to lunch, which left
hydration and end-of-day unable to reach the threshold of 70 at all. Two
weights were added, surfaced and approved before implementation:

| Signal | Weight | Earned when |
|---|---|---|
| `hydrationGatePassed` | **+20** | the hydration eligibility gate passes |
| `endOfDayGatePassed` | **+40** | the end-of-day eligibility gate passes |

They are scoring signals, never standalone triggers: the type's own gate must
pass first, and every gate already requires sustained activity, so neither can
turn a clock-only context into an intervention.

The global threshold stays at **70**; there are no per-type thresholds, and the
`−30` outside-work-hours penalty still applies to end-of-day. Break receives no
new bonus and reaches the threshold only once a break pattern has been learned
(P11), which is accepted.

Resulting maxima: **lunch 115 · break 85 (65 before learning) · hydration 85 ·
end-of-day 75.** End-of-day and hydration do not also earn the
historical-confidence term; end-of-day's learned work end is what its own +40
already rewards.

### 7.3.2 Known limitation — "lunch confirmed today" (decision D42)

The engine is pure and has no timezone database (§3, D39), so it cannot compute
a local day. It treats a `lastLunchConfirmation` at or after today's resolved
`lunchWindow.start` as a confirmation made today.

A confirmation earlier on the same local day but before the window opened is
therefore not recognised, and Jambu may ask again. The error is in the safe
direction — an extra question, never a suppressed one. Closing it properly
would require a caller-resolved `localDayStart` on `CareContext`; that is a
shared-types change and has **not** been made.

### 7.4 Overlap and cooldown

At most one intervention is live at a time. When several types qualify, the
highest score wins; ties break by a fixed priority (lunch > end-of-day > break
> hydration). Cooldowns are enforced **both** in the engine and again in the
API (P7), because the API is authoritative.

---

## 8. Persona Abstraction (D10)

MVP ships exactly one persona: `"mom"`. It is **not hard-coded**.

```text
care-engine  ──►  CareDecision { interventionType, score, reason }
                        │        ← no persona awareness whatsoever
                        ▼
message-templates:  resolve(personaId, interventionType, locale) ──► string
```

- The Care Engine has **no knowledge of personas** and never imports the
  message package. Adding a persona therefore cannot require an engine change,
  which is the actual requirement in D10.
- `message-templates` exposes a registry: `PersonaId → { [interventionType]: string[] }`,
  plus avatar asset id, signature (`— Mom ❤️`), and tone metadata.
- `user_preferences.persona` selects the registry entry, defaulting to `'mom'`.
- `interventions.persona` records which persona actually spoke, so later
  analysis can compare personas without guesswork.

**No additional personas are built now.** The registry simply has one entry.

---

## 9. Care Card Delivery (D3)

### 9.1 Primary — content script overlay

The Care Card is a **shadow-DOM overlay injected via `chrome.scripting`** into
the active tab. Shadow DOM isolates Jambu's styles from the host page and the
host page's styles from Jambu.

Per §19: compact, soft neutral background, rounded corners, subtle shadow,
warm avatar, restrained emoji, never a full-screen modal, never covering a
significant portion of the screen. Accessible: focus trap, Escape to dismiss,
visible focus rings, `prefers-reduced-motion` respected, WCAG AA contrast.

**The content script is render-only.** It receives a message containing the
card text and returns the user's response. It never reads the DOM, never reads
page text, and sends nothing about the page back to the service worker or the
API (§9).

### 9.2 Fallback — native notification

When no injectable tab exists — `chrome://` pages, the Chrome Web Store, PDF
viewer, no focused window — the service worker falls back to
`chrome.notifications`. This path is tested, not incidental. It loses the §19
styling, which is precisely why it is the fallback and not the default.

### 9.3 Permissions (D3 — documented and minimized)

| Permission | Why it is needed | Why it cannot be narrower |
|---|---|---|
| `storage` | Activity buffer, auth tokens, last-sync timestamp, notification state (§25) | No alternative persistent store survives service-worker termination |
| `alarms` | D4 fallback evaluation; MV3 kills `setTimeout` | Required by the MV3 lifecycle |
| `idle` | Session boundaries and the D6 ≥10-minute rule | No other API reports OS-level idle |
| `scripting` | Inject the Care Card on demand | Narrower than a static all-frames content script: injection happens only at the moment of an intervention |
| `notifications` | §9.2 fallback delivery | Only used when injection is impossible |
| `host_permissions: <all_urls>` | (a) read the active tab's **domain** for activity attribution; (b) inject the Care Card wherever the user is working | See below |

**Deliberately NOT requested:** `tabs`, `history`, `webRequest`, `cookies`,
`downloads`, `clipboardRead`, `clipboardWrite`, `bookmarks`, `management`,
`debugger`, `nativeMessaging`.

Note on `tabs`: it is **not requested**, because `host_permissions` already
grants the tab URL visibility we need. Requesting both would be redundant
permission surface.

Note on `<all_urls>`: this is the one broad permission, and it is broad because
the Care Card must be able to appear wherever the user actually works.
Mitigations that keep §9's privacy promise intact:

- the URL is reduced to its **registrable domain in the service worker and the
  full URL is discarded immediately**; the path and query never enter a
  variable that outlives the handler and never reach storage or the network
- the injected script is render-only (§9.1)
- a manifest permission **snapshot test** fails the build if this list ever
  widens without review

Chrome Web Store publication is not a current blocker (private beta), but this
table is maintained now so the listing and privacy policy are a transcription
job later, not an archaeology job.

---

## 10. Privacy Architecture (§9)

**Jambu knows how long the user has been working, not what they are working on.**

Collected: active browser state, active **domain** (never full URL),
timestamps, session duration, idle state, aggregated activity duration,
intervention history, preferences, routine statistics.

Never collected: keystrokes, passwords, page contents, email contents, private
messages, form inputs, screenshots, clipboard, document contents, credentials.

Enforced by tests, not by review checklist:

1. **P4** — the API rejects or strips any activity payload containing a path or
   query string.
2. **P14** — an assertion over every emitted analytics payload proves no
   domain, URL, page content, email or token is present.
3. **P15** — a privacy audit test walks the schema and asserts no column
   matching the §9 forbidden list exists.

Data minimization: aggregated sessions, never raw event streams.

---

## 11. Database Design

Supabase PostgreSQL. All timestamps are `TIMESTAMPTZ` stored in UTC (§28);
all user-facing time reasoning converts to the user's IANA timezone.

Per D5, pause, snooze and deletion are **separate concerns with their own
tables** — not extra columns bolted onto `user_preferences`.

### 11.1 `users`

Mirrors the Supabase Auth user. Supabase owns credentials; this row holds
profile and timezone.

```sql
id          UUID PRIMARY KEY,          -- equals auth.users.id
email       VARCHAR NOT NULL,
name        VARCHAR,
timezone    VARCHAR NOT NULL DEFAULT 'UTC',   -- IANA, e.g. 'Asia/Kolkata'
created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
deleted_at  TIMESTAMPTZ                       -- soft delete (§42)
```

### 11.2 `user_preferences`

Stable user choices only. **No pause or snooze state here** (D5).

```sql
id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id           UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
work_start        TIME NOT NULL,
work_end          TIME NOT NULL,
lunch_enabled     BOOLEAN NOT NULL DEFAULT true,
break_enabled     BOOLEAN NOT NULL DEFAULT true,
hydration_enabled BOOLEAN NOT NULL DEFAULT false,  -- opt-in per D7
end_day_enabled   BOOLEAN NOT NULL DEFAULT true,
persona           VARCHAR NOT NULL DEFAULT 'mom',  -- D10
created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
```

`hydration_enabled` defaults to **false** — D7 requires hydration to be opt-in.

### 11.3 `activity_sessions`

```sql
id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
started_at     TIMESTAMPTZ NOT NULL,
ended_at       TIMESTAMPTZ NOT NULL,
active_seconds INTEGER NOT NULL CHECK (active_seconds >= 0),
domain         VARCHAR,                      -- registrable domain ONLY
client_session_id UUID NOT NULL,             -- extension-generated, for idempotent retry
created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
CHECK (ended_at >= started_at),
UNIQUE (user_id, client_session_id)           -- makes §26 retries safe
```

`client_session_id` exists because §26 requires the extension to buffer and
retry; without it, a retried batch would duplicate rows and inflate
`continuousWorkMinutes`.

### 11.4 `routine_patterns`

```sql
id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
pattern_type VARCHAR NOT NULL,     -- 'lunch' | 'work_start' | 'work_end' | 'break_interval'
day_of_week  INTEGER CHECK (day_of_week BETWEEN 0 AND 6),   -- NULL = all days
start_time   TIME,
end_time     TIME,
confidence   DECIMAL(3,2) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
sample_count INTEGER NOT NULL DEFAULT 0,
updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
-- Decision D13, verified on PostgreSQL 17.6.
UNIQUE NULLS NOT DISTINCT (user_id, pattern_type, day_of_week)
```

`NULLS NOT DISTINCT` is load-bearing, not cosmetic. `day_of_week IS NULL`
means "all days", and under Postgres' default `NULLS DISTINCT` this constraint
would permit unlimited duplicate all-day rows for the same pattern type —
exactly the case it exists to prevent. It requires PostgreSQL 15 or newer; the
local Supabase stack provides **17.6**, so the partial-index fallback offered
under D13 is not needed and was not used.

### 11.5 `interventions`

```sql
id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
type         VARCHAR NOT NULL,     -- 'lunch'|'break'|'hydration'|'end_of_day'
trigger      VARCHAR NOT NULL,     -- 'activity_sync' | 'alarm_poll'  (D4 path)
persona      VARCHAR NOT NULL DEFAULT 'mom',        -- D10
message      TEXT NOT NULL,
score        INTEGER NOT NULL,                      -- §13 explainability
reason       TEXT NOT NULL,                         -- §13 explainability
delivery     VARCHAR,              -- 'care_card' | 'notification'  (D3 path taken)
shown_at     TIMESTAMPTZ,
expires_at   TIMESTAMPTZ NOT NULL,                  -- drives 'expired' (§18)
response     VARCHAR CHECK (response IN
               ('confirmed','not_yet','snoozed','dismissed','expired')),
responded_at TIMESTAMPTZ,
created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

`score` and `reason` are mandatory: §13 requires the engine be **explainable**,
and R4 (wrong weights) is only tunable if every decision recorded its own
arithmetic.

### 11.6 `pause_states` (D5 — new)

Current pause state, one row per user.

```sql
user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
paused_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
paused_until TIMESTAMPTZ,          -- NULL = paused indefinitely
source       VARCHAR NOT NULL DEFAULT 'user',
updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

Absence of a row means "not paused". This drives the §14 `−100` term and the
§42 pause requirement — neither of which had anywhere to live in the original
§22 schema.

### 11.7 `intervention_snoozes` (D5 — new)

Snooze is **per intervention type**, so snoozing lunch does not silence breaks.

```sql
id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
type          VARCHAR NOT NULL,
snoozed_until TIMESTAMPTZ NOT NULL,
source_intervention_id UUID REFERENCES interventions(id) ON DELETE SET NULL,
created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
UNIQUE (user_id, type)
```

### 11.8 `deletion_requests` (D5 — new)

Auditable record that a deletion happened, holding **no personal data**.

```sql
id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id      UUID NOT NULL,        -- deliberately NOT a FK: survives account deletion
scope        VARCHAR NOT NULL CHECK (scope IN ('activity','account')),
status       VARCHAR NOT NULL CHECK (status IN ('pending','completed','failed')),
requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
completed_at TIMESTAMPTZ
```

`user_id` intentionally has no foreign key: the audit row must outlive the
account it refers to, and it contains nothing but an opaque id.

### 11.9 Indexes

Per §22 ("do not create excessive indexes without evidence"):

```sql
CREATE INDEX ON activity_sessions (user_id, started_at DESC);
CREATE INDEX ON interventions     (user_id, shown_at DESC);
CREATE INDEX ON interventions     (user_id, type, created_at DESC);
```

Primary keys and unique constraints supply the rest. Nothing further is added
without a measured query to justify it.

Two index paths this section previously listed as separate statements —
`routine_patterns (user_id, pattern_type, day_of_week)` and
`intervention_snoozes (user_id, type)` — **already exist**, created
automatically by the unique constraints on those tables. Declaring them again
would build a second identical B-tree on the same columns for no benefit, which
§22 forbids. The index paths are unchanged; only the statement that creates
them is.

### 11.10 RLS

Enabled on `users`, `user_preferences`, `activity_sessions`,
`routine_patterns`, `interventions`, `pause_states`, `intervention_snoozes`.
Policy shape: `USING (user_id = auth.uid())`. `deletion_requests` is
service-role only. See §4.3 for what this does and does not protect.

---

## 12. Error Handling and Offline Behaviour (§26)

A backend outage must not break the extension.

```text
sync fails → keep aggregated sessions in chrome.storage
           → exponential backoff (30s, 1m, 2m, 5m, 15m, cap 30m)
           → chrome.alarms drives the retry, never setTimeout
           → buffer capped; oldest aggregated sessions evicted first
           → on recovery, flush in order; client_session_id makes it idempotent
```

The Care Card continues to render any intervention already delivered. Jambu
degrades to silence, not to malfunction.

---

## 13. Timezone Handling (§28)

- Store UTC everywhere.
- Store the user's IANA timezone on `users.timezone`, auto-detected at
  onboarding via `Intl.DateTimeFormat().resolvedOptions().timeZone`, and
  overridable.
- Convert to local time before evaluating lunch windows, work hours,
  end-of-day, daily totals and routine patterns.
- One conversion module, `apps/api/src/lib/timezone.ts`. The Care Engine
  receives already-converted values — it never does timezone maths itself,
  which keeps it pure.
- Explicit tests for DST transitions and half-hour offsets (`Asia/Kolkata`).

---

## 14. What This Architecture Does Not Include

Per §37: no desktop or mobile app, no voice, no chatbot, no wearables, no
nutrition or calorie data, no medical recommendations, no gamification or
streaks, no social or team features, no productivity analytics, no payments,
and **no LLM anywhere in the decision path** (§21).
