# Jambu — Implementation Plan

**Status:** Decisions D1–D10 approved · awaiting approval of P0
**Date:** 2026-09-21
**Source of truth:** `CLAUDE.md` (repo root, blob `3a2a90c`)
**Repository:** https://github.com/shubsara/Jambu
**Local directory:** `~/Desktop/jambu`

Companion documents: `ARCHITECTURE.md` (system + database design),
`API.md` (endpoint contracts).

---

## 1. Repository Assessment

### 1.1 Current state

| Item | Finding |
|---|---|
| Remote | `github.com/shubsara/Jambu`, public, default branch `main` |
| Repo size | 0 KB — **no application code exists** |
| Files on `main` | `CLAUDE.md`, `README.md` |
| Commits | 3 (`e42369f`, `2f9150e`, `467cc46`) |
| Branches | `main`, `shubsara-patch-1` (1 ahead / 2 behind `main`) |
| Pull requests | None |

**The repository is empty of application code.** Greenfield build; nothing to
preserve or reverse-engineer.

### 1.2 Issues found

1. **`README.md` on `main` is a byte-identical copy of `CLAUDE.md`** (both blob
   `3a2a90c8b0c8cb312dbb4b0f024354e224894277`, 25,947 bytes). Commit `467cc46`
   overwrote the README with the internal agent instructions. **Fixed in P0 per
   D9.**
2. The real 74-byte README survives only on the orphan branch
   `shubsara-patch-1`. **Resolved in P0 per D9.**
3. No `.gitignore`, license or CI. **Added in P0.**
4. **`git` is non-functional on this machine** (Xcode licence). **D1 — the user
   is handling this manually. I will not attempt it.**

### 1.3 Spec integrity

`CLAUDE.md` in `~/Desktop/jambu` was verified byte-identical to the repository
copy (matching git blob SHA `3a2a90c`), so this plan is written against the
authoritative spec.

---

## 2. Approved Decisions (D1–D10)

| # | Decision | Where it lands |
|---|---|---|
| **D1** | Xcode licence accepted **manually by the user**. Claude must not attempt it. | P0 prerequisite |
| **D2** | **Supabase** for PostgreSQL + Auth. RLS where appropriate. Service-role key **never** in the extension. Privileged operations server-side. | `ARCHITECTURE.md` §4, §11 |
| **D3** | Custom floating **Care Card is the primary experience**, content-script based, native notification as fallback. Private beta — Web Store is not a blocker, but permissions are documented, justified and minimized. | `ARCHITECTURE.md` §9 |
| **D4** | **Hybrid**: activity-driven evaluation primary, `chrome.alarms` fallback. **`setTimeout` never used** for persistent background behaviour. | `ARCHITECTURE.md` §5 |
| **D5** | Extend schema for **pause, snooze, data deletion, account deletion** — as **separate tables**, not extra `user_preferences` columns. New endpoints documented. | `ARCHITECTURE.md` §11.6–11.8, `API.md` §9–11 |
| **D6** | **Continuous work = the current active session.** Idle **≥ 10 minutes** ends it. One definition across tracker, API, engine and tests. | `ARCHITECTURE.md` §6 |
| **D7** | **Hydration**: opt-in, meaningful continuous activity, no recent hydration confirmation, user active, no medical claims. **End of day**: after learned work-end + ≥30 min continued work + active + not paused, gentle language. | `ARCHITECTURE.md` §7.3 |
| **D8** | Default lunch window **12:30–14:30 local** for insufficient data; transitions to learned window; treated as a **fallback, never a schedule**. | `ARCHITECTURE.md` §7.3, `API.md` §5 |
| **D9** | Local directory `~/Desktop/jambu`. README becomes a real README; `CLAUDE.md` stays the internal instruction file; **no duplication**. | P0 |
| **D10** | `persona = "mom"` for MVP, via an **extensible persona/message abstraction**. Care Engine has no persona awareness. **No additional personas built now.** | `ARCHITECTURE.md` §8 |

---

## 3. Architecture Summary

Full detail in `ARCHITECTURE.md`. The load-bearing points:

- **Purity boundary.** `care-engine` and `routine-learning` are pure: no I/O,
  no clock reads (`currentTime` is an input), no randomness. Enforced by an
  ESLint rule that fails CI.
- **The extension never talks to Supabase.** All traffic goes through the
  Fastify API, which alone holds the service-role key. D2's "privileged
  operations server-side" is therefore structural, not conventional.
- **RLS is defense-in-depth, not the primary control** — the service role
  bypasses it. Real protection is per-request authorization by user id,
  asserted by tests at the API layer (`ARCHITECTURE.md` §4.3).
- **Care decisions ride back on the activity-sync response** (D4 primary), so
  the common case costs no extra request and has no polling latency.
- **Persona is invisible to the Care Engine** (D10): the engine emits a type,
  the message layer resolves `(persona, type) → copy`.

---

## 4. Implementation Phases

16 phases. Each ends in a green `lint / typecheck / test / build` (§33).
P0–P10 constitute the **"Mom Moment"** (§5); nothing after P10 begins until
that loop is reliable. Branch naming per §35.

---

### P0 — Repository foundation

**Objective.** A pnpm workspace that lints, typechecks, tests and builds, with
the README defect fixed, so every later phase has a working quality gate.

**Prerequisite (D1).** The user accepts the Xcode licence manually. Nothing in
P0 runs before `git --version` succeeds.

**Git reconciliation.** `~/Desktop/jambu` already holds `CLAUDE.md` and `docs/`,
so a plain `git clone` into it would fail. Sequence preserving remote history:

```text
1. git clone https://github.com/shubsara/Jambu.git /tmp/jambu-git
2. mv /tmp/jambu-git/.git ~/Desktop/jambu/.git
3. git -C ~/Desktop/jambu status     # local docs appear as changes on main
4. branch: feature/repository-foundation
```

**Files/components.**

| File | Purpose |
|---|---|
| `package.json` | workspace root, scripts `lint`/`typecheck`/`test`/`build` |
| `pnpm-workspace.yaml` | `apps/*`, `packages/*` |
| `tsconfig.json` | `strict`, `noUncheckedIndexedAccess`, project references |
| `eslint.config.js` | incl. purity rule + `setTimeout` ban (D4) |
| `.prettierrc` | formatting |
| `.gitignore` | `node_modules`, `.env`, `dist`, build info |
| `.env.example` | Supabase URL, anon key, service-role key, API port (§31) |
| `vitest.workspace.ts` | test runner across packages |
| `.github/workflows/ci.yml` | runs all four scripts |
| `README.md` | **real README** (D9) |
| `docs/PRD.md` | stub |
| `LICENSE` | to confirm |
| directory skeleton | `apps/{extension,api}`, `packages/*`, `database/{migrations,seed}` |

**Dependencies.** D1 resolved. No other phase.

**Database changes.** None.

**API changes.** None.

**Tests required.** One smoke test per workspace package proving the runner is
wired. CI must execute `lint`, `typecheck`, `test`, `build`.

**Acceptance criteria.**
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass from a clean clone.
- `tsconfig.json` sets `strict: true` and `noUncheckedIndexedAccess: true`.
- **`README.md` is a real project README and shares no content with `CLAUDE.md`** (D9);
  a CI check fails if their hashes ever match again.
- `CLAUDE.md` remains at the root, unmodified, as the internal instruction file.
- `.env.example` present and complete; `.env` git-ignored; no secrets committed.
- ESLint rejects `setTimeout` under `apps/extension/background/` (D4).
- CI green.

---

### P1 — `shared-types` and `message-templates`

**Objective.** Freeze the domain vocabulary and the persona abstraction.

**Files.** `packages/shared-types/src/{activity,state,care,intervention,preferences,pause,snooze,constants}.ts`;
`packages/message-templates/src/{registry,personas/mom,selector}.ts`.

**Dependencies.** P0.

**Database changes.** None.

**API changes.** None (types only).

**Tests required.** Discriminated-union type tests; selector determinism for a
given seed with no immediate repeat; registry lookup for an unknown persona
fails loudly rather than falling back silently.

**Acceptance criteria.**
- `ActivitySession`, `UserState`, `CareContext`, `CareDecision`,
  `InterventionResponse`, `UserPreferences` match §11–§18 exactly.
- `IDLE_BREAK_THRESHOLD_MINUTES = 10` (D6) and the default lunch window
  `12:30–14:30` (D8) are defined **once**, here.
- Persona registry has exactly one entry, `mom`, and adding a second would
  require **no** change to `care-engine` (D10).
- §20 message strings present verbatim. Zero runtime dependencies. No `any`.

---

### P2 — Database schema and migrations

**Objective.** The schema in `ARCHITECTURE.md` §11, on Supabase.

**Files.** `database/migrations/0001_init.sql`, `0002_rls.sql`,
`database/seed/dev.sql`, migration runner.

**Dependencies.** P1, D2.

**Database changes.** Creates `users`, `user_preferences`, `activity_sessions`,
`routine_patterns`, `interventions` (§22) **plus** `pause_states`,
`intervention_snoozes`, `deletion_requests` (D5), with the columns and indexes
specified in `ARCHITECTURE.md` §11. All `TIMESTAMPTZ`, UTC.

**API changes.** None.

**Tests required.** Migration up/down idempotency; FK cascade on user delete;
constraint tests (`active_seconds >= 0`, `ended_at >= started_at`, response
enum, confidence 0–1); `UNIQUE (user_id, client_session_id)` rejects a
duplicate replay; RLS policy tests.

**Acceptance criteria.**
- Migrations run clean on an empty Supabase project and are reversible.
- Pause, snooze and deletion live in **their own tables**; `user_preferences`
  gained no state columns (D5).
- `hydration_enabled` defaults to **false** (D7 opt-in).
- `persona` defaults to `'mom'` (D10).
- Only the indexes listed in `ARCHITECTURE.md` §11.9 exist (§22).

---

### P3 — API foundation and authentication

**Objective.** Fastify app with health, Supabase-proxied auth, enforced
authorization.

**Files.** `apps/api/src/{server,app}.ts`; plugins for config, errors, CORS,
rate limiting; `routes/auth/*`; auth middleware; Supabase server client.

**Dependencies.** P0, P2.

**Database changes.** None beyond P2.

**API changes.** `GET /health`, `POST /api/auth/register|login|refresh`
(`API.md` §2–3).

**Tests required.** Register/login/refresh happy paths; weak input rejected;
**401 on every user-scoped route without a token**; **403 when user A requests
user B's resource**; CORS restriction; no token or password in logs (§31).

**Acceptance criteria.**
- No hand-rolled password handling (§24) — Supabase Auth only.
- Service-role key read from env, used only server-side, never logged (D2).
- Every route validates input against a schema (§31).
- Integration tests pass against a real Supabase instance.

---

### P4 — Activity ingestion

**Objective.** Accept, deduplicate and store aggregated activity; return
decisions inline (D4).

**Files.** `routes/activity/session.ts`, `services/activity.ts`, domain
extraction and validation.

**Dependencies.** P3.

**Database changes.** Writes `activity_sessions`.

**API changes.** `POST /api/activity/session` (`API.md` §4).

**Tests required.** §27 Activity list in full: creation, continuation, ending,
idle detection, **duplicate events**, timezone handling. Plus: replayed
`clientSessionId` counted as duplicate not error; batch partial failure;
oversized batch rejected; **a payload containing a path or query is rejected**
(privacy assertion, §9).

**Acceptance criteria.**
- Re-sending an identical batch creates no duplicate rows.
- Only `domain` persists; path and query never stored (§11).
- Sessions ≥10 minutes apart are not merged; shorter gaps bridge (D6).
- Timestamps stored UTC.

---

### P5 — User state derivation

**Objective.** Derive `UserState` (§12) in the user's local timezone.

**Files.** `services/user-state.ts`, `lib/timezone.ts`.

**Dependencies.** P4.

**Database changes.** None — derived, not stored (§12).

**API changes.** `GET /api/user/state` (`API.md` §5).

**Tests required.** D6 continuity: a 9-minute gap bridges, an 11-minute gap
resets; `totalWorkMinutesToday` across local midnight; DST transition days;
`Asia/Kolkata` half-hour offset; brand-new user with no activity;
`currentActivity` resolution; `lunchWindow.source` is `"default"` before
learning and `"learned"` after (D8).

**Acceptance criteria.**
- "Today" is the user's local day, never the UTC day (§28).
- Returns valid state for a user with zero data.
- D6's 10-minute rule is applied from the shared constant, not a local literal.

---

### P6 — Care Engine

**Objective.** The deterministic decision core (§13–§15, §17).

**Files.** `packages/care-engine/src/{index,scoring,cooldown,rules/*}.ts`,
`config/scoring.ts`.

**Dependencies.** P1. **Pure — buildable in parallel with P3–P5.**

**Database changes.** None.

**API changes.** None (wired in P7).

**Tests required.** Full §27 matrix: lunch, break, hydration, end-of-day,
cooldown, snooze, dismissal, paused user, inactive user, outside work hours,
overlapping types. Plus:
- threshold boundaries at exactly 39/40/69/70
- **hydration does not fire when `hydration_enabled` is false** (D7 opt-in)
- hydration does not fire after a recent hydration confirmation (D7)
- **end-of-day does not fire until ≥30 min past learned work-end** (D7)
- repeated dismissal **reduces** frequency, never increases it (§17)
- paused user scores −100 and never intervenes (D5/§14)
- `reason` non-empty whenever `shouldIntervene` is true
- no message text appears anywhere in the package (D10 separation)

**Acceptance criteria.**
- Same `CareContext` → same `CareDecision`, always (property test).
- **Zero imports** of `Date`, `Math.random`, DB or HTTP — enforced by lint.
- A clock-only context (right time, no activity signal) does **not** intervene
  — the defining test of §15.
- Engine contains no persona awareness (D10).

---

### P7 — Intervention lifecycle

**Objective.** Create, deliver and record interventions; enforce cooldown,
snooze and pause server-side.

**Files.** `routes/interventions/*`, `services/intervention.ts`, expiry sweep.

**Dependencies.** P5, P6.

**Database changes.** Writes `interventions` including `score`, `reason`,
`persona`, `trigger`, `delivery`, `expires_at`.

**API changes.** `POST /api/interventions`,
`POST /api/interventions/:id/response`, `GET /api/interventions/today`
(`API.md` §8). Ingest response carries `pendingInterventions` (D4).

**Tests required.** §27 API list: creation, response recording, authorization.
Plus: cooldown blocks a second intervention in-window; **`snoozed` response
writes a type-scoped snooze that does not silence other types** (D5);
double-submitted response is idempotent; another user's intervention → 403;
expiry sweep sets `expired` (§18); overlapping types never both created.

**Acceptance criteria.**
- Every row stores the score and reason that produced it (§13).
- All five §18 responses accepted and persisted.
- Cooldown enforced in the API as well as the engine (§32).

---

### P8 — Extension foundation

**Objective.** Installable MV3 extension with auth and a minimal popup.

**Files.** `apps/extension/` — `manifest.json`, Vite + CRX build,
`background/service-worker.ts`, `popup/`, `lib/api-client.ts`,
`lib/storage.ts`, Tailwind.

**Dependencies.** P3.

**Database changes.** None.

**API changes.** None (consumer).

**Tests required.** API client retry/backoff (§26); token storage and refresh;
service worker restores state after termination; **manifest permission
snapshot test** fails the build if permissions widen (D3).

**Consideration carried forward from P3 — registration without a session.**
Supabase may return a created user and **no session** when email confirmation
is enabled. `POST /api/auth/register` then responds `201` with `{ user }` and
no tokens. That is correct behaviour and not a contract change, so `API.md` was
deliberately left untouched — but the extension client must handle it
explicitly: treat the account as created and route the user to sign-in rather
than assuming tokens are always present.

**Acceptance criteria.**
- Loads unpacked; user can log in and see their email.
- **No Supabase key of any kind in the bundle** — build-time grep for
  `supabase`, `service_role`, `SUPABASE_`, `eyJ` fails the build on a hit (D2).
- Manifest requests exactly the permissions in `ARCHITECTURE.md` §9.3 —
  and **does not request `tabs`** (D3 minimization).
- Popup contains no business logic (§10).

---

### P9 — Activity tracking in the extension

**Objective.** Observe, aggregate, buffer and sync activity.

**Files.** `background/activity-tracker.ts`, `background/idle.ts`,
`background/sync.ts`, `background/alarms.ts`.

**Dependencies.** P4, P8.

**Database changes.** None.

**API changes.** Consumer of `POST /api/activity/session`.

**Tests required.** Session open/extend/close against faked
`chrome.tabs`/`chrome.idle`; **D6 10-minute idle boundary**; buffer survives
service-worker restart; offline → buffer → backoff → resync (§26); buffer cap
and eviction; **domain extraction discards the URL immediately** (§9);
**no `setTimeout` anywhere in background code** (D4, lint-enforced).

**Acceptance criteria.**
- Backend down 30 minutes → no data loss, no aggressive retry (§26).
- Sync is batched, not per-event (§11).
- Only domains leave the browser, verified by inspecting outbound payloads.
- All scheduling via `chrome.alarms`; all state in `chrome.storage` (D4).

---

### P10 — Care Card and the Mom Moment 🎯

**Objective.** **The §5 milestone works end to end.**

**Files.** `content/care-card/` (shadow-DOM overlay, avatar, Tailwind),
`background/notification-orchestrator.ts`, `background/fallback-notification.ts`.

**Dependencies.** P7, P9.

**Database changes.** None.

**API changes.** None (consumer).

**Tests required.** Component tests for render, both actions, dismiss, and a11y
(focus trap, Escape, visible focus, `prefers-reduced-motion`, WCAG AA contrast);
orchestrator tests for sync-response → show → respond → stop-showing (D4
primary) **and** alarm-poll → show (D4 fallback); **native notification
fallback when no injectable tab exists** (D3); content script sends back only
the response and nothing about the page (§9).

**Acceptance criteria — the gate for the whole MVP:**
- A real user, working normally, receives the §5 card with the §5 copy.
- `[ Yes, I have ]` and `[ Remind me later ]` both persist a response;
  "Remind me later" creates a type-scoped snooze (D5).
- Card never covers a significant portion of the screen; no full-screen modal (§19).
- Card does not reappear during cooldown.
- Fallback notification path is exercised by a test, not assumed (D3).
- Card text comes from `message-templates` via the persona registry (D10).
- **P11+ does not begin until this loop is reliable** (§5).

---

### P11 — Routine Learning

**Objective.** Replace default windows with learned ones (§16, D8).

**Files.** `packages/routine-learning/src/{index,lunch,workHours,breakInterval,confidence}.ts`;
`routes/routines/*`; recalculation job.

**Dependencies.** P10. Package itself is pure and testable earlier.

**Database changes.** Writes `routine_patterns`.

**API changes.** `GET /api/routines`, `POST /api/routines/recalculate`
(`API.md` §7).

**Tests required.** §27 Routine list: insufficient observations, normal
observations, **outliers**, confidence calculation, different weekdays. Plus:
median-based lunch reproducing the §16 worked example
(13:20/13:42/13:35/13:29/13:38 → ~13:25–13:45); a single extreme outlier moves
the window less than a defined bound; confidence tiers match §16
(<3 / 3–7 / 8–14 / 15+); **the 12:30–14:30 default is used below 3
observations and `source` flips to `"learned"` at the threshold** (D8).

**Handoff from P7 — break-interval encoding is NOT settled.**
`routine_patterns` has no numeric interval column, so P7 derives a break
interval from the span between the stored `start_time` and `end_time` of the
`break_interval` row. That was the only reading available without a migration,
and nothing exercises it yet because routine learning does not exist.

P11 **must review this encoding explicitly** and decide the real routine-learning
data model rather than inheriting the P7 reading by default. If a numeric
interval column is the right answer, that is a P11 migration — P7 deliberately
did not change the schema.

**Acceptance criteria.**
- Under 3 observations → generic default, never personalization (§16).
- Confidence feeds the `+20` historical-pattern term in P6.
- Package pure and deterministic.
- End-of-day rule now uses the **learned** work-end time (D7).

---

### P12 — Onboarding

**Objective.** Under two minutes, collecting only what §3.2 permits.

**Files.** `apps/extension/onboarding/`, preference bootstrap.

**Dependencies.** P8, P11.

**Database changes.** Writes `user_preferences`; sets `users.timezone`.

**API changes.** `GET /api/preferences`, `PUT /api/preferences` (`API.md` §6).

**Tests required.** Flow completion; resume after abandonment; timezone
auto-detected and overridable; preference persistence; **an assertion that the
flow never asks for lunch time, water schedule or break schedule** (§3.2);
hydration presented as explicitly opt-in and **off by default** (D7).

**Acceptance criteria.**
- Completes in under two minutes with defaults (§42).
- Collects rough work hours + enabled intervention types — nothing more.
- Persona defaults to `mom` without asking (D10).

---

### P13 — Settings, pause, snooze and privacy controls

**Objective.** User control plus §42 data deletion; implements the D5 endpoints.

**Files.** `apps/extension/settings/`, `routes/pause/*`, `routes/snoozes/*`,
`routes/user/{export,activity,account}.ts`, deletion service.

**Dependencies.** P12.

**Database changes.** Writes `pause_states`, `intervention_snoozes`,
`deletion_requests`; hard-deletes activity/routines/interventions; sets
`users.deleted_at`.

**API changes.** All of `API.md` §9–11: pause (GET/POST/DELETE), snoozes
(GET/POST/DELETE), `GET /api/user/export`, `DELETE /api/user/activity`,
`DELETE /api/user/account`, `GET /api/user/deletion-request/:id`.

**Tests required.** Pause suppresses all interventions end to end and expires
any live one; resume restores; per-type toggles honoured; snooze silences one
type only; activity deletion removes activity/routines/interventions but keeps
the account; account deletion removes every row **and** the Supabase Auth user;
deletion touches no other user's rows; `deletion_requests` holds no personal
data; export contains no page content.

**Acceptance criteria.**
- Pausing silences Jambu completely and immediately (§42).
- A deleted user's activity is genuinely gone from the database (§42).
- Each of the four intervention types can be disabled independently (§42).
- Destructive endpoints require the explicit `confirm` value and say they are
  irreversible.

---

### P14 — Analytics and observability

**Objective.** §29 events and §31-safe error reporting.

**Files.** `lib/analytics.ts` (both apps), Sentry init with scrubbing.

**Dependencies.** P13.

**Database changes.** None.

**API changes.** None.

**Tests required.** Each §29 event fires once per occurrence; **no payload
contains a domain, URL, page content, email or token** (automated assertion);
Sentry scrubbing verified; analytics failure never breaks the care loop.

**Carry-forward from P10 (decision D70) - `shown_at` is not proof of display.**
`interventions.shown_at` is set when the row is created, not when a card
actually reached the user's screen. Injection can fail (an uninjectable page,
no focused window) and the native-notification fallback can be suppressed by
the OS, so a row can carry `shown_at` while nothing was ever seen.

P10 deliberately did **not** change this: correcting it means an API lifecycle
change, which was out of scope. P14 must therefore either treat `shown_at` as
"created, delivery attempted" in every metric derived from it, or introduce a
genuine delivery-confirmation signal. Reporting it as impressions without that
decision would overcount.

**Acceptance criteria.**
- All 12 §29 events emitted, including `jambu_paused` / `jambu_resumed` (D5).
- §30 metrics derivable from emitted data.
- Analytics fail-open and non-blocking.

---

### P15 — Integration testing and beta readiness

**Objective.** Prove §42 in full and prepare the private beta.

**Files.** `tests/integration/`, seeded multi-day fixtures, finalized docs,
`docs/PRIVACY.md`, permission justification table, beta install guide.

**Dependencies.** P14.

**Database changes.** None.

**API changes.** None.

**Tests required.** Simulated multi-day user (activity → learning →
intervention → response → refined timing); the §42 checklist as executable
assertions; load sanity on activity ingest; **privacy audit test** asserting no
forbidden §9 field exists in schema or payloads.

**Deferred here by decision: CI database and API integration tests.**
`pnpm test:db` (P2) and `pnpm test:api` (P3) need a live PostgreSQL and the
Supabase stack, which CI has no Docker for. They are excluded from `pnpm test`,
`pnpm verify` and `.github/workflows/ci.yml`, and run only on a developer
machine with `pnpm db:start`.

The gap this leaves is real and should not be forgotten: CI currently verifies
types, lint, unit tests and the build, but **not** the schema, RLS policies,
migration reversibility or the live auth flow. Closing it means adding a
PostgreSQL service container to the workflow and running both suites against
it.

**Acceptance criteria.**
- Every line of §42 demonstrably passes.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.
- Docs reflect the built system (§36).
- Permission table and privacy policy complete for the private beta (D3) —
  Web Store submission remains out of scope.

---

### 4.1 Dependency graph

```text
P0 ──► P1 ──► P2 ──► P3 ──► P4 ──► P5 ──┐
       │                    │           ├──► P7 ──► P10 ──► P11 ──► P12 ──► P13 ──► P14 ──► P15
       └──► P6 ─────────────┘           │            ▲
                                        │            │
                            P8 ──► P9 ──┴────────────┘
```

Parallelizable: **P6** (pure) alongside P3–P5; **P8** alongside P4–P5;
**P11's package** alongside P7.

---

## 5. Risks

Decisions D1–D10 closed the open questions; these remain live engineering risks.

| # | Risk | Impact | Mitigation | Status |
|---|---|---|---|---|
| R1 | Chrome Web Store review of broad host permissions | High | Private beta first (D3); permissions documented, justified, minimized; `tabs` not requested | **Deferred by D3** |
| R2 | MV3 service-worker termination loses in-memory state | High | All state in `chrome.storage`; `chrome.alarms` only; lint bans `setTimeout`; P9 restarts the worker in tests | Mitigated by D4 |
| R3 | Mom Moment needs a lunch window before learning has data | High | 12:30–14:30 local default at confidence 0, `source: "default"` | **Closed by D8** |
| R4 | §14 scoring weights are guesses | High | Single config object; every intervention persists `score` + `reason`; tune from beta data | Open — by design |
| R5 | Timezone and DST bugs | High | One `lib/timezone.ts`; engine receives converted values; explicit DST + `Asia/Kolkata` tests | Open |
| R6 | Polling cost and latency | Medium | **Largely removed by D4** — decisions ride the sync response; alarms are a 5-minute fallback | Reduced by D4 |
| R7 | Card injection fails on `chrome://`, Web Store, PDFs, unfocused windows | Medium | Native notification fallback, tested as a first-class path | Mitigated by D3 |
| R8 | Privacy regression creeping in later | High | Automated assertions in P4, P14, P15 that fail the build | Open — by design |
| R9 | Scope creep toward productivity analytics | Medium | §37 treated as a build-time rule | Open |
| R10 | Multiple devices/browsers inflate `continuousWorkMinutes` | Medium | Server-side overlap merge in P4; document as known MVP limitation if costly | Open |
| R11 | `git` blocked by Xcode licence | Blocking | **D1 — user handles manually. Claude will not attempt it.** | User-owned |

### 5.1 New risk introduced by the approved decisions

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R12 | **Supabase service role bypasses RLS.** Enabling RLS can create false confidence that data is protected when the real control is API-layer authorization. | High | Documented explicitly in `ARCHITECTURE.md` §4.3; P3 asserts cross-user 403 at the API layer independently of RLS; RLS treated as defense-in-depth only |

---

## 6. Out of Scope

Per §37: no desktop or mobile app, no voice, no chatbot, no wearables, no
nutrition or calorie data, no medical recommendations, no gamification or
streaks, no social or team features, no productivity analytics, no payments,
**no LLM in the decision path** (§21), and **no personas beyond `mom`** (D10).
