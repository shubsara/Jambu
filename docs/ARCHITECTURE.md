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


### 7.5 Intervention lifecycle constants (P7)

| Constant | Value | Decision |
|---|---|---|
| `INTERVENTION_EXPIRY_MINUTES` | **30** | D50 — how long a care card stays answerable |
| `INTERVENTION_SNOOZE_MINUTES` | **30** | D51 — how long "remind me later" silences that type |

Both live in `apps/api/src/config.ts` and are environment-overridable; neither
appears as a literal anywhere else.

**Snooze is per intervention type only.** Snoozing lunch must not silence
breaks, hydration or end-of-day. A `snoozed` response upserts one row in
`intervention_snoozes` keyed `(user_id, type)`, and that row feeds the existing
Care Engine suppression path via `CareContext.snoozedUntilByType` — there is no
separate cooldown mechanism for snoozes, so exactly one place decides when
Jambu stays quiet.

Expiry is applied lazily at the start of `POST /api/interventions` and
`GET /api/interventions/today`. It is idempotent: the update matches only
unanswered rows already past their deadline, so a second sweep changes nothing.
No scheduler is introduced.

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
interval_minutes INTEGER,          -- decision D77: break_interval only
confidence   DECIMAL(3,2) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
sample_count INTEGER NOT NULL DEFAULT 0,
updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
-- Decision D13, verified on PostgreSQL 17.6.
UNIQUE NULLS NOT DISTINCT (user_id, pattern_type, day_of_week)
```

A `break_interval` is a **duration**, not a time of day, and decision D77
gives it its own column rather than smuggling it into `start_time`/`end_time`.
Two check constraints keep the two shapes from mixing:

```sql
-- routine_patterns_shape_is_coherent
(pattern_type = 'break_interval'
   and interval_minutes is not null and start_time is null and end_time is null)
or (pattern_type <> 'break_interval' and interval_minutes is null)

-- routine_patterns_interval_minutes_positive
interval_minutes is null or interval_minutes > 0
```

The first is what makes the old span encoding (`'00:00'`-`'01:30'` meaning
ninety minutes) impossible to insert, and an interval longer than a day
expressible at all.

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

---

## 14.1 Activity Tracking in the Extension (P9 decisions)

Decisions D60-D66, settled before implementation.

| # | Decision |
|---|---|
| **D60** | `<all_urls>` is added for **domain attribution only**. `scripting` is *not* added; it arrives with the Care Card in P10. |
| **D61** | A domain change **closes** the current session and **opens** a new one, so every stored session has exactly one domain. |
| **D62** | `chrome.idle` detection threshold is **60 seconds**. D6's 10-minute continuity rule stays authoritative in P5 derivation and is **not** duplicated or redefined in the tracker. |
| **D63** | P9 **ignores** `pendingInterventions` on the sync response - it neither stores nor notifies. P10 owns intervention presentation. |
| **D64** | Flush when the buffer reaches **20 sessions** or on a **5-minute** `chrome.alarms` tick, whichever comes first. No `setTimeout` in background code. |
| **D65** | Buffer cap **500 sessions**, oldest-first eviction. |
| **D66** | Only `http`/`https` URLs produce a domain. Other schemes produce a **domain-null** session; the original URL is never persisted. |

### Bounded data loss (D65)

The buffer holds 500 sessions - the same ceiling as the API's batch maximum, so
a full buffer is always expressible as one request. Eviction is oldest-first
and **only** occurs once the backlog exceeds 500 unsynced sessions. Within that
bound there is no loss: the 30-minute backend-outage acceptance case must
demonstrate every session surviving and syncing on recovery.

### Implementation notes settled during P9

Four behaviours that fell out of implementation rather than from a numbered
decision. Recorded so they are choices on the record, not accidents.

**Sub-second sessions are dropped.** Rapid tab switching would otherwise
produce a stored row per flicker, none of which represents work. A session
shorter than one second is discarded rather than buffered.

**Sessions longer than 24 hours are dropped, not clamped.** `POST
/api/activity/session` refuses anything beyond
`MAX_ACTIVE_SECONDS_PER_SESSION` (decision D25), so such a session could never
be accepted; keeping it would mean retrying a request that can only ever fail.
This arises when the worker sleeps through a machine suspend. Clamping was
rejected because a fabricated duration would quietly corrupt
`continuousWorkMinutes`, which every Care Engine decision reads.

**An HTTP 400 discards the affected batch.** A validation failure is permanent
— the same payload will be refused every time — and leaving it buffered would
block every later, valid session behind it. The count is returned to the
caller; nothing about the content is logged. Transient failures (429, 5xx,
network) are *not* discarded: those stay buffered and wait for the next alarm.

**`syncBufferedActivity` accepts injectable `ApiClientDeps`.** This is a
testability improvement, not a product behaviour change: it lets tests exercise
the bounded backoff without waiting out the real schedule. Production callers
pass nothing and get the real `fetch`, `sleep` and clock.

### Privacy boundary (CLAUDE.md §9)

The hostname is extracted **inside the tab-event handler** and the full URL is
discarded there. It never enters `chrome.storage`, never crosses the network,
and is never logged - along with page titles and page content. `POST
/api/activity/session` remains the final boundary: decision D23 makes it reject
any payload carrying a path, query or fragment, so a leak fails loudly rather
than silently persisting.

---

## 14.2 Care Card Delivery (P10 decisions)

Decisions D67-D76, settled before implementation.

| # | Decision |
|---|---|
| **D67** | Inject only into the **active tab of the focused window**. If injection fails or the page is uninjectable, fall back to `chrome.notifications`. **Never hunt for another tab** - a card on a page the user is not looking at is worse than no card. |
| **D68** | Fixed bottom-right, ~320px wide, auto height, 16px inset. Compact, never full-screen. Dismissible by Escape or a close control. |
| **D69** | The card persists until answered or the tab navigates. **No auto-dismiss, and no fabricated `expired` response.** The server-side 30-minute expiry (D50) stays authoritative. |
| **D70** | **Deferred.** `shown_at` keeps its creation-time semantics; no API change and no new endpoint. See the P14 carry-forward below. |
| **D71** | **Do not steal focus on render.** A focus trap engages only once the user interacts with the card. Escape dismisses when focus is inside it. |
| **D72** | Navigation removes the card with the page. It is **not** re-injected on navigation; the intervention stays unanswered and may resurface through the fallback poll. |
| **D73** | The D4 fallback poll reuses the **existing 5-minute alarm**. No second alarm, no new cadence constant. |
| **D74** | Deduplicate by intervention id in `chrome.storage`, cleared on response and pruned after the 30-minute expiry window, so the registry cannot grow without bound. |
| **D75** | The card's CSS is built as a **separate asset** and adopted into the shadow root, preserving the project's styling architecture. |
| **D76** | **Manual Chrome acceptance is required.** P10 is not complete on automated tests alone. |

### Why focus is not stolen (D71)

A focus trap is an accessibility requirement, but grabbing focus from someone
mid-sentence is exactly the interruption CLAUDE.md §3.1 warns against. The card
therefore renders inert: it is reachable by keyboard, and the trap engages only
once the user has chosen to interact with it.

### Render-only content script (CLAUDE.md §9)

The injected script receives the text to display and returns the user's answer.
It never reads the DOM, page text, selection, form state, title, URL or any
page metadata, and the message it sends back carries **only** an intervention
id and a response value. No page information reaches storage, a log line or
the API.

## 14.3 Routine Learning (P11 decisions)

Decisions D77-D84, settled before implementation.

| # | Decision |
|---|---|
| **D77** | A break interval is stored in its own `interval_minutes INTEGER` column. **Durations are never encoded as time spans**, so an interval longer than a day is expressible and the two shapes cannot be confused. |
| **D78** | Lunch is learned from the **longest idle gap inside the midday search window** (11:00-15:00 local), at most one observation per day, gaps under 15 minutes ignored. |
| **D79** | Learning reads a rolling **28-day** window of activity. Older behaviour is allowed to fall out of the picture. |
| **D80** | Patterns are learned **across all days** (`day_of_week IS NULL`). Per-weekday learning is deferred; the schema already allows it. |
| **D81** | Confidence is a function of sample count alone: `insufficient` 0, `low` 0.4 (3+), `medium` 0.65 (8+), `high` 0.85 (15+). |
| **D82** | Windows are built from the **median**, not the mean, so one unusual day cannot drag the learned time. Treated as a representative-data acceptance test, not a universal mathematical guarantee. |
| **D83** | Recalculation is **lazy and best-effort**, triggered on activity ingest when the stored patterns are more than 24 hours old. **No scheduler.** A learning failure never fails the ingest. |
| **D84** | Work start and end are the **medians of each day's first start and last end**, stored as degenerate windows. |

### The learning package sees no domains (CLAUDE.md §9)

`packages/routine-learning` receives only `{ localDay, startMinute, endMinute }`
per run. It has no domain, no URL, no session id and no user id, and the API
layer's query deliberately selects only `started_at, ended_at, active_seconds`.
The package cannot leak what it was never given, and a test asserts the
observation object has exactly those three keys.

### Why learning is lazy rather than scheduled (D83)

A scheduler would be a second source of truth about when work happens, and a
second thing to operate. Recalculation instead rides the traffic that already
exists: an activity sync checks whether the stored patterns are stale and, if
so, recomputes them before the decision step. Staleness is read from
`max(routine_patterns.updated_at)`, so no extra column and no second migration
was needed.

The ingest is authoritative. If recalculation throws, the batch is still
accepted and a `routine_recalculation_failed` line is logged — the same
best-effort shape P7 and P9 use.

### What counts as an observation

Lunch and work hours are counted **per day**; a break interval is counted **per
run**. Three days of split work therefore yields three lunch observations but
six break observations, and the two cross the D81 threshold at different times.

### P11 manual acceptance checklist

Automated coverage is the gate here - P11 has no new user-visible surface, so
unlike P8 and P10 this checklist is a confirmation, not a separate approval.
With `pnpm db:start` running and the API up:

1. **A new account learns nothing.** `GET /api/routines` returns `{"patterns": []}`.
2. **Three days of split work produce a lunch window.** Seed three days with a
   midday gap, `POST /api/routines/recalculate`, and confirm a `lunch` pattern
   whose `start`/`end` bracket the median gap, `tier: "low"`, `sampleCount: 3`.
3. **User state flips source.** `GET /api/user/state` reports
   `lunchWindow.source: "default"` before recalculation and `"learned"` after.
4. **Break interval is a duration.** The `break_interval` row has a positive
   `interval_minutes` and `NULL` `start_time`/`end_time`.
5. **The old encoding is rejected.** Inserting a `break_interval` row with
   `start_time`/`end_time` fails on `routine_patterns_shape_is_coherent`.
6. **Recalculation is idempotent.** Running it three times leaves the same rows
   and the same row count.
7. **Lazy recalculation fires.** A fresh activity sync on a user with stale
   patterns updates them; a sync minutes later does not.
8. **Ingest survives a learning failure.** Activity is still accepted with
   `accepted: 1` and the session is stored.
9. **No domain leaks.** The `GET /api/routines` body contains no hostname.

Checks 1-9 are all covered by `apps/api/tests/routines.integration.test.ts`;
running `pnpm test:api` exercises every one against the live stack.

---

## 14.4 Onboarding (P12 decisions)

Decisions D85-D95, settled before implementation.

| # | Decision |
|---|---|
| **D85** | Onboarding renders as its **own page**, opened with `chrome.tabs.create` on install. No new permission: `chrome.tabs.create` does not require `tabs`, so D3 minimization holds. |
| **D86** | Completion is **server-side**: `users.onboarding_completed_at TIMESTAMPTZ`. It survives reinstall and reaches a second device. |
| **D87** | The **full registration form** ships in onboarding, retiring the §15.3 curl workaround. |
| **D88** | **Work hours are not asked.** CLAUDE.md §3.2 forbids making the user schedule their own behaviour, and D84 already learns work start and end from activity. Asking would collect something Jambu overwrites within days. |
| **D89** | Hydration is **one toggle among the four, default OFF** (D7). Not a separate persuasion step. |
| **D90** | `timezone` is added to **`PUT /api/preferences`** rather than a new user endpoint. §13 promises an overridable timezone and nothing could change `users.timezone` after registration; this closes that gap with the smallest contract change. `API.md` §6 is updated accordingly. |
| **D91** | Registration keeps writing **09:00-18:00** defaults, so an abandoned onboarding still leaves a usable preferences row. |
| **D92** | Onboarding is **skippable**, and partial progress lives in `chrome.storage`. The popup offers a path back to finish it. |
| **D93** | **Activity tracking is gated on completion.** Signing in is not consent to be observed; finishing onboarding is. Skipping leaves tracking off. |
| **D94** | `PRD.md` §6 is expanded with the actual onboarding requirements, discharging the stub's own "to be written out before P12". |
| **D95** | "Under two minutes" is made falsifiable as **<=5 steps and <=5 required inputs**, asserted in tests, plus a stopwatch reading during Chrome acceptance. |
| **D96** | The **signed-out popup exposes a secondary "Create account" action** that opens the onboarding page via `openOnboarding()`. Registration stays exclusively inside that page — the form is never duplicated in the popup. Without this, registration is unreachable once the install-time tab is closed. |

### Why onboarding asks so little (D88, D89)

The flow collects a timezone and four toggles. That is the whole of it.

Every question onboarding could ask about *when* the user eats, drinks, breaks
or stops is a question P11 answers better from observed behaviour, and §3.2
exists to stop Jambu becoming the scheduling chore it is meant to replace. The
09:00-18:00 default (D91) is a bootstrap, not a claim about the user; D84
replaces it once three days of activity exist.

### The §3.2 guard is a type, not a string scan

The primary invariant is structural: the onboarding state machine's type and
the `PUT /api/preferences` payload type admit **no** lunch, water, break or
work-schedule field, so such a question cannot be wired to anything. A
rendered-text scan runs as a secondary guard, because a schema cannot catch a
question asked and thrown away.

### Onboarding state on the wire (A1, A2)

D86 makes completion server-side, and D93 makes the service worker depend on
it, so the extension must be able to read it after a reinstall or on a second
device. Two resolutions, both inside `API.md` §6 and neither adding an
endpoint (constraint 4):

- **A1** — `GET /api/preferences` returns `onboardingCompletedAt`
  (ISO 8601 or `null`).
- **A2** — `PUT /api/preferences` accepts an explicit
  `onboardingCompleted: true`. Completion is **never inferred** from an
  ordinary preference update: a P13 settings edit by a user who never
  onboarded must not silently switch tracking on. Setting it twice is
  idempotent — the first timestamp wins and is not overwritten.

### Registration without a session (A3)

Supabase returns a created user and **no tokens** when email confirmation is
enabled, so `POST /api/auth/register` answers `201 { user }` alone. Onboarding
then stops and asks the user to verify their email and sign in. Progress is
already in `chrome.storage` (D92), so signing in resumes at Step 3 rather than
starting over. This is the P3/P8 carry-forward finally discharged.

### Grandfathering existing accounts (A4)

The migration backfills **every existing user** to
`onboarding_completed_at = now()`, then leaves the column NULL-by-default for
everyone created afterwards:

```sql
alter table public.users add column onboarding_completed_at timestamptz;
update public.users set onboarding_completed_at = now()
  where onboarding_completed_at is null;
```

Without the backfill, D93 would silently switch off tracking for every P8-P11
beta account the moment P12 shipped. Those users consented in the pre-P12
world; a new column is not a reason to revoke it. **Newly registered users get
NULL** and must complete onboarding explicitly — the `update` runs once, at
migration time, and never again.

### Consent precedes observation (D93)

Tracking starts on completion, never on sign-in. The consequence is deliberate:
a user who skips onboarding has a working popup, a real account and a Jambu
that watches nothing at all (A5, confirmed). The popup carries the way back.

### What onboarding collects (A6)

A timezone and four toggles. **`users.name` is deliberately not collected**:
the persona signs "- Mom", and a grep of `message-templates` and `care-engine`
finds no consumer for a user's name. Storing it would be personal data with no
purpose, which CLAUDE.md §9 forbids. The column stays, nullable, for anyone
registering through the API directly.

---

### Registration has to survive a closed tab (D96)

D85 opens onboarding on install, and D87 put the registration form there. What
neither said is how someone reaches that form *afterwards*. Until D96 the only
automatic entry was `chrome.runtime.onInstalled` with `reason === 'install'`,
and the popup's "Finish setup" button renders only when the user is **already
signed in** — so a signed-out user with the install tab closed had no route to
registration at all, and the §15.3 curl workaround that D87 set out to retire
was quietly still the only way in.

The popup therefore offers "Create account" beside "Sign in". It opens the
onboarding page rather than asking for credentials itself: one registration
form, in one place, is easier to keep honest than two.

### P12 manual acceptance checklist

Onboarding is user-visible, so P8/P10 rules apply: **a green `pnpm verify` is
not sufficient**. Both stale-process failures (P8 CORS, P11 404) began with a
server older than the code, so before starting:

```bash
pnpm --filter @jambu/api build && pnpm db:start
```

Restart the API and confirm the process is newer than your last edit. Then
`pnpm build:extension` and load `apps/extension/dist` unpacked.

1. **Onboarding opens by itself** on first install, in its own tab (D85).
2. **The manifest is unchanged** — `chrome://extensions` shows storage, idle,
   alarms, scripting, notifications and nothing more (constraint 6).
3. **Create an account from the UI** (D87) and land on the timezone step.
   Then close the tab, open the popup while signed out, and confirm
   **"Create account"** reopens onboarding (D96) — registration must not
   depend on a fresh install.
4. **No session path (A3)** — enable email confirmation in Supabase, reach
   registration from the signed-out popup (D96, no reinstall needed), and
   confirm the page says the account exists and to sign in, rather than
   hanging. Sign in from the popup and confirm onboarding resumes at Step 3.
5. **Timezone** is pre-filled from the browser; change it and confirm
   `GET /api/preferences` reports the new value (D90).
6. **Check-ins** show water off and the other three on (D7, D89).
7. **Stopwatch the flow** with defaults — under two minutes, 4 steps, and only
   an email and password typed (D95).
8. **Nothing is asked** about lunch time, water or break schedules, work
   hours, persona or your name (D88, D10, A6).
9. **Skip mid-flow** (D92): the popup shows "Finish setup", `GET
   /api/preferences` reports `onboardingCompletedAt: null`, and after browsing
   for a few minutes `activity_sessions` is still **empty** (D93, A5).
10. **Resume** from the popup and confirm it reopens at the step you left.
11. **Finish**, then browse — `activity_sessions` now fills, and
    `onboardingCompletedAt` is a timestamp.
12. **Reopen onboarding** manually: a completed user is not re-onboarded (D86).
13. **DevTools** — no password, token, URL or page content in any log line.
14. **Keyboard only** — every control reachable, focus ring visible (§19).

Checks 1-3 and 5-12 have automated counterparts in
`apps/extension/src/onboarding/*.test.*`, `apps/extension/src/popup/App.test.tsx`
(the D96 entry point), `tracking-gate.test.ts` and
`apps/api/tests/preferences.integration.test.ts`; check 4 needs a Supabase
setting only a human can flip, and checks 7, 13 and 14 need a person.

---

## 14.5 Settings, pause, snooze and privacy controls (P13 decisions)

Decisions D97-D107, settled before implementation.

| # | Decision |
|---|---|
| **D97** | Settings is a **dedicated options page**, registered via `options_ui` and opened with `chrome.runtime.openOptionsPage()`. A manifest key, not a permission — D3 minimization holds. |
| **D98** | Pause offers **30 minutes, 1 hour, 2 hours, and rest of day**. The API keeps taking an arbitrary `until`; these are the choices the UI presents. |
| **D99** | Pause **suppresses interventions but does not stop observation**. Pause and tracking consent stay separate concepts: D93 governs whether Jambu may watch, pause governs whether it may speak. |
| **D100** | Pausing **immediately removes a displayed Care Card**. This is an explicit pause override to P10's D69; unanswered cards otherwise still persist until answered. |
| **D101** | "Rest of day" resolves to the user's **configured work-end**, falling back to the **learned** work-end per existing routine-learning semantics (D84, D7). |
| **D102** | Snooze creation stays **tied to an intervention response**. Settings can view and clear active snoozes; it cannot mint arbitrary ones. |
| **D103** | Disabling an intervention type **clears its active snooze**. Re-enabling does not recreate an intervention. |
| **D104** | Deletion is **asynchronous**. `GET /api/user/deletion-request/:id` polling is retained **for activity scope**; account deletion is confirmed by its successful `202` instead (see the resolution below). |
| **D105** | Export is a **versioned JSON download** with a documented schema and a bounded response. It carries no URLs or page content, because none is collected (§9). |
| **D106** | Destructive actions require **typed confirmation**: `DELETE_ACTIVITY` or `DELETE_ACCOUNT`. |
| **D107** | After account deletion the extension **clears access and refresh credentials and the onboarding cache**, returns to the signed-out state, and shows an explicit completion message — triggered by the `202`, not by a polled status. |

### The mockups are the visual source of truth

The Jambu 3D mockups — onboarding, popup states, Lunch, Break, Hydration,
End-of-Day, responses, pause and settings — govern **visual hierarchy,
illustration style, card treatment, spacing and interaction presentation**. No
alternative visual language may be invented alongside them.

Behaviour is governed by this document and the state machines it describes.
Where a mockup and a decision appear to disagree about *behaviour*, the
decision wins and the disagreement is raised rather than resolved silently.

**Precondition for P13 implementation:** the mockup assets are not yet in the
repository. They must be added (for example under `docs/design/`) and
referenced here before UI work begins; until then only the API layer of P13 is
implementable.

### Pause silences, it does not blind (D99)

Pausing is about interruption, not surveillance. Jambu keeps observing so that
resuming does not start from an empty history and the learned routines stay
current — but it says nothing at all while paused. The control that stops
observation is onboarding consent (D93), and the control that removes what was
observed is deletion (§11). Three separate promises, three separate controls,
so that none of them silently stands in for another.

### Why pause takes the card away (D100)

D69 says an unanswered card persists: no auto-dismiss, no fabricated response.
That protects a card the user has not dealt with yet. Pause is different — the
user has just said "not now", and leaving the card on screen would contradict
the very instruction that produced it. §42 requires pausing to silence Jambu
*immediately*, and a card already on the page is Jambu still talking.

The removal carries no response value. The intervention is expired server-side
through the existing `expireStale` path, exactly as a timeout would.

### Snooze is earned, not scheduled (D102, D103)

A snooze exists because the user answered a card with "remind me later". It is
a reaction to a moment, not a schedule — and CLAUDE.md §3.2 is precisely about
not making people schedule their own care. Settings therefore shows active
snoozes and lets them be cleared, but offers no way to create one.

D103 follows from the same reading: turning a type off is the stronger, more
deliberate statement, so it clears the weaker temporary one. Turning it back
on restores eligibility, never a pending intervention.

### Account deletion is confirmed by its acceptance (D104 + D107)

Implementation surfaced a conflict the two decisions could not both survive.
`GET /api/user/deletion-request/:id` is authenticated, and completing an
account deletion destroys the auth user — so the token needed to poll dies
with the account it is asking about. Proven rather than assumed: the deletion
reached `completed` with `auth users remaining: 0`, and the same token then
got `401` from the status route.

**Resolved:** a successful `202` **is** the confirmation for account scope.
The client clears its credentials and shows the completion message on that
response, and never polls afterwards. Polling stays exactly as specified for
activity scope, where the account survives and the token still works.

Two tempting fixes were rejected: an unauthenticated status endpoint (it would
disclose deletion state for any guessed id, and weakening auth on a route that
reports deletion status is not a change to make casually) and a short-lived
receipt token (a second credential type, invented to observe something the
`202` already told us). Neither buys anything the acceptance response does not.

The server still writes the audit row and still moves it to `completed`. What
changed is only who is expected to read it: operators, not the departing user.

### Where the mockups and the decisions differ

The mockups in `docs/design/` are the visual source of truth: hierarchy,
illustration style, card treatment, spacing and interaction presentation all
follow the board. Behaviour follows the decisions, and six places needed that
rule applied. Each is a **behavioural** difference, not a visual one — the
board's look is reproduced in every case.

| Board | Implemented | Why |
|---|---|---|
| Settings lists **Posture reminders** | Omitted | Not an MVP intervention type. CLAUDE.md §2 lists four and says not to expand the catalogue without approval; there is no enum value, scoring rule or message template for posture, so the toggle would control nothing. |
| Settings **omits Lunch** | Included | Lunch is the Mom Moment (§5). Leaving it out would hide the product's headline behaviour behind no control at all. |
| Pause offers **"Until end of day / 1h / 2h / Custom time"** | 30 minutes, 1 hour, 2 hours, rest of day | D98 approved those four. "Custom time" is also the scheduling chore §3.2 avoids. |
| Popup has **"Take a break now"** | Omitted | No approved contract creates an intervention on demand; `POST /api/interventions` only creates one when warranted (P7). |
| Care Card reads **"Take a 5 minute break" / "Not now"** | Unchanged from P10 | The card's actions are the §18 response values, settled in P10 (D68-D75). Redesigning it is outside P13. |
| Onboarding screen is **restyled** | Unchanged from P12 | P12 is accepted and closed. Restyling it is a separate, reviewable change. |

Three board details are reproduced exactly because they match the decisions
outright: the paused state says activity is still tracked (D99), export warns
about the 10,000-record cap (D105), and both delete screens require the phrase
typed (D106).

### P13 manual acceptance checklist

Rebuild and restart the API first, and confirm the running process is newer
than the last edit — both previous stale-process failures (P8 CORS, P11 404)
began exactly there.

```bash
pnpm --filter @jambu/api build && pnpm build:extension
```

1. **Settings opens** from the popup as its own options page (D97).
2. **Manifest unchanged** apart from `options_ui` — permissions still storage,
   idle, alarms, scripting, notifications (D3).
3. **Pause offers exactly four choices**: 30 minutes, 1 hour, 2 hours, rest of
   day (D98).
4. **Pause removes a live card** — trigger an intervention, pause while it is
   on screen, and watch it disappear (D100).
5. **Paused Jambu stays quiet** — browse for a stretch and confirm no new card.
6. **Paused Jambu keeps observing** — `activity_sessions` still grows while
   paused (D99). This is the check that distinguishes pause from consent.
7. **Rest of day** ends at the configured work-end, or the learned one where
   routine learning supplies it (D101).
8. **Resume** restores normal behaviour; pausing and resuming twice changes
   nothing further (idempotent).
9. **Disable lunch** and confirm only lunch goes quiet.
10. **Disabling a type clears its snooze** — snooze lunch from a card, disable
    lunch in settings, and confirm the snooze is gone (D103).
11. **Snoozes are viewable and clearable**, and settings offers no way to
    create one (D102).
12. **Export** downloads versioned JSON; read it by eye and confirm no URL or
    page content anywhere (D105).
13. **Typed confirmation** — `DELETE_ACTIVITY` must be typed exactly; a near
    miss is refused (D106).
14. **Activity deletion** removes activity, routines and interventions while
    the account, preferences and pause state survive.
15. **Activity deletion status polls** from `pending` to `completed` (D104).
    This is activity scope only — account scope is confirmed by its `202`.
16. **Account deletion** removes every row, and the extension returns to
    signed-out with credentials and the onboarding cache cleared and a plain
    completion message shown (D107) — triggered by the `202`, with **no**
    polling attempted afterwards.
17. **DevTools** — no token, URL or page content in any log line.
18. **Keyboard only** — every settings control reachable, focus ring visible.
19. **Visual fidelity** — compare the options page, popup, pause modal and the
    export and delete dialogs against `docs/design/`. This is the one P13
    acceptance item no automated test can stand in for.

Checks 3, 8-11 and 13-16 have automated counterparts; checks 1, 2, 4, 6, 12,
17 and 18 need a person, and check 6 is the one worth doing carefully — it is
the only place the D93/D99 distinction is visible.

---

---

## 15. Beta Setup / Operational Notes

Operational facts discovered while accepting P8 in a real browser. These
describe how to run the system, not how it is designed; none of them implies a
change to the product.

### 15.1 CORS is coupled to the unpacked extension ID

**The extension's ID must be listed in `CORS_ALLOWED_ORIGINS` before sign-in
will work.** The popup calls the API from a document context and the extension
requests no host permissions (decision D55), so every call is an ordinary
cross-origin request carrying `Origin: chrome-extension://<id>`. An unlisted
origin gets no CORS grant, exactly as decision D19 intends.

```
CORS_ALLOWED_ORIGINS=http://127.0.0.1:3000,chrome-extension://<extension-id>
```

The ID is not knowable until the extension is loaded unpacked, so beta setup is
necessarily two passes: load it, copy the ID, add it, restart the API.

**Known rough edge, deliberately not fixed.** `@fastify/cors` treats a
disallowed origin as "CORS does not apply": it sets `Vary: Origin`, declines to
add `Access-Control-Allow-Origin`, and lets the request continue. No `OPTIONS`
route is declared for these paths, so the preflight falls through to the
not-found handler and the browser reports:

```
404 NOT_FOUND — "The requested route does not exist."
```

That is correct, strict behaviour, but it reads like a routing bug rather than
a rejected origin and cost a full debugging cycle during P8. Returning `403`
instead was considered and **deliberately declined** — the CORS implementation
is not being changed. Anyone debugging a failed sign-in should read a
preflight 404 as *"this origin is not in the allowlist"*.

Verify before opening Chrome; this must print `204`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS \
  http://127.0.0.1:3000/api/auth/login \
  -H 'Origin: chrome-extension://<extension-id>' \
  -H 'Access-Control-Request-Method: POST'
```

### 15.2 Restarting the API after an `.env` change

Node reads `--env-file` **once, at startup**. A running server never re-reads
it, so any `.env` edit requires a genuine restart.

Confirm the port is actually free first. During P8 a stale process kept port
3000 while each replacement died on `EADDRINUSE`; because it was launched in
the background the error was never seen, and the old single-origin allowlist
kept serving:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN     # expect no output before starting
```

Start it in the **foreground** during setup so a bind failure is visible rather
than silent. Checking `node --env-file=.env -e 'console.log(...)'` proves only
that the *file* is correct — it spawns a fresh process and says nothing about
the one already listening.

### 15.3 Creating an account

**Registration is a UI flow as of P12.** Install the extension and onboarding
opens by itself (D85); if that tab has been closed, open the popup while
signed out and click **"Create account"** (D96). Both routes lead to the same
form on the onboarding page — there is no second one.

P8 shipped sign-in only (D58) and this section used to carry a `curl` recipe
against `/api/auth/register` as the way to make beta accounts. That workaround
is **retired**: D87 replaced it with the real form, and D96 made the form
reachable without reinstalling. The endpoint still exists and still accepts the
same body, so scripted fixtures may call it directly — but it is no longer how
a person creates an account, and it should not be offered to a tester as one.

The client handles a registration that returns **no session** (email
confirmation enabled — `201 { user }` with no tokens): onboarding stops, asks
the user to confirm their email and sign in, then resumes at the timezone step
from the progress in `chrome.storage`. See resolution A3 in §14.4.
